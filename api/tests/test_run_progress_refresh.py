"""run-progress: "Refresh progress" counts only the active runs it checked, names each run
it could not check and why, and a running segment shows the latest evidence of its work
(heartbeat, the runtime's last event, proposals written) and whether its cost was reported."""

import uuid

import pytest

from oracle.baseline.models import Proposal
from oracle.tenancy import tenant_session
from tests.fixtures import seed_auth
from tests.test_adapter_v2 import on, use
from tests.test_adapter_v2 import settings as _v2_settings
from tests.test_runs import get, started, tick

settings = _v2_settings

STARTED = "2026-10-21T09:00:00+00:00"
EVENT = "2026-10-21T09:04:00+00:00"


@pytest.fixture
async def owner():
    return await seed_auth()


async def _tick(client, auth) -> dict:
    resp = await client.post("/v1/internal/tick", headers=auth)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _running(run: dict) -> dict:
    return next(s for s in run["segments"] if s["status"] == "running")


async def test_a_run_that_could_not_be_checked_is_named_with_why_and_not_counted(client, owner):
    _, auth = owner
    swarm = on()
    use(swarm)
    swarm.steps_per_poll = 0
    ok = await started(client, auth)
    broken = await started(client, auth)
    assert _running(await get(client, auth, broken["id"]))["workflow_id"] == "wf_2"
    swarm.html_404_ids = {"wf_2"}

    out = await _tick(client, auth)
    assert out["active_runs"] == 1
    [unchecked] = out["unchecked"]
    assert unchecked["run_id"] == broken["id"]
    doc = broken["document_title"]
    assert unchecked["title"] == (f"{doc} · " if doc else "") + broken["flow_title"]
    assert unchecked["reason"] and broken["id"] not in unchecked["reason"]
    assert all(u["run_id"] != ok["id"] for u in out["unchecked"])


async def test_an_ended_run_still_watched_is_not_counted_as_active(client, owner):
    _, auth = owner
    swarm = on()
    use(swarm)
    swarm.steps_per_poll = 0
    running = await started(client, auth)
    ended = await started(client, auth)
    swarm.fail_cancels = 100
    resp = await client.post(f"/v1/runs/{ended['id']}/cancel", headers=auth)
    assert resp.status_code == 200, resp.text
    assert (await get(client, auth, ended["id"]))["status"] != "running"

    out = await _tick(client, auth)
    assert out["runs_checked"] == 2
    assert out["active_runs"] == 1
    assert (await get(client, auth, running["id"]))["status"] == "running"


async def test_every_tick_moves_a_running_run_s_checked_time(client, owner):
    _, auth = owner
    swarm = on()
    use(swarm)
    swarm.steps_per_poll = 0
    run = await started(client, auth)
    await tick(client, auth)
    first = _running(await get(client, auth, run["id"]))["checked_at"]
    await tick(client, auth)
    second = _running(await get(client, auth, run["id"]))["checked_at"]
    assert first is not None and second > first


async def test_the_runtime_s_last_event_is_the_agent_s_last_work(client, owner):
    _, auth = owner
    swarm = on()
    use(swarm)
    swarm.steps_per_poll = 0
    run = await started(client, auth)
    first = swarm.workflows["wf_1"].steps[0]
    swarm.forged[first.step_id] = {"state": "RUNNING", "started_at": STARTED, "updated_at": EVENT}

    await tick(client, auth)
    seg = _running(await get(client, auth, run["id"]))
    [agent] = seg["agents"]
    assert agent["heartbeat_at"] is None
    assert agent["last_work"] == "event"
    assert agent["last_work_at"].startswith("2026-10-21T09:04:00")
    # Nothing (only a zero) reported: not $0.00 spent.
    assert seg["cost_reported"] is False


async def test_proposals_written_count_as_the_agent_s_last_work(client, owner):
    tenant_id, auth = owner
    swarm = on()
    use(swarm)
    swarm.steps_per_poll = 0
    run = await started(client, auth)
    first = swarm.workflows["wf_1"].steps[0]
    swarm.forged[first.step_id] = {"state": "RUNNING", "started_at": STARTED}
    await tick(client, auth)
    async with tenant_session(tenant_id) as s:
        for i in range(12):
            s.add(
                Proposal(payload={"name": f"Example {i}"}, run_id=uuid.UUID(run["id"]), actor="x")
            )
        await s.commit()

    seg = _running(await get(client, auth, run["id"]))
    assert seg["proposals_written"] == 12
    [agent] = seg["agents"]
    assert agent["last_work"] == "proposals"
    assert agent["last_work_at"] is not None


async def test_a_reported_cost_is_reported(client, owner):
    _, auth = owner
    swarm = on()
    use(swarm)
    swarm.steps_per_poll = 0
    run = await started(client, auth)
    first = swarm.workflows["wf_1"].steps[0]
    swarm.forged[first.step_id] = {"state": "RUNNING", "cost_usd_total": 0.5}
    await tick(client, auth)
    seg = _running(await get(client, auth, run["id"]))
    assert seg["cost_reported"] is True
