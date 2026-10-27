"""Simple S9 (#723, D22): change by chat (oracle.simple.chat). For people: a run's token is
refused (the ``simple`` area is in no run-token scope, oracle.mcp.scopes).

- ``GET /v1/simple/chat``: viewer and up; the caller's own Ask-panel thread.
- ``POST /v1/simple/chat/messages``: viewer and up; the line and Oracle's reply (cards,
  one question, an answer or a note). Nothing is written to the plan.
- ``GET|POST /v1/simple/meetings/{id}/chat[/messages]``: the meeting's attendees; 404
  without the meeting (S8).
- ``PUT /v1/simple/meetings/{id}/chat/mode``: the presenter: who may apply (D22a).
- ``POST /v1/simple/chat/cards/{id}/apply``: through the change engine with the caller's
  rights (applied or proposed); in a meeting, only those the change mode allows, and an
  applied card is a meeting decision. ``/discard``: nothing written. ``/undo``: its change.
- ``GET /v1/simple/walk``: Home's "Walk me through it".
"""

import uuid

from fastapi import APIRouter, HTTPException

from oracle.auth.deps import TenantDB
from oracle.simple import changes, chat, drafts
from oracle.simple.changes_router import CONFLICT, Commenter, Reader, _one_commit
from oracle.simple.schemas import (
    ChatApplyIn,
    ChatApplyOut,
    ChatCardOut,
    ChatIn,
    ChatModeIn,
    ChatRulesOut,
    ChatThreadOut,
    WalkOut,
)

router = APIRouter(prefix="/v1/simple", tags=["simple"])


async def _run(db, coro):
    try:
        return await coro
    except (chat.ChatError, changes.ChangeError, drafts.DraftError) as e:
        await db.rollback()
        raise HTTPException(e.status, e.detail) from e


@router.get("/chat", response_model=ChatThreadOut, name="get_simple_chat")
async def get_simple_chat(principal: Reader, db: TenantDB) -> ChatThreadOut:
    """The caller's Ask-panel thread: their requests, Oracle's replies and cards."""
    return await _run(db, chat.thread(db, principal))


@router.post("/chat/messages", response_model=ChatThreadOut, name="post_simple_chat")
async def post_simple_chat(body: ChatIn, principal: Reader, db: TenantDB) -> ChatThreadOut:
    """Ask Oracle in plain words; a change request gets change cards (nothing applies
    until Apply), an ambiguous one a question, a question about the plan an answer."""
    return await _run(db, chat.post(db, principal, body.text))


@router.get("/meetings/{meeting_id}/chat", response_model=ChatThreadOut,
            name="get_simple_meeting_chat")  # fmt: skip
async def get_simple_meeting_chat(
    meeting_id: uuid.UUID, principal: Reader, db: TenantDB
) -> ChatThreadOut:
    """The meeting's one shared thread and who may apply its cards."""
    return await _run(db, chat.thread(db, principal, meeting_id))


@router.post("/meetings/{meeting_id}/chat/messages", response_model=ChatThreadOut,
             name="post_simple_meeting_chat")  # fmt: skip
async def post_simple_meeting_chat(
    meeting_id: uuid.UUID, body: ChatIn, principal: Reader, db: TenantDB
) -> ChatThreadOut:
    """A line in the meeting's thread; a viewer's change request gets a note, no cards."""
    return await _run(db, chat.post(db, principal, body.text, meeting_id))


@router.put("/meetings/{meeting_id}/chat/mode", response_model=ChatRulesOut,
            name="set_simple_meeting_chat_mode")  # fmt: skip
async def set_simple_meeting_chat_mode(
    meeting_id: uuid.UUID, body: ChatModeIn, principal: Commenter, db: TenantDB
) -> ChatRulesOut:
    """The presenter sets who may apply: everyone, only the presenter, or the presenter
    and one or two named people."""
    return await _run(
        db, chat.set_mode(db, principal, meeting_id, body.change_mode, body.change_people)
    )


@router.post("/chat/cards/{card_id}/apply", response_model=ChatApplyOut,
             name="apply_simple_chat_card", responses=CONFLICT)  # fmt: skip
async def apply_simple_chat_card(
    card_id: uuid.UUID, principal: Commenter, db: TenantDB, body: ChatApplyIn | None = None
) -> ChatApplyOut:
    """Apply the card (or ``fix``: one of its fixes) through the change engine: applied
    for an owner or the decider, proposed for others; 403 with the reason when the
    meeting's change mode leaves the caller out. In a meeting the change and its meeting
    decision commit together (S8's one commit): a refusal or failure between them keeps
    neither."""
    async with _one_commit(db):
        card, result = await _run(
            db, chat.apply(db, principal, card_id, body.fix if body is not None else None)
        )
    return ChatApplyOut(card=card, result=result)


@router.post("/chat/cards/{card_id}/discard", response_model=ChatCardOut,
             name="discard_simple_chat_card")  # fmt: skip
async def discard_simple_chat_card(
    card_id: uuid.UUID, principal: Commenter, db: TenantDB
) -> ChatCardOut:
    """Discard the card: nothing is written."""
    return await _run(db, chat.discard(db, principal, card_id))


@router.post("/chat/cards/{card_id}/undo", response_model=ChatCardOut,
             name="undo_simple_chat_card")  # fmt: skip
async def undo_simple_chat_card(
    card_id: uuid.UUID, principal: Commenter, db: TenantDB
) -> ChatCardOut:
    """Undo the change an applied card made (its author, in its session)."""
    return await _run(db, chat.undo(db, principal, card_id))


@router.get("/walk", response_model=WalkOut, name="get_simple_walk")
async def get_simple_walk(principal: Reader, db: TenantDB) -> WalkOut:
    """Walk me through it: the broken links first, then the decisions on the next
    meeting's agenda, then the proposals waiting on the caller."""
    return await _run(db, chat.walk(db, principal))
