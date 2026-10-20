"""Slack channel picker: GET /v1/connections/{id}/slack/channels (S5, S3).

Slack's Web API is mocked with httpx.MockTransport; nothing reaches the network.
"""

import httpx
import pytest
from sqlalchemy import select

from oracle.connections.models import Connection
from oracle.tenancy import tenant_session
from tests.connection_helpers import (
    add_connection,
    clear_provider_http,
    make_person,
    use_provider_http,
)

TOKEN = "xoxp-example-browse-token"


def channel(cid: str, name: str, **extra) -> dict:
    base = {
        "id": cid,
        "name": name,
        "is_channel": not cid.startswith("G"),
        "is_group": False,
        "is_im": False,
        "is_mpim": False,
        "is_private": cid.startswith("G"),
        "is_archived": False,
        "num_members": 12,
        "topic": {"value": f"All about {name}"},
    }
    return {**base, **extra}


PAGE1 = [
    channel("C0PRODUCT", "product", num_members=42),
    channel("G0ROADMAP", "roadmap", num_members=5, topic={"value": ""}),
    channel("C0OLD", "old-launch", is_archived=True),
    # Slack never returns these for these types, but Oracle drops them anyway.
    channel("D0DIRECT", "dm", is_im=True, is_channel=False),
    channel("G0MPIM", "mpdm-ada--lin-1", is_mpim=True, is_private=True),
]
PAGE2 = [channel("C0FEEDBACK", "customer-feedback", num_members=17)]


class FakeSlack:
    def __init__(self):
        self.calls: list[dict[str, str]] = []
        self.limited = False
        self.error: str | None = None

    def __call__(self, request: httpx.Request) -> httpx.Response:
        assert request.url.host == "slack.com"
        assert request.url.path == "/api/conversations.list"
        assert request.headers["Authorization"] == f"Bearer {TOKEN}"
        params = dict(request.url.params)
        self.calls.append(params)
        if self.limited:
            return httpx.Response(429, headers={"Retry-After": "30"}, json={"ok": False})
        if self.error:
            return httpx.Response(200, json={"ok": False, "error": self.error})
        if params.get("cursor") == "page-2":
            return httpx.Response(
                200,
                json={"ok": True, "channels": PAGE2, "response_metadata": {"next_cursor": ""}},
            )
        return httpx.Response(
            200,
            json={"ok": True, "channels": PAGE1, "response_metadata": {"next_cursor": "page-2"}},
        )


@pytest.fixture
def slack():
    fake = FakeSlack()
    use_provider_http(fake)
    yield fake
    clear_provider_http()


@pytest.fixture
async def alice(tenant_id):
    return await make_person(tenant_id, "alice@example.com", "owner")


@pytest.fixture
async def bob(tenant_id):
    return await make_person(tenant_id, "bob@example.com", "commenter")


@pytest.fixture
async def conn(tenant_id, alice):
    return await add_connection(
        tenant_id, alice.id, "slack", bundle={"access_token": TOKEN}, account_id="T0EXAMPLE"
    )


def url(conn, **params) -> str:
    query = "&".join(f"{k}={v}" for k, v in params.items())
    return f"/v1/connections/{conn.id}/slack/channels" + (f"?{query}" if query else "")


async def test_lists_public_and_private_channels_never_dms(client, alice, conn, slack):
    resp = await client.get(url(conn), headers=alice.headers)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["channels"] == [
        {
            "id": "C0PRODUCT",
            "name": "product",
            "is_private": False,
            "is_archived": False,
            "num_members": 42,
            "topic": "All about product",
        },
        {
            "id": "G0ROADMAP",
            "name": "roadmap",
            "is_private": True,
            "is_archived": False,
            "num_members": 5,
            "topic": None,
        },
    ]
    assert body["next_cursor"] == "page-2"
    # Asked only for channels, with the archived ones left out, using the user token.
    (call,) = slack.calls
    assert call["types"] == "public_channel,private_channel"
    assert call["exclude_archived"] == "true"
    assert TOKEN not in resp.text


async def test_next_page(client, alice, conn, slack):
    resp = await client.get(url(conn, cursor="page-2"), headers=alice.headers)
    assert resp.status_code == 200, resp.text
    assert [c["id"] for c in resp.json()["channels"]] == ["C0FEEDBACK"]
    assert resp.json()["next_cursor"] is None
    assert slack.calls[0]["cursor"] == "page-2"


async def test_archived_on_request(client, alice, conn, slack):
    resp = await client.get(url(conn, include_archived="true"), headers=alice.headers)
    assert resp.status_code == 200, resp.text
    ids = [c["id"] for c in resp.json()["channels"]]
    assert "C0OLD" in ids
    assert "D0DIRECT" not in ids and "G0MPIM" not in ids
    assert slack.calls[0]["exclude_archived"] == "false"


async def test_search_matches_names_across_pages(client, alice, conn, slack):
    resp = await client.get(url(conn, search="FEED"), headers=alice.headers)
    assert resp.status_code == 200, resp.text
    # Slack has no name filter: Oracle reads on through the pages to find matches.
    assert [c["name"] for c in resp.json()["channels"]] == ["customer-feedback"]
    assert resp.json()["next_cursor"] is None
    assert len(slack.calls) == 2

    resp = await client.get(url(conn, search="%23road"), headers=alice.headers)
    assert [c["name"] for c in resp.json()["channels"]] == ["roadmap"]


async def test_another_users_connection_is_not_found(client, bob, conn, slack):
    resp = await client.get(url(conn), headers=bob.headers)
    assert resp.status_code == 404
    assert slack.calls == []


async def test_a_github_connection_is_not_found(client, tenant_id, alice, slack):
    other = await add_connection(tenant_id, alice.id, "github")
    resp = await client.get(url(other), headers=alice.headers)
    assert resp.status_code == 404
    assert slack.calls == []


async def test_rate_limit_is_a_clear_retry(client, alice, conn, slack):
    slack.limited = True
    resp = await client.get(url(conn), headers=alice.headers)
    assert resp.status_code == 429
    assert resp.headers["Retry-After"] == "30"
    assert resp.json()["detail"] == "Slack is busy: try again in 30 seconds"


async def test_rejected_token_marks_the_connection(client, tenant_id, alice, conn, slack):
    slack.error = "token_revoked"
    resp = await client.get(url(conn), headers=alice.headers)
    assert resp.status_code == 409
    assert "reconnect" in resp.json()["detail"].lower()
    assert TOKEN not in resp.text
    async with tenant_session(tenant_id) as s:
        row = await s.scalar(select(Connection).where(Connection.id == conn.id))
        assert row.status == "expired"


async def test_missing_scope(client, alice, conn, slack):
    slack.error = "missing_scope"
    resp = await client.get(url(conn), headers=alice.headers)
    assert resp.status_code == 409
    assert "scope" in resp.json()["detail"]


async def test_inactive_connection(client, tenant_id, alice, slack):
    expired = await add_connection(
        tenant_id, alice.id, "slack", bundle={"access_token": TOKEN}, status="expired"
    )
    resp = await client.get(url(expired), headers=alice.headers)
    assert resp.status_code == 409
    assert slack.calls == []


async def test_slack_unreachable_is_a_bad_gateway(client, alice, conn):
    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route", request=request)

    use_provider_http(down)
    try:
        resp = await client.get(url(conn), headers=alice.headers)
    finally:
        clear_provider_http()
    assert resp.status_code == 502
    assert resp.json()["detail"] == "Slack could not be reached: try again"
