"""``alignment_reports`` and ``alignment_report_reads`` (F6, migration 0020_alignment_reports).

A report's ``content`` is what it says (oracle.reports.alignment), frozen when it is built;
``markdown`` is the same as text. The ``slack_*`` columns follow its post to the company's
Slack channel (oracle.reports.slack). One weekly report per company and week: the partial
unique index makes a second build impossible. Reads are per person (the Inbox's Done).
"""

import uuid
from datetime import date, datetime
from typing import Any

from sqlalchemy import (
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Text,
    UniqueConstraint,
    Uuid,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from oracle.db import Base, TenantScoped
from oracle.docs.models import _in

REPORT_KINDS = ("weekly", "on_demand")
SLACK_STATUSES = ("not_configured", "not_requested", "pending", "posted", "failed")


class AlignmentReport(TenantScoped, Base):
    __tablename__ = "alignment_reports"
    __table_args__ = (
        CheckConstraint(_in("kind", REPORT_KINDS), name="kind"),
        CheckConstraint(_in("slack_status", SLACK_STATUSES), name="slack_status"),
        Index(
            "ux_alignment_reports_week",
            "tenant_id",
            "week_start",
            unique=True,
            postgresql_where=text("kind = 'weekly'"),
        ),
    )

    kind: Mapped[str] = mapped_column(Text, nullable=False)
    # The Monday the week starts on, in the company's time zone.
    week_start: Mapped[date] = mapped_column(Date, nullable=False)
    period_start: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    period_end: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    timezone: Mapped[str] = mapped_column(Text, nullable=False)
    content: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    markdown: Mapped[str] = mapped_column(Text, nullable=False)
    # Null: the ticker built it.
    generated_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    slack_status: Mapped[str] = mapped_column(Text, nullable=False)
    slack_channel_id: Mapped[str | None] = mapped_column(Text)
    slack_channel_name: Mapped[str | None] = mapped_column(Text)
    slack_ts: Mapped[str | None] = mapped_column(Text)
    slack_error: Mapped[str | None] = mapped_column(Text)
    slack_attempts: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    slack_next_attempt_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    slack_posted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # An owner dismissed "Report not posted to Slack" in the Inbox.
    slack_dismissed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class AlignmentReportRead(TenantScoped, Base):
    """A person opened the report: Done in their Inbox, for them only."""

    __tablename__ = "alignment_report_reads"
    __table_args__ = (UniqueConstraint("report_id", "user_id"),)

    report_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("alignment_reports.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    read_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
