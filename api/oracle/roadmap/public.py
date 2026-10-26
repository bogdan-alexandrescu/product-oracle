"""The Public version of a roadmap (spec-O5 §2): built, never filtered.

The page is rendered by :func:`render_public` from a :class:`PublicPage`, which has a slot
only for the allowlisted fields: the company name, the public title and intro, the
disclaimer, and per stage the cards of approved public texts (public title, public
description, stage, announced quarter, changelog link). Nothing internal has a slot, so
nothing internal can be left in by mistake: no goal, owner, effort, tracker key,
dependency, confidence, internal title or outcome, prose section, citation, date other
than an announced quarter, or item without an approved text.

An item is shown when its public text is approved, was written for the item as it is now
(``source_hash``), has no blocking leak finding (re-checked at every render, since the
company's records move), and no warning the approver has not ticked, and the item serves a
confirmed goal. The page's public title and intro are re-checked at every render the same way
and left out once they leak; nobody ticks them, so the four kinds an item text's approver
ticks (:data:`PAGE_BLOCKING`) block them.

A **public check** records a person's look at the exact page of one publication. It holds
while the page's content hash matches; any change lapses it ("Changed since checked").

The ``public_text`` job (:func:`run_job`) drafts texts for items with none; a person
approves each (O5-Q7). It never fills an announced quarter.
"""

import hashlib
import json
import uuid
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.docs.models import Document, DocumentVersion, Section
from oracle.roadmap import leak_check, variants
from oracle.roadmap.models import (
    PUBLIC_STAGES,
    RoadmapItem,
    RoadmapPublicCheck,
    RoadmapPublicText,
    TrackerRecord,
)

DEFAULT_DISCLAIMER = (
    "This roadmap shows our current plans. It is not a commitment, and plans and timing can change."
)
ORACLE_MARK = "Made with Product Oracle"
STAGE_LABELS = {
    "shipped": "Shipped recently",
    "in_progress": "In progress",
    "planned": "Planned",
    "exploring": "Exploring",
}
COLUMN_ORDER = ("shipped", "in_progress", "planned", "exploring")
HORIZON_STAGE = {"now": "in_progress", "next": "planned", "later": "exploring"}
TITLE_MAX, DESCRIPTION_MAX = 80, 280
# Warnings on an item's text (its approver ticks them) that block the page's own title and
# intro, which nobody ticks (owner decision, 2026-10-26).
PAGE_BLOCKING = ("internal_document", "decision", "pricing", "internal_note")
# The headers of every Public page response (spec-O5 §3, "What the page sends").
PAGE_HEADERS = {
    "Content-Security-Policy": (
        "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; "
        "frame-ancestors 'none'"
    ),
    "X-Robots-Tag": "noindex, nofollow",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
}


@dataclass(frozen=True)
class PublicCard:
    title: str
    description: str
    stage: str
    announced_quarter: str | None
    changelog_url: str | None


@dataclass(frozen=True)
class PublicPage:
    company: str
    title: str
    intro: str | None
    disclaimer: str
    # ((stage, (cards...)), ...) in COLUMN_ORDER
    columns: tuple[tuple[str, tuple[PublicCard, ...]], ...]
    oracle_mark: bool


@dataclass
class Row:
    item_key: str
    internal_title: str
    horizon: str
    text: RoadmapPublicText | None
    state: str  # approved | draft | excluded | missing | changed
    findings: list[leak_check.Finding]
    shown: bool
    left_out_reason: str | None  # no_approved_text | excluded | no_goal


@dataclass
class Review:
    document: Document
    version: DocumentVersion
    rows: list[Row]
    page: PublicPage
    page_findings: list[leak_check.Finding]
    removed: dict[str, int] = field(default_factory=dict)

    @property
    def shown_keys(self) -> list[str]:
        return [r.item_key for r in self.rows if r.shown]

    def left_out(self) -> dict[str, int]:
        out = {"no_approved_text": 0, "excluded": 0, "no_goal": 0}
        for r in self.rows:
            if r.left_out_reason:
                out[r.left_out_reason] += 1
        return out

    def not_ready(self) -> list[dict[str, Any]]:
        """What stops a public check: every item that serves a goal and is not excluded
        needs an approved, current text without a blocking finding or an unticked warning."""
        left: list[dict[str, Any]] = []
        for r in self.rows:
            if r.shown or r.left_out_reason in ("excluded", "no_goal"):
                continue
            reason = "findings" if r.state == "approved" else r.state
            left.append({"item_key": r.item_key, "reason": reason})
        if leak_check.blocking(self.page_findings):
            left.append({"item_key": None, "reason": "page_findings"})
        if not left and not self.shown_keys:
            left.append({"item_key": None, "reason": "nothing_shown"})
        return left


def source_hash(title: str, outcome: str | None) -> str:
    return hashlib.sha256(f"{title}\n{outcome or ''}".encode()).hexdigest()


def text_findings(
    ctx: leak_check.LeakContext,
    *,
    title: str,
    description: str,
    changelog_url: str | None,
    announced_quarter: str | None,
    internal_title: str | None,
) -> list[leak_check.Finding]:
    """Leak findings of one public text, merged by code."""
    merged: dict[str, leak_check.Finding] = {}
    parts = [
        leak_check.check(title, ctx, announced_quarter=announced_quarter,
                         internal_title=internal_title),
        leak_check.check(description, ctx, announced_quarter=announced_quarter),
        leak_check.check(changelog_url or "", ctx, announced_quarter=announced_quarter),
    ]  # fmt: skip
    for found in parts:
        for f in found:
            if f.code in merged:
                words = list(dict.fromkeys(merged[f.code].words + f.words))
                merged[f.code] = leak_check.Finding(f.code, f.severity, words)
            else:
                merged[f.code] = f
    order = leak_check.BLOCKING + leak_check.WARNINGS
    return sorted(merged.values(), key=lambda f: order.index(f.code))


def page_check(text: str | None, ctx: leak_check.LeakContext) -> list[leak_check.Finding]:
    """Leak findings of the page's own title or intro: the kinds an item text's approver
    ticks are blocking here, since nobody ticks a title or intro (owner decision,
    2026-10-26)."""
    found = [
        leak_check.Finding(f.code, "blocking", f.words) if f.code in PAGE_BLOCKING else f
        for f in leak_check.check(text or "", ctx)
    ]
    return sorted(found, key=lambda f: f.severity != "blocking")


def page_text_findings(ctx: leak_check.LeakContext, title: str | None, intro: str | None):
    return page_check(title, ctx) + page_check(intro, ctx)


def check_state(check: RoadmapPublicCheck | None, content_hash: str | None = None) -> str:
    """none | checked | lapsed ("Changed since checked")."""
    if check is None:
        return "none"
    return "checked" if check.content_hash == content_hash else "lapsed"


def content_hash(page: PublicPage) -> str:
    return hashlib.sha256(json.dumps(asdict(page), sort_keys=True).encode()).hexdigest()


async def company_name(db: AsyncSession) -> str:
    from oracle.models import Tenant
    from oracle.tenancy import current_tenant

    tenant = await db.get(Tenant, current_tenant(db))
    return tenant.name if tenant is not None else "Our"


async def _items(db: AsyncSession, version: DocumentVersion) -> list[RoadmapItem]:
    return list(
        await db.scalars(
            select(RoadmapItem)
            .where(RoadmapItem.roadmap_version_id == version.id)
            .order_by(RoadmapItem.position)
        )
    )


async def _sections(db: AsyncSession, version: DocumentVersion) -> list[Section]:
    return list(
        await db.scalars(
            select(Section).where(Section.version_id == version.id).order_by(Section.ordinal)
        )
    )


def _views(items: list[RoadmapItem]) -> list[variants.ItemView]:
    return [
        variants.ItemView(
            key=i.item_key, title=i.title, outcome=i.outcome, horizon=i.horizon,
            position=i.position,
        )
        for i in items
    ]  # fmt: skip


async def _removed(db: AsyncSession, items: list[RoadmapItem], sections: list[Section]) -> dict:
    """What the Public page leaves out of this version, counted ("What is removed")."""
    tracks = {i.track_id for i in items if i.track_id is not None}
    keys = {i.item_key for i in items}
    tracker = 0
    if tracks:
        refs = await db.execute(
            select(TrackerRecord.item_key).where(
                TrackerRecord.track_id.in_(tracks), TrackerRecord.item_key.is_not(None)
            )
        )
        tracker = sum(1 for (k,) in refs.all() if k in keys)
    goals = next((s for s in sections if s.section_key == "goals"), None)
    body = "\n".join(s.body_md or "" for s in sections)
    return {
        "internal_titles": len(items),
        "owners": body.count("Owner:"),
        "goals": sum(1 for ln in (goals.body_md if goals else "").splitlines()
                     if ln.lstrip().startswith(("-", "*"))),
        "dates_not_announced": sum(1 for i in items if (i.milestone or {}).get("date")),
        "tracker_links": tracker,
        "dependencies": sum(len(i.depends_on or []) for i in items),
        "economics": sum(1 for i in items if i.economics),
        "prose_sections": sum(1 for s in sections
                              if s.level <= 2 and s.section_key not in variants.HORIZON_SECTIONS),
    }  # fmt: skip


async def review(db: AsyncSession, document: Document, version: DocumentVersion) -> Review:
    """Every item of ``version`` with its public text, state and findings, and the exact
    Public page they make."""
    ctx = await leak_check.load_context(db)
    items = await _items(db, version)
    sections = await _sections(db, version)
    no_goal = variants._no_goal_keys(sections, _views(items))
    texts = {
        t.item_key: t
        for t in await db.scalars(
            select(RoadmapPublicText).where(RoadmapPublicText.document_id == document.id)
        )
    }
    rows: list[Row] = []
    cards: dict[str, list[PublicCard]] = {s: [] for s in COLUMN_ORDER}
    for item in items:
        text = texts.get(item.item_key)
        findings: list[leak_check.Finding] = []
        if text is None:
            state = "missing"
        elif text.state == "excluded":
            state = "excluded"
        elif text.source_hash != source_hash(item.title, item.outcome):
            state = "changed"
        else:
            state = text.state
        if text is not None:
            findings = text_findings(
                ctx,
                title=text.title,
                description=text.description,
                changelog_url=text.changelog_url,
                announced_quarter=text.announced_quarter,
                internal_title=item.title,
            )
        serves = item.item_key not in no_goal
        # A warning found since the text was approved (a decision named later) is not
        # ticked: the text is left out until a person checks it again.
        ticked = set(text.checked_warnings or []) if text else set()
        unticked = set(leak_check.warnings(findings)) - ticked
        shown = (
            serves and state == "approved" and not leak_check.blocking(findings) and not unticked
        )
        reason = None
        if not serves:
            reason = "no_goal"
        elif state == "excluded":
            reason = "excluded"
        elif not shown:
            reason = "no_approved_text"
        rows.append(Row(item.item_key, item.title, item.horizon, text, state, findings,
                        shown, reason))  # fmt: skip
        if shown and text is not None:
            url = text.changelog_url if (text.changelog_url or "").startswith("https://") else None
            cards[text.stage].append(
                PublicCard(text.title, text.description, text.stage, text.announced_quarter, url)
            )
    company = await company_name(db)
    # The page's own title and intro are re-checked like the items' texts: one that now
    # names something internal is left out (the default title shows), which changes the
    # content hash, so a public check no longer holds.
    title_findings = page_check(document.public_title, ctx)
    intro_findings = page_check(document.public_intro, ctx)
    title = None if leak_check.blocking(title_findings) else document.public_title
    intro = None if leak_check.blocking(intro_findings) else document.public_intro
    page = PublicPage(
        company=company,
        title=title or f"{company} roadmap",
        intro=intro or None,
        disclaimer=DEFAULT_DISCLAIMER,
        columns=tuple((s, tuple(cards[s])) for s in COLUMN_ORDER),
        oracle_mark=True,
    )
    return Review(document, version, rows, page, title_findings + intro_findings,
                  await _removed(db, items, sections))  # fmt: skip


def quarter_label(quarter: str | None) -> str | None:
    if not quarter or len(quarter) != 7:
        return None
    return f"{quarter[5:]} {quarter[:4]}"


def render_public(
    page: PublicPage, *, shared_on: str | None = None, expires_on: str | None = None
) -> str:
    """The Public page: self-contained HTML with no script and no outside fetch."""
    from oracle.export.render import _jinja

    if shared_on and expires_on:
        footer = f"Shared {shared_on} · expires {expires_on}"
    else:
        footer = "Preview: a shared link's page shows when it was shared and when it ends here"
    columns = [
        {
            "label": STAGE_LABELS[stage],
            "cards": [{**asdict(c), "quarter": quarter_label(c.announced_quarter)} for c in cards],
        }
        for stage, cards in page.columns
    ]
    return (
        _jinja()
        .get_template("public_roadmap.html.j2")
        .render(page=page, columns=columns, footer=footer, oracle_mark=ORACLE_MARK)
    )


async def latest_check(db: AsyncSession, version: DocumentVersion) -> RoadmapPublicCheck | None:
    return await db.scalar(
        select(RoadmapPublicCheck)
        .where(RoadmapPublicCheck.version_id == version.id)
        .order_by(RoadmapPublicCheck.checked_at.desc(), RoadmapPublicCheck.id)
        .limit(1)
    )


# --- the public_text job (O5-Q7) ------------------------------------------------------


async def run_job(s: AsyncSession, job, ask) -> dict[str, Any]:
    """Draft rows for the version's goal-serving items that have no public text."""
    from oracle.jobs.kinds import JobInputError

    document = await s.get(Document, job.document_id)
    version = await s.get(DocumentVersion, job.version_id) if job.version_id else None
    if document is None or version is None:
        raise JobInputError("the roadmap version no longer exists")
    items = await _items(s, version)
    no_goal = variants._no_goal_keys(await _sections(s, version), _views(items))
    have = set(
        await s.scalars(
            select(RoadmapPublicText.item_key).where(RoadmapPublicText.document_id == document.id)
        )
    )
    needed = {i.item_key: i for i in items if i.item_key not in have | no_goal}
    if not needed:
        return {"drafted": 0, "item_keys": []}
    payload = {
        "company": await company_name(s),
        "items": [
            {"item_key": i.item_key, "title": i.title, "outcome": i.outcome or "",
             "horizon": i.horizon}
            for i in needed.values()
        ],
    }  # fmt: skip
    answer = await ask("public_text", payload)
    # A person may have written one while the model ran: theirs is kept.
    have = set(
        await s.scalars(
            select(RoadmapPublicText.item_key).where(RoadmapPublicText.document_id == document.id)
        )
    )
    drafted: list[str] = []
    for entry in (answer or {}).get("texts") or []:
        if not isinstance(entry, dict):
            continue
        key = str(entry.get("item_key") or "")
        item = needed.get(key)
        # A model's draft is saved without invisible format characters (a person's text
        # holding one is refused).
        title = " ".join(leak_check.strip_format(str(entry.get("title") or "")).split())
        title = title[:TITLE_MAX].strip()
        if item is None or key in have or key in drafted or not title:
            continue
        stage = entry.get("stage")
        if stage not in PUBLIC_STAGES:
            stage = HORIZON_STAGE.get(item.horizon, "exploring")
        description = " ".join(leak_check.strip_format(str(entry.get("description") or "")).split())
        s.add(
            RoadmapPublicText(
                id=uuid.uuid4(),
                document_id=document.id,
                item_key=key,
                title=title,
                description=description[:DESCRIPTION_MAX].strip(),
                stage=stage,
                # Never from the model: only a person says a quarter in public.
                announced_quarter=None,
                state="draft",
                drafted_by="oracle",
                source_hash=source_hash(item.title, item.outcome),
                updated_at=datetime.now(UTC),
            )
        )
        drafted.append(key)
    await s.flush()
    return {"drafted": len(drafted), "item_keys": drafted}
