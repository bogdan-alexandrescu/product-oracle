"""The Notion page picker's browse API, and Notion sources made the way the web UI makes them.

Notion is mocked on an httpx.MockTransport (tests/fixtures/connectors/notion); no network.
"""

import json

import httpx
import pytest

from oracle.auth.service import create_api_token
from oracle.connections import notion_pages
from oracle.connections import service as connections_service
from oracle.connections.models import Connection
from oracle.mcp import scopes
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


@pytest.fixture(autouse=True)
def fresh_throttle():
    notion_pages._browses.clear()
    yield
    notion_pages._browses.clear()


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


async def test_notion_source_from_the_ui_syncs(client, alice, notion_conn, notion_connector):
    # "roots" is what the picker saves.
    created = await client.post(
        "/v1/sources",
        headers=alice.headers,
        json={
            "kind": "notion",
            "name": "Handbook",
            "connection_id": str(notion_conn.id),
            "config": {"roots": [ROOT]},
        },
    )
    assert created.status_code == 201, created.text
    synced = await client.post(f"/v1/sources/{created.json()['id']}/sync", headers=alice.headers)
    assert synced.status_code == 200, synced.text
    out = synced.json()
    assert out["outcome"] == "completed", out
    assert out["upserted"] == len({ROOT, CHILD, ROW1, ROW2, GRAND})
    assert out["source"]["last_error"] is None


async def test_narrowing_a_notion_source_deletes_pages_outside_it(
    client, alice, notion_conn, notion_connector
):
    # Owner decision S5: narrowing a source deletes what now falls outside it on the next
    # sync. Roots CHILD (with GRAND under it) and DB (rows ROW1, ROW2); then untick DB.
    created = await client.post(
        "/v1/sources",
        headers=alice.headers,
        json={
            "kind": "notion",
            "name": "Handbook",
            "connection_id": str(notion_conn.id),
            "config": {"roots": [CHILD, DB]},
        },
    )
    assert created.status_code == 201, created.text
    sid = created.json()["id"]
    first = await client.post(f"/v1/sources/{sid}/sync", headers=alice.headers)
    assert first.json()["upserted"] == len({CHILD, GRAND, ROW1, ROW2}), first.text

    patched = await client.patch(
        f"/v1/sources/{sid}", headers=alice.headers, json={"config": {"roots": [CHILD]}}
    )
    assert patched.status_code == 200, patched.text
    second = await client.post(f"/v1/sources/{sid}/sync", headers=alice.headers)
    assert second.json()["outcome"] == "completed", second.text
    assert second.json()["deleted"] == 2

    items = (
        await client.get(
            f"/v1/sources/{sid}/items", params={"include_deleted": "true"}, headers=alice.headers
        )
    ).json()
    deleted = {i["external_id"]: i["deleted_at"] is not None for i in items}
    assert deleted == {CHILD: False, GRAND: False, ROW1: True, ROW2: True}


async def test_the_old_pages_key_is_refused_naming_roots(
    client, alice, notion_conn, notion_connector
):
    resp = await client.post(
        "/v1/sources",
        headers=alice.headers,
        json={
            "kind": "notion",
            "name": "Handbook",
            "connection_id": str(notion_conn.id),
            "config": {"pages": [ROOT]},
        },
    )
    assert resp.status_code in (400, 422), resp.text
    assert '"roots"' in resp.json()["detail"]


# --- Review fixes, round 2 ----------------------------------------------------------------


async def test_browsing_reads_the_credential_with_the_row_locked(
    client, alice, notion_conn, notion_http, monkeypatch
):
    locked: list[bool] = []
    get_own = connections_service.get_own

    async def spy(session, connection_id, user_id, *, lock=False):
        locked.append(lock)
        return await get_own(session, connection_id, user_id, lock=lock)

    monkeypatch.setattr(connections_service, "get_own", spy)
    resp = await client.get(pages_url(notion_conn), headers=alice.headers)
    assert resp.status_code == 200, resp.text
    assert locked == [True]


async def test_a_missing_capability_does_not_expire_the_connection(
    client, tenant_id, alice, notion_conn
):
    use_provider_http(
        lambda r: httpx.Response(
            403,
            json={"object": "error", "status": 403, "code": "restricted_resource", "message": "x"},
        )
    )
    try:
        resp = await client.get(pages_url(notion_conn), headers=alice.headers)
    finally:
        clear_provider_http()
    assert resp.status_code == 409
    assert resp.json()["detail"] == "Notion refused: the integration lacks a capability"
    async with tenant_session(tenant_id) as s:
        row = await s.get(Connection, notion_conn.id)
        assert row.status == "active"


async def test_malformed_results_are_skipped_not_a_500(client, alice, notion_conn):
    good = fixture("search_roadmap.json")["results"][0]
    body = {
        "object": "list",
        "results": [
            {"object": "page", "properties": {}},  # no id
            {**good, "icon": {"type": "emoji", "emoji": 5}},  # fails NotionPageOut
            {**good, "last_edited_time": "yesterday"},
            good,
        ],
        "has_more": False,
        "next_cursor": None,
    }
    use_provider_http(lambda r: httpx.Response(200, json=body))
    try:
        resp = await client.get(pages_url(notion_conn), headers=alice.headers)
        use_provider_http(lambda r: httpx.Response(200, json=["not", "an", "object"]))
        odd = await client.get(pages_url(notion_conn), headers=alice.headers)
    finally:
        clear_provider_http()
    assert resp.status_code == 200, resp.text
    assert [i["title"] for i in resp.json()["items"]] == ["Roadmap"]
    assert odd.status_code == 502
    assert odd.json()["detail"] == "Notion did not answer; try again shortly"


async def test_browsing_is_throttled_per_person_and_connection(
    client, tenant_id, alice, bob, notion_conn, notion_http, monkeypatch
):
    monkeypatch.setattr(notion_pages, "BROWSE_LIMIT", 3)
    for _ in range(3):
        ok = await client.get(pages_url(notion_conn), headers=alice.headers)
        assert ok.status_code == 200, ok.text
    limited = await client.get(pages_url(notion_conn), headers=alice.headers)
    assert limited.status_code == 429
    assert 1 <= int(limited.headers["retry-after"]) <= 60
    assert limited.json()["detail"].startswith("Too many Notion page lists")
    # Notion was not called for the refused one.
    assert len(notion_http.requests) == 3

    # Another connection of the same person has its own allowance.
    other = await add_connection(
        tenant_id, alice.id, "notion", bundle={"access_token": TOKEN}, account_id="2"
    )
    assert (await client.get(pages_url(other), headers=alice.headers)).status_code == 200

    # The window slides: once it has passed, lists are allowed again.
    later = notion_pages.time.monotonic() + notion_pages.BROWSE_WINDOW_SECONDS + 1
    monkeypatch.setattr(notion_pages.time, "monotonic", lambda: later)
    assert (await client.get(pages_url(notion_conn), headers=alice.headers)).status_code == 200


def test_run_tokens_may_not_list_notion_pages():
    path = "/v1/connections/{connection_id}/notion/pages"
    assert scopes.required_scope("GET", path) is None
    every_scope = frozenset({*scopes.READ_AREAS, "write:proposals", "write:drafts"})
    assert not scopes.allowed(every_scope, "GET", path)


async def test_service_api_tokens_may_not_list_notion_pages(
    client, tenant_id, notion_conn, notion_http
):
    async with tenant_session(tenant_id) as s:
        _token, raw = await create_api_token(s, "service")
        await s.commit()
    resp = await client.get(pages_url(notion_conn), headers={"Authorization": f"Bearer {raw}"})
    assert resp.status_code == 403
    assert notion_http.requests == []


async def test_a_run_token_is_refused_list_notion_pages_over_mcp(
    tenant_id, alice, notion_conn, notion_http
):
    from tests.test_mcp import mcp_client, run_token, text_of

    token = await run_token(tenant_id, ["read:sources", "read:baseline"], alice.id)
    async with mcp_client(token) as c:
        names = {t.name for t in (await c.list_tools()).tools}
        assert "list_notion_pages" not in names
        refused = await c.call_tool("list_notion_pages", {"connection_id": str(notion_conn.id)})
        assert refused.is_error and "not available to run tokens" in text_of(refused)
    assert notion_http.requests == []


async def test_the_mcp_tool_says_it_lists_every_shared_page(tenant_id, alice):
    from oracle.main import app
    from oracle.mcp.tools import app_operations

    op = next(o for o in app_operations(app) if o.operation_id == "list_notion_pages")
    assert op.excluded is None
    assert "every Notion page" in op.tool_description()
    assert "including pages that are in no source" in op.tool_description()
