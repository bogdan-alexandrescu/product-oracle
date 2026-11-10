"""tracks-goal (owner Nov 9): a track holds many PRDs; a PRD belongs to at most one track.
Oracle starts no track on its own: a PRD taken off a track gets none again, and a newly
accepted PRD on no track gets one Inbox suggestion that a person confirms. Against Postgres;
the company's clock is fixed (tests.test_simple_roadmap_api).

Test cards (protects / fails_when / no_claim):

- test_two_prds_on_one_track_read_everywhere: protects=a second PRD put on a track
  (``edit_track`` ``prd_ids``) reads in the Tracks sheet, track health, the track monitor,
  the Plan, priorities, the Roadmap (both PRDs' features on the track), the weekly
  alignment report, and its linked issue joins the track; fails_when=any reader sees only
  the first PRD or fails; no_claim=the web.
- test_a_prd_taken_off_a_track_starts_none_again: protects=a PRD a person took off a track
  starts no track and gets no suggestion when accepted again; fails_when=a track or an Inbox
  item appears for it.
- test_a_new_prd_gets_one_suggestion_and_confirming_links_it: protects=a newly accepted PRD
  on no track starts no track, gets one Inbox item for its owner naming the best-fitting
  track (by name); Confirm puts it on that track, the item leaves the Inbox and its
  feature reads the track; New track starts one for it; fails_when=a track starts on its
  own, two items show, or the item stays after confirming.
- test_confirming_a_track_another_decides_waits_for_them: protects=the PRD's owner confirming
  a track another decides proposes it to that decider: the owner's item shows it waits (whose
  and which track; not counted), a second proposal for the PRD is refused, the change holds
  only add_prd_id, and accepting puts on only that PRD; both Inbox items leave; fails_when=
  the item keeps its actions, a second proposal is made, or accepting restores a PRD taken
  off meanwhile.
- test_a_declined_track_proposal_brings_the_suggestion_back: protects=a decline brings the
  suggestion back with its actions; fails_when=it stays waiting or gone.
- test_a_proposed_removal_takes_off_only_that_prd: protects=remove_prd_id takes off only that
  PRD when accepted; fails_when=a PRD added meanwhile is dropped.
- test_placing_a_prd_directly_closes_its_open_proposal: protects=the track's decider putting a
  PRD on a track directly (``add_prd_id`` or ``prd_ids``) closes an open proposal for that PRD
  (declined, by them): it leaves their Inbox and the PRD owner's item, and is no longer
  decided; fails_when=it stays open, still counts, or its Accept answers 409 "outdated".
- test_placing_one_prd_of_a_two_prd_proposal_keeps_the_rest_open: protects=the track's
  decider putting one PRD of an open two-PRD proposal on a track directly takes only that
  PRD out of the proposal (saying why); the rest stays open and, accepted, puts on only the
  other PRD; fails_when=the whole proposal is declined, or accepting moves the placed PRD.
"""

import uuid

import pytest
from sqlalchemy import select

from oracle import changes, company_time
from oracle.docs.models import DocumentVersion
from oracle.roadmap.models import ProductTrack, TrackerRecord, TrackPrd
from oracle.simple.models import SimpleChange
from oracle.tenancy import tenant_session
from tests.baseline_helpers import Ctx, make_ctx
from tests.test_simple_removed_tracks import read_tracks
from tests.test_simple_roadmap_api import NOW, URL, Seed
from tests.test_simple_tracks_goal import CHANGES, change, row


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


async def seed(ctx: Ctx) -> dict:
    async with tenant_session(ctx.tenant_id) as s:
        sd = Seed(s)
        prd, pv, rm, rv = await sd.roadmap("checkout")
        track = await sd.track(pv, rm, title="Checkout", owner_id=ctx.users["owner"].id)
        await sd.item(rv, pv, "f-01", title="Saved cards", track_id=track.id)
        second = await sd.doc("checkout-wallets-prd")
        sv = await sd.version(second)
        await sd.item(rv, sv, "f-02", title="Wallet pay")
        await sd.add(
            TrackerRecord(tracker="linear", external_ref="EX-9", prd_document_id=second.id,
                          item_key="f-02", state="todo", observed_at=NOW)
        )  # fmt: skip
        await s.commit()
        return {"track_id": str(track.id), "prd_id": str(prd.id), "second_id": str(second.id),
                "rv": rv.id, "rm": rm.id}  # fmt: skip


async def publish(ctx: Ctx, version_id) -> None:
    """The review lane's publish transaction (as tests.test_tracks does)."""
    async with tenant_session(ctx.tenant_id) as s:
        version = await s.get(DocumentVersion, version_id)
        await changes.record_change(
            s, "document_version", cause="published", actor="user:x",
            subject_id=version.id, document_id=version.document_id,
        )  # fmt: skip
        await s.commit()


async def suggestions(client, ctx: Ctx, role: str = "owner") -> list[dict]:
    r = await client.get("/v1/inbox", headers=ctx.as_(role))
    assert r.status_code == 200, r.text
    return r.json()["simple_track_suggestions"]


async def test_two_prds_on_one_track_read_everywhere(client):
    ctx = await make_ctx()
    ids = await seed(ctx)
    tid = ids["track_id"]
    done = (await change(client, ctx, "owner", "edit_track", {"track_id": tid},
                         {"add_prd_id": ids["second_id"]}))["change"]  # fmt: skip
    assert done["status"] == "applied"
    assert "Checkout Wallets Prd" in done["words"]
    owner = ctx.as_("owner")

    t = row(await read_tracks(client, ctx), "Checkout")
    assert [p["id"] for p in t["prds"]] == [ids["prd_id"], ids["second_id"]]
    health = await client.get(f"/v1/tracks/{tid}", headers=owner)
    assert health.status_code == 200, health.text
    assert [p["id"] for p in health.json()["prds"]] == [ids["prd_id"], ids["second_id"]]
    assert health.json()["counts"]["items"] == 2
    monitor = await client.post(f"/v1/tracks/{tid}/monitor", headers=owner)
    assert monitor.status_code == 200, monitor.text
    assert monitor.json()["overview"]["counts"]["items"] == 2
    plan = await client.get("/v1/plan", headers=owner)
    assert plan.status_code == 200, plan.text
    assert {i["title"]: str(i["track_id"]) for i in plan.json()["items"]} == {
        "Saved cards": tid,
        "Wallet pay": tid,
    }
    priorities = await client.get("/v1/simple/priorities", headers=owner)
    assert priorities.status_code == 200, priorities.text
    roadmap = await client.get(URL, params={"group": "track"}, headers=owner)
    assert roadmap.status_code == 200, roadmap.text
    tracks = {i["title"]: (i["track"] or {}).get("id") for i in roadmap.json()["items"]}
    assert tracks == {"Saved cards": tid, "Wallet pay": tid}
    report = await client.post("/v1/alignment-reports", json={}, headers=owner)
    assert report.status_code == 201, report.text
    (part,) = report.json()["tracks"]
    assert [p["title"] for p in part["prds"]] == ["Checkout Prd", "Checkout Wallets Prd"]
    async with tenant_session(ctx.tenant_id) as s:
        record = await s.scalar(select(TrackerRecord).where(TrackerRecord.external_ref == "EX-9"))
        assert str(record.track_id) == tid

    # Undo takes the second PRD off again.
    r = await client.post(f"{CHANGES}/{done['id']}/undo", headers=owner)
    assert r.status_code == 201, r.text
    t = row(await read_tracks(client, ctx), "Checkout")
    assert [p["id"] for p in t["prds"]] == [ids["prd_id"]]


async def test_a_prd_taken_off_a_track_starts_none_again(client):
    ctx = await make_ctx()
    ids = await seed(ctx)
    await change(client, ctx, "owner", "edit_track", {"track_id": ids["track_id"]},
                 {"prd_ids": []})  # fmt: skip
    async with tenant_session(ctx.tenant_id) as s:
        sd = Seed(s)
        v2 = await sd.add(
            DocumentVersion(document_id=ids["prd_id"], number=2, markdown="# v2\n",
                            content_hash="checkout-2", approved_at=NOW)
        )  # fmt: skip
        await s.commit()
    await publish(ctx, v2.id)
    out = await read_tracks(client, ctx)
    assert [t["title"] for t in out["tracks"]] == ["Checkout"]
    assert row(out, "Checkout")["prds"] == []
    assert await suggestions(client, ctx) == []
    async with tenant_session(ctx.tenant_id) as s:
        link = await s.scalar(select(TrackPrd).where(TrackPrd.prd_document_id == ids["prd_id"]))
        assert link.state == "off"


async def test_a_new_prd_gets_one_suggestion_and_confirming_links_it(client):
    ctx = await make_ctx()
    ids = await seed(ctx)
    async with tenant_session(ctx.tenant_id) as s:
        sv = await s.scalar(
            select(DocumentVersion).where(DocumentVersion.document_id == ids["second_id"])
        )
        version_id = sv.id
    await publish(ctx, version_id)
    await publish(ctx, version_id)
    async with tenant_session(ctx.tenant_id) as s:
        assert len(list(await s.scalars(select(ProductTrack)))) == 1
    (item,) = await suggestions(client, ctx)
    assert item["prd"]["id"] == ids["second_id"]
    assert item["track"] == {"id": ids["track_id"], "title": "Checkout"}
    # Not the approver's PRD: nothing in their Inbox.
    assert await suggestions(client, ctx, "approver") == []
    roadmap = (await client.get(URL, headers=ctx.as_("owner"))).json()
    wallet = next(i for i in roadmap["items"] if i["title"] == "Wallet pay")
    assert wallet["track"] is None

    confirmed = await change(client, ctx, "owner", "edit_track", {"track_id": ids["track_id"]},
                             {"add_prd_id": ids["second_id"]})  # fmt: skip
    assert confirmed["change"]["status"] == "applied"
    assert await suggestions(client, ctx) == []
    roadmap = (await client.get(URL, headers=ctx.as_("owner"))).json()
    wallet = next(i for i in roadmap["items"] if i["title"] == "Wallet pay")
    assert wallet["track"]["id"] == ids["track_id"]


async def test_new_track_from_a_suggestion(client):
    ctx = await make_ctx()
    ids = await seed(ctx)
    async with tenant_session(ctx.tenant_id) as s:
        sv = await s.scalar(
            select(DocumentVersion).where(DocumentVersion.document_id == ids["second_id"])
        )
        version_id = sv.id
    await publish(ctx, version_id)
    assert len(await suggestions(client, ctx)) == 1
    await change(client, ctx, "owner", "add_track", {},
                 {"title": "Wallets", "prd_ids": [ids["second_id"]]})  # fmt: skip
    assert await suggestions(client, ctx) == []
    assert [p["id"] for p in row(await read_tracks(client, ctx), "Wallets")["prds"]] == [
        ids["second_id"]
    ]


async def owned_by_approver(ctx: Ctx, ids: dict) -> None:
    """The second PRD is the approver's (they brought it in), accepted on no track."""
    async with tenant_session(ctx.tenant_id) as s:
        sv = await s.scalar(
            select(DocumentVersion).where(DocumentVersion.document_id == ids["second_id"])
        )
        sv.imported_by = ctx.users["approver"].id
        version_id = sv.id
        await s.commit()
    await publish(ctx, version_id)


async def test_confirming_a_track_another_decides_waits_for_them(client):
    """tracks-goal (owner Nov 9): the PRD's owner confirms a track someone else decides: a
    proposal to that track's decider; the owner's item waits (no actions, not counted), a
    second proposal for the PRD is refused, and the change holds only that PRD."""
    ctx = await make_ctx()
    ids = await seed(ctx)
    tid = ids["track_id"]
    await owned_by_approver(ctx, ids)
    (item,) = await suggestions(client, ctx, "approver")
    assert item["proposed"] is None
    prop = (await change(client, ctx, "approver", "edit_track", {"track_id": tid},
                         {"add_prd_id": ids["second_id"]}))["change"]  # fmt: skip
    assert prop["status"] == "proposed"
    assert prop["after"] == {"add_prd_id": ids["second_id"]}
    (item,) = await suggestions(client, ctx, "approver")
    assert item["proposed"]["track"] == {"id": tid, "title": "Checkout"}
    assert item["proposed"]["to_name"]
    inbox = (await client.get("/v1/inbox", headers=ctx.as_("approver"))).json()
    assert inbox["total"] == 0
    # Asked once: Confirm again, Pick a track or New track for it are refused while it waits.
    await change(client, ctx, "approver", "edit_track", {"track_id": tid},
                 {"add_prd_id": ids["second_id"]}, code=409)  # fmt: skip
    await change(client, ctx, "approver", "add_track", {},
                 {"title": "Wallets", "prd_ids": [ids["second_id"]]}, code=409)  # fmt: skip
    # The track changes meanwhile: its first PRD comes off.
    await change(client, ctx, "owner", "edit_track", {"track_id": tid}, {"prd_ids": []})
    (waiting,) = (await client.get("/v1/inbox", headers=ctx.as_("owner"))).json()[
        "simple_proposals"
    ]
    assert waiting["id"] == prop["id"]
    r = await client.post(f"{CHANGES}/{prop['id']}/accept", json={}, headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    # Only that PRD joins: the one taken off stays off.
    t = row(await read_tracks(client, ctx), "Checkout")
    assert [p["id"] for p in t["prds"]] == [ids["second_id"]]
    assert await suggestions(client, ctx, "approver") == []
    assert (await client.get("/v1/inbox", headers=ctx.as_("owner"))).json()[
        "simple_proposals"
    ] == []
    roadmap = (await client.get(URL, headers=ctx.as_("owner"))).json()
    wallet = next(i for i in roadmap["items"] if i["title"] == "Wallet pay")
    assert wallet["track"]["id"] == tid


async def test_a_declined_track_proposal_brings_the_suggestion_back(client):
    ctx = await make_ctx()
    ids = await seed(ctx)
    await owned_by_approver(ctx, ids)
    prop = (await change(client, ctx, "approver", "edit_track", {"track_id": ids["track_id"]},
                         {"add_prd_id": ids["second_id"]}))["change"]  # fmt: skip
    r = await client.post(f"{CHANGES}/{prop['id']}/decline", json={}, headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    (item,) = await suggestions(client, ctx, "approver")
    assert item["proposed"] is None
    assert item["track"] == {"id": ids["track_id"], "title": "Checkout"}
    # Asked again, it is a new proposal.
    again = await change(client, ctx, "approver", "edit_track", {"track_id": ids["track_id"]},
                         {"add_prd_id": ids["second_id"]})  # fmt: skip
    assert again["change"]["status"] == "proposed"


async def test_a_proposed_removal_takes_off_only_that_prd(client):
    ctx = await make_ctx()
    ids = await seed(ctx)
    tid = ids["track_id"]
    prop = (await change(client, ctx, "approver", "edit_track", {"track_id": tid},
                         {"remove_prd_id": ids["prd_id"]}))["change"]  # fmt: skip
    assert prop["status"] == "proposed"
    assert prop["after"] == {"remove_prd_id": ids["prd_id"]}
    # Meanwhile a second PRD joins the track.
    await change(client, ctx, "owner", "edit_track", {"track_id": tid},
                 {"add_prd_id": ids["second_id"]})  # fmt: skip
    r = await client.post(f"{CHANGES}/{prop['id']}/accept", json={}, headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    t = row(await read_tracks(client, ctx), "Checkout")
    assert [p["id"] for p in t["prds"]] == [ids["second_id"]]


@pytest.mark.parametrize("form", ["add_prd_id", "prd_ids"])
async def test_placing_a_prd_directly_closes_its_open_proposal(client, form):
    ctx = await make_ctx()
    ids = await seed(ctx)
    tid = ids["track_id"]
    await owned_by_approver(ctx, ids)
    prop = (await change(client, ctx, "approver", "edit_track", {"track_id": tid},
                         {"add_prd_id": ids["second_id"]}))["change"]  # fmt: skip
    assert prop["status"] == "proposed"
    (waiting,) = (await client.get("/v1/inbox", headers=ctx.as_("owner"))).json()[
        "simple_proposals"
    ]
    assert waiting["id"] == prop["id"]
    # The track's decider puts the PRD on the track themselves.
    after = (
        {"add_prd_id": ids["second_id"]}
        if form == "add_prd_id"
        else {"prd_ids": [ids["prd_id"], ids["second_id"]]}
    )
    done = (await change(client, ctx, "owner", "edit_track", {"track_id": tid}, after))["change"]
    assert done["status"] == "applied"
    # The proposal is closed: out of every Inbox, and never decided again.
    assert (await client.get("/v1/inbox", headers=ctx.as_("owner"))).json()[
        "simple_proposals"
    ] == []
    assert await suggestions(client, ctx, "approver") == []
    async with tenant_session(ctx.tenant_id) as s:
        c = await s.get(SimpleChange, uuid.UUID(prop["id"]))
        assert (c.status, c.decided_by) == ("declined", ctx.users["owner"].id)
        assert c.decided_at is not None
    r = await client.post(f"{CHANGES}/{prop['id']}/accept", json={}, headers=ctx.as_("owner"))
    assert r.status_code == 409, r.text
    assert "outdated" not in r.text
    t = row(await read_tracks(client, ctx), "Checkout")
    assert sorted(p["id"] for p in t["prds"]) == sorted([ids["prd_id"], ids["second_id"]])


async def test_placing_one_prd_of_a_two_prd_proposal_keeps_the_rest_open(client):
    ctx = await make_ctx()
    ids = await seed(ctx)
    tid = ids["track_id"]
    async with tenant_session(ctx.tenant_id) as s:
        from tests.test_simple_roadmap_api import Seed

        third = await Seed(s).doc("loyalty-points-prd")
        await Seed(s).version(third)
        await s.commit()
        third_id = str(third.id)
    prop = (await change(client, ctx, "approver", "add_track", {},
                         {"title": "Wallets", "prd_ids": [ids["second_id"], third_id]}))[
        "change"
    ]  # fmt: skip
    assert prop["status"] == "proposed"
    # The decider of Checkout puts the second PRD there directly.
    done = (await change(client, ctx, "owner", "edit_track", {"track_id": tid},
                         {"add_prd_id": ids["second_id"]}))["change"]  # fmt: skip
    assert done["status"] == "applied"
    async with tenant_session(ctx.tenant_id) as s:
        c = await s.get(SimpleChange, uuid.UUID(prop["id"]))
        assert c.status == "proposed"
        assert c.after["prd_ids"] == [third_id]
        assert c.target["prd_ids"] == [third_id]
        assert ids["second_id"] not in (c.target.get("prior") or {})
        (dropped,) = c.target["placed_directly"]
        assert dropped["prd_id"] == ids["second_id"]
        assert dropped["reason"] == "Checkout Wallets Prd was put on Checkout directly"
    (waiting,) = (await client.get("/v1/inbox", headers=ctx.as_("owner"))).json()[
        "simple_proposals"
    ]
    assert waiting["id"] == prop["id"]
    r = await client.post(f"{CHANGES}/{prop['id']}/accept", json={}, headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    tracks = await read_tracks(client, ctx)
    assert [p["id"] for p in row(tracks, "Wallets")["prds"]] == [third_id]
    assert sorted(p["id"] for p in row(tracks, "Checkout")["prds"]) == sorted(
        [ids["prd_id"], ids["second_id"]]
    )
