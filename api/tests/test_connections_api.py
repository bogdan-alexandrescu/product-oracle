"""The connections API: per-user, encrypted at rest, never returns a credential."""

import json

import httpx
import pytest
from sqlalchemy import select

from oracle import crypto
from oracle.auth.service import create_api_token
from oracle.connections.models import Connection
from oracle.models import AuditEvent
from oracle.tenancy import tenant_session
from tests.connection_helpers import (
    add_connection,
    clear_provider_http,
    make_person,
    use_provider_http,
)

GITHUB_TOKEN = "example-github-token-1"


def github(request: httpx.Request) -> httpx.Response:
    token = request.headers.get("Authorization", "").removeprefix("Bearer ")
    if token.startswith("example-github"):
        # Every example token is the same account except the "other" one.
        account = 7 if token.endswith("-x") else 42
        return httpx.Response(
            200,
            json={"id": account, "login": f"user-{account}"},
            headers={"X-OAuth-Scopes": "repo"},
        )
    return httpx.Response(401, json={"message": "Bad credentials"})


@pytest.fixture(autouse=True)
def _http():
    seen = use_provider_http(github)
    yield seen
    clear_provider_http()


@pytest.fixture
async def alice(tenant_id):
    return await make_person(tenant_id, "alice@example.com", "owner")


@pytest.fixture
async def bob(tenant_id):
    return await make_person(tenant_id, "bob@example.com", "commenter")


async def test_connect_with_token_stores_it_encrypted_and_never_returns_it(
    client, tenant_id, alice
):
    resp = await client.post(
        "/v1/connections/github/token", json={"token": GITHUB_TOKEN}, headers=alice.headers
    )
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["provider"] == "github"
    assert out["auth_mode"] == "token"
    assert out["account_id"] == "42"
    assert out["account_label"] == "user-42"
    assert out["scopes"] == ["repo"]
    assert out["status"] == "active"
    assert GITHUB_TOKEN not in resp.text

    listed = await client.get("/v1/connections", headers=alice.headers)
    assert [c["id"] for c in listed.json()] == [out["id"]]
    assert GITHUB_TOKEN not in listed.text
    assert "ciphertext" not in listed.text

    async with tenant_session(tenant_id) as s:
        row = await s.scalar(select(Connection))
        assert row.user_id == alice.id
        assert GITHUB_TOKEN.encode() not in row.ciphertext
        assert row.key_version == crypto.KEY_VERSION
        assert json.loads(crypto.decrypt(row.ciphertext))["access_token"] == GITHUB_TOKEN
        audit = (await s.scalars(select(AuditEvent))).all()
        assert any(a.action == "connection.connect" for a in audit)
        assert all(GITHUB_TOKEN not in json.dumps(a.data) for a in audit)


async def test_label_override_and_same_account_reconnects_in_place(client, alice):
    first = await client.post(
        "/v1/connections/github/token",
        json={"token": GITHUB_TOKEN, "label": "Work GitHub"},
        headers=alice.headers,
    )
    assert first.json()["account_label"] == "Work GitHub"
    again = await client.post(
        "/v1/connections/github/token",
        json={"token": GITHUB_TOKEN + "2"},
        headers=alice.headers,
    )
    assert again.json()["id"] == first.json()["id"]
    other = await client.post(
        "/v1/connections/github/token", json={"token": "example-github-x"}, headers=alice.headers
    )
    assert other.json()["id"] != first.json()["id"]
    assert len((await client.get("/v1/connections", headers=alice.headers)).json()) == 2


async def test_rejected_token_unknown_provider_and_provider_down(client, alice):
    bad = await client.post(
        "/v1/connections/github/token", json={"token": "nope"}, headers=alice.headers
    )
    assert bad.status_code == 400
    assert "GitHub rejected the token" in bad.json()["detail"]

    unknown = await client.post(
        "/v1/connections/dropbox/token", json={"token": "x"}, headers=alice.headers
    )
    assert unknown.status_code == 404

    use_provider_http(lambda r: httpx.Response(503))
    down = await client.post(
        "/v1/connections/github/token", json={"token": GITHUB_TOKEN}, headers=alice.headers
    )
    assert down.status_code == 502
    assert (await client.get("/v1/connections", headers=alice.headers)).json() == []


async def test_user_b_never_sees_or_touches_user_a_connections(client, tenant_id, alice, bob):
    conn = await add_connection(tenant_id, alice.id, "github")
    assert (await client.get("/v1/connections", headers=bob.headers)).json() == []
    assert len((await client.get("/v1/connections", headers=alice.headers)).json()) == 1

    deleted = await client.delete(f"/v1/connections/{conn.id}", headers=bob.headers)
    assert deleted.status_code == 404
    reconnect = await client.post(f"/v1/connections/{conn.id}/reconnect", headers=bob.headers)
    assert reconnect.status_code == 404
    async with tenant_session(tenant_id) as s:
        assert await s.get(Connection, conn.id) is not None


async def test_other_tenant_cannot_see_connections(client, tenant_id, alice):
    from tests.conftest import make_tenant

    await add_connection(tenant_id, alice.id, "github")
    other_tenant = await make_tenant("Other Co")
    mallory = await make_person(other_tenant, "alice@example.com", "owner")
    assert (await client.get("/v1/connections", headers=mallory.headers)).json() == []


async def test_api_tokens_have_no_connections(client, tenant_id):
    async with tenant_session(tenant_id) as s:
        _, raw = await create_api_token(s, "agent")
        await s.commit()
    resp = await client.get("/v1/connections", headers={"Authorization": f"Bearer {raw}"})
    assert resp.status_code == 403
    assert (await client.get("/v1/connections")).status_code == 401


async def test_disconnect_removes_row(client, tenant_id, alice):
    conn = await add_connection(
        tenant_id, alice.id, "github", account_id="7", bundle={"access_token": "t"}
    )
    resp = await client.delete(f"/v1/connections/{conn.id}", headers=alice.headers)
    assert resp.status_code == 204
    async with tenant_session(tenant_id) as s:
        assert await s.get(Connection, conn.id) is None


async def test_reconnect_with_new_token_same_account_only(client, tenant_id, alice):
    conn = await add_connection(
        tenant_id, alice.id, "github", account_id="42", status="expired", label="user-42"
    )
    other = await client.post(
        f"/v1/connections/{conn.id}/reconnect",
        json={"token": "example-github-x"},
        headers=alice.headers,
    )
    assert other.status_code == 400
    assert "user-7" in other.json()["detail"]

    ok = await client.post(
        f"/v1/connections/{conn.id}/reconnect", json={"token": GITHUB_TOKEN}, headers=alice.headers
    )
    assert ok.status_code == 200, ok.text
    assert ok.json()["connection"]["status"] == "active"
    async with tenant_session(tenant_id) as s:
        row = await s.get(Connection, conn.id)
        assert json.loads(crypto.decrypt(row.ciphertext))["access_token"] == GITHUB_TOKEN


async def test_reconnect_without_token_rechecks_stored_token(client, tenant_id, alice):
    good = await add_connection(
        tenant_id, alice.id, "github", account_id="42", status="error",
        bundle={"access_token": GITHUB_TOKEN},
    )  # fmt: skip
    resp = await client.post(f"/v1/connections/{good.id}/reconnect", headers=alice.headers)
    assert resp.status_code == 200
    assert resp.json()["connection"]["status"] == "active"
    assert resp.json()["connection"]["last_error"] is None

    revoked = await add_connection(
        tenant_id, alice.id, "github", account_id="43", bundle={"access_token": "revoked"}
    )
    resp = await client.post(f"/v1/connections/{revoked.id}/reconnect", headers=alice.headers)
    assert resp.status_code == 409
    async with tenant_session(tenant_id) as s:
        row = await s.get(Connection, revoked.id)
        assert row.status == "expired"
        assert "rejected" in row.last_error


async def test_providers_list_reports_oauth_configuration(client, alice):
    resp = await client.get("/v1/connections/providers", headers=alice.headers)
    assert resp.status_code == 200
    by_key = {p["key"]: p for p in resp.json()}
    assert set(by_key) == {"github", "slack", "notion", "fireflies", "google"}
    assert not any(p["oauth_configured"] for p in by_key.values())
