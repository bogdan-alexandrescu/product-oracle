"""The roadmap item diff as people read it (E3): which items a ref names, what a head is
compared with (the previous version, the approved plan or a named ref), the diff's rows
and an item's history. The comparison itself is oracle.roadmap.diff's, unchanged.

A ref is ``<slug>@<n>``: a roadmap version's items, or a PRD version's draft items (E1
Roadmap per draft; until those are stored, a PRD ref is 409, not ready). Both sides'
dates are compared as they stand now (items.live_milestones).
"""

import re
import uuid
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.docs import service as docs_service
from oracle.docs.models import Document, DocumentVersion
from oracle.roadmap import diff as diff_mod
from oracle.roadmap.items import live_milestones
from oracle.roadmap.models import RoadmapItem
from oracle.roadmap.schemas import (
    DocumentRef,
    ItemsDiffOut,
    ItemsOption,
    ItemsOptions,
    ItemsRef,
    RoadmapItemChange,
    RoadmapItemHistoryEntry,
    RoadmapItemHistoryOut,
)
from oracle.roadmap.views import version_items

REF = re.compile(r"^(?P<slug>[^@\s]+)@(?P<n>[1-9][0-9]{0,5})$")
BASES = ("previous", "approved")
HORIZON_ORDER = {"now": 0, "next": 1, "later": 2}
HISTORY_LIMIT = 50
# The diff's field names as the route shows them.
FIELD_NAMES = {"key": "item_key", "section_hash": "prd_section_text"}


class DiffError(Exception):
    def __init__(self, status_code: int, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code


@dataclass
class Side:
    kind: str
    document: Document
    version: DocumentVersion
    rows: list[RoadmapItem]

    @property
    def ref(self) -> str:
        return f"{self.document.slug}@{self.version.number}"

    @property
    def label(self) -> str:
        return label(self.kind, self.version.number)

    def out(self) -> ItemsRef:
        return ItemsRef(
            ref=self.ref,
            kind=self.kind,  # type: ignore[arg-type]
            label=self.label,
            document=DocumentRef(
                id=self.document.id,
                slug=self.document.slug,
                title=self.document.title,
                version=self.version.number,
                approved=self.version.approved_at is not None,
            ),
        )

    def option(self) -> ItemsOption:
        return ItemsOption(ref=self.ref, label=self.label)


def label(kind: str, n: int) -> str:
    return f"Draft v{n}" if kind == "prd_draft" else f"Roadmap v{n}"


async def resolve_ref(db: AsyncSession, ref: str) -> Side:
    """The document, version and items a ref names. 422 malformed; 404 unknown; 409 a PRD
    version whose draft items are not ready."""
    m = REF.match(ref or "")
    if m is None:
        raise DiffError(422, f"'{ref}' is not a ref: write <slug>@<version>")
    try:
        document = await docs_service.get_document_or_404(db, m["slug"])
        version = await docs_service.get_version_row(db, document, int(m["n"]))
    except docs_service.NotFoundError as e:
        raise DiffError(404, str(e)) from e
    if document.kind == "prd":
        # E1 Roadmap per draft stores a PRD version's draft items; none are stored yet.
        raise DiffError(409, f"Roadmap items for v{version.number} are not ready yet")
    if document.kind != "roadmap":
        raise DiffError(422, f"'{document.slug}' is a {document.kind}: it has no roadmap items")
    return Side("roadmap", document, version, await version_items(db, version))


async def _with_items(db: AsyncSession, head: Side, *, approved: bool) -> Side | None:
    """The roadmap's latest other version with items: earlier than the head (previous) or
    approved (the approved plan)."""
    q = select(DocumentVersion).where(
        DocumentVersion.document_id == head.document.id,
        DocumentVersion.id != head.version.id,
        select(RoadmapItem.id).where(RoadmapItem.roadmap_version_id == DocumentVersion.id).exists(),
    )
    if approved:
        q = q.where(DocumentVersion.approved_at.is_not(None))
    else:
        q = q.where(DocumentVersion.number < head.version.number)
    version = await db.scalar(q.order_by(DocumentVersion.number.desc()).limit(1))
    if version is None:
        return None
    return Side(head.kind, head.document, version, await version_items(db, version))


async def options(db: AsyncSession, head: Side) -> tuple[Side | None, Side | None]:
    return await _with_items(db, head, approved=False), await _with_items(db, head, approved=True)


async def resolve_base(
    db: AsyncSession, head: Side, base: str, previous: Side | None, approved: Side | None
) -> Side | None:
    if base == "previous":
        return previous
    if base == "approved":
        return approved
    if "@" not in base:
        raise DiffError(422, f"base must be previous, approved or a ref, not '{base}'")
    try:
        side = await resolve_ref(db, base)
    except DiffError as e:
        # A PRD's draft items are never another chain's base: say so, not "not ready".
        if e.status_code == 409:
            raise DiffError(422, f"'{base}' is not a version of '{head.document.slug}'") from e
        raise
    if side.document.id != head.document.id:
        raise DiffError(422, f"'{base}' is not a version of '{head.document.slug}'")
    return side


async def snapshots(db: AsyncSession, rows: list[RoadmapItem]) -> list[diff_mod.ItemSnapshot]:
    live = await live_milestones(db, rows)
    return [diff_mod.snapshot_from_row(r, live.get(r.id)) for r in rows]


def _value(value: Any) -> Any:
    return list(value) if isinstance(value, tuple) else value


def _field(change: diff_mod.FieldChange) -> dict[str, Any]:
    out: dict[str, Any] = {
        "field": FIELD_NAMES.get(change.field, change.field),
        "before": _value(change.before),
        "after": _value(change.after),
    }
    if change.field == "depends_on":
        before, after = list(change.before or ()), list(change.after or ())
        out["added"] = [d for d in after if d not in before]
        out["removed"] = [d for d in before if d not in after]
    return out


def _row(d: diff_mod.ItemDiff) -> dict[str, Any]:
    shown = d.head or d.base
    assert shown is not None
    if d.base is None or d.head is None:
        matched_by = None
    else:
        matched_by = "title" if d.renamed else "key"
    fields = [_field(c) for c in d.changes]
    dated = any(c.field == "milestone_date" for c in d.changes)
    # The date's state follows the date: a separate note only when the date did not move.
    notes = [_field(n) for n in d.notes if not (dated and n.field == "date_state")]
    return {
        "item_key": d.key,
        "change": d.status,
        "matched_by": matched_by,
        "title": shown.title,
        "base_horizon": d.base.horizon if d.base else None,
        "head_horizon": d.head.horizon if d.head else None,
        "base_position": d.base.position if d.base else None,
        "head_position": d.head.position if d.head else None,
        "fields": fields,
        "notes": notes,
    }


def _rank(horizon: str | None) -> int:
    return HORIZON_ORDER.get(horizon or "", len(HORIZON_ORDER))


def item_rows(diff: diff_mod.ItemsDiff) -> list[dict[str, Any]]:
    """The diff's rows: head items in head order; each dropped item right after the last
    head item whose horizon is its own or an earlier one (first when there is none), so
    it shows in the horizon it had."""
    present = [d for d in diff.items if d.head is not None]
    gone = [d for d in diff.items if d.head is None]
    after: dict[int, list[diff_mod.ItemDiff]] = {}
    for d in gone:
        limit = _rank(d.base.horizon if d.base else None)
        anchor = -1
        for j, p in enumerate(present):
            if _rank(p.head.horizon if p.head else None) <= limit:
                anchor = j
        after.setdefault(anchor, []).append(d)
    ordered = list(after.get(-1, []))
    for j, d in enumerate(present):
        ordered.append(d)
        ordered.extend(after.get(j, []))
    return [_row(d) for d in ordered]


async def diff_view(db: AsyncSession, head_ref: str, base: str = "previous") -> ItemsDiffOut:
    head = await resolve_ref(db, head_ref)
    previous, approved = await options(db, head)
    side = await resolve_base(db, head, base, previous, approved)
    out = ItemsDiffOut(
        head=head.out(),
        base=None,
        options=ItemsOptions(
            previous=previous.option() if previous else None,
            approved=approved.option() if approved else None,
        ),
        summary=None,
        items=[],
    )
    if side is None:
        return out
    diff = diff_mod.diff_items(await snapshots(db, side.rows), await snapshots(db, head.rows))
    out.base = side.out()
    out.summary = dict(diff.summary)
    out.items = [RoadmapItemChange.model_validate(r) for r in item_rows(diff)]
    return out


async def history(db: AsyncSession, prd: str, item_key: str) -> RoadmapItemHistoryOut:
    """The item across the roadmap versions whose items trace to the PRD, oldest first
    (the latest HISTORY_LIMIT), each against the one before; where it left, an entry
    ``present: false``. By key only: a rename starts a new history."""
    try:
        document = await docs_service.get_document_or_404(db, prd)
    except docs_service.NotFoundError as e:
        raise DiffError(404, str(e)) from e
    if document.kind != "prd":
        raise DiffError(422, f"'{document.slug}' is a {document.kind}, not a prd")
    traced = select(RoadmapItem.roadmap_version_id).where(
        RoadmapItem.prd_document_id == document.id
    )
    versions = list(
        await db.scalars(
            select(DocumentVersion)
            .where(DocumentVersion.id.in_(traced))
            .order_by(DocumentVersion.created_at.desc(), DocumentVersion.number.desc())
            .limit(HISTORY_LIMIT)
        )
    )[::-1]
    roadmaps: dict[uuid.UUID, Document] = {}
    entries: list[RoadmapItemHistoryEntry] = []
    last: diff_mod.ItemSnapshot | None = None
    for version in versions:
        row = await db.scalar(
            select(RoadmapItem).where(
                RoadmapItem.roadmap_version_id == version.id, RoadmapItem.item_key == item_key
            )
        )
        if row is None and last is None:
            continue
        roadmap = roadmaps.get(version.document_id) or await db.get(Document, version.document_id)
        assert roadmap is not None
        roadmaps[version.document_id] = roadmap
        common = {
            "ref": f"{roadmap.slug}@{version.number}",
            "kind": "roadmap",
            "label": label("roadmap", version.number),
            "approved": version.approved_at is not None,
            "at": version.created_at,
        }
        if row is None:
            entries.append(
                RoadmapItemHistoryEntry(**common, present=False, title=None, horizon=None,
                                 milestone_name=None, milestone_date=None, change="dropped")
            )  # fmt: skip
            last = None
            continue
        (snap,) = await snapshots(db, [row])
        change = "added" if last is None else diff_mod.diff_items([last], [snap]).items[0].status
        entries.append(
            RoadmapItemHistoryEntry(**common, present=True, title=snap.title, horizon=snap.horizon,
                             milestone_name=snap.milestone_name,
                             milestone_date=snap.milestone_date, change=change)
        )  # fmt: skip
        last = snap
    return RoadmapItemHistoryOut(
        prd=DocumentRef(id=document.id, slug=document.slug, title=document.title),
        item_key=item_key,
        entries=entries,
    )
