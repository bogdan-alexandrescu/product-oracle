"""G4: a discussion's section change waiting for the document's next draft.

C1e's accepted suggestions stay in ``llm_suggestions`` and D8's actions in
``checkpoint_actions``: the one staging list reads all three stores, so each row has one
source of truth. ``lock_version`` maps as SQLAlchemy's ``version_id_col``.
"""

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Text,
    Uuid,
    false,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from oracle.db import Base, TenantScoped
from oracle.docs.models import _in

STATUSES = ("staged", "unstaged", "applied", "superseded")
MAX_INSTRUCTION = 1000
MAX_TEXT = 20000
MAX_REASON = 1000


class NextDraftChange(TenantScoped, Base):
    __tablename__ = "next_draft_changes"
    __table_args__ = (
        CheckConstraint(f"char_length(instruction) <= {MAX_INSTRUCTION}", name="instruction"),
        CheckConstraint(f"text IS NULL OR char_length(text) <= {MAX_TEXT}", name="text"),
        CheckConstraint(f"reason IS NULL OR char_length(reason) <= {MAX_REASON}", name="reason"),
        CheckConstraint(_in("status", STATUSES), name="status"),
        Index("ix_next_draft_changes_document", "document_id", "status"),
        Index(
            "uq_next_draft_changes_change_live",
            "discussion_change_id",
            unique=True,
            postgresql_where=text("status = 'staged'"),
        ),
    )

    document_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("documents.id", ondelete="CASCADE"), nullable=False
    )
    section_key: Mapped[str] = mapped_column(Text, nullable=False)
    raised_on_version: Mapped[int] = mapped_column(Integer, nullable=False)
    instruction: Mapped[str] = mapped_column(Text, nullable=False)
    # A proposed section body.
    text: Mapped[str | None] = mapped_column(Text)
    reason: Mapped[str | None] = mapped_column(Text)
    discussion_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("discussions.id", ondelete="SET NULL")
    )
    discussion_change_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("discussion_changes.id", ondelete="SET NULL")
    )
    # Staged while the discussion was private; never rewritten.
    from_private: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=false()
    )
    staged_by: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    suggested_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    status: Mapped[str] = mapped_column(
        Text, nullable=False, default="staged", server_default="staged"
    )
    applied_in_version: Mapped[int | None] = mapped_column(Integer)
    unstaged_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    unstaged_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )
    lock_version: Mapped[int] = mapped_column(
        Integer, nullable=False, default=1, server_default="1"
    )

    __mapper_args__ = {"version_id_col": lock_version}
