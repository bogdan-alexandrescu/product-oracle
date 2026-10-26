"""An owner-set GraphQL endpoint on a Fireflies connection (BGD: "Build now, owner-set,
guarded"). Every request to it, the default included, goes through the guarded transport
of oracle.baseline.public_links; redirects to another host are refused, so the API key is
only ever sent to the configured host. No network: resolvers and connects are faked."""

import json
import uuid

import httpcore
import httpx
import pytest
from sqlalchemy import select

from oracle import crypto
from oracle.auth.service import create_api_token
from oracle.connections.models import Connection
from oracle.models import AuditEvent
from oracle.sources import fireflies_browse
from oracle.sources.connectors import fireflies
from oracle.sources.connectors.fireflies import (
    DEFAULT_ENDPOINT,
    EndpointRefused,
    FirefliesConnector,
    check_endpoint,
    guarded_client,
)
from oracle.tenancy import tenant_session
from tests.connection_helpers import (
    add_connection,
    clear_provider_http,
    make_person,
    use_provider_http,
)
from tests.fireflies_fake import API_KEY, SAMPLE, FakeFireflies

CUSTOM = "https://ff.example.com/graphql"
PUBLIC_IP = "93.184.216.34"
NEW_KEY = "ff-new-key-2"
ANOTHER_ACCOUNT = (
    "That key belongs to another Fireflies account than this connection's; "
    "connect it as a new connection"
)


# --- the URL rule ---------------------------------------------------------------------


@pytest.mark.parametrize(
    ("url", "words"),
    [
        ("http://ff.example.com/graphql", "https://"),
        ("https://ff.example.com:8443/graphql", "standard https port"),
        ("https://user:secret@ff.example.com/graphql", "user name or password"),
        ("https://user@ff.example.com/graphql", "user name or password"),
        ("https://ff.example.com/graphql?x=1", "query"),
        ("https://ff.example.com/graphql#top", "query"),
        ("https://10.0.0.5/graphql", "private"),
        ("https://192.168.1.10/graphql", "private"),
        ("https://127.0.0.1/graphql", "private"),
        ("https://[::1]/graphql", "private"),
        ("https://169.254.169.254/graphql", "private"),
        ("https://[fe80::1]/graphql", "private"),
        ("https://[::ffff:10.0.0.5]/graphql", "private"),
        ("https://[::ffff:127.0.0.1]/graphql", "private"),
        ("https://100.64.0.1/graphql", "private"),
        ("not a url", "https://"),
        ("https://[nope/graphql", "valid"),
        # Octal, hex and short IPv4 forms: resolvers read them as 127.0.0.1.
        ("https://0177.0.0.1/graphql", "private"),
        ("https://0x7f000001/graphql", "private"),
        ("https://127.1/graphql", "private"),
        ("https://2130706433/graphql", "private"),
        ("https://0x7f.0.0.1/graphql", "private"),
        # A public address in such a form is refused too, and an invalid one.
        ("https://0x5db8d822/graphql", "four decimal numbers"),
        ("https://93.184.216.034/graphql", "four decimal numbers"),
        ("https://1.2.3.08/graphql", "valid"),
    ],
)
def test_the_endpoint_rule_refuses(url, words):
    with pytest.raises(EndpointRefused) as refused:
        check_endpoint(url)
    assert words in str(refused.value)


def test_the_endpoint_rule_keeps_https_on_the_default_port():
    assert check_endpoint(CUSTOM) == CUSTOM
    assert check_endpoint("https://FF.Example.com:443/graphql") == CUSTOM
    # The default reads as none: such a connection behaves exactly as before.
    assert check_endpoint(DEFAULT_ENDPOINT) is None
    assert check_endpoint(None) is None
    assert check_endpoint("  ") is None


# --- the guarded transport ------------------------------------------------------------


@pytest.fixture
def connects(monkeypatch):
    """Record every TCP connect the guarded transport makes (and make none)."""
    seen: list[str] = []

    async def connect_tcp(self, host, port, **kwargs):
        seen.append(host)
        raise httpcore.ConnectError("no network in tests")

    monkeypatch.setattr(httpcore.AnyIOBackend, "connect_tcp", connect_tcp)
    return seen


def resolver(*answers: list[str]):
    """A resolver that gives each answer in turn (the last one from then on)."""
    calls: list[str] = []

    async def resolve(host: str, port: int) -> list[str]:
        calls.append(host)
        return answers[min(len(calls), len(answers)) - 1]

    resolve.calls = calls  # type: ignore[attr-defined]
    return resolve


async def _user_query(endpoint: str, resolve) -> None:
    async with guarded_client(resolve) as client:
        await FirefliesConnector(client).validate(
            {"mode": "all"}, {"api_key": API_KEY, "endpoint": endpoint}
        )


async def test_a_host_resolving_to_a_private_address_is_never_connected(connects):
    resolve = resolver(["10.1.2.3"])
    with pytest.raises(httpx.ConnectError) as refused:
        await _user_query(CUSTOM, resolve)
    assert fireflies.address_refused(refused.value)
    assert resolve.calls == ["ff.example.com"]
    assert connects == []


async def test_the_default_endpoint_goes_through_the_guard_too(connects):
    resolve = resolver(["127.0.0.1"])
    with pytest.raises(httpx.ConnectError):
        await _user_query(DEFAULT_ENDPOINT, resolve)
    assert resolve.calls == ["api.fireflies.ai"]
    assert connects == []


async def test_the_registered_connector_reads_through_the_guard(connects, monkeypatch):
    """No client given (the registered connector, a sync): the guarded one, with the
    system resolver, which the test replaces."""
    from oracle.baseline import public_links

    resolve = resolver(["10.9.9.9"])
    monkeypatch.setattr(public_links, "system_resolve", resolve)
    monkeypatch.setattr(fireflies, "system_resolve", resolve, raising=False)
    with pytest.raises(httpx.ConnectError):
        await FirefliesConnector().validate({"mode": "all"}, {"api_key": API_KEY})
    assert resolve.calls == ["api.fireflies.ai"]
    assert connects == []


async def test_dns_rebinding_connects_only_to_the_address_it_checked(connects):
    """The first answer is public (connected to, by address); the second is private:
    refused before any connect."""
    resolve = resolver([PUBLIC_IP], ["10.0.0.7"])
    async with guarded_client(resolve) as client:
        connector = FirefliesConnector(client)
        credential = {"api_key": API_KEY, "endpoint": CUSTOM}
        with pytest.raises(httpx.ConnectError):
            await connector.validate({"mode": "all"}, credential)
        assert connects == [PUBLIC_IP]
        with pytest.raises(httpx.ConnectError) as refused:
            await connector.validate({"mode": "all"}, credential)
    assert fireflies.address_refused(refused.value)
    assert resolve.calls == ["ff.example.com", "ff.example.com"]
    assert connects == [PUBLIC_IP]


# --- redirects and where the key goes -------------------------------------------------


def _user_answer() -> httpx.Response:
    return httpx.Response(200, json={"data": {"user": {"user_id": "u1", "email": "a@b.c"}}})


async def _validate_with(handler, endpoint: str = CUSTOM) -> list[httpx.Request]:
    seen: list[httpx.Request] = []

    def record(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    async with httpx.AsyncClient(transport=httpx.MockTransport(record)) as client:
        await FirefliesConnector(client).validate(
            {"mode": "all"}, {"api_key": API_KEY, "endpoint": endpoint}
        )
    return seen


@pytest.mark.parametrize(
    "location",
    [
        "https://other.example.net/graphql",
        "https://10.0.0.1/graphql",
        "https://169.254.169.254/latest/meta-data",
        "https://ff.example.com.evil.example/graphql",
        "http://ff.example.com/graphql",
        "https://ff.example.com:8443/graphql",
    ],
)
async def test_a_redirect_elsewhere_is_refused_and_the_key_stays_home(location):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "ff.example.com" and request.url.port in (None, 443):
            if request.url.scheme == "https":
                return httpx.Response(307, headers={"Location": location})
        return _user_answer()

    with pytest.raises(EndpointRefused) as refused:
        await _validate_with(handler)
    assert "redirect" in str(refused.value)
    assert API_KEY not in str(refused.value)


async def test_a_same_host_redirect_is_followed():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/graphql":
            return httpx.Response(308, headers={"Location": "/v2/graphql"})
        return _user_answer()

    seen = await _validate_with(handler)
    assert [str(r.url) for r in seen] == [CUSTOM, "https://ff.example.com/v2/graphql"]
    assert all(r.method == "POST" for r in seen)


async def test_too_many_redirects_are_refused():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(307, headers={"Location": "/graphql"})

    with pytest.raises(EndpointRefused):
        await _validate_with(handler)


async def test_the_key_is_sent_only_to_the_configured_host():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/graphql":
            return httpx.Response(307, headers={"Location": "https://other.example.net/x"})
        return _user_answer()

    seen: list[httpx.Request] = []

    def record(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    async with httpx.AsyncClient(transport=httpx.MockTransport(record)) as client:
        with pytest.raises(EndpointRefused):
            await FirefliesConnector(client).validate(
                {"mode": "all"}, {"api_key": API_KEY, "endpoint": CUSTOM}
            )
    assert [r.url.host for r in seen] == ["ff.example.com"]
    assert all(r.headers["Authorization"] == f"Bearer {API_KEY}" for r in seen)


# --- sync and browse read the configured endpoint -------------------------------------


async def test_sync_reads_the_configured_endpoint():
    fake = FakeFireflies(list(SAMPLE), api_url=CUSTOM)
    seen: list[str] = []

    def record(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return fake(request)

    async with httpx.AsyncClient(transport=httpx.MockTransport(record)) as client:
        events = [
            e
            async for e in FirefliesConnector(client).sync(
                {"mode": "all"}, {"api_key": API_KEY, "endpoint": CUSTOM}, None
            )
        ]
    assert events
    assert seen and set(seen) == {CUSTOM}


async def test_a_connection_credential_carries_its_endpoint(tenant_id):
    from oracle.connections import service as connections
    from oracle.sources.service import _read_credential

    owner = await make_person(tenant_id, "owner@example.com", "owner")
    row = await add_connection(tenant_id, owner.id, "fireflies", bundle={"access_token": API_KEY})
    async with tenant_session(tenant_id) as s:
        conn = await s.get(Connection, row.id)
        conn.endpoint_url = CUSTOM
        await s.commit()
        credential = await _read_credential(s, conn)
        assert credential["endpoint"] == CUSTOM
        assert credential["api_key"] == API_KEY
        plain = await connections.credential_for(s, conn)
        assert plain.endpoint_url == CUSTOM


@pytest.fixture
def browse_fake():
    fake = FakeFireflies(list(SAMPLE), api_url=CUSTOM)
    seen = use_provider_http(fake)
    fireflies_browse.reset_limits()
    yield fake, seen
    clear_provider_http()
    fireflies_browse.reset_limits()


async def _fireflies_connection(tenant_id, user_id, endpoint: str | None) -> uuid.UUID:
    row = await add_connection(
        tenant_id,
        user_id,
        "fireflies",
        bundle={"access_token": API_KEY},
        account_id=f"ff-{uuid.uuid4().hex[:6]}",
    )
    async with tenant_session(tenant_id) as s:
        conn = await s.get(Connection, row.id)
        conn.endpoint_url = endpoint
        await s.commit()
    return row.id


async def test_browse_reads_the_configured_endpoint(client, tenant_id, browse_fake):
    _, seen = browse_fake
    owner = await make_person(tenant_id, "owner@example.com", "owner")
    conn = await _fireflies_connection(tenant_id, owner.id, CUSTOM)
    resp = await client.get(f"/v1/connections/{conn}/fireflies/meetings", headers=owner.headers)
    assert resp.status_code == 200, resp.text
    resp = await client.get(f"/v1/connections/{conn}/fireflies/series", headers=owner.headers)
    assert resp.status_code == 200, resp.text
    assert seen and {str(r.url) for r in seen} == {CUSTOM}
    assert API_KEY not in resp.text


async def test_another_host_browses_on_a_looser_budget(client, tenant_id, browse_fake):
    assert fireflies_browse.OTHER_HOST_CALLS_PER_MINUTE > fireflies_browse.CALLS_PER_MINUTE
    assert fireflies_browse.OTHER_HOST_CALLS_PER_DAY > fireflies_browse.CALLS_PER_DAY
    owner = await make_person(tenant_id, "owner@example.com", "owner")
    conn = await _fireflies_connection(tenant_id, owner.id, CUSTOM)
    url = f"/v1/connections/{conn}/fireflies/meetings"
    calls = fireflies_browse.OTHER_HOST_CALLS_PER_MINUTE
    statuses = [
        (await client.get(url, params={"search": f"m{i}"}, headers=owner.headers)).status_code
        for i in range(calls + 1)
    ]
    assert statuses == [200] * calls + [429]


async def test_fireflies_ai_keeps_its_budget(client, tenant_id):
    fake = FakeFireflies(list(SAMPLE))
    use_provider_http(fake)
    fireflies_browse.reset_limits()
    try:
        owner = await make_person(tenant_id, "owner@example.com", "owner")
        conn = await _fireflies_connection(tenant_id, owner.id, None)
        url = f"/v1/connections/{conn}/fireflies/meetings"
        calls = fireflies_browse.CALLS_PER_MINUTE
        statuses = [
            (await client.get(url, params={"search": f"m{i}"}, headers=owner.headers)).status_code
            for i in range(calls + 1)
        ]
        assert statuses == [200] * calls + [429]
    finally:
        clear_provider_http()
        fireflies_browse.reset_limits()


# --- who can set it -------------------------------------------------------------------


@pytest.fixture
def identify():
    """Fireflies answers the user query at any host the test names."""
    seen = use_provider_http(lambda request: _user_answer())
    yield seen
    clear_provider_http()


async def test_an_owner_connects_with_an_endpoint_and_sees_it(client, tenant_id, identify):
    owner = await make_person(tenant_id, "owner@example.com", "owner")
    resp = await client.post(
        "/v1/connections/fireflies/token",
        json={"token": API_KEY, "endpoint_url": CUSTOM},
        headers=owner.headers,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["endpoint_url"] == CUSTOM
    assert API_KEY not in resp.text
    assert [str(r.url) for r in identify] == [CUSTOM]
    listed = await client.get("/v1/connections", headers=owner.headers)
    assert [c["endpoint_url"] for c in listed.json()] == [CUSTOM]
    kinds = await client.get("/v1/sources/kinds", headers=owner.headers)
    ff = next(k for k in kinds.json() if k["kind"] == "fireflies")
    assert [c["endpoint_url"] for c in ff["connections"]] == [CUSTOM]
    assert API_KEY not in kinds.text


async def test_a_connection_without_one_reads_the_default(client, tenant_id, identify):
    viewer = await make_person(tenant_id, "viewer@example.com", "viewer")
    resp = await client.post(
        "/v1/connections/fireflies/token", json={"token": API_KEY}, headers=viewer.headers
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["endpoint_url"] == DEFAULT_ENDPOINT
    assert [str(r.url) for r in identify] == [DEFAULT_ENDPOINT]
    async with tenant_session(tenant_id) as s:
        assert (await s.scalar(select(Connection))).endpoint_url is None


@pytest.mark.parametrize("role", ["approver", "commenter", "viewer"])
async def test_only_an_owner_sets_an_endpoint_on_connect(client, tenant_id, identify, role):
    person = await make_person(tenant_id, f"{role}@example.com", role)
    resp = await client.post(
        "/v1/connections/fireflies/token",
        json={"token": API_KEY, "endpoint_url": CUSTOM},
        headers=person.headers,
    )
    assert resp.status_code == 403, resp.text
    assert "owner" in resp.json()["detail"]
    assert identify == []
    async with tenant_session(tenant_id) as s:
        assert await s.scalar(select(Connection)) is None


@pytest.mark.parametrize("role", ["approver", "commenter", "viewer"])
async def test_only_an_owner_changes_an_endpoint(client, tenant_id, identify, role):
    person = await make_person(tenant_id, f"{role}@example.com", role)
    conn = await _fireflies_connection(tenant_id, person.id, None)
    resp = await client.put(
        f"/v1/connections/{conn}/endpoint",
        json={"endpoint_url": CUSTOM, "token": NEW_KEY},
        headers=person.headers,
    )
    assert resp.status_code == 403, resp.text
    assert identify == []
    async with tenant_session(tenant_id) as s:
        assert (await s.get(Connection, conn)).endpoint_url is None


async def test_an_owner_changes_the_endpoint_with_the_key_again(client, tenant_id, identify):
    owner = await make_person(tenant_id, "owner@example.com", "owner")
    conn = await _fireflies_connection(tenant_id, owner.id, None)
    async with tenant_session(tenant_id) as s:
        row = await s.get(Connection, conn)
        row.account_id = "u1"
        await s.commit()
    # The key must be entered again with a new endpoint.
    missing = await client.put(
        f"/v1/connections/{conn}/endpoint", json={"endpoint_url": CUSTOM}, headers=owner.headers
    )
    assert missing.status_code == 422, missing.text
    resp = await client.put(
        f"/v1/connections/{conn}/endpoint",
        json={"endpoint_url": CUSTOM, "token": NEW_KEY},
        headers=owner.headers,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["endpoint_url"] == CUSTOM
    assert NEW_KEY not in resp.text
    assert [str(r.url) for r in identify] == [CUSTOM]
    assert identify[0].headers["Authorization"] == f"Bearer {NEW_KEY}"
    async with tenant_session(tenant_id) as s:
        row = await s.get(Connection, conn)
        assert row.endpoint_url == CUSTOM
        assert json.loads(crypto.decrypt(row.ciphertext))["access_token"] == NEW_KEY
        events = list(
            await s.scalars(select(AuditEvent).where(AuditEvent.action == "connection.endpoint"))
        )
    assert len(events) == 1
    assert events[0].data["from"] == DEFAULT_ENDPOINT
    assert events[0].data["to"] == CUSTOM
    assert NEW_KEY not in json.dumps(events[0].data)
    assert API_KEY not in json.dumps(events[0].data)

    # Back to the default.
    back = await client.put(
        f"/v1/connections/{conn}/endpoint",
        json={"endpoint_url": None, "token": NEW_KEY},
        headers=owner.headers,
    )
    assert back.status_code == 200, back.text
    assert back.json()["endpoint_url"] == DEFAULT_ENDPOINT


async def test_an_endpoint_of_another_account_is_refused(client, tenant_id, identify):
    owner = await make_person(tenant_id, "owner@example.com", "owner")
    conn = await _fireflies_connection(tenant_id, owner.id, None)
    resp = await client.put(
        f"/v1/connections/{conn}/endpoint",
        json={"endpoint_url": CUSTOM, "token": NEW_KEY},
        headers=owner.headers,
    )
    assert resp.status_code == 400, resp.text
    # The account's name comes from the endpoint's server: it is not echoed back.
    assert resp.json()["detail"] == ANOTHER_ACCOUNT
    assert "a@b.c" not in resp.text
    async with tenant_session(tenant_id) as s:
        assert (await s.get(Connection, conn)).endpoint_url is None


async def test_only_fireflies_takes_an_endpoint(client, tenant_id, identify):
    owner = await make_person(tenant_id, "owner@example.com", "owner")
    resp = await client.post(
        "/v1/connections/github/token",
        json={"token": "example-github-token", "endpoint_url": CUSTOM},
        headers=owner.headers,
    )
    assert resp.status_code == 422, resp.text
    conn = await add_connection(tenant_id, owner.id, "github")
    resp = await client.put(
        f"/v1/connections/{conn.id}/endpoint",
        json={"endpoint_url": CUSTOM, "token": "x" * 10},
        headers=owner.headers,
    )
    assert resp.status_code == 422, resp.text


@pytest.mark.parametrize(
    ("url", "words"),
    [
        ("http://ff.example.com/graphql", "https://"),
        ("https://10.0.0.5/graphql", "private"),
        ("https://ff.example.com:8080/graphql", "standard https port"),
    ],
)
async def test_the_api_refuses_a_bad_endpoint_in_words(client, tenant_id, identify, url, words):
    owner = await make_person(tenant_id, "owner@example.com", "owner")
    resp = await client.post(
        "/v1/connections/fireflies/token",
        json={"token": API_KEY, "endpoint_url": url},
        headers=owner.headers,
    )
    assert resp.status_code == 422, resp.text
    assert words in resp.json()["detail"]
    assert API_KEY not in resp.text
    assert identify == []


async def test_a_host_resolving_privately_is_refused_in_words(client, tenant_id, connects):
    """No provider override: the real Fireflies client (the guarded transport); the
    system resolver answers a private address."""
    from oracle.baseline import public_links

    resolve = resolver(["192.168.0.20"])
    from unittest import mock

    with (
        mock.patch.object(public_links, "system_resolve", resolve),
        mock.patch.object(fireflies, "system_resolve", resolve, create=True),
    ):
        owner = await make_person(tenant_id, "owner@example.com", "owner")
        resp = await client.post(
            "/v1/connections/fireflies/token",
            json={"token": API_KEY, "endpoint_url": CUSTOM},
            headers=owner.headers,
        )
    assert resp.status_code == 422, resp.text
    assert "private" in resp.json()["detail"]
    assert API_KEY not in resp.text
    assert connects == []


# --- MCP and run tokens ---------------------------------------------------------------


async def _personal_token(tenant_id, person) -> str:
    async with tenant_session(tenant_id) as s:
        _, raw = await create_api_token(
            s, "pat", user_id=person.id, scope="oracle:read oracle:write"
        )
        await s.commit()
    return raw


@pytest.mark.parametrize("role", ["approver", "commenter", "viewer"])
async def test_mcp_tools_refuse_an_endpoint_below_owner(tenant_id, identify, role):
    from tests.test_mcp import mcp_client, text_of

    person = await make_person(tenant_id, f"{role}@example.com", role)
    conn = await _fireflies_connection(tenant_id, person.id, None)
    async with mcp_client(await _personal_token(tenant_id, person)) as c:
        connect = await c.call_tool(
            "connect_with_token",
            {"provider": "fireflies", "body": {"token": API_KEY, "endpoint_url": CUSTOM}},
        )
        change = await c.call_tool(
            "set_connection_endpoint",
            {"connection_id": str(conn), "body": {"endpoint_url": CUSTOM, "token": NEW_KEY}},
        )
    assert connect.is_error and "HTTP 403" in text_of(connect)
    assert change.is_error and "HTTP 403" in text_of(change)
    assert identify == []
    async with tenant_session(tenant_id) as s:
        assert [c.endpoint_url for c in await s.scalars(select(Connection))] == [None]


async def test_an_owner_sets_the_endpoint_over_mcp(tenant_id, identify):
    from tests.test_mcp import mcp_client, text_of

    owner = await make_person(tenant_id, "owner@example.com", "owner")
    async with mcp_client(await _personal_token(tenant_id, owner)) as c:
        connect = await c.call_tool(
            "connect_with_token",
            {"provider": "fireflies", "body": {"token": API_KEY, "endpoint_url": CUSTOM}},
        )
    assert not connect.is_error, text_of(connect)
    assert connect.structured_content["endpoint_url"] == CUSTOM
    assert API_KEY not in text_of(connect)


async def test_a_run_token_cannot_set_an_endpoint(tenant_id, identify):
    from oracle.swarm import FakeRuntime, set_runtime
    from tests.test_mcp import mcp_client, run_token, text_of

    set_runtime(FakeRuntime())
    try:
        owner = await make_person(tenant_id, "owner@example.com", "owner")
        conn = await _fireflies_connection(tenant_id, owner.id, None)
        token = await run_token(tenant_id, ["read:sources", "write:proposals"], owner.id)
        async with mcp_client(token) as c:
            change = await c.call_tool(
                "set_connection_endpoint",
                {"connection_id": str(conn), "body": {"endpoint_url": CUSTOM, "token": NEW_KEY}},
            )
            connect = await c.call_tool(
                "connect_with_token",
                {"provider": "fireflies", "body": {"token": API_KEY, "endpoint_url": CUSTOM}},
            )
    finally:
        set_runtime(None)
    assert change.is_error, text_of(change)
    assert connect.is_error, text_of(connect)
    assert identify == []
    async with tenant_session(tenant_id) as s:
        assert (await s.get(Connection, conn)).endpoint_url is None


async def test_connecting_again_keeps_an_owner_set_endpoint_from_others(
    client, tenant_id, identify
):
    """A member demoted after their owner-set endpoint pastes the key again: the
    endpoint is not reset by them; an owner's paste resets it, recorded."""
    person = await make_person(tenant_id, "pm@example.com", "approver")
    conn = await _fireflies_connection(tenant_id, person.id, CUSTOM)
    async with tenant_session(tenant_id) as s:
        (await s.get(Connection, conn)).account_id = "u1"
        await s.commit()
    resp = await client.post(
        "/v1/connections/fireflies/token", json={"token": API_KEY}, headers=person.headers
    )
    assert resp.status_code == 403, resp.text
    async with tenant_session(tenant_id) as s:
        assert (await s.get(Connection, conn)).endpoint_url == CUSTOM
        (await s.get(type(person.user), person.id)).role = "owner"
        await s.commit()
    resp = await client.post(
        "/v1/connections/fireflies/token", json={"token": API_KEY}, headers=person.headers
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["endpoint_url"] == DEFAULT_ENDPOINT
    async with tenant_session(tenant_id) as s:
        events = list(
            await s.scalars(select(AuditEvent).where(AuditEvent.action == "connection.endpoint"))
        )
    assert [(e.data["from"], e.data["to"]) for e in events] == [(CUSTOM, DEFAULT_ENDPOINT)]


# --- #602 review ----------------------------------------------------------------------


@pytest.mark.parametrize(
    "url", ["https://0177.0.0.1/graphql", "https://1.2.3.08/graphql", "https://127.1/graphql"]
)
async def test_an_odd_ip_form_is_refused_in_words_not_a_500(client, tenant_id, identify, url):
    owner = await make_person(tenant_id, "owner@example.com", "owner")
    resp = await client.post(
        "/v1/connections/fireflies/token",
        json={"token": API_KEY, "endpoint_url": url},
        headers=owner.headers,
    )
    assert resp.status_code == 422, resp.text
    assert "Product Oracle" in resp.json()["detail"] or "valid" in resp.json()["detail"]
    assert API_KEY not in resp.text
    assert identify == []
    async with tenant_session(tenant_id) as s:
        assert await s.scalar(select(Connection)) is None


async def test_the_transport_refuses_a_url_httpx_cannot_read_in_words():
    """Behind check_endpoint: a URL httpx cannot parse is an EndpointRefused, never an
    uncaught httpx.InvalidURL."""
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: _user_answer())) as c:
        with pytest.raises(EndpointRefused) as refused:
            await fireflies.post(c, "https://0177.0.0.1/graphql", API_KEY, {"query": "q"})
    assert "valid" in str(refused.value)
    assert API_KEY not in str(refused.value)


async def test_the_endpoint_routes_are_per_item_checks(client, tenant_id):
    """Connect takes an endpoint from an owner only (below, the input decides); the PUT is
    an owner's. /v1/me/capabilities says so, and the web's can() reads it."""
    import oracle.capabilities as caps

    assert caps.PER_ITEM["connect_with_token"] == "owner"
    assert caps.PER_ITEM["set_connection_endpoint"] == "owner"
    approver = await make_person(tenant_id, "pm@example.com", "approver")
    body = (await client.get("/v1/me/capabilities", headers=approver.headers)).json()
    assert body["operations"]["connect_with_token"] is True
    assert body["operations"]["set_connection_endpoint"] is False
    assert body["per_item"]["connect_with_token"] == "owner"
    assert body["per_item"]["set_connection_endpoint"] == "owner"


async def test_the_endpoint_change_rechecks_the_caller_at_write_time(
    client, tenant_id, identify, monkeypatch
):
    """As other owner-only writes (require_role_now): an owner disabled or demoted while
    the request was in flight is refused before the key goes anywhere."""
    from fastapi import HTTPException

    from oracle import authz

    async def refuse(session, principal, min_role, **kwargs):
        raise HTTPException(403, "You are no longer an owner")

    monkeypatch.setattr(authz, "recheck_caller", refuse)
    owner = await make_person(tenant_id, "owner@example.com", "owner")
    conn = await _fireflies_connection(tenant_id, owner.id, None)
    resp = await client.put(
        f"/v1/connections/{conn}/endpoint",
        json={"endpoint_url": CUSTOM, "token": NEW_KEY},
        headers=owner.headers,
    )
    assert resp.status_code == 403, resp.text
    assert resp.json()["detail"] == "You are no longer an owner"
    assert identify == []


async def test_a_run_token_cannot_change_an_endpoint_over_rest(client, tenant_id, identify):
    """The MCP server's in-process REST call for a run carries the creator's credential and
    the run's header: the route refuses it (``not_for_runs``), whatever the creator's role."""
    from oracle.auth.deps import RUN_HEADER, RUN_TOKEN_HEADER
    from oracle.auth.service import sign_run_binding
    from tests.test_mcp import run_token

    owner = await make_person(tenant_id, "owner@example.com", "owner")
    conn = await _fireflies_connection(tenant_id, owner.id, None)
    run = await run_token(tenant_id, ["read:sources", "write:proposals"], owner.id)
    for headers in (
        {**owner.headers, RUN_TOKEN_HEADER: run},
        {**owner.headers, RUN_HEADER: sign_run_binding(owner.id, uuid.uuid4())},
    ):
        resp = await client.put(
            f"/v1/connections/{conn}/endpoint",
            json={"endpoint_url": CUSTOM, "token": NEW_KEY},
            headers=headers,
        )
        assert resp.status_code == 403, resp.text
        assert "run" in resp.json()["detail"]
    assert identify == []
    async with tenant_session(tenant_id) as s:
        assert (await s.get(Connection, conn)).endpoint_url is None
