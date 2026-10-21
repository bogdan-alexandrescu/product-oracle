"""Reading alignment reports: the API shapes, who read what, and the owners' Inbox rows."""

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.auth.deps import Principal
from oracle.reports.alignment import short_day, title
from oracle.reports.models import AlignmentReport, AlignmentReportRead
from oracle.reports.schemas import (
    AlignmentReportListItem,
    AlignmentReportOut,
    InboxReport,
    InboxReportFailure,
    ReportChannel,
    ReportPeriod,
    ReportSlack,
)

# Weekly reports the owners' Inbox lists (the newest).
INBOX_REPORTS = 8


async def read_ids(
    db: AsyncSession, principal: Principal, report_ids: list[uuid.UUID]
) -> set[uuid.UUID]:
    """The reports among ``report_ids`` that I opened."""
    if principal.user_id is None or not report_ids:
        return set()
    return set(
        await db.scalars(
            select(AlignmentReportRead.report_id).where(
                AlignmentReportRead.user_id == principal.user_id,
                AlignmentReportRead.report_id.in_(report_ids),
            )
        )
    )


def _channel(r: AlignmentReport) -> ReportChannel | None:
    if not r.slack_channel_id:
        return None
    return ReportChannel(id=r.slack_channel_id, name=r.slack_channel_name or r.slack_channel_id)


def _slack(r: AlignmentReport) -> ReportSlack:
    return ReportSlack(
        status=r.slack_status,  # type: ignore[arg-type]
        channel=_channel(r),
        posted_at=r.slack_posted_at,
        attempts=r.slack_attempts,
        error=r.slack_error,
        next_attempt_at=r.slack_next_attempt_at,
    )


def _common(r: AlignmentReport, read: bool) -> dict[str, Any]:
    c = r.content
    return {
        "id": r.id,
        "kind": r.kind,
        "week_start": r.week_start,
        "title": title(r.kind, r.week_start),
        "period": ReportPeriod(from_=r.period_start, to=r.period_end),
        "timezone": r.timezone,
        "generated_at": r.created_at,
        "headline": c["headline"],
        "summary": c["summary"],
        "slack": _slack(r),
        "read": read,
    }


def list_item(r: AlignmentReport, read: bool) -> AlignmentReportListItem:
    return AlignmentReportListItem(**_common(r, read))


def report_out(r: AlignmentReport, read: bool) -> AlignmentReportOut:
    return AlignmentReportOut(
        **_common(r, read),
        tracks=r.content["tracks"],
        unreadable_tracks=r.content.get("unreadable_tracks", []),
        markdown=r.markdown,
        needs_attention_as_of_now=bool(r.content.get("needs_attention_as_of_now", True)),
    )


async def inbox_rows(
    db: AsyncSession, principal: Principal
) -> tuple[list[InboxReport], list[InboxReportFailure]]:
    """Owners only: the newest weekly reports (read or not) and the reports Slack refused
    for 24 hours, not dismissed."""
    if principal.role != "owner":
        return [], []
    weekly = list(
        await db.scalars(
            select(AlignmentReport)
            .where(AlignmentReport.kind == "weekly")
            .order_by(AlignmentReport.week_start.desc())
            .limit(INBOX_REPORTS)
        )
    )
    read = await read_ids(db, principal, [r.id for r in weekly])
    reports = [
        InboxReport(
            id=r.id,
            kind=r.kind,  # type: ignore[arg-type]
            week_start=r.week_start,
            title=title(r.kind, r.week_start),
            headline=r.content["headline"],
            summary=r.content["summary"],
            read=r.id in read,
            created_at=r.created_at,
        )
        for r in weekly
    ]
    failed = await db.scalars(
        select(AlignmentReport)
        .where(
            AlignmentReport.slack_status == "failed", AlignmentReport.slack_dismissed_at.is_(None)
        )
        .order_by(AlignmentReport.created_at)
    )
    failures = [
        InboxReportFailure(
            id=r.id,
            week_start=r.week_start,
            title=f"Report not posted to Slack · week of {short_day(r.week_start)}",
            error=r.slack_error,
            channel=_channel(r),
            attempts=r.slack_attempts,
            created_at=r.created_at,
        )
        for r in failed
    ]
    return reports, failures
