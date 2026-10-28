"""Simple chat follow-ups: who records a decision with "decision: ..." (the owner's pick,
2026-10-27: "Approvers and owners record it at once, commenters as proposal"; in a meeting
"Keep: any allowed attendee records it"). Against Postgres, with S8's real meetings module.

People: owner, decider (the PRD's decider, Dee Cider), approver, commenter, viewer
(tests.test_simple_meetings_api.world).

Test cards (protects / fails_when / no_claim):

- test_ask_decision_per_role: protects=on the Ask panel an owner's and an approver's
  "decision: ..." card records a decided decision at once; a commenter's card is a
  proposal ("Proposed to Dee Cider; they decide"): applied, it opens a decision on the
  page's document with the commenter as proposer and the PRD's decider to confirm, shown
  in the decider's inbox ("Decisions waiting for you") and on Decisions, and the
  decider's Decide decides it; a viewer's is refused; fails_when=a commenter is refused,
  records a decided decision, or the proposal waits on the wrong person;
  no_claim=the web's card words (web spec).
- test_ask_decision_without_a_document_goes_to_an_owner: protects=a commenter's proposal
  off a document page waits on the company's owner; fails_when=it has no approver.
- test_meeting_decision_per_role: protects=in a meeting every allowed attendee (owner,
  approver, commenter) records the decision at once and a viewer gets a note, no card
  (unchanged);
  fails_when=a meeting commenter's card becomes a proposal.
"""

import uuid

from sqlalchemy import select

from oracle.decisions.models import Decision
from oracle.tenancy import tenant_session
from tests.test_simple_changes_api import clock as clock  # noqa: F401
from tests.test_simple_chat_actions import apply, one_card, say
from tests.test_simple_meetings_api import get, start, uid, world

PAGE = "/simple/prds/payments-prd"


async def _decision(w, title: str) -> Decision:
    async with tenant_session(w.ctx.tenant_id) as s:
        d = await s.scalar(select(Decision).where(Decision.title == title))
        assert d is not None, title
        return d


async def test_ask_decision_per_role(client):
    w = await world()
    for who in ("owner", "approver"):
        c = await one_card(client, w, who, f"decision: Go weekly for {who}", page=PAGE)
        assert c["may"] == "apply", who
        assert "proposed_to" not in c["preview"]
        r = await apply(client, w, who, c["id"])
        assert r.status_code == 200, r.text
        assert r.json()["card"]["status"] == "applied"
        d = await _decision(w, f"Go weekly for {who}")
        assert d.status == "decided" and d.approver_id == w.ctx.users[who].id

    c = await one_card(client, w, "commenter", "decision: Ship it monthly", page=PAGE)
    assert c["may"] == "propose" and c["why_not"] is None
    assert c["preview"]["proposed_to"] == "Dee Cider"
    async with tenant_session(w.ctx.tenant_id) as s:  # nothing until Apply
        assert await s.scalar(select(Decision).where(Decision.title == "Ship it monthly")) is None
    r = await apply(client, w, "commenter", c["id"])
    assert r.status_code == 200, r.text
    card = r.json()["card"]
    assert card["status"] == "proposed" and card["decision_id"]
    d = await _decision(w, "Ship it monthly")
    assert str(d.id) == card["decision_id"]
    assert d.status == "proposed"
    assert d.approver_id == w.ctx.users["decider"].id
    assert d.created_by == w.ctx.users["commenter"].id
    assert {"kind": "document", "id": c["target"]["document_id"]} in [
        {"kind": x["kind"], "id": x["id"]} for x in d.subjects]  # fmt: skip
    assert len(d.options) >= 2 and d.options[0]["label"] == "Ship it monthly"

    # The decider's inbox: "Decisions waiting for you" on Home.
    inbox = (await client.get("/v1/inbox", headers=w.ctx.as_("decider"))).json()
    assert any(x["number"] == d.number and x["reason"] == "needs_decision"
               for x in inbox["decisions"])  # fmt: skip
    mine = (await client.get("/v1/inbox", headers=w.ctx.as_("commenter"))).json()
    assert not any(x["reason"] == "needs_decision" and x["number"] == d.number
                   for x in mine["decisions"])  # fmt: skip
    # Decisions (Simple's page): among the decisions taken outside meetings.
    page = (await client.get("/v1/simple/decisions", headers=w.ctx.as_("decider"))).json()
    assert any(x["id"] == str(d.id) for x in page["other"])
    # The decider decides it as any open decision.
    r = await client.post(f"/v1/decisions/{d.number}/decide", headers=w.ctx.as_("commenter"),
                          json={"option_key": d.options[0]["key"], "rationale": "x",
                                "expected_outcome": "y"})  # fmt: skip
    assert r.status_code == 403, r.text
    r = await client.post(f"/v1/decisions/{d.number}/decide", headers=w.ctx.as_("decider"),
                          json={"option_key": d.options[0]["key"], "rationale": "Agreed",
                                "expected_outcome": "Monthly ships"})  # fmt: skip
    assert r.status_code == 200, r.text
    assert (await _decision(w, "Ship it monthly")).status == "decided"

    c = await one_card(client, w, "viewer", "decision: Not mine", page=PAGE)
    assert c["may"] is None and c["why_not"]
    assert (await apply(client, w, "viewer", c["id"])).status_code == 403


async def test_ask_decision_without_a_document_goes_to_an_owner(client):
    w = await world()
    c = await one_card(client, w, "commenter", "decision: Freeze on Fridays", page="/simple")
    assert c["may"] == "propose" and c["preview"]["proposed_to"]
    r = await apply(client, w, "commenter", c["id"])
    assert r.status_code == 200, r.text
    d = await _decision(w, "Freeze on Fridays")
    assert d.status == "proposed" and d.approver_id == w.ctx.users["owner"].id


async def test_meeting_decision_per_role(client):
    w = await world()
    attendees = [uid(w, x) for x in ("owner", "approver", "commenter", "viewer")]
    mid = (await start(client, w, attendee_ids=attendees))["id"]
    for who in ("owner", "approver", "commenter"):
        c = await one_card(client, w, who, f"decision: Keep it for {who}", mid)
        assert c["may"] == "apply" and "proposed_to" not in c["preview"], who
        r = await apply(client, w, who, c["id"])
        assert r.status_code == 200, (who, r.text)
        assert r.json()["card"]["status"] == "applied"
        did = r.json()["card"]["decision_id"]
        mt = await get(client, w, mid)
        assert any(x["id"] == did for x in mt["meeting_decisions"]), who
        async with tenant_session(w.ctx.tenant_id) as s:
            assert (await s.get(Decision, uuid.UUID(did))).status == "decided"
    m = await say(client, w, "viewer", "decision: Not mine", mid)
    assert m["kind"] == "note" and m["cards"] == []


# The review's minors (each fails on the branch before its fix):
# - test_commenter_naming_a_decider_is_told_who_decides: "decision by Rae Viewer: X" from a
#   commenter on the Ask panel goes to the document's decider and the card says so (it
#   names Dee Cider as the decider, and Rae Viewer as not); fails_when=the card keeps Rae.
# - test_ask_decider_only_for_decision_lines: a commenter's other Ask lines never resolve
#   who confirms a proposal; fails_when=every line runs ask_decider.
# - test_card_follows_the_role_at_apply: a commenter's card applied after they became an
#   approver records at once and no longer says it goes to someone; fails_when=the applied
#   card still carries proposed_to.
# - test_meeting_decision_on_the_next_item_clears_it: a meeting decision about the item the
#   agenda takes next clears agenda.next; fails_when=the decided item stays "next".


async def test_commenter_naming_a_decider_is_told_who_decides(client):
    w = await world()
    c = await one_card(client, w, "commenter", "decision by Rae Viewer: Go quarterly", page=PAGE)
    assert c["may"] == "propose"
    p = c["preview"]
    assert p["proposed_to"] == "Dee Cider" and p["decider_name"] == "Dee Cider"
    assert p["not_to"] == "Rae Viewer"
    assert c["after"]["decider_id"] is None
    r = await apply(client, w, "commenter", c["id"])
    assert r.status_code == 200, r.text
    d = await _decision(w, "Go quarterly")
    assert d.status == "proposed" and d.approver_id == w.ctx.users["decider"].id


async def test_ask_decider_only_for_decision_lines(client, monkeypatch):
    from oracle.simple import chat_actions

    w = await world()
    calls: list = []
    real = chat_actions.ask_decider

    async def counted(db, document):
        calls.append(document)
        return await real(db, document)

    monkeypatch.setattr(chat_actions, "ask_decider", counted)
    await say(client, w, "commenter", "when does Ledger v2 end?", page=PAGE)
    assert calls == []
    c = await one_card(client, w, "commenter", "decision: Ship it biweekly", page=PAGE)
    assert c["preview"]["proposed_to"] == "Dee Cider" and len(calls) == 1


async def test_card_follows_the_role_at_apply(client):
    from oracle.auth.models import User

    w = await world()
    c = await one_card(client, w, "commenter", "decision: Ship it nightly", page=PAGE)
    assert c["preview"]["proposed_to"] == "Dee Cider"
    async with tenant_session(w.ctx.tenant_id) as s:
        (await s.get(User, w.ctx.users["commenter"].id)).role = "approver"
        await s.commit()
    r = await apply(client, w, "commenter", c["id"])
    assert r.status_code == 200, r.text
    card = r.json()["card"]
    assert card["status"] == "applied" and "proposed_to" not in card["preview"]
    assert card["preview"]["decider_name"] != "Dee Cider"
    assert (await _decision(w, "Ship it nightly")).status == "decided"


async def test_meeting_decision_on_the_next_item_clears_it(client):
    w = await world()
    mid = (await start(client, w))["id"]
    title = await _item_title(w)
    c = await one_card(client, w, "decider", f"take {title} next", mid)
    assert (await apply(client, w, "decider", c["id"])).status_code == 200
    assert (await get(client, w, mid))["agenda"]["next"]["title"] == title
    c = await one_card(client, w, "decider", f"Rae Viewer owns {title}", mid)
    r = await apply(client, w, "decider", c["id"])
    assert r.status_code == 200, r.text
    assert (await get(client, w, mid))["agenda"]["next"] is None


async def _item_title(w) -> str:
    from oracle.roadmap.models import RoadmapItem

    async with tenant_session(w.ctx.tenant_id) as s:
        return (await s.get(RoadmapItem, uuid.UUID(next(iter(w.ids.values()))))).title
