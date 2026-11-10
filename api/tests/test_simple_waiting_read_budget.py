"""QA (Simple Home and Decisions): GET /v1/simple/decisions/waiting, the one list Home's
waiting cards, the Decisions page's "Waiting for you" and the rail read, answers in a fixed
number of statements however many run stops wait, and holds the Inbox's other "Needs you"
rows (Add predictions first), so Home never says "Nothing waits on you" while the Inbox
shows something waiting for the same person.

Before: the list read the whole Inbox (every checkpoint's review summary, feedback,
reports, rituals, launches, tracks...) just to keep the run stops, so each read grew with
the company's open runs and the Decisions page sat on "Loading what waits on you…"; and it
left the Inbox's outcome, launch, ritual, metric and request rows out.

Against Postgres, with invented example data only.

Test cards (protects / fails_when / no_claim):

- test_waiting_reads_in_a_fixed_budget: protects=the list's statements do not grow with the
  number of pending run stops, stay under MAX_READS, and the read never builds the whole
  Inbox; fails_when=each stop costs more reads or GET /v1/inbox's builder runs;
  no_claim=wall-clock time on production data.
- test_add_predictions_waits_as_on_the_inbox: protects=the Inbox's counted "Add
  predictions" row waits on the same person in the one list, linked to Plan > Outcomes, and
  leaves once the prediction is added; fails_when=Home's list leaves it out or keeps it after;
  no_claim=the other Inbox kinds' own seeding (each reads the same row builder the Inbox does).
"""

import time

from sqlalchemy import event

from oracle.db import get_engine
from oracle.runs.models import Checkpoint, Run, RunSegment
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.outcome_helpers import outcome_world
from tests.test_roadmap import (  # noqa: F401 - fixtures
    as_user,
    owner,
    runtime,
)

WAITING = "/v1/simple/decisions/waiting"
# The list's statements, the sign-in's included, whatever the number of run stops
# (measured 53 after the fix, with or without stops).
MAX_READS = 70
MAX_SECONDS = 2.0


async def stops(ctx, n: int) -> None:
    async with tenant_session(ctx.tenant_id) as s:
        for i in range(n):
            run = Run(flow="baseline_to_prd", status="awaiting_checkpoint",
                      created_by=ctx.users["owner"].id)  # fmt: skip
            s.add(run)
            await s.flush()
            s.add(RunSegment(run_id=run.id, seq=1, name="baseline", status="succeeded"))
            s.add(Checkpoint(run_id=run.id, kind="baseline_confirm", status="pending",
                             approver_role="approver", payload={"segment_seq": 1}))  # fmt: skip
        await s.commit()


async def read(client, headers) -> tuple[int, float, dict]:
    statements: list[str] = []

    def count(conn, cursor, statement, parameters, *args):
        if "SAVEPOINT" not in statement:
            statements.append(statement)

    engine = get_engine().sync_engine
    event.listen(engine, "before_cursor_execute", count)
    try:
        start = time.perf_counter()
        resp = await client.get(WAITING, headers=headers)
        seconds = time.perf_counter() - start
    finally:
        event.remove(engine, "before_cursor_execute", count)
    assert resp.status_code == 200, resp.text
    return len(statements), seconds, resp.json()


async def test_waiting_reads_in_a_fixed_budget(client, monkeypatch):
    from oracle.runs import service as runs

    async def whole_inbox(*a, **k):
        raise AssertionError("the one list built the whole Inbox")

    monkeypatch.setattr(runs, "inbox", whole_inbox)
    ctx = await make_ctx()
    await stops(ctx, 1)
    one, _, body = await read(client, ctx.as_("approver"))
    assert len([i for i in body["items"] if i["kind"] == "run_stop"]) == 1
    await stops(ctx, 20)
    many, seconds, body = await read(client, ctx.as_("approver"))
    assert len([i for i in body["items"] if i["kind"] == "run_stop"]) == 21
    assert many <= one, (one, many)
    assert many <= MAX_READS, many
    assert seconds < MAX_SECONDS, seconds


async def test_add_predictions_waits_as_on_the_inbox(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    by_item = await outcome_world(client, auth, runtime, tenant_id)
    inbox = (await client.get("/v1/inbox", headers=auth)).json()
    row = next(r for r in inbox["outcomes"] if r["reason"] == "needs_prediction")
    items = (await client.get(WAITING, headers=auth)).json()["items"]
    item = next((i for i in items if i["key"] == f"outcome:needs_prediction:{row['id']}"), None)
    assert item is not None, items
    assert item["kind"] == "inbox"
    assert item["title"] == row["title"]
    assert item["href"] == f"/plan/outcomes?outcome={row['id']}"
    assert item["action"] == "Open"

    ship = by_item["shipping-step"]
    resp = await client.patch(
        f"/v1/outcomes/{ship['id']}",
        json={
            "prediction": {**ship["prediction"], "baseline_value": 38, "predicted_value": 41,
                           "threshold_value": 40, "direction": "increase", "unit": "%"},
            "lock_version": ship["lock_version"],
        },
        headers=auth,
    )  # fmt: skip
    assert resp.status_code == 200, resp.text
    items = (await client.get(WAITING, headers=auth)).json()["items"]
    assert [i for i in items if i["kind"] == "inbox"] == []

