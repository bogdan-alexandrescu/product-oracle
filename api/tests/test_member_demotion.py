"""C2 (owner, 2026-10-19): a demotion, like a disable, voids the person's pending spend
approvals and not-yet-acted checkpoint decisions (they return to the Inbox); revoking a
token or grant does not."""

from datetime import UTC, datetime
from decimal import Decimal

import pytest

from oracle.runs.models import Run, RunSegment
from oracle.tenancy import tenant_session
from tests.review_v2_helpers import person, setup
from tests.test_review_v2_security_6 import (  # noqa: F401
    OVERSPEND,
    _at_checkpoint,
    _decide,
    _read,
    _started,
    _tick,
    runtime,
)


async def _demote(client, ctx, user_id, role: str):
    resp = await client.patch(f"/v1/members/{user_id}", json={"role": role}, headers=ctx.auth)
    assert resp.status_code == 200, resp.text


async def _approved_run(ctx, approver_id, author_id, *, started: bool):
    async with tenant_session(ctx.tenant_id) as s:
        run = Run(
            flow="baseline_to_prd",
            created_by=author_id,
            status="running",
            estimate_usd=Decimal("40"),
            approved_by=approver_id,
            approved_at=datetime.now(UTC),
        )
        s.add(run)
        await s.flush()
        s.add(
            RunSegment(
                run_id=run.id,
                seq=1,
                name="baseline",
                status="running" if started else "pending",
                started_at=datetime.now(UTC) if started else None,
            )
        )
        await s.commit()
        return run.id


@pytest.mark.parametrize("started", [False, True])
async def test_a_demoted_owners_spend_approval_is_voided_on_an_unstarted_run(client, started):
    ctx = await setup(client)
    owner = await person(ctx.tenant_id, "owner", "spender")
    author = await person(ctx.tenant_id, "approver", "author")
    run_id = await _approved_run(ctx, owner.user_id, author.user_id, started=started)
    await _demote(client, ctx, owner.user_id, "approver")
    async with tenant_session(ctx.tenant_id) as s:
        run = await s.get(Run, run_id)
    if started:
        assert run.status == "running" and run.approved_by == owner.user_id
    else:
        assert run.status == "awaiting_approval" and run.approved_by is None


async def test_their_own_run_approved_by_themselves_is_voided_too(client):
    """Unlike a disable, a demotion leaves their runs running; an approval they gave
    their own unstarted run needs an owner again."""
    ctx = await setup(client)
    owner = await person(ctx.tenant_id, "owner", "spender")
    run_id = await _approved_run(ctx, owner.user_id, owner.user_id, started=False)
    await _demote(client, ctx, owner.user_id, "commenter")
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.get(Run, run_id)).status == "awaiting_approval"


async def test_a_promotion_or_an_owner_kept_voids_nothing(client):
    ctx = await setup(client)
    owner = await person(ctx.tenant_id, "owner", "spender")
    author = await person(ctx.tenant_id, "approver", "author")
    run_id = await _approved_run(ctx, owner.user_id, author.user_id, started=False)
    await _demote(client, ctx, author.user_id, "owner")
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.get(Run, run_id)).status == "running"


async def test_a_demoted_approvers_pending_checkpoint_decision_is_voided(client, runtime):  # noqa: F811
    from oracle.swarm import RuntimeUnavailable

    ctx = await setup(client)
    run = await _at_checkpoint(client, ctx)
    approver = await person(ctx.tenant_id, "approver", "approver")
    real = runtime.submit

    async def down(spec):
        raise RuntimeUnavailable("SwarmCloud is down")

    runtime.submit = down
    resp = await _decide(client, run, approver.headers)
    assert resp.status_code == 200, resp.text
    runtime.submit = real
    await _demote(client, ctx, approver.user_id, "commenter")
    await _tick(client, ctx)
    run = await _read(client, ctx, run["id"])
    assert run["status"] == "awaiting_checkpoint"
    assert len(runtime.submitted) == 1


async def test_a_demotion_that_keeps_the_checkpoint_role_keeps_the_decision(client, runtime):  # noqa: F811
    from oracle.swarm import RuntimeUnavailable

    ctx = await setup(client)
    run = await _at_checkpoint(client, ctx)
    owner = await person(ctx.tenant_id, "owner", "decider")
    real = runtime.submit

    async def down(spec):
        raise RuntimeUnavailable("SwarmCloud is down")

    runtime.submit = down
    assert (await _decide(client, run, owner.headers)).status_code == 200
    runtime.submit = real
    await _demote(client, ctx, owner.user_id, "approver")  # still an approver
    await _tick(client, ctx)
    run = await _read(client, ctx, run["id"])
    assert run["status"] == "running"
    assert len(runtime.submitted) == 2


# --- M2: an overrun Resume is a spend approval (C2) ------------------------------------


async def _paused(client, ctx, runtime):  # noqa: F811
    """A run paused on overrun, its segment finished and its checkpoint off: a Resume
    queues the next segment."""
    from oracle.swarm import Outcome

    runtime.script["baseline"] = [Outcome(cost_usd=OVERSPEND, polls=1)]
    run = await _started(client, ctx, checkpoints={"baseline_confirm": False})
    await _tick(client, ctx)
    await _tick(client, ctx)
    run = await _read(client, ctx, run["id"])
    assert run["status"] == "paused_overrun", run
    return run


async def _resume(client, run, headers):
    resp = await client.post(f"/v1/runs/{run['id']}/resume", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _remove(client, ctx, how: str, user_id) -> None:
    if how == "demoted":
        await _demote(client, ctx, user_id, "approver")
    else:
        resp = await client.post(f"/v1/members/{user_id}/disable", headers=ctx.auth)
        assert resp.status_code == 200, resp.text


@pytest.mark.parametrize("how", ["demoted", "disabled"])
async def test_a_resume_whose_segment_was_not_submitted_is_voided(client, runtime, how):  # noqa: F811
    from sqlalchemy import select

    from oracle.models import AuditEvent
    from oracle.runtokens import RunToken
    from oracle.swarm import RuntimeUnavailable

    ctx = await setup(client)
    run = await _paused(client, ctx, runtime)
    ceiling = run["overrun_ceiling_usd"]
    spender = await person(ctx.tenant_id, "owner", "spender")
    real = runtime.submit

    async def down(spec):
        raise RuntimeUnavailable("SwarmCloud is down")

    runtime.submit = down
    resumed = await _resume(client, run, spender.headers)
    assert resumed["status"] == "running" and resumed["overrun_ceiling_usd"] != ceiling
    runtime.submit = real
    submitted = len(runtime.submitted)

    await _remove(client, ctx, how, spender.user_id)
    after = await _read(client, ctx, run["id"])
    assert after["status"] == "paused_overrun"
    assert after["overrun_ceiling_usd"] == ceiling
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(Run, run["id"])
        assert row.resumed_by is None
        assert all(t.revoked_at for t in await s.scalars(select(RunToken)))
        events = list(
            await s.scalars(select(AuditEvent).where(AuditEvent.action == "run.resume_voided"))
        )
        assert [e.data["resumed_by"] for e in events] == [str(spender.user_id)]
    # Nothing is submitted for it now: the tick leaves the run paused.
    await _tick(client, ctx)
    assert (await _read(client, ctx, run["id"]))["status"] == "paused_overrun"
    assert len(runtime.submitted) == submitted
    # An owner who still is one resumes it: the voided segment is queued and submitted.
    again = await _resume(client, run, ctx.auth)
    assert again["status"] == "running"
    assert len(runtime.submitted) == submitted + 1


@pytest.mark.parametrize("how", ["demoted", "disabled"])
async def test_a_resume_whose_segment_was_submitted_stands(client, runtime, how):  # noqa: F811
    ctx = await setup(client)
    run = await _paused(client, ctx, runtime)
    spender = await person(ctx.tenant_id, "owner", "spender")
    resumed = await _resume(client, run, spender.headers)
    submitted = len(runtime.submitted)
    await _remove(client, ctx, how, spender.user_id)
    after = await _read(client, ctx, run["id"])
    assert after["status"] == "running"
    assert after["overrun_ceiling_usd"] == resumed["overrun_ceiling_usd"]
    assert len(runtime.submitted) == submitted
