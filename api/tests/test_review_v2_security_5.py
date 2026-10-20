"""CR-06 review fixes, round 5 (PR #57, on #45 / #38), after the owner's C2 follow-ups
(2026-10-19): owner-level writes re-check the caller under the gate like member routes;
a provider revoke that keeps failing is retried for 24 hours and shown to owners in the
Inbox with Retry and Dismiss. Synthetic placeholders only."""

import asyncio
import uuid
from decimal import Decimal

import pytest
from sqlalchemy import select

from oracle import readiness
from oracle.auth.models import User
from oracle.tenancy import tenant_session
from tests.review_v2_helpers import DOC, person, setup
from tests.test_review_v2_security_3 import disable, member_token
from tests.test_review_v2_security_4 import _lose_standing


@pytest.fixture(autouse=True)
def _only_test_checks():
    with readiness.isolated_checks():
        yield


# --- ITEM 1: owner-level writes re-check the caller under the gate --------------------

POLICY = {
    "decider_id": None,
    "mandatory_reviewer_ids": [],
    "required_section_keys": [],
    "section_approval": "required_sections",
    "rereview_on_change": False,
}


async def _settings(ctx) -> dict:
    from oracle.tenant_settings import TenantSetting

    async with tenant_session(ctx.tenant_id) as s:
        return {r.key: r.value for r in await s.scalars(select(TenantSetting))}


async def _document_policy(ctx):
    from oracle.review.models import DocumentReviewPolicy

    async with tenant_session(ctx.tenant_id) as s:
        return await s.scalar(select(DocumentReviewPolicy))


ROGUE_WRITES = ["iap_default_role", "review_policy", "document_review_policy"]


async def _rogue_write(client, what: str, headers):
    if what == "iap_default_role":
        return await client.put(
            "/v1/settings/iap_default_role", json={"value": "owner"}, headers=headers
        )
    if what == "review_policy":
        return await client.put(
            "/v1/settings/review_policy", json={"value": POLICY}, headers=headers
        )
    return await client.put(f"/v1/documents/{DOC}/review-policy", json=POLICY, headers=headers)


@pytest.mark.parametrize("what", ROGUE_WRITES)
async def test_an_owner_write_queued_on_the_gate_while_the_owner_is_disabled_is_refused(
    client, monkeypatch, what
):
    """Rogue owner B writes a company setting or a PRD's review policy; owner A disables
    B. B's request, queued on the gate while A holds it, runs after A commits: refused,
    nothing written."""
    from oracle.review import publish

    ctx = await setup(client)
    rogue = await person(ctx.tenant_id, "owner", "rogue")
    real = publish.gate_lock
    a_holds, b_waits = asyncio.Event(), asyncio.Event()
    calls = 0

    async def spy(db, *, shared):
        nonlocal calls
        calls += 1
        if calls == 1:  # A's disable: hold the gate until B queues on it
            await real(db, shared=shared)
            a_holds.set()
            try:  # a route that never takes the gate never queues: give up, and see
                await asyncio.wait_for(b_waits.wait(), 2)
            except TimeoutError:
                pass
            await asyncio.sleep(0.3)
            return
        b_waits.set()
        await real(db, shared=shared)

    monkeypatch.setattr(publish, "gate_lock", spy)
    a = asyncio.create_task(disable(client, ctx, rogue.user_id))
    await a_holds.wait()
    b = asyncio.create_task(_rogue_write(client, what, rogue.headers))
    ra, rb = await asyncio.gather(a, b)
    assert ra.status_code == 200, ra.text
    assert rb.status_code == 403, rb.text
    assert b_waits.is_set(), "the write did not take the gate"
    if what == "document_review_policy":
        assert await _document_policy(ctx) is None
    else:
        assert what not in await _settings(ctx)


async def _awaiting_run(ctx, author_id) -> uuid.UUID:
    from oracle.runs.models import Run, RunSegment

    async with tenant_session(ctx.tenant_id) as s:
        run = Run(
            flow="baseline_to_prd",
            created_by=author_id,
            status="awaiting_approval",
            estimate_usd=Decimal("80"),
        )
        s.add(run)
        await s.flush()
        s.add(RunSegment(run_id=run.id, seq=1, name="baseline", status="pending"))
        await s.commit()
        return run.id


OWNER_ROUTES = [
    "settings_confidence_weights",
    "settings_publish_latest_only",
    "settings_reset",
    "document_review_policy",
    "llm_job_settings",
    "draft_defaults",
    "claude_fallback",
    "run_approve",
    "run_resume",
]
APPROVER_ROUTES = ["llm_job_enqueue", "run_start", "run_create"]


@pytest.mark.parametrize(
    "route,how",
    [(r, "disabled") for r in OWNER_ROUTES + APPROVER_ROUTES]
    + [("settings_confidence_weights", "demoted"), ("run_approve", "demoted")]
    + [("document_review_policy", "token_revoked"), ("llm_job_enqueue", "token_revoked")],
)
async def test_an_owner_or_approver_write_by_a_caller_who_lost_standing_is_refused(
    client, monkeypatch, route, how
):
    from oracle.jobs.models import LlmJob
    from oracle.review import publish
    from oracle.runs.models import Run

    ctx = await setup(client)
    role = "approver" if route in APPROVER_ROUTES else "owner"
    caller = await person(ctx.tenant_id, role, "caller")
    token_id, bearer = await member_token(ctx, caller.user_id, "caller-agent")
    headers = bearer if how == "token_revoked" else caller.headers
    author = await person(ctx.tenant_id, "approver", "author")
    run_id = await _awaiting_run(ctx, author.user_id)
    if route == "run_resume":
        async with tenant_session(ctx.tenant_id) as s:
            (await s.get(Run, run_id)).status = "paused_overrun"
            await s.commit()
    if route == "run_start":
        async with tenant_session(ctx.tenant_id) as s:
            run = await s.get(Run, run_id)
            run.status, run.created_by = "draft", caller.user_id
            await s.commit()
    before = await _settings(ctx)

    real = publish.gate_lock
    fired = False

    async def spy(db, *, shared):
        nonlocal fired
        if not fired:
            fired = True
            await _lose_standing(ctx, how, caller.user_id, token_id)
        await real(db, shared=shared)

    monkeypatch.setattr(publish, "gate_lock", spy)
    if route == "settings_confidence_weights":
        body = {"value": {"low": 0.3}}
        resp = await client.put("/v1/settings/confidence_weights", json=body, headers=headers)
    elif route == "settings_publish_latest_only":
        body = {"value": False}
        resp = await client.put("/v1/settings/publish_latest_only", json=body, headers=headers)
    elif route == "settings_reset":
        body = {"value": None}
        resp = await client.put("/v1/settings/iap_default_role", json=body, headers=headers)
    elif route == "document_review_policy":
        resp = await client.put(f"/v1/documents/{DOC}/review-policy", json=POLICY, headers=headers)
    elif route == "llm_job_settings":
        body = {"review_comments": False, "reporting": True, "refinement": True}
        resp = await client.put(
            f"/v1/documents/{DOC}/llm-jobs/settings", json=body, headers=headers
        )
    elif route == "draft_defaults":
        resp = await client.put("/v1/drafts/defaults", json={}, headers=headers)
    elif route == "claude_fallback":
        token = "-".join(("sk", "ant", "api03", "placeholder" * 3))
        body = {"token": token}
        resp = await client.put("/v1/claude-accounts/fallback", json=body, headers=headers)
    elif route == "run_approve":
        resp = await client.post(f"/v1/runs/{run_id}/approve", headers=headers)
    elif route == "run_resume":
        resp = await client.post(f"/v1/runs/{run_id}/resume", headers=headers)
    elif route == "run_start":
        resp = await client.post(f"/v1/runs/{run_id}/start", headers=headers)
    elif route == "run_create":
        body = {"flow": "baseline_to_prd"}
        resp = await client.post("/v1/runs", json=body, headers=headers)
    else:
        body = {"kind": "review_comments"}
        resp = await client.post(f"/v1/documents/{DOC}/llm-jobs", json=body, headers=headers)
    assert fired, "the route did not take the gate"
    assert resp.status_code == 403, resp.text
    assert await _settings(ctx) == before
    assert await _document_policy(ctx) is None
    async with tenant_session(ctx.tenant_id) as s:
        run = await s.get(Run, run_id)
        assert run.approved_by is None
        assert run.status in ("awaiting_approval", "paused_overrun", "draft")
        assert await s.scalar(select(LlmJob.id)) is None
        assert await s.scalar(select(Run.id).where(Run.id != run_id)) is None


async def test_an_active_owner_still_writes_settings_and_policies(client):
    ctx = await setup(client)
    owner = await person(ctx.tenant_id, "owner", "owner")
    for what in ROGUE_WRITES:
        resp = await _rogue_write(client, what, owner.headers)
        assert resp.status_code == 200, (what, resp.text)
    settings = await _settings(ctx)
    assert settings["iap_default_role"] == "owner"
    assert settings["review_policy"]["rereview_on_change"] is False
    assert await _document_policy(ctx) is not None
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.get(User, owner.user_id)).disabled_at is None
