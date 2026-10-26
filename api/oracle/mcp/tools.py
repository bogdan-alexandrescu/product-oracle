"""One MCP tool per OpenAPI operation of the app, executed as an in-process REST call.

Tools are read from the live route table, so a route added later becomes a tool
without changes here. A call goes through the whole app (middleware, dependencies,
role checks) with the caller's credentials, so MCP can do exactly what REST allows.
"""

import base64
import copy
import json
import re
import uuid
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import date
from typing import Any
from urllib.parse import quote, unquote

import httpx
import mcp_types as types
from fastapi import FastAPI
from fastapi.routing import iter_route_contexts
from starlette.routing import Match

from oracle.auth.deps import READ_ONLY
from oracle.mcp import scopes
from oracle.mcp.auth import McpCaller

HTTP_METHODS = ("get", "post", "put", "patch", "delete")
# Signing in and out belongs to browsers; an MCP client already holds a credential.
# A5: a Google-signed person's own access state and note: the browser only.
EXCLUDED_OPERATIONS = {"login", "logout", "get_access_state", "send_access_note"}
# Live streams, and what a client that cannot read one calls instead.
STREAM_OPERATIONS = {
    "stream_discussion_reply": "a live stream; call create_discussion_message with wait=true",
}
# Only from the signed-in browser (AC1, owner 2026-10-20): a credential never mints
# another, changes the password or signs its person out everywhere.
BROWSER_ONLY_OPERATIONS = {"create_personal_token", "change_password", "sign_out_everywhere"}
# The interviewee's own routes behind a private interview link (C3): no member credential.
PUBLIC_OPERATIONS = {
    "public_interview",
    "public_interview_message",
    "public_interview_skip",
    "public_interview_finish",
}
INTERNAL_BASE_URL = "http://oracle.internal"


@dataclass(frozen=True)
class Param:
    name: str
    location: str  # "path" | "query"
    schema: dict[str, Any]
    required: bool
    description: str | None = None


@dataclass(frozen=True)
class Operation:
    operation_id: str
    method: str  # upper case
    path: str
    summary: str
    description: str
    tags: tuple[str, ...]
    params: tuple[Param, ...]
    # Media type of the request body, None without one.
    body_media_type: str | None = None
    body_schema: dict[str, Any] | None = None
    body_required: bool = False
    body_description: str | None = None
    # Why this operation is not a tool; None when it is one.
    excluded: str | None = None
    components: dict[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @property
    def tool_name(self) -> str:
        return snake_case(self.operation_id)

    @property
    def body_key(self) -> str:
        names = {p.name for p in self.params}
        return "body" if "body" not in names else "request_body"

    def input_schema(self) -> dict[str, Any]:
        properties: dict[str, Any] = {}
        required: list[str] = []
        for p in self.params:
            prop = copy.deepcopy(p.schema)
            if p.description and "description" not in prop:
                prop["description"] = p.description
            properties[p.name] = prop
            if p.required:
                required.append(p.name)
        if self.body_media_type is not None:
            body = copy.deepcopy(self.body_schema or {})
            if self.body_media_type != "application/json":
                body = {"type": "string"}
                body["description"] = f"Request body ({self.body_media_type})"
            elif self.body_description and "description" not in body:
                body["description"] = self.body_description
            properties[self.body_key] = body
            if self.body_required:
                required.append(self.body_key)
        schema: dict[str, Any] = {"type": "object", "properties": properties}
        if required:
            schema["required"] = required
        return _inline_refs(schema, self.components)

    def tool_description(self) -> str:
        parts = [self.summary, self.description] if self.description else [self.summary]
        parts.append(f"REST: {self.method} {self.path}.")
        return "\n\n".join(p for p in parts if p)


def snake_case(name: str) -> str:
    name = re.sub(r"(?<=[a-z0-9])([A-Z])", r"_\1", name)
    name = re.sub(r"[^0-9a-zA-Z]+", "_", name).strip("_").lower()
    return name or "operation"


# Non-text/* media types whose body is still text: the tool takes it as a string.
TEXT_BODY_MEDIA_TYPES = frozenset({"application/yaml", "application/x-yaml"})


def _exclusion(op_id: str, path: str, tags: Iterable[str], media: str | None) -> str | None:
    if op_id in EXCLUDED_OPERATIONS:
        return "browser sign-in; MCP clients authenticate with a bearer token"
    if op_id in PUBLIC_OPERATIONS:
        return "for the interviewee's browser behind a private interview link"
    if op_id in BROWSER_ONLY_OPERATIONS:
        return "from the signed-in browser only (My account)"
    if op_id in STREAM_OPERATIONS:
        return STREAM_OPERATIONS[op_id]
    segments = [s for s in path.split("/") if s]
    if segments[:1] == ["mcp"]:
        return "the MCP endpoint itself"
    if (
        "oauth" in segments
        # A provider's OAuth redirect back to Oracle (connections): browser only.
        or segments[-1:] == ["callback"]
        or (segments and segments[0].startswith(".well-known"))
        or any("oauth" in t.lower() for t in tags)
    ):
        return "OAuth flow endpoint"
    if media is not None and media.startswith("multipart/"):
        return "multipart upload; use the REST API"
    if (
        media is not None
        and media != "application/json"
        and not media.startswith("text/")
        and media not in TEXT_BODY_MEDIA_TYPES
    ):
        return f"{media} request body; use the REST API"
    return None


def _inline_refs(schema: dict[str, Any], components: dict[str, Any]) -> dict[str, Any]:
    """Point ``#/components/schemas/X`` refs at ``#/$defs/X`` and carry those defs along."""
    defs: dict[str, Any] = {}
    prefix = "#/components/schemas/"

    def walk(node: Any) -> Any:
        if isinstance(node, dict):
            out = {}
            for k, v in node.items():
                if k == "$ref" and isinstance(v, str) and v.startswith(prefix):
                    name = v[len(prefix) :]
                    if name not in defs and name in components:
                        defs[name] = {}  # placeholder: stops cycles
                        defs[name] = walk(components[name])
                    out[k] = "#/$defs/" + name
                else:
                    out[k] = walk(v)
            return out
        if isinstance(node, list):
            return [walk(v) for v in node]
        return node

    result = walk(schema)
    if defs:
        result["$defs"] = defs
    return result


def operations_from_openapi(doc: dict[str, Any]) -> list[Operation]:
    components = doc.get("components", {}).get("schemas", {})
    ops: list[Operation] = []
    for path, item in doc.get("paths", {}).items():
        shared = item.get("parameters", [])
        for method in HTTP_METHODS:
            spec = item.get(method)
            if spec is None:
                continue
            op_id = spec.get("operationId") or f"{method}_{path}"
            params = tuple(
                Param(
                    name=p["name"],
                    location=p["in"],
                    schema=p.get("schema", {}),
                    required=bool(p.get("required", p["in"] == "path")),
                    description=p.get("description"),
                )
                for p in [*shared, *spec.get("parameters", [])]
                if p.get("in") in ("path", "query")
            )
            body = spec.get("requestBody")
            media = schema = None
            if body:
                content = body.get("content", {})
                media = "application/json" if "application/json" in content else next(iter(content))
                schema = content[media].get("schema", {})
            tags = tuple(spec.get("tags", []))
            summary = spec.get("summary") or op_id.replace("_", " ").capitalize()
            ops.append(
                Operation(
                    operation_id=op_id,
                    method=method.upper(),
                    path=path,
                    summary=summary,
                    description=spec.get("description", ""),
                    tags=tags,
                    params=params,
                    body_media_type=media,
                    body_schema=schema,
                    body_required=bool(body and body.get("required")),
                    body_description=(body or {}).get("description"),
                    excluded=_exclusion(op_id, path, tags, media),
                    components=components,
                )
            )
    return ops


def app_operations(app: FastAPI) -> list[Operation]:
    """Every operation of ``app``'s live OpenAPI document (excluded ones included)."""
    key = tuple(id(r) for r in app.routes)
    cached = getattr(app.state, "mcp_operations", None)
    if cached is not None and cached[0] == key:
        return cached[1]
    # Routes changed since the document was cached: build it again.
    app.openapi_schema = None
    ops = operations_from_openapi(app.openapi())
    app.state.mcp_operations = (key, ops)
    return ops


def tool_names(ops: Iterable[Operation], reserved: Iterable[str] = ()) -> dict[str, Operation]:
    """Tool name -> operation for the operations that are tools.

    A name taken by a curated tool gets an ``_op`` suffix on the generated one.
    """
    taken = set(reserved)
    out: dict[str, Operation] = {}
    for op in ops:
        if op.excluded:
            continue
        name = op.tool_name
        while name in taken or name in out:
            name += "_op"
        out[name] = op
    return out


def annotations(op: Operation) -> types.ToolAnnotations:
    return types.ToolAnnotations(
        title=op.summary,
        read_only_hint=op.method == "GET",
        destructive_hint=op.method == "DELETE",
        idempotent_hint=op.method in ("GET", "PUT", "DELETE"),
        open_world_hint=False,
    )


class ToolError(Exception):
    """A tool call the caller should see as ``isError`` with this message."""


@dataclass(frozen=True)
class RestResponse:
    status_code: int
    content_type: str
    content: bytes
    path: str

    @property
    def ok(self) -> bool:
        return self.status_code < 400

    def json(self) -> Any:
        return json.loads(self.content)

    @property
    def is_json(self) -> bool:
        return self.content_type.startswith("application/json") or self.content_type.endswith(
            "+json"
        )


# A path value holding one of these could leave its segment (a /, an encoded one, a
# backslash, a query or fragment, a control character): the call would reach another
# route than the one whose scope was checked.
_UNSAFE_PATH_VALUE = re.compile(r"[/\\%?#\x00-\x1f\x7f]")


def _path_value(p: Param, value: Any) -> str:
    """``value`` as the text of path parameter ``p``; ToolError unless it fits its
    declared type and format and stays one plain segment."""
    kind = p.schema.get("type")
    fmt = p.schema.get("format")
    refused = ToolError(f"Refused: {p.name} is not a valid {fmt or kind or 'path value'}.")
    if kind == "integer":
        if isinstance(value, bool) or not (
            isinstance(value, int) or (isinstance(value, str) and re.fullmatch(r"-?\d+", value))
        ):
            raise refused
        return str(int(value))
    if not isinstance(value, str):
        raise refused
    try:
        if fmt == "uuid":
            return str(uuid.UUID(value))
        if fmt == "date":
            return date.fromisoformat(value).isoformat()
    except ValueError:
        raise refused from None
    if not value.strip() or value == "." or ".." in value or _UNSAFE_PATH_VALUE.search(value):
        raise refused
    return value


def _resolves_to(app: FastAPI, op: Operation, path: str) -> bool:
    """Whether the app routes ``op.method path`` to ``op``'s own route, as it will once
    the in-process transport decodes the path."""
    scope = {"type": "http", "method": op.method, "path": unquote(path), "root_path": ""}
    # In the router's own order, included routers walked into, as FastAPI matches them.
    for route in iter_route_contexts(app.router.routes):
        match, _ = route.matches(scope)
        if match == Match.FULL:
            return getattr(route, "path_format", None) == op.path
    return False


def _build_request(op: Operation, args: dict[str, Any]) -> tuple[str, dict, Any, str | None]:
    path = op.path
    query: dict[str, Any] = {}
    missing = [p.name for p in op.params if p.required and args.get(p.name) is None]
    if op.body_required and args.get(op.body_key) is None:
        missing.append(op.body_key)
    if missing:
        raise ToolError(f"Missing required argument(s): {', '.join(missing)}")
    known = {p.name for p in op.params} | ({op.body_key} if op.body_media_type else set())
    unknown = sorted(set(args) - known)
    if unknown:
        raise ToolError(f"Unknown argument(s): {', '.join(unknown)}")
    for p in op.params:
        value = args.get(p.name)
        if value is None:
            continue
        if p.location == "path":
            path = path.replace("{" + p.name + "}", quote(_path_value(p, value), safe=""))
        else:
            query[p.name] = value
    body = args.get(op.body_key) if op.body_media_type else None
    return path, query, body, op.body_media_type


async def _run_document_refusal(caller: McpCaller, doc: str) -> str | None:
    """Why a run token may not push a draft to ``doc``, or None. A run pushes only to its
    own run's document (its ``document_id``, or the slug it was created for); a run with
    no document of its own may not push to a spec (E1: a spec version is its request's)."""
    from oracle.docs.models import Document
    from oracle.docs.service import find_document
    from oracle.runs.models import Run
    from oracle.tenancy import tenant_session

    async with tenant_session(caller.tenant_id) as s:
        run = await s.get(Run, caller.run_id) if caller.run_id else None
        if run is None:
            return "Refused: the run of this token is gone."
        target = await find_document(s, doc)
        own_slug = (run.knobs or {}).get("document_slug")
        own = await s.get(Document, run.document_id) if run.document_id else None
    if target is not None and own is not None and target.id == own.id:
        return None
    # The slug it was created for, only while no document holds it: a document someone
    # else made there since is not this run's.
    if own_slug and doc == own_slug and own is None and target is None:
        return None
    if own is None and not own_slug and (target is None or target.kind != "spec"):
        return None
    name = own.slug if own is not None else own_slug
    mine = f" ('{name}')" if name else " (this run has none)"
    return f"Refused: a run token pushes drafts only to its own run's document{mine}, not '{doc}'."


def _writes(method: str, needed: str | None) -> bool:
    """Whether a call writes: any scope but a read scope, else any method but GET (a POST
    under a read scope, such as H7's web search, reads)."""
    if needed is not None:
        return not needed.startswith("read:")
    return method.upper() != "GET"


async def call_operation(
    app: FastAPI,
    caller: McpCaller,
    op: Operation,
    args: dict[str, Any],
    *,
    check_scopes: bool = True,
) -> RestResponse:
    """Run ``op`` as ``caller`` through the app; raise ToolError when it may not run.
    ``check_scopes=False`` only for a curated tool that pins the call to the caller's own
    run (the REST role checks still apply)."""
    needed = scopes.required_scope(op.method, op.path)
    if check_scopes and not scopes.allowed(caller.scopes, op.method, op.path):
        if caller.scopes is None:
            reason = f"is for run tokens holding {needed} only"
        else:
            reason = f"needs the {needed} scope" if needed else "is not available to run tokens"
        raise ToolError(f"Refused: {op.method} {op.path} {reason}.")
    if caller.read_only and op.method.upper() not in ("GET", "HEAD"):
        raise ToolError(f"Refused (HTTP 403): {op.method} {op.path}: {READ_ONLY}.")
    if caller.kind == "run" and caller.run_id is not None and _writes(op.method, needed):
        # W5: decided now, just before the write, not when the request started: the
        # run's token is read-only while a checkpoint wait is open in SwarmCloud.
        from oracle.runs.service import run_token_hold

        held = await run_token_hold(caller.tenant_id, caller.run_id)
        if held:
            raise ToolError(f"Refused (HTTP 403): {op.method} {op.path}: {held}.")
    path, query, body, media = _build_request(op, args)
    # The scope above was checked against op.path: the request must reach that route.
    if not _resolves_to(app, op, path):
        raise ToolError(f"Refused: {op.method} {path} is not a {op.method} {op.path} call.")
    if caller.kind == "run" and scopes.required_scope(op.method, op.path) == "write:drafts":
        refusal = await _run_document_refusal(caller, str(args.get("doc") or ""))
        if refusal:
            raise ToolError(refusal)
    headers = {"accept": "application/json, text/*;q=0.9, */*;q=0.5", **caller.credentials}
    content = None
    if body is not None and media == "application/json":
        content = json.dumps(body).encode()
    elif body is not None:
        content = body.encode() if isinstance(body, str) else json.dumps(body).encode()
    if content is not None:
        headers["content-type"] = media
    # An unhandled error in the route becomes a 500 result, not a protocol error.
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url=INTERNAL_BASE_URL) as client:
        r = await client.request(op.method, path, params=query, content=content, headers=headers)
    return RestResponse(
        status_code=r.status_code,
        content_type=r.headers.get("content-type", ""),
        content=r.content,
        path=path,
    )


def to_result(resp: RestResponse, data: Any = None) -> types.CallToolResult:
    """An MCP result for a REST response; ``data`` replaces the parsed JSON body."""
    if not resp.ok:
        text = resp.content.decode("utf-8", "replace")
        return types.CallToolResult(
            content=[types.TextContent(text=f"HTTP {resp.status_code}: {text}")], is_error=True
        )
    if resp.status_code == 204 or not resp.content:
        return types.CallToolResult(content=[types.TextContent(text=f"Done ({resp.status_code}).")])
    if resp.is_json or data is not None:
        value = resp.json() if data is None else data
        return types.CallToolResult(
            content=[types.TextContent(text=json.dumps(value, ensure_ascii=False))],
            structured_content=value if isinstance(value, dict) else {"result": value},
        )
    if resp.content_type.startswith("text/"):
        return types.CallToolResult(
            content=[types.TextContent(text=resp.content.decode("utf-8", "replace"))]
        )
    blob = types.BlobResourceContents(
        uri=f"oracle:{resp.path}",
        mime_type=resp.content_type.split(";")[0] or "application/octet-stream",
        blob=base64.b64encode(resp.content).decode(),
    )
    return types.CallToolResult(content=[types.EmbeddedResource(resource=blob)])
