import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Integer, Text, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from oracle.db import Base, TenantScoped
from oracle.docs.models import _in

LIVE_READ_STATUSES = ("ok", "cached", "error")


class LiveRead(TenantScoped, Base):
    """One live tool call (#710 section 3): what was read, from which connection, when.

    It stores no source text, no query text and no key: the tool, the item id, the
    status and the time. ``source_label`` and ``tool`` are written at read time (C2), so
    a citation reads them from here and renaming or deleting the connection later leaves
    old citations as they were.
    """

    __tablename__ = "live_reads"
    __table_args__ = (CheckConstraint(_in("status", LIVE_READ_STATUSES), name="status"),)

    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    # Null: an MCP or REST call outside Ask.
    message_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("discussion_messages.id", ondelete="CASCADE"), index=True
    )
    connection_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("connections.id", ondelete="SET NULL")
    )
    tool: Mapped[str] = mapped_column(Text, nullable=False)
    source_label: Mapped[str] = mapped_column(Text, nullable=False)
    # Null for a failed call (C1).
    ref_n: Mapped[int | None] = mapped_column(Integer)
    item_id: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    read_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
