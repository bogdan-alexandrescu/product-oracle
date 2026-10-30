"""Simple DoD: the remaining who/when cells of docs/simple-dod-ops.md (meeting start,
rules, approve, minutes redraft and send; chat cards' apply/undo/apply-all;
cut_with_dependents; add_feature_ask; record_decision). Against Postgres, over REST.

The company's clock is fixed (``company_time.now``, tests.test_simple_changes_api's
``clock``); audit events carry the database's ``created_at`` (checked to fall inside the
request) and the actor ``user:<uuid>``.

Test cards (protects / fails_when / no_claim):

- test_meeting_start_and_rules_record_when: protects=a started meeting's ``started_at``
  and its session's ``started_at`` are the company clock's now and its
  ``simple_meeting.started`` event names the starter, stamped during the request; the
  presenter's rules change writes a ``simple_meeting.rules`` event naming them, stamped
  during that request, with the new mode and absent list; fails_when=start keeps another
  time or no event, or rules leave no record of who/when; no_claim=who may start (the
  meetings tests' role matrix).
- test_meeting_approve_records_its_own_decision: protects=the decider's Approve in the
  meeting writes a decision (origin ``meeting``, ``approver_id``/``decided_by`` the
  decider, ``decided_at`` during the request, title "Approved ...", subject the roadmap's document
  whose draft it approved) and
  its meeting link row at the company clock's now; fails_when=the approval's decision
  names someone else, another time, or is not linked to the meeting; no_claim=the
  absent-reviewer gating (test_simple_meetings_api).
- test_minutes_redraft_and_send_record_who_and_when: protects=the decider's redraft of a
  failed minutes job writes a ``simple_meeting.redraft`` event naming them (stamped during
  the request, the new job's id) and the presenter's send stamps ``sent_at`` with the
  company clock's now and writes a ``simple_meeting.sent`` event naming the sender;
  fails_when=either step leaves no record of who acted or when; no_claim=delivery
  channels (test_delivery_choices).
- test_chat_card_records_who_and_when_on_apply_undo_and_apply_all: protects=an Ask-panel
  card the owner applies stores ``decided_by`` the owner and ``decided_at`` the company
  clock's now, and its change row the same by/at; its undo (later) marks the card
  ``undone`` while keeping who applied it and when, and writes an ``undone`` change row
  (``undoes_id`` the card's change) by the undoer at the undo's time; a card applied
  through Apply all stores the same ``decided_by``/``decided_at`` as a single apply;
  fails_when=a card's decision names someone else or another time, or the undo leaves no
  record of who undid it and when; no_claim=meeting cards' decisions
  (test_simple_chat_api), the card itself naming the undoer (it does not).
- test_cut_with_dependents_change_records_who_and_when: protects=the owner's cut of an item
  with its dependents (a chat card applied ``with_dependents``) is one change row
  ``cut_with_dependents`` with ``by`` the owner and ``at`` the company clock's now;
  fails_when=the row names someone else or another time; no_claim=which items it cuts
  (test_simple_cut_dependents_api).
- test_feature_ask_names_who_filed_it: protects=an approver's ``add_feature_ask`` writes a
  change by them at the company clock's now and the Requests row's ``filed_by`` is them;
  fails_when=the ask is filed under someone else or nobody; no_claim=the ask's undo
  (test_new_ops_per_role).
- test_record_decision_records_who_and_when: protects=an approver's ``record_decision``
  card on a PRD page writes a decision with ``approver_id``/``decided_by`` them and
  ``decided_at`` stamped during the request, and the card's ``decided_by``/``decided_at``
  them at the company clock's now; fails_when=the decision or card has no time or names
  someone else; no_claim=the meeting path (test_simple_chat_actions).
"""

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from oracle.decisions.models import Decision
from oracle.models import AuditEvent
from oracle.requests.models import ProductRequest
from oracle.simple.models import (
    SimpleChange,
    SimpleChatCard,
    SimpleMeeting,
    SimpleMeetingDecision,
    SimpleSession,
)
from oracle.tenancy import tenant_session
from tests.test_simple_changes_api import clock as clock  # noqa: F401
from tests.test_simple_chat_api import CARDS, World, make_people, say
from tests.test_simple_meetings_api import MEETINGS, edit_title, start, uid, world
from tests.test_simple_meetings_walk import ended, set_job


async def recorded(w, action: str, who: str, since: datetime, entity_id) -> AuditEvent:
    async with tenant_session(w.ctx.tenant_id) as s:
        [e] = list(await s.scalars(select(AuditEvent).where(AuditEvent.action == action)))
    assert e.actor == f"user:{w.ctx.users[who].id}", action
    assert since <= e.created_at <= datetime.now(UTC), action
    assert e.entity_id == uuid.UUID(str(entity_id)), action
    return e


async def test_meeting_start_and_rules_record_when(client, clock):
    w = await world()
    clock["now"] = clock["now"] + timedelta(minutes=7)
    since = datetime.now(UTC)
    m = await start(client, w, "decider")
    async with tenant_session(w.ctx.tenant_id) as s:
        row = await s.get(SimpleMeeting, uuid.UUID(m["id"]))
        session = await s.get(SimpleSession, row.session_id)
    assert row.started_at == clock["now"] and session.started_at == clock["now"]
    assert row.presenter_id == w.ctx.users["decider"].id
    assert session.started_by == w.ctx.users["decider"].id
    await recorded(w, "simple_meeting.started", "decider", since, m["id"])
    since = datetime.now(UTC)
    r = await client.patch(f"{MEETINGS}/{m['id']}/rules",
                           json={"change_mode": "presenter", "absent_ids": [uid(w, "approver")]},
                           headers=w.ctx.as_("decider"))  # fmt: skip
    assert r.status_code == 200, r.text
    e = await recorded(w, "simple_meeting.rules", "decider", since, m["id"])
    assert e.data["change_mode"] == "presenter" and e.data["absent"] == [uid(w, "approver")]


async def test_meeting_approve_records_its_own_decision(client, clock):
    w = await world()
    m = await start(client, w)
    assert (await edit_title(client, w, "decider", m["session_id"])).status_code == 201
    clock["now"] = clock["now"] + timedelta(minutes=12)
    since = datetime.now(UTC)
    r = await client.post(f"{MEETINGS}/{m['id']}/approve", headers=w.ctx.as_("decider"))
    assert r.status_code == 200, r.text
    async with tenant_session(w.ctx.tenant_id) as s:
        rows = (
            await s.execute(
                select(SimpleMeetingDecision, Decision)
                .join(Decision, Decision.id == SimpleMeetingDecision.decision_id)
                .where(SimpleMeetingDecision.meeting_id == uuid.UUID(m["id"]))
                .where(Decision.title.like("Approved %"))
            )
        ).all()
        from oracle.docs.models import Document

        plan = await s.scalar(select(Document).where(Document.slug == "payments"))
    [(link, d)] = rows
    decider = w.ctx.users["decider"].id
    assert d.origin == "meeting" and d.approver_id == decider and d.decided_by == decider
    assert since <= d.decided_at <= datetime.now(UTC)
    assert link.at == clock["now"]
    assert plan is not None
    assert [{"kind": "document", "id": str(plan.id)}] == [
        {"kind": x.get("kind"), "id": x.get("id")} for x in d.subjects
    ]


async def test_minutes_redraft_and_send_record_who_and_when(client, clock):
    w = await world()
    m = await ended(client, w)
    await set_job(w, status="failed", error="the model said no", attempts=3)
    since = datetime.now(UTC)
    r = await client.post(f"{MEETINGS}/{m['id']}/minutes/redraft", headers=w.ctx.as_("decider"))
    assert r.status_code == 200, r.text
    async with tenant_session(w.ctx.tenant_id) as s:
        row = await s.get(SimpleMeeting, uuid.UUID(m["id"]))
    e = await recorded(w, "simple_meeting.redraft", "decider", since, m["id"])
    assert e.data["minutes_job_id"] == str(row.minutes_job_id)
    body = {"summary": "We kept the ledger.", "open_questions": [], "action_items": []}
    r = await client.put(f"{MEETINGS}/{m['id']}/minutes", json=body, headers=w.ctx.as_("decider"))
    assert r.status_code == 200, r.text
    clock["now"] = clock["now"] + timedelta(minutes=30)
    since = datetime.now(UTC)
    r = await client.post(f"{MEETINGS}/{m['id']}/send", json={}, headers=w.ctx.as_("decider"))
    assert r.status_code == 200, r.text
    async with tenant_session(w.ctx.tenant_id) as s:
        row = await s.get(SimpleMeeting, uuid.UUID(m["id"]))
    assert row.minutes_state == "sent" and row.sent_at == clock["now"]
    await recorded(w, "simple_meeting.sent", "decider", since, m["id"])


async def card_row(ctx, card_id) -> SimpleChatCard:
    async with tenant_session(ctx.tenant_id) as s:
        return await s.get(SimpleChatCard, uuid.UUID(str(card_id)))


async def test_chat_card_records_who_and_when_on_apply_undo_and_apply_all(client, clock):
    ctx = await make_people()
    await World(ctx).build()
    owner = ctx.users["owner"].id
    card = (await say(client, ctx, "owner", "move Ledger v2 to Q2"))["cards"][0]
    clock["now"] = applied_at = clock["now"] + timedelta(minutes=5)
    r = await client.post(f"{CARDS}/{card['id']}/apply", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    row = await card_row(ctx, card["id"])
    assert row.status == "applied" and row.decided_by == owner
    assert row.decided_at == applied_at
    async with tenant_session(ctx.tenant_id) as s:
        change = await s.get(SimpleChange, row.change_id)
    assert change.by == owner and change.at == applied_at
    clock["now"] = undone_at = clock["now"] + timedelta(minutes=10)
    r = await client.post(f"{CARDS}/{card['id']}/undo", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    row = await card_row(ctx, card["id"])
    assert row.status == "undone"
    assert row.decided_by == owner and row.decided_at == applied_at
    async with tenant_session(ctx.tenant_id) as s:
        [undo] = list(
            await s.scalars(select(SimpleChange).where(SimpleChange.undoes_id == change.id))
        )
    assert undo.status == "undone" and undo.by == owner and undo.at == undone_at
    msg = await say(client, ctx, "owner", "cut Alert export")
    [card2] = msg["cards"]
    clock["now"] = all_at = clock["now"] + timedelta(minutes=15)
    r = await client.post(f"/v1/simple/chat/messages/{msg['id']}/apply-all",
                          headers=ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 200, r.text
    assert r.json()["applied"] == [card2["id"]]
    row = await card_row(ctx, card2["id"])
    assert row.status == "applied" and row.decided_by == owner and row.decided_at == all_at


async def test_cut_with_dependents_change_records_who_and_when(client, clock):
    from tests.test_simple_cut_dependents_api import world as cut_world

    ctx, _w = await cut_world()
    card = (await say(client, ctx, "owner", "cut Ledger v2"))["cards"][0]
    clock["now"] = at = clock["now"] + timedelta(minutes=9)
    r = await client.post(f"{CARDS}/{card['id']}/apply", json={"with_dependents": True},
                          headers=ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 200, r.text
    async with tenant_session(ctx.tenant_id) as s:
        [row] = list(await s.scalars(select(SimpleChange)))
    assert row.op == "cut_with_dependents" and row.status == "applied"
    assert row.by == ctx.users["owner"].id and row.at == at


async def test_feature_ask_names_who_filed_it(client, clock):
    ctx = await make_people()
    await World(ctx).build()
    clock["now"] = at = clock["now"] + timedelta(minutes=4)
    ask = {"op": "add_feature_ask", "target": {}, "before": {},
           "after": {"title": "SSO", "requester_name": "Example Retail"}}  # fmt: skip
    r = await client.post("/v1/simple/changes", json=ask, headers=ctx.as_("approver"))
    assert r.status_code == 201, r.text
    approver = ctx.users["approver"].id
    async with tenant_session(ctx.tenant_id) as s:
        change = await s.get(SimpleChange, uuid.UUID(r.json()["change"]["id"]))
        [request] = list(await s.scalars(select(ProductRequest)))
    assert change.by == approver and change.at == at
    assert request.filed_by == approver and request.title == "SSO"


async def test_record_decision_records_who_and_when(client, clock):
    from tests.test_simple_chat_actions import apply as apply_card
    from tests.test_simple_chat_actions import one_card

    w = await world()
    c = await one_card(client, w, "approver", "decision: Go weekly",
                       page="/simple/prds/payments-prd")  # fmt: skip
    assert c["op"] == "record_decision"
    clock["now"] = at = clock["now"] + timedelta(minutes=3)
    since = datetime.now(UTC)
    r = await apply_card(client, w, "approver", c["id"])
    assert r.status_code == 200, r.text
    approver = w.ctx.users["approver"].id
    async with tenant_session(w.ctx.tenant_id) as s:
        d = await s.scalar(select(Decision).where(Decision.title == "Go weekly"))
    assert d.approver_id == approver and d.decided_by == approver
    assert since <= d.decided_at <= datetime.now(UTC)
    row = await card_row(w.ctx, c["id"])
    assert row.decided_by == approver and row.decided_at == at
