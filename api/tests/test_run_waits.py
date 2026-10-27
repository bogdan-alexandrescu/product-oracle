"""Why SwarmCloud holds a run's step, in plain words (run page, Runs row, Inbox); a run
whose workflow has started no agent 30 minutes after submission, as an Inbox row; and a
run whose key expired while its step waited in SwarmCloud's queue: what its error says,
and the one automatic restart. Driven through the fake SwarmCloud, with invented data."""

import uuid
from datetime import datetime, timedelta

import pytest
from sqlalchemy import event

from oracle.db import get_engine
from oracle.runs import service
from oracle.runs.models import Run
from oracle.swarm import set_runtime
from oracle.swarm.settings import get_runtime_settings
from oracle.tenancy import tenant_session
from tests.fixtures import seed_auth
from tests.swarmcloud_fake import FakeSwarmCloud
from tests.test_runs import get, started, tick

PUBLIC = "https://oracle.example.test"
FIRST = "baseline-1-researcher"
QUOTA = "Waiting for a Claude account: the accounts lent to Oracle have no quota left"
ROOM = "Waiting for room in SwarmCloud"
# The reads of one ``GET /v1/inbox`` with no rows but ended runs that waited in SwarmCloud's
# queue (tests.test_inbox_checkpoint_summary's MAX_INBOX_READS bounds it with 20
# checkpoints): the same however many of them there are.
MAX_INBOX_READS = 72


@pytest.fixture(autouse=True)
def settings(monkeypatch):
    monkeypatch.setenv("ORACLE_PUBLIC_URL", PUBLIC)
    for key in ("ORACLE_CHECKPOINT_WAIT_SECONDS", "ORACLE_STEP_SECONDS"):
        monkeypatch.delenv(key, raising=False)
    get_runtime_settings.cache_clear()
    yield
    get_runtime_settings.cache_clear()
    set_runtime(None)


@pytest.fixture
async def owner():
    return await seed_auth()


class _Clocks:
    """Oracle's clock and the fake SwarmCloud's, moved forward together."""

    def __init__(self, monkeypatch, swarm: FakeSwarmCloud) -> None:
        self.offset = timedelta(0)
        self.swarm = swarm
        real = service._now
        monkeypatch.setattr(service, "_now", lambda: real() + self.offset)

    def forward(self, seconds: float) -> None:
        self.offset += timedelta(seconds=seconds)
        self.swarm.tick(seconds)


def _swarm() -> FakeSwarmCloud:
    swarm = FakeSwarmCloud(mcp=True, await_input=True, service_answer=True)
    set_runtime(swarm.runtime())
    return swarm


async def _row(client, auth, run_id) -> dict:
    resp = await client.get("/v1/runs", headers=auth)
    assert resp.status_code == 200, resp.text
    return next(r for r in resp.json() if r["id"] == run_id)


async def _inbox(client, auth) -> dict:
    resp = await client.get("/v1/inbox", headers=auth)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _key_seconds(swarm: FakeSwarmCloud, n: int = -1) -> int:
    return swarm.submissions()[n]["mcp_credentials"]["oracle"]["expires_in"]


def _token(swarm: FakeSwarmCloud, n: int = -1) -> str:
    return swarm.submissions()[n]["mcp_credentials"]["oracle"]["value"]


# --------------------------------------------------------------------------- park reasons


async def test_a_quota_park_shows_its_sentence_and_since_on_the_run_and_its_row(
    client, owner, monkeypatch
):
    """protects=a step SwarmCloud parks with PROVIDER_QUOTA_EXHAUSTED reads, on the run's
    segment and its Runs row, as the plain sentence with the moment Oracle first read it
    held (kept on later reads); fails_when=the run shows a plain Running with no reason,
    the since moves on each read, or the row and the segment disagree;
    no_claim=the Company time zone's rendering (the web formats ``since``)."""
    _, auth = owner
    swarm = _swarm()
    clocks = _Clocks(monkeypatch, swarm)
    swarm.held[FIRST] = "PROVIDER_QUOTA_EXHAUSTED"
    run = await started(client, auth)
    await tick(client, auth)
    first = service._now()
    run = await get(client, auth, run["id"])
    assert run["status"] == "running"
    waiting = run["segments"][0]["queue_wait"]
    assert waiting["code"] == "PROVIDER_QUOTA_EXHAUSTED"
    assert waiting["text"] == QUOTA
    since = datetime.fromisoformat(waiting["since"])
    assert abs((since - first).total_seconds()) < 60
    assert (await _row(client, auth, run["id"]))["queue_wait"] == waiting

    clocks.forward(600)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["segments"][0]["queue_wait"]["since"] == waiting["since"]
    assert (await _row(client, auth, run["id"]))["queue_wait"]["since"] == waiting["since"]


async def test_an_unknown_park_reason_shows_its_code(client, owner):
    """protects=a park reason Oracle has no words for is shown as SwarmCloud's code,
    verbatim; fails_when=an unknown reason is hidden or reworded; no_claim=which codes
    SwarmCloud will add."""
    _, auth = owner
    swarm = _swarm()
    swarm.held[FIRST] = "TENANT_EMBARGO_7"
    run = await started(client, auth)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    waiting = run["segments"][0]["queue_wait"]
    assert waiting["code"] == "TENANT_EMBARGO_7" and "TENANT_EMBARGO_7" in waiting["text"]
    assert (await _row(client, auth, run["id"]))["queue_wait"]["code"] == "TENANT_EMBARGO_7"


async def test_a_dependency_wait_shows_nothing_extra(client, owner):
    """protects=DEPENDENCY_INCOMPLETE stays an ordinary wait; fails_when=it shows a
    waiting text on the run or its row; no_claim=the steps after it."""
    _, auth = owner
    swarm = _swarm()
    swarm.held[FIRST] = "DEPENDENCY_INCOMPLETE"
    other = await started(client, auth)
    await tick(client, auth)
    other = await get(client, auth, other["id"])
    assert other["status"] == "running"
    assert other["segments"][0]["queue_wait"] is None
    assert (await _row(client, auth, other["id"]))["queue_wait"] is None


@pytest.mark.parametrize(
    "reason",
    [
        "CAPACITY_EXHAUSTED",
        "POOL_EXHAUSTED",
        "CONCURRENCY_LIMIT",
        "NO_SLOT_AVAILABLE",
        "SLOTS_FULL",
        "NO_ROOM",
        "TENANT_QUEUE_FULL",
    ],
)
async def test_capacity_and_pool_waits_read_as_waiting_for_room(client, owner, reason):
    """protects=owner, 2026-10-26: a park reason containing CAPACITY, POOL, CONCURRENCY,
    SLOT or SLOTS, NO_ROOM or QUEUE_FULL reads "Waiting for room in SwarmCloud";
    fails_when=one of them shows its raw code (SLOT inside a longer code included);
    no_claim=the full list of SwarmCloud's codes."""
    _, auth = owner
    swarm = _swarm()
    swarm.held[FIRST] = reason
    run = await started(client, auth)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["segments"][0]["queue_wait"]["text"] == ROOM


async def test_a_hold_on_the_workflows_first_read_is_since_its_submission(
    client, owner, monkeypatch
):
    """protects=owner, 2026-10-26: "waiting since" is Oracle's first read of the hold, and
    on the workflow's first read its submission; fails_when=the first read's moment is
    shown though the workflow was submitted earlier; no_claim=SwarmCloud's own park time."""
    _, auth = owner
    swarm = _swarm()
    clocks = _Clocks(monkeypatch, swarm)
    swarm.held[FIRST] = "PROVIDER_QUOTA_EXHAUSTED"
    run = await started(client, auth)
    submitted = service._now()
    clocks.forward(20 * 60)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    since = datetime.fromisoformat(run["segments"][0]["queue_wait"]["since"])
    assert abs((since - submitted).total_seconds()) < 60, (since, submitted)


# --------------------------------------------------------------------------- not started


async def test_no_agent_after_30_minutes_is_an_inbox_row_that_clears_when_one_starts(
    client, owner, monkeypatch
):
    """protects=a run whose workflow started no agent 30 minutes after submission is a
    stuck row in the Inbox, counted by the badge, saying what it waits for and since when;
    it clears once an agent starts; fails_when=the row is missing, not counted, shown
    before 30 minutes, or stays after the agent started; no_claim=the web's buttons."""
    _, auth = owner
    swarm = _swarm()
    clocks = _Clocks(monkeypatch, swarm)
    swarm.held[FIRST] = "PROVIDER_QUOTA_EXHAUSTED"
    run = await started(client, auth)
    await tick(client, auth)
    before = await _inbox(client, auth)
    assert run["id"] not in [r["id"] for r in before["lookups"]]

    clocks.forward(31 * 60)
    await tick(client, auth)
    inbox = await _inbox(client, auth)
    [row] = [r for r in inbox["lookups"] if r["id"] == run["id"]]
    assert QUOTA in row["stuck"] and "since" in row["stuck"]
    assert "30 min" in row["stuck"] or "31 min" in row["stuck"]
    assert inbox["total"] == before["total"] + 1
    assert row["status"] == "running" and row["can_retry"] is False

    del swarm.held[FIRST]
    await tick(client, auth)
    after = await _inbox(client, auth)
    assert run["id"] not in [r["id"] for r in after["lookups"]]
    assert after["total"] == before["total"] + len(after["checkpoints"]) - len(
        before["checkpoints"]
    )
    run = await get(client, auth, run["id"])
    assert run["segments"][0]["queue_wait"] is None


async def test_a_queued_step_without_a_park_reason_is_an_inbox_row_after_30_minutes(
    client, owner, monkeypatch
):
    """protects=a run whose first step is only queued (READY, no park reason) is flagged
    too after 30 minutes; fails_when=only parked runs are flagged; no_claim=why
    SwarmCloud has not started it."""
    _, auth = owner
    swarm = _swarm()
    clocks = _Clocks(monkeypatch, swarm)
    swarm.steps_per_poll = 0
    run = await started(client, auth)
    await tick(client, auth)
    clocks.forward(31 * 60)
    await tick(client, auth)
    inbox = await _inbox(client, auth)
    [row] = [r for r in inbox["lookups"] if r["id"] == run["id"]]
    assert "started no agent" in row["stuck"]


async def test_the_not_started_row_clears_when_the_run_ends(client, owner, monkeypatch):
    """protects=the not-started row goes once the run ends (Cancel);
    fails_when=a cancelled run stays a stuck row; no_claim=SwarmCloud's cancel."""
    _, auth = owner
    swarm = _swarm()
    clocks = _Clocks(monkeypatch, swarm)
    swarm.held[FIRST] = "PROVIDER_QUOTA_EXHAUSTED"
    run = await started(client, auth)
    await tick(client, auth)
    clocks.forward(31 * 60)
    await tick(client, auth)
    assert run["id"] in [r["id"] for r in (await _inbox(client, auth))["lookups"]]
    resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=auth)
    assert resp.status_code == 200, resp.text
    assert run["id"] not in [r["id"] for r in (await _inbox(client, auth))["lookups"]]
    assert (await get(client, auth, run["id"]))["segments"][0]["queue_wait"] is None


async def _not_started_then_cancelled(client, auth, swarm, clocks) -> str:
    """A run flagged as not started, then cancelled from the Inbox: its id."""
    swarm.held[FIRST] = "PROVIDER_QUOTA_EXHAUSTED"
    run = await started(client, auth)
    await tick(client, auth)
    clocks.forward(31 * 60)
    await tick(client, auth)
    resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=auth)
    assert resp.status_code == 200, resp.text
    return run["id"]


class _InboxReads:
    """The statements of one Inbox read, and the runs its stuck-runs read loaded."""

    def __init__(self, monkeypatch) -> None:
        self.statements: list[str] = []
        self.loaded: list[uuid.UUID] = []
        real = service._manages

        def manages(principal, run):
            self.loaded.append(run.id)
            return real(principal, run)

        monkeypatch.setattr(service, "_manages", manages)

    async def read(self, client, auth) -> dict:
        self.statements.clear()
        self.loaded.clear()

        def count(conn, cursor, statement, *args):
            self.statements.append(statement)

        engine = get_engine().sync_engine
        event.listen(engine, "before_cursor_execute", count)
        try:
            return await _inbox(client, auth)
        finally:
            event.remove(engine, "before_cursor_execute", count)

    @property
    def reads(self) -> int:
        return sum(1 for st in self.statements if "SAVEPOINT" not in st)


async def test_a_finished_run_with_a_stale_wait_is_neither_loaded_nor_shown(
    client, owner, monkeypatch
):
    """protects=#732 review: the run's queue_wait knob goes when the run ends, and a
    finished run that still carries one (written before the fix) is neither loaded by the
    Inbox nor shown; fails_when=the knob stays on a cancelled run, or the Inbox's
    stuck-runs read loads a finished run for it; no_claim=the other knobs' rows."""
    tenant_id, auth = owner
    swarm = _swarm()
    clocks = _Clocks(monkeypatch, swarm)
    run_id = await _not_started_then_cancelled(client, auth, swarm, clocks)
    async with tenant_session(tenant_id) as s:
        run = await s.get(Run, uuid.UUID(run_id))
        assert run is not None and run.status == "cancelled"
        assert "queue_wait" not in (run.knobs or {})
        # A finished run's stale knob, as runs that ended before the fix kept it.
        stale = {
            "workflow_id": "wf-stale",
            "seq": 1,
            "submitted_at": "2026-01-01T00:00:00+00:00",
            "started": False,
            "held": {"step_id": FIRST, "code": "PROVIDER_QUOTA_EXHAUSTED", "since": "x"},
        }
        run.knobs = {**(run.knobs or {}), "queue_wait": stale}
        await s.commit()
    reads = _InboxReads(monkeypatch)
    inbox = await reads.read(client, auth)
    assert uuid.UUID(run_id) not in reads.loaded
    assert run_id not in [r["id"] for r in inbox["lookups"]]
    assert (await _row(client, auth, run_id))["queue_wait"] is None


async def test_the_inbox_read_does_not_grow_with_finished_runs(client, owner, monkeypatch):
    """protects=#732 review: the Inbox's stuck-runs read selects only running runs' waits,
    so its statements and the runs it loads stay the same however many runs waited in
    SwarmCloud's queue and ended; fails_when=a finished run that waited is loaded, or
    the read count grows from one such run to three; no_claim=wall time."""
    _, auth = owner
    swarm = _swarm()
    clocks = _Clocks(monkeypatch, swarm)
    reads = _InboxReads(monkeypatch)
    ended = [await _not_started_then_cancelled(client, auth, swarm, clocks)]
    await reads.read(client, auth)
    one, loaded_one = reads.reads, len(reads.loaded)
    ended += [await _not_started_then_cancelled(client, auth, swarm, clocks) for _ in range(2)]
    await reads.read(client, auth)
    assert not {uuid.UUID(i) for i in ended} & set(reads.loaded)
    assert len(reads.loaded) == loaded_one == 0
    assert reads.reads == one <= MAX_INBOX_READS, (reads.reads, one)


# --------------------------------------------------------------------------- queued expiry


async def _expire_in_queue(client, auth, swarm, clocks) -> None:
    """The run's current step waits parked past its key's lifetime, then is let go: it
    fails at once with mcp_credential_expired."""
    swarm.held[FIRST] = "PROVIDER_QUOTA_EXHAUSTED"
    await tick(client, auth)
    clocks.forward(_key_seconds(swarm) + 60)
    await tick(client, auth)
    del swarm.held[FIRST]
    await tick(client, auth)


async def test_restart_once_then_a_second_queued_expiry_fails_the_run(client, owner, monkeypatch):
    """protects=a run whose key expired while its step waited in SwarmCloud's queue is
    resubmitted once (same segment, a new attempt, a freshly minted key) with the note;
    a second such expiry fails it with the queue message, never the checkpoint advice;
    fails_when=the first expiry fails the run, reuses the old key, loops, or the error
    says to lower ORACLE_CHECKPOINT_WAIT_SECONDS; no_claim=SwarmCloud's own retry."""
    _, auth = owner
    swarm = _swarm()
    clocks = _Clocks(monkeypatch, swarm)
    run = await started(client, auth)
    await _expire_in_queue(client, auth, swarm, clocks)
    # The restart is queued by the tick that read the failure, submitted after it; its
    # step is held again.
    swarm.held[FIRST] = "PROVIDER_QUOTA_EXHAUSTED"
    await tick(client, auth)
    out = await get(client, auth, run["id"])
    assert out["status"] == "running", out["error"]
    assert len(swarm.submissions()) == 2
    assert _token(swarm, 0) != _token(swarm, 1)
    hours = _key_seconds(swarm, 0) // 3600
    note = f"Restarted once: its key expired while it waited {hours} h"
    assert any(n.startswith(note) and "in SwarmCloud's queue" in n for n in out["notes"]), out[
        "notes"
    ]
    attempts = out["segments"][0]["attempts"]
    assert [a["attempt"] for a in attempts] == [1, 2]
    assert attempts[0]["state"] == "failed"

    await _expire_in_queue(client, auth, swarm, clocks)
    await tick(client, auth)
    out = await get(client, auth, run["id"])
    assert out["status"] == "failed"
    assert len(swarm.submissions()) == 2
    assert "key expired while it waited in SwarmCloud's queue for" in out["error"]
    assert "restarted it once" in out["error"]
    assert "ORACLE_CHECKPOINT_WAIT_SECONDS" not in out["error"]


async def test_a_key_that_expired_after_work_began_keeps_the_checkpoint_advice(
    client, owner, monkeypatch
):
    """protects=a key that expired after the failing step had started keeps today's
    advice (lower ORACLE_CHECKPOINT_WAIT_SECONDS) and is not restarted;
    fails_when=it reads as a queue wait or is resubmitted; no_claim=how long work ran."""
    _, auth = owner
    swarm = _swarm()
    clocks = _Clocks(monkeypatch, swarm)
    run = await started(client, auth)
    began = swarm.now + timedelta(seconds=60)
    clocks.forward(_key_seconds(swarm) + 60)
    swarm.step_failure[FIRST] = ("mcp_credential_expired", "the workflow's credential expired")
    swarm.forged[FIRST] = {"started_at": began.isoformat()}
    await tick(client, auth)
    await tick(client, auth)
    out = await get(client, auth, run["id"])
    assert out["status"] == "failed"
    assert "ORACLE_CHECKPOINT_WAIT_SECONDS" in out["error"]
    assert "queue" not in out["error"]
    assert len(swarm.submissions()) == 1


async def test_no_restart_when_the_failed_attempt_cost_money(client, owner, monkeypatch):
    """protects=a queued expiry whose failed attempt spent money is never restarted: the
    run fails and says it must be started again; fails_when=Oracle resubmits it;
    no_claim=what the money bought."""
    _, auth = owner
    swarm = _swarm()
    clocks = _Clocks(monkeypatch, swarm)
    run = await started(client, auth)
    swarm.forged[FIRST] = {"cost_usd_total": 0.42}
    await _expire_in_queue(client, auth, swarm, clocks)
    await tick(client, auth)
    out = await get(client, auth, run["id"])
    assert out["status"] == "failed"
    assert len(swarm.submissions()) == 1
    assert "key expired while it waited in SwarmCloud's queue for" in out["error"]
    assert "start the run again" in out["error"].lower()
    assert out["spent_usd"] == pytest.approx(0.42)
