"""inbox-meeting-proposals owner: the Inbox lists every Simple proposal waiting on me, not
only a meeting's: one asked through Ask Oracle and one a teammate made on the page each
say who or what asked. Against Postgres. Made-up names only.

Test cards (protects / fails_when / no_claim):

- test_an_ask_oracle_proposal_says_it_came_from_ask_oracle: protects=a commenter's Ask
  Oracle card ("commenter owns Cut A"), applied, is a proposal in the roadmap decider's
  Inbox, named, in plain words, from Ask Oracle (``from_ask``), by whom, which the decider
  may decide; it counts in ``total``; Accept applies it and the row leaves;
  fails_when=no row, no ``from_ask``, not counted, or it stays once accepted;
  no_claim=the web (e2e/inbox-meeting-proposals.spec.ts).
- test_a_teammates_proposal_names_the_teammate: protects=a commenter's cut made on the
  page is a proposal in the decider's Inbox, not from Ask Oracle nor a meeting, with the
  teammate's name; Decline leaves the item and the row leaves; fails_when=it is marked
  from Ask Oracle or a meeting, or stays once declined.
"""

from tests.test_simple_changes_api import CHANGES
from tests.test_simple_changes_api import clock as clock  # noqa: F401
from tests.test_simple_chat_actions import apply, item, one_card
from tests.test_simple_meeting_agenda import INBOX, cut_flag
from tests.test_simple_meetings_api import world


async def _inbox(client, w, who: str) -> dict:
    r = await client.get(INBOX, headers=w.ctx.as_(who))
    assert r.status_code == 200, r.text
    return r.json()


def _row(inbox: dict, change_id: str) -> dict | None:
    rows = [x for x in inbox["simple_proposals"] if x["id"] == change_id]
    return rows[0] if rows else None


async def test_an_ask_oracle_proposal_says_it_came_from_ask_oracle(client):
    w = await world()
    before = (await _inbox(client, w, "decider"))["total"]
    card = await one_card(client, w, "commenter", "commenter owns Cut A")
    r = await apply(client, w, "commenter", card["id"])
    assert r.status_code == 200, r.text
    assert r.json()["card"]["status"] == "proposed"
    change = r.json()["result"]["change"]
    inbox = await _inbox(client, w, "decider")
    row = _row(inbox, change["id"])
    assert row is not None, inbox["simple_proposals"]
    assert row["item_title"] == "Cut A"
    assert row["asked"] and "Cut A" in row["asked"]
    assert row["from_ask"] is True
    assert row["from_meeting"] is None
    assert row["by_name"] == w.ctx.users["commenter"].name
    assert row["can_decide"] is True
    assert inbox["total"] == before + 1
    r = await client.post(f"{CHANGES}/{change['id']}/accept", json={},
                          headers=w.ctx.as_("decider"))  # fmt: skip
    assert r.status_code == 200, r.text
    inbox = await _inbox(client, w, "decider")
    assert _row(inbox, change["id"]) is None
    assert inbox["total"] == before
    assert (await item(w, "cut-a")).owner_id == w.ctx.users["commenter"].id


async def test_a_teammates_proposal_names_the_teammate(client):
    w = await world()
    body = {"op": "cut", "target": {"item_id": w.ids["cut-a"]}, "before": {"cut": False},
            "after": {"cut": True}}  # fmt: skip
    r = await client.post(CHANGES, json=body, headers=w.ctx.as_("commenter"))
    assert r.status_code == 201, r.text
    change = r.json()["change"]
    assert change["status"] == "proposed"
    row = _row(await _inbox(client, w, "decider"), change["id"])
    assert row is not None
    assert row["asked"] == "cut Cut A"
    assert row["from_ask"] is False
    assert row["from_meeting"] is None
    assert row["by_name"] == w.ctx.users["commenter"].name
    assert row["can_decide"] is True
    r = await client.post(f"{CHANGES}/{change['id']}/decline", json={},
                          headers=w.ctx.as_("decider"))  # fmt: skip
    assert r.status_code == 200, r.text
    assert _row(await _inbox(client, w, "decider"), change["id"]) is None
    assert not await cut_flag(w, "cut-a")
