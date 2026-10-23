"""The PRD scope (C6): the features and requirements a feature-set stop approves for one
PRD, written from ``feature_set.yaml`` when the segment ends (oracle.runs.feature_set).

A run's feature-set segment writes one scope per attempt (``proposed``); approving its
checkpoint approves it, and every earlier approved scope of the same document becomes
``superseded``, as does a proposed one sent back with Request changes. Later segments, the
document's next drafts and the priority order read the approved scope, not the whole
baseline. Excluded and deferred features are scope-only: nothing in the baseline changes.
"""

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    Text,
    UniqueConstraint,
    Uuid,
    func,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from oracle.db import Base, TenantScoped
from oracle.docs.models import _in

SCOPE_STATUSES = ("proposed", "approved", "superseded")
ITEM_KINDS = ("feature", "requirement")
DECISIONS = ("include", "exclude", "defer", "keep", "cut")
FEATURE_DECISIONS = ("include", "exclude", "defer")
REQUIREMENT_DECISIONS = ("keep", "cut")
ITEM_ORIGINS = ("agent", "person")


class PrdScope(TenantScoped, Base):
    __tablename__ = "prd_scopes"
    __table_args__ = (
        UniqueConstraint("run_id", "segment_seq", "attempt"),
        CheckConstraint(_in("status", SCOPE_STATUSES), name="status"),
        Index("ix_prd_scopes_document", "document_id", "status"),
    )

    run_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("runs.id", ondelete="CASCADE"), nullable=False
    )
    segment_seq: Mapped[int] = mapped_column(Integer, nullable=False)
    attempt: Mapped[int] = mapped_column(Integer, nullable=False)
    checkpoint_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("checkpoints.id", ondelete="SET NULL")
    )
    document_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("documents.id", ondelete="SET NULL")
    )
    status: Mapped[str] = mapped_column(
        Text, nullable=False, default="proposed", server_default="proposed"
    )
    # The FeatureSetCheck of the scope as last checked (oracle.runs.feature_set).
    check_result: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, default=dict, server_default="{}"
    )
    # Null when Oracle approved it (the stop was off).
    approved_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )
    lock_version: Mapped[int] = mapped_column(
        Integer, nullable=False, default=1, server_default="1"
    )


class PrdScopeItem(TenantScoped, Base):
    """A feature (included, excluded or deferred) or one of its requirements (kept or
    cut) in a scope."""

    __tablename__ = "prd_scope_items"
    __table_args__ = (
        UniqueConstraint("scope_id", "kind", "key"),
        CheckConstraint(_in("kind", ITEM_KINDS), name="kind"),
        CheckConstraint(_in("decision", DECISIONS), name="decision_values"),
        CheckConstraint(_in("origin", ITEM_ORIGINS), name="origin"),
        CheckConstraint(
            f"(kind = 'feature' AND {_in('decision', FEATURE_DECISIONS)}) OR "
            f"(kind = 'requirement' AND {_in('decision', REQUIREMENT_DECISIONS)})",
            name="decision",
        ),
    )

    scope_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("prd_scopes.id", ondelete="CASCADE"), nullable=False, index=True
    )
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    # A requirement's feature.
    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("prd_scope_items.id", ondelete="CASCADE")
    )
    key: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    text: Mapped[str | None] = mapped_column(Text)
    acceptance: Mapped[list[str]] = mapped_column(
        JSONB, nullable=False, default=list, server_default="[]"
    )
    entity_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("entities.id", ondelete="SET NULL")
    )
    proposal_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("proposals.id", ondelete="SET NULL")
    )
    # [{goal_id, key, contribution}]
    goals: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, nullable=False, default=list, server_default="[]"
    )
    depends_on: Mapped[list[str]] = mapped_column(
        ARRAY(Text), nullable=False, default=list, server_default="{}"
    )
    blocker_keys: Mapped[list[str]] = mapped_column(
        ARRAY(Text), nullable=False, default=list, server_default="{}"
    )
    confidence: Mapped[Decimal | None] = mapped_column(Numeric(4, 3))
    evidence_ids: Mapped[list[uuid.UUID]] = mapped_column(
        ARRAY(Uuid), nullable=False, default=list, server_default="{}"
    )
    decision: Mapped[str] = mapped_column(Text, nullable=False)
    decision_reason: Mapped[str | None] = mapped_column(Text)
    origin: Mapped[str] = mapped_column(
        Text, nullable=False, default="agent", server_default="agent"
    )
    flags: Mapped[list[str]] = mapped_column(
        ARRAY(Text), nullable=False, default=list, server_default="{}"
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    # The agent's values (C7), for Undo and History; {} for a row a person added.
    original: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, default=dict, server_default="{}"
    )
    decided_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )
    lock_version: Mapped[int] = mapped_column(
        Integer, nullable=False, default=1, server_default="1"
    )
