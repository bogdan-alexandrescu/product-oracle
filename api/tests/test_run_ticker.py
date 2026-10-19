"""The run ticker: Cloud Scheduler's POST /internal/scheduler/tick with a Google ID token.

A locally generated RSA key stands in for Google's; the cert fetch is replaced.
"""

import asyncio
import base64
import json
import logging
import time
import uuid
from datetime import UTC, datetime, timedelta

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncConnection, create_async_engine
from sqlalchemy.pool import NullPool

from oracle.auth import jwks
from oracle.claude_accounts import sweep as claude_sweep
from oracle.claude_accounts import usage
from oracle.claude_accounts.models import ClaudeSweepLease
from oracle.config import get_settings
from oracle.db import get_engine
from oracle.jobs import kinds
from oracle.jobs import worker as llm_jobs
from oracle.jobs.models import LlmJob
from oracle.llm import gateway
from oracle.llm.transports import LlmRateLimited, get_llm_settings
from oracle.mcp.tools import app_operations
from oracle.runs import service as runs_service
from oracle.swarm import FakeRuntime, set_runtime
from oracle.tenancy import tenant_session
from oracle.ticker import idtoken
from oracle.ticker import router as ticker
from tests.claude_account_helpers import FakeEndpoint, add_account, window
from tests.conftest import TEST_DATABASE_URL, make_tenant
from tests.fixtures import seed_auth
from tests.test_llm_jobs import DRAFT_V1, SLUG, FakeClaude
from tests.test_members import token_with_role
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

    async def slow(*args):
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
    "audience list with extras": lambda: bearer(id_token(aud=[AUDIENCE, "https://other.test/"])),
    "audience list": lambda: bearer(id_token(aud=[AUDIENCE])),
    "wrong email": lambda: bearer(id_token(email="other@example-project.iam.gserviceaccount.com")),
    # U+212A KELVIN SIGN lower-cases to "k": an exact comparison only.
    "unicode look-alike email": lambda: bearer(id_token(email=ACCOUNT.replace("k", "\u212a"))),
    "upper-case email": lambda: bearer(id_token(email=ACCOUNT.upper())),
    "no email": lambda: bearer(id_token(email=None)),
    "unverified email": lambda: bearer(id_token(email_verified=False)),
    "email_verified as a string": lambda: bearer(id_token(email_verified="true")),
    "no email_verified": lambda: bearer(id_token(email_verified=None)),
    "expired": lambda: bearer(_expired()),
    "no expiry": lambda: bearer(id_token(exp=None)),
    "no iat": lambda: bearer(id_token(iat=None)),
    "lives longer than an hour": lambda: bearer(id_token(exp=int(time.time()) + 3600 + 60)),
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


async def test_refusals_log_at_debug_only(client, ticker_on, caplog, monkeypatch):
    # alembic's logging config (run by the test harness) disables existing loggers.
    monkeypatch.setattr(ticker.log, "disabled", False)
    caplog.set_level(logging.DEBUG, logger=ticker.__name__)
    resp = await client.post(PATH, headers=bearer(id_token(aud="https://elsewhere.test/")))
    assert resp.status_code == 401
    records = [r for r in caplog.records if r.name == ticker.__name__]
    assert records and all(r.levelno == logging.DEBUG for r in records)


async def test_unreachable_certs_are_fetched_once_then_backed_off(client, ticker_on, monkeypatch):
    fetched: list[int] = []

    async def down() -> dict:
        fetched.append(1)
        await asyncio.sleep(0.05)
        raise OSError("connection refused")

    monkeypatch.setattr(idtoken, "_fetch_certs", down)
    idtoken._keys.clear()
    resps = await asyncio.gather(
        *[client.post(PATH, headers=bearer(id_token())) for _ in range(20)]
    )
    assert [r.status_code for r in resps] == [503] * 20
    assert fetched == [1]
    # Within the back-off a request fetches nothing.
    assert (await client.post(PATH, headers=bearer(id_token()))).status_code == 503
    assert fetched == [1]
    # After it, the next request tries again.
    monkeypatch.setattr(idtoken._keys, "backoff_seconds", 0)

    async def up() -> dict:
        fetched.append(1)
        return _certs()

    monkeypatch.setattr(idtoken, "_fetch_certs", up)
    assert (await client.post(PATH, headers=bearer(id_token()))).status_code == 200
    assert fetched == [1, 1]


@pytest.mark.parametrize("answer", [{"keys": []}, {"keys": [{"kid": "x", "alg": "ES256"}]}])
async def test_certs_without_a_usable_key_back_off_too(client, ticker_on, monkeypatch, answer):
    fetched: list[int] = []

    async def empty() -> dict:
        fetched.append(1)
        return answer

    monkeypatch.setattr(idtoken, "_fetch_certs", empty)
    idtoken._keys.clear()
    for _ in range(3):
        assert (await client.post(PATH, headers=bearer(id_token()))).status_code == 503
    assert fetched == [1]
    # The ticker keeps the 30 s back-off (IAP's is shorter: sign-in waits on it).
    assert idtoken._keys.backoff_seconds == jwks.DEFAULT_BACKOFF_SECONDS == 30


async def test_a_failure_after_taking_the_lock_releases_it(client, ticker_on, monkeypatch):
    real_commit = AsyncConnection.commit
    commits: list[int] = []

    async def commit(self):
        commits.append(1)
        if len(commits) == 1:
            raise RuntimeError("the commit after the lock failed")
        return await real_commit(self)

    monkeypatch.setattr(AsyncConnection, "commit", commit)
    try:
        resp = await client.post(PATH, headers=bearer(id_token()))
        assert resp.status_code == 500
    except RuntimeError:
        pass
    monkeypatch.setattr(AsyncConnection, "commit", real_commit)
    # From another database session: advisory locks are re-entrant within one.
    other = create_async_engine(TEST_DATABASE_URL, poolclass=NullPool)
    try:
        async with other.connect() as conn:
            lock = text("SELECT pg_try_advisory_lock(:k)")
            assert await conn.scalar(lock, {"k": ticker.ADVISORY_LOCK_KEY})
            unlock = text("SELECT pg_advisory_unlock(:k)")
            await conn.execute(unlock, {"k": ticker.ADVISORY_LOCK_KEY})
            await conn.commit()
    finally:
        await other.dispose()


# --- the Claude account sweep: once per sweep interval, and a 429 backs it off ----------


@pytest.fixture
def usage_polls(monkeypatch):
    """The usage endpoint replaced (answers in order, then a reading); the 5-minute interval."""
    polls: list[str] = []
    answers: list = []

    async def fetch(token: str):
        polls.append(token)
        answer = answers.pop(0) if answers else None
        if isinstance(answer, Exception):
            raise answer
        return {"five_hour": window(0.1)}

    previous_fetch = claude_sweep.set_usage_fetch(fetch)
    previous_endpoint = claude_sweep.set_token_endpoint(FakeEndpoint())
    monkeypatch.setattr(claude_sweep.get_pool_settings(), "sweep_seconds", 300)
    yield polls, answers
    claude_sweep.set_usage_fetch(previous_fetch)
    claude_sweep.set_token_endpoint(previous_endpoint)


async def _age_sweep(tenant_id: uuid.UUID, seconds: float) -> None:
    """As if the company's last sweep completed ``seconds`` earlier than it did."""
    async with tenant_session(tenant_id) as s:
        await s.execute(
            update(ClaudeSweepLease).values(
                last_completed_at=ClaudeSweepLease.last_completed_at - timedelta(seconds=seconds)
            )
        )
        await s.commit()


async def test_the_account_sweep_runs_once_per_interval(client, ticker_on, usage_polls):
    polls, _ = usage_polls
    tenant_id, _ = await seed_auth()
    await add_account(tenant_id, "one")
    await add_account(tenant_id, "two")

    first = (await client.post(PATH, headers=bearer(id_token()))).json()["claude_accounts"]
    assert (first["polled"], first["not_due"]) == (2, 0)
    # A minute later: not due, so no account is polled again.
    await _age_sweep(tenant_id, 60)
    second = (await client.post(PATH, headers=bearer(id_token()))).json()["claude_accounts"]
    assert (second["polled"], second["examined"], second["not_due"]) == (0, 0, 1)
    assert sorted(polls) == ["acc-one", "acc-two"]
    # Past the interval: due again.
    await _age_sweep(tenant_id, 300)
    third = (await client.post(PATH, headers=bearer(id_token()))).json()["claude_accounts"]
    assert (third["polled"], third["not_due"]) == (2, 0)


@pytest.mark.parametrize("interval", [0, 60, -1])
async def test_the_ticker_sweeps_at_most_every_five_minutes_whatever_the_setting(
    client, ticker_on, usage_polls, monkeypatch, interval
):
    # 0 turns the in-process sweep off; it must not make the ticker sweep every minute.
    monkeypatch.setattr(claude_sweep.get_pool_settings(), "sweep_seconds", interval)
    polls, _ = usage_polls
    tenant_id, _ = await seed_auth()
    await add_account(tenant_id, "one")

    first = (await client.post(PATH, headers=bearer(id_token()))).json()["claude_accounts"]
    assert (first["polled"], first["not_due"]) == (1, 0)
    for _ in range(4):
        await _age_sweep(tenant_id, 60)
        out = (await client.post(PATH, headers=bearer(id_token()))).json()["claude_accounts"]
        assert (out["polled"], out["not_due"]) == (0, 1)
    assert polls == ["acc-one"]
    await _age_sweep(tenant_id, 60)
    out = (await client.post(PATH, headers=bearer(id_token()))).json()["claude_accounts"]
    assert (out["polled"], out["not_due"]) == (1, 0)


async def test_a_longer_interval_is_kept(client, ticker_on, usage_polls, monkeypatch):
    monkeypatch.setattr(claude_sweep.get_pool_settings(), "sweep_seconds", 900)
    tenant_id, _ = await seed_auth()
    await add_account(tenant_id, "one")
    await client.post(PATH, headers=bearer(id_token()))
    await _age_sweep(tenant_id, 600)
    out = (await client.post(PATH, headers=bearer(id_token()))).json()["claude_accounts"]
    assert out["not_due"] == 1


@pytest.mark.parametrize("interval", [0, 300])
async def test_the_v1_tick_sweeps_only_when_due(
    client, ticker_on, usage_polls, monkeypatch, interval
):
    # POST /v1/internal/tick is what `oracle tick` (and a cron running it) calls.
    monkeypatch.setattr(claude_sweep.get_pool_settings(), "sweep_seconds", interval)
    polls, _ = usage_polls
    tenant_id, _ = await seed_auth()
    await add_account(tenant_id, "one")
    headers = await token_with_role(tenant_id, "owner")

    first = (await client.post("/v1/internal/tick", headers=headers)).json()["claude_accounts"]
    assert (first["lease"], first["polled"]) == ("ran", 1)
    await _age_sweep(tenant_id, 60)
    again = (await client.post("/v1/internal/tick", headers=headers)).json()["claude_accounts"]
    assert (again["lease"], again["polled"], again["examined"]) == ("not_due", 0, 0)
    # The scheduled tick shares the same record: not due there either.
    out = (await client.post(PATH, headers=bearer(id_token()))).json()["claude_accounts"]
    assert out["not_due"] == 1
    assert polls == ["acc-one"]
    await _age_sweep(tenant_id, 300)
    out = (await client.post("/v1/internal/tick", headers=headers)).json()["claude_accounts"]
    assert (out["lease"], out["polled"]) == ("ran", 1)


async def test_a_429_backs_the_next_usage_poll_off(client, ticker_on, usage_polls):
    polls, answers = usage_polls
    tenant_id, _ = await seed_auth()
    await add_account(tenant_id, "one")
    await add_account(tenant_id, "two")
    answers.append(usage.RateLimited(900))

    out = (await client.post(PATH, headers=bearer(id_token()))).json()["claude_accounts"]
    assert out["polled"] == 0 and len(polls) == 1
    async with tenant_session(tenant_id) as s:
        retry_at = await s.scalar(select(ClaudeSweepLease.usage_retry_at))
    assert retry_at is not None and retry_at > datetime.now(UTC) + timedelta(seconds=800)

    # The sweep is due again, but the 429's retry-after has not passed: no poll.
    await _age_sweep(tenant_id, 301)
    out = (await client.post(PATH, headers=bearer(id_token()))).json()["claude_accounts"]
    assert out["polled"] == 0 and out["not_due"] == 0 and len(polls) == 1

    # Once it has, the accounts are polled again.
    async with tenant_session(tenant_id) as s:
        await s.execute(
            update(ClaudeSweepLease).values(usage_retry_at=datetime.now(UTC) - timedelta(seconds=1))
        )
        await s.commit()
    await _age_sweep(tenant_id, 301)
    out = (await client.post(PATH, headers=bearer(id_token()))).json()["claude_accounts"]
    assert out["polled"] == 2 and len(polls) == 3


@pytest.mark.parametrize("retry_after", [10**30, 10**12, -(10**30)])
async def test_a_huge_retry_after_is_clamped(client, ticker_on, usage_polls, retry_after):
    _, answers = usage_polls
    tenant_id, _ = await seed_auth()
    await add_account(tenant_id, "one")
    answers.append(usage.RateLimited(retry_after))
    out = await claude_sweep.poll_usage(tenant_id)
    assert "error" not in out
    async with tenant_session(tenant_id) as s:
        retry_at = await s.scalar(select(ClaudeSweepLease.usage_retry_at))
    assert retry_at is not None
    assert retry_at <= datetime.now(UTC) + claude_sweep.MAX_USAGE_RETRY_AFTER


# --- built-in model jobs: never cut mid-call, put back when cancelled, one share each ----


@pytest.fixture
def claude(monkeypatch, usage_polls):
    """A fake Claude for built-in jobs, whose review_comments runner makes one call."""
    fake = FakeClaude()
    previous = gateway.set_transports(gateway.Transports(plan=fake, api_key=fake))

    async def one_call(s, job, ask):
        return await ask("review_comments", {"job": str(job.id)})

    monkeypatch.setitem(kinds.RUNNERS, "review_comments", one_call)
    # Tests set the model-call timeout itself: a job takes that long at most.
    monkeypatch.setattr(llm_jobs, "JOB_OVERHEAD_SECONDS", 0.0)
    yield fake
    gateway.set_transports(previous)


async def _backlog(client, jobs: int) -> uuid.UUID:
    """Another company with one Claude account and ``jobs`` queued built-in jobs."""
    tenant_id = await make_tenant("Backlog Co")
    headers = await token_with_role(tenant_id, "owner")
    await add_account(tenant_id, "personal", windows={"five_hour": window(0.2)})
    resp = await client.post(
        f"/v1/documents/{SLUG}/versions",
        content=DRAFT_V1.encode(),
        headers={**headers, "Content-Type": "text/markdown"},
    )
    assert resp.status_code in (200, 201), resp.text
    for _ in range(jobs):
        resp = await client.post(
            f"/v1/documents/{SLUG}/llm-jobs", json={"kind": "review_comments"}, headers=headers
        )
        assert resp.status_code == 201, resp.text
    return tenant_id


async def _jobs(tenant_id: uuid.UUID) -> list[LlmJob]:
    async with tenant_session(tenant_id) as s:
        return list(await s.scalars(select(LlmJob).order_by(LlmJob.created_at)))


async def test_a_job_is_never_cut_mid_call_by_the_tick(client, ticker_on, claude, monkeypatch):
    tenant_id = await _backlog(client, 5)
    monkeypatch.setattr(get_llm_settings(), "timeout_seconds", 1.0)
    monkeypatch.setattr(ticker, "HARD_LIMIT_SECONDS", 2.5)

    async def slow(kind, payload):
        await asyncio.sleep(0.8)

    claude.on_call = slow
    out = (await client.post(PATH, headers=bearer(id_token()))).json()
    assert out["timed_out"] is False
    statuses = [j.status for j in await _jobs(tenant_id)]
    # Only jobs that could finish inside the tick were claimed; the rest wait, unclaimed.
    assert "running" not in statuses
    assert 1 <= out["llm_jobs"]["ran"] == statuses.count("succeeded") < 5
    assert statuses.count("queued") == 5 - out["llm_jobs"]["ran"]


async def test_no_job_is_claimed_when_less_than_a_call_remains(
    client, ticker_on, claude, monkeypatch
):
    tenant_id = await _backlog(client, 1)
    monkeypatch.setattr(get_llm_settings(), "timeout_seconds", 300.0)
    out = (await client.post(PATH, headers=bearer(id_token()))).json()
    assert out["llm_jobs"]["ran"] == 0 and claude.calls == []
    [job] = await _jobs(tenant_id)
    assert (job.status, job.attempts) == ("queued", 0)


async def test_a_job_whose_calls_keep_overrunning_fails_after_its_attempts(
    client, ticker_on, claude, monkeypatch
):
    tenant_id = await _backlog(client, 1)
    # A call that outlives the tick's hard limit anyway (a model call past its timeout).
    monkeypatch.setattr(get_llm_settings(), "timeout_seconds", 0.01)
    monkeypatch.setattr(ticker, "HARD_LIMIT_SECONDS", 1.0)

    async def hang(kind, payload):
        await asyncio.sleep(30)

    claude.on_call = hang
    for attempt in range(1, llm_jobs.MAX_ATTEMPTS + 1):
        out = (await client.post(PATH, headers=bearer(id_token()))).json()
        assert out["timed_out"] is True and len(claude.calls) == attempt
        [job] = await _jobs(tenant_id)
        # The call had started: the cut is an attempt, with what is known of it.
        assert job.attempts == attempt and "cut off" in (job.error or "")
        assert (job.account_label, job.via) == ("personal", "account")
        assert job.output is None
    assert job.status == "failed" and job.finished_at is not None
    # Failed for good: the next tick runs nothing, instead of the same job forever.
    out = (await client.post(PATH, headers=bearer(id_token()))).json()
    assert out["llm_jobs"]["ran"] == 0 and len(claude.calls) == llm_jobs.MAX_ATTEMPTS


async def test_a_job_cut_before_its_call_started_goes_back_to_the_queue(
    client, ticker_on, claude, monkeypatch
):
    tenant_id = await _backlog(client, 1)
    monkeypatch.setattr(get_llm_settings(), "timeout_seconds", 0.01)
    monkeypatch.setattr(ticker, "HARD_LIMIT_SECONDS", 1.0)
    reading = asyncio.Event()

    async def slow_inputs(s, job, ask):
        # Reading the job's inputs outlives the tick: no model call has started.
        if not reading.is_set():
            await asyncio.sleep(30)
        return await ask("review_comments", {"job": str(job.id)})

    monkeypatch.setitem(kinds.RUNNERS, "review_comments", slow_inputs)
    out = (await client.post(PATH, headers=bearer(id_token()))).json()
    assert out["timed_out"] is True and claude.calls == []
    [job] = await _jobs(tenant_id)
    assert (job.status, job.attempts) == ("queued", 0)
    assert job.finished_at is None and job.output is None
    assert (job.account_label, job.input_tokens, job.cost_usd) == (None, None, None)
    # Its claim is released: the next tick runs it.
    reading.set()
    monkeypatch.setattr(ticker, "HARD_LIMIT_SECONDS", 240.0)
    out = (await client.post(PATH, headers=bearer(id_token()))).json()
    assert out["llm_jobs"]["succeeded"] == 1
    [job] = await _jobs(tenant_id)
    assert (job.status, job.attempts) == ("succeeded", 1)


async def test_a_job_swaps_to_no_account_it_has_no_time_left_for(
    client, ticker_on, claude, monkeypatch
):
    tenant_id = await _backlog(client, 1)
    await add_account(tenant_id, "spare", windows={"five_hour": window(0.3)})
    monkeypatch.setattr(get_llm_settings(), "timeout_seconds", 1.0)
    monkeypatch.setattr(ticker, "HARD_LIMIT_SECONDS", 1.6)

    async def slow(kind, payload):
        await asyncio.sleep(0.7)

    claude.on_call = slow
    claude.script["review_comments"] = [LlmRateLimited("out of quota")]
    out = (await client.post(PATH, headers=bearer(id_token()))).json()
    # The first account was spent, and no second call fits: a retry, not a cut.
    assert out["timed_out"] is False and len(claude.calls) == 1
    assert out["llm_jobs"]["retried"] == 1
    [job] = await _jobs(tenant_id)
    assert (job.status, job.attempts) == ("queued", 1)


async def test_no_job_runs_with_a_limit_of_zero(client, ticker_on, claude, monkeypatch):
    tenant_id = await _backlog(client, 2)
    monkeypatch.setattr(get_llm_settings(), "timeout_seconds", 0.05)
    monkeypatch.setattr(llm_jobs.get_worker_settings(), "max_per_tick", 0)
    out = (await client.post(PATH, headers=bearer(id_token()))).json()
    assert out["llm_jobs"]["ran"] == 0 and claude.calls == []
    assert [j.status for j in await _jobs(tenant_id)] == ["queued", "queued"]


async def test_a_backlog_defers_no_other_companys_runs(
    client, ticker_on, runtime, claude, monkeypatch
):
    _, auth = await seed_auth()
    run = await started(client, auth)
    backlog = await _backlog(client, 10)
    # The company with the backlog goes first.
    monkeypatch.setattr(ticker.random, "shuffle", lambda ids: ids.sort(key=lambda t: t != backlog))
    monkeypatch.setattr(get_llm_settings(), "timeout_seconds", 0.05)
    monkeypatch.setattr(ticker, "BUDGET_SECONDS", 0.5)

    async def slow(kind, payload):
        await asyncio.sleep(0.15)

    claude.on_call = slow
    out = (await client.post(PATH, headers=bearer(id_token()))).json()
    assert out["companies"] == {"ticked": 2, "failed": 0, "deferred": 0}
    assert out["runs"]["segments_finished"] == 1
    assert out["llm_jobs"]["succeeded"] == 10
    assert (await get(client, auth, run["id"]))["status"] == "awaiting_checkpoint"


async def test_companies_take_turns_at_built_in_jobs(client, ticker_on, claude, monkeypatch):
    first = await _backlog(client, 3)
    second = await make_tenant("Second Co")
    headers = await token_with_role(second, "owner")
    await add_account(second, "personal", windows={"five_hour": window(0.2)})
    resp = await client.post(
        f"/v1/documents/{SLUG}/versions",
        content=DRAFT_V1.encode(),
        headers={**headers, "Content-Type": "text/markdown"},
    )
    assert resp.status_code in (200, 201), resp.text
    resp = await client.post(
        f"/v1/documents/{SLUG}/llm-jobs", json={"kind": "review_comments"}, headers=headers
    )
    assert resp.status_code == 201
    monkeypatch.setattr(ticker.random, "shuffle", lambda ids: ids.sort(key=lambda t: t != first))
    monkeypatch.setattr(get_llm_settings(), "timeout_seconds", 0.05)
    order: list[uuid.UUID] = []

    async def note(kind, payload):
        async with tenant_session(first) as s:
            mine = await s.get(LlmJob, uuid.UUID(payload["job"]))
        order.append(first if mine is not None else second)

    claude.on_call = note
    out = (await client.post(PATH, headers=bearer(id_token()))).json()
    assert out["llm_jobs"]["succeeded"] == 4
    # One job each in turn: the second company's job runs before the backlog's second.
    assert order[:2] == [first, second]
