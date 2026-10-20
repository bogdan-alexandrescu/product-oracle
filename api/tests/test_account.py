"""Account management (owner request 2026-10-20): members' sign-in facts and open
tokens, every token of the company by kind, My account (password, personal tokens,
MCP clients, sign out everywhere), the reserved-domain guard, and the MCP tools."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select, update

from oracle.auth.models import ApiToken, User
from oracle.auth.service import (
    PASSWORD_MIN_LENGTH,
    ReservedEmailError,
    create_api_token,
    create_user,
    hash_password,
    reserved_email,
)
from oracle.config import get_settings
from oracle.mcp.oauth.models import OAuthToken
from oracle.models import AuditEvent
from oracle.runs.models import Run
from oracle.runtokens import RunToken, mint_run_token, verify_run_token
from oracle.seed import main as seed_main
from oracle.seed import seed
from oracle.tenancy import tenant_session
from tests.test_mcp import mcp_client, text_of
from tests.test_oauth import PASSWORD, full_flow

ADMIN = "admin@example.com"


def _phrase(word: str) -> str:
    """A test password, built at runtime (never one literal in the source)."""
    return " ".join([word] * 4)


@pytest.fixture
def real_build(monkeypatch):
    """Outside the mock/test build: reserved example domains are refused."""
    monkeypatch.setattr(get_settings(), "allow_reserved_email_domains", False)


async def _owner_token(tenant_id: uuid.UUID) -> dict[str, str]:
    async with tenant_session(tenant_id) as s:
        _, raw = await create_api_token(s, "owner-token")
        await s.commit()
    return {"Authorization": f"Bearer {raw}"}


async def _add_user(tenant_id: uuid.UUID, email: str, role: str, password: str = "x") -> User:
    async with tenant_session(tenant_id) as s:
        user = User(email=email, password_hash=hash_password(password), role=role)
        s.add(user)
        await s.commit()
        return user


async def _login(client, email: str = ADMIN, password: str = PASSWORD) -> None:
    resp = await client.post("/v1/auth/login", json={"email": email, "password": password})
    assert resp.status_code == 200, resp.text


async def _run_token(tenant_id: uuid.UUID, created_by: uuid.UUID, scopes: list[str]) -> str:
    async with tenant_session(tenant_id) as s:
        run = Run(flow="baseline_to_prd", created_by=created_by)
        s.add(run)
        await s.flush()
        raw = await mint_run_token(s, run.id, scopes, ttl_seconds=600)
        await s.commit()
    return raw


async def _admin_id(tenant_id: uuid.UUID) -> uuid.UUID:
    async with tenant_session(tenant_id) as s:
        return await s.scalar(select(User.id).where(User.email == ADMIN))


# --- Reserved example domains (item 4) --------------------------------------------------


@pytest.mark.parametrize(
    ("email", "reserved"),
    [
        ("admin@example.com", True),
        ("a@EXAMPLE.ORG", True),
        ("a@example.net", True),
        ("a@sub.example.com", True),
        ("a@acme.test", True),
        ("a@x.invalid", True),
        ("a@box.localhost", True),
        ("a@localhost", True),
        ("a@example.co", False),
        ("a@notexample.com", False),
        ("a@acme.com", False),
        ("a@testing.io", False),
    ],
)
def test_reserved_email(email, reserved):
    assert reserved_email(email) is reserved


async def test_invite_for_a_reserved_domain_is_refused_outside_tests(client, real_build):
    r = await seed(email="owner@acme.io", password=PASSWORD)
    owner = await _owner_token(r.tenant_id)
    resp = await client.post(
        "/v1/invites", json={"email": "new@example.com", "role": "viewer"}, headers=owner
    )
    assert resp.status_code == 422, resp.text
    assert "example.com" in resp.json()["detail"]
    ok = await client.post(
        "/v1/invites", json={"email": "new@acme.io", "role": "viewer"}, headers=owner
    )
    assert ok.status_code == 201, ok.text


async def test_invite_for_a_reserved_domain_is_allowed_in_the_test_build(client):
    assert get_settings().allow_reserved_email_domains  # conftest sets it
    r = await seed(password=PASSWORD)
    resp = await client.post(
        "/v1/invites",
        json={"email": "new@example.com", "role": "viewer"},
        headers=await _owner_token(r.tenant_id),
    )
    assert resp.status_code == 201, resp.text


async def test_create_user_refuses_reserved_domains_outside_tests(tenant_id, real_build):
    async with tenant_session(tenant_id) as s:
        with pytest.raises(ReservedEmailError):
            await create_user(s, "someone@acme.test", PASSWORD)
        user = await create_user(s, "someone@acme.io", PASSWORD)
        assert user.email == "someone@acme.io"


async def test_existing_reserved_members_are_not_touched(client, real_build, monkeypatch):
    """admin@example.com, seeded before the guard, still signs in and is still listed."""
    monkeypatch.setattr(get_settings(), "allow_reserved_email_domains", True)
    r = await seed(password=PASSWORD)
    monkeypatch.setattr(get_settings(), "allow_reserved_email_domains", False)
    await _login(client)
    members = (await client.get("/v1/members")).json()
    assert [m["email"] for m in members] == [ADMIN]
    # Seeding again for the existing admin mints a token and creates nobody.
    again = await seed(email=ADMIN)
    assert again.tenant_id == r.tenant_id and not again.user_created


async def test_seed_requires_an_email_outside_tests(real_build, monkeypatch, capsys):
    with pytest.raises(ValueError, match="email"):
        await seed()
    monkeypatch.delenv("ORACLE_ADMIN_EMAIL", raising=False)
    monkeypatch.setattr("sys.argv", ["oracle.seed"])
    with pytest.raises(SystemExit) as exit_:
        seed_main()
    assert exit_.value.code == 2
    assert "--email is required" in capsys.readouterr().err


async def test_seed_refuses_a_reserved_email_outside_tests(real_build):
    with pytest.raises(ReservedEmailError):
        await seed(email=ADMIN)


async def test_iap_does_not_provision_reserved_domains_outside_tests(client, monkeypatch):
    from oracle.auth import iap
    from tests import test_iap
    from tests.test_iap import HEADER, assertion

    settings = get_settings()
    monkeypatch.setattr(settings, "allow_reserved_email_domains", True)
    await seed(email="owner@acme.io", password=PASSWORD)
    monkeypatch.setattr(settings, "allow_reserved_email_domains", False)
    monkeypatch.setattr(settings, "iap_audiences", [test_iap.AUDIENCE])
    monkeypatch.setattr(settings, "iap_allowed_domains", ["example.com", "acme.io"])
    monkeypatch.setattr(settings, "iap_auto_provision", True)

    async def fake_fetch() -> dict:
        return test_iap._jwks()

    monkeypatch.setattr(iap, "_fetch_jwks", fake_fetch)
    iap._keys.clear()
    try:
        refused = await client.get("/v1/me", headers={HEADER: assertion("dana@example.com")})
        assert refused.status_code == 401
        ok = await client.get("/v1/me", headers={HEADER: assertion("dana@acme.io")})
        assert ok.status_code == 200, ok.text
    finally:
        iap._keys.clear()


# --- Members: last sign-in, open tokens, not yourself (item 1) ---------------------------


async def test_members_show_last_sign_in_and_open_tokens(client):
    r = await seed(password=PASSWORD)  # the seed's token acts as the admin
    before = datetime.now(UTC)
    await _login(client)
    member = await _add_user(r.tenant_id, "pm@example.com", "approver")
    async with tenant_session(r.tenant_id) as s:
        await create_api_token(s, "pm-bot", user_id=member.id)
        old, _ = await create_api_token(s, "pm-old", user_id=member.id)
        old.revoked_at = datetime.now(UTC)
        await s.commit()
    rows = {m["email"]: m for m in (await client.get("/v1/members")).json()}
    assert datetime.fromisoformat(rows[ADMIN]["last_sign_in_at"]) >= before
    assert rows[ADMIN]["open_tokens"] == 1
    assert rows["pm@example.com"]["last_sign_in_at"] is None
    assert rows["pm@example.com"]["open_tokens"] == 1  # the revoked one does not count


async def test_open_tokens_count_live_mcp_grants(client):
    await full_flow(client)
    rows = (await client.get("/v1/members")).json()
    assert rows[0]["open_tokens"] == 2  # the seed's token and the MCP client's grant


async def test_an_owner_cannot_remove_themselves(client):
    r = await seed(password=PASSWORD)
    await _add_user(r.tenant_id, "other-owner@example.com", "owner")
    await _login(client)
    me = (await client.get("/v1/me")).json()
    resp = await client.post(f"/v1/members/{me['user_id']}/disable")
    assert resp.status_code == 409, resp.text
    assert "yourself" in resp.json()["detail"]
    legacy = await client.delete(f"/v1/members/{me['user_id']}")
    assert legacy.status_code == 409
    # Still an active owner.
    assert (await client.get("/v1/me")).json()["role"] == "owner"


# --- API tokens of the company, every kind (item 2) -------------------------------------


async def test_api_tokens_lists_every_kind(client):
    reg, _ = await full_flow(client)  # signs in as the seeded admin (owner)
    async with tenant_session((await client.get("/v1/me")).json()["tenant_id"]) as s:
        admin = await s.scalar(select(User).where(User.email == ADMIN))
        tenant_id = admin.tenant_id
        _, _ = await create_api_token(s, "ci-service")
        await s.commit()
    await _run_token(tenant_id, admin.id, ["read:documents"])
    rows = (await client.get("/v1/api-tokens")).json()
    kinds = {row["kind"]: row for row in rows}
    assert set(kinds) == {"personal", "service", "run", "mcp_client"}
    personal = kinds["personal"]
    assert personal["name"] == "agent-track" and personal["owner_email"] == ADMIN
    assert personal["scopes"] == ["oracle:read", "oracle:write"]
    assert kinds["service"]["owner_email"] is None and kinds["service"]["role"] == "owner"
    assert kinds["run"]["owner_email"] == ADMIN and kinds["run"]["scopes"] == ["read:documents"]
    assert kinds["run"]["expires_at"] is not None
    client_row = kinds["mcp_client"]
    assert client_row["name"] == reg["client_name"] and client_row["owner_email"] == ADMIN
    assert client_row["scopes"] == ["oracle:read", "oracle:write"]
    for row in rows:
        assert set(row) >= {"id", "created_at", "last_used_at", "revoked_at"}
        assert "token_hash" not in row and "secret" not in row

    only_runs = (await client.get("/v1/api-tokens", params={"kind": "run"})).json()
    assert [x["kind"] for x in only_runs] == ["run"]
    mine = (await client.get("/v1/api-tokens", params={"user_id": str(admin.id)})).json()
    assert {x["kind"] for x in mine} == {"personal", "run", "mcp_client"}
    bad = await client.get("/v1/api-tokens", params={"kind": "nope"})
    assert bad.status_code == 422


async def test_revoke_a_run_token_and_an_mcp_grant(client):
    _, issued = await full_flow(client)
    tenant_id = uuid.UUID((await client.get("/v1/me")).json()["tenant_id"])
    raw_run = await _run_token(tenant_id, await _admin_id(tenant_id), ["read:documents"])
    rows = {r["kind"]: r for r in (await client.get("/v1/api-tokens")).json()}

    assert (await client.delete(f"/v1/api-tokens/{rows['run']['id']}")).status_code == 204
    assert (await client.delete(f"/v1/api-tokens/{rows['mcp_client']['id']}")).status_code == 204
    after = {r["kind"]: r for r in (await client.get("/v1/api-tokens")).json()}
    assert after["run"]["revoked_at"] and after["mcp_client"]["revoked_at"]
    assert after["personal"]["revoked_at"] is None
    assert await verify_run_token(raw_run) is None
    me = await client.get("/v1/me", headers={"Authorization": f"Bearer {issued['access_token']}"})
    assert me.status_code == 401
    async with tenant_session(tenant_id) as s:
        assert (await s.scalar(select(RunToken.revoked_at))) is not None
    actions = await _actions(tenant_id, "run_token.revoke", "mcp_grant.revoke")
    assert actions == ["mcp_grant.revoke", "run_token.revoke"]
    # Twice is a no-op; an unknown id is a 404.
    assert (await client.delete(f"/v1/api-tokens/{rows['run']['id']}")).status_code == 204
    assert (await client.delete(f"/v1/api-tokens/{uuid.uuid4()}")).status_code == 404


async def _actions(tenant_id: uuid.UUID, *names: str) -> list[str]:
    async with tenant_session(tenant_id) as s:
        return sorted(
            (await s.scalars(select(AuditEvent.action).where(AuditEvent.action.in_(names)))).all()
        )


async def test_remove_revokes_every_token_of_the_member(client):
    """Item 2: removing a member revokes their personal tokens, MCP grants and run tokens."""
    _, issued = await full_flow(client)  # the admin's MCP grant
    tenant_id = uuid.UUID((await client.get("/v1/me")).json()["tenant_id"])
    admin_id = await _admin_id(tenant_id)
    await _run_token(tenant_id, admin_id, ["read:documents"])
    # Another owner removes the admin.
    other = await _add_user(tenant_id, "boss@acme.io", "owner", password=PASSWORD)
    await _login(client, "boss@acme.io")
    resp = await client.post(f"/v1/members/{admin_id}/disable")
    assert resp.status_code == 200, resp.text
    assert resp.json()["open_tokens"] == 0
    rows = (await client.get("/v1/api-tokens", params={"user_id": str(admin_id)})).json()
    assert {r["kind"] for r in rows} == {"personal", "run", "mcp_client"}
    assert all(r["revoked_at"] for r in rows), rows
    assert other.id != admin_id


# --- My account (item 3) ----------------------------------------------------------------


async def test_my_account(client):
    await seed(password=PASSWORD)
    await _login(client)
    body = (await client.get("/v1/me/account")).json()
    assert body["email"] == ADMIN and body["role"] == "owner"
    assert body["sign_in_methods"] == ["password"]
    assert body["password_min_length"] == PASSWORD_MIN_LENGTH
    assert body["last_sign_in_at"] is not None


async def test_iap_provisioned_users_have_no_password(client, monkeypatch):
    from oracle.auth import iap
    from tests import test_iap

    settings = get_settings()
    await seed(password=PASSWORD)
    monkeypatch.setattr(settings, "iap_audiences", [test_iap.AUDIENCE])
    monkeypatch.setattr(settings, "iap_allowed_domains", ["example.com"])
    monkeypatch.setattr(settings, "iap_auto_provision", True)

    async def fake_fetch() -> dict:
        return test_iap._jwks()

    monkeypatch.setattr(iap, "_fetch_jwks", fake_fetch)
    iap._keys.clear()
    try:
        headers = {test_iap.HEADER: test_iap.assertion("dana@example.com")}
        body = (await client.get("/v1/me/account", headers=headers)).json()
        assert body["sign_in_methods"] == ["google"]
        assert body["last_sign_in_at"] is not None
        resp = await client.post(
            "/v1/me/password",
            json={"current_password": _phrase("any"), "new_password": _phrase("fresh")},
            headers=headers,
        )
        assert resp.status_code == 409
        # The admin signs in both ways while IAP is on.
        admin = {test_iap.HEADER: test_iap.assertion(ADMIN)}
        methods = (await client.get("/v1/me/account", headers=admin)).json()["sign_in_methods"]
        assert methods == ["password", "google"]
    finally:
        iap._keys.clear()


async def test_change_password(client):
    await seed(password=PASSWORD)
    await _login(client)
    old_cookie = client.cookies.get(get_settings().session_cookie_name)
    new = _phrase("longer")
    short = await client.post(
        "/v1/me/password", json={"current_password": PASSWORD, "new_password": "x" * 5}
    )
    assert short.status_code == 422
    wrong = await client.post(
        "/v1/me/password", json={"current_password": _phrase("wrong"), "new_password": new}
    )
    assert wrong.status_code == 400
    ok = await client.post(
        "/v1/me/password", json={"current_password": PASSWORD, "new_password": new}
    )
    assert ok.status_code == 204, ok.text
    # This browser stays signed in with a fresh cookie; every other session ends.
    assert (await client.get("/v1/me")).status_code == 200
    stale = await client.get("/v1/me", cookies={get_settings().session_cookie_name: old_cookie})
    assert stale.status_code == 401
    bad = await client.post("/v1/auth/login", json={"email": ADMIN, "password": PASSWORD})
    assert bad.status_code == 401
    await _login(client, password=new)
    tenant_id = uuid.UUID((await client.get("/v1/me")).json()["tenant_id"])
    assert await _actions(tenant_id, "password.change", "password.change_failed") == [
        "password.change",
        "password.change_failed",
    ]


async def test_change_password_is_rate_limited(client):
    await seed(password=PASSWORD)
    await _login(client)
    body = {"current_password": _phrase("guess"), "new_password": _phrase("longer")}
    for _ in range(5):
        assert (await client.post("/v1/me/password", json=body)).status_code == 400
    limited = await client.post("/v1/me/password", json=body)
    assert limited.status_code == 429
    assert int(limited.headers["retry-after"]) > 0
    # Even the right password waits out the window.
    right = {**body, "current_password": PASSWORD}
    assert (await client.post("/v1/me/password", json=right)).status_code == 429


async def test_personal_tokens(client):
    r = await seed(password=PASSWORD)
    await _login(client)
    created = await client.post(
        "/v1/me/tokens", json={"name": "laptop cli", "scopes": ["oracle:read"]}
    )
    assert created.status_code == 201, created.text
    body = created.json()
    secret = body["secret"]
    assert secret.startswith("po_")
    assert body["token"]["kind"] == "personal" and body["token"]["scopes"] == ["oracle:read"]
    # Shown once: never listed again.
    listed = (await client.get("/v1/me/tokens")).json()
    assert {t["name"] for t in listed} == {"agent-track", "laptop cli"}
    assert all("secret" not in t for t in listed)
    # A read-only token acts as a viewer, whatever the owner's role.
    me = await client.get("/v1/me", headers={"Authorization": f"Bearer {secret}"})
    assert me.json()["role"] == "viewer"
    denied = await client.post(
        "/v1/invites",
        json={"email": "x@example.com", "role": "viewer"},
        headers={"Authorization": f"Bearer {secret}"},
    )
    assert denied.status_code == 403
    # Revoke it.
    tid = body["token"]["id"]
    assert (await client.delete(f"/v1/me/tokens/{tid}")).status_code == 204
    gone = await client.get("/v1/me", headers={"Authorization": f"Bearer {secret}"})
    assert gone.status_code == 401
    # Another member's token is not mine to revoke.
    other = await _add_user(r.tenant_id, "pm@example.com", "approver")
    async with tenant_session(r.tenant_id) as s:
        theirs, _ = await create_api_token(s, "pm-bot", user_id=other.id)
        await s.commit()
    assert (await client.delete(f"/v1/me/tokens/{theirs.id}")).status_code == 404


async def test_personal_token_validation_and_scope_cap(client):
    await seed(password=PASSWORD)
    await _login(client)
    for bad in ({"name": "", "scopes": ["oracle:read"]}, {"name": "x", "scopes": []}):
        assert (await client.post("/v1/me/tokens", json=bad)).status_code == 422
    weird = await client.post("/v1/me/tokens", json={"name": "x", "scopes": ["admin"]})
    assert weird.status_code == 422
    # A read-only token cannot mint a token with more than it has.
    ro = (
        await client.post("/v1/me/tokens", json={"name": "ro", "scopes": ["oracle:read"]})
    ).json()["secret"]
    headers = {"Authorization": f"Bearer {ro}"}
    wider = await client.post(
        "/v1/me/tokens",
        json={"name": "w", "scopes": ["oracle:read", "oracle:write"]},
        headers=headers,
    )
    assert wider.status_code == 403
    same = await client.post(
        "/v1/me/tokens", json={"name": "r2", "scopes": ["oracle:read"]}, headers=headers
    )
    assert same.status_code == 201


async def test_my_mcp_clients(client):
    reg, issued = await full_flow(client)
    rows = (await client.get("/v1/me/oauth-clients")).json()
    assert len(rows) == 1
    grant = rows[0]
    assert grant["client_name"] == reg["client_name"] and grant["client_id"] == reg["client_id"]
    assert grant["scopes"] == ["oracle:read", "oracle:write"] and grant["revoked_at"] is None
    assert (await client.delete(f"/v1/me/oauth-clients/{grant['id']}")).status_code == 204
    rows = (await client.get("/v1/me/oauth-clients")).json()
    assert rows[0]["revoked_at"] is not None
    me = await client.get("/v1/me", headers={"Authorization": f"Bearer {issued['access_token']}"})
    assert me.status_code == 401
    refreshed = await client.post(
        "/oauth/token",
        data={
            "grant_type": "refresh_token",
            "client_id": reg["client_id"],
            "refresh_token": issued["refresh_token"],
        },
    )
    assert refreshed.status_code == 400
    assert (await client.delete(f"/v1/me/oauth-clients/{uuid.uuid4()}")).status_code == 404


async def test_another_members_grant_is_not_mine(client):
    _, _ = await full_flow(client)
    grant_id = (await client.get("/v1/me/oauth-clients")).json()[0]["id"]
    tenant_id = uuid.UUID((await client.get("/v1/me")).json()["tenant_id"])
    await _add_user(tenant_id, "pm@acme.io", "approver", password=PASSWORD)
    await _login(client, "pm@acme.io")
    assert (await client.get("/v1/me/oauth-clients")).json() == []
    assert (await client.delete(f"/v1/me/oauth-clients/{grant_id}")).status_code == 404


async def test_sign_out_everywhere(client):
    reg, issued = await full_flow(client)
    name = get_settings().session_cookie_name
    first = client.cookies.get(name)
    await _login(client)  # a second device
    second = client.cookies.get(name)
    resp = await client.post("/v1/me/sign-out-everywhere")
    assert resp.status_code == 200, resp.text
    assert resp.json()["mcp_clients_revoked"] == 1
    for cookie in (first, second):
        assert (await client.get("/v1/me", cookies={name: cookie})).status_code == 401
    # The MCP client's tokens, refresh included, are dead.
    me = await client.get("/v1/me", headers={"Authorization": f"Bearer {issued['access_token']}"})
    assert me.status_code == 401
    refreshed = await client.post(
        "/oauth/token",
        data={
            "grant_type": "refresh_token",
            "client_id": reg["client_id"],
            "refresh_token": issued["refresh_token"],
        },
    )
    assert refreshed.status_code == 400
    # Personal API tokens are not sessions: they keep working until revoked.
    tenant_id = uuid.UUID(await _tenant_of_admin())
    async with tenant_session(tenant_id) as s:
        token = await s.scalar(select(ApiToken).where(ApiToken.name == "agent-track"))
        assert token.revoked_at is None
    # Signing in again works.
    await _login(client)
    assert (await client.get("/v1/me")).status_code == 200


async def _tenant_of_admin() -> str:
    from oracle.tenancy import unscoped_session

    async with unscoped_session() as s:
        return str(await s.scalar(select(User.tenant_id).where(User.email == ADMIN)))


async def test_account_endpoints_need_a_person(client):
    """A user-less (service) token has no account; a run's call never manages one."""
    r = await seed(password=PASSWORD)
    service = await _owner_token(r.tenant_id)
    for method, path in [
        ("GET", "/v1/me/account"),
        ("GET", "/v1/me/tokens"),
        ("POST", "/v1/me/sign-out-everywhere"),
    ]:
        resp = await client.request(method, path, headers=service)
        assert resp.status_code == 403, (path, resp.text)
    assert (await client.get("/v1/me/account")).status_code == 401


async def test_sessions_signed_before_a_password_change_by_another_device_end(client):
    """The per-user session epoch is checked on every request."""
    await seed(password=PASSWORD)
    await _login(client)
    name = get_settings().session_cookie_name
    cookie = client.cookies.get(name)
    async with tenant_session(uuid.UUID(await _tenant_of_admin())) as s:
        await s.execute(
            update(User).values(sessions_valid_after=datetime.now(UTC) + timedelta(seconds=1))
        )
        await s.commit()
    assert (await client.get("/v1/me", cookies={name: cookie})).status_code == 401


# --- MCP tools (item 5) -----------------------------------------------------------------

ACCOUNT_TOOLS = {
    "list_api_tokens",
    "revoke_api_token",
    "create_personal_token",
    "list_my_tokens",
    "revoke_my_token",
    "list_my_oauth_clients",
    "revoke_my_oauth_client",
    "change_password",
    "sign_out_everywhere",
    "get_my_account",
}


async def test_account_tools_exist_for_people(client):
    r = await seed(password=PASSWORD)
    async with tenant_session(r.tenant_id) as s:
        token = await s.scalar(select(ApiToken))
    # The seed's token acts as the admin: a person.
    async with mcp_client(r.token) as c:
        names = {t.name for t in (await c.list_tools()).tools}
        assert ACCOUNT_TOOLS <= names
        result = await c.call_tool("list_my_tokens", {})
        assert not result.is_error and "agent-track" in text_of(result)
        result = await c.call_tool(
            "create_personal_token", {"body": {"name": "from mcp", "scopes": ["oracle:read"]}}
        )
        assert not result.is_error and "po_" in text_of(result)
    assert token.name == "agent-track"


async def test_run_tokens_never_reach_account_tools(client):
    r = await seed(password=PASSWORD)
    admin_id = await _admin_id(r.tenant_id)
    every_scope = [
        "read:sources",
        "read:baseline",
        "read:documents",
        "write:proposals",
        "write:drafts",
    ]
    raw = await _run_token(r.tenant_id, admin_id, every_scope)
    async with mcp_client(raw) as c:
        names = {t.name for t in (await c.list_tools()).tools}
        assert names.isdisjoint(ACCOUNT_TOOLS)
        for tool, args in [
            ("list_api_tokens", {}),
            ("revoke_api_token", {"token_id": str(uuid.uuid4())}),
            ("create_personal_token", {"body": {"name": "x", "scopes": ["oracle:read"]}}),
            ("list_my_tokens", {}),
            ("revoke_my_token", {"token_id": str(uuid.uuid4())}),
            ("list_my_oauth_clients", {}),
            ("revoke_my_oauth_client", {"grant_id": str(uuid.uuid4())}),
            ("change_password", {"body": {"current_password": PASSWORD, "new_password": "x" * 20}}),
            ("sign_out_everywhere", {}),
            ("get_my_account", {}),
        ]:
            result = await c.call_tool(tool, args)
            assert result.is_error, tool
    async with tenant_session(r.tenant_id) as s:
        assert (await s.scalar(select(User.sessions_valid_after))) is None
        assert len((await s.scalars(select(ApiToken))).all()) == 1


async def test_rest_refuses_a_call_made_for_a_run(client):
    """The REST layer refuses account calls carrying a run's token too (defence in depth)."""
    from oracle.auth.deps import RUN_TOKEN_HEADER

    r = await seed(password=PASSWORD)
    raw = await _run_token(r.tenant_id, await _admin_id(r.tenant_id), ["read:documents"])
    await _login(client)
    for method, path in [
        ("GET", "/v1/me/account"),
        ("GET", "/v1/me/tokens"),
        ("POST", "/v1/me/sign-out-everywhere"),
        ("GET", "/v1/api-tokens"),
    ]:
        resp = await client.request(method, path, headers={RUN_TOKEN_HEADER: raw})
        assert resp.status_code == 403, (path, resp.text)


async def test_grant_ids_are_family_ids(client):
    await full_flow(client)
    tenant_id = uuid.UUID(await _tenant_of_admin())
    async with tenant_session(tenant_id) as s:
        family = await s.scalar(select(OAuthToken.family_id))
    rows = (await client.get("/v1/me/oauth-clients")).json()
    assert rows[0]["id"] == str(family)
