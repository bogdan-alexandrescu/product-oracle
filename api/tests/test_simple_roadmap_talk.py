"""Simple roadmap-talk (#723, the owner's pick C): talk to Oracle inside a roadmap item's
card, and conversational roadmap changes with Apply / Reject / Correct. Against Postgres;
the reader's model is always a fake ``ask`` (tests.test_simple_chat_join.read).

One roadmap (tests.test_simple_changes_api's World with the move_dates items): ``a``
Adaptive pacing (Oct 1 - Nov 15, milestone "M1 Launch prep" on Nov 15), ``b`` Reliability
work (Nov 10 - Dec 15, depends on a, milestone "M2 Scale volume" on Dec 18), ``u``
undated; the goal Growth. Today is Nov 2.

Test cards (protects / fails_when / no_claim):

- test_roadmap_actions_are_registered: protects=move_to_milestone, move_after, add_item
  and split_item are ops the reader is offered, and move_dates takes typed days;
  fails_when=one is missing from chat.OPS or the reader's payload; no_claim=the model.
- test_item_talk_answers_with_its_source: protects=an item's talk is its own thread (per
  item and person), the reader gets the item as "it", and the answer says where it comes
  from ("From the PRD · …" / "From the roadmap · …"); fails_when=the talk shares the Ask
  panel's thread, the item is not in the payload or the answer has no source;
  no_claim=the model's words.
- test_item_talk_move_restated_per_role: protects="move it two weeks later" in the item's
  talk is restated in one line ("I understood: move … two weeks later, to Oct 15 – Nov
  29.") with one card showing before -> after, what it breaks and its Correct fields;
  Apply applies for the owner and the decider, proposes for approvers and commenters; a
  viewer gets a note and no card; fails_when=the card is built for a viewer, the
  restatement is missing or Apply bypasses the change engine's rights; no_claim=the web's
  layout.
- test_new_actions_per_role: protects=each new action (move to another milestone, move
  after another item, add an item with goal, milestone and dates, split into slices)
  read by the reader on the roadmap page becomes engine cards that apply for the owner
  and the decider and are proposed for approvers and commenters; viewers get no cards;
  fails_when=a new action writes outside the change engine or a role gets the wrong
  outcome; no_claim=the drafted item's outcome (Oracle's item_draft job).
- test_two_actions_one_corrected_one_rejected: protects=a two-action sentence gives two
  cards; Correct's values win (the dates written are the corrected ones and the
  restatement says them); Reject writes nothing; fails_when=Apply after Correct writes
  Oracle's reading or Reject changes the plan; no_claim=the model's reading.
- test_correct_refuses_what_the_engine_would: protects=Correct's values go through the
  same build (an unknown milestone or goal, an end before the start, a field the card
  has not) and are refused with a reason, writing nothing; the reader's unknown goal or
  self-move is a refusal, never a card; fails_when=a corrected or read card is one the
  change engine would refuse; no_claim=the wording of each refusal.
- test_correct_restates_the_item_talk_line: protects=after Correct in an item's talk the
  "I understood:" line says the corrected values; fails_when=the line keeps Oracle's
  reading while the corrected dates apply; no_claim=the web's layout.
- test_applied_add_item_names_its_item: protects=an applied add_item card names the new
  item (the timeline flashes its bar); fails_when=the card's item_id stays empty;
  no_claim=a proposed addition (it has no item yet).
- test_add_item_card_says_what_the_engine_does: protects=an add_item card's Apply or
  Propose follows the target roadmap's own rule (with no decider, its approver-owner
  applies); fails_when=the card says Propose while the engine applies; no_claim=other ops.
- test_item_talk_filters_off_topic_answers: protects=in an item's talk an answer that
  names nothing of the item or the roadmap is not shown as Oracle's; fails_when=any
  reader answer is shown; no_claim=the model's words.
- test_correct_refusals_are_plain: protects=Correct's refusals use plain words, never
  field jargon ("values: ..."); a cut on the roadmap is a roadmap card with nothing to
  correct (the web says Reject); fails_when=a refusal starts with an internal field name or
  a roadmap cut has no Correct data; no_claim=the exact wording.
- test_talk_move_by_a_span_moves_from_newer_dates: protects=a talk card's "two weeks
  later" carries its span (preview.shift, as the mock's talkMove), so when someone moves
  the item before it is applied, it is offered again two weeks after the item's new dates
  and Apply lands there; fails_when=the card keeps its old absolute dates (the API and
  the mock disagree on what the card does); no_claim=a card naming a day (it keeps that
  day).
"""

import uuid
from datetime import date

import pytest
from sqlalchemy import select

from oracle.baseline.models import Entity
from oracle.roadmap.models import RoadmapItem
from oracle.simple import chat, drafts
from oracle.tenancy import tenant_session
from tests.test_simple_changes_api import World, make_people
from tests.test_simple_changes_api import clock as clock  # noqa: F401
from tests.test_simple_chat_join import act, actions, read

CHAT = "/v1/simple/chat"
CARDS = "/v1/simple/chat/cards"
ROADMAP = "/simple/roadmap"
APPLIES = {"owner": "applied", "decider": "applied", "approver": "proposed",
           "commenter": "proposed"}  # fmt: skip
ROLES = ["owner", "decider", "approver", "commenter", "viewer"]


async def world() -> World:
    w = await World(await make_people()).build(decider=True, ops=["move_dates"])
    async with tenant_session(w.ctx.tenant_id) as s:
        a = await s.get(RoadmapItem, uuid.UUID(w.ids["move_dates-a"]))
        b = await s.get(RoadmapItem, uuid.UUID(w.ids["move_dates-b"]))
        a.title, b.title = "Adaptive pacing", "Reliability work"
        a.milestone = {"name": "M1 Launch prep", "date": "2026-11-15", "date_source": "typed"}
        b.milestone = {"name": "M2 Scale volume", "date": "2026-12-18", "date_source": "typed"}
        g = Entity(type="goal", key="G1", title="Growth", status="confirmed", origin="user",
                   attrs={})  # fmt: skip
        s.add(g)
        await s.commit()
        w.goal = str(g.id)  # type: ignore[attr-defined]
    return w


def page(w: World, key: str = "a") -> str:
    return f"/simple/roadmap/items/{w.ids[f'move_dates-{key}']}"


async def say(client, w, who: str, text: str, where: str) -> dict:
    r = await client.post(f"{CHAT}/messages", json={"text": text, "page": where},
                          headers=w.ctx.as_(who))  # fmt: skip
    assert r.status_code == 200, r.text
    return r.json()["messages"][-1]


async def last(client, w, who: str, where: str) -> dict:
    r = await client.get(CHAT, params={"page": where}, headers=w.ctx.as_(who))
    assert r.status_code == 200, r.text
    return r.json()["messages"][-1]


async def reads(client, w, who: str, line: str, answer: dict, where: str, seen=None) -> dict:
    m = await say(client, w, who, line, where)
    assert m["kind"] == "pending", (line, m["body"])
    assert await read(w, answer, seen) == 1
    return await last(client, w, who, where)


async def apply(client, w, who: str, card_id: str, values: dict | None = None):
    body = {"values": values} if values is not None else None
    return await client.post(f"{CARDS}/{card_id}/apply", json=body, headers=w.ctx.as_(who))


async def row(w: World, key: str) -> RoadmapItem:
    return await w.item(f"move_dates-{key}")


async def added(w: World, title: str) -> RoadmapItem | None:
    async with tenant_session(w.ctx.tenant_id) as s:
        r = await s.scalar(select(RoadmapItem).where(RoadmapItem.title == title))
        return await drafts.effective_row(s, r) if r is not None else None


def test_roadmap_actions_are_registered():
    for op in ("move_to_milestone", "move_after", "add_item", "split_item"):
        assert op in chat.OPS
    assert {"start", "end", "shift", "when"} <= set(chat.OPS["move_dates"].args)


async def test_item_talk_answers_with_its_source(client):
    w = await world()
    seen: list = []
    m = await reads(client, w, "commenter", "what is this for?",
                    {"actions": [], "clarify": None, "answer": "Adaptive pacing serves Growth.",
                     "source": "prd"}, page(w), seen)  # fmt: skip
    assert seen[0]["context"]["item"]["id"] == w.ids["move_dates-a"]
    assert {"M1 Launch prep", "M2 Scale volume"} <= set(seen[0]["milestones"])
    assert m["kind"] == "answer" and m["body"] == "Adaptive pacing serves Growth."
    assert m["source"] in ("From the PRD · Adaptive pacing", "From the roadmap · Adaptive pacing")
    # A question parse() answers at once says its source too.
    m = await say(client, w, "commenter", "when is it?", page(w))
    assert m["kind"] == "answer" and m["body"].startswith("Adaptive pacing: Oct 1")
    assert m["source"] == "From the roadmap · Adaptive pacing"
    # The talk is kept with this item and this person.
    r = await client.get(CHAT, params={"page": page(w, "b")}, headers=w.ctx.as_("commenter"))
    assert r.json()["messages"] == []
    r = await client.get(CHAT, params={"page": page(w)}, headers=w.ctx.as_("approver"))
    assert r.json()["messages"] == []
    r = await client.get(CHAT, params={"page": ROADMAP}, headers=w.ctx.as_("commenter"))
    assert r.json()["messages"] == []


@pytest.mark.parametrize("who", ROLES)
async def test_item_talk_move_restated_per_role(client, who):
    w = await world()
    m = await say(client, w, who, "move it two weeks later", page(w))
    if who == "viewer":
        assert m["kind"] == "note" and m["cards"] == []
        assert m["body"].startswith("Viewers ask questions here")
        return
    assert m["kind"] == "cards"
    assert m["body"] == "I understood: move Adaptive pacing two weeks later, to Oct 15 – Nov 29."
    [card] = m["cards"]
    assert card["op"] == "move_dates" and card["after"] == {"start_date": "2026-10-15",
                                                           "end_date": "2026-11-29"}  # fmt: skip
    assert card["change_words"] == {"before": "Oct 1 – Nov 15", "after": "Oct 15 – Nov 29"}
    assert card["correct"]["fields"] == ["start_date", "end_date"]
    assert card["correct"]["values"] == {"start_date": "2026-10-15", "end_date": "2026-11-29"}
    kinds = {f["kind"] for x in card["flags"] for f in x["flags"] if f["state"] == "red"}
    assert "outside_milestone" in kinds  # it ends after M1 (Nov 15)
    assert card["may"] == ("apply" if APPLIES[who] == "applied" else "propose")
    r = await apply(client, w, who, card["id"])
    assert r.status_code == 200, r.text
    assert r.json()["card"]["status"] == APPLIES[who]
    a = await row(w, "a")
    moved = APPLIES[who] == "applied"
    assert a.start_date == (date(2026, 10, 15) if moved else date(2026, 10, 1))


@pytest.mark.parametrize("who", ROLES)
async def test_new_actions_per_role(client, who):
    w = await world()
    a, b = w.ids["move_dates-a"], w.ids["move_dates-b"]
    answer = actions(act("move_to_milestone", item=a, milestone="M2"),
                     act("add_item", title="Dashboard", goal="Growth", milestone="M2"),
                     act("split_item", item=b, slices="two"),
                     act("move_after", item=a, after=b))  # fmt: skip
    m = await reads(client, w, who, "a few roadmap changes", answer, ROADMAP)
    if who == "viewer":
        assert m["kind"] == "note" and m["cards"] == []
        return
    ops = [c["op"] for c in m["cards"]]
    assert ops == ["set_milestone", "add_item", "move_dates", "add_item", "move_dates"], ops
    ms, add, first, slice2, after = m["cards"]
    assert ms["summary"] == "Move Adaptive pacing to M2 Scale volume (Dec 18)"
    assert ms["change_words"] == {"before": "M1 Launch prep", "after": "M2 Scale volume"}
    assert add["summary"] == "Add Dashboard under Growth to M2 Scale volume, Dec 5 – Dec 18"
    assert add["correct"]["values"] == {
        "title": "Dashboard", "goal": "Growth", "milestone": "M2 Scale volume",
        "start_date": "2026-12-05", "end_date": "2026-12-18",
    }  # fmt: skip
    assert first["after"]["end_date"] < "2026-12-15" and slice2["after"]["title"].endswith("2")
    assert after["after"]["start_date"] == "2026-12-16"
    may = "apply" if APPLIES[who] == "applied" else "propose"
    assert [c["may"] for c in m["cards"]] == [may] * 5
    for card in (ms, add, first, slice2):
        r = await apply(client, w, who, card["id"])
        assert r.status_code == 200, r.text
        assert r.json()["card"]["status"] == APPLIES[who], card["op"]
    applied = APPLIES[who] == "applied"
    ra = await row(w, "a")
    assert (ra.milestone or {}).get("name") == ("M2 Scale volume" if applied else "M1 Launch prep")
    dash = await added(w, "Dashboard")
    if applied:
        assert dash is not None and dash.goal_ids == [uuid.UUID(w.goal)]  # type: ignore[attr-defined]
        assert (dash.start_date, dash.end_date) == (date(2026, 12, 5), date(2026, 12, 18))
        assert dash.milestone["name"] == "M2 Scale volume"
        assert await added(w, "Reliability work: slice 2") is not None
    else:
        assert dash is None


async def test_two_actions_one_corrected_one_rejected(client):
    w = await world()
    a, b = w.ids["move_dates-a"], w.ids["move_dates-b"]
    answer = actions(act("move_after", item=b, after=a),
                     act("add_item", title="Dashboard", goal="Growth", milestone="M2"))  # fmt: skip
    m = await reads(client, w, "owner", "push b after a and add a dashboard item to M2 under "
                    "Growth", answer, ROADMAP)  # fmt: skip
    assert m["body"] == "I understood two changes:"
    move, add = m["cards"]
    assert move["after"] == {"start_date": "2026-11-16", "end_date": "2026-12-21"}
    # Correct: the person's dates win and the restatement says them.
    r = await apply(client, w, "owner", move["id"],
                    {"start_date": "2026-11-20", "end_date": "2026-12-20"})  # fmt: skip
    assert r.status_code == 200, r.text
    card = r.json()["card"]
    assert card["status"] == "applied" and card["summary"] == (
        "Move Reliability work to Nov 20 – Dec 20"
    )
    assert card["after"] == {"start_date": "2026-11-20", "end_date": "2026-12-20"}
    rb = await row(w, "b")
    assert (rb.start_date, rb.end_date) == (date(2026, 11, 20), date(2026, 12, 20))
    # Reject writes nothing.
    r = await client.post(f"{CARDS}/{add['id']}/discard", headers=w.ctx.as_("owner"))
    assert r.status_code == 200 and r.json()["status"] == "discarded"
    assert await added(w, "Dashboard") is None
    # A corrected add: its title, milestone and dates as corrected.
    one = actions(act("add_item", title="Dashboard", goal="Growth"))
    m = await reads(client, w, "owner", "add a dashboard item", one, ROADMAP)
    r = await apply(client, w, "owner", m["cards"][0]["id"],
                    {"title": "Growth dashboard", "milestone": "M1 Launch prep",
                     "start_date": "2026-11-03", "end_date": "2026-11-13"})  # fmt: skip
    assert r.status_code == 200, r.text
    assert r.json()["card"]["summary"] == (
        "Add Growth dashboard under Growth to M1 Launch prep, Nov 3 – Nov 13"
    )
    d = await added(w, "Growth dashboard")
    assert d is not None and (d.start_date, d.end_date) == (date(2026, 11, 3), date(2026, 11, 13))
    assert d.milestone["name"] == "M1 Launch prep"


async def test_correct_refuses_what_the_engine_would(client):
    w = await world()
    m = await say(client, w, "owner", "move it two weeks later", page(w))
    cid = m["cards"][0]["id"]
    for values, why in (({"start_date": "2026-12-01", "end_date": "2026-11-01"}, "end"),
                        ({"milestone": "M2"}, "cannot be corrected"),
                        ({"start_date": "someday"}, "day")):  # fmt: skip
        r = await apply(client, w, "owner", cid, values)
        assert r.status_code == 422 and why in r.text, r.text
    assert (await row(w, "a")).start_date == date(2026, 10, 1)
    # The card is still open and applies as read.
    r = await apply(client, w, "owner", cid)
    assert r.status_code == 200 and r.json()["card"]["status"] == "applied"
    # A milestone the plan does not know.
    b = w.ids["move_dates-b"]
    m = await reads(
        client,
        w,
        "owner",
        "move it to M3",
        actions(act("move_to_milestone", item=b, milestone="M3")),
        page(w, "b"),
    )
    assert m["cards"] == [] and "M3" in m["body"]
    # The reader's unknown goal or self-move is a refusal, never a card.
    a = w.ids["move_dates-a"]
    m = await reads(client, w, "owner", "odd", actions(act("add_item", title="X", goal="Nope"),
                    act("move_after", item=a, after=a)), ROADMAP)  # fmt: skip
    assert m["cards"] == []
    # Correct on a card off the roadmap (the Home Ask panel) is refused.
    m = await say(client, w, "owner", "cut Move_Dates U", "/simple")
    r = await apply(client, w, "owner", m["cards"][0]["id"], {"title": "x"})
    assert r.status_code == 422, r.text


async def test_correct_restates_the_item_talk_line(client):
    w = await world()
    m = await say(client, w, "owner", "move it two weeks later", page(w))
    assert m["body"] == "I understood: move Adaptive pacing two weeks later, to Oct 15 – Nov 29."
    r = await apply(client, w, "owner", m["cards"][0]["id"],
                    {"start_date": "2026-11-20", "end_date": "2026-12-04"})  # fmt: skip
    assert r.status_code == 200, r.text
    assert r.json()["card"]["summary"] == "Move Adaptive pacing to Nov 20 – Dec 4"
    line = await last(client, w, "owner", page(w))
    assert line["body"] == "I understood: move Adaptive pacing to Nov 20 – Dec 4."


async def test_applied_add_item_names_its_item(client):
    w = await world()
    one = actions(act("add_item", title="Dashboard", goal="Growth", milestone="M2"))
    m = await reads(client, w, "owner", "add a dashboard item", one, ROADMAP)
    r = await apply(client, w, "owner", m["cards"][0]["id"])
    assert r.status_code == 200, r.text
    d = await added(w, "Dashboard")
    assert d is not None and r.json()["card"]["item_id"] == str(d.id)


@pytest.mark.parametrize("who", ["approver", "commenter"])
async def test_add_item_card_says_what_the_engine_does(client, who):
    w = await World(await make_people()).build(decider=False, track_owner="approver",
                                               ops=["move_dates"])  # fmt: skip
    one = actions(act("add_item", title="Dashboard"))
    m = await reads(client, w, who, "add a dashboard item", one, ROADMAP)
    [card] = m["cards"]
    want = "applied" if who == "approver" else "proposed"
    assert card["may"] == ("apply" if want == "applied" else "propose")
    r = await apply(client, w, who, card["id"])
    assert r.status_code == 200, r.text
    assert r.json()["card"]["status"] == want


async def test_item_talk_filters_off_topic_answers(client):
    w = await world()
    m = await reads(client, w, "commenter", "tell me a joke",
                    {"actions": [], "clarify": None, "answer": "The weather is fine today.",
                     "source": "roadmap"}, page(w))  # fmt: skip
    assert m["kind"] != "answer" and "weather" not in m["body"]
    m = await reads(client, w, "commenter", "where does it end?",
                    {"actions": [], "clarify": None, "answer": "It ends in M1 Launch prep.",
                     "source": "roadmap"}, page(w))  # fmt: skip
    assert m["kind"] == "answer" and m["body"] == "It ends in M1 Launch prep."


async def test_correct_refusals_are_plain(client):
    w = await world()
    m = await say(client, w, "owner", "move it two weeks later", page(w))
    r = await apply(client, w, "owner", m["cards"][0]["id"], {"milestone": "M2"})
    assert r.status_code == 422 and "cannot be corrected" in r.text
    assert not r.json()["detail"].startswith("values")
    m = await say(client, w, "owner", "cut Move_Dates U", "/simple")
    r = await apply(client, w, "owner", m["cards"][0]["id"], {"title": "x"})
    assert r.status_code == 422 and not r.json()["detail"].startswith("values"), r.text
    m = await say(client, w, "owner", "cut Move_Dates U", ROADMAP)
    [cut] = m["cards"]
    assert cut["correct"] == {"fields": [], "values": {}}
    r = await apply(client, w, "owner", cut["id"], {"title": "x"})
    assert r.status_code == 422 and r.json()["detail"] == "The title cannot be corrected here"


async def test_talk_move_by_a_span_moves_from_newer_dates(client):
    w = await world()
    m = await say(client, w, "owner", "move it two weeks later", page(w))
    [card] = m["cards"]
    assert card["preview"]["shift"] == [0, 14]
    moved = {"start_date": "2026-10-08", "end_date": "2026-11-22"}
    r = await client.post("/v1/simple/changes", json={
        "op": "move_dates", "target": {"item_id": w.ids["move_dates-a"]},
        "before": card["before"], "after": moved}, headers=w.ctx.as_("decider"))  # fmt: skip
    assert r.status_code == 201, r.text
    r = await apply(client, w, "owner", card["id"])
    assert r.status_code == 409, r.text
    again = (await last(client, w, "owner", page(w)))["cards"][0]
    assert again["before"] == moved
    assert again["after"] == {"start_date": "2026-10-22", "end_date": "2026-12-06"}
    r = await apply(client, w, "owner", card["id"])
    assert r.status_code == 200, r.text
    a = await row(w, "a")
    assert (a.start_date, a.end_date) == (date(2026, 10, 22), date(2026, 12, 6))
