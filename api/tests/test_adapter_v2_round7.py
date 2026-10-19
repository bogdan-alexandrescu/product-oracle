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
    _Clock,
    _console,
    _member,
    _writes,
    on,
    token_of,
    use,
)
from tests.test_adapter_v2 import settings as _v2_settings
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
