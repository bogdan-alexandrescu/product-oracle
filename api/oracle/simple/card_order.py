"""chat-latest-card (the owner, Nov 4): in a chat, only the latest card is actionable.

Once a card in a chat is applied or declined (acted on: anything but open), every earlier
card in that chat is replaced; among the open cards, only the newest card per topic is
actionable. A topic is the record the card changes: its item, else the record its target
names (a question, a line, an API action's record). A card that makes a new record (a note, an
open question, a decision, a suggestion, a feature ask, a new item) is its own topic: the
meeting, page or goal it is made in is where, not what, and two drafts sharing most words
("we launch billing in March" / "... in April") are two records. Only a card its builder
marks a redo of an earlier open draft (``redo_of``: the person asked to change that draft,
"make it April instead", "no, ...") takes that draft's topic and so replaces it.
Cards on one reply are offered together (Apply all), so they never replace one another;
"earlier" is an earlier reply.

Read, never stored (but ``redo_of``): the chat's cards in order say it, so it holds after a
reload.
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
# The person's line answering the previous card to change it: "no, ...", "instead, ..."
# (what follows is the change itself), or a short change request ending "instead" with no
# record prefix ("make it April instead", "April instead"), read in the person's own words.
# _REDO and _INSTEAD (its record prefixes: note|decided|decision|open|question|suggest|add|idea)
# are copied by hand as REDO and INSTEAD in web/lib/api/mock/simple-chat.ts: change both together.
_REDO = re.compile(r"^(?:no|nope|rather|instead)\b[,:;.!]?\s+(.+)$", re.I)
_INSTEAD = re.compile(
    r"^(?!(?:note|decided|decision|open|question|suggest|add|idea)\b)"
    r"(?:[^\s:]+\s+){0,4}[^\s:]+,?\s+instead[.!]?$",
    re.I,
)


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


def redo_line(line: str) -> str | None:
    """The change a line asks for when it answers the previous card to change it ("no,
    note: ...": what follows; "make it April instead": the line itself), else None. A
    longer line or one with a record prefix ("note: we use Redis instead") is no redo."""
    line = " ".join(line.split())
    m = _REDO.match(line)
    if m:
        return m[1]
    return line if _INSTEAD.match(line) else None


async def redo_of(
    db: AsyncSession, answer: DiscussionMessage, card: dict[str, Any], named: Any,
    explicit: bool,
) -> uuid.UUID | None:  # fmt: skip
    """The earlier open draft a new record's card (the dict built for ``answer``) redoes:
    the one the reader named (``named``, an open draft of the same op in this chat), else,
    when the person's line asks to change the previous card (``explicit``), the open draft
    of the same op on the reply right before (none if that reply has none). Else None: the
    card is its own topic."""
    if card.get("item_id") is not None or card.get("op") not in NEW_OPS:
        return None
    if named is None and not explicit:
        return None
    rows = list(
        await db.scalars(
            select(SimpleChatCard)
            .join(DiscussionMessage, DiscussionMessage.id == SimpleChatCard.message_id)
            .where(SimpleChatCard.discussion_id == answer.discussion_id,
                   SimpleChatCard.message_id != answer.id,
                   DiscussionMessage.created_at < answer.created_at)
            .order_by(DiscussionMessage.created_at, SimpleChatCard.created_at, SimpleChatCard.id)
        )
    )  # fmt: skip

    def draft(r: SimpleChatCard) -> bool:
        return r.status == "open" and r.op == card["op"] and r.item_id is None

    if named is not None:
        return next((r.id for r in rows if draft(r) and str(r.id) == str(named)), None)
    # The reply right before this one, cards or not ("no, ..." after a plain answer: new).
    before = await db.scalar(
        select(DiscussionMessage.id)
        .where(DiscussionMessage.discussion_id == answer.discussion_id,
               DiscussionMessage.author_kind == "oracle",
               DiscussionMessage.id != answer.id,
               DiscussionMessage.created_at < answer.created_at)
        .order_by(DiscussionMessage.created_at.desc())
        .limit(1)
    )  # fmt: skip
    same = [r for r in rows if r.message_id == before and draft(r)]
    return same[-1].id if same else None


def topics(cards: list[SimpleChatCard]) -> list[str]:
    """Each card's topic, the chat's cards oldest first: a redo of an earlier draft
    (``redo_of``) takes that draft's topic."""
    keys: list[str] = []
    at: dict[uuid.UUID, int] = {}
    for c in cards:
        key = topic(c)
        if c.redo_of is not None and c.redo_of in at:
            key = keys[at[c.redo_of]]
        at[c.id] = len(keys)
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
