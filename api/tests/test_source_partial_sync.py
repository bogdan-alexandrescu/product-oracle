"""#249: a sync that stopped part way (a rate limit) says when it last stored something.

``partly_synced_at`` is set when a sync that has not finished commits a checkpoint and
cleared when a sync finishes; ``last_synced_at`` stays the last finished sync. A sync that
stopped before its first checkpoint stored nothing: the source still reads never synced.
"""

import pytest

from oracle.sources import base, service
from oracle.sources.base import ConnectorRateLimited
from tests.sources_helpers import FakeConnector, client_for, make_connection, make_user, message


@pytest.fixture
def slack(monkeypatch):
    service.load_connectors()
    fake = FakeConnector(kind="slack")
    monkeypatch.setitem(base._registry, "slack", fake)
    return fake


@pytest.fixture
async def a(tenant_id):
    alice = await make_user(tenant_id, "alice@example.com")
    async with client_for(alice) as c:
        c.user = alice
        yield c


async def _source(a, tenant_id):
    conn = await make_connection(tenant_id, a.user, "slack")
    resp = await a.post(
        "/v1/sources",
        json={
            "kind": "slack",
            "name": "Team chat",
            "connection_id": str(conn),
            "config": {"channels": ["C1"]},
        },
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _sync(a, source_id):
    resp = await a.post(f"/v1/sources/{source_id}/sync")
    assert resp.status_code == 200, resp.text
    return resp.json()


async def test_a_new_source_was_never_synced(a, tenant_id, slack):
    src = await _source(a, tenant_id)
    assert src["last_synced_at"] is None and src["partly_synced_at"] is None


async def test_a_rate_limit_after_a_checkpoint_reads_partly_synced(a, tenant_id, slack):
    src = await _source(a, tenant_id)
    slack.pages = [[message("m1", "one")], [message("m2", "two")], [message("m3", "three")]]
    slack.fail = {1: ConnectorRateLimited(retry_after=30)}

    result = await _sync(a, src["id"])

    assert result["outcome"] == "rate_limited"
    source = result["source"]
    assert source["item_count"] == 1
    assert source["last_synced_at"] is None
    assert source["partly_synced_at"] is not None
    listed = (await a.get("/v1/sources")).json()
    assert [s["partly_synced_at"] for s in listed] == [source["partly_synced_at"]]

    # The next sync finishes: a full sync, no longer partial.
    slack.fail = {}
    done = (await _sync(a, src["id"]))["source"]
    assert done["last_synced_at"] is not None and done["partly_synced_at"] is None


async def test_a_rate_limit_before_any_checkpoint_stores_nothing(a, tenant_id, slack):
    src = await _source(a, tenant_id)
    slack.pages = [[message("m1", "one")], [message("m2", "two")]]
    slack.fail = {0: ConnectorRateLimited()}

    source = (await _sync(a, src["id"]))["source"]

    assert source["item_count"] == 0
    assert source["last_synced_at"] is None and source["partly_synced_at"] is None


async def test_a_partial_sync_after_a_finished_one_keeps_both_times(a, tenant_id, slack):
    src = await _source(a, tenant_id)
    slack.pages = [[message("m1", "one")]]
    first = (await _sync(a, src["id"]))["source"]
    assert first["partly_synced_at"] is None

    # More arrived; the next run stops after its first checkpoint.
    slack.pages = [[message("m1", "one")], [message("m2", "two")], [message("m3", "three")]]
    slack.fail = {2: ConnectorRateLimited()}
    source = (await _sync(a, src["id"]))["source"]

    assert source["last_synced_at"] == first["last_synced_at"]
    assert source["partly_synced_at"] is not None
    assert source["partly_synced_at"] > first["last_synced_at"]
