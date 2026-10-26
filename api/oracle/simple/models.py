"""Simple S2 (#723) tables: Oracle's date suggestions for undated roadmap items
(oracle.simple.suggestions).

One row per suggestion: ``open`` until a person with the right accepts it (the item takes
its dates, ``date_source = 'accepted'``), edits it (the item takes the person's dates) or
dismisses it. An item has at most one open suggestion; the daily regeneration replaces it.
"""

import uuid
from datetime import date, datetime

from sqlalchemy import CheckConstraint, Date, DateTime, ForeignKey, Index, Text, Uuid, text
from sqlalchemy.orm import Mapped, mapped_column

from oracle.db import Base, TenantScoped
from oracle.docs.models import _in

SUGGESTION_STATUSES = ("open", "accepted", "edited", "dismissed")


class RoadmapDateSuggestion(TenantScoped, Base):
    __tablename__ = "roadmap_date_suggestions"
    __table_args__ = (
        CheckConstraint(_in("status", SUGGESTION_STATUSES), name="status"),
        CheckConstraint("end_date >= start_date", name="span"),
        Index(
            "uq_roadmap_date_suggestions_open",
            "item_id",
            unique=True,
            postgresql_where=text("status = 'open'"),
        ),
    )

    item_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("roadmap_items.id", ondelete="CASCADE"), nullable=False, index=True
    )
    start_date: Mapped[date] = mapped_column(Date, nullable=False)
    end_date: Mapped[date] = mapped_column(Date, nullable=False)
    # One sentence: why these dates.
    basis: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="open")
    decided_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
