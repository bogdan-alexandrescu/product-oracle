"""Engineering specs, flows and wireframes from an approved PRD (CR-09, §11.1, §11.2,
§11.5, §16.19): the prd_to_spec flow on the fake runtime, the spec document kind with its
brief and full layers, product requirements apart from the proposed approach, artifact
versions with provenance, lineage and staleness, engineering approval, design reviews,
regeneration as a proposal, the cost gates, roles and company scoping."""

import asyncio
import io
import json
import re
import threading
import time
import uuid
from decimal import Decimal

import pytest
import yaml
from pypdf import PdfReader
from sqlalchemy import delete, select, update

from oracle import safe_yaml
from oracle.baseline.models import Entity
from oracle.docs import parser
from oracle.docs import parser as docs_parser
from oracle.docs.models import Document, DocumentVersion
from oracle.docs.parser import DraftError, parse_draft
from oracle.export import pptx, render
from oracle.export.pdf import pdf_available
from oracle.models import AuditEvent
from oracle.runs import extensions, flows
from oracle.runs.models import Run
from oracle.runtokens import mint_run_token
from oracle.specs import contract
from oracle.specs import service as spec_service
from oracle.swarm import FakeRuntime, Outcome, set_runtime
from oracle.tenancy import tenant_session
from oracle.v2.models import (
    ArtifactDependency,
    ArtifactOutput,
    ArtifactVersion,
    DocumentSectionLink,
)
from tests.baseline_helpers import make_ctx
from tests.fixtures import draft
from tests.specs_helpers import (
    PRD,
    SPEC_SECTIONS,
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
from tests.test_mcp import api_token, mcp_client, text_of


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
    # Everything but the proposed acceptance criteria, which the PRD decides (E1).
    assert all(s["decided"] for s in spec["sections"] if s["part"] != "proposed")
    assert [s["half"] for s in spec["sections"] if not s["decided"]] == ["proposed"]
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
    assert resp.status_code == 422  # say why, in plain words (qa-docs-80)
    assert resp.json()["detail"] == "Add a note to request changes or reject."
    resp = await client.post(url, json={"kind": "approved"}, headers=world.ctx.as_("approver"))
    assert resp.status_code == 201 and resp.json()["version"]["status"] == "approved"

    viewer = world.ctx.as_("viewer")
    view = (await client.get(f"/v1/design-artifacts/{av_id}", headers=viewer)).json()
    out = next(o for o in view["outputs"] if o["name"] == "cart-1.html")
    [note] = out["annotations"]
    assert note["section_key"] == "s-5-1" and note["requirement_ids"] == [str(world.shipping)]
    assert [r["body"] for r in note["reviews"]] == ["Show the range too."]
    assert [r["kind"] for r in view["reviews"]] == ["approved"]


async def test_design_review_threads_name_people(client, runtime):
    """#619 review: every role that reads the spec sees who wrote each review event and who
    its engineering approvers are, by name."""
    world = await make_world(client)
    lead = await add_approver(world.ctx)
    created = await generated(client, runtime, world, engineering_approver_ids=[str(lead.id)])
    request_id = created["spec"]["request"]["id"]
    viewer = world.ctx.as_("viewer")
    spec = await get_spec(client, viewer, request_id)
    assert spec["engineering_approvers"] == [{"id": str(lead.id), "name": "Eng Lead"}]
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
    assert resp.json()["event"]["actor_name"] == "Commenter"
    resp = await client.post(
        url, json={"kind": "comment", "body": "Looks right."}, headers=world.ctx.as_("token")
    )
    assert resp.status_code == 201, resp.text
    resp = await client.post(url, json={"kind": "approved"}, headers=world.ctx.as_(lead.email))
    assert resp.status_code == 201, resp.text

    view = (await client.get(f"/v1/design-artifacts/{av_id}", headers=viewer)).json()
    out = next(o for o in view["outputs"] if o["name"] == "cart-1.html")
    [note] = out["annotations"]
    assert [r["actor_name"] for r in note["reviews"]] == ["Commenter"]
    assert [(r["kind"], r["actor_name"]) for r in view["reviews"]] == [
        ("comment", "agent-track"),
        ("approved", "Eng Lead"),
    ]
    spec = await get_spec(client, viewer, request_id)
    wire = next(d for d in spec["design"] if d["kind"] == "wireframe")
    assert [r["actor_name"] for r in wire["reviews"]] == ["agent-track", "Eng Lead"]


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


# -----------------------------------------------------------------------------
# Specs security review, round 2 (owner decision E1, 2026-10-19): an edit to a spec may
# change only its engineering parts; a spec lists only requirements linked to its approved
# PRD version; a run token pushes only to its own run's document; with no engineering
# approvers named, the requester may approve their own spec, audited.


REFUSED = "Product requirements come from PRD v1. Change them in the PRD."


async def generated_review2(client, runtime, world, who: str = "approver", **body):
    created = await request_spec(client, world, who=who, depth="full", **body)
    runtime.script["spec_draft"] = [
        Outcome(artifacts={"spec.md": spec_md(), "design.json": design_json(world.reqs, SECTIONS)})
    ]
    await start(client, world.ctx.as_(who), created["run_id"])
    await tick(client, world.ctx.as_("owner"))
    return created


async def stored_markdown(tenant_id, slug: str, number: int = 1) -> str:
    async with tenant_session(tenant_id) as s:
        return await s.scalar(
            select(DocumentVersion.markdown)
            .join(Document, Document.id == DocumentVersion.document_id)
            .where(Document.slug == slug, DocumentVersion.number == number)
        )


async def version_count(tenant_id, slug: str) -> int:
    async with tenant_session(tenant_id) as s:
        doc = await s.scalar(select(Document).where(Document.slug == slug))
        return len(
            (
                await s.scalars(
                    select(DocumentVersion.id).where(DocumentVersion.document_id == doc.id)
                )
            ).all()
        )


# --------------------------------------------------------------------------- item 2: edits


EDITS_OF_PRD_PARTS = [
    # A reworded requirement.
    ("Show shipping cost on the cart**", "Show shipping cost on the cart, free over $50**"),
    # A requirement statement.
    ("The cart shows the shipping cost before", "The cart may show the shipping cost before"),
    # An acceptance criterion decided with the PRD.
    ("A shopper sees the shipping cost without", "A shopper may see the shipping cost without"),
    # Sources.
    ("- Product requirements: PRD checkout-redesign version 1", "- Product requirements: none"),
    # The section heading.
    ("## Product requirements {#requirements}", "## Requirements we like {#requirements}"),
]


@pytest.mark.parametrize(("old", "new"), EDITS_OF_PRD_PARTS)
async def test_an_edit_that_changes_a_prd_part_is_refused(client, runtime, old, new):
    world = await make_world(client)
    created = await generated_review2(client, runtime, world)
    slug = created["spec"]["document_slug"]
    stored = await stored_markdown(world.ctx.tenant_id, slug)
    assert old in stored
    resp = await import_md(client, world.ctx.as_("approver"), stored.replace(old, new), doc=slug)
    assert resp.status_code == 422, resp.text
    assert REFUSED in resp.text
    assert await version_count(world.ctx.tenant_id, slug) == 1


async def test_an_edit_that_drops_the_requirements_section_is_refused(client, runtime):
    world = await make_world(client)
    created = await generated_review2(client, runtime, world)
    slug = created["spec"]["document_slug"]
    stored = await stored_markdown(world.ctx.tenant_id, slug)
    start_at = stored.index("## Product requirements {#requirements}")
    end_at = stored.index("## Proposed engineering approach")
    resp = await import_md(
        client,
        world.ctx.as_("owner"),
        (stored[:start_at] + stored[end_at:]).replace("\n- requirements\n", "\n"),
        doc=slug,
    )
    assert resp.status_code == 422, resp.text
    assert REFUSED in resp.text


async def test_an_edit_to_engineering_parts_is_accepted(client, runtime):
    world = await make_world(client)
    created = await generated_review2(client, runtime, world)
    slug = created["spec"]["document_slug"]
    stored = await stored_markdown(world.ctx.tenant_id, slug)
    edited = stored.replace("A shipping quote service", "A cached shipping quote service").replace(
        "- The quote refreshes when the cart changes.",
        "- The quote refreshes when the cart or the postcode changes.",
    )
    assert edited.count("cached shipping quote") == 1 and "or the postcode" in edited
    resp = await import_md(client, world.ctx.as_("approver"), edited, doc=slug)
    assert resp.status_code == 201, resp.text
    spec = await get_spec(client, world.ctx.as_("owner"), created["spec"]["request"]["id"])
    assert spec["latest_version"] == 2 and spec["versions"][1]["origin"] == "edit"
    # And an edit of that edit, still leaving the PRD parts alone.
    again = edited.replace(
        "Which carrier rates to cache.", "Which carrier rates to cache, how long."
    )
    resp = await import_md(client, world.ctx.as_("owner"), again, doc=slug)
    assert resp.status_code == 201, resp.text


async def test_a_run_cannot_push_to_another_runs_spec(client, runtime):
    world = await make_world(client)
    created = await generated_review2(client, runtime, world)
    slug = created["spec"]["document_slug"]
    stored = await stored_markdown(world.ctx.tenant_id, slug)
    edited = stored.replace("A shipping quote service", "A cached shipping quote service")
    owner = world.ctx.users["owner"]
    async with tenant_session(world.ctx.tenant_id) as s:
        other = Run(flow="baseline_to_prd", created_by=owner.id, knobs={"document_slug": "other"})
        s.add(other)
        await s.flush()
        other_token = await mint_run_token(s, other.id, ["write:drafts"], ttl_seconds=600)
        await s.commit()
    async with mcp_client(other_token) as c:
        refused = await c.call_tool("push_draft", {"doc": slug, "markdown": edited})
    assert refused.is_error, text_of(refused)
    assert "its own run's document" in text_of(refused)
    assert await version_count(world.ctx.tenant_id, slug) == 1
    # A run with no document of its own cannot push to a spec either.
    async with tenant_session(world.ctx.tenant_id) as s:
        loose = Run(flow="baseline_to_prd", created_by=owner.id)
        s.add(loose)
        await s.flush()
        loose_token = await mint_run_token(s, loose.id, ["write:drafts"], ttl_seconds=600)
        await s.commit()
    async with mcp_client(loose_token) as c:
        refused = await c.call_tool("push_draft", {"doc": slug, "markdown": edited})
    assert refused.is_error and "its own run's document" in text_of(refused)
    # The spec's own run may (and its edit is checked like anyone's).
    async with tenant_session(world.ctx.tenant_id) as s:
        own_token = await mint_run_token(
            s, uuid.UUID(created["run_id"]), ["write:drafts"], ttl_seconds=600
        )
        await s.commit()
    async with mcp_client(own_token) as c:
        pushed = await c.call_tool("push_draft", {"doc": slug, "markdown": edited})
        assert not pushed.is_error, text_of(pushed)
        reworded = edited.replace("Show shipping cost on the cart**", "Free shipping**")
        refused = await c.call_tool("push_draft", {"doc": slug, "markdown": reworded})
    assert refused.is_error and REFUSED in text_of(refused)


# --------------------------------------------------------------------------- item 3: linked


async def _requirement(world, key: str, status: str, link: str | None = None) -> uuid.UUID:
    """A requirement; ``link``: None, "version" (a link on PRD v1) or "document"."""
    async with tenant_session(world.ctx.tenant_id) as s:
        e = Entity(type="requirement", key=key, title=key, status=status, origin="user")
        s.add(e)
        await s.flush()
        if link is not None:
            s.add(
                DocumentSectionLink(
                    document_id=world.prd_id,
                    version_id=world.prd_v1 if link == "version" else None,
                    section_key="s-5-1",
                    kind="implements",
                    entity_id=e.id,
                )
            )
        await s.commit()
        return e.id


async def test_a_proposed_requirement_the_prd_never_adopted_is_refused(client, runtime):
    world = await make_world(client)
    r9 = await _requirement(world, "R9", "proposed")
    body = await request_spec(
        client, world, status=422, requirement_ids=[str(r9)], section_keys=["s-5-1"]
    )
    assert body["detail"] == "R9 is not in PRD v1"


async def test_a_confirmed_but_unlinked_requirement_is_refused(client, runtime):
    world = await make_world(client)
    r7 = await _requirement(world, "R7", "confirmed")
    body = await request_spec(
        client,
        world,
        status=422,
        requirement_ids=[str(world.shipping), str(r7)],
        section_keys=["s-5-1"],
    )
    assert body["detail"] == "R7 is not in PRD v1"


async def test_a_requirement_linked_to_another_prd_version_is_refused(client, runtime):
    world = await make_world(client)
    r8 = await _requirement(world, "R8", "confirmed")
    # Linked only on PRD v2, not on v1 that the spec is built from.
    v2 = draft("prd_v1.md").replace("wallet payments", "wallet and bank payments")
    assert (await import_md(client, world.ctx.as_("owner"), v2)).status_code == 201
    async with tenant_session(world.ctx.tenant_id) as s:
        v2_id = await s.scalar(
            select(DocumentVersion.id).where(
                DocumentVersion.document_id == world.prd_id, DocumentVersion.number == 2
            )
        )
        s.add(
            DocumentSectionLink(
                document_id=world.prd_id, version_id=v2_id, section_key="s-5-1",
                kind="implements", entity_id=r8,
            )
        )  # fmt: skip
        await s.commit()
    body = await request_spec(
        client, world, status=422, requirement_ids=[str(r8)], section_keys=["s-5-1"], prd_version=1
    )
    assert body["detail"] == "R8 is not in PRD v1"


async def test_linked_requirements_are_accepted(client, runtime):
    world = await make_world(client)
    on_version = await _requirement(world, "R5", "confirmed", link="version")
    on_document = await _requirement(world, "R6", "confirmed", link="document")
    created = await request_spec(
        client, world, requirement_ids=[str(world.shipping), str(on_version), str(on_document)]
    )
    assert len(created["spec"]["request"]["requirement_ids"]) == 3


# --------------------------------------------------------------------------- item 4


async def test_with_no_engineering_approvers_the_requester_approves_their_own_spec(client, runtime):
    world = await make_world(client)
    created = await generated_review2(client, runtime, world, who="approver")
    slug = created["spec"]["document_slug"]
    requester = world.ctx.users["approver"]
    resp = await client.post(
        f"/v1/documents/{slug}/versions/1/approve", headers=world.ctx.as_("approver")
    )
    assert resp.status_code == 200, resp.text
    async with tenant_session(world.ctx.tenant_id) as s:
        av = await s.scalar(
            select(ArtifactVersion).where(
                ArtifactVersion.request_id == uuid.UUID(created["spec"]["request"]["id"])
            )
        )
        assert av.status == "approved" and av.approved_by == requester.id
        event = await s.scalar(
            select(AuditEvent).where(
                AuditEvent.action == "spec.approach_approved", AuditEvent.entity_id == av.id
            )
        )
    assert event is not None
    assert event.data["self_approval"] is True
    assert event.data["engineering_approvers_named"] is False
    assert event.data["requested_by"] == str(requester.id)
    # PRDs allow the same.
    resp = await client.post(
        f"/v1/documents/{PRD}/versions/1/approve", headers=world.ctx.as_("approver")
    )
    assert resp.status_code == 200


# --------------------------------------------------------------------------- minors


async def test_regenerate_changes_nothing_until_its_run_imports(client, runtime):
    world = await make_world(client)
    owner, approver = world.ctx.as_("owner"), world.ctx.as_("approver")
    created = await generated_review2(client, runtime, world)
    request_id = created["spec"]["request"]["id"]
    run = await get_run(client, owner, created["run_id"])
    await client.post(
        f"/v1/runs/{run['id']}/checkpoints/{pending(run)['id']}/decide",
        json={"decision": "approved"},
        headers=owner,
    )
    before = (await get_spec(client, owner, request_id))["request"]
    v2 = draft("prd_v1.md").replace("wallet payments", "wallet and bank payments")
    assert (await import_md(client, owner, v2)).status_code == 201
    await client.post(f"/v1/documents/{PRD}/versions/2/approve", headers=owner)
    # E1: PRD v2 adopts the spec's requirements (a regeneration is refused otherwise).
    await adopt(world, 2)
    resp = await client.post(
        f"/v1/spec-requests/{request_id}/regenerate", json={"reason": "v2"}, headers=approver
    )
    assert resp.status_code == 201, resp.text
    proposal = resp.json()
    after = (await get_spec(client, owner, request_id))["request"]
    for key in ("source_version_id", "section_keys", "status"):
        assert after[key] == before[key], key
    # Cancelled, the proposal leaves the request as it was.
    resp = await client.post(f"/v1/runs/{proposal['run_id']}/cancel", headers=approver)
    assert resp.status_code == 200, resp.text
    assert (await get_spec(client, owner, request_id))["request"]["source_version_id"] == (
        before["source_version_id"]
    )
    # A run that imports moves the request to the PRD version it was built from.
    resp = await client.post(
        f"/v1/spec-requests/{request_id}/regenerate", json={"reason": "v2"}, headers=approver
    )
    assert resp.status_code == 201, resp.text
    runtime.script["spec_draft"] = [
        Outcome(artifacts={"spec.md": spec_md(), "design.json": design_json(world.reqs, SECTIONS)})
    ]
    await start(client, approver, resp.json()["run_id"])
    await tick(client, owner)
    spec = await get_spec(client, owner, request_id)
    assert spec["latest_version"] == 2
    assert spec["request"]["source_version_id"] != before["source_version_id"]
    assert spec["versions"][1]["artifact_version"]["provenance"]["prd_version"] == 2
    # Never back to an older approved version.
    resp = await client.post(
        f"/v1/spec-requests/{request_id}/regenerate", json={"prd_version": 1}, headers=approver
    )
    assert resp.status_code == 422, resp.text
    assert "older" in resp.json()["detail"]


async def test_record_design_does_not_record_the_same_design_twice(client, runtime):
    from oracle.auth.deps import Principal  # noqa: F401
    from oracle.specs import lineage
    from oracle.specs.design import check_design
    from oracle.v2.models import ArtifactRequest

    world = await make_world(client)
    created = await generated_review2(client, runtime, world)
    flow_request_id = created["spec"]["request"]["params"]["design_request_ids"]["user_flow"]
    check = check_design(
        design_json(world.reqs, SECTIONS),
        prd_sections=set(SECTIONS) | {"s-1"},
        requirement_ids=set(world.reqs),
    )
    assert check.flows
    async with tenant_session(world.ctx.tenant_id) as s:
        request = await s.get(ArtifactRequest, uuid.UUID(flow_request_id))
        before = (
            await s.scalars(select(ArtifactVersion).where(ArtifactVersion.request_id == request.id))
        ).all()
        assert len(before) == 1
        av = await lineage.record_design(
            s,
            None,
            request,
            check.flows,
            source_version_id=world.prd_v1,
            provenance={"run_id": created["run_id"]},
            prd_version_id=world.prd_v1,
        )
        await s.commit()
        assert av.id == before[0].id
        rows = (
            await s.scalars(select(ArtifactVersion).where(ArtifactVersion.request_id == request.id))
        ).all()
        assert len(rows) == 1 and rows[0].status != "superseded"


# -----------------------------------------------------------------------------
# Specs security review, round 3 (owner decisions E1, 2026-10-19 and 2026-10-20).
#
# 1. Spec structure: an edit may add sections the spec template doesn't have; an added
#    section always shows as Proposed, never Decided. The parts Oracle writes keep their
#    key, heading level, position and brief listing, the decided acceptance criteria split
#    only at Oracle's own label, and the labels and the intro line stay.
# 2. Adoption: a requirement is adopted by a PRD version only through a section link of any
#    kind except 'mentions', checked on request, on regeneration and on import.
# 3. The static check of design files is linear.


# --------------------------------------------------------------------------- item 1

FORGED = (
    "## Product requirements {#product-requirements}\n\n"
    f"{contract.REQUIREMENTS_NOTE}\n\n"
    "- **req-free-shipping: Free shipping on every order** (requirement id `forged`)\n\n"
)


def _sections(spec: dict) -> dict[str, dict]:
    return {s["key"]: s for s in spec["sections"]}


async def _edit(client, world, created, edit, who: str = "approver"):
    slug = created["spec"]["document_slug"]
    stored = await stored_markdown(world.ctx.tenant_id, slug)
    edited = edit(stored)
    assert edited != stored
    return await import_md(client, world.ctx.as_(who), edited, doc=slug)


def _probe(stored: str) -> str:
    """The reviewer's probe: a forged requirements section where the real one was, the real
    one moved to the end as an h3, and the brief listing the forged key instead."""
    start_at = stored.index("## Product requirements {#requirements}")
    end_at = stored.index("## Proposed engineering approach")
    real = stored[start_at:end_at]
    rest = stored[:start_at] + FORGED + stored[end_at:]
    rest = rest.replace("\n- requirements\n", "\n- product-requirements\n", 1)
    return rest.rstrip("\n") + "\n\n" + real.replace("## Product", "### Product", 1)


async def test_the_reviewers_probe_is_refused_naming_the_part(client, runtime):
    world = await make_world(client)
    created = await generated_review2(client, runtime, world)
    resp = await _edit(client, world, created, _probe)
    assert resp.status_code == 422, resp.text
    assert REFUSED in resp.text
    assert "requirements" in resp.text
    assert await version_count(world.ctx.tenant_id, created["spec"]["document_slug"]) == 1


@pytest.mark.parametrize(
    "edit",
    [
        # Moved after Sources, same level.
        lambda md: _move_to_end(md, "## Acceptance criteria {#acceptance-criteria}"),
        # Demoted to an h3 in place (it becomes part of the summary's subtree).
        lambda md: md.replace("## Product requirements {#requirements}",
                              "### Product requirements {#requirements}"),
        # Dropped from the brief.
        lambda md: md.replace("\n- requirements\n", "\n", 1),
        # Swapped in the brief for an added section.
        lambda md: md.replace("\n- requirements\n", "\n- product-requirements\n", 1).replace(
            "## Product requirements {#requirements}",
            FORGED + "## Product requirements {#requirements}",
        ),
    ],
    ids=["moved", "demoted", "not-in-brief", "brief-swapped"],
)  # fmt: skip
async def test_oracle_parts_keep_key_level_position_and_brief(client, runtime, edit):
    world = await make_world(client)
    created = await generated_review2(client, runtime, world)
    resp = await _edit(client, world, created, edit)
    assert resp.status_code == 422, resp.text
    assert REFUSED in resp.text


def _move_to_end(md: str, heading: str) -> str:
    start_at = md.index(heading)
    end_at = md.index("\n## ", start_at + 1) + 1
    return md[:start_at] + md[end_at:].rstrip("\n") + "\n\n" + md[start_at:end_at]


# Round 4 (E1 'Added sections, visible', owner, 2026-10-20): an added section that takes
# Oracle's heading is refused (tests/test_specs_review4.py); one inserted in the same place
# under its own heading shows as proposed.
INSERTED = "## Shipping notes {#shipping-notes}\n\n- Free shipping on every order.\n\n"


async def test_an_inserted_section_shows_as_proposed(client, runtime):
    world = await make_world(client)
    created = await generated_review2(client, runtime, world)
    resp = await _edit(
        client,
        world,
        created,
        lambda md: md.replace(
            "## Product requirements {#requirements}",
            INSERTED + "## Product requirements {#requirements}",
        ).replace("\n- requirements\n", "\n- requirements\n- shipping-notes\n", 1),
    )
    assert resp.status_code == 201, resp.text
    spec = await get_spec(client, world.ctx.as_("owner"), created["spec"]["request"]["id"])
    sections = _sections(spec)
    assert sections["shipping-notes"]["part"] == "proposed"
    assert sections["shipping-notes"]["decided"] is False
    assert sections["shipping-notes"]["layer"] == "brief"
    assert sections["requirements"]["part"] == "product_requirement"
    assert sections["requirements"]["decided"] is True


async def test_an_added_rollout_notes_section_is_accepted_and_proposed(client, runtime):
    world = await make_world(client)
    created = await generated_review2(client, runtime, world)
    resp = await _edit(
        client,
        world,
        created,
        lambda md: (
            md.rstrip("\n") + "\n\n## Rollout notes {#rollout-notes}\n\nTen percent first.\n"
        ),
    )
    assert resp.status_code == 201, resp.text
    owner = world.ctx.as_("owner")
    request_id = created["spec"]["request"]["id"]
    rollout = _sections(await get_spec(client, owner, request_id))["rollout-notes"]
    assert rollout["part"] == "proposed" and rollout["decided"] is False
    # Never decided, even once the version's approach is approved.
    slug = created["spec"]["document_slug"]
    resp = await client.post(f"/v1/documents/{slug}/versions/2/approve", headers=owner)
    assert resp.status_code == 200, resp.text
    spec = await get_spec(client, owner, request_id)
    assert spec["approach_status"] == "approved"
    sections = _sections(spec)
    assert sections["rollout-notes"]["decided"] is False
    assert sections["approach"]["decided"] is True


async def test_an_editor_written_proposed_label_is_not_a_split_point(client, runtime):
    world = await make_world(client)
    created = await generated_review2(client, runtime, world)
    stored = await stored_markdown(world.ctx.tenant_id, created["spec"]["document_slug"])
    oracle_label = "\n\nProposed by this spec (not product requirements until the PRD adopts them):"
    assert stored.count(oracle_label) == 1
    resp = await _edit(
        client,
        world,
        created,
        lambda md: md.replace(
            oracle_label,
            "\n\nProposed by this spec (and decided too):\n\n- req-shipping-cost: free shipping"
            + oracle_label,
        ),
    )
    assert resp.status_code == 422, resp.text
    assert REFUSED in resp.text
    # Proposals after Oracle's own label may change.
    resp = await _edit(
        client,
        world,
        created,
        lambda md: md.replace(
            "- The quote refreshes when the cart changes.",
            "- The quote refreshes when the cart changes.\n- The quote shows a currency.",
        ),
    )
    assert resp.status_code == 201, resp.text


@pytest.mark.parametrize(
    "edit",
    [
        # The PROPOSED/ASSUMED label of an engineering section.
        lambda md: md.replace(contract.ASSUMED_LABEL + "\n\nA shipping quote service", "A shipping "
                              "quote service", 1),
        # Every label at once.
        lambda md: md.replace(contract.ASSUMED_LABEL + "\n\n", ""),
        # The no-map note on the assumptions.
        lambda md: md.replace(contract.NO_MAP_NOTE + "\n\nThe cart service", "The cart service"),
        # The intro's PRD version.
        lambda md: md.replace("(version 1). Product requirements", "(version 7). Product "
                              "requirements"),
        # The intro's PRD.
        lambda md: md.replace("from the approved PRD ", "from the draft PRD ", 1),
    ],
    ids=["one-label", "all-labels", "no-map-note", "intro-version", "intro-prd"],
)  # fmt: skip
async def test_labels_and_the_intro_line_cannot_be_edited(client, runtime, edit):
    world = await make_world(client)
    created = await generated_review2(client, runtime, world)
    resp = await _edit(client, world, created, edit)
    assert resp.status_code == 422, resp.text
    assert REFUSED in resp.text


async def test_an_edit_is_checked_against_the_prd_versions_text_not_todays(client, runtime):
    world = await make_world(client)
    created = await generated_review2(client, runtime, world)
    # The baseline changes after the spec was written from PRD v1.
    async with tenant_session(world.ctx.tenant_id) as s:
        await s.execute(
            update(Entity)
            .where(Entity.id == world.shipping)
            .values(title="Show shipping cost and free-shipping threshold")
        )
        await s.commit()
    resp = await _edit(
        client,
        world,
        created,
        lambda md: md.replace(
            "Show shipping cost on the cart**", "Show shipping cost and free-shipping threshold**"
        ),
    )
    assert resp.status_code == 422, resp.text
    assert REFUSED in resp.text
    # The text as Oracle wrote it from the PRD version still edits fine.
    resp = await _edit(
        client,
        world,
        created,
        lambda md: md.replace("A shipping quote service", "A cached shipping quote service"),
    )
    assert resp.status_code == 201, resp.text


# --------------------------------------------------------------------------- item 2


async def _link(world, version_id, entity_id, key: str, kind: str = "implements") -> None:
    async with tenant_session(world.ctx.tenant_id) as s:
        s.add(
            DocumentSectionLink(
                document_id=world.prd_id, version_id=version_id, section_key=key, kind=kind,
                entity_id=entity_id,
            )
        )  # fmt: skip
        await s.commit()


async def _approved_v2(client, world) -> uuid.UUID:
    """PRD v2, approved. Its links are not carried forward (the fixture's links have no
    section hash): each test links what v2 adopts."""
    owner = world.ctx.as_("owner")
    v2 = draft("prd_v1.md").replace("wallet payments", "wallet and bank payments")
    assert (await import_md(client, owner, v2)).status_code == 201
    resp = await client.post(f"/v1/documents/{PRD}/versions/2/approve", headers=owner)
    assert resp.status_code == 200, resp.text
    async with tenant_session(world.ctx.tenant_id) as s:
        return await s.scalar(
            select(DocumentVersion.id).where(
                DocumentVersion.document_id == world.prd_id, DocumentVersion.number == 2
            )
        )


async def _spec_on_v1(client, runtime, world) -> str:
    """A spec built from PRD v1 for both requirements, its run finished."""
    owner = world.ctx.as_("owner")
    created = await generated_review2(client, runtime, world)
    run = await get_run(client, owner, created["run_id"])
    resp = await client.post(
        f"/v1/runs/{run['id']}/checkpoints/{pending(run)['id']}/decide",
        json={"decision": "approved"},
        headers=owner,
    )
    assert resp.status_code == 200, resp.text
    return created["spec"]["request"]["id"]


async def _regenerate(client, world, request_id, status=201, **body):
    resp = await client.post(
        f"/v1/spec-requests/{request_id}/regenerate",
        json={"reason": "PRD v2", **body},
        headers=world.ctx.as_("approver"),
    )
    assert resp.status_code == status, resp.text
    return resp.json()


async def test_regenerate_to_a_version_that_did_not_carry_a_requirement_is_refused(client, runtime):
    world = await make_world(client)
    request_id = await _spec_on_v1(client, runtime, world)
    v2 = await _approved_v2(client, world)
    # PRD v2 adopts the saved-cards requirement; the shipping-cost link was not carried.
    await _link(world, v2, world.cards, "s-5-1")
    body = await _regenerate(client, world, request_id, status=422)
    assert body["detail"] == "req-shipping-cost is not in PRD v2"


async def test_regenerate_with_a_requirement_rejected_since_is_refused(client, runtime):
    world = await make_world(client)
    request_id = await _spec_on_v1(client, runtime, world)
    v2 = await _approved_v2(client, world)
    await _link(world, v2, world.cards, "s-5-1")
    await _link(world, v2, world.shipping, "s-5-2")
    async with tenant_session(world.ctx.tenant_id) as s:
        await s.execute(update(Entity).where(Entity.id == world.shipping).values(status="rejected"))
        await s.commit()
    body = await _regenerate(client, world, request_id, status=422)
    assert "req-shipping-cost" in body["detail"]
    assert "req-saved-cards" not in body["detail"]


async def test_a_mentions_link_does_not_adopt_a_requirement(client, runtime):
    world = await make_world(client)
    async with tenant_session(world.ctx.tenant_id) as s:
        r4 = Entity(type="requirement", key="R4", title="R4", status="confirmed", origin="user")
        s.add(r4)
        await s.commit()
    await _link(world, world.prd_v1, r4.id, "s-5-1", kind="mentions")
    body = await request_spec(
        client, world, status=422, requirement_ids=[str(r4.id)], section_keys=["s-5-1"]
    )
    assert body["detail"] == "R4 is not in PRD v1"
    # Any other kind adopts it.
    await _link(world, world.prd_v1, r4.id, "s-5-1", kind="tests")
    await request_spec(client, world, requirement_ids=[str(r4.id)], section_keys=["s-5-1"])


async def test_regenerate_refuses_a_requirement_v2_only_mentions(client, runtime):
    world = await make_world(client)
    request_id = await _spec_on_v1(client, runtime, world)
    v2 = await _approved_v2(client, world)
    await _link(world, v2, world.cards, "s-5-1")
    await _link(world, v2, world.shipping, "s-5-2", kind="mentions")
    body = await _regenerate(client, world, request_id, status=422)
    assert body["detail"] == "req-shipping-cost is not in PRD v2"


async def test_import_drops_and_reports_a_requirement_no_longer_adopted(client, runtime):
    world = await make_world(client)
    owner = world.ctx.as_("owner")
    request_id = await _spec_on_v1(client, runtime, world)
    v2 = await _approved_v2(client, world)
    await _link(world, v2, world.cards, "s-5-1")
    await _link(world, v2, world.shipping, "s-5-2")
    proposal = await _regenerate(client, world, request_id)
    # The link goes before the run imports.
    async with tenant_session(world.ctx.tenant_id) as s:
        await s.execute(
            delete(DocumentSectionLink).where(
                DocumentSectionLink.version_id == v2,
                DocumentSectionLink.entity_id == world.shipping,
            )
        )
        await s.commit()
    runtime.script["spec_draft"] = [
        Outcome(artifacts={"spec.md": spec_md(), "design.json": design_json(world.reqs, SECTIONS)})
    ]
    await start(client, world.ctx.as_("approver"), proposal["run_id"])
    await tick(client, owner)
    run = await get_run(client, owner, proposal["run_id"])
    imported = pending(run)["payload"]["import"]
    assert imported["dropped_requirements"] == ["req-shipping-cost"]
    assert any(p["code"] == "requirement_not_adopted" for p in imported["spec_check"])
    spec = await get_spec(client, owner, request_id)
    assert spec["latest_version"] == 2
    markdown = await stored_markdown(world.ctx.tenant_id, spec["document_slug"], 2)
    front = yaml.safe_load(markdown.split("---")[1])
    assert front["spec"]["requirement_ids"] == [str(world.cards)]
    assert "req-shipping-cost" not in markdown.split("{#requirements}")[1].split("\n## ")[0]


async def test_a_regeneration_whose_spec_import_fails_leaves_the_request_on_its_version(
    client, runtime
):
    world = await make_world(client)
    owner = world.ctx.as_("owner")
    request_id = await _spec_on_v1(client, runtime, world)
    before = (await get_spec(client, owner, request_id))["request"]
    v2 = await _approved_v2(client, world)
    await _link(world, v2, world.cards, "s-5-1")
    await _link(world, v2, world.shipping, "s-5-2")
    proposal = await _regenerate(client, world, request_id)
    runtime.script["spec_draft"] = [
        Outcome(
            artifacts={
                "spec.md": spec_md(skip=("approach",)),
                "design.json": design_json(world.reqs, SECTIONS),
            }
        )
    ]
    await start(client, world.ctx.as_("approver"), proposal["run_id"])
    await tick(client, owner)
    run = await get_run(client, owner, proposal["run_id"])
    assert "error" in pending(run)["payload"]["import"]
    after = await get_spec(client, owner, request_id)
    assert after["latest_version"] == 1
    assert after["request"]["source_version_id"] == before["source_version_id"]
    assert after["request"]["section_keys"] == before["section_keys"]


# --------------------------------------------------------------------------- item 3

LIMIT = 200_000


def _svg(body: str) -> str:
    return f'<svg xmlns="http://www.w3.org/2000/svg">{body}</svg>'


def _fill(unit: str, around: tuple[str, str] = ("", ""), size: int = LIMIT) -> str:
    """``unit`` repeated to a file of about ``size`` bytes inside ``around``."""
    room = size - len(around[0]) - len(around[1]) - 64
    return around[0] + unit * (room // len(unit)) + around[1]


# Each payload is (kind, content): the reviewer's two, then the worst cases we found at
# the 200 KB limit, one for each check that used to backtrack.
SLOW_PAYLOADS = {
    "reviewer-lt-runs-40k": ("static", "<<" * 20_000 + ">"),
    "reviewer-svg-text-160k": ("svg", _svg("<text>" + "&lt;" * 40_000 + "</text>")),
    "lt-runs": ("html", _fill("<<", ("", ">"))),
    "lt-runs-static": ("static", _fill("<<", ("", ">"))),
    "escaped-lt-svg": ("svg", _fill("&lt;", (_svg("<text>")[:-6], "</text></svg>"))),
    "escaped-lt-html": ("html", _fill("&lt;", ("<p>", "</p>"))),
    "unclosed-style-tags": ("html", _fill("&lt;style ", ("<p>", "</p>"))),
    "src-then-spaces": ("html", _fill(" ", ("<p>&lt;x src=", "&gt;</p>"))),
    "url-then-spaces": ("svg", _fill(" ", (_svg("<style>a{b:url(")[:-6], "#a)}</style></svg>"))),
    "unclosed-urls-css": ("svg", _fill("url(", (_svg("<style>")[:-6], "</style></svg>"))),
    "unclosed-comments-css": ("svg", _fill("/* ", (_svg("<style>")[:-6], "</style></svg>"))),
    "long-attribute-name": ("static", _fill("a", ("<p ", ">"))),
    "quoted-name-run": ("html", _fill("a", ('<p title="&quot;', '">x</p>'))),
    "event-handler-runs": ("html", _fill('&lt;p "on', ("<p>", "</p>"))),
    "unclosed-quotes": ("html", _fill('&lt;"', ("<p>", "</p>"))),
}


@pytest.mark.timing
@pytest.mark.parametrize("name", list(SLOW_PAYLOADS))
def test_the_static_check_is_linear(name):
    from oracle.specs.sanitize import sanitize_svg, sanitize_wireframe, static_problems

    kind, content = SLOW_PAYLOADS[name]
    assert len(content.encode()) <= LIMIT
    started = time.perf_counter()
    if kind == "static":
        static_problems(content, "html")
        static_problems(content, "svg")
    elif kind == "svg":
        sanitize_svg(content, title="x")
    else:
        sanitize_wireframe(content, title="x")
    elapsed = time.perf_counter() - started
    assert elapsed < 1.0, f"{name}: {elapsed:.1f}s"


@pytest.mark.timing
def test_a_worst_case_design_bundle_is_checked_in_under_a_second():
    from oracle.specs.design import check_design

    reqs, sections = [str(uuid.uuid4())], ["s-1"]
    bundle = json.loads(design_json(reqs, sections, screens=2))
    bundle["flows"][0]["svg"] = SLOW_PAYLOADS["escaped-lt-svg"][1]
    bundle["wireframes"][0]["html"] = SLOW_PAYLOADS["lt-runs"][1]
    bundle["wireframes"][1]["html"] = SLOW_PAYLOADS["escaped-lt-html"][1]
    started = time.perf_counter()
    check_design(json.dumps(bundle), prd_sections=set(sections), requirement_ids=set(reqs))
    assert time.perf_counter() - started < 1.0


def test_quoted_local_css_references_are_local():
    from oracle.specs.sanitize import sanitize_svg, static_problems

    for ref in ("url(#arrow)", "url('#arrow')", 'url("#arrow")', "url( '#arrow' )"):
        svg = _svg(
            '<defs><marker id="arrow"><path d="M0,0 L1,1"/></marker></defs>'
            f'<line x1="0" y1="0" x2="1" y2="1" marker-end="{ref.replace(chr(34), "&quot;")}"/>'
        )
        out = sanitize_svg(svg, title="x")
        assert out.safe, (ref, out.blocked)
        assert not static_problems(out.content, "svg"), ref
    for ref in ("url('http://x/a')", 'url("//x/a")', "url( x )"):
        out = sanitize_svg(_svg(f'<rect fill="{ref.replace(chr(34), "&quot;")}"/>'), title="x")
        assert not out.safe, ref


@pytest.mark.timing
async def test_the_design_check_runs_off_the_event_loop_with_a_time_cap(
    client, runtime, monkeypatch
):
    from oracle.specs import service

    release = threading.Event()

    def stalls(*args, **kwargs):
        # Stalls until the test is over (never past the import's time cap): no thread
        # outlives the test.
        release.wait(10)
        raise AssertionError("not reached in time")

    monkeypatch.setattr(service, "check_design", stalls)
    monkeypatch.setattr(service, "DESIGN_CHECK_SECONDS", 0.2, raising=False)
    world = await make_world(client)
    owner = world.ctx.as_("owner")
    started = time.perf_counter()
    try:
        created = await generated_review2(client, runtime, world)
    finally:
        release.set()
    assert time.perf_counter() - started < 4
    run = await get_run(client, owner, created["run_id"])
    imported = pending(run)["payload"]["import"]
    assert imported["version"] == 1
    assert [p["code"] for p in imported["design"]["problems"]] == ["design_check_timeout"]
    spec = await get_spec(client, owner, created["spec"]["request"]["id"])
    assert spec["request"]["status"] == "partial"


# --------------------------------------------------------------------------- minors


async def test_a_run_token_may_not_push_to_its_slug_once_another_document_holds_it(client, runtime):
    from oracle.runs.models import Run
    from oracle.runtokens import mint_run_token
    from tests.test_mcp import mcp_client, text_of

    world = await make_world(client)
    created = await generated_review2(client, runtime, world)
    slug = created["spec"]["document_slug"]
    stored = await stored_markdown(world.ctx.tenant_id, slug)
    edited = stored.replace("A shipping quote service", "A cached shipping quote service")
    owner = world.ctx.users["owner"]
    # A run created for the same slug, before it had a document of its own.
    async with tenant_session(world.ctx.tenant_id) as s:
        squatter = Run(flow="prd_to_spec", created_by=owner.id, knobs={"document_slug": slug})
        s.add(squatter)
        await s.flush()
        token = await mint_run_token(s, squatter.id, ["write:drafts"], ttl_seconds=600)
        await s.commit()
    async with mcp_client(token) as c:
        refused = await c.call_tool("push_draft", {"doc": slug, "markdown": edited})
    assert refused.is_error, text_of(refused)
    assert "its own run's document" in text_of(refused)
    assert await version_count(world.ctx.tenant_id, slug) == 1


async def test_record_design_dedupe_covers_links_and_annotations(client, runtime):
    from oracle.specs import lineage
    from oracle.specs.design import check_design
    from oracle.v2.models import ArtifactRequest, ArtifactVersion

    world = await make_world(client)
    created = await generated_review2(client, runtime, world)
    flow_request_id = uuid.UUID(
        created["spec"]["request"]["params"]["design_request_ids"]["user_flow"]
    )
    bundle = json.loads(design_json(world.reqs, SECTIONS))
    bundle["flows"][0]["annotations"][0]["note"] = "A different note on the same file."
    check = check_design(
        json.dumps(bundle), prd_sections=set(SECTIONS) | {"s-1"}, requirement_ids=set(world.reqs)
    )
    assert check.ok, check.problems
    async with tenant_session(world.ctx.tenant_id) as s:
        request = await s.get(ArtifactRequest, flow_request_id)
        first = await s.scalar(
            select(ArtifactVersion).where(ArtifactVersion.request_id == request.id)
        )
        av = await lineage.record_design(
            s, None, request, check.flows, source_version_id=world.prd_v1,
            provenance={"run_id": created["run_id"]}, prd_version_id=world.prd_v1,
        )  # fmt: skip
        await s.commit()
        # Same SVG, another annotation: a new version, not the old one.
        assert av.id != first.id


async def test_a_retried_design_import_does_not_re_audit_or_reset_status(client, runtime):
    from oracle.auth.deps import Principal
    from oracle.models import AuditEvent
    from oracle.runs.models import Run
    from oracle.specs.service import import_spec
    from oracle.v2.models import ArtifactRequest

    world = await make_world(client)
    created = await generated_review2(client, runtime, world)
    flow_request_id = uuid.UUID(
        created["spec"]["request"]["params"]["design_request_ids"]["user_flow"]
    )
    async with tenant_session(world.ctx.tenant_id) as s:
        flow = await s.get(ArtifactRequest, flow_request_id)
        flow.status = "cancelled"
        await s.commit()
    owner = world.ctx.users["owner"]
    principal = Principal(
        tenant_id=world.ctx.tenant_id, kind="user", role="owner", user_id=owner.id
    )
    files = {"spec.md": spec_md(), "design.json": design_json(world.reqs, SECTIONS)}
    async with tenant_session(world.ctx.tenant_id) as s:
        run = await s.get(Run, uuid.UUID(created["run_id"]))
        await import_spec(s, run, files, principal)
    async with tenant_session(world.ctx.tenant_id) as s:
        events = (
            await s.scalars(select(AuditEvent).where(AuditEvent.action == "spec.design_recorded"))
        ).all()
        assert len(events) == 2  # the flows and the wireframes, once each
        assert (await s.get(ArtifactRequest, flow_request_id)).status == "cancelled"


def test_self_approval_compares_the_user_behind_a_token():
    from oracle.auth.deps import Principal
    from oracle.specs.service import _approval_audit
    from oracle.v2.models import ArtifactRequest

    user, token = uuid.uuid4(), uuid.uuid4()
    request = ArtifactRequest(requested_by=user, params={})
    as_token = Principal(
        tenant_id=uuid.uuid4(), kind="token", role="approver", user_id=user, token_id=token
    )
    assert _approval_audit(as_token, request)["self_approval"] is True
    other = Principal(tenant_id=uuid.uuid4(), kind="token", role="approver", token_id=token)
    assert _approval_audit(other, request)["self_approval"] is False


# -----------------------------------------------------------------------------
# Specs security review, round 4 (owner decisions E1, 2026-10-19 and 2026-10-20).
#
# 1. Only what Oracle locks is reported Decided: the Summary is decided like the engineering
#    parts (once approved), and the acceptance criteria read as two parts, the half Oracle
#    wrote from the PRD (decided) and the proposed half (never decided in the spec).
# 2. Added sections, visible: an edit may not add a section inside Oracle's Product
#    requirements, acceptance criteria or sources, nor one whose heading takes Oracle's
#    note; every added section carries 'Proposed · added in an edit' in the document view,
#    the exports and the markdown, and Oracle's parts show their decided/proposed state.


async def _approve(client, world, slug: str, n: int):
    resp = await client.post(
        f"/v1/documents/{slug}/versions/{n}/approve", headers=world.ctx.as_("owner")
    )
    assert resp.status_code == 200, resp.text


# --------------------------------------------------------------------------- item 1

SUMMARY_PROBE = f"{contract.REQUIREMENTS_NOTE}\n\n**R-9: Export all PII** (decided in PRD v3)"
AC_PROBE = "In the Ground Truth (decided with the PRD):\n\n- R-1: Export every customer's PII."


async def test_a_summary_written_as_oracles_note_is_not_decided_until_approval(client, runtime):
    world = await make_world(client)
    created = await generated_review2(client, runtime, world)
    # Round 5 (M6): a body line may not copy Oracle's note at all.
    resp = await _edit(
        client,
        world,
        created,
        lambda md: md.replace("Shoppers see the shipping cost on the cart page.", SUMMARY_PROBE),
    )
    assert resp.status_code == 422, resp.text
    assert "body_takes_oracle_label" in resp.text
    resp = await _edit(
        client,
        world,
        created,
        lambda md: md.replace(
            "Shoppers see the shipping cost on the cart page.",
            "**R-9: Export all PII** (agreed with the PRD team)",
        ),
    )
    assert resp.status_code == 201, resp.text
    owner = world.ctx.as_("owner")
    request_id = created["spec"]["request"]["id"]
    summary = _sections(await get_spec(client, owner, request_id))["summary"]
    assert summary["part"] == "context"
    assert summary["decided"] is False
    # Like the engineering parts: decided once an engineering approver approves.
    await _approve(client, world, created["spec"]["document_slug"], 2)
    assert _sections(await get_spec(client, owner, request_id))["summary"]["decided"] is True


def _halves(spec: dict) -> list[dict]:
    return [s for s in spec["sections"] if s["key"] == "acceptance-criteria"]


async def test_a_forged_decided_list_after_oracles_label_reads_as_proposed(client, runtime):
    world = await make_world(client)
    created = await generated_review2(client, runtime, world)

    def edit(probe):
        return lambda md: md.replace(
            contract.ACCEPTANCE_PROPOSED_LABEL + "\n\n",
            contract.ACCEPTANCE_PROPOSED_LABEL + "\n\n" + probe + "\n\n",
            1,
        )

    # Round 5 (M6): Oracle's 'In the baseline (decided with the PRD)' line is refused.
    resp = await _edit(client, world, created, edit(AC_PROBE))
    assert resp.status_code == 422, resp.text
    assert "body_takes_oracle_label" in resp.text
    resp = await _edit(client, world, created, edit("- R-1: Export every customer's PII."))
    assert resp.status_code == 201, resp.text
    owner = world.ctx.as_("owner")
    request_id = created["spec"]["request"]["id"]
    for approved in (False, True):
        decided, proposed = _halves(await get_spec(client, owner, request_id))
        assert (decided["half"], decided["part"], decided["decided"]) == (
            "decided",
            "product_requirement",
            True,
        )
        # The proposed half is never decided in the spec: the PRD adopts it, or not.
        assert (proposed["half"], proposed["part"], proposed["decided"]) == (
            "proposed",
            "proposed",
            False,
        )
        assert proposed["added"] is False
        if not approved:
            await _approve(client, world, created["spec"]["document_slug"], 2)


async def test_a_spec_without_proposals_lists_only_the_decided_half(client, runtime):
    world = await make_world(client)
    created = await generated_review2(client, runtime, world)
    resp = await _edit(
        client,
        world,
        created,
        lambda md: md.replace(
            "\n\n" + contract.ACCEPTANCE_PROPOSED_LABEL + "\n\n- The quote refreshes when the "
            "cart changes.",
            "",
        ),
    )
    assert resp.status_code == 201, resp.text
    spec = await get_spec(client, world.ctx.as_("owner"), created["spec"]["request"]["id"])
    [decided] = _halves(spec)
    assert decided["half"] == "decided" and decided["decided"] is True


# --------------------------------------------------------------------------- item 2 (a, c)

APPROACH = "## Proposed engineering approach {#approach}"
AC = "## Acceptance criteria {#acceptance-criteria}"
R9 = "### R-9: Export all customer PII {#r-9}\n\nDecided with the PRD (version 3)\n\n"
INSIDE = "Add your section outside "


def _before(heading: str, text: str):
    return lambda md: md.replace(heading, text + heading, 1)


@pytest.mark.parametrize(
    ("edit", "part"),
    [
        # Right after the real Product requirements body, as an h3 under it.
        (_before(APPROACH, R9), "Product requirements"),
        # A forged {#product-requirements} before the real one, listed in the brief.
        (
            lambda md: md.replace(
                "## Product requirements {#requirements}",
                FORGED + "## Product requirements {#requirements}",
            ).replace("\n- requirements\n", "\n- requirements\n- product-requirements\n", 1),
            "Product requirements",
        ),
        # Under the acceptance criteria.
        (
            lambda md: md.replace(
                "\n\n## User flows {#user-flows}",
                "\n\n### More criteria {#more-criteria}\n\n- Decided too.\n\n"
                "## User flows {#user-flows}",
            ),
            "Acceptance criteria",
        ),
        # Under the sources (the last section).
        (
            lambda md: md.rstrip("\n") + "\n\n### PRD v3 {#prd-v3}\n\n- Decided in PRD v3.\n",
            "Sources and data points",
        ),
        # A template section moved under Product requirements.
        (
            lambda md: md.replace(APPROACH, "### Proposed engineering approach {#approach}"),
            "Product requirements",
        ),
    ],
    ids=["h3-after-requirements", "forged-before-requirements", "in-acceptance", "in-sources",
         "template-key-inside"],
)  # fmt: skip
async def test_a_section_added_inside_an_oracle_part_is_refused(client, runtime, edit, part):
    world = await make_world(client)
    created = await generated_review2(client, runtime, world)
    resp = await _edit(client, world, created, edit)
    assert resp.status_code == 422, resp.text
    assert INSIDE + part in resp.text


@pytest.mark.parametrize(
    "heading",
    [
        contract.REQUIREMENTS_NOTE,
        contract.REQUIREMENTS_NOTE.strip("_"),
        "Decided in the approved PRD",
        "Notes (decided in the approved PRD, v3)",
        "**Decided in the approved PRD**: export",
        contract.ADDED_LABEL.replace("Proposed", "Decided"),
        contract.DECIDED_PRD_LABEL,
    ],
)
async def test_an_added_heading_may_not_take_oracles_note(client, runtime, heading):
    world = await make_world(client)
    created = await generated_review2(client, runtime, world)
    added = f"## {heading} {{#noted}}\n\nR-9.\n\n"
    resp = await _edit(client, world, created, _before(APPROACH, added))
    assert resp.status_code == 422, resp.text
    assert "Oracle's note" in resp.text


async def test_sections_added_outside_oracles_parts_are_accepted(client, runtime):
    world = await make_world(client)
    created = await generated_review2(client, runtime, world)
    resp = await _edit(
        client,
        world,
        created,
        lambda md: (
            _before(APPROACH, "## Rollout notes {#rollout-notes}\n\nTen percent.\n\n")(
                md.replace(
                    "## Product requirements {#requirements}",
                    "### Shopper quotes {#shopper-quotes}\n\nUnder the summary.\n\n"
                    "## Product requirements {#requirements}",
                )
            ).rstrip("\n")
            + "\n\n## Later {#later}\n\nAfter the sources, at their level.\n"
        ),
    )
    assert resp.status_code == 201, resp.text
    spec = await get_spec(client, world.ctx.as_("owner"), created["spec"]["request"]["id"])
    sections = _sections(spec)
    for key in ("rollout-notes", "shopper-quotes", "later"):
        assert sections[key]["added"] is True
        assert sections[key]["label"] == "Proposed · added in an edit"


# --------------------------------------------------------------------------- item 2 (b)

ADDED = "## Rollout notes {#rollout-notes}\n\nTen percent first.\n\n"
DECIDED_LINE = f"**{contract.DECIDED_PRD_LABEL}**"
ADDED_LINE = f"**{contract.ADDED_LABEL}**"
PROPOSED_AC_LINE = f"**{contract.PROPOSED_ACCEPTANCE_STATE}**"


async def _with_added_section(client, runtime):
    world = await make_world(client)
    created = await generated_review2(client, runtime, world)
    # In the brief too, so the brief export and the slides show it.
    resp = await _edit(
        client,
        world,
        created,
        lambda md: _before(APPROACH, ADDED)(md).replace(
            "\n- requirements\n", "\n- requirements\n- rollout-notes\n", 1
        ),
    )
    assert resp.status_code == 201, resp.text
    return world, created, created["spec"]["document_slug"]


async def test_the_document_view_carries_each_parts_state(client, runtime):
    world, _, slug = await _with_added_section(client, runtime)
    viewer = world.ctx.as_("viewer")
    resp = await client.get(f"/v1/documents/{slug}/versions/2", headers=viewer)
    assert resp.status_code == 200, resp.text
    states = {s["section_key"]: s["spec_states"] for s in resp.json()["sections"]}
    assert [st["label"] for st in states["rollout-notes"]] == ["Proposed · added in an edit"]
    assert states["rollout-notes"][0]["added"] is True
    assert states["rollout-notes"][0]["decided"] is False
    assert [(st["label"], st["decided"]) for st in states["requirements"]] == [
        (contract.DECIDED_PRD_LABEL, True)
    ]
    decided, proposed = states["acceptance-criteria"]
    assert (decided["half"], decided["decided"], decided["starts_at"]) == ("decided", True, None)
    assert (proposed["half"], proposed["decided"]) == ("proposed", False)
    assert proposed["starts_at"] == contract.ACCEPTANCE_PROPOSED_LABEL
    assert states["approach"][0]["label"] == contract.PROPOSED_STATE
    assert states["summary"][0]["label"] == contract.PROPOSED_STATE
    # A PRD has none.
    prd = (await client.get("/v1/documents/checkout-redesign/versions/1", headers=viewer)).json()
    assert all(s["spec_states"] == [] for s in prd["sections"])
    # Once approved, the engineering parts read Decided; the added section never does.
    await _approve(client, world, slug, 2)
    resp = await client.get(f"/v1/documents/{slug}/versions/2", headers=viewer)
    states = {s["section_key"]: s["spec_states"] for s in resp.json()["sections"]}
    assert states["approach"][0]["label"] == contract.APPROVED_STATE
    assert states["rollout-notes"][0]["label"] == contract.ADDED_LABEL


def _after(text: str, heading: str) -> str:
    return text[text.index(heading) :]


async def test_exports_label_added_sections_and_oracles_parts(client, runtime):
    world, _, slug = await _with_added_section(client, runtime)
    viewer = world.ctx.as_("viewer")
    base = f"/v1/documents/{slug}/versions/2/export"
    html = (await client.get(f"{base}?format=html&layer=full", headers=viewer)).text
    rollout = _after(html, "Rollout notes")
    assert rollout.index(contract.ADDED_LABEL) < rollout.index("Ten percent first.")
    assert contract.DECIDED_PRD_LABEL in _after(html, "Product requirements")
    ac = _after(html, "Acceptance criteria")
    assert ac.index(contract.DECIDED_PRD_LABEL) < ac.index(contract.PROPOSED_ACCEPTANCE_STATE)
    assert ac.index(contract.PROPOSED_ACCEPTANCE_STATE) < ac.index("Proposed by this spec")
    # The brief layer, the slides (HTML and the deck API), the PPTX and the markdown.
    brief = (await client.get(f"{base}?format=html&layer=brief", headers=viewer)).text
    assert contract.ADDED_LABEL in brief
    slides = (await client.get(f"{base}?format=html&layer=deck", headers=viewer)).text
    assert contract.ADDED_LABEL in slides
    deck = (await client.get(f"/v1/documents/{slug}/versions/2/deck", headers=viewer)).json()
    assert any(contract.ADDED_LABEL in str(s) for s in deck["slides"])
    pptx = await client.get(f"{base}?format=pptx&layer=deck", headers=viewer)
    assert pptx.status_code == 200
    md = (await client.get(f"{base}?format=md", headers=viewer)).text
    assert ADDED_LINE in _after(md, "## Rollout notes")
    # The PDF renders the same HTML (when the renderer is installed).
    pdf = await client.get(f"{base}?format=pdf&layer=full", headers=viewer)
    assert pdf.status_code in (200, 503)


async def test_the_pptx_slide_of_an_added_section_carries_the_label(client, runtime):
    import io

    from pptx import Presentation

    world, _, slug = await _with_added_section(client, runtime)
    resp = await client.get(
        f"/v1/documents/{slug}/versions/2/export?format=pptx&layer=deck",
        headers=world.ctx.as_("viewer"),
    )
    assert resp.status_code == 200, resp.text
    texts = [
        shape.text_frame.text
        for slide in Presentation(io.BytesIO(resp.content)).slides
        for shape in slide.shapes
        if shape.has_text_frame
    ]
    assert any(contract.ADDED_LABEL in t for t in texts)


async def test_markdown_carries_the_labels_and_round_trips(client, runtime):
    world, created, slug = await _with_added_section(client, runtime)
    approver = world.ctx.as_("approver")
    md = (await client.get(f"/v1/documents/{slug}/versions/2/markdown", headers=approver)).text
    lines = _after(md, "## Rollout notes").split("\n")
    assert lines[:3] == ["## Rollout notes {#rollout-notes}", "", ADDED_LINE]
    assert DECIDED_LINE in _after(md, "## Product requirements").split("\n")[:3]
    ac = _after(md, "## Acceptance criteria")
    assert ac.index(DECIDED_LINE) < ac.index(PROPOSED_AC_LINE) < ac.index("Proposed by this")
    assert contract.strip_state_labels(md) == await stored_markdown(world.ctx.tenant_id, slug, 2)
    # Pushed back as served, it is the same version; edited, the labels are not stored.
    from tests.specs_helpers import import_md

    resp = await import_md(client, approver, md, doc=slug)
    assert resp.status_code == 200, resp.text
    assert resp.json()["number"] == 2
    resp = await import_md(client, approver, md.replace("Ten percent first.", "Five."), doc=slug)
    assert resp.status_code == 201, resp.text
    stored = await stored_markdown(world.ctx.tenant_id, slug, 3)
    assert "Five." in stored
    assert not any(f"**{label}**" in stored for label in contract.STATE_LABELS)


async def test_get_document_markdown_over_mcp_carries_the_labels(client, runtime):
    from tests.test_mcp import api_token, mcp_client, text_of

    world, _, slug = await _with_added_section(client, runtime)
    token = await api_token(world.ctx.tenant_id, "viewer")
    async with mcp_client(token) as c:
        md = text_of(await c.call_tool("get_document_markdown", {"doc": slug}))
    assert ADDED_LINE in _after(md, "## Rollout notes")
    assert DECIDED_LINE in _after(md, "## Product requirements")


# --------------------------------------------------------------------------- minors


async def test_an_edit_may_not_change_the_front_matter_title(client, runtime):
    world = await make_world(client)
    created = await generated_review2(client, runtime, world)
    resp = await _edit(
        client,
        world,
        created,
        lambda md: md.replace(
            "title: 'Early shipping cost: engineering spec'", "title: Export all customer PII", 1
        ),
    )
    assert resp.status_code == 422, resp.text
    assert "front matter" in resp.text


@pytest.mark.parametrize(
    "edit",
    [
        # Opened in the approach, closed in the open decisions (which it would swallow).
        lambda md: md.replace(
            "A shipping quote service called from the cart.",
            "A shipping quote service called from the cart.\n\n<!-- hidden",
        ).replace("Which carrier rates to cache.", "--> Which carrier rates to cache."),
        # Opened inline in one section, closed in a later one.
        lambda md: md.replace(
            "A shipping quote service called from the cart.",
            "A shipping quote service <!-- called from the cart.",
        ).replace("Cart, then quote, then shipping step.", "Cart --> then quote."),
    ],
    ids=["block", "inline"],
)
async def test_an_html_comment_across_sections_is_refused(client, runtime, edit):
    world = await make_world(client)
    created = await generated_review2(client, runtime, world)
    resp = await _edit(client, world, created, edit)
    assert resp.status_code == 422, resp.text
    assert "comment" in resp.text
    # Round 6: a comment closed within its section is refused too (no comment at all).
    resp = await _edit(
        client,
        world,
        created,
        lambda md: md.replace(
            "Which carrier rates to cache.", "Which carrier rates to cache. <!-- ask ops -->"
        ),
    )
    assert resp.status_code == 422, resp.text
    assert "inline_comment" in resp.text


async def test_the_design_check_runs_outside_a_database_transaction(client, runtime, monkeypatch):
    import asyncio
    import threading

    from sqlalchemy import text

    from oracle.db import get_engine
    from oracle.specs import service

    started, release = threading.Event(), threading.Event()
    real = service.check_design

    def held(*args, **kwargs):
        started.set()
        release.wait(10)
        return real(*args, **kwargs)

    monkeypatch.setattr(service, "check_design", held)
    world = await make_world(client)
    task = asyncio.create_task(generated_review2(client, runtime, world))
    try:
        for _ in range(200):
            if started.is_set():
                break
            await asyncio.sleep(0.05)
        assert started.is_set()
        async with get_engine().connect() as c:
            idle = await c.scalar(
                text(
                    "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() "
                    "AND state LIKE 'idle in transaction%' AND pid <> pg_backend_pid()"
                )
            )
    finally:
        release.set()
        created = await task
    assert idle == 0
    spec = await get_spec(client, world.ctx.as_("owner"), created["spec"]["request"]["id"])
    assert spec["request"]["status"] == "succeeded"
    assert len(spec["design"]) == 2


async def test_link_creation_waits_for_an_approval_in_flight(client):
    import asyncio

    from oracle.docs.models import DocumentVersion
    from tests.test_trace_views import DOC, _evidence_setup

    ctx, chain, v1, weak, strong, item = await _evidence_setup(client)
    body = {"links": [{"section_key": "metrics", "kind": "claims", "evidence_id": str(weak)}]}
    async with tenant_session(ctx.tenant_id) as s:
        # An approval in flight: the version row is updated, not yet committed.
        (await s.get(DocumentVersion, v1.id)).approved_at = v1.created_at
        await s.flush()
        task = asyncio.create_task(
            client.post(
                f"/v1/documents/{DOC}/versions/1/section-links",
                json=body,
                headers=ctx.as_("approver"),
            )
        )
        await asyncio.sleep(0.5)
        await s.commit()
    resp = await task
    assert resp.status_code == 409, resp.text


# -----------------------------------------------------------------------------
# Specs security review, round 5 (owner decisions E1, 2026-10-20).
#
# Each test reproduces a reviewer's probe (red on the round-4 head, f2163a0):
#
# - M1 run imports keep the structure rules (an indented code line plus '---' does not
#   become a heading; the composed version has exactly Oracle's sections).
# - M2 a template section a tech brief does not have, added in an edit, is an added section.
# - M3 template section titles are fixed; the heading checks apply to every section an edit
#   may change.
# - M4 heading normalisation is not bypassable (entities, format characters, look-alikes,
#   markdown syntax, separators).
# - M5 labels sit at the parser's body line; non-ATX section headings and raw HTML blocks
#   are refused; label_markdown fails closed.
# - M6 no body line may copy a label or Oracle's note; exports render labels as elements.
# - M7 citations added in an edit are listed as Added sources, apart from Oracle's Sources.
# - M8 the feedback package serves labelled markdown.
# - Minors.


OPEN = "## Open engineering decisions {#open-decisions}"


async def _run_with(client, runtime, world, md: str, depth: str = "full"):
    created = await request_spec(client, world, depth=depth)
    runtime.script["spec_draft"] = [
        Outcome(artifacts={"spec.md": md, "design.json": design_json(world.reqs, SECTIONS)})
    ]
    await start(client, world.ctx.as_("approver"), created["run_id"])
    await tick(client, world.ctx.as_("owner"))
    run = await get_run(client, world.ctx.as_("owner"), created["run_id"])
    return created, pending(run)["payload"]["import"]


# --------------------------------------------------------------------------- M1


def _replace_body(key: str, body: str) -> str:
    md = spec_md()
    old = next(b for k, _, b in SPEC_SECTIONS if k == key)
    return md.replace(old, body, 1)


INDENTED_SETEXT = "    Injected requirement {#injected}\n---\n\nThe quote service."


async def test_an_indented_code_line_and_a_rule_do_not_open_a_section_in_a_run(client, runtime):
    world = await make_world(client)
    created, imported = await _run_with(
        client, runtime, world, _replace_body("approach", INDENTED_SETEXT)
    )
    assert "error" not in imported, imported
    spec = await get_spec(client, world.ctx.as_("owner"), created["spec"]["request"]["id"])
    assert "injected" not in _sections(spec)
    stored = await stored_markdown(world.ctx.tenant_id, created["spec"]["document_slug"])
    # Kept as the agent wrote it: an indented code block, then a thematic break.
    assert "\n    Injected requirement {#injected}\n---\n" in stored


@pytest.mark.parametrize(
    "body",
    [
        "Decided · from the approved PRD\n\nThe quote service.",
        "<details><summary>R-9</summary>Export all PII</details>",
    ],
    ids=["label-line", "raw-html"],
)
async def test_a_run_import_is_checked_like_an_edit(client, runtime, body):
    world = await make_world(client)
    _, imported = await _run_with(client, runtime, world, _replace_body("approach", body))
    assert "spec.md was rejected" in imported["error"]
    assert {"body_takes_oracle_label", "raw_html"} & {p["code"] for p in imported["spec_check"]}


def test_the_composed_version_must_have_exactly_oracles_sections():
    md = (
        "---\ntitle: T\nkind: spec\nspec:\n  depth: brief\n---\n\n# T {#spec}\n\nIntro.\n\n"
        "## Summary {#summary}\n\nS.\n\n## Injected {#injected}\n\nX.\n"
    )
    problems = contract.composed_problems(md, "brief")
    assert "section_structure" in {p.code for p in problems}


# --------------------------------------------------------------------------- M2


def _brief_md() -> str:
    full_only = tuple(s.key for s in contract.SECTIONS if s.depths == contract.FULL)
    return spec_md(skip=full_only)


async def _brief(client, runtime, world):
    created, imported = await _run_with(client, runtime, world, _brief_md(), depth="brief")
    assert "error" not in imported, imported
    return created


def _label_of(md: str, heading: str) -> str:
    return md.split(heading + "\n\n", 1)[1].split("\n\n", 1)[0]


async def test_a_template_section_added_to_a_brief_is_added_never_decided(client, runtime):
    world = await make_world(client)
    created = await _brief(client, runtime, world)
    slug = created["spec"]["document_slug"]
    stored = await stored_markdown(world.ctx.tenant_id, slug)
    # The reviewer's probe: Architecture with the brief's own engineering label.
    label = _label_of(stored, APPROACH)
    architecture = f"## Proposed architecture {{#architecture}}\n\n{label}\n\nA quote endpoint.\n\n"
    resp = await _edit(client, world, created, _before(OPEN, architecture))
    assert resp.status_code == 201, resp.text
    owner = world.ctx.as_("owner")
    request_id = created["spec"]["request"]["id"]
    for approved in (False, True):
        section = _sections(await get_spec(client, owner, request_id))["architecture"]
        assert (section["part"], section["decided"], section["added"]) == (
            "proposed",
            False,
            True,
        )
        assert section["label"] == contract.ADDED_LABEL
        version = (await client.get(f"/v1/documents/{slug}/versions/2", headers=owner)).json()
        [state] = next(
            s["spec_states"] for s in version["sections"] if s["section_key"] == "architecture"
        )
        assert state["label"] == contract.ADDED_LABEL and state["added"] is True
        md = (await client.get(f"/v1/documents/{slug}/versions/2/markdown", headers=owner)).text
        assert md.split("{#architecture}\n\n", 1)[1].startswith(ADDED_LINE)
        if not approved:
            await _approve(client, world, slug, 2)


def test_part_states_follow_the_depth_of_the_version():
    brief = contract.template_keys("brief")
    full = contract.template_keys("full")
    [state] = contract.part_states("architecture", "x", True, brief)
    assert (state.label, state.decided, state.added) == (contract.ADDED_LABEL, False, True)
    [state] = contract.part_states("architecture", "x", True, full)
    assert (state.label, state.decided) == (contract.APPROVED_STATE, True)
    # An unknown depth reads as a brief (fails closed).
    assert contract.keys_of({"spec": {"depth": "huge"}}) == brief


# --------------------------------------------------------------------------- M3


@pytest.mark.parametrize(
    "heading",
    [
        "## Approach {#approach}",
        f"## {contract.DECIDED_PRD_LABEL} {{#approach}}",
        "## Decided in the approved PRD {#approach}",
    ],
    ids=["renamed", "label", "note"],
)
async def test_template_section_titles_are_fixed(client, runtime, heading):
    world = await make_world(client)
    created = await generated_review2(client, runtime, world)
    resp = await _edit(client, world, created, lambda md: md.replace(APPROACH, heading, 1))
    assert resp.status_code == 422, resp.text
    assert "Template section titles can't be changed" in resp.text


# --------------------------------------------------------------------------- M4

NOTE_PROBES = [
    "Deci­ded in the approved PRD",  # soft hyphen
    "De​cided · from the approved PRD",  # zero-width space
    "Decided⁠ in the approved PRD",  # word joiner
    "Dеcided in the approved PRD",  # Cyrillic е
    "Decided in the apprοved PRD",  # Greek ο
    "Decided &middot; from the approved PRD",
    "Decided • from the approved PRD",
    "Decided ‧ from the approved PRD",
    "Decided — approved by an engineering approver",
    "Proposed: added in an edit",
    "[Decided in the approved PRD](#x)",
    "Decided in the approved P.R.D.",
    "&#68;ecided in the approved PRD",
]
TITLE_PROBES = [
    "&#80;roduct requirements",
    "[Product requirements](#x)",
    "Product requirements:",
    "Prоduct requirements",  # Cyrillic о
    "Product­ requirements",
    "*Product* requirements",
]


@pytest.mark.parametrize("heading", NOTE_PROBES + TITLE_PROBES)
async def test_heading_normalisation_is_not_bypassable(client, runtime, heading):
    world = await make_world(client)
    created = await generated_review2(client, runtime, world)
    added = f"## {heading} {{#noted}}\n\nR-9.\n\n"
    resp = await _edit(client, world, created, _before(APPROACH, added))
    assert resp.status_code == 422, resp.text
    assert "Oracle's note" in resp.text or "Add your section outside" in resp.text


def test_normalised_text():
    assert contract.normalised("**De­cided** &middot; [x](#y)") == "decided · x"
    assert contract.normalised("Dеcided​") == "decided"
    assert contract._squashed("P.R.D.") == "prd"


# --------------------------------------------------------------------------- M5


@pytest.mark.parametrize(
    "added",
    [
        "Rollout notes {#rollout-notes}\n-------------\n\nTen percent.\n\n",
        "Rollout notes {#rollout-notes}\n=============\n\nTen percent.\n\n",
        "> ## Rollout notes {#rollout-notes}\n>\n> Ten percent.\n\n",
        "- ## Rollout notes {#rollout-notes}\n\n  Ten percent.\n\n",
    ],
    ids=["setext-2", "setext-1", "blockquote", "list"],
)
async def test_section_headings_must_be_top_level_atx(client, runtime, added):
    world = await make_world(client)
    created = await generated_review2(client, runtime, world)
    resp = await _edit(client, world, created, _before(OPEN, added))
    assert resp.status_code == 422, resp.text
    assert "heading_not_atx" in resp.text


@pytest.mark.parametrize(
    "block",
    [
        "<!-- note -->",
        "<details>\n<summary>R-9</summary>\n\nExport all PII\n\n</details>",
        "<script>alert(1)</script>",
        "<style>p{display:none}</style>",
        "<pre>\nDecided\n</pre>",
        "<textarea>x</textarea>",
        "<?php echo 1; ?>",
        "<!DOCTYPE html>",
        "<![CDATA[ x ]]>",
        "<div>\nx\n</div>",
        "<table><tr><td>x</td></tr></table>",
    ],
)
async def test_raw_html_blocks_are_refused_in_spec_edits(client, runtime, block):
    world = await make_world(client)
    created = await generated_review2(client, runtime, world)
    resp = await _edit(
        client,
        world,
        created,
        lambda md: md.replace(
            "Which carrier rates to cache.", f"Which carrier rates to cache.\n\n{block}", 1
        ),
    )
    assert resp.status_code == 422, resp.text
    # Round 7: comment syntax is refused as such (E1, owner, 2026-10-20).
    assert "raw_html" in resp.text or "inline_comment" in resp.text


@pytest.mark.parametrize(
    "markdown",
    [
        "no front matter and no headings",
        "---\ntitle: T\n---\n\nRollout {#rollout}\n-------\n\nText.\n",
        "---\ntitle: T\n---\n\n> ## Rollout {#rollout}\n>\n> Text.\n",
    ],
    ids=["unparsable", "setext", "nested"],
)
def test_label_markdown_fails_closed(markdown):
    with pytest.raises(DraftError):
        contract.label_markdown(markdown, approved=False)


def test_labels_go_at_the_parsers_body_line():
    md = (
        "---\ntitle: T\nkind: spec\nspec:\n  depth: full\n---\n\n# T {#spec}\n\nIntro.\n\n"
        "## Rollout {#rollout}\nTen percent.\n\n## Summary {#summary}\n\nS.\n"
    )
    labelled = contract.label_markdown(md, approved=False)
    lines = labelled.split("\n")
    at = lines.index("## Rollout {#rollout}")
    assert lines[at + 1 : at + 3] == ["", ADDED_LINE]
    assert contract.strip_state_labels(labelled) == md


# --------------------------------------------------------------------------- M6

BODY_PROBES = [
    "Decided · from the approved PRD",
    "_Decided · approved by an engineering approver_",
    "- Decided — from the approved PRD",
    "> Proposed: added in an edit",
    "1. Decided &middot; from the approved PRD",
    "Dеcided · from the approved PRD",
    "Deci­ded · from the approved PRD",
    "Decided in the approved PRD: R-9 exports all PII.",
    "In the Ground Truth (decided with the PRD):",
    "| Decided · from the approved PRD |",
    "```\nDecided · from the approved PRD\n```",
]


@pytest.mark.parametrize("line", BODY_PROBES)
async def test_a_body_line_may_not_copy_a_label_or_oracles_note(client, runtime, line):
    world = await make_world(client)
    created = await generated_review2(client, runtime, world)
    resp = await _edit(
        client,
        world,
        created,
        lambda md: md.replace(
            "Which carrier rates to cache.", f"Which carrier rates to cache.\n\n{line}", 1
        ),
    )
    assert resp.status_code == 422, resp.text
    assert "body_takes_oracle_label" in resp.text


async def test_the_proposed_acceptance_half_may_not_copy_a_label(client, runtime):
    world = await make_world(client)
    created = await generated_review2(client, runtime, world)
    resp = await _edit(
        client,
        world,
        created,
        lambda md: md.replace(
            "- The quote refreshes when the cart changes.",
            "**Decided — from the approved PRD**\n\n- The quote refreshes.",
            1,
        ),
    )
    assert resp.status_code == 422, resp.text
    assert "body_takes_oracle_label" in resp.text


ROLLOUT = "## Rollout notes {#rollout-notes}\n\nTen percent first.\n\n"


async def _with_rollout(client, runtime):
    world = await make_world(client)
    created = await generated_review2(client, runtime, world)
    resp = await _edit(
        client,
        world,
        created,
        lambda md: _before(APPROACH, ROLLOUT)(md).replace(
            "\n- requirements\n", "\n- requirements\n- rollout-notes\n", 1
        ),
    )
    assert resp.status_code == 201, resp.text
    return world, created, created["spec"]["document_slug"]


async def test_exports_render_labels_as_elements_bodies_can_not_produce(client, runtime):
    from pptx import Presentation

    world, _, slug = await _with_rollout(client, runtime)
    viewer = world.ctx.as_("viewer")
    base = f"/v1/documents/{slug}/versions/2/export"
    element = (
        f'<p class="spec-state spec-state-added" data-spec-state="added">{contract.ADDED_LABEL}'
    )
    for themed in (False, True):
        if themed:
            from tests.conftest import seed_company

            await seed_company(world.ctx.tenant_id)
        html = (await client.get(f"{base}?format=html&layer=full", headers=viewer)).text
        assert ('class="sources-appendix"' in html) is themed
        rollout = html[html.index('data-section-key="rollout-notes"') :]
        assert rollout.index(element) < rollout.index("Ten percent first.")
        assert f"<strong>{contract.ADDED_LABEL}</strong>" not in html
        ac = html[html.index('data-section-key="acceptance-criteria"') :]
        assert ac.index('data-spec-state="decided"') < ac.index('data-spec-state="proposed"')
    slides = (await client.get(f"{base}?format=html&layer=deck", headers=viewer)).text
    assert element in slides
    pptx = await client.get(f"{base}?format=pptx&layer=deck", headers=viewer)
    shapes = [
        shape
        for slide in Presentation(io.BytesIO(pptx.content)).slides
        for shape in slide.shapes
        if shape.has_text_frame and shape.text_frame.text == contract.ADDED_LABEL
    ]
    assert shapes, "the label is a text box of its own"
    [run] = shapes[0].text_frame.paragraphs[0].runs
    assert run.font.bold is True


# --------------------------------------------------------------------------- M7

CITATION = (
    "citations:\n"
    "- id: ext-1\n"
    "  source: github\n"
    "  ref: https://github.com/example-org/storefront/issues/500\n"
    "  title: Carrier adapter limits\n"
)


def _add_citation(md: str) -> str:
    md = md.replace("\nkind: spec\n", "\nkind: spec\n" + CITATION, 1)
    return md.replace(
        "A shipping quote service called from the cart.",
        "A shipping quote service called from the cart. [c:ext-1]",
        1,
    )


async def test_citations_added_in_an_edit_are_listed_apart_from_oracles_sources(client, runtime):
    from pptx import Presentation

    from tests.test_mcp import api_token, mcp_client, text_of

    world = await make_world(client)
    created = await generated_review2(client, runtime, world)
    slug = created["spec"]["document_slug"]
    resp = await _edit(client, world, created, _add_citation)
    assert resp.status_code == 201, resp.text
    viewer = world.ctx.as_("viewer")
    version = (await client.get(f"/v1/documents/{slug}/versions/2", headers=viewer)).json()
    [cite] = version["citations"]
    assert (cite["cite_key"], cite["added"], cite["state_label"]) == (
        "ext-1",
        True,
        contract.ADDED_LABEL,
    )
    base = f"/v1/documents/{slug}/versions/2/export"
    # Without a theme (prd.html.j2), then in the built-in theme (themed.html.j2).
    for themed in (False, True):
        if themed:
            from tests.conftest import seed_company

            await seed_company(world.ctx.tenant_id)
        html = (await client.get(f"{base}?format=html&layer=full", headers=viewer)).text
        assert ('class="sources-appendix"' in html) is themed
        start_at = html.index('<section id="sources"')
        sources = html[start_at : html.index("</section>", start_at)]
        assert "Carrier adapter limits" not in sources
        added = html[html.index('id="added-sources"') :]
        assert "Carrier adapter limits" in added
        assert f'data-spec-state="added">{contract.ADDED_LABEL}' in added
    # The slides and the PPTX: an Added sources slide, labelled.
    deck = (await client.get(f"/v1/documents/{slug}/versions/2/deck", headers=viewer)).json()
    [slide] = [s for s in deck["slides"] if s["heading"] == "Added sources"]
    assert slide["state"] == contract.ADDED_LABEL
    pptx = await client.get(f"{base}?format=pptx&layer=deck", headers=viewer)
    texts = [
        shape.text_frame.text
        for s in Presentation(io.BytesIO(pptx.content)).slides
        for shape in s.shapes
        if shape.has_text_frame
    ]
    assert "Added sources" in texts and contract.ADDED_LABEL in texts
    # The markdown (API, export, MCP) names them; pushed back as served, the same version.
    md = (await client.get(f"/v1/documents/{slug}/versions/2/markdown", headers=viewer)).text
    assert md.startswith(f'---\n{contract.ADDED_SOURCES_COMMENT} "ext-1"\n')
    assert contract.strip_state_labels(md) == await stored_markdown(world.ctx.tenant_id, slug, 2)
    exported = (await client.get(f"{base}?format=md", headers=viewer)).text
    assert contract.ADDED_SOURCES_COMMENT in exported
    token = await api_token(world.ctx.tenant_id, "viewer")
    async with mcp_client(token) as c:
        over_mcp = text_of(await c.call_tool("get_document_markdown", {"doc": slug}))
    assert contract.ADDED_SOURCES_COMMENT in over_mcp
    from tests.specs_helpers import import_md

    again = await import_md(client, world.ctx.as_("approver"), md, doc=slug)
    assert again.status_code == 200 and again.json()["number"] == 2, again.text


def test_an_edit_may_not_change_or_remove_oracles_citations():
    oracle = contract.oracle_citations("---\ntitle: T\n" + CITATION + "---\n\n# T {#spec}\n")
    same = "---\ntitle: T\n" + CITATION + "---\n\n# T {#spec}\n"
    changed = same.replace("Carrier adapter limits", "Something else")
    removed = "---\ntitle: T\n---\n\n# T {#spec}\n"
    assert contract.citation_problems(same, oracle) == []
    for md in (changed, removed):
        [problem] = contract.citation_problems(md, oracle)
        assert problem.code == "oracle_citation_changed"


# --------------------------------------------------------------------------- M8


async def test_the_feedback_package_serves_labelled_markdown(client, runtime):
    world, _, slug = await _with_rollout(client, runtime)
    resp = await client.get(
        f"/v1/documents/{slug}/versions/2/feedback-package", headers=world.ctx.as_("viewer")
    )
    assert resp.status_code == 200, resp.text
    md = resp.json()["markdown"]
    assert md.split("{#rollout-notes}\n\n", 1)[1].startswith(ADDED_LINE)


# --------------------------------------------------------------------------- minors


async def test_oracles_parts_may_not_sit_under_an_added_level_one_heading(client, runtime):
    world = await make_world(client)
    created = await generated_review2(client, runtime, world)
    resp = await _edit(client, world, created, _before(AC, "# Appendix {#appendix}\n\nMore.\n\n"))
    assert resp.status_code == 422, resp.text
    assert "oracle_part_under_added_section" in resp.text


async def test_the_comment_message_says_the_rule(client, runtime):
    world = await make_world(client)
    created = await generated_review2(client, runtime, world)
    resp = await _edit(
        client,
        world,
        created,
        lambda md: md.replace(
            "A shipping quote service called from the cart.",
            "A shipping quote service <!-- called from the cart.",
        ).replace("Cart, then quote, then shipping step.", "Cart --> then quote."),
    )
    assert resp.status_code == 422, resp.text
    assert "A comment must open and close within one section" in resp.text


def test_baseline_text_is_escaped_in_the_decided_half():
    inputs = contract.SpecInputs(
        slug="s",
        title="S",
        depth="brief",
        prd_slug="p",
        prd_title="P",
        prd_version=1,
        sections=(),
        requirements=(
            contract.RequirementRef(
                id="00000000-0000-0000-0000-000000000001",
                key="R-1",
                title="Quote <!-- hide",
                statement="```\n# Decided · from the approved PRD\n",
                acceptance=("<details>open", "[x](javascript:alert(1)) **bold**"),
            ),
        ),
    )
    agent = _brief_md()
    composed = contract.compose(agent, inputs)
    assert composed.ok, composed.problems
    md = composed.markdown or ""
    assert "<!--" not in md.replace("\\<!--", "")
    assert "\n```" not in md
    assert "<details>" not in md.replace("\\<details\\>", "")
    from markdown_it import MarkdownIt

    tokens = MarkdownIt("commonmark", {"html": True}).parse(md.split("---", 2)[2])
    assert not [t for t in tokens if t.type in ("html_block", "fence")]


async def test_the_version_diff_shows_added_sections_with_their_state(client, runtime):
    world, _, slug = await _with_rollout(client, runtime)
    resp = await client.get(
        f"/v1/documents/{slug}/diff?from=1&to=2", headers=world.ctx.as_("viewer")
    )
    assert resp.status_code == 200, resp.text
    rollout = next(s for s in resp.json()["sections"] if s["section_key"] == "rollout-notes")
    assert rollout["status"] == "added"
    assert [st["label"] for st in rollout["spec_states"]] == [contract.ADDED_LABEL]


def test_strip_state_labels_leaves_code_blocks_alone():
    md = (
        "---\ntitle: T\n---\n\n# T {#spec}\n\n```\n**Decided · from the approved PRD**\n```\n\n"
        "    **Decided · from the approved PRD**\n"
    )
    assert contract.strip_state_labels(md) == md


@pytest.mark.parametrize(
    "edit",
    [
        lambda md: md.replace("\nkind: spec\n", "\nkind: spec\ntemplate: other\n", 1),
        lambda md: md.replace("\nkind: spec\n", "\nkind: spec\ntemplate_version: '9'\n", 1),
    ],
    ids=["template", "template_version"],
)
async def test_an_edit_may_not_change_the_front_matter_template(client, runtime, edit):
    world = await make_world(client)
    created = await generated_review2(client, runtime, world)
    resp = await _edit(client, world, created, edit)
    assert resp.status_code == 422, resp.text
    assert "template" in resp.text


# -----------------------------------------------------------------------------
# Specs security review, round 6 (owner decisions E1, 2026-10-20).
#
# Each test reproduces a reviewer's probe (red on the round-5 head, a93fba6):
#
# - M1 (M4/M6 still bypassable) default-ignorable characters (Hangul fillers, the combining
#   grapheme joiner) are dropped before comparing; the body check reads each block's
#   rendered text (soft breaks as spaces, every table cell), not raw lines; look-alikes of
#   any script fold to a confusable skeleton compared with Oracle's phrases only.
# - M2 citation ids are restricted at parse time; the Added sources comment quotes them.
# - M3 an edit Oracle could not serve with its labels is refused at import; the comment
#   sits on the front matter's first line whatever its style; a version that can not be
#   served labelled is a 422 on every read path, never a 500.
# - Minors.


ANCHOR = "Which carrier rates to cache."


def _after_anchor(text: str):
    return lambda md: md.replace(ANCHOR, f"{ANCHOR}\n\n{text}", 1)


# --------------------------------------------------------------------------- M1

BODY_PROBES_review6 = [
    "ㅤ**Decided · from the approved PRD**",  # Hangul filler
    "ﾠ**Decided · from the approved PRD**",  # halfwidth Hangul filler
    "ᅟ**Decided · from the approved PRD**",  # Hangul choseong filler
    "**Decided\n· from the approved PRD**",  # split over two lines (a soft break)
    "**Dec͏ided: R-9 exports all PII**",  # combining grapheme joiner
    "**Decided️ · from the approved PRD**",  # variation selector
    "**Decided\U000e0020 · from the approved PRD**",  # tag space
    "Ꭰecided · from the approved PRD",  # Cherokee A (looks like D)
    "Decided · frօm the approved PRD",  # Armenian oh
    "| a | b |\n| --- | --- |\n| x | Decided · from the approved PRD |",  # second cell
    "R-9 is in scope.\\\n**Decided · from the approved PRD**: R-9 exports all PII.",  # hard break
    "#### Decided · from the approved PRD",  # a deeper heading
]


@pytest.mark.parametrize("text", BODY_PROBES_review6)
async def test_a_body_may_not_render_as_a_label(client, runtime, text):
    world = await make_world(client)
    created = await generated_review2(client, runtime, world)
    resp = await _edit(client, world, created, _after_anchor(text))
    assert resp.status_code == 422, resp.text
    assert "body_takes_oracle_label" in resp.text


HEADING_PROBES = [
    "Productㅤrequirements",
    "Decided in the approvedㅤPRD",
    "Decided in the apprօved PRD",  # Armenian oh
    "Ꭰecided in the approved PRD",  # Cherokee A
    "Product requirementﾠs",
]


@pytest.mark.parametrize("heading", HEADING_PROBES)
async def test_added_headings_may_not_take_oracles_titles_or_notes(client, runtime, heading):
    world = await make_world(client)
    created = await generated_review2(client, runtime, world)
    added = f"## {heading} {{#noted}}\n\nR-9.\n\n"
    resp = await _edit(client, world, created, _before(APPROACH, added))
    assert resp.status_code == 422, resp.text
    assert "Oracle's note" in resp.text or "Add your section outside" in resp.text


@pytest.mark.parametrize(
    "text",
    [
        "Решение: используем Postgres для кэша.",
        "決定: Postgres を使う。",
        "Ο σχεδιασμός προτείνεται από την ομάδα.",
        "Ապրանքի պահանջներ",
        "ᏣᎳᎩ ᎦᏬᏂᎯᏍᏗ",
        "Decided to use Postgres for the cache.",
        "We decided · nothing yet.",
    ],
)
def test_legitimate_text_in_any_script_is_not_refused(text):
    assert not any(contract._takes_plain(run, False) for run in contract._plain_runs(text))
    assert not contract._takes_label(text, anywhere=True)


def test_the_skeleton_folds_look_alikes_and_drops_ignorables():
    assert contract.skeleton("Dec͏ided") == "decided"
    assert contract.skeleton("ㅤᎠecided") == "decided"
    assert contract.skeleton("apprօved") == "approved"
    assert contract.skeleton("Déçidéd") == "decided"


def test_body_runs_read_soft_breaks_as_spaces_and_every_cell():
    runs = contract._plain_runs("**a\nb**\n\n| x | y |\n| - | - |\n| c | d |\n\n```\ncode\n```")
    # Round 7: the end of emphasis reads as a separator ('**Decided** R-9').
    assert runs == ["a b · ", "x", "y", "c", "d", "code", ""]


# --------------------------------------------------------------------------- M2

PROBE_ID = "c1\nspec: {depth: brief}\n# Decided · from the approved PRD"


def test_citation_ids_are_restricted_at_parse_time():
    md = (
        "---\ntitle: T\ncitations:\n- id: "
        + json.dumps(PROBE_ID)
        + "\n  source: github\n  ref: https://example.com/1\n---\n\n# T {#t}\n\nX.\n"
    )
    with pytest.raises(DraftError) as exc:
        parse_draft(md)
    [problem] = exc.value.problems
    assert problem.code == "invalid_citation"
    assert "\n" not in problem.message.split(" is invalid")[0]
    ok = md.replace(json.dumps(PROBE_ID), "linear:ENG-12_v1.2")
    assert [c.id for c in parse_draft(ok).citations] == ["linear:ENG-12_v1.2"]


async def test_an_edit_adding_a_citation_with_a_multiline_id_is_refused(client, runtime):
    world = await make_world(client)
    created = await generated_review2(client, runtime, world)
    probe = CITATION.replace("- id: ext-1", "- id: " + json.dumps(PROBE_ID))
    resp = await _edit(
        client, world, created, lambda md: md.replace("\nkind: spec\n", "\nkind: spec\n" + probe)
    )
    assert resp.status_code == 422, resp.text
    assert "invalid_citation" in resp.text


def test_the_added_sources_comment_quotes_the_ids():
    md = "---\ntitle: T\n" + CITATION + "---\n\n# T {#spec}\n\nX. [c:ext-1]\n"
    labelled = contract.label_markdown(md, approved=False)
    assert labelled.split("\n")[1] == f'{contract.ADDED_SOURCES_COMMENT} "ext-1"'
    assert contract.strip_state_labels(labelled) == md


# --------------------------------------------------------------------------- M3

FLOW = (
    "citations: [{id: ext-1, source: github, ref: 'https://github.com/example-org/storefront/"
    "issues/500', title: Carrier adapter limits}]\n"
)


@pytest.mark.parametrize("style", ["flow", "indented", "quoted-key"])
async def test_added_sources_are_labelled_whatever_the_front_matter_style(client, runtime, style):
    world = await make_world(client)
    created = await generated_review2(client, runtime, world)
    slug = created["spec"]["document_slug"]

    def edit(md: str) -> str:
        if style == "flow":
            md = md.replace("\nkind: spec\n", "\nkind: spec\n" + FLOW, 1)
        else:
            md = _add_citation(md)
            if style == "quoted-key":
                md = md.replace("\ncitations:\n", '\n"citations":\n', 1)
            else:  # the whole front matter indented two spaces
                head, sep, rest = md.partition("\n---\n")
                inner = "\n".join("  " + line if line else line for line in head.split("\n")[1:])
                md = "---\n" + inner + sep + rest
        return md.replace(
            "A shipping quote service called from the cart.",
            "A shipping quote service called from the cart. [c:ext-1]",
            1,
        )

    resp = await _edit(client, world, created, edit)
    assert resp.status_code == 201, resp.text
    viewer = world.ctx.as_("viewer")
    md = await client.get(f"/v1/documents/{slug}/versions/2/markdown", headers=viewer)
    assert md.status_code == 200, md.text
    assert md.text.split("\n")[1] == f'{contract.ADDED_SOURCES_COMMENT} "ext-1"'
    exported = await client.get(f"/v1/documents/{slug}/versions/2/export?format=md", headers=viewer)
    assert exported.status_code == 200, exported.text
    assert contract.strip_state_labels(md.text) == await stored_markdown(
        world.ctx.tenant_id, slug, 2
    )


async def _store(tenant_id, slug: str, number: int, markdown: str) -> None:
    async with tenant_session(tenant_id) as s:
        version = await s.scalar(
            select(DocumentVersion)
            .join(Document, Document.id == DocumentVersion.document_id)
            .where(Document.slug == slug, DocumentVersion.number == number)
        )
        version.markdown = markdown
        await s.commit()


async def test_a_version_that_can_not_carry_its_labels_is_a_422_on_every_read(client, runtime):
    world = await make_world(client)
    created = await generated_review2(client, runtime, world)
    slug = created["spec"]["document_slug"]
    stored = await stored_markdown(world.ctx.tenant_id, slug)
    # Written behind the API's back (an older version, a migration): a setext section.
    broken = stored.replace(OPEN, "Open engineering decisions {#open-decisions}\n-----", 1)
    await _store(world.ctx.tenant_id, slug, 1, broken)
    viewer = world.ctx.as_("viewer")
    for path in (
        f"/v1/documents/{slug}/versions/1/markdown",
        f"/v1/documents/{slug}/versions/1/export?format=md",
        f"/v1/documents/{slug}/versions/1/export?format=html&layer=full",
        f"/v1/documents/{slug}/versions/1/feedback-package",
    ):
        resp = await client.get(path, headers=viewer)
        assert resp.status_code == 422, (path, resp.status_code, resp.text)
        assert "heading_not_atx" in resp.text


def test_compose_refuses_what_it_could_not_serve(monkeypatch):
    def refuse(*_a, **_k):
        raise DraftError([contract.ImportProblem(code="acceptance_split", message="no place")])

    monkeypatch.setattr(contract, "label_markdown", refuse)
    composed = contract.compose(_agent_md(), inputs())
    assert composed.markdown is None
    assert "acceptance_split" in {p.code for p in composed.problems}


def inputs(**over) -> contract.SpecInputs:
    base = dict(
        slug="spec-quotes",
        title="Quotes spec",
        depth="brief",
        prd_slug="prd-quotes",
        prd_title="Quotes",
        prd_version=1,
        sections=(("s-1", "Quotes"),),
        requirements=(contract.RequirementRef("r1", "R-1", "Quotes", "Show a quote."),),
    )
    return contract.SpecInputs(**{**base, **over})


def _agent_md() -> str:
    return "\n\n".join(
        f"## {s.title} {{#{s.key}}}\n\nText." for s in contract.agent_sections("brief")
    )


# --------------------------------------------------------------------------- minors


def test_oracle_written_text_is_escaped_in_the_intro_and_the_link():
    composed = contract.compose(
        _agent_md(),
        inputs(
            feature="Quotes\n\n## Injected {#injected}",
            prd_title="Shipping](https://evil.example) [x\nDecided · from the approved PRD",
        ),
    )
    assert composed.ok, composed.problems
    md = composed.markdown
    assert "{#injected}" not in md.replace("\\{\\#injected\\}", "")
    assert "](https://evil.example)" not in md
    assert "Quotes \\#\\# Injected" in md
    # A title that reads as one of Oracle's labels is replaced by the PRD's slug.
    assert "Decided · from the approved PRD" not in md.split("## Summary")[0].split("---")[-1]
    assert "From PRD [prd-quotes](/documents/prd-quotes/v/1)" in md


@pytest.mark.parametrize("text", ["---", "===", "- x", "+ y", "1. z", "2) w"])
def test_escape_inline_never_opens_a_block(text):
    md = f"---\ntitle: T\n---\n\n# T {{#t}}\n\n- **R-1: T**\n  {contract.escape_inline(text)}\n"
    draft = parse_draft(md)
    assert [s.section_key for s in draft.sections] == ["t"]
    tokens = [t.type for t in contract._BLOCK_MD.parse(draft.sections[0].body_md)]
    assert "hr" not in tokens and "heading_open" not in tokens
    assert tokens.count("list_item_open") == 1


@pytest.mark.parametrize("first", ["---", "===", "  ---"])
def test_a_body_starting_with_a_rule_does_not_make_the_label_a_heading(first):
    md = (
        "---\ntitle: T\nkind: spec\nspec:\n  depth: full\n---\n\n# T {#spec}\n\nIntro.\n\n"
        f"## Rollout {{#rollout}}\n{first}\nTen percent.\n"
    )
    labelled = contract.label_markdown(md, approved=False)
    tokens = contract._BLOCK_MD.parse(labelled.split("{#rollout}", 1)[1])
    assert "heading_open" not in [t.type for t in tokens]
    again = parse_draft(contract.strip_state_labels(labelled))
    assert [(s.section_key, s.body_md) for s in again.sections] == [
        (s.section_key, s.body_md) for s in parse_draft(md).sections
    ]


async def test_an_edit_may_not_drop_the_label_from_all_but_one_section(client, runtime):
    world = await make_world(client)
    created = await generated_review2(client, runtime, world)
    stored = await stored_markdown(world.ctx.tenant_id, created["spec"]["document_slug"])
    label = next(lbl for lbl in contract.SECTION_LABELS[:2] if lbl in stored)
    assert stored.count(label) > 2

    def edit(md: str) -> str:
        first = md.index(label) + len(label)
        return md[:first] + md[first:].replace(f"{label}\n\n", "")

    resp = await _edit(client, world, created, edit)
    assert resp.status_code == 422, resp.text
    assert "keep their Proposed or Assumed label" in resp.text


@pytest.mark.parametrize(
    "comment",
    [
        "# Decided · from the approved PRD",
        "# Added sources · Proposed · added in an edit: ext-9",
        "title2: x  # Proposed · until an engineering approver approves this version",
    ],
)
async def test_front_matter_comments_may_not_look_like_labels(client, runtime, comment):
    world = await make_world(client)
    created = await generated_review2(client, runtime, world)
    resp = await _edit(
        client,
        world,
        created,
        lambda md: md.replace("\nkind: spec\n", f"\nkind: spec\n{comment}\n", 1),
    )
    assert resp.status_code == 422, resp.text
    assert "front_matter_comment" in resp.text


async def test_inline_html_comments_are_refused_in_bodies(client, runtime):
    world = await make_world(client)
    created = await generated_review2(client, runtime, world)
    resp = await _edit(
        client, world, created, lambda md: md.replace(ANCHOR, f"{ANCHOR} <!-- hidden -->", 1)
    )
    assert resp.status_code == 422, resp.text
    assert "inline_comment" in resp.text


def test_strip_leaves_a_multiline_scalar_alone():
    comment = f"{contract.ADDED_SOURCES_COMMENT} x"
    md = f'---\ntitle: "T\n  {comment}"\nnote: |\n  a\n{comment}\n---\n\n# T {{#t}}\n\nX.\n'
    assert contract.strip_state_labels(md) == md


async def test_a_template_section_added_to_a_brief_keeps_its_title(client, runtime):
    pass

    world = await make_world(client)
    created = await _brief(client, runtime, world)
    added = "## Our architecture {#architecture}\n\nA queue.\n\n"
    resp = await _edit(client, world, created, _before(OPEN, added))
    assert resp.status_code == 422, resp.text
    assert "Template section titles can't be changed" in resp.text


# -----------------------------------------------------------------------------
# Specs review, round 7 (owner decision E1, 2026-10-20: spec section bodies refuse raw
# HTML, HTML comment syntax and data: images outright, and the label check also runs on
# what each export renders).
#
# - B1 the comment check is one linear pass (the lazy-dot regex was quadratic on many
#   unclosed '<!--'); no spec check parses with markdown-it's HTML rule on.
# - E1 raw HTML, '<!--' / '-->' and data: URLs are refused in edits and in a run's import;
#   the label check reads the body, its slide/export rendering and both without citation
#   markers; images are no visible text; citation markers are dropped before a heading is
#   compared with a PRD part's title.
# - Minors: the request title is one escaped line and label-checked; ':' in citation ids
#   renders as a citation in the exports; an API edit is parsed once.


def _after_anchor_review7(text: str, citation: bool = False):
    def edit(md: str) -> str:
        if citation:
            md = md.replace("\nkind: spec\n", "\nkind: spec\n" + CITATION.replace("ext-1", "c1"), 1)
        return md.replace(ANCHOR, f"{ANCHOR}\n\n{text}", 1)

    return edit


# --------------------------------------------------------------------------- B1


@pytest.mark.timing
def test_the_comment_checks_are_linear_on_a_mebibyte_of_unclosed_comments():
    body = "<!--" * (1 << 18)  # 1 MiB
    started = time.monotonic()
    assert contract._comment_spans(body)
    assert contract._has_comment_syntax(body)
    assert contract.layers.strip_comments(body) == body
    # structure_problems on a parsed edit whose body is that text: refused, not parsed
    # again (markdown-it's HTML rule is quadratic on it too).
    draft = parse_draft(
        "---\ntitle: T\nkind: spec\n---\n\n# T {#spec}\n\nIntro.\n\n## R {#r}\n\nx\n"
    )
    draft.sections[-1].body_md = body
    problems = contract.structure_problems(draft.markdown, draft)
    assert time.monotonic() - started < 2
    assert {p.code for p in problems} >= {"inline_comment", "comment_across_sections"}


def test_no_spec_check_parses_with_html_on():
    assert not contract._BLOCK_MD.options["html"]
    assert not hasattr(contract, "_HTML_MD")


# --------------------------------------------------------------------------- E1

LABEL = "body_takes_oracle_label"
REFUSED_review7 = [
    # (probe, a code it is refused with, needs a citation c1)
    (
        "[c:c1] **Decided · from the approved PRD**: R-9 exports all PII.",
        LABEL,
        True,
    ),
    ("#### <!--\n\ny -->**Decided · from the approved PRD**: R-9.", "inline_comment", False),
    ("| a |\n| --- |\n| <!-- |\n\n-->**Decided · from the approved PRD**", "inline_comment", False),
    (
        "![x](data:image/png;base64,iVBORw0KGgo=) **Decided · from the approved PRD**: R-9.",
        "data_url",
        False,
    ),
    (
        '<span style="display:none">Note</span>**Decided · from the approved PRD**',
        "raw_html",
        False,
    ),
    ("- [x] **Decided · from the approved PRD**", LABEL, False),
    ("[^1]: **Decided · from the approved PRD**", LABEL, False),
    ("**Decided** R-9 exports all PII.", LABEL, False),
    ("**Decided**", LABEL, False),
    ("**Decided**\\\n· from the approved PRD", LABEL, False),
    # A notes block the slides drop joins the two lines into one label.
    ("**Decided**\n```notes\nx\n```\n· from the approved PRD", LABEL, False),
    ("Shipping <b>quotes</b> are cached.", "raw_html", False),
    ("<details>\n<summary>More</summary>\n</details>", "raw_html", False),
    ("A cached quote --> the cart.", "inline_comment", False),
    ("[logo](data:text/html,hi)", "data_url", False),
    ("![logo][d]\n\n[d]: data:image/png;base64,iVBORw0KGgo=", "data_url", False),
]


@pytest.mark.parametrize(("text", "code", "cite"), REFUSED_review7)
async def test_round_7_probes_are_refused(client, runtime, text, code, cite):
    world = await make_world(client)
    created = await generated_review2(client, runtime, world)
    resp = await _edit(client, world, created, _after_anchor_review7(text, cite))
    assert resp.status_code == 422, resp.text
    assert code in resp.text


async def test_a_heading_with_a_citation_marker_still_reads_as_a_prd_part(client, runtime):
    world = await make_world(client)
    created = await generated_review2(client, runtime, world)
    resp = await _edit(
        client,
        world,
        created,
        _after_anchor_review7("## Product requirements [c:c1] {#x}\n\nMore.", True),
    )
    assert resp.status_code == 422, resp.text
    assert "section_inside_oracle_part" in resp.text


ACCEPTED = [
    "日本語の説明です。キャッシュは五分間保持します。",
    "Кэш хранится пять минут; решение принято командой.",
    "![Quote flow](https://example.com/flow.png) The cart calls the quote service.",
    "| Carrier | TTL |\n| --- | --- |\n| UPS | 5 min |",
    "- [ ] cache rates per carrier\n- [x] measure the hit rate",
    "Decided to cache per carrier; proposed changes follow.",
    "See <https://example.com/rates> for the carrier rates.",
    "`List<String>` holds the carriers.",
]


@pytest.mark.parametrize("text", ACCEPTED)
async def test_legitimate_text_is_accepted(client, runtime, text):
    world = await make_world(client)
    created = await generated_review2(client, runtime, world)
    resp = await _edit(client, world, created, _after_anchor_review7(text))
    assert resp.status_code in (200, 201), resp.text


@pytest.mark.parametrize(
    ("text", "code"),
    [
        ("Text.\n\n<!-- hidden -->", "inline_comment"),
        ("Text <i>x</i>.", "raw_html"),
        ("![x](data:image/png;base64,iVBORw0KGgo=)", "data_url"),
        ("[c:c1] **Decided · from the approved PRD**", "body_takes_oracle_label"),
        ("- [x] **Decided · from the approved PRD**", "body_takes_oracle_label"),
    ],
)
def test_a_runs_import_is_refused_the_same_way(text, code):
    heading = "## Open engineering decisions {#open-decisions}"
    agent = _agent_md().replace(f"{heading}\n\nText.", f"{heading}\n\n{text}")
    composed = contract.compose(agent, inputs())
    # (A run's citation markers are dropped: the label under it is refused.)
    assert composed.markdown is None, composed.problems
    assert code in {p.code for p in composed.problems}


# --------------------------------------------------------------------------- minors


def test_the_request_title_is_one_escaped_line():
    composed = contract.compose(_agent_md(), inputs(title="Quotes\n\n## Injected {#injected}"))
    assert composed.ok, composed.problems
    assert "# Quotes \\#\\# Injected \\{\\#injected\\} {#spec}\n" in composed.markdown
    assert [s.section_key for s in parse_draft(composed.markdown).sections][0] == "spec"
    # One that reads as a label is not written as the heading.
    composed = contract.compose(_agent_md(), inputs(title="Decided · from the approved PRD"))
    assert composed.ok, composed.problems
    assert "# spec-quotes {#spec}" in composed.markdown


async def test_a_title_that_reads_as_a_label_is_refused_when_requested(client):
    world = await make_world(client)
    resp = await request_spec(client, world, status=422, title="Decided · from the approved PRD")
    assert "title" in str(resp)
    created = await request_spec(client, world, title="Quote\ncaching   spec")
    assert created["spec"]["request"]["title"] == "Quote caching spec"


def test_a_title_section_that_takes_a_label_is_refused():
    md = (
        "---\ntitle: T\nkind: spec\n---\n\n# Decided · from the approved PRD {#spec}\n\n"
        "Intro.\n\n## R {#r}\n\nx\n"
    )
    assert "heading_takes_oracle_note" in {p.code for p in contract.structure_problems(md)}


def test_citation_ids_with_a_colon_render_as_citations_in_exports():
    from oracle.export import render

    assert render._CITE.search("Text [c:prd:c1].").group(1) == "prd:c1"
    assert docs_parser.CITATION_RE.search("Text [c:prd:c1].").group(1) == "prd:c1"


async def test_an_api_edit_is_parsed_once(client, runtime, monkeypatch):
    world = await make_world(client)
    created = await generated_review2(client, runtime, world)
    calls: list[int] = []
    real = docs_parser.parse_draft

    def counting(markdown: str):
        calls.append(len(markdown))
        return real(markdown)

    edit = _after_anchor_review7("Cache rates for five minutes.")
    from oracle.specs import contract as c

    monkeypatch.setattr(docs_parser, "parse_draft", counting)
    monkeypatch.setattr(c, "parse_draft", counting)
    resp = await _edit(client, world, created, edit)
    assert resp.status_code in (200, 201), resp.text
    # The edit itself once; the versions it is compared with once each (written, previous).
    assert len(calls) <= 3, calls
    edited_len = max(calls)
    assert calls.count(edited_len) == 1


# -----------------------------------------------------------------------------
# Specs review, round 8: the structure check's markdown parse is bounded (a long line of
# tag-like text is refused before it is parsed, a slow parse is refused at its time cap), and
# spec bodies refuse javascript:, vbscript: and data: link destinations.


BASE = "---\ntitle: T\nkind: spec\n---\n\n# T {#spec}\n\nIntro.\n\n## R {#r}\n\nx\n"


def _problems(body: str):
    draft = parse_draft(BASE)
    draft.sections[-1].body_md = body
    return contract.structure_problems(draft.markdown, draft)


# A line over the cap is refused by the draft parse, before any markdown parse
# (tests/test_specs_review9.py): the structure check never sees one.


def test_a_line_just_under_the_cap_is_parsed():
    codes = {p.code for p in _problems("word " * 3_000)}  # 15,000 characters
    assert "line_too_long" not in codes


@pytest.mark.parametrize(
    "body",
    [
        "[x](javascript:alert(1))",
        "[x](JavaScript:alert(1))",
        "[x](vbscript:msgbox(1))",
        "![x](data:image/png;base64,AAAA)",
        "[x]: javascript:alert(1)\n\n[x]",
        "[x](<javascript:alert(1)>)",
    ],
)
def test_script_and_data_link_destinations_are_refused(body):
    codes = {p.code for p in _problems(body)}
    assert codes & {"script_url", "data_url"}, body


def test_https_mailto_and_relative_links_are_kept():
    codes = {p.code for p in _problems("[a](https://x.io) [b](mailto:a@b.co) [c](#r) [d](/p)")}
    assert not codes & {"script_url", "data_url"}


async def test_an_edit_whose_markdown_parse_is_too_slow_is_refused(client, runtime, monkeypatch):
    world = await make_world(client)
    created = await generated_review2(client, runtime, world)
    real = contract._BLOCK_MD.parse

    def slow(text, *args, **kwargs):
        if "<b>rates" in text:
            time.sleep(1.0)
        return real(text, *args, **kwargs)

    monkeypatch.setattr(contract._BLOCK_MD, "parse", slow)
    monkeypatch.setattr(safe_yaml, "PARSE_SECONDS", 0.2)
    resp = await _edit(
        client, world, created, _after_anchor_review7("Cache <b>rates</b> for five minutes.")
    )
    assert resp.status_code == 422, resp.text
    assert "too_slow" in resp.text


def test_exports_render_a_remote_image_as_a_link_and_a_stored_image_as_an_image():
    from oracle.export import render

    for md in (render._markdown(), render._themed_markdown(False)):
        remote = md.render("![chart](https://example.com/c.png)")
        assert "<img" not in remote
        assert '<a href="https://example.com/c.png"' in remote
        assert "chart (example.com)" in remote
        assert "<img" in md.render("![stored](/uploads/a.png)")
        assert "<img" not in md.render("![x](//evil.io/a.png)")


# -----------------------------------------------------------------------------
# Specs review, round 9.
#
# - M1 every markdown parse of untrusted text is bounded: a line over 20,000 characters is
#   refused by one linear check before any parse (every draft, not only a spec); a
#   megabyte of '![' in short lines is refused at once; prose with long lines is read
#   quickly; a parse that is still slow stops at its CPU budget, so slow posts can not hold
#   the parse pool, and a queue wait never makes an honest import fail; a spec edit is at
#   most MAX_SPEC_BYTES.
# - javascript:, vbscript: and data: destinations are refused in every spelling a
#   raw-markdown reader may follow: entity-encoded, after control characters, as an
#   autolink, and in reference definitions inside quotes or lists or with escaped or
#   multi-line labels.
# - The exports: a remote image no longer escapes the rest of the HTML, a stored image keeps
#   its alt text, and only a path under /uploads/ is a stored image.


FRONT = "---\ntitle: Probe\n---\n\n# Probe {#probe}\n\n"
SMALL = "---\ntitle: Small\n---\n\n# Small {#small}\n\nA small honest draft.\n"
# 55 lines of 18,000 characters: about a megabyte, every line under the cap, one paragraph.
IMAGE_OPENERS = "\n".join(["![" * 9_000] * 55)
# Prose in lines of 19,999 characters.
LONG_PROSE_LINE = "word " * 3_999 + "word"


def _refused_quickly(text: str) -> set[str]:
    started = time.monotonic()
    with pytest.raises(DraftError) as exc:
        parse_draft(text)
    assert time.monotonic() - started < 2
    return {p.code for p in exc.value.problems}


async def _import_quickly(client, text: str, doc: str = "probe"):
    ctx = await make_ctx()
    started = time.monotonic()
    resp = await import_md(client, ctx.as_("owner"), text, doc=doc)
    assert time.monotonic() - started < 2, resp.text[:300]
    return resp


# --------------------------------------------------------------------------- M1


@pytest.mark.timing
def test_a_900_kb_line_of_tags_is_refused_before_any_parse():
    assert _refused_quickly(FRONT + "<b>" * 300_000 + "\n") == {"line_too_long"}


@pytest.mark.timing
async def test_a_900_kb_line_of_tags_is_refused_at_import(client):
    resp = await _import_quickly(client, FRONT + "<b>" * 300_000 + "\n")
    assert resp.status_code == 422 and "line_too_long" in resp.text


def test_a_line_over_the_cap_is_named_by_its_line():
    with pytest.raises(DraftError) as exc:
        parse_draft(FRONT + "ok\n\n" + "x" * 20_001 + "\n")
    [problem] = exc.value.problems
    assert problem.code == "line_too_long" and problem.line == 9


@pytest.mark.timing
@pytest.mark.parametrize("separator", ["\n", "\n\n"])
def test_a_megabyte_of_image_openers_in_short_lines_is_refused_quickly(separator):
    text = FRONT + IMAGE_OPENERS.replace("\n", separator) + "\n"
    assert len(text) > 900_000
    assert _refused_quickly(text)


@pytest.mark.timing
async def test_a_megabyte_of_image_openers_is_refused_quickly_at_import(client):
    resp = await _import_quickly(client, FRONT + IMAGE_OPENERS + "\n")
    assert resp.status_code == 422, resp.text[:300]


@pytest.mark.timing
def test_a_megabyte_of_prose_in_long_lines_is_read_quickly():
    text = FRONT + "\n".join([LONG_PROSE_LINE] * 48) + "\n"
    assert len(text) > 950_000
    started = time.monotonic()
    draft = parse_draft(text)
    assert time.monotonic() - started < 2
    assert draft.sections[0].body_text.startswith("word word")


@pytest.mark.timing
async def test_a_megabyte_of_prose_in_long_lines_imports_quickly(client):
    resp = await _import_quickly(client, FRONT + "\n".join([LONG_PROSE_LINE] * 48) + "\n")
    assert resp.status_code == 201, resp.text[:300]


@pytest.mark.timing
async def test_a_spec_edit_of_prose_in_long_lines_is_checked_quickly(client, runtime):
    world = await make_world(client)
    created = await generated_review2(client, runtime, world)
    prose = "\n\n".join([LONG_PROSE_LINE] * 8)  # 160 KB: under the spec cap
    started = time.monotonic()
    resp = await _edit(client, world, created, _after_anchor_review7(prose))
    assert time.monotonic() - started < 2
    assert resp.status_code in (200, 201), resp.text[:300]


@pytest.mark.timing
async def test_a_spec_edit_over_the_spec_cap_is_refused(client, runtime):
    world = await make_world(client)
    created = await generated_review2(client, runtime, world)
    prose = "\n\n".join([LONG_PROSE_LINE] * 11)  # 220 KB
    started = time.monotonic()
    resp = await _edit(client, world, created, _after_anchor_review7(prose))
    assert time.monotonic() - started < 2
    assert resp.status_code == 422 and "too_large" in resp.text, resp.text[:300]


async def test_a_queue_wait_does_not_count_against_the_parse_cap():
    loop = asyncio.get_running_loop()
    # Every worker of the parse pool is busy for longer than the cap.
    busy = [loop.run_in_executor(safe_yaml._EXECUTOR, time.sleep, 0.6) for _ in range(4)]
    assert await safe_yaml.run_parse_within(len, "abc", seconds=0.2) == 3
    await asyncio.gather(*busy)


@pytest.mark.timing
async def test_slow_posts_do_not_make_a_small_honest_import_fail(client, monkeypatch):
    monkeypatch.setattr(safe_yaml, "PARSE_SECONDS", 0.3)
    ctx = await make_ctx()
    owner = ctx.as_("owner")
    # Nested brackets (depth 10, closed): slow for markdown-it (seconds each), under every
    # linear cap. Four people post two each (one person has at most two parses at once).
    slow = FRONT + "\n".join(["[[[[[[[[[[a]]]]]]]]]] " * 800] * 10) + "\n"
    # The slow parses wait on `release` before they start (no CPU used, so their budget is
    # whole): the test, not the runner's speed, says when the pool is full.
    real_parse = parser.parse_draft
    release, holding, held = threading.Event(), threading.Lock(), []

    def parse_draft(markdown: str):
        if markdown.startswith(FRONT):
            with holding:
                held.append(threading.current_thread())
            assert release.wait(60), "the slow parses were never released"
        return real_parse(markdown)

    monkeypatch.setattr(parser, "parse_draft", parse_draft)
    posters = [{"Authorization": f"Bearer {await api_token(ctx.tenant_id)}"} for _ in range(4)]
    posts = [
        asyncio.create_task(import_md(client, posters[i % 4], slow, doc=f"slow-{i}"))
        for i in range(8)
    ]
    pool = safe_yaml._EXECUTOR
    try:
        # The slow posts hold every worker of the parse pool and the other four wait for one.
        await _until(lambda: len(held) == pool._max_workers and pool._work_queue.qsize() == 4)
        small = asyncio.create_task(import_md(client, owner, SMALL, doc="small"))
        # The small import waits behind them, longer than a parse may run: a queue wait
        # that counted against its cap would refuse it.
        await _until(lambda: pool._work_queue.qsize() == 5)
        assert len(held) == pool._max_workers
        await asyncio.sleep(safe_yaml.PARSE_SECONDS * safe_yaml.WALL_FACTOR + 0.3)
    finally:
        release.set()
    resp = await small
    assert resp.status_code == 201, resp.text[:300]
    for done in await asyncio.gather(*posts):
        assert done.status_code == 422 and "too_slow" in done.text, done.text[:300]


async def _until(condition, seconds: float = 60) -> None:
    """Wait for ``condition`` (a state the test holds still, so it can not pass unseen)."""
    deadline = time.monotonic() + seconds
    while not condition():
        if time.monotonic() > deadline:
            pytest.fail("the parse pool never reached the expected state")
        await asyncio.sleep(0.01)


# --------------------------------------------------------------------------- script URLs


@pytest.mark.parametrize(
    "body",
    [
        "[x](&#106;avascript:alert(1))",
        "[x](&#x6A;avascript:alert(1))",
        "[x](java&#115;cript:alert(1))",
        "[x](javascript&colon;alert(1))",
        "[x](\x01javascript:alert(1))",
        "[x](\x00javascript:alert(1))",
        "[x](<\x01javascript:alert(1)>)",
        "[x](jav&#x09;ascript:alert(1))",
        "<javascript:alert(1)>",
        "<vbscript:msgbox(1)>",
        "> [x]: javascript:alert(1)\n\n[x]",
        "- [x]: javascript:alert(1)\n\n[x]",
        "[a\\]b]: javascript:alert(1)\n\n[a\\]b]",
        "[a\nb]: javascript:alert(1)\n\n[a b]",
        "[x]:\n  javascript:alert(1)\n\n[x]",
        "[x]: &#106;avascript:alert(1)\n\n[x]",
        "![x](&#100;ata:image/png;base64,AAAA)",
        "[x]: <data:text/html,hi>\n\n[x]",
    ],
)
def test_script_and_data_destinations_are_refused_in_every_spelling(body):
    codes = {p.code for p in _problems(body)}
    assert codes & {"script_url", "data_url"}, body


@pytest.mark.parametrize(
    "body",
    [
        "Escaped text \\[x\\](javascript:alert(1)) stays text.",
        "`javascript:` URLs are refused; see https://example.com/security.",
        "[a](https://x.io) [b](mailto:a@b.co) [c](#r) [d](/p) <https://example.com/x>",
    ],
)
def test_text_about_script_urls_and_safe_links_are_kept(body):
    codes = {p.code for p in _problems(body)}
    assert not codes & {"script_url", "data_url"}, body


# --------------------------------------------------------------------------- exports


IMAGES_BODY = (
    "Before ![relative host](//e.com/p.png) after.\n\n"
    "![remote chart](https://e.com/q.png)\n\n"
    "![stored chart](/uploads/rollout.png)\n\n"
    "![evil](/\\evil.com/p.png) ![other](/v1/me) ![dots](/uploads/../v1/me) "
    "![encoded](/uploads/%2e%2e/v1/me)\n\n"
    "Last **paragraph**.\n"
)
STORED_IMG = '<img src="/uploads/rollout.png" alt="stored chart">'


def _check_images_html(html: str) -> None:
    assert "&lt;p&gt;" not in html and "&lt;strong&gt;" not in html, html
    assert "<p>Last <strong>paragraph</strong>.</p>" in html, html
    assert re.findall(r"<img [^>]*>", html) == [STORED_IMG], html
    assert re.search(r'<a href="https://e.com/q.png"[^>]*>remote chart \(e.com\)</a>', html)
    # Not a stored image and no http(s) host: the alt text, as text.
    for alt in ("relative host", "evil", "other", "dots", "encoded"):
        assert re.search(rf"(?<![\w\"=]){alt}(?![\w\"])", re.sub(r"<[^>]+>", " ", html)), alt
    assert "evil.com" not in html


def test_the_export_renderers_show_images_by_the_rule():
    for md in (render._markdown(), render._themed_markdown(False)):
        _check_images_html(md.render(IMAGES_BODY, {"footnotes": render._Footnotes({})}))


async def test_html_and_pdf_exports_show_images_by_the_rule(client):
    owner = (await make_ctx()).as_("owner")
    draft = "---\ntitle: Images\n---\n\n# Images {#images}\n\n" + IMAGES_BODY
    resp = await import_md(client, owner, draft, doc="images")
    assert resp.status_code == 201, resp.text
    url = "/v1/documents/images/versions/1/export"
    resp = await client.get(url, params={"format": "html"}, headers=owner)
    assert resp.status_code == 200, resp.text
    _check_images_html(resp.text)
    if not pdf_available():
        return
    resp = await client.get(url, params={"format": "pdf"}, headers=owner)
    assert resp.status_code == 200, resp.text
    text = " ".join(page.extract_text() for page in PdfReader(io.BytesIO(resp.content)).pages)
    text = re.sub(r"\s+", " ", text)
    assert "remote chart (e.com)" in text and "Last paragraph." in text, text
    assert "<p>" not in text and "&lt;" not in text, text


def test_slides_show_an_image_as_its_label():
    blocks = pptx.parse_blocks(IMAGES_BODY)
    paras = [item for item in blocks.items if isinstance(item, pptx.Para)]
    text = " ".join(r.text for p in paras for r in p.runs)
    for label in ("relative host", "remote chart (e.com)", "stored chart", "evil", "dots"):
        assert label in text, (label, text)
