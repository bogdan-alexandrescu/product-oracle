"""prio-ux (#1738): finished work is not ranked. A feature whose every live roadmap item is
Done leaves the priorities read (rows, unranked, buckets); a feature with a Done slice and
an open one ranks by its open item. Against Postgres; the world is
tests.test_simple_priorities_api's (ledger: pay-1 now and pay-7 later; exports: pay-3 now).
Each test's card is its docstring.
"""

from sqlalchemy import select

from oracle.roadmap.models import RoadmapItem
from oracle.tenancy import tenant_session
from tests.test_simple_changes_api import clock, make_people  # noqa: F401
from tests.test_simple_priorities_api import World

SHIPPED = {"note": "Shipped", "on": "2026-11-01", "by": "Example Person"}


async def _ship(ctx, *keys: str) -> None:
    async with tenant_session(ctx.tenant_id) as s:
        for key in keys:
            row = await s.scalar(select(RoadmapItem).where(RoadmapItem.item_key == key))
            row.shipped = SHIPPED
        await s.commit()


async def test_a_feature_whose_items_are_all_done_is_not_ranked(client):
    """protects=exports, whose only item (pay-3) is Done, is no row, not unranked and not in
    a goal bucket's weeks; fails_when=a Done feature still ranks (the live NEW at #1);
    no_claim=the web's renumbering."""
    ctx = await make_people()
    w = await World(ctx).build()
    await _ship(ctx, "pay-3")
    out = await w.read(client)
    assert "pay-3" not in {r["code"] for r in out["rows"]}
    assert w.ids["exports"] not in {r["feature_id"] for r in out["rows"]}
    assert "pay-3" not in {u["code"] for u in out["unranked"]}
    assert all("pay-3" not in b["codes"] for b in out["buckets"])


async def test_a_done_slice_gives_way_to_the_open_one(client):
    """protects=ledger with pay-1 Done and pay-7 open ranks by pay-7; with both Done it is no
    row; fails_when=the Done slice stands for the feature; no_claim=the rank it takes."""
    ctx = await make_people()
    w = await World(ctx).build()
    await _ship(ctx, "pay-1")
    rows = {r["feature_id"]: r for r in (await w.read(client))["rows"]}
    assert rows[w.ids["ledger"]]["code"] == "pay-7"
    await _ship(ctx, "pay-7")
    rows = {r["feature_id"]: r for r in (await w.read(client))["rows"]}
    assert w.ids["ledger"] not in rows
