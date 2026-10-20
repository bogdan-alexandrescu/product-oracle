"""Google Docs and the Drive picker (S5, 2026-10-19, revised by 'Drive folders'): people
pick files and folders with Google's Drive picker; Oracle keeps read access to the
person's Drive (drive.readonly), so a picked folder syncs every doc in it, now and later.
Only a Google grant without drive.readonly (the short-lived drive.file one) is asked to
reconnect."""

from urllib.parse import parse_qs, urlparse

import httpx
import pytest

from oracle.auth.service import create_api_token
from oracle.config import get_settings
from oracle.connections import oauth
from oracle.connections.providers import (
    DRIVE_FILE,
    DRIVE_READONLY,
    PROVIDERS,
    RECONNECT_TO_CHOOSE_FILES,
)
from oracle.sources import base, service
from oracle.sources.base import CursorCheckpoint, ItemUnavailable
from oracle.tenancy import tenant_session
from tests.connection_helpers import (
    add_connection,
    clear_provider_http,
    make_person,
    use_provider_http,
)
from tests.sources_helpers import FakeConnector, client_for, make_connection, message

CLIENT_ID = "1234-picker.apps.googleusercontent.com"
CLIENT_SECRET = "".join(["GOC", "SPX", "-example-client-secret"])
APP_ID = "123456789012"
API_KEY = "".join(["AI", "za", "Sy", "Example-browser-key"])
# What Oracle asks for, and what connections made before the picker already hold.
READONLY = ["openid", "email", DRIVE_READONLY]
# The drive.file grant the first picker build asked for: it cannot read folders.
FILE_ONLY = ["openid", "email", DRIVE_FILE]
# Example token values, built from pieces so no credential-shaped literal is in the file.
OLD_ACCESS = "".join(["ya", "29", ".old"])
OLD_REFRESH = "".join(["1", "/", "/old"])
USER_ACCESS = "".join(["ya", "29", ".user-token"])
USER_REFRESH = "".join(["1", "/", "/user-refresh"])


@pytest.fixture
def google_oauth(monkeypatch):
    monkeypatch.setenv("ORACLE_OAUTH_GOOGLE_CLIENT_ID", CLIENT_ID)
    monkeypatch.setenv("ORACLE_OAUTH_GOOGLE_CLIENT_SECRET", CLIENT_SECRET)
    monkeypatch.setenv("ORACLE_OAUTH_REDIRECT_BASE", "https://oracle.example.com")
    oauth.get_oauth_settings.cache_clear()
    yield
    oauth.get_oauth_settings.cache_clear()


@pytest.fixture
def picker(monkeypatch, google_oauth):
    monkeypatch.setenv("ORACLE_GOOGLE_PICKER_APP_ID", APP_ID)
    monkeypatch.setenv("ORACLE_GOOGLE_PICKER_API_KEY", API_KEY)
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture(autouse=True)
def _clean():
    yield
    clear_provider_http()
    get_settings.cache_clear()


@pytest.fixture
def docs(monkeypatch):
    service.load_connectors()
    fake = FakeConnector(kind="google_docs")
    monkeypatch.setitem(base._registry, "google_docs", fake)
    return fake


# --- Scope --------------------------------------------------------------------------


def test_google_asks_for_drive_readonly():
    assert PROVIDERS["google"].oauth.scopes == ["openid", "email", DRIVE_READONLY]
    assert DRIVE_READONLY == "https://www.googleapis.com/auth/drive.readonly"


def test_authorize_url_requests_drive_readonly(google_oauth):
    p = PROVIDERS["google"]
    url = oauth.authorize_url(p, oauth.client_for(p), "state", "challenge")
    scope = parse_qs(urlparse(url).query)["scope"][0].split()
    assert scope == ["openid", "email", DRIVE_READONLY]
    assert DRIVE_FILE not in url


async def test_identify_reads_granted_scopes_from_tokeninfo():
    def handler(request):
        if request.url.host == "oauth2.googleapis.com":
            assert request.url.path == "/tokeninfo"
            # The token goes in a POST body, never in a URL (logs, proxies).
            assert request.method == "POST"
            assert "access_token" not in str(request.url)
            assert parse_qs(request.content.decode()) == {"access_token": ["tok"]}
            return httpx.Response(200, json={"scope": " ".join(READONLY)})
        return httpx.Response(200, json={"sub": "g-1", "email": "pat@example.com"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
        identity = await PROVIDERS["google"].identify(c, "tok")
    assert identity.scopes == READONLY


@pytest.mark.parametrize(
    "answer",
    [
        httpx.Response(500),
        httpx.Response(200, text="<html>not json</html>"),
        httpx.Response(200, json=["not", "an", "object"]),
    ],
)
async def test_identify_still_works_when_tokeninfo_fails(answer):
    def handler(request):
        if request.url.host == "oauth2.googleapis.com":
            return answer
        return httpx.Response(200, json={"sub": "g-1", "email": "pat@example.com"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
        identity = await PROVIDERS["google"].identify(c, "tok")
    assert (identity.account_id, identity.scopes) == ("g-1", [])


async def test_only_connections_without_drive_readonly_ask_to_reconnect(client, tenant_id):
    pat = await make_person(tenant_id, "pat@example.com", "viewer")
    readonly = await add_connection(
        tenant_id, pat.id, "google", auth_mode="oauth", account_id="g-ro", scopes=READONLY
    )
    file_only = await add_connection(
        tenant_id, pat.id, "google", auth_mode="oauth", account_id="g-file", scopes=FILE_ONLY
    )
    unknown = await add_connection(tenant_id, pat.id, "google", account_id="g-pasted", scopes=[])
    gh = await add_connection(tenant_id, pat.id, "github", scopes=["repo"])
    resp = await client.get("/v1/connections", headers=pat.headers)
    assert resp.status_code == 200
    by_id = {c["id"]: c for c in resp.json()}
    # Existing drive.readonly connections keep working with no reconnect.
    assert by_id[str(readonly.id)]["reconnect_reason"] is None
    assert by_id[str(file_only.id)]["reconnect_reason"] == RECONNECT_TO_CHOOSE_FILES
    assert RECONNECT_TO_CHOOSE_FILES == "Reconnect to choose files"
    # Scopes Google did not report (a pasted token) are not judged.
    assert by_id[str(unknown.id)]["reconnect_reason"] is None
    assert by_id[str(gh.id)]["reconnect_reason"] is None


async def test_reconnect_without_drive_readonly_signs_in_again(client, tenant_id, google_oauth):
    pat = await make_person(tenant_id, "pat@example.com", "viewer")
    old = await add_connection(
        tenant_id, pat.id, "google", auth_mode="oauth", account_id="g-file", scopes=FILE_ONLY,
        bundle={"access_token": OLD_ACCESS, "refresh_token": OLD_REFRESH},
    )  # fmt: skip
    resp = await client.post(f"/v1/connections/{old.id}/reconnect", headers=pat.headers)
    assert resp.status_code == 200, resp.text
    url = resp.json()["authorize_url"]
    assert url.startswith("https://accounts.google.com/")
    assert DRIVE_READONLY in parse_qs(urlparse(url).query)["scope"][0].split()
    assert oauth.decode_state(parse_qs(urlparse(url).query)["state"][0], "google").connection_id


async def test_reconnect_with_drive_readonly_just_refreshes(client, tenant_id, google_oauth):
    pat = await make_person(tenant_id, "pat@example.com", "viewer")
    conn = await add_connection(
        tenant_id, pat.id, "google", auth_mode="oauth", account_id="g-1", scopes=READONLY,
        bundle={"access_token": OLD_ACCESS, "refresh_token": OLD_REFRESH},
    )  # fmt: skip

    def handler(request):
        if request.url.path == "/token":
            return httpx.Response(200, json={"access_token": USER_ACCESS, "expires_in": 3599})
        if request.url.path == "/tokeninfo":
            return httpx.Response(200, json={"scope": " ".join(READONLY)})
        return httpx.Response(200, json={"sub": "g-1", "email": "pat@example.com"})

    use_provider_http(handler)
    resp = await client.post(f"/v1/connections/{conn.id}/reconnect", headers=pat.headers)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["authorize_url"] is None
    assert body["connection"]["status"] == "active"
    assert body["connection"]["reconnect_reason"] is None


# --- Picker config ------------------------------------------------------------------


async def test_picker_config_for_signed_in_users(client, tenant_id, picker):
    viewer = await make_person(tenant_id, "viewer@example.com", "viewer")
    await add_connection(
        tenant_id, viewer.id, "google", auth_mode="oauth", scopes=READONLY,
        bundle={"access_token": USER_ACCESS, "refresh_token": USER_REFRESH},
    )  # fmt: skip
    resp = await client.get("/v1/connections/google/picker-config", headers=viewer.headers)
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"client_id": CLIENT_ID, "app_id": APP_ID, "developer_key": API_KEY}
    for secret in (CLIENT_SECRET, USER_ACCESS, USER_REFRESH):
        assert secret not in resp.text


async def test_picker_config_needs_a_person(client, tenant_id, picker):
    assert (await client.get("/v1/connections/google/picker-config")).status_code == 401
    async with tenant_session(tenant_id) as s:
        _, raw = await create_api_token(s, "agent")
        await s.commit()
    resp = await client.get(
        "/v1/connections/google/picker-config", headers={"Authorization": f"Bearer {raw}"}
    )
    assert resp.status_code == 403


@pytest.mark.parametrize("missing", ["client", "app_id", "api_key"])
async def test_picker_config_not_configured(client, tenant_id, monkeypatch, missing):
    if missing != "client":
        monkeypatch.setenv("ORACLE_OAUTH_GOOGLE_CLIENT_ID", CLIENT_ID)
        monkeypatch.setenv("ORACLE_OAUTH_GOOGLE_CLIENT_SECRET", CLIENT_SECRET)
    if missing != "app_id":
        monkeypatch.setenv("ORACLE_GOOGLE_PICKER_APP_ID", APP_ID)
    if missing != "api_key":
        monkeypatch.setenv("ORACLE_GOOGLE_PICKER_API_KEY", API_KEY)
    oauth.get_oauth_settings.cache_clear()
    get_settings.cache_clear()
    try:
        pat = await make_person(tenant_id, "pat@example.com", "viewer")
        resp = await client.get("/v1/connections/google/picker-config", headers=pat.headers)
    finally:
        oauth.get_oauth_settings.cache_clear()
    assert resp.status_code == 404
    assert "Choosing files from Drive is not configured" in resp.json()["detail"]
    assert CLIENT_SECRET not in resp.text and API_KEY not in resp.text


def test_picker_key_is_not_in_the_settings_repr(picker):
    assert API_KEY not in repr(get_settings())


# --- Sources ------------------------------------------------------------------------


async def _google_source(tenant_id, user, scopes, config):
    conn = await make_connection(tenant_id, user, "google", scopes=scopes)
    async with client_for(user) as c:
        resp = await c.post(
            "/v1/sources",
            json={"kind": "google_docs", "name": "Docs", "connection_id": str(conn),
                  "config": config},
        )  # fmt: skip
    return conn, resp


async def test_picked_files_and_folders_on_drive_readonly(tenant_id, docs):
    pat = (await make_person(tenant_id, "pat@example.com")).user
    docs.pages = [[message("1Doc", "text", kind="doc"), message("1InFolder", "t", kind="doc")]]
    config = {"docs": ["1Doc"], "folders": ["1Folder"], "names": {"1Folder": "Specs"}}
    _, resp = await _google_source(tenant_id, pat, READONLY, config)
    assert resp.status_code == 201, resp.text
    source = resp.json()
    assert source["config"] == config
    assert source["reconnect_reason"] is None
    async with client_for(pat) as c:
        result = (await c.post(f"/v1/sources/{source['id']}/sync")).json()
    assert result["outcome"] == "completed", result
    assert result["upserted"] == 2
    file_only = await make_connection(tenant_id, pat, "google", scopes=FILE_ONLY)
    async with client_for(pat) as c:
        kinds = {k["kind"]: k for k in (await c.get("/v1/sources/kinds")).json()}
    choices = {c["id"]: c for c in kinds["google_docs"]["connections"]}
    assert choices[str(file_only)]["reconnect_reason"] == RECONNECT_TO_CHOOSE_FILES
    assert [c["reconnect_reason"] for k, c in choices.items() if k != str(file_only)] == [None]


async def test_folders_without_drive_readonly_ask_to_reconnect(tenant_id, docs):
    pat = (await make_person(tenant_id, "pat@example.com")).user
    _, resp = await _google_source(tenant_id, pat, FILE_ONLY, {"folders": ["1Folder"]})
    assert resp.status_code == 422
    assert resp.json()["detail"].startswith(RECONNECT_TO_CHOOSE_FILES)
    assert not [c for c in docs.calls if "cursor" in c]


async def test_a_grant_that_loses_drive_readonly_stops_syncing_folders(tenant_id, docs):
    pat = (await make_person(tenant_id, "pat@example.com")).user
    conn, resp = await _google_source(tenant_id, pat, READONLY, {"folders": ["1Folder"]})
    source = resp.json()
    assert source["reconnect_reason"] is None
    from oracle.connections.models import Connection

    async with tenant_session(tenant_id) as s:
        row = await s.get(Connection, conn)
        row.scopes = FILE_ONLY
        await s.commit()
    async with client_for(pat) as c:
        listed = (await c.get("/v1/sources")).json()
        result = (await c.post(f"/v1/sources/{source['id']}/sync")).json()
    (out,) = [s for s in listed if s["id"] == source["id"]]
    assert out["reconnect_reason"] == RECONNECT_TO_CHOOSE_FILES
    assert result["outcome"] == "error"
    assert result["error"].startswith(RECONNECT_TO_CHOOSE_FILES)
    assert not [c for c in docs.calls if "cursor" in c]


async def test_unreadable_items_are_reported_not_a_source_failure(tenant_id, docs):
    pat = (await make_person(tenant_id, "pat@example.com")).user
    docs.pages = [
        [
            message("1DocOk", "text", kind="doc"),
            ItemUnavailable("1DocGone", "No access: the file was unshared or removed"),
        ]
    ]
    _, resp = await _google_source(tenant_id, pat, READONLY, {"docs": ["1DocOk", "1DocGone"]})
    source = resp.json()
    async with client_for(pat) as c:
        result = (await c.post(f"/v1/sources/{source['id']}/sync")).json()
        again = (await c.get(f"/v1/sources/{source['id']}")).json()
    assert result["outcome"] == "completed"
    assert result["upserted"] == 1
    reason = "No access: the file was unshared or removed"
    expected = [{"external_id": "1DocGone", "reason": reason}]
    assert result["unavailable"] == expected
    assert result["source"]["status"] == "active"
    assert again["unavailable_items"] == expected

    # Readable again: the report clears on the next full sync.
    docs.pages = [[message("1DocOk", "text", kind="doc"), message("1DocGone", "t", kind="doc")]]
    async with tenant_session(tenant_id) as s:
        from oracle.sources.models import Source

        row = await s.get(Source, source["id"])
        row.cursor = None
        await s.commit()
    async with client_for(pat) as c:
        result = (await c.post(f"/v1/sources/{source['id']}/sync")).json()
    assert result["unavailable"] == [] and result["source"]["unavailable_items"] == []


def test_item_unavailable_is_a_sync_event():
    event = ItemUnavailable("1Doc", "No access")
    assert (event.external_id, event.reason) == ("1Doc", "No access")
    assert not isinstance(event, CursorCheckpoint)
