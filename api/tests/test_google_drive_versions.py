"""Google Docs sources under the save and sync rules every source kind follows (#122
merged with #121): a Drive save names the config_version it read (base_version), so one
without it is refused (422) and a stale one too (409), and a names-only edit counts as a
change. A pure narrowing (only picks removed) asks Drive nothing, so an expired
connection does not stop it, and an error status stays. A sync holds the source row
before each write and stops (superseded) when the source or the company's Drive settings
changed; it then tidies by what changed: items whose drive and owner are unknown only
after a company narrowing. Runs the real connector against the fake Drive of
test_google_drive_narrowing."""

import asyncio

import httpx
import pytest
from sqlalchemy import select, update

from oracle.config import get_settings
from oracle.sources import base, service
from oracle.sources.connectors.google_docs import GoogleDocsConnector
from oracle.sources.models import Source, SourceItem
from oracle.tenancy import tenant_session
from oracle.tenant_settings import TenantSetting
from tests.sources_helpers import client_for, make_connection
from tests.test_google_drive_narrowing import (
    DOC_A,
    DOC_B,
    FOLDER,
    IN_FOLDER,
    IN_SUB,
    READONLY,
    SENSITIVE,
    Drive,
    _legacy_acl,
    _live,
    _patch,
    _reset_cursor,
    _row,
    _set_connection_status,
    _setup,
    _sync,
)


@pytest.fixture
def drive(monkeypatch):
    service.load_connectors()
    fake = Drive()
    real = GoogleDocsConnector(httpx.AsyncClient(transport=httpx.MockTransport(fake)))
    monkeypatch.setitem(base._registry, "google_docs", real)
    return fake


@pytest.fixture(autouse=True)
def _settings(monkeypatch):
    # As test_google_drive_narrowing: the company's domains from the members' addresses
    # (pat@example.com) until the owner's setting names them.
    monkeypatch.setenv("ORACLE_INFER_COMPANY_DOMAINS", "true")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


async def _raw_patch(pat, source, body):
    async with client_for(pat) as c:
        return await c.patch(f"/v1/sources/{source['id']}", json=body)


async def test_a_drive_save_without_base_version_is_refused_and_changes_nothing(tenant_id, drive):
    drive.doc(DOC_A, "A")
    drive.doc(SENSITIVE, "SENSITIVE")
    pat, source = await _setup(tenant_id, drive, {"docs": [DOC_A, SENSITIVE]})
    other = await make_connection(tenant_id, pat, "google", scopes=READONLY)
    drive.calls.clear()
    for body in (
        {"config": {"docs": [DOC_A]}},
        {"config": {"docs": [DOC_A, SENSITIVE], "names": {DOC_A: "A"}}},
        {"connection_id": str(other)},
    ):
        resp = await _raw_patch(pat, source, body)
        assert resp.status_code == 422, (body, resp.text)
        assert resp.json()["code"] == "base_version_required"
    assert drive.calls == []
    row = await _row(tenant_id, source["id"])
    assert row.config == {"docs": [DOC_A, SENSITIVE]}
    assert row.config_version == 1
    assert await _live(tenant_id, source["id"]) == {DOC_A, SENSITIVE}


async def test_a_stale_drive_save_is_refused_and_hides_nothing(tenant_id, drive):
    drive.doc(DOC_A, "A")
    drive.doc(SENSITIVE, "SENSITIVE")
    pat, source = await _setup(tenant_id, drive, {"docs": [DOC_A, SENSITIVE]})
    loaded = source["config_version"]
    # Another tab saves first (a rename of the picks).
    saved = await _patch(
        pat, source, {"config": {"docs": [DOC_A, SENSITIVE], "names": {DOC_A: "A"}}}
    )
    assert saved["config_version"] == loaded + 1
    drive.calls.clear()

    stale = await _raw_patch(pat, source, {"config": {"docs": [DOC_A]}, "base_version": loaded})
    assert stale.status_code == 409, stale.text
    assert stale.json()["code"] == "source_changed"
    assert drive.calls == []
    row = await _row(tenant_id, source["id"])
    assert row.config == {"docs": [DOC_A, SENSITIVE], "names": {DOC_A: "A"}}
    assert row.config_version == loaded + 1
    assert await _live(tenant_id, source["id"]) == {DOC_A, SENSITIVE}


async def test_a_names_only_drive_edit_bumps_the_config_version(tenant_id, drive):
    drive.doc(DOC_A, "A")
    drive.doc("1DocMissing", "Unshared later")
    pat, source = await _setup(tenant_id, drive, {"docs": [DOC_A, "1DocMissing"]})
    drive.unshare("1DocMissing")
    await _sync(pat, source)
    before = await _row(tenant_id, source["id"])
    assert before.unavailable_items
    drive.calls.clear()

    names = {DOC_A: "A renamed"}
    edited = await _patch(pat, source, {"config": {"docs": [DOC_A, "1DocMissing"], "names": names}})
    assert edited["config_version"] == before.config_version + 1
    assert edited["config"]["names"] == names
    assert drive.calls == []
    after = await _row(tenant_id, source["id"])
    # Nothing else changed: the report and the cursor stand.
    assert after.unavailable_items == before.unavailable_items
    assert after.cursor == before.cursor
    # A form that loaded the version before the rename is now stale.
    stale = await _raw_patch(
        pat, source, {"config": {"docs": [DOC_A]}, "base_version": before.config_version}
    )
    assert stale.status_code == 409


async def test_a_drive_pure_narrowing_with_an_expired_connection_saves_and_sweeps(tenant_id, drive):
    drive.folder(FOLDER, "Specs")
    drive.doc(IN_FOLDER, "Spec", folder=FOLDER)
    drive.doc(DOC_A, "A")
    pat, source = await _setup(tenant_id, drive, {"docs": [DOC_A], "folders": [FOLDER]})
    await _set_connection_status(tenant_id, source["id"], "expired")
    async with tenant_session(tenant_id) as s:
        await s.execute(
            update(Source)
            .where(Source.id == source["id"])
            .values(status="error", last_error="The connection was rejected: expired")
        )
        await s.commit()
    drive.calls.clear()

    edited = await _patch(pat, source, {"config": {"docs": [DOC_A]}})
    assert drive.calls == []
    assert await _live(tenant_id, source["id"]) == {DOC_A}
    assert edited["config_version"] == source["config_version"] + 1
    # Nothing was asked of Drive, so the rejected connection still stands.
    assert edited["status"] == "error"
    assert edited["last_error"] == "The connection was rejected: expired"
    # A widening is still checked with Drive, which needs a working connection.
    widen = await _raw_patch(
        pat, source, {"config": {"docs": [DOC_A, DOC_B]}, "base_version": edited["config_version"]}
    )
    assert widen.status_code == 422, widen.text
    assert "expired" in widen.json()["detail"]


async def test_a_drive_narrowing_records_the_deleting_transaction(tenant_id, drive):
    """As every delete does (pin stability): a hidden item carries deleted_xid, so a pin
    taken before the save committed still reads it."""
    drive.doc(DOC_A, "A")
    drive.doc(SENSITIVE, "SENSITIVE")
    pat, source = await _setup(tenant_id, drive, {"docs": [DOC_A, SENSITIVE]})
    await _patch(pat, source, {"config": {"docs": [DOC_A]}})
    async with tenant_session(tenant_id) as s:
        hidden = await s.scalar(
            select(SourceItem).where(
                SourceItem.source_id == source["id"], SourceItem.external_id == SENSITIVE
            )
        )
    assert hidden.deleted_at is not None
    assert hidden.deleted_xid is not None


async def _sync_held_at_listing(drive, pat, source, doc):
    """A sync held while it reads ``doc``'s metadata (listing, before any item write and
    before its early checkpoint): the change made meanwhile is first seen when that
    checkpoint writes on the source."""
    started, release = asyncio.Event(), asyncio.Event()
    drive.hold_meta[doc] = (started, release)
    drive.calls.clear()
    running = asyncio.create_task(_sync(pat, source))
    await asyncio.wait_for(started.wait(), 10)
    return running, release


async def _legacy_folder_source(tenant_id, drive):
    drive.folder(FOLDER, "Specs")
    drive.doc(IN_FOLDER, "Legacy", folder=FOLDER)
    drive.doc(IN_SUB, "Normal", folder=FOLDER)
    drive.doc(DOC_A, "A")
    pat, source = await _setup(tenant_id, drive, {"folders": [FOLDER], "docs": [DOC_A]})
    assert await _live(tenant_id, source["id"]) == {DOC_A, IN_FOLDER, IN_SUB}
    async with tenant_session(tenant_id) as s:
        s.add(TenantSetting(key="company_email_domains", value=["example.com", "other.org"]))
        await s.commit()
    # Stored before Oracle kept a doc's drive and owners: whose it is is unknown.
    await _legacy_acl(tenant_id, source["id"], {IN_FOLDER})
    await _reset_cursor(tenant_id, source["id"])
    return pat, source


async def test_a_sync_superseded_by_a_company_narrowing_still_hides_unknown_items(tenant_id, drive):
    pat, source = await _legacy_folder_source(tenant_id, drive)
    running, release = await _sync_held_at_listing(drive, pat, source, DOC_A)
    try:
        async with tenant_session(tenant_id) as s:
            setting = await s.scalar(
                select(TenantSetting).where(TenantSetting.key == "company_email_domains")
            )
            setting.value = ["example.com"]
            await s.commit()
    finally:
        release.set()
        first = await asyncio.wait_for(running, 10)
    assert first["outcome"] == "superseded", first
    assert not [c for c in drive.calls if c.endswith("/export")]
    # The legacy doc's owner is unknown: hidden after a company narrowing (the next sync
    # reads it again if it is the company's). A doc picked on its own always stays.
    assert await _live(tenant_id, source["id"]) == {DOC_A, IN_SUB}


async def test_a_sync_superseded_by_a_persons_edit_does_not_hide_unknown_items(tenant_id, drive):
    pat, source = await _legacy_folder_source(tenant_id, drive)
    running, release = await _sync_held_at_listing(drive, pat, source, DOC_A)
    try:
        await _patch(pat, source, {"config": {"folders": [FOLDER]}})
    finally:
        release.set()
        first = await asyncio.wait_for(running, 10)
    assert first["outcome"] == "superseded", first
    assert not [c for c in drive.calls if c.endswith("/export")]
    # Only what the person removed is hidden; the legacy doc stays.
    assert await _live(tenant_id, source["id"]) == {IN_FOLDER, IN_SUB}
