import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    Numeric,
    Text,
    UniqueConstraint,
    Uuid,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from oracle.auth.models import ROLES
from oracle.db import Base, TenantScoped
from oracle.docs.models import _in

FLOWS = ("baseline_to_prd", "feedback_loop", "prd_to_roadmap")
RUN_STATUSES = (
    "draft",
    "awaiting_approval",
    "running",
    "awaiting_checkpoint",
    "paused_overrun",
    "succeeded",
    "failed",
    "cancelled",
)
SEGMENT_STATUSES = ("pending", "running", "succeeded", "failed", "cancelled")
CHECKPOINT_KINDS = (
    "baseline_confirm",
    "feature_set",
    "priority_order",
    "prd_review",
    "eng_review",
    "roadmap_items",
    "roadmap_review",
)
CHECKPOINT_STATUSES = ("pending", "approved", "changes_requested", "skipped")

# US dollars to four decimal places: enough for per-call model costs.
Usd = Numeric(12, 4)


class Run(TenantScoped, Base):
    __tablename__ = "runs"
    __table_args__ = (
        CheckConstraint(_in("flow", FLOWS), name="flow"),
        CheckConstraint(_in("status", RUN_STATUSES), name="status"),
    )

    flow: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="draft")
    # {"depth", "roles", "checkpoints", "budget_usd"}
    knobs: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, server_default="{}")
    snapshot_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("snapshots.id", ondelete="SET NULL")
    )
    document_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("documents.id", ondelete="SET NULL")
    )
    estimate_usd: Mapped[Decimal | None] = mapped_column(Usd)
    spent_usd: Mapped[Decimal] = mapped_column(
        Usd, nullable=False, default=Decimal(0), server_default="0"
    )
    # User id or API token id; no FK because it can be either.
    created_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    # Who approved the cost estimate (runs over the approval threshold).
    approved_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # The last overrun Resume (a spend approval, C2): who gave it, when, and the ceiling
    # it replaced (restored if a demotion or disable voids it before its next segment
    # was submitted: oracle.members.service._void_spend_approvals).
    resumed_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    resumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    resumed_from_ceiling_usd: Mapped[Decimal | None] = mapped_column(Usd)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    error: Mapped[str | None] = mapped_column(Text)


class RunSegment(TenantScoped, Base):
    """One SwarmCloud workflow: the steps of a run between two checkpoints."""

    __tablename__ = "run_segments"
    __table_args__ = (
        UniqueConstraint("run_id", "seq"),
        CheckConstraint(_in("status", SEGMENT_STATUSES), name="status"),
    )

    run_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("runs.id", ondelete="CASCADE"), nullable=False
    )
    seq: Mapped[int] = mapped_column(Integer, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="pending")
    swarm_workflow_id: Mapped[str | None] = mapped_column(Text)
    estimate_usd: Mapped[Decimal | None] = mapped_column(Usd)
    cost_usd: Mapped[Decimal] = mapped_column(
        Usd, nullable=False, default=Decimal(0), server_default="0"
    )
    artifacts: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, server_default="{}")
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    error: Mapped[str | None] = mapped_column(Text)


class Checkpoint(TenantScoped, Base):
    """A stop in a run waiting on one approver (the Inbox)."""

    __tablename__ = "checkpoints"
    __table_args__ = (
        CheckConstraint(_in("kind", CHECKPOINT_KINDS), name="kind"),
        CheckConstraint(_in("status", CHECKPOINT_STATUSES), name="status"),
        CheckConstraint(_in("approver_role", ROLES), name="approver_role"),
    )

    run_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("runs.id", ondelete="CASCADE"), nullable=False, index=True
    )
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="pending")
    # The lowest role that may decide this checkpoint.
    approver_role: Mapped[str] = mapped_column(
        Text, nullable=False, default="approver", server_default="approver"
    )
    decided_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    note: Mapped[str | None] = mapped_column(Text)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, server_default="{}")
