"""Ask Oracle does what a person can do (owner, Nov 4): the action catalogue of the API.

**The catalogue** is an allow-list: ``ALLOWED`` names each operation the chats may offer,
with its plain words; each stays inside Oracle and carries no secret. Ask Oracle does what a
person can (owner, Nov 5): a write that sends a Slack message (``PINGS``: a question asked
of someone or reassigned, a decision requested of its approver) is offered, and its card
names each person messaged, by name, and truly whether Slack sends it ("<name> gets a
Slack message asking for a decision and sees it in their Inbox", else "<name> sees it in
their Inbox" and why not); no name, no card. Apply sends exactly that: whom, as the
route decides then, must be whom the card names (else 409). Such a card has no Undo (a
message sent is not taken back). tests/test_ask_oracle_actions.py walks each allowed
route's calls: one reaching a Slack ping, the Slack outbox or the mailer must be in
``PINGS`` with a card naming its recipients. An allowed write still sends the company's own
webhooks, as the same edit on its page does. Every
other route of the app is named in oracle.simple.ask_action_routes (outward or
secret-bearing, with why, or not offered), and a route added later is not offered until
it is allowed here by name (tests/test_ask_oracle_actions.py fails while a route is in
neither). Each action has its parameters, whether it reads (GET) or writes, and the role
its route requires (the ``require_role`` dependency the route declares; a route without
one needs a member).

**In the chats** (oracle.simple.chat's reader): the model is offered the actions the
person's role reaches, in a meeting the role every attendee reaches (``offer``), and
answers ``calls`` (``{"action", "args"}``). A read runs at once and a second call words
its result in plain words. A write becomes a card (op ``api_action``) naming what changes:
each record its path names, and each its body or query points to by id, is read first as the
person and named in the card (no name, no card): by an offered read, or by ``NAME_READS``
(a person, an intake, a document and its versions, a run, a discussion, a request; never
offered themselves); a value that looks like a secret, under a
secret's key or pasted into any text, is never kept in one. In a meeting no read of one
person's own records (``OWN_READS``: their sources) is offered, as everyone there reads the
answer. Nothing runs until Apply, which calls the same route as the page would, with the
person's own session (so the route's own checks decide); the route's own audit rows say
"via Ask Oracle" (oracle.audit.VIA), and the card's ``simple_chat.api_action`` row is
written with the chat's change. Undo is promised only
where it is sure: a create whose route makes a new record (201) and returns its one id,
with a DELETE of it; an edit whose record reads back every field sent; a delete with a
``/restore``. Any other write's card says before Apply that it cannot be undone; so does an
edit sending a dict (``attrs``: the route merges it, so the old dict sent back would keep a
new key), and a create the route answers 202 (a proposal, not the record) has none. Apply
marks the card before it calls the route, so a card whose own write then fails is never
applied twice.
"""

import json
import re
import uuid
from dataclasses import dataclass, field
from typing import Any

from fastapi import FastAPI
from fastapi.routing import iter_route_contexts
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.auth.models import ROLES, User
from oracle.authz import has_role
from oracle.mcp import tools

OP = "api_action"
VIA = "Ask Oracle"
# The operations Ask Oracle may offer, each in plain words: inside Oracle, no secrets.
ALLOWED: dict[str, str] = {
    # Reads
    "list_entities": "Read the product records",
    "get_entity": "Read the product record",
    "list_edges": "Read the links between records",
    "get_edge": "Read the link",
    "list_blockers": "Read the blockers",
    "get_blocker_strategy": "Read the blocker",
    "list_decisions": "Read the decisions",
    "get_decision": "Read the decision",
    "list_knowledge_gaps": "Read the open gaps",
    "get_knowledge_gap": "Read the gap",
    "list_learnings": "Read the learnings",
    "list_outcomes": "Read the outcomes",
    "get_outcome": "Read the outcome",
    "get_priorities": "Read the priorities",
    "list_stakeholder_questions": "Read the questions",
    "get_stakeholder_question": "Read the question",
    "list_sources": "Read the sources",
    "get_source": "Read the source",
    "list_themes": "Read the themes",
    "get_theme": "Read the theme",
    "get_simple_roadmap": "Read the roadmap",
    "get_simple_priorities": "Read the priorities list",
    "get_simple_decisions": "Read the decisions list",
    "list_goal_buckets": "Read the goals and their features",
    "list_simple_changes": "Read the recent changes",
    "list_members": "Read the members",
    "get_member": "Read the member",
    # Writes
    "create_entity": "Add a product record",
    "update_entity": "Change the product record",
    "delete_entity": "Delete the product record",
    "confirm_entity": "Confirm the product record",
    "reject_entity": "Reject the product record",
    "create_edge": "Link two records",
    "update_edge": "Change the link",
    "delete_edge": "Remove the link",
    "create_blocker": "Add a blocker",
    "update_blocker": "Change the blocker",
    "update_decision": "Change the decision",
    "create_knowledge_gap": "Add a gap",
    "update_knowledge_gap": "Change the gap",
    "create_learning": "Add a learning",
    "create_outcome": "Add an outcome",
    "update_outcome": "Change the outcome",
    "create_theme": "Add a theme",
    # Each pings a person by Slack: its card names them (``PINGS``).
    "create_decision": "Request a decision",
    "create_question": "Ask a question",
    "update_question": "Change the question",
    "update_theme": "Change the theme",
    "archive_theme": "Archive the theme",
    "restore_theme": "Bring back the theme",
    "delete_source": "Delete the source",
}
# The writes that send a Slack message (oracle.slack.pings), with the body field that
# names whom, and what the message does: the card names each of them, by name.
PINGS: dict[str, tuple[str, str]] = {
    "create_decision": ("approver_id", "asking for a decision"),
    "create_question": ("asked_to", "with the question"),
    "update_question": ("asked_to", "with the question"),
}
PINGED_CHANGED = "Whom this card messages has changed since it was made; ask again."
# The reads that name a record a write points to by id but the chat does not offer
# (operation id), each called as the person: a person (the member picker, which any
# member may read), an intake, a document, a run, a discussion, a request; a document
# version (a PRD's, a roadmap's) is named by its document and number.
NAME_READS = {
    "person": "list_people", "intake": "get_intake", "document": "get_document",
    "run": "get_run", "discussion": "get_discussion", "request": "get_request",
}  # fmt: skip
# A body field's stem -> the kind of record it names.
KINDS = {
    "asked_to": "person", "approver": "person", "contributor": "person", "informed": "person",
    "owner": "person", "author": "person", "intake": "intake", "document": "document",
    "prd_version": "version", "roadmap_version": "version", "document_version": "version",
    "run": "run", "discussion": "discussion", "request": "request",
}  # fmt: skip
NOT_OFFERED_WHY = "not offered in the chat"
NEW_ROUTE_WHY = "a new route: not offered until it is allowed by name"
# Oracle's own chat: a card may not apply, undo or post another chat's line.
CHAT_PATH = re.compile(r"^/v1/simple/(meetings/\{[^}]+\}/)?chats?(/|$)")
# A key that names a secret: such a value is never kept in a card or shown.
SECRET = re.compile(r"(api_?key|secret|password|passwd|credential|private_?key|authorization"
                    r"|(^|_)token$)", re.I)  # fmt: skip
# What names a record read back for its card.
NAME_FIELDS = ("title", "name", "label", "display_name", "key", "email", "prompt")
CANNOT_UNDO = "This cannot be undone."
NO_NAME = "I can't tell which record that changes, so I made no card."
SECRET_WHY = "a value that looks like a secret is never kept in the chat."
# A value that looks like a pasted key or token (well-known prefixes, a JWT, a private key,
# or a long run of letters and digits; never a UUID, never a hyphenated key).
SECRET_VALUE = re.compile(
    r"(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}"
    r"|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|bearer\s+\S{16,}"
    r"|-----BEGIN [A-Z ]*PRIVATE KEY|(?<![A-Za-z0-9_+/=-])(?=[A-Za-z0-9_+/=]*\d)"
    r"(?=[A-Za-z0-9_+/=]*[A-Za-z])[A-Za-z0-9_+/=]{32,})",
    re.I,
)
# Reads of one person's own records (filtered by owner): never in a meeting's chat.
OWN_READS = frozenset({"list_sources", "get_source"})
OWN_WHY = "only you read your own sources, so not in a meeting's chat."
APPLYING = "This card was applied already"
# A body field's words on a card (its "_id" dropped).
FIELD_WORDS = {"src": "from", "dst": "to", "prd_version": "PRD version"}
# What the reader is offered of each action (the model's budget).
SUMMARY_MAX = 90
RESULT_MAX = 6000


class Refusal(Exception):
    """A write that gets no card, with why in plain words."""


@dataclass(frozen=True)
class Action:
    name: str
    method: str
    path: str
    summary: str
    reads: bool
    # The role the route requires ("viewer": any signed-in member).
    needs: str
    params: tuple[str, ...]
    body: bool
    op: tools.Operation = field(repr=False, compare=False)
    # The route answers 201: each call makes a new record.
    creates: bool = False

    def offer(self) -> dict[str, Any]:
        out: dict[str, Any] = {"action": self.name, "reads": self.reads}
        out["does"] = self.summary[:SUMMARY_MAX]
        if self.params:
            out["params"] = list(self.params)
        if self.body:
            out["body"] = body_fields(self.op)
        return out


@dataclass(frozen=True)
class Catalogue:
    actions: dict[str, Action]
    # operation id -> why it is not an action.
    denied: dict[str, str]
    # ``NAME_READS``' kind -> its read (never offered: it only names a card's record).
    namers: dict[str, Action] = field(default_factory=dict)

    def for_role(self, role: str) -> list[Action]:
        return [a for a in self.actions.values() if has_role(role, a.needs)]  # type: ignore[arg-type]


def body_fields(op: tools.Operation) -> list[str]:
    """The top-level fields of the action's JSON body (``body``: the model fills them)."""
    schema = op.body_schema or {}
    ref = schema.get("$ref", "")
    if ref.startswith("#/components/schemas/"):
        schema = op.components.get(ref.rsplit("/", 1)[-1], {})
    return list(schema.get("properties") or {})[:20]


def _min_role(dependant: Any) -> str:
    """The highest ``require_role`` the route's dependencies declare."""
    best = 0
    stack = [dependant]
    while stack:
        d = stack.pop()
        role = getattr(d.call, "min_role", None) if d.call is not None else None
        if role in ROLES:
            best = max(best, ROLES.index(role))
        stack.extend(d.dependencies)
    return ROLES[best]


def _denial(op: tools.Operation) -> str | None:
    """Why the operation is not offered (None: it is in ``ALLOWED``)."""
    from oracle.simple.ask_action_routes import NOT_OFFERED, OUTWARD_OR_SECRET

    if op.operation_id in OUTWARD_OR_SECRET:
        return OUTWARD_OR_SECRET[op.operation_id]
    if op.operation_id not in ALLOWED:
        return NOT_OFFERED_WHY if op.operation_id in NOT_OFFERED else NEW_ROUTE_WHY
    if op.excluded:
        return op.excluded
    if CHAT_PATH.match(op.path):
        return "Oracle's own chat"
    return None


def catalogue(app: FastAPI) -> Catalogue:
    key = tuple(id(r) for r in app.routes)
    cached = getattr(app.state, "ask_catalogue", None)
    if cached is not None and cached[0] == key:
        return cached[1]
    roles, created = {}, set()
    for r in iter_route_contexts(app.router.routes):
        dependant = getattr(r, "dependant", None)
        if dependant is None:
            continue
        for m in getattr(r, "methods", None) or ():
            roles[(m.upper(), r.path_format)] = _min_role(dependant)
            if getattr(r, "status_code", None) == 201:
                created.add((m.upper(), r.path_format))
    actions: dict[str, Action] = {}
    denied: dict[str, str] = {}
    namers: dict[str, Action] = {}
    for op in tools.app_operations(app):
        for kind, op_id in NAME_READS.items():
            if op.operation_id == op_id and op.method == "GET":
                namers[kind] = Action(
                    name=op.tool_name, method=op.method, path=op.path, summary="", reads=True,
                    needs=roles.get((op.method, op.path), "viewer"),
                    params=tuple(p.name for p in op.params), body=False, op=op,
                )  # fmt: skip
        why = _denial(op)
        if why is not None:
            denied[op.operation_id] = why
            continue
        actions[op.tool_name] = Action(
            name=op.tool_name, method=op.method, path=op.path,
            summary=ALLOWED[op.operation_id], reads=op.method == "GET",
            needs=roles.get((op.method, op.path), "viewer"),
            params=tuple(p.name for p in op.params), body=op.body_media_type is not None,
            op=op, creates=(op.method, op.path) in created,
        )  # fmt: skip
    out = Catalogue(actions, denied, namers)
    app.state.ask_catalogue = (key, out)
    return out


def the_app() -> FastAPI:
    from oracle.main import app

    return app


def offer(role: str, reach: str | None = None, meeting: bool = False) -> list[dict[str, Any]]:
    """What the reader is offered: the actions the role reaches; reads only those ``reach``
    (in a meeting, every attendee's role: :func:`reach_role`) reaches too, and in a meeting
    none of ``OWN_READS``."""
    return [a.offer() for a in catalogue(the_app()).for_role(role)
            if not a.reads or (has_role(reach or role, a.needs)  # type: ignore[arg-type]
                               and not (meeting and a.name in OWN_READS))]  # fmt: skip


async def reach_role(db: AsyncSession, principal: Any, meeting: Any) -> str:
    """The role whose reads the chat offers: the asker's; in a meeting, the lowest of every
    attendee's (each of them reads the answer), read again now (attendees change)."""
    if meeting is None:
        return principal.role
    from sqlalchemy import select

    from oracle.simple.models import SimpleMeeting

    ids = {meeting.presenter_id, *(getattr(meeting, "attendee_ids", None) or [])}
    mid = getattr(meeting, "meeting_id", None)
    row = await db.get(SimpleMeeting, mid, populate_existing=True) if mid else None
    if row is not None:
        ids |= {row.presenter_id, *(row.attendee_ids or [])}
    ids -= {None}
    found = list(await db.scalars(select(User.role).where(User.id.in_(ids)))) if ids else []
    return min([principal.role, *found], key=lambda r: ROLES.index(r) if r in ROLES else 0)


def _caller(user: User) -> Any:
    from oracle.mcp.auth import user_caller

    return user_caller(user)


async def _person(db: AsyncSession, principal: Any) -> User:
    from oracle.simple import chat

    user = await db.get(User, principal.user_id) if principal.user_id else None
    if user is None or user.disabled_at is not None:
        raise chat.ChatError(403, "Only a signed-in member asks Oracle to act")
    return user


async def run(db: AsyncSession, principal: Any, action: Action, args: dict[str, Any]) -> Any:
    """The action's route, called as the person (the route's own checks decide); its own
    audit rows say it came via Ask Oracle."""
    return (await call(db, principal, action, args))[1]


async def call(
    db: AsyncSession, principal: Any, action: Action, args: dict[str, Any]
) -> tuple[int, Any]:
    """:func:`run`, with the route's status code."""
    user = await _person(db, principal)
    token = audit.VIA.set(VIA) if not action.reads else None
    try:
        resp = await tools.call_operation(the_app(), _caller(user), action.op, args)
    finally:
        if token is not None:
            audit.VIA.reset(token)
    data: Any = resp.json() if resp.is_json else resp.content.decode(errors="replace")
    if not resp.ok:
        detail = data.get("detail") if isinstance(data, dict) else data
        if isinstance(detail, list) and detail and isinstance(detail[0], dict):
            # A validation error: its first message, without the field paths.
            detail = detail[0].get("msg")
        if isinstance(detail, dict):
            detail = detail.get("message") or json.dumps(detail)
        raise tools.ToolError(str(detail or f"HTTP {resp.status_code}"))
    return resp.status_code, data


# --------------------------------------------------------------------------- naming, undo


def _norm(path: str) -> str:
    return re.sub(r"\{[^}/]+\}", "{}", path)


def _at(method: str, path: str) -> Action | None:
    """The offered action of this method at this path (path parameters' names aside)."""
    want = _norm(path)
    return next((a for a in catalogue(the_app()).actions.values()
                 if a.method == method and _norm(a.path) == want), None)  # fmt: skip


def _path_params(path: str) -> list[str]:
    return re.findall(r"\{([^}/]+)\}", path)


def _args_for(other: Action, values: list[Any]) -> dict[str, Any]:
    """``other``'s path parameters given by position (its names may differ)."""
    return dict(zip(_path_params(other.path), values, strict=False))


def _deleter(action: Action) -> Action | None:
    one = re.escape(_norm(action.path)) + r"/\{\}"
    return next((a for a in catalogue(the_app()).actions.values()
                 if a.method == "DELETE" and re.fullmatch(one, _norm(a.path))), None)  # fmt: skip


def _sent(action: Action, args: dict[str, Any]) -> dict[str, Any]:
    body = args.get(action.op.body_key) if action.body else None
    return body if isinstance(body, dict) else {}


def _reads_back(before: Any, sent: dict[str, Any]) -> bool:
    """Each field sent reads back, and none is a dict (the route merges one: sending the
    old dict back would keep a key the edit added)."""
    return (bool(sent) and isinstance(before, dict) and all(k in before for k in sent)
            and not any(isinstance(v, dict) for v in sent.values()))  # fmt: skip


def inverse(action: Action, args: dict[str, Any] | None = None, before: Any = None) -> str | None:
    """How Undo reverses the action: "delete", "restore", "edit", or None (cannot). A create
    only when its route makes a new record each time; an edit only when the record as read
    (``before``) has every field sent."""
    if action.method == "POST" and action.creates and _deleter(action) is not None:
        return "delete"
    if action.method in ("PUT", "PATCH") and _at("GET", action.path) is not None:
        return "edit" if _reads_back(before, _sent(action, args or {})) else None
    if action.method == "DELETE" and _at("POST", action.path + "/restore") is not None:
        return "restore"
    return None


def _name_of(data: Any) -> str | None:
    if not isinstance(data, dict):
        return None
    for k in NAME_FIELDS:
        v = data.get(k)
        if isinstance(v, str) and v.strip() and not _is_id(v):
            return v.strip()
    inner = [v for v in data.values() if isinstance(v, dict)]
    return _name_of(inner[0]) if len(inner) == 1 else None


async def _named(
    db: AsyncSession, principal: Any, action: Action, args: dict[str, Any]
) -> tuple[list[str], Any]:
    """Each record the action's path names, read as the person and named; and the record
    at the action's own path as read (an edit's values before). Refusal when one cannot
    be named."""
    names: list[str] = []
    record: Any = None
    params = _path_params(action.path)
    for i, p in enumerate(params):
        if p not in args:
            raise Refusal(NO_NAME)
        prefix = action.path[: action.path.index("{" + p + "}") + len(p) + 2]
        reader = _at("GET", prefix)
        if reader is None:
            raise Refusal(NO_NAME)
        try:
            data = await run(db, principal, reader,
                             _args_for(reader, [args[q] for q in params[: i + 1]]))  # fmt: skip
        except tools.ToolError as e:
            raise Refusal(NO_NAME) from e
        name = _name_of(data)
        if name is None:
            raise Refusal(NO_NAME)
        names.append(name)
        if _norm(prefix) == _norm(action.path):
            record = data
    if record is None and action.method in ("PUT", "PATCH"):
        reader = _at("GET", action.path)
        if reader is not None:
            try:
                record = await run(db, principal, reader,
                                   _args_for(reader, [args[q] for q in params]))  # fmt: skip
            except tools.ToolError:
                record = None
    return names, record


def _ids(value: Any, key: str = "") -> list[tuple[str, str]]:
    """Each (field, id) a value points to, nested ones too."""
    if isinstance(value, dict):
        # A subject ({"kind": "document", "id": ...}): its id is of that kind.
        kind = value.get("kind") if isinstance(value.get("kind"), str) else None
        return [x for k, v in value.items()
                for x in _ids(v, f"{kind}_id" if kind and k == "id" else str(k))]  # fmt: skip
    if isinstance(value, list):
        return [x for v in value for x in _ids(v, key)]
    return [(key, str(value))] if isinstance(value, str) and _is_id(value) else []


def _stem(key: str) -> str:
    return re.sub(r"_ids?$", "", key)


def _readers(action: Action, key: str) -> list[Action]:
    """The offered reads of one record by its id, likeliest first for ``key``."""
    own = action.path.rstrip("/").split("/{")[0]
    stem = _stem(key)

    def rank(a: Action) -> int:
        p = _path_params(a.path)[0]
        if p == key or (stem and p == f"{stem}_id"):
            return 0
        if stem and stem in a.path.rsplit("/{", 1)[0].rsplit("/", 1)[-1]:
            return 1
        return 2 if a.path.startswith(own + "/{") else 3

    one = [a for a in catalogue(the_app()).actions.values()
           if a.reads and len(_path_params(a.path)) == 1 and a.path.endswith("}")]  # fmt: skip
    return sorted(one, key=rank)


async def _id_names(
    db: AsyncSession, principal: Any, action: Action, args: dict[str, Any]
) -> dict[str, str]:
    """Each id the action's body or query points to, read as the person and named
    (Refusal when one cannot be)."""
    path = set(_path_params(action.path))
    out: dict[str, str] = {}
    for key, rid in _ids({k: v for k, v in args.items() if k not in path}):
        if rid in out:
            continue
        kind = KINDS.get(_stem(key))
        if kind is not None:
            name = await _name_by_kind(db, principal, kind, rid)
            if name is None:
                raise Refusal(NO_NAME)
            out[rid] = name
            continue
        for reader in _readers(action, key):
            try:
                data = await run(db, principal, reader, _args_for(reader, [rid]))
            except tools.ToolError:
                continue
            name = _name_of(data)
            if name is not None:
                out[rid] = name
                break
        else:
            raise Refusal(NO_NAME)
    return out


async def _name_by_kind(db: AsyncSession, principal: Any, kind: str, rid: str) -> str | None:
    """The record's name, read as the person: a person's name (never an id), an intake's or
    a document's title, a document version as its document's title and number."""
    namers = catalogue(the_app()).namers
    try:
        if kind == "person":
            data = await run(db, principal, namers["person"], {"ids": [rid]})
            one = (
                [p for p in data if str(p.get("user_id")) == rid] if isinstance(data, list) else []
            )
            return _name_of({"name": one[0].get("name")}) if len(one) == 1 else None
        if kind == "version":
            from sqlalchemy import select

            from oracle.docs.models import DocumentVersion

            cols = select(DocumentVersion.document_id, DocumentVersion.number)
            row = (await db.execute(cols.where(DocumentVersion.id == uuid.UUID(rid)))).first()
            if row is None:
                return None
            title = await _name_by_kind(db, principal, "document", str(row.document_id))
            return f"{title} version {row.number}" if title else None
        reader = namers.get(kind)
        if reader is None:
            return None
        data = await run(db, principal, reader, _args_for(reader, [rid]))
        if kind == "run" and isinstance(data, dict):
            # A run has no title: its flow and its document's ("Draft of Saved addresses").
            flow, doc = data.get("flow_title"), data.get("document_title")
            return f"{flow} of {doc}" if flow and doc else None
        return _name_of(data)
    except tools.ToolError:
        return None


def _pinged(principal: Any, action: Action, args: dict[str, Any], record: Any) -> list[str]:
    """Whom the write sends a Slack message (``PINGS``), as the route decides: never the
    person acting; a question reassigned to whom it is asked already pings no one."""
    if action.name not in PINGS:
        return []
    who = _sent(action, args).get(PINGS[action.name][0])
    if not isinstance(who, str) or not _is_id(who) or who == str(principal.user_id or ""):
        return []
    if action.method == "PATCH" and isinstance(record, dict) and str(record.get("asked_to")) == who:
        return []
    return [who]


def _field(key: str) -> str:
    stem = _stem(key) if key.endswith(("_id", "_ids")) else key
    return FIELD_WORDS.get(stem, stem).replace("_", " ")


def _words(value: Any, names: dict[str, str] | None = None) -> str:
    names = names or {}
    if isinstance(value, dict):
        return ", ".join(f"{_field(k)} {_words(v, names)}" for k, v in value.items()
                         if v is not None and (not _is_id(v) or str(v) in names))  # fmt: skip
    if isinstance(value, list):
        return ", ".join(_words(v, names) for v in value if not _is_id(v) or str(v) in names)
    if isinstance(value, str) and value in names:
        return f"“{names[value]}”"
    return f"“{value}”" if isinstance(value, str) else str(value)


def _is_id(v: Any) -> bool:
    try:
        uuid.UUID(str(v))
    except ValueError:
        return False
    return True


def _secret(value: Any) -> bool:
    """A key that names a secret, or a value that looks like one (a token pasted in text)."""
    if isinstance(value, dict):
        return any(SECRET.search(str(k)) or _secret(v) for k, v in value.items())
    if isinstance(value, list):
        return any(_secret(v) for v in value)
    if isinstance(value, str):
        return any(not _is_id(m.group(0)) for m in SECRET_VALUE.finditer(value))
    return False


async def slack_reach(db: AsyncSession, pinged: list[str]) -> dict[str, str]:
    """Whether each person pinged gets the Slack message, as pings.queue decides it: "on",
    "off" (they turned review-requested pings off) or "none" (Slack is not connected)."""
    from oracle.integrations import slack_oauth
    from oracle.slack import pings

    if not pinged:
        return {}
    install = await slack_oauth.installed(db)
    if install is None or install.status != "active":
        return dict.fromkeys(pinged, "none")
    chosen = await pings._chosen(db, [uuid.UUID(p) for p in pinged])
    return {p: "on" if chosen[uuid.UUID(p)]["review_requested"] else "off" for p in pinged}


def _ping_words(action: Action, name: str, reach: str) -> str:
    if reach == "on":
        return f"{name} gets a Slack message {PINGS[action.name][1]} and sees it in their Inbox."
    if reach == "off":
        return f"{name} sees it in their Inbox; they turned these Slack messages off."
    return f"{name} sees it in their Inbox; Slack is not connected."


def summary(
    action: Action, args: dict[str, Any], names: list[str], how: str | None,
    ids: dict[str, str] | None = None, pinged: list[str] | None = None,
    reach: dict[str, str] | None = None,
) -> str:  # fmt: skip
    """The card's line in plain words: what it does, to which named record, with what (each
    record an id points to by its name); whom it messages, by name, and truly whether Slack
    sends it (``reach``: slack_reach); and before Apply, when it cannot be undone. Kept
    under 500 characters, the message's words whole."""
    line = action.summary + "".join(f" “{n}”" for n in names)
    said = _words(_sent(action, args), ids)
    line = f"{line}: {said}" if said else line
    tail = "".join(
        f" {_ping_words(action, (ids or {})[p], (reach or {}).get(p, 'none'))}"
        for p in pinged or []
    )
    tail += "" if how else f" {CANNOT_UNDO}"
    return f"{line[: 499 - len(tail)]}.{tail}"


async def card(db: AsyncSession, principal: Any, action: Action, args: dict[str, Any]) -> dict:
    """The write's card, its records named (Refusal: no card)."""
    if _secret(args):
        raise Refusal(f"I can't do that from the chat: {SECRET_WHY}")
    names, record = await _named(db, principal, action, args)
    ids = await _id_names(db, principal, action, args)
    pinged = _pinged(principal, action, args, record)
    if any(p not in ids for p in pinged):
        raise Refusal(NO_NAME)
    # A message sent cannot be taken back: a card that sends one promises no Undo.
    how = None if action.name in PINGS else inverse(action, args, record)
    reach = await slack_reach(db, pinged)
    said = summary(action, args, names, how, ids, pinged, reach)
    return {"summary": said, "op": OP, "item_id": None,
            "target": {"action": action.name, "args": args, "names": names, "ids": ids,
                       "pinged": pinged},
            "before": {}, "after": {"undo": how}}  # fmt: skip


def _result_id(result: Any, back: Action | None) -> str | None:
    """The one id a create returned (its own, else its one record's; never a list's),
    for its DELETE's last parameter."""
    if back is None or not isinstance(result, dict):
        return None
    last = _path_params(back.path)[-1] if _path_params(back.path) else ""
    if not (last == "id" or last.endswith("_id")):
        return None
    if result.get("id"):
        return str(result["id"])
    if any(isinstance(v, list) for v in result.values()):
        return None
    inner = [v["id"] for v in result.values() if isinstance(v, dict) and v.get("id")]
    return str(inner[0]) if len(inner) == 1 else None


def bar(principal: Any, c: Any) -> str | None:
    """Why the caller may not apply (or undo) this action's card: its route's role."""
    from oracle.simple import chat

    if c.owner_id is not None and c.owner_id != chat._me(principal):
        return "This card is someone else's"
    action = catalogue(the_app()).actions.get(str((c.target or {}).get("action")))
    if action is None:
        return "That action is no longer offered"
    if not has_role(principal.role, action.needs):  # type: ignore[arg-type]
        return f"{action.summary} needs the {action.needs} role"
    return None


async def _commit_now(db: AsyncSession) -> None:
    """A real commit, inside a meeting's one commit too (oracle.simple.changes_router.
    _one_commit makes ``db.commit`` a flush): the route has committed its write in its own
    session already, so the card's mark may not wait for the rest."""
    await type(db).commit(db)


async def apply(db: AsyncSession, principal: Any, c: Any) -> None:
    """Apply: the route as the person; the result kept for Undo, the audit log says how."""
    from oracle.simple import chat

    action = catalogue(the_app()).actions.get(str(c.target.get("action")))
    if action is None:
        raise chat.ChatError(409, "That action is no longer offered")
    args = dict(c.target.get("args") or {})
    if _secret(args):
        raise chat.ChatError(409, SECRET_WHY)
    was = dict(c.after or {})
    if was.get("applying"):
        raise chat.ChatError(409, APPLYING)
    promised = was.get("undo")
    path_args = {p: args[p] for p in _path_params(action.path) if p in args}
    before = None
    # Marked before the route runs, in its own commit: should the card's write fail after
    # the route's, the card is never applied a second time.
    if action.name in PINGS:
        # Apply sends exactly the messages the card names: whom, as the route decides now.
        record = None
        if action.method in ("PUT", "PATCH") and _at("GET", action.path) is not None:
            reader = _at("GET", action.path)
            try:
                record = await run(db, principal, reader,  # type: ignore[arg-type]
                                   _args_for(reader, list(path_args.values())))  # type: ignore[arg-type]  # fmt: skip
            except tools.ToolError as e:
                raise chat.ChatError(409, f"Oracle could not do that: {e}") from e
        if _pinged(principal, action, args, record) != list(c.target.get("pinged") or []):
            raise chat.ChatError(409, PINGED_CHANGED)
        promised = None
    c.after = {**was, "applying": True}
    await _commit_now(db)
    try:
        if promised == "edit":
            reader = _at("GET", action.path)
            before = await run(db, principal, reader,  # type: ignore[arg-type]
                               _args_for(reader, list(path_args.values())))  # type: ignore[arg-type]  # fmt: skip
        code, result = await call(db, principal, action, args)
    except tools.ToolError as e:
        c.after = was
        await _commit_now(db)
        raise chat.ChatError(409, f"Oracle could not do that: {e}") from e
    # 202: a proposal, not the record; nothing of it to undo.
    how = promised if code != 202 else None
    rid = None
    if how == "edit" and not _reads_back(before, _sent(action, args)):
        how = None
    if how == "delete":
        rid = _result_id(result, _deleter(action))
        how = how if rid else None
    c.before = {"values": before} if before is not None else {}
    c.after = {"undo": how, "result_id": rid}
    await audit.record(db, principal, "simple_chat.api_action", "simple_chat_card", c.id,
                       {"via": VIA, "action": action.name, "method": action.method,
                        "path": action.path, "summary": c.summary})  # fmt: skip


async def undo(db: AsyncSession, principal: Any, c: Any) -> None:
    from oracle.simple import chat

    action = catalogue(the_app()).actions.get(str(c.target.get("action")))
    how = (c.after or {}).get("undo")
    if action is None or how is None:
        raise chat.ChatError(409, CANNOT_UNDO)
    args = dict(c.target.get("args") or {})
    path_args = {p: args[p] for p in _path_params(action.path) if p in args}
    try:
        if how == "delete":
            back = _deleter(action)
            rid = (c.after or {}).get("result_id")
            if back is None or not rid:
                raise chat.ChatError(409, CANNOT_UNDO)
            await run(db, principal, back, _args_for(back, [*path_args.values(), rid]))
        elif how == "restore":
            back = _at("POST", action.path + "/restore")
            if back is None:
                raise chat.ChatError(409, CANNOT_UNDO)
            await run(db, principal, back, _args_for(back, list(path_args.values())))
        else:
            values = (c.before or {}).get("values") or {}
            sent = _sent(action, args)
            if not _reads_back(values, sent):
                raise chat.ChatError(409, CANNOT_UNDO)
            body = {k: values[k] for k in sent}
            await run(db, principal, action, {**path_args, action.op.body_key: body})
    except tools.ToolError as e:
        raise chat.ChatError(409, f"Oracle could not undo that: {e}") from e
    await audit.record(db, principal, "simple_chat.api_action_undo", "simple_chat_card", c.id,
                       {"via": VIA, "action": action.name})  # fmt: skip


# --------------------------------------------------------------------------- the reader


async def calls(c: Any, answer: dict[str, Any]) -> tuple[list[dict], list[dict], list[str]]:
    """The reader's ``calls``: reads run now (their results), writes as cards, refusals. A
    read in a meeting runs only when every attendee's role reaches it."""
    from oracle.simple import chat

    cat = catalogue(the_app())
    results: list[dict] = []
    cards: list[dict] = []
    refused: list[str] = []
    reach = await reach_role(c.db, c.principal, c.meeting)
    for x in (answer.get("calls") or [])[:5]:
        if not isinstance(x, dict):
            continue
        name = str(x.get("action") or "")
        args = x.get("args") if isinstance(x.get("args"), dict) else {}
        action = cat.actions.get(name)
        if action is None:
            why = next((w for o, w in cat.denied.items() if tools.snake_case(o) == name), None)
            refused.append(f"I can't do that from the chat ({why})." if why
                           else "I can't do that from the chat.")  # fmt: skip
            continue
        if not has_role(c.principal.role, action.needs):  # type: ignore[arg-type]
            refused.append(f"{action.summary} needs the {action.needs} role; you are "
                           f"{'an' if c.principal.role[0] in 'aeiou' else 'a'} "
                           f"{c.principal.role}.")  # fmt: skip
            continue
        if action.reads:
            if c.meeting is not None and name in OWN_READS:
                refused.append(f"{action.summary}: {OWN_WHY}")
                continue
            if not has_role(reach, action.needs):  # type: ignore[arg-type]
                refused.append(f"{action.summary}: not in this meeting's chat, as everyone "
                               "here reads the answer.")  # fmt: skip
                continue
            try:
                data = await run(c.db, c.principal, action, args)
            except tools.ToolError as e:
                refused.append(f"I couldn't read that: {chat.plain(str(e))}")
                continue
            text = json.dumps(data, default=str)
            results.append({"action": name, "does": action.summary, "result": text[:RESULT_MAX]})
        else:
            try:
                cards.append(await card(c.db, c.principal, action, args))
            except Refusal as e:
                refused.append(str(e))
    return results, cards, refused
