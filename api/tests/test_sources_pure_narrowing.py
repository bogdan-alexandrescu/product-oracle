"""A pure narrowing makes no provider call, and a stale save cannot undo one (S5,
owner 2026-10-20: "no provider call").

A save that only removes picks (or moves dates inward), with no new picks, no wider dates
and no connection change, sweeps without validating against the provider and without
needing an active connection: an expired connection, a provider outage or an archived
remaining root does not block it. A save that widens is still validated, also when it
comes from a stale request (an old tab re-sending the whole form after another save
narrowed the source): what changed is compared with the row as it is under the lock.
"""

import httpx
import pytest
from sqlalchemy import select, update

from oracle.connections.models import Connection
from oracle.sources import base, fireflies_browse, service
from oracle.sources.connectors.fireflies import FirefliesConnector
from oracle.sources.connectors.notion import NotionConnector
from oracle.sources.models import SourceItem
from oracle.tenancy import tenant_session
from tests.connection_helpers import (
    add_connection,
    clear_provider_http,
    make_person,
    use_provider_http,
)
from tests.connectors.test_notion import CHILD, DB, GRAND, ROW1, ROW2, FakeNotion, full_routes
from tests.fireflies_fake import API_KEY, PLANNING_CAL, SAMPLE, STANDUP_CAL, FakeFireflies
from tests.sources_helpers import patch_source

STANDUP = f"cal:{STANDUP_CAL}"
PLANNING = f"cal:{PLANNING_CAL}"
WIDE_FF = {"mode": "selected", "series": [STANDUP, PLANNING]}
NARROW_FF = {"mode": "selected", "series": [STANDUP]}


@pytest.fixture
async def alice(tenant_id):
    return await make_person(tenant_id, "alice@example.com", "owner")


async def _break_connection(tenant_id, conn_id) -> None:
    async with tenant_session(tenant_id) as s:
        await s.execute(update(Connection).where(Connection.id == conn_id).values(status="expired"))
        await s.commit()


async def _live(tenant_id, source_id) -> dict[str, bool]:
    async with tenant_session(tenant_id) as s:
        rows = await s.scalars(select(SourceItem).where(SourceItem.source_id == source_id))
        return {i.external_id: i.deleted_at is None for i in rows}


async def _create(client, alice, kind, conn, config) -> str:
    resp = await client.post(
        "/v1/sources",
        headers=alice.headers,
        json={"kind": kind, "name": f"My {kind}", "connection_id": str(conn.id), "config": config},
    )
    assert resp.status_code == 201, resp.text
    sid = resp.json()["id"]
    sync = await client.post(f"/v1/sources/{sid}/sync", headers=alice.headers)
    assert sync.json()["outcome"] == "completed", sync.text
    return sid


async def _config(client, alice, sid) -> dict:
    return (await client.get(f"/v1/sources/{sid}", headers=alice.headers)).json()["config"]


# --- Fireflies ----------------------------------------------------------------------


@pytest.fixture
def fake():
    fake = FakeFireflies(list(SAMPLE))
    use_provider_http(fake)
    fireflies_browse.reset_limits()
    yield fake
    clear_provider_http()
    fireflies_browse.reset_limits()


@pytest.fixture
def ff_connector(fake, monkeypatch):
    service.load_connectors()
    real = FirefliesConnector(httpx.AsyncClient(transport=httpx.MockTransport(fake)))
    monkeypatch.setitem(base._registry, "fireflies", real)
    return real


@pytest.fixture
async def ff_conn(tenant_id, alice):
    return await add_connection(
        tenant_id, alice.id, "fireflies", bundle={"access_token": API_KEY}, label="Fireflies"
    )


async def test_fireflies_narrowing_with_an_expired_connection_saves_and_sweeps(
    client, tenant_id, alice, fake, ff_connector, ff_conn
):
    sid = await _create(client, alice, "fireflies", ff_conn, WIDE_FF)
    assert (await _live(tenant_id, sid))["P1"] is True
    await _break_connection(tenant_id, ff_conn.id)
    fake.requests.clear()

    resp = await patch_source(client, sid, {"config": NARROW_FF}, headers=alice.headers)
    assert resp.status_code == 200, resp.text
    assert fake.requests == []
    live = await _live(tenant_id, sid)
    assert live["P1"] is False and live["P2"] is False
    assert live["S1"] is True


async def test_fireflies_narrowing_during_a_provider_outage_saves_and_sweeps(
    client, tenant_id, alice, fake, ff_connector, ff_conn
):
    sid = await _create(client, alice, "fireflies", ff_conn, WIDE_FF)
    fake.error = httpx.Response(503, text="Service Unavailable")
    fake.requests.clear()

    resp = await patch_source(client, sid, {"config": NARROW_FF}, headers=alice.headers)
    assert resp.status_code == 200, resp.text
    assert fake.requests == []
    live = await _live(tenant_id, sid)
    assert live["P1"] is False and live["P2"] is False and live["S1"] is True


async def test_fireflies_widening_still_needs_a_working_connection(
    client, tenant_id, alice, fake, ff_connector, ff_conn
):
    sid = await _create(client, alice, "fireflies", ff_conn, NARROW_FF)
    await _break_connection(tenant_id, ff_conn.id)
    resp = await patch_source(client, sid, {"config": WIDE_FF}, headers=alice.headers)
    assert resp.status_code >= 400
    assert await _config(client, alice, sid) == NARROW_FF


async def test_fireflies_a_stale_rename_with_the_old_wide_config_is_validated(
    client, tenant_id, alice, fake, ff_connector, ff_conn
):
    """One request narrows; an old tab then re-sends the whole form (the old, wide
    config) with a new name. It widens, so it is validated like any widening: with the
    connection gone it is refused and the narrowing stands."""
    sid = await _create(client, alice, "fireflies", ff_conn, WIDE_FF)
    saved = await patch_source(client, sid, {"config": NARROW_FF}, headers=alice.headers)
    assert saved.status_code == 200, saved.text
    await _break_connection(tenant_id, ff_conn.id)

    stale = await patch_source(
        client, sid, {"name": "Renamed", "config": WIDE_FF}, headers=alice.headers
    )
    assert stale.status_code >= 400, stale.text
    assert await _config(client, alice, sid) == NARROW_FF
    live = await _live(tenant_id, sid)
    assert live["P1"] is False and live["P2"] is False


# --- Notion -------------------------------------------------------------------------


@pytest.fixture
def notion_fake(monkeypatch):
    service.load_connectors()
    fake = FakeNotion(full_routes())
    monkeypatch.setitem(base._registry, "notion", fake.connector())
    return fake


@pytest.fixture
async def notion_conn(tenant_id, alice):
    return await add_connection(
        tenant_id, alice.id, "notion", bundle={"access_token": "ntn_example"}, label="Notion"
    )


async def test_notion_narrowing_with_an_expired_connection_saves_and_sweeps(
    client, tenant_id, alice, notion_fake, notion_conn
):
    sid = await _create(client, alice, "notion", notion_conn, {"roots": [CHILD, DB]})
    await _break_connection(tenant_id, notion_conn.id)
    notion_fake.requests.clear()

    resp = await patch_source(client, sid, {"config": {"roots": [CHILD]}}, headers=alice.headers)
    assert resp.status_code == 200, resp.text
    assert notion_fake.requests == []
    live = await _live(tenant_id, sid)
    assert live == {CHILD: True, GRAND: True, ROW1: False, ROW2: False}


async def test_notion_narrowing_during_a_provider_outage_saves_and_sweeps(
    client, tenant_id, alice, notion_fake, notion_conn, monkeypatch
):
    sid = await _create(client, alice, "notion", notion_conn, {"roots": [CHILD, DB]})
    down = httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(503)))
    monkeypatch.setitem(base._registry, "notion", NotionConnector(client=down))
    notion_fake.requests.clear()

    resp = await patch_source(client, sid, {"config": {"roots": [CHILD]}}, headers=alice.headers)
    assert resp.status_code == 200, resp.text
    assert await _live(tenant_id, sid) == {CHILD: True, GRAND: True, ROW1: False, ROW2: False}


async def test_notion_adding_a_root_still_needs_a_working_connection(
    client, tenant_id, alice, notion_fake, notion_conn
):
    sid = await _create(client, alice, "notion", notion_conn, {"roots": [CHILD]})
    await _break_connection(tenant_id, notion_conn.id)
    resp = await patch_source(
        client, sid, {"config": {"roots": [CHILD, DB]}}, headers=alice.headers
    )
    assert resp.status_code >= 400
    assert await _config(client, alice, sid) == {"roots": [CHILD]}


async def test_notion_a_stale_rename_with_the_old_wide_config_is_validated(
    client, tenant_id, alice, notion_fake, notion_conn
):
    sid = await _create(client, alice, "notion", notion_conn, {"roots": [CHILD, DB]})
    saved = await patch_source(client, sid, {"config": {"roots": [CHILD]}}, headers=alice.headers)
    assert saved.status_code == 200, saved.text
    wide = {"name": "Renamed", "config": {"roots": [CHILD, DB]}}

    # Healthy connection: the widening is validated against Notion (the user's call).
    notion_fake.requests.clear()
    ok = await patch_source(client, sid, wide, headers=alice.headers)
    assert ok.status_code == 200, ok.text
    assert "GET /users/me" in notion_fake.requests

    # Narrow again, lose the connection, then the stale form arrives: refused.
    again = await patch_source(client, sid, {"config": {"roots": [CHILD]}}, headers=alice.headers)
    assert again.status_code == 200, again.text
    await _break_connection(tenant_id, notion_conn.id)
    stale = await patch_source(client, sid, wide, headers=alice.headers)
    assert stale.status_code >= 400, stale.text
    assert await _config(client, alice, sid) == {"roots": [CHILD]}
    live = await _live(tenant_id, sid)
    assert live[ROW1] is False and live[ROW2] is False


# --- The lost update: a request that read the row before another save ----------------


async def test_a_save_that_loaded_the_row_before_a_narrowing_is_validated_as_a_widening(
    tenant_id, alice, notion_fake, notion_conn
):
    """Two requests overlap: the second loaded the wide row, the first narrowed it and
    committed, then the second re-sends the old wide config (a rename from an old tab).
    Against the row it loaded the config is 'unchanged', so nothing was validated and the
    narrowing was undone; against the row under the lock it widens and is validated."""
    async with tenant_session(tenant_id) as first, tenant_session(tenant_id) as second:
        created = await service.create_source(
            first,
            alice.id,
            kind="notion",
            name="Handbook",
            connection_id=notion_conn.id,
            config={"roots": [CHILD, DB]},
        )
        stale = await service.get_source(second, alice.id, created.id)
        await service.update_source(first, created, {"config": {"roots": [CHILD]}})
        await _break_connection(tenant_id, notion_conn.id)

        with pytest.raises(service.InvalidError):
            await service.update_source(
                second, stale, {"name": "Renamed", "config": {"roots": [CHILD, DB]}}
            )
        await second.rollback()
    async with tenant_session(tenant_id) as check:
        row = await service.get_source(check, alice.id, created.id)
        assert row.config == {"roots": [CHILD]}
        assert row.name == "Handbook"


async def test_a_save_that_loaded_the_row_before_a_reconnect_is_validated_as_a_reconnect(
    tenant_id, alice, notion_fake, notion_conn
):
    other = await add_connection(
        tenant_id, alice.id, "notion", bundle={"access_token": "ntn_example"}, account_id="2"
    )
    async with tenant_session(tenant_id) as first, tenant_session(tenant_id) as second:
        created = await service.create_source(
            first,
            alice.id,
            kind="notion",
            name="Handbook",
            connection_id=notion_conn.id,
            config={"roots": [CHILD]},
        )
        stale = await service.get_source(second, alice.id, created.id)
        await service.update_source(first, created, {"connection_id": other.id})
        # The first connection is back in the old tab's form, but it has expired.
        await _break_connection(tenant_id, notion_conn.id)
        with pytest.raises(service.InvalidError):
            await service.update_source(
                second, stale, {"name": "Renamed", "connection_id": notion_conn.id}
            )
        await second.rollback()
    async with tenant_session(tenant_id) as check:
        row = await service.get_source(check, alice.id, created.id)
        assert row.connection_id == other.id


# --- A stale save is refused (config_version, owner 2026-10-20) -----------------------

STALE = {
    "code": "source_changed",
    "message": "This source changed since you opened it. Reload to see the current picks.",
}


async def _get(client, alice, sid) -> dict:
    return (await client.get(f"/v1/sources/{sid}", headers=alice.headers)).json()


async def test_a_stale_save_with_an_old_base_version_is_refused_and_changes_nothing(
    client, tenant_id, alice, fake, ff_connector, ff_conn
):
    sid = await _create(client, alice, "fireflies", ff_conn, WIDE_FF)
    opened = (await _get(client, alice, sid))["config_version"]
    assert opened == 1
    narrowed = await patch_source(
        client, sid, {"config": NARROW_FF, "base_version": opened}, headers=alice.headers
    )
    assert narrowed.status_code == 200, narrowed.text
    assert narrowed.json()["config_version"] == opened + 1

    stale = await patch_source(
        client,
        sid,
        {"name": "Renamed", "config": WIDE_FF, "base_version": opened},
        headers=alice.headers,
    )
    assert stale.status_code == 409, stale.text
    assert stale.json() == STALE
    after = await _get(client, alice, sid)
    assert after["config"] == NARROW_FF
    assert after["name"] == "My fireflies"
    assert after["config_version"] == opened + 1
    live = await _live(tenant_id, sid)
    assert live["P1"] is False and live["P2"] is False


async def test_a_save_with_the_matching_base_version_is_applied(
    client, tenant_id, alice, fake, ff_connector, ff_conn
):
    sid = await _create(client, alice, "fireflies", ff_conn, WIDE_FF)
    version = (await _get(client, alice, sid))["config_version"]
    renamed = await patch_source(
        client, sid, {"name": "Renamed", "base_version": version}, headers=alice.headers
    )
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["name"] == "Renamed"
    assert renamed.json()["config_version"] == version + 1


REQUIRED = {
    "code": "base_version_required",
    "message": "Say which version of the source you read (base_version); get it from the source.",
}


async def test_a_config_change_without_a_base_version_is_refused(
    client, tenant_id, alice, fake, ff_connector, ff_conn
):
    """Owner 2026-10-20: base_version is required wherever config or connection change."""
    sid = await _create(client, alice, "fireflies", ff_conn, WIDE_FF)
    before = await _get(client, alice, sid)
    for body in (
        {"config": NARROW_FF},
        {"name": "Renamed", "config": NARROW_FF},
        {"connection_id": str(ff_conn.id)},
    ):
        resp = await client.patch(f"/v1/sources/{sid}", headers=alice.headers, json=body)
        assert resp.status_code == 422, (body, resp.text)
        assert resp.json() == REQUIRED
    assert await _get(client, alice, sid) == before


async def test_a_rename_and_a_pause_need_no_base_version(
    client, tenant_id, alice, fake, ff_connector, ff_conn
):
    sid = await _create(client, alice, "fireflies", ff_conn, WIDE_FF)
    version = (await _get(client, alice, sid))["config_version"]
    renamed = await client.patch(
        f"/v1/sources/{sid}", headers=alice.headers, json={"name": "Renamed"}
    )
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["config_version"] == version + 1
    assert (await client.post(f"/v1/sources/{sid}/pause", headers=alice.headers)).status_code == 200
    assert (
        await client.post(f"/v1/sources/{sid}/resume", headers=alice.headers)
    ).status_code == 200


async def test_a_rename_with_a_stale_base_version_is_still_checked(
    client, tenant_id, alice, fake, ff_connector, ff_conn
):
    sid = await _create(client, alice, "fireflies", ff_conn, WIDE_FF)
    stale = await client.patch(
        f"/v1/sources/{sid}", headers=alice.headers, json={"name": "Renamed", "base_version": 99}
    )
    assert stale.status_code == 409, stale.text
    assert stale.json() == STALE
    assert (await _get(client, alice, sid))["name"] == "My fireflies"


async def test_a_rename_without_a_lock_adds_one_to_the_current_version(
    tenant_id, alice, notion_conn
):
    """The rename-only path takes no lock: it must bump the version the row has now, not
    the one read at request start (that would hand two versions the same number)."""
    async with tenant_session(tenant_id) as first, tenant_session(tenant_id) as second:
        created = await service.create_source(
            first,
            alice.id,
            kind="notion",
            name="Handbook",
            connection_id=notion_conn.id,
            config={"roots": [CHILD]},
        )
        stale = await service.get_source(second, alice.id, created.id)
        await service.update_source(first, created, {"name": "One"})
        await service.update_source(second, stale, {"name": "Two"})
    async with tenant_session(tenant_id) as check:
        row = await service.get_source(check, alice.id, created.id)
        assert row.name == "Two"
        assert row.config_version == 3


async def test_a_save_that_lands_during_validation_is_refused(
    tenant_id, alice, notion_fake, notion_conn, monkeypatch
):
    """The second base check: validating a widening reads the provider with the lock
    released, so another save can land meanwhile. It is checked again afterwards."""
    async with tenant_session(tenant_id) as first, tenant_session(tenant_id) as second:
        created = await service.create_source(
            first,
            alice.id,
            kind="notion",
            name="Handbook",
            connection_id=notion_conn.id,
            config={"roots": [CHILD]},
        )
        mine = await service.get_source(second, alice.id, created.id)
        real = service._validate

        async def validate_then_a_rival_saves(db, kind, config, conn):
            await real(db, kind, config, conn)
            await service.update_source(first, created, {"name": "Rival"})

        monkeypatch.setattr(service, "_validate", validate_then_a_rival_saves)
        with pytest.raises(service.StaleError):
            await service.update_source(
                second, mine, {"config": {"roots": [CHILD, DB]}, "base_version": 1}
            )
        await second.rollback()
    async with tenant_session(tenant_id) as check:
        row = await service.get_source(check, alice.id, created.id)
        assert row.config == {"roots": [CHILD]}
        assert row.name == "Rival"
        assert row.config_version == 2


async def test_a_save_that_changes_nothing_does_not_bump_the_version(
    client, tenant_id, alice, fake, ff_connector, ff_conn
):
    sid = await _create(client, alice, "fireflies", ff_conn, WIDE_FF)
    before = await _get(client, alice, sid)
    same = await client.patch(
        f"/v1/sources/{sid}",
        headers=alice.headers,
        json={
            "name": before["name"],
            "config": WIDE_FF,
            "connection_id": str(ff_conn.id),
            "base_version": before["config_version"],
        },
    )
    assert same.status_code == 200, same.text
    assert same.json()["config_version"] == before["config_version"]
    assert (await _get(client, alice, sid))["config_version"] == before["config_version"]


async def test_a_sync_and_a_pause_do_not_bump_the_config_version(
    client, tenant_id, alice, fake, ff_connector, ff_conn
):
    sid = await _create(client, alice, "fireflies", ff_conn, WIDE_FF)  # creates and syncs
    version = (await _get(client, alice, sid))["config_version"]
    again = await client.post(f"/v1/sources/{sid}/sync", headers=alice.headers)
    assert again.status_code == 200, again.text
    await client.post(f"/v1/sources/{sid}/pause", headers=alice.headers)
    await client.post(f"/v1/sources/{sid}/resume", headers=alice.headers)
    assert (await _get(client, alice, sid))["config_version"] == version
    # A form opened before the sync still saves.
    saved = await patch_source(
        client, sid, {"config": NARROW_FF, "base_version": version}, headers=alice.headers
    )
    assert saved.status_code == 200, saved.text
