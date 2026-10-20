import asyncio
import json
import re
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest

from oracle.sources.base import (
    ConnectorAuthError,
    ConnectorConfigError,
    ConnectorRateLimited,
    CursorCheckpoint,
    ItemDelete,
    ItemUnavailable,
    ItemUpsert,
    get_connector,
)
from oracle.sources.connectors import google_docs
from oracle.sources.connectors.google_docs import DRIVE_URL, GoogleDocsConnector

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "connectors" / "google_docs"
CREDENTIAL = {"access_token": "ya29.test-token", "refresh_token": "1//test-refresh"}
PRODUCT = "1FolderProductExample"
SPECS = "1FolderSpecsExample"
CONFIG = {"folders": [PRODUCT], "docs": ["1DocListedExample"]}
EXTENSIONS = {"text/markdown": "md", "text/plain": "txt"}
# The page cursor list_product_page1 hands out (added by FakeDrive, built from pieces).
PAGE_2 = "-".join(["page", "2"])


def fixture(name: str) -> dict:
    return json.loads((FIXTURES / f"{name}.json").read_text())


def error(name: str, status: int, **kw) -> httpx.Response:
    return httpx.Response(status, json=fixture(name), **kw)


class FakeDrive:
    """Answers Drive v3 calls. ``routes`` keys: ``about``, ``file:<id>``,
    ``list:<folder>[:<page token>]``, ``export:<id>:<mime>``; values are a fixture name
    (``.json`` metadata, or an export file) or an ``httpx.Response``. Exports default to
    ``export_<id>.<ext>`` and files to ``file_<id>``."""

    def __init__(self, routes: dict[str, str | httpx.Response] | None = None):
        self.routes = routes or {}
        self.calls: list[str] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        assert request.headers["Authorization"] == "Bearer ya29.test-token"
        path = str(request.url.copy_with(query=None))[len(DRIVE_URL) :]
        params = request.url.params
        if path == "about":
            key = "about"
        elif path == "files":
            assert "trashed = false" in params["q"]
            (folder,) = re.findall(r"'([^']+)' in parents", params["q"])
            key = f"list:{folder}" + (f":{params['pageToken']}" if "pageToken" in params else "")
        elif path.endswith("/export"):
            key = f"export:{path.split('/')[1]}:{params['mimeType']}"
        else:
            key = f"file:{path.split('/')[1]}"
        self.calls.append(key)
        route = self.routes.get(key)
        if isinstance(route, httpx.Response):
            return route
        if key.startswith("export:"):
            _, file_id, mime = key.split(":")
            name = route or f"export_{file_id}.{EXTENSIONS[mime]}"
            if not (FIXTURES / name).exists():
                return error("error_export_unsupported", 400)
            return httpx.Response(200, content=(FIXTURES / name).read_bytes())
        name = route or ("about" if key == "about" else f"file_{key.split(':')[1]}")
        if not (FIXTURES / f"{name}.json").exists():
            return error("error_404", 404)
        body = fixture(name)
        if name == "list_product_page1":
            body["nextPageToken"] = PAGE_2
        return httpx.Response(200, json=body)


def connector(fake: FakeDrive) -> GoogleDocsConnector:
    return GoogleDocsConnector(httpx.AsyncClient(transport=httpx.MockTransport(fake)))


FULL_ROUTES = {
    f"list:{PRODUCT}": "list_product_page1",
    f"list:{PRODUCT}:{PAGE_2}": "list_product_page2",
    f"list:{SPECS}": "list_specs",
}


# Connectors do no database work: opt out of the harness's database fixtures so these
# tests run without Postgres.
@pytest.fixture(scope="session")
def migrated_db():
    return None


@pytest.fixture
def _truncate_after_test():
    return None


async def collect(conn, config, cursor=None):
    return [e async for e in conn.sync(config, CREDENTIAL, cursor)]


def test_registered_with_oauth_metadata():
    assert isinstance(get_connector("google_docs"), GoogleDocsConnector)
    assert google_docs.OAUTH["token_url"] == "https://oauth2.googleapis.com/token"
    # Picked files and folders, folders read in full (S5, 'Drive folders', 2026-10-19).
    assert google_docs.OAUTH["scopes"] == ["https://www.googleapis.com/auth/drive.readonly"]


async def test_validate():
    fake = FakeDrive()
    await connector(fake).validate(CONFIG, CREDENTIAL)
    assert fake.calls == ["about", f"file:{PRODUCT}", "file:1DocListedExample"]


async def test_validate_checks_picked_items_in_bounded_batches():
    docs = [f"1DocMany{i:02d}" for i in range(23)]
    in_flight, peak, seen = 0, 0, []

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal in_flight, peak
        path = str(request.url.copy_with(query=None))[len(DRIVE_URL) :]
        if path == "about":
            return httpx.Response(200, json=fixture("about"))
        in_flight += 1
        peak = max(peak, in_flight)
        await asyncio.sleep(0.01)
        in_flight -= 1
        file_id = path.split("/")[1]
        seen.append(file_id)
        return httpx.Response(200, json={"id": file_id, "mimeType": google_docs.DOC_MIME})

    conn = GoogleDocsConnector(httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    await conn.validate({"docs": docs}, CREDENTIAL)
    assert sorted(seen) == docs
    # Several at once, never more than one batch.
    assert 1 < peak <= google_docs.VALIDATE_BATCH


async def test_validate_caps_how_many_items_a_source_picks():
    fake = FakeDrive()
    many = {"docs": [f"1Doc{i}" for i in range(google_docs.MAX_PICKED + 1)]}
    with pytest.raises(ConnectorConfigError, match=f"at most {google_docs.MAX_PICKED}"):
        await connector(fake).validate(many, CREDENTIAL)
    assert fake.calls == []


@pytest.mark.parametrize(
    ("config", "credential", "match"),
    [
        ({}, CREDENTIAL, "at least one folder or doc"),
        ({"folders": "x"}, CREDENTIAL, "list of Drive ids"),
        (CONFIG, {"refresh_token": "1//test-refresh"}, "no access token"),
        ({"folders": ["1FolderGoneExample"]}, CREDENTIAL, "not found"),
        ({"folders": ["1DocListedExample"]}, CREDENTIAL, "not a folder"),
        ({"docs": ["1SheetExample"]}, CREDENTIAL, "not a Google Doc"),
        ({"docs": ["1DocGoneExample"]}, CREDENTIAL, "not found"),
    ],
)
async def test_validate_config_errors(config, credential, match):
    with pytest.raises(ConnectorConfigError, match=match):
        await connector(FakeDrive()).validate(config, credential)


async def test_full_sync_recurses_folders_and_falls_back_to_plain_text():
    fake = FakeDrive(FULL_ROUTES)
    events = await collect(connector(fake), CONFIG)

    items = [e for e in events if isinstance(e, ItemUpsert)]
    # Oldest change first.
    assert [i.external_id for i in items] == [
        "1DocListedExample",
        "1DocSpecExample",
        "1DocPrdExample",
        "1DocNotesExample",
    ]
    assert all(i.kind == "doc" for i in items)
    listed, spec, prd, notes = items
    assert prd.title == "Onboarding v2 PRD"
    assert prd.url == "https://docs.google.com/document/d/1DocPrdExample/edit"
    assert prd.author == "Ada Example"
    assert prd.content.startswith("# Onboarding v2 PRD\n\n## Goals")
    assert prd.occurred_at == datetime(2026, 9, 1, 9, tzinfo=UTC)
    assert prd.source_updated_at == datetime(2026, 10, 2, 10, tzinfo=UTC)
    assert prd.acl == {
        "shared": True,
        "owners": ["ada@example.com"],
        "permissions": [
            {"type": "user", "role": "owner", "email": "ada@example.com"},
            {"type": "domain", "role": "reader", "domain": "example.com"},
        ],
    }
    assert listed.author == "Lin Example"
    assert spec.acl == {"shared": False, "owners": ["ada@example.com"]}

    # Markdown export refused: plain text, BOM and CRLF stripped.
    assert notes.content == (
        "Research notes\n\nFive of eight interviewees asked for annual plans.\n"
    )
    assert fake.calls.count("export:1DocNotesExample:text/markdown") == 1
    assert fake.calls.count("export:1DocNotesExample:text/plain") == 1
    assert fake.calls.count("export:1DocPrdExample:text/plain") == 0
    assert fake.calls.count(f"list:{PRODUCT}:{PAGE_2}") == 1

    assert events[-1] == CursorCheckpoint(
        {
            "modified_since": "2026-10-03T10:00:00.000Z",
            "files": {
                "1DocListedExample": "2026-09-15T10:00:00.000Z",
                "1DocSpecExample": "2026-09-28T10:00:00.000Z",
                "1DocPrdExample": "2026-10-02T10:00:00.000Z",
                "1DocNotesExample": "2026-10-03T10:00:00.000Z",
            },
        }
    )


@pytest.mark.parametrize(
    ("status", "name"), [(400, "error_export_unsupported"), (403, "error_export_size")]
)
async def test_markdown_export_fallback(status, name):
    fake = FakeDrive(
        {
            "export:1DocListedExample:text/markdown": error(name, status),
            "export:1DocListedExample:text/plain": "export_1DocListedExample.md",
        }
    )
    events = await collect(connector(fake), {"docs": ["1DocListedExample"]})
    (item,) = [e for e in events if isinstance(e, ItemUpsert)]
    assert item.content == "# Pricing strategy\n\nAnnual plans get two months free.\n"
    assert fake.calls[-1] == "export:1DocListedExample:text/plain"


async def test_incremental_sync_exports_changes_and_deletes_removed_docs():
    first = await collect(connector(FakeDrive(FULL_ROUTES)), CONFIG)
    cursor = first[-1].cursor

    fake = FakeDrive(
        {
            f"list:{PRODUCT}": "list_product_incremental",
            f"list:{SPECS}": "list_specs",
            "file:1DocListedExample": "file_1DocListedExample_trashed",
            "export:1DocPrdExample:text/markdown": "export_1DocPrdExample_v2.md",
        }
    )
    events = await collect(connector(fake), CONFIG, cursor)

    # The notes left the folder (or were trashed), the listed doc was trashed.
    assert [e for e in events if isinstance(e, ItemDelete)] == [
        ItemDelete("1DocListedExample"),
        ItemDelete("1DocNotesExample"),
    ]
    (prd,) = [e for e in events if isinstance(e, ItemUpsert)]
    assert prd.external_id == "1DocPrdExample"
    assert "under 3 minutes" in prd.content
    # Only the changed doc is exported.
    assert [c for c in fake.calls if c.startswith("export:")] == [
        "export:1DocPrdExample:text/markdown"
    ]
    assert events[-1].cursor == {
        "modified_since": "2026-10-06T10:00:00.000Z",
        "files": {
            "1DocSpecExample": "2026-09-28T10:00:00.000Z",
            "1DocPrdExample": "2026-10-06T10:00:00.000Z",
        },
    }


async def test_removed_listed_doc_is_deleted():
    cursor = {"modified_since": None, "files": {"1DocGoneExample": "2026-09-01T00:00:00.000Z"}}
    events = await collect(connector(FakeDrive()), {"docs": ["1DocGoneExample"]}, cursor)
    assert events[0] == ItemDelete("1DocGoneExample")
    assert events[-1].cursor == {"modified_since": None, "files": {}}


async def test_expired_token():
    fake = FakeDrive({"about": error("error_401", 401), f"list:{PRODUCT}": error("error_401", 401)})
    with pytest.raises(ConnectorAuthError):
        await connector(fake).validate(CONFIG, CREDENTIAL)
    with pytest.raises(ConnectorAuthError):
        await collect(connector(fake), CONFIG)


@pytest.mark.parametrize(
    "response",
    [
        error("error_rate", 403, headers={"Retry-After": "12"}),
        error("error_rate", 429, headers={"Retry-After": "12"}),
    ],
)
async def test_rate_limited(response):
    fake = FakeDrive({**FULL_ROUTES, "export:1DocListedExample:text/markdown": response})
    with pytest.raises(ConnectorRateLimited) as raised:
        await collect(connector(fake), CONFIG)
    assert raised.value.retry_after == 12


# --- drive.file: the files each person picked ----------------------------------------

PICKED = {
    "docs": ["1DocListedExample", "1DocPrdExample"],
    "names": {"1DocListedExample": "Pricing strategy", "1DocPrdExample": "Onboarding v2 PRD"},
}


async def test_picked_docs_sync_without_listing_any_folder():
    fake = FakeDrive()
    await connector(fake).validate(PICKED, CREDENTIAL)
    events = await collect(connector(fake), PICKED)
    items = [e for e in events if isinstance(e, ItemUpsert)]
    assert [i.external_id for i in items] == ["1DocListedExample", "1DocPrdExample"]
    assert items[1].title == "Onboarding v2 PRD"
    # drive.file cannot list folders: only the picked files are read.
    assert not [c for c in fake.calls if c.startswith("list:")]
    assert not [e for e in events if isinstance(e, ItemUnavailable)]


async def test_unreadable_picked_docs_are_reported_per_item():
    cursor = {
        "modified_since": None,
        "files": {"1DocUnsharedExample": "2026-09-01T00:00:00.000Z"},
    }
    config = {"docs": ["1DocListedExample", "1DocUnsharedExample", "1DocPrdExample"]}
    fake = FakeDrive({"file:1DocPrdExample": error("error_403_app_not_authorized", 403)})
    events = await collect(connector(fake), config, cursor)

    unavailable = {e.external_id: e.reason for e in events if isinstance(e, ItemUnavailable)}
    assert set(unavailable) == {"1DocUnsharedExample", "1DocPrdExample"}
    assert unavailable["1DocUnsharedExample"].startswith("No access")
    assert unavailable["1DocPrdExample"].startswith("Not picked")
    # What can be read is still synced; the unshared doc's item is removed.
    assert [e.external_id for e in events if isinstance(e, ItemUpsert)] == ["1DocListedExample"]
    assert ItemDelete("1DocUnsharedExample") in events
    assert set(events[-1].cursor["files"]) == {"1DocListedExample"}


async def test_export_refused_for_one_doc_is_reported_per_item():
    refused = error("error_403_insufficient", 403)
    fake = FakeDrive(
        {
            "export:1DocListedExample:text/markdown": refused,
            "export:1DocListedExample:text/plain": refused,
        }
    )
    events = await collect(connector(fake), PICKED)
    assert [e.external_id for e in events if isinstance(e, ItemUpsert)] == ["1DocPrdExample"]
    (gone,) = [e for e in events if isinstance(e, ItemUnavailable)]
    assert gone.external_id == "1DocListedExample" and gone.reason.startswith("No access")
    # Not recorded as synced, so the next sync tries it again.
    assert set(events[-1].cursor["files"]) == {"1DocPrdExample"}


def test_names_must_be_a_map_of_strings():
    from oracle.sources.base import ConnectorConfigError
    from oracle.sources.connectors.google_docs import _options

    with pytest.raises(ConnectorConfigError, match="names"):
        _options({"docs": ["1Doc"], "names": ["x"]})
