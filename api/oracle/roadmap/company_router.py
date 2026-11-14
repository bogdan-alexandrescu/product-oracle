"""one-roadmap-many-prds: the company roadmap, one team's queue across PRDs, and a PRD
replaced by area PRDs (oracle.roadmap.company)."""

import uuid
from datetime import date
from typing import Annotated

from fastapi import Depends, HTTPException, Response, status

from oracle.auth.deps import Principal, TenantDB
from oracle.authz import require_role, require_role_now
from oracle.base_model import BaseModel
from oracle.docs import service as docs_service
from oracle.docs.schemas import DocumentOut, PrdRef
from oracle.roadmap import company
from oracle.routing import APIRouter

router = APIRouter(prefix="/v1", tags=["roadmaps"])

Reader = Annotated[Principal, Depends(require_role("viewer"))]
ApproverNow = Annotated[Principal, Depends(require_role_now("approver"))]


class CompanyRoadmapOut(BaseModel):
    id: uuid.UUID
    slug: str
    title: str


class QueueItem(BaseModel):
    key: str
    title: str
    prd: PrdRef | None = None
    milestone: str | None = None
    effort_weeks: float
    start: date
    end: date


class QueueOut(BaseModel):
    roadmap: CompanyRoadmapOut | None = None
    team_size: int
    focus: float
    items: list[QueueItem] = []


class ReplacedByIn(BaseModel):
    # The slugs of the PRDs that replace this one, in order; empty: no longer replaced.
    prds: list[str]


@router.get(
    "/roadmaps/company",
    response_model=CompanyRoadmapOut,
    responses={404: {"description": "The company has no company roadmap yet"}},
)
async def get_company_roadmap(principal: Reader, db: TenantDB) -> CompanyRoadmapOut:
    """The company's one roadmap, which every PRD feeds."""
    found = await company.active(db)
    if found is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No company roadmap yet")
    return CompanyRoadmapOut(id=found.id, slug=found.slug, title=found.title)


@router.post(
    "/roadmaps/company",
    response_model=CompanyRoadmapOut,
    status_code=status.HTTP_201_CREATED,
    responses={200: {"model": CompanyRoadmapOut, "description": "It already exists"}},
)
async def create_company_roadmap(
    principal: ApproverNow, db: TenantDB, response: Response
) -> CompanyRoadmapOut:
    """Create the company roadmap ('Product roadmap') empty when none exists (the first-run
    step); with one, return it (200). Approvers and owners."""
    doc, made = await company.ensure(db, principal)
    await db.commit()
    if not made:
        response.status_code = status.HTTP_200_OK
    return CompanyRoadmapOut(id=doc.id, slug=doc.slug, title=doc.title)


@router.get("/roadmaps/company/queue", response_model=QueueOut)
async def get_company_queue(principal: Reader, db: TenantDB, prd: str | None = None) -> QueueOut:
    """Every item on the company roadmap planned as one team's capacity queue (team size x
    focus; milestone order, then the company goal order, then priority). ``prd`` (slug or
    id): only that PRD's items, with their places in the shared queue."""
    cap, rows = await company.queue(db)
    found = await company.active(db)
    items = [
        QueueItem(
            key=q.item.item_key,
            title=q.item.title,
            prd=PrdRef(**q.prd) if q.prd else None,
            milestone=(q.item.milestone or {}).get("name")
            if isinstance(q.item.milestone, dict)
            else None,
            effort_weeks=q.effort_weeks,
            start=q.start,
            end=q.end,
        )
        for q in rows
        if not prd or (q.prd is not None and prd in (q.prd["slug"], str(q.prd["id"])))
    ]
    return QueueOut(
        roadmap=CompanyRoadmapOut(id=found.id, slug=found.slug, title=found.title)
        if found
        else None,
        team_size=int(cap["team_size"]),
        focus=float(cap["focus"]),
        items=items,
    )


@router.post("/documents/{doc}/replaced-by", response_model=DocumentOut)
async def set_replaced_by(
    doc: str, body: ReplacedByIn, principal: ApproverNow, db: TenantDB
) -> DocumentOut:
    """Mark a PRD replaced by one or more PRDs (one per area of focus): it turns read-only,
    names them at its top, its items stop feeding the roadmap, and its verified schedule
    bases follow their items to the replacing PRDs ('carried from <title>')."""
    document = await docs_service.find_document(db, doc, for_update=True)
    if document is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"document '{doc}' not found")
    try:
        await company.replace(db, principal, document, body.prds)
    except company.CompanyError as e:
        raise HTTPException(e.status_code, str(e)) from e
    await db.commit()
    return await docs_service.read_document(db, document.slug)
