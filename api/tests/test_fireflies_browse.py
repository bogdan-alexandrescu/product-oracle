"""Browsing a Fireflies connection's meetings and series, and syncing a picked source
(S5, owner 2026-10-19). Fireflies is mocked: no network."""

import uuid
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from sqlalchemy import func, select, update

from oracle.connections.models import Connection
from oracle.main import app
from oracle.sources import base, fireflies_browse, service
from oracle.sources.base import SCOPE_KEY
from oracle.sources.connectors.fireflies import (
    MAX_LABEL,
    MAX_LABELS,
    MAX_MEETING_ID,
    MAX_MEETINGS,
    MAX_SERIES,
    MAX_SERIES_KEY,
    FirefliesConnector,
)
from oracle.sources.models import Source, SourceItem, SourceItemVersion
from oracle.tenancy import tenant_session
from tests.connection_helpers import clear_provider_http, use_provider_http
from tests.fireflies_fake import (
    API_KEY,
    PLANNING_CAL,
    SAMPLE,
    STANDUP_CAL,
    FakeFireflies,
    meeting,
    rate_limited,
)
from tests.sources_helpers import client_for, make_connection, make_user, patch_source

STANDUP = f"cal:{STANDUP_CAL}"
PLANNING = f"cal:{PLANNING_CAL}"


@pytest.fixture
def fake():
    fake = FakeFireflies(list(SAMPLE))
    use_provider_http(fake)
    fireflies_browse.reset_limits()
    yield fake
    clear_provider_http()
    fireflies_browse.reset_limits()


@pytest.fixture
def connector(fake, monkeypatch):
    """The registered Fireflies connector, talking to the fake."""
    service.load_connectors()
    real = FirefliesConnector(httpx.AsyncClient(transport=httpx.MockTransport(fake)))
    monkeypatch.setitem(base._registry, "fireflies", real)
    return real


@pytest.fixture
async def alice(tenant_id):
    return await make_user(tenant_id, "alice@example.com")


@pytest.fixture
async def bob(tenant_id):
    return await make_user(tenant_id, "bob@example.com")


@pytest.fixture
async def conn(tenant_id, alice):
    return await make_connection(
        tenant_id, alice, "fireflies", credential={"access_token": API_KEY}
    )


async def test_meetings_lists_the_owners_meetings_paged(fake, alice, conn):
    async with client_for(alice) as a:
        resp = await a.get(f"/v1/connections/{conn}/fireflies/meetings")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert [m["id"] for m in body["meetings"]] == ["P2", "S3", "S2", "K1", "P1", "S1", "O1"]
        assert body["next_cursor"] is None
        k1 = next(m for m in body["meetings"] if m["id"] == "K1")
        assert k1 == {
            "id": "K1",
            "title": "Customer interview: Acme",
            "date": "2026-10-02T16:00:00Z",
            "duration": 45.5,
            "organizer": "ada@example.com",
            "attendee_count": 3,
            "series_key": None,
            "series_title": "Customer interview: Acme",
        }
        # The API key is used server-side only.
        assert API_KEY not in resp.text

        resp = await a.get(
            f"/v1/connections/{conn}/fireflies/meetings",
            params={"search": "standup", "from": "2026-10-01", "to": "2026-10-31"},
        )
        assert [m["id"] for m in resp.json()["meetings"]] == ["S3", "S2"]
    listed = fake.list_variables()[-1]
    assert listed["keyword"] == "standup"
    # #401: from/to are whole days in the Company time zone (Los Angeles by default).
    assert listed["fromDate"] == "2026-10-01T07:00:00Z"
    assert listed["toDate"] == "2026-11-01T06:59:59.999Z"


async def test_meetings_cursor_pages(fake, alice, conn, monkeypatch):
    from oracle.sources.connectors import fireflies

    monkeypatch.setattr(fireflies, "PAGE_SIZE", 3)
    async with client_for(alice) as a:
        first = (await a.get(f"/v1/connections/{conn}/fireflies/meetings")).json()
        assert [m["id"] for m in first["meetings"]] == ["P2", "S3", "S2"]
        assert first["next_cursor"]
        second = (
            await a.get(
                f"/v1/connections/{conn}/fireflies/meetings",
                params={"cursor": first["next_cursor"]},
            )
        ).json()
        assert [m["id"] for m in second["meetings"]] == ["K1", "P1", "S1"]
        bad = await a.get(f"/v1/connections/{conn}/fireflies/meetings", params={"cursor": "x"})
        assert bad.status_code == 422


async def test_series_lists_groups_with_counts(fake, alice, conn):
    async with client_for(alice) as a:
        resp = await a.get(f"/v1/connections/{conn}/fireflies/series")
    assert resp.status_code == 200, resp.text
    series = {s["key"]: s for s in resp.json()["series"]}
    assert series[STANDUP]["meeting_count"] == 3
    assert series[STANDUP]["title"] == "AI agents daily standup"
    assert series[STANDUP]["last_date"] == "2026-10-12T09:00:00Z"
    assert series[PLANNING]["meeting_count"] == 2
    # The one-off and the old kickoff are on no calendar: in no series.
    assert set(series) == {STANDUP, PLANNING}
    assert resp.json()["truncated"] is False


async def test_another_users_connection_is_not_found(fake, tenant_id, bob, conn):
    github = await make_connection(tenant_id, bob, "github")
    async with client_for(bob) as b:
        for path in ("meetings", "series"):
            resp = await b.get(f"/v1/connections/{conn}/fireflies/{path}")
            assert resp.status_code == 404
            # Bob's own connection of another provider is not a Fireflies one.
            resp = await b.get(f"/v1/connections/{github}/fireflies/{path}")
            assert resp.status_code == 404
    assert fake.requests == []


async def test_rate_limit_surfaces_as_a_retry_message(fake, alice, conn):
    fake.error = rate_limited(30)
    async with client_for(alice) as a:
        resp = await a.get(f"/v1/connections/{conn}/fireflies/meetings")
    assert resp.status_code == 429
    assert resp.headers["Retry-After"] == "30"
    assert "try again in 30 seconds" in resp.json()["detail"].lower()


async def test_rejected_key_asks_to_reconnect(fake, alice, conn):
    fake.error = httpx.Response(401, json={"errors": [{"message": "Invalid API key"}]})
    async with client_for(alice) as a:
        resp = await a.get(f"/v1/connections/{conn}/fireflies/series")
    assert resp.status_code == 409
    assert "reconnect" in resp.json()["detail"].lower()
    assert API_KEY not in resp.text


# --- Sources ------------------------------------------------------------------------


async def _items(tenant_id, source_id) -> dict[str, bool]:
    async with tenant_session(tenant_id) as s:
        rows = await s.scalars(select(SourceItem).where(SourceItem.source_id == source_id))
        return {i.external_id: i.deleted_at is None for i in rows}


async def test_picked_source_syncs_and_drops_what_is_unpicked(
    fake, connector, tenant_id, alice, conn
):
    async with client_for(alice) as a:
        resp = await a.post(
            "/v1/sources",
            json={
                "kind": "fireflies",
                "name": "Agents meetings",
                "connection_id": str(conn),
                "config": {"mode": "selected", "series": [STANDUP], "meetings": ["K1"]},
            },
        )
        assert resp.status_code == 201, resp.text
        source = resp.json()
        sync = (await a.post(f"/v1/sources/{source['id']}/sync")).json()
        assert sync["outcome"] == "completed", sync
        assert await _items(tenant_id, source["id"]) == {
            "S1": True,
            "S2": True,
            "S3": True,
            "K1": True,
        }

        # Unpick the interview, add the planning series.
        resp = await patch_source(
            a, source["id"], {"config": {"mode": "selected", "series": [STANDUP, PLANNING]}}
        )
        assert resp.status_code == 200, resp.text
        # The unpicked interview went on save (owner 2026-10-20), not on the next sync.
        assert (await _items(tenant_id, source["id"]))["K1"] is False
        fake.requests.clear()
        sync = (await a.post(f"/v1/sources/{source['id']}/sync")).json()
        assert sync["outcome"] == "completed", sync
        assert sync["deleted"] == 0
        assert await _items(tenant_id, source["id"]) == {
            "S1": True,
            "S2": True,
            "S3": True,
            "K1": False,
            "P1": True,
            "P2": True,
        }
        # Only the newly picked meetings were read in full.
        assert sorted(fake.detail_ids()) == ["P1", "P2"]


async def test_legacy_source_keeps_syncing(fake, connector, tenant_id, alice, conn):
    async with client_for(alice) as a:
        resp = await a.post(
            "/v1/sources",
            json={
                "kind": "fireflies",
                "name": "Old rule",
                "connection_id": str(conn),
                "config": {"from_date": "2026-09-01", "title_contains": ["standup"]},
            },
        )
        assert resp.status_code == 201, resp.text
        sync = (await a.post(f"/v1/sources/{resp.json()['id']}/sync")).json()
        assert sync["outcome"] == "completed", sync
        assert set(await _items(tenant_id, resp.json()["id"])) == {"S1", "S2", "S3"}


ALL_IDS = {"S1", "S2", "S3", "P1", "P2", "K1", "O1"}


@pytest.mark.parametrize(
    ("before", "after", "kept"),
    [
        pytest.param(
            {"mode": "selected", "series": [STANDUP], "meetings": ["K1"]},
            {"mode": "selected", "series": [STANDUP]},
            {"S1", "S2", "S3"},
            id="deselect-a-meeting",
        ),
        pytest.param(
            {"mode": "selected", "series": [STANDUP, PLANNING]},
            {"mode": "selected", "series": [PLANNING]},
            {"P1", "P2"},
            id="deselect-a-series",
        ),
        pytest.param(
            {"mode": "all"},
            {"mode": "all", "date_from": "2026-10-10"},
            {"S3", "P2"},
            id="later-date-from",
        ),
        pytest.param(
            {"mode": "all", "date_from": "2026-09-01"},
            {"mode": "all", "date_from": "2026-09-01", "date_to": "2026-10-01"},
            {"S1", "P1"},
            id="earlier-date-to",
        ),
        pytest.param(
            {"mode": "all"},
            {"mode": "selected", "series": [STANDUP], "meetings": ["K1"]},
            {"S1", "S2", "S3", "K1"},
            id="all-to-selected",
        ),
    ],
)
async def test_narrowing_deletes_what_falls_outside(
    fake, connector, tenant_id, alice, conn, before, after, kept
):
    """Owner, 2026-10-19 and 2026-10-20: narrowing a source deletes what was already
    pulled in and now falls outside it, taking effect on save as far as stored items show
    (the date range), the rest on the next sync."""
    async with client_for(alice) as a:
        resp = await a.post(
            "/v1/sources",
            json={
                "kind": "fireflies",
                "name": "Meetings",
                "connection_id": str(conn),
                "config": before,
            },
        )
        assert resp.status_code == 201, resp.text
        source_id = resp.json()["id"]
        for _ in range(2):  # a full pass, then an incremental one
            sync = (await a.post(f"/v1/sources/{source_id}/sync")).json()
            assert sync["outcome"] == "completed", sync
        stored = {i for i, live in (await _items(tenant_id, source_id)).items() if live}
        assert kept < stored

        resp = await patch_source(a, source_id, {"config": after})
        assert resp.status_code == 200, resp.text
        # On save (owner 2026-10-20) what the date range leaves out; the picks, which only
        # Fireflies can tell, on the next sync's full pass.
        saved = {i for i, live in (await _items(tenant_id, source_id)).items() if live}
        assert kept <= saved
        if all(after.get(k) == before.get(k) for k in ("mode", "series", "meetings")):
            assert saved == kept
        sync = (await a.post(f"/v1/sources/{source_id}/sync")).json()
        assert sync["outcome"] == "completed", sync
        assert sync["deleted"] == len(saved - kept)
        items = await _items(tenant_id, source_id)
        assert {i for i, live in items.items() if live} == kept
        assert {i for i, live in items.items() if not live} == stored - kept
        # Deleted, not purged: citations to them can still say "source removed".
        assert set(items) == stored

        # The source's item list no longer shows them.
        resp = await a.get(f"/v1/sources/{source_id}/items")
        assert resp.status_code == 200, resp.text
        assert {i["external_id"] for i in resp.json()} == kept


def _position(cursor):
    """A saved cursor without the engine's fingerprint of the selection."""
    return {k: v for k, v in (cursor or {}).items() if k != SCOPE_KEY}


async def _change_source(tenant_id, source_id, alice, what: str) -> None:
    """What another request does while a sync runs (oracle.sources.service.update_source
    resets the cursor; a reconnect changes the connection's account)."""
    other = None
    if what == "connection":
        other = await make_connection(
            tenant_id, alice, "fireflies", credential={"access_token": API_KEY}
        )
    async with tenant_session(tenant_id) as s:
        source = await s.get(Source, source_id)
        if what == "config":
            source.config = {"mode": "selected", "meetings": ["K1"]}
            source.cursor = None
        elif what == "connection":
            source.connection_id = other
            source.cursor = None
        else:
            conn = await s.get(Connection, source.connection_id)
            conn.account_id = "another-fireflies-account"
        await s.commit()


@pytest.mark.parametrize("what", ["config", "connection", "account"])
async def test_a_sync_saves_no_cursor_once_its_source_changed(
    fake, connector, monkeypatch, tenant_id, alice, conn, what
):
    """A sync that started before the source's config or connection changed must not
    save its cursor (or anything after its last checkpoint) under the new one."""
    async with client_for(alice) as a:
        resp = await a.post(
            "/v1/sources",
            json={
                "kind": "fireflies",
                "name": "Meetings",
                "connection_id": str(conn),
                "config": {"mode": "all"},
            },
        )
        assert resp.status_code == 201, resp.text
        source_id = uuid.UUID(resp.json()["id"])

        original = connector.sync
        raced = []

        async def racing(config, credential, cursor, **kw):
            async for event in original(config, credential, cursor, **kw):
                if not raced:
                    raced.append(1)
                    await _change_source(tenant_id, source_id, alice, what)
                yield event

        monkeypatch.setattr(connector, "sync", racing)
        sync = (await a.post(f"/v1/sources/{source_id}/sync")).json()
        assert sync["outcome"] == "superseded", sync
        async with tenant_session(tenant_id) as s:
            source = await s.get(Source, source_id)
            # No position saved: at most the fingerprint the sync stamped when it started.
            assert not _position(source.cursor)
            assert source.last_synced_at is None
        assert await _items(tenant_id, source_id) == {}

        # The next sync runs under the new config and connection, from the start.
        monkeypatch.setattr(connector, "sync", original)
        sync = (await a.post(f"/v1/sources/{source_id}/sync")).json()
        assert sync["outcome"] == "completed", sync
        expected = {"K1"} if what == "config" else {m["id"] for m in SAMPLE}
        assert set(await _items(tenant_id, source_id)) == expected


# --- Safety -------------------------------------------------------------------------


@pytest.mark.parametrize("path", ["meetings", "series"])
async def test_an_out_of_range_date_is_a_422(fake, alice, conn, path):
    async with client_for(alice) as a:
        resp = await a.get(f"/v1/connections/{conn}/fireflies/{path}", params={"to": "9999-12-31"})
    assert resp.status_code == 422, resp.text
    assert fake.requests == []


@pytest.mark.parametrize(
    "config",
    [
        {"mode": "all", "date_to": "9999-12-31"},
        {"mode": "all", "date_from": 5},
        {"mode": "all", "date_from": True},
        {"mode": "all", "labels": {f"m{i}": "x" for i in range(MAX_LABELS + 1)}},
        {"mode": "all", "labels": {"m1": "x" * (MAX_LABEL + 1)}},
        {"mode": "all", "labels": {"m" * (MAX_SERIES_KEY + 1): "x"}},
        {"mode": "selected", "series": ["cal:" + "x" * (MAX_SERIES_KEY - 3)]},
        {"mode": "selected", "meetings": ["m" * (MAX_MEETING_ID + 1)]},
    ],
)
async def test_a_source_with_a_bad_date_or_too_many_labels_is_a_422(
    fake, connector, alice, conn, config
):
    async with client_for(alice) as a:
        resp = await a.post(
            "/v1/sources",
            json={"kind": "fireflies", "name": "Bad", "connection_id": str(conn), "config": config},
        )
    assert resp.status_code == 422, resp.text


async def test_the_browse_502_is_redacted(fake, alice, conn):
    fake.error = httpx.Response(
        200, json={"errors": [{"message": f"internal error for key {API_KEY}"}]}
    )
    async with client_for(alice) as a:
        resp = await a.get(f"/v1/connections/{conn}/fireflies/meetings")
    assert resp.status_code == 502
    assert API_KEY not in resp.text


async def test_a_browse_that_gets_no_list_is_a_502(fake, alice, conn):
    fake.error = httpx.Response(200, text="<html>maintenance</html>")
    async with client_for(alice) as a:
        resp = await a.get(f"/v1/connections/{conn}/fireflies/series")
    assert resp.status_code == 502


async def _connection_status(user, conn) -> str:
    async with client_for(user) as c:
        rows = (await c.get("/v1/connections")).json()
    return next(r["status"] for r in rows if r["id"] == str(conn))


async def test_forbidden_on_browse_does_not_expire_the_connection(fake, alice, conn):
    fake.error = httpx.Response(
        200,
        json={
            "errors": [
                {
                    "message": "You do not have access to this resource",
                    "extensions": {"code": "forbidden", "status": 403},
                }
            ]
        },
    )
    async with client_for(alice) as a:
        resp = await a.get(f"/v1/connections/{conn}/fireflies/meetings")
    assert resp.status_code == 409, resp.text
    assert "reconnect" not in resp.json()["detail"].lower()
    assert await _connection_status(alice, conn) == "active"

    # A rejected key still does.
    fake.error = httpx.Response(401, json={"errors": [{"message": "Invalid API key"}]})
    async with client_for(alice) as a:
        resp = await a.get(f"/v1/connections/{conn}/fireflies/meetings")
    assert resp.status_code == 409
    assert await _connection_status(alice, conn) == "expired"


async def test_a_full_pass_on_a_broken_answer_keeps_the_items(
    fake, connector, tenant_id, alice, conn
):
    async with client_for(alice) as a:
        resp = await a.post(
            "/v1/sources",
            json={
                "kind": "fireflies",
                "name": "All",
                "connection_id": str(conn),
                "config": {"mode": "all"},
            },
        )
        source_id = resp.json()["id"]
        assert (await a.post(f"/v1/sources/{source_id}/sync")).json()["outcome"] == "completed"
        # A config change makes the next sync a full pass, which prunes.
        resp = await patch_source(
            a, source_id, {"config": {"mode": "all", "date_from": "2026-01-01"}}
        )
        assert resp.status_code == 200, resp.text
        for broken in (
            httpx.Response(200, text="<html>maintenance</html>"),
            httpx.Response(200, json={"data": {"transcripts": None}}),
        ):
            fake.error = broken
            sync = (await a.post(f"/v1/sources/{source_id}/sync")).json()
            assert sync["outcome"] == "error", sync
            assert sync["deleted"] == 0
            assert all((await _items(tenant_id, source_id)).values())


# --- Cost: cache and per-connection limit ---------------------------------------------


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def clock(monkeypatch):
    clock = Clock()
    monkeypatch.setattr(fireflies_browse, "_clock", clock)
    start = datetime(2026, 10, 20, tzinfo=UTC)
    monkeypatch.setattr(
        fireflies_browse, "_now", lambda: start + timedelta(seconds=clock.now), raising=False
    )
    return clock


async def test_answers_are_cached_for_a_minute(fake, alice, conn, clock):
    url = f"/v1/connections/{conn}/fireflies/meetings"
    async with client_for(alice) as a:
        first = await a.get(url, params={"search": "standup"})
        assert first.status_code == 200
        calls = len(fake.requests)
        clock.now += 30
        again = await a.get(url, params={"search": "standup"})
        assert again.json() == first.json()
        assert len(fake.requests) == calls
        # Other parameters are another answer.
        await a.get(url, params={"search": "planning"})
        assert len(fake.requests) == calls + 1
        clock.now += 31
        await a.get(url, params={"search": "standup"})
        assert len(fake.requests) == calls + 2

        series = f"/v1/connections/{conn}/fireflies/series"
        await a.get(series)
        calls = len(fake.requests)
        await a.get(series)
        assert len(fake.requests) == calls


async def test_a_looping_client_is_limited_per_connection(fake, tenant_id, alice, conn, clock):
    url = f"/v1/connections/{conn}/fireflies/meetings"
    statuses = []
    async with client_for(alice) as a:
        for i in range(200):
            resp = await a.get(url, params={"search": f"loop {i}"})
            statuses.append(resp.status_code)
        assert len(fake.requests) <= fireflies_browse.CALLS_PER_MINUTE
        limited = await a.get(url, params={"search": "one more"})
        assert limited.status_code == 429
        assert 0 < int(limited.headers["Retry-After"]) <= 60
        assert limited.json()["detail"].startswith("Fireflies limit reached, try later")
        # Cached answers are still served.
        assert (await a.get(url, params={"search": "loop 0"})).status_code == 200

        # Another connection of the same person has its own budget.
        other = await make_connection(
            tenant_id, alice, "fireflies", credential={"access_token": API_KEY}
        )
        resp = await a.get(f"/v1/connections/{other}/fireflies/meetings")
        assert resp.status_code == 200, resp.text

        # A minute later, the connection may call Fireflies again, up to the daily cap.
        clock.now += 61
        assert (await a.get(url, params={"search": "later"})).status_code == 200
        for i in range(400):
            clock.now += 60
            await a.get(url, params={"search": f"slow {i}"})
        # All within a day: the daily cap holds (+1: the other connection).
        assert len(fake.requests) <= fireflies_browse.CALLS_PER_DAY + 1
        limited = await a.get(url, params={"search": "tomorrow"})
        assert limited.status_code == 429
        assert int(limited.headers["Retry-After"]) > 3600
        assert "hours" in limited.json()["detail"]
    assert statuses.count(200) <= fireflies_browse.CALLS_PER_MINUTE


async def test_the_budget_is_shared_by_every_api_process(fake, alice, conn, clock):
    """Counted in the database: a process that never saw the earlier calls (an empty
    in-memory cache) still finds the connection's budget spent."""
    url = f"/v1/connections/{conn}/fireflies/meetings"
    async with client_for(alice) as a:
        for i in range(fireflies_browse.CALLS_PER_MINUTE):
            clock.now += 61
            assert (await a.get(url, params={"search": f"s{i}"})).status_code == 200
        for i in range(fireflies_browse.CALLS_PER_DAY):
            fireflies_browse.reset_limits()  # another API process
            clock.now += 61
            await a.get(url, params={"search": f"t{i}"})
        assert len(fake.requests) == fireflies_browse.CALLS_PER_DAY
        fireflies_browse.reset_limits()
        clock.now += 61
        assert (await a.get(url, params={"search": "s0"})).status_code == 429


async def test_a_low_plans_daily_quota_survives_a_browsing_session(fake, alice, conn, clock):
    """The lower Fireflies plans allow 50 API calls a day: one browsing session (series
    lists and pages of meetings, as fast as a client can ask) leaves half to syncs."""
    async with client_for(alice) as a:
        for i in range(100):
            clock.now += 5
            await a.get(
                f"/v1/connections/{conn}/fireflies/series",
                params={"from": f"2026-01-{1 + i % 28:02d}"},
            )
            await a.get(
                f"/v1/connections/{conn}/fireflies/meetings", params={"cursor": str(i * 50)}
            )
    assert len(fake.requests) <= 25
    assert fireflies_browse.CALLS_PER_DAY <= 25


async def test_a_cached_answer_is_not_served_once_the_connection_is_unusable(
    fake, tenant_id, alice, conn, clock
):
    url = f"/v1/connections/{conn}/fireflies/meetings"
    async with client_for(alice) as a:
        assert (await a.get(url)).status_code == 200
        async with tenant_session(tenant_id) as s:
            row = await s.get(Connection, conn)
            row.status = "expired"
            await s.commit()
        resp = await a.get(url)
        assert resp.status_code == 409, resp.text
        assert "reconnect" in resp.json()["detail"]


async def test_one_search_is_one_cache_entry(fake, alice, conn, clock):
    url = f"/v1/connections/{conn}/fireflies/meetings"
    async with client_for(alice) as a:
        assert (await a.get(url, params={"search": "standup"})).status_code == 200
        assert (await a.get(url, params={"search": "  standup "})).status_code == 200
        assert (await a.get(url, params={"search": "   "})).status_code == 200
        assert (await a.get(url, params={"search": ""})).status_code == 200
    assert len(fake.list_variables()) == 2


@pytest.fixture
def local_runtime():
    """Run tokens from any address, as in tests/test_mcp.py."""
    from oracle.swarm import FakeRuntime, set_runtime

    set_runtime(FakeRuntime())
    yield
    set_runtime(None)


async def test_run_tokens_cannot_browse_a_connection(
    fake, tenant_id, alice, conn, clock, local_runtime
):
    """A run's token acts for the run, not for the person: it may not spend their
    Fireflies quota, through REST or MCP."""
    from tests.test_mcp import mcp_client, run_token, text_of

    token = await run_token(tenant_id, ["read:sources", "read:documents"], alice.id)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
        headers={"Authorization": f"Bearer {token}"},
    ) as rest:
        for path in ("meetings", "series"):
            resp = await rest.get(f"/v1/connections/{conn}/fireflies/{path}")
            # Run tokens are for Oracle's MCP server only: REST does not know them.
            assert resp.status_code == 401, resp.text
    async with mcp_client(token) as c:
        names = {t.name for t in (await c.list_tools()).tools}
        assert names.isdisjoint({"list_fireflies_meetings", "list_fireflies_series"})
        for tool in ("list_fireflies_meetings", "list_fireflies_series"):
            refused = await c.call_tool(tool, {"connection_id": str(conn)})
            assert refused.is_error and "not available to run tokens" in text_of(refused)
    assert fake.requests == []


async def test_series_counts_cover_the_whole_window(fake, alice, conn, clock):
    """Issue #252: a series counts every meeting of the From/To window, not the newest
    page: each page read is one call from the browse budget."""
    fake.meetings = [
        meeting(
            f"W{i}",
            "Weekly sync",
            (datetime(2026, 10, 1, 9, tzinfo=UTC) - timedelta(hours=i)).isoformat(),
            calendar_id="weeklycal1",
        )
        for i in range(280)
    ]
    async with client_for(alice) as a:
        resp = await a.get(f"/v1/connections/{conn}/fireflies/series")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["truncated"] is False
    assert body["scanned"] == 280
    assert body["series"][0]["meeting_count"] == 280
    assert len(fake.requests) == 6


def _large_window() -> list[dict]:
    return [
        meeting(f"M{i}", f"Meeting {i}", f"2026-{1 + i % 9:02d}-{1 + i % 28:02d}T09:00:00Z")
        for i in range(1000)
    ]


async def test_the_series_list_stops_at_six_pages_and_a_search_still_answers(
    fake, alice, conn, clock
):
    """Owner, review of #284: a series list reads at most 6 pages (the newest 300
    meetings), so it leaves the minute's budget to Search and Load more, and a date
    change or two do not use up the day."""
    fake.meetings = _large_window()
    async with client_for(alice) as a:
        resp = await a.get(f"/v1/connections/{conn}/fireflies/series")
        assert resp.status_code == 200, resp.text
        assert resp.json()["truncated"] is True
        assert resp.json()["scanned"] == 300
        assert len(fake.requests) == 6
        search = await a.get(
            f"/v1/connections/{conn}/fireflies/meetings", params={"search": "Meeting 7"}
        )
        assert search.status_code == 200, search.text
        more = await a.get(f"/v1/connections/{conn}/fireflies/meetings", params={"cursor": "50"})
        assert more.status_code == 200, more.text

        # Two date changes later, a search still answers the same day.
        for day in ("2026-02-01", "2026-03-01"):
            clock.now += 61
            changed = await a.get(f"/v1/connections/{conn}/fireflies/series", params={"from": day})
            assert changed.status_code == 200, changed.text
        search = await a.get(
            f"/v1/connections/{conn}/fireflies/meetings", params={"search": "Meeting 8"}
        )
        assert search.status_code == 200, search.text


async def test_the_series_list_stops_at_the_browse_budget(fake, alice, conn, clock):
    fake.meetings = _large_window()
    async with client_for(alice) as a:
        for i in range(fireflies_browse.CALLS_PER_MINUTE - 3):
            resp = await a.get(
                f"/v1/connections/{conn}/fireflies/meetings", params={"search": f"s{i}"}
            )
            assert resp.status_code == 200
        resp = await a.get(f"/v1/connections/{conn}/fireflies/series")
    assert resp.status_code == 200
    assert resp.json()["truncated"] is True
    assert resp.json()["scanned"] == 3 * 50
    assert len(fake.requests) == fireflies_browse.CALLS_PER_MINUTE


async def test_a_series_lists_same_title_meetings_outside_it(fake, alice, conn):
    """Issue #252: a reschedule or one-off copy with the series' title is not in the
    series; the list names them so the picker can offer to tick them too."""
    fake.meetings = [
        *SAMPLE,
        meeting("X1", "AI agents sprint planning", "2026-10-06T17:00:00Z"),
        meeting(
            "X2", "AI Agents Sprint Planning #12", "2026-09-20T17:00:00Z", calendar_id="other9"
        ),
        meeting("X3", "AI agents sprint planning retro", "2026-10-07T17:00:00Z"),
    ]
    async with client_for(alice) as a:
        resp = await a.get(f"/v1/connections/{conn}/fireflies/series")
        assert resp.status_code == 200, resp.text
        series = {s["key"]: s for s in resp.json()["series"]}
        same = series[PLANNING]["same_title"]
        assert [m["id"] for m in same] == ["X1", "X2"]
        assert same[0] == {
            "id": "X1",
            "title": "AI agents sprint planning",
            "date": "2026-10-06T17:00:00Z",
        }
        assert series[STANDUP]["same_title"] == []
        # Only the From/To window counts.
        resp = await a.get(
            f"/v1/connections/{conn}/fireflies/series", params={"from": "2026-10-01"}
        )
        series = {s["key"]: s for s in resp.json()["series"]}
        assert [m["id"] for m in series[PLANNING]["same_title"]] == ["X1"]


async def test_mcp_clients_acting_as_the_person_can_browse(fake, tenant_id, alice, conn, clock):
    """Owner, 2026-10-19: the browse lists are open to MCP clients acting as the person."""
    from tests.test_mcp import mcp_client, user_token

    token = await user_token(tenant_id, alice)
    async with mcp_client(token) as c:
        meetings = await c.call_tool("list_fireflies_meetings", {"connection_id": str(conn)})
        assert not meetings.is_error, meetings
        assert [m["id"] for m in meetings.structured_content["meetings"]][:2] == ["P2", "S3"]
        series = await c.call_tool("list_fireflies_series", {"connection_id": str(conn)})
        assert not series.is_error, series


# --- Round 4: what a sync starts from, its failures, odd answers ----------------------


async def _source(a, conn, config=None) -> uuid.UUID:
    resp = await a.post(
        "/v1/sources",
        json={
            "kind": "fireflies",
            "name": "Meetings",
            "connection_id": str(conn),
            "config": config or {"mode": "all"},
        },
    )
    assert resp.status_code == 201, resp.text
    return uuid.UUID(resp.json()["id"])


def _recording(connector, monkeypatch) -> list[dict]:
    """The connector's sync calls (config, credential, cursor), as it received them."""
    calls: list[dict] = []
    original = connector.sync

    async def recorded(config, credential, cursor, **kw):
        calls.append({"config": config, "credential": credential, "cursor": cursor})
        async for event in original(config, credential, cursor, **kw):
            yield event

    monkeypatch.setattr(connector, "sync", recorded)
    return calls


async def test_a_connection_switch_before_the_sync_starts_is_superseded(
    fake, connector, monkeypatch, tenant_id, alice, conn
):
    """The router loads the source, another request switches its connection (and resets
    the cursor), then the sync starts: it must not run the old account's position (the
    loaded row's cursor) under the new connection."""
    from oracle.sources import router as sources_router

    async with client_for(alice) as a:
        source_id = await _source(a, conn)
        assert (await a.post(f"/v1/sources/{source_id}/sync")).json()["outcome"] == "completed"
        async with tenant_session(tenant_id) as s:
            assert (await s.get(Source, source_id)).cursor is not None

        calls = _recording(connector, monkeypatch)
        loaded = sources_router._owned

        async def owned_then_switched(db, principal, sid, **kw):
            source = await loaded(db, principal, sid, **kw)
            await _change_source(tenant_id, sid, alice, "connection")
            return source

        monkeypatch.setattr(sources_router, "_owned", owned_then_switched)
        sync = (await a.post(f"/v1/sources/{source_id}/sync")).json()
        assert sync["outcome"] == "superseded", sync
        # Nothing ran with the old cursor, and none was saved.
        assert calls == []
        async with tenant_session(tenant_id) as s:
            source = await s.get(Source, source_id)
            # No position saved: at most the fingerprint the sync stamped when it started.
            assert not _position(source.cursor)
            assert source.connection_id != conn
            new_conn = source.connection_id

        # The next sync runs the new connection from the start.
        monkeypatch.setattr(sources_router, "_owned", loaded)
        sync = (await a.post(f"/v1/sources/{source_id}/sync")).json()
        assert sync["outcome"] == "completed", sync
        assert len(calls) == 1 and calls[0]["cursor"] is None
        async with tenant_session(tenant_id) as s:
            source = await s.get(Source, source_id)
            assert source.connection_id == new_conn and source.cursor is not None


async def test_the_sync_runs_what_the_database_holds_at_its_start(
    fake, connector, monkeypatch, tenant_id, alice, conn
):
    """Config, connection and cursor come from one read at the start, not the caller's
    copy: a cursor the database reset is not resurrected by a stale in-memory row."""
    from oracle.sources import router as sources_router

    async with client_for(alice) as a:
        source_id = await _source(a, conn)
        assert (await a.post(f"/v1/sources/{source_id}/sync")).json()["outcome"] == "completed"
        calls = _recording(connector, monkeypatch)
        loaded = sources_router._owned

        async def owned_then_reset(db, principal, sid, **kw):
            source = await loaded(db, principal, sid, **kw)
            async with tenant_session(tenant_id) as s:
                (await s.get(Source, sid)).cursor = None
                await s.commit()
            return source

        monkeypatch.setattr(sources_router, "_owned", owned_then_reset)
        sync = (await a.post(f"/v1/sources/{source_id}/sync")).json()
        assert sync["outcome"] == "completed", sync
        assert calls[0]["cursor"] is None
        assert calls[0]["config"] == {"mode": "all"}


@pytest.mark.parametrize("failure", ["rate_limited", "error", "auth"])
async def test_a_failure_after_the_source_changed_is_superseded(
    fake, connector, monkeypatch, tenant_id, alice, conn, failure
):
    """A sync that fails after the source's connection changed reports superseded and
    writes nothing on the source; a rejected credential marks the connection the sync
    used, not the one the source points at now."""
    async with client_for(alice) as a:
        source_id = await _source(a, conn)

        async def failing(config, credential, cursor, **kw):
            await _change_source(tenant_id, source_id, alice, "connection")
            if failure == "rate_limited":
                raise base.ConnectorRateLimited("slow down", retry_after=30)
            if failure == "auth":
                raise base.ConnectorAuthError("Fireflies rejected the API key")
            raise base.ConnectorError("Fireflies query failed")
            yield  # pragma: no cover

        monkeypatch.setattr(connector, "sync", failing)
        sync = (await a.post(f"/v1/sources/{source_id}/sync")).json()
        assert sync["outcome"] == "superseded", sync
        async with tenant_session(tenant_id) as s:
            source = await s.get(Source, source_id)
            assert source.status == "active"
            assert source.last_error is None
            new_conn = await s.get(Connection, source.connection_id)
            old_conn = await s.get(Connection, conn)
            assert new_conn.status == "active"
            assert old_conn.status == ("expired" if failure == "auth" else "active")


async def test_a_rejected_key_marks_the_connection_the_sync_used(
    fake, connector, tenant_id, alice, conn
):
    async with client_for(alice) as a:
        source_id = await _source(a, conn)
        fake.error = httpx.Response(401, json={"errors": [{"message": "bad key"}]})
        sync = (await a.post(f"/v1/sources/{source_id}/sync")).json()
    assert sync["outcome"] == "error", sync
    async with tenant_session(tenant_id) as s:
        assert (await s.get(Source, source_id)).status == "error"
        assert (await s.get(Connection, conn)).status == "expired"


async def test_a_403_on_one_transcript_fails_the_source_not_the_connection(
    fake, connector, tenant_id, alice, conn
):
    fake.forbidden = {"K1"}
    async with client_for(alice) as a:
        source_id = await _source(a, conn)
        sync = (await a.post(f"/v1/sources/{source_id}/sync")).json()
    assert sync["outcome"] == "error", sync
    assert "refused" in sync["error"]
    async with tenant_session(tenant_id) as s:
        source = await s.get(Source, source_id)
        assert source.status == "error"
        assert "refused" in source.last_error
        connection = await s.get(Connection, conn)
        assert connection.status == "active" and connection.last_error is None


@pytest.mark.parametrize(
    "when", ["0001-01-02T00:00:00Z", "0001-01-01T00:00:00Z", "1999-12-31T00:00:00Z"]
)
async def test_a_transcript_dated_near_year_one_is_skipped_not_fatal(
    fake, connector, tenant_id, alice, conn, when
):
    fake.meetings.append(meeting("Y1", "Year one", when))
    async with client_for(alice) as a:
        source_id = await _source(a, conn)
        for _ in range(2):
            sync = (await a.post(f"/v1/sources/{source_id}/sync")).json()
            assert sync["outcome"] == "completed", sync
    items = await _items(tenant_id, source_id)
    assert "Y1" not in items
    assert set(items) == {m["id"] for m in SAMPLE}


async def test_a_cursor_dated_near_year_one_does_not_overflow(
    fake, connector, tenant_id, alice, conn
):
    async with client_for(alice) as a:
        source_id = await _source(a, conn)
        async with tenant_session(tenant_id) as s:
            source = await s.get(Source, source_id)
            source.cursor = {
                "since": "0001-01-02T00:00:00Z",
                "listed": "0001-01-01T00:00:00Z",
                "recent": {"Z1": "0001-01-01T00:00:00Z", "Z2": "not a date"},
            }
            await s.commit()
        sync = (await a.post(f"/v1/sources/{source_id}/sync")).json()
    assert sync["outcome"] == "completed", sync
    assert set(await _items(tenant_id, source_id)) == {m["id"] for m in SAMPLE}


ODD = [
    {**meeting("N1", "x", "2026-10-03T09:00:00Z"), "id": 12345},
    {**meeting("N2", "x", "2026-10-03T10:00:00Z"), "title": {"text": "Weekly"}},
    {**meeting("N3", "x", "2026-10-03T11:00:00Z"), "title": ["Weekly"]},
    {**meeting("N4", "x", "2026-10-03T12:00:00Z"), "id": None},
    {**meeting("N5", "x", "2026-10-03T13:00:00Z"), "calendar_id": "c" * 5000},
]


@pytest.mark.parametrize("path", ["meetings", "series"])
async def test_a_transcript_with_a_non_text_id_or_title_is_skipped_on_browse(
    fake, alice, conn, path
):
    fake.meetings.extend(ODD)
    async with client_for(alice) as a:
        resp = await a.get(f"/v1/connections/{conn}/fireflies/{path}")
    assert resp.status_code == 200, resp.text
    if path == "meetings":
        ids = [m["id"] for m in resp.json()["meetings"]]
        assert set(ids) == {m["id"] for m in SAMPLE} | {"N5"}
        # A calendar id too long to be a series key: the meeting is in no series.
        assert next(m for m in resp.json()["meetings"] if m["id"] == "N5")["series_key"] is None
    else:
        keys = [s["key"] for s in resp.json()["series"]]
        assert all(len(k) <= MAX_SERIES_KEY for k in keys)


async def test_a_transcript_with_a_non_text_id_or_title_is_skipped_on_sync(
    fake, connector, tenant_id, alice, conn
):
    fake.meetings.extend(ODD)
    async with client_for(alice) as a:
        source_id = await _source(a, conn)
        sync = (await a.post(f"/v1/sources/{source_id}/sync")).json()
    assert sync["outcome"] == "completed", sync
    assert set(await _items(tenant_id, source_id)) == {m["id"] for m in SAMPLE} | {"N5"}


@pytest.mark.parametrize(
    "error",
    [
        httpx.ConnectError("connection refused"),
        httpx.ReadTimeout("timed out"),
        httpx.RemoteProtocolError("reset"),
    ],
)
async def test_a_network_error_while_browsing_is_a_fixed_502(alice, conn, error):
    def unreachable(request: httpx.Request) -> httpx.Response:
        raise error

    use_provider_http(unreachable)
    fireflies_browse.reset_limits()
    try:
        async with client_for(alice) as a:
            resp = await a.get(f"/v1/connections/{conn}/fireflies/meetings")
    finally:
        clear_provider_http()
        fireflies_browse.reset_limits()
    assert resp.status_code == 502, resp.text
    assert resp.json()["detail"] == fireflies_browse.UNREACHABLE


async def test_a_full_pick_fits_the_labels_cap(fake, connector, alice, conn):
    """The picker saves a label per pick: the most series and meetings it can pick, each
    labelled, is a valid config."""
    config = {
        "mode": "selected",
        "series": [f"cal:s{i}" for i in range(MAX_SERIES)],
        "meetings": [f"m{i}" for i in range(MAX_MEETINGS)],
    }
    config["labels"] = {k: "A title" for k in config["series"] + config["meetings"]}
    async with client_for(alice) as a:
        resp = await a.post(
            "/v1/sources",
            json={
                "kind": "fireflies",
                "name": "Full",
                "connection_id": str(conn),
                "config": config,
            },
        )
    assert resp.status_code == 201, resp.text


# --- Narrowing takes effect on save, picks included (owner S5, 2026-10-20) --------------


async def _picked(a, conn, config):
    resp = await a.post(
        "/v1/sources",
        json={
            "kind": "fireflies",
            "name": "Meetings",
            "connection_id": str(conn),
            "config": config,
        },
    )
    assert resp.status_code == 201, resp.text
    source = resp.json()
    sync = (await a.post(f"/v1/sources/{source['id']}/sync")).json()
    assert sync["outcome"] == "completed", sync
    return source


async def _save(a, fake, source, config):
    """PATCH the config; what Fireflies was asked for meetings meanwhile."""
    fake.requests.clear()
    resp = await patch_source(a, source["id"], {"config": config})
    assert resp.status_code == 200, resp.text
    return fake.list_variables(), fake.detail_ids()


async def test_unpicking_a_meeting_deletes_it_on_save(fake, connector, tenant_id, alice, conn):
    async with client_for(alice) as a:
        source = await _picked(
            a, conn, {"mode": "selected", "series": [STANDUP], "meetings": ["K1", "P1"]}
        )
        listed, detail = await _save(
            a, fake, source, {"mode": "selected", "series": [STANDUP], "meetings": ["P1"]}
        )
        assert (listed, detail) == ([], [])
        assert await _items(tenant_id, source["id"]) == {
            "S1": True,
            "S2": True,
            "S3": True,
            "P1": True,
            "K1": False,
        }


async def test_unpicking_a_series_deletes_its_meetings_on_save(
    fake, connector, tenant_id, alice, conn
):
    async with client_for(alice) as a:
        source = await _picked(
            a, conn, {"mode": "selected", "series": [STANDUP, PLANNING], "meetings": ["K1"]}
        )
        listed, detail = await _save(
            a, fake, source, {"mode": "selected", "series": [PLANNING], "meetings": ["K1"]}
        )
        assert (listed, detail) == ([], [])
        assert await _items(tenant_id, source["id"]) == {
            "S1": False,
            "S2": False,
            "S3": False,
            "P1": True,
            "P2": True,
            "K1": True,
        }


async def test_a_meeting_picked_alone_stays_when_its_series_is_unpicked(
    fake, connector, tenant_id, alice, conn
):
    async with client_for(alice) as a:
        source = await _picked(
            a, conn, {"mode": "selected", "series": [STANDUP], "meetings": ["S2"]}
        )
        await _save(a, fake, source, {"mode": "selected", "meetings": ["S2"]})
        assert await _items(tenant_id, source["id"]) == {"S1": False, "S2": True, "S3": False}


async def test_items_of_unknown_provenance_not_shown_picked_are_swept(
    fake, connector, tenant_id, alice, conn
):
    """Stored before the provenance existed (the migration's backfill: the meeting id, no
    series): a pick by meeting id still holds; what cannot be shown inside the new picks
    is deleted."""
    async with client_for(alice) as a:
        source = await _picked(
            a, conn, {"mode": "selected", "series": [STANDUP], "meetings": ["K1"]}
        )
        async with tenant_session(tenant_id) as s:
            await s.execute(
                update(SourceItem)
                .where(SourceItem.source_id == source["id"])
                .values(provenance=func.jsonb_build_object("meeting", SourceItem.external_id))
            )
            await s.commit()
        await _save(a, fake, source, {"mode": "selected", "series": [STANDUP], "meetings": ["K1"]})
        # Nothing changed: nothing is swept.
        assert all((await _items(tenant_id, source["id"])).values())
        await _save(a, fake, source, {"mode": "selected", "series": [PLANNING], "meetings": ["K1"]})
        items = await _items(tenant_id, source["id"])
        assert items["K1"] is True
        assert [items[i] for i in ("S1", "S2", "S3")] == [False, False, False]


async def test_a_save_that_does_not_change_the_selection_sweeps_nothing(
    fake, connector, tenant_id, alice, conn
):
    async with client_for(alice) as a:
        source = await _picked(a, conn, {"mode": "selected", "series": [STANDUP]})
        await _save(
            a,
            fake,
            source,
            {"mode": "selected", "series": [STANDUP], "labels": {STANDUP: "Daily standup"}},
        )
        assert all((await _items(tenant_id, source["id"])).values())


async def test_an_edit_is_checked_against_the_row_read_under_the_lock(
    fake, connector, tenant_id, alice, conn
):
    """A request loaded the source, another saved a new config, then this one asks for
    the config it loaded: that is a change from what is stored, and is written."""
    first = {"mode": "all"}
    second = {"mode": "all", "date_from": "2026-10-01"}
    async with client_for(alice) as a:
        source = await _picked(a, conn, first)
    sid = uuid.UUID(source["id"])
    async with tenant_session(tenant_id) as early:
        stale = await early.get(Source, sid)
        assert stale.config == first
        async with tenant_session(tenant_id) as other:
            await service.update_source(other, await other.get(Source, sid), {"config": second})
        await service.update_source(early, stale, {"config": first})
    async with tenant_session(tenant_id) as s:
        assert (await s.get(Source, sid)).config == first


# --- re-reading recent meetings still without a summary (owner 2026-10-26) -------------


def _days_ago(days: float) -> str:
    when = datetime.now(UTC) - timedelta(days=days)
    return when.strftime("%Y-%m-%dT%H:%M:%SZ")


async def _contents(tenant_id, source_id) -> dict[str, str]:
    async with tenant_session(tenant_id) as s:
        rows = await s.execute(
            select(SourceItem.external_id, SourceItemVersion.content)
            .join(SourceItemVersion, SourceItemVersion.id == SourceItem.current_version_id)
            .where(SourceItem.source_id == source_id, SourceItem.deleted_at.is_(None))
        )
        return dict(rows.all())


def _summarised(content: str) -> bool:
    return content.startswith("## Overview\n\nAbout ")


# protects=owner 2026-10-26: Fireflies writes the summary after the transcript, so each
# sync re-reads the meetings of the last 7 days still stored without a summary and stores
# the one it now has; a meeting stored with a summary, or older than 7 days, is not read
# again; fails_when=the 2-day-old meeting keeps no summary after the archive has one, or
# the summarised or 9-day-old meeting is fetched again; no_claim=a later title or speaker
# change of a summarised meeting (owner: not picked up).
async def test_a_sync_rereads_a_recent_meeting_still_without_a_summary(
    fake, connector, tenant_id, alice, conn
):
    fake.meetings = [
        meeting("R2", "Pricing sync", _days_ago(2)),
        meeting("H2", "Hiring sync", _days_ago(2.5)),
        meeting("O9", "Offsite debrief", _days_ago(9)),
    ]
    fake.unsummarised = {"R2", "O9"}
    async with client_for(alice) as a:
        source_id = await _source(a, conn)
        first = (await a.post(f"/v1/sources/{source_id}/sync")).json()
        assert first["outcome"] == "completed", first
        stored = await _contents(tenant_id, source_id)
        assert {i: _summarised(c) for i, c in stored.items()} == {
            "R2": False,
            "H2": True,
            "O9": False,
        }

        # Fireflies has written both summaries since.
        fake.unsummarised = set()
        fake.requests.clear()
        second = (await a.post(f"/v1/sources/{source_id}/sync")).json()
    assert second["outcome"] == "completed", second
    assert fake.detail_ids() == ["R2"]
    stored = await _contents(tenant_id, source_id)
    assert stored["R2"].startswith("## Overview\n\nAbout Pricing sync.")
    assert not _summarised(stored["O9"])
    assert _summarised(stored["H2"])


# protects=owner 2026-10-26: re-reads count against the same limits and never starve new
# meetings: a new meeting is fetched before any re-read, so with room for one transcript
# the new one is stored and the re-read waits for the next sync; fails_when=the re-read
# goes first (the new meeting is not stored) or a rate-limited re-read loses the new
# meeting; no_claim=how long the next sync waits (oracle.sources.background).
async def test_new_meetings_come_before_rereads_when_the_budget_is_tight(
    fake, connector, tenant_id, alice, conn
):
    fake.meetings = [meeting("R2", "Pricing sync", _days_ago(2))]
    fake.unsummarised = {"R2"}
    async with client_for(alice) as a:
        source_id = await _source(a, conn)
        first = (await a.post(f"/v1/sources/{source_id}/sync")).json()
        assert first["outcome"] == "completed", first

        fake.unsummarised = set()
        fake.meetings.append(meeting("N1", "Launch check-in", _days_ago(1)))
        fake.requests.clear()
        fake.detail_budget = 1
        tight = (await a.post(f"/v1/sources/{source_id}/sync")).json()
        assert tight["outcome"] == "rate_limited", tight
        assert fake.detail_ids() == ["N1", "R2"]
        stored = await _contents(tenant_id, source_id)
        assert _summarised(stored["N1"])
        assert not _summarised(stored["R2"])

        fake.detail_budget = None
        fake.requests.clear()
        later = (await a.post(f"/v1/sources/{source_id}/sync")).json()
    assert later["outcome"] == "completed", later
    assert fake.detail_ids() == ["R2"]
    assert _summarised((await _contents(tenant_id, source_id))["R2"])


# protects=participants in the sync: the people who spoke (speakers[].name, asked for in
# the transcript query) then participants then meeting_attendees, de-duplicated in order;
# fails_when=the query does not ask for speakers or the stored acl drops them;
# no_claim=who can see the item (a source's items are its owner's, S3).
async def test_a_synced_meeting_records_speakers_and_invitees(
    fake, connector, tenant_id, alice, conn
):
    fake.meetings = [
        meeting("K7", "Kickoff", _days_ago(1), participants=["ada@example.com", "lin@x.io"])
    ]
    async with client_for(alice) as a:
        source_id = await _source(a, conn)
        sync = (await a.post(f"/v1/sources/{source_id}/sync")).json()
    assert sync["outcome"] == "completed", sync
    async with tenant_session(tenant_id) as s:
        item = await s.scalar(select(SourceItem).where(SourceItem.source_id == source_id))
    assert item.acl == {"participants": ["Ada", "ada@example.com", "lin@x.io"]}
