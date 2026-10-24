"""H7 Competitive digest, lane 1: Oracle's web tools

``web_searches``: one row per search sent to the provider, which the per-run cap and the
company's ``web_searches_per_month`` count. The ``web_results`` table and the ``read:web``
run-token scope are 0049_market's (owner decision h7-web-results-owner, 2026-10-24). The
``web_searches_per_month`` setting needs no schema: its default lives in
``oracle.tenant_settings_api.DEFAULTS``.

Live-safe: one new table.

The downgrade drops the table and any stored ``web_searches_per_month`` setting.

Revision ID: 0050_web_tools
Revises: 0049_market
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy import text

revision: str = "0050_web_tools"
down_revision: str | None = "0049_market"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.create_table(
        "web_searches",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("run_id", sa.Uuid(), nullable=False),
        sa.Column("query", sa.Text(), nullable=False),
        sa.Column("results", sa.Integer(), nullable=False),
        sa.Column(
            "searched_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_web_searches_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["run_id"], ["runs.id"], name=op.f("fk_web_searches_run_id_runs"), ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_web_searches")),
    )
    op.create_index(op.f("ix_web_searches_tenant_id"), "web_searches", ["tenant_id"])
    op.create_index(op.f("ix_web_searches_run_id"), "web_searches", ["run_id"])
    op.create_index("ix_web_searches_month", "web_searches", ["tenant_id", "searched_at"])


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.get_bind().execute(text("DELETE FROM tenant_settings WHERE key = 'web_searches_per_month'"))
    op.drop_table("web_searches")
