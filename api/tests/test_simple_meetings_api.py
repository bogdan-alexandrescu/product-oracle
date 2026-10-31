"""Simple S8 (#723): review meetings and the Decisions page (``/v1/simple/meetings``,
``/v1/simple/decisions``, oracle.simple.meetings). Against Postgres.

Each test seeds S3b's world (tests.test_simple_drafts_api: one roadmap "payments" whose
items are of the PRD "payments-prd", a decider of the roadmap and, here, of the PRD; the
four roles plus ``decider`` and a second approver ``reviewer2``) and acts over REST as a
person would. The minutes job runs with a fake ``ask`` (never a live model).

Test cards (protects / fails_when / no_claim):

- test_start_permissions (role x start): protects=only an owner or the PRD's decider starts
  a meeting (201: a live meeting, a titled ``meeting`` session, default attendees the
  decider, reviewers and the starter); approver and commenter get 403, a viewer 403; the
  start sheet says who may start (``can_start``, ``starters``) and others may join;
  fails_when=anyone else starts one or the sheet hides who starts it; no_claim=the sheet.
- test_every_action_is_a_meeting_decision: protects=a change through the meeting's
  session (applied by the decider, proposed by a commenter), an accept and a decline with
  the meeting's session, and an undo each become a ``decisions`` row (origin
  ``meeting``, approver who decided, subjects the item and the PRD) listed newest first
  on the meeting; a comment (qa-simple-decide-1) is a note, not a decision, and does not
  appear there; the change is marked made in the meeting; with the change mode
  "presenter" a commenter's change through it is 403 and "named" lets the named person
  in; ``meeting_rules`` and ``record_meeting_decision`` (the contract) answer as named;
  fails_when=an action is not recorded, is recorded with the wrong approver, or the mode
  is ignored; no_claim=the chat (S9).
- test_approve_absent_reviewer_then_publish: protects=the decider's Approve in the meeting
  approves for the present required reviewer, holds the draft for the absent one, who
  alone gets an Inbox request; the version publishes only when they approve; the approval
  is a meeting decision and the roadmap item links to it (``decided_in``); approver and
  commenter may not approve (403); fails_when=it publishes early, asks the present
  reviewer, or never publishes; no_claim=PRD drafts (same path, S5's tests).
- test_end_and_minutes_job: protects=ending writes Oracle's quick minutes at once (a short
  prose count of decisions, notes and open questions, qa-simple-decide-6; what waits on
  whom) and queues the ``meeting_minutes`` job;
  its answer (fake) replaces them, held to the meeting's record (an item nobody said is
  dropped, test_simple_minutes_record has the rest); a person's edit wins over
  a later answer; only the presenter, decider or an owner ends; a change through an
  ended meeting is refused; fails_when=no minutes, the job overwrites an edit, or anyone
  ends it; no_claim=the prompt's wording.
- test_delivery_choices: protects=sending always posts to the Decisions page and each
  attendee's Inbox (``simple_minutes``); email is optional: "unavailable" without a mailer,
  else queued and sent to each attendee through Oracle's mailer (a fake); Slack is 422
  while not connected and, connected, queues one channel post; action items go through
  the change engine with the meeting's id; sending twice is 409; fails_when=a choice is
  ignored, Slack is used while not connected, or minutes skip the Inbox; no_claim=Slack's
  API (oracle.slack.outbox's tests).
- test_decisions_page_grouping_and_filters: protects=the page groups a meeting's
  decisions under it with its minutes, keeps decisions outside meetings apart, filters
  by PRD, goal and meeting (an unknown one is 404); a meeting_option's title carries its
  day (qa-simple-decide-11); fails_when=a decision lands in the wrong group or a filter
  leaks; no_claim=Detailed's decision log.
- test_an_open_decision_named_in_minutes_is_not_listed_twice: protects=an open decision
  the shown meeting's minutes name as an open question ("D-<n>: ...") is left out of the
  decisions outside meetings, and is listed there again once decided; fails_when=it shows
  twice (under the meeting's open questions and in "other") or never comes back;
  no_claim=the minutes' wording.
- test_meeting_option_title_carries_the_day_and_live (qa-simple-decide-11): protects=a
  live meeting's option title ends " · live", an ended one's does not; fails_when=the
  suffix is missing or shown once ended; no_claim=the web's filter control.
"""

import datetime as dt
import uuid
from datetime import timedelta

import pytest
from sqlalchemy import select

from oracle import company_time
from oracle.auth.models import User
from oracle.decisions.models import Decision
from oracle.jobs.models import LlmJob
from oracle.review.models import DocumentReviewPolicy
from oracle.simple import meetings
from oracle.simple.models import SimpleChange, SimpleMeeting
from oracle.simple.schemas import SimpleSlackState
from oracle.slack.models import SlackOutbox
from oracle.tenancy import tenant_session
from tests.test_simple_changes_api import CHANGES, World, make_people
from tests.test_simple_changes_api import clock as clock  # noqa: F401
from tests.test_simple_drafts_api import DRAFTS, inbox, roadmap, title_in

MEETINGS = "/v1/simple/meetings"
PRD = "payments-prd"


OPS = ["edit_title", "move_dates", "change_horizon", "cut", "reorder"]


async def world(*, reviewers: tuple[str, ...] = ()) -> World:
    ctx = await make_people()
    async with tenant_session(ctx.tenant_id) as s:
        user = User(email="reviewer2@example.com", name="Rae Viewer", password_hash="x",
                    role="approver")  # fmt: skip
        s.add(user)
        await s.commit()
        ctx.users["reviewer2"] = user
    w = await World(ctx).build(decider=True, ops=OPS)
    async with tenant_session(w.ctx.tenant_id) as s:
        if reviewers:
            p = await s.scalar(select(DocumentReviewPolicy))
            p.mandatory_reviewer_ids = [ctx.users[r].id for r in reviewers]
        from oracle.docs.models import Document

        prd = await s.scalar(select(Document).where(Document.slug == PRD))
        s.add(DocumentReviewPolicy(document_id=prd.id, decider_id=w.ctx.users["decider"].id,
                                   mandatory_reviewer_ids=[w.ctx.users[r].id
                                                           for r in reviewers]))  # fmt: skip
        await s.commit()
    return w


def uid(w: World, who: str) -> str:
    return str(w.ctx.users[who].id)


async def start(client, w: World, who: str = "decider", **over) -> dict:
    body = {"prd": PRD, "title": "Payments review",
            "attendee_ids": [uid(w, x) for x in ("approver", "commenter")], **over}  # fmt: skip
    r = await client.post(MEETINGS, json=body, headers=w.ctx.as_(who))
    assert r.status_code == 201, r.text
    return r.json()


async def get(client, w: World, mid: str, who: str = "decider") -> dict:
    r = await client.get(f"{MEETINGS}/{mid}", headers=w.ctx.as_(who))
    assert r.status_code == 200, r.text
    return r.json()


async def edit_title(client, w: World, who: str, sid: str, title="Ledger v2", before=None):
    return await w.post(client, who, "edit_title", session_id=sid, after={"title": title},
                        **({"before": {"title": before}} if before else {}))  # fmt: skip


async def meeting_decisions(w: World) -> list[Decision]:
    async with tenant_session(w.ctx.tenant_id) as s:
        return list(
            await s.scalars(
                select(Decision).where(Decision.origin == "meeting").order_by(Decision.number)
            )
        )


@pytest.mark.parametrize(
    ("who", "code"),
    [("owner", 201), ("decider", 201), ("approver", 403), ("commenter", 403), ("viewer", 403)],
)
async def test_start_permissions(client, who, code):
    w = await world(reviewers=("reviewer2",))
    r = await client.get(f"{MEETINGS}/options", params={"prd": PRD}, headers=w.ctx.as_(who))
    assert r.status_code == 200, r.text
    [p] = r.json()["prds"]
    assert p["can_start"] is (code == 201)
    starters = {x["id"] for x in p["starters"]}
    assert {uid(w, "decider"), uid(w, "owner")} <= starters
    assert {uid(w, "decider"), uid(w, "reviewer2")} <= set(p["default_attendee_ids"])
    r = await client.post(MEETINGS, json={"prd": PRD}, headers=w.ctx.as_(who))
    assert r.status_code == code, r.text
    if code != 201:
        assert (await client.get(MEETINGS, headers=w.ctx.as_(who))).json()["live"] == []
        return
    m = r.json()
    assert m["status"] == "live" and m["title"] == "Review: Payments Prd"
    assert m["presenter"]["id"] == uid(w, who) and m["length_min"] == 60
    assert m["change_mode"] == "everyone" and m["can"]["end"] and m["can"]["set_rules"]
    async with tenant_session(w.ctx.tenant_id) as s:
        row = await s.get(SimpleMeeting, uuid.UUID(m["id"]))
        session = await s.get(meetings.SimpleSession, row.session_id)
        assert session.kind == "meeting" and session.started_by == w.ctx.users[who].id
    # Anyone who reads the PRD sees it live and joins.
    live = (await client.get(MEETINGS, headers=w.ctx.as_("commenter"))).json()["live"]
    assert [x["id"] for x in live] == [m["id"]]
    r = await client.post(f"{MEETINGS}/{m['id']}/join", headers=w.ctx.as_("commenter"))
    assert r.status_code == 200 and uid(w, "commenter") in [a["id"] for a in r.json()["attendees"]]


async def test_every_action_is_a_meeting_decision(client):
    w = await world()
    m = await start(client, w)
    sid = m["session_id"]
    # The decider's change applies through the meeting.
    r = await edit_title(client, w, "decider", sid)
    assert r.status_code == 201, r.text
    applied = r.json()["change"]
    # A commenter's (an attendee, mode everyone) is a proposal made in the meeting.
    r = await w.post(client, "commenter", "change_horizon", session_id=sid)
    assert r.status_code == 201 and r.json()["change"]["status"] == "proposed", r.text
    proposal = r.json()["change"]
    r = await client.post(f"{CHANGES}/{proposal['id']}/accept", json={"session_id": sid},
                          headers=w.ctx.as_("decider"))  # fmt: skip
    assert r.status_code == 200, r.text
    r = await w.post(client, "commenter", "cut", session_id=sid)
    declined = r.json()["change"]
    r = await client.post(f"{CHANGES}/{declined['id']}/decline", json={"session_id": sid},
                          headers=w.ctx.as_("decider"))  # fmt: skip
    assert r.status_code == 200, r.text
    r = await client.post(f"{CHANGES}/{applied['id']}/undo", headers=w.ctx.as_("decider"))
    assert r.status_code == 201, r.text
    # qa-simple-decide-1: a comment is a note, not a meeting decision.
    r = await client.post(f"{MEETINGS}/{m['id']}/comments", json={"text": "Keep the beta"},
                          headers=w.ctx.as_("approver"))  # fmt: skip
    assert r.status_code == 201, r.text
    comment_out = r.json()
    assert [n["text"] for n in comment_out["notes"] if n["kind"] == "comment"] == ["Keep the beta"]
    rows = await meeting_decisions(w)
    titles = [d.title for d in rows]
    # qa4-simple-decide-12: a move says where to; an accepted or declined proposal says whose.
    who = w.ctx.users["commenter"].name
    assert titles == [
        "Renamed Edit_Title A",
        "Proposed: Moved Change_Horizon A to Next",
        f"Accepted {who}'s proposal: Moved Change_Horizon A to Next",
        "Proposed: Cut Cut A",
        f"Declined {who}'s proposal: Cut Cut A",
        "Undone: Renamed Edit_Title A",
    ]
    assert "Comment: Keep the beta" not in titles
    first = rows[0]
    assert first.status == "decided" and first.approver_id == w.ctx.users["decider"].id
    assert {"kind": "roadmap_item", "id": w.ids["edit_title-a"], "ref": "edit_title-a"} in (
        first.subjects
    )
    out = await get(client, w, m["id"])
    assert [d["title"] for d in out["meeting_decisions"]] == list(reversed(titles))
    assert out["decisions"] == len(titles)
    [comment_note] = [n for n in out["notes"] if n["kind"] == "comment"]
    assert (comment_note["text"] == "Keep the beta"
            and comment_note["by_name"] == "approver@example.com")  # fmt: skip
    assert comment_note["at"] is not None
    # The draft marks the change as made in the meeting.
    [d] = (await client.get(DRAFTS, headers=w.ctx.as_("decider"))).json()
    assert d["change_log"] and all(c["in_meeting"] for c in d["change_log"])
    # The presenter's change mode: only the presenter, then the presenter plus one.
    r = await client.patch(f"{MEETINGS}/{m['id']}/rules", json={"change_mode": "presenter"},
                           headers=w.ctx.as_("commenter"))  # fmt: skip
    assert r.status_code == 403
    r = await client.patch(f"{MEETINGS}/{m['id']}/rules", json={"change_mode": "presenter"},
                           headers=w.ctx.as_("decider"))  # fmt: skip
    assert r.status_code == 200 and r.json()["can"]["change"], r.text
    r = await w.post(client, "commenter", "reorder", session_id=sid, before={"position": 12})
    assert r.status_code == 403, r.text
    assert not (await get(client, w, m["id"], "commenter"))["can"]["change"]
    r = await client.patch(
        f"{MEETINGS}/{m['id']}/rules",
        json={"change_mode": "named", "change_people": [uid(w, "commenter")]},
        headers=w.ctx.as_("decider"),
    )
    assert r.status_code == 200, r.text
    r = await w.post(client, "commenter", "reorder", session_id=sid, before={"position": 12})
    assert r.status_code == 201, r.text
    r = await w.post(client, "approver", "move_dates", session_id=sid)
    assert r.status_code == 403, r.text
    # The contract.
    async with tenant_session(w.ctx.tenant_id) as s:
        rules = await meetings.meeting_rules(s, uuid.UUID(m["id"]))
        assert rules.change_mode == "named" and rules.change_people == [w.ctx.users["commenter"].id]
        assert rules.presenter_id == w.ctx.users["decider"].id and not rules.ended
        assert rules.may_change(w.ctx.users["commenter"].id)
        assert not rules.may_change(w.ctx.users["approver"].id)
        assert await meetings.meeting_rules(s, uuid.uuid4()) is None
        from oracle.simple.drafts import principal_for

        p = await principal_for(s, w.ctx.tenant_id, w.ctx.users["approver"].id)
        did = await meetings.record_meeting_decision(
            s, p, uuid.UUID(m["id"]), "Ship the beta",
            [{"kind": "document", "id": str(uuid.uuid4())}],
            [uuid.UUID(applied["id"])],
        )  # fmt: skip
        await s.commit()
        d = await s.get(Decision, did)
        assert d.origin == "meeting" and d.approver_id == w.ctx.users["approver"].id


async def test_approve_absent_reviewer_then_publish(client):
    w = await world(reviewers=("approver", "reviewer2"))
    # The roadmap names the same required reviewers (its draft's review policy).
    m = await start(client, w, attendee_ids=[uid(w, "approver"), uid(w, "reviewer2")])
    r = await client.patch(f"{MEETINGS}/{m['id']}/rules",
                           json={"absent_ids": [uid(w, "reviewer2")]},
                           headers=w.ctx.as_("decider"))  # fmt: skip
    assert r.status_code == 200, r.text
    assert [a["present"] for a in r.json()["attendees"] if a["id"] == uid(w, "reviewer2")] == [
        False
    ]
    assert (await edit_title(client, w, "decider", m["session_id"])).status_code == 201
    for who in ("approver", "commenter"):
        r = await client.post(f"{MEETINGS}/{m['id']}/approve", headers=w.ctx.as_(who))
        assert r.status_code == 403, (who, r.text)
    r = await client.post(f"{MEETINGS}/{m['id']}/approve", headers=w.ctx.as_("decider"))
    assert r.status_code == 200, r.text
    [d] = r.json()["drafts"]
    assert d["status"] == "submitted" and d["waiting_on"] == [uid(w, "reviewer2")]
    assert title_in(await roadmap(client, w, "viewer"), "edit_title-a") != "Ledger v2"
    assert (await inbox(client, w, "approver"))["simple_approvals"] == []
    [row] = (await inbox(client, w, "reviewer2"))["simple_approvals"]
    assert row["draft_id"] == d["id"] and row["decider_approved"]
    approval = (await meeting_decisions(w))[-1]
    assert approval.title == (
        "Approved Plan changes (not yet published: Waiting on Rae Viewer's approval)"
    )
    r = await client.post(f"{DRAFTS}/{d['id']}/approve", headers=w.ctx.as_("reviewer2"))
    assert r.status_code == 200 and r.json()["status"] == "approved", r.text
    view = await roadmap(client, w, "viewer")
    assert title_in(view, "edit_title-a") == "Ledger v2"
    item = next(i for i in view["items"] if i["key"] == "edit_title-a")
    assert "Renamed Edit_Title A" in [x["title"] for x in item["decided_in"]]


class FakeMailer:
    def __init__(self) -> None:
        self.sent: list = []

    async def send(self, http, message) -> None:
        self.sent.append(message)


async def end(client, w: World, mid: str, who: str = "decider") -> dict:
    r = await client.post(f"{MEETINGS}/{mid}/end", headers=w.ctx.as_(who))
    assert r.status_code == 200, r.text
    return r.json()


async def test_end_and_minutes_job(client):
    w = await world()
    m = await start(client, w)
    assert (await edit_title(client, w, "decider", m["session_id"])).status_code == 201
    # The meeting's record: the chat's question and a task someone took on.
    for line in ("Who owns QA?", "I will write the QA plan by Nov 2"):
        r = await client.post(f"{MEETINGS}/{m['id']}/chat/messages", json={"text": line},
                              headers=w.ctx.as_("approver"))  # fmt: skip
        assert r.status_code == 200, r.text
    for who in ("approver", "commenter"):
        r = await client.post(f"{MEETINGS}/{m['id']}/end", headers=w.ctx.as_(who))
        assert r.status_code == 403, (who, r.text)
    out = await end(client, w, m["id"])
    assert out["status"] == "ended" and out["minutes_state"] == "drafting"
    # qa-simple-decide-6: a short prose count, not the decision's title.
    assert out["minutes"]["summary"] == "1 decision taken, 1 open question."
    assert out["minutes"]["written_by"] == "extract"
    assert any("working draft" in x["what"] for x in out["minutes"]["waits"])
    r = await w.post(client, "decider", "reorder", session_id=m["session_id"])
    assert r.status_code == 409, r.text
    async with tenant_session(w.ctx.tenant_id) as s:
        job = await s.scalar(select(LlmJob).where(LlmJob.kind == "meeting_minutes"))
        assert job is not None and job.input["meeting_id"] == m["id"]
        seen = {}

        async def ask(kind, payload):
            seen.update(payload)
            return {"summary": "We renamed the ledger.", "open_questions": ["Who owns QA?"],
                    "action_items": [{"title": "Write the QA plan", "owner_id": uid(w, "approver"),
                                      "due_date": "2026-11-02"},
                                     {"title": "Tell support", "owner_id": str(uuid.uuid4()),
                                      "due_date": "soon"}]}  # fmt: skip

        assert (await meetings.run_job(s, job, ask))["written"] is True
        await s.commit()
    assert seen["decisions"][0]["title"] == "Renamed Edit_Title A"
    out = await get(client, w, m["id"])
    mins = out["minutes"]
    assert out["minutes_state"] == "ready" and mins["written_by"] == "oracle"
    assert mins["summary"] == "We renamed the ledger." and mins["open_questions"] == [
        "Who owns QA?"
    ]
    assert mins["action_items"][0] == {"title": "Write the QA plan", "owner_id": uid(w, "approver"),
                                       "due_date": "2026-11-02", "owner_name": None,
                                       "action_item_id": None}  # fmt: skip
    # Nobody said it (the meeting's record does not hold it): dropped.
    assert len(mins["action_items"]) == 1
    body = {"summary": "Edited summary", "open_questions": [], "action_items": []}
    r = await client.put(f"{MEETINGS}/{m['id']}/minutes", json=body, headers=w.ctx.as_("commenter"))
    assert r.status_code == 403
    r = await client.put(f"{MEETINGS}/{m['id']}/minutes", json=body, headers=w.ctx.as_("decider"))
    assert r.status_code == 200 and r.json()["minutes"]["written_by"] == "edited", r.text
    async with tenant_session(w.ctx.tenant_id) as s:
        job = await s.scalar(select(LlmJob).where(LlmJob.kind == "meeting_minutes"))

        async def ask2(kind, payload):
            return {"summary": "Later answer"}

        assert (await meetings.run_job(s, job, ask2))["written"] is False
        await s.commit()
    assert (await get(client, w, m["id"]))["minutes"]["summary"] == "Edited summary"


async def test_delivery_choices(client, monkeypatch):
    from oracle.members import mailer

    w = await world()
    m = await start(client, w)
    assert (await edit_title(client, w, "decider", m["session_id"])).status_code == 201
    await end(client, w, m["id"])
    body = {"summary": "Short", "open_questions": [],
            "action_items": [{"title": "Write the QA plan",
                              "owner_id": uid(w, "approver")}]}  # fmt: skip
    assert (await client.put(f"{MEETINGS}/{m['id']}/minutes", json=body,
                             headers=w.ctx.as_("decider"))).status_code == 200  # fmt: skip
    r = await client.post(f"{MEETINGS}/{m['id']}/send", json={"slack": True},
                          headers=w.ctx.as_("decider"))  # fmt: skip
    assert r.status_code == 422 and "not connected" in r.text, r.text
    r = await client.post(f"{MEETINGS}/{m['id']}/send", json={"email": True},
                          headers=w.ctx.as_("decider"))  # fmt: skip
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["minutes_state"] == "sent"
    assert out["delivery"]["decisions"] and out["delivery"]["inbox"]
    assert out["delivery"]["email"] and out["delivery"]["email_status"] == "unavailable"
    assert not out["delivery"]["slack"]
    r = await client.post(f"{MEETINGS}/{m['id']}/send", json={}, headers=w.ctx.as_("decider"))
    assert r.status_code == 409
    for who in ("approver", "commenter"):
        [row] = (await inbox(client, w, who))["simple_minutes"]
        assert row["meeting_id"] == m["id"] and row["decisions"] == 1
    assert (await inbox(client, w, "viewer"))["simple_minutes"] == []
    async with tenant_session(w.ctx.tenant_id) as s:
        [c] = list(
            await s.scalars(select(SimpleChange).where(SimpleChange.op == "add_action_item"))
        )
        assert c.target["meeting_id"] == m["id"] and c.after["title"] == "Write the QA plan"
    # Email through Oracle's mailer, Slack connected: a second meeting.
    fake = FakeMailer()
    monkeypatch.setattr(mailer, "get_mailer", lambda: fake)

    async def connected(db):
        return SimpleSlackState(connected=True, channel="#product")

    monkeypatch.setattr(meetings, "_slack_state", connected)
    posts: list[str] = []

    async def post(db, text):
        posts.append(text)

    monkeypatch.setattr(meetings, "_post_slack", post)
    m2 = await start(client, w, title="Second review")
    out = await end(client, w, m2["id"])
    assert out["email_available"] and out["slack"] == {"connected": True, "channel": "#product"}
    r = await client.post(f"{MEETINGS}/{m2['id']}/send", json={"email": True, "slack": True},
                          headers=w.ctx.as_("decider"))  # fmt: skip
    assert r.status_code == 200, r.text
    assert r.json()["delivery"]["slack_channel"] == "#product"
    async with tenant_session(w.ctx.tenant_id) as s:
        # dod-delivery: the post is tried with the emails (its own status), not the outbox.
        assert list(await s.scalars(select(SlackOutbox))) == []
        await meetings.deliver_email(s, uuid.UUID(m2["id"]))
        await s.commit()
    got = await get(client, w, m2["id"])
    assert got["delivery"]["email_status"] == "sent"
    assert got["delivery"]["slack_status"] == "sent" and "Second review" in posts[0]
    emails = {w.ctx.users[x].email for x in ("decider", "approver", "commenter")}
    assert sorted(x.to for x in fake.sent) == sorted(emails)
    assert all(x.subject == "Minutes: Second review" for x in fake.sent)


async def test_minutes_inbox_row_is_dated_by_its_send(client, clock):
    """dod-actions-meet review: the Inbox's minutes row carries when they were sent, so its
    age and its new/open read from the same moment.
    protects = ``simple_minutes`` rows have ``sent_at``, the send's time; fails_when = the
    row has only the meeting's end, so minutes sent hours after it read hours old; no_claim =
    the 30-day window."""
    w = await world()
    m = await start(client, w)
    assert (await edit_title(client, w, "decider", m["session_id"])).status_code == 201
    await end(client, w, m["id"])
    ended = clock["now"]
    clock["now"] = ended + timedelta(hours=3)
    r = await client.post(f"{MEETINGS}/{m['id']}/send", json={}, headers=w.ctx.as_("decider"))
    assert r.status_code == 200, r.text
    [row] = (await inbox(client, w, "approver"))["simple_minutes"]
    assert dt.datetime.fromisoformat(row["sent_at"]) == ended + timedelta(hours=3)


async def test_decisions_page_grouping_and_filters(client):
    w = await world()
    m = await start(client, w)
    assert (await edit_title(client, w, "decider", m["session_id"])).status_code == 201
    await end(client, w, m["id"])
    assert (await client.post(f"{MEETINGS}/{m['id']}/send", json={},
                              headers=w.ctx.as_("decider"))).status_code == 200  # fmt: skip
    # A decision outside meetings, naming the PRD.
    async with tenant_session(w.ctx.tenant_id) as s:
        from oracle.decisions import capture
        from oracle.docs.models import Document

        prd = await s.scalar(select(Document).where(Document.slug == PRD))
        await capture.capture(s, None, origin="version_approval", source_kind="test",
                              source_id=uuid.uuid4(), title="Approved the PRD",
                              options=[{"key": "approve"}], chosen_option="approve",
                              rationale="Fine", approver_id=w.ctx.users["owner"].id,
                              subjects=[{"kind": "document", "id": str(prd.id)}])  # fmt: skip
        await capture.capture(s, None, origin="version_approval", source_kind="test",
                              source_id=uuid.uuid4(), title="Elsewhere",
                              options=[{"key": "approve"}], chosen_option="approve",
                              rationale="Fine", approver_id=w.ctx.users["owner"].id,
                              subjects=[{"kind": "document", "id": str(uuid.uuid4())}])  # fmt: skip
        await s.commit()
    r = await client.get("/v1/simple/decisions", headers=w.ctx.as_("viewer"))
    assert r.status_code == 200, r.text
    page = r.json()
    [g] = page["meetings"]
    assert g["meeting"]["id"] == m["id"] and g["minutes"]["summary"]
    assert [d["title"] for d in g["decisions"]] == ["Renamed Edit_Title A"]
    assert [d["title"] for d in page["other"]] == ["Elsewhere", "Approved the PRD"]
    assert PRD in [p["id"] for p in page["prds"]]
    # qa-simple-decide-11: the meeting's title carries its day and (while live) " · live".
    words = company_time.date_in_words(company_time.day(m["started_at"]))
    assert [o["id"] for o in page["meeting_options"]] == [m["id"]]
    assert page["meeting_options"][0]["title"] == f"{m['title']} · {words}"
    r = await client.get("/v1/simple/decisions", params={"prd": PRD}, headers=w.ctx.as_("viewer"))
    page = r.json()
    assert len(page["meetings"]) == 1 and [d["title"] for d in page["other"]] == [
        "Approved the PRD"
    ]
    r = await client.get("/v1/simple/decisions", params={"meeting": m["id"]},
                         headers=w.ctx.as_("viewer"))  # fmt: skip
    assert len(r.json()["meetings"]) == 1 and r.json()["other"] == []
    r = await client.get("/v1/simple/decisions", params={"meeting": str(uuid.uuid4())},
                         headers=w.ctx.as_("viewer"))  # fmt: skip
    assert r.json()["meetings"] == []
    for key, value in (("prd", "no-such-prd"), ("goal", "no-such-goal")):
        r = await client.get("/v1/simple/decisions", params={key: value},
                             headers=w.ctx.as_("viewer"))  # fmt: skip
        assert r.status_code == 404, (key, r.text)


async def test_an_open_decision_named_in_minutes_is_not_listed_twice(client):
    w = await world()
    m = await start(client, w)
    await end(client, w, m["id"])
    async with tenant_session(w.ctx.tenant_id) as s:
        from oracle.decisions import capture

        open_one = await capture.capture(
            s, None, origin="version_approval", source_kind="test", source_id=uuid.uuid4(),
            title="Pick the ledger", options=[{"key": "a"}], chosen_option="a",
            rationale="Later", approver_id=w.ctx.users["owner"].id,
            subjects=[{"kind": "document", "id": str(uuid.uuid4())}],
        )  # fmt: skip
        open_one.status = "proposed"
        await s.commit()
        number, decision_id = open_one.number, open_one.id

    async def other() -> list[str]:
        r = await client.get("/v1/simple/decisions", headers=w.ctx.as_("viewer"))
        assert r.status_code == 200, r.text
        assert [g["meeting"]["id"] for g in r.json()["meetings"]] == [m["id"]]
        return [d["title"] for d in r.json()["other"]]

    # Not named in the minutes yet: listed outside meetings.
    assert "Pick the ledger" in await other()
    body = {"summary": "We talked.", "open_questions": [f"D-{number}: Pick the ledger"]}
    r = await client.put(f"{MEETINGS}/{m['id']}/minutes", json=body,
                         headers=w.ctx.as_("decider"))  # fmt: skip
    assert r.status_code == 200, r.text
    assert "Pick the ledger" not in await other()
    async with tenant_session(w.ctx.tenant_id) as s:
        (await s.get(Decision, decision_id)).status = "decided"
        await s.commit()
    assert "Pick the ledger" in await other()


async def test_meeting_option_title_carries_the_day_and_live(client):
    """qa-simple-decide-11: a meeting_option's title is "<title> · <day>", plus " · live"
    while the meeting is still live."""
    w = await world()
    ended = await start(client, w, title="Ended review")
    await end(client, w, ended["id"])
    live = await start(client, w, title="Live review")
    r = await client.get("/v1/simple/decisions", headers=w.ctx.as_("viewer"))
    assert r.status_code == 200, r.text
    options = {o["id"]: o["title"] for o in r.json()["meeting_options"]}
    ended_words = company_time.date_in_words(company_time.day(ended["started_at"]))
    live_words = company_time.date_in_words(company_time.day(live["started_at"]))
    assert options[ended["id"]] == f"Ended review · {ended_words}"
    assert options[live["id"]] == f"Live review · {live_words} · live"
