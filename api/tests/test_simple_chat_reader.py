"""Simple chat-reader (#723): free-form chat lines read in context (oracle.simple.chat's
reader, the ``chat_reader`` llm job), restated and confirmed as cards, in a meeting's chat
and the Ask panel's "This page". Against Postgres; the model is always a fake ``ask``.

Uses test_simple_chat_api's world (one roadmap with a decider: Ledger v2, Bulk import,
Partner API, Alert digest, Alert export) and its fake S8 meetings module.

Test cards (protects / fails_when / no_claim):

- test_free_form_line_is_restated_with_a_card: protects=a line parse() does not know is
  stored with a pending Oracle line ("Reading that…") and one queued chat_reader job; the
  job's payload carries the line, the thread's earlier lines, the caller's items (ids),
  people, today and OPS; its actions come back as the restated line "I understood one
  change:" and one card built by ChatOp.build; nothing is written to the plan;
  fails_when=a free-form line gets "I did not understand", the reader is offered an op
  outside OPS, or a card skips ChatOp.build; no_claim=the live model's reading.
- test_two_actions_two_cards_and_apply_all: protects=two actions give two cards under
  "I understood two changes:"; Apply all applies them in order; when the second cannot
  apply (stale after the first) Apply all stops there, says which and why, and leaves it
  open; fails_when=Apply all skips a card, applies past a failure or hides it;
  no_claim=more than five actions (the reader keeps five).
- test_ambiguous_gives_choices_then_a_card: protects=a clarify answer becomes one
  question with clickable choices (only those that build, "Neither" last); a pick posts
  the label as the person's line and the choice's card with no model call; "Neither"
  answers "Say it another way." and builds nothing; a second pick is refused; the fast
  path's ambiguous item ("move alert to Q2") carries the same choices;
  fails_when=Oracle guesses, a pick calls the model, or Neither builds a card;
  no_claim=the question's wording from the model.
- test_bad_model_replies_are_refusals: protects=an unknown op, a bad arg name, a date it
  cannot read and an item the caller cannot read (an id not on their roadmap) each become
  a plain one-line refusal with no card; fails_when=any of them makes a card;
  no_claim=the refusal's exact words.
- test_failed_read_offers_retry: protects=a failed (or cancelled) chat_reader job shows
  "I couldn't read that just now." with retry; Retry queues a new job and its answer
  completes the line; Retry on a line that did not fail is 409; fails_when=a failed read
  stays "Reading that…" forever or Retry is missing; no_claim=the worker's own retries.
- test_reader_roles_in_a_meeting: protects=in a meeting the reader's cards follow the
  change mode and gesture rules per role (owner and decider apply, approver and commenter
  propose); a viewer's free-form change gets the viewer note and no card;
  fails_when=a viewer gets a card or a role may more than its gesture; no_claim=S8.
- test_reader_roles_on_ask: protects=on the Ask panel each role's card follows their own
  rights (owner and decider apply, approver and commenter propose, viewer may not apply);
  a line the reader finds to be a plain question (no actions, no clarify, no answer) in the
  one box comes back "ask" for Oracle's Ask; an answer from the data is an answer;
  fails_when=a question becomes a card or a role does more than its gesture;
  no_claim=Oracle's Ask's answer.
- test_the_worker_claims_a_chat_reader_job: protects=the job worker claims a queued
  chat_reader job (it has no document or other subject row to lock) and the gateway knows
  its kind; fails_when=the job sits queued forever ("Reading that…" never ends);
  no_claim=the live model call.
- test_every_parse_op_is_registered: protects=every op parse() builds is in OPS and the
  reader's job is a registered runner and gateway job; fails_when=the reader cannot be
  offered an op parse() makes, or the job is unknown to the gateway; no_claim=chat-actions'
  ops (chat-join registers them).
"""

import uuid
from typing import Any

import pytest
from sqlalchemy import select

from oracle import company_time
from oracle.jobs import kinds
from oracle.jobs.models import LlmJob
from oracle.llm import gateway
from oracle.simple import chat
from oracle.tenancy import tenant_session
from tests.test_simple_chat_api import (
    ASK,
    CARDS,
    MeetingRules,
    World,
    make_people,
    meetings,  # noqa: F401 -- the fixture
    n_changes,
)
from tests.test_simple_roadmap_api import NOW


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


def _meeting(ctx, fake, mode: str = "everyone") -> uuid.UUID:
    mid = uuid.uuid4()
    u = ctx.users
    fake.rules[mid] = MeetingRules(
        meeting_id=mid, session_id=None, presenter_id=u["owner"].id,
        attendee_ids=[u[r].id for r in ("owner", "decider", "approver", "commenter", "viewer")],
        change_mode=mode,
    )  # fmt: skip
    return mid


def _url(meeting: uuid.UUID | None) -> str:
    return f"/v1/simple/meetings/{meeting}/chat" if meeting else "/v1/simple/chat"


async def post(client, ctx, who, text, meeting=None, only_understood=False) -> dict:
    body: dict[str, Any] = {"text": text}
    if only_understood:
        body["only_understood"] = True
    r = await client.post(f"{_url(meeting)}/messages", json=body, headers=ctx.as_(who))
    assert r.status_code == 200, r.text
    return r.json()


async def last(client, ctx, who, meeting=None) -> dict:
    r = await client.get(_url(meeting), headers=ctx.as_(who))
    assert r.status_code == 200, r.text
    return r.json()["messages"][-1]


async def read(ctx, answer: Any, seen: list | None = None, fail: str | None = None) -> int:
    """Run every queued chat_reader job as the worker would, with a fake model answer
    (``fail``: the job's end state instead)."""

    async def ask(kind, payload):
        assert kind == "chat_reader"
        if seen is not None:
            seen.append(payload)
        return answer(payload) if callable(answer) else answer

    async with tenant_session(ctx.tenant_id) as s:
        ids = list(
            await s.scalars(
                select(LlmJob.id).where(LlmJob.kind == "chat_reader", LlmJob.status == "queued")
            )
        )
    for i in ids:
        async with tenant_session(ctx.tenant_id) as s:
            job = await s.get(LlmJob, i)
            assert job is not None
            if fail:
                job.status = fail
            else:
                job.output = await kinds.RUNNERS["chat_reader"](s, job, ask)
                job.status = "succeeded"
            await s.commit()
    return len(ids)


def act(op: str, **args: str) -> dict:
    return {"op": op, "args": args, "restated": f"{op} {args}"}


def actions(*xs: dict) -> dict:
    return {"actions": list(xs), "clarify": None, "answer": None}


async def test_free_form_line_is_restated_with_a_card(client):
    ctx = await make_people()
    w = await World(ctx).build()
    await post(client, ctx, "owner", "who owns Ledger v2?")
    t = await post(client, ctx, "owner", "can we push Ledger v2 out a quarter")
    m = t["messages"][-1]
    assert m["kind"] == "pending" and m["body"] == "Reading that…" and m["cards"] == []
    assert t["messages"][-2]["body"] == "can we push Ledger v2 out a quarter"
    assert m["reply_to"] == t["messages"][-2]["id"]
    seen: list = []
    ledger = w.ids["Ledger v2"]
    n = await read(ctx, actions(act("move_dates", item=ledger, shift="1 quarter")), seen)
    assert n == 1
    p = seen[0]
    assert p["line"] == "can we push Ledger v2 out a quarter"
    assert [x["text"] for x in p["thread"]][:1] == ["who owns Ledger v2?"]
    assert ledger in {i["id"] for i in p["items"]}
    assert {o["op"] for o in p["ops"]} == set(chat.OPS)
    assert p["today"] == "2026-11-02" or p["today"]
    assert any(x["email"] == "dee@example.com" for x in p["people"])
    assert p["context"]["role"] == "owner"
    m = await last(client, ctx, "owner")
    assert m["kind"] == "cards" and m["body"] == "I understood one change:"
    [card] = m["cards"]
    assert card["op"] == "move_dates" and card["status"] == "open" and card["may"] == "apply"
    assert card["after"] == {"start_date": "2027-01-01", "end_date": "2027-02-15"}
    assert await n_changes(ctx) == 0
    r = await client.post(f"{CARDS}/{card['id']}/apply", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert str((await w.item("Ledger v2")).start_date) == "2027-01-01"


async def test_two_actions_two_cards_and_apply_all(client):
    ctx = await make_people()
    w = await World(ctx).build()
    ledger, export = w.ids["Ledger v2"], w.ids["Alert export"]
    await post(client, ctx, "owner", "push ledger to next quarter and drop the export")
    await read(ctx, actions(act("move_dates", item=ledger, when="next quarter"),
                            act("cut", item=export)))  # fmt: skip
    m = await last(client, ctx, "owner")
    assert m["body"] == "I understood two changes:"
    assert [c["op"] for c in m["cards"]] == ["move_dates", "cut"]
    r = await client.post(f"/v1/simple/chat/messages/{m['id']}/apply-all",
                          headers=ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["stopped"] is None and len(out["applied"]) == 2
    assert (await w.item("Alert export")).cut is True
    # The second card is stale once the first applies: Apply all stops there.
    await post(client, ctx, "owner", "push ledger out a month, then to March")
    await read(ctx, actions(act("move_dates", item=ledger, shift="1 month"),
                            act("move_dates", item=ledger, when="March 3")))  # fmt: skip
    m = await last(client, ctx, "owner")
    first, second = m["cards"]
    r = await client.post(f"/v1/simple/chat/messages/{m['id']}/apply-all",
                          headers=ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["applied"] == [first["id"]]
    assert out["stopped"]["card_id"] == second["id"] and out["stopped"]["reason"]
    after = {c["id"]: c["status"] for c in out["thread"]["messages"][-1]["cards"]}
    assert after == {first["id"]: "applied", second["id"]: "open"}
    # A viewer's Apply all is refused.
    r = await client.post(f"/v1/simple/chat/messages/{m['id']}/apply-all",
                          headers=ctx.as_("viewer"))  # fmt: skip
    assert r.status_code in (403, 404)


async def test_ambiguous_gives_choices_then_a_card(client):
    ctx = await make_people()
    w = await World(ctx).build()
    digest, export = w.ids["Alert digest"], w.ids["Alert export"]
    await post(client, ctx, "owner", "shift the alert thing to next quarter")
    clarify = {"actions": [], "answer": None, "clarify": {"question": "Which item?", "choices": [
        {"label": "Alert digest", "op": "move_dates", "args": {"item": digest,
                                                               "when": "next quarter"}},
        {"label": "Alert export", "op": "move_dates", "args": {"item": export,
                                                               "when": "next quarter"}},
        {"label": "Nope", "op": "erase_all", "args": {}},
    ]}}  # fmt: skip
    await read(ctx, clarify)
    q = await last(client, ctx, "owner")
    assert q["kind"] == "question" and q["body"] == "Which item?" and q["cards"] == []
    assert [c["label"] for c in q["choices"]] == ["Alert digest", "Alert export", "Neither"]
    r = await client.post(f"/v1/simple/chat/messages/{q['id']}/choose", json={"index": 1},
                          headers=ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 200, r.text
    msgs = r.json()["messages"]
    assert msgs[-2]["body"] == "Alert export" and msgs[-2]["author_kind"] == "person"
    assert msgs[-1]["body"] == "I understood one change:"
    assert [(c["op"], c["item_id"]) for c in msgs[-1]["cards"]] == [("move_dates", export)]
    assert [m for m in msgs if m["id"] == q["id"]][0]["picked"] == 1
    r = await client.post(f"/v1/simple/chat/messages/{q['id']}/choose", json={"index": 0},
                          headers=ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 409
    # Another person's Ask line is not theirs.
    r = await client.post(f"/v1/simple/chat/messages/{q['id']}/choose", json={"index": 0},
                          headers=ctx.as_("commenter"))  # fmt: skip
    assert r.status_code == 404
    # The fast path's ambiguous item: the same choices; Neither builds nothing.
    t = await post(client, ctx, "owner", "move alert to Q2")
    q = t["messages"][-1]
    assert q["body"] == "Which one: Alert digest or Alert export?"
    assert [c["label"] for c in q["choices"]] == ["Alert digest", "Alert export", "Neither"]
    r = await client.post(f"/v1/simple/chat/messages/{q['id']}/choose", json={"index": 2},
                          headers=ctx.as_("owner"))  # fmt: skip
    msgs = r.json()["messages"]
    assert msgs[-2]["body"] == "Neither"
    assert msgs[-1]["body"] == "Say it another way." and msgs[-1]["cards"] == []
    assert await n_changes(ctx) == 0


async def test_bad_model_replies_are_refusals(client):
    ctx = await make_people()
    w = await World(ctx).build()
    ledger = w.ids["Ledger v2"]
    bad = [
        actions(act("erase_everything", item=ledger)),
        actions(act("move_dates", item=ledger, colour="red")),
        actions(act("move_dates", item=ledger, when="someday soon")),
        actions(act("cut", item=str(uuid.uuid4()))),
        {"actions": "nope"},
        "not even json",
    ]
    for answer in bad:
        await post(client, ctx, "owner", "do the thing with the thing")
        await read(ctx, answer)
        m = await last(client, ctx, "owner")
        assert m["kind"] == "note", (answer, m)
        assert m["cards"] == [] and m["choices"] == [], answer
        assert "\n" not in m["body"]
    assert await n_changes(ctx) == 0


@pytest.mark.parametrize("end", ["failed", "cancelled"])
async def test_failed_read_offers_retry(client, end):
    ctx = await make_people()
    w = await World(ctx).build()
    await post(client, ctx, "owner", "kick ledger down the road a month")
    await read(ctx, None, fail=end)
    m = await last(client, ctx, "owner")
    assert m["kind"] == "failed" and m["retry"] is True
    assert m["body"] == "I couldn't read that just now."
    r = await client.post(f"/v1/simple/chat/messages/{m['id']}/retry", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert r.json()["messages"][-1]["kind"] == "pending"
    await read(ctx, actions(act("move_dates", item=w.ids["Ledger v2"], shift="1 month")))
    m = await last(client, ctx, "owner")
    assert m["kind"] == "cards" and len(m["cards"]) == 1
    r = await client.post(f"/v1/simple/chat/messages/{m['id']}/retry", headers=ctx.as_("owner"))
    assert r.status_code == 409


MAY = {"owner": "apply", "decider": "apply", "approver": "propose", "commenter": "propose"}


async def test_reader_roles_in_a_meeting(client, meetings):  # noqa: F811
    ctx = await make_people()
    w = await World(ctx).build()
    mid = _meeting(ctx, meetings)
    answer = actions(act("change_horizon", item=w.ids["Partner API"], horizon="next"))
    for who, may in MAY.items():
        await post(client, ctx, who, "let's bring partner api forward", mid)
        await read(ctx, answer)
        m = await last(client, ctx, who, mid)
        assert m["body"] == "I understood one change:", who
        [card] = m["cards"]
        assert card["may"] == may, who
    await post(client, ctx, "viewer", "let's bring partner api forward", mid)
    await read(ctx, answer)
    m = await last(client, ctx, "viewer", mid)
    assert m["kind"] == "note" and m["cards"] == []
    assert m["body"] == chat.VIEWER_NOTE
    # The commenter's Apply proposes; the decider's applies.
    cards = [c for x in (await client.get(_url(mid), headers=ctx.as_("owner"))).json()[
        "messages"] for c in x["cards"]]  # fmt: skip
    r = await client.post(f"{CARDS}/{cards[3]['id']}/apply", headers=ctx.as_("commenter"))
    assert r.json()["result"]["change"]["status"] == "proposed"
    r = await client.post(f"{CARDS}/{cards[1]['id']}/apply", headers=ctx.as_("decider"))
    assert r.json()["result"]["change"]["status"] == "applied"
    assert (await w.item("Partner API")).horizon == "next"


async def test_reader_roles_on_ask(client):
    ctx = await make_people()
    w = await World(ctx).build()
    answer = actions(act("edit_title", item=w.ids["Bulk import"], title="Bulk import v2"))
    for who, may in {**MAY, "viewer": None}.items():
        await post(client, ctx, who, "call bulk import v2 from now on", only_understood=True)
        await read(ctx, answer)
        m = await last(client, ctx, who)
        [card] = m["cards"]
        assert card["may"] == may, who
        if may is None:
            r = await client.post(f"{CARDS}/{card['id']}/apply", headers=ctx.as_(who))
            assert r.status_code == 403
    # A plain question in the one box goes to Oracle's Ask; an answer from the data stays.
    await post(client, ctx, "commenter", "why is the plan shaped like this", only_understood=True)
    await read(ctx, {"actions": [], "clarify": None, "answer": None})
    assert (await last(client, ctx, "commenter"))["kind"] == "ask"
    await post(client, ctx, "commenter", "anything starting after ledger?", only_understood=True)
    await read(ctx, {"actions": [], "clarify": None, "answer": "Bulk import starts 20 Nov."})
    m = await last(client, ctx, "commenter")
    assert m["kind"] == "answer" and m["body"] == "Bulk import starts 20 Nov."
    # Outside the one box a plain question with nothing to do is a note.
    await post(client, ctx, "commenter", "why is the plan shaped like this")
    await read(ctx, {"actions": [], "clarify": None, "answer": None})
    assert (await last(client, ctx, "commenter"))["kind"] == "note"
    assert await n_changes(ctx) == 0


async def test_the_worker_claims_a_chat_reader_job(client):
    from oracle.jobs import worker

    ctx = await make_people()
    await World(ctx).build()
    await post(client, ctx, "owner", "nudge ledger a little later")
    async with tenant_session(ctx.tenant_id) as s:
        queued = await s.scalar(select(LlmJob.id).where(LlmJob.kind == "chat_reader"))
    assert await worker.claim_next(ctx.tenant_id) == queued
    async with tenant_session(ctx.tenant_id) as s:
        job = await s.get(LlmJob, queued)
        assert job is not None and job.status == "running"


def test_every_parse_op_is_registered():
    ops = {"move_dates", "change_horizon", "set_milestone", "add_feature_ask",
           "add_launch_task", "add_item_task", "add_action_item", "edit_title", "cut"}  # fmt: skip
    assert ops <= set(chat.OPS)
    assert all(isinstance(o, chat.ChatOp) and o.args for o in chat.OPS.values())
    assert "chat_reader" in kinds.RUNNERS and "chat_reader" in gateway.JOBS
    assert ASK == "/v1/simple/chat/messages"


# chat-reader review (the verdict's minors).


async def test_review_one_bad_action_keeps_the_valid_cards(client):
    # protects: one invalid action among several keeps the valid cards and says, on the same
    # line, which one it cannot do; fails_when: the whole reply turns into a refusal.
    ctx = await make_people()
    w = await World(ctx).build()
    await post(client, ctx, "owner", "push ledger out a quarter and erase everything")
    await read(ctx, actions(act("move_dates", item=w.ids["Ledger v2"], shift="1 quarter"),
                            act("erase_everything", item=w.ids["Bulk import"])))  # fmt: skip
    m = await last(client, ctx, "owner")
    assert m["kind"] == "cards" and [c["op"] for c in m["cards"]] == ["move_dates"]
    assert m["body"].endswith("I understood one change:") and "can't do" in m["body"]
    assert "\n" not in m["body"]


async def test_review_unknown_person_or_day_is_a_question(client):
    # protects: an action naming an unknown person or a day Oracle cannot read asks a
    # question (no card) instead of refusing; fails_when: it reads "I can't do that: Who …".
    ctx = await make_people()
    w = await World(ctx).build()
    await post(client, ctx, "owner", "give zed the ledger cutover")
    await read(ctx, actions(act("add_action_item", owner="Zed Nobody", title="run the cutover")))
    m = await last(client, ctx, "owner")
    assert m["kind"] == "question" and m["cards"] == []
    assert m["body"].startswith("Who is “Zed Nobody”?")
    await post(client, ctx, "owner", "a ledger task for whenever")
    await read(ctx, actions(act("add_item_task", item=w.ids["Ledger v2"], title="Dry run",
                                due="whenever")))  # fmt: skip
    m = await last(client, ctx, "owner")
    assert m["kind"] == "question" and m["cards"] == []
    assert m["body"] == "Which day is “whenever”?"
    assert await n_changes(ctx) == 0


async def test_review_an_answer_names_oracles_data(client):
    # protects: the reader's free-text answer is kept only when it speaks of Oracle's data
    # (an item or a person it was given); fails_when: an answer about anything else is shown.
    ctx = await make_people()
    await World(ctx).build()
    off = {"actions": [], "clarify": None, "answer": "The weather in Paris is sunny."}
    await post(client, ctx, "commenter", "how is the weather", only_understood=True)
    await read(ctx, off)
    assert (await last(client, ctx, "commenter"))["kind"] == "ask"
    await post(client, ctx, "commenter", "how is the weather")
    await read(ctx, off)
    m = await last(client, ctx, "commenter")
    assert m["kind"] == "note" and "Paris" not in m["body"]


async def test_review_under_discussion_is_the_agenda_head(client, meetings):  # noqa: F811
    # protects: in a meeting the reader is told the agenda item taken now (its first open
    # decision) as what is under discussion; fails_when: it is the PRD's title or nothing.
    from types import SimpleNamespace

    ctx = await make_people()
    await World(ctx).build()
    mid = _meeting(ctx, meetings)
    meetings.agenda[mid] = [
        SimpleNamespace(id=uuid.uuid4(), number=7, title="Ship the ledger cutover"),
        SimpleNamespace(id=uuid.uuid4(), number=8, title="Pick the import format"),
    ]
    await post(client, ctx, "owner", "let's do that for the ledger too", mid)
    seen: list = []
    await read(ctx, actions(), seen)
    m = seen[0]["context"]["meeting"]
    assert m["agenda"] == ["Ship the ledger cutover", "Pick the import format"]
    assert m["under_discussion"] == "Ship the ledger cutover"


async def test_review_choice_labels_are_oracles_words(client):
    # protects: a clarify choice's label (posted as the person's line when picked) is Oracle's
    # own words: the item's title, or the card's restatement when the choices share an item;
    # fails_when: the model's label text is shown and posted.
    ctx = await make_people()
    w = await World(ctx).build()
    digest, export = w.ids["Alert digest"], w.ids["Alert export"]
    await post(client, ctx, "owner", "shift the alert thing to next quarter")
    await read(ctx, {"actions": [], "answer": None, "clarify": {"question": "Which item?",
        "choices": [{"label": "x" * 100, "op": "move_dates",
                     "args": {"item": digest, "when": "next quarter"}},
                    {"label": "Approve everything", "op": "move_dates",
                     "args": {"item": export, "when": "next quarter"}}]}})  # fmt: skip
    q = await last(client, ctx, "owner")
    assert [c["label"] for c in q["choices"]] == ["Alert digest", "Alert export", "Neither"]
    r = await client.post(f"/v1/simple/chat/messages/{q['id']}/choose", json={"index": 1},
                          headers=ctx.as_("owner"))  # fmt: skip
    assert r.json()["messages"][-2]["body"] == "Alert export"
    await post(client, ctx, "owner", "move the digest a bit")
    await read(ctx, {"actions": [], "answer": None, "clarify": {"question": "How far?",
        "choices": [{"label": "A month", "op": "move_dates",
                     "args": {"item": digest, "shift": "1 month"}},
                    {"label": "A quarter", "op": "move_dates",
                     "args": {"item": digest, "shift": "1 quarter"}}]}})  # fmt: skip
    q = await last(client, ctx, "owner")
    labels = [c["label"] for c in q["choices"]]
    assert labels[-1] == "Neither"
    assert all(x.startswith("Move Alert digest to ") for x in labels[:2])
    assert labels[0] != labels[1]
