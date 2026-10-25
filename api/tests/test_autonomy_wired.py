"""H11 Autonomy wired by the picks that shipped: Order priorities (C8, C9), Watch the
roadmap (F2), Decide reversible calls (H1) and Check outcomes (H3). Each asks
``autonomy.allows`` (or ``level``) at its decision point and, where Oracle acts on its
own, calls ``autonomy.acted`` so the owner gets an "Oracle did" Inbox row. Against
Postgres with the FakeRuntime; a scripted fake stands in for the model.

Every test states its card: protects (the observable), fails_when (the wrong result
it rejects), no_claim (what green does not prove). Synthetic placeholders only."""

import uuid

import pytest
from sqlalchemy import select

from oracle import autonomy
from oracle.autonomy_models import OracleAction
from oracle.decisions import service as decisions
from oracle.decisions.models import Decision
from oracle.jobs import worker
from oracle.models import AuditEvent
from oracle.priorities import run_order
from oracle.runs.models import Checkpoint
from oracle.tenancy import tenant_session
from oracle.tenant_settings import TenantSetting
from tests.baseline_helpers import make_ctx
from tests.claude_account_helpers import add_account, window
from tests.day_helpers import company_today
from tests.decision_helpers import (
    clock,  # noqa: F401 (autouse: one clock for the test and the API)
    propose,
    two_options,
)
from tests.launch_helpers import ticker_pass
from tests.outcome_helpers import days_ago, goal_history, outcome_world, set_record
from tests.test_llm_jobs import FakeClaude
from tests.test_priority_run_order import at_priority, snapshots
from tests.test_runs import owner, runtime  # noqa: F401 - fixtures
from tests.test_track_alerts import slipped

WIRED = ("priorities", "roadmap_watch", "decisions", "outcomes")


async def set_level(tenant_id: uuid.UUID, key: str, level: str, **limits) -> None:
    """The company's setting, as Settings › Autonomy stores it (the route is tested in
    test_autonomy.py)."""
    item: dict = {"level": level}
    if limits:
        item["limits"] = limits
    async with tenant_session(tenant_id) as s:
        row = await s.scalar(select(TenantSetting).where(TenantSetting.key == "autonomy"))
        if row is None:
            s.add(TenantSetting(key="autonomy", value={key: item}))
        else:
            row.value = {**row.value, key: item}
        await s.commit()


async def actions_of(tenant_id: uuid.UUID, key: str) -> list[OracleAction]:
    async with tenant_session(tenant_id) as s:
        return list(await s.scalars(select(OracleAction).where(OracleAction.responsibility == key)))


# --- the registry --------------------------------------------------------------------------


def test_the_four_are_wired_and_roadmap_watch_keeps_todays_behaviour():
    """protects=Settings › Autonomy drops "Takes effect when <pick> ships" for the four
    picks that shipped, and Watch the roadmap's default is the level F2 built (Oracle
    proposes the date and the re-plan; a person decides); fails_when=one still reads as not
    wired, or the default hides F2's one-step fixes; no_claim=the screen (Playwright)."""
    for key in WIRED:
        assert autonomy.get(key).wired is True, key
    assert autonomy.get("roadmap_watch").default == "recommend"
    assert autonomy.get("roadmap_watch").ceiling == "recommend"


# --- Watch the roadmap (F2) ----------------------------------------------------------------


@pytest.mark.parametrize(
    "level, want",
    [
        ("observe", {"keep"}),
        ("draft", {"replan", "keep"}),
        ("recommend", {"accept_date", "replan", "keep"}),
    ],
)
async def test_the_roadmap_level_sets_which_fixes_a_slip_offers(
    client,
    owner,  # noqa: F811
    runtime,  # noqa: F811
    level,
    want,
):
    """protects=a date slip offers Oracle's fixes by level: Observe only flags it (Keep
    watching), Draft adds Re-plan (a draft for its owner), Recommend adds Accept new date
    (the date change with the tracker's evidence); fails_when=Observe still proposes a fix
    or Recommend loses one; no_claim=the accept-date write (test_track_alerts.py)."""
    tenant_id, auth = owner
    await set_level(tenant_id, "roadmap_watch", level)
    _, alert = await slipped(client, auth, runtime)
    assert set(alert["actions"]) == want
    inbox = (await client.get("/v1/inbox", headers=auth)).json()
    (row,) = [a for t in inbox["tracks"] for a in t["alerts"] if a["id"] == alert["id"]]
    assert set(row["actions"]) == want


# --- Check outcomes (H3) -------------------------------------------------------------------


async def test_oracle_recording_a_verdict_tells_the_owner(client, owner, runtime):  # noqa: F811
    """protects=at Act Oracle records the verdict read from data and the record's owner
    gets a counted "Oracle did" row that opens the outcome; fails_when=no row, or a row
    for another person; no_claim=the H3 "Oracle recorded" row (test_outcome_shipping.py)."""
    tenant_id, auth = owner
    pay = (await outcome_world(client, auth, runtime, tenant_id))["payment-step"]
    prediction = {**pay["prediction"], "threshold_value": 40, "by": days_ago(10).isoformat()}
    await set_record(
        tenant_id, pay["id"], status="tracking", prediction=prediction,
        assess_due_on=company_today(),
    )  # fmt: skip
    await goal_history(tenant_id, ("41%", days_ago(5)))
    await set_level(tenant_id, "outcomes", "act")
    await ticker_pass(tenant_id)
    (did,) = await actions_of(tenant_id, "outcomes")
    assert did.summary == "Recorded partly held for Payment step: the goal read 41%"
    assert did.subject == {
        "kind": "outcome",
        "key": pay["id"],
        "href": f"/plan/outcomes?outcome={pay['id']}",
    }
    assert did.undo is None
    inbox = (await client.get("/v1/inbox", headers=auth)).json()
    (row,) = inbox["oracle_actions"]
    assert row["responsibility"] == "outcomes" and row["counts"] is True


async def test_with_no_owner_oracle_tells_the_owners(client, owner, runtime):  # noqa: F811
    """protects=an outcome with no owner still gets someone told: the company's owners;
    fails_when=Oracle records the verdict and tells no one; no_claim=who owns it later."""
    tenant_id, auth = owner
    pay = (await outcome_world(client, auth, runtime, tenant_id))["payment-step"]
    prediction = {**pay["prediction"], "threshold_value": 40, "by": days_ago(10).isoformat()}
    await set_record(
        tenant_id, pay["id"], status="tracking", prediction=prediction,
        assess_due_on=company_today(), owner_id=None,
    )  # fmt: skip
    await goal_history(tenant_id, ("41%", days_ago(5)))
    await set_level(tenant_id, "outcomes", "act")
    await ticker_pass(tenant_id)
    (did,) = await actions_of(tenant_id, "outcomes")
    assert len(did.notify_ids) >= 1
    inbox = (await client.get("/v1/inbox", headers=auth)).json()
    assert [r["responsibility"] for r in inbox["oracle_actions"]] == ["outcomes"]


@pytest.mark.parametrize("level", ["observe", "draft"])
async def test_below_recommend_oracle_reads_the_actual_but_proposes_no_verdict(
    client,
    owner,  # noqa: F811
    runtime,  # noqa: F811
    level,
):
    """protects=at Observe and Draft Oracle records the predicted and actual results only:
    the record shows the goal's reading with no proposed verdict; fails_when=a verdict is
    proposed below Recommend; no_claim=the screen (Playwright)."""
    tenant_id, auth = owner
    pay = (await outcome_world(client, auth, runtime, tenant_id))["payment-step"]
    prediction = {**pay["prediction"], "threshold_value": 40, "by": days_ago(10).isoformat()}
    await set_record(
        tenant_id, pay["id"], status="tracking", prediction=prediction,
        assess_due_on=company_today(),
    )  # fmt: skip
    await goal_history(tenant_id, ("41%", days_ago(5)))
    await set_level(tenant_id, "outcomes", level)
    await ticker_pass(tenant_id)
    got = (await client.get(f"/v1/outcomes/{pay['id']}", headers=auth)).json()
    assert got["status"] == "tracking"
    assert got["proposed_assessment"]["verdict"] is None
    assert got["proposed_assessment"]["observed"] == "41%"
    assert await actions_of(tenant_id, "outcomes") == []


async def test_oracle_records_no_verdict_below_act(client, owner, runtime):  # noqa: F811
    """protects=at Recommend the verdict waits for a person and nobody is told Oracle
    did anything; fails_when=an "Oracle did" row appears; no_claim=the proposal itself."""
    tenant_id, auth = owner
    pay = (await outcome_world(client, auth, runtime, tenant_id))["payment-step"]
    prediction = {**pay["prediction"], "by": days_ago(10).isoformat()}
    await set_record(
        tenant_id, pay["id"], status="tracking", prediction=prediction,
        assess_due_on=company_today(),
    )  # fmt: skip
    await goal_history(tenant_id, ("41%", days_ago(5)))
    await ticker_pass(tenant_id)
    assert await actions_of(tenant_id, "outcomes") == []


# --- Decide reversible calls (H1) ----------------------------------------------------------


@pytest.fixture
async def ctx():
    return await make_ctx()


def recommended(cost: str | None = "Two weeks of rework") -> list[dict]:
    first, second = two_options()
    return [{**first, "recommended": True, "cost_if_wrong": cost}, second]


async def oracle_decides(tenant_id: uuid.UUID, number: int) -> Decision:
    async with tenant_session(tenant_id) as s:
        d = await s.scalar(select(Decision).where(Decision.number == number))
        await decisions.decide_within_limits(s, d)
        await s.commit()
        await s.refresh(d)
        return d


async def test_oracle_decides_a_reversible_call_after_preparing_options(client, ctx):
    """protects=at Act, once Oracle's options job recommends one, Oracle decides a
    reversible proposal itself: the record says who set the limits, the approver gets an
    "Oracle did" row, and its Undo reverses the decision; fails_when=it waits for the
    approver, names a person as the decider, or Undo leaves it decided; no_claim=a scripted
    fake stands in for the model."""
    resp = await client.put(
        "/v1/autonomy/decisions",
        json={"level": "act", "reason": "Small reversible calls are fine"},
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 200, resp.text
    d = await propose(client, ctx, options=[], expected_outcome=None)
    resp = await client.post(
        f"/v1/decisions/{d['number']}/options-job", headers=ctx.as_("approver")
    )
    assert resp.status_code == 201, resp.text
    fake = FakeClaude()
    from oracle.llm import gateway

    previous = gateway.set_transports(gateway.Transports(plan=fake, api_key=fake))
    try:
        await add_account(ctx.tenant_id, "personal", windows={"five_hour": window(0.2)})
        fake.script["decision_options"].append({"options": recommended()})
        await worker.run_pending(ctx.tenant_id)
    finally:
        gateway.set_transports(previous)
    got = (await client.get(f"/v1/decisions/{d['number']}", headers=ctx.as_("viewer"))).json()
    assert got["status"] == "decided" and got["chosen_option"] == "caps-first"
    assert got["decided_actor"] == "oracle" and got["decided_by"] is None
    assert got["rationale"].startswith("Decided by Oracle within limits set by owner@example.com.")
    assert got["expected_outcome"] == "Caps read plan thresholds only"
    (did,) = await actions_of(ctx.tenant_id, "decisions")
    assert did.summary == f"Decided D-{d['number']}: Caps first"
    assert did.notify_ids == [ctx.users["approver"].id]
    assert did.subject["href"] == f"/company/decisions?d={d['number']}"
    assert did.undo == {
        "method": "POST",
        "path": f"/v1/decisions/{d['id']}/reviews",
        "body": {"verdict": "revisit", "note": "Handed Oracle's decision back from the Inbox"},
    }


async def test_undo_hands_oracles_decision_back_to_the_approver(client, ctx):
    """protects=Undo on Oracle's decision hands the question back: a new proposal that
    supersedes it, with its options and evidence and no recommendation, which the approver
    decides on another option and Oracle does not decide again; fails_when=Undo reverses
    the decision (the approver can neither decide nor withdraw it), or Oracle re-decides
    the revisit; no_claim=the Inbox screen (Playwright)."""
    await set_level(ctx.tenant_id, "decisions", "act")
    d = await propose(client, ctx, options=recommended())
    out = await oracle_decides(ctx.tenant_id, d["number"])
    assert out.status == "decided"
    (did,) = await actions_of(ctx.tenant_id, "decisions")
    resp = await client.post(f"/v1/oracle-actions/{did.id}/undo", headers=ctx.as_("approver"))
    assert resp.status_code == 200, resp.text
    got = (await client.get(f"/v1/decisions/{d['number']}", headers=ctx.as_("viewer"))).json()
    assert got["status"] == "decided" and got["revisit_id"] is not None
    async with tenant_session(ctx.tenant_id) as s:
        new = await s.get(Decision, uuid.UUID(got["revisit_id"]))
        assert new.status == "proposed" and new.supersedes_id == out.id
        assert [o["key"] for o in new.options] == ["caps-first", "together"]
        assert not any(o["recommended"] for o in new.options)
        # Even with a recommendation added back, Oracle leaves a revisit to the approver.
        new.options = recommended()
        assert await decisions.decide_within_limits(s, new) is False
        await s.commit()
        number = new.number
    again = await client.post(
        f"/v1/decisions/{number}/decide",
        json={
            "option_key": "together",
            "rationale": "Wait for detection after all",
            "reversibility": "reversible",
            "expected_outcome": "One launch, no noisy alerts",
        },
        headers=ctx.as_("approver"),
    )
    assert again.status_code == 200, again.text
    assert again.json()["chosen_option"] == "together"
    assert len(await actions_of(ctx.tenant_id, "decisions")) == 1


async def test_oracle_never_decides_a_call_about_an_approvers_only_document(client, ctx):
    """protects=pricing stays with people: a reversible call whose subject is an
    approvers-only document (a pricing memo) waits for its approver even at Act;
    fails_when=Oracle decides it; no_claim=the pricing flow itself (test_pricing*)."""
    from oracle.docs.models import Document

    await set_level(ctx.tenant_id, "decisions", "act")
    async with tenant_session(ctx.tenant_id) as s:
        memo = Document(slug="memo", title="Price memo", kind="pricing", visibility="approvers")
        s.add(memo)
        await s.commit()
        memo_id = str(memo.id)
    d = await propose(
        client,
        ctx,
        who="approver",
        options=recommended(),
        subjects=[{"kind": "document", "id": memo_id}],
    )
    out = await oracle_decides(ctx.tenant_id, d["number"])
    assert out.status == "proposed"
    assert await actions_of(ctx.tenant_id, "decisions") == []


@pytest.mark.parametrize("level, recommends", [("observe", False), ("draft", False),
                                               ("recommend", True)])  # fmt: skip
async def test_asked_options_follow_the_level(client, ctx, level, recommends):
    """protects=below Recommend, Ask Oracle for options gives options with evidence but no
    default; fails_when=Observe or Draft still marks one recommended; no_claim=the model."""
    await set_level(ctx.tenant_id, "decisions", level)
    d = await propose(client, ctx, options=[], expected_outcome=None)
    resp = await client.post(
        f"/v1/decisions/{d['number']}/options-job", headers=ctx.as_("approver")
    )
    assert resp.status_code == 201, resp.text
    fake = FakeClaude()
    from oracle.llm import gateway

    previous = gateway.set_transports(gateway.Transports(plan=fake, api_key=fake))
    try:
        await add_account(ctx.tenant_id, "personal", windows={"five_hour": window(0.2)})
        fake.script["decision_options"].append({"options": recommended()})
        await worker.run_pending(ctx.tenant_id)
    finally:
        gateway.set_transports(previous)
    got = (await client.get(f"/v1/decisions/{d['number']}", headers=ctx.as_("viewer"))).json()
    assert len(got["options"]) == 2
    assert any(o["recommended"] for o in got["options"]) is recommends


@pytest.mark.parametrize(
    "level, limits, body, decided",
    [
        ("act", {}, {"options": recommended()}, True),
        ("recommend", {}, {"options": recommended()}, False),
        ("act", {}, {"options": recommended(), "reversibility": "irreversible"}, False),
        ("act", {}, {"options": two_options()}, False),
        ("act", {"origins": ["oracle"]}, {"options": recommended()}, False),
        ("act", {}, {"options": recommended("About $120 of contractor time")}, False),
        ("act", {"max_cost_usd": 50}, {"options": recommended("About $40 of time")}, True),
    ],
    ids=["act", "recommend", "hard-to-reverse", "none-recommended", "origin", "cost", "in-cost"],
)
async def test_oracle_decides_only_inside_the_limits(client, ctx, level, limits, body, decided):
    """protects=Oracle decides only at Act, a reversible call, of a listed origin, with a
    recommended option whose stated cost is within the limit; fails_when=any of those is
    ignored; no_claim=how the options were written."""
    await set_level(ctx.tenant_id, "decisions", level, **limits)
    d = await propose(client, ctx, **body)
    out = await oracle_decides(ctx.tenant_id, d["number"])
    assert (out.status == "decided") is decided
    assert len(await actions_of(ctx.tenant_id, "decisions")) == int(decided)


# --- Order priorities (C8, C9) -------------------------------------------------------------


def row(key: str, rank: int, live: int | None, *goals: str) -> dict:
    return {"key": key, "rank": rank, "live_rank": live,
            "explanation": {"goals": [{"goal": g, "term": 1} for g in goals]}}  # fmt: skip


@pytest.mark.parametrize(
    "rows, most, outside",
    [
        ([row("a", 1, 1, "g"), row("b", 2, 2, "g")], 3, None),
        ([row("b", 1, 2, "g"), row("a", 2, 1, "g")], 3, None),
        ([row("b", 1, 2, "g"), row("a", 2, 1, "h")], 3, "b passes a, which serves another goal"),
        (
            [row("d", 1, 4, "g"), row("a", 2, 1, "g"), row("b", 3, 2, "g"), row("c", 4, 3, "g")],
            2,
            "d moves 3 places, more than 2",
        ),
        ([row("a", 1, 1, "g"), row("new", 2, None)], 1, None),
    ],
    ids=["same", "swap-in-goal", "across-goals", "too-far", "not-ranked-live"],
)
def test_an_order_is_within_limits_only_inside_one_goal_and_the_move_limit(rows, most, outside):
    """protects=C9's "within one goal, by at most N places" read on a run's order against
    the live ranking; fails_when=a move across goals or past the limit passes;
    no_claim=the order's quality."""
    assert run_order.outside_limits(rows, max_rank_move=most) == outside


async def test_at_act_oracle_saves_an_order_within_limits(client, owner, runtime):  # noqa: F811
    """protects=at Act a clean order inside the limits is saved by Oracle with no stop to
    wait on, and the run's starter gets an "Oracle did" row; fails_when=the run still waits
    on the priority stop, or no one is told; no_claim=C9's moves on the live ranking."""
    tenant_id, auth = owner
    await set_level(tenant_id, "priorities", "act")
    run = await at_priority(client, owner, runtime)
    assert run["waiting_on"] != "priority_order" and run["error"] is None
    (snap,) = await snapshots(tenant_id, run["id"])
    assert snap.status == "saved" and snap.decided_by is None
    async with tenant_session(tenant_id) as s:
        cp = await s.scalar(select(Checkpoint).where(Checkpoint.kind == "priority_order"))
        ev = await s.scalar(
            select(AuditEvent).where(AuditEvent.action == "priority_snapshot.approved")
        )
    assert cp.status == "skipped" and cp.note == autonomy_note()
    assert ev.actor == "oracle" and ev.data["reason"] == "autonomy"
    (did,) = await actions_of(tenant_id, "priorities")
    assert did.summary.startswith("Saved the priority order of ")
    assert did.subject["href"] == f"/runs/{run['id']}"
    assert did.undo is None and len(did.notify_ids) == 1


async def test_below_act_the_order_waits_for_a_person(client, owner, runtime):  # noqa: F811
    """protects=at the default (Recommend) the order waits on its stop; fails_when=Oracle
    saves it; no_claim=the approval itself (test_priority_run_order.py)."""
    tenant_id, auth = owner
    run = await at_priority(client, owner, runtime)
    assert run["waiting_on"] == "priority_order"
    assert await actions_of(tenant_id, "priorities") == []


def autonomy_note() -> str:
    from oracle.runs import service

    return service.ORDER_SAVED_BY_ORACLE
