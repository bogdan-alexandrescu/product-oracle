"""Simple S9 (#723, D22): change by chat (``/v1/simple/chat``, ``/v1/simple/meetings/{id}/chat``,
``/v1/simple/chat/cards``, ``/v1/simple/walk``) and the engine's new ops ``set_milestone`` and
``add_feature_ask``. Against Postgres.

S8's oracle.simple.meetings is replaced by a fake module (``meeting_rules``,
``record_meeting_decision``, and S8's real ``set_rules``, ``listing`` and ``one`` with their
own signatures) installed in ``sys.modules``: the chat imports it lazily, so these tests
hold with or without S8's module. People: the four roles
of tests.baseline_helpers plus ``decider``, an approver the roadmap's policy names decider.

Test cards (protects / fails_when / no_claim):

- test_requests_become_cards_for_each_op_family: protects=moves (quarter, day, horizon),
  milestones, feature asks, item tasks, action items, launch tasks, renames and cuts each
  come back as one change card with the exact change-engine op, and asking writes nothing;
  fails_when=a request writes, or a family maps to the wrong op; no_claim=free-form
  wording beyond the documented phrases.
- test_ambiguous_or_unknown_gets_one_question: protects=a name that matches several items,
  none, or a line Oracle does not understand gets one short question and no card;
  fails_when=Oracle guesses an item; no_claim=the question's exact words.
- test_questions_are_answered_from_oracle_data: protects=who owns / who decides / when is
  are answered from the roadmap's data, with no card; fails_when=the answer names the wrong
  person or carries a card; no_claim=sources outside Oracle (never read in a chat).
- test_ask_panel_cards_follow_ones_own_permissions: protects=in the Ask panel the owner's
  Apply applies (the item changes in the working draft; Undo restores it), the commenter's
  proposes (routed to the decider; nothing changes), a viewer's card is not appliable
  (403), and another person's card is not theirs (404); fails_when=a card lets anyone do
  more than their gesture could; no_claim=the panel's screen.
- test_preview_then_discard_leaves_nothing: protects=a card carries its preview (the new
  dates) and discarding it writes no change and leaves the item; a discarded card does
  not apply; fails_when=a preview or discard writes; no_claim=the ghost bar (web spec).
- test_meeting_change_mode_decides_who_applies (everyone / presenter / named): protects=the
  presenter's change mode decides who may apply, and within it the gesture rules (owner
  and decider apply, commenter proposes); a viewer never applies; a non-attendee cannot
  read the thread; fails_when=someone the mode leaves out applies; no_claim=S8's storage.
- test_viewer_in_a_meeting_only_asks: protects=a viewer's change request in a meeting gets
  a note and no card, their question an answer; fails_when=a viewer gets cards;
  no_claim=viewers outside meetings (they get cards they may not apply).
- test_applied_card_is_a_meeting_decision: protects=a card applied in a meeting records
  one meeting decision with its change id; a proposal records none; an ended meeting
  applies nothing; the presenter changes the mode, others may not; fails_when=a decision is
  missing or recorded for a proposal; no_claim=the minutes (S8).
- test_undo_of_a_meeting_card_reverses_its_decision: protects=undoing a card applied in a
  meeting reverses its meeting decision (with a review saying why), so the log and the
  minutes no longer show it as holding; fails_when=the decision stays decided;
  no_claim=S8's minutes screen.
- test_meeting_mode_bars_discard: protects=the change mode that bars someone from applying
  bars them from discarding too; fails_when=a barred attendee discards; no_claim=the
  Ask panel (one person's own cards).
- test_meeting_apply_uses_the_meeting_session: protects=an allowed attendee's Apply goes
  into the meeting's session (made in the meeting), not only the presenter's;
  fails_when=a non-presenter's change goes to their own session; no_claim=S8's session
  rules (its change engine accepts attendees the presenter lets change things).
- test_meeting_fix_is_a_decision_titled_with_the_fix: protects=a fix applied from a
  meeting card is a meeting decision titled with the fix's label; fails_when=the decision
  carries the card's summary; no_claim=the card's own status (open until applied).
- test_walk_lists_only_the_next_meetings_agenda: protects=the walk's agenda step lists
  the open decisions of the next (live) meeting the person attends, labelled with that
  meeting, and none when they attend no meeting; fails_when=a decision on no meeting's
  agenda is called the next meeting's; no_claim=upcoming ritual occurrences (no PRD yet).
- test_meeting_chat_without_meetings_module_is_404: protects=without S8's module the
  meeting chat answers 404; fails_when=it errors or opens; no_claim=S8's own routes.
- test_new_ops_per_role: protects=set_milestone applies for the owner and the decider and
  is proposed by approvers and commenters (nothing written); add_feature_ask files a
  request for every commenter and up, its undo removes it; viewers get 403;
  fails_when=a role does more than its gesture; no_claim=Requests' triage.
- test_walk_order_undo_and_fixes: protects=Walk me through it lists the broken links the
  person decides first, then the next meeting's agenda, then the proposals waiting on
  them; a broken link's card applies a one-click fix and undoes; a commenter has no broken
  links to fix; fails_when=the order differs, or a step is someone else's;
  no_claim=progress and Done (web spec).
"""

import sys
import types
import uuid
from dataclasses import dataclass, field
from datetime import date
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy import func, select

from oracle import company_time
from oracle.auth.models import User
from oracle.decisions.models import Decision, DecisionReview
from oracle.requests.models import ProductRequest
from oracle.review.models import DocumentReviewPolicy
from oracle.roadmap.models import RoadmapItem
from oracle.simple import drafts
from oracle.simple.models import SimpleChange
from oracle.tenancy import tenant_session
from tests.baseline_helpers import Ctx, make_ctx
from tests.test_simple_roadmap_api import NOW, Seed

ASK = "/v1/simple/chat/messages"
CARDS = "/v1/simple/chat/cards"
CHANGES = "/v1/simple/changes"


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


@dataclass
class MeetingRules:
    meeting_id: uuid.UUID
    session_id: uuid.UUID | None
    presenter_id: uuid.UUID
    attendee_ids: list[uuid.UUID]
    change_mode: str
    change_people: list[uuid.UUID] = field(default_factory=list)
    ended: bool = False


class FakeMeetings:
    """S8's contract, in memory."""

    def __init__(self) -> None:
        self.rules: dict[uuid.UUID, MeetingRules] = {}
        self.decisions: list[dict[str, Any]] = []
        self.module = types.ModuleType("oracle.simple.meetings")
        self.module.meeting_rules = self.meeting_rules  # type: ignore[attr-defined]
        self.module.record_meeting_decision = self.record  # type: ignore[attr-defined]
        self.module.set_rules = self.set_rules  # type: ignore[attr-defined]
        self.module.SimpleMeetingRulesIn = SimpleNamespace  # type: ignore[attr-defined]
        self.module.listing = self.listing  # type: ignore[attr-defined]
        self.module.one = self.one  # type: ignore[attr-defined]
        self.titles: dict[uuid.UUID, str] = {}
        self.agenda: dict[uuid.UUID, list[Decision]] = {}

    async def meeting_rules(self, db, meeting_id):
        return self.rules.get(meeting_id)

    async def record(self, db, principal, meeting_id, title, subjects, change_ids):
        """A decided decisions row, as S8's does (origin 'meeting' there)."""
        self.decisions.append({"meeting_id": meeting_id, "title": title, "by": principal.user_id,
                               "subjects": subjects, "change_ids": change_ids})  # fmt: skip
        n = (await db.scalar(select(func.max(Decision.number)))) or 0
        d = Decision(number=n + 1, title=title, approver_id=principal.user_id, driver="oracle",
                     origin="manual", status="decided", chosen_option="decided",
                     rationale="Decided in the meeting", decided_at=NOW,
                     review_at=NOW.date(), decided_by=principal.user_id)  # fmt: skip
        db.add(d)
        await db.flush()
        return d.id

    async def set_rules(self, db, principal, meeting_id, body):
        """S8's ``set_rules(db, principal, meeting_id, SimpleMeetingRulesIn)``."""
        r = self.rules[meeting_id]
        r.change_mode = body.change_mode or r.change_mode
        r.change_people = list(body.change_people or []) if r.change_mode == "named" else []
        return r

    async def listing(self, db, principal):
        live = [SimpleNamespace(id=i, title=self.titles.get(i, "Review"), started_at=NOW,
                                status="live")
                for i, r in self.rules.items() if not r.ended]  # fmt: skip
        return SimpleNamespace(upcoming=[], live=live, past=[])

    async def one(self, db, principal, meeting_id):
        return SimpleNamespace(open_decisions=[
            SimpleNamespace(id=d.id, number=d.number, title=d.title)
            for d in self.agenda.get(meeting_id, [])
        ])  # fmt: skip


@pytest.fixture
def meetings(monkeypatch) -> FakeMeetings:
    fake = FakeMeetings()
    monkeypatch.setitem(sys.modules, "oracle.simple.meetings", fake.module)
    return fake


class World:
    """One roadmap with a decider: Ledger v2 (Oct 1 - Nov 15), Bulk import (Nov 20 - Dec 20,
    after Ledger v2), Partner API (undated), Alert digest and Alert export (dated)."""

    def __init__(self, ctx: Ctx) -> None:
        self.ctx = ctx
        self.ids: dict[str, str] = {}
        self.roadmap_id = ""

    async def build(self, overlap: bool = False) -> "World":
        async with tenant_session(self.ctx.tenant_id) as s:
            seed = Seed(s)
            _, pv, rm, rv = await seed.roadmap("payments")
            self.roadmap_id = str(rm.id)
            track = await seed.track(pv, rm, owner_id=self.ctx.users["approver"].id)
            rows = [
                ("ledger-v2", "Ledger v2", date(2026, 10, 1), date(2026, 11, 15), []),
                ("bulk-import", "Bulk import",
                 date(2026, 11, 10) if overlap else date(2026, 11, 20), date(2026, 12, 20),
                 ["ledger-v2"]),
                ("partner-api", "Partner API", None, None, []),
                ("alert-digest", "Alert digest", date(2026, 11, 1), date(2026, 11, 30), []),
                ("alert-export", "Alert export", date(2026, 12, 1), date(2026, 12, 31), []),
            ]  # fmt: skip
            for i, (key, title, start, end, deps) in enumerate(rows):
                kw: dict[str, Any] = {"start_date": start, "end_date": end}
                if start:
                    kw["date_source"] = "typed"
                row = await seed.item(rv, pv, key, title=title, position=i, track_id=track.id,
                                      depends_on=deps, **kw)  # fmt: skip
                self.ids[title] = str(row.id)
            s.add(DocumentReviewPolicy(document_id=rm.id,
                                       decider_id=self.ctx.users["decider"].id))  # fmt: skip
            await s.commit()
        return self

    async def item(self, title: str) -> RoadmapItem:
        async with tenant_session(self.ctx.tenant_id) as s:
            return await drafts.effective_row(s, await s.get(RoadmapItem, self.ids[title]))


async def make_people() -> Ctx:
    ctx = await make_ctx()
    async with tenant_session(ctx.tenant_id) as s:
        user = User(email="dee@example.com", name="Dee Cider", password_hash="x", role="approver")
        s.add(user)
        await s.commit()
        ctx.users["decider"] = user
    return ctx


async def n_changes(ctx: Ctx) -> int:
    async with tenant_session(ctx.tenant_id) as s:
        return await s.scalar(select(func.count()).select_from(SimpleChange)) or 0


async def say(client, ctx: Ctx, who: str, text: str, meeting: uuid.UUID | None = None) -> dict:
    url = f"/v1/simple/meetings/{meeting}/chat/messages" if meeting else ASK
    r = await client.post(url, json={"text": text}, headers=ctx.as_(who))
    assert r.status_code == 200, r.text
    return r.json()["messages"][-1]


async def card_as(client, ctx: Ctx, who: str, card_id: str, meeting: uuid.UUID | None = None):
    url = f"/v1/simple/meetings/{meeting}/chat" if meeting else "/v1/simple/chat"
    r = await client.get(url, headers=ctx.as_(who))
    assert r.status_code == 200, r.text
    for m in r.json()["messages"]:
        for c in m["cards"]:
            if c["id"] == card_id:
                return c
    raise AssertionError(card_id)


async def test_requests_become_cards_for_each_op_family(client):
    ctx = await make_people()
    w = await World(ctx).build()
    lines = {
        "move Ledger v2 to Q2": "move_dates",
        "move Ledger v2 to March 3": "move_dates",
        "move Partner API to next": "change_horizon",
        "add a milestone 'beta' to Bulk import on March 1": "set_milestone",
        "new feature ask from Example Retail: SSO": "add_feature_ask",
        "add a task 'Draft the email' to Bulk import for commenter by March 5": "add_item_task",
        "action item: approver to send the pricing note by Nov 6 on Ledger v2": "add_action_item",
        "add a launch task 'Tell support' to Ledger v2": "add_launch_task",
        "rename Partner API to Partner API v2": "edit_title",
        "cut Alert export": "cut",
    }
    for line, op in lines.items():
        m = await say(client, ctx, "owner", line)
        assert m["kind"] == "cards", (line, m["body"])
        assert [c["op"] for c in m["cards"]] == [op], line
        assert m["cards"][0]["status"] == "open"
    assert await n_changes(ctx) == 0
    messages = (await client.get("/v1/simple/chat", headers=ctx.as_("owner"))).json()["messages"]
    every = [c for m in messages for c in m["cards"]]
    cards = {c["op"]: c for c in every}
    # Q2 on or after today's quarter (Nov 2026): 2027; the move keeps the length.
    q2 = every[0]
    assert q2["after"] == {"start_date": "2027-04-01", "end_date": "2027-05-16"}
    assert q2["before"] == {"start_date": "2026-10-01", "end_date": "2026-11-15"}
    assert q2["preview"]["kind"] == "dates"
    assert cards["set_milestone"]["after"]["milestone"]["date"] == "2027-03-01"
    assert cards["add_feature_ask"]["after"]["requester_name"] == "Example Retail"
    assert cards["add_item_task"]["after"]["owner_id"] == str(ctx.users["commenter"].id)
    assert cards["add_action_item"]["after"]["due_date"] == "2026-11-06"
    assert cards["add_action_item"]["target"]["item_id"] == w.ids["Ledger v2"]
    assert cards["edit_title"]["preview"] == {
        "kind": "title", "item_id": w.ids["Partner API"], "title": "Partner API v2"}  # fmt: skip
    assert (await w.item("Ledger v2")).start_date == date(2026, 10, 1)


async def test_ambiguous_or_unknown_gets_one_question(client):
    ctx = await make_people()
    await World(ctx).build()
    for line in ("move alert to Q2", "move Nothing like it to Q2", "make it better"):
        m = await say(client, ctx, "owner", line)
        assert m["kind"] == "question", line
        assert m["cards"] == []
    m = await say(client, ctx, "owner", "move alert to Q2")
    assert m["body"] == "Which one: Alert digest or Alert export?"
    r = await client.get("/v1/simple/chat", headers=ctx.as_("owner"))
    assert len(r.json()["messages"]) == 8
    assert await n_changes(ctx) == 0


async def test_questions_are_answered_from_oracle_data(client):
    ctx = await make_people()
    await World(ctx).build()
    owns = await say(client, ctx, "commenter", "who owns Ledger v2?")
    decides = await say(client, ctx, "commenter", "who decides Ledger v2?")
    when = await say(client, ctx, "commenter", "when is Bulk import?")
    assert owns["kind"] == decides["kind"] == when["kind"] == "answer"
    assert "Approver" in owns["body"] or "approver" in owns["body"]
    assert "Dee Cider" in decides["body"]
    assert "20 Nov" in when["body"] and "20 Dec 2026" in when["body"]
    assert owns["cards"] == decides["cards"] == when["cards"] == []


async def test_ask_panel_cards_follow_ones_own_permissions(client):
    ctx = await make_people()
    w = await World(ctx).build()
    # The owner applies, then undoes.
    card = (await say(client, ctx, "owner", "move Ledger v2 to Q2"))["cards"][0]
    assert card["may"] == "apply"
    r = await client.post(f"{CARDS}/{card['id']}/apply", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert r.json()["card"]["status"] == "applied"
    assert r.json()["result"]["change"]["status"] == "applied"
    assert (await w.item("Ledger v2")).start_date == date(2027, 4, 1)
    r = await client.post(f"{CARDS}/{card['id']}/undo", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "undone"
    assert (await w.item("Ledger v2")).start_date == date(2026, 10, 1)
    # The commenter proposes it to the decider; nothing changes.
    card = (await say(client, ctx, "commenter", "rename Partner API to Partner API v2"))["cards"][0]
    assert card["may"] == "propose"
    r = await client.post(f"{CARDS}/{card['id']}/apply", headers=ctx.as_("commenter"))
    assert r.status_code == 200, r.text
    change = r.json()["result"]["change"]
    assert change["status"] == "proposed"
    assert change["routed_to"] == [str(ctx.users["decider"].id)]
    assert r.json()["card"]["status"] == "proposed"
    assert (await w.item("Partner API")).title == "Partner API"
    # A viewer reads; another person's card is not theirs.
    vcard = (await say(client, ctx, "viewer", "cut Alert export"))["cards"][0]
    assert vcard["may"] is None and vcard["why_not"]
    r = await client.post(f"{CARDS}/{vcard['id']}/apply", headers=ctx.as_("viewer"))
    assert r.status_code == 403
    other = (await say(client, ctx, "owner", "cut Alert export"))["cards"][0]
    r = await client.post(f"{CARDS}/{other['id']}/apply", headers=ctx.as_("approver"))
    assert r.status_code == 404
    assert not (await w.item("Alert export")).cut


async def test_preview_then_discard_leaves_nothing(client):
    ctx = await make_people()
    w = await World(ctx).build()
    card = (await say(client, ctx, "owner", "move Ledger v2 to March 3"))["cards"][0]
    assert card["preview"] == {"kind": "dates", "item_id": w.ids["Ledger v2"],
                               "start_date": "2027-03-03", "end_date": "2027-04-17"}  # fmt: skip
    # The constraint check as if applied: Bulk import would start before Ledger v2 ends.
    flagged = {f["item_id"]: [x["kind"] for x in f["flags"]] for f in card["flags"]}
    assert "dependency_order" in flagged.get(w.ids["Bulk import"], [])
    assert {f["op"] for f in card["fixes"]} >= {"shift_dependents", "move_dependency"}
    r = await client.post(f"{CARDS}/{card['id']}/discard", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "discarded"
    assert await n_changes(ctx) == 0
    assert (await w.item("Ledger v2")).start_date == date(2026, 10, 1)
    r = await client.post(f"{CARDS}/{card['id']}/apply", headers=ctx.as_("owner"))
    assert r.status_code == 409
    assert await n_changes(ctx) == 0


def _meeting(ctx: Ctx, fake: FakeMeetings, mode: str, people: tuple[str, ...] = ()) -> uuid.UUID:
    mid = uuid.uuid4()
    u = ctx.users
    fake.rules[mid] = MeetingRules(
        meeting_id=mid, session_id=None, presenter_id=u["owner"].id,
        attendee_ids=[u[r].id for r in ("owner", "decider", "commenter", "viewer")],
        change_mode=mode, change_people=[u[p].id for p in people],
    )  # fmt: skip
    return mid


MAY = {
    "everyone": {"owner": "apply", "decider": "apply", "commenter": "propose", "viewer": None},
    "presenter": {"owner": "apply", "decider": None, "commenter": None, "viewer": None},
    "named": {"owner": "apply", "decider": "apply", "commenter": None, "viewer": None},
}


@pytest.mark.parametrize("mode", ["everyone", "presenter", "named"])
async def test_meeting_change_mode_decides_who_applies(client, meetings, mode):
    ctx = await make_people()
    w = await World(ctx).build()
    mid = _meeting(ctx, meetings, mode, ("decider",) if mode == "named" else ())
    lines = {"owner": "rename Alert export to Alert export A",
             "decider": "rename Alert digest to Alert digest B",
             "commenter": "rename Partner API to Partner API C"}  # fmt: skip
    cards = {}
    for who, line in lines.items():
        cards[who] = (await say(client, ctx, "owner", line, mid))["cards"][0]["id"]
    for who, may in MAY[mode].items():
        c = await card_as(client, ctx, who, cards["owner"], mid)
        assert c["may"] == may, (mode, who)
        assert (c["why_not"] is None) == (may is not None), (mode, who)
    for who in ("decider", "commenter"):
        r = await client.post(f"{CARDS}/{cards[who]}/apply", headers=ctx.as_(who))
        if MAY[mode][who] is None:
            assert r.status_code == 403, (mode, who, r.text)
        else:
            assert r.status_code == 200, r.text
            assert r.json()["result"]["change"]["status"] == (
                "applied" if MAY[mode][who] == "apply" else "proposed"
            )
    r = await client.post(f"{CARDS}/{cards['owner']}/apply", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert (await w.item("Alert export")).title == "Alert export A"
    # Not an attendee: no thread, no card.
    r = await client.get(f"/v1/simple/meetings/{mid}/chat", headers=ctx.as_("approver"))
    assert r.status_code == 403


async def test_viewer_in_a_meeting_only_asks(client, meetings):
    ctx = await make_people()
    await World(ctx).build()
    mid = _meeting(ctx, meetings, "everyone")
    m = await say(client, ctx, "viewer", "cut Ledger v2", mid)
    assert m["kind"] == "note" and m["cards"] == []
    m = await say(client, ctx, "viewer", "who decides Ledger v2?", mid)
    assert m["kind"] == "answer" and "Dee Cider" in m["body"]
    r = await client.get(f"/v1/simple/meetings/{mid}/chat", headers=ctx.as_("viewer"))
    rules = r.json()["rules"]
    assert rules["ask_only"] is True and rules["may_apply"] is False
    # The thread is shared: the owner reads the viewer's lines.
    r = await client.get(f"/v1/simple/meetings/{mid}/chat", headers=ctx.as_("owner"))
    assert [m["body"] for m in r.json()["messages"] if m["author_kind"] == "person"] == [
        "cut Ledger v2", "who decides Ledger v2?"]  # fmt: skip
    assert await n_changes(ctx) == 0


async def test_applied_card_is_a_meeting_decision(client, meetings):
    ctx = await make_people()
    w = await World(ctx).build()
    mid = _meeting(ctx, meetings, "everyone")
    card = (await say(client, ctx, "commenter", "move Partner API to later", mid))["cards"][0]
    r = await client.post(f"{CARDS}/{card['id']}/apply", headers=ctx.as_("commenter"))
    assert r.json()["result"]["change"]["status"] == "proposed"
    assert meetings.decisions == []
    card = (await say(client, ctx, "decider", "move Ledger v2 to Q2", mid))["cards"][0]
    r = await client.post(f"{CARDS}/{card['id']}/apply", headers=ctx.as_("decider"))
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["card"]["decision_id"] is not None
    assert len(meetings.decisions) == 1
    d = meetings.decisions[0]
    assert d["meeting_id"] == mid and d["by"] == ctx.users["decider"].id
    assert d["change_ids"] == [uuid.UUID(out["result"]["change"]["id"])]
    assert d["subjects"] == [{"kind": "roadmap_item", "id": w.ids["Ledger v2"]}]
    # The presenter changes the mode; nobody else may.
    body = {"change_mode": "named", "change_people": [str(ctx.users["decider"].id)]}
    r = await client.put(f"/v1/simple/meetings/{mid}/chat/mode", json=body,
                         headers=ctx.as_("commenter"))  # fmt: skip
    assert r.status_code == 403
    r = await client.put(f"/v1/simple/meetings/{mid}/chat/mode", json=body,
                         headers=ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 200, r.text
    assert r.json()["change_mode"] == "named"
    assert [p["name"] for p in r.json()["change_people"]] == ["Dee Cider"]
    # An ended meeting applies nothing.
    card = (await say(client, ctx, "owner", "cut Alert export", mid))["cards"][0]
    meetings.rules[mid].ended = True
    r = await client.post(f"{CARDS}/{card['id']}/apply", headers=ctx.as_("owner"))
    assert r.status_code == 403
    assert len(meetings.decisions) == 1


async def test_undo_of_a_meeting_card_reverses_its_decision(client, meetings):
    ctx = await make_people()
    w = await World(ctx).build()
    mid = _meeting(ctx, meetings, "everyone")
    card = (await say(client, ctx, "owner", "move Ledger v2 to Q2", mid))["cards"][0]
    r = await client.post(f"{CARDS}/{card['id']}/apply", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    decision_id = uuid.UUID(r.json()["card"]["decision_id"])
    r = await client.post(f"{CARDS}/{card['id']}/undo", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "undone"
    assert (await w.item("Ledger v2")).start_date == date(2026, 10, 1)
    async with tenant_session(ctx.tenant_id) as s:
        d = await s.get(Decision, decision_id)
        assert d is not None and d.status == "reversed"
        review = await s.scalar(select(DecisionReview).where(DecisionReview.decision_id == d.id))
        assert review is not None and review.verdict == "reversed"
        assert review.reviewed_by == ctx.users["owner"].id


async def test_meeting_mode_bars_discard(client, meetings):
    ctx = await make_people()
    await World(ctx).build()
    mid = _meeting(ctx, meetings, "presenter")
    card = (await say(client, ctx, "owner", "cut Alert export", mid))["cards"][0]
    # Presenter only: the commenter may neither apply nor discard.
    r = await client.post(f"{CARDS}/{card['id']}/discard", headers=ctx.as_("commenter"))
    assert r.status_code == 403, r.text
    assert (await card_as(client, ctx, "owner", card["id"], mid))["status"] == "open"
    r = await client.post(f"{CARDS}/{card['id']}/discard", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text


async def test_meeting_apply_uses_the_meeting_session(client, meetings, monkeypatch):
    from oracle.simple import changes

    ctx = await make_people()
    await World(ctx).build()
    mid = _meeting(ctx, meetings, "everyone")
    session_id = uuid.uuid4()
    meetings.rules[mid].session_id = session_id
    card = (await say(client, ctx, "owner", "cut Alert export", mid))["cards"][0]
    tried: list[uuid.UUID | None] = []
    create = changes.create

    async def spy(db, principal, body):
        tried.append(body.session_id)
        return await create(db, principal, body)

    monkeypatch.setattr(changes, "create", spy)
    # The decider is not the presenter: their Apply still goes into the meeting's session
    # (this branch's engine has no meeting sessions, so it falls back to their own).
    r = await client.post(f"{CARDS}/{card['id']}/apply", headers=ctx.as_("decider"))
    assert r.status_code == 200, r.text
    assert tried[0] == session_id


async def test_meeting_fix_is_a_decision_titled_with_the_fix(client, meetings):
    ctx = await make_people()
    await World(ctx).build(overlap=True)
    mid = _meeting(ctx, meetings, "everyone")
    card = (await say(client, ctx, "owner", "rename Ledger v2 to Ledger v3", mid))["cards"][0]
    assert card["fixes"], card
    label = card["fixes"][0]["label"]
    r = await client.post(f"{CARDS}/{card['id']}/apply", json={"fix": 0},
                          headers=ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 200, r.text
    assert meetings.decisions[-1]["title"] == label


async def _proposed_decisions(ctx: Ctx, *titles: str) -> list[Decision]:
    async with tenant_session(ctx.tenant_id) as s:
        dee = ctx.users["decider"].id
        for i, t in enumerate(titles, start=1):
            s.add(Decision(number=i, title=t, approver_id=dee, driver="oracle",
                           origin="manual"))  # fmt: skip
        await s.commit()
        return list(await s.scalars(select(Decision).order_by(Decision.number)))


async def test_walk_lists_only_the_next_meetings_agenda(client, meetings):
    ctx = await make_people()
    await World(ctx).build()
    on, off = await _proposed_decisions(ctx, "Pick the import format", "Name the API")
    r = await client.get("/v1/simple/walk", headers=ctx.as_("decider"))
    assert r.status_code == 200, r.text
    assert [s for s in r.json()["steps"] if s["kind"] == "agenda_decision"] == []
    mid = _meeting(ctx, meetings, "everyone")
    meetings.titles[mid] = "Payments review"
    meetings.agenda[mid] = [on]
    steps = (await client.get("/v1/simple/walk", headers=ctx.as_("decider"))).json()["steps"]
    agenda = [s for s in steps if s["kind"] == "agenda_decision"]
    assert [s["decision"]["title"] for s in agenda] == ["Pick the import format"]
    assert "Payments review" in agenda[0]["why"]
    # Not an attendee: that meeting's agenda is not theirs.
    steps = (await client.get("/v1/simple/walk", headers=ctx.as_("approver"))).json()["steps"]
    assert [s for s in steps if s["kind"] == "agenda_decision"] == []
    assert off.title == "Name the API"


async def test_meeting_chat_without_meetings_module_is_404(client, monkeypatch):
    monkeypatch.setitem(sys.modules, "oracle.simple.meetings", None)
    ctx = await make_people()
    mid = uuid.uuid4()
    r = await client.get(f"/v1/simple/meetings/{mid}/chat", headers=ctx.as_("owner"))
    assert r.status_code == 404
    r = await client.post(f"/v1/simple/meetings/{mid}/chat/messages", json={"text": "hi"},
                          headers=ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 404


@pytest.mark.parametrize("role", ["owner", "decider", "approver", "commenter", "viewer"])
async def test_new_ops_per_role(client, role):
    ctx = await make_people()
    w = await World(ctx).build()
    milestone = {"name": "beta", "date": "2027-03-01", "date_source": "typed"}
    body = {"op": "set_milestone", "target": {"item_id": w.ids["Bulk import"]},
            "before": {"milestone": None}, "after": {"milestone": milestone}}  # fmt: skip
    r = await client.post(CHANGES, json=body, headers=ctx.as_(role))
    ask = {"op": "add_feature_ask", "target": {}, "before": {},
           "after": {"title": "SSO", "requester_name": "Example Retail"}}  # fmt: skip
    r2 = await client.post(CHANGES, json=ask, headers=ctx.as_(role))
    async with tenant_session(ctx.tenant_id) as s:
        asks = list(await s.scalars(select(ProductRequest)))
    if role == "viewer":
        assert r.status_code == r2.status_code == 403
        assert asks == []
        return
    assert r.status_code == 201, r.text
    applies = role in ("owner", "decider")
    assert r.json()["change"]["status"] == ("applied" if applies else "proposed")
    got = (await w.item("Bulk import")).milestone
    assert got == (milestone if applies else None)
    assert r2.status_code == 201, r2.text
    assert r2.json()["change"]["status"] == "applied"
    assert [(a.title, a.requester_name, a.requester_kind, a.state) for a in asks] == [
        ("SSO", "Example Retail", "customer", "new")]  # fmt: skip
    r = await client.post(f"{CHANGES}/{r2.json()['change']['id']}/undo", headers=ctx.as_(role))
    assert r.status_code == 201, r.text
    async with tenant_session(ctx.tenant_id) as s:
        assert list(await s.scalars(select(ProductRequest))) == []


async def test_walk_order_undo_and_fixes(client, meetings):
    ctx = await make_people()
    w = await World(ctx).build(overlap=True)
    mid = _meeting(ctx, meetings, "everyone")
    meetings.agenda[mid] = await _proposed_decisions(ctx, "Pick the import format")
    body = {"op": "edit_title", "target": {"item_id": w.ids["Partner API"]},
            "before": {"title": "Partner API"}, "after": {"title": "Partner API v2"}}  # fmt: skip
    r = await client.post(CHANGES, json=body, headers=ctx.as_("commenter"))
    assert r.json()["change"]["status"] == "proposed"
    r = await client.get("/v1/simple/walk", headers=ctx.as_("decider"))
    assert r.status_code == 200, r.text
    steps = r.json()["steps"]
    assert [s["kind"] for s in steps] == ["broken_link", "agenda_decision", "proposal"]
    link = steps[0]["card"]
    assert link["op"] == "shift_dependents" and link["may"] == "apply"
    assert [f["op"] for f in link["fixes"]] == ["shift_dependents", "move_dependency",
                                                "accept_risk"]  # fmt: skip
    assert steps[1]["decision"]["title"] == "Pick the import format"
    assert steps[2]["change"]["can_decide"] is True
    # The same walk again reuses the card.
    again = (await client.get("/v1/simple/walk", headers=ctx.as_("decider"))).json()["steps"]
    assert again[0]["card"]["id"] == link["id"]
    r = await client.post(f"{CARDS}/{link['id']}/apply", headers=ctx.as_("decider"))
    assert r.status_code == 200, r.text
    assert (await w.item("Bulk import")).start_date == date(2026, 11, 16)
    after = (await client.get("/v1/simple/walk", headers=ctx.as_("decider"))).json()["steps"]
    assert [s["kind"] for s in after] == ["agenda_decision", "proposal"]
    r = await client.post(f"{CARDS}/{link['id']}/undo", headers=ctx.as_("decider"))
    assert r.status_code == 200, r.text
    assert (await w.item("Bulk import")).start_date == date(2026, 11, 10)
    # A commenter decides nothing here: only the agenda of the meeting they attend.
    r = await client.get("/v1/simple/walk", headers=ctx.as_("commenter"))
    assert [s["kind"] for s in r.json()["steps"]] == ["agenda_decision"]
