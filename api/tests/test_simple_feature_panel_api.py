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

from datetime import date, timedelta

from sqlalchemy import select, update

from oracle.roadmap.models import RoadmapItem
from oracle.simple.models import SimpleChange
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


async def _goals_for(ctx, item_id: str) -> tuple[str, str]:
    """Two confirmed goals; the item's feature supports the first (Oracle's goal)."""
    import uuid

    from oracle.baseline.models import Edge, Entity

    async with tenant_session(ctx.tenant_id) as s:
        feature = Entity(type="feature", key="fp-feature", title="Alert digest", status="confirmed",
                         origin="user")  # fmt: skip
        grow = Entity(type="goal", key="grow", title="Grow retention", status="confirmed",
                      origin="user", attrs={"metric": "Teams active after 90 days"})  # fmt: skip
        reply = Entity(type="goal", key="reply", title="Cut time to first response",
                       status="confirmed", origin="user")  # fmt: skip
        s.add_all([feature, grow, reply])
        await s.flush()
        s.add(Edge(src_id=feature.id, dst_id=grow.id, type="supports", status="confirmed",
                   origin="user"))  # fmt: skip
        await s.execute(
            update(RoadmapItem)
            .where(RoadmapItem.id == uuid.UUID(item_id))
            .values(feature_id=feature.id)
        )
        await s.commit()
        return str(grow.id), str(reply.id)


async def test_own_goal_wins_over_oracles_and_restores(client, clock):  # noqa: F811
    """build-feature-panel review 2: the panel's Serves and Measure fields. protects=``set_goal``
    gives the item its own goal (``goal_ids``) and measure, which win over the goal its feature
    supports (Oracle's); ``goal_set`` names Oracle's goal and who set the item's;
    ``restore_goal`` puts Oracle's back; viewers get 403; fails_when=the baseline goal still
    wins, the setter or Oracle's goal is lost, or Restore leaves the person's goal;
    no_claim=Goal buckets' drops (S7)."""
    ctx = await make_people()
    w = await World(ctx).build(decider=True, ops=["fp"])
    a = w.ids["fp-a"]
    grow, reply = await _goals_for(ctx, a)
    it = await item_of(client, ctx, "decider", a)
    assert it["goal"]["id"] == grow and it["goal_set"] is None
    r = await post(client, ctx, "viewer", "set_goal", {"item_id": a}, {"goal_ids": []},
                   {"goal_ids": [reply]})  # fmt: skip
    assert r.status_code == 403, r.text
    clock["now"] += timedelta(minutes=1)
    r = await post(client, ctx, "decider", "set_goal", {"item_id": a}, {"goal_ids": []},
                   {"goal_ids": [reply], "measure": "Median minutes to first reply"})  # fmt: skip
    assert r.status_code == 201, r.text
    it = await item_of(client, ctx, "decider", a)
    assert it["goal"]["id"] == reply and it["goal_ids"] == [reply]
    gs = it["goal_set"]
    assert (gs["oracle"]["id"], gs["oracle"]["title"], gs["by"], gs["measure"]) == (
        grow, "Grow retention", "Dee Cider", "Median minutes to first reply",
    )  # fmt: skip
    # Not a goal: refused.
    clock["now"] += timedelta(minutes=1)
    r = await post(client, ctx, "decider", "set_goal", {"item_id": a}, {"goal_ids": [reply]},
                   {"goal_ids": [a]})  # fmt: skip
    assert r.status_code == 422, r.text
    clock["now"] += timedelta(minutes=1)
    r = await post(client, ctx, "decider", "restore_goal", {"item_id": a}, {"goal_ids": [reply]})
    assert r.status_code == 201, r.text
    it = await item_of(client, ctx, "decider", a)
    assert it["goal"]["id"] == grow and it["goal_set"] is None and it["goal_ids"] == []
    clock["now"] += timedelta(minutes=1)
    r = await post(client, ctx, "decider", "restore_goal", {"item_id": a}, {"goal_ids": []})
    assert r.status_code == 422, r.text


async def test_restore_goal_at_the_same_moment_still_wins(client, clock):  # noqa: F811
    """build-feature-panel review 3: protects=a ``set_goal`` and the ``restore_goal`` that
    answers it, written at the same ``at`` (a frozen clock, one batch's now), apply in the
    order they were written, so Oracle's goal is back; fails_when=two changes with one ``at``
    are ordered by their random ids (the restore first: the person's goal stays);
    no_claim=changes written out of order on purpose."""
    import uuid

    ctx = await make_people()
    w = await World(ctx).build(decider=True, ops=["fp"])
    a = w.ids["fp-a"]
    grow, reply = await _goals_for(ctx, a)
    r = await post(client, ctx, "decider", "set_goal", {"item_id": a}, {"goal_ids": []},
                   {"goal_ids": [reply]})  # fmt: skip
    assert r.status_code == 201, r.text
    r = await post(client, ctx, "decider", "restore_goal", {"item_id": a}, {"goal_ids": [reply]})
    assert r.status_code == 201, r.text
    # The clock did not move: both have one ``at``. Give the restore the lower id, so an
    # order by (at, id) puts it first, every time.
    async with tenant_session(ctx.tenant_id) as s:
        rows = {c.op: c for c in await s.scalars(
            select(SimpleChange).where(SimpleChange.op.in_(("set_goal", "restore_goal")))
        )}  # fmt: skip
        assert rows["set_goal"].at == rows["restore_goal"].at
        for op, new in (("set_goal", "ffffffff-ffff-4fff-bfff-ffffffffffff"),
                        ("restore_goal", "00000000-0000-4000-8000-000000000000")):  # fmt: skip
            await s.execute(
                update(SimpleChange).where(SimpleChange.id == rows[op].id)
                .values(id=uuid.UUID(new))
            )  # fmt: skip
        await s.commit()
    it = await item_of(client, ctx, "decider", a)
    assert it["goal"]["id"] == grow and it["goal_set"] is None and it["goal_ids"] == []


async def test_engine_written_milestone_renames(client):
    """build-feature-panel review 2: protects=``set_milestone`` checks ``before`` by the
    milestone's name and date as the item reads them, so a milestone the date engine wrote
    (an estimate's ``date_source``, ``basis_ids``, a refused date) is renamed from the panel;
    fails_when=the panel's ``before`` must repeat fields it never sees (409);
    no_claim=a changed name or date is still a 409."""
    import uuid

    ctx = await make_people()
    w = await World(ctx).build(decider=True, ops=["fp"])
    a = w.ids["fp-a"]
    stored = {"name": None, "date": "2026-12-18", "date_source": "estimate:eng-1",
              "basis_ids": [str(uuid.uuid4())], "refused_date": "2026-12-01",
              "refused": True}  # fmt: skip
    async with tenant_session(ctx.tenant_id) as s:
        await s.execute(
            update(RoadmapItem).where(RoadmapItem.id == uuid.UUID(a)).values(milestone=stored)
        )
        await s.commit()
    it = await item_of(client, ctx, "decider", a)
    m = it["milestone"]
    assert (m["name"], m["date"], m["source"]) == (None, "2026-12-18", "item")
    seen = {"name": m["name"], "date": m["date"]}
    r = await post(client, ctx, "decider", "set_milestone", {"item_id": a},
                   {"milestone": {**seen, "date": "2026-12-19"}},
                   {"milestone": {"name": "Pilot", "date": "2026-12-18"}})  # fmt: skip
    assert r.status_code == 409, r.text
    r = await post(client, ctx, "decider", "set_milestone", {"item_id": a}, {"milestone": seen},
                   {"milestone": {"name": "Pilot", "date": "2026-12-18"}})  # fmt: skip
    assert r.status_code == 201, r.text
    it = await item_of(client, ctx, "decider", a)
    assert (it["milestone"]["name"], it["milestone"]["date"]) == ("Pilot", "2026-12-18")


async def test_owner_back_to_track_when_from_track_records_nothing(client):
    """build-feature-panel review 2: protects=``set_owner`` null on an item whose owner is
    its track's already is refused (422, nothing recorded); fails_when=a no-op change is
    written; no_claim=the panel's own check (its spec)."""
    from oracle.simple.models import SimpleChange

    ctx = await make_people()
    w = await World(ctx).build(decider=True, track_owner="approver", ops=["fp"])
    a = w.ids["fp-a"]
    r = await post(client, ctx, "decider", "set_owner", {"item_id": a}, {"owner_id": None},
                   {"owner_id": None})  # fmt: skip
    assert r.status_code == 422, r.text
    async with tenant_session(ctx.tenant_id) as s:
        assert (
            await s.scalars(select(SimpleChange).where(SimpleChange.op == "set_owner"))
        ).all() == []
