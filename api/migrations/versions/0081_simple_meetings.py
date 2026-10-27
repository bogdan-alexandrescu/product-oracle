"""Simple S8 (#723): review meetings and their decisions.

- ``simple_meetings``: one review meeting of a PRD (oracle.simple.meetings): its titled
  session, attendees, the presenter's change mode, its length, minutes and delivery.
- ``simple_meeting_decisions``: each decision taken in a meeting and the changes it made.
- ``meeting`` joins the ``decisions`` origins and ``meeting_minutes`` the ``llm_jobs``
  kinds (widened through oracle.migration_checks).

The downgrade deletes the meeting decisions and minutes jobs and drops the tables.

Revision ID: 0081_simple_meetings
Revises: 0080_simple_one_pagers
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

from oracle.migration_checks import add_check_values, remove_check_values

revision: str = "0081_simple_meetings"
down_revision: str | None = "0080_simple_one_pagers"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"
KIND_CHECK = ("llm_jobs", "ck_llm_jobs_kind", "kind")
ORIGIN_CHECK = ("decisions", "ck_decisions_origin", "origin")


def _base(t: str) -> list:
    return [
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f(f"fk_{t}_tenant_id_tenants"),
            ondelete="CASCADE",
        ),  # fmt: skip
        sa.PrimaryKeyConstraint("id", name=op.f(f"pk_{t}")),
    ]


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    t = "simple_meetings"
    uuids = postgresql.ARRAY(sa.Uuid())
    op.create_table(
        t,
        *_base(t),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("prd_document_id", sa.Uuid(), nullable=False),
        sa.Column("origin", sa.Text(), nullable=False),
        sa.Column("occurrence_id", sa.Uuid(), nullable=True),
        sa.Column("session_id", sa.Uuid(), nullable=False),
        sa.Column("presenter_id", sa.Uuid(), nullable=False),
        sa.Column("attendee_ids", uuids, server_default="{}", nullable=False),
        sa.Column("absent_ids", uuids, server_default="{}", nullable=False),
        sa.Column("change_mode", sa.Text(), server_default="everyone", nullable=False),
        sa.Column("change_people", uuids, server_default="{}", nullable=False),
        sa.Column("length_min", sa.Integer(), server_default="60", nullable=False),
        sa.Column("status", sa.Text(), server_default="live", nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("ended_by", sa.Uuid(), nullable=True),
        sa.Column("minutes", postgresql.JSONB(), nullable=True),
        sa.Column("minutes_state", sa.Text(), nullable=True),
        sa.Column("minutes_job_id", sa.Uuid(), nullable=True),
        sa.Column("delivery", postgresql.JSONB(), nullable=True),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "origin IN ('one_pager', 'roadmap', 'ritual')", name=op.f("ck_simple_meetings_origin")
        ),
        sa.CheckConstraint("status IN ('live', 'ended')", name=op.f("ck_simple_meetings_status")),
        sa.CheckConstraint(
            "change_mode IN ('everyone', 'presenter', 'named')",
            name=op.f("ck_simple_meetings_change_mode"),
        ),
        sa.CheckConstraint(
            "minutes_state IS NULL OR minutes_state IN ('drafting', 'ready', 'sent')",
            name=op.f("ck_simple_meetings_minutes_state"),
        ),
        sa.CheckConstraint(
            "length_min BETWEEN 5 AND 240", name=op.f("ck_simple_meetings_length_min")
        ),
        sa.ForeignKeyConstraint(
            ["prd_document_id"],
            ["documents.id"],
            name=op.f("fk_simple_meetings_prd_document_id_documents"),
            ondelete="CASCADE",
        ),  # fmt: skip
        sa.ForeignKeyConstraint(
            ["occurrence_id"],
            ["ritual_occurrences.id"],
            name=op.f("fk_simple_meetings_occurrence_id_ritual_occurrences"),
            ondelete="SET NULL",
        ),  # fmt: skip
        sa.ForeignKeyConstraint(
            ["session_id"],
            ["simple_sessions.id"],
            name=op.f("fk_simple_meetings_session_id_simple_sessions"),
            ondelete="CASCADE",
        ),  # fmt: skip
        sa.UniqueConstraint("session_id", name=op.f("uq_simple_meetings_session_id")),
    )
    op.create_index(op.f("ix_simple_meetings_tenant_id"), t, ["tenant_id"])
    op.create_index(op.f("ix_simple_meetings_prd_document_id"), t, ["prd_document_id"])
    op.create_index("ix_simple_meetings_started", t, ["started_at"])

    t = "simple_meeting_decisions"
    op.create_table(
        t,
        *_base(t),
        sa.Column("meeting_id", sa.Uuid(), nullable=False),
        sa.Column("decision_id", sa.Uuid(), nullable=False),
        sa.Column("change_ids", uuids, server_default="{}", nullable=False),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["meeting_id"],
            ["simple_meetings.id"],
            name=op.f("fk_simple_meeting_decisions_meeting_id_simple_meetings"),
            ondelete="CASCADE",
        ),  # fmt: skip
        sa.ForeignKeyConstraint(
            ["decision_id"],
            ["decisions.id"],
            name=op.f("fk_simple_meeting_decisions_decision_id_decisions"),
            ondelete="CASCADE",
        ),  # fmt: skip
        sa.UniqueConstraint("decision_id", name=op.f("uq_simple_meeting_decisions_decision_id")),
    )
    op.create_index(op.f("ix_simple_meeting_decisions_tenant_id"), t, ["tenant_id"])
    op.create_index(op.f("ix_simple_meeting_decisions_meeting_id"), t, ["meeting_id"])
    add_check_values(*KIND_CHECK, ("meeting_minutes",))
    add_check_values(*ORIGIN_CHECK, ("meeting",))


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.execute("DELETE FROM llm_jobs WHERE kind = 'meeting_minutes'")
    op.execute("DELETE FROM decisions WHERE origin = 'meeting'")
    remove_check_values(*ORIGIN_CHECK, ("meeting",))
    remove_check_values(*KIND_CHECK, ("meeting_minutes",))
    op.drop_table("simple_meeting_decisions")
    op.drop_table("simple_meetings")
