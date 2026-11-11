# ruff: noqa: F811 - the ritual fixtures are imported
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
- test_failed_ritual_offers_retry_as_on_the_inbox: protects="Ritual failed to prepare" waits
  with Retry (its ritual's id, for POST /v1/rituals/{id}/prepare) and opens Company > Rituals,
  as the Inbox's row does; fails_when=it offers only Open on the failed occurrence's own page;
  no_claim=the Retry button's click (web/e2e).

The budget is in statements, never in seconds: a slow machine neither fails nor hides it.
"""

from sqlalchemy import event

from oracle.db import get_engine
from oracle.rituals import blocks
from oracle.runs.models import Checkpoint, Run, RunSegment
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.outcome_helpers import outcome_world
from tests.ritual_helpers import (  # noqa: F401 - fixtures
    at,
    ctx,
    occurrences_of,
    rituals_of,
    tick,
)
from tests.test_roadmap import (  # noqa: F401 - fixtures
    as_user,
    owner,
    runtime,
)

WAITING = "/v1/simple/decisions/waiting"
# The list's statements, the sign-in's included, whatever the number of run stops
# (measured 58 after the fix, with 1 stop or 21; before it, 97 and 277: about nine more
# statements for every stop, from the Inbox's review summary of each).
MAX_READS = 64


async def stops(ctx, n: int) -> None:
    async with tenant_session(ctx.tenant_id) as s:
        for _ in range(n):
            run = Run(flow="baseline_to_prd", status="awaiting_checkpoint",
                      created_by=ctx.users["owner"].id)  # fmt: skip
            s.add(run)
            await s.flush()
            s.add(RunSegment(run_id=run.id, seq=1, name="baseline", status="succeeded"))
            s.add(Checkpoint(run_id=run.id, kind="baseline_confirm", status="pending",
                             approver_role="approver", payload={"segment_seq": 1}))  # fmt: skip
        await s.commit()


async def read(client, headers) -> tuple[int, dict]:
    statements: list[str] = []

    def count(conn, cursor, statement, parameters, *args):
        if "SAVEPOINT" not in statement:
            statements.append(statement)

    engine = get_engine().sync_engine
    event.listen(engine, "before_cursor_execute", count)
    try:
        resp = await client.get(WAITING, headers=headers)
    finally:
        event.remove(engine, "before_cursor_execute", count)
    assert resp.status_code == 200, resp.text
    return len(statements), resp.json()


async def test_waiting_reads_in_a_fixed_budget(client, monkeypatch):
    from oracle.runs import service as runs

    async def whole_inbox(*a, **k):
        raise AssertionError("the one list built the whole Inbox")

    monkeypatch.setattr(runs, "inbox", whole_inbox)
    ctx = await make_ctx()
    await stops(ctx, 1)
    one, body = await read(client, ctx.as_("approver"))
    assert len([i for i in body["items"] if i["kind"] == "run_stop"]) == 1
    await stops(ctx, 20)
    many, body = await read(client, ctx.as_("approver"))
    assert len([i for i in body["items"] if i["kind"] == "run_stop"]) == 21
    # Twenty more stops cost not one more statement.
    assert many == one, (one, many)
    assert many <= MAX_READS, many


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
    assert [i for i in items if i["key"].startswith("outcome:needs_prediction:")] == []


async def test_failed_ritual_offers_retry_as_on_the_inbox(client, ctx, at, monkeypatch):  # noqa: F811
    from oracle.rituals import service as rituals

    async def has_goal(db) -> bool:
        return True

    # The built-ins start on, as for a company with a confirmed goal.
    monkeypatch.setattr(rituals, "has_confirmed_goal", has_goal)
    await tick(ctx.tenant_id)
    seeded = await rituals_of(ctx.tenant_id)

    async def broken(*args, **kwargs):
        raise RuntimeError("tracks unavailable")

    monkeypatch.setitem(blocks.BUILDERS, "tracks", broken)
    at(max(seeded[k].next_due_at for k in ("goals_checkin", "roadmap_refresh", "goals_review")))
    for _ in range(3):
        await tick(ctx.tenant_id)
    by_ritual = {o.ritual_id: o for o in await occurrences_of(ctx.tenant_id)}
    failed = by_ritual[seeded["roadmap_refresh"].id]
    assert failed.status == "failed"
    items = (await client.get(WAITING, headers=ctx.as_("owner"))).json()["items"]
    item = next((i for i in items if i["key"] == f"ritual:failed:{failed.id}"), None)
    assert item is not None, items
    assert item["title"].startswith("Ritual failed to prepare · ")
    assert item["action"] == "Retry"
    assert item["ref_id"] == str(seeded["roadmap_refresh"].id)
    assert item["href"] == "/company/rituals"
