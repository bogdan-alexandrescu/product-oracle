"""The hard readiness check cannot be talked around (PR #17 review).

- Every baseline write path (PATCH, POST, proposals, agent writes, YAML imports) refuses
  a change to ``attrs.blocker``: a blocker changes only through the blocker routes.
- The gate fails closed when the stored strategy disagrees with the last recorded
  blocker event, including a strategy edited straight in the database.
- A feasibility-only pass expires at its decision gate and needs its owner and success
  threshold; a succeeded experiment is time-boxed to its gate date.
- B4 (company settings): who may accept a critical hard blocker's risk or approve a
  feasibility scope (default owners), and the longest review horizon (default 90 days).
- Archiving or deleting a gating blocker: tests/test_blockers_gate_roles.py.
- One audit event per risk acceptance or feasibility scope.
"""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
import yaml
from sqlalchemy import select

from oracle.auth.deps import Principal
from oracle.baseline import service as baseline
from oracle.baseline.models import Entity, Proposal
from oracle.blockers.readiness import critical_blockers
from oracle.models import AuditEvent
from oracle.readiness import CheckOutcome, ReadinessContext
from oracle.tenancy import tenant_session
from oracle.v2 import models as m
from tests.baseline_helpers import make_ctx
from tests.blocker_helpers import create_blocker, make_document

LATER = (datetime.now(UTC) + timedelta(days=30)).isoformat()


async def _check(ctx, doc_id) -> CheckOutcome:
    async with tenant_session(ctx.tenant_id) as s:
        return await critical_blockers(ReadinessContext(s, doc_id, purpose="publish"))


async def _entity(ctx, entity_id) -> Entity:
    async with tenant_session(ctx.tenant_id) as s:
        return await s.get(Entity, uuid.UUID(str(entity_id)))


async def _gated(client, ctx):
    """A critical hard blocker gating one document, as the blocker routes record it."""
    doc_id = await make_document(ctx)
    b = (await create_blocker(client, ctx, document_ids=[str(doc_id)]))["blocker"]
    assert (await _check(ctx, doc_id)).status == "critical"
    return doc_id, b


async def _put_setting(client, ctx, key: str, value):
    return await client.put(f"/v1/settings/{key}", json={"value": value}, headers=ctx.as_("owner"))


async def _experiment(client, ctx, blocker_id, **body) -> dict:
    payload = {
        "hypothesis": "Batching halves calls",
        "method": "Replay a synthetic day",
        "success_threshold": "Under 50 requests a minute at peak",
        "owner_id": str(ctx.users["approver"].id),
        "decision_gate_at": LATER,
        **body,
    }
    resp = await client.post(
        f"/v1/blockers/{blocker_id}/experiments", json=payload, headers=ctx.as_("approver")
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _scoped(client, ctx, blocker_id, **body) -> dict:
    exp = await _experiment(client, ctx, blocker_id, **body)
    resp = await client.post(
        f"/v1/blockers/{blocker_id}/feasibility-scope",
        json={"experiment_id": exp["id"], "reason": "One pilot company only"},
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 200, resp.text
    return exp


async def _patch_experiment(client, ctx, exp_id: str, **body):
    async with tenant_session(ctx.tenant_id) as s:
        version = (await s.get(m.FeasibilityExperiment, uuid.UUID(exp_id))).lock_version
    return await client.patch(
        f"/v1/feasibility-experiments/{exp_id}",
        json={"lock_version": version, **body},
        headers=ctx.as_("approver"),
    )


# --- MAJOR 1: every baseline write path refuses a change to attrs.blocker ---------------


@pytest.mark.parametrize(
    "change",
    [
        {"blocker": None},
        "type",
        "severity",
        "document_ids",
        "status",
    ],
)
async def test_the_generic_patch_refuses_any_change_to_the_strategy(client, change):
    ctx = await make_ctx()
    doc_id, b = await _gated(client, ctx)
    stored = dict((await _entity(ctx, b["id"])).attrs["blocker"])
    if isinstance(change, dict):
        attrs = change
    else:
        new = {
            "type": "soft",
            "severity": "low",
            "document_ids": [],
            "status": "resolved",
        }[change]
        attrs = {"blocker": {**stored, change: new}}
    resp = await client.patch(
        f"/v1/baseline/entities/{b['id']}", json={"attrs": attrs}, headers=ctx.as_("owner")
    )
    assert resp.status_code == 422, resp.text
    assert "/v1/blockers" in resp.json()["detail"]
    assert (await _entity(ctx, b["id"])).attrs["blocker"] == stored
    assert (await _check(ctx, doc_id)).status == "critical"


async def test_other_attrs_of_a_blocker_entity_stay_editable(client):
    ctx = await make_ctx()
    doc_id, b = await _gated(client, ctx)
    resp = await client.patch(
        f"/v1/baseline/entities/{b['id']}",
        json={"title": "Partner API rate limit (per company)", "attrs": {"area": "sync"}},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 200, resp.text
    # Restating the stored strategy unchanged is not a change either.
    stored = (await _entity(ctx, b["id"])).attrs["blocker"]
    resp = await client.patch(
        f"/v1/baseline/entities/{b['id']}",
        json={"attrs": {"blocker": stored}},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 200, resp.text
    assert (await _check(ctx, doc_id)).status == "critical"


async def test_creating_an_entity_with_a_strategy_is_refused(client):
    ctx = await make_ctx()
    resp = await client.post(
        "/v1/baseline/entities",
        json={
            "type": "constraint",
            "key": "smuggled",
            "title": "Smuggled blocker",
            "attrs": {"blocker": {"type": "hard", "severity": "critical", "status": "resolved"}},
        },
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 422, resp.text
    assert "/v1/blockers" in resp.json()["detail"]


@pytest.mark.parametrize("op", ["update", "create"])
async def test_a_proposal_cannot_carry_a_strategy_change(client, op):
    ctx = await make_ctx()
    _doc_id, b = await _gated(client, ctx)
    if op == "update":
        body = {
            "op": "update",
            "kind": "entity",
            "entity_id": b["id"],
            "fields": {"attrs": {"blocker": None}},
        }
    else:
        body = {
            "op": "create",
            "kind": "entity",
            "fields": {
                "type": "constraint",
                "key": "agent-made",
                "title": "Agent-made blocker",
                "attrs": {"blocker": {"type": "hard", "severity": "critical"}},
            },
        }
    resp = await client.post("/v1/baseline/proposals", json=body, headers=ctx.as_("commenter"))
    assert resp.status_code == 422, resp.text


async def test_an_open_proposal_from_before_cannot_be_accepted(client):
    """A proposal stored before this rule existed is refused when an approver accepts."""
    ctx = await make_ctx()
    doc_id, b = await _gated(client, ctx)
    stored = dict((await _entity(ctx, b["id"])).attrs["blocker"])
    async with tenant_session(ctx.tenant_id) as s:
        proposal = Proposal(
            entity_id=uuid.UUID(b["id"]),
            payload={
                "op": "update",
                "kind": "entity",
                "fields": {"attrs": {"blocker": {**stored, "severity": "low"}}},
                "reason": "Looks minor",
                "origin": "agent",
            },
            actor="run:example",
            status="open",
        )
        s.add(proposal)
        await s.commit()
        proposal_id = proposal.id
    resp = await client.post(
        f"/v1/baseline/proposals/{proposal_id}/accept", json={}, headers=ctx.as_("owner")
    )
    assert resp.status_code == 422, resp.text
    assert (await _entity(ctx, b["id"])).attrs["blocker"] == stored
    assert (await _check(ctx, doc_id)).status == "critical"


async def test_an_agent_write_is_refused_not_proposed(client):
    ctx = await make_ctx()
    _doc_id, b = await _gated(client, ctx)
    principal = Principal(
        tenant_id=ctx.tenant_id, kind="user", role="approver", user_id=ctx.users["approver"].id
    )
    async with tenant_session(ctx.tenant_id) as s:
        entity = await s.get(Entity, uuid.UUID(b["id"]))
        writer = baseline.Writer(principal, "agent", reason="Run notes")
        with pytest.raises(baseline.InvalidError, match="/v1/blockers"):
            await baseline.update_entity(s, writer, entity, {"attrs": {"blocker": None}})
        assert (await s.scalars(select(Proposal))).all() == []


async def test_a_yaml_import_cannot_change_the_strategy(client):
    ctx = await make_ctx()
    doc_id, b = await _gated(client, ctx)
    stored = dict((await _entity(ctx, b["id"])).attrs["blocker"])
    exported = (await client.get("/v1/baseline/yaml", headers=ctx.as_("viewer"))).text
    data = yaml.safe_load(exported)
    mine = next(e for e in data["entities"] if e["key"] == b["key"])

    # Re-importing the export unchanged is fine.
    resp = await client.post(
        "/v1/baseline/yaml",
        content=yaml.safe_dump(data),
        headers={**ctx.as_("approver"), "Content-Type": "application/yaml"},
    )
    assert resp.status_code == 200, resp.text

    # A file that leaves the strategy out does not drop it.
    mine["attrs"] = {k: v for k, v in mine["attrs"].items() if k != "blocker"}
    resp = await client.post(
        "/v1/baseline/yaml",
        content=yaml.safe_dump(data),
        headers={**ctx.as_("approver"), "Content-Type": "application/yaml"},
    )
    assert resp.status_code == 200, resp.text
    assert (await _entity(ctx, b["id"])).attrs["blocker"] == stored

    # A file that rewrites it is rejected.
    mine["attrs"]["blocker"] = {**stored, "status": "resolved", "severity": "low"}
    resp = await client.post(
        "/v1/baseline/yaml",
        content=yaml.safe_dump(data),
        headers={**ctx.as_("approver"), "Content-Type": "application/yaml"},
    )
    assert resp.status_code == 422, resp.text
    assert "/v1/blockers" in resp.text
    assert (await _entity(ctx, b["id"])).attrs["blocker"] == stored
    assert (await _check(ctx, doc_id)).status == "critical"


async def test_the_blocker_routes_still_reclassify(client):
    """The blocker PATCH is the way to change type or severity; the gate follows it.
    Lowering a gating blocker takes an owner (B4, tests/test_blockers_lowering.py)."""
    ctx = await make_ctx()
    doc_id, b = await _gated(client, ctx)
    resp = await client.patch(
        f"/v1/blockers/{b['id']}",
        json={"revision": b["revision"], "severity": "high", "reason": "Pilot volume is small"},
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 200, resp.text
    assert (await _check(ctx, doc_id)).status == "warning"


# --- MAJOR 1: the gate fails closed on a strategy written around the routes --------------


@pytest.mark.parametrize(
    ("field", "value"),
    [("severity", "high"), ("type", "soft"), ("status", "resolved"), ("document_ids", [])],
)
async def test_a_strategy_edited_in_the_database_fails_closed(client, field, value):
    ctx = await make_ctx()
    doc_id, b = await _gated(client, ctx)
    async with tenant_session(ctx.tenant_id) as s:
        entity = await s.get(Entity, uuid.UUID(b["id"]))
        entity.attrs = {**entity.attrs, "blocker": {**entity.attrs["blocker"], field: value}}
        await s.commit()
    out = await _check(ctx, doc_id)
    assert out.status == "critical", out
    assert "outside" in out.rationale


async def test_a_strategy_deleted_in_the_database_fails_closed(client):
    ctx = await make_ctx()
    doc_id, b = await _gated(client, ctx)
    async with tenant_session(ctx.tenant_id) as s:
        entity = await s.get(Entity, uuid.UUID(b["id"]))
        entity.attrs = {k: v for k, v in entity.attrs.items() if k != "blocker"}
        await s.commit()
    out = await _check(ctx, doc_id)
    assert out.status == "critical", out


async def test_a_resolved_blocker_downgraded_through_the_routes_still_passes(client):
    ctx = await make_ctx()
    doc_id, b = await _gated(client, ctx)
    resp = await client.post(
        f"/v1/blockers/{b['id']}/status",
        json={"status": "resolved", "reason": "The provider raised our tier"},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 200, resp.text
    resp = await client.patch(
        f"/v1/blockers/{b['id']}",
        json={"revision": resp.json()["blocker"]["revision"], "document_ids": []},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 200, resp.text
    assert (await _check(ctx, doc_id)).status == "not_applicable"


# --- MAJOR 2: a feasibility-only pass expires --------------------------------------------


async def test_a_feasibility_scope_expires_at_its_decision_gate(client):
    ctx = await make_ctx()
    doc_id, b = await _gated(client, ctx)
    exp = await _scoped(client, ctx, b["id"])
    assert (await _check(ctx, doc_id)).status == "pass"
    past = (datetime.now(UTC) - timedelta(minutes=1)).isoformat()
    resp = await _patch_experiment(client, ctx, exp["id"], decision_gate_at=past)
    assert resp.status_code == 200, resp.text
    out = await _check(ctx, doc_id)
    assert out.status == "critical"
    assert "decision gate" in out.rationale


async def test_moving_the_gate_later_needs_a_new_approval(client):
    """The approved date caps the scope; extending the experiment does not extend it."""
    ctx = await make_ctx()
    doc_id, b = await _gated(client, ctx)
    exp = await _scoped(client, ctx, b["id"])
    much_later = (datetime.now(UTC) + timedelta(days=60)).isoformat()
    resp = await _patch_experiment(client, ctx, exp["id"], decision_gate_at=much_later)
    assert resp.status_code == 200, resp.text
    # Time passes beyond the approved gate date.
    async with tenant_session(ctx.tenant_id) as s:
        event = (
            await s.scalars(
                select(m.BlockerResolutionEvent).where(
                    m.BlockerResolutionEvent.kind == "feasibility_scope_approved"
                )
            )
        ).one()
        past = (datetime.now(UTC) - timedelta(minutes=1)).isoformat()
        event.data = {**event.data, "decision_gate_at": past}
        await s.commit()
    out = await _check(ctx, doc_id)
    assert out.status == "critical"
    assert "decision gate" in out.rationale


@pytest.mark.parametrize("cleared", ["owner_id", "success_threshold"])
async def test_a_feasibility_scope_needs_its_owner_and_threshold(client, cleared):
    ctx = await make_ctx()
    doc_id, b = await _gated(client, ctx)
    exp = await _scoped(client, ctx, b["id"])
    resp = await _patch_experiment(client, ctx, exp["id"], **{cleared: None})
    assert resp.status_code == 200, resp.text
    out = await _check(ctx, doc_id)
    assert out.status == "critical"
    assert ("owner" if cleared == "owner_id" else "success threshold") in out.rationale


async def test_a_succeeded_experiment_is_time_boxed_to_its_gate(client):
    ctx = await make_ctx()
    doc_id, b = await _gated(client, ctx)
    exp = await _scoped(client, ctx, b["id"])
    resp = await _patch_experiment(client, ctx, exp["id"], status="running")
    assert resp.status_code == 200, resp.text
    resp = await _patch_experiment(
        client, ctx, exp["id"], status="succeeded", result="Peak stayed at 40 a minute"
    )
    assert resp.status_code == 200, resp.text
    out = await _check(ctx, doc_id)
    assert out.status == "pass"
    assert "until" in out.rationale
    # Past its gate date a success alone does not pass: resolve the blocker.
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(m.FeasibilityExperiment, uuid.UUID(exp["id"]))
        row.decision_gate_at = datetime.now(UTC) - timedelta(minutes=1)
        await s.commit()
    out = await _check(ctx, doc_id)
    assert out.status == "critical"
    assert "resolve" in out.rationale
    resp = await client.post(
        f"/v1/blockers/{b['id']}/status",
        json={"status": "resolved", "reason": "The experiment proved batching is enough"},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 200, resp.text
    assert (await _check(ctx, doc_id)).status == "pass"


# --- B4: who accepts the risk, and for how long ------------------------------------------


async def test_the_b4_settings_have_their_defaults(client):
    ctx = await make_ctx()
    listed = (await client.get("/v1/settings", headers=ctx.as_("owner"))).json()
    values = {s["key"]: s["value"] for s in listed}
    assert values["blocker_risk_acceptance_role"] == "owner"
    assert values["blocker_risk_review_max_days"] == 90


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("blocker_risk_acceptance_role", "commenter"),
        ("blocker_risk_acceptance_role", "viewer"),
        ("blocker_risk_review_max_days", 0),
        ("blocker_risk_review_max_days", 366),
        ("blocker_risk_review_max_days", 12.5),
        ("blocker_risk_review_max_days", True),
    ],
)
async def test_the_b4_settings_are_validated(client, key, value):
    ctx = await make_ctx()
    assert (await _put_setting(client, ctx, key, value)).status_code == 422


@pytest.mark.parametrize("action", ["accept-risk", "feasibility-scope"])
async def test_by_default_only_owners_decide_a_critical_hard_blocker(client, action):
    ctx = await make_ctx()
    doc_id, b = await _gated(client, ctx)
    if action == "accept-risk":
        body = {"reason": "Pilot volume stays under the limit", "review_at": LATER}
    else:
        exp = await _experiment(client, ctx, b["id"])
        body = {"experiment_id": exp["id"], "reason": "One pilot company only"}
    url = f"/v1/blockers/{b['id']}/{action}"
    resp = await client.post(url, json=body, headers=ctx.as_("approver"))
    assert resp.status_code == 403, resp.text
    assert "owner" in resp.json()["detail"]
    assert (await _check(ctx, doc_id)).status == "critical"
    resp = await client.post(url, json=body, headers=ctx.as_("owner"))
    assert resp.status_code == 200, resp.text
    assert (await _check(ctx, doc_id)).status == "pass"


async def test_the_company_can_let_approvers_decide(client):
    ctx = await make_ctx()
    doc_id, b = await _gated(client, ctx)
    resp = await _put_setting(client, ctx, "blocker_risk_acceptance_role", "approver")
    assert resp.status_code == 200, resp.text
    resp = await client.post(
        f"/v1/blockers/{b['id']}/accept-risk",
        json={"reason": "Pilot volume stays under the limit", "review_at": LATER},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 200, resp.text
    assert (await _check(ctx, doc_id)).status == "pass"


async def test_approvers_still_decide_lesser_blockers(client):
    ctx = await make_ctx()
    b = (await create_blocker(client, ctx, severity="high"))["blocker"]
    resp = await client.post(
        f"/v1/blockers/{b['id']}/accept-risk",
        json={"reason": "Acceptable for the pilot", "review_at": LATER},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 200, resp.text


async def test_a_risk_acceptance_must_be_reviewed_within_the_horizon(client):
    ctx = await make_ctx()
    _doc_id, b = await _gated(client, ctx)
    url = f"/v1/blockers/{b['id']}/accept-risk"
    too_far = (datetime.now(UTC) + timedelta(days=91)).isoformat()
    resp = await client.post(
        url, json={"reason": "Pilot volume", "review_at": too_far}, headers=ctx.as_("owner")
    )
    assert resp.status_code == 422, resp.text
    assert "90 days" in resp.json()["detail"]

    assert (await _put_setting(client, ctx, "blocker_risk_review_max_days", 20)).is_success
    resp = await client.post(
        url, json={"reason": "Pilot volume", "review_at": LATER}, headers=ctx.as_("owner")
    )
    assert resp.status_code == 422, resp.text
    assert "20 days" in resp.json()["detail"]

    assert (await _put_setting(client, ctx, "blocker_risk_review_max_days", 120)).is_success
    resp = await client.post(
        url, json={"reason": "Pilot volume", "review_at": too_far}, headers=ctx.as_("owner")
    )
    assert resp.status_code == 200, resp.text


# --- one audit per decision --------------------------


async def _actions(ctx) -> dict[uuid.UUID, str]:
    async with tenant_session(ctx.tenant_id) as s:
        return dict((await s.execute(select(AuditEvent.id, AuditEvent.action))).all())


async def test_a_risk_acceptance_is_audited_once(client):
    ctx = await make_ctx()
    _doc_id, b = await _gated(client, ctx)
    before = await _actions(ctx)
    resp = await client.post(
        f"/v1/blockers/{b['id']}/accept-risk",
        json={"reason": "Pilot volume stays under the limit", "review_at": LATER},
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 200, resp.text
    added = [a for i, a in (await _actions(ctx)).items() if i not in before]
    blocker_audits = [a for a in added if a.startswith("blocker.")]
    assert blocker_audits == ["blocker.risk_accepted"]


async def test_a_feasibility_scope_is_audited_once(client):
    ctx = await make_ctx()
    _doc_id, b = await _gated(client, ctx)
    exp = await _experiment(client, ctx, b["id"])
    before = await _actions(ctx)
    resp = await client.post(
        f"/v1/blockers/{b['id']}/feasibility-scope",
        json={"experiment_id": exp["id"], "reason": "One pilot company only"},
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 200, resp.text
    added = [a for i, a in (await _actions(ctx)).items() if i not in before]
    assert [a for a in added if a.startswith("blocker.")] == ["blocker.feasibility_scope_approved"]
