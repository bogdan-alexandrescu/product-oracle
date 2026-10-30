"""Simple chat-actions (#723, the owner's report): the chat's new actions, each a card
(restate + card) applied with the caller's rights: owner and decider changes, record a
decision, minutes notes and open questions, agenda changes. Against Postgres, with S8's
real meetings module (oracle.simple.meetings).

People: owner, decider (an approver the roadmap's and the PRD's policies name decider),
approver, commenter, viewer (tests.test_simple_meetings_api.world).

Test cards (protects / fails_when / no_claim):

- test_set_owner_and_decider_per_role: protects=on the Ask panel "<person> owns <item>" and
  "<person> decides <item>" restate and give one set_owner / set_decider card; the owner's
  and the decider's Apply applies (the item names its new owner and decider; Undo puts it
  back), the approver's and the commenter's propose (nothing changes), the viewer's is
  refused (403); fails_when=a role does more than its gesture, or the card writes before
  Apply; no_claim=the web's restatement (web spec).
- test_new_decider_decides_the_item: protects=an item's own decider replaces the roadmap's
  for that item (service.can_decide) for readers of the working draft: the roadmap's
  decider proposes on it, an owner still applies; fails_when=the old decider still
  applies; no_claim=readers of the published version (they see it once the draft
  publishes), the roadmap's other items.
- test_unknown_person_gets_a_question: protects=an unknown person gets one question and no
  card; fails_when=Oracle guesses someone; no_claim=the question's choices row (chat-reader).
- test_meeting_only_actions_refused_outside_a_meeting: protects=on the Ask panel minutes
  notes, open questions and agenda changes answer a one-line note and build no card;
  fails_when=a card is built outside a meeting; no_claim=Ask's General tab.
- test_notes_questions_and_agenda_in_a_meeting: protects=in a meeting a commenter's notes,
  open questions, "next" and "skip" apply (everyone mode), show on the meeting for every
  attendee, Undo removes a note and puts the agenda back, and the drafted minutes' open
  questions carry the chat's questions (never a note's own text, qa-simple-decide-6); a
  viewer gets the viewers' note; fails_when=an effect is missing, survives its Undo, a
  viewer gets a card, or a note's text leaks into the summary; no_claim=the minutes job's
  own text.
- test_presenter_mode_bars_direct_actions: protects=the presenter's change mode bars the
  direct actions as it bars engine cards; fails_when=a barred attendee adds a note;
  no_claim=the named mode (chat's own tests).
- test_record_decision_in_a_meeting_and_on_ask: protects=in a meeting "decision: <text>"
  becomes a meeting decision (decided by the named person, else the PRD's decider) shown
  on the meeting (the minutes' "Decisions taken"), Undo reverses it; on the Ask panel an
  approver's decision is a decided decision on the page's document; a viewer's is refused
  (a commenter's is a proposal: test_simple_chat_followups); fails_when=a decision is
  missing, decided by the wrong person, stays decided after Undo; no_claim=the Decisions
  page's grouping (S8's tests).
"""

import uuid

from sqlalchemy import select

from oracle.decisions.models import Decision
from oracle.roadmap.models import RoadmapItem
from oracle.simple import chat, chat_actions, drafts
from oracle.tenancy import tenant_session
from tests.test_simple_changes_api import clock as clock  # noqa: F401
from tests.test_simple_meetings_api import MEETINGS, end, get, start, uid, world

ASK = "/v1/simple/chat/messages"
CARDS = "/v1/simple/chat/cards"


async def say(client, w, who: str, text: str, meeting: str | None = None, page=None) -> dict:
    url = f"{MEETINGS}/{meeting}/chat/messages" if meeting else ASK
    body = {"text": text, **({"page": page} if page else {})}
    r = await client.post(url, json=body, headers=w.ctx.as_(who))
    assert r.status_code == 200, r.text
    return r.json()["messages"][-1]


async def one_card(client, w, who: str, text: str, meeting: str | None = None, page=None):
    m = await say(client, w, who, text, meeting, page)
    assert m["kind"] == "cards", (text, m["body"])
    assert m["body"] == chat_actions.UNDERSTOOD
    assert len(m["cards"]) == 1
    return m["cards"][0]


async def apply(client, w, who: str, card_id: str):
    return await client.post(f"{CARDS}/{card_id}/apply", headers=w.ctx.as_(who))


async def undo(client, w, who: str, card_id: str):
    return await client.post(f"{CARDS}/{card_id}/undo", headers=w.ctx.as_(who))


async def item(w, key: str) -> RoadmapItem:
    async with tenant_session(w.ctx.tenant_id) as s:
        return await drafts.effective_row(s, await s.get(RoadmapItem, w.ids[key]))


async def test_set_owner_and_decider_per_role(client):
    w = await world()
    commenter = w.ctx.users["commenter"].id
    for who, want in (("owner", "applied"), ("decider", "applied"), ("approver", "proposed"),
                      ("commenter", "proposed")):  # fmt: skip
        c = await one_card(client, w, who, "commenter owns Cut A")
        assert c["op"] == "set_owner" and c["status"] == "open"
        assert c["summary"].startswith("Make ") and c["summary"].endswith("the owner of Cut A")
        assert c["preview"]["kind"] == "owner"
        assert (await item(w, "cut-a")).owner_id is None  # nothing until Apply
        r = await apply(client, w, who, c["id"])
        assert r.status_code == 200, (who, r.text)
        assert r.json()["card"]["status"] == want, who
        if want == "applied":
            assert (await item(w, "cut-a")).owner_id == commenter
            answer = await say(client, w, who, "who owns Cut A?")
            assert "commenter" in answer["body"].lower()
            r = await undo(client, w, who, c["id"])
            assert r.status_code == 200, r.text
            assert r.json()["status"] == "undone"
        assert (await item(w, "cut-a")).owner_id is None, who
    c = await one_card(client, w, "owner", "approver decides Cut B")
    assert c["op"] == "set_decider" and c["preview"]["kind"] == "decider"
    assert (await apply(client, w, "owner", c["id"])).json()["card"]["status"] == "applied"
    assert (await item(w, "cut-b")).decider_id == w.ctx.users["approver"].id
    c = await one_card(client, w, "viewer", "commenter owns Cut A")
    assert c["may"] is None and c["why_not"]
    assert (await apply(client, w, "viewer", c["id"])).status_code == 403


async def test_new_decider_decides_the_item(client):
    w = await world()
    c = await one_card(client, w, "owner", "approver decides Cut B")
    assert (await apply(client, w, "owner", c["id"])).status_code == 200
    # In the working draft (which the roadmap's decider reads) the item's own decider is
    # the approver: the roadmap's decider now proposes on it; an owner still applies.
    for who, want in (("decider", "propose"), ("owner", "apply")):
        m = await say(client, w, who, "rename Cut B to Cut B two")
        assert m["cards"][0]["may"] == want, who


async def test_unknown_person_gets_a_question(client):
    w = await world()
    m = await say(client, w, "owner", "Zelda owns Cut A")
    assert m["kind"] == "question" and m["cards"] == []
    assert "Zelda" in m["body"]


async def test_meeting_only_actions_refused_outside_a_meeting(client):
    w = await world()
    for line in ("note: ship it", "open question: who tests?", "next: Cut A", "skip Cut A"):
        m = await say(client, w, "owner", line)
        assert m["kind"] == "note", line
        assert m["body"] == chat_actions.MEETING_NOTE
        assert m["cards"] == []


async def test_notes_questions_and_agenda_in_a_meeting(client):
    w = await world()
    mt = await start(client, w, attendee_ids=[uid(w, x) for x in ("approver", "commenter",
                                                                  "viewer")])  # fmt: skip
    mid = mt["id"]
    note = await one_card(client, w, "commenter", "note: Ship the checklist first", mid)
    assert note["op"] == "minutes_note" and note["preview"] == {
        "kind": "note", "text": "Ship the checklist first"}  # fmt: skip
    assert (await get(client, w, mid))["notes"] == []
    r = await apply(client, w, "commenter", note["id"])
    assert r.status_code == 200, r.text
    assert r.json()["card"]["status"] == "applied" and r.json()["result"] is None
    q = await one_card(client, w, "approver", "open question: Who writes the tour?", mid)
    assert (await apply(client, w, "approver", q["id"])).status_code == 200
    drop = await one_card(client, w, "commenter", "note: Drop the video", mid)
    assert (await apply(client, w, "commenter", drop["id"])).status_code == 200
    seen = await get(client, w, mid, "approver")
    assert [(n["kind"], n["text"]) for n in seen["notes"]] == [
        ("note", "Ship the checklist first"), ("question", "Who writes the tour?"),
        ("note", "Drop the video")]  # fmt: skip
    assert (await undo(client, w, "commenter", drop["id"])).json()["status"] == "undone"
    assert len((await get(client, w, mid))["notes"]) == 2

    nxt = await one_card(client, w, "commenter", "next: Cut A", mid)
    assert nxt["op"] == "agenda_next" and nxt["summary"] == "Take Cut A next"
    assert (await apply(client, w, "commenter", nxt["id"])).status_code == 200
    assert (await get(client, w, mid, "viewer"))["agenda"]["next"]["title"] == "Cut A"
    skip = await one_card(client, w, "commenter", "skip Cut A", mid)
    assert skip["summary"] == "Skip Cut A"
    assert (await apply(client, w, "commenter", skip["id"])).status_code == 200
    agenda = (await get(client, w, mid))["agenda"]
    assert agenda["next"] is None and [x["title"] for x in agenda["skipped"]] == ["Cut A"]
    assert (await undo(client, w, "commenter", skip["id"])).status_code == 200
    agenda = (await get(client, w, mid))["agenda"]
    assert agenda["next"]["title"] == "Cut A" and agenda["skipped"] == []

    v = await say(client, w, "viewer", "note: viewers write too", mid)
    assert v["kind"] == "note" and v["cards"] == [] and v["body"] == chat.VIEWER_NOTE

    out = await end(client, w, mid)
    # qa-simple-decide-6: the quick summary is prose, never a note's own text.
    assert out["minutes"]["summary"] == f"{mt['title']}: no decision was taken."
    assert "Ship the checklist first" not in out["minutes"]["summary"]
    assert "Drop the video" not in out["minutes"]["summary"]
    assert "Who writes the tour?" in out["minutes"]["open_questions"]
    # An ended meeting takes no more notes.
    late = await one_card(client, w, "decider", "note: too late", mid)
    assert (await apply(client, w, "decider", late["id"])).status_code == 403


async def test_presenter_mode_bars_direct_actions(client):
    w = await world()
    mid = (await start(client, w))["id"]
    r = await client.put(f"{MEETINGS}/{mid}/chat/mode", json={"change_mode": "presenter"},
                         headers=w.ctx.as_("decider"))  # fmt: skip
    assert r.status_code == 200, r.text
    c = await one_card(client, w, "commenter", "note: mine", mid)
    assert c["may"] is None
    assert (await apply(client, w, "commenter", c["id"])).status_code == 403
    assert (await apply(client, w, "decider", c["id"])).status_code == 200


async def test_record_decision_in_a_meeting_and_on_ask(client):
    w = await world()
    mid = (await start(client, w))["id"]
    c = await one_card(client, w, "commenter", "decision by approver: Ship it weekly", mid)
    assert c["op"] == "record_decision" and c["preview"]["where"] == "meeting"
    r = await apply(client, w, "commenter", c["id"])
    assert r.status_code == 200, r.text
    did = r.json()["card"]["decision_id"]
    mt = await get(client, w, mid)
    [d] = [x for x in mt["meeting_decisions"] if x["id"] == did]
    assert d["title"] == "Ship it weekly" and d["approver"]["id"] == uid(w, "approver")
    c2 = await one_card(client, w, "commenter", "decision: Keep five steps", mid)
    assert c2["preview"]["decider_name"] == "Dee Cider"
    r = await apply(client, w, "commenter", c2["id"])
    did2 = r.json()["card"]["decision_id"]
    [d2] = [x for x in (await get(client, w, mid))["meeting_decisions"] if x["id"] == did2]
    assert d2["approver"]["id"] == uid(w, "decider")  # the PRD's decider
    assert (await undo(client, w, "commenter", c["id"])).status_code == 200
    async with tenant_session(w.ctx.tenant_id) as s:
        assert (await s.get(Decision, uuid.UUID(did))).status == "reversed"
        assert (await s.get(Decision, uuid.UUID(did2))).status == "decided"

    page = "/simple/prds/payments-prd"
    c = await one_card(client, w, "approver", "decision: Go weekly", page=page)
    assert c["preview"]["where"] == "page" and c["target"].get("document_id")
    r = await apply(client, w, "approver", c["id"])
    assert r.status_code == 200, r.text
    async with tenant_session(w.ctx.tenant_id) as s:
        d = await s.scalar(select(Decision).where(Decision.title == "Go weekly"))
        assert d is not None and d.status == "decided"
        assert d.approver_id == w.ctx.users["approver"].id
        assert {"kind": "document", "id": c["target"]["document_id"]} in [
            {"kind": x["kind"], "id": x["id"]} for x in d.subjects]  # fmt: skip
    # A commenter's is a proposal (test_simple_chat_followups); a viewer's is refused.
    c = await one_card(client, w, "viewer", "decision: Not mine", page=page)
    assert c["may"] is None
    assert (await apply(client, w, "viewer", c["id"])).status_code == 403


# ---------------------------------------------------------------- the review's findings
# - test_questions_and_unknown_lines_go_to_ask: protects=on the Ask panel's one box a line
#   that only contains "owns", "decides" or "skip" (a question, an unknown person or item)
#   is not claimed (understood=False, nothing written), while "skip <known item>" still
#   gets the meeting-only note and "<person> owns <item>" a card; fails_when=a natural
#   question becomes a refusal; no_claim=Oracle's Ask's own answer.
# - test_unknown_person_offers_matching_people: protects=an unknown or ambiguous person's
#   question carries choices of matching people; fails_when=the question has no choices;
#   no_claim=the choices row (chat-reader, wired by chat-join).
# - test_owner_words_name_the_items_own_owner / test_page_document_reads_document_routes /
#   test_ask_decision_undo_says_ask / test_apply_engine_does_not_reenter_chat_apply /
#   test_set_owner_and_decider_in_a_meeting_per_role /
#   test_direct_ops_in_a_meeting_for_owner_and_decider: the review's minors.


async def ask_box(client, w, who: str, text: str) -> dict:
    r = await client.post(ASK, json={"text": text, "only_understood": True},
                          headers=w.ctx.as_(who))  # fmt: skip
    assert r.status_code == 200, r.text
    return r.json()


async def test_questions_and_unknown_lines_go_to_ask(client):
    w = await world()
    for line in ("Which team owns billing?", "Tell me how marketing decides pricing",
                 "skip the intro, what is late?", "Who really owns Cut A?",
                 "Zelda owns Cut A", "commenter owns the moon", "skip the intro"):  # fmt: skip
        out = await ask_box(client, w, "owner", line)
        # chat-join: not claimed by a phrase: nothing written (Oracle's Ask), or the line
        # left to Oracle's reader ("Reading that…", which hands a question to Ask).
        if out["messages"]:
            assert out["messages"][-1]["kind"] == "pending", line
        else:
            assert out["understood"] is False, line
    out = await ask_box(client, w, "owner", "skip Cut A")
    assert out["understood"] is True
    assert out["messages"][-1]["body"] == chat_actions.MEETING_NOTE
    out = await ask_box(client, w, "owner", "commenter owns Cut A")
    assert out["understood"] is True and out["messages"][-1]["kind"] == "cards"


async def test_unknown_person_offers_matching_people(client):
    w = await world()
    async with tenant_session(w.ctx.tenant_id) as s:
        p = await drafts.principal_for(s, w.ctx.tenant_id, w.ctx.users["owner"].id)
        c = await chat.Ctx(s, p, None).load()
        r = chat.parse(c, "Deee owns Cut A")
        assert r.kind == "question" and not r.cards
        # chat-join: the choices row's choices (a pick builds the card).
        assert "Dee Cider" in [ch["label"] for ch in r.choices]


async def test_owner_words_name_the_items_own_owner(client):
    w = await world()
    c = await one_card(client, w, "owner", "approver owns Cut A")
    assert (await apply(client, w, "owner", c["id"])).status_code == 200
    m = await say(client, w, "owner", "who owns Cut A?")
    assert m["kind"] == "answer" and "track" not in m["body"], m["body"]


async def test_page_document_reads_document_routes(client):
    w = await world()
    async with tenant_session(w.ctx.tenant_id) as s:
        from oracle.docs.models import Document

        doc = await s.scalar(select(Document).where(Document.slug == "payments-prd"))
        assert (await chat_actions.page_document(s, "/simple/prds/payments-prd")).id == doc.id
        assert (await chat_actions.page_document(s, f"/documents/{doc.id}")).id == doc.id
        doc.slug = "roadmap"
        await s.flush()
        for page in ("/simple/roadmap", "/roadmap", "/simple/decisions?x=roadmap"):
            assert await chat_actions.page_document(s, page) is None, page
        assert (await chat_actions.page_document(s, "/documents/roadmap")).id == doc.id
        await s.rollback()


async def test_ask_decision_undo_says_ask(client):
    w = await world()
    c = await one_card(
        client, w, "approver", "decision: Go monthly", page="/simple/prds/payments-prd"
    )
    r = await apply(client, w, "approver", c["id"])
    did = uuid.UUID(r.json()["card"]["decision_id"])
    r = await undo(client, w, "approver", c["id"])
    assert r.status_code == 200 and r.json()["status"] == "undone"
    from oracle.decisions.models import DecisionReview

    async with tenant_session(w.ctx.tenant_id) as s:
        assert (await s.get(Decision, did)).status == "reversed"
        review = await s.scalar(select(DecisionReview).where(DecisionReview.decision_id == did))
        assert review.note == "Undone on the Ask panel"


async def test_apply_engine_does_not_reenter_chat_apply(client, monkeypatch):
    w = await world()
    c = await one_card(client, w, "owner", "commenter owns Cut A")

    async def boom(*a, **k):
        raise AssertionError("chat.apply re-entered")

    monkeypatch.setattr(chat, "apply", boom)
    from oracle.simple.models import SimpleChatCard

    async with tenant_session(w.ctx.tenant_id) as s:
        p = await drafts.principal_for(s, w.ctx.tenant_id, w.ctx.users["owner"].id)
        card = await s.get(SimpleChatCard, uuid.UUID(c["id"]))
        await chat_actions.apply_engine(s, p, card)
        assert card.status == "applied" and card.change_id is not None
        await s.commit()
    assert (await item(w, "cut-a")).owner_id == w.ctx.users["commenter"].id


async def test_set_owner_and_decider_in_a_meeting_per_role(client):
    w = await world()
    mid = (await start(client, w, attendee_ids=[uid(w, x) for x in (
        "owner", "approver", "commenter", "viewer")]))["id"]  # fmt: skip
    commenter = w.ctx.users["commenter"].id
    for who in ("owner", "decider", "approver", "commenter"):
        c = await one_card(client, w, who, "commenter owns Cut A", mid)
        assert c["op"] == "set_owner"
        r = await apply(client, w, who, c["id"])
        assert r.status_code == 200, (who, r.text)
        if r.json()["card"]["status"] == "applied":
            assert (await item(w, "cut-a")).owner_id == commenter, who
            assert (await undo(client, w, who, c["id"])).status_code == 200, who
        assert (await item(w, "cut-a")).owner_id is None, who
    c = await one_card(client, w, "owner", "approver decides Cut B", mid)
    r = await apply(client, w, "owner", c["id"])
    assert r.json()["card"]["status"] == "applied" and r.json()["card"]["decision_id"]
    v = await say(client, w, "viewer", "commenter owns Cut A", mid)
    assert v["cards"] == [] and v["body"] == chat.VIEWER_NOTE


async def test_direct_ops_in_a_meeting_for_owner_and_decider(client):
    w = await world()
    mid = (await start(client, w, attendee_ids=[uid(w, "owner")]))["id"]
    for who in ("owner", "decider"):
        for line in (f"note: by {who}", f"open question: {who} asks", "next: Cut A",
                     f"decision: {who} decided"):  # fmt: skip
            c = await one_card(client, w, who, line, mid)
            r = await apply(client, w, who, c["id"])
            assert r.status_code == 200 and r.json()["card"]["status"] == "applied", (who, line)
            assert (await undo(client, w, who, c["id"])).status_code == 200, (who, line)
    assert (await get(client, w, mid))["notes"] == []
