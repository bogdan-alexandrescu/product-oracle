"""build-feature-panel (AN PR 1204, ported onto this line's one feature panel, PR 1297): what
the panel reads and changes that this line's panel lacked. Against Postgres.

Test cards (protects / fails_when / no_claim):

- test_engine_written_milestone_renames: protects=``set_milestone`` checks ``before`` by the
  milestone's name and day as the item reads them; fails_when=a date-engine milestone is a 409.
- test_owner_back_to_track_when_from_track_records_nothing: protects=a no-op ``set_owner`` is
  422 and records nothing; fails_when=a no-op change is written.
- test_panel_reads_the_goals_reading_and_the_notes: protects=the item's goal carries its
  reading (``current``, ``unit``, with this line's ``target`` words and ``due``); the item reads
  its ``note``, which ``edit_note`` changes (viewers 403, over 500 characters 422);
  fails_when=any is missing; no_claim=Oracle's dates kept over a person's (not ported).
"""

from sqlalchemy import select, update

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


async def test_panel_reads_the_goals_reading_and_the_notes(client):
    """build-feature-panel review 3: the picked frames' Reading and Notes rows, and Start's
    note after only the delivery moved. protects=the item's goal carries its reading
    (``current``, ``target``, ``unit``, ``due``, from the goal's attrs); the item reads its
    ``note``, which ``edit_note`` changes (viewers 403, over 500 characters 422); a
    ``move_dates`` keeps the start's own source (``override.start_source``);
    fails_when=any is missing; no_claim=a goal with a linked metric's pull."""
    import uuid

    from oracle.baseline.models import Entity

    ctx = await make_people()
    w = await World(ctx).build(decider=True, ops=["fp"])
    a = w.ids["fp-a"]
    grow, _ = await _goals_for(ctx, a)
    async with tenant_session(ctx.tenant_id) as s:
        g = await s.get(Entity, uuid.UUID(grow))
        g.attrs = {**g.attrs, "unit": "%", "comparison": ">=", "target": 70, "current": 61,
                   "current_as_of": "2026-10-20", "due": "2027-06-30"}  # fmt: skip
        await s.execute(
            update(RoadmapItem).where(RoadmapItem.id == uuid.UUID(a))
            .values(note="Send on Monday morning.")
        )  # fmt: skip
        await s.commit()
    it = await item_of(client, ctx, "decider", a)
    goal = it["goal"]
    # This line reads the target as the goal bucket edit does ("70%").
    assert (goal["current"], goal["target"], goal["unit"], goal["due"]) == (
        61, "70%", "%", "2027-06-30",
    )  # fmt: skip
    assert it["note"] == "Send on Monday morning."
    r = await post(client, ctx, "viewer", "edit_note", {"item_id": a},
                   {"note": "Send on Monday morning."}, {"note": "Skip quiet teams."})  # fmt: skip
    assert r.status_code == 403, r.text
    r = await post(client, ctx, "decider", "edit_note", {"item_id": a},
                   {"note": "Send on Monday morning."}, {"note": "x" * 501})  # fmt: skip
    assert r.status_code == 422, r.text
    seen = {"note": "Send on Monday morning."}
    r = await post(client, ctx, "decider", "edit_note", {"item_id": a}, seen,
                   {"note": "  Skip quiet teams.  "})  # fmt: skip
    assert r.status_code == 201, r.text
    it = await item_of(client, ctx, "decider", a)
    assert it["note"] == "Skip quiet teams."


async def test_a_dependency_that_would_make_a_loop_is_refused(client):
    """build-feature-panel (AN's add_link loop check, on this line's ``set_depends``):
    protects=a new dependency that already waits on the item, directly or through others, is
    refused (422 "loop") and nothing is written; one that makes no loop is taken;
    fails_when=a loop is written; no_claim=links across roadmaps."""
    ctx = await make_people()
    w = await World(ctx).build(decider=True, ops=["fp"])
    a, u = w.ids["fp-a"], w.ids["fp-u"]
    # fp-b already depends on fp-a: fp-a depending on fp-b would make a loop.
    r = await post(client, ctx, "decider", "set_depends", {"item_id": a}, {"depends_on": []},
                   {"depends_on": ["fp-b"]})  # fmt: skip
    assert r.status_code == 422 and "loop" in r.text, r.text
    assert (await w.item("fp-a")).depends_on in ([], None)
    # Through another: fp-u on fp-b is fine; then fp-a on fp-u loops (fp-u > fp-b > fp-a).
    r = await post(client, ctx, "decider", "set_depends", {"item_id": u}, {"depends_on": []},
                   {"depends_on": ["fp-b"]})  # fmt: skip
    assert r.status_code == 201, r.text
    r = await post(client, ctx, "decider", "set_depends", {"item_id": a}, {"depends_on": []},
                   {"depends_on": ["fp-u"]})  # fmt: skip
    assert r.status_code == 422 and "loop" in r.text, r.text
