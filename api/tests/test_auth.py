from datetime import UTC, datetime

from sqlalchemy import select

from oracle.auth.models import ApiToken, User
from oracle.models import AuditEvent
from oracle.seed import seed
from oracle.tenancy import tenant_session


async def test_seed_creates_tenant_admin_and_token():
    first = await seed(email="Admin@Example.com", password="s3cret-pass")
    assert first.tenant_created and first.user_created
    assert first.password is None  # supplied, so not echoed back
    assert first.token.startswith("po_")

    async with tenant_session(first.tenant_id) as s:
        user = await s.scalar(select(User))
        assert user.email == "admin@example.com"
        assert user.password_hash.startswith("$argon2id$")
        token = await s.scalar(select(ApiToken))
        assert token.token_hash != first.token and first.token not in token.token_hash

    second = await seed(email="admin@example.com")
    assert second.tenant_id == first.tenant_id
    assert not second.tenant_created and not second.user_created
    assert second.token != first.token


async def test_seed_generates_password_when_missing(client):
    r = await seed()
    assert r.password
    resp = await client.post(
        "/v1/auth/login", json={"email": "admin@example.com", "password": r.password}
    )
    assert resp.status_code == 200


async def test_login_cookie_me_and_logout(client):
    r = await seed(password="correct horse")
    bad = await client.post(
        "/v1/auth/login", json={"email": "admin@example.com", "password": "wrong"}
    )
    assert bad.status_code == 401
    assert (await client.get("/v1/me")).status_code == 401

    ok = await client.post(
        "/v1/auth/login", json={"email": "admin@example.com", "password": "correct horse"}
    )
    assert ok.status_code == 200
    assert "httponly" in ok.headers["set-cookie"].lower()
    me = await client.get("/v1/me")
    assert me.status_code == 200
    assert me.json()["kind"] == "user"
    assert me.json()["email"] == "admin@example.com"
    assert me.json()["tenant_id"] == str(r.tenant_id)

    async with tenant_session(r.tenant_id) as s:
        assert (await s.scalars(select(AuditEvent.action))).all() == ["login"]

    assert (await client.post("/v1/auth/logout")).status_code == 204
    assert (await client.get("/v1/me")).status_code == 401


async def test_tampered_cookie_is_rejected(client):
    await seed(password="pw")
    await client.post("/v1/auth/login", json={"email": "admin@example.com", "password": "pw"})
    value = client.cookies.get("oracle_session")
    client.cookies.set("oracle_session", value[:-2] + "xx")
    assert (await client.get("/v1/me")).status_code == 401


async def test_bearer_token_auth(client):
    r = await seed(token_name="ci")
    resp = await client.get("/v1/me", headers={"Authorization": f"Bearer {r.token}"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["kind"] == "token" and body["token_name"] == "ci"
    assert body["tenant_id"] == str(r.tenant_id)

    async with tenant_session(r.tenant_id) as s:
        token = await s.scalar(select(ApiToken))
        assert token.last_used_at is not None
        token.revoked_at = datetime.now(UTC)
        await s.commit()

    resp = await client.get("/v1/me", headers={"Authorization": f"Bearer {r.token}"})
    assert resp.status_code == 401
    resp = await client.get("/v1/me", headers={"Authorization": "Bearer po_nope"})
    assert resp.status_code == 401
