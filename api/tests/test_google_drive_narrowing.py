"""Narrowing a Google Docs source (S5, 'Browse access and narrowing', owner 2026-10-19):
removing a picked file or folder, then saving, deletes what was pulled in from it on the
next sync. Runs the real connector against a small fake Drive."""

import json
import re

import httpx
import pytest
from sqlalchemy import select

from oracle.connections.providers import DRIVE_READONLY
from oracle.sources import base, service
from oracle.sources.connectors.google_docs import (
    DOC_MIME,
    DRIVE_URL,
    FOLDER_MIME,
    GoogleDocsConnector,
)
from oracle.sources.models import Source, SourceItem
from oracle.tenancy import tenant_session
from tests.connection_helpers import make_person
from tests.sources_helpers import client_for, make_connection

READONLY = ["openid", "email", DRIVE_READONLY]
TIME = "2026-10-01T09:00:00.000Z"


class Drive:
    """Docs and folders by id; ``parents`` maps a folder to the ids in it."""

    def __init__(self):
        self.files: dict[str, dict] = {}
        self.parents: dict[str, list[str]] = {}

    def doc(self, file_id: str, name: str, folder: str | None = None) -> None:
        self.files[file_id] = {"id": file_id, "name": name, "mimeType": DOC_MIME,
                               "modifiedTime": TIME, "createdTime": TIME}  # fmt: skip
        if folder:
            self.parents.setdefault(folder, []).append(file_id)

    def folder(self, file_id: str, name: str, parent: str | None = None) -> None:
        self.files[file_id] = {"id": file_id, "name": name, "mimeType": FOLDER_MIME}
        if parent:
            self.parents.setdefault(parent, []).append(file_id)

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = str(request.url.copy_with(query=None))[len(DRIVE_URL) :]
        if path == "about":
            return httpx.Response(200, json={"user": {"emailAddress": "pat@example.com"}})
        if path == "files":
            (folder,) = re.findall(r"'([^']+)' in parents", request.url.params["q"])
            kids = [self.files[i] for i in self.parents.get(folder, [])]
            return httpx.Response(200, json={"files": kids})
        file_id = path.split("/")[1]
        if file_id not in self.files:
            return httpx.Response(404, json={"error": {"message": "File not found"}})
        if path.endswith("/export"):
            return httpx.Response(200, text=f"# {self.files[file_id]['name']}\n")
        return httpx.Response(200, json=self.files[file_id])


@pytest.fixture
def drive(monkeypatch):
    service.load_connectors()
    fake = Drive()
    real = GoogleDocsConnector(httpx.AsyncClient(transport=httpx.MockTransport(fake)))
    monkeypatch.setitem(base._registry, "google_docs", real)
    return fake


async def _live(tenant_id, source_id) -> set[str]:
    async with tenant_session(tenant_id) as s:
        rows = await s.scalars(
            select(SourceItem.external_id).where(
                SourceItem.source_id == source_id, SourceItem.deleted_at.is_(None)
            )
        )
        return set(rows)


async def _setup(tenant_id, drive, config):
    pat = (await make_person(tenant_id, "pat@example.com")).user
    conn = await make_connection(tenant_id, pat, "google", scopes=READONLY)
    async with client_for(pat) as c:
        resp = await c.post(
            "/v1/sources",
            json={"kind": "google_docs", "name": "Docs", "connection_id": str(conn),
                  "config": config},
        )  # fmt: skip
        assert resp.status_code == 201, resp.text
        source = resp.json()
        result = (await c.post(f"/v1/sources/{source['id']}/sync")).json()
    assert result["outcome"] == "completed", result
    return pat, source


async def _narrow_and_sync(pat, source, config) -> dict:
    async with client_for(pat) as c:
        resp = await c.patch(f"/v1/sources/{source['id']}", json={"config": config})
        assert resp.status_code == 200, resp.text
        result = (await c.post(f"/v1/sources/{source['id']}/sync")).json()
    assert result["outcome"] == "completed", result
    return result


async def test_removed_file_is_deleted_on_the_next_sync(tenant_id, drive):
    # The reviewer's probe: pick A and SENSITIVE, sync, remove SENSITIVE, sync.
    drive.doc("1DocA", "A")
    drive.doc("1DocSensitive", "SENSITIVE")
    pat, source = await _setup(tenant_id, drive, {"docs": ["1DocA", "1DocSensitive"]})
    assert await _live(tenant_id, source["id"]) == {"1DocA", "1DocSensitive"}

    result = await _narrow_and_sync(pat, source, {"docs": ["1DocA"]})
    assert result["deleted"] == 1
    assert await _live(tenant_id, source["id"]) == {"1DocA"}


async def test_removed_folder_deletes_every_doc_from_it(tenant_id, drive):
    drive.folder("1Folder", "Specs")
    drive.folder("1Sub", "Old specs", parent="1Folder")
    drive.doc("1DocInFolder", "Spec", folder="1Folder")
    drive.doc("1DocInSub", "Old spec", folder="1Sub")
    drive.doc("1DocA", "A")
    pat, source = await _setup(tenant_id, drive, {"docs": ["1DocA"], "folders": ["1Folder"]})
    assert await _live(tenant_id, source["id"]) == {"1DocA", "1DocInFolder", "1DocInSub"}

    result = await _narrow_and_sync(pat, source, {"docs": ["1DocA"]})
    assert result["deleted"] == 2
    assert await _live(tenant_id, source["id"]) == {"1DocA"}


async def test_a_doc_added_to_a_picked_folder_later_is_pulled_in(tenant_id, drive):
    drive.folder("1Folder", "Specs")
    drive.doc("1DocInFolder", "Spec", folder="1Folder")
    pat, source = await _setup(tenant_id, drive, {"folders": ["1Folder"]})
    drive.doc("1DocLater", "Written later", folder="1Folder")
    async with client_for(pat) as c:
        result = (await c.post(f"/v1/sources/{source['id']}/sync")).json()
    assert result["upserted"] == 1
    assert await _live(tenant_id, source["id"]) == {"1DocInFolder", "1DocLater"}


async def test_widening_keeps_what_is_there_and_adds(tenant_id, drive):
    drive.doc("1DocA", "A")
    drive.doc("1DocB", "B")
    pat, source = await _setup(tenant_id, drive, {"docs": ["1DocA"]})
    result = await _narrow_and_sync(pat, source, {"docs": ["1DocA", "1DocB"]})
    assert result["deleted"] == 0
    assert await _live(tenant_id, source["id"]) == {"1DocA", "1DocB"}


async def test_items_left_behind_by_an_earlier_edit_are_deleted_too(tenant_id, drive):
    # Before this fix an edit dropped the cursor, so the connector no longer knew the
    # removed doc. The next edit still deletes it.
    drive.doc("1DocA", "A")
    drive.doc("1DocSensitive", "SENSITIVE")
    pat, source = await _setup(tenant_id, drive, {"docs": ["1DocA", "1DocSensitive"]})
    async with tenant_session(tenant_id) as s:
        row = await s.get(Source, source["id"])
        row.config = {"docs": ["1DocA"]}
        row.cursor = None
        await s.commit()
    async with client_for(pat) as c:
        await c.post(f"/v1/sources/{source['id']}/sync")
    assert "1DocSensitive" in await _live(tenant_id, source["id"])

    await _narrow_and_sync(pat, source, {"docs": ["1DocA"], "names": {"1DocA": "A"}})
    assert await _live(tenant_id, source["id"]) == {"1DocA"}


async def test_cursor_after_an_edit_keeps_only_known_files(tenant_id, drive):
    drive.doc("1DocA", "A")
    pat, source = await _setup(tenant_id, drive, {"docs": ["1DocA"]})
    async with client_for(pat) as c:
        await c.patch(f"/v1/sources/{source['id']}", json={"config": {"docs": ["1DocA"],
                      "names": {"1DocA": "A"}}})  # fmt: skip
    async with tenant_session(tenant_id) as s:
        row = await s.get(Source, source["id"])
        cursor = json.loads(json.dumps(row.cursor))
    # The known files stay, so the next sync deletes what left the allowlist.
    assert cursor == {"files": {"1DocA": TIME}}
