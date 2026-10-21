"""Review and feedback logic. Lane 2 implements; Lane 1 calls the functions below.

Contract with Lane 1 (document import), in the import transaction:

    version = DocumentVersion(...)          # flushed, so version.id exists
    locked = await locked_section_keys(db, previous_version.id)  # before writing sections
    ...
    await apply_resolutions(db, document.id, version.id, resolutions)

Neither function commits; the caller owns the transaction.

Everything else here backs ``oracle.review.router``. Service functions flush but never
commit; the router commits once per request. Every mutation writes an audit event.
"""

import uuid
from collections.abc import Iterable, Sequence
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.authz import has_role
from oracle.docs.models import Document, DocumentVersion, Section
from oracle.jobs.schemas import SuggestionOut
from oracle.review import publish_gate
from oracle.review.models import FEEDBACK_STATUSES, Comment, FeedbackItem, SectionReview
from oracle.review.schemas import (
    CommentOut,
    FeedbackItemOut,
    FeedbackPackage,
    Resolution,
    ResolutionReport,
    TextQuoteSelector,
)

if TYPE_CHECKING:
    from oracle.auth.deps import Principal

VERDICT_LABELS = {"changes_requested": "Changes requested", "rejected": "Rejected"}


class UnknownFeedbackItemsError(ValueError):
    """Resolutions reference feedback ids that do not exist on this document.

    Lane 1 turns this into a 422 (``code="unknown_feedback_item"``), one problem per id.
    """

    def __init__(self, feedback_ids: Sequence[uuid.UUID]):
        self.feedback_ids = list(feedback_ids)
        super().__init__(f"unknown feedback items: {', '.join(map(str, self.feedback_ids))}")


class ReviewError(Exception):
    """A request the review service refuses; the router maps ``kind`` to an HTTP status."""

    def __init__(self, kind: str, message: str, conflict: dict | None = None):
        self.kind = kind  # "not_found" | "invalid" | "forbidden" | "conflict"
        self.message = message
        # For "conflict": a ConflictResponse body (oracle.review.schemas).
        self.conflict = conflict
        super().__init__(message)


def _now() -> datetime:
    # Wall clock, not the transaction's now(): verdict order must hold even when two
    # verdicts land in one transaction.
    return datetime.now(UTC)


# --- Lookups -----------------------------------------------------------------------------


async def get_document(session: AsyncSession, doc: str) -> Document:
    """Document by slug or id."""
    cond = Document.slug == doc
    try:
        cond = or_(cond, Document.id == uuid.UUID(doc))
    except ValueError:
        pass
    document = await session.scalar(select(Document).where(cond))
    if document is None:
        raise ReviewError("not_found", f"Document {doc!r} not found")
    return document


async def get_version(session: AsyncSession, doc: str, n: int) -> DocumentVersion:
    document = await get_document(session, doc)
    version = await session.scalar(
        select(DocumentVersion).where(
            DocumentVersion.document_id == document.id, DocumentVersion.number == n
        )
    )
    if version is None:
        raise ReviewError("not_found", f"Version {n} of {document.slug!r} not found")
    return version


async def _get_section(session: AsyncSession, version: DocumentVersion, key: str) -> Section:
    section = await session.scalar(
        select(Section).where(Section.version_id == version.id, Section.section_key == key)
    )
    if section is None:
        raise ReviewError("invalid", f"Section {key!r} does not exist in version {version.number}")
    return section


async def _get_comment(session: AsyncSession, comment_id: uuid.UUID) -> Comment:
    comment = await session.get(Comment, comment_id)
    if comment is None:
        raise ReviewError("not_found", f"Comment {comment_id} not found")
    return comment


async def _comment_document(session: AsyncSession, comment: Comment) -> Document:
    version = await session.get(DocumentVersion, comment.version_id)
    return await session.get(Document, version.document_id)


async def _mark_in_review(session: AsyncSession, document: Document) -> None:
    if document.status == "draft":
        document.status = "in_review"


# --- Serialisation -----------------------------------------------------------------------


def _comment_out(
    comment: Comment,
    replies: Iterable[Comment] = (),
    feedback_item_id: uuid.UUID | None = None,
    layer: str | None = None,
) -> CommentOut:
    return CommentOut(
        id=comment.id,
        version_id=comment.version_id,
        section_key=comment.section_key,
        anchor=TextQuoteSelector(**comment.anchor) if comment.anchor else None,
        body=comment.body,
        author_id=comment.author_id,
        parent_id=comment.parent_id,
        resolved_at=comment.resolved_at,
        created_at=comment.created_at,
        replies=[_comment_out(r, layer=layer) for r in replies],
        feedback_item_id=feedback_item_id,
        layer=layer,
    )


async def section_layer(session: AsyncSession, version_id: uuid.UUID, key: str) -> str | None:
    return await session.scalar(
        select(Section.layer).where(Section.version_id == version_id, Section.section_key == key)
    )


async def feedback_out(
    session: AsyncSession, items: Sequence[FeedbackItem]
) -> list[FeedbackItemOut]:
    """Items with the anchor / verdict of their comment / section review copied in."""
    comment_ids = {i.comment_id for i in items if i.comment_id}
    review_ids = {i.section_review_id for i in items if i.section_review_id}
    anchors: dict[uuid.UUID, dict | None] = {}
    verdicts: dict[uuid.UUID, str] = {}
    if comment_ids:
        rows = await session.execute(
            select(Comment.id, Comment.anchor).where(Comment.id.in_(comment_ids))
        )
        anchors = {k: v for k, v in rows}
    if review_ids:
        rows = await session.execute(
            select(SectionReview.id, SectionReview.verdict).where(SectionReview.id.in_(review_ids))
        )
        verdicts = {k: v for k, v in rows}
    from oracle.jobs.service import latest_suggestions

    suggestions = await latest_suggestions(session, [i.id for i in items])
    latest = await latest_numbers(session, {i.document_id for i in items})
    out = []
    for item in items:
        anchor = anchors.get(item.comment_id) if item.comment_id else None
        suggestion = suggestions.get(item.id)
        state = feedback_state(item.status, suggestion)
        out.append(
            FeedbackItemOut(
                id=item.id,
                document_id=item.document_id,
                raised_on_version=item.raised_on_version,
                kind=item.kind,
                comment_id=item.comment_id,
                section_review_id=item.section_review_id,
                section_key=item.section_key,
                summary=item.summary,
                author_id=item.author_id,
                anchor=TextQuoteSelector(**anchor) if anchor else None,
                verdict=verdicts.get(item.section_review_id) if item.section_review_id else None,
                status=item.status,
                addressed_in_version=item.addressed_in_version,
                resolution_note=item.resolution_note,
                severity=item.severity,
                created_at=item.created_at,
                updated_at=item.updated_at,
                suggestion=SuggestionOut.model_validate(suggestion) if suggestion else None,
                state=state,
                staged_for_version=(latest.get(item.document_id) or 0) + 1
                if state == "staged"
                else None,
            )
        )
    return out


def is_staged(suggestion) -> bool:
    """C1e: an accepted section-text suggestion not applied in any draft yet."""
    return (
        suggestion is not None
        and suggestion.kind == "section_text"
        and suggestion.status == "accepted"
        and suggestion.applied_in_version is None
    )


def feedback_state(status: str, suggestion) -> str:
    """open / staged / declined / done, from the item's status and its live suggestion.

    Staged first (owner, 2026-10-20): an accepted change carries into the next draft until
    a draft applies it or someone discards it, whatever happened to its item since (closed
    by a draft's resolutions, an approval or by hand). The build action counts the same
    changes (``kinds.staged_suggestions``)."""
    if is_staged(suggestion):
        return "staged"
    if status == "declined":
        return "declined"
    if status != "open":
        return "done"
    if suggestion is not None and suggestion.status == "applied":
        return "done"
    return "open"


async def latest_numbers(
    session: AsyncSession, document_ids: Iterable[uuid.UUID]
) -> dict[uuid.UUID, int]:
    ids = set(document_ids)
    if not ids:
        return {}
    rows = await session.execute(
        select(DocumentVersion.document_id, func.max(DocumentVersion.number))
        .where(DocumentVersion.document_id.in_(ids))
        .group_by(DocumentVersion.document_id)
    )
    return dict(rows.all())


def _feedback_order():
    return (FeedbackItem.raised_on_version, FeedbackItem.created_at, FeedbackItem.id)


# --- Comments ----------------------------------------------------------------------------


async def create_comment(
    session: AsyncSession,
    principal: "Principal",
    doc: str,
    n: int,
    section_key: str,
    anchor: TextQuoteSelector,
    body: str,
    severity: str | None = None,
) -> CommentOut:
    """Top-level inline comment; also opens a ``comment`` feedback item (a change
    request of ``severity`` when given). The section's owner and reviewers are
    notified."""
    version = await get_version(session, doc, n)
    section = await _get_section(session, version, section_key)
    comment = Comment(
        version_id=version.id,
        section_key=section_key,
        anchor=anchor.model_dump(),
        body=body,
        author_id=principal.id,
        created_at=_now(),
    )
    session.add(comment)
    await session.flush()
    item = FeedbackItem(
        document_id=version.document_id,
        raised_on_version=version.number,
        kind="comment",
        comment_id=comment.id,
        section_key=section_key,
        summary=body,
        author_id=principal.id,
        status="open",
        severity=severity,
        created_at=comment.created_at,
    )
    session.add(item)
    await session.flush()
    document = await session.get(Document, version.document_id)
    await _mark_in_review(session, document)
    from oracle.review import collab

    await collab.on_comment(session, principal, document, version.number, comment)
    await audit.record(
        session,
        principal,
        "comment.create",
        "comment",
        comment.id,
        {"version": version.number, "section_key": section_key, "feedback_item_id": str(item.id)},
    )
    await audit.record(
        session,
        principal,
        "feedback.create",
        "feedback_item",
        item.id,
        {
            "kind": "comment",
            "comment_id": str(comment.id),
            "raised_on_version": version.number,
            **({"severity": severity} if severity else {}),
        },
    )
    return _comment_out(comment, feedback_item_id=item.id, layer=section.layer)


async def create_general_feedback(
    session: AsyncSession,
    principal: "Principal",
    doc: str,
    n: int,
    body: str,
    severity: str | None = None,
) -> FeedbackItemOut:
    """Feedback on the whole draft (D13): a ``general`` item with no section, raised on
    version ``n`` by ``principal``."""
    version = await get_version(session, doc, n)
    item = FeedbackItem(
        document_id=version.document_id,
        raised_on_version=version.number,
        kind="general",
        section_key=None,
        summary=body,
        author_id=principal.id,
        status="open",
        severity=severity,
        created_at=_now(),
    )
    session.add(item)
    await session.flush()
    await _mark_in_review(session, await session.get(Document, version.document_id))
    await audit.record(
        session,
        principal,
        "feedback.create",
        "feedback_item",
        item.id,
        {
            "kind": "general",
            "raised_on_version": version.number,
            **({"severity": severity} if severity else {}),
        },
    )
    await session.refresh(item)
    [out] = await feedback_out(session, [item])
    return out


async def list_comments(session: AsyncSession, doc: str, n: int) -> list[CommentOut]:
    """Top-level comments of a version, oldest first, with their replies nested."""
    version = await get_version(session, doc, n)
    comments = (
        await session.scalars(
            select(Comment)
            .where(Comment.version_id == version.id)
            .order_by(Comment.created_at, Comment.id)
        )
    ).all()
    top_ids = [c.id for c in comments if c.parent_id is None]
    items: dict[uuid.UUID, uuid.UUID] = {}
    if top_ids:
        rows = await session.execute(
            select(FeedbackItem.comment_id, FeedbackItem.id).where(
                FeedbackItem.comment_id.in_(top_ids)
            )
        )
        items = {k: v for k, v in rows}
    replies: dict[uuid.UUID, list[Comment]] = {}
    for c in comments:
        if c.parent_id is not None:
            replies.setdefault(c.parent_id, []).append(c)
    layers = dict(
        (
            await session.execute(
                select(Section.section_key, Section.layer).where(Section.version_id == version.id)
            )
        ).all()
    )
    return [
        _comment_out(c, replies.get(c.id, []), items.get(c.id), layers.get(c.section_key))
        for c in comments
        if c.parent_id is None
    ]


async def reply_to_comment(
    session: AsyncSession, principal: "Principal", comment_id: uuid.UUID, body: str
) -> CommentOut:
    """Reply in a thread. Replying to a reply attaches to the thread's top-level comment.

    Replies are discussion, not new feedback: they open no feedback item.
    """
    parent = await _get_comment(session, comment_id)
    if parent.parent_id is not None:
        parent = await _get_comment(session, parent.parent_id)
    reply = Comment(
        version_id=parent.version_id,
        section_key=parent.section_key,
        anchor=None,
        body=body,
        author_id=principal.id,
        parent_id=parent.id,
        created_at=_now(),
    )
    session.add(reply)
    await session.flush()
    await audit.record(
        session, principal, "comment.reply", "comment", reply.id, {"parent_id": str(parent.id)}
    )
    from oracle.review import collab

    version = await session.get(DocumentVersion, reply.version_id)
    document = await session.get(Document, version.document_id)
    await collab.on_comment(session, principal, document, version.number, reply, parent)
    return _comment_out(
        reply, layer=await section_layer(session, reply.version_id, reply.section_key)
    )


async def update_comment(
    session: AsyncSession,
    principal: "Principal",
    comment_id: uuid.UUID,
    resolved: bool | None,
    body: str | None,
) -> CommentOut:
    """Resolve / reopen a thread and/or edit a comment's text.

    Resolving a thread also closes its feedback item (``addressed``, no version), so the
    Inbox stops counting it; reopening the thread reopens an item closed that way. Editing
    the body of a top-level comment refreshes its item's summary while the item is open.

    Below the approver role a principal may only change its own comments.
    """
    comment = await _get_comment(session, comment_id)
    if comment.author_id != principal.id:
        refusal = None if has_role(principal.role, "approver") else "not an approver"
        if refusal is None:
            # Moderation: the role is read now, under the review gate (C2).
            from oracle.auth.service import caller_refusal
            from oracle.review import publish

            await publish.gate_lock(session, shared=True)
            refusal = await caller_refusal(session, principal, "approver")
        if refusal is not None:
            raise ReviewError("forbidden", "Only the author or an approver can change this comment")
    changes: dict[str, object] = {}
    if resolved is not None:
        if comment.parent_id is not None:
            raise ReviewError("invalid", "Replies cannot be resolved; resolve the thread")
        if resolved and comment.resolved_at is None:
            comment.resolved_at = _now()
            changes["resolved"] = True
            item = await session.scalar(
                select(FeedbackItem).where(FeedbackItem.comment_id == comment.id)
            )
            if item is not None and item.status == "open":
                item.status = "addressed"
        elif not resolved and comment.resolved_at is not None:
            comment.resolved_at = None
            changes["resolved"] = False
            item = await session.scalar(
                select(FeedbackItem).where(FeedbackItem.comment_id == comment.id)
            )
            if (
                item is not None
                and item.status == "addressed"
                and item.addressed_in_version is None
            ):
                item.status = "open"
    if body is not None and body != comment.body:
        comment.body = body
        changes["body"] = body
        if comment.parent_id is None:
            item = await session.scalar(
                select(FeedbackItem).where(FeedbackItem.comment_id == comment.id)
            )
            if item is not None and item.status == "open":
                item.summary = body
    await session.flush()
    item_id = None
    replies: list[Comment] = []
    if comment.parent_id is None:
        item_id = await session.scalar(
            select(FeedbackItem.id).where(FeedbackItem.comment_id == comment.id)
        )
        replies = list(
            (
                await session.scalars(
                    select(Comment)
                    .where(Comment.parent_id == comment.id)
                    .order_by(Comment.created_at, Comment.id)
                )
            ).all()
        )
    if changes:
        await audit.record(session, principal, "comment.update", "comment", comment.id, changes)
    layer = await section_layer(session, comment.version_id, comment.section_key)
    return _comment_out(comment, replies, item_id, layer)


# --- Section verdicts --------------------------------------------------------------------


async def _still_an_approver(session: AsyncSession, principal: "Principal") -> None:
    """Under the review gate (shared): the caller still is an approver now. A role
    change, a disable or a token or grant revocation takes the gate exclusively and
    lapses the approvals it ends; this re-read keeps one that raced with it from
    landing after."""
    from oracle.auth.service import caller_refusal
    from oracle.review.publish import gate_lock

    await gate_lock(session, shared=True)
    refusal = await caller_refusal(session, principal, "approver")
    if refusal is not None:
        if refusal.startswith("Your access"):
            refusal = "Requires the approver role"
        raise ReviewError("forbidden", refusal)


async def latest_verdicts(session: AsyncSession, version_id: uuid.UUID) -> dict[str, SectionReview]:
    """Latest verdict per section key in a version (Lane 1 can use it for VersionOut)."""
    reviews = (
        await session.scalars(
            select(SectionReview)
            .where(SectionReview.version_id == version_id)
            .order_by(SectionReview.created_at, SectionReview.id)
        )
    ).all()
    return {r.section_key: r for r in reviews}  # later rows overwrite earlier ones


async def review_section(
    session: AsyncSession,
    principal: "Principal",
    doc: str,
    n: int,
    section_key: str,
    verdict: str,
    note: str | None,
    revision: str | None = None,
    severity: str | None = None,
) -> tuple[SectionReview, FeedbackItem | None]:
    """Record a verdict (history is kept; the latest wins).

    Any still-open ``section_review`` item for the same section, raised on this or an
    earlier version, becomes ``superseded``. A non-approved verdict opens a new item.

    The verdict binds to the section's revision (its content hash). With ``revision``
    (what the reviewer read), a verdict whose revision is no longer the latest
    version's is a ``conflict``: an approval is never given on stale text. A verdict
    clears a pending re-review request on the section.
    """
    from oracle.review.publish import lock_document

    version = await get_version(session, doc, n)
    # The review gate, then the publish lock (publish's order): a verdict never commits
    # while a publish renders, nor lands after a role change that ended it.
    await _still_an_approver(session, principal)
    await lock_document(session, version.document_id)
    section = await _get_section(session, version, section_key)
    if revision is not None:
        await _check_revision(session, version, section, revision)
    from oracle.review.state import review_revisions

    bound = await review_revisions(
        session, version.document_id, version.id, {section_key: section.revision}
    )
    review = SectionReview(
        version_id=version.id,
        section_key=section_key,
        verdict=verdict,
        note=note,
        reviewer_id=principal.user_id or principal.id,
        # The token the verdict came through (C2: revoking it voids its approvals).
        token_id=principal.token_id,
        # And the MCP OAuth grant (revoking the grant voids them too).
        grant_id=principal.grant_id,
        # The review revision: the section's revision and its section links.
        section_hash=bound[section_key],
        created_at=_now(),
    )
    session.add(review)
    await session.flush()
    await audit.record(
        session,
        principal,
        "section_review.create",
        "section_review",
        review.id,
        {"version": version.number, "section_key": section_key, "verdict": verdict},
    )

    earlier = (
        await session.scalars(
            select(FeedbackItem).where(
                FeedbackItem.document_id == version.document_id,
                FeedbackItem.kind == "section_review",
                FeedbackItem.section_key == section_key,
                FeedbackItem.status == "open",
                FeedbackItem.raised_on_version <= version.number,
            )
        )
    ).all()
    for old in earlier:
        old.status = "superseded"
        old.resolution_note = (
            f"Superseded by a later '{verdict}' verdict on version {version.number}"
        )
        await audit.record(
            session,
            principal,
            "feedback.supersede",
            "feedback_item",
            old.id,
            {"by_section_review_id": str(review.id)},
        )

    item = None
    if verdict != "approved":
        label = VERDICT_LABELS[verdict]
        item = FeedbackItem(
            document_id=version.document_id,
            raised_on_version=version.number,
            kind="section_review",
            section_review_id=review.id,
            section_key=section_key,
            summary=f"{label}: {note}" if note else f"{label} (section {section_key})",
            author_id=review.reviewer_id,
            status="open",
            severity=severity,
            created_at=review.created_at,
        )
        session.add(item)
        await session.flush()
        await audit.record(
            session,
            principal,
            "feedback.create",
            "feedback_item",
            item.id,
            {
                "kind": "section_review",
                "section_review_id": str(review.id),
                "raised_on_version": version.number,
            },
        )
    from oracle.review.models import SectionReviewState

    state = await session.scalar(
        select(SectionReviewState).where(
            SectionReviewState.document_id == version.document_id,
            SectionReviewState.section_key == section_key,
        )
    )
    if state is not None and state.rereview_requested_at is not None:
        state.rereview_requested_at = None
    await _mark_in_review(session, await session.get(Document, version.document_id))
    await session.flush()
    return review, item


async def _check_revision(
    session: AsyncSession, version: DocumentVersion, section: Section, revision: str
) -> None:
    latest = await session.scalar(
        select(DocumentVersion)
        .where(DocumentVersion.document_id == version.document_id)
        .order_by(DocumentVersion.number.desc())
        .limit(1)
    )
    current = await session.scalar(
        select(Section).where(
            Section.version_id == latest.id, Section.section_key == section.section_key
        )
    )
    if revision == section.revision and current is not None and (current.revision == revision):
        return
    message = (
        f"section {section.section_key!r} changed: version {latest.number} has another "
        "revision; review the current text"
    )
    raise ReviewError(
        "conflict",
        message,
        {
            "detail": message,
            "code": "section_conflict",
            "base_version": version.number,
            "latest_version": latest.number,
            "sections": [
                {
                    "section_key": section.section_key,
                    "base_revision": revision,
                    "current_revision": current.revision if current else None,
                    "current_heading": current.heading if current else None,
                    "current_body_md": current.body_md if current else None,
                }
            ],
        },
    )


# --- Feedback ----------------------------------------------------------------------------


async def list_feedback(
    session: AsyncSession, doc: str, status: str | None = None, version: int | None = None
) -> list[FeedbackItemOut]:
    """Feedback items of a document; ``version`` filters on the version they were raised on."""
    document = await get_document(session, doc)
    stmt = select(FeedbackItem).where(FeedbackItem.document_id == document.id)
    if status is not None:
        stmt = stmt.where(FeedbackItem.status == status)
    if version is not None:
        stmt = stmt.where(FeedbackItem.raised_on_version == version)
    items = (await session.scalars(stmt.order_by(*_feedback_order()))).all()
    return await feedback_out(session, items)


async def update_feedback(
    session: AsyncSession,
    principal: "Principal",
    feedback_id: uuid.UUID,
    fields: dict[str, object],
) -> FeedbackItemOut:
    """Set status / resolution note / addressed_in_version (only the fields given).

    Reopening an item (``status=open``) clears ``addressed_in_version`` unless one is given.
    """
    item = await session.get(FeedbackItem, feedback_id)
    if item is None:
        raise ReviewError("not_found", f"Feedback item {feedback_id} not found")
    if fields.get("status") is None:
        fields.pop("status", None)
    number = fields.get("addressed_in_version")
    if number is not None:
        exists = await session.scalar(
            select(DocumentVersion.id).where(
                DocumentVersion.document_id == item.document_id, DocumentVersion.number == number
            )
        )
        if exists is None:
            raise ReviewError("invalid", f"Version {number} does not exist for this document")
    if fields.get("status") == "open" and "addressed_in_version" not in fields:
        fields["addressed_in_version"] = None
    before = {k: getattr(item, k) for k in fields}
    for key, value in fields.items():
        setattr(item, key, value)
    await session.flush()
    if fields:
        await audit.record(
            session,
            principal,
            "feedback.update",
            "feedback_item",
            item.id,
            {"before": before, "after": fields},
        )
    await session.refresh(item)
    return (await feedback_out(session, [item]))[0]


async def apply_resolutions(
    session: AsyncSession,
    document_id: uuid.UUID,
    version_id: uuid.UUID,
    resolutions: Sequence[Resolution],
    *,
    principal: "Principal | None" = None,
) -> list[FeedbackItem]:
    """Apply a draft's front-matter ``resolutions`` to the document's feedback items.

    For each resolution: set the item's ``status`` (addressed | declined),
    ``resolution_note`` and ``addressed_in_version`` (the NUMBER of ``version_id``).
    Validates all ids first and raises :class:`UnknownFeedbackItemsError` without
    changing anything if any is unknown for ``document_id``. Returns the updated items.
    The audit events name ``principal`` (whoever imported or saved the version).
    """
    if not resolutions:
        return []
    ids = list(dict.fromkeys(r.feedback_id for r in resolutions))
    found = {
        item.id: item
        for item in (
            await session.scalars(
                select(FeedbackItem).where(
                    FeedbackItem.document_id == document_id, FeedbackItem.id.in_(ids)
                )
            )
        ).all()
    }
    missing = [i for i in ids if i not in found]
    if missing:
        raise UnknownFeedbackItemsError(missing)
    version = await session.get(DocumentVersion, version_id)
    if version is None or version.document_id != document_id:
        raise ValueError(f"version {version_id} does not belong to document {document_id}")
    for res in resolutions:  # a repeated id: the last entry wins
        item = found[res.feedback_id]
        before = item.status
        item.status = res.status
        item.resolution_note = res.note
        item.addressed_in_version = version.number
        await audit.record(
            session,
            principal,
            "feedback.resolve",
            "feedback_item",
            item.id,
            {"from": before, "to": res.status, "version": version.number, "note": res.note},
        )
    await session.flush()
    return [found[i] for i in ids]


async def locked_section_keys(session: AsyncSession, version_id: uuid.UUID) -> set[str]:
    """Section keys whose LATEST verdict in ``version_id`` is ``approved``.

    Lane 1 compares these against the next draft to emit ``locked_section_changed``;
    the feedback package reports them as ``locked_section_keys``.
    """
    return {
        k
        for k, r in (await latest_verdicts(session, version_id)).items()
        if r.verdict == "approved" and r.lapsed_at is None
    }


async def feedback_package(session: AsyncSession, doc: str, n: int) -> FeedbackPackage:
    """Version markdown, every item still open (raised on this or an earlier version) and
    the locked (approved) section keys, in document order."""
    version = await get_version(session, doc, n)
    document = await session.get(Document, version.document_id)
    items = (
        await session.scalars(
            select(FeedbackItem)
            .where(
                FeedbackItem.document_id == document.id,
                FeedbackItem.status == "open",
                FeedbackItem.raised_on_version <= n,
            )
            .order_by(*_feedback_order())
        )
    ).all()
    locked = await locked_section_keys(session, version.id)
    ordered = (
        await session.scalars(
            select(Section.section_key)
            .where(Section.version_id == version.id)
            .order_by(Section.ordinal)
        )
    ).all()
    # oracle.docs.service imports this module.
    from oracle.docs import service as docs_service

    return FeedbackPackage(
        document_id=document.id,
        slug=document.slug,
        title=document.title,
        version=version.number,
        # A spec version's markdown carries its state labels (E1), as everywhere it is served.
        markdown=await docs_service.spec_markdown(session, version),
        open_items=await feedback_out(session, items),
        locked_section_keys=[k for k in ordered if k in locked],
        generated_at=_now(),
    )


async def resolution_report(session: AsyncSession, doc: str, n: int) -> ResolutionReport:
    """Every item raised on a version before ``n`` with its current outcome."""
    version = await get_version(session, doc, n)
    items = (
        await session.scalars(
            select(FeedbackItem)
            .where(
                FeedbackItem.document_id == version.document_id,
                FeedbackItem.raised_on_version < n,
            )
            .order_by(*_feedback_order())
        )
    ).all()
    counts = dict.fromkeys(FEEDBACK_STATUSES, 0)
    for item in items:
        counts[item.status] += 1
    return ResolutionReport(
        document_id=version.document_id,
        version=n,
        items=await feedback_out(session, items),
        counts=counts,
    )


# --- Approval ----------------------------------------------------------------------------


def readiness_summary(report: Any) -> str | None:
    """One line of a passing readiness report, for the decision log (H1)."""
    if report is None or not getattr(report, "results", None):
        return None
    counts: dict[str, int] = {}
    for r in report.results:
        counts[r.status] = counts.get(r.status, 0) + 1
    order = (("pass", "passed"), ("warning", "warned"), ("critical", "critical"))
    parts = [f"{counts[k]} {word}" for k, word in order if counts.get(k)]
    return "Readiness at approval: " + (", ".join(parts) or "no checks applied")


async def approve_version(
    session: AsyncSession, principal: "Principal", doc: str, n: int
) -> tuple[Document, DocumentVersion]:
    """Stamp the version's ``approved_at`` and ``approved_by`` (a re-approval by someone
    else updates both; the same approver's keeps them); document -> approved.

    The final approval is the designated decider's when the review policy names one
    (others review and give section verdicts), and it is of the current version only:
    approving a version a newer one replaced is a ``conflict``. A PRD passes the publish
    gate first (raises ``publish_gate.PublishBlocked``).
    """
    from oracle.review.publish import lock_document
    from oracle.review.state import effective_policy

    version = await get_version(session, doc, n)
    # The review gate, then the publish lock (publish's order): an approval never
    # commits while a publish renders, nor lands after a role change that ended it.
    await _still_an_approver(session, principal)
    document = await lock_document(session, version.document_id)
    await session.refresh(version)
    policy = await effective_policy(session, document)
    # The person behind the call: an API token acting for a user is that user.
    who = principal.user_id or principal.id
    if policy.decider_id is not None and who != policy.decider_id:
        raise ReviewError(
            "forbidden", "Only the designated decider approves this document's versions"
        )
    # A PRD: the publish gate (only the latest version, then readiness), in its words.
    gate = await publish_gate.check(session, document, version)
    latest = await session.scalar(
        select(DocumentVersion.number)
        .where(DocumentVersion.document_id == document.id)
        .order_by(DocumentVersion.number.desc())
        .limit(1)
    )
    if version.approved_at is None and latest != version.number:
        raise ReviewError(
            "conflict",
            f"version {version.number} is not the current version (version {latest} is); "
            "approve the current version",
        )
    already = version.approved_at is not None
    previous_approver = version.approved_by
    # A re-approval by someone else (the decider set after an earlier approval) is the
    # approval that counts: it records them and when; the same approver's is a no-op.
    if not already or previous_approver != who:
        version.approved_at = _now()
        version.approved_by = who
        version.approved_token_id = principal.token_id
        version.approved_grant_id = principal.grant_id
        # A new approval; a lapsed one stays in the audit log, never counts again.
        version.approval_lapsed_at = None
        version.approval_lapsed_by = None
        version.approval_lapse_reason = None
    previous_status = document.status
    document.status = "approved"
    await session.flush()
    await audit.record(
        session,
        principal,
        "version.approve",
        "document_version",
        version.id,
        {
            "document_id": str(document.id),
            "version": version.number,
            "previous_status": previous_status,
            "already_approved": already,
            **(
                {"previous_approved_by": str(previous_approver)}
                if already and previous_approver
                else {}
            ),
        },
    )
    if not already:
        # H1: the first approval of a version is a decision ("Publish <document> v<n>").
        from oracle.decisions import capture

        await capture.version_approved(
            session, principal, document, version, readiness_summary(gate)
        )
    if document.kind == "prd":
        # V2b, T2: approving a PRD version publishes it; a published PRD starts (or
        # advances) its product track.
        from oracle.roadmap import tracks

        await tracks.ensure_track(session, document, version, actor=principal, cause="approved")
    return document, version
