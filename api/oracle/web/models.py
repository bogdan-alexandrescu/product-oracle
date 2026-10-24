"""What each run searched and read through Oracle's web tools (H7).

- ``web_results`` (migration 0052_market): every search result and page a run read,
  under a ref ``w-<n>`` unique in the run. ``search_web`` and ``fetch_web_page`` record
  each one here; a ``fetch_web_page`` URL must be one of the run's results. The
  competitive digest's importer (oracle.market.digest) accepts a web finding only when it
  cites one of its run's refs and quotes its text, and takes the URL, host and date from
  this record, never from the agent's files.
- ``web_searches`` (migration 0053_web_tools): one row per search sent to the provider (a
  search with no results costs a call too). The per-run cap and the company's
  ``web_searches_per_month`` count these rows.

Both are kept 13 months, then purged by the market ticker step (:func:`purge_old`).
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
from oracle.v2.models import _fk

RESULT_KINDS = ("search_result", "page")
# What a page result keeps of the page's text.
PAGE_TEXT_CHARS = 20_000
# Kept 13 months (a year of monthly digests and the month before), then purged.
KEEP_DAYS = 396


class WebResult(TenantScoped, Base):
    __tablename__ = "web_results"
    __table_args__ = (
        CheckConstraint(_in("kind", RESULT_KINDS), name="kind"),
        UniqueConstraint("run_id", "ref"),
        Index("ix_web_results_month", "tenant_id", "fetched_at"),
    )

    run_id: Mapped[uuid.UUID] = _fk("runs", nullable=False)
    ref: Mapped[str] = mapped_column(Text, nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    query: Mapped[str | None] = mapped_column(Text)
    url: Mapped[str] = mapped_column(Text, nullable=False)
    host: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str | None] = mapped_column(Text)
    # The snippet, or the page text (at most PAGE_TEXT_CHARS).
    text: Mapped[str] = mapped_column(Text, nullable=False)
    published_on: Mapped[date | None] = mapped_column(Date)
    fetched_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


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
