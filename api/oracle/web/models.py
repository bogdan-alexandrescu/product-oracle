"""What each run searched and read on the web (H7 lane 1, migration 0049_web_tools).

- ``web_searches``: one row per search sent to the provider (a search with no results
  costs a call too). The per-run cap and the company's ``web_searches_per_month`` count
  these rows.
- ``web_results``: every search result and page a run read, under a ref ``w-<n>`` unique
  in the run. A ``fetch_web_page`` URL must be one of the run's results; the digest's
  importer (lane 2) checks a finding's ref and excerpt against these rows and takes its
  URL, host and date from them.

Both are kept 13 months, then purged by the ticker (:func:`purge_old`).
"""

import uuid
from datetime import date, datetime, timedelta

from sqlalchemy import (
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Text,
    UniqueConstraint,
    Uuid,
    delete,
    func,
    select,
)
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Mapped, mapped_column

from oracle.db import Base, TenantScoped
from oracle.docs.models import _in

RESULT_KINDS = ("search_result", "page")
# Kept 13 months (a year of monthly digests and the month before), then purged.
KEEP_DAYS = 396


class WebSearch(TenantScoped, Base):
    __tablename__ = "web_searches"
    __table_args__ = (Index("ix_web_searches_month", "tenant_id", "searched_at"),)

    run_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("runs.id", ondelete="CASCADE"), nullable=False, index=True
    )
    query: Mapped[str] = mapped_column(Text, nullable=False)
    results: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    searched_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class WebResult(TenantScoped, Base):
    __tablename__ = "web_results"
    __table_args__ = (
        CheckConstraint(_in("kind", RESULT_KINDS), name="kind"),
        UniqueConstraint("run_id", "ref"),
        Index("ix_web_results_month", "tenant_id", "fetched_at"),
    )

    run_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("runs.id", ondelete="CASCADE"), nullable=False
    )
    ref: Mapped[str] = mapped_column(Text, nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    query: Mapped[str | None] = mapped_column(Text)
    url: Mapped[str] = mapped_column(Text, nullable=False)
    host: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str | None] = mapped_column(Text)
    # The snippet, or the page text (at most 20,000 chars).
    text: Mapped[str] = mapped_column(Text, nullable=False)
    published_on: Mapped[date | None] = mapped_column(Date)
    fetched_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


async def searches_in_run(db: AsyncSession, run_id: uuid.UUID) -> int:
    return await db.scalar(select(func.count()).where(WebSearch.run_id == run_id)) or 0


async def searches_since(db: AsyncSession, since: datetime) -> int:
    return await db.scalar(select(func.count()).where(WebSearch.searched_at >= since)) or 0


async def pages_in_run(db: AsyncSession, run_id: uuid.UUID) -> int:
    return (
        await db.scalar(
            select(func.count()).where(WebResult.run_id == run_id, WebResult.kind == "page")
        )
        or 0
    )


async def next_ref(db: AsyncSession, run_id: uuid.UUID) -> int:
    """The next ``n`` of ``w-<n>`` in the run (the caller holds the run's row lock)."""
    refs = (await db.scalars(select(WebResult.ref).where(WebResult.run_id == run_id))).all()
    return max((int(r[2:]) for r in refs if r.startswith("w-") and r[2:].isdigit()), default=0) + 1


async def purge_old(db: AsyncSession, now: datetime) -> int:
    """Delete the session company's web results and searches older than 13 months
    (the caller commits). Returns how many results went."""
    cutoff = now - timedelta(days=KEEP_DAYS)
    gone = await db.execute(delete(WebResult).where(WebResult.fetched_at < cutoff))
    await db.execute(delete(WebSearch).where(WebSearch.searched_at < cutoff))
    return gone.rowcount or 0
