"""OAuth 2.1 for MCP clients: discovery, registration, code + PKCE, refresh, revoke."""

import base64
import hashlib
import secrets
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs, unquote, urlsplit

import pytest
from sqlalchemy import func, select, update

from oracle.auth.models import ROLES, User
from oracle.auth.service import sign_run_binding
from oracle.authz import has_role
from oracle.mcp.oauth import service
from oracle.mcp.oauth.models import OAuthClient, OAuthCode, OAuthToken
from oracle.mcp.oauth.verify import verify_access_token, www_authenticate
from oracle.runs.models import Run
from oracle.seed import seed
from oracle.tenancy import tenant_session, unscoped_session
from tests.test_iap import HEADER, _join_at_once, assertion, fetches  # noqa: F401  (fetches: IAP on)

BASE = "http://test"
REDIRECT = "http://127.0.0.1:33418/callback"
PASSWORD = "correct horse"


def pkce() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
    return verifier, challenge.rstrip(b"=").decode()


async def register(client, **body) -> dict:
    body = {"client_name": "Example Agent", "redirect_uris": [REDIRECT], **body}
    resp = await client.post("/oauth/register", json=body)
    assert resp.status_code == 201, resp.text
    return resp.json()


async def sign_in(client, role: str = "owner"):
    r = await seed(password=PASSWORD)
    if role != "owner":
        async with tenant_session(r.tenant_id) as s:
            await s.execute(update(User).values(role=role))
            await s.commit()
    resp = await client.post(
        "/v1/auth/login", json={"email": "admin@example.com", "password": PASSWORD}
    )
    assert resp.status_code == 200
    return r


def authorize_params(client_id: str, challenge: str, **extra) -> dict:
    return {
        "response_type": "code",
        "client_id": client_id,
        "redirect_uri": REDIRECT,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "state": "xyz",
        **extra,
    }


def query(url: str) -> dict[str, str]:
    return {k: v[0] for k, v in parse_qs(urlsplit(url).query).items()}


async def consent_handle(client, params: dict) -> str:
    resp = await client.get("/oauth/authorize", params=params)
    assert resp.status_code == 302, resp.text
    location = resp.headers["location"]
    assert location.startswith(f"{BASE}/oauth/consent?request=")
    return query(location)["request"]


async def approve(client, params: dict) -> str:
    handle = await consent_handle(client, params)
    resp = await client.post("/oauth/authorize/decision", json={"request": handle, "approve": True})
    assert resp.status_code == 200, resp.text
    back = query(resp.json()["redirect_to"])
    assert back["state"] == "xyz"
    assert back["iss"] == BASE
    return back["code"]


async def token(client, **form):
    return await client.post("/oauth/token", data=form)


async def full_flow(client, scope: str | None = None, role: str = "owner") -> tuple[dict, dict]:
    """Sign in, register, approve, exchange. Returns (registered client, token response)."""
    await sign_in(client, role)
    reg = await register(client)
    verifier, challenge = pkce()
    extra = {"scope": scope} if scope else {}
    code = await approve(client, authorize_params(reg["client_id"], challenge, **extra))
    resp = await token(
        client,
        grant_type="authorization_code",
        client_id=reg["client_id"],
        code=code,
        redirect_uri=REDIRECT,
        code_verifier=verifier,
    )
    assert resp.status_code == 200, resp.text
    return reg, resp.json()


# ---------------------------------------------------------------- discovery


async def test_protected_resource_metadata(client):
    for path in (
        "/.well-known/oauth-protected-resource",
        "/.well-known/oauth-protected-resource/mcp",
    ):
        doc = (await client.get(path)).json()
        assert doc["resource"] == f"{BASE}/mcp"
        assert doc["authorization_servers"] == [BASE]
        assert doc["scopes_supported"] == ["oracle:read", "oracle:write"]
        assert doc["bearer_methods_supported"] == ["header"]


async def test_authorization_server_metadata(client):
    doc = (await client.get("/.well-known/oauth-authorization-server")).json()
    assert doc["issuer"] == BASE
    assert doc["authorization_endpoint"] == f"{BASE}/oauth/authorize"
    assert doc["token_endpoint"] == f"{BASE}/oauth/token"
    assert doc["registration_endpoint"] == f"{BASE}/oauth/register"
    assert doc["revocation_endpoint"] == f"{BASE}/oauth/revoke"
    assert doc["code_challenge_methods_supported"] == ["S256"]
    assert doc["grant_types_supported"] == ["authorization_code", "refresh_token"]
    assert doc["response_types_supported"] == ["code"]
    assert doc["token_endpoint_auth_methods_supported"] == ["none"]


async def test_public_url_setting_sets_the_issuer(client, monkeypatch):
    monkeypatch.setenv("ORACLE_PUBLIC_URL", "https://oracle.example.com/")
    service.oauth_settings.cache_clear()
    try:
        doc = (await client.get("/.well-known/oauth-authorization-server")).json()
        prm = (await client.get("/.well-known/oauth-protected-resource")).json()
    finally:
        monkeypatch.delenv("ORACLE_PUBLIC_URL")
        service.oauth_settings.cache_clear()
    assert doc["issuer"] == "https://oracle.example.com"
    assert doc["token_endpoint"] == "https://oracle.example.com/oauth/token"
    assert prm["resource"] == "https://oracle.example.com/mcp"
    scheme, _, params = www_authenticate("http://ignored/").partition(" ")
    assert scheme == "Bearer"
    assert params == 'resource_metadata="http://ignored/.well-known/oauth-protected-resource/mcp"'


# ---------------------------------------------------------------- registration


async def test_register_a_public_client(client):
    await seed()
    reg = await register(
        client,
        redirect_uris=[REDIRECT, "https://agent.example.com/cb", "http://localhost/cb"],
        token_endpoint_auth_method="none",
        logo_uri="https://agent.example.com/logo.png",
    )
    assert reg["client_id"].startswith("pocl_")
    assert reg["client_name"] == "Example Agent"
    assert reg["token_endpoint_auth_method"] == "none"
    assert reg["grant_types"] == ["authorization_code", "refresh_token"]
    assert "client_secret" not in reg
    async with unscoped_session() as s:
        row = await s.scalar(select(OAuthClient))
    assert row.redirect_uris == [REDIRECT, "https://agent.example.com/cb", "http://localhost/cb"]


@pytest.mark.parametrize(
    ("body", "error"),
    [
        ({"redirect_uris": []}, "invalid_redirect_uri"),
        ({"redirect_uris": ["http://agent.example.com/cb"]}, "invalid_redirect_uri"),
        ({"redirect_uris": ["https://agent.example.com/cb#frag"]}, "invalid_redirect_uri"),
        ({"redirect_uris": ["javascript:alert(1)"]}, "invalid_redirect_uri"),
        ({"redirect_uris": ["myapp://callback"]}, "invalid_redirect_uri"),
        ({"redirect_uris": ["https://user:pw@agent.example.com/cb"]}, "invalid_redirect_uri"),
        ({"redirect_uris": ["https:///cb"]}, "invalid_redirect_uri"),
        (
            {"redirect_uris": [f"https://a.example.com/{i}" for i in range(11)]},
            "invalid_redirect_uri",
        ),
        (
            {"redirect_uris": [REDIRECT], "token_endpoint_auth_method": "client_secret_basic"},
            "invalid_client_metadata",
        ),
        ({"redirect_uris": [REDIRECT], "grant_types": ["implicit"]}, "invalid_client_metadata"),
        ({"redirect_uris": [REDIRECT], "response_types": ["token"]}, "invalid_client_metadata"),
        ({"redirect_uris": [REDIRECT], "scope": "admin"}, "invalid_client_metadata"),
    ],
)
async def test_register_rejects_bad_metadata(client, body, error):
    await seed()
    resp = await client.post("/oauth/register", json=body)
    assert resp.status_code == 400
    assert resp.json()["error"] == error
    async with unscoped_session() as s:
        assert await s.scalar(select(func.count()).select_from(OAuthClient)) == 0


async def test_register_lands_in_the_default_tenant(client):
    first = await seed()
    reg = await register(client)
    async with unscoped_session() as s:
        row = await s.scalar(select(OAuthClient).where(OAuthClient.client_id == reg["client_id"]))
    assert row.tenant_id == first.tenant_id


async def test_register_before_setup_is_unavailable(client):
    resp = await client.post("/oauth/register", json={"redirect_uris": [REDIRECT]})
    assert resp.status_code == 503


# ---------------------------------------------------------------- authorize


async def test_anonymous_browser_signs_in_first(client):
    await seed()
    reg = await register(client)
    _, challenge = pkce()
    resp = await client.get(
        "/oauth/authorize", params=authorize_params(reg["client_id"], challenge)
    )
    assert resp.status_code == 302
    location = resp.headers["location"]
    assert location.startswith(f"{BASE}/login?next=")
    nxt = unquote(query(location)["next"])
    assert nxt.startswith("/oauth/consent?request=")
    # The consent screen's call needs a signed-in user.
    handle = query(nxt)["request"]
    resp = await client.get("/oauth/authorize/request", params={"request": handle})
    assert resp.status_code == 401


async def test_authorize_rejects_unknown_client_and_redirect_without_redirecting(client):
    await sign_in(client)
    reg = await register(client)
    _, challenge = pkce()
    resp = await client.get("/oauth/authorize", params=authorize_params("pocl_nope", challenge))
    assert resp.status_code == 400
    params = authorize_params(reg["client_id"], challenge, redirect_uri="https://evil.example/cb")
    resp = await client.get("/oauth/authorize", params=params)
    assert resp.status_code == 400
    assert "redirect_uri" in resp.json()["error_description"]


@pytest.mark.parametrize(
    ("override", "error"),
    [
        ({"response_type": "token"}, "unsupported_response_type"),
        ({"code_challenge_method": "plain"}, "invalid_request"),
        ({"code_challenge_method": None}, "invalid_request"),
        ({"code_challenge": None}, "invalid_request"),
        ({"code_challenge": "short"}, "invalid_request"),
        ({"scope": "oracle:admin"}, "invalid_scope"),
        ({"resource": "https://elsewhere.example/mcp"}, "invalid_target"),
    ],
)
async def test_authorize_errors_go_back_to_the_client(client, override, error):
    await sign_in(client)
    reg = await register(client)
    _, challenge = pkce()
    params = {
        k: v
        for k, v in {**authorize_params(reg["client_id"], challenge), **override}.items()
        if v is not None
    }
    resp = await client.get("/oauth/authorize", params=params)
    assert resp.status_code == 302
    location = resp.headers["location"]
    assert location.startswith(REDIRECT)
    back = query(location)
    assert back["error"] == error
    assert back["state"] == "xyz"


async def test_loopback_redirect_may_use_any_port(client):
    await sign_in(client)
    reg = await register(client)
    _, challenge = pkce()
    other_port = "http://127.0.0.1:51234/callback"
    params = authorize_params(reg["client_id"], challenge, redirect_uri=other_port)
    handle = await consent_handle(client, params)
    detail = (await client.get("/oauth/authorize/request", params={"request": handle})).json()
    assert detail["redirect_uri"] == other_port
    # Path still has to match.
    params["redirect_uri"] = "http://127.0.0.1:51234/other"
    assert (await client.get("/oauth/authorize", params=params)).status_code == 400


async def test_consent_details_and_deny(client):
    await sign_in(client, role="commenter")
    reg = await register(client)
    _, challenge = pkce()
    handle = await consent_handle(client, authorize_params(reg["client_id"], challenge))
    detail = (await client.get("/oauth/authorize/request", params={"request": handle})).json()
    assert detail["client_name"] == "Example Agent"
    assert detail["redirect_host"] == "127.0.0.1:33418"
    assert [s["name"] for s in detail["scopes"]] == ["oracle:read", "oracle:write"]
    assert detail["user_email"] == "admin@example.com"
    assert (detail["user_role"], detail["effective_role"]) == ("commenter", "commenter")

    resp = await client.post(
        "/oauth/authorize/decision", json={"request": handle, "approve": False}
    )
    back = query(resp.json()["redirect_to"])
    assert back["error"] == "access_denied"
    assert back["state"] == "xyz"
    assert "code" not in back
    async with unscoped_session() as s:
        assert await s.scalar(select(func.count()).select_from(OAuthCode)) == 0


async def test_tampered_consent_request_is_rejected(client):
    await sign_in(client)
    reg = await register(client)
    _, challenge = pkce()
    handle = await consent_handle(client, authorize_params(reg["client_id"], challenge))
    resp = await client.post(
        "/oauth/authorize/decision", json={"request": handle[:-2] + "xx", "approve": True}
    )
    assert resp.status_code == 400


async def test_decision_requires_a_signed_in_user(client):
    await sign_in(client)
    reg = await register(client)
    _, challenge = pkce()
    handle = await consent_handle(client, authorize_params(reg["client_id"], challenge))
    client.cookies.clear()
    resp = await client.post("/oauth/authorize/decision", json={"request": handle, "approve": True})
    assert resp.status_code == 401


# ---------------------------------------------------------------- code exchange


async def test_full_flow_issues_working_tokens(client):
    reg, tok = await full_flow(client)
    assert tok["token_type"] == "Bearer"
    assert tok["expires_in"] == 3600
    assert tok["scope"] == "oracle:read oracle:write"
    assert tok["access_token"].startswith("poa_")
    assert tok["refresh_token"].startswith("por_")

    principal = await verify_access_token(tok["access_token"])
    assert principal is not None
    assert (principal.kind, principal.role) == ("user", "owner")
    # Only hashes are stored.
    async with unscoped_session() as s:
        row = await s.scalar(select(OAuthToken))
        code = await s.scalar(select(OAuthCode))
    assert row.access_hash == hashlib.sha256(tok["access_token"].encode()).hexdigest()
    assert tok["access_token"] not in (row.access_hash, row.refresh_hash)
    assert code.used_at is not None
    assert code.expires_at - code.created_at <= timedelta(minutes=10, seconds=5)
    assert row.refresh_expires_at - row.expires_at > timedelta(days=29)


async def test_token_response_is_not_cached(client):
    _, _ = await full_flow(client)
    resp = await token(client, grant_type="password")
    assert resp.status_code == 400
    assert resp.json()["error"] == "unsupported_grant_type"
    assert resp.headers["cache-control"] == "no-store"


async def _code_for(client) -> tuple[dict, str, str]:
    await sign_in(client)
    reg = await register(client)
    verifier, challenge = pkce()
    code = await approve(client, authorize_params(reg["client_id"], challenge))
    return reg, code, verifier


async def test_wrong_verifier_is_rejected(client):
    reg, code, _ = await _code_for(client)
    wrong, _ = pkce()
    resp = await token(
        client,
        grant_type="authorization_code",
        client_id=reg["client_id"],
        code=code,
        redirect_uri=REDIRECT,
        code_verifier=wrong,
    )
    assert resp.status_code == 400
    assert resp.json()["error"] == "invalid_grant"
    resp = await token(
        client,
        grant_type="authorization_code",
        client_id=reg["client_id"],
        code=code,
        redirect_uri=REDIRECT,
    )
    assert resp.json()["error"] == "invalid_request"


async def test_redirect_mismatch_is_rejected(client):
    reg, code, verifier = await _code_for(client)
    resp = await token(
        client,
        grant_type="authorization_code",
        client_id=reg["client_id"],
        code=code,
        redirect_uri="http://127.0.0.1:33418/other",
        code_verifier=verifier,
    )
    assert resp.status_code == 400
    assert resp.json()["error"] == "invalid_grant"


async def test_code_of_another_client_is_rejected(client):
    _, code, verifier = await _code_for(client)
    other = await register(client, client_name="Other")
    resp = await token(
        client,
        grant_type="authorization_code",
        client_id=other["client_id"],
        code=code,
        redirect_uri=REDIRECT,
        code_verifier=verifier,
    )
    assert resp.json()["error"] == "invalid_grant"
    resp = await token(client, grant_type="authorization_code", client_id="pocl_unknown", code=code)
    assert resp.status_code == 401
    assert resp.json()["error"] == "invalid_client"


async def test_code_reuse_is_rejected_and_revokes_its_tokens(client):
    reg, code, verifier = await _code_for(client)
    form = {
        "grant_type": "authorization_code",
        "client_id": reg["client_id"],
        "code": code,
        "redirect_uri": REDIRECT,
        "code_verifier": verifier,
    }
    first = await token(client, **form)
    assert first.status_code == 200
    again = await token(client, **form)
    assert again.status_code == 400
    assert again.json()["error"] == "invalid_grant"
    assert await verify_access_token(first.json()["access_token"]) is None


async def test_expired_code_is_rejected(client):
    reg, code, verifier = await _code_for(client)
    async with unscoped_session() as s:
        await s.execute(
            update(OAuthCode).values(expires_at=datetime.now(UTC) - timedelta(seconds=1))
        )
        await s.commit()
    resp = await token(
        client,
        grant_type="authorization_code",
        client_id=reg["client_id"],
        code=code,
        redirect_uri=REDIRECT,
        code_verifier=verifier,
    )
    assert resp.json() == {
        "error": "invalid_grant",
        "error_description": "Authorization code expired",
    }


# ---------------------------------------------------------------- refresh, revoke, expiry


async def test_refresh_rotates(client):
    reg, tok = await full_flow(client)
    resp = await token(
        client,
        grant_type="refresh_token",
        client_id=reg["client_id"],
        refresh_token=tok["refresh_token"],
    )
    assert resp.status_code == 200
    new = resp.json()
    assert new["refresh_token"] != tok["refresh_token"]
    assert new["access_token"] != tok["access_token"]
    assert await verify_access_token(new["access_token"]) is not None
    # The rotated-out pair stops working.
    assert await verify_access_token(tok["access_token"]) is None
    async with unscoped_session() as s:
        rows = (await s.scalars(select(OAuthToken).order_by(OAuthToken.created_at))).all()
    assert len(rows) == 2
    assert rows[1].rotated_from == rows[0].id
    assert rows[1].family_id == rows[0].family_id


async def test_refresh_reuse_revokes_the_family(client):
    reg, tok = await full_flow(client)
    form = {"grant_type": "refresh_token", "client_id": reg["client_id"]}
    second = (await token(client, **form, refresh_token=tok["refresh_token"])).json()
    third = (await token(client, **form, refresh_token=second["refresh_token"])).json()
    assert await verify_access_token(third["access_token"]) is not None

    # An attacker replays the first refresh token: everything in the family dies.
    replay = await token(client, **form, refresh_token=tok["refresh_token"])
    assert replay.status_code == 400
    assert replay.json()["error"] == "invalid_grant"
    assert await verify_access_token(third["access_token"]) is None
    latest = await token(client, **form, refresh_token=third["refresh_token"])
    assert latest.json()["error"] == "invalid_grant"


async def test_refresh_may_narrow_but_not_widen_scope(client):
    reg, tok = await full_flow(client, scope="oracle:read")
    form = {"grant_type": "refresh_token", "client_id": reg["client_id"]}
    wide = await token(client, **form, refresh_token=tok["refresh_token"], scope="oracle:write")
    assert wide.json()["error"] == "invalid_scope"
    ok = await token(client, **form, refresh_token=tok["refresh_token"], scope="oracle:read")
    assert ok.json()["scope"] == "oracle:read"


async def test_refresh_by_another_client_is_rejected(client):
    _, tok = await full_flow(client)
    other = await register(client, client_name="Other")
    resp = await token(
        client,
        grant_type="refresh_token",
        client_id=other["client_id"],
        refresh_token=tok["refresh_token"],
    )
    assert resp.json()["error"] == "invalid_grant"


async def test_expired_tokens(client):
    reg, tok = await full_flow(client)
    past = datetime.now(UTC) - timedelta(seconds=1)
    async with unscoped_session() as s:
        await s.execute(update(OAuthToken).values(expires_at=past))
        await s.commit()
    assert await verify_access_token(tok["access_token"]) is None
    # An expired access token can still be refreshed while the refresh token lives.
    async with unscoped_session() as s:
        await s.execute(update(OAuthToken).values(refresh_expires_at=past))
        await s.commit()
    resp = await token(
        client,
        grant_type="refresh_token",
        client_id=reg["client_id"],
        refresh_token=tok["refresh_token"],
    )
    assert resp.json()["error"] == "invalid_grant"


@pytest.mark.parametrize("which", ["access_token", "refresh_token"])
async def test_revoke(client, which):
    reg, tok = await full_flow(client)
    other = await register(client, client_name="Other")
    # Another client cannot revoke it (and learns nothing: still 200).
    resp = await client.post(
        "/oauth/revoke", data={"client_id": other["client_id"], "token": tok[which]}
    )
    assert resp.status_code == 200
    assert await verify_access_token(tok["access_token"]) is not None

    resp = await client.post(
        "/oauth/revoke", data={"client_id": reg["client_id"], "token": tok[which]}
    )
    assert resp.status_code == 200
    assert await verify_access_token(tok["access_token"]) is None
    refreshed = await token(
        client,
        grant_type="refresh_token",
        client_id=reg["client_id"],
        refresh_token=tok["refresh_token"],
    )
    assert refreshed.json()["error"] == "invalid_grant"
    # Unknown tokens are fine; unknown clients are not.
    resp = await client.post(
        "/oauth/revoke", data={"client_id": reg["client_id"], "token": "poa_x"}
    )
    assert resp.status_code == 200
    resp = await client.post("/oauth/revoke", data={"client_id": "pocl_x", "token": "poa_x"})
    assert resp.status_code == 401


async def test_verify_rejects_garbage():
    assert await verify_access_token("") is None
    assert await verify_access_token("po_not-an-oauth-token") is None
    assert await verify_access_token("poa_unknown") is None


# ---------------------------------------------------------------- scope x role


@pytest.mark.parametrize("role", ROLES)
@pytest.mark.parametrize("scope", ["oracle:read", "oracle:write", "oracle:read oracle:write"])
async def test_effective_rights_are_role_intersected_with_scope(client, role, scope):
    _, tok = await full_flow(client, scope=scope, role=role)
    principal = await verify_access_token(tok["access_token"])
    expected = role if "oracle:write" in scope else "viewer"
    assert principal.role == expected
    assert has_role(principal.role, "viewer")
    if scope == "oracle:read":
        assert not has_role(principal.role, "commenter")


async def test_role_changes_apply_to_live_tokens(client):
    r = await seed(password=PASSWORD)
    await client.post("/v1/auth/login", json={"email": "admin@example.com", "password": PASSWORD})
    reg = await register(client)
    verifier, challenge = pkce()
    code = await approve(client, authorize_params(reg["client_id"], challenge))
    tok = (
        await token(
            client,
            grant_type="authorization_code",
            client_id=reg["client_id"],
            code=code,
            redirect_uri=REDIRECT,
            code_verifier=verifier,
        )
    ).json()
    async with tenant_session(r.tenant_id) as s:
        await s.execute(update(User).values(role="commenter"))
        await s.commit()
    assert (await verify_access_token(tok["access_token"])).role == "commenter"


async def test_google_signed_in_user_goes_straight_to_consent(client, fetches):  # noqa: F811
    r = await seed()
    await _join_at_once(r.tenant_id)  # A5: an uninvited sign-in joins at once
    reg = await register(client)
    verifier, challenge = pkce()
    headers = {HEADER: assertion("dana@example.com")}
    resp = await client.get(
        "/oauth/authorize", params=authorize_params(reg["client_id"], challenge), headers=headers
    )
    assert resp.status_code == 302
    handle = query(resp.headers["location"])["request"]
    detail = await client.get(
        "/oauth/authorize/request", params={"request": handle}, headers=headers
    )
    assert detail.json()["user_email"] == "dana@example.com"
    resp = await client.post(
        "/oauth/authorize/decision", json={"request": handle, "approve": True}, headers=headers
    )
    code = query(resp.json()["redirect_to"])["code"]
    tok = await token(
        client,
        grant_type="authorization_code",
        client_id=reg["client_id"],
        code=code,
        redirect_uri=REDIRECT,
        code_verifier=verifier,
    )
    principal = await verify_access_token(tok.json()["access_token"])
    async with unscoped_session() as s:
        dana = await s.scalar(select(User).where(User.email == "dana@example.com"))
    assert principal.user_id == dana.id


# ---------------------------------------------------------------- /mcp and REST


@pytest.mark.parametrize(("scope", "can_write"), [("oracle:read", False), (None, True)])
async def test_access_token_works_on_mcp_and_rest(client, scope, can_write):
    """D2's verifier is registered with D1's /mcp registry; REST accepts the same token,
    as the approving user with their role capped by the scope (no scope asked: read and
    write)."""
    from tests.test_mcp import PROPOSED_GOAL, mcp_client, text_of

    _, tok = await full_flow(client, scope=scope)
    access = tok["access_token"]
    me = await client.get("/v1/me", headers={"Authorization": f"Bearer {access}"})
    assert me.status_code == 200
    assert me.json()["kind"] == "user" and me.json()["email"] == "admin@example.com"
    assert me.json()["role"] == ("owner" if can_write else "viewer")

    async with mcp_client(access) as c:
        names = {t.name for t in (await c.list_tools()).tools}
        assert {"search", "get_baseline", "propose_change"} <= names
        base = await c.call_tool("get_baseline", {})
        assert not base.is_error, text_of(base)
        change = {"op": "create", "kind": "entity", "fields": PROPOSED_GOAL}
        proposed = await c.call_tool("propose_change", {"body": change})
    if can_write:
        assert not proposed.is_error, text_of(proposed)
    else:
        assert proposed.is_error and "HTTP 403" in text_of(proposed)
    # An unknown OAuth token is a 401 with the resource metadata, on /mcp and on REST.
    resp = await client.post("/mcp", headers={"Authorization": "Bearer poa_unknown"})
    assert (
        resp.status_code == 401 and "oauth-protected-resource" in resp.headers["www-authenticate"]
    )
    resp = await client.get("/v1/me", headers={"Authorization": "Bearer poa_unknown"})
    assert resp.status_code == 401


@pytest.mark.parametrize("binding", ["bad", "valid"])
async def test_a_run_header_reads_as_not_signed_in(client, binding):
    """A run header that does not verify is a 400 on the API; on the consent pages the
    browser is simply not signed in (sign in, 401), never an error page. A valid one
    is a run, and a run never grants access either."""
    r = await sign_in(client)
    reg = await register(client)
    _, challenge = pkce()
    handle = await consent_handle(client, authorize_params(reg["client_id"], challenge))
    value = "not-a-signed-value"
    if binding == "valid":
        async with tenant_session(r.tenant_id) as s:
            user = await s.scalar(select(User).where(User.email == r.user_email))
            run = Run(flow="baseline_to_prd", status="running", created_by=user.id)
            s.add(run)
            await s.commit()
            value = sign_run_binding(user.id, run.id)
        assert (await client.get("/v1/me", headers={"x-oracle-run-id": value})).status_code == 200
    header = {"x-oracle-run-id": value}
    resp = await client.get(
        "/oauth/authorize", params=authorize_params(reg["client_id"], challenge), headers=header
    )
    assert resp.status_code == 302, resp.text
    assert resp.headers["location"].startswith(f"{BASE}/login?next=")
    resp = await client.get("/oauth/authorize/request", params={"request": handle}, headers=header)
    assert resp.status_code == 401, resp.text
    resp = await client.post(
        "/oauth/authorize/decision", json={"request": handle, "approve": True}, headers=header
    )
    assert resp.status_code == 401, resp.text
    # Without the header the same browser is signed in.
    resp = await client.get("/oauth/authorize/request", params={"request": handle})
    assert resp.status_code == 200, resp.text
