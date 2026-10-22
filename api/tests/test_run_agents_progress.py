"""#258: a running segment shows its agents (role, state, started, last heartbeat) and
the cost spent so far, as the last tick read them from SwarmCloud."""

import pytest

from oracle.swarm.swarmcloud import SwarmCloudRuntime
from tests.fixtures import seed_auth
from tests.test_adapter_v2 import on, use
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
