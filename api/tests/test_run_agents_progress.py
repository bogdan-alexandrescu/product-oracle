"""#258: a running segment shows its agents (role, state, started, last heartbeat) and
the cost spent so far, as the last tick read them from SwarmCloud."""

import uuid
from decimal import Decimal

import pytest

from oracle.runs import service
from oracle.runs.models import Run, RunSegment
from oracle.swarm.swarmcloud import SwarmCloudRuntime
from oracle.tenancy import tenant_session
from tests.fixtures import seed_auth
from tests.test_adapter_v2 import _ceiling, on, use
from tests.test_adapter_v2 import settings as _v2_settings
from tests.test_runs import decide, get, started, tick

settings = _v2_settings

STARTED = "2026-10-21T09:00:00+00:00"
BEAT = "2026-10-21T09:24:30+00:00"


@pytest.fixture
async def owner():
    return await seed_auth()


def _running(seg: dict) -> bool:
    return seg["status"] == "running"


async def test_a_tick_records_the_running_agents_and_their_cost(client, owner):
    _, auth = owner
    swarm = on()
    use(swarm)
    swarm.steps_per_poll = 0
    run = await started(client, auth)
    first = swarm.workflows["wf_1"].steps[0]
    swarm.forged[first.step_id] = {
        "state": "RUNNING",
        "cost_usd_total": 1.25,
        "started_at": STARTED,
        "heartbeat_at": BEAT,
    }

    await tick(client, auth)
    after = await get(client, auth, run["id"])
    seg = next(s for s in after["segments"] if _running(s))
    assert seg["cost_usd"] == pytest.approx(1.25)
    assert after["spent_usd"] == pytest.approx(1.25)
    assert seg["checked_at"] is not None
    [agent] = seg["agents"]
    assert agent["role"] == first.metadata["agent_role"]
    assert agent["state"] == "running"
    assert agent["started_at"].startswith("2026-10-21T09:00:00")
    assert agent["heartbeat_at"].startswith("2026-10-21T09:24:30")
    assert agent["cost_usd"] == pytest.approx(1.25)


async def test_waiting_and_finished_steps_are_not_listed_as_running_agents(client, owner):
    _, auth = owner
    swarm = on()
    use(swarm)
    swarm.steps_per_poll = 0
    run = await started(client, auth)

    await tick(client, auth)
    seg = next(s for s in (await get(client, auth, run["id"]))["segments"] if _running(s))
    # Every step is still queued or parked on its dependencies: none is working yet.
    assert seg["agents"] == []
    assert seg["checked_at"] is not None


async def test_the_adapter_reads_an_agent_s_role_times_and_cost():
    rt = object.__new__(SwarmCloudRuntime)

    async def read(workflow_id):
        return {
            "workflow": {"state": "running", "steps": [{"step_id": "a", "task_id": "t_a"}]},
            "tasks": [
                {
                    "id": "t_a",
                    "state": "RUNNING",
                    "metadata": {"agent_role": "analyst"},
                    "lease": {"created_at": STARTED, "heartbeat_at": BEAT},
                    "cost_usd_total": 0.5,
                }
            ],
        }

    rt._read = read
    step = (await rt.status("wf_1")).step("a")
    # The lease's times stand in when the task carries none of its own.
    assert step.role == "analyst"
    assert step.started_at is not None and step.started_at.isoformat().startswith(STARTED[:19])
    assert step.heartbeat_at is not None and step.heartbeat_at.isoformat().startswith(BEAT[:19])
    assert step.cost_usd == pytest.approx(0.5)


async def test_a_later_segment_of_the_workflow_shows_what_its_own_agents_spent(client, owner):
    # Review fix: segment 2 runs in the workflow submitted for segment 1; its cost so far
    # is what its own agents spent, not $0.00 with the whole workflow's on segment 1.
    _, auth = owner
    swarm = on()
    use(swarm)
    run = await started(client, auth)
    await tick(client, auth)
    swarm.steps_per_poll = 0
    run = await decide(client, auth, await get(client, auth, run["id"]))
    swarm.forged["feature_set-1-analyst"] = {"state": "RUNNING", "cost_usd_total": 0.75}

    await tick(client, auth)
    run = await get(client, auth, run["id"])
    first, second = run["segments"][0], run["segments"][1]
    assert second["status"] == "running" and second["workflow_id"] == "wf_1"
    assert second["cost_usd"] == pytest.approx(0.75)
    baseline = sum(s.cost for s in swarm.workflows["wf_1"].steps)
    assert first["cost_usd"] == pytest.approx(baseline)
    # The run's spend is still the workflow's cost, counted once.
    assert run["spent_usd"] == pytest.approx(baseline + 0.75)


async def test_a_segment_that_starts_during_a_check_shows_what_that_check_read(client, owner):
    # Review fix: segment 1 finishes during the check (its checkpoint off) and segment 2
    # starts in the same workflow; segment 2 shows what that check read, not "not checked".
    _, auth = owner
    swarm = on()
    use(swarm)
    swarm.steps_per_poll = 2
    run = await started(client, auth, checkpoints={"baseline_confirm": False})
    swarm.forged["feature_set-1-analyst"] = {"state": "RUNNING"}

    await tick(client, auth)
    run = await get(client, auth, run["id"])
    first, second = run["segments"][0], run["segments"][1]
    assert first["status"] == "succeeded"
    assert second["status"] == "running" and second["workflow_id"] == "wf_1"
    assert second["checked_at"] is not None
    assert [a["state"] for a in second["agents"]] == ["running"]


async def _second_spending(client, auth, swarm) -> dict:
    """Segment 2 running in the workflow submitted for segment 1, its analyst $0.75 in."""
    use(swarm)
    run = await started(client, auth)
    await tick(client, auth)
    swarm.steps_per_poll = 0
    run = await decide(client, auth, await get(client, auth, run["id"]))
    swarm.workflows["wf_1"].step("feature_set-1-analyst").cost = 0.75
    swarm.forged["feature_set-1-analyst"] = {"state": "RUNNING"}
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["segments"][1]["cost_usd"] == pytest.approx(0.75)
    assert run["spent_usd"] == pytest.approx(_wf_cost(swarm))
    return run


def _wf_cost(swarm) -> float:
    return sum(s.cost for s in swarm.workflows["wf_1"].steps)


async def test_a_cancel_that_winds_down_counts_a_later_segment_s_cost_once(client, owner):
    # Second review fix: the cancel's last read of the workflow is its whole cost; segment
    # 2 already carries its own share, so segment 1 carries the rest, not the whole again.
    _, auth = owner
    swarm = on()
    run = await _second_spending(client, auth, swarm)
    swarm.wind_down_reads = 1
    resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=auth)
    assert resp.status_code == 200, resp.text
    swarm.forged.clear()
    swarm.workflows["wf_1"].steps[0].cost += 1.0  # spent while winding down
    for _ in range(2):
        await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "cancelled" and run["searching"] is None
    assert run["spent_usd"] == pytest.approx(_wf_cost(swarm))
    assert sum(s["cost_usd"] for s in run["segments"]) == pytest.approx(_wf_cost(swarm))


async def test_an_overrun_pause_that_winds_down_counts_a_later_segment_s_cost_once(client, owner):
    tenant_id, auth = owner
    swarm = on()
    run = await _second_spending(client, auth, swarm)
    await _ceiling(tenant_id, run["id"], str(run["spent_usd"]))
    swarm.wind_down_reads = 1
    swarm.workflows["wf_1"].steps[0].cost += 1.0  # over the ceiling
    await tick(client, auth)
    assert (await get(client, auth, run["id"]))["status"] == "paused_overrun"
    swarm.forged.clear()
    swarm.workflows["wf_1"].steps[0].cost += 0.5  # spent while winding down
    for _ in range(2):
        await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["searching"] is None
    assert run["spent_usd"] == pytest.approx(_wf_cost(swarm))


async def test_a_detached_workflow_s_later_segment_keeps_its_own_share(client, owner):
    # The tick of a segment left running on a detached workflow: the workflow's cost is
    # counted once, and segment 2 keeps what its own agents spent.
    tenant_id, auth = owner
    swarm = on()
    run = await _second_spending(client, auth, swarm)
    async with tenant_session(tenant_id) as s:
        r = await s.get(Run, uuid.UUID(run["id"]))
        r.knobs = {**r.knobs, "workflow": {**r.knobs["workflow"], "state": "ended"}}
        await s.commit()
    swarm.workflows["wf_1"].steps[0].cost += 1.0
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["spent_usd"] == pytest.approx(_wf_cost(swarm))
    assert run["segments"][1]["cost_usd"] == pytest.approx(0.75)


def _seg(seq: int, attempts: list[dict]) -> RunSegment:
    return RunSegment(seq=seq, artifacts={"attempts": attempts}, cost_usd=Decimal(0))


def test_a_workflow_s_last_read_never_counts_its_later_segments_shares_again():
    # Three segments in one workflow: segments 2 and 3 carry their own agents' shares;
    # the workflow's last read ($3.75) leaves segment 1 the rest, every dollar once.
    first = _seg(1, [{"workflow_id": "wf_1", "cost_usd": 2.0, "workflow_cost_usd": 3.0}])
    second = _seg(2, [{"workflow_id": "wf_1", "cost_usd": 0.5}])
    third = _seg(3, [{"workflow_id": "wf_1", "cost_usd": 0.5}])
    segments = [first, second, third]
    for s in segments:
        s.cost_usd = Decimal(str(s.artifacts["attempts"][0]["cost_usd"]))
    run = Run(spent_usd=Decimal(3))
    service._cost_on(run, segments, {"seq": 1, "id": "wf_1"}, Decimal("3.75"))
    assert run.spent_usd == Decimal("3.75")
    assert first.cost_usd == Decimal("2.75")
    # An older, lower read lowers nothing.
    service._cost_on(run, segments, {"seq": 1, "id": "wf_1"}, Decimal("3.5"))
    assert run.spent_usd == Decimal("3.75")
