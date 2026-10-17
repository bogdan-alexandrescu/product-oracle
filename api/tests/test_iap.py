"""Google IAP single sign-on: a test EC P-256 key stands in for Google's."""

import json
import time

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from sqlalchemy import func, select

from oracle.auth import iap
from oracle.auth.models import User
from oracle.config import get_settings
from oracle.models import AuditEvent
from oracle.seed import seed
from oracle.tenancy import tenant_session, unscoped_session

AUDIENCE = "/projects/123456789/global/backendServices/987654321"
KID = "test-key"
HEADER = iap.ASSERTION_HEADER

_key = ec.generate_private_key(ec.SECP256R1())
_other_key = ec.generate_private_key(ec.SECP256R1())


def _jwks() -> dict:
    jwk = json.loads(jwt.algorithms.ECAlgorithm.to_jwk(_key.public_key()))
    return {"keys": [{**jwk, "kid": KID, "alg": "ES256", "use": "sig"}]}


def assertion(
    email: str = "dana@example.com",
    *,
    aud: str = AUDIENCE,
    iss: str = iap.ISSUER,
    exp_in: int = 600,
    key=_key,
    kid: str = KID,
) -> str:
    now = int(time.time())
    claims = {
        "iss": iss,
        "aud": aud,
        "sub": "accounts.google.com:1234567890",
        "email": email,
        "iat": now - 5,
        "exp": now + exp_in,
    }
    return jwt.encode(claims, key, algorithm="ES256", headers={"kid": kid})


@pytest.fixture
def fetches(monkeypatch) -> list[int]:
    """IAP SSO on for example.com, Google's key endpoint replaced; counts fetches."""
    calls: list[int] = []

    async def fake_fetch() -> dict:
        calls.append(1)
        return _jwks()

    settings = get_settings()
    monkeypatch.setattr(settings, "iap_audiences", [AUDIENCE])
    monkeypatch.setattr(settings, "iap_allowed_domains", ["example.com"])
    monkeypatch.setattr(settings, "iap_auto_provision", True)
    monkeypatch.setattr(iap, "_fetch_jwks", fake_fetch)
    iap._keys.clear()
    yield calls
    iap._keys.clear()


async def _users() -> list[str]:
    async with unscoped_session() as s:
        return sorted((await s.scalars(select(User.email))).all())


async def test_valid_assertion_provisions_user(client, fetches):
    r = await seed()
    resp = await client.get("/v1/me", headers={HEADER: assertion("Dana@Example.com")})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["kind"] == "user" and body["email"] == "dana@example.com"
    assert body["tenant_id"] == str(r.tenant_id)

    async with tenant_session(r.tenant_id) as s:
        user = await s.scalar(select(User).where(User.email == "dana@example.com"))
        assert user.role == "owner"
        events = (await s.scalars(select(AuditEvent))).all()
        assert [(e.action, e.entity_id, e.data) for e in events] == [
            ("provision", user.id, {"via": "iap"})
        ]

    # Second request: same user, no new row, keys served from the cache.
    again = await client.get("/v1/me", headers={HEADER: assertion("dana@example.com")})
    assert again.json()["user_id"] == body["user_id"]
    assert await _users() == ["admin@example.com", "dana@example.com"]
    assert len(fetches) == 1


async def test_existing_user_matched_case_insensitively(client, fetches, monkeypatch):
    monkeypatch.setattr(get_settings(), "iap_allowed_domains", [])  # no provisioning
    await seed(email="admin@other.test")
    resp = await client.get("/v1/me", headers={HEADER: assertion("ADMIN@Other.Test")})
    assert resp.status_code == 200
    assert resp.json()["email"] == "admin@other.test"
    assert await _users() == ["admin@other.test"]


async def test_iap_user_can_use_the_api(client, fetches):
    await seed()
    resp = await client.get("/v1/documents", headers={HEADER: assertion("admin@example.com")})
    assert resp.status_code == 200


@pytest.mark.parametrize(
    "bad",
    [
        pytest.param(lambda: assertion(aud="/projects/1/global/backendServices/2"), id="audience"),
        pytest.param(lambda: assertion(iss="https://accounts.google.com"), id="issuer"),
        pytest.param(lambda: assertion(exp_in=-120), id="expired"),
        pytest.param(lambda: assertion(key=_other_key), id="signature"),
        pytest.param(lambda: assertion(kid="unknown"), id="unknown-kid"),
        pytest.param(lambda: assertion()[:-4] + "AAAA", id="tampered"),
        pytest.param(lambda: "not-a-jwt", id="garbage"),
        pytest.param(
            lambda: jwt.encode(
                {"iss": iap.ISSUER, "aud": AUDIENCE, "email": "dana@example.com"},
                "a-shared-secret-that-is-32-bytes!",
                algorithm="HS256",
                headers={"kid": KID},
            ),
            id="hs256",
        ),
    ],
)
async def test_invalid_assertion_is_401(client, fetches, bad):
    await seed()
    resp = await client.get("/v1/me", headers={HEADER: bad()})
    assert resp.status_code == 401
    assert await _users() == ["admin@example.com"]


async def test_expiry_within_leeway_is_accepted(client, fetches):
    await seed()
    resp = await client.get("/v1/me", headers={HEADER: assertion("admin@example.com", exp_in=-5)})
    assert resp.status_code == 200


async def test_invalid_assertion_beats_a_valid_cookie(client, fetches):
    await seed(password="correct horse")
    await client.post(
        "/v1/auth/login", json={"email": "admin@example.com", "password": "correct horse"}
    )
    assert (await client.get("/v1/me")).status_code == 200
    resp = await client.get("/v1/me", headers={HEADER: assertion(exp_in=-120)})
    assert resp.status_code == 401


async def test_disallowed_domain_is_401_and_not_created(client, fetches):
    await seed()
    resp = await client.get("/v1/me", headers={HEADER: assertion("eve@elsewhere.test")})
    assert resp.status_code == 401
    assert await _users() == ["admin@example.com"]


async def test_auto_provision_off(client, fetches, monkeypatch):
    monkeypatch.setattr(get_settings(), "iap_auto_provision", False)
    await seed()
    resp = await client.get("/v1/me", headers={HEADER: assertion("dana@example.com")})
    assert resp.status_code == 401
    ok = await client.get("/v1/me", headers={HEADER: assertion("admin@example.com")})
    assert ok.status_code == 200
    assert await _users() == ["admin@example.com"]


async def test_no_tenant_yet_is_401(client, fetches):
    resp = await client.get("/v1/me", headers={HEADER: assertion()})
    assert resp.status_code == 401
    async with unscoped_session() as s:
        assert await s.scalar(select(func.count()).select_from(User)) == 0


async def test_disabled_ignores_header(client, fetches, monkeypatch):
    monkeypatch.setattr(get_settings(), "iap_audiences", [])
    await seed(password="correct horse")
    # Neither a valid nor a garbage assertion does anything; the old flow applies.
    assert (await client.get("/v1/me", headers={HEADER: assertion()})).status_code == 401
    await client.post(
        "/v1/auth/login", json={"email": "admin@example.com", "password": "correct horse"}
    )
    resp = await client.get("/v1/me", headers={HEADER: "garbage"})
    assert resp.status_code == 200 and resp.json()["email"] == "admin@example.com"
    assert fetches == []
    # The unsigned email header is never trusted.
    client.cookies.clear()
    spoof = {"x-goog-authenticated-user-email": "accounts.google.com:admin@example.com"}
    assert (await client.get("/v1/me", headers=spoof)).status_code == 401


async def test_unsigned_email_header_ignored_when_enabled(client, fetches):
    await seed()
    spoof = {"x-goog-authenticated-user-email": "accounts.google.com:admin@example.com"}
    assert (await client.get("/v1/me", headers=spoof)).status_code == 401


async def test_cookie_and_bearer_still_work_when_enabled(client, fetches):
    r = await seed(password="correct horse", token_name="ci")
    bearer = await client.get("/v1/me", headers={"Authorization": f"Bearer {r.token}"})
    assert bearer.status_code == 200 and bearer.json()["kind"] == "token"

    await client.post(
        "/v1/auth/login", json={"email": "admin@example.com", "password": "correct horse"}
    )
    cookie = await client.get("/v1/me")
    assert cookie.status_code == 200 and cookie.json()["email"] == "admin@example.com"
    assert (await client.post("/v1/auth/logout")).status_code == 204
    assert fetches == []


async def test_logout_is_harmless_under_iap(client, fetches):
    await seed()
    headers = {HEADER: assertion("admin@example.com")}
    assert (await client.post("/v1/auth/logout", headers=headers)).status_code == 204
    assert (await client.get("/v1/me", headers=headers)).status_code == 200


async def test_key_endpoint_down_is_503(client, monkeypatch):
    async def down() -> dict:
        raise OSError("unreachable")

    monkeypatch.setattr(get_settings(), "iap_audiences", [AUDIENCE])
    monkeypatch.setattr(iap, "_fetch_jwks", down)
    iap._keys.clear()
    await seed()
    resp = await client.get("/v1/me", headers={HEADER: assertion("admin@example.com")})
    assert resp.status_code == 503
    iap._keys.clear()
