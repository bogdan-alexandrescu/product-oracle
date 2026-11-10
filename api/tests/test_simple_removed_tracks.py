"""removed-tracks: what was removed in Simple (cut features, archived goals, removed goal
milestones) listed with who and when, put back through the change engine; and tracks
added, edited and deleted (to Settings > Trash) through it. Against Postgres. The
company's clock is fixed to Mon Nov 2, 2026 (tests.test_simple_roadmap_api).

Test cards (protects / fails_when / no_claim):

- test_removed_lists_what_was_cut_archived_and_removed: protects=``GET
  /v1/simple/removed`` lists a cut feature (its roadmap's name, who cut it and when), an
  archived goal ("Goals", who archived it) and a removed goal milestone (its goal's name,
  who removed it), newest first, with whether the reader restores it and who decides
  otherwise; a goal rejected for another reason is left out; fails_when=a kind is missing,
  who/when is empty, or a viewer reads that they decide; no_claim=the web.
- test_a_feature_cut_from_its_panel_status_names_who_and_when: protects=a feature cut with
  op ``set_status`` (the feature panel's Status field, after.status cut) is on ``GET
  /v1/simple/removed`` with who cut it and when, as one cut with op ``cut`` (the panel's
  "Cut on <day> by <name>" line reads it); fails_when=who or when is empty for it;
  no_claim=the web (web/e2e/panel-menu-tree.spec.ts).
- test_unarchive_goal_and_restore_milestone_through_the_change_engine: protects=op
  ``unarchive_goal`` (this line's oracle.simple.goal_asks: an approver or owner applies it,
  a commenter's is proposed to the owners and applies on accept) takes an archived goal off
  the Removed list; ``restore_goal_milestone`` applies for who changes the roadmap, is
  proposed for a commenter, refused to a viewer; both read in words; fails_when=the goal or
  milestone does not come back, a commenter's change applies, or the words carry ids;
  no_claim=links of the goal's old features (they stay where the archive moved them).
- test_tracks_add_edit_delete_and_restore_from_trash: protects=``GET /v1/simple/tracks``
  and ops ``add_track``, ``edit_track``, ``delete_track``: an owner adds, renames, pauses
  and deletes a track; an approver's edit of another's track is proposed to its owner; a
  track owner who is an approver edits their own; a deleted track leaves every read, is in
  Settings > Trash as a Track, its features go to no track, and restoring it from Trash
  puts it and its features back; fails_when=any of those does not hold; no_claim=the web.
- test_a_tracks_feature_count_is_the_whole_roadmaps: protects=each row of ``GET
  /v1/simple/tracks`` counts its track's live features over the whole roadmap (cut and
  merged ones left out), whatever the roadmap's filters show (PR 1272 review);
  fails_when=the count is missing, counts a cut feature or another track's;
  no_claim=the web's filters (web/e2e/roadmap-tracks-sheet.spec.ts). Its ``moves_count``
  counts every feature on it, cut ones too: what Move to Trash sends to no track.
- test_undo_of_an_add_never_hard_deletes_a_track_that_holds_something: protects=Undo of
  ``add_track`` removes the track while it holds nothing added since; once it holds a
  milestone or a feature, Undo moves it to Settings > Trash (restorable, what it holds
  kept) and the undo says so (``after.in_trash``); fails_when=a track holding anything is
  hard-deleted, or an untouched one lands in Trash; no_claim=the web's toast.
- test_undo_of_an_add_keeps_a_track_that_anything_references: protects=a track alert, a
  launch or an outcome on the track since the add also sends it to Trash on Undo;
  fails_when=the hard delete drops the alert or unlinks the launch or outcome;
  no_claim=other references.
"""

import uuid

import pytest
from sqlalchemy import select

from oracle import company_time
from oracle.baseline.models import Entity
from oracle.members.names import display_name
from oracle.roadmap.models import ProductTrack, RoadmapItem, TrackMilestone
from oracle.tenancy import tenant_session
from oracle.trash.filter import INCLUDE_TRASHED
from tests.baseline_helpers import Ctx, make_ctx
from tests.test_simple_roadmap_api import NOW, Seed

CHANGES = "/v1/simple/changes"
REMOVED = "/v1/simple/removed"
TRACKS = "/v1/simple/tracks"
MILESTONES = "/v1/simple/roadmap/milestones"
GOALS = "/v1/simple/goal-buckets/goals"


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


def name(ctx: Ctx, role: str) -> str:
    u = ctx.users[role]
    return display_name(u.email, u.name)


def who(ctx: Ctx, role: str) -> str:
    """Who in a change's words (oracle.simple.changes._names)."""
    u = ctx.users[role]
    return u.name or u.email


async def seed(ctx: Ctx) -> dict:
    async with tenant_session(ctx.tenant_id) as s:
        sd = Seed(s)
        prd, pv, rm, rv = await sd.roadmap("launch")
        other_prd = await sd.doc("gift-boxes-prd")
        await sd.version(other_prd)
        track = await sd.track(pv, rm, title="Guided setup", owner_id=ctx.users["approver"].id)
        item = await sd.item(rv, pv, "f-01", title="Billing page", track_id=track.id)
        goal = await sd.entity("goal", "fewer-tickets")
        goal.title = "Fewer support tickets"
        other = await sd.entity("goal", "old-goal")
        other.status = "rejected"
        await s.commit()
        return {"roadmap_id": str(rm.id), "roadmap_title": rm.title, "item_id": str(item.id),
                "goal_id": str(goal.id), "other_goal_id": str(other.id),
                "track_id": str(track.id), "prd_id": str(other_prd.id),
                "own_prd_id": str(prd.id)}  # fmt: skip


async def change(client, ctx: Ctx, role: str, op: str, target: dict, after: dict | None = None,
                 code: int = 201, before: dict | None = None) -> dict:  # fmt: skip
    body = {"op": op, "target": target, "before": before or {}, "after": after or {}}
    r = await client.post(CHANGES, json=body, headers=ctx.as_(role))
    assert r.status_code == code, r.text
    return r.json()


async def removed(client, ctx: Ctx, role: str = "owner") -> list[dict]:
    r = await client.get(REMOVED, headers=ctx.as_(role))
    assert r.status_code == 200, r.text
    return r.json()["items"]


async def add_milestone(client, ctx: Ctx, ids: dict) -> dict:
    body = {"roadmap_id": ids["roadmap_id"], "name": "Prove it", "date": "2026-11-27",
            "goal_id": ids["goal_id"], "counts_when": "Ten teams finish setup"}  # fmt: skip
    r = await client.post(MILESTONES, json=body, headers=ctx.as_("owner"))
    assert r.status_code == 201, r.text
    return r.json()


async def test_removed_lists_what_was_cut_archived_and_removed(client):
    ctx = await make_ctx()
    ids = await seed(ctx)
    assert await removed(client, ctx) == []
    await change(client, ctx, "owner", "cut", {"item_id": ids["item_id"]}, {"cut": True},
                 before={"cut": False})  # fmt: skip
    r = await client.post(f"{GOALS}/{ids['goal_id']}/archive", json={"to_goal_id": None},
                          headers=ctx.as_("approver"))  # fmt: skip
    assert r.status_code == 200, r.text
    m = await add_milestone(client, ctx, ids)
    r = await client.delete(f"{MILESTONES}/{m['id']}", headers=ctx.as_("owner"))
    assert r.status_code in (200, 204), r.text

    items = await removed(client, ctx)
    by_kind = {i["kind"]: i for i in items}
    assert set(by_kind) == {"feature", "goal", "milestone"}, items
    f, g, ms = by_kind["feature"], by_kind["goal"], by_kind["milestone"]
    assert (f["id"], f["title"], f["where"]) == (ids["item_id"], "Billing page",
                                                 ids["roadmap_title"])  # fmt: skip
    assert f["by_name"] == name(ctx, "owner") and f["at"] is not None
    assert f["roadmap_id"] == ids["roadmap_id"] and f["can_decide"] is True
    assert (g["id"], g["title"], g["where"]) == (ids["goal_id"], "Fewer support tickets", "Goals")
    assert g["by_name"] == name(ctx, "approver") and g["at"] is not None
    assert ids["other_goal_id"] not in {i["id"] for i in items}
    assert (ms["id"], ms["title"], ms["where"]) == (m["id"], "Prove it", "Fewer support tickets")
    assert ms["by_name"] == name(ctx, "owner") and ms["at"] is not None
    assert all(i["can_decide"] for i in items)

    seen = await removed(client, ctx, "viewer")
    assert {i["kind"] for i in seen} >= {"goal", "milestone"}
    goal = next(i for i in seen if i["kind"] == "goal")
    assert goal["can_decide"] is False and goal["decider_name"] == name(ctx, "owner")
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(Entity, uuid.UUID(ids["goal_id"]))
        assert row.archived_by == ctx.users["approver"].id and row.archived_at is not None
        ml = await s.get(TrackMilestone, uuid.UUID(m["id"]))
        assert ml.deleted_by == ctx.users["owner"].id


async def test_a_feature_cut_from_its_panel_status_names_who_and_when(client):
    ctx = await make_ctx()
    ids = await seed(ctx)
    out = await change(client, ctx, "owner", "set_status", {"item_id": ids["item_id"]},
                       {"status": "cut"}, before={"status": "planned"})  # fmt: skip
    assert out["change"]["status"] == "applied", out
    (f,) = await removed(client, ctx)
    assert (f["kind"], f["id"]) == ("feature", ids["item_id"])
    assert f["by_name"] == name(ctx, "owner") and f["at"] is not None


async def test_unarchive_goal_and_restore_milestone_through_the_change_engine(client):
    ctx = await make_ctx()
    ids = await seed(ctx)
    r = await client.post(f"{GOALS}/{ids['goal_id']}/archive", json={"to_goal_id": None},
                          headers=ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 200, r.text
    undo = r.json()["undo"]
    # The archive's own Undo clears who/when.
    r = await client.post("/v1/simple/goal-buckets/undo", json=undo, headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(Entity, uuid.UUID(ids["goal_id"]))
        assert row.status != "rejected" and row.archived_at is None and row.archived_by is None
    r = await client.post(f"{GOALS}/{ids['goal_id']}/archive", json={"to_goal_id": None},
                          headers=ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 200, r.text

    # A commenter reads that the owners decide; an approver restores it directly.
    [row] = [i for i in await removed(client, ctx, "commenter") if i["kind"] == "goal"]
    assert row["can_decide"] is False and row["decider_name"]
    prop = (await change(client, ctx, "commenter", "unarchive_goal",
                         {"goal_id": ids["goal_id"]}))["change"]  # fmt: skip
    assert prop["status"] == "proposed"
    assert prop["routed_to"] == [str(ctx.users["owner"].id)]
    assert "restore the goal" in prop["words"] and "Fewer support tickets" in prop["words"]
    r = await client.post(f"{CHANGES}/{prop['id']}/accept", json={}, headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert r.json()["change"]["status"] == "accepted"
    assert not [i for i in await removed(client, ctx) if i["kind"] == "goal"]
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(Entity, uuid.UUID(ids["goal_id"]))
        assert row.archived_at is None and row.archived_by is None

    r = await client.post(f"{GOALS}/{ids['goal_id']}/archive", json={"to_goal_id": None},
                          headers=ctx.as_("owner"))  # fmt: skip
    done = (await change(client, ctx, "approver", "unarchive_goal",
                         {"goal_id": ids["goal_id"]}))["change"]  # fmt: skip
    assert done["status"] == "applied"
    assert "restored the goal" in done["words"] and "Fewer support tickets" in done["words"]
    assert not [i for i in await removed(client, ctx) if i["kind"] == "goal"]

    m = await add_milestone(client, ctx, ids)
    r = await client.delete(f"{MILESTONES}/{m['id']}", headers=ctx.as_("owner"))
    assert r.status_code in (200, 204), r.text
    await change(client, ctx, "viewer", "restore_goal_milestone", {"milestone_id": m["id"]},
                 code=403)  # fmt: skip
    # The approver owns the roadmap's track (they change it directly): a commenter proposes.
    prop = (await change(client, ctx, "commenter", "restore_goal_milestone",
                         {"milestone_id": m["id"]}))["change"]  # fmt: skip
    assert prop["status"] == "proposed" and "restored the milestone Prove it" in prop["words"]
    done = (await change(client, ctx, "owner", "restore_goal_milestone",
                         {"milestone_id": m["id"]}))["change"]  # fmt: skip
    assert done["status"] == "applied"
    async with tenant_session(ctx.tenant_id) as s:
        ml = await s.get(TrackMilestone, uuid.UUID(m["id"]))
        assert ml.deleted_at is None and ml.deleted_by is None
    assert not [i for i in await removed(client, ctx) if i["kind"] == "milestone"]
    # The approver's proposal is outdated now: the milestone is back.
    r = await client.post(f"{CHANGES}/{prop['id']}/accept", json={}, headers=ctx.as_("owner"))
    assert r.status_code == 409, r.text


async def read_tracks(client, ctx: Ctx, role: str = "owner") -> dict:
    r = await client.get(TRACKS, headers=ctx.as_(role))
    assert r.status_code == 200, r.text
    return r.json()


async def test_tracks_add_edit_delete_and_restore_from_trash(client):
    ctx = await make_ctx()
    ids = await seed(ctx)
    out = await read_tracks(client, ctx)
    assert out["can_add"] is True
    assert [t["title"] for t in out["tracks"]] == ["Guided setup"]
    t0 = out["tracks"][0]
    assert t0["owner_name"] == name(ctx, "approver") and t0["prd_id"] == ids["own_prd_id"]
    assert t0["can_decide"] is True
    assert ids["prd_id"] in [p["id"] for p in out["prds"]]
    # tracks-goal: a PRD on a track is offered as moving from it.
    on = next(p for p in out["prds"] if p["id"] == ids["own_prd_id"])
    assert on["track_title"] == "Guided setup"
    assert name(ctx, "viewer") in [p["name"] for p in out["people"]]
    seen = await read_tracks(client, ctx, "viewer")
    assert seen["can_add"] is False and seen["add_decider_name"] == name(ctx, "owner")
    assert seen["tracks"][0]["can_decide"] is False

    # add_track needs a name (tracks-goal: its PRD is optional).
    await change(client, ctx, "owner", "add_track", {}, {"prd_id": ids["prd_id"]}, code=422)
    await change(client, ctx, "viewer", "add_track", {},
                 {"title": "Gift boxes", "prd_id": ids["prd_id"]}, code=403)  # fmt: skip
    prop = (await change(client, ctx, "approver", "add_track", {},
                         {"title": "Gift boxes", "prd_id": ids["prd_id"]}))["change"]  # fmt: skip
    assert prop["status"] == "proposed" and prop["routed_to"] == [str(ctx.users["owner"].id)]
    added = (await change(client, ctx, "owner", "add_track", {},
                          {"title": "Gift boxes", "prd_id": ids["prd_id"],
                           "owner_id": str(ctx.users["owner"].id)}))["change"]  # fmt: skip
    assert added["status"] == "applied"
    assert added["words"] == f"{who(ctx, 'owner')} added the track Gift boxes"
    new_id = added["after"]["track_id"]
    out = await read_tracks(client, ctx)
    assert {t["title"] for t in out["tracks"]} == {"Guided setup", "Gift boxes"}
    on = next(p for p in out["prds"] if p["id"] == ids["prd_id"])
    assert on["track_title"] == "Gift boxes"

    renamed = (await change(client, ctx, "owner", "edit_track", {"track_id": new_id},
                            {"title": "Gift wrap"}))["change"]  # fmt: skip
    assert renamed["words"] == f"{who(ctx, 'owner')} renamed the track Gift boxes to Gift wrap"
    paused = (await change(client, ctx, "owner", "edit_track", {"track_id": new_id},
                           {"status": "paused"}))["change"]  # fmt: skip
    assert paused["words"] == f"{who(ctx, 'owner')} paused the track Gift wrap"
    out = await read_tracks(client, ctx)
    assert {t["title"]: t["status"] for t in out["tracks"]}["Gift wrap"] == "paused"

    # The approver owns Guided setup: they edit it directly; not the owner's Gift wrap.
    own = (await change(client, ctx, "approver", "edit_track", {"track_id": ids["track_id"]},
                        {"owner_id": str(ctx.users["owner"].id)}))["change"]  # fmt: skip
    assert own["status"] == "applied"
    assert own["words"] == (f"{who(ctx, 'approver')} set Guided setup's owner to "
                            f"{name(ctx, 'owner')}")  # fmt: skip
    prop = (await change(client, ctx, "approver", "edit_track", {"track_id": new_id},
                         {"status": "closed"}))["change"]  # fmt: skip
    assert prop["status"] == "proposed" and prop["routed_to"] == [str(ctx.users["owner"].id)]
    assert "closed the track Gift wrap" in prop["words"]

    gone = (await change(client, ctx, "owner", "delete_track",
                         {"track_id": ids["track_id"]}))["change"]  # fmt: skip
    assert gone["status"] == "applied"
    assert gone["words"] == f"{who(ctx, 'owner')} moved the track Guided setup to Trash"
    out = await read_tracks(client, ctx)
    assert [t["title"] for t in out["tracks"]] == ["Gift wrap"]
    r = await client.get("/v1/tracks", headers=ctx.as_("owner"))
    assert "Guided setup" not in r.text
    async with tenant_session(ctx.tenant_id) as s:
        item = await s.get(RoadmapItem, uuid.UUID(ids["item_id"]))
        assert item.track_id is None and item.prd_document_id is not None
    trash = (await client.get("/v1/trash", headers=ctx.as_("owner"))).json()
    entry = next(e for e in trash if e["root"]["type"] == "track")
    assert (entry["root"]["title"], entry["root"]["kind"]) == ("Guided setup", "Track")
    r = await client.post(f"/v1/trash/{entry['id']}/restore", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    out = await read_tracks(client, ctx)
    assert {t["title"] for t in out["tracks"]} == {"Guided setup", "Gift wrap"}
    async with tenant_session(ctx.tenant_id) as s:
        item = await s.get(RoadmapItem, uuid.UUID(ids["item_id"]))
        assert str(item.track_id) == ids["track_id"]

    # Undo of a delete puts the track back too.
    gone = (await change(client, ctx, "owner", "delete_track",
                         {"track_id": new_id}))["change"]  # fmt: skip
    r = await client.post(f"{CHANGES}/{gone['id']}/undo", headers=ctx.as_("owner"))
    assert r.status_code == 201, r.text
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.scalar(select(ProductTrack).where(ProductTrack.id == uuid.UUID(new_id))
                             .execution_options(**{INCLUDE_TRASHED: True}))  # fmt: skip
        assert row is not None and row.deleted_at is None


async def test_a_tracks_feature_count_is_the_whole_roadmaps(client):
    ctx = await make_ctx()
    ids = await seed(ctx)
    async with tenant_session(ctx.tenant_id) as s:
        first = await s.get(RoadmapItem, uuid.UUID(ids["item_id"]))
        for n, cut in ((2, False), (3, True)):
            s.add(RoadmapItem(roadmap_document_id=first.roadmap_document_id,
                              roadmap_version_id=first.roadmap_version_id, item_key=f"f-0{n}",
                              title=f"Feature {n}", horizon="later", position=n,
                              prd_document_id=first.prd_document_id,
                              prd_version_id=first.prd_version_id, track_id=first.track_id,
                              cut=cut))  # fmt: skip
        await s.commit()
    out = await read_tracks(client, ctx)
    assert [(t["title"], t["feature_count"]) for t in out["tracks"]] == [("Guided setup", 2)]
    added = (await change(client, ctx, "owner", "add_track", {},
                          {"title": "Gift boxes", "prd_id": ids["prd_id"]}))["change"]  # fmt: skip
    assert added["status"] == "applied"
    counts = {t["title"]: t["feature_count"] for t in (await read_tracks(client, ctx))["tracks"]}
    assert counts == {"Guided setup": 2, "Gift boxes": 0}
    # What Move to Trash sends to no track counts the cut one too, and is what moves.
    rows = (await read_tracks(client, ctx))["tracks"]
    assert {t["title"]: t["moves_count"] for t in rows} == {"Guided setup": 3, "Gift boxes": 0}
    await change(client, ctx, "owner", "delete_track", {"track_id": ids["track_id"]})
    async with tenant_session(ctx.tenant_id) as s:
        moved = await s.scalars(select(RoadmapItem.id).where(RoadmapItem.track_id.is_(None))
                                .execution_options(**{INCLUDE_TRASHED: True}))  # fmt: skip
        assert len(list(moved)) == 3


async def test_undo_of_an_add_never_hard_deletes_a_track_that_holds_something(client):
    ctx = await make_ctx()
    ids = await seed(ctx)

    async def track_row(track_id: str) -> ProductTrack | None:
        async with tenant_session(ctx.tenant_id) as s:
            return await s.scalar(select(ProductTrack)
                                  .where(ProductTrack.id == uuid.UUID(track_id))
                                  .execution_options(**{INCLUDE_TRASHED: True}))  # fmt: skip

    async def add() -> dict:
        after = {"title": "Gift boxes", "prd_id": ids["prd_id"]}
        return (await change(client, ctx, "owner", "add_track", {}, after))["change"]

    # Untouched since the add: Undo removes it, and the PRD takes a track again.
    first = await add()
    r = await client.post(f"{CHANGES}/{first['id']}/undo", headers=ctx.as_("owner"))
    assert r.status_code == 201, r.text
    assert not r.json()["change"]["after"].get("in_trash")
    assert await track_row(first["after"]["track_id"]) is None
    assert ids["prd_id"] in [p["id"] for p in (await read_tracks(client, ctx))["prds"]]

    # A milestone and a feature put on it since: Undo moves it to Trash, all kept.
    second = await add()
    new_id = second["after"]["track_id"]
    async with tenant_session(ctx.tenant_id) as s:
        s.add(TrackMilestone(track_id=uuid.UUID(new_id), name="Beta", horizon="now",
                             item_keys=["f-01"]))  # fmt: skip
        item = await s.get(RoadmapItem, uuid.UUID(ids["item_id"]))
        item.track_id = uuid.UUID(new_id)
        await s.commit()
    r = await client.post(f"{CHANGES}/{second['id']}/undo", headers=ctx.as_("owner"))
    assert r.status_code == 201, r.text
    assert r.json()["change"]["after"].get("in_trash") is True
    row = await track_row(new_id)
    assert row is not None and row.deleted_at is not None
    assert "Gift boxes" not in [t["title"] for t in (await read_tracks(client, ctx))["tracks"]]
    async with tenant_session(ctx.tenant_id) as s:
        kept = await s.scalar(select(TrackMilestone).where(TrackMilestone.name == "Beta")
                              .execution_options(**{INCLUDE_TRASHED: True}))  # fmt: skip
        assert kept is not None and str(kept.track_id) == new_id
    trash = (await client.get("/v1/trash", headers=ctx.as_("owner"))).json()
    entry = next(e for e in trash if e["root"]["type"] == "track")
    assert entry["root"]["title"] == "Gift boxes"
    r = await client.post(f"/v1/trash/{entry['id']}/restore", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    row = await track_row(new_id)
    assert row is not None and row.deleted_at is None
    async with tenant_session(ctx.tenant_id) as s:
        item = await s.get(RoadmapItem, uuid.UUID(ids["item_id"]))
        assert str(item.track_id) == new_id


async def test_another_company_neither_reads_nor_changes_these(client):
    # protects=the removed list, the tracks and their ops are the company's own (tenant
    # scope); fails_when=another company reads them, changes one by its id or adds a
    # track on this company's PRD (refused in words that do not say whether it exists).
    ctx = await make_ctx()
    ids = await seed(ctx)
    await change(client, ctx, "owner", "add_track", {},
                 {"title": "Gift boxes", "prd_id": ids["prd_id"]})  # fmt: skip
    other = await make_ctx()
    out = await read_tracks(client, other)
    assert out["tracks"] == [] and out["prds"] == []
    assert await removed(client, other) == []
    await change(client, other, "owner", "delete_track", {"track_id": ids["track_id"]},
                 code=404)  # fmt: skip
    await change(client, other, "owner", "add_track", {},
                 {"title": "Theirs", "prd_id": ids["prd_id"]}, code=409)  # fmt: skip
    assert (await read_tracks(client, other))["tracks"] == []
    titles = {t["title"] for t in (await read_tracks(client, ctx))["tracks"]}
    assert titles == {"Guided setup", "Gift boxes"}


@pytest.mark.parametrize("kind", ["alert", "launch", "outcome"])
async def test_undo_of_an_add_keeps_a_track_that_anything_references(client, kind):
    """A track alert (deleted with its track) or a launch or outcome (unlinked) made since
    the add: Undo moves the track to Trash, not a hard delete."""
    from oracle.launches.models import Launch
    from oracle.quality.models import OutcomeRecord
    from oracle.roadmap.models import TrackAlert

    ctx = await make_ctx()
    ids = await seed(ctx)
    after = {"title": "Gift boxes", "prd_id": ids["prd_id"]}
    added = (await change(client, ctx, "owner", "add_track", {}, after))["change"]
    track_id = uuid.UUID(added["after"]["track_id"])
    async with tenant_session(ctx.tenant_id) as s:
        if kind == "alert":
            s.add(TrackAlert(track_id=track_id, kind="stale", fingerprint="a1",
                             detail="No change in two weeks"))  # fmt: skip
        elif kind == "launch":
            s.add(Launch(title="Gift boxes launch", track_id=track_id))
        else:
            s.add(OutcomeRecord(title="Fewer tickets", goal_id=uuid.UUID(ids["goal_id"]),
                                track_id=track_id))  # fmt: skip
        await s.commit()
    r = await client.post(f"{CHANGES}/{added['id']}/undo", headers=ctx.as_("owner"))
    assert r.status_code == 201, r.text
    assert r.json()["change"]["after"].get("in_trash") is True
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.scalar(select(ProductTrack).where(ProductTrack.id == track_id)
                             .execution_options(**{INCLUDE_TRASHED: True}))  # fmt: skip
        assert row is not None and row.deleted_at is not None
