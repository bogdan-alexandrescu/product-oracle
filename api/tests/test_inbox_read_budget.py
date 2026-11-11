"""inbox-perf: GET /v1/inbox on a company the size of a real one (tests/inbox_seed.py: 25
PRDs, 400 roadmap items, 2,000 Ground Truth entities, 1,500 changes, 300 of them proposed,
500 feedback items, 20 runs waiting at Confirm the baseline) answers in a fixed number of
statements however many run stops wait, and in time.

Before: each pending Confirm the baseline stop read its run's baseline twice (its gate's
live reasons, then its Inbox counts), each time in five statements or more, plus its own draft
actions, the company's confidence weights and its entities' evidence, conflicts and links:
eighteen statements a stop.

Against Postgres, with invented example data only.

Test cards (protects / fails_when / no_claim):

- test_statements_do_not_grow_with_run_stops: protects=twenty more stops waiting at Confirm
  the baseline cost no more statements, and the read stays under MAX_STATEMENTS;
  fails_when=a stop's review reads its run, actions or weights on its own;
  no_claim=wall-clock time (the timing test).
- test_batched_reads_answer_as_each_alone: protects=the Inbox read with its shared reads
  (oracle.runs.batch) answers exactly as each stop reading alone (the read before
  inbox-perf), for the owner, an approver and an API token; fails_when=a shared read
  returns another stop's rows or a stale count.
- test_answers_as_before_inbox_perf: protects=the Inbox answers exactly as the code before
  inbox-perf (its changed modules read from git at BEFORE and run in this process) on
  the same company, for the owner, an approver and an API token; fails_when=any row,
  count or field differs (the seed's cross-run case included: runs revising and proposing
  on each other's items, a withdrawn proposal, a material conflict, an owner-only stop, a
  company time zone not the default); no_claim=a checkout that cannot
  fetch that commit off CI (skipped; in CI it fails).
- test_inbox_answers_in_time (timing): protects=the owner's Inbox answers under BUDGET_MS
  (best of three warm reads); fails_when=the read slows past it; no_claim=production's
  network round trips (the statement budget covers them).
"""

import os
import subprocess
import time
import types
from pathlib import Path

import pytest
from sqlalchemy import event

from oracle import company_time
from oracle.baseline import from_run
from oracle.db import get_engine
from oracle.runs import actions, batch
from oracle.runs import service as runs_service
from oracle.simple import agenda
from tests.baseline_helpers import make_ctx
from tests.inbox_seed import CROSS_STOPS, seed_company, stops

INBOX = "/v1/inbox"
# The owner, an approver (who may not approve the owner-only stop) and the owner's API token.
READERS = ("owner", "approver", "token")
# The owner's Inbox on the seeded company, the sign-in's statements included (measured
# before inbox-perf: 502, and eighteen more for every stop waiting at Confirm the baseline;
# after: 136, whatever the number of stops; 140 at baf72ce1f, measured on the runner, with
# and without the seed's cross-run case).
MAX_STATEMENTS = 150
# Best of three warm reads (measured on the runner before inbox-perf: 930 to 1,150 ms;
# after: 445 to 560 ms, of which the Simple proposals' rows take about 300).
BUDGET_MS = 700


async def read(client, headers) -> tuple[int, dict]:
    statements: list[str] = []

    def count(conn, cursor, statement, *args):
        if "SAVEPOINT" not in statement:
            statements.append(statement)

    engine = get_engine().sync_engine
    event.listen(engine, "before_cursor_execute", count)
    try:
        resp = await client.get(INBOX, headers=headers)
    finally:
        event.remove(engine, "before_cursor_execute", count)
    assert resp.status_code == 200, resp.text
    return len(statements), resp.json()


async def test_statements_do_not_grow_with_run_stops(client):
    ctx = await make_ctx()
    await seed_company(ctx)
    await read(client, ctx.as_("owner"))
    before, body = await read(client, ctx.as_("owner"))
    assert len(body["checkpoints"]) == 20 + CROSS_STOPS
    await stops(ctx, 20)
    after, body = await read(client, ctx.as_("owner"))
    assert len(body["checkpoints"]) == 40 + CROSS_STOPS
    print(f"statements: 20 stops {before}, 40 stops {after}")
    # Twenty more stops cost not one more statement.
    assert after == before, (before, after)
    assert after <= MAX_STATEMENTS, after


async def test_batched_reads_answer_as_each_alone(client, monkeypatch):
    ctx = await make_ctx()
    await seed_company(ctx)
    shared = {who: (await read(client, ctx.as_(who)))[1] for who in READERS}
    # The twenty stops, and cross_runs' A and B (C's proposals do not block).
    assert sum(1 for c in shared["owner"]["checkpoints"] if c["summary"]["blocking"]) == 22

    async def alone(key, load):
        return await load()

    async def each(kind, keys, load):
        return {k: v for k, v in (await load(keys)).items() if k in keys}

    monkeypatch.setattr(batch, "once", alone)
    monkeypatch.setattr(batch, "many", each)
    monkeypatch.setattr(batch, "put", lambda key, value: None)
    for who, body in shared.items():
        assert (await read(client, ctx.as_(who)))[1] == body, who


# The commit right before inbox-perf (waiting-speed's last), and the modules inbox-perf
# changed. (An earlier BEFORE, train BL's 5c6d57bed, reads the same: the two commits between
# them change only the waiting list.) Its full id, so a shallow checkout can fetch it.
BEFORE = "e191493d1580ea712e31566fb69a9976be819f2c"
CHANGED = (from_run, actions, runs_service, agenda, company_time)


def _show(root: Path, path: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "show", f"{BEFORE}:{path.relative_to(root)}"],
        cwd=root, capture_output=True, text=True, check=False,
    )  # fmt: skip


def before(module: types.ModuleType) -> dict:
    """``module``'s functions as they were at BEFORE, run against this process's modules.
    A checkout without BEFORE (CI's is one commit deep) fetches it; in CI one that still
    has not got it fails, elsewhere (offline) it skips."""
    path = Path(module.__file__).resolve()
    root = Path(__file__).resolve().parents[2]
    got = _show(root, path)
    if got.returncode != 0:
        fetch = ["git", "fetch", "--no-tags", "--depth=1", "origin", BEFORE]
        subprocess.run(fetch, cwd=root, capture_output=True, check=False, timeout=300)
        got = _show(root, path)
    if got.returncode != 0:
        if os.environ.get("CI"):
            pytest.fail(f"{BEFORE} is not in this checkout and could not be fetched")
        pytest.skip(f"{BEFORE} is not in this checkout and could not be fetched")
    ns: dict = {"__name__": module.__name__, "__file__": str(path)}
    exec(compile(got.stdout, str(path), "exec"), ns)  # noqa: S102 - our own code, from git
    return {k: v for k, v in ns.items() if isinstance(v, types.FunctionType)}


async def test_answers_as_before_inbox_perf(client, monkeypatch):
    ctx = await make_ctx()
    await seed_company(ctx)
    now = {who: (await read(client, ctx.as_(who)))[1] for who in READERS}
    for module in CHANGED:
        for name, fn in before(module).items():
            if getattr(module, name, None) is not None:
                monkeypatch.setattr(module, name, fn)
    for who, body in now.items():
        count, was = await read(client, ctx.as_(who))
        assert was == body, who
    # The old code really ran: eighteen more statements for each stop.
    assert count > MAX_STATEMENTS, count


@pytest.mark.timing
async def test_inbox_answers_in_time(client):
    ctx = await make_ctx()
    await seed_company(ctx)
    headers = ctx.as_("owner")
    await read(client, headers)
    times = []
    for _ in range(3):
        t0 = time.perf_counter()
        await read(client, headers)
        times.append((time.perf_counter() - t0) * 1000)
    print("owner Inbox: " + ", ".join(f"{t:.0f}" for t in times) + " ms")
    assert min(times) < BUDGET_MS, times
