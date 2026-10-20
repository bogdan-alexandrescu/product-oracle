"""Shared setup for the CR-11 roadmap alignment and product track tests."""

import uuid
from datetime import UTC, date, datetime, timedelta

from sqlalchemy import select

from oracle.baseline.models import Edge, Entity
from oracle.roadmap.models import ScheduleBasis
from oracle.tenancy import tenant_session
from oracle.v2.models import FeasibilityExperiment

BLOCKER = {"type": "hard", "severity": "critical", "status": "open", "limit_kind": "capacity"}


async def entity(tenant_id: uuid.UUID, type_: str, key: str) -> Entity:
    async with tenant_session(tenant_id) as s:
        return await s.scalar(select(Entity).where(Entity.type == type_, Entity.key == key))


async def seed_trace(tenant_id: uuid.UUID) -> dict[str, uuid.UUID]:
    """On top of test_roadmap.seed_baseline: a requirement of the payment step, its
    acceptance criterion, and a critical hard blocker affecting the payment step with an
    open feasibility experiment."""
    async with tenant_session(tenant_id) as s:
        pay = await s.scalar(
            select(Entity).where(Entity.type == "feature", Entity.key == "payment-step")
        )
        req = Entity(
            type="requirement", key="saved-cards", title="Saved cards",
            status="confirmed", origin="user",
        )  # fmt: skip
        crit = Entity(
            type="acceptance_criterion", key="saved-cards-ac", title="A saved card pays in one tap",
            status="confirmed", origin="user",
        )  # fmt: skip
        blocker = Entity(
            type="constraint", key="psp-rate-limit", title="Payment provider rate limit",
            status="confirmed", origin="user", attrs={"blocker": dict(BLOCKER)},
        )  # fmt: skip
        s.add_all([req, crit, blocker])
        await s.flush()
        s.add_all(
            [
                Edge(src_id=req.id, dst_id=pay.id, type="part_of", status="confirmed",
                     origin="user"),
                Edge(src_id=crit.id, dst_id=req.id, type="verifies", status="confirmed",
                     origin="user"),
                Edge(src_id=blocker.id, dst_id=pay.id, type="affects", status="confirmed",
                     origin="user"),
            ]
        )  # fmt: skip
        s.add(
            FeasibilityExperiment(
                blocker_id=blocker.id,
                hypothesis="A token bucket keeps us under the limit",
                success_threshold="p99 under 300 ms at 5x load",
                decision_gate_at=datetime.now(UTC) + timedelta(days=14),
            )
        )
        await s.commit()
        return {"feature": pay.id, "requirement": req.id, "criterion": crit.id,
                "blocker": blocker.id}  # fmt: skip


async def basis(
    tenant_id: uuid.UUID,
    reference: str,
    when: date,
    kind: str = "estimate",
    status: str = "verified",
) -> uuid.UUID:
    async with tenant_session(tenant_id) as s:
        row = ScheduleBasis(
            kind=kind, reference=reference, supports_date=when, status=status,
            verified_at=datetime.now(UTC),
        )  # fmt: skip
        s.add(row)
        await s.commit()
        return row.id


async def other_company() -> dict[str, str]:
    """An owner token of a second company (negative cross-company tests)."""
    from tests.baseline_helpers import make_ctx

    ctx = await make_ctx("Other Co")
    return {"Authorization": f"Bearer {ctx.token}"}
