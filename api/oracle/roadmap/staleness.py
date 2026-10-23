"""Roadmap items go potentially stale when what they trace to changes (§11.5, CR-11).

The ``roadmap.items`` handler on :mod:`oracle.changes` runs after the trace lane's
``trace.mark_stale`` (which marks the roadmap *version* through its derived
dependencies) and marks the *items*:

- ``document_version`` on a PRD: items traced to an earlier version of that PRD whose
  section's content hash differs in the new version, or is gone (an item with no section
  goes stale on any new version);
- ``document_section``: items traced to that section of that PRD;
- ``requirement``, ``decision``, ``entity``, ``blocker_status``: items whose feature,
  requirements or blockers include the changed entity (or a batch's roots, or what the
  trace handler found downstream, ``data["trace"]["entity_ids"]``), and items whose PRD
  section links it.

``document_version`` on a roadmap stores the version's items (oracle.roadmap.items).

The handler writes only the items' freshness columns: an item's content, and an approved
roadmap version, are never rewritten. A person settles staleness: ``review`` (under
review) or ``reconcile`` (with a reason; the PRD's latest approved version and that
section's hash are recorded as what the item was reconciled against, and later changes
are judged against them; the item's own trace is kept as built).
"""

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.auth.deps import Principal
from oracle.docs.models import Document, DocumentVersion, Section
from oracle.models import AuditEvent
from oracle.roadmap import items as items_mod
from oracle.roadmap.models import RoadmapItem
from oracle.v2.models import ChangeEvent, DocumentSectionLink

HANDLER = "roadmap.items"
SUBJECTS = (
    "document_version",
    "document_section",
    "requirement",
    "decision",
    "entity",
    "blocker_status",
)
ENTITY_SUBJECTS = ("requirement", "decision", "entity", "blocker_status")
VERBS = {
    "entity_updated": "changed",
    "entity_confirmed": "was confirmed",
    "entity_rejected": "was rejected",
    "entity_deleted": "was deleted",
    "edge_created": "gained a link",
    "edge_deleted": "lost a link",
    "edge_updated": "had a link changed",
}
FROM_STATES = {
    "review": ("potentially_stale",),
    "reconcile": ("potentially_stale", "under_review"),
}


class Conflict(RuntimeError):
    pass


class Invalid(ValueError):
    pass


def _uuid(value: Any) -> uuid.UUID | None:
    try:
        return value if isinstance(value, uuid.UUID) else uuid.UUID(str(value))
    except ValueError:
        return None


def _entity_ids(event: ChangeEvent) -> set[uuid.UUID]:
    data = event.data or {}
    ids = {event.subject_id} if event.subject_id else set()
    for root in data.get("roots") or []:
        if isinstance(root, dict) and (u := _uuid(root.get("id"))):
            ids.add(u)
    for raw in (data.get("trace") or {}).get("entity_ids") or []:
        if u := _uuid(raw):
            ids.add(u)
    return ids


def _mark(item: RoadmapItem, event: ChangeEvent, reason: str, now: datetime) -> None:
    if item.freshness != "potentially_stale" or item.stale_since is None:
        item.stale_since = now
    item.freshness = "potentially_stale"
    item.caused_by_change_id = event.id
    reasons = list(item.stale_reasons or [])
    if reason not in reasons:
        reasons.append(reason)
    item.stale_reasons = reasons[-20:]


async def _by_prd_version(db: AsyncSession, event: ChangeEvent, found: dict) -> None:
    new = await db.get(DocumentVersion, event.subject_id)
    if new is None:
        return
    hashes = dict(
        (
            await db.execute(
                select(Section.section_key, Section.content_hash).where(
                    Section.version_id == new.id
                )
            )
        ).all()
    )
    rows = await db.scalars(
        select(RoadmapItem).where(
            RoadmapItem.prd_document_id == new.document_id,
            RoadmapItem.roadmap_version_id.is_not(None),
        )
    )
    for item in rows:
        version_id, section_hash = anchor(item)
        if version_id == new.id:
            continue
        key = item.prd_section_key
        if key is None:
            found[item.id] = (item, f"the PRD has a new version ({new.number})")
        elif key not in hashes:
            found[item.id] = (item, f"PRD section {key} is gone in version {new.number}")
        elif hashes[key] != section_hash:
            found[item.id] = (item, f"PRD section {key} changed in version {new.number}")


async def _by_section(db: AsyncSession, event: ChangeEvent, found: dict) -> None:
    key = (event.data or {}).get("section_key")
    if event.document_id is None or not key:
        return
    rows = await db.scalars(
        select(RoadmapItem).where(
            RoadmapItem.prd_document_id == event.document_id,
            RoadmapItem.prd_section_key == key,
            RoadmapItem.roadmap_version_id.is_not(None),
        )
    )
    for item in rows:
        found[item.id] = (item, f"PRD section {key} changed ({event.cause})")


async def _by_entities(db: AsyncSession, event: ChangeEvent, found: dict) -> None:
    ids = _entity_ids(event)
    if not ids:
        return
    what = event.subject_ref or f"{len(ids)} baseline items"
    verb = VERBS.get(event.cause, "changed")
    if event.subject_kind == "blocker_status":
        verb = "changed status"
    id_list = list(ids)
    rows = await db.scalars(
        select(RoadmapItem).where(
            or_(
                RoadmapItem.feature_id.in_(id_list),
                RoadmapItem.requirement_ids.overlap(id_list),
                RoadmapItem.blocker_ids.overlap(id_list),
            ),
            RoadmapItem.roadmap_version_id.is_not(None),
        )
    )
    for item in rows:
        found.setdefault(item.id, (item, f"{what} {verb}"))
    # Items whose PRD section links a changed entity.
    links = (
        await db.execute(
            select(DocumentSectionLink.version_id, DocumentSectionLink.section_key).where(
                DocumentSectionLink.entity_id.in_(id_list),
                DocumentSectionLink.version_id.is_not(None),
            )
        )
    ).all()
    if links:
        rows = await db.scalars(
            select(RoadmapItem).where(
                or_(
                    *(
                        and_(
                            RoadmapItem.prd_version_id == v,
                            RoadmapItem.prd_section_key == k,
                        )
                        for v, k in set(links)
                    )
                ),
                RoadmapItem.roadmap_version_id.is_not(None),
            )
        )
        for item in rows:
            found.setdefault(
                item.id,
                (item, f"PRD section {item.prd_section_key} links {what}, which changed"),
            )


async def mark_items(db: AsyncSession, event: ChangeEvent) -> None:
    """The ``roadmap.items`` change handler.

    A section change that is part of a version's change (``part_of_change_id``: the
    version import recorded both) is that change's: marked once, from the version, as
    ``trace.mark_stale`` does."""
    if event.subject_kind == "document_section" and (event.data or {}).get("part_of_change_id"):
        return
    found: dict[uuid.UUID, tuple[RoadmapItem, str]] = {}
    if event.subject_kind == "document_version" and event.subject_id is not None:
        document = await db.get(Document, event.document_id) if event.document_id else None
        if document is None:
            return
        if document.kind == "roadmap" and event.cause == "version_imported":
            version = await db.get(DocumentVersion, event.subject_id)
            if version is not None:
                await items_mod.on_roadmap_version(db, version, document)
            return
        if document.kind == "prd" and event.cause == "version_imported":
            await _by_prd_version(db, event, found)
    elif event.subject_kind == "document_section":
        await _by_section(db, event, found)
    elif event.subject_kind in ENTITY_SUBJECTS:
        await _by_entities(db, event, found)
    if not found:
        return
    now = datetime.now(UTC)
    for item, reason in found.values():
        _mark(item, event, reason, now)
    await db.flush()
    event.data = {
        **(event.data or {}),
        "roadmap": {
            "item_ids": [str(i) for i in found],
            "reasons": {str(i): r for i, (_, r) in found.items()},
        },
    }
    db.add(
        AuditEvent(
            actor="system",
            action="roadmap.items_marked_stale",
            entity="change_event",
            entity_id=event.id,
            data={"caused_by": event.actor, "items": len(found)},
        )
    )
    await db.flush()


# --- human actions --------------------------------------------------------------------------


def anchor(item: RoadmapItem) -> tuple[uuid.UUID | None, str | None]:
    """The PRD version and section hash the item is judged against: what a person last
    reconciled it with, else what it was built from."""
    if item.reconciled_version_id is not None:
        return item.reconciled_version_id, item.reconciled_section_hash
    return item.prd_version_id, item.prd_section_hash


async def _reconcile_anchor(db: AsyncSession, item: RoadmapItem) -> dict[str, Any]:
    """Record the PRD's latest approved version (and that section's hash) as what the
    item was reconciled against, when it is at least as recent as the item's anchor. The
    item's own trace (the version it was built from) is never rewritten."""
    version_id, section_hash = anchor(item)
    before = {
        "version_id": str(version_id) if version_id else None,
        "section_hash": section_hash,
    }
    if item.prd_document_id is None:
        return before
    latest = await db.scalar(
        select(DocumentVersion)
        .where(
            DocumentVersion.document_id == item.prd_document_id,
            DocumentVersion.approved_at.is_not(None),
        )
        .order_by(DocumentVersion.number.desc())
        .limit(1)
    )
    current = (
        await db.scalar(select(DocumentVersion.number).where(DocumentVersion.id == version_id))
        if version_id
        else None
    )
    if latest is None or (current is not None and latest.number < current):
        return before
    item.reconciled_version_id = latest.id
    item.reconciled_section_hash = None
    if item.prd_section_key:
        item.reconciled_section_hash = await db.scalar(
            select(Section.content_hash).where(
                Section.version_id == latest.id, Section.section_key == item.prd_section_key
            )
        )
    return before


async def act(
    db: AsyncSession,
    principal: Principal,
    action: str,
    items: list[RoadmapItem],
    reason: str | None,
) -> list[dict[str, Any]]:
    """Review or reconcile items. The caller commits. Conflict when none is in a state
    the action applies to."""
    if action == "reconcile" and not (reason or "").strip():
        raise Invalid("reconciling needs a reason")
    targets = [i for i in items if i.freshness in FROM_STATES[action]]
    if not targets:
        states = sorted({i.freshness for i in items}) or ["no items"]
        raise Conflict(f"nothing to {action}: {', '.join(states)}")
    now = datetime.now(UTC)
    changed = []
    for item in targets:
        entry: dict[str, Any] = {"item": item.item_key, "id": str(item.id), "from": item.freshness}
        if action == "reconcile":
            entry["anchor_before"] = await _reconcile_anchor(db, item)
            item.freshness = "reconciled"
            item.reconciled_by = principal.id
            item.reconciled_at = now
        else:
            item.freshness = "under_review"
        if reason:
            item.note = reason
        entry["to"] = item.freshness
        changed.append(entry)
    await db.flush()
    await audit.record(
        db,
        principal,
        f"roadmap.items.{action}",
        "document",
        targets[0].roadmap_document_id,
        {"items": changed, "reason": reason},
    )
    await db.flush()
    return changed
