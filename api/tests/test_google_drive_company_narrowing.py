"""Company Drive settings narrow every member's Drive sources on save (S5, owner
2026-10-20): when an owner removes a shared drive from ``company_shared_drives`` or a
domain from ``company_email_domains``, the docs in picked folders that now fall outside
are soft-deleted across every member's Google Docs sources in that request, with no
Drive call, from the item metadata already stored. A doc whose drive or owner is not
known is deleted too and read again on the next sync. Docs picked one by one stay.
Public mail providers are refused as company domains. A sync running across the change
saves nothing more (superseded). Runs the real connector against the fake Drive of
test_google_drive_narrowing."""

import asyncio

import httpx
import pytest
from sqlalchemy import select

from oracle.config import get_settings
from oracle.sources import base, service
from oracle.sources.connectors.google_docs import GoogleDocsConnector
from oracle.sources.models import SourceItem
from oracle.tenancy import tenant_session
from tests.connection_helpers import make_person
from tests.sources_helpers import client_for, make_connection
from tests.test_google_drive_narrowing import (
    DOC_B,
    FOLDER,
    IN_FOLDER,
    OUTSIDE,
    PAT,
    READONLY,
    Drive,
    _held_sync,
)

PRODUCT = "0AProduct0000"
PARTNER = "0APartner0000"
IN_PRODUCT = "1DocInProduct"
KIM = {"displayName": "Kim", "emailAddress": "kim@partner.example"}


@pytest.fixture
def drive(monkeypatch):
    service.load_connectors()
    fake = Drive()
    real = GoogleDocsConnector(httpx.AsyncClient(transport=httpx.MockTransport(fake)))
    monkeypatch.setitem(base._registry, "google_docs", real)
    return fake


@pytest.fixture(autouse=True)
def _explicit_domains(monkeypatch):
    # Production: the company's domains are set explicitly, never inferred.
    monkeypatch.delenv("ORACLE_INFER_COMPANY_DOMAINS", raising=False)
    monkeypatch.delenv("ORACLE_IAP_ALLOWED_DOMAINS", raising=False)
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


async def _put(owner, key: str, value) -> httpx.Response:
    async with client_for(owner) as c:
        return await c.put(f"/v1/settings/{key}", json={"value": value})


async def _source(tenant_id, user, config) -> dict:
    conn = await make_connection(tenant_id, user, "google", scopes=READONLY)
    async with client_for(user) as c:
        resp = await c.post(
            "/v1/sources",
            json={"kind": "google_docs", "name": "Docs", "connection_id": str(conn),
                  "config": config},
        )  # fmt: skip
        assert resp.status_code == 201, resp.text
        source = resp.json()
        result = (await c.post(f"/v1/sources/{source['id']}/sync")).json()
    assert result["outcome"] == "completed", result
    return source


async def _sync(user, source) -> dict:
    async with client_for(user) as c:
        return (await c.post(f"/v1/sources/{source['id']}/sync")).json()


async def _live(tenant_id, source_id) -> set[str]:
    async with tenant_session(tenant_id) as s:
        rows = await s.scalars(
            select(SourceItem.external_id).where(
                SourceItem.source_id == source_id, SourceItem.deleted_at.is_(None)
            )
        )
        return set(rows)


async def _people(tenant_id):
    owner = (await make_person(tenant_id, "pat@example.com", "owner")).user
    member = (await make_person(tenant_id, "sam@example.com", "commenter")).user
    return owner, member


def _company_folder(drive: Drive) -> None:
    drive.folder(FOLDER, "Joint work")
    drive.doc(IN_FOLDER, "Mine", folder=FOLDER, owner=PAT)
    drive.doc(IN_PRODUCT, "Product plan", folder=FOLDER, drive_id=PRODUCT)
    drive.doc(OUTSIDE, "Partner notes", folder=FOLDER, owner=KIM)
    # In the Product shared drive, picked on its own by the member.
    drive.doc(DOC_B, "Product brief", drive_id=PRODUCT)


async def test_removing_a_shared_drive_deletes_every_members_docs_from_it_on_save(tenant_id, drive):
    owner, member = await _people(tenant_id)
    _company_folder(drive)
    assert (await _put(owner, "company_email_domains", ["example.com"])).status_code == 200
    drives = [{"id": PRODUCT, "name": "Product"}, {"id": PARTNER, "name": "Partner"}]
    assert (await _put(owner, "company_shared_drives", drives)).status_code == 200
    mine = await _source(tenant_id, owner, {"folders": [FOLDER]})
    theirs = await _source(tenant_id, member, {"folders": [FOLDER], "docs": [DOC_B]})
    assert await _live(tenant_id, mine["id"]) == {IN_FOLDER, IN_PRODUCT}
    assert await _live(tenant_id, theirs["id"]) == {IN_FOLDER, IN_PRODUCT, DOC_B}

    drive.calls.clear()
    resp = await _put(owner, "company_shared_drives", [{"id": PARTNER, "name": "Partner"}])
    assert resp.status_code == 200, resp.text
    assert drive.calls == []
    assert await _live(tenant_id, mine["id"]) == {IN_FOLDER}
    # The doc the member picked on its own stays, whoever owns it.
    assert await _live(tenant_id, theirs["id"]) == {IN_FOLDER, DOC_B}

    # The next sync lists it as skipped and does not bring it back.
    result = await _sync(member, theirs)
    assert result["outcome"] == "completed", result
    assert await _live(tenant_id, theirs["id"]) == {IN_FOLDER, DOC_B}
    skipped = [u["external_id"] for u in result["source"]["unavailable_items"]]
    assert IN_PRODUCT in skipped


async def test_removing_a_domain_deletes_every_members_docs_owned_there_on_save(tenant_id, drive):
    owner, member = await _people(tenant_id)
    _company_folder(drive)
    domains = ["example.com", "partner.example"]
    assert (await _put(owner, "company_email_domains", domains)).status_code == 200
    mine = await _source(tenant_id, owner, {"folders": [FOLDER]})
    theirs = await _source(tenant_id, member, {"folders": [FOLDER]})
    assert await _live(tenant_id, theirs["id"]) == {IN_FOLDER, OUTSIDE}

    drive.calls.clear()
    resp = await _put(owner, "company_email_domains", ["example.com"])
    assert resp.status_code == 200, resp.text
    assert drive.calls == []
    assert await _live(tenant_id, mine["id"]) == {IN_FOLDER}
    assert await _live(tenant_id, theirs["id"]) == {IN_FOLDER}

    # Adding it back deletes nothing; the next sync reads the doc again.
    assert (await _put(owner, "company_email_domains", domains)).status_code == 200
    assert await _live(tenant_id, theirs["id"]) == {IN_FOLDER}
    result = await _sync(member, theirs)
    assert result["outcome"] == "completed", result
    assert await _live(tenant_id, theirs["id"]) == {IN_FOLDER, OUTSIDE}


async def test_resetting_the_domains_deletes_what_they_let_in(tenant_id, drive):
    owner, _ = await _people(tenant_id)
    _company_folder(drive)
    assert (await _put(owner, "company_email_domains", ["example.com"])).status_code == 200
    mine = await _source(tenant_id, owner, {"folders": [FOLDER]})
    assert await _live(tenant_id, mine["id"]) == {IN_FOLDER}
    assert (await _put(owner, "company_email_domains", None)).status_code == 200
    # No company domain: every doc in a picked folder counts as outside (fails closed).
    assert await _live(tenant_id, mine["id"]) == set()


async def test_a_doc_whose_drive_or_owner_is_unknown_is_deleted_then_read_again(tenant_id, drive):
    owner, _ = await _people(tenant_id)
    _company_folder(drive)
    domains = ["example.com", "partner.example"]
    assert (await _put(owner, "company_email_domains", domains)).status_code == 200
    mine = await _source(tenant_id, owner, {"folders": [FOLDER]})
    assert await _live(tenant_id, mine["id"]) == {IN_FOLDER, OUTSIDE}
    # Stored before Oracle kept the owner and drive (an older sync): nothing to judge by.
    async with tenant_session(tenant_id) as s:
        item = await s.scalar(select(SourceItem).where(SourceItem.external_id == IN_FOLDER))
        item.acl = {"shared": False, "owners": []}
        await s.commit()

    assert (await _put(owner, "company_email_domains", ["example.com"])).status_code == 200
    assert await _live(tenant_id, mine["id"]) == set()
    result = await _sync(owner, mine)
    assert result["outcome"] == "completed", result
    assert await _live(tenant_id, mine["id"]) == {IN_FOLDER}


async def test_include_and_flag_deletes_nothing_on_save(tenant_id, drive, monkeypatch):
    monkeypatch.setenv("ORACLE_DRIVE_DOCS_OWNED_OUTSIDE", "include_and_flag")
    get_settings.cache_clear()
    owner, _ = await _people(tenant_id)
    _company_folder(drive)
    domains = ["example.com", "partner.example"]
    assert (await _put(owner, "company_email_domains", domains)).status_code == 200
    mine = await _source(tenant_id, owner, {"folders": [FOLDER]})
    before = await _live(tenant_id, mine["id"])
    assert (await _put(owner, "company_email_domains", ["example.com"])).status_code == 200
    # Pulled in and flagged on the next sync instead.
    assert await _live(tenant_id, mine["id"]) == before


@pytest.mark.parametrize(
    "domain",
    ["gmail.com", "GMAIL.com", "@googlemail.com", "outlook.com", "hotmail.com", "live.com",
     "yahoo.com", "yahoo.co.uk", "icloud.com", "me.com", "aol.com", "proton.me",
     "protonmail.com", "gmx.de", "gmx.net", "gmx.at"],
)  # fmt: skip
async def test_public_mail_providers_are_refused_as_company_domains(tenant_id, domain):
    owner, _ = await _people(tenant_id)
    resp = await _put(owner, "company_email_domains", ["example.com", domain])
    assert resp.status_code == 422, resp.text
    assert "public mail provider" in resp.json()["detail"]


async def test_company_domains_on_a_provider_name_are_not_refused(tenant_id):
    owner, _ = await _people(tenant_id)
    for domain in ("live.example.com", "mail.example.com", "gmx-partners.com"):
        resp = await _put(owner, "company_email_domains", [domain])
        assert resp.status_code == 200, (domain, resp.text)


async def test_a_sync_running_across_a_company_change_saves_nothing_more(tenant_id, drive):
    """_hold compares the company's domains and shared drives too: a sync that read the
    folders under the old settings does not save its docs."""
    owner, _ = await _people(tenant_id)
    _company_folder(drive)
    domains = ["example.com", "partner.example"]
    assert (await _put(owner, "company_email_domains", domains)).status_code == 200
    mine = await _source(tenant_id, owner, {"folders": [FOLDER]})
    # Edited in Drive: the next sync exports both again; it is held at the first.
    for doc in (IN_FOLDER, OUTSIDE):
        drive.files[doc]["modifiedTime"] = "2026-10-03T09:00:00.000Z"
        drive._change(doc)
    async with _held_sync(drive, owner, mine) as first:
        put = _put(owner, "company_email_domains", ["example.com"])
        resp = await asyncio.wait_for(put, 10)
        assert resp.status_code == 200, resp.text
    assert first["outcome"] == "superseded", first
    assert await _live(tenant_id, mine["id"]) == {IN_FOLDER}
