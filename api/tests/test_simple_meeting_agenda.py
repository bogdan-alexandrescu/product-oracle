"""meeting-changes-only-its-agenda: a meeting changes only what it reviews. Against Postgres.

A review meeting of the PRD "payments-prd" reviews its roadmap "payments" (roadmap A).
An item on another roadmap, "shipping" (roadmap B, decided by ``reviewer2``), is not on
its agenda: a change the meeting makes to it is never applied, even by an owner who could
apply it outside the meeting; it is a proposal for B's decider, who accepts or declines
it from their Inbox, and the proposal names the meeting that asked for it.

Test cards (protects / fails_when / no_claim):

- test_a_cut_on_another_roadmap_is_a_proposal_for_its_owner: protects=an owner presenting
  the meeting cuts an item on B through the meeting's session: nothing is written on B,
  one proposal routed to B's decider, with the meeting's title (``from_meeting``) and
  ``off_agenda``, in B's decider's Inbox; fails_when=the cut applies, the proposal goes to
  the meeting's people, or does not say which meeting asked; no_claim=the web.
- test_accepting_applies_and_declining_leaves_it: protects=B's decider's Accept applies the
  change on B; another cut, declined, leaves B untouched; the meeting cannot decide it
  through its own session; fails_when=accept does not apply, decline writes, or a meeting
  accepts it; no_claim=the outdated check (test_simple_changes_api).
- test_items_on_the_agenda_still_apply: protects=the same owner's cut of an item on A, in
  the meeting, applies as today; fails_when=an agenda item becomes a proposal.
- test_a_task_on_another_roadmap_is_a_proposal: protects=a task added in the meeting to an
  item on B is a proposal for B's decider; fails_when=it is added.
"""

import uuid
from datetime import date

from sqlalchemy import select

from oracle.review.models import DocumentReviewPolicy
from oracle.simple import drafts
from oracle.simple.models import SimpleChange
from oracle.tenancy import tenant_session
from tests.test_simple_changes_api import CHANGES, World
from tests.test_simple_changes_api import clock as clock  # noqa: F401
from tests.test_simple_meetings_api import start, uid, world
from tests.test_simple_roadmap_api import Seed

INBOX = "/v1/inbox"


async def with_roadmap_b(w: World) -> str:
    """Roadmap B ("shipping", its own PRD), decided by reviewer2; its item ``ship-a``."""
    async with tenant_session(w.ctx.tenant_id) as s:
        seed = Seed(s)
        _, pv, rm, rv = await seed.roadmap("shipping")
        track = await seed.track(pv, rm, title="Shipping")
        row = await seed.item(rv, pv, "ship-a", title="Delivery integrity", track_id=track.id,
                              start_date=date(2026, 10, 1), end_date=date(2026, 11, 15),
                              date_source="typed")  # fmt: skip
        s.add(DocumentReviewPolicy(document_id=rm.id, decider_id=w.ctx.users["reviewer2"].id))
        await s.commit()
        w.ids["ship-a"] = str(row.id)
        return str(rm.id)


async def cut_flag(w: World, key: str) -> bool:
    async with tenant_session(w.ctx.tenant_id) as s:
        from oracle.simple.models import RoadmapItem

        return bool((await drafts.effective_row(s, await s.get(RoadmapItem, w.ids[key]))).cut)


async def cut(client, w: World, who: str, key: str, sid: str):
    body = {"op": "cut", "target": {"item_id": w.ids[key]}, "before": {"cut": False},
            "after": {"cut": True}, "session_id": sid}  # fmt: skip
    return await client.post(CHANGES, json=body, headers=w.ctx.as_(who))


async def meeting(client, w: World) -> dict:
    return await start(client, w, "owner", title="Payments review",
                       attendee_ids=[uid(w, "decider"), uid(w, "commenter")])  # fmt: skip


async def test_a_cut_on_another_roadmap_is_a_proposal_for_its_owner(client):
    w = await world()
    b = await with_roadmap_b(w)
    m = await meeting(client, w)
    r = await cut(client, w, "owner", "ship-a", m["session_id"])
    assert r.status_code == 201, r.text
    c = r.json()["change"]
    assert c["status"] == "proposed"
    assert c["routed_to"] == [uid(w, "reviewer2")]
    assert c["document_id"] == b
    assert c["from_meeting"] == {"id": m["id"], "title": "Payments review"}
    assert c["off_agenda"] is True
    assert not await cut_flag(w, "ship-a")
    async with tenant_session(w.ctx.tenant_id) as s:
        rows = list(await s.scalars(select(SimpleChange).where(SimpleChange.document_id
                                                              == uuid.UUID(b))))  # fmt: skip
    assert [x.status for x in rows] == ["proposed"]
    # B's decider sees it with Accept and Decline in their Inbox, from the meeting.
    r = await client.get(INBOX, headers=w.ctx.as_("reviewer2"))
    assert r.status_code == 200, r.text
    waiting = r.json()["simple_proposals"]
    assert [x["id"] for x in waiting] == [c["id"]]
    assert waiting[0]["from_meeting"] == {"id": m["id"], "title": "Payments review"}
    r = await client.get(CHANGES, params={"status": "proposed"}, headers=w.ctx.as_("reviewer2"))
    mine = [x for x in r.json() if x["id"] == c["id"]]
    assert mine and mine[0]["can_decide"] is True and mine[0]["from_meeting"]["title"]


async def test_accepting_applies_and_declining_leaves_it(client):
    w = await world()
    await with_roadmap_b(w)
    m = await meeting(client, w)
    sid = m["session_id"]
    first = (await cut(client, w, "owner", "ship-a", sid)).json()["change"]
    # The meeting does not decide it through its own session either.
    r = await client.post(f"{CHANGES}/{first['id']}/decline", json={"session_id": sid},
                          headers=w.ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 409, r.text
    r = await client.post(f"{CHANGES}/{first['id']}/decline", json={},
                          headers=w.ctx.as_("reviewer2"))  # fmt: skip
    assert r.status_code == 200, r.text
    assert not await cut_flag(w, "ship-a")
    second = (await cut(client, w, "owner", "ship-a", sid)).json()["change"]
    assert second["status"] == "proposed"
    r = await client.post(f"{CHANGES}/{second['id']}/accept", json={},
                          headers=w.ctx.as_("reviewer2"))  # fmt: skip
    assert r.status_code == 200, r.text
    assert r.json()["change"]["status"] == "accepted"
    assert await cut_flag(w, "ship-a")


async def test_items_on_the_agenda_still_apply(client):
    w = await world()
    await with_roadmap_b(w)
    m = await meeting(client, w)
    r = await cut(client, w, "owner", "cut-a", m["session_id"])
    assert r.status_code == 201, r.text
    c = r.json()["change"]
    assert c["status"] == "applied"
    assert c["off_agenda"] is False
    assert c["from_meeting"]["id"] == m["id"]


async def test_a_task_on_another_roadmap_is_a_proposal(client):
    w = await world()
    await with_roadmap_b(w)
    m = await meeting(client, w)
    body = {"op": "add_item_task", "target": {"item_id": w.ids["ship-a"]}, "before": {},
            "after": {"title": "Check the packing list", "owner_id": None, "due_date": None}, "session_id": m["session_id"]}  # fmt: skip
    r = await client.post(CHANGES, json=body, headers=w.ctx.as_("owner"))
    assert r.status_code == 201, r.text
    c = r.json()["change"]
    assert c["status"] == "proposed"
    assert c["routed_to"] == [uid(w, "reviewer2")]
    assert c["off_agenda"] is True
