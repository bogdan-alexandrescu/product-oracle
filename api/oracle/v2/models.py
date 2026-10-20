"""Product Oracle v2 tables (migration 0013): the shared foundation the v2 lanes build on.

Every table is :class:`~oracle.db.TenantScoped`. Nothing here replaces an existing table:

- blockers are baseline ``constraint`` entities (``entities``); their options,
  experiments and resolution events point at that entity;
- traceability stays in the baseline graph (new entity and edge types in
  :mod:`oracle.baseline.models`); only links the graph cannot carry live here: document
  section links (revision-aware) and artifact dependencies with a freshness state;
- PRD text stays in ``document_versions`` and ``sections``; compositions record which
  modules a document uses, never a second copy of its Markdown.

Rows that people edit in place carry ``lock_version`` (optimistic concurrency, see
:mod:`oracle.v2.concurrency`). Free-standing ``*_by`` columns hold a user or API token
id with no FK, as elsewhere; ``actor`` columns hold the audit actor string.
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

from oracle.db import Base, TenantScoped
from oracle.docs.models import _in

# --- value sets (the Pydantic Literals in oracle.v2.schemas mirror these) -------------

SEMVER = r"^[0-9]+\.[0-9]+\.[0-9]+$"
MODULE_POLICIES = ("required", "conditional", "optional")
MODULE_ORIGINS = ("builtin", "company")
COMPOSITION_REVISION_STATUSES = ("working", "confirmed", "published", "superseded")

INTAKE_STATUSES = ("draft", "analyzing", "awaiting_answers", "ready", "converted", "archived")
# §5: the Gap Registry's statuses.
GAP_STATUSES = (
    "unknown",
    "under_investigation",
    "asked",
    "answered",
    # A critical gap answered below the owner role, waiting for review (B4).
    "answered_pending_review",
    "validated",
    "deferred",
    "accepted_risk",
)
# §5: required question categories.
GAP_CATEGORIES = (
    "customer_user",
    "pain_evidence",
    "goal_alignment",
    "success_metric",
    "differentiation",
    "alternatives",
    "constraints",
    "blockers",
    "economic_benefit",
    "effort_cost",
    "security_privacy",
    "ownership",
    "non_goals",
    "release_rollout",
    "evaluation_criteria",
    "third_party_policy",
    "configurability_scaling",
)
# §5 step 5: what a missing answer affects.
IMPACT_AREAS = ("goals", "feasibility", "scope", "economics", "risks", "module_selection")
IMPORTANCE = ("critical", "high", "medium", "low")
# §5 step 3: never present an inference or a hypothesis as a fact.
KNOWLEDGE_STATES = ("verified_fact", "user_decision", "ai_inference", "hypothesis", "unknown")
QUESTION_STATUSES = (
    "draft",
    "asked",
    "answered",
    "deferred",
    "delegated",
    "researching",
    "withdrawn",
)
# §5 step 6: "I don't know", defer, another person's answer, "Research this".
ANSWER_KINDS = ("answer", "dont_know", "defer", "delegate", "research")
ASSUMPTION_DECISIONS = ("accept_assumption", "accept_risk", "validate", "reject")

# §6 solution approaches and the blocker lifecycle.
BLOCKER_APPROACHES = (
    "direct_remedy",
    "alternative_workflow",
    "architecture",
    "partnership",
    "operations",
    "distribution",
)
FEASIBILITY = ("high", "medium", "low", "unknown")
# §6: options must stay within platform rules; a non-compliant option is never selected.
COMPLIANCE = ("compliant", "needs_review", "non_compliant")
BLOCKER_OPTION_STATUSES = ("proposed", "evaluating", "selected", "fallback", "rejected")
EXPERIMENT_STATUSES = ("planned", "running", "succeeded", "failed", "inconclusive", "cancelled")
BLOCKER_STATUSES = ("open", "mitigating", "resolved", "accepted_risk", "feasibility_only")
BLOCKER_EVENT_KINDS = (
    "status_changed",
    "option_selected",
    "experiment_started",
    "experiment_concluded",
    "risk_accepted",
    "feasibility_scope_approved",
    "reopened",
)

# §7 / §11.5.
FRESHNESS = ("fresh", "potentially_stale", "under_review", "reconciled")
SECTION_LINK_KINDS = ("implements", "evidences", "claims", "tests", "mentions")
LINK_PRECISION = ("section", "paragraph", "claim")
# What a change event is about (waves.md: the oracle/changes.py hook).
CHANGE_SUBJECTS = (
    "document_section",
    "requirement",
    "decision",
    "source_permission",
    "blocker_status",
    "composition_revision",
    "document_version",
    "entity",
    "artifact_version",
    # A product track's monitoring (oracle.roadmap, migration 0016_roadmap).
    "product_track",
)

# §10, T2: advisory by default; hard only where a hard readiness check says so.
FINDING_STATUSES = ("pass", "warning", "critical", "not_applicable")
EVALUATORS = ("rules", "llm_job", "agent", "human")
REPORT_STATUSES = ("pending", "complete", "failed")

# §11: downstream artifacts.
ARTIFACT_KINDS = (
    "tech_brief",
    "engineering_spec",
    "user_flow",
    "wireframe",
    "prototype",
    "acceptance_tests",
    "figma_design",
)
ARTIFACT_REQUEST_STATUSES = (
    "requested",
    "queued",
    "running",
    "succeeded",
    "partial",
    "failed",
    "blocked",
    "cancelled",
)
ARTIFACT_VERSION_STATUSES = ("draft", "in_review", "approved", "rejected", "superseded")
ARTIFACT_REVIEW_KINDS = (
    "comment",
    "approved",
    "changes_requested",
    "rejected",
    "marked_stale",
    "reconciled",
)

CONFIDENCE_RANGE = "confidence IS NULL OR (confidence >= 0 AND confidence <= 1)"


def _all_in(column: str, values: tuple[str, ...]) -> str:
    """Every element of an ARRAY(Text) column is one of ``values``."""
    return f"{column} <@ ARRAY[{', '.join(repr(v) for v in values)}]::text[]"


def _fk(table: str, ondelete: str = "CASCADE", *, nullable: bool = True) -> Any:
    return mapped_column(
        Uuid, ForeignKey(f"{table}.id", ondelete=ondelete), nullable=nullable, index=True
    )


def _updated_at() -> Mapped[datetime]:
    return mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


def _lock_version() -> Mapped[int]:
    return mapped_column(Integer, nullable=False, default=1, server_default="1")


def _uuids() -> Mapped[list[uuid.UUID]]:
    return mapped_column(ARRAY(Uuid), nullable=False, server_default="{}")


def _texts() -> Mapped[list[str]]:
    return mapped_column(ARRAY(Text), nullable=False, server_default="{}")


def _json(default: str = "{}") -> Any:
    return mapped_column(JSONB, nullable=False, server_default=default)


# --- semantic modules (§4) --------------------------------------------------------------


class ModuleDefinition(TenantScoped, Base):
    """A semantic module (``constraints.solutions``), separate from template format/style.

    Built-ins are copied into each company like templates; a company edit is a new
    :class:`ModuleVersion` with origin ``company``, never a change to a built-in row.
    """

    __tablename__ = "module_definitions"
    __table_args__ = (UniqueConstraint("tenant_id", "key"),)

    # Stable semantic id, e.g. "goals.outcomes".
    key: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    builtin: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=false()
    )
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)


class ModuleVersion(TenantScoped, Base):
    """Immutable release of a module: its validated contract (oracle.v2.contract)."""

    __tablename__ = "module_versions"
    __table_args__ = (
        UniqueConstraint("module_id", "version"),
        CheckConstraint(f"version ~ '{SEMVER}'", name="semver"),
        CheckConstraint(_in("origin", MODULE_ORIGINS), name="origin"),
    )

    module_id: Mapped[uuid.UUID] = _fk("module_definitions", nullable=False)
    version: Mapped[str] = mapped_column(Text, nullable=False)
    # ModuleContract.model_dump(mode="json"); validated before it is stored.
    contract: Mapped[dict[str, Any]] = _json()
    # sha256 of the canonical contract JSON: detects a re-import that changed nothing.
    contract_hash: Mapped[str] = mapped_column(Text, nullable=False)
    origin: Mapped[str] = mapped_column(Text, nullable=False, server_default="builtin")
    created_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)


class TemplateModuleAssignment(TenantScoped, Base):
    """One module in a template's manifest. A template with no rows has no manifest and
    behaves exactly as before (legacy)."""

    __tablename__ = "template_module_assignments"
    __table_args__ = (
        UniqueConstraint("template_id", "module_key"),
        CheckConstraint(_in("policy", MODULE_POLICIES), name="policy"),
        CheckConstraint(f"module_version IS NULL OR module_version ~ '{SEMVER}'", name="semver"),
    )

    template_id: Mapped[uuid.UUID] = _fk("templates", nullable=False)
    module_key: Mapped[str] = mapped_column(Text, nullable=False)
    # Pinned module release; null follows the newest release.
    module_version: Mapped[str | None] = mapped_column(Text)
    policy: Mapped[str] = mapped_column(Text, nullable=False)
    display_order: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    # Legacy template section ids ({#id}) this module maps to, where unambiguous.
    section_ids: Mapped[list[str]] = _texts()
    # First template version the assignment applies to; null: every version.
    since_template_version: Mapped[int | None] = mapped_column(Integer)
    # Manifest format version, so the parser can read older manifests.
    manifest_format: Mapped[int] = mapped_column(Integer, nullable=False, server_default="1")
    created_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)


class DocumentComposition(TenantScoped, Base):
    """The module composition of one document; its history is its revisions."""

    __tablename__ = "document_compositions"
    __table_args__ = (UniqueConstraint("document_id"),)

    document_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("documents.id", ondelete="CASCADE"), nullable=False
    )
    template: Mapped[str | None] = mapped_column(Text)
    template_version: Mapped[str | None] = mapped_column(Text)
    # Number of the revision in force (CompositionRevision.number); null before the first.
    current_revision: Mapped[int | None] = mapped_column(Integer)
    lock_version: Mapped[int] = _lock_version()
    __mapper_args__ = {"version_id_col": lock_version}
    updated_at: Mapped[datetime] = _updated_at()


class CompositionRevision(TenantScoped, Base):
    """A decided composition: modules with versions, inputs, who decided and why.

    A material change makes a new ``working`` revision; a published revision is never
    changed (§4.3 steps 7-8).
    """

    __tablename__ = "composition_revisions"
    __table_args__ = (
        UniqueConstraint("composition_id", "number"),
        CheckConstraint(_in("status", COMPOSITION_REVISION_STATUSES), name="status"),
    )

    composition_id: Mapped[uuid.UUID] = _fk("document_compositions", nullable=False)
    number: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(
        Text, nullable=False, default="working", server_default="working"
    )
    # [CompositionModule]: key, version, policy, included, reason, order, section_ids.
    modules: Mapped[list[dict[str, Any]]] = _json("[]")
    # CompositionInputs: template, brief, snapshots, scope, category, output requests.
    inputs: Mapped[dict[str, Any]] = _json()
    decided_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reason: Mapped[str | None] = mapped_column(Text)
    # The revision this one was derived from.
    parent_number: Mapped[int | None] = mapped_column(Integer)
    # The document version it was published with (published revisions only).
    document_version_id: Mapped[uuid.UUID | None] = _fk("document_versions", "SET NULL")
    lock_version: Mapped[int] = _lock_version()
    __mapper_args__ = {"version_id_col": lock_version}


# --- intake, gaps, questions (§5) -------------------------------------------------------


class ProductIntake(TenantScoped, Base):
    """A short product brief and what Oracle made of it, pinned to source snapshots."""

    __tablename__ = "product_intakes"
    __table_args__ = (CheckConstraint(_in("status", INTAKE_STATUSES), name="status"),)

    title: Mapped[str] = mapped_column(Text, nullable=False)
    brief: Mapped[str] = mapped_column(Text, nullable=False)
    author_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    # Snapshot ids (snapshots.id) the intake reads; later sources never rewrite it (S4).
    source_snapshot_ids: Mapped[list[uuid.UUID]] = _uuids()
    status: Mapped[str] = mapped_column(
        Text, nullable=False, default="draft", server_default="draft"
    )
    # IntakeAnalysis: users, problem, outcomes, goal links, scope, blockers, category.
    analysis: Mapped[dict[str, Any]] = _json()
    document_id: Mapped[uuid.UUID | None] = _fk("documents", "SET NULL")
    lock_version: Mapped[int] = _lock_version()
    __mapper_args__ = {"version_id_col": lock_version}
    updated_at: Mapped[datetime] = _updated_at()


class KnowledgeGap(TenantScoped, Base):
    """One entry of the Gap Registry (§5)."""

    __tablename__ = "knowledge_gaps"
    __table_args__ = (
        CheckConstraint(_in("category", GAP_CATEGORIES), name="category"),
        CheckConstraint(_in("importance", IMPORTANCE), name="importance"),
        CheckConstraint(_in("status", GAP_STATUSES), name="status"),
        CheckConstraint(_in("knowledge_state", KNOWLEDGE_STATES), name="knowledge_state"),
        CheckConstraint(_all_in("impact", IMPACT_AREAS), name="impact"),
        CheckConstraint(CONFIDENCE_RANGE, name="confidence"),
        CheckConstraint("intake_id IS NOT NULL OR document_id IS NOT NULL", name="subject"),
        CheckConstraint(
            "importance_basis IS NULL OR importance_basis IN ('brief', 'person')",
            name="importance_basis",
        ),
        # Rule-made rows from before their importance basis was recorded: read by
        # /v1/gaps?importance= (oracle.intake.views); the next analysis records it.
        Index(
            "ix_knowledge_gaps_legacy_importance",
            "intake_id",
            postgresql_where=text("rule_key IS NOT NULL AND importance_basis IS NULL"),
        ),
    )

    intake_id: Mapped[uuid.UUID | None] = _fk("product_intakes")
    document_id: Mapped[uuid.UUID | None] = _fk("documents")
    category: Mapped[str] = mapped_column(Text, nullable=False)
    statement: Mapped[str] = mapped_column(Text, nullable=False)
    impact: Mapped[list[str]] = _texts()
    importance: Mapped[str] = mapped_column(Text, nullable=False)
    evidence_ids: Mapped[list[uuid.UUID]] = _uuids()
    confidence: Mapped[Decimal | None] = mapped_column(Numeric(4, 3))
    knowledge_state: Mapped[str] = mapped_column(Text, nullable=False, server_default="unknown")
    status: Mapped[str] = mapped_column(
        Text, nullable=False, default="unknown", server_default="unknown"
    )
    # The person who decides it (user id).
    owner_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    related_modules: Mapped[list[str]] = _texts()
    # When the gap counts as closed, in words ("a named owner and a dated metric").
    stop_condition: Mapped[str | None] = mapped_column(Text)
    # Baseline entities (entities.id) and document sections ({#id}) it concerns.
    entity_ids: Mapped[list[uuid.UUID]] = _uuids()
    section_keys: Mapped[list[str]] = _texts()
    created_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    # The category key of a rule-made gap (the intake engine's own, one per category);
    # None for a gap a person or the model wrote. Its statement text may change in
    # code; this does not (S6: model-written gaps are private, rule-made ones are not).
    rule_key: Mapped[str | None] = mapped_column(Text)
    # Where the importance comes from: "brief" (the engine, from the brief and public
    # facts; refreshed by each analysis) or "person" (someone set it; kept). None: a row
    # from before this was recorded, whose importance others read from the brief (S6).
    importance_basis: Mapped[str | None] = mapped_column(Text)
    lock_version: Mapped[int] = _lock_version()
    __mapper_args__ = {"version_id_col": lock_version}
    updated_at: Mapped[datetime] = _updated_at()


class StakeholderQuestion(TenantScoped, Base):
    """A question in the ledger, asked in short prioritized batches."""

    __tablename__ = "stakeholder_questions"
    __table_args__ = (
        CheckConstraint(_in("status", QUESTION_STATUSES), name="status"),
        CheckConstraint(_in("category", GAP_CATEGORIES), name="category"),
    )

    gap_id: Mapped[uuid.UUID | None] = _fk("knowledge_gaps")
    intake_id: Mapped[uuid.UUID | None] = _fk("product_intakes")
    document_id: Mapped[uuid.UUID | None] = _fk("documents")
    category: Mapped[str] = mapped_column(Text, nullable=False)
    prompt: Mapped[str] = mapped_column(Text, nullable=False)
    # Why it is asked (expected effect on goals, scope, ... ); shown with the question.
    rationale: Mapped[str | None] = mapped_column(Text)
    # Lower asks first; batch groups questions asked together.
    priority: Mapped[int] = mapped_column(Integer, nullable=False, server_default="100")
    batch: Mapped[int | None] = mapped_column(Integer)
    asked_to: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    asked_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    module_key: Mapped[str | None] = mapped_column(Text)
    section_key: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(
        Text, nullable=False, default="draft", server_default="draft"
    )
    updated_at: Mapped[datetime] = _updated_at()


class StakeholderAnswer(TenantScoped, Base):
    """An answer, or a non-answer (don't know, defer, delegate, research)."""

    __tablename__ = "stakeholder_answers"
    __table_args__ = (
        CheckConstraint(_in("kind", ANSWER_KINDS), name="kind"),
        CheckConstraint(_in("knowledge_state", KNOWLEDGE_STATES), name="knowledge_state"),
    )

    question_id: Mapped[uuid.UUID] = _fk("stakeholder_questions", nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    body: Mapped[str | None] = mapped_column(Text)
    answered_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    # For "delegate": who should answer instead.
    delegated_to: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    evidence_ids: Mapped[list[uuid.UUID]] = _uuids()
    knowledge_state: Mapped[str] = mapped_column(
        Text, nullable=False, server_default="user_decision"
    )


class AssumptionDecision(TenantScoped, Base):
    """An explicit, authorized decision to proceed on an assumption or accept a risk."""

    __tablename__ = "assumption_decisions"
    __table_args__ = (CheckConstraint(_in("decision", ASSUMPTION_DECISIONS), name="decision"),)

    gap_id: Mapped[uuid.UUID | None] = _fk("knowledge_gaps", "SET NULL")
    document_id: Mapped[uuid.UUID | None] = _fk("documents")
    # The baseline assumption (or risk / constraint) entity it decides, if any.
    entity_id: Mapped[uuid.UUID | None] = _fk("entities", "SET NULL")
    statement: Mapped[str] = mapped_column(Text, nullable=False)
    decision: Mapped[str] = mapped_column(Text, nullable=False)
    rationale: Mapped[str] = mapped_column(Text, nullable=False)
    decided_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    decided_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    # When to look again (an accepted risk is not forever).
    review_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


# --- blockers (§6): options, experiments, events on the baseline constraint entity ------


class BlockerOption(TenantScoped, Base):
    """A candidate solution to a blocker (a baseline ``constraint`` entity)."""

    __tablename__ = "blocker_options"
    __table_args__ = (
        CheckConstraint(_in("approach", BLOCKER_APPROACHES), name="approach"),
        CheckConstraint(_in("technical_feasibility", FEASIBILITY), name="technical_feasibility"),
        CheckConstraint(_in("policy_feasibility", FEASIBILITY), name="policy_feasibility"),
        CheckConstraint(_in("compliance", COMPLIANCE), name="compliance"),
        CheckConstraint(_in("status", BLOCKER_OPTION_STATUSES), name="status"),
        CheckConstraint("status <> 'selected' OR compliance = 'compliant'", name="compliant"),
    )

    blocker_id: Mapped[uuid.UUID] = _fk("entities", nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    approach: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    technical_feasibility: Mapped[str] = mapped_column(
        Text, nullable=False, server_default="unknown"
    )
    policy_feasibility: Mapped[str] = mapped_column(Text, nullable=False, server_default="unknown")
    compliance: Mapped[str] = mapped_column(Text, nullable=False, server_default="needs_review")
    status: Mapped[str] = mapped_column(
        Text, nullable=False, default="proposed", server_default="proposed"
    )
    # BlockerOptionDetails: outcome, cost, effort, risk, residual limits, fallback,
    # monitoring signal, scaling trigger, corrective action, review date.
    details: Mapped[dict[str, Any]] = _json()
    evidence_ids: Mapped[list[uuid.UUID]] = _uuids()
    owner_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    selected_reason: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    lock_version: Mapped[int] = _lock_version()
    __mapper_args__ = {"version_id_col": lock_version}
    updated_at: Mapped[datetime] = _updated_at()


class FeasibilityExperiment(TenantScoped, Base):
    """A scoped validation of a blocker option, with an owner and a decision gate."""

    __tablename__ = "feasibility_experiments"
    __table_args__ = (CheckConstraint(_in("status", EXPERIMENT_STATUSES), name="status"),)

    blocker_id: Mapped[uuid.UUID] = _fk("entities", nullable=False)
    option_id: Mapped[uuid.UUID | None] = _fk("blocker_options", "SET NULL")
    hypothesis: Mapped[str] = mapped_column(Text, nullable=False)
    method: Mapped[str | None] = mapped_column(Text)
    success_threshold: Mapped[str | None] = mapped_column(Text)
    owner_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    decision_gate_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(
        Text, nullable=False, default="planned", server_default="planned"
    )
    result: Mapped[str | None] = mapped_column(Text)
    evidence_ids: Mapped[list[uuid.UUID]] = _uuids()
    lock_version: Mapped[int] = _lock_version()
    __mapper_args__ = {"version_id_col": lock_version}
    updated_at: Mapped[datetime] = _updated_at()


class BlockerResolutionEvent(TenantScoped, Base):
    """Append-only history of a blocker's resolution, a first-class decision (§6)."""

    __tablename__ = "blocker_resolution_events"
    __table_args__ = (
        CheckConstraint(_in("kind", BLOCKER_EVENT_KINDS), name="kind"),
        CheckConstraint(
            f"from_status IS NULL OR {_in('from_status', BLOCKER_STATUSES)}", name="from_status"
        ),
        CheckConstraint(
            f"to_status IS NULL OR {_in('to_status', BLOCKER_STATUSES)}", name="to_status"
        ),
    )

    blocker_id: Mapped[uuid.UUID] = _fk("entities", nullable=False)
    option_id: Mapped[uuid.UUID | None] = _fk("blocker_options", "SET NULL")
    experiment_id: Mapped[uuid.UUID | None] = _fk("feasibility_experiments", "SET NULL")
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    from_status: Mapped[str | None] = mapped_column(Text)
    to_status: Mapped[str | None] = mapped_column(Text)
    reason: Mapped[str | None] = mapped_column(Text)
    actor: Mapped[str] = mapped_column(Text, nullable=False)
    data: Mapped[dict[str, Any]] = _json()


# --- change events (the store behind oracle.changes) ------------------------------------


class ChangeEvent(TenantScoped, Base):
    """Something upstream changed; handlers (staleness, approval invalidation) react."""

    __tablename__ = "change_events"
    __table_args__ = (
        CheckConstraint(_in("subject_kind", CHANGE_SUBJECTS), name="subject_kind"),
        Index("ix_change_events_subject", "subject_kind", "subject_id"),
    )

    subject_kind: Mapped[str] = mapped_column(Text, nullable=False)
    subject_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    # Human-readable stable reference, e.g. "checkout-redesign@3#goal-trace".
    subject_ref: Mapped[str | None] = mapped_column(Text)
    document_id: Mapped[uuid.UUID | None] = _fk("documents", "SET NULL")
    # Why it changed, e.g. "section_edited", "patch_accepted", "source_revoked".
    cause: Mapped[str] = mapped_column(Text, nullable=False)
    actor: Mapped[str] = mapped_column(Text, nullable=False)
    # Before/after hashes or values, and anything the handlers need.
    data: Mapped[dict[str, Any]] = _json()
    # Names of the handlers that ran, in order.
    handled_by: Mapped[list[str]] = _texts()


# --- trace (§7): section links and artifact dependencies --------------------------------


class DocumentSectionLink(TenantScoped, Base):
    """A revision-aware link from a document section to the baseline or its evidence.

    The internal per-claim evidence behind O1c: rendered bodies carry no citations, the
    appendix and the evidence inspector read these.
    """

    __tablename__ = "document_section_links"
    __table_args__ = (
        CheckConstraint(_in("kind", SECTION_LINK_KINDS), name="kind"),
        CheckConstraint(_in("precision", LINK_PRECISION), name="precision"),
        CheckConstraint(
            "entity_id IS NOT NULL OR evidence_id IS NOT NULL OR source_item_id IS NOT NULL",
            name="target",
        ),
        Index("ix_document_section_links_document_section", "document_id", "section_key"),
    )

    document_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("documents.id", ondelete="CASCADE"), nullable=False
    )
    version_id: Mapped[uuid.UUID | None] = _fk("document_versions")
    section_key: Mapped[str] = mapped_column(Text, nullable=False)
    # Content hash of the section the link was made on (sections.content_hash).
    section_hash: Mapped[str | None] = mapped_column(Text)
    composition_revision: Mapped[int | None] = mapped_column(Integer)
    module_key: Mapped[str | None] = mapped_column(Text)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    entity_id: Mapped[uuid.UUID | None] = _fk("entities")
    evidence_id: Mapped[uuid.UUID | None] = _fk("evidence")
    # SET NULL: a link keeps its other targets when its source item goes. The delete paths
    # delete a link that would be left with no target first (oracle.v2.links).
    source_item_id: Mapped[uuid.UUID | None] = _fk("source_items", "SET NULL")
    precision: Mapped[str] = mapped_column(Text, nullable=False, server_default="section")
    # The claim, for precision "claim" (the exact words it supports).
    claim: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)


class ArtifactDependency(TenantScoped, Base):
    """A downstream output depends on an upstream item; freshness tracks drift (§11.5).

    Downstream is an artifact version or a document version (roadmaps are documents).
    Upstream is a document section (at a hash), an entity, or a whole document version.
    An upstream entity that is deleted leaves the row in place (0014_trace): the
    reference is nulled and ``upstream_snapshot`` keeps what it pointed at.
    """

    __tablename__ = "artifact_dependencies"
    __table_args__ = (
        CheckConstraint(_in("freshness", FRESHNESS), name="freshness"),
        CheckConstraint(
            "(artifact_version_id IS NULL) <> (document_version_id IS NULL)", name="downstream"
        ),
        CheckConstraint(
            "upstream_version_id IS NOT NULL OR upstream_entity_id IS NOT NULL"
            " OR upstream_snapshot IS NOT NULL",
            name="upstream",
        ),
        Index("ix_artifact_dependencies_freshness", "tenant_id", "freshness"),
    )

    artifact_version_id: Mapped[uuid.UUID | None] = _fk("artifact_versions")
    document_version_id: Mapped[uuid.UUID | None] = _fk("document_versions")
    upstream_version_id: Mapped[uuid.UUID | None] = _fk("document_versions")
    # With upstream_version_id: the section it depends on; null: the whole version.
    upstream_section_key: Mapped[str | None] = mapped_column(Text)
    upstream_section_hash: Mapped[str | None] = mapped_column(Text)
    upstream_entity_id: Mapped[uuid.UUID | None] = _fk("entities", "SET NULL")
    # The upstream entity as it was when it was deleted ({id, type, key, title, status}).
    upstream_snapshot: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    upstream_deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    composition_revision: Mapped[int | None] = mapped_column(Integer)
    freshness: Mapped[str] = mapped_column(
        Text, nullable=False, default="fresh", server_default="fresh"
    )
    # The change that made it potentially stale.
    caused_by_change_id: Mapped[uuid.UUID | None] = _fk("change_events", "SET NULL")
    stale_since: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reconciled_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    reconciled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    note: Mapped[str | None] = mapped_column(Text)
    updated_at: Mapped[datetime] = _updated_at()


# --- evaluation (§10) -------------------------------------------------------------------


class EvaluationReport(TenantScoped, Base):
    __tablename__ = "evaluation_reports"
    __table_args__ = (
        CheckConstraint(_in("evaluator", EVALUATORS), name="evaluator"),
        CheckConstraint(_in("status", REPORT_STATUSES), name="status"),
    )

    document_id: Mapped[uuid.UUID] = _fk("documents", nullable=False)
    version_id: Mapped[uuid.UUID | None] = _fk("document_versions")
    composition_revision: Mapped[int | None] = mapped_column(Integer)
    evaluator: Mapped[str] = mapped_column(Text, nullable=False)
    # The quality policy applied (T2 open: "advisory").
    policy: Mapped[str] = mapped_column(Text, nullable=False, server_default="advisory")
    status: Mapped[str] = mapped_column(
        Text, nullable=False, default="pending", server_default="pending"
    )
    # Counts per finding status and whether a hard check is critical.
    summary: Mapped[dict[str, Any]] = _json()
    created_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)


class EvaluationFinding(TenantScoped, Base):
    __tablename__ = "evaluation_findings"
    __table_args__ = (CheckConstraint(_in("status", FINDING_STATUSES), name="status"),)

    report_id: Mapped[uuid.UUID] = _fk("evaluation_reports", nullable=False)
    # Criterion or readiness check key, e.g. "problem_clarity", "critical_blockers".
    criterion: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    hard: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=false()
    )
    rationale: Mapped[str] = mapped_column(Text, nullable=False)
    evidence_ids: Mapped[list[uuid.UUID]] = _uuids()
    owner_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    section_keys: Mapped[list[str]] = _texts()
    module_key: Mapped[str | None] = mapped_column(Text)


# --- downstream artifacts (§11; used by wave 2) -----------------------------------------


class ArtifactRequest(TenantScoped, Base):
    """A request for a downstream artifact from an approved document version."""

    __tablename__ = "artifact_requests"
    __table_args__ = (
        CheckConstraint(_in("kind", ARTIFACT_KINDS), name="kind"),
        CheckConstraint(_in("status", ARTIFACT_REQUEST_STATUSES), name="status"),
    )

    kind: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    source_document_id: Mapped[uuid.UUID] = _fk("documents", nullable=False)
    source_version_id: Mapped[uuid.UUID | None] = _fk("document_versions", "SET NULL")
    # Requirement entities (entities.id) and sections the artifact covers.
    requirement_ids: Mapped[list[uuid.UUID]] = _uuids()
    section_keys: Mapped[list[str]] = _texts()
    params: Mapped[dict[str, Any]] = _json()
    status: Mapped[str] = mapped_column(
        Text, nullable=False, default="requested", server_default="requested"
    )
    run_id: Mapped[uuid.UUID | None] = _fk("runs", "SET NULL")
    requested_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    lock_version: Mapped[int] = _lock_version()
    __mapper_args__ = {"version_id_col": lock_version}
    updated_at: Mapped[datetime] = _updated_at()


class ArtifactVersion(TenantScoped, Base):
    __tablename__ = "artifact_versions"
    __table_args__ = (
        UniqueConstraint("request_id", "number"),
        CheckConstraint(_in("status", ARTIFACT_VERSION_STATUSES), name="status"),
        CheckConstraint(_in("freshness", FRESHNESS), name="freshness"),
    )

    request_id: Mapped[uuid.UUID] = _fk("artifact_requests", nullable=False)
    number: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(
        Text, nullable=False, default="draft", server_default="draft"
    )
    # Worst freshness of its dependencies (artifact_dependencies), kept for listing.
    freshness: Mapped[str] = mapped_column(Text, nullable=False, server_default="fresh")
    source_version_id: Mapped[uuid.UUID | None] = _fk("document_versions", "SET NULL")
    composition_revision: Mapped[int | None] = mapped_column(Integer)
    content_hash: Mapped[str | None] = mapped_column(Text)
    summary: Mapped[str | None] = mapped_column(Text)
    # Run provenance: run, runner profile, prompt version, cost (never a credential).
    provenance: Mapped[dict[str, Any]] = _json()
    created_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    approved_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ArtifactOutput(TenantScoped, Base):
    """A named file of an artifact version, validated (type, size, checksum) on import."""

    __tablename__ = "artifact_outputs"
    __table_args__ = (
        UniqueConstraint("version_id", "name"),
        CheckConstraint("size_bytes >= 0", name="size"),
    )

    version_id: Mapped[uuid.UUID] = _fk("artifact_versions", nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    media_type: Mapped[str] = mapped_column(Text, nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    sha256: Mapped[str] = mapped_column(Text, nullable=False)
    # Small text outputs inline; larger ones in blob storage (storage_ref).
    content: Mapped[str | None] = mapped_column(Text)
    storage_ref: Mapped[str | None] = mapped_column(Text)
    meta: Mapped[dict[str, Any]] = _json()


class ArtifactReviewEvent(TenantScoped, Base):
    __tablename__ = "artifact_review_events"
    __table_args__ = (CheckConstraint(_in("kind", ARTIFACT_REVIEW_KINDS), name="kind"),)

    version_id: Mapped[uuid.UUID] = _fk("artifact_versions", nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    body: Mapped[str | None] = mapped_column(Text)
    actor: Mapped[str] = mapped_column(Text, nullable=False)
    data: Mapped[dict[str, Any]] = _json()
