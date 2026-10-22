"""Section owners and reviewer assignees, due dates, organization-wide feedback campaigns
and in-app notifications (CR-06, build prompt §9). Slack notifications are wave 2.

Nothing here approves anything: assignees and campaign invitees comment and give
verdicts through the existing review routes; the designated decider stays the approval
authority (``oracle.review.state``). Service functions flush, never commit.
"""

import uuid
from collections.abc import Iterable
from typing import TYPE_CHECKING, Any

from sqlalchemy import Uuid, any_, distinct, func, literal, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.auth.models import User
from oracle.authz import has_role
from oracle.docs import visibility
from oracle.docs.models import Document, DocumentVersion, Section
from oracle.review.models import (
    Comment,
    FeedbackItem,
    Notification,
    ReviewCampaign,
    SectionReviewState,
)
from oracle.review.schemas import (
    CampaignCreate,
    CampaignOut,
    ReviewQueueItem,
    SectionAssignmentIn,
    SectionAssignmentOut,
)
from oracle.review.state import counting_history, now, review_revisions, section_status
from oracle.v2.concurrency import VersionConflict, expect_version, flush_or_conflict

if TYPE_CHECKING:
    from oracle.auth.deps import Principal


class CollabError(Exception):
    def __init__(self, kind: str, message: str):
        self.kind = kind  # "not_found" | "invalid" | "forbidden"
        self.message = message
        super().__init__(message)


# --- notifications --------------------------------------------------------------------


async def notify(
    db: AsyncSession,
    recipients: Iterable[uuid.UUID | None],
    *,
    kind: str,
    title: str,
    actor: str,
    document_id: uuid.UUID | None = None,
    version_number: int | None = None,
    section_key: str | None = None,
    comment_id: uuid.UUID | None = None,
    campaign_id: uuid.UUID | None = None,
    data: dict[str, Any] | None = None,
) -> int:
    """One notification per distinct recipient who is a user of this company, except
    whoever caused it. Returns how many were written."""
    ids = list(dict.fromkeys(r for r in recipients if r is not None))
    if not ids:
        return 0
    stmt = select(User.id).where(User.id.in_(ids), User.disabled_at.is_(None))
    if document_id is not None:
        # H8: nobody hears about a document they may not see (an update reaches owners
        # and approvers only).
        visible = await db.scalar(
            select(Document.visibility)
            .where(Document.id == document_id)
            .execution_options(oracle_all_documents=True)
        )
        if visible is not None and visible != visibility.COMPANY:
            stmt = stmt.where(User.role.in_(("approver", "owner")))
    users = set(await db.scalars(stmt))
    written = 0
    for uid in ids:
        if uid not in users or actor == f"user:{uid}":
            continue
        db.add(
            Notification(
                user_id=uid,
                kind=kind,
                title=title,
                actor=actor,
                document_id=document_id,
                version_number=version_number,
                section_key=section_key,
                comment_id=comment_id,
                campaign_id=campaign_id,
                data=data or {},
            )
        )
        written += 1
    await db.flush()
    return written


async def on_comment(
    db: AsyncSession,
    principal: "Principal",
    document: Document,
    version_number: int,
    comment: Comment,
    parent: Comment | None = None,
) -> None:
    """Comment notifications: the section's owner and reviewers; on a reply, also the
    thread's participants."""
    state = await db.scalar(
        select(SectionReviewState).where(
            SectionReviewState.document_id == document.id,
            SectionReviewState.section_key == comment.section_key,
        )
    )
    recipients: list[uuid.UUID | None] = []
    if state is not None:
        recipients += [state.owner_id, *state.reviewer_ids]
    if parent is not None:
        recipients.append(parent.author_id)
        recipients += list(
            await db.scalars(select(Comment.author_id).where(Comment.parent_id == parent.id))
        )
    await notify(
        db,
        recipients,
        kind="reply" if parent is not None else "comment",
        title=(
            f"New reply on {comment.section_key} in {document.title}"
            if parent is not None
            else f"New comment on {comment.section_key} in {document.title}"
        ),
        actor=principal.actor,
        document_id=document.id,
        version_number=version_number,
        section_key=comment.section_key,
        comment_id=comment.id,
    )


async def list_notifications(
    db: AsyncSession, principal: "Principal", unread: bool, limit: int
) -> list[Notification]:
    if principal.user_id is None:
        return []
    stmt = select(Notification).where(Notification.user_id == principal.user_id)
    # H8: none about a document the caller may not see now (it may have been closed to
    # owners and approvers since).
    hidden = await visibility.hidden_document_ids(db)
    if hidden:
        stmt = stmt.where(
            Notification.document_id.is_(None) | Notification.document_id.not_in(hidden)
        )
    if unread:
        stmt = stmt.where(Notification.read_at.is_(None))
    return list(
        await db.scalars(
            stmt.order_by(Notification.created_at.desc(), Notification.id).limit(limit)
        )
    )


async def mark_read(
    db: AsyncSession, principal: "Principal", notification_id: uuid.UUID
) -> Notification:
    row = await db.get(Notification, notification_id)
    # Another user's notification is not found, not forbidden.
    if (
        row is None
        or principal.user_id is None
        or row.user_id != principal.user_id
        or row.document_id in await visibility.hidden_document_ids(db, [row.document_id])
    ):
        raise CollabError("not_found", f"Notification {notification_id} not found")
    if row.read_at is None:
        row.read_at = now()
        await db.flush()
    return row


async def mark_all_read(db: AsyncSession, principal: "Principal") -> int:
    if principal.user_id is None:
        return 0
    result = await db.execute(
        update(Notification)
        .where(Notification.user_id == principal.user_id, Notification.read_at.is_(None))
        .values(read_at=now())
    )
    return result.rowcount or 0


# --- assignments ----------------------------------------------------------------------


def assignment_out(row: SectionReviewState) -> SectionAssignmentOut:
    return SectionAssignmentOut(
        document_id=row.document_id,
        section_key=row.section_key,
        owner_id=row.owner_id,
        reviewer_ids=list(row.reviewer_ids),
        due_at=row.due_at,
        overdue=row.due_at is not None and row.due_at < now(),
        lock_version=row.lock_version,
        updated_at=row.updated_at,
    )


async def _members(db: AsyncSession, ids: list[uuid.UUID], what: str, min_role: str) -> None:
    if not ids:
        return
    users = {u.id: u for u in await db.scalars(select(User).where(User.id.in_(ids)))}
    for uid in ids:
        user = users.get(uid)
        if user is None:
            raise CollabError("invalid", f"{what}: user {uid} is not a member of this company")
        if user.disabled_at is not None:
            raise CollabError("invalid", f"{what}: user {uid} was removed from this company")
        if not has_role(user.role, min_role):  # type: ignore[arg-type]
            raise CollabError("invalid", f"{what}: user {uid} needs at least the {min_role} role")


async def latest_version(db: AsyncSession, document_id: uuid.UUID) -> DocumentVersion | None:
    return await db.scalar(
        select(DocumentVersion)
        .where(DocumentVersion.document_id == document_id)
        .order_by(DocumentVersion.number.desc())
        .limit(1)
    )


async def set_assignment(
    db: AsyncSession,
    principal: "Principal",
    document: Document,
    key: str,
    body: SectionAssignmentIn,
) -> SectionAssignmentOut:
    latest = await latest_version(db, document.id)
    exists = latest is not None and await db.scalar(
        select(Section.id).where(Section.version_id == latest.id, Section.section_key == key)
    )
    if not exists:
        raise CollabError("not_found", f"Section {key!r} is not in the latest version")
    reviewers = list(dict.fromkeys(body.reviewer_ids))
    await _members(db, [body.owner_id] if body.owner_id else [], "owner_id", "commenter")
    await _members(db, reviewers, "reviewer_ids", "commenter")
    row = await db.scalar(
        select(SectionReviewState)
        .where(SectionReviewState.document_id == document.id, SectionReviewState.section_key == key)
        .with_for_update()
    )
    # Optimistic concurrency: a section with no state row takes lock_version null, one
    # with a row its current lock_version (GET .../section-states shows it).
    if row is None:
        if body.lock_version is not None:
            raise VersionConflict(None)
        row = SectionReviewState(
            document_id=document.id, section_key=key, reviewer_ids=[], invalidated_review_ids=[]
        )
    elif body.lock_version is None:
        raise VersionConflict(row.lock_version)
    else:
        expect_version(row, body.lock_version)
    before_people = {row.owner_id, *row.reviewer_ids}
    before = {
        "owner_id": str(row.owner_id) if row.owner_id else None,
        "reviewer_ids": [str(r) for r in row.reviewer_ids],
        "due_at": row.due_at.isoformat() if row.due_at else None,
    }
    row.owner_id = body.owner_id
    row.reviewer_ids = reviewers
    row.due_at = body.due_at
    if row.id is None:
        try:
            async with db.begin_nested():
                db.add(row)
                await db.flush()
        except IntegrityError as e:
            # Another writer created the section's row first.
            raise VersionConflict(None) from e
    await flush_or_conflict(db)
    await db.refresh(row)
    after = {
        "owner_id": str(row.owner_id) if row.owner_id else None,
        "reviewer_ids": [str(r) for r in row.reviewer_ids],
        "due_at": row.due_at.isoformat() if row.due_at else None,
    }
    await audit.record(
        db,
        principal,
        "section_assignment.update",
        "document",
        document.id,
        {"section_key": key, "before": before, "after": after},
    )
    newcomers = [p for p in [row.owner_id, *row.reviewer_ids] if p not in before_people]
    due = f", due {row.due_at:%Y-%m-%d}" if row.due_at else ""
    await notify(
        db,
        newcomers,
        kind="assignment",
        title=f"You were asked to review {key} in {document.title}{due}",
        actor=principal.actor,
        document_id=document.id,
        version_number=latest.number if latest else None,
        section_key=key,
        data={"owner": row.owner_id in newcomers},
    )
    return assignment_out(row)


async def list_assignments(db: AsyncSession, document: Document) -> list[SectionAssignmentOut]:
    rows = await db.scalars(
        select(SectionReviewState)
        .where(SectionReviewState.document_id == document.id)
        .order_by(SectionReviewState.section_key)
    )
    return [assignment_out(r) for r in rows if r.owner_id or r.reviewer_ids or r.due_at is not None]


async def review_queue(db: AsyncSession, principal: "Principal") -> list[ReviewQueueItem]:
    """Sections the caller owns or reviews, in the latest version of each document."""
    if principal.user_id is None:
        return []
    me = principal.user_id
    rows = list(
        await db.scalars(
            select(SectionReviewState).where(
                (SectionReviewState.owner_id == me)
                | (literal(me, Uuid) == any_(SectionReviewState.reviewer_ids))
            )
        )
    )
    out: list[ReviewQueueItem] = []
    at = now()
    for row in rows:
        document = await db.get(Document, row.document_id)
        latest = await latest_version(db, row.document_id)
        if document is None or latest is None:
            continue
        section = await db.scalar(
            select(Section).where(
                Section.version_id == latest.id, Section.section_key == row.section_key
            )
        )
        if section is None:
            continue
        hist, _ = await counting_history(db, document.id, key=row.section_key)
        current = await review_revisions(
            db, document.id, latest.id, {row.section_key: section.revision}
        )
        st = section_status(
            hist.by_key.get(row.section_key, []),
            current[row.section_key],
            set(row.invalidated_review_ids),
        )
        out.append(
            ReviewQueueItem(
                document_id=document.id,
                slug=document.slug,
                title=document.title,
                version=latest.number,
                section_key=row.section_key,
                heading=section.heading,
                role="owner" if row.owner_id == me else "reviewer",
                status=st.status,  # type: ignore[arg-type]
                rereview_requested=row.rereview_requested_at is not None
                and st.status != "approved",
                due_at=row.due_at,
                overdue=row.due_at is not None and st.status != "approved" and row.due_at < at,
            )
        )
    out.sort(key=lambda i: (i.due_at is None, i.due_at or at, i.slug, i.section_key))
    return out


# --- campaigns ------------------------------------------------------------------------


async def campaign_out(db: AsyncSession, row: ReviewCampaign) -> CampaignOut:
    version = await db.scalar(
        select(DocumentVersion).where(
            DocumentVersion.document_id == row.document_id,
            DocumentVersion.number == row.version_number,
        )
    )
    comments = participants = 0
    if version is not None:
        window = [Comment.version_id == version.id, Comment.created_at >= row.created_at]
        if row.closed_at is not None:
            window.append(Comment.created_at <= row.closed_at)
        comments = await db.scalar(select(func.count(Comment.id)).where(*window)) or 0
        participants = (
            await db.scalar(select(func.count(distinct(Comment.author_id))).where(*window)) or 0
        )
    open_crs = (
        await db.scalar(
            select(func.count(FeedbackItem.id)).where(
                FeedbackItem.document_id == row.document_id,
                FeedbackItem.status == "open",
                FeedbackItem.raised_on_version == row.version_number,
            )
        )
        or 0
    )
    invited = (
        await db.scalar(
            select(func.count(User.id)).where(
                User.role.in_(row.audience_roles), User.disabled_at.is_(None)
            )
        )
        or 0
    )
    out = CampaignOut.model_validate(row)
    out.invited, out.comments, out.participants = invited, comments, participants
    out.open_change_requests = open_crs
    return out


async def create_campaign(
    db: AsyncSession, principal: "Principal", document: Document, body: CampaignCreate
) -> CampaignOut:
    latest = await latest_version(db, document.id)
    if latest is None:
        raise CollabError("invalid", "The document has no version to comment on")
    number = body.version or latest.number
    if number > latest.number:
        raise CollabError("not_found", f"Version {number} of {document.slug!r} not found")
    roles = list(dict.fromkeys(body.audience_roles))
    row = ReviewCampaign(
        document_id=document.id,
        version_number=number,
        title=body.title,
        message=body.message,
        due_at=body.due_at,
        audience_roles=roles,
        status="open",
        created_by=principal.id,
    )
    db.add(row)
    await db.flush()
    # Members with those roles; a removed (disabled) member is not invited.
    invitees = list(
        await db.scalars(select(User.id).where(User.role.in_(roles), User.disabled_at.is_(None)))
    )
    sent = await notify(
        db,
        invitees,
        kind="campaign",
        title=f"Feedback wanted on {document.title} v{number}: {body.title}",
        actor=principal.actor,
        document_id=document.id,
        version_number=number,
        campaign_id=row.id,
        data={"due_at": body.due_at.isoformat() if body.due_at else None},
    )
    await audit.record(
        db,
        principal,
        "review_campaign.create",
        "review_campaign",
        row.id,
        {"document_id": str(document.id), "version": number, "roles": roles, "notified": sent},
    )
    await db.refresh(row)
    return await campaign_out(db, row)


async def list_campaigns(db: AsyncSession, document: Document) -> list[CampaignOut]:
    rows = await db.scalars(
        select(ReviewCampaign)
        .where(ReviewCampaign.document_id == document.id)
        .order_by(ReviewCampaign.created_at.desc())
    )
    return [await campaign_out(db, r) for r in rows]


async def get_campaign(db: AsyncSession, campaign_id: uuid.UUID) -> ReviewCampaign:
    # Joined to its document: a campaign on a document the caller may not see is not
    # found (H8, oracle.docs.visibility).
    row = await db.scalar(
        select(ReviewCampaign)
        .join(Document, Document.id == ReviewCampaign.document_id)
        .where(ReviewCampaign.id == campaign_id)
    )
    if row is None:
        raise CollabError("not_found", f"Campaign {campaign_id} not found")
    return row


async def update_campaign(
    db: AsyncSession, principal: "Principal", campaign_id: uuid.UUID, status: str, lock: int
) -> CampaignOut:
    row = await get_campaign(db, campaign_id)
    expect_version(row, lock)
    if row.status != status:
        row.status = status
        if status == "closed":
            row.closed_at, row.closed_by = now(), principal.id
        else:
            row.closed_at = row.closed_by = None
        await flush_or_conflict(db)
        await audit.record(
            db, principal, f"review_campaign.{status}", "review_campaign", row.id, {}
        )
    await db.refresh(row)
    return await campaign_out(db, row)
