"""C7 Scope review

``prd_scope_items`` gains ``original``: the agent's values of a row, for Undo and History
(``{}`` for a row a person added). ``llm_jobs`` gains ``scope_id`` and the
``scope_enhance`` kind (Enhance on a requirement), with a PRD scope as a job's fifth
possible subject. The kind is added to the check as it is now
(oracle.migration_checks), so values other lanes add to it survive.

Live-safe: adding a nullable column and one with a constant default takes a short lock;
the wait for it is capped (LOCK_TIMEOUT).

The downgrade deletes the ``scope_enhance`` jobs, then drops the column and restores the
checks.

Revision ID: 0048_scope_review
Revises: 0047_slack_bridge
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

from oracle.migration_checks import add_check_values, remove_check_values

revision: str = "0048_scope_review"
down_revision: str | None = "0047_slack_bridge"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"
KIND_CHECK = ("llm_jobs", "ck_llm_jobs_kind", "kind")
KINDS = ("scope_enhance",)
SUBJECT_BEFORE = (
    "document_id IS NOT NULL OR intake_id IS NOT NULL OR decision_id IS NOT NULL "
    "OR interview_id IS NOT NULL"
)
SUBJECT_AFTER = f"{SUBJECT_BEFORE} OR scope_id IS NOT NULL"


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.add_column(
        "prd_scope_items",
        sa.Column("original", JSONB(), nullable=False, server_default="{}"),
    )
    op.add_column("llm_jobs", sa.Column("scope_id", sa.Uuid(), nullable=True))
    op.create_index(op.f("ix_llm_jobs_scope_id"), "llm_jobs", ["scope_id"], unique=False)
    op.create_foreign_key(
        op.f("fk_llm_jobs_scope_id_prd_scopes"),
        "llm_jobs",
        "prd_scopes",
        ["scope_id"],
        ["id"],
        ondelete="CASCADE",
    )
    add_check_values(*KIND_CHECK, KINDS)
    op.drop_constraint(op.f("ck_llm_jobs_subject"), "llm_jobs", type_="check")
    op.create_check_constraint(op.f("ck_llm_jobs_subject"), "llm_jobs", SUBJECT_AFTER)


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.execute("DELETE FROM llm_jobs WHERE scope_id IS NOT NULL OR kind = 'scope_enhance'")
    op.drop_constraint(op.f("ck_llm_jobs_subject"), "llm_jobs", type_="check")
    op.create_check_constraint(op.f("ck_llm_jobs_subject"), "llm_jobs", SUBJECT_BEFORE)
    remove_check_values(*KIND_CHECK, KINDS)
    op.drop_constraint(op.f("fk_llm_jobs_scope_id_prd_scopes"), "llm_jobs", type_="foreignkey")
    op.drop_index(op.f("ix_llm_jobs_scope_id"), table_name="llm_jobs")
    op.drop_column("llm_jobs", "scope_id")
    op.drop_column("prd_scope_items", "original")
