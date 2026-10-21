"""Drift down the strategy stack (H4 §5): deterministic, no model call.

Rules, measured against the latest approved product strategy:

- ``goal_without_strategy`` (warning): a confirmed goal with no confirmed ``derived_from``
  edge to a confirmed focus choice;
- ``focus_without_goal`` (warning): a confirmed focus choice no confirmed goal derives from;
- ``outside_strategy`` (warning): an item of the latest approved roadmap version of an
  active track whose feature's goals are all without the strategy, or that serves none;
- ``stopped_but_planned`` (high): such an item in Now or Next whose feature a confirmed
  stop choice affects;
- ``strategy_review_due`` / ``vision_review_due`` (warning): today is on or after the
  approved version's ``review_on`` (default: a year after its approval);
- ``no_strategy`` (info): no approved strategy; then only the vision rule runs.

Each check upserts the findings it sees (``last_seen_at``), resolves the open ones it no
longer sees, and leaves waived ones waived until their subject changes again (a goal or
choice edited, a document approved again: ``subject_version``). It runs daily per
company from the run ticker, after a strategy, vision or roadmap approval, and from the
``strategy.drift`` change handler after a goal, feature or choice change. Drift is
advisory: nothing waits on a finding.
"""

import logging
import uuid
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from typing import Any

from sqlalchemy import func, select, text
from sqlalchemy.dialects.postgresql import distinct_on
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import changes
from oracle.baseline.models import Edge, Entity, EntityRevision, Evidence
from oracle.docs.models import Document, DocumentVersion, Section
from oracle.roadmap.models import ProductTrack, RoadmapItem
from oracle.strategy import frontmatter
from oracle.strategy.models import StrategyCheck, StrategyFinding
from oracle.strategy.schemas import (
    StackBelief,
    StackChoice,
    StackCounts,
    StackDocument,
    StackGoal,
    StackNode,
    StackStrategy,
    StackVision,
    StrategyStackOut,
    Unaligned,
    UnalignedItem,
)
from oracle.strategy.sync import CHOICE, SYNCING
from oracle.tenancy import current_tenant

log = logging.getLogger(__name__)

__all__ = ["StrategyCheck", "check_due", "run_check", "stack", "inbox_row"]

DAILY = timedelta(days=1)
REVIEW_EVERY = timedelta(days=365)
PLANNED = ("now", "next")
HANDLER = "strategy.drift"
# Entity types whose changes can move a finding.
WATCHED = {"goal", "feature", CHOICE}
INBOX_HREF = "/company/strategy"


@dataclass
class Found:
    kind: str
    severity: str
    subject_kind: str
    subject_id: uuid.UUID | None
    subject_ref: str
    subject_version: str | None = None
    detail: dict[str, Any] = field(default_factory=dict)

    @property
    def key(self) -> tuple[str, str, uuid.UUID | None]:
        return (self.kind, self.subject_kind, self.subject_id)


@dataclass
class Approved:
    document: Document
    version: DocumentVersion

    @property
    def review_on(self) -> date:
        due = frontmatter.review_on(self.version.front_matter or {})
        if due is not None:
            return due
        approved = self.version.approved_at or datetime.now(UTC)
        return (approved + REVIEW_EVERY).date()


@dataclass
class Graph:
    """What the rules and the stack read, loaded once."""

    strategy: Approved | None
    vision: Approved | None
    goals: dict[uuid.UUID, Entity]
    choices: dict[uuid.UUID, Entity]
    # goal id -> focus choice ids it derives from (confirmed edges, confirmed ends).
    derived: dict[uuid.UUID, set[uuid.UUID]]
    # stop choice id -> feature ids it affects.
    stopped: dict[uuid.UUID, set[uuid.UUID]]
    # feature id -> confirmed goal ids it supports.
    supports: dict[uuid.UUID, set[uuid.UUID]]
    items: list[RoadmapItem]
    features: dict[uuid.UUID, Entity]

    @property
    def aligned_goals(self) -> set[uuid.UUID]:
        return {g for g, cs in self.derived.items() if cs}

    def focus(self) -> list[Entity]:
        return [c for c in self.choices.values() if c.attrs.get("stance") == "focus"]

    def item_goals(self, item: RoadmapItem) -> set[uuid.UUID]:
        return self.supports.get(item.feature_id, set()) if item.feature_id else set()

    def outside(self, item: RoadmapItem) -> bool:
        goals = self.item_goals(item)
        return not goals or not (goals & self.aligned_goals)

    def stopping(self, item: RoadmapItem) -> list[uuid.UUID]:
        """The stop choices affecting the item's feature, when the item is in Now or Next."""
        if item.horizon not in PLANNED or item.feature_id is None:
            return []
        return [c for c, fs in self.stopped.items() if item.feature_id in fs]


async def _latest_approved(db: AsyncSession, kind: str) -> Approved | None:
    row = (
        await db.execute(
            select(Document, DocumentVersion)
            .join(DocumentVersion, DocumentVersion.document_id == Document.id)
            .where(Document.kind == kind, DocumentVersion.approved_at.is_not(None))
            .order_by(DocumentVersion.approved_at.desc(), DocumentVersion.number.desc())
            .limit(1)
        )
    ).first()
    return Approved(row[0], row[1]) if row else None


async def _planned_items(db: AsyncSession) -> list[RoadmapItem]:
    """Items of the latest approved version of each active track's roadmap."""
    roadmaps = list(
        await db.scalars(
            select(ProductTrack.roadmap_document_id).where(
                ProductTrack.status == "active", ProductTrack.roadmap_document_id.is_not(None)
            )
        )
    )
    if not roadmaps:
        return []
    latest = (
        select(DocumentVersion.document_id, func.max(DocumentVersion.number).label("n"))
        .where(
            DocumentVersion.document_id.in_(set(roadmaps)),
            DocumentVersion.approved_at.is_not(None),
        )
        .group_by(DocumentVersion.document_id)
        .subquery()
    )
    versions = select(DocumentVersion.id).join(
        latest,
        (latest.c.document_id == DocumentVersion.document_id)
        & (latest.c.n == DocumentVersion.number),
    )
    return list(
        await db.scalars(
            select(RoadmapItem)
            .where(RoadmapItem.roadmap_version_id.in_(versions))
            .order_by(RoadmapItem.roadmap_document_id, RoadmapItem.position)
        )
    )


async def load(db: AsyncSession) -> Graph:
    strategy = await _latest_approved(db, "strategy")
    vision = await _latest_approved(db, "vision")
    goals = {
        e.id: e
        for e in await db.scalars(
            select(Entity).where(Entity.type == "goal", Entity.status == "confirmed")
        )
    }
    choices: dict[uuid.UUID, Entity] = {}
    if strategy is not None:
        choices = {
            e.id: e
            for e in await db.scalars(
                select(Entity)
                .where(
                    Entity.type == CHOICE,
                    Entity.status == "confirmed",
                    Entity.attrs["document_id"].astext == str(strategy.document.id),
                )
                .order_by(Entity.key)
            )
        }
    edges = list(
        await db.scalars(
            select(Edge).where(
                Edge.status == "confirmed",
                Edge.type.in_(("derived_from", "affects", "supports")),
            )
        )
    )
    derived: dict[uuid.UUID, set[uuid.UUID]] = {g: set() for g in goals}
    stopped: dict[uuid.UUID, set[uuid.UUID]] = {
        c: set() for c, e in choices.items() if e.attrs.get("stance") == "stop"
    }
    supports: dict[uuid.UUID, set[uuid.UUID]] = {}
    for e in edges:
        if e.type == "derived_from" and e.src_id in goals and e.dst_id in choices:
            if choices[e.dst_id].attrs.get("stance") == "focus":
                derived[e.src_id].add(e.dst_id)
        elif e.type == "affects" and e.src_id in stopped:
            stopped[e.src_id].add(e.dst_id)
        elif e.type == "supports" and e.dst_id in goals:
            supports.setdefault(e.src_id, set()).add(e.dst_id)
    items = await _planned_items(db)
    feature_ids = {i.feature_id for i in items if i.feature_id} | {
        f for fs in stopped.values() for f in fs
    }
    features = (
        {e.id: e for e in await db.scalars(select(Entity).where(Entity.id.in_(feature_ids)))}
        if feature_ids
        else {}
    )
    return Graph(strategy, vision, goals, choices, derived, stopped, supports, items, features)


async def _revisions(db: AsyncSession, ids: set[uuid.UUID]) -> dict[uuid.UUID, str]:
    """Each entity's latest revision id: what it was when a finding was last seen."""
    if not ids:
        return {}
    rows = (
        await db.execute(
            select(EntityRevision.entity_id, EntityRevision.id)
            .where(EntityRevision.entity_id.in_(ids))
            .ext(distinct_on(EntityRevision.entity_id))
            .order_by(EntityRevision.entity_id, EntityRevision.created_at.desc())
        )
    ).all()
    return {e: str(r) for e, r in rows}


def _review_due(kind: str, approved: Approved | None, today: date) -> list[Found]:
    if approved is None or today < approved.review_on:
        return []
    return [
        Found(
            kind,
            "warning",
            "document",
            approved.document.id,
            approved.document.slug,
            subject_version=str(approved.version.id),
            detail={
                "review_on": approved.review_on.isoformat(),
                "version": approved.version.number,
            },
        )
    ]


async def evaluate(db: AsyncSession, g: Graph | None = None) -> list[Found]:
    g = g or await load(db)
    today = datetime.now(UTC).date()
    found = _review_due("vision_review_due", g.vision, today)
    if g.strategy is None:
        return [*found, Found("no_strategy", "info", "document", None, "strategy")]
    found += _review_due("strategy_review_due", g.strategy, today)
    aligned = g.aligned_goals
    for goal in sorted(g.goals.values(), key=lambda e: e.key):
        if goal.id not in aligned:
            found.append(
                Found("goal_without_strategy", "warning", "entity", goal.id, f"goal:{goal.key}")
            )
    derived_choices = {c for cs in g.derived.values() for c in cs}
    for choice in g.focus():
        if choice.id not in derived_choices:
            found.append(
                Found("focus_without_goal", "warning", "entity", choice.id,
                      f"{CHOICE}:{choice.key}")
            )  # fmt: skip
    for item in g.items:
        where = {"roadmap_document_id": str(item.roadmap_document_id), "horizon": item.horizon,
                 "title": item.title, "draft": False}  # fmt: skip
        if g.outside(item):
            found.append(
                Found("outside_strategy", "warning", "roadmap_item", item.id, item.item_key,
                      detail=where)
            )  # fmt: skip
        stops = g.stopping(item)
        if stops:
            found.append(
                Found("stopped_but_planned", "high", "roadmap_item", item.id, item.item_key,
                      detail={**where, "choice_ids": [str(c) for c in stops]})
            )  # fmt: skip
    revisions = await _revisions(
        db, {f.subject_id for f in found if f.subject_kind == "entity" and f.subject_id}
    )
    for f in found:
        if f.subject_kind == "entity" and f.subject_id:
            f.subject_version = revisions.get(f.subject_id)
    return found


async def run_check(db: AsyncSession, cause: str) -> dict[str, int]:
    """Recompute the company's findings (no commit). Returns what it opened and resolved."""
    await db.execute(
        text("SELECT pg_advisory_xact_lock(hashtext(:k))"),
        {"k": f"oracle-strategy-drift:{current_tenant(db)}"},
    )
    g = await load(db)
    found = await evaluate(db, g)
    strategy_version = g.strategy.version.id if g.strategy else None
    now = datetime.now(UTC)
    rows = {
        (r.kind, r.subject_kind, r.subject_id): r for r in await db.scalars(select(StrategyFinding))
    }
    opened = resolved = 0
    seen = set()
    for f in found:
        seen.add(f.key)
        row = rows.get(f.key)
        if row is None:
            db.add(
                StrategyFinding(
                    kind=f.kind, severity=f.severity, subject_kind=f.subject_kind,
                    subject_id=f.subject_id, subject_ref=f.subject_ref,
                    subject_version=f.subject_version, strategy_version_id=strategy_version,
                    detail=f.detail, status="open", first_seen_at=now, last_seen_at=now,
                )
            )  # fmt: skip
            opened += 1
            continue
        reopen = row.status == "resolved" or (
            row.status == "waived" and row.subject_version != f.subject_version
        )
        if reopen:
            row.status = "open"
            row.first_seen_at = now
            row.resolved_at = None
            row.waived_by = row.waived_at = row.waive_reason = None
            opened += 1
        row.severity = f.severity
        row.subject_ref = f.subject_ref
        row.subject_version = f.subject_version
        row.strategy_version_id = strategy_version
        row.detail = f.detail
        row.last_seen_at = now
    for key, row in rows.items():
        if key not in seen and row.status == "open":
            row.status = "resolved"
            row.resolved_at = now
            resolved += 1
    db.add(StrategyCheck(cause=cause, opened=opened, resolved=resolved))
    await db.flush()
    return {"opened": opened, "resolved": resolved}


async def check_due(db: AsyncSession) -> bool:
    """The ticker's daily call: check when no check ran in the last day (no commit)."""
    last = await db.scalar(select(func.max(StrategyCheck.created_at)))
    if last is not None and datetime.now(UTC) - last < DAILY:
        return False
    await run_check(db, "daily")
    return True


async def on_change(db: AsyncSession, event: changes.ChangeEvent) -> None:
    """The ``strategy.drift`` handler: re-check after a goal, feature or choice change. A
    failing check is logged and rolled back to its savepoint; it never aborts the change."""
    if db.info.get(SYNCING):
        return
    data = event.data or {}
    types = {(data.get("entity") or {}).get("type")} | {
        (r.get("entity") or {}).get("type") for r in data.get("roots") or []
    }
    if not types & WATCHED:
        return
    try:
        async with db.begin_nested():
            await run_check(db, "change")
    except Exception:  # noqa: BLE001 - drift is advisory; the change stands
        log.exception("strategy drift check after change %s failed", event.id)


changes.register_handler(HANDLER, on_change, subjects={"entity"})


# --- reads --------------------------------------------------------------------------


def _doc(a: Approved) -> StackDocument:
    return StackDocument(
        slug=a.document.slug,
        title=a.document.title,
        version=a.version.number,
        approved_at=a.version.approved_at,
    )


async def _section_text(db: AsyncSession, version_id: uuid.UUID, key: str) -> str | None:
    body = await db.scalar(
        select(Section.body_text).where(
            Section.version_id == version_id, Section.section_key == key
        )
    )
    return body.strip() if body and body.strip() else None


def _node(e: Entity) -> StackNode:
    return StackNode(id=e.id, key=e.key, title=e.title)


async def _vision(db: AsyncSession, a: Approved) -> StackVision:
    beliefs, _ = frontmatter.read_beliefs(a.version.front_matter or {})
    keys = [f"{a.document.slug}-{b.id}" for b in beliefs]
    counts = dict(
        (
            await db.execute(
                select(Entity.key, func.count(Evidence.id))
                .outerjoin(Evidence, Evidence.entity_id == Entity.id)
                .where(Entity.type == "assumption", Entity.key.in_(keys))
                .group_by(Entity.key)
            )
        ).all()
    )
    years = (a.version.front_matter or {}).get("horizon_years")
    return StackVision(
        document=_doc(a),
        headline=await _section_text(db, a.version.id, "headline"),
        horizon_years=years if isinstance(years, int) and not isinstance(years, bool) else None,
        beliefs=[
            StackBelief(
                id=b.id,
                statement=b.statement,
                status=b.status,  # type: ignore[arg-type]
                evidence=counts.get(f"{a.document.slug}-{b.id}", 0),
            )
            for b in beliefs
        ],  # fmt: skip
        review_on=a.review_on,
    )


async def stack(db: AsyncSession) -> StrategyStackOut:
    g = await load(db)
    rows = list(await db.scalars(select(StrategyFinding)))
    open_rows = [r for r in rows if r.status == "open" and r.severity != "info"]
    counts = StackCounts(
        open=len(open_rows),
        high=sum(r.severity == "high" for r in open_rows),
        waived=sum(r.status == "waived" for r in rows),
    )
    vision = await _vision(db, g.vision) if g.vision else None
    if g.strategy is None:
        return StrategyStackOut(vision=vision, strategy=None, unaligned=Unaligned(), counts=counts)

    def open_for(choice_id: uuid.UUID) -> int:
        return sum(
            r.subject_id == choice_id or str(choice_id) in (r.detail or {}).get("choice_ids", [])
            for r in open_rows
        )

    prefix = f"{g.strategy.document.slug}-"
    choices = []
    for c in sorted(g.choices.values(), key=lambda e: (e.attrs.get("rank") or 0, e.key)):
        stance = c.attrs.get("stance")
        if stance == "focus":
            goals = [g.goals[x] for x, cs in g.derived.items() if c.id in cs]
            features: list[Entity] = []
            items = sum(1 for i in g.items if g.item_goals(i) & {x.id for x in goals})
        else:
            goals = []
            features = [g.features[f] for f in g.stopped.get(c.id, set()) if f in g.features]
            items = sum(1 for i in g.items if c.id in g.stopping(i))
        choices.append(
            StackChoice(
                entity_id=c.id,
                id=c.key.removeprefix(prefix),
                title=c.title,
                stance=stance,  # type: ignore[arg-type]
                goals=[
                    StackGoal(
                        **_node(x).model_dump(), items=sum(x.id in g.item_goals(i) for i in g.items)
                    )
                    for x in sorted(goals, key=lambda e: e.key)
                ],
                features=[_node(x) for x in sorted(features, key=lambda e: e.key)],
                items=items,
                open_findings=open_for(c.id),
            )
        )
    aligned = g.aligned_goals
    return StrategyStackOut(
        vision=vision,
        strategy=StackStrategy(
            document=_doc(g.strategy),
            summary=await _section_text(db, g.strategy.version.id, "summary"),
            review_on=g.strategy.review_on,
            choices=choices,
        ),
        unaligned=Unaligned(
            goals=[
                _node(x)
                for x in sorted(g.goals.values(), key=lambda e: e.key)
                if x.id not in aligned
            ],
            items=[
                UnalignedItem(roadmap_item_id=i.id, title=i.title, draft=False)
                for i in g.items
                if g.outside(i)
            ],
        ),  # fmt: skip
        counts=counts,
    )


async def inbox_row(db: AsyncSession) -> dict[str, Any] | None:
    """Owners' Inbox row: the open findings (``no_strategy`` is a Plan banner only), the
    high ones, where they are read, and when the newest was first seen."""
    rows = list(
        await db.scalars(
            select(StrategyFinding).where(
                StrategyFinding.status == "open", StrategyFinding.severity != "info"
            )
        )
    )
    if not rows:
        return None
    return {
        "new_findings": len(rows),
        "high": sum(r.severity == "high" for r in rows),
        "href": INBOX_HREF,
        "since": max(r.first_seen_at for r in rows),
    }
