"""Simple roadmap-talk (#723, the owner's pick C, 2026-10-28): talk to Oracle inside a
roadmap item's card, and conversational roadmap changes with Apply / Reject / Correct.

**The item's talk** is a person's Ask thread on the item's own page key
(``/simple/roadmap/items/<item id>``: one thread per item and person, "Just you and Oracle ·
kept with this item"). In it "it" / "this" is the item; a question goes to Oracle's reader
(the ``chat_reader`` job) with the item, its PRD section and its milestone as context, and
the answer says where it comes from ("From the PRD · F-06 Adaptive pacing"); a change is
restated in one line ("I understood: move …") above its card.

**Roadmap action cards** (the item's talk and the Ask panel on the roadmap page): the
reader may read a line into these actions besides chat's own (move_dates, set_owner,
edit_title, cut): ``move_to_milestone`` (the change engine's ``set_milestone`` with a
milestone the plan knows), ``move_after`` (``move_dates``: the day after another item
ends, keeping its length), ``add_item`` (S7's ``add_item`` with a title, a goal, a
milestone and dates) and ``split_item`` (a ``move_dates`` shrinking the item to its first
slice and one ``add_item`` per further slice). Each card is an engine op built through
ChatOp.build (the same lookups and checks), so the reader never makes a card the engine
would refuse; Apply goes through the change engine with the caller's rights (owners and
the decider apply, approvers and commenters propose); on the roadmap a viewer gets a note,
never a card.

**Correct** (``values`` on Apply): the card's fields (dates, milestone, title, goal,
owner), prefilled with Oracle's reading (``correct``), rebuild the card through the same
build before it applies: the corrected values win and the restatement matches them.
"""

import re
import uuid
from datetime import date, timedelta
from typing import Any

from sqlalchemy import select

from oracle.baseline.models import Entity
from oracle.members.names import display_name
from oracle.simple import chat, service
from oracle.simple.models import SimpleChatCard

ITEM_PAGE = re.compile(r"/simple/roadmap/items/([0-9a-f-]{36})")
ROADMAP_PAGE = "/simple/roadmap"
VIEWER_NOTE = "Viewers ask questions here; changes need a commenter or above."
IT = ("it", "this", "this item", "that", "that item", "this one")
WORDS = {1: "one", 2: "two", 3: "three", 4: "four"}
WORDS_IN = {v: k for k, v in WORDS.items()}
CORRECTABLE: dict[str, tuple[str, ...]] = {
    "move_dates": ("start_date", "end_date"),
    "set_milestone": ("milestone",),
    "edit_title": ("title",),
    "set_owner": ("owner",),
    "add_item": ("title", "goal", "milestone", "start_date", "end_date"),
    # A cut has nothing to correct; it is still a roadmap card (Reject, not Discard).
    "cut": (),
}
SLICES_MAX = 4


def item_of(page: str | None) -> uuid.UUID | None:
    """The item whose talk a page key is (None: not an item's talk)."""
    m = ITEM_PAGE.search(page or "")
    return uuid.UUID(m[1]) if m else None


def on_roadmap(page: str | None) -> bool:
    return chat.page_of(page).startswith(ROADMAP_PAGE)


async def load(c: Any) -> None:
    """The item of the talk, the codes of the items and the company's goals."""
    assert c.read is not None
    await service.item_codes(c.db, c.read.entries)
    c.talk_goals = list(
        await c.db.scalars(select(Entity).where(Entity.type == "goal").order_by(Entity.key))
    )
    iid = item_of(c.page)
    c.item = c.read.by_id().get(iid) if iid is not None else None


def label(e: service.Entry) -> str:
    """An item's name as people read it: its code with its title."""
    return f"{e.code} {e.row.title}" if getattr(e, "code", None) else e.row.title


def span(start: date, end: date) -> str:
    return f"{chat._day_words(start)} – {chat._day_words(end)}"


# --------------------------------------------------------------------------- lookups


def milestones(c: Any) -> dict[str, tuple[str, date | None]]:
    """The milestones the plan knows: lower-cased name -> (name, day)."""
    out: dict[str, tuple[str, date | None]] = {}
    for m in c.read.milestones:
        out.setdefault(m.name.lower(), (m.name, m.target_date))
    for e in c.entries():
        if e.milestone is not None and e.milestone.name:
            out.setdefault(e.milestone.name.lower(), (e.milestone.name, e.milestone.date))
    return out


def milestone(c: Any, text: str) -> tuple[str, date | None] | chat.Reply:
    x = chat._unquote(text).lower()
    known = milestones(c)
    if x in known:
        return known[x]
    # "M2" names "M2 Scale volume".
    hits = [v for k, v in known.items() if k.split(" ")[0] == x or k.startswith(f"{x} ")]
    if len(hits) == 1:
        return hits[0]
    names = sorted(v[0] for v in (hits or known.values()))[:5]
    if hits:
        return chat.Reply("question", f"Which milestone: {chat._or(names)}?")
    return chat.Reply("question", f"I could not find the milestone “{chat._unquote(text)}”.",
                      missing=True)  # fmt: skip


def goal(c: Any, text: str) -> Entity | chat.Reply:
    x = chat._unquote(text).lower()
    for g in c.talk_goals:
        if x in (g.title.lower(), (g.key or "").lower(), str(g.id)):
            return g
    hits = [g for g in c.talk_goals if x and x in g.title.lower()]
    if len(hits) == 1:
        return hits[0]
    return chat.Reply("question", f"I could not find the goal “{chat._unquote(text)}”.",
                      missing=True)  # fmt: skip


def _day(c: Any, text: str | None, name: str) -> date | None:
    if text is None:
        return None
    try:
        return date.fromisoformat(text)
    except ValueError:
        day = chat.parse_day(text, c.today)
        if day is None:
            raise ValueError(f"I could not tell which day “{text}” is ({name})") from None
        return day


# --------------------------------------------------------------------------- builds


def _move_kw(c: Any, e: service.Entry, start: date, end: date, how: str = "") -> dict:
    if end < start:
        raise ValueError("the end comes before the start")
    s, en = start.isoformat(), end.isoformat()
    how = f" {how}," if how else ""
    return chat._kw(f"Move {label(e)}{how} to {span(start, end)}", "move_dates", e,
                    {"item_id": str(e.row.id)}, chat._dates(e), {"start_date": s, "end_date": en},
                    {"kind": "dates", "item_id": str(e.row.id), "start_date": s,
                     "end_date": en, "roadmap": True})  # fmt: skip


def build_move_dates(c: Any, a: dict[str, Any]) -> chat.Built:
    """chat's move_dates with typed days (Correct's start and end) or a shift said "later" or
    "earlier"; else chat's own build (a period or a day)."""
    start, end = _day(c, chat._arg(a, "start"), "start"), _day(c, chat._arg(a, "end"), "end")
    shift = chat._arg(a, "shift")
    m = re.fullmatch(rf"{SHIFT}(?: (later|earlier|out))?", shift.lower()) if shift else None
    said = m is not None and (m[3] == "earlier" or on_roadmap(c.page))
    if start is None and end is None and m is not None and said:
        e = c.find(chat._need(a, "item"))
        if isinstance(e, chat.Reply):
            return e
        by = chat.parse_shift(f"{m[1]} {m[2]}")
        assert by is not None
        sign = -1 if m[3] == "earlier" else 1
        r = e.resolved

        def moved(d: date) -> date:
            return chat._add_months(d, sign * by[0]) + timedelta(days=sign * by[1])

        n = {"a": 1, "an": 1, "one": 1}.get(m[1]) or WORDS_IN.get(m[1]) or int(m[1])
        how = f"{WORDS.get(n, str(n))} {m[2]}{'s' if n > 1 else ''} {m[3] or 'later'}"
        if m[3] == "out":
            how = how.replace(" out", " later")
        return _move_kw(c, e, moved(r.start.date), moved(r.end.date), how)
    if start is None and end is None:
        return chat._b_move(c, a)
    e = c.find(chat._need(a, "item"))
    if isinstance(e, chat.Reply):
        return e
    r = e.resolved
    start = start or (end - (r.end.date - r.start.date) if end else r.start.date)  # type: ignore[operator]
    end = end or start + (r.end.date - r.start.date)
    return _move_kw(c, e, start, end)


def build_move_after(c: Any, a: dict[str, Any]) -> chat.Built:
    e = c.find(chat._need(a, "item"))
    if isinstance(e, chat.Reply):
        return e
    other = c.find(chat._need(a, "after"))
    if isinstance(other, chat.Reply):
        return other
    if other.row.id == e.row.id:
        raise ValueError("an item cannot move after itself")
    r = e.resolved
    start = other.resolved.end.date + timedelta(days=1)
    return _move_kw(c, e, start, start + (r.end.date - r.start.date),
                    f"after {other.row.title}")  # fmt: skip


def build_move_to_milestone(c: Any, a: dict[str, Any]) -> chat.Built:
    e = c.find(chat._need(a, "item"))
    if isinstance(e, chat.Reply):
        return e
    m = milestone(c, chat._need(a, "milestone"))
    if isinstance(m, chat.Reply):
        return m
    name, day = m
    if e.milestone is not None and (e.milestone.name or "").lower() == name.lower():
        return chat.Reply("note", f"{e.row.title} is in {name} already.")
    when = f" ({chat._day_words(day)})" if day else ""
    after = {"milestone": {"name": name, "date": day.isoformat() if day else None,
                           "date_source": "typed" if day else None}}  # fmt: skip
    return chat._kw(f"Move {label(e)} to {name}{when}", "set_milestone", e,
                    {"item_id": str(e.row.id)}, {"milestone": e.row.milestone}, after,
                    {"kind": "milestone", "item_id": str(e.row.id), "name": name,
                     "date": day.isoformat() if day else None,
                     "before_name": e.milestone.name if e.milestone else None,
                     "roadmap": True})  # fmt: skip


def build_add_item(c: Any, a: dict[str, Any]) -> chat.Built:
    from oracle.simple.changes import TITLE_MAX

    title = chat._unquote(chat._need(a, "title"))
    if not title or len(title) > TITLE_MAX:
        raise ValueError(f"a title of 1 to {TITLE_MAX} characters")
    g = goal(c, a["goal"]) if chat._arg(a, "goal") else None
    if isinstance(g, chat.Reply):
        return g
    m = milestone(c, a["milestone"]) if chat._arg(a, "milestone") else None
    if isinstance(m, chat.Reply):
        return m
    start, end = _day(c, chat._arg(a, "start"), "start"), _day(c, chat._arg(a, "end"), "end")
    if m is not None and m[1] is not None and start is None and end is None:
        # Inside the milestone: its last two weeks, never before today.
        end = m[1]
        start = max(c.today, end - timedelta(days=13))
    if start is not None and end is None:
        end = start + timedelta(days=13)
    if end is not None and start is None:
        start = max(c.today, end - timedelta(days=13))
    if start is not None and end is not None and end < start:
        raise ValueError("the end comes before the start")
    if end is not None and end < c.today:
        raise ValueError("those days are over")
    where = ({"kind": "goal", "value": str(g.id)} if g is not None
             else {"kind": "horizon", "value": "next"})  # fmt: skip
    after: dict[str, Any] = {"title": title, "outcome": None,
                             "start_date": start.isoformat() if start else None,
                             "end_date": end.isoformat() if end else None,
                             "milestone": ({"name": m[0], "date": m[1].isoformat() if m[1]
                                            else None} if m is not None else None)}  # fmt: skip
    words = (f" under {g.title}" if g is not None else "") + (f" to {m[0]}" if m else "")
    if start is not None and end is not None:
        words += f", {span(start, end)}"
    return chat._kw(f"Add {title}{words}", "add_item", None, {"where": where}, {}, after,
                    {"kind": "add", "title": title, "goal": g.title if g is not None else None,
                     "milestone": m[0] if m else None, "start_date": after["start_date"],
                     "end_date": after["end_date"], "roadmap": True})  # fmt: skip


def build_split_item(c: Any, a: dict[str, Any]) -> chat.Built:
    e = c.find(chat._need(a, "item"))
    if isinstance(e, chat.Reply):
        return e
    raw = chat._need(a, "slices").lower()
    n = WORDS_IN.get(raw) or (int(raw) if raw.isdigit() else 0)
    if not 2 <= n <= SLICES_MAX:
        raise ValueError(f"split into 2 to {SLICES_MAX} slices")
    r = e.resolved
    days = (r.end.date - r.start.date).days + 1
    if days < n:
        raise ValueError(f"{e.row.title} is too short to split in {n}")
    each = days // n
    cards = [_move_kw(c, e, r.start.date, r.start.date + timedelta(days=each - 1),
                      "to its first slice")]  # fmt: skip
    g = e.goal.title if e.goal is not None else None
    ms = e.milestone.name if e.milestone is not None and e.milestone.name else None
    for k in range(1, n):
        s = r.start.date + timedelta(days=each * k)
        en = r.end.date if k == n - 1 else s + timedelta(days=each - 1)
        out = build_add_item(c, {"title": f"{e.row.title}: slice {k + 1}", "goal": g,
                                 "milestone": ms, "start": s.isoformat(),
                                 "end": en.isoformat()})  # fmt: skip
        if isinstance(out, chat.Reply):
            return out
        cards.append(out)
    return chat.Reply("cards", f"I understood: split {label(e)} into {WORDS[n]} slices.", cards)


# --------------------------------------------------------------------------- the phrases

SHIFT = r"(a|an|one|two|three|four|\d+) (day|week|month|quarter)s?"


def phrase(c: Any, t: str) -> tuple[str, dict[str, Any]] | None:
    """The item talk's own fixed phrases ("move it two weeks later")."""
    if m := re.fullmatch(rf"(?:move|push|shift|slip) (.+?) (?:by )?{SHIFT} (later|earlier)\.?",
                         t, re.I):  # fmt: skip
        return "move_dates", {"item": m[1], "shift": f"{m[2]} {m[3]}s {m[4].lower()}".lower()}
    if m := re.fullmatch(r"(?:move|push|put) (.+?) (?:to|into|under) (m\d+\b.*?)\.?", t, re.I):
        return "move_to_milestone", {"item": m[1], "milestone": m[2]}
    if m := re.fullmatch(r"(?:push|move) (.+?) after (.+?)\.?", t, re.I):
        return "move_after", {"item": m[1], "after": m[2]}
    if m := re.fullmatch(r"split (.+?) (?:into|in) (two|three|four|\d) (?:slices|parts)\.?", t,
                         re.I):  # fmt: skip
        return "split_item", {"item": m[1], "slices": m[2]}
    return None


# --------------------------------------------------------------------------- the card out


FIELD_WORDS = {"title": "title", "goal": "goal", "milestone": "milestone",
               "start_date": "start", "end_date": "end", "owner": "owner"}  # fmt: skip


def correct_out(card: SimpleChatCard) -> tuple[dict | None, dict | None]:
    """(change_words, correct) of an open roadmap card (None, None for any other)."""
    p = card.preview or {}
    if not p.get("roadmap") or card.meeting_id is not None:
        return None, None
    fields = CORRECTABLE.get(card.op)
    words: dict | None = None
    values: dict[str, Any] = {}
    if card.op == "move_dates":
        b, a = card.before or {}, card.after or {}
        if b.get("start_date") and b.get("end_date"):
            words = {"before": span(date.fromisoformat(b["start_date"]),
                                    date.fromisoformat(b["end_date"])),
                     "after": span(date.fromisoformat(a["start_date"]),
                                   date.fromisoformat(a["end_date"]))}  # fmt: skip
        values = {"start_date": a.get("start_date"), "end_date": a.get("end_date")}
    elif card.op == "set_milestone":
        words = {"before": p.get("before_name") or "No milestone", "after": p.get("name")}
        values = {"milestone": p.get("name")}
    elif card.op == "edit_title":
        words = {"before": (card.before or {}).get("title"), "after": p.get("title")}
        values = {"title": p.get("title")}
    elif card.op == "set_owner":
        words = {"before": p.get("before_name") or "No owner", "after": p.get("person_name")}
        values = {"owner": p.get("person_name")}
    elif card.op == "add_item":
        values = {k: p.get(k) for k in CORRECTABLE["add_item"]}
    if fields is None:
        return words, None
    return words, {"fields": list(fields), "values": values}


def args_of(card: SimpleChatCard, values: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    """The build (op, args) that remakes a card from Correct's values (its own reading for
    any field not given)."""
    _, cur = correct_out(card)
    if cur is None:
        raise chat.ChatError(422, "This change has nothing to correct")
    unknown = set(values) - set(cur["fields"])
    if unknown:
        words = ", ".join(FIELD_WORDS.get(k, "that") for k in sorted(unknown))
        raise chat.ChatError(422, f"The {words} cannot be corrected here")
    v = {**cur["values"], **{k: x for k, x in values.items() if x not in (None, "")}}
    item = str(card.item_id) if card.item_id else None
    if card.op == "move_dates":
        return "move_dates", {"item": item, "start": v["start_date"], "end": v["end_date"]}
    if card.op == "set_milestone":
        return "move_to_milestone", {"item": item, "milestone": v["milestone"]}
    if card.op == "edit_title":
        return "edit_title", {"item": item, "title": v["title"]}
    if card.op == "set_owner":
        return "set_owner", {"item": item, "person": v["owner"]}
    return "add_item", {"title": v.get("title"), "goal": v.get("goal"),
                        "milestone": v.get("milestone"), "start": v.get("start_date"),
                        "end": v.get("end_date")}  # fmt: skip


async def correct(db: Any, principal: Any, card: SimpleChatCard, values: dict[str, Any]) -> None:
    """Rebuild an open card from Correct's values through its build (the caller applies it
    next): the corrected values win; the restatement says them."""
    if card.status != "open":
        raise chat.ChatError(409, f"This card is {card.status} already")
    op, args = args_of(card, {k: str(x) for k, x in values.items() if x is not None})
    c = chat.Ctx(db, principal, None)
    c.wants_decider = False
    await c.load()
    reply = chat.build(c, op, {k: x for k, x in args.items() if x is not None})
    if reply.kind != "cards" or len(reply.cards) != 1:
        raise chat.ChatError(422, reply.body.removeprefix("I can't do that here: "))
    kw = reply.cards[0]
    card.summary, card.target, card.before = kw["summary"], kw["target"], kw["before"]
    card.after, card.preview = kw["after"], {**(kw["preview"] or {}), "roadmap": True}
    await _restate_line(db, card)


async def _restate_line(db: Any, card: SimpleChatCard) -> None:
    """An item talk's one-card line ("I understood: ...") says the corrected card."""
    from oracle.discussions.models import DiscussionMessage

    if card.message_id is None:
        return
    msg = await db.get(DiscussionMessage, card.message_id)
    if msg is None or not (msg.body or "").startswith("I understood: "):
        return
    ids = await db.scalars(
        select(SimpleChatCard.id).where(SimpleChatCard.message_id == card.message_id)
    )
    if len(list(ids)) == 1:
        s = card.summary
        msg.body = f"I understood: {s[:1].lower()}{s[1:]}."


def restate(c: Any, reply: chat.Reply) -> chat.Reply:
    """On the roadmap: a viewer gets a note, never a card; every card is a roadmap card (it
    may be corrected); in an item's talk one change is restated in one line."""
    if c.meeting is not None or not on_roadmap(c.page) or reply.kind != "cards":
        return reply
    from oracle.authz import has_role

    if not has_role(c.principal.role, "commenter"):
        return chat.Reply("note", VIEWER_NOTE)
    for card in reply.cards:
        card["preview"] = {**(card.get("preview") or {}), "roadmap": True}
        if card["op"] == "set_owner":
            card["preview"]["before_name"] = card["preview"].get("before_name")
    if c.item is not None and len(reply.cards) == 1:
        s = reply.cards[0]["summary"]
        reply.body = f"I understood: {s[:1].lower()}{s[1:]}."
    return reply


def source_of(c: Any, said: Any) -> list[dict[str, Any]]:
    """Where an item talk's answer comes from, as the message's citation."""
    if c.item is None:
        return []
    where = "From the PRD" if said == "prd" and c.item.row.prd_document_id else "From the roadmap"
    return [{"kind": "simple_source", "label": f"{where} · {label(c.item)}"}]


def source_label(citations: list[dict[str, Any]] | None) -> str | None:
    return next((str(x.get("label")) for x in citations or []
                 if isinstance(x, dict) and x.get("kind") == "simple_source"), None)  # fmt: skip


def item_context(c: Any) -> dict[str, Any] | None:
    """The talk's item for the reader: "it" means this item."""
    e = c.item
    if e is None:
        return None
    r = e.resolved
    names = {u.id: display_name(u.email, u.name) for u in c.people}
    return {
        "id": str(e.row.id), "code": getattr(e, "code", None), "title": e.row.title,
        "outcome": e.row.outcome, "start": r.start.date.isoformat(),
        "end": r.end.date.isoformat(), "estimated": r.undated,
        "milestone": e.milestone.name if e.milestone else None,
        "milestone_day": e.milestone.date.isoformat() if e.milestone and e.milestone.date
        else None,
        "goal": e.goal.title if e.goal is not None else None,
        "owner": e.owner_name or names.get(e.row.owner_id),  # type: ignore[arg-type]
        "prd": e.prd.title if e.prd is not None else None,
        "prd_section": service.prd_section_label(e.row.prd_section_key, e.prd_heading)
        if e.row.prd_section_key else None,
        "reasons": service._reasons(e),
    }  # fmt: skip


ITEM = chat.ITEM
ACTIONS: list[dict[str, Any]] = [
    {"op": "move_to_milestone", "describe": "Move an item to another milestone",
     "args": {"item": ITEM, "milestone": "the milestone's name (\"M2\" or its full name)"},
     "build": build_move_to_milestone},
    {"op": "move_after", "describe": "Move an item to start the day after another ends",
     "args": {"item": ITEM, "after": "the item it goes after"}, "build": build_move_after},
    {"op": "add_item", "describe": "Add a new item to the roadmap",
     "args": {"title": "its title", "goal": "the goal it serves (optional)",
              "milestone": "its milestone (optional)", "start": "its first day (optional)",
              "end": "its last day (optional)"}, "build": build_add_item},
    {"op": "split_item", "describe": "Split an item into slices (2 to 4)",
     "args": {"item": ITEM, "slices": "how many slices"}, "build": build_split_item},
]  # fmt: skip

for _a in ACTIONS:
    chat.register(chat.ChatOp(_a["op"], _a["describe"], dict(_a["args"]), _a["build"]))
# chat's move_dates also takes typed days (Correct, the reader's "start"/"end").
chat.register(chat.ChatOp(
    "move_dates", chat.OPS["move_dates"].describe,
    {**chat.OPS["move_dates"].args, "start": "or its new first day", "end": "and last day"},
    build_move_dates))  # fmt: skip
