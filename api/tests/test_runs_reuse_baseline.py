"""C4 "Use the current baseline" (decided 2026-10-21, B1 Build baseline "Reuse base"):
GET /v1/baseline/review-status, the ``reuse_baseline`` knob, the reused baseline segment
in the estimate and at start (segment and workflow mode), the 409 and the regression.

Test card (test_reuse_baseline, every test below): protects=B1 "Reuse base" (a run skips
its baseline segment only on a review approved in the past 30 days with no build under
way); fails_when=a stale or missing review is reused, a reused run submits or charges the
baseline step, or a plain API run stops rebuilding; no_claim=the feature set's quality on
an older baseline, or how the web draws the choice.

Runs against Postgres with the FakeRuntime (segment mode) or the fake SwarmCloud API
(workflow mode). The reviews and builds are seeded rows. Synthetic placeholders only.
"""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from oracle import company_time
from oracle.main import app
from oracle.mcp.scopes import required_scope
from oracle.mcp.tools import app_operations
from oracle.models import AuditEvent
from oracle.runs.models import Checkpoint, Run
from oracle.swarm import FakeRuntime, set_runtime
from oracle.swarm.settings import get_runtime_settings
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.intake_helpers import intake_with_source
from tests.swarmcloud_fake import FakeSwarmCloud

STATUS = "/v1/baseline/review-status"


@pytest.fixture
def runtime():
    fake = FakeRuntime()
    set_runtime(fake)
    yield fake
    set_runtime(None)


async def review(ctx, days_ago: float, flow: str = "baseline") -> tuple[uuid.UUID, datetime]:
    """A finished run whose Confirm the baseline was approved ``days_ago`` days ago."""
    at = datetime.now(UTC) - timedelta(days=days_ago)
    async with tenant_session(ctx.tenant_id) as s:
        run = Run(flow=flow, status="succeeded", knobs={})
        s.add(run)
        await s.flush()
        cp = Checkpoint(
            run_id=run.id,
            kind="baseline_confirm",
            status="approved",
            approver_role="approver",
            decided_at=at,
        )
        s.add(cp)
        await s.commit()
        return cp.id, at


async def build(
    ctx, flow: str, status: str, checkpoint: str | None = None, knobs: dict | None = None
) -> uuid.UUID:
    async with tenant_session(ctx.tenant_id) as s:
        run = Run(flow=flow, status=status, knobs=knobs or {})
        s.add(run)
        await s.flush()
        if checkpoint:
            s.add(
                Checkpoint(
                    run_id=run.id,
                    kind="baseline_confirm",
                    status=checkpoint,
                    approver_role="approver",
                )
            )
        await s.commit()
        return run.id


async def status_of(client, ctx, who: str = "viewer") -> dict:
    resp = await client.get(STATUS, headers=ctx.as_(who))
    assert resp.status_code == 200, resp.text
    return resp.json()


def oct_date(at: datetime) -> str:
    """The Company day (America/Los_Angeles by default), #463."""
    return company_time.day_in_words(at)


async def plain_run(client, ctx, **knobs) -> dict:
    resp = await client.post(
        "/v1/runs",
        json={"flow": "baseline_to_prd", "document": "saved-addresses", "knobs": knobs},
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


async def estimate(client, ctx, run_id: str, expect: int = 200) -> dict:
    resp = await client.post(f"/v1/runs/{run_id}/estimate", headers=ctx.as_("owner"))
    assert resp.status_code == expect, resp.text
    return resp.json()


async def start(client, ctx, run_id: str, expect: int = 200) -> dict:
    resp = await client.post(f"/v1/runs/{run_id}/start", headers=ctx.as_("owner"))
    assert resp.status_code == expect, resp.text
    return resp.json()


# --------------------------------------------------------------------------- 8a status


async def test_a_review_approved_29_days_ago_is_reusable(client):
    ctx = await make_ctx()
    cp_id, at = await review(ctx, 29)
    # A draft Baseline to PRD run has not started: it builds nothing.
    await build(ctx, "baseline_to_prd", "draft")
    out = await status_of(client, ctx)
    assert out["reusable"] is True and out["reason"] is None
    assert out["checkpoint_id"] == str(cp_id)
    assert out["age_days"] == 29
    assert out["build_under_way"] is False
    assert out["run_id"]
    assert datetime.fromisoformat(out["last_approved_at"]) == at
    assert out["baseline_segment_usd"] == {"quick": 3.5, "standard": 7.0, "deep": 14.0}


async def test_a_review_approved_31_days_ago_is_too_old(client):
    ctx = await make_ctx()
    await review(ctx, 31, flow="baseline_to_prd")
    out = await status_of(client, ctx)
    assert out["reusable"] is False and out["reason"] == "too_old"
    assert out["age_days"] == 31


async def test_no_approved_review_is_never_reviewed(client):
    ctx = await make_ctx()
    # A run with its stop off leaves no review.
    await build(ctx, "baseline", "succeeded", checkpoint="skipped")
    out = await status_of(client, ctx)
    assert out["reusable"] is False and out["reason"] == "never_reviewed"
    assert out["last_approved_at"] is None and out["checkpoint_id"] is None
    assert out["age_days"] is None


async def test_a_running_baseline_build_is_under_way(client):
    ctx = await make_ctx()
    await review(ctx, 2)
    await build(ctx, "baseline", "running")
    out = await status_of(client, ctx)
    assert out["reusable"] is False and out["reason"] == "build_under_way"
    assert out["build_under_way"] is True


async def test_a_prd_run_waiting_at_confirm_the_baseline_is_under_way(client):
    ctx = await make_ctx()
    await review(ctx, 2)
    await build(ctx, "baseline_to_prd", "awaiting_checkpoint", checkpoint="pending")
    assert (await status_of(client, ctx))["reason"] == "build_under_way"


async def test_a_prd_run_past_its_baseline_is_not_a_build(client):
    ctx = await make_ctx()
    await review(ctx, 2)
    await build(ctx, "baseline_to_prd", "awaiting_checkpoint", checkpoint="skipped")
    assert (await status_of(client, ctx))["reusable"] is True


async def test_a_prd_run_awaiting_approval_that_reuses_is_not_a_build(client):
    """A run waiting for an owner's cost approval has no checkpoint yet: it counts as a
    build under way only when it builds the baseline itself."""
    ctx = await make_ctx()
    cp_id, at = await review(ctx, 2)
    knob = {"checkpoint_id": str(cp_id), "approved_at": at.isoformat()}
    await build(ctx, "baseline_to_prd", "awaiting_approval", knobs={"reuse_baseline": knob})
    out = await status_of(client, ctx)
    assert out["reusable"] is True and out["build_under_way"] is False


async def test_a_prd_run_awaiting_approval_that_rebuilds_is_under_way(client):
    ctx = await make_ctx()
    await review(ctx, 2)
    await build(ctx, "baseline_to_prd", "awaiting_approval")
    assert (await status_of(client, ctx))["reason"] == "build_under_way"


async def test_review_status_is_an_mcp_read_refused_to_run_tokens(client):
    ops = {(o.method, o.path): o for o in app_operations(app)}
    op = ops[("GET", STATUS)]
    assert not op.excluded and op.tool_name == "get_baseline_review_status"
    assert required_scope("GET", STATUS) is None
    # Anyone signed in reads it.
    resp = await client.get(STATUS)
    assert resp.status_code == 401


# --------------------------------------------------------------------------- 8b reuse


async def test_an_intake_run_reuses_a_reusable_baseline(client, runtime):
    ctx = await make_ctx()
    cp_id, at = await review(ctx, 9)
    out = await intake_with_source(client, ctx)
    resp = await client.post(
        f"/v1/intakes/{out['intake']['id']}/runs",
        json={"document": "saved-addresses", "reuse_baseline": None},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 201, resp.text
    run = resp.json()
    async with tenant_session(ctx.tenant_id) as s:
        knob = (await s.get(Run, uuid.UUID(run["id"]))).knobs["reuse_baseline"]
    assert knob["checkpoint_id"] == str(cp_id)
    assert datetime.fromisoformat(knob["approved_at"]) == at
    assert run["knobs"]["reuse_baseline"]["checkpoint_id"] == str(cp_id)

    est = await estimate(client, ctx, run["id"])
    rows = {r["name"]: r for r in est["segments"]}
    assert rows["baseline"]["estimate_usd"] == 0.0
    assert rows["baseline"]["reused"] is True
    assert rows["baseline"]["note"] == f"Current baseline, approved {oct_date(at)}"
    assert rows["feature_set"]["reused"] is False and rows["feature_set"]["note"] is None
    rebuilt = await estimate(
        client, ctx, (await plain_run(client, ctx, reuse_baseline=False))["id"]
    )
    assert rebuilt["total_usd"] - est["total_usd"] == pytest.approx(7.0)
    assert est["total_usd"] == pytest.approx(24.5)

    started = await start(client, ctx, run["id"])
    assert started["status"] == "running"
    seg = started["segments"]
    assert seg[0]["name"] == "baseline" and seg[0]["status"] == "skipped"
    assert seg[0]["cost_usd"] == 0 and seg[0]["estimate_usd"] == 0
    assert seg[0]["note"] == f"Reused the baseline approved {oct_date(at)}"
    assert seg[0]["reused"]["checkpoint_id"] == str(cp_id)
    assert seg[1]["name"] == "feature_set" and seg[1]["status"] == "running"
    [cp] = started["checkpoints"]
    assert cp["kind"] == "baseline_confirm" and cp["status"] == "skipped"
    # Nothing was submitted for the baseline: the one submission is the feature set's.
    [spec] = runtime.submitted
    assert spec.labels["segment"] == "feature_set"
    prompt = spec.steps[0].prompt
    assert (
        f"The baseline was reviewed and approved on {oct_date(at)}; read it with get_baseline"
        in prompt
    )
    async with tenant_session(ctx.tenant_id) as s:
        event = await s.scalar(select(AuditEvent).where(AuditEvent.action == "run.baseline_reused"))
    assert event is not None and event.data["checkpoint_id"] == str(cp_id)
    assert str(event.entity_id) == run["id"]


async def test_an_intake_run_rebuilds_when_the_baseline_is_not_reusable(client, runtime):
    ctx = await make_ctx()
    await review(ctx, 40)
    out = await intake_with_source(client, ctx)
    resp = await client.post(
        f"/v1/intakes/{out['intake']['id']}/runs",
        json={"document": "saved-addresses"},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 201, resp.text
    run = resp.json()
    assert run["knobs"].get("reuse_baseline") is None
    est = await estimate(client, ctx, run["id"])
    assert est["total_usd"] == pytest.approx(31.5)


@pytest.fixture
def workflow_settings(monkeypatch):
    monkeypatch.setenv("ORACLE_PUBLIC_URL", "https://oracle.example.com")
    get_runtime_settings.cache_clear()
    yield
    get_runtime_settings.cache_clear()
    set_runtime(None)


async def test_workflow_mode_submits_no_baseline_step(client, workflow_settings):
    ctx = await make_ctx()
    await review(ctx, 3)
    swarm = FakeSwarmCloud(mcp=True, await_input=True, service_answer=True)
    set_runtime(swarm.runtime())
    run = await plain_run(client, ctx, reuse_baseline=True)
    await estimate(client, ctx, run["id"])
    started = await start(client, ctx, run["id"])
    assert started["segments"][0]["status"] == "skipped"
    assert started["segments"][1]["status"] == "running"
    [sub] = swarm.submissions()
    ids = [s["step_id"] for s in sub["steps"]]
    assert ids[0].startswith("feature_set-")
    assert not any(i.startswith("baseline-") for i in ids)
    assert "baseline-review1" not in ids


# --------------------------------------------------------------------------- 8c


async def test_start_refuses_when_a_build_started_after_the_estimate(client, runtime):
    ctx = await make_ctx()
    await review(ctx, 3)
    run = await plain_run(client, ctx, reuse_baseline=True)
    await estimate(client, ctx, run["id"])
    await build(ctx, "baseline", "running")
    refused = await start(client, ctx, run["id"], expect=409)
    assert refused["detail"] == {"code": "baseline_not_reusable", "reason": "build_under_way"}
    after = (await client.get(f"/v1/runs/{run['id']}", headers=ctx.as_("owner"))).json()
    assert after["status"] == "draft"
    assert [s["status"] for s in after["segments"]] == ["pending"] * 5
    assert after["checkpoints"] == []
    assert runtime.submitted == []


async def test_estimate_refuses_a_review_that_went_stale(client, runtime):
    ctx = await make_ctx()
    cp_id, _ = await review(ctx, 3)
    run = await plain_run(client, ctx, reuse_baseline=True)
    async with tenant_session(ctx.tenant_id) as s:
        cp = await s.get(Checkpoint, cp_id)
        cp.decided_at = datetime.now(UTC) - timedelta(days=31)
        await s.commit()
    refused = await estimate(client, ctx, run["id"], expect=409)
    assert refused["detail"] == {"code": "baseline_not_reusable", "reason": "too_old"}
    after = (await client.get(f"/v1/runs/{run['id']}", headers=ctx.as_("owner"))).json()
    assert after["estimate_usd"] is None


async def test_a_plain_run_without_the_knob_still_builds_the_baseline(client, runtime):
    ctx = await make_ctx()
    await review(ctx, 3)
    run = await plain_run(client, ctx)
    assert run["knobs"].get("reuse_baseline") is None
    est = await estimate(client, ctx, run["id"])
    assert est["total_usd"] == pytest.approx(31.5)
    assert all(r["note"] is None and r["reused"] is False for r in est["segments"])
    started = await start(client, ctx, run["id"])
    assert started["segments"][0]["status"] == "running"
    [spec] = runtime.submitted
    assert spec.labels["segment"] == "baseline"


async def _awaiting_approval(client, ctx) -> dict:
    """A run reusing the baseline whose estimate is over the owner's threshold (P3)."""
    run = await plain_run(client, ctx, reuse_baseline=True)
    await estimate(client, ctx, run["id"])
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(Run, uuid.UUID(run["id"]))
        row.estimate_usd = 60
        await s.commit()
    started = await start(client, ctx, run["id"])
    assert started["status"] == "awaiting_approval"
    return started


async def test_approve_starts_a_run_reusing_a_still_reusable_baseline(client, runtime):
    ctx = await make_ctx()
    await review(ctx, 3)
    run = await _awaiting_approval(client, ctx)
    # Waiting for the owner, it builds nothing: the baseline stays reusable.
    assert (await status_of(client, ctx))["reusable"] is True
    resp = await client.post(f"/v1/runs/{run['id']}/approve", headers=ctx.as_("owner"))
    assert resp.status_code == 200, resp.text
    approved = resp.json()
    assert approved["status"] == "running"
    assert approved["segments"][0]["status"] == "skipped"
    [spec] = runtime.submitted
    assert spec.labels["segment"] == "feature_set"


async def test_approve_refuses_a_review_that_went_stale(client, runtime):
    ctx = await make_ctx()
    cp_id, _ = await review(ctx, 3)
    run = await _awaiting_approval(client, ctx)
    async with tenant_session(ctx.tenant_id) as s:
        cp = await s.get(Checkpoint, cp_id)
        cp.decided_at = datetime.now(UTC) - timedelta(days=31)
        await s.commit()
    resp = await client.post(f"/v1/runs/{run['id']}/approve", headers=ctx.as_("owner"))
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"] == {"code": "baseline_not_reusable", "reason": "too_old"}
    after = (await client.get(f"/v1/runs/{run['id']}", headers=ctx.as_("owner"))).json()
    assert after["status"] == "awaiting_approval"
    assert after["approved_by"] is None
    assert after["checkpoints"] == []
    assert runtime.submitted == []
