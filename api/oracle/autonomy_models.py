"""What Oracle did on its own account (H11 Autonomy): one row per action, shown as an
"Oracle did" row in the Inbox of each person it notified until they open it.

``undo`` is the route that reverses it (``{method, path, body}``), when the behaviour
that acted supplied one; Undo calls it as the person who clicks it."""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, ForeignKey, Index, Text, Uuid, text
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from oracle.db import Base, TenantScoped


class OracleAction(TenantScoped, Base):
    __tablename__ = "oracle_actions"
    __table_args__ = (Index("ix_oracle_actions_recent", "tenant_id", text("created_at DESC")),)

    responsibility: Mapped[str] = mapped_column(Text, nullable=False)
    summary: Mapped[str] = mapped_column(Text, nullable=False)
    subject: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, server_default="{}")
    undo: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    notify_ids: Mapped[list[uuid.UUID]] = mapped_column(
        ARRAY(Uuid), nullable=False, server_default="{}"
    )
    opened_by: Mapped[list[uuid.UUID]] = mapped_column(
        ARRAY(Uuid), nullable=False, server_default="{}"
    )
    undone_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    undone_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    audit_event_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("audit_events.id", ondelete="SET NULL")
    )
