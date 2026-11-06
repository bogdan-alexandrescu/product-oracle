"""prio-company (the owner, Nov 4: "a person always sees what is happening to a roadmap
shared with them and every change it needs can be made in the UI"): Simple › Priorities moves
the company roadmap. Against Postgres, on tests.test_simple_priorities_api's world with its
``payments`` roadmap made the company roadmap.

Test cards (protects / fails_when / no_claim):

- test_the_owner_may_move_every_row: protects=the owner's every row can be moved, a feature
  with no item on the company roadmap marked ``on_roadmap`` false (the row says a move adds
  it); a commenter, who may not add to the roadmap, cannot move that one row and every other;
  fails_when=the owner gets a row they cannot move, or the off-roadmap row is not marked;
  no_claim=the web (prio-company.spec.ts).
- test_a_move_adds_the_feature_to_the_company_roadmap: protects=an override_priority on a
  feature with no item (``target.feature_id``) adds it to the company roadmap, then pins it;
  the row then has its item; fails_when=the move is refused (422) or nothing is added;
  no_claim=other roadmaps.
- test_a_commenter_cannot_add_to_the_company_roadmap: protects=only an owner adds; a
  commenter's move of such a feature is refused (403), nothing added; fails_when=a commenter
  adds a feature to the company roadmap.
- test_estimate_a_feature_with_no_item: protects=a PM-owned feature with no item gets an
  effort in place (``target.feature_id``), so its score appears; fails_when=refused.
- test_own_key_only_for_a_real_code: protects=a row's ``own_key`` is the feature's own code
  (F-12) and empty for a feature with none: no letters made up from its name;
  fails_when=a generated code shows.
- test_a_placeholder_milestone_never_shows: protects=a milestone named with a literal
  placeholder ("Milestone N agents") is not a row's milestone nor a line; fails_when=it shows.
- test_a_bracketed_milestone_name_shows: protects=a real name with brackets ("Beta
  [internal]") is a row's milestone and a line; only a lone "N" is a placeholder;
  fails_when=it is dropped as a placeholder.
- test_a_move_reuses_the_features_draft_item: protects=moving a feature whose only item on
  the company roadmap is a draft confirms that item, never a second one; fails_when=a second
  item is added for the feature.
"""

import uuid
from datetime import date

from sqlalchemy import select

from oracle.baseline.models import Entity
from oracle.docs.models import Document
from oracle.roadmap.models import RoadmapItem, TrackMilestone
from oracle.tenancy import tenant_session
from tests.test_simple_changes_api import CHANGES, clock, make_people  # noqa: F401
from tests.test_simple_priorities_api import World
from tests.test_simple_targets_api import no_llm  # noqa: F401

REASON = "Example Co's launch needs it first"


async def company_world() -> World:
    w = await World(await make_people()).build()
    async with tenant_session(w.ctx.tenant_id) as s:
        rm = await s.scalar(select(Document).where(Document.slug == "payments"))
        rm.company_roadmap = True
        await s.commit()
        w.ids["roadmap"] = str(rm.id)
    return w


def by_feature(out: dict, w: World) -> dict[str, dict]:
    names = {v: k for k, v in w.ids.items()}
    return {names[r["feature_id"]]: r for r in out["rows"]}


async def test_the_owner_may_move_every_row(client):
    w = await company_world()
    rows = by_feature(await w.read(client), w)
    assert all(r["can_reorder"] for r in rows.values()), "the owner cannot move a row"
    assert rows["insights"]["on_roadmap"] is False and rows["insights"]["item_id"] is None
    assert rows["ledger"]["on_roadmap"] is True
    mine = by_feature(await w.read(client, "commenter"), w)
    assert mine["insights"]["can_reorder"] is False
    assert mine["ledger"]["can_reorder"] is True


async def test_a_move_adds_the_feature_to_the_company_roadmap(client):
    w = await company_world()
    body = {"op": "override_priority", "target": {"feature_id": w.ids["insights"]},
            "before": {"override": None},
            "after": {"position": 1, "reason": REASON, "confirm": True}}  # fmt: skip
    r = await client.post(CHANGES, json=body, headers=w.ctx.as_("owner"))
    assert r.status_code in (200, 201), r.text
    out = await w.read(client)
    top = out["rows"][0]
    assert top["feature_id"] == w.ids["insights"], "the move did not pin it first"
    assert top["on_roadmap"] is True and top["item_id"] is not None
    async with tenant_session(w.ctx.tenant_id) as s:
        item = await s.get(RoadmapItem, uuid.UUID(top["item_id"]))
        assert str(item.roadmap_document_id) == w.ids["roadmap"]
        assert str(item.feature_id) == w.ids["insights"] and item.draft is False


async def test_a_commenter_cannot_add_to_the_company_roadmap(client):
    w = await company_world()
    body = {"op": "override_priority", "target": {"feature_id": w.ids["insights"]},
            "before": {"override": None}, "after": {"position": 1, "reason": REASON}}  # fmt: skip
    r = await client.post(CHANGES, json=body, headers=w.ctx.as_("commenter"))
    assert r.status_code == 403, r.text
    async with tenant_session(w.ctx.tenant_id) as s:
        found = await s.scalar(
            select(RoadmapItem.id).where(RoadmapItem.feature_id == uuid.UUID(w.ids["insights"]))
        )
        assert found is None


async def test_estimate_a_feature_with_no_item(client):
    w = await company_world()
    before = by_feature(await w.read(client), w)["widgets"]
    assert before["effort"] is None and before["item_id"] is None
    body = {"op": "estimate_feature", "target": {"feature_id": w.ids["widgets"]},
            "before": {"goal_value": None, "effort": None}, "after": {"effort": 3}}  # fmt: skip
    r = await client.post(CHANGES, json=body, headers=w.ctx.as_("owner"))
    assert r.status_code in (200, 201), r.text
    row = by_feature(await w.read(client), w)["widgets"]
    assert row["effort"] == 3 and row["score"] is not None


async def test_own_key_only_for_a_real_code(client):
    w = await company_world()
    async with tenant_session(w.ctx.tenant_id) as s:
        f = await s.get(Entity, uuid.UUID(w.ids["ledger"]))
        f.key = "F-12"
        await s.commit()
    rows = by_feature(await w.read(client), w)
    assert rows["ledger"]["own_key"] == "F-12"
    assert rows["insights"]["own_key"] is None and rows["chatbot"]["own_key"] is None


async def test_a_placeholder_milestone_never_shows(client):
    w = await company_world()
    async with tenant_session(w.ctx.tenant_id) as s:
        row = await s.get(RoadmapItem, uuid.UUID(w.ids["pay-1"]))
        row.milestone = {"name": "Milestone N agents"}
        m = TrackMilestone(track_id=row.track_id, name="Milestone N agents",
                           target_date=date(2027, 1, 31), horizon="next", status="planned",
                           basis_ids=[uuid.uuid4()], item_keys=["pay-2"])  # fmt: skip
        s.add(m)
        await s.commit()
    out = await w.read(client)
    rows = by_feature(out, w)
    assert rows["ledger"]["milestone"] is None
    assert rows["exports"]["milestone"] == "Beta"
    assert not [ln for ln in out["lines"] if " N " in f" {ln['label']} "], out["lines"]


async def test_a_bracketed_milestone_name_shows(client):
    w = await company_world()
    async with tenant_session(w.ctx.tenant_id) as s:
        row = await s.get(RoadmapItem, uuid.UUID(w.ids["pay-1"]))
        row.milestone = {"name": "Beta [internal]"}
        m = TrackMilestone(track_id=row.track_id, name="Beta [internal]",
                           target_date=date(2027, 1, 31), horizon="next", status="planned",
                           basis_ids=[uuid.uuid4()], item_keys=["pay-2"])  # fmt: skip
        s.add(m)
        await s.commit()
    out = await w.read(client)
    assert by_feature(out, w)["ledger"]["milestone"] == "Beta [internal]"
    assert [ln for ln in out["lines"] if "Beta [internal]" in ln["label"]], out["lines"]


async def test_a_move_reuses_the_features_draft_item(client):
    w = await company_world()
    assert by_feature(await w.read(client), w)["widgets"]["on_roadmap"] is False
    body = {"op": "override_priority", "target": {"feature_id": w.ids["widgets"]},
            "before": {"override": None},
            "after": {"position": 1, "reason": REASON, "confirm": True}}  # fmt: skip
    r = await client.post(CHANGES, json=body, headers=w.ctx.as_("owner"))
    assert r.status_code in (200, 201), r.text
    async with tenant_session(w.ctx.tenant_id) as s:
        items = (
            await s.scalars(
                select(RoadmapItem).where(RoadmapItem.feature_id == uuid.UUID(w.ids["widgets"]))
            )
        ).all()
        assert [str(i.id) for i in items] == [w.ids["pay-5"]], "a second item was added"
        assert items[0].draft is False
    row = by_feature(await w.read(client), w)["widgets"]
    assert row["on_roadmap"] is True and row["item_id"] == w.ids["pay-5"]
