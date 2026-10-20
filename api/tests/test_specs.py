"""Engineering specs, flows and wireframes from an approved PRD (CR-09, §11.1, §11.2,
§11.5, §16.19): the prd_to_spec flow on the fake runtime, the spec document kind with its
brief and full layers, product requirements apart from the proposed approach, artifact
versions with provenance, lineage and staleness, engineering approval, design reviews,
regeneration as a proposal, the cost gates, roles and company scoping."""

import uuid
from decimal import Decimal

import pytest
from sqlalchemy import select

from oracle.docs.models import Document, DocumentVersion
from oracle.runs import extensions, flows
from oracle.specs import service as spec_service
from oracle.swarm import FakeRuntime, Outcome, set_runtime
from oracle.tenancy import tenant_session
from oracle.v2.models import ArtifactDependency, ArtifactOutput, ArtifactVersion
from tests.fixtures import draft
from tests.specs_helpers import (
    PRD,
    add_approver,
    adopt,
    design_json,
    get_run,
    get_spec,
    import_md,
    make_world,
    pending,
    request_spec,
    spec_md,
    start,
    tick,
)


@pytest.fixture
def runtime():
    fake = FakeRuntime()
    set_runtime(fake)
    yield fake
    set_runtime(None)


SECTIONS = ["s-5-1", "s-5-2"]


def script(runtime, world, spec: str | None = None, design: str | None = None, **outcome):
    files = {
        "spec.md": spec if spec is not None else spec_md(),
        "design.json": design if design is not None else design_json(world.reqs, SECTIONS),
    }
    runtime.script["spec_draft"] = [Outcome(artifacts=files, **outcome)]


async def generated(client, runtime, world, *, checkpoint: bool = True, **body):
    """A spec request whose run has written its first versions (checkpoint pending, or the
    run finished when the eng_review checkpoint is off)."""
    knobs = {} if checkpoint else {"checkpoints": {"eng_review": False}}
    created = await request_spec(client, world, depth="full", knobs=knobs, **body)
    owner = world.ctx.as_("owner")
    if "spec_draft" not in runtime.script:
        script(runtime, world)
    await start(client, world.ctx.as_("approver"), created["run_id"])
    await tick(client, owner)
    return created


async def av_rows(tenant_id) -> list[ArtifactVersion]:
    async with tenant_session(tenant_id) as s:
        return list(await s.scalars(select(ArtifactVersion).order_by(ArtifactVersion.created_at)))


# --------------------------------------------------------------------------- the flow


async def test_flow_in_the_catalog(client, runtime):
    world = await make_world(client)
    body = (await client.get("/v1/flows", headers=world.ctx.as_("viewer"))).json()
    flow = next(f for f in body["flows"] if f["key"] == "prd_to_spec")
    assert flow["target_kind"] == "spec" and flow["source_kind"] == "prd"
    assert flow["entry"] == "POST /v1/spec-requests"
    [segment] = flow["segments"]
    assert segment["checkpoint"] == "eng_review"  # E1: the toggleable eng review stop
    assert segment["outputs"] == ["spec.md", "design.json"]
    assert segment["roles"] == ["architect", "designer", "critic"]
    assert "write:drafts" not in segment["scopes"]  # Oracle imports, with provenance
    assert any(r["key"] == "designer" for r in body["roles"])


async def test_runs_route_does_not_start_a_spec_run(client, runtime):
    world = await make_world(client)
    resp = await client.post(
        "/v1/runs", json={"flow": "prd_to_spec", "source": PRD}, headers=world.ctx.as_("owner")
    )
    assert resp.status_code == 422
    assert "/v1/spec-requests" in resp.json()["detail"]


async def test_request_checks_its_inputs(client, runtime):
    world = await make_world(client, approve=False)
    detail = (await request_spec(client, world, status=422))["detail"]
    assert "no approved version" in detail
    await client.post(f"/v1/documents/{PRD}/versions/1/approve", headers=world.ctx.as_("owner"))
    bad = str(uuid.uuid4())
    assert (
        "unknown requirements"
        in (await request_spec(client, world, status=422, requirement_ids=[bad]))["detail"]
    )
    assert (
        "not requirements"
        in (await request_spec(client, world, status=422, requirement_ids=[str(world.criterion)]))[
            "detail"
        ]
    )
    assert (
        "sections not in"
        in (await request_spec(client, world, status=422, section_keys=["nope"]))["detail"]
    )
    assert (
        "unknown engineering approvers"
        in (await request_spec(client, world, status=422, engineering_approver_ids=[bad]))["detail"]
    )
    # Viewer and commenter roles cannot request a spec.
    await request_spec(client, world, who="viewer", status=403)
    await request_spec(client, world, who="commenter", status=403)
    # Two to four key screens (O2).
    await request_spec(client, world, status=422, screens=5)


async def test_a_spec_run_writes_spec_flows_and_wireframes_linked_to_requirements(client, runtime):
    world = await make_world(client)
    created = await generated(client, runtime, world)
    owner, viewer = world.ctx.as_("owner"), world.ctx.as_("viewer")
    spec = created["spec"]
    assert spec["request"]["kind"] == "engineering_spec"
    assert spec["section_keys"] == ["s-5-1", "s-5-2"]  # from the requirements' section links
    assert spec["code_capability_map"] == "unavailable"

    run = await get_run(client, owner, created["run_id"])
    assert run["status"] == "awaiting_checkpoint"
    cp = pending(run)
    assert cp["kind"] == "eng_review"
    imported = cp["payload"]["import"]
    assert "error" not in imported, imported
    assert imported["version"] == 1 and imported["kind"] == "spec"
    assert imported["design"]["problems"] == []

    spec = await get_spec(client, viewer, created["spec"]["request"]["id"])
    assert spec["latest_version"] == 1 and spec["approach_status"] == "proposed"
    assert spec["freshness"] == "fresh" and spec["stale"] == []
    [version] = spec["versions"]
    prov = version["artifact_version"]["provenance"]
    assert prov["prd_version_id"] == str(world.prd_v1) and prov["prd_version"] == 1
    assert prov["run_id"] == created["run_id"]
    assert prov["requirement_ids"] == world.reqs
    assert prov["prompt_version"] == "prd_to_spec/1" and prov["runner_profile"]
    assert prov["origin"] == "run"
    assert not any("token" in k for k in prov)

    # The spec document: kind spec, brief and full layers, requirements apart from approach.
    slug = spec["document_slug"]
    doc = (await client.get(f"/v1/documents/{slug}/versions/1", headers=viewer)).json()
    layers = {s["section_key"]: s["layer"] for s in doc["sections"]}
    assert doc["brief_source"] == "draft"
    for key in ("summary", "requirements", "approach", "open-decisions"):
        assert layers[key] == "brief"
    for key in ("architecture", "test-strategy", "assumptions", "sources"):
        assert layers[key] == "detail"
    body = {s["section_key"]: s["body_md"] for s in doc["sections"]}
    assert str(world.shipping) in body["requirements"]
    assert f"/documents/{PRD}/v/1#s-5-2" in body["requirements"]
    assert "Decided in the approved PRD" in body["requirements"]
    assert "A shopper sees the shipping cost" in body["acceptance-criteria"]
    assert "Proposed by this spec" in body["acceptance-criteria"]
    assert "based on assumptions" in body["approach"]
    assert "No code capability map" in body["assumptions"]
    parts = {s["key"]: (s["part"], s["decided"]) for s in spec["sections"]}
    assert parts["requirements"] == ("product_requirement", True)
    assert parts["approach"] == ("engineering_approach", False)
    assert parts["open-decisions"] == ("open_decision", False)
    assert parts["assumptions"] == ("assumption", False)
    listed = (await client.get("/v1/documents?kind=spec", headers=viewer)).json()
    assert [d["slug"] for d in listed] == [slug]
    # It exports and presents like any document: brief and full layers, deck.
    for layer in ("brief", "full"):
        resp = await client.get(
            f"/v1/documents/{slug}/versions/1/export?format=html&layer={layer}", headers=viewer
        )
        assert resp.status_code == 200, resp.text
        assert "Product requirements" in resp.text
    deck = await client.get(f"/v1/documents/{slug}/versions/1/deck", headers=viewer)
    assert deck.status_code == 200, deck.text

    # Flows and wireframes: artifact versions linked to sections and requirement ids.
    design = {d["kind"]: d for d in spec["design"]}
    flow = design["user_flow"]
    assert [o["name"] for o in flow["outputs"]] == ["checkout-flow.svg"]
    assert flow["outputs"][0]["section_keys"] == SECTIONS
    assert flow["outputs"][0]["annotations"][0]["section_key"] == "s-5-1"
    wire = design["wireframe"]
    assert [o["name"] for o in wire["outputs"]] == ["cart-1.html", "cart-2.html", "cart-3.html"]
    assert {o["media_type"] for o in wire["outputs"]} == {"text/html"}
    ups = {(d["upstream"]["section_key"], (d["upstream"]["entity"] or {}).get("id"))
           for d in flow["lineage"]["dependencies"]}  # fmt: skip
    assert ("s-5-1", None) in ups and (None, str(world.shipping)) in ups

    # The spec's own lineage: the PRD sections and every requirement.
    async with tenant_session(world.ctx.tenant_id) as s:
        av = await s.get(ArtifactVersion, uuid.UUID(version["artifact_version"]["id"]))
        deps = list(
            await s.scalars(
                select(ArtifactDependency).where(ArtifactDependency.artifact_version_id == av.id)
            )
        )
        assert {d.upstream_section_key for d in deps if d.upstream_section_key} == set(SECTIONS)
        assert {d.upstream_entity_id for d in deps if d.upstream_entity_id} == {
            world.shipping,
            world.cards,
        }
        output = await s.scalar(select(ArtifactOutput).where(ArtifactOutput.version_id == av.id))
        assert output.name == "spec.md" and output.content is None
        assert output.storage_ref.startswith("document_versions/")

    # The eng review stop finishes the run.
    resp = await client.post(
        f"/v1/runs/{created['run_id']}/checkpoints/{cp['id']}/decide",
        json={"decision": "approved"},
        headers=owner,
    )
    assert resp.status_code == 200 and resp.json()["status"] == "succeeded"


async def test_the_prompt_carries_requirements_contract_and_prd(client, runtime):
    world = await make_world(client)
    created = await generated(client, runtime, world)
    prompt = runtime.submitted[-1].steps[-1].prompt
    assert "Product requirements (decided in the PRD" in prompt
    assert f"{world.shipping} req-shipping-cost" in prompt
    assert "Acceptance criterion: A shopper sees the shipping cost" in prompt
    assert "## Proposed architecture {#architecture}" in prompt
    assert "No code capability map is available" in prompt
    assert "design.json" in prompt and "no scripts" in prompt
    assert f"--- PRD {PRD} v1 ---" in prompt
    assert "Horizons (B2)" not in prompt  # the roadmap's source lines are not used
    assert runtime.submitted[-1].outputs == ("spec.md", "design.json")
    assert created["run_id"]


async def test_the_fake_runtime_default_files_import(client, runtime):
    world = await make_world(client)
    created = await request_spec(client, world, depth="brief", screens=2)
    await start(client, world.ctx.as_("approver"), created["run_id"])
    await tick(client, world.ctx.as_("owner"))
    run = await get_run(client, world.ctx.as_("owner"), created["run_id"])
    imported = pending(run)["payload"]["import"]
    assert "error" not in imported, imported
    spec = await get_spec(client, world.ctx.as_("viewer"), created["spec"]["request"]["id"])
    assert spec["request"]["kind"] == "tech_brief" and spec["request"]["status"] == "succeeded"
    assert {d["kind"] for d in spec["design"]} == {"user_flow", "wireframe"}
    keys = [s["key"] for s in spec["sections"]]
    assert "architecture" not in keys  # a tech brief has no full-spec sections
    assert "approach" in keys and "assumptions" in keys


async def test_a_spec_that_breaks_the_contract_is_not_imported(client, runtime):
    world = await make_world(client)
    script(runtime, world, spec=spec_md(skip=("approach", "assumptions")))
    created = await generated(client, runtime, world, checkpoint=False)
    run = await get_run(client, world.ctx.as_("owner"), created["run_id"])
    assert run["status"] == "failed"
    assert "missing_section" in run["error"]
    spec = await get_spec(client, world.ctx.as_("viewer"), created["spec"]["request"]["id"])
    assert spec["versions"] == []
    assert spec["request"]["status"] == "partial"  # the design was stored


async def test_unsafe_design_is_refused_and_nothing_half_checked_is_stored(client, runtime):
    world = await make_world(client)
    bad = design_json(world.reqs, SECTIONS).replace(
        "<button>Continue</button>", '<button onclick=\\"steal()\\">Continue</button>'
    )
    script(runtime, world, design=bad)
    created = await generated(client, runtime, world)
    run = await get_run(client, world.ctx.as_("owner"), created["run_id"])
    design = pending(run)["payload"]["import"]["design"]
    assert any(p["code"] == "unsafe_content" for p in design["problems"])
    spec = await get_spec(client, world.ctx.as_("viewer"), created["spec"]["request"]["id"])
    assert spec["design"] == [] and spec["request"]["status"] == "partial"
    assert spec["latest_version"] == 1


async def test_design_links_must_be_the_requests(client, runtime):
    world = await make_world(client)
    other = str(uuid.uuid4())
    script(runtime, world, design=design_json([other], ["no-such-section"]))
    created = await generated(client, runtime, world)
    run = await get_run(client, world.ctx.as_("owner"), created["run_id"])
    codes = {p["code"] for p in pending(run)["payload"]["import"]["design"]["problems"]}
    assert {"unknown_requirement", "unknown_section"} <= codes


# --------------------------------------------------------------------------- staleness


async def test_a_prd_change_marks_what_links_the_section_potentially_stale(client, runtime):
    world = await make_world(client)
    created = await generated(client, runtime, world)
    owner, viewer = world.ctx.as_("owner"), world.ctx.as_("viewer")
    request_id = created["spec"]["request"]["id"]
    slug = created["spec"]["document_slug"]
    before = (await client.get(f"/v1/documents/{slug}/versions/1/markdown", headers=viewer)).text

    # A new PRD version changes section s-5-2 (the shipping step).
    v2 = draft("prd_v1.md").replace(
        "Show the shipping cost on the cart page", "Show a shipping estimate on the cart page"
    )
    assert (await import_md(client, owner, v2)).status_code == 201
    spec = await get_spec(client, viewer, request_id)
    assert spec["freshness"] == "potentially_stale"
    stale = {v["artifact_kind"]: v for v in spec["stale"]}
    # The flow links s-5-2; the wireframes link only s-5-1, so they stay fresh.
    assert set(stale) == {"engineering_spec", "user_flow"}
    assert {d["kind"]: d["version"]["freshness"] for d in spec["design"]} == {
        "user_flow": "potentially_stale",
        "wireframe": "fresh",
    }
    assert any("s-5-2" in r for r in stale["engineering_spec"]["reasons"])
    # Never rewritten: the spec version's markdown and its status stay as they were.
    after = (await client.get(f"/v1/documents/{slug}/versions/1/markdown", headers=viewer)).text
    assert after == before
    assert spec["latest_version"] == 1
    assert spec["versions"][0]["artifact_version"]["status"] == "in_review"

    # The trace lane sees them as engineering spec and wireframe outputs.
    listed = (await client.get("/v1/trace/staleness", headers=viewer)).json()
    categories = {i["category"] for i in listed["items"]}
    assert {"engineering_spec", "wireframe"} <= categories

    # A stale spec cannot be approved until someone reviews or reconciles it.
    resp = await client.post(f"/v1/documents/{slug}/versions/1/approve", headers=owner)
    assert resp.status_code == 422 and "stale" in resp.json()["detail"]


async def test_a_requirement_change_marks_the_spec_stale(client, runtime):
    world = await make_world(client)
    created = await generated(client, runtime, world)
    owner = world.ctx.as_("owner")
    resp = await client.patch(
        f"/v1/baseline/entities/{world.cards}",
        json={"title": "Saved cards and wallets first"},
        headers=owner,
    )
    assert resp.status_code == 200, resp.text
    spec = await get_spec(client, owner, created["spec"]["request"]["id"])
    assert spec["freshness"] == "potentially_stale"
    # The spec and the flow link the requirement; the wireframes link s-5-1, the PRD
    # section that states it (oracle.trace follows section links).
    stale = {v["artifact_kind"] for v in spec["stale"]}
    assert stale == {"engineering_spec", "user_flow", "wireframe"}


async def test_regeneration_is_a_proposed_draft_run(client, runtime):
    world = await make_world(client)
    created = await generated(client, runtime, world)
    owner, approver = world.ctx.as_("owner"), world.ctx.as_("approver")
    request_id = created["spec"]["request"]["id"]
    run = await get_run(client, owner, created["run_id"])
    await client.post(
        f"/v1/runs/{run['id']}/checkpoints/{pending(run)['id']}/decide",
        json={"decision": "approved"},
        headers=owner,
    )
    v2 = draft("prd_v1.md").replace("wallet payments", "wallet and bank payments")
    assert (await import_md(client, owner, v2)).status_code == 201
    # Only an approved PRD version can be the source.
    resp = await client.post(
        f"/v1/spec-requests/{request_id}/regenerate", json={"prd_version": 2}, headers=approver
    )
    assert resp.status_code == 422
    await client.post(f"/v1/documents/{PRD}/versions/2/approve", headers=owner)
    # E1: PRD v2 adopts the spec's requirements (a regeneration is refused otherwise).
    await adopt(world, 2)
    resp = await client.post(
        f"/v1/spec-requests/{request_id}/regenerate",
        json={"reason": "The payment step changed"},
        headers=world.ctx.as_("commenter"),
    )
    assert resp.status_code == 403
    resp = await client.post(
        f"/v1/spec-requests/{request_id}/regenerate",
        json={"reason": "The payment step changed"},
        headers=approver,
    )
    assert resp.status_code == 201, resp.text
    proposal = resp.json()
    assert proposal["prd_version"] == 2 and proposal["section_keys"] == SECTIONS
    assert any("s-5-1" in r for r in proposal["reasons"])
    new_run = await get_run(client, owner, proposal["run_id"])
    assert new_run["status"] == "draft"  # proposed, nobody started it
    spec = await get_spec(client, owner, request_id)
    assert spec["latest_version"] == 1 and spec["run_id"] == proposal["run_id"]
    assert len(await av_rows(world.ctx.tenant_id)) == 3  # nothing new was written

    # Started, it writes version 2 from PRD v2, for review; version 1 is superseded.
    script(runtime, world)
    await start(client, approver, proposal["run_id"])
    await tick(client, owner)
    assert "The payment step changed" in runtime.submitted[-1].steps[-1].prompt
    spec = await get_spec(client, owner, request_id)
    assert spec["latest_version"] == 2 and spec["freshness"] == "fresh"
    assert spec["versions"][1]["artifact_version"]["provenance"]["prd_version"] == 2
    assert [v["artifact_version"]["status"] for v in spec["versions"]] == [
        "superseded",
        "in_review",
    ]


# --------------------------------------------------------------------------- approval


async def test_engineering_approvers_approve_the_approach(client, runtime):
    world = await make_world(client)
    lead = await add_approver(world.ctx)
    created = await generated(client, runtime, world, engineering_approver_ids=[str(lead.id)])
    slug = created["spec"]["document_slug"]
    request_id = created["spec"]["request"]["id"]
    # Another approver is not one of the spec's engineering approvers.
    resp = await client.post(
        f"/v1/documents/{slug}/versions/1/approve", headers=world.ctx.as_("approver")
    )
    assert resp.status_code == 403
    # Section reviews and comments work as on PRDs.
    resp = await client.put(
        f"/v1/documents/{slug}/versions/1/sections/approach/review",
        json={"verdict": "approved"},
        headers=world.ctx.as_("approver"),
    )
    assert resp.status_code == 200, resp.text
    resp = await client.post(
        f"/v1/documents/{slug}/versions/1/approve", headers=world.ctx.as_(lead.email)
    )
    assert resp.status_code == 200, resp.text
    spec = await get_spec(client, world.ctx.as_("viewer"), request_id)
    assert spec["approach_status"] == "approved"
    [version] = spec["versions"]
    assert version["approved_by"] == str(lead.id)
    assert version["artifact_version"]["status"] == "approved"
    assert all(s["decided"] for s in spec["sections"])
    # A PRD's approval route is unchanged for PRDs.
    resp = await client.post(
        f"/v1/documents/{PRD}/versions/1/approve", headers=world.ctx.as_("approver")
    )
    assert resp.status_code == 200


async def test_a_person_edits_a_spec_and_keeps_its_lineage(client, runtime):
    world = await make_world(client)
    created = await generated(client, runtime, world)
    owner = world.ctx.as_("owner")
    slug = created["spec"]["document_slug"]
    md = (await client.get(f"/v1/documents/{slug}/versions/1/markdown", headers=owner)).text
    # The markdown export carries a banner; edit the stored draft instead.
    async with tenant_session(world.ctx.tenant_id) as s:
        stored = await s.scalar(
            select(DocumentVersion.markdown)
            .join(Document, Document.id == DocumentVersion.document_id)
            .where(Document.slug == slug)
        )
    assert md
    edited = stored.replace("A shipping quote service", "A cached shipping quote service")
    resp = await import_md(client, owner, edited, doc=slug)
    assert resp.status_code == 201, resp.text
    spec = await get_spec(client, owner, created["spec"]["request"]["id"])
    assert spec["latest_version"] == 2
    first, second = spec["versions"]
    assert second["origin"] == "edit" and first["artifact_version"]["status"] == "superseded"
    async with tenant_session(world.ctx.tenant_id) as s:
        deps = {
            av: sorted(
                (str(d.upstream_section_key), str(d.upstream_entity_id))
                for d in await s.scalars(
                    select(ArtifactDependency).where(ArtifactDependency.artifact_version_id == av)
                )
            )
            for av in (
                uuid.UUID(first["artifact_version"]["id"]),
                uuid.UUID(second["artifact_version"]["id"]),
            )
        }
    a, b = deps.values()
    assert a == b and len(a) == 4

    # A spec document nobody requested is refused: every spec has lineage.
    orphan = edited.replace(f"document: {slug}", "document: orphan-spec")
    resp = await import_md(client, owner, orphan, doc="orphan-spec")
    assert resp.status_code == 422
    assert "spec_without_request" in resp.text


# --------------------------------------------------------------------------- design reviews


async def test_design_annotations_are_reviewable(client, runtime):
    world = await make_world(client)
    created = await generated(client, runtime, world)
    spec = await get_spec(client, world.ctx.as_("viewer"), created["spec"]["request"]["id"])
    wire = next(d for d in spec["design"] if d["kind"] == "wireframe")
    av_id = wire["version"]["id"]
    url = f"/v1/design-artifacts/{av_id}/reviews"
    resp = await client.post(
        url,
        json={"kind": "comment", "body": "Show the range too.", "output": "cart-1.html",
              "annotation_id": "cost-label"},
        headers=world.ctx.as_("commenter"),
    )  # fmt: skip
    assert resp.status_code == 201, resp.text
    resp = await client.post(
        url,
        json={"kind": "comment", "body": "?", "output": "cart-1.html", "annotation_id": "nope"},
        headers=world.ctx.as_("commenter"),
    )
    assert resp.status_code == 422
    resp = await client.post(
        url, json={"kind": "comment", "body": "x"}, headers=world.ctx.as_("viewer")
    )
    assert resp.status_code == 403
    # Verdicts belong to approvers.
    resp = await client.post(url, json={"kind": "approved"}, headers=world.ctx.as_("commenter"))
    assert resp.status_code == 403
    resp = await client.post(
        url, json={"kind": "changes_requested"}, headers=world.ctx.as_("approver")
    )
    assert resp.status_code == 422  # say why
    resp = await client.post(url, json={"kind": "approved"}, headers=world.ctx.as_("approver"))
    assert resp.status_code == 201 and resp.json()["version"]["status"] == "approved"

    viewer = world.ctx.as_("viewer")
    view = (await client.get(f"/v1/design-artifacts/{av_id}", headers=viewer)).json()
    out = next(o for o in view["outputs"] if o["name"] == "cart-1.html")
    [note] = out["annotations"]
    assert note["section_key"] == "s-5-1" and note["requirement_ids"] == [str(world.shipping)]
    assert [r["body"] for r in note["reviews"]] == ["Show the range too."]
    assert [r["kind"] for r in view["reviews"]] == ["approved"]


async def test_design_outputs_are_served_static_and_sandboxed(client, runtime):
    world = await make_world(client)
    created = await generated(client, runtime, world)
    spec = await get_spec(client, world.ctx.as_("viewer"), created["spec"]["request"]["id"])
    for d in spec["design"]:
        for o in d["outputs"]:
            resp = await client.get(o["content_url"], headers=world.ctx.as_("viewer"))
            assert resp.status_code == 200
            csp = resp.headers["content-security-policy"]
            assert "default-src 'none'" in csp and "sandbox" in csp
            assert "script-src" not in csp or "'none'" in csp
            assert resp.headers["x-content-type-options"] == "nosniff"
            assert resp.headers["content-type"].startswith(o["media_type"])
            assert "<script" not in resp.text.lower()
            assert "grayscale" in resp.text
    resp = await client.get(
        f"/v1/design-artifacts/{spec['design'][0]['version']['id']}/outputs/missing.svg",
        headers=world.ctx.as_("viewer"),
    )
    assert resp.status_code == 404


# --------------------------------------------------------------------------- cost gates


async def test_the_cost_gates_hold_for_spec_runs(client, runtime):
    world = await make_world(client)
    every = ["researcher", "analyst", "architect", "designer", "prioritizer", "writer", "critic"]
    created = await request_spec(
        client, world, knobs={"depth": "deep", "roles": {"spec_draft": every}}
    )
    approver, owner = world.ctx.as_("approver"), world.ctx.as_("owner")
    run = await start(client, approver, created["run_id"])
    assert run["estimate_usd"] > float(flows.APPROVAL_THRESHOLD_USD)
    assert run["status"] == "awaiting_approval"  # > $50 waits for an owner
    resp = await client.post(f"/v1/runs/{created['run_id']}/approve", headers=approver)
    assert resp.status_code == 403
    # An overrun pauses after the segment, and nothing is imported until it resumes.
    script(runtime, world, cost_usd=Decimal("500"))
    resp = await client.post(f"/v1/runs/{created['run_id']}/approve", headers=owner)
    assert resp.status_code == 200, resp.text
    await tick(client, owner)
    run = await get_run(client, owner, created["run_id"])
    assert run["status"] == "paused_overrun"
    spec = await get_spec(client, owner, created["spec"]["request"]["id"])
    assert spec["versions"] == []
    resp = await client.post(f"/v1/runs/{created['run_id']}/resume", headers=owner)
    assert resp.status_code == 200, resp.text
    spec = await get_spec(client, owner, created["spec"]["request"]["id"])
    assert spec["latest_version"] == 1


async def test_design_can_be_left_out(client, runtime):
    world = await make_world(client)
    script(runtime, world, design='{"version": 1, "flows": [], "wireframes": []}')
    created = await generated(client, runtime, world, design=False)
    assert runtime.submitted[-1].steps[-1].role == "critic"
    assert [s.role for s in runtime.submitted[-1].steps] == ["architect", "critic"]
    spec = await get_spec(client, world.ctx.as_("owner"), created["spec"]["request"]["id"])
    assert spec["design"] == [] and spec["request"]["status"] == "succeeded"


# --------------------------------------------------------------------------- scoping


async def test_another_company_cannot_see_or_touch_specs(client, runtime):
    world = await make_world(client)
    created = await generated(client, runtime, world)
    other = await make_world(client, name="Other Co")
    spec = await get_spec(client, world.ctx.as_("viewer"), created["spec"]["request"]["id"])
    av_id = spec["design"][0]["version"]["id"]
    name = spec["design"][0]["outputs"][0]["name"]
    headers = other.ctx.as_("owner")
    request_id = created["spec"]["request"]["id"]
    for path in (
        f"/v1/spec-requests/{request_id}",
        f"/v1/design-artifacts/{av_id}",
        f"/v1/design-artifacts/{av_id}/outputs/{name}",
    ):
        assert (await client.get(path, headers=headers)).status_code == 404, path
    resp = await client.post(
        f"/v1/design-artifacts/{av_id}/reviews", json={"kind": "approved"}, headers=headers
    )
    assert resp.status_code == 404
    resp = await client.post(f"/v1/spec-requests/{request_id}/regenerate", json={}, headers=headers)
    assert resp.status_code == 404
    assert (await client.get("/v1/spec-requests", headers=headers)).json() == []
    # Another company's requirement ids are unknown here.
    resp = await client.post(
        "/v1/spec-requests",
        json={"prd": PRD, "requirement_ids": world.reqs},
        headers=other.ctx.as_("approver"),
    )
    assert resp.status_code == 422


async def test_every_specs_route_is_an_mcp_tool():
    from oracle.main import app
    from oracle.mcp.tools import app_operations

    names = {op.tool_name for op in app_operations(app) if op.excluded is None}
    for tool in (
        "create_spec_request",
        "list_spec_requests",
        "get_spec_request",
        "regenerate_spec",
        "get_design_artifact",
        "get_design_output",
        "review_design_artifact",
    ):
        assert tool in names, tool


# --------------------------------------------------------------------------- review fixes


async def test_an_older_version_cannot_be_approved_over_a_newer_one(client, runtime):
    world = await make_world(client)
    created = await generated(client, runtime, world)
    owner = world.ctx.as_("owner")
    slug = created["spec"]["document_slug"]
    async with tenant_session(world.ctx.tenant_id) as s:
        stored = await s.scalar(
            select(DocumentVersion.markdown)
            .join(Document, Document.id == DocumentVersion.document_id)
            .where(Document.slug == slug)
        )
    edited = stored.replace("A shipping quote service", "A cached shipping quote service")
    assert (await import_md(client, owner, edited, doc=slug)).status_code == 201
    resp = await client.post(f"/v1/documents/{slug}/versions/1/approve", headers=owner)
    assert resp.status_code == 422 and "superseded" in resp.json()["detail"]
    resp = await client.post(f"/v1/documents/{slug}/versions/2/approve", headers=owner)
    assert resp.status_code == 200, resp.text
    spec = await get_spec(client, owner, created["spec"]["request"]["id"])
    assert [v["artifact_version"]["status"] for v in spec["versions"]] == [
        "superseded",
        "approved",
    ]


async def test_an_importer_crash_still_opens_the_checkpoint(client, runtime):
    world = await make_world(client)

    async def boom(db, run, files, principal):
        raise RuntimeError("synthetic failure")

    extensions.register_importer("spec", boom)
    try:
        created = await generated(client, runtime, world)
    finally:
        extensions.register_importer("spec", spec_service.import_spec)
    run = await get_run(client, world.ctx.as_("owner"), created["run_id"])
    assert run["status"] == "awaiting_checkpoint"
    assert "import failed (RuntimeError)" in pending(run)["payload"]["import"]["error"]


async def test_a_refused_spec_import_still_records_the_design_and_status(client, runtime):
    world = await make_world(client)
    created = await request_spec(client, world, document="taken-slug", depth="full")
    # Meanwhile a PRD takes the slug: the spec import is refused (kind mismatch).
    prd = draft("prd_v1.md").replace("document: checkout-redesign", "document: taken-slug")
    assert (
        await import_md(client, world.ctx.as_("owner"), prd, doc="taken-slug")
    ).status_code == 201
    script(runtime, world)
    await start(client, world.ctx.as_("approver"), created["run_id"])
    await tick(client, world.ctx.as_("owner"))
    run = await get_run(client, world.ctx.as_("owner"), created["run_id"])
    assert "kind_mismatch" in pending(run)["payload"]["import"]["error"]
    spec = await get_spec(client, world.ctx.as_("owner"), created["spec"]["request"]["id"])
    assert spec["request"]["status"] == "partial" and spec["versions"] == []
    assert {d["kind"] for d in spec["design"]} == {"user_flow", "wireframe"}
