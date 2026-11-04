"""build-feature-panel: what Simple's one feature panel edits and reads (oracle.simple.changes,
oracle.simple.service). Against Postgres.

Test cards (protects / fails_when / no_claim):

- test_override_keeps_oracles_dates_and_restore: protects=a person's dates over Oracle's
  (engineering) keep Oracle's on the item (``override``: Oracle's dates and source, who set
  the new ones); ``restore_dates`` puts Oracle's back with its source and the override goes;
  fails_when=Oracle's value is lost, the setter is not named, or Restore leaves typed dates;
  no_claim=dates set before this change.
- test_add_link_refuses_a_loop_and_names_who_added_it: protects=``add_link`` adds a
  dependency (the item's ``links`` names who added it; Oracle's links name no one), refuses
  one already there and one that would make a loop (422 "loop"); viewers get 403;
  fails_when=a loop or a duplicate is written, or the link's maker is lost; no_claim=links
  across roadmaps.
- test_removed_oracle_link_stays_and_restores: protects=``remove_link`` of Oracle's link takes
  it out of depends_on and keeps it in ``links`` as removed, naming who removed it;
  ``restore_link`` puts it back as Oracle's; fails_when=the removed link is forgotten or
  Restore makes it a person's; no_claim=a person's link removed (it simply goes).
"""

from datetime import date

from sqlalchemy import update

from oracle.roadmap.models import RoadmapItem
from oracle.tenancy import tenant_session
from tests.test_simple_changes_api import CHANGES, World, clock, make_people  # noqa: F401

ROADMAP = "/v1/simple/roadmap"


async def item_of(client, ctx, who: str, item_id: str) -> dict:
    r = await client.get(ROADMAP, headers=ctx.as_(who))
    assert r.status_code == 200, r.text
    return next(i for i in r.json()["items"] if i["id"] == item_id)


async def post(client, ctx, who: str, op: str, target: dict, before: dict, after=None):
    body = {"op": op, "target": target, "before": before, "after": after or {}}
    return await client.post(CHANGES, json=body, headers=ctx.as_(who))


async def test_override_keeps_oracles_dates_and_restore(client):
    ctx = await make_people()
    w = await World(ctx).build(decider=True, ops=["fp"])
    a = w.ids["fp-a"]
    async with tenant_session(ctx.tenant_id) as s:
        await s.execute(
            update(RoadmapItem).where(RoadmapItem.id == a).values(date_source="engineering")
        )
        await s.commit()
    before = {"start_date": "2026-10-01", "end_date": "2026-11-15"}
    r = await post(client, ctx, "decider", "move_dates", {"item_id": a}, before,
                   {"start_date": "2026-10-01", "end_date": "2026-11-05"})  # fmt: skip
    assert r.status_code == 201, r.text
    it = await item_of(client, ctx, "decider", a)
    assert it["end"]["date"] == "2026-11-05"
    assert it["override"] == {
        "start_date": "2026-10-01",
        "end_date": "2026-11-15",
        "source": "engineering",
        "by": "Dee Cider",
        "at": it["override"]["at"],
    }
    r = await post(client, ctx, "decider", "restore_dates", {"item_id": a},
                   {"start_date": "2026-10-01", "end_date": "2026-11-05"})  # fmt: skip
    assert r.status_code == 201, r.text
    row = await w.item("fp-a")
    assert (row.end_date, row.date_source) == (date(2026, 11, 15), "engineering")
    it = await item_of(client, ctx, "decider", a)
    assert it["override"] is None
    # Nothing to restore now.
    r = await post(client, ctx, "decider", "restore_dates", {"item_id": a}, before)
    assert r.status_code == 422, r.text


async def test_add_link_refuses_a_loop_and_names_who_added_it(client):
    ctx = await make_people()
    w = await World(ctx).build(decider=True, ops=["fp"])
    a, b, u = (w.ids[f"fp-{x}"] for x in "abu")
    # b already depends on a (Oracle's link: no one added it).
    it = await item_of(client, ctx, "decider", b)
    assert it["links"] == [{"item_id": a, "by": None, "removed": False, "removed_by": None}]
    r = await post(client, ctx, "decider", "add_link", {"item_id": b, "subject": a},
                   {"depends_on": ["fp-a"]})  # fmt: skip
    assert r.status_code == 422 and "already" in r.text, r.text
    # a depending on b would make a loop.
    r = await post(client, ctx, "decider", "add_link", {"item_id": a, "subject": b},
                   {"depends_on": []})  # fmt: skip
    assert r.status_code == 422 and "loop" in r.text, r.text
    assert (await w.item("fp-a")).depends_on in ([], None)
    r = await post(client, ctx, "viewer", "add_link", {"item_id": u, "subject": b},
                   {"depends_on": []})  # fmt: skip
    assert r.status_code == 403, r.text
    r = await post(client, ctx, "decider", "add_link", {"item_id": u, "subject": b},
                   {"depends_on": []})  # fmt: skip
    assert r.status_code == 201, r.text
    assert (await w.item("fp-u")).depends_on == ["fp-b"]
    it = await item_of(client, ctx, "decider", u)
    assert it["depends_on"] == [b]
    assert it["links"] == [{"item_id": b, "by": "Dee Cider", "removed": False, "removed_by": None}]


async def test_removed_oracle_link_stays_and_restores(client):
    ctx = await make_people()
    w = await World(ctx).build(decider=True, ops=["fp"])
    a, b = w.ids["fp-a"], w.ids["fp-b"]
    r = await post(client, ctx, "decider", "remove_link", {"item_id": b, "subject": a},
                   {"depends_on": ["fp-a"]})  # fmt: skip
    assert r.status_code == 201, r.text
    assert (await w.item("fp-b")).depends_on == []
    it = await item_of(client, ctx, "decider", b)
    assert it["depends_on"] == []
    assert it["links"] == [{"item_id": a, "by": None, "removed": True, "removed_by": "Dee Cider"}]
    r = await post(client, ctx, "decider", "restore_link", {"item_id": b, "subject": a},
                   {"depends_on": []})  # fmt: skip
    assert r.status_code == 201, r.text
    assert (await w.item("fp-b")).depends_on == ["fp-a"]
    it = await item_of(client, ctx, "decider", b)
    assert it["links"] == [{"item_id": a, "by": None, "removed": False, "removed_by": None}]


async def test_own_owner_and_milestone_read_back_on_the_item(client):
    """build-feature-panel review: the panel's Owner and Milestone fields. protects=an owner
    set on the item (``set_owner``) is the item's owner, ``source`` "item", over its track's
    (``source`` "track"); null gives it back to the track's owner; a milestone set on it reads
    back and a second change names it as ``before``; fails_when=the item still shows the
    track's owner, or the stored milestone cannot be named as the panel shows it;
    no_claim=who may set them (test_simple_chat_actions)."""
    ctx = await make_people()
    w = await World(ctx).build(decider=True, track_owner="approver", ops=["fp"])
    a = w.ids["fp-a"]
    it = await item_of(client, ctx, "decider", a)
    assert it["owner"]["id"] == str(ctx.users["approver"].id)
    assert it["owner"]["source"] == "track"
    dee = str(ctx.users["decider"].id)
    r = await post(client, ctx, "decider", "set_owner", {"item_id": a}, {"owner_id": None},
                   {"owner_id": dee})  # fmt: skip
    assert r.status_code == 201, r.text
    it = await item_of(client, ctx, "decider", a)
    assert it["owner"] == {"id": dee, "name": "Dee Cider", "source": "item"}
    r = await post(client, ctx, "decider", "set_owner", {"item_id": a}, {"owner_id": dee},
                   {"owner_id": None})  # fmt: skip
    assert r.status_code == 201, r.text
    it = await item_of(client, ctx, "decider", a)
    assert it["owner"]["source"] == "track"

    m = {"name": "Beta for the pilot", "date": "2026-12-18"}
    r = await post(client, ctx, "decider", "set_milestone", {"item_id": a}, {"milestone": None},
                   {"milestone": m})  # fmt: skip
    assert r.status_code == 201, r.text
    it = await item_of(client, ctx, "decider", a)
    assert (it["milestone"]["name"], it["milestone"]["date"], it["milestone"]["source"]) == (
        "Beta for the pilot", "2026-12-18", "item",
    )  # fmt: skip
    seen = {**m, "date_source": "typed"}
    r = await post(client, ctx, "decider", "set_milestone", {"item_id": a}, {"milestone": seen},
                   {"milestone": None})  # fmt: skip
    assert r.status_code == 201, r.text
