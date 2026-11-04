"""Ask Oracle does what a person can do (owner, Nov 4): the action catalogue of the API.

**The catalogue** is built from the app's own route table, the same OpenAPI operations
the web calls and ``/mcp`` exposes (oracle.mcp.tools.app_operations), so a route added
later joins it without changes here. Each action has its parameters, whether it reads
(GET) or writes, and the role its route requires (the ``require_role`` dependency the
route declares; a route without one needs a signed-in member). Deny-listed, each with its
reason: what /mcp itself leaves out (sign-in, OAuth, public links, browser-only), and
signing in, tokens, credentials and secrets, member removal, Trash purge, Oracle's own
chat, and what reaches people outside Oracle (notify, send, deliver) and cannot be taken
back.

**In the chats** (oracle.simple.chat's reader): the model is offered the actions the
person's role reaches (``offer``) and answers ``calls`` (``{"action", "args"}``). A read
runs at once, as the person, and a second call words its result in plain words. A write
becomes a card (op ``api_action``) naming what changes; nothing runs until Apply, which
calls the same route as the page would, with the person's own session (so the route's own
checks decide), and records ``simple_chat.api_action`` in the audit log "via Ask Oracle".
A write with an inverse route returns an Undo: a create whose result has an id and a
DELETE of it, an edit (PUT/PATCH) with a GET of the same path (the values before go back),
a delete with a ``/restore``. Any other write's card says it cannot be undone.
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
# Areas (the first path segment after /v1) never offered, with why.
DENIED_AREAS = {
    "auth": "signing in and out",
    "me": "a person's own password, tokens and connected apps",
    "api-tokens": "tokens",
    "claude-accounts": "credentials",
    "connections": "credentials of connected tools",
    "webhooks": "secrets and deliveries to outside systems",
    "settings": "the company's settings, secrets among them",
    "oauth": "OAuth sign-in",
    "mcp": "the MCP endpoint itself",
    "public": "behind a public link, not a member's",
}
# Operations never offered, with why.
DENIED_OPERATIONS = {
    "remove_member": "member removal",
    "disable_member": "member removal",
    "hand_over": "a member's work handed over as they leave",
    "purge_trash_entry": "Trash purge: cannot be undone",
    "create_invite": "an invitation email reaches someone outside Oracle",
}
# Oracle's own chat: a card may not apply, undo or post another chat's line.
CHAT_PATH = re.compile(r"^/v1/simple/(meetings/\{[^}]+\}/)?chats?(/|$)")
# Reaches people or systems outside Oracle: cannot be taken back.
OUTWARD = re.compile(r"(^|_)(notify|send|email|mail|deliver|redeliver)(_|$)")
OUTWARD_WHY = "reaches people outside Oracle and cannot be taken back"
CANNOT_UNDO = "This cannot be undone."
# What the reader is offered of each action (the model's budget).
SUMMARY_MAX = 90
RESULT_MAX = 6000


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

    def offer(self) -> dict[str, Any]:
        out: dict[str, Any] = {"action": self.name, "reads": self.reads}
        said = self.summary[:SUMMARY_MAX]
        if said.lower() != self.name.replace("_", " "):
            out["does"] = said
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

    def for_role(self, role: str) -> list[Action]:
        return [a for a in self.actions.values() if has_role(role, a.needs)]  # type: ignore[arg-type]


def _plain(summary: str) -> str:
    """FastAPI's Title Case summary ("Create Entity") as a sentence ("Create entity")."""
    words = summary.split()
    if words and all(w[:1].isupper() for w in words):
        return " ".join([words[0], *(w.lower() for w in words[1:])])
    return summary


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
    if op.excluded:
        return op.excluded
    if op.operation_id in DENIED_OPERATIONS:
        return DENIED_OPERATIONS[op.operation_id]
    segments = [s for s in op.path.split("/") if s]
    area = segments[1] if segments[:1] == ["v1"] and len(segments) > 1 else segments[:1]
    area = area if isinstance(area, str) else (area[0] if area else "")
    if area in DENIED_AREAS:
        return DENIED_AREAS[area]
    if CHAT_PATH.match(op.path):
        return "Oracle's own chat"
    if op.method != "GET" and OUTWARD.search(op.operation_id):
        return OUTWARD_WHY
    return None


def catalogue(app: FastAPI) -> Catalogue:
    key = tuple(id(r) for r in app.routes)
    cached = getattr(app.state, "ask_catalogue", None)
    if cached is not None and cached[0] == key:
        return cached[1]
    roles = {}
    for r in iter_route_contexts(app.router.routes):
        dependant = getattr(r, "dependant", None)
        if dependant is None:
            continue
        for m in getattr(r, "methods", None) or ():
            roles[(m.upper(), r.path_format)] = _min_role(dependant)
    actions: dict[str, Action] = {}
    denied: dict[str, str] = {}
    for op in tools.app_operations(app):
        why = _denial(op)
        if why is not None:
            denied[op.operation_id] = why
            continue
        actions[op.tool_name] = Action(
            name=op.tool_name, method=op.method, path=op.path, summary=_plain(op.summary),
            reads=op.method == "GET", needs=roles.get((op.method, op.path), "viewer"),
            params=tuple(p.name for p in op.params), body=op.body_media_type is not None,
            op=op,
        )  # fmt: skip
    out = Catalogue(actions, denied)
    app.state.ask_catalogue = (key, out)
    return out


def the_app() -> FastAPI:
    from oracle.main import app

    return app


def offer(role: str) -> list[dict[str, Any]]:
    """What the reader is offered: the actions the role reaches."""
    return [a.offer() for a in catalogue(the_app()).for_role(role)]


def _caller(user: User) -> Any:
    from oracle.mcp.auth import user_caller

    return user_caller(user)


async def _person(db: AsyncSession, principal: Any) -> User:
    user = await db.get(User, principal.user_id)
    assert user is not None
    return user


async def run(db: AsyncSession, principal: Any, action: Action, args: dict[str, Any]) -> Any:
    """The action's route, called as the person (the route's own checks decide)."""
    resp = await tools.call_operation(the_app(), _caller(await _person(db, principal)),
                                      action.op, args)  # fmt: skip
    data: Any = resp.json() if resp.is_json else resp.content.decode(errors="replace")
    if not resp.ok:
        detail = data.get("detail") if isinstance(data, dict) else data
        if isinstance(detail, list) and detail and isinstance(detail[0], dict):
            # A validation error: its first message, without the field paths.
            detail = detail[0].get("msg")
        if isinstance(detail, dict):
            detail = detail.get("message") or json.dumps(detail)
        raise tools.ToolError(str(detail or f"HTTP {resp.status_code}"))
    return data


# --------------------------------------------------------------------------- undo


def _sibling(method: str, path: str) -> Action | None:
    return next((a for a in catalogue(the_app()).actions.values()
                 if a.method == method and a.path == path), None)  # fmt: skip


def inverse(action: Action) -> str | None:
    """How Undo reverses the action: "delete", "restore", "edit", or None (cannot)."""
    if action.method == "POST" and any(
        a.method == "DELETE" and re.fullmatch(re.escape(action.path) + r"/\{[^}/]+\}", a.path)
        for a in catalogue(the_app()).actions.values()
    ):
        return "delete"
    if action.method in ("PUT", "PATCH") and _sibling("GET", action.path):
        return "edit"
    if action.method == "DELETE" and _sibling("POST", action.path + "/restore"):
        return "restore"
    return None


def _words(value: Any) -> str:
    if isinstance(value, dict):
        return ", ".join(f"{k.replace('_', ' ')} {_words(v)}" for k, v in value.items()
                         if v is not None and not _is_id(v))  # fmt: skip
    if isinstance(value, list):
        return ", ".join(_words(v) for v in value if not _is_id(v))
    return f"“{value}”" if isinstance(value, str) else str(value)


def _is_id(v: Any) -> bool:
    try:
        uuid.UUID(str(v))
    except ValueError:
        return False
    return True


def summary(action: Action, args: dict[str, Any]) -> str:
    """The card's line: the action's own name and what it is given (no raw ids)."""
    said = _words(args.get(action.op.body_key)) if action.body else ""
    line = f"{action.summary}: {said}" if said else action.summary
    return line if inverse(action) else f"{line}. {CANNOT_UNDO}"


def card(action: Action, args: dict[str, Any]) -> dict[str, Any]:
    return {"summary": summary(action, args)[:500], "op": OP, "item_id": None,
            "target": {"action": action.name, "args": args},
            "before": {}, "after": {"undo": inverse(action)}}  # fmt: skip


def _result_id(result: Any) -> str | None:
    """The id of what a create made: the result's own, else its one record's."""
    if not isinstance(result, dict):
        return None
    if result.get("id"):
        return str(result["id"])
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


async def apply(db: AsyncSession, principal: Any, c: Any) -> None:
    """Apply: the route as the person; the result kept for Undo, the audit log says how."""
    from oracle.simple import chat

    action = catalogue(the_app()).actions.get(str(c.target.get("action")))
    if action is None:
        raise chat.ChatError(409, "That action is no longer offered")
    args = dict(c.target.get("args") or {})
    how = inverse(action)
    path_args = {p: args[p] for p in action.params if p in args}
    before = None
    try:
        if how == "edit":
            before = await run(db, principal, _sibling("GET", action.path), path_args)  # type: ignore[arg-type]
        result = await run(db, principal, action, args)
    except tools.ToolError as e:
        raise chat.ChatError(409, f"Oracle could not do that: {e}") from e
    c.before = {"values": before} if before is not None else {}
    c.after = {"undo": how, "result_id": _result_id(result)}
    await audit.record(db, principal, "simple_chat.api_action", "simple_chat_card", c.id,
                       {"via": VIA, "action": action.name, "method": action.method,
                        "path": action.path})  # fmt: skip


async def undo(db: AsyncSession, principal: Any, c: Any) -> None:
    from oracle.simple import chat

    cat = catalogue(the_app()).actions
    action = cat.get(str(c.target.get("action")))
    how = (c.after or {}).get("undo")
    if action is None or how is None:
        raise chat.ChatError(409, CANNOT_UNDO)
    args = dict(c.target.get("args") or {})
    path_args = {p: args[p] for p in action.params if p in args}
    try:
        if how == "delete":
            rid = (c.after or {}).get("result_id")
            one = re.escape(action.path) + r"/\{[^}/]+\}"
            back = next(
                a for a in cat.values() if a.method == "DELETE" and re.fullmatch(one, a.path)
            )
            last = back.path.rsplit("{", 1)[-1].rstrip("}")
            await run(db, principal, back, {**path_args, last: rid})
        elif how == "restore":
            await run(db, principal, _sibling("POST", action.path + "/restore"), path_args)  # type: ignore[arg-type]
        else:
            values = (c.before or {}).get("values") or {}
            sent = args.get(action.op.body_key) or {}
            body = {k: values.get(k) for k in sent if isinstance(values, dict) and k in values}
            await run(db, principal, action, {**path_args, action.op.body_key: body})
    except (tools.ToolError, StopIteration) as e:
        raise chat.ChatError(409, f"Oracle could not undo that: {e}") from e
    await audit.record(db, principal, "simple_chat.api_action_undo", "simple_chat_card", c.id,
                       {"via": VIA, "action": action.name})  # fmt: skip


# --------------------------------------------------------------------------- the reader


async def calls(c: Any, answer: dict[str, Any]) -> tuple[list[dict], list[dict], list[str]]:
    """The reader's ``calls``: reads run now (their results), writes as cards, refusals."""
    from oracle.simple import chat

    cat = catalogue(the_app())
    results: list[dict] = []
    cards: list[dict] = []
    refused: list[str] = []
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
            try:
                data = await run(c.db, c.principal, action, args)
            except tools.ToolError as e:
                refused.append(f"I couldn't read that: {chat.plain(str(e))}")
                continue
            text = json.dumps(data, default=str)
            results.append({"action": name, "does": action.summary, "result": text[:RESULT_MAX]})
        else:
            cards.append(card(action, args))
    return results, cards, refused
