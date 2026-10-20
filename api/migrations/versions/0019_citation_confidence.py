"""A citation keeps what its writer computed (owner decision 2026-10-20, change D)

Adds to ``citations``: ``item_id`` (the source item the writer read; a foreign key, set
null when the item goes, and null on import when the company has no such item),
``confidence`` (0-1 or null), ``confidence_note`` (why there is no score, or how it was
reached) and ``low_confidence`` (false by default).

Additive. Live-safe: the API runs ``alembic upgrade head`` at container start. Nullable
columns and a constant default are catalog-only changes; the foreign key, the check and
the index take short locks on ``citations`` (and ``source_items`` for the key) and scan
columns that are all null. A lock that cannot be had within a few seconds fails the
migration instead of queueing every reader behind it, and the next start tries again.

The downgrade drops the four columns: what they held is lost, the citations are kept.


Revision ID: 0019_citation_confidence
Revises: 0018_runtime_features
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0019_citation_confidence"
down_revision: str | None = "0018_runtime_features"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "citations"
LOCK_TIMEOUT = "5s"


def _lock_timeout(value: str) -> str:
    """Set this transaction's lock wait; returns the one it replaces."""
    bind = op.get_bind()
    before = bind.scalar(sa.text("SELECT current_setting('lock_timeout')"))
    bind.execute(sa.text("SELECT set_config('lock_timeout', :t, true)"), {"t": value})
    return before


def upgrade() -> None:
    before = _lock_timeout(LOCK_TIMEOUT)
    op.add_column(TABLE, sa.Column("item_id", sa.Uuid(), nullable=True))
    op.add_column(TABLE, sa.Column("confidence", sa.Numeric(4, 3), nullable=True))
    op.add_column(TABLE, sa.Column("confidence_note", sa.Text(), nullable=True))
    op.add_column(
        TABLE,
        sa.Column("low_confidence", sa.Boolean(), server_default=sa.false(), nullable=False),
    )
    op.create_foreign_key(
        op.f("fk_citations_item_id_source_items"),
        TABLE,
        "source_items",
        ["item_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_check_constraint(
        op.f("ck_citations_confidence"),
        TABLE,
        "confidence IS NULL OR (confidence >= 0 AND confidence <= 1)",
    )
    op.create_index(op.f("ix_citations_item_id"), TABLE, ["item_id"])
    _lock_timeout(before)


def downgrade() -> None:
    before = _lock_timeout(LOCK_TIMEOUT)
    op.drop_index(op.f("ix_citations_item_id"), table_name=TABLE)
    op.drop_constraint(op.f("ck_citations_confidence"), TABLE, type_="check")
    op.drop_constraint(op.f("fk_citations_item_id_source_items"), TABLE, type_="foreignkey")
    for column in ("low_confidence", "confidence_note", "confidence", "item_id"):
        op.drop_column(TABLE, column)
    _lock_timeout(before)
