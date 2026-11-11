"""The Inbox's goal suggestions read the roadmap they are filed under once per read, however
many goals the person decides on: with no company roadmap, a goal with no items files its
suggestions under the company's first roadmap, and the Inbox looked that up once per goal.
Against Postgres. Made-up names only.

Test cards (protects / fails_when / no_claim):

- test_goal_rows_cost_the_same_for_one_goal_or_four: protects=with no company roadmap, the
  decider's Inbox with open suggestions on four goals with no items costs no more statements
  than with one, and still lists every suggestion under the first roadmap;
  fails_when=inbox_rows looks up a goal's roadmap once per goal; no_claim=wall-clock time
  (test_inbox_read_budget's timing test).
"""

import uuid

from sqlalchemy import event

from oracle.db import get_engine
from oracle.simple.models import SimpleGoalSuggestion
from oracle.tenancy import tenant_session
from tests.test_simple_additions_api import World
from tests.test_simple_roadmap_api import Seed

INBOX = "/v1/inbox"


async def _read(client, headers) -> tuple[int, dict]:
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


async def _suggest(w: World, goal_ids: list[str]) -> None:
    async with tenant_session(w.ctx.tenant_id) as s:
        for i, gid in enumerate(goal_ids):
            s.add(SimpleGoalSuggestion(goal_id=uuid.UUID(gid), title=f"Example idea {i}",
                                       outcome="Fewer support tickets", why="Example",
                                       evidence=[], origin="auto"))  # fmt: skip
        await s.commit()


async def test_goal_rows_cost_the_same_for_one_goal_or_four(client):
    w = await World().build()
    async with tenant_session(w.ctx.tenant_id) as s:
        seed = Seed(s)
        extra = [await seed.entity("goal", f"example-goal-{i}") for i in range(3)]
        await s.commit()
        goals = [w.goals["quiet"], *(str(g.id) for g in extra)]
    headers = w.as_("decider")
    await _suggest(w, goals[:1])
    await _read(client, headers)
    one, body = await _read(client, headers)
    assert [r["goal"]["id"] for r in body["simple_goal_suggestions"]] == goals[:1]
    await _suggest(w, goals[1:])
    four, body = await _read(client, headers)
    rows = body["simple_goal_suggestions"]
    assert sorted(r["goal"]["id"] for r in rows) == sorted(goals)
    # Filed under the first roadmap: the World's, there being no company roadmap.
    assert {r["document_id"] for r in rows} == {w.roadmap_id}
    print(f"statements: 1 goal {one}, 4 goals {four}")
    assert four == one, (one, four)
