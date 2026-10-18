"""Roadmap from an approved PRD (O4b)

The ``prd_to_roadmap`` flow and its two checkpoints (``roadmap_items`` and
``roadmap_review``). ``document_versions.source_version_id`` records the PRD version a
roadmap version was built from (its provenance); deleting the PRD clears it.

Revision ID: 0011
Revises: 0010
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0011"
down_revision: str | None = "0010"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

OLD_FLOWS = "flow IN ('baseline_to_prd', 'feedback_loop')"
NEW_FLOWS = "flow IN ('baseline_to_prd', 'feedback_loop', 'prd_to_roadmap')"
OLD_KINDS = (
    "kind IN ('baseline_confirm', 'feature_set', 'priority_order', 'prd_review', 'eng_review')"
)
NEW_KINDS = (
    "kind IN ('baseline_confirm', 'feature_set', 'priority_order', 'prd_review', "
    "'eng_review', 'roadmap_items', 'roadmap_review')"
)


def upgrade() -> None:
    op.drop_constraint(op.f("ck_runs_flow"), "runs", type_="check")
    op.create_check_constraint(op.f("ck_runs_flow"), "runs", NEW_FLOWS)
    op.drop_constraint(op.f("ck_checkpoints_kind"), "checkpoints", type_="check")
    op.create_check_constraint(op.f("ck_checkpoints_kind"), "checkpoints", NEW_KINDS)
    op.add_column("document_versions", sa.Column("source_version_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        op.f("fk_document_versions_source_version_id_document_versions"),
        "document_versions",
        "document_versions",
        ["source_version_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        op.f("ix_document_versions_source_version_id"),
        "document_versions",
        ["source_version_id"],
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_document_versions_source_version_id"), "document_versions")
    op.drop_constraint(
        op.f("fk_document_versions_source_version_id_document_versions"),
        "document_versions",
        type_="foreignkey",
    )
    op.drop_column("document_versions", "source_version_id")
    op.execute("DELETE FROM checkpoints WHERE kind IN ('roadmap_items', 'roadmap_review')")
    op.execute("DELETE FROM runs WHERE flow = 'prd_to_roadmap'")
    op.drop_constraint(op.f("ck_checkpoints_kind"), "checkpoints", type_="check")
    op.create_check_constraint(op.f("ck_checkpoints_kind"), "checkpoints", OLD_KINDS)
    op.drop_constraint(op.f("ck_runs_flow"), "runs", type_="check")
    op.create_check_constraint(op.f("ck_runs_flow"), "runs", OLD_FLOWS)
