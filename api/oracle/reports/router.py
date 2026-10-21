"""Alignment report routes (F6 §6): viewers and up read the reports, owners generate one
now and retry or dismiss a failed Slack post; reading one marks it read for me (the
Inbox's Done). Company-scoped: another company's report is a 404. Run tokens are refused
(the area is in no run-token scope, oracle.mcp.scopes)."""

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.auth.deps import Principal, TenantDB
from oracle.authz import recheck_caller, require_role
from oracle.reports import alignment, clock, service
from oracle.reports import slack as report_slack
from oracle.reports.models import AlignmentReport, AlignmentReportRead
from oracle.reports.schemas import (
    AlignmentReportCreate,
    AlignmentReportListItem,
    AlignmentReportOut,
)

router = APIRouter(prefix="/v1", tags=["reports"])

Viewer = Annotated[Principal, Depends(require_role("viewer"))]
Owner = Annotated[Principal, Depends(require_role("owner"))]


async def _report(db: AsyncSession, report_id: uuid.UUID, *, lock: bool = False) -> AlignmentReport:
    stmt = select(AlignmentReport).where(AlignmentReport.id == report_id)
    if lock:
        stmt = stmt.with_for_update()
    report = await db.scalar(stmt)
    if report is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Report not found")
    return report


@router.get("/alignment-reports", response_model=list[AlignmentReportListItem])
async def list_alignment_reports(
    principal: Viewer,
    db: TenantDB,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> list[AlignmentReportListItem]:
    """Every alignment report, newest first."""
    rows = list(
        await db.scalars(
            select(AlignmentReport)
            .order_by(AlignmentReport.created_at.desc(), AlignmentReport.id)
            .limit(limit)
            .offset(offset)
        )
    )
    read = await service.read_ids(db, principal, [r.id for r in rows])
    return [service.list_item(r, r.id in read) for r in rows]


@router.get("/alignment-reports/{report_id}", response_model=AlignmentReportOut)
async def get_alignment_report(
    report_id: uuid.UUID, principal: Viewer, db: TenantDB
) -> AlignmentReportOut:
    """One report: the headline, the summary figures, one part per track, its Markdown
    and its Slack post."""
    report = await _report(db, report_id)
    return service.report_out(
        report, report.id in await service.read_ids(db, principal, [report.id])
    )


@router.post(
    "/alignment-reports",
    response_model=AlignmentReportOut,
    status_code=status.HTTP_201_CREATED,
    responses={409: {"description": "No active or paused track"}},
)
async def create_alignment_report(
    body: AlignmentReportCreate, principal: Owner, db: TenantDB
) -> AlignmentReportOut:
    """Generate now: an on-demand report for the week so far, posted to Slack only with
    ``post_to_slack``."""
    await recheck_caller(db, principal, "owner")
    settings = await alignment.load_settings(db)
    week = alignment.week_start_of(clock.now(), settings.timezone)
    try:
        report = await alignment.build(
            db,
            kind="on_demand",
            week_start=week,
            settings=settings,
            generated_by=principal,
            post_to_slack=body.post_to_slack,
        )
    except alignment.NoTracks as e:
        raise HTTPException(status.HTTP_409_CONFLICT, str(e)) from None
    if report.slack_status == "pending":
        await report_slack.deliver(db, report, actor=principal)
    await db.commit()
    return service.report_out(report, False)


@router.post("/alignment-reports/{report_id}/read", response_model=AlignmentReportOut)
async def mark_alignment_report_read(
    report_id: uuid.UUID, principal: Viewer, db: TenantDB
) -> AlignmentReportOut:
    """I opened the report: Done in my Inbox (for me only)."""
    report = await _report(db, report_id)
    if principal.user_id is None:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "Reads belong to a person: sign in as a user"
        )
    await db.execute(
        insert(AlignmentReportRead)
        .values(
            id=uuid.uuid4(),
            tenant_id=principal.tenant_id,
            report_id=report.id,
            user_id=principal.user_id,
        )
        .on_conflict_do_nothing(index_elements=["report_id", "user_id"])
    )
    await db.commit()
    return service.report_out(report, True)


@router.post(
    "/alignment-reports/{report_id}/slack/retry",
    response_model=AlignmentReportOut,
    responses={409: {"description": "Nothing to retry"}},
)
async def retry_alignment_report_slack(
    report_id: uuid.UUID, principal: Owner, db: TenantDB
) -> AlignmentReportOut:
    """Post a report Slack refused again, now."""
    await recheck_caller(db, principal, "owner")
    report = await _report(db, report_id, lock=True)
    if report.slack_status not in ("pending", "failed"):
        raise HTTPException(
            status.HTTP_409_CONFLICT, f"Nothing to retry: the report is {report.slack_status}"
        )
    await report_slack.deliver(db, report, actor=principal)
    await db.commit()
    read = report.id in await service.read_ids(db, principal, [report.id])
    return service.report_out(report, read)


@router.post(
    "/alignment-reports/{report_id}/slack/dismiss",
    response_model=AlignmentReportOut,
    responses={409: {"description": "The post did not fail"}},
)
async def dismiss_alignment_report_slack(
    report_id: uuid.UUID, principal: Owner, db: TenantDB
) -> AlignmentReportOut:
    """Take "Report not posted to Slack" out of the owners' Inbox; the report stays."""
    await recheck_caller(db, principal, "owner")
    report = await _report(db, report_id, lock=True)
    if report.slack_status != "failed":
        raise HTTPException(status.HTTP_409_CONFLICT, "Only a failed Slack post can be dismissed")
    report.slack_dismissed_at = clock.now()
    await audit.record(
        db, principal, "alignment_report.post_dismissed", "alignment_report", report.id, {}
    )
    await db.commit()
    read = report.id in await service.read_ids(db, principal, [report.id])
    return service.report_out(report, read)
