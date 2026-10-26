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
from sqlalchemy import select, update

from oracle.auth.deps import Principal
from oracle.auth.models import ROLES, ApiToken, User
from oracle.auth.service import create_api_token, create_user
from oracle.authz import require_role
from oracle.baseline.models import Proposal
from oracle.main import app, create_app
from oracle.mcp import auth as mcp_auth
from oracle.mcp.curated import CURATED, flag_low_confidence
from oracle.mcp.scopes import allowed, required_scope
from oracle.mcp.tools import app_operations
from oracle.runs.models import Run
from oracle.runtokens import RunToken, mint_run_token
from oracle.tenancy import tenant_session
from oracle.tenant_settings import TenantSetting

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture(autouse=True)
def local_runtime():
    """The local runtime: run tokens from any address (the egress check, for SwarmCloud,
    has its own tests in test_adapter_v2.py)."""
    from oracle.swarm import FakeRuntime, set_runtime

    set_runtime(FakeRuntime())
    yield
    set_runtime(None)


PRD_V1 = (FIXTURES / "prd_v1.md").read_text()
DOC = "checkout-redesign"
PROPOSED_GOAL = {"type": "goal", "key": "activation", "title": "Activation"}


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
    tenant_id: uuid.UUID,
    scopes: list[str],
    created_by: uuid.UUID | None,
    ttl: int = 600,
    flow: str = "baseline_to_prd",
) -> str:
    """A run token of a new run of ``flow``. A Baseline to PRD run without a target writes
    a new company-wide PRD, so it reads as a member (#541 part 5); a pricing_memo run
    reads with its creator's role."""
    async with tenant_session(tenant_id) as s:
        run = Run(flow=flow, created_by=created_by)
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
    # Browser sign-in, the OAuth flow itself, file uploads (multipart: use REST), the
    # account operations that work from the signed-in browser only (AC1), G2's live reply
    # stream (MCP calls create_discussion_message with wait=true instead), and the
    # interviewee's own routes behind a private interview link (C3).
    oauth = {o for o in excluded if o.startswith("oauth_")}
    assert {"oauth_token", "oauth_register", "oauth_callback"} <= oauth
    assert excluded - oauth == {
        "login",
        "logout",
        "upload_files",
        "stream_discussion_reply",
        "create_personal_token",
        "change_password",
        "sign_out_everywhere",
        # A5: a Google-signed person's own access state and note, browser only.
        "get_access_state",
        "send_access_note",
        "public_interview",
        "public_interview_message",
        "public_interview_skip",
        "public_interview_finish",
    }
    # A5's routes for owners and approvers are tools.
    tools = {o.operation_id for o in ops.values() if not o.excluded}
    assert {
        "list_access_requests", "approve_access_request", "decline_access_request",
        "reopen_access_request", "get_sign_in_rules", "resend_invite", "update_my_account",
        "get_member", "get_member_impact", "list_member_approvals", "hand_over",
    } <= tools  # fmt: skip


async def test_parity_over_the_wire(tenant_id):
    token = await api_token(tenant_id)
    async with mcp_client(token) as c:
        result = await c.list_tools()
    names = {t.name for t in result.tools}
    for op in app_operations(app):
        # Run-only operations (H7's web tools, read:web) are never offered to people.
        if op.excluded or not allowed(None, op.method, op.path):
            assert op.tool_name not in names, op.tool_name
            continue
        assert op.tool_name in names or f"{op.tool_name}_op" in names, op.tool_name
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
        pushed = await c.call_tool(
            "push_draft", {"doc": DOC, "markdown": PRD_V1, "base_version": 0}
        )
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
        # Browsing a person's connection spends their provider quota: never a run's.
        ("GET", "/v1/connections/{connection_id}/fireflies/meetings", None),
        ("GET", "/v1/connections/{connection_id}/fireflies/series", None),
        ("GET", "/v1/runs", None),
        ("GET", "/healthz", None),
    ],
)
def test_scope_map(method, path, scope):
    assert required_scope(method, path) == scope


async def test_run_token_scopes_limit_tools_and_calls(tenant_id):
    owner = await user_with_role(tenant_id, "owner")
    async with mcp_client(await api_token(tenant_id)) as c:
        assert not (
            await c.call_tool("push_draft", {"doc": DOC, "markdown": PRD_V1, "base_version": 0})
        ).is_error

    token = await run_token(tenant_id, ["read:documents"], owner.id)
    async with mcp_client(token) as c:
        names = {t.name for t in (await c.list_tools()).tools}
        assert {"list_documents", "get_document_markdown", "list_open_feedback"} <= names
        assert names.isdisjoint({"import_version", "push_draft", "create_comment", "me"})
        assert names.isdisjoint({"approve_version", "update_feedback", "healthz"})
        ok = await c.call_tool("get_document_markdown", {"doc": DOC})
        assert text_of(ok) == PRD_V1
        # Hidden tools are refused too, not just hidden.
        refused = await c.call_tool(
            "push_draft", {"doc": DOC, "markdown": PRD_V1, "base_version": 0}
        )
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
        pushed = await c.call_tool(
            "push_draft", {"doc": DOC, "markdown": PRD_V1, "base_version": 0}
        )
    assert not pushed.is_error, text_of(pushed)
    assert pushed.structured_content["imported_by"] == str(pm.id)


async def test_run_token_is_limited_by_the_creator_role(tenant_id):
    viewer = await user_with_role(tenant_id, "viewer")
    # A scope-allowed write that REST reserves for commenters: the creator's role decides.
    token = await run_token(tenant_id, ["write:proposals"], viewer.id)
    change = {"op": "create", "kind": "entity", "fields": PROPOSED_GOAL, "reason": "seen"}
    async with mcp_client(token) as c:
        r = await c.call_tool("propose_change", {"body": change})
    assert r.is_error and "Requires the commenter role" in text_of(r)

    async with tenant_session(tenant_id) as s:
        await s.execute(update(User).values(role="commenter"))
        await s.commit()
    async with mcp_client(token) as c:
        r = await c.call_tool("propose_change", {"body": change})
    assert not r.is_error, text_of(r)
    assert r.structured_content["status"] == "open"
    assert r.structured_content["payload"]["fields"]["key"] == "activation"


# --- curated tools over routes other lanes add ------------------------------------------


async def _rest(token: str) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
        headers={"Authorization": f"Bearer {token}"},
    )


async def user_token(tenant_id: uuid.UUID, user: User) -> str:
    """An API token acting for ``user`` (their role and their own sources)."""
    async with tenant_session(tenant_id) as s:
        _, raw = await create_api_token(s, "agent", user_id=user.id)
        await s.commit()
    return raw


async def test_curated_tools_bind_to_the_lanes_routes():
    ops = {o.operation_id: o for o in app_operations(app)}
    bound = {}
    for c in CURATED:
        found = c.resolve(list(ops.values()))
        assert found is not None, c.name
        bound[c.name] = {role: (op.method, op.path) for role, op in found.items()}
    assert bound["search"] == {"op": ("GET", "/v1/search")}
    assert bound["get_baseline"] == {"op": ("GET", "/v1/baseline/graph")}
    assert bound["trace_feature"] == {"op": ("GET", "/v1/baseline/trace")}
    assert bound["propose_change"] == {"op": ("POST", "/v1/baseline/proposals")}


async def test_curated_tools_hidden_until_their_routes_exist(tenant_id):
    # An app without the sources and baseline routes lists none of their curated tools.
    from oracle.docs.router import router as docs_router
    from oracle.mcp.server import mount_mcp
    from oracle.review.router import router as review_router

    bare = FastAPI(generate_unique_id_function=lambda route: route.name)
    bare.include_router(docs_router)
    bare.include_router(review_router)
    mount_mcp(bare)
    async with mcp_client(await api_token(tenant_id), bare) as c:
        names = {t.name for t in (await c.list_tools()).tools}
    assert {"list_open_feedback", "get_document_markdown", "push_draft"} <= names
    assert names.isdisjoint({"search", "get_baseline", "trace_feature", "propose_change"})


async def test_curated_search_returns_source_confidence(tenant_id):
    pm = await user_with_role(tenant_id, "commenter")
    token = await user_token(tenant_id, pm)
    async with await _rest(token) as rest:
        src = (await rest.post("/v1/sources", json={"kind": "upload", "name": "Notes"})).json()
        files = [("files", ("checkout.md", b"# Checkout\n\nShipping costs drive drop-off."))]
        resp = await rest.post(f"/v1/sources/{src['id']}/uploads", files=files)
        assert resp.status_code in (200, 201), resp.text
    async with mcp_client(token) as c:
        tools = {t.name: t for t in (await c.list_tools()).tools}
        assert "confidence" in tools["search"].description
        assert "search_sources" in tools  # the generated tool for the same operation
        found = await c.call_tool("search", {"q": "shipping"})
        assert not found.is_error, text_of(found)
        hits = found.structured_content["hits"]
        assert len(hits) == 1
        hit = hits[0]
        # B1's confidence, lifted to the hit next to the relevance x confidence score.
        assert hit["confidence"] == hit["item"]["confidence"]["value"]
        assert 0 < hit["confidence"] <= 1
        assert hit["low_confidence"] is hit["item"]["confidence"]["low"]
        assert set(hit["confidence_factors"]) == {"source", "freshness", "mentions", "goal_impact"}
        assert hit["score"] <= hit["relevance"]


async def test_curated_baseline_tools_flag_low_confidence(tenant_id):
    token = await api_token(tenant_id, "owner")
    async with await _rest(token) as rest:
        goal = (
            await rest.post(
                "/v1/baseline/entities",
                json={"type": "goal", "key": "activation", "title": "Activation"},
            )
        ).json()
        feature = (
            await rest.post(
                "/v1/baseline/entities",
                json={"type": "feature", "key": "checkout", "title": "Checkout"},
            )
        ).json()
        for e in (goal, feature):
            assert "id" in e or "entity" in e, e
        fid = (feature.get("entity") or feature)["id"]
        resp = await rest.post(
            f"/v1/baseline/entities/{fid}/evidence",
            json={"url": "https://example.com/notes", "excerpt": "Users drop at shipping."},
        )
        assert resp.status_code in (200, 201), resp.text
    async with mcp_client(token) as c:
        tools = {t.name: t for t in (await c.list_tools()).tools}
        # Every curated tool but the run-only one (a run's own outputs, for run tokens).
        assert {c.name for c in CURATED if not c.own_run} <= set(tools)
        assert "get_run_output" not in tools
        for name in ("search", "get_baseline", "trace_feature", "propose_change"):
            assert "confidence" in tools[name].description
            assert "flag" in tools[name].description
        base = await c.call_tool("get_baseline", {})
        assert not base.is_error, text_of(base)
        scored = [e for e in base.structured_content["entities"] if e["key"] == "checkout"][0]
        assert isinstance(scored["confidence"], float)
        assert scored["low_confidence"] is (scored["confidence"] < 0.4)
        trace = await c.call_tool("trace_feature", {})
        assert not trace.is_error, text_of(trace)

    # The company's own low threshold applies.
    async with tenant_session(tenant_id) as s:
        s.add(TenantSetting(key="confidence_weights", value={"low": 0.99}))
        await s.commit()
    async with mcp_client(token) as c:
        base = await c.call_tool("get_baseline", {})
    scored = [e for e in base.structured_content["entities"] if e["key"] == "checkout"][0]
    assert scored["low_confidence"] is True


async def test_curated_tools_follow_run_token_scopes(tenant_id):
    pm = await user_with_role(tenant_id, "approver")
    token = await run_token(tenant_id, ["read:sources"], pm.id)
    async with mcp_client(token) as c:
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


async def test_update_source_over_mcp_requires_the_version_that_was_read(tenant_id):
    """Owner 2026-10-20: base_version is required wherever config or connection change,
    MCP included; the tool says to read the source first."""
    pm = await user_with_role(tenant_id, "commenter")
    token = await user_token(tenant_id, pm)
    async with await _rest(token) as rest:
        src = (await rest.post("/v1/sources", json={"kind": "upload", "name": "Notes"})).json()
    path = {"source_id": src["id"]}
    async with mcp_client(token) as c:
        tools = {t.name: t for t in (await c.list_tools()).tools}
        said = tools["update_source"].description
        assert "get_source" in said and "config_version" in said and "base_version" in said

        refused = await c.call_tool("update_source", {**path, "body": {"config": {}}})
        assert refused.is_error
        assert "HTTP 422" in text_of(refused) and "base_version_required" in text_of(refused)

        # A rename needs none, and bumps the version.
        renamed = await c.call_tool("update_source", {**path, "body": {"name": "Renamed"}})
        assert not renamed.is_error, text_of(renamed)
        version = renamed.structured_content["config_version"]
        assert version == src["config_version"] + 1

        stale = await c.call_tool(
            "update_source", {**path, "body": {"name": "Again", "base_version": 1}}
        )
        assert stale.is_error and "source_changed" in text_of(stale)

        read = await c.call_tool("get_source", path)
        base = read.structured_content["config_version"]
        saved = await c.call_tool(
            "update_source", {**path, "body": {"config": {}, "base_version": base}}
        )
        assert not saved.is_error, text_of(saved)


# --- B3: a run token's proposals record the run ----------------------------------------


async def _run_and_token(tenant_id: uuid.UUID, created_by: uuid.UUID) -> tuple[uuid.UUID, str]:
    async with tenant_session(tenant_id) as s:
        run = Run(flow="baseline_to_prd", created_by=created_by)
        s.add(run)
        await s.flush()
        raw = await mint_run_token(s, run.id, ["write:proposals"], ttl_seconds=600)
        await s.commit()
        return run.id, raw


async def test_run_token_proposal_records_its_run(tenant_id):
    """protects: every agent proposal is attributable to its run.
    fails_when: a run-token proposal is stored with run_id null.
    no_claim: uses the run binding the MCP server sets, not a live SwarmCloud agent."""
    pm = await user_with_role(tenant_id, "commenter")
    run_id, token = await _run_and_token(tenant_id, pm.id)
    change = {"op": "create", "kind": "entity", "fields": PROPOSED_GOAL, "reason": "seen"}
    async with mcp_client(token) as c:
        r = await c.call_tool("propose_change", {"body": change})
    assert not r.is_error, text_of(r)
    assert r.structured_content["run_id"] == str(run_id)
    async with tenant_session(tenant_id) as s:
        [row] = (await s.scalars(select(Proposal))).all()
        assert row.run_id == run_id


async def test_run_token_cannot_propose_for_another_run(tenant_id):
    """protects: a run cannot attribute its proposals to another run.
    fails_when: a run token's proposal carrying another run's id is stored.
    no_claim: uses the run binding the MCP server sets, not a live SwarmCloud agent."""
    pm = await user_with_role(tenant_id, "commenter")
    _, token = await _run_and_token(tenant_id, pm.id)
    other_run, _ = await _run_and_token(tenant_id, pm.id)
    change = {
        "op": "create",
        "kind": "entity",
        "fields": PROPOSED_GOAL,
        "run_id": str(other_run),
    }
    async with mcp_client(token) as c:
        r = await c.call_tool("propose_change", {"body": change})
    assert r.is_error and "a run can only propose for itself" in text_of(r)
    async with tenant_session(tenant_id) as s:
        assert (await s.scalars(select(Proposal))).all() == []


@pytest.mark.parametrize("role", ["viewer", "approver", "owner"])
async def test_the_claude_account_pool_names_its_holders_to_owners_alone(tenant_id, role):
    """BGD 2026-10-25: MCP reads the pool as REST does, emails and organisations only for
    owners."""
    from tests.claude_account_helpers import add_account, edit_row

    a = await add_account(tenant_id, "personal")
    await edit_row(
        tenant_id, a.account_id, claude_email="ada@example.com",
        claude_organization="Example Studio",
    )  # fmt: skip
    async with mcp_client(await api_token(tenant_id, role)) as c:
        listed = await c.call_tool("list_claude_accounts", {})
    assert not listed.is_error, text_of(listed)
    shown = "ada@example.com" in text_of(listed) or "Example Studio" in text_of(listed)
    assert shown == (role == "owner")
