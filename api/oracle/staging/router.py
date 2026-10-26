"""G4 One staging list: ``GET /v1/staging`` (viewers and up) and unstaging a next-draft
row (approvers). Both are MCP tools with the caller's role; run tokens never reach them
(``staging`` and ``next-draft-changes`` are not run-token areas, oracle.mcp.scopes)."""

import uuid
from collections.abc import Awaitable
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query

from oracle.auth.deps import Principal, TenantDB
from oracle.authz import require_role
from oracle.jobs.service import JobError
from oracle.staging import service
from oracle.staging.schemas import NextDraftChangeOut, StagingList, UnstageIn

router = APIRouter(prefix="/v1", tags=["staging"], dependencies=[Depends(require_role("viewer"))])
Viewer = Annotated[Principal, Depends(require_role("viewer"))]
Approver = Annotated[Principal, Depends(require_role("approver"))]


async def _call[T](op: Awaitable[T]) -> T:
    try:
        return await op
    except service.StagingError as e:
        raise HTTPException(e.status, e.detail) from e
    except JobError as e:  # a document's lookup (oracle.jobs.next_draft): 404, 409, 422
        raise HTTPException(e.status, str(e)) from e


@router.get("/staging", response_model=StagingList)
async def list_staging(
    principal: Viewer,
    db: TenantDB,
    document: Annotated[str | None, Query(description="A document's slug")] = None,
    checkpoint: Annotated[uuid.UUID | None, Query(description="A checkpoint's id")] = None,
) -> StagingList:
    """Everything staged for one target, from every origin: for a document, the accepted
    review suggestions (C1e) and the section changes staged from discussions; for a
    checkpoint, its shared draft's actions from rows and from discussions. A row from a
    private discussion the caller is not in names no discussion."""
    return await _call(service.staging_list(db, principal, document, checkpoint))


@router.post("/next-draft-changes/{change_id}/unstage", response_model=NextDraftChangeOut)
async def unstage_next_draft_change(
    change_id: uuid.UUID, body: UnstageIn, principal: Approver, db: TenantDB
) -> NextDraftChangeOut:
    """Take a discussion's section change out of the next draft; its discussion change
    goes back to the discussion. 409 "Already in draft <n>" once applied."""
    return await _call(service.unstage(db, principal, change_id, body.lock_version))
