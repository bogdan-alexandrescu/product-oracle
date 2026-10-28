"""Simple chat-join (#723): chat-actions' ACTIONS joined into chat-reader's reader, so a
free-form line in a meeting's chat or the Ask panel's "This page" can ask for the new
actions too. Against Postgres; the model is always a fake ``ask``.

Uses test_simple_meetings_api's world (a roadmap with Cut A, a decider, real S8 meetings).

Test cards (protects / fails_when / no_claim):

- test_every_action_is_a_registered_op: protects=each chat_actions.ACTIONS entry is in
  chat.OPS with its own build and describe, chat.apply applies it through its own apply,
  and the reader's payload offers it; fails_when=the reader cannot be offered an action or
  its card is applied by anything but the action's apply; no_claim=the live model.
- test_reader_two_changes_owner_and_dates: protects=a free-form "push <item> to next
  quarter and make <person> own it" read as two actions gives "I understood two changes:"
  and two cards; Apply all applies both in order (the dates move, the item's own owner is
  the person); fails_when=the set_owner action is refused or Apply all stops;
  no_claim=the model's reading of the words.
- test_reader_decision_note_question_and_agenda: protects=in a meeting the reader's
  record_decision, minutes_note, open_question, agenda_next, agenda_skip and set_decider
  actions each become one card restated "I understood one change:" with the action's own
  preview, and Apply writes the meeting's decision, notes and agenda; fails_when=any of
  them is refused or applies to the wrong place; no_claim=the minutes job's text.
- test_reader_unknown_person_asks_with_choices: protects=an action naming a person Oracle
  cannot find asks one question with the people the name may mean and "Neither"; a pick
  builds the card; nothing changes until Apply; fails_when=Oracle guesses the person or
  the question has no choices; no_claim=the question's wording.
- test_reader_new_ops_per_place_and_role: protects=on the Ask panel the meeting-only
  actions are a one-line refusal and no card, a decision is a card on the page's document;
  in a meeting a viewer's free-form action gets the viewers' note; fails_when=a card is
  built outside a meeting or for a viewer; no_claim=Ask's General tab.
"""

import uuid
from typing import Any

from sqlalchemy import select

from oracle.jobs import kinds
from oracle.jobs.models import LlmJob
from oracle.simple import chat, chat_actions
from oracle.tenancy import tenant_session
from tests.test_simple_changes_api import clock as clock  # noqa: F401
from tests.test_simple_chat_actions import item
from tests.test_simple_meetings_api import MEETINGS, get, start, uid, world

ASK = "/v1/simple/chat/messages"
CARDS = "/v1/simple/chat/cards"


def _url(meeting: str | None) -> str:
    return f"{MEETINGS}/{meeting}/chat" if meeting else "/v1/simple/chat"


async def post(client, w, who: str, text: str, meeting: str | None = None) -> dict:
    r = await client.post(f"{_url(meeting)}/messages", json={"text": text},
                          headers=w.ctx.as_(who))  # fmt: skip
    assert r.status_code == 200, r.text
    return r.json()["messages"][-1]


async def last(client, w, who: str, meeting: str | None = None) -> dict:
    r = await client.get(_url(meeting), headers=w.ctx.as_(who))
    assert r.status_code == 200, r.text
    return r.json()["messages"][-1]


async def read(w, answer: Any, seen: list | None = None) -> int:
    """Run every queued chat_reader job as the worker would, with a fake model answer."""

    async def ask(kind, payload):
        assert kind == "chat_reader"
        if seen is not None:
            seen.append(payload)
        return answer

    async with tenant_session(w.ctx.tenant_id) as s:
        ids = list(
            await s.scalars(
                select(LlmJob.id).where(LlmJob.kind == "chat_reader", LlmJob.status == "queued")
            )
        )
    for i in ids:
        async with tenant_session(w.ctx.tenant_id) as s:
            job = await s.get(LlmJob, i)
            assert job is not None
            job.output = await kinds.RUNNERS["chat_reader"](s, job, ask)
            job.status = "succeeded"
            await s.commit()
    return len(ids)


def act(op: str, **args: str) -> dict:
    return {"op": op, "args": args, "restated": f"{op} {args}"}


def actions(*xs: dict) -> dict:
    return {"actions": list(xs), "clarify": None, "answer": None}


async def reads(client, w, who: str, line: str, answer: dict, meeting: str | None = None):
    """The line, read by the fake reader: Oracle's reply."""
    m = await post(client, w, who, line, meeting)
    assert m["kind"] == "pending", (line, m["body"])
    assert await read(w, answer) == 1
    return await last(client, w, who, meeting)


async def apply(client, w, who: str, card_id: str):
    return await client.post(f"{CARDS}/{card_id}/apply", headers=w.ctx.as_(who))


def test_every_action_is_a_registered_op():
    for a in chat_actions.ACTIONS:
        op = chat.OPS[a["op"]]
        assert op.build is a["build"] and op.describe == a["describe"]
        assert op.args == a["args"]
        assert chat.APPLIERS[a["op"]] is a["apply"]
    assert {a["op"] for a in chat_actions.ACTIONS} == {
        "set_owner", "set_decider", "record_decision", "minutes_note", "open_question",
        "agenda_next", "agenda_skip"}  # fmt: skip


async def test_reader_two_changes_owner_and_dates(client):
    w = await world()
    mid = (await start(client, w))["id"]
    cut_a = str(w.ids["cut-a"])
    seen: list = []
    await post(client, w, "decider", "push Cut A to next quarter and make the approver own it",
               mid)  # fmt: skip
    answer = actions(act("move_dates", item=cut_a, when="next quarter"),
                     act("set_owner", item=cut_a, person="approver@example.com"))  # fmt: skip
    assert await read(w, answer, seen) == 1
    assert {"set_owner", "record_decision", "agenda_next"} <= {o["op"] for o in seen[0]["ops"]}
    m = await last(client, w, "decider", mid)
    assert m["kind"] == "cards" and m["body"] == "I understood two changes:"
    assert [c["op"] for c in m["cards"]] == ["move_dates", "set_owner"]
    assert m["cards"][1]["preview"]["kind"] == "owner"
    r = await client.post(f"{ASK}/{m['id']}/apply-all", headers=w.ctx.as_("decider"))
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["stopped"] is None and len(out["applied"]) == 2
    assert (await item(w, "cut-a")).owner_id == w.ctx.users["approver"].id


async def test_reader_decision_note_question_and_agenda(client):
    w = await world()
    mid = (await start(client, w))["id"]
    cut_a = str(w.ids["cut-a"])
    cases = [
        ("we decided to keep Cut A in M3", act("record_decision", text="Keep Cut A in M3"),
         "record_decision", "decision"),
        ("note that legal must review the PII rules",
         act("minutes_note", text="Legal must review the PII rules"), "minutes_note", "note"),
        ("we still need to find out who writes the tour",
         act("open_question", text="Who writes the tour?"), "open_question", "question"),
        ("let's do Cut A next", act("agenda_next", item=cut_a), "agenda_next", "agenda"),
        ("park Cut A for today", act("agenda_skip", item=cut_a), "agenda_skip", "agenda"),
        ("the approver calls the shots on Cut A now",
         act("set_decider", item=cut_a, person="approver@example.com"), "set_decider",
         "decider"),
    ]  # fmt: skip
    for line, action, op, kind in cases:
        m = await reads(client, w, "decider", line, actions(action), mid)
        assert m["kind"] == "cards" and m["body"] == "I understood one change:", (line, m)
        [c] = m["cards"]
        assert c["op"] == op and c["preview"]["kind"] == kind, line
        r = await apply(client, w, "decider", c["id"])
        assert r.status_code == 200, (line, r.text)
        assert r.json()["card"]["status"] == "applied", line
    mt = await get(client, w, mid)
    assert "Keep Cut A in M3" in [d["title"] for d in mt["meeting_decisions"]]
    assert [(n["kind"], n["text"]) for n in mt["notes"]] == [
        ("note", "Legal must review the PII rules"),
        ("question", "Who writes the tour?"),
    ]
    assert [x["title"] for x in mt["agenda"]["skipped"]] == ["Cut A"]
    assert (await item(w, "cut-a")).decider_id == w.ctx.users["approver"].id


async def test_reader_unknown_person_asks_with_choices(client):
    w = await world()
    mid = (await start(client, w))["id"]
    cut_a = str(w.ids["cut-a"])
    q = await reads(client, w, "decider", "give Cut A to Deee",
                    actions(act("set_owner", item=cut_a, person="Deee")), mid)  # fmt: skip
    assert q["kind"] == "question" and q["cards"] == []
    labels = [c["label"] for c in q["choices"]]
    assert "Dee Cider" in labels and labels[-1] == "Neither"
    r = await client.post(f"{ASK}/{q['id']}/choose", json={"index": labels.index("Dee Cider")},
                          headers=w.ctx.as_("decider"))  # fmt: skip
    assert r.status_code == 200, r.text
    m = r.json()["messages"][-1]
    assert [(c["op"], c["status"]) for c in m["cards"]] == [("set_owner", "open")]
    assert (await item(w, "cut-a")).owner_id is None


async def test_reader_new_ops_per_place_and_role(client):
    w = await world()
    m = await reads(client, w, "approver", "jot down that legal reviews PII",
                    actions(act("minutes_note", text="Legal reviews PII")))  # fmt: skip
    assert m["kind"] == "note" and m["cards"] == [] and chat_actions.MEETING_NOTE in m["body"]
    m = await reads(client, w, "approver", "we decided to ship weekly",
                    actions(act("record_decision", text="Ship weekly")))  # fmt: skip
    assert [c["op"] for c in m["cards"]] == ["record_decision"]
    assert m["cards"][0]["preview"]["where"] == "page"
    mid = (await start(client, w, attendee_ids=[uid(w, x) for x in ("approver", "viewer")]))["id"]
    m = await reads(client, w, "viewer", "note that viewers write too",
                    actions(act("minutes_note", text="Viewers write too")), mid)  # fmt: skip
    assert m["kind"] == "note" and m["cards"] == [] and m["body"] == chat.VIEWER_NOTE
    assert uuid.UUID(mid)
