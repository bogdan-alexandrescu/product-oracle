"""Additive edits to a ``column IN (...)`` check constraint, for migrations.

Several lanes' migrations extend one check (``ck_change_events_subject_kind``). A
migration that drops and recreates it from a literal list removes whatever another lane
added. These helpers read the constraint's definition at upgrade time (pg_constraint) and
add, or at downgrade remove, only the migration's own values.
"""

import re

from alembic import op
from sqlalchemy import text

_VALUE = re.compile(r"'((?:[^']|'')*)'")


def check_values(table: str, constraint: str) -> list[str]:
    """The values a ``column IN (...)`` check constraint allows now, in its order."""
    definition = op.get_bind().scalar(
        text(
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
    # op.f: the name is final (the metadata's naming convention is not applied again).
    op.drop_constraint(op.f(constraint), table, type_="check")
    op.create_check_constraint(op.f(constraint), table, f"{column} IN ({listed})")


def add_check_values(table: str, constraint: str, column: str, values: tuple[str, ...]) -> None:
    """Allow ``values`` too, keeping every value the constraint already allows."""
    now = check_values(table, constraint)
    missing = [v for v in values if v not in now]
    if missing:
        _replace(table, constraint, column, now + missing)


def remove_check_values(table: str, constraint: str, column: str, values: tuple[str, ...]) -> None:
    """Stop allowing ``values`` only, keeping every other value the constraint allows."""
    now = check_values(table, constraint)
    kept = [v for v in now if v not in values]
    if kept != now:
        _replace(table, constraint, column, kept)
