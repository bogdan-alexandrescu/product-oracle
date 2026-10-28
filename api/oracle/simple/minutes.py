"""A meeting's minutes say only what happened (the owner's production walk, 2026-10-27).

The minutes of a meeting where nothing was decided once invented open questions and
action items nobody said. Now the minutes come from the meeting's own **record**
(:func:`record`): its chat lines (the people's lines in the meeting chat, oracle.simple.chat),
its decisions (with their rationale: the notes), its action items (``simple_action_items``
with the meeting's id) and what still waits on whom.

- Oracle's quick draft (oracle.simple.meetings.extract) lists the record's open questions
  (the chat's questions) and action items;
- an empty record (no chat line, decision or action item) gives minutes saying plainly that
  nothing was decided or recorded, with empty lists, and the ``meeting_minutes`` job asks
  no model;
- the job's answer passes :func:`check`: an open question or action item the record does
  not support is dropped (and logged); an action item from the record keeps the record's
  owner and due date; one taken from a chat line keeps an owner only when that person wrote
  or is named in the line, and a due date only when the line says it; every recorded
  action item is in the minutes.
"""

import logging
import re
import uuid
from dataclasses import dataclass, field
from datetime import date
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

log = logging.getLogger(__name__)

MAX_LINES = 80
LINE_MAX = 500
# The share of an item's words a single record line must hold to support it.
SUPPORT = 0.6
STOP = set(
    "the a an and or but of to in on at by for with from as is are was were be been it its "
    "this that these those we our us you your they their them he she his her i me my who "
    "what when where why how which will would should could can do does did not no yes so "
    "if then than there here about into out up down over all any some more most one two "
    "also just only per via get got let make need needs".split()
)
MONTHS = "jan feb mar apr may jun jul aug sep oct nov dec".split()


@dataclass
class Line:
    text: str
    by: uuid.UUID | None = None


@dataclass
class Record:
    chat: list[Line] = field(default_factory=list)
    decisions: list[dict[str, Any]] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    actions: list[dict[str, Any]] = field(default_factory=list)
    waits: list[str] = field(default_factory=list)

    @property
    def empty(self) -> bool:
        return not (self.chat or self.decisions or self.actions)

    def lines(self) -> list[Line]:
        return [
            *self.chat,
            *(Line(d["title"]) for d in self.decisions),
            *(Line(n) for n in self.notes),
            *(Line(a["title"], a.get("owner_id")) for a in self.actions),
            *(Line(w) for w in self.waits),
        ]

    def questions(self) -> list[str]:
        """The chat's questions, in order."""
        return [c.text for c in self.chat if c.text.rstrip().endswith("?")]


def _clip(text: str) -> str:
    return " ".join(str(text or "").split())[:LINE_MAX]


async def record(
    db: AsyncSession, m: Any, decisions: list[Any], waits: list[dict[str, Any]]
) -> Record:
    """The meeting's own record; ``decisions``: its decisions oldest first."""
    from oracle.discussions.models import Discussion, DiscussionMessage
    from oracle.simple.models import SimpleActionItem

    out = Record()
    key = f"screen:/simple/meetings/{m.id}"
    rows = await db.scalars(
        select(DiscussionMessage)
        .join(Discussion, Discussion.id == DiscussionMessage.discussion_id)
        .where(
            Discussion.subject_key == key,
            Discussion.origin == "panel",
            DiscussionMessage.author_kind == "person",
            DiscussionMessage.deleted_at.is_(None),
        )
        .order_by(DiscussionMessage.created_at, DiscussionMessage.id)
        .limit(MAX_LINES)
    )
    out.chat = [Line(_clip(r.body), r.author_id) for r in rows if _clip(r.body)]
    for d in decisions:
        out.decisions.append({"title": _clip(d.title), "by": d.approver_id})
        out.notes += [_clip(x) for x in (d.rationale, d.context) if _clip(x or "")]
    actions = await db.scalars(
        select(SimpleActionItem)
        .where(SimpleActionItem.meeting_id == m.id, SimpleActionItem.status != "dropped")
        .order_by(SimpleActionItem.created_at, SimpleActionItem.id)
    )
    out.actions = [
        {
            "title": _clip(a.title),
            "owner_id": a.owner_id,
            "due_date": a.due_date.isoformat() if a.due_date else None,
        }
        for a in actions
    ]
    out.waits = [_clip(w["what"]) for w in waits]
    return out


def words(text: str) -> set[str]:
    out = set()
    for w in re.findall(r"[a-z0-9]+", str(text).lower()):
        if len(w) < 3 or w in STOP:
            continue
        out.add(w[:-1] if len(w) > 3 and w.endswith("s") else w)
    return out


def supports(line: str, item: str) -> bool:
    want = words(item)
    return bool(want) and len(want & words(line)) / len(want) >= SUPPORT


def _said_date(due: str, line: str) -> bool:
    """The line says the day: its ISO form, or its month and day ("Nov 6", "6 November")."""
    try:
        d = date.fromisoformat(due)
    except ValueError:
        return False
    low = line.lower()
    if due in low:
        return True
    month = MONTHS[d.month - 1]
    return bool(
        re.search(rf"\b{month}[a-z]*\.? {d.day}\b", low)
        or re.search(rf"\b{d.day} {month}[a-z]*\b", low)
    )


def _named(person: uuid.UUID, names: dict[uuid.UUID, str], line: str) -> bool:
    name = words(names.get(person, ""))
    return bool(name & words(line))


def check(
    meeting_id: Any,
    rec: Record,
    questions: list[str],
    actions: list[dict[str, Any]],
    attendees: set[uuid.UUID],
    names: dict[uuid.UUID, str],
) -> tuple[list[str], list[dict[str, Any]]]:
    """The answer's open questions and (cleaned) action items the record supports; the rest
    is dropped and logged. Every recorded action item is kept, as recorded."""
    lines = rec.lines()
    kept_q = []
    for q in questions:
        if any(supports(x.text, q) for x in lines):
            kept_q.append(q)
        else:
            log.info("meeting %s minutes: dropped an open question not in its record: %r",
                     meeting_id, q)  # fmt: skip
    kept_a: list[dict[str, Any]] = []
    used: set[int] = set()
    for a in actions:
        title = a["title"]
        hit = next(
            (i for i, r in enumerate(rec.actions) if i not in used and supports(r["title"], title)),
            None,
        )
        if hit is not None:
            used.add(hit)
            r = rec.actions[hit]
            kept_a.append({"title": r["title"], "owner_id": str(r["owner_id"]),
                           "due_date": r["due_date"]})  # fmt: skip
            continue
        same = words(title)
        if any(same == words(k["title"]) for k in kept_a):
            continue  # the same task twice
        line = next((c for c in rec.chat if supports(c.text, title)), None)
        if line is None:
            log.info("meeting %s minutes: dropped an action item not in its record: %r",
                     meeting_id, title)  # fmt: skip
            continue
        owner = None
        if a.get("owner_id"):
            try:
                owner = uuid.UUID(str(a["owner_id"]))
            except ValueError:
                owner = None
        if owner is not None and (
            owner not in attendees or not (owner == line.by or _named(owner, names, line.text))
        ):
            owner = None
        due = (
            a.get("due_date")
            if a.get("due_date") and _said_date(a["due_date"], line.text)
            else None
        )
        kept_a.append({"title": title, "owner_id": str(owner) if owner else None, "due_date": due})
    for i, r in enumerate(rec.actions):
        if i not in used:
            kept_a.append({"title": r["title"], "owner_id": str(r["owner_id"]),
                           "due_date": r["due_date"]})  # fmt: skip
    return kept_q, kept_a


def nothing(title: str) -> str:
    return f"{title}: nothing was decided or recorded."
