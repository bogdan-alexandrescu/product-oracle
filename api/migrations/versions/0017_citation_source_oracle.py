"""A draft cites Oracle's own baseline: citations.source gains 'oracle' (owner, 2026-10-20)

Additive. A run's writer cites the baseline's goals, decisions, constraints and features
as ``source: oracle`` (its ``ref`` is free text naming the item). The source check is read
from the database and extended by that one value, so sources another lane added are kept;
it is never rebuilt from a fixed list.

Live-safe: the API runs ``alembic upgrade head`` at container start. Swapping the check
takes a brief exclusive lock on ``citations`` and one scan of it (the rows already pass a
narrower check); a lock that cannot be had within a few seconds fails the migration
instead of queueing every reader of the table behind it, and the next start tries again.

The downgrade takes 'oracle' out again and refuses while any 'oracle' citation exists:
dropping those rows would silently lose what imported versions cite.

Revision ID: 0017_citation_source_oracle
Revises: 0016_refinement_batch
"""

import re
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0017_citation_source_oracle"
down_revision: str | None = "0016_refinement_batch"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "citations"
CHECK = "ck_citations_source"
COLUMN = "source"
SOURCE = "oracle"
LOCK_TIMEOUT = "5s"


# --- oracle.migration_checks, frozen here as of this revision ----------------------------
# A migration must not import application code that can change after it ships; this is
# that module's behaviour, copied.

_VALUE = re.compile(r"'((?:[^']|'')*)'")


def check_values(table: str, constraint: str) -> list[str]:
    """The values a ``column IN (...)`` check constraint allows now, in its order."""
    definition = op.get_bind().scalar(
        sa.text(
            "SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c "
            "JOIN pg_class t ON t.oid = c.conrelid "
            "WHERE c.conname = :name AND t.relname = :table AND c.contype = 'c'"
        ),
        {"name": constraint, "table": table},
    )
    if definition is None:
        raise RuntimeError(f"check constraint {constraint} on {table} not found")
    return [v.replace("''", "'") for v in _VALUE.findall(definition)]


def _replace(table: str, constraint: str, column: str, values: list[str]) -> None:
    listed = ", ".join("'" + v.replace("'", "''") + "'" for v in values)
    op.drop_constraint(op.f(constraint), table, type_="check")
    op.create_check_constraint(op.f(constraint), table, f"{column} IN ({listed})")


# ------------------------------------------------------------------------------------------


def _swap(values: list[str]) -> None:
    """Replace the check under a short lock wait, restoring the session's own after: the
    whole upgrade runs in one transaction, and later revisions keep their setting."""
    bind = op.get_bind()
    before = bind.scalar(sa.text("SELECT current_setting('lock_timeout')"))
    bind.execute(sa.text("SELECT set_config('lock_timeout', :t, true)"), {"t": LOCK_TIMEOUT})
    _replace(TABLE, CHECK, COLUMN, values)
    bind.execute(sa.text("SELECT set_config('lock_timeout', :t, true)"), {"t": before})


def upgrade() -> None:
    now = check_values(TABLE, CHECK)
    if SOURCE not in now:
        _swap([*now, SOURCE])


def downgrade() -> None:
    cited = op.get_bind().scalar(
        sa.text(f"SELECT count(*) FROM {TABLE} WHERE {COLUMN} = :s"), {"s": SOURCE}
    )
    if cited:
        raise RuntimeError(
            f"cannot downgrade below {revision}: {cited} citation(s) have source '{SOURCE}'; "
            "the narrower check would refuse them, and deleting them would lose what imported "
            "versions cite. Re-cite or remove them first."
        )
    now = check_values(TABLE, CHECK)
    if SOURCE in now:
        _swap([v for v in now if v != SOURCE])
