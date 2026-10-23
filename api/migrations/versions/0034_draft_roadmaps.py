"""An items-only roadmap for every PRD draft (E1 Roadmap per PRD draft)

Additive. ``draft_roadmaps`` records one PRD version's derivation (queued, running,
ready, ...); ``roadmap_items`` rows may belong to one instead of a roadmap version
(``draft_roadmap_id``; exactly one owner, ``ck_roadmap_items_one_owner``), so the two
roadmap columns become nullable. ``documents.draft_roadmap_auto`` is a PRD's "Derive for
each new draft" switch, on by default. ``ck_runs_flow`` also allows ``prd_draft_items``,
extended with the additive helpers (oracle.migration_checks) so other lanes' flows
survive.

Live-safe: every existing item has its roadmap version, so the check is added NOT VALID
and validated without blocking writes; dropping NOT NULL and adding a nullable column
take a short lock, whose wait is capped (LOCK_TIMEOUT).

The downgrade deletes draft items and the runs of the new flow (their segments and
checkpoints cascade): draft items are lost; roadmap versions' items are untouched.

Revision ID: 0034_draft_roadmaps
Revises: 0033_question_retired
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

from oracle.migration_checks import add_check_values, remove_check_values

revision: str = "0034_draft_roadmaps"
down_revision: str | None = "0033_question_retired"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"
TABLE = "draft_roadmaps"
ITEMS = "roadmap_items"
FLOW_CHECK = ("runs", "ck_runs_flow", "flow")
FLOWS = ("prd_draft_items",)
# Frozen here as of this revision (oracle.roadmap.models).
STATUSES = ("queued", "running", "ready", "failed", "superseded", "off", "skipped")
DEPTHS = ("quick", "standard", "deep")
VIA = ("new_draft", "derive")
ONE_OWNER = "(roadmap_version_id IS NULL) <> (draft_roadmap_id IS NULL)"


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


def _now() -> sa.Column:
    return sa.text("now()")


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.create_table(
        TABLE,
        sa.Column("prd_document_id", sa.Uuid(), nullable=False),
        sa.Column("prd_version_id", sa.Uuid(), nullable=False),
        sa.Column("status", sa.Text(), server_default="queued", nullable=False),
        sa.Column("run_id", sa.Uuid(), nullable=True),
        sa.Column("requested_by", sa.Uuid(), nullable=True),
        sa.Column("requested_via", sa.Text(), server_default="new_draft", nullable=False),
        sa.Column("depth", sa.Text(), server_default="standard", nullable=False),
        sa.Column("items_check", JSONB(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("ready_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=_now(), nullable=False),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=_now(), nullable=False),
        sa.CheckConstraint(_in("status", STATUSES), name=op.f(f"ck_{TABLE}_status")),
        sa.CheckConstraint(_in("depth", DEPTHS), name=op.f(f"ck_{TABLE}_depth")),
        sa.CheckConstraint(_in("requested_via", VIA), name=op.f(f"ck_{TABLE}_via")),
        sa.ForeignKeyConstraint(
            ["prd_document_id"],
            ["documents.id"],
            name=op.f(f"fk_{TABLE}_prd_document_id_documents"),
            ondelete="CASCADE",
        ),  # fmt: skip
        sa.ForeignKeyConstraint(
            ["prd_version_id"],
            ["document_versions.id"],
            name=op.f(f"fk_{TABLE}_prd_version_id_document_versions"),
            ondelete="CASCADE",
        ),  # fmt: skip
        sa.ForeignKeyConstraint(
            ["run_id"], ["runs.id"], name=op.f(f"fk_{TABLE}_run_id_runs"), ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f(f"fk_{TABLE}_tenant_id_tenants"),
            ondelete="CASCADE",
        ),  # fmt: skip
        sa.PrimaryKeyConstraint("id", name=op.f(f"pk_{TABLE}")),
        sa.UniqueConstraint("prd_version_id", name=op.f(f"uq_{TABLE}_prd_version_id")),
    )
    op.create_index(op.f(f"ix_{TABLE}_tenant_id"), TABLE, ["tenant_id"])
    op.create_index(
        "ix_draft_roadmaps_prd_status", TABLE, ["tenant_id", "prd_document_id", "status"]
    )

    op.alter_column(ITEMS, "roadmap_document_id", nullable=True)
    op.alter_column(ITEMS, "roadmap_version_id", nullable=True)
    op.add_column(ITEMS, sa.Column("draft_roadmap_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        op.f(f"fk_{ITEMS}_draft_roadmap_id_draft_roadmaps"), ITEMS, TABLE,
        ["draft_roadmap_id"], ["id"], ondelete="CASCADE",
    )  # fmt: skip
    op.execute(
        f"ALTER TABLE {ITEMS} ADD CONSTRAINT ck_{ITEMS}_one_owner CHECK ({ONE_OWNER}) NOT VALID"
    )
    op.execute(f"ALTER TABLE {ITEMS} VALIDATE CONSTRAINT ck_{ITEMS}_one_owner")
    op.create_index(
        "uq_roadmap_items_draft_key",
        ITEMS,
        ["draft_roadmap_id", "item_key"],
        unique=True,
        postgresql_where=sa.text("draft_roadmap_id IS NOT NULL"),
    )

    op.add_column(
        "documents",
        sa.Column("draft_roadmap_auto", sa.Boolean(), server_default=sa.true(), nullable=False),
    )
    add_check_values(*FLOW_CHECK, FLOWS)


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.execute(f"DELETE FROM {ITEMS} WHERE draft_roadmap_id IS NOT NULL")
    op.drop_index("uq_roadmap_items_draft_key", table_name=ITEMS)
    op.drop_constraint(op.f(f"ck_{ITEMS}_one_owner"), ITEMS, type_="check")
    op.drop_constraint(
        op.f(f"fk_{ITEMS}_draft_roadmap_id_draft_roadmaps"), ITEMS, type_="foreignkey"
    )
    op.drop_column(ITEMS, "draft_roadmap_id")
    op.alter_column(ITEMS, "roadmap_version_id", nullable=False)
    op.alter_column(ITEMS, "roadmap_document_id", nullable=False)
    op.drop_index("ix_draft_roadmaps_prd_status", table_name=TABLE)
    op.drop_index(op.f(f"ix_{TABLE}_tenant_id"), table_name=TABLE)
    op.drop_table(TABLE)
    op.execute("DELETE FROM runs WHERE flow = 'prd_draft_items'")
    remove_check_values(*FLOW_CHECK, FLOWS)
    op.drop_column("documents", "draft_roadmap_auto")
