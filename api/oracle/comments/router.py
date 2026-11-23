"""Comments on a feature (#1553): everyone who can open the app reads and adds them (a
viewer's one write); a person edits and deletes their own, an owner deletes any.

The routes take the id of the row the panel shows (``SimpleRoadmapItem.id``); the comment is
kept on that row's roadmap and ``item_key`` (oracle.comments.models). A feature in Trash is
not found, so its comments are hidden with it and back when it is restored.
"""

import uuid
from datetime import datetime
from typing import Annotated

from fastapi import Depends, HTTPException, status
from pydantic import Field, field_validator
from sqlalchemy import func, select

from oracle import company_time
from oracle.auth.deps import Principal, TenantDB, same_origin
from oracle.auth.models import User
from oracle.authz import has_role
from oracle.base_model import BaseModel
from oracle.comments.models import MAX_BODY, FeatureComment
from oracle.members.names import display_name
from oracle.roadmap.models import RoadmapItem
from oracle.routing import APIRouter
from oracle.simple.router import _people

router = APIRouter(prefix="/v1/simple", tags=["simple"], dependencies=[Depends(same_origin)])

Reader = Annotated[Principal, Depends(_people("viewer"))]


class FeatureCommentIn(BaseModel):
    body: str = Field(max_length=MAX_BODY)

    @field_validator("body")
    @classmethod
    def _not_blank(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Write something first")
        return v


class FeatureCommentAuthor(BaseModel):
    id: uuid.UUID
    name: str


class FeatureCommentOut(BaseModel):
    id: uuid.UUID
    author: FeatureCommentAuthor
    body: str
    created_at: datetime
    edited_at: datetime | None = None
    can_edit: bool
    can_delete: bool


class FeatureCommentCount(BaseModel):
    roadmap_id: uuid.UUID
    key: str
    count: int


async def _feature(db, item_id: uuid.UUID) -> tuple[uuid.UUID, str]:
    item = await db.get(RoadmapItem, item_id)
    if item is None or item.deleted_at is not None or item.roadmap_document_id is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Feature not found")
    return item.roadmap_document_id, item.item_key


async def _comment(db, item_id: uuid.UUID, comment_id: uuid.UUID) -> FeatureComment:
    roadmap_id, key = await _feature(db, item_id)
    c = await db.get(FeatureComment, comment_id)
    if (
        c is None
        or c.deleted_at is not None
        or (c.roadmap_document_id, c.item_key)
        != (
            roadmap_id,
            key,
        )
    ):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Comment not found")
    return c


def _out(c: FeatureComment, author: User | None, principal: Principal) -> FeatureCommentOut:
    mine = principal.user_id is not None and c.author_id == principal.user_id
    return FeatureCommentOut(
        id=c.id,
        author=FeatureCommentAuthor(
            id=c.author_id, name=display_name(author.email, author.name) if author else "Someone"
        ),
        body=c.body,
        created_at=c.created_at,
        edited_at=c.edited_at,
        can_edit=mine,
        can_delete=mine or has_role(principal.role, "owner"),
    )


async def _author(db, c: FeatureComment) -> User | None:
    return await db.get(User, c.author_id)


@router.get("/roadmap/items/{item_id}/comments", response_model=list[FeatureCommentOut])
async def list_feature_comments(
    item_id: uuid.UUID, principal: Reader, db: TenantDB
) -> list[FeatureCommentOut]:
    roadmap_id, key = await _feature(db, item_id)
    rows = (
        await db.execute(
            select(FeatureComment, User)
            .outerjoin(User, User.id == FeatureComment.author_id)
            .where(
                FeatureComment.roadmap_document_id == roadmap_id,
                FeatureComment.item_key == key,
                FeatureComment.deleted_at.is_(None),
            )
            .order_by(FeatureComment.created_at, FeatureComment.id)
        )
    ).all()
    return [_out(c, u, principal) for c, u in rows]


@router.post(
    "/roadmap/items/{item_id}/comments",
    response_model=FeatureCommentOut,
    status_code=status.HTTP_201_CREATED,
)
async def add_feature_comment(
    item_id: uuid.UUID, body: FeatureCommentIn, principal: Reader, db: TenantDB
) -> FeatureCommentOut:
    if principal.user_id is None or principal.read_only:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only a person can comment")
    roadmap_id, key = await _feature(db, item_id)
    c = FeatureComment(
        roadmap_document_id=roadmap_id, item_key=key, author_id=principal.user_id, body=body.body
    )
    db.add(c)
    await db.commit()
    await db.refresh(c)
    return _out(c, await _author(db, c), principal)


@router.patch("/roadmap/items/{item_id}/comments/{comment_id}", response_model=FeatureCommentOut)
async def edit_feature_comment(
    item_id: uuid.UUID,
    comment_id: uuid.UUID,
    body: FeatureCommentIn,
    principal: Reader,
    db: TenantDB,
) -> FeatureCommentOut:
    c = await _comment(db, item_id, comment_id)
    if principal.read_only or c.author_id != principal.user_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only its author can edit a comment")
    c.body = body.body
    c.edited_at = company_time.now()
    await db.commit()
    await db.refresh(c)
    return _out(c, await _author(db, c), principal)


@router.delete(
    "/roadmap/items/{item_id}/comments/{comment_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def delete_feature_comment(
    item_id: uuid.UUID, comment_id: uuid.UUID, principal: Reader, db: TenantDB
) -> None:
    c = await _comment(db, item_id, comment_id)
    mine = principal.user_id is not None and c.author_id == principal.user_id
    if principal.read_only or not (mine or has_role(principal.role, "owner")):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only its author or an owner can delete it")
    c.deleted_at = company_time.now()
    await db.commit()


@router.get("/comment-counts", response_model=list[FeatureCommentCount])
async def list_feature_comment_counts(principal: Reader, db: TenantDB) -> list[FeatureCommentCount]:
    """How many comments each feature has (only those with one), by roadmap and key."""
    rows = (
        await db.execute(
            select(FeatureComment.roadmap_document_id, FeatureComment.item_key, func.count())
            .where(FeatureComment.deleted_at.is_(None))
            .group_by(FeatureComment.roadmap_document_id, FeatureComment.item_key)
        )
    ).all()
    return [FeatureCommentCount(roadmap_id=r, key=k, count=n) for r, k, n in rows]
