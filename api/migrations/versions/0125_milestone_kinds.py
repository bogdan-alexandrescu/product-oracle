"""Every roadmap milestone is one of six kinds, with a status (milestone-kinds, owner)

On ``track_milestones`` and ``roadmap_key_dates``:

- ``kind``: ``sub_goal`` | ``goal`` | ``delivery`` | ``decision`` | ``outside`` | ``handoff``
  (default ``delivery``);
- ``done_when_line``: the one "done when" line;
- ``status_set`` (``on_track`` | ``at_risk`` | ``hit`` | ``missed``), ``status_set_by`` and
  ``status_reason``: a person's override of the computed status, and why;
- ``measure``, ``baseline``, ``target``, ``current``: a measured (sub-)goal's numbers;
- ``sub_goal_of_id``: the measured-goal milestone a sub-goal builds toward;
- ``from_track_id``, ``to_track_id``: a hand-off's tracks.

On ``entities`` (the company goals): ``on_roadmap`` (default true), whether a goal with a target
date shows on the roadmap as a goal milestone.

Backfill: a goal's key-result milestone (``roadmap_id`` set, ``origin_prd_id`` null,
``goal_id`` set) becomes a ``sub_goal``; every other row stays ``delivery``. The downgrade
drops it all.

Revision ID: 0125_milestone_kinds
Revises: 0124_track_prds
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0125_milestone_kinds"
down_revision: str | None = "0124_track_prds"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"
TABLES = ("track_milestones", "roadmap_key_dates")
KINDS = ("sub_goal", "goal", "delivery", "decision", "outside", "handoff")
STATUSES = ("on_track", "at_risk", "hit", "missed")


def _in(col: str, values: tuple[str, ...]) -> str:
    return f"{col} IN ({', '.join(repr(v) for v in values)})"


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    for t in TABLES:
        op.add_column(t, sa.Column("kind", sa.Text(), nullable=False, server_default="delivery"))
        op.add_column(t, sa.Column("done_when_line", sa.Text(), nullable=False, server_default=""))
        op.add_column(t, sa.Column("status_set", sa.Text(), nullable=True))
        op.add_column(t, sa.Column("status_set_by", sa.Uuid(), nullable=True))
        op.add_column(t, sa.Column("status_reason", sa.Text(), nullable=True))
        op.add_column(t, sa.Column("measure", sa.Text(), nullable=True))
        for col in ("baseline", "target", "current"):
            op.add_column(t, sa.Column(col, sa.Numeric(20, 6), nullable=True))
        for col, to in (
            ("sub_goal_of_id", "track_milestones"),
            ("from_track_id", "product_tracks"),
            ("to_track_id", "product_tracks"),
        ):
            op.add_column(t, sa.Column(col, sa.Uuid(), nullable=True))
            op.create_foreign_key(
                op.f(f"fk_{t}_{col}_{to}"), t, to, [col], ["id"], ondelete="SET NULL"
            )
        op.create_check_constraint(op.f(f"ck_{t}_kind"), t, _in("kind", KINDS))
        op.create_check_constraint(
            op.f(f"ck_{t}_status_set"), t, "status_set IS NULL OR " + _in("status_set", STATUSES)
        )
    op.add_column(
        "entities",
        sa.Column("on_roadmap", sa.Boolean(), nullable=False, server_default=sa.true()),
    )
    op.execute(
        "UPDATE track_milestones SET kind = 'sub_goal' WHERE roadmap_id IS NOT NULL "
        "AND origin_prd_id IS NULL AND goal_id IS NOT NULL"
    )


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.drop_column("entities", "on_roadmap")
    for t in TABLES:
        for col in (
            "kind", "done_when_line", "status_set", "status_set_by", "status_reason", "measure",
            "baseline", "target", "current", "sub_goal_of_id", "from_track_id", "to_track_id",
        ):  # fmt: skip
            op.drop_column(t, col)  # drops its check constraint and foreign key
