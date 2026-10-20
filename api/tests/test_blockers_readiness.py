"""§16 item 11 (the blocker half): a critical unresolved hard blocker stops a publish
unless an authorized person approved a scoped feasibility experiment or accepted the
risk; an ordinary advisory quality result alone never blocks."""

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select

import oracle.main  # noqa: F401 - registers the lanes' checks
from oracle import readiness
from oracle.baseline.models import Entity
from oracle.blockers.readiness import CHECK_KEY, critical_blockers
from oracle.readiness import CheckOutcome, ReadinessContext
from oracle.tenancy import tenant_session
from oracle.v2 import models as m
from tests.baseline_helpers import make_ctx
from tests.blocker_helpers import create_blocker, make_document, make_entity

LATER = (datetime.now(UTC) + timedelta(days=30)).isoformat()


async def _check(ctx, doc_id) -> CheckOutcome:
    async with tenant_session(ctx.tenant_id) as s:
        return await critical_blockers(ReadinessContext(s, doc_id, purpose="publish"))


async def _report(ctx, doc_id) -> readiness.ReadinessReport:
    async with tenant_session(ctx.tenant_id) as s:
        return await readiness.evaluate(ReadinessContext(s, doc_id, purpose="publish"))


def test_the_check_is_registered_as_hard():
    regs = {r.key: r for r in readiness.checks()}
    assert CHECK_KEY == "critical_blockers"
    assert regs[CHECK_KEY].hard is True


async def test_no_blockers_is_not_applicable():
    ctx = await make_ctx()
    doc_id = await make_document(ctx)
    out = await _check(ctx, doc_id)
    assert out.status == "not_applicable"


async def test_a_critical_unresolved_hard_blocker_blocks(client):
    ctx = await make_ctx()
    doc_id = await make_document(ctx)
    b = (
        await create_blocker(
            client, ctx, document_ids=[str(doc_id)], owner_id=str(ctx.users["approver"].id)
        )
    )["blocker"]
    out = await _check(ctx, doc_id)
    assert out.status == "critical"
    assert "Partner API" in out.rationale or "partner API" in out.rationale
    assert out.evidence_ids == [uuid.UUID(b["id"])]
    assert out.owner_id == ctx.users["approver"].id
    assert "blocker-partner-api-rate-limit" in out.section_keys
    with readiness.isolated_checks():
        readiness.register_check(CHECK_KEY, critical_blockers, hard=True)
        report = await _report(ctx, doc_id)
    assert report.blocked
    assert [r.key for r in report.blocking] == [CHECK_KEY]


async def test_mitigating_is_still_unresolved(client):
    ctx = await make_ctx()
    doc_id = await make_document(ctx)
    await create_blocker(client, ctx, document_ids=[str(doc_id)], status="mitigating")
    assert (await _check(ctx, doc_id)).status == "critical"


async def test_lesser_blockers_warn_but_do_not_block(client):
    ctx = await make_ctx()
    doc_id = await make_document(ctx)
    await create_blocker(client, ctx, key="hard-high", severity="high", document_ids=[str(doc_id)])
    await create_blocker(client, ctx, key="soft-critical", type="soft", document_ids=[str(doc_id)])
    await create_blocker(
        client, ctx, key="unknown-critical", type="unknown", document_ids=[str(doc_id)]
    )
    out = await _check(ctx, doc_id)
    assert out.status == "warning"
    assert "unknown-critical" in out.rationale or "Unknown critical" in out.rationale


async def test_a_resolved_blocker_passes(client):
    ctx = await make_ctx()
    doc_id = await make_document(ctx)
    b = (await create_blocker(client, ctx, document_ids=[str(doc_id)]))["blocker"]
    await client.post(
        f"/v1/blockers/{b['id']}/status",
        json={"status": "resolved", "reason": "The provider raised our tier"},
        headers=ctx.as_("approver"),
    )
    assert (await _check(ctx, doc_id)).status == "pass"


async def test_an_accepted_risk_passes_until_its_review_date(client):
    ctx = await make_ctx()
    doc_id = await make_document(ctx)
    b = (await create_blocker(client, ctx, document_ids=[str(doc_id)]))["blocker"]
    resp = await client.post(
        f"/v1/blockers/{b['id']}/accept-risk",
        json={"reason": "Pilot company volume stays under the limit", "review_at": LATER},
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 200, resp.text
    out = await _check(ctx, doc_id)
    assert out.status == "pass"
    assert "accepted" in out.rationale
    # An accepted risk is not forever: past its review date it blocks again.
    async with tenant_session(ctx.tenant_id) as s:
        decision = (await s.scalars(select(m.AssumptionDecision))).one()
        decision.review_at = datetime.now(UTC) - timedelta(minutes=1)
        await s.commit()
    out = await _check(ctx, doc_id)
    assert out.status == "critical"
    assert "review date" in out.rationale


async def test_an_approved_feasibility_experiment_passes(client):
    ctx = await make_ctx()
    doc_id = await make_document(ctx)
    b = (await create_blocker(client, ctx, document_ids=[str(doc_id)]))["blocker"]
    exp = await client.post(
        f"/v1/blockers/{b['id']}/experiments",
        json={
            "hypothesis": "Batching halves calls",
            "success_threshold": "Under 50 a minute",
            "owner_id": str(ctx.users["approver"].id),
            "decision_gate_at": LATER,
        },
        headers=ctx.as_("approver"),
    )
    exp = exp.json()
    resp = await client.post(
        f"/v1/blockers/{b['id']}/feasibility-scope",
        json={"experiment_id": exp["id"], "reason": "One pilot company only"},
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 200, resp.text
    out = await _check(ctx, doc_id)
    assert out.status == "pass"
    assert "feasibility" in out.rationale
    # Cancelling the experiment withdraws the scope.
    await client.patch(
        f"/v1/feasibility-experiments/{exp['id']}",
        json={"lock_version": exp["lock_version"], "status": "cancelled"},
        headers=ctx.as_("approver"),
    )
    assert (await _check(ctx, doc_id)).status == "critical"


async def test_a_status_written_around_the_strategy_is_refused(client):
    """Setting attrs.blocker.status through the generic baseline edit would skip the
    recorded decision (who and why): the edit is refused and the check still sees an
    unresolved blocker."""
    ctx = await make_ctx()
    doc_id = await make_document(ctx)
    b = (await create_blocker(client, ctx, document_ids=[str(doc_id)]))["blocker"]
    resp = await client.patch(
        f"/v1/baseline/entities/{b['id']}",
        json={
            "attrs": {
                "blocker": {**_attrs_of(await _entity(ctx, b["id"])), "status": "accepted_risk"}
            }
        },
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 422, resp.text
    out = await _check(ctx, doc_id)
    assert out.status == "critical"
    assert "unresolved" in out.rationale


async def test_a_blocker_linked_from_a_section_counts(client):
    ctx = await make_ctx()
    doc_id = await make_document(ctx)
    b = (await create_blocker(client, ctx))["blocker"]
    async with tenant_session(ctx.tenant_id) as s:
        s.add(
            m.DocumentSectionLink(
                document_id=doc_id,
                section_key="risks",
                kind="mentions",
                entity_id=uuid.UUID(b["id"]),
            )
        )
        await s.commit()
    assert (await _check(ctx, doc_id)).status == "critical"


async def test_unreadable_blocker_data_fails_closed():
    ctx = await make_ctx()
    doc_id = await make_document(ctx)
    entity_id = await make_entity(
        ctx, "constraint", "garbled", {"blocker": {"type": "hard", "severity": "catastrophic"}}
    )
    async with tenant_session(ctx.tenant_id) as s:
        s.add(
            m.DocumentSectionLink(
                document_id=doc_id, section_key="risks", kind="mentions", entity_id=entity_id
            )
        )
        await s.commit()
    out = await _check(ctx, doc_id)
    assert out.status == "critical"
    assert "cannot be read" in out.rationale


async def test_an_advisory_result_alone_never_blocks(client):
    ctx = await make_ctx()
    doc_id = await make_document(ctx)

    async def poor_quality(ctx_):
        return CheckOutcome(status="critical", rationale="Thin problem statement")

    with readiness.isolated_checks():
        readiness.register_check(CHECK_KEY, critical_blockers, hard=True)
        readiness.register_check("problem_clarity", poor_quality)  # advisory (T2)
        report = await _report(ctx, doc_id)
    assert not report.blocked
    assert {r.key: r.status for r in report.results} == {
        CHECK_KEY: "not_applicable",
        "problem_clarity": "critical",
    }


async def _entity(ctx, entity_id: str) -> Entity:
    async with tenant_session(ctx.tenant_id) as s:
        return await s.get(Entity, uuid.UUID(entity_id))


def _attrs_of(entity: Entity) -> dict:
    return dict(entity.attrs["blocker"])
