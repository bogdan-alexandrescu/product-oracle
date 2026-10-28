"""Simple chat-reader (#723): free-form chat lines read in context.

- ``simple_chat_reads``: Oracle's reply to one chat line while and after its reader reads
  it (the ``chat_reader`` job), and a clarify question's choices (oracle.simple.chat).
- ``chat_reader`` joins the ``llm_jobs`` kinds (widened through oracle.migration_checks).

The downgrade drops the table and the kind (and its jobs).

Revision ID: 0087_simple_chat_reads
Revises: 0086_simple_meetings
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

from oracle.migration_checks import add_check_values, remove_check_values

revision: str = "0087_simple_chat_reads"
down_revision: str | None = "0086_simple_meetings"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"
KIND_CHECK = ("llm_jobs", "ck_llm_jobs_kind", "kind")
# A chat_reader job's subject is its simple_chat_reads row (``input.read_id``).
SUBJECT_BEFORE = (
    "document_id IS NOT NULL OR intake_id IS NOT NULL OR decision_id IS NOT NULL "
    "OR interview_id IS NOT NULL OR scope_id IS NOT NULL OR request_id IS NOT NULL "
    "OR visual_id IS NOT NULL"
)
SUBJECT_AFTER = f"{SUBJECT_BEFORE} OR kind = 'chat_reader'"
T = "simple_chat_reads"


def _fk(col: str, table: str, ondelete: str) -> sa.ForeignKeyConstraint:
    return sa.ForeignKeyConstraint(
        [col], [f"{table}.id"], name=op.f(f"fk_{T}_{col}_{table}"), ondelete=ondelete
    )


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.create_table(
        T,
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("discussion_id", sa.Uuid(), nullable=False),
        sa.Column("message_id", sa.Uuid(), nullable=False),
        sa.Column("ask_id", sa.Uuid(), nullable=True),
        sa.Column("meeting_id", sa.Uuid(), nullable=True),
        sa.Column("by", sa.Uuid(), nullable=False),
        sa.Column("line", sa.Text(), nullable=False),
        sa.Column("page", sa.Text(), nullable=True),
        sa.Column("ask_box", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("job_id", sa.Uuid(), nullable=True),
        sa.Column("choices", postgresql.JSONB(), server_default="[]", nullable=False),
        sa.Column("picked", sa.Integer(), nullable=True),
        _fk("tenant_id", "tenants", "CASCADE"),
        _fk("discussion_id", "discussions", "CASCADE"),
        sa.ForeignKeyConstraint(["message_id"], ["discussion_messages.id"],
                                name=op.f(f"fk_{T}_message_id_discussion_messages"),
                                ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["ask_id"], ["discussion_messages.id"],
                                name=op.f(f"fk_{T}_ask_id_discussion_messages"),
                                ondelete="CASCADE"),
        _fk("job_id", "llm_jobs", "SET NULL"),
        sa.PrimaryKeyConstraint("id", name=op.f(f"pk_{T}")),
        sa.UniqueConstraint("message_id", name=op.f(f"uq_{T}_message_id")),
    )  # fmt: skip
    op.create_index(op.f(f"ix_{T}_tenant_id"), T, ["tenant_id"])
    op.create_index(op.f(f"ix_{T}_discussion_id"), T, ["discussion_id"])
    add_check_values(*KIND_CHECK, ("chat_reader",))
    op.drop_constraint(op.f("ck_llm_jobs_subject"), "llm_jobs", type_="check")
    op.create_check_constraint(op.f("ck_llm_jobs_subject"), "llm_jobs", SUBJECT_AFTER)


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.execute("DELETE FROM llm_jobs WHERE kind = 'chat_reader'")
    op.drop_table(T)
    op.drop_constraint(op.f("ck_llm_jobs_subject"), "llm_jobs", type_="check")
    op.create_check_constraint(op.f("ck_llm_jobs_subject"), "llm_jobs", SUBJECT_BEFORE)
    remove_check_values(*KIND_CHECK, ("chat_reader",))
