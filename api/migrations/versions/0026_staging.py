"""G4 One staging list: discussions stage into D8's shared draft or the next draft

Additive. ``checkpoint_actions`` gains ``origin`` ('row' for every existing action,
``ck_checkpoint_actions_origin``), the discussion and discussion change an action came
from (SET NULL when they go) and ``from_private`` (false). ``next_draft_changes`` holds a
discussion's section change waiting for the document's next draft; one live (staged) row
per discussion change (``uq_next_draft_changes_change_live``).

Live-safe: a new table, nullable columns and columns with a constant default are
catalog-only changes; adding a check reads ``checkpoint_actions`` once (small).

The downgrade drops the table and the four columns: staged next-draft rows are lost, and
discussion-origin actions read as row actions.

Revision ID: 0026_staging
Revises: 0025_checkpoint_review
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0026_staging"
down_revision: str | None = "0025_checkpoint_review"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

ACTIONS = "checkpoint_actions"
TABLE = "next_draft_changes"
# Frozen here as of this revision (oracle.runs.models.ACTION_ORIGINS,
# oracle.staging.models.STATUSES).
ORIGINS = ("row", "discussion")
STATUSES = ("staged", "unstaged", "applied", "superseded")


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


def upgrade() -> None:
    op.add_column(ACTIONS, sa.Column("origin", sa.Text(), server_default="row", nullable=False))
    op.add_column(ACTIONS, sa.Column("discussion_id", sa.Uuid(), nullable=True))
    op.add_column(ACTIONS, sa.Column("discussion_change_id", sa.Uuid(), nullable=True))
    op.add_column(
        ACTIONS,
        sa.Column("from_private", sa.Boolean(), server_default=sa.false(), nullable=False),
    )
    op.create_check_constraint(op.f(f"ck_{ACTIONS}_origin"), ACTIONS, _in("origin", ORIGINS))
    op.create_foreign_key(
        op.f(f"fk_{ACTIONS}_discussion_id_discussions"), ACTIONS, "discussions",
        ["discussion_id"], ["id"], ondelete="SET NULL",
    )  # fmt: skip
    op.create_foreign_key(
        op.f(f"fk_{ACTIONS}_discussion_change_id_discussion_changes"), ACTIONS,
        "discussion_changes", ["discussion_change_id"], ["id"], ondelete="SET NULL",
    )  # fmt: skip
    op.create_table(
        TABLE,
        sa.Column("document_id", sa.Uuid(), nullable=False),
        sa.Column("section_key", sa.Text(), nullable=False),
        sa.Column("raised_on_version", sa.Integer(), nullable=False),
        sa.Column("instruction", sa.Text(), nullable=False),
        sa.Column("text", sa.Text(), nullable=True),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("discussion_id", sa.Uuid(), nullable=True),
        sa.Column("discussion_change_id", sa.Uuid(), nullable=True),
        sa.Column("from_private", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("staged_by", sa.Uuid(), nullable=False),
        sa.Column("suggested_by", sa.Uuid(), nullable=True),
        sa.Column("status", sa.Text(), server_default="staged", nullable=False),
        sa.Column("applied_in_version", sa.Integer(), nullable=True),
        sa.Column("unstaged_by", sa.Uuid(), nullable=True),
        sa.Column("unstaged_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),  # fmt: skip
        sa.Column("lock_version", sa.Integer(), server_default="1", nullable=False),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),  # fmt: skip
        sa.CheckConstraint(
            "char_length(instruction) <= 1000", name=op.f(f"ck_{TABLE}_instruction")
        ),
        sa.CheckConstraint(
            "text IS NULL OR char_length(text) <= 20000", name=op.f(f"ck_{TABLE}_text")
        ),
        sa.CheckConstraint(
            "reason IS NULL OR char_length(reason) <= 1000", name=op.f(f"ck_{TABLE}_reason")
        ),
        sa.CheckConstraint(_in("status", STATUSES), name=op.f(f"ck_{TABLE}_status")),
        sa.ForeignKeyConstraint(
            ["document_id"],
            ["documents.id"],
            name=op.f(f"fk_{TABLE}_document_id_documents"),
            ondelete="CASCADE",
        ),  # fmt: skip
        sa.ForeignKeyConstraint(
            ["discussion_id"],
            ["discussions.id"],
            name=op.f(f"fk_{TABLE}_discussion_id_discussions"),
            ondelete="SET NULL",
        ),  # fmt: skip
        sa.ForeignKeyConstraint(
            ["discussion_change_id"],
            ["discussion_changes.id"],
            name=op.f(f"fk_{TABLE}_discussion_change_id_discussion_changes"),
            ondelete="SET NULL",
        ),  # fmt: skip
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f(f"fk_{TABLE}_tenant_id_tenants"),
            ondelete="CASCADE",
        ),  # fmt: skip
        sa.PrimaryKeyConstraint("id", name=op.f(f"pk_{TABLE}")),
    )
    op.create_index(op.f(f"ix_{TABLE}_tenant_id"), TABLE, ["tenant_id"], unique=False)
    op.create_index("ix_next_draft_changes_document", TABLE, ["document_id", "status"])
    op.create_index(
        "uq_next_draft_changes_change_live",
        TABLE,
        ["discussion_change_id"],
        unique=True,
        postgresql_where=sa.text("status = 'staged'"),
    )


def downgrade() -> None:
    op.drop_index("uq_next_draft_changes_change_live", table_name=TABLE)
    op.drop_index("ix_next_draft_changes_document", table_name=TABLE)
    op.drop_index(op.f(f"ix_{TABLE}_tenant_id"), table_name=TABLE)
    op.drop_table(TABLE)
    op.drop_constraint(
        op.f(f"fk_{ACTIONS}_discussion_change_id_discussion_changes"), ACTIONS, type_="foreignkey"
    )
    op.drop_constraint(op.f(f"fk_{ACTIONS}_discussion_id_discussions"), ACTIONS, type_="foreignkey")
    op.drop_constraint(op.f(f"ck_{ACTIONS}_origin"), ACTIONS, type_="check")
    for column in ("from_private", "discussion_change_id", "discussion_id", "origin"):
        op.drop_column(ACTIONS, column)
