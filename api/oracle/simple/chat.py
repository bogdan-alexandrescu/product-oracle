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

import importlib
import re
import uuid
from datetime import UTC, date, datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, company_time
from oracle.auth.models import User
from oracle.authz import has_role
from oracle.decisions.models import Decision, DecisionReview
from oracle.discussions.models import Discussion, DiscussionMessage, DiscussionParticipant
from oracle.members.names import display_name
from oracle.simple import changes, drafts, service, targets
from oracle.simple.changes import ChangeError
from oracle.simple.models import SimpleChange, SimpleChatCard
from oracle.simple.schemas import (
    ChatCardOut,
    ChatFix,
    ChatMessageOut,
    ChatRulesOut,
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


def quarter(n: int, today: date) -> tuple[date, date]:
    """Qn: the next one on or after today's quarter."""
    current = (today.month - 1) // 3 + 1
    year = today.year if n >= current else today.year + 1
    start = date(year, 3 * (n - 1) + 1, 1)
    end = (date(year + 1, 1, 1) if n == 4 else date(year, 3 * n + 1, 1)) - timedelta(days=1)
    return start, end


# --------------------------------------------------------------------------- Oracle's reply


class Reply:
    def __init__(self, kind: str, body: str, cards: list[dict[str, Any]] | None = None) -> None:
        self.kind, self.body, self.cards = kind, body, cards or []


class Ctx:
    """What Oracle reads to answer one line: the plan as the asker sees it."""

    def __init__(self, db: AsyncSession, principal: Any, meeting: Any) -> None:
        self.db, self.principal, self.meeting = db, principal, meeting
        self.read: service.Read | None = None
        self.overlays: dict[uuid.UUID, dict[str, Any]] = {}
        self.people: list[User] = []

    async def load(self) -> "Ctx":
        self.overlays = await drafts.overlays_for(self.db, self.principal)
        self.read = await service.load(self.db, self.overlays)
        self.people = list(await self.db.scalars(select(User).where(User.disabled_at.is_(None))))
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
        es = self.entries()
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
            return Reply("question", f"Which one: {_or(titles)}?")
        missing = _unquote(text)
        return Reply("question", f"I could not find “{missing}” on the roadmap. Which item?")

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
            return Reply("question", f"Which {_unquote(text)}: "
                         f"{_or([display_name(u.email, u.name) for u in hits[:5]])}?")  # fmt: skip
        return Reply("question", f"Who is “{_unquote(text)}”? Name a person of the company.")


def _card(summary: str, op: str, e: service.Entry | None, target: dict, before: dict,
          after: dict, preview: dict | None = None) -> Reply:  # fmt: skip
    return Reply("cards", "Here is the change. Preview it, then apply or discard it.", [
        {"summary": summary, "op": op, "item_id": e.row.id if e is not None else None,
         "target": target, "before": before, "after": after, "preview": preview}
    ])  # fmt: skip


def _dates(e: service.Entry) -> dict[str, Any]:
    return changes.read(e.row, changes.DATES, {})


def _owner_words(c: Ctx, e: service.Entry) -> str:
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


def parse(c: Ctx, text: str) -> Reply:
    """Oracle's reply to one line (deterministic). The plan's questions are answered from
    Oracle's data; change requests become cards; anything else, one short question."""
    t = " ".join(text.split())
    viewer_in_meeting = c.meeting is not None and not has_role(c.principal.role, "commenter")

    def found(x: str):
        return c.find(x)

    if m := re.fullmatch(r"who (owns|decides)\s+(.+?)\??", t, re.I):
        e = found(m[2])
        if isinstance(e, Reply):
            return e
        owns = m[1].lower() == "owns"
        return Reply("answer", _owner_words(c, e) if owns else _decider_words(c, e))
    if m := re.fullmatch(r"when is\s+(.+?)\??", t, re.I):
        e = found(m[1])
        if isinstance(e, Reply):
            return e
        r = e.resolved
        est = " (estimated)" if r.undated else ""
        return Reply("answer", f"{e.row.title}: {_day_words(r.start.date)} – "
                               f"{_day_words(r.end.date, True)}{est}.")  # fmt: skip
    if m := re.fullmatch(r"(?:what is the )?status of\s+(.+?)\??", t, re.I):
        e = found(m[1])
        if isinstance(e, Reply):
            return e
        return Reply("answer", f"{e.row.title} is {e.status.replace('_', ' ')} ({e.row.horizon}).")

    def change(build) -> Reply:
        if viewer_in_meeting:
            return Reply("note", VIEWER_NOTE)
        return build()

    if m := re.fullmatch(r"move (.+) to (now|next|later)\.?", t, re.I):

        def horizon() -> Reply:
            e = found(m[1])
            if isinstance(e, Reply):
                return e
            h = m[2].lower()
            return _card(f"Move {e.row.title} to {h.capitalize()}", "change_horizon", e,
                         {"item_id": str(e.row.id)}, {"horizon": e.row.horizon}, {"horizon": h},
                         {"kind": "horizon", "item_id": str(e.row.id), "horizon": h})  # fmt: skip

        return change(horizon)
    q = re.fullmatch(r"move (.+) to q([1-4])(?: \d{4})?\.?", t, re.I)
    d = re.fullmatch(rf"move (.+) to {DAY}\.?", t, re.I)
    if q or (d and parse_day(d[2], c.today)):

        def move() -> Reply:
            e = found((q or d)[1])  # type: ignore[index]
            if isinstance(e, Reply):
                return e
            r = e.resolved
            length = (r.end.date - r.start.date).days
            if q:
                start, last = quarter(int(q[2]), c.today)
                end = last if r.undated else start + timedelta(days=length)
            else:
                start = parse_day(d[2], c.today)  # type: ignore[index,assignment]
                end = start + timedelta(days=29 if r.undated else length)
            s, en = start.isoformat(), end.isoformat()
            return _card(f"Move {e.row.title} to {_day_words(start)} – {_day_words(end, True)}",
                         "move_dates", e, {"item_id": str(e.row.id)}, _dates(e),
                         {"start_date": s, "end_date": en},
                         {"kind": "dates", "item_id": str(e.row.id), "start_date": s,
                          "end_date": en})  # fmt: skip

        return change(move)
    if m := re.fullmatch(rf"add (?:a )?milestone {QUOTE} to (.+) on {DAY}\.?", t, re.I):

        def milestone() -> Reply:
            day = parse_day(m[3], c.today)
            if day is None:
                return Reply("question", f"Which day is “{m[3]}”?")
            e = found(m[2])
            if isinstance(e, Reply):
                return e
            name = m[1].strip()
            after = {"milestone": {"name": name, "date": day.isoformat(), "date_source": "typed"}}
            return _card(f"Add the milestone “{name}” to {e.row.title} on {_day_words(day, True)}",
                         "set_milestone", e, {"item_id": str(e.row.id)},
                         {"milestone": e.row.milestone}, after,
                         {"kind": "milestone", "item_id": str(e.row.id), "name": name,
                          "date": day.isoformat()})  # fmt: skip

        return change(milestone)
    if m := re.fullmatch(r"(?:new )?feature ask(?: from (.+?))?:\s*(.+)", t, re.I):

        def ask() -> Reply:
            who = _unquote(m[1]) if m[1] else None
            title = _unquote(m[2])
            ours = who is not None and any(
                who.lower() in (display_name(u.email, u.name).lower(),) for u in c.people
            )
            kind = "team" if ours else ("customer" if who else "unknown")
            channel = "meeting" if c.meeting is not None else "other"
            return _card(f"New feature ask{f' from {who}' if who else ''}: {title}",
                         "add_feature_ask", None, {}, {},
                         {"title": title, "requester_name": who, "requester_kind": kind,
                          "channel": channel})  # fmt: skip

        return change(ask)
    if m := re.fullmatch(rf"add (?:a )?launch task {QUOTE} (?:to|for|on) (.+?)\.?", t, re.I):

        def launch() -> Reply:
            e = found(m[2])
            if isinstance(e, Reply):
                return e
            return _card(f"Add the launch task “{m[1]}” to {e.row.title}'s launch",
                         "add_launch_task", e, {"item_id": str(e.row.id)}, {},
                         {"title": m[1], "owner_id": None})  # fmt: skip

        return change(launch)
    if m := re.fullmatch(
        rf"add (?:a )?task {QUOTE} (?:to|under|on) (.+?)(?: for (.+?))?(?: by {DAY})?\.?", t, re.I
    ):

        def task() -> Reply:
            e = found(m[2])
            if isinstance(e, Reply):
                return e
            owner = c.person(m[3]) if m[3] else None
            if isinstance(owner, Reply):
                return owner
            due = parse_day(m[4], c.today) if m[4] else None
            words = (f" for {display_name(owner.email, owner.name)}" if owner else "") + (
                f" by {_day_words(due, True)}" if due else ""
            )
            return _card(f"Add the task “{m[1]}” to {e.row.title}{words}", "add_item_task", e,
                         {"item_id": str(e.row.id)}, {},
                         {"title": m[1], "owner_id": str(owner.id) if owner else None,
                          "due_date": due.isoformat() if due else None})  # fmt: skip

        return change(task)
    action_re = rf"action item:?\s*(.+?) to (.+?)(?: by {DAY})?(?: on (.+?))?\.?"
    if m := re.fullmatch(action_re, t, re.I):

        def action() -> Reply:
            owner = c.person(m[1])
            if isinstance(owner, Reply):
                return owner
            e = found(m[4]) if m[4] else None
            if isinstance(e, Reply):
                return e
            due = parse_day(m[3], c.today) if m[3] else None
            target: dict[str, Any] = {}
            if c.meeting is not None:
                target["meeting_id"] = str(c.meeting.meeting_id)
            if e is not None:
                target["item_id"] = str(e.row.id)
            words = (f" by {_day_words(due, True)}" if due else "") + (
                f" ({e.row.title})" if e is not None else ""
            )
            name = display_name(owner.email, owner.name)
            return _card(f"Action item: {name} to {m[2]}{words}", "add_action_item", e, target,
                         {}, {"title": m[2], "owner_id": str(owner.id),
                              "due_date": due.isoformat() if due else None})  # fmt: skip

        return change(action)
    if m := re.fullmatch(r"rename (.+) to (.+)", t, re.I):

        def rename() -> Reply:
            e = found(m[1])
            if isinstance(e, Reply):
                return e
            title = _unquote(m[2])
            return _card(f"Rename {e.row.title} to “{title}”", "edit_title", e,
                         {"item_id": str(e.row.id)}, {"title": e.row.title}, {"title": title},
                         {"kind": "title", "item_id": str(e.row.id), "title": title})  # fmt: skip

        return change(rename)
    if m := re.fullmatch(r"cut (.+?)\.?", t, re.I):

        def cut() -> Reply:
            e = found(m[1])
            if isinstance(e, Reply):
                return e
            if e.row.cut:
                return Reply("note", f"{e.row.title} is cut already.")
            return _card(f"Cut {e.row.title}", "cut", e, {"item_id": str(e.row.id)},
                         {"cut": False}, {"cut": True},
                         {"kind": "cut", "item_id": str(e.row.id)})  # fmt: skip

        return change(cut)
    return Reply("question", f"I did not understand that. {EXAMPLES}")


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


def _key(meeting_id: uuid.UUID | None, me: uuid.UUID) -> tuple[str, str]:
    path = f"/simple/meetings/{meeting_id}" if meeting_id else f"/simple/ask/{me}"
    return path, f"screen:{path}"


async def _thread(
    db: AsyncSession, principal: Any, meeting_id: uuid.UUID | None, create: bool
) -> Discussion | None:
    me = _me(principal)
    path, key = _key(meeting_id, me)
    d = await db.scalar(
        select(Discussion)
        .where(Discussion.subject_key == key, Discussion.origin == "panel")
        .order_by(Discussion.created_at)
        .limit(1)
    )
    if d is None and create:
        title = "Meeting chat" if meeting_id else "Ask Oracle: changes"
        d = Discussion(subject_kind="screen", subject={"path": path}, subject_key=key,
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
    db: AsyncSession, principal: Any, meeting_id: uuid.UUID | None = None
) -> ChatThreadOut:
    rules = None
    if meeting_id is not None:
        rules = await rules_of(db, meeting_id)
        if not _attends(principal, rules):
            raise ChatError(403, "Only the meeting's attendees use its chat")
    d = await _thread(db, principal, meeting_id, create=False)
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
        for m in msgs:
            person = m.author_kind == "person"
            messages.append(ChatMessageOut(
                id=m.id, author_kind="person" if person else "oracle", author_id=m.author_id,
                author_name=names.get(m.author_id, "someone") if person else "Oracle",  # type: ignore[arg-type]
                body=m.body, at=m.created_at, kind="request" if person else (m.prompt or "note"),  # type: ignore[arg-type]
                cards=by_msg.get(m.id, []),
            ))  # fmt: skip
    return ChatThreadOut(
        id=d.id if d is not None else None,
        meeting_id=meeting_id,
        messages=messages,
        rules=await rules_out(db, principal, rules) if rules is not None else None,
    )


async def post(
    db: AsyncSession, principal: Any, text: str, meeting_id: uuid.UUID | None = None
) -> ChatThreadOut:
    """The person's line and Oracle's reply, in one go."""
    me = _me(principal)
    rules = None
    if meeting_id is not None:
        rules = await rules_of(db, meeting_id)
        if not _attends(principal, rules):
            raise ChatError(403, "Only the meeting's attendees use its chat")
    ctx = await Ctx(db, principal, rules).load()
    reply = parse(ctx, text)
    d = await _thread(db, principal, meeting_id, create=True)
    assert d is not None
    # Real time orders the lines (the company clock may stand still in tests).
    at = datetime.now(UTC)
    asked = DiscussionMessage(discussion_id=d.id, author_kind="person", author_id=me,
                              body=text.strip(), status="complete", created_at=at)  # fmt: skip
    answer = DiscussionMessage(discussion_id=d.id, author_kind="oracle", body=reply.body,
                               status="complete", reply_to=None, model=ENGINE,
                               prompt=reply.kind,
                               created_at=at + timedelta(microseconds=1))  # fmt: skip
    db.add_all([asked, answer])
    d.last_message_at = at
    await db.flush()
    answer.reply_to = asked.id
    for c in reply.cards:
        card = SimpleChatCard(discussion_id=d.id, message_id=answer.id, meeting_id=meeting_id,
                              owner_id=None if meeting_id else me, status="open", **c)  # fmt: skip
        db.add(card)
        await db.flush()
        if card.op in FLOW_OPS:
            await _request_visual(db, principal, card)
    await db.commit()
    return await thread(db, principal, meeting_id)


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
    if card.op == "add_feature_ask":
        return True
    if card.item_id is None:
        return has_role(principal.role, "owner")
    e = read_.by_id().get(card.item_id)
    return e is not None and service.can_decide(principal, e, read_.deciders)


def _card_bar(principal: Any, card: SimpleChatCard, rules: Any) -> str | None:
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
        may: str | None = None
        bar = None
        if c.status == "open":
            bar = _card_bar(principal, c, rules)
            if bar is None:
                may = "apply" if _decides(principal, c, read_) else "propose"
        outs.append(ChatCardOut(
            id=c.id, message_id=c.message_id, op=c.op, target=c.target,  # type: ignore[arg-type]
            before=c.before, after=c.after, summary=c.summary, item_id=c.item_id,
            item_title=e.row.title if e is not None else None, status=c.status,  # type: ignore[arg-type]
            may=may, why_not=bar, flags=flags, fixes=fixes, preview=c.preview,  # type: ignore[arg-type]
            flow=await _flow(db, c), change_id=c.change_id,
            decided_by_name=names.get(c.decided_by) if c.decided_by else None,  # type: ignore[arg-type]
            decided_at=c.decided_at, decision_id=c.decision_id,
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
    db: AsyncSession, principal: Any, card_id: uuid.UUID, fix: int | None = None
) -> tuple[ChatCardOut, SimpleChangeResult]:
    """Apply a card (or one of its fixes) through the change engine with the caller's own
    rights; in a meeting an applied card is a meeting decision."""
    me = _me(principal)
    card, rules = await _get(db, principal, card_id)
    bar = _card_bar(principal, card, rules)
    if bar is not None:
        raise ChatError(403, bar)
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
    if rules is not None and status == "applied":
        meetings = _module(MEETINGS)
        if meetings is not None:
            subjects = [{"kind": "roadmap_item", "id": str(card.item_id)}] if card.item_id else []
            title = f.label if fix is not None else card.summary
            card.decision_id = await meetings.record_meeting_decision(
                db, principal, rules.meeting_id, title, subjects, [result.change.id]
            )
    await db.commit()
    return await one(db, principal, card, rules), result


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


async def _reverse(db: AsyncSession, principal: Any, decision_id: uuid.UUID) -> None:
    """The card's meeting decision no longer holds: reversed, with a review saying why, so
    the Decisions log and the minutes stop showing it as decided."""
    d = await db.get(Decision, decision_id, with_for_update=True)
    if d is None or d.status != "decided":
        return
    note = "Undone in the meeting chat"
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
