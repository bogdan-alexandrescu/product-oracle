"""GitHub repo picker: GET /v1/connections/{id}/github/repos (S5).

GitHub's REST API is mocked with httpx.MockTransport; nothing reaches the network.
"""

import time

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

TOKEN = "gho_example_browse_token"


def repo(full_name: str, *, private: bool = False, description: str | None = None, **extra):
    owner, name = full_name.split("/")
    return {
        "id": abs(hash(full_name)) % 10_000_000,
        "full_name": full_name,
        "name": name,
        "owner": {"login": owner, "type": "Organization" if owner != "ada" else "User"},
        "private": private,
        "description": description,
        "pushed_at": "2026-10-18T09:30:00Z",
        "archived": False,
        "html_url": f"https://github.com/{full_name}",
        **extra,
    }


PAGE1 = [
    repo("example-org/example-app", private=True, description="The web app"),
    repo("ada/dotfiles"),
    repo("example-org/old-site", archived=True),
]
PAGE2 = [repo("other-org/billing-api", private=True, description="Invoices and plans")]


class FakeGithub:
    def __init__(self):
        self.calls: list[dict[str, str]] = []
        self.limited = False
        self.status: int | None = None

    def __call__(self, request: httpx.Request) -> httpx.Response:
        assert request.url.host == "api.github.com"
        assert request.url.path == "/user/repos"
        assert request.headers["Authorization"] == f"Bearer {TOKEN}"
        params = dict(request.url.params)
        self.calls.append(params)
        if self.limited:
            reset = str(int(time.time()) + 120)
            return httpx.Response(
                403,
                headers={"x-ratelimit-remaining": "0", "x-ratelimit-reset": reset},
                json={"message": "API rate limit exceeded"},
            )
        if self.status:
            return httpx.Response(self.status, json={"message": "Bad credentials"})
        if params.get("page") == "2":
            return httpx.Response(200, json=PAGE2)
        nxt = '<https://api.github.com/user/repos?page=2&per_page=100>; rel="next"'
        return httpx.Response(200, json=PAGE1, headers={"Link": nxt})


@pytest.fixture
def github():
    fake = FakeGithub()
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
    return await add_connection(tenant_id, alice.id, "github", bundle={"access_token": TOKEN})


def url(conn, **params) -> str:
    query = "&".join(f"{k}={v}" for k, v in params.items())
    return f"/v1/connections/{conn.id}/github/repos" + (f"?{query}" if query else "")


async def test_lists_user_and_org_repos(client, alice, conn, github):
    resp = await client.get(url(conn), headers=alice.headers)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["repos"][0] == {
        "full_name": "example-org/example-app",
        "owner": "example-org",
        "name": "example-app",
        "is_private": True,
        "is_archived": False,
        "description": "The web app",
        "pushed_at": "2026-10-18T09:30:00Z",
    }
    assert [r["full_name"] for r in body["repos"]] == [
        "example-org/example-app",
        "ada/dotfiles",
        "example-org/old-site",
    ]
    assert body["next_cursor"] == "2"
    (call,) = github.calls
    assert call["affiliation"] == "owner,collaborator,organization_member"
    assert call["sort"] == "pushed"
    assert TOKEN not in resp.text


async def test_next_page(client, alice, conn, github):
    resp = await client.get(url(conn, cursor="2"), headers=alice.headers)
    assert resp.status_code == 200, resp.text
    assert [r["full_name"] for r in resp.json()["repos"]] == ["other-org/billing-api"]
    assert resp.json()["next_cursor"] is None


async def test_bad_cursor(client, alice, conn, github):
    resp = await client.get(url(conn, cursor="nope"), headers=alice.headers)
    assert resp.status_code == 422
    assert github.calls == []


async def test_search_owner_name_and_description_across_pages(client, alice, conn, github):
    resp = await client.get(url(conn, search="invoices"), headers=alice.headers)
    assert resp.status_code == 200, resp.text
    assert [r["full_name"] for r in resp.json()["repos"]] == ["other-org/billing-api"]
    assert resp.json()["next_cursor"] is None
    assert len(github.calls) == 2

    resp = await client.get(url(conn, search="EXAMPLE-ORG/"), headers=alice.headers)
    assert [r["full_name"] for r in resp.json()["repos"]] == [
        "example-org/example-app",
        "example-org/old-site",
    ]


async def test_another_users_connection_is_not_found(client, bob, conn, github):
    resp = await client.get(url(conn), headers=bob.headers)
    assert resp.status_code == 404
    assert github.calls == []


async def test_a_slack_connection_is_not_found(client, tenant_id, alice, github):
    other = await add_connection(tenant_id, alice.id, "slack")
    resp = await client.get(url(other), headers=alice.headers)
    assert resp.status_code == 404


@pytest.mark.timing
async def test_rate_limit_is_a_clear_retry(client, alice, conn, github):
    github.limited = True
    resp = await client.get(url(conn), headers=alice.headers)
    assert resp.status_code == 429
    wait = int(resp.headers["Retry-After"])
    assert 100 <= wait <= 121
    assert resp.json()["detail"] == f"GitHub is busy: try again in {wait} seconds"


async def test_rejected_token_marks_the_connection(client, tenant_id, alice, conn, github):
    github.status = 401
    resp = await client.get(url(conn), headers=alice.headers)
    assert resp.status_code == 409
    assert "reconnect" in resp.json()["detail"].lower()
    assert TOKEN not in resp.text
    async with tenant_session(tenant_id) as s:
        row = await s.scalar(select(Connection).where(Connection.id == conn.id))
        assert row.status == "expired"


async def test_provider_down_is_a_bad_gateway(client, alice, conn, github):
    github.status = 500
    resp = await client.get(url(conn), headers=alice.headers)
    assert resp.status_code == 502


async def test_github_unreachable_is_a_bad_gateway(client, alice, conn):
    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route", request=request)

    use_provider_http(down)
    try:
        resp = await client.get(url(conn), headers=alice.headers)
    finally:
        clear_provider_http()
    assert resp.status_code == 502
    assert resp.json()["detail"] == "GitHub could not be reached: try again"
