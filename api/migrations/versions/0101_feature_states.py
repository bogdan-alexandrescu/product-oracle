"""Current state beside Desired state: each feature's place and its proof

``feature_states``: one row per feature (desired, marked as already shipped, or moved to
Current state by the owner), with the owner's Not yet and "still runs?" answer and when
its proof was last read. ``feature_proofs``: one row per feature and kind (code map, pull
requests, tasks, measured). The downgrade drops both tables.

Revision ID: 0101_feature_states
Revises: 0100_source_lost_connection
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0101_feature_states"
down_revision: str | None = "0100_source_lost_connection"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

S, P = "feature_states", "feature_proofs"


def _common(t: str) -> list:
    return [
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("feature_id", sa.Uuid(), nullable=False),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"],
                                name=op.f(f"fk_{t}_tenant_id_tenants"), ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["feature_id"], ["entities.id"],
                                name=op.f(f"fk_{t}_feature_id_entities"), ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name=op.f(f"pk_{t}")),
    ]  # fmt: skip


def upgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    ts = sa.DateTime(timezone=True)
    op.create_table(
        S,
        *_common(S),
        sa.Column("status", sa.Text(), server_default="desired", nullable=False),
        sa.Column("shipped_at", ts, nullable=True),
        sa.Column("moved_at", ts, nullable=True),
        sa.Column("moved_by", sa.Uuid(), nullable=True),
        sa.Column("move_note", sa.Text(), nullable=True),
        sa.Column("not_yet_at", ts, nullable=True),
        sa.Column("answer", sa.Text(), nullable=True),
        sa.Column("answered_at", ts, nullable=True),
        sa.Column("answered_by", sa.Uuid(), nullable=True),
        sa.Column("checked_at", ts, nullable=True),
        sa.Column("read_at", ts, nullable=True),
        sa.Column("checking", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.CheckConstraint("status IN ('desired', 'shipped', 'current')",
                           name=op.f(f"ck_{S}_status")),
        sa.CheckConstraint(
            "answer IS NULL OR answer IN ('still_runs', 'changed', 'no_longer_runs')",
            name=op.f(f"ck_{S}_answer")),
        sa.UniqueConstraint("tenant_id", "feature_id", name=op.f(f"uq_{S}_tenant_id_feature_id")),
    )  # fmt: skip
    op.create_index(op.f(f"ix_{S}_tenant_id"), S, ["tenant_id"])
    op.create_index(op.f(f"ix_{S}_feature_id"), S, ["feature_id"])
    op.create_table(
        P,
        *_common(P),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("count", sa.Integer(), nullable=True),
        sa.Column("total", sa.Integer(), nullable=True),
        sa.Column("value", sa.Text(), nullable=True),
        sa.Column("period", sa.Text(), nullable=True),
        sa.Column("ok", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("still_true", sa.Boolean(), nullable=True),
        sa.Column("checked_at", ts, nullable=True),
        sa.CheckConstraint("kind IN ('code_map', 'pull_requests', 'tasks', 'measured')",
                           name=op.f(f"ck_{P}_kind")),
        sa.UniqueConstraint("tenant_id", "feature_id", "kind",
                            name=op.f(f"uq_{P}_tenant_id_feature_id_kind")),
    )  # fmt: skip
    op.create_index(op.f(f"ix_{P}_tenant_id"), P, ["tenant_id"])
    op.create_index(op.f(f"ix_{P}_feature_id"), P, ["feature_id"])


def downgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.drop_table(P)
    op.drop_table(S)
