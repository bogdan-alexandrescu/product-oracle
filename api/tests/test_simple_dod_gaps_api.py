"""Simple Definition of Done, item 5 (docs/simple-dod-ops.md): the cells the ops table still
marked MISSING, for the chat's direct actions (oracle.simple.chat_actions), the review
meetings (oracle.simple.meetings) and the change engine's draft-item, key-date and
question ops (oracle.simple.changes, key_dates, questions). Against Postgres; the worlds of
tests.test_simple_chat_actions / test_simple_meetings_api, test_simple_dod_changes_api,
test_simple_additions_api, test_simple_key_dates_api and test_simple_prd_questions; the
clock frozen at tests.test_simple_roadmap_api.NOW.

Test cards (protects / fails_when / no_claim):

Chat actions (docs Part 2, "1. Chat actions"):

- test_chat_notes_record_who_and_when: protects=a minutes_note and an open_question
  applied in a meeting's chat are stored on the meeting naming their author (``by``) and
  the company's now (``at``), shown on the meeting with the author's name and that time,
  and their card records who applied it and when (``decided_by``/``decided_at``);
  fails_when=a note or its card loses its author or time, or names someone else;
  no_claim=the minutes job's use of the notes.
- test_chat_agenda_moves_record_who_and_when: protects=an agenda_next and an agenda_skip
  card applied in a meeting's chat record who applied it and when on the card (the agenda
  itself holds only the order); fails_when=the card has no author or time, or the wrong
  ones; no_claim=a who/when on the agenda JSON (it has none by design).
- test_chat_agenda_next_undo_restores_exactly: protects=undoing "next: <item>" puts the
  meeting's stored agenda back exactly as it was (the next item and the skipped list,
  including an item the move took out of the skipped list); fails_when=the undo leaves any
  part of the agenda changed; no_claim=undo after the meeting ended (refused, S8's tests).

Meetings (docs Part 2, "3. Meetings"):

- test_meeting_end_records_who_and_when: protects=ending a live meeting stores who ended
  it and the company's now (``ended_by``/``ended_at``, the session closed at that time),
  reads back on the meeting, and writes a ``simple_meeting.ended`` audit event naming the
  person; fails_when=the end is stored without its author or time, or with the wrong
  ones; no_claim=the minutes job.
- test_meeting_join_records_who_and_when: protects=a person's join of a live meeting is
  recorded with who joined (an audit event naming the person and the meeting), beyond
  their place in the attendee list; fails_when=a join leaves no record of who joined;
  no_claim=the event's time against the frozen clock (audit events take the database's
  time).

Change engine ops (docs Part 1, Group 2 and Group 4):

- test_remove_key_date_undo_restores_exactly: protects=undoing remove_key_date puts the
  key date back in the working draft exactly as it was (name, date, note, in-draft
  state) and leaves every stored column of the published key date row untouched
  throughout; a remove made on a key date that changed since is 409 with its current
  value and writes nothing; fails_when=the undo leaves the key date gone or changed, the
  published row is written, or a stale remove lands; no_claim=undo after the draft is
  submitted.
- test_remove_key_date_waits_in_the_working_draft: protects=an applied remove_key_date is
  in the working draft only: the published row (every stored column) stays and a viewer
  still reads the key date until the decider submits and approves the draft, then it is
  gone for everyone; fails_when=the remove deletes the published row early or approval
  does not publish it; no_claim=required reviewers (test_simple_drafts_api).
- test_draft_flag_ops_wait_in_the_working_draft[keep_both|confirm_item]: protects=on a
  published draft item, an applied keep_both / confirm_item is in the working draft only:
  the published row (every stored column) and a viewer's roadmap are unchanged until the
  decider submits and approves the draft, whose new version holds the new value;
  fails_when=the op writes the published row, or approval does not publish it;
  no_claim=a draft item added in the working draft (test_simple_additions_api).
- test_draft_flag_ops_refuse_a_stale_before[keep_both|confirm_item]: protects=a keep_both
  / confirm_item made on values that changed since (another person applied it first)
  answers 409 with the current values and writes nothing (a confirm_item on an item
  confirmed since is refused 422 "Only a draft item ...", the draft-only guard answering
  before the before check); fails_when=a stale op lands or writes a change row;
  no_claim=merge_item (its before is read, not given).
- test_merge_item_returns_the_checker_flags: protects=merge_item, proposed or applied,
  answers the constraint checker's flags of every item it touched (the draft, the item it
  is merged into) and their dependents, as the roadmap shows them once applied (a
  proposal's as if applied); fails_when=the merge skips the check or answers stale or
  partial flags; no_claim=which flags a merge raises.
- test_decide_question_returns_no_flags: protects=decide_question, applied or proposed,
  answers an empty flags list (PRD decisions do not run the item checker), and a decide
  made on a status that changed since is 409 with the current state, writing nothing;
  fails_when=flags appear for a question, or a stale decide lands; no_claim=the
  question's page wording.
"""

import uuid
from datetime import datetime

import pytest
from sqlalchemy import inspect, select

from oracle.auth.models import User
from oracle.members.names import display_name
from oracle.models import AuditEvent
from oracle.roadmap.models import RoadmapItem
from oracle.simple.models import (
    RoadmapKeyDate,
    SimpleChange,
    SimpleChatCard,
    SimpleMeeting,
    SimpleSession,
)
from oracle.tenancy import tenant_session
from tests import test_simple_chat_actions as ca
from tests import test_simple_meetings_api as mt
from tests.test_simple_additions_api import World as AddWorld
from tests.test_simple_changes_api import CHANGES
from tests.test_simple_changes_api import clock as clock  # noqa: F401
from tests.test_simple_dod_changes_api import DRAFTS, ROADMAP, columns, snapshot
from tests.test_simple_dod_changes_api import world as dod_world
from tests.test_simple_key_dates_api import key_dates, published_key_date
from tests.test_simple_key_dates_api import post as post_key_date
from tests.test_simple_key_dates_api import world as key_date_world
from tests.test_simple_roadmap_api import NOW

# --------------------------------------------------------------------------- chat actions


async def card_row(w, card_id: str) -> SimpleChatCard:
    async with tenant_session(w.ctx.tenant_id) as s:
        return await s.get(SimpleChatCard, uuid.UUID(card_id))


async def meeting_row(w, mid: str) -> SimpleMeeting:
    async with tenant_session(w.ctx.tenant_id) as s:
        return await s.get(SimpleMeeting, uuid.UUID(mid))


async def name_of(w, who: str, *, meeting: bool = False) -> str:
    """The person's name as the chat card (display name) or the meeting (name, else
    email) shows it."""
    async with tenant_session(w.ctx.tenant_id) as s:
        u = await s.get(User, w.ctx.users[who].id)
    return (u.name or u.email) if meeting else display_name(u.email, u.name)


async def applied_by(client, w, who: str, card: dict) -> dict:
    """Apply the card as ``who``; its row and its answer name ``who`` and now."""
    r = await ca.apply(client, w, who, card["id"])
    assert r.status_code == 200, r.text
    out = r.json()["card"]
    assert out["status"] == "applied", out
    assert out["decided_by_name"] == await name_of(w, who), out
    assert datetime.fromisoformat(out["decided_at"]) == NOW, out
    row = await card_row(w, card["id"])
    assert (row.status, row.decided_by, row.decided_at) == ("applied", w.ctx.users[who].id, NOW)
    return out


async def test_chat_notes_record_who_and_when(client):
    w = await mt.world()
    m = await mt.start(client, w, attendee_ids=[mt.uid(w, x) for x in ("approver", "commenter")])
    mid = m["id"]
    note = await ca.one_card(client, w, "commenter", "note: Ship the checklist first", mid)
    assert note["op"] == "minutes_note"
    await applied_by(client, w, "commenter", note)
    q = await ca.one_card(client, w, "approver", "open question: Who writes the tour?", mid)
    assert q["op"] == "open_question"
    await applied_by(client, w, "approver", q)
    stored = (await meeting_row(w, mid)).notes
    assert [(n["kind"], n["text"], n["by"], n["card_id"]) for n in stored] == [
        ("note", "Ship the checklist first", mt.uid(w, "commenter"), note["id"]),
        ("question", "Who writes the tour?", mt.uid(w, "approver"), q["id"]),
    ]
    assert all(datetime.fromisoformat(n["at"]) == NOW for n in stored), stored
    shown = (await mt.get(client, w, mid, "approver"))["notes"]
    assert [(n["kind"], n["by_name"]) for n in shown] == [
        ("note", await name_of(w, "commenter", meeting=True)),
        ("question", await name_of(w, "approver", meeting=True)),
    ]
    assert all(datetime.fromisoformat(n["at"]) == NOW for n in shown), shown


async def test_chat_agenda_moves_record_who_and_when(client):
    w = await mt.world()
    mid = (await mt.start(client, w))["id"]
    nxt = await ca.one_card(client, w, "commenter", "next: Cut A", mid)
    assert nxt["op"] == "agenda_next"
    await applied_by(client, w, "commenter", nxt)
    skip = await ca.one_card(client, w, "approver", "skip Cut A", mid)
    assert skip["op"] == "agenda_skip"
    await applied_by(client, w, "approver", skip)
    agenda = (await mt.get(client, w, mid))["agenda"]
    assert agenda["next"] is None and [x["title"] for x in agenda["skipped"]] == ["Cut A"]


async def test_chat_agenda_next_undo_restores_exactly(client):
    w = await mt.world()
    mid = (await mt.start(client, w))["id"]
    # From a fresh meeting: the undo puts back an empty agenda.
    first = await ca.one_card(client, w, "commenter", "next: Cut A", mid)
    shown = (await mt.get(client, w, mid))["agenda"]
    await applied_by(client, w, "commenter", first)
    assert (await mt.get(client, w, mid))["agenda"]["next"]["title"] == "Cut A"
    r = await ca.undo(client, w, "commenter", first["id"])
    assert r.status_code == 200 and r.json()["status"] == "undone", r.text
    assert (await mt.get(client, w, mid))["agenda"] == shown
    # A next item and a skipped one; "next: Cut B" takes Cut B out of the skipped list.
    for line in ("next: Cut A", "skip Cut B"):
        c = await ca.one_card(client, w, "commenter", line, mid)
        await applied_by(client, w, "commenter", c)
    stored = (await meeting_row(w, mid)).agenda
    assert stored == {"next": str(w.ids["cut-a"]), "skipped": [str(w.ids["cut-b"])]}
    shown = (await mt.get(client, w, mid))["agenda"]
    nxt = await ca.one_card(client, w, "commenter", "next: Cut B", mid)
    await applied_by(client, w, "commenter", nxt)
    assert (await meeting_row(w, mid)).agenda == {"next": str(w.ids["cut-b"]), "skipped": []}
    r = await ca.undo(client, w, "commenter", nxt["id"])
    assert r.status_code == 200 and r.json()["status"] == "undone", r.text
    assert (await meeting_row(w, mid)).agenda == stored
    assert (await mt.get(client, w, mid))["agenda"] == shown


# --------------------------------------------------------------------------- meetings


async def test_meeting_end_records_who_and_when(client):
    w = await mt.world()
    m = await mt.start(client, w)
    out = await mt.end(client, w, m["id"])
    assert out["status"] == "ended"
    row = await meeting_row(w, m["id"])
    assert (row.status, row.ended_by, row.ended_at) == ("ended", w.ctx.users["decider"].id, NOW)
    async with tenant_session(w.ctx.tenant_id) as s:
        session = await s.get(SimpleSession, row.session_id)
        assert session.closed_at == NOW
        events = list(
            await s.scalars(
                select(AuditEvent).where(
                    AuditEvent.action == "simple_meeting.ended",
                    AuditEvent.entity_id == row.id,
                )
            )
        )
    assert [e.actor for e in events] == [f"user:{mt.uid(w, 'decider')}"]
    listed = (await client.get(mt.MEETINGS, headers=w.ctx.as_("decider"))).json()
    briefs = [b for v in listed.values() if isinstance(v, list) for b in v]
    mine = [b for b in briefs if isinstance(b, dict) and b.get("id") == m["id"]]
    assert mine and all(datetime.fromisoformat(b["ended_at"]) == NOW for b in mine), listed


async def test_meeting_join_records_who_and_when(client):
    w = await mt.world()
    m = await mt.start(client, w, attendee_ids=[mt.uid(w, "approver")])
    assert mt.uid(w, "commenter") not in [a["id"] for a in m["attendees"]]
    r = await client.post(f"{mt.MEETINGS}/{m['id']}/join", headers=w.ctx.as_("commenter"))
    assert r.status_code == 200, r.text
    row = await meeting_row(w, m["id"])
    assert w.ctx.users["commenter"].id in row.attendee_ids
    async with tenant_session(w.ctx.tenant_id) as s:
        events = list(
            await s.scalars(
                select(AuditEvent).where(
                    AuditEvent.entity_id == row.id,
                    AuditEvent.actor == f"user:{mt.uid(w, 'commenter')}",
                )
            )
        )
    # The join is a record of who joined (DoD column a), not only a place in the list.
    assert [e for e in events if "join" in e.action], [e.action for e in events]


# --------------------------------------------------------------------------- key dates


def key_date_columns(row: RoadmapKeyDate) -> dict:
    return {a.key: getattr(row, a.key) for a in inspect(RoadmapKeyDate).mapper.column_attrs}


async def key_date_row(w, kd: str) -> dict | None:
    async with tenant_session(w.ctx.tenant_id) as s:
        row = await s.get(RoadmapKeyDate, uuid.UUID(kd))
        return key_date_columns(row) if row is not None else None


SEEN = {"name": "Board meeting", "date": "2026-11-20", "note": None}


async def read_key_dates(client, w, who: str) -> list[tuple]:
    return [(k["id"], k["name"], k["date"], k["note"], k["in_draft"])
            for k in await key_dates(client, w, who)]  # fmt: skip


async def test_remove_key_date_undo_restores_exactly(client):
    w = await key_date_world()
    kd = await published_key_date(w)
    published = await key_date_row(w, kd)
    shown = await read_key_dates(client, w, "decider")
    r = await post_key_date(client, w, "decider", "remove_key_date", SEEN, key_date_id=kd)
    assert r.status_code == 201, r.text
    change = r.json()["change"]
    assert change["status"] == "applied"
    assert await read_key_dates(client, w, "decider") == []
    assert await key_date_row(w, kd) == published
    u = await client.post(f"{CHANGES}/{change['id']}/undo", headers=w.ctx.as_("decider"))
    assert u.status_code == 201, u.text
    assert await read_key_dates(client, w, "decider") == shown
    assert await key_date_row(w, kd) == published
    # A remove made on a key date that changed since: 409 with the current value.
    edit = await post_key_date(client, w, "decider", "edit_key_date", SEEN, {"name": "Moved"},
                               key_date_id=kd)  # fmt: skip
    assert edit.status_code == 201, edit.text
    async with tenant_session(w.ctx.tenant_id) as s:
        n = len(list(await s.scalars(select(SimpleChange))))
    stale = await post_key_date(client, w, "owner", "remove_key_date", SEEN, key_date_id=kd)
    assert stale.status_code == 409, stale.text
    assert stale.json()["detail"]["current"]["key_date"]["name"] == "Moved"
    assert [k[1] for k in await read_key_dates(client, w, "decider")] == ["Moved"]
    async with tenant_session(w.ctx.tenant_id) as s:
        assert len(list(await s.scalars(select(SimpleChange)))) == n


async def test_remove_key_date_waits_in_the_working_draft(client):
    w = await key_date_world()
    kd = await published_key_date(w)
    published = await key_date_row(w, kd)
    seen = await read_key_dates(client, w, "viewer")
    assert [k[1] for k in seen] == ["Board meeting"]
    r = await post_key_date(client, w, "decider", "remove_key_date", SEEN, key_date_id=kd)
    assert r.status_code == 201, r.text
    assert r.json()["change"]["status"] == "applied"
    assert len(r.json()["change"]["draft_ids"]) == 1
    assert await read_key_dates(client, w, "decider") == []
    # Nothing published moved: the row and a viewer's read are as they were.
    assert await key_date_row(w, kd) == published
    assert await read_key_dates(client, w, "viewer") == seen
    [d] = (await client.get(DRAFTS, headers=w.ctx.as_("decider"))).json()
    r = await client.post(f"{DRAFTS}/{d['id']}/submit", headers=w.ctx.as_("decider"))
    assert r.status_code == 200, r.text
    assert await read_key_dates(client, w, "viewer") == seen
    if r.json()["status"] != "approved":
        r = await client.post(f"{DRAFTS}/{d['id']}/approve", headers=w.ctx.as_("decider"))
        assert r.status_code == 200, r.text
    assert r.json()["status"] == "approved"
    assert await read_key_dates(client, w, "viewer") == []
    assert await key_date_row(w, kd) is None


# --------------------------------------------------------------------------- draft items

FLAG_OPS = {
    "keep_both": ({"kept_both": False}, {"kept_both": True}),
    "confirm_item": ({"draft": True}, {"draft": False}),
}


async def draft_flag_world(op: str):
    """tests.test_simple_dod_changes_api's world for ``op``, its item ``<op>-a`` a published
    draft item (as Oracle's drafting leaves one)."""
    w = await dod_world(ops=[op])
    async with tenant_session(w.ctx.tenant_id) as s:
        (await s.get(RoadmapItem, w.ids[f"{op}-a"])).draft = True
        await s.commit()
    return w


def flag_body(w, op: str) -> dict:
    before, after = FLAG_OPS[op]
    return {"op": op, "target": {"item_id": w.ids[f"{op}-a"]}, "before": before, "after": after}


@pytest.mark.parametrize("op", list(FLAG_OPS))
async def test_draft_flag_ops_wait_in_the_working_draft(client, op):
    w = await draft_flag_world(op)
    field, value = next(iter(FLAG_OPS[op][1].items()))
    published = await snapshot(w, op, published=True)
    seen = (await client.get(ROADMAP, headers=w.ctx.as_("viewer"))).json()["items"]
    r = await client.post(CHANGES, json=flag_body(w, op), headers=w.ctx.as_("decider"))
    assert r.status_code == 201, r.text
    assert r.json()["change"]["status"] == "applied"
    assert len(r.json()["change"]["draft_ids"]) == 1
    working = await snapshot(w, op)
    assert working != published and working["a"][field] == value
    assert await snapshot(w, op, published=True) == published
    assert (await client.get(ROADMAP, headers=w.ctx.as_("viewer"))).json()["items"] == seen
    rows = (await client.get(DRAFTS, headers=w.ctx.as_("owner"))).json()
    assert len(rows) == 1, rows
    d = rows[0]
    r = await client.post(f"{DRAFTS}/{d['id']}/submit", headers=w.ctx.as_("decider"))
    assert r.status_code == 200, r.text
    assert await snapshot(w, op, published=True) == published
    if r.json()["status"] != "approved":
        r = await client.post(f"{DRAFTS}/{d['id']}/approve", headers=w.ctx.as_("decider"))
        assert r.status_code == 200, r.text
    assert r.json()["status"] == "approved"
    old_version = published["a"]["roadmap_version_id"]
    async with tenant_session(w.ctx.tenant_id) as s:
        new = [
            r
            for r in await s.scalars(select(RoadmapItem).where(RoadmapItem.item_key == f"{op}-a"))
            if r.roadmap_version_id not in (None, old_version)
        ]
    assert len(new) == 1 and getattr(new[0], field) == value, [columns(x) for x in new]


@pytest.mark.parametrize("op", list(FLAG_OPS))
async def test_draft_flag_ops_refuse_a_stale_before(client, op):
    w = await draft_flag_world(op)
    r = await client.post(CHANGES, json=flag_body(w, op), headers=w.ctx.as_("decider"))
    assert r.status_code == 201, r.text
    seen = await snapshot(w, op)
    async with tenant_session(w.ctx.tenant_id) as s:
        n = len(list(await s.scalars(select(SimpleChange))))
    r = await client.post(CHANGES, json=flag_body(w, op), headers=w.ctx.as_("owner"))
    if op == "confirm_item":
        # Confirmed already: no longer a draft, so the draft-only guard answers first.
        assert r.status_code == 422 and "Only a draft item" in r.text, r.text
    else:
        assert r.status_code == 409, r.text
        detail = r.json()["detail"]
        assert detail["message"] and detail["current"] == FLAG_OPS[op][1], detail
    assert await snapshot(w, op) == seen
    async with tenant_session(w.ctx.tenant_id) as s:
        assert len(list(await s.scalars(select(SimpleChange)))) == n


async def test_merge_item_returns_the_checker_flags(client):
    w = await AddWorld().build()
    draft = (await w.add(client, "owner", "Import from spreadsheets"))["change"]["target"][
        "item_id"
    ]
    body = {"op": "merge_item", "target": {"item_id": draft, "into_id": w.ids["import-a"]},
            "before": {}, "after": {}}  # fmt: skip
    r = await client.post(CHANGES, json=body, headers=w.as_("approver"))
    assert r.status_code == 201, r.text
    assert r.json()["change"]["status"] == "proposed"
    proposed = {f["item_id"]: f["flags"] for f in r.json()["flags"]}
    r = await client.post(CHANGES, json=body, headers=w.as_("decider"))
    assert r.status_code == 201, r.text
    assert r.json()["change"]["status"] == "applied"
    applied = {f["item_id"]: f["flags"] for f in r.json()["flags"]}
    # The draft, the item it is merged into, and that item's dependent (import-b).
    assert {draft, w.ids["import-a"], w.ids["import-b"]} <= set(applied), applied
    shown = {i["id"]: i["flags"] for i in (await w.items(client, "decider")).values()}
    for item_id, flags in applied.items():
        assert flags == shown[item_id], (item_id, flags, shown.get(item_id))
    assert proposed == applied


async def test_decide_question_returns_no_flags(client):
    from tests.baseline_helpers import make_ctx
    from tests.test_simple_prd_questions import page, seed

    ctx = await make_ctx()
    await seed(ctx)
    qs = {q["code"]: q for q in (await page(client, ctx, "owner"))["questions"]}
    for who, code, status in (("commenter", "Q3", "proposed"), ("owner", "Q4", "applied")):
        r = await client.post(CHANGES, headers=ctx.as_(who), json={
            "op": "decide_question", "target": {"decision_id": qs[code]["id"]},
            "before": {"status": "proposed"}, "after": {"option": "recommended"}})  # fmt: skip
        assert r.status_code == 201, r.text
        assert r.json()["change"]["status"] == status
        assert r.json()["flags"] == []
    # Q4 is decided now: a decide made on the proposed question is stale.
    async with tenant_session(ctx.tenant_id) as s:
        n = len(list(await s.scalars(select(SimpleChange))))
    r = await client.post(CHANGES, headers=ctx.as_("owner"), json={
        "op": "decide_question", "target": {"decision_id": qs["Q4"]["id"]},
        "before": {"status": "proposed"}, "after": {"option": "recommended"}})  # fmt: skip
    assert r.status_code == 409 and "decided already" in r.json()["detail"], r.text
    # A decide made on a status the question no longer has: 409 with its current state.
    r = await client.post(CHANGES, headers=ctx.as_("owner"), json={
        "op": "decide_question", "target": {"decision_id": qs["Q5"]["id"]},
        "before": {"status": "decided"}, "after": {"option": "recommended"}})  # fmt: skip
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["current"]["status"] == "proposed", r.text
    async with tenant_session(ctx.tenant_id) as s:
        assert len(list(await s.scalars(select(SimpleChange)))) == n
