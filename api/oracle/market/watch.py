"""Weekly checks of watched pages (deterministic, no model call).

The ticker step :func:`check_due` (``oracle.ticker.router._tick_company``, in its own
``try``) reads every ``active`` page whose last read is :data:`EVERY` old or more with
``LinkFetcher.fetch`` (its guards: https, public addresses only, 20 s, 2 MB, HTML or
text): at most :data:`PER_TICK` reads per company per tick and one read per host per
minute. robots.txt is honoured first (oracle.market.robots).

A read stores a snapshot of the normalised text; when its hash differs from the
previous snapshot, a ``competitor_changes`` row holds the line diff (oracle.market.diff).
A failure sets ``last_error`` and counts an attempt; after :data:`MAX_ATTEMPTS` failed
weeks, or at once when the page is not public or its host is not a public address, the
page is ``error``. Each page keeps its last :data:`KEEP_SNAPSHOTS` snapshots plus those a
change points to. The same step purges web results older than :data:`WEB_RESULTS_KEPT`.
"""

import logging
from datetime import datetime, timedelta
from urllib.parse import urlsplit

from sqlalchemy import delete, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.baseline.public_links import LinkError, LinkFetcher, get_link_fetcher
from oracle.market import diff, robots
from oracle.market.models import CompetitorChange, CompetitorPage, CompetitorPageSnapshot
from oracle.rituals import clock
from oracle.web.models import WebResult

log = logging.getLogger(__name__)

EVERY = timedelta(days=7)
PER_TICK = 10
HOST_GAP = timedelta(minutes=1)
MAX_ATTEMPTS = 3
KEEP_SNAPSHOTS = 13
WEB_RESULTS_KEPT = timedelta(days=396)
# Fetcher codes that end the page at once: a sign-in wall or a non-public address.
FINAL_CODES = ("not_public", "blocked_address")
NOT_READ = "Not read for 3 weeks"


def fetcher() -> LinkFetcher:
    """The ticker's fetcher; tests replace it with a fake transport."""
    return get_link_fetcher()


def host_of(url: str) -> str:
    return (urlsplit(url).hostname or "").lower()


async def check_page(
    db: AsyncSession, page: CompetitorPage, fetch: LinkFetcher, now: datetime
) -> CompetitorPage:
    """Read one page now (a scheduled read or Check now). The caller commits."""
    page.last_checked_at = now
    if not await robots.allowed(fetch, page.url, now):
        page.status, page.last_error = "blocked", robots.BLOCKED
        return page
    try:
        read = await fetch.fetch(page.url, now=now)
    except LinkError as e:
        page.last_error = str(e)
        page.attempts += 1
        if e.code in FINAL_CODES or page.attempts >= MAX_ATTEMPTS:
            page.status = "error"
        return page
    page.attempts, page.last_error = 0, None
    if page.status in ("error", "blocked"):
        page.status = "active"
    text = diff.normalise(read.text)
    snap = CompetitorPageSnapshot(
        page_id=page.id, fetched_at=now, final_url=read.final_url, title=read.title, text=text,
        content_hash=diff.content_hash(read.title, text), last_modified=read.last_modified,
    )  # fmt: skip
    previous = await db.scalar(
        select(CompetitorPageSnapshot)
        .where(CompetitorPageSnapshot.page_id == page.id)
        .order_by(
            CompetitorPageSnapshot.fetched_at.desc(), CompetitorPageSnapshot.created_at.desc()
        )
        .limit(1)
    )
    db.add(snap)
    await db.flush()
    if previous is not None and previous.content_hash != snap.content_hash:
        d = diff.line_diff(previous.text, text)
        db.add(
            CompetitorChange(
                competitor_id=page.competitor_id, origin="page", page_id=page.id,
                before_id=previous.id, after_id=snap.id, detected_at=now, added_lines=d.added,
                removed_lines=d.removed, diff=d.lines, rating=d.rating, rated_by="rule",
            )
        )  # fmt: skip
        page.last_changed_at = now
        await db.flush()
    await _prune(db, page)
    return page


async def _prune(db: AsyncSession, page: CompetitorPage) -> None:
    keep = select(CompetitorPageSnapshot.id).where(CompetitorPageSnapshot.page_id == page.id)
    recent = list(
        await db.scalars(
            keep.order_by(CompetitorPageSnapshot.fetched_at.desc()).limit(KEEP_SNAPSHOTS)
        )
    )
    cited = select(CompetitorChange.before_id).where(CompetitorChange.page_id == page.id)
    cited_after = select(CompetitorChange.after_id).where(CompetitorChange.page_id == page.id)
    await db.execute(
        delete(CompetitorPageSnapshot).where(
            CompetitorPageSnapshot.page_id == page.id,
            CompetitorPageSnapshot.id.not_in(recent),
            CompetitorPageSnapshot.id.not_in(cited.where(CompetitorChange.before_id.is_not(None))),
            CompetitorPageSnapshot.id.not_in(cited_after),
        )
    )


async def check_due(db: AsyncSession) -> int:
    """One tick's weekly reads for the session's company; returns how many were read. The
    caller commits."""
    now = clock.now()
    await db.execute(delete(WebResult).where(WebResult.fetched_at < now - WEB_RESULTS_KEPT))
    due = list(
        await db.scalars(
            select(CompetitorPage)
            .where(
                CompetitorPage.status == "active",
                or_(
                    CompetitorPage.last_checked_at.is_(None),
                    CompetitorPage.last_checked_at <= now - EVERY,
                ),
            )
            .order_by(CompetitorPage.last_checked_at.asc().nulls_first(), CompetitorPage.id)
            .with_for_update(skip_locked=True)
        )
    )
    if not due:
        return 0
    busy = {
        host_of(u)
        for u in await db.scalars(
            select(CompetitorPage.url).where(CompetitorPage.last_checked_at > now - HOST_GAP)
        )
    }
    fetch = fetcher()
    read = 0
    for page in due:
        if read >= PER_TICK:
            break
        host = host_of(page.url)
        if host in busy:
            continue
        busy.add(host)
        try:
            async with db.begin_nested():
                await check_page(db, page, fetch, now)
        except Exception:
            log.exception("market: reading watched page %s failed", page.id)
        read += 1
    return read
