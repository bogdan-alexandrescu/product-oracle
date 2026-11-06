"""Simple Goal map (build-goal-map): the goals, the guardrail, the areas of focus in the
owner's order, the gated milestones (track_milestones, the records Simple Roadmap draws)
and the features serving them.

- Goals: confirmed ``goal`` entities with a numeric ``target`` attr, in the one goal order
  (oracle.baseline.goal_order: their priority, never what one builds on); today's reading
  is their latest ``goal_measurements`` row. ``attrs``: ``metric``, ``unit`` ("$" or ""),
  ``math``, ``builds_on`` (goal ids) and ``target_history`` (newest first). A goal marked
  ``attrs.guardrail`` is never one of them.
- The guardrail: a confirmed ``constraint`` entity with ``attrs.guardrail``, else the first
  guardrail goal; its last 7 days are its measurements.
- A milestone's gate reads its goal (``goal_id``): the reading and the 7 days are the goal's
  measurements, never a stored copy. Its status: not measured yet without a reading; met
  when the 7 days all hold the threshold; missed when due before today and not met; else
  on track at three quarters of the threshold or more, at risk below. A gate nobody has
  confirmed yet is only proposed. A goal milestone with no threshold has no gate yet.
- The milestones are the goal milestones of Simple Roadmap (``roadmap_id`` and ``goal_id``
  set, not deleted), in the order of what each comes after (``after_id``, picked by people).
"""

import uuid
from datetime import date, timedelta
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import distinct_on
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

from oracle import company_time
from oracle.auth.models import User
from oracle.baseline.goal_order import sort_goals
from oracle.baseline.goals import COMPARISONS, meets
from oracle.baseline.models import Entity, GoalMeasurement
from oracle.docs.models import Document
from oracle.roadmap import company
from oracle.roadmap.models import RoadmapItem, TrackMilestone
from oracle.simple.goal_milestones import _next_code
from oracle.simple.models import FocusArea, MilestoneFeature

Status = Literal["met", "on_track", "at_risk", "missed", "not_measured", "no_gate"]
Lift = Literal["helping", "not_helping", "not_measured"]


class GmHistory(BaseModel):
    date: str
    text: str
    by: str


class GmGoal(BaseModel):
    id: uuid.UUID
    name: str
    measure: str
    target: float
    current: float | None
    unit: str
    status: Status
    math: str
    builds_on: list[uuid.UUID]
    history: list[GmHistory]


class GmArea(BaseModel):
    id: uuid.UUID
    name: str
    lever: str


class GmGuardrail(BaseModel):
    name: str
    rule: str
    current: float | None
    days: list[float | None]
    held: bool


class GmMilestone(BaseModel):
    id: uuid.UUID
    name: str
    goal: uuid.UUID
    measure: str
    # None: no gate yet.
    threshold: float | None
    unit: str
    current: float | None
    status: Status
    areas: list[uuid.UUID]
    depends: list[uuid.UUID]
    month: str
    # The due date in words ("Oct 31"), when the milestone has one.
    due: str | None
    days: list[float | None]
    confirmed: str | None
    # When it was confirmed, in words ("Nov 2").
    confirmed_on: str | None
    proposed: bool


class GmLink(BaseModel):
    """What a feature is expected to do for one milestone, and what it did."""

    milestone: uuid.UUID
    expected: str
    confidence: Literal["High", "Medium", "Low"]
    measured: str | None
    lift: Lift


class GmFeature(BaseModel):
    id: uuid.UUID
    name: str
    area: uuid.UUID | None
    milestones: list[uuid.UUID]
    lever: str
    expected: str
    confidence: Literal["High", "Medium", "Low"]
    released: bool
    measured: str | None
    lift: Lift
    links: list[GmLink]


class GoalMapOut(BaseModel):
    goals: list[GmGoal]
    areas: list[GmArea]
    guardrail: GmGuardrail | None
    milestones: list[GmMilestone]
    features: list[GmFeature]
    today: str
    reps: int | None
    # Who a proposed milestone is sent to for approval (the first owner by name).
    approver: str | None
    can_edit: bool


class AreaIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    lever: str = Field(default="", max_length=120)


class AreaOrderIn(BaseModel):
    ids: list[uuid.UUID]


class GoalTargetIn(BaseModel):
    target: float = Field(gt=0)


class ProposeIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    goal: uuid.UUID
    threshold: float = Field(gt=0)
    areas: list[uuid.UUID] = []
    # The milestone it comes after; not sent: the goal's previous milestone.
    after: uuid.UUID | None = None


class AttachIn(BaseModel):
    feature: uuid.UUID
    milestone: uuid.UUID
    # The cell's area: the feature is filed under it when it has no area yet.
    area: uuid.UUID
    expected: str = Field(default="", max_length=120)
    confidence: Literal["high", "medium", "low"] = "medium"


class GateIn(BaseModel):
    threshold: float | None = Field(default=None, gt=0)
    # The milestone it comes after (null: starts now); not sent: unchanged.
    after: uuid.UUID | None = None
    # Confirm the gate as the person sending it, today.
    confirm: bool = False


class GoalMapError(Exception):
    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


def _f(v: Decimal | float | int | None) -> float | None:
    return None if v is None else float(v)


def amount(v: float, unit: str) -> str:
    """A number as people read it: $20k, $900, 5.6, 12."""
    if unit == "$":
        return f"${round(v / 100) / 10:g}k" if v >= 1000 else f"${v:g}"
    return f"{round(v * 10) / 10:g}"


def _short(d: date | None) -> str | None:
    return company_time.calendar_day(d) if d else None


def in_words(d: date) -> str:
    return company_time.calendar_day_with_year(d)


def goal_status(current: float | None, target: float) -> Status:
    if current is None:
        return "not_measured"
    if current >= target:
        return "met"
    return "on_track" if current >= 0.75 * target else "at_risk"


def gate_status(
    m: TrackMilestone, current: float | None, days: list[float | None], today: date
) -> Status:
    if current is None:
        return "not_measured"
    t = float(m.gate_threshold)  # type: ignore[arg-type]
    if all(v is not None and v >= t for v in days):
        return "met"
    if m.target_date is not None and m.target_date < today:
        return "missed"
    return "on_track" if current >= 0.75 * t else "at_risk"


async def _readings(db: AsyncSession, ids: list[uuid.UUID], today: date) -> dict:
    """Per entity: its last 7 days (oldest first, None when not measured) and its latest.
    Loads only those: the 7 days' rows and each entity's latest row on or before today."""
    start = today - timedelta(days=6)
    gm = GoalMeasurement
    cols = (gm.entity_id, gm.measured_on, gm.value)
    week = (await db.execute(
        select(*cols).where(gm.entity_id.in_(ids), gm.measured_on.between(start, today))
    )).all()  # fmt: skip
    seen = {e for e, _, _ in week}
    rest = [i for i in ids if i not in seen]
    older = (await db.execute(
        select(*cols)
        .where(gm.entity_id.in_(rest), gm.measured_on < start)
        .order_by(gm.entity_id, gm.measured_on.desc())
        .ext(distinct_on(gm.entity_id))
    )).all() if rest else []  # fmt: skip
    out: dict[uuid.UUID, tuple[list[float | None], float | None]] = {
        eid: ([None] * 7, None) for eid in ids
    }
    for e, on, v in sorted([*older, *week], key=lambda r: r[1]):
        days, _ = out[e]
        if on >= start:
            days[(on - start).days] = float(v)
        out[e] = (days, float(v))
    return out


# A guardrail goal's rule reads its comparison as a sign ("≤ 5 every day").
_SIGN = {"at_least": "≥", "above": ">", "at_most": "≤", "below": "<"}


def _is_guardrail(e: Entity) -> bool:
    return bool((e.attrs or {}).get("guardrail"))


async def _goals(db: AsyncSession) -> list[Entity]:
    """The measurable goals in the one goal order, guardrail goals too (build() leaves them
    out of the goal cards)."""
    rows = (
        await db.scalars(select(Entity).where(Entity.type == "goal", Entity.status == "confirmed"))
    ).all()
    return sort_goals(g for g in rows if isinstance((g.attrs or {}).get("target"), int | float))


async def _on_map(db: AsyncSession) -> list[TrackMilestone]:
    """The goal milestones of Simple Roadmap, ordered by what each comes after (then by
    when they were added). Only the roadmaps that feed Simple (one-roadmap-many-prds: the
    company roadmap alone while there is one)."""
    rows = (
        await db.scalars(
            select(TrackMilestone)
            .where(
                TrackMilestone.goal_id.is_not(None),
                TrackMilestone.roadmap_id.is_not(None),
                TrackMilestone.deleted_at.is_(None),
                TrackMilestone.status != "dropped",
            )
            .order_by(TrackMilestone.created_at, TrackMilestone.id)
        )
    ).all()
    feeding = set(await company.feeding_ids(db, list({m.roadmap_id for m in rows})))
    rows = [m for m in rows if m.roadmap_id in feeding]
    by = {m.id: m for m in rows}
    depth: dict[uuid.UUID, int] = {}

    def d(m: TrackMilestone, seen: frozenset = frozenset()) -> int:
        if m.id not in depth:
            up = by.get(m.after_id) if m.after_id else None
            depth[m.id] = 0 if up is None or up.id in seen else 1 + d(up, seen | {m.id})
        return depth[m.id]

    return sorted(rows, key=lambda m: d(m))


async def build(db: AsyncSession, can_edit: bool) -> GoalMapOut:
    today = company_time.today(await company_time.company_time_zone(db))
    every = await _goals(db)
    goals = [g for g in every if not _is_guardrail(g)]
    guard = next(
        (
            e
            for e in (
                await db.scalars(
                    select(Entity)
                    .where(Entity.type == "constraint", Entity.status == "confirmed")
                    .order_by(Entity.created_at)
                )
            ).all()
            if _is_guardrail(e)
        ),
        None,
    ) or next((g for g in every if _is_guardrail(g)), None)
    reads = await _readings(db, [g.id for g in goals] + ([guard.id] if guard else []), today)
    goal_reads = {g.id: reads[g.id] for g in goals}
    goal_out = []
    for g in goals:
        a = g.attrs or {}
        days, current = reads[g.id]
        target = float(a["target"])
        goal_out.append(
            GmGoal(
                id=g.id,
                name=g.title,
                measure=a.get("metric") or g.title.lower(),
                target=target,
                current=current,
                unit=a.get("unit") or "",
                status=goal_status(current, target),
                math=a.get("math") or "",
                builds_on=[uuid.UUID(str(b)) for b in a.get("builds_on") or []],
                history=[GmHistory(**h) for h in a.get("target_history") or []],
            )
        )
    guardrail = None
    if guard is not None:
        days, current = reads[guard.id]
        a = guard.attrs or {}
        if guard.type == "goal":
            # A guardrail goal holds while each day meets its own target.
            target, comparison = float(a["target"]), a.get("comparison")
            comparison = comparison if comparison in COMPARISONS else "at_most"
            rule = a.get("rule") or (
                "= 0 every day"
                if target == 0 and comparison == "at_most"
                else f"{_SIGN[comparison]} {amount(target, a.get('unit') or '')} every day"
            )
            held = all(v is not None and meets(v, comparison, target) for v in days)
        else:
            rule, held = a.get("rule") or "= 0 every day", all(v == 0 for v in days)
        guardrail = GmGuardrail(name=guard.title, rule=rule, current=current, days=days, held=held)
    areas = (
        await db.scalars(select(FocusArea).order_by(FocusArea.position, FocusArea.created_at))
    ).all()
    by_goal = {g.id: g for g in goal_out}
    rows = await _on_map(db)
    on_map = {m.id for m in rows}
    ms_out = []
    for m in rows:
        goal = by_goal.get(m.goal_id)  # type: ignore[arg-type]
        if goal is None:
            continue
        days, current = goal_reads[goal.id]
        gated = m.gate_threshold is not None
        ms_out.append(
            GmMilestone(
                id=m.id,
                name=m.name,
                goal=goal.id,
                measure=goal.measure,
                threshold=_f(m.gate_threshold),
                unit=goal.unit,
                current=current,
                status=gate_status(m, current, days, today) if gated else "no_gate",
                areas=list(m.gate_area_ids or []),
                depends=[m.after_id] if m.after_id in on_map else [],
                # Undated (a proposal, say): this month, until it gets a date.
                month=company_time.calendar_month(m.target_date or today),
                due=_short(m.target_date),
                days=list(days),
                confirmed=m.gate_confirmed_by,
                confirmed_on=_short(m.gate_confirmed_on),
                proposed=gated and m.gate_confirmed_by is None,
            )
        )
    shown = {m.id for m in ms_out}
    area_by = {a.id: a for a in areas}
    links = (
        await db.execute(
            select(MilestoneFeature, RoadmapItem.title)
            .join(RoadmapItem, RoadmapItem.id == MilestoneFeature.item_id)
            .order_by(RoadmapItem.position, RoadmapItem.title, MilestoneFeature.created_at)
        )
    ).all()
    feats: dict[uuid.UUID, GmFeature] = {}
    for link, title in links:
        if link.milestone_id not in shown:
            continue
        f = feats.get(link.item_id)
        mine = GmLink(
            milestone=link.milestone_id,
            expected=link.expected,
            confidence=link.confidence.capitalize(),  # type: ignore[arg-type]
            measured=link.measured,
            lift=link.lift,  # type: ignore[arg-type]
        )
        if f is None:
            area = area_by.get(link.area_id) if link.area_id else None
            feats[link.item_id] = GmFeature(
                id=link.item_id,
                name=title,
                area=area.id if area else None,
                milestones=[link.milestone_id],
                lever=area.lever if area else "",
                expected=link.expected,
                confidence=link.confidence.capitalize(),  # type: ignore[arg-type]
                released=link.released or link.measured is not None,
                measured=link.measured,
                lift=link.lift,  # type: ignore[arg-type]
                links=[mine],
            )
        elif link.milestone_id not in f.milestones:
            f.milestones.append(link.milestone_id)
            f.links.append(mine)
    owner = await db.scalar(
        select(User).where(User.role == "owner", User.name.is_not(None)).order_by(User.created_at)
    )
    reps = next((int(g.attrs["reps"]) for g in goals if (g.attrs or {}).get("reps")), None)
    return GoalMapOut(
        goals=goal_out,
        areas=[GmArea(id=a.id, name=a.name, lever=a.lever) for a in areas],
        guardrail=guardrail,
        milestones=ms_out,
        features=list(feats.values()),
        today=company_time.calendar_day(today),
        reps=reps,
        approver=owner.name if owner else None,
        can_edit=can_edit,
    )


async def add_area(db: AsyncSession, body: AreaIn) -> None:
    areas = (await db.scalars(select(FocusArea))).all()
    last = max((a.position for a in areas), default=-1)
    db.add(FocusArea(name=body.name.strip(), lever=body.lever.strip(), position=last + 1))


async def order_areas(db: AsyncSession, ids: list[uuid.UUID]) -> None:
    areas = {a.id: a for a in (await db.scalars(select(FocusArea))).all()}
    if len(ids) != len(set(ids)) or set(ids) != set(areas):
        raise GoalMapError(422, "Send every area once, in the new order")
    for i, aid in enumerate(ids):
        areas[aid].position = i


async def edit_goal(db: AsyncSession, goal_id: uuid.UUID, target: float, who: str) -> None:
    goal = next((g for g in await _goals(db) if g.id == goal_id), None)
    if goal is None:
        raise GoalMapError(404, "No such goal")
    a = dict(goal.attrs or {})
    unit = a.get("unit") or ""
    today = company_time.today(await company_time.company_time_zone(db))
    entry = {
        "date": in_words(today),
        "text": f"Target {amount(float(a['target']), unit)} → {amount(target, unit)}",
        "by": who,
    }
    a["target_history"] = [entry, *(a.get("target_history") or [])]
    a["target"] = int(target) if float(target).is_integer() else target
    goal.attrs = a
    flag_modified(goal, "attrs")


async def _check_after(
    rows: list[TrackMilestone], m: TrackMilestone | None, after: uuid.UUID | None
) -> TrackMilestone | None:
    """The milestone picked as the one it comes after: on the map, never itself or one that
    comes after it."""
    if after is None:
        return None
    by = {r.id: r for r in rows}
    up = by.get(after)
    if up is None:
        raise GoalMapError(422, "Pick a milestone it comes after")
    seen: set[uuid.UUID] = set()
    step: TrackMilestone | None = up
    while m is not None and step is not None and step.id not in seen:
        if step.id == m.id:
            raise GoalMapError(422, "A milestone cannot come after one that comes after it")
        seen.add(step.id)
        step = by.get(step.after_id) if step.after_id else None
    return up


async def propose(db: AsyncSession, body: ProposeIn, by: uuid.UUID | None) -> None:
    """Saved the way Simple Roadmap saves its goal milestones: on a roadmap, no track, the
    goal's next "M" code."""
    goal = next((g for g in await _goals(db) if g.id == body.goal), None)
    if goal is None:
        raise GoalMapError(422, "Pick a goal")
    rows = await _on_map(db)
    if "after" in body.model_fields_set:
        after = await _check_after(rows, None, body.after)
    else:
        after = next((m for m in reversed(rows) if m.goal_id == goal.id), None)
    known = {a.id for a in (await db.scalars(select(FocusArea))).all()}
    if any(a not in known for a in body.areas):
        raise GoalMapError(422, "Pick areas of this map")
    roadmap_id = (
        (after.roadmap_id if after else None)
        or next((m.roadmap_id for m in rows if m.goal_id == goal.id), None)
        or next((m.roadmap_id for m in rows), None)
        or getattr(await company.active(db), "id", None)
        or await db.scalar(
            select(Document.id)
            .where(Document.kind == "roadmap")
            .order_by(Document.created_at)
            .limit(1)
        )
    )
    if roadmap_id is None:
        raise GoalMapError(409, "There is no roadmap to add a milestone to yet")
    name = body.name.strip()
    clash = await db.scalar(
        select(TrackMilestone.id).where(
            TrackMilestone.roadmap_id == roadmap_id,
            TrackMilestone.name == name,
            TrackMilestone.deleted_at.is_(None),
        )
    )
    if clash is not None:
        raise GoalMapError(409, "A milestone with this name is already on the roadmap")
    db.add(
        TrackMilestone(
            track_id=None,
            roadmap_id=roadmap_id,
            goal_id=goal.id,
            code=await _next_code(db, roadmap_id, goal.id),
            name=name,
            created_by=by,
            gate_threshold=Decimal(str(body.threshold)),
            gate_area_ids=list(body.areas),
            after_id=after.id if after else None,
        )
    )


async def set_gate(db: AsyncSession, milestone_id: uuid.UUID, body: GateIn, who: str) -> None:
    rows = await _on_map(db)
    m = next((r for r in rows if r.id == milestone_id), None)
    if m is None:
        raise GoalMapError(404, "No such milestone")
    if "after" in body.model_fields_set:
        after = await _check_after(rows, m, body.after)
        m.after_id = after.id if after else None
    if body.threshold is not None:
        m.gate_threshold = Decimal(str(body.threshold))
    if body.confirm:
        if m.gate_threshold is None:
            raise GoalMapError(422, "Set a threshold before confirming the gate")
        m.gate_confirmed_by = who
        m.gate_confirmed_on = company_time.today(await company_time.company_time_zone(db))


async def attach(db: AsyncSession, body: AttachIn) -> None:
    m = await db.get(TrackMilestone, body.milestone)
    item = await db.get(RoadmapItem, body.feature)
    if m is None or m.goal_id is None or m.deleted_at is not None or item is None:
        raise GoalMapError(404, "No such feature or milestone")
    if await db.get(FocusArea, body.area) is None:
        raise GoalMapError(422, "Pick an area of this map")
    links = (
        await db.scalars(
            select(MilestoneFeature)
            .where(MilestoneFeature.item_id == item.id)
            .order_by(MilestoneFeature.created_at)
        )
    ).all()
    # A feature sits in one area: attached from another area's cell, it moves there.
    for link in links:
        link.area_id = body.area
    if any(link.milestone_id == m.id for link in links):
        return
    area = body.area
    db.add(
        MilestoneFeature(
            milestone_id=m.id,
            item_id=item.id,
            area_id=area,
            expected=body.expected.strip(),
            confidence=body.confidence,
            released=any(link.released for link in links),
        )
    )
