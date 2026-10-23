"""Outcome records and learnings (migration 0014_quality).

An outcome record links what launched (an approved PRD version, a roadmap item, a
validation experiment) back to the goal it was meant to move, with the prediction and,
later, whether it held. A learning is what the company keeps from that for future module
and question recommendations. Neither ever changes a published document.
"""

import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    Text,
    Uuid,
    false,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from oracle.db import Base, TenantScoped
from oracle.docs.models import _in
from oracle.v2.models import _fk, _json, _lock_version, _texts, _updated_at, _uuids

# H3: "predicted" until the item ships, then "tracking" (on screen: Measuring).
OUTCOME_STATUSES = ("tracking", "held", "partially_held", "not_held", "inconclusive", "predicted")
ASSESSED = ("held", "partially_held", "not_held", "inconclusive")
LEARNING_TARGETS = ("module", "question_category", "criterion")
LEARNING_DIRECTIONS = ("recommend_more", "recommend_less", "note")
LEARNING_STATUSES = ("active", "retired")


class OutcomeRecord(TenantScoped, Base):
    __tablename__ = "outcome_records"
    __table_args__ = (
        CheckConstraint(_in("status", OUTCOME_STATUSES), name="status"),
        CheckConstraint(
            "confidence_at_prediction IS NULL OR confidence_at_prediction BETWEEN 0 AND 1",
            name="confidence_at_prediction",
        ),
        Index(
            "ux_outcome_records_item",
            "tenant_id",
            "roadmap_item_id",
            unique=True,
            postgresql_where=text("roadmap_item_id IS NOT NULL"),
        ),
        Index(
            "ix_outcome_records_due",
            "tenant_id",
            "assess_due_on",
            postgresql_where=text("status = 'tracking'"),
        ),
    )

    title: Mapped[str] = mapped_column(Text, nullable=False)
    # The baseline goal entity it serves, and the outcome entity it measures, if any.
    goal_id: Mapped[uuid.UUID] = _fk("entities", nullable=False)
    outcome_entity_id: Mapped[uuid.UUID | None] = _fk("entities", "SET NULL")
    # The PRD (and its approved version) the prediction came from.
    document_id: Mapped[uuid.UUID | None] = _fk("documents", "SET NULL")
    prd_version_id: Mapped[uuid.UUID | None] = _fk("document_versions", "SET NULL")
    # The launched roadmap item: a section ({#id}) of a roadmap version.
    roadmap_version_id: Mapped[uuid.UUID | None] = _fk("document_versions", "SET NULL")
    roadmap_item_key: Mapped[str | None] = mapped_column(Text)
    experiment_id: Mapped[uuid.UUID | None] = _fk("feasibility_experiments", "SET NULL")
    # H3: the roadmap item row and track it was predicted for (migration 0026).
    roadmap_item_id: Mapped[uuid.UUID | None] = _fk("roadmap_items", "SET NULL")
    track_id: Mapped[uuid.UUID | None] = _fk("product_tracks", "SET NULL")
    # decisions.outcome_id points back here: use_alter breaks the create-order cycle.
    decision_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("decisions.id", ondelete="SET NULL", use_alter=True), index=True
    )
    # No numeric prediction yet: the roadmap's approver is asked to add one.
    needs_prediction: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=false()
    )
    confidence_at_prediction: Mapped[Decimal | None] = mapped_column(Numeric(4, 3))
    shipped_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # {"kind": tracker | milestone | launch | manual, "refs": [...], "at"}.
    ship_signal: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    assess_due_on: Mapped[date | None] = mapped_column(Date)
    # Oracle's proposal on the due date (ProposedAssessment); a person confirms it.
    proposed_assessment: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    # Prediction: metric, baseline, predicted, threshold, by.
    prediction: Mapped[dict[str, Any]] = _json()
    module_keys: Mapped[list[str]] = _texts()
    gap_categories: Mapped[list[str]] = _texts()
    status: Mapped[str] = mapped_column(
        Text, nullable=False, default="tracking", server_default="tracking"
    )
    observed: Mapped[str | None] = mapped_column(Text)
    # Every assessment, oldest first (Assessment): a re-assessment never erases one.
    assessments: Mapped[list[dict[str, Any]]] = _json("[]")
    evidence_ids: Mapped[list[uuid.UUID]] = _uuids()
    owner_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    created_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    assessed_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    assessed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    lock_version: Mapped[int] = _lock_version()
    __mapper_args__ = {"version_id_col": lock_version}
    updated_at: Mapped[datetime] = _updated_at()


class QualityLearning(TenantScoped, Base):
    __tablename__ = "quality_learnings"
    __table_args__ = (
        CheckConstraint(_in("applies_to", LEARNING_TARGETS), name="applies_to"),
        CheckConstraint(_in("direction", LEARNING_DIRECTIONS), name="direction"),
        CheckConstraint(_in("status", LEARNING_STATUSES), name="status"),
        CheckConstraint("weight >= 1 AND weight <= 3", name="weight"),
    )

    outcome_id: Mapped[uuid.UUID | None] = _fk("outcome_records", "SET NULL")
    statement: Mapped[str] = mapped_column(Text, nullable=False)
    applies_to: Mapped[str] = mapped_column(Text, nullable=False)
    # A module key, a gap category or a criterion key.
    target: Mapped[str] = mapped_column(Text, nullable=False)
    direction: Mapped[str] = mapped_column(Text, nullable=False)
    weight: Mapped[int] = mapped_column(Integer, nullable=False, server_default="1")
    status: Mapped[str] = mapped_column(
        Text, nullable=False, default="active", server_default="active"
    )
    retired_reason: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    retired_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    retired_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = _updated_at()
