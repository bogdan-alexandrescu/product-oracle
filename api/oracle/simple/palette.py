"""The ⌘K palette's index (build-palette, issue 1794): ``GET /v1/simple/palette``, viewer
and up, people only. One company's PRDs (those the person may see, not in Trash), its confirmed
live goals with their measure, its key results (the confirmed live subgoals, each under its top
goal) and the goal milestones the person's own Simple roadmap read shows, one per roadmap code.
Features come from that read.
"""

import uuid
from datetime import date

from sqlalchemy import select

from oracle import company_time
from oracle.auth.deps import TenantDB
from oracle.base_model import BaseModel
from oracle.baseline.models import Entity
from oracle.docs.models import Document
from oracle.docs.visibility import visible_to
from oracle.routing import APIRouter
from oracle.simple import goal_reads, roadmap_codes, service
from oracle.simple.goal_buckets import is_live
from oracle.simple.goal_map_router import Reader
from oracle.simple.schemas import SimpleGoalMilestone, SimpleMilestone, SimpleRoadmapOut

router = APIRouter(prefix="/v1/simple/palette", tags=["simple"])


class PalettePrd(BaseModel):
    id: uuid.UUID
    slug: str
    title: str
    status: str


class PaletteGoal(BaseModel):
    id: uuid.UUID
    name: str
    measure: str


class PaletteKeyResult(BaseModel):
    id: uuid.UUID
    name: str
    # Its top goal, which the Goal map draws it in.
    goal: str
    goal_id: uuid.UUID


class PaletteMilestone(BaseModel):
    id: uuid.UUID
    # Its one code across the roadmap (oracle.simple.roadmap_codes).
    code: str
    name: str
    # Its date in words ("Dec 2"); empty: undated.
    date: str


class PaletteOut(BaseModel):
    prds: list[PalettePrd]
    goals: list[PaletteGoal]
    key_results: list[PaletteKeyResult]
    milestones: list[PaletteMilestone]


def _goals(by_id: dict[uuid.UUID, Entity]) -> tuple[list[PaletteGoal], list[PaletteKeyResult]]:
    """The confirmed live goals, and the confirmed live subgoals under the top goal each folds
    into: up its confirmed parents, as Simple's goal lists (web/lib/key-results.ts)."""
    live = {i: g for i, g in by_id.items() if g.status == "confirmed" and is_live(by_id, i)}
    goals, results = [], []
    for g in sorted(live.values(), key=lambda g: (g.title, str(g.id))):
        top = g
        while top.parent_id in live:  # is_live: the walk up ends at a top goal
            top = live[top.parent_id]
        if top is g:
            measure = str((g.attrs or {}).get("metric") or "")
            goals.append(PaletteGoal(id=g.id, name=g.title, measure=measure))
        else:
            results.append(PaletteKeyResult(id=g.id, name=g.title, goal=top.title, goal_id=top.id))
    return goals, results


def _name(members: list[SimpleMilestone | SimpleGoalMilestone]) -> str:
    """The longer name of the milestones of one code (web/lib/milestone-code.ts joinedNames)."""
    names = [" ".join(roadmap_codes.split(m.name)[1].split()) for m in members]
    return max(names, key=lambda n: (len(n.split()), len(n)))


def _day(tracks: list[SimpleMilestone], goal_ms: list[SimpleGoalMilestone]) -> date | None:
    """The date the code goes by (roadmap_codes.assign): its track milestone's, else its
    earliest goal's own milestone's, else its earliest."""
    if tracks and tracks[0].date is not None:
        return tracks[0].date
    own = [m.date for m in goal_ms if m.goal_id and m.prd is None and m.date]
    dates = [m.date for m in [*tracks, *goal_ms] if m.date]
    return min(dates if tracks or not own else own, default=None)


def _milestones(read: SimpleRoadmapOut) -> list[PaletteMilestone]:
    """The read's goal milestones, one per roadmap code (twins folded, as every page shows them)."""
    groups: dict[str, list[SimpleGoalMilestone]] = {}
    for m in read.goal_milestones:
        if m.roadmap_code:
            groups.setdefault(m.roadmap_code, []).append(m)
    out = []
    for code, of in sorted(groups.items(), key=lambda x: int(x[0][1:])):
        tracks = [m for m in read.milestones if m.roadmap_code == code]
        day = _day(tracks, of)
        # The row opens the goal's own milestone, else the first (a PRD's).
        first = next((m for m in of if m.goal_id and m.prd is None), of[0])
        out.append(
            PaletteMilestone(
                id=first.id,
                code=code,
                name=_name([*tracks, *of]),
                date=company_time.calendar_day(day) if day else "",
            )
        )
    return out


@router.get("", response_model=PaletteOut)
async def get_palette(principal: Reader, db: TenantDB) -> PaletteOut:
    docs = await db.scalars(
        select(Document)
        .where(Document.kind == "prd", Document.deleted_at.is_(None), visible_to(principal))
        .order_by(Document.title)
    )
    prds = [PalettePrd(id=d.id, slug=d.slug, title=d.title, status=d.status) for d in docs]
    goals, key_results = _goals(await goal_reads.goals_by_id(db))
    # Their rights, codes and folding are the roadmap read's own.
    milestones = _milestones(await service.build(db, principal))
    return PaletteOut(prds=prds, goals=goals, key_results=key_results, milestones=milestones)
