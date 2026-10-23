"""The baseline graph: entities, edges, their evidence, history, proposals and conflicts.

Evidence, revisions, proposals and conflicts point at an entity OR an edge; a check
constraint enforces it (proposals may point at neither: a proposed new item).
"""

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Numeric,
    Text,
    UniqueConstraint,
    Uuid,
    false,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from oracle.db import Base, TenantScoped
from oracle.docs.models import _in

# v2 (§7, migration 0013) adds outcome, acceptance_criterion, assumption and risk, and the
# edges derived_from, verifies, affects and mitigates, so traceability stays in this one
# graph. A blocker is a "constraint" entity (oracle.v2.schemas.BlockerAttrs in attrs).
ENTITY_TYPES = (
    "goal",
    "product",
    "feature",
    "requirement",
    "constraint",
    "decision",
    "person",
    "outcome",
    "acceptance_criterion",
    "assumption",
    "risk",
    # H4 (migration 0020_strategy): a focus or stop choice of an approved product strategy.
    "strategy_choice",
)
EDGE_TYPES = (
    "supports",
    "depends_on",
    "blocks",
    "part_of",
    "owned_by",
    "derived_from",
    "verifies",
    "affects",
    "mitigates",
)
NODE_STATUSES = ("proposed", "confirmed", "rejected")
ORIGINS = ("user", "agent", "import")
PROPOSAL_STATUSES = ("open", "accepted", "rejected", "withdrawn")
CONFLICT_STATUSES = ("open", "resolved", "logged")
# Evidence from a public link (owner, 2026-10-17): scored like these source kinds.
LINK_KINDS = ("notion", "google_docs", "web")

EXACTLY_ONE_TARGET = "(entity_id IS NULL) <> (edge_id IS NULL)"
CONFIDENCE_RANGE = "confidence IS NULL OR (confidence >= 0 AND confidence <= 1)"
AT_MOST_ONE_TARGET = "entity_id IS NULL OR edge_id IS NULL"


def _entity_fk() -> Mapped[uuid.UUID | None]:
    return mapped_column(Uuid, ForeignKey("entities.id", ondelete="CASCADE"), index=True)


def _edge_fk() -> Mapped[uuid.UUID | None]:
    return mapped_column(Uuid, ForeignKey("edges.id", ondelete="CASCADE"), index=True)


def _run_fk() -> Mapped[uuid.UUID | None]:
    return mapped_column(Uuid, ForeignKey("runs.id", ondelete="SET NULL"), index=True)


class Entity(TenantScoped, Base):
    __tablename__ = "entities"
    __table_args__ = (
        UniqueConstraint("tenant_id", "type", "key"),
        CheckConstraint(_in("type", ENTITY_TYPES), name="type"),
        CheckConstraint(_in("status", NODE_STATUSES), name="status"),
        CheckConstraint(_in("origin", ORIGINS), name="origin"),
        CheckConstraint(CONFIDENCE_RANGE, name="confidence"),
    )

    type: Mapped[str] = mapped_column(Text, nullable=False)
    # Slug, unique per tenant and type, e.g. "activation".
    key: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    body: Mapped[str | None] = mapped_column(Text)
    # Type-specific fields: goal metric/target/horizon/weight/owner, feature
    # effort/confidence/status, ...
    attrs: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, server_default="{}")
    status: Mapped[str] = mapped_column(Text, nullable=False, default="proposed")
    origin: Mapped[str] = mapped_column(Text, nullable=False)
    # A user correction: agent writes to a locked entity become proposals.
    locked: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=false()
    )
    # User id or API token id; no FK because it can be either.
    locked_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    locked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Aggregate of its evidence's confidence (oracle.baseline confidence scoring).
    confidence: Mapped[Decimal | None] = mapped_column(Numeric(4, 3))
    run_id: Mapped[uuid.UUID | None] = _run_fk()
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class Edge(TenantScoped, Base):
    __tablename__ = "edges"
    __table_args__ = (
        UniqueConstraint("src_id", "dst_id", "type"),
        CheckConstraint(_in("type", EDGE_TYPES), name="type"),
        CheckConstraint(_in("status", NODE_STATUSES), name="status"),
        CheckConstraint(_in("origin", ORIGINS), name="origin"),
        CheckConstraint("src_id <> dst_id", name="not_self"),
        CheckConstraint(CONFIDENCE_RANGE, name="confidence"),
    )

    src_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("entities.id", ondelete="CASCADE"), nullable=False
    )
    dst_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("entities.id", ondelete="CASCADE"), nullable=False, index=True
    )
    type: Mapped[str] = mapped_column(Text, nullable=False)
    # "supports" carries {"contribution": 0-3}.
    attrs: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, server_default="{}")
    status: Mapped[str] = mapped_column(Text, nullable=False, default="proposed")
    origin: Mapped[str] = mapped_column(Text, nullable=False)
    locked: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=false()
    )
    locked_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    locked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Aggregate of its evidence's confidence (oracle.baseline confidence scoring).
    confidence: Mapped[Decimal | None] = mapped_column(Numeric(4, 3))
    run_id: Mapped[uuid.UUID | None] = _run_fk()
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class Evidence(TenantScoped, Base):
    __tablename__ = "evidence"
    __table_args__ = (
        CheckConstraint(EXACTLY_ONE_TARGET, name="one_target"),
        CheckConstraint(CONFIDENCE_RANGE, name="confidence"),
        CheckConstraint(f"kind IS NULL OR {_in('kind', LINK_KINDS)}", name="kind"),
    )

    entity_id: Mapped[uuid.UUID | None] = _entity_fk()
    edge_id: Mapped[uuid.UUID | None] = _edge_fk()
    source_item_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("source_items.id", ondelete="SET NULL"), index=True
    )
    url: Mapped[str | None] = mapped_column(Text)
    excerpt: Mapped[str | None] = mapped_column(Text)
    ref: Mapped[str | None] = mapped_column(Text)
    retrieved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # 0-1: how much this evidence counts in outputs (freshness, source kind, mentions,
    # goal impact); the inputs and their weights are kept in confidence_factors.
    confidence: Mapped[Decimal | None] = mapped_column(Numeric(4, 3))
    confidence_factors: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, server_default="{}"
    )
    scored_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Set for public-link evidence ("notion" | "google_docs" | "web"); its page is kept in
    # evidence_link_snapshots. Null for evidence from a source item or free-standing.
    kind: Mapped[str | None] = mapped_column(Text)
    # Why the person who added a public link cites it.
    note: Mapped[str | None] = mapped_column(Text)
    # User or API token that added it; the author of link evidence may remove it (C2c).
    added_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)


class EvidenceLinkSnapshot(TenantScoped, Base):
    """One fetch of a public link behind a piece of evidence; the newest is current.

    Fetched without any credential, so it is public and every user may see it.
    """

    __tablename__ = "evidence_link_snapshots"

    evidence_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("evidence.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # The page that was fetched (after redirects) and, for Google Docs, its export.
    final_url: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str | None] = mapped_column(Text)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    content_hash: Mapped[str] = mapped_column(Text, nullable=False)
    content_type: Mapped[str | None] = mapped_column(Text)
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # When the page says it last changed (Last-Modified header or page metadata).
    last_modified: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # User id or API token id that asked for the fetch.
    fetched_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)


class EntityRevision(TenantScoped, Base):
    """One change to an entity or edge: its fields before and after."""

    __tablename__ = "entity_revisions"
    __table_args__ = (CheckConstraint(EXACTLY_ONE_TARGET, name="one_target"),)

    entity_id: Mapped[uuid.UUID | None] = _entity_fk()
    edge_id: Mapped[uuid.UUID | None] = _edge_fk()
    # Null before = created; null after = deleted.
    before: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    after: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    # Audit actor string: "user:<uuid>", "token:<uuid>", "run:<uuid>" or "system".
    actor: Mapped[str] = mapped_column(Text, nullable=False)
    reason: Mapped[str | None] = mapped_column(Text)
    # The run whose write made it (B2: a run's merge); null for a person's edits.
    run_id: Mapped[uuid.UUID | None] = _run_fk()


class Proposal(TenantScoped, Base):
    """A change waiting for a person: agent writes to locked items land here."""

    __tablename__ = "proposals"
    __table_args__ = (
        CheckConstraint(AT_MOST_ONE_TARGET, name="one_target"),
        CheckConstraint(_in("status", PROPOSAL_STATUSES), name="status"),
    )

    # Both null: a proposed new entity or edge, described by the payload.
    entity_id: Mapped[uuid.UUID | None] = _entity_fk()
    edge_id: Mapped[uuid.UUID | None] = _edge_fk()
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    # The run that proposed it, if any.
    run_id: Mapped[uuid.UUID | None] = _run_fk()
    # Audit actor string of the proposer.
    actor: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="open")
    decided_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Conflict(TenantScoped, Base):
    __tablename__ = "conflicts"
    __table_args__ = (
        CheckConstraint(EXACTLY_ONE_TARGET, name="one_target"),
        CheckConstraint(_in("status", CONFLICT_STATUSES), name="status"),
    )

    entity_id: Mapped[uuid.UUID | None] = _entity_fk()
    edge_id: Mapped[uuid.UUID | None] = _edge_fk()
    field: Mapped[str] = mapped_column(Text, nullable=False)
    # [{"value", "evidence_ids", "source_kind", "observed_at"}, ...]
    claims: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, nullable=False, server_default="[]")
    resolution: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    # Material conflicts change a decision and are escalated; others are logged.
    material: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=false()
    )
    status: Mapped[str] = mapped_column(Text, nullable=False, default="open")
