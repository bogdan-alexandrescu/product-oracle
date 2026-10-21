"""The people who asked for a launch's items, in this order:

1. **Requests** (C1 Requests): requests linked to the items' features or requirements,
   with the requester's name and how they reached the company, as given. Until C1
   ships nothing is registered here and this source is empty (``REQUEST_SOURCES``).
2. **Members** whose PRD comments led to the items' requirements: authors of comment
   feedback addressed on the item's PRD section, in the PRD version the item came from
   or an earlier one.
3. **People added by hand** on the launch (``requester_kind = manual``).

Oracle never looks contact details up: ``contact_hint`` holds only what the requester
gave. Each requester gets one note per launch (``sync_notes``).
"""

import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.auth.models import User
from oracle.docs.models import DocumentVersion
from oracle.launches.models import Launch, RequesterNote
from oracle.launches.tiers import items_of
from oracle.review.models import Comment, FeedbackItem


@dataclass
class Requester:
    kind: str  # request | member
    display_name: str
    request_id: uuid.UUID | None = None
    member_id: uuid.UUID | None = None
    contact_hint: str | None = None
    asked: str | None = None


# C1 Requests registers its lookup here: (db, launch, items) -> requesters.
RequestSource = Callable[[AsyncSession, Launch, list], Awaitable[list[Requester]]]
REQUEST_SOURCES: list[RequestSource] = []


async def _members(db: AsyncSession, launch: Launch, items: list) -> list[Requester]:
    found: dict[uuid.UUID, Requester] = {}
    for item in items:
        if item.prd_document_id is None or not item.prd_section_key:
            continue
        number = None
        if item.prd_version_id is not None:
            number = await db.scalar(
                select(DocumentVersion.number).where(DocumentVersion.id == item.prd_version_id)
            )
        query = (
            select(Comment.body, User)
            .join(FeedbackItem, FeedbackItem.comment_id == Comment.id)
            .join(User, User.id == Comment.author_id)
            .where(
                FeedbackItem.document_id == item.prd_document_id,
                FeedbackItem.section_key == item.prd_section_key,
                FeedbackItem.status == "addressed",
                User.disabled_at.is_(None),
            )
            .order_by(Comment.created_at, Comment.id)
        )
        if number is not None:
            query = query.where(FeedbackItem.addressed_in_version <= number)
        for body, user in (await db.execute(query)).all():
            r = found.get(user.id)
            if r is None:
                found[user.id] = Requester(
                    kind="member", display_name=user.email, member_id=user.id, asked=body
                )
            elif body and body not in (r.asked or ""):
                r.asked = f"{r.asked}\n\n{body}" if r.asked else body
    return list(found.values())


async def list_requesters(db: AsyncSession, launch: Launch) -> list[Requester]:
    items = await items_of(db, launch)
    out: list[Requester] = []
    for source in REQUEST_SOURCES:
        out += await source(db, launch, items)
    out += await _members(db, launch, items)
    return out


async def sync_notes(db: AsyncSession, launch: Launch) -> int:
    """A note for every requester who has none on this launch yet; returns how many
    were added. People added by hand already have theirs."""
    have = {
        (n.requester_kind, n.request_id, n.member_id)
        for n in await db.scalars(select(RequesterNote).where(RequesterNote.launch_id == launch.id))
    }
    added = 0
    for r in await list_requesters(db, launch):
        if (r.kind, r.request_id, r.member_id) in have:
            continue
        db.add(
            RequesterNote(
                launch_id=launch.id,
                requester_kind=r.kind,
                request_id=r.request_id,
                member_id=r.member_id,
                display_name=r.display_name,
                contact_hint=r.contact_hint,
                asked=r.asked,
            )
        )
        have.add((r.kind, r.request_id, r.member_id))
        added += 1
    await db.flush()
    return added
