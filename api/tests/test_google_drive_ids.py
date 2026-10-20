"""Drive ids are checked before Drive is called (review M2): an id is 10 to 200 of
[A-Za-z0-9_-], never 'root'; ids are quoted in Drive queries and URL paths anyway, so a
crafted id cannot run its own Drive query or reach another googleapis path."""

import re

import httpx
import pytest

from oracle.connections.providers import DRIVE_READONLY
from oracle.sources import base, service
from oracle.sources.base import ConnectorBadInput
from oracle.sources.connectors import google_docs
from oracle.sources.connectors.google_docs import DRIVE_URL, GoogleDocsConnector, _Drive
from tests.connection_helpers import make_person
from tests.sources_helpers import client_for, make_connection

READONLY = ["openid", "email", DRIVE_READONLY]
# The reviewer's probe: validates as files/root, then lists by the caller's own query.
INJECTED = "root?x=' in parents or (sharedWithMe or fullText contains 'salary') or 'y"


@pytest.fixture
def drive(monkeypatch) -> list[httpx.Request]:
    service.load_connectors()
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"id": "x", "mimeType": google_docs.DOC_MIME})

    real = GoogleDocsConnector(httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    monkeypatch.setitem(base._registry, "google_docs", real)
    return seen


async def _post(tenant_id, config):
    pat = (await make_person(tenant_id, "pat@example.com")).user
    conn = await make_connection(tenant_id, pat, "google", scopes=READONLY)
    async with client_for(pat) as c:
        resp = await c.post(
            "/v1/sources",
            json={"kind": "google_docs", "name": "Docs", "connection_id": str(conn),
                  "config": config},
        )  # fmt: skip
    return pat, resp


@pytest.mark.parametrize(
    "config",
    [
        {"folders": [INJECTED]},
        {"docs": [INJECTED]},
        {"folders": ["root"]},
        {"folders": ["ROOT"]},
        {"docs": ["../../oauth2/v3/tokeninfo"]},
        {"docs": ["1DocA0000%2F..%2Fabout"]},
        {"docs": ["short"]},
        {"docs": ["x" * 201]},
    ],
)
async def test_a_bad_id_is_a_400_before_any_drive_call(tenant_id, drive, config):
    _, resp = await _post(tenant_id, config)
    assert resp.status_code == 400, resp.text
    assert "is not a Drive file or folder id" in resp.json()["detail"]
    assert drive == []


async def test_a_bad_id_in_an_edit_is_a_400_too(tenant_id, drive):
    pat, resp = await _post(tenant_id, {"docs": ["1DocA000000"]})
    assert resp.status_code == 201, resp.text
    drive.clear()
    async with client_for(pat) as c:
        edit = await c.patch(
            f"/v1/sources/{resp.json()['id']}", json={"config": {"folders": [INJECTED]}}
        )
    assert edit.status_code == 400
    assert drive == []


def test_valid_ids():
    assert google_docs.valid_id("1AbC_dEf-0123456789")
    for bad in ("root", "Root", "", "1Doc", "a b c d e f g h", "1DocA00000'", INJECTED, None, 7):
        assert not google_docs.valid_id(bad)
    with pytest.raises(ConnectorBadInput):
        google_docs._options({"folders": ["root"]})


async def test_children_escapes_quotes_and_backslashes():
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"files": []})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        drive = _Drive(client, "token")
        _ = [f async for f in drive.children("it's\\x", "files(id)")]
    q = seen[0].url.params["q"]
    assert q.startswith("'it\\'s\\\\x' in parents and trashed = false")
    # One quoted string: the quote inside is escaped, so it cannot close it.
    assert re.match(r"^'(?:[^'\\]|\\.)*' in parents and ", q)


async def test_paths_are_quoted_segments():
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"id": "x"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        drive = _Drive(client, "token")
        await drive.file("../about?x=1")
        await drive.export("a/../../b")
    assert seen[0].url.raw_path.startswith(b"/drive/v3/files/..%2Fabout%3Fx%3D1?")
    assert seen[1].url.raw_path.startswith(b"/drive/v3/files/a%2F..%2F..%2Fb/export?")
    assert all(str(r.url).startswith(DRIVE_URL) for r in seen)
