import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, Text, Uuid, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from oracle.db import Base, TenantScoped
from oracle.docs.models import _in

PRIORITY_METHODS = ("goal_weighted", "rice", "moscow", "wsjf")
# saved: a person's snapshot, or a run's order once approved (C8); proposed: a run's order
# waiting at its priority stop; discarded: sent back, or replaced by a re-run's proposal.
SNAPSHOT_STATUSES = ("saved", "proposed", "discarded")


class PrioritySnapshot(TenantScoped, Base):
    """A scored, dependency-ordered ranking of features, with every number explained."""

    __tablename__ = "priority_snapshots"
    __table_args__ = (
        CheckConstraint(_in("method", PRIORITY_METHODS), name="method"),
        CheckConstraint(_in("status", SNAPSHOT_STATUSES), name="status"),
        Index("ix_priority_snapshots_document", "document_id", "status", text("created_at DESC")),
    )

    method: Mapped[str] = mapped_column(Text, nullable=False)
    params: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, server_default="{}")
    ranking: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, nullable=False, server_default="[]"
    )
    # User id or API token id; no FK because it can be either.
    created_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    status: Mapped[str] = mapped_column(
        Text, nullable=False, default="saved", server_default="saved"
    )
    # C8: the run whose priority.yaml this is, the checkpoint that decides it, the PRD it
    # is the order of (filled when the draft imports) and the approved PRD scope it ranks.
    run_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("runs.id", ondelete="SET NULL")
    )
    checkpoint_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("checkpoints.id", ondelete="SET NULL")
    )
    document_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("documents.id", ondelete="SET NULL")
    )
    scope_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("prd_scopes.id", ondelete="SET NULL")
    )
    # The check of the run's priority.yaml (oracle.priorities.run_order); {} for a person's.
    check_result: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, default=dict, server_default="{}"
    )
    # Who approved or discarded it, and when (null decided_by: Oracle, the stop was off).
    decided_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
