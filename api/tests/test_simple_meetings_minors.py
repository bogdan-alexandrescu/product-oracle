"""Simple meetings say what happened to a meeting and to a question (the end-to-end pass of
2026-10-30). Against Postgres, with S8's real meetings module.

Test cards (protects / fails_when / no_claim):
- test_a_meeting_nobody_opened_is_ended_by_the_idle_sweep: protects=a meeting whose start
  reply never reached its presenter (the row was created, nobody opened it) stays live
  past its length, then the idle sweep (changes.close_idle, then meetings.end_idle, both
  the ticker's) ends it with Oracle's quick minutes, with no one reading it;
  fails_when=the row stays live until someone opens it; no_claim=the web's clock
  (e2e/simple-meeting-minors.spec.ts).
- test_a_kept_question_shows_under_notes_at_once: protects=a chat question the reader saw
  nothing to change in ("Kept as a question for the minutes") is an open question on the
  meeting's notes at once, by its asker, and the minutes list it once; fails_when=the
  notes stay empty until the meeting ends, or the minutes list it twice;
  no_claim=the reader's wording.
"""

import uuid
from datetime import timedelta

from sqlalchemy import select

from oracle.simple import changes, chat, meetings
from oracle.simple.models import SimpleMeeting
from oracle.tenancy import tenant_session
from tests.test_simple_changes_api import clock as clock  # noqa: F401
from tests.test_simple_chat_reader import read
from tests.test_simple_meetings_api import MEETINGS, end, get, start, uid, world
from tests.test_simple_roadmap_api import NOW

NOTHING = {"actions": [], "clarify": None, "answer": None}


async def _row(w, mid: str) -> SimpleMeeting:
    async with tenant_session(w.ctx.tenant_id) as s:
        row = await s.scalar(select(SimpleMeeting).where(SimpleMeeting.id == uuid.UUID(mid)))
        assert row is not None
        return row


async def _sweep(w) -> int:
    async with tenant_session(w.ctx.tenant_id) as s:
        await changes.close_idle(s)
        n = await meetings.end_idle(s)
        await s.commit()
        return n


async def test_a_meeting_nobody_opened_is_ended_by_the_idle_sweep(client, clock):  # noqa: F811
    w = await world()
    # The start's reply failed: the row is there, and nobody opens the meeting.
    mid = (await start(client, w, length_min=60))["id"]
    clock["now"] = NOW + timedelta(minutes=90)
    assert await _sweep(w) == 0
    assert (await _row(w, mid)).status == "live"
    clock["now"] = NOW + changes.MEETING_IDLE + timedelta(minutes=1)
    assert await _sweep(w) == 1
    row = await _row(w, mid)
    assert row.status == "ended" and row.minutes_state == "ready"
    assert row.ended_at == clock["now"] and row.ended_by == row.presenter_id
    assert row.minutes is not None
    assert await _sweep(w) == 0
    out = await get(client, w, mid)
    assert out["status"] == "ended" and out["can"]["end"] is True


async def test_a_kept_question_shows_under_notes_at_once(client):
    w = await world()
    mid = (await start(client, w, attendee_ids=[uid(w, x) for x in ("approver", "commenter")]))[
        "id"
    ]
    line = "Can we move Cut A to start on 2026-12-01, so the pilot fits?"
    r = await client.post(
        f"{MEETINGS}/{mid}/chat/messages", json={"text": line}, headers=w.ctx.as_("commenter")
    )
    assert r.status_code == 200, r.text
    assert r.json()["messages"][-1]["kind"] == "pending"
    assert await read(w.ctx, NOTHING) == 1
    r = await client.get(f"{MEETINGS}/{mid}/chat", headers=w.ctx.as_("commenter"))
    assert r.json()["messages"][-1]["body"] == chat.MEETING_ASK
    notes = (await get(client, w, mid, "approver"))["notes"]
    assert [(n["kind"], n["text"]) for n in notes] == [("question", line)]
    assert notes[0]["card_id"] is None and notes[0]["by_name"] != "someone"
    out = await end(client, w, mid)
    assert out["minutes"]["open_questions"].count(line) == 1
