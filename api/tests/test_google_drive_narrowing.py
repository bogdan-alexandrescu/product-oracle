"""Narrowing a Google Docs source (S5, 'Browse access and narrowing', owner 2026-10-19;
soft delete, and narrowing takes effect on save, owner 2026-10-20): removing a picked
file or folder and saving deletes what was pulled in from it in that request, with no
Drive call, so it holds with an expired connection or a paused source. A sync also
deletes what it knows and no longer finds (sources narrowed before this fix). A picked
folder Drive refuses (403 or 404) hides its docs until it can be read again (owner
2026-10-20). Runs the real connector against a small fake Drive."""

import asyncio
import re
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from sqlalchemy import select

from oracle.config import get_settings
from oracle.connections.providers import DRIVE_READONLY
from oracle.sources import base, service
from oracle.sources.connectors import google_docs
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
LATER = "2026-10-02T09:00:00.000Z"
# Drive ids are 10 or more of [A-Za-z0-9_-].
DOC_A = "1DocA000000"
DOC_B = "1DocB000000"
SENSITIVE = "1DocSensitive"
FOLDER = "1Folder0000"
SUB = "1FolderSub0"
IN_FOLDER = "1DocInFolder"
IN_SUB = "1DocInSub00"
ADDED_LATER = "1DocLater00"
OUTSIDE = "1DocOutside"
PAT = {"displayName": "Pat", "emailAddress": "pat@example.com"}
EVE = {"displayName": "Eve", "emailAddress": "eve@elsewhere.org"}


class Drive:
    """Docs and folders by id; ``parents`` maps a folder to the ids in it. Keeps a change
    log for ``changes`` and can hold the next export until released."""

    def __init__(self):
        self.files: dict[str, dict] = {}
        self.parents: dict[str, list[str]] = {}
        self.log: list[dict] = []
        self.gone: set[str] = set()
        # File id -> (status, reason) Drive answers for its metadata (403s, 5xx).
        self.refuse: dict[str, tuple[int, str]] = {}
        # File ids whose metadata call times out.
        self.slow: set[str] = set()
        # File ids whose export times out (the metadata is fine).
        self.export_slow: set[str] = set()
        self.calls: list[str] = []
        self.hold: tuple[asyncio.Event, asyncio.Event] | None = None
        # File id -> (started, release): holds that file's next metadata call (the listing).
        self.hold_meta: dict[str, tuple[asyncio.Event, asyncio.Event]] = {}
        # After a held export is released: answer it 429 (Drive rate limiting).
        self.limit_after_hold = False

    def _change(self, file_id: str, removed: bool = False) -> None:
        parents = [p for p, kids in self.parents.items() if file_id in kids]
        self.log.append({"fileId": file_id, "removed": removed, "file": {"parents": parents}})

    def doc(
        self, file_id: str, name: str, folder: str | None = None, owner=PAT, drive_id=None
    ) -> None:
        self.files[file_id] = {"id": file_id, "name": name, "mimeType": DOC_MIME,
                               "modifiedTime": TIME, "createdTime": TIME,
                               "owners": [owner]}  # fmt: skip
        if drive_id:
            # Drive names no owner for a shared drive's files.
            self.files[file_id] |= {"driveId": drive_id, "owners": []}
        if folder:
            self.parents.setdefault(folder, []).append(file_id)
        self._change(file_id)

    def folder(self, file_id: str, name: str, parent: str | None = None) -> None:
        self.files[file_id] = {"id": file_id, "name": name, "mimeType": FOLDER_MIME}
        if parent:
            self.parents.setdefault(parent, []).append(file_id)
        self._change(file_id)

    def unshare(self, file_id: str) -> None:
        """Access removed: Drive answers 404 and lists the folder as empty."""
        self.gone.add(file_id)
        self._change(file_id, removed=True)

    def unrelated_change(self) -> None:
        self.log.append({"fileId": "1Elsewhere0", "removed": False, "file": {"parents": []}})

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        path = str(request.url.copy_with(query=None))[len(DRIVE_URL) :]
        params = request.url.params
        self.calls.append(path)
        if path == "about":
            return httpx.Response(200, json={"user": {"emailAddress": "pat@example.com"}})
        if path == "changes/startPageToken":
            return httpx.Response(200, json={"startPageToken": str(len(self.log))})
        if path == "changes":
            start = int(params["pageToken"])
            return httpx.Response(
                200,
                json={"changes": self.log[start:], "newStartPageToken": str(len(self.log))},
            )
        if path == "files":
            (folder,) = re.findall(r"'([^']+)' in parents", params["q"])
            if folder in self.gone or folder in self.refuse:
                return httpx.Response(200, json={"files": []})
            kids = [self.files[i] for i in self.parents.get(folder, []) if i not in self.gone]
            return httpx.Response(200, json={"files": kids})
        file_id = path.split("/")[1]
        if file_id in self.slow:
            raise httpx.ReadTimeout("timed out", request=request)
        if file_id in self.refuse:
            status, reason = self.refuse[file_id]
            error = {"message": "Refused", "errors": [{"reason": reason}]}
            return httpx.Response(status, json={"error": error})
        if file_id not in self.files or file_id in self.gone:
            return httpx.Response(404, json={"error": {"message": "File not found"}})
        if not path.endswith("/export") and file_id in self.hold_meta:
            started, release = self.hold_meta.pop(file_id)
            started.set()
            await release.wait()
        if path.endswith("/export"):
            if file_id in self.export_slow:
                self.calls.append(f"export-timeout:{file_id}")
                raise httpx.ReadTimeout("timed out", request=request)
            if self.hold is not None:
                started, release = self.hold
                self.hold = None
                started.set()
                await release.wait()
                if self.limit_after_hold:
                    return httpx.Response(429, headers={"Retry-After": "30"}, json={})
            return httpx.Response(200, text=f"# {self.files[file_id]['name']}\n")
        return httpx.Response(200, json=self.files[file_id])


@pytest.fixture
def drive(monkeypatch):
    service.load_connectors()
    fake = Drive()
    real = GoogleDocsConnector(httpx.AsyncClient(transport=httpx.MockTransport(fake)))
    monkeypatch.setitem(base._registry, "google_docs", real)
    return fake


@pytest.fixture(autouse=True)
def _settings(monkeypatch):
    # The company's domains from the members' addresses (pat@example.com), as in local
    # development; production never infers them (test_company_domains_are_explicit...).
    monkeypatch.setenv("ORACLE_INFER_COMPANY_DOMAINS", "true")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


async def _live(tenant_id, source_id) -> set[str]:
    async with tenant_session(tenant_id) as s:
        rows = await s.scalars(
            select(SourceItem.external_id).where(
                SourceItem.source_id == source_id, SourceItem.deleted_at.is_(None)
            )
        )
        return set(rows)


async def _row(tenant_id, source_id) -> Source:
    async with tenant_session(tenant_id) as s:
        return await s.get(Source, source_id)


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


async def _sync(pat, source) -> dict:
    async with client_for(pat) as c:
        return (await c.post(f"/v1/sources/{source['id']}/sync")).json()


async def _patch(pat, source, body) -> dict:
    async with client_for(pat) as c:
        resp = await c.patch(f"/v1/sources/{source['id']}", json=body)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _narrow_and_sync(pat, source, config) -> dict:
    await _patch(pat, source, {"config": config})
    result = await _sync(pat, source)
    assert result["outcome"] == "completed", result
    return result


@asynccontextmanager
async def _held_sync(drive, pat, source):
    """A sync held at its first export while the block runs; yields its result, filled in
    once the block ends. Released even when the block fails, so a failing test never
    leaves a sync holding rows that every later test would wait on."""
    started, release = asyncio.Event(), asyncio.Event()
    drive.hold = (started, release)
    running = asyncio.create_task(_sync(pat, source))
    result: dict = {}
    try:
        await asyncio.wait_for(started.wait(), 10)
        yield result
    finally:
        release.set()
        result.update(await asyncio.wait_for(running, 10))


@asynccontextmanager
async def _held_after_write(monkeypatch, pat, source, external_id):
    """A sync held right after it wrote ``external_id``'s item, before the per-file
    checkpoint commits it: the row is changed and locked, uncommitted. Yields its result,
    filled in once the block ends; released even when the block fails."""
    from oracle.sources import sync as sync_module

    started, release = asyncio.Event(), asyncio.Event()
    real = sync_module.store.upsert_item

    async def upsert(db, src, event):
        out = await real(db, src, event)
        if event.external_id == external_id and not started.is_set():
            started.set()
            await release.wait()
        return out

    monkeypatch.setattr(sync_module.store, "upsert_item", upsert)
    running = asyncio.create_task(_sync(pat, source))
    result: dict = {}
    try:
        await asyncio.wait_for(started.wait(), 10)
        yield result
    finally:
        release.set()
        result.update(await asyncio.wait_for(running, 10))


async def _legacy_acl(tenant_id, source_id, ids) -> None:
    """Items stored by main: a shared-drive doc has no shared_drive and no owner email."""
    async with tenant_session(tenant_id) as s:
        rows = await s.scalars(
            select(SourceItem).where(
                SourceItem.source_id == source_id, SourceItem.external_id.in_(sorted(ids))
            )
        )
        for row in rows:
            row.acl = {"owners": []}
        await s.commit()


async def _narrow(tenant_id, drive, pat, source, config) -> dict:
    """Save a narrower allowlist; what left it is deleted in that request, Drive untouched."""
    drive.calls.clear()
    edited = await _patch(pat, source, {"config": config})
    assert drive.calls == []
    return edited


async def _set_connection_status(tenant_id, source_id, status: str) -> None:
    from oracle.connections.models import Connection

    async with tenant_session(tenant_id) as s:
        row = await s.get(Source, source_id)
        conn = await s.get(Connection, row.connection_id)
        conn.status = status
        await s.commit()


async def _forget_tree(tenant_id, source_id, folder) -> None:
    """A picked folder whose docs Oracle has not listed (its tree is unknown)."""
    async with tenant_session(tenant_id) as s:
        row = await s.get(Source, source_id)
        tree = dict(row.cursor["tree"])
        del tree[folder]
        row.cursor = {**row.cursor, "tree": tree}
        await s.commit()


async def _reset_cursor(tenant_id, source_id, config=None) -> None:
    """What a source narrowed on main before this fix looks like: no cursor."""
    async with tenant_session(tenant_id) as s:
        row = await s.get(Source, source_id)
        if config is not None:
            row.config = config
        row.cursor = None
        await s.commit()


async def test_a_removed_file_is_deleted_on_save(tenant_id, drive):
    # The reviewer's probe: pick A and SENSITIVE, sync, remove SENSITIVE, save.
    drive.doc(DOC_A, "A")
    drive.doc(SENSITIVE, "SENSITIVE")
    pat, source = await _setup(tenant_id, drive, {"docs": [DOC_A, SENSITIVE]})
    assert await _live(tenant_id, source["id"]) == {DOC_A, SENSITIVE}

    edited = await _narrow(tenant_id, drive, pat, source, {"docs": [DOC_A]})
    assert edited["item_count"] == 1
    assert await _live(tenant_id, source["id"]) == {DOC_A}
    # The next sync has nothing more to delete.
    result = await _sync(pat, source)
    assert result["outcome"] == "completed", result
    assert result["deleted"] == 0
    assert await _live(tenant_id, source["id"]) == {DOC_A}


async def test_a_removed_folder_deletes_every_doc_from_it_on_save(tenant_id, drive):
    drive.folder(FOLDER, "Specs")
    drive.folder(SUB, "Old specs", parent=FOLDER)
    drive.doc(IN_FOLDER, "Spec", folder=FOLDER)
    drive.doc(IN_SUB, "Old spec", folder=SUB)
    drive.doc(DOC_A, "A")
    pat, source = await _setup(tenant_id, drive, {"docs": [DOC_A], "folders": [FOLDER]})
    assert await _live(tenant_id, source["id"]) == {DOC_A, IN_FOLDER, IN_SUB}

    await _narrow(tenant_id, drive, pat, source, {"docs": [DOC_A]})
    assert await _live(tenant_id, source["id"]) == {DOC_A}
    result = await _sync(pat, source)
    assert result["deleted"] == 0
    assert await _live(tenant_id, source["id"]) == {DOC_A}


async def test_narrowing_with_an_expired_connection_deletes_on_save(tenant_id, drive):
    """No Drive call is needed to narrow: an expired connection does not stop it."""
    drive.folder(FOLDER, "Specs")
    drive.doc(IN_FOLDER, "Spec", folder=FOLDER)
    drive.doc(DOC_A, "A")
    pat, source = await _setup(tenant_id, drive, {"docs": [DOC_A], "folders": [FOLDER]})
    await _set_connection_status(tenant_id, source["id"], "expired")

    await _narrow(tenant_id, drive, pat, source, {"docs": [DOC_A]})
    assert await _live(tenant_id, source["id"]) == {DOC_A}


async def test_narrowing_a_paused_source_deletes_on_save(tenant_id, drive):
    drive.doc(DOC_A, "A")
    drive.doc(SENSITIVE, "SENSITIVE")
    pat, source = await _setup(tenant_id, drive, {"docs": [DOC_A, SENSITIVE]})
    async with client_for(pat) as c:
        assert (await c.post(f"/v1/sources/{source['id']}/pause")).status_code == 200
    edited = await _narrow(tenant_id, drive, pat, source, {"docs": [DOC_A]})
    assert edited["status"] == "paused"
    assert await _live(tenant_id, source["id"]) == {DOC_A}


async def test_narrowing_deletes_what_came_from_a_removed_folder_when_another_tree_is_unknown(
    tenant_id, drive
):
    """Folder B's docs were never listed (its tree is unknown): what came from the removed
    folder A is still deleted on save, and B's docs are not touched."""
    other, in_other = "1FolderOther", "1DocInOther0"
    drive.folder(FOLDER, "Specs")
    drive.doc(IN_FOLDER, "Spec", folder=FOLDER)
    drive.folder(other, "Plans")
    drive.doc(in_other, "Plan", folder=other)
    drive.doc(DOC_A, "A")
    config = {"docs": [DOC_A], "folders": [FOLDER, other]}
    pat, source = await _setup(tenant_id, drive, config)
    assert await _live(tenant_id, source["id"]) == {DOC_A, IN_FOLDER, in_other}
    await _forget_tree(tenant_id, source["id"], other)
    await _set_connection_status(tenant_id, source["id"], "expired")

    await _narrow(tenant_id, drive, pat, source, {"docs": [DOC_A], "folders": [other]})
    assert await _live(tenant_id, source["id"]) == {DOC_A, in_other}


async def test_a_removed_doc_still_in_a_picked_folder_is_kept(tenant_id, drive):
    drive.folder(FOLDER, "Specs")
    drive.doc(IN_FOLDER, "Spec", folder=FOLDER)
    pat, source = await _setup(tenant_id, drive, {"docs": [IN_FOLDER], "folders": [FOLDER]})
    await _narrow(tenant_id, drive, pat, source, {"folders": [FOLDER]})
    assert await _live(tenant_id, source["id"]) == {IN_FOLDER}


async def test_a_folder_picked_again_after_narrowing_brings_its_docs_back(tenant_id, drive):
    drive.folder(FOLDER, "Specs")
    drive.doc(IN_FOLDER, "Spec", folder=FOLDER)
    drive.doc(DOC_A, "A")
    pat, source = await _setup(tenant_id, drive, {"docs": [DOC_A], "folders": [FOLDER]})
    await _narrow(tenant_id, drive, pat, source, {"docs": [DOC_A]})
    assert await _live(tenant_id, source["id"]) == {DOC_A}

    await _patch(pat, source, {"config": {"docs": [DOC_A], "folders": [FOLDER]}})
    result = await _sync(pat, source)
    assert result["outcome"] == "completed", result
    assert await _live(tenant_id, source["id"]) == {DOC_A, IN_FOLDER}


async def test_a_doc_added_to_a_picked_folder_later_is_pulled_in(tenant_id, drive):
    drive.folder(FOLDER, "Specs")
    drive.doc(IN_FOLDER, "Spec", folder=FOLDER)
    pat, source = await _setup(tenant_id, drive, {"folders": [FOLDER]})
    drive.doc(ADDED_LATER, "Written later", folder=FOLDER)
    result = await _sync(pat, source)
    assert result["upserted"] == 1
    assert await _live(tenant_id, source["id"]) == {IN_FOLDER, ADDED_LATER}


async def test_widening_keeps_what_is_there_and_adds(tenant_id, drive):
    drive.doc(DOC_A, "A")
    drive.doc(DOC_B, "B")
    pat, source = await _setup(tenant_id, drive, {"docs": [DOC_A]})
    result = await _narrow_and_sync(pat, source, {"docs": [DOC_A, DOC_B]})
    assert result["deleted"] == 0
    assert await _live(tenant_id, source["id"]) == {DOC_A, DOC_B}


# --- M1: what to delete comes from the stored items ----------------------------------


async def test_changing_connection_and_narrowing_together_deletes(tenant_id, drive):
    # (a) A new connection resets the cursor; the removed doc is still deleted.
    drive.doc(DOC_A, "A")
    drive.doc(SENSITIVE, "SENSITIVE")
    pat, source = await _setup(tenant_id, drive, {"docs": [DOC_A, SENSITIVE]})
    other = await make_connection(tenant_id, pat, "google", scopes=READONLY)

    await _patch(pat, source, {"connection_id": str(other), "config": {"docs": [DOC_A]}})
    # Deleted on save; the new connection is checked with Drive as before.
    assert await _live(tenant_id, source["id"]) == {DOC_A}
    result = await _sync(pat, source)
    assert result["outcome"] == "completed", result
    assert result["deleted"] == 0
    assert await _live(tenant_id, source["id"]) == {DOC_A}
    # Everything left is read again through the new connection.
    assert result["upserted"] == 1


async def test_a_source_narrowed_before_the_fix_is_cleaned_by_a_plain_sync(tenant_id, drive):
    # (b) Narrowed on main: config {A}, no cursor, A and S still live. No edit needed.
    drive.doc(DOC_A, "A")
    drive.doc(SENSITIVE, "SENSITIVE")
    pat, source = await _setup(tenant_id, drive, {"docs": [DOC_A, SENSITIVE]})
    await _reset_cursor(tenant_id, source["id"], config={"docs": [DOC_A]})
    assert await _live(tenant_id, source["id"]) == {DOC_A, SENSITIVE}

    result = await _sync(pat, source)
    assert result["outcome"] == "completed", result
    assert result["deleted"] == 1
    assert await _live(tenant_id, source["id"]) == {DOC_A}


async def test_a_sync_running_across_the_edit_saves_nothing_over_it(tenant_id, drive):
    # (c) A sync from no cursor is held at its first export; the source is narrowed;
    # the held sync must not save its cursor or report, and the next sync deletes S.
    drive.doc(DOC_A, "A")
    drive.doc(SENSITIVE, "SENSITIVE")
    drive.doc("1DocMissing", "Unshared later")
    config = {"docs": [DOC_A, SENSITIVE, "1DocMissing"]}
    pat, source = await _setup(tenant_id, drive, config)
    drive.unshare("1DocMissing")
    await _sync(pat, source)
    await _reset_cursor(tenant_id, source["id"])
    assert (await _row(tenant_id, source["id"])).unavailable_items  # 1DocMissing

    async with _held_sync(drive, pat, source) as first:
        edited = await _patch(pat, source, {"config": {"docs": [DOC_A]}})
        assert edited["unavailable_items"] == []
        # Deleted on save, while the sync still runs.
        assert await _live(tenant_id, source["id"]) == {DOC_A}

    assert first["outcome"] == "superseded", first
    row = await _row(tenant_id, source["id"])
    # The edit's cleared report stands; the sync's early checkpoint (its deletes, before
    # any export) left no finished listing and nothing of what the edit removed.
    assert row.unavailable_items == []
    assert not (row.cursor or {}).get("listing")
    assert SENSITIVE not in (row.cursor or {}).get("files", {})
    assert await _live(tenant_id, source["id"]) == {DOC_A}

    result = await _sync(pat, source)
    assert result["outcome"] == "completed", result
    assert result["deleted"] == 0
    assert await _live(tenant_id, source["id"]) == {DOC_A}


async def test_a_sync_holding_a_removed_docs_row_does_not_block_the_save(
    tenant_id, drive, monkeypatch
):
    """The sync has written (not yet committed) the row of the doc being removed: the
    save does not wait on that row (SKIP LOCKED leaves the doc live for now), and once the
    sync stops (superseded, its writes rolled back) tidy deletes it all the same."""
    drive.doc(DOC_A, "A")
    drive.doc(SENSITIVE, "SENSITIVE")
    pat, source = await _setup(tenant_id, drive, {"docs": [SENSITIVE, DOC_A]})
    await _reset_cursor(tenant_id, source["id"])
    # A new title, so the sync's write changes (and locks) the row.
    drive.files[SENSITIVE]["name"] = "SENSITIVE renamed"
    async with _held_after_write(monkeypatch, pat, source, SENSITIVE) as first:
        edited = await asyncio.wait_for(_patch(pat, source, {"config": {"docs": [DOC_A]}}), 10)
        assert edited["config"]["docs"] == [DOC_A]
        # The save skipped the locked row: still live while the sync holds it.
        assert await _live(tenant_id, source["id"]) == {DOC_A, SENSITIVE}
    assert first["outcome"] == "superseded", first
    assert await _live(tenant_id, source["id"]) == {DOC_A}
    assert SENSITIVE not in ((await _row(tenant_id, source["id"])).cursor or {}).get("files", {})


async def test_an_edit_landing_before_the_early_checkpoint_stops_the_sync_before_any_export(
    tenant_id, drive
):
    """The edit lands while the sync is still listing (before its early checkpoint):
    nothing the edit removed is exported or kept, and the removed doc stays deleted."""
    drive.doc(DOC_A, "A")
    drive.doc(SENSITIVE, "SENSITIVE")
    pat, source = await _setup(tenant_id, drive, {"docs": [SENSITIVE, DOC_A]})
    await _reset_cursor(tenant_id, source["id"])
    started, release = asyncio.Event(), asyncio.Event()
    drive.hold_meta[DOC_A] = (started, release)
    drive.calls.clear()
    running = asyncio.create_task(_sync(pat, source))
    try:
        await asyncio.wait_for(started.wait(), 10)
        await _patch(pat, source, {"config": {"docs": [DOC_A]}})
        assert await _live(tenant_id, source["id"]) == {DOC_A}
    finally:
        release.set()
        first = await asyncio.wait_for(running, 10)
    assert first["outcome"] == "superseded", first
    assert not [c for c in drive.calls if c.endswith("/export")]
    row = await _row(tenant_id, source["id"])
    assert SENSITIVE not in (row.cursor or {}).get("files", {})
    assert await _live(tenant_id, source["id"]) == {DOC_A}


async def test_a_persons_edit_stopping_a_sync_hides_only_what_they_removed(tenant_id, drive):
    """Owner 2026-10-20: legacy items (no shared drive, no owner email) are hidden only
    after a company narrowing, not when a person's own edit stops a sync."""
    drive.folder(FOLDER, "Specs")
    drive.doc(IN_FOLDER, "Legacy", folder=FOLDER)
    drive.doc(IN_SUB, "Normal", folder=FOLDER)
    drive.doc(DOC_A, "A")
    config = {"folders": [FOLDER], "docs": [DOC_A]}
    pat, source = await _setup(tenant_id, drive, config)
    assert await _live(tenant_id, source["id"]) == {DOC_A, IN_FOLDER, IN_SUB}
    await _legacy_acl(tenant_id, source["id"], {IN_FOLDER})
    await _reset_cursor(tenant_id, source["id"])

    async with _held_sync(drive, pat, source) as first:
        await _patch(pat, source, {"config": {"folders": [FOLDER]}})
    assert first["outcome"] == "superseded", first
    assert await _live(tenant_id, source["id"]) == {IN_FOLDER, IN_SUB}


async def test_a_company_narrowing_stopping_a_sync_hides_unknown_items(tenant_id, drive):
    from oracle.tenant_settings import TenantSetting

    drive.folder(FOLDER, "Specs")
    drive.doc(IN_FOLDER, "Legacy", folder=FOLDER)
    drive.doc(IN_SUB, "Normal", folder=FOLDER)
    pat, source = await _setup(tenant_id, drive, {"folders": [FOLDER]})
    assert await _live(tenant_id, source["id"]) == {IN_FOLDER, IN_SUB}
    async with tenant_session(tenant_id) as s:
        s.add(TenantSetting(key="company_email_domains", value=["example.com", "other.org"]))
        await s.commit()
    await _legacy_acl(tenant_id, source["id"], {IN_FOLDER})
    await _reset_cursor(tenant_id, source["id"])

    async with _held_sync(drive, pat, source) as first:
        async with tenant_session(tenant_id) as s:
            setting = await s.scalar(
                select(TenantSetting).where(TenantSetting.key == "company_email_domains")
            )
            setting.value = ["example.com"]
            await s.commit()
    assert first["outcome"] == "superseded", first
    assert await _live(tenant_id, source["id"]) == {IN_SUB}


async def test_a_failed_export_after_a_per_file_checkpoint_keeps_the_listing_undone(
    tenant_id, drive
):
    drive.doc(DOC_A, "A")
    drive.doc(DOC_B, "B")
    pat, source = await _setup(tenant_id, drive, {"docs": [DOC_A, DOC_B]})
    for doc in (DOC_A, DOC_B):
        drive.files[doc]["modifiedTime"] = LATER
        drive._change(doc)
    drive.export_slow.add(DOC_B)
    result = await _sync(pat, source)
    assert result["outcome"] == "error", result
    # A was exported and checkpointed, B failed: the listing is not marked done.
    assert not ((await _row(tenant_id, source["id"])).cursor or {}).get("listing")
    drive.export_slow.clear()
    result = await _sync(pat, source)
    assert result["outcome"] == "completed", result
    assert (await _row(tenant_id, source["id"])).last_error is None
    assert (await _row(tenant_id, source["id"])).cursor["files"][DOC_B] == LATER


async def test_the_early_checkpoint_writes_the_lost_access_report(tenant_id, drive):
    drive.doc(DOC_A, "A")
    drive.doc("1DocMissing", "Unshared later")
    pat, source = await _setup(tenant_id, drive, {"docs": [DOC_A, "1DocMissing"]})
    drive.unshare("1DocMissing")
    drive.files[DOC_A]["modifiedTime"] = LATER
    drive.export_slow.add(DOC_A)
    drive._change(DOC_A)
    await _reset_cursor(tenant_id, source["id"])
    result = await _sync(pat, source)
    assert result["outcome"] == "error", result
    notes = (await _row(tenant_id, source["id"])).unavailable_items
    assert [n["external_id"] for n in notes] == ["1DocMissing"]


async def test_a_rate_limited_sync_across_the_edit_writes_no_error_over_it(tenant_id, drive):
    """The rate-limited stop writes last_error under the same row lock as the other
    endings: a sync superseded by an edit leaves the edited source as the edit left it."""
    drive.doc(DOC_A, "A")
    drive.doc(SENSITIVE, "SENSITIVE")
    pat, source = await _setup(tenant_id, drive, {"docs": [DOC_A, SENSITIVE]})
    await _reset_cursor(tenant_id, source["id"])

    drive.limit_after_hold = True
    async with _held_sync(drive, pat, source) as first:
        await _patch(pat, source, {"config": {"docs": [DOC_A]}})

    assert first["outcome"] == "superseded", first
    assert (await _row(tenant_id, source["id"])).last_error is None


async def test_a_rate_limited_sync_says_so_on_the_source(tenant_id, drive):
    drive.doc(DOC_A, "A")
    pat, source = await _setup(tenant_id, drive, {"docs": [DOC_A]})
    await _reset_cursor(tenant_id, source["id"])
    started, release = asyncio.Event(), asyncio.Event()
    drive.hold, drive.limit_after_hold = (started, release), True
    release.set()
    result = await _sync(pat, source)
    assert result["outcome"] == "rate_limited", result
    assert "Rate limited" in (await _row(tenant_id, source["id"])).last_error


async def test_the_sync_lock_does_not_wait_on_item_writes(tenant_id, drive):
    """Two syncs of one source: one writing items (which takes KEY SHARE on the source
    row through the foreign key) must not block the other's row lock, or each could end
    up waiting on the other. FOR NO KEY UPDATE does not conflict with KEY SHARE."""
    from sqlalchemy import text

    from oracle.sources.sync import _hold, _Started

    drive.doc(DOC_A, "A")
    _, source = await _setup(tenant_id, drive, {"docs": [DOC_A]})
    row = await _row(tenant_id, source["id"])
    started = _Started(row.id, row.config, row.connection_id)
    async with tenant_session(tenant_id) as writer, tenant_session(tenant_id) as syncer:
        writer.add(SourceItem(source_id=row.id, external_id="1DocOther00", kind="doc"))
        await writer.flush()  # holds KEY SHARE on the source row until rollback
        await syncer.execute(text("SET LOCAL lock_timeout = '2s'"))
        await _hold(syncer, started)  # would time out with FOR UPDATE
        await syncer.rollback()
        await writer.rollback()


async def test_items_left_behind_by_an_earlier_edit_are_deleted_too(tenant_id, drive):
    drive.doc(DOC_A, "A")
    drive.doc(SENSITIVE, "SENSITIVE")
    pat, source = await _setup(tenant_id, drive, {"docs": [DOC_A, SENSITIVE]})
    await _reset_cursor(tenant_id, source["id"], config={"docs": [DOC_A]})
    await _narrow_and_sync(pat, source, {"docs": [DOC_A], "names": {DOC_A: "A"}})
    assert await _live(tenant_id, source["id"]) == {DOC_A}


async def test_an_allowlist_edit_keeps_the_cursor(tenant_id, drive):
    drive.doc(DOC_A, "A")
    pat, source = await _setup(tenant_id, drive, {"docs": [DOC_A]})
    before = (await _row(tenant_id, source["id"])).cursor
    await _patch(pat, source, {"config": {"docs": [DOC_A], "names": {DOC_A: "A"}}})
    after = (await _row(tenant_id, source["id"])).cursor
    assert after == before and after["files"] == {DOC_A: TIME}


# --- folders: unreadable, capped, not listed again when nothing changed ----------------


def _refused(status: int, reason: str):
    def lose(drive) -> None:
        drive.refuse[FOLDER] = (status, reason)
        drive._change(FOLDER, removed=True)  # Drive logs the permission change

    return lose


LOSSES = {
    "404": lambda drive: drive.unshare(FOLDER),
    "403 insufficientFilePermissions": _refused(403, "insufficientFilePermissions"),
    "403 forbidden": _refused(403, "forbidden"),
    "404 notFound": _refused(404, "notFound"),
}


@pytest.mark.parametrize("loss", list(LOSSES))
async def test_a_folder_drive_refuses_hides_its_docs_until_it_can_be_read_again(
    tenant_id, drive, loss
):
    """Owner 2026-10-20: a 403 or 404 for a picked folder is a confirmed loss: its docs
    are hidden at once and the source says "Lost access to <folder>"; once Drive lets
    Oracle read the folder again, they come back."""
    drive.folder(FOLDER, "Specs")
    drive.doc(IN_FOLDER, "Spec", folder=FOLDER)
    drive.doc(DOC_A, "A")
    config = {"docs": [DOC_A], "folders": [FOLDER], "names": {FOLDER: "Specs"}}
    pat, source = await _setup(tenant_id, drive, config)
    LOSSES[loss](drive)

    result = await _sync(pat, source)
    assert result["outcome"] == "completed", result
    assert result["deleted"] == 1
    assert await _live(tenant_id, source["id"]) == {DOC_A}
    (note,) = result["source"]["unavailable_items"]
    assert note["external_id"] == FOLDER and note["status"] == "unavailable"
    assert note["name"] == "Specs"
    assert note["reason"].startswith("Lost access to Specs")
    # Still hidden, and still said, on the sync after.
    result = await _sync(pat, source)
    assert await _live(tenant_id, source["id"]) == {DOC_A}
    assert [n["external_id"] for n in result["source"]["unavailable_items"]] == [FOLDER]

    # Shared again (Drive's change log need not say so): the docs come back.
    drive.gone.discard(FOLDER)
    drive.refuse.pop(FOLDER, None)
    result = await _sync(pat, source)
    assert result["outcome"] == "completed", result
    assert await _live(tenant_id, source["id"]) == {DOC_A, IN_FOLDER}
    assert result["source"]["unavailable_items"] == []


async def test_a_lost_folder_removed_from_the_source_leaves_no_note(tenant_id, drive):
    drive.folder(FOLDER, "Specs")
    drive.doc(IN_FOLDER, "Spec", folder=FOLDER)
    drive.doc(DOC_A, "A")
    pat, source = await _setup(tenant_id, drive, {"docs": [DOC_A], "folders": [FOLDER]})
    drive.unshare(FOLDER)
    await _sync(pat, source)
    edited = await _narrow(tenant_id, drive, pat, source, {"docs": [DOC_A]})
    assert edited["unavailable_items"] == []
    assert await _live(tenant_id, source["id"]) == {DOC_A}


async def test_narrowing_keeps_what_the_last_sync_said_about_the_rest(tenant_id, drive):
    """A folder still lost keeps saying so after an unrelated pick is removed (its docs
    stay hidden), so the source never hides docs without saying why."""
    other = "1FolderOther"
    drive.folder(FOLDER, "Specs")
    drive.doc(IN_FOLDER, "Spec", folder=FOLDER)
    drive.folder(other, "Plans")
    drive.doc(DOC_A, "A")
    pat, source = await _setup(tenant_id, drive, {"docs": [DOC_A], "folders": [FOLDER, other]})
    drive.unshare(FOLDER)
    await _sync(pat, source)
    edited = await _narrow(tenant_id, drive, pat, source, {"folders": [FOLDER, other]})
    assert [n["external_id"] for n in edited["unavailable_items"]] == [FOLDER]
    assert await _live(tenant_id, source["id"]) == set()


async def test_a_lost_folder_without_a_known_tree_still_hides_its_docs(tenant_id, drive):
    drive.folder(FOLDER, "Specs")
    drive.doc(IN_FOLDER, "Spec", folder=FOLDER)
    drive.doc(DOC_A, "A")
    pat, source = await _setup(tenant_id, drive, {"docs": [DOC_A], "folders": [FOLDER]})
    await _reset_cursor(tenant_id, source["id"])
    drive.unshare(FOLDER)
    result = await _sync(pat, source)
    assert result["outcome"] == "completed", result
    assert await _live(tenant_id, source["id"]) == {DOC_A}


async def test_a_doc_picked_on_its_own_in_a_lost_folder_stays(tenant_id, drive):
    drive.folder(FOLDER, "Specs")
    drive.doc(IN_FOLDER, "Spec", folder=FOLDER)
    drive.doc(IN_SUB, "Shared with me directly", folder=FOLDER)
    pat, source = await _setup(tenant_id, drive, {"docs": [IN_SUB], "folders": [FOLDER]})
    _refused(404, "notFound")(drive)
    await _sync(pat, source)
    assert await _live(tenant_id, source["id"]) == {IN_SUB}


FAILURES = {
    "timeout": lambda drive: drive.slow.add(FOLDER),
    "500": lambda drive: drive.refuse.update({FOLDER: (500, "backendError")}),
    "503": lambda drive: drive.refuse.update({FOLDER: (503, "")}),
}


@pytest.mark.parametrize("failure", list(FAILURES))
async def test_a_folder_that_times_out_or_fails_hides_nothing(tenant_id, drive, failure):
    drive.folder(FOLDER, "Specs")
    drive.doc(IN_FOLDER, "Spec", folder=FOLDER)
    drive.doc(DOC_A, "A")
    pat, source = await _setup(tenant_id, drive, {"docs": [DOC_A], "folders": [FOLDER]})
    FAILURES[failure](drive)
    drive._change(FOLDER)  # so the folders are listed again
    result = await _sync(pat, source)
    assert result["outcome"] == "error", result
    assert result["deleted"] == 0
    assert await _live(tenant_id, source["id"]) == {DOC_A, IN_FOLDER}


async def test_folder_docs_are_capped_with_a_note(tenant_id, drive, monkeypatch):
    monkeypatch.setattr(google_docs, "MAX_FOLDER_DOCS", 2)
    drive.folder(FOLDER, "Specs")
    for i in range(3):
        drive.doc(f"1DocMany{i:04d}", f"Doc {i}", folder=FOLDER)
    pat, source = await _setup(tenant_id, drive, {"folders": [FOLDER]})
    assert len(await _live(tenant_id, source["id"])) == 2
    row = await _row(tenant_id, source["id"])
    (note,) = row.unavailable_items
    assert note["status"] == "limited" and note["external_id"] == FOLDER
    assert note["reason"].startswith("Only the first 2 docs")


async def test_unchanged_folders_are_not_listed_again(tenant_id, drive):
    drive.folder(FOLDER, "Specs")
    drive.doc(IN_FOLDER, "Spec", folder=FOLDER)
    pat, source = await _setup(tenant_id, drive, {"folders": [FOLDER]})
    drive.unrelated_change()
    drive.calls.clear()
    result = await _sync(pat, source)
    assert result["outcome"] == "completed", result
    assert drive.calls == ["changes"]

    # A doc edited in the folder: listed again, and only that doc exported.
    drive.files[IN_FOLDER]["modifiedTime"] = LATER
    drive._change(IN_FOLDER)
    drive.calls.clear()
    result = await _sync(pat, source)
    assert "files" in drive.calls and f"files/{IN_FOLDER}/export" in drive.calls
    assert result["upserted"] == 1


async def test_an_unreadable_picked_doc_is_reported_once_and_read_again_later(tenant_id, drive):
    drive.folder(FOLDER, "Specs")
    drive.doc(IN_FOLDER, "Spec", folder=FOLDER)
    drive.doc(DOC_B, "B")
    pat, source = await _setup(tenant_id, drive, {"folders": [FOLDER], "docs": [DOC_B]})
    drive.unshare(DOC_B)
    await _sync(pat, source)  # listed again: B is gone, reported and deleted
    drive.unrelated_change()
    drive.calls.clear()
    result = await _sync(pat, source)
    assert "files" not in drive.calls  # the folders were not listed again
    assert [u["external_id"] for u in result["source"]["unavailable_items"]] == [DOC_B]

    drive.gone.discard(DOC_B)  # shared again; Drive's log says nothing about it
    result = await _sync(pat, source)
    assert result["source"]["unavailable_items"] == []
    assert await _live(tenant_id, source["id"]) == {IN_FOLDER, DOC_B}


async def test_folders_are_listed_again_after_a_while(tenant_id, drive, monkeypatch):
    drive.folder(FOLDER, "Specs")
    drive.doc(IN_FOLDER, "Spec", folder=FOLDER)
    pat, source = await _setup(tenant_id, drive, {"folders": [FOLDER]})
    async with tenant_session(tenant_id) as s:
        row = await s.get(Source, source["id"])
        stale = datetime.now(UTC) - timedelta(seconds=google_docs.RELIST_SECONDS + 60)
        row.cursor = {**row.cursor, "listing": {**row.cursor["listing"], "at": stale.isoformat()}}
        await s.commit()
    drive.calls.clear()
    await _sync(pat, source)
    assert "files" in drive.calls


# --- docs in a picked folder owned outside the company (S5, owner 2026-10-20) --------


async def test_folder_docs_owned_outside_the_company_are_skipped(tenant_id, drive):
    drive.folder(FOLDER, "Specs")
    drive.doc(IN_FOLDER, "Spec", folder=FOLDER)
    drive.doc(OUTSIDE, "Vendor plan", folder=FOLDER, owner=EVE)
    pat, source = await _setup(tenant_id, drive, {"folders": [FOLDER]})
    assert await _live(tenant_id, source["id"]) == {IN_FOLDER}
    row = await _row(tenant_id, source["id"])
    assert row.unavailable_items == [
        {
            "external_id": OUTSIDE,
            "reason": "Skipped: owned outside example.com",
            "name": "Vendor plan",
            "status": "skipped",
        }
    ]
    # Still listed after a sync that does not list the folders again.
    drive.unrelated_change()
    result = await _sync(pat, source)
    assert [u["external_id"] for u in result["source"]["unavailable_items"]] == [OUTSIDE]


async def test_a_doc_owned_outside_picked_on_its_own_is_pulled_in(tenant_id, drive):
    drive.folder(FOLDER, "Specs")
    drive.doc(OUTSIDE, "Vendor plan", folder=FOLDER, owner=EVE)
    pat, source = await _setup(tenant_id, drive, {"folders": [FOLDER], "docs": [OUTSIDE]})
    assert await _live(tenant_id, source["id"]) == {OUTSIDE}
    assert (await _row(tenant_id, source["id"])).unavailable_items == []


async def test_include_and_flag_is_one_setting(tenant_id, drive, monkeypatch):
    monkeypatch.setenv("ORACLE_DRIVE_DOCS_OWNED_OUTSIDE", "include_and_flag")
    get_settings.cache_clear()
    drive.folder(FOLDER, "Specs")
    drive.doc(OUTSIDE, "Vendor plan", folder=FOLDER, owner=EVE)
    pat, source = await _setup(tenant_id, drive, {"folders": [FOLDER]})
    assert await _live(tenant_id, source["id"]) == {OUTSIDE}
    (note,) = (await _row(tenant_id, source["id"])).unavailable_items
    assert note["status"] == "flagged"
    assert note["reason"] == "Owned outside example.com"
    async with tenant_session(tenant_id) as s:
        item = await s.scalar(select(SourceItem).where(SourceItem.external_id == OUTSIDE))
    assert item.acl["owned_outside_company"] is True


async def test_company_domains_come_from_the_setting_first(tenant_id, monkeypatch):
    await make_person(tenant_id, "pat@example.com")
    await make_person(tenant_id, "sam@gmail.com")
    async with tenant_session(tenant_id) as s:
        assert await service.company_domains(s, tenant_id) == ["example.com"]
    monkeypatch.setenv("ORACLE_IAP_ALLOWED_DOMAINS", '["corp.example"]')
    get_settings.cache_clear()
    async with tenant_session(tenant_id) as s:
        assert await service.company_domains(s, tenant_id) == ["corp.example"]


async def test_people_cannot_set_the_company_domains(tenant_id, drive):
    drive.doc(DOC_A, "A")
    pat = (await make_person(tenant_id, "pat@example.com")).user
    conn = await make_connection(tenant_id, pat, "google", scopes=READONLY)
    async with client_for(pat) as c:
        resp = await c.post(
            "/v1/sources",
            json={"kind": "google_docs", "name": "Docs", "connection_id": str(conn),
                  "config": {"docs": [DOC_A], "_company_domains": ["elsewhere.org"]}},
        )  # fmt: skip
    assert resp.status_code == 422


async def test_public_mail_domains_are_not_company_domains(tenant_id):
    for email in ("pat@example.com", "sam@yahoo.co.uk", "kim@pm.me", "lee@GMX.de"):
        await make_person(tenant_id, email)
    async with tenant_session(tenant_id) as s:
        assert await service.company_domains(s, tenant_id) == ["example.com"]
    for domain in (
        "yahoo.co.uk", "hotmail.co.uk", "aol.com", "msn.com", "pm.me", "gmx.com", "gmx.de",
        "gmx.net", "yandex.com", "yandex.ru", "mail.ru", "qq.com", "zoho.com", "fastmail.com",
        "hey.com", "proton.me", "protonmail.com", "icloud.com", "me.com", "live.com",
        "outlook.com",
    ):  # fmt: skip
        assert domain in service.PUBLIC_MAIL_DOMAINS


async def test_with_no_company_domain_folder_docs_are_skipped_and_say_why(tenant_id, drive):
    """Every member on a public mail provider: no company domain is known, so the
    outside-owner check fails closed instead of turning off."""
    drive.folder(FOLDER, "Specs")
    drive.doc(IN_FOLDER, "Mine", folder=FOLDER)
    drive.doc(DOC_A, "Picked on its own")
    pat = (await make_person(tenant_id, "pat@gmail.com")).user
    conn = await make_connection(tenant_id, pat, "google", scopes=READONLY)
    async with client_for(pat) as c:
        resp = await c.post(
            "/v1/sources",
            json={"kind": "google_docs", "name": "Docs", "connection_id": str(conn),
                  "config": {"folders": [FOLDER], "docs": [DOC_A]}},
        )  # fmt: skip
        source = resp.json()
        result = (await c.post(f"/v1/sources/{source['id']}/sync")).json()
    assert result["outcome"] == "completed", result
    assert await _live(tenant_id, source["id"]) == {DOC_A}
    (note,) = (await _row(tenant_id, source["id"])).unavailable_items
    assert note["external_id"] == IN_FOLDER and note["status"] == "skipped"
    assert note["reason"] == "Skipped: company domain not set"


async def test_folders_walked_per_sync_are_capped_and_keep_what_came_from_the_rest(
    tenant_id, drive, monkeypatch
):
    drive.folder(FOLDER, "Specs")
    drive.doc(IN_FOLDER, "Top", folder=FOLDER)
    drive.folder(SUB, "Deeper", parent=FOLDER)
    drive.doc(IN_SUB, "Deep", folder=SUB)
    pat, source = await _setup(tenant_id, drive, {"folders": [FOLDER]})
    assert await _live(tenant_id, source["id"]) == {IN_FOLDER, IN_SUB}

    # One folder per sync: the sub-folder is not listed, and what came from it stays.
    monkeypatch.setattr(google_docs, "MAX_FOLDERS_WALKED", 1)
    monkeypatch.setattr(google_docs, "RELIST_SECONDS", 0)
    drive.calls.clear()
    result = await _sync(pat, source)
    assert result["outcome"] == "completed", result
    assert result["deleted"] == 0
    assert await _live(tenant_id, source["id"]) == {IN_FOLDER, IN_SUB}
    assert sum(1 for c in drive.calls if c == "files") == 1
    (note,) = (await _row(tenant_id, source["id"])).unavailable_items
    assert note["status"] == "limited" and note["external_id"] == FOLDER
    assert note["reason"].startswith("Only the first 1 folders")
    # Still kept on the sync after.
    result = await _sync(pat, source)
    assert result["deleted"] == 0
    assert await _live(tenant_id, source["id"]) == {IN_FOLDER, IN_SUB}


async def test_renaming_picked_items_does_not_ask_drive_again(tenant_id, drive):
    drive.doc(DOC_A, "A")
    drive.doc(DOC_B, "B")
    drive.doc("1DocMissing", "Unshared later")
    pat, source = await _setup(tenant_id, drive, {"docs": [DOC_A, DOC_B, "1DocMissing"]})
    drive.unshare("1DocMissing")
    await _sync(pat, source)
    report = (await _row(tenant_id, source["id"])).unavailable_items
    assert report
    drive.calls.clear()
    names = {DOC_A: "A renamed", DOC_B: "B"}
    edited = await _patch(
        pat, source, {"config": {"docs": [DOC_A, DOC_B, "1DocMissing"], "names": names}}
    )
    assert drive.calls == []
    assert edited["config"]["names"] == names
    # What the last sync reported still stands.
    assert (await _row(tenant_id, source["id"])).unavailable_items == report
    # A names-only edit still checks the shape of what it is given.
    async with client_for(pat) as c:
        bad = await c.patch(
            f"/v1/sources/{source['id']}",
            json={"config": {"docs": [DOC_A, DOC_B, "1DocMissing"], "names": {DOC_A: 1}}},
        )
    assert bad.status_code == 422
    # Adding a pick does ask Drive; removing one does not (narrowing takes effect on save).
    drive.doc("1DocNew0000", "New")
    await _patch(pat, source, {"config": {"docs": [DOC_A, DOC_B, "1DocNew0000"]}})
    assert "about" in drive.calls
    drive.calls.clear()
    await _patch(pat, source, {"config": {"docs": [DOC_A], "names": {DOC_A: "A"}}})
    assert drive.calls == []


async def test_names_only_name_what_is_picked(tenant_id, drive):
    drive.doc(DOC_A, "A")
    pat, source = await _setup(tenant_id, drive, {"docs": [DOC_A]})
    for names in (
        {DOC_B: "Not picked"},
        {DOC_A: "x" * 501},
        {DOC_A: "A", DOC_B: "B"},
    ):
        async with client_for(pat) as c:
            resp = await c.patch(
                f"/v1/sources/{source['id']}", json={"config": {"docs": [DOC_A], "names": names}}
            )
        assert resp.status_code == 422, names
    await _patch(pat, source, {"config": {"docs": [DOC_A], "names": {DOC_A: "x" * 500}}})


async def test_company_domains_are_explicit_and_never_inferred_by_default(tenant_id, monkeypatch):
    """S5 (owner, 2026-10-20): ORACLE_IAP_ALLOWED_DOMAINS and the owner's setting, never
    the members' addresses outside local development."""
    from oracle.tenant_settings import TenantSetting

    monkeypatch.delenv("ORACLE_INFER_COMPANY_DOMAINS")
    get_settings.cache_clear()
    await make_person(tenant_id, "pat@example.com")
    async with tenant_session(tenant_id) as s:
        assert await service.company_domains(s, tenant_id) == []
        s.add(TenantSetting(key="company_email_domains", value=["corp.example"]))
        await s.commit()
        assert await service.company_domains(s, tenant_id) == ["corp.example"]
    monkeypatch.setenv("ORACLE_IAP_ALLOWED_DOMAINS", '["iap.example"]')
    get_settings.cache_clear()
    async with tenant_session(tenant_id) as s:
        assert await service.company_domains(s, tenant_id) == ["corp.example", "iap.example"]


async def test_folder_docs_skipped_in_production_until_a_domain_is_set(
    tenant_id, drive, monkeypatch
):
    from oracle.tenant_settings import TenantSetting

    monkeypatch.delenv("ORACLE_INFER_COMPANY_DOMAINS")
    get_settings.cache_clear()
    drive.folder(FOLDER, "Specs")
    drive.doc(IN_FOLDER, "Spec", folder=FOLDER)
    pat, source = await _setup(tenant_id, drive, {"folders": [FOLDER]})
    assert await _live(tenant_id, source["id"]) == set()
    (note,) = (await _row(tenant_id, source["id"])).unavailable_items
    assert note["reason"] == "Skipped: company domain not set"

    async with tenant_session(tenant_id) as s:
        s.add(TenantSetting(key="company_email_domains", value=["example.com"]))
        await s.commit()
    result = await _sync(pat, source)
    assert result["outcome"] == "completed", result
    assert await _live(tenant_id, source["id"]) == {IN_FOLDER}
    assert (await _row(tenant_id, source["id"])).unavailable_items == []


async def test_a_shared_drive_is_the_companys_only_when_the_owner_lists_it(tenant_id, drive):
    """A doc in a picked folder in a shared drive not on company_shared_drives is skipped
    and listed; once the owner lists the drive, the next sync pulls it in. A doc in that
    drive picked on its own is always pulled in."""
    from oracle.tenant_settings import TenantSetting

    drive.folder(FOLDER, "Joint work")
    drive.doc(IN_FOLDER, "Mine", folder=FOLDER)
    drive.doc(OUTSIDE, "Partner plan", folder=FOLDER, drive_id="0APartner0000")
    drive.doc(DOC_B, "Partner brief", drive_id="0APartner0000")
    pat, source = await _setup(tenant_id, drive, {"folders": [FOLDER], "docs": [DOC_B]})
    assert await _live(tenant_id, source["id"]) == {IN_FOLDER, DOC_B}
    assert (await _row(tenant_id, source["id"])).unavailable_items == [
        {
            "external_id": OUTSIDE,
            "reason": "Skipped: in a shared drive outside the company",
            "name": "Partner plan",
            "status": "skipped",
        }
    ]

    async with tenant_session(tenant_id) as s:
        s.add(
            TenantSetting(
                key="company_shared_drives", value=[{"id": "0APartner0000", "name": "Joint"}]
            )
        )
        await s.commit()
    drive.unrelated_change()
    result = await _sync(pat, source)
    assert result["outcome"] == "completed", result
    assert await _live(tenant_id, source["id"]) == {IN_FOLDER, OUTSIDE, DOC_B}
    assert (await _row(tenant_id, source["id"])).unavailable_items == []


def test_owned_outside():
    from oracle.sources.connectors.google_docs import owned_outside

    mine = {"owners": [PAT]}
    theirs = {"owners": [EVE]}
    shared = {"driveId": "0AShared00000", "owners": []}
    assert owned_outside(mine, ["example.com"]) is None
    assert owned_outside(theirs, ["example.com"]) == "owner"
    assert owned_outside(mine, []) == "no_domains"
    assert owned_outside(shared, ["example.com"]) == "shared_drive"
    assert owned_outside(shared, [], ["0AShared00000"]) is None


async def test_a_stored_source_with_bad_names_still_syncs(tenant_id, drive):
    """Saves refuse unpicked or oversized names, but a config already stored with them must
    not fail its sync with a config error: the sync ignores or trims them."""
    drive.doc(DOC_A, "A")
    pat, source = await _setup(tenant_id, drive, {"docs": [DOC_A]})
    await _reset_cursor(
        tenant_id,
        source["id"],
        {"docs": [DOC_A], "names": {DOC_A: "x" * 900, DOC_B: "never picked"}},
    )
    result = await _sync(pat, source)
    assert result["outcome"] == "completed", result
    assert await _live(tenant_id, source["id"]) == {DOC_A}


async def test_hides_commit_before_exports_so_a_failing_export_cannot_roll_them_back(
    tenant_id, drive
):
    """Owner 2026-10-20: folder X is refused (404) while doc Y keeps timing out on export.
    X's docs are hidden after the sync and stay hidden on the next one, and Y is retried
    each sync (the listing is not marked done) and shows as the source's error."""
    drive.folder(FOLDER, "Specs")
    drive.doc(IN_FOLDER, "Spec", folder=FOLDER)
    drive.doc(DOC_A, "A")
    pat, source = await _setup(tenant_id, drive, {"docs": [DOC_A], "folders": [FOLDER]})
    assert await _live(tenant_id, source["id"]) == {DOC_A, IN_FOLDER}

    drive.unshare(FOLDER)
    drive.files[DOC_A]["modifiedTime"] = LATER
    drive.export_slow.add(DOC_A)
    drive._change(DOC_A)
    for _ in range(2):
        drive.calls.clear()
        result = await _sync(pat, source)
        assert result["outcome"] == "error", result
        assert await _live(tenant_id, source["id"]) == {DOC_A}
        assert f"export-timeout:{DOC_A}" in drive.calls  # retried
        assert (await _row(tenant_id, source["id"])).last_error
