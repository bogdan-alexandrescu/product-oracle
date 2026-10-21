"""Shapes of the alignment report routes (F6 §6)."""

import uuid
from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

ReportKind = Literal["weekly", "on_demand"]
SlackStatus = Literal["not_configured", "not_requested", "pending", "posted", "failed"]


class ReportPeriod(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    from_: datetime = Field(alias="from")
    to: datetime


class ReportSummaryFigures(BaseModel):
    tracks: int
    at_risk: int
    off_track: int
    slips: int
    untracked_now: int
    unplanned: int
    dates_verified: int
    dates_withdrawn: int


class ReportPrd(BaseModel):
    slug: str
    title: str


class ReportMilestone(BaseModel):
    name: str
    date: date | None
    # A verified schedule basis supports the date.
    verified: bool


class ReportAlignmentCounts(BaseModel):
    aligned: int
    drift: int
    untracked: int
    done: int


class ReportAttention(BaseModel):
    item_key: str
    title: str
    horizon: str
    # Until F2's alerts: the track's current at-risk reasons (blocked, stale, slipping).
    kind: str
    detail: str
    # F2's alert, once it ships.
    alert_id: uuid.UUID | None = None
    # The item in the Plan: /plan?item=<prd>:<key>.
    link: str


class ReportDrift(BaseModel):
    kind: Literal["ahead", "unplanned"]
    item_key: str | None = None
    tracker_ref: str | None = None
    detail: str
    title: str | None = None
    link: str | None = None


class ReportBasis(BaseModel):
    reference: str
    supports_date: date
    reason: str | None = None


class ReportDates(BaseModel):
    verified: list[ReportBasis]
    withdrawn: list[ReportBasis]


class ReportTrack(BaseModel):
    track_id: uuid.UUID
    status: Literal["active", "paused"]
    prd: ReportPrd
    link: str
    health: str
    health_before: str
    headline: str
    next_milestone: ReportMilestone | None
    alignment: ReportAlignmentCounts
    needs_attention: list[ReportAttention]
    drift: list[ReportDrift]
    dates: ReportDates
    prd_moved: bool


class ReportChannel(BaseModel):
    id: str
    name: str


class ReportSlack(BaseModel):
    status: SlackStatus
    channel: ReportChannel | None = None
    posted_at: datetime | None = None
    attempts: int = 0
    error: str | None = None
    next_attempt_at: datetime | None = None


class AlignmentReportListItem(BaseModel):
    id: uuid.UUID
    kind: ReportKind
    week_start: date
    title: str
    period: ReportPeriod
    timezone: str
    generated_at: datetime
    headline: str
    summary: ReportSummaryFigures
    slack: ReportSlack
    # Whether I opened it.
    read: bool


class ReportUnreadableTrack(BaseModel):
    track_id: uuid.UUID
    title: str


class AlignmentReportOut(AlignmentReportListItem):
    tracks: list[ReportTrack]
    # Tracks Oracle could not read when it built the report (logged); the rest stand.
    unreadable_tracks: list[ReportUnreadableTrack] = []
    markdown: str
    # Needs attention lists the tracks' current at-risk reasons (until F2 Track health).
    needs_attention_as_of_now: bool = True


class AlignmentReportCreate(BaseModel):
    post_to_slack: bool = False


class InboxReport(BaseModel):
    """Owners' Inbox: a weekly report, Open while unread, Done once I opened it."""

    id: uuid.UUID
    kind: ReportKind
    week_start: date
    # "Weekly alignment · week of Oct 19"
    title: str
    headline: str
    summary: ReportSummaryFigures
    read: bool
    created_at: datetime


class InboxReportFailure(BaseModel):
    """Owners' Inbox: a report Slack refused for 24 hours (Retry, Dismiss)."""

    id: uuid.UUID
    week_start: date
    # "Report not posted to Slack · week of Oct 19"
    title: str
    error: str | None
    channel: ReportChannel | None = None
    attempts: int
    created_at: datetime
