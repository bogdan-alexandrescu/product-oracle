"""A source whose connection was deleted (Disconnect) can be linked again (owner Nov 3).

The connection's provider and account stay on the source when the link is cleared: the
same person connecting the same account again links it by itself; another account is
never linked by itself but can be picked; another provider's connection is refused.
"""

import httpx
import pytest
from sqlalchemy import select

from oracle.sources import base, service
from oracle.sources.models import Source
from oracle.tenancy import tenant_session
from oracle.v2.models import ChangeEvent
from tests.connection_helpers import (
    add_connection,
    clear_provider_http,
    make_person,
    use_provider_http,
)
from tests.sources_helpers import FakeConnector, message, patch_source

TOKEN = "example-github-token-1"
OTHER = "example-github-x"


def github(request: httpx.Request) -> httpx.Response:
    token = request.headers.get("Authorization", "").removeprefix("Bearer ")
    if token.startswith("example-github"):
        account = 7 if token.endswith("-x") else 42
        return httpx.Response(
            200,
            json={"id": account, "login": f"user-{account}"},
            headers={"X-OAuth-Scopes": "repo"},
        )
    return httpx.Response(401, json={"message": "Bad credentials"})


@pytest.fixture(autouse=True)
def _http():
    seen = use_provider_http(github)
    yield seen
    clear_provider_http()


@pytest.fixture
def fake(monkeypatch):
    service.load_connectors()
    connector = FakeConnector(kind="github", pages=[[message("i1", "Hello", kind="issue")]])
    monkeypatch.setitem(base._registry, "github", connector)
    return connector


@pytest.fixture
async def alice(tenant_id):
    return await make_person(tenant_id, "alice@example.com", "owner")


async def _connect(client, alice, token: str) -> dict:
    resp = await client.post(
        "/v1/connections/github/token", json={"token": token}, headers=alice.headers
    )
    assert resp.status_code in (200, 201), resp.text
    return resp.json()


async def _source(client, alice, conn_id: str) -> dict:
    resp = await client.post(
        "/v1/sources",
        json={
            "kind": "github",
            "name": "Shop code",
            "connection_id": conn_id,
            "config": {"repos": ["example/shop"]},
        },
        headers=alice.headers,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _get(client, alice, source_id) -> dict:
    resp = await client.get(f"/v1/sources/{source_id}", headers=alice.headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _disconnect(client, alice, conn_id) -> None:
    resp = await client.delete(f"/v1/connections/{conn_id}", headers=alice.headers)
    assert resp.status_code == 204, resp.text


async def test_disconnect_leaves_the_source_without_a_connection(client, tenant_id, alice, fake):
    conn = await _connect(client, alice, TOKEN)
    src = await _source(client, alice, conn["id"])
    await _disconnect(client, alice, conn["id"])

    got = await _get(client, alice, src["id"])
    assert got["connection_id"] is None
    resp = await client.post(f"/v1/sources/{src['id']}/sync", headers=alice.headers)
    assert resp.status_code == 200, resp.text
    assert resp.json()["outcome"] == "error"
    assert "no connection" in resp.json()["error"]
    async with tenant_session(tenant_id) as s:
        row = await s.get(Source, src["id"])
        # What it lost is kept, so the same account connecting again links it.
        assert (row.lost_provider, row.lost_account_id) == ("github", "42")
        # The publish gate's revocation stands as before.
        causes = list(
            await s.scalars(
                select(ChangeEvent.cause).where(
                    ChangeEvent.subject_kind == "source_permission",
                    ChangeEvent.subject_id == row.id,
                )
            )
        )
        assert causes == ["connection_revoked"]


async def test_the_same_account_connecting_again_links_it_and_a_sync_reads_through_it(
    client, tenant_id, alice, fake
):
    conn = await _connect(client, alice, TOKEN)
    src = await _source(client, alice, conn["id"])
    await _disconnect(client, alice, conn["id"])
    before = (await _get(client, alice, src["id"]))["config_version"]

    again = await _connect(client, alice, TOKEN + "-new")
    assert again["id"] != conn["id"]
    got = await _get(client, alice, src["id"])
    assert got["connection_id"] == again["id"]
    assert got["config_version"] == before + 1

    resp = await client.post(f"/v1/sources/{src['id']}/sync", headers=alice.headers)
    assert resp.status_code == 200, resp.text
    assert resp.json()["outcome"] == "completed", resp.text
    assert fake.calls[-1]["credential"]["access_token"] == TOKEN + "-new"
    async with tenant_session(tenant_id) as s:
        row = await s.get(Source, src["id"])
        assert (row.lost_provider, row.lost_account_id) == (None, None)


async def test_another_account_is_not_linked_by_itself_but_can_be_picked(
    client, tenant_id, alice, fake
):
    conn = await _connect(client, alice, TOKEN)
    src = await _source(client, alice, conn["id"])
    await _disconnect(client, alice, conn["id"])

    other = await _connect(client, alice, OTHER)
    assert (await _get(client, alice, src["id"]))["connection_id"] is None
    # Offered as a choice for the source's kind.
    kinds = (await client.get("/v1/sources/kinds", headers=alice.headers)).json()
    choices = next(k for k in kinds if k["kind"] == "github")["connections"]
    assert [c["id"] for c in choices] == [other["id"]]

    resp = await patch_source(
        client, src["id"], {"connection_id": other["id"]}, headers=alice.headers
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["connection_id"] == other["id"]
    resp = await client.post(f"/v1/sources/{src['id']}/sync", headers=alice.headers)
    assert resp.status_code == 200, resp.text
    assert resp.json()["outcome"] == "completed", resp.text
    assert fake.calls[-1]["credential"]["access_token"] == OTHER

    # Picked: the lost account no longer takes it back by itself.
    await _connect(client, alice, TOKEN)
    assert (await _get(client, alice, src["id"]))["connection_id"] == other["id"]


async def test_another_persons_same_account_is_not_linked(client, tenant_id, alice, fake):
    bob = await make_person(tenant_id, "bob@example.com", "owner")
    conn = await _connect(client, alice, TOKEN)
    src = await _source(client, alice, conn["id"])
    await _disconnect(client, alice, conn["id"])

    await _connect(client, bob, TOKEN)
    assert (await _get(client, alice, src["id"]))["connection_id"] is None


async def test_picking_a_connection_of_another_provider_is_refused(client, tenant_id, alice, fake):
    conn = await _connect(client, alice, TOKEN)
    src = await _source(client, alice, conn["id"])
    await _disconnect(client, alice, conn["id"])
    slack = await add_connection(tenant_id, alice.id, "slack")

    resp = await patch_source(
        client, src["id"], {"connection_id": str(slack.id)}, headers=alice.headers
    )
    assert resp.status_code == 422
    assert "github connection, not a slack one" in resp.json()["detail"]
    assert (await _get(client, alice, src["id"]))["connection_id"] is None
