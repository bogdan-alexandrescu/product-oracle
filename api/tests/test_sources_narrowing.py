"""Narrowing a source (S5, owner 2026-10-19): a later start date, a removed channel or
a removed repo deletes what was already pulled in and now falls outside the selection,
on the next sync. Widening again brings it back. The delete is soft (owner, 2026-10-20):
``deleted_at`` is set and the stored versions stay.

The real Slack and GitHub connectors run against httpx.MockTransport providers.
"""

import base64
import uuid
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from sqlalchemy import func, select, update

from oracle.auth.service import hash_token
from oracle.mcp.oauth.models import OAuthClient, OAuthToken
from oracle.sources import base, service
from oracle.sources.connectors import slack as slack_module
from oracle.sources.connectors.github import GithubConnector
from oracle.sources.connectors.slack import SlackConnector
from oracle.sources.models import Source, SourceItem, SourceItemVersion
from oracle.tenancy import tenant_session
from tests.slack_world import SlackWorld, ts
from tests.sources_helpers import client_for, make_connection, make_user


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


async def test_an_earlier_until_deletes_later_messages_but_keeps_threads_in_range(
    a, tenant_id, alice, slack
):
    parent = slack.channels["C0PRODUCT"][1]  # 2025-10-05, replied to on 2025-10-08
    parent.update(reply_count=1, latest_reply=ts("2025-10-08"), thread_ts=parent["ts"])
    reply = {"ts": ts("2025-10-08"), "user": "U0ADA", "text": "late", "thread_ts": parent["ts"]}
    slack.replies[parent["ts"]] = [parent, reply]
    source = await add(a, tenant_id, alice, "slack", {"channels": BOTH})
    await sync(a, source)
    assert len(await live(a, source)) == 4

    await narrow(a, source, {"channels": BOTH, "until": "2025-10-06"})
    result = await sync(a, source)
    assert result["deleted"] == 1
    assert await removed(a, source) == [f"C0PRODUCT:{ts('2025-10-10')}"]
    assert f"C0PRODUCT:{parent['ts']}" in await live(a, source)


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


# --- A selection changing under a running sync (review round 3, M1) ------------------


async def test_a_sync_running_while_a_channel_is_removed_keeps_nothing_of_it(
    a, tenant_id, alice, monkeypatch
):
    world = SlackWorld()
    world.channels["C0SECRET"] = [{"ts": ts("2025-10-04"), "user": "U0ADA", "text": "secret"}]
    edit: dict = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        # The owner removes C0SECRET while the sync reads its first channel's history.
        if request.url.path.endswith("conversations.history") and edit.get("armed"):
            edit["armed"] = False
            async with tenant_session(tenant_id) as s:
                source = await service.get_source(s, alice.id, uuid.UUID(edit["id"]))
                await service.update_source(s, source, {"config": {"channels": BOTH}})
        return world(request)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setitem(base._registry, "slack", SlackConnector(client))
    source = await add(a, tenant_id, alice, "slack", {"channels": ["C0SECRET", *BOTH]})
    edit["id"] = source["id"]
    await sync(a, source)
    assert f"C0SECRET:{ts('2025-10-04')}" in await live(a, source)

    edit["armed"] = True
    running = (await a.post(f"/v1/sources/{source['id']}/sync")).json()
    assert running["outcome"] == "superseded"
    assert running["source"]["config"] == {"channels": BOTH}

    await sync(a, source)
    assert not [i for i in await live(a, source) if i.startswith("C0SECRET")]
    assert await removed(a, source) == [f"C0SECRET:{ts('2025-10-04')}"]


# --- A rate limit right after narrowing (M2) ------------------------------------------


async def test_a_rate_limit_after_narrowing_keeps_the_sweep(a, tenant_id, alice, slack):
    parent = slack.channels["C0PRODUCT"][1]
    parent.update(reply_count=1, latest_reply=ts("2025-10-06"), thread_ts=parent["ts"])
    reply = {"ts": ts("2025-10-06"), "user": "U0ADA", "text": "r", "thread_ts": parent["ts"]}
    slack.replies[parent["ts"]] = [parent, reply]
    source = await add(a, tenant_id, alice, "slack", {"channels": BOTH})
    await sync(a, source)

    await narrow(a, source, {"channels": ["C0PRODUCT"]})
    slack.limited = {"conversations.replies"}
    result = (await a.post(f"/v1/sources/{source['id']}/sync")).json()
    assert result["outcome"] == "rate_limited"
    assert await removed(a, source) == [f"C0ROADMAP:{ts('2025-10-03')}"]

    # The sweep is not repeated, and the next sync finishes.
    slack.limited = set()
    again = await sync(a, source)
    assert again["deleted"] == 0
    assert await removed(a, source) == [f"C0ROADMAP:{ts('2025-10-03')}"]


async def test_a_large_channel_checkpoints_each_page(a, tenant_id, alice, slack, monkeypatch):
    monkeypatch.setattr(slack_module, "PAGE_SIZE", 1)
    source = await add(a, tenant_id, alice, "slack", {"channels": ["C0PRODUCT"]})
    # Two pages of history, then Slack asks to slow down.
    slack.limit_after = {"conversations.history": 2}
    result = (await a.post(f"/v1/sources/{source['id']}/sync")).json()
    assert result["outcome"] == "rate_limited"
    assert result["checkpoints"] == 2
    # Newest first: the two newest messages are kept.
    assert await live(a, source) == [
        f"C0PRODUCT:{ts('2025-10-05')}",
        f"C0PRODUCT:{ts('2025-10-10')}",
    ]

    slack.limit_after = {}
    slack.calls.clear()
    await sync(a, source)
    assert len(await live(a, source)) == 3
    # It resumed on the third page, not from the top.
    (call,) = [p for m, p in slack.calls if m == "conversations.history"]
    assert call["cursor"] == "2"


# --- Deleted in Slack -----------------------------------------------------------------


async def test_a_message_deleted_in_slack_is_deleted(a, tenant_id, alice, slack):
    source = await add(a, tenant_id, alice, "slack", {"channels": BOTH})
    await sync(a, source)
    gone = slack.channels["C0PRODUCT"].pop(1)
    result = await sync(a, source)
    assert result["deleted"] == 1
    assert await removed(a, source) == [f"C0PRODUCT:{gone['ts']}"]


# --- Narrowing is a soft delete -------------------------------------------------------


async def test_narrowed_out_items_keep_their_versions(a, tenant_id, alice, slack):
    source = await add(a, tenant_id, alice, "slack", {"channels": BOTH})
    await sync(a, source)
    await narrow(a, source, {"channels": ["C0PRODUCT"]})
    await sync(a, source)
    async with tenant_session(tenant_id) as s:
        item = await s.scalar(
            select(SourceItem).where(SourceItem.external_id == f"C0ROADMAP:{ts('2025-10-03')}")
        )
        assert item.deleted_at is not None
        versions = await s.scalar(select(func.count()).where(SourceItemVersion.item_id == item.id))
        assert versions == 1 and item.current_version_id is not None


# --- GitHub: the selection changes, upstream deletes still count (M4) ------------------


class GithubFilesWorld:
    """example-org/one with a README and docs on main; releases on request."""

    def __init__(self):
        self.files = {"README.md": "# One\n", "docs/a.md": "# A\n", "docs/b.md": "# B\n"}

    def tree_sha(self) -> str:
        return "t" + str(abs(hash(tuple(sorted(self.files)))))

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/user":
            return httpx.Response(200, json={"login": "ada"})
        if path == "/repos/example-org/one":
            return httpx.Response(
                200,
                json={
                    "full_name": "example-org/one",
                    "html_url": "https://github.com/example-org/one",
                    "default_branch": "main",
                    "private": True,
                },
            )
        if path == "/repos/example-org/one/git/trees/main":
            tree = [
                {"path": p, "type": "blob", "sha": f"sha-{p}", "size": len(c)}
                for p, c in self.files.items()
            ]
            return httpx.Response(200, json={"sha": self.tree_sha(), "tree": tree})
        if path.startswith("/repos/example-org/one/git/blobs/sha-"):
            content = self.files[path.split("/sha-", 1)[1]]
            encoded = base64.b64encode(content.encode()).decode()
            return httpx.Response(200, json={"encoding": "base64", "content": encoded})
        if path == "/repos/example-org/one/releases":
            return httpx.Response(200, json=[])
        raise AssertionError(f"unexpected GitHub call {path}")


async def test_a_file_deleted_upstream_is_deleted_after_the_selection_changes(
    a, tenant_id, alice, monkeypatch
):
    world = GithubFilesWorld()
    client = httpx.AsyncClient(transport=httpx.MockTransport(world))
    monkeypatch.setitem(base._registry, "github", GithubConnector(client))
    config = {"repos": ["example-org/one"], "include": ["readme", "docs"]}
    source = await add(a, tenant_id, alice, "github", config)
    await sync(a, source)
    assert "example-org/one:file:docs/a.md" in await live(a, source)

    del world.files["docs/a.md"]
    await narrow(a, source, {**config, "include": ["readme", "docs", "releases"]})
    await sync(a, source)
    assert await removed(a, source) == ["example-org/one:file:docs/a.md"]
    assert "example-org/one:file:docs/b.md" in await live(a, source)


async def test_widening_again_brings_back_files_without_new_versions(
    a, tenant_id, alice, monkeypatch
):
    world = GithubFilesWorld()
    client = httpx.AsyncClient(transport=httpx.MockTransport(world))
    monkeypatch.setitem(base._registry, "github", GithubConnector(client))
    config = {"repos": ["example-org/one"], "include": ["readme", "docs"]}
    source = await add(a, tenant_id, alice, "github", config)
    await sync(a, source)
    await narrow(a, source, {**config, "include": ["readme"]})
    await sync(a, source)
    assert await removed(a, source) == [
        "example-org/one:file:docs/a.md",
        "example-org/one:file:docs/b.md",
    ]
    await narrow(a, source, config)
    result = await sync(a, source)
    assert len(await live(a, source)) == 3
    assert result["versions_written"] == 0


# --- A saved selection a newer rule refuses --------------------------------------------


async def test_a_source_over_the_channel_cap_needs_attention(a, tenant_id, alice, slack):
    source = await add(a, tenant_id, alice, "slack", {"channels": BOTH})
    too_many = [f"C{n:08d}" for n in range(slack_module.MAX_CHANNELS + 1)]
    async with tenant_session(tenant_id) as s:
        await s.execute(
            update(Source)
            .where(Source.id == uuid.UUID(source["id"]))
            .values(config={"channels": too_many})
        )
        await s.commit()
    slack.calls.clear()
    result = (await a.post(f"/v1/sources/{source['id']}/sync")).json()
    assert result["outcome"] == "needs_attention"
    assert result["source"]["status"] == "needs_attention"
    assert "at most 100 channels" in result["error"]
    assert "edit this source" in result["source"]["last_error"]
    assert slack.calls == []

    # Editing it back within the rules clears it.
    await narrow(a, source, {"channels": BOTH})
    assert (await a.get(f"/v1/sources/{source['id']}")).json()["status"] == "active"
    await sync(a, source)


async def test_a_source_with_a_now_refused_date_needs_attention(a, tenant_id, alice, slack):
    source = await add(a, tenant_id, alice, "slack", {"channels": BOTH})
    async with tenant_session(tenant_id) as s:
        await s.execute(
            update(Source)
            .where(Source.id == uuid.UUID(source["id"]))
            .values(config={"channels": BOTH, "since": "1999-01-01"})
        )
        await s.commit()
    result = (await a.post(f"/v1/sources/{source['id']}/sync")).json()
    assert result["outcome"] == "needs_attention"
    assert "Since must be a date" in result["error"]


# --- Roles ----------------------------------------------------------------------------


async def _mcp_token(tenant_id, user, scope: str) -> str:
    raw = f"poa_{uuid.uuid4().hex}"
    async with tenant_session(tenant_id) as s:
        client = OAuthClient(
            client_id=uuid.uuid4().hex, name="Claude", redirect_uris=["http://localhost/cb"]
        )
        s.add(client)
        await s.flush()
        now = datetime.now(UTC)
        s.add(
            OAuthToken(
                access_hash=hash_token(raw),
                refresh_hash=hash_token(f"por_{uuid.uuid4().hex}"),
                client_id=client.id,
                user_id=user.id,
                scope=scope,
                expires_at=now + timedelta(hours=1),
                refresh_expires_at=now + timedelta(days=1),
                family_id=uuid.uuid4(),
            )
        )
        await s.commit()
    return raw


async def test_a_read_only_mcp_client_cannot_change_sources(a, tenant_id, alice, slack):
    source = await add(a, tenant_id, alice, "slack", {"channels": BOTH})
    raw = await _mcp_token(tenant_id, alice, "oracle:read")
    async with client_for(headers={"Authorization": f"Bearer {raw}"}) as mcp:
        assert (await mcp.get(f"/v1/sources/{source['id']}")).status_code == 200
        url = f"/v1/sources/{source['id']}"
        assert (await mcp.patch(url, json={"name": "x"})).status_code == 403
        assert (await mcp.post(f"{url}/sync")).status_code == 403
        assert (await mcp.post(f"{url}/pause")).status_code == 403
        assert (await mcp.delete(url)).status_code == 403
        body = {"kind": "upload", "name": "Mine"}
        assert (await mcp.post("/v1/sources", json=body)).status_code == 403
    assert (await a.get(url)).json()["name"] == "My slack"

    write = await _mcp_token(tenant_id, alice, "oracle:read oracle:write")
    async with client_for(headers={"Authorization": f"Bearer {write}"}) as mcp:
        assert (await mcp.patch(url, json={"name": "Renamed"})).status_code == 200
