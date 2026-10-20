"""CR-06 review fixes, round 5 (PR #57, on #45 / #38), after the owner's C2 follow-ups
(2026-10-19): owner-level writes re-check the caller under the gate like member routes;
a provider revoke that keeps failing is retried for 24 hours and shown to owners in the
Inbox with Retry and Dismiss. Synthetic placeholders only."""

import asyncio
import uuid
from datetime import UTC, datetime
from decimal import Decimal

import httpx
import pytest
from sqlalchemy import select

from oracle import readiness
from oracle.auth.models import User
from oracle.tenancy import tenant_session
from tests.review_v2_helpers import DOC, person, setup
from tests.test_review_v2_security_3 import disable, member_token
from tests.test_review_v2_security_4 import (
    _lose_standing,
    add_oauth_connection,
    email_of,
)


@pytest.fixture(autouse=True)
def _only_test_checks():
    with readiness.isolated_checks():
        yield


@pytest.fixture
def provider():
    from tests.connection_helpers import clear_provider_http, use_provider_http

    seen = use_provider_http(lambda request: httpx.Response(200, json={"ok": True}))
    yield seen
    clear_provider_http()


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


# --- ITEM 2: a provider revoke that keeps failing: 24 hours, then the Inbox -------------


async def add_connection(ctx, user_id, account: str) -> uuid.UUID:
    """An OAuth GitHub connection of ``user_id`` (``account``: the provider's account id)."""
    from oracle import crypto
    from oracle.connections.models import Connection

    async with tenant_session(ctx.tenant_id) as s:
        conn = Connection(
            user_id=user_id,
            provider="github",
            auth_mode="oauth",
            account_id=account,
            account_label=account,
            ciphertext=crypto.encrypt(b'{"access_token": "placeholder"}'),
            key_version=crypto.KEY_VERSION,
        )
        s.add(conn)
        await s.commit()
        return conn.id


def _always(outcome: str, calls: list | None = None):
    async def revoke(http, conn):
        if calls is not None:
            calls.append(conn.id)
        return outcome

    return revoke


async def _follow_up_row(ctx):
    from oracle.members.models import MemberFollowUp

    async with tenant_session(ctx.tenant_id) as s:
        return (await s.scalars(select(MemberFollowUp))).one()


async def _shift(ctx, *, created_hours_ago: float | None = None, due: bool = True) -> None:
    """Move the follow-up's clock: due now, and created ``created_hours_ago`` hours ago."""
    from datetime import UTC, datetime, timedelta

    from oracle.members.models import MemberFollowUp

    async with tenant_session(ctx.tenant_id) as s:
        row = (await s.scalars(select(MemberFollowUp))).one()
        now = datetime.now(UTC)
        if due:
            row.next_attempt_at = now - timedelta(seconds=1)
        if created_hours_ago is not None:
            row.created_at = now - timedelta(hours=created_hours_ago)
        await s.commit()


async def _tick(client, ctx):
    resp = await client.post("/v1/internal/tick", headers=ctx.auth)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _revoke_failures(client, headers) -> list[dict]:
    resp = await client.get("/v1/inbox", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()["revoke_failures"]


async def test_a_failing_revoke_is_retried_by_time_for_24_hours_and_keeps_its_copy(
    client, monkeypatch, provider
):
    from oracle.connections import service as connections

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    await add_oauth_connection(ctx, pm.user_id)
    calls: list = []
    monkeypatch.setattr(connections, "revoke_at_provider", _always("failed", calls))
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    assert len(calls) == 1
    # Ticks in quick succession do not burn retries: the next one waits for its backoff.
    for _ in range(6):
        await _tick(client, ctx)
    assert len(calls) == 1
    row = await _follow_up_row(ctx)
    assert row.status == "pending" and row.attempts == 1 and row.ciphertext is not None
    # Due again: retried, still pending, the copy kept; well past 5 attempts.
    for _ in range(6):
        await _shift(ctx)
        await _tick(client, ctx)
    assert len(calls) == 7
    row = await _follow_up_row(ctx)
    assert row.status == "pending" and row.attempts == 7 and row.ciphertext is not None
    # 24 hours on: retrying stops; the copy is kept for an owner's Retry or Dismiss.
    await _shift(ctx, created_hours_ago=25)
    await _tick(client, ctx)
    row = await _follow_up_row(ctx)
    assert row.status == "failed" and row.ciphertext is not None
    await _shift(ctx)
    await _tick(client, ctx)
    assert len(calls) == 8  # no automatic retry after the 24 hours
    [item] = await _revoke_failures(client, ctx.auth)
    email = await email_of(ctx, pm.user_id)
    assert item["title"] == f"Couldn't revoke {email}'s GitHub access at GitHub"
    assert item["status"] == "failed" and item["outcome"] == "failed"


@pytest.mark.parametrize("outcome", ["not_configured", "unreadable"])
async def test_not_configured_and_unreadable_are_not_a_success(
    client, monkeypatch, provider, outcome
):
    from oracle.connections import service as connections

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    await add_oauth_connection(ctx, pm.user_id)
    monkeypatch.setattr(connections, "revoke_at_provider", _always(outcome))
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    row = await _follow_up_row(ctx)
    assert row.status == "pending" and row.outcome == outcome and row.ciphertext is not None
    [item] = await _revoke_failures(client, ctx.auth)
    assert item["outcome"] == outcome


async def test_owners_see_revoke_failures_others_do_not(client, monkeypatch, provider):
    from oracle.connections import service as connections

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    other = await person(ctx.tenant_id, "approver", "other")
    await add_oauth_connection(ctx, pm.user_id)
    monkeypatch.setattr(connections, "revoke_at_provider", _always("failed"))
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    assert len(await _revoke_failures(client, ctx.auth)) == 1
    assert await _revoke_failures(client, other.headers) == []
    resp = await client.get("/v1/inbox", headers=ctx.auth)
    assert resp.json()["total"] >= 1


async def test_retry_runs_now_and_a_success_drops_the_copy(client, monkeypatch, provider):
    from oracle.audit import AuditEvent
    from oracle.connections import service as connections

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    await add_oauth_connection(ctx, pm.user_id)
    monkeypatch.setattr(connections, "revoke_at_provider", _always("failed"))
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    await _shift(ctx, created_hours_ago=25)
    await _tick(client, ctx)
    [item] = await _revoke_failures(client, ctx.auth)
    # Retry is owner-only.
    resp = await client.post(f"/v1/member-follow-ups/{item['id']}/retry", headers=pm.headers)
    assert resp.status_code in (401, 403)
    calls: list = []
    monkeypatch.setattr(connections, "revoke_at_provider", _always("revoked", calls))
    resp = await client.post(f"/v1/member-follow-ups/{item['id']}/retry", headers=ctx.auth)
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "done" and resp.json()["outcome"] == "revoked"
    assert len(calls) == 1
    row = await _follow_up_row(ctx)
    assert row.status == "done" and row.ciphertext is None
    assert await _revoke_failures(client, ctx.auth) == []
    async with tenant_session(ctx.tenant_id) as s:
        actions = list(await s.scalars(select(AuditEvent.action)))
    assert "connection.provider_revoke" in actions


async def test_a_failed_retry_keeps_the_item(client, monkeypatch, provider):
    from oracle.connections import service as connections

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    await add_oauth_connection(ctx, pm.user_id)
    monkeypatch.setattr(connections, "revoke_at_provider", _always("failed"))
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    [item] = await _revoke_failures(client, ctx.auth)
    resp = await client.post(f"/v1/member-follow-ups/{item['id']}/retry", headers=ctx.auth)
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "pending" and resp.json()["attempts"] == 2
    row = await _follow_up_row(ctx)
    assert row.ciphertext is not None
    assert len(await _revoke_failures(client, ctx.auth)) == 1


async def test_dismiss_is_owner_only_audited_and_drops_the_copy(client, monkeypatch, provider):
    from oracle.audit import AuditEvent
    from oracle.connections import service as connections

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    approver = await person(ctx.tenant_id, "approver", "approver")
    await add_oauth_connection(ctx, pm.user_id)
    monkeypatch.setattr(connections, "revoke_at_provider", _always("failed"))
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    [item] = await _revoke_failures(client, ctx.auth)
    url = f"/v1/member-follow-ups/{item['id']}/dismiss"
    assert (await client.post(url, headers=approver.headers)).status_code == 403
    assert (await _follow_up_row(ctx)).ciphertext is not None
    resp = await client.post(url, headers=ctx.auth)
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "dismissed"
    row = await _follow_up_row(ctx)
    assert row.status == "dismissed" and row.ciphertext is None and row.dismissed_at
    assert await _revoke_failures(client, ctx.auth) == []
    async with tenant_session(ctx.tenant_id) as s:
        event = await s.scalar(
            select(AuditEvent).where(AuditEvent.action == "connection.provider_revoke_dismissed")
        )
    assert event is not None and event.data["member_id"] == str(pm.user_id)
    # A dismissed revoke is never tried again.
    await _shift(ctx)
    await _tick(client, ctx)
    assert (await _follow_up_row(ctx)).status == "dismissed"
    retry = await client.post(f"/v1/member-follow-ups/{item['id']}/retry", headers=ctx.auth)
    assert retry.status_code == 409


async def test_dismiss_by_an_owner_disabled_while_waiting_on_the_gate_is_refused(
    client, monkeypatch, provider
):
    from oracle.connections import service as connections
    from oracle.review import publish

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    caller = await person(ctx.tenant_id, "owner", "caller")
    await add_oauth_connection(ctx, pm.user_id)
    monkeypatch.setattr(connections, "revoke_at_provider", _always("failed"))
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    [item] = await _revoke_failures(client, ctx.auth)
    real = publish.gate_lock
    fired = False

    async def spy(db, *, shared):
        nonlocal fired
        if not fired:
            fired = True
            await _lose_standing(ctx, "disabled", caller.user_id)
        await real(db, shared=shared)

    monkeypatch.setattr(publish, "gate_lock", spy)
    url = f"/v1/member-follow-ups/{item['id']}/dismiss"
    assert (await client.post(url, headers=caller.headers)).status_code == 403
    assert fired
    assert (await _follow_up_row(ctx)).ciphertext is not None


async def test_follow_ups_run_after_runs_and_jobs_within_a_time_budget(
    client, monkeypatch, provider
):
    from oracle.connections import service as connections
    from oracle.members import service as members
    from oracle.members.models import MemberFollowUp
    from oracle.runs import router as runs_router

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    for i in range(3):
        await add_connection(ctx, pm.user_id, f"gh-{i}")
    monkeypatch.setattr(connections, "revoke_at_provider", _always("failed"))
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    async with tenant_session(ctx.tenant_id) as s:
        for row in await s.scalars(select(MemberFollowUp)):
            row.next_attempt_at = datetime.now(UTC)
        await s.commit()

    order: list[str] = []
    real_tick, real_jobs = runs_router.service.tick, runs_router.run_llm_jobs

    async def runs_tick(db, principal=None, **kwargs):
        order.append("runs")
        return await real_tick(db, principal, **kwargs)

    async def jobs(tenant_id, **kwargs):
        order.append("jobs")
        return await real_jobs(tenant_id, **kwargs)

    async def slow(http, conn):
        order.append("revoke")
        await asyncio.sleep(0.6)
        return "failed"

    monkeypatch.setattr(runs_router.service, "tick", runs_tick)
    monkeypatch.setattr(runs_router, "run_llm_jobs", jobs)
    monkeypatch.setattr(connections, "revoke_at_provider", slow)
    monkeypatch.setattr(members, "FOLLOW_UP_TICK_BUDGET_SECONDS", 1.0)
    started = asyncio.get_running_loop().time()
    out = await _tick(client, ctx)
    elapsed = asyncio.get_running_loop().time() - started
    # Runs and jobs first; then as many follow-ups as fit in the budget, the rest wait.
    assert order[:2] == ["runs", "jobs"]
    assert order.count("revoke") < 3
    assert 1 <= out["member_follow_ups"] < 3
    assert elapsed < 1.0 + 1.5
    # A call the budget cut short is not counted: it is due again at the next tick.
    async with tenant_session(ctx.tenant_id) as s:
        attempts = sorted(r.attempts for r in await s.scalars(select(MemberFollowUp)))
    assert attempts == [1] * (3 - out["member_follow_ups"]) + [2] * out["member_follow_ups"]


async def test_a_db_error_in_one_follow_up_rolls_it_back_and_the_others_run(
    client, monkeypatch, provider
):
    from sqlalchemy import text

    from oracle.connections import service as connections
    from oracle.members import service as members
    from oracle.members.models import MemberFollowUp

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    first = await add_connection(ctx, pm.user_id, "gh-1")
    second = await add_connection(ctx, pm.user_id, "gh-2")
    monkeypatch.setattr(connections, "revoke_at_provider", _always("failed"))
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    async with tenant_session(ctx.tenant_id) as s:
        for row in await s.scalars(select(MemberFollowUp)):
            row.next_attempt_at = datetime.now(UTC)
        await s.commit()

    real_record = members.audit.record

    async def record(session, *args, **kwargs):
        if args[2] == "connection" and args[3] == first and args[1] == "connection.provider_revoke":
            await session.execute(text("SELECT 1/0"))  # a real DB error: the txn aborts
        return await real_record(session, *args, **kwargs)

    monkeypatch.setattr(connections, "revoke_at_provider", _always("revoked"))
    monkeypatch.setattr(members.audit, "record", record)
    out = await _tick(client, ctx)
    async with tenant_session(ctx.tenant_id) as s:
        rows = {r.target_id: r for r in await s.scalars(select(MemberFollowUp))}
    # The broken one rolled back (still pending, its copy kept); the other one ran.
    assert rows[first].status == "pending" and rows[first].attempts == 1
    assert rows[first].ciphertext is not None
    assert rows[second].status == "done" and rows[second].ciphertext is None
    assert out["member_follow_ups"] >= 1


# --- MINORS --------------------------------------------------------------------------


async def test_the_sweep_rechecks_the_member_under_the_gate(client, monkeypatch):
    """A restore that commits while the sweep waits on the gate: nothing of the restored
    member's is revoked."""
    from oracle.auth.models import ApiToken
    from oracle.members.service import sweep_disabled
    from oracle.review import publish
    from tests.test_review_v2_security_3 import restore

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    token_id, _ = await member_token(ctx, pm.user_id, "slipped-in")
    real = publish.gate_lock

    async def spy(db, *, shared):
        monkeypatch.setattr(publish, "gate_lock", real)
        assert (await restore(client, ctx, pm.user_id)).status_code == 200
        await real(db, shared=shared)

    monkeypatch.setattr(publish, "gate_lock", spy)
    async with tenant_session(ctx.tenant_id) as s:
        assert await sweep_disabled(s, None, pm.user_id) is False
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.get(ApiToken, token_id)).revoked_at is None


async def test_a_disable_waits_for_a_locked_queued_job_and_cancels_it(client):
    from oracle.docs.models import Document
    from oracle.jobs.models import LlmJob

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    async with tenant_session(ctx.tenant_id) as s:
        doc_id = await s.scalar(select(Document.id).where(Document.slug == DOC))
        job = LlmJob(kind="reporting", document_id=doc_id, requested_by=pm.user_id)
        s.add(job)
        await s.commit()
        job_id = job.id
    held = asyncio.Event()

    async def hold():
        # A worker looking at the job (its claim locks the row briefly).
        async with tenant_session(ctx.tenant_id) as s:
            await s.scalar(select(LlmJob).where(LlmJob.id == job_id).with_for_update())
            held.set()
            await asyncio.sleep(0.5)
            await s.rollback()

    holder = asyncio.create_task(hold())
    await held.wait()
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    await holder
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.get(LlmJob, job_id)).status == "cancelled"


@pytest.mark.parametrize(
    "spelling",
    [
        "URN:UUID:{u}",
        "Urn:Uuid:{u}",
        "urn:uuid:{U}",
        "URN:UUID:{{{U}}}",
        "  URN:UUID:{h}  ",
    ],
)
def test_external_key_accepts_any_case_urn_prefix(spelling):
    from oracle.review.publish import _as_uuid, external_key

    u = uuid.UUID("12345678-9abc-def0-1234-56789abcdef0")
    value = spelling.format(u=u, U=str(u).upper(), h=u.hex)
    assert external_key(value) == str(u)
    assert _as_uuid(value) == u
