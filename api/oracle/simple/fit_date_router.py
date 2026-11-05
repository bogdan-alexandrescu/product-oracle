"""Bring a date in (Simple): Oracle's ranked changes for a PRD milestone that misses its
target, the live date of a picked set, the drafted re-plan and its approval.

Every date comes from :mod:`oracle.simple.fit_date` (the capacity queue), read from the
PRD's plan as its latest approved version has it (:mod:`oracle.simple.plan`): the
milestones' order, dates and engineer-weeks, the features' slices and sizes, the team line
("Team: 4 engineers at 70% focus"), the must-keep rules ("## Must keep": guardrail, safety
and must-include features) and the re-plans already approved ("## Re-plan"). No model call.

- ``GET  /v1/simple/fit-date``: each readable PRD's goal milestones with their target and
  their date on today's plan, late first (the Roadmap's goal card).
- ``GET  /v1/simple/prds/{prd}/fit-date?milestone=M2``: Oracle's answer.
- ``POST /v1/simple/prds/{prd}/fit-date/live``: the date of a picked set.
- ``POST /v1/simple/prds/{prd}/fit-date/draft``: what the picks change in the PRD, every
  date that moves (the target too when no set reaches it) and the items needing a new
  estimate.
- ``POST /v1/simple/prds/{prd}/fit-date/approve``: the PRD's next version with the re-plan,
  approved through the same path as any PRD version; the roadmap follows in its next version
  (``_roadmap_follows``), approved when the approver decides the roadmap.
"""

from __future__ import annotations

import datetime as dt
import math
import re
import uuid
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import select

from oracle import audit, company_time
from oracle.auth.deps import Principal, TenantDB
from oracle.docs.models import Document, DocumentVersion
from oracle.simple import fit_date as fd
from oracle.simple import one_pager, plan
from oracle.simple.changes import ChangeError
from oracle.simple.router import _people
from oracle.simple.schemas import SimpleDocRef

router = APIRouter(prefix="/v1/simple", tags=["simple"])

Reader = Annotated[Principal, Depends(_people("viewer"))]
Approver = Annotated[Principal, Depends(_people("approver"))]

_TEAM = re.compile(r"(\d+)\s+engineers?\s+at\s+(\d+)\s*%\s*focus", re.I)
_RULE = re.compile(
    r"^\s*[-*]\s*(F-\d+[a-z]?)\b[^:]*:\s*(guardrail|safety|must-include)\b[:\s]*(.*)$",
    re.I | re.M,
)
_REPLAN = re.compile(r"^\s*[-*]\s*(F-\d+[a-z]?|M\d+ wait|Team focus)\b[^:]*:\s*(.+?)\.?\s*$", re.M)


class FitMove(BaseModel):
    what: str
    before: dt.date | None = None
    after: dt.date | None = None


class FitChangeOut(BaseModel):
    id: str
    lever: Literal["move", "next_prd", "slice", "ungate", "split", "overlap", "capacity"]
    item: str
    title: str
    days: int
    pw_saved: float
    cost_kind: Literal["none", "risk", "gate", "goal", "must"]
    cost: str
    pickable: bool
    # What the change does, in one line ("Moves to M3 Team inbox: lands Mar 19").
    effect: str
    moves: list[FitMove]


class FitHireOut(BaseModel):
    """One more engineer when no set reaches the target: counted only after their start
    weeks, at the team's focus. ``date``: the best date with them; ``reaches``: whether it
    is by the target."""

    start_weeks: int
    date: dt.date
    reaches: bool


class FitLockedOut(BaseModel):
    item: str
    pw: float
    why: str
    # Cutting it (with every change) would reach the target; Oracle still will not offer it.
    would_reach: bool


class FitLaneItem(BaseModel):
    id: str
    title: str
    date: dt.date | None = None
    locked: bool = False
    needs_estimate: bool = False


class FitLane(BaseModel):
    code: str
    name: str
    date: dt.date | None = None
    items: list[FitLaneItem]


class FitTeam(BaseModel):
    engineers: int
    focus: float


class FitApprovalOut(BaseModel):
    """The last re-plan approved for this milestone: who, when, the versions it made live,
    the milestone's date before and after, and what moved in words."""

    at: dt.datetime
    by_me: bool
    version: int
    roadmap_version: int | None = None
    # Whether that roadmap version is approved; when not, who decides it.
    roadmap_live: bool = False
    roadmap_decider: str | None = None
    was: dt.date
    date: dt.date
    target: dt.date
    moves: list[str] = []


class FitGoalOut(BaseModel):
    prd: SimpleDocRef
    prd_version: int
    # The PRD's roadmap and its latest version (None: the PRD is on no roadmap yet).
    roadmap: SimpleDocRef | None = None
    roadmap_version: int | None = None
    goal: str | None = None
    # What is measured now, in words ("26 replied threads per agent today").
    goal_now: str | None = None
    milestone: str
    milestone_name: str
    target: dt.date
    today: dt.date
    late_days: int
    team: FitTeam
    lanes: list[FitLane]
    approved: FitApprovalOut | None = None


class FitBaselineGoalOut(BaseModel):
    """The Baseline goal the milestone's gate counts toward (the milestone's first target's
    goal, by name): what "Keep the date with a smaller goal" opens and saves through
    ``PATCH /v1/baseline/entities/{id}``. ``plan_target``: the number the PRD's milestone
    target names; ``smaller``: the goal's target is below it, so the answer counts the
    goal's own work in the milestone in proportion (:func:`_scale`)."""

    id: uuid.UUID
    title: str
    target: float | None = None
    unit: str | None = None
    comparison: str | None = None
    start: float | None = None
    due: dt.date | None = None
    plan_target: float | None = None
    smaller: bool = False
    can_edit: bool = False


class FitAnswerOut(FitGoalOut):
    changes: list[FitChangeOut]
    pick: list[str]
    pick_date: dt.date
    best_date: dt.date
    reachable: bool
    locked: list[FitLockedOut]
    # When no set reaches the target: what one more engineer would do.
    hire: FitHireOut | None = None
    # None: no Baseline goal by the milestone goal's name (the panel says so, no button).
    baseline_goal: FitBaselineGoalOut | None = None


class FitPicksIn(BaseModel):
    milestone: str
    picks: list[str]


class FitLiveOut(BaseModel):
    date: dt.date
    target: dt.date
    # Days past the target (negative: days to spare).
    over_days: int
    pw_saved: float
    picks: list[str]


class FitPrdChange(BaseModel):
    item: str
    change: str


class FitDateMove(BaseModel):
    what: str
    before: dt.date | None = None
    after: dt.date | None = None
    # in: earlier; out: later or off the plan.
    kind: Literal["in", "out"]
    note: str | None = None


class FitEstimate(BaseModel):
    item: str
    owner: str | None = None


class FitDraftOut(BaseModel):
    prd: SimpleDocRef
    prd_version: int
    next_version: int
    roadmap_version: int | None = None
    changes: list[FitPrdChange]
    dates: list[FitDateMove]
    new_target: dt.date | None = None
    date: dt.date
    needs_estimate: list[FitEstimate]


class FitApprovedOut(BaseModel):
    prd: SimpleDocRef
    version: int
    date: dt.date
    target: dt.date
    approved_at: dt.datetime
    needs_estimate: list[FitEstimate]
    # The roadmap's version with the re-planned dates: live when the approver decides the
    # roadmap, else in review with its decider; None when nothing on it moved.
    roadmap_version: int | None = None
    roadmap_live: bool = False
    roadmap_decider: str | None = None


# --------------------------------------------------------------------------- reading


def _team(text: str, view: plan.View) -> tuple[int, float]:
    m = _TEAM.search(text)
    if m:
        return max(1, int(m[1])), min(1.0, max(0.1, int(m[2]) / 100))
    # No team line: the milestones' engineer-weeks over their work weeks, at full focus.
    weeks = sum(
        max(1, ((ms.end_date - ms.start_date).days + 1) / 7)
        for ms in view.milestones
        if ms.start_date and ms.end_date and ms.effort_weeks
    )
    effort = sum(ms.effort_weeks or 0 for ms in view.milestones if ms.start_date and ms.end_date)
    return (max(1, math.ceil(effort / weeks)) if weeks else 1), 1.0


def _lever(sl, asked_goal: str | None) -> fd.Lever:
    if sl.pm_owned or not sl.goal:
        return "next_prd"
    if asked_goal and sl.goal != asked_goal:
        return "ungate"
    return "slice" if (sl.effort_weeks or 0) >= 4 else "move"


def _replans(text: str) -> list[str]:
    """The picks of the re-plans already approved into this version (its "## Re-plan")."""
    at = text.find("## Re-plan")
    if at < 0:
        return []
    out = []
    for code, _words in _REPLAN.findall(text[at:]):
        if code == "Team focus":
            out.append("focus")
        elif code.endswith(" wait"):
            out.append(f"wait:{code.split()[0]}")
        else:
            out.append(code)
    return out


def _slice_pw(pw: float) -> float:
    """A slice or a split's first slice: half its whole weeks, never more than the item itself
    (a slice never grows it)."""
    return min(math.ceil(pw) / 2, pw)


def build_plan(
    text: str, view: plan.View, milestone: str, today: dt.date, scale: float = 1.0
) -> fd.Plan | None:
    """The fit-date plan of a PRD's approved version: None when the milestone has no date.
    ``scale`` (a smaller goal, :func:`_scale`): the asked milestone's own work for its goal,
    unlocked items only, counts at that share of its size, each at least a tenth of it (to 0.1 week)
    (guardrail, safety and must-include items keep their full size)."""
    ms = view.milestone(milestone)
    if ms is None or ms.end_date is None:
        return None
    engineers, focus = _team(text, view)
    rules = {code: (kind.lower(), why.strip()) for code, kind, why in _RULE.findall(text)}
    asked_goal = ms.targets[0].goal if ms.targets else None
    milestones = []
    prev_end: dt.date | None = None
    for m in view.milestones:
        wait = 0
        if prev_end and m.start_date and (m.start_date - prev_end).days > 3:
            wait = (m.start_date - prev_end).days - 3
        milestones.append(fd.Milestone(m.code, f"{m.code} {m.name}".strip(), wait,
                                       f"{m.code} {wait}-day wait" if wait else None))  # fmt: skip
        prev_end = m.end_date or prev_end
    items = []
    for sl in view.slices:
        kind, why = rules.get(sl.feature_code, ("", ""))
        guard = f"{kind.capitalize()}: {why}" if kind in ("guardrail", "safety") else None
        pw = sl.effort_weeks or 0
        if scale < 1 and sl.milestone == milestone and sl.goal == asked_goal and not kind:
            # Never under a tenth of its own effort, rounded to a tenth of a week like every
            # size here; a small item keeps 0.1 (or its whole size, if less).
            pw = max(round(pw * scale, 1), round(pw * 0.1, 1), min(pw, 0.1))
        lever = _lever(sl, asked_goal)
        items.append(fd.Item(
            id=sl.code, title=sl.name, pw=pw, milestone=sl.milestone, guard=guard,
            must=kind == "must-include", lever=lever,
            slice_pw=_slice_pw(pw) if lever in ("slice", "split") else None,
        ))  # fmt: skip
    start = min((m.start_date for m in view.milestones if m.start_date), default=today)
    focus_raise = round(focus + 0.1, 2) if focus <= 0.9 else None
    p = fd.Plan(start, engineers, focus, tuple(milestones), tuple(items), milestone,
                ms.end_date, focus_raise)  # fmt: skip
    done = _replans(text)
    return fd.apply(p, done) if done else p


async def _approved(db, document: Document) -> DocumentVersion | None:
    return await plan.approved_version(db, document.id)


async def _load(db, principal, prd: str, milestone: str):
    document, v, view, p, _ = await _load_goal(db, principal, prd, milestone)
    return document, v, view, p


async def _load_goal(db, principal, prd: str, milestone: str):
    """The PRD, its approved version, its plan view, the fit-date plan (counted against the
    Baseline goal's target) and that Baseline goal (None when none is found)."""
    try:
        document = await one_pager._document(db, principal, prd)
    except ChangeError as e:
        raise HTTPException(e.status, e.detail) from e
    v = await _approved(db, document)
    view = (await plan.views(db, {document.id})).get(document.id)
    if v is None or view is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "This PRD has no approved plan yet.")
    today = await company_time.company_today(db)
    goal = await _baseline_goal(db, principal, view, milestone)
    p = build_plan(v.markdown, view, milestone, today, _scale(goal))
    if p is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No dated milestone by that name.")
    return document, v, view, p, goal


_NUMBER = re.compile(r"-?\d+(?:\.\d+)?")


def _float(x) -> float | None:
    try:
        f = float(x)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


async def _baseline_goal(db, principal, view: plan.View, milestone: str):
    """The Baseline goal the milestone's gate counts toward: the goal entity named as the
    milestone's first target's goal (confirmed first, never a rejected one), as
    :func:`oracle.simple.plan.enrich` matches goals."""
    from oracle.authz import has_role
    from oracle.baseline.models import Entity

    ms = view.milestone(milestone)
    t = ms.targets[0] if ms and ms.targets else None
    if t is None or not t.goal:
        return None
    name = t.goal.strip().lower()
    found = None
    for e in await db.scalars(select(Entity).where(Entity.type == "goal")):
        if (e.title or "").strip().lower() != name or e.status == "rejected":
            continue
        if found is None or e.status == "confirmed":
            found = e
    if found is None:
        return None
    attrs = found.attrs or {}
    m = _NUMBER.search((t.target or "").replace(",", ""))
    try:
        due = dt.date.fromisoformat(attrs["due"]) if attrs.get("due") else None
    except (TypeError, ValueError):
        due = None
    out = FitBaselineGoalOut(
        id=found.id, title=found.title, target=_float(attrs.get("target")),
        unit=attrs.get("unit"), comparison=attrs.get("comparison"),
        start=_float(attrs.get("start")), due=due,
        plan_target=float(m[0]) if m else None,
        can_edit=has_role(principal.role, "approver"),
    )  # fmt: skip
    out.smaller = _scale(out) < 1
    return out


def _scale(goal: FitBaselineGoalOut | None) -> float:
    """The share of the goal's own work a smaller goal still needs: the way from the start
    value to the goal's target over the way to the PRD's milestone target (1: not smaller;
    at least 0.1). Only a goal counted up (at least, above) shrinks this way."""
    if goal is None or goal.target is None or goal.plan_target is None:
        return 1.0
    if goal.comparison not in ("at_least", "above"):
        return 1.0
    start = goal.start
    base = start if start is not None and start < goal.plan_target else 0.0
    if goal.target >= goal.plan_target or goal.plan_target <= base:
        return 1.0
    return max(0.1, min(1.0, (goal.target - base) / (goal.plan_target - base)))


async def _roadmap_id(db, document: Document):
    """The roadmap the PRD's re-plan reads and writes, by prd_roadmap._roadmap's rule
    (one-roadmap-many-prds): the company roadmap while there is one, else its track's."""
    from oracle.roadmap import company
    from oracle.roadmap.models import ProductTrack

    if (one := await company.active(db)) is not None:
        return one.id
    return await db.scalar(
        select(ProductTrack.roadmap_document_id).where(ProductTrack.prd_document_id == document.id)
    )


async def _roadmap(db, document: Document) -> tuple[SimpleDocRef | None, int | None]:
    rid = await _roadmap_id(db, document)
    rm = await db.get(Document, rid) if rid else None
    if rm is None:
        return None, None
    n = await db.scalar(
        select(DocumentVersion.number)
        .where(DocumentVersion.document_id == rm.id)
        .order_by(DocumentVersion.number.desc())
        .limit(1)
    )
    return _ref(rm), n


async def _approval(db, principal, document: Document, milestone: str) -> FitApprovalOut | None:
    from oracle.models import AuditEvent

    ev = await db.scalar(
        select(AuditEvent)
        .where(AuditEvent.action == "simple_fit_date.approved", AuditEvent.entity_id == document.id)
        .order_by(AuditEvent.created_at.desc())
        .limit(1)
    )
    if ev is None or ev.data.get("milestone") != milestone or "was" not in ev.data:
        return None
    d = ev.data
    live, decider = False, None
    rm, n = await _roadmap(db, document)
    if rm is not None and d.get("roadmap_version") is not None:
        at = await db.scalar(
            select(DocumentVersion.approved_at).where(
                DocumentVersion.document_id == rm.id,
                DocumentVersion.number == d["roadmap_version"],
            )
        )
        live = at is not None
        decider = None if live else await _decider(db, rm.id)
    return FitApprovalOut(
        at=ev.created_at, by_me=ev.actor == f"user:{getattr(principal, 'user_id', '')}",
        version=d["version"], roadmap_version=d.get("roadmap_version"),
        roadmap_live=live, roadmap_decider=decider,
        was=dt.date.fromisoformat(d["was"]), date=dt.date.fromisoformat(d["date"]),
        target=dt.date.fromisoformat(d["target"]), moves=d.get("moves", []),
    )  # fmt: skip


async def _decider(db, roadmap_id) -> str | None:
    """Who decides the roadmap, by name: its decider, else its owners."""
    from oracle.simple import drafts
    from oracle.simple.changes import _names

    w = await drafts.who(db, {roadmap_id})
    ids = (
        [w.deciders.get(roadmap_id)]
        if w.deciders.get(roadmap_id)
        else sorted(w.owners.get(roadmap_id, set()), key=str)
    )
    names = await _names(db, set(ids))
    got = [names[i] for i in ids if i in names]
    return drafts._people(got) if got else None


async def _foreign_edits(db, document: Document) -> str | None:
    """Who has changes of their own in the roadmap's working draft, by name: approving the
    re-plan publishes that draft, so it must hold only this PRD's own writes. None when it
    holds nothing else (or there is no working draft)."""
    from oracle.roadmap.models import RoadmapItem
    from oracle.simple import drafts, prd_roadmap
    from oracle.simple.changes import _names
    from oracle.simple.models import SimpleDraft

    rid = await _roadmap_id(db, document)
    d = rid and await db.scalar(
        select(SimpleDraft).where(SimpleDraft.document_id == rid, SimpleDraft.status == "working")
    )
    if not d:
        return None
    overlay = d.overlay or {}
    sources = overlay.get(prd_roadmap.KEY) or {}
    ours = sources.get(str(document.id)) or {}
    mine = {str(i) for i in ours.get("items") or []} | set(ours.get(prd_roadmap.KEY_DATES) or [])
    other = [k for k in overlay if k not in (prd_roadmap.KEY, prd_roadmap.KEY_DATES, *mine)]
    other += [k for k in overlay.get(prd_roadmap.KEY_DATES) or {} if k not in mine]
    other += [k for k, v in sources.items() if k != str(document.id) and v.get("items")]
    added = await db.scalars(
        select(RoadmapItem.id).where(
            RoadmapItem.simple_draft_id == d.id, RoadmapItem.roadmap_version_id.is_(None)
        )
    )
    other += [str(i) for i in added if str(i) not in mine]
    changes = await drafts._live_changes(db, d)
    if not other and not changes:
        return None
    ids = list(dict.fromkeys([*(c.by for c in changes), d.created_by]))
    names = await _names(db, set(ids))
    return drafts._people([names[i] for i in ids if i in names] or ["Someone"])


def _ref(d: Document) -> SimpleDocRef:
    return SimpleDocRef(id=d.id, slug=d.slug, title=d.title)


def _lanes(p: fd.Plan, resized: set[str] = frozenset()) -> list[FitLane]:
    s = fd.schedule(p)
    return [
        FitLane(code=m.code, name=m.name, date=s.milestones.get(m.code), items=[
            FitLaneItem(id=i.id, title=i.title, date=s.items.get(i.id), locked=bool(i.guard),
                        needs_estimate=i.id in resized)
            for i in p.items if i.milestone == m.code
        ])
        for m in p.milestones
    ]  # fmt: skip


async def _goal_of(db, principal, document, v, view, p: fd.Plan) -> FitGoalOut:
    g = _goal(document, v, view, p)
    g.roadmap, g.roadmap_version = await _roadmap(db, document)
    g.approved = await _approval(db, principal, document, p.milestone)
    return g


def _goal(document, v, view, p: fd.Plan) -> FitGoalOut:
    ms = view.milestone(p.milestone)
    goal = ms.targets[0].goal if ms and ms.targets else None
    measured = next((g.measured for g in view.goals if g.name == goal), None)
    on_plan = fd.schedule(p).milestones[p.milestone]
    return FitGoalOut(
        prd=_ref(document), prd_version=v.number, goal=goal, goal_now=measured,
        milestone=p.milestone, milestone_name=f"{p.milestone} {ms.name}" if ms else p.milestone,
        target=p.target, today=on_plan, late_days=(on_plan - p.target).days,
        team=FitTeam(engineers=p.engineers, focus=p.focus), lanes=_lanes(p),
    )  # fmt: skip


# --------------------------------------------------------------------------- routes


@router.get("/fit-date", response_model=list[FitGoalOut])
async def list_fit_dates(principal: Reader, db: TenantDB) -> list[FitGoalOut]:
    """Each readable PRD's dated goal milestones with their target and their date on today's
    plan, the latest first."""
    from oracle.docs import visibility

    docs = [
        d
        for d in await db.scalars(select(Document).where(Document.kind == "prd"))
        if visibility.can_see(principal, d) and not getattr(d, "deleted_at", None)
    ]
    views = await plan.views(db, {d.id for d in docs})
    out: list[FitGoalOut] = []
    for d in docs:
        view = views.get(d.id)
        v = await _approved(db, d) if view else None
        if view is None or v is None:
            continue
        for ms in view.milestones:
            if not ms.targets or ms.end_date is None:
                continue
            goal = await _baseline_goal(db, principal, view, ms.code)
            today = await company_time.company_today(db)
            p = build_plan(v.markdown, view, ms.code, today, _scale(goal))
            if p is not None:
                out.append(await _goal_of(db, principal, d, v, view, p))
    return sorted(out, key=lambda g: (-g.late_days, g.prd.title, g.milestone))


def _day(d: dt.date | None) -> str:
    return company_time.calendar_day(d) if d else "not dated"


def _effect(p: fd.Plan, c: fd.Change) -> str:
    """The change in one line, from the plan with it applied."""
    names = {m.code: m.name for m in p.milestones}
    item = next((i for i in p.items if i.id == c.id), None)
    after = fd.schedule(fd.apply(p, [c.id]))
    nxt = fd._next_code(p, p.milestone)
    if c.lever == "move" and item:
        if c.cost_kind == "must":
            return "Must-include for this goal"
        lands = _day(after.items.get(c.id))
        return f"Moves to {names.get(nxt or '', 'later')}: lands {lands}"
    if c.lever == "ungate":
        lands = _day(after.items.get(c.id))
        return f"Still built, lands {lands}; {p.milestone} no longer waits for it"
    if c.lever == "next_prd":
        return "Leaves this PRD; waits for the next one"
    if c.lever == "slice" and item:
        return f"{item.pw:g} person-weeks down to {item.slice_pw or item.pw:g}"
    if c.lever == "split" and item:
        return f"Slice 1 lands {_day(after.items.get(c.id))}; slice 2 after {p.milestone}"
    if c.lever == "overlap":
        return f"{p.milestone} work starts during the wait, not after it"
    return f"Every bar is shorter at {round((p.focus_raise or p.focus) * 100)}% focus"


# The weeks before a new engineer's work counts (the picked frame's "a 3-week start").
HIRE_START_WEEKS = 3


def _hire(p: fd.Plan, best: dt.date) -> FitHireOut:
    """The best date with one more engineer who counts only after their start weeks: the
    work left after the start goes at n + 1 engineers' pace instead of n's."""
    n = p.engineers
    start = HIRE_START_WEEKS * 7
    days = (best - p.start).days
    after = days if days <= start else start + math.ceil((days - start) * n / (n + 1))
    date = p.start + dt.timedelta(days=after)
    return FitHireOut(start_weeks=HIRE_START_WEEKS, date=date, reaches=date <= p.target)


@router.get("/prds/{prd}/fit-date", response_model=FitAnswerOut)
async def get_fit_date(
    prd: str, principal: Reader, db: TenantDB, milestone: Annotated[str, Query()]
) -> FitAnswerOut:
    """Oracle's ranked changes to bring the milestone in to its target."""
    document, v, view, p, goal = await _load_goal(db, principal, prd, milestone)
    a = fd.answer(p)
    return FitAnswerOut(
        **(await _goal_of(db, principal, document, v, view, p)).model_dump(),
        changes=[
            FitChangeOut(id=c.id, lever=c.lever, item=c.item, title=c.title, days=c.days,
                         pw_saved=c.pw_saved, cost_kind=c.cost_kind, cost=c.cost,
                         pickable=c.pickable, effect=_effect(p, c),
                         moves=[FitMove(what=w, before=b, after=x) for w, b, x in c.moves])
            for c in a.changes
        ],
        pick=list(a.pick), pick_date=a.pick_date, best_date=a.best_date, reachable=a.reachable,
        locked=[FitLockedOut(item=it.title, pw=it.pw, why=it.guard or "", would_reach=r)
                for it, r in a.locked],
        hire=None if a.reachable else _hire(p, a.best_date), baseline_goal=goal,
    )  # fmt: skip


@router.post("/prds/{prd}/fit-date/live", response_model=FitLiveOut)
async def fit_date_live(prd: str, body: FitPicksIn, principal: Reader, db: TenantDB) -> FitLiveOut:
    """The milestone's date with these changes picked: the capacity queue, no model call."""
    _, _, _, p = await _load(db, principal, prd, body.milestone)
    after = fd.apply(p, body.picks)
    date = fd.schedule(after).milestones[p.milestone]
    gated = sum(i.pw for i in p.items if i.milestone == p.milestone and i.gate)
    left = sum(i.pw for i in after.items if i.milestone == p.milestone and i.gate)
    return FitLiveOut(date=date, target=p.target, over_days=(date - p.target).days,
                      pw_saved=round(gated - left, 1), picks=body.picks)  # fmt: skip


def _estimates(p: fd.Plan, d: fd.Draft) -> list[FitEstimate]:
    owners = {i.id: i.owner for i in p.items}
    return [FitEstimate(item=i.title, owner=owners.get(i.id)) for i in d.needs_estimate]


def _draft_out(document, v, p: fd.Plan, d: fd.Draft) -> FitDraftOut:
    dates = []
    for what, before, after in d.dates:
        later = after is None or (before is not None and after > before)
        note = None
        if what == "Target":
            what = f"{p.milestone} target"
            note = (
                f"No set of changes reaches {company_time.calendar_day(before)}, "
                "so you approve the new target too"
            )
        dates.append(FitDateMove(what=what, before=before, after=after,
                                 kind="out" if later else "in", note=note))  # fmt: skip
    return FitDraftOut(
        prd=_ref(document), prd_version=v.number, next_version=v.number + 1,
        changes=[FitPrdChange(item=i, change=c) for i, c in d.prd], dates=dates,
        new_target=d.new_target, date=fd.schedule(d.plan).milestones[p.milestone],
        needs_estimate=_estimates(p, d),
    )  # fmt: skip


@router.post("/prds/{prd}/fit-date/draft", response_model=FitDraftOut)
async def fit_date_draft(
    prd: str, body: FitPicksIn, principal: Approver, db: TenantDB
) -> FitDraftOut:
    """The re-plan the picks write into the PRD's next version: nothing changes until it is
    approved."""
    document, v, _, p = await _load(db, principal, prd, body.milestone)
    out = _draft_out(document, v, p, fd.draft(p, body.picks))
    out.roadmap_version = (await _roadmap(db, document))[1]
    return out


def replan_markdown(text: str, p: fd.Plan, d: fd.Draft, picks: list[str]) -> str:
    """The next version's text: the re-plan section (each pick in words, read back by
    :func:`_replans`) and, when no set reaches the target, the milestone's new end date."""
    titles = {i.id: i.title for i in p.items}
    offered = {c.id: c for c in fd.answer(p).changes if c.pickable}
    lines = []
    for cid in picks:
        c = offered.get(cid)
        if c is None:
            continue
        if cid == "focus":
            head = "Team focus"
        elif cid.startswith("wait:"):
            head = f"{cid.removeprefix('wait:')} wait"
        else:
            head = f"{cid} {titles.get(cid, '')}".strip()
        lines.append(f"- {head}: {c.title.lower()}.")
    out = text.rstrip()
    if d.new_target:
        when = company_time.calendar_day_with_year(d.new_target)
        was = re.escape(company_time.calendar_day(p.target))
        out = re.sub(
            rf"^(\|\s*{re.escape(p.milestone)}\b[^\n]*)$",
            lambda m: re.sub(rf"{was}(, {p.target.year})?", when, m[1]),
            out, flags=re.M,
        )  # fmt: skip
    if "## Re-plan" not in out:
        out += "\n\n## Re-plan {#re-plan}\n"
    return out + "\n" + "\n".join(lines) + "\n"


async def _roadmap_follows(
    db, principal: Principal, document: Document, nv: DocumentVersion, p: fd.Plan, d: fd.Draft
) -> tuple[int | None, bool]:
    """The roadmap follows the re-plan: the PRD's items on its published roadmap take their
    re-planned end dates in the roadmap's working draft (as an approved PRD's items do,
    ``prd_roadmap``), which is submitted as its next version and approved through the same
    path as any Simple draft. An approver who does not decide the roadmap leaves it in review
    with its decider. Returns the version and whether it is live; (None, False) when nothing
    on the roadmap moved or its draft is in review already."""
    from oracle.roadmap import views
    from oracle.simple import drafts, prd_roadmap
    from oracle.simple.priorities import prd_code

    rid = await _roadmap_id(db, document)
    if rid is None:
        return None, False
    ends = fd.schedule(d.plan).items
    draft = await prd_roadmap._draft(db, rid, principal)
    if draft is None:
        return None, False
    base = await db.get(DocumentVersion, draft.base_version_id) if draft.base_version_id else None
    published = await views.version_items(db, base) if base is not None else []
    overlay = dict(draft.overlay or {})
    wrote: dict = {}
    asks: list = []
    for row in published:
        code = prd_code(row.prd_section_key)
        if row.prd_document_id != document.id or code is None:
            continue
        # An item's end is its last slice's ("F-03" ends with "F-03b").
        got = [x for k, x in ends.items() if re.fullmatch(rf"{re.escape(code)}[a-z]?", k) and x]
        if not got:
            continue
        cur = drafts.overlaid(row, overlay.get(str(row.id)))
        sized = [i for i in d.needs_estimate if re.fullmatch(rf"{re.escape(code)}[a-z]?", i.id)]
        resized = bool(sized)
        if cur.end_date == max(got) and cur.estimate_pending == resized:
            continue
        changed = drafts.overlaid(row, drafts.snapshot(cur))
        changed.end_date = max(got)
        if changed.start_date and changed.start_date > changed.end_date:
            changed.start_date = None
        # A sliced or split item's date waits on a new estimate from its owner.
        changed.estimate_pending = resized
        overlay[str(row.id)] = wrote[str(row.id)] = drafts.snapshot(changed)
        if resized and not cur.estimate_pending:
            asks.append((row, sized[0].title))
    if not wrote:
        return None, False
    sources = dict(overlay.get(prd_roadmap.KEY) or {})
    mine = dict(sources.get(str(document.id)) or {"items": [], prd_roadmap.KEY_DATES: []})
    mine["version"] = nv.number
    mine["items"] = list(dict.fromkeys([*(mine.get("items") or []), *wrote]))
    mine["wrote"] = {**(mine.get("wrote") or {}), **wrote}
    sources[str(document.id)] = mine
    overlay[prd_roadmap.KEY] = sources
    draft.overlay = overlay
    await db.flush()
    # Submitted as its next version whoever approves: by the approver when they change the
    # roadmap, else on behalf of the draft's routed author (its decider, prd_roadmap._draft).
    w = await drafts.who(db, {rid})
    sender = principal
    if not drafts.can_edit(principal, rid, w) and draft.created_by != drafts._me(principal):
        sender = await drafts.principal_for(db, principal.tenant_id, draft.created_by)
    try:
        async with db.begin_nested():
            await drafts.submit(db, sender, draft.id)
    except drafts.DraftError:
        return None, False
    try:
        async with db.begin_nested():
            await drafts.approve(db, principal, draft.id)
    except drafts.DraftError:
        # Not this approver's to decide: it waits in review on the roadmap's decider.
        pass
    await db.refresh(draft)
    version = await db.get(DocumentVersion, draft.version_id)
    await _ask_estimates(db, principal, rid, version, asks)
    return version.number, draft.status == "approved"


async def _ask_estimates(db, principal: Principal, rid, version: DocumentVersion, asks) -> None:
    """Each resized item's owner is asked for a new estimate (their Inbox); its date on the
    roadmap reads "Estimate pending" until then."""
    from oracle.review import collab

    actor = f"user:{getattr(principal, 'user_id', '')}"
    for row, title in asks:
        await collab.notify(
            db, [row.owner_id], kind="estimate_requested", actor=actor,
            title=f"{title} needs a new estimate: the re-plan resized it",
            document_id=rid, version_number=version.number,
            data={"item_id": str(row.id), "item_key": row.item_key},
        )  # fmt: skip


@router.post("/prds/{prd}/fit-date/approve", response_model=FitApprovedOut)
async def fit_date_approve(
    prd: str, body: FitPicksIn, principal: Approver, db: TenantDB
) -> FitApprovedOut:
    """Make the re-plan live: the PRD's next version, approved the way any version is (its
    roadmap follows); sliced or split items need a new estimate."""
    from oracle.docs import service as docs
    from oracle.review import service as review

    document, v, _, p = await _load(db, principal, prd, body.milestone)
    d = fd.draft(p, body.picks)
    if not d.prd:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Pick at least one change.")
    who = await _foreign_edits(db, document)
    if who is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"{who} {'has' if ' and ' not in who else 'have'} unsaved changes in this roadmap's "
            "draft; ask them to submit or discard first.",
        )
    text = replan_markdown(v.markdown, p, d, body.picks)
    try:
        res = await docs.import_draft(db, document.slug, text, principal, base_version=v.number,
                                      cause="fit_date", unverified_dates="mark")  # fmt: skip
        doc, nv = await review.approve_version(db, principal, document.slug, res.version.number)
    except HTTPException:
        raise
    except Exception as e:  # a gate refusing the version says why
        detail = getattr(e, "detail", None) or str(e)
        raise HTTPException(status.HTTP_409_CONFLICT, detail) from e
    was = fd.schedule(p).milestones[p.milestone]
    date = fd.schedule(d.plan).milestones[p.milestone]
    moves = [
        m.what + (f": {company_time.calendar_day(m.after)}" if m.after else ": not dated")
        for m in _draft_out(document, v, p, d).dates
        if m.what != f"{p.milestone} target"
    ]
    rv, live = await _roadmap_follows(db, principal, document, nv, p, d)
    if rv is None:
        rv = (await _roadmap(db, document))[1]
    await audit.record(db, principal, "simple_fit_date.approved", "document", document.id, data={
        "version": nv.number, "roadmap_version": rv, "picks": body.picks,
        "milestone": p.milestone, "was": was.isoformat(), "date": date.isoformat(),
        "target": (d.new_target or p.target).isoformat(), "moves": moves,
    })  # fmt: skip
    rm = (await _roadmap(db, document))[0]
    decider = await _decider(db, rm.id) if rm is not None and not live else None
    await db.commit()
    return FitApprovedOut(
        prd=_ref(doc), version=nv.number, date=fd.schedule(d.plan).milestones[p.milestone],
        target=d.new_target or p.target, approved_at=nv.approved_at,
        needs_estimate=_estimates(p, d), roadmap_version=rv, roadmap_live=live,
        roadmap_decider=decider,
    )  # fmt: skip
