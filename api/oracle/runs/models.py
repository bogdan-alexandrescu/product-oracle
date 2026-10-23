import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    Text,
    UniqueConstraint,
    Uuid,
    false,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from oracle.auth.models import ROLES
from oracle.db import Base, TenantScoped
from oracle.docs.models import _in

# request_triage: C1 Requests' triage run (oracle.requests.triage, migration 0020_requests).
FLOWS = (
    "baseline_to_prd",
    "feedback_loop",
    "prd_to_roadmap",
    "prd_to_spec",
    "request_triage",
    "strategy_draft",
    "launch_kit",
    "baseline",
    # F5-2 (migration 0022_code_maps): one repo's code capability map.
    "code_map",
    "update_draft",
    # E1 (migration 0030_draft_roadmaps): one PRD draft's items-only roadmap.
    "prd_draft_items",
)
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
SEGMENT_STATUSES = ("pending", "running", "succeeded", "failed", "cancelled", "skipped")
CHECKPOINT_KINDS = (
    "baseline_confirm",
    "feature_set",
    "priority_order",
    "prd_review",
    "eng_review",
    "roadmap_items",
    "roadmap_review",
    "request_triage",
    "strategy_review",
    "launch_review",
    "update_review",
)
CHECKPOINT_STATUSES = ("pending", "approved", "changes_requested", "skipped")
# D8: what a person does to one item of a pending checkpoint's shared draft. Every kind the
# backlog uses is listed here from the start (look_again: B2 Baseline review from this run;
# add: C7 Scope review's added requirement); oracle.runs.actions.VOCABULARY says which a
# checkpoint kind takes.
ACTION_KINDS = (
    "accept",
    "edit",
    "drop",
    "restore",
    "split",
    "merge",
    "question",
    "waive",
    "look_again",
    "add",
)
# Staged by the checkpoint's approver role or above; suggested by a commenter (counts for
# nothing until an approver stages it).
ACTION_STATES = ("staged", "suggested")
# Where an action came from: a review screen's row, or a discussion (G4).
ACTION_ORIGINS = ("row", "discussion")

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
    # D8: the shared draft's note to the agents, and its revision (every draft write bumps
    # it; a decision sent with an older one is refused).
    draft_note: Mapped[str | None] = mapped_column(Text)
    draft_revision: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    # The structured review sent with a send-back (D4), or the edits applied (D7).
    review: Mapped[dict[str, Any] | None] = mapped_column(JSONB)


class CheckpointAction(TenantScoped, Base):
    """One staged or suggested action on one item of a pending checkpoint (D8)."""

    __tablename__ = "checkpoint_actions"
    __table_args__ = (
        CheckConstraint(_in("kind", ACTION_KINDS), name="kind"),
        CheckConstraint(_in("state", ACTION_STATES), name="state"),
        CheckConstraint(_in("origin", ACTION_ORIGINS), name="origin"),
        # One action per item, kind and field: staging again replaces it.
        Index(
            "ux_checkpoint_actions_slot",
            "checkpoint_id",
            "item_key",
            "kind",
            text("coalesce(field, '')"),
            unique=True,
        ),
    )

    checkpoint_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("checkpoints.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # The item's id in the reviewed file; "*" for the whole file.
    item_key: Mapped[str] = mapped_column(Text, nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    # kind=edit: horizon | milestone_date | milestone_name | depends_on | outcome | title
    #            | prd_section | order | clear:<field>   (the D2 vocabulary)
    field: Mapped[str | None] = mapped_column(Text)
    value: Mapped[Any | None] = mapped_column(JSONB)
    # The reason codes (D2) this action answers, e.g. ["unverified_date"].
    answers: Mapped[list[str]] = mapped_column(ARRAY(Text), nullable=False, server_default="{}")
    note: Mapped[str | None] = mapped_column(Text)
    state: Mapped[str] = mapped_column(Text, nullable=False, server_default="staged")
    question_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("stakeholder_questions.id", ondelete="SET NULL")
    )
    # User or API token ids (no FK, as on Run.created_by).
    created_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    updated_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )
    # G4: staged from a discussion; how it was staged (private) is never rewritten.
    origin: Mapped[str] = mapped_column(Text, nullable=False, default="row", server_default="row")
    discussion_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("discussions.id", ondelete="SET NULL")
    )
    discussion_change_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("discussion_changes.id", ondelete="SET NULL")
    )
    from_private: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=false()
    )
