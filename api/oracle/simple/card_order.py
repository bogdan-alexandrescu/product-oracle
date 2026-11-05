"""chat-latest-card (the owner, Nov 4): in a chat, only the latest card is actionable.

Once a card in a chat is applied or declined (acted on: anything but open), every earlier
card in that chat is replaced; among the open cards, only the newest card per topic is
actionable. A topic is the record the card changes: its item, else the record its target
names (a question, a line, an API action's record). A card that makes a new record (a note, an
open question, a decision, a suggestion, a feature ask, a new item) is its own topic: the
meeting, page or goal it is made in is where, not what. Only a draft offered again in other
words (same op and place, an open earlier card, most of its words the same) replaces it.
Cards on one reply are offered together (Apply all), so they never replace one another;
"earlier" is an earlier reply.

Read, never stored: the chat's cards in order say it, so it holds after a reload.
"""

from __future__ import annotations

import json
import re
import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.discussions.models import Discussion, DiscussionMessage
from oracle.simple.models import SimpleChatCard

REPLACED = "This card was replaced by a newer card in the chat: use the newest one"
# Ids a card's target gains when applied, or that only say where it was asked.
_NOT_TOPIC = ("note_id", "suggestion_id", "meeting_id", "dependency_id", "decider_id")
# Cards that make a new record when applied (with no item yet): each its own topic.
NEW_OPS = ("minutes_note", "open_question", "record_decision", "suggest_feature",
           "add_feature_ask", "add_item")  # fmt: skip
# Words a reworded draft may drop or add without saying something else.
_SMALL = frozenset(
    "a an the and or of to for in on at by with is are was be we it this that our".split()
)
# A reworded draft: at least half of the two drafts' words (the small ones aside) shared.
REWORDED = 0.5


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
    """What the card changes: one key per item or other record (a new record: its own)."""
    if card.item_id is not None:
        return str(card.item_id)
    target = card.target or {}
    if card.op in NEW_OPS:
        return f"new:{card.id}"
    if card.op == "api_action":
        return _api_topic(target)
    for k, v in target.items():
        if k.endswith("_id") and k not in _NOT_TOPIC and v:
            return str(v)
    rest = {k: v for k, v in target.items() if k not in ("note_id", "suggestion_id")}
    return f"{card.op}:{json.dumps(rest, sort_keys=True, default=str)}"


def _draft(card: SimpleChatCard) -> tuple[str, str, frozenset[str]] | None:
    """A new record's draft: its op, where it is made, and its words; else None."""
    if card.item_id is not None or card.op not in NEW_OPS:
        return None
    target, after = card.target or {}, card.after or {}
    where = {k: v for k, v in target.items()
             if k.endswith("_id") and k not in ("note_id", "suggestion_id", "item_id")}  # fmt: skip
    text = next((str(v) for v in (after.get("text"), after.get("outcome"), after.get("title"),
                                  target.get("title")) if v), "")  # fmt: skip
    words = frozenset(w for w in re.findall(r"[a-z0-9]+", text.casefold()) if w not in _SMALL)
    return card.op, json.dumps(where, sort_keys=True, default=str), words


def _reworded(a: frozenset[str], b: frozenset[str]) -> bool:
    if not a or not b:
        return a == b
    return len(a & b) / len(a | b) >= REWORDED


def topics(cards: list[SimpleChatCard]) -> list[str]:
    """Each card's topic, the chat's cards oldest first: a new record's draft offered again
    in other words takes the topic of the newest earlier open draft it rewords."""
    keys: list[str] = []
    drafts = [_draft(c) for c in cards]
    for i, c in enumerate(cards):
        key, mine = topic(c), drafts[i]
        if mine is not None:
            for j in range(i - 1, -1, -1):
                d = drafts[j]
                if (d is not None and cards[j].status == "open" and d[:2] == mine[:2]
                        and _reworded(d[2], mine[2])):  # fmt: skip
                    key = keys[j]
                    break
        keys.append(key)
    return keys


def replaced(cards: list[SimpleChatCard]) -> dict[uuid.UUID, uuid.UUID]:
    """One chat's cards, oldest first: each replaced card's id → the card that replaced it
    (the newest later card on its topic, else the newest later card acted on)."""
    out: dict[uuid.UUID, uuid.UUID] = {}
    keys = topics(cards)
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


async def replaced_in(
    db: AsyncSession, cards: list[SimpleChatCard], fresh: bool = False
) -> dict[uuid.UUID, uuid.UUID]:
    """``replaced`` for every chat these cards are in (a card off any chat: never).
    ``fresh``: the cards as stored now, not as this session read them before."""
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
                .execution_options(populate_existing=fresh)
            )
        )
        out.update(replaced(rows))
    return out


async def refuse_replaced(db: AsyncSession, card: SimpleChatCard) -> None:
    """409 (chat.ChatError) when a newer card in its chat replaced this open card. The chat is
    locked until the caller's transaction ends, so a newer card acted on at the same time
    is seen: of an older and a newer card applied at once, the older is refused."""
    from oracle.simple.chat import ChatError

    if card.status != "open" or card.discussion_id is None:
        return
    await db.execute(
        select(Discussion.id).where(Discussion.id == card.discussion_id).with_for_update()
    )
    if card.id in await replaced_in(db, [card], fresh=True):
        raise ChatError(409, REPLACED)
