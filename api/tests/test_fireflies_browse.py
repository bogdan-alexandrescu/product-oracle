"""Browsing a Fireflies connection's meetings and series, and syncing a picked source
(S5, owner 2026-10-19). Fireflies is mocked: no network."""

import httpx
import pytest
from sqlalchemy import select

from oracle.sources import base, service
from oracle.sources.connectors.fireflies import FirefliesConnector
from oracle.sources.models import SourceItem
from oracle.tenancy import tenant_session
from tests.connection_helpers import clear_provider_http, use_provider_http
from tests.fireflies_fake import API_KEY, SAMPLE, STANDUP_CAL, FakeFireflies, rate_limited
from tests.sources_helpers import client_for, make_connection, make_user

STANDUP = f"cal:{STANDUP_CAL}"
PLANNING = "title:ai agents sprint planning|lin@x.io"


@pytest.fixture
def fake():
    fake = FakeFireflies(list(SAMPLE))
    use_provider_http(fake)
    yield fake
    clear_provider_http()


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
            "series_key": "title:customer interview: acme|ada@example.com",
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
    assert listed["fromDate"] == "2026-10-01T00:00:00Z"
    assert listed["toDate"] == "2026-10-31T23:59:59.999Z"


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
        resp = await a.patch(
            f"/v1/sources/{source['id']}",
            json={"config": {"mode": "selected", "series": [STANDUP, PLANNING]}},
        )
        assert resp.status_code == 200, resp.text
        fake.requests.clear()
        sync = (await a.post(f"/v1/sources/{source['id']}/sync")).json()
        assert sync["outcome"] == "completed", sync
        assert sync["deleted"] == 1
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
async def test_narrowing_deletes_what_falls_outside_on_the_next_sync(
    fake, connector, tenant_id, alice, conn, before, after, kept
):
    """Owner, 2026-10-19: narrowing a source deletes what was already pulled in and now
    falls outside it on the next sync."""
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

        resp = await a.patch(f"/v1/sources/{source_id}", json={"config": after})
        assert resp.status_code == 200, resp.text
        sync = (await a.post(f"/v1/sources/{source_id}/sync")).json()
        assert sync["outcome"] == "completed", sync
        assert sync["deleted"] == len(stored - kept)
        items = await _items(tenant_id, source_id)
        assert {i for i, live in items.items() if live} == kept
        assert {i for i, live in items.items() if not live} == stored - kept
        # Deleted, not purged: citations to them can still say "source removed".
        assert set(items) == stored

        # The source's item list no longer shows them.
        resp = await a.get(f"/v1/sources/{source_id}/items")
        assert resp.status_code == 200, resp.text
        assert {i["external_id"] for i in resp.json()} == kept


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
        {"mode": "all", "labels": {f"m{i}": "x" for i in range(1001)}},
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
        resp = await a.patch(
            f"/v1/sources/{source_id}", json={"config": {"mode": "all", "date_from": "2026-01-01"}}
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
