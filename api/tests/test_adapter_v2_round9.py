"""Adapter v2 review fixes, round 9: a resumed advance that keeps failing (counted,
stopped at 5, in the Inbox with Retry, the workflow still read meanwhile), shared status
checks share only a read-only answer (W5, owner 2026-10-20), a stuck cancel's cost is
read and not 'unknown' (P3d), Cancel again enforced by the service, the overrun's kind,
the shared HTTP client, and one more read after a 'gone' that follows a confirmed
cancel."""

import asyncio
import uuid

import httpx
import pytest
from sqlalchemy import select

from oracle.auth.service import create_user, make_session_cookie
from oracle.config import get_settings
from oracle.models import AuditEvent
from oracle.runs import service
from oracle.runs.models import Run, RunSegment
from oracle.swarm import RuntimeUnavailable, set_runtime
from oracle.swarm.runtime import StepStatus, WorkflowStatus
from oracle.swarm.settings import get_runtime_settings
from oracle.swarm.swarmcloud import StaticBearer, SwarmCloudRuntime
from oracle.tenancy import tenant_session
from tests.conftest import make_tenant
from tests.fixtures import seed_auth
from tests.swarmcloud_fake import EGRESS
from tests.test_adapter_v2 import (
    LB,
    _at_baseline,
    _ceiling,
    _Clock,
    _draft_markdown,
    _inbox,
    _knobs_of,
    _tick_errors,
    mcp_session,
    on,
    token_of,
    use,
)
from tests.test_adapter_v2 import settings as _v2_settings
from tests.test_adapter_v2_round7 import _stopped, _wf_cost
from tests.test_runs import as_user, get, started

# The same environment as test_adapter_v2 (Oracle's public URL, default timings).
settings = _v2_settings


@pytest.fixture
async def owner():
    return await seed_auth()


async def _audits(tenant_id, action: str) -> list[AuditEvent]:
    async with tenant_session(tenant_id) as s:
        return list(await s.scalars(select(AuditEvent).where(AuditEvent.action == action)))


async def _segment(tenant_id, run_id: str, seq: int = 1) -> RunSegment:
    async with tenant_session(tenant_id) as s:
        return await s.scalar(
            select(RunSegment).where(RunSegment.run_id == uuid.UUID(run_id), RunSegment.seq == seq)
        )


async def _user(tenant_id, role: str) -> tuple[uuid.UUID, dict[str, str]]:
    """A member of ``role`` and their session cookie."""
    async with tenant_session(tenant_id) as s:
        user = await create_user(s, f"{role}-{uuid.uuid4().hex[:6]}@example.com", "pw")
        user.role = role
        await s.commit()
    return user.id, {"Cookie": f"{get_settings().session_cookie_name}={make_session_cookie(user)}"}


async def _created_by(tenant_id, run_id: str, user_id: uuid.UUID) -> None:
    async with tenant_session(tenant_id) as s:
        row = await s.get(Run, uuid.UUID(run_id))
        row.created_by = user_id
        await s.commit()


async def _other_tenant_owner() -> dict[str, str]:
    return await as_user(await make_tenant("Other Co"), "owner")


# --------------------------------------------------------------------------- item 1


class _ImportFails:
    """baseline.yaml's import raises every time (an error none of the import's own
    refusals covers), with agent content in its message."""

    def __init__(self, monkeypatch) -> None:
        self.calls = 0
        self.real = service._import_baseline
        self.failing = True
        monkeypatch.setattr(service, "_import_baseline", self)

    async def __call__(self, db, run, text):
        self.calls += 1
        if self.failing:
            raise ValueError("agent wrote: secret-agent-content-77")
        return await self.real(db, run, text)


async def _interrupted(client, auth, monkeypatch, swarm) -> tuple[dict, _ImportFails]:
    """A run whose advance raised in its import after the first commit."""
    use(swarm)
    run = await started(client, auth)
    fails = _ImportFails(monkeypatch)
    assert await _tick_errors(client, auth)
    assert fails.calls == 1
    return run, fails


async def test_a_resume_that_keeps_failing_stops_at_five_and_still_reads_the_workflow(
    client, owner, monkeypatch
):
    tenant_id, auth = owner
    swarm = on()
    run, fails = await _interrupted(client, auth, monkeypatch, swarm)
    for n in range(1, service.RESUME_TRIES + 1):
        swarm.workflows["wf_1"].steps[0].cost += 1.0  # spent meanwhile
        errors = await _tick_errors(client, auth)
        assert errors and all("secret-agent-content" not in e for e in errors), errors
        assert fails.calls == 1 + n
        got = await get(client, auth, run["id"])
        assert got["spent_usd"] == pytest.approx(_wf_cost(swarm, "wf_1")), n
        seg = await _segment(tenant_id, run["id"])
        attempt = seg.artifacts["attempts"][-1]
        assert attempt["resume_failures"]["count"] == n
        assert attempt["resume_failures"]["error"] == "ValueError"
        assert attempt["resume_failures"]["at"]
    # Stopped: no more tries, the step failed with a clear reason, in the owners' Inbox.
    await _tick_errors(client, auth)
    assert fails.calls == 1 + service.RESUME_TRIES
    got = await get(client, auth, run["id"])
    seg = got["segments"][0]
    assert seg["status"] == "failed" and "ValueError" in (seg["error"] or ""), seg
    assert "secret-agent-content" not in str(got)
    [item] = (await _inbox(client, auth))["imports"]
    assert item["id"] == run["id"] and item["can_retry_import"] is True
    assert (
        item["import_failed"].startswith("Couldn't import")
        and "ValueError" in (item["import_failed"])
    )
    assert "secret-agent-content" not in item["import_failed"]
    assert await _audits(tenant_id, "run.import_failed")
    # Approvers do not see it (an owner's Retry).
    lead = await as_user(tenant_id, "approver")
    assert (await _inbox(client, lead))["imports"] == []


async def test_a_failing_resume_does_not_skip_the_ceiling(client, owner, monkeypatch):
    tenant_id, auth = owner
    swarm = on()
    run, _ = await _interrupted(client, auth, monkeypatch, swarm)
    await _ceiling(tenant_id, run["id"], "0.01")
    swarm.workflows["wf_1"].steps[0].cost += 5.0
    await _tick_errors(client, auth)
    got = await get(client, auth, run["id"])
    assert got["status"] == "paused_overrun", got["status"]


async def test_a_failing_resume_does_not_skip_a_workflow_that_ended(client, owner, monkeypatch):
    _, auth = owner
    swarm = on()
    run, _ = await _interrupted(client, auth, monkeypatch, swarm)
    wf = swarm.workflows["wf_1"]
    wf.state = "FAILED"
    await _tick_errors(client, auth)
    got = await get(client, auth, run["id"])
    assert got["status"] == "failed", got["status"]


async def test_retry_import_is_an_owners_audited_and_resets_the_count(client, owner, monkeypatch):
    tenant_id, auth = owner
    swarm = on()
    run, fails = await _interrupted(client, auth, monkeypatch, swarm)
    for _ in range(service.RESUME_TRIES):
        await _tick_errors(client, auth)
    url = f"/v1/runs/{run['id']}/retry-import"
    # Owners only: not even an approver who created the run; another tenant's run is
    # not found.
    lead_id, lead = await _user(tenant_id, "approver")
    await _created_by(tenant_id, run["id"], lead_id)
    assert (await client.post(url, headers=lead)).status_code == 403
    assert (await client.post(url, headers=await _other_tenant_owner())).status_code == 404
    fails.failing = False
    resp = await client.post(url, headers=auth)
    assert resp.status_code == 200, resp.text
    assert await _audits(tenant_id, "run.import_retried")
    seg = await _segment(tenant_id, run["id"])
    assert seg.status == "succeeded" and "resume_failures" not in seg.artifacts["attempts"][-1]
    assert (await _inbox(client, auth))["imports"] == []
    # A second Retry has nothing to do.
    assert (await client.post(url, headers=auth)).status_code == 409
    await _tick_errors(client, auth)
    got = await get(client, auth, run["id"])
    assert got["status"] == "awaiting_checkpoint" and got["waiting_on"] == "baseline_confirm"


async def test_retry_import_resets_the_count_to_five_more_tries(client, owner, monkeypatch):
    tenant_id, auth = owner
    swarm = on()
    run, fails = await _interrupted(client, auth, monkeypatch, swarm)
    for _ in range(service.RESUME_TRIES):
        await _tick_errors(client, auth)
    resp = await client.post(f"/v1/runs/{run['id']}/retry-import", headers=auth)
    assert resp.status_code == 200, resp.text
    before = fails.calls
    await _tick_errors(client, auth)
    assert fails.calls == before + 1
    seg = await _segment(tenant_id, run["id"])
    assert seg.status == "succeeded"
    assert seg.artifacts["attempts"][-1]["resume_failures"]["count"] == 1


async def test_importing_baseline_again_makes_no_second_proposal_for_a_locked_item(client, owner):
    """A resume imports baseline.yaml again: a locked item it would change gets one
    proposal, not one per try."""
    from oracle.baseline.models import Entity, Proposal

    tenant_id, auth = owner
    use(on())
    run = await started(client, auth)
    first = "version: 1\nentities:\n  - type: feature\n    key: f1\n    title: First\nedges: []\n"
    async with tenant_session(tenant_id) as s:
        row = await s.get(Run, uuid.UUID(run["id"]))
        assert "error" not in await service._import_baseline(s, row, first)
        entity = await s.scalar(select(Entity))
        entity.locked = True
        await s.commit()
        for _ in range(3):
            out = await service._import_baseline(s, row, first.replace("First", "Second"))
            assert out.get("proposals") == 1, out
        proposals = list(await s.scalars(select(Proposal)))
    assert len(proposals) == 1


# --------------------------------------------------------------------------- item 2


class _Status:
    """A runtime whose status reads are counted; the first waits for ``gate``. Review
    step ``r1`` reads ``state``."""

    def __init__(self, state: str) -> None:
        self.state = state
        self.calls = 0
        self.gate = asyncio.Event()

    async def status(self, workflow_id):
        self.calls += 1
        if self.calls == 1:
            await self.gate.wait()
        return WorkflowStatus("running", steps=(StepStatus("r1", state=self.state),))


@pytest.fixture
def hold_runtime(monkeypatch):
    service._hold_cache.clear()
    service._hold_reads.clear()

    def make(state: str) -> _Status:
        runtime = _Status(state)
        monkeypatch.setattr(service, "get_runtime", lambda: runtime)
        return runtime

    yield make
    service._hold_cache.clear()
    service._hold_reads.clear()


async def test_a_joiner_on_a_may_write_check_reads_for_itself(hold_runtime):
    runtime = hold_runtime("PENDING")
    key = (uuid.uuid4(), "wf_x", ("r1",))
    first = asyncio.create_task(service._live_hold(*key))
    await asyncio.sleep(0.01)
    joiners = [asyncio.create_task(service._live_hold(*key)) for _ in range(3)]
    await asyncio.sleep(0.01)
    assert runtime.calls == 1, "the joiners wait on the check in flight"
    runtime.gate.set()
    assert await first is None
    assert await asyncio.gather(*joiners) == [None, None, None]
    # The first used its own answer; each joiner made its own read.
    assert runtime.calls == 4


async def test_a_read_only_check_refuses_every_joiner_without_another_read(hold_runtime):
    runtime = hold_runtime("RUNNING")
    key = (uuid.uuid4(), "wf_x", ("r1",))
    first = asyncio.create_task(service._live_hold(*key))
    await asyncio.sleep(0.01)
    joiners = [asyncio.create_task(service._live_hold(*key)) for _ in range(3)]
    await asyncio.sleep(0.01)
    runtime.gate.set()
    answers = [await first, *await asyncio.gather(*joiners)]
    assert answers == [service.HOLD_DECISION] * 4
    assert runtime.calls == 1
    # Cached for 5 seconds: a later request is refused without a read too.
    assert await service._live_hold(*key) == service.HOLD_DECISION
    assert runtime.calls == 1


# --------------------------------------------------------------------------- minors (W5)


async def test_the_hold_cache_does_not_leak_across_runs(hold_runtime):
    runtime = hold_runtime("RUNNING")
    runtime.gate.set()
    one = (uuid.uuid4(), "wf_1", ("r1",))
    assert await service._live_hold(*one) == service.HOLD_DECISION
    runtime.state = "PENDING"
    # Another run on a workflow of the same id and review steps: its own read.
    other = (uuid.uuid4(), "wf_1", ("r1",))
    assert await service._live_hold(*other) is None
    assert runtime.calls == 2
    assert await service._live_hold(*one) == service.HOLD_DECISION  # still cached
    assert runtime.calls == 2


async def test_expired_hold_answers_are_pruned_on_reads_too(hold_runtime, monkeypatch):
    runtime = hold_runtime("RUNNING")
    runtime.gate.set()
    now = [1000.0]
    monkeypatch.setattr(service, "_hold_clock", lambda: now[0])
    old = (uuid.uuid4(), "wf_1", ("r1",))
    await service._live_hold(*old)
    assert old in service._hold_cache
    now[0] += service.HOLD_CACHE_SECONDS + 1
    fresh = (uuid.uuid4(), "wf_2", ("r1",))
    service._hold_cache[fresh] = (now[0], service.HOLD_DECISION)
    # Served from the cache (no read), and the expired answer is gone.
    assert await service._live_hold(*fresh) == service.HOLD_DECISION
    assert runtime.calls == 1
    assert old not in service._hold_cache


def test_the_not_reached_step_states_are_in_one_place():
    from oracle.swarm import runtime as swarm_runtime

    assert swarm_runtime.NOT_REACHED_STATES == frozenset({"PENDING", "SKIPPED"})
    assert not hasattr(service, "_NOT_REACHED")


@pytest.mark.parametrize(
    "state",
    ["PENDING", "SKIPPED", "RUNNING", "PARKED", "SUCCEEDED", "FAILED", "CANCELLED", "NEW_STATE"],
)
async def test_only_the_not_reached_states_leave_the_token_writable(hold_runtime, state):
    from oracle.swarm.runtime import NOT_REACHED_STATES

    runtime = hold_runtime(state)
    runtime.gate.set()
    held = await service._live_hold(uuid.uuid4(), "wf_1", ("r1",))
    assert (held is None) == (state in NOT_REACHED_STATES), held


async def _curated_writes(token: str) -> dict[str, tuple[bool, str]]:
    out = {}
    async with mcp_session(token, f"{EGRESS[0]}, {LB}") as c:
        for name, args in (
            ("push_draft", {"doc": "r9-held", "markdown": _draft_markdown()}),
            ("propose_change", {"body": {"op": "add", "kind": "goal", "data": {"key": "g9"}}}),
        ):
            res = await c.call_tool(name, args)
            out[name] = (res.is_error, res.content[0].text)
    return out


@pytest.mark.parametrize("why", ["open_checkpoint", "review_reached"])
async def test_curated_writes_are_refused_while_held_and_write_nothing(
    client, owner, monkeypatch, why
):
    from dataclasses import replace

    from oracle.baseline.models import Proposal
    from oracle.docs.models import Document

    tenant_id, auth = owner
    swarm = on()
    if why == "open_checkpoint":
        await _at_baseline(client, auth, swarm)
    else:
        # Oracle has not looked yet; the live read finds the review step reached.
        runtime = use(swarm)
        swarm.steps_per_poll = 0
        await started(client, auth)
        real = runtime.status

        async def status(workflow_id):
            read = await real(workflow_id)
            steps = tuple(
                replace(s, state="PARKED") if s.step_id == "baseline-review1" else s
                for s in read.steps
            )
            return replace(read, steps=steps)

        monkeypatch.setattr(runtime, "status", status)
    out = await _curated_writes(token_of(swarm))
    for name, (err, said) in out.items():
        assert err and "waiting for approval" in said, (name, said)
    async with tenant_session(tenant_id) as s:
        assert await s.scalar(select(Document).where(Document.slug == "r9-held")) is None
        assert list(await s.scalars(select(Proposal))) == []


# --------------------------------------------------------------------------- item 3


async def test_a_stuck_cancel_is_not_cost_unknown_while_its_cost_reads(client, owner, monkeypatch):
    """P3d 'Stuck cancels' (owner, 2026-10-20): a confirmed cancel that keeps reading
    CANCELLING is dropped after 3 days with a note; until then its cost is read and
    counted, never labelled 'cost unknown'. Only a failed read makes it unknown."""
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    run = await _at_baseline(client, auth, swarm)
    swarm.wind_down_reads = 10**6
    resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=auth)
    assert resp.status_code == 200, resp.text
    await _tick_errors(client, auth)
    clock.forward(86400 + get_runtime_settings().step_seconds + 60)
    swarm.workflows["wf_1"].steps[0].cost += 2.0  # spent while winding down
    await _tick_errors(client, auth)
    got = await get(client, auth, run["id"])
    assert got["spent_usd"] == pytest.approx(_wf_cost(swarm, "wf_1"))
    assert got["can_retry_lookup"] is False
    assert "Cost unknown" not in (got["stuck"] or ""), got["stuck"]
    [entry] = (await _knobs_of(tenant_id, run["id"]))["searches"]
    assert not entry.get("cost_unknown"), entry
    items = (await _inbox(client, auth))["lookups"]
    assert all("Cost unknown" not in (i["stuck"] or "") for i in items), items
    # A read that fails: now its cost is unknown.
    runtime = use(swarm)
    real = runtime.status

    async def fails(workflow_id):
        raise RuntimeUnavailable("SwarmCloud is unavailable", status=503)

    monkeypatch.setattr(runtime, "status", fails)
    await _tick_errors(client, auth)
    got = await get(client, auth, run["id"])
    assert got["can_retry_lookup"] is True and "Cost unknown" in got["stuck"], got["stuck"]
    # It reads again: counted, and no longer unknown.
    monkeypatch.setattr(runtime, "status", real)
    clock.forward(service.STUCK_LOOKUP_SECONDS + 1)
    swarm.workflows["wf_1"].steps[0].cost += 1.0
    await _tick_errors(client, auth)
    got = await get(client, auth, run["id"])
    assert got["spent_usd"] == pytest.approx(_wf_cost(swarm, "wf_1"))
    assert "Cost unknown" not in (got["stuck"] or ""), got["stuck"]
    # Dropped at the cap, with a note on the run.
    clock.forward(service.COST_UNKNOWN_SECONDS + 60)
    await _tick_errors(client, auth)
    assert not (await _knobs_of(tenant_id, run["id"])).get("searches")
    got = await get(client, auth, run["id"])
    assert any("wf_1" in n and "CANCELLING" in n for n in got["notes"]), got["notes"]


# --------------------------------------------------------------------------- item 4


async def _over_after_stop(client, auth, tenant_id, swarm, clock) -> dict:
    """A cancelled run whose workflow wf_1 was stopped (Stop cancelling) and whose spend
    then passed its ceiling: the overrun is recorded, Cancel again is offered."""
    run = await _stopped(client, auth, tenant_id, swarm, clock)
    await _ceiling(tenant_id, run["id"], str(run["spent_usd"] + 0.5))
    swarm.workflows["wf_1"].steps[0].cost += 1.0
    await _tick_errors(client, auth)
    got = await get(client, auth, run["id"])
    assert got["cancel_again"] == ["wf_1"], got["cancel_again"]
    return got


async def _again(client, headers, run_id: str, wid: str = "wf_1"):
    return await client.post(
        f"/v1/runs/{run_id}/cancel-again", json={"workflow_id": wid}, headers=headers
    )


async def _edit_run(tenant_id, run_id: str, **changes) -> None:
    async with tenant_session(tenant_id) as s:
        row = await s.get(Run, uuid.UUID(run_id))
        knobs = dict(row.knobs or {})
        for key, value in changes.pop("knobs", {}).items():
            if value is None:
                knobs.pop(key, None)
            else:
                knobs[key] = value
        row.knobs = knobs
        for key, value in changes.items():
            setattr(row, key, value)
        await s.commit()


@pytest.mark.parametrize("case", ["no_overrun", "dismissed", "not_ended", "not_stopped"])
async def test_cancel_again_is_refused_unless_the_ui_would_offer_it(
    client, owner, monkeypatch, case
):
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    run = await _over_after_stop(client, auth, tenant_id, swarm, clock)
    knobs = await _knobs_of(tenant_id, run["id"])
    if case == "no_overrun":
        await _edit_run(tenant_id, run["id"], knobs={"overrun_after_end": None})
    elif case == "dismissed":
        over = {**knobs["overrun_after_end"], "dismissed_at": "2026-10-20T10:00:00+00:00"}
        await _edit_run(tenant_id, run["id"], knobs={"overrun_after_end": over})
    elif case == "not_ended":
        await _edit_run(tenant_id, run["id"], status="running", finished_at=None)
    else:
        searches = [{**e, "cancel": True} for e in knobs["searches"]]
        await _edit_run(tenant_id, run["id"], knobs={"searches": searches})
    resp = await _again(client, auth, run["id"])
    assert resp.status_code == 409, resp.text
    assert await _audits(tenant_id, "run.cancel_again") == []
    entries = (await _knobs_of(tenant_id, run["id"]))["searches"]
    assert not any(e.get("cancel_again_at") for e in entries)


async def test_cancel_again_who_and_which_run(client, owner, monkeypatch):
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    run = await _over_after_stop(client, auth, tenant_id, swarm, clock)
    # An approver who did not create the run: refused; another tenant: not found.
    _, lead = await _user(tenant_id, "approver")
    assert (await _again(client, lead, run["id"])).status_code == 403
    assert (await _again(client, await _other_tenant_owner(), run["id"])).status_code == 404
    # Another run's workflow (the run is otherwise eligible): refused.
    assert (await _again(client, auth, run["id"], "wf_2")).status_code == 409
    # The approver who created it may; a second call has no second effect.
    creator_id, creator = await _user(tenant_id, "approver")
    await _created_by(tenant_id, run["id"], creator_id)
    resp = await _again(client, creator, run["id"])
    assert resp.status_code == 200, resp.text
    notes = len((await get(client, auth, run["id"]))["notes"])
    resp = await _again(client, creator, run["id"])
    assert resp.status_code == 409, resp.text
    assert len(await _audits(tenant_id, "run.cancel_again")) == 1
    assert len((await get(client, auth, run["id"]))["notes"]) == notes


# --------------------------------------------------------------------------- item 5


async def test_an_overrun_from_before_the_end_is_not_recorded_as_after_the_end(
    client, owner, monkeypatch
):
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    run = await _at_baseline(client, auth, swarm)
    # Over its ceiling before it ends: cancelled before a tick pauses it.
    await _ceiling(tenant_id, run["id"], str(run["spent_usd"] - 0.5))
    swarm.html_404_cancel = True
    resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=auth)
    assert resp.status_code == 200, resp.text
    for _ in range(service.NOT_FOUND_TRIES):
        clock.forward(service.STUCK_LOOKUP_SECONDS + 1)
        await _tick_errors(client, auth)
    resp = await client.post(f"/v1/runs/{run['id']}/stop-cancelling", headers=auth)
    assert resp.status_code == 200, resp.text
    await _tick_errors(client, auth)  # the stopped workflow read: nothing new spent
    assert "overrun_after_end" not in await _knobs_of(tenant_id, run["id"])
    assert await _audits(tenant_id, "run.overrun_after_end") == []
    # Spend that arrives after the end is recorded, saying it was over already.
    swarm.workflows["wf_1"].steps[0].cost += 1.0
    await _tick_errors(client, auth)
    over = (await _knobs_of(tenant_id, run["id"]))["overrun_after_end"]
    assert float(over["spent_usd"]) == pytest.approx(_wf_cost(swarm, "wf_1"))
    got = await get(client, auth, run["id"])
    assert any("already" in n and "when it ended" in n for n in got["notes"]), got["notes"]


async def test_a_dismissed_overrun_does_not_block_a_new_one(client, owner, monkeypatch):
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    run = await _over_after_stop(client, auth, tenant_id, swarm, clock)
    knobs = await _knobs_of(tenant_id, run["id"])
    first = knobs["overrun_after_end"]
    dismissed = {**first, "dismissed_at": "2026-10-20T10:00:00+00:00"}
    await _edit_run(tenant_id, run["id"], knobs={"overrun_after_end": dismissed})
    # No new spend: nothing new is recorded.
    await _tick_errors(client, auth)
    assert (await _knobs_of(tenant_id, run["id"]))["overrun_after_end"] == dismissed
    # Spend grows past the last recorded amount: recorded again, shown again.
    swarm.workflows["wf_1"].steps[0].cost += 1.0
    await _tick_errors(client, auth)
    over = (await _knobs_of(tenant_id, run["id"]))["overrun_after_end"]
    assert not over.get("dismissed_at")
    assert float(over["spent_usd"]) > float(first["spent_usd"])
    assert len(await _audits(tenant_id, "run.overrun_after_end")) == 2
    got = await get(client, auth, run["id"])
    assert got["cancel_again"] == ["wf_1"]


# --------------------------------------------------------------------------- item 6


def _runtime_on(handler) -> SwarmCloudRuntime:
    return SwarmCloudRuntime(
        "https://swarm.test", StaticBearer("sc-bearer"), transport=httpx.MockTransport(handler)
    )


async def test_a_pool_timeout_never_left_so_it_is_not_lost():
    def handler(request):
        raise httpx.PoolTimeout("no connection free in the pool")

    with pytest.raises(RuntimeUnavailable) as caught:
        await _runtime_on(handler).status("wf_1")
    assert caught.value.lost is False and caught.value.retryable


async def test_a_submit_stuck_in_the_pool_is_not_lost_and_holds_nothing(client, owner, monkeypatch):
    tenant_id, auth = owner
    swarm = on()
    pool_timeouts = 1

    def handler(request):
        nonlocal pool_timeouts
        if request.method == "POST" and request.url.path == "/v1/workflows" and pool_timeouts:
            pool_timeouts -= 1
            raise httpx.PoolTimeout("no connection free in the pool")
        return swarm(request)

    runtime = swarm.runtime()
    runtime._transport = httpx.MockTransport(handler)
    set_runtime(runtime)
    run = await started(client, auth)
    seg = await _segment(tenant_id, run["id"])
    assert seg.status == "pending" and "lost" not in (seg.artifacts or {}), seg.artifacts
    got = await get(client, auth, run["id"])
    assert got["token_read_only"] is False
    assert not (await _inbox(client, auth))["lookups"]


async def test_cookies_are_not_shared_across_calls():
    seen: list[str | None] = []

    def handler(request):
        seen.append(request.headers.get("cookie"))
        return httpx.Response(
            404, json={"error": "not_found"}, headers={"set-cookie": "sticky=1; Path=/"}
        )

    runtime = _runtime_on(handler)
    for _ in range(2):
        with pytest.raises(RuntimeUnavailable):
            await runtime.status("wf_1")
    assert seen == [None, None]


def test_the_old_client_is_closed_when_the_event_loop_changes():
    def handler(request):
        return httpx.Response(404, json={"error": "not_found"})

    runtime = _runtime_on(handler)
    clients = []

    async def call():
        with pytest.raises(RuntimeUnavailable):
            await runtime.status("wf_1")
        clients.append(runtime._http)

    asyncio.run(call())
    asyncio.run(call())
    assert clients[0] is not clients[1]
    assert clients[0].is_closed and not clients[1].is_closed


# --------------------------------------------------------------------------- item 7


async def _cancel(client, auth, run) -> None:
    resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=auth)
    assert resp.status_code == 200, resp.text


async def test_gone_right_after_a_confirmed_cancel_reads_the_cost_once_more(client, owner):
    tenant_id, auth = owner
    swarm = on()
    run = await _at_baseline(client, auth, swarm)
    swarm.gone_reads_after_cancel = 1  # the read right after the cancel: 404 not_found
    await _cancel(client, auth, run)
    swarm.workflows["wf_1"].steps[0].cost += 1.0  # spent before the cancel took
    await _tick_errors(client, auth)
    got = await get(client, auth, run["id"])
    assert got["spent_usd"] == pytest.approx(_wf_cost(swarm, "wf_1"))
    assert not (await _knobs_of(tenant_id, run["id"])).get("searches")


async def test_gone_on_a_searched_cancelled_workflow_reads_once_more_even_if_costed(client, owner):
    tenant_id, auth = owner
    swarm = on()
    run = await _at_baseline(client, auth, swarm)
    swarm.wind_down_reads = 1
    await _cancel(client, auth, run)
    [entry] = (await _knobs_of(tenant_id, run["id"]))["searches"]
    assert entry["cancelled"] and entry["costed"]
    swarm._gone_reads = 1
    swarm.workflows["wf_1"].steps[0].cost += 1.0
    await _tick_errors(client, auth)
    assert (await _knobs_of(tenant_id, run["id"])).get("searches"), "read once more"
    await _tick_errors(client, auth)
    got = await get(client, auth, run["id"])
    assert got["spent_usd"] == pytest.approx(_wf_cost(swarm, "wf_1"))
    assert not (await _knobs_of(tenant_id, run["id"])).get("searches")


async def test_gone_on_the_ticks_read_after_a_confirmed_cancel_reads_once_more(client, owner):
    tenant_id, auth = owner
    swarm = on()
    run = await _at_baseline(client, auth, swarm)
    swarm.fail_reads_after_cancel = 1  # confirmed, its last cost not read
    await _cancel(client, auth, run)
    assert (await _knobs_of(tenant_id, run["id"]))["workflow"]["cancel_pending"]["confirmed"]
    swarm._gone_reads = 1
    swarm.workflows["wf_1"].steps[0].cost += 1.0
    await _tick_errors(client, auth)
    await _tick_errors(client, auth)
    got = await get(client, auth, run["id"])
    assert got["spent_usd"] == pytest.approx(_wf_cost(swarm, "wf_1"))
    assert not (await _knobs_of(tenant_id, run["id"])).get("searches")


async def test_a_failed_read_after_gone_follows_the_cost_unknown_rules(client, owner, monkeypatch):
    tenant_id, auth = owner
    swarm = on()
    run = await _at_baseline(client, auth, swarm)
    swarm.gone_reads_after_cancel = 1
    await _cancel(client, auth, run)
    runtime = use(swarm)

    async def fails(workflow_id):
        raise RuntimeUnavailable("SwarmCloud is unavailable", status=503)

    monkeypatch.setattr(runtime, "status", fails)
    await _tick_errors(client, auth)
    [entry] = (await _knobs_of(tenant_id, run["id"]))["searches"]
    assert entry["id"] == "wf_1" and entry["unread"] == 1, entry
