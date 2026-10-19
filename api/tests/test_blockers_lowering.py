"""Lowering a gating blocker, gate reads that never write (PR #31 review, round 3).

- B4 (owner, 2026-10-19): changing a blocker's severity or type so that it stops gating
  publish takes the B4 role (default owner): "This blocker gates publishing. Only an
  owner can lower it." Nothing is stored. Approvers may still mark it resolved, with a
  reason, audited; lowering a blocker that does not gate stays with approvers.
- Reads never write: a blocker without a gate snapshot (one the 0014 migration did not
  reach) is legacy-unrecorded, judged on its current strategy, and fails closed only if
  that strategy cannot be read. A write path records its first snapshot under the
  blocker's row lock.
- A YAML import refused under B4 is a 403 with the same text.
- A reopen by reclassification says so in the history, returns the scope's experiment
  to planned, and an owner reclassifying an approver's decision into the gate keeps it
  only by confirming it (``confirm_decision``).
"""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
import yaml
from sqlalchemy import func, select

from oracle.baseline.models import Entity
from oracle.blockers import service as blockers
from oracle.blockers.readiness import critical_blockers
from oracle.blockers.schemas import BlockerSpec, dump
from oracle.models import AuditEvent
from oracle.readiness import CheckOutcome, ReadinessContext
from oracle.tenancy import tenant_session
from oracle.v2 import models as m
from tests.baseline_helpers import make_ctx
from tests.blocker_helpers import create_blocker, make_document, make_entity

LATER = (datetime.now(UTC) + timedelta(days=30)).isoformat()
LOWER = "This blocker gates publishing. Only an owner can lower it."
STILL_GATES = "This blocker still gates publishing. Only an owner can archive it."


async def _check(ctx, doc_id) -> CheckOutcome:
    async with tenant_session(ctx.tenant_id) as s:
        return await critical_blockers(ReadinessContext(s, doc_id, purpose="publish"))


async def _entity(ctx, entity_id) -> Entity:
    async with tenant_session(ctx.tenant_id) as s:
        return await s.get(Entity, uuid.UUID(str(entity_id)))


async def _events(ctx, entity_id) -> list[m.BlockerResolutionEvent]:
    async with tenant_session(ctx.tenant_id) as s:
        return list(
            (
                await s.scalars(
                    select(m.BlockerResolutionEvent)
                    .where(m.BlockerResolutionEvent.blocker_id == uuid.UUID(str(entity_id)))
                    .order_by(m.BlockerResolutionEvent.created_at)
                )
            ).all()
        )


async def _blocker(client, ctx, **overrides):
    doc_id = await make_document(ctx)
    b = (await create_blocker(client, ctx, document_ids=[str(doc_id)], **overrides))["blocker"]
    return doc_id, b


async def _patch(client, ctx, blocker_id, who: str, **body):
    revision = (await _entity(ctx, blocker_id)).attrs["blocker"]["revision"]
    return await client.patch(
        f"/v1/blockers/{blocker_id}", json={"revision": revision, **body}, headers=ctx.as_(who)
    )


async def _experiment(client, ctx, blocker_id) -> dict:
    resp = await client.post(
        f"/v1/blockers/{blocker_id}/experiments",
        json={
            "hypothesis": "Batching halves calls",
            "method": "Replay a synthetic day",
            "success_threshold": "Under 50 requests a minute at peak",
            "owner_id": str(ctx.users["approver"].id),
            "decision_gate_at": LATER,
        },
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _decide(client, ctx, blocker_id, action: str, who: str) -> dict | None:
    """Accept the risk or approve a scope; returns the scope's experiment, if any."""
    exp = None
    if action == "accept-risk":
        body = {"reason": "Pilot volume stays under the limit", "review_at": LATER}
    else:
        exp = await _experiment(client, ctx, blocker_id)
        body = {"experiment_id": exp["id"], "reason": "One pilot company only"}
    resp = await client.post(f"/v1/blockers/{blocker_id}/{action}", json=body, headers=ctx.as_(who))
    assert resp.status_code == 200, resp.text
    return exp


async def _audits(ctx, action: str, entity_id) -> list[AuditEvent]:
    async with tenant_session(ctx.tenant_id) as s:
        return list(
            (
                await s.scalars(
                    select(AuditEvent).where(
                        AuditEvent.action == action,
                        AuditEvent.entity_id == uuid.UUID(str(entity_id)),
                    )
                )
            ).all()
        )


# --- MAJOR 1 (B4): lowering a gating blocker takes the owner role -----------------------


@pytest.mark.parametrize(
    "patch",
    [
        {"severity": "high"},
        {"severity": "low"},
        {"type": "soft"},
        {"type": "unknown", "severity": "medium"},
    ],
)
async def test_an_approver_cannot_lower_a_gating_blocker(client, patch):
    ctx = await make_ctx()
    doc_id, b = await _blocker(client, ctx)
    before = await _entity(ctx, b["id"])
    events_before = len(await _events(ctx, b["id"]))
    resp = await _patch(client, ctx, b["id"], "approver", **patch, statement="Renamed")
    assert resp.status_code == 403, resp.text
    assert resp.json()["detail"] == LOWER
    # Nothing is stored: not the strategy, not the title, not an event.
    after = await _entity(ctx, b["id"])
    assert after.attrs == before.attrs and after.title == before.title
    assert len(await _events(ctx, b["id"])) == events_before
    assert (await _check(ctx, doc_id)).status == "critical"


async def test_an_approver_cannot_lower_a_gating_blocker_while_its_risk_is_accepted(client):
    """An accepted risk still gates (it only lets a publish through for a while)."""
    ctx = await make_ctx()
    _doc_id, b = await _blocker(client, ctx)
    await _decide(client, ctx, b["id"], "accept-risk", "owner")
    resp = await _patch(client, ctx, b["id"], "approver", severity="high")
    assert resp.status_code == 403, resp.text
    assert resp.json()["detail"] == LOWER


async def test_the_lowering_403_names_the_configured_role(client):
    ctx = await make_ctx()
    _doc_id, b = await _blocker(client, ctx)
    resp = await client.put(
        "/v1/settings/blocker_risk_acceptance_role",
        json={"value": "approver"},
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 200, resp.text
    # With the role set to approver, an approver is the decider and may lower it.
    resp = await _patch(client, ctx, b["id"], "approver", severity="high")
    assert resp.status_code == 200, resp.text


async def test_an_owner_may_lower_a_gating_blocker(client):
    ctx = await make_ctx()
    doc_id, b = await _blocker(client, ctx)
    resp = await _patch(client, ctx, b["id"], "owner", severity="high", reason="Pilot is small")
    assert resp.status_code == 200, resp.text
    assert resp.json()["blocker"]["severity"] == "high"
    assert (await _check(ctx, doc_id)).status == "warning"


async def test_an_approver_may_resolve_a_gating_blocker_with_a_reason_audited(client):
    ctx = await make_ctx()
    doc_id, b = await _blocker(client, ctx)
    url = f"/v1/blockers/{b['id']}/status"
    resp = await client.post(url, json={"status": "resolved"}, headers=ctx.as_("approver"))
    assert resp.status_code == 422, resp.text
    resp = await client.post(
        url,
        json={"status": "resolved", "reason": "The provider raised our tier"},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 200, resp.text
    assert (await _check(ctx, doc_id)).status == "pass"
    audits = await _audits(ctx, "blocker.status_changed", b["id"])
    assert len(audits) == 1
    assert audits[0].actor == f"user:{ctx.users['approver'].id}"
    assert audits[0].data["to_status"] == "resolved"
    assert audits[0].data["reason"] == "The provider raised our tier"


@pytest.mark.parametrize(
    ("start", "patch"),
    [
        ({"severity": "high"}, {"severity": "low"}),
        ({"type": "soft"}, {"severity": "low"}),
        ({"type": "soft", "severity": "high"}, {"type": "temporary"}),
    ],
)
async def test_an_approver_may_lower_a_blocker_that_does_not_gate(client, start, patch):
    ctx = await make_ctx()
    _doc_id, b = await _blocker(client, ctx, **start)
    resp = await _patch(client, ctx, b["id"], "approver", **patch)
    assert resp.status_code == 200, resp.text


async def test_an_approver_may_lower_a_resolved_blocker(client):
    ctx = await make_ctx()
    doc_id, b = await _blocker(client, ctx)
    resp = await client.post(
        f"/v1/blockers/{b['id']}/status",
        json={"status": "resolved", "reason": "The provider raised our tier"},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 200, resp.text
    resp = await _patch(client, ctx, b["id"], "approver", severity="low")
    assert resp.status_code == 200, resp.text
    assert (await _check(ctx, doc_id)).status == "pass"


async def test_an_approver_may_still_edit_a_gating_blocker_without_lowering_it(client):
    ctx = await make_ctx()
    _doc_id, b = await _blocker(client, ctx)
    resp = await _patch(client, ctx, b["id"], "approver", timing="Next quarter", type="hard")
    assert resp.status_code == 200, resp.text


async def test_lowering_a_strategy_tampered_down_in_the_database_takes_an_owner(client):
    """The gate reads the last recorded snapshot: a blocker lowered in the database is
    still gating, and an approver's PATCH cannot launder that into a new snapshot."""
    ctx = await make_ctx()
    doc_id, b = await _blocker(client, ctx)
    async with tenant_session(ctx.tenant_id) as s:
        entity = await s.get(Entity, uuid.UUID(b["id"]))
        entity.attrs = {**entity.attrs, "blocker": {**entity.attrs["blocker"], "severity": "low"}}
        await s.commit()
    resp = await _patch(client, ctx, b["id"], "approver", timing="Whenever")
    assert resp.status_code == 403, resp.text
    assert resp.json()["detail"] == LOWER
    assert (await _check(ctx, doc_id)).status == "critical"


# --- MAJOR 2: reads never write ---------------------------------------------------------


async def _legacy(ctx, doc_id, key: str, **fields) -> uuid.UUID:
    """A blocker as stored before gate snapshots, which the 0014 migration did not reach."""
    spec = BlockerSpec(
        type=fields.get("type", "hard"),
        limit_kind="capacity",
        severity=fields.get("severity", "critical"),
        status=fields.get("status", "open"),
        document_ids=[doc_id],
    )
    return await make_entity(ctx, "constraint", key, {"blocker": dump(spec)})


async def _event_count(ctx) -> int:
    async with tenant_session(ctx.tenant_id) as s:
        return await s.scalar(select(func.count()).select_from(m.BlockerResolutionEvent))


async def test_reading_the_gate_writes_nothing(client):
    ctx = await make_ctx()
    doc_id = await make_document(ctx)
    entity_id = await _legacy(ctx, doc_id, "legacy-read", type="soft", severity="low")
    async with tenant_session(ctx.tenant_id) as s:
        out = await critical_blockers(ReadinessContext(s, doc_id, purpose="publish"))
        inputs = await blockers.gate_inputs(s, [entity_id])
        assert not s.new and not s.dirty
        await s.commit()  # even a committing caller stores nothing
    assert out.status == "pass", out
    assert entity_id not in inputs.recorded_gate
    for path in (
        f"/v1/blockers/{entity_id}",
        "/v1/blockers",
        f"/v1/documents/{doc_id}/blocker-strategy",
        f"/v1/documents/{doc_id}/blocker-strategy/render",
    ):
        resp = await client.get(path, headers=ctx.as_("viewer"))
        assert resp.status_code == 200, resp.text
    assert await _event_count(ctx) == 0


@pytest.mark.parametrize(
    ("fields", "expected"),
    [
        ({"type": "soft", "severity": "low", "status": "resolved"}, "pass"),
        ({"type": "hard", "severity": "high"}, "warning"),
        ({}, "critical"),
    ],
)
async def test_a_legacy_unrecorded_blocker_is_judged_on_its_strategy(client, fields, expected):
    ctx = await make_ctx()
    doc_id = await make_document(ctx)
    await _legacy(ctx, doc_id, "legacy-unrecorded", **fields)
    out = await _check(ctx, doc_id)
    assert out.status == expected, out
    assert "outside the blocker strategy (its type" not in out.rationale


async def test_an_unreadable_legacy_unrecorded_strategy_fails_closed(client):
    ctx = await make_ctx()
    doc_id = await make_document(ctx)
    await make_entity(
        ctx,
        "constraint",
        "legacy-garbled",
        {"blocker": {"type": "hard", "severity": "catastrophic", "document_ids": [str(doc_id)]}},
    )
    out = await _check(ctx, doc_id)
    assert out.status == "critical"
    assert "cannot be read" in out.rationale
    assert await _event_count(ctx) == 0


async def test_a_write_records_the_first_snapshot_of_a_legacy_blocker(client, monkeypatch):
    """The first write records the strategy as it was, under the row lock, so an edit
    around the routes afterwards fails closed."""
    ctx = await make_ctx()
    doc_id = await make_document(ctx)
    entity_id = await _legacy(ctx, doc_id, "legacy-written", type="soft", severity="low")
    locked = []
    real = blockers.require_constraint

    async def spy(db, entity_id, *, for_update=False):
        locked.append(for_update)
        return await real(db, entity_id, for_update=for_update)

    monkeypatch.setattr(blockers, "require_constraint", spy)
    resp = await _patch(client, ctx, entity_id, "approver", timing="Next quarter")
    assert resp.status_code == 200, resp.text
    assert locked and locked[0] is True
    snapshots = [e for e in await _events(ctx, entity_id) if "gate" in e.data]
    assert [e.data.get("change") for e in snapshots] == ["legacy_snapshot"]
    assert snapshots[0].data["gate"]["severity"] == "low"
    async with tenant_session(ctx.tenant_id) as s:
        entity = await s.get(Entity, entity_id)
        entity.attrs = {
            **entity.attrs,
            "blocker": {**entity.attrs["blocker"], "status": "resolved"},
        }
        await s.commit()
    out = await _check(ctx, doc_id)
    assert out.status == "critical"
    assert "outside" in out.rationale


# --- minors -----------------------------------------------------------------------------


async def test_a_yaml_import_refused_under_b4_is_a_403_with_the_same_text(client):
    ctx = await make_ctx()
    doc_id, b = await _blocker(client, ctx)
    data = yaml.safe_load((await client.get("/v1/baseline/yaml", headers=ctx.as_("viewer"))).text)
    next(e for e in data["entities"] if e["key"] == b["key"])["status"] = "rejected"
    resp = await client.post(f"/v1/baseline/entities/{b['id']}/unlock", headers=ctx.as_("approver"))
    assert resp.status_code == 200, resp.text
    resp = await client.post(
        "/v1/baseline/yaml",
        content=yaml.safe_dump(data),
        headers={**ctx.as_("approver"), "Content-Type": "application/yaml"},
    )
    assert resp.status_code == 403, resp.text
    assert resp.json()["detail"] == STILL_GATES
    assert (await _check(ctx, doc_id)).status == "critical"


@pytest.mark.parametrize(
    ("action", "summary"),
    [
        (
            "accept-risk",
            "Reopened by reclassification to hard critical (the risk acceptance needs an owner)",
        ),
        (
            "feasibility-scope",
            "Reopened by reclassification to hard critical (the feasibility scope needs an owner)",
        ),
    ],
)
async def test_a_reopen_by_reclassification_says_so(client, action, summary):
    ctx = await make_ctx()
    _doc_id, b = await _blocker(client, ctx, severity="high")
    await _decide(client, ctx, b["id"], action, "approver")
    resp = await _patch(client, ctx, b["id"], "approver", severity="critical")
    assert resp.status_code == 200, resp.text
    strategy = (await client.get(f"/v1/blockers/{b['id']}", headers=ctx.as_("viewer"))).json()
    reopened = [
        e for e in strategy["events"] if e["data"].get("change") == "reopened_by_reclassification"
    ]
    assert len(reopened) == 1
    assert reopened[0]["summary"] == summary


@pytest.mark.parametrize("start_running", [False, True])
async def test_a_reopen_returns_the_scope_experiment_to_planned(client, start_running):
    ctx = await make_ctx()
    _doc_id, b = await _blocker(client, ctx, severity="high")
    exp = await _decide(client, ctx, b["id"], "feasibility-scope", "approver")
    if start_running:
        resp = await client.patch(
            f"/v1/feasibility-experiments/{exp['id']}",
            json={"lock_version": exp["lock_version"], "status": "running"},
            headers=ctx.as_("approver"),
        )
        assert resp.status_code == 200, resp.text
    resp = await _patch(client, ctx, b["id"], "approver", severity="critical")
    assert resp.status_code == 200, resp.text
    async with tenant_session(ctx.tenant_id) as s:
        stored = await s.get(m.FeasibilityExperiment, uuid.UUID(exp["id"]))
        assert stored.status == "planned"
    reopened = [e for e in await _events(ctx, b["id"]) if e.to_status == "open"][-1]
    assert reopened.experiment_id == uuid.UUID(exp["id"])
    assert reopened.data["experiment"] == {
        "from": "running" if start_running else "planned",
        "to": "planned",
    }


@pytest.mark.parametrize("action", ["accept-risk", "feasibility-scope"])
async def test_an_owner_reclassifying_an_approvers_decision_reopens_it_unless_confirmed(
    client, action
):
    ctx = await make_ctx()
    doc_id, b = await _blocker(client, ctx, severity="high")
    await _decide(client, ctx, b["id"], action, "approver")
    resp = await _patch(client, ctx, b["id"], "owner", severity="critical")
    assert resp.status_code == 200, resp.text
    assert resp.json()["blocker"]["status"] == "open"
    assert (await _check(ctx, doc_id)).status == "critical"


@pytest.mark.parametrize("action", ["accept-risk", "feasibility-scope"])
async def test_an_owner_confirming_keeps_an_approvers_decision(client, action):
    ctx = await make_ctx()
    doc_id, b = await _blocker(client, ctx, severity="high")
    await _decide(client, ctx, b["id"], action, "approver")
    resp = await _patch(
        client, ctx, b["id"], "owner", severity="critical", confirm_decision=True, reason="Seen it"
    )
    assert resp.status_code == 200, resp.text
    status = "accepted_risk" if action == "accept-risk" else "feasibility_only"
    assert resp.json()["blocker"]["status"] == status
    assert (await _check(ctx, doc_id)).status == "pass"
    confirmed = [e for e in await _events(ctx, b["id"]) if e.data.get("change") == "confirmed"]
    assert len(confirmed) == 1 and confirmed[0].to_status is None
    assert len(await _audits(ctx, "blocker.decision_confirmed", b["id"])) == 1


async def test_an_owners_own_earlier_decision_stands_when_reclassified(client):
    ctx = await make_ctx()
    doc_id, b = await _blocker(client, ctx, severity="high")
    await _decide(client, ctx, b["id"], "accept-risk", "owner")
    resp = await _patch(client, ctx, b["id"], "approver", severity="critical")
    assert resp.status_code == 200, resp.text
    assert resp.json()["blocker"]["status"] == "accepted_risk"
    assert (await _check(ctx, doc_id)).status == "pass"


async def test_an_approver_cannot_confirm_a_decision(client):
    ctx = await make_ctx()
    _doc_id, b = await _blocker(client, ctx, severity="high")
    await _decide(client, ctx, b["id"], "accept-risk", "approver")
    before = await _entity(ctx, b["id"])
    resp = await _patch(
        client, ctx, b["id"], "approver", severity="critical", confirm_decision=True
    )
    assert resp.status_code == 403, resp.text
    assert resp.json()["detail"].startswith("Only an owner can confirm")
    assert (await _entity(ctx, b["id"])).attrs == before.attrs
