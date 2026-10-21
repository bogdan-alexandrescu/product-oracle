"""Runs end to end against Postgres, with the FakeRuntime as the agent runtime."""

import uuid
from decimal import Decimal

import pytest
from sqlalchemy import select

from oracle.auth.service import create_user, make_session_cookie
from oracle.config import get_settings
from oracle.docs.models import Document, DocumentVersion
from oracle.models import AuditEvent
from oracle.review.models import FeedbackItem
from oracle.runs import flows
from oracle.runs.models import Checkpoint, Run, RunSegment
from oracle.runtokens import RunToken, verify_run_token
from oracle.sources.models import Snapshot
from oracle.swarm import FakeRuntime, Outcome, set_runtime
from oracle.tenancy import tenant_session
from tests.fixtures import draft, import_draft, seed_auth

BAD_PRD = "# No front matter {#title}\n"


@pytest.fixture
def runtime():
    fake = FakeRuntime()
    set_runtime(fake)
    yield fake
    set_runtime(None)


@pytest.fixture
async def owner():
    """(tenant_id, owner API token headers)."""
    return await seed_auth()


async def as_user(tenant_id: uuid.UUID, role: str, email: str | None = None) -> dict[str, str]:
    async with tenant_session(tenant_id) as s:
        user = await create_user(s, email or f"{role}-{uuid.uuid4().hex[:6]}@example.com", "pw")
        user.role = role
        await s.commit()
    return {"Cookie": f"{get_settings().session_cookie_name}={make_session_cookie(user)}"}


async def create(client, headers, flow="baseline_to_prd", document="example-prd", **knobs):
    resp = await client.post(
        "/v1/runs", json={"flow": flow, "document": document, "knobs": knobs}, headers=headers
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


async def started(client, headers, **kw):
    run = await create(client, headers, **kw)
    est = await client.post(f"/v1/runs/{run['id']}/estimate", headers=headers)
    assert est.status_code == 200, est.text
    resp = await client.post(f"/v1/runs/{run['id']}/start", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def tick(client, headers):
    resp = await client.post("/v1/internal/tick", headers=headers)
    assert resp.status_code == 200, resp.text
    assert resp.json()["errors"] == []
    return resp.json()


async def get(client, headers, run_id):
    resp = await client.get(f"/v1/runs/{run_id}", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


def pending(run):
    return next(c for c in run["checkpoints"] if c["status"] == "pending")


async def decide(client, headers, run, decision="approved", note=None):
    cp = pending(run)
    resp = await client.post(
        f"/v1/runs/{run['id']}/checkpoints/{cp['id']}/decide",
        json={"decision": decision, "note": note},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


# --------------------------------------------------------------------------- flows


async def test_flow_catalog(client, owner, runtime):
    _, auth = owner
    resp = await client.get("/v1/flows", headers=auth)
    assert resp.status_code == 200
    body = resp.json()
    b2p = next(f for f in body["flows"] if f["key"] == "baseline_to_prd")
    assert [s["checkpoint"] for s in b2p["segments"]] == [
        "baseline_confirm",
        "feature_set",
        "priority_order",
        "prd_review",
    ]
    assert body["approval_threshold_usd"] == 50
    assert body["runtime"] == "fake"


def test_segment_prompts_name_tools_and_the_low_confidence_threshold():
    flow = flows.FLOWS["baseline_to_prd"]
    knobs = flows.resolve_knobs(flow, {})
    ctx = flows.PromptContext(
        run_id="r1", document="example-prd", snapshot_as_of=None, low_confidence=0.4
    )
    for segment in flow.segments:
        steps = flows.build_steps(flow, segment, knobs, ctx)
        assert [s[1] for s in steps] == list(segment.roles)
        last = steps[-1][2]
        for tool in segment.tools:
            assert tool in last
        assert "/mcp" in last
        assert "confidence" in last and "below 0.4" in last
        for output in segment.outputs:
            assert output in last
        if len(steps) > 1:
            assert steps[1][3] == (steps[0][0],)


def test_segment_tools_are_tools_of_the_mcp_server():
    from oracle.main import app
    from oracle.mcp.curated import CURATED, CURATED_NAMES
    from oracle.mcp.tools import app_operations, tool_names

    ops = app_operations(app)
    names = set(tool_names(ops, CURATED_NAMES)) | {c.name for c in CURATED if c.resolve(ops)}
    assert set(flows.MCP_TOOLS) <= names
    for flow in flows.FLOWS.values():
        for segment in flow.segments:
            assert set(segment.tools) <= set(flows.MCP_TOOLS), segment.name


# --------------------------------------------------------------------------- full flow


async def test_full_flow_through_every_checkpoint(client, owner, runtime):
    tenant_id, auth = owner
    run = await started(client, auth)
    assert run["status"] == "running"
    assert run["estimate_usd"] == 26.5
    assert run["snapshot_id"] and run["snapshot_as_of"]
    assert run["overrun_ceiling_usd"] == pytest.approx(39.75)
    assert [s["status"] for s in run["segments"]] == ["running", "pending", "pending", "pending"]

    expected = ["baseline_confirm", "feature_set", "priority_order", "prd_review"]
    for i, kind in enumerate(expected):
        result = await tick(client, auth)
        assert result["segments_finished"] == 1
        run = await get(client, auth, run["id"])
        assert run["status"] == "awaiting_checkpoint", run
        assert run["waiting_on"] == kind
        cp = pending(run)
        assert cp["kind"] == kind and cp["segment_seq"] == i + 1 and cp["can_decide"]
        assert run["segments"][i]["status"] == "succeeded"
        assert run["segments"][i]["artifacts"]
        run = await decide(client, auth, run, note=f"ok {kind}")

    assert run["status"] == "succeeded"
    assert run["finished_at"]
    assert [c["status"] for c in run["checkpoints"]] == ["approved"] * 4
    # Spend is the fake's 90% of each segment's estimate.
    assert run["spent_usd"] == pytest.approx(26.5 * 0.9)
    assert len(runtime.submitted) == 4

    # prd.md became version 1 of the new document.
    assert run["document_slug"] == "example-prd"
    prd = run["segments"][3]
    assert prd["draft_import"]["version"] == 1 and prd["draft_import"]["created"]
    async with tenant_session(tenant_id) as s:
        doc = await s.scalar(select(Document).where(Document.slug == "example-prd"))
        assert doc is not None and str(doc.id) == run["document_id"]
        assert await s.scalar(select(DocumentVersion.number)) == 1
        tokens = list(await s.scalars(select(RunToken)))
        assert len(tokens) == 4 and all(t.revoked_at for t in tokens)
        snap = await s.get(Snapshot, uuid.UUID(run["snapshot_id"]))
        assert snap.created_by == uuid.UUID(run["created_by"])
        actions = set(await s.scalars(select(AuditEvent.action)))
    assert {"run.created", "run.started", "checkpoint.approved"} <= actions

    # Earlier outputs and approval notes reach later segments' prompts.
    last_prompt = runtime.submitted[3].steps[-1].prompt
    assert "baseline.yaml" in last_prompt and "ok baseline_confirm" in last_prompt

    art = await client.get(f"/v1/runs/{run['id']}/segments/1/artifacts/baseline.yaml", headers=auth)
    assert art.status_code == 200 and "baseline" in art.text
    missing = await client.get(f"/v1/runs/{run['id']}/segments/1/artifacts/nope.md", headers=auth)
    assert missing.status_code == 404

    listed = (await client.get("/v1/runs", headers=auth)).json()
    assert [r["id"] for r in listed] == [run["id"]]
    assert listed[0]["status"] == "succeeded"


async def test_run_token_scopes_per_segment(client, owner, runtime):
    _, auth = owner
    run = await started(client, auth)
    raws = []
    for _ in range(4):
        await tick(client, auth)
        run = await decide(client, auth, await get(client, auth, run["id"]))
        raws.append(runtime.submitted[len(raws)].mcp.token)

    flow = flows.FLOWS["baseline_to_prd"]
    for spec, segment in zip(runtime.submitted, flow.segments, strict=True):
        assert spec.labels["segment"] == segment.name
        assert spec.mcp.scopes == segment.scopes
        assert spec.mcp.url.endswith("/mcp")
    # Every token was revoked by the time the next segment (or the end) came.
    for raw in raws:
        assert await verify_run_token(raw) is None
    assert set(flow.segment("priority").scopes) == {"read:baseline", "write:proposals"}
    assert "write:drafts" in flow.segment("prd_draft").scopes
    assert "write:drafts" not in flow.segment("baseline").scopes


async def test_token_is_live_while_its_segment_runs(client, owner, runtime):
    _, auth = owner
    run = await started(client, auth)
    claims = await verify_run_token(runtime.submitted[0].mcp.token)
    assert claims is not None and str(claims.run_id) == run["id"]
    assert claims.scopes == {"read:sources", "read:baseline", "write:proposals"}


async def test_skipped_checkpoints(client, owner, runtime):
    _, auth = owner
    run = await started(client, auth, checkpoints={"feature_set": False, "priority_order": False})
    assert run["knobs"]["checkpoints"] == {
        "baseline_confirm": True,
        "feature_set": False,
        "priority_order": False,
        "prd_review": True,
    }
    await tick(client, auth)
    run = await decide(client, auth, await get(client, auth, run["id"]))
    await tick(client, auth)  # feature set done, its checkpoint skipped, priority submitted
    run = await get(client, auth, run["id"])
    assert run["status"] == "running"
    assert run["segments"][2]["status"] == "running"
    await tick(client, auth)  # priority done, skipped, PRD draft submitted
    await tick(client, auth)  # PRD draft done
    run = await get(client, auth, run["id"])
    assert run["status"] == "awaiting_checkpoint" and run["waiting_on"] == "prd_review"
    assert [(c["kind"], c["status"]) for c in run["checkpoints"]] == [
        ("baseline_confirm", "approved"),
        ("feature_set", "skipped"),
        ("priority_order", "skipped"),
        ("prd_review", "pending"),
    ]
    run = await decide(client, auth, run)
    assert run["status"] == "succeeded"


async def test_all_checkpoints_off_runs_to_the_end(client, owner, runtime):
    _, auth = owner
    off = dict.fromkeys(flows.FLOWS["baseline_to_prd"].checkpoints, False)
    run = await started(client, auth, checkpoints=off)
    for _ in range(4):
        await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "succeeded"
    assert {c["status"] for c in run["checkpoints"]} == {"skipped"}


# --------------------------------------------------------------------------- cost policy


async def test_estimate_over_50_waits_for_an_owner(client, owner, runtime):
    tenant_id, auth = owner
    approver = await as_user(tenant_id, "approver")
    run = await create(client, approver, depth="deep")
    est = (await client.post(f"/v1/runs/{run['id']}/estimate", headers=approver)).json()
    assert est["total_usd"] == 53.0
    assert est["needs_approval"] is True
    assert [s["estimate_usd"] for s in est["segments"]] == [14.0, 16.0, 5.0, 18.0]

    resp = await client.post(f"/v1/runs/{run['id']}/start", headers=approver)
    assert resp.json()["status"] == "awaiting_approval"
    assert resp.json()["needs_approval"] is True
    assert runtime.submitted == []
    assert (await tick(client, auth))["runs_checked"] == 0

    inbox = (await client.get("/v1/inbox", headers=auth)).json()
    assert [r["id"] for r in inbox["approvals"]] == [run["id"]]
    assert (await client.get("/v1/inbox", headers=approver)).json()["approvals"] == []

    denied = await client.post(f"/v1/runs/{run['id']}/approve", headers=approver)
    assert denied.status_code == 403
    resp = await client.post(f"/v1/runs/{run['id']}/approve", headers=auth)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "running" and body["approved_by"] and body["approved_at"]
    assert len(runtime.submitted) == 1
    again = await client.post(f"/v1/runs/{run['id']}/approve", headers=auth)
    assert again.status_code == 409


async def test_estimate_at_50_starts_without_approval(client, owner, runtime):
    _, auth = owner
    # Base costs summing to 25, doubled by deep depth: exactly the threshold.
    roles = {
        "baseline": ["researcher"],  # 4
        "feature_set": ["researcher"],  # 4
        "priority": ["prioritizer", "analyst"],  # 5.5
        "prd_draft": ["writer", "critic", "prioritizer"],  # 11.5
    }
    run = await started(client, auth, depth="deep", roles=roles)
    assert run["estimate_usd"] == 50.0
    assert run["status"] == "running"


async def test_budget_caps_the_estimate(client, owner, runtime):
    _, auth = owner
    run = await create(client, auth, budget_usd=20)
    est = (await client.post(f"/v1/runs/{run['id']}/estimate", headers=auth)).json()
    assert est["within_budget"] is False
    resp = await client.post(f"/v1/runs/{run['id']}/start", headers=auth)
    assert resp.status_code == 422
    assert "budget" in resp.json()["detail"]
    assert runtime.submitted == []


async def test_start_needs_an_estimate(client, owner, runtime):
    _, auth = owner
    run = await create(client, auth)
    resp = await client.post(f"/v1/runs/{run['id']}/start", headers=auth)
    assert resp.status_code == 409
    assert "estimate" in resp.json()["detail"]


async def test_overrun_pauses_and_an_owner_resumes(client, owner, runtime):
    tenant_id, auth = owner
    approver = await as_user(tenant_id, "approver")
    # Estimate 26.50, ceiling 39.75: halfway the baseline has spent 25, then 50.
    runtime.script["baseline"] = [Outcome(cost_usd=Decimal(50), polls=1)]
    run = await started(client, auth)

    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "running" and run["spent_usd"] == 25.0

    result = await tick(client, auth)
    assert result["runs_paused"] == 1
    run = await get(client, auth, run["id"])
    assert run["status"] == "paused_overrun"
    assert run["spent_usd"] == 50.0
    assert run["segments"][0]["status"] == "succeeded"
    assert run["checkpoints"] == []  # not advanced while paused

    inbox = (await client.get("/v1/inbox", headers=auth)).json()
    assert [r["id"] for r in inbox["overruns"]] == [run["id"]]
    # Ticking a paused run does nothing more.
    await tick(client, auth)
    assert (await get(client, auth, run["id"]))["status"] == "paused_overrun"

    denied = await client.post(f"/v1/runs/{run['id']}/resume", headers=approver)
    assert denied.status_code == 403
    resp = await client.post(f"/v1/runs/{run['id']}/resume", headers=auth)
    assert resp.status_code == 200, resp.text
    run = resp.json()
    # Resuming accepts the spend so far plus half the estimate.
    assert run["overrun_ceiling_usd"] == pytest.approx(50 + 26.5 * 0.5)
    assert run["status"] == "awaiting_checkpoint" and run["waiting_on"] == "baseline_confirm"


async def test_overrun_owner_cancels(client, owner, runtime):
    _, auth = owner
    runtime.script["baseline"] = [Outcome(cost_usd=Decimal(50), polls=2)]
    run = await started(client, auth)
    # Ceiling 39.75: two polls at 25 keep it running, the end at 50 pauses it.
    await tick(client, auth)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "running"
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "paused_overrun"
    resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=auth)
    assert resp.json()["status"] == "cancelled"


# --------------------------------------------------------------------------- cancel


async def test_cancel_a_running_run(client, owner, runtime):
    tenant_id, auth = owner
    other_approver = await as_user(tenant_id, "approver")
    runtime.script["baseline"] = [Outcome(polls=5)]
    run = await started(client, auth)
    workflow_id = run["segments"][0]["workflow_id"]

    denied = await client.post(f"/v1/runs/{run['id']}/cancel", headers=other_approver)
    assert denied.status_code == 403

    resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=auth)
    assert resp.status_code == 200
    run = resp.json()
    assert run["status"] == "cancelled" and run["finished_at"]
    assert [s["status"] for s in run["segments"]] == ["cancelled"] * 4
    assert runtime.cancelled == [workflow_id]
    assert await verify_run_token(runtime.submitted[0].mcp.token) is None
    assert (await client.post(f"/v1/runs/{run['id']}/cancel", headers=auth)).status_code == 409
    assert (await tick(client, auth))["runs_checked"] == 0


async def test_creator_approver_cancels_own_run_and_pending_checkpoint_is_skipped(
    client, owner, runtime
):
    tenant_id, auth = owner
    approver = await as_user(tenant_id, "approver")
    run = await started(client, approver)
    await tick(client, auth)
    resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=approver)
    assert resp.status_code == 200
    run = resp.json()
    assert run["checkpoints"][0]["status"] == "skipped"
    assert run["checkpoints"][0]["note"] == "Run cancelled."


async def test_cancel_a_draft(client, owner, runtime):
    _, auth = owner
    run = await create(client, auth)
    resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=auth)
    assert resp.json()["status"] == "cancelled"


# --------------------------------------------------------------------------- cost data


async def test_runs_api_keeps_every_cost_field(client, owner, runtime):
    """P3d Cost prominence: the web shows cost only in details and decisions; the API keeps all."""
    _, auth = owner
    run = await started(client, auth)
    await tick(client, auth)

    run = await get(client, auth, run["id"])
    first = run["segments"][0]
    assert run["estimate_usd"] == 26.5
    assert sum(s["estimate_usd"] for s in run["segments"]) == pytest.approx(26.5)
    assert run["overrun_ceiling_usd"] == pytest.approx(39.75)
    assert all("cost_usd" in s for s in run["segments"])
    assert first["cost_usd"] == pytest.approx(first["estimate_usd"] * 0.9)
    assert first["attempts"][0]["cost_usd"] == pytest.approx(first["cost_usd"])
    assert run["spent_usd"] == pytest.approx(first["cost_usd"])

    listed = await client.get("/v1/runs", headers=auth)
    assert listed.status_code == 200, listed.text
    row = next(r for r in listed.json() if r["id"] == run["id"])
    assert row["estimate_usd"] == 26.5
    assert row["spent_usd"] == pytest.approx(run["spent_usd"])


# --------------------------------------------------------------------------- checkpoints


async def test_changes_requested_reruns_the_segment_with_the_note(client, owner, runtime):
    tenant_id, auth = owner
    runtime.script["baseline"] = [Outcome(cost_usd=Decimal(3)), Outcome(cost_usd=Decimal(4))]
    run = await started(client, auth)
    await tick(client, auth)
    run = await get(client, auth, run["id"])

    cp = pending(run)
    missing_note = await client.post(
        f"/v1/runs/{run['id']}/checkpoints/{cp['id']}/decide",
        json={"decision": "changes_requested"},
        headers=auth,
    )
    assert missing_note.status_code == 422

    run = await decide(client, auth, run, "changes_requested", "Goal G2 needs a target")
    assert run["status"] == "running"
    seg = run["segments"][0]
    assert seg["status"] == "running" and len(seg["attempts"]) == 2
    assert seg["attempts"][1]["note"] == "Goal G2 needs a target"
    assert "Goal G2 needs a target" in runtime.submitted[1].steps[0].prompt
    assert runtime.submitted[1].labels["attempt"] == "2"

    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert [(c["kind"], c["status"]) for c in run["checkpoints"]] == [
        ("baseline_confirm", "changes_requested"),
        ("baseline_confirm", "pending"),
    ]
    assert pending(run)["payload"]["attempt"] == 2
    assert run["segments"][0]["cost_usd"] == 7.0
    assert run["spent_usd"] == 7.0
    assert run["segments"][1]["status"] == "pending"

    # Deciding twice is refused.
    old = run["checkpoints"][0]
    again = await client.post(
        f"/v1/runs/{run['id']}/checkpoints/{old['id']}/decide",
        json={"decision": "approved"},
        headers=auth,
    )
    assert again.status_code == 409


async def test_checkpoint_roles(client, owner, runtime):
    tenant_id, auth = owner
    commenter = await as_user(tenant_id, "commenter")
    approver = await as_user(tenant_id, "approver")
    run = await started(client, auth)
    await tick(client, auth)
    run = await get(client, commenter, run["id"])
    cp = pending(run)
    assert cp["can_decide"] is False
    resp = await client.post(
        f"/v1/runs/{run['id']}/checkpoints/{cp['id']}/decide",
        json={"decision": "approved"},
        headers=commenter,
    )
    assert resp.status_code == 403
    assert (await client.get("/v1/inbox", headers=commenter)).json()["checkpoints"] == []

    inbox = (await client.get("/v1/inbox", headers=approver)).json()
    assert [c["id"] for c in inbox["checkpoints"]] == [cp["id"]]
    assert inbox["checkpoints"][0]["segment_title"] == "Baseline proposal"
    run = await decide(client, approver, await get(client, approver, run["id"]))
    assert run["checkpoints"][0]["status"] == "approved"


async def test_flow_named_role_is_enforced(client, owner, runtime):
    _, auth = owner
    run = await started(client, auth)
    await tick(client, auth)
    # A flow may name a higher role for a stop; the checkpoint row carries it.
    async with tenant_session(owner[0]) as s:
        cp = await s.scalar(select(Checkpoint))
        cp.approver_role = "owner"
        await s.commit()
    approver = await as_user(owner[0], "approver")
    run = await get(client, approver, run["id"])
    resp = await client.post(
        f"/v1/runs/{run['id']}/checkpoints/{pending(run)['id']}/decide",
        json={"decision": "approved"},
        headers=approver,
    )
    assert resp.status_code == 403
    assert (await client.get("/v1/inbox", headers=approver)).json()["checkpoints"] == []


# --------------------------------------------------------------------------- roles


async def test_role_checks(client, owner, runtime):
    tenant_id, auth = owner
    viewer = await as_user(tenant_id, "viewer")
    commenter = await as_user(tenant_id, "commenter")
    approver = await as_user(tenant_id, "approver")

    body = {"flow": "baseline_to_prd", "document": "example-prd"}
    for headers in (viewer, commenter):
        assert (await client.post("/v1/runs", json=body, headers=headers)).status_code == 403
    run = await create(client, approver)
    for path in ("estimate", "start", "cancel"):
        resp = await client.post(f"/v1/runs/{run['id']}/{path}", headers=viewer)
        assert resp.status_code == 403, path
    assert (await client.get(f"/v1/runs/{run['id']}", headers=viewer)).status_code == 200
    assert (await client.get("/v1/runs", headers=viewer)).status_code == 200

    # The tick: an owner or an API token, not an approver.
    assert (await client.post("/v1/internal/tick", headers=approver)).status_code == 403
    owner_user = await as_user(tenant_id, "owner")
    assert (await client.post("/v1/internal/tick", headers=owner_user)).status_code == 200
    assert (await client.post("/v1/internal/tick", headers=auth)).status_code == 200


async def test_runs_are_tenant_scoped(client, owner, runtime):
    _, auth = owner
    run = await create(client, auth)
    from tests.conftest import make_tenant

    other = await make_tenant("Other Co")
    stranger = await as_user(other, "owner")
    assert (await client.get(f"/v1/runs/{run['id']}", headers=stranger)).status_code == 404
    assert (await client.get("/v1/runs", headers=stranger)).json() == []


# --------------------------------------------------------------------------- validation


async def test_knob_and_document_validation(client, owner, runtime):
    _, auth = owner
    cases = [
        {"flow": "baseline_to_prd", "document": "x", "knobs": {"roles": {"baseline": ["ghost"]}}},
        {"flow": "baseline_to_prd", "document": "x", "knobs": {"roles": {"nope": ["writer"]}}},
        {"flow": "baseline_to_prd", "document": "x", "knobs": {"roles": {"baseline": []}}},
        {"flow": "baseline_to_prd", "document": "x", "knobs": {"checkpoints": {"eng_review": 1}}},
        {"flow": "baseline_to_prd", "document": "x", "knobs": {"depth": "extreme"}},
        {"flow": "baseline_to_prd"},
        {"flow": "feedback_loop", "document": "missing-doc"},
        {"flow": "feedback_loop"},
        {"flow": "baseline_to_prd", "document": str(uuid.uuid4())},
    ]
    for body in cases:
        resp = await client.post("/v1/runs", json=body, headers=auth)
        assert resp.status_code == 422, (body, resp.text)


async def test_patch_a_draft_clears_its_estimate(client, owner, runtime):
    _, auth = owner
    run = await create(client, auth)
    await client.post(f"/v1/runs/{run['id']}/estimate", headers=auth)
    resp = await client.patch(
        f"/v1/runs/{run['id']}",
        json={"knobs": {"depth": "quick"}, "document": "renamed-prd"},
        headers=auth,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["estimate_usd"] is None
    assert body["knobs"]["depth"] == "quick"
    assert body["document_slug"] == "renamed-prd"
    est = (await client.post(f"/v1/runs/{run['id']}/estimate", headers=auth)).json()
    assert est["total_usd"] == 13.25
    await client.post(f"/v1/runs/{run['id']}/start", headers=auth)
    resp = await client.patch(f"/v1/runs/{run['id']}", json={}, headers=auth)
    assert resp.status_code == 409


# --------------------------------------------------------------------------- drafts


async def test_feedback_loop_imports_the_next_version(client, owner, runtime):
    tenant_id, auth = owner
    assert (await import_draft(client, auth, draft("prd_v1.md"))).status_code == 201
    async with tenant_session(tenant_id) as s:
        doc = await s.scalar(select(Document))
        s.add(
            FeedbackItem(
                document_id=doc.id,
                raised_on_version=1,
                kind="general",
                summary="Add a guardrail metric",
            )
        )
        await s.commit()

    run = await started(client, auth, flow="feedback_loop", document="checkout-redesign")
    assert run["document_slug"] == "checkout-redesign"
    assert run["estimate_usd"] == 9.0
    prompt = runtime.submitted[0].steps[-1].prompt
    assert "Add a guardrail metric" in prompt
    assert "get_feedback_package" in prompt

    inbox = (await client.get("/v1/inbox", headers=auth)).json()
    assert inbox["feedback"][0]["slug"] == "checkout-redesign"
    assert inbox["feedback"][0]["open_count"] == 1

    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "awaiting_checkpoint" and run["waiting_on"] == "prd_review"
    imp = run["segments"][0]["draft_import"]
    assert imp["version"] == 2 and imp["slug"] == "checkout-redesign"
    assert pending(run)["payload"]["import"]["version"] == 2
    async with tenant_session(tenant_id) as s:
        v2 = await s.scalar(select(DocumentVersion).where(DocumentVersion.number == 2))
        assert "Draft 1 written by the local agent runtime" in v2.markdown
        # Imported as the run's creator: here the seeded API token.
        assert str(v2.imported_by) == run["created_by"]
    run = await decide(client, auth, run)
    assert run["status"] == "succeeded"


async def test_inbox_feedback_says_what_waits_and_where_the_first_item_is(client, owner):
    from datetime import UTC, datetime, timedelta

    from oracle.jobs.models import LlmSuggestion

    tenant_id, auth = owner
    assert (await import_draft(client, auth, draft("prd_v1.md"))).status_code == 201
    t0 = datetime(2026, 10, 19, 9, 0, tzinfo=UTC)
    async with tenant_session(tenant_id) as s:
        doc = await s.scalar(select(Document))

        def item(key, minutes, kind="general", status="open"):
            f = FeedbackItem(
                document_id=doc.id,
                raised_on_version=1,
                kind=kind,
                section_key=key,
                summary=f"About {key}",
                status=status,
                created_at=t0 + timedelta(minutes=minutes),
            )
            s.add(f)
            return f

        later, first, third = item("metrics", 5), item("problem", 1), item("goal", 9)
        accepted = item("solution", 12)
        item("solution", 14, kind="comment")
        item(None, 0)  # open, no section: counted, never the first link
        item("problem", -5, status="addressed")  # closed: not in the inbox
        await s.flush()
        decided = [(later, "open"), (first, "open"), (third, "open"), (accepted, "accepted")]
        for f, status in decided:
            s.add(
                LlmSuggestion(
                    document_id=doc.id,
                    feedback_item_id=f.id,
                    version_number=1,
                    classification="change_request",
                    kind="section_text",
                    section_key=f.section_key,
                    text="New text",
                    status=status,
                )
            )
        await s.commit()

    inbox = (await client.get("/v1/inbox", headers=auth)).json()
    row = inbox["feedback"][0]
    # C1e: the accepted section-text suggestion is staged for the next draft, so its item
    # is not open feedback; it is in the document's staged row instead.
    assert row["open_count"] == 5
    counts = {"suggestions": 3, "accepted": 0, "comments": 1, "verdicts": 0, "other": 1}
    assert row["counts"] == counts
    assert row["first_section_key"] == "problem"
    by_key = {(i["section_key"], i["kind"]): i for i in row["items"]}
    assert by_key[("metrics", "general")]["suggestion_status"] == "open"
    assert by_key[("solution", "comment")]["suggestion_status"] is None
    assert [r["count"] for r in inbox["staged"]] == [1]


async def test_a_rejected_draft_waits_at_review_and_reruns(client, owner, runtime):
    tenant_id, auth = owner
    runtime.script["prd_draft"] = [Outcome(artifacts={"prd.md": BAD_PRD})]
    off = {"baseline_confirm": False, "feature_set": False, "priority_order": False}
    run = await started(client, auth, checkpoints=off)
    for _ in range(4):
        await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "awaiting_checkpoint"
    imp = run["segments"][3]["draft_import"]
    assert "rejected" in imp["error"] and imp["version"] is None
    run = await decide(client, auth, run, "changes_requested", "Add the front matter")
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["segments"][3]["draft_import"]["version"] == 1


async def test_a_rejected_draft_with_review_off_fails_the_run(client, owner, runtime):
    _, auth = owner
    runtime.script["prd_draft"] = [Outcome(artifacts={"prd.md": BAD_PRD})]
    off = dict.fromkeys(flows.FLOWS["baseline_to_prd"].checkpoints, False)
    run = await started(client, auth, checkpoints=off)
    for _ in range(4):
        await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "failed"
    assert "rejected" in run["error"]


async def test_a_failed_segment_fails_the_run(client, owner, runtime):
    tenant_id, auth = owner
    runtime.script["baseline"] = [Outcome(state="failed", error="agent crashed")]
    run = await started(client, auth)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "failed"
    assert run["segments"][0]["status"] == "failed"
    assert "agent crashed" in run["error"]
    async with tenant_session(tenant_id) as s:
        assert all(t.revoked_at for t in await s.scalars(select(RunToken)))


async def test_submit_failure_is_retried_by_the_next_tick(client, owner, runtime):
    from oracle.swarm import RuntimeUnavailable

    _, auth = owner
    real_submit = runtime.submit
    calls = {"n": 0}

    async def flaky(spec):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeUnavailable("SwarmCloud is down")
        return await real_submit(spec)

    runtime.submit = flaky
    run = await started(client, auth)
    assert run["status"] == "running"
    assert run["segments"][0]["status"] == "pending"
    assert "down" in run["segments"][0]["error"]
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["segments"][0]["status"] == "running"


async def test_rows_written(client, owner, runtime):
    tenant_id, auth = owner
    run = await started(client, auth)
    async with tenant_session(tenant_id) as s:
        row = await s.get(Run, uuid.UUID(run["id"]))
        assert row.knobs["spend_ceiling_usd"] == "39.7500"
        segs = list(await s.scalars(select(RunSegment).order_by(RunSegment.seq)))
        assert [s_.estimate_usd for s_ in segs] == [
            Decimal("7.00"),
            Decimal("8.00"),
            Decimal("2.50"),
            Decimal("9.00"),
        ]


LANE_E_ROUTES = [
    ("GET", "/v1/flows"),
    ("GET", "/v1/runs"),
    ("POST", "/v1/runs"),
    ("GET", "/v1/runs/{id}"),
    ("PATCH", "/v1/runs/{id}"),
    ("POST", "/v1/runs/{id}/estimate"),
    ("POST", "/v1/runs/{id}/start"),
    ("POST", "/v1/runs/{id}/approve"),
    ("POST", "/v1/runs/{id}/resume"),
    ("POST", "/v1/runs/{id}/cancel"),
    ("POST", "/v1/runs/{id}/checkpoints/{id}/decide"),
    ("GET", "/v1/runs/{id}/segments/1/artifacts/prd.md"),
    ("GET", "/v1/inbox"),
    ("POST", "/v1/internal/tick"),
]


@pytest.mark.parametrize(("method", "path"), LANE_E_ROUTES)
async def test_lane_e_routes_require_auth(client, method, path):
    resp = await client.request(method, path.replace("{id}", str(uuid.uuid4())), json={})
    assert resp.status_code == 401


async def test_inbox_for_a_viewer_is_empty(client, owner, runtime):
    tenant_id, auth = owner
    viewer = await as_user(tenant_id, "viewer")
    assert (await import_draft(client, auth, draft("prd_v1.md"))).status_code == 201
    async with tenant_session(tenant_id) as s:
        doc = await s.scalar(select(Document))
        s.add(FeedbackItem(document_id=doc.id, raised_on_version=1, kind="general", summary="x"))
        await s.commit()
    run = await started(client, auth, depth="deep")  # awaiting approval
    assert run["status"] == "awaiting_approval"
    inbox = (await client.get("/v1/inbox", headers=viewer)).json()
    assert {
        k: inbox[k]
        for k in (
            "checkpoints",
            "approvals",
            "overruns",
            "lookups",
            "searches",
            "imports",
            "feedback",
            "revoke_failures",
            "total",
        )
    } == {
        "checkpoints": [],
        "approvals": [],
        "overruns": [],
        "lookups": [],
        "searches": [],
        "imports": [],
        "feedback": [],
        "revoke_failures": [],
        "total": 0,
    }
    # No feedback states for a viewer either (C1e).
    assert (inbox["items"], inbox["staged"], inbox["needs_me"]) == ([], [], 0)
    assert (await client.get("/v1/inbox", headers=auth)).json()["total"] == 2


async def test_a_refused_rerun_keeps_the_reviewers_note(client, owner, runtime):
    from oracle.swarm import RuntimeUnavailable

    _, auth = owner
    run = await started(client, auth)
    await tick(client, auth)
    real_submit = runtime.submit

    async def down(spec):
        raise RuntimeUnavailable("SwarmCloud is down")

    runtime.submit = down
    run = await decide(
        client, auth, await get(client, auth, run["id"]), "changes_requested", "Cite G1"
    )
    assert run["segments"][0]["status"] == "pending"
    runtime.submit = real_submit
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["segments"][0]["status"] == "running"
    assert run["segments"][0]["attempts"][-1]["note"] == "Cite G1"
    assert "Cite G1" in runtime.submitted[-1].steps[0].prompt


# --------------------------------------------------------------------------- baseline.yaml

RUN_BASELINE = """\
version: 1
entities:
  - type: goal
    key: activation
    title: Raise activation
    status: confirmed
    attrs: {metric: activated accounts, target: "40%", horizon: short, weight: 3}
  - type: feature
    key: guided-setup
    title: Guided setup
    evidence:
      - url: https://notes.example.com/interviews
        excerpt: New accounts stall on the first screen.
  - type: feature
    key: checkout
    title: Checkout, as the agent sees it
edges:
  - src: feature:guided-setup
    dst: goal:activation
    type: supports
    attrs: {contribution: 3}
"""


async def test_baseline_yaml_is_merged_through_the_import(client, owner, runtime):
    tenant_id, auth = owner
    # A person's locked feature: the run may not change it, only propose.
    resp = await client.post(
        "/v1/baseline/entities",
        json={"type": "feature", "key": "checkout", "title": "Checkout"},
        headers=auth,
    )
    assert resp.status_code == 201, resp.text
    runtime.script["baseline"] = [
        Outcome(artifacts={"baseline.yaml": RUN_BASELINE, "summary.md": "# Summary\n"})
    ]
    run = await started(client, auth)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "awaiting_checkpoint" and run["waiting_on"] == "baseline_confirm"
    merged = pending(run)["payload"]["baseline_import"]
    assert merged["created"] == 3  # the goal, guided-setup and the supports edge
    assert merged["proposals"] == 1  # the locked checkout
    assert merged["evidence_added"] == 1
    assert any(n["code"] == "goal_needs_confirmation" for n in merged["notes"])

    graph = (await client.get("/v1/baseline/graph", headers=auth)).json()
    by_key = {e["key"]: e for e in graph["entities"]}
    assert by_key["checkout"]["title"] == "Checkout"  # locked: unchanged
    assert by_key["guided-setup"]["origin"] == "agent"
    assert by_key["guided-setup"]["run_id"] == run["id"]
    assert by_key["activation"]["status"] == "proposed"  # goals are confirmed by people
    assert len(graph["edges"]) == 1
    proposals = (await client.get("/v1/baseline/proposals", headers=auth)).json()
    assert [(p["payload"]["fields"].get("title"), p["run_id"]) for p in proposals] == [
        ("Checkout, as the agent sees it", run["id"])
    ]

    # Approving the checkpoint moves on; the import is not repeated.
    run = await decide(client, auth, run)
    assert run["status"] == "running"
    proposals = (await client.get("/v1/baseline/proposals", headers=auth)).json()
    assert len(proposals) == 1


async def test_a_rejected_baseline_yaml_with_review_off_fails_the_run(client, owner, runtime):
    _, auth = owner
    runtime.script["baseline"] = [Outcome(artifacts={"baseline.yaml": "entities: [{type: x}]"})]
    off = dict.fromkeys(flows.FLOWS["baseline_to_prd"].checkpoints, False)
    run = await started(client, auth, checkpoints=off)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "failed"
    assert run["error"].startswith("baseline.yaml was rejected: [invalid_type]")
    graph = (await client.get("/v1/baseline/graph", headers=auth)).json()
    assert graph["entities"] == []


async def test_the_runs_list_carries_each_runs_progress(client, owner, runtime):
    """Home's In flight reads segments done and what comes next from the list, no call per run."""
    _, auth = owner
    first = await started(client, auth)
    second = await started(client, auth)
    await tick(client, auth)  # each run's first segment done, waiting on its checkpoint
    listed = {r["id"]: r for r in (await client.get("/v1/runs", headers=auth)).json()}
    for run_id in (first["id"], second["id"]):
        run = await get(client, auth, run_id)
        progress = listed[run_id]["progress"]
        assert progress == {"done": 1, "total": 4, "now": run["segments"][1]["title"]}
        assert run["progress"] == progress
    run = await decide(client, auth, await get(client, auth, first["id"]))
    listed = {r["id"]: r for r in (await client.get("/v1/runs", headers=auth)).json()}
    assert listed[first["id"]]["progress"]["now"] == run["segments"][1]["title"]
    assert run["segments"][1]["status"] == "running"
    # The inbox embeds summaries without it.
    inbox = (await client.get("/v1/inbox", headers=auth)).json()
    assert all(r["progress"] is None for r in inbox["approvals"] + inbox["overruns"])


async def test_the_runs_list_carries_progress_with_what_the_inbox_says_of_a_stuck_run(
    client, owner, runtime
):
    """Home round 2's progress and adapter v2's stuck and import-failed fields, side by side
    in one list: the Inbox counts the run in both groups, as the badge does."""
    tenant_id, auth = owner
    run = await started(client, auth)
    await tick(client, auth)
    async with tenant_session(tenant_id) as s:
        row = await s.get(Run, uuid.UUID(run["id"]))
        row.status = "running"
        row.knobs = {
            **row.knobs,
            "stuck_lookup": {"label": "seg-1-a2"},
            "import_failed": {"error": "DataError", "count": 5},
        }
        await s.commit()
    listed = {r["id"]: r for r in (await client.get("/v1/runs", headers=auth)).json()}
    summary = listed[run["id"]]
    assert summary["progress"] == {"done": 1, "total": 4, "now": run["segments"][1]["title"]}
    assert summary["stuck"].startswith("Submission seg-1-a2 was lost")
    assert summary["can_retry"] is True
    assert "DataError on 5 tries" in summary["import_failed"]
    assert summary["can_retry_import"] is True
    inbox = (await client.get("/v1/inbox", headers=auth)).json()
    assert [r["id"] for r in inbox["lookups"]] == [run["id"]]
    assert [r["id"] for r in inbox["imports"]] == [run["id"]]
    assert all(r["progress"] is None for r in inbox["lookups"] + inbox["imports"])
    assert inbox["total"] == len(inbox["checkpoints"]) + len(inbox["approvals"]) + len(
        inbox["overruns"]
    ) + 2 + len(inbox["feedback"])


async def test_run_counts_its_open_proposals(client, owner, runtime):
    """protects: the run page's "Baseline proposals: N open" line (B3).
    fails_when: open_proposals counts decided proposals, another run's or a person's, or
    does not drop when one is accepted.
    no_claim: proposals made through the REST route, not by a run's merge."""
    tenant_id, auth = owner
    run = await create(client, auth)
    other = await create(client, auth, document="other-prd")
    assert (await get(client, auth, run["id"]))["open_proposals"] == 0
    commenter = await as_user(tenant_id, "commenter")
    made = []
    for key, run_id in (("a", run["id"]), ("b", run["id"]), ("c", other["id"]), ("d", None)):
        body = {"op": "create", "kind": "entity", "fields": {"type": "goal", "key": key}}
        body["fields"]["title"] = key.upper()
        if run_id:
            body["run_id"] = run_id
        resp = await client.post("/v1/baseline/proposals", json=body, headers=commenter)
        assert resp.status_code == 201, resp.text
        made.append(resp.json())
    assert (await get(client, auth, run["id"]))["open_proposals"] == 2
    resp = await client.post(f"/v1/baseline/proposals/{made[0]['id']}/accept", headers=auth)
    assert resp.status_code == 200, resp.text
    assert (await get(client, auth, run["id"]))["open_proposals"] == 1
    assert (await get(client, auth, other["id"]))["open_proposals"] == 1
