"""home-decisions-one-list: the one list GET /v1/simple/decisions/waiting ``items`` reads
(oracle.simple.waiting_list) for every kind it carries. Against Postgres.

Each test reuses an existing module's seeding helpers (imported, never duplicated) to put
one item of a kind in front of the person it waits on, checks it is absent for someone it
does not wait on, acts on it through that kind's own endpoint (never by editing data by
hand) and checks the next read has dropped it. ``broken_link`` and ``date`` ride along on
the same roadmap a proposal/draft test already builds (an undated item gets an open date
suggestion and the dated pair always overlaps, so both come for free); every kind the
schema lists is covered, none skipped.

Test cards (protects / fails_when / no_claim):

- test_question_waiting_and_decide: protects=an open PRD question waits for its named
  decider only; deciding it (the same decide flow as test_decide_per_role) drops it;
  fails_when=another approver sees it or it survives the decision; no_claim=due dates.
- test_proposal_waiting_and_accept: protects=a proposed change routed to the roadmap's
  decider waits for them only; accepting it drops it; fails_when=a non-deciding approver
  sees it or it survives accept; no_claim=decline (covered by test_simple_changes_api).
- test_date_and_broken_link_waiting: protects=an open date suggestion and a red,
  fixable dependency flag on the same roadmap both wait for its decider only; accepting
  the dates and shifting the dependent drop them; fails_when=either survives its fix or
  shows for a non-deciding approver; no_claim=the other fixes (move_dependency,
  accept_risk).
- test_draft_waiting_and_approve: protects=a submitted working draft waits for its
  required reviewer, and not for a commenter; approving it drops it; fails_when=a
  commenter sees it or it survives approve; no_claim=the decider's own approval.
- test_draft_waits_for_its_decider: protects=a draft an owner sent waits for the
  roadmap's decider (not in ``waiting_on``) until their approval is in, as the Inbox lists
  it to them; fails_when=the decider does not see it, the sender does, or it survives the
  decider's approval; no_claim=publishing.
- test_goal_suggestion_waiting_and_reject: protects=an open suggestion on a goal whose
  items put it on a roadmap with a decider waits for that decider only; rejecting it
  drops it; fails_when=a non-deciding approver sees it or it survives reject;
  no_claim=accept (covered by test_simple_additions_api).
- test_goal_waiting_and_confirm: protects=a proposed goal waits for whoever may confirm
  goals (the approver role confirm_entity needs) and leaves once confirmed; a confirmed or
  rejected goal never waits; fails_when=a commenter sees it, a confirmed goal is listed, or
  it survives confirm, or it carries a second line repeating "A proposed goal";
  no_claim=reject's own flow (covered by the baseline tests).
- test_run_stop_waiting_and_decide: protects=a pending checkpoint waits for whoever holds
  its approver role; deciding it drops it; fails_when=a commenter sees it or it survives
  the decision; no_claim=engineering stops routed to leads (A3, its own tests).
"""

import uuid
from datetime import UTC, date, datetime

import pytest
from sqlalchemy import select

from oracle import company_time
from oracle.baseline.models import Entity
from oracle.runs.models import Checkpoint, Run, RunSegment
from oracle.simple import waiting_list
from oracle.simple.models import SimpleGoalSuggestion
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.decision_helpers import decide, propose
from tests.test_simple_additions_api import World as AdditionsWorld
from tests.test_simple_changes_api import CHANGES, A, B, World, make_people
from tests.test_simple_drafts_api import DRAFTS, edit_title, the_draft
from tests.test_simple_drafts_api import world as drafts_world
from tests.test_simple_prd_questions import FIXTURE, seed
from tests.test_simple_roadmap_api import NOW

WAITING = "/v1/simple/decisions/waiting"


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


async def waiting(client, ctx, role: str) -> list[dict]:
    r = await client.get(WAITING, headers=ctx.as_(role))
    assert r.status_code == 200, r.text
    return r.json()["items"]


def find(items: list[dict], kind: str, ref_id: str) -> dict | None:
    return next((i for i in items if i["kind"] == kind and i["ref_id"] == ref_id), None)


async def test_question_waiting_and_decide(client):
    ctx = await make_ctx()
    await seed(ctx, FIXTURE)
    r = await client.get("/v1/simple/decisions", headers=ctx.as_("decider"))
    assert r.status_code == 200, r.text
    q = next(x for x in r.json()["questions"] if x["code"] == "Q2")
    assert find(await waiting(client, ctx, "decider"), "question", q["id"]) is not None
    assert find(await waiting(client, ctx, "approver"), "question", q["id"]) is None
    d = await client.post(CHANGES, headers=ctx.as_("decider"), json={
        "op": "decide_question", "target": {"decision_id": q["id"]},
        "before": {"status": "proposed"}, "after": {"option": "recommended"}})  # fmt: skip
    assert d.status_code == 201, d.text
    assert find(await waiting(client, ctx, "decider"), "question", q["id"]) is None


async def test_proposal_waiting_and_accept(client):
    ctx = await make_people()
    w = await World(ctx).build(decider=True, ops=["edit_title"])
    c = (await w.post(client, "commenter", "edit_title")).json()["change"]
    assert find(await waiting(client, ctx, "decider"), "proposal", c["id"]) is not None
    assert find(await waiting(client, ctx, "approver"), "proposal", c["id"]) is None
    a = await client.post(f"{CHANGES}/{c['id']}/accept", headers=ctx.as_("decider"))
    assert a.status_code == 200, a.text
    assert find(await waiting(client, ctx, "decider"), "proposal", c["id"]) is None


async def test_date_and_broken_link_waiting(client):
    ctx = await make_people()
    w = await World(ctx).build(decider=True, ops=["edit_title"])
    a_id, b_id, u_id = (w.ids[f"edit_title-{x}"] for x in "abu")
    suggestion_id = w.suggestion["edit_title-u"]

    date_item = find(await waiting(client, ctx, "decider"), "date", suggestion_id)
    assert date_item is not None and date_item["action"] == "Confirm the dates"
    assert find(await waiting(client, ctx, "approver"), "date", suggestion_id) is None
    link = find(await waiting(client, ctx, "decider"), "broken_link", b_id)
    assert link is not None and link["action"] == "Fix the link"
    assert find(await waiting(client, ctx, "approver"), "broken_link", b_id) is None

    accept = await client.post(CHANGES, headers=ctx.as_("decider"), json={
        "op": "accept_date_suggestion",
        "target": {"item_id": u_id, "suggestion_id": suggestion_id},
        "before": {"start_date": None, "end_date": None}, "after": {}})  # fmt: skip
    assert accept.status_code == 201, accept.text
    assert find(await waiting(client, ctx, "decider"), "date", suggestion_id) is None

    shift = await client.post(CHANGES, headers=ctx.as_("decider"), json={
        "op": "shift_dependents", "target": {"item_id": b_id, "subject": a_id},
        "before": {b_id: B, a_id: A}, "after": {}})  # fmt: skip
    assert shift.status_code == 201, shift.text
    assert find(await waiting(client, ctx, "decider"), "broken_link", b_id) is None


async def test_draft_waiting_and_approve(client):
    w = await drafts_world(reviewers=("approver",))
    await edit_title(client, w, "decider")
    d = await the_draft(client, w)
    submit = await client.post(f"{DRAFTS}/{d['id']}/submit", headers=w.ctx.as_("decider"))
    assert submit.status_code == 200, submit.text
    assert find(await waiting(client, w.ctx, "approver"), "draft", d["id"]) is not None
    assert find(await waiting(client, w.ctx, "commenter"), "draft", d["id"]) is None
    approve = await client.post(f"{DRAFTS}/{d['id']}/approve", headers=w.ctx.as_("approver"))
    assert approve.status_code == 200, approve.text
    assert find(await waiting(client, w.ctx, "approver"), "draft", d["id"]) is None


async def test_draft_waits_for_its_decider(client):
    w = await drafts_world(reviewers=("approver",))
    await edit_title(client, w, "owner")
    d = await the_draft(client, w, "owner")
    submit = await client.post(f"{DRAFTS}/{d['id']}/submit", headers=w.ctx.as_("owner"))
    assert submit.status_code == 200, submit.text
    # The decider gives the final approval: it waits on them as on the required reviewer,
    # as the Inbox lists it to both (drafts.inbox_rows).
    assert find(await waiting(client, w.ctx, "decider"), "draft", d["id"]) is not None
    assert find(await waiting(client, w.ctx, "approver"), "draft", d["id"]) is not None
    assert find(await waiting(client, w.ctx, "owner"), "draft", d["id"]) is None
    approve = await client.post(f"{DRAFTS}/{d['id']}/approve", headers=w.ctx.as_("decider"))
    assert approve.status_code == 200, approve.text
    assert find(await waiting(client, w.ctx, "decider"), "draft", d["id"]) is None
    assert find(await waiting(client, w.ctx, "approver"), "draft", d["id"]) is not None


async def test_goal_suggestion_waiting_and_reject(client):
    w = await AdditionsWorld().build(decider=True)
    async with tenant_session(w.ctx.tenant_id) as s:
        sug = SimpleGoalSuggestion(
            goal_id=uuid.UUID(w.goals["grow"]), title="Faster onboarding",
            outcome="New accounts finish setup sooner", why="Example reason",
            evidence=[], origin="auto")  # fmt: skip
        s.add(sug)
        await s.commit()
        sid = str(sug.id)
    assert find(await waiting(client, w.ctx, "decider"), "goal_suggestion", sid) is not None
    assert find(await waiting(client, w.ctx, "approver"), "goal_suggestion", sid) is None
    r = await client.post(f"/v1/simple/goal-suggestions/{sid}/reject",
                          headers=w.as_("decider"), json={"reason": "Not now"})  # fmt: skip
    assert r.status_code == 200, r.text
    assert find(await waiting(client, w.ctx, "decider"), "goal_suggestion", sid) is None


async def test_goal_waiting_and_confirm(client):
    ctx = await make_ctx()
    async with tenant_session(ctx.tenant_id) as s:
        goal = Entity(type="goal", key="cut-early-churn", title="Cut early churn",
                      status="proposed", origin="agent")  # fmt: skip
        kept = Entity(type="goal", key="grow-teams", title="Grow teams",
                      status="confirmed", origin="user")  # fmt: skip
        s.add_all([goal, kept])
        await s.commit()
        gid, kept_id = str(goal.id), str(kept.id)
    item = find(await waiting(client, ctx, "approver"), "goal", gid)
    assert item is not None, "a proposed goal waits on who confirms goals"
    assert item["title"] == "Cut early churn" and item["action"] == "Confirm"
    # Its row reads "Proposed goal · Cut early churn", as on Home: no second line repeats it.
    assert item["detail"] == ""
    assert find(await waiting(client, ctx, "approver"), "goal", kept_id) is None
    assert find(await waiting(client, ctx, "commenter"), "goal", gid) is None
    r = await client.post(f"/v1/baseline/entities/{gid}/confirm", headers=ctx.as_("approver"))
    assert r.status_code == 200, r.text
    assert find(await waiting(client, ctx, "approver"), "goal", gid) is None


async def test_run_stop_waiting_and_decide(client):
    ctx = await make_ctx()
    async with tenant_session(ctx.tenant_id) as s:
        run = Run(flow="baseline_to_prd", status="awaiting_checkpoint",
                  created_by=ctx.users["owner"].id)  # fmt: skip
        s.add(run)
        await s.flush()
        s.add(RunSegment(run_id=run.id, seq=1, name="baseline", status="succeeded"))
        cp = Checkpoint(run_id=run.id, kind="baseline_confirm", status="pending",
                        approver_role="approver", payload={"segment_seq": 1})  # fmt: skip
        s.add(cp)
        await s.commit()
        run_id, cp_id = str(run.id), str(cp.id)
    assert find(await waiting(client, ctx, "approver"), "run_stop", cp_id) is not None
    assert find(await waiting(client, ctx, "commenter"), "run_stop", cp_id) is None
    r = await client.post(f"/v1/runs/{run_id}/checkpoints/{cp_id}/decide",
                          json={"decision": "approved"}, headers=ctx.as_("approver"))  # fmt: skip
    assert r.status_code == 200, r.text
    assert find(await waiting(client, ctx, "approver"), "run_stop", cp_id) is None
    async with tenant_session(ctx.tenant_id) as s:
        status = await s.scalar(select(Checkpoint.status).where(Checkpoint.id == uuid.UUID(cp_id)))
        assert status == "approved"


async def test_decision_log_call_waiting_and_decide(client):
    ctx = await make_ctx()
    d = await propose(client, ctx, "commenter", title="Ship the example export first")
    ref = str(d["number"])
    r = await client.get(WAITING, headers=ctx.as_("approver"))
    assert r.status_code == 200, r.text
    body = r.json()
    item = find(body["items"], "decision", ref)
    assert item is not None, body["items"]
    assert item["action"] == "Decide" and item["title"] == "Ship the example export first"
    # The list holds every call the decisions count does (Home's tile, Decisions, the rail).
    assert len([i for i in body["items"] if i["kind"] == "decision"]) == body["others"] == 1
    assert find(await waiting(client, ctx, "owner"), "decision", ref) is None
    await decide(client, ctx, ref, "approver")
    assert find(await waiting(client, ctx, "approver"), "decision", ref) is None


def test_day_reads_this_year_in_the_company_zone(monkeypatch):
    # 07:30 UTC on Jan 1, 2027 is still Dec 31, 2026 in the company's zone (Los Angeles).
    monkeypatch.setattr(company_time, "now", lambda: datetime(2027, 1, 1, 7, 30, tzinfo=UTC))
    today = company_time.today()
    assert waiting_list._day(date(2026, 12, 30), today) == "Dec 30"
    assert waiting_list._day(date(2027, 1, 8), today) == "Jan 8, 2027"


async def test_every_red_flag_with_a_fix_waits_as_a_broken_link(monkeypatch):
    """protects=qa-simple-home-3 after the merge of roadmap-decide into train AN: a "Broken
    link" on the one waiting list is every red flag with a one-click fix, as Home's tile and the
    walk count them (a feature ending after its milestone is one a person must see); a red flag
    with no fix (a draft with no owner) is not; fails_when=the end past its milestone is left out.
    """
    from types import SimpleNamespace as NS

    def flag(kind: str, fixes: list[str]) -> NS:
        return NS(state="red", fixes=fixes, kind=kind, subject=None, reason="Late")

    row = NS(id=uuid.uuid4(), title="Example item", feature_id=None, prd_section_key=None,
             decider_id=None)  # fmt: skip
    item = NS(row=row, roadmap=NS(id=uuid.uuid4()), track=None, suggestion=None,
              flags=[flag("dependency_order", ["shift_dependents"]),
                     flag("outside_milestone", ["accept_risk"]),
                     flag("draft_without_owner", [])])  # fmt: skip

    async def today(db):
        return date(2026, 11, 5)

    monkeypatch.setattr(company_time, "company_today", today)
    # The list's one roadmap read (service.load), as an owner (who decides every item) reads it.
    read_ = NS(entries=[item], deciders={})
    out = await waiting_list._roadmap(None, NS(role="owner", user_id=uuid.uuid4()), read_)  # type: ignore[arg-type]
    assert [i.key.split(":")[2] for i in out] == ["dependency_order", "outside_milestone"]


def test_a_ground_truth_stop_is_named_as_its_run_names_it():
    """port-AN 5: the one list's run stop reads "Confirm the Ground Truth", as the run's own
    stop since the Ground Truth words (never "the baseline")."""
    from oracle.simple import waiting_list

    assert waiting_list._STOP_ACTION["baseline_confirm"] == "Confirm the Ground Truth"
