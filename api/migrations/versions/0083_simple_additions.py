"""Simple S7 (#723, D15): additions and goal suggestions.

- ``roadmap_items``: ``simple_draft_id`` (an item added in Simple lives in the roadmap's
  working draft, on no version, until the draft is submitted: ``ck_roadmap_items_one_owner``
  allows it), ``goal_ids`` (the goals it was dropped on or suggested for), ``merged_into``
  (the key of the item a draft was merged into) and ``kept_both`` (a person said it is not
  a duplicate).
- ``simple_goal_suggestions``: Oracle's suggested features per goal (open, accepted,
  rejected), and ``simple_goal_autos``: the goals Oracle suggested for once, automatically,
  when they had no items.
- ``item_draft`` and ``goal_suggestions`` join the ``llm_jobs`` kinds.

The downgrade deletes the added items, the two jobs' rows and the tables.

Revision ID: 0083_simple_additions
Revises: 0080_simple_one_pagers
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

from oracle.migration_checks import add_check_values, remove_check_values

revision: str = "0083_simple_additions"
down_revision: str | None = "0082_roadmap_key_dates"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"
KIND_CHECK = ("llm_jobs", "ck_llm_jobs_kind", "kind")
KINDS = ("item_draft", "goal_suggestions")
ITEMS = "roadmap_items"
ONE_OWNER = "(roadmap_version_id IS NULL) <> (draft_roadmap_id IS NULL)"
ONE_OWNER_S7 = (
    f"({ONE_OWNER}) OR (simple_draft_id IS NOT NULL AND roadmap_version_id IS NULL "
    "AND draft_roadmap_id IS NULL)"
)


def _tenant(t: str) -> list:
    return [
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f(f"fk_{t}_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f(f"pk_{t}")),
    ]


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.add_column(ITEMS, sa.Column("simple_draft_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        op.f(f"fk_{ITEMS}_simple_draft_id_simple_drafts"), ITEMS, "simple_drafts",
        ["simple_draft_id"], ["id"], ondelete="CASCADE",
    )  # fmt: skip
    op.create_index(op.f(f"ix_{ITEMS}_simple_draft_id"), ITEMS, ["simple_draft_id"])
    op.add_column(ITEMS, sa.Column("goal_ids", postgresql.ARRAY(sa.Uuid()),
                                   server_default="{}", nullable=False))  # fmt: skip
    op.add_column(ITEMS, sa.Column("merged_into", sa.Text(), nullable=True))
    op.add_column(ITEMS, sa.Column("kept_both", sa.Boolean(), server_default=sa.false(),
                                   nullable=False))  # fmt: skip
    op.execute(f"ALTER TABLE {ITEMS} DROP CONSTRAINT ck_{ITEMS}_one_owner")
    op.execute(f"ALTER TABLE {ITEMS} ADD CONSTRAINT ck_{ITEMS}_one_owner CHECK ({ONE_OWNER_S7})")

    t = "simple_goal_suggestions"
    op.create_table(
        t,
        *_tenant(t),
        sa.Column("goal_id", sa.Uuid(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("outcome", sa.Text(), nullable=True),
        sa.Column("why", sa.Text(), nullable=True),
        sa.Column("evidence", postgresql.JSONB(), server_default="[]", nullable=False),
        sa.Column("status", sa.Text(), server_default="open", nullable=False),
        sa.Column("origin", sa.Text(), server_default="on_demand", nullable=False),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("job_id", sa.Uuid(), nullable=True),
        sa.Column("change_id", sa.Uuid(), nullable=True),
        sa.Column("item_id", sa.Uuid(), nullable=True),
        sa.Column("decided_by", sa.Uuid(), nullable=True),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "status IN ('open', 'accepted', 'rejected')", name=op.f(f"ck_{t}_status")
        ),
        sa.CheckConstraint("origin IN ('auto', 'on_demand')", name=op.f(f"ck_{t}_origin")),
        sa.ForeignKeyConstraint(
            ["goal_id"],
            ["entities.id"],
            name=op.f(f"fk_{t}_goal_id_entities"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["job_id"],
            ["llm_jobs.id"],
            name=op.f(f"fk_{t}_job_id_llm_jobs"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["change_id"],
            ["simple_changes.id"],
            name=op.f(f"fk_{t}_change_id_simple_changes"),
            ondelete="SET NULL",
        ),
    )
    op.create_index(op.f(f"ix_{t}_tenant_id"), t, ["tenant_id"])
    op.create_index("ix_simple_goal_suggestions_goal_status", t, ["goal_id", "status"])

    t = "simple_goal_autos"
    op.create_table(
        t,
        *_tenant(t),
        sa.Column("goal_id", sa.Uuid(), nullable=False),
        sa.Column("job_id", sa.Uuid(), nullable=True),
        sa.ForeignKeyConstraint(
            ["goal_id"],
            ["entities.id"],
            name=op.f(f"fk_{t}_goal_id_entities"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["job_id"],
            ["llm_jobs.id"],
            name=op.f(f"fk_{t}_job_id_llm_jobs"),
            ondelete="SET NULL",
        ),
        sa.UniqueConstraint("goal_id", name=op.f(f"uq_{t}_goal_id")),
    )
    op.create_index(op.f(f"ix_{t}_tenant_id"), t, ["tenant_id"])
    add_check_values(*KIND_CHECK, KINDS)


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.execute("DELETE FROM llm_jobs WHERE kind IN ('item_draft', 'goal_suggestions')")
    remove_check_values(*KIND_CHECK, KINDS)
    op.drop_table("simple_goal_autos")
    op.drop_table("simple_goal_suggestions")
    op.execute(f"DELETE FROM {ITEMS} WHERE simple_draft_id IS NOT NULL")
    op.execute(f"ALTER TABLE {ITEMS} DROP CONSTRAINT ck_{ITEMS}_one_owner")
    op.execute(f"ALTER TABLE {ITEMS} ADD CONSTRAINT ck_{ITEMS}_one_owner CHECK ({ONE_OWNER})")
    op.drop_column(ITEMS, "kept_both")
    op.drop_column(ITEMS, "merged_into")
    op.drop_column(ITEMS, "goal_ids")
    op.drop_index(op.f(f"ix_{ITEMS}_simple_draft_id"), table_name=ITEMS)
    op.drop_constraint(op.f(f"fk_{ITEMS}_simple_draft_id_simple_drafts"), ITEMS)
    op.drop_column(ITEMS, "simple_draft_id")
