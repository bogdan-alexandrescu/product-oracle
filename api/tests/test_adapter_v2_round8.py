"""Adapter v2 review fixes, round 8: 'Cancel again' on a stopped workflow over the run's
ceiling (P3d, owner 2026-10-19), the 5-second read-only cache (W5, owner 2026-10-19),
the run token's hold decided when a write runs (never on reads, with the database
released before SwarmCloud is called, one bounded and shared read), the overrun on a
search's final read, and the minors of the round-7 review."""

import asyncio
import uuid
from dataclasses import replace

import httpx
import pytest
from sqlalchemy import select, text

from oracle.mcp import server as mcp_server
from oracle.models import AuditEvent
from oracle.runs import service
from oracle.runs.models import Run
from oracle.swarm import RuntimeUnavailable
from oracle.swarm.settings import get_runtime_settings
from oracle.tenancy import tenant_session
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
    _member,
    _tick_errors,
    mcp_session,
    on,
    token_of,
    use,
)
from tests.test_adapter_v2 import settings as _v2_settings
from tests.test_adapter_v2_round7 import _stopped, _wf_cost
from tests.test_runs import as_user, get, pending, started, tick

# The same environment as test_adapter_v2 (Oracle's public URL, default timings).
settings = _v2_settings

FORWARDED = f"{EGRESS[0]}, {LB}"


@pytest.fixture
async def owner():
    return await seed_auth()


def _reads(swarm, wid: str = "wf_1") -> int:
    """SwarmCloud status reads of workflow ``wid``."""
    return sum(
        1 for r in swarm.requests if r.method == "GET" and r.url.path == f"/v1/workflows/{wid}"
    )


async def _push(token: str, doc: str = "r8-draft") -> tuple[bool, str]:
    async with mcp_session(token, FORWARDED) as c:
        res = await c.call_tool("push_draft", {"doc": doc, "markdown": _draft_markdown()})
    return res.is_error, res.content[0].text


async def _audits(tenant_id, action: str) -> list[AuditEvent]:
    async with tenant_session(tenant_id) as s:
        return list(await s.scalars(select(AuditEvent).where(AuditEvent.action == action)))


# --------------------------------------------------------------------------- MAJOR 1


async def test_reads_initialize_and_tools_list_never_read_swarmcloud(client, owner):
    """The live read is made only when a write is about to run: never for initialize,
    tools/list or a read tool."""
    _, auth = owner
    swarm = on()
    use(swarm)
    await started(client, auth)
    token = token_of(swarm)
    before = _reads(swarm)
    async with mcp_session(token, FORWARDED) as c:
        await c.list_tools()
        await c.call_tool("get_run_output", {"seq": 1, "name": "summary.md"})
    assert _reads(swarm) == before


async def test_thirty_concurrent_writes_on_a_slow_status_share_one_bounded_read(
    client, owner, monkeypatch
):
    """30 run-token writes while SwarmCloud's status hangs: no database connection is held
    over the read (a cookie request is served meanwhile), they share one read, and the
    read's deadline makes them read-only ('status unknown')."""
    tenant_id, auth = owner
    swarm = on()
    runtime = use(swarm)
    run = await started(client, auth)
    token = token_of(swarm)
    cookie = await as_user(tenant_id, "owner")
    monkeypatch.setattr(service, "HOLD_READ_SECONDS", 1.0, raising=False)
    release = asyncio.Event()
    calls = 0
    real = runtime.status

    async def slow(workflow_id):
        nonlocal calls
        calls += 1
        await release.wait()
        return await real(workflow_id)

    monkeypatch.setattr(runtime, "status", slow)
    writes = [asyncio.create_task(_push(token, f"r8-{n}")) for n in range(30)]
    try:
        await asyncio.sleep(0.3)
        resp = await asyncio.wait_for(client.get(f"/v1/runs/{run['id']}", headers=cookie), 5)
        assert resp.status_code == 200, resp.text
        results = await asyncio.wait_for(asyncio.gather(*writes), 20)
    finally:
        release.set()
        await asyncio.gather(*writes, return_exceptions=True)
    assert all(err and "status unknown" in said for err, said in results), results[:2]
    assert calls == 1


async def test_a_slow_status_read_times_out_to_read_only(client, owner, monkeypatch):
    _, auth = owner
    swarm = on()
    runtime = use(swarm)
    await started(client, auth)
    token = token_of(swarm)
    monkeypatch.setattr(service, "HOLD_READ_SECONDS", 0.3, raising=False)

    async def hangs(workflow_id):
        await asyncio.sleep(30)

    monkeypatch.setattr(runtime, "status", hangs)
    err, said = await asyncio.wait_for(_push(token), 10)
    assert err and "waiting for approval" in said and "status unknown" in said


async def test_the_swarmcloud_runtime_reuses_one_http_client(monkeypatch):
    made: list[int] = []
    real = httpx.AsyncClient

    class Counting(real):  # type: ignore[misc,valid-type]
        def __init__(self, *a, **kw):
            made.append(1)
            super().__init__(*a, **kw)

    monkeypatch.setattr(httpx, "AsyncClient", Counting)
    runtime = on().runtime()
    for _ in range(3):
        with pytest.raises(RuntimeUnavailable):
            await runtime.status("wf_none")
    assert len(made) == 1


# --------------------------------------------------------------------------- MAJOR 2


async def _writable_between_waits(client, auth, tenant_id, swarm, clock) -> dict:
    """The baseline checkpoint answered by an approver and read: the run goes on, its
    next segment's agents wait for the test (the next wait is not open), writable."""
    await _member(tenant_id, "lead@example.com", "approver")
    run = await _at_baseline(client, auth, swarm)
    await tick(client, auth)
    swarm.steps_per_poll = 0
    swarm.console_answer("wf_1", "baseline-review1", "MERGE", by="lead@example.com")
    clock.forward(service.WATCH_SECONDS + 1)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "running" and run["token_read_only"] is False
    return run


async def test_a_wait_that_opens_after_the_request_starts_refuses_the_write(
    client, owner, monkeypatch
):
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    await _writable_between_waits(client, auth, tenant_id, swarm, clock)
    token = token_of(swarm)
    real = mcp_server.Catalog.call

    async def wait_opens_first(self, name, args):
        # After the request was authenticated, before its write runs: the next segment's
        # agents finish and its wait opens.
        swarm.steps_per_poll = None
        swarm._advance(swarm.workflows["wf_1"])
        assert any(s.state == "PARKED" for s in swarm.workflows["wf_1"].steps[1:])
        return await real(self, name, args)

    monkeypatch.setattr(mcp_server.Catalog, "call", wait_opens_first)
    err, said = await _push(token)
    assert err and "waiting for approval" in said, said


# --------------------------------------------------------------------------- MAJOR 3


async def test_an_overrun_on_a_stopped_workflows_final_read_is_recorded(client, owner, monkeypatch):
    """$10 ceiling, $9 spent; the stopped workflow is read at $12 as SUCCEEDED: the
    overrun is audited, noted and shown in the Inbox (no Cancel again: it ended)."""
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    run = await _stopped(client, auth, tenant_id, swarm, clock)
    await _ceiling(tenant_id, run["id"], "10")
    wf = swarm.workflows["wf_1"]
    others = _wf_cost(swarm, "wf_1") - wf.steps[0].cost
    wf.steps[0].cost = 9.0 - others
    await _tick_errors(client, auth)
    run = await get(client, auth, run["id"])
    assert run["spent_usd"] == pytest.approx(9.0)
    assert await _audits(tenant_id, "run.overrun_after_end") == []
    wf.steps[0].cost = 12.0 - others
    wf.state = "SUCCEEDED"
    await _tick_errors(client, auth)
    run = await get(client, auth, run["id"])
    assert run["spent_usd"] == pytest.approx(12.0) and run["searching"] is None
    [event] = await _audits(tenant_id, "run.overrun_after_end")
    assert event.data["ceiling_usd"] == "10"
    assert any("ceiling" in n for n in run["notes"]), run["notes"]
    [item] = (await _inbox(client, auth))["lookups"]
    assert item["id"] == run["id"] and "ceiling" in item["stuck"]
    assert item["cancel_again"] == [] and item["can_dismiss_overrun"] is True
    # Dismissed by the owner: the Inbox item goes, the record stays.
    resp = await client.post(f"/v1/runs/{run['id']}/dismiss-overrun", headers=auth)
    assert resp.status_code == 200, resp.text
    assert (await _inbox(client, auth))["lookups"] == []
    assert await _audits(tenant_id, "run.overrun_dismissed")


# --------------------------------------------------------------------------- A (P3d)


async def test_cancel_again_turns_the_cancel_calls_back_on(client, owner, monkeypatch):
    """P3d (owner, 2026-10-19): a stopped workflow whose spend passes the run's ceiling
    shows in the Inbox with its spend, the ceiling and Cancel again; Cancel again (an
    owner, or the approver who created the run) turns Oracle's cancel calls back on."""
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    run = await _stopped(client, auth, tenant_id, swarm, clock)
    await _ceiling(tenant_id, run["id"], str(run["spent_usd"] + 0.5))
    wf = swarm.workflows["wf_1"]
    wf.steps[0].cost += 1.0
    cancels = swarm.cancels.count("wf_1")
    await _tick_errors(client, auth)
    assert swarm.cancels.count("wf_1") == cancels  # stopped: no cancel call
    [item] = (await _inbox(client, auth))["lookups"]
    assert item["cancel_again"] == ["wf_1"]
    assert "ceiling" in item["stuck"] and f"${item['spent_usd']}" in item["stuck"]
    # Not the run's creator: refused.
    other = await as_user(tenant_id, "approver")
    resp = await client.post(
        f"/v1/runs/{run['id']}/cancel-again", json={"workflow_id": "wf_1"}, headers=other
    )
    assert resp.status_code == 403, resp.text
    resp = await client.post(
        f"/v1/runs/{run['id']}/cancel-again", json={"workflow_id": "wf_other"}, headers=auth
    )
    assert resp.status_code == 409, resp.text
    resp = await client.post(
        f"/v1/runs/{run['id']}/cancel-again", json={"workflow_id": "wf_1"}, headers=auth
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["cancel_again"] == []
    [event] = await _audits(tenant_id, "run.cancel_again")
    assert event.data == {"workflow_id": "wf_1"}
    assert len(swarm.submissions()) == 1  # nothing restarts
    # The cancel calls are on again: SwarmCloud takes this one.
    swarm.html_404_cancel = False
    await _tick_errors(client, auth)
    assert wf.state == "CANCELLED"
    run = await get(client, auth, run["id"])
    assert run["spent_usd"] == _wf_cost(swarm, "wf_1") and run["searching"] is None
    [item] = (await _inbox(client, auth))["lookups"]
    assert item["cancel_again"] == [] and item["can_dismiss_overrun"] is True
    assert len(swarm.submissions()) == 1


# --------------------------------------------------------------------------- B (W5)


async def test_a_read_only_answer_is_cached_for_five_seconds_and_may_write_never(
    client, owner, monkeypatch
):
    _, auth = owner
    swarm = on()
    use(swarm)
    now = [1000.0]
    monkeypatch.setattr(service, "_hold_clock", lambda: now[0], raising=False)
    swarm.steps_per_poll = 0
    await started(client, auth)
    token = token_of(swarm)
    # The wait is not reached: may write, read again for each write.
    reads = _reads(swarm)
    for n in range(2):
        err, said = await _push(token, f"r8-may-{n}")
        assert "waiting for approval" not in said, said
    assert _reads(swarm) == reads + 2
    # The wait opens: read-only, and that answer is reused for 5 seconds.
    swarm.steps_per_poll = None
    err, said = await _push(token)
    assert err and "waiting for approval" in said
    reads = _reads(swarm)
    now[0] += 4.5
    err, said = await _push(token)
    assert err and "waiting for approval" in said
    assert _reads(swarm) == reads
    now[0] += 1.0
    await _push(token)
    assert _reads(swarm) == reads + 1


# --------------------------------------------------------------------------- minors


@pytest.mark.parametrize("state", ["RUNNING", "AWAITING_INPUT", "RESUMING", "missing"])
async def test_a_review_step_reached_in_any_state_holds_the_token(
    client, owner, monkeypatch, state
):
    """Deny by default: from the moment the workflow reaches the review step, whatever
    state SwarmCloud reports it in (or no row for it), the token is read-only."""
    _, auth = owner
    swarm = on()
    runtime = use(swarm)
    swarm.steps_per_poll = 0
    await started(client, auth)
    token = token_of(swarm)
    real = runtime.status

    async def status(workflow_id):
        read = await real(workflow_id)
        steps = tuple(
            replace(s, state=state) if s.step_id == "baseline-review1" else s
            for s in read.steps
            if not (state == "missing" and s.step_id == "baseline-review1")
        )
        return replace(read, steps=steps)

    monkeypatch.setattr(runtime, "status", status)
    err, said = await _push(token)
    assert err and "waiting for approval" in said, said


async def test_a_lost_submission_holds_its_token(client, owner):
    """A submission whose answer was lost keeps its token alive (it may have landed):
    read-only until the submission is resolved."""
    _, auth = owner
    swarm = on()
    use(swarm)
    swarm.other_tasks = 1100  # the lookup does not reach it
    swarm.lose_next_submit = True
    run = await started(client, auth)
    run = await get(client, auth, run["id"])
    assert run["segments"][0]["status"] == "pending"
    token = token_of(swarm)
    err, said = await _push(token)
    assert err and "waiting for approval" in said and "status unknown" in said, said
    assert run["token_read_only"] is True


async def test_an_advance_interrupted_after_its_first_commit_recovers(client, owner, monkeypatch):
    """The import raises after _advance's first commit: the next tick opens the
    checkpoint (the import is idempotent) instead of leaving the run read-only with none."""
    tenant_id, auth = owner
    swarm = on()
    use(swarm)
    run = await started(client, auth)
    real = service._import_baseline
    calls = 0

    async def crashes_once(db, run_, body):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("import crashed")
        return await real(db, run_, body)

    monkeypatch.setattr(service, "_import_baseline", crashes_once)
    assert await _tick_errors(client, auth)
    assert "opening_wait" in await _knobs_of(tenant_id, run["id"])
    assert await _tick_errors(client, auth) == []
    run = await get(client, auth, run["id"])
    assert run["status"] == "awaiting_checkpoint" and run["waiting_on"] == "baseline_confirm"
    assert pending(run) and run["token_read_only"] is True
    assert "opening_wait" not in await _knobs_of(tenant_id, run["id"])
    assert calls == 2


async def test_the_cap_drop_is_audited_and_keeps_the_overrun(client, owner, monkeypatch):
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    run = await _stopped(client, auth, tenant_id, swarm, clock)
    await _ceiling(tenant_id, run["id"], str(run["spent_usd"] - 0.5))
    runtime = use(swarm)
    real = runtime.status

    async def status(workflow_id):
        if workflow_id == "wf_1":
            raise RuntimeUnavailable("SwarmCloud is unavailable", status=503)
        return await real(workflow_id)

    monkeypatch.setattr(runtime, "status", status)
    await _tick_errors(client, auth)
    assert (await _knobs_of(tenant_id, run["id"]))["overrun_after_end"]
    clock.forward(86400 + get_runtime_settings().step_seconds + 60)
    await _tick_errors(client, auth)
    clock.forward(service.COST_UNKNOWN_SECONDS + 60)
    await _tick_errors(client, auth)
    knobs = await _knobs_of(tenant_id, run["id"])
    assert not knobs.get("searches")
    assert knobs["overrun_after_end"], "the overrun mark is kept"
    [event] = await _audits(tenant_id, "run.search_dropped")
    assert event.data["workflow_id"] == "wf_1" and event.data["reason"] == "cost_unknown_cap"
    [item] = (await _inbox(client, auth))["lookups"]
    assert "ceiling" in item["stuck"] and item["cancel_again"] == []


async def _cost_unknown_stopped(client, auth, tenant_id, swarm, clock) -> dict:
    run = await _stopped(client, auth, tenant_id, swarm, clock)
    swarm.html_404_ids = {"wf_1"}
    for _ in range(service.NOT_FOUND_TRIES):
        clock.forward(service.STUCK_LOOKUP_SECONDS + 1)
        await _tick_errors(client, auth)
    [item] = (await _inbox(client, auth))["lookups"]
    assert item["can_retry_lookup"] is True
    return run


async def test_retry_lookup_reads_one_entry_outside_the_row_lock_with_a_cooldown(
    client, owner, monkeypatch
):
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    run = await _cost_unknown_stopped(client, auth, tenant_id, swarm, clock)
    # Another search on the run (a label not looked up yet): Retry lookup leaves it.
    async with tenant_session(tenant_id) as s:
        row = await s.get(Run, uuid.UUID(run["id"]))
        other = {
            "label": "oracle-other-1",
            "seq": 1,
            "submitted_at": "2026-10-19T10:00:00+00:00",
            "until": "2099-01-01T00:00:00+00:00",
            "why": "cancel",
            "looked_at": None,
            "lookups": 0,
        }
        row.knobs = {**row.knobs, "searches": [*row.knobs["searches"], other]}
        await s.commit()
    runtime = use(swarm)
    real = runtime.status
    locked: list[bool] = []

    async def status(workflow_id):
        async with tenant_session(tenant_id) as s:
            try:
                await s.execute(
                    text("SELECT id FROM runs WHERE id = :id FOR UPDATE NOWAIT"), {"id": run["id"]}
                )
                locked.append(False)
            except Exception:
                locked.append(True)
            await s.rollback()
        return await real(workflow_id)

    monkeypatch.setattr(runtime, "status", status)
    listings = sum(1 for r in swarm.requests if r.url.path == "/v1/tasks")
    resp = await client.post(f"/v1/runs/{run['id']}/retry-lookup", headers=auth)
    assert resp.status_code == 200, resp.text
    assert locked == [False]
    assert sum(1 for r in swarm.requests if r.url.path == "/v1/tasks") == listings
    entries = (await _knobs_of(tenant_id, run["id"]))["searches"]
    assert [e.get("looked_at") for e in entries if e["label"] == "oracle-other-1"] == [None]
    # A second click within 30 seconds is refused; after it, read again.
    resp = await client.post(f"/v1/runs/{run['id']}/retry-lookup", headers=auth)
    assert resp.status_code == 429, resp.text
    clock.forward(31)
    resp = await client.post(f"/v1/runs/{run['id']}/retry-lookup", headers=auth)
    assert resp.status_code == 200, resp.text
    assert len(locked) == 2


async def test_a_confirmed_cancel_stuck_cancelling_is_capped_like_cost_unknown(
    client, owner, monkeypatch
):
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    run = await _at_baseline(client, auth, swarm)
    swarm.wind_down_reads = 10**6
    resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=auth)
    assert resp.status_code == 200, resp.text
    assert swarm.workflows["wf_1"].state == "CANCELLING"
    await _tick_errors(client, auth)
    assert (await _inbox(client, auth))["lookups"] == []
    clock.forward(86400 + get_runtime_settings().step_seconds + 60)
    await _tick_errors(client, auth)
    [item] = (await _inbox(client, auth))["lookups"]
    assert item["can_retry_lookup"] is True
    assert "wf_1" in item["stuck"] and "CANCELLING" in item["stuck"], item["stuck"]
    clock.forward(service.COST_UNKNOWN_SECONDS + 60)
    await _tick_errors(client, auth)
    assert not (await _knobs_of(tenant_id, run["id"])).get("searches")
    assert (await _inbox(client, auth))["lookups"] == []
    run = await get(client, auth, run["id"])
    assert any("wf_1" in n and "CANCELLING" in n for n in run["notes"]), run["notes"]
    assert await _audits(tenant_id, "run.search_dropped")


async def test_a_confirmed_cancel_later_read_as_gone_has_ended(client, owner):
    tenant_id, auth = owner
    swarm = on()
    run = await _at_baseline(client, auth, swarm)
    swarm.wind_down_reads = 1
    resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=auth)
    assert resp.status_code == 200, resp.text
    [entry] = (await _knobs_of(tenant_id, run["id"]))["searches"]
    assert entry["cancelled"] is True
    swarm.gone_reads_after_cancel = 0
    swarm._gone_reads = 100  # SwarmCloud forgot it
    await _tick_errors(client, auth)
    assert not (await _knobs_of(tenant_id, run["id"])).get("searches")
    assert (await _inbox(client, auth))["lookups"] == []
    run = await get(client, auth, run["id"])
    assert any("wf_1" in n and "ended" in n for n in run["notes"]), run["notes"]


def test_two_label_only_searches_merge():
    run = Run(knobs={})
    for _ in range(2):
        service._search_for(
            run, label="oracle-r-baseline-1", seq=1, submitted_at=None, until=None, why="cancel"
        )
    assert len(run.knobs["searches"]) == 1


async def test_the_hold_reason_never_carries_swarmclouds_error_text(client, owner, monkeypatch):
    """A failed live read is read-only, and agents see a fixed reason."""
    _, auth = owner
    swarm = on()
    runtime = use(swarm)
    await started(client, auth)
    token = token_of(swarm)

    async def fails(workflow_id):
        raise RuntimeUnavailable("cannot reach SwarmCloud: upstream-secret-detail-42", status=503)

    monkeypatch.setattr(runtime, "status", fails)
    err, said = await _push(token)
    assert err and "status unknown" in said and "upstream-secret-detail-42" not in said, said


async def test_a_checkpoint_hold_sends_a_fixed_reason(client, owner):
    """The MCP write refused during a hold (here: an open checkpoint wait): a fixed
    reason, not what Oracle records about the checkpoint."""
    _, auth = owner
    swarm = on()
    await _at_baseline(client, auth, swarm)
    err, said = await _push(token_of(swarm))
    assert err and "waiting for a checkpoint decision" in said, said
    assert "baseline_confirm" not in said and "SwarmCloud" not in said
