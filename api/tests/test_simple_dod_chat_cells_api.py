"""Simple DoD: the chat cells of docs/simple-dod-ops.md Part 2 left MISSING (``choose``'s
who/when and meeting-mode viewer note; ``suggest_feature``'s when; ``record_decision``'s
undo keeping the decision; who may ask Oracle to suggest a goal's features). Against
Postgres, over REST; the company's clock is fixed and moved by the tests; chat lines and
database defaults carry real time (checked to fall inside the request).

Test cards (protects / fails_when / no_claim):

- test_choose_records_who_picked_and_when: protects=a pick on the Ask panel is recorded as
  the picker's own line (author_kind ``person``, ``author_id`` the picker, body the
  choice's label, stamped during the request), the question's ``picked`` index is set, and
  the built card is the picker's (``owner_id``) and stamped during the request; in a
  meeting thread the pick of another attendee's question is recorded as the picker's line
  (not the asker's); fails_when=a pick leaves no record of who picked it or when, or is
  filed under the person who asked; no_claim=an audit event (choose writes none: its
  record is the thread line itself).
- test_a_viewer_choosing_in_a_meeting_gets_the_viewer_note: protects=in a meeting thread a
  viewer attendee's pick of the owner's question answers with chat.VIEWER_NOTE and builds
  no card, writes no change and leaves the roadmap as it was (the pick itself is taken:
  ``picked`` is set and the label is the viewer's line); fails_when=a viewer's pick in a
  meeting builds a card or writes; no_claim=the Ask panel's viewer pick
  (test_simple_dod_actors_api: a card the viewer may not apply).
- test_suggest_feature_card_records_when: protects=a commenter's applied
  ``suggest_feature`` card files a suggestion whose ``created_at`` falls inside the
  request, ``proposed_by`` the commenter, with one ``simple_goal_suggestion.suggested``
  audit event naming them stamped during the request, and the card's ``decided_by`` /
  ``decided_at`` the commenter at the company clock's now; fails_when=the suggestion or
  card carries another time or names someone else; no_claim=the suggestion's accept
  (test_simple_dod_records_api).
- test_record_decision_undo_keeps_the_decision: protects=undoing an applied
  ``record_decision`` card (Ask panel and meeting) flips only the decision's ``status`` to
  ``reversed`` (and its ``updated_at``/``lock_version``): title, subjects, approver,
  ``decided_by``/``decided_at``, options, origin and every other stored column are exactly
  as before, and a ``reversed`` review names the undoer; fails_when=undo deletes the
  decision, rewrites a field, or leaves no record of who undid it; no_claim=the Decisions
  log's display.
- test_suggest_goal_features_roles: protects=``POST /v1/simple/goals/{id}/suggest`` queues a
  ``goal_suggestions`` job for owner, decider, approver and commenter; a viewer gets 403, a
  run gets 403, another company's owner is refused (422 "No such goal": the goal is not
  theirs), and none of the refused calls queues a job in either company; GET
  /v1/me/capabilities answers ``suggest_goal_features`` the same per role (per item:
  commenter); fails_when=a viewer, a run or an outsider queues a job, or the web's can()
  disagrees with the route; no_claim=the job's output (test_simple_additions_api).
"""

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select

from oracle.authz import has_role
from oracle.decisions.models import Decision, DecisionReview
from oracle.discussions.models import DiscussionMessage
from oracle.jobs.models import LlmJob
from oracle.models import AuditEvent
from oracle.simple import chat
from oracle.simple.models import SimpleChatCard, SimpleChatRead, SimpleGoalSuggestion
from oracle.tenancy import tenant_session
from tests import test_simple_chat_api as ct
from tests.coverage_helpers import run_headers
from tests.test_simple_additions_api import GOALS
from tests.test_simple_additions_api import World as AddWorld
from tests.test_simple_additions_api import _say as add_say
from tests.test_simple_changes_api import clock as clock  # noqa: F401
from tests.test_simple_changes_api import make_people
from tests.test_simple_chat_api import meetings  # noqa: F401 -- the fixture
from tests.test_simple_chat_reader import _meeting

ROLES = ("owner", "decider", "approver", "commenter")


def wall() -> datetime:
    return datetime.now(UTC)


async def choose(client, ctx, who: str, message_id: str, index: int):
    return await client.post(f"{ct.ASK}/{message_id}/choose", json={"index": index},
                             headers=ctx.as_(who))  # fmt: skip


async def picked_line(ctx, question_id: str) -> tuple[SimpleChatRead, DiscussionMessage]:
    """The question's read row and the person's line the pick wrote (the next one)."""
    async with tenant_session(ctx.tenant_id) as s:
        read = await s.scalar(
            select(SimpleChatRead).where(SimpleChatRead.message_id == uuid.UUID(question_id))
        )
        q = await s.get(DiscussionMessage, uuid.UUID(question_id))
        later = list(
            await s.scalars(
                select(DiscussionMessage)
                .where(DiscussionMessage.discussion_id == read.discussion_id,
                       DiscussionMessage.created_at > q.created_at)
                .order_by(DiscussionMessage.created_at)
            )
        )  # fmt: skip
    return read, later[0]


async def test_choose_records_who_picked_and_when(client, meetings):  # noqa: F811
    ctx = await ct.make_people()
    await ct.World(ctx).build()
    q = await ct.say(client, ctx, "owner", "move alert to Q2")
    assert q["kind"] == "question" and q["choices"][0]["label"] == "Alert digest", q
    since = wall()
    r = await choose(client, ctx, "owner", q["id"], 0)
    assert r.status_code == 200, r.text
    until = wall()
    [card] = r.json()["messages"][-1]["cards"]
    read, line = await picked_line(ctx, q["id"])
    assert read.picked == 0
    assert line.author_kind == "person" and line.author_id == ctx.users["owner"].id
    assert line.body == "Alert digest"
    assert since <= line.created_at <= until
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(SimpleChatCard, uuid.UUID(card["id"]))
    assert row.owner_id == ctx.users["owner"].id and row.status == "open"
    assert since <= row.created_at <= until
    # In a meeting the thread is shared: the decider's pick of the owner's question is
    # the decider's line.
    mid = _meeting(ctx, meetings)
    q = await ct.say(client, ctx, "owner", "move alert to Q2", mid)
    assert q["kind"] == "question", q
    since = wall()
    r = await choose(client, ctx, "decider", q["id"], 1)
    assert r.status_code == 200, r.text
    until = wall()
    assert r.json()["messages"][-1]["cards"], r.json()["messages"][-1]
    read, line = await picked_line(ctx, q["id"])
    assert read.picked == 1 and read.by == ctx.users["owner"].id
    assert line.author_id == ctx.users["decider"].id and line.body == "Alert export"
    assert since <= line.created_at <= until


async def test_a_viewer_choosing_in_a_meeting_gets_the_viewer_note(client, meetings):  # noqa: F811
    ctx = await ct.make_people()
    w = await ct.World(ctx).build()
    mid = _meeting(ctx, meetings)
    q = await ct.say(client, ctx, "owner", "move alert to Q2", mid)
    assert q["kind"] == "question", q
    before = (await w.item("Alert digest")).start_date
    async with tenant_session(ctx.tenant_id) as s:
        n_cards = await s.scalar(select(func.count()).select_from(SimpleChatCard))
    r = await choose(client, ctx, "viewer", q["id"], 0)
    assert r.status_code == 200, r.text
    m = r.json()["messages"][-1]
    assert m["kind"] == "note" and m["body"] == chat.VIEWER_NOTE and m["cards"] == []
    assert r.json()["messages"][-2]["body"] == "Alert digest"
    read, line = await picked_line(ctx, q["id"])
    assert read.picked == 0 and line.author_id == ctx.users["viewer"].id
    async with tenant_session(ctx.tenant_id) as s:
        assert await s.scalar(select(func.count()).select_from(SimpleChatCard)) == n_cards
    assert await ct.n_changes(ctx) == 0
    assert (await w.item("Alert digest")).start_date == before


async def test_suggest_feature_card_records_when(client, clock):  # noqa: F811
    w = await AddWorld().build()
    c = (await add_say(client, w, "commenter", "suggest a feature for grow: Faster imports"))[
        "cards"
    ][0]
    assert c["op"] == "suggest_feature", c
    clock["now"] = at = clock["now"] + timedelta(minutes=6)
    since = wall()
    r = await client.post(f"{ct.CARDS}/{c['id']}/apply", headers=w.as_("commenter"))
    assert r.status_code == 200, r.text
    until = wall()
    commenter = w.ctx.users["commenter"].id
    async with tenant_session(w.ctx.tenant_id) as s:
        card = await s.get(SimpleChatCard, uuid.UUID(c["id"]))
        row = await s.get(SimpleGoalSuggestion, uuid.UUID(card.target["suggestion_id"]))
        [e] = list(
            await s.scalars(
                select(AuditEvent).where(AuditEvent.action == "simple_goal_suggestion.suggested")
            )
        )
    assert card.status == "applied" and card.decided_by == commenter and card.decided_at == at
    assert row.proposed_by == commenter and row.origin == "person" and row.status == "open"
    assert since <= row.created_at <= until
    assert e.actor == f"user:{commenter}" and e.entity_id == row.id
    assert since <= e.created_at <= until


COLUMNS = [c.key for c in Decision.__mapper__.column_attrs]
CHANGED = {"status", "updated_at", "lock_version"}


async def decision_row(ctx, decision_id) -> dict:
    async with tenant_session(ctx.tenant_id) as s:
        d = await s.get(Decision, uuid.UUID(str(decision_id)))
        return {k: getattr(d, k) for k in COLUMNS}


async def test_record_decision_undo_keeps_the_decision(client, clock):  # noqa: F811
    from tests.test_simple_chat_actions import apply as apply_card
    from tests.test_simple_chat_actions import one_card
    from tests.test_simple_chat_actions import undo as undo_card
    from tests.test_simple_meetings_api import start, world

    w = await world()
    mid = (await start(client, w))["id"]
    cases = [
        ("approver", "decision: Go weekly", {"page": "/simple/prds/payments-prd"}),
        ("commenter", "decision by approver: Ship it weekly", {"meeting": mid}),
    ]
    for who, text, where in cases:
        c = await one_card(client, w, who, text, **where)
        assert c["op"] == "record_decision"
        r = await apply_card(client, w, who, c["id"])
        assert r.status_code == 200, r.text
        did = r.json()["card"]["decision_id"]
        before = await decision_row(w.ctx, did)
        assert before["status"] == "decided" and before["decided_at"] is not None
        clock["now"] = clock["now"] + timedelta(minutes=5)
        r = await undo_card(client, w, who, c["id"])
        assert r.status_code == 200, r.text
        after = await decision_row(w.ctx, did)
        assert after["status"] == "reversed", text
        assert {k: v for k, v in after.items() if k not in CHANGED} == {
            k: v for k, v in before.items() if k not in CHANGED
        }, text
        async with tenant_session(w.ctx.tenant_id) as s:
            [review] = list(
                await s.scalars(
                    select(DecisionReview).where(DecisionReview.decision_id == uuid.UUID(did))
                )
            )
        assert review.verdict == "reversed" and review.reviewed_by == w.ctx.users[who].id


async def goal_jobs(ctx) -> int:
    async with tenant_session(ctx.tenant_id) as s:
        return (
            await s.scalar(
                select(func.count()).select_from(LlmJob).where(LlmJob.kind == "goal_suggestions")
            )
            or 0
        )


async def test_suggest_goal_features_roles(client):
    w = await AddWorld().build()
    other = await make_people()
    url = f"{GOALS}/{w.goals['grow']}/suggest"
    for who in ROLES:
        n = await goal_jobs(w.ctx)
        r = await client.post(url, headers=w.as_(who))
        assert r.status_code == 200, (who, r.text)
        assert r.json()["pending"] is True and await goal_jobs(w.ctx) == n + 1, who
    n = await goal_jobs(w.ctx)
    r = await client.post(url, headers=w.as_("viewer"))
    assert r.status_code == 403, r.text
    r = await client.post(url, headers=await run_headers(w.ctx, "owner"))
    assert r.status_code == 403, r.text
    r = await client.post(url, headers=other.as_("owner"))
    assert r.status_code == 422 and r.json()["detail"] == "No such goal", r.text
    assert await goal_jobs(w.ctx) == n and await goal_jobs(other) == 0
    # The web's can() (web/lib/me.tsx, no item) reads the same answer: the operation is
    # open to every member and its per-item role, commenter, decides.
    for who in (*ROLES, "viewer"):
        r = await client.get("/v1/me/capabilities", headers=w.as_(who))
        assert r.status_code == 200, r.text
        caps = r.json()
        assert caps["operations"]["suggest_goal_features"] is True, who
        role = caps["per_item"]["suggest_goal_features"]
        assert role == "commenter", who
        assert has_role(caps["role"], role) is (who != "viewer"), who
