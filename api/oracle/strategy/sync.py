"""The strategy stack in the graph, written when a version is approved (H4 §4).

- A product strategy version: one ``strategy_choice`` entity per choice (key
  ``<document-slug>-<choice-id>``, attrs ``{stance, document_id, version, section_key,
  rank}``, confirmed), ``derived_from`` edges goal -> focus choice and ``affects`` edges
  stop choice -> feature, all written as the approving owner (origin ``user``, locked). A
  choice missing from a newer approved version is rejected with its edges.
- A vision version: one ``assumption`` entity per belief (key ``<slug>-<belief-id>``,
  attrs ``{vision_document_id, belief_id, status}``); a dropped belief is rejected.
- A roadmap version approved after a strategy: one ``artifact_dependencies`` row per
  (item, focus choice) path item -> feature -> supports -> goal -> derived_from -> choice,
  so a strategy change marks the roadmap potentially stale through the trace handler.

The writes go through the baseline service in one change batch: one ``entity`` change
event per approval, which the existing staleness handler walks. A kept choice whose
content did not change only has its ``version`` attr moved, recording no change (its
dependents are not made stale by a re-approval).
"""

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.auth.deps import Principal
from oracle.baseline import service as baseline
from oracle.baseline.models import Edge, Entity
from oracle.docs.models import Document, DocumentVersion
from oracle.roadmap.models import RoadmapItem
from oracle.strategy import frontmatter
from oracle.v2.models import ArtifactDependency

CHOICE = "strategy_choice"
# A sync's own entity changes run no drift check from the change handler: the approval
# runs one when the sync is done.
SYNCING = "strategy.syncing"


def choice_key(slug: str, choice_id: str) -> str:
    return f"{slug}-{choice_id}"


async def on_approval(
    db: AsyncSession, principal: Principal, document: Document, version: DocumentVersion
) -> None:
    db.info[SYNCING] = True
    try:
        if document.kind == "strategy":
            await sync_strategy(db, principal, document, version)
        elif document.kind == "vision":
            await sync_vision(db, principal, document, version)
        elif document.kind == "roadmap":
            await record_roadmap_dependencies(db, version)
    finally:
        db.info.pop(SYNCING, None)


def _writer(principal: Principal, document: Document, version: DocumentVersion):
    return baseline.Writer(principal, "user", reason=f"{document.slug} v{version.number} approved")


async def _upsert(
    db: AsyncSession,
    writer: baseline.Writer,
    type_: str,
    key: str,
    title: str,
    attrs: dict[str, Any],
    silent: tuple[str, ...] = (),
) -> Entity:
    """Create or confirm the entity. A change only in the ``silent`` attrs is written
    without a revision or change event."""
    entity = await baseline.find_entity(db, type_, key)
    if entity is None:
        result = await baseline.create_entity(
            db, writer, type_=type_, key=key, title=title, attrs=attrs, status="confirmed"
        )
        assert result.entity is not None
        return result.entity
    loud = {k: v for k, v in attrs.items() if k not in silent}
    if (
        entity.title != title
        or entity.status != "confirmed"
        or any(entity.attrs.get(k) != v for k, v in loud.items())
    ):
        await baseline.update_entity(
            db, writer, entity, {"title": title, "attrs": attrs, "status": "confirmed"}
        )
    elif any(entity.attrs.get(k) != attrs[k] for k in silent):
        entity.attrs = {**entity.attrs, **{k: attrs[k] for k in silent}}
        await db.flush()
    return entity


async def _reject(db: AsyncSession, writer: baseline.Writer, entity: Entity) -> None:
    if entity.status != "rejected":
        await baseline.update_entity(db, writer, entity, {"status": "rejected"})


async def _set_edges(
    db: AsyncSession,
    writer: baseline.Writer,
    wanted: set[tuple[uuid.UUID, uuid.UUID, str]],
    owned: list[Edge],
) -> None:
    """Confirm the ``wanted`` edges (creating the missing ones) and reject the ``owned``
    edges no longer wanted."""
    for src, dst, type_ in sorted(wanted, key=str):
        edge = await baseline.find_edge(db, src, dst, type_)
        if edge is None:
            await baseline.create_edge(
                db, writer, src_id=src, dst_id=dst, type_=type_, status="confirmed"
            )
        elif edge.status != "confirmed":
            await baseline.update_edge(db, writer, edge, {"status": "confirmed"})
    for edge in owned:
        if (edge.src_id, edge.dst_id, edge.type) not in wanted and edge.status != "rejected":
            await baseline.update_edge(db, writer, edge, {"status": "rejected"})


async def _keyed(db: AsyncSession, type_: str, keys: set[str]) -> dict[str, Entity]:
    if not keys:
        return {}
    rows = await db.scalars(select(Entity).where(Entity.type == type_, Entity.key.in_(keys)))
    return {e.key: e for e in rows}


async def document_choices(db: AsyncSession, document_id: uuid.UUID) -> list[Entity]:
    """Every strategy_choice entity a strategy document ever wrote."""
    return list(
        await db.scalars(
            select(Entity).where(
                Entity.type == CHOICE, Entity.attrs["document_id"].astext == str(document_id)
            )
        )
    )


async def sync_strategy(
    db: AsyncSession, principal: Principal, document: Document, version: DocumentVersion
) -> None:
    writer = _writer(principal, document, version)
    choices, _ = frontmatter.read_choices(version.front_matter or {})
    goals = await _keyed(db, "goal", {g for c in choices for g in c.goals})
    features = await _keyed(db, "feature", {f for c in choices for f in c.features})
    async with baseline.batched_changes(db):
        kept: set[uuid.UUID] = set()
        wanted: set[tuple[uuid.UUID, uuid.UUID, str]] = set()
        for c in choices:
            entity = await _upsert(
                db,
                writer,
                CHOICE,
                choice_key(document.slug, c.id),
                c.title,
                {
                    "stance": c.stance,
                    "document_id": str(document.id),
                    "version": version.number,
                    "section_key": c.section_key,
                    "rank": c.rank,
                },
                silent=("version",),
            )
            kept.add(entity.id)
            if c.stance == "focus":
                wanted |= {(goals[g].id, entity.id, "derived_from") for g in c.goals if g in goals}
            else:
                wanted |= {
                    (entity.id, features[f].id, "affects") for f in c.features if f in features
                }
        everyone = await document_choices(db, document.id)
        ids = [e.id for e in everyone]
        owned = list(
            await db.scalars(
                select(Edge).where(
                    ((Edge.type == "derived_from") & Edge.dst_id.in_(ids))
                    | ((Edge.type == "affects") & Edge.src_id.in_(ids))
                )
            )
        )
        await _set_edges(db, writer, wanted, owned)
        for entity in everyone:
            if entity.id not in kept:
                await _reject(db, writer, entity)


async def sync_vision(
    db: AsyncSession, principal: Principal, document: Document, version: DocumentVersion
) -> None:
    writer = _writer(principal, document, version)
    beliefs, _ = frontmatter.read_beliefs(version.front_matter or {})
    async with baseline.batched_changes(db):
        kept: set[uuid.UUID] = set()
        for b in beliefs:
            entity = await _upsert(
                db,
                writer,
                "assumption",
                f"{document.slug}-{b.id}",
                b.statement,
                {"vision_document_id": str(document.id), "belief_id": b.id, "status": b.status},
            )
            kept.add(entity.id)
        rows = await db.scalars(
            select(Entity).where(
                Entity.type == "assumption",
                Entity.attrs["vision_document_id"].astext == str(document.id),
            )
        )
        for entity in list(rows):
            if entity.id not in kept:
                await _reject(db, writer, entity)


async def focus_paths(
    db: AsyncSession, feature_ids: set[uuid.UUID]
) -> dict[uuid.UUID, set[uuid.UUID]]:
    """Feature id -> the confirmed focus choices it reaches through a confirmed goal it
    supports (feature -> supports -> goal -> derived_from -> choice)."""
    if not feature_ids:
        return {}
    supports = (
        await db.execute(
            select(Edge.src_id, Edge.dst_id)
            .join(Entity, Entity.id == Edge.dst_id)
            .where(
                Edge.type == "supports",
                Edge.status == "confirmed",
                Edge.src_id.in_(feature_ids),
                Entity.type == "goal",
                Entity.status == "confirmed",
            )
        )
    ).all()
    goal_ids = {g for _, g in supports}
    derived = (
        await db.execute(
            select(Edge.src_id, Edge.dst_id)
            .join(Entity, Entity.id == Edge.dst_id)
            .where(
                Edge.type == "derived_from",
                Edge.status == "confirmed",
                Edge.src_id.in_(goal_ids),
                Entity.type == CHOICE,
                Entity.status == "confirmed",
                Entity.attrs["stance"].astext == "focus",
            )
        )
    ).all()
    choices_of_goal: dict[uuid.UUID, set[uuid.UUID]] = {}
    for goal, choice in derived:
        choices_of_goal.setdefault(goal, set()).add(choice)
    out: dict[uuid.UUID, set[uuid.UUID]] = {}
    for feature, goal in supports:
        out.setdefault(feature, set()).update(choices_of_goal.get(goal, set()))
    return out


async def record_roadmap_dependencies(db: AsyncSession, version: DocumentVersion) -> int:
    """One dependency row per (item, focus choice) path of the approved roadmap version;
    none twice. Returns the rows added."""
    items = list(
        await db.scalars(
            select(RoadmapItem)
            .where(
                RoadmapItem.roadmap_version_id == version.id, RoadmapItem.feature_id.is_not(None)
            )
            .order_by(RoadmapItem.position)
        )
    )
    paths = await focus_paths(db, {i.feature_id for i in items if i.feature_id})
    if not any(paths.values()):
        return 0
    existing = {
        (d.upstream_entity_id, d.note)
        for d in await db.scalars(
            select(ArtifactDependency).where(
                ArtifactDependency.document_version_id == version.id,
                ArtifactDependency.upstream_entity_id.is_not(None),
            )
        )
    }
    added = 0
    for item in items:
        note = f"roadmap item {item.item_key}"
        for choice_id in sorted(paths.get(item.feature_id, set()), key=str):  # type: ignore[arg-type]
            if (choice_id, note) in existing:
                continue
            db.add(
                ArtifactDependency(
                    document_version_id=version.id, upstream_entity_id=choice_id, note=note
                )
            )
            existing.add((choice_id, note))
            added += 1
    await db.flush()
    return added
