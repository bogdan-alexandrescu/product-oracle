"""Simple S8 (#723), production walk: the minutes job's failure and slowness, Draft again,
Send whatever the job's state, and Meetings > Upcoming from each ritual's next review
(oracle.simple.meetings). Against Postgres, over REST as a person would, on
test_simple_meetings_api's world; the minutes job runs with a fake ``ask``.

Test cards (protects / fails_when / no_claim):

- test_failed_minutes_job_and_draft_again (role x redraft): protects=a failed
  ``meeting_minutes`` job reads ``minutes_job`` "failed" with ``can.redraft`` for the
  decider and an owner only; Draft again (``POST .../minutes/redraft``) is 403 for an
  approver and a commenter, requeues the job for the decider (drafting again) and is 409
  when nothing failed; fails_when=a failed job reads as drafting forever, anyone else
  requeues it, or a requeue twice is allowed; no_claim=the job runner's retry budget.
- test_slow_minutes_job: protects=a job queued or running past 2 minutes reads "slow";
  fails_when=it reads "drafting" forever; no_claim=the runner's own timeouts.
- test_send_without_a_job_answer: protects=the person's edited summary, open questions
  and action items send while the job has not answered (sent with them, the job's later
  answer is dropped), and the quick minutes send while it failed; fails_when=Send waits
  on the job or the job overwrites sent minutes; no_claim=email and Slack (test_delivery_choices).
- test_upcoming_lists_ritual_next_review: protects=Meetings > Upcoming lists an active
  ritual's next review before its occurrence is made (what Home shows), a viewer reads
  it, a commenter may not start from it (403, nothing made) and the decider's start makes
  the occurrence, links the meeting to it and moves the ritual on; fails_when=Upcoming
  says no review while a ritual is due, or a start from it makes two occurrences;
  no_claim=the pre-read (oracle.rituals' tests).
"""

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select, update

from oracle import company_time
from oracle.jobs.models import LlmJob
from oracle.rituals.models import Ritual, RitualOccurrence
from oracle.simple import meetings
from oracle.tenancy import tenant_session
from tests.test_simple_changes_api import clock as clock  # noqa: F401
from tests.test_simple_meetings_api import (
    MEETINGS,
    PRD,
    edit_title,
    end,
    get,
    start,
    uid,
    world,
)


async def ended(client, w, edit: bool = True) -> dict:
    m = await start(client, w)
    if edit:
        assert (await edit_title(client, w, "decider", m["session_id"])).status_code == 201
    out = await end(client, w, m["id"])
    assert out["minutes_state"] == "drafting" and out["minutes_job"] == "drafting"
    assert not out["can"]["redraft"]
    return out


async def set_job(w, **values) -> None:
    async with tenant_session(w.ctx.tenant_id) as s:
        await s.execute(update(LlmJob).where(LlmJob.kind == "meeting_minutes").values(**values))
        await s.commit()


async def test_failed_minutes_job_and_draft_again(client):
    w = await world()
    m = await ended(client, w)
    redraft = f"{MEETINGS}/{m['id']}/minutes/redraft"
    r = await client.post(redraft, headers=w.ctx.as_("decider"))
    assert r.status_code == 409, r.text
    await set_job(w, status="failed", error="the model said no", attempts=3)
    for who, may in (("decider", True), ("owner", True), ("approver", False),
                     ("commenter", False)):  # fmt: skip
        out = await get(client, w, m["id"], who)
        assert out["minutes_job"] == "failed" and out["can"]["redraft"] is may, who
    for who in ("approver", "commenter"):
        r = await client.post(redraft, headers=w.ctx.as_(who))
        assert r.status_code == 403, (who, r.text)
    r = await client.post(redraft, headers=w.ctx.as_("decider"))
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["minutes_state"] == "drafting" and out["minutes_job"] == "drafting"
    assert not out["can"]["redraft"]
    async with tenant_session(w.ctx.tenant_id) as s:
        jobs = list(await s.scalars(select(LlmJob).where(LlmJob.kind == "meeting_minutes")))
        assert [(j.status, j.attempts, j.error) for j in jobs] == [("queued", 0, None)]
    assert (await client.post(redraft, headers=w.ctx.as_("decider"))).status_code == 409


async def test_slow_minutes_job(client):
    w = await world()
    m = await ended(client, w)
    await set_job(w, updated_at=datetime.now(UTC) - timedelta(minutes=3))
    out = await get(client, w, m["id"])
    assert out["minutes_job"] == "slow" and not out["can"]["redraft"]


async def test_send_without_a_job_answer(client):
    w = await world()
    m = await ended(client, w)
    body = {"summary": "We kept the ledger.", "open_questions": ["Who tells support?"],
            "action_items": [{"title": "Write the QA plan", "owner_id": uid(w, "approver"),
                              "due_date": "2026-11-02"}]}  # fmt: skip
    r = await client.put(f"{MEETINGS}/{m['id']}/minutes", json=body, headers=w.ctx.as_("decider"))
    assert r.status_code == 200, r.text
    r = await client.post(f"{MEETINGS}/{m['id']}/send", json={}, headers=w.ctx.as_("decider"))
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["minutes_state"] == "sent" and out["minutes_job"] is None
    assert out["minutes"]["summary"] == "We kept the ledger."
    assert out["minutes"]["open_questions"] == ["Who tells support?"]
    assert out["minutes"]["action_items"][0]["title"] == "Write the QA plan"
    async with tenant_session(w.ctx.tenant_id) as s:
        job = await s.scalar(select(LlmJob).where(LlmJob.kind == "meeting_minutes"))

        async def ask(kind, payload):
            return {"summary": "A late answer"}

        assert (await meetings.run_job(s, job, ask))["written"] is False
        await s.commit()
    assert (await get(client, w, m["id"]))["minutes"]["summary"] == "We kept the ledger."
    # A failed job: the quick minutes send as they are.
    m2 = await ended(client, w, edit=False)
    await set_job(w, status="failed")
    assert (await get(client, w, m2["id"]))["minutes_job"] == "failed"
    r = await client.post(f"{MEETINGS}/{m2['id']}/send", json={}, headers=w.ctx.as_("decider"))
    assert r.status_code == 200 and r.json()["minutes_state"] == "sent", r.text
    assert r.json()["minutes"]["written_by"] == "extract"


async def test_upcoming_lists_ritual_next_review(client):
    w = await world()
    due = (company_time.now() + timedelta(days=3)).replace(microsecond=0)
    async with tenant_session(w.ctx.tenant_id) as s:
        r = Ritual(kind="custom", title="Leadership review", duration_min=60, prep_hours=2,
                   schedule={"freq": "weekly", "interval": 1, "weekday": 1, "week_of_month": 1,
                             "month": 1, "time": "10:00", "timezone": "UTC"},
                   next_due_at=due, owner_id=w.ctx.users["decider"].id,
                   attendee_ids=[w.ctx.users["approver"].id])  # fmt: skip
        s.add(r)
        await s.commit()
        ritual_id = str(r.id)
    listed = (await client.get(MEETINGS, headers=w.ctx.as_("viewer"))).json()["upcoming"]
    assert [(x["ritual_id"], x["occurrence_id"], x["meeting_id"]) for x in listed] == [
        (ritual_id, None, None)
    ]
    assert listed[0]["ritual_title"] == "Leadership review" and listed[0]["length_min"] == 60
    body = {"prd": PRD, "ritual_id": ritual_id}
    r = await client.post(MEETINGS, json=body, headers=w.ctx.as_("commenter"))
    assert r.status_code == 403, r.text
    m = await start(client, w, ritual_id=ritual_id)
    assert m["occurrence_id"] and m["origin"] == "ritual"
    async with tenant_session(w.ctx.tenant_id) as s:
        occs = list(await s.scalars(select(RitualOccurrence)))
        assert [(str(o.id), o.due_at) for o in occs] == [(m["occurrence_id"], due)]
        ritual = await s.get(Ritual, uuid.UUID(ritual_id))
        assert ritual.next_due_at > due
    listed = (await client.get(MEETINGS, headers=w.ctx.as_("viewer"))).json()["upcoming"]
    assert listed[0]["occurrence_id"] == m["occurrence_id"]
    assert listed[0]["meeting_id"] == m["id"]
    assert listed[1]["occurrence_id"] is None and listed[1]["due_at"] > listed[0]["due_at"]
