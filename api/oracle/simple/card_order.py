"""chat-latest-card (the owner, Nov 4): in a chat, only the latest card is actionable.

Once a card in a chat is applied or declined (acted on: anything but open), every earlier
card in that chat is replaced; among the open cards, only the newest card per topic is
actionable. A topic is what the card changes: its item, else the record its target names
(a goal, a document, a meeting, an API action's record). Cards on one reply are offered
together (Apply all), so they never replace one another; "earlier" is an earlier reply.

Read, never stored: the chat's cards in order say it, so it holds after a reload.
"""

from __future__ import annotations

import json
import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.discussions.models import DiscussionMessage
from oracle.simple.models import SimpleChatCard

REPLACED = "This card was replaced by a newer card in the chat: use the newest one"
# Ids a card's target gains when applied, or that only say where it was asked.
_NOT_TOPIC = ("note_id", "suggestion_id", "meeting_id", "dependency_id", "decider_id")


def _api_topic(target: dict[str, Any]) -> str:
    from oracle.simple import ask_actions

    args = target.get("args") or {}
    action = ask_actions.catalogue(ask_actions.the_app()).actions.get(str(target.get("action")))
    path = ask_actions._path_params(action.path) if action is not None else []
    ids = [str(args[p]) for p in path if args.get(p) is not None]
    # The record the route's path names (its last id); a create names none: its own topic.
    if ids:
        return ids[-1]
    return f"{target.get('action')}:{json.dumps(args, sort_keys=True, default=str)}"


def topic(card: SimpleChatCard) -> str:
    """What the card changes: one key per item or other target."""
    if card.item_id is not None:
        return str(card.item_id)
    target = card.target or {}
    if card.op == "api_action":
        return _api_topic(target)
    for k, v in target.items():
        if k.endswith("_id") and k not in _NOT_TOPIC and v:
            return str(v)
    rest = {k: v for k, v in target.items() if k not in ("note_id", "suggestion_id")}
    return f"{card.op}:{json.dumps(rest, sort_keys=True, default=str)}"


def replaced(cards: list[SimpleChatCard]) -> dict[uuid.UUID, uuid.UUID]:
    """One chat's cards, oldest first: each replaced card's id → the card that replaced it
    (the newest later card on its topic, else the newest later card acted on)."""
    out: dict[uuid.UUID, uuid.UUID] = {}
    keys = [topic(c) for c in cards]
    for i, c in enumerate(cards):
        later = [(d, keys[j]) for j, d in enumerate(cards[i + 1 :], i + 1)
                 if d.message_id is None or d.message_id != c.message_id]  # fmt: skip
        acted = [d for d, _ in later if d.status != "open"]
        same = [d for d, k in later if k == keys[i]]
        if c.status == "open":
            by = same[-1] if same else acted[-1] if acted else None
        else:
            # An acted-on card is replaced only by a newer card acted on (it keeps its Undo).
            mine = [d for d in acted if d in same]
            by = mine[-1] if mine else acted[-1] if acted else None
        if by is not None:
            out[c.id] = by.id
    return out


async def replaced_in(db: AsyncSession, cards: list[SimpleChatCard]) -> dict[uuid.UUID, uuid.UUID]:
    """``replaced`` for every chat these cards are in (a card off any chat: never)."""
    chats = {c.discussion_id for c in cards if c.discussion_id is not None}
    out: dict[uuid.UUID, uuid.UUID] = {}
    for chat_id in chats:
        # In the chat's order (its lines', as the thread shows them), then the reply's own.
        rows = list(
            await db.scalars(
                select(SimpleChatCard)
                .outerjoin(DiscussionMessage, DiscussionMessage.id == SimpleChatCard.message_id)
                .where(SimpleChatCard.discussion_id == chat_id)
                .order_by(
                    DiscussionMessage.created_at,
                    DiscussionMessage.id,
                    SimpleChatCard.created_at,
                    SimpleChatCard.id,
                )
            )
        )
        out.update(replaced(rows))
    return out


async def refuse_replaced(db: AsyncSession, card: SimpleChatCard) -> None:
    """409 (chat.ChatError) when a newer card in its chat replaced this open card."""
    from oracle.simple.chat import ChatError

    if card.status == "open" and card.id in await replaced_in(db, [card]):
        raise ChatError(409, REPLACED)
