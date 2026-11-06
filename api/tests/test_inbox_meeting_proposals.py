"""inbox-meeting-proposals: a meeting's proposal for an item it does not review shows in its
owner's Inbox, with Accept and Decline. Against Postgres.

A review meeting of "payments-prd" (roadmap A) cuts ``ship-a`` "Delivery integrity" on
roadmap B, decided by ``reviewer2``: a proposal for reviewer2 (test_simple_meeting_agenda).

Test cards (protects / fails_when / no_claim):

- test_the_owners_inbox_row_says_what_the_meeting_asked: protects=reviewer2's Inbox row
  names the item by its name, says what the meeting asked for in plain words (``asked``:
  "cut Delivery integrity"), which meeting and when, and that reviewer2 may decide it
  (``can_decide``); it counts in ``total``; fails_when=the row has no plain words or no
  can_decide, or is not counted; no_claim=the web (e2e/inbox-meeting-proposals.spec.ts).
- test_an_answered_proposal_leaves_the_inbox: protects=once accepted (the item is cut) or
  declined (it is not), the proposal is no longer in reviewer2's Inbox and the count drops;
  fails_when=an answered proposal stays waiting.
- test_someone_else_does_not_get_it: protects=the meeting's own people (who may not decide
  B) have no row for it; fails_when=it shows in another person's Inbox.
"""

from tests.test_simple_changes_api import CHANGES
from tests.test_simple_changes_api import clock as clock  # noqa: F401
from tests.test_simple_meeting_agenda import INBOX, cut, cut_flag, meeting, with_roadmap_b
from tests.test_simple_meetings_api import world


async def _inbox(client, w, who: str) -> dict:
    r = await client.get(INBOX, headers=w.ctx.as_(who))
    assert r.status_code == 200, r.text
    return r.json()


async def test_the_owners_inbox_row_says_what_the_meeting_asked(client):
    w = await world()
    b = await with_roadmap_b(w)
    before = (await _inbox(client, w, "reviewer2"))["total"]
    m = await meeting(client, w)
    c = (await cut(client, w, "owner", "ship-a", m["session_id"])).json()["change"]
    inbox = await _inbox(client, w, "reviewer2")
    rows = [x for x in inbox["simple_proposals"] if x["id"] == c["id"]]
    assert len(rows) == 1, inbox["simple_proposals"]
    row = rows[0]
    assert row["item_title"] == "Delivery integrity"
    assert row["document_id"] == b
    assert row["asked"] == "cut Delivery integrity"
    assert row["from_meeting"] == {"id": m["id"], "title": "Payments review"}
    assert row["at"] == c["at"]
    assert row["can_decide"] is True
    assert row["state"] == "new"
    assert inbox["total"] == before + 1


async def test_an_answered_proposal_leaves_the_inbox(client):
    w = await world()
    await with_roadmap_b(w)
    m = await meeting(client, w)
    sid = m["session_id"]
    first = (await cut(client, w, "owner", "ship-a", sid)).json()["change"]
    waiting = (await _inbox(client, w, "reviewer2"))["total"]
    r = await client.post(f"{CHANGES}/{first['id']}/decline", json={},
                          headers=w.ctx.as_("reviewer2"))  # fmt: skip
    assert r.status_code == 200, r.text
    inbox = await _inbox(client, w, "reviewer2")
    assert first["id"] not in [x["id"] for x in inbox["simple_proposals"]]
    assert inbox["total"] == waiting - 1
    assert not await cut_flag(w, "ship-a")
    second = (await cut(client, w, "owner", "ship-a", sid)).json()["change"]
    row = [x for x in (await _inbox(client, w, "reviewer2"))["simple_proposals"]
           if x["id"] == second["id"]]  # fmt: skip
    assert row and row[0]["can_decide"] is True
    r = await client.post(f"{CHANGES}/{second['id']}/accept", json={},
                          headers=w.ctx.as_("reviewer2"))  # fmt: skip
    assert r.status_code == 200, r.text
    inbox = await _inbox(client, w, "reviewer2")
    assert second["id"] not in [x["id"] for x in inbox["simple_proposals"]]
    assert await cut_flag(w, "ship-a")


async def test_someone_else_does_not_get_it(client):
    w = await world()
    await with_roadmap_b(w)
    m = await meeting(client, w)
    c = (await cut(client, w, "owner", "ship-a", m["session_id"])).json()["change"]
    for who in ("owner", "decider", "commenter"):
        inbox = await _inbox(client, w, who)
        assert c["id"] not in [x["id"] for x in inbox["simple_proposals"]], who
