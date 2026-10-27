"""Simple S2 (#723): roadmap dates, accepted risks, draft items and date suggestions

``roadmap_items`` gains its own ``start_date`` and ``end_date``, where they came from
(``date_source``: typed, accepted, engineering, tracker; null: none), the risks accepted on
its constraint flags (``accepted_risks``, ``[]``) and ``draft`` (an item added in Simple,
not yet confirmed). ``roadmap_date_suggestions``: Oracle's suggested dates for an undated
item (oracle.simple.suggestions), tenant-scoped like every table, at most one open per
item.

Live-safe: nullable columns and columns with constant defaults (no rewrite), one new table.

The downgrade drops the table, the columns (typed and accepted dates are lost) and the
internal ``simple_date_suggestions`` setting (the last day the suggestions ran).

Revision ID: 0076_simple_roadmap_dates
Revises: 0075_live_tokens
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0076_simple_roadmap_dates"
down_revision: str | None = "0075_live_tokens"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"
DATE_SOURCES = ("typed", "accepted", "engineering", "tracker")
STATUSES = ("open", "accepted", "edited", "dismissed")


def _in(column: str, values: Sequence[str]) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.add_column("roadmap_items", sa.Column("start_date", sa.Date(), nullable=True))
    op.add_column("roadmap_items", sa.Column("end_date", sa.Date(), nullable=True))
    op.add_column("roadmap_items", sa.Column("date_source", sa.Text(), nullable=True))
    op.add_column(
        "roadmap_items",
        sa.Column(
            "accepted_risks",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="[]",
            nullable=False,
        ),
    )
    op.add_column(
        "roadmap_items",
        sa.Column("draft", sa.Boolean(), server_default=sa.false(), nullable=False),
    )
    op.create_check_constraint(
        op.f("ck_roadmap_items_date_source"),
        "roadmap_items",
        f"date_source IS NULL OR {_in('date_source', DATE_SOURCES)}",
    )
    op.create_table(
        "roadmap_date_suggestions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("item_id", sa.Uuid(), nullable=False),
        sa.Column("start_date", sa.Date(), nullable=False),
        sa.Column("end_date", sa.Date(), nullable=False),
        sa.Column("basis", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), server_default="open", nullable=False),
        sa.Column("decided_by", sa.Uuid(), nullable=True),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            _in("status", STATUSES), name=op.f("ck_roadmap_date_suggestions_status")
        ),
        sa.CheckConstraint("end_date >= start_date", name=op.f("ck_roadmap_date_suggestions_span")),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_roadmap_date_suggestions_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["item_id"],
            ["roadmap_items.id"],
            name=op.f("fk_roadmap_date_suggestions_item_id_roadmap_items"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_roadmap_date_suggestions")),
    )
    op.create_index(
        op.f("ix_roadmap_date_suggestions_tenant_id"), "roadmap_date_suggestions", ["tenant_id"]
    )
    op.create_index(
        op.f("ix_roadmap_date_suggestions_item_id"), "roadmap_date_suggestions", ["item_id"]
    )
    op.create_index(
        "uq_roadmap_date_suggestions_open",
        "roadmap_date_suggestions",
        ["item_id"],
        unique=True,
        postgresql_where=sa.text("status = 'open'"),
    )


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.get_bind().execute(
        sa.text("DELETE FROM tenant_settings WHERE key = 'simple_date_suggestions'")
    )
    op.drop_table("roadmap_date_suggestions")
    op.drop_constraint(op.f("ck_roadmap_items_date_source"), "roadmap_items", type_="check")
    for column in ("draft", "accepted_risks", "date_source", "end_date", "start_date"):
        op.drop_column("roadmap_items", column)
