"""The run ticker: Cloud Scheduler's POST /internal/scheduler/tick with a Google ID token.

A locally generated RSA key stands in for Google's; the cert fetch is replaced.
"""

import asyncio
import base64
import json
import time

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from sqlalchemy import text

from oracle.config import get_settings
from oracle.db import get_engine
from oracle.mcp.tools import app_operations
from oracle.runs import service as runs_service
from oracle.swarm import FakeRuntime, set_runtime
from oracle.ticker import idtoken
from oracle.ticker import router as ticker
from tests.conftest import make_tenant
from tests.fixtures import seed_auth
from tests.test_runs import get, started

PATH = "/internal/scheduler/tick"
AUDIENCE = "https://oracle.test/internal/scheduler/tick"
ACCOUNT = "oracle-ticker@example-project.iam.gserviceaccount.com"
KID = "test-rsa"
REFUSED = {"detail": "Not authenticated"}

_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_other_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)


def _certs() -> dict:
    jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(_key.public_key()))
    return {"keys": [{**jwk, "kid": KID, "alg": "RS256", "use": "sig"}]}


def id_token(*, key=_key, kid: str = KID, alg: str = "RS256", **overrides) -> str:
    now = int(time.time())
    claims = {
        "iss": "https://accounts.google.com",
        "aud": AUDIENCE,
        "azp": "112233445566778899",
        "sub": "112233445566778899",
        "email": ACCOUNT,
        "email_verified": True,
        "iat": now - 5,
        "exp": now + 3600,
        **overrides,
    }
    claims = {k: v for k, v in claims.items() if v is not None}
    return jwt.encode(claims, key, algorithm=alg, headers={"kid": kid})


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def ticker_on(monkeypatch) -> list[int]:
    """The ticker configured, Google's cert endpoint replaced; counts fetches."""
    calls: list[int] = []

    async def fake_fetch() -> dict:
        calls.append(1)
        return _certs()

    settings = get_settings()
    monkeypatch.setattr(settings, "ticker_audience", AUDIENCE)
    monkeypatch.setattr(settings, "ticker_service_account", ACCOUNT)
    monkeypatch.setattr(idtoken, "_fetch_certs", fake_fetch)
    idtoken._keys.clear()
    yield calls
    idtoken._keys.clear()


@pytest.fixture
def runtime():
    fake = FakeRuntime()
    set_runtime(fake)
    yield fake
    set_runtime(None)


async def test_a_valid_token_advances_a_waiting_run(client, ticker_on, runtime):
    tenant_id, auth = await seed_auth()
    run = await started(client, auth)
    assert run["segments"][0]["status"] == "running"

    resp = await client.post(PATH, headers=bearer(id_token()))
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["companies"] == {"ticked": 1, "failed": 0, "deferred": 0}
    assert out["runs"] == {
        "checked": 1,
        "segments_finished": 1,
        "advanced": 1,
        "paused": 0,
        "errors": 0,
    }
    assert out["claude_accounts"]["errors"] == 0
    assert out["llm_jobs"] == {"ran": 0, "succeeded": 0, "failed": 0, "retried": 0}
    # Counts only: no ids anywhere.
    assert str(tenant_id) not in resp.text and run["id"] not in resp.text

    run = await get(client, auth, run["id"])
    assert run["status"] == "awaiting_checkpoint"
    assert run["waiting_on"] == "baseline_confirm"
    assert ticker_on == [1]
    # The certs are cached between ticks.
    assert (await client.post(PATH, headers=bearer(id_token()))).status_code == 200
    assert ticker_on == [1]


async def test_the_unprefixed_issuer_is_accepted(client, ticker_on):
    resp = await client.post(PATH, headers=bearer(id_token(iss="accounts.google.com")))
    assert resp.status_code == 200, resp.text


async def test_every_company_ticks_and_one_failure_stops_none(
    client, ticker_on, runtime, monkeypatch
):
    _, auth = await seed_auth()
    run = await started(client, auth)
    broken = await make_tenant("Broken Co")
    real_tick = runs_service.tick

    async def tick(db, principal=None):
        if db.info["tenant_id"] == broken:
            raise RuntimeError("password=hunter2 leaked in an error")
        return await real_tick(db, principal)

    monkeypatch.setattr(runs_service, "tick", tick)
    resp = await client.post(PATH, headers=bearer(id_token()))
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["companies"] == {"ticked": 2, "failed": 1, "deferred": 0}
    assert out["runs"]["segments_finished"] == 1
    assert "hunter2" not in resp.text and str(broken) not in resp.text
    assert (await get(client, auth, run["id"]))["status"] == "awaiting_checkpoint"


async def test_run_errors_are_counted_not_shown(client, ticker_on, runtime, monkeypatch):
    _, auth = await seed_auth()
    await started(client, auth)

    async def tick_run(db, run, stats):
        raise ValueError("secret-token-abc")

    monkeypatch.setattr(runs_service, "_tick_run", tick_run)
    resp = await client.post(PATH, headers=bearer(id_token()))
    assert resp.status_code == 200
    assert resp.json()["runs"]["errors"] == 1
    assert "secret-token-abc" not in resp.text


async def test_companies_past_the_budget_are_deferred(client, ticker_on, monkeypatch):
    await make_tenant("One")
    await make_tenant("Two")
    monkeypatch.setattr(ticker, "BUDGET_SECONDS", 0)
    resp = await client.post(PATH, headers=bearer(id_token()))
    assert resp.status_code == 200
    assert resp.json()["companies"] == {"ticked": 0, "failed": 0, "deferred": 2}


async def test_a_tick_that_overruns_is_cut_off(client, ticker_on, monkeypatch):
    await make_tenant("Slow Co")

    async def slow(tenant_id, out):
        await asyncio.sleep(5)

    monkeypatch.setattr(ticker, "_tick_company", slow)
    monkeypatch.setattr(ticker, "HARD_LIMIT_SECONDS", 0.05)
    resp = await client.post(PATH, headers=bearer(id_token()))
    assert resp.status_code == 200
    assert resp.json()["timed_out"] is True


async def test_an_overlapping_tick_is_skipped(client, ticker_on):
    async with get_engine().connect() as conn:
        held = await conn.scalar(
            text("SELECT pg_try_advisory_lock(:k)"), {"k": ticker.ADVISORY_LOCK_KEY}
        )
        assert held
        try:
            resp = await client.post(PATH, headers=bearer(id_token()))
            assert resp.status_code == 200
            assert resp.json() == {"skipped": "running"}
        finally:
            unlock = text("SELECT pg_advisory_unlock(:k)")
            await conn.execute(unlock, {"k": ticker.ADVISORY_LOCK_KEY})
            await conn.commit()
    # Released: the next tick runs, and releases the lock itself.
    resp = await client.post(PATH, headers=bearer(id_token()))
    assert "skipped" not in resp.json()
    resp = await client.post(PATH, headers=bearer(id_token()))
    assert "skipped" not in resp.json()


def _expired() -> str:
    now = int(time.time())
    return id_token(iat=now - 7200, exp=now - 600)


REFUSALS = {
    "wrong audience": lambda: bearer(id_token(aud="https://elsewhere.test/tick")),
    "no audience": lambda: bearer(id_token(aud=None)),
    "wrong email": lambda: bearer(id_token(email="other@example-project.iam.gserviceaccount.com")),
    "no email": lambda: bearer(id_token(email=None)),
    "unverified email": lambda: bearer(id_token(email_verified=False)),
    "email_verified as a string": lambda: bearer(id_token(email_verified="true")),
    "no email_verified": lambda: bearer(id_token(email_verified=None)),
    "expired": lambda: bearer(_expired()),
    "no expiry": lambda: bearer(id_token(exp=None)),
    "wrong issuer": lambda: bearer(id_token(iss="https://evil.example.com")),
    "IAP issuer": lambda: bearer(id_token(iss="https://cloud.google.com/iap")),
    "another key": lambda: bearer(id_token(key=_other_key)),
    "unknown kid": lambda: bearer(id_token(kid="nope")),
    "alg none": lambda: bearer(id_token(key=None, alg="none")),
    "HS256": lambda: bearer(id_token(key="a-shared-secret-of-enough-length-1234", alg="HS256")),
    "garbage": lambda: bearer("not.a.jwt"),
    "missing header": lambda: {},
    "basic auth": lambda: {"Authorization": " ".join(["Basic", base64.b64encode(b"u:p").decode()])},
    "empty bearer": lambda: {"Authorization": "Bearer "},
}


@pytest.mark.parametrize("case", list(REFUSALS))
async def test_refused(client, ticker_on, case):
    resp = await client.post(PATH, headers=REFUSALS[case]())
    assert resp.status_code == 401, resp.text
    assert resp.json() == REFUSED


async def test_an_api_token_is_refused(client, ticker_on):
    _, auth = await seed_auth()
    resp = await client.post(PATH, headers=auth)
    assert resp.status_code == 401 and resp.json() == REFUSED


async def test_an_oauth_token_and_a_session_are_refused(client, ticker_on):
    from tests.test_oauth import full_flow

    _, tokens = await full_flow(client)  # also leaves a signed-in session cookie
    resp = await client.post(PATH, headers=bearer(tokens["access_token"]))
    assert resp.status_code == 401 and resp.json() == REFUSED
    resp = await client.post(PATH)  # the cookie alone
    assert resp.status_code == 401 and resp.json() == REFUSED


async def test_the_id_token_opens_nothing_else(client, ticker_on):
    await seed_auth()
    headers = bearer(id_token())
    assert (await client.get("/v1/runs", headers=headers)).status_code == 401
    assert (await client.post("/v1/internal/tick", headers=headers)).status_code == 401


async def test_certs_that_cannot_be_fetched_are_503(client, ticker_on, monkeypatch):
    async def down() -> dict:
        raise OSError("connection refused")

    monkeypatch.setattr(idtoken, "_fetch_certs", down)
    idtoken._keys.clear()
    resp = await client.post(PATH, headers=bearer(id_token()))
    assert resp.status_code == 503
    assert "refused" not in resp.text


@pytest.mark.parametrize("unset", ["ticker_audience", "ticker_service_account"])
async def test_disabled_when_unset(client, ticker_on, monkeypatch, unset):
    monkeypatch.setattr(get_settings(), unset, "")
    resp = await client.post(PATH, headers=bearer(id_token()))
    assert resp.status_code == 404
    assert ticker_on == []  # not even a cert fetch


async def test_disabled_by_default(client):
    settings = get_settings()
    assert settings.ticker_audience == "" and settings.ticker_service_account == ""
    assert (await client.post(PATH)).status_code == 404


def test_not_in_openapi_nor_an_mcp_tool():
    from oracle.main import app

    app.openapi_schema = None
    assert not [p for p in app.openapi()["paths"] if "scheduler" in p]
    assert not [op for op in app_operations(app) if "scheduler" in op.path]
