"""Subgoals (#345): a goal's parent goal

``entities.parent_id``: the goal this one is a subgoal of (one level; the API refuses
cycles and a second level). Deleting a parent leaves its subgoals as goals (SET NULL); a
goal cannot be its own parent. Additive: no row changes.

The downgrade drops the column; every subgoal becomes a goal again.

Revision ID: 0041_subgoals
Revises: 0040_claude_account_identity
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0041_subgoals"
down_revision: str | None = "0040_claude_account_identity"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("entities", sa.Column("parent_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        op.f("fk_entities_parent_id_entities"),
        "entities",
        "entities",
        ["parent_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(op.f("ix_entities_parent_id"), "entities", ["parent_id"])
    op.create_check_constraint(
        op.f("ck_entities_not_own_parent"), "entities", "parent_id IS NULL OR parent_id <> id"
    )


def downgrade() -> None:
    op.drop_constraint(op.f("ck_entities_not_own_parent"), "entities", type_="check")
    op.drop_index(op.f("ix_entities_parent_id"), table_name="entities")
    op.drop_constraint(op.f("fk_entities_parent_id_entities"), "entities", type_="foreignkey")
    op.drop_column("entities", "parent_id")
