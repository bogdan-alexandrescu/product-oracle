"""A tool's path arguments reach only the route whose scope was checked.

The scope check reads the operation's path template; the request is built from the
arguments. A value that adds a segment (an encoded ``/``), climbs (``..``), starts a
query or fragment, or names a literal sibling route would make the two disagree.
"""

import uuid

import httpx
import pytest

from oracle.main import app
from oracle.mcp.auth import McpCaller
from oracle.mcp.tools import (
    INTERNAL_BASE_URL,
    ToolError,
    app_operations,
    call_operation,
    tool_names,
)
from tests.test_mcp import (  # noqa: F401 (local_runtime: the autouse fixture)
    local_runtime,
    mcp_client,
    run_token,
    text_of,
    user_with_role,
)

BAD_VALUES = ["x/summary", "x%2Fsummary", "x%252F", "..", "x?y=1", "x#y", "x\\y"]


def _good_value(schema: dict) -> object:
    if schema.get("type") == "integer":
        return 1
    if schema.get("format") == "uuid":
        return str(uuid.uuid4())
    if schema.get("format") == "date":
        return "2026-01-05"
    return "x"


def _good_args(op) -> dict:
    args = {p.name: _good_value(p.schema) for p in op.params if p.required}
    if op.body_required:
        args[op.body_key] = {} if op.body_media_type == "application/json" else "x"
    return args


def _path_tools() -> list[tuple[str, object, str]]:
    names = tool_names(app_operations(app))
    return [
        (name, op, p.name)
        for name, op in sorted(names.items())
        for p in op.params
        if p.location == "path"
    ]


@pytest.fixture
def requests_sent(monkeypatch) -> list[str]:
    """Every in-process REST request an MCP tool sends (answered 204, not run)."""
    sent: list[str] = []
    real = httpx.AsyncClient.request

    async def fake(self, method, url, **kwargs):
        if str(self.base_url).rstrip("/") != INTERNAL_BASE_URL:
            return await real(self, method, url, **kwargs)
        sent.append(f"{method} {url}")
        return httpx.Response(204)

    monkeypatch.setattr(httpx.AsyncClient, "request", fake)
    return sent


def _caller() -> McpCaller:
    return McpCaller(tenant_id=uuid.uuid4(), kind="token", credentials={})


def test_every_path_tool_is_walked():
    # The walk below covers what the app has, not a hand-picked list.
    tools = _path_tools()
    assert len(tools) > 300
    names = {name for name, _, _ in tools}
    assert {"get_intake", "get_launch", "get_request", "get_document"} <= names


async def test_every_path_argument_refuses_a_value_that_leaves_its_segment(requests_sent):
    """protects: no MCP tool's path argument can steer the call to another route.
    fails_when: any tool sends a request for a path value holding /, %, .., ?, # or \\.
    no_claim: request bodies and query arguments are not path arguments."""
    let_through = []
    for name, op, param in _path_tools():
        for bad in BAD_VALUES:
            args = {**_good_args(op), param: bad}
            requests_sent.clear()
            try:
                await call_operation(app, _caller(), op, args)
            except ToolError as e:
                assert "Refused" in str(e), (name, param, bad, str(e))
            else:
                let_through.append((name, param, bad))
            if requests_sent:
                let_through.append((name, param, bad, list(requests_sent)))
    assert let_through == []


async def test_good_path_arguments_still_reach_their_own_route(requests_sent):
    """protects: the path checks refuse only bad values.
    fails_when: a tool's well-formed path arguments are refused."""
    for name, op, _ in _path_tools():
        requests_sent.clear()
        await call_operation(app, _caller(), op, _good_args(op))
        assert len(requests_sent) == 1, name


async def test_a_value_naming_a_literal_sibling_route_is_refused(requests_sent):
    """protects: a plain value equal to a sibling route's literal segment
    (GET /v1/decisions/people beside GET /v1/decisions/{decision}) is refused.
    fails_when: the call is sent and answered by the sibling route."""
    [op] = [
        o for o in app_operations(app) if o.method == "GET" and o.path == "/v1/decisions/{decision}"
    ]
    with pytest.raises(ToolError, match="Refused"):
        await call_operation(app, _caller(), op, {"decision": "people"})
    assert requests_sent == []
    # Any other plain value goes through.
    await call_operation(app, _caller(), op, {"decision": "some-decision"})
    assert requests_sent == ["GET /v1/decisions/some-decision"]


@pytest.mark.parametrize(
    ("tool", "param", "leaf"),
    [
        ("get_intake", "item_id", "summary"),
        ("get_intake", "item_id", "question-batch"),
        ("get_intake", "item_id", "next-batch"),
        ("get_launch", "launch_id", "notes"),
        ("get_request", "request_id", "replies"),
    ],
)
async def test_read_baseline_run_token_cannot_reach_source_reads(
    tenant_id, requests_sent, tool, param, leaf
):
    """protects: a read:baseline run token cannot read read:sources routes (requester
    notes, request replies, an intake's evidence) through a read:baseline tool.
    fails_when: '<id>/<leaf>' in a path argument is sent and routed as a real '/'."""
    owner = await user_with_role(tenant_id, "owner")
    token = await run_token(tenant_id, ["read:baseline"], owner.id)
    async with mcp_client(token) as c:
        r = await c.call_tool(tool, {param: f"{uuid.uuid4()}/{leaf}"})
    assert r.is_error and "Refused" in text_of(r), text_of(r)
    assert requests_sent == []
