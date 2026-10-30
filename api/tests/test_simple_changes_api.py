"""Simple S3a (#723): the change engine (``/v1/simple/sessions``, ``/v1/simple/changes``).
Against Postgres.

Each test seeds a roadmap through the models and acts as a person of the company would,
over REST. The company's clock is fixed (``company_time.now``, tests.test_simple_roadmap_api).
People: the four roles of tests.baseline_helpers plus ``decider``, an approver the roadmap's
review policy names its decider (when the test gives the roadmap one).

Test cards (protects / fails_when / no_claim):

- test_permission_matrix (op x role, with and without a decider): protects=owners and the
  roadmap's decider apply every op (the item changes); approvers and commenters propose
  (nothing changes; routed to the decider, else the company's owners); viewers get 403;
  fails_when=a role applies that may only propose, a proposal writes, or a viewer is let
  in; no_claim=that the published rows stay (S3b, tests/test_simple_drafts_api.py).
- test_proposal_routes_to_the_track_owner_without_a_decider: protects=with no decider a
  proposal goes to the roadmap's owner (its track's owner), who applies directly;
  fails_when=it goes to the company's owners instead; no_claim=the web.
- test_stale_before_is_409: protects=a change whose ``before`` differs from the stored
  values answers 409 with the current values and who changed them last, and writes
  nothing (no change row, no item change); fails_when=a stale change lands;
  no_claim=changes made outside Simple name no one.
- test_undo_rules: protects=undo is its author's only, in its session only (a closed
  session refuses), only while the target still has the change's ``after`` (409 with the
  current values); a good undo restores ``before`` and writes an ``undone`` row, keeping
  the original; a second undo is 409; fails_when=any of these is let through or history
  is deleted; no_claim=undo of an accepted proposal.
- test_proposal_accept_decline_and_outdated: protects=the decider accepts (the item
  changes, status accepted) or declines (with a reason, the item stays); an approver
  who does not decide gets 403; a proposal whose ``before`` no longer holds answers 409
  "outdated: changed by X"; the decider's Inbox lists open proposals and the proposer's
  lists the decisions; fails_when=either way; no_claim=the Inbox screen.
- test_constraint_flags_returned: protects=an applied change and a proposal both return
  the touched items' flags (a proposal's as if applied) from S2's checker;
  fails_when=the flags are missing or stale; no_claim=the flags' wording (S2's tests).
- test_idle_sessions_close_on_the_tick: protects=the minute tick closes an editing
  session idle 30 minutes and leaves a recent one open; a closed session takes no
  change (409); one open editing session per person is reused; fails_when=either way;
  no_claim=the scheduled ticker's lock.
- test_fixes_shift_dependents_and_move_dependency: protects=shift_dependents moves the
  flagged item (and its own dependents that would now overlap) to start the day after its
  dependency ends, keeping durations; move_dependency ends the dependency the day before
  the item starts, keeping its duration; the dependency_order flag clears; undo restores
  every moved item; fails_when=a duration changes, a cascade is missed or the flag stays;
  no_claim=blocker or milestone fixes (accept_risk only).
- test_list_filters_audit_and_tools: protects=GET /v1/simple/changes filters by session,
  document, status and mine; every change writes an audit event; the routes are MCP tools
  by operationId; fails_when=a filter is ignored, an audit event is missing or a route has
  no tool; no_claim=MCP scopes for runs (Simple is not for runs).
"""

from datetime import date, timedelta
from typing import Any

import pytest
from sqlalchemy import select, text

from oracle import company_time
from oracle.auth.models import User
from oracle.review.models import DocumentReviewPolicy
from oracle.roadmap.models import RoadmapItem
from oracle.simple import drafts, suggestions
from oracle.simple.models import RoadmapDateSuggestion
from oracle.tenancy import tenant_session
from tests.baseline_helpers import Ctx, make_ctx
from tests.test_simple_roadmap_api import NOW, Seed

SESSIONS = "/v1/simple/sessions"
CHANGES = "/v1/simple/changes"
OPS = [
    "move_dates",
    "change_horizon",
    "reorder",
    "cut",
    "restore",
    "edit_title",
    "edit_outcome",
    "accept_date_suggestion",
    "accept_risk",
    "shift_dependents",
    "move_dependency",
]
A = {"start_date": "2026-10-01", "end_date": "2026-11-15"}
B = {"start_date": "2026-11-10", "end_date": "2026-12-15"}


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    moment = {"now": NOW}
    monkeypatch.setattr(company_time, "now", lambda: moment["now"])
    return moment


def seeded_title(key: str) -> str:
    return key.replace("-", " ").title()


async def make_people() -> Ctx:
    ctx = await make_ctx()
    async with tenant_session(ctx.tenant_id) as s:
        user = User(email="decider@example.com", name="Dee Cider", password_hash="x",
                    role="approver")  # fmt: skip
        s.add(user)
        await s.commit()
        ctx.users["decider"] = user
    return ctx


class World:
    """One roadmap: per op an item ``<op>-a`` (Oct 1 - Nov 15) and ``<op>-b`` (Nov 10 -
    Dec 15) that depends on it, and ``<op>-u``, undated, with an open date suggestion."""

    def __init__(self, ctx: Ctx) -> None:
        self.ctx = ctx
        self.ids: dict[str, str] = {}
        self.roadmap_id = ""
        self.suggestion: dict[str, str] = {}

    async def build(self, *, decider: bool, track_owner: str | None = None, ops=OPS) -> "World":
        async with tenant_session(self.ctx.tenant_id) as s:
            seed = Seed(s)
            _, pv, rm, rv = await seed.roadmap("payments")
            self.roadmap_id = str(rm.id)
            owner_id = self.ctx.users[track_owner].id if track_owner else None
            track = await seed.track(pv, rm, owner_id=owner_id)
            for i, op in enumerate(ops):
                a = await seed.item(rv, pv, f"{op}-a", position=3 * i, track_id=track.id,
                                    start_date=date(2026, 10, 1), end_date=date(2026, 11, 15),
                                    date_source="typed")  # fmt: skip
                b = await seed.item(rv, pv, f"{op}-b", position=3 * i + 1, track_id=track.id,
                                    start_date=date(2026, 11, 10), end_date=date(2026, 12, 15),
                                    date_source="typed", depends_on=[f"{op}-a"])  # fmt: skip
                u = await seed.item(rv, pv, f"{op}-u", position=3 * i + 2, track_id=track.id)
                for row in (a, b, u):
                    self.ids[row.item_key] = str(row.id)
            if decider:
                s.add(DocumentReviewPolicy(document_id=rm.id,
                                           decider_id=self.ctx.users["decider"].id))  # fmt: skip
            await s.commit()
            await suggestions.regenerate(s)
            await s.commit()
            for sg in await s.scalars(select(RoadmapDateSuggestion)):
                key = next(k for k, v in self.ids.items() if v == str(sg.item_id))
                self.suggestion[key] = str(sg.id)
        return self

    async def item(self, key: str) -> RoadmapItem:
        """The item as its roadmap's open draft has it (S3b: applied changes go there)."""
        async with tenant_session(self.ctx.tenant_id) as s:
            return await drafts.effective_row(s, await s.get(RoadmapItem, self.ids[key]))

    def body(self, op: str, **over: Any) -> dict[str, Any]:
        a, b, u = (self.ids[f"{op}-{x}"] for x in "abu")
        bodies: dict[str, dict[str, Any]] = {
            "move_dates": {"target": {"item_id": a}, "before": A,
                           "after": {"start_date": "2026-10-05", "end_date": "2026-11-20"}},
            "change_horizon": {"target": {"item_id": a}, "before": {"horizon": "now"},
                               "after": {"horizon": "next"}},
            "reorder": {"target": {"item_id": a}, "before": {"position": OPS.index(op) * 3},
                        "after": {"position": 99}},
            "cut": {"target": {"item_id": a}, "before": {"cut": False}, "after": {"cut": True}},
            "restore": {"target": {"item_id": a}, "before": {"cut": True},
                        "after": {"cut": False}},
            "edit_title": {"target": {"item_id": a}, "before": {"title": seeded_title(f"{op}-a")},
                           "after": {"title": "Ledger v2"}},
            "edit_outcome": {"target": {"item_id": a}, "before": {"outcome": None},
                             "after": {"outcome": "Half the support tickets"}},
            "accept_date_suggestion": {
                "target": {"item_id": u, "suggestion_id": self.suggestion.get(f"{op}-u")},
                "before": {"start_date": None, "end_date": None}, "after": {}},
            "accept_risk": {"target": {"item_id": b, "flag": "dependency_order", "subject": a},
                            "before": {"risk": None},
                            "after": {"risk": {"note": "The overlap is the beta week"}}},
            "shift_dependents": {"target": {"item_id": b, "subject": a},
                                 "before": {b: B, a: A}, "after": {}},
            "move_dependency": {"target": {"item_id": b, "subject": a},
                                "before": {b: B, a: A}, "after": {}},
        }  # fmt: skip
        return {"op": op, **bodies[op], **over}

    async def post(self, client, who: str, op: str, **over: Any):
        return await client.post(CHANGES, json=self.body(op, **over), headers=self.ctx.as_(who))


async def changed(w: World, op: str) -> bool:
    """Whether the op's effect is on the items."""
    a, b, u = [await w.item(f"{op}-{x}") for x in "abu"]
    match op:
        case "move_dates":
            return (a.start_date, a.end_date) == (date(2026, 10, 5), date(2026, 11, 20))
        case "change_horizon":
            return a.horizon == "next"
        case "reorder":
            return a.position == 99
        case "cut":
            return a.cut is True
        case "restore":
            return a.cut is False
        case "edit_title":
            return a.title == "Ledger v2"
        case "edit_outcome":
            return a.outcome == "Half the support tickets"
        case "accept_date_suggestion":
            return u.start_date is not None and u.date_source == "accepted"
        case "accept_risk":
            return [r.get("note") for r in b.accepted_risks] == ["The overlap is the beta week"]
        case "shift_dependents":
            return b.start_date == date(2026, 11, 16)
        case "move_dependency":
            return a.end_date == date(2026, 11, 9)
    raise AssertionError(op)


@pytest.mark.parametrize("with_decider", [True, False], ids=["decider", "no-decider"])
@pytest.mark.parametrize("role", ["owner", "decider", "approver", "commenter", "viewer"])
async def test_permission_matrix(client, role, with_decider):
    ctx = await make_people()
    w = await World(ctx).build(decider=with_decider)
    # restore needs a cut item first: cut in the published version (S3b: an owner's cut
    # through Simple waits in a draft that proposers may not see).
    async with tenant_session(ctx.tenant_id) as s:
        (await s.get(RoadmapItem, w.ids["restore-a"])).cut = True
        await s.commit()
    applies = role == "owner" or (role == "decider" and with_decider)
    routed = [str(ctx.users["decider"].id)] if with_decider else [str(ctx.users["owner"].id)]
    for op in OPS:
        r = await w.post(client, role, op)
        if role == "viewer":
            assert r.status_code == 403, (op, r.text)
            assert not await changed(w, op), op
            continue
        assert r.status_code == 201, (op, r.text)
        change = r.json()["change"]
        assert change["op"] == op
        assert change["status"] == ("applied" if applies else "proposed"), op
        assert change["document_id"] == w.roadmap_id
        # A proposed restore leaves the owner's cut in place.
        assert await changed(w, op) is applies, op
        if not applies:
            assert change["routed_to"] == routed, op


async def test_proposal_routes_to_the_track_owner_without_a_decider(client):
    ctx = await make_people()
    w = await World(ctx).build(decider=False, track_owner="approver", ops=["edit_title"])
    r = await w.post(client, "commenter", "edit_title")
    assert r.status_code == 201, r.text
    assert r.json()["change"]["status"] == "proposed"
    assert r.json()["change"]["routed_to"] == [str(ctx.users["approver"].id)]
    r = await w.post(client, "approver", "edit_title")
    assert r.json()["change"]["status"] == "applied"


async def test_stale_before_is_409(client):
    ctx = await make_people()
    w = await World(ctx).build(decider=True, ops=["edit_title"])
    first = await w.post(client, "decider", "edit_title")
    assert first.status_code == 201, first.text
    before_rows = (await client.get(CHANGES, headers=ctx.as_("owner"))).json()
    r = await w.post(client, "owner", "edit_title", after={"title": "Ledger v3"})
    assert r.status_code == 409, r.text
    detail = r.json()["detail"]
    assert detail["current"] == {"title": "Ledger v2"}
    assert detail["changed_by"]["id"] == str(ctx.users["decider"].id)
    assert "Dee Cider" in detail["message"]
    assert (await w.item("edit_title-a")).title == "Ledger v2"
    after_rows = (await client.get(CHANGES, headers=ctx.as_("owner"))).json()
    assert len(after_rows) == len(before_rows)
    # A missing before field is refused too (422), never treated as "anything".
    r = await w.post(client, "owner", "edit_title", before={})
    assert r.status_code == 422, r.text


async def test_undo_rules(client):
    ctx = await make_people()
    w = await World(ctx).build(decider=True, ops=["edit_title", "move_dates"])
    change = (await w.post(client, "decider", "edit_title")).json()["change"]
    undo = f"{CHANGES}/{change['id']}/undo"
    # Not its author.
    assert (await client.post(undo, headers=ctx.as_("owner"))).status_code == 403
    # The target changed since: 409 with the current values.
    other = await w.post(client, "owner", "edit_title", before={"title": "Ledger v2"},
                         after={"title": "Ledger v3"})  # fmt: skip
    assert other.status_code == 201, other.text
    r = await client.post(undo, headers=ctx.as_("decider"))
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["current"] == {"title": "Ledger v3"}
    # The owner undoes their own: the decider's title is back.
    r = await client.post(f"{CHANGES}/{other.json()['change']['id']}/undo",
                          headers=ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 201, r.text
    undone = r.json()["change"]
    assert undone["status"] == "undone"
    assert undone["undoes_id"] == other.json()["change"]["id"]
    assert (await w.item("edit_title-a")).title == "Ledger v2"
    # A second undo of the same change: 409.
    again = await client.post(f"{CHANGES}/{other.json()['change']['id']}/undo",
                              headers=ctx.as_("owner"))  # fmt: skip
    assert again.status_code == 409
    # Now the decider's own undo works: the title is its seeded one again.
    r = await client.post(undo, headers=ctx.as_("decider"))
    assert r.status_code == 201, r.text
    assert (await w.item("edit_title-a")).title == "Edit_Title A"
    # History is kept: 2 applied + 2 undone.
    rows = (await client.get(CHANGES, headers=ctx.as_("owner"))).json()
    assert sorted(c["status"] for c in rows) == ["applied", "applied", "undone", "undone"]
    # Only in its session: once the session is closed, undo is refused.
    moved = (await w.post(client, "decider", "move_dates")).json()["change"]
    closed = await client.post(f"{SESSIONS}/{moved['session_id']}/close",
                               headers=ctx.as_("decider"))  # fmt: skip
    assert closed.status_code == 200, closed.text
    r = await client.post(f"{CHANGES}/{moved['id']}/undo", headers=ctx.as_("decider"))
    assert r.status_code == 409, r.text
    assert (await w.item("move_dates-a")).start_date == date(2026, 10, 5)


async def test_proposal_accept_decline_and_outdated(client):
    ctx = await make_people()
    w = await World(ctx).build(decider=True, ops=["edit_title", "move_dates"])
    proposal = (await w.post(client, "commenter", "edit_title")).json()["change"]
    assert proposal["status"] == "proposed" and proposal["session_id"] is None
    inbox = (await client.get("/v1/inbox", headers=ctx.as_("decider"))).json()
    assert [p["id"] for p in inbox["simple_proposals"]] == [proposal["id"]]
    assert (await client.get("/v1/inbox", headers=ctx.as_("approver"))).json()[
        "simple_proposals"
    ] == []
    accept = f"{CHANGES}/{proposal['id']}/accept"
    assert (await client.post(accept, json={}, headers=ctx.as_("approver"))).status_code == 403
    r = await client.post(accept, json={}, headers=ctx.as_("decider"))
    assert r.status_code == 200, r.text
    assert r.json()["change"]["status"] == "accepted"
    assert r.json()["change"]["decided_by"] == str(ctx.users["decider"].id)
    assert (await w.item("edit_title-a")).title == "Ledger v2"
    assert (await client.post(accept, json={}, headers=ctx.as_("decider"))).status_code == 409
    # Declined with a reason: nothing changes.
    second = (await w.post(client, "commenter", "move_dates")).json()["change"]
    r = await client.post(f"{CHANGES}/{second['id']}/decline",
                          json={"reason": "Q4 is full"}, headers=ctx.as_("decider"))  # fmt: skip
    assert r.status_code == 200, r.text
    assert r.json()["change"]["status"] == "declined"
    assert r.json()["change"]["decision_reason"] == "Q4 is full"
    assert (await w.item("move_dates-a")).start_date == date(2026, 10, 1)
    mine = (await client.get("/v1/inbox", headers=ctx.as_("commenter"))).json()
    assert {(d["id"], d["status"]) for d in mine["simple_decisions"]} == {
        (proposal["id"], "accepted"),
        (second["id"], "declined"),
    }
    # Outdated: the decider moved the item after the proposal.
    third = (await w.post(client, "approver", "move_dates")).json()["change"]
    direct = await w.post(client, "decider", "move_dates",
                          after={"start_date": "2026-10-02", "end_date": "2026-11-16"})  # fmt: skip
    assert direct.status_code == 201, direct.text
    r = await client.post(f"{CHANGES}/{third['id']}/accept", json={}, headers=ctx.as_("owner"))
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["message"].startswith("outdated: changed by Dee Cider")
    assert (await w.item("move_dates-a")).start_date == date(2026, 10, 2)


async def test_constraint_flags_returned(client):
    ctx = await make_people()
    w = await World(ctx).build(decider=True, ops=["move_dates"])
    b = w.ids["move_dates-b"]
    # The proposal's flags are as if applied: b starting Oct 20 overlaps a (ends Nov 15).
    body = w.body("move_dates", target={"item_id": b}, before=B,
                  after={"start_date": "2026-11-20", "end_date": "2026-12-20"})  # fmt: skip
    r = await client.post(CHANGES, json=body, headers=ctx.as_("commenter"))
    assert r.status_code == 201, r.text
    flags = {f["item_id"]: f["flags"] for f in r.json()["flags"]}
    assert flags[b] == []
    body["after"] = {"start_date": "2026-10-20", "end_date": "2026-12-20"}
    r = await client.post(CHANGES, json=body, headers=ctx.as_("decider"))
    assert r.status_code == 201, r.text
    flags = {f["item_id"]: f["flags"] for f in r.json()["flags"]}
    (flag,) = flags[b]
    assert (flag["kind"], flag["state"]) == ("dependency_order", "red")
    assert "Oct 20" in flag["reason"]


async def test_idle_sessions_close_on_the_tick(client, clock):
    from oracle.ticker.body import tick_company

    ctx = await make_people()
    w = await World(ctx).build(decider=True, ops=["edit_title"])
    r = await client.post(SESSIONS, json={"kind": "editing"}, headers=ctx.as_("decider"))
    assert r.status_code == 200, r.text
    session = r.json()
    again = await client.post(SESSIONS, json={"kind": "editing"}, headers=ctx.as_("decider"))
    assert again.json()["id"] == session["id"]
    meeting = await client.post(SESSIONS, json={"kind": "meeting"}, headers=ctx.as_("decider"))
    assert meeting.json()["id"] != session["id"]
    assert (
        await client.post(SESSIONS, json={"kind": "editing"}, headers=ctx.as_("viewer"))
    ).status_code == 403
    assert (
        await client.post(f"{SESSIONS}/{session['id']}/close", headers=ctx.as_("owner"))
    ).status_code == 403
    owner_session = (
        await client.post(SESSIONS, json={"kind": "editing"}, headers=ctx.as_("owner"))
    ).json()
    clock["now"] = NOW + timedelta(minutes=20)
    # The owner works at minute 20: their session stays open at minute 31.
    r = await w.post(client, "owner", "edit_title", session_id=owner_session["id"])
    assert r.status_code == 201, r.text
    clock["now"] = NOW + timedelta(minutes=31)
    async with tenant_session(ctx.tenant_id) as s:
        await tick_company(s, ctx.tenant_id)
    current = await client.get(f"{SESSIONS}/current", headers=ctx.as_("decider"))
    assert current.status_code == 200 and current.json() is None
    mine = (await client.get(f"{SESSIONS}/current", headers=ctx.as_("owner"))).json()
    assert mine["id"] == owner_session["id"] and mine["closed_at"] is None
    r = await w.post(client, "decider", "edit_title", session_id=session["id"],
                     before={"title": "Ledger v2"}, after={"title": "Ledger v3"})  # fmt: skip
    assert r.status_code == 409, r.text
    # Without a session id the person's open editing session is used (a new one).
    r = await w.post(client, "decider", "edit_title",
                     before={"title": "Ledger v2"}, after={"title": "Ledger v3"})  # fmt: skip
    assert r.status_code == 201, r.text
    assert r.json()["change"]["session_id"] not in (session["id"], None)


async def test_fixes_shift_dependents_and_move_dependency(client):
    ctx = await make_people()
    w = await World(ctx).build(decider=True, ops=["shift_dependents", "move_dependency"])
    # c depends on shift_dependents-b and starts the day after b ends: shifting b moves it.
    async with tenant_session(ctx.tenant_id) as s:
        b = await s.get(RoadmapItem, w.ids["shift_dependents-b"])
        c = RoadmapItem(roadmap_document_id=b.roadmap_document_id,
                        roadmap_version_id=b.roadmap_version_id, item_key="shift_dependents-c",
                        position=50, title="Rollout", horizon="now",
                        start_date=date(2026, 12, 16), end_date=date(2026, 12, 31),
                        date_source="typed", depends_on=["shift_dependents-b"])  # fmt: skip
        s.add(c)
        await s.commit()
        w.ids["shift_dependents-c"] = str(c.id)
    r = await w.post(client, "decider", "shift_dependents")
    assert r.status_code == 201, r.text
    change = r.json()["change"]
    b, c = await w.item("shift_dependents-b"), await w.item("shift_dependents-c")
    assert (b.start_date, b.end_date) == (date(2026, 11, 16), date(2026, 12, 21))
    assert (c.start_date, c.end_date) == (date(2026, 12, 22), date(2027, 1, 6))
    assert set(change["after"]) == {w.ids["shift_dependents-b"], w.ids["shift_dependents-c"]}
    flags = {f["item_id"]: f["flags"] for f in r.json()["flags"]}
    assert flags[w.ids["shift_dependents-b"]] == []
    r = await w.post(client, "decider", "move_dependency")
    assert r.status_code == 201, r.text
    a = await w.item("move_dependency-a")
    assert (a.start_date, a.end_date) == (date(2026, 9, 25), date(2026, 11, 9))
    flags = {f["item_id"]: f["flags"] for f in r.json()["flags"]}
    assert flags[w.ids["move_dependency-b"]] == []
    # Undo puts every moved item back.
    r = await client.post(f"{CHANGES}/{change['id']}/undo", headers=ctx.as_("decider"))
    assert r.status_code == 201, r.text
    b, c = await w.item("shift_dependents-b"), await w.item("shift_dependents-c")
    assert (b.start_date, c.start_date) == (date(2026, 11, 10), date(2026, 12, 16))


async def test_shift_dependents_moves_every_sibling_but_an_accepted_risk(client):
    """#9 (fix2 review): Move the dependents on b also moves s, another dependent of a that
    starts too early, and d, which depends on s; r, whose early start was accepted as a
    risk, stays where it is."""
    ctx = await make_people()
    w = await World(ctx).build(decider=True, ops=["shift_dependents"])
    a_id = w.ids["shift_dependents-a"]
    async with tenant_session(ctx.tenant_id) as s:
        a = await s.get(RoadmapItem, a_id)

        def row(key: str, pos: int, start: date, end: date, dep: str, **kw: Any) -> RoadmapItem:
            return RoadmapItem(roadmap_document_id=a.roadmap_document_id,
                               roadmap_version_id=a.roadmap_version_id, item_key=key,
                               position=pos, title=seeded_title(key), horizon="now",
                               track_id=a.track_id, start_date=start, end_date=end,
                               date_source="typed", depends_on=[dep], **kw)  # fmt: skip

        rows = [
            row("sib-s", 60, date(2026, 11, 1), date(2026, 11, 30), "shift_dependents-a"),
            row("sib-d", 61, date(2026, 12, 1), date(2026, 12, 10), "sib-s"),
            row("sib-r", 62, date(2026, 11, 5), date(2026, 11, 25), "shift_dependents-a",
                accepted_risks=[{"flag": "dependency_order", "subject": a_id,
                                 "note": "Built in parallel"}]),
        ]  # fmt: skip
        s.add_all(rows)
        await s.commit()
        for r_ in rows:
            w.ids[r_.item_key] = str(r_.id)
    # fix4 review (qa-simple-home-1): b's order flag names what Move the dependents moves,
    # b first, as the engine moves them below (Home reads it; no copy of the plan in the web).
    rm = await client.get("/v1/simple/roadmap", headers=ctx.as_("decider"))
    assert rm.status_code == 200, rm.text
    b_item = next(i for i in rm.json()["items"] if i["id"] == w.ids["shift_dependents-b"])
    order = next(f for f in b_item["flags"] if f["kind"] == "dependency_order")
    assert order["moves"][0] == w.ids["shift_dependents-b"]
    assert set(order["moves"]) == {w.ids[k] for k in ("shift_dependents-b", "sib-s", "sib-d")}
    assert all(f["moves"] == [] for f in b_item["flags"] if f["kind"] != "dependency_order")
    r = await w.post(client, "decider", "shift_dependents")
    assert r.status_code == 201, r.text
    moved = {k: await w.item(k) for k in ("shift_dependents-b", "sib-s", "sib-d", "sib-r")}
    assert (moved["shift_dependents-b"].start_date, moved["shift_dependents-b"].end_date) == (
        date(2026, 11, 16),
        date(2026, 12, 21),
    )
    assert (moved["sib-s"].start_date, moved["sib-s"].end_date) == (
        date(2026, 11, 16),
        date(2026, 12, 15),
    )
    assert (moved["sib-d"].start_date, moved["sib-d"].end_date) == (
        date(2026, 12, 16),
        date(2026, 12, 25),
    )
    assert (moved["sib-r"].start_date, moved["sib-r"].end_date) == (
        date(2026, 11, 5),
        date(2026, 11, 25),
    )
    after = set(r.json()["change"]["after"])
    assert after == {w.ids[k] for k in ("shift_dependents-b", "sib-s", "sib-d")}


async def test_list_filters_audit_and_tools(client):
    from oracle.main import app
    from oracle.mcp import tools

    ctx = await make_people()
    w = await World(ctx).build(decider=True, ops=["edit_title", "move_dates"])
    applied = (await w.post(client, "decider", "edit_title")).json()["change"]
    proposed = (await w.post(client, "commenter", "move_dates")).json()["change"]

    async def ids(who: str = "owner", **params) -> list[str]:
        r = await client.get(CHANGES, params=params, headers=ctx.as_(who))
        assert r.status_code == 200, r.text
        return [c["id"] for c in r.json()]

    assert set(await ids()) == {applied["id"], proposed["id"]}
    assert await ids(session=applied["session_id"]) == [applied["id"]]
    assert await ids(status="proposed") == [proposed["id"]]
    assert set(await ids(document=w.roadmap_id)) == {applied["id"], proposed["id"]}
    assert await ids(document="00000000-0000-0000-0000-000000000000") == []
    assert await ids("commenter", mine="true") == [proposed["id"]]
    assert await ids("decider", mine="true") == [applied["id"]]
    # A viewer sees no proposals or changes in review (the owner answer).
    assert await ids("viewer") == []
    async with tenant_session(ctx.tenant_id) as s:
        actions = list(
            await s.scalars(
                text("SELECT action FROM audit_events WHERE entity = 'simple_change' ORDER BY 1")
            )
        )
    assert actions == ["simple_change.applied", "simple_change.proposed"]
    names = {op.operation_id for op in tools.app_operations(app) if op.excluded is None}
    assert {
        "create_simple_session",
        "get_current_simple_session",
        "close_simple_session",
        "create_simple_change",
        "list_simple_changes",
        "undo_simple_change",
        "accept_simple_change",
        "decline_simple_change",
    } <= names
