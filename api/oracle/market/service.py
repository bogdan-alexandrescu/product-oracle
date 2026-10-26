"""Alternatives, watched pages, the change log, web findings and positioning: the routes'
work (oracle.market.router). Every write is an approver's or an owner's; run tokens only
read (oracle.mcp.scopes)."""

import uuid
from datetime import UTC, date, datetime, timedelta
from typing import Any
from urllib.parse import urlsplit

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, company_time
from oracle.auth.deps import Principal
from oracle.auth.models import User
from oracle.baseline.public_links import LinkFetcher
from oracle.docs import visibility
from oracle.market import robots, watch
from oracle.market.blocks import LABEL_TITLES
from oracle.market.findings import plain
from oracle.market.models import (
    FIELDS,
    Competitor,
    CompetitorChange,
    CompetitorPage,
    CompetitorWebFinding,
    Positioning,
    PositioningSuggestion,
)
from oracle.market.schemas import (
    ChangeDetail,
    ChangeOut,
    CompetitorCreate,
    CompetitorDetail,
    CompetitorOut,
    CompetitorPatch,
    DiffLine,
    Item,
    PageIn,
    PageOut,
    PagePatch,
    PositioningFields,
    PositioningIn,
    PositioningOut,
    PositioningSuggestionOut,
    SuggestionRef,
    WebFindingOut,
)
from oracle.rituals import clock
from oracle.rituals.models import Ritual

MAX_ALIASES = 5
PAGES_PER_COMPETITOR = 10
PAGES_PER_COMPANY = 60
ITEM_CHARS = 300
ITEMS_PER_FIELD = 10
# Promoted and dismissed URLs are not shown again for this long.
DECIDED_HIDE = timedelta(days=180)
# Open findings older than this are hidden from the default view.
OPEN_SHOWN = timedelta(days=90)
KIND = "competitive_digest"
STALE_POSITIONING = "Someone else changed the positioning; reload"


class MarketError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


def _now() -> datetime:
    return clock.now()


async def _zone(db: AsyncSession) -> str:
    return await company_time.company_time_zone(db)


# --- the ritual's one resume -------------------------------------------------------------


async def resume_digest_once(db: AsyncSession) -> None:
    """The first alternative or watched page resumes the paused digest ritual, once
    (audit ``ritual.resumed``, actor oracle). An owner can pause it again. The caller
    commits."""
    from oracle.models import AuditEvent
    from oracle.rituals.schedule import next_occurrence

    ritual = await db.scalar(
        select(Ritual).where(Ritual.kind == KIND, Ritual.builtin).with_for_update()
    )
    if ritual is None or ritual.status != "paused":
        return
    done = await db.scalar(
        select(func.count()).select_from(AuditEvent).where(
            AuditEvent.action == "ritual.resumed", AuditEvent.entity_id == ritual.id,
            AuditEvent.actor == audit.ORACLE,
        )
    )  # fmt: skip
    if done:
        return
    ritual.status = "active"
    ritual.next_due_at = next_occurrence(ritual.schedule, clock.now())
    ritual.lock_version += 1
    await audit.record(db, audit.ORACLE, "ritual.resumed", "ritual", ritual.id,
                       {"reason": "first alternative or watched page"})  # fmt: skip


# --- alternatives ------------------------------------------------------------------------


def _aliases(values: list[str]) -> list[str]:
    out: list[str] = []
    for v in values:
        v = " ".join(v.split())
        if not v:
            continue
        if len(v) > 60:
            raise MarketError(422, "aliases: an alias is at most 60 characters")
        if v.lower() not in (o.lower() for o in out):
            out.append(v)
    if len(out) > MAX_ALIASES:
        raise MarketError(422, f"aliases: at most {MAX_ALIASES} aliases")
    return out


async def _name_free(db: AsyncSession, name: str, but: uuid.UUID | None = None) -> None:
    q = select(Competitor.id).where(
        func.lower(Competitor.name) == name.lower(), Competitor.status == "active"
    )
    if but is not None:
        q = q.where(Competitor.id != but)
    if await db.scalar(q) is not None:
        raise MarketError(422, "name: another active alternative has this name")


def _month_start(now: datetime, zone: str) -> date:
    return company_time.day(now, zone).replace(day=1)


async def _out(db: AsyncSession, c: Competitor, zone: str) -> CompetitorOut:
    now = _now()
    pages = list(
        await db.scalars(select(CompetitorPage).where(CompetitorPage.competitor_id == c.id))
    )
    changes = list(
        await db.scalars(
            select(CompetitorChange.detected_at).where(CompetitorChange.competitor_id == c.id)
        )
    )
    month = _month_start(now, zone)
    days = [company_time.day(d, zone) for d in changes]
    open_findings = await db.scalar(
        select(func.count()).select_from(CompetitorWebFinding).where(
            CompetitorWebFinding.competitor_id == c.id, CompetitorWebFinding.status == "open"
        )
    )  # fmt: skip
    failing = any(p.status == "error" and p.attempts >= watch.MAX_ATTEMPTS for p in pages)
    return CompetitorOut(
        id=c.id, name=c.name, kind=c.kind, website=c.website, aliases=list(c.aliases or []),  # type: ignore[arg-type]
        description=c.description, status=c.status, pages=len(pages),  # type: ignore[arg-type]
        last_change_on=max(days) if days else None,
        changes_this_month=sum(1 for d in days if d >= month),
        open_web_findings=int(open_findings or 0),
        watch_problem=watch.NOT_READ if failing else None, lock_version=c.lock_version,
    )  # fmt: skip


async def get_competitor(db: AsyncSession, cid: uuid.UUID, *, lock: bool = False) -> Competitor:
    q = select(Competitor).where(Competitor.id == cid)
    if lock:
        q = q.with_for_update()
    c = await db.scalar(q)
    if c is None:
        raise MarketError(404, "No such alternative")
    return c


async def list_competitors(db: AsyncSession, include_archived: bool) -> list[CompetitorOut]:
    q = select(Competitor).order_by(func.lower(Competitor.name))
    if not include_archived:
        q = q.where(Competitor.status == "active")
    zone = await _zone(db)
    return [await _out(db, c, zone) for c in await db.scalars(q)]


async def create_competitor(
    db: AsyncSession, principal: Principal, body: CompetitorCreate
) -> CompetitorOut:
    name = " ".join(body.name.split())
    if not name:
        raise MarketError(422, "name: required")
    aliases = _aliases(body.aliases)
    await _name_free(db, name)
    c = Competitor(
        name=name, kind=body.kind, website=(body.website or "").strip() or None,
        description=(body.description or "").strip() or None, aliases=aliases,
        created_by=principal.id,
    )  # fmt: skip
    db.add(c)
    await db.flush()
    await audit.record(db, principal, "competitor.created", "competitor", c.id, {"name": name})
    await resume_digest_once(db)
    await db.commit()
    return await _out(db, c, await _zone(db))


async def update_competitor(
    db: AsyncSession, principal: Principal, cid: uuid.UUID, body: CompetitorPatch
) -> CompetitorOut:
    c = await get_competitor(db, cid, lock=True)
    if c.lock_version != body.lock_version:
        raise MarketError(409, "Someone else changed this alternative; reload")
    data = body.model_dump(exclude_unset=True, exclude={"lock_version"})
    if data.get("name") is not None:
        name = " ".join(data["name"].split())
        if c.status == "active":
            await _name_free(db, name, but=c.id)
        c.name = name
    if data.get("kind") is not None:
        c.kind = data["kind"]
    if "website" in data:
        c.website = (data["website"] or "").strip() or None
    if "description" in data:
        c.description = (data["description"] or "").strip() or None
    if data.get("aliases") is not None:
        c.aliases = _aliases(data["aliases"])
    c.lock_version += 1
    await audit.record(db, principal, "competitor.updated", "competitor", c.id,
                       {"fields": sorted(data)})  # fmt: skip
    await db.commit()
    return await _out(db, c, await _zone(db))


async def set_competitor_status(
    db: AsyncSession, principal: Principal, cid: uuid.UUID, status: str
) -> CompetitorOut:
    c = await get_competitor(db, cid, lock=True)
    if c.status != status:
        if status == "active":
            await _name_free(db, c.name, but=c.id)
        c.status = status
        c.lock_version += 1
        if status == "archived":
            for p in await db.scalars(
                select(CompetitorPage).where(
                    CompetitorPage.competitor_id == c.id, CompetitorPage.status == "active"
                )
            ):
                p.status = "paused"
        verb = "archived" if status == "archived" else "restored"
        await audit.record(db, principal, f"competitor.{verb}", "competitor", c.id)
        await db.commit()
    return await _out(db, c, await _zone(db))


async def competitor_detail(db: AsyncSession, cid: uuid.UUID) -> CompetitorDetail:
    c = await get_competitor(db, cid)
    zone = await _zone(db)
    base = await _out(db, c, zone)
    pages = list(
        await db.scalars(
            select(CompetitorPage)
            .where(CompetitorPage.competitor_id == c.id)
            .order_by(CompetitorPage.created_at)
        )
    )
    return CompetitorDetail(
        **base.model_dump(),
        page_list=[page_out(p) for p in pages],
        changes=await list_changes(db, competitor_id=c.id, limit=20),
        web_findings=await list_findings(db, status="open", competitor_id=c.id),
    )


# --- watched pages -----------------------------------------------------------------------


def page_out(p: CompetitorPage) -> PageOut:
    return PageOut(
        id=p.id, competitor_id=p.competitor_id, url=p.url, host=watch.host_of(p.url),
        label=p.label, status=p.status, last_checked_at=p.last_checked_at,  # type: ignore[arg-type]
        last_changed_at=p.last_changed_at, attempts=p.attempts, last_error=p.last_error,
    )  # fmt: skip


def _https(url: str) -> str:
    url = url.strip()
    try:
        parts = urlsplit(url)
    except ValueError as e:
        raise MarketError(422, "url: not a valid URL") from e
    if parts.scheme.lower() != "https" or not parts.hostname:
        raise MarketError(422, "url: only https:// pages can be watched")
    return url


async def watch_page(
    db: AsyncSession, principal: Principal, cid: uuid.UUID, body: PageIn, fetch: LinkFetcher
) -> PageOut:
    c = await get_competitor(db, cid, lock=True)
    url = _https(body.url)
    if c.status != "active":
        raise MarketError(409, "The alternative is archived; restore it first")
    mine = await db.scalar(
        select(func.count()).select_from(CompetitorPage).where(CompetitorPage.competitor_id == c.id)
    )
    if (mine or 0) >= PAGES_PER_COMPETITOR:
        raise MarketError(422, f"url: at most {PAGES_PER_COMPETITOR} pages per alternative")
    total = await db.scalar(select(func.count()).select_from(CompetitorPage))
    if (total or 0) >= PAGES_PER_COMPANY:
        raise MarketError(422, f"url: at most {PAGES_PER_COMPANY} watched pages in all")
    dup = await db.scalar(
        select(CompetitorPage.id).where(
            CompetitorPage.competitor_id == c.id, CompetitorPage.url == url
        )
    )
    if dup is not None:
        raise MarketError(422, "url: this page is already watched for this alternative")
    page = CompetitorPage(competitor_id=c.id, url=url, label=body.label, created_by=principal.id)
    db.add(page)
    await db.flush()
    await audit.record(db, principal, "competitor_page.watched", "competitor_page", page.id,
                       {"url": url})  # fmt: skip
    await resume_digest_once(db)
    await watch.check_page(db, page, fetch, _now())
    await db.commit()
    return page_out(page)


async def get_page(db: AsyncSession, pid: uuid.UUID, *, lock: bool = False) -> CompetitorPage:
    q = select(CompetitorPage).where(CompetitorPage.id == pid)
    if lock:
        q = q.with_for_update()
    p = await db.scalar(q)
    if p is None:
        raise MarketError(404, "No such watched page")
    return p


async def update_page(
    db: AsyncSession, principal: Principal, pid: uuid.UUID, body: PagePatch
) -> PageOut:
    p = await get_page(db, pid, lock=True)
    if body.label is not None:
        p.label = body.label
    if body.status is not None and body.status != p.status:
        if body.status == "active":
            p.attempts, p.last_error = 0, None
        p.status = body.status
    await audit.record(db, principal, "competitor_page.updated", "competitor_page", p.id,
                       body.model_dump(exclude_none=True))  # fmt: skip
    await db.commit()
    return page_out(p)


async def delete_page(db: AsyncSession, principal: Principal, pid: uuid.UUID) -> None:
    p = await get_page(db, pid, lock=True)
    await audit.record(db, principal, "competitor_page.removed", "competitor_page", p.id,
                       {"url": p.url})  # fmt: skip
    await db.delete(p)
    await db.commit()


async def check_now(
    db: AsyncSession, principal: Principal, pid: uuid.UUID, fetch: LinkFetcher
) -> PageOut:
    """Check now: robots.txt is honoured (409 when it disallows the page)."""
    p = await get_page(db, pid, lock=True)
    now = _now()
    if not await robots.allowed(fetch, p.url, now):
        p.status, p.last_error, p.last_checked_at = "blocked", robots.BLOCKED, now
        await db.commit()
        raise MarketError(409, robots.BLOCKED)
    await watch.check_page(db, p, fetch, now)
    await db.commit()
    return page_out(p)


# --- the change log ----------------------------------------------------------------------


def _change_out(ch: CompetitorChange, c: Competitor, page: CompetitorPage | None,
                finding: CompetitorWebFinding | None) -> ChangeOut:  # fmt: skip
    return ChangeOut(
        id=ch.id, competitor_id=c.id, competitor_name=c.name, origin=ch.origin,  # type: ignore[arg-type]
        page_label=page.label if page else None,  # type: ignore[arg-type]
        page_url=page.url if page else None, web_host=finding.host if finding else None,
        detected_at=ch.detected_at, added_lines=ch.added_lines, removed_lines=ch.removed_lines,
        rating=ch.rating, rated_by=ch.rated_by, summary=ch.summary,  # type: ignore[arg-type]
        web_finding_id=ch.web_finding_id,
    )  # fmt: skip


def _change_query():
    return (
        select(CompetitorChange, Competitor, CompetitorPage, CompetitorWebFinding)
        .join(Competitor, Competitor.id == CompetitorChange.competitor_id)
        .outerjoin(CompetitorPage, CompetitorPage.id == CompetitorChange.page_id)
        .outerjoin(CompetitorWebFinding, CompetitorWebFinding.id == CompetitorChange.web_finding_id)
    )


async def list_changes(
    db: AsyncSession,
    *,
    competitor_id: uuid.UUID | None = None,
    from_: datetime | None = None,
    to: datetime | None = None,
    rating: str | None = None,
    origin: str | None = None,
    limit: int = 500,
) -> list[ChangeOut]:
    q = _change_query()
    if competitor_id is not None:
        q = q.where(CompetitorChange.competitor_id == competitor_id)
    if from_ is not None:
        q = q.where(CompetitorChange.detected_at >= from_)
    if to is not None:
        q = q.where(CompetitorChange.detected_at < to)
    if rating is not None:
        q = q.where(CompetitorChange.rating == rating)
    if origin is not None:
        q = q.where(CompetitorChange.origin == origin)
    q = q.order_by(CompetitorChange.detected_at.desc(), CompetitorChange.id).limit(limit)
    return [_change_out(*row) for row in (await db.execute(q)).all()]


async def change_detail(db: AsyncSession, change_id: uuid.UUID) -> ChangeDetail:
    row = (await db.execute(_change_query().where(CompetitorChange.id == change_id))).first()
    if row is None:
        raise MarketError(404, "No such change")
    ch, c, page, finding = row
    zone = await _zone(db)
    return ChangeDetail(
        **_change_out(ch, c, page, finding).model_dump(),
        diff=[DiffLine(**d) for d in ch.diff or []],
        web_finding=_finding_out(finding, c, zone) if finding is not None else None,
    )


# --- web findings ------------------------------------------------------------------------


def _finding_out(f: CompetitorWebFinding, c: Competitor, zone: str) -> WebFindingOut:
    return WebFindingOut(
        id=f.id, competitor_id=c.id, competitor_name=c.name, kind=f.kind, title=f.title,  # type: ignore[arg-type]
        summary=f.summary, excerpt=f.excerpt, url=f.url, host=f.host,
        published_on=f.published_on, found_on=company_time.day(f.created_at, zone),
        status=f.status, vetted=False, occurrence_id=f.occurrence_id,  # type: ignore[arg-type]
        dismiss_reason=f.dismiss_reason,
    )  # fmt: skip


async def list_findings(
    db: AsyncSession,
    *,
    status: str | None = "open",
    competitor_id: uuid.UUID | None = None,
    occurrence_id: uuid.UUID | None = None,
    include_older: bool = False,
) -> list[WebFindingOut]:
    q = select(CompetitorWebFinding, Competitor).join(
        Competitor, Competitor.id == CompetitorWebFinding.competitor_id
    )
    if status is not None:
        q = q.where(CompetitorWebFinding.status == status)
    if competitor_id is not None:
        q = q.where(CompetitorWebFinding.competitor_id == competitor_id)
    if occurrence_id is not None:
        q = q.where(CompetitorWebFinding.occurrence_id == occurrence_id)
    if status == "open" and not include_older:
        q = q.where(CompetitorWebFinding.created_at >= _now() - OPEN_SHOWN)
    q = q.order_by(CompetitorWebFinding.created_at.desc(), CompetitorWebFinding.id)
    zone = await _zone(db)
    return [_finding_out(f, c, zone) for f, c in (await db.execute(q)).all()]


async def _open_finding(db: AsyncSession, fid: uuid.UUID) -> CompetitorWebFinding:
    f = await db.scalar(
        select(CompetitorWebFinding).where(CompetitorWebFinding.id == fid).with_for_update()
    )
    if f is None:
        raise MarketError(404, "No such web finding")
    if f.status != "open":
        raise MarketError(409, f"This finding was already {f.status}")
    return f


async def promote_finding(
    db: AsyncSession, principal: Principal, fid: uuid.UUID, rating: str | None
) -> ChangeOut:
    f = await _open_finding(db, fid)
    now = _now()
    f.status, f.decided_by, f.decided_at = "promoted", principal.id, now
    ch = CompetitorChange(
        competitor_id=f.competitor_id, origin="web", web_finding_id=f.id, detected_at=now,
        rating=rating or "notable", rated_by="person", summary=f.title,
        occurrence_id=f.occurrence_id,
    )  # fmt: skip
    db.add(ch)
    await db.flush()
    await audit.record(db, principal, "web_finding.promoted", "competitor_web_finding", f.id,
                       {"change_id": str(ch.id), "url": f.url})  # fmt: skip
    await db.commit()
    c = await get_competitor(db, f.competitor_id)
    return _change_out(ch, c, None, f)


async def dismiss_finding(
    db: AsyncSession, principal: Principal, fid: uuid.UUID, reason: str | None
) -> WebFindingOut:
    f = await _open_finding(db, fid)
    f.status, f.decided_by, f.decided_at = "dismissed", principal.id, _now()
    f.dismiss_reason = plain(reason or "")[:500] or None
    await audit.record(db, principal, "web_finding.dismissed", "competitor_web_finding", f.id,
                       {"url": f.url})  # fmt: skip
    await db.commit()
    c = await get_competitor(db, f.competitor_id)
    return _finding_out(f, c, await _zone(db))


async def recently_decided_urls(db: AsyncSession, now: datetime) -> set[str]:
    return set(
        await db.scalars(
            select(CompetitorWebFinding.url).where(
                CompetitorWebFinding.status.in_(("promoted", "dismissed")),
                CompetitorWebFinding.decided_at >= now - DECIDED_HIDE,
            )
        )
    )


# --- positioning -------------------------------------------------------------------------


async def _positioning(db: AsyncSession, *, lock: bool = False) -> Positioning | None:
    q = select(Positioning)
    if lock:
        q = q.with_for_update()
    return await db.scalar(q)


def _fields(row: Positioning | None) -> dict[str, list[dict[str, str]]]:
    stored = (row.fields if row is not None else {}) or {}
    return {f: [dict(i) for i in stored.get(f) or []] for f in FIELDS}


async def _ref_out(
    db: AsyncSession, ref: dict[str, Any], viewer: uuid.UUID | None
) -> SuggestionRef:
    """A suggestion's evidence with its title: the finding's, the change's summary (else
    the alternative and the page), the request's, and a source item's for its source's
    owner only (a person's source is private to them, S3)."""
    from oracle.requests.models import ProductRequest
    from oracle.sources.models import Source, SourceItem

    title: str | None = None
    vetted: bool | None = None
    kind = ref.get("kind")
    try:
        rid = uuid.UUID(str(ref.get("id")))
    except ValueError:
        rid = None
    if rid is not None and kind == "web":
        f = await db.get(CompetitorWebFinding, rid)
        if f is not None:
            title, vetted = f.title, f.status == "promoted"
    elif rid is not None and kind == "change":
        row = (
            await db.execute(
                select(CompetitorChange, Competitor, CompetitorPage)
                .join(Competitor, Competitor.id == CompetitorChange.competitor_id)
                .outerjoin(CompetitorPage, CompetitorPage.id == CompetitorChange.page_id)
                .where(CompetitorChange.id == rid)
            )
        ).first()
        if row is not None:
            ch, c, page = row
            where = LABEL_TITLES[page.label] if page is not None else "From the web"
            title = ch.summary or f"{c.name} · {where}"
    elif rid is not None and kind == "request":
        title = await db.scalar(select(ProductRequest.title).where(ProductRequest.id == rid))
    elif rid is not None and kind == "source_item" and viewer is not None:
        title = await db.scalar(
            select(SourceItem.title)
            .join(Source, Source.id == SourceItem.source_id)
            .where(SourceItem.id == rid, Source.owner_user_id == viewer)
        )
    return SuggestionRef(kind=ref["kind"], id=str(ref["id"]), title=title, vetted=vetted)


async def positioning_out(db: AsyncSession, viewer: uuid.UUID | None = None) -> PositioningOut:
    """The positioning and its open suggestions as ``viewer`` (a user id) sees them."""
    row = await _positioning(db)
    fields = _fields(row)
    suggestions = []
    # A digest run's suggestion naming a decision or document the reader may not see (one
    # written before #541 part 4, when the run read as its creator) is not shown to them.
    hidden = await visibility.hidden_for_reader(db)
    for s in await db.scalars(
        select(PositioningSuggestion)
        .where(PositioningSuggestion.status == "open")
        .order_by(PositioningSuggestion.created_at, PositioningSuggestion.id)
    ):
        if hidden is not None and (hidden.names(s.text) or hidden.names(s.rationale)):
            continue
        suggestions.append(
            PositioningSuggestionOut(
                id=s.id, field=s.field, action=s.action, item_id=s.item_id, text=s.text,  # type: ignore[arg-type]
                rationale=s.rationale, refs=[await _ref_out(db, r, viewer) for r in s.refs or []],
                occurrence_id=s.occurrence_id,
            )
        )  # fmt: skip
    name = None
    if row is not None and row.updated_by is not None:
        user = await db.get(User, row.updated_by)
        name = (getattr(user, "name", None) or getattr(user, "email", None)) if user else None
    return PositioningOut(
        fields=PositioningFields(**{f: [Item(**i) for i in v] for f, v in fields.items()}),
        suggestions=suggestions, updated_by_name=name,
        updated_at=row.updated_at if row is not None else None,
        lock_version=row.lock_version if row is not None else 0,
    )  # fmt: skip


def _check_items(field: str, items: list[dict[str, str]]) -> None:
    limit = 1 if field == "market_category" else ITEMS_PER_FIELD
    if len(items) > limit:
        raise MarketError(422, f"fields.{field}: at most {limit} item{'s' if limit > 1 else ''}")
    for i in items:
        if not i["text"]:
            raise MarketError(422, f"fields.{field}: an item has no text")
        if len(i["text"]) > ITEM_CHARS:
            raise MarketError(422, f"fields.{field}: an item is over {ITEM_CHARS} characters")


def _removed(before: dict[str, list[dict[str, str]]], after: dict[str, list[dict[str, str]]]):
    out = []
    for f in FIELDS:
        kept = {i["id"] for i in after[f]}
        out += [{"field": f, "text": i["text"]} for i in before[f] if i["id"] not in kept]
    return out


async def _save(
    db: AsyncSession, principal: Principal, row: Positioning | None,
    fields: dict[str, list[dict[str, str]]], data: dict[str, Any],
) -> None:  # fmt: skip
    before = _fields(row)
    if row is None:
        row = Positioning(fields=fields, updated_by=principal.id, updated_at=_now())
        try:
            # Two first saves at once: the one that loses the race to the company's one
            # row reloads, as with a stale lock_version.
            async with db.begin_nested():
                db.add(row)
                await db.flush()
        except IntegrityError:
            raise MarketError(409, STALE_POSITIONING) from None
    else:
        row.fields = fields
        row.updated_by, row.updated_at = principal.id, _now()
        row.lock_version += 1
    await db.flush()
    await audit.record(db, principal, "positioning.changed", "positioning", row.id,
                       {**data, "at": _now().isoformat(),
                        "removed": _removed(before, fields)})  # fmt: skip


async def update_positioning(
    db: AsyncSession, principal: Principal, body: PositioningIn
) -> PositioningOut:
    row = await _positioning(db, lock=True)
    if (row.lock_version if row is not None else 0) != body.lock_version:
        raise MarketError(409, STALE_POSITIONING)
    fields: dict[str, list[dict[str, str]]] = {}
    for f in FIELDS:
        items = [
            {"id": i.id or uuid.uuid4().hex[:12], "text": " ".join(i.text.split())}
            for i in getattr(body.fields, f)
        ]
        _check_items(f, items)
        fields[f] = items
    await _save(db, principal, row, fields, {"by": "person"})
    await db.commit()
    return await positioning_out(db, principal.user_id)


async def _open_suggestion(db: AsyncSession, sid: uuid.UUID) -> PositioningSuggestion:
    s = await db.scalar(
        select(PositioningSuggestion).where(PositioningSuggestion.id == sid).with_for_update()
    )
    if s is None:
        raise MarketError(404, "No such suggestion")
    if s.status != "open":
        raise MarketError(409, f"This suggestion was already {s.status}")
    return s


async def accept_suggestion(
    db: AsyncSession, principal: Principal, sid: uuid.UUID
) -> PositioningOut:
    s = await _open_suggestion(db, sid)
    row = await _positioning(db, lock=True)
    fields = _fields(row)
    items = fields[s.field]
    if s.action == "add":
        if s.field == "market_category":
            items[:] = []
        items.append({"id": uuid.uuid4().hex[:12], "text": s.text or ""})
    elif s.action == "replace":
        hit = next((i for i in items if i["id"] == s.item_id), None)
        if hit is None:
            raise MarketError(409, "The item this suggestion replaces is gone")
        hit["text"] = s.text or ""
    else:
        if not any(i["id"] == s.item_id for i in items):
            raise MarketError(409, "The item this suggestion removes is gone")
        items[:] = [i for i in items if i["id"] != s.item_id]
    _check_items(s.field, items)
    s.status, s.decided_by, s.decided_at = "accepted", principal.id, _now()
    await _save(db, principal, row, fields, {"by": "suggestion", "suggestion_id": str(s.id)})
    await db.commit()
    return await positioning_out(db, principal.user_id)


async def dismiss_suggestion(
    db: AsyncSession, principal: Principal, sid: uuid.UUID
) -> PositioningOut:
    s = await _open_suggestion(db, sid)
    s.status, s.decided_by, s.decided_at = "dismissed", principal.id, _now()
    await audit.record(db, principal, "positioning_suggestion.dismissed",
                       "positioning_suggestion", s.id)  # fmt: skip
    await db.commit()
    return await positioning_out(db, principal.user_id)


def utc(d: date) -> datetime:
    return datetime(d.year, d.month, d.day, tzinfo=UTC)
