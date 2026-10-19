"""Product Oracle v2 foundation (wave 1)

Additive only. New company-scoped tables for semantic modules and compositions, product
intakes, the gap registry and question ledger, blocker options / experiments / resolution
events (on the existing baseline ``constraint`` entity), document section links and
artifact dependencies with freshness, change events, evaluation reports, and downstream
artifacts. The baseline graph gains entity types outcome, acceptance_criterion,
assumption and risk, and edge types derived_from, verifies, affects and mitigates.
Review correctness: ``section_reviews.section_hash``, ``document_versions.approved_by``
and ``document_versions.base_number``. Existing rows are untouched; new columns are
nullable. See docs/product-oracle-v2/01-solution-architecture.md.

Lanes that need more schema add ``0014_<lane>`` with down_revision "0013".

Revision ID: 0013
Revises: 0012
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0013"
down_revision: str | None = "0012"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

OLD_ENTITY_TYPES = ("goal", "product", "feature", "requirement", "constraint", "decision", "person")
NEW_ENTITY_TYPES = ("outcome", "acceptance_criterion", "assumption", "risk")
OLD_EDGE_TYPES = ("supports", "depends_on", "blocks", "part_of", "owned_by")
NEW_EDGE_TYPES = ("derived_from", "verifies", "affects", "mitigates")


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


def _set_graph_types(entity_types: tuple[str, ...], edge_types: tuple[str, ...]) -> None:
    op.drop_constraint(op.f("ck_entities_type"), "entities", type_="check")
    op.create_check_constraint(op.f("ck_entities_type"), "entities", _in("type", entity_types))
    op.drop_constraint(op.f("ck_edges_type"), "edges", type_="check")
    op.create_check_constraint(op.f("ck_edges_type"), "edges", _in("type", edge_types))


def upgrade() -> None:
    _set_graph_types(OLD_ENTITY_TYPES + NEW_ENTITY_TYPES, OLD_EDGE_TYPES + NEW_EDGE_TYPES)
    op.create_table(
        "module_definitions",
        sa.Column("key", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("builtin", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_by", sa.Uuid(), nullable=True),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_module_definitions_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_module_definitions")),
        sa.UniqueConstraint("tenant_id", "key", name=op.f("uq_module_definitions_tenant_id_key")),
    )
    op.create_index(
        op.f("ix_module_definitions_tenant_id"), "module_definitions", ["tenant_id"], unique=False
    )
    op.create_table(
        "change_events",
        sa.Column("subject_kind", sa.Text(), nullable=False),
        sa.Column("subject_id", sa.Uuid(), nullable=True),
        sa.Column("subject_ref", sa.Text(), nullable=True),
        sa.Column("document_id", sa.Uuid(), nullable=True),
        sa.Column("cause", sa.Text(), nullable=False),
        sa.Column("actor", sa.Text(), nullable=False),
        sa.Column(
            "data", postgresql.JSONB(astext_type=sa.Text()), server_default="{}", nullable=False
        ),
        sa.Column("handled_by", postgresql.ARRAY(sa.Text()), server_default="{}", nullable=False),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "subject_kind IN ('document_section', 'requirement', 'decision', 'source_permission', "
            "'blocker_status', 'composition_revision', 'document_version', 'entity', "
            "'artifact_version')",
            name=op.f("ck_change_events_subject_kind"),
        ),
        sa.ForeignKeyConstraint(
            ["document_id"],
            ["documents.id"],
            name=op.f("fk_change_events_document_id_documents"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_change_events_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_change_events")),
    )
    op.create_index(
        op.f("ix_change_events_document_id"), "change_events", ["document_id"], unique=False
    )
    op.create_index(
        "ix_change_events_subject", "change_events", ["subject_kind", "subject_id"], unique=False
    )
    op.create_index(
        op.f("ix_change_events_tenant_id"), "change_events", ["tenant_id"], unique=False
    )
    op.create_table(
        "document_compositions",
        sa.Column("document_id", sa.Uuid(), nullable=False),
        sa.Column("template", sa.Text(), nullable=True),
        sa.Column("template_version", sa.Text(), nullable=True),
        sa.Column("current_revision", sa.Integer(), nullable=True),
        sa.Column("lock_version", sa.Integer(), server_default="1", nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["document_id"],
            ["documents.id"],
            name=op.f("fk_document_compositions_document_id_documents"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_document_compositions_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_document_compositions")),
        sa.UniqueConstraint("document_id", name=op.f("uq_document_compositions_document_id")),
    )
    op.create_index(
        op.f("ix_document_compositions_tenant_id"),
        "document_compositions",
        ["tenant_id"],
        unique=False,
    )
    op.create_table(
        "module_versions",
        sa.Column("module_id", sa.Uuid(), nullable=False),
        sa.Column("version", sa.Text(), nullable=False),
        sa.Column(
            "contract", postgresql.JSONB(astext_type=sa.Text()), server_default="{}", nullable=False
        ),
        sa.Column("contract_hash", sa.Text(), nullable=False),
        sa.Column("origin", sa.Text(), server_default="builtin", nullable=False),
        sa.Column("created_by", sa.Uuid(), nullable=True),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "origin IN ('builtin', 'company')", name=op.f("ck_module_versions_origin")
        ),
        sa.CheckConstraint(
            "version ~ '^[0-9]+\\.[0-9]+\\.[0-9]+$'", name=op.f("ck_module_versions_semver")
        ),
        sa.ForeignKeyConstraint(
            ["module_id"],
            ["module_definitions.id"],
            name=op.f("fk_module_versions_module_id_module_definitions"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_module_versions_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_module_versions")),
        sa.UniqueConstraint(
            "module_id", "version", name=op.f("uq_module_versions_module_id_version")
        ),
    )
    op.create_index(
        op.f("ix_module_versions_module_id"), "module_versions", ["module_id"], unique=False
    )
    op.create_index(
        op.f("ix_module_versions_tenant_id"), "module_versions", ["tenant_id"], unique=False
    )
    op.create_table(
        "product_intakes",
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("brief", sa.Text(), nullable=False),
        sa.Column("author_id", sa.Uuid(), nullable=True),
        sa.Column(
            "source_snapshot_ids", postgresql.ARRAY(sa.Uuid()), server_default="{}", nullable=False
        ),
        sa.Column("status", sa.Text(), server_default="draft", nullable=False),
        sa.Column(
            "analysis", postgresql.JSONB(astext_type=sa.Text()), server_default="{}", nullable=False
        ),
        sa.Column("document_id", sa.Uuid(), nullable=True),
        sa.Column("lock_version", sa.Integer(), server_default="1", nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "status IN ('draft', 'analyzing', 'awaiting_answers', 'ready', 'converted', "
            "'archived')",
            name=op.f("ck_product_intakes_status"),
        ),
        sa.ForeignKeyConstraint(
            ["document_id"],
            ["documents.id"],
            name=op.f("fk_product_intakes_document_id_documents"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_product_intakes_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_product_intakes")),
    )
    op.create_index(
        op.f("ix_product_intakes_document_id"), "product_intakes", ["document_id"], unique=False
    )
    op.create_index(
        op.f("ix_product_intakes_tenant_id"), "product_intakes", ["tenant_id"], unique=False
    )
    op.create_table(
        "template_module_assignments",
        sa.Column("template_id", sa.Uuid(), nullable=False),
        sa.Column("module_key", sa.Text(), nullable=False),
        sa.Column("module_version", sa.Text(), nullable=True),
        sa.Column("policy", sa.Text(), nullable=False),
        sa.Column("display_order", sa.Integer(), server_default="0", nullable=False),
        sa.Column("section_ids", postgresql.ARRAY(sa.Text()), server_default="{}", nullable=False),
        sa.Column("since_template_version", sa.Integer(), nullable=True),
        sa.Column("manifest_format", sa.Integer(), server_default="1", nullable=False),
        sa.Column("created_by", sa.Uuid(), nullable=True),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "module_version IS NULL OR module_version ~ '^[0-9]+\\.[0-9]+\\.[0-9]+$'",
            name=op.f("ck_template_module_assignments_semver"),
        ),
        sa.CheckConstraint(
            "policy IN ('required', 'conditional', 'optional')",
            name=op.f("ck_template_module_assignments_policy"),
        ),
        sa.ForeignKeyConstraint(
            ["template_id"],
            ["templates.id"],
            name=op.f("fk_template_module_assignments_template_id_templates"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_template_module_assignments_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_template_module_assignments")),
        sa.UniqueConstraint(
            "template_id",
            "module_key",
            name=op.f("uq_template_module_assignments_template_id_module_key"),
        ),
    )
    op.create_index(
        op.f("ix_template_module_assignments_template_id"),
        "template_module_assignments",
        ["template_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_template_module_assignments_tenant_id"),
        "template_module_assignments",
        ["tenant_id"],
        unique=False,
    )
    op.create_table(
        "artifact_requests",
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("source_document_id", sa.Uuid(), nullable=False),
        sa.Column("source_version_id", sa.Uuid(), nullable=True),
        sa.Column(
            "requirement_ids", postgresql.ARRAY(sa.Uuid()), server_default="{}", nullable=False
        ),
        sa.Column("section_keys", postgresql.ARRAY(sa.Text()), server_default="{}", nullable=False),
        sa.Column(
            "params", postgresql.JSONB(astext_type=sa.Text()), server_default="{}", nullable=False
        ),
        sa.Column("status", sa.Text(), server_default="requested", nullable=False),
        sa.Column("run_id", sa.Uuid(), nullable=True),
        sa.Column("requested_by", sa.Uuid(), nullable=True),
        sa.Column("lock_version", sa.Integer(), server_default="1", nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "kind IN ('tech_brief', 'engineering_spec', 'user_flow', 'wireframe', 'prototype', "
            "'acceptance_tests', 'figma_design')",
            name=op.f("ck_artifact_requests_kind"),
        ),
        sa.CheckConstraint(
            "status IN ('requested', 'queued', 'running', 'succeeded', 'partial', 'failed', "
            "'blocked', 'cancelled')",
            name=op.f("ck_artifact_requests_status"),
        ),
        sa.ForeignKeyConstraint(
            ["run_id"],
            ["runs.id"],
            name=op.f("fk_artifact_requests_run_id_runs"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["source_document_id"],
            ["documents.id"],
            name=op.f("fk_artifact_requests_source_document_id_documents"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["source_version_id"],
            ["document_versions.id"],
            name=op.f("fk_artifact_requests_source_version_id_document_versions"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_artifact_requests_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_artifact_requests")),
    )
    op.create_index(
        op.f("ix_artifact_requests_run_id"), "artifact_requests", ["run_id"], unique=False
    )
    op.create_index(
        op.f("ix_artifact_requests_source_document_id"),
        "artifact_requests",
        ["source_document_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_artifact_requests_source_version_id"),
        "artifact_requests",
        ["source_version_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_artifact_requests_tenant_id"), "artifact_requests", ["tenant_id"], unique=False
    )
    op.create_table(
        "composition_revisions",
        sa.Column("composition_id", sa.Uuid(), nullable=False),
        sa.Column("number", sa.Integer(), nullable=False),
        sa.Column("status", sa.Text(), server_default="working", nullable=False),
        sa.Column(
            "modules", postgresql.JSONB(astext_type=sa.Text()), server_default="[]", nullable=False
        ),
        sa.Column(
            "inputs", postgresql.JSONB(astext_type=sa.Text()), server_default="{}", nullable=False
        ),
        sa.Column("decided_by", sa.Uuid(), nullable=True),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("parent_number", sa.Integer(), nullable=True),
        sa.Column("document_version_id", sa.Uuid(), nullable=True),
        sa.Column("lock_version", sa.Integer(), server_default="1", nullable=False),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "status IN ('working', 'confirmed', 'published', 'superseded')",
            name=op.f("ck_composition_revisions_status"),
        ),
        sa.ForeignKeyConstraint(
            ["composition_id"],
            ["document_compositions.id"],
            name=op.f("fk_composition_revisions_composition_id_document_compositions"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["document_version_id"],
            ["document_versions.id"],
            name=op.f("fk_composition_revisions_document_version_id_document_versions"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_composition_revisions_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_composition_revisions")),
        sa.UniqueConstraint(
            "composition_id", "number", name=op.f("uq_composition_revisions_composition_id_number")
        ),
    )
    op.create_index(
        op.f("ix_composition_revisions_composition_id"),
        "composition_revisions",
        ["composition_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_composition_revisions_document_version_id"),
        "composition_revisions",
        ["document_version_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_composition_revisions_tenant_id"),
        "composition_revisions",
        ["tenant_id"],
        unique=False,
    )
    op.create_table(
        "evaluation_reports",
        sa.Column("document_id", sa.Uuid(), nullable=False),
        sa.Column("version_id", sa.Uuid(), nullable=True),
        sa.Column("composition_revision", sa.Integer(), nullable=True),
        sa.Column("evaluator", sa.Text(), nullable=False),
        sa.Column("policy", sa.Text(), server_default="advisory", nullable=False),
        sa.Column("status", sa.Text(), server_default="pending", nullable=False),
        sa.Column(
            "summary", postgresql.JSONB(astext_type=sa.Text()), server_default="{}", nullable=False
        ),
        sa.Column("created_by", sa.Uuid(), nullable=True),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "evaluator IN ('rules', 'llm_job', 'agent', 'human')",
            name=op.f("ck_evaluation_reports_evaluator"),
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'complete', 'failed')", name=op.f("ck_evaluation_reports_status")
        ),
        sa.ForeignKeyConstraint(
            ["document_id"],
            ["documents.id"],
            name=op.f("fk_evaluation_reports_document_id_documents"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_evaluation_reports_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["version_id"],
            ["document_versions.id"],
            name=op.f("fk_evaluation_reports_version_id_document_versions"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_evaluation_reports")),
    )
    op.create_index(
        op.f("ix_evaluation_reports_document_id"),
        "evaluation_reports",
        ["document_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_evaluation_reports_tenant_id"), "evaluation_reports", ["tenant_id"], unique=False
    )
    op.create_index(
        op.f("ix_evaluation_reports_version_id"), "evaluation_reports", ["version_id"], unique=False
    )
    op.create_table(
        "knowledge_gaps",
        sa.Column("intake_id", sa.Uuid(), nullable=True),
        sa.Column("document_id", sa.Uuid(), nullable=True),
        sa.Column("category", sa.Text(), nullable=False),
        sa.Column("statement", sa.Text(), nullable=False),
        sa.Column("impact", postgresql.ARRAY(sa.Text()), server_default="{}", nullable=False),
        sa.Column("importance", sa.Text(), nullable=False),
        sa.Column("evidence_ids", postgresql.ARRAY(sa.Uuid()), server_default="{}", nullable=False),
        sa.Column("confidence", sa.Numeric(precision=4, scale=3), nullable=True),
        sa.Column("knowledge_state", sa.Text(), server_default="unknown", nullable=False),
        sa.Column("status", sa.Text(), server_default="unknown", nullable=False),
        sa.Column("owner_id", sa.Uuid(), nullable=True),
        sa.Column(
            "related_modules", postgresql.ARRAY(sa.Text()), server_default="{}", nullable=False
        ),
        sa.Column("stop_condition", sa.Text(), nullable=True),
        sa.Column("entity_ids", postgresql.ARRAY(sa.Uuid()), server_default="{}", nullable=False),
        sa.Column("section_keys", postgresql.ARRAY(sa.Text()), server_default="{}", nullable=False),
        sa.Column("created_by", sa.Uuid(), nullable=True),
        sa.Column("lock_version", sa.Integer(), server_default="1", nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "category IN ('customer_user', 'pain_evidence', 'goal_alignment', 'success_metric', "
            "'differentiation', 'alternatives', 'constraints', 'blockers', 'economic_benefit', "
            "'effort_cost', 'security_privacy', 'ownership', 'non_goals', 'release_rollout', "
            "'evaluation_criteria', 'third_party_policy', 'configurability_scaling')",
            name=op.f("ck_knowledge_gaps_category"),
        ),
        sa.CheckConstraint(
            "impact <@ ARRAY['goals', 'feasibility', 'scope', 'economics', 'risks', "
            "'module_selection']::text[]",
            name=op.f("ck_knowledge_gaps_impact"),
        ),
        sa.CheckConstraint(
            "importance IN ('critical', 'high', 'medium', 'low')",
            name=op.f("ck_knowledge_gaps_importance"),
        ),
        sa.CheckConstraint(
            "knowledge_state IN ('verified_fact', 'user_decision', 'ai_inference', 'hypothesis', "
            "'unknown')",
            name=op.f("ck_knowledge_gaps_knowledge_state"),
        ),
        sa.CheckConstraint(
            "status IN ('unknown', 'under_investigation', 'asked', 'answered', 'validated', "
            "'deferred', 'accepted_risk')",
            name=op.f("ck_knowledge_gaps_status"),
        ),
        sa.CheckConstraint(
            "confidence IS NULL OR (confidence >= 0 AND confidence <= 1)",
            name=op.f("ck_knowledge_gaps_confidence"),
        ),
        sa.CheckConstraint(
            "intake_id IS NOT NULL OR document_id IS NOT NULL",
            name=op.f("ck_knowledge_gaps_subject"),
        ),
        sa.ForeignKeyConstraint(
            ["document_id"],
            ["documents.id"],
            name=op.f("fk_knowledge_gaps_document_id_documents"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["intake_id"],
            ["product_intakes.id"],
            name=op.f("fk_knowledge_gaps_intake_id_product_intakes"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_knowledge_gaps_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_knowledge_gaps")),
    )
    op.create_index(
        op.f("ix_knowledge_gaps_document_id"), "knowledge_gaps", ["document_id"], unique=False
    )
    op.create_index(
        op.f("ix_knowledge_gaps_intake_id"), "knowledge_gaps", ["intake_id"], unique=False
    )
    op.create_index(
        op.f("ix_knowledge_gaps_tenant_id"), "knowledge_gaps", ["tenant_id"], unique=False
    )
    op.create_table(
        "artifact_versions",
        sa.Column("request_id", sa.Uuid(), nullable=False),
        sa.Column("number", sa.Integer(), nullable=False),
        sa.Column("status", sa.Text(), server_default="draft", nullable=False),
        sa.Column("freshness", sa.Text(), server_default="fresh", nullable=False),
        sa.Column("source_version_id", sa.Uuid(), nullable=True),
        sa.Column("composition_revision", sa.Integer(), nullable=True),
        sa.Column("content_hash", sa.Text(), nullable=True),
        sa.Column("summary", sa.Text(), nullable=True),
        sa.Column(
            "provenance",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="{}",
            nullable=False,
        ),
        sa.Column("created_by", sa.Uuid(), nullable=True),
        sa.Column("approved_by", sa.Uuid(), nullable=True),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "freshness IN ('fresh', 'potentially_stale', 'under_review', 'reconciled')",
            name=op.f("ck_artifact_versions_freshness"),
        ),
        sa.CheckConstraint(
            "status IN ('draft', 'in_review', 'approved', 'rejected', 'superseded')",
            name=op.f("ck_artifact_versions_status"),
        ),
        sa.ForeignKeyConstraint(
            ["request_id"],
            ["artifact_requests.id"],
            name=op.f("fk_artifact_versions_request_id_artifact_requests"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["source_version_id"],
            ["document_versions.id"],
            name=op.f("fk_artifact_versions_source_version_id_document_versions"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_artifact_versions_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_artifact_versions")),
        sa.UniqueConstraint(
            "request_id", "number", name=op.f("uq_artifact_versions_request_id_number")
        ),
    )
    op.create_index(
        op.f("ix_artifact_versions_request_id"), "artifact_versions", ["request_id"], unique=False
    )
    op.create_index(
        op.f("ix_artifact_versions_source_version_id"),
        "artifact_versions",
        ["source_version_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_artifact_versions_tenant_id"), "artifact_versions", ["tenant_id"], unique=False
    )
    op.create_table(
        "assumption_decisions",
        sa.Column("gap_id", sa.Uuid(), nullable=True),
        sa.Column("document_id", sa.Uuid(), nullable=True),
        sa.Column("entity_id", sa.Uuid(), nullable=True),
        sa.Column("statement", sa.Text(), nullable=False),
        sa.Column("decision", sa.Text(), nullable=False),
        sa.Column("rationale", sa.Text(), nullable=False),
        sa.Column("decided_by", sa.Uuid(), nullable=True),
        sa.Column(
            "decided_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("review_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "decision IN ('accept_assumption', 'accept_risk', 'validate', 'reject')",
            name=op.f("ck_assumption_decisions_decision"),
        ),
        sa.ForeignKeyConstraint(
            ["document_id"],
            ["documents.id"],
            name=op.f("fk_assumption_decisions_document_id_documents"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["entity_id"],
            ["entities.id"],
            name=op.f("fk_assumption_decisions_entity_id_entities"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["gap_id"],
            ["knowledge_gaps.id"],
            name=op.f("fk_assumption_decisions_gap_id_knowledge_gaps"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_assumption_decisions_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_assumption_decisions")),
    )
    op.create_index(
        op.f("ix_assumption_decisions_document_id"),
        "assumption_decisions",
        ["document_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_assumption_decisions_entity_id"),
        "assumption_decisions",
        ["entity_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_assumption_decisions_gap_id"), "assumption_decisions", ["gap_id"], unique=False
    )
    op.create_index(
        op.f("ix_assumption_decisions_tenant_id"),
        "assumption_decisions",
        ["tenant_id"],
        unique=False,
    )
    op.create_table(
        "blocker_options",
        sa.Column("blocker_id", sa.Uuid(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("approach", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("technical_feasibility", sa.Text(), server_default="unknown", nullable=False),
        sa.Column("policy_feasibility", sa.Text(), server_default="unknown", nullable=False),
        sa.Column("compliance", sa.Text(), server_default="needs_review", nullable=False),
        sa.Column("status", sa.Text(), server_default="proposed", nullable=False),
        sa.Column(
            "details", postgresql.JSONB(astext_type=sa.Text()), server_default="{}", nullable=False
        ),
        sa.Column("evidence_ids", postgresql.ARRAY(sa.Uuid()), server_default="{}", nullable=False),
        sa.Column("owner_id", sa.Uuid(), nullable=True),
        sa.Column("selected_reason", sa.Text(), nullable=True),
        sa.Column("created_by", sa.Uuid(), nullable=True),
        sa.Column("lock_version", sa.Integer(), server_default="1", nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "approach IN ('direct_remedy', 'alternative_workflow', 'architecture', 'partnership', "
            "'operations', 'distribution')",
            name=op.f("ck_blocker_options_approach"),
        ),
        sa.CheckConstraint(
            "compliance IN ('compliant', 'needs_review', 'non_compliant')",
            name=op.f("ck_blocker_options_compliance"),
        ),
        sa.CheckConstraint(
            "policy_feasibility IN ('high', 'medium', 'low', 'unknown')",
            name=op.f("ck_blocker_options_policy_feasibility"),
        ),
        sa.CheckConstraint(
            "status <> 'selected' OR compliance = 'compliant'",
            name=op.f("ck_blocker_options_compliant"),
        ),
        sa.CheckConstraint(
            "status IN ('proposed', 'evaluating', 'selected', 'fallback', 'rejected')",
            name=op.f("ck_blocker_options_status"),
        ),
        sa.CheckConstraint(
            "technical_feasibility IN ('high', 'medium', 'low', 'unknown')",
            name=op.f("ck_blocker_options_technical_feasibility"),
        ),
        sa.ForeignKeyConstraint(
            ["blocker_id"],
            ["entities.id"],
            name=op.f("fk_blocker_options_blocker_id_entities"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_blocker_options_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_blocker_options")),
    )
    op.create_index(
        op.f("ix_blocker_options_blocker_id"), "blocker_options", ["blocker_id"], unique=False
    )
    op.create_index(
        op.f("ix_blocker_options_tenant_id"), "blocker_options", ["tenant_id"], unique=False
    )
    op.create_table(
        "evaluation_findings",
        sa.Column("report_id", sa.Uuid(), nullable=False),
        sa.Column("criterion", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("hard", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("rationale", sa.Text(), nullable=False),
        sa.Column("evidence_ids", postgresql.ARRAY(sa.Uuid()), server_default="{}", nullable=False),
        sa.Column("owner_id", sa.Uuid(), nullable=True),
        sa.Column("section_keys", postgresql.ARRAY(sa.Text()), server_default="{}", nullable=False),
        sa.Column("module_key", sa.Text(), nullable=True),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "status IN ('pass', 'warning', 'critical', 'not_applicable')",
            name=op.f("ck_evaluation_findings_status"),
        ),
        sa.ForeignKeyConstraint(
            ["report_id"],
            ["evaluation_reports.id"],
            name=op.f("fk_evaluation_findings_report_id_evaluation_reports"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_evaluation_findings_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_evaluation_findings")),
    )
    op.create_index(
        op.f("ix_evaluation_findings_report_id"), "evaluation_findings", ["report_id"], unique=False
    )
    op.create_index(
        op.f("ix_evaluation_findings_tenant_id"), "evaluation_findings", ["tenant_id"], unique=False
    )
    op.create_table(
        "stakeholder_questions",
        sa.Column("gap_id", sa.Uuid(), nullable=True),
        sa.Column("intake_id", sa.Uuid(), nullable=True),
        sa.Column("document_id", sa.Uuid(), nullable=True),
        sa.Column("category", sa.Text(), nullable=False),
        sa.Column("prompt", sa.Text(), nullable=False),
        sa.Column("rationale", sa.Text(), nullable=True),
        sa.Column("priority", sa.Integer(), server_default="100", nullable=False),
        sa.Column("batch", sa.Integer(), nullable=True),
        sa.Column("asked_to", sa.Uuid(), nullable=True),
        sa.Column("asked_by", sa.Uuid(), nullable=True),
        sa.Column("module_key", sa.Text(), nullable=True),
        sa.Column("section_key", sa.Text(), nullable=True),
        sa.Column("status", sa.Text(), server_default="draft", nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "category IN ('customer_user', 'pain_evidence', 'goal_alignment', 'success_metric', "
            "'differentiation', 'alternatives', 'constraints', 'blockers', 'economic_benefit', "
            "'effort_cost', 'security_privacy', 'ownership', 'non_goals', 'release_rollout', "
            "'evaluation_criteria', 'third_party_policy', 'configurability_scaling')",
            name=op.f("ck_stakeholder_questions_category"),
        ),
        sa.CheckConstraint(
            "status IN ('draft', 'asked', 'answered', 'deferred', 'delegated', 'researching', "
            "'withdrawn')",
            name=op.f("ck_stakeholder_questions_status"),
        ),
        sa.ForeignKeyConstraint(
            ["document_id"],
            ["documents.id"],
            name=op.f("fk_stakeholder_questions_document_id_documents"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["gap_id"],
            ["knowledge_gaps.id"],
            name=op.f("fk_stakeholder_questions_gap_id_knowledge_gaps"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["intake_id"],
            ["product_intakes.id"],
            name=op.f("fk_stakeholder_questions_intake_id_product_intakes"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_stakeholder_questions_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_stakeholder_questions")),
    )
    op.create_index(
        op.f("ix_stakeholder_questions_document_id"),
        "stakeholder_questions",
        ["document_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_stakeholder_questions_gap_id"), "stakeholder_questions", ["gap_id"], unique=False
    )
    op.create_index(
        op.f("ix_stakeholder_questions_intake_id"),
        "stakeholder_questions",
        ["intake_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_stakeholder_questions_tenant_id"),
        "stakeholder_questions",
        ["tenant_id"],
        unique=False,
    )
    op.create_table(
        "artifact_dependencies",
        sa.Column("artifact_version_id", sa.Uuid(), nullable=True),
        sa.Column("document_version_id", sa.Uuid(), nullable=True),
        sa.Column("upstream_version_id", sa.Uuid(), nullable=True),
        sa.Column("upstream_section_key", sa.Text(), nullable=True),
        sa.Column("upstream_section_hash", sa.Text(), nullable=True),
        sa.Column("upstream_entity_id", sa.Uuid(), nullable=True),
        sa.Column("composition_revision", sa.Integer(), nullable=True),
        sa.Column("freshness", sa.Text(), server_default="fresh", nullable=False),
        sa.Column("caused_by_change_id", sa.Uuid(), nullable=True),
        sa.Column("stale_since", sa.DateTime(timezone=True), nullable=True),
        sa.Column("reconciled_by", sa.Uuid(), nullable=True),
        sa.Column("reconciled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "freshness IN ('fresh', 'potentially_stale', 'under_review', 'reconciled')",
            name=op.f("ck_artifact_dependencies_freshness"),
        ),
        sa.CheckConstraint(
            "(artifact_version_id IS NULL) <> (document_version_id IS NULL)",
            name=op.f("ck_artifact_dependencies_downstream"),
        ),
        sa.CheckConstraint(
            "upstream_version_id IS NOT NULL OR upstream_entity_id IS NOT NULL",
            name=op.f("ck_artifact_dependencies_upstream"),
        ),
        sa.ForeignKeyConstraint(
            ["artifact_version_id"],
            ["artifact_versions.id"],
            name=op.f("fk_artifact_dependencies_artifact_version_id_artifact_versions"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["caused_by_change_id"],
            ["change_events.id"],
            name=op.f("fk_artifact_dependencies_caused_by_change_id_change_events"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["document_version_id"],
            ["document_versions.id"],
            name=op.f("fk_artifact_dependencies_document_version_id_document_versions"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_artifact_dependencies_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["upstream_entity_id"],
            ["entities.id"],
            name=op.f("fk_artifact_dependencies_upstream_entity_id_entities"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["upstream_version_id"],
            ["document_versions.id"],
            name=op.f("fk_artifact_dependencies_upstream_version_id_document_versions"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_artifact_dependencies")),
    )
    op.create_index(
        op.f("ix_artifact_dependencies_artifact_version_id"),
        "artifact_dependencies",
        ["artifact_version_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_artifact_dependencies_caused_by_change_id"),
        "artifact_dependencies",
        ["caused_by_change_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_artifact_dependencies_document_version_id"),
        "artifact_dependencies",
        ["document_version_id"],
        unique=False,
    )
    op.create_index(
        "ix_artifact_dependencies_freshness",
        "artifact_dependencies",
        ["tenant_id", "freshness"],
        unique=False,
    )
    op.create_index(
        op.f("ix_artifact_dependencies_tenant_id"),
        "artifact_dependencies",
        ["tenant_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_artifact_dependencies_upstream_entity_id"),
        "artifact_dependencies",
        ["upstream_entity_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_artifact_dependencies_upstream_version_id"),
        "artifact_dependencies",
        ["upstream_version_id"],
        unique=False,
    )
    op.create_table(
        "artifact_outputs",
        sa.Column("version_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("media_type", sa.Text(), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("sha256", sa.Text(), nullable=False),
        sa.Column("content", sa.Text(), nullable=True),
        sa.Column("storage_ref", sa.Text(), nullable=True),
        sa.Column(
            "meta", postgresql.JSONB(astext_type=sa.Text()), server_default="{}", nullable=False
        ),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("size_bytes >= 0", name=op.f("ck_artifact_outputs_size")),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_artifact_outputs_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["version_id"],
            ["artifact_versions.id"],
            name=op.f("fk_artifact_outputs_version_id_artifact_versions"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_artifact_outputs")),
        sa.UniqueConstraint("version_id", "name", name=op.f("uq_artifact_outputs_version_id_name")),
    )
    op.create_index(
        op.f("ix_artifact_outputs_tenant_id"), "artifact_outputs", ["tenant_id"], unique=False
    )
    op.create_index(
        op.f("ix_artifact_outputs_version_id"), "artifact_outputs", ["version_id"], unique=False
    )
    op.create_table(
        "artifact_review_events",
        sa.Column("version_id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("body", sa.Text(), nullable=True),
        sa.Column("actor", sa.Text(), nullable=False),
        sa.Column(
            "data", postgresql.JSONB(astext_type=sa.Text()), server_default="{}", nullable=False
        ),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "kind IN ('comment', 'approved', 'changes_requested', 'rejected', 'marked_stale', "
            "'reconciled')",
            name=op.f("ck_artifact_review_events_kind"),
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_artifact_review_events_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["version_id"],
            ["artifact_versions.id"],
            name=op.f("fk_artifact_review_events_version_id_artifact_versions"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_artifact_review_events")),
    )
    op.create_index(
        op.f("ix_artifact_review_events_tenant_id"),
        "artifact_review_events",
        ["tenant_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_artifact_review_events_version_id"),
        "artifact_review_events",
        ["version_id"],
        unique=False,
    )
    op.create_table(
        "feasibility_experiments",
        sa.Column("blocker_id", sa.Uuid(), nullable=False),
        sa.Column("option_id", sa.Uuid(), nullable=True),
        sa.Column("hypothesis", sa.Text(), nullable=False),
        sa.Column("method", sa.Text(), nullable=True),
        sa.Column("success_threshold", sa.Text(), nullable=True),
        sa.Column("owner_id", sa.Uuid(), nullable=True),
        sa.Column("decision_gate_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("status", sa.Text(), server_default="planned", nullable=False),
        sa.Column("result", sa.Text(), nullable=True),
        sa.Column("evidence_ids", postgresql.ARRAY(sa.Uuid()), server_default="{}", nullable=False),
        sa.Column("lock_version", sa.Integer(), server_default="1", nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "status IN ('planned', 'running', 'succeeded', 'failed', 'inconclusive', 'cancelled')",
            name=op.f("ck_feasibility_experiments_status"),
        ),
        sa.ForeignKeyConstraint(
            ["blocker_id"],
            ["entities.id"],
            name=op.f("fk_feasibility_experiments_blocker_id_entities"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["option_id"],
            ["blocker_options.id"],
            name=op.f("fk_feasibility_experiments_option_id_blocker_options"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_feasibility_experiments_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_feasibility_experiments")),
    )
    op.create_index(
        op.f("ix_feasibility_experiments_blocker_id"),
        "feasibility_experiments",
        ["blocker_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_feasibility_experiments_option_id"),
        "feasibility_experiments",
        ["option_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_feasibility_experiments_tenant_id"),
        "feasibility_experiments",
        ["tenant_id"],
        unique=False,
    )
    op.create_table(
        "stakeholder_answers",
        sa.Column("question_id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("body", sa.Text(), nullable=True),
        sa.Column("answered_by", sa.Uuid(), nullable=True),
        sa.Column("delegated_to", sa.Uuid(), nullable=True),
        sa.Column("evidence_ids", postgresql.ARRAY(sa.Uuid()), server_default="{}", nullable=False),
        sa.Column("knowledge_state", sa.Text(), server_default="user_decision", nullable=False),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "kind IN ('answer', 'dont_know', 'defer', 'delegate', 'research')",
            name=op.f("ck_stakeholder_answers_kind"),
        ),
        sa.CheckConstraint(
            "knowledge_state IN ('verified_fact', 'user_decision', 'ai_inference', 'hypothesis', "
            "'unknown')",
            name=op.f("ck_stakeholder_answers_knowledge_state"),
        ),
        sa.ForeignKeyConstraint(
            ["question_id"],
            ["stakeholder_questions.id"],
            name=op.f("fk_stakeholder_answers_question_id_stakeholder_questions"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_stakeholder_answers_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_stakeholder_answers")),
    )
    op.create_index(
        op.f("ix_stakeholder_answers_question_id"),
        "stakeholder_answers",
        ["question_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_stakeholder_answers_tenant_id"), "stakeholder_answers", ["tenant_id"], unique=False
    )
    op.create_table(
        "blocker_resolution_events",
        sa.Column("blocker_id", sa.Uuid(), nullable=False),
        sa.Column("option_id", sa.Uuid(), nullable=True),
        sa.Column("experiment_id", sa.Uuid(), nullable=True),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("from_status", sa.Text(), nullable=True),
        sa.Column("to_status", sa.Text(), nullable=True),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("actor", sa.Text(), nullable=False),
        sa.Column(
            "data", postgresql.JSONB(astext_type=sa.Text()), server_default="{}", nullable=False
        ),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "from_status IS NULL OR from_status IN ('open', 'mitigating', 'resolved', "
            "'accepted_risk', 'feasibility_only')",
            name=op.f("ck_blocker_resolution_events_from_status"),
        ),
        sa.CheckConstraint(
            "kind IN ('status_changed', 'option_selected', 'experiment_started', "
            "'experiment_concluded', 'risk_accepted', 'feasibility_scope_approved', 'reopened')",
            name=op.f("ck_blocker_resolution_events_kind"),
        ),
        sa.CheckConstraint(
            "to_status IS NULL OR to_status IN ('open', 'mitigating', 'resolved', "
            "'accepted_risk', 'feasibility_only')",
            name=op.f("ck_blocker_resolution_events_to_status"),
        ),
        sa.ForeignKeyConstraint(
            ["blocker_id"],
            ["entities.id"],
            name=op.f("fk_blocker_resolution_events_blocker_id_entities"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["experiment_id"],
            ["feasibility_experiments.id"],
            name=op.f("fk_blocker_resolution_events_experiment_id_feasibility_experiments"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["option_id"],
            ["blocker_options.id"],
            name=op.f("fk_blocker_resolution_events_option_id_blocker_options"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_blocker_resolution_events_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_blocker_resolution_events")),
    )
    op.create_index(
        op.f("ix_blocker_resolution_events_blocker_id"),
        "blocker_resolution_events",
        ["blocker_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_blocker_resolution_events_experiment_id"),
        "blocker_resolution_events",
        ["experiment_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_blocker_resolution_events_option_id"),
        "blocker_resolution_events",
        ["option_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_blocker_resolution_events_tenant_id"),
        "blocker_resolution_events",
        ["tenant_id"],
        unique=False,
    )
    op.create_table(
        "document_section_links",
        sa.Column("document_id", sa.Uuid(), nullable=False),
        sa.Column("version_id", sa.Uuid(), nullable=True),
        sa.Column("section_key", sa.Text(), nullable=False),
        sa.Column("section_hash", sa.Text(), nullable=True),
        sa.Column("composition_revision", sa.Integer(), nullable=True),
        sa.Column("module_key", sa.Text(), nullable=True),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("entity_id", sa.Uuid(), nullable=True),
        sa.Column("evidence_id", sa.Uuid(), nullable=True),
        sa.Column("source_item_id", sa.Uuid(), nullable=True),
        sa.Column("precision", sa.Text(), server_default="section", nullable=False),
        sa.Column("claim", sa.Text(), nullable=True),
        sa.Column("created_by", sa.Uuid(), nullable=True),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "kind IN ('implements', 'evidences', 'claims', 'tests', 'mentions')",
            name=op.f("ck_document_section_links_kind"),
        ),
        sa.CheckConstraint(
            "precision IN ('section', 'paragraph', 'claim')",
            name=op.f("ck_document_section_links_precision"),
        ),
        sa.CheckConstraint(
            "entity_id IS NOT NULL OR evidence_id IS NOT NULL OR source_item_id IS NOT NULL",
            name=op.f("ck_document_section_links_target"),
        ),
        sa.ForeignKeyConstraint(
            ["document_id"],
            ["documents.id"],
            name=op.f("fk_document_section_links_document_id_documents"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["entity_id"],
            ["entities.id"],
            name=op.f("fk_document_section_links_entity_id_entities"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["evidence_id"],
            ["evidence.id"],
            name=op.f("fk_document_section_links_evidence_id_evidence"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["source_item_id"],
            ["source_items.id"],
            name=op.f("fk_document_section_links_source_item_id_source_items"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_document_section_links_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["version_id"],
            ["document_versions.id"],
            name=op.f("fk_document_section_links_version_id_document_versions"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_document_section_links")),
    )
    op.create_index(
        "ix_document_section_links_document_section",
        "document_section_links",
        ["document_id", "section_key"],
        unique=False,
    )
    op.create_index(
        op.f("ix_document_section_links_entity_id"),
        "document_section_links",
        ["entity_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_document_section_links_evidence_id"),
        "document_section_links",
        ["evidence_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_document_section_links_source_item_id"),
        "document_section_links",
        ["source_item_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_document_section_links_tenant_id"),
        "document_section_links",
        ["tenant_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_document_section_links_version_id"),
        "document_section_links",
        ["version_id"],
        unique=False,
    )
    op.add_column("document_versions", sa.Column("approved_by", sa.Uuid(), nullable=True))
    op.add_column("document_versions", sa.Column("base_number", sa.Integer(), nullable=True))
    op.add_column("section_reviews", sa.Column("section_hash", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("section_reviews", "section_hash")
    op.drop_column("document_versions", "base_number")
    op.drop_column("document_versions", "approved_by")
    op.drop_index(op.f("ix_document_section_links_version_id"), table_name="document_section_links")
    op.drop_index(op.f("ix_document_section_links_tenant_id"), table_name="document_section_links")
    op.drop_index(
        op.f("ix_document_section_links_source_item_id"), table_name="document_section_links"
    )
    op.drop_index(
        op.f("ix_document_section_links_evidence_id"), table_name="document_section_links"
    )
    op.drop_index(op.f("ix_document_section_links_entity_id"), table_name="document_section_links")
    op.drop_index("ix_document_section_links_document_section", table_name="document_section_links")
    op.drop_table("document_section_links")
    op.drop_index(
        op.f("ix_blocker_resolution_events_tenant_id"), table_name="blocker_resolution_events"
    )
    op.drop_index(
        op.f("ix_blocker_resolution_events_option_id"), table_name="blocker_resolution_events"
    )
    op.drop_index(
        op.f("ix_blocker_resolution_events_experiment_id"), table_name="blocker_resolution_events"
    )
    op.drop_index(
        op.f("ix_blocker_resolution_events_blocker_id"), table_name="blocker_resolution_events"
    )
    op.drop_table("blocker_resolution_events")
    op.drop_index(op.f("ix_stakeholder_answers_tenant_id"), table_name="stakeholder_answers")
    op.drop_index(op.f("ix_stakeholder_answers_question_id"), table_name="stakeholder_answers")
    op.drop_table("stakeholder_answers")
    op.drop_index(
        op.f("ix_feasibility_experiments_tenant_id"), table_name="feasibility_experiments"
    )
    op.drop_index(
        op.f("ix_feasibility_experiments_option_id"), table_name="feasibility_experiments"
    )
    op.drop_index(
        op.f("ix_feasibility_experiments_blocker_id"), table_name="feasibility_experiments"
    )
    op.drop_table("feasibility_experiments")
    op.drop_index(op.f("ix_artifact_review_events_version_id"), table_name="artifact_review_events")
    op.drop_index(op.f("ix_artifact_review_events_tenant_id"), table_name="artifact_review_events")
    op.drop_table("artifact_review_events")
    op.drop_index(op.f("ix_artifact_outputs_version_id"), table_name="artifact_outputs")
    op.drop_index(op.f("ix_artifact_outputs_tenant_id"), table_name="artifact_outputs")
    op.drop_table("artifact_outputs")
    op.drop_index(
        op.f("ix_artifact_dependencies_upstream_version_id"), table_name="artifact_dependencies"
    )
    op.drop_index(
        op.f("ix_artifact_dependencies_upstream_entity_id"), table_name="artifact_dependencies"
    )
    op.drop_index(op.f("ix_artifact_dependencies_tenant_id"), table_name="artifact_dependencies")
    op.drop_index("ix_artifact_dependencies_freshness", table_name="artifact_dependencies")
    op.drop_index(
        op.f("ix_artifact_dependencies_document_version_id"), table_name="artifact_dependencies"
    )
    op.drop_index(
        op.f("ix_artifact_dependencies_caused_by_change_id"), table_name="artifact_dependencies"
    )
    op.drop_index(
        op.f("ix_artifact_dependencies_artifact_version_id"), table_name="artifact_dependencies"
    )
    op.drop_table("artifact_dependencies")
    op.drop_index(op.f("ix_stakeholder_questions_tenant_id"), table_name="stakeholder_questions")
    op.drop_index(op.f("ix_stakeholder_questions_intake_id"), table_name="stakeholder_questions")
    op.drop_index(op.f("ix_stakeholder_questions_gap_id"), table_name="stakeholder_questions")
    op.drop_index(op.f("ix_stakeholder_questions_document_id"), table_name="stakeholder_questions")
    op.drop_table("stakeholder_questions")
    op.drop_index(op.f("ix_evaluation_findings_tenant_id"), table_name="evaluation_findings")
    op.drop_index(op.f("ix_evaluation_findings_report_id"), table_name="evaluation_findings")
    op.drop_table("evaluation_findings")
    op.drop_index(op.f("ix_blocker_options_tenant_id"), table_name="blocker_options")
    op.drop_index(op.f("ix_blocker_options_blocker_id"), table_name="blocker_options")
    op.drop_table("blocker_options")
    op.drop_index(op.f("ix_assumption_decisions_tenant_id"), table_name="assumption_decisions")
    op.drop_index(op.f("ix_assumption_decisions_gap_id"), table_name="assumption_decisions")
    op.drop_index(op.f("ix_assumption_decisions_entity_id"), table_name="assumption_decisions")
    op.drop_index(op.f("ix_assumption_decisions_document_id"), table_name="assumption_decisions")
    op.drop_table("assumption_decisions")
    op.drop_index(op.f("ix_artifact_versions_tenant_id"), table_name="artifact_versions")
    op.drop_index(op.f("ix_artifact_versions_source_version_id"), table_name="artifact_versions")
    op.drop_index(op.f("ix_artifact_versions_request_id"), table_name="artifact_versions")
    op.drop_table("artifact_versions")
    op.drop_index(op.f("ix_knowledge_gaps_tenant_id"), table_name="knowledge_gaps")
    op.drop_index(op.f("ix_knowledge_gaps_intake_id"), table_name="knowledge_gaps")
    op.drop_index(op.f("ix_knowledge_gaps_document_id"), table_name="knowledge_gaps")
    op.drop_table("knowledge_gaps")
    op.drop_index(op.f("ix_evaluation_reports_version_id"), table_name="evaluation_reports")
    op.drop_index(op.f("ix_evaluation_reports_tenant_id"), table_name="evaluation_reports")
    op.drop_index(op.f("ix_evaluation_reports_document_id"), table_name="evaluation_reports")
    op.drop_table("evaluation_reports")
    op.drop_index(op.f("ix_composition_revisions_tenant_id"), table_name="composition_revisions")
    op.drop_index(
        op.f("ix_composition_revisions_document_version_id"), table_name="composition_revisions"
    )
    op.drop_index(
        op.f("ix_composition_revisions_composition_id"), table_name="composition_revisions"
    )
    op.drop_table("composition_revisions")
    op.drop_index(op.f("ix_artifact_requests_tenant_id"), table_name="artifact_requests")
    op.drop_index(op.f("ix_artifact_requests_source_version_id"), table_name="artifact_requests")
    op.drop_index(op.f("ix_artifact_requests_source_document_id"), table_name="artifact_requests")
    op.drop_index(op.f("ix_artifact_requests_run_id"), table_name="artifact_requests")
    op.drop_table("artifact_requests")
    op.drop_index(
        op.f("ix_template_module_assignments_tenant_id"), table_name="template_module_assignments"
    )
    op.drop_index(
        op.f("ix_template_module_assignments_template_id"), table_name="template_module_assignments"
    )
    op.drop_table("template_module_assignments")
    op.drop_index(op.f("ix_product_intakes_tenant_id"), table_name="product_intakes")
    op.drop_index(op.f("ix_product_intakes_document_id"), table_name="product_intakes")
    op.drop_table("product_intakes")
    op.drop_index(op.f("ix_module_versions_tenant_id"), table_name="module_versions")
    op.drop_index(op.f("ix_module_versions_module_id"), table_name="module_versions")
    op.drop_table("module_versions")
    op.drop_index(op.f("ix_document_compositions_tenant_id"), table_name="document_compositions")
    op.drop_table("document_compositions")
    op.drop_index(op.f("ix_change_events_tenant_id"), table_name="change_events")
    op.drop_index("ix_change_events_subject", table_name="change_events")
    op.drop_index(op.f("ix_change_events_document_id"), table_name="change_events")
    op.drop_table("change_events")
    op.drop_index(op.f("ix_module_definitions_tenant_id"), table_name="module_definitions")
    op.drop_table("module_definitions")
    # Graph items of the new types go (their edges, evidence and history cascade).
    op.execute(f"DELETE FROM edges WHERE {_in('type', NEW_EDGE_TYPES)}")
    op.execute(f"DELETE FROM entities WHERE {_in('type', NEW_ENTITY_TYPES)}")
    _set_graph_types(OLD_ENTITY_TYPES, OLD_EDGE_TYPES)
