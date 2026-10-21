"""/v1/strategy: the strategy stack, drift findings and their waivers (H4 §5).

Everyone reads (viewer+; run tokens with read:baseline). Owners waive any finding and
run the check now; approvers waive ``outside_strategy`` findings only. Drift is
advisory: nothing waits on a finding.
"""

import uuid
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select

from oracle import audit
from oracle.auth.deps import CurrentPrincipal, Principal, TenantDB
from oracle.authz import has_role, recheck_caller, require_role, require_role_now
from oracle.strategy import drift
from oracle.strategy.models import StrategyFinding
from oracle.strategy.schemas import (
    CheckOut,
    FindingKind,
    FindingStatus,
    StrategyFindingOut,
    StrategyStackOut,
    SubjectKind,
    WaiveIn,
)

router = APIRouter(prefix="/v1/strategy", tags=["strategy"])

Approver = Annotated[Principal, Depends(require_role("approver"))]
OwnerNow = Annotated[Principal, Depends(require_role_now("owner"))]
# Approvers may waive these too; every other kind is an owner's.
APPROVER_WAIVES = ("outside_strategy",)


@router.get("/stack", response_model=StrategyStackOut)
async def get_strategy_stack(db: TenantDB, _: CurrentPrincipal) -> StrategyStackOut:
    """The approved vision and strategy: focus choices with their goals, the stop list,
    the roadmap items under each, and the goals and items not under the strategy."""
    return await drift.stack(db)


@router.get("/findings", response_model=list[StrategyFindingOut])
async def list_strategy_findings(
    db: TenantDB,
    _: CurrentPrincipal,
    status_: Annotated[FindingStatus | None, Query(alias="status")] = "open",
    kind: FindingKind | None = None,
    subject_kind: SubjectKind | None = None,
) -> list[StrategyFinding]:
    """Drift findings, open by default; high first, then the newest."""
    stmt = select(StrategyFinding)
    if status_:
        stmt = stmt.where(StrategyFinding.status == status_)
    if kind:
        stmt = stmt.where(StrategyFinding.kind == kind)
    if subject_kind:
        stmt = stmt.where(StrategyFinding.subject_kind == subject_kind)
    rows = list(await db.scalars(stmt.order_by(StrategyFinding.first_seen_at.desc())))
    rows.sort(key=lambda r: r.severity != "high")
    return rows


@router.post("/findings/{finding_id}/waive", response_model=StrategyFindingOut)
async def waive_strategy_finding(
    finding_id: uuid.UUID, body: WaiveIn, db: TenantDB, principal: Approver
) -> StrategyFinding:
    """Waive an open finding with a reason (owners; approvers for outside_strategy). It
    stays waived until its subject changes again."""
    finding = await db.scalar(
        select(StrategyFinding).where(StrategyFinding.id == finding_id).with_for_update()
    )
    if finding is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Finding not found")
    needed = "approver" if finding.kind in APPROVER_WAIVES else "owner"
    if not has_role(principal.role, needed):
        raise HTTPException(status.HTTP_403_FORBIDDEN, f"Requires the {needed} role")
    await recheck_caller(db, principal, needed)
    if finding.status != "open":
        raise HTTPException(status.HTTP_409_CONFLICT, f"The finding is {finding.status}")
    finding.status = "waived"
    finding.waived_by = principal.user_id or principal.id
    finding.waived_at = datetime.now(UTC)
    finding.waive_reason = body.reason
    await audit.record(
        db,
        principal,
        "strategy_finding.waived",
        "strategy_finding",
        finding.id,
        {"kind": finding.kind, "subject": finding.subject_ref, "reason": body.reason},
    )
    await db.commit()
    await db.refresh(finding)
    return finding


@router.post("/check", response_model=CheckOut)
async def run_strategy_check(db: TenantDB, _: OwnerNow) -> CheckOut:
    """Recompute the drift findings now."""
    out = await drift.run_check(db, "manual")
    await db.commit()
    return CheckOut(**out)
