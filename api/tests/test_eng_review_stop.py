"""F4 Engineering review stop, lane A: the Engineering check (``eng_review``) of Baseline
to PRD, after the feature set and before the priority order.

Every test states its card: protects / fails_when / no_claim. Against Postgres; the
FakeRuntime stands in for SwarmCloud and its architect (no model is called). Synthetic
placeholders only.
"""

import uuid

import pytest
from sqlalchemy import select

from oracle.baseline.models import Entity
from oracle.models import AuditEvent
from oracle.runs import flows
from oracle.runs.models import CheckpointAction, Run
from oracle.swarm import FakeRuntime, Outcome, set_runtime
from oracle.tenancy import tenant_session
from tests.fixtures import seed_auth
from tests.review_v2_helpers import person
from tests.test_runs import create, get, pending, started, tick

BRIEFS = """\
version: 1
code_map: {used: false, repos: []}
features:
  - feature: price-early
    title: Show the price early
    approach: Compute the total on the cart page and show it before checkout.
    touches: []
    reuse: []
    risks: []
    questions:
      - {id: q1, question: "Can the tax service answer within 200 ms?", why: Latency,
         blocking: true}
      - {id: q2, question: "Show shipping too?", why: Scope, blocking: false}
    size: m
    size_why: One page and one service call
    depends_on: []
    assumptions: ["A tax service exists"]
"""


@pytest.fixture
def runtime():
    fake = FakeRuntime({"eng_review": [Outcome(artifacts={flows.BRIEFS_FILE: BRIEFS})]})
    set_runtime(fake)
    yield fake
    set_runtime(None)


@pytest.fixture
async def owner():
    return await seed_auth()


def _url(run, cp) -> str:
    return f"/v1/runs/{run['id']}/checkpoints/{cp['id']}"


async def _approve(client, headers, run, note=None):
    return await client.post(
        _url(run, pending(run)) + "/decide",
        json={"decision": "approved", "note": note},
        headers=headers,
    )


async def _act(client, headers, run, body):
    return await client.post(_url(run, pending(run)) + "/actions", json=body, headers=headers)


async def _at_check(client, auth, **knobs) -> dict:
    """A run waiting at the Engineering check (the baseline and feature set approved)."""
    run = await started(client, auth, **knobs)
    for kind in ("baseline_confirm", "feature_set"):
        await tick(client, auth)
        run = await get(client, auth, run["id"])
        assert run["waiting_on"] == kind, run["waiting_on"]
        assert (await _approve(client, auth, run)).status_code == 200
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["waiting_on"] == "eng_review", run["waiting_on"]
    return run


async def _state(tenant_id, field: str) -> str:
    async with tenant_session(tenant_id) as s:
        return await s.scalar(
            select(CheckpointAction.state).where(CheckpointAction.field == field)
        )


async def _decide_all(client, headers, run, size="m"):
    for body in (
        {"item_key": "price-early", "kind": "edit", "field": "verdict",
         "value": {"verdict": "not_feasible", "note": "Needs a new tax provider"}},
        {"item_key": "price-early", "kind": "edit", "field": "answer:q1",
         "value": "Not today: 900 ms at p95."},
        {"item_key": "price-early", "kind": "edit", "field": "size", "value": size},
    ):  # fmt: skip
        resp = await _act(client, headers, run, body)
        assert resp.status_code in (200, 201), resp.text


# --------------------------------------------------------------------------- unit


def test_the_flow_has_the_check_after_the_feature_set_and_it_skips_when_off():
    # protects=AC1/AC2 segment order, skip_when_off and the estimate; fails_when=the
    # check sits elsewhere, runs with its stop off or costs other than one architect;
    # no_claim=the dates stop (lane B).
    flow = flows.FLOWS["baseline_to_prd"]
    assert [s.name for s in flow.segments] == [
        "baseline", "feature_set", "eng_review", "priority", "prd_draft",
    ]  # fmt: skip
    sdef = flow.segment("eng_review")
    assert sdef.title == "Engineering check" and sdef.skip_when_off
    assert sdef.roles == ("architect",) and sdef.outputs == (flows.BRIEFS_FILE,)
    assert "Never give dates" in sdef.task
    knobs = flows.resolve_knobs(flow, {})
    assert knobs.checkpoints["eng_review"] is True
    assert flows.segment_estimate(sdef, knobs) == flows.Decimal("5.00")
    assert not any(s.skip_when_off for s in flow.segments if s.name != "eng_review")


# --------------------------------------------------------------------------- API


async def test_a_new_run_has_the_check_on_and_its_estimate_includes_it(client, owner, runtime):
    # protects=AC1 knobs and estimate, GET /v1/flows decider; fails_when=the check is off
    # by default, missing from the estimate or the flow says it is decided by role;
    # no_claim=eng_dates (lane B: $36.50 with both).
    _, auth = owner
    run = await create(client, auth)
    assert run["knobs"]["checkpoints"]["eng_review"] is True
    est = (await client.post(f"/v1/runs/{run['id']}/estimate", headers=auth)).json()
    assert est["total_usd"] == pytest.approx(31.5)
    row = next(s for s in est["segments"] if s["name"] == "eng_review")
    assert row["estimate_usd"] == 5.0 and row["title"] == "Engineering check"
    body = (await client.get("/v1/flows", headers=auth)).json()
    b2p = next(f for f in body["flows"] if f["key"] == "baseline_to_prd")
    deciders = {s["name"]: s["decider"] for s in b2p["segments"]}
    assert deciders["eng_review"] == "engineering_lead"
    assert deciders["priority"] == "role"
    spec = next(f for f in body["flows"] if f["key"] == "prd_to_spec")
    assert {s["decider"] for s in spec["segments"]} == {"role"}


async def test_with_the_check_off_no_step_runs_and_nothing_is_spent(client, owner, runtime):
    # protects=AC2 skip in segment mode; fails_when=the estimate counts it, a step is
    # submitted for it or the run stalls between the feature set and priority;
    # no_claim=workflow mode (covered by the plan's segment filter, not driven here).
    _, auth = owner
    run = await create(client, auth, checkpoints={"eng_review": False})
    est = (await client.post(f"/v1/runs/{run['id']}/estimate", headers=auth)).json()
    assert est["total_usd"] == pytest.approx(26.5)
    off = next(s for s in est["segments"] if s["name"] == "eng_review")
    assert off["estimate_usd"] == 0 and off["note"] == "Turned off when the run started."
    assert (await client.post(f"/v1/runs/{run['id']}/start", headers=auth)).status_code == 200
    for kind in ("baseline_confirm", "feature_set"):
        await tick(client, auth)
        run = await get(client, auth, run["id"])
        assert run["waiting_on"] == kind
        assert (await _approve(client, auth, run)).status_code == 200
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["waiting_on"] == "priority_order"
    seg = next(s for s in run["segments"] if s["name"] == "eng_review")
    assert seg["status"] == "skipped" and seg["cost_usd"] == 0
    assert "eng_review" not in [s.labels["segment"] for s in runtime.submitted]


async def test_the_run_waits_at_the_check_with_its_briefs(client, owner, runtime):
    # protects=AC3; fails_when=the check is not submitted after the feature set or its
    # checkpoint does not list tech_briefs.yaml; no_claim=the architect's content.
    _, auth = owner
    run = await _at_check(client, auth)
    cp = pending(run)
    assert cp["kind"] == "eng_review"
    seg = next(s for s in run["segments"] if s["name"] == "eng_review")
    assert flows.BRIEFS_FILE in seg["artifacts"]
    art = await client.get(
        f"/v1/runs/{run['id']}/segments/{seg['seq']}/artifacts/{flows.BRIEFS_FILE}", headers=auth
    )
    assert art.status_code == 200 and "price-early" in art.text


async def test_approve_is_blocked_until_each_verdict_and_blocking_answer(client, owner, runtime):
    # protects=AC6 the gate and c6 suggestions; fails_when=Approve passes with a feature
    # undecided or a blocking question open, or a commenter's verdict counts; no_claim=the
    # screen (Playwright).
    tenant_id, auth = owner
    run = await _at_check(client, auth)
    resp = await _approve(client, auth, run)
    assert resp.status_code == 409, resp.text
    detail = resp.json()["detail"]
    assert detail["code"] == "blocking_open"
    left = {(x["code"], x["item"], x.get("question_id")) for x in detail["left"]}
    assert left == {("no_verdict", "price-early", None), ("blocking_question", "price-early", "q1")}

    commenter = await person(tenant_id, "commenter")
    resp = await _act(client, commenter.headers, run, {
        "item_key": "price-early", "kind": "edit", "field": "verdict",
        "value": {"verdict": "feasible", "note": None}})  # fmt: skip
    assert resp.status_code in (200, 201), resp.text
    assert await _state(tenant_id, "verdict") == "suggested"
    assert (await _approve(client, auth, run)).status_code == 409

    await _decide_all(client, auth, run)
    resp = await _approve(client, auth, run)
    assert resp.status_code == 200, resp.text


@pytest.mark.parametrize(
    ("body", "words"),
    [
        ({"field": "verdict", "value": {"verdict": "maybe"}}, "verdict is"),
        ({"field": "verdict", "value": {"verdict": "not_feasible"}}, "needs a note"),
        ({"field": "verdict", "value": {"verdict": "feasible_with_changes", "note": " "}},
         "needs a note"),
        ({"field": "size", "value": "xxl"}, "size is one of"),
        ({"field": "answer:q9", "value": "Yes"}, "no question q9"),
        ({"field": "answer:q1", "value": ""}, "an answer is text"),
        ({"field": "title", "value": "x"}, "edit takes the field"),
        ({"item_key": "nope", "field": "size", "value": "m"}, "not a feature"),
    ],
)  # fmt: skip
async def test_the_vocabulary_refuses_what_it_does_not_allow(client, owner, runtime, body, words):
    # protects=AC §7 422s; fails_when=an invalid verdict, size, answer or feature is
    # stored; no_claim=question actions (D8's own tests).
    _, auth = owner
    run = await _at_check(client, auth)
    resp = await _act(client, auth, run, {"item_key": "price-early", "kind": "edit", **body})
    assert resp.status_code == 422, resp.text
    assert words in resp.text


async def test_approve_sets_the_size_and_tells_priority_about_the_verdict(client, owner, runtime):
    # protects=AC7; fails_when=the changed size is not the feature's locked attrs.effort
    # by the lead, or the priority prompt lacks the not-feasible feature and its reason;
    # no_claim=the priority score maths (C8).
    tenant_id, auth = owner
    run = await _at_check(client, auth)
    await _decide_all(client, auth, run, size="xl")
    assert (await _approve(client, auth, run)).status_code == 200
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["waiting_on"] == "priority_order"
    async with tenant_session(tenant_id) as s:
        rows = list(await s.scalars(select(Entity).where(Entity.key == "price-early")))
        feature = rows[0]
        assert feature.attrs["effort"] == "xl" and feature.locked
        events = list(
            await s.scalars(select(AuditEvent).where(AuditEvent.action == "entity.effort_set"))
        )
        assert [e.data["after"] for e in events] == ["xl"]
    prompt = runtime.submitted[-1].steps[-1].prompt
    assert runtime.submitted[-1].labels["segment"] == "priority"
    assert "price-early: Not feasible as scoped: Needs a new tax provider; size XL" in prompt
    assert "not_feasible" in prompt


async def test_with_a_lead_named_only_the_lead_decides(client, owner, runtime):
    # protects=AC4 at the check; fails_when=an approver decides while a lead is named, or
    # no-lead decisions are not audited engineering_lead_named false; no_claim=the
    # console path (A3's tests).
    tenant_id, auth = owner
    run = await _at_check(client, auth)
    approver = await person(tenant_id, "approver")
    lead = await person(tenant_id, "commenter", "lead")
    resp = await client.patch(
        f"/v1/members/{lead.user_id}", json={"engineering_lead": True}, headers=auth
    )
    assert resp.status_code == 200, resp.text
    # The lead (a commenter) stages; an approver who is not the lead only suggests.
    resp = await _act(client, approver.headers, run, {
        "item_key": "price-early", "kind": "edit", "field": "size", "value": "l"})  # fmt: skip
    assert resp.status_code in (200, 201), resp.text
    assert await _state(tenant_id, "size") == "suggested"
    await _decide_all(client, lead.headers, run)
    assert await _state(tenant_id, "size") == "staged"
    assert (await _approve(client, approver.headers, run)).status_code == 403
    resp = await _approve(client, lead.headers, run)
    assert resp.status_code == 200, resp.text
    async with tenant_session(tenant_id) as s:
        event = await s.scalar(
            select(AuditEvent)
            .where(AuditEvent.action == "checkpoint.approved")
            .order_by(AuditEvent.created_at.desc())
            .limit(1)
        )
        assert event.data["engineering_lead_named"] is True


async def test_with_no_lead_an_approver_decides_audited(client, owner, runtime):
    # protects=AC4 fallback; fails_when=an approver is refused with no lead named or the
    # audit lacks engineering_lead_named false; no_claim=A3's flag routes.
    tenant_id, auth = owner
    run = await _at_check(client, auth)
    approver = await person(tenant_id, "approver")
    await _decide_all(client, approver.headers, run)
    assert (await _approve(client, approver.headers, run)).status_code == 200
    async with tenant_session(tenant_id) as s:
        event = await s.scalar(
            select(AuditEvent)
            .where(AuditEvent.action == "checkpoint.approved")
            .order_by(AuditEvent.created_at.desc())
            .limit(1)
        )
        assert event.data["engineering_lead_named"] is False


async def test_send_back_reruns_the_architect_and_opens_a_new_check(client, owner, runtime):
    # protects=AC8 at the check; fails_when=the segment is not re-run with the note or no
    # new eng_review checkpoint opens; no_claim=D4's file format (its own tests).
    _, auth = owner
    run = await _at_check(client, auth)
    first = pending(run)["id"]
    resp = await client.post(
        _url(run, pending(run)) + "/decide",
        json={"decision": "changes_requested", "note": "Size the tax call again"},
        headers=auth,
    )
    assert resp.status_code == 200, resp.text
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["waiting_on"] == "eng_review" and pending(run)["id"] != first
    assert "Size the tax call again" in runtime.submitted[-1].steps[-1].prompt


async def test_a_run_started_before_the_check_keeps_its_segments(client, owner, runtime):
    # protects=AC28; fails_when=stored knobs without eng_review resolve it on; no_claim=
    # a migration (lane A has none).
    from oracle.runs import service

    tenant_id, auth = owner
    run = await create(client, auth)
    async with tenant_session(tenant_id) as s:
        row = await s.get(Run, uuid.UUID(run["id"]))
        old = {k: v for k, v in row.knobs["checkpoints"].items() if k != "eng_review"}
        row.knobs = {**row.knobs, "checkpoints": old}
        await s.commit()
        row = await s.get(Run, uuid.UUID(run["id"]))
        assert service._knobs(row).checkpoints["eng_review"] is False
