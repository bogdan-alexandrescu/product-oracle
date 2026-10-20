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
from oracle.sources.connectors import slack
from oracle.sources.connectors.slack import THREAD_LOOKBACK, SlackConnector

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "connectors" / "slack"
CREDENTIAL = {"token": "xoxp-test-token"}


def fixture(name: str) -> dict:
    return json.loads((FIXTURES / f"{name}.json").read_text())


class FakeSlack:
    """Answers Web API calls from fixtures; ``routes`` maps a method (optionally
    ``method:key``, where key is the channel, ts, user or page cursor) to a fixture name
    or an ``httpx.Response``."""

    def __init__(self, routes: dict[str, str | httpx.Response]):
        self.routes = routes
        self.calls: list[tuple[str, dict[str, str]]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        assert request.headers["Authorization"] == "Bearer xoxp-test-token"
        method = request.url.path.rsplit("/", 1)[-1]
        params = dict(request.url.params)
        self.calls.append((method, params))
        for key in ("cursor", "ts", "user", "channel"):
            if key in params and f"{method}:{params[key]}" in self.routes:
                return self._answer(self.routes[f"{method}:{params[key]}"])
        if method in self.routes:
            return self._answer(self.routes[method])
        raise AssertionError(f"unexpected call {method} {params}")

    @staticmethod
    def _answer(route: str | httpx.Response) -> httpx.Response:
        if isinstance(route, httpx.Response):
            return route
        return httpx.Response(200, json=fixture(route))

    def count(self, method: str) -> int:
        return sum(1 for m, _ in self.calls if m == method)


def connector(fake: FakeSlack) -> SlackConnector:
    return SlackConnector(httpx.AsyncClient(transport=httpx.MockTransport(fake)))


BASE_ROUTES = {
    "auth.test": "auth_test",
    "conversations.info:C0PRODUCT": "info_C0PRODUCT",
    "conversations.info:C0ROADMAP": "info_C0ROADMAP",
    "conversations.info:G0LEGACY": "info_G0LEGACY",
    "conversations.info:G0MPIM": "info_G0MPIM",
    "conversations.info:C0IMLIKE": "info_C0IMLIKE",
    "conversations.info:C0MISSING": "channel_not_found",
    "users.info:U0ADA": "users_U0ADA",
    "users.info:U0LIN": "users_U0LIN",
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
    assert isinstance(get_connector("slack"), SlackConnector)
    assert slack.OAUTH["authorize_url"].startswith("https://slack.com/")
    assert "channels:history" in slack.OAUTH["scopes"]
    assert not any(s.startswith(("im:", "mpim:")) for s in slack.OAUTH["scopes"])


async def test_validate_accepts_public_and_private_channels():
    fake = FakeSlack(BASE_ROUTES)
    await connector(fake).validate({"channels": ["C0PRODUCT", "C0ROADMAP", "G0LEGACY"]}, CREDENTIAL)
    assert fake.count("conversations.info") == 3


@pytest.mark.parametrize("channel", ["D0DIRECT", "G0MPIM", "C0IMLIKE"])
async def test_validate_refuses_direct_messages(channel):
    fake = FakeSlack(BASE_ROUTES)
    with pytest.raises(ConnectorConfigError, match="DMs are never ingested"):
        await connector(fake).validate({"channels": ["C0PRODUCT", channel]}, CREDENTIAL)
    if channel.startswith("D"):
        assert fake.calls == []  # refused before any call


async def test_sync_refuses_direct_messages():
    fake = FakeSlack(BASE_ROUTES)
    with pytest.raises(ConnectorConfigError):
        await collect(connector(fake), {"channels": ["G0MPIM"]})
    assert fake.count("conversations.history") == 0
    with pytest.raises(ConnectorConfigError):
        await collect(connector(fake), {"channels": ["D0DIRECT"]})


@pytest.mark.parametrize(
    ("config", "credential", "match"),
    [
        ({"channels": []}, CREDENTIAL, "at least one channel"),
        ({}, CREDENTIAL, "at least one channel"),
        ({"channels": [""]}, CREDENTIAL, "strings"),
        ({"channels": ["C0PRODUCT"]}, {}, "no token"),
        ({"channels": ["C0MISSING"]}, CREDENTIAL, "not found"),
    ],
)
async def test_validate_config_errors(config, credential, match):
    with pytest.raises(ConnectorConfigError, match=match):
        await connector(FakeSlack(BASE_ROUTES)).validate(config, credential)


async def test_invalid_auth():
    fake = FakeSlack({**BASE_ROUTES, "auth.test": "auth_invalid"})
    with pytest.raises(ConnectorAuthError):
        await connector(fake).validate({"channels": ["C0PRODUCT"]}, CREDENTIAL)
    with pytest.raises(ConnectorAuthError):
        await collect(connector(fake), {"channels": ["C0PRODUCT"]})


async def test_rate_limited_with_retry_after():
    limited = httpx.Response(429, headers={"Retry-After": "30"}, json=fixture("ratelimited"))
    fake = FakeSlack({**BASE_ROUTES, "conversations.history": limited})
    with pytest.raises(ConnectorRateLimited) as raised:
        await collect(connector(fake), {"channels": ["C0PRODUCT"]})
    assert raised.value.retry_after == 30


async def test_full_sync_messages_threads_and_pagination():
    fake = FakeSlack(
        {
            **BASE_ROUTES,
            "conversations.history": "history_C0PRODUCT_page1",
            "conversations.history:bmV4dF90czoxNzYwMDAwMTAw": "history_C0PRODUCT_page2",
            "conversations.replies:1760000200.000200": "replies_1760000200",
        }
    )
    events = await collect(connector(fake), {"channels": ["C0PRODUCT"]})

    items = [e for e in events if isinstance(e, ItemUpsert)]
    assert sorted((i.external_id, i.kind) for i in items) == [
        ("C0PRODUCT:1760000100.000100", "message"),
        ("C0PRODUCT:1760000200.000200", "thread"),
        ("C0PRODUCT:1760000300.000300", "message"),
    ]  # the channel_join is skipped
    items.sort(key=lambda i: i.external_id)
    first, thread, bot = items
    assert first.author == "Ada"
    assert first.content == "Ada: Kickoff notes for the onboarding revamp are in the doc."
    assert first.url == "https://example.slack.com/archives/C0PRODUCT/p1760000100000100"
    assert first.title == "#product: Kickoff notes for the onboarding revamp are in the doc."
    assert first.acl == {"channel": "C0PRODUCT", "channel_name": "product", "is_private": False}
    assert first.occurred_at == datetime.fromtimestamp(1760000100.0001, UTC)

    assert thread.author == "Lin Example"
    assert thread.content.splitlines() == [
        "Lin Example (2025-10-09 08:56): Should onboarding v2 ship before the pricing change?",
        "Ada (2025-10-09 08:57): Yes, @Lin Example: pricing depends on the new plan picker.",
        "Lin Example (2025-10-09 08:57): Agreed, onboarding v2 first.",
    ]
    assert thread.source_updated_at == datetime.fromtimestamp(1760000260.0006, UTC)
    assert bot.author == "deploybot"

    assert events[-1] == CursorCheckpoint(
        {
            "channels": {
                "C0PRODUCT": {
                    "oldest": "1760000300.000300",
                    "threads": {"1760000200.000200": "1760000260.000600"},
                    "messages": ["1760000100.000100", "1760000300.000300"],
                }
            }
        }
    )
    # Two history pages, one replies call, each user looked up once.
    assert fake.count("conversations.history") == 2
    assert fake.count("conversations.replies") == 1
    assert fake.count("users.info") == 2


async def test_incremental_sync_updates_threads_with_new_replies():
    cursor = {
        "channels": {
            "C0PRODUCT": {
                "oldest": "1760000300.000300",
                "threads": {"1760000200.000200": "1760000260.000600"},
            }
        }
    }
    fake = FakeSlack(
        {
            **BASE_ROUTES,
            "conversations.history": "history_C0PRODUCT_incremental",
            "conversations.replies:1760000200.000200": "replies_1760000200_v2",
        }
    )
    events = await collect(connector(fake), {"channels": ["C0PRODUCT"]}, cursor)

    history = next(p for m, p in fake.calls if m == "conversations.history")
    assert float(history["oldest"]) == pytest.approx(1760000300.0003 - THREAD_LOOKBACK)
    items = [e for e in events if isinstance(e, ItemUpsert)]
    assert [(i.external_id, i.kind) for i in items] == [
        ("C0PRODUCT:1760000200.000200", "thread"),
        ("C0PRODUCT:1760000400.000400", "message"),
    ]
    thread, edited = items
    assert thread.content.endswith(
        "Ada (2025-10-09 08:59): Update: legal signed off on the pricing copy."
    )
    assert edited.source_updated_at == datetime.fromtimestamp(1760000410, UTC)
    # A cursor from before deletes were tracked: the messages it covers count as known.
    assert events[-1].cursor["channels"]["C0PRODUCT"] == {
        "oldest": "1760000400.000400",
        "threads": {"1760000200.000200": "1760000350.000700"},
        "messages": ["1760000100.000100", "1760000300.000300", "1760000400.000400"],
    }

    # Nothing new: no items, no replies fetched.
    fake.calls.clear()
    again = await collect(connector(fake), {"channels": ["C0PRODUCT"]}, events[-1].cursor)
    assert [e for e in again if isinstance(e, ItemUpsert)] == []
    assert fake.count("conversations.replies") == 0


async def test_checkpoint_per_channel_keeps_other_channels():
    cursor = {"channels": {"C0OTHER": {"oldest": "1750000000.000000", "threads": {}}}}
    fake = FakeSlack({**BASE_ROUTES, "conversations.history": "history_C0ROADMAP"})
    events = await collect(connector(fake), {"channels": ["C0ROADMAP"]}, cursor)
    (item,) = [e for e in events if isinstance(e, ItemUpsert)]
    assert item.acl["is_private"] is True
    assert events[-1].cursor["channels"] == {
        "C0OTHER": {"oldest": "1750000000.000000", "threads": {}},
        "C0ROADMAP": {
            "oldest": "1760000500.000500",
            "threads": {},
            "messages": ["1760000500.000500"],
        },
    }


SINCE_EPOCH = datetime(2025, 10, 10, tzinfo=UTC).timestamp()


@pytest.mark.parametrize("since", ["not-a-date", 20251010, "2025-13-01"])
async def test_validate_refuses_a_bad_since(since):
    fake = FakeSlack(BASE_ROUTES)
    with pytest.raises(ConnectorConfigError, match="since"):
        await connector(fake).validate({"channels": ["C0PRODUCT"], "since": since}, CREDENTIAL)
    assert fake.calls == []


async def test_validate_accepts_since_or_none():
    for since in ("2025-10-10", None):
        fake = FakeSlack(BASE_ROUTES)
        await connector(fake).validate({"channels": ["C0PRODUCT"], "since": since}, CREDENTIAL)


async def test_since_reads_no_message_before_it():
    fake = FakeSlack(
        {
            **BASE_ROUTES,
            # Slack would honour ``oldest``; the fake does not, so the connector's own
            # filter is checked too.
            "conversations.history": "history_C0PRODUCT_page1",
            "conversations.history:bmV4dF90czoxNzYwMDAwMTAw": "history_C0PRODUCT_page2",
        }
    )
    events = await collect(connector(fake), {"channels": ["C0PRODUCT"], "since": "2025-10-10"})
    history = next(p for m, p in fake.calls if m == "conversations.history")
    assert float(history["oldest"]) == SINCE_EPOCH
    assert [e for e in events if isinstance(e, ItemUpsert)] == []
    assert fake.count("conversations.replies") == 0
    assert fake.count("users.info") == 0


async def test_since_keeps_messages_on_or_after_it():
    fake = FakeSlack(
        {
            **BASE_ROUTES,
            "conversations.history": "history_C0PRODUCT_page1",
            "conversations.history:bmV4dF90czoxNzYwMDAwMTAw": "history_C0PRODUCT_page2",
            "conversations.replies:1760000200.000200": "replies_1760000200",
        }
    )
    events = await collect(connector(fake), {"channels": ["C0PRODUCT"], "since": "2025-10-09"})
    history = next(p for m, p in fake.calls if m == "conversations.history")
    assert float(history["oldest"]) == datetime(2025, 10, 9, tzinfo=UTC).timestamp()
    assert len([e for e in events if isinstance(e, ItemUpsert)]) == 3


async def test_since_bounds_the_thread_lookback_of_an_incremental_sync():
    # The cursor's lookback would reach back before ``since``: ``since`` wins.
    cursor = {"channels": {"C0PRODUCT": {"oldest": f"{SINCE_EPOCH + 3600:.6f}", "threads": {}}}}
    fake = FakeSlack({**BASE_ROUTES, "conversations.history": "history_C0PRODUCT_page2"})
    await collect(connector(fake), {"channels": ["C0PRODUCT"], "since": "2025-10-10"}, cursor)
    history = next(p for m, p in fake.calls if m == "conversations.history")
    assert float(history["oldest"]) == SINCE_EPOCH
