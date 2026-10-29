"""Simple S9 (#723, D22): change by chat, in a meeting and in the Ask panel, and Home's
"Walk me through it".

**A request never changes anything by itself** (D22c). Oracle answers each line with one
reply: change CARDS (the exact change-engine ops, oracle.simple.changes, each with its
constraint check as if applied and one-click fixes), one short QUESTION when the request
is ambiguous, an ANSWER to a question about the plan (from Oracle's data only: no live
reads of anyone's sources), or a NOTE. Nothing is written until someone allowed applies a
card; Apply goes through the change engine with the caller's own rights (owners and the
decider apply, approvers and commenters propose), so a card can never do what a gesture
could not. Discard writes nothing.

**Threads** are Oracle's discussions (G1): one shared thread per meeting (subject the
meeting's screen, private to its attendees), and one per person for the Ask panel. The
person's line and Oracle's reply are discussion messages; the cards hang off the reply
(``simple_chat_cards``). Oracle's reply here is deterministic (no model call), so it costs
no llm budget.

**Who applies in a meeting** (D22a, S8's oracle.simple.meetings, imported lazily: without
it a meeting chat answers 404): the presenter's change mode: ``everyone`` (any attendee),
``presenter`` (only the presenter) or ``named`` (the presenter and one or two named
people); a viewer only asks questions (no cards); an ended meeting applies nothing. An
applied card is a meeting decision (``record_meeting_decision``), and undoing the card
reverses that decision. The presenter changes the mode through S8's ``set_rules``.

**Visuals** (S10's oracle.simple.visuals, imported lazily): a card that adds or changes a
flow or feature carries the stored flow and requests a visual when it has none.
"""

import difflib
import importlib
import re
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from oracle import audit, company_time
from oracle.auth.models import User
from oracle.authz import has_role
from oracle.decisions.models import Decision, DecisionReview
from oracle.discussions.models import Discussion, DiscussionMessage, DiscussionParticipant
from oracle.members.names import display_name
from oracle.simple import changes, drafts, service, targets
from oracle.simple.changes import ChangeError
from oracle.simple.models import SimpleChange, SimpleChatCard, SimpleChatRead
from oracle.simple.schemas import (
    ChatCardOut,
    ChatChoiceOut,
    ChatFix,
    ChatMessageOut,
    ChatRulesOut,
    ChatStopOut,
    ChatSummaryOut,
    ChatThreadOut,
    SimpleChangeIn,
    SimpleChangeResult,
    SimpleFlag,
    SimpleItemFlags,
    SimplePersonRef,
    WalkDecision,
    WalkOut,
    WalkStepOut,
)

MEETINGS = "oracle.simple.meetings"
VISUALS = "oracle.simple.visuals"
ENGINE = "oracle.simple.chat"
READER_JOB = "chat_reader"
DEAD = ("failed", "cancelled")
FLOW_OPS = ("add_feature_ask", "add_item_task")
CARD_OPS_ON_ITEMS = ("move_dates", "change_horizon", "set_milestone", "edit_title", "cut")
VIEWER_NOTE = "Viewers ask questions here; ask the presenter to make a change."
EXAMPLES = (
    "Try “move <item> to Q2”, “add a milestone 'beta' to <item> on March 1”, “new feature ask "
    "from <name>: <ask>”, “add a task '<task>' to <item>”, “action item: <person> to <do> by "
    "<day>” or “who owns <item>?”."
)
MONTHS = {
    m: i + 1
    for i, m in enumerate(
        (
            "january february march april may june july august september october november december"
        ).split()
    )
}
HERE = "Here is the change. Preview it, then apply or discard it."
NEITHER: dict[str, Any] = {"label": "Neither", "op": None, "args": {}}
READING = "Reading that…"
COULD_NOT_READ = "I couldn't read that just now."
SAY_AGAIN = "Say it another way."
# qa-simple-decide-3: a question in a meeting's chat is kept for the minutes' open questions
# (minutes.Record.questions); Ask Oracle answers it.
MEETING_ASK = "Kept as a question for the minutes. For an answer now, use Ask Oracle."
QUOTE = r"[\"'“‘](.+?)[\"'”’]"
DAY = r"(\d{4}-\d{2}-\d{2}|[a-z]+ \d{1,2})"


class ChatError(Exception):
    def __init__(self, status: int, detail: Any) -> None:
        super().__init__(str(detail))
        self.status = status
        self.detail = detail


def _module(name: str) -> Any:
    """A parallel lane's module (S8 meetings, S10 visuals), or None while it is absent."""
    try:
        return importlib.import_module(name)
    except ImportError:
        return None


def _me(principal: Any) -> uuid.UUID:
    me = getattr(principal, "user_id", None)
    if me is None:
        raise ChatError(403, "Simple's chat is for people")
    return me


# --------------------------------------------------------------------------- words


def _unquote(s: str) -> str:
    return re.sub(r"[?.!]+$", "", s.strip().strip("\"'“”‘’")).strip()


def _or(xs: list[str]) -> str:
    return xs[0] if len(xs) < 2 else f"{', '.join(xs[:-1])} or {xs[-1]}"


def _day_words(d: date | str | None, year: bool = False) -> str:
    if d is None:
        return "no date"
    d = date.fromisoformat(d) if isinstance(d, str) else d
    return f"{d.day} {d.strftime('%b')}" + (f" {d.year}" if year else "")


def parse_day(text: str, today: date) -> date | None:
    """ "2027-03-01", or "March 1" / "mar 1": the next such day on or after today."""
    text = text.strip().lower()
    try:
        return date.fromisoformat(text)
    except ValueError:
        pass
    m = re.fullmatch(r"([a-z]+) (\d{1,2})", text)
    if not m:
        return None
    month = next((n for k, n in MONTHS.items() if k.startswith(m[1]) and len(m[1]) >= 3), None)
    if month is None:
        return None
    try:
        d = date(today.year, month, int(m[2]))
        return d if d >= today else date(today.year + 1, month, int(m[2]))
    except ValueError:
        return None


def _months(year: int, month: int, n: int) -> tuple[date, date]:
    """The n months from the first of ``month`` (it may run past December)."""
    year, month = year + (month - 1) // 12, (month - 1) % 12 + 1
    after = month - 1 + n
    end = date(year + after // 12, after % 12 + 1, 1) - timedelta(days=1)
    return date(year, month, 1), end


def quarter(n: int, today: date, year: int | None = None) -> tuple[date, date]:
    """Qn of ``year``, else the next one on or after today's quarter."""
    current = (today.month - 1) // 3 + 1
    if year is None:
        year = today.year if n >= current else today.year + 1
    return _months(year, 3 * (n - 1) + 1, 3)


def parse_period(
    text: str, today: date, plan_span: tuple[date, date] | None = None
) -> tuple[date, date] | None:
    """A period in words, from ``today`` (the company's day): "this quarter" (the plan's
    span when there is one, plan-model), "next
    quarter", "the quarter after [next]", "next month", "<month> [year]" (the next one on
    or after this month), "Qn [year]" and "Hn [year]" (the next on or after today's)."""
    t = " ".join(text.lower().split()).removeprefix("the ")
    q = (today.month - 1) // 3  # this quarter, from 0
    steps = {"this quarter": 0, "current quarter": 0, "next quarter": 1,
             "quarter after": 2, "quarter after next": 2}  # fmt: skip
    if t in steps and steps[t] == 0 and plan_span is not None:
        return plan_span
    if t in steps:
        return _months(today.year, 3 * (q + steps[t]) + 1, 3)
    if t == "this month":
        return _months(today.year, today.month, 1)
    if t == "next month":
        return _months(today.year, today.month + 1, 1)
    if m := re.fullmatch(r"q([1-4])(?: (\d{4}))?", t):
        return quarter(int(m[1]), today, int(m[2]) if m[2] else None)
    if m := re.fullmatch(r"h([12])(?: (\d{4}))?", t):
        n = int(m[1])
        year = int(m[2]) if m[2] else today.year + (n < (1 if today.month <= 6 else 2))
        return _months(year, 6 * (n - 1) + 1, 6)
    if m := re.fullmatch(r"([a-z]+)(?: (\d{4}))?", t):
        month = MONTHS.get(m[1]) or next(
            (n for k, n in MONTHS.items() if len(m[1]) >= 3 and k.startswith(m[1])), None
        )
        if month is None:
            return None
        year = int(m[2]) if m[2] else today.year + (month < today.month)
        return _months(year, month, 1)
    return None


# --------------------------------------------------------------------------- Oracle's reply


class Reply:
    """``understood``: the line is one Oracle's reader knows (the Ask panel's one box sends
    any other line to Oracle's Ask); ``missing``: no item (or person) has the name it gave."""

    def __init__(self, kind: str, body: str, cards: list[dict[str, Any]] | None = None,
                 understood: bool = True, missing: bool = False, reader: bool = False,
                 choices: list[dict[str, Any]] | None = None) -> None:  # fmt: skip
        self.kind, self.body, self.cards = kind, body, cards or []
        self.understood, self.missing = understood, missing
        # ``reader``: a line parse() does not know, for Oracle's reader (the chat_reader job).
        self.reader = reader
        # A question's clickable choices ({label, op, args}; NEITHER last).
        self.choices = choices or []
        # The items an ambiguous name matched (ChatOp builds turn them into choices).
        self.candidates: list[service.Entry] = []
        # The people an unknown or ambiguous name may mean (build turns them into choices).
        self.people: list[str] = []
        self.person_text: str | None = None
        # roadmap-talk: where an item talk's answer comes from (the message's citations).
        self.citations: list[dict[str, Any]] = []


class Ctx:
    """What Oracle reads to answer one line: the plan as the asker sees it."""

    def __init__(self, db: AsyncSession, principal: Any, meeting: Any) -> None:
        self.db, self.principal, self.meeting = db, principal, meeting
        self.read: service.Read | None = None
        self.overlays: dict[uuid.UUID, dict[str, Any]] = {}
        self.people: list[User] = []
        # chat-actions: the Ask panel's page and the document it shows.
        self.page: str | None = None
        self.page_document: Any = None
        self.meeting_decider_name: str | None = None
        # A commenter's decision on the Ask panel is proposed to this person.
        self.ask_decider: User | None = None
        # Only a line that may build a decision card resolves it (False: the line is not one).
        self.wants_decider = True
        # suggest_feature: the confirmed goals and the baseline features (look-alikes).
        self.goals: list[Any] = []
        self.features: list[Any] = []
        # plan-model: "this quarter" is the span of the plan running today (else the next).
        self.plan_span: tuple[date, date] | None = None
        # roadmap-talk: the item whose talk this is ("it"), the company's goals.
        self.item: service.Entry | None = None
        self.talk_goals: list[Any] = []

    async def load(self) -> "Ctx":
        from oracle.simple import chat_actions

        self.page_document = await chat_actions.page_document(self.db, self.page)
        self.overlays = await drafts.overlays_for(self.db, self.principal)
        self.read = await service.load(self.db, self.overlays)
        from oracle.simple import plan

        views = await plan.views(self.db, {e.prd.id for e in self.read.entries if e.prd})
        span = plan.current_span(list(views.values()), self.read.today)
        self.plan_span = (span.start, span.end) if span is not None else None
        self.people = list(await self.db.scalars(select(User).where(User.disabled_at.is_(None))))
        await _talk().load(self)
        self.meeting_decider_name = await chat_actions.meeting_decider_name(self.db, self)
        self.goals, self.features = await chat_actions.suggest_context(self.db)
        if self.meeting is None and self.wants_decider and chat_actions.proposes(self.principal):
            self.ask_decider = await chat_actions.ask_decider(self.db, self.page_document)
        return self

    @property
    def today(self) -> date:
        assert self.read is not None
        return self.read.today

    def entries(self) -> list[service.Entry]:
        assert self.read is not None
        return [e for e in self.read.entries if e.row.draft_roadmap_id is None]

    def find(self, text: str) -> service.Entry | Reply:
        x = _unquote(text).lower()
        if self.item is not None and x in _talk().IT:
            return self.item
        es = self.entries()
        by_id = [e for e in es if str(e.row.id) == x or (e.row.item_key or "").lower() == x]
        if len(by_id) == 1:
            return by_id[0]
        exact = [e for e in es if e.row.title.lower() == x]
        if len(exact) == 1:
            return exact[0]
        hits = exact or [e for e in es if x and x in e.row.title.lower()]
        if len(hits) == 1:
            return hits[0]
        if hits:
            titles = sorted({e.row.title for e in hits})[:5]
            if len(titles) == 1:
                titles = [f"{e.row.title} ({e.roadmap.title})" for e in hits[:5]]
            q = Reply("question", f"Which one: {_or(titles)}?")
            q.candidates = sorted(hits, key=lambda e: e.row.title)
            return q
        missing = _unquote(text)
        return Reply("question", f"I could not find “{missing}” on the roadmap. Which item?",
                     missing=True)  # fmt: skip

    def person(self, text: str) -> User | Reply:
        x = _unquote(text).lower()
        if x in ("me", "myself", "i"):
            me = next((u for u in self.people if u.id == _me(self.principal)), None)
            if me is not None:
                return me

        def names(u: User) -> list[str]:
            full = display_name(u.email, u.name).lower()
            return [full, full.split(" ")[0], u.email.lower(), u.email.split("@")[0].lower()]

        hits = [u for u in self.people if x in names(u)]
        if len(hits) == 1:
            return hits[0]
        if hits:
            shown = [display_name(u.email, u.name) for u in hits[:5]]
            q = Reply("question", f"Which {_unquote(text)}: {_or(shown)}?")
            q.people, q.person_text = shown, text
            return q
        # No one by that name: offer the people whose names come closest.
        near = {n: u for u in self.people for n in names(u)}
        close = difflib.get_close_matches(x, list(near), n=5, cutoff=0.6)
        shown = list(dict.fromkeys(display_name(near[n].email, near[n].name) for n in close))
        q = Reply("question", f"Who is “{_unquote(text)}”? Name a person of the company.",
                  missing=True)  # fmt: skip
        q.people, q.person_text = shown, text
        return q


def _kw(summary: str, op: str, e: service.Entry | None, target: dict, before: dict,
        after: dict, preview: dict | None = None) -> dict[str, Any]:  # fmt: skip
    """A card's kwargs (``simple_chat_cards``), as ChatOp.build returns them."""
    return {"summary": summary, "op": op, "item_id": e.row.id if e is not None else None,
            "target": target, "before": before, "after": after, "preview": preview}  # fmt: skip


def _card(summary: str, op: str, e: service.Entry | None, target: dict, before: dict,
          after: dict, preview: dict | None = None) -> Reply:  # fmt: skip
    return Reply("cards", HERE, [_kw(summary, op, e, target, before, after, preview)])


def _dates(e: service.Entry) -> dict[str, Any]:
    return changes.read(e.row, changes.DATES, {})


def _owner_words(c: Ctx, e: service.Entry) -> str:
    if e.owner_name and any(u.id == e.row.owner_id for u in c.people):
        return f"{e.owner_name} owns {e.row.title}."
    if e.owner_name:
        return f"{e.owner_name} owns {e.row.title} (its track's owner)."
    return f"{e.row.title} has no owner yet."


def _decider_words(c: Ctx, e: service.Entry) -> str:
    assert c.read is not None
    ids = service.decider_ids(e, c.read.deciders)
    names = [display_name(u.email, u.name) for u in c.people if u.id in ids]
    if not names:
        return f"The company's owners decide {e.row.title}."
    return f"{_or(names)} {'decide' if len(names) > 1 else 'decides'} {e.row.title}."


# --------------------------------------------------------------------------- ops


Built = dict[str, Any] | Reply


@dataclass(frozen=True)
class ChatOp:
    """One change a chat line may ask for: what Oracle's reader is offered (``op``,
    ``describe``, ``args``: arg name -> one-line meaning) and how its card is built
    (``build``: the card kwargs, or a Reply: a question with choices, a refusal). parse()
    and the reader build cards only through it: the same item lookup, date words,
    permissions and constraint check."""

    op: str
    describe: str
    args: dict[str, str]
    build: Callable[[Ctx, dict[str, Any]], "dict | Reply"]


OPS: dict[str, ChatOp] = {}


def register(op: ChatOp) -> None:
    OPS[op.op] = op


def _arg(a: dict[str, Any], key: str) -> str | None:
    v = a.get(key)
    if v is None:
        return None
    v = str(v).strip()
    return v or None


def _need(a: dict[str, Any], key: str) -> str:
    v = _arg(a, key)
    if v is None:
        raise ValueError(f"{key} is missing")
    return v


def _add_months(d: date, n: int) -> date:
    y, m = divmod(d.month - 1 + n, 12)
    year, month = d.year + y, m + 1
    last = (date(year + (month == 12), month % 12 + 1, 1) - timedelta(days=1)).day
    return date(year, month, min(d.day, last))


def parse_shift(text: str) -> tuple[int, int] | None:
    """ "1 quarter", "a month", "2 weeks", "10 days": (months, days) to move by."""
    t = " ".join(text.lower().split()).removeprefix("+").removeprefix("by ")
    m = re.fullmatch(r"(a|an|one|two|three|\d+) (quarter|month|week|day)s?(?: later| out)?", t)
    if not m:
        return None
    n = {"a": 1, "an": 1, "one": 1, "two": 2, "three": 3}.get(m[1]) or int(m[1])
    unit = m[2]
    if unit == "quarter":
        return 3 * n, 0
    if unit == "month":
        return n, 0
    return 0, n * (7 if unit == "week" else 1)


def _b_horizon(c: Ctx, a: dict[str, Any]) -> Built:
    e = c.find(_need(a, "item"))
    if isinstance(e, Reply):
        return e
    h = _need(a, "horizon").lower()
    if h not in ("now", "next", "later"):
        raise ValueError("horizon: now, next or later")
    return _kw(f"Move {e.row.title} to {h.capitalize()}", "change_horizon", e,
               {"item_id": str(e.row.id)}, {"horizon": e.row.horizon}, {"horizon": h},
               {"kind": "horizon", "item_id": str(e.row.id), "horizon": h})  # fmt: skip


def _b_move(c: Ctx, a: dict[str, Any]) -> Built:
    when, shift = _arg(a, "when"), _arg(a, "shift")
    period = parse_period(when, c.today, c.plan_span) if when else None
    day = None
    if when and period is None:
        day = parse_day(when, c.today) if re.fullmatch(DAY, when, re.I) else None
    by = parse_shift(shift) if shift else None
    if period is None and day is None and by is None:
        raise ValueError(f"I could not tell which day “{when or shift or ''}” is")
    e = c.find(_need(a, "item"))
    if isinstance(e, Reply):
        return e
    r = e.resolved
    length = (r.end.date - r.start.date).days
    if by is not None:
        start = _add_months(r.start.date, by[0]) + timedelta(days=by[1])
        end = _add_months(r.end.date, by[0]) + timedelta(days=by[1])
    elif period is not None:
        start, last = period
        end = last if r.undated else start + timedelta(days=length)
    else:
        assert day is not None
        start = day
        end = start + timedelta(days=29 if r.undated else length)
    s, en = start.isoformat(), end.isoformat()
    card = _kw(f"Move {e.row.title} to {_day_words(start)} – {_day_words(end, True)}",
               "move_dates", e, {"item_id": str(e.row.id)}, _dates(e),
               {"start_date": s, "end_date": en},
               {"kind": "dates", "item_id": str(e.row.id), "start_date": s,
                "end_date": en})  # fmt: skip
    if period is not None and start < c.today:
        # "this quarter" / "this month" / the current Qn start on their first day.
        return Reply("cards", f"Here is the change. That period began {start:%b} {start.day}, "
                     "so the move starts on a past day. Preview it, then apply or discard it.",
                     [card])  # fmt: skip
    return card


def _b_milestone(c: Ctx, a: dict[str, Any]) -> Built:
    words = _need(a, "day")
    day = parse_day(words, c.today)
    if day is None:
        return Reply("question", f"Which day is “{words}”?")
    e = c.find(_need(a, "item"))
    if isinstance(e, Reply):
        return e
    name = _unquote(_need(a, "name"))
    after = {"milestone": {"name": name, "date": day.isoformat(), "date_source": "typed"}}
    return _kw(f"Add the milestone “{name}” to {e.row.title} on {_day_words(day, True)}",
               "set_milestone", e, {"item_id": str(e.row.id)},
               {"milestone": e.row.milestone}, after,
               {"kind": "milestone", "item_id": str(e.row.id), "name": name,
                "date": day.isoformat()})  # fmt: skip


def _b_ask(c: Ctx, a: dict[str, Any]) -> Built:
    who = _unquote(a["from"]) if _arg(a, "from") else None
    title = _unquote(_need(a, "title"))
    ours = who is not None and any(
        who.lower() in (display_name(u.email, u.name).lower(),) for u in c.people
    )
    kind = "team" if ours else ("customer" if who else "unknown")
    channel = "meeting" if c.meeting is not None else "other"
    return _kw(f"New feature ask{f' from {who}' if who else ''}: {title}",
               "add_feature_ask", None, {}, {},
               {"title": title, "requester_name": who, "requester_kind": kind,
                "channel": channel})  # fmt: skip


def _b_launch(c: Ctx, a: dict[str, Any]) -> Built:
    e = c.find(_need(a, "item"))
    if isinstance(e, Reply):
        return e
    title = _unquote(_need(a, "title"))
    return _kw(f"Add the launch task “{title}” to {e.row.title}'s launch",
               "add_launch_task", e, {"item_id": str(e.row.id)}, {},
               {"title": title, "owner_id": None})  # fmt: skip


def _due(c: Ctx, a: dict[str, Any]) -> date | None | Reply:
    words = _arg(a, "due")
    if words is None:
        return None
    due = parse_day(words, c.today)
    return due if due is not None else Reply("question", f"Which day is “{words}”?")


def _b_task(c: Ctx, a: dict[str, Any]) -> Built:
    e = c.find(_need(a, "item"))
    if isinstance(e, Reply):
        return e
    owner = c.person(a["owner"]) if _arg(a, "owner") else None
    if isinstance(owner, Reply):
        return owner
    due = _due(c, a)
    if isinstance(due, Reply):
        return due
    title = _unquote(_need(a, "title"))
    words = (f" for {display_name(owner.email, owner.name)}" if owner else "") + (
        f" by {_day_words(due, True)}" if due else ""
    )
    return _kw(f"Add the task “{title}” to {e.row.title}{words}", "add_item_task", e,
               {"item_id": str(e.row.id)}, {},
               {"title": title, "owner_id": str(owner.id) if owner else None,
                "due_date": due.isoformat() if due else None})  # fmt: skip


def _b_action(c: Ctx, a: dict[str, Any]) -> Built:
    owner = c.person(_need(a, "owner"))
    if isinstance(owner, Reply):
        return owner
    e = c.find(a["item"]) if _arg(a, "item") else None
    if isinstance(e, Reply):
        return e
    due = _due(c, a)
    if isinstance(due, Reply):
        return due
    title = _need(a, "title")
    target: dict[str, Any] = {}
    if c.meeting is not None:
        target["meeting_id"] = str(c.meeting.meeting_id)
    if e is not None:
        target["item_id"] = str(e.row.id)
    words = (f" by {_day_words(due, True)}" if due else "") + (
        f" ({e.row.title})" if e is not None else ""
    )
    name = display_name(owner.email, owner.name)
    return _kw(f"Action item: {name} to {title}{words}", "add_action_item", e, target,
               {}, {"title": title, "owner_id": str(owner.id),
                    "due_date": due.isoformat() if due else None})  # fmt: skip


def _b_rename(c: Ctx, a: dict[str, Any]) -> Built:
    e = c.find(_need(a, "item"))
    if isinstance(e, Reply):
        return e
    title = _unquote(_need(a, "title"))
    return _kw(f"Rename {e.row.title} to “{title}”", "edit_title", e,
               {"item_id": str(e.row.id)}, {"title": e.row.title}, {"title": title},
               {"kind": "title", "item_id": str(e.row.id), "title": title})  # fmt: skip


def _b_cut(c: Ctx, a: dict[str, Any]) -> Built:
    e = c.find(_need(a, "item"))
    if isinstance(e, Reply):
        return e
    if e.row.cut:
        return Reply("note", f"{e.row.title} is cut already.")
    return _kw(f"Cut {e.row.title}", "cut", e, {"item_id": str(e.row.id)},
               {"cut": False}, {"cut": True},
               {"kind": "cut", "item_id": str(e.row.id)})  # fmt: skip


ITEM = "the roadmap item's id (or its exact title)"
for _op in (
    ChatOp("move_dates", "Move an item's dates: to a period or day, or by a shift",
           {"item": ITEM, "when": "the new start: a period (\"next quarter\", \"Q2 2027\", "
            "\"March\") or a day (\"March 3\", \"2027-03-03\")",
            "shift": "or move it by \"1 quarter\", \"2 months\", \"3 weeks\""}, _b_move),
    ChatOp("change_horizon", "Move an item to Now, Next or Later",
           {"item": ITEM, "horizon": "now, next or later"}, _b_horizon),
    ChatOp("set_milestone", "Set an item's milestone",
           {"item": ITEM, "name": "the milestone's name", "day": "its day"}, _b_milestone),
    ChatOp("add_feature_ask", "File a new feature ask",
           {"title": "what is asked for", "from": "who asked (optional)"}, _b_ask),
    ChatOp("add_launch_task", "Add a task to an item's launch",
           {"item": ITEM, "title": "the task"}, _b_launch),
    ChatOp("add_item_task", "Add a task under a roadmap item",
           {"item": ITEM, "title": "the task", "owner": "who does it (optional)",
            "due": "by which day (optional)"}, _b_task),
    ChatOp("add_action_item", "Record a meeting action item",
           {"owner": "who does it", "title": "what they do", "due": "by which day (optional)",
            "item": "the roadmap item it is about (optional)"}, _b_action),
    ChatOp("edit_title", "Rename an item", {"item": ITEM, "title": "the new title"}, _b_rename),
    ChatOp("cut", "Cut an item from the roadmap", {"item": ITEM}, _b_cut),
):  # fmt: skip
    register(_op)


# The joined actions' own apply (chat_actions.ACTIONS): op -> async (db, principal, card).
APPLIERS: dict[str, Callable[..., Any]] = {}


def join(actions: list[dict[str, Any]]) -> None:
    """chat-join: chat-actions' ACTIONS become ops the reader offers and parse() builds
    (through ChatOp.build), and chat.apply applies their cards through their own apply."""
    for a in actions:
        register(ChatOp(a["op"], a["describe"], dict(a["args"]), a["build"]))
        APPLIERS[a["op"]] = a["apply"]


def _count(n: int) -> str:
    words = {1: "one change", 2: "two changes", 3: "three changes"}
    return f"I understood {words.get(n, f'{n} changes')}:"


def build(c: Ctx, op: str, args: dict[str, Any], body: str | None = None) -> Reply:
    """One op's reply through its ChatOp.build: a card, a question (an ambiguous item gets
    its choices, "Neither" last), or a plain refusal (an unknown op, a bad arg)."""
    known = OPS.get(op)
    if known is None:
        return Reply("note", "I can't do that here.")
    if not isinstance(args, dict) or set(args) - set(known.args):
        return Reply("note", f"I can't do that here: {known.describe.lower()} takes "
                             f"{_or(list(known.args))}.")  # fmt: skip
    try:
        out = known.build(c, {k: v for k, v in args.items() if v is not None})
    except (KeyError, ValueError, TypeError) as e:
        return Reply("note", f"I can't do that here: {e}.")
    if isinstance(out, Reply):
        if out.candidates and "item" in known.args:
            out.choices = [
                {"label": x.row.title, "op": op, "args": {**args, "item": str(x.row.id)}}
                for x in out.candidates[:5]
            ] + [NEITHER]
        elif out.people:
            # An unknown or ambiguous person: the people the name may mean, as choices.
            key = next((k for k, v in args.items() if v == out.person_text), None)
            if key is not None:
                out.choices = [{"label": n, "op": op, "args": {**args, key: n}}
                               for n in out.people] + [NEITHER]  # fmt: skip
        return out
    return Reply("cards", body or HERE, [out])


def parse(c: Ctx, text: str) -> Reply:
    """Oracle's reply to one line (deterministic, the fast path). The plan's questions are
    answered from Oracle's data; change requests become cards; any other line is for
    Oracle's reader (``reader``)."""
    t = " ".join(text.split())
    viewer_in_meeting = c.meeting is not None and not has_role(c.principal.role, "commenter")

    def asked(x: str):
        # A question about something not on the roadmap is Ask's (the page, the company).
        e = c.find(x)
        if isinstance(e, Reply) and e.missing:
            e.understood = False
        return e

    if m := re.fullmatch(r"who (owns|decides)\s+(.+?)\??", t, re.I):
        e = asked(m[2])
        if isinstance(e, Reply):
            return e
        owns = m[1].lower() == "owns"
        return Reply("answer", _owner_words(c, e) if owns else _decider_words(c, e))
    if m := re.fullmatch(r"when is\s+(.+?)\??", t, re.I):
        e = asked(m[1])
        if isinstance(e, Reply):
            return e
        r = e.resolved
        est = " (estimated)" if r.undated else ""
        return Reply("answer", f"{e.row.title}: {_day_words(r.start.date)} – "
                               f"{_day_words(r.end.date, True)}{est}.")  # fmt: skip
    if m := re.fullmatch(r"(?:what is the )?status of\s+(.+?)\??", t, re.I):
        e = asked(m[1])
        if isinstance(e, Reply):
            return e
        return Reply("answer", f"{e.row.title} is {e.status.replace('_', ' ')} ({e.row.horizon}).")

    asks = _phrase(c, t) or _actions().phrase(t) or _talk().phrase(c, t)
    if asks is None:
        return Reply("question", f"I did not understand that. {EXAMPLES}", understood=False,
                     reader=True)  # fmt: skip
    if viewer_in_meeting:
        return Reply("note", VIEWER_NOTE)
    # The joined actions restate what was understood ("I understood one change:").
    out = build(c, *asks, body=_count(1) if asks[0] in APPLIERS else None)
    if out.missing and out.person_text is not None:
        # A person Oracle cannot find: asked at once, with the people the name may mean (the
        # Ask panel's one box sends the line to Oracle's Ask).
        out.understood = False
        return out
    if out.missing:
        # A phrase it knows naming no item ("move the alert thing to Q2"): the reader reads
        # the name in context.
        return Reply("question", out.body, understood=False, reader=True,
                     choices=out.choices)  # fmt: skip
    return out


def _decision_line(text: str) -> bool:
    """Whether parse() may build a decision card from this line (only then does a
    commenter's Ask line resolve who confirms their proposal)."""
    asks = _actions().phrase(" ".join(text.split()))
    return asks is not None and asks[0] == "record_decision"


def _phrase(c: Ctx, t: str) -> tuple[str, dict[str, Any]] | None:
    """The fixed phrases parse() knows: the op and its args, or None."""
    if m := re.fullmatch(r"move (.+) to (now|next|later)\.?", t, re.I):
        return "change_horizon", {"item": m[1], "horizon": m[2].lower()}
    if re.fullmatch(r"move (.+) to (.+?)\.?", t, re.I):
        # The item's name may hold " to ": try each split, the shortest time first.
        for at in reversed([x.start() for x in re.finditer(r" to ", t, re.I)]):
            what, when = t[5:at], re.sub(r"\.$", "", t[at + 4 :])
            if parse_period(when, c.today, c.plan_span) or (
                re.fullmatch(DAY, when, re.I) and parse_day(when, c.today)
            ):
                return "move_dates", {"item": what, "when": when}
    if m := re.fullmatch(rf"add (?:a )?milestone {QUOTE} to (.+) on {DAY}\.?", t, re.I):
        return "set_milestone", {"item": m[2], "name": m[1], "day": m[3]}
    if m := re.fullmatch(r"(?:new )?feature ask(?: from (.+?))?:\s*(.+)", t, re.I):
        return "add_feature_ask", {"title": m[2], "from": m[1]}
    if m := re.fullmatch(rf"add (?:a )?launch task {QUOTE} (?:to|for|on) (.+?)\.?", t, re.I):
        return "add_launch_task", {"item": m[2], "title": m[1]}
    if m := re.fullmatch(
        rf"add (?:a )?task {QUOTE} (?:to|under|on) (.+?)(?: for (.+?))?(?: by {DAY})?\.?", t, re.I
    ):
        return "add_item_task", {"item": m[2], "title": m[1], "owner": m[3], "due": m[4]}
    action_re = rf"action item:?\s*(.+?) to (.+?)(?: by {DAY})?(?: on (.+?))?\.?"
    if m := re.fullmatch(action_re, t, re.I):
        return "add_action_item", {"owner": m[1], "title": m[2], "due": m[3], "item": m[4]}
    if m := re.fullmatch(r"rename (.+) to (.+)", t, re.I):
        return "edit_title", {"item": m[1], "title": m[2]}
    if m := re.fullmatch(r"cut (.+?)\.?", t, re.I):
        return "cut", {"item": m[1]}
    return None


# --------------------------------------------------------------------------- meetings


async def rules_of(db: AsyncSession, meeting_id: uuid.UUID) -> Any:
    meetings = _module(MEETINGS)
    rules = await meetings.meeting_rules(db, meeting_id) if meetings is not None else None
    if rules is None:
        raise ChatError(404, "No such meeting")
    return rules


def _attends(principal: Any, rules: Any) -> bool:
    me = _me(principal)
    return me == rules.presenter_id or me in (rules.attendee_ids or [])


def meeting_bar(principal: Any, rules: Any) -> str | None:
    """Why the caller may not apply cards in this meeting (None: they may)."""
    me = _me(principal)
    if not has_role(principal.role, "commenter"):
        return "Viewers ask questions in the meeting chat"
    if rules.ended:
        return "The meeting has ended"
    if rules.change_mode == "presenter" and me != rules.presenter_id:
        return "Only the presenter applies changes in this meeting"
    if (
        rules.change_mode == "named"
        and me != rules.presenter_id
        and me not in (rules.change_people or [])
    ):
        return "Only the presenter and the people they named apply changes in this meeting"
    return None


async def set_mode(
    db: AsyncSession, principal: Any, meeting_id: uuid.UUID, mode: str, people: list[uuid.UUID]
) -> ChatRulesOut:
    """The presenter changes who may apply (D22a), through S8's meetings module."""
    rules = await rules_of(db, meeting_id)
    if _me(principal) != rules.presenter_id:
        raise ChatError(403, "Only the presenter sets who may apply changes")
    if mode == "named" and not people:
        raise ChatError(422, "change_people: one or two people")
    meetings = _module(MEETINGS)
    body = meetings.SimpleMeetingRulesIn(
        change_mode=mode, change_people=people if mode == "named" else []
    )
    try:
        await meetings.set_rules(db, principal, meeting_id, body)
    except getattr(meetings, "MeetingError", ()) as e:
        raise ChatError(e.status, e.detail) from e
    await db.commit()
    return await rules_out(db, principal, await rules_of(db, meeting_id))


async def rules_out(db: AsyncSession, principal: Any, rules: Any) -> ChatRulesOut:
    ids = {rules.presenter_id, *(rules.change_people or [])}
    names = await _names(db, ids)
    me = _me(principal)
    bar = meeting_bar(principal, rules)
    return ChatRulesOut(
        change_mode=rules.change_mode,
        change_people=[SimplePersonRef(id=i, name=names.get(i, "someone"))
                       for i in rules.change_people or []],
        presenter=SimplePersonRef(id=rules.presenter_id,
                                  name=names.get(rules.presenter_id, "someone")),
        is_presenter=me == rules.presenter_id, may_apply=bar is None,
        ask_only=not has_role(principal.role, "commenter"), ended=bool(rules.ended),
    )  # fmt: skip


# --------------------------------------------------------------------------- threads


async def _names(db: AsyncSession, ids: set[uuid.UUID]) -> dict[uuid.UUID, str]:
    ids = {i for i in ids if i}
    if not ids:
        return {}
    return {
        u.id: display_name(u.email, u.name)
        for u in await db.scalars(select(User).where(User.id.in_(ids)))
    }


def page_of(page: str | None) -> str:
    """The Simple page an Ask thread belongs to: its path without query, fragment or
    trailing slash; Home (``/simple``) for none or a path outside Simple."""
    path = (page or "").split("?")[0].split("#")[0].strip()
    path = "/" + "/".join(p for p in path.split("/") if p)
    return path if path == "/simple" or path.startswith("/simple/") else "/simple"


def _key(meeting_id: uuid.UUID | None, me: uuid.UUID, page: str | None = None) -> tuple[str, str]:
    """A meeting's one shared thread; else the person's Ask thread on one page (the walk:
    a thread per person and page, so a page shows only its own lines; the old per-person
    thread, ``/simple/ask/<me>``, stays readable but is no page's)."""
    path = f"/simple/meetings/{meeting_id}" if meeting_id else f"/simple/ask/{me}{page_of(page)}"
    return path, f"screen:{path}"


def page_of_thread(d: Discussion | None) -> str | None:
    """The page of a person's Ask thread (``/simple/ask/<me><page>``); None for a meeting's."""
    path = ((d.subject or {}) if d is not None else {}).get("path") or ""
    if not path.startswith("/simple/ask/"):
        return None
    rest = path[len("/simple/ask/") :]
    return rest[rest.find("/") :] if "/" in rest else None


def _own_chat(d: Discussion | None, me: uuid.UUID) -> bool:
    """Whether ``d`` is one of the person's own Ask chats on a Simple page (never a
    meeting's chat, never the old per-person thread)."""
    return d is not None and d.origin == "panel" and page_of_thread(d) is not None and (
        ((d.subject or {}).get("path") or "").startswith(f"/simple/ask/{me}/"))  # fmt: skip


async def own_chat(db: AsyncSession, principal: Any, chat_id: uuid.UUID) -> Discussion:
    """ask-fresh: the caller's own Ask chat ``chat_id``; 404 for anyone else's or a meeting's."""
    d = await db.get(Discussion, chat_id)
    if not _own_chat(d, _me(principal)):
        raise ChatError(404, "No such chat")
    assert d is not None
    return d


async def _thread(
    db: AsyncSession,
    principal: Any,
    meeting_id: uuid.UUID | None,
    create: bool,
    page: str | None = None,
    chat_id: uuid.UUID | None = None,
    new_chat: bool = False,
    general: bool = False,
) -> Discussion | None:
    """A meeting's thread; else the caller's Ask chat ``chat_id``; else, with ``new_chat``
    (ask-fresh: every time the Ask panel opens in Simple), a new chat about the page (none
    until its first line); else the page's first chat (the older one-thread-per-page). A
    new chat started under "General" stays General (Recent names it so)."""
    me = _me(principal)
    path, key = _key(meeting_id, me, page)
    if meeting_id is None and chat_id is not None:
        d: Discussion | None = await own_chat(db, principal, chat_id)
    elif meeting_id is None and new_chat:
        d = None
    else:
        d = await db.scalar(
            select(Discussion)
            .where(Discussion.subject_key == key, Discussion.origin == "panel")
            .order_by(Discussion.created_at)
            .limit(1)
        )
    if d is None and create:
        title = "Meeting chat" if meeting_id else "Ask Oracle: changes"
        subject = {"path": path, **({"general": True} if general and meeting_id is None else {})}
        d = Discussion(subject_kind="screen", subject=subject, subject_key=key,
                       title=title, visibility="private", author_only=meeting_id is None,
                       origin="panel", started_by=me)  # fmt: skip
        db.add(d)
        await db.flush()
    if d is not None and create:
        joined = await db.scalar(
            select(DiscussionParticipant.id).where(
                DiscussionParticipant.discussion_id == d.id, DiscussionParticipant.user_id == me
            )
        )
        if joined is None:
            db.add(DiscussionParticipant(discussion_id=d.id, user_id=me, added_via="posted"))
    return d


async def thread(
    db: AsyncSession,
    principal: Any,
    meeting_id: uuid.UUID | None = None,
    page: str | None = None,
    chat_id: uuid.UUID | None = None,
    new_chat: bool = False,
) -> ChatThreadOut:
    rules = None
    if meeting_id is not None:
        rules = await rules_of(db, meeting_id)
        if not _attends(principal, rules):
            raise ChatError(403, "Only the meeting's attendees use its chat")
    d = await _thread(db, principal, meeting_id, create=False, page=page, chat_id=chat_id,
                      new_chat=new_chat)  # fmt: skip
    messages: list[ChatMessageOut] = []
    if d is not None:
        msgs = list(
            await db.scalars(
                select(DiscussionMessage)
                .where(DiscussionMessage.discussion_id == d.id)
                .order_by(DiscussionMessage.created_at, DiscussionMessage.id)
            )
        )
        cards = list(
            await db.scalars(
                select(SimpleChatCard)
                .where(SimpleChatCard.discussion_id == d.id)
                .order_by(SimpleChatCard.created_at, SimpleChatCard.id)
            )
        )
        outs = await cards_out(db, principal, cards, rules)
        by_msg: dict[uuid.UUID, list[ChatCardOut]] = {}
        for c, o in zip(cards, outs, strict=True):
            by_msg.setdefault(c.message_id, []).append(o)  # type: ignore[arg-type]
        names = await _names(db, {m.author_id for m in msgs if m.author_id})
        reads = {r.message_id: r for r in await db.scalars(
            select(SimpleChatRead).where(SimpleChatRead.discussion_id == d.id))}  # fmt: skip
        jobs = await _job_states(db, [r.job_id for r in reads.values() if r.job_id])
        for m in msgs:
            person = m.author_kind == "person"
            r = reads.get(m.id)
            kind, body = "request" if person else (m.prompt or "note"), m.body
            if kind == "pending" and r is not None and jobs.get(r.job_id) in DEAD:  # type: ignore[arg-type]
                kind, body = "failed", COULD_NOT_READ
            choices = [ChatChoiceOut(index=i, label=c["label"])
                       for i, c in enumerate(r.choices or [])] if r is not None else []  # fmt: skip
            messages.append(ChatMessageOut(
                id=m.id, author_kind="person" if person else "oracle", author_id=m.author_id,
                author_name=names.get(m.author_id, "someone") if person else "Oracle",  # type: ignore[arg-type]
                body=body, at=m.created_at, kind=kind,  # type: ignore[arg-type]
                cards=by_msg.get(m.id, []), reply_to=m.reply_to, choices=choices,
                picked=r.picked if r is not None else None, retry=kind == "failed",
                source=_talk().source_label(m.citations),
            ))  # fmt: skip
    return ChatThreadOut(
        id=d.id if d is not None else None,
        meeting_id=meeting_id,
        messages=messages,
        rules=await rules_out(db, principal, rules) if rules is not None else None,
        ask_id=_ask_of(d),
    )


def _ask_of(d: Discussion | None) -> uuid.UUID | None:
    """The Oracle's Ask chat a Simple Ask chat handed its questions to (ask-fresh)."""
    ask = ((d.subject or {}) if d is not None else {}).get("ask")
    return uuid.UUID(ask) if ask else None


def _summary(d: Discussion, question: str | None = None) -> ChatSummaryOut:
    """A chat on Recent chats: named by its page, or "General" for one started under General,
    and by its first question."""
    page = page_of_thread(d) or "/simple"
    general = bool((d.subject or {}).get("general"))
    return ChatSummaryOut(id=d.id, page=page, page_name="General" if general else page_name(page),
                          last_at=d.last_message_at or d.created_at, ask_id=_ask_of(d),
                          general=general, question=question)  # fmt: skip


QUESTION_CHARS = 200


async def _questions(db: AsyncSession, chats: list[Discussion]) -> dict[uuid.UUID, str]:
    """Each chat's first question: the person's first line in it, else in the Oracle's Ask
    chat it handed it to (a chat whose first line went to Ask holds none of its own)."""
    asks = {d.id: a for d in chats if (a := _ask_of(d)) is not None}
    ids = [d.id for d in chats] + list(asks.values())
    if not ids:
        return {}
    M = aliased(DiscussionMessage)
    at = (
        select(func.min(DiscussionMessage.created_at))
        .where(
            DiscussionMessage.discussion_id == M.discussion_id,
            DiscussionMessage.author_kind == "person",
            DiscussionMessage.deleted_at.is_(None),
        )
        .scalar_subquery()
    )
    rows = await db.execute(
        select(M.discussion_id, M.body).where(
            M.discussion_id.in_(ids),
            M.author_kind == "person",
            M.deleted_at.is_(None),
            M.created_at == at,
        )
    )
    first = {i: " ".join(b.split())[:QUESTION_CHARS] for i, b in rows.all()}
    out: dict[uuid.UUID, str] = {}
    for d in chats:
        ask = asks.get(d.id)
        q = first.get(d.id) or (first.get(ask) if ask is not None else None)
        if q:
            out[d.id] = q
    return out


def page_name(page: str | None) -> str:
    """A Simple page's name as the panel says it (never its route): Home, Roadmap..."""
    from oracle.discussions.context import page_name as named

    return named(page_of(page))


async def recent(db: AsyncSession, principal: Any, limit: int = 10) -> list[ChatSummaryOut]:
    """ask-fresh: the caller's last Ask chats from any Simple page, newest first; meeting
    chats stay in their meeting (never listed)."""
    me = _me(principal)
    rows = await db.scalars(
        select(Discussion)
        .where(
            Discussion.origin == "panel",
            Discussion.started_by == me,
            Discussion.subject_key.startswith(f"screen:/simple/ask/{me}/"),
        )
        .order_by(Discussion.last_message_at.desc().nulls_last(), Discussion.created_at.desc())
        .limit(limit)
    )
    chats = [d for d in rows if _own_chat(d, me)]
    questions = await _questions(db, chats)
    return [_summary(d, questions.get(d.id)) for d in chats]


async def link_ask(
    db: AsyncSession, principal: Any, chat_id: uuid.UUID, ask_id: uuid.UUID
) -> ChatSummaryOut:
    """ask-fresh: the Oracle's Ask chat (the caller's own private panel chat) this Ask chat
    handed its questions to, so the chat reopened from Recent shows both."""
    d = await own_chat(db, principal, chat_id)
    ask = await db.get(Discussion, ask_id)
    if (ask is None or ask.origin != "panel" or ask.visibility != "private"
            or ask.started_by != _me(principal)):  # fmt: skip
        raise ChatError(404, "No such chat")
    d.subject = {**(d.subject or {}), "ask": str(ask_id)}
    await db.commit()
    return _summary(d, (await _questions(db, [d])).get(d.id))


async def post(
    db: AsyncSession,
    principal: Any,
    text: str,
    meeting_id: uuid.UUID | None = None,
    only_understood: bool = False,
    page: str | None = None,
    chat_id: uuid.UUID | None = None,
    new_chat: bool = False,
    general: bool = False,
) -> ChatThreadOut:
    """The person's line and Oracle's reply. parse() answers the lines it knows at once;
    any other line is for Oracle's reader: Oracle's line reads "Reading that…" while the
    ``chat_reader`` job runs (the thread refreshes until it completes). ``only_understood``
    (the Ask panel's one box): a question about something not on the roadmap writes
    nothing and answers ``understood=False``, for the panel to send it to Oracle's Ask."""
    rules = None
    if meeting_id is not None:
        rules = await rules_of(db, meeting_id)
        if not _attends(principal, rules):
            raise ChatError(403, "Only the meeting's attendees use its chat")
    elif chat_id is not None:
        page = page_of_thread(await own_chat(db, principal, chat_id))
    ctx = Ctx(db, principal, rules)
    ctx.page = page
    ctx.wants_decider = _decision_line(text)
    await ctx.load()
    reply = _talk().restate(ctx, parse(ctx, text))
    if ctx.item is not None and reply.kind == "answer":
        reply.citations = _talk().source_of(ctx, "roadmap")
    if only_understood and not reply.understood and not reply.reader:
        if meeting_id is None and chat_id is None and new_chat:
            # A new chat's first line goes to Oracle's Ask: the chat exists (empty) so the
            # panel links its Ask chat to it and Recent lists it (ask-fresh).
            d = await _thread(db, principal, None, create=True, page=page, new_chat=True,
                              general=general)  # fmt: skip
            assert d is not None
            d.last_message_at = datetime.now(UTC)
            await db.commit()
            chat_id, new_chat = d.id, False
        out = await thread(db, principal, meeting_id, page, chat_id, new_chat)
        out.understood = False
        return out
    if reply.reader:
        reply = Reply("pending", READING)
    asked, answer = await _write(db, principal, meeting_id, text.strip(), reply, page=page,
                                 chat_id=chat_id, new_chat=new_chat, general=general)  # fmt: skip
    if reply.kind == "pending":
        read = SimpleChatRead(discussion_id=answer.discussion_id, message_id=answer.id,
                              ask_id=asked.id, meeting_id=meeting_id, by=_me(principal),
                              line=text.strip(), page=page, ask_box=only_understood)  # fmt: skip
        db.add(read)
        await db.flush()
        await _enqueue_read(db, principal, read)
    await db.commit()
    return await _out(db, principal, meeting_id, page, answer.discussion_id)


async def _out(
    db: AsyncSession,
    principal: Any,
    meeting_id: uuid.UUID | None,
    page: str | None,
    discussion_id: uuid.UUID,
) -> ChatThreadOut:
    """The thread a line was written to: a meeting's, else that Ask chat (ask-fresh: one of
    the person's chats, not only the page's first)."""
    if meeting_id is not None:
        return await thread(db, principal, meeting_id, page)
    return await thread(db, principal, None, page, chat_id=discussion_id)


async def _write(
    db: AsyncSession,
    principal: Any,
    meeting_id: uuid.UUID | None,
    line: str,
    reply: Reply,
    page: str | None = None,
    chat_id: uuid.UUID | None = None,
    new_chat: bool = False,
    general: bool = False,
) -> tuple[DiscussionMessage, DiscussionMessage]:
    """The person's line and Oracle's reply with its cards (and choices); the caller
    commits."""
    me = _me(principal)
    d = await _thread(db, principal, meeting_id, create=True, page=page, chat_id=chat_id,
                      new_chat=new_chat, general=general)  # fmt: skip
    assert d is not None
    # Real time orders the lines (the company clock may stand still in tests).
    at = datetime.now(UTC)
    asked = DiscussionMessage(discussion_id=d.id, author_kind="person", author_id=me,
                              body=line, status="complete", created_at=at)  # fmt: skip
    answer = DiscussionMessage(discussion_id=d.id, author_kind="oracle", body=reply.body,
                               status="pending" if reply.kind == "pending" else "complete",
                               reply_to=None, model=ENGINE, prompt=reply.kind,
                               citations=reply.citations,
                               created_at=at + timedelta(microseconds=1))  # fmt: skip
    db.add_all([asked, answer])
    d.last_message_at = at
    await db.flush()
    answer.reply_to = asked.id
    await _attach(db, principal, answer, meeting_id, reply)
    if reply.choices:
        db.add(SimpleChatRead(discussion_id=d.id, message_id=answer.id, ask_id=asked.id,
                              meeting_id=meeting_id, by=me, line=line,
                              choices=_jsonable(reply.choices)))  # fmt: skip
    return asked, answer


def _jsonable(choices: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{"label": str(c["label"]), "op": c.get("op"),
             "args": {k: v if v is None else str(v) for k, v in (c.get("args") or {}).items()}}
            for c in choices]  # fmt: skip


async def _attach(
    db: AsyncSession,
    principal: Any,
    answer: DiscussionMessage,
    meeting_id: uuid.UUID | None,
    reply: Reply,
) -> None:
    """Oracle's cards on its line, in the order asked (real time orders them)."""
    at = datetime.now(UTC)
    for i, c in enumerate(reply.cards):
        card = SimpleChatCard(discussion_id=answer.discussion_id, message_id=answer.id,
                              meeting_id=meeting_id,
                              owner_id=None if meeting_id else _me(principal), status="open",
                              created_at=at + timedelta(microseconds=i), **c)  # fmt: skip
        db.add(card)
        await db.flush()
        if card.op in FLOW_OPS:
            await _request_visual(db, principal, card)


# --------------------------------------------------------------------------- the reader


async def _job_states(db: AsyncSession, ids: list[uuid.UUID]) -> dict[uuid.UUID, str]:
    if not ids:
        return {}
    from oracle.jobs.models import LlmJob

    rows = await db.execute(select(LlmJob.id, LlmJob.status).where(LlmJob.id.in_(ids)))
    return {i: st for i, st in rows.all()}


async def _enqueue_read(db: AsyncSession, principal: Any, read: SimpleChatRead) -> None:
    from oracle.jobs.models import LlmJob

    job = LlmJob(kind=READER_JOB, status="queued", input={"read_id": str(read.id)},
                 requested_by=_me(principal), attempts=0)  # fmt: skip
    db.add(job)
    await db.flush()
    read.job_id = job.id
    await audit.record(db, principal, "llm_job.queue", "llm_job", job.id,
                       {"kind": READER_JOB, "read_id": str(read.id)})  # fmt: skip


async def _payload(c: Ctx, read: SimpleChatRead) -> dict[str, Any]:
    db = c.db
    assert c.read is not None
    prior = list(
        await db.scalars(
            select(DiscussionMessage)
            .where(DiscussionMessage.discussion_id == read.discussion_id,
                   DiscussionMessage.created_at < (
                       select(DiscussionMessage.created_at)
                       .where(DiscussionMessage.id == read.ask_id).scalar_subquery()))
            .order_by(DiscussionMessage.created_at.desc(), DiscussionMessage.id.desc())
            .limit(10)
        )
    )  # fmt: skip
    names = {u.id: display_name(u.email, u.name) for u in c.people}
    context: dict[str, Any] = {"role": c.principal.role}
    if c.meeting is not None:
        r = c.meeting
        context["meeting"] = {
            "presenter": names.get(r.presenter_id),
            "attendees": [names.get(i) for i in (r.attendee_ids or []) if i in names],
            "change_mode": r.change_mode,
        }
        meetings = _module(MEETINGS)
        try:
            # A savepoint: a failing read of the agenda leaves the job's transaction usable.
            async with db.begin_nested():
                one_ = await meetings.one(db, c.principal, r.meeting_id) if meetings else None
        except Exception:  # noqa: BLE001 -- the agenda is context, never required
            one_ = None
        if one_ is not None:
            context["meeting"]["title"] = getattr(one_, "title", None)
            # The open decisions as S8 lists them (newest first): context, not an order.
            context["meeting"]["open_decisions"] = [
                f"D-{x.number} {x.title}" if getattr(x, "number", None) else str(x.title)
                for x in getattr(one_, "open_decisions", []) or []
            ][:20]
            # The agenda the meeting keeps (chat-actions' "take X next" / "skip X").
            agenda = getattr(one_, "agenda", None)
            nxt = getattr(getattr(agenda, "next", None), "title", None)
            context["meeting"]["agenda"] = {
                "next": nxt,
                "skipped": [x.title for x in getattr(agenda, "skipped", None) or []],
            }
            prd = getattr(one_, "prd", None)
            context["meeting"]["prd"] = getattr(prd, "title", None)
            # Under discussion: the item the meeting takes next while it is still in the plan
            # (a decision about it clears it from the agenda), else the PRD under review
            # (never the newest open decision).
            nid = str(getattr(getattr(agenda, "next", None), "id", ""))
            live = any(str(e.row.id) == nid and not e.row.cut for e in c.entries())
            context["meeting"]["under_discussion"] = (nxt if live else None) or getattr(
                prd, "title", None
            )
    else:
        context["page"] = read.page
        if c.item is not None:
            # roadmap-talk: the item's own talk ("it" is this item).
            context["item"] = _talk().item_context(c)
    items = []
    for e in c.entries()[:200]:
        r_ = e.resolved
        deciders = service.decider_ids(e, c.read.deciders)
        items.append({
            "id": str(e.row.id), "key": e.row.item_key, "code": e.code, "title": e.row.title,
            "start": r_.start.date.isoformat(), "end": r_.end.date.isoformat(),
            "estimated": r_.undated, "milestone": (e.milestone.name if e.milestone else None),
            "owner": e.owner_name, "decider": _or([names[i] for i in deciders if i in names])
            if deciders else None, "track": e.track.title if e.track else None,
            "horizon": e.row.horizon, "cut": e.row.cut,
        })  # fmt: skip
    return {
        "line": read.line,
        "thread": [
            {
                "who": "Oracle" if m.author_kind != "person" else names.get(m.author_id, "someone"),
                "text": m.body[:500],
            }  # type: ignore[arg-type]
            for m in reversed(prior)
        ],  # fmt: skip
        "context": context,
        "items": items,
        "people": [{"name": display_name(u.email, u.name), "email": u.email} for u in c.people],
        "goals": [g.title for g in c.talk_goals],
        "milestones": [n for n, _ in _talk().milestones(c).values()],
        "today": c.today.isoformat(),
        "ops": [{"op": o.op, "describe": o.describe, "args": o.args} for o in OPS.values()],
    }


def _grounded(c: Ctx, said: str) -> bool:
    """Whether the reader's answer speaks of Oracle's data: it names an item (its title or
    key) or a person it was given; any other answer is not Oracle's to give."""
    t = said.lower()
    names = [e.row.title for e in c.entries()] + [e.row.item_key or "" for e in c.entries()]
    names += [display_name(u.email, u.name) for u in c.people]
    if c.item is not None:
        # roadmap-talk: in an item's talk ("it") the answer may name its milestone, goal or PRD.
        e = c.item
        names += [x for x in (getattr(e, "code", None), e.milestone.name if e.milestone else None,
                              e.goal.title if e.goal is not None else None,
                              e.prd.title if e.prd is not None else None) if x]  # fmt: skip
        if e.milestone is not None and e.milestone.name:
            names.append(e.milestone.name.split()[0])
    return any(len(n) >= 3 and n.lower() in t for n in names)


def interpret(c: Ctx, answer: Any, ask_box: bool = False) -> Reply:
    """The reader's answer, validated: every action through ChatOp.build (an unknown op, a
    bad arg or an item the caller cannot read is a plain refusal, never a card); a clarify
    question keeps only the choices that build; an answer is Oracle's data only."""
    if not isinstance(answer, dict):
        return Reply("note", f"I could not tell what to change. {SAY_AGAIN}")
    actions = answer.get("actions") or []
    clarify = answer.get("clarify")
    said = answer.get("answer")
    viewer_in_meeting = c.meeting is not None and not has_role(c.principal.role, "commenter")
    if isinstance(actions, list) and actions:
        if viewer_in_meeting:
            return Reply("note", VIEWER_NOTE)
        cards: list[dict[str, Any]] = []
        refused: list[str] = []
        for a in actions[:5]:
            if not isinstance(a, dict):
                refused.append(f"I could not tell what to change. {SAY_AGAIN}")
                continue
            r = build(c, str(a.get("op")), a.get("args") or {})
            if r.kind != "cards":
                if r.choices:
                    # An action naming an item that matches several: ask which.
                    return Reply("question", "Which item?" if r.candidates else "Who do you mean?",
                                 choices=r.choices)  # fmt: skip
                if r.kind == "question" and (not r.missing or r.person_text is not None):
                    # An unknown person, a day it cannot read: ask (the next line answers).
                    return Reply("question", r.body)
                refused.append(r.body if r.kind == "note" else f"I can't do that: {r.body}")
                continue
            cards += r.cards
        if not cards:
            return Reply("note", refused[0])
        if refused:
            # The valid cards stay; the line says which one it cannot do.
            why = (
                refused[0].removeprefix("I can't do that here: ").removeprefix("I can't do that: ")
            )
            return Reply("cards", f"One I can't do: {why} {_count(len(cards))}", cards)
        return Reply("cards", _count(len(cards)), cards)
    if isinstance(clarify, dict) and clarify.get("choices"):
        if viewer_in_meeting:
            return Reply("note", VIEWER_NOTE)
        built: list[tuple[dict[str, Any], dict[str, Any]]] = []
        for ch in clarify["choices"][:5]:
            if not isinstance(ch, dict) or not ch.get("op"):
                continue
            r = build(c, str(ch["op"]), ch.get("args") or {})
            if r.kind == "cards":
                built.append((ch, r.cards[0]))
        # A choice's label (the person's line when picked) is Oracle's words, never the
        # model's: the item's title when each choice is another item, else the card's
        # restatement.
        titles = {str(e.row.id): e.row.title for e in c.entries()}
        items = [str(card.get("item_id")) for _, card in built]
        by_item = len(set(items)) == len(items) and all(i in titles for i in items)
        choices = [{"label": titles[i] if by_item else card["summary"], "op": ch["op"],
                    "args": ch.get("args") or {}}
                   for i, (ch, card) in zip(items, built, strict=True)]  # fmt: skip
        if not choices:
            return Reply("note", f"I could not tell what to change. {SAY_AGAIN}")
        question = str(clarify.get("question") or "Which one?")[:200]
        return Reply("question", question, choices=[*choices, NEITHER])
    if isinstance(said, str) and said.strip() and _grounded(c, said):
        return Reply("answer", said.strip()[:1500])
    if ask_box:
        return Reply("ask", "Asking Oracle…")
    return Reply("note", f"I could not tell what to change. {SAY_AGAIN}")


async def run_reader(s: AsyncSession, job: Any, ask: Any) -> dict[str, Any]:
    """The ``chat_reader`` job: one call with the line in its context; the validated
    answer becomes Oracle's line (cards, a question with choices, an answer or a refusal)."""
    from oracle.docs import visibility
    from oracle.jobs.kinds import JobInputError

    read_id = (job.input or {}).get("read_id")
    read = await s.get(SimpleChatRead, uuid.UUID(read_id)) if read_id else None
    if read is None:
        raise JobInputError("the chat line no longer exists")
    msg = await s.get(DiscussionMessage, read.message_id)
    if msg is None or msg.prompt != "pending":
        raise JobInputError("the chat line was answered already")
    principal = await drafts.principal_for(s, job.tenant_id, read.by)
    visibility.bind(s, principal)
    rules = await rules_of(s, read.meeting_id) if read.meeting_id is not None else None
    c = Ctx(s, principal, rules)
    c.page = read.page
    await c.load()
    answer = await ask(READER_JOB, await _payload(c, read))
    reply = _talk().restate(c, interpret(c, answer, read.ask_box))
    if (
        read.meeting_id is not None
        and reply.kind == "note"
        and read.line.rstrip().endswith("?")
        and reply.body == f"I could not tell what to change. {SAY_AGAIN}"
    ):
        reply = Reply("note", MEETING_ASK)
    msg.body, msg.prompt, msg.status = reply.body, reply.kind, "complete"
    if reply.kind == "answer" and isinstance(answer, dict):
        msg.citations = _talk().source_of(c, answer.get("source"))
    read.choices = _jsonable(reply.choices)
    await _attach(s, principal, msg, read.meeting_id, reply)
    await s.flush()
    return {"kind": reply.kind, "cards": len(reply.cards), "choices": len(reply.choices)}


async def _read_of(
    db: AsyncSession, principal: Any, message_id: uuid.UUID
) -> tuple[SimpleChatRead, Any]:
    read = await db.scalar(
        select(SimpleChatRead).where(SimpleChatRead.message_id == message_id).with_for_update()
    )
    if read is None:
        raise ChatError(404, "No such line")
    rules = None
    if read.meeting_id is not None:
        rules = await rules_of(db, read.meeting_id)
        if not _attends(principal, rules):
            raise ChatError(404, "No such line")
    elif read.by != _me(principal):
        raise ChatError(404, "No such line")
    return read, rules


async def retry(db: AsyncSession, principal: Any, message_id: uuid.UUID) -> ChatThreadOut:
    """A failed or cancelled read is read again (a new ``chat_reader`` job)."""
    read, _ = await _read_of(db, principal, message_id)
    msg = await db.get(DiscussionMessage, read.message_id)
    assert msg is not None
    states = await _job_states(db, [read.job_id] if read.job_id else [])
    if msg.prompt != "pending" or states.get(read.job_id) not in DEAD:  # type: ignore[arg-type]
        raise ChatError(409, "Only a line Oracle could not read is read again")
    msg.body = READING
    await _enqueue_read(db, principal, read)
    await db.commit()
    return await _out(db, principal, read.meeting_id, read.page, read.discussion_id)


async def choose(
    db: AsyncSession, principal: Any, message_id: uuid.UUID, index: int
) -> ChatThreadOut:
    """A clicked choice: its label is the person's next line and Oracle's reply is the
    choice's card (no model call); "Neither" builds nothing."""
    read, rules = await _read_of(db, principal, message_id)
    if read.picked is not None:
        raise ChatError(409, "A choice was picked already")
    if not 0 <= index < len(read.choices or []):
        raise ChatError(422, "index: one of the question's choices")
    ch = read.choices[index]
    read.picked = index
    if ch.get("op") is None:
        reply = Reply("note", SAY_AGAIN)
    else:
        c = Ctx(db, principal, rules)
        c.wants_decider = ch.get("op") == "record_decision"
        await c.load()
        if rules is not None and not has_role(principal.role, "commenter"):
            reply = Reply("note", VIEWER_NOTE)
        else:
            reply = build(c, ch["op"], ch.get("args") or {}, _count(1))
            if reply.kind != "cards":
                reply = Reply("note", reply.body)
    chat_id = read.discussion_id if read.meeting_id is None else None
    await _write(db, principal, read.meeting_id, ch["label"], reply, page=read.page,
                 chat_id=chat_id)  # fmt: skip
    await db.commit()
    return await _out(db, principal, read.meeting_id, read.page, read.discussion_id)


async def apply_all(
    db: AsyncSession, principal: Any, message_id: uuid.UUID, one_commit: Any
) -> tuple[ChatThreadOut, list[uuid.UUID], ChatStopOut | None]:
    """Apply a reply's open cards in order; stop at the first that cannot apply (the rest
    stay open) and say which and why. ``one_commit``: the route's commit of one card's
    change with its meeting decision (changes_router._one_commit)."""
    msg = await db.get(DiscussionMessage, message_id)
    if msg is None:
        raise ChatError(404, "No such line")
    # The Ask thread's page (a thread per person and page), read before the rollback below.
    page = page_of_thread(await db.get(Discussion, msg.discussion_id))
    discussion_id = msg.discussion_id
    cards = list(
        await db.scalars(
            select(SimpleChatCard)
            .where(SimpleChatCard.message_id == message_id, SimpleChatCard.status == "open")
            .order_by(SimpleChatCard.created_at, SimpleChatCard.id)
        )
    )
    if not cards:
        raise ChatError(409, "No open cards on this line")
    todo = [(c.id, c.summary) for c in cards]
    _, rules = await _get(db, principal, todo[0][0])
    meeting_id = rules.meeting_id if rules is not None else None
    await db.rollback()
    applied: list[uuid.UUID] = []
    stopped: ChatStopOut | None = None
    for card_id, summary in todo:
        try:
            async with one_commit(db):
                await apply(db, principal, card_id)
        except (ChatError, ChangeError) as e:
            await db.rollback()
            stopped = ChatStopOut(card_id=card_id, summary=summary, reason=str(e.detail))
            break
        applied.append(card_id)
    return await _out(db, principal, meeting_id, page, discussion_id), applied, stopped


# --------------------------------------------------------------------------- cards


async def _request_visual(db: AsyncSession, principal: Any, card: SimpleChatCard) -> None:
    visuals = _module(VISUALS)
    if visuals is None:
        return
    if await visuals.flow_for(db, "chat_card", card.id) is None:
        await visuals.request_visual(db, principal, "chat_card", card.id, card.summary)


async def _flow(db: AsyncSession, card: SimpleChatCard) -> Any:
    visuals = _module(VISUALS)
    if visuals is None or card.op not in FLOW_OPS:
        return None
    return await visuals.flow_for(db, "chat_card", card.id)


def _decides(principal: Any, card: SimpleChatCard, read_: service.Read) -> bool:
    """Whether the caller's Apply applies (else proposes): the change engine's rule."""
    if card.op == "record_decision" and not card.target.get("meeting_id"):
        # On the Ask panel a commenter's decision is a proposal (the owner's pick).
        return not _actions().proposes(principal)
    if card.op == "add_feature_ask" or card.op in _actions().DIRECT_OPS:
        return True
    if card.item_id is None:
        return has_role(principal.role, "owner")
    e = read_.by_id().get(card.item_id)
    return e is not None and service.can_decide(principal, e, read_.deciders)


async def _adds_directly(
    db: AsyncSession, principal: Any, card: SimpleChatCard, read_: service.Read
) -> bool:
    """roadmap-talk: whether an add_item card applies (else proposes): the engine's own rule
    (additions.create) on the roadmap the new item goes to."""
    from oracle.simple import additions

    where = (card.target or {}).get("where") or {}
    try:
        goal = (await additions._goal(db, where.get("value"))
                if where.get("kind") == "goal" else None)  # fmt: skip
        doc = await additions._roadmap_for(db, principal, card.target.get("roadmap_id"), goal,
                                           read_)  # fmt: skip
    except ChangeError:
        return has_role(principal.role, "owner")
    return drafts.can_edit(principal, doc.id, await drafts.who(db, {doc.id}))


def _talk() -> Any:
    from oracle.simple import roadmap_talk

    return roadmap_talk


def _actions() -> Any:
    from oracle.simple import chat_actions

    return chat_actions


def _card_bar(principal: Any, card: SimpleChatCard, rules: Any) -> str | None:
    if card.op in _actions().DIRECT_OPS:
        return _actions().bar(principal, card, rules)
    if rules is not None:
        return meeting_bar(principal, rules)
    if not has_role(principal.role, "commenter"):
        return "Viewers read the plan; they don't change it"
    if card.owner_id is not None and card.owner_id != _me(principal):
        return "This card is someone else's"
    return None


def _flags_out(flags: list[Any]) -> list[SimpleFlag]:
    return [
        SimpleFlag(
            kind=f.kind,
            reason=f.reason,
            fixes=f.fixes,
            state=f.state,
            subject=f.subject,
            risk_note=f.risk_note,
        )  # fmt: skip
        for f in flags
    ]


def _as_if(card: SimpleChatCard, read_: service.Read, overlays: dict) -> dict:
    """The reader's overlays with the card's item fields applied (the constraint check)."""
    if card.op not in CARD_OPS_ON_ITEMS or card.item_id is None:
        return overlays
    e = read_.by_id().get(card.item_id)
    if e is None:
        return overlays
    out = {k: {**v} for k, v in overlays.items()}
    doc = out.setdefault(e.roadmap.id, {})
    fields = {**doc.get(str(e.row.id), drafts.snapshot(e.row))}
    fields.update(card.after)
    doc[str(e.row.id)] = fields
    return out


def _fixes(e: service.Entry, by_id: dict[uuid.UUID, service.Entry]) -> list[ChatFix]:
    """One-click fixes of the item's red dependency flags: move the dependents, move the
    dependency, or accept as a risk (D14)."""
    out: list[ChatFix] = []
    for f in e.flags:
        if f.state != "red" or f.kind != "dependency_order" or not f.subject:
            continue
        dep = by_id.get(uuid.UUID(f.subject))
        if dep is None:
            continue
        before = {str(x.row.id): _dates(x) for x in (e, dep)}
        target = {"item_id": str(e.row.id), "subject": f.subject}
        out += [
            ChatFix(label=f"Start {e.row.title} after {dep.row.title} ends",
                    op="shift_dependents", target=target, before=before),
            ChatFix(label=f"End {dep.row.title} before {e.row.title} starts",
                    op="move_dependency", target=target, before=before),
            ChatFix(label="Accept as a risk", op="accept_risk",
                    target={"item_id": str(e.row.id), "flag": f.kind, "subject": f.subject},
                    before={"risk": None},
                    after={"risk": {"note": "Accepted in the chat"}}),
        ]  # fmt: skip
    return out


async def cards_out(
    db: AsyncSession, principal: Any, cards: list[SimpleChatCard], rules: Any = None
) -> list[ChatCardOut]:
    if not cards:
        return []
    overlays = await drafts.overlays_for(db, principal)
    read_ = await service.load(db, overlays)
    names = await _names(db, {c.decided_by for c in cards if c.decided_by})
    outs: list[ChatCardOut] = []
    for c in cards:
        e = read_.by_id().get(c.item_id) if c.item_id else None
        flags: list[SimpleItemFlags] = []
        fixes: list[ChatFix] = []
        if c.status == "open" and e is not None:
            after = (
                read_
                if c.op not in CARD_OPS_ON_ITEMS
                else await service.load(db, _as_if(c, read_, overlays))
            )
            by_id = after.by_id()
            ae = by_id.get(e.row.id)
            if ae is not None:
                flags = [
                    SimpleItemFlags(item_id=i, flags=_flags_out(by_id[i].flags))
                    for i in (ae.row.id, *ae.needed_by)
                    if i in by_id and by_id[i].flags
                ]
                fixes = [x for i in (ae.row.id, *ae.needed_by) if i in by_id
                         for x in _fixes(by_id[i], by_id)]  # fmt: skip
        change_words, correct = _talk().correct_out(c)
        may: str | None = None
        bar = None
        if c.status == "open":
            bar = _card_bar(principal, c, rules)
            if bar is None:
                decides = (await _adds_directly(db, principal, c, read_) if c.op == "add_item"
                           else _decides(principal, c, read_))  # fmt: skip
                may = "apply" if decides else "propose"
        outs.append(ChatCardOut(
            id=c.id, message_id=c.message_id, op=c.op, target=c.target,  # type: ignore[arg-type]
            before=c.before, after=c.after, summary=c.summary, item_id=c.item_id,
            item_title=e.row.title if e is not None else None, status=c.status,  # type: ignore[arg-type]
            may=may, why_not=bar, flags=flags, fixes=fixes, preview=c.preview,  # type: ignore[arg-type]
            flow=await _flow(db, c), change_id=c.change_id,
            decided_by_name=names.get(c.decided_by) if c.decided_by else None,  # type: ignore[arg-type]
            decided_at=c.decided_at, decision_id=c.decision_id, change_words=change_words,
            correct=correct if c.status == "open" else None,
        ))  # fmt: skip
    return outs


async def _get(db: AsyncSession, principal: Any, card_id: uuid.UUID) -> tuple[SimpleChatCard, Any]:
    card = await db.get(SimpleChatCard, card_id, with_for_update=True)
    if card is None:
        raise ChatError(404, "No such card")
    rules = None
    if card.meeting_id is not None:
        rules = await rules_of(db, card.meeting_id)
        if not _attends(principal, rules):
            raise ChatError(404, "No such card")
    elif card.owner_id is not None and card.owner_id != _me(principal):
        raise ChatError(404, "No such card")
    return card, rules


async def one(db: AsyncSession, principal: Any, card: SimpleChatCard, rules: Any) -> ChatCardOut:
    return (await cards_out(db, principal, [card], rules))[0]


async def apply(
    db: AsyncSession,
    principal: Any,
    card_id: uuid.UUID,
    fix: int | None = None,
    values: dict[str, Any] | None = None,
) -> tuple[ChatCardOut, SimpleChangeResult]:
    """Apply a card (or one of its fixes) through the change engine with the caller's own
    rights; in a meeting an applied card is a meeting decision. ``values`` (roadmap-talk's
    Correct): the card is rebuilt from them first, so the corrected values apply."""
    me = _me(principal)
    card, rules = await _get(db, principal, card_id)
    bar = _card_bar(principal, card, rules)
    if bar is not None:
        raise ChatError(403, bar)
    if values:
        if fix is not None:
            raise ChatError(422, "A fix takes no corrections")
        await _talk().correct(db, principal, card, values)
        await db.flush()
    if card.op in _actions().DIRECT_OPS:
        return await _apply_direct(db, principal, card_id, rules, fix)
    if fix is not None:
        fixes = (await one(db, principal, card, rules)).fixes
        if fix >= len(fixes):
            raise ChatError(422, "fix: one of the card's fixes")
        f = fixes[fix]
        body = SimpleChangeIn(op=f.op, target=f.target, before=f.before, after=f.after)
    else:
        if card.status != "open":
            raise ChatError(409, f"This card is {card.status} already")
        body = SimpleChangeIn(op=card.op, target=card.target, before=card.before,  # type: ignore[arg-type]
                              after=card.after)  # fmt: skip
    # In a meeting the change goes into the meeting's session, whoever the mode lets apply
    # (S8's engine takes them; their own rights still decide): made in the meeting.
    body.session_id = getattr(rules, "session_id", None) if rules is not None else None

    async def make() -> SimpleChangeResult:
        # The card is taken in the change's own transaction (the engine commits both): two
        # Apply clicks at once make one change.
        if fix is None:
            c = await db.get(SimpleChatCard, card_id, with_for_update=True, populate_existing=True)
            if c is None or c.status != "open":
                raise ChatError(409, f"This card is {c.status if c else 'gone'} already")
            c.status = "applied"
            await db.flush()
        return await changes.create(db, principal, body)

    try:
        result = await make()
    except ChangeError as e:
        if body.session_id is None or e.status not in (404, 409):
            raise
        # The meeting's session is closed or not a change session: the presenter's own.
        await db.rollback()
        body.session_id = None
        result = await make()
    card = await db.get(SimpleChatCard, card_id, with_for_update=True, populate_existing=True)
    assert card is not None
    status = result.change.status
    if fix is None:
        card.status = "applied" if status == "applied" else "proposed"
        card.change_id, card.decided_by, card.decided_at = result.change.id, me, company_time.now()
        if card.op == "add_item" and status == "applied" and card.item_id is None:
            # roadmap-talk: the new item, so its bar flashes on the timeline.
            new = (result.change.target or {}).get("item_id")
            card.item_id = uuid.UUID(str(new)) if new else None
    if rules is not None and status == "applied":
        meetings = _module(MEETINGS)
        if meetings is not None:
            subjects = [{"kind": "roadmap_item", "id": str(card.item_id)}] if card.item_id else []
            title = f.label if fix is not None else card.summary
            try:
                card.decision_id = await meetings.record_meeting_decision(
                    db, principal, rules.meeting_id, title, subjects, [result.change.id]
                )
            except getattr(meetings, "MeetingError", ()) as e:
                raise ChatError(e.status, e.detail) from e
    await db.commit()
    return await one(db, principal, card, rules), result


async def _apply_direct(
    db: AsyncSession, principal: Any, card_id: uuid.UUID, rules: Any, fix: int | None
) -> tuple[ChatCardOut, SimpleChangeResult | None]:
    """chat-actions' ops: applied through the meetings module or Oracle's decisions (no
    change-engine change), in one transaction with the card."""
    if fix is not None:
        raise ChatError(422, "fix: one of the card's fixes")
    card = await db.get(SimpleChatCard, card_id, with_for_update=True, populate_existing=True)
    if card is None or card.status != "open":
        raise ChatError(409, f"This card is {card.status if card else 'gone'} already")
    await APPLIERS[card.op](db, principal, card)
    # An applier may leave the card proposed (a commenter's decision on the Ask panel).
    card.status = "proposed" if card.status == "proposed" else "applied"
    card.decided_by, card.decided_at = _me(principal), company_time.now()
    await db.commit()
    return await one(db, principal, card, rules), None


async def discard(db: AsyncSession, principal: Any, card_id: uuid.UUID) -> ChatCardOut:
    card, rules = await _get(db, principal, card_id)
    if card.status != "open":
        raise ChatError(409, f"This card is {card.status} already")
    if not has_role(principal.role, "commenter"):
        raise ChatError(403, "Viewers ask questions; they don't discard cards")
    # Those the change mode bars from applying may not discard either.
    bar = _card_bar(principal, card, rules)
    if bar is not None:
        raise ChatError(403, bar)
    card.status, card.decided_by, card.decided_at = "discarded", _me(principal), company_time.now()
    await db.commit()
    return await one(db, principal, card, rules)


async def undo(db: AsyncSession, principal: Any, card_id: uuid.UUID) -> ChatCardOut:
    card, rules = await _get(db, principal, card_id)
    if card.status == "applied" and card.op in _actions().DIRECT_OPS:
        await _actions().undo(db, principal, card, rules)
        card.status = "undone"
        await db.commit()
        return await one(db, principal, card, rules)
    if card.status != "applied" or card.change_id is None:
        raise ChatError(409, "Only an applied card undoes")
    await changes.undo(db, principal, card.change_id)
    card = await db.get(SimpleChatCard, card_id, with_for_update=True, populate_existing=True)
    assert card is not None
    card.status = "undone"
    if card.decision_id is not None:
        await _reverse(db, principal, card.decision_id)
    await db.commit()
    return await one(db, principal, card, rules)


async def _reverse(db: AsyncSession, principal: Any, decision_id: uuid.UUID,
                   note: str = "Undone in the meeting chat") -> None:  # fmt: skip
    """The card's decision no longer holds: reversed, with a review saying why (``note``),
    so the Decisions log and the minutes stop showing it as decided."""
    d = await db.get(Decision, decision_id, with_for_update=True)
    if d is None or d.status != "decided":
        return
    d.status = "reversed"
    db.add(DecisionReview(decision_id=d.id, verdict="reversed", note=note,
                          reviewed_by=_me(principal)))  # fmt: skip
    await db.flush()
    await audit.record(db, principal, "decision.review_reversed", "decision", d.id,
                       {"note": note, "revisit_id": None})  # fmt: skip


# --------------------------------------------------------------------------- the walk


async def _walk_card(db: AsyncSession, me: uuid.UUID, summary: str, fix: ChatFix,
                     e: service.Entry) -> SimpleChatCard:  # fmt: skip
    """The person's open walk card for this fix (reused), else a new one."""
    for c in await db.scalars(
        select(SimpleChatCard).where(
            SimpleChatCard.owner_id == me,
            SimpleChatCard.discussion_id.is_(None),
            SimpleChatCard.status == "open",
            SimpleChatCard.op == fix.op,
            SimpleChatCard.item_id == e.row.id,
        )
    ):
        if c.target == fix.target and c.before == fix.before:
            return c
    c = SimpleChatCard(owner_id=me, op=fix.op, target=fix.target, before=fix.before,
                       after=fix.after, summary=summary, item_id=e.row.id, status="open",
                       preview=None)  # fmt: skip
    db.add(c)
    await db.flush()
    return c


async def _next_agenda(db: AsyncSession, principal: Any) -> tuple[str, list[Any]]:
    """The next meeting the person attends (S8's live meetings, earliest first) and the open
    decisions on its agenda; none without one (or without S8's module)."""
    meetings = _module(MEETINGS)
    if meetings is None:
        return "", []
    live = (await meetings.listing(db, principal)).live
    for b in sorted(live, key=lambda b: b.started_at):
        rules = await meetings.meeting_rules(db, b.id)
        if rules is not None and not rules.ended and _attends(principal, rules):
            return b.title, list((await meetings.one(db, principal, b.id)).open_decisions)
    return "", []


async def walk(db: AsyncSession, principal: Any) -> WalkOut:
    """What waits for the person, one card at a time: the broken links they decide first,
    then the decisions on the next meeting's agenda, then the proposals waiting on them."""
    me = _me(principal)
    overlays = await drafts.overlays_for(db, principal)
    read_ = await service.load(db, overlays)
    by_id = read_.by_id()
    steps: list[WalkStepOut] = []
    cards: list[tuple[int, SimpleChatCard]] = []
    if has_role(principal.role, "commenter"):
        for e in sorted(read_.entries, key=lambda x: (x.roadmap.title, x.row.position)):
            if not service.can_decide(principal, e, read_.deciders):
                continue
            fixes = _fixes(e, by_id)
            for f in e.flags:
                if f.state != "red" or f.kind != "dependency_order" or not fixes:
                    continue
                dep = by_id.get(uuid.UUID(f.subject)) if f.subject else None
                what = dep.row.title if dep else "its dependency"
                title = f"{e.row.title} starts before {what} ends"
                card = await _walk_card(db, me, title, fixes[0], e)
                cards.append((len(steps), card))
                steps.append(WalkStepOut(id=f"link:{e.row.id}:{f.subject}", kind="broken_link",
                                         title=title, why=f.reason))  # fmt: skip
    meeting, agenda = await _next_agenda(db, principal)
    for d in agenda:
        steps.append(WalkStepOut(
            id=f"decision:{d.id}", kind="agenda_decision", title=d.title,
            why=f"On the agenda of {meeting}: read it before the meeting.",
            decision=WalkDecision(id=d.id, title=d.title, url=f"/simple/decisions?d={d.id}"),
        ))  # fmt: skip
    proposed = list(
        await db.scalars(
            select(SimpleChange)
            .where(SimpleChange.status == "proposed")
            .order_by(SimpleChange.at, SimpleChange.id)
        )
    )
    if proposed:
        view = await changes._view(db, principal, proposed)
        names = await changes._names(db, {c.by for c in proposed})
        for c in proposed:
            ours = targets.OPS
            mine = targets.may_decide(principal, c, view) if c.op in ours else view.may_decide(c)
            if c.by == me or not mine:
                continue
            out = changes._out(c, view, names)
            what = c.op.replace("_", " ")
            steps.append(WalkStepOut(id=f"change:{c.id}", kind="proposal",
                                     title=f"{out.by_name} proposes: {what}",
                                     why=c.reason or "Waiting on your decision",
                                     change=out))  # fmt: skip
    if cards:
        await db.commit()
        outs = await cards_out(db, principal, [c for _, c in cards])
        for (i, _), o in zip(cards, outs, strict=True):
            steps[i].card = o
    return WalkOut(steps=steps)


import oracle.simple.chat_actions  # noqa: E402, F401  (chat-join: registers its ACTIONS)
import oracle.simple.roadmap_talk  # noqa: E402, F401  (roadmap-talk: registers its actions)
