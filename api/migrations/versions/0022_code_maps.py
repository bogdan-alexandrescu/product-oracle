"""Code capability maps (F5-2): the code_maps table and the code_map flow

Adds ``code_maps``: one map a ``code_map`` run builds of one repo of a GitHub source
(status building, ready, stale or failed; sharing private or full, S6), with its checked
``code_map.json`` in ``content``. Unique per source, repo and commit; deleting the source
deletes its maps, deleting the run keeps the map (``run_id`` nulled). ``stale_at``: the
first merge on the repo after the map's run started (a refresh is due).

``runs.flow`` gains ``code_map``, extended through ``oracle.migration_checks`` from what
the database holds, so other lanes' values survive in either order.

Additive. The downgrade deletes ``code_map`` runs, drops the table and removes the value
(keeping every other value of the check).

Revision ID: 0022_code_maps
Revises: 0021_feedback_agent_staging
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

from oracle.migration_checks import add_check_values, remove_check_values

revision: str = "0022_code_maps"
down_revision: str | None = "0021_feedback_agent_staging"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

FLOW_CHECK = ("runs", "ck_runs_flow", "flow")
FLOWS = ("code_map",)


def upgrade() -> None:
    add_check_values(*FLOW_CHECK, FLOWS)
    op.create_table(
        "code_maps",
        sa.Column("source_id", sa.Uuid(), nullable=False),
        sa.Column("repo", sa.Text(), nullable=False),
        sa.Column("commit_sha", sa.Text(), nullable=True),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("sharing", sa.Text(), server_default="private", nullable=False),
        sa.Column("shared_by", sa.Uuid(), nullable=True),
        sa.Column("shared_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("content", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("size_bytes", sa.Integer(), nullable=True),
        sa.Column("run_id", sa.Uuid(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("as_of", sa.DateTime(timezone=True), nullable=True),
        sa.Column("stale_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "status IN ('building', 'ready', 'stale', 'failed')", name=op.f("ck_code_maps_status")
        ),
        sa.CheckConstraint("sharing IN ('private', 'full')", name=op.f("ck_code_maps_sharing")),
        sa.ForeignKeyConstraint(
            ["run_id"], ["runs.id"], name=op.f("fk_code_maps_run_id_runs"), ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(
            ["source_id"],
            ["sources.id"],
            name=op.f("fk_code_maps_source_id_sources"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_code_maps_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_code_maps")),
        sa.UniqueConstraint(
            "source_id", "repo", "commit_sha", name=op.f("uq_code_maps_source_id_repo_commit_sha")
        ),
    )
    op.create_index(op.f("ix_code_maps_tenant_id"), "code_maps", ["tenant_id"], unique=False)
    op.create_index("ix_code_maps_source_id_repo", "code_maps", ["source_id", "repo"])


def downgrade() -> None:
    op.execute("DELETE FROM runs WHERE flow = 'code_map'")
    op.drop_table("code_maps")
    remove_check_values(*FLOW_CHECK, FLOWS)
