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
  approved through the same path as any PRD version (its roadmap follows,
  ``prd_roadmap.on_prd_approved``); the resized items' estimates go back to unverified.
"""

from __future__ import annotations

import datetime as dt
import math
import re
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

# What drafting the re-plan takes, from the run estimator's figures for a PRD re-draft.
RUN_SECONDS = 40
RUN_USD = 0.20

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
    moves: list[FitMove]


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


class FitGoalOut(BaseModel):
    prd: SimpleDocRef
    prd_version: int
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


class FitAnswerOut(FitGoalOut):
    changes: list[FitChangeOut]
    pick: list[str]
    pick_date: dt.date
    best_date: dt.date
    reachable: bool
    locked: list[FitLockedOut]
    run_seconds: int
    run_usd: float


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
    changes: list[FitPrdChange]
    dates: list[FitDateMove]
    new_target: dt.date | None = None
    date: dt.date
    needs_estimate: list[FitEstimate]
    run_seconds: int
    run_usd: float


class FitApprovedOut(BaseModel):
    prd: SimpleDocRef
    version: int
    date: dt.date
    target: dt.date
    approved_at: dt.datetime
    needs_estimate: list[FitEstimate]


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


def build_plan(text: str, view: plan.View, milestone: str, today: dt.date) -> fd.Plan | None:
    """The fit-date plan of a PRD's approved version: None when the milestone has no date."""
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
        lever = _lever(sl, asked_goal)
        items.append(fd.Item(
            id=sl.code, title=sl.name, pw=pw, milestone=sl.milestone, guard=guard,
            must=kind == "must-include", lever=lever,
            slice_pw=math.ceil(pw) / 2 if lever in ("slice", "split") else None,
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
    try:
        document = await one_pager._document(db, principal, prd)
    except ChangeError as e:
        raise HTTPException(e.status, e.detail) from e
    v = await _approved(db, document)
    view = (await plan.views(db, {document.id})).get(document.id)
    if v is None or view is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "This PRD has no approved plan yet.")
    today = await company_time.company_today(db)
    p = build_plan(v.markdown, view, milestone, today)
    if p is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No dated milestone by that name.")
    return document, v, view, p


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
            p = build_plan(v.markdown, view, ms.code, await company_time.company_today(db))
            if p is not None:
                out.append(_goal(d, v, view, p))
    return sorted(out, key=lambda g: (-g.late_days, g.prd.title, g.milestone))


@router.get("/prds/{prd}/fit-date", response_model=FitAnswerOut)
async def get_fit_date(
    prd: str, principal: Reader, db: TenantDB, milestone: Annotated[str, Query()]
) -> FitAnswerOut:
    """Oracle's ranked changes to bring the milestone in to its target."""
    document, v, view, p = await _load(db, principal, prd, milestone)
    a = fd.answer(p)
    return FitAnswerOut(
        **_goal(document, v, view, p).model_dump(),
        changes=[
            FitChangeOut(id=c.id, lever=c.lever, item=c.item, title=c.title, days=c.days,
                         pw_saved=c.pw_saved, cost_kind=c.cost_kind, cost=c.cost,
                         pickable=c.pickable,
                         moves=[FitMove(what=w, before=b, after=x) for w, b, x in c.moves])
            for c in a.changes
        ],
        pick=list(a.pick), pick_date=a.pick_date, best_date=a.best_date, reachable=a.reachable,
        locked=[FitLockedOut(item=it.title, pw=it.pw, why=it.guard or "", would_reach=r)
                for it, r in a.locked],
        run_seconds=RUN_SECONDS, run_usd=RUN_USD,
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
                f"No set of changes reaches {before:%b} {before.day}, "
                "so you approve the new target too"
            )
        dates.append(FitDateMove(what=what, before=before, after=after,
                                 kind="out" if later else "in", note=note))  # fmt: skip
    return FitDraftOut(
        prd=_ref(document), prd_version=v.number, next_version=v.number + 1,
        changes=[FitPrdChange(item=i, change=c) for i, c in d.prd], dates=dates,
        new_target=d.new_target, date=fd.schedule(d.plan).milestones[p.milestone],
        needs_estimate=_estimates(p, d),
        run_seconds=RUN_SECONDS, run_usd=RUN_USD,
    )  # fmt: skip


@router.post("/prds/{prd}/fit-date/draft", response_model=FitDraftOut)
async def fit_date_draft(
    prd: str, body: FitPicksIn, principal: Approver, db: TenantDB
) -> FitDraftOut:
    """The re-plan the picks write into the PRD's next version: nothing changes until it is
    approved."""
    document, v, _, p = await _load(db, principal, prd, body.milestone)
    return _draft_out(document, v, p, fd.draft(p, body.picks))


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
        when = f"{d.new_target:%b} {d.new_target.day}, {d.new_target.year}"
        out = re.sub(
            rf"^(\|\s*{re.escape(p.milestone)}\b[^\n]*)$",
            lambda m: re.sub(rf"{p.target:%b} {p.target.day}(, {p.target.year})?", when, m[1]),
            out, flags=re.M,
        )  # fmt: skip
    if "## Re-plan" not in out:
        out += "\n\n## Re-plan {#re-plan}\n"
    return out + "\n" + "\n".join(lines) + "\n"


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
    await audit.record(db, principal, "simple_fit_date.approved", "document", document.id,
                       data={"version": nv.number, "picks": body.picks})  # fmt: skip
    await db.commit()
    return FitApprovedOut(
        prd=_ref(doc), version=nv.number, date=fd.schedule(d.plan).milestones[p.milestone],
        target=d.new_target or p.target, approved_at=nv.approved_at,
        needs_estimate=_estimates(p, d),
    )  # fmt: skip
