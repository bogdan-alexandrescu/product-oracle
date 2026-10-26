"""S4 Freshness (A2 §8): the run ticker syncs each source about hourly.

A source is due when it last synced an hour ago or more (or never) and its backoff has
passed. Paused sources, uploads and sources without a working connection are never
synced in the background. A tick syncs a bounded number of sources, the stalest first,
and at most one per connection (each provider's limits are per connection). A failed
sync backs off (2 h, 4 h, … up to a day); a rate limit waits for the provider's retry
time; a sync that completes clears both."""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select, update

from oracle.connections.models import Connection
from oracle.sources import background, base, service
from oracle.sources.base import ConnectorError, ConnectorRateLimited
from oracle.sources.models import Source
from oracle.tenancy import tenant_session
from oracle.ticker import router as ticker
from tests.sources_helpers import FakeConnector, client_for, make_connection, make_user, message


@pytest.fixture
def slack(monkeypatch):
    service.load_connectors()
    fake = FakeConnector(kind="slack", pages=[[message("m1", "one")]])
    monkeypatch.setitem(base._registry, "slack", fake)
    return fake


@pytest.fixture
async def a(tenant_id):
    alice = await make_user(tenant_id, "alice@example.com")
    async with client_for(alice) as c:
        c.user = alice
        yield c


async def _source(a, tenant_id, name="Team chat", conn=None, kind="slack"):
    if kind == "upload":
        body = {"kind": "upload", "name": name, "config": {}}
    else:
        conn = conn or await make_connection(tenant_id, a.user, kind)
        body = {"kind": kind, "name": name, "connection_id": str(conn), "config": {"channels": ["C1"]}}
    resp = await a.post("/v1/sources", json=body)
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


async def _get(tenant_id, source_id) -> Source:
    async with tenant_session(tenant_id) as s:
        return await s.get(Source, source_id)


async def _set(tenant_id, source_id, **values) -> None:
    async with tenant_session(tenant_id) as s:
        await s.execute(update(Source).where(Source.id == source_id).values(**values))
        await s.commit()


async def _due(tenant_id, now=None) -> background.Synced:
    async with tenant_session(tenant_id) as s:
        return await background.sync_due(s, now=now or datetime.now(UTC))


async def test_the_ticker_syncs_a_source_never_synced(a, tenant_id, slack):
    sid = await _source(a, tenant_id)
    out = ticker.TickerOut()
    await ticker._tick_company(tenant_id, out, ticker._Failures(out))
    src = await _get(tenant_id, sid)
    assert src.last_synced_at is not None
    assert out.sources.synced == 1 and out.sources.failed == 0
    assert (await a.get(f"/v1/sources/{sid}")).json()["item_count"] == 1


async def test_a_source_synced_within_the_hour_waits(a, tenant_id, slack):
    sid = await _source(a, tenant_id)
    assert (await _due(tenant_id)).synced == 1
    calls = len(slack.calls)
    assert (await _due(tenant_id)).synced == 0
    assert len(slack.calls) == calls
    # An hour on, it is due again.
    await _set(tenant_id, sid, last_synced_at=datetime.now(UTC) - timedelta(minutes=61))
    assert (await _due(tenant_id)).synced == 1


async def test_paused_uploads_and_disconnected_sources_are_left_alone(a, tenant_id, slack):
    paused = await _source(a, tenant_id, "Paused chat")
    assert (await a.post(f"/v1/sources/{paused}/pause")).status_code == 200
    await _source(a, tenant_id, "Files", kind="upload")
    revoked_conn = await make_connection(tenant_id, a.user, "slack")
    revoked = await _source(a, tenant_id, "Revoked chat", conn=revoked_conn)
    async with tenant_session(tenant_id) as s:
        await s.execute(
            update(Connection).where(Connection.id == revoked_conn).values(status="revoked")
        )
        await s.commit()
    gone_conn = await make_connection(tenant_id, a.user, "slack")
    gone = await _source(a, tenant_id, "Removed chat", conn=gone_conn)
    await _set(tenant_id, gone, connection_id=None)

    result = await _due(tenant_id)

    assert result.synced == 0 and result.failed == 0
    assert slack.calls == []
    for sid in (paused, revoked, gone):
        assert (await _get(tenant_id, sid)).last_synced_at is None


async def test_a_tick_is_bounded_stalest_first_and_one_per_connection(a, tenant_id, slack):
    now = datetime.now(UTC)
    ids = []
    for i in range(background.SOURCES_PER_TICK + 2):
        sid = await _source(a, tenant_id, f"Chat {i}")
        # Chat 0 is the stalest.
        await _set(tenant_id, sid, last_synced_at=now - timedelta(hours=10 - i))
        ids.append(sid)
    shared_conn = await make_connection(tenant_id, a.user, "slack")
    one = await _source(a, tenant_id, "Shared one", conn=shared_conn)
    two = await _source(a, tenant_id, "Shared two", conn=shared_conn)
    await _set(tenant_id, one, last_synced_at=now - timedelta(days=3))
    await _set(tenant_id, two, last_synced_at=now - timedelta(days=2))

    result = await _due(tenant_id, now)

    assert result.synced == background.SOURCES_PER_TICK
    synced = [
        sid for sid in [one, two, *ids] if (await _get(tenant_id, sid)).last_synced_at > now
    ]
    # One of the two on the shared connection (the stalest), then the stalest others.
    assert synced == [one, *ids[: background.SOURCES_PER_TICK - 1]]


async def test_a_failed_sync_backs_off_then_recovers(a, tenant_id, slack):
    sid = await _source(a, tenant_id)
    slack.fail = {0: ConnectorError("upstream down")}
    now = datetime.now(UTC)

    assert (await _due(tenant_id, now)).failed == 1
    src = await _get(tenant_id, sid)
    assert src.status == "error" and src.sync_failures == 1
    assert src.next_sync_at == now + timedelta(hours=2)

    # Not retried before the backoff ends, even though it never synced.
    calls = len(slack.calls)
    assert (await _due(tenant_id, now + timedelta(hours=1))).failed == 0
    assert len(slack.calls) == calls

    # The second failure waits twice as long.
    assert (await _due(tenant_id, now + timedelta(hours=2))).failed == 1
    src = await _get(tenant_id, sid)
    assert src.sync_failures == 2
    assert src.next_sync_at == now + timedelta(hours=2) + timedelta(hours=4)

    # Fixed upstream: the next due sync completes and clears the backoff.
    slack.fail = {}
    assert (await _due(tenant_id, now + timedelta(hours=7))).synced == 1
    src = await _get(tenant_id, sid)
    assert src.status == "active" and src.sync_failures == 0 and src.next_sync_at is None


async def test_the_backoff_stops_at_a_day(a, tenant_id, slack):
    sid = await _source(a, tenant_id)
    slack.fail = {0: ConnectorError("upstream down")}
    await _set(tenant_id, sid, sync_failures=9)
    now = datetime.now(UTC)
    await _due(tenant_id, now)
    assert (await _get(tenant_id, sid)).next_sync_at == now + background.MAX_BACKOFF


async def test_a_rate_limit_waits_for_the_provider(a, tenant_id, slack):
    sid = await _source(a, tenant_id)
    slack.fail = {0: ConnectorRateLimited(retry_after=7200)}
    now = datetime.now(UTC)
    result = await _due(tenant_id, now)
    assert result.rate_limited == 1
    src = await _get(tenant_id, sid)
    assert src.sync_failures == 0
    assert src.next_sync_at == now + timedelta(seconds=7200)


async def test_a_short_rate_limit_still_waits_the_minimum(a, tenant_id, slack):
    sid = await _source(a, tenant_id)
    slack.fail = {0: ConnectorRateLimited(retry_after=5)}
    now = datetime.now(UTC)
    await _due(tenant_id, now)
    assert (await _get(tenant_id, sid)).next_sync_at == now + background.MIN_RATE_LIMIT_WAIT


async def test_a_manual_sync_clears_the_backoff(a, tenant_id, slack):
    sid = await _source(a, tenant_id)
    await _set(tenant_id, sid, sync_failures=3, next_sync_at=datetime.now(UTC) + timedelta(hours=8))
    resp = await a.post(f"/v1/sources/{sid}/sync")
    assert resp.status_code == 200 and resp.json()["outcome"] == "completed"
    src = await _get(tenant_id, sid)
    assert src.sync_failures == 0 and src.next_sync_at is None


async def test_the_deadline_stops_new_syncs(a, tenant_id, slack):
    await _source(a, tenant_id)
    async with tenant_session(tenant_id) as s:
        result = await background.sync_due(s, now=datetime.now(UTC), deadline=0.0)
    assert result.synced == 0 and slack.calls == []

