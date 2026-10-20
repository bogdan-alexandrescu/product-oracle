"""Provider OAuth with PKCE (state round trip, callback) and token refresh."""

import base64
import hashlib
import json
import time
import uuid
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs, urlparse

import httpx
import pytest

from oracle import crypto
from oracle.connections import oauth, service
from oracle.connections.models import Connection
from oracle.connections.providers import DRIVE_READONLY, PROVIDERS
from oracle.tenancy import tenant_session
from tests.connection_helpers import (
    add_connection,
    clear_provider_http,
    make_person,
    use_provider_http,
)


@pytest.fixture
def github_client(monkeypatch):
    monkeypatch.setenv("ORACLE_OAUTH_GITHUB_CLIENT_ID", "client-123")
    monkeypatch.setenv("ORACLE_OAUTH_GITHUB_CLIENT_SECRET", "secret-456")
    monkeypatch.setenv("ORACLE_OAUTH_GOOGLE_CLIENT_ID", "g-client")
    monkeypatch.setenv("ORACLE_OAUTH_GOOGLE_CLIENT_SECRET", "g-secret")
    monkeypatch.setenv("ORACLE_OAUTH_REDIRECT_BASE", "https://oracle.example.com")
    oauth.get_oauth_settings.cache_clear()
    yield
    oauth.get_oauth_settings.cache_clear()


@pytest.fixture(autouse=True)
def _no_http_override():
    yield
    clear_provider_http()


@pytest.fixture
async def alice(tenant_id):
    return await make_person(tenant_id, "alice@example.com", "approver")


# --- State --------------------------------------------------------------------------


def _state(**kw) -> oauth.State:
    return oauth.State(
        tenant_id=kw.get("tenant_id", uuid.uuid4()),
        user_id=kw.get("user_id", uuid.uuid4()),
        provider=kw.get("provider", "github"),
        verifier=kw.get("verifier", "v" * 64),
        connection_id=kw.get("connection_id"),
    )


def test_state_round_trip_is_encrypted_and_signed():
    st = _state(connection_id=uuid.uuid4())
    value = oauth.encode_state(st)
    assert st.verifier not in value
    assert str(st.user_id) not in value
    assert oauth.decode_state(value, "github") == st


def test_state_rejects_tampering_other_provider_and_age():
    value = oauth.encode_state(_state())
    with pytest.raises(oauth.InvalidState):
        oauth.decode_state(value[:-2] + ("AA" if not value.endswith("AA") else "BB"), "github")
    with pytest.raises(oauth.InvalidState):
        oauth.decode_state(value, "slack")
    with pytest.raises(oauth.InvalidState):
        oauth.decode_state("garbage", "github")
    time.sleep(1.1)
    with pytest.raises(oauth.InvalidState):
        oauth.decode_state(value, "github", max_age=0)


def test_pkce_challenge_is_s256_of_verifier():
    verifier, challenge = oauth.pkce_pair()
    assert 43 <= len(verifier) <= 128
    expected = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=")
    assert challenge == expected.decode()


# --- Authorize + callback -----------------------------------------------------------


async def test_authorize_needs_a_configured_client(client, alice):
    resp = await client.get("/v1/connections/github/authorize", headers=alice.headers)
    assert resp.status_code == 409
    assert "paste a token" in resp.json()["detail"]
    fireflies = await client.get("/v1/connections/fireflies/authorize", headers=alice.headers)
    assert fireflies.status_code == 409


async def test_oauth_flow_end_to_end(client, tenant_id, alice, github_client):
    resp = await client.get("/v1/connections/github/authorize", headers=alice.headers)
    assert resp.status_code == 200
    url = urlparse(resp.json()["url"])
    q = {k: v[0] for k, v in parse_qs(url.query).items()}
    assert url.netloc == "github.com"
    assert q["client_id"] == "client-123"
    assert q["redirect_uri"] == "https://oracle.example.com/v1/connections/github/callback"
    assert q["code_challenge_method"] == "S256"
    assert q["scope"] == "read:user repo"
    assert "secret-456" not in resp.text
    verifier = oauth.decode_state(q["state"], "github").verifier

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url == "https://github.com/login/oauth/access_token":
            form = parse_qs(request.content.decode())
            assert form["code"] == ["the-code"]
            assert form["code_verifier"] == [verifier]
            assert form["client_secret"] == ["secret-456"]
            return httpx.Response(
                200,
                json={
                    "access_token": "example-access",
                    "refresh_token": "example-refresh",
                    "expires_in": 28800,
                    "scope": "read:user,repo",
                },
            )
        assert request.headers["Authorization"] == "Bearer example-access"
        return httpx.Response(200, json={"id": 42, "login": "user-42"})

    use_provider_http(handler)
    back = await client.get(
        "/v1/connections/github/callback",
        params={"code": "the-code", "state": q["state"]},
        headers=alice.headers,
    )
    assert back.status_code == 303
    assert back.headers["location"] == "/settings/connections?connected=github"

    listed = (await client.get("/v1/connections", headers=alice.headers)).json()
    assert len(listed) == 1
    assert listed[0]["auth_mode"] == "oauth"
    assert listed[0]["scopes"] == ["read:user", "repo"]
    assert listed[0]["expires_at"] is not None
    async with tenant_session(tenant_id) as s:
        row = await s.get(Connection, uuid.UUID(listed[0]["id"]))
        bundle = json.loads(crypto.decrypt(row.ciphertext))
        assert bundle == {"access_token": "example-access", "refresh_token": "example-refresh"}


async def test_callback_by_another_user_or_with_errors_connects_nothing(
    client, tenant_id, alice, github_client
):
    bob = await make_person(tenant_id, "bob@example.com", "viewer")
    started = await client.get("/v1/connections/github/authorize", headers=alice.headers)
    url = started.json()["url"]
    state = parse_qs(urlparse(url).query)["state"][0]
    use_provider_http(lambda r: pytest.fail("no token exchange expected"))

    stolen = await client.get(
        "/v1/connections/github/callback",
        params={"code": "c", "state": state},
        headers=bob.headers,
    )
    assert stolen.status_code == 303
    assert "error=" in stolen.headers["location"]

    denied = await client.get(
        "/v1/connections/github/callback",
        params={"error": "access_denied", "state": state},
        headers=alice.headers,
    )
    assert "error=access_denied" in denied.headers["location"]

    forged = await client.get(
        "/v1/connections/github/callback",
        params={"code": "c", "state": "forged"},
        headers=alice.headers,
    )
    assert "error=" in forged.headers["location"]
    assert (await client.get("/v1/connections", headers=alice.headers)).json() == []


async def test_callback_with_refused_code(client, alice, github_client):
    started = await client.get("/v1/connections/github/authorize", headers=alice.headers)
    url = started.json()["url"]
    state = parse_qs(urlparse(url).query)["state"][0]
    use_provider_http(lambda r: httpx.Response(200, json={"error": "bad_verification_code"}))
    back = await client.get(
        "/v1/connections/github/callback",
        params={"code": "c", "state": state},
        headers=alice.headers,
    )
    assert back.status_code == 303
    assert "error=" in back.headers["location"]
    assert (await client.get("/v1/connections", headers=alice.headers)).json() == []


def test_slack_user_token_and_notion_basic_auth_shapes(monkeypatch):
    slack = PROVIDERS["slack"]
    user = {"access_token": "example-slack-user", "scope": "channels:read"}
    data = {"ok": True, "authed_user": user}
    assert slack.parse_token_response(data)["access_token"] == "example-slack-user"
    assert slack.oauth.scope_param == "user_scope"
    assert PROVIDERS["notion"].oauth.client_auth == "basic"


# --- Refresh ------------------------------------------------------------------------


def _soon(minutes: int) -> datetime:
    return datetime.now(UTC) + timedelta(minutes=minutes)


def _token_endpoint(response: httpx.Response | Exception):
    calls: list[httpx.Request] = []

    def handler(request):
        calls.append(request)
        if isinstance(response, Exception):
            raise response
        return response

    return httpx.AsyncClient(transport=httpx.MockTransport(handler)), calls


async def _oauth_conn(tenant_id, user_id, minutes: int, refresh: str | None = "r1"):
    bundle = {"access_token": "a1", "refresh_token": refresh}
    return await add_connection(
        tenant_id, user_id, "google", auth_mode="oauth", account_id="g-1",
        bundle=bundle, expires_at=_soon(minutes), scopes=["openid", "email", DRIVE_READONLY],
    )  # fmt: skip


async def test_get_credential_returns_token_without_refresh_when_fresh(
    tenant_id, alice, github_client
):
    conn = await _oauth_conn(tenant_id, alice.id, minutes=30)
    http, calls = _token_endpoint(httpx.Response(500))
    async with tenant_session(tenant_id) as s:
        cred = await service.get_credential(s, conn.id, alice.id, http=http)
    assert cred.access_token == "a1"
    assert calls == []
    async with tenant_session(tenant_id) as s:
        assert (await s.get(Connection, conn.id)).last_used_at is not None


async def test_get_credential_refreshes_within_five_minutes(tenant_id, alice, github_client):
    conn = await _oauth_conn(tenant_id, alice.id, minutes=4)
    http, calls = _token_endpoint(
        httpx.Response(200, json={"access_token": "a2", "refresh_token": "r2", "expires_in": 3600})
    )
    async with tenant_session(tenant_id) as s:
        cred = await service.get_credential(s, conn.id, alice.id, http=http)
    assert cred.access_token == "a2"
    assert parse_qs(calls[0].content.decode())["refresh_token"] == ["r1"]
    async with tenant_session(tenant_id) as s:
        row = await s.get(Connection, conn.id)
        assert json.loads(crypto.decrypt(row.ciphertext))["refresh_token"] == "r2"
        assert row.expires_at > _soon(50)
        assert row.status == "active"


async def test_refresh_keeps_refresh_token_when_not_rotated(tenant_id, alice, github_client):
    conn = await _oauth_conn(tenant_id, alice.id, minutes=1)
    http, _ = _token_endpoint(httpx.Response(200, json={"access_token": "a2", "expires_in": 60}))
    async with tenant_session(tenant_id) as s:
        await service.get_credential(s, conn.id, alice.id, http=http)
    async with tenant_session(tenant_id) as s:
        row = await s.get(Connection, conn.id)
        assert json.loads(crypto.decrypt(row.ciphertext))["refresh_token"] == "r1"


async def test_refused_refresh_marks_expired(tenant_id, alice, github_client):
    conn = await _oauth_conn(tenant_id, alice.id, minutes=2)
    http, _ = _token_endpoint(httpx.Response(400, json={"error": "invalid_grant"}))
    async with tenant_session(tenant_id) as s:
        with pytest.raises(service.ConnectionUnavailable) as e:
            await service.get_credential(s, conn.id, alice.id, http=http)
    assert e.value.status == "expired"
    async with tenant_session(tenant_id) as s:
        row = await s.get(Connection, conn.id)
        assert row.status == "expired"
        assert "invalid_grant" in row.last_error
    # Once expired it stays unusable until reconnected.
    async with tenant_session(tenant_id) as s:
        with pytest.raises(service.ConnectionUnavailable):
            await service.get_credential(s, conn.id, alice.id, http=http)


async def test_provider_down_uses_token_until_it_expires_then_marks_error(
    tenant_id, alice, github_client
):
    still_valid = await _oauth_conn(tenant_id, alice.id, minutes=3)
    http, _ = _token_endpoint(httpx.ConnectError("down"))
    async with tenant_session(tenant_id) as s:
        cred = await service.get_credential(s, still_valid.id, alice.id, http=http)
    assert cred.access_token == "a1"

    async with tenant_session(tenant_id) as s:
        row = await s.get(Connection, still_valid.id)
        row.expires_at = _soon(-1)
        await s.commit()
    async with tenant_session(tenant_id) as s:
        with pytest.raises(service.ConnectionUnavailable) as e:
            await service.get_credential(s, still_valid.id, alice.id, http=http)
    assert e.value.status == "error"
    async with tenant_session(tenant_id) as s:
        row = await s.get(Connection, still_valid.id)
        assert row.status == "error" and "Refresh failed" in row.last_error


async def test_expired_without_refresh_token_is_marked_expired(tenant_id, alice, github_client):
    conn = await _oauth_conn(tenant_id, alice.id, minutes=-1, refresh=None)
    http, calls = _token_endpoint(httpx.Response(500))
    async with tenant_session(tenant_id) as s:
        with pytest.raises(service.ConnectionUnavailable):
            await service.get_credential(s, conn.id, alice.id, http=http)
    assert calls == []
    async with tenant_session(tenant_id) as s:
        assert (await s.get(Connection, conn.id)).status == "expired"


async def test_get_credential_never_serves_another_users_connection(tenant_id, alice):
    bob = await make_person(tenant_id, "bob@example.com", "viewer")
    conn = await add_connection(tenant_id, alice.id, "github")
    async with tenant_session(tenant_id) as s:
        with pytest.raises(service.ConnectionUnavailable):
            await service.get_credential(s, conn.id, bob.id)
        cred = await service.get_credential(s, conn.id, alice.id)
    assert cred.access_token == "tok"
    assert cred.provider == "github"


async def test_reconnect_oauth_refreshes(client, tenant_id, alice, github_client):
    conn = await _oauth_conn(tenant_id, alice.id, minutes=60)

    def handler(request):
        if request.url.host == "oauth2.googleapis.com":
            return httpx.Response(200, json={"access_token": "a9", "expires_in": 3600})
        assert request.headers["Authorization"] == "Bearer a9"
        return httpx.Response(200, json={"sub": "g-1", "email": "pat@example.com"})

    use_provider_http(handler)
    resp = await client.post(f"/v1/connections/{conn.id}/reconnect", headers=alice.headers)
    assert resp.status_code == 200, resp.text
    assert resp.json()["connection"]["status"] == "active"
    assert resp.json()["authorize_url"] is None


async def test_reconnect_oauth_without_refresh_returns_sign_in_url(
    client, tenant_id, alice, github_client
):
    conn = await _oauth_conn(tenant_id, alice.id, minutes=-5, refresh=None)
    use_provider_http(lambda r: pytest.fail("nothing to call"))
    resp = await client.post(f"/v1/connections/{conn.id}/reconnect", headers=alice.headers)
    assert resp.status_code == 200
    url = resp.json()["authorize_url"]
    assert url.startswith("https://accounts.google.com/")
    state = parse_qs(urlparse(url).query)["state"][0]
    assert oauth.decode_state(state, "google").connection_id == conn.id


# --- Disconnect revokes at the provider -------------------------------------------------


@pytest.mark.parametrize(
    ("provider", "method", "url"),
    [
        ("github", "DELETE", "https://api.github.com/applications/client-123/token"),
        ("google", "POST", "https://oauth2.googleapis.com/revoke"),
    ],
)
async def test_disconnect_revokes_an_oauth_grant_then_deletes(
    client, tenant_id, alice, github_client, provider, method, url
):
    conn = await add_connection(
        tenant_id,
        alice.id,
        provider,
        auth_mode="oauth",
        bundle={"access_token": "at-1", "refresh_token": "rt-1"},
    )
    seen = use_provider_http(lambda r: httpx.Response(200 if provider == "google" else 204))
    resp = await client.delete(f"/v1/connections/{conn.id}", headers=alice.headers)
    assert resp.status_code == 204
    assert [(r.method, str(r.url).split("?")[0]) for r in seen] == [(method, url)]
    if provider == "github":
        assert json.loads(seen[0].content) == {"access_token": "at-1"}
        assert seen[0].headers["authorization"].startswith("Basic ")
    else:
        assert parse_qs(seen[0].content.decode()) == {"token": ["rt-1"]}  # the whole grant
    async with tenant_session(tenant_id) as s:
        assert await s.get(Connection, conn.id) is None


async def test_disconnect_revokes_slack_and_survives_provider_failure(client, tenant_id, alice):
    slack = await add_connection(
        tenant_id, alice.id, "slack", auth_mode="oauth", bundle={"access_token": "xoxp-1"}
    )
    # Slack's revoke is token-authenticated: no client secret needed, but the client must
    # be configured for a grant Oracle obtained; without one, nothing is called.
    seen = use_provider_http(lambda r: httpx.Response(200, json={"ok": True, "revoked": True}))
    assert (
        await client.delete(f"/v1/connections/{slack.id}", headers=alice.headers)
    ).status_code == 204
    assert seen == []

    env = {"ORACLE_OAUTH_SLACK_CLIENT_ID": "s", "ORACLE_OAUTH_SLACK_CLIENT_SECRET": "t"}
    with pytest.MonkeyPatch.context() as mp:
        for k, v in env.items():
            mp.setenv(k, v)
        oauth.get_oauth_settings.cache_clear()
        slack = await add_connection(
            tenant_id, alice.id, "slack", auth_mode="oauth", bundle={"access_token": "xoxp-2"}
        )
        seen = use_provider_http(lambda r: httpx.Response(200, json={"ok": True}))
        resp = await client.delete(f"/v1/connections/{slack.id}", headers=alice.headers)
        assert resp.status_code == 204
        assert [str(r.url) for r in seen] == ["https://slack.com/api/auth.revoke"]
        assert seen[0].headers["authorization"] == "Bearer xoxp-2"

        # The provider failing does not keep Oracle's copy: best effort.
        slack = await add_connection(
            tenant_id, alice.id, "slack", auth_mode="oauth", bundle={"access_token": "xoxp-3"}
        )
        use_provider_http(lambda r: httpx.Response(503))
        resp = await client.delete(f"/v1/connections/{slack.id}", headers=alice.headers)
        assert resp.status_code == 204
        async with tenant_session(tenant_id) as s:
            assert await s.get(Connection, slack.id) is None
    oauth.get_oauth_settings.cache_clear()


async def test_disconnect_leaves_pasted_tokens_alone(client, tenant_id, alice, github_client):
    conn = await add_connection(tenant_id, alice.id, "github", bundle={"access_token": "pat"})
    seen = use_provider_http(lambda r: httpx.Response(204))
    assert (
        await client.delete(f"/v1/connections/{conn.id}", headers=alice.headers)
    ).status_code == 204
    assert seen == []
