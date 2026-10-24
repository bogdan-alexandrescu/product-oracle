"""H7 Competitive digest: alternatives, watched pages, changes, web findings, positioning

Eight new tables (oracle.market.models and oracle.web.models): ``competitors``,
``competitor_pages``, ``competitor_page_snapshots``, ``web_results``,
``competitor_web_findings``, ``competitor_changes``, ``positioning`` and
``positioning_suggestions``. The ``competitive_digest`` flow joins ``runs.flow`` through
``oracle.migration_checks`` (other lanes' values survive), and ``read:web`` joins the
run-token scopes check. The ``web_searches_per_month`` setting needs no schema: its
default lives in code.

Downgrade: refuses while a live run token holds ``read:web``; deletes the digest runs and
the setting, narrows both checks and drops the eight tables.

Revision ID: 0052_market
Revises: 0051_pricing
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

from oracle.migration_checks import add_check_values, remove_check_values

revision: str = "0052_market"
down_revision: str | None = "0051_pricing"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


FLOW_CHECK = ("runs", "ck_runs_flow", "flow", ("competitive_digest",))
SCOPES_BEFORE = (
    "read:sources",
    "read:baseline",
    "read:documents",
    "write:proposals",
    "write:drafts",
)


def _scopes_check(scopes: tuple[str, ...]) -> None:
    listed = ", ".join(f"'{s}'" for s in scopes)
    op.drop_constraint(op.f("ck_run_tokens_scopes"), "run_tokens", type_="check")
    op.create_check_constraint(
        op.f("ck_run_tokens_scopes"),
        "run_tokens",
        f"cardinality(scopes) > 0 AND scopes <@ ARRAY[{listed}]::text[]",
    )


def upgrade() -> None:
    add_check_values(*FLOW_CHECK)
    _scopes_check((*SCOPES_BEFORE, "read:web"))
    op.create_table(
        "competitors",
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("website", sa.Text(), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("aliases", postgresql.ARRAY(sa.Text()), server_default="{}", nullable=False),
        sa.Column("status", sa.Text(), server_default="active", nullable=False),
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
            "kind IN ('direct', 'indirect', 'status_quo')", name=op.f("ck_competitors_kind")
        ),
        sa.CheckConstraint("status IN ('active', 'archived')", name=op.f("ck_competitors_status")),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_competitors_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_competitors")),
    )
    op.create_index(op.f("ix_competitors_tenant_id"), "competitors", ["tenant_id"], unique=False)
    op.create_index(
        "ux_competitors_name",
        "competitors",
        ["tenant_id", sa.literal_column("lower(name)")],
        unique=True,
        postgresql_where=sa.text("status = 'active'"),
    )
    op.create_table(
        "positioning",
        sa.Column(
            "fields", postgresql.JSONB(astext_type=sa.Text()), server_default="{}", nullable=False
        ),
        sa.Column("updated_by", sa.Uuid(), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("lock_version", sa.Integer(), server_default="1", nullable=False),
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
            name=op.f("fk_positioning_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_positioning")),
        sa.UniqueConstraint("tenant_id", name=op.f("uq_positioning_tenant_id")),
    )
    op.create_index(op.f("ix_positioning_tenant_id"), "positioning", ["tenant_id"], unique=False)
    op.create_table(
        "competitor_pages",
        sa.Column("competitor_id", sa.Uuid(), nullable=False),
        sa.Column("url", sa.Text(), nullable=False),
        sa.Column("label", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), server_default="active", nullable=False),
        sa.Column("last_checked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_changed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("attempts", sa.Integer(), server_default="0", nullable=False),
        sa.Column("last_error", sa.Text(), nullable=True),
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
            "label IN ('pricing', 'changelog', 'product', 'docs', 'blog', 'other')",
            name=op.f("ck_competitor_pages_label"),
        ),
        sa.CheckConstraint(
            "status IN ('active', 'paused', 'blocked', 'error')",
            name=op.f("ck_competitor_pages_status"),
        ),
        sa.ForeignKeyConstraint(
            ["competitor_id"],
            ["competitors.id"],
            name=op.f("fk_competitor_pages_competitor_id_competitors"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_competitor_pages_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_competitor_pages")),
        sa.UniqueConstraint(
            "competitor_id", "url", name=op.f("uq_competitor_pages_competitor_id_url")
        ),
    )
    op.create_index(
        op.f("ix_competitor_pages_competitor_id"),
        "competitor_pages",
        ["competitor_id"],
        unique=False,
    )
    op.create_index(
        "ix_competitor_pages_due",
        "competitor_pages",
        ["tenant_id", "last_checked_at"],
        unique=False,
        postgresql_where=sa.text("status = 'active'"),
    )
    op.create_index(
        op.f("ix_competitor_pages_tenant_id"), "competitor_pages", ["tenant_id"], unique=False
    )
    op.create_table(
        "competitor_page_snapshots",
        sa.Column("page_id", sa.Uuid(), nullable=False),
        sa.Column("fetched_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("final_url", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=True),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("content_hash", sa.Text(), nullable=False),
        sa.Column("last_modified", sa.DateTime(timezone=True), nullable=True),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["page_id"],
            ["competitor_pages.id"],
            name=op.f("fk_competitor_page_snapshots_page_id_competitor_pages"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_competitor_page_snapshots_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_competitor_page_snapshots")),
    )
    op.create_index(
        op.f("ix_competitor_page_snapshots_page_id"),
        "competitor_page_snapshots",
        ["page_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_competitor_page_snapshots_tenant_id"),
        "competitor_page_snapshots",
        ["tenant_id"],
        unique=False,
    )
    op.create_table(
        "web_results",
        sa.Column("run_id", sa.Uuid(), nullable=False),
        sa.Column("ref", sa.Text(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("query", sa.Text(), nullable=True),
        sa.Column("url", sa.Text(), nullable=False),
        sa.Column("host", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=True),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("published_on", sa.Date(), nullable=True),
        sa.Column(
            "fetched_at",
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
        sa.CheckConstraint("kind IN ('search_result', 'page')", name=op.f("ck_web_results_kind")),
        sa.ForeignKeyConstraint(
            ["run_id"], ["runs.id"], name=op.f("fk_web_results_run_id_runs"), ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_web_results_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_web_results")),
        sa.UniqueConstraint("run_id", "ref", name=op.f("uq_web_results_run_id_ref")),
    )
    op.create_index(
        "ix_web_results_month", "web_results", ["tenant_id", "fetched_at"], unique=False
    )
    op.create_index(op.f("ix_web_results_run_id"), "web_results", ["run_id"], unique=False)
    op.create_index(op.f("ix_web_results_tenant_id"), "web_results", ["tenant_id"], unique=False)
    op.create_table(
        "competitor_web_findings",
        sa.Column("competitor_id", sa.Uuid(), nullable=False),
        sa.Column("web_result_id", sa.Uuid(), nullable=True),
        sa.Column("run_id", sa.Uuid(), nullable=True),
        sa.Column("occurrence_id", sa.Uuid(), nullable=True),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("summary", sa.Text(), nullable=False),
        sa.Column("excerpt", sa.Text(), nullable=False),
        sa.Column("url", sa.Text(), nullable=False),
        sa.Column("host", sa.Text(), nullable=False),
        sa.Column("published_on", sa.Date(), nullable=True),
        sa.Column("status", sa.Text(), server_default="open", nullable=False),
        sa.Column("decided_by", sa.Uuid(), nullable=True),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("dismiss_reason", sa.Text(), nullable=True),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "kind IN ('news', 'review', 'launch', 'pricing', 'other')",
            name=op.f("ck_competitor_web_findings_kind"),
        ),
        sa.CheckConstraint(
            "status IN ('open', 'promoted', 'dismissed')",
            name=op.f("ck_competitor_web_findings_status"),
        ),
        sa.ForeignKeyConstraint(
            ["competitor_id"],
            ["competitors.id"],
            name=op.f("fk_competitor_web_findings_competitor_id_competitors"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["occurrence_id"],
            ["ritual_occurrences.id"],
            name=op.f("fk_competitor_web_findings_occurrence_id_ritual_occurrences"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["run_id"],
            ["runs.id"],
            name=op.f("fk_competitor_web_findings_run_id_runs"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_competitor_web_findings_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["web_result_id"],
            ["web_results.id"],
            name=op.f("fk_competitor_web_findings_web_result_id_web_results"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_competitor_web_findings")),
    )
    op.create_index(
        op.f("ix_competitor_web_findings_competitor_id"),
        "competitor_web_findings",
        ["competitor_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_competitor_web_findings_occurrence_id"),
        "competitor_web_findings",
        ["occurrence_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_competitor_web_findings_run_id"),
        "competitor_web_findings",
        ["run_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_competitor_web_findings_tenant_id"),
        "competitor_web_findings",
        ["tenant_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_competitor_web_findings_web_result_id"),
        "competitor_web_findings",
        ["web_result_id"],
        unique=False,
    )
    op.create_index(
        "ix_web_findings_url", "competitor_web_findings", ["tenant_id", "url"], unique=False
    )
    op.create_table(
        "positioning_suggestions",
        sa.Column("field", sa.Text(), nullable=False),
        sa.Column("action", sa.Text(), nullable=False),
        sa.Column("item_id", sa.Text(), nullable=True),
        sa.Column("text", sa.Text(), nullable=True),
        sa.Column("rationale", sa.Text(), nullable=False),
        sa.Column(
            "refs", postgresql.JSONB(astext_type=sa.Text()), server_default="[]", nullable=False
        ),
        sa.Column("run_id", sa.Uuid(), nullable=True),
        sa.Column("occurrence_id", sa.Uuid(), nullable=True),
        sa.Column("status", sa.Text(), server_default="open", nullable=False),
        sa.Column("decided_by", sa.Uuid(), nullable=True),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "action IN ('add', 'replace', 'remove')", name=op.f("ck_positioning_suggestions_action")
        ),
        sa.CheckConstraint(
            "field IN ('alternatives', 'unique_attributes', 'value_and_proof', "
            "'best_fit_customers', 'market_category', 'trends')",
            name=op.f("ck_positioning_suggestions_field"),
        ),
        sa.CheckConstraint(
            "status IN ('open', 'accepted', 'dismissed')",
            name=op.f("ck_positioning_suggestions_status"),
        ),
        sa.ForeignKeyConstraint(
            ["occurrence_id"],
            ["ritual_occurrences.id"],
            name=op.f("fk_positioning_suggestions_occurrence_id_ritual_occurrences"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["run_id"],
            ["runs.id"],
            name=op.f("fk_positioning_suggestions_run_id_runs"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_positioning_suggestions_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_positioning_suggestions")),
    )
    op.create_index(
        op.f("ix_positioning_suggestions_occurrence_id"),
        "positioning_suggestions",
        ["occurrence_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_positioning_suggestions_run_id"),
        "positioning_suggestions",
        ["run_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_positioning_suggestions_tenant_id"),
        "positioning_suggestions",
        ["tenant_id"],
        unique=False,
    )
    op.create_table(
        "competitor_changes",
        sa.Column("competitor_id", sa.Uuid(), nullable=False),
        sa.Column("origin", sa.Text(), server_default="page", nullable=False),
        sa.Column("page_id", sa.Uuid(), nullable=True),
        sa.Column("before_id", sa.Uuid(), nullable=True),
        sa.Column("after_id", sa.Uuid(), nullable=True),
        sa.Column("web_finding_id", sa.Uuid(), nullable=True),
        sa.Column("detected_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("added_lines", sa.Integer(), server_default="0", nullable=False),
        sa.Column("removed_lines", sa.Integer(), server_default="0", nullable=False),
        sa.Column(
            "diff", postgresql.JSONB(astext_type=sa.Text()), server_default="[]", nullable=False
        ),
        sa.Column("rating", sa.Text(), server_default="minor", nullable=False),
        sa.Column("rated_by", sa.Text(), server_default="rule", nullable=False),
        sa.Column("summary", sa.Text(), nullable=True),
        sa.Column("occurrence_id", sa.Uuid(), nullable=True),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "(origin = 'page') = (page_id IS NOT NULL AND after_id IS NOT NULL)",
            name=op.f("ck_competitor_changes_page"),
        ),
        sa.CheckConstraint(
            "(origin = 'web') = (web_finding_id IS NOT NULL)",
            name=op.f("ck_competitor_changes_web"),
        ),
        sa.CheckConstraint("origin IN ('page', 'web')", name=op.f("ck_competitor_changes_origin")),
        sa.CheckConstraint(
            "rated_by IN ('rule', 'oracle', 'person')", name=op.f("ck_competitor_changes_rated_by")
        ),
        sa.CheckConstraint(
            "rating IN ('minor', 'notable', 'major')", name=op.f("ck_competitor_changes_rating")
        ),
        sa.ForeignKeyConstraint(
            ["after_id"],
            ["competitor_page_snapshots.id"],
            name=op.f("fk_competitor_changes_after_id_competitor_page_snapshots"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["before_id"],
            ["competitor_page_snapshots.id"],
            name=op.f("fk_competitor_changes_before_id_competitor_page_snapshots"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["competitor_id"],
            ["competitors.id"],
            name=op.f("fk_competitor_changes_competitor_id_competitors"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["occurrence_id"],
            ["ritual_occurrences.id"],
            name=op.f("fk_competitor_changes_occurrence_id_ritual_occurrences"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["page_id"],
            ["competitor_pages.id"],
            name=op.f("fk_competitor_changes_page_id_competitor_pages"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_competitor_changes_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["web_finding_id"],
            ["competitor_web_findings.id"],
            name=op.f("fk_competitor_changes_web_finding_id_competitor_web_findings"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_competitor_changes")),
    )
    op.create_index(
        op.f("ix_competitor_changes_after_id"), "competitor_changes", ["after_id"], unique=False
    )
    op.create_index(
        op.f("ix_competitor_changes_before_id"), "competitor_changes", ["before_id"], unique=False
    )
    op.create_index(
        op.f("ix_competitor_changes_competitor_id"),
        "competitor_changes",
        ["competitor_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_competitor_changes_occurrence_id"),
        "competitor_changes",
        ["occurrence_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_competitor_changes_page_id"), "competitor_changes", ["page_id"], unique=False
    )
    op.create_index(
        op.f("ix_competitor_changes_tenant_id"), "competitor_changes", ["tenant_id"], unique=False
    )
    op.create_index(
        op.f("ix_competitor_changes_web_finding_id"),
        "competitor_changes",
        ["web_finding_id"],
        unique=False,
    )
    op.create_index(
        "ix_competitor_changes_when",
        "competitor_changes",
        ["tenant_id", sa.literal_column("detected_at DESC")],
        unique=False,
    )


def downgrade() -> None:
    live = op.get_bind().scalar(
        sa.text(
            "SELECT count(*) FROM run_tokens WHERE 'read:web' = ANY(scopes) "
            "AND revoked_at IS NULL AND expires_at > now()"
        )
    )
    if live:
        raise RuntimeError("a live run token holds read:web; let it expire first")
    op.drop_index("ix_competitor_changes_when", table_name="competitor_changes")
    op.drop_index(op.f("ix_competitor_changes_web_finding_id"), table_name="competitor_changes")
    op.drop_index(op.f("ix_competitor_changes_tenant_id"), table_name="competitor_changes")
    op.drop_index(op.f("ix_competitor_changes_page_id"), table_name="competitor_changes")
    op.drop_index(op.f("ix_competitor_changes_occurrence_id"), table_name="competitor_changes")
    op.drop_index(op.f("ix_competitor_changes_competitor_id"), table_name="competitor_changes")
    op.drop_index(op.f("ix_competitor_changes_before_id"), table_name="competitor_changes")
    op.drop_index(op.f("ix_competitor_changes_after_id"), table_name="competitor_changes")
    op.drop_table("competitor_changes")
    op.drop_index(
        op.f("ix_positioning_suggestions_tenant_id"), table_name="positioning_suggestions"
    )
    op.drop_index(op.f("ix_positioning_suggestions_run_id"), table_name="positioning_suggestions")
    op.drop_index(
        op.f("ix_positioning_suggestions_occurrence_id"), table_name="positioning_suggestions"
    )
    op.drop_table("positioning_suggestions")
    op.drop_index("ix_web_findings_url", table_name="competitor_web_findings")
    op.drop_index(
        op.f("ix_competitor_web_findings_web_result_id"), table_name="competitor_web_findings"
    )
    op.drop_index(
        op.f("ix_competitor_web_findings_tenant_id"), table_name="competitor_web_findings"
    )
    op.drop_index(op.f("ix_competitor_web_findings_run_id"), table_name="competitor_web_findings")
    op.drop_index(
        op.f("ix_competitor_web_findings_occurrence_id"), table_name="competitor_web_findings"
    )
    op.drop_index(
        op.f("ix_competitor_web_findings_competitor_id"), table_name="competitor_web_findings"
    )
    op.drop_table("competitor_web_findings")
    op.drop_index(op.f("ix_web_results_tenant_id"), table_name="web_results")
    op.drop_index(op.f("ix_web_results_run_id"), table_name="web_results")
    op.drop_index("ix_web_results_month", table_name="web_results")
    op.drop_table("web_results")
    op.drop_index(
        op.f("ix_competitor_page_snapshots_tenant_id"), table_name="competitor_page_snapshots"
    )
    op.drop_index(
        op.f("ix_competitor_page_snapshots_page_id"), table_name="competitor_page_snapshots"
    )
    op.drop_table("competitor_page_snapshots")
    op.drop_index(op.f("ix_competitor_pages_tenant_id"), table_name="competitor_pages")
    op.drop_index(
        "ix_competitor_pages_due",
        table_name="competitor_pages",
        postgresql_where=sa.text("status = 'active'"),
    )
    op.drop_index(op.f("ix_competitor_pages_competitor_id"), table_name="competitor_pages")
    op.drop_table("competitor_pages")
    op.drop_index(op.f("ix_positioning_tenant_id"), table_name="positioning")
    op.drop_table("positioning")
    op.drop_index(
        "ux_competitors_name",
        table_name="competitors",
        postgresql_where=sa.text("status = 'active'"),
    )
    op.drop_index(op.f("ix_competitors_tenant_id"), table_name="competitors")
    op.drop_table("competitors")
    op.execute("DELETE FROM run_tokens WHERE 'read:web' = ANY(scopes)")
    _scopes_check(SCOPES_BEFORE)
    op.execute("DELETE FROM runs WHERE flow = 'competitive_digest'")
    remove_check_values(*FLOW_CHECK)
    op.execute("DELETE FROM tenant_settings WHERE key = 'web_searches_per_month'")
