"""Product Oracle v2 intake (wave 1, lane v2-intake, CR-03)

Additive only. ``intake_proposals`` holds what an intake proposes from an answer (a
research run, a PRD patch) until a person accepts or dismisses it. ``llm_jobs`` gains
``intake_id`` and the ``intake_analysis`` kind, so light extraction runs on the existing
built-in model jobs; an intake job has no document, so ``document_id`` becomes nullable
and a check keeps every job tied to a document or an intake. Existing rows are
untouched. See docs/product-oracle-v2/03-discovery-and-quality.md.

Security review fixes (same lane, same revision):

- Pin stability: a snapshot records the database's transaction snapshot when it is
  taken (``snapshots.txn_snapshot``), every source item version the transaction that
  wrote it (``source_item_versions.xid``), and a deletion its transaction
  (``source_items.deleted_xid``). A pinned read keeps only what had *committed* when the
  pin was taken, so a sync that began before the pin and commits after it never joins
  the pinned set. Rows from before this revision have no xid and count as committed.
- ``knowledge_gaps.status`` gains ``answered_pending_review``: a critical gap answered
  by someone below the owner role waits for review instead of clearing (B4).
- ``knowledge_gaps.rule_key`` (round 3): the category key of a gap the intake engine
  made by rule. A rule-made gap was told from a model-written one by its statement
  text, so rewording a category in code turned rule gaps private (S6). Existing rows
  are backfilled from the statements as they stand at this revision.
- ``knowledge_gaps.importance_basis`` (round 4): where a gap's importance comes from,
  ``brief`` (the engine, from the brief and public facts) or ``person`` (someone set it).
  It is recorded on the gap whatever private findings the intake holds, so setting
  importance changes the same rows either way (S6). Existing rows keep NULL: their
  importance may have been moved by private sources, so reads still derive what others
  see from the brief for them. A partial index finds those rows
  (``ix_knowledge_gaps_legacy_importance``); the next analysis records their basis.
- ``intake_withheld_items`` (round 5, owner 2026-10-19): while any finding of an intake
  is below "shared in full", every source item its analysis and jobs read is withheld
  from its author's runs. Precomputed per intake, so a run's read is one indexed query.
  Existing intakes are backfilled fail closed: everything their stored analysis names
  is withheld until the intake is next analysed. Sharing alone does not release it:
  what an intake analysed before reads were recorded read is not known, so its author
  re-runs the analysis (``POST /v1/intakes/{id}/analyze``) to release it. A malformed
  item id in a stored analysis is skipped, never cast.
- ``intake_shared_items`` (round 6, owner 2026-10-19): the items cited by findings
  shared in full, which every run reads in full text unless an intake withholds them
  (``intake_withheld_items`` always wins). Round 7 (freeze at sharing, owner
  2026-10-19): a row is an (item, version) pair, what a finding cited, at the version
  its intake read, when its author shared it in full; runs read that version only.
  Existing full shares are backfilled with the version each cited item had at the
  intake's pin (recorded in the finding too, ``frozen``); an item whose version there
  cannot be determined (no pin, no version at it, deleted, not the author's) is not
  released and stays withheld until the author shares the finding again. A JSON-null
  ``findings`` (or list) in a stored analysis is read as empty.
- ``proposals.status`` gains ``withdrawn`` (round 6, owner 2026-10-19): lowering a
  finding back to private withdraws the open baseline proposal its answer made.
- ``source_item_versions.url`` (round 9, links, owner 2026-10-20): a version keeps the
  link it was written with, as it keeps the title, so a share freezes the link too.
  Existing versions are backfilled from their item's link, except Notion pages: their
  link's slug carries the page's *current* title, so they get the id-only page link
  (none when the item's id is not a page id). Fail closed. Round 10: rows whose link
  would be NULL are skipped; versions an old image writes during the rollout get theirs
  from the same query at API startup (``oracle.sources.repair``).

Check constraints this revision widens (``llm_jobs.kind``, ``knowledge_gaps.status``,
``proposals.status``) are extended from what the database holds, never rebuilt from a
fixed list, so values other lanes' revisions added (``quality_review``) survive in either
order; a downgrade removes only the values added here.

The integrator re-chains this revision in merge order (waves.md).

Revision ID: 0014_intake
Revises: 0017_citation_source_oracle
"""

import re
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0014_intake"
down_revision: str | None = "0017_citation_source_oracle"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# The rule-made statements at this revision, frozen (the backfill never follows code).
RULE_STATEMENTS = {
    "customer_user": "The primary user or customer segment is not confirmed.",
    "pain_evidence": "There is no confirmed evidence that the pain is real and frequent.",
    "goal_alignment": "No confirmed company goal is linked to this idea.",
    "success_metric": "No success metric with a baseline value and a target is agreed.",
    "differentiation": "Why this beats what competitors or the status quo offer is not stated.",
    "alternatives": "Alternatives (including doing nothing) have not been compared.",
    "constraints": "Technical, legal or organisational constraints are not listed.",
    "blockers": "It is unknown whether anything could stop this from shipping.",
    "economic_benefit": "The expected economic benefit is not estimated.",
    "effort_cost": "Effort and running cost are not estimated.",
    "security_privacy": "Security and privacy impact is not assessed.",
    "ownership": "No team or person owns the outcome.",
    "non_goals": "What is deliberately out of scope is not stated.",
    "release_rollout": "How this is released and rolled back is not planned.",
    "evaluation_criteria": "How quality is evaluated before launch is not defined.",
    "third_party_policy": (
        "Third-party API eligibility, limits, permissions and policies are not checked."
    ),
    "configurability_scaling": "Expected scale and what must be configurable are not known.",
}
XID = "(pg_current_xact_id()::text)::bigint"
UUID_TEXT = "'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'"


def _check_values(table: str, name: str) -> list[str]:
    """The quoted values of an ``IN`` check as the database holds it, in order."""
    definition = (
        op.get_bind()
        .execute(
            sa.text(
                "SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c "
                "JOIN pg_class t ON t.oid = c.conrelid "
                "WHERE t.relname = :table AND c.conname = :name"
            ).bindparams(table=table, name=name)
        )
        .scalar_one()
    )
    return [v.replace("''", "'") for v in re.findall(r"'((?:[^']|'')*)'", definition)]


def _widen_check(table: str, column: str, add: str = "", remove: str = "") -> None:
    """Add or remove one value of ``ck_<table>_<column>``, keeping every other value."""
    name = f"ck_{table}_{column}"
    values = [v for v in _check_values(table, name) if v != remove]
    if add and add not in values:
        values.append(add)
    listed = ", ".join("'" + v.replace("'", "''") + "'" for v in values)
    op.drop_constraint(op.f(name), table, type_="check")
    op.create_check_constraint(op.f(name), table, f"{column} IN ({listed})")


def _obj(expr: str) -> str:
    """A JSON object, or an empty one for SQL NULL, JSON null or anything else."""
    return f"(CASE WHEN jsonb_typeof({expr}) = 'object' THEN {expr} ELSE '{{}}'::jsonb END)"


def _arr(expr: str) -> str:
    """A JSON array, or an empty one for SQL NULL, JSON null or anything else."""
    return f"(CASE WHEN jsonb_typeof({expr}) = 'array' THEN {expr} ELSE '[]'::jsonb END)"


FINDINGS = _obj("i.analysis->'findings'")
# Every item id an intake's stored analysis names: what it read, the findings' citations,
# stale items and conflict claims. An id that is not a UUID is skipped, never cast (one
# malformed entry would abort the whole migration).
WITHHELD_BACKFILL = (
    """
INSERT INTO intake_withheld_items (id, tenant_id, intake_id, user_id, item_id)
SELECT gen_random_uuid(), i.tenant_id, i.id, i.author_id,
    CASE WHEN x.item_id ~* """
    + UUID_TEXT
    + f""" THEN x.item_id::uuid END
FROM product_intakes i
CROSS JOIN LATERAL (
    SELECT jsonb_array_elements_text({_arr("i.analysis->'read_item_ids'")})
    UNION SELECT jsonb_array_elements_text({_arr("i.analysis->'relevant_item_ids'")})
    UNION SELECT s->>'item_id' FROM jsonb_array_elements({_arr("i.analysis->'stale'")}) s
    UNION SELECT cl->>'item_id'
        FROM jsonb_array_elements({_arr("i.analysis->'conflicts'")}) c,
             jsonb_array_elements({_arr("c->'claims'")}) cl
    UNION SELECT jsonb_array_elements_text({_arr("f.value->'source_item_ids'")})
        FROM jsonb_each({FINDINGS}) f
    UNION SELECT jsonb_array_elements_text({_arr("f.value->'evidence_ids'")})
        FROM jsonb_each({FINDINGS}) f
) AS x(item_id)
WHERE i.author_id IS NOT NULL AND x.item_id ~* """
    + UUID_TEXT
    + """
ON CONFLICT DO NOTHING
"""
)
# Freeze at sharing (round 7): each finding shared in full records the version each
# item it cites had at the intake's pin (its last snapshot, committed then), for the
# author's items not deleted. What cannot be determined is left out: not released.
PINNED_VERSIONS = (
    """
SELECT DISTINCT ON (v.item_id) v.item_id, v.id AS version_id
FROM source_item_versions v
JOIN source_items si ON si.id = v.item_id AND si.deleted_at IS NULL
JOIN sources so ON so.id = si.source_id AND so.owner_user_id = i.author_id
JOIN snapshots sn ON sn.id = i.source_snapshot_ids[array_upper(i.source_snapshot_ids, 1)]
WHERE v.item_id IN (
        SELECT CASE WHEN c ~* """
    + UUID_TEXT
    + f""" THEN c::uuid END
        FROM jsonb_array_elements_text({_arr("f.value->'source_item_ids'")}) c
        WHERE c ~* """
    + UUID_TEXT
    + """)
  AND v.fetched_at <= sn.as_of
  AND (sn.txn_snapshot IS NULL OR v.xid IS NULL
       OR pg_visible_in_snapshot(v.xid::text::xid8, sn.txn_snapshot::pg_snapshot))
ORDER BY v.item_id, v.fetched_at DESC
"""
)
FROZEN_BACKFILL = f"""
UPDATE product_intakes i
SET analysis = jsonb_set(i.analysis, '{{findings}}', (
    SELECT jsonb_object_agg(f.key, CASE
        WHEN jsonb_typeof(f.value) = 'object' AND f.value->>'sharing' = 'full'
        THEN f.value || jsonb_build_object('frozen', (
            SELECT COALESCE(jsonb_object_agg(p.item_id::text, p.version_id::text), '{{}}')
            FROM ({PINNED_VERSIONS}) p))
        ELSE f.value END)
    FROM jsonb_each({FINDINGS}) f))
WHERE i.author_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM jsonb_each({FINDINGS}) f
    WHERE jsonb_typeof(f.value) = 'object' AND f.value->>'sharing' = 'full')
"""
# The (item, version) pairs each finding shared in full released.
SHARED_BACKFILL = f"""
INSERT INTO intake_shared_items (id, tenant_id, intake_id, user_id, item_id, version_id)
SELECT gen_random_uuid(), i.tenant_id, i.id, i.author_id, fr.key::uuid, fr.value::uuid
FROM product_intakes i
CROSS JOIN LATERAL jsonb_each({FINDINGS}) f
CROSS JOIN LATERAL jsonb_each_text({_obj("f.value->'frozen'")}) fr
WHERE i.author_id IS NOT NULL AND jsonb_typeof(f.value) = 'object'
  AND f.value->>'sharing' = 'full'
ON CONFLICT DO NOTHING
"""
TXN_SNAPSHOT = "pg_current_snapshot()::text"
# Round 9 (links): a version's link. Round 10: rows whose link would be NULL are not
# written. A frozen copy of oracle.sources.repair, which runs it again at startup for
# versions an old image wrote during the rollout. Built from the item's
# id only, never the item's current link, which can carry a name that changed after
# sharing (a Notion page's or Fireflies meeting's title, a GitHub repository's name).
# Notion: the id-only page link; Fireflies: the transcript id; Google Docs: the file id;
# GitHub: the repository as the source names it in the item's id (issues, pull requests
# and milestones; a release or file names no link by id); Slack: the permalink, which
# carries channel and message ids only. Anything else (an upload), or an id not of the
# expected form, gets none (fail closed).
VERSION_URL = """CASE so.kind
    WHEN 'notion' THEN CASE
        WHEN lower(replace(si.external_id, '-', '')) ~ '^[0-9a-f]{32}$'
        THEN 'https://www.notion.so/' || lower(replace(si.external_id, '-', '')) END
    WHEN 'fireflies' THEN CASE
        WHEN si.external_id ~ '^[A-Za-z0-9]+$'
        THEN 'https://app.fireflies.ai/view/' || si.external_id END
    WHEN 'google_docs' THEN CASE
        WHEN si.external_id ~ '^[A-Za-z0-9_-]+$'
        THEN 'https://docs.google.com/document/d/' || si.external_id || '/edit' END
    WHEN 'github' THEN CASE
        WHEN si.external_id ~ '^[a-z0-9._-]+/[a-z0-9._-]+:(issue|pull|milestone):[0-9]+$'
        THEN 'https://github.com/' || split_part(si.external_id, ':', 1) || '/'
            || CASE split_part(si.external_id, ':', 2) WHEN 'issue' THEN 'issues'
                ELSE split_part(si.external_id, ':', 2) END
            || '/' || split_part(si.external_id, ':', 3) END
    WHEN 'slack' THEN CASE
        WHEN si.url ~ '^https://[^/?#]+/archives/[A-Z0-9]+/p[0-9]+$' THEN si.url END
END"""

VERSION_URL_BACKFILL = f"""
UPDATE source_item_versions v
SET url = {VERSION_URL}
FROM source_items si
JOIN sources so ON so.id = si.source_id
WHERE si.id = v.item_id AND v.url IS NULL AND ({VERSION_URL}) IS NOT NULL
"""


def upgrade() -> None:
    op.create_table(
        "intake_proposals",
        sa.Column("intake_id", sa.Uuid(), nullable=False),
        sa.Column("gap_id", sa.Uuid(), nullable=True),
        sa.Column("question_id", sa.Uuid(), nullable=True),
        sa.Column("answer_id", sa.Uuid(), nullable=True),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column(
            "detail", postgresql.JSONB(astext_type=sa.Text()), server_default="{}", nullable=False
        ),
        sa.Column("status", sa.Text(), server_default="proposed", nullable=False),
        sa.Column(
            "result", postgresql.JSONB(astext_type=sa.Text()), server_default="{}", nullable=False
        ),
        sa.Column("created_by", sa.Uuid(), nullable=True),
        sa.Column("decided_by", sa.Uuid(), nullable=True),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("decision_note", sa.Text(), nullable=True),
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
            "kind IN ('research_run', 'prd_patch')", name=op.f("ck_intake_proposals_kind")
        ),
        sa.CheckConstraint(
            "status IN ('proposed', 'accepted', 'dismissed')",
            name=op.f("ck_intake_proposals_status"),
        ),
        sa.ForeignKeyConstraint(
            ["answer_id"],
            ["stakeholder_answers.id"],
            name=op.f("fk_intake_proposals_answer_id_stakeholder_answers"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["gap_id"],
            ["knowledge_gaps.id"],
            name=op.f("fk_intake_proposals_gap_id_knowledge_gaps"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["intake_id"],
            ["product_intakes.id"],
            name=op.f("fk_intake_proposals_intake_id_product_intakes"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["question_id"],
            ["stakeholder_questions.id"],
            name=op.f("fk_intake_proposals_question_id_stakeholder_questions"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_intake_proposals_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_intake_proposals")),
    )
    for column in ("answer_id", "gap_id", "intake_id", "question_id", "tenant_id"):
        op.create_index(
            op.f(f"ix_intake_proposals_{column}"), "intake_proposals", [column], unique=False
        )

    op.add_column("llm_jobs", sa.Column("intake_id", sa.Uuid(), nullable=True))
    op.alter_column("llm_jobs", "document_id", existing_type=sa.UUID(), nullable=True)
    op.create_index(op.f("ix_llm_jobs_intake_id"), "llm_jobs", ["intake_id"], unique=False)
    op.create_foreign_key(
        op.f("fk_llm_jobs_intake_id_product_intakes"),
        "llm_jobs",
        "product_intakes",
        ["intake_id"],
        ["id"],
        ondelete="CASCADE",
    )
    _widen_check("llm_jobs", "kind", add="intake_analysis")
    op.create_check_constraint(
        op.f("ck_llm_jobs_subject"), "llm_jobs", "document_id IS NOT NULL OR intake_id IS NOT NULL"
    )

    # Pin stability. Added without a default first, so existing rows keep NULL (committed).
    op.add_column("source_item_versions", sa.Column("xid", sa.BigInteger(), nullable=True))
    op.alter_column("source_item_versions", "xid", server_default=sa.text(XID))
    op.add_column("source_items", sa.Column("deleted_xid", sa.BigInteger(), nullable=True))
    op.add_column("snapshots", sa.Column("txn_snapshot", sa.Text(), nullable=True))
    op.alter_column("snapshots", "txn_snapshot", server_default=sa.text(TXN_SNAPSHOT))

    _widen_check("knowledge_gaps", "status", add="answered_pending_review")

    op.add_column("knowledge_gaps", sa.Column("rule_key", sa.Text(), nullable=True))
    for key, statement in RULE_STATEMENTS.items():
        op.execute(
            sa.text(
                "UPDATE knowledge_gaps SET rule_key = :key WHERE category = :key "
                "AND statement = :statement AND created_by IS NULL AND intake_id IS NOT NULL"
            ).bindparams(key=key, statement=statement)
        )

    op.add_column("knowledge_gaps", sa.Column("importance_basis", sa.Text(), nullable=True))
    op.create_check_constraint(
        op.f("ck_knowledge_gaps_importance_basis"),
        "knowledge_gaps",
        "importance_basis IS NULL OR importance_basis IN ('brief', 'person')",
    )
    op.create_index(
        "ix_knowledge_gaps_legacy_importance",
        "knowledge_gaps",
        ["intake_id"],
        unique=False,
        postgresql_where=sa.text("rule_key IS NOT NULL AND importance_basis IS NULL"),
    )

    op.create_table(
        "intake_withheld_items",
        sa.Column("intake_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("item_id", sa.Uuid(), nullable=False),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["intake_id"],
            ["product_intakes.id"],
            name=op.f("fk_intake_withheld_items_intake_id_product_intakes"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_intake_withheld_items_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_intake_withheld_items")),
        sa.UniqueConstraint(
            "intake_id", "item_id", name=op.f("uq_intake_withheld_items_intake_id_item_id")
        ),
    )
    for column in ("intake_id", "tenant_id"):
        op.create_index(
            op.f(f"ix_intake_withheld_items_{column}"),
            "intake_withheld_items",
            [column],
            unique=False,
        )
    op.create_index(
        "ix_intake_withheld_items_user_id_item_id",
        "intake_withheld_items",
        ["user_id", "item_id"],
        unique=False,
    )
    # Fail closed: every item an existing intake's analysis names is withheld.
    op.execute(WITHHELD_BACKFILL)

    op.create_table(
        "intake_shared_items",
        sa.Column("intake_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("item_id", sa.Uuid(), nullable=False),
        sa.Column("version_id", sa.Uuid(), nullable=False),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["intake_id"],
            ["product_intakes.id"],
            name=op.f("fk_intake_shared_items_intake_id_product_intakes"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_intake_shared_items_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_intake_shared_items")),
        sa.UniqueConstraint(
            "intake_id",
            "item_id",
            "version_id",
            name=op.f("uq_intake_shared_items_intake_id_item_id_version_id"),
        ),
    )
    for column in ("intake_id", "tenant_id"):
        op.create_index(
            op.f(f"ix_intake_shared_items_{column}"),
            "intake_shared_items",
            [column],
            unique=False,
        )
    op.create_index(
        "ix_intake_shared_items_item_id_user_id",
        "intake_shared_items",
        ["item_id", "user_id"],
        unique=False,
    )
    op.execute(FROZEN_BACKFILL)
    op.execute(SHARED_BACKFILL)

    _widen_check("proposals", "status", add="withdrawn")

    op.add_column("source_item_versions", sa.Column("url", sa.Text(), nullable=True))
    op.execute(VERSION_URL_BACKFILL)


def downgrade() -> None:
    op.drop_column("source_item_versions", "url")
    # A withdrawn proposal goes back to rejected (nobody may accept it).
    op.execute("UPDATE proposals SET status = 'rejected' WHERE status = 'withdrawn'")
    _widen_check("proposals", "status", remove="withdrawn")
    op.drop_table("intake_shared_items")
    op.drop_table("intake_withheld_items")
    op.drop_index("ix_knowledge_gaps_legacy_importance", table_name="knowledge_gaps")
    op.drop_constraint(op.f("ck_knowledge_gaps_importance_basis"), "knowledge_gaps", type_="check")
    op.drop_column("knowledge_gaps", "importance_basis")
    op.drop_column("knowledge_gaps", "rule_key")
    # A gap waiting for review goes back to answered (what it was before B4).
    op.execute(
        "UPDATE knowledge_gaps SET status = 'answered' WHERE status = 'answered_pending_review'"
    )
    _widen_check("knowledge_gaps", "status", remove="answered_pending_review")
    op.drop_column("snapshots", "txn_snapshot")
    op.drop_column("source_items", "deleted_xid")
    op.drop_column("source_item_versions", "xid")

    # Intake jobs have no document: they go with the column.
    op.execute("DELETE FROM llm_jobs WHERE document_id IS NULL OR kind = 'intake_analysis'")
    op.drop_constraint(op.f("ck_llm_jobs_subject"), "llm_jobs", type_="check")
    _widen_check("llm_jobs", "kind", remove="intake_analysis")
    op.drop_constraint(
        op.f("fk_llm_jobs_intake_id_product_intakes"), "llm_jobs", type_="foreignkey"
    )
    op.drop_index(op.f("ix_llm_jobs_intake_id"), table_name="llm_jobs")
    op.alter_column("llm_jobs", "document_id", existing_type=sa.UUID(), nullable=False)
    op.drop_column("llm_jobs", "intake_id")
    for column in ("tenant_id", "question_id", "intake_id", "gap_id", "answer_id"):
        op.drop_index(op.f(f"ix_intake_proposals_{column}"), table_name="intake_proposals")
    op.drop_table("intake_proposals")
