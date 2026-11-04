"""one-roadmap-many-prds (the owner, Nov 4): the company has ONE roadmap, never one per PRD.

Many PRDs (one per area of focus) feed it; links between features stay within it.

- **The company roadmap** (:func:`active`, :func:`ensure`): a roadmap document with
  ``company_roadmap`` set, at most one not in Trash (a partial unique index). An owner or
  approver creates it empty (``POST /v1/roadmaps/company``, the first-run step); while one
  exists, Simple (Roadmap, Home, Priorities) reads it alone (:func:`feeding_ids`), and older
  per-PRD roadmaps stay readable as history. With none, every roadmap feeds Simple as before.
- **A PRD's roadmap run** writes the company roadmap's next version (oracle.runs.service's
  default target): its items file adds and updates only its own PRD's items, every other
  PRD's items are carried as they are from the latest version, approved or not
  (:func:`carry_other_prds`, from oracle.roadmap.items.import_items), so a second PRD's run
  merges onto the first one's draft and never overwrites it.
- **One team's queue** (:func:`queue`): every item on the company roadmap, across PRDs, in
  one capacity queue: team size x focus (the ``team_capacity`` setting) person-weeks a week;
  items in milestone order (Now before Next before Later, then the milestone's first place
  on the roadmap), then the company goal order (goal positions), then priority (highest
  first). An item's effort is its declared ``effort_weeks`` (else 1 week).
- **A replaced PRD** (:func:`replace`): ``replaced_by`` names the PRDs that replace it; it is
  read-only (oracle.docs.service refuses a new version), its items no longer feed the
  roadmap, and its verified schedule bases follow their item to the PRD the item now sits
  under on the company roadmap (:func:`carry_bases`), with the note ``carried from <old
  PRD title>`` and their verified status; the old PRD keeps its own.
"""

import math
import uuid
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, company_time
from oracle.auth.deps import Principal
from oracle.baseline.goal_order import goal_sort_key
from oracle.baseline.models import Edge, Entity
from oracle.docs.models import Document, DocumentVersion
from oracle.roadmap.models import RoadmapItem, ScheduleBasis

TITLE = "Product roadmap"
SLUG = "product-roadmap"
CAPACITY_KEY = "team_capacity"
DEFAULT_CAPACITY = {"team_size": 1, "focus": 1.0}
HORIZON_ORDER = {"now": 0, "next": 1, "later": 2}
CARRIED = "carried from {title}"


class CompanyError(Exception):
    status_code = 422


class Invalid(CompanyError):
    status_code = 422


class NotFound(CompanyError):
    status_code = 404


async def active(db: AsyncSession) -> Document | None:
    """The company's one roadmap not in Trash, if there is one."""
    return await db.scalar(
        select(Document).where(
            Document.company_roadmap.is_(True),
            Document.kind == "roadmap",
            Document.deleted_at.is_(None),
        )
    )


async def ensure(db: AsyncSession, principal: Principal) -> tuple[Document, bool]:
    """(the company roadmap, made now): made empty when none exists. The caller commits."""
    found = await active(db)
    if found is not None:
        return found, False
    slug, n = SLUG, 1
    while await db.scalar(select(Document.id).where(Document.slug == slug)) is not None:
        n += 1
        slug = f"{SLUG}-{n}"
    doc = Document(slug=slug, title=TITLE, kind="roadmap", status="draft", company_roadmap=True)
    db.add(doc)
    await db.flush()
    await audit.record(db, principal, "roadmap.company_created", "document", doc.id,
                       {"slug": slug})  # fmt: skip
    return doc, True


async def feeding_ids(db: AsyncSession, roadmap_ids: list[uuid.UUID]) -> list[uuid.UUID]:
    """Of ``roadmap_ids``, those that feed Simple: the company roadmap alone while there is
    one (older per-PRD roadmaps are history), else all of them."""
    company = await active(db)
    if company is None:
        return roadmap_ids
    return [i for i in roadmap_ids if i == company.id]


async def replaced_prd_ids(db: AsyncSession) -> set[uuid.UUID]:
    """The PRDs a person marked replaced: their items no longer feed the roadmap."""
    return set(
        await db.scalars(
            select(Document.id).where(Document.kind == "prd", Document.replaced_by != [])
        )
    )


async def refs(db: AsyncSession, ids: list[uuid.UUID]) -> list[dict[str, Any]]:
    """{id, slug, title} of the documents ``ids``, in that order (those not found left out)."""
    if not ids:
        return []
    found = {
        d.id: d
        for d in await db.scalars(
            select(Document).where(Document.id.in_(ids), Document.deleted_at.is_(None))
        )
    }
    return [{"id": i, "slug": found[i].slug, "title": found[i].title} for i in ids if i in found]


async def _latest_version(db: AsyncSession, document_id: uuid.UUID) -> DocumentVersion | None:
    return await db.scalar(
        select(DocumentVersion)
        .where(DocumentVersion.document_id == document_id)
        .order_by(DocumentVersion.number.desc())
        .limit(1)
    )


async def _items_version(db: AsyncSession, document_id: uuid.UUID) -> DocumentVersion | None:
    """The company roadmap's latest version with items (the draft a run writes onto)."""
    return await db.scalar(
        select(DocumentVersion)
        .where(
            DocumentVersion.document_id == document_id,
            DocumentVersion.id.in_(
                select(RoadmapItem.roadmap_version_id).where(
                    RoadmapItem.roadmap_document_id == document_id
                )
            ),
        )
        .order_by(DocumentVersion.number.desc())
        .limit(1)
    )


async def carry_other_prds(
    db: AsyncSession, version: DocumentVersion, prd_id: uuid.UUID | None, start: int
) -> int:
    """A company roadmap version written from one PRD keeps every other PRD's items as the
    latest earlier version with items has them (approved or still a draft). The caller
    flushes. Returns how many were carried."""
    from oracle.roadmap.items import COPIED

    previous = await db.scalar(
        select(DocumentVersion)
        .where(
            DocumentVersion.document_id == version.document_id,
            DocumentVersion.number < version.number,
            DocumentVersion.id.in_(
                select(RoadmapItem.roadmap_version_id).where(
                    RoadmapItem.roadmap_document_id == version.document_id
                )
            ),
        )
        .order_by(DocumentVersion.number.desc())
        .limit(1)
    )
    if previous is None:
        return 0
    rows = await db.scalars(
        select(RoadmapItem)
        .where(RoadmapItem.roadmap_version_id == previous.id)
        .order_by(RoadmapItem.position)
    )
    carried = 0
    for old in rows:
        if old.prd_document_id == prd_id:
            continue
        values = {c: getattr(old, c) for c in COPIED}
        values["position"] = start + carried
        db.add(
            RoadmapItem(
                **values,
                milestone=old.milestone,
                roadmap_document_id=version.document_id,
                roadmap_version_id=version.id,
                note=old.note,
            )
        )
        carried += 1
    return carried


# --- one team's capacity queue -------------------------------------------------------


@dataclass
class Queued:
    item: RoadmapItem
    prd: dict[str, Any] | None
    effort_weeks: float
    start: date
    end: date


def _effort(item: RoadmapItem) -> float:
    economics = item.economics or {}
    for where in (economics.get("declared") or {}, economics.get("baseline") or {}):
        value = where.get("effort_weeks")
        if isinstance(value, int | float) and not isinstance(value, bool) and value > 0:
            return float(value)
    return 1.0


def _priority(item: RoadmapItem) -> float:
    score = (item.priority or {}).get("score")
    if score is None:
        score = (item.economics or {}).get("priority_score")
    return float(score) if isinstance(score, int | float) and not isinstance(score, bool) else 0.0


async def capacity(db: AsyncSession) -> dict[str, Any]:
    from oracle.tenant_settings_api import get_setting

    value = await get_setting(db, CAPACITY_KEY)
    return {**DEFAULT_CAPACITY, **(value if isinstance(value, dict) else {})}


async def queue(db: AsyncSession) -> tuple[dict[str, Any], list[Queued]]:
    """(capacity, every item on the company roadmap planned as one team's queue)."""
    cap = await capacity(db)
    company = await active(db)
    if company is None:
        return cap, []
    version = await _items_version(db, company.id)
    if version is None:
        return cap, []
    replaced = await replaced_prd_ids(db)
    rows = [
        r
        for r in await db.scalars(
            select(RoadmapItem)
            .where(RoadmapItem.roadmap_version_id == version.id)
            .order_by(RoadmapItem.position)
        )
        if r.prd_document_id not in replaced and r.plan_state is None
    ]
    # Milestone order: horizon, then where the milestone first shows on the roadmap.
    first: dict[str, tuple[int, int]] = {}
    for r in rows:
        name = (r.milestone or {}).get("name") if isinstance(r.milestone, dict) else None
        if name and name not in first:
            first[name] = (HORIZON_ORDER.get(r.horizon, 3), r.position)
    # The company goal order: the first goal each item's feature supports.
    feature_ids = {r.feature_id for r in rows if r.feature_id}
    goal_of: dict[uuid.UUID, tuple] = {}
    if feature_ids:
        found = (
            await db.execute(
                select(Edge.src_id, Entity)
                .join(Entity, Entity.id == Edge.dst_id)
                .where(
                    Edge.src_id.in_(feature_ids),
                    Edge.type == "supports",
                    Edge.status != "rejected",
                    Entity.type == "goal",
                    Entity.status != "rejected",
                )
            )
        ).all()
        for src, goal in found:
            key = goal_sort_key(goal)
            if src not in goal_of or key < goal_of[src]:
                goal_of[src] = key
    last = (True, math.inf)

    def order(r: RoadmapItem) -> tuple:
        name = (r.milestone or {}).get("name") if isinstance(r.milestone, dict) else None
        place = first.get(name) if name else None
        return (
            place is None,
            place or (HORIZON_ORDER.get(r.horizon, 3), r.position),
            goal_of.get(r.feature_id, last) if r.feature_id else last,
            -_priority(r),
            r.position,
        )

    prds = {
        p["id"]: p
        for p in await refs(db, list({r.prd_document_id for r in rows if r.prd_document_id}))
    }
    per_week = max(float(cap["team_size"]) * float(cap["focus"]), 0.01)
    today = company_time.now().date()
    done = 0.0
    out: list[Queued] = []
    for r in sorted(rows, key=order):
        effort = _effort(r)
        start = today + timedelta(days=round(done / per_week * 7))
        done += effort
        end = today + timedelta(days=round(done / per_week * 7))
        out.append(Queued(r, prds.get(r.prd_document_id), effort, start, end))
    return cap, out


def _day(d: date) -> str:
    return f"{d:%b} {d.day}, {d.year}"


async def run_queue(db: AsyncSession, prd_id: uuid.UUID | None) -> list[dict[str, Any]]:
    """What a PRD's roadmap run reads of the shared queue: every item on the company
    roadmap with its place in one team's queue ({key, title, prd, start, end, ours}); the
    other PRDs' items go into the draft's plan tables as they are (Dates from: team queue)."""
    company_doc = await active(db)
    if company_doc is None:
        return []
    _, rows = await queue(db)
    return [
        {
            "key": q.item.item_key,
            "title": q.item.title,
            "prd": (q.prd or {}).get("title", ""),
            "start": q.start.isoformat(),
            "end": q.end.isoformat(),
            "ours": q.item.prd_document_id == prd_id,
        }
        for q in rows
    ]


def queue_lines(rows: list[dict[str, Any]]) -> list[str]:
    """The shared queue in the run's prompt, dates month first."""
    if not rows:
        return []
    out = [
        "",
        "The company roadmap is one roadmap that every PRD feeds, planned as one team's "
        "queue (team size x focus, milestone order, then the company goal order, then "
        "priority). Each item's place in that queue (yours are marked *):",
    ]
    for r in rows:
        mark = "*" if r["ours"] else "-"
        out.append(
            f"{mark} {r['title']} ({r['prd']}): "
            f"{_day(date.fromisoformat(r['start']))} to {_day(date.fromisoformat(r['end']))}"
        )
    out.append(
        "Add or change only this PRD's items; every other PRD's item stays as it is, and "
        "the plan tables list it as below."
    )
    return out


# --- a replaced PRD ------------------------------------------------------------------


async def replace(
    db: AsyncSession, principal: Principal, prd: Document, slugs: list[str]
) -> list[ScheduleBasis]:
    """Mark ``prd`` replaced by the PRDs ``slugs`` (in order; empty: no longer replaced) and
    carry its verified bases to the PRDs its items now sit under. The caller commits."""
    if prd.kind != "prd":
        raise Invalid("only a PRD can be replaced")
    by: list[Document] = []
    for slug in dict.fromkeys(slugs):
        doc = await db.scalar(
            select(Document).where(Document.slug == slug, Document.deleted_at.is_(None))
        )
        if doc is None or doc.kind != "prd":
            raise Invalid(f"'{slug}' is not a PRD")
        if doc.id == prd.id:
            raise Invalid("a PRD cannot replace itself")
        if doc.replaced_by:
            raise Invalid(f"{doc.title} is itself replaced")
        by.append(doc)
    before = list(prd.replaced_by or [])
    prd.replaced_by = [d.id for d in by]
    await audit.record(db, principal, "document.replaced_by", "document", prd.id,
                       {"before": [str(i) for i in before],
                        "after": [str(d.id) for d in by]})  # fmt: skip
    await db.flush()
    return await carry_bases(db, prd)


async def carry_bases(db: AsyncSession, old: Document) -> list[ScheduleBasis]:
    """The verified bases of the replaced PRD ``old`` scoped to an item follow that item to
    the replacing PRD it sits under on the company roadmap (the latest version with items),
    once each: same reference, kind, date and item, still verified, with the note
    ``carried from <old title>``. The old PRD keeps its own."""
    if not old.replaced_by:
        return []
    company = await active(db)
    version = await _items_version(db, company.id) if company else None
    if version is None:
        return []
    under: dict[str, uuid.UUID] = {}
    for r in await db.scalars(
        select(RoadmapItem).where(
            RoadmapItem.roadmap_version_id == version.id,
            RoadmapItem.prd_document_id.in_(old.replaced_by),
        )
    ):
        under.setdefault(r.item_key, r.prd_document_id)
    if not under:
        return []
    note = CARRIED.format(title=old.title)
    made: list[ScheduleBasis] = []
    for b in await db.scalars(
        select(ScheduleBasis).where(
            ScheduleBasis.prd_document_id == old.id,
            ScheduleBasis.status == "verified",
            ScheduleBasis.item_key.in_(list(under)),
        )
    ):
        target = under[b.item_key]
        exists = await db.scalar(
            select(ScheduleBasis.id).where(
                ScheduleBasis.prd_document_id == target,
                ScheduleBasis.item_key == b.item_key,
                ScheduleBasis.reference == b.reference,
                ScheduleBasis.supports_date == b.supports_date,
                ScheduleBasis.status == "verified",
            )
        )
        if exists is not None:
            continue
        row = ScheduleBasis(
            kind=b.kind,
            reference=b.reference,
            supports_date=b.supports_date,
            detail=f"{b.detail} ({note})" if b.detail else note,
            prd_document_id=target,
            item_key=b.item_key,
            status=b.status,
            verified_by=b.verified_by,
            verified_at=b.verified_at,
        )
        db.add(row)
        made.append(row)
    await db.flush()
    return made


async def carry_for_version(db: AsyncSession, version: DocumentVersion) -> None:
    """After a company roadmap version's items are stored: the bases of every replaced PRD
    whose items moved onto a replacing PRD follow them."""
    company = await active(db)
    if company is None or company.id != version.document_id:
        return
    for old in await db.scalars(
        select(Document).where(Document.kind == "prd", Document.replaced_by != [])
    ):
        await carry_bases(db, old)
