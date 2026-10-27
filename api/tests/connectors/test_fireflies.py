import json
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest

from oracle.sources.base import (
    ConnectorAuthError,
    ConnectorConfigError,
    ConnectorRateLimited,
    CursorCheckpoint,
    ItemUpsert,
    get_connector,
)
from oracle.sources.connectors import fireflies
from oracle.sources.connectors.fireflies import API_URL, FirefliesConnector, fingerprint

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "connectors" / "fireflies"
CREDENTIAL = {"api_key": "ff-test-key"}


def fixture(name: str) -> dict:
    return json.loads((FIXTURES / f"{name}.json").read_text())


class FakeFireflies:
    """Answers GraphQL queries from fixtures: ``lists`` maps a ``skip`` to a list page,
    a transcript query answers ``transcript_<id>``."""

    def __init__(self, lists: dict[int, str] | None = None, error: httpx.Response | None = None):
        self.lists = lists or {}
        self.error = error
        self.requests: list[dict] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        assert str(request.url) == API_URL
        assert request.headers["Authorization"] == "Bearer ff-test-key"
        body = json.loads(request.content)
        self.requests.append(body)
        if self.error is not None:
            return self.error
        query, variables = body["query"], body["variables"]
        if "user {" in query:
            return httpx.Response(200, json=fixture("user"))
        if "transcripts(" in query:
            return httpx.Response(200, json=fixture(self.lists[variables["skip"]]))
        if "transcript(" in query:
            return httpx.Response(200, json=fixture(f"transcript_{variables['id']}"))
        raise AssertionError(f"unexpected query {query}")

    def detail_ids(self) -> list[str]:
        return [r["variables"]["id"] for r in self.requests if "transcript(" in r["query"]]

    def list_variables(self) -> list[dict]:
        return [r["variables"] for r in self.requests if "transcripts(" in r["query"]]


def connector(fake: FakeFireflies) -> FirefliesConnector:
    return FirefliesConnector(httpx.AsyncClient(transport=httpx.MockTransport(fake)))


@pytest.fixture(autouse=True)
def small_pages(monkeypatch):
    monkeypatch.setattr(fireflies, "PAGE_SIZE", 2)


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


PAGES = {0: "list_page1", 2: "list_page2", 4: "list_page3"}


def test_registered_without_oauth():
    assert isinstance(get_connector("fireflies"), FirefliesConnector)
    assert fireflies.OAUTH is None


async def test_validate():
    await connector(FakeFireflies()).validate(
        {"from_date": "2026-09-01", "title_contains": ["product"]}, CREDENTIAL
    )


@pytest.mark.parametrize(
    ("config", "credential", "match"),
    [
        ({"from_date": "last tuesday"}, CREDENTIAL, "ISO date"),
        ({"title_contains": "product"}, CREDENTIAL, "list of strings"),
        ({}, {}, "no API key"),
    ],
)
async def test_validate_config_errors(config, credential, match):
    with pytest.raises(ConnectorConfigError, match=match):
        await connector(FakeFireflies()).validate(config, credential)


async def test_full_sync_pages_newest_first_and_yields_oldest_first():
    fake = FakeFireflies(PAGES)
    events = await collect(connector(fake), {})

    assert [v["skip"] for v in fake.list_variables()] == [0, 2, 4]
    assert all(v["limit"] == 2 and "fromDate" not in v for v in fake.list_variables())
    items = [e for e in events if isinstance(e, ItemUpsert)]
    assert [i.external_id for i in items] == [
        "01TRANSCRIPT1",
        "01TRANSCRIPT2",
        "01TRANSCRIPT3",
        "01TRANSCRIPT4",
    ]
    # One checkpoint after each transcript.
    assert [type(e).__name__ for e in events] == ["ItemUpsert", "CursorCheckpoint"] * 4

    review = items[-1]
    assert review.kind == "transcript"
    assert review.title == "Product review: onboarding v2"
    assert review.url == "https://app.fireflies.ai/view/01TRANSCRIPT4"
    assert review.author == "ada@example.com"
    assert review.occurred_at == datetime(2026, 10, 10, 15, tzinfo=UTC)
    # The people who spoke, then the invitees, each once.
    assert review.acl == {
        "participants": [
            "Ada Example",
            "Lin Example",
            "ada@example.com",
            "lin@example.com",
            "guest@example.org",
        ]
    }
    assert review.content == (
        "## Overview\n\nThe team reviewed onboarding v2 and agreed to ship next sprint.\n\n"
        "## Action items\n\n**Lin Example**\n- Get legal sign-off on pricing copy (01:12)\n"
        "**Ada Example**\n- Schedule the launch (02:30)\n\n"
        "## Keywords\n\nonboarding, pricing, plan picker\n\n"
        "## Transcript\n\n"
        "Ada Example: Let's review onboarding v2. The plan picker is done.\n"
        "Lin Example: Pricing copy still needs legal.\n"
        "Ada Example: Then we ship next sprint."
    )
    # Comma-packed participants are split.
    assert items[2].acl == {"participants": ["ada@example.com", "sam@example.com"]}

    assert events[-1] == CursorCheckpoint(
        {
            "since": "2026-10-10T15:00:00Z",
            # Synced within the three days a sync reads back.
            "recent": {
                "01TRANSCRIPT3": "2026-10-08T09:30:00Z",
                "01TRANSCRIPT4": "2026-10-10T15:00:00Z",
            },
            "selection": fingerprint({}),
        }
    )


async def test_from_date_and_title_filter():
    fake = FakeFireflies(PAGES)
    config = {"from_date": "2026-10-01", "title_contains": ["PRODUCT", "pricing"]}
    events = await collect(connector(fake), config)

    assert fake.list_variables()[0]["fromDate"] == "2026-10-01T00:00:00Z"
    # The kickoff is before from_date: a full pass reads on past it (and skips it); the
    # standup fails the filter.
    assert len(fake.list_variables()) == 3
    assert fake.detail_ids() == ["01TRANSCRIPT3", "01TRANSCRIPT4"]
    assert [e.external_id for e in events if isinstance(e, ItemUpsert)] == fake.detail_ids()


async def test_incremental_sync_reads_back_an_overlap():
    cursor = {"since": "2026-10-08T09:30:00Z", "recent": {"01TRANSCRIPT3": "2026-10-08T09:30:00Z"}}
    fake = FakeFireflies({0: "list_incremental"})
    events = await collect(connector(fake), {}, cursor)

    assert fake.list_variables() == [{"limit": 2, "skip": 0, "fromDate": "2026-10-05T09:30:00Z"}]
    # The late-processed meeting inside the overlap is picked up; the synced one is not
    # fetched again; the one before the overlap stops paging.
    assert fake.detail_ids() == ["01TRANSCRIPTL", "01TRANSCRIPT5"]
    assert events[1] == CursorCheckpoint(
        {
            "since": "2026-10-08T09:30:00Z",
            "recent": {
                "01TRANSCRIPT3": "2026-10-08T09:30:00Z",
                "01TRANSCRIPTL": "2026-10-07T23:00:00Z",
            },
            "selection": fingerprint({}),
        }
    )
    assert events[-1] == CursorCheckpoint(
        {
            "since": "2026-10-12T10:00:00Z",
            "recent": {"01TRANSCRIPT5": "2026-10-12T10:00:00Z"},
            "selection": fingerprint({}),
        }
    )


async def test_nothing_new_yields_nothing():
    cursor = {
        "since": "2026-10-10T15:00:00Z",
        "recent": {
            "01TRANSCRIPT3": "2026-10-08T09:30:00Z",
            "01TRANSCRIPT4": "2026-10-10T15:00:00Z",
        },
    }
    fake = FakeFireflies({0: "list_page1", 2: "list_page2"})
    assert await collect(connector(fake), {}, cursor) == []


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(200, json=fixture("auth_error")),
        httpx.Response(401, json=fixture("auth_error")),
    ],
)
async def test_auth_error(response):
    fake = FakeFireflies(error=response)
    with pytest.raises(ConnectorAuthError):
        await connector(fake).validate({}, CREDENTIAL)
    with pytest.raises(ConnectorAuthError):
        await collect(connector(fake), {})


async def test_rate_limited():
    fake = FakeFireflies(error=httpx.Response(200, json=fixture("rate_error")))
    with pytest.raises(ConnectorRateLimited):
        await collect(connector(fake), {})
    limited = httpx.Response(429, headers={"Retry-After": "60"}, json=fixture("rate_error"))
    with pytest.raises(ConnectorRateLimited) as raised:
        await collect(connector(FakeFireflies(error=limited)), {})
    assert raised.value.retry_after == 60
