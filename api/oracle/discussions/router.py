"""Discussions (G1): ``/v1/discussions``. Every role reads what it may see; commenters and
up start and write; who may add people, close or make a private discussion open is
checked per discussion (oracle.discussions.access). Every route is also an MCP tool with
the caller's role; run tokens never see them (``discussions`` is not a run-token area)."""

import contextlib
import uuid
from collections.abc import Awaitable
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import JSONResponse, StreamingResponse

from oracle.auth.deps import Principal, TenantDB, same_origin
from oracle.authz import require_role
from oracle.discussions import changes, kinds, replies, service, summary
from oracle.discussions.schemas import (
    ChangeActIn,
    ChangeDismissIn,
    ChangeEdit,
    ChangeIn,
    ChangeKindOut,
    ChangeResult,
    ChangeStageIn,
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
    DiscussionStarted,
    Origin,
    Status,
    SummaryAsk,
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
    response_model=DiscussionStarted,
    status_code=status.HTTP_201_CREATED,
    responses={404: {"description": "The subject is not in this company"}},
)
async def create_discussion(
    body: DiscussionCreate, principal: Commenter, db: TenantDB, wait: bool = False
) -> DiscussionStarted:
    """Start a discussion about one subject: open (everyone who can see the subject reads
    it) or private (only the people picked). ``title`` defaults to the subject's label;
    ``participants`` is the starter's pick for a private discussion and mentions on an
    open one; ``message`` is optional.

    Oracle replies to the first message as to any other (``POST …/messages``): while only
    the starter is in it, and after that when addressed. ``reply`` is its ``pending``
    reply; ``wait`` runs it here, as there. When Oracle has answered a lot in a short time
    the discussion still starts, without a reply."""
    d, first = await _call(service.start(db, principal, body))
    reply = None
    if first is not None and await replies.wants_reply(db, d, first):
        with contextlib.suppress(replies.ReplyLimited):
            reply = await replies.ask(db, d, first)
    await db.commit()
    if reply is not None and wait:
        await replies.wait(principal.tenant_id, reply.id)
        await db.refresh(reply)
    await db.refresh(d)
    out = await service.discussion_out(db, principal, d)
    [reply_out] = await service.messages_out(db, [reply], principal) if reply else [None]
    return DiscussionStarted(**out.model_dump(), reply=reply_out)


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
    """The typed changes the discussion ended in, each with the action the caller may take
    (``action``: the kind's verb, ``allowed`` and ``why_not``) and what else they may do
    (``can``). Viewers read them and get no action."""
    d, _parts, seat = await _call(service.readable(db, principal, discussion_id))
    return await changes.list_changes(db, principal, d, seat, status_)


@router.get(
    "/discussions/{discussion_id}/change-kinds",
    response_model=list[ChangeKindOut],
    responses={403: PRIVATE, 404: GONE},
)
async def list_discussion_change_kinds(
    discussion_id: uuid.UUID, principal: Viewer, db: TenantDB
) -> list[ChangeKindOut]:
    """The kinds "Propose a change" offers on this discussion's subject: only those
    available now, each with its action verb and its payload's JSON schema."""
    d, _parts, _seat = await _call(service.readable(db, principal, discussion_id))
    return [
        ChangeKindOut(kind=k, verb=kinds.REGISTRY[k].verb, schema=kinds.schema_of(k))  # type: ignore[arg-type]
        for k in kinds.available_for(d.subject_kind, db)
    ]


async def _result(
    db: TenantDB, principal: Principal, change_id: uuid.UUID, result: dict[str, Any] | None
) -> ChangeResult:
    await db.commit()
    row = await db.get(changes.DiscussionChange, change_id, populate_existing=True)
    assert row is not None
    d, _parts, seat = await _call(service.readable(db, principal, row.discussion_id))
    [out] = await changes.list_changes(db, principal, d, seat, ids=[row.id])
    return ChangeResult(change=out, result=result)


ACTS = {
    403: {"description": "Not this caller's to do (viewers read; approvers stage)"},
    404: GONE,
    409: {"description": "Stale lock_version, or already handled"},
    422: {"description": "The kind, rule 4 (share the finding first), or a reason is missing"},
}


@router.post(
    "/discussions/{discussion_id}/changes",
    response_model=ChangeResult,
    status_code=status.HTTP_201_CREATED,
    responses={403: PRIVATE, 404: GONE, 422: ACTS[422]},
)
async def create_discussion_change(
    discussion_id: uuid.UUID, body: ChangeIn, principal: Viewer, db: TenantDB
) -> ChangeResult:
    """Write a change by hand (commenters and up): a commenter's is ``suggested``, an
    approver's ``proposed``, ready to stage. Only the subject's available kinds; the
    payload is checked as Oracle's are."""
    row = await _call(
        changes.create(db, principal, discussion_id, body.kind, body.payload, body.rationale)
    )
    return await _result(db, principal, row.id, None)


@router.patch("/discussion-changes/{change_id}", response_model=ChangeResult, responses=ACTS)
async def update_discussion_change(
    change_id: uuid.UUID, body: ChangeEdit, principal: Viewer, db: TenantDB
) -> ChangeResult:
    """Edit before acting: saves ``edited_payload``. A commenter's edit makes it their
    suggestion; an approver's keeps the status."""
    _c, result = await _call(
        changes.edit(db, principal, change_id, body.payload, body.rationale, body.lock_version)
    )
    return await _result(db, principal, change_id, result)


@router.post("/discussion-changes/{change_id}/suggest", response_model=ChangeResult,
             responses=ACTS)  # fmt: skip
async def suggest_discussion_change(
    change_id: uuid.UUID, body: ChangeActIn, principal: Viewer, db: TenantDB
) -> ChangeResult:
    """Suggest it for an approver to stage (commenters and up): "Suggested by <name>". At
    a checkpoint it is also the item's suggested shared-draft action."""
    _c, result = await _call(changes.suggest(db, principal, change_id, body.lock_version))
    return await _result(db, principal, change_id, result)


@router.post("/discussion-changes/{change_id}/withdraw", response_model=ChangeResult,
             responses=ACTS)  # fmt: skip
async def withdraw_discussion_change(
    change_id: uuid.UUID, body: ChangeActIn, principal: Viewer, db: TenantDB
) -> ChangeResult:
    """Withdraw your own suggestion: back to ``proposed`` when Oracle proposed it, else
    ``dismissed``."""
    _c, result = await _call(changes.withdraw(db, principal, change_id, body.lock_version))
    return await _result(db, principal, change_id, result)


@router.post("/discussion-changes/{change_id}/stage", response_model=ChangeResult,
             responses=ACTS)  # fmt: skip
async def stage_discussion_change(
    change_id: uuid.UUID, body: ChangeStageIn, principal: Viewer, db: TenantDB
) -> ChangeResult:
    """Stage it (approvers and up): a shared-draft action at the checkpoint or a row for
    the document's next draft (G4). When Oracle pushed back on it, ``override_reason`` is
    required; from a private discussion, ``reason`` (the reason everyone will see) is."""
    _c, result = await _call(
        changes.stage(
            db, principal, change_id, body.lock_version, body.override_reason, body.reason
        )
    )
    return await _result(db, principal, change_id, result)


@router.post("/discussion-changes/{change_id}/dismiss", response_model=ChangeResult,
             responses=ACTS)  # fmt: skip
async def dismiss_discussion_change(
    change_id: uuid.UUID, body: ChangeDismissIn, principal: Viewer, db: TenantDB
) -> ChangeResult:
    """Dismiss it (approvers and up), with an optional note."""
    _c, result = await _call(
        changes.dismiss(db, principal, change_id, body.lock_version, body.note)
    )
    return await _result(db, principal, change_id, result)


@router.post("/discussion-changes/{change_id}/propose", response_model=ChangeResult,
             responses=ACTS)  # fmt: skip
async def propose_discussion_change(
    change_id: uuid.UUID, body: ChangeActIn, principal: Viewer, db: TenantDB
) -> ChangeResult:
    """``goal_measure`` and ``entity_edit`` (commenters and up): an open baseline proposal
    whose reason names the discussion; approvers accept it in Baseline."""
    _c, result = await _call(changes.propose(db, principal, change_id, body.lock_version))
    return await _result(db, principal, change_id, result)


@router.post("/discussion-changes/{change_id}/resolve", response_model=ChangeResult,
             responses=ACTS)  # fmt: skip
async def resolve_discussion_change(
    change_id: uuid.UUID, body: ChangeActIn, principal: Viewer, db: TenantDB
) -> ChangeResult:
    """``conflict_pick`` (approvers and up): resolves the conflict with the picked claim."""
    _c, result = await _call(changes.resolve(db, principal, change_id, body.lock_version))
    return await _result(db, principal, change_id, result)


@router.post("/discussion-changes/{change_id}/answer", response_model=ChangeResult,
             responses=ACTS)  # fmt: skip
async def answer_with_discussion_change(
    change_id: uuid.UUID, body: ChangeActIn, principal: Viewer, db: TenantDB
) -> ChangeResult:
    """``answer`` (the person asked, or approvers and up): posts it as the question's
    answer."""
    _c, result = await _call(changes.answer(db, principal, change_id, body.lock_version))
    return await _result(db, principal, change_id, result)


@router.post("/discussion-changes/{change_id}/verify", response_model=ChangeResult,
             responses=ACTS)  # fmt: skip
async def record_discussion_change(
    change_id: uuid.UUID, body: ChangeActIn, principal: Viewer, db: TenantDB
) -> ChangeResult:
    """``basis_record`` (Record): records the schedule basis with the caller's date rights
    (F3, ``leads.date_rights``): verified for an engineering lead or an owner, and for an
    approver while no lead is named; ``proposed`` for the lead when an approver records it
    while a lead is named. Anyone else gets 403."""
    _c, result = await _call(changes.record(db, principal, change_id, body.lock_version))
    return await _result(db, principal, change_id, result)


@router.post(
    "/discussions/{discussion_id}/summary",
    response_model=DiscussionOut,
    responses={403: PRIVATE, 404: GONE, 409: {"description": "The starter confirmed it"}},
)
async def summarize_discussion(
    discussion_id: uuid.UUID, body: SummaryAsk, principal: Viewer, db: TenantDB
) -> DiscussionOut:
    """Ask Oracle for a summary draft now (commenters and up who can write in it), at most
    1,200 characters: "Decided:", "Open:", "Context:". A summary the starter confirmed is
    replaced only when the starter asks (``replace``); anyone else gets 409."""
    d = await _call(summary.ask(db, principal, discussion_id, body.replace))
    await db.commit()
    await db.refresh(d)
    return await service.discussion_out(db, principal, d)
