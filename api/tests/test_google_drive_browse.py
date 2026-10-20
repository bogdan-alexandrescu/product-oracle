"""The Drive browse list (S5, 'Browse access and narrowing'): the person's Google Docs
and folders through their own Google connection, for the browser and for MCP clients
acting as the person. Owner only, ids checked, the search text escaped, cached and
throttled per person."""

import httpx
import pytest
from sqlalchemy import select

from oracle.auth.models import User
from oracle.auth.service import create_api_token
from oracle.connections import browse_google
from oracle.connections.providers import DRIVE_FILE, DRIVE_READONLY
from oracle.mcp import scopes
from oracle.sources.connectors.google_docs import DOC_MIME, DRIVE_URL, FOLDER_MIME
from oracle.tenancy import tenant_session, unscoped_session
from tests.connection_helpers import (
    add_connection,
    clear_provider_http,
    make_person,
    use_provider_http,
)
from tests.sources_helpers import client_for

READONLY = ["openid", "email", DRIVE_READONLY]
PATH = "/v1/connections/{}/google/files"
FILES = [
    {"id": "1FolderSpecs", "name": "Specs", "mimeType": FOLDER_MIME},
    {
        "id": "1DocPricing0",
        "name": "Pricing",
        "mimeType": DOC_MIME,
        "modifiedTime": "2026-10-01T09:00:00.000Z",
        "webViewLink": "https://docs.google.com/document/d/1DocPricing0/edit",
        "owners": [{"emailAddress": "pat@example.com"}],
    },
]


@pytest.fixture(autouse=True)
def _clean():
    browse_google.reset()
    yield
    browse_google.reset()
    clear_provider_http()


@pytest.fixture
def drive() -> list[httpx.Request]:
    def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url).startswith(DRIVE_URL + "files?")
        return httpx.Response(200, json={"files": FILES, "nextPageToken": "page-2"})

    return use_provider_http(handler)


async def _pat(tenant_id, scopes_=READONLY):
    pat = (await make_person(tenant_id, "pat@example.com")).user
    conn = await add_connection(tenant_id, pat.id, "google", scopes=scopes_)
    return pat, conn


async def test_lists_docs_and_folders(tenant_id, drive):
    pat, conn = await _pat(tenant_id)
    async with client_for(pat) as c:
        resp = await c.get(PATH.format(conn.id), params={"q": "pric"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert [(f["id"], f["kind"]) for f in body["files"]] == [
        ("1FolderSpecs", "folder"),
        ("1DocPricing0", "doc"),
    ]
    assert body["files"][1]["owner"] == "pat@example.com"
    assert body["next_cursor"] == "page-2"
    q = drive[0].url.params["q"]
    assert q == (
        f"trashed = false and (mimeType = '{DOC_MIME}' or mimeType = '{FOLDER_MIME}') "
        "and name contains 'pric'"
    )
    assert drive[0].headers["Authorization"] == "Bearer tok"


async def test_search_text_is_one_escaped_term(tenant_id, drive):
    pat, conn = await _pat(tenant_id)
    text = "x' or sharedWithMe or name contains '\\"
    async with client_for(pat) as c:
        resp = await c.get(PATH.format(conn.id), params={"q": text})
    assert resp.status_code == 200
    q = drive[0].url.params["q"]
    assert q.endswith("name contains 'x\\' or sharedWithMe or name contains \\'\\\\'")


async def test_folder_must_be_a_drive_id(tenant_id, drive):
    pat, conn = await _pat(tenant_id)
    async with client_for(pat) as c:
        for bad in ("root", "root?x=' in parents or sharedWithMe or 'y", "../about"):
            resp = await c.get(PATH.format(conn.id), params={"folder": bad})
            assert resp.status_code == 400, bad
        ok = await c.get(PATH.format(conn.id), params={"folder": "1FolderSpecs"})
    assert ok.status_code == 200
    assert len(drive) == 1
    assert drive[0].url.params["q"].startswith("'1FolderSpecs' in parents and ")


async def test_cached_for_a_minute_and_throttled_per_person(tenant_id, drive, monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(browse_google, "_clock", lambda: now[0])
    monkeypatch.setattr(browse_google, "RATE_LIMIT", 3)
    pat, conn = await _pat(tenant_id)
    async with client_for(pat) as c:
        for _ in range(3):
            assert (await c.get(PATH.format(conn.id), params={"q": "a"})).status_code == 200
        assert len(drive) == 1  # cached
        for q in ("b", "c"):
            assert (await c.get(PATH.format(conn.id), params={"q": q})).status_code == 200
        limited = await c.get(PATH.format(conn.id), params={"q": "d"})
        assert limited.status_code == 429 and limited.headers["Retry-After"]
        # Cached answers stay free while throttled.
        assert (await c.get(PATH.format(conn.id), params={"q": "a"})).status_code == 200
        now[0] += browse_google.RATE_WINDOW + 1
        assert (await c.get(PATH.format(conn.id), params={"q": "d"})).status_code == 200
    assert len(drive) == 4


async def test_owner_only(tenant_id, drive):
    _, conn = await _pat(tenant_id)
    sam = (await make_person(tenant_id, "sam@example.com")).user
    async with client_for(sam) as c:
        resp = await c.get(PATH.format(conn.id))
    assert resp.status_code == 404
    assert drive == []


@pytest.mark.parametrize(("scope", "allowed"), [("oracle:read", False), (None, True)])
async def test_read_only_credentials_are_refused(client, drive, scope, allowed):
    """Browsing only finds ids for a source edit, which a read-only MCP client cannot
    make: it gets 403 and Drive is never asked."""
    from tests.test_oauth import full_flow

    _, tok = await full_flow(client, scope=scope)
    client.cookies.clear()
    async with unscoped_session() as s:
        admin = await s.scalar(select(User).where(User.email == "admin@example.com"))
    conn = await add_connection(admin.tenant_id, admin.id, "google", scopes=READONLY)
    resp = await client.get(
        PATH.format(conn.id), headers={"Authorization": f"Bearer {tok['access_token']}"}
    )
    if allowed:
        assert resp.status_code == 200, resp.text
        assert len(drive) == 1
    else:
        assert resp.status_code == 403
        assert "oracle:read" in resp.json()["detail"]
        assert drive == []


async def test_service_tokens_are_refused(tenant_id, drive):
    _, conn = await _pat(tenant_id)
    async with tenant_session(tenant_id) as s:
        _, raw = await create_api_token(s, "service")
        await s.commit()
    async with client_for(headers={"Authorization": f"Bearer {raw}"}) as c:
        resp = await c.get(PATH.format(conn.id))
    assert resp.status_code == 403
    assert drive == []


def test_run_tokens_cannot_reach_it():
    # A run token's scopes cover sources, baseline and documents, never connections.
    assert scopes.required_scope("GET", "/v1/connections/{connection_id}/google/files") is None
    assert not scopes.allowed(
        frozenset({"read:sources"}), "GET", "/v1/connections/{connection_id}/google/files"
    )


async def test_a_grant_without_drive_readonly_is_asked_to_reconnect(tenant_id, drive):
    pat, conn = await _pat(tenant_id, ["openid", "email", DRIVE_FILE])
    async with client_for(pat) as c:
        resp = await c.get(PATH.format(conn.id))
    assert resp.status_code == 409
    assert "Reconnect to choose files" in resp.json()["detail"]


async def test_an_mcp_tool_describes_what_it_lists():
    from oracle.main import app
    from oracle.mcp.tools import app_operations

    (op,) = [o for o in app_operations(app) if o.operation_id == "list_google_drive_files"]
    assert op.excluded is None
    description = op.tool_description()
    assert "Google Docs and folders in your Google Drive" in description
    assert {p.name for p in op.params} >= {"connection_id", "q", "folder", "cursor"}
