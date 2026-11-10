"""tracks-goal: a track's PRD is optional, and a track may be tied to one company goal
(the goal it replaces as the Roadmap's band). Through the change engine (``add_track``,
``edit_track``) and every read of a track. Against Postgres; the company's clock is fixed
(tests.test_simple_roadmap_api).

Test cards (protects / fails_when / no_claim):

- test_a_track_adds_with_no_prd: protects=``add_track`` with no ``prd_id`` adds a track
  (an owner's applies) that ``GET /v1/simple/tracks``, ``GET /v1/tracks`` and the
  roadmap read with no PRD; its Undo removes it; fails_when=the add is refused or a read
  fails or names a PRD; no_claim=the web.
- test_edit_track_sets_and_clears_the_goal_and_the_prd: protects=``edit_track`` sets and
  clears ``goal_id`` and ``prd_id``; the goal reads as its id and name on the track's row
  and on its features' track; an approver's change to another's track is proposed and
  applies on accept; Undo puts the goal back; an archived goal or a feature is refused;
  fails_when=any of those does not hold; no_claim=the Roadmap's bands.
- test_a_prd_keeps_one_track: protects=a PRD with a track is neither added to nor set on
  another track (409), and a PRD taken off a track is free again; fails_when=two tracks
  share a PRD; no_claim=a PRD's track in Trash (tests.test_simple_removed_tracks).
- test_a_prd_set_on_a_track_adopts_its_issues_and_roadmap: protects=``edit_track`` setting a
  PRD on a track does what ``ensure_track`` does for a new one: the PRD's linked issues with
  no track join it and a track with no roadmap takes the PRD's latest; fails_when=either is
  left unset; no_claim=a PRD's issues already on another track.
- test_a_feature_on_a_track_with_no_prd_reads_everywhere: protects=a feature on a track with
  no PRD reads in track health, the track monitor, the Plan, priorities and the weekly
  alignment report (each 200, naming the feature), with no SQLAlchemy "fully NULL primary
  key" warning; fails_when=any read fails or looks up a Document with no id; no_claim=the
  web.
"""

import pytest
from sqlalchemy import select

from oracle import company_time
from oracle.docs.models import DocumentVersion
from oracle.roadmap.models import ProductTrack, TrackerRecord
from oracle.tenancy import tenant_session
from tests.baseline_helpers import Ctx, make_ctx
from tests.test_simple_removed_tracks import read_tracks
from tests.test_simple_roadmap_api import NOW, URL, Seed

CHANGES = "/v1/simple/changes"


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


async def seed(ctx: Ctx) -> dict:
    async with tenant_session(ctx.tenant_id) as s:
        sd = Seed(s)
        prd, pv, rm, rv = await sd.roadmap("launch")
        free = await sd.doc("gift-boxes-prd")
        await sd.version(free)
        track = await sd.track(pv, rm, title="Guided setup", owner_id=ctx.users["owner"].id)
        item = await sd.item(rv, pv, "f-01", title="Billing page", track_id=track.id)
        goal = await sd.entity("goal", "keep-accounts")
        goal.title = "Keep more accounts"
        archived = await sd.entity("goal", "old-goal")
        archived.status = "rejected"
        feature = await sd.entity("feature", "a-feature")
        await s.commit()
        return {"track_id": str(track.id), "item_id": str(item.id), "own_prd_id": str(prd.id),
                "free_prd_id": str(free.id), "goal_id": str(goal.id),
                "archived_id": str(archived.id), "feature_id": str(feature.id)}  # fmt: skip


async def change(client, ctx: Ctx, role: str, op: str, target: dict, after: dict,
                 code: int = 201) -> dict:  # fmt: skip
    body = {"op": op, "target": target, "before": {}, "after": after}
    r = await client.post(CHANGES, json=body, headers=ctx.as_(role))
    assert r.status_code == code, r.text
    return r.json()


def row(out: dict, title: str) -> dict:
    return next(t for t in out["tracks"] if t["title"] == title)


async def test_a_track_adds_with_no_prd(client):
    ctx = await make_ctx()
    ids = await seed(ctx)
    added = (await change(client, ctx, "owner", "add_track", {},
                          {"title": "Account Management"}))["change"]  # fmt: skip
    assert added["status"] == "applied", added
    out = await read_tracks(client, ctx)
    t = row(out, "Account Management")
    assert (t["prd_id"], t["prd_title"], t["goal_id"], t["goal_name"]) == (None, None, None, None)
    # The free PRD stays free: a track with no PRD takes none.
    assert ids["free_prd_id"] in [p["id"] for p in out["prds"]]
    r = await client.get("/v1/tracks", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert "Account Management" in r.text
    r = await client.get(URL, headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    r = await client.post(f"{CHANGES}/{added['id']}/undo", headers=ctx.as_("owner"))
    assert r.status_code == 201, r.text
    assert "Account Management" not in [
        t["title"] for t in (await read_tracks(client, ctx))["tracks"]
    ]
    # One who does not decide proposes it; an owner accepts.
    after = {"title": "Account Management", "goal_id": ids["goal_id"]}
    prop = (await change(client, ctx, "approver", "add_track", {}, after))["change"]
    assert prop["status"] == "proposed"
    r = await client.post(f"{CHANGES}/{prop['id']}/accept", json={}, headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    t = row(await read_tracks(client, ctx), "Account Management")
    assert (t["prd_id"], t["goal_id"], t["goal_name"]) == (
        None,
        ids["goal_id"],
        "Keep more accounts",
    )


async def test_edit_track_sets_and_clears_the_goal_and_the_prd(client):
    ctx = await make_ctx()
    ids = await seed(ctx)
    tid = {"track_id": ids["track_id"]}
    done = (await change(client, ctx, "owner", "edit_track", tid,
                         {"goal_id": ids["goal_id"]}))["change"]  # fmt: skip
    assert done["status"] == "applied"
    assert "Keep more accounts" in done["words"] and ids["goal_id"] not in done["words"]
    t = row(await read_tracks(client, ctx), "Guided setup")
    assert (t["goal_id"], t["goal_name"]) == (ids["goal_id"], "Keep more accounts")
    r = await client.get(URL, headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    item = next(i for i in r.json()["items"] if i["id"] == ids["item_id"])
    assert item["track"]["goal_id"] == ids["goal_id"]
    assert item["track"]["goal_name"] == "Keep more accounts"

    # Undo puts the goal back as it was.
    r = await client.post(f"{CHANGES}/{done['id']}/undo", headers=ctx.as_("owner"))
    assert r.status_code == 201, r.text
    assert row(await read_tracks(client, ctx), "Guided setup")["goal_id"] is None
    await change(client, ctx, "owner", "edit_track", tid, {"goal_id": ids["goal_id"]})
    cleared = (await change(client, ctx, "owner", "edit_track", tid,
                            {"goal_id": None}))["change"]  # fmt: skip
    assert cleared["status"] == "applied"
    assert row(await read_tracks(client, ctx), "Guided setup")["goal_id"] is None

    # Only a live goal: an archived one, or a feature, is refused.
    await change(client, ctx, "owner", "edit_track", tid, {"goal_id": ids["archived_id"]}, 422)
    await change(client, ctx, "owner", "edit_track", tid, {"goal_id": ids["feature_id"]}, 422)

    # The PRD clears and is set again; the track keeps its features.
    off = (await change(client, ctx, "owner", "edit_track", tid, {"prd_id": None}))["change"]
    assert off["status"] == "applied"
    t = row(await read_tracks(client, ctx), "Guided setup")
    assert (t["prd_id"], t["prd_title"], t["feature_count"]) == (None, None, 1)
    on = (await change(client, ctx, "owner", "edit_track", tid,
                       {"prd_id": ids["free_prd_id"]}))["change"]  # fmt: skip
    assert on["status"] == "applied"
    t = row(await read_tracks(client, ctx), "Guided setup")
    assert t["prd_id"] == ids["free_prd_id"] and t["prd_title"]

    # The approver neither owns nor decides Guided setup: their goal change is proposed.
    prop = (await change(client, ctx, "approver", "edit_track", tid,
                         {"goal_id": ids["goal_id"]}))["change"]  # fmt: skip
    assert prop["status"] == "proposed"
    assert row(await read_tracks(client, ctx), "Guided setup")["goal_id"] is None
    r = await client.post(f"{CHANGES}/{prop['id']}/accept", json={}, headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert row(await read_tracks(client, ctx), "Guided setup")["goal_id"] == ids["goal_id"]


async def test_a_prd_keeps_one_track(client):
    ctx = await make_ctx()
    ids = await seed(ctx)
    await change(client, ctx, "owner", "add_track", {},
                 {"title": "Second", "prd_id": ids["own_prd_id"]}, 409)  # fmt: skip
    added = (await change(client, ctx, "owner", "add_track", {}, {"title": "Second"}))["change"]
    other = {"track_id": added["after"]["track_id"]}
    await change(client, ctx, "owner", "edit_track", other, {"prd_id": ids["own_prd_id"]}, 409)
    # Taken off Guided setup, its PRD is free for another track.
    await change(client, ctx, "owner", "edit_track", {"track_id": ids["track_id"]},
                 {"prd_id": None})  # fmt: skip
    assert ids["own_prd_id"] in [p["id"] for p in (await read_tracks(client, ctx))["prds"]]
    await change(client, ctx, "owner", "edit_track", other, {"prd_id": ids["own_prd_id"]})
    out = await read_tracks(client, ctx)
    assert row(out, "Second")["prd_id"] == ids["own_prd_id"]
    assert row(out, "Guided setup")["prd_id"] is None
    assert ids["own_prd_id"] not in [p["id"] for p in out["prds"]]


async def test_a_prd_set_on_a_track_adopts_its_issues_and_roadmap(client):
    ctx = await make_ctx()
    async with tenant_session(ctx.tenant_id) as s:
        sd = Seed(s)
        prd = await sd.doc("gift-boxes-prd")
        pv = await sd.version(prd)
        rm = await sd.doc("gift-boxes", "roadmap")
        await sd.add(
            DocumentVersion(document_id=rm.id, number=1, markdown="# gift-boxes\n",
                            content_hash="gift-boxes-1", source_version_id=pv.id)
        )  # fmt: skip
        record = await sd.add(
            TrackerRecord(tracker="linear", external_ref="EX-7", prd_document_id=prd.id,
                          item_key="f-02", state="todo", observed_at=NOW)
        )  # fmt: skip
        await s.commit()
        prd_id, rm_id, record_id = str(prd.id), rm.id, record.id
    added = await change(client, ctx, "owner", "add_track", {}, {"title": "Gift Boxes"})
    tid = added["change"]["after"]["track_id"]
    await change(client, ctx, "owner", "edit_track", {"track_id": tid}, {"prd_id": prd_id})
    async with tenant_session(ctx.tenant_id) as s:
        track = await s.scalar(select(ProductTrack).where(ProductTrack.id == tid))
        assert str(track.prd_document_id) == prd_id
        assert track.roadmap_document_id == rm_id
        record = await s.scalar(select(TrackerRecord).where(TrackerRecord.id == record_id))
        assert str(record.track_id) == tid


@pytest.mark.filterwarnings("error:.*fully NULL primary key")
async def test_a_feature_on_a_track_with_no_prd_reads_everywhere(client):
    ctx = await make_ctx()
    async with tenant_session(ctx.tenant_id) as s:
        sd = Seed(s)
        rm = await sd.doc("accounts", "roadmap")
        rv = await sd.version(rm)
        track = await sd.add(ProductTrack(title="Account Management", status="active",
                                          roadmap_document_id=rm.id))  # fmt: skip
        await sd.item(rv, None, "f-03", title="Saved addresses", track_id=track.id)
        await s.commit()
        tid = track.id
    owner = ctx.as_("owner")
    reads = [
        await client.get(f"/v1/tracks/{tid}", headers=owner),
        await client.post(f"/v1/tracks/{tid}/monitor", headers=owner),
        await client.get("/v1/plan", headers=owner),
        await client.get("/v1/simple/priorities", headers=owner),
        await client.post("/v1/alignment-reports", json={}, headers=owner),
    ]
    for r in reads:
        assert r.status_code in (200, 201), (r.request.url, r.text)
        assert "Saved addresses" in r.text, (r.request.url, r.text)
