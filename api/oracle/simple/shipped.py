"""item-chat-understands (owner, Nov 3): an item's talk understands "this already exists".

A line saying the item already runs, is shipped, is live or is partly done ("this is
already happening now in our other app's review section") is read into ``mark_shipped``:
a card "Mark as already shipped: <item>" whose evidence note is where it runs, in the
person's words, and, when they said they will keep improving it, a second card "Keep
improving it" (roadmap-talk's ``add_item``: a smaller improvement item in Next). An owner
applies the first: the item's ``shipped`` is set and it reads done (out of planned work);
Undo clears it. A line the reader reads no change in gets a short question with choices
drawn from what was said (``choices``), never "Say it another way" alone.
"""

import re
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, company_time
from oracle.authz import has_role
from oracle.roadmap.models import RoadmapItem
from oracle.simple import chat
from oracle.simple.models import SimpleChatCard

OP = "mark_shipped"
OWNERS_ONLY = "Only an owner marks an item as already shipped"
NOTE_MAX = 200
# A line that says the item already exists (read at once, no model call).
SAID = re.compile(
    r"\b(?:already (?:happening|shipped|live|out|built|done|running|in use|available|exists?|"
    r"there|have (?:it|this)|ha(?:s|ve) (?:it|this))|(?:is|it's|its|has been|was) "
    r"(?:shipped|live|launched|released)|(?:has|have|we) shipped|"
    r"(?:partly|partially) (?:done|shipped|built|live))\b",
    re.I,
)
# A line that may mean it (a choice to offer, not a card).
HINT = re.compile(
    r"\b(?:already|shipped|live|launched|released|exists?|in use|using|used|been out|"
    r"for a while|for months|for years|we have (?:it|this)|built)\b",
    re.I,
)
WHERE = re.compile(
    r"\b(?:in|on|inside|within|as part of) ((?:our|the|their|its|my|your) [^.,;!?]+?)"
    r"(?=[.,;!?]|$| and | but | so )",
    re.I,
)
IMPROVE = re.compile(r"\b(?:keep|continue|will|going to)\b[^.]*?\b(?:improv|iterat|polish|"
                     r"work on|grow)", re.I)  # fmt: skip


def where_of(text: str) -> str | None:
    m = WHERE.search(" ".join(text.split()))
    return m[1].strip()[:NOTE_MAX] if m else None


def phrase(c: Any, t: str) -> tuple[str, dict[str, Any]] | None:
    """In an item's talk, a line saying the item already exists: mark_shipped on it."""
    if c.item is None or not SAID.search(t):
        return None
    args: dict[str, Any] = {"item": str(c.item.row.id), "where": where_of(t)}
    if IMPROVE.search(t):
        args["improve"] = "yes"
    if args["where"] is None:
        args["said"] = t[:NOTE_MAX]
    return OP, args


def note_of(a: dict[str, Any]) -> str:
    where = chat._arg(a, "where")
    if where:
        where = re.sub(r"^(?:runs |it runs |in |on )+", "", chat._unquote(where), flags=re.I)
        return f"Runs in {where}"[:NOTE_MAX]
    said = chat._arg(a, "said")
    return f"Said in its talk: “{chat._unquote(said)}”"[:NOTE_MAX] if said else "Already shipped"


def build(c: Any, a: dict[str, Any]) -> chat.Built:
    from oracle.simple import roadmap_talk

    e = c.find(chat._need(a, "item"))
    if isinstance(e, chat.Reply):
        return e
    if e.row.cut:
        return chat.Reply("note", f"{e.row.title} is cut already.")
    if e.row.shipped:
        return chat.Reply("note", f"{e.row.title} is marked as shipped already.")
    note = note_of(a)
    after = {"shipped": {"note": note, "on": c.today.isoformat()}}
    card = chat._kw(f"Mark as already shipped: {e.row.title}", OP, e,
                    {"item_id": str(e.row.id)}, {"shipped": None}, after)  # fmt: skip
    if (chat._arg(a, "improve") or "").lower() not in ("yes", "true", "1"):
        return card
    title = f"Improve {e.row.title}"
    more = roadmap_talk.build_add_item(c, {"title": title})
    if isinstance(more, chat.Reply):
        return more
    more["summary"] = f"Keep improving it: add {title} to Next"
    return chat.Reply("cards", f"I understood: {e.row.title} already runs. {note}.", [card, more])


def bar(principal: Any, card: SimpleChatCard) -> str | None:
    return None if has_role(principal.role, "owner") else OWNERS_ONLY


async def apply(db: AsyncSession, principal: Any, card: SimpleChatCard) -> None:
    why = bar(principal, card)
    if why is not None:
        raise chat.ChatError(403, why)
    row = await db.get(RoadmapItem, card.item_id, with_for_update=True, populate_existing=True)
    if row is None:
        raise chat.ChatError(404, "No such roadmap item")
    if row.shipped:
        raise chat.ChatError(409, f"{row.title} is marked as shipped already")
    row.shipped = {**(card.after.get("shipped") or {}), "by": str(chat._me(principal)),
                   "on": company_time.today().isoformat()}  # fmt: skip
    await audit.record(db, principal, "simple_chat.item_shipped", "roadmap_item", row.id,
                       {"note": row.shipped.get("note"), "card_id": str(card.id)})  # fmt: skip


async def undo(db: AsyncSession, principal: Any, card: SimpleChatCard) -> None:
    row = await db.get(RoadmapItem, card.item_id, with_for_update=True, populate_existing=True)
    if row is None or not row.shipped:
        raise chat.ChatError(409, "This item is not marked as shipped now")
    row.shipped = None
    await audit.record(db, principal, "simple_chat.item_unshipped", "roadmap_item", row.id,
                       {"card_id": str(card.id)})  # fmt: skip


def choices(c: Any, line: str | None) -> chat.Reply | None:
    """In an item's talk, a line with no change read: a short question with choices drawn
    from what was said (each builds its card when picked), "Neither" last."""
    e = c.item
    if e is None or not line or not line.strip():
        return None
    words = " ".join(line.split())
    item = str(e.row.id)
    out: list[dict[str, Any]] = []
    if HINT.search(words) and not e.row.shipped and not e.row.cut:
        args = {"item": item, "where": where_of(words)} if where_of(words) else {
            "item": item, "said": words[:NOTE_MAX]}  # fmt: skip
        out.append({"label": "Mark it as already shipped?", "op": OP, "args": args})
    task = words[:120].rstrip(".")
    out.append({"label": "Add this as a task?", "op": "add_item_task",
                "args": {"item": item, "title": task}})  # fmt: skip
    if len(out) < 2:
        out.append({"label": "Add it as a feature ask?", "op": "add_feature_ask",
                    "args": {"title": task}})  # fmt: skip
    built = [ch for ch in out if chat.build(c, ch["op"], ch["args"]).kind == "cards"]
    if not built:
        return None
    return chat.Reply("question", "What should I do with that?", choices=[*built, chat.NEITHER])


ARGS = {"item": chat.ITEM, "where": "where it already runs, in their words (optional)",
        "said": "or their words, when they did not say where (optional)",
        "improve": "\"yes\" when they will keep improving it (optional)"}  # fmt: skip
DESCRIBE = (
    "Mark an item as already shipped: it already exists, runs, is live or is "
    "partly done (it leaves planned work)"
)
