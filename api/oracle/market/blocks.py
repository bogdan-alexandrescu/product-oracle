"""The competitive digest's pre-read blocks (oracle.rituals.blocks registers them):
deterministic, from Oracle's own data, no model call.

- ``competitor_changes``: per alternative, each change in the period (page changes and
  promoted web findings).
- ``competitor_web``: the open web findings of the period; the digest run fills it
  (oracle.market.digest).
- ``competitor_mentions``: requests created in the period that name an active
  alternative (its name or an alias: whole words, any case). Person-owned source items are
  not scanned: they are private to their owner (S3, S6).
- ``watch_problems``: pages blocked, failing or not public, and whether web search is set
  up.
"""

import re
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import company_time
from oracle.market import watch
from oracle.market.models import Competitor, CompetitorChange, CompetitorPage, CompetitorWebFinding
from oracle.requests.models import ProductRequest

LABEL_TITLES = {
    "pricing": "Pricing",
    "changelog": "Changelog",
    "product": "Product",
    "docs": "Docs",
    "blog": "Blog",
    "other": "Other",
}
MENTION_LABEL = "Asked for because an alternative has it?"
WEB_NOT_SET_UP = "Web search is not set up"
WEB_UNAVAILABLE = "Web search was not available this month"


def web_search_configured() -> bool:
    """Whether Oracle's web tools (H7 lane 1) are on: the provider key is set."""
    from oracle.config import get_settings

    return bool(getattr(get_settings(), "web_search_key", None))


def mention_pattern(c: Competitor) -> re.Pattern[str]:
    terms = [c.name, *(c.aliases or [])]
    alts = "|".join(re.escape(t) for t in sorted({t for t in terms if t}, key=len, reverse=True))
    return re.compile(rf"(?<!\w)(?:{alts})(?!\w)", re.I)


async def _active(db: AsyncSession) -> list[Competitor]:
    return list(
        await db.scalars(
            select(Competitor).where(Competitor.status == "active").order_by(Competitor.name)
        )
    )


def _day(moment: Any, zone: str) -> str:
    return company_time.day_in_words(moment, zone)


async def competitor_changes(db: AsyncSession, ctx: Any) -> list[dict[str, Any]]:
    zone = await company_time.company_time_zone(db)
    rows = (
        await db.execute(
            select(CompetitorChange, Competitor, CompetitorPage, CompetitorWebFinding)
            .join(Competitor, Competitor.id == CompetitorChange.competitor_id)
            .outerjoin(CompetitorPage, CompetitorPage.id == CompetitorChange.page_id)
            .outerjoin(
                CompetitorWebFinding, CompetitorWebFinding.id == CompetitorChange.web_finding_id
            )
            .where(
                CompetitorChange.detected_at >= ctx.period_from,
                CompetitorChange.detected_at < ctx.period_to,
            )
            .order_by(Competitor.name, CompetitorChange.detected_at)
        )
    ).all()
    out = []
    for ch, c, page, finding in rows:
        origin = LABEL_TITLES[page.label] if page is not None else "From the web"
        if finding is not None:
            origin = f"From the web · {finding.host}"
        lines = f" · +{ch.added_lines} −{ch.removed_lines}" if ch.origin == "page" else ""
        # A promoted finding's summary is its title, text from the web: it stays a field
        # marked untrusted and never enters the pre-read's text (the digest's prompt).
        untrusted = ch.origin == "web"
        summary = f" · {ch.summary}" if ch.summary and not untrusted else ""
        out.append({
            "change_id": str(ch.id), "competitor_id": str(c.id), "competitor": c.name,
            "origin": ch.origin, "label": page.label if page is not None else None,
            "detected_on": company_time.day(ch.detected_at, zone).isoformat(),
            "added_lines": ch.added_lines, "removed_lines": ch.removed_lines,
            "rating": ch.rating, "summary": ch.summary, "untrusted": untrusted,
            "href": f"/company/market?alternative={c.id}&change={ch.id}",
            "text": f"{c.name} · {origin} · {_day(ch.detected_at, zone)}{lines} · "
                    f"{ch.rating}{summary}",
        })  # fmt: skip
    return out


def finding_row(f: CompetitorWebFinding, c: Competitor, zone: str) -> dict[str, Any]:
    when = f.published_on.strftime("%b %-d") if f.published_on else (
        f"found {_day(f.created_at, zone)}"
    )  # fmt: skip
    return {
        "finding_id": str(f.id), "competitor_id": str(c.id), "competitor": c.name,
        "kind": f.kind, "title": f.title, "summary": f.summary, "excerpt": f.excerpt,
        "url": f.url, "host": f.host, "status": f.status, "vetted": False,
        "href": f"/company/market?tab=changes&view=web&alternative={c.id}",
        "text": f"{c.name}: {f.title} (Not vetted · {f.host} · {when})",
    }  # fmt: skip


async def competitor_web(db: AsyncSession, ctx: Any) -> list[dict[str, Any]]:
    zone = await company_time.company_time_zone(db)
    rows = (
        await db.execute(
            select(CompetitorWebFinding, Competitor)
            .join(Competitor, Competitor.id == CompetitorWebFinding.competitor_id)
            .where(
                CompetitorWebFinding.status == "open",
                CompetitorWebFinding.created_at >= ctx.period_from,
                CompetitorWebFinding.created_at < ctx.period_to,
            )
            .order_by(Competitor.name, CompetitorWebFinding.created_at)
        )
    ).all()
    out = [finding_row(f, c, zone) for f, c in rows]
    if not out and not web_search_configured():
        out.append({"href": "/company/market", "text": WEB_NOT_SET_UP})
    return out


async def mentions(db: AsyncSession, period_from: Any, period_to: Any) -> list[dict[str, Any]]:
    alternatives = [(c, mention_pattern(c)) for c in await _active(db)]
    if not alternatives:
        return []
    out = []
    for r in await db.scalars(
        select(ProductRequest)
        .where(ProductRequest.created_at >= period_from, ProductRequest.created_at < period_to)
        .order_by(ProductRequest.created_at, ProductRequest.id)
    ):
        text = f"{r.title}\n{r.body or ''}"
        named = [c for c, pattern in alternatives if pattern.search(text)]
        for c in named:
            out.append({
                "request_id": str(r.id), "competitor_id": str(c.id), "competitor": c.name,
                "label": MENTION_LABEL, "href": f"/requests?request={r.id}",
                "text": f"{r.title} · names {c.name} · {MENTION_LABEL}",
            })  # fmt: skip
    return out


async def competitor_mentions(db: AsyncSession, ctx: Any) -> list[dict[str, Any]]:
    return await mentions(db, ctx.period_from, ctx.period_to)


PROBLEMS = {"blocked": "blocked by robots.txt", "error": "not read"}


async def watch_problems(db: AsyncSession, ctx: Any) -> list[dict[str, Any]]:
    rows = (
        await db.execute(
            select(CompetitorPage, Competitor)
            .join(Competitor, Competitor.id == CompetitorPage.competitor_id)
            .where(Competitor.status == "active", CompetitorPage.status.in_(("blocked", "error")))
            .order_by(Competitor.name, CompetitorPage.url)
        )
    ).all()
    out = []
    for p, c in rows:
        why = p.last_error or PROBLEMS[p.status]
        if p.status == "error" and p.attempts >= watch.MAX_ATTEMPTS:
            why = watch.NOT_READ
        out.append({
            "page_id": str(p.id), "competitor_id": str(c.id), "status": p.status,
            "href": f"/company/market?alternative={c.id}",
            "text": f"{c.name} · {LABEL_TITLES[p.label]} · {watch.host_of(p.url)}: {why}",
        })  # fmt: skip
    if not web_search_configured():
        out.append({"href": "/company/market", "text": WEB_NOT_SET_UP})
    return out


TITLES = {
    "competitor_changes": "Changes",
    "competitor_web": "From the web",
    "competitor_mentions": "What people in the company said",
    "watch_problems": "Watch problems",
}
BUILDERS = {
    "competitor_changes": competitor_changes,
    "competitor_web": competitor_web,
    "competitor_mentions": competitor_mentions,
    "watch_problems": watch_problems,
}
