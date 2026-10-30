from datetime import UTC, datetime

from sqlalchemy import select

from oracle.auth.models import ApiToken, User
from oracle.models import AuditEvent
from oracle.seed import format_result, seed
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


async def test_seed_output_shows_secrets_only_when_new():
    first = format_result(await seed())
    assert "password   " in first and "<- generated, shown once" in first
    assert "export ORACLE_API_TOKEN=" in first

    again = format_result(await seed())
    assert "generated" not in again and "(unchanged" in again
    assert "export ORACLE_API_TOKEN=" in again  # every run mints a new token


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


async def test_a_removed_member_hears_why_only_with_the_right_password(client):
    # qa-settings-42: removed (disabled) who gives the right password is refused in words, naming
    # the owner who removed them; a wrong password says no more than for anyone else.
    from oracle.auth.service import create_user

    r = await seed(password="pw")
    async with tenant_session(r.tenant_id) as s:
        admin = await s.scalar(select(User).where(User.email == "admin@example.com"))
        pm = await create_user(s, "former.pm@example.com", "pm-pass")
        pm.role, pm.disabled_at, pm.disabled_by = "approver", datetime.now(UTC), admin.id
        pm_id = pm.id
        await s.commit()
    login = {"email": "former.pm@example.com", "password": "pm-pass"}

    wrong = await client.post("/v1/auth/login", json={**login, "password": "nope"})
    assert (wrong.status_code, wrong.json()["detail"]) == (401, "Invalid email or password")
    resp = await client.post("/v1/auth/login", json=login)
    assert resp.status_code == 403
    assert resp.json()["detail"] == (
        "An owner removed you from this Oracle. Ask Admin to restore you."
    )
    assert "set-cookie" not in resp.headers
    assert (await client.get("/v1/me")).status_code == 401

    # Removed by a token, or by someone since removed too: any owner.
    async with tenant_session(r.tenant_id) as s:
        (await s.get(User, pm_id)).disabled_by = None
        await s.commit()
    resp = await client.post("/v1/auth/login", json=login)
    assert resp.json()["detail"] == (
        "An owner removed you from this Oracle. Ask an owner to restore you."
    )


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
    # The seeded token acts as the admin (tokens without a user report kind "token").
    assert body["kind"] == "user" and body["token_name"] == "ci"
    assert body["email"] == "admin@example.com"
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
