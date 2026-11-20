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
meeting's screen, keyed ``meeting_chat:<id>`` apart from Oracle's Ask panel on that page,
private to its attendees), and one per person for the Ask panel. The
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

import logging
import uuid
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
from oracle.roadmap.models import RoadmapItem
from oracle.simple import (
    agenda,
    card_order,
    change_words,
    changes,
    constraints,
    drafts,
    service,
    targets,
)
from oracle.simple.card_order import refuse_replaced, replaced_in
from oracle.simple.changes import ChangeError
from oracle.simple.chat_common import (  # noqa: F401
    CARD_OPS_ON_ITEMS,
    COULD_NOT_READ,
    DAY,
    DEAD,
    ENGINE,
    EXAMPLES,
    FLOW_OPS,
    HERE,
    HERE_PLAIN,
    KINDS,
    MEETING_ASK,
    MEETINGS,
    MONTHS,
    NEITHER,
    QUOTE,
    READER_JOB,
    READING,
    SAY_AGAIN,
    SPENT_UNTIL,
    UNCHECKED_OPS,
    VIEWER_NOTE,
    VISUALS,
    ChatError,
    Reply,
    _actions,
    _api,
    _attends,
    _day_words,
    _me,
    _module,
    _or,
    _shipped,
    _talk,
    _unquote,
    rules_of,
)
from oracle.simple.chat_ops import (  # noqa: F401
    APPLIERS,
    ITEM,
    OPS,
    PRD_TEXT,
    Built,
    ChatOp,
    Ctx,
    MeetingPrd,
    _add_months,
    _arg,
    _b_action,
    _b_ask,
    _b_cut,
    _b_horizon,
    _b_launch,
    _b_milestone,
    _b_move,
    _b_rename,
    _b_task,
    _card,
    _count,
    _current,
    _dates,
    _decider_words,
    _decision_line,
    _draft_entry,
    _due,
    _kw,
    _months,
    _need,
    _owner_words,
    _phrase,
    _task_item,
    build,
    join,
    meeting_prd,
    parse,
    parse_day,
    parse_period,
    parse_shift,
    quarter,
    register,
    shown_text,
)
from oracle.simple.chat_reader import (  # noqa: F401
    _ABOUT_IT,
    _ISO_DAY,
    _ITS_PLAN,
    _TOKEN,
    NOT_YET,
    _attach,
    _enqueue_read,
    _grounded,
    _job_rows,
    _jsonable,
    _keep_question,
    _linked,
    _live_of,
    _LiveRun,
    _no_change,
    _open_drafts,
    _payload,
    _read_of,
    _request_visual,
    _spent_until,
    _unread,
    _unused,
    _with_calls,
    interpret,
    plain,
    run_reader,
)
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
    SimpleItemFlags,
    SimplePersonRef,
    WalkDecision,
    WalkOut,
    WalkStepOut,
)

log = logging.getLogger(__name__)


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
    by_itself = bool(getattr(rules, "ended_by_itself", False))
    ended_by = getattr(rules, "ended_by", None) if rules.ended and not by_itself else None
    ids = {rules.presenter_id, *(rules.change_people or []), *([ended_by] if ended_by else [])}
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
        ended_at=getattr(rules, "ended_at", None) if rules.ended else None,
        ended_by=SimplePersonRef(id=ended_by, name=names.get(ended_by, "someone"))
        if ended_by else None,
        ended_by_itself=bool(rules.ended) and by_itself,
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


def meeting_key(meeting_id: Any) -> str:
    """A meeting chat's own subject key (meet-chat-own-key): never the meeting page's screen
    key, which Oracle's Ask panel on that page uses for its own discussion."""
    return f"meeting_chat:{meeting_id}"


def _key(meeting_id: uuid.UUID | None, me: uuid.UUID, page: str | None = None) -> tuple[str, str]:
    """A meeting's one shared thread (its subject the meeting's page, its key its own); else
    the person's Ask thread on one page (the walk: a thread per person and page, so a page
    shows only its own lines; the old per-person thread, ``/simple/ask/<me>``, stays readable
    but is no page's)."""
    if meeting_id:
        return f"/simple/meetings/{meeting_id}", meeting_key(meeting_id)
    path = f"/simple/ask/{me}{page_of(page)}"
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
        jobs = await _job_rows(db, [r.job_id for r in reads.values() if r.job_id])
        zone = await company_time.company_time_zone(db) if jobs else company_time.DEFAULT_ZONE
        for m in msgs:
            person = m.author_kind == "person"
            r = reads.get(m.id)
            kind, body = "request" if person else (m.prompt or "note"), m.body
            if kind not in KINDS:
                # Not a chat kind (a discussion reply left here before meet-chat-kind): its
                # body reads as an answer, so one stray line never takes the chat down.
                kind = "answer"
            job = jobs.get(r.job_id) if r is not None and r.job_id else None
            spent_until = None
            if kind == "pending" and job is not None and job.status in DEAD:
                kind, body = "failed", COULD_NOT_READ
                spent_until = _spent_until(job)
                if spent_until is not None:
                    body = SPENT_UNTIL.format(when=company_time.until_in_words(spent_until, zone))
            retry = kind == "failed" and spent_until is None
            choices = [ChatChoiceOut(index=i, label=c["label"])
                       for i, c in enumerate(r.choices or [])] if r is not None else []  # fmt: skip
            messages.append(ChatMessageOut(
                id=m.id, author_kind="person" if person else "oracle", author_id=m.author_id,
                author_name=names.get(m.author_id, "someone") if person else "Oracle",  # type: ignore[arg-type]
                body=body,
                at=(r.answered_at if r is not None and r.answered_at else m.created_at),
                kind=kind,  # type: ignore[arg-type]
                cards=by_msg.get(m.id, []), reply_to=m.reply_to, choices=choices,
                picked=r.picked if r is not None else None, retry=retry, retry_after=spent_until,
                source=_talk().source_label(m.citations),
                links=_talk().links_of(m.citations),
                live_reads=[x for x in m.citations or []
                            if isinstance(x, dict) and x.get("kind") == "live"],
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
    # chat-latest-card: a line answering the previous card to change it ("no, note: ...")
    # is that change, made a redo of the previous card's draft (card_order.redo_of).
    rest = card_order.redo_line(text)
    ctx.wants_decider = _decision_line(rest or text)
    await ctx.load()
    reply = parse(ctx, rest) if rest is not None else None
    redo = reply is not None and reply.kind == "cards"
    if not redo:
        ctx.wants_decider = _decision_line(text)
        reply = parse(ctx, text)
    reply = _talk().restate(ctx, reply)
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
                                 chat_id=chat_id, new_chat=new_chat, general=general,
                                 redo=redo)  # fmt: skip
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
    redo: bool = False,
) -> tuple[DiscussionMessage, DiscussionMessage]:
    """The person's line and Oracle's reply with its cards (and choices); the caller
    commits. ``redo``: the line asks to change the previous card's draft."""
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
    await _attach(db, principal, answer, meeting_id, reply, redo)
    if reply.choices:
        db.add(SimpleChatRead(discussion_id=d.id, message_id=answer.id, ask_id=asked.id,
                              meeting_id=meeting_id, by=me, line=line,
                              choices=_jsonable(reply.choices)))  # fmt: skip
    return asked, answer


async def retry(db: AsyncSession, principal: Any, message_id: uuid.UUID) -> ChatThreadOut:
    """A failed or cancelled read is read again (a new ``chat_reader`` job)."""
    read, _ = await _read_of(db, principal, message_id)
    msg = await db.get(DiscussionMessage, read.message_id)
    assert msg is not None
    jobs = await _job_rows(db, [read.job_id] if read.job_id else [])
    job = jobs.get(read.job_id) if read.job_id else None
    if msg.prompt != "pending" or job is None or job.status not in DEAD:
        raise ChatError(409, "Only a line Oracle could not read is read again")
    if _spent_until(job) is not None:
        raise ChatError(409, "Oracle's Claude accounts are used up; read it again once they clear")
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
            # ask-oracle-actions: an API action card is applied on its own, never in bulk.
            .where(
                SimpleChatCard.message_id == message_id,
                SimpleChatCard.status == "open",
                SimpleChatCard.op != _api().OP,
            )
            .order_by(SimpleChatCard.created_at, SimpleChatCard.id)
        )
    )
    # chat-latest-card: only the line's active cards; a newer card replaced the others.
    gone = await replaced_in(db, cards)
    cards = [c for c in cards if c.id not in gone]
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
            # dod-data: the engine's answer's words, not its raw detail (ids, raw dates);
            # a card whose item changed is offered again on the new state.
            why = e.detail.get("message") if isinstance(e.detail, dict) else e.detail
            stopped = ChatStopOut(card_id=card_id, summary=summary, reason=str(why))
            if isinstance(e, ChangeError) and e.status == 409:
                await rebase(db, card_id, e.detail)
            break
        applied.append(card_id)
    return await _out(db, principal, meeting_id, page, discussion_id), applied, stopped


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


def _undo_bar(principal: Any, card: SimpleChatCard, rules: Any, read_: service.Read) -> str | None:
    """qa4-simple-decide-1: why the caller may not undo an applied card (None: they may).
    The rule its Apply takes (the meeting's change mode, the viewer's bar); an engine card
    also needs the caller to decide its item, unless they applied it themselves."""
    bar = _card_bar(principal, card, rules)
    if bar is None and card.op == _api().OP and not (card.after or {}).get("undo"):
        return _api().CANNOT_UNDO
    if bar is not None or card.op in _actions().DIRECT_OPS or card.decided_by == _me(principal):
        return bar
    if not _decides(principal, card, read_):
        return "Only someone who may change this item undoes it"
    return None


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


def _flag_fixes(
    e: service.Entry, f: constraints.Flag, by_id: dict[uuid.UUID, service.Entry]
) -> list[ChatFix]:
    """One red flag's one-click fixes (constraints.FIXES): a dependency's move the
    dependents, move the dependency or accept as a risk (D14); the other kinds' accept as a
    risk; none for a draft without an owner."""
    risk = ChatFix(label="Accept as a risk", op="accept_risk",
                   target={"item_id": str(e.row.id), "flag": f.kind, "subject": f.subject},
                   before={"risk": None},
                   after={"risk": {"note": "Accepted in the chat"}})  # fmt: skip
    if f.kind != "dependency_order":
        return [risk] if "accept_risk" in f.fixes else []
    dep = by_id.get(uuid.UUID(f.subject)) if f.subject else None
    if dep is None:
        return []
    before = {str(x.row.id): _dates(x) for x in (e, dep)}
    target = {"item_id": str(e.row.id), "subject": f.subject}
    return [
        ChatFix(label=f"Start {e.row.title} after {dep.row.title} ends",
                op="shift_dependents", target=target, before=before),
        ChatFix(label=f"End {dep.row.title} before {e.row.title} starts",
                op="move_dependency", target=target, before=before),
        risk,
    ]  # fmt: skip


def broken_links(e: service.Entry) -> list[constraints.Flag]:
    """The item's broken links, as Home counts them (web/lib/simple-home.ts brokenLinks):
    its red flags that have a one-click fix (qa-simple-home-3: an end past its milestone too; a
    draft without an owner has none)."""
    return [f for f in e.flags if f.state == "red" and f.fixes]


def _fixes(e: service.Entry, by_id: dict[uuid.UUID, service.Entry]) -> list[ChatFix]:
    """One-click fixes of the item's red dependency flags: move the dependents, move the
    dependency, or accept as a risk (D14)."""
    return [x for f in e.flags if f.state == "red" and f.kind == "dependency_order"
            for x in _flag_fixes(e, f, by_id)]  # fmt: skip


async def _proposals(db: AsyncSession, cards: list[SimpleChatCard]) -> dict[uuid.UUID, Any]:
    """Each proposed card's change: who it went to (walkc-meeting: "Proposed to ...") and
    whether it was declined since (walkc-meeting r2: the card then says so)."""
    ids = {c.change_id for c in cards if c.status == "proposed" and c.change_id}
    if not ids:
        return {}
    rows = await db.scalars(select(SimpleChange).where(SimpleChange.id.in_(ids)))
    return {r.id: r for r in rows}


async def cards_out(
    db: AsyncSession, principal: Any, cards: list[SimpleChatCard], rules: Any = None
) -> list[ChatCardOut]:
    if not cards:
        return []
    overlays = await drafts.overlays_for(db, principal)
    # walkc-meeting: a meeting's cards are checked on the meeting's working state (the
    # changes applied in it), not only on the drafts the reader sees.
    if getattr(rules, "session_id", None) is not None:
        overlays = {**overlays, **await drafts.session_overlays(db, rules.session_id)}
    read_ = await service.load(db, overlays)
    # A meeting's cards may be on its PRD's draft-roadmap items (meet-chat-right-prd).
    await meeting_prd(db, read_, rules)
    proposals = await _proposals(db, cards)
    # chat-latest-card: a card a newer one in its chat replaced is no longer actionable.
    gone = await replaced_in(db, cards)
    routes = {i: list(r.routed_to or []) for i, r in proposals.items()}
    declined = {i: r for i, r in proposals.items() if r.status == "declined"}
    names = await _names(db, {c.decided_by for c in cards if c.decided_by}
                          | {i for ids in routes.values() for i in ids}
                          | {r.decided_by for r in declined.values() if r.decided_by})  # fmt: skip
    owners: list[uuid.UUID] | None = None
    # meeting-changes-only-its-agenda: an item the meeting does not review is only proposed
    # to its own decider, and the card says so.
    ag = await agenda.for_session(db, rules.session_id) if rules is not None else None
    outs: list[ChatCardOut] = []
    for c in cards:
        e = read_.by_id().get(c.item_id) if c.item_id else None
        off = ag is not None and e is not None and not ag.covers(e.row)
        flags: list[SimpleItemFlags] = []
        fixes: list[ChatFix] = []
        # fix5-cut-dependents: what "Cut it and its dependents" cuts with the item, as the
        # reader reads the roadmap now.
        waiting = (
            changes.dependents(e, read_.by_id())
            if c.status == "open" and c.op == "cut" and e is not None
            else []
        )
        if c.status == "open" and e is not None and c.op not in UNCHECKED_OPS:
            after = (
                read_
                if c.op not in CARD_OPS_ON_ITEMS
                else await service.load(db, _as_if(c, read_, overlays))
            )
            by_id = after.by_id()
            ae = by_id.get(e.row.id)
            if ae is not None:
                flags = [
                    SimpleItemFlags(
                        item_id=i,
                        flags=service.flags_out(
                            by_id[i],
                            lambda d, w=after.deciders: service.can_decide(principal, d, w),
                        ),
                    )
                    for i in (ae.row.id, *ae.needed_by)
                    if i in by_id and by_id[i].flags
                ]
                fixes = [x for i in (ae.row.id, *ae.needed_by) if i in by_id
                         for x in _fixes(by_id[i], by_id)]  # fmt: skip
        card_words, correct = _talk().correct_out(c)
        may: str | None = None
        may_all: str | None = None
        bar = None
        if c.status == "open":
            bar = _card_bar(principal, c, rules)
            if bar is None and e is not None and _on_draft(e):
                # A draft-roadmap item has no change engine: its decider applies, no proposal.
                if c.op not in DRAFT_ITEM_OPS:
                    bar = DRAFT_ITEM_WAITS
                elif not _decides(principal, c, read_):
                    bar = DRAFT_ITEM_BAR
                else:
                    may = "apply"
            elif bar is None:
                decides = (await _adds_directly(db, principal, c, read_) if c.op == "add_item"
                           else _decides(principal, c, read_))  # fmt: skip
                may = "apply" if decides else "propose"
                if waiting and e is not None:
                    # Review major: the cut with its dependents needs rights on every item.
                    cut = [e, *waiting]
                    may_all = (
                        "apply"
                        if changes.decides_all(principal, cut, read_.deciders)
                        else "propose"
                    )
        asks: list[uuid.UUID] = []
        here = True
        if may == "propose" and e is not None and c.op != "add_item":
            # walkc-meeting: who Propose asks, said before Propose; in a meeting its
            # deciders, and when nobody in it may decide, who outside it would be asked.
            asks = service.decider_ids(e, read_.deciders)
            if not asks:
                owners = owners if owners is not None else await changes._company_owners(db)
                asks = owners
            if rules is not None:
                asks, here = await changes.meeting_route(db, rules, [e], read_.deciders, asks)
            names.update(await _names(db, {i for i in asks if i not in names}))
        elif c.status == "proposed":
            asks = routes.get(c.change_id, []) if c.change_id else []
        asks_all: list[uuid.UUID] = []
        here_all = True
        if may_all == "propose" and e is not None:
            # walkc-meeting review: the cut with its dependents goes to whoever decides every
            # item it cuts (changes.create's cut_route), so the card names them for it.
            cut = [e, *waiting]
            asks_all = changes.cut_route(cut, read_.deciders)
            if not asks_all:
                owners = owners if owners is not None else await changes._company_owners(db)
                asks_all = owners
            if rules is not None:
                asks_all, here_all = await changes.meeting_route(
                    db, rules, cut, read_.deciders, asks_all
                )
            names.update(await _names(db, {i for i in asks_all if i not in names}))
        if off and e is not None:
            may = "propose" if may == "apply" else may
            may_all = "propose" if may_all == "apply" else may_all
            if may == "propose":
                owners = owners if owners is not None else await changes._company_owners(db)
                asks, here = service.decider_ids(e, read_.deciders) or owners, False
                asks_all, here_all = asks if may_all else [], False
                names.update(await _names(db, {i for i in asks if i not in names}))
        if c.status == "open" and c.id in gone:
            may = may_all = bar = None
            asks, asks_all, here, here_all = [], [], True, True
        # walkc-meeting r2: a proposal declined since reads as declined, by whom and when.
        no = declined.get(c.change_id) if c.status == "proposed" and c.change_id else None
        by, at = (no.decided_by, no.decided_at) if no is not None else (c.decided_by, c.decided_at)
        outs.append(ChatCardOut(
            id=c.id, message_id=c.message_id, op=c.op, target=c.target,  # type: ignore[arg-type]
            before=c.before, after=c.after, summary=c.summary, item_id=c.item_id,
            item_title=e.row.title if e is not None else None,
            status="declined" if no is not None else c.status,  # type: ignore[arg-type]
            may=may, why_not=bar, flags=flags, fixes=fixes, preview=c.preview,  # type: ignore[arg-type]
            flow=await _flow(db, c), change_id=c.change_id,
            decided_by_name=names.get(by) if by else None,  # type: ignore[arg-type]
            decided_at=at, decision_id=c.decision_id, change_words=card_words,
            correct=correct if c.status == "open" and c.id not in gone else None,
            replaced_by=gone.get(c.id),
            dependents=[x.row.title for x in waiting], dependent_ids=[x.row.id for x in waiting],
            may_with_dependents=may_all,  # type: ignore[arg-type]
            can_undo=c.status == "applied" and _undo_bar(principal, c, rules, read_) is None,
            asks=[names[i] for i in asks if i in names], asks_outside=not here,
            asks_with_dependents=[names[i] for i in asks_all if i in names],
            asks_with_dependents_outside=not here_all,
            elsewhere=agenda.elsewhere_words(e.row.title) if off and e is not None else None,
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
    with_dependents: bool = False,
    dependents: list[uuid.UUID] | None = None,
) -> tuple[ChatCardOut, SimpleChangeResult]:
    """Apply a card (or one of its fixes) through the change engine with the caller's own
    rights; in a meeting an applied card is a meeting decision. ``values`` (roadmap-talk's
    Correct): the card is rebuilt from them first, so the corrected values apply.
    ``with_dependents`` (fix5-cut-dependents): a cut card applies as cut_with_dependents,
    the item and everything that waits on it in one change; the card then names them.
    ``dependents``: the ids the card listed; others waiting on it now are 409."""
    me = _me(principal)
    card, rules = await _get(db, principal, card_id)
    await refuse_replaced(db, card)
    bar = _card_bar(principal, card, rules)
    if bar is not None:
        raise ChatError(403, bar)
    if with_dependents and (card.op != "cut" or fix is not None or values):
        raise ChatError(422, "Only a cut card cuts its dependents too")
    if values:
        if fix is not None:
            raise ChatError(422, "A fix takes no corrections")
        await _talk().correct(db, principal, card, values)
        await db.flush()
    if card.op in _actions().DIRECT_OPS:
        return await _apply_direct(db, principal, card_id, rules, fix)
    row = await db.get(RoadmapItem, card.item_id) if card.item_id is not None else None
    if row is not None and row.draft_roadmap_id is not None:
        return await _apply_draft_item(db, principal, card_id, rules, fix)
    if fix is not None:
        fixes = (await one(db, principal, card, rules)).fixes
        if fix >= len(fixes):
            raise ChatError(422, "fix: one of the card's fixes")
        f = fixes[fix]
        body = SimpleChangeIn(op=f.op, target=f.target, before=f.before, after=f.after)
    else:
        if card.status != "open":
            raise ChatError(409, f"This card is {card.status} already")
        body = SimpleChangeIn(op=changes.CUT_ALL if with_dependents else card.op,  # type: ignore[arg-type]
                              target=card.target,
                              before={**card.before, "dependents": [str(i) for i in dependents]}
                              if with_dependents and dependents is not None else card.before,
                              after={} if with_dependents else card.after)  # fmt: skip
    # In a meeting the change goes into the meeting's session, whoever the mode lets apply
    # (S8's engine takes them; their own rights still decide): made in the meeting.
    body.session_id = getattr(rules, "session_id", None) if rules is not None else None

    async def make() -> SimpleChangeResult:
        # The chat is locked and the card checked again in the change's own transaction (a
        # retry's rollback let the first lock go): a newer card acted on meanwhile refuses it.
        fresh = await db.get(SimpleChatCard, card_id, populate_existing=True)
        if fresh is not None:
            await refuse_replaced(db, fresh)
        # The card is taken in the change's own transaction (the engine commits both): two
        # Apply clicks at once make one change.
        if fix is None:
            c = await db.get(SimpleChatCard, card_id, with_for_update=True, populate_existing=True)
            if c is None or c.status != "open":
                raise ChatError(409, f"This card is {c.status if c else 'gone'} already")
            c.status = "applied"
            await db.flush()
        # The meeting's session closed: still only what the meeting reviews changes.
        later = {"meeting_id": rules.meeting_id} if body.session_id is None and rules else {}
        return await changes.create(db, principal, body, **later)

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
        if with_dependents:
            # The card names every item the one change cut.
            t = result.change.target
            said = change_words.phrase(changes.CUT_ALL, t, {}, {}, (t.get("titles") or [None])[0])
            card.summary = said[:1].upper() + said[1:]
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
    await _logged(db, principal, card)
    await db.commit()
    return await one(db, principal, card, rules), result


async def _logged(db: AsyncSession, principal: Any, card: SimpleChatCard) -> None:
    """ask-oracle-actions: an applied card is in the audit log as made via Ask Oracle."""
    await audit.record(db, principal, "simple_chat.card_apply", "simple_chat_card", card.id,
                       {"via": "Ask Oracle", "op": card.op, "summary": card.summary,
                        "change_id": str(card.change_id) if card.change_id else None})  # fmt: skip


async def rebase(db: AsyncSession, card_id: uuid.UUID, detail: Any) -> None:
    """dod-data: a card refused because its item changed since it was made (409 with the
    current values, after the failed apply is rolled back) stays open and is offered again
    on the new state: its ``before`` is what the item has now, so a second Apply is the
    person's choice on what they see. The caller has checked the card is theirs to apply."""
    current = detail.get("current") if isinstance(detail, dict) else None
    if not isinstance(current, dict) or not current:
        return
    card = await db.get(SimpleChatCard, card_id, with_for_update=True, populate_existing=True)
    if card is None or card.status != "open" or not set(current) <= set(card.before or {}):
        return
    card.before = {**card.before, **current}
    shift = (card.preview or {}).get("shift")
    if card.op == "move_dates" and shift and current.get("start_date") and current.get("end_date"):
        # A move by a span ("out a quarter") lands that span from where the item is now.
        start, end = (_add_months(date.fromisoformat(current[k]), shift[0])
                      + timedelta(days=shift[1]) for k in ("start_date", "end_date"))  # fmt: skip
        old = card.after
        s, en = start.isoformat(), end.isoformat()
        card.after = {"start_date": s, "end_date": en}
        card.preview = {**card.preview, "start_date": s, "end_date": en}
        was = f"{_day_words(date.fromisoformat(old['start_date']))} – " \
              f"{_day_words(date.fromisoformat(old['end_date']), True)}"  # fmt: skip
        card.summary = card.summary.replace(was, f"{_day_words(start)} – {_day_words(end, True)}")
    await db.commit()


DRAFT_ITEM_OPS = ("move_dates", "change_horizon", "edit_title", "cut", "restore")
DRAFT_ITEM_BAR = "Only the PRD's decider or an owner changes its draft roadmap"
DRAFT_ITEM_WAITS = "This item is on the PRD's draft roadmap: that change waits for its approval"


def _on_draft(e: service.Entry) -> bool:
    return e.row.draft_roadmap_id is not None


async def _apply_draft_item(
    db: AsyncSession, principal: Any, card_id: uuid.UUID, rules: Any, fix: int | None
) -> tuple[ChatCardOut, SimpleChangeResult | None]:
    """meet-chat-right-prd: a card on an item of the meeting PRD's draft roadmap (a run's
    items-only roadmap, before the PRD is approved). It has no roadmap, so no working draft
    for the change engine: its decider's Apply writes the item itself, in one transaction
    with the card, as a meeting decision."""
    if fix is not None:
        raise ChatError(422, "fix: one of the card's fixes")
    card = await db.get(SimpleChatCard, card_id, with_for_update=True, populate_existing=True)
    if card is None or card.status != "open":
        raise ChatError(409, f"This card is {card.status if card else 'gone'} already")
    if card.op not in DRAFT_ITEM_OPS:
        raise ChatError(409, DRAFT_ITEM_WAITS)
    read_ = await service.load(db, await drafts.overlays_for(db, principal))
    await meeting_prd(db, read_, rules)
    if not _decides(principal, card, read_):
        raise ChatError(403, DRAFT_ITEM_BAR)
    row = await db.get(RoadmapItem, card.item_id, with_for_update=True, populate_existing=True)
    assert row is not None
    if changes.read(row, list(card.before), card.target) != card.before:
        raise ChatError(409, "This item changed since the card was made: ask again")
    changes.write(row, card.after, card.target)
    card.status = "applied"
    card.decided_by, card.decided_at = _me(principal), company_time.now()
    meetings = _module(MEETINGS)
    if rules is not None and meetings is not None:
        try:
            card.decision_id = await meetings.record_meeting_decision(
                db, principal, rules.meeting_id, card.summary,
                [{"kind": "roadmap_item", "id": str(row.id)}], [],
            )  # fmt: skip
        except getattr(meetings, "MeetingError", ()) as e:
            raise ChatError(e.status, e.detail) from e
    await audit.record(db, principal, "simple_chat.draft_item_applied", "roadmap_item", row.id,
                       {"op": card.op, "before": card.before, "after": card.after})  # fmt: skip
    await db.commit()
    return await one(db, principal, card, rules), None


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
    if card.op != _api().OP:  # an API action logs its own (ask_actions.apply)
        await _logged(db, principal, card)
    await db.commit()
    return await one(db, principal, card, rules), None


async def discard(db: AsyncSession, principal: Any, card_id: uuid.UUID) -> ChatCardOut:
    card, rules = await _get(db, principal, card_id)
    if card.status != "open":
        raise ChatError(409, f"This card is {card.status} already")
    await refuse_replaced(db, card)
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
    if card.status == "applied":
        read_ = await service.load(db, await drafts.overlays_for(db, principal))
        bar = _undo_bar(principal, card, rules, read_)
        if bar is not None:
            raise ChatError(403, bar)
    if card.status == "applied" and card.op in _actions().DIRECT_OPS:
        await _actions().undo(db, principal, card, rules)
        card.status = "undone"
        await db.commit()
        return await one(db, principal, card, rules)
    row = await db.get(RoadmapItem, card.item_id, with_for_update=True) if card.item_id else None
    if card.status == "applied" and row is not None and row.draft_roadmap_id is not None:
        # A draft-roadmap item's card (meet-chat-right-prd): its values go back.
        if changes.read(row, list(card.after), card.target) != card.after:
            raise ChatError(409, "This item changed since: undo works only on the card's change")
        changes.write(row, card.before, card.target)
        card.status = "undone"
        if card.decision_id is not None:
            await _reverse(db, principal, card.decision_id)
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
    """What waits for the person, one card at a time: the broken links first (every red flag
    with a fix, as Home counts and lists them: broken_links; the card applies what the
    person decides and proposes the rest, as Home's own fixes), then the decisions on the
    next meeting's agenda, then the proposals waiting on them. Home's walk puts the
    decisions waiting for them (GET /v1/simple/decisions/waiting) after the broken links."""
    me = _me(principal)
    overlays = await drafts.overlays_for(db, principal)
    read_ = await service.load(db, overlays)
    by_id = read_.by_id()
    steps: list[WalkStepOut] = []
    cards: list[tuple[int, SimpleChatCard]] = []
    if has_role(principal.role, "commenter"):
        for e in sorted(read_.entries, key=lambda x: (x.roadmap.title, x.row.position)):
            for f in broken_links(e):
                fixes = _flag_fixes(e, f, by_id)
                if not fixes:
                    continue
                # The problem said once (the step's why), under the item's name.
                card = await _walk_card(db, me, f"{e.row.title}: {f.reason}", fixes[0], e)
                cards.append((len(steps), card))
                steps.append(WalkStepOut(id=f"link:{e.row.id}:{f.kind}:{f.subject}",
                                         kind="broken_link", title=e.row.title,
                                         why=f.reason))  # fmt: skip
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
            .order_by(SimpleChange.at, SimpleChange.seq)
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
