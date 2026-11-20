"""oracle.simple.chat's ops: reading a line into change cards (the op registry)."""

import difflib
import re
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.auth.models import User
from oracle.authz import has_role
from oracle.docs.models import Document, DocumentVersion
from oracle.errors import exception_text
from oracle.members.names import display_name
from oracle.roadmap.models import DraftRoadmap, ProductTrack, RoadmapItem
from oracle.roadmap.tracks import on_prd as tracks_on_prd
from oracle.simple import (
    changes,
    dates,
    drafts,
    service,
)
from oracle.simple.changes import ChangeError
from oracle.simple.chat_common import (
    DAY,
    EXAMPLES,
    HERE,
    HERE_PLAIN,
    MONTHS,
    NEITHER,
    QUOTE,
    VIEWER_NOTE,
    Reply,
    _actions,
    _api,
    _day_words,
    _me,
    _or,
    _talk,
    _unquote,
)


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


# The most of a meeting PRD's text the reader is given (its start; a PRD runs a few pages).
PRD_TEXT = 12000


@dataclass
class MeetingPrd:
    """meet-chat-right-prd: what a meeting's chat reads: the meeting's PRD (``number``: its
    version under review, else its newest) and its items: on its roadmap, or, while that
    version is not approved, on the version's draft roadmap (a run's items-only roadmap,
    that version's own when it is ready); ``text``: that version's markdown, or the PRD as
    the meeting's one-pager shows the asker (qa5-chat-working-draft: its working draft's
    edited sections, for whoever sees that draft; ``number`` then names the draft's base)."""

    document: Document
    number: int | None
    approved: bool
    draft: bool
    ids: set[uuid.UUID]
    text: str = ""

    def source(self) -> str:
        n = f" (draft {self.number})" if self.number else ""
        where = "its draft roadmap" if self.draft else "its roadmap"
        return f"From {self.document.title}{n} and {where}"


def _draft_entry(
    read: service.Read, prd: Document, row: RoadmapItem, effort: float | None = None
) -> service.Entry:
    """A draft-roadmap item as an entry: it has no roadmap, so its PRD stands in (its
    decider decides it); ``effort``: its feature's, in weeks (service.efforts)."""
    resolved, h = dates.resolve_by_dates(service._candidates(row, [], {}, {}), read.windows, effort)
    return service.Entry(
        row=row, roadmap=prd, prd=prd, track=None, goal=None, window=dates.board(read.windows)[h],
        resolved=resolved, horizon=h,
        status=service._status(row, [], set()), milestone=service._milestone(row, None, {}),
    )  # fmt: skip


async def shown_text(
    db: AsyncSession, principal: Any, prd: Document, saved: DocumentVersion | None
) -> tuple[str, int | None]:
    """qa5-chat-working-draft: the PRD's text as the meeting's one-pager shows it to
    ``principal`` (oracle.simple.one_pager.read), and the number of the version it is built
    on: with an open working draft they see, the draft's base with its edited sections
    (what submitting it imports), so an answer never contradicts the screen; else
    ``saved``'s, the version under review."""
    from oracle.docs.models import Section
    from oracle.simple import one_pager

    text = saved.markdown if saved is not None else ""
    number = saved.number if saved is not None else None
    d = await one_pager._open_draft(db, prd)
    patched = ((d.overlay or {}).get("sections") or {}) if d is not None else {}
    heads = ((d.overlay or {}).get("headings") or {}) if d is not None else {}
    if not (patched or heads) or d is None or d.base_version_id is None:
        return text, number
    if not one_pager.sees_draft(principal, d, await one_pager.who(db, prd)):
        return text, number
    base = await db.get(DocumentVersion, d.base_version_id)
    if base is None:
        return text, number
    secs = list(
        await db.scalars(
            select(Section).where(Section.version_id == base.id).order_by(Section.ordinal)
        )
    )
    try:
        return one_pager.patched_markdown(base, secs, patched, heads), base.number
    except ChangeError:
        # A section the patch cannot find in the markdown: its front matter and title, then
        # its sections as the one-pager lists them, each with its edited body.
        head = re.split(r"^## ", base.markdown, maxsplit=1, flags=re.M)[0].strip()
        body = "\n\n".join(
            f"## {heads.get(x.section_key, x.heading)}\n\n"
            f"{patched.get(x.section_key, x.body_md).strip()}"
            for x in secs
        )
        return "\n\n".join(p for p in (head, body) if p), base.number


async def meeting_prd(
    db: AsyncSession, read: service.Read, rules: Any, principal: Any = None
) -> MeetingPrd | None:
    """The meeting's PRD and its items, added to ``read`` when they are on a draft roadmap
    (None: no meeting, or a meeting module that names no PRD); ``principal`` given, its
    text is the PRD as the meeting shows them (:func:`shown_text`)."""
    from oracle.review.models import DocumentReviewPolicy
    from oracle.roadmap import draft_items

    prd_id = getattr(rules, "prd_document_id", None) if rules is not None else None
    prd = await db.get(Document, prd_id) if prd_id is not None else None
    if prd is None:
        return None
    newest = await db.scalar(
        select(DocumentVersion)
        .where(DocumentVersion.document_id == prd.id)
        .order_by(DocumentVersion.number.desc())
        .limit(1)
    )
    # The version under review is the newest; its number is named even when its own draft
    # roadmap is not ready yet and an older version's draft gives the items. A working draft
    # the asker sees names its base, the version its text is built on.
    number = newest.number if newest is not None else None
    text = newest.markdown if newest is not None else ""
    if principal is not None:
        text, number = await shown_text(db, principal, prd, newest)
    text = text[:PRD_TEXT]
    approved = newest is not None and newest.approved_at is not None
    on_roadmap = [e for e in read.entries if e.row.prd_document_id == prd.id
                  and e.row.draft_roadmap_id is None]  # fmt: skip
    got = None
    if newest is not None:
        own = await db.scalar(select(DraftRoadmap).where(
            DraftRoadmap.prd_version_id == newest.id, DraftRoadmap.status == "ready"))  # fmt: skip
        got = (own, await draft_items.draft_items(db, own)) if own is not None else None
    got = got or await draft_items.latest_ready(db, prd.id)
    if got is None or (approved and on_roadmap):
        return MeetingPrd(prd, number, approved, False, {e.row.id for e in on_roadmap}, text)
    _, rows = got
    known = read.by_id()
    effort = await service.efforts(db, [r for r in rows if r.id not in known])
    drafts_ = [known.get(r.id) or _draft_entry(read, prd, r, effort.get(r.id)) for r in rows]
    await service._prd_headings(db, [e for e in drafts_ if e.row.id not in known])
    read.entries += [e for e in drafts_ if e.row.id not in known]
    if prd.id not in read.deciders:
        read.deciders[prd.id] = await db.scalar(
            select(DocumentReviewPolicy.decider_id).where(
                DocumentReviewPolicy.document_id == prd.id
            )
        )
    keys = {e.row.item_key for e in drafts_}
    ids = {e.row.id for e in drafts_} | {e.row.id for e in on_roadmap if e.row.item_key not in keys}
    return MeetingPrd(prd, number, approved, True, ids, text)


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
        # item-talk-reads: the item's Ground Truth feature (None: it has none).
        self.item_feature: Any = None
        self.talk_goals: list[Any] = []
        # meet-chat-right-prd: a meeting's chat reads only the meeting's PRD.
        self.prd: MeetingPrd | None = None
        # ask-oracle-actions: the role whose reads are offered (a meeting's lowest).
        self.api_role: str | None = None

    async def load(self) -> "Ctx":
        from oracle.simple import chat_actions

        self.page_document = await chat_actions.page_document(self.db, self.page)
        self.overlays = await drafts.overlays_for(self.db, self.principal)
        self.read = await service.load(self.db, self.overlays)
        self.prd = await meeting_prd(self.db, self.read, self.meeting, self.principal)
        if self.prd is not None:
            # The plan's milestones of the meeting's PRD only (never another PRD's M1).
            tracks = set(await self.db.scalars(
                select(ProductTrack.id).where(tracks_on_prd(self.prd.document.id))
            ))  # fmt: skip
            self.read.milestones = [m for m in self.read.milestones if m.track_id in tracks]
        from oracle.simple import plan

        views = await plan.views(self.db, {e.prd.id for e in self.read.entries if e.prd})
        span = plan.current_span(list(views.values()), self.read.today)
        self.plan_span = (span.start, span.end) if span is not None else None
        self.people = list(await self.db.scalars(select(User).where(User.disabled_at.is_(None))))
        self.api_role = await _api().reach_role(self.db, self.principal, self.meeting)
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
        if self.prd is not None:
            return [e for e in self.read.entries if e.row.id in self.prd.ids]
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
    return Reply("cards", HERE if preview else HERE_PLAIN,
                 [_kw(summary, op, e, target, before, after, preview)])  # fmt: skip


def _dates(e: service.Entry) -> dict[str, Any]:
    return changes.read(e.row, changes.DATES, {})


def _current(e: service.Entry) -> dict[str, Any]:
    """walkc-meeting r2 (5b): the dates the item shows now and their source (``typed``,
    ``engineering``, ``estimated``, ...), for a move card's Before: an item dated by its
    engineering lead has no dates of its own, yet it is not Oracle's estimate."""
    r = e.resolved
    return {"start_date": r.start.date.isoformat(), "end_date": r.end.date.isoformat(),
            "source": r.source}  # fmt: skip


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
    return _kw(f"Move {_talk().label(e)} to {h.capitalize()}", "change_horizon", e,
               {"item_id": str(e.row.id)}, {"horizon": e.horizon}, {"horizon": h},
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
    card = _kw(f"Move {_talk().label(e)} to {_day_words(start)} – {_day_words(end, True)}",
               "move_dates", e, {"item_id": str(e.row.id)}, _dates(e),
               {"start_date": s, "end_date": en},
               {"kind": "dates", "item_id": str(e.row.id), "start_date": s,
                "end_date": en, "current": _current(e)})  # fmt: skip
    if by is not None:
        # A move by a span: offered again on newer dates, it moves from those (rebase).
        card["preview"]["shift"] = list(by)
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


def _task_item(c: Ctx, a: dict[str, Any]) -> dict[str, Any]:
    """walkc-meeting: "add a task 'X' to Exports for teams for Theo": an item's own name
    may hold " for ", so the longest name the roadmap knows takes the words before
    "for <person>" (none known: as parsed)."""
    owner = _arg(a, "owner")
    if not owner:
        return a
    parts = f"{_unquote(_need(a, 'item'))} for {owner}".split(" for ")
    titles = {e.row.title.lower() for e in c.entries()}
    for k in range(len(parts), 0, -1):
        if " for ".join(parts[:k]).lower() in titles:
            return {**a, "item": " for ".join(parts[:k]), "owner": " for ".join(parts[k:]) or None}
    return a


def _b_task(c: Ctx, a: dict[str, Any]) -> Built:
    a = _task_item(c, a)
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
        return Reply("note", f"I can't do that here: {exception_text(e)}.")
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
    return Reply("cards", body or (HERE if out.get("preview") else HERE_PLAIN), [out])


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
        return Reply("answer", f"{e.row.title} is {e.status.replace('_', ' ')} ({e.horizon}).")

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
