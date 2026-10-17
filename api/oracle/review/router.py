"""Comments, section verdicts, feedback, approval. Lane 2 implements; stubs return 501."""

import uuid

from fastapi import APIRouter, status

from oracle.auth.deps import CurrentPrincipal, TenantDB
from oracle.http import not_implemented
from oracle.review.schemas import (
    ApproveOut,
    CommentCreate,
    CommentOut,
    CommentPatch,
    FeedbackItemOut,
    FeedbackPackage,
    FeedbackPatch,
    FeedbackStatus,
    ReplyCreate,
    ResolutionReport,
    SectionReviewIn,
    SectionReviewOut,
)

router = APIRouter(prefix="/v1", tags=["review"])
VERSION = "/documents/{doc}/versions/{n}"


@router.post(VERSION + "/comments", response_model=CommentOut, status_code=status.HTTP_201_CREATED)
async def create_comment(
    doc: str, n: int, body: CommentCreate, principal: CurrentPrincipal, db: TenantDB
) -> CommentOut:
    raise not_implemented("2")


@router.get(VERSION + "/comments", response_model=list[CommentOut])
async def list_comments(doc: str, n: int, db: TenantDB) -> list[CommentOut]:
    """Top-level comments with their replies nested."""
    raise not_implemented("2")


@router.post(
    "/comments/{comment_id}/replies",
    response_model=CommentOut,
    status_code=status.HTTP_201_CREATED,
)
async def reply_to_comment(
    comment_id: uuid.UUID, body: ReplyCreate, principal: CurrentPrincipal, db: TenantDB
) -> CommentOut:
    raise not_implemented("2")


@router.patch("/comments/{comment_id}", response_model=CommentOut)
async def update_comment(
    comment_id: uuid.UUID, body: CommentPatch, principal: CurrentPrincipal, db: TenantDB
) -> CommentOut:
    raise not_implemented("2")


@router.put(VERSION + "/sections/{key}/review", response_model=SectionReviewOut)
async def review_section(
    doc: str, n: int, key: str, body: SectionReviewIn, principal: CurrentPrincipal, db: TenantDB
) -> SectionReviewOut:
    raise not_implemented("2")


@router.get("/documents/{doc}/feedback", response_model=list[FeedbackItemOut])
async def list_feedback(
    doc: str,
    db: TenantDB,
    status: FeedbackStatus | None = None,
    version: int | None = None,
) -> list[FeedbackItemOut]:
    raise not_implemented("2")


@router.patch("/feedback/{feedback_id}", response_model=FeedbackItemOut)
async def update_feedback(
    feedback_id: uuid.UUID, body: FeedbackPatch, principal: CurrentPrincipal, db: TenantDB
) -> FeedbackItemOut:
    raise not_implemented("2")


@router.get(VERSION + "/feedback-package", response_model=FeedbackPackage)
async def get_feedback_package(doc: str, n: int, db: TenantDB) -> FeedbackPackage:
    raise not_implemented("2")


@router.get(VERSION + "/resolution-report", response_model=ResolutionReport)
async def get_resolution_report(doc: str, n: int, db: TenantDB) -> ResolutionReport:
    raise not_implemented("2")


@router.post(VERSION + "/approve", response_model=ApproveOut)
async def approve_version(
    doc: str, n: int, principal: CurrentPrincipal, db: TenantDB
) -> ApproveOut:
    raise not_implemented("2")
