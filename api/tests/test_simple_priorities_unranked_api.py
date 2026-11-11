"""prio-unranked: the priorities read lists the live, non-draft roadmap items that have no
ranked feature (``unranked``), so Simple Priorities shows them under the ranked rows. Against
Postgres; the world is tests.test_simple_priorities_api's (pay-6 has no feature, pay-5 is a
draft, pay-7 is ledger's second item). Each test's card is its docstring.
"""

from sqlalchemy import select

from oracle.baseline.models import Entity
from oracle.roadmap.models import RoadmapItem
from oracle.tenancy import tenant_session
from tests.test_simple_changes_api import clock, make_people  # noqa: F401
from tests.test_simple_priorities_api import World


async def test_unranked_lists_items_with_no_ranked_feature(client):
    """protects=an item with no feature (pay-6) is listed in ``unranked`` with its id, code,
    title and roadmap; a draft (pay-5) and an item whose feature is ranked (pay-7, ledger's
    later item) are not; fails_when=``unranked`` is missing, lists a draft or a ranked
    feature's item; no_claim=the web's look."""
    ctx = await make_people()
    w = await World(ctx).build()
    out = await w.read(client)
    un = out["unranked"]
    assert [u["code"] for u in un] == ["pay-6"]
    assert un[0]["item_id"] == w.ids["pay-6"]
    assert un[0]["title"]
    assert un[0]["roadmap"]["slug"] == "payments"
    assert "pay-6" not in {r["code"] for r in out["rows"]}


async def test_unranked_item_moves_up_once_its_feature_ranks(client):
    """protects=an item that gains a ranked feature leaves ``unranked`` and is that feature's
    row; fails_when=it stays unranked or shows twice; no_claim=the rank it takes."""
    ctx = await make_people()
    w = await World(ctx).build()
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.scalar(select(RoadmapItem).where(RoadmapItem.item_key == "pay-6"))
        row.feature_id = w.ids["insights"]
        await s.commit()
    out = await w.read(client)
    assert out["unranked"] == []
    rows = {r["feature_id"]: r for r in out["rows"]}
    assert rows[w.ids["insights"]]["item_id"] == w.ids["pay-6"]


async def test_rows_drafts_and_unranked_carry_every_goal_of_the_item(client):
    """protects=each row, draft and unranked item carries the item's own goals in order
    (``goal_ids``), so Archive and Delete of a goal list an item that serves it second;
    fails_when=``goal_ids`` is missing or holds the first goal only; no_claim=the web."""
    ctx = await make_people()
    w = await World(ctx).build()
    async with tenant_session(ctx.tenant_id) as s:
        goals = {e.key: e.id for e in await s.scalars(select(Entity).where(Entity.type == "goal"))}
        both = [goals["retention"], goals["growth"]]
        for key in ("pay-1", "pay-5", "pay-6"):
            row = await s.scalar(select(RoadmapItem).where(RoadmapItem.item_key == key))
            row.goal_ids = both
        await s.commit()
    out = await w.read(client)
    want = [str(g) for g in both]
    assert {r["code"]: r["goal_ids"] for r in out["rows"]}["pay-1"] == want
    assert {d["code"]: d["goal_ids"] for d in out["drafts"]}["pay-5"] == want
    assert {u["code"]: u["goal_ids"] for u in out["unranked"]}["pay-6"] == want


async def test_an_item_left_with_only_an_archived_goal_reads_no_goal(client):
    """protects=an item serving growth and an archived retention, whose growth is archived
    to no goal, reads No goal in Priorities (as the dialog counted it) while keeping
    retention in ``goal_ids`` for Undo; fails_when=the archived goal shows as its goal;
    no_claim=the roadmap (its own test)."""
    ctx = await make_people()
    w = await World(ctx).build()
    async with tenant_session(ctx.tenant_id) as s:
        goals = {e.key: e for e in await s.scalars(select(Entity).where(Entity.type == "goal"))}
        goals["retention"].status = "rejected"
        both = [goals["growth"].id, goals["retention"].id]
        row = await s.scalar(select(RoadmapItem).where(RoadmapItem.item_key == "pay-6"))
        row.goal_ids = both
        await s.commit()
    r = await client.post(f"/v1/simple/goal-buckets/goals/{both[0]}/archive",
                          headers=ctx.as_("owner"), json={"to_goal_id": None})  # fmt: skip
    assert r.status_code == 200, r.text
    un = {u["code"]: u for u in (await w.read(client))["unranked"]}["pay-6"]
    assert un["goal"] is None
    assert un["goal_ids"] == [str(both[1])]
