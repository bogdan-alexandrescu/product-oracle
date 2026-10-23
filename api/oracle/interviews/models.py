"""Interviews (C3, migration 0032_interviews).

- ``interviews``: one interview. A customer interview (lane 1) has the customer's name
  and company as given (unverified), what it is about (an intake, a request theme or a
  topic), the guide a member approved (``[{id, prompt, purpose}]``) and, once a member
  creates it, a private link: only the token's sha256 is kept (``link_token_hash``), and
  the first browser to open it is bound by the sha256 of its cookie (``session_hash``).
  ``position`` is the current guide question and ``followed_up`` whether Oracle has
  asked its one follow-up on it; ``turn_started_at`` claims the running turn and
  ``refusals``/``refusals_since`` count the refused requests audited this minute. A
  team interview (lane 2) belongs to an intake and the member answering.
- ``interview_messages``: the transcript, Oracle's messages with the model call's
  model, usage and cost.
"""

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    Text,
    Uuid,
    false,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from oracle.db import Base, TenantScoped
from oracle.docs.models import _in
from oracle.v2.models import _fk, _json, _lock_version, _updated_at

KINDS = ("team", "customer")
STATUSES = ("draft", "invited", "in_progress", "finished", "expired", "revoked")
ROLES = ("oracle", "interviewee")
MESSAGE_KINDS = ("intro", "question", "ack", "follow_up", "answer", "skip", "closing")


class Interview(TenantScoped, Base):
    __tablename__ = "interviews"
    __table_args__ = (
        CheckConstraint(_in("kind", KINDS), name="kind"),
        CheckConstraint(_in("status", STATUSES), name="status"),
        CheckConstraint(
            "kind <> 'team' OR (intake_id IS NOT NULL AND interviewee_user_id IS NOT NULL)",
            name="team",
        ),
        CheckConstraint("kind <> 'customer' OR interviewee_name IS NOT NULL", name="customer"),
        Index(
            "ux_interviews_team",
            "intake_id",
            "interviewee_user_id",
            unique=True,
            postgresql_where=text("kind = 'team'"),
        ),
    )

    kind: Mapped[str] = mapped_column(Text, nullable=False)
    intake_id: Mapped[uuid.UUID | None] = _fk("product_intakes", "SET NULL")
    theme_id: Mapped[uuid.UUID | None] = _fk("request_themes", "SET NULL")
    topic: Mapped[str | None] = mapped_column(Text)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    intro: Mapped[str | None] = mapped_column(Text)
    # [{id, prompt, purpose}], what a member approved.
    guide: Mapped[list[dict[str, Any]]] = _json("[]")
    guide_job_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("llm_jobs.id", ondelete="SET NULL", use_alter=True)
    )
    interviewee_user_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    interviewee_name: Mapped[str | None] = mapped_column(Text)
    interviewee_company: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(
        Text, nullable=False, default="draft", server_default="draft"
    )
    link_token_hash: Mapped[str | None] = mapped_column(Text, unique=True)
    link_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    link_opened_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    session_hash: Mapped[str | None] = mapped_column(Text)
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    followed_up: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=false()
    )
    customer_messages: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    # The running turn's claim (one turn per interview at a time, across API instances);
    # a claim older than the model call's deadline is from an instance that stopped.
    turn_started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Refused public requests audited in the window starting at ``refusals_since``.
    refusals_since: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    refusals: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    # InterviewSnapshot: quick_facts, quotes, needs, insights; {} until written.
    snapshot: Mapped[dict[str, Any]] = _json()
    snapshot_job_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("llm_jobs.id", ondelete="SET NULL", use_alter=True)
    )
    # User or API token id, no FK, as elsewhere.
    created_by: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = _updated_at()
    lock_version: Mapped[int] = _lock_version()
    __mapper_args__ = {"version_id_col": lock_version}


class InterviewMessage(TenantScoped, Base):
    __tablename__ = "interview_messages"
    __table_args__ = (
        CheckConstraint(_in("role", ROLES), name="role"),
        CheckConstraint(_in("kind", MESSAGE_KINDS), name="kind"),
        Index("ix_interview_messages_interview", "interview_id", "created_at"),
    )

    interview_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("interviews.id", ondelete="CASCADE"), nullable=False
    )
    role: Mapped[str] = mapped_column(Text, nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    # The guide question's id.
    guide_item: Mapped[str | None] = mapped_column(Text)
    # Team interviews (lane 2): the stakeholder question answered.
    question_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("stakeholder_questions.id", ondelete="SET NULL")
    )
    model: Mapped[str | None] = mapped_column(Text)
    usage: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    cost_usd: Mapped[Decimal | None] = mapped_column(Numeric(12, 4))
