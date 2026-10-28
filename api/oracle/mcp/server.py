"""The ``/mcp`` endpoint: Streamable HTTP, stateless, JSON responses.

Every request is authenticated here (:mod:`oracle.mcp.auth`), then served by a fresh
low-level MCP server whose tools are the app's REST operations plus the curated ones.
"""

import logging
from typing import Any

import mcp_types as types
from fastapi import FastAPI
from mcp.server import Server
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route
from starlette.types import Receive, Scope, Send

from oracle.mcp import auth, scopes
from oracle.mcp.curated import CONFIDENCE_GUIDANCE, CURATED, CURATED_NAMES, Curated
from oracle.mcp.egress import client_address, run_token_allowed
from oracle.mcp.oauth.service import issuer
from oracle.mcp.tools import (
    Operation,
    ToolError,
    annotations,
    app_operations,
    call_operation,
    to_result,
    tool_names,
)
from oracle.runtokens import RUN_TOKEN_PREFIX

log = logging.getLogger(__name__)

MOUNT_PATH = "/mcp"
SERVER_NAME = "product-oracle"
AUTH_SCHEME = "Bearer"


def _www_authenticate(request: Request, error: bool) -> str:
    """RFC 6750 / RFC 9728 challenge: the auth scheme, then its parameters."""
    # The OAuth lane's public URL when configured (behind a proxy), else the request's.
    origin = issuer(f"{request.url.scheme}://{request.url.netloc}")
    params = {"resource_metadata": origin + auth.RESOURCE_METADATA_PATH}
    if error:
        params["error"] = "invalid_token"
        params["error_description"] = "Unknown or expired token"
    return AUTH_SCHEME + " " + ", ".join(f'{k}="{v}"' for k, v in params.items())


def unauthorized(request: Request, error: bool) -> JSONResponse:
    return JSONResponse(
        {"error": "invalid_token" if error else "unauthorized", "detail": "Not authenticated"},
        status_code=401,
        headers={"WWW-Authenticate": _www_authenticate(request, error)},
    )


def refused(request: Request) -> JSONResponse:
    log.warning(
        "/mcp: a run token from %s refused (not SwarmCloud's egress)",
        client_address(request) or "an unknown address",
    )
    return JSONResponse(
        {
            "error": "forbidden",
            "detail": "Run tokens are accepted only from the agent runtime's egress addresses",
        },
        status_code=403,
    )


def _bearer(request: Request) -> str | None:
    header = request.headers.get("authorization", "")
    scheme, _, value = header.partition(" ")
    if scheme.lower() != "bearer" or not value.strip():
        return None
    return value.strip()


class Catalog:
    """The tools a caller sees, from the app's live route table."""

    def __init__(self, app: FastAPI, caller: auth.McpCaller):
        self.app = app
        self.caller = caller
        self.operations = app_operations(app)
        self.generated = tool_names(self.operations, reserved=CURATED_NAMES)
        self.curated: dict[str, tuple[Curated, dict[str, Operation]]] = {}
        for c in CURATED:
            found = c.resolve(self.operations)
            if found is not None:
                self.curated[c.name] = (c, found)

    def _allowed(self, op: Operation) -> bool:
        # Write tools held back for now (W5) stay listed: a call says why not.
        return scopes.allowed(self.caller.scopes, op.method, op.path)

    def tools(self) -> list[types.Tool]:
        out: list[types.Tool] = []
        for name, (c, ops) in self.curated.items():
            offered = c.offered_to(self.caller)
            if offered is None:
                offered = all(self._allowed(op) for op in ops.values())
            if offered:
                read_only = all(op.method == "GET" for op in ops.values())
                out.append(
                    types.Tool(
                        name=name,
                        description=c.description,
                        input_schema=c.schema(ops),
                        annotations=types.ToolAnnotations(
                            read_only_hint=read_only, destructive_hint=False
                        ),
                    )
                )
        for name, op in self.generated.items():
            if self._allowed(op):
                out.append(
                    types.Tool(
                        name=name,
                        description=op.tool_description(),
                        input_schema=op.input_schema(),
                        annotations=annotations(op),
                    )
                )
        return out

    def unavailable(self) -> list[str]:
        return [
            f"{op.method} {op.path} ({op.operation_id}): {op.excluded}"
            for op in self.operations
            if op.excluded
        ]

    def instructions(self) -> str:
        lines = [
            "Product Oracle: the company's product baseline, sources, documents and "
            "reviews. Each REST operation is a tool named after its operationId; the "
            "curated tools (search, get_baseline, trace_feature, list_open_feedback, "
            "get_document_markdown, propose_change, push_draft) are the shortest path "
            "for agents. Your role and, for run tokens, the token's scopes decide what "
            "you may call.",
            CONFIDENCE_GUIDANCE,
        ]
        unavailable = self.unavailable()
        if unavailable:
            lines.append("Not available over MCP:\n" + "\n".join(f"- {u}" for u in unavailable))
        return "\n\n".join(lines)

    async def call(self, name: str, args: dict[str, Any]) -> types.CallToolResult:
        try:
            if name in self.curated:
                c, ops = self.curated[name]
                if c.offered_to(self.caller) is False:
                    # Own-run tools: people read the same through the generated tools.
                    raise ToolError(f"{name} is for a run's own agents (a run token).")
                return await c.run(self.app, self.caller, ops, args)
            op = self.generated.get(name)
            if op is None:
                raise ToolError(f"Unknown tool: {name}")
            resp = await call_operation(self.app, self.caller, op, args)
            return to_result(resp, plain=plain_for(self.caller))
        except ToolError as exc:
            return types.CallToolResult(content=[types.TextContent(text=str(exc))], is_error=True)


def plain_for(caller: auth.McpCaller) -> bool:
    """An Ask reply's live token (``live:sources`` only): a live source's failure reaches
    its answer as one plain line (oracle.mcp.tools.to_result)."""
    from oracle.live.tokens import SCOPE

    return caller.scopes == frozenset({SCOPE})


def build_server(catalog: Catalog) -> Server:
    async def list_tools(ctx, params) -> types.ListToolsResult:
        return types.ListToolsResult(
            tools=catalog.tools(),
            meta={"oracle/unavailable": catalog.unavailable()},
        )

    async def call_tool(ctx, params: types.CallToolRequestParams) -> types.CallToolResult:
        return await catalog.call(params.name, params.arguments or {})

    return Server(
        SERVER_NAME,
        version=catalog.app.version,
        instructions=catalog.instructions(),
        on_list_tools=list_tools,
        on_call_tool=call_tool,
    )


class McpEndpoint:
    """ASGI app serving ``/mcp`` for ``app``."""

    def __init__(self, app: FastAPI):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            return
        request = Request(scope, receive)
        raw = _bearer(request)
        if raw and raw.startswith(RUN_TOKEN_PREFIX) and not await run_token_allowed(request):
            # Checked before the token is: a run token is SwarmCloud's to use, and from
            # anywhere else it is refused without being looked up.
            await refused(request)(scope, receive, send)
            return
        caller = await auth.verify(raw) if raw else None
        if caller is None:
            await unauthorized(request, error=raw is not None)(scope, receive, send)
            return
        # Stateless: a fresh server and transport per request, so no app lifespan is needed.
        manager = StreamableHTTPSessionManager(
            build_server(Catalog(self.app, caller)), stateless=True, json_response=True
        )
        async with manager.run():
            await manager.handle_request(scope, receive, send)


def mount_mcp(app: FastAPI) -> None:
    # A Route, not a Mount: a Mount answers /mcp with a redirect to /mcp/.
    app.router.routes.append(Route(MOUNT_PATH, endpoint=McpEndpoint(app)))
