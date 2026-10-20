"""Roadmap items, schedule bases, product tracks and tracker records (CR-11, lane v2-roadmap)

Additive only. New tables: ``product_tracks``, ``track_milestones``, ``schedule_bases``,
``tracker_records`` and ``roadmap_items`` (oracle.roadmap.models). ``change_events``
accepts one more subject, ``product_track`` (a track's monitoring), added to the subjects
the check allows at upgrade time and removed alone at downgrade. Existing roadmap
documents and versions are untouched: a version imported before this has no items until a
run or a person imports them.

Downgrade drops the new tables and the product_track change events.

Revision ID: 0016_roadmap
Revises: 0014_blockers_snapshot
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

from oracle.migration_checks import add_check_values, remove_check_values

revision: str = "0016_roadmap"
down_revision: str | None = "0014_blockers_snapshot"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Only this lane's subject: the check keeps whatever other lanes' migrations added
# (oracle.migration_checks reads it from pg_constraint). oracle.v2.models.CHANGE_SUBJECTS
# stays the one list of every subject.
SUBJECTS = ("product_track",)
SUBJECT_CHECK = ("change_events", "ck_change_events_subject_kind", "subject_kind")


def upgrade() -> None:
    add_check_values(*SUBJECT_CHECK, SUBJECTS)
    op.create_table(
        "product_tracks",
        sa.Column("prd_document_id", sa.Uuid(), nullable=False),
        sa.Column("started_version_id", sa.Uuid(), nullable=True),
        sa.Column("current_version_id", sa.Uuid(), nullable=True),
        sa.Column("roadmap_document_id", sa.Uuid(), nullable=True),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), server_default="active", nullable=False),
        sa.Column("owner_id", sa.Uuid(), nullable=True),
        sa.Column("created_by", sa.Uuid(), nullable=True),
        sa.Column(
            "monitor", postgresql.JSONB(astext_type=sa.Text()), server_default="{}", nullable=False
        ),
        sa.Column("monitored_at", sa.DateTime(timezone=True), nullable=True),
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
            "status IN ('active', 'paused', 'closed')", name=op.f("ck_product_tracks_status")
        ),
        sa.ForeignKeyConstraint(
            ["current_version_id"],
            ["document_versions.id"],
            name=op.f("fk_product_tracks_current_version_id_document_versions"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["prd_document_id"],
            ["documents.id"],
            name=op.f("fk_product_tracks_prd_document_id_documents"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["roadmap_document_id"],
            ["documents.id"],
            name=op.f("fk_product_tracks_roadmap_document_id_documents"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["started_version_id"],
            ["document_versions.id"],
            name=op.f("fk_product_tracks_started_version_id_document_versions"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_product_tracks_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_product_tracks")),
        sa.UniqueConstraint(
            "tenant_id", "prd_document_id", name=op.f("uq_product_tracks_tenant_id_prd_document_id")
        ),
    )
    op.create_index(
        op.f("ix_product_tracks_current_version_id"),
        "product_tracks",
        ["current_version_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_product_tracks_prd_document_id"),
        "product_tracks",
        ["prd_document_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_product_tracks_roadmap_document_id"),
        "product_tracks",
        ["roadmap_document_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_product_tracks_started_version_id"),
        "product_tracks",
        ["started_version_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_product_tracks_tenant_id"), "product_tracks", ["tenant_id"], unique=False
    )
    op.create_table(
        "roadmap_items",
        sa.Column("roadmap_document_id", sa.Uuid(), nullable=False),
        sa.Column("roadmap_version_id", sa.Uuid(), nullable=False),
        sa.Column("track_id", sa.Uuid(), nullable=True),
        sa.Column("run_id", sa.Uuid(), nullable=True),
        sa.Column("item_key", sa.Text(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("outcome", sa.Text(), nullable=True),
        sa.Column("horizon", sa.Text(), nullable=False),
        sa.Column("prd_document_id", sa.Uuid(), nullable=True),
        sa.Column("prd_version_id", sa.Uuid(), nullable=True),
        sa.Column("prd_section_key", sa.Text(), nullable=True),
        sa.Column("prd_section_hash", sa.Text(), nullable=True),
        sa.Column("feature_id", sa.Uuid(), nullable=True),
        sa.Column(
            "requirement_ids", postgresql.ARRAY(sa.Uuid()), server_default="{}", nullable=False
        ),
        sa.Column("blocker_ids", postgresql.ARRAY(sa.Uuid()), server_default="{}", nullable=False),
        sa.Column("depends_on", postgresql.ARRAY(sa.Text()), server_default="{}", nullable=False),
        sa.Column(
            "trace", postgresql.JSONB(astext_type=sa.Text()), server_default="[]", nullable=False
        ),
        sa.Column("milestone", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column(
            "validation_gates",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="[]",
            nullable=False,
        ),
        sa.Column(
            "economics",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="{}",
            nullable=False,
        ),
        sa.Column("priority", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("confidence", sa.Text(), nullable=True),
        sa.Column("freshness", sa.Text(), server_default="fresh", nullable=False),
        sa.Column("caused_by_change_id", sa.Uuid(), nullable=True),
        sa.Column("stale_since", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "stale_reasons", postgresql.ARRAY(sa.Text()), server_default="{}", nullable=False
        ),
        sa.Column("reconciled_by", sa.Uuid(), nullable=True),
        sa.Column("reconciled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("reconciled_version_id", sa.Uuid(), nullable=True),
        sa.Column("reconciled_section_hash", sa.Text(), nullable=True),
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
            name=op.f("ck_roadmap_items_freshness"),
        ),
        sa.CheckConstraint(
            "horizon IN ('now', 'next', 'later')", name=op.f("ck_roadmap_items_horizon")
        ),
        sa.ForeignKeyConstraint(
            ["caused_by_change_id"],
            ["change_events.id"],
            name=op.f("fk_roadmap_items_caused_by_change_id_change_events"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["reconciled_version_id"],
            ["document_versions.id"],
            name=op.f("fk_roadmap_items_reconciled_version_id_document_versions"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["feature_id"],
            ["entities.id"],
            name=op.f("fk_roadmap_items_feature_id_entities"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["prd_document_id"],
            ["documents.id"],
            name=op.f("fk_roadmap_items_prd_document_id_documents"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["prd_version_id"],
            ["document_versions.id"],
            name=op.f("fk_roadmap_items_prd_version_id_document_versions"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["roadmap_document_id"],
            ["documents.id"],
            name=op.f("fk_roadmap_items_roadmap_document_id_documents"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["roadmap_version_id"],
            ["document_versions.id"],
            name=op.f("fk_roadmap_items_roadmap_version_id_document_versions"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["run_id"], ["runs.id"], name=op.f("fk_roadmap_items_run_id_runs"), ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_roadmap_items_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["track_id"],
            ["product_tracks.id"],
            name=op.f("fk_roadmap_items_track_id_product_tracks"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_roadmap_items")),
        sa.UniqueConstraint(
            "roadmap_version_id",
            "item_key",
            name=op.f("uq_roadmap_items_roadmap_version_id_item_key"),
        ),
    )
    op.create_index(
        op.f("ix_roadmap_items_caused_by_change_id"),
        "roadmap_items",
        ["caused_by_change_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_roadmap_items_feature_id"), "roadmap_items", ["feature_id"], unique=False
    )
    op.create_index(
        op.f("ix_roadmap_items_reconciled_version_id"),
        "roadmap_items",
        ["reconciled_version_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_roadmap_items_prd_document_id"), "roadmap_items", ["prd_document_id"], unique=False
    )
    op.create_index(
        "ix_roadmap_items_prd_section",
        "roadmap_items",
        ["prd_version_id", "prd_section_key"],
        unique=False,
    )
    op.create_index(
        op.f("ix_roadmap_items_prd_version_id"), "roadmap_items", ["prd_version_id"], unique=False
    )
    op.create_index(
        op.f("ix_roadmap_items_roadmap_document_id"),
        "roadmap_items",
        ["roadmap_document_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_roadmap_items_roadmap_version_id"),
        "roadmap_items",
        ["roadmap_version_id"],
        unique=False,
    )
    op.create_index(op.f("ix_roadmap_items_run_id"), "roadmap_items", ["run_id"], unique=False)
    op.create_index(
        op.f("ix_roadmap_items_tenant_id"), "roadmap_items", ["tenant_id"], unique=False
    )
    op.create_index(op.f("ix_roadmap_items_track_id"), "roadmap_items", ["track_id"], unique=False)
    op.create_table(
        "track_milestones",
        sa.Column("track_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("horizon", sa.Text(), server_default="now", nullable=False),
        sa.Column("target_date", sa.Date(), nullable=True),
        sa.Column("basis_ids", postgresql.ARRAY(sa.Uuid()), server_default="{}", nullable=False),
        sa.Column("item_keys", postgresql.ARRAY(sa.Text()), server_default="{}", nullable=False),
        sa.Column("status", sa.Text(), server_default="planned", nullable=False),
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
            "horizon IN ('now', 'next', 'later')", name=op.f("ck_track_milestones_horizon")
        ),
        sa.CheckConstraint(
            "status IN ('planned', 'done', 'dropped')", name=op.f("ck_track_milestones_status")
        ),
        sa.CheckConstraint(
            "target_date IS NULL OR cardinality(basis_ids) > 0",
            name=op.f("ck_track_milestones_dated_needs_basis"),
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_track_milestones_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["track_id"],
            ["product_tracks.id"],
            name=op.f("fk_track_milestones_track_id_product_tracks"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_track_milestones")),
        sa.UniqueConstraint("track_id", "name", name=op.f("uq_track_milestones_track_id_name")),
    )
    op.create_index(
        op.f("ix_track_milestones_tenant_id"), "track_milestones", ["tenant_id"], unique=False
    )
    op.create_index(
        op.f("ix_track_milestones_track_id"), "track_milestones", ["track_id"], unique=False
    )
    op.create_table(
        "tracker_records",
        sa.Column("tracker", sa.Text(), nullable=False),
        sa.Column("external_ref", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=True),
        sa.Column("url", sa.Text(), nullable=True),
        sa.Column("track_id", sa.Uuid(), nullable=True),
        sa.Column("item_key", sa.Text(), nullable=True),
        sa.Column("state", sa.Text(), nullable=False),
        sa.Column("raw_status", sa.Text(), nullable=True),
        sa.Column("estimate", sa.Numeric(precision=10, scale=2), nullable=True),
        sa.Column("estimate_unit", sa.Text(), nullable=True),
        sa.Column("target_date", sa.Date(), nullable=True),
        sa.Column("observed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("recorded_by", sa.Uuid(), nullable=True),
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
            "state IN ('todo', 'in_progress', 'done', 'cancelled', 'unknown')",
            name=op.f("ck_tracker_records_state"),
        ),
        sa.CheckConstraint(
            "tracker IN ('linear', 'jira', 'github', 'other')",
            name=op.f("ck_tracker_records_tracker"),
        ),
        sa.CheckConstraint(
            "estimate IS NULL OR estimate >= 0", name=op.f("ck_tracker_records_estimate")
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_tracker_records_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["track_id"],
            ["product_tracks.id"],
            name=op.f("fk_tracker_records_track_id_product_tracks"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_tracker_records")),
        sa.UniqueConstraint(
            "tenant_id",
            "tracker",
            "external_ref",
            name=op.f("uq_tracker_records_tenant_id_tracker_external_ref"),
        ),
    )
    op.create_index(
        op.f("ix_tracker_records_tenant_id"), "tracker_records", ["tenant_id"], unique=False
    )
    op.create_index(
        op.f("ix_tracker_records_track_id"), "tracker_records", ["track_id"], unique=False
    )
    op.create_table(
        "schedule_bases",
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("reference", sa.Text(), nullable=False),
        sa.Column("supports_date", sa.Date(), nullable=False),
        sa.Column("detail", sa.Text(), nullable=True),
        sa.Column("prd_document_id", sa.Uuid(), nullable=False),
        sa.Column("item_key", sa.Text(), nullable=True),
        sa.Column("tracker_key", sa.Text(), nullable=True),
        sa.Column("tracker_record_id", sa.Uuid(), nullable=True),
        sa.Column("status", sa.Text(), server_default="verified", nullable=False),
        sa.Column("verified_by", sa.Uuid(), nullable=True),
        sa.Column("verified_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("withdrawn_by", sa.Uuid(), nullable=True),
        sa.Column("withdrawn_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "kind IN ('estimate', 'capacity', 'commitment')", name=op.f("ck_schedule_bases_kind")
        ),
        sa.CheckConstraint(
            "status IN ('verified', 'withdrawn')", name=op.f("ck_schedule_bases_status")
        ),
        sa.CheckConstraint(
            "item_key IS NULL OR tracker_key IS NULL", name=op.f("ck_schedule_bases_one_key")
        ),
        sa.ForeignKeyConstraint(
            ["prd_document_id"],
            ["documents.id"],
            name=op.f("fk_schedule_bases_prd_document_id_documents"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_schedule_bases_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tracker_record_id"],
            ["tracker_records.id"],
            name=op.f("fk_schedule_bases_tracker_record_id_tracker_records"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_schedule_bases")),
    )
    op.create_index(
        op.f("ix_schedule_bases_prd_document_id"),
        "schedule_bases",
        ["prd_document_id"],
        unique=False,
    )
    op.create_index(
        "ix_schedule_bases_reference", "schedule_bases", ["tenant_id", "reference"], unique=False
    )
    op.create_index(
        op.f("ix_schedule_bases_tenant_id"), "schedule_bases", ["tenant_id"], unique=False
    )
    op.create_index(
        op.f("ix_schedule_bases_tracker_record_id"),
        "schedule_bases",
        ["tracker_record_id"],
        unique=False,
    )


def downgrade() -> None:
    op.execute("DELETE FROM change_events WHERE subject_kind = 'product_track'")
    remove_check_values(*SUBJECT_CHECK, SUBJECTS)
    op.drop_index(op.f("ix_schedule_bases_tracker_record_id"), table_name="schedule_bases")
    op.drop_index(op.f("ix_schedule_bases_tenant_id"), table_name="schedule_bases")
    op.drop_index("ix_schedule_bases_reference", table_name="schedule_bases")
    op.drop_index(op.f("ix_schedule_bases_prd_document_id"), table_name="schedule_bases")
    op.drop_table("schedule_bases")
    op.drop_index(op.f("ix_tracker_records_track_id"), table_name="tracker_records")
    op.drop_index(op.f("ix_tracker_records_tenant_id"), table_name="tracker_records")
    op.drop_table("tracker_records")
    op.drop_index(op.f("ix_track_milestones_track_id"), table_name="track_milestones")
    op.drop_index(op.f("ix_track_milestones_tenant_id"), table_name="track_milestones")
    op.drop_table("track_milestones")
    op.drop_index(op.f("ix_roadmap_items_track_id"), table_name="roadmap_items")
    op.drop_index(op.f("ix_roadmap_items_tenant_id"), table_name="roadmap_items")
    op.drop_index(op.f("ix_roadmap_items_run_id"), table_name="roadmap_items")
    op.drop_index(op.f("ix_roadmap_items_roadmap_version_id"), table_name="roadmap_items")
    op.drop_index(op.f("ix_roadmap_items_roadmap_document_id"), table_name="roadmap_items")
    op.drop_index(op.f("ix_roadmap_items_prd_version_id"), table_name="roadmap_items")
    op.drop_index(op.f("ix_roadmap_items_reconciled_version_id"), table_name="roadmap_items")
    op.drop_index("ix_roadmap_items_prd_section", table_name="roadmap_items")
    op.drop_index(op.f("ix_roadmap_items_prd_document_id"), table_name="roadmap_items")
    op.drop_index(op.f("ix_roadmap_items_feature_id"), table_name="roadmap_items")
    op.drop_index(op.f("ix_roadmap_items_caused_by_change_id"), table_name="roadmap_items")
    op.drop_table("roadmap_items")
    op.drop_index(op.f("ix_product_tracks_tenant_id"), table_name="product_tracks")
    op.drop_index(op.f("ix_product_tracks_started_version_id"), table_name="product_tracks")
    op.drop_index(op.f("ix_product_tracks_roadmap_document_id"), table_name="product_tracks")
    op.drop_index(op.f("ix_product_tracks_prd_document_id"), table_name="product_tracks")
    op.drop_index(op.f("ix_product_tracks_current_version_id"), table_name="product_tracks")
    op.drop_table("product_tracks")
