"""F5-1 tech briefs: the tech_briefs.yaml contract and its check, the task text,
registration as tech_brief artifacts (at the Engineering check's approval for an
existing PRD, else with the prd_draft import), staleness and the read routes.

The fake SwarmCloud runtime stands in for the architect; no model is called. F4 adds
the Engineering check segment to the real flow: these tests stand it in
(tests.tech_brief_helpers.flow_with_eng_check)."""

import json
import uuid

import pytest
from sqlalchemy import select

import oracle.main  # noqa: F401  (registers the lanes' change handlers)
from oracle.auth.service import create_user, make_session_cookie
from oracle.config import get_settings
from oracle.docs.models import Document, DocumentVersion
from oracle.engineering import briefs
from oracle.models import AuditEvent
from oracle.runs import flows
from oracle.runs.models import Checkpoint
from oracle.swarm import FakeRuntime, Outcome, set_runtime
from oracle.tenancy import tenant_session
from oracle.v2 import models as m
from tests.fixtures import draft, import_draft, seed_auth
from tests.tech_brief_helpers import (
    CODE_MAP,
    FEATURES,
    NO_MAP,
    SAMPLE,
    BriefsRuntime,
    flow_with_eng_check,
    seed_features,
)
from tests.test_code_maps import MAP, shared_map

# --------------------------------------------------------------------------- the check


def codes(problems) -> set[str]:
    return {p.code for p in problems}


def test_the_sample_checks_clean_against_its_feature_set_and_code_map():
    # protects=AC1 the contract's own sample is valid; fails_when=a rule refuses the
    # documented format; no_claim=what the brief says is true of the code.
    assert briefs.check(SAMPLE, FEATURES, CODE_MAP) == []
    assert briefs.check(NO_MAP, FEATURES, None) == []


BIG = "x" * (briefs.MAX_BYTES + 1)


@pytest.mark.parametrize(
    ("code", "text", "features", "code_map"),
    [
        ("unreadable", "version: [1\n", FEATURES, CODE_MAP),
        ("unreadable", "- a list, not a mapping\n", FEATURES, CODE_MAP),
        ("unreadable", f"version: 1\nnote: {BIG}\n", FEATURES, CODE_MAP),
        ("wrong_version", SAMPLE.replace("version: 1", "version: 2"), FEATURES, CODE_MAP),
        ("missing_feature", SAMPLE, (*FEATURES, "feature-c"), CODE_MAP),
        ("unknown_feature", SAMPLE, ("feature-a",), CODE_MAP),
        ("bad_size", SAMPLE.replace("size: m\n", "size: xxl\n"), FEATURES, CODE_MAP),
        ("bad_kind", SAMPLE.replace("kind: api", "kind: widget"), FEATURES, CODE_MAP),
        ("bad_change", SAMPLE.replace("change: new", "change: rewrite"), FEATURES, CODE_MAP),
        (
            "duplicate_question_id",
            SAMPLE.replace(
                "blocking: true}\n",
                "blocking: true}\n      - {id: q1, question: Again, why: Twice, blocking: false}\n",
            ),
            FEATURES,
            CODE_MAP,
        ),
        (
            "unknown_dependency",
            SAMPLE.replace("depends_on: [feature-b]", "depends_on: [feature-z]"),
            FEATURES,
            CODE_MAP,
        ),
        ("unknown_ref", SAMPLE, FEATURES, {"module:billing"}),
        ("unknown_ref", SAMPLE, FEATURES, None),
        (
            "ref_without_map",
            SAMPLE.replace("used: true", "used: false"),
            FEATURES,
            None,
        ),
        (
            "no_assumptions",
            NO_MAP.replace('assumptions: ["A billing module exists"]', "assumptions: []"),
            FEATURES,
            None,
        ),
    ],
)
def test_each_problem_code_is_reported(code, text, features, code_map):
    # protects=AC1 every listed problem code; fails_when=a crafted file passes or is
    # reported under another code; no_claim=the wording of the message.
    problems = briefs.check(text, features, code_map)
    assert code in codes(problems), problems
    for p in problems:
        assert p.message


def test_problems_name_the_feature_they_are_about():
    # protects=the error card can point at a feature; fails_when=feature is lost.
    text = SAMPLE.replace("size: m\n", "size: huge\n")
    (problem,) = briefs.check(text, FEATURES, CODE_MAP)
    assert problem.code == "bad_size" and problem.feature == "feature-a"


def test_a_reuse_entry_is_a_ref_too():
    # protects=reuse cites code map ids; fails_when=a reuse id outside the map passes.
    text = SAMPLE.replace('reuse: ["module:notifications"]', 'reuse: ["module:ghost"]')
    assert codes(briefs.check(text, FEATURES, CODE_MAP)) == {"unknown_ref"}


def test_limits_on_features_and_questions():
    # protects=the 100 features and 20 questions per feature limits; fails_when=more
    # pass; no_claim=the 200 KB limit (tested above as unreadable).
    entry = (
        "  - {feature: f%d, title: F, approach: A, touches: [], reuse: [], risks: [],"
        " questions: [], size: s, size_why: W, depends_on: [], assumptions: [x]}\n"
    )
    many = "version: 1\ncode_map: {used: false, repos: []}\nfeatures:\n" + "".join(
        entry % i for i in range(briefs.MAX_FEATURES + 1)
    )
    keys = [f"f{i}" for i in range(briefs.MAX_FEATURES + 1)]
    assert "too_large" in codes(briefs.check(many, keys, None))
    questions = "".join(
        f"      - {{id: q{i}, question: Q, why: W, blocking: false}}\n"
        for i in range(briefs.MAX_QUESTIONS + 1)
    )
    text = SAMPLE.replace(
        '      - {id: q1, question: "Can the nightly job run hourly?", why: "Freshness", '
        "blocking: true}\n",
        questions,
    )
    assert "too_large" in codes(briefs.check(text, FEATURES, CODE_MAP))


def test_a_missing_or_mistyped_field_is_a_bad_entry():
    # protects=registration only reads well-formed entries; fails_when=a brief without
    # an approach or with a string for touches passes.
    no_approach = SAMPLE.replace(
        '    approach: "Extend the notifications module with a digest."\n', ""
    )
    assert "bad_entry" in codes(briefs.check(no_approach, FEATURES, CODE_MAP))
    wrong_type = SAMPLE.replace("    reuse: []\n", "    reuse: nothing\n")
    assert "bad_entry" in codes(briefs.check(wrong_type, FEATURES, CODE_MAP))


def test_the_task_text_states_the_contract():
    # protects=the architect's instructions (F4's Engineering check segment); fails_when
    # a rule of the task is dropped; no_claim=how a model follows it.
    task = flows.TECH_BRIEF_TASK
    assert flows.BRIEFS_FILE in task and "one brief per feature" in task
    assert "get_code_map" in task and "ref" in task
    assert "used: false" in task and "assumptions" in task
    assert "blocking" in task and "never give dates" in task.lower()
    for size in briefs.SIZES:
        assert size in task


def test_the_markdown_rendering_carries_what_a_reader_needs():
    # protects=brief.md; fails_when=approach, refs, questions or the verdict are dropped.
    parsed = briefs.parse(SAMPLE)
    entry = parsed.features[0]
    md = briefs.render_markdown(
        entry,
        parsed.code_map,
        verdict={"value": "feasible_with_changes", "note": "One writer"},
        answers=[{"question_id": "q1", "answer": "Hourly is fine"}],
    )
    for text in ("Feature A", entry.approach, "module:billing", "POST /v1/invoices",
                 "Can the nightly job run hourly?", "Hourly is fine", "feasible with changes",
                 "org/app"):  # fmt: skip
        assert text in md, text
    no_map = briefs.parse(NO_MAP)
    md = briefs.render_markdown(no_map.features[0], no_map.code_map, verdict=None, answers=[])
    assert "No code map: assumptions" in md and "A billing module exists" in md


# --------------------------------------------------------------------------- registration


@pytest.fixture
def eng_flow(monkeypatch):
    monkeypatch.setitem(flows.FLOWS, "baseline_to_prd", flow_with_eng_check())


@pytest.fixture
def runtime():
    fake = BriefsRuntime(
        {
            "eng_check": [Outcome(artifacts={flows.BRIEFS_FILE: SAMPLE})],
        }
    )
    set_runtime(fake)
    yield fake
    set_runtime(None)


async def member(tenant_id: uuid.UUID, role: str) -> tuple[uuid.UUID, dict[str, str]]:
    async with tenant_session(tenant_id) as s:
        user = await create_user(s, f"{role}-{uuid.uuid4().hex[:6]}@example.com", "pw")
        user.role = role
        await s.commit()
    cookie = f"{get_settings().session_cookie_name}={make_session_cookie(user)}"
    return user.id, {"Cookie": cookie}


async def start(client, auth, document: str, **knobs) -> dict:
    resp = await client.post(
        "/v1/runs",
        json={"flow": "baseline_to_prd", "document": document, "knobs": knobs},
        headers=auth,
    )
    assert resp.status_code == 201, resp.text
    run_id = resp.json()["id"]
    assert (await client.post(f"/v1/runs/{run_id}/estimate", headers=auth)).status_code == 200
    resp = await client.post(f"/v1/runs/{run_id}/start", headers=auth)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def tick(client, auth) -> None:
    resp = await client.post("/v1/internal/tick", headers=auth)
    assert resp.status_code == 200 and resp.json()["errors"] == [], resp.text


async def get_run(client, auth, run_id: str) -> dict:
    return (await client.get(f"/v1/runs/{run_id}", headers=auth)).json()


async def advance_to(client, auth, run_id: str, kind: str) -> dict:
    """Tick and approve until the run waits at ``kind`` (approving everything before)."""
    for _ in range(10):
        await tick(client, auth)
        run = await get_run(client, auth, run_id)
        if run["status"] != "awaiting_checkpoint":
            continue
        if run["waiting_on"] == kind:
            return run
        await decide(client, auth, run)
    raise AssertionError(f"the run never waited at {kind}")


def pending(run: dict) -> dict:
    return next(c for c in run["checkpoints"] if c["status"] == "pending")


async def stage_check(client, headers, run: dict, verdicts=None, answers=None) -> None:
    """F4's Engineering check gate: stage a verdict per feature and an answer per blocking
    question (``verdicts``/``answers`` by feature key; else feasible and "Yes")."""
    cp = pending(run)
    for f in cp["payload"]["briefs_check"]["features"]:
        bodies = [
            {
                "field": "verdict",
                "value": (verdicts or {}).get(f["key"]) or {"verdict": "feasible", "note": None},
            }
        ]
        bodies += [{"field": f"answer:{q['id']}",
                    "value": (answers or {}).get(f["key"], {}).get(q["id"], "Yes")}
                   for q in f["questions"] if q["blocking"]]  # fmt: skip
        for body in bodies:
            resp = await client.post(
                f"/v1/runs/{run['id']}/checkpoints/{cp['id']}/actions",
                json={"item_key": f["key"], "kind": "edit", **body},
                headers=headers,
            )
            assert resp.status_code in (200, 201), resp.text


async def decide(client, headers, run: dict, stage: bool = True) -> dict:
    cp = pending(run)
    if stage and cp["kind"] == "eng_review":
        await stage_check(client, headers, run)
    resp = await client.post(
        f"/v1/runs/{run['id']}/checkpoints/{cp['id']}/decide",
        json={"decision": "approved", "note": "Looks buildable"},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


async def record_engineering_decisions(client, headers, run: dict) -> None:
    """What F4's Engineering check screen stages before Approve."""
    await stage_check(
        client,
        headers,
        run,
        verdicts={"feature-a": {"verdict": "feasible_with_changes", "note": "One writer"}},
        answers={"feature-a": {"q1": "Hourly is fine"}},
    )


async def brief_rows(tenant_id: uuid.UUID):
    async with tenant_session(tenant_id) as s:
        rows = (
            await s.execute(
                select(m.ArtifactRequest, m.ArtifactVersion)
                .join(m.ArtifactVersion, m.ArtifactVersion.request_id == m.ArtifactRequest.id)
                .where(m.ArtifactRequest.kind == "tech_brief")
                .order_by(m.ArtifactRequest.title)
            )
        ).all()
        return [(req, av) for req, av in rows]


async def test_existing_prd_briefs_are_registered_when_the_engineering_check_is_approved(
    client, eng_flow, runtime
):
    # protects=AC2 one approved tech_brief per feature with outputs and dependencies,
    # the draft version filled in at the import, and requirement edits marking it
    # potentially_stale; fails_when=a brief is missing, unapproved, without brief.json /
    # brief.md or without its feature and requirement dependencies; no_claim=F4's
    # screen (the verdicts are written on the checkpoint as it will).
    tenant_id, auth = await seed_auth()
    ids = await seed_features(tenant_id)
    assert (await import_draft(client, auth, draft("prd_v1.md"))).status_code == 201
    lead_id, lead = await member(tenant_id, "approver")
    await shared_map(tenant_id, MAP)  # F4's check: SAMPLE's refs are in the run's map
    run = await start(client, auth, "checkout-redesign")
    run = await advance_to(client, auth, run["id"], "eng_review")
    assert await brief_rows(tenant_id) == []
    await record_engineering_decisions(client, lead, run)
    await decide(client, lead, run, stage=False)

    rows = await brief_rows(tenant_id)
    assert [req.title for req, _ in rows] == ["Feature A", "Feature B"]
    async with tenant_session(tenant_id) as s:
        doc = await s.scalar(select(Document).where(Document.slug == "checkout-redesign"))
        cp = await s.scalar(select(Checkpoint).where(Checkpoint.kind == "eng_review"))
    for req, av in rows:
        assert req.source_document_id == doc.id
        assert req.source_version_id is None  # the run's draft does not exist yet
        assert req.run_id == uuid.UUID(run["id"])
        assert req.params["run_id"] == run["id"] and req.params["segment_seq"] == 3
        assert av.number == 1 and av.status == "approved"
        assert av.approved_by == lead_id and av.approved_at is not None
        assert av.provenance["run_id"] == run["id"]
        assert av.provenance["code_map"] == [
            # partial: F5-2, set by Oracle from the map the run recorded (none here).
            {"repo": "org/app", "commit": "3f2c9a1", "as_of": "2026-10-18T10:00:00Z",
             "partial": False}
        ]  # fmt: skip
    (req_a, av_a), (req_b, av_b) = rows
    assert req_a.params["feature_key"] == "feature-a"
    assert set(req_a.requirement_ids) == {ids["req-a1"], ids["req-a2"]}
    assert set(req_b.requirement_ids) == {ids["req-b1"]}
    assert av_a.provenance["size"] == "m" and av_b.provenance["size"] == "s"
    assert av_a.provenance["verdict"]["value"] == "feasible_with_changes"
    assert av_a.provenance["verdict"]["by"] == str(lead_id)
    assert av_a.provenance["answers"] == [
        {"question_id": "q1", "answer": "Hourly is fine", "by": str(lead_id)}
    ]
    # F4's gate: every feature has a verdict before Approve (feature B's staged feasible).
    assert av_b.provenance["verdict"]["value"] == "feasible"
    assert cp.status == "approved"

    async with tenant_session(tenant_id) as s:
        outputs = {
            o.name: o
            for o in await s.scalars(
                select(m.ArtifactOutput).where(m.ArtifactOutput.version_id == av_a.id)
            )
        }
        deps = (
            await s.scalars(
                select(m.ArtifactDependency).where(
                    m.ArtifactDependency.artifact_version_id == av_a.id
                )
            )
        ).all()
        audits = (
            await s.scalars(select(AuditEvent).where(AuditEvent.action == "tech_brief.registered"))
        ).all()
    assert set(outputs) == {"brief.json", "brief.md"}
    body = json.loads(outputs["brief.json"].content)
    assert body["feature"] == "feature-a" and body["verdict"]["value"] == "feasible_with_changes"
    assert outputs["brief.json"].media_type == "application/json"
    assert outputs["brief.md"].media_type == "text/markdown"
    assert "Add an invoice endpoint" in outputs["brief.md"].content
    assert {d.upstream_entity_id for d in deps} == {ids["feature-a"], ids["req-a1"], ids["req-a2"]}
    assert len(audits) == 2

    # The run's draft: imported as the next version, it fills in source_version_id.
    run = await advance_to(client, auth, run["id"], "prd_review")
    assert run["segments"][4]["draft_import"]["version"] == 2
    async with tenant_session(tenant_id) as s:
        v2 = await s.scalar(
            select(DocumentVersion).where(
                DocumentVersion.document_id == doc.id, DocumentVersion.number == 2
            )
        )
    rows = await brief_rows(tenant_id)
    assert {req.source_version_id for req, _ in rows} == {v2.id}
    assert len(rows) == 2  # nothing registered twice

    # Editing one of feature A's requirements marks its brief, not feature B's.
    resp = await client.patch(
        f"/v1/baseline/entities/{ids['req-a1']}",
        json={"title": "Requirement A1, revised", "origin": "user"},
        headers=lead,
    )
    assert resp.status_code == 200, resp.text
    (_, av_a), (_, av_b) = await brief_rows(tenant_id)
    assert av_a.freshness == "potentially_stale"
    assert av_b.freshness == "fresh"

    viewer_id, viewer = await member(tenant_id, "viewer")
    resp = await client.get(f"/v1/tech-briefs/{av_a.id}", headers=viewer)
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["feature"] == {"key": "feature-a", "title": "Feature A",
                              "entity_id": str(ids["feature-a"])}  # fmt: skip
    assert out["prd"] == {"slug": "checkout-redesign", "version": 2}
    assert out["run_id"] == run["id"]
    assert out["code_map"]["used"] is True
    assert out["code_map"]["repos"][0]["repo"] == "org/app"
    assert out["approach"].startswith("Add an invoice endpoint")
    assert out["touches"][0] == {"area": "api/billing", "kind": "module", "change": "change",
                                 "ref": "module:billing"}  # fmt: skip
    assert out["reuse"] == ["module:notifications"]
    assert out["risks"][0]["level"] == "medium"
    assert out["questions"][0]["id"] == "q1" and out["questions"][0]["blocking"] is True
    assert out["answers"] == [{"question_id": "q1", "answer": "Hourly is fine", "by": str(lead_id)}]
    assert out["size"] == "m" and out["size_why"] == "Two endpoints and one migration"
    assert out["depends_on"] == ["feature-b"]
    assert out["verdict"]["value"] == "feasible_with_changes"
    assert out["verdict"]["by"] == str(lead_id) and out["verdict"]["at"]
    assert out["status"] == "approved"
    assert out["freshness"] == "potentially_stale"
    assert out["stale_reasons"]


async def test_a_new_prd_gets_its_briefs_with_the_prd_draft_import(client, eng_flow, runtime):
    # protects=AC3 a new PRD's briefs are registered in the same transaction as the
    # prd_draft import; fails_when=they are registered before the PRD exists, later
    # than the import, or not at all; no_claim=the import's own checks.
    tenant_id, auth = await seed_auth()
    await seed_features(tenant_id)
    await shared_map(tenant_id, MAP)  # F4's check: SAMPLE's refs are in the run's map
    run = await start(client, auth, "new-prd")
    run = await advance_to(client, auth, run["id"], "eng_review")
    await decide(client, auth, run)
    assert await brief_rows(tenant_id) == []  # no PRD yet: nothing to attach them to

    run = await advance_to(client, auth, run["id"], "prd_review")
    rows = await brief_rows(tenant_id)
    assert len(rows) == 2
    async with tenant_session(tenant_id) as s:
        version = await s.scalar(select(DocumentVersion))
        imported = await s.scalar(
            select(AuditEvent).where(AuditEvent.action == "document.version_imported")
        )
        registered = (
            await s.scalars(select(AuditEvent).where(AuditEvent.action == "tech_brief.registered"))
        ).all()
    for req, av in rows:
        assert req.source_document_id == version.document_id
        assert req.source_version_id == version.id
        assert av.source_version_id == version.id
        assert av.status == "approved" and av.approved_by is not None
    # now() is the transaction's start: one transaction, one timestamp.
    assert {a.created_at for a in registered} == {imported.created_at}


async def test_with_the_engineering_check_off_briefs_are_registered_as_drafts(
    client, eng_flow, no_map_runtime
):
    # protects=status 'approved' only when the check was approved; fails_when=a brief
    # no one approved reads as approved. Without the check, a ref is checked against the
    # run's code map, which no run records yet (F5-2): the briefs here have no map.
    tenant_id, auth = await seed_auth()
    await seed_features(tenant_id)
    run = await start(client, auth, "unchecked-prd", checkpoints={"eng_review": False})
    await advance_to(client, auth, run["id"], "prd_review")
    rows = await brief_rows(tenant_id)
    assert len(rows) == 2
    for _, av in rows:
        assert av.status == "draft" and av.approved_by is None
        assert av.provenance["verdict"] is None


@pytest.fixture
def no_map_runtime():
    fake = BriefsRuntime(
        {
            "eng_check": [Outcome(artifacts={flows.BRIEFS_FILE: NO_MAP})],
        }
    )
    set_runtime(fake)
    yield fake
    set_runtime(None)


async def test_the_read_routes(client, eng_flow, no_map_runtime):
    # protects=GET /v1/tech-briefs (by PRD and feature) and /v1/tech-briefs/{id} for
    # viewers, company-scoped; fails_when=a filter is ignored, another company reads a
    # brief or a viewer is refused; no_claim=MCP transport (the tools are the routes).
    tenant_id, auth = await seed_auth()
    await seed_features(tenant_id)
    run = await start(client, auth, "map-less")
    run = await advance_to(client, auth, run["id"], "prd_review")
    _, viewer = await member(tenant_id, "viewer")

    resp = await client.get("/v1/tech-briefs", params={"prd": "map-less"}, headers=viewer)
    assert resp.status_code == 200, resp.text
    listed = resp.json()
    assert [b["feature"]["key"] for b in listed] == ["feature-a", "feature-b"]
    assert listed[0]["code_map"] == {"used": False, "repos": [], "unmapped": []}
    assert listed[0]["assumptions"] == ["A billing module exists"]
    assert listed[0]["prd"] == {"slug": "map-less", "version": 1}
    resp = await client.get(
        "/v1/tech-briefs", params={"prd": "map-less", "feature": "feature-b"}, headers=viewer
    )
    assert [b["feature"]["key"] for b in resp.json()] == ["feature-b"]
    assert (await client.get("/v1/tech-briefs", headers=viewer)).status_code == 200
    resp = await client.get("/v1/tech-briefs", params={"prd": "nope"}, headers=viewer)
    assert resp.status_code == 404

    one = listed[0]["id"]
    assert (await client.get(f"/v1/tech-briefs/{one}", headers=viewer)).status_code == 200
    assert (await client.get(f"/v1/tech-briefs/{uuid.uuid4()}", headers=viewer)).status_code == 404
    assert (await client.get(f"/v1/tech-briefs/{one}")).status_code == 401

    # Another company: 404 for the id, nothing listed.
    other_tenant, other = await seed_other_company()
    assert (await client.get(f"/v1/tech-briefs/{one}", headers=other)).status_code == 404
    resp = await client.get("/v1/tech-briefs", headers=other)
    assert resp.status_code == 200 and resp.json() == []
    assert other_tenant != tenant_id

    # Another artifact kind is not a tech brief.
    async with tenant_session(tenant_id) as s:
        req = await s.scalar(select(m.ArtifactRequest))
        req_id = req.id
    async with tenant_session(tenant_id) as s:
        spec = m.ArtifactRequest(kind="engineering_spec", title="Spec",
                                 source_document_id=req.source_document_id)  # fmt: skip
        s.add(spec)
        await s.flush()
        av = m.ArtifactVersion(request_id=spec.id, number=1)
        s.add(av)
        await s.commit()
        spec_version = av.id
    assert req_id
    assert (await client.get(f"/v1/tech-briefs/{spec_version}", headers=viewer)).status_code == 404


async def seed_other_company() -> tuple[uuid.UUID, dict[str, str]]:
    from tests.conftest import make_tenant

    other = await make_tenant("Other Co")
    _, headers = await member(other, "owner")
    return other, headers


async def test_registration_is_idempotent(client, eng_flow, runtime):
    # protects=one brief per feature per run; fails_when=a repeated import or approval
    # registers a second brief.
    from oracle.engineering import store

    tenant_id, auth = await seed_auth()
    await seed_features(tenant_id)
    await shared_map(tenant_id, MAP)  # F4's check: SAMPLE's refs are in the run's map
    run = await start(client, auth, "twice")
    await advance_to(client, auth, run["id"], "prd_review")
    async with tenant_session(tenant_id) as s:
        version = await s.scalar(select(DocumentVersion))
        document = await s.get(Document, version.document_id)
        user = await s.scalar(
            select(AuditEvent.actor).where(AuditEvent.action == "tech_brief.registered")
        )
        assert user
        from oracle.auth.deps import Principal

        principal = Principal(tenant_id=tenant_id, kind="user", role="owner", user_id=uuid.uuid4())
        added = await store.on_draft_imported(s, principal, uuid.UUID(run["id"]), document, version)
        await s.commit()
    assert added == []
    assert len(await brief_rows(tenant_id)) == 2


def test_the_routes_are_mcp_tools():
    # protects=list_tech_briefs and get_tech_brief (the issue's API summary);
    # fails_when=an operation id changes.
    from oracle.main import app
    from oracle.mcp.tools import app_operations

    names = {op.tool_name for op in app_operations(app)}
    assert {"list_tech_briefs", "get_tech_brief"} <= names


# --------------------------------------------------------------------------- review fixes


def test_parse_reads_the_file_once(monkeypatch):
    # protects=one YAML load per parse (check reuses parse's data); fails_when=parse
    # loads the untrusted file again to check it.
    from oracle import safe_yaml

    loads = []
    real = safe_yaml.load

    def counting(text, **kw):
        loads.append(text)
        return real(text, **kw)

    monkeypatch.setattr(safe_yaml, "load", counting)
    parsed = briefs.parse(SAMPLE)
    assert [f.feature for f in parsed.features] == list(FEATURES)
    assert len(loads) == 1


@pytest.mark.timing
async def test_a_slow_brief_parse_is_refused_off_the_event_loop(monkeypatch):
    # protects=the briefs' parse and rendering run on the parse pool with a time cap
    # (oracle.safe_yaml.run_parse_within); fails_when=they run on the event loop or wait
    # without a cap.
    import asyncio
    import time

    from oracle import safe_yaml
    from oracle.engineering import store

    def slow(*args, **kwargs):
        time.sleep(0.5)
        raise AssertionError("not reached")

    monkeypatch.setattr(store, "_prepare", slow)
    monkeypatch.setattr(safe_yaml, "PARSE_SECONDS", 0.05)
    beats = 0

    async def beat():
        nonlocal beats
        while True:
            await asyncio.sleep(0.01)
            beats += 1

    task = asyncio.create_task(beat())
    with pytest.raises(safe_yaml.ParseTimeout):
        await store.prepare(SAMPLE, None)
    task.cancel()
    assert beats >= 2


async def test_registration_parses_and_renders_on_the_parse_pool(
    client, eng_flow, runtime, monkeypatch
):
    # protects=at the approval and at the draft import, tech_briefs.yaml is loaded and
    # brief.md rendered on the parse pool, never on the event loop; fails_when=a request
    # handler parses or renders the untrusted file itself.
    import threading

    from oracle import safe_yaml

    threads: dict[str, list[str]] = {"load": [], "render": []}
    real_load, real_render = safe_yaml.load, briefs.render_markdown

    def load(text, **kw):
        if text == SAMPLE:
            threads["load"].append(threading.current_thread().name)
        return real_load(text, **kw)

    def render(*args, **kw):
        threads["render"].append(threading.current_thread().name)
        return real_render(*args, **kw)

    monkeypatch.setattr(safe_yaml, "load", load)
    monkeypatch.setattr(briefs, "render_markdown", render)
    tenant_id, auth = await seed_auth()
    await seed_features(tenant_id)
    assert (await import_draft(client, auth, draft("prd_v1.md"))).status_code == 201
    await shared_map(tenant_id, MAP)  # F4's check: SAMPLE's refs are in the run's map
    run = await start(client, auth, "checkout-redesign")
    run = await advance_to(client, auth, run["id"], "eng_review")
    threads["load"].clear()
    await decide(client, auth, run)
    assert len(await brief_rows(tenant_id)) == 2
    assert len(threads["load"]) == 1 and len(threads["render"]) == 2, threads
    threads["load"].clear()
    await advance_to(client, auth, run["id"], "prd_review")  # the draft import
    assert threads["load"], "the draft import did not read the briefs"
    for name in threads["load"] + threads["render"]:
        assert name.startswith("safe-yaml"), threads


async def test_non_text_decisions_are_dropped_at_registration(
    client, eng_flow, runtime, monkeypatch
):
    # protects=the GET routes read a brief whose checkpoint recorded non-text verdicts or
    # answers; fails_when=such a value is stored and the routes answer 500.
    tenant_id, auth = await seed_auth()
    await seed_features(tenant_id)
    assert (await import_draft(client, auth, draft("prd_v1.md"))).status_code == 201
    lead_id, lead = await member(tenant_id, "approver")
    await shared_map(tenant_id, MAP)  # F4's check: SAMPLE's refs are in the run's map
    run = await start(client, auth, "checkout-redesign")
    run = await advance_to(client, auth, run["id"], "eng_review")
    recorded = {
        "verdicts": {"feature-a": {"value": 3, "note": ["x"]}, "feature-b": "feasible"},
        "answers": {
            "feature-a": [
                {"question_id": "q1", "answer": {"text": "Hourly"}},
                {"question_id": 7, "answer": "Seven"},
                {"question_id": "q1", "answer": 42},
                {"question_id": "q1", "answer": "Hourly is fine", "by": 5},
                "junk",
            ],
            "feature-b": "none",
        },
    }
    # F4's Approve records the staged choices on the checkpoint: record these instead.
    from oracle.engineering import check as eng_check

    monkeypatch.setattr(eng_check, "decisions", lambda cp, actions: {**recorded, "sizes": {}})

    async def no_lines(*args):
        return []  # what the later prompts read of such values is not this test's claim

    monkeypatch.setattr(eng_check, "prompt_lines", no_lines)
    await decide(client, lead, run)

    _, viewer = await member(tenant_id, "viewer")
    resp = await client.get("/v1/tech-briefs", headers=viewer)
    assert resp.status_code == 200, resp.text
    a, b = resp.json()
    assert a["verdict"]["value"] is None and a["verdict"]["note"] == "Looks buildable"
    assert a["answers"] == [{"question_id": "q1", "answer": "Hourly is fine", "by": str(lead_id)}]
    assert b["verdict"]["value"] is None and b["answers"] == []
    resp = await client.get(f"/v1/tech-briefs/{a['id']}", headers=viewer)
    assert resp.status_code == 200, resp.text


# The contract's sample written as ordinary YAML: an unquoted digits-only commit reads as
# a number and an unquoted ISO timestamp as a date and time.
UNQUOTED = SAMPLE.replace(
    '{repo: "org/app", commit: "3f2c9a1", as_of: "2026-10-18T10:00:00Z"}',
    "{repo: org/app, commit: 1234567, as_of: 2026-10-18T10:00:00Z}",
)


def test_a_commit_or_as_of_that_is_not_text_is_a_bad_entry():
    # protects=check and parse refuse a code_map repo whose commit or as_of YAML read as
    # a number or a date; fails_when=check returns [] and parse raises a pydantic
    # ValidationError the callers do not catch.
    assert UNQUOTED != SAMPLE
    problems = briefs.check(UNQUOTED, FEATURES, CODE_MAP)
    assert codes(problems) == {"bad_entry"}
    assert any("commit" in p.message for p in problems)
    assert any("as_of" in p.message for p in problems)
    with pytest.raises(briefs.BriefsInvalid) as exc:
        briefs.parse(UNQUOTED)
    assert codes(exc.value.problems) == {"bad_entry"}
    nulls = SAMPLE.replace('commit: "3f2c9a1", as_of: "2026-10-18T10:00:00Z"',
                           "commit: null, as_of: null")  # fmt: skip
    assert briefs.check(nulls, FEATURES, CODE_MAP) == []
    assert briefs.parse(nulls).code_map.repos[0].commit is None


@pytest.fixture
def unquoted_runtime():
    fake = BriefsRuntime(
        {
            "eng_check": [Outcome(artifacts={flows.BRIEFS_FILE: UNQUOTED})],
        }
    )
    set_runtime(fake)
    yield fake
    set_runtime(None)


async def test_an_unquoted_commit_is_a_file_problem_at_the_engineering_approval(
    client, eng_flow, unquoted_runtime
):
    # protects=an Engineering check whose tech_briefs.yaml has an unquoted commit and
    # as_of is refused as a file-level problem (F4: Send back is the only way on), and
    # nothing is registered; fails_when=the approval answers 500 on a pydantic
    # ValidationError, or lands.
    tenant_id, auth = await seed_auth()
    await seed_features(tenant_id)
    assert (await import_draft(client, auth, draft("prd_v1.md"))).status_code == 201
    _, lead = await member(tenant_id, "approver")
    run = await start(client, auth, "checkout-redesign")
    run = await advance_to(client, auth, run["id"], "eng_review")
    cp = pending(run)
    assert cp["gate"]["file_problems"] > 0
    resp = await client.post(
        f"/v1/runs/{run['id']}/checkpoints/{cp['id']}/decide",
        json={"decision": "approved"},
        headers=lead,
    )
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"]["code"] == "blocking_open"
    assert await brief_rows(tenant_id) == []


async def test_an_unquoted_commit_does_not_break_the_prd_draft_import(
    client, eng_flow, unquoted_runtime
):
    # protects=a new PRD's prd_draft import goes through when the run's tech_briefs.yaml
    # has an unquoted commit and as_of; fails_when=the import raises on every tick.
    # F4's gate refuses such a check (a file-level problem), so its stop is off here: the
    # stand-in segment still writes the file (tests.tech_brief_helpers).
    tenant_id, auth = await seed_auth()
    await seed_features(tenant_id)
    run = await start(client, auth, "new-prd", checkpoints={"eng_review": False})
    await advance_to(client, auth, run["id"], "prd_review")  # tick asserts no errors
    async with tenant_session(tenant_id) as s:
        assert await s.scalar(select(DocumentVersion)) is not None
    assert await brief_rows(tenant_id) == []


# One brief that checks clean, one citing a code map id no map of the run holds, one
# for a feature the feature set does not have.
UNCHECKED = """\
version: 1
code_map:
  used: true
  repos:
    - {repo: "org/app", commit: "3f2c9a1", as_of: "2026-10-18T10:00:00Z"}
features:
  - feature: feature-a
    title: "Feature A"
    approach: "Add an invoice endpoint."
    touches:
      - {area: "POST /v1/invoices", kind: api, change: new, ref: null}
    size: s
  - feature: feature-b
    title: "Feature B"
    approach: "Extend the notifications module."
    touches:
      - {area: "api/notifications", kind: module, change: change, ref: "module:ghost"}
    size: s
  - feature: feature-z
    title: "Feature Z"
    approach: "Something the feature set does not have."
    size: xs
"""


@pytest.fixture
def unchecked_runtime():
    fake = FakeRuntime({"eng_check": [Outcome(artifacts={flows.BRIEFS_FILE: UNCHECKED})]})
    set_runtime(fake)
    yield fake
    set_runtime(None)


async def test_with_the_check_off_a_brief_with_an_unknown_feature_or_ref_is_refused(
    client, eng_flow, unchecked_runtime
):
    # protects=with the Engineering check turned off, registration runs the check against
    # the feature set and the code map and refuses a brief with unknown_feature or
    # unknown_ref; fails_when=such a brief is stored unchecked.
    tenant_id, auth = await seed_auth()
    await seed_features(tenant_id)
    run = await start(client, auth, "unchecked-prd", checkpoints={"eng_review": False})
    await advance_to(client, auth, run["id"], "prd_review")
    rows = await brief_rows(tenant_id)
    assert [req.params["feature_key"] for req, _ in rows] == ["feature-a"]
