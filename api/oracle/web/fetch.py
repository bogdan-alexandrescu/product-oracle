"""``fetch_web_page``: read a page a search of this run returned.

A page's text cannot send the agent to an address of its choosing: the URL must be one
Oracle recorded for this run (a search result, or a page it already read). The read goes
through ``LinkFetcher`` (https, public addresses only, checked on every connect and
redirect, 20 s, 2 MB, HTML or text) after robots.txt allows it.
"""

import uuid
from datetime import UTC, datetime
from urllib.parse import urlsplit

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.baseline.public_links import LinkFetcher
from oracle.web import robots
from oracle.web.models import WebResult, next_ref
from oracle.web.schemas import PAGE_TEXT_CHARS


class WebError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code


ROBOTS_REFUSED = "The site asks bots not to read this page (robots.txt)."


async def recorded_url(
    db: AsyncSession, run_id: uuid.UUID, ref: str | None, url: str | None
) -> str:
    """The URL to read: a ref of this run, or a URL this run recorded; WebError otherwise."""
    if ref is not None:
        found = await db.scalar(
            select(WebResult.url).where(WebResult.run_id == run_id, WebResult.ref == ref.strip())
        )
        if found is None:
            raise WebError(404, "unknown_ref", f"This run has no result {ref!r}.")
        return found
    wanted = (url or "").strip()
    found = await db.scalar(
        select(WebResult.url).where(WebResult.run_id == run_id, WebResult.url == wanted).limit(1)
    )
    if found is None:
        raise WebError(
            403,
            "not_from_this_run",
            "Only a URL a search of this run returned can be read.",
        )
    return found


async def read_page(
    db: AsyncSession, fetcher: LinkFetcher, run_id: uuid.UUID, url: str
) -> WebResult:
    """Read ``url`` (robots.txt first) and record it under a new ref. LinkError and
    WebError pass through; nothing is recorded for a refused read."""
    now = datetime.now(UTC)
    if not await robots.allowed(fetcher, url, now=now):
        raise WebError(409, "robots_disallowed", ROBOTS_REFUSED)
    page = await fetcher.fetch(url, now=now)
    row = WebResult(
        run_id=run_id,
        ref=f"w-{await next_ref(db, run_id)}",
        kind="page",
        url=url,
        host=(urlsplit(url).hostname or "").lower(),
        title=page.title,
        text=page.text[:PAGE_TEXT_CHARS],
        fetched_at=now,
    )
    db.add(row)
    await db.flush()
    return row
