"""Edits to the approved plan, proposed as a new roadmap version (#346).

Owner decision 2026-10-22: roadmap edits on the approved plan are proposed as a new
roadmap version; nobody edits an approved version in place. A change set is opened on the
roadmap's approved version and holds its changes in order (:mod:`oracle.roadmap.schemas`
``PlanChange``): add an item (a Baseline feature or a new one), move it between Now, Next
and Later, defer it (to Later), cut it with a reason, reorder it within its horizon.

:func:`apply` is pure: the base's items plus the changes. :func:`propose` imports the next
roadmap version (the base's text plus a Plan changes section, so the document diff shows
them) and stores its items: the base's rows, copied with their trace and freshness, moved
and reordered as the changes say, without the cut ones, and the added ones. The version
then goes through the existing review: only the document's decider (when named) approves
it, and approving it makes it the live plan.

A change set whose base is no longer the approved version is stale: it is refused (409)
until it is discarded and the plan edited again.
"""

import re
import uuid
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.auth.deps import Principal
from oracle.baseline.models import Entity
from oracle.docs import service as docs_service
from oracle.docs.models import Document, DocumentVersion, Section
from oracle.roadmap import diff as item_diff
from oracle.roadmap import items as items_mod
from oracle.roadmap import schedule, views
from oracle.roadmap.models import HORIZONS, RoadmapChangeSet, RoadmapItem
from oracle.roadmap.schemas import (
    AddChange,
    ChangeSetDiffItem,
    ChangeSetOut,
    CutChange,
    CutItem,
    DeferChange,
    MoveChange,
    PlanChange,
    PlannedItem,
    ReorderChange,
)

SECTION_KEY = "plan-changes"
LABEL = {"now": "Now", "next": "Next", "later": "Later"}


class ChangeSetError(Exception):
    status_code = 422


class Stale(ChangeSetError):
    status_code = 409


class Conflict(ChangeSetError):
    status_code = 409


@dataclass
class Planned:
    key: str
    title: str
    horizon: str
    outcome: str | None = None
    feature_id: uuid.UUID | None = None
    base: RoadmapItem | None = None
    deferred: bool = False


@dataclass
class Applied:
    # Per horizon, in order.
    lanes: dict[str, list[Planned]]
    cut: list[tuple[Planned, str]] = field(default_factory=list)

    def items(self) -> list[tuple[int, Planned]]:
        out: list[tuple[int, Planned]] = []
        for h in HORIZONS:
            out.extend((len(out), p) for p in self.lanes[h])
        return out


def slug(title: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:80] or "item"


def apply(base: list[RoadmapItem], changes: list[Any]) -> Applied:
    """The base's items (by position) plus the changes, in order. Raises
    :class:`ChangeSetError` naming the change that does not apply."""
    lanes: dict[str, list[Planned]] = {h: [] for h in HORIZONS}
    for row in sorted(base, key=lambda r: r.position):
        lanes[row.horizon].append(
            Planned(row.item_key, row.title, row.horizon, row.outcome, row.feature_id, row)
        )
    out = Applied(lanes)
    cut: dict[str, str] = {}

    def find(key: str) -> Planned:
        for lane in lanes.values():
            for p in lane:
                if p.key == key:
                    return p
        if key in cut:
            raise ChangeSetError(f"{key} is cut from the plan already")
        raise ChangeSetError(f"{key} is not an item of the plan")

    for c in changes:
        if isinstance(c, AddChange):
            key = c.key or slug(c.title)
            if key in cut or any(p.key == key for lane in lanes.values() for p in lane):
                raise ChangeSetError(f"the plan has an item {key} already")
            lanes[c.horizon].append(Planned(key, c.title, c.horizon, c.outcome, c.feature_id))
            continue
        item = find(c.key)
        lanes[item.horizon].remove(item)
        if isinstance(c, CutChange):
            cut[item.key] = c.reason
            out.cut.append((item, c.reason))
        elif isinstance(c, MoveChange | DeferChange):
            item.horizon = c.horizon if isinstance(c, MoveChange) else "later"
            item.deferred = isinstance(c, DeferChange)
            lanes[item.horizon].append(item)
        elif isinstance(c, ReorderChange):
            lanes[item.horizon].insert(min(c.position, len(lanes[item.horizon])), item)
    return out


# --- reads ----------------------------------------------------------------------------------


async def approved_version(db: AsyncSession, document: Document) -> DocumentVersion | None:
    """The roadmap's live plan: its latest approved version."""
    return await db.scalar(
        select(DocumentVersion)
        .where(
            DocumentVersion.document_id == document.id,
            DocumentVersion.approved_at.is_not(None),
        )
        .order_by(DocumentVersion.number.desc())
        .limit(1)
    )


async def get(db: AsyncSession, document: Document, set_id: uuid.UUID) -> RoadmapChangeSet:
    row = await db.scalar(
        select(RoadmapChangeSet).where(
            RoadmapChangeSet.id == set_id, RoadmapChangeSet.roadmap_document_id == document.id
        )
    )
    if row is None:
        err = ChangeSetError("Change set not found")
        err.status_code = 404
        raise err
    return row


async def list_sets(
    db: AsyncSession, document: Document, status: str | None = None
) -> list[RoadmapChangeSet]:
    query = select(RoadmapChangeSet).where(RoadmapChangeSet.roadmap_document_id == document.id)
    if status is not None:
        query = query.where(RoadmapChangeSet.status == status)
    order = (RoadmapChangeSet.created_at.desc(), RoadmapChangeSet.id)
    return list(await db.scalars(query.order_by(*order).limit(50)))


async def check_base(db: AsyncSession, document: Document, row: RoadmapChangeSet) -> None:
    """Refuse a change set whose base is no longer the approved version."""
    base = await db.get(DocumentVersion, row.base_version_id)
    live = await approved_version(db, document)
    if live is None or live.id != row.base_version_id:
        now = f"version {live.number} is approved now" if live else "no version is approved now"
        raise Stale(
            f"The approved plan changed: these changes were made on version {base.number} "
            f"and {now}. Discard them and edit the plan again."
        )


def _parse(changes: list[dict[str, Any]]) -> list[Any]:
    from pydantic import TypeAdapter

    return TypeAdapter(list[PlanChange]).validate_python(changes)


def _snapshot(p: Planned, position: int, lane_at: int) -> item_diff.ItemSnapshot:
    return item_diff.ItemSnapshot(
        key=p.key, title=p.title, outcome=p.outcome, horizon=p.horizon, position=position,
        rank=lane_at,
    )  # fmt: skip


def _diff(base: list[RoadmapItem], applied: Applied) -> tuple[list[ChangeSetDiffItem], dict]:
    """E3's one item diff (oracle.roadmap.diff) of the base and the proposal."""
    lane_of: dict[str, int] = {}
    before: list[item_diff.ItemSnapshot] = []
    for h in HORIZONS:
        rows = [r for r in sorted(base, key=lambda r: r.position) if r.horizon == h]
        for at, r in enumerate(rows):
            lane_of[r.item_key] = at
            before.append(
                _snapshot(Planned(r.item_key, r.title, r.horizon, r.outcome), r.position, at)
            )
    after = [_snapshot(p, n, applied.lanes[p.horizon].index(p)) for n, p in applied.items()]
    reasons = {p.key: reason for p, reason in applied.cut}
    result = item_diff.diff_items(before, after, counted=("title", "outcome", "horizon"))
    out = []
    for d in result.items:
        snap = d.head or d.base
        moved = d.changed("horizon")
        reordered = (
            d.status == "unchanged"
            and d.head is not None
            and lane_of.get(d.base.key) != d.head.rank
        )
        out.append(
            ChangeSetDiffItem(
                key=d.key,
                title=snap.title,
                status=d.status,
                from_horizon=moved.before if moved else None,
                to_horizon=moved.after if moved else None,
                fields=[c.field for c in d.changes],
                reordered=reordered,
                reason=reasons.get(d.key) if d.status == "dropped" else None,
            )
        )
    summary = dict(result.summary)
    summary["reordered"] = sum(1 for d in out if d.reordered)
    return out, summary


async def view(db: AsyncSession, document: Document, row: RoadmapChangeSet) -> ChangeSetOut:
    from oracle.review.state import effective_policy

    await db.refresh(row)  # updated_at is the database's
    base = await db.get(DocumentVersion, row.base_version_id)
    rows = await views.version_items(db, base)
    changes = _parse(row.changes)
    applied = apply(rows, changes)
    diff, summary = _diff(rows, applied)
    proposed = (
        await db.get(DocumentVersion, row.proposed_version_id) if row.proposed_version_id else None
    )
    policy = await effective_policy(db, document)
    return ChangeSetOut(
        id=row.id,
        roadmap=document.slug,
        roadmap_title=document.title,
        base_version=base.number,
        status=row.status,  # type: ignore[arg-type]
        changes=changes,
        items=[
            PlannedItem(
                key=p.key,
                title=p.title,
                horizon=p.horizon,
                position=n,
                outcome=p.outcome,
                feature_id=p.feature_id,
                new=p.base is None,
                deferred=p.deferred,
            )  # fmt: skip
            for n, p in applied.items()
        ],
        cut=[
            CutItem(key=p.key, title=p.title, horizon=p.horizon, reason=r) for p, r in applied.cut
        ],
        diff=diff,
        summary=summary,
        proposed_version=proposed.number if proposed else None,
        approved=proposed is not None and proposed.approved_at is not None,
        decider_id=policy.decider_id,
        lock_version=row.lock_version,
        created_by=row.created_by,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


# --- writes ---------------------------------------------------------------------------------


async def open_set(
    db: AsyncSession, principal: Principal, document: Document
) -> tuple[RoadmapChangeSet, bool]:
    """The roadmap's draft change set; a new one on the approved version when it has none.
    Returns it and whether it was made now."""
    row = await db.scalar(
        select(RoadmapChangeSet)
        .where(
            RoadmapChangeSet.roadmap_document_id == document.id,
            RoadmapChangeSet.status == "draft",
        )
        .with_for_update()
    )
    if row is not None:
        return row, False
    base = await approved_version(db, document)
    if base is None:
        raise ChangeSetError(
            f"'{document.slug}' has no approved version: edit the plan once a version is approved"
        )
    row = RoadmapChangeSet(
        roadmap_document_id=document.id,
        base_version_id=base.id,
        status="draft",
        changes=[],
        created_by=principal.user_id or principal.id,
    )
    db.add(row)
    await db.flush()
    await audit.record(
        db, principal, "roadmap.change_set_opened", "roadmap_change_set", row.id,
        {"roadmap": document.slug, "base_version": base.number},
    )  # fmt: skip
    return row, True


def _draft(row: RoadmapChangeSet) -> None:
    if row.status != "draft":
        raise Conflict(f"This change set is {row.status}: edit the plan again to change it")


async def _stored(db: AsyncSession, changes: list[Any]) -> list[dict[str, Any]]:
    """The changes as stored: an added item takes its key (a Baseline feature's, else
    from its title)."""
    out = []
    for c in changes:
        if isinstance(c, AddChange) and c.feature_id is not None:
            feature = await db.get(Entity, c.feature_id)
            if feature is None or feature.type != "feature":
                raise ChangeSetError("feature_id is not a Baseline feature")
            c = c.model_copy(update={"key": c.key or feature.key})
        elif isinstance(c, AddChange):
            c = c.model_copy(update={"key": c.key or slug(c.title)})
        out.append(c.model_dump(mode="json", exclude_none=True))
    return out


async def update(
    db: AsyncSession,
    principal: Principal,
    document: Document,
    row: RoadmapChangeSet,
    changes: list[Any],
    lock_version: int,
) -> None:
    _draft(row)
    if lock_version != row.lock_version:
        raise Conflict("The change set changed since it was loaded")
    await check_base(db, document, row)
    stored = await _stored(db, changes)
    base = await db.get(DocumentVersion, row.base_version_id)
    apply(await views.version_items(db, base), _parse(stored))
    before = list(row.changes)
    row.changes = stored
    row.lock_version += 1
    await audit.record(
        db, principal, "roadmap.change_set_updated", "roadmap_change_set", row.id,
        {"roadmap": document.slug, "before": before, "after": stored},
    )  # fmt: skip


async def discard(
    db: AsyncSession, principal: Principal, document: Document, row: RoadmapChangeSet
) -> None:
    _draft(row)
    row.status = "discarded"
    row.lock_version += 1
    await audit.record(
        db, principal, "roadmap.change_set_discarded", "roadmap_change_set", row.id,
        {"roadmap": document.slug, "changes": len(row.changes)},
    )  # fmt: skip


def _summary_lines(base_number: int, changes: list[Any], titles: dict[str, str]) -> str:
    lines = [f"Proposed as changes to version {base_number}:", ""]
    for c in changes:
        name = c.title if isinstance(c, AddChange) else titles.get(c.key, c.key)
        if isinstance(c, AddChange):
            lines.append(f"- Added {name} to {LABEL[c.horizon]}")
        elif isinstance(c, MoveChange):
            lines.append(f"- Moved {name} to {LABEL[c.horizon]}")
        elif isinstance(c, DeferChange):
            lines.append(f"- Deferred {name} to Later")
        elif isinstance(c, CutChange):
            lines.append(f"- Cut {name}: {c.reason.strip()}")
        elif isinstance(c, ReorderChange):
            lines.append(f"- Moved {name} to place {c.position + 1} in its horizon")
    return "\n".join(lines)


async def _markdown(db: AsyncSession, base: DocumentVersion, body: str) -> str:
    from oracle.jobs.service import compose_markdown

    sections = [
        s
        for s in await db.scalars(
            select(Section).where(Section.version_id == base.id).order_by(Section.ordinal)
        )
        if s.section_key != SECTION_KEY
    ]
    added = SimpleNamespace(section_key=SECTION_KEY, level=2, heading="Plan changes", body_md=body)
    at = next((n for n, s in enumerate(sections) if s.section_key == "sources"), len(sections))
    return compose_markdown(
        base.front_matter or {}, [*sections[:at], added, *sections[at:]], {}, []
    )


async def propose(
    db: AsyncSession, principal: Principal, document: Document, row: RoadmapChangeSet
) -> DocumentVersion:
    """Import the next roadmap version from the change set and store its items."""
    _draft(row)
    await check_base(db, document, row)
    changes = _parse(row.changes)
    if not changes:
        raise ChangeSetError("Nothing to propose: the change set has no changes")
    base = await db.get(DocumentVersion, row.base_version_id)
    base_rows = await views.version_items(db, base)
    applied = apply(base_rows, changes)
    titles = {r.item_key: r.title for r in base_rows}
    markdown = await _markdown(db, base, _summary_lines(base.number, changes, titles))
    latest = await db.scalar(
        select(DocumentVersion.number)
        .where(DocumentVersion.document_id == document.id)
        .order_by(DocumentVersion.number.desc())
        .limit(1)
    )
    set_id, base_number = row.id, base.number
    # The import commits the version (oracle.docs.service.import_draft); the items follow.
    result = await docs_service.import_draft(
        db, document.slug, markdown, principal, kind="roadmap",
        source_version_id=base.source_version_id, base_version=latest,
        cause="roadmap_change_set",
    )  # fmt: skip
    version = await db.scalar(
        select(DocumentVersion).where(
            DocumentVersion.document_id == document.id,
            DocumentVersion.number == result.version.number,
        )
    )
    await db.execute(delete(RoadmapItem).where(RoadmapItem.roadmap_version_id == version.id))
    prd_ids = {r.prd_document_id for r in base_rows}
    bases = {p: await schedule.verified_bases(db, p) for p in prd_ids}
    template = base_rows[0] if base_rows else None
    for position, p in applied.items():
        if p.base is not None:
            old = p.base
            fields = {c: getattr(old, c) for c in items_mod.COPIED}
            fields.update(
                position=position,
                horizon=p.horizon,
                milestone=items_mod.recheck_date(
                    old.milestone, bases[old.prd_document_id], old.item_key, p.horizon
                ),
                note=f"from version {base_number}" + (", deferred" if p.deferred else ""),
            )
        else:
            fields = {
                "item_key": p.key, "position": position, "title": p.title,
                "outcome": p.outcome, "horizon": p.horizon, "feature_id": p.feature_id,
                "track_id": template.track_id if template else None,
                "prd_document_id": template.prd_document_id if template else None,
                "prd_version_id": base.source_version_id,
                "trace": [{"target": "feature", "id": str(p.feature_id), "via": "change_set"}]
                if p.feature_id else [],
                "note": f"added to version {base_number}'s plan",
            }  # fmt: skip
        db.add(
            RoadmapItem(roadmap_document_id=document.id, roadmap_version_id=version.id, **fields)
        )
    row = await db.get(RoadmapChangeSet, set_id, with_for_update=True)
    row.status = "proposed"
    row.proposed_version_id = version.id
    row.lock_version += 1
    await audit.record(
        db, principal, "roadmap.change_set_proposed", "roadmap_change_set", row.id,
        {"roadmap": document.slug, "base_version": base_number, "version": version.number,
         "changes": row.changes},
    )  # fmt: skip
    await db.flush()
    return version
