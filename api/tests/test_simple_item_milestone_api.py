"""item-milestone (product gap, Nov 6, 2026): a roadmap item is placed in one of its roadmap's
milestones from the one feature panel (``set_milestone`` with ``after.milestone.id``, a goal
milestone of the item's roadmap), and the company roadmap lists every PRD's milestones even
when two PRDs' items serve the same goal. Against Postgres; invented example data only.

Test cards (protects / fails_when / no_claim):

- test_panel_places_an_item_in_a_roadmap_milestone: protects=a decider places an item in a
  PRD milestone of its roadmap by the milestone's id (applied into the working draft, with
  Undo), the item reads that milestone by id with its code and name and keeps its dates; a
  stale ``before`` is a 409, a move to another milestone and a clear go through, Undo puts the
  last one back; a milestone of another roadmap or no milestone at all is a 422 that says so in
  plain words, and a deleted one says it was deleted; a commenter's pick is proposed (the item
  unchanged) and a viewer is refused; fails_when=the pick is not stored or read by id, it moves
  the item's dates, it applies for a commenter, a foreign or deleted milestone is taken, or the
  refusal is not plain words; no_claim=the web (web/e2e/item-milestone.spec.ts).
- test_a_proposed_pick_of_a_milestone_deleted_since_is_refused_on_accept: protects=a commenter's
  pick waits on the decider; the milestone is deleted meanwhile, and accepting it is refused in
  plain words with the item left in no milestone and the proposal still open; fails_when=the
  accept places the item in a deleted milestone; no_claim=declining it (the change engine's).
- test_undo_back_into_a_milestone_deleted_since_is_refused: protects=an item moved out of a
  milestone that is then put in Trash: Undo, which would point it back at that milestone, is
  refused with a 422 in a forward pick's words, the item left where it is and the change still
  undoable once nothing changed; fails_when=Undo writes the deleted milestone back;
  no_claim=a typed (name and day) milestone, which has no Trash.
- test_company_roadmap_lists_each_prds_milestones_in_one_goal: protects=two PRDs whose items
  serve the same goal on the company roadmap both have their own M1 listed (a PRD's milestones
  are coded per PRD, not per goal), and an item of one PRD is placed in the other PRD's M1;
  fails_when=the second PRD's M1 is dropped (the per-goal code index) or cannot be picked;
  no_claim=a PRD with no item on the roadmap (its milestones are read only with its items).
"""

import uuid
from datetime import UTC, date, datetime

from oracle.roadmap.models import RoadmapItem, TrackMilestone
from oracle.simple.models import SimplePrdPlan
from oracle.tenancy import tenant_session
from tests.test_simple_changes_api import CHANGES, World, clock, make_people  # noqa: F401
from tests.test_simple_roadmap_api import Seed

ROADMAP = "/v1/simple/roadmap"


def _plan(*milestones: tuple[str, str, str | None]) -> dict:
    return {
        "milestones": [
            {"code": code, "name": name, "start": None, "end": end, "effort_weeks": None,
             "done_when": [], "targets": []}
            for code, name, end in milestones
        ],
        "features": [], "goals": [], "holidays": [],
    }  # fmt: skip


async def _read(client, ctx, who: str) -> dict:
    r = await client.get(ROADMAP, headers=ctx.as_(who))
    assert r.status_code == 200, r.text
    return r.json()


def _item(body: dict, item_id: str) -> dict:
    return next(i for i in body["items"] if i["id"] == item_id)


async def _post(client, ctx, who: str, item_id: str, before, after):
    body = {"op": "set_milestone", "target": {"item_id": item_id},
            "before": {"milestone": before}, "after": {"milestone": after}}  # fmt: skip
    return await client.post(CHANGES, json=body, headers=ctx.as_(who))


async def test_panel_places_an_item_in_a_roadmap_milestone(client):
    ctx = await make_people()
    w = await World(ctx).build(decider=True, ops=["im"])
    a = w.ids["im-a"]
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(RoadmapItem, uuid.UUID(a))
        s.add(SimplePrdPlan(document_id=row.prd_document_id, version_id=row.prd_version_id,
                            status="ready", source="prd",
                            data=_plan(("M1", "Prove it", "2026-11-27"),
                                       ("M2", "Scale volume", "2026-12-18"))))  # fmt: skip
        other = await Seed(s).doc("hiking-roadmap", "roadmap")
        foreign = TrackMilestone(track_id=None, roadmap_id=other.id, code="M1",
                                 name="Trail maps live", target_date=date(2026, 12, 4))  # fmt: skip
        gone = TrackMilestone(track_id=None, roadmap_id=uuid.UUID(w.roadmap_id), code="M7",
                              name="Old launch", deleted_at=datetime.now(UTC))  # fmt: skip
        s.add_all([foreign, gone])
        await s.commit()
        foreign_id, gone_id = str(foreign.id), str(gone.id)
    body = await _read(client, ctx, "decider")
    ms = {m["code"]: m for m in body["goal_milestones"] if m["roadmap_id"] == w.roadmap_id}
    assert {"M1", "M2"} <= set(ms), body["goal_milestones"]
    m1, m2 = ms["M1"], ms["M2"]
    seen = _item(body, a)
    assert seen["milestone"] is None
    dates = (seen["start"]["date"], seen["end"]["date"])

    # A viewer changes nothing; a commenter's pick waits on the decider.
    r = await _post(client, ctx, "viewer", a, None, {"id": m1["id"]})
    assert r.status_code == 403, r.text
    r = await _post(client, ctx, "commenter", a, None, {"id": m1["id"]})
    assert r.status_code == 201, r.text
    assert r.json()["change"]["status"] == "proposed"
    assert _item(await _read(client, ctx, "decider"), a)["milestone"] is None

    # Not a milestone of the item's roadmap, none at all, or a deleted one: refused, in plain words.
    for bad in (foreign_id, str(uuid.uuid4())):
        r = await _post(client, ctx, "decider", a, None, {"id": bad})
        assert r.status_code == 422, r.text
        assert r.json()["detail"] == "That milestone is not on this item's roadmap.", r.text
    r = await _post(client, ctx, "decider", a, None, {"id": gone_id})
    assert r.status_code == 422, r.text
    assert r.json()["detail"] == "That milestone was deleted.", r.text

    r = await _post(client, ctx, "decider", a, None, {"id": m1["id"], "name": "M1 Prove it"})
    assert r.status_code == 201, r.text
    first = r.json()["change"]
    assert (first["status"], first["can_undo"]) == ("applied", True)
    it = _item(await _read(client, ctx, "decider"), a)
    assert it["milestone"]["id"] == m1["id"]
    # roadmap-milestone-codes: read by its code across the roadmap read.
    assert (it["milestone"]["name"], it["milestone"]["source"]) == (
        f"{m1['roadmap_code']} Prove it",
        "item",
    )
    # Placing it in a milestone leaves its dates as they were.
    assert (it["start"]["date"], it["end"]["date"]) == dates

    # A stale before (it had no milestone) is a conflict; the one read moves it.
    r = await _post(client, ctx, "decider", a, None, {"id": m2["id"]})
    assert r.status_code == 409, r.text
    shown = {k: it["milestone"][k] for k in ("id", "name", "date")}
    r = await _post(client, ctx, "decider", a, shown, {"id": m2["id"]})
    assert r.status_code == 201, r.text
    moved = r.json()["change"]
    it = _item(await _read(client, ctx, "decider"), a)
    assert (it["milestone"]["id"], it["milestone"]["name"]) == (
        m2["id"],
        f"{m2['roadmap_code']} Scale volume",
    )
    assert m2["roadmap_code"] == "M3"  # after M1 Prove it and the other roadmap's Dec 4 one

    # Undo puts M1 back.
    r = await client.post(f"{CHANGES}/{moved['id']}/undo", headers=ctx.as_("decider"))
    assert r.status_code in (200, 201), r.text
    it = _item(await _read(client, ctx, "decider"), a)
    assert it["milestone"]["id"] == m1["id"]

    # No milestone.
    shown = {k: it["milestone"][k] for k in ("id", "name", "date")}
    r = await _post(client, ctx, "decider", a, shown, None)
    assert r.status_code == 201, r.text
    assert _item(await _read(client, ctx, "decider"), a)["milestone"] is None


async def test_company_roadmap_lists_each_prds_milestones_in_one_goal(client):
    ctx = await make_people()
    async with tenant_session(ctx.tenant_id) as s:
        sd = Seed(s)
        goal = await sd.entity("goal", "more-hikers")
        safety = await sd.doc("trail-safety")
        sv = await sd.version(safety)
        scale = await sd.doc("trail-scale")
        cv_scale = await sd.version(scale)
        company = await sd.doc("product-roadmap", "roadmap")
        company.company_roadmap = True
        cv = await sd.version(company)
        a = await sd.item(cv, sv, "report-button", title="Report button", goal_ids=[goal.id])
        await sd.item(cv, cv_scale, "read-replicas", position=1, title="Read replicas",
                      goal_ids=[goal.id])  # fmt: skip
        s.add_all([
            SimplePrdPlan(document_id=safety.id, version_id=sv.id, status="ready", source="prd",
                          data=_plan(("M1", "Reports reach a person", "2026-11-27"),
                                     ("M2", "Blocks hold everywhere", "2026-12-18"))),
            SimplePrdPlan(document_id=scale.id, version_id=cv_scale.id, status="ready",
                          source="prd", data=_plan(("M1", "Load measured", "2026-12-04"))),
        ])  # fmt: skip
        await s.commit()
        ids = {"a": str(a.id), "company": str(company.id), "safety": str(safety.id),
               "scale": str(scale.id)}  # fmt: skip
    body = await _read(client, ctx, "owner")
    listed = {
        (m["prd"]["id"] if m["prd"] else None, m["code"]): m
        for m in body["goal_milestones"]
        if m["roadmap_id"] == ids["company"]
    }
    assert set(listed) == {
        (ids["safety"], "M1"), (ids["safety"], "M2"), (ids["scale"], "M1"),
    }, sorted(listed)  # fmt: skip
    scale_m1 = listed[(ids["scale"], "M1")]
    assert scale_m1["name"] == "Load measured"
    # A second read lists them once (the rows are made once).
    again = [m for m in (await _read(client, ctx, "owner"))["goal_milestones"]
             if m["roadmap_id"] == ids["company"]]  # fmt: skip
    assert len(again) == 3

    # An item of User Safety goes into Scale's M1.
    r = await _post(client, ctx, "owner", ids["a"], None, {"id": scale_m1["id"]})
    assert r.status_code == 201, r.text
    assert r.json()["change"]["status"] == "applied"
    it = _item(await _read(client, ctx, "owner"), ids["a"])
    # roadmap-milestone-codes: two PRDs' M1 are two milestones with two codes across the roadmap.
    assert (it["milestone"]["id"], it["milestone"]["name"]) == (
        scale_m1["id"],
        f"{scale_m1['roadmap_code']} Load measured",
    )
    assert scale_m1["roadmap_code"] == "M2"


async def test_a_proposed_pick_of_a_milestone_deleted_since_is_refused_on_accept(client):
    ctx = await make_people()
    w = await World(ctx).build(decider=True, ops=["im"])
    a = w.ids["im-a"]
    async with tenant_session(ctx.tenant_id) as s:
        own = TrackMilestone(track_id=None, roadmap_id=uuid.UUID(w.roadmap_id), code="M1",
                             name="Beta for ten teams", target_date=date(2026, 12, 4))  # fmt: skip
        s.add(own)
        await s.commit()
        own_id = own.id
    r = await _post(client, ctx, "commenter", a, None, {"id": str(own_id)})
    assert r.status_code == 201, r.text
    proposal = r.json()["change"]
    assert proposal["status"] == "proposed"
    async with tenant_session(ctx.tenant_id) as s:
        (await s.get(TrackMilestone, own_id)).deleted_at = datetime.now(UTC)
        await s.commit()
    r = await client.post(f"{CHANGES}/{proposal['id']}/accept", json={},
                          headers=ctx.as_("decider"))  # fmt: skip
    assert r.status_code == 422, r.text
    assert r.json()["detail"] == "That milestone was deleted.", r.text
    assert _item(await _read(client, ctx, "decider"), a)["milestone"] is None
    rows = (await client.get(CHANGES, headers=ctx.as_("decider"))).json()
    assert {c["id"]: c["status"] for c in rows}[proposal["id"]] == "proposed", rows


async def test_undo_back_into_a_milestone_deleted_since_is_refused(client):
    ctx = await make_people()
    w = await World(ctx).build(decider=True, ops=["im"])
    a = w.ids["im-a"]
    async with tenant_session(ctx.tenant_id) as s:
        own = TrackMilestone(track_id=None, roadmap_id=uuid.UUID(w.roadmap_id), code="M1",
                             name="Beta for ten teams", target_date=date(2026, 12, 4))  # fmt: skip
        s.add(own)
        await s.commit()
        own_id = own.id
    r = await _post(client, ctx, "decider", a, None, {"id": str(own_id)})
    assert r.status_code == 201, r.text
    it = _item(await _read(client, ctx, "decider"), a)
    shown = {k: it["milestone"][k] for k in ("id", "name", "date")}
    r = await _post(client, ctx, "decider", a, shown, None)
    assert r.status_code == 201, r.text
    cleared = r.json()["change"]
    async with tenant_session(ctx.tenant_id) as s:
        (await s.get(TrackMilestone, own_id)).deleted_at = datetime.now(UTC)
        await s.commit()
    r = await client.post(f"{CHANGES}/{cleared['id']}/undo", headers=ctx.as_("decider"))
    assert r.status_code == 422, r.text
    assert r.json()["detail"] == "That milestone was deleted.", r.text
    assert _item(await _read(client, ctx, "decider"), a)["milestone"] is None
