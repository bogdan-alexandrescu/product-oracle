"""Narrowing a source (S5, owner 2026-10-19): a later start date, a removed channel or
a removed repo deletes what was already pulled in and now falls outside the selection,
on the next sync. Widening again brings it back.

The real Slack and GitHub connectors run against httpx.MockTransport providers.
"""

from datetime import UTC, datetime
from typing import Any

import httpx
import pytest

from oracle.sources import base
from oracle.sources.connectors.github import GithubConnector
from oracle.sources.connectors.slack import SlackConnector
from tests.sources_helpers import client_for, make_connection, make_user


def ts(day: str, hour: int = 12) -> str:
    when = datetime.fromisoformat(day).replace(hour=hour, tzinfo=UTC)
    return f"{when.timestamp():.6f}"


class SlackWorld:
    """A workspace with two channels; honours ``oldest``/``latest`` as Slack does."""

    def __init__(self):
        self.channels: dict[str, list[dict[str, Any]]] = {
            "C0PRODUCT": [
                {"ts": ts("2025-10-01"), "user": "U0ADA", "text": "kick-off"},
                {"ts": ts("2025-10-05"), "user": "U0ADA", "text": "pricing idea"},
                {"ts": ts("2025-10-10"), "user": "U0ADA", "text": "launch plan"},
            ],
            "C0ROADMAP": [{"ts": ts("2025-10-03"), "user": "U0ADA", "text": "q4 roadmap"}],
        }
        self.replies: dict[str, list[dict[str, Any]]] = {}
        self.calls: list[tuple[str, dict[str, str]]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        method = request.url.path.rsplit("/", 1)[-1]
        params = dict(request.url.params)
        self.calls.append((method, params))
        if method == "auth.test":
            return self.ok(url="https://example.slack.com/")
        if method == "conversations.info":
            cid = params["channel"]
            if cid not in self.channels:
                return self.ok_false("channel_not_found")
            name = cid[2:].lower()
            return self.ok(channel={"id": cid, "name": name, "is_channel": True})
        if method == "conversations.history":
            oldest = float(params.get("oldest") or 0)
            latest = float(params.get("latest") or 1e12)
            messages = [
                m for m in self.channels[params["channel"]] if oldest <= float(m["ts"]) < latest
            ]
            return self.ok(messages=list(reversed(messages)), response_metadata={})
        if method == "conversations.replies":
            return self.ok(messages=self.replies[params["ts"]], response_metadata={})
        if method == "users.info":
            return self.ok(user={"id": params["user"], "name": "ada"})
        raise AssertionError(f"unexpected Slack call {method}")

    @staticmethod
    def ok(**body: Any) -> httpx.Response:
        return httpx.Response(200, json={"ok": True, **body})

    @staticmethod
    def ok_false(error: str) -> httpx.Response:
        return httpx.Response(200, json={"ok": False, "error": error})


class GithubWorld:
    """Two repos, each with one issue and one release (no files)."""

    REPOS = ("example-org/one", "example-org/two")

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path.lower()
        if path == "/user":
            return httpx.Response(200, json={"login": "ada"})
        for full in self.REPOS:
            n = full[-3:]
            if path == f"/repos/{full}":
                return httpx.Response(
                    200,
                    json={
                        "full_name": full,
                        "html_url": f"https://github.com/{full}",
                        "default_branch": None,
                        "private": True,
                    },
                )
            if path == f"/repos/{full}/issues":
                issue = {
                    "number": 1,
                    "title": f"Bug in {n}",
                    "state": "open",
                    "html_url": f"https://github.com/{full}/issues/1",
                    "created_at": "2025-10-01T00:00:00Z",
                    "updated_at": "2025-10-01T00:00:00Z",
                }
                return httpx.Response(200, json=[issue])
            if path == f"/repos/{full}/releases":
                release = {"id": 7, "tag_name": f"v1-{n}", "published_at": "2025-10-02T00:00:00Z"}
                return httpx.Response(200, json=[release])
        raise AssertionError(f"unexpected GitHub call {path}")


@pytest.fixture
def slack(monkeypatch):
    world = SlackWorld()
    client = httpx.AsyncClient(transport=httpx.MockTransport(world))
    monkeypatch.setitem(base._registry, "slack", SlackConnector(client))
    return world


@pytest.fixture
def github(monkeypatch):
    world = GithubWorld()
    client = httpx.AsyncClient(transport=httpx.MockTransport(world))
    monkeypatch.setitem(base._registry, "github", GithubConnector(client))
    return world


@pytest.fixture
async def alice(tenant_id):
    return await make_user(tenant_id, "alice@example.com")


@pytest.fixture
async def a(alice):
    async with client_for(alice) as c:
        yield c


async def add(a, tenant_id, alice, kind: str, config: dict) -> dict:
    conn = await make_connection(tenant_id, alice, kind)
    resp = await a.post(
        "/v1/sources",
        json={"kind": kind, "name": f"My {kind}", "connection_id": str(conn), "config": config},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


async def sync(a, source: dict) -> dict:
    resp = await a.post(f"/v1/sources/{source['id']}/sync")
    assert resp.status_code == 200, resp.text
    assert resp.json()["outcome"] == "completed", resp.json()
    return resp.json()


async def narrow(a, source: dict, config: dict) -> None:
    resp = await a.patch(f"/v1/sources/{source['id']}", json={"config": config})
    assert resp.status_code == 200, resp.text


async def live(a, source: dict) -> list[str]:
    items = (await a.get(f"/v1/sources/{source['id']}/items")).json()
    return sorted(i["external_id"] for i in items)


async def removed(a, source: dict) -> list[str]:
    items = (await a.get(f"/v1/sources/{source['id']}/items?include_deleted=true")).json()
    return sorted(i["external_id"] for i in items if i["deleted_at"])


BOTH = ["C0PRODUCT", "C0ROADMAP"]


# --- Slack --------------------------------------------------------------------------


async def test_a_later_since_deletes_older_messages(a, tenant_id, alice, slack):
    source = await add(a, tenant_id, alice, "slack", {"channels": BOTH})
    await sync(a, source)
    assert len(await live(a, source)) == 4

    await narrow(a, source, {"channels": BOTH, "since": "2025-10-04"})
    result = await sync(a, source)
    assert result["deleted"] == 2
    assert await live(a, source) == [
        f"C0PRODUCT:{ts('2025-10-05')}",
        f"C0PRODUCT:{ts('2025-10-10')}",
    ]
    assert await removed(a, source) == [
        f"C0PRODUCT:{ts('2025-10-01')}",
        f"C0ROADMAP:{ts('2025-10-03')}",
    ]
    assert result["source"]["item_count"] == 2

    # Widening again brings them back.
    await narrow(a, source, {"channels": BOTH})
    await sync(a, source)
    assert len(await live(a, source)) == 4


async def test_a_thread_started_before_since_is_deleted(a, tenant_id, alice, slack):
    parent = slack.channels["C0PRODUCT"][0]
    parent.update(reply_count=1, latest_reply=ts("2025-10-06"), thread_ts=parent["ts"])
    reply = {"ts": ts("2025-10-06"), "user": "U0ADA", "text": "late", "thread_ts": parent["ts"]}
    slack.replies[parent["ts"]] = [parent, reply]
    source = await add(a, tenant_id, alice, "slack", {"channels": ["C0PRODUCT"]})
    await sync(a, source)
    assert f"C0PRODUCT:{parent['ts']}" in await live(a, source)

    await narrow(a, source, {"channels": ["C0PRODUCT"], "since": "2025-10-02"})
    await sync(a, source)
    assert await removed(a, source) == [f"C0PRODUCT:{parent['ts']}"]


async def test_removing_a_channel_deletes_its_messages(a, tenant_id, alice, slack):
    source = await add(a, tenant_id, alice, "slack", {"channels": BOTH})
    await sync(a, source)

    await narrow(a, source, {"channels": ["C0PRODUCT"]})
    result = await sync(a, source)
    assert result["deleted"] == 1
    assert await removed(a, source) == [f"C0ROADMAP:{ts('2025-10-03')}"]
    assert len(await live(a, source)) == 3


async def test_a_sync_without_a_change_deletes_nothing(a, tenant_id, alice, slack):
    source = await add(a, tenant_id, alice, "slack", {"channels": BOTH})
    await sync(a, source)
    result = await sync(a, source)
    assert result["deleted"] == 0
    assert len(await live(a, source)) == 4


# --- GitHub -------------------------------------------------------------------------

ONE = ["example-org/one:issue:1", "example-org/one:release:7"]
TWO = ["example-org/two:issue:1", "example-org/two:release:7"]


async def test_removing_a_repo_deletes_its_items(a, tenant_id, alice, github):
    config = {"repos": ["example-org/one", "Example-Org/Two"], "include": ["issues", "releases"]}
    source = await add(a, tenant_id, alice, "github", config)
    await sync(a, source)
    assert await live(a, source) == ONE + TWO

    await narrow(a, source, {**config, "repos": ["example-org/one"]})
    result = await sync(a, source)
    assert result["deleted"] == 2
    assert await live(a, source) == ONE
    assert await removed(a, source) == TWO


async def test_dropping_an_include_deletes_those_items(a, tenant_id, alice, github):
    config = {"repos": ["example-org/one"], "include": ["issues", "releases"]}
    source = await add(a, tenant_id, alice, "github", config)
    await sync(a, source)

    await narrow(a, source, {**config, "include": ["issues"]})
    await sync(a, source)
    assert await live(a, source) == ["example-org/one:issue:1"]
    assert await removed(a, source) == ["example-org/one:release:7"]
