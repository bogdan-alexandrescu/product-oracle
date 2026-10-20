"""Next draft from staged suggestions (C1e): llm_jobs.kind gains refinement_batch

Additive. The kind check is read from the database and extended (or, on downgrade,
shrunk) by one value, so kinds another lane added after 0013 are kept as they are; it
is never rebuilt from a fixed list. Staging itself needs no schema: a staged suggestion
is an accepted section-text suggestion with no ``applied_in_version`` yet, and the
Inbox's last visit is a user preference (``inbox_last_seen_at``).

The downgrade deletes the batch jobs (the old check would refuse them).

Revision ID: 0016_refinement_batch
Revises: 0016_roadmap
"""

import re
from collections.abc import Sequence

from alembic import op
from sqlalchemy import text

revision: str = "0016_refinement_batch"
down_revision: str | None = "0016_roadmap"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "llm_jobs"
CHECK = "ck_llm_jobs_kind"
KIND = "refinement_batch"


def _current_kinds() -> list[str]:
    definition = op.get_bind().scalar(
        text(
            "SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c "
            "JOIN pg_class t ON t.oid = c.conrelid "
            "WHERE t.relname = :table AND c.conname = :name"
        ),
        {"table": TABLE, "name": CHECK},
    )
    if definition is None:
        raise RuntimeError(f"{CHECK} is missing on {TABLE}")
    return re.findall(r"'((?:[^']|'')*)'", definition)


def _set_kinds(kinds: list[str]) -> None:
    values = ", ".join("'" + k.replace("'", "''") + "'" for k in kinds)
    op.drop_constraint(op.f(CHECK), TABLE, type_="check")
    op.create_check_constraint(op.f(CHECK), TABLE, f"kind IN ({values})")


def upgrade() -> None:
    kinds = _current_kinds()
    if KIND not in kinds:
        _set_kinds([*kinds, KIND])


def downgrade() -> None:
    op.execute(f"DELETE FROM {TABLE} WHERE kind = '{KIND}'")
    kinds = _current_kinds()
    if KIND in kinds:
        _set_kinds([k for k in kinds if k != KIND])
