"""Comments, section verdicts, feedback, approval.

Logic lives in :mod:`oracle.review.service`; each handler commits once.
"""

import uuid
from collections.abc import Awaitable
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import JSONResponse

from oracle.auth.deps import Principal, TenantDB
from oracle.authz import require_role, require_role_now
from oracle.docs.schemas import VersionSummary
from oracle.jobs import service as jobs_service
from oracle.review import publish_gate, service
from oracle.review.schemas import (
    ApproveOut,
    CommentCreate,
    CommentOut,
    CommentPatch,
    ConflictResponse,
    FeedbackItemOut,
    FeedbackPackage,
    FeedbackPatch,
    FeedbackStatus,
    PublishBlockedOut,
    ReplyCreate,
    ResolutionReport,
    SectionReviewIn,
    SectionReviewOut,
)

# Viewers read everything; commenters comment, reply and resolve their own threads;
# approvers set verdicts, triage feedback and approve versions.
router = APIRouter(prefix="/v1", tags=["review"], dependencies=[Depends(require_role("viewer"))])
Commenter = Annotated[Principal, Depends(require_role("commenter"))]
Approver = Annotated[Principal, Depends(require_role("approver"))]
ApproverNow = Annotated[Principal, Depends(require_role_now("approver"))]
VERSION = "/documents/{doc}/versions/{n}"

_STATUS = {
    "not_found": status.HTTP_404_NOT_FOUND,
    "invalid": 422,
    "forbidden": status.HTTP_403_FORBIDDEN,
    "conflict": status.HTTP_409_CONFLICT,
}


async def _call[T](op: Awaitable[T]) -> T:
    try:
        return await op
    except service.ReviewError as e:
        raise HTTPException(_STATUS[e.kind], e.message) from e


@router.post(VERSION + "/comments", response_model=CommentOut, status_code=status.HTTP_201_CREATED)
async def create_comment(
    doc: str, n: int, body: CommentCreate, principal: Commenter, db: TenantDB
) -> CommentOut:
    out = await _call(
        service.create_comment(
            db, principal, doc, n, body.section_key, body.anchor, body.body, body.severity
        )
    )
    # Oracle's review-comments job picks the new item up (when it is on for the document).
    version = await service.get_version(db, doc, n)
    await jobs_service.on_feedback(db, version.document_id, n)
    await db.commit()
    return out


@router.get(VERSION + "/comments", response_model=list[CommentOut])
async def list_comments(doc: str, n: int, db: TenantDB) -> list[CommentOut]:
    """Top-level comments with their replies nested."""
    return await _call(service.list_comments(db, doc, n))


@router.post(
    "/comments/{comment_id}/replies",
    response_model=CommentOut,
    status_code=status.HTTP_201_CREATED,
)
async def reply_to_comment(
    comment_id: uuid.UUID, body: ReplyCreate, principal: Commenter, db: TenantDB
) -> CommentOut:
    out = await _call(service.reply_to_comment(db, principal, comment_id, body.body))
    await db.commit()
    return out


@router.patch("/comments/{comment_id}", response_model=CommentOut)
async def update_comment(
    comment_id: uuid.UUID, body: CommentPatch, principal: Commenter, db: TenantDB
) -> CommentOut:
    out = await _call(service.update_comment(db, principal, comment_id, body.resolved, body.body))
    await db.commit()
    return out


@router.put(
    VERSION + "/sections/{key}/review",
    response_model=SectionReviewOut,
    responses={409: {"model": ConflictResponse, "description": "The section changed"}},
)
async def review_section(
    doc: str, n: int, key: str, body: SectionReviewIn, principal: Approver, db: TenantDB
) -> SectionReviewOut | JSONResponse:
    """A verdict on a section, bound to its revision. Send ``revision`` (the section's
    content hash you read) and a verdict on text that changed since is a 409."""
    try:
        review, item = await service.review_section(
            db, principal, doc, n, key, body.verdict, body.note, body.revision, body.severity
        )
    except service.ReviewError as e:
        if e.conflict is not None:
            return JSONResponse(
                ConflictResponse(**e.conflict).model_dump(mode="json"), status.HTTP_409_CONFLICT
            )
        raise HTTPException(_STATUS[e.kind], e.message) from e
    if item is not None:
        await jobs_service.on_feedback(db, item.document_id, n)
    await db.commit()
    out = SectionReviewOut.model_validate(review)
    out.feedback_item_id = item.id if item else None
    out.layer = await service.section_layer(db, review.version_id, review.section_key)
    return out


@router.get("/documents/{doc}/feedback", response_model=list[FeedbackItemOut])
async def list_feedback(
    doc: str,
    db: TenantDB,
    status: FeedbackStatus | None = None,
    version: int | None = None,
) -> list[FeedbackItemOut]:
    return await _call(service.list_feedback(db, doc, status, version))


@router.patch("/feedback/{feedback_id}", response_model=FeedbackItemOut)
async def update_feedback(
    feedback_id: uuid.UUID, body: FeedbackPatch, principal: ApproverNow, db: TenantDB
) -> FeedbackItemOut:
    fields = body.model_dump(exclude_unset=True)
    out = await _call(service.update_feedback(db, principal, feedback_id, fields))
    await db.commit()
    return out


@router.get(VERSION + "/feedback-package", response_model=FeedbackPackage)
async def get_feedback_package(doc: str, n: int, db: TenantDB) -> FeedbackPackage:
    return await _call(service.feedback_package(db, doc, n))


@router.get(VERSION + "/resolution-report", response_model=ResolutionReport)
async def get_resolution_report(doc: str, n: int, db: TenantDB) -> ResolutionReport:
    return await _call(service.resolution_report(db, doc, n))


@router.post(
    VERSION + "/approve",
    response_model=ApproveOut,
    responses={status.HTTP_409_CONFLICT: {"model": PublishBlockedOut}},
)
async def approve_version(
    doc: str, n: int, principal: Approver, db: TenantDB
) -> ApproveOut | JSONResponse:
    """Approve (publish) a version. A PRD version is refused with a 409 naming the blocks
    when its readiness verdict for purpose ``publish`` is blocked, or when it is not the
    latest version; nothing is recorded then."""
    try:
        document, version = await _call(service.approve_version(db, principal, doc, n))
    except publish_gate.PublishBlocked as e:
        await db.rollback()
        out = PublishBlockedOut(detail=e.message, blocking=e.blocking)
        return JSONResponse(out.model_dump(mode="json"), status_code=status.HTTP_409_CONFLICT)
    await db.commit()
    return ApproveOut(
        document_id=document.id,
        document_status=document.status,
        version=VersionSummary.model_validate(version),
    )
