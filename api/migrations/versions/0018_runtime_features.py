"""Learned runtime feature states (UI test finding E3): runtime_features

What a submission or an answer taught Oracle about the agent runtime's features (caller
MCP, await-input, service answers), so a deploy or another Cloud Run instance knows it
too. One row per feature for the whole deployment (no tenant): the runtime is Oracle's.
``expires_at`` NULL is a sticky state, kept until the runtime reports the feature on.

Additive; the downgrade drops the table (each process then learns again at its first
submission, as before).

Revision ID: 0018_runtime_features
Revises: 0017_citation_source_oracle
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0018_runtime_features"
down_revision: str | None = "0017_citation_source_oracle"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "runtime_features",
        sa.Column("feature", sa.Text(), nullable=False),
        sa.Column("state", sa.Text(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False, server_default=""),
        sa.Column("learned_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "state IN ('on', 'off', 'unknown')", name=op.f("ck_runtime_features_state")
        ),
        sa.PrimaryKeyConstraint("feature", name=op.f("pk_runtime_features")),
    )


def downgrade() -> None:
    op.drop_table("runtime_features")
