"""Questions to people (C2): every open question reaches a named person

A question in ``stakeholder_questions`` is about an intake, a document (section), a run
checkpoint item (``checkpoint_id`` + ``item_ref``) or a baseline entity (``entity_id``);
the ``ck_stakeholder_questions_subject`` check says it is about one of them. ``general``
joins the question categories (a person's question to a teammate; gaps keep their 17,
added with :func:`oracle.migration_checks.add_check_values` so another lane's values
stay). ``ix_stakeholder_questions_asked_to`` serves the Inbox read (asked of me, by
status). Data: asked or delegated questions with no person go to their intake's author.

The subject check holds for existing rows (the intake engine always sets ``intake_id``);
a row with neither an intake nor a document takes them from its gap, and the upgrade
refuses, naming the count, if any is still about nothing.

Live-safe: the API runs ``alembic upgrade head`` at container start. Nullable columns are
catalog-only; the foreign keys, the checks and the index take short locks on
``stakeholder_questions`` (a small table) and the referenced tables. A lock that cannot
be had within a few seconds fails the migration instead of queueing every reader behind
it, and the next start tries again.

The downgrade drops the three columns, the subject check and the index and restores the
17-category check; it refuses while ``general`` questions exist (withdraw and delete
them first). The data move is not undone: it only filled an empty field.

Revision ID: 0020_question_subjects
Revises: 0014_member_follow_up_retry
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

from oracle.migration_checks import add_check_values, remove_check_values

revision: str = "0020_question_subjects"
down_revision: str | None = "0014_member_follow_up_retry"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "stakeholder_questions"
CATEGORY = "ck_stakeholder_questions_category"
SUBJECT = "ck_stakeholder_questions_subject"
LOCK_TIMEOUT = "5s"


def _lock_timeout(value: str) -> str:
    """Set this transaction's lock wait; returns the one it replaces."""
    bind = op.get_bind()
    before = bind.scalar(sa.text("SELECT current_setting('lock_timeout')"))
    bind.execute(sa.text("SELECT set_config('lock_timeout', :t, true)"), {"t": value})
    return before


def upgrade() -> None:
    before = _lock_timeout(LOCK_TIMEOUT)
    bind = op.get_bind()
    op.add_column(TABLE, sa.Column("checkpoint_id", sa.Uuid(), nullable=True))
    op.add_column(TABLE, sa.Column("item_ref", sa.Text(), nullable=True))
    op.add_column(TABLE, sa.Column("entity_id", sa.Uuid(), nullable=True))
    for column, target in (("checkpoint_id", "checkpoints"), ("entity_id", "entities")):
        op.create_foreign_key(
            op.f(f"fk_{TABLE}_{column}_{target}"), TABLE, target, [column], ["id"],
            ondelete="CASCADE",
        )  # fmt: skip
        op.create_index(op.f(f"ix_{TABLE}_{column}"), TABLE, [column], unique=False)
    op.create_index(op.f(f"ix_{TABLE}_asked_to"), TABLE, ["asked_to", "status"], unique=False)
    add_check_values(TABLE, CATEGORY, "category", ("general",))

    # A question about nothing takes its gap's intake and document.
    bind.execute(
        sa.text(
            f"UPDATE {TABLE} q SET intake_id = g.intake_id, document_id = g.document_id "
            "FROM knowledge_gaps g WHERE q.gap_id = g.id "
            "AND q.intake_id IS NULL AND q.document_id IS NULL"
        )
    )
    orphans = bind.scalar(
        sa.text(f"SELECT count(*) FROM {TABLE} WHERE intake_id IS NULL AND document_id IS NULL")
    )
    if orphans:
        raise RuntimeError(
            f"{orphans} question(s) are about no intake and no document; link or delete "
            "them before this upgrade"
        )
    op.create_check_constraint(
        op.f(SUBJECT),
        TABLE,
        "intake_id IS NOT NULL OR document_id IS NOT NULL "
        "OR checkpoint_id IS NOT NULL OR entity_id IS NOT NULL",
    )

    # Every asked question has a person: one asked of nobody goes to its intake's author.
    bind.execute(
        sa.text(
            f"UPDATE {TABLE} q SET asked_to = i.author_id FROM product_intakes i "
            "WHERE q.intake_id = i.id AND q.status IN ('asked', 'delegated') "
            "AND q.asked_to IS NULL"
        )
    )
    _lock_timeout(before)


def downgrade() -> None:
    bind = op.get_bind()
    general = bind.scalar(sa.text(f"SELECT count(*) FROM {TABLE} WHERE category = 'general'"))
    if general:
        raise RuntimeError(
            f"{general} general question(s) exist; the 17-category check cannot hold them. "
            "Withdraw and delete them first"
        )
    before = _lock_timeout(LOCK_TIMEOUT)
    op.drop_constraint(op.f(SUBJECT), TABLE, type_="check")
    remove_check_values(TABLE, CATEGORY, "category", ("general",))
    op.drop_index(op.f(f"ix_{TABLE}_asked_to"), table_name=TABLE)
    for column, target in (("checkpoint_id", "checkpoints"), ("entity_id", "entities")):
        op.drop_index(op.f(f"ix_{TABLE}_{column}"), table_name=TABLE)
        op.drop_constraint(op.f(f"fk_{TABLE}_{column}_{target}"), TABLE, type_="foreignkey")
        op.drop_column(TABLE, column)
    op.drop_column(TABLE, "item_ref")
    _lock_timeout(before)
