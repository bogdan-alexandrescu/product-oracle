"""AC1: read-only credentials make no account changes. Every request but GET/HEAD from a
read-only principal (an MCP client approved with oracle:read only) is refused with 403
where the principal is resolved, not route by route: over MCP and directly on REST, so
disconnecting (which also revokes the grant at Google/GitHub/Slack), pasting a token and
reconnecting are refused along with everything else."""

import re
import uuid

import pytest
from sqlalchemy import select

from oracle.auth.deps import RUN_HEADER
from oracle.auth.models import User
from oracle.auth.service import sign_run_binding
from oracle.connections.models import Connection
from oracle.sources.models import Source
from oracle.tenancy import tenant_session, unscoped_session
from tests.connection_helpers import add_connection, clear_provider_http, use_provider_http
from tests.test_oauth import full_flow


@pytest.fixture
def provider():
    seen = use_provider_http(lambda request: pytest.fail(f"provider called: {request.url}"))
    yield seen
    clear_provider_http()


async def _admin() -> User:
    async with unscoped_session() as s:
        return await s.scalar(select(User).where(User.email == "admin@example.com"))


async def _bearer(client, scope: str | None) -> dict[str, str]:
    """A poa_ access token, used directly on REST (no cookie)."""
    _, tok = await full_flow(client, scope=scope)
    client.cookies.clear()
    assert tok["access_token"].startswith("poa_")
    return {"Authorization": f"Bearer {tok['access_token']}"}


def _pasted() -> dict[str, str]:
    """A body for the token routes (a placeholder: the route never reads it)."""
    return dict.fromkeys(["token"], "placeholder")


async def _exists(tenant_id, conn_id) -> bool:
    async with tenant_session(tenant_id) as s:
        return await s.get(Connection, conn_id) is not None


async def test_delete_connection_is_refused_and_nothing_is_revoked(client, provider):
    auth = await _bearer(client, "oracle:read")
    admin = await _admin()
    conn = await add_connection(admin.tenant_id, admin.id, "google", auth_mode="oauth")
    resp = await client.delete(f"/v1/connections/{conn.id}", headers=auth)
    assert resp.status_code == 403
    assert "oracle:read" in resp.json()["detail"]
    assert await _exists(admin.tenant_id, conn.id)
    assert provider == []


async def test_connect_with_token_is_refused(client, provider):
    auth = await _bearer(client, "oracle:read")
    resp = await client.post("/v1/connections/github/token", json=_pasted(), headers=auth)
    assert resp.status_code == 403
    admin = await _admin()
    async with tenant_session(admin.tenant_id) as s:
        assert (await s.scalars(select(Connection))).all() == []
    assert provider == []


async def test_reconnect_connection_is_refused(client, provider):
    auth = await _bearer(client, "oracle:read")
    admin = await _admin()
    conn = await add_connection(admin.tenant_id, admin.id, "github")
    for body in (_pasted(), None):
        resp = await client.post(f"/v1/connections/{conn.id}/reconnect", json=body, headers=auth)
        assert resp.status_code == 403, resp.text
    assert provider == []


def _write_routes() -> list[tuple[str, str]]:
    """Every non-GET/HEAD route that resolves a principal, with ids filled in."""
    from fastapi.routing import APIRoute

    from oracle.auth.deps import get_principal
    from oracle.main import app

    def calls(dep):
        yield dep.call
        for sub in dep.dependencies:
            yield from calls(sub)

    found = []

    def walk(routes, prefix=""):
        for r in routes:
            if isinstance(r, APIRoute):
                if get_principal in set(calls(r.dependant)):
                    path = re.sub(r"\{[^}]+\}", str(uuid.uuid4()), prefix + r.path)
                    found.extend((m, path) for m in sorted(r.methods - {"GET", "HEAD"}))
            elif hasattr(r, "original_router"):
                walk(r.original_router.routes, prefix + (r.include_context.prefix or ""))
            elif hasattr(r, "routes"):
                walk(r.routes, prefix)

    walk(app.router.routes)
    return found


WRITE_ROUTES = _write_routes()


def test_the_sweep_sees_the_routes_it_should():
    paths = {f"{m} {p.split('/')[2]}" for m, p in WRITE_ROUTES}
    assert {"POST sources", "PATCH sources", "DELETE sources", "DELETE connections"} <= paths
    assert len(WRITE_ROUTES) > 30


async def test_every_write_route_is_refused(client, provider):
    """Refused while resolving the principal, before the route runs or reads its body."""
    auth = await _bearer(client, "oracle:read")
    wrong = []
    for method, path in WRITE_ROUTES:
        resp = await client.request(method, path, headers=auth, json={})
        if resp.status_code != 403 or "oracle:read" not in resp.text:
            wrong.append((method, path, resp.status_code))
    assert wrong == []
    assert provider == []


async def test_reads_still_work(client):
    auth = await _bearer(client, "oracle:read")
    assert (await client.get("/v1/me", headers=auth)).status_code == 200
    assert (await client.get("/v1/connections", headers=auth)).status_code == 200
    assert (await client.head("/v1/me", headers=auth)).status_code in (200, 405)


async def test_a_write_client_may_still_disconnect(client, provider):
    auth = await _bearer(client, None)
    admin = await _admin()
    conn = await add_connection(admin.tenant_id, admin.id, "github")
    resp = await client.delete(f"/v1/connections/{conn.id}", headers=auth)
    assert resp.status_code == 204, resp.text
    assert not await _exists(admin.tenant_id, conn.id)


async def test_mcp_tools_are_refused_for_a_read_only_client(client, provider):
    from tests.test_mcp import mcp_client, text_of

    _, tok = await full_flow(client, scope="oracle:read")
    admin = await _admin()
    conn = await add_connection(admin.tenant_id, admin.id, "google", auth_mode="oauth")
    async with mcp_client(tok["access_token"]) as c:
        listed = await c.call_tool("list_connections", {})
        deleted = await c.call_tool("delete_connection", {"connection_id": str(conn.id)})
    assert not listed.is_error, text_of(listed)
    assert deleted.is_error and "HTTP 403" in text_of(deleted), text_of(deleted)
    assert await _exists(admin.tenant_id, conn.id)
    assert provider == []


# --- With the run binding (S6): a run's signed header changes nothing of AC1 ----------


async def test_a_read_only_credential_is_refused_with_or_without_the_run_binding(client, provider):
    """The read-only refusal is made where the bearer is resolved, before the run binding
    is read: a signed x-oracle-run-id for the same user (or a forged one) does not let a
    read-only client write, and a read with the binding still works."""
    auth = await _bearer(client, "oracle:read")
    admin = await _admin()
    signed = {**auth, RUN_HEADER: sign_run_binding(admin.id, uuid.uuid4())}
    forged = {**auth, RUN_HEADER: str(uuid.uuid4())}
    body = {"kind": "upload", "name": "Mine"}
    for headers in (auth, signed, forged):
        resp = await client.post("/v1/sources", json=body, headers=headers)
        assert resp.status_code == 403, resp.text
        assert "oracle:read" in resp.json()["detail"]
    async with tenant_session(admin.tenant_id) as s:
        assert (await s.scalars(select(Source))).all() == []
    assert (await client.get("/v1/sources", headers=signed)).status_code == 200
    assert provider == []


async def test_a_write_credential_with_the_run_binding_may_still_write(client, provider):
    auth = await _bearer(client, None)
    admin = await _admin()
    signed = {**auth, RUN_HEADER: sign_run_binding(admin.id, uuid.uuid4())}
    resp = await client.post("/v1/sources", json={"kind": "upload", "name": "Mine"}, headers=signed)
    assert resp.status_code == 201, resp.text
