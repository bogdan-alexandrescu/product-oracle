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
- test_ritual_start_owners_only (role x ritual start): protects=starting from a ritual's
  next review (``ritual_id``) is for owners and the ritual's owner: a PRD's decider who
  does not own the ritual gets 403, no occurrence is made and the ritual's schedule does
  not move; ``can_start`` on the Upcoming row says so; fails_when=any decider uses up
  the ritual's occurrence; no_claim=starts from an occurrence already made.
- test_ritual_start_pins_its_due_time: protects=a ``ritual_id`` start names the row's
  ``due_at``; a second (stale, double-clicked or crossing) start of that row is 409 with
  the first meeting's id, a due time the ritual has moved past is 409, and only one
  occurrence is made; fails_when=a stale start silently makes the next week's occurrence
  and moves the ritual on again; no_claim=the occurrence's pre-read.
- test_upcoming_one_row_per_ritual: protects=Upcoming lists a ritual once (its made
  occurrence, else its next due time) however far ahead (BGD: no horizon), soonest first,
  with the pre-read's readiness; fails_when=a ritual shows twice or a review months away is
  left out; no_claim=the pre-read's contents.
- test_approve_in_meeting_publishes_the_one_pager: protects=a line edited through the
  meeting and the decider's Approve there publish the one-pager (version 2, no working
  draft, the edited line), what the meeting screen reads again after Approve; a
  regression guard of the API (it passed before the walk's fix, which is the web's:
  e2e/simple-meetings-walk.spec.ts); fails_when=Approve leaves the PRD's draft working or
  the page on version 1; no_claim=the meeting screen's refresh, absent reviewers
  (test_simple_meetings_api's approve test).
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
    body = {"prd": PRD, "ritual_id": ritual_id, "due_at": listed[0]["due_at"]}
    r = await client.post(MEETINGS, json=body, headers=w.ctx.as_("commenter"))
    assert r.status_code == 403, r.text
    m = await start(client, w, ritual_id=ritual_id, due_at=listed[0]["due_at"])
    assert m["occurrence_id"] and m["origin"] == "ritual"
    async with tenant_session(w.ctx.tenant_id) as s:
        occs = list(await s.scalars(select(RitualOccurrence)))
        assert [(str(o.id), o.due_at) for o in occs] == [(m["occurrence_id"], due)]
        ritual = await s.get(Ritual, uuid.UUID(ritual_id))
        assert ritual.next_due_at > due
    listed = (await client.get(MEETINGS, headers=w.ctx.as_("viewer"))).json()["upcoming"]
    assert listed[0]["occurrence_id"] == m["occurrence_id"]
    assert listed[0]["meeting_id"] == m["id"]


async def ritual(w, owner: str, days: float = 3) -> tuple[str, datetime]:
    due = (company_time.now() + timedelta(days=days)).replace(microsecond=0)
    async with tenant_session(w.ctx.tenant_id) as s:
        r = Ritual(kind="custom", title=f"Review in {days} days", duration_min=60, prep_hours=2,
                   schedule={"freq": "weekly", "interval": 1, "weekday": 1, "week_of_month": 1,
                             "month": 1, "time": "10:00", "timezone": "UTC"},
                   next_due_at=due, owner_id=w.ctx.users[owner].id)  # fmt: skip
        s.add(r)
        await s.commit()
        return str(r.id), due


async def ritual_state(w, ritual_id: str) -> tuple[datetime, int]:
    async with tenant_session(w.ctx.tenant_id) as s:
        r = await s.get(Ritual, uuid.UUID(ritual_id))
        n = len(list(await s.scalars(select(RitualOccurrence.id))))
        return r.next_due_at, n


async def test_ritual_start_owners_only(client):
    w = await world()
    ritual_id, due = await ritual(w, owner="approver")
    for who, can in [("owner", True), ("decider", False), ("approver", True), ("viewer", False)]:
        row = (await client.get(MEETINGS, headers=w.ctx.as_(who))).json()["upcoming"][0]
        assert row["can_start"] is can, who
    body = {"prd": PRD, "ritual_id": ritual_id, "due_at": due.isoformat()}
    r = await client.post(MEETINGS, json=body, headers=w.ctx.as_("decider"))
    assert r.status_code == 403, r.text
    assert await ritual_state(w, ritual_id) == (due, 0)
    m = await start(client, w, "owner", ritual_id=ritual_id, due_at=due.isoformat())
    assert m["occurrence_id"]
    next_due, n = await ritual_state(w, ritual_id)
    assert next_due > due and n == 1


async def test_ritual_start_pins_its_due_time(client):
    w = await world()
    ritual_id, due = await ritual(w, owner="decider")
    r = await client.post(MEETINGS, json={"prd": PRD, "ritual_id": ritual_id},
                          headers=w.ctx.as_("decider"))  # fmt: skip
    assert r.status_code == 422, r.text
    first = await start(client, w, ritual_id=ritual_id, due_at=due.isoformat())
    moved, _ = await ritual_state(w, ritual_id)
    # Bob's stale row (the same due time) and a double click: the first meeting, no new week.
    for who in ("decider", "owner"):
        r = await client.post(MEETINGS, json={"prd": PRD, "ritual_id": ritual_id,
                                              "due_at": due.isoformat()},
                              headers=w.ctx.as_(who))  # fmt: skip
        assert r.status_code == 409, r.text
        assert r.json()["detail"]["meeting_id"] == first["id"]
    # A due time the ritual never had (or has moved past without an occurrence): 409.
    r = await client.post(MEETINGS, json={"prd": PRD, "ritual_id": ritual_id,
                                          "due_at": (due - timedelta(days=7)).isoformat()},
                          headers=w.ctx.as_("decider"))  # fmt: skip
    assert r.status_code == 409, r.text
    assert await ritual_state(w, ritual_id) == (moved, 1)


async def test_upcoming_one_row_per_ritual(client):
    w = await world()
    ritual_id, due = await ritual(w, owner="decider")
    far_id, _ = await ritual(w, owner="decider", days=60)  # no horizon: listed, after the soon one
    listed = (await client.get(MEETINGS, headers=w.ctx.as_("viewer"))).json()["upcoming"]
    assert [x["ritual_id"] for x in listed] == [ritual_id, far_id]
    assert listed[0]["pre_read_ready"] is False
    m = await start(client, w, ritual_id=ritual_id, due_at=due.isoformat())
    async with tenant_session(w.ctx.tenant_id) as s:
        occ = await s.get(RitualOccurrence, uuid.UUID(m["occurrence_id"]))
        occ.status = "ready"
        await s.commit()
    listed = (await client.get(MEETINGS, headers=w.ctx.as_("viewer"))).json()["upcoming"]
    assert [(x["ritual_id"], x["occurrence_id"]) for x in listed] == [
        (ritual_id, m["occurrence_id"]),
        (far_id, None),
    ]
    assert listed[0]["meeting_id"] == m["id"] and listed[0]["pre_read_ready"] is True


async def test_approve_in_meeting_publishes_the_one_pager(client):
    from tests import test_simple_one_pager_api as op

    ctx = await op.world(client)
    r = await client.post(MEETINGS, json={"prd": "guided-setup", "title": "Setup review"},
                          headers=ctx.as_("decider"))  # fmt: skip
    assert r.status_code == 201, r.text
    m = r.json()
    view = await op.get(client, ctx, "decider")
    assert view["version"] == 1
    r = await client.post("/v1/simple/changes", json={
        "op": "edit_line", "session_id": m["session_id"],
        "target": {"document_id": view["document"]["id"], "line_id": "bets-1"},
        "before": {"line": op.line(view, "bets-1")["text"]},
        "after": {"line": "A checklist with two steps"},
    }, headers=ctx.as_("decider"))  # fmt: skip
    assert r.status_code == 201, r.text
    mine = await op.get(client, ctx, "decider")
    assert mine["draft"] and mine["draft"]["changes"] == 1
    r = await client.post(f"{MEETINGS}/{m['id']}/approve", headers=ctx.as_("decider"))
    assert r.status_code == 200, r.text
    assert r.json()["not_approved"] == [], r.json()["not_approved"]
    after = await op.get(client, ctx, "decider")
    assert after["version"] == 2 and after["draft"] is None, (after["version"], after["draft"])
    assert op.line(after, "bets-1")["text"] == "A checklist with two steps"
