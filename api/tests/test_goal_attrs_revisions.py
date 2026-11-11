"""goal-target-kept: Simple's own goal edits never drop a measured goal's ``target`` and
``unit``, and each one leaves an entity revision (the Ground Truth goal panel's History).
Against Postgres. Invented example data only.

Found in production (Nov 10): a confirmed, locked goal lost its target and unit with no
revision, became "Not measurable" and left the Goal map. The feature panel's goal fields
(``set_goal_measure``) and the goal form (``PATCH /v1/simple/goal-buckets/goals/{id}``) both
replaced a numeric target with the text typed (or nothing), and neither wrote a revision.

Test cards (protects / fails_when / no_claim):

- test_panel_goal_fields_keep_target_and_unit: protects=a date-only edit in the feature
  panel keeps the goal's target and unit (also when its stored unit carries a stray space),
  a typed new number stays a number with the goal's unit, clearing a measured goal's target
  there is refused (422), and every applied change and its Undo writes a revision;
  fails_when=target or unit is dropped, or a write leaves no revision; no_claim=the web.
- test_goal_form_edit_keeps_target_and_unit: protects=the goal form's save keeps a measured
  goal's unit and its target as a number, and its save and Undo each write a revision;
  fails_when=the target becomes text, the unit is dropped, or no revision is written;
  no_claim=goals with a text target only (test_simple_goal_buckets_api).
- test_goal_archive_and_restore_write_revisions: protects=archive and restore of a goal
  from Simple each write a revision; fails_when=either leaves none; no_claim=its features.
- test_goal_map_target_edit_writes_a_revision: protects=the Goal map's target edit writes a
  revision with the old and new target; fails_when=none is written; no_claim=its history.
- test_goal_form_typed_target_keeps_number_and_unit: protects=the goal form takes a number
  typed with its unit in any case ("70 Shops" is 70 shops), and refuses, changing nothing,
  a number in another unit ("70 partners", "$1,200", "70 shops/week"), words only and a
  cleared target, so the shown target never reads apart from the number the Goal map and
  progress use; fails_when=the typed text is stored beside the old number, or a target is
  cleared; no_claim=text-only goals (test_simple_goal_buckets_api).
- test_goal_map_target_edit_drops_target_text: protects=the Goal map's target edit drops a
  stale typed target text, so the target shown is the new number; fails_when=the old text
  still reads as the target; no_claim=its history.
- test_goal_form_refusal_names_unit_as_read: protects=the refusal of a number in another
  unit names a currency goal's unit as a person reads it ("$", "€", "£"), other units as
  stored; fails_when=it names the stored code ("usd"); no_claim=the web.
- test_goal_form_target_commas_only_between_thousands: protects=a typed number takes commas
  only as thousands separators ("1,200", "12,000,000"); "1,2" and the like are refused in
  plain words, changing nothing; fails_when="1,2" saves as 12; no_claim=text-only goals.
- test_baseline_numeric_target_drops_target_text: protects=a Baseline write of a numeric
  target drops an older typed target text, so the goal buckets show the new number;
  fails_when=the stale text still reads as the target; no_claim=agent writes kept as text.
- test_goal_ask_archive_and_restore_write_revisions: protects=an asked archive and restore,
  accepted by an owner, each write a revision; fails_when=the Ask path leaves none;
  no_claim=the ask's routing (test_simple_goal_owner_asks_api).
- test_goal_form_add_writes_a_revision: protects=a goal added from the goal form has its
  created revision; fails_when=none is written; no_claim=its features.
- test_goal_milestone_rename_writes_a_revision: protects=renaming a goal's own roadmap
  milestone (``milestone_name`` in the goal's attrs) writes a revision; fails_when=none is
  written; no_claim=PRD milestones.
"""

import uuid

import pytest
from sqlalchemy import select

from oracle.baseline.models import Entity, EntityRevision
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.test_milestone_kinds_api import make, read, seed, targets
from tests.test_simple_changes_api import CHANGES, make_people
from tests.test_simple_goal_buckets_api import GOAL, World
from tests.test_simple_goal_buckets_api import URL as BUCKETS
from tests.test_simple_goal_map_api import URL as GOAL_MAP
from tests.test_simple_goal_map_api import world as goal_map_world
from tests.test_simple_goal_milestones_api import MILESTONES
from tests.test_simple_panel_fields import Panel, clock  # noqa: F401

pytestmark = pytest.mark.asyncio(loop_scope="session")

MEASURED = {"metric": "Weekly conversions", "target": 50, "unit": "conversions",
            "start": 10, "comparison": "at_least", "due": "2027-03-31"}  # fmt: skip


async def _goal(tenant_id, goal_id) -> tuple[dict, list[EntityRevision]]:
    goal_id = uuid.UUID(str(goal_id))
    async with tenant_session(tenant_id) as s:
        g = await s.get(Entity, goal_id, populate_existing=True)
        revs = list(
            await s.scalars(
                select(EntityRevision)
                .where(EntityRevision.entity_id == goal_id)
                .order_by(EntityRevision.created_at, EntityRevision.id)
            )
        )
        return dict(g.attrs or {}), revs


async def _set_attrs(tenant_id, goal_id, attrs: dict) -> None:
    goal_id = uuid.UUID(str(goal_id))
    async with tenant_session(tenant_id) as s:
        g = await s.get(Entity, goal_id)
        g.attrs, g.locked = dict(attrs), True
        await s.commit()


async def test_panel_goal_fields_keep_target_and_unit(client):
    p = await Panel().build(await make_people())
    tid, gid = p.ctx.tenant_id, p.g1.id
    # The unit as an older form stored it, with a stray space.
    await _set_attrs(tid, gid, {**MEASURED, "unit": " conversions"})

    async def post(after: dict):
        goal = (await p.read(client))["a"]["goal"]
        seen = {"measure": goal["metric"], "target": goal["target"], "due": goal["due"]}
        body = {"op": "set_goal_measure", "target": {"item_id": p.a, "goal_id": str(gid)},
                "before": seen, "after": {**seen, **after}}  # fmt: skip
        return await client.post(CHANGES, json=body, headers=p.ctx.as_("owner"))

    # Only the date changes: the target and unit stay.
    r = await post({"due": "2027-06-30"})
    assert r.status_code == 201, r.text
    attrs, revs = await _goal(tid, gid)
    assert attrs["target"] == 50 and attrs["unit"].strip() == "conversions", attrs
    assert "target_text" not in attrs and attrs["due"] == "2027-06-30"
    assert len(revs) == 1, "the panel's goal change leaves a revision"
    assert revs[0].before["attrs"]["due"] == "2027-03-31"
    assert revs[0].after["attrs"]["due"] == "2027-06-30"
    assert revs[0].actor.startswith("user:")

    # A new number typed with no unit: still a number, in the goal's unit.
    await _set_attrs(tid, gid, MEASURED)
    r = await post({"target": "60"})
    assert r.status_code == 201, r.text
    applied = r.json()["change"]
    attrs, revs = await _goal(tid, gid)
    assert (attrs["target"], attrs["unit"]) == (60, "conversions"), attrs
    assert "target_text" not in attrs
    assert (await p.read(client))["a"]["goal"]["target"] == "60 conversions"
    assert revs[-1].before["attrs"]["target"] == 50 and revs[-1].after["attrs"]["target"] == 60

    # Its Undo puts the target back, with a revision of its own.
    n = len(revs)
    u = await client.post(f"{CHANGES}/{applied['id']}/undo", headers=p.ctx.as_("owner"))
    assert u.status_code == 201, u.text
    attrs, revs = await _goal(tid, gid)
    assert (attrs["target"], attrs["unit"]) == (50, "conversions"), attrs
    assert len(revs) == n + 1

    # Clearing a measured goal's target from the panel is refused; nothing changes.
    r = await post({"target": None})
    assert r.status_code == 422, r.text
    attrs, revs = await _goal(tid, gid)
    assert (attrs["target"], attrs["unit"]) == (50, "conversions")
    assert len(revs) == n + 1


async def test_goal_form_edit_keeps_target_and_unit(client):
    w = await World().build()
    tid, gid = w.ctx.tenant_id, w.goals["grow"]
    await _set_attrs(tid, gid, {"position": 1, "metric": "Shops live", "target": 40,
                                "unit": "shops", "due": "2027-03-31"})  # fmt: skip
    body = {"title": "Grow", "measure": "Shops live", "target": "45", "due": "2027-03-31"}
    r = await client.patch(f"{BUCKETS}/goals/{gid}", headers=w.as_("owner"), json=body)
    assert r.status_code == 200, r.text
    attrs, revs = await _goal(tid, gid)
    assert (attrs.get("target"), attrs.get("unit")) == (45, "shops"), attrs
    assert "target_text" not in attrs
    assert len(revs) == 1 and revs[0].before["attrs"]["target"] == 40

    r = await client.post(f"{BUCKETS}/undo", headers=w.as_("owner"), json=r.json()["undo"])
    assert r.status_code == 200, r.text
    attrs, revs = await _goal(tid, gid)
    assert (attrs.get("target"), attrs.get("unit")) == (40, "shops")
    assert len(revs) == 2 and revs[1].after["attrs"]["target"] == 40


async def test_goal_archive_and_restore_write_revisions(client):
    w = await World().build()
    tid, gid = w.ctx.tenant_id, w.goals["quiet"]
    r = await client.post(f"{BUCKETS}/goals/{gid}/archive", headers=w.as_("owner"), json={})
    assert r.status_code == 200, r.text
    _, revs = await _goal(tid, gid)
    assert len(revs) == 1 and revs[0].after["status"] == "rejected"
    r = await client.post(f"{BUCKETS}/goals/{gid}/unarchive", headers=w.as_("owner"))
    assert r.status_code == 200, r.text
    _, revs = await _goal(tid, gid)
    assert len(revs) == 2 and revs[1].after["status"] == "confirmed"


async def test_goal_map_target_edit_writes_a_revision(client):
    ctx, ids = await goal_map_world()
    r = await client.patch(
        f"{GOAL_MAP}/goals/{ids['conv']}", json={"target": 12}, headers=ctx.as_("owner")
    )
    assert r.status_code == 200, r.text
    attrs, revs = await _goal(ctx.tenant_id, ids["conv"])
    assert attrs["target"] == 12
    assert len(revs) == 1
    assert revs[0].before["attrs"]["target"] == 10 and revs[0].after["attrs"]["target"] == 12


async def test_goal_form_add_writes_a_revision(client):
    w = await World().build()
    r = await client.post(f"{BUCKETS}/goals", headers=w.as_("owner"), json=GOAL)
    assert r.status_code == 201, r.text
    attrs, revs = await _goal(w.ctx.tenant_id, r.json()["goal"]["id"])
    assert attrs["metric"] == GOAL["measure"]
    assert len(revs) == 1 and revs[0].before is None
    assert revs[0].after["attrs"]["metric"] == GOAL["measure"]


async def test_goal_milestone_rename_writes_a_revision(client):
    ctx = await make_ctx()
    ids = await seed(ctx, due="2026-12-15")
    await make(client, ctx, ids, name="Carts ready", date="2026-11-27")
    [g] = targets(await read(client, ctx))
    _, before = await _goal(ctx.tenant_id, ids["goal_id"])
    r = await client.patch(f"{MILESTONES}/{g['id']}", json={"name": "Ten teams live"},
                           headers=ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 200, r.text
    attrs, revs = await _goal(ctx.tenant_id, ids["goal_id"])
    assert attrs["milestone_name"] == "Ten teams live"
    assert len(revs) == len(before) + 1
    assert revs[-1].after["attrs"]["milestone_name"] == "Ten teams live"


async def test_goal_form_typed_target_keeps_number_and_unit(client):
    w = await World().build()
    tid, gid = w.ctx.tenant_id, w.goals["grow"]
    await _set_attrs(tid, gid, {"position": 1, "metric": "Shops live", "target": 40,
                                "unit": "shops", "due": "2027-03-31"})  # fmt: skip
    body = {"title": "Grow", "measure": "Shops live", "due": "2027-03-31"}

    async def patch(target: str):
        return await client.patch(f"{BUCKETS}/goals/{gid}", headers=w.as_("owner"),
                                  json={**body, "target": target})  # fmt: skip

    # Its unit typed with a capital: the number, in the goal's own unit.
    r = await patch("70 Shops")
    assert r.status_code == 200, r.text
    assert r.json()["goal"]["target"] == "70 shops"
    attrs, revs = await _goal(tid, gid)
    assert (attrs.get("target"), attrs.get("unit")) == (70, "shops"), attrs
    assert "target_text" not in attrs
    n = len(revs)

    # Another unit, or words only, or nothing: refused in plain words, nothing changes.
    for typed in ("70 partners", "$1,200", "70 shops/week"):
        r = await patch(typed)
        assert r.status_code == 422, (typed, r.text)
        assert r.json()["detail"] == "This goal is measured in shops: type its new number"
    r = await patch("about seventy")
    assert r.status_code == 422, r.text
    assert r.json()["detail"] == "A measured goal keeps its target: type its new number"
    r = await patch("   ")
    assert r.status_code == 422, r.text
    attrs, revs = await _goal(tid, gid)
    assert (attrs.get("target"), attrs.get("unit")) == (70, "shops"), attrs
    assert "target_text" not in attrs
    assert len(revs) == n


async def test_goal_map_target_edit_drops_target_text(client):
    ctx, ids = await goal_map_world()
    attrs, _ = await _goal(ctx.tenant_id, ids["conv"])
    await _set_attrs(ctx.tenant_id, ids["conv"], {**attrs, "target_text": "about ten"})
    r = await client.patch(
        f"{GOAL_MAP}/goals/{ids['conv']}", json={"target": 12}, headers=ctx.as_("owner")
    )
    assert r.status_code == 200, r.text
    attrs, revs = await _goal(ctx.tenant_id, ids["conv"])
    assert attrs["target"] == 12 and "target_text" not in attrs, attrs
    assert revs[-1].before["attrs"]["target_text"] == "about ten"


async def test_goal_ask_archive_and_restore_write_revisions(client):
    w = await World().build()
    tid, gid = w.ctx.tenant_id, w.goals["quiet"]

    async def asked(op: str) -> None:
        ask = {"op": op, "target": {"goal_id": str(gid)}, "before": {}, "after": {}}
        r = await client.post(CHANGES, headers=w.as_("commenter"), json=ask)
        assert r.status_code == 201, r.text
        assert r.json()["change"]["status"] == "proposed"
        cid = r.json()["change"]["id"]
        r = await client.post(f"{CHANGES}/{cid}/accept", headers=w.as_("owner"), json={})
        assert r.status_code == 200, r.text

    await asked("archive_goal")
    _, revs = await _goal(tid, gid)
    assert len(revs) == 1 and revs[0].after["status"] == "rejected"
    assert revs[0].actor.startswith("user:")
    await asked("unarchive_goal")
    _, revs = await _goal(tid, gid)
    assert len(revs) == 2 and revs[1].after["status"] == "confirmed"


async def _measured_goal(client, unit: str):
    w = await World().build()
    tid, gid = w.ctx.tenant_id, w.goals["grow"]
    await _set_attrs(tid, gid, {"position": 1, "metric": "Shops live", "target": 40,
                                "unit": unit, "due": "2027-03-31"})  # fmt: skip
    body = {"title": "Grow", "measure": "Shops live", "due": "2027-03-31"}

    async def patch(target: str):
        return await client.patch(f"{BUCKETS}/goals/{gid}", headers=w.as_("owner"),
                                  json={**body, "target": target})  # fmt: skip

    return w, tid, gid, patch


async def test_goal_form_refusal_names_unit_as_read(client):
    for unit, shown in (("usd", "$"), ("EUR", "€"), ("gbp", "£"), ("shops", "shops")):
        _, _, _, patch = await _measured_goal(client, unit)
        r = await patch("70 partners")
        assert r.status_code == 422, (unit, r.text)
        assert r.json()["detail"] == f"This goal is measured in {shown}: type its new number"


async def test_goal_form_target_commas_only_between_thousands(client):
    w, tid, gid, patch = await _measured_goal(client, "shops")
    for typed, n in (("1,200", 1200), ("12,000,000 shops", 12000000), ("1,234.5", 1234.5)):
        r = await patch(typed)
        assert r.status_code == 200, (typed, r.text)
        attrs, _ = await _goal(tid, gid)
        assert attrs["target"] == n, (typed, attrs)
    _, revs = await _goal(tid, gid)
    for typed in ("1,2", "12,00 shops", "1,2345", "1,,200"):
        r = await patch(typed)
        assert r.status_code == 422, (typed, r.text)
        assert r.json()["detail"] == "Type the target as a number, like 60"
    attrs, after = await _goal(tid, gid)
    assert attrs["target"] == 1234.5 and len(after) == len(revs)


async def test_baseline_numeric_target_drops_target_text(client):
    w = await World().build()
    tid, gid = w.ctx.tenant_id, w.goals["grow"]
    await _set_attrs(tid, gid, {"position": 1, "metric": "Shops live", "unit": "shops",
                                "comparison": "at_least", "target_text": "about seventy",
                                "due": "2027-03-31"})  # fmt: skip
    r = await client.patch(f"/v1/baseline/entities/{gid}", json={"attrs": {"target": 70}},
                           headers=w.as_("owner"))  # fmt: skip
    assert r.status_code == 200, r.text
    attrs, _ = await _goal(tid, gid)
    assert attrs["target"] == 70 and "target_text" not in attrs, attrs
    grow = next(g for g in (await w.read(client))["goals"] if g["id"] == gid)
    assert grow["target"] == "70 shops"
