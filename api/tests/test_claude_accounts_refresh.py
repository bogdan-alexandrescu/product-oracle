"""The single writer and the sweep, mirroring SwarmCloud's test_account_refresh.py,
test_refresh_skips_held_accounts.py and the sweep's REAUTH_REQUIRED confirmation."""

import json
from datetime import UTC, datetime, timedelta

import pytest

from oracle.claude_accounts import store, sweep
from oracle.claude_accounts.accounts import AccountState
from oracle.claude_accounts.credentials import (
    DEFAULT_HELD_REFRESH_MARGIN,
    CredentialRefresher,
)
from oracle.claude_accounts.oauth import Credential, serialise
from tests.claude_account_helpers import REAUTH, FakeEndpoint, add_account, get_account, now

NOW = datetime(2026, 10, 18, 12, 0, tzinfo=UTC)


class RecordingStore:
    """A secret store that records every write in order."""

    def __init__(self, secrets: dict[str, str]):
        self.secrets = dict(secrets)
        self.writes: list[str] = []
        self.fail_reads: set[str] = set()

    async def access(self, name: str) -> str:
        if name in self.fail_reads:
            raise RuntimeError("store down")
        if name not in self.secrets:
            raise KeyError(name)
        return self.secrets[name]

    async def add_version(self, name: str, payload: str) -> None:
        self.writes.append(name)
        self.secrets[name] = payload


def _pair(expires_in: timedelta, access="acc", refresh="ref") -> str:
    ms = int((NOW + expires_in).timestamp() * 1000)
    return json.dumps({"accessToken": access, "refreshToken": refresh, "expiresAt": ms})


def _refresher(secrets, endpoint=None):
    s = RecordingStore(secrets)
    return CredentialRefresher(s, endpoint or FakeEndpoint(), now=lambda: NOW), s


async def test_the_rotated_pair_is_persisted_before_the_access_token():
    r, s = _refresher({"a-refresh": _pair(timedelta(hours=1)), "a": "acc"})
    out = await r.refresh_secret("a")
    assert (out.refreshed, out.reason) == (True, "refreshed")
    assert s.writes == ["a-refresh", "a"]
    stored = json.loads(s.secrets["a-refresh"])
    assert (stored["accessToken"], stored["refreshToken"]) == ("acc-new-1", "ref-new-1")
    assert s.secrets["a"] == "acc-new-1"


async def test_an_account_far_from_expiry_costs_no_endpoint_call_and_no_write():
    endpoint = FakeEndpoint()
    r, s = _refresher({"a-refresh": _pair(timedelta(hours=7)), "a": "acc"}, endpoint)
    out = await r.refresh_secret("a")
    assert out.reason == "still_valid" and out.expires_at == NOW + timedelta(hours=7)
    assert endpoint.exchanged == [] and s.writes == []


async def test_still_valid_is_not_already_published():
    r, s = _refresher({"a-refresh": _pair(timedelta(hours=7))})
    out = await r.refresh_secret("a")
    assert (out.refreshed, out.reason) == (True, "published")
    assert s.writes == ["a"] and s.secrets["a"] == "acc"


async def test_a_held_account_inside_the_window_but_outside_the_margin_is_not_refreshed():
    endpoint = FakeEndpoint()
    r, s = _refresher({"a-refresh": _pair(timedelta(hours=1)), "a": "acc"}, endpoint)
    out = await r.refresh_secret("a", held=True)
    assert out.reason == "held_deferred" and out.expires_at == NOW + timedelta(hours=1)
    assert endpoint.exchanged == [] and s.writes == []


async def test_a_held_account_near_expiry_is_refreshed():
    near = DEFAULT_HELD_REFRESH_MARGIN - timedelta(minutes=1)
    r, s = _refresher({"a-refresh": _pair(near), "a": "acc"})
    assert (await r.refresh_secret("a", held=True)).reason == "refreshed"
    assert s.writes == ["a-refresh", "a"]


async def test_a_dead_refresh_token_is_reauth_and_nothing_is_written():
    endpoint = FakeEndpoint()
    endpoint.refuse = REAUTH
    r, s = _refresher({"a-refresh": _pair(timedelta(hours=1)), "a": "acc"}, endpoint)
    assert (await r.refresh_secret("a")).reason == "reauth_required"
    assert s.writes == []


async def test_missing_unreadable_and_unavailable_are_different_answers():
    r, s = _refresher({"b-refresh": "not json", "c-refresh": _pair(timedelta(hours=1))})
    s.fail_reads.add("c-refresh")
    assert (await r.refresh_secret("a")).reason == "no_refresh_credential"
    assert (await r.refresh_secret("b")).reason == "unreadable"
    assert (await r.refresh_secret("c")).reason == "store_unavailable"


async def test_one_bad_account_does_not_stop_the_rest_and_the_fence_does():
    r, s = _refresher({"a-refresh": "not json", "b-refresh": _pair(timedelta(hours=1)), "b": "acc"})
    out = await r.sweep_accounts(["a", "b"])
    assert [o.reason for o in out] == ["unreadable", "refreshed"]
    calls = 0

    async def fence() -> bool:
        nonlocal calls
        calls += 1
        return calls == 1

    assert len(await r.sweep_accounts(["a", "b"], keep_going=fence)) == 1


async def test_no_token_material_reaches_the_outcome():
    r, _ = _refresher({"a-refresh": _pair(timedelta(hours=1), access="secret-acc"), "a": "x"})
    text = json.dumps((await r.refresh_secret("a")).as_dict())
    assert "secret-acc" not in text and "acc-new" not in text and "ref-new" not in text


# --- the sweep, against Postgres ------------------------------------------------------


@pytest.fixture
def endpoint():
    fake = FakeEndpoint()
    previous = sweep.set_token_endpoint(fake)
    previous_fetch = sweep.set_usage_fetch(None)
    yield fake
    sweep.set_token_endpoint(previous)
    sweep.set_usage_fetch(previous_fetch)


@pytest.fixture
def no_usage():
    async def fetch(token):
        from oracle.claude_accounts.usage import UsageUnavailable

        raise UsageUnavailable("not in this test")

    previous = sweep.set_usage_fetch(fetch)
    yield
    sweep.set_usage_fetch(previous)


async def test_every_account_is_refreshed_including_idle_and_paused_ones(
    tenant_id, endpoint, no_usage
):
    idle = await add_account(tenant_id, "idle", expires_in=timedelta(hours=1))
    paused = await add_account(
        tenant_id, "paused", expires_in=timedelta(hours=1), state=AccountState.PAUSED
    )
    dead = await add_account(
        tenant_id, "dead", expires_in=timedelta(hours=1), state=AccountState.REAUTH_REQUIRED
    )
    result = await sweep.sweep(tenant_id)
    assert result["accounts"]["refreshed"] == 2
    assert sorted(endpoint.exchanged) == ["ref-idle", "ref-paused"]
    for a in (idle, paused):
        account = await get_account(tenant_id, a.account_id)
        assert account.last_refresh_reason == "refreshed"
        assert account.token_expires_at is not None
    assert (await get_account(tenant_id, dead.account_id)).last_refresh_at is None
    assert result["sweep_lease"]["acquired"] is True


async def test_the_sweep_defers_only_accounts_with_a_live_hold(tenant_id, endpoint, no_usage):
    held = await add_account(tenant_id, "held", expires_in=timedelta(hours=1))
    stale_hold = await add_account(tenant_id, "stale", expires_in=timedelta(hours=1))
    await store.acquire_hold(tenant_id, held.account_id, now=now())
    await store.acquire_hold(tenant_id, stale_hold.account_id, now=now() - timedelta(hours=4))
    result = await sweep.sweep(tenant_id)
    assert result["accounts"]["held_deferred"] == [held.account_id]
    assert endpoint.exchanged == ["ref-stale"]


async def test_a_dead_credential_is_confirmed_then_marked_and_not_retried(
    tenant_id, endpoint, no_usage
):
    a = await add_account(tenant_id, "work", expires_in=timedelta(hours=1))
    endpoint.refuse = REAUTH
    result = await sweep.sweep(tenant_id)
    assert result["accounts"]["marked_reauth_required"] == [a.account_id]
    # Confirmed with a second exchange before it was written.
    assert endpoint.exchanged == ["ref-work", "ref-work"]
    account = await get_account(tenant_id, a.account_id)
    assert account.state is AccountState.REAUTH_REQUIRED
    assert account.state_before_reauth is AccountState.AVAILABLE
    assert account.reason == "refresh failed: reauth_required"
    await sweep.sweep(tenant_id)
    assert len(endpoint.exchanged) == 2


async def test_a_refresh_that_works_on_the_second_attempt_leaves_the_state_alone(
    tenant_id, endpoint, no_usage
):
    a = await add_account(tenant_id, "work", expires_in=timedelta(hours=1))
    endpoint.refuse_once = REAUTH
    result = await sweep.sweep(tenant_id)
    assert result["accounts"]["reauth_required"] == [a.account_id]
    assert result["accounts"]["marked_reauth_required"] == []
    account = await get_account(tenant_id, a.account_id)
    assert account.state is AccountState.AVAILABLE
    assert account.last_refresh_reason == "refreshed"


async def test_another_sweep_holding_the_lease_means_no_exchange(tenant_id, endpoint, no_usage):
    await add_account(tenant_id, "work", expires_in=timedelta(hours=1))
    taken = await sweep.acquire_lease(tenant_id, "someone-else", now())
    assert taken.acquired
    result = await sweep.sweep(tenant_id)
    assert result["sweep_lease"]["acquired"] is False
    assert result["sweep_lease"]["held_by"] == "someone-else"
    assert endpoint.exchanged == []
    # Once it lapses, the next sweep takes it over.
    later = now() + sweep.LEASE_TTL + timedelta(seconds=1)
    assert (await sweep.acquire_lease(tenant_id, "me", later)).acquired


async def test_the_lease_records_that_the_sweep_is_alive(client, tenant_id, endpoint, no_usage):
    from tests.connection_helpers import make_person

    owner = await make_person(tenant_id, "owner@example.com", "owner")
    page = (await client.get("/v1/claude-accounts", headers=owner.headers)).json()
    assert page["refresh_sweep"]["last_completed_at"] is None
    await sweep.sweep(tenant_id)
    page = (await client.get("/v1/claude-accounts", headers=owner.headers)).json()
    assert page["refresh_sweep"]["last_outcome"] == "ok"
    assert page["refresh_sweep"]["last_completed_at"] is not None


async def test_usage_readings_land_on_the_account_within_the_budget(tenant_id, endpoint):
    from oracle.claude_accounts.accounts import WindowReading

    accounts = [await add_account(tenant_id, f"acct-{i}") for i in range(5)]
    tokens: list[str] = []

    async def fetch(token):
        tokens.append(token)
        return {"five_hour": WindowReading(0.42, now() + timedelta(hours=2))}

    sweep.set_usage_fetch(fetch)
    result = await sweep.sweep(tenant_id)
    assert result["usage"]["polled"] == 3
    assert len(tokens) == 3 and all(t.startswith("acc-acct-") for t in tokens)
    read = [await get_account(tenant_id, a.account_id) for a in accounts]
    assert sum(1 for a in read if a.observed_at is not None) == 3


async def test_the_refresh_button_goes_through_the_same_writer_and_recovers(
    client, tenant_id, endpoint
):
    from tests.connection_helpers import make_person

    owner = await make_person(tenant_id, "owner@example.com", "owner")
    a = await add_account(tenant_id, "work", expires_in=timedelta(hours=1))
    await store.mark_reauth_required(tenant_id, a.account_id, "refresh failed: reauth_required")
    resp = await client.post(f"/v1/claude-accounts/{a.account_id}/refresh", headers=owner.headers)
    assert resp.status_code == 200
    body = resp.json()
    assert body["refresh"]["reason"] == "refreshed"
    assert body["account"]["state"] == "AVAILABLE"
    assert body["account"]["last_refresh_reason"] == "refreshed"

    endpoint.refuse = REAUTH
    await store.DbSecretStore(tenant_id).add_version(
        f"{a.account_id}-refresh",
        serialise(Credential("acc", "ref-dying", now() + timedelta(minutes=5))),
    )
    body = (
        await client.post(f"/v1/claude-accounts/{a.account_id}/refresh", headers=owner.headers)
    ).json()
    assert body["refresh"]["reason"] == "reauth_required"
    assert body["account"]["state"] == "REAUTH_REQUIRED"
