"""What a link holder sees (spec-O5 §3): :func:`render_share`, with no principal.

It reads only through a :class:`ShareContext` (the link's company, publication and
audience) on a session scoped to that company, never a member's document loaders, and
renders one of two things:

- the **Public** audience: the Public version (``oracle.roadmap.public.render_public``)
  of the publication's version, while a public check of exactly that publication still
  matches its content; otherwise "This page is being updated";
- **Board, Team, Engineering**: the publication's version in that audience
  (``oracle.export.render.apply_audience``), with what a link holder never sees taken out
  first: citation markers (plain text), citations, the Sources and data points appendix,
  evidence links and every HTML comment (the export banner names the internal slug); the
  banner names no other document (the PRD it was built from), no review status and no
  version, and every link that leaves the page keeps its words but not the link (spec-O5
  §3: no outbound links but the Public version's changelog links).

Renders take an export place under the company's limits on the export pool (a busy pool
is 503); each one is cached per (publication, audience, format, content: the items' goal
groups as read at render time, ``variants.render_key``), so a busy link does not take
export places. The footer is the link's own and is added after the cache.
"""

import html as html_lib
import re
import urllib.parse
import uuid
from collections import OrderedDict
from dataclasses import dataclass, replace
from datetime import datetime
from types import SimpleNamespace

from sqlalchemy import select

from oracle import company_time
from oracle.docs.models import Document, DocumentVersion
from oracle.docs.parser import strip_citations
from oracle.export import offload
from oracle.export.pdf import html_to_pdf
from oracle.review.models import DocumentPublication
from oracle.roadmap import public, variants
from oracle.roadmap.models import RoadmapPublicCheck
from oracle.tenancy import tenant_session

UPDATING = "This page is being updated"
ENDED = "This link has ended. Ask the person who sent it for a new one."
CACHE_SIZE = 64
_COMMENT = re.compile(r"<!--.*?-->", re.S)
# A link that leaves the page (into the app or anywhere else): its words stay.
_OUTBOUND = re.compile(r"<a\b[^>]*?\bhref=\"(?!#)[^\"]*\"[^>]*>(.*?)</a>", re.S | re.I)
_cache: OrderedDict[tuple, str | bytes] = OrderedDict()


@dataclass(frozen=True)
class ShareContext:
    """Everything a share render may read: nothing of the member who made the link."""

    tenant_id: uuid.UUID
    link_id: uuid.UUID
    publication_id: uuid.UUID
    audience: str
    shared_at: datetime
    expires_at: datetime


class Unavailable(Exception):
    """The link's document or publication is gone (trashed or purged): it has ended."""


class Busy(Exception):
    """No export place or pool worker now: 503 "Try again in a moment"."""


def clear_cache() -> None:
    _cache.clear()


def _remember(key: tuple, content: str | bytes) -> None:
    _cache[key] = content
    _cache.move_to_end(key)
    while len(_cache) > CACHE_SIZE:
        _cache.popitem(last=False)


def page(title: str, body: str) -> str:
    """A minimal self-contained page (no script, no outside fetch)."""
    return (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        '<meta name="robots" content="noindex, nofollow">'
        f"<title>{html_lib.escape(title)}</title>"
        "<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;"
        "padding:0 1rem;color:#1f2937}input,button{font:inherit;padding:.5rem}"
        "</style></head>"
        f"<body>{body}</body></html>"
    )


def ended_page() -> str:
    return page("Link ended", f"<p>{html_lib.escape(ENDED)}</p>")


def _footer(company: str, ctx: ShareContext, zone: str) -> str:
    shared = company_time.day_in_words(ctx.shared_at, zone)
    expires = company_time.day_in_words(ctx.expires_at, zone)
    return (
        '<footer class="share-footer" style="margin-top:2rem;font-size:.85rem;color:#4b5563">'
        f"Shared with you by {html_lib.escape(company)} on {html_lib.escape(shared)} · "
        f"link expires {html_lib.escape(expires)}</footer>"
    )


def with_download(html: str, token: str) -> str:
    """The page with a plain Download PDF link (no script) to the link's PDF, for a link
    that allows downloads; relative, so it stays on the link's path (and its cookie)."""
    href = html_lib.escape(urllib.parse.quote(token, safe="") + "/pdf")
    return _with_footer(html, (
        '<p class="share-download" style="margin-top:1rem">'
        f'<a href="{href}" download="roadmap.pdf">Download PDF</a></p>'
    ))  # fmt: skip


def _with_footer(html: str, footer: str) -> str:
    if "</body>" in html:
        return html.replace("</body>", footer + "</body>", 1)
    return html + footer


def _for_link_holder(ev):
    """The export as a link holder may see it: no citation, no Sources appendix, no
    evidence link (the render then has nothing to number or list)."""
    from oracle.export.render import sources_keys

    appendix = sources_keys(ev.all_sections)

    def clean(sections):
        out = []
        for s in sections:
            if s.section_key in appendix:
                continue
            s.body_md = strip_citations(s.body_md or "")
            s.citation_keys = []
            out.append(s)
        return out

    return replace(
        ev,
        sections=clean(ev.sections),
        all_sections=clean(ev.all_sections),
        citations=[],
        evidence_links=[],
        added_citations=set(),
        link_holder=True,
    )


def _render_audience(ev, fmt: str) -> str | bytes:
    """CPU-bound: on the export pool."""
    from oracle.export.render import render_html

    html = _OUTBOUND.sub(r"\1", _COMMENT.sub("", render_html(ev)))
    return html_to_pdf(html) if fmt == "pdf" else html


def _render_public(pg: public.PublicPage, fmt: str, shared_on: str, expires_on: str):
    html = _COMMENT.sub("", public.render_public(pg, shared_on=shared_on, expires_on=expires_on))
    return html_to_pdf(html) if fmt == "pdf" else html


async def _on_pool(ctx: ShareContext, fn, *args):
    # The company's export place: the link counts as one person of its company.
    holder = SimpleNamespace(tenant_id=ctx.tenant_id, actor=f"share_link:{ctx.link_id}")
    try:
        with offload.place(holder) as held:  # type: ignore[arg-type]
            return await offload.run(held, fn, *args)
    except offload.Refused as e:
        raise Busy() from e


async def render_share(ctx: ShareContext, fmt: str = "html") -> str | bytes:
    """The link's page (``html``) or its PDF (``pdf``). Raises :class:`Unavailable` when
    the document or publication is gone, :class:`Busy` when the pool has no place."""
    from oracle.export import router as exports
    from oracle.export.render import apply_layer, detached, load_export_version

    async with tenant_session(ctx.tenant_id) as db:
        publication = await db.get(DocumentPublication, ctx.publication_id)
        if publication is None:
            raise Unavailable()
        document = await db.scalar(select(Document).where(Document.id == publication.document_id))
        version = await db.get(DocumentVersion, publication.version_id)
        if document is None or version is None or document.visibility != "company":
            raise Unavailable()
        zone = await company_time.company_time_zone(db)
        company = await public.company_name(db)
        if ctx.audience == "public":
            review = await public.review(db, document, version)
            current = public.content_hash(review.page)
            check = await db.scalar(
                select(RoadmapPublicCheck)
                .where(RoadmapPublicCheck.publication_id == publication.id)
                .order_by(RoadmapPublicCheck.checked_at.desc(), RoadmapPublicCheck.id)
                .limit(1)
            )
            await db.commit()
            if public.check_state(check, current) != "checked":
                content = page(UPDATING, f"<p>{UPDATING}. Please look again later.</p>")
                return content if fmt == "html" else b""
            shared_on = company_time.day_in_words(ctx.shared_at, zone)
            expires_on = company_time.day_in_words(ctx.expires_at, zone)
            key = (ctx.publication_id, "public", fmt, current, shared_on, expires_on)
            if key not in _cache:
                _remember(key, await _on_pool(ctx, _render_public, review.page, fmt,
                                              shared_on, expires_on))  # fmt: skip
            return _cache[key]
        footer = _footer(company, ctx, zone)
        ev = await load_export_version(db, str(document.id), version.number)
        ev = apply_layer(ev, "full")
        ev = await exports.with_audience(db, ev, ctx.audience)
        # The items' goal groups are read from the baseline at render time: a goal renamed
        # or unconfirmed since makes a new key, so the page regroups (owner decision
        # 2026-10-26).
        key = (ctx.publication_id, ctx.audience, fmt, variants.render_key(ev.items))
        if key in _cache and fmt == "html":
            await db.commit()
            return _with_footer(str(_cache[key]), footer)
        ev = _for_link_holder(detached(ev))
        await db.commit()  # no connection held while it waits for the pool
    if fmt == "html":
        html = await _on_pool(ctx, _render_audience, ev, "html")
        _remember(key, html)
        return _with_footer(str(html), footer)
    # The PDF carries the link's footer in its own text: rendered per link, not cached.
    html = _with_footer(str(await _on_pool(ctx, _render_audience, ev, "html")), footer)
    return await _on_pool(ctx, html_to_pdf, html)
