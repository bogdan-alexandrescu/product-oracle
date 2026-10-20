"""The Notion page picker's browse API, and Notion sources made the way the web UI makes them.

Notion is mocked on an httpx.MockTransport (tests/fixtures/connectors/notion); no network.
"""

import json

import httpx
import pytest

from oracle.connections.models import Connection
from oracle.sources import base, service
from oracle.sources.connectors.notion import NotionConnector
from oracle.tenancy import tenant_session
from tests.connection_helpers import (
    add_connection,
    clear_provider_http,
    make_person,
    use_provider_http,
)
from tests.connectors.test_notion import (
    CHILD,
    DB,
    GRAND,
    ROOT,
    ROW1,
    ROW2,
    FakeNotion,
    fixture,
    full_routes,
)

TOKEN = "ntn_example"


def search(request: httpx.Request) -> httpx.Response:
    body = json.loads(request.content)
    if body.get("query") == "road":
        return httpx.Response(200, json=fixture("search_roadmap.json"))
    if body.get("start_cursor") == "cursor-search-2":
        return httpx.Response(200, json=fixture("search_2.json"))
    return httpx.Response(200, json=fixture("search_1.json"))


@pytest.fixture
def notion_http():
    fake = FakeNotion({"POST /search": search, "POST /search#cursor-search-2": search})
    use_provider_http(fake)
    yield fake
    clear_provider_http()


@pytest.fixture
async def alice(tenant_id):
    return await make_person(tenant_id, "alice@example.com", "owner")


@pytest.fixture
async def bob(tenant_id):
    return await make_person(tenant_id, "bob@example.com", "owner")


@pytest.fixture
async def notion_conn(tenant_id, alice):
    return await add_connection(
        tenant_id, alice.id, "notion", bundle={"access_token": TOKEN}, label="Example Notion"
    )


def pages_url(conn: Connection) -> str:
    return f"/v1/connections/{conn.id}/notion/pages"


async def test_lists_shared_pages_and_databases_paged(client, alice, notion_conn, notion_http):
    resp = await client.get(pages_url(notion_conn), headers=alice.headers)
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["next_cursor"] == "cursor-search-2"
    assert out["items"][0] == {
        "id": ROOT,
        "type": "page",
        "title": "Product handbook",
        "icon": "📘",
        "parent_type": "workspace",
        "parent_id": None,
        "last_edited_at": "2026-09-02T10:00:00Z",
        "url": "https://www.notion.so/11111111111141118111111111111111",
    }
    assert [(i["id"], i["type"], i["parent_id"]) for i in out["items"]] == [
        (ROOT, "page", None),
        (CHILD, "page", ROOT),
        (DB, "database", ROOT),
    ]
    # The token went to Notion only, never back to the browser.
    assert notion_http.requests == ["POST /search"]
    assert TOKEN not in resp.text

    more = await client.get(
        pages_url(notion_conn), params={"cursor": "cursor-search-2"}, headers=alice.headers
    )
    assert more.status_code == 200, more.text
    assert more.json()["next_cursor"] is None
    assert [i["parent_type"] for i in more.json()["items"]] == ["database", "block"]

    found = await client.get(
        pages_url(notion_conn), params={"search": "road"}, headers=alice.headers
    )
    assert [i["title"] for i in found.json()["items"]] == ["Roadmap"]


async def test_only_the_connection_owner_may_browse(
    client, tenant_id, alice, bob, notion_conn, notion_http
):
    other = await client.get(pages_url(notion_conn), headers=bob.headers)
    assert other.status_code == 404
    missing = await client.get(
        "/v1/connections/00000000-0000-4000-8000-000000000000/notion/pages",
        headers=alice.headers,
    )
    assert missing.status_code == 404
    assert notion_http.requests == []

    github = await add_connection(tenant_id, alice.id, "github")
    wrong = await client.get(pages_url(github), headers=alice.headers)
    assert wrong.status_code == 409
    assert "not a Notion connection" in wrong.json()["detail"]


async def test_rate_limit_is_a_clear_retry_message(client, alice, notion_conn):
    use_provider_http(
        lambda r: httpx.Response(
            429, json=fixture("error_rate_limited.json"), headers={"Retry-After": "20"}
        )
    )
    try:
        resp = await client.get(pages_url(notion_conn), headers=alice.headers)
    finally:
        clear_provider_http()
    assert resp.status_code == 429
    assert resp.headers["retry-after"] == "20"
    assert resp.json()["detail"] == (
        "Notion is limiting requests right now; try again in 20 seconds"
    )


async def test_rejected_token_marks_the_connection_expired(client, tenant_id, alice, notion_conn):
    use_provider_http(lambda r: httpx.Response(401, json=fixture("error_unauthorized.json")))
    try:
        resp = await client.get(pages_url(notion_conn), headers=alice.headers)
        again = await client.get(pages_url(notion_conn), headers=alice.headers)
    finally:
        clear_provider_http()
    assert resp.status_code == 409
    assert "reconnect" in resp.json()["detail"]
    assert TOKEN not in resp.text
    async with tenant_session(tenant_id) as s:
        row = await s.get(Connection, notion_conn.id)
        assert row.status == "expired"
    # Now expired: refused before calling Notion.
    assert again.status_code == 409


async def test_notion_down_is_a_502(client, alice, notion_conn):
    use_provider_http(lambda r: httpx.Response(503, json={"message": "down"}))
    try:
        resp = await client.get(pages_url(notion_conn), headers=alice.headers)
    finally:
        clear_provider_http()
    assert resp.status_code == 502


# --- A Notion source made through the UI's request shape syncs -------------------------


@pytest.fixture
def notion_connector(monkeypatch):
    service.load_connectors()
    fake = FakeNotion(full_routes())
    connector = NotionConnector(client=httpx.AsyncClient(transport=httpx.MockTransport(fake)))
    monkeypatch.setitem(base._registry, "notion", connector)
    return fake


@pytest.mark.parametrize("key", ["roots", "pages"])
async def test_notion_source_from_the_ui_syncs(client, alice, notion_conn, notion_connector, key):
    # "roots" is what the picker saves; "pages" is what the UI saved before it.
    created = await client.post(
        "/v1/sources",
        headers=alice.headers,
        json={
            "kind": "notion",
            "name": "Handbook",
            "connection_id": str(notion_conn.id),
            "config": {key: [ROOT]},
        },
    )
    assert created.status_code == 201, created.text
    synced = await client.post(f"/v1/sources/{created.json()['id']}/sync", headers=alice.headers)
    assert synced.status_code == 200, synced.text
    out = synced.json()
    assert out["outcome"] == "completed", out
    assert out["upserted"] == len({ROOT, CHILD, ROW1, ROW2, GRAND})
    assert out["source"]["last_error"] is None
