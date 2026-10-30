"""Simple Definition of Done, item 5 (docs/simple-dod-ops.md, Part 2 sections 4-7), column
(a): each Simple write outside the change engine's own ops records WHO acted and WHEN.
Against Postgres. Each test acts over REST as a person would, then reads back the stored
actor and time: the domain row's own fields (``submitted_by``/``submitted_at``,
``decider_approval``, ``decided_by``/``decided_at``, ``requested_by``, ``author_id``,
``proposed_by``, a change's ``by``/``at``) and the audit event (``actor``). Times the code
takes from the company clock must equal the test's frozen clock, moved before each step so
each op is shown to stamp its own moment; times the database stamps (``created_at``) must
fall within the request.

Test cards (protects / fails_when / no_claim):

- test_draft_ops_record_who_and_when: protects=(section 4) resume names the decider and the
  moment on the new session (started_by/started_at) and in a simple_draft.resumed event;
  submit sets submitted_by/submitted_at; withdraw stamps the withdrawn version's note with
  the moment and a simple_draft.withdrawn event names who; the decider's approve stores
  decider_approval by/at, the required reviewer's approve is a simple_draft.approval event
  naming them and the draft's approved_at is that moment; fails_when=an op stores another
  actor or time, or none; no_claim=the review policy itself (test_simple_drafts_api,
  test_simple_review_fixes).
- test_visual_ops_record_who_and_when: protects=(section 5) a request names its asker on
  the visual (requested_by, updated_at now) and its job, with an llm_job.queue event; a
  comment stores its author and its time and a simple_visual.comment event; a revise
  queues a job naming who revised, with a simple_visual.revise event; fails_when=a visual
  write is anonymous or stamped with another time; no_claim=the drawing (test_simple_visuals_api).
- test_date_suggestion_ops_record_who_and_when: protects=(section 6) accept and edit are
  accept_date_suggestion changes with the decider's by/at, and the suggestion's
  decided_by/decided_at are the decider and that moment; an approver's accept is a
  proposal with its by/at; dismiss sets decided_by/decided_at and a
  roadmap_date_suggestion.dismiss event; fails_when=any of these records another actor or
  time, or none; no_claim=refresh (structurally actor-less, noted in the doc).
- test_goal_suggestion_ops_record_who_and_when: protects=(section 7) "Suggest features"
  queues a job naming the commenter who asked with a simple_goal.suggest event; a person's
  suggestion names its proposer and its time with a simple_goal_suggestion.suggested
  event; accept is an add_item change with the decider's by/at and sets the suggestion's
  decided_by/decided_at; reject sets decided_by/decided_at and a
  simple_goal_suggestion.rejected event; fails_when=any write records another actor or
  time, or none; no_claim=who may act (test_simple_additions_api).
"""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from oracle import company_time
from oracle.docs.models import DocumentVersion
from oracle.jobs.models import LlmJob
from oracle.models import AuditEvent
from oracle.simple import changes as simple_changes
from oracle.simple.models import (
    RoadmapDateSuggestion,
    SimpleChange,
    SimpleDraft,
    SimpleGoalSuggestion,
    SimpleSession,
    SimpleVisual,
    SimpleVisualComment,
)
from oracle.tenancy import tenant_session
from tests.test_simple_additions_api import GOALS, _seed_suggestions
from tests.test_simple_additions_api import SUGGESTIONS as GOAL_SUGGESTIONS
from tests.test_simple_additions_api import World as AddWorld
from tests.test_simple_changes_api import World as ChangeWorld
from tests.test_simple_changes_api import make_people
from tests.test_simple_drafts_api import DRAFTS, edit_title, the_draft
from tests.test_simple_drafts_api import world as draft_world
from tests.test_simple_roadmap_api import NOW, SUGGESTIONS
from tests.test_simple_visuals_api import URL as VISUALS
from tests.test_simple_visuals_api import roadmap_world, run_visual_jobs
from tests.test_simple_visuals_api import world as visual_world

SLACK = timedelta(seconds=5)


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    moment = {"now": NOW}
    monkeypatch.setattr(company_time, "now", lambda: moment["now"])
    return moment


def wall() -> datetime:
    return datetime.now(UTC)


def uid(ctx, who: str) -> uuid.UUID:
    return ctx.users[who].id


async def mark(ctx) -> tuple[set[uuid.UUID], datetime]:
    """The audit events so far and the wall clock, taken before a request."""
    async with tenant_session(ctx.tenant_id) as s:
        return set(await s.scalars(select(AuditEvent.id))), wall()


async def audited(ctx, action: str, entity_id, who: str, since) -> AuditEvent:
    """The one audit event of ``action`` on ``entity_id`` the request made: it names
    ``who`` and its (database) time is within the request."""
    seen, t0 = since
    async with tenant_session(ctx.tenant_id) as s:
        rows = list(
            await s.scalars(
                select(AuditEvent).where(
                    AuditEvent.action == action,
                    AuditEvent.entity_id == uuid.UUID(str(entity_id)),
                    AuditEvent.id.not_in(seen),
                )
            )
        )
    assert len(rows) == 1, (action, [(e.actor, e.created_at) for e in rows])
    [e] = rows
    assert e.actor == f"user:{uid(ctx, who)}", (action, e.actor)
    assert t0 - SLACK <= e.created_at <= wall() + SLACK, action
    return e


async def change_recorded(ctx, change: dict, who: str, op: str, at: datetime) -> None:
    assert change["op"] == op
    assert change["by"] == str(uid(ctx, who)), op
    assert datetime.fromisoformat(change["at"]) == at, op
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(SimpleChange, uuid.UUID(change["id"]))
        assert (row.op, row.by, row.at) == (op, uid(ctx, who), at), op


# --------------------------------------------------------------------------- 4. drafts


async def test_draft_ops_record_who_and_when(client, clock):
    w = await draft_world(reviewers=("approver",))
    ctx = w.ctx
    assert (await edit_title(client, w, "decider")).status_code == 201
    d = await the_draft(client, w)
    url = f"{DRAFTS}/{d['id']}"

    # resume: the idle session closes; the decider resumes into a new session.
    t1 = NOW + timedelta(minutes=31)
    clock["now"] = t1
    async with tenant_session(ctx.tenant_id) as s:
        assert await simple_changes.close_idle(s) == 1
        await s.commit()
    since = await mark(ctx)
    r = await client.post(f"{url}/resume", headers=ctx.as_("decider"))
    assert r.status_code == 200, r.text
    sid = uuid.UUID(r.json()["session"]["id"])
    async with tenant_session(ctx.tenant_id) as s:
        session = await s.get(SimpleSession, sid)
        assert (session.started_by, session.started_at) == (uid(ctx, "decider"), t1)
    e = await audited(ctx, "simple_draft.resumed", d["id"], "decider", since)
    assert e.data["session_id"] == str(sid)

    # submit
    t2 = t1 + timedelta(minutes=5)
    clock["now"] = t2
    since = await mark(ctx)
    r = await client.post(f"{url}/submit", headers=ctx.as_("decider"))
    assert r.status_code == 200, r.text
    assert r.json()["submitted_by"] == str(uid(ctx, "decider"))
    assert datetime.fromisoformat(r.json()["submitted_at"]) == t2
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(SimpleDraft, uuid.UUID(d["id"]))
        assert (row.submitted_by, row.submitted_at) == (uid(ctx, "decider"), t2)
    await audited(ctx, "simple_draft.submitted", d["id"], "decider", since)

    # withdraw: who in the audit event, when on the withdrawn version's note.
    t3 = t2 + timedelta(minutes=5)
    clock["now"] = t3
    since = await mark(ctx)
    r = await client.post(f"{url}/withdraw", headers=ctx.as_("decider"))
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "working"
    await audited(ctx, "simple_draft.withdrawn", d["id"], "decider", since)
    async with tenant_session(ctx.tenant_id) as s:
        v2 = await s.scalar(select(DocumentVersion).where(DocumentVersion.number == 2))
        [note] = [n for n in v2.notes if n.get("draft_id") == d["id"]]
        assert datetime.fromisoformat(note["at"]) == t3

    # approve: the decider's approval, then the required reviewer's, which publishes. The
    # draft changes once more first: resubmitting it unchanged lands on the withdrawn
    # version 2 (the import finds its content), which is never approved.
    clock["now"] = t3 + timedelta(minutes=5)
    r = await edit_title(client, w, "decider", "Ledger v3", before={"title": "Ledger v2"},
                         session_id=str(sid))  # fmt: skip
    assert r.status_code == 201, r.text
    r = await client.post(f"{url}/submit", headers=ctx.as_("decider"))
    assert r.status_code == 200, r.text
    t5 = t3 + timedelta(minutes=10)
    clock["now"] = t5
    since = await mark(ctx)
    r = await client.post(f"{url}/approve", headers=ctx.as_("decider"))
    assert r.status_code == 200 and r.json()["decider_approved"], r.text
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(SimpleDraft, uuid.UUID(d["id"]))
        assert row.decider_approval["by"] == str(uid(ctx, "decider"))
        assert datetime.fromisoformat(row.decider_approval["at"]) == t5
    await audited(ctx, "simple_draft.approval", d["id"], "decider", since)
    t6 = t5 + timedelta(minutes=5)
    clock["now"] = t6
    since = await mark(ctx)
    r = await client.post(f"{url}/approve", headers=ctx.as_("approver"))
    assert r.status_code == 200 and r.json()["status"] == "approved", r.text
    assert datetime.fromisoformat(r.json()["approved_at"]) == t6
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(SimpleDraft, uuid.UUID(d["id"]))
        assert (row.status, row.approved_at) == ("approved", t6)
    await audited(ctx, "simple_draft.approval", d["id"], "approver", since)


# --------------------------------------------------------------------------- 5. visuals


async def test_visual_ops_record_who_and_when(client, clock):
    ctx = await visual_world(client)
    _, item = await roadmap_world(ctx)
    path = f"{VISUALS}/feature/{item.id}"

    # request: the owner asks Oracle to draw the feature.
    t1 = NOW + timedelta(minutes=1)
    clock["now"] = t1
    since = await mark(ctx)
    r = await client.post(f"{path}/request", json={"brief": "The checklist"},
                          headers=ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 202, r.text
    async with tenant_session(ctx.tenant_id) as s:
        v = await s.scalar(select(SimpleVisual).where(SimpleVisual.subject_id == item.id))
        assert (v.requested_by, v.updated_at) == (uid(ctx, "owner"), t1)
        [job] = list(await s.scalars(select(LlmJob).where(LlmJob.visual_id == v.id)))
        assert job.requested_by == uid(ctx, "owner")
        assert since[1] - SLACK <= job.created_at <= wall() + SLACK
        vid = v.id
    await audited(ctx, "llm_job.queue", job.id, "owner", since)
    await run_visual_jobs(ctx)

    # comment: a commenter's note on the drawing.
    since = await mark(ctx)
    r = await client.post(f"{path}/comments", json={"body": "Show the skip path"},
                          headers=ctx.as_("commenter"))  # fmt: skip
    assert r.status_code == 201, r.text
    async with tenant_session(ctx.tenant_id) as s:
        [c] = list(await s.scalars(select(SimpleVisualComment)))
        assert c.author_id == uid(ctx, "commenter")
        assert since[1] - SLACK <= c.created_at <= wall() + SLACK
    await audited(ctx, "simple_visual.comment", vid, "commenter", since)

    # revise: the owner has Oracle redraw it from the comment.
    since = await mark(ctx)
    r = await client.post(f"{path}/revise", json={"note": "Keep it short"},
                          headers=ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 202, r.text
    async with tenant_session(ctx.tenant_id) as s:
        job = await s.scalar(
            select(LlmJob).where(LlmJob.visual_id == vid, LlmJob.status == "queued")
        )
        assert job.input["mode"] == "revise" and job.requested_by == uid(ctx, "owner")
        assert since[1] - SLACK <= job.created_at <= wall() + SLACK
    e = await audited(ctx, "simple_visual.revise", vid, "owner", since)
    assert e.data["job_id"] == str(job.id)


# --------------------------------------------------------------------------- 6. date suggestions


async def decided(ctx, sid: str, status: str, who: str, at: datetime) -> None:
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(RoadmapDateSuggestion, uuid.UUID(sid))
        assert (row.status, row.decided_by, row.decided_at) == (status, uid(ctx, who), at)


async def test_date_suggestion_ops_record_who_and_when(client, clock):
    ctx = await make_people()
    w = await ChangeWorld(ctx).build(decider=True, ops=["move_dates", "edit_title", "edit_text"])
    a, b, c = (w.suggestion[f"{op}-u"] for op in ("move_dates", "edit_title", "edit_text"))

    # An approver's accept is a proposal: recorded, the suggestion stays open.
    t0 = NOW + timedelta(minutes=1)
    clock["now"] = t0
    r = await client.post(f"{SUGGESTIONS}/{a}/accept", headers=ctx.as_("approver"))
    assert r.status_code == 200, r.text
    assert r.json()["change"]["status"] == "proposed"
    await change_recorded(ctx, r.json()["change"], "approver", "accept_date_suggestion", t0)

    # accept by the decider.
    t1 = NOW + timedelta(minutes=2)
    clock["now"] = t1
    r = await client.post(f"{SUGGESTIONS}/{a}/accept", headers=ctx.as_("decider"))
    assert r.status_code == 200, r.text
    assert r.json()["change"]["status"] == "applied"
    await change_recorded(ctx, r.json()["change"], "decider", "accept_date_suggestion", t1)
    await decided(ctx, a, "accepted", "decider", t1)

    # edit by the decider.
    t2 = NOW + timedelta(minutes=3)
    clock["now"] = t2
    r = await client.post(f"{SUGGESTIONS}/{b}/edit", headers=ctx.as_("decider"),
                          json={"start_date": "2026-11-02", "end_date": "2026-11-30"})  # fmt: skip
    assert r.status_code == 200, r.text
    await change_recorded(ctx, r.json()["change"], "decider", "accept_date_suggestion", t2)
    await decided(ctx, b, "edited", "decider", t2)

    # dismiss by the decider.
    t3 = NOW + timedelta(minutes=4)
    clock["now"] = t3
    since = await mark(ctx)
    r = await client.post(f"{SUGGESTIONS}/{c}/dismiss", headers=ctx.as_("decider"))
    assert r.status_code == 200 and r.json()["status"] == "dismissed", r.text
    await decided(ctx, c, "dismissed", "decider", t3)
    await audited(ctx, "roadmap_date_suggestion.dismiss", c, "decider", since)


# --------------------------------------------------------------------------- 7. goal suggestions


async def test_goal_suggestion_ops_record_who_and_when(client, clock):
    w = await AddWorld().build()
    ctx = w.ctx
    quiet = w.goals["quiet"]

    # suggest: a commenter asks Oracle for suggestions on the empty goal.
    since = await mark(ctx)
    r = await client.post(f"{GOALS}/{quiet}/suggest", headers=ctx.as_("commenter"))
    assert r.status_code in (200, 202), r.text
    job_id = r.json()["job_id"]
    async with tenant_session(ctx.tenant_id) as s:
        job = await s.get(LlmJob, uuid.UUID(job_id))
        assert job.kind == "goal_suggestions" and job.requested_by == uid(ctx, "commenter")
        assert since[1] - SLACK <= job.created_at <= wall() + SLACK
    e = await audited(ctx, "simple_goal.suggest", quiet, "commenter", since)
    assert e.data["job_id"] == job_id

    # create (file_suggestion): an approver files one.
    since = await mark(ctx)
    body = {"title": "Quiet hours", "outcome": "Fewer alerts at night"}
    r = await client.post(f"{GOALS}/{quiet}/suggestions", headers=ctx.as_("approver"), json=body)
    assert r.status_code == 201, r.text
    filed = r.json()
    assert filed["proposed_by_name"] == "Approver"
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(SimpleGoalSuggestion, uuid.UUID(filed["id"]))
        assert row.proposed_by == uid(ctx, "approver")
        assert since[1] - SLACK <= row.created_at <= wall() + SLACK
    await audited(ctx, "simple_goal_suggestion.suggested", filed["id"], "approver", since)

    # accept: the decider accepts the filed suggestion (an add_item).
    t1 = NOW + timedelta(minutes=1)
    clock["now"] = t1
    r = await client.post(f"{GOAL_SUGGESTIONS}/{filed['id']}/accept",
                          headers=ctx.as_("decider"), json={})  # fmt: skip
    assert r.status_code == 200, r.text
    change = r.json()["change"]
    assert change["status"] == "applied"
    await change_recorded(ctx, change, "decider", "add_item", t1)
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(SimpleGoalSuggestion, uuid.UUID(filed["id"]))
        assert (row.status, row.decided_by, row.decided_at) == (
            "accepted", uid(ctx, "decider"), t1,
        )  # fmt: skip

    # reject: the decider rejects one of Oracle's.
    [other] = await _seed_suggestions(w, 1)
    t2 = NOW + timedelta(minutes=2)
    clock["now"] = t2
    since = await mark(ctx)
    r = await client.post(f"{GOAL_SUGGESTIONS}/{other}/reject", headers=ctx.as_("decider"),
                          json={"reason": "Not this year"})  # fmt: skip
    assert r.status_code == 200 and r.json()["status"] == "rejected", r.text
    assert datetime.fromisoformat(r.json()["decided_at"]) == t2
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(SimpleGoalSuggestion, uuid.UUID(other))
        assert (row.decided_by, row.decided_at) == (uid(ctx, "decider"), t2)
    await audited(ctx, "simple_goal_suggestion.rejected", other, "decider", since)
