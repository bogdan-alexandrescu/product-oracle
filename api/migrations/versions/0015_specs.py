"""Specs: engineering specs as a document kind, and the prd_to_spec flow (wave 2, v2-specs)

Additive. Two check constraints widen:

- ``documents.kind`` accepts ``spec``: a technical brief or a full engineering spec is an
  Oracle document (brief and full layers, versions, review), built from an approved PRD.
- ``runs.flow`` accepts ``prd_to_spec``: the code-defined flow that writes it, with its
  flows and wireframes.

Everything else the lane stores uses the foundation's tables (``artifact_requests``,
``artifact_versions``, ``artifact_outputs``, ``artifact_review_events``,
``artifact_dependencies``). The ``eng_review`` checkpoint kind already exists (E1).

The downgrade deletes spec documents and prd_to_spec runs (the old schema cannot hold
them), then restores the constraints.

Revision ID: 0015_specs
Revises: 0014_trace
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0015_specs"
down_revision: str | None = "0014_trace"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

OLD_KINDS = "kind IN ('prd', 'roadmap')"
NEW_KINDS = "kind IN ('prd', 'roadmap', 'spec')"
OLD_FLOWS = "flow IN ('baseline_to_prd', 'feedback_loop', 'prd_to_roadmap')"
NEW_FLOWS = "flow IN ('baseline_to_prd', 'feedback_loop', 'prd_to_roadmap', 'prd_to_spec')"


def upgrade() -> None:
    op.drop_constraint(op.f("ck_documents_kind"), "documents", type_="check")
    op.create_check_constraint(op.f("ck_documents_kind"), "documents", NEW_KINDS)
    op.drop_constraint(op.f("ck_runs_flow"), "runs", type_="check")
    op.create_check_constraint(op.f("ck_runs_flow"), "runs", NEW_FLOWS)


def downgrade() -> None:
    op.execute("DELETE FROM runs WHERE flow = 'prd_to_spec'")
    op.execute("DELETE FROM documents WHERE kind = 'spec'")
    op.drop_constraint(op.f("ck_runs_flow"), "runs", type_="check")
    op.create_check_constraint(op.f("ck_runs_flow"), "runs", OLD_FLOWS)
    op.drop_constraint(op.f("ck_documents_kind"), "documents", type_="check")
    op.create_check_constraint(op.f("ck_documents_kind"), "documents", OLD_KINDS)
