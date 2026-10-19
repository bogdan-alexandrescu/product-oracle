"""Adapter v2 review fixes, round 7: an open checkpoint wait holds the run token from the
moment it opens (W5, owner 2026-10-19), 'Stop cancelling' on a run that has not ended
ends it while its workflow's spend still counts (P3d, owner 2026-10-19), and the minors
of the round-6 review."""

import pytest

from oracle.runs import service
from oracle.tenancy import tenant_session
from tests.fixtures import seed_auth
from tests.swarmcloud_fake import FakeSwarmCloud
from tests.test_adapter_v2 import (
    _at_baseline,
    _ceiling,
    _Clock,
    _console,
    _inbox,
    _knobs_of,
    _member,
    _tick_errors,
    _writes,
    on,
    token_of,
    use,
)
from tests.test_adapter_v2 import settings as _v2_settings
from tests.test_adapter_v2_round6 import _stuck_cancel
from tests.test_runs import decide, get, pending, started, tick

# The same environment as test_adapter_v2 (Oracle's public URL, default timings).
settings = _v2_settings


@pytest.fixture
async def owner():
    return await seed_auth()


def _wf_cost(swarm: FakeSwarmCloud, wid: str) -> float:
    return sum(s.cost for s in swarm.workflows[wid].steps)


def _refused(held: dict[str, str]) -> bool:
    return all(
        held[n].startswith("ERROR") and "waiting for approval" in held[n]
        for n in ("push_draft", "import_version", "propose_change")
    )


def _allowed(held: dict[str, str]) -> bool:
    return all("waiting for approval" not in v for v in held.values())


# --------------------------------------------------------------------------- item 1 (W5)


async def test_an_open_wait_holds_the_token_until_an_answer_that_counts_is_read(
    client, owner, monkeypatch
):
    """W5 'Open waits' (owner, 2026-10-19): from the moment the workflow reaches a
    checkpoint the run token is read-only, before any answer and before Oracle's next
    tick; a non-approver's console MERGE (the workflow moves on) keeps it so, the
    60-second watch throttle included; an approver's answer read by Oracle releases it."""
    tenant_id, auth = owner
    swarm = on()
    use(swarm)
    clock = _Clock(monkeypatch)
    await _member(tenant_id, "commenter@example.com", "commenter")
    run = await started(client, auth)
    token = token_of(swarm)
    # No tick yet: SwarmCloud runs the baseline step and parks on its wait.
    held = await _writes(token)
    assert _refused(held), held
    assert held["get_run_output"].startswith("OK") or "not found" in held["get_run_output"]
    assert swarm.workflows["wf_1"].step("baseline-review1").state == "PARKED"
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "awaiting_checkpoint" and run["token_read_only"] is True
    await tick(client, auth)  # the tick's look at the wait: unanswered
    # The next segment's agents start only when the test lets them.
    swarm.steps_per_poll = 0
    # A non-approver answers MERGE inside the watch throttle: the workflow moves on, the
    # tick does not read the wait yet, and the token stays read-only.
    swarm.console_answer("wf_1", "baseline-review1", "MERGE", by="commenter@example.com")
    assert swarm.workflows["wf_1"].step("baseline-review1").state == "SUCCEEDED"
    await tick(client, auth)
    assert _refused(await _writes(token))
    assert (await get(client, auth, run["id"]))["token_read_only"] is True
    # Read: it does not count (a commenter), so it still holds.
    clock.forward(service.WATCH_SECONDS + 1)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert _console(run, pending(run)["id"])["needs"] == "confirm"
    assert run["token_read_only"] is True and _refused(await _writes(token))
    # An approver decides in the Inbox: an answer that counts, read: writable again.
    run = await decide(client, auth, run, "approved")
    assert run["token_read_only"] is False
    assert _allowed(await _writes(token))


async def test_an_approvers_console_answer_holds_until_oracle_reads_it(client, owner, monkeypatch):
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    await _member(tenant_id, "lead@example.com", "approver")
    run = await _at_baseline(client, auth, swarm)
    token = token_of(swarm)
    await tick(client, auth)  # the tick's look at the wait: unanswered
    swarm.steps_per_poll = 0
    swarm.console_answer("wf_1", "baseline-review1", "MERGE", by="lead@example.com")
    # Answered by an approver, not read yet (inside the throttle): held.
    await tick(client, auth)
    assert _refused(await _writes(token))
    # Read: it counts, the run follows it, and the token is whole again.
    clock.forward(service.WATCH_SECONDS + 1)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "running" and run["token_read_only"] is False
    assert _allowed(await _writes(token))
    # The next segment reaches its wait: held again, before any tick.
    swarm.steps_per_poll = None
    assert _refused(await _writes(token))


async def test_a_wait_answered_before_its_checkpoint_opens_is_held_through_the_import(
    client, owner, monkeypatch
):
    """The answered-before-it-opened path: _advance commits the import before it adds the
    checkpoint; the hold is in place across that commit."""
    tenant_id, auth = owner
    swarm = on()
    use(swarm)
    await _member(tenant_id, "lead@example.com", "approver")
    run = await started(client, auth)
    token = token_of(swarm)
    swarm.console_answer("wf_1", "baseline-review1", "MERGE", by="lead@example.com")
    swarm.steps_per_poll = 0
    seen: list[str | None] = []
    real = service._import_baseline

    async def spy(db, run_, text):
        # Inside _advance, after its first commit: what a token check sees now.
        async with tenant_session(tenant_id) as s:
            seen.append(await service.token_hold(s, run_.id))
        return await real(db, run_, text)

    monkeypatch.setattr(service, "_import_baseline", spy)
    await tick(client, auth)
    assert seen and seen[0] is not None, seen
    assert _refused(await _writes(token))
    run = await get(client, auth, run["id"])
    assert run["token_read_only"] is True


# --------------------------------------------------------------------------- item 2 (P3d)


@pytest.mark.parametrize("resumed", [False, True])
async def test_stop_cancelling_a_run_that_has_not_ended_ends_it_and_keeps_counting(
    client, owner, monkeypatch, resumed
):
    """P3d (owner, 2026-10-19): Stop cancelling on a run that has not ended (paused on
    overrun, or resumed and running while its cancel is still stuck) ends the run; the
    stopped workflow's status and cost are read until it ends and counted on the run,
    the ceiling still trips, and no second workflow starts for that segment."""
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    run = await _stuck_cancel(client, auth, tenant_id, swarm, clock)
    wf = swarm.workflows["wf_1"]
    if resumed:
        resp = await client.post(f"/v1/runs/{run['id']}/resume", headers=auth)
        assert resp.status_code == 200, resp.text
        assert resp.json()["status"] in ("running", "awaiting_checkpoint")
    resp = await client.post(f"/v1/runs/{run['id']}/stop-cancelling", headers=auth)
    assert resp.status_code == 200, resp.text
    run = resp.json()
    assert run["status"] == "cancelled" and run["finished_at"]
    assert "Stop cancelling" in (run["error"] or ""), run["error"]
    assert all(s["status"] not in ("running", "pending") for s in run["segments"])
    assert all(c["status"] != "pending" for c in run["checkpoints"])
    assert "wf_1" in (run["searching"] or "")
    assert (await _inbox(client, auth))["lookups"] == []
    # It ended: Resume has nothing to resume.
    resp = await client.post(f"/v1/runs/{run['id']}/resume", headers=auth)
    assert resp.status_code == 409, resp.text
    # Its cost is read on every tick (no rest), and nothing new is submitted.
    for _ in range(3):
        wf.steps[0].cost += 1.0
        await _tick_errors(client, auth)
        run = await get(client, auth, run["id"])
        assert run["spent_usd"] == _wf_cost(swarm, "wf_1")
    assert len(swarm.submissions()) == 1
    # The ceiling still trips: the overrun shows in the Inbox, with what it spent.
    await _ceiling(tenant_id, run["id"], str(run["spent_usd"] + 0.5))
    wf.steps[0].cost += 1.0
    await _tick_errors(client, auth)
    [over] = (await _inbox(client, auth))["lookups"]
    assert over["id"] == run["id"] and "ceiling" in over["stuck"] and "wf_1" in over["stuck"]
    assert (await _knobs_of(tenant_id, run["id"]))["overrun_after_end"]
    # SwarmCloud stops it: its last cost lands, the search and the Inbox item end.
    wf.steps[0].cost += 1.0
    swarm._cancel(wf)
    await _tick_errors(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "cancelled" and run["spent_usd"] == _wf_cost(swarm, "wf_1")
    assert run["searching"] is None
    assert (await _inbox(client, auth))["lookups"] == []
    assert len(swarm.submissions()) == 1
