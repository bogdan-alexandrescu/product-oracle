"""The ⌘K palette's index (build-palette, issue 1794): ``GET /v1/simple/palette``, viewer
and up, people only. One company's PRDs (those the person may see, not in Trash), its confirmed
live goals with their measure, its key results (the confirmed live subgoals, each under its top
goal), the milestones the person's own Simple roadmap read shows (its tracks' and its goals'),
one per roadmap code, and the confirmed live Ground Truth features no roadmap item holds.
Features on a roadmap come from that read.
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
from oracle.roadmap import codes as roadmap_codes_of
from oracle.roadmap.models import RoadmapItem
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


class PaletteFeature(BaseModel):
    id: uuid.UUID
    # Its Ground Truth code (oracle.roadmap.codes.feature_codes); null: none yet.
    code: str | None
    name: str


class PaletteOut(BaseModel):
    prds: list[PalettePrd]
    goals: list[PaletteGoal]
    key_results: list[PaletteKeyResult]
    milestones: list[PaletteMilestone]
    features: list[PaletteFeature]


def _goals(by_id: dict[uuid.UUID, Entity]) -> tuple[list[PaletteGoal], list[PaletteKeyResult]]:
    """The confirmed live goals, and the confirmed live subgoals under the top goal each folds
    into: up its confirmed parents, as Simple's goal lists (web/lib/key-results.ts)."""
    live = {i: g for i, g in by_id.items() if g.status == "confirmed" and is_live(by_id, i)}
    goals, results = [], []
    for g in sorted(live.values(), key=lambda g: (g.title, str(g.id))):
        top = g
        # is_live: the walk up ends at a top goal.
        while (up := top.parent_id) is not None and up in live:
            top = live[up]
        if top is g:
            metric = (g.attrs or {}).get("metric")
            measure = metric if isinstance(metric, str) else ""
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
    """The read's milestones, its tracks' and its goals', one per roadmap code (twins folded, as
    every page shows them)."""
    codes = {m.roadmap_code for m in [*read.milestones, *read.goal_milestones] if m.roadmap_code}
    out = []
    for code in sorted(codes, key=lambda c: int(c[1:])):
        tracks = [m for m in read.milestones if m.roadmap_code == code]
        of = [m for m in read.goal_milestones if m.roadmap_code == code]
        day = _day(tracks, of)
        # The row opens the goal's own milestone, else the first (a PRD's), else the track's.
        first = next((m for m in of if m.goal_id and m.prd is None), of[0] if of else tracks[0])
        out.append(
            PaletteMilestone(
                id=first.id,
                code=code,
                name=_name([*tracks, *of]),
                date=company_time.calendar_day(day) if day else "",
            )
        )
    return out


async def _features(db: TenantDB, read: SimpleRoadmapOut) -> list[PaletteFeature]:
    """The confirmed Ground Truth features not in Trash that no item of the roadmap read holds,
    by code (a feature only an older version or a draft holds is on no roadmap a person sees)."""
    ids = [i.id for i in read.items]
    held = set(
        await db.scalars(
            select(RoadmapItem.feature_id).where(
                RoadmapItem.id.in_(ids), RoadmapItem.feature_id.is_not(None)
            )
        )
    )
    codes = await roadmap_codes_of.feature_codes(db)
    rows = await db.scalars(
        select(Entity).where(Entity.type == "feature", Entity.status == "confirmed")
    )
    found = [
        PaletteFeature(id=f.id, code=codes.get(f.id), name=f.title)
        for f in rows
        if f.id not in held
    ]
    return sorted(found, key=lambda f: (f.code is None, f.code or "", f.name))


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
    roadmap = await service.build(db, principal)
    milestones = _milestones(roadmap)
    features = await _features(db, roadmap)
    return PaletteOut(
        prds=prds, goals=goals, key_results=key_results, milestones=milestones, features=features
    )
