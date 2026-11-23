"""unique-codes (the owner, Nov 23): every roadmap item has its own code; nothing shares one.

Items of one Ground Truth feature (its slices) read the feature's code today, so two items
read F-51 and setting an owner on one leaves the other flagged. An item's own code (its
title's) now comes before its feature's; a code another item reads is refused naming that
item; the migration gives every item sharing a code (or with none) its own, the earliest
start keeping it, the others the next free numbers, audited. Invented example data only.
"""

import uuid
from datetime import UTC, date, datetime

import pytest
from sqlalchemy import select

from oracle import company_time
from oracle.models import AuditEvent
from oracle.roadmap.models import RoadmapItem
from oracle.tenancy import tenant_session, unscoped_session
from tests.test_simple_changes_api import make_people
from tests.test_simple_goal_milestones_api import CHANGES
from tests.test_simple_roadmap_api import NOW, Seed, by_key, get

pytestmark = pytest.mark.asyncio(loop_scope="session")


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


async def one_feature_two_items(ctx) -> tuple[str, str]:
    """Feature F-51 Alert routing with two items: one reads the feature's code, the other its
    own (F-64)."""
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        _, pv, _, rv = await seed.roadmap("alerts")
        f = await seed.entity("feature", "F-51")
        f.title = "Alert routing"
        a = await seed.item(rv, pv, "a", position=0, title="Alert routing", feature_id=f.id)
        b = await seed.item(rv, pv, "b", position=1, title="F-64 Routing by team", feature_id=f.id)
        await s.commit()
    return str(a.id), str(b.id)


def set_code(client, ctx, item: str, before: str | None, after: str | None):
    body = {"op": "set_code", "target": {"item_id": item}, "before": {"code": before},
            "after": {"code": after}}  # fmt: skip
    return client.post(CHANGES, json=body, headers=ctx.as_("owner"))


async def test_two_items_of_one_feature_read_their_own_codes(client):
    """Two items of one feature read two codes; the one with its own still names the feature."""
    # protects=an item's own code (its title's) before its feature's, and its feature named;
    # fails_when=both items read F-51; no_claim=Priorities' 2x2 marks.
    ctx = await make_people()
    await one_feature_two_items(ctx)
    shown = by_key(await get(client, ctx, "owner"))
    a, b = shown["a"], shown["b"]
    assert (a["code"], a["code_from"], a["title"]) == ("F-51", "feature", "Alert routing")
    assert (b["code"], b["code_from"], b["title"]) == ("F-64", None, "Routing by team")
    assert b["feature_name"] == "F-51 Alert routing"
    assert a["feature_name"] is None


async def test_a_taken_code_is_refused_naming_the_item_that_has_it(client):
    """An item of a feature takes a code of its own; one another item reads is refused."""
    ctx = await make_people()
    _, b = await one_feature_two_items(ctx)
    r = await set_code(client, ctx, b, "F-64", "F-51")
    assert r.status_code == 422, r.text
    assert r.json()["detail"] == "F-51 is already the code of F-51 Alert routing"
    r = await set_code(client, ctx, b, "F-64", "F-70")
    assert r.status_code == 201, r.text
    assert by_key(await get(client, ctx, "owner"))["b"]["code"] == "F-70"


async def test_a_rename_keeps_the_items_own_code_checked(client):
    """A rename of an item of a feature, to a code another item reads, is refused."""
    ctx = await make_people()
    _, b = await one_feature_two_items(ctx)
    body = {"op": "edit_title", "target": {"item_id": b}, "before": {"title": "Routing by team"},
            "after": {"title": "F-51 Routing by team"}}  # fmt: skip
    r = await client.post(CHANGES, json=body, headers=ctx.as_("owner"))
    assert r.status_code == 422, r.text
    assert r.json()["detail"] == "F-51 is already the code of F-51 Alert routing"


@pytest.mark.asyncio(loop_scope="session")
async def test_the_next_free_number_is_one_rule():
    """New items and the migration share one rule: the highest F-number in use, plus one."""
    from oracle.roadmap import codes

    assert codes.next_number(["F-62", "F-37a", "F-12.2", None, "AB-90", "F-8"]) == "F-63"
    assert codes.next_number([]) == "F-1"


def _at(day: int) -> datetime:
    return datetime(2026, 10, day, 9, 0, tzinfo=UTC)


async def test_the_migration_gives_every_item_its_own_code(client):
    """Each group sharing a code keeps it on its earliest start; the others take the next free
    numbers in date order, as do items with none; unique codes stay; audited; twice is once."""
    from oracle.roadmap.renumber import ACTION, renumber

    ctx = await make_people()
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        _, pv, rm, rv = await seed.roadmap("alerts")
        rv2 = await seed.version(rm, 2)
        f51 = await seed.entity("feature", "F-51")
        f62 = await seed.entity("feature", "F-62")
        await seed.entity("feature", "F-08")  # a feature with no item: its number is in use

        def item(v, key, title, created, **kw):
            return seed.item(v, pv, key, title=title, created_at=_at(created), **kw)

        # Three slices of F-51: the earliest start keeps it.
        await item(rv, "a", "Routing rules", 1, feature_id=f51.id, start_date=date(2026, 12, 1))
        await item(rv, "b", "Routing by team", 2, feature_id=f51.id, start_date=date(2026, 11, 2))
        await item(rv, "c", "Routing digest", 3, feature_id=f51.id)
        # The same item on the next version: every row of it is renumbered alike.
        await item(rv2, "a", "Routing rules", 9, feature_id=f51.id, start_date=date(2026, 12, 1))
        # Two of F-62 on one start date: the earliest created keeps it.
        await item(rv, "d", "Search index", 5, feature_id=f62.id, start_date=date(2026, 11, 9))
        await item(rv, "e", "Search filters", 4, feature_id=f62.id, start_date=date(2026, 11, 9))
        # Unique codes stay, slices with a suffix too; an item with none gets one.
        await item(rv, "g", "F-37a Exports", 6)
        await item(rv, "h", "F-29a Saved views", 7)
        await item(rv, "i", "Loose ends", 8, start_date=date(2026, 11, 20))
        await s.commit()

    async with unscoped_session() as s:
        made = await s.run_sync(renumber)
        await s.commit()
    got = {m["item_key"]: (m["old"], m["new"]) for m in made}
    assert got == {
        "d": ("F-62", "F-63"),  # Nov 9, created after e
        "i": (None, "F-64"),  # Nov 20
        "a": ("F-51", "F-65"),  # Dec 1
        "c": ("F-51", "F-66"),  # no start date: last
    }

    async with unscoped_session() as s:
        titles = {
            (r.roadmap_version_id, r.item_key): r.title
            for r in await s.scalars(
                select(RoadmapItem).where(RoadmapItem.roadmap_document_id == rm.id)
            )
        }
        events = list(
            await s.scalars(
                select(AuditEvent).where(
                    AuditEvent.action == ACTION, AuditEvent.tenant_id == ctx.tenant_id
                )
            )
        )
    assert titles[(rv.id, "a")] == titles[(rv2.id, "a")] == "F-65 Routing rules"
    assert titles[(rv.id, "b")] == "Routing by team"  # keeps F-51, from its feature
    assert titles[(rv.id, "e")] == "Search filters"  # keeps F-62
    assert titles[(rv.id, "g")] == "F-37a Exports"
    assert titles[(rv.id, "h")] == "F-29a Saved views"
    pairs = sorted(((e.data["old"], e.data["new"]) for e in events), key=str)
    assert pairs == sorted(got.values(), key=str)
    assert all(isinstance(e.entity_id, uuid.UUID) for e in events)

    async with unscoped_session() as s:
        again = await s.run_sync(renumber)
        await s.commit()
    assert again == []
