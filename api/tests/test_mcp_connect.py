"""Connecting an AI tool from the app (#1553, Nov 23): My account gives the MCP address,
each connected client says where it runs and when it was last used on /mcp (stored, at
most once a minute per grant), and owners see who in the company is connected."""

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select, update

from oracle.auth.service import hash_token
from oracle.mcp.oauth.models import OAuthClient, OAuthToken
from oracle.tenancy import tenant_session, unscoped_session
from tests.conftest import make_tenant
from tests.test_mcp import mcp_client, user_with_role
from tests.test_oauth import BASE, full_flow, register

OTHER = "https://app.example.org/callback"


async def test_my_account_gives_the_mcp_address(client):
    """The address a person copies is the one /mcp serves its metadata for."""
    await full_flow(client)
    account = (await client.get("/v1/me/account")).json()
    resource = (await client.get("/.well-known/oauth-protected-resource/mcp")).json()
    assert account["mcp_url"] == f"{BASE}/mcp" == resource["resource"]


async def test_a_connected_client_says_where_it_runs(client):
    """A loopback redirect address is the person's computer; otherwise the site's host."""
    await full_flow(client)
    await register(client, client_name="Web Helper", redirect_uris=[OTHER])
    rows = (await client.get("/v1/me/oauth-clients")).json()
    assert [r["runs_on"] for r in rows] == ["Your computer"]
    async with unscoped_session() as s:
        web = await s.scalar(select(OAuthClient).where(OAuthClient.name == "Web Helper"))
        tok = await s.scalar(select(OAuthToken))
        assert web is not None and tok is not None
        s.add(
            OAuthToken(
                tenant_id=tok.tenant_id,
                access_hash=hash_token(f"poa_{uuid.uuid4().hex}"),
                refresh_hash=hash_token(f"por_{uuid.uuid4().hex}"),
                client_id=web.id,
                user_id=tok.user_id,
                scope="oracle:read",
                expires_at=tok.expires_at,
                refresh_expires_at=tok.refresh_expires_at,
                family_id=uuid.uuid4(),
            )
        )
        await s.commit()
    rows = (await client.get("/v1/me/oauth-clients")).json()
    assert sorted(r["runs_on"] for r in rows) == ["Your computer", "app.example.org"]


async def _used_at() -> datetime | None:
    async with unscoped_session() as s:
        return await s.scalar(select(OAuthToken.used_at))


async def _list_tools(access: str) -> None:
    async with mcp_client(access) as c:
        await c.list_tools()


async def test_last_used_is_stored_when_a_token_is_used_on_mcp(client):
    """Using a grant's token on /mcp records the time, at most once a minute."""
    _, issued = await full_flow(client)
    long_ago = datetime.now(UTC) - timedelta(days=2)
    async with unscoped_session() as s:
        await s.execute(update(OAuthToken).values(created_at=long_ago, used_at=None))
        await s.commit()
    before = (await client.get("/v1/me/oauth-clients")).json()[0]["last_used_at"]
    assert datetime.fromisoformat(before) < datetime.now(UTC) - timedelta(days=1)

    await _list_tools(issued["access_token"])
    first = await _used_at()
    assert first is not None and first > datetime.now(UTC) - timedelta(minutes=1)
    row = (await client.get("/v1/me/oauth-clients")).json()[0]
    assert datetime.fromisoformat(row["last_used_at"]) == first

    await _list_tools(issued["access_token"])
    assert await _used_at() == first  # within the minute: no write

    a_while = datetime.now(UTC) - timedelta(minutes=2)
    async with unscoped_session() as s:
        await s.execute(update(OAuthToken).values(used_at=a_while))
        await s.commit()
    await _list_tools(issued["access_token"])
    later = await _used_at()
    assert later is not None and later > a_while + timedelta(minutes=1)


async def _other_company_grant() -> None:
    """A second company with one connected client: never counted in the first."""
    tenant_id = await make_tenant("Other Co")
    user = await user_with_role(tenant_id, "owner", "owner@example.net")
    async with tenant_session(tenant_id) as s:
        c = OAuthClient(
            tenant_id=tenant_id,
            client_id=f"pocl_{uuid.uuid4().hex}",
            name="Other Agent",
            redirect_uris=[OTHER],
        )
        s.add(c)
        await s.flush()
        now = datetime.now(UTC)
        s.add(
            OAuthToken(
                tenant_id=tenant_id,
                access_hash=hash_token(f"poa_{uuid.uuid4().hex}"),
                refresh_hash=hash_token(f"por_{uuid.uuid4().hex}"),
                client_id=c.id,
                user_id=user.id,
                scope="oracle:read oracle:write",
                expires_at=now + timedelta(hours=1),
                refresh_expires_at=now + timedelta(days=30),
                family_id=uuid.uuid4(),
            )
        )
        await s.commit()


async def test_owners_see_who_in_the_company_is_connected(client):
    """n of m people connected, each with their role, client count and newest use."""
    await full_flow(client)
    await _other_company_grant()
    tenant_id = uuid.UUID((await client.get("/v1/me")).json()["tenant_id"])
    await user_with_role(tenant_id, "viewer", "viewer@example.com")
    body = (await client.get("/v1/mcp-people")).json()
    assert body["connected"] == 1 and body["total"] == 2
    people = {p["email"]: p for p in body["people"]}
    assert set(people) == {"admin@example.com", "viewer@example.com"}
    assert people["admin@example.com"]["clients"] == 1
    assert people["admin@example.com"]["role"] == "owner"
    assert people["admin@example.com"]["last_used_at"] is not None
    assert people["viewer@example.com"]["clients"] == 0
    assert people["viewer@example.com"]["last_used_at"] is None

    for g in (await client.get("/v1/me/oauth-clients")).json():
        await client.delete(f"/v1/me/oauth-clients/{g['id']}")
    assert (await client.get("/v1/mcp-people")).json()["connected"] == 0


async def test_only_owners_see_the_company_view(client):
    """Anyone but an owner is refused the company view."""
    await full_flow(client, role="approver")
    assert (await client.get("/v1/mcp-people")).status_code == 403
