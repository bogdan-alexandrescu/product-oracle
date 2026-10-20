"""Browse access (S5, owner 2026-10-19): the Slack and GitHub pickers' lists stay open
to the person in the browser and to MCP clients acting as that person, behind a short
per-connection cache and a per-connection rate limit, so a search cannot hammer the
provider. A refusal that is not about the token never marks the connection expired.
"""

import time

import httpx
import pytest
from sqlalchemy import select

from oracle.auth.service import create_api_token
from oracle.connections import browse
from oracle.connections.models import Connection
from oracle.tenancy import tenant_session
from tests.connection_helpers import (
    add_connection,
    clear_provider_http,
    make_person,
    use_provider_http,
)
from tests.test_mcp import mcp_client, text_of

SLACK_TOKEN = "xoxp-example-browse-token"
GITHUB_TOKEN = "gho_example_browse_token"

CHANNELS = [
    {"id": "C0PRODUCT", "name": "product", "is_channel": True, "is_private": False},
    {"id": "G0ROADMAP", "name": "roadmap", "is_group": True, "is_private": True},
]
REPOS = [
    {
        "full_name": "example-org/example-app",
        "name": "example-app",
        "owner": {"login": "example-org"},
        "private": True,
    }
]


class Provider:
    """Slack and GitHub together: counts calls; ``slack_answer`` / ``github_answer``
    replace the normal answer."""

    def __init__(self):
        self.calls: list[httpx.Request] = []
        self.slack_answer: httpx.Response | None = None
        self.github_answer: httpx.Response | None = None

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        if request.url.host == "slack.com":
            return self.slack_answer or httpx.Response(
                200, json={"ok": True, "channels": CHANNELS, "response_metadata": {}}
            )
        assert request.url.host == "api.github.com"
        return self.github_answer or httpx.Response(200, json=REPOS)


@pytest.fixture
def provider():
    fake = Provider()
    use_provider_http(fake)
    browse.reset()
    yield fake
    browse.reset()
    clear_provider_http()


@pytest.fixture
async def alice(tenant_id):
    return await make_person(tenant_id, "alice@example.com", "owner")


@pytest.fixture
async def slack_conn(tenant_id, alice):
    return await add_connection(
        tenant_id, alice.id, "slack", bundle={"access_token": SLACK_TOKEN}, account_id="T0EXAMPLE"
    )


@pytest.fixture
async def github_conn(tenant_id, alice):
    return await add_connection(
        tenant_id, alice.id, "github", bundle={"access_token": GITHUB_TOKEN}
    )


def channels(conn, query: str = "") -> str:
    return f"/v1/connections/{conn.id}/slack/channels{query}"


def repos(conn, query: str = "") -> str:
    return f"/v1/connections/{conn.id}/github/repos{query}"


async def status_of(tenant_id, conn) -> str:
    async with tenant_session(tenant_id) as s:
        return (await s.scalar(select(Connection).where(Connection.id == conn.id))).status


# --- cache --------------------------------------------------------------------------


async def test_the_same_list_within_a_minute_is_read_once(client, alice, slack_conn, provider):
    first = await client.get(channels(slack_conn, "?search=prod"), headers=alice.headers)
    again = await client.get(channels(slack_conn, "?search=prod"), headers=alice.headers)
    assert first.status_code == again.status_code == 200
    assert again.json() == first.json()
    assert len(provider.calls) == 1
    # Another search is another list.
    await client.get(channels(slack_conn, "?search=road"), headers=alice.headers)
    assert len(provider.calls) == 2


async def test_the_cache_expires(client, alice, github_conn, provider, monkeypatch):
    now = [time.monotonic()]
    monkeypatch.setattr(browse, "_clock", lambda: now[0])
    await client.get(repos(github_conn), headers=alice.headers)
    now[0] += browse.CACHE_SECONDS - 1
    await client.get(repos(github_conn), headers=alice.headers)
    assert len(provider.calls) == 1
    now[0] += 2
    await client.get(repos(github_conn), headers=alice.headers)
    assert len(provider.calls) == 2


async def test_the_cache_still_checks_the_connection(
    client, tenant_id, alice, slack_conn, provider
):
    await client.get(channels(slack_conn), headers=alice.headers)
    bob = await make_person(tenant_id, "bob@example.com", "owner")
    assert (await client.get(channels(slack_conn), headers=bob.headers)).status_code == 404
    async with tenant_session(tenant_id) as s:
        row = await s.get(Connection, slack_conn.id)
        row.status = "revoked"
        await s.commit()
    assert (await client.get(channels(slack_conn), headers=alice.headers)).status_code == 409
    assert len(provider.calls) == 1


# --- rate limit ---------------------------------------------------------------------


async def test_searches_past_the_limit_are_refused_without_calling_the_provider(
    client, alice, slack_conn, github_conn, provider
):
    for n in range(browse.RATE_LIMIT):
        resp = await client.get(channels(slack_conn, f"?search=s{n}"), headers=alice.headers)
        assert resp.status_code == 200, resp.text
    assert len(provider.calls) == browse.RATE_LIMIT
    resp = await client.get(channels(slack_conn, "?search=one-more"), headers=alice.headers)
    assert resp.status_code == 429
    assert 1 <= int(resp.headers["Retry-After"]) <= browse.RATE_WINDOW
    assert resp.json()["detail"].startswith("Too many Slack searches")
    assert len(provider.calls) == browse.RATE_LIMIT
    # A cached answer is still served, and the limit is per connection.
    again = await client.get(channels(slack_conn, "?search=s0"), headers=alice.headers)
    assert again.status_code == 200
    assert (await client.get(repos(github_conn), headers=alice.headers)).status_code == 200


async def test_the_limit_frees_up_as_the_window_moves(
    client, alice, github_conn, provider, monkeypatch
):
    now = [1000.0]
    monkeypatch.setattr(browse, "_clock", lambda: now[0])
    for n in range(browse.RATE_LIMIT):
        await client.get(repos(github_conn, f"?search=r{n}"), headers=alice.headers)
    over = await client.get(repos(github_conn, "?search=x"), headers=alice.headers)
    assert over.status_code == 429
    now[0] += browse.RATE_WINDOW + 1
    later = await client.get(repos(github_conn, "?search=x"), headers=alice.headers)
    assert later.status_code == 200


# --- Slack: user tokens only --------------------------------------------------------


async def test_a_slack_bot_token_is_refused(client, tenant_id, alice, provider):
    bot = await add_connection(
        tenant_id, alice.id, "slack", bundle={"access_token": "xoxb-example-bot"}, account_id="T0B"
    )
    resp = await client.get(channels(bot), headers=alice.headers)
    assert resp.status_code == 409
    assert "bot token" in resp.json()["detail"]
    assert "xoxb-example-bot" not in resp.text
    assert provider.calls == []
    assert await status_of(tenant_id, bot) == "active"


# --- refusals that are not about the token ------------------------------------------


async def test_slack_no_permission_does_not_expire_the_connection(
    client, tenant_id, alice, slack_conn, provider
):
    provider.slack_answer = httpx.Response(200, json={"ok": False, "error": "no_permission"})
    resp = await client.get(channels(slack_conn), headers=alice.headers)
    assert resp.status_code == 403
    assert "Slack refused" in resp.json()["detail"]
    assert await status_of(tenant_id, slack_conn) == "active"


async def test_slack_http_403_does_not_expire_the_connection(
    client, tenant_id, alice, slack_conn, provider
):
    provider.slack_answer = httpx.Response(403, json={"ok": False})
    resp = await client.get(channels(slack_conn), headers=alice.headers)
    assert resp.status_code == 403
    assert await status_of(tenant_id, slack_conn) == "active"


async def test_github_403_that_is_not_a_rate_limit_does_not_expire_the_connection(
    client, tenant_id, alice, github_conn, provider
):
    provider.github_answer = httpx.Response(
        403, json={"message": "Resource not accessible by personal access token"}
    )
    resp = await client.get(repos(github_conn), headers=alice.headers)
    assert resp.status_code == 403
    assert "GitHub refused" in resp.json()["detail"]
    assert await status_of(tenant_id, github_conn) == "active"


async def test_a_rejected_token_still_expires_the_connection(
    client, tenant_id, alice, github_conn, provider
):
    provider.github_answer = httpx.Response(401, json={"message": "Bad credentials"})
    resp = await client.get(repos(github_conn), headers=alice.headers)
    assert resp.status_code == 409
    assert await status_of(tenant_id, github_conn) == "expired"


# --- MCP clients acting as the person -----------------------------------------------


async def test_an_mcp_client_acting_as_the_person_can_browse(
    tenant_id, alice, slack_conn, github_conn, provider
):
    async with tenant_session(tenant_id) as s:
        _, raw = await create_api_token(s, "agent", user_id=alice.id)
        await s.commit()
    async with mcp_client(raw) as c:
        names = {t.name for t in (await c.list_tools()).tools}
        assert {"list_slack_channels", "list_github_repos"} <= names
        listed = await c.call_tool("list_slack_channels", {"connection_id": str(slack_conn.id)})
        assert not listed.is_error, text_of(listed)
        assert [ch["id"] for ch in listed.structured_content["channels"]] == [
            "C0PRODUCT",
            "G0ROADMAP",
        ]
        listed = await c.call_tool("list_github_repos", {"connection_id": str(github_conn.id)})
        assert not listed.is_error, text_of(listed)
        assert listed.structured_content["repos"][0]["full_name"] == "example-org/example-app"
