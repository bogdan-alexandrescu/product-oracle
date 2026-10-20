"""Specs: engineering specs as a document kind, and the prd_to_spec flow (wave 2, v2-specs)

Additive. Two check constraints widen:

- ``documents.kind`` accepts ``spec``: a technical brief or a full engineering spec is an
  Oracle document (brief and full layers, versions, review), built from an approved PRD.
- ``runs.flow`` accepts ``prd_to_spec``: the code-defined flow that writes it, with its
  flows and wireframes.

Everything else the lane stores uses the foundation's tables (``artifact_requests``,
``artifact_versions``, ``artifact_outputs``, ``artifact_review_events``,
``artifact_dependencies``). The ``eng_review`` checkpoint kind already exists (E1).

Each constraint is widened from its CURRENT definition in the database (read from
``pg_constraint``), never rebuilt from a fixed list, so values other lanes added before
this revision survive it. The downgrade deletes spec documents and prd_to_spec runs (the
old schema cannot hold them), then removes the one value again the same way.

Revision ID: 0015_specs
Revises: 0014_blockers_snapshot
"""

import re
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0015_specs"
down_revision: str | None = "0014_blockers_snapshot"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _values(table: str, name: str) -> list[str]:
    """The quoted values the live check constraint ``name`` on ``table`` accepts."""
    definition = (
        op.get_bind()
        .execute(
            sa.text(
                "SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c "
                "JOIN pg_class t ON t.oid = c.conrelid "
                "WHERE t.relname = :table AND c.conname = :name AND c.contype = 'c'"
            ),
            {"table": table, "name": name},
        )
        .scalar_one()
    )
    return re.findall(r"'((?:[^']|'')*)'", definition)


def _set(table: str, name: str, column: str, values: list[str]) -> None:
    op.drop_constraint(op.f(name), table, type_="check")
    listed = ", ".join("'" + v + "'" for v in values)
    op.execute(sa.text(f"ALTER TABLE {table} ADD CONSTRAINT {name} CHECK ({column} IN ({listed}))"))


def _widen(table: str, name: str, column: str, value: str) -> None:
    current = _values(table, name)
    if value not in current:
        _set(table, name, column, [*current, value])


def _narrow(table: str, name: str, column: str, value: str) -> None:
    current = _values(table, name)
    if value in current:
        _set(table, name, column, [v for v in current if v != value])


def upgrade() -> None:
    _widen("documents", "ck_documents_kind", "kind", "spec")
    _widen("runs", "ck_runs_flow", "flow", "prd_to_spec")


def downgrade() -> None:
    op.execute("DELETE FROM runs WHERE flow = 'prd_to_spec'")
    op.execute("DELETE FROM documents WHERE kind = 'spec'")
    _narrow("runs", "ck_runs_flow", "flow", "prd_to_spec")
    _narrow("documents", "ck_documents_kind", "kind", "spec")
