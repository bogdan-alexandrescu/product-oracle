"""The decision log: one record per product decision, with one approver (H1)

New tables ``decisions`` and ``decision_reviews`` (oracle.decisions.models). ``class`` is a
generated column: ``checkpoint`` for a run's stop approved or sent back, ``judgement`` for
everything else. ``llm_jobs`` gains ``decision_id`` and the ``decision_options`` kind (Ask
Oracle for options), with a decision as a job's third possible subject.

Backfill: one ``decided`` record per existing ``assumption_decisions`` row that accepted a
risk or an assumption (origin ``assumption``), numbered per company in decision order, its
review date kept (or the decision date plus 90 days), so due reviews start surfacing,
each with its locked baseline ``decision`` entity ``d-<number>`` and the gap, document and
entity it is about as subjects, as live capture records them.
Version approvals and checkpoint decisions made before this revision are not backfilled.

Downgrade: deletes the baseline entities synced from decisions (``attrs ? 'decision_id'``),
the decision jobs and the ``decision_irreversible_role`` setting, then drops both tables.
The source tables (``assumption_decisions``, ``blocker_resolution_events``,
``llm_suggestions``) are never changed.

Revision ID: 0020_decisions
Revises: 0020_requests
"""

import re
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0020_decisions"
down_revision: str | None = "0020_requests"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

KIND_CHECK = ("llm_jobs", "ck_llm_jobs_kind", "kind")
KINDS = ("decision_options",)
SUBJECT_BEFORE = "document_id IS NOT NULL OR intake_id IS NOT NULL"
SUBJECT_AFTER = "document_id IS NOT NULL OR intake_id IS NOT NULL OR decision_id IS NOT NULL"


# --- oracle.migration_checks, frozen here as of this revision ----------------------------

_VALUE = re.compile(r"'((?:[^']|'')*)'")


def check_values(table: str, constraint: str) -> list[str]:
    """The values a ``column IN (...)`` check constraint allows now, in its order."""
    definition = op.get_bind().scalar(
        sa.text(
            "SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c "
            "JOIN pg_class t ON t.oid = c.conrelid "
            "WHERE c.conname = :name AND t.relname = :table AND c.contype = 'c'"
        ),
        {"name": constraint, "table": table},
    )
    if definition is None:
        raise RuntimeError(f"check constraint {constraint} on {table} not found")
    return [v.replace("''", "'") for v in _VALUE.findall(definition)]


def _replace(table: str, constraint: str, column: str, values: list[str]) -> None:
    listed = ", ".join("'" + v.replace("'", "''") + "'" for v in values)
    op.drop_constraint(op.f(constraint), table, type_="check")
    op.create_check_constraint(op.f(constraint), table, f"{column} IN ({listed})")


def add_check_values(table: str, constraint: str, column: str, values: tuple[str, ...]) -> None:
    now = check_values(table, constraint)
    missing = [v for v in values if v not in now]
    if missing:
        _replace(table, constraint, column, now + missing)


def remove_check_values(table: str, constraint: str, column: str, values: tuple[str, ...]) -> None:
    now = check_values(table, constraint)
    kept = [v for v in now if v not in values]
    if kept != now:
        _replace(table, constraint, column, kept)


# One decided record per accepted risk or assumption, numbered per company by decision
# time; the approver is who decided (rows without one are left out: no one to review).
BACKFILL = """
INSERT INTO decisions (
    id, tenant_id, created_at, updated_at, number, title, context, options, chosen_option,
    rationale, status, approver_id, driver, subjects, entity_ids, review_at, origin,
    source_kind, source_id, decided_by, decided_actor, decided_at, created_by
)
SELECT
    gen_random_uuid(), a.tenant_id, a.decided_at, now(),
    row_number() OVER (PARTITION BY a.tenant_id ORDER BY a.decided_at, a.id),
    left(a.statement, 200),
    CASE WHEN length(a.statement) > 200 THEN a.statement END,
    jsonb_build_array(
        jsonb_build_object(
            'key', a.decision,
            'label', CASE a.decision WHEN 'accept_risk' THEN 'Accept the risk'
                ELSE 'Proceed on the assumption' END,
            'summary', NULL, 'pros', '[]'::jsonb, 'cons', '[]'::jsonb,
            'evidence_ids', '[]'::jsonb, 'cost_if_wrong', NULL, 'recommended', false
        ),
        jsonb_build_object(
            'key', 'validate', 'label', 'Validate it first',
            'summary', NULL, 'pros', '[]'::jsonb, 'cons', '[]'::jsonb,
            'evidence_ids', '[]'::jsonb, 'cost_if_wrong', NULL, 'recommended', false
        )
    ),
    a.decision,
    a.rationale,
    'decided',
    a.decided_by,
    'oracle',
    (CASE WHEN a.gap_id IS NULL THEN '[]'::jsonb
        ELSE jsonb_build_array(jsonb_build_object(
            'kind', 'gap', 'id', a.gap_id::text, 'ref', 'gap:' || a.gap_id::text)) END)
    || (CASE WHEN a.document_id IS NULL THEN '[]'::jsonb
        ELSE jsonb_build_array(jsonb_build_object('kind', 'document', 'id', a.document_id::text))
        END)
    || (CASE WHEN a.entity_id IS NULL THEN '[]'::jsonb
        ELSE jsonb_build_array(jsonb_build_object('kind', 'entity', 'id', a.entity_id::text))
        END),
    '{}'::uuid[],
    COALESCE((a.review_at AT TIME ZONE 'UTC')::date,
             (a.decided_at AT TIME ZONE 'UTC')::date + 90),
    'assumption',
    'assumption_decision',
    a.id,
    a.decided_by,
    'user',
    a.decided_at,
    a.decided_by
FROM assumption_decisions a
WHERE a.decision IN ('accept_risk', 'accept_assumption') AND a.decided_by IS NOT NULL
"""

# Each backfilled record is in the Baseline graph as live capture leaves it
# (oracle.decisions.service.sync_entity): one locked, confirmed ``decision`` entity keyed
# ``d-<number>`` (an existing one with that key is taken over, as live sync does), its
# creation revision, and the record's ``entity_id``. Reversing or superseding it then
# rejects that entity and marks what depends on it stale.
BACKFILL_ENTITIES = """
INSERT INTO entities (
    id, tenant_id, created_at, updated_at, type, key, title, body, attrs, status, origin,
    locked, locked_by, locked_at
)
SELECT
    gen_random_uuid(), d.tenant_id, now(), now(), 'decision', 'd-' || d.number, d.title,
    d.rationale,
    jsonb_build_object(
        'decision_id', d.id::text, 'chosen_option', d.chosen_option,
        'reversibility', d.reversibility
    ),
    'confirmed', 'user', true, d.decided_by, now()
FROM decisions d
WHERE d.source_kind = 'assumption_decision'
ON CONFLICT (tenant_id, type, key) DO UPDATE SET
    title = EXCLUDED.title, body = EXCLUDED.body,
    attrs = entities.attrs || EXCLUDED.attrs, status = 'confirmed', updated_at = now()
"""
BACKFILL_LINK = """
UPDATE decisions d SET entity_id = e.id
FROM entities e
WHERE d.source_kind = 'assumption_decision' AND e.tenant_id = d.tenant_id
    AND e.type = 'decision' AND e.key = 'd-' || d.number
"""
BACKFILL_REVISIONS = """
INSERT INTO entity_revisions (id, tenant_id, created_at, entity_id, before, after, actor, reason)
SELECT
    gen_random_uuid(), e.tenant_id, now(), e.id, NULL,
    jsonb_build_object(
        'type', e.type, 'key', e.key, 'title', e.title, 'body', e.body, 'attrs', e.attrs,
        'status', e.status
    ),
    'user:' || d.decided_by::text,
    'Synced from the decision log: D-' || d.number || ' decided'
FROM decisions d JOIN entities e ON e.id = d.entity_id
WHERE d.source_kind = 'assumption_decision'
"""
BACKFILLS = (BACKFILL, BACKFILL_ENTITIES, BACKFILL_LINK, BACKFILL_REVISIONS)


def upgrade() -> None:
    op.create_table(
        "decisions",
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("number", sa.Integer(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("question", sa.Text(), nullable=True),
        sa.Column("context", sa.Text(), nullable=True),
        sa.Column(
            "options", postgresql.JSONB(astext_type=sa.Text()), server_default="[]", nullable=False
        ),
        sa.Column("chosen_option", sa.Text(), nullable=True),
        sa.Column("rationale", sa.Text(), nullable=True),
        sa.Column("reversibility", sa.Text(), server_default="reversible", nullable=False),
        sa.Column("status", sa.Text(), server_default="proposed", nullable=False),
        sa.Column("approver_id", sa.Uuid(), nullable=False),
        sa.Column("driver", sa.Text(), nullable=False),
        sa.Column(
            "contributor_ids", postgresql.ARRAY(sa.Uuid()), server_default="{}", nullable=False
        ),
        sa.Column("informed_ids", postgresql.ARRAY(sa.Uuid()), server_default="{}", nullable=False),
        sa.Column("evidence_ids", postgresql.ARRAY(sa.Uuid()), server_default="{}", nullable=False),
        sa.Column("entity_ids", postgresql.ARRAY(sa.Uuid()), server_default="{}", nullable=False),
        sa.Column(
            "subjects", postgresql.JSONB(astext_type=sa.Text()), server_default="[]", nullable=False
        ),
        sa.Column("expected_outcome", sa.Text(), nullable=True),
        sa.Column("prediction", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("outcome_id", sa.Uuid(), nullable=True),
        sa.Column("review_at", sa.Date(), nullable=True),
        sa.Column("origin", sa.Text(), nullable=False),
        sa.Column(
            "class",
            sa.Text(),
            sa.Computed(
                "CASE WHEN origin = 'checkpoint' THEN 'checkpoint' ELSE 'judgement' END",
                persisted=True,
            ),
            nullable=False,
        ),
        sa.Column("source_kind", sa.Text(), nullable=True),
        sa.Column("source_id", sa.Uuid(), nullable=True),
        sa.Column("run_id", sa.Uuid(), nullable=True),
        sa.Column("decided_via", sa.Text(), nullable=True),
        sa.Column("supersedes_id", sa.Uuid(), nullable=True),
        sa.Column("entity_id", sa.Uuid(), nullable=True),
        sa.Column("decided_by", sa.Uuid(), nullable=True),
        sa.Column("decided_actor", sa.Text(), nullable=True),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_by", sa.Uuid(), nullable=True),
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
            "origin IN ('manual', 'oracle', 'version_approval', 'assumption', 'blocker', "
            "'pushback_override', 'priority_override', 'autonomy', 'checkpoint')",
            name=op.f("ck_decisions_origin"),
        ),
        sa.CheckConstraint(
            "reversibility IN ('reversible', 'irreversible')",
            name=op.f("ck_decisions_reversibility"),
        ),
        sa.CheckConstraint(
            "status <> 'decided' OR (chosen_option IS NOT NULL AND rationale IS NOT NULL "
            "AND decided_at IS NOT NULL AND (review_at IS NOT NULL OR origin = 'checkpoint'))",
            name=op.f("ck_decisions_decided"),
        ),
        sa.CheckConstraint(
            "status IN ('proposed', 'decided', 'superseded', 'reversed', 'withdrawn')",
            name=op.f("ck_decisions_status"),
        ),
        sa.ForeignKeyConstraint(
            ["entity_id"],
            ["entities.id"],
            name=op.f("fk_decisions_entity_id_entities"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["outcome_id"],
            ["outcome_records.id"],
            name=op.f("fk_decisions_outcome_id_outcome_records"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["run_id"], ["runs.id"], name=op.f("fk_decisions_run_id_runs"), ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(
            ["supersedes_id"],
            ["decisions.id"],
            name=op.f("fk_decisions_supersedes_id_decisions"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_decisions_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_decisions")),
        sa.UniqueConstraint("tenant_id", "number", name=op.f("uq_decisions_tenant_id_number")),
        sa.UniqueConstraint(
            "tenant_id",
            "source_kind",
            "source_id",
            name=op.f("uq_decisions_tenant_id_source_kind_source_id"),
        ),
    )
    op.create_index(
        "ix_decisions_approver", "decisions", ["tenant_id", "approver_id", "status"], unique=False
    )
    op.create_index(
        "ix_decisions_class",
        "decisions",
        ["tenant_id", "class", sa.literal_column("decided_at DESC")],
        unique=False,
    )
    op.create_index(
        "ix_decisions_due",
        "decisions",
        ["tenant_id", "review_at"],
        unique=False,
        postgresql_where=sa.text("status = 'decided' AND origin <> 'checkpoint'"),
    )
    op.create_index(op.f("ix_decisions_entity_id"), "decisions", ["entity_id"], unique=False)
    op.create_index(op.f("ix_decisions_outcome_id"), "decisions", ["outcome_id"], unique=False)
    op.create_index(
        "ix_decisions_run",
        "decisions",
        ["tenant_id", "run_id"],
        unique=False,
        postgresql_where=sa.text("run_id IS NOT NULL"),
    )
    op.create_index(op.f("ix_decisions_run_id"), "decisions", ["run_id"], unique=False)
    op.create_index(
        op.f("ix_decisions_supersedes_id"), "decisions", ["supersedes_id"], unique=False
    )
    op.create_index(op.f("ix_decisions_tenant_id"), "decisions", ["tenant_id"], unique=False)
    op.create_table(
        "decision_reviews",
        sa.Column("decision_id", sa.Uuid(), nullable=False),
        sa.Column("verdict", sa.Text(), nullable=False),
        sa.Column("note", sa.Text(), nullable=False),
        sa.Column("outcome_status", sa.Text(), nullable=True),
        sa.Column("next_review_at", sa.Date(), nullable=True),
        sa.Column("revisit_id", sa.Uuid(), nullable=True),
        sa.Column("reviewed_by", sa.Uuid(), nullable=False),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "verdict IN ('reaffirmed', 'revisit', 'reversed')",
            name=op.f("ck_decision_reviews_verdict"),
        ),
        sa.ForeignKeyConstraint(
            ["decision_id"],
            ["decisions.id"],
            name=op.f("fk_decision_reviews_decision_id_decisions"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["revisit_id"],
            ["decisions.id"],
            name=op.f("fk_decision_reviews_revisit_id_decisions"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_decision_reviews_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_decision_reviews")),
    )
    op.create_index(
        op.f("ix_decision_reviews_decision_id"), "decision_reviews", ["decision_id"], unique=False
    )
    op.create_index(
        op.f("ix_decision_reviews_revisit_id"), "decision_reviews", ["revisit_id"], unique=False
    )
    op.create_index(
        op.f("ix_decision_reviews_tenant_id"), "decision_reviews", ["tenant_id"], unique=False
    )
    op.add_column("llm_jobs", sa.Column("decision_id", sa.Uuid(), nullable=True))
    op.create_index(op.f("ix_llm_jobs_decision_id"), "llm_jobs", ["decision_id"], unique=False)
    op.create_foreign_key(
        op.f("fk_llm_jobs_decision_id_decisions"),
        "llm_jobs",
        "decisions",
        ["decision_id"],
        ["id"],
        ondelete="CASCADE",
    )
    add_check_values(*KIND_CHECK, KINDS)
    op.drop_constraint(op.f("ck_llm_jobs_subject"), "llm_jobs", type_="check")
    op.create_check_constraint(op.f("ck_llm_jobs_subject"), "llm_jobs", SUBJECT_AFTER)
    for statement in BACKFILLS:
        op.execute(statement)


def downgrade() -> None:
    op.execute("DELETE FROM llm_jobs WHERE decision_id IS NOT NULL OR kind = 'decision_options'")
    op.drop_constraint(op.f("ck_llm_jobs_subject"), "llm_jobs", type_="check")
    op.create_check_constraint(op.f("ck_llm_jobs_subject"), "llm_jobs", SUBJECT_BEFORE)
    remove_check_values(*KIND_CHECK, KINDS)
    op.drop_constraint(op.f("fk_llm_jobs_decision_id_decisions"), "llm_jobs", type_="foreignkey")
    op.drop_index(op.f("ix_llm_jobs_decision_id"), table_name="llm_jobs")
    op.drop_column("llm_jobs", "decision_id")
    # The baseline decision entities synced from decisions (their edges, revisions and
    # evidence go with them); a dependency on one would be left with no upstream.
    synced = "SELECT id FROM entities WHERE type = 'decision' AND attrs ? 'decision_id'"
    op.execute(f"DELETE FROM artifact_dependencies WHERE upstream_entity_id IN ({synced})")
    op.execute("UPDATE decisions SET entity_id = NULL")
    op.execute(f"DELETE FROM entities WHERE id IN ({synced})")
    op.execute("DELETE FROM tenant_settings WHERE key = 'decision_irreversible_role'")
    op.drop_table("decision_reviews")
    op.drop_table("decisions")
