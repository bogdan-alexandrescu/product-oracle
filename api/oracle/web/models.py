"""Every search result and page a run read through Oracle's web tools (H7, migration
0049_market): ``web_results``.

Oracle's ``search_web`` and ``fetch_web_page`` (H7 lane 1) record each result here with a
ref (``w-<n>``) unique in the run. The competitive digest's importer (oracle.market.digest)
accepts a web finding only when it cites one of its run's refs and quotes its text, and
takes the URL, host and date from this record, never from the agent's files. Kept 13
months, then purged by the market ticker step.
"""

import uuid
from datetime import date, datetime

from sqlalchemy import CheckConstraint, Date, DateTime, Index, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from oracle.db import Base, TenantScoped
from oracle.docs.models import _in
from oracle.v2.models import _fk

RESULT_KINDS = ("search_result", "page")
# What a page result keeps of the page's text.
PAGE_TEXT_CHARS = 20_000


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
