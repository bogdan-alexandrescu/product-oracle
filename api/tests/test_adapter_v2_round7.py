"""Adapter v2 review fixes, round 7: an open checkpoint wait holds the run token from the
moment it opens (W5, owner 2026-10-19), 'Stop cancelling' on a run that has not ended
ends it while its workflow's spend still counts (P3d, owner 2026-10-19), and the minors
of the round-6 review."""

import uuid

import pytest

from oracle.runs import service
from oracle.runs.models import Run, RunSegment
from oracle.swarm import RuntimeUnavailable
from oracle.swarm.settings import get_runtime_settings
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
    _retried,
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


# --------------------------------------------------------------------------- minors


async def _stopped(client, auth, tenant_id, swarm, clock) -> dict:
    """A cancelled run whose workflow's cancel is stuck on bare 404s, then stopped (Cancel
    on the ended run): wf_1 still runs, on ``searches`` with ``cancel`` False."""
    run = await _at_baseline(client, auth, swarm)
    swarm.html_404_cancel = True
    resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=auth)
    assert resp.status_code == 200, resp.text
    for _ in range(service.NOT_FOUND_TRIES):
        clock.forward(service.STUCK_LOOKUP_SECONDS + 1)
        await _tick_errors(client, auth)
    resp = await client.post(f"/v1/runs/{run['id']}/stop-cancelling", headers=auth)
    assert resp.status_code == 200, resp.text
    [entry] = (await _knobs_of(tenant_id, run["id"]))["searches"]
    assert entry["id"] == "wf_1" and entry["cancel"] is False
    return resp.json()


async def test_a_stopped_workflow_is_read_on_every_tick(client, owner, monkeypatch):
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    run = await _stopped(client, auth, tenant_id, swarm, clock)
    for _ in range(2):
        swarm.workflows["wf_1"].steps[0].cost += 2.0
        await _tick_errors(client, auth)  # no clock forward: no rest between reads
        run = await get(client, auth, run["id"])
        assert run["spent_usd"] == _wf_cost(swarm, "wf_1")


async def test_a_stopped_workflow_whose_status_never_reads_shows_as_cost_unknown(
    client, owner, monkeypatch
):
    """Past the credential's end plus a step's timeout it is kept, shown in the Inbox as
    'Cost unknown for workflow ...' with the cap; only past that cap is it dropped
    (noted)."""
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    run = await _stopped(client, auth, tenant_id, swarm, clock)
    runtime = use(swarm)
    real = runtime.status

    async def status(workflow_id):
        if workflow_id == "wf_1":
            raise RuntimeUnavailable("SwarmCloud is unavailable", status=503)
        return await real(workflow_id)

    monkeypatch.setattr(runtime, "status", status)
    clock.forward(86400 + get_runtime_settings().step_seconds + 60)
    await _tick_errors(client, auth)
    assert (await _knobs_of(tenant_id, run["id"])).get("searches"), "kept"
    [item] = (await _inbox(client, auth))["lookups"]
    assert item["id"] == run["id"] and item["can_retry_lookup"] is True
    assert "Cost unknown for workflow wf_1" in item["stuck"] and "until" in item["stuck"]
    clock.forward(service.COST_UNKNOWN_SECONDS + 60)
    await _tick_errors(client, auth)
    assert not (await _knobs_of(tenant_id, run["id"])).get("searches")
    assert (await _inbox(client, auth))["lookups"] == []
    run = await get(client, auth, run["id"])
    assert any("wf_1" in n and "unknown" in n for n in run["notes"]), run["notes"]


async def test_bare_404s_on_a_stopped_workflow_offer_retry_lookup(client, owner, monkeypatch):
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    run = await _stopped(client, auth, tenant_id, swarm, clock)
    swarm.html_404_ids = {"wf_1"}
    for _ in range(service.NOT_FOUND_TRIES):
        clock.forward(service.STUCK_LOOKUP_SECONDS + 1)
        await _tick_errors(client, auth)
    [item] = (await _inbox(client, auth))["lookups"]
    assert "Cost unknown for workflow wf_1" in item["stuck"] and "404" in item["stuck"]
    assert item["can_retry_lookup"] is True
    # SwarmCloud serves it again: Retry lookup reads it now.
    swarm.html_404_ids = set()
    swarm.workflows["wf_1"].steps[0].cost += 3.0
    resp = await client.post(f"/v1/runs/{run['id']}/retry-lookup", headers=auth)
    assert resp.status_code == 200, resp.text
    assert resp.json()["spent_usd"] == _wf_cost(swarm, "wf_1")
    assert (await _inbox(client, auth))["lookups"] == []
    assert (await _knobs_of(tenant_id, run["id"]))["searches"][0]["id"] == "wf_1"


async def test_retry_lookup_needs_a_cost_unknown_workflow(client, owner):
    _, auth = owner
    use(on())
    run = await started(client, auth)
    resp = await client.post(f"/v1/runs/{run['id']}/retry-lookup", headers=auth)
    assert resp.status_code == 409, resp.text


def _label_search(at: str) -> dict:
    return {
        "label": "oracle-r-baseline-1",
        "seq": 1,
        "submitted_at": at,
        "until": "2026-10-20T10:00:00+00:00",
        "why": "cancel",
        "looked_at": None,
        "lookups": 0,
    }


def test_search_for_merges_a_stop_into_the_label_search_of_the_same_submission():
    run = Run(knobs={"searches": [_label_search("2026-10-19T10:00:00+00:00")]})
    service._search_for(
        run,
        label="oracle-r-baseline-1",
        seq=1,
        submitted_at="2026-10-19T10:00:00Z",
        until=None,
        why="stopped",
        workflow_id="wf_9",
        cancel=False,
    )
    [entry] = run.knobs["searches"]
    assert entry["id"] == "wf_9" and entry["cancel"] is False
    # And a stop on an entry known by its id.
    run = Run(knobs={"searches": [{**_label_search("2026-10-19T10:00:00+00:00"), "id": "wf_9"}]})
    service._search_for(
        run,
        label="x",
        seq=1,
        submitted_at=None,
        until=None,
        why="stopped",
        workflow_id="wf_9",
        cancel=False,
    )
    [entry] = run.knobs["searches"]
    assert entry["cancel"] is False


def test_search_for_compares_normalised_submission_times():
    run = Run(knobs={})
    for at in ("2026-10-19T10:00:00", "2026-10-19T10:00:00", "2026-10-19T10:00:00+00:00"):
        service._search_for(
            run, label="oracle-r-baseline-1", seq=1, submitted_at=at, until=None, why="retry"
        )
    assert len(run.knobs["searches"]) == 1


async def test_cancel_keeps_a_confirmed_cancel_whose_status_is_unread_on_searches(
    client, owner, monkeypatch
):
    """A running segment not on the run's live workflow: its cancel is confirmed, its
    status not read; it goes on searches, so its last cost is read and counted."""
    tenant_id, auth = owner
    swarm = FakeSwarmCloud(mcp=True)  # one workflow per segment
    use(swarm)
    swarm.steps_per_poll = 1
    run = await started(client, auth)
    await tick(client, auth)
    assert (await get(client, auth, run["id"]))["segments"][0]["status"] == "running"
    async with tenant_session(tenant_id) as s:
        r = await s.get(Run, uuid.UUID(run["id"]))
        r.knobs = {
            **r.knobs,
            # Another workflow attached as the run's (one SwarmCloud no longer knows).
            "workflow": {"id": "wf_gone", "state": "live", "start_seq": 1, "segments": []},
        }
        await s.commit()
    swarm.workflows["wf_1"].steps[0].cost += 2.0
    swarm.fail_reads_after_cancel = 1
    resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=auth)
    assert resp.status_code == 200, resp.text
    assert swarm.workflows["wf_1"].state == "CANCELLED"
    entries = (await _knobs_of(tenant_id, run["id"])).get("searches") or []
    assert [e["id"] for e in entries] == ["wf_1"], entries
    await _tick_errors(client, auth)
    run = await get(client, auth, run["id"])
    assert run["spent_usd"] == _wf_cost(swarm, "wf_1") and run["searching"] is None


async def test_a_found_searchs_confirmed_cancel_is_read_until_it_is_terminal(
    client, owner, monkeypatch
):
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    run = await _retried(client, auth, swarm, clock)
    swarm._advance(swarm.workflows["wf_1"])
    swarm.other_tasks = 0
    clock.forward(service.STUCK_LOOKUP_SECONDS + 1)  # due for a lookup
    swarm.wind_down_reads = 2
    await _tick_errors(client, auth)
    wf = swarm.workflows["wf_1"]
    assert wf.state == "CANCELLING"
    assert (await _knobs_of(tenant_id, run["id"])).get("searches"), "kept: still winding down"
    wf.steps[0].cost += 1.0  # spent while winding down
    for _ in range(3):
        await _tick_errors(client, auth)
    run = await get(client, auth, run["id"])
    found = [a for a in run["segments"][0]["attempts"] if a["workflow_id"] == "wf_1"]
    assert found[0]["cost_usd"] == _wf_cost(swarm, "wf_1")
    assert run["searching"] is None


async def test_a_confirmed_cancel_on_the_main_path_is_read_until_it_is_terminal(
    client, owner, monkeypatch
):
    tenant_id, auth = owner
    swarm = on()
    run = await _at_baseline(client, auth, swarm)
    swarm.wind_down_reads = 1
    resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=auth)
    assert resp.status_code == 200, resp.text
    assert swarm.workflows["wf_1"].state == "CANCELLING"
    swarm.workflows["wf_1"].steps[0].cost += 1.0  # spent while winding down
    for _ in range(2):
        await _tick_errors(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "cancelled"
    assert run["spent_usd"] == _wf_cost(swarm, "wf_1") and run["searching"] is None


async def test_a_later_segment_left_running_on_a_detached_workflow_is_not_counted_twice(
    client, owner
):
    tenant_id, auth = owner
    swarm = on()
    run = await _at_baseline(client, auth, swarm)
    swarm.steps_per_poll = 0
    run = await decide(client, auth, run, "approved")
    assert run["segments"][1]["status"] == "running"
    assert run["segments"][1]["workflow_id"] == "wf_1"
    async with tenant_session(tenant_id) as s:
        r = await s.get(Run, uuid.UUID(run["id"]))
        r.knobs = {**r.knobs, "workflow": {**r.knobs["workflow"], "state": "ended"}}
        await s.commit()
    swarm.workflows["wf_1"].steps[0].cost += 1.0
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["spent_usd"] == _wf_cost(swarm, "wf_1")


async def test_a_pause_over_an_unread_answer_leaves_it_for_an_approver(client, owner, monkeypatch):
    """Paused on overrun while an answer waits to be read: the workflow is cancelled, so
    the answer is never read; the Inbox asks an approver to decide instead of showing
    the run waiting forever to read it."""
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    await _member(tenant_id, "commenter@example.com", "commenter")
    run = await _at_baseline(client, auth, swarm)
    swarm.form_status = 502
    swarm.console_answer("wf_1", "baseline-review1", "MERGE", by="commenter@example.com")
    clock.forward(service.WATCH_SECONDS + 1)
    await _tick_errors(client, auth)
    run = await get(client, auth, run["id"])
    assert _console(run, pending(run)["id"])["needs"] == "unread"
    await _ceiling(tenant_id, run["id"], str(run["spent_usd"]))
    swarm.workflows["wf_1"].steps[0].cost += 1.0
    await _tick_errors(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "paused_overrun"
    console = _console(run, pending(run)["id"])
    assert console["needs"] == "unreadable" and "paused" in console["reason"]


def test_a_per_segment_attach_carries_its_submission_time():
    seg = RunSegment(
        seq=1,
        name="baseline",
        artifacts={
            "files": {},
            "notes": [],
            "attempts": [
                {"workflow_id": "wf_1", "label": "L", "submitted_at": "2026-10-19T10:00:00+00:00"}
            ],
        },
    )
    run = Run(knobs={})
    wf = service._attach_for_cancel(run, seg, "wf_1")
    assert wf["submitted_at"] == "2026-10-19T10:00:00+00:00"


async def test_a_searched_workflows_cancel_call_rests_while_its_cost_is_read_every_tick(
    client, owner, monkeypatch
):
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    run = await _retried(client, auth, swarm, clock)
    swarm.other_tasks = 0
    clock.forward(service.STUCK_LOOKUP_SECONDS + 1)  # due for a lookup
    swarm.html_404_cancel = True  # its cancel is never confirmed; its status reads
    await _tick_errors(client, auth)
    cancels = swarm.cancels.count("wf_1")
    swarm.workflows["wf_1"].steps[0].cost += 2.0
    await _tick_errors(client, auth)
    assert swarm.cancels.count("wf_1") == cancels  # the cancel call rests
    run = await get(client, auth, run["id"])
    found = [a for a in run["segments"][0]["attempts"] if a["workflow_id"] == "wf_1"]
    assert found[0]["cost_usd"] == _wf_cost(swarm, "wf_1")  # its cost read meanwhile
    clock.forward(service.STUCK_LOOKUP_SECONDS + 1)
    await _tick_errors(client, auth)
    assert swarm.cancels.count("wf_1") == cancels + 1
