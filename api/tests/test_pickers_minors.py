"""Slack and GitHub pickers, review round 2 minors: strict dates, list caps, batched
validation, DM guards, GitHub SSO partial results, managed-user logins, and browsing
that does not write ``last_used_at``.
"""

import httpx
import pytest
from sqlalchemy import select

from oracle.connections import browse
from oracle.connections.models import Connection
from oracle.sources import base
from oracle.sources.base import ConnectorConfigError
from oracle.sources.connectors.github import GithubConnector
from oracle.sources.connectors.slack import MAX_CHANNELS, SlackConnector
from oracle.tenancy import tenant_session
from tests.connection_helpers import (
    add_connection,
    clear_provider_http,
    make_person,
    use_provider_http,
)
from tests.slack_world import SlackWorld, ts
from tests.sources_helpers import client_for, make_connection, make_user

CREDENTIAL = {"token": "xoxp-test-token"}


def slack_connector(world: SlackWorld) -> SlackConnector:
    return SlackConnector(httpx.AsyncClient(transport=httpx.MockTransport(world)))


@pytest.fixture
def slack(monkeypatch):
    world = SlackWorld()
    monkeypatch.setitem(base._registry, "slack", slack_connector(world))
    return world


@pytest.fixture
async def alice(tenant_id):
    return await make_user(tenant_id, "alice@example.com")


@pytest.fixture
async def a(alice):
    async with client_for(alice) as c:
        yield c


async def create_slack(a, tenant_id, alice, config: dict) -> httpx.Response:
    conn = await make_connection(tenant_id, alice, "slack")
    return await a.post(
        "/v1/sources",
        json={"kind": "slack", "name": "Chat", "connection_id": str(conn), "config": config},
    )


# --- strict dates -------------------------------------------------------------------


@pytest.mark.parametrize(
    "dates",
    [
        {"until": "9999-12-31"},
        {"since": "0001-01-01"},
        {"since": "1999-12-31"},
        {"until": "2101-01-01"},
        {"since": "20251010"},
        {"since": "2025-W41-1"},
        {"until": "2025-10-10T00:00"},
        {"since": " 2025-10-10"},
    ],
)
async def test_dates_out_of_bounds_or_not_yyyy_mm_dd_are_a_422(a, tenant_id, alice, slack, dates):
    resp = await create_slack(a, tenant_id, alice, {"channels": ["C0PRODUCT"], **dates})
    assert resp.status_code == 422, resp.text
    assert "YYYY-MM-DD" in resp.json()["detail"]
    assert slack.calls == []


async def test_dates_inside_the_bounds_are_accepted(a, tenant_id, alice, slack):
    config = {"channels": ["C0PRODUCT"], "since": "2000-01-01", "until": "2100-12-31"}
    resp = await create_slack(a, tenant_id, alice, config)
    assert resp.status_code == 201, resp.text


# --- list caps and batched validation -----------------------------------------------


async def test_too_many_channels_is_a_422(a, tenant_id, alice, slack):
    channels = [f"C{n:08d}" for n in range(MAX_CHANNELS + 1)]
    resp = await create_slack(a, tenant_id, alice, {"channels": channels})
    assert resp.status_code == 422
    assert f"at most {MAX_CHANNELS} channels" in resp.json()["detail"]
    assert slack.calls == []


async def test_fifty_channels_validate_in_one_list_read(a, tenant_id, alice, slack):
    channels = [f"C{n:08d}" for n in range(50)]
    slack.channels = {cid: [] for cid in [*channels, "C0PRODUCT", "C0ROADMAP"]}
    resp = await create_slack(a, tenant_id, alice, {"channels": channels})
    assert resp.status_code == 201, resp.text
    assert slack.count("conversations.info") == 0
    assert slack.count("conversations.list") == 1


async def test_a_channel_the_list_does_not_show_is_looked_up(a, tenant_id, alice, slack):
    slack.channels.update({"C0A": [], "C0B": []})
    channels = ["C0PRODUCT", "C0ROADMAP", "C0A", "C0B", "C0MISSING"]
    resp = await create_slack(a, tenant_id, alice, {"channels": channels})
    assert resp.status_code == 422
    assert "C0MISSING not found" in resp.json()["detail"]
    assert slack.count("conversations.list") == 1
    assert slack.count("conversations.info") == 1


async def test_a_rate_limit_while_validating_is_a_429(a, tenant_id, alice, slack):
    slack.limited = {"conversations.list", "conversations.info"}
    resp = await create_slack(a, tenant_id, alice, {"channels": ["C0PRODUCT", "C0ROADMAP"]})
    assert resp.status_code == 429, resp.text
    assert resp.headers["Retry-After"] == "30"
    assert "try again in 30 seconds" in resp.json()["detail"]


async def test_too_many_repos_is_a_422():
    from oracle.sources.connectors.github import MAX_REPOS

    def no_call(request: httpx.Request) -> httpx.Response:
        raise AssertionError("refused before any call to GitHub")

    connector = GithubConnector(httpx.AsyncClient(transport=httpx.MockTransport(no_call)))
    repos = [f"example-org/repo-{n}" for n in range(MAX_REPOS + 1)]
    with pytest.raises(ConnectorConfigError, match=f"at most {MAX_REPOS} repos"):
        await connector.validate({"repos": repos}, {"token": "t"})


# --- DM guards ----------------------------------------------------------------------


@pytest.mark.parametrize("channel", ["d0direct", " D0DIRECT", "D0DIRECT\n", "\td0direct"])
async def test_d_prefixed_ids_in_any_case_or_spacing_are_dms(channel):
    world = SlackWorld()
    with pytest.raises(ConnectorConfigError, match="DMs are never ingested"):
        await slack_connector(world).validate({"channels": [channel]}, CREDENTIAL)
    assert world.calls == []


async def test_an_mpdm_named_channel_is_a_dm():
    world = SlackWorld()
    world.channels["G0GROUPDM"] = []
    world.names["G0GROUPDM"] = "mpdm-ada--lin--sam-1"
    with pytest.raises(ConnectorConfigError, match="DMs are never ingested"):
        await slack_connector(world).validate({"channels": ["G0GROUPDM"]}, CREDENTIAL)
    with pytest.raises(ConnectorConfigError, match="DMs are never ingested"):
        await anext(slack_connector(world).sync({"channels": ["G0GROUPDM"]}, CREDENTIAL, None))
    assert world.count("conversations.history") == 0


async def test_channel_ids_are_trimmed():
    world = SlackWorld()
    world.channels["C0PRODUCT"] = [{"ts": ts("2025-10-01"), "user": "U0ADA", "text": "hi"}]
    events = [
        e
        async for e in slack_connector(world).sync({"channels": [" C0PRODUCT "]}, CREDENTIAL, None)
    ]
    assert events[0].external_id == f"C0PRODUCT:{ts('2025-10-01')}"


async def test_the_picker_drops_mpdm_names(client, tenant_id):
    person = await make_person(tenant_id, "pat@example.com")
    conn = await add_connection(
        tenant_id, person.id, "slack", bundle={"access_token": "xoxp-x"}, account_id="T0"
    )
    listed = [
        {"id": "C0PRODUCT", "name": "product", "is_channel": True},
        # A legacy group DM: a private "channel" Slack does not flag as is_mpim.
        {"id": "G0GROUPDM", "name": "mpdm-ada--lin-1", "is_group": True, "is_private": True},
        # A DM id in lower case.
        {"id": "d0direct", "name": "direct", "is_channel": False},
    ]

    def answer(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"ok": True, "channels": listed, "response_metadata": {}})

    use_provider_http(answer)
    browse.reset()
    try:
        resp = await client.get(f"/v1/connections/{conn.id}/slack/channels", headers=person.headers)
    finally:
        clear_provider_http()
    assert resp.status_code == 200, resp.text
    assert [c["id"] for c in resp.json()["channels"]] == ["C0PRODUCT"]


# --- GitHub -------------------------------------------------------------------------


async def test_sso_partial_results_are_a_hint(client, tenant_id):
    person = await make_person(tenant_id, "pat@example.com")
    conn = await add_connection(tenant_id, person.id, "github", bundle={"access_token": "gho_x"})

    def answer(request: httpx.Request) -> httpx.Response:
        repo = {"full_name": "ada/app", "name": "app", "owner": {"login": "ada"}}
        sso = "partial-results; organizations=21955855,20582480"
        return httpx.Response(200, json=[repo], headers={"X-GitHub-SSO": sso})

    use_provider_http(answer)
    browse.reset()
    try:
        resp = await client.get(f"/v1/connections/{conn.id}/github/repos", headers=person.headers)
        plain = await client.get(
            f"/v1/connections/{conn.id}/github/repos?search=app", headers=person.headers
        )
    finally:
        clear_provider_http()
    assert resp.status_code == 200, resp.text
    hint = resp.json()["sso_hint"]
    assert hint.startswith("2 organizations hide their repositories")
    assert "single sign-on" in hint
    assert plain.json()["sso_hint"] == hint


async def test_no_sso_header_no_hint(client, tenant_id):
    person = await make_person(tenant_id, "pat@example.com")
    conn = await add_connection(tenant_id, person.id, "github", bundle={"access_token": "gho_x"})
    use_provider_http(lambda request: httpx.Response(200, json=[]))
    browse.reset()
    try:
        resp = await client.get(f"/v1/connections/{conn.id}/github/repos", headers=person.headers)
    finally:
        clear_provider_http()
    assert resp.json()["sso_hint"] is None


@pytest.mark.parametrize("repo", ["ada_example/app", "Ada_Example-Corp/app"])
async def test_managed_user_logins_with_underscores_are_repo_owners(repo):
    def answer(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/user":
            return httpx.Response(200, json={"login": "ada_example"})
        return httpx.Response(
            200,
            json={"full_name": repo, "html_url": f"https://github.com/{repo}", "private": True},
        )

    connector = GithubConnector(httpx.AsyncClient(transport=httpx.MockTransport(answer)))
    await connector.validate({"repos": [repo]}, {"token": "t"})


# --- last_used_at -------------------------------------------------------------------


async def test_browsing_does_not_write_last_used_at(client, tenant_id):
    person = await make_person(tenant_id, "pat@example.com")
    conn = await add_connection(tenant_id, person.id, "github", bundle={"access_token": "gho_x"})
    use_provider_http(lambda request: httpx.Response(200, json=[]))
    browse.reset()
    try:
        for search in ("a", "ab", "abc"):
            resp = await client.get(
                f"/v1/connections/{conn.id}/github/repos?search={search}", headers=person.headers
            )
            assert resp.status_code == 200
    finally:
        clear_provider_http()
    async with tenant_session(tenant_id) as s:
        row = await s.scalar(select(Connection).where(Connection.id == conn.id))
        assert row.last_used_at is None
