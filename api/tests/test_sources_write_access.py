"""Changing sources needs write access: an MCP client approved with oracle:read only
reads as a viewer and may not add, edit, sync, pause or delete the person's sources,
over REST or through its MCP tools. It may still list them (browsing Drive is refused:
that only finds ids for an edit)."""

import pytest
from sqlalchemy import select

from oracle.auth.models import User
from oracle.sources import base, service
from oracle.sources.models import Source
from oracle.tenancy import unscoped_session
from tests.sources_helpers import FakeConnector, make_connection
from tests.test_oauth import full_flow


@pytest.fixture
def slack(monkeypatch):
    service.load_connectors()
    fake = FakeConnector(kind="slack")
    monkeypatch.setitem(base._registry, "slack", fake)
    return fake


async def _source(admin: User) -> Source:
    conn = await make_connection(admin.tenant_id, admin, "slack")
    from oracle.tenancy import tenant_session

    async with tenant_session(admin.tenant_id) as s:
        source = Source(
            owner_user_id=admin.id,
            connection_id=conn,
            kind="slack",
            name="Product",
            config={"channels": ["C1"]},
            status="active",
        )
        s.add(source)
        await s.commit()
        return source


async def _admin() -> User:
    async with unscoped_session() as s:
        return await s.scalar(select(User).where(User.email == "admin@example.com"))


@pytest.mark.parametrize(("scope", "can_write"), [("oracle:read", False), (None, True)])
async def test_source_writes_need_oracle_write(client, slack, scope, can_write):
    _, tok = await full_flow(client, scope=scope)
    client.cookies.clear()
    auth = {"Authorization": f"Bearer {tok['access_token']}"}
    admin = await _admin()
    source = await _source(admin)
    conn = await make_connection(admin.tenant_id, admin, "slack")
    path = f"/v1/sources/{source.id}"

    assert (await client.get("/v1/sources", headers=auth)).status_code == 200
    assert (await client.get(path, headers=auth)).status_code == 200
    writes = [
        await client.post(
            "/v1/sources",
            json={
                "kind": "slack",
                "name": "New",
                "connection_id": str(conn),
                "config": {"channels": ["C2"]},
            },
            headers=auth,
        ),
        await client.patch(path, json={"name": "Renamed"}, headers=auth),
        await client.post(f"{path}/sync", headers=auth),
        await client.post(f"{path}/pause", headers=auth),
        await client.post(f"{path}/resume", headers=auth),
        await client.delete(path, headers=auth),
    ]
    codes = [r.status_code for r in writes]
    if can_write:
        assert codes == [201, 200, 200, 200, 200, 204], [r.text for r in writes]
    else:
        assert codes == [403] * 6
        assert "oracle:write" in writes[0].json()["detail"]


async def test_mcp_tools_refuse_source_writes_for_a_read_only_client(client, slack):
    from tests.test_mcp import mcp_client, text_of

    _, tok = await full_flow(client, scope="oracle:read")
    admin = await _admin()
    source = await _source(admin)
    async with mcp_client(tok["access_token"]) as c:
        listed = await c.call_tool("list_sources", {})
        synced = await c.call_tool("sync_source", {"source_id": str(source.id)})
        deleted = await c.call_tool("delete_source", {"source_id": str(source.id)})
    assert not listed.is_error, text_of(listed)
    assert synced.is_error and "HTTP 403" in text_of(synced)
    assert deleted.is_error and "HTTP 403" in text_of(deleted)


async def _personal_token(scope: str) -> str:
    """A personal API token (po_...) for the seeded admin with ``scope``."""
    from oracle.auth.service import create_api_token
    from oracle.seed import seed
    from oracle.tenancy import tenant_session

    await seed(password="correct horse")
    admin = await _admin()
    async with tenant_session(admin.tenant_id) as s:
        _, raw = await create_api_token(s, "pat", user_id=admin.id, scope=scope)
        await s.commit()
    return raw


@pytest.mark.parametrize("scope", ["oracle:read", "", "unknown:scope"])
async def test_a_read_only_personal_token_changes_no_source(client, slack, scope):
    """A personal API token without oracle:write is read-only as an oracle:read MCP
    client is: every source write is a 403 (empty or unknown scopes fail closed)."""
    auth = {"Authorization": f"Bearer {await _personal_token(scope)}"}
    admin = await _admin()
    source = await _source(admin)
    conn = await make_connection(admin.tenant_id, admin, "slack")
    path = f"/v1/sources/{source.id}"
    assert (await client.get("/v1/sources", headers=auth)).status_code == 200
    writes = [
        await client.post(
            "/v1/sources",
            json={
                "kind": "slack",
                "name": "New",
                "connection_id": str(conn),
                "config": {"channels": ["C2"]},
            },
            headers=auth,
        ),
        await client.patch(path, json={"name": "Renamed"}, headers=auth),
        await client.post(f"{path}/pause", headers=auth),
        await client.delete(path, headers=auth),
    ]
    assert [r.status_code for r in writes] == [403] * 4, [r.text for r in writes]
    assert "oracle:write" in writes[0].json()["detail"]
    async with unscoped_session() as s:
        rows = (await s.scalars(select(Source))).all()
    assert [(x.name, x.status) for x in rows] == [("Product", "active")]


async def test_mcp_tools_refuse_source_writes_for_a_read_only_personal_token(client, slack):
    from tests.test_mcp import mcp_client, text_of

    raw = await _personal_token("oracle:read")
    source = await _source(await _admin())
    async with mcp_client(raw) as c:
        listed = await c.call_tool("list_sources", {})
        paused = await c.call_tool("pause_source", {"source_id": str(source.id)})
        deleted = await c.call_tool("delete_source", {"source_id": str(source.id)})
    assert not listed.is_error, text_of(listed)
    assert paused.is_error and "HTTP 403" in text_of(paused), text_of(paused)
    assert deleted.is_error and "HTTP 403" in text_of(deleted)
    async with unscoped_session() as s:
        assert (await s.scalar(select(Source.status))) == "active"
