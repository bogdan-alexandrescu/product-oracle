"""timeline-order (#1553): the Simple roadmap read carries each item's place in the one feature
order, the Priorities rank the Goal buckets follow (``position``), and the pin a move sends as
``before.override`` (``before_override``). A move on the Roadmap timeline is that order's own
change, ``override_priority`` on the item, one request: the item takes the rank of the one it
lands on and its neighbours renumber (whole numbers). Against Postgres; the world, people and
clock are tests.test_simple_priorities_api's. Each test's card is its docstring.
"""

import pytest

from tests.baseline_helpers import Ctx
from tests.test_simple_changes_api import clock, make_people  # noqa: F401
from tests.test_simple_priorities_api import World
from tests.test_simple_roadmap_api import URL
from tests.test_simple_targets_api import no_llm  # noqa: F401

pytestmark = pytest.mark.usefixtures("clock", "no_llm")
REASON = "Reordered in place"
ORDERED = ("pay-1", "pay-2", "pay-3", "pay-4")


async def items(client, ctx: Ctx, who: str = "owner") -> dict[str, dict]:
    r = await client.get(URL, headers=ctx.as_(who))
    assert r.status_code == 200, r.text
    return {i["key"]: i for i in r.json()["items"]}


def positions(read: dict[str, dict]) -> dict[str, int | None]:
    return {k: read[k]["position"] for k in ORDERED}


async def move(client, w: World, who: str, item: str, onto: str, read: dict) -> object:
    return await w.change(client, who, "override_priority", item,
                          {"override": read[item]["before_override"]},
                          {"position": read[onto]["position"], "reason": REASON,
                           "confirm": True}, reason=REASON)  # fmt: skip


async def test_read_carries_the_priorities_rank(client):
    """protects=each item's position is its feature's Priorities rank (one order: the read and
    Priorities agree), whole numbers; an item with no feature has none; before_override is
    null with no pin; fails_when=the read has no position, or a second order;
    no_claim=draft items' place."""
    w = await World(await make_people()).build()
    read = await items(client, w.ctx)
    ranks = {r["code"]: r["rank"] for r in (await w.read(client))["rows"]}
    assert positions(read) == {k: ranks[k] for k in ORDERED}
    assert all(isinstance(p, int) for p in positions(read).values())
    assert read["pay-6"]["position"] is None
    assert read["pay-7"]["position"] == read["pay-1"]["position"]
    assert all(read[k]["before_override"] is None for k in ORDERED)


async def test_decider_move_is_final_and_renumbers(client):
    """protects=an owner's move (one request) puts the item at the place of the one it lands
    on, the ones between move down one, every reader (a viewer too) reads the new order at
    once, and Priorities reads the same order; fails_when=the move waits, leaves a gap or a
    tie, or the two pages disagree; no_claim=the pushback wording."""
    w = await World(await make_people()).build()
    read = await items(client, w.ctx)
    was = positions(read)
    r = await move(client, w, "owner", "pay-4", "pay-2", read)
    assert r.status_code == 201, r.text
    assert r.json()["change"]["status"] == "applied"
    now = positions(await items(client, w.ctx, "viewer"))
    assert now["pay-4"] == was["pay-2"]
    assert now["pay-2"] == was["pay-2"] + 1 and now["pay-3"] == was["pay-3"] + 1
    assert now["pay-1"] == was["pay-1"]
    assert sorted(now.values()) == sorted(was.values())
    ranks = {r["code"]: r["rank"] for r in (await w.read(client, "viewer"))["rows"]}
    assert now == {k: ranks[k] for k in ORDERED}
    after = await items(client, w.ctx)
    assert after["pay-4"]["before_override"]["position"] == was["pay-2"]


async def test_commenter_proposes_and_the_order_stays(client):
    """protects=a commenter's move is filed as a proposal (proposed) and changes no one's
    order until the decider accepts it; fails_when=a commenter reorders the live roadmap;
    no_claim=the pending mark (the web's)."""
    w = await World(await make_people()).build()
    read = await items(client, w.ctx, "commenter")
    was = positions(read)
    r = await move(client, w, "commenter", "pay-4", "pay-1", read)
    assert r.status_code == 201, r.text
    assert r.json()["change"]["status"] == "proposed"
    assert positions(await items(client, w.ctx, "commenter")) == was
    assert positions(await items(client, w.ctx)) == was


async def test_viewer_is_refused(client):
    """protects=a viewer's move is refused on the server and nothing moves;
    fails_when=a viewer reorders or proposes; no_claim=the refusal's words."""
    w = await World(await make_people()).build()
    read = await items(client, w.ctx, "viewer")
    was = positions(read)
    r = await move(client, w, "viewer", "pay-4", "pay-1", read)
    assert r.status_code == 403, r.text
    assert positions(await items(client, w.ctx)) == was


async def test_stale_before_is_refused(client):
    """protects=a move sent with the pin as it was before someone else's move is refused (409,
    who changed it) and writes nothing; fails_when=a stale move lands over the other;
    no_claim=the exact words."""
    w = await World(await make_people()).build()
    stale = await items(client, w.ctx)
    r = await move(client, w, "owner", "pay-4", "pay-2", stale)
    assert r.status_code == 201, r.text
    moved = positions(await items(client, w.ctx))
    r = await move(client, w, "decider", "pay-4", "pay-1", stale)
    assert r.status_code == 409, r.text
    assert "changed by" in r.json()["detail"]["message"]
    assert positions(await items(client, w.ctx)) == moved


async def test_another_company_is_never_touched(client):
    """protects=a move in one company leaves another company's order as it was, and one
    company cannot move another's item; fails_when=the order or the pin leaks across
    companies; no_claim=the 404's words."""
    a = await World(await make_people()).build()
    b = await World(await make_people()).build()
    theirs = positions(await items(client, b.ctx))
    read = await items(client, a.ctx)
    r = await move(client, a, "owner", "pay-4", "pay-1", read)
    assert r.status_code == 201, r.text
    assert positions(await items(client, b.ctx)) == theirs
    assert (await items(client, b.ctx))["pay-4"]["before_override"] is None
    body = {"op": "override_priority", "target": {"item_id": b.ids["pay-4"]},
            "before": {"override": None}, "after": {"position": 1, "reason": REASON}}  # fmt: skip
    r = await client.post("/v1/simple/changes", json=body, headers=a.ctx.as_("owner"))
    assert r.status_code in (403, 404), r.text
    assert positions(await items(client, b.ctx)) == theirs
