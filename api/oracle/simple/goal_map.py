"""Simple Goal map (build-goal-map): the goals, the guardrail, the areas of focus in the
owner's order, the gated milestones (track_milestones, the records Simple Roadmap draws)
and the features serving them.

- Goals: confirmed ``goal`` entities with a numeric ``target`` attr; today's reading is
  their latest ``goal_measurements`` row. ``attrs``: ``metric``, ``unit`` ("$" or ""),
  ``math``, ``builds_on`` (goal ids) and ``target_history`` (newest first).
- The guardrail: a confirmed ``constraint`` entity with ``attrs.guardrail``; its last 7
  days are its measurements.
- A milestone's status follows its gate: not measured yet without a reading; met when its
  7 days all hold the threshold; missed when due before today and not met; else its
  stored at_risk/on_track (on track when none).
"""

import uuid
from collections.abc import Sequence
from datetime import date, timedelta
from decimal import Decimal
from typing import Any, Literal

from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

from oracle import company_time
from oracle.auth.models import User
from oracle.baseline.models import Entity, GoalMeasurement
from oracle.roadmap.models import ProductTrack, RoadmapItem, TrackMilestone
from oracle.simple.models import FocusArea, MilestoneFeature

Status = Literal["met", "on_track", "at_risk", "missed", "not_measured"]
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
    threshold: float
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
    threshold: float
    areas: list[uuid.UUID] = []
    after: uuid.UUID | None = None


class AttachIn(BaseModel):
    feature: uuid.UUID
    milestone: uuid.UUID


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
    return f"{d:%b} {d.day}" if d else None


def in_words(d: date) -> str:
    return f"{d:%b} {d.day}, {d.year}"


def goal_status(current: float | None, target: float) -> Status:
    if current is None:
        return "not_measured"
    if current >= target:
        return "met"
    return "on_track" if current >= 0.75 * target else "at_risk"


def gate_status(m: TrackMilestone, days: list[float | None], today: date) -> Status:
    if m.gate_reading is None:
        return "not_measured"
    t = float(m.gate_threshold or 0)
    if len(days) == 7 and all(v is not None and v >= t for v in days):
        return "met"
    if m.target_date is not None and m.target_date < today:
        return "missed"
    return "at_risk" if m.gate_status == "at_risk" else "on_track"


def _seven(values: Sequence[Any]) -> list[float | None]:
    out = [None if v is None else float(v) for v in list(values)[-7:]]
    return [None] * (7 - len(out)) + out


async def _readings(db: AsyncSession, ids: list[uuid.UUID], today: date) -> dict:
    """Per entity: its last 7 days (oldest first, None when not measured) and its latest."""
    start = today - timedelta(days=6)
    rows = (
        await db.execute(
            select(GoalMeasurement.entity_id, GoalMeasurement.measured_on, GoalMeasurement.value)
            .where(GoalMeasurement.entity_id.in_(ids), GoalMeasurement.measured_on <= today)
            .order_by(GoalMeasurement.measured_on)
        )
    ).all()
    out: dict[uuid.UUID, tuple[list[float | None], float | None]] = {}
    for eid in ids:
        mine = [(on, v) for e, on, v in rows if e == eid]
        days: list[float | None] = [None] * 7
        for on, v in mine:
            if on >= start:
                days[(on - start).days] = float(v)
        out[eid] = (days, float(mine[-1][1]) if mine else None)
    return out


def _order_goals(goals: list[Entity]) -> list[Entity]:
    """What a goal builds on comes first; else by title."""
    by = {g.id: g for g in goals}
    done: list[Entity] = []
    seen: set[uuid.UUID] = set()

    def visit(g: Entity) -> None:
        if g.id in seen:
            return
        seen.add(g.id)
        for b in (g.attrs or {}).get("builds_on") or []:
            dep = by.get(uuid.UUID(str(b)))
            if dep is not None:
                visit(dep)
        done.append(g)

    for g in sorted(goals, key=lambda x: x.title):
        visit(g)
    return done


async def _goals(db: AsyncSession) -> list[Entity]:
    rows = (
        await db.scalars(select(Entity).where(Entity.type == "goal", Entity.status == "confirmed"))
    ).all()
    return _order_goals([g for g in rows if isinstance((g.attrs or {}).get("target"), int | float)])


async def build(db: AsyncSession, can_edit: bool) -> GoalMapOut:
    today = company_time.today(await company_time.company_time_zone(db))
    goals = await _goals(db)
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
            if (e.attrs or {}).get("guardrail")
        ),
        None,
    )
    reads = await _readings(db, [g.id for g in goals] + ([guard.id] if guard else []), today)
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
        guardrail = GmGuardrail(
            name=guard.title,
            rule=(guard.attrs or {}).get("rule") or "= 0 every day",
            current=current,
            days=days,
            held=all(v == 0 for v in days),
        )
    areas = (
        await db.scalars(select(FocusArea).order_by(FocusArea.position, FocusArea.created_at))
    ).all()
    by_goal = {g.id: g for g in goal_out}
    rows = (
        await db.scalars(
            select(TrackMilestone)
            .where(TrackMilestone.gate_goal_id.is_not(None), TrackMilestone.status != "dropped")
            .order_by(TrackMilestone.created_at)
        )
    ).all()
    ms_out = []
    for m in rows:
        goal = by_goal.get(m.gate_goal_id)
        if goal is None:
            continue
        days = _seven(m.gate_days or [])
        ms_out.append(
            GmMilestone(
                id=m.id,
                name=m.name,
                goal=goal.id,
                measure=goal.measure,
                threshold=float(m.gate_threshold or 0),
                unit=goal.unit,
                current=_f(m.gate_reading),
                status=gate_status(m, days, today),
                areas=list(m.gate_area_ids or []),
                depends=list(m.gate_after_ids or []),
                # Undated (a proposal, say): this month, until it gets a date.
                month=f"{m.target_date or today:%b}",
                due=_short(m.target_date),
                days=days,
                confirmed=m.gate_confirmed_by,
                confirmed_on=_short(m.gate_confirmed_on),
                proposed=bool(m.gate_proposed),
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
            )
        elif link.milestone_id not in f.milestones:
            f.milestones.append(link.milestone_id)
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
        today=f"{today:%b} {today.day}",
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


async def propose(db: AsyncSession, body: ProposeIn, by: uuid.UUID | None) -> None:
    goal = next((g for g in await _goals(db) if g.id == body.goal), None)
    if goal is None:
        raise GoalMapError(422, "Pick a goal")
    gated = (
        await db.scalars(
            select(TrackMilestone)
            .where(TrackMilestone.gate_goal_id.is_not(None))
            .order_by(TrackMilestone.created_at)
        )
    ).all()
    after = next((m for m in gated if m.id == body.after), None) if body.after else None
    if body.after and after is None:
        raise GoalMapError(422, "Pick a milestone it comes after")
    known = {a.id for a in (await db.scalars(select(FocusArea))).all()}
    if any(a not in known for a in body.areas):
        raise GoalMapError(422, "Pick areas of this map")
    track_id = (
        after.track_id
        if after
        else next((m.track_id for m in gated if m.gate_goal_id == goal.id), None)
        or next((m.track_id for m in gated), None)
        or await db.scalar(select(ProductTrack.id).order_by(ProductTrack.created_at).limit(1))
    )
    if track_id is None:
        raise GoalMapError(409, "There is no track to add a milestone to yet")
    clash = await db.scalar(
        select(TrackMilestone.id).where(
            TrackMilestone.track_id == track_id, TrackMilestone.name == body.name.strip()
        )
    )
    if clash is not None:
        raise GoalMapError(409, "A milestone with this name is already on the track")
    today = company_time.today(await company_time.company_time_zone(db))
    days, current = (await _readings(db, [goal.id], today))[goal.id]
    db.add(
        TrackMilestone(
            track_id=track_id,
            name=body.name.strip(),
            horizon="next",
            status="planned",
            created_by=by,
            gate_goal_id=goal.id,
            gate_threshold=Decimal(str(body.threshold)),
            gate_reading=None if current is None else Decimal(str(current)),
            gate_days=days,
            gate_area_ids=list(body.areas),
            gate_after_ids=[after.id] if after else [],
            gate_proposed=True,
        )
    )


async def attach(db: AsyncSession, body: AttachIn) -> None:
    m = await db.get(TrackMilestone, body.milestone)
    item = await db.get(RoadmapItem, body.feature)
    if m is None or m.gate_goal_id is None or item is None:
        raise GoalMapError(404, "No such feature or milestone")
    links = (
        await db.scalars(
            select(MilestoneFeature)
            .where(MilestoneFeature.item_id == item.id)
            .order_by(MilestoneFeature.created_at)
        )
    ).all()
    if any(link.milestone_id == m.id for link in links):
        return
    first = links[0] if links else None
    area = first.area_id if first else (m.gate_area_ids[0] if m.gate_area_ids else None)
    db.add(
        MilestoneFeature(
            milestone_id=m.id,
            item_id=item.id,
            area_id=area,
            expected=first.expected if first else "",
            confidence=first.confidence if first else "medium",
            released=first.released if first else False,
            measured=first.measured if first else None,
            lift=first.lift if first else "not_measured",
        )
    )
