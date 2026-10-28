"""A meeting's minutes say only what happened (the owner's production walk, 2026-10-27).
Against Postgres; the world and helpers are test_simple_meetings_api's; the
``meeting_minutes`` job runs with a fake ``ask`` (never a live model). Invented data only.

Test cards (protects / fails_when / no_claim):

- test_an_empty_meeting_invents_nothing: protects=a meeting where nothing was said, decided
  or assigned gets quick minutes and job minutes saying plainly that nothing was decided or
  recorded, with no open question and no action item, even when the model answers with
  invented ones (and no model call is spent on it); fails_when=an open question or action
  item appears that nobody said, or the PRD's other open decisions are listed as the
  meeting's; no_claim=the waits (facts of the working drafts, unchanged).
- test_two_action_items_are_exactly_those: protects=a meeting with two recorded action
  items gets exactly those two in the minutes (title, owner and due date as recorded), in
  the quick draft and after the job, when the model drops one, renames one and adds an
  invented one; fails_when=the invented item is kept, a recorded one is missing, or an
  owner or date is not the recorded one; no_claim=how action items are recorded
  (test_simple_changes_api's add_action_item).
- test_chat_lines_support_questions_and_tasks: protects=a question asked in the meeting
  chat stays an open question, and a task said in the chat stays an action item, its owner
  kept only because the line names them and its date only because the line says it; an
  invented question, an invented owner and an invented date are dropped (and logged);
  fails_when=the minutes keep "Why did the session close without decisions?" or assign a
  task to someone the line does not name, or the same task twice; no_claim=the model's
  summary wording.
- test_support_units: protects=the record check's word overlap, plural folding and date
  reading; fails_when=an unrelated line supports an item or "Nov 6" is not read as the
  6th of November; no_claim=every phrasing.
"""

import uuid
from datetime import date

from sqlalchemy import select, update

from oracle.auth.models import User
from oracle.jobs.models import LlmJob
from oracle.simple import meetings, minutes
from oracle.simple.models import SimpleActionItem
from oracle.tenancy import tenant_session
from tests.test_simple_meetings_api import MEETINGS, end, get, start, uid, world

INVENTED = {
    "summary": "The session closed without decisions.",
    "open_questions": [
        "Why did the session close without decisions - missing information, missing "
        "decision-makers, or no agenda?"
    ],
    "action_items": [
        {"title": "Schedule a follow-up session", "owner_id": None, "due_date": "2026-11-09"},
    ],
}


async def run_job(w, answer: dict) -> tuple[dict, int]:
    calls = []
    async with tenant_session(w.ctx.tenant_id) as s:
        job = await s.scalar(select(LlmJob).where(LlmJob.kind == "meeting_minutes"))
        assert job is not None

        async def ask(kind, payload):
            calls.append(payload)
            return answer

        out = await meetings.run_job(s, job, ask)
        await s.commit()
    assert out["written"] is True, out
    return out, len(calls)


def logged(monkeypatch) -> list[str]:
    """What the record check logs as dropped."""
    out: list[str] = []
    monkeypatch.setattr(minutes.log, "info", lambda msg, *a: out.append(msg % a))
    return out


async def chat(client, w, mid: str, who: str, text: str) -> None:
    r = await client.post(f"{MEETINGS}/{mid}/chat/messages", json={"text": text},
                          headers=w.ctx.as_(who))  # fmt: skip
    assert r.status_code == 200, r.text


async def test_an_empty_meeting_invents_nothing(client):
    w = await world()
    m = await start(client, w)
    out = await end(client, w, m["id"])
    quick = out["minutes"]
    assert quick["summary"] == "Payments review: nothing was decided or recorded."
    assert quick["open_questions"] == [] and quick["action_items"] == []
    _, calls = await run_job(w, INVENTED)
    assert calls == 0
    mins = (await get(client, w, m["id"]))["minutes"]
    assert mins["written_by"] == "oracle"
    assert mins["summary"] == "Payments review: nothing was decided or recorded."
    assert mins["open_questions"] == [] and mins["action_items"] == []


async def test_two_action_items_are_exactly_those(client, monkeypatch):
    w = await world()
    m = await start(client, w)
    async with tenant_session(w.ctx.tenant_id) as s:
        for title, who, due in (("Send the pricing note", "approver", date(2026, 11, 6)),
                                ("Book the support training", "commenter", None)):  # fmt: skip
            s.add(SimpleActionItem(meeting_id=uuid.UUID(m["id"]), title=title,
                                   owner_id=w.ctx.users[who].id, due_date=due,
                                   created_by=w.ctx.users["decider"].id))  # fmt: skip
        await s.commit()
    want = [
        {"title": "Send the pricing note", "owner_id": uid(w, "approver"),
         "due_date": "2026-11-06"},
        {"title": "Book the support training", "owner_id": uid(w, "commenter"),
         "due_date": None},
    ]  # fmt: skip
    quick = (await end(client, w, m["id"]))["minutes"]
    assert sorted(({k: a[k] for k in ("title", "owner_id", "due_date")}
            for a in quick["action_items"]), key=str) == sorted(want, key=str)  # fmt: skip
    answer = {
        "summary": "Two follow-ups were agreed.",
        "open_questions": [],
        "action_items": [
            {"title": "Send the pricing notes", "owner_id": uid(w, "commenter"),
             "due_date": "2026-12-01"},
            {"title": "Hire a new vendor for ledgers", "owner_id": uid(w, "approver"),
             "due_date": None},
        ],
    }  # fmt: skip
    dropped = logged(monkeypatch)
    _, calls = await run_job(w, answer)
    assert calls == 1
    mins = (await get(client, w, m["id"]))["minutes"]
    assert sorted(({k: a[k] for k in ("title", "owner_id", "due_date")}
            for a in mins["action_items"]), key=str) == sorted(want, key=str)  # fmt: skip
    assert any("Hire a new vendor" in x for x in dropped)


async def test_chat_lines_support_questions_and_tasks(client, monkeypatch):
    w = await world()
    m = await start(client, w)
    await chat(client, w, m["id"], "approver", "Who signs off the QA plan?")
    await chat(client, w, m["id"], "commenter", "Ann will write the QA plan by Nov 6")
    async with tenant_session(w.ctx.tenant_id) as s:
        await s.execute(update(User).where(User.id == w.ctx.users["approver"].id)
                        .values(name="Ann Prover"))  # fmt: skip
        await s.commit()
    quick = (await end(client, w, m["id"]))["minutes"]
    assert quick["open_questions"] == ["Who signs off the QA plan?"]
    assert quick["action_items"] == []
    answer = {
        "summary": "The QA plan was discussed.",
        "open_questions": ["Who signs off the QA plan?", INVENTED["open_questions"][0]],
        "action_items": [
            {"title": "Write the QA plan", "owner_id": uid(w, "approver"),
             "due_date": "2026-11-06"},
            {"title": "Write the QA plans", "owner_id": uid(w, "approver"),
             "due_date": "2026-11-06"},
            {"title": "Ann writes the QA plan", "owner_id": uid(w, "decider"),
             "due_date": "2026-11-20"},
            INVENTED["action_items"][0],
        ],
    }  # fmt: skip
    dropped = logged(monkeypatch)
    await run_job(w, answer)
    mins = (await get(client, w, m["id"]))["minutes"]
    assert mins["open_questions"] == ["Who signs off the QA plan?"]
    got = [{k: a[k] for k in ("title", "owner_id", "due_date")} for a in mins["action_items"]]
    assert got == [
        {"title": "Write the QA plan", "owner_id": uid(w, "approver"), "due_date": "2026-11-06"},
        {"title": "Ann writes the QA plan", "owner_id": None, "due_date": None},
    ]
    text = " ".join(dropped)
    assert "missing decision-makers" in text and "follow-up session" in text


def test_support_units():
    assert minutes.supports("Ann will write the QA plan by Nov 6", "Write the QA plans")
    assert not minutes.supports("Ann will write the QA plan", "Schedule a follow-up session")
    assert not minutes.supports("anything", "the of and")
    assert minutes._said_date("2026-11-06", "write it by Nov 6")
    assert minutes._said_date("2026-11-06", "due 6 November")
    assert not minutes._said_date("2026-11-16", "write it by Nov 6")
    assert not minutes._said_date("soon", "write it by Nov 6")
