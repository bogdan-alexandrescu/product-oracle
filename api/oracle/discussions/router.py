"""Discussions (G1): ``/v1/discussions``. Every role reads what it may see; commenters and
up start and write; who may add people, close or make a private discussion open is
checked per discussion (oracle.discussions.access). Every route is also an MCP tool with
the caller's role; run tokens never see them (``discussions`` is not a run-token area)."""

import uuid
from collections.abc import Awaitable
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import JSONResponse, StreamingResponse

from oracle.auth.deps import Principal, TenantDB, same_origin
from oracle.authz import require_role
from oracle.discussions import replies, service
from oracle.discussions.schemas import (
    ChangeStatus,
    DiscussionChangeOut,
    DiscussionCreate,
    DiscussionExposureConflict,
    DiscussionMessageEdit,
    DiscussionMessageIn,
    DiscussionMessageOut,
    DiscussionMessagePage,
    DiscussionMessagePosted,
    DiscussionOut,
    DiscussionPage,
    DiscussionParticipantOut,
    DiscussionParticipantsIn,
    DiscussionPatch,
    DiscussionReadIn,
    DiscussionShareIn,
    Origin,
    Status,
)

router = APIRouter(
    prefix="/v1", tags=["discussions"], dependencies=[Depends(require_role("viewer"))]
)
Viewer = Annotated[Principal, Depends(require_role("viewer"))]
Commenter = Annotated[Principal, Depends(require_role("commenter"))]

PRIVATE = {"description": "This discussion is private"}
GONE = {"description": "No such discussion (or not one the caller may know of)"}


async def _call[T](op: Awaitable[T]) -> T:
    try:
        return await op
    except service.DiscussionError as e:
        raise HTTPException(e.status, e.detail) from e


@router.post(
    "/discussions",
    response_model=DiscussionOut,
    status_code=status.HTTP_201_CREATED,
    responses={404: {"description": "The subject is not in this company"}},
)
async def create_discussion(
    body: DiscussionCreate, principal: Commenter, db: TenantDB
) -> DiscussionOut:
    """Start a discussion about one subject: open (everyone who can see the subject reads
    it) or private (only the people picked). ``title`` defaults to the subject's label;
    ``participants`` is the starter's pick for a private discussion and mentions on an
    open one; ``message`` is optional."""
    d = await _call(service.start(db, principal, body))
    await db.commit()
    await db.refresh(d)
    return await service.discussion_out(db, principal, d)


@router.get("/discussions", response_model=DiscussionPage)
async def list_discussions(
    principal: Viewer,
    db: TenantDB,
    subject_key: Annotated[str | None, Query(max_length=400)] = None,
    document_id: uuid.UUID | None = None,
    run_id: uuid.UUID | None = None,
    status_: Annotated[Status | None, Query(alias="status")] = None,
    mine: bool = False,
    origin: Origin | None = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
) -> DiscussionPage:
    """Discussions, latest activity first. A private discussion the caller is not in is
    listed only when the filter names its subject (``subject_key``, ``document_id`` or
    ``run_id``), as ``{id, visibility, hidden, summary}``: that it exists, and its summary
    when the starter shared it. ``mine``: the ones the caller is in."""
    items = await service.list_discussions(
        db, principal, subject_key=subject_key, document_id=document_id, run_id=run_id,
        status=status_, mine=mine, origin=origin, limit=limit,
    )  # fmt: skip
    return DiscussionPage(items=items)


@router.get(
    "/discussions/{discussion_id}",
    response_model=DiscussionOut,
    responses={403: PRIVATE, 404: GONE},
)
async def get_discussion(
    discussion_id: uuid.UUID, principal: Viewer, db: TenantDB
) -> DiscussionOut:
    """One discussion with its people. The starter of a private discussion also gets
    ``exposure``: what making it open would expose now."""
    d, _parts, _seat = await _call(service.readable(db, principal, discussion_id))
    return await service.discussion_out(db, principal, d)


@router.patch(
    "/discussions/{discussion_id}",
    response_model=DiscussionOut,
    responses={
        403: PRIVATE,
        404: GONE,
        409: {
            "model": DiscussionExposureConflict,
            "description": "Stale, closed, or counts to confirm",
        },
    },
)
async def update_discussion(
    discussion_id: uuid.UUID, body: DiscussionPatch, principal: Viewer, db: TenantDB
) -> Any:
    """Rename, make private or open, close or reopen, write the summary or share it. The
    starter changes title, visibility and summary; the starter or an approver closes and
    reopens. Making a private discussion open needs ``exposes``: the counts its warning
    showed; without them, or when they are no longer current, 409 "Confirm what this
    exposes" with the current ``messages`` and ``people``, and nothing changes."""
    try:
        d = await _call(service.update(db, principal, discussion_id, body))
    except service.ExposureMismatch as e:
        await db.rollback()
        conflict = DiscussionExposureConflict(detail=str(e), messages=e.messages, people=e.people)
        return JSONResponse(conflict.model_dump(), status.HTTP_409_CONFLICT)
    await db.commit()
    await db.refresh(d)
    return await service.discussion_out(db, principal, d)


@router.post(
    "/discussions/{discussion_id}/share",
    response_model=DiscussionOut,
    status_code=status.HTTP_201_CREATED,
    responses={
        403: {"description": "Not the panel chat's starter"},
        404: GONE,
        422: {"description": "Not a panel chat, or no first message"},
    },
)
async def share_discussion(
    discussion_id: uuid.UUID, body: DiscussionShareIn, principal: Commenter, db: TenantDB
) -> DiscussionOut:
    """Share as discussion (G7 head-of-product panel): a new open discussion on the panel
    chat's subject, ``origin: "discuss"``, whose first message is ``first_message`` (the
    chat's summary as its starter edited it); the chat's open changes are copied as
    ``suggested`` by the sharer. Only the chat's starter may; the chat stays private."""
    d = await _call(service.share(db, principal, discussion_id, body))
    await db.commit()
    await db.refresh(d)
    return await service.discussion_out(db, principal, d)


@router.get(
    "/discussions/{discussion_id}/messages",
    response_model=DiscussionMessagePage,
    responses={403: PRIVATE, 404: GONE},
)
async def list_discussion_messages(
    discussion_id: uuid.UUID,
    principal: Viewer,
    db: TenantDB,
    before: uuid.UUID | None = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> DiscussionMessagePage:
    """The thread, a page at a time, oldest first within the page; ``before``: the
    messages older than that one."""
    d, _parts, _seat = await _call(service.readable(db, principal, discussion_id))
    rows, more = await _call(service.list_messages(db, d, before, limit))
    return DiscussionMessagePage(
        items=await service.messages_out(db, rows, principal), has_more=more
    )


@router.post(
    "/discussions/{discussion_id}/messages",
    response_model=DiscussionMessagePosted,
    status_code=status.HTTP_201_CREATED,
    responses={
        403: PRIVATE,
        404: GONE,
        409: {"description": "This discussion is closed"},
        429: {"description": "Oracle has answered a lot here; the message is still stored"},
    },
)
async def create_discussion_message(
    discussion_id: uuid.UUID,
    body: DiscussionMessageIn,
    principal: Viewer,
    db: TenantDB,
    wait: bool = False,
) -> DiscussionMessagePosted:
    """Write in a discussion (commenters and up; in a private one, its people). Plain
    text with Markdown links, at most 8,000 characters. ``mentions`` (member ids from
    ``GET /v1/people``) add people to an open discussion; in a private one only the
    starter adds people.

    Oracle replies to every message while only one person is in the discussion, and
    after that when addressed (``@Oracle`` or ``mention_oracle``): ``reply`` is its
    ``pending`` reply, whose text streams from ``GET …/messages/{reply_id}/stream``.
    ``wait``: the reply runs here, without streaming, for at most 120 s, and comes back
    ``complete`` or ``failed``. 429 when Oracle has answered a lot here in a short time
    (the message is stored)."""
    message = await _call(service.post_message(db, principal, discussion_id, body))
    d = await service.get_discussion(db, discussion_id)
    reply = None
    if await replies.wants_reply(db, d, message):
        try:
            reply = await replies.ask(db, d, message)
        except replies.ReplyLimited as e:
            await db.commit()
            raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, str(e)) from e
    await db.commit()
    if reply is not None and wait:
        await replies.wait(principal.tenant_id, reply.id)
        await db.refresh(reply)
    [out, *rest] = await service.messages_out(db, [message, *([reply] if reply else [])], principal)
    return DiscussionMessagePosted(message=out, reply=rest[0] if rest else None)


@router.get(
    "/discussions/{discussion_id}/messages/{reply_id}/stream",
    operation_id="stream_discussion_reply",
    response_class=StreamingResponse,
    responses={
        200: {"content": {"text/event-stream": {}}, "description": "The reply's events"},
        403: PRIVATE,
        404: GONE,
    },
)
async def stream_discussion_reply(
    discussion_id: uuid.UUID, reply_id: uuid.UUID, principal: Viewer, db: TenantDB
) -> StreamingResponse:
    """Oracle's reply as it is written (``text/event-stream``): ``delta`` events with
    the new text, then ``citations`` and ``done`` (the message), or ``error``
    (``reason``, ``message``, ``retry``); ``: ping`` every 15 s. The first reader runs
    the reply; every other reader (another tab, another person, a reload) tails it."""
    d, _parts, _seat = await _call(service.readable(db, principal, discussion_id))
    row = await db.get(service.DiscussionMessage, reply_id)
    if row is None or row.discussion_id != d.id or row.author_kind != "oracle":
        raise HTTPException(404, "Reply not found")
    await db.commit()
    return StreamingResponse(
        replies.stream(principal.tenant_id, principal, discussion_id, reply_id),
        media_type="text/event-stream",
        # no-transform: Next's proxy (and any other) must not gzip, so buffer, the events.
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
    )


@router.post(
    "/discussions/{discussion_id}/messages/{reply_id}/cancel",
    response_model=DiscussionMessageOut,
    dependencies=[Depends(same_origin)],
    responses={403: PRIVATE, 404: GONE},
)
async def cancel_discussion_reply(
    discussion_id: uuid.UUID, reply_id: uuid.UUID, principal: Viewer, db: TenantDB
) -> DiscussionMessageOut:
    """Stop Oracle's reply (the person who asked, or an approver): it ends ``cancelled``
    with the text written so far, within a second."""
    reply = await _call(replies.cancel(db, principal, discussion_id, reply_id))
    await db.commit()
    [out] = await service.messages_out(db, [reply], principal)
    return out


@router.post(
    "/discussions/{discussion_id}/messages/{reply_id}/retry",
    response_model=DiscussionMessageOut,
    dependencies=[Depends(same_origin)],
    responses={
        403: PRIVATE,
        404: GONE,
        409: {"description": "Not failed or stopped"},
        429: {"description": "Oracle has answered a lot here in a short time"},
    },
)
async def retry_discussion_reply(
    discussion_id: uuid.UUID, reply_id: uuid.UUID, principal: Viewer, db: TenantDB
) -> DiscussionMessageOut:
    """Ask again for a failed or stopped reply (the person who asked, or an approver):
    it is ``pending`` again, with no text; open its stream to run it. 429 when Oracle
    has answered a lot here in a short time (each Retry counts as an answer)."""
    try:
        reply = await _call(replies.retry(db, principal, discussion_id, reply_id))
    except replies.ReplyLimited as e:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, str(e)) from e
    await db.commit()
    [out] = await service.messages_out(db, [reply], principal)
    return out


@router.patch(
    "/discussions/{discussion_id}/messages/{message_id}",
    response_model=DiscussionMessageOut,
    responses={403: PRIVATE, 404: GONE},
)
async def update_discussion_message(
    discussion_id: uuid.UUID,
    message_id: uuid.UUID,
    body: DiscussionMessageEdit,
    principal: Viewer,
    db: TenantDB,
) -> DiscussionMessageOut:
    """Edit your own message; it shows "edited". Oracle's messages cannot be edited."""
    message = await _call(service.edit_message(db, principal, discussion_id, message_id, body.body))
    await db.commit()
    [out] = await service.messages_out(db, [message])
    return out


@router.delete(
    "/discussions/{discussion_id}/messages/{message_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    responses={403: PRIVATE, 404: GONE},
)
async def delete_discussion_message(
    discussion_id: uuid.UUID, message_id: uuid.UUID, principal: Viewer, db: TenantDB
) -> None:
    """Delete your own message: it reads "Message deleted" and its text is gone."""
    await _call(service.delete_message(db, principal, discussion_id, message_id))
    await db.commit()


@router.post(
    "/discussions/{discussion_id}/participants",
    response_model=list[DiscussionParticipantOut],
    responses={403: PRIVATE, 404: GONE},
)
async def add_discussion_participants(
    discussion_id: uuid.UUID, body: DiscussionParticipantsIn, principal: Viewer, db: TenantDB
) -> list[DiscussionParticipantOut]:
    """Add people. On a private discussion only the starter may; on an open one any
    reader adds themselves (Follow) and commenters and up add others. Returns everyone
    in it."""
    people = await _call(service.add_participants(db, principal, discussion_id, body.user_ids))
    await db.commit()
    return people


@router.delete(
    "/discussions/{discussion_id}/participants/{user_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    responses={403: PRIVATE, 404: GONE},
)
async def remove_discussion_participant(
    discussion_id: uuid.UUID, user_id: uuid.UUID, principal: Viewer, db: TenantDB
) -> None:
    """Leave (or unfollow), or, the starter of a private discussion, remove someone."""
    await _call(service.remove_participant(db, principal, discussion_id, user_id))
    await db.commit()


@router.post(
    "/discussions/{discussion_id}/read",
    status_code=status.HTTP_204_NO_CONTENT,
    responses={403: PRIVATE, 404: GONE},
)
async def mark_discussion_read(
    discussion_id: uuid.UUID, body: DiscussionReadIn, principal: Viewer, db: TenantDB
) -> None:
    """Mark the thread read up to a message (what is unread for the caller)."""
    await _call(service.mark_read(db, principal, discussion_id, body.message_id))
    await db.commit()


@router.get(
    "/discussions/{discussion_id}/changes",
    response_model=list[DiscussionChangeOut],
    responses={403: PRIVATE, 404: GONE},
)
async def list_discussion_changes(
    discussion_id: uuid.UUID,
    principal: Viewer,
    db: TenantDB,
    status_: Annotated[ChangeStatus | None, Query(alias="status")] = None,
) -> list[DiscussionChangeOut]:
    """The typed changes the discussion ended in, read-only here (proposing, suggesting
    and staging arrive with G3 and G4)."""
    d, _parts, _seat = await _call(service.readable(db, principal, discussion_id))
    return await service.list_changes(db, d, status_)
