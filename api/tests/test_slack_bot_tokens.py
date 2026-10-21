"""Slack bot tokens are refused on every path (M3): a bot token would read the bot's
channels, not the person's. Slack marks one by ``bot_id`` in ``auth.test``, whatever the
token's prefix (a rotated bot token reads ``xoxe.xoxb-...``)."""

import httpx
import pytest

from oracle.connections import browse
from oracle.connections.providers import PROVIDERS, CredentialRefused, CredentialRejected
from oracle.sources import base
from oracle.sources.connectors.slack import SlackConnector
from tests.connection_helpers import (
    add_connection,
    clear_provider_http,
    make_person,
    use_provider_http,
)

BOT = "xoxe.xoxb-1-x"
USER = "xoxp-example-user"


def slack_api(request: httpx.Request) -> httpx.Response:
    """Slack's Web API: ``BOT`` is a bot token, ``USER`` a person's."""
    assert request.url.host == "slack.com"
    token = request.headers["Authorization"].removeprefix("Bearer ")
    method = request.url.path.rsplit("/", 1)[-1]
    if method == "auth.test":
        body = {"ok": True, "team_id": "T0EXAMPLE", "team": "Example", "url": "x"}
        if token == BOT:
            body |= {"user_id": "U0BOT", "user": "oracle-bot", "bot_id": "B0BOT"}
        else:
            body |= {"user_id": "U0PAT", "user": "pat"}
        return httpx.Response(200, json=body)
    if method in ("conversations.list", "conversations.info"):
        channel = {"id": "C0PRODUCT", "name": "product", "is_channel": True, "is_member": True}
        return httpx.Response(
            200,
            json={"ok": True, "channels": [channel], "channel": channel, "response_metadata": {}},
        )
    return httpx.Response(200, json={"ok": True, "messages": [], "members": []})


@pytest.fixture
def slack(monkeypatch):
    seen = use_provider_http(slack_api)
    client = httpx.AsyncClient(transport=httpx.MockTransport(slack_api))
    monkeypatch.setitem(base._registry, "slack", SlackConnector(client))
    browse.reset()
    yield seen
    browse.reset()
    clear_provider_http()


@pytest.fixture
async def alice(tenant_id):
    return await make_person(tenant_id, "alice@example.com", "owner")


async def test_a_bot_token_is_refused_at_connect_browse_and_source_creation(
    client, tenant_id, alice, slack
):
    # Connect: 422, not 400 (the token works; Oracle will not use it).
    resp = await client.post(
        "/v1/connections/slack/token", json={"token": BOT}, headers=alice.headers
    )
    assert resp.status_code == 422, resp.text
    detail = resp.json()["detail"]
    assert "bot token" in detail and "xoxp-" in detail
    assert BOT not in resp.text
    assert (await client.get("/v1/connections", headers=alice.headers)).json() == []

    # A connection stored before this check: the picker refuses it.
    stored = await add_connection(
        tenant_id, alice.id, "slack", bundle={"access_token": BOT}, account_id="T0EXAMPLE:U0BOT"
    )
    resp = await client.get(f"/v1/connections/{stored.id}/slack/channels", headers=alice.headers)
    assert resp.status_code == 409, resp.text
    assert "bot token" in resp.json()["detail"]
    assert not any(r.url.path.endswith("conversations.list") for r in slack)

    # ... and so does adding a source on it (SlackConnector.validate).
    resp = await client.post(
        "/v1/sources",
        json={
            "kind": "slack",
            "name": "Product",
            "connection_id": str(stored.id),
            "config": {"channels": ["C0PRODUCT"]},
        },
        headers=alice.headers,
    )
    assert resp.status_code == 422, resp.text
    assert "bot token" in resp.json()["detail"]


async def test_a_user_token_still_connects_and_browses(client, alice, slack):
    resp = await client.post(
        "/v1/connections/slack/token", json={"token": USER}, headers=alice.headers
    )
    assert resp.status_code == 200, resp.text
    conn_id = resp.json()["id"]
    resp = await client.get(f"/v1/connections/{conn_id}/slack/channels", headers=alice.headers)
    assert resp.status_code == 200, resp.text
    assert [c["id"] for c in resp.json()["channels"]] == ["C0PRODUCT"]


async def test_reconnecting_with_a_bot_token_is_refused(client, tenant_id, alice, slack):
    conn = await add_connection(
        tenant_id, alice.id, "slack", bundle={"access_token": USER}, account_id="T0EXAMPLE:U0PAT"
    )
    resp = await client.post(
        f"/v1/connections/{conn.id}/reconnect", json={"token": BOT}, headers=alice.headers
    )
    assert resp.status_code == 422, resp.text
    assert "bot token" in resp.json()["detail"]


async def test_the_bot_check_is_asked_once_per_cache_window(
    client, tenant_id, alice, slack, monkeypatch
):
    now = [5000.0]
    monkeypatch.setattr(browse, "_clock", lambda: now[0])
    conn = await add_connection(
        tenant_id, alice.id, "slack", bundle={"access_token": USER}, account_id="T0EXAMPLE:U0PAT"
    )
    for search in ("a", "b", "c"):
        resp = await client.get(
            f"/v1/connections/{conn.id}/slack/channels?search={search}", headers=alice.headers
        )
        assert resp.status_code == 200, resp.text
    assert sum(r.url.path.endswith("auth.test") for r in slack) == 1
    now[0] += browse.CACHE_SECONDS + 1
    await client.get(f"/v1/connections/{conn.id}/slack/channels", headers=alice.headers)
    assert sum(r.url.path.endswith("auth.test") for r in slack) == 2


async def test_identify_refuses_a_bot_token():
    async with httpx.AsyncClient(transport=httpx.MockTransport(slack_api)) as c:
        with pytest.raises(CredentialRefused) as refused:
            await PROVIDERS["slack"].identify(c, BOT)
        assert isinstance(refused.value, CredentialRejected)
        identity = await PROVIDERS["slack"].identify(c, USER)
        assert identity.account_id == "T0EXAMPLE:U0PAT"


@pytest.mark.parametrize(
    "data",
    [
        # A grant with a bot token and no user token: never fall back to the bot's.
        {"ok": True, "access_token": "xoxb-bot", "token_type": "bot"},
        {"ok": True, "access_token": "xoxb-bot", "token_type": "bot", "authed_user": {"id": "U1"}},
        {"ok": True, "access_token": "xoxb-bot", "authed_user": {}},
    ],
)
def test_an_oauth_grant_without_a_user_token_is_refused(data):
    with pytest.raises(CredentialRefused):
        PROVIDERS["slack"].parse_token_response(data)


def test_an_oauth_grant_with_a_user_token_uses_it():
    parse = PROVIDERS["slack"].parse_token_response
    user = {"id": "U1", "access_token": "xoxp-user", "token_type": "user"}
    grant = {"ok": True, "access_token": "xoxb-bot", "token_type": "bot", "authed_user": user}
    assert parse(grant)["access_token"] == "xoxp-user"
    # A refreshed user token (token rotation) comes back at the top level, marked user.
    refreshed = {"ok": True, "access_token": "xoxe.xoxp-1", "token_type": "user"}
    assert parse(refreshed)["access_token"] == "xoxe.xoxp-1"
