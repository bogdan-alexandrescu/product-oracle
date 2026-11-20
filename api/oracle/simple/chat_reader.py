"""oracle.simple.chat's reader: Oracle's model read of a line it does not know."""

import asyncio
import logging
import re
import uuid
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from typing import Any

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, company_time
from oracle.authz import has_role
from oracle.discussions.models import Discussion, DiscussionMessage
from oracle.errors import exception_text, read_state
from oracle.members.names import display_name
from oracle.simple import (
    card_order,
    drafts,
    service,
)
from oracle.simple.chat_common import (
    COULD_NOT_READ,
    FLOW_OPS,
    MEETING_ASK,
    MEETINGS,
    NEITHER,
    READER_JOB,
    SAY_AGAIN,
    VIEWER_NOTE,
    VISUALS,
    ChatError,
    Reply,
    _api,
    _attends,
    _day_words,
    _me,
    _module,
    _or,
    _shipped,
    _talk,
    rules_of,
)
from oracle.simple.chat_ops import (
    OPS,
    Ctx,
    _count,
    build,
)
from oracle.simple.models import SimpleChatCard, SimpleChatRead

log = logging.getLogger("oracle.simple.chat")


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
    redo: bool = False,
) -> None:
    """Oracle's cards on its line, in the order asked (real time orders them). A new
    record's card redoes an earlier draft only on an explicit signal: the reader named it
    (``redo_of``) or the line asks to change the previous card (``redo``)."""
    at = datetime.now(UTC)
    for i, c in enumerate(reply.cards):
        c = dict(c)
        named = c.pop("redo_of", None)
        again = await card_order.redo_of(db, answer, c, named, redo)
        card = SimpleChatCard(discussion_id=answer.discussion_id, message_id=answer.id,
                              meeting_id=meeting_id,
                              owner_id=None if meeting_id else _me(principal), status="open",
                              created_at=at + timedelta(microseconds=i), redo_of=again,
                              **c)  # fmt: skip
        db.add(card)
        await db.flush()
        if card.op in FLOW_OPS:
            await _request_visual(db, principal, card)


# --------------------------------------------------------------------------- the reader


async def _job_rows(db: AsyncSession, ids: list[uuid.UUID]) -> dict[uuid.UUID, Any]:
    """Each job's status and, when no Claude account could take its call, the pool's
    reason and next reset (the structured cause the worker stores)."""
    if not ids:
        return {}
    from oracle.jobs.models import LlmJob

    rows = await db.execute(
        select(LlmJob.id, LlmJob.status, LlmJob.error_reason, LlmJob.next_reset_at).where(
            LlmJob.id.in_(ids)
        )
    )
    return {row.id: row for row in rows.all()}


def _spent_until(job: Any) -> datetime | None:
    """When a failed read's spent pool clears, while that is still ahead; None otherwise."""
    from oracle.claude_accounts.accounts import Unavailable

    if job.status != "failed" or job.error_reason != Unavailable.NO_ACCOUNT_AVAILABLE:
        return None
    at = job.next_reset_at
    return at if at is not None and at > company_time.now() else None


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
        one_ = None
        agenda_read = read_state(applies=meetings is not None)
        try:
            # A savepoint: a failing read of the agenda leaves the job's transaction usable.
            async with db.begin_nested():
                one_ = await meetings.one(db, c.principal, r.meeting_id) if meetings else None
        except Exception as exc:  # noqa: BLE001 - the agenda is context, never required
            # The reader is told the error's kind; its text (maybe SQL) goes to the log only.
            agenda_read = {**read_state(exc), "reason": type(exc).__name__}
            log.warning("chat reader: meeting %s agenda unavailable: %s",
                        r.meeting_id, exception_text(exc))  # fmt: skip
        # The reader is told whether the agenda was read, could not be (and why), or
        # does not apply: an unread agenda is not an empty one.
        context["meeting"]["agenda_read"] = agenda_read
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
        if c.prd is not None:
            # meet-chat-right-prd: the PRD the meeting reviews, its version under review,
            # and where its items come from (``items`` are its items only).
            context["meeting"].update({
                "prd": c.prd.document.title, "prd_version": c.prd.number,
                "prd_text": c.prd.text,
                "approved": c.prd.approved,
                "items_from": "draft roadmap" if c.prd.draft else "roadmap",
            })  # fmt: skip
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
            "horizon": e.horizon, "cut": e.row.cut,
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
        # chat-latest-card: the chat's open drafts of new records, a line may ask to change
        # one ("make it April instead"): the reader names it (``redo_of``).
        "cards": await _open_drafts(db, read),
        # ask-oracle-actions: every action of the API the person's role reaches (``calls``).
        "api": _api().offer(c.principal.role, c.api_role, c.meeting is not None),
    }


async def _open_drafts(db: AsyncSession, read: SimpleChatRead) -> list[dict[str, str]]:
    rows = list(
        await db.scalars(
            select(SimpleChatCard)
            .where(SimpleChatCard.discussion_id == read.discussion_id,
                   SimpleChatCard.message_id != read.message_id,
                   SimpleChatCard.status == "open", SimpleChatCard.item_id.is_(None),
                   SimpleChatCard.op.in_(card_order.NEW_OPS))
            .order_by(SimpleChatCard.created_at.desc(), SimpleChatCard.id.desc())
            .limit(10)
        )
    )  # fmt: skip
    return [{"id": str(c.id), "op": c.op, "restated": c.summary} for c in reversed(rows)]


_TOKEN = re.compile(r"\s*\[(?:c|l):\d+\]")
_ISO_DAY = re.compile(r"\b(\d{4})-(\d{2})-(\d{2})\b")


def plain(text: str) -> str:
    """The reader's words as people read them: no raw citation tokens ([c:5]), days month
    first ("Dec 1, 2026"), never ISO."""

    def day(m: re.Match) -> str:
        try:
            return _day_words(date(int(m[1]), int(m[2]), int(m[3])), True)
        except ValueError:
            return m[0]

    return _ISO_DAY.sub(day, _TOKEN.sub("", text))


# A sentence (or clause after ":" or ";") whose subject is the item: "It ends ...", "Got it:
# this already runs ...". "it" or "this" elsewhere ("Got it! Why did ...") is not.
_ABOUT_IT = re.compile(
    r"(?:^|[.!?]\s+|[:;]\s*)(?:it|its|it's|this|this item|this feature|the item|the feature)\b",
    re.I,
)
# ... and it speaks of the item's plan: its dates, state, owner, milestone, goal or tasks.
_ITS_PLAN = re.compile(
    r"\b(?:ship(?:s|ped)?|live|launch(?:es|ed)?|release[sd]?|runs?|running|built|done|planned|"
    r"plan|dates?|starts?|started|ends?|ended|due|late|milestones?|goals?|tasks?|owners?|owns|"
    r"owned|status|scope|prd|roadmap|slices?|risks?|blocked|depends|cut)\b",
    re.I,
)


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
        if _ABOUT_IT.search(said.strip()) and _ITS_PLAN.search(said):
            # item-chat-understands: the talk's context is the item, so an answer whose
            # subject is "it" and that speaks of its plan is about this item, its name
            # repeated or not (review: a stray "it" or "this" alone is not).
            return True
    return any(len(n) >= 3 and n.lower() in t for n in names)


# ask-length-limit: parts of a line no chat change does yet, said as such with where they are
# changed (never "I did not understand"): (pattern, the words, the page's name, its link).
NOT_YET = (
    (re.compile(r"\bgate\b", re.I),
     "I can't change an item that is off the gate but still in Now from a chat yet",
     "Roadmap", "/simple/roadmap"),
    (re.compile(r"\bcapacity\b|\bheadcount\b|\bengineer[- ]weeks?\b", re.I),
     "I can't change capacity from a chat yet", "Priorities", "/simple/priorities"),
    (re.compile(r"\bdates?\b|\bdeadlines?\b", re.I),
     "I can't change dates from a chat yet", "Roadmap", "/simple/roadmap"),
)  # fmt: skip


def _unread(skipped: Any, links: list[dict[str, str]] | None = None) -> list[str]:
    """The reader's ``skipped`` parts of the line, every one said back (each clipped): a part
    about capacity, dates or the gate is not yet supported, with where to change it (added to
    ``links``, once each); any other part was not understood."""
    if not isinstance(skipped, list):
        return []
    parts = [" ".join(str(x).split())[:120] for x in skipped if str(x).strip()]
    said: list[str] = []
    for p in parts:
        hit = next((n for n in NOT_YET if n[0].search(p)), None)
        if hit is None:
            said.append(f"I did not understand: “{p}”.")
            continue
        said.append(f"{hit[1]} (“{p}”); change it on {hit[2]}.")
        if links is not None and all(x["href"] != hit[3] for x in links):
            links.append({"label": hit[2], "href": hit[3]})
    return said


def _unused(c: Ctx, actions: list[Any]) -> str:
    """ask-length-limit: the changes past the fifth, each named, for the person to say again."""
    names = []
    for a in actions:
        r = build(c, str(a.get("op")), a.get("args") or {}) if isinstance(a, dict) else None
        if r is not None and r.kind == "cards" and r.cards:
            names.append(str(r.cards[0].get("summary") or ""))
        elif isinstance(a, dict) and str(a.get("restated") or "").strip():
            names.append(plain(" ".join(str(a["restated"]).split()))[:120])
    names = [f"“{n}”" for n in names if n]
    if not names:
        return "I read the first five changes; say the rest again."
    return f"I did not use these changes yet; say them again: {'; '.join(names)}."


def _linked(reply: Reply, links: list[dict[str, str]]) -> Reply:
    reply.links = links
    return reply


def _no_change(c: Ctx, line: str | None, nothing: bool = True) -> Reply:
    """No change read: in an item's talk a short question with choices drawn from the line
    (item-chat-understands), else "Say it another way"."""
    viewer = not has_role(c.principal.role, "commenter")
    asked = None if viewer else _shipped().choices(c, line)
    reply = asked or Reply("note", f"I could not tell what to change. {SAY_AGAIN}")
    reply.no_change = nothing
    return reply


def interpret(c: Ctx, answer: Any, ask_box: bool = False, line: str | None = None) -> Reply:
    """The reader's answer, validated: every action through ChatOp.build (an unknown op, a
    bad arg or an item the caller cannot read is a plain refusal, never a card); a clarify
    question keeps only the choices that build; an answer is Oracle's data only. ``line``:
    the person's words, for the choices offered when no change is read."""
    if not isinstance(answer, dict):
        return _no_change(c, line, False)
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
            if a.get("redo_of"):
                # chat-latest-card: the reader read the line as changing that open draft
                # (checked when the card is stored: card_order.redo_of).
                r.cards = [{**x, "redo_of": str(a["redo_of"])} for x in r.cards]
            cards += r.cards
        # qa-simple-decide-24: nothing is dropped without a word: every refusal, the parts the
        # reader could not read, the changes past the fifth.
        links: list[dict[str, str]] = []
        said = _unread(answer.get("skipped"), links)
        if len(actions) > 5:
            said.append(_unused(c, actions[5:]))
        if not cards:
            return _linked(Reply("note", " ".join([refused[0], *refused[1:], *said])), links)
        if refused:
            # The valid cards stay; the line says which ones it cannot do.
            whys = " ".join(
                r.removeprefix("I can't do that here: ").removeprefix("I can't do that: ")
                for r in refused
            )
            n = {1: "One", 2: "Two", 3: "Three"}.get(len(refused), str(len(refused)))
            said.insert(0, f"{n} I can't do: {whys}")
        return _linked(Reply("cards", " ".join([*said, _count(len(cards))]), cards), links)
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
            return _no_change(c, line, False)
        question = plain(str(clarify.get("question") or "Which one?"))[:200]
        return Reply("question", question, choices=[*choices, NEITHER])
    if isinstance(said, str) and said.strip() and _grounded(c, said):
        return Reply("answer", plain(said.strip())[:1500])
    if ask_box:
        return Reply("ask", "Asking Oracle…")
    return _no_change(c, line)


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
    payload = await _payload(c, read)
    live = await _live_of(s, job.tenant_id, read, msg)
    try:
        answer = await (ask(READER_JOB, payload, mcp=live.mcp) if live
                        else ask(READER_JOB, payload))  # fmt: skip
    finally:
        if live:
            # The token reads no more once the run has answered (a second call, wording
            # the API's results, never reads live).
            await live.end()
    reply, cited = await live.answer(answer) if live else (None, [])
    reply = reply or await _with_calls(c, ask, payload, answer, read)
    if read.meeting_id is not None and reply.no_change and read.line.rstrip().endswith("?"):
        # As the mock's question branch: only a line the reader saw nothing to change in;
        # a change it could not build keeps its own reply.
        reply = Reply("note", MEETING_ASK)
        await _keep_question(s, principal, read.meeting_id, read.line)
    msg.body, msg.prompt, msg.status = reply.body, reply.kind, "complete"
    # Oracle's line is dated when Oracle wrote it, not when the line was asked; kept on its
    # read, never as the line's edited_at (a discussion view would call it "edited").
    read.answered_at = datetime.now(UTC)
    if reply.kind == "answer" and isinstance(answer, dict):
        msg.citations = _talk().source_of(c, answer.get("source"))
        if not msg.citations and c.prd is not None:
            # A meeting's answer names where it comes from: the meeting's PRD.
            msg.citations = [{"kind": "simple_source", "label": c.prd.source()}]
    if cited and reply.kind == "answer":
        msg.citations = [*(msg.citations or []), *cited]
    if reply.links:
        links = [{"kind": "simple_link", **x} for x in reply.links]
        msg.citations = [*(msg.citations or []), *links]
    read.choices = _jsonable(reply.choices)
    await _attach(s, principal, msg, read.meeting_id, reply)
    await s.flush()
    return {"kind": reply.kind, "cards": len(reply.cards), "choices": len(reply.choices)}


@dataclass
class _LiveRun:
    """#710 in Simple: an Ask panel line's reader run reads its asker's sources live as Ask's
    replies do (oracle.discussions.replies: the live plan, its token, prompt and MCP server),
    only in the person's own Ask chat, never a meeting's chat or one others are in."""

    tenant_id: uuid.UUID
    message_id: uuid.UUID
    started: bool = False
    beat: asyncio.Task | None = field(default=None, repr=False)

    async def mcp(self, system: str) -> tuple[str, Any]:
        """Claude Code is about to run the line: the reply is ``streaming`` while it may
        read (as every live call re-checks), its lease renewed until :meth:`end` (the
        lease sweep fails a lapsed one), then the live decision is taken again and the
        token minted (replies' own)."""
        from oracle.discussions import replies

        await self._lease(status="streaming")
        self.started = True
        if self.beat is None:
            self.beat = asyncio.ensure_future(self._renew())
        return await replies.for_claude_code(self.tenant_id, self.message_id, system)

    async def _lease(self, **values: Any) -> None:
        from oracle.discussions import replies
        from oracle.tenancy import tenant_session

        async with tenant_session(self.tenant_id) as db:
            await db.execute(update(DiscussionMessage)
                             .where(DiscussionMessage.id == self.message_id,
                                    *([] if values else
                                      [DiscussionMessage.status == "streaming"]))
                             .values(stream_lease_until=func.now() + replies.LEASE, **values)
                             .execution_options(synchronize_session=False))  # fmt: skip
            await db.commit()

    async def _renew(self) -> None:
        """The lease, renewed at a third of its length while Claude Code runs."""
        from oracle.discussions import replies

        while True:
            await asyncio.sleep(replies.LEASE.total_seconds() / 3)
            try:
                await self._lease()
            except Exception:
                log.exception("could not renew the lease of chat line %s", self.message_id)

    async def answer(self, answer: Any) -> tuple["Reply | None", list[dict[str, Any]]]:
        """Oracle's answer from the asker's live reads, and the reads it cites (``[l:n]``;
        a marker with no read of this line is dropped): when a live read happened and the
        reader made no change of the plan, its words are the answer as they are (a refused
        read's sentence says what to do; it is never handed on to Ask, a second run), a
        source's raw failure said plainly as Ask's replies do."""
        from oracle.discussions import plan as plan_ctx
        from oracle.discussions import replies

        if not self.started or not isinstance(answer, dict):
            return None, []
        said = answer.get("answer")
        if (not isinstance(said, str) or not said.strip() or answer.get("actions")
                or answer.get("calls") or answer.get("clarify")):  # fmt: skip
            return None, []
        if not await replies.live_read(self.tenant_id, self.message_id):
            return None, []
        cited: list[dict[str, Any]] = []
        if "[l:" in said:
            reads = await replies.live_citations(self.tenant_id, self.message_id)
            refs = dict.fromkeys(int(n) for n in replies.LIVE_MARKER.findall(said))
            cited = [reads[n] for n in refs if n in reads]
        if await replies.live_failed(self.tenant_id, self.message_id):
            said = plan_ctx.plain_failures(said)
        return Reply("answer", plain(said.strip())[:1500]), cited

    async def end(self) -> None:
        """The token reads no more; the line is the reader's again (its job sets it done)."""
        from oracle.discussions import replies
        from oracle.tenancy import tenant_session

        if self.beat is not None:
            self.beat.cancel()
            # Waits for the renewal to stop without taking its cancel as the job's own.
            await asyncio.wait([self.beat])
            self.beat = None
        if not self.started:
            return
        await replies.revoke(self.tenant_id, [self.message_id])
        async with tenant_session(self.tenant_id) as db:
            await db.execute(update(DiscussionMessage)
                             .where(DiscussionMessage.id == self.message_id,
                                    DiscussionMessage.status == "streaming")
                             .values(status="pending", stream_lease_until=None)
                             .execution_options(synchronize_session=False))  # fmt: skip
            await db.commit()


async def _live_of(
    db: AsyncSession, tenant_id: uuid.UUID, read: SimpleChatRead, msg: DiscussionMessage
) -> _LiveRun | None:
    """A live run for an Ask panel line whose asker may read live there (replies.live_plan,
    unminted); None in a meeting's chat, a chat others are in, with no live source, or on a
    retry of a line that already had its live run (one token, one read cap per question)."""
    from oracle.discussions import replies
    from oracle.live.tokens import LiveToken

    if read.meeting_id is not None:
        return None
    if await db.scalar(select(LiveToken.id).where(LiveToken.message_id == msg.id).limit(1)):
        return None
    d = await db.get(Discussion, read.discussion_id)
    if d is None or d.subject_key.startswith("meeting_chat:"):
        return None
    plan = await replies.live_plan(db, d, msg, mint=False)
    return _LiveRun(tenant_id, msg.id) if plan.live else None


async def _with_calls(c: Ctx, ask: Any, payload: dict, answer: Any, read: SimpleChatRead) -> Reply:
    """ask-oracle-actions: the reader's ``calls`` of the API's actions beside its ops. Reads
    run at once as the person and a second call words their results (an answer); writes
    are cards; a call the person's role does not reach is a plain refusal, never a card."""
    calls = answer.get("calls") if isinstance(answer, dict) else None
    if not calls:
        return _talk().restate(c, interpret(c, answer, read.ask_box, read.line))
    if c.meeting is not None and not has_role(c.principal.role, "commenter"):
        return Reply("note", VIEWER_NOTE)
    results, cards, refused = await _api().calls(c, answer)
    if results:
        worded = await ask(READER_JOB, {**payload, "results": results})
        said = worded.get("answer") if isinstance(worded, dict) else None
        if not isinstance(said, str) or not said.strip():
            return Reply("note", " ".join([COULD_NOT_READ, *refused]))
        return Reply("answer", " ".join([plain(said.strip())[:1500], *refused]))
    first = (_talk().restate(c, interpret(c, {**answer, "calls": None}, False, read.line))
             if answer.get("actions") else None)  # fmt: skip
    cards = [*(first.cards if first is not None and first.kind == "cards" else []), *cards]
    if not cards:
        return Reply("note", " ".join(refused) or f"I could not tell what to change. {SAY_AGAIN}")
    said = [f"I can't do: {' '.join(refused)}"] if refused else []
    return Reply("cards", " ".join([*said, _count(len(cards))]), cards)


async def _keep_question(
    db: AsyncSession, principal: Any, meeting_id: uuid.UUID, line: str
) -> None:
    """A kept question is the meeting's open question at once (its "Notes so far", then the
    minutes' open questions, which list each question once); an ended meeting keeps none."""
    meetings = _module(MEETINGS)
    if meetings is None or not hasattr(meetings, "add_note"):
        return
    try:
        async with db.begin_nested():
            await meetings.add_note(db, principal, meeting_id, "question", line)
    except getattr(meetings, "MeetingError", ()):
        pass


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


# --------------------------------------------------------------------------- cards


async def _request_visual(db: AsyncSession, principal: Any, card: SimpleChatCard) -> None:
    visuals = _module(VISUALS)
    if visuals is None:
        return
    if await visuals.flow_for(db, "chat_card", card.id) is None:
        await visuals.request_visual(db, principal, "chat_card", card.id, card.summary)
