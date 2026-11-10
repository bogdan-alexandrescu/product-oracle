"""approved-roadmap-to-simple (the owner, Nov 3: one roadmap, one set of dates): an approved
roadmap version's plan is applied to the roadmap's items, so Simple reads what the
approved version says, not the estimates its items were carried forward with.

**The plan** (:func:`parse`): the version's text, two tables.

- items: a table whose header names ``Item``, ``Start`` and ``End`` (and optionally ``Key``
  or ``Id``, ``Dates from`` and ``Status``). A row's key is its ``Key`` (else the item of
  the same title, else the title as a slug); its dates are month first (``Dec 1, 2026``) or
  year first (``2026-12-01``); ``Dates from`` is kept as written ("engineering estimate",
  "founder commitment", "set by Pat Example"); ``Status`` ``shipped`` (or ``done``) and
  ``next PRD`` take the item off the plan;
- milestones: a table whose header names ``Milestone`` and ``Date`` (optionally ``Gates``:
  item keys or titles, comma separated, and ``Counts when``); one with ``Gates`` wins over
  a template's own milestones table before it.

A version with neither table changes nothing but an earlier version's mark carried on its
items (so Simple never says it matches that one).

**What applying writes** (:func:`apply`, from ``approve_version`` and on demand for the
latest approved version, ``POST /v1/simple/roadmap/apply-approved``), on the version's own
items:

1. each listed item's start and end (``date_source`` accepted, ``date_basis`` the words),
   except where a person's own dates are on it (``typed``): those stay, and Simple names
   the difference;
2. a shipped item, or one the version leaves out whose track says it shipped
   (oracle.roadmap.shipped), is ``plan_state`` shipped; a next-PRD item ``next_prd``: both
   leave Simple's plan. A listed item the version has no row for is added;
3. its milestones are its track's milestones (``roadmap_version_id``; an earlier version's
   are replaced, one of the same name updated; a person's own milestone of the same name is
   left alone and the version's is not added), with the gated items' keys and how each
   counts; dated only with a verified basis of the track's PRD for that day;
4. dependency marks need nothing: Simple computes them from the dates it reads.

``applied`` on each item ({version, start, end, basis}) is what the version wrote: Simple's
line (:func:`lines`) says it matches the version or what a person changed since.
"""

import re
import uuid
from dataclasses import dataclass, field
from datetime import date
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.authz import has_role
from oracle.company_time import calendar_day
from oracle.docs.models import Document, DocumentVersion
from oracle.roadmap.models import ProductTrack, RoadmapItem, ScheduleBasis, TrackMilestone
from oracle.simple.schemas import SimpleAppliedVersion, SimpleDocRef

SHIPPED = "shipped"
NEXT_PRD = "next_prd"
MONTHS = {m: i for i, m in enumerate(
    ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"), 1
)}  # fmt: skip
LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")
MONTH_FIRST = re.compile(r"^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?$")
DAY_FIRST = re.compile(r"^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?(?:,?\s+(\d{4}))?$")


@dataclass
class PlanItem:
    key: str | None
    title: str
    start: date | None
    end: date | None
    basis: str | None
    state: str | None


@dataclass
class PlanMilestone:
    name: str
    date: date | None
    gates: list[str]
    counts: str | None


@dataclass
class Plan:
    items: list[PlanItem] = field(default_factory=list)
    milestones: list[PlanMilestone] = field(default_factory=list)
    # Whether the text has each table, rows or not (oracle.runs.plan_tables checks a draft).
    has_items_table: bool = False
    has_milestones_table: bool = False

    @property
    def empty(self) -> bool:
        return not self.items and not self.milestones


def _cells(line: str) -> list[str]:
    return [
        LINK.sub(r"\1", c).strip().strip("*_`").strip() for c in line.strip().strip("|").split("|")
    ]


def _rule(cells: list[str]) -> bool:
    return bool(cells) and all(c and set(c) <= set(":- ") for c in cells)


def parse_date(text: str, today: date) -> date | None:
    """``Dec 1, 2026``, ``1 Dec 2026``, ``2026-12-01``; a year-less day is the first on or
    after ``today``."""
    text = text.strip()
    if not text:
        return None
    try:
        return date.fromisoformat(text[:10])
    except ValueError:
        pass
    m = MONTH_FIRST.match(text)
    if m:
        month, day, year = m.group(1), m.group(2), m.group(3)
    elif m := DAY_FIRST.match(text):
        day, month, year = m.group(1), m.group(2), m.group(3)
    else:
        return None
    n = MONTHS.get(month.lower())
    if n is None:
        return None
    try:
        if year:
            return date(int(year), n, int(day))
        got = date(today.year, n, int(day))
        return got if got >= today else date(today.year + 1, n, int(day))
    except ValueError:
        return None


def _state(text: str) -> str | None:
    t = text.lower()
    if t in ("shipped", "done", "launched"):
        return SHIPPED
    if "next prd" in t or "next-prd" in t:
        return NEXT_PRD
    return None


def _col(header: list[str], *names: str) -> int | None:
    for i, h in enumerate(header):
        if h.lower() in names:
            return i
    return None


def parse(markdown: str, today: date) -> Plan:
    """The version's items and milestones tables (the first of each; for milestones, the
    first with a Gates column if any)."""
    plan = Plan()
    lines = markdown.splitlines()
    i = 0
    seen_items = seen_milestones = gated = False
    while i < len(lines):
        line = lines[i]
        if not line.lstrip().startswith("|") or i + 1 >= len(lines):
            i += 1
            continue
        header = _cells(line)
        if not _rule(_cells(lines[i + 1])):
            i += 1
            continue
        low = [h.lower() for h in header]
        rows: list[list[str]] = []
        j = i + 2
        while j < len(lines) and lines[j].lstrip().startswith("|"):
            rows.append(_cells(lines[j]) + [""] * len(header))
            j += 1
        if not seen_items and "item" in low and "start" in low and "end" in low:
            seen_items = plan.has_items_table = True
            key, item = _col(header, "key", "id"), _col(header, "item")
            start, end = _col(header, "start"), _col(header, "end")
            basis, state = _col(header, "dates from", "source"), _col(header, "status")
            for r in rows:
                title = r[item]  # type: ignore[index]
                if not title:
                    continue
                plan.items.append(PlanItem(
                    key=(r[key] or None) if key is not None else None,
                    title=title,
                    start=parse_date(r[start], today),  # type: ignore[index]
                    end=parse_date(r[end], today),  # type: ignore[index]
                    basis=(r[basis] or None) if basis is not None else None,
                    state=_state(r[state]) if state is not None else None,
                ))  # fmt: skip
        elif (
            "milestone" in low
            and "date" in low
            and (not seen_milestones or ("gates" in low and not gated))
        ):
            # A template's own milestones table (no Gates) gives way to the plan's.
            seen_milestones = plan.has_milestones_table = True
            gated = "gates" in low
            plan.milestones = []
            name, day = _col(header, "milestone"), _col(header, "date")
            gates, counts = _col(header, "gates"), _col(header, "counts when", "counts")
            for r in rows:
                if not r[name]:  # type: ignore[index]
                    continue
                plan.milestones.append(PlanMilestone(
                    name=r[name],  # type: ignore[index]
                    date=parse_date(r[day], today),  # type: ignore[index]
                    gates=[g.strip() for g in r[gates].split(",") if g.strip()]
                    if gates is not None else [],
                    counts=(r[counts] or None) if counts is not None else None,
                ))  # fmt: skip
        i = j
    return plan


def _slug(title: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-") or "item"


async def latest_approved(db: AsyncSession, document_id: uuid.UUID) -> DocumentVersion | None:
    return await db.scalar(
        select(DocumentVersion)
        .where(DocumentVersion.document_id == document_id, DocumentVersion.approved_at.is_not(None))
        .order_by(DocumentVersion.number.desc())
        .limit(1)
    )


async def _track(
    db: AsyncSession, document: Document, rows: list[RoadmapItem]
) -> ProductTrack | None:
    for r in rows:
        if r.track_id is not None:
            return await db.get(ProductTrack, r.track_id)
    return await db.scalar(
        select(ProductTrack)
        .where(ProductTrack.roadmap_document_id == document.id)
        .order_by(ProductTrack.created_at)
        .limit(1)
    )


async def apply(
    db: AsyncSession, principal: Any, document: Document, version: DocumentVersion
) -> bool:
    """Apply the version's plan to its items and its track's milestones. False: the
    version has no plan (nothing written). The caller commits."""
    from oracle import company_time
    from oracle.roadmap.shipped import shipped_items

    plan = parse(version.markdown or "", await company_time.company_today(db))
    rows = list(
        await db.scalars(
            select(RoadmapItem)
            .where(RoadmapItem.roadmap_version_id == version.id)
            .order_by(RoadmapItem.position)
        )
    )
    if plan.empty:
        # Rows carried forward keep an earlier version's mark; this version applied
        # nothing, so Simple must not say it matches that one.
        for r in rows:
            if (r.applied or {}).get("version") not in (None, version.number):
                r.applied = None
        await db.flush()
        return False
    by_key = {r.item_key: r for r in rows}
    by_title = {r.title.strip().lower(): r for r in rows}
    from oracle.simple.models import SimpleDraft

    # A Simple draft's version writes its items' own dates (hotfix 4): where they agree, the
    # dates keep the source they had (a person's stay theirs).
    from_simple = (
        await db.scalar(select(SimpleDraft.id).where(SimpleDraft.version_id == version.id).limit(1))
        is not None
    )
    track = await _track(db, document, rows)
    template = rows[0] if rows else None
    position = max((r.position for r in rows), default=-1)
    listed: set[uuid.UUID] = set()
    written: dict[str, Any] = {"items": [], "added": [], "shipped": [], "moved_out": [],
                               "not_added": []}  # fmt: skip
    from oracle.simple import trash_items

    # A feature in Trash keeps its key (and its row on this version): a new item never takes it.
    taken = await trash_items.trashed_keys(db, document.id)
    from oracle.roadmap import codes

    by_feature: dict | None = None
    for p in plan.items:
        row = by_key.get(p.key or "") or by_title.get(p.title.lower())
        if row is None:
            if p.state is not None:
                continue
            if by_feature is None:
                by_feature = await codes.feature_codes(db)
            said = _not_added(p, list(by_key.values()), by_feature)
            if said:
                written["not_added"].append(said)
                continue
            position += 1
            key, n = p.key or _slug(p.title), 2
            while key in taken or key in by_key:
                key, n = f"{(p.key or _slug(p.title))[:21]}-{n}", n + 1
            row = RoadmapItem(
                roadmap_document_id=document.id,
                roadmap_version_id=version.id,
                track_id=track.id if track else None,
                item_key=key,
                title=p.title,
                horizon=template.horizon if template else "now",
                position=position,
                prd_document_id=template.prd_document_id if template else None,
                prd_version_id=template.prd_version_id if template else None,
                note=f"added by version {version.number}",
            )
            db.add(row)
            by_key[row.item_key] = row
            written["added"].append(row.item_key)
        if row.id is not None:
            listed.add(row.id)
        if p.state is not None:
            row.plan_state = p.state
            row.applied = {"version": version.number, "state": p.state}
            written["shipped" if p.state == SHIPPED else "moved_out"].append(row.item_key)
            continue
        row.plan_state = None
        own = (row.start_date, row.end_date)
        person = row.date_source == "typed" and any(own) and own != (p.start, p.end)
        if from_simple and own == (p.start, p.end):
            pass
        elif not person and (p.start or p.end):
            row.start_date, row.end_date = p.start, p.end
            row.date_source = "accepted"
            row.date_basis = p.basis
        elif person:
            row.date_basis = None
        row.applied = {
            "version": version.number,
            "start": p.start.isoformat() if p.start else None,
            "end": p.end.isoformat() if p.end else None,
            "basis": p.basis,
        }
        written["items"].append(row.item_key)
    await db.flush()
    if track is not None:
        shipped = await shipped_items(db, track.id)
        for r in rows:
            if r.id not in listed and r.plan_state is None and r.item_key in shipped:
                r.plan_state = SHIPPED
                r.applied = {"version": version.number, "state": SHIPPED}
                written["shipped"].append(r.item_key)
        await _milestones(db, track, plan, by_key, by_title, version)
    await db.flush()
    if principal is not None:
        await audit.record(db, principal, "roadmap_version.apply", "document_version", version.id,
                           {"document_id": str(document.id), "version": version.number,
                            **written})  # fmt: skip
    return True


def _not_added(p: PlanItem, rows: list[RoadmapItem], by_feature: dict) -> str | None:
    """every-field: one code, one item. A new row whose title's code a live item of the version
    shows already (oracle.roadmap.codes.shown) adds no second item (the live one stays): why,
    in plain words; else None."""
    from oracle.roadmap import codes

    code = codes.title_code(p.title)
    hit = codes.clash(code, "", None, rows, by_feature) if code else None
    if hit is None:
        return None
    return f"{p.title} was not added: {codes.taken(code, codes.named(hit, by_feature))}"  # type: ignore[arg-type]


async def _not_added_rows(db: AsyncSession, version: DocumentVersion) -> list[str]:
    """The version's plan rows that added no item because their code was taken (as
    :func:`apply` leaves them out), in plain words."""
    from oracle import company_time
    from oracle.roadmap import codes

    plan = parse(version.markdown or "", await company_time.company_today(db))
    if plan.empty:
        return []
    rows = list(
        await db.scalars(select(RoadmapItem).where(RoadmapItem.roadmap_version_id == version.id))
    )
    keys, titles = {r.item_key for r in rows}, {r.title.strip().lower() for r in rows}
    wanted = [
        p
        for p in plan.items
        if p.state is None
        and (p.key or "") not in keys
        and p.title.lower() not in titles
        and codes.title_code(p.title)
    ]
    if not wanted:
        return []
    by_feature = await codes.feature_codes(db)
    return [said for p in wanted for said in [_not_added(p, rows, by_feature)] if said]


async def _milestones(
    db: AsyncSession,
    track: ProductTrack,
    plan: Plan,
    by_key: dict[str, RoadmapItem],
    by_title: dict[str, RoadmapItem],
    version: DocumentVersion,
) -> None:
    """The version's milestones as its track's: an earlier version's are replaced."""
    await db.execute(
        delete(TrackMilestone).where(
            TrackMilestone.track_id == track.id,
            TrackMilestone.roadmap_version_id.is_not(None),
            TrackMilestone.name.not_in([m.name for m in plan.milestones]),
        )
    )
    existing: dict[str, TrackMilestone] = {}
    people: set[str] = set()
    for m in await db.scalars(select(TrackMilestone).where(TrackMilestone.track_id == track.id)):
        if m.roadmap_version_id is None:
            people.add(m.name)
        else:
            existing[m.name] = m
    for p in plan.milestones:
        if p.name in people:
            continue  # a person's own milestone of that name stays theirs
        keys = []
        for g in p.gates:
            row = by_key.get(g) or by_title.get(g.lower())
            keys.append(row.item_key if row is not None else g)
        bases = (
            list(
                await db.scalars(
                    select(ScheduleBasis.id).where(
                        ScheduleBasis.prd_document_id.in_(track.prd_ids),
                        ScheduleBasis.status == "verified",
                        ScheduleBasis.supports_date == p.date,
                    )
                )
            )
            if p.date
            else []
        )
        m = existing.get(p.name)
        if m is None:
            m = TrackMilestone(track_id=track.id, name=p.name, horizon="now", status="planned")
            db.add(m)
        m.target_date = p.date if bases else None
        m.basis_ids = bases
        m.item_keys = keys
        m.counts = p.counts
        m.roadmap_version_id = version.id
    await db.flush()


def _day(d: date) -> str:
    return calendar_day(d)


def _difference(title: str, now: tuple[date | None, date | None], was: tuple, n: int) -> str:
    (s, e), (ws, we) = now, was
    if s != ws and e != we and s and e and ws and we:
        return f"{title} runs {_day(s)} to {_day(e)}, version {n} says {_day(ws)} to {_day(we)}"
    if e != we and e and we:
        return f"{title} ends {_day(e)}, version {n} says {_day(we)}"
    if s != ws and s and ws:
        return f"{title} starts {_day(s)}, version {n} says {_day(ws)}"
    return f"{title} has other dates than version {n}"


def date_basis(row: RoadmapItem) -> str | None:
    """The applied version's words for the row's dates while they are still its dates."""
    a = row.applied or {}
    if not row.date_basis or "start" not in a:
        return None
    was = (a.get("start"), a.get("end"))
    now = (
        row.start_date.isoformat() if row.start_date else None,
        row.end_date.isoformat() if row.end_date else None,
    )
    return row.date_basis if now == was else None


async def lines(
    db: AsyncSession, principal: Any, entries: list[Any], roadmaps: list[Document]
) -> list[SimpleAppliedVersion]:
    """One line per shown roadmap whose shown items an approved version was applied to:
    it matches the version, or what differs (dates a person changed, items added or cut
    since). Two statements at most, whatever the number of roadmaps."""
    by_doc: dict[uuid.UUID, list[Any]] = {}
    for e in entries:
        by_doc.setdefault(e.roadmap.id, []).append(e)
    version_ids = {
        e.row.roadmap_version_id for e in entries if e.row.roadmap_version_id is not None
    }
    off_of: dict[uuid.UUID, list[RoadmapItem]] = {}
    if version_ids:
        for r in await db.scalars(
            select(RoadmapItem)
            .where(
                RoadmapItem.roadmap_version_id.in_(version_ids),
                RoadmapItem.plan_state.is_not(None),
            )
            .order_by(RoadmapItem.position)
        ):
            off_of.setdefault(r.roadmap_document_id, []).append(r)  # type: ignore[arg-type]
    wanted: dict[uuid.UUID, int] = {}
    for doc in roadmaps:
        numbers = [
            int(a["version"])
            for a in [e.row.applied or {} for e in by_doc.get(doc.id, [])]
            + [r.applied or {} for r in off_of.get(doc.id, [])]
            if a.get("version")
        ]
        if numbers:
            wanted[doc.id] = max(numbers)
    if not wanted:
        return []
    approved = {
        (v.document_id, v.number): v
        for v in await db.scalars(
            select(DocumentVersion).where(
                DocumentVersion.document_id.in_(list(wanted)),
                DocumentVersion.number.in_(set(wanted.values())),
            )
        )
    }
    out: list[SimpleAppliedVersion] = []
    for doc in roadmaps:
        n = wanted.get(doc.id)
        version = approved.get((doc.id, n)) if n is not None else None
        if n is None or version is None or version.approved_at is None:
            continue
        off = off_of.get(doc.id, [])
        differences: list[str] = []
        for e in by_doc.get(doc.id, []):
            a = e.row.applied or {}
            if a.get("version") != n:
                # A cut item the version does not list is off the plan, as the version has it.
                if e.status != "cut":
                    differences.append(f"{e.row.title} was added after version {n}")
                continue
            if e.status == "cut":
                differences.append(f"{e.row.title} was cut after version {n}")
                continue
            if "start" not in a or not (a.get("start") or a.get("end")):
                continue
            was = (_iso(a.get("start")), _iso(a.get("end")))
            now = (e.row.start_date, e.row.end_date)
            if now != was:
                differences.append(_difference(e.row.title, now, was, n))
        differences += await _not_added_rows(db, version)
        out.append(
            SimpleAppliedVersion(
                roadmap=SimpleDocRef(id=doc.id, slug=doc.slug, title=doc.title),
                version=n,
                approved_at=version.approved_at,
                href=f"/documents/{doc.slug}/v/{n}",
                matches=not differences,
                differences=differences,
                shipped=[r.title for r in off if r.plan_state == SHIPPED],
                moved_out=[r.title for r in off if r.plan_state == NEXT_PRD],
                can_apply=principal is not None
                and has_role(getattr(principal, "role", "viewer"), "approver"),
            )
        )
    return out


def _iso(value: Any) -> date | None:
    try:
        return date.fromisoformat(value) if value else None
    except ValueError:
        return None
