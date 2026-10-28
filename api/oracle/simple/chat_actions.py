"""Simple chat-actions (#723, the owner's report): the chat's new actions, each a card
(restate + card) that nothing applies until an allowed person clicks Apply.

- ``set_owner`` / ``set_decider`` (item, person): the change engine's ops of the same name
  (oracle.simple.changes, into the working draft): owners and the decider apply, with Undo;
  approvers and commenters propose; viewers read. chat.apply takes them as any engine card.
- ``record_decision`` (text, decider?): in a meeting, a decision of the meeting (S8's
  ``record_meeting_decision``: the minutes' "Decisions taken" and the Decisions page),
  decided by the named person, else the PRD's decider, else the caller; on the Ask panel, a
  decision on the page's document (Oracle's decisions, ``capture``), for approvers and
  owners. Undo reverses it (a review says why).
- ``minutes_note`` / ``open_question`` (text): meeting only; the meeting's notes (its screen,
  then Oracle's drafted minutes: Summary notes, Open questions). Undo removes the note.
- ``agenda_next`` / ``agenda_skip`` (item): meeting only; the meeting's agenda, seen by every
  attendee. Undo puts the agenda back as it was.

In a meeting the direct ops apply for whoever the presenter's change mode lets apply (chat's
``meeting_bar``: never a viewer, never once ended). ``ACTIONS`` is the contract with
chat-reader (chat-join registers it into chat.OPS); parse() calls the same build functions
for its fixed phrases.
"""

import re
import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import company_time
from oracle.authz import has_role
from oracle.decisions.models import Decision
from oracle.docs.models import Document
from oracle.members.names import display_name
from oracle.simple import changes, chat
from oracle.simple.models import SimpleChatCard
from oracle.simple.schemas import SimpleChangeIn

ENGINE_OPS = ("set_owner", "set_decider")
DIRECT_OPS = ("record_decision", "minutes_note", "open_question", "agenda_next", "agenda_skip")
MEETING_ONLY = ("minutes_note", "open_question", "agenda_next", "agenda_skip")
UNDERSTOOD = "I understood one change:"
MEETING_NOTE = "Minutes notes, open questions and agenda changes belong to a meeting."
TEXT_MAX = 500
SOURCE_KIND = "simple_chat_decision"


def _text(args: dict[str, Any], key: str = "text") -> str:
    text = " ".join(str(args.get(key) or "").split())
    return text.strip("\"'“”‘’").strip()[:TEXT_MAX]


def _name(u: Any) -> str:
    return display_name(u.email, u.name)


# --------------------------------------------------------------------------- builds


def _who_build(field: str, word: str):
    def build(c: chat.Ctx, args: dict[str, Any]) -> dict | chat.Reply:
        e = c.find(str(args.get("item") or ""))
        if isinstance(e, chat.Reply):
            return e
        person = c.person(str(args.get("person") or ""))
        if isinstance(person, chat.Reply):
            return person
        now = getattr(e.row, field)
        if now == person.id:
            return chat.Reply("note", f"{_name(person)} is the {word} of {e.row.title} already.")
        before_name = None
        if now is not None:
            before_name = next((_name(u) for u in c.people if u.id == now), None)
        elif field == "owner_id":
            before_name = e.owner_name
        return {"summary": f"Make {_name(person)} the {word} of {e.row.title}",
                "op": "set_owner" if field == "owner_id" else "set_decider",
                "item_id": e.row.id, "target": {"item_id": str(e.row.id)},
                "before": {field: str(now) if now else None}, "after": {field: str(person.id)},
                "preview": {"kind": word, "item_id": str(e.row.id), "person_id": str(person.id),
                            "person_name": _name(person), "before_name": before_name}}  # fmt: skip

    return build


build_set_owner = _who_build("owner_id", "owner")
build_set_decider = _who_build("decider_id", "decider")


def _page_document(c: chat.Ctx) -> Document | None:
    return getattr(c, "page_document", None)


def build_record_decision(c: chat.Ctx, args: dict[str, Any]) -> dict | chat.Reply:
    text = _text(args)
    if not text:
        return chat.Reply("question", "What was decided?")
    decider = None
    if args.get("decider"):
        decider = c.person(str(args["decider"]))
        if isinstance(decider, chat.Reply):
            return decider
    target: dict[str, Any] = {}
    if c.meeting is not None:
        target["meeting_id"] = str(c.meeting.meeting_id)
    elif (doc := _page_document(c)) is not None:
        target["document_id"] = str(doc.id)
    where = "meeting" if c.meeting is not None else "page"
    if decider is not None:
        decider_name = _name(decider)
    elif c.meeting is not None:
        decider_name = getattr(c, "meeting_decider_name", None) or "the meeting's decider"
    else:
        me = chat._me(c.principal)
        decider_name = next((_name(u) for u in c.people if u.id == me), "you")
    return {"summary": f"Record the decision: {text}", "op": "record_decision", "item_id": None,
            "target": target, "before": {},
            "after": {"text": text, "decider_id": str(decider.id) if decider else None},
            "preview": {"kind": "decision", "text": text, "decider_name": decider_name,
                        "where": where}}  # fmt: skip


def _note_build(kind: str):
    def build(c: chat.Ctx, args: dict[str, Any]) -> dict | chat.Reply:
        if c.meeting is None:
            return chat.Reply("note", MEETING_NOTE)
        text = _text(args)
        if not text:
            return chat.Reply("question", "What should the minutes say?")
        note = kind == "note"
        return {"summary": f"Add to the minutes: {text}" if note
                else f"Add the open question: {text}",
                "op": "minutes_note" if note else "open_question", "item_id": None,
                "target": {"meeting_id": str(c.meeting.meeting_id)}, "before": {},
                "after": {"text": text},
                "preview": {"kind": "note" if note else "question", "text": text}}  # fmt: skip

    return build


build_minutes_note = _note_build("note")
build_open_question = _note_build("question")


def _agenda_build(move: str):
    def build(c: chat.Ctx, args: dict[str, Any]) -> dict | chat.Reply:
        e = c.find(str(args.get("item") or ""))
        if isinstance(e, chat.Reply):
            return e
        if c.meeting is None:
            return chat.Reply("note", MEETING_NOTE)
        title = e.row.title
        return {"summary": f"Take {title} next" if move == "next" else f"Skip {title}",
                "op": f"agenda_{move}", "item_id": e.row.id,
                "target": {"meeting_id": str(c.meeting.meeting_id), "item_id": str(e.row.id)},
                "before": {}, "after": {"move": move},
                "preview": {"kind": "agenda", "item_id": str(e.row.id), "move": move,
                            "item_title": title}}  # fmt: skip

    return build


build_agenda_next = _agenda_build("next")
build_agenda_skip = _agenda_build("skip")


# --------------------------------------------------------------------------- the phrases

# (pattern, op, arg names, worded: a "<words>: ..." phrase, which claims its line even
# when it ends in "?"; the others leave a question to the reader).
PHRASES: list[tuple[str, str, tuple[str, ...], bool]] = [
    (r"(?:open )?question:\s*(.+)", "open_question", ("text",), True),
    (r"(?:minutes )?note:\s*(.+)", "minutes_note", ("text",), True),
    (r"next:\s*(.+?)\.?", "agenda_next", ("item",), True),
    (r"(?:take|discuss) (.+?) next\.?", "agenda_next", ("item",), False),
    (r"skip (.+?)\.?", "agenda_skip", ("item",), False),
    (r"(?:we )?decided:\s*(.+)", "record_decision", ("text",), True),
    (r"decision(?: by (.+?))?:\s*(.+)", "record_decision", ("decider", "text"), True),
    (r"(?!who\b)(.+?) (?:now )?owns (.+?)\.?", "set_owner", ("person", "item"), False),
    (r"(?!who\b)(.+?) (?:now )?decides (.+?)\.?", "set_decider", ("person", "item"), False),
]  # fmt: skip


def phrase(t: str) -> tuple[str, dict[str, Any]] | None:
    """The fixed phrases: the op and its args (None: not one of them). chat.parse() builds
    them through chat.build like its own, so an unknown item or person is not claimed
    (``understood=False``: the Ask panel's one box sends the line to Oracle's Ask)."""
    for pattern, op, names, worded in PHRASES:
        if not worded and t.rstrip().endswith("?"):
            continue
        if m := re.fullmatch(pattern, t, re.I):
            return op, {k: v for k, v in zip(names, m.groups(), strict=True) if v is not None}
    return None


# --------------------------------------------------------------------------- apply


def bar(principal: Any, card: SimpleChatCard, rules: Any) -> str | None:
    """Why the caller may not apply this direct card (None: they may)."""
    if rules is not None:
        return chat.meeting_bar(principal, rules)
    if card.op in MEETING_ONLY:
        return MEETING_NOTE
    if card.owner_id is not None and card.owner_id != chat._me(principal):
        return "This card is someone else's"
    if not has_role(principal.role, "approver"):
        return "Approvers and owners record decisions; ask one of them"
    return None


async def _meeting_decider(db: AsyncSession, meeting_id: uuid.UUID) -> uuid.UUID | None:
    meetings = chat._module(chat.MEETINGS)
    if meetings is None or not hasattr(meetings, "prd_who"):
        return None
    from oracle.simple.models import SimpleMeeting

    m = await db.get(SimpleMeeting, meeting_id)
    doc = await db.get(Document, m.prd_document_id) if m is not None else None
    return (await meetings.prd_who(db, doc)).decider if doc is not None else None


async def meeting_decider_name(db: AsyncSession, c: chat.Ctx) -> str | None:
    """The name of the meeting PRD's decider (an unnamed decision is theirs)."""
    if c.meeting is None:
        return None
    decider = await _meeting_decider(db, c.meeting.meeting_id)
    return next((_name(u) for u in c.people if u.id == decider), None) if decider else None


async def apply_record_decision(db: AsyncSession, principal: Any, card: SimpleChatCard) -> None:
    from oracle.decisions import capture

    me = chat._me(principal)
    text = str(card.after.get("text") or "")
    named = uuid.UUID(card.after["decider_id"]) if card.after.get("decider_id") else None
    meeting_id = card.target.get("meeting_id")
    if meeting_id:
        meetings = chat._module(chat.MEETINGS)
        if meetings is None:
            raise chat.ChatError(404, "No such meeting")
        try:
            decision_id = await meetings.record_meeting_decision(
                db, principal, uuid.UUID(meeting_id), text, [], []
            )
        except getattr(meetings, "MeetingError", ()) as e:
            raise chat.ChatError(e.status, e.detail) from e
        decider = named or await _meeting_decider(db, uuid.UUID(meeting_id))
        if decider is not None:
            d = await db.get(Decision, decision_id)
            if d is not None:
                d.approver_id, d.decided_by = decider, decider
        card.decision_id = decision_id
        return
    doc_id = card.target.get("document_id")
    subjects = [{"kind": "document", "id": doc_id}] if doc_id else []
    decider = named or me
    d = await capture.capture(
        db, principal, origin="manual", source_kind=SOURCE_KIND, source_id=card.id, title=text,
        options=[{"key": "decided", "label": text}], chosen_option="decided",
        rationale="Recorded in Simple's chat", approver_id=decider,
        context="Recorded from the Ask panel", subjects=subjects, decided_by=decider,
    )  # fmt: skip
    card.decision_id = d.id


async def apply_note(db: AsyncSession, principal: Any, card: SimpleChatCard) -> None:
    meetings = chat._module(chat.MEETINGS)
    if meetings is None:
        raise chat.ChatError(404, "No such meeting")
    kind = "note" if card.op == "minutes_note" else "question"
    try:
        meeting_id = uuid.UUID(card.target["meeting_id"])
        text = str(card.after.get("text") or "")
        note_id = await meetings.add_note(db, principal, meeting_id, kind, text, card.id)
    except getattr(meetings, "MeetingError", ()) as e:
        raise chat.ChatError(e.status, e.detail) from e
    card.target = {**card.target, "note_id": note_id}


async def apply_agenda(db: AsyncSession, principal: Any, card: SimpleChatCard) -> None:
    meetings = chat._module(chat.MEETINGS)
    if meetings is None:
        raise chat.ChatError(404, "No such meeting")
    try:
        was = await meetings.set_agenda(db, uuid.UUID(card.target["meeting_id"]),
                                        uuid.UUID(card.target["item_id"]),
                                        card.after.get("move") or "next")  # fmt: skip
    except getattr(meetings, "MeetingError", ()) as e:
        raise chat.ChatError(e.status, e.detail) from e
    card.before = {"agenda": was}


async def apply_engine(db: AsyncSession, principal: Any, card: SimpleChatCard) -> None:
    """set_owner / set_decider as a plain (db, principal, card) apply: the change engine
    with the caller's rights (in a meeting, into the meeting's session). It does not call
    chat.apply (which reloads the card and dispatches here); the engine commits."""
    rules = await chat.rules_of(db, card.meeting_id) if card.meeting_id else None
    bar_why = chat._card_bar(principal, card, rules)
    if bar_why is not None:
        raise chat.ChatError(403, bar_why)
    if card.status != "open":
        raise chat.ChatError(409, f"This card is {card.status} already")
    body = SimpleChangeIn(op=card.op, target=card.target, before=card.before,  # type: ignore[arg-type]
                          after=card.after,
                          session_id=getattr(rules, "session_id", None))  # fmt: skip
    card.status = "applied"
    result = await changes.create(db, principal, body)
    card.status = "applied" if result.change.status == "applied" else "proposed"
    card.change_id, card.decided_by = result.change.id, chat._me(principal)
    card.decided_at = company_time.now()
    meetings = chat._module(chat.MEETINGS)
    if rules is not None and card.status == "applied" and meetings is not None:
        # In a meeting an applied card is a meeting decision (as chat.apply makes it).
        subjects = [{"kind": "roadmap_item", "id": str(card.item_id)}] if card.item_id else []
        try:
            card.decision_id = await meetings.record_meeting_decision(
                db, principal, rules.meeting_id, card.summary, subjects, [result.change.id]
            )
        except getattr(meetings, "MeetingError", ()) as e:
            raise chat.ChatError(e.status, e.detail) from e


async def undo(db: AsyncSession, principal: Any, card: SimpleChatCard, rules: Any) -> None:
    """Undo of an applied direct card (by whoever may apply it; the caller commits)."""
    why = bar(principal, card, rules)
    if why is not None:
        raise chat.ChatError(403, why)
    meetings = chat._module(chat.MEETINGS)
    try:
        if card.op == "record_decision":
            if card.decision_id is not None:
                where = (
                    "in the meeting chat" if card.target.get("meeting_id") else "on the Ask panel"
                )
                await chat._reverse(db, principal, card.decision_id, f"Undone {where}")
        elif card.op in ("minutes_note", "open_question"):
            await meetings.remove_note(db, uuid.UUID(card.target["meeting_id"]),
                                       str(card.target.get("note_id")))  # fmt: skip
        else:
            await meetings.restore_agenda(db, uuid.UUID(card.target["meeting_id"]),
                                          dict(card.before.get("agenda") or {}))  # fmt: skip
    except getattr(meetings, "MeetingError", ()) as e:
        raise chat.ChatError(e.status, e.detail) from e


DOCUMENT_ROUTES = ("documents", "prds", "one-pagers")


async def page_document(db: AsyncSession, page: str | None) -> Document | None:
    """The document the Ask panel's page shows: the id or slug right after a document
    route (/documents/<doc>, /simple/prds/<doc>, /simple/one-pagers/<doc>), if any."""
    if not page:
        return None
    parts = [p for p in re.split(r"/", re.split(r"[?#]", page, maxsplit=1)[0]) if p]
    ref = next((b for a, b in zip(parts, parts[1:], strict=False) if a in DOCUMENT_ROUTES), None)
    if ref is None:
        return None
    try:
        return await db.get(Document, uuid.UUID(ref))
    except ValueError:
        pass
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", ref):
        return None
    return await db.scalar(select(Document).where(Document.slug == ref).limit(1))


ACTIONS: list[dict[str, Any]] = [
    {"op": "set_owner", "describe": "Make a person the owner of a roadmap item",
     "args": {"item": "the roadmap item", "person": "the new owner"},
     "build": build_set_owner, "apply": apply_engine},
    {"op": "set_decider", "describe": "Make a person the decider of a roadmap item",
     "args": {"item": "the roadmap item", "person": "the new decider"},
     "build": build_set_decider, "apply": apply_engine},
    {"op": "record_decision", "describe": "Record a decision (in a meeting: the meeting's)",
     "args": {"text": "what was decided", "decider": "who decided (optional)"},
     "build": build_record_decision, "apply": apply_record_decision},
    {"op": "minutes_note", "describe": "Add a note to the meeting's minutes (meeting only)",
     "args": {"text": "the note"}, "build": build_minutes_note, "apply": apply_note},
    {"op": "open_question", "describe": "Add an open question to the minutes (meeting only)",
     "args": {"text": "the question"}, "build": build_open_question, "apply": apply_note},
    {"op": "agenda_next", "describe": "Take a roadmap item next in the meeting (meeting only)",
     "args": {"item": "the roadmap item"}, "build": build_agenda_next, "apply": apply_agenda},
    {"op": "agenda_skip", "describe": "Skip a roadmap item in the meeting (meeting only)",
     "args": {"item": "the roadmap item"}, "build": build_agenda_skip, "apply": apply_agenda},
]  # fmt: skip

# chat-join: the reader offers these ops and chat.apply applies their cards.
chat.join(ACTIONS)
