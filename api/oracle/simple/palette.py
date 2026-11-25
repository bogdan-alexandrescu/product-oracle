"""The ⌘K palette's index (build-palette, issue 1794): ``GET /v1/simple/palette``, viewer
and up, people only. One company's PRDs (those the person may see, not in Trash), confirmed
goals with their measure, key results (the metrics that give a goal its readings) and goal
milestones on a roadmap. Features come from the Simple roadmap read.
"""

import uuid

from sqlalchemy import select

from oracle.auth.deps import TenantDB
from oracle.base_model import BaseModel
from oracle.baseline.models import Entity
from oracle.docs.models import Document
from oracle.docs.visibility import visible_to
from oracle.metrics.models import Metric
from oracle.roadmap.models import TrackMilestone
from oracle.routing import APIRouter
from oracle.simple.goal_map_router import Reader

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
    goal: str


class PaletteMilestone(BaseModel):
    id: uuid.UUID
    code: str
    name: str
    # Its date in words ("Dec 2"); empty: undated.
    date: str


class PaletteOut(BaseModel):
    prds: list[PalettePrd]
    goals: list[PaletteGoal]
    key_results: list[PaletteKeyResult]
    milestones: list[PaletteMilestone]


@router.get("", response_model=PaletteOut)
async def get_palette(principal: Reader, db: TenantDB) -> PaletteOut:
    docs = await db.scalars(
        select(Document)
        .where(Document.kind == "prd", Document.deleted_at.is_(None), visible_to(principal))
        .order_by(Document.title)
    )
    goals = list(
        await db.scalars(
            select(Entity)
            .where(Entity.type == "goal", Entity.status == "confirmed", Entity.deleted_at.is_(None))
            .order_by(Entity.title)
        )
    )
    names = {g.id: g.title for g in goals}
    metrics = await db.scalars(
        select(Metric).where(Metric.goal_id.in_(names.keys())).order_by(Metric.title)
    )
    milestones = await db.scalars(
        select(TrackMilestone)
        .join(Document, Document.id == TrackMilestone.roadmap_id)
        .where(TrackMilestone.deleted_at.is_(None), Document.deleted_at.is_(None))
        .order_by(TrackMilestone.target_date.nulls_last(), TrackMilestone.name)
    )
    return PaletteOut(
        prds=[PalettePrd(id=d.id, slug=d.slug, title=d.title, status=d.status) for d in docs],
        goals=[
            PaletteGoal(id=g.id, name=g.title, measure=str((g.attrs or {}).get("metric") or ""))
            for g in goals
        ],
        key_results=[
            PaletteKeyResult(id=m.id, name=m.title, goal=names[m.goal_id] if m.goal_id else "")
            for m in metrics
        ],
        milestones=[
            PaletteMilestone(
                id=m.id,
                code=m.code or "",
                name=m.name,
                date=f"{m.target_date:%b} {m.target_date.day}" if m.target_date else "",
            )
            for m in milestones
        ],
    )
