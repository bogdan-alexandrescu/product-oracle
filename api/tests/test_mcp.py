"""Lane D1: the /mcp server, driven with the official MCP client over the ASGI app."""

import uuid
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Annotated

import httpx
import httpx2
import pytest
from fastapi import Depends, FastAPI, File
from mcp import Client
from mcp.client.streamable_http import streamable_http_client
from sqlalchemy import update

from oracle.auth.deps import Principal
from oracle.auth.models import ROLES, ApiToken, User
from oracle.auth.service import create_api_token, create_user
from oracle.authz import require_role
from oracle.main import app, create_app
from oracle.mcp import auth as mcp_auth
from oracle.mcp.curated import CURATED_NAMES, flag_low_confidence
from oracle.mcp.scopes import required_scope
from oracle.mcp.tools import app_operations, snake_case
from oracle.runs.models import Run
from oracle.runtokens import RunToken, mint_run_token
from oracle.tenancy import tenant_session
from oracle.tenant_settings import TenantSetting

FIXTURES = Path(__file__).parent / "fixtures"
PRD_V1 = (FIXTURES / "prd_v1.md").read_text()
DOC = "checkout-redesign"


@asynccontextmanager
async def mcp_client(token: str | None, target: FastAPI = app, mode: str = "legacy"):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    http = httpx2.AsyncClient(
        transport=httpx2.ASGITransport(app=target), base_url="http://test", headers=headers
    )
    async with (
        http,
        Client(streamable_http_client("http://test/mcp", http_client=http), mode=mode) as c,
    ):
        yield c


async def api_token(tenant_id: uuid.UUID, role: str = "owner") -> str:
    async with tenant_session(tenant_id) as s:
        token, raw = await create_api_token(s, f"mcp-{role}")
        token.role = role
        await s.commit()
    return raw


async def user_with_role(tenant_id: uuid.UUID, role: str, email: str = "pm@example.com") -> User:
    async with tenant_session(tenant_id) as s:
        user = await create_user(s, email, "correct horse")
        user.role = role
        await s.commit()
        return user


async def run_token(
    tenant_id: uuid.UUID, scopes: list[str], created_by: uuid.UUID | None, ttl: int = 600
) -> str:
    async with tenant_session(tenant_id) as s:
        run = Run(flow="baseline_to_prd", created_by=created_by)
        s.add(run)
        await s.flush()
        raw = await mint_run_token(s, run.id, scopes, ttl_seconds=ttl)
        await s.commit()
    return raw


def text_of(result) -> str:
    return "\n".join(getattr(c, "text", "") for c in result.content)


# --- auth ----------------------------------------------------------------------------


async def test_no_token_is_401_with_resource_metadata(client):
    resp = await client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "ping"})
    assert resp.status_code == 401
    header = resp.headers["www-authenticate"]
    assert header.startswith("Bearer ")
    assert 'resource_metadata="http://test/.well-known/oauth-protected-resource"' in header
    assert "error=" not in header


@pytest.mark.parametrize("token", ["po_unknown", "ort_unknown", "something-else"])
async def test_unknown_token_is_401_invalid_token(client, token):
    resp = await client.post(
        "/mcp",
        json={"jsonrpc": "2.0", "id": 1, "method": "ping"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 401
    header = resp.headers["www-authenticate"]
    assert "/.well-known/oauth-protected-resource" in header
    assert 'error="invalid_token"' in header


async def test_expired_or_revoked_tokens_are_401(client, tenant_id):
    user = await user_with_role(tenant_id, "owner")
    expired = await run_token(tenant_id, ["read:documents"], user.id)
    async with tenant_session(tenant_id) as s:
        await s.execute(
            update(RunToken).values(expires_at=datetime.now(UTC) - timedelta(seconds=1))
        )
        await s.commit()
    revoked = await api_token(tenant_id)
    async with tenant_session(tenant_id) as s:
        await s.execute(update(ApiToken).values(revoked_at=datetime.now(UTC)))
        await s.commit()
    for token in (expired, revoked):
        resp = await client.post(
            "/mcp",
            json={"jsonrpc": "2.0", "id": 1, "method": "ping"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 401
        assert "oauth-protected-resource" in resp.headers["www-authenticate"]


async def test_run_token_without_a_creator_is_refused(client, tenant_id):
    token = await run_token(tenant_id, ["read:documents"], created_by=None)
    resp = await client.post(
        "/mcp",
        json={"jsonrpc": "2.0", "id": 1, "method": "ping"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 401


async def test_registered_verifier_plugs_in(tenant_id):
    user = await user_with_role(tenant_id, "commenter")

    async def verify_test_token(raw: str):
        return mcp_auth.user_caller(user) if raw == "oat_test" else None

    mcp_auth.register_verifier(verify_test_token)
    try:
        async with mcp_client("oat_test") as c:
            me = await c.call_tool("me", {})
        assert not me.is_error
        assert me.structured_content["kind"] == "user"
        assert me.structured_content["user_id"] == str(user.id)
        assert me.structured_content["role"] == "commenter"
    finally:
        mcp_auth.unregister_verifier(verify_test_token)
    assert await mcp_auth.verify("oat_test") is None


# --- protocol, listing, parity ---------------------------------------------------------


@pytest.mark.parametrize("mode", ["legacy", "auto"])
async def test_initialize_and_list_tools(tenant_id, mode):
    token = await api_token(tenant_id)
    async with mcp_client(token, mode=mode) as c:
        assert c.server_info.name == "product-oracle"
        assert "Not available over MCP" in (c.instructions or "")
        assert "login" in c.instructions and "confidence" in c.instructions
        tools = {t.name: t for t in (await c.list_tools()).tools}
    assert {"list_documents", "import_version", "get_document_markdown", "push_draft"} <= set(tools)
    assert "login" not in tools and "logout" not in tools
    t = tools["diff_versions"]
    assert t.input_schema["required"] == ["doc", "from", "to"]
    assert "REST: GET /v1/documents/{doc}/diff" in t.description
    assert t.annotations.read_only_hint is True
    body = tools["create_comment"].input_schema
    assert "body" in body["required"]
    assert body["properties"]["body"]["$ref"].startswith("#/$defs/")
    assert body["properties"]["body"]["$ref"][len("#/$defs/") :] in body["$defs"]
    assert tools["import_version"].input_schema["properties"]["body"]["type"] == "string"


def test_parity_every_operation_is_a_tool_or_listed_as_unavailable():
    """Every operation of the app's OpenAPI document is a tool unless excluded."""
    doc = app.openapi()
    ops = {o.operation_id: o for o in app_operations(app)}
    excluded = set()
    for path, item in doc["paths"].items():
        for method, spec in item.items():
            op = ops[spec["operationId"]]
            assert (op.method, op.path) == (method.upper(), path)
            if op.excluded:
                excluded.add(op.operation_id)
    assert excluded == {"login", "logout"}


async def test_parity_over_the_wire(tenant_id):
    token = await api_token(tenant_id)
    async with mcp_client(token) as c:
        result = await c.list_tools()
    names = {t.name for t in result.tools}
    doc = app.openapi()
    for item in doc["paths"].values():
        for spec in item.values():
            name = snake_case(spec["operationId"])
            if name in {"login", "logout"}:
                assert name not in names
                continue
            assert name in names or f"{name}_op" in names, name
    unavailable = result.meta["oracle/unavailable"]
    assert any("login" in u for u in unavailable)


async def test_routes_added_later_become_tools(tenant_id):
    target = create_app()
    token = await api_token(tenant_id)
    async with mcp_client(token, target) as c:
        before = {t.name for t in (await c.list_tools()).tools}

    @target.get("/v1/widgets/{widget_id}", summary="Read a widget")
    async def get_widget(widget_id: str, size: int = 1) -> dict:
        return {"id": widget_id, "size": size}

    @target.post("/v1/uploads", summary="Upload a file")
    async def upload(file: Annotated[bytes, File()]) -> dict:
        return {}

    async with mcp_client(token, target) as c:
        tools = {t.name: t for t in (await c.list_tools()).tools}
        assert "get_widget" not in before and "get_widget" in tools
        assert tools["get_widget"].description.startswith("Read a widget")
        assert "upload" not in tools  # multipart
        assert "POST /v1/uploads (upload): multipart" in c.instructions
        r = await c.call_tool("get_widget", {"widget_id": "w 1", "size": 3})
    assert r.structured_content == {"id": "w 1", "size": 3}


# --- calls under API tokens -----------------------------------------------------------


async def test_document_round_trip_with_an_api_token(tenant_id):
    token = await api_token(tenant_id, "owner")
    async with mcp_client(token) as c:
        pushed = await c.call_tool("push_draft", {"doc": DOC, "markdown": PRD_V1})
        assert not pushed.is_error, text_of(pushed)
        assert pushed.structured_content["number"] == 1
        listed = await c.call_tool("list_documents", {})
        assert [d["slug"] for d in listed.structured_content["result"]] == [DOC]
        md = await c.call_tool("get_document_markdown", {"doc": DOC})
        assert text_of(md) == PRD_V1
        md1 = await c.call_tool("get_version_markdown", {"doc": DOC, "n": 1})
        assert text_of(md1) == PRD_V1
        feedback = await c.call_tool("list_open_feedback", {"doc": DOC})
        assert feedback.structured_content == {"result": []}
        missing = await c.call_tool("get_document", {"doc": "nope"})
        assert missing.is_error and "HTTP 404" in text_of(missing)
        bad = await c.call_tool("get_document", {})
        assert bad.is_error and "Missing required argument(s): doc" in text_of(bad)
        unknown = await c.call_tool("no_such_tool", {})
        assert unknown.is_error
        pdf = await c.call_tool("export_version", {"doc": DOC, "n": 1, "format": "html"})
        assert not pdf.is_error


@pytest.fixture
def guarded_app() -> FastAPI:
    """The real app plus one role-guarded route per role, as other lanes add them."""
    target = create_app()
    for min_role in ROLES:

        def endpoint(
            principal: Annotated[Principal, Depends(require_role(min_role))],
        ) -> dict:
            return {"role": principal.role, "kind": principal.kind}

        target.post(f"/v1/guarded/{min_role}", operation_id=f"guarded_{min_role}")(endpoint)
    return target


@pytest.mark.parametrize("role", ROLES)
async def test_rest_role_checks_apply_to_api_tokens(tenant_id, guarded_app, role):
    token = await api_token(tenant_id, role)
    async with mcp_client(token, guarded_app) as c:
        for rank, min_role in enumerate(ROLES):
            r = await c.call_tool(f"guarded_{min_role}", {})
            if rank <= ROLES.index(role):
                assert not r.is_error, (role, min_role)
                assert r.structured_content == {"role": role, "kind": "token"}
            else:
                assert r.is_error, (role, min_role)
                assert "HTTP 403" in text_of(r)
                assert f"Requires the {min_role} role" in text_of(r)


# --- run tokens -----------------------------------------------------------------------


@pytest.mark.parametrize(
    ("method", "path", "scope"),
    [
        ("GET", "/v1/sources", "read:sources"),
        ("GET", "/v1/search", "read:sources"),
        ("GET", "/v1/snapshots/{id}", "read:sources"),
        ("GET", "/v1/baseline", "read:baseline"),
        ("GET", "/v1/priorities/snapshots", "read:baseline"),
        ("GET", "/v1/documents/{doc}/versions/{n}/markdown", "read:documents"),
        ("GET", "/v1/feedback/{id}", "read:documents"),
        ("GET", "/v1/exports/{id}", "read:documents"),
        ("POST", "/v1/baseline/proposals", "write:proposals"),
        ("POST", "/v1/baseline/entities/{id}/evidence", "write:proposals"),
        ("POST", "/v1/documents/{doc}/versions", "write:drafts"),
        ("POST", "/v1/baseline/proposals/{id}/accept", None),
        ("PATCH", "/v1/baseline/entities/{id}", None),
        ("POST", "/v1/documents/{doc}/versions/{n}/approve", None),
        ("POST", "/v1/documents/{doc}/versions/{n}/comments", None),
        ("GET", "/v1/me", None),
        ("GET", "/v1/runs", None),
        ("GET", "/healthz", None),
    ],
)
def test_scope_map(method, path, scope):
    assert required_scope(method, path) == scope


async def test_run_token_scopes_limit_tools_and_calls(tenant_id):
    owner = await user_with_role(tenant_id, "owner")
    async with mcp_client(await api_token(tenant_id)) as c:
        assert not (await c.call_tool("push_draft", {"doc": DOC, "markdown": PRD_V1})).is_error

    token = await run_token(tenant_id, ["read:documents"], owner.id)
    async with mcp_client(token) as c:
        names = {t.name for t in (await c.list_tools()).tools}
        assert {"list_documents", "get_document_markdown", "list_open_feedback"} <= names
        assert names.isdisjoint({"import_version", "push_draft", "create_comment", "me"})
        assert names.isdisjoint({"approve_version", "update_feedback", "healthz"})
        ok = await c.call_tool("get_document_markdown", {"doc": DOC})
        assert text_of(ok) == PRD_V1
        # Hidden tools are refused too, not just hidden.
        refused = await c.call_tool("push_draft", {"doc": DOC, "markdown": PRD_V1})
        assert refused.is_error and "needs the write:drafts scope" in text_of(refused)
        refused = await c.call_tool("approve_version", {"doc": DOC, "n": 1})
        assert refused.is_error and "not available to run tokens" in text_of(refused)
        refused = await c.call_tool("me", {})
        assert refused.is_error


async def test_run_token_acts_for_the_run_creator(tenant_id):
    pm = await user_with_role(tenant_id, "approver")
    token = await run_token(tenant_id, ["write:drafts", "read:documents"], pm.id)
    async with mcp_client(token) as c:
        names = {t.name for t in (await c.list_tools()).tools}
        assert {"push_draft", "import_version"} <= names
        pushed = await c.call_tool("push_draft", {"doc": DOC, "markdown": PRD_V1})
    assert not pushed.is_error, text_of(pushed)
    assert pushed.structured_content["imported_by"] == str(pm.id)


async def test_run_token_is_limited_by_the_creator_role(tenant_id, guarded_app):
    viewer = await user_with_role(tenant_id, "viewer")
    # A scope-allowed write that REST reserves for approvers: the creator's role decides.
    target = guarded_app

    @target.post("/v1/baseline/proposals", operation_id="create_proposal")
    async def create_proposal(
        principal: Annotated[Principal, Depends(require_role("commenter"))], body: dict
    ) -> dict:
        return {"by": str(principal.user_id), **body}

    token = await run_token(tenant_id, ["write:proposals"], viewer.id)
    async with mcp_client(token, target) as c:
        r = await c.call_tool("propose_change", {"body": {"field": "status"}})
    assert r.is_error and "Requires the commenter role" in text_of(r)

    async with tenant_session(tenant_id) as s:
        await s.execute(update(User).values(role="commenter"))
        await s.commit()
    async with mcp_client(token, target) as c:
        r = await c.call_tool("propose_change", {"body": {"field": "status"}})
    assert r.structured_content == {"by": str(viewer.id), "field": "status"}


# --- curated tools over routes other lanes add ------------------------------------------


@pytest.fixture
def lane_app() -> FastAPI:
    """Stand-ins for the sources and baseline routes, under their likely operationIds."""
    target = create_app()

    @target.get("/v1/search", operation_id="search", summary="Search sources")
    async def search(q: str, _: Annotated[Principal, Depends(require_role("viewer"))]) -> dict:
        return {
            "results": [
                {"title": f"{q} strong", "confidence": 0.9},
                {"title": f"{q} weak", "confidence": 0.2},
            ]
        }

    @target.get("/v1/baseline", operation_id="get_baseline")
    async def get_baseline(_: Annotated[Principal, Depends(require_role("viewer"))]) -> dict:
        return {"entities": [{"id": "f1", "confidence": 0.55}], "edges": []}

    @target.get("/v1/baseline/traceability", operation_id="get_traceability")
    async def trace(
        _: Annotated[Principal, Depends(require_role("viewer"))], feature: str | None = None
    ) -> list[dict]:
        return [{"feature": feature or "f1", "goals": [], "confidence": 0.1}]

    @target.post("/v1/baseline/proposals", operation_id="create_proposal")
    async def propose(
        _: Annotated[Principal, Depends(require_role("commenter"))], body: dict
    ) -> dict:
        return {"status": "open", **body}

    return target


async def test_curated_tools_hidden_until_their_routes_exist(tenant_id):
    async with mcp_client(await api_token(tenant_id)) as c:
        names = {t.name for t in (await c.list_tools()).tools}
    assert {"list_open_feedback", "get_document_markdown", "push_draft"} <= names
    # On this commit the sources and baseline lanes have not added their routes yet.
    assert names.isdisjoint({"search", "get_baseline", "trace_feature", "propose_change"})


async def test_curated_tools_flag_low_confidence(tenant_id, lane_app):
    token = await api_token(tenant_id, "commenter")
    async with mcp_client(token, lane_app) as c:
        tools = {t.name: t for t in (await c.list_tools()).tools}
        assert CURATED_NAMES <= set(tools)
        for name in ("search", "get_baseline", "trace_feature", "propose_change"):
            assert "confidence" in tools[name].description
            assert "flag" in tools[name].description
        # Generated tool for the same operation, renamed so the curated one keeps its name.
        assert "search_op" in tools
        assert tools["search"].input_schema["required"] == ["q"]

        found = await c.call_tool("search", {"q": "checkout"})
        assert [r["low_confidence"] for r in found.structured_content["results"]] == [
            False,
            True,
        ]
        raw = await c.call_tool("search_op", {"q": "checkout"})
        assert "low_confidence" not in raw.structured_content["results"][0]
        base = await c.call_tool("get_baseline", {})
        assert base.structured_content["entities"][0]["low_confidence"] is False
        trace = await c.call_tool("trace_feature", {"feature": "f9"})
        assert trace.structured_content["result"][0] == {
            "feature": "f9",
            "goals": [],
            "confidence": 0.1,
            "low_confidence": True,
        }
        proposed = await c.call_tool("propose_change", {"body": {"entity": "f1"}})
        assert proposed.structured_content == {"status": "open", "entity": "f1"}

    # The company's own low threshold applies.
    async with tenant_session(tenant_id) as s:
        s.add(TenantSetting(key="confidence_weights", value={"low": 0.6}))
        await s.commit()
    async with mcp_client(token, lane_app) as c:
        base = await c.call_tool("get_baseline", {})
    assert base.structured_content["entities"][0]["low_confidence"] is True


async def test_curated_tools_follow_run_token_scopes(tenant_id, lane_app):
    pm = await user_with_role(tenant_id, "approver")
    token = await run_token(tenant_id, ["read:sources"], pm.id)
    async with mcp_client(token, lane_app) as c:
        names = {t.name for t in (await c.list_tools()).tools}
        assert "search" in names
        assert names.isdisjoint({"get_baseline", "trace_feature", "propose_change", "push_draft"})
        assert not (await c.call_tool("search", {"q": "x"})).is_error
        refused = await c.call_tool("propose_change", {"body": {}})
        assert refused.is_error and "write:proposals" in text_of(refused)


def test_flag_low_confidence_leaves_other_values_alone():
    value = {"confidence": True, "items": [{"confidence": "high"}, {"confidence": 0.39}], "n": 1}
    assert flag_low_confidence(value, 0.4) == {
        "confidence": True,
        "items": [{"confidence": "high"}, {"confidence": 0.39, "low_confidence": True}],
        "n": 1,
    }


async def test_rest_client_fixture_still_works(client):
    # The mount does not shadow REST routes.
    assert (await client.get("/v1/documents")).status_code == 401
    assert isinstance(client, httpx.AsyncClient)
