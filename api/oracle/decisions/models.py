"""The decision log (migration 0020_decisions).

A decision is one choice with one approver: its options, the evidence it rests on, what
it should lead to and when to look at it again. People and Oracle propose them by hand;
Oracle records the ones made elsewhere on its own (:mod:`oracle.decisions.capture`), one
row per source. ``class`` is derived from ``origin`` by the database: a run's stop
approved or sent back is a ``checkpoint`` record, everything else a ``judgement`` call.
"""

import uuid
from datetime import date, datetime
from typing import Any

from sqlalchemy import (
    CheckConstraint,
    Computed,
    Date,
    DateTime,
    Index,
    Integer,
    Text,
    UniqueConstraint,
    Uuid,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from oracle.db import Base, TenantScoped
from oracle.docs.models import _in
from oracle.v2.models import _fk, _json, _lock_version, _updated_at, _uuids

REVERSIBILITY = ("reversible", "irreversible")
DECISION_STATUSES = ("proposed", "decided", "superseded", "reversed", "withdrawn")
ORIGINS = (
    "manual",
    "oracle",
    "version_approval",
    "assumption",
    "blocker",
    "pushback_override",
    "priority_override",
    "autonomy",
    "checkpoint",
)
# Origins Oracle records on its own: decided as they are captured.
CAPTURED_ORIGINS = (
    "version_approval",
    "assumption",
    "blocker",
    "pushback_override",
    "priority_override",
    "checkpoint",
)
CLASSES = ("judgement", "checkpoint")
SUBJECT_KINDS = (
    "document",
    "document_version",
    "section",
    "roadmap_item",
    "entity",
    "blocker",
    "gap",
    "run",
    "ritual_occurrence",
    "discussion",
)
REVIEW_VERDICTS = ("reaffirmed", "revisit", "reversed")
# How a checkpoint record's decision arrived: Oracle's Inbox, SwarmCloud's console, or
# D10's automatic approval of a reviewed version.
DECIDED_VIA = ("oracle", "swarmcloud_console", "document_review")

CLASS_SQL = "CASE WHEN origin = 'checkpoint' THEN 'checkpoint' ELSE 'judgement' END"
DECIDED_SQL = (
    "status <> 'decided' OR (chosen_option IS NOT NULL AND rationale IS NOT NULL "
    "AND decided_at IS NOT NULL AND (review_at IS NOT NULL OR origin = 'checkpoint'))"
)


class Decision(TenantScoped, Base):
    __tablename__ = "decisions"
    __table_args__ = (
        UniqueConstraint("tenant_id", "number"),
        UniqueConstraint("tenant_id", "source_kind", "source_id"),
        CheckConstraint(_in("reversibility", REVERSIBILITY), name="reversibility"),
        CheckConstraint(_in("status", DECISION_STATUSES), name="status"),
        CheckConstraint(_in("origin", ORIGINS), name="origin"),
        CheckConstraint(DECIDED_SQL, name="decided"),
        Index(
            "ix_decisions_due",
            "tenant_id",
            "review_at",
            postgresql_where=text("status = 'decided' AND origin <> 'checkpoint'"),
        ),
        Index("ix_decisions_approver", "tenant_id", "approver_id", "status"),
        Index("ix_decisions_class", "tenant_id", "class", text("decided_at DESC")),
        Index(
            "ix_decisions_run", "tenant_id", "run_id", postgresql_where=text("run_id IS NOT NULL")
        ),
    )

    updated_at: Mapped[datetime] = _updated_at()
    # D-1, D-2, ... per company; assigned on create under an advisory lock, never reused.
    number: Mapped[int] = mapped_column(Integer, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    question: Mapped[str | None] = mapped_column(Text)
    context: Mapped[str | None] = mapped_column(Text)
    # [{key, label, summary, pros, cons, evidence_ids, cost_if_wrong, recommended}]
    options: Mapped[list[dict[str, Any]]] = _json("[]")
    chosen_option: Mapped[str | None] = mapped_column(Text)
    rationale: Mapped[str | None] = mapped_column(Text)
    reversibility: Mapped[str] = mapped_column(
        Text, nullable=False, default="reversible", server_default="reversible"
    )
    status: Mapped[str] = mapped_column(
        Text, nullable=False, default="proposed", server_default="proposed"
    )
    # The single approver (a user id; no FK, like the other *_by columns).
    approver_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    # Who prepares it: ``user:<id>`` or ``oracle``.
    driver: Mapped[str] = mapped_column(Text, nullable=False)
    contributor_ids: Mapped[list[uuid.UUID]] = _uuids()
    informed_ids: Mapped[list[uuid.UUID]] = _uuids()
    evidence_ids: Mapped[list[uuid.UUID]] = _uuids()
    entity_ids: Mapped[list[uuid.UUID]] = _uuids()
    # [{kind, id, ref}], at most 10.
    subjects: Mapped[list[dict[str, Any]]] = _json("[]")
    expected_outcome: Mapped[str | None] = mapped_column(Text)
    # {goal_id, metric, baseline, predicted, threshold, by}
    prediction: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    outcome_id: Mapped[uuid.UUID | None] = _fk("outcome_records", "SET NULL")
    review_at: Mapped[date | None] = mapped_column(Date)
    origin: Mapped[str] = mapped_column(Text, nullable=False)
    class_: Mapped[str] = mapped_column("class", Text, Computed(CLASS_SQL, persisted=True))
    # The capture source: one record per source.
    source_kind: Mapped[str | None] = mapped_column(Text)
    source_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    # Checkpoint records: the run ("Decisions in this run") and how the decision arrived.
    run_id: Mapped[uuid.UUID | None] = _fk("runs", "SET NULL")
    decided_via: Mapped[str | None] = mapped_column(Text)
    supersedes_id: Mapped[uuid.UUID | None] = _fk("decisions", "SET NULL")
    # The synced baseline ``decision`` entity (judgement calls only).
    entity_id: Mapped[uuid.UUID | None] = _fk("entities", "SET NULL")
    decided_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    # user | oracle | swarmcloud_console | document_review
    decided_actor: Mapped[str | None] = mapped_column(Text)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    lock_version: Mapped[int] = _lock_version()
    __mapper_args__ = {"version_id_col": lock_version}


class DecisionReview(TenantScoped, Base):
    """A look back at a decided decision: reaffirmed, revisit or reversed."""

    __tablename__ = "decision_reviews"
    __table_args__ = (CheckConstraint(_in("verdict", REVIEW_VERDICTS), name="verdict"),)

    decision_id: Mapped[uuid.UUID] = _fk("decisions", nullable=False)
    verdict: Mapped[str] = mapped_column(Text, nullable=False)
    note: Mapped[str] = mapped_column(Text, nullable=False)
    outcome_status: Mapped[str | None] = mapped_column(Text)
    next_review_at: Mapped[date | None] = mapped_column(Date)
    revisit_id: Mapped[uuid.UUID | None] = _fk("decisions", "SET NULL")
    reviewed_by: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
