"""The Plan screen's reads (F1, c7 Plan rename). Viewer and up, company-scoped. A run's
token is refused: the Plan is for people (the ``plan`` area is in no run-token scope,
oracle.mcp.scopes), and people's MCP clients get ``get_plan`` and
``get_plan_item_history`` from these operations (I2 MCP parity). Nothing is written.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status

from oracle.auth.deps import Principal, TenantDB
from oracle.authz import require_role
from oracle.docs import service as docs_service
from oracle.plan import service
from oracle.plan.schemas import ItemHistoryOut, PlanOut, PlanScope

router = APIRouter(prefix="/v1/plan", tags=["plan"])


async def _person(principal: Annotated[Principal, Depends(require_role("viewer"))]) -> Principal:
    if principal.run_id is not None or principal.run_token_id is not None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "The plan is not available to runs")
    return principal


Reader = Annotated[Principal, Depends(_person)]


@router.get("", response_model=PlanOut)
async def get_plan(principal: Reader, db: TenantDB, scope: PlanScope = "all") -> PlanOut:
    """The Plan: the PRDs in play with their stage, and every roadmap item under Now,
    Next and Later with its state, engineering status and next decision. ``scope=all``
    adds the items of each roadmap's latest draft (``origin: draft``), each marked with
    how it differs from its approved twin; ``scope=approved`` leaves them out."""
    return await service.build(db, principal, scope)


@router.get("/items/history", response_model=ItemHistoryOut)
async def get_plan_item_history(
    principal: Reader,
    db: TenantDB,
    roadmap: Annotated[str, Query(min_length=1, max_length=200)],
    item: Annotated[str, Query(min_length=1, max_length=200)],
) -> ItemHistoryOut:
    """A roadmap item across its roadmap's versions, in version order: its horizon in
    each version that has it, the PRD version it came from, and when that roadmap
    version was approved. ``tracker_events`` stays empty until F2 Track health."""
    try:
        document = await docs_service.get_document_or_404(db, roadmap)
    except docs_service.NotFoundError as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(e)) from e
    if document.kind != "roadmap":
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f"'{document.slug}' is a {document.kind}, not a roadmap",
        )
    return await service.item_history(db, document, item)
