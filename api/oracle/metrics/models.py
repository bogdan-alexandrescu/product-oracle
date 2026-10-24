"""The metric catalog, its weekly values and their variances (H5, migration
0049_metrics).

- ``metrics``: a number Oracle reads every week. An output is a result the company
  wants (it may link one confirmed goal with the same unit); an input is a number the
  team can move, linked to the output it drives. Its source is a PostHog query, values
  typed by hand, or values written through the API. Changing the query or the unit
  raises ``definition_version``; ``definitions`` keeps each version.
- ``metric_values``: one value per metric per week (a Monday in the Company time zone),
  with the definition version it was read under.
- ``metric_variances``: a week whose change is outside the normal range
  (``oracle.metrics.variance``), its possible causes and what the metric's owner says.
"""

import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    Text,
    UniqueConstraint,
    Uuid,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from oracle.db import Base, TenantScoped
from oracle.docs.models import _in
from oracle.v2.models import _fk, _json, _lock_version, _updated_at

METRIC_KINDS = ("output", "input")
DIRECTIONS = ("up", "down")
METRIC_SOURCES = ("posthog", "manual", "api")
METRIC_STATUSES = ("active", "paused", "error", "archived")
VARIANCE_DIRECTIONS = ("better", "worse")
VARIANCE_STATUSES = ("open", "explained", "unknown", "noise")
CONFIDENCES = ("high", "medium", "low")


class Metric(TenantScoped, Base):
    __tablename__ = "metrics"
    __table_args__ = (
        CheckConstraint(_in("kind", METRIC_KINDS), name="kind"),
        CheckConstraint(_in("direction", DIRECTIONS), name="direction"),
        CheckConstraint(_in("source", METRIC_SOURCES), name="source"),
        CheckConstraint(_in("status", METRIC_STATUSES), name="status"),
        CheckConstraint(
            "threshold_pct IS NULL OR threshold_pct BETWEEN 1 AND 500", name="threshold_pct"
        ),
        CheckConstraint("(kind = 'input') = (drives_metric_id IS NOT NULL)", name="drives"),
        CheckConstraint("kind = 'output' OR goal_id IS NULL", name="goal"),
        CheckConstraint("(source = 'posthog') = (query IS NOT NULL)", name="query"),
        Index(
            "ux_metrics_title",
            "tenant_id",
            text("lower(title)"),
            unique=True,
            postgresql_where=text("status <> 'archived'"),
        ),
        Index(
            "ux_metrics_goal",
            "tenant_id",
            "goal_id",
            unique=True,
            postgresql_where=text("goal_id IS NOT NULL AND status <> 'archived'"),
        ),
    )

    updated_at: Mapped[datetime] = _updated_at()
    title: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    unit: Mapped[str] = mapped_column(Text, nullable=False)
    direction: Mapped[str] = mapped_column(Text, nullable=False)
    goal_id: Mapped[uuid.UUID | None] = _fk("entities", "SET NULL")
    drives_metric_id: Mapped[uuid.UUID | None] = _fk("metrics", "SET NULL")
    # A member (a user id), as a goal's owner.
    owner_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    source: Mapped[str] = mapped_column(Text, nullable=False)
    query: Mapped[str | None] = mapped_column(Text)
    threshold_pct: Mapped[Decimal | None] = mapped_column(Numeric(6, 2))
    definition_version: Mapped[int] = mapped_column(
        Integer, nullable=False, default=1, server_default="1"
    )
    # Each definition: [{"version", "unit", "query", "at"}], oldest first.
    definitions: Mapped[list[dict[str, Any]]] = _json("[]")
    status: Mapped[str] = mapped_column(
        Text, nullable=False, default="active", server_default="active"
    )
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    last_error: Mapped[str | None] = mapped_column(Text)
    last_pulled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # The first failed pull since the last good one (error after 24 hours), and when the
    # next attempt may run (hourly).
    failing_since: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    next_pull_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    lock_version: Mapped[int] = _lock_version()


class MetricValue(TenantScoped, Base):
    __tablename__ = "metric_values"
    __table_args__ = (
        UniqueConstraint("metric_id", "week_start"),
        CheckConstraint(_in("source", METRIC_SOURCES), name="source"),
        CheckConstraint("extract(isodow FROM week_start) = 1", name="monday"),
    )

    metric_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("metrics.id", ondelete="CASCADE"), nullable=False, index=True
    )
    week_start: Mapped[date] = mapped_column(Date, nullable=False)
    value: Mapped[Decimal] = mapped_column(Numeric(20, 6), nullable=False)
    source: Mapped[str] = mapped_column(Text, nullable=False)
    definition_version: Mapped[int] = mapped_column(Integer, nullable=False)
    note: Mapped[str | None] = mapped_column(Text)
    recorded_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    recorded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class MetricVariance(TenantScoped, Base):
    __tablename__ = "metric_variances"
    __table_args__ = (
        UniqueConstraint("metric_id", "week_start"),
        CheckConstraint(_in("direction", VARIANCE_DIRECTIONS), name="direction"),
        CheckConstraint(_in("status", VARIANCE_STATUSES), name="status"),
        CheckConstraint(
            "oracle_confidence IS NULL OR " + _in("oracle_confidence", CONFIDENCES),
            name="oracle_confidence",
        ),
    )

    updated_at: Mapped[datetime] = _updated_at()
    metric_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("metrics.id", ondelete="CASCADE"), nullable=False, index=True
    )
    week_start: Mapped[date] = mapped_column(Date, nullable=False)
    value: Mapped[Decimal] = mapped_column(Numeric(20, 6), nullable=False)
    previous: Mapped[Decimal] = mapped_column(Numeric(20, 6), nullable=False)
    band_low: Mapped[Decimal | None] = mapped_column(Numeric(20, 6))
    band_high: Mapped[Decimal | None] = mapped_column(Numeric(20, 6))
    direction: Mapped[str] = mapped_column(Text, nullable=False)
    # [{"kind", "title", "on", "href"}], at most 8 (oracle.metrics.causes).
    possible_causes: Mapped[list[dict[str, Any]]] = _json("[]")
    status: Mapped[str] = mapped_column(Text, nullable=False, default="open", server_default="open")
    explanation: Mapped[str | None] = mapped_column(Text)
    explained_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    explained_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    find_out_by: Mapped[date | None] = mapped_column(Date)
    noise_reason: Mapped[str | None] = mapped_column(Text)
    oracle_draft: Mapped[str | None] = mapped_column(Text)
    oracle_confidence: Mapped[str | None] = mapped_column(Text)
    oracle_refs: Mapped[list[dict[str, Any]]] = _json("[]")
    oracle_run_id: Mapped[uuid.UUID | None] = _fk("runs", "SET NULL")
    occurrence_id: Mapped[uuid.UUID | None] = _fk("ritual_occurrences", "SET NULL")
    lock_version: Mapped[int] = _lock_version()
