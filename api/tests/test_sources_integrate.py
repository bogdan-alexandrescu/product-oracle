"""The one sync engine of the Slack, GitHub and Fireflies pickers (the #105 + #108
integration): what a selection change keeps of a Slack cursor, an edit racing a sync,
a private channel the person left, a bot-token connection, a pause during a sync and a
refused request.

The real Slack connector runs against tests/slack_world.py (httpx.MockTransport).
"""

import uuid

import httpx
import pytest
from sqlalchemy import select

from oracle.connections.models import Connection
from oracle.sources import base, service
from oracle.sources.connectors.slack import SlackConnector
from oracle.sources.models import Source, SourceItem
from oracle.tenancy import tenant_session
from tests.slack_world import SlackWorld, ts
from tests.sources_helpers import client_for, make_connection, make_user

BOTH = ["C0PRODUCT", "C0ROADMAP"]
PRICING = f"C0PRODUCT:{ts('2025-10-05')}"


class World(SlackWorld):
    """SlackWorld that can answer as a bot token, or refuse a method with a 403."""

    def __init__(self):
        super().__init__()
        self.bot = False
        self.forbidden: set[str] = set()

    def __call__(self, request: httpx.Request) -> httpx.Response:
        method = request.url.path.rsplit("/", 1)[-1]
        if method in self.forbidden:
            return httpx.Response(403, json={"ok": False})
        if method == "auth.test" and self.bot:
            self.calls.append((method, {}))
            return self.ok(url="https://example.slack.com/", bot_id="B0BOT")
        return super().__call__(request)


@pytest.fixture
def slack(monkeypatch):
    world = World()
    client = httpx.AsyncClient(transport=httpx.MockTransport(world))
    monkeypatch.setitem(base._registry, "slack", SlackConnector(client))
    return world


@pytest.fixture
async def alice(tenant_id):
    return await make_user(tenant_id, "alice@example.com")


@pytest.fixture
async def a(alice):
    async with client_for(alice) as c:
        yield c


async def add(a, tenant_id, alice, config: dict) -> dict:
    conn = await make_connection(tenant_id, alice, "slack")
    resp = await a.post(
        "/v1/sources",
        json={"kind": "slack", "name": "Chat", "connection_id": str(conn), "config": config},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


async def sync(a, source: dict, outcome: str = "completed") -> dict:
    resp = await a.post(f"/v1/sources/{source['id']}/sync")
    assert resp.status_code == 200, resp.text
    assert resp.json()["outcome"] == outcome, resp.json()
    return resp.json()


async def patch(a, source: dict, body: dict) -> dict:
    resp = await a.patch(f"/v1/sources/{source['id']}", json=body)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def items(tenant_id, source: dict) -> dict[str, bool]:
    """external id -> live (not deleted)."""
    async with tenant_session(tenant_id) as s:
        rows = await s.execute(
            select(SourceItem.external_id, SourceItem.deleted_at).where(
                SourceItem.source_id == uuid.UUID(source["id"])
            )
        )
        return {e: d is None for e, d in rows.all()}


async def cursor_of(tenant_id, source: dict) -> dict | None:
    async with tenant_session(tenant_id) as s:
        return (await s.get(Source, uuid.UUID(source["id"]))).cursor


async def set_cursor(tenant_id, source: dict, cursor: dict | None) -> None:
    async with tenant_session(tenant_id) as s:
        row = await s.get(Source, uuid.UUID(source["id"]))
        row.cursor = cursor
        await s.commit()


def drop_pricing(slack: World) -> None:
    slack.channels["C0PRODUCT"] = [
        m for m in slack.channels["C0PRODUCT"] if m["ts"] != ts("2025-10-05")
    ]


# --- A selection change keeps what Slack deletes are compared against (#105 M) -------


async def test_a_message_deleted_upstream_is_deleted_after_a_channel_is_added(
    a, tenant_id, alice, slack
):
    source = await add(a, tenant_id, alice, {"channels": ["C0PRODUCT"]})
    await sync(a, source)
    assert (await items(tenant_id, source))[PRICING] is True

    drop_pricing(slack)
    await patch(a, source, {"config": {"channels": BOTH}})
    result = await sync(a, source)
    stored = await items(tenant_id, source)
    assert stored[PRICING] is False
    assert stored[f"C0ROADMAP:{ts('2025-10-03')}"] is True
    assert result["deleted"] == 1


async def test_a_message_deleted_upstream_is_deleted_under_a_legacy_cursor(
    a, tenant_id, alice, slack
):
    """A cursor saved before the engine stamped its fingerprint (and before ranges were
    kept): the first sync after deploy rescopes it, and must still compare deletes."""
    source = await add(a, tenant_id, alice, {"channels": ["C0PRODUCT"]})
    await sync(a, source)
    legacy = await cursor_of(tenant_id, source)
    legacy.pop(base.SCOPE_KEY)
    legacy.pop("range")
    for entry in legacy["channels"].values():
        entry.pop("name", None)
    await set_cursor(tenant_id, source, legacy)

    drop_pricing(slack)
    await sync(a, source)
    assert (await items(tenant_id, source))[PRICING] is False
    # The refetch ran to the end of the window: the flag is cleared.
    saved = await cursor_of(tenant_id, source)
    assert "refetch" not in saved["channels"]["C0PRODUCT"]
    assert saved["range"] == {}


async def test_a_new_range_refetches_and_still_compares_deletes(a, tenant_id, alice, slack):
    source = await add(a, tenant_id, alice, {"channels": ["C0PRODUCT"]})
    await sync(a, source)
    drop_pricing(slack)
    await patch(a, source, {"config": {"channels": ["C0PRODUCT"], "since": "2025-09-01"}})
    await sync(a, source)
    stored = await items(tenant_id, source)
    assert stored[PRICING] is False
    assert stored[f"C0PRODUCT:{ts('2025-10-01')}"] is True
    assert "refetch" not in (await cursor_of(tenant_id, source))["channels"]["C0PRODUCT"]


async def test_a_reordered_allowlist_is_the_same_selection(a, tenant_id, alice, slack):
    source = await add(a, tenant_id, alice, {"channels": [" C0ROADMAP", "C0PRODUCT", "C0PRODUCT"]})
    assert source["config"]["channels"] == BOTH
    await sync(a, source)
    before = await cursor_of(tenant_id, source)
    await patch(a, source, {"config": {"channels": ["C0ROADMAP", "C0PRODUCT"]}})
    assert await cursor_of(tenant_id, source) == before


# --- An edit racing a sync (#108 M) --------------------------------------------------


async def test_a_reconnect_resets_a_cursor_a_sync_saved_after_the_request_loaded_it(
    tenant_id, alice, slack
):
    first = await make_connection(tenant_id, alice, "slack")
    second = await make_connection(tenant_id, alice, "slack")
    async with tenant_session(tenant_id) as s:
        row = Source(
            owner_user_id=alice.id,
            connection_id=first,
            kind="slack",
            name="Chat",
            config={"channels": ["C0PRODUCT"]},
            status="active",
        )
        s.add(row)
        await s.commit()
        source_id = row.id

    async with tenant_session(tenant_id) as request:
        loaded = await request.get(Source, source_id)
        assert loaded.cursor is None
        # Meanwhile a sync commits its cursor.
        async with tenant_session(tenant_id) as syncing:
            other = await syncing.get(Source, source_id)
            other.cursor = {"channels": {"C0PRODUCT": {"oldest": "1.0"}}}
            await syncing.commit()
        await service.update_source(request, loaded, {"connection_id": second})

    async with tenant_session(tenant_id) as s:
        saved = await s.get(Source, source_id)
        assert saved.connection_id == second
        assert saved.cursor is None


# --- Engineering defaults ------------------------------------------------------------


async def test_a_private_channel_left_needs_attention_and_the_rest_still_syncs(
    a, tenant_id, alice, slack
):
    slack.channels["G0SECRET"] = [{"ts": ts("2025-10-04"), "user": "U0ADA", "text": "secret"}]
    source = await add(a, tenant_id, alice, {"channels": ["C0PRODUCT", "G0SECRET"]})
    await sync(a, source)

    # Alice leaves the private channel; a new message arrives in the public one.
    del slack.channels["G0SECRET"]
    slack.channels["C0PRODUCT"].append({"ts": ts("2025-10-11"), "user": "U0ADA", "text": "new"})
    result = await sync(a, source, "needs_attention")
    assert "G0SECRET" in result["error"] and "#secret" in result["error"]
    assert result["source"]["status"] == "needs_attention"
    stored = await items(tenant_id, source)
    assert stored[f"C0PRODUCT:{ts('2025-10-11')}"] is True
    # Its items stay until she removes it from the allowlist.
    assert stored[f"G0SECRET:{ts('2025-10-04')}"] is True
    assert "G0SECRET" in (await cursor_of(tenant_id, source))["channels"]

    await patch(a, source, {"config": {"channels": ["C0PRODUCT"]}})
    await sync(a, source)
    assert (await items(tenant_id, source))[f"G0SECRET:{ts('2025-10-04')}"] is False


async def test_a_source_on_a_bot_token_connection_needs_attention_and_keeps_its_items(
    a, tenant_id, alice, slack
):
    source = await add(a, tenant_id, alice, {"channels": ["C0PRODUCT"]})
    await sync(a, source)
    slack.bot = True
    result = await sync(a, source, "needs_attention")
    assert result["error"].startswith("Reconnect with your own Slack account")
    assert result["source"]["status"] == "needs_attention"
    assert all((await items(tenant_id, source)).values())
    async with tenant_session(tenant_id) as s:
        conn = await s.get(Connection, uuid.UUID(source["connection_id"]))
        assert conn.status == "active"


async def test_a_forbidden_request_fails_the_source_and_leaves_the_connection_active(
    a, tenant_id, alice, slack
):
    source = await add(a, tenant_id, alice, {"channels": ["C0PRODUCT"]})
    slack.forbidden.add("conversations.history")
    result = await sync(a, source, "error")
    assert result["error"].startswith("Access refused")
    async with tenant_session(tenant_id) as s:
        conn = await s.get(Connection, uuid.UUID(source["connection_id"]))
        assert conn.status == "active"


async def test_a_rejected_token_expires_the_connection_the_sync_used(
    a, tenant_id, alice, slack, monkeypatch
):
    source = await add(a, tenant_id, alice, {"channels": ["C0PRODUCT"]})
    other = await make_connection(tenant_id, alice, "slack")
    connector = base._registry["slack"]
    original = connector.sync

    async def racing(config, credential, cursor, **kw):
        # The source moves to another connection, then the old token is rejected.
        async with tenant_session(tenant_id) as s:
            row = await s.get(Source, uuid.UUID(source["id"]))
            row.connection_id = other
            await s.commit()
        raise base.ConnectorAuthError("token_revoked")
        yield  # pragma: no cover

    monkeypatch.setattr(connector, "sync", racing)
    result = await sync(a, source, "superseded")
    monkeypatch.setattr(connector, "sync", original)
    async with tenant_session(tenant_id) as s:
        used = await s.get(Connection, uuid.UUID(source["connection_id"]))
        assert used.status == "expired"
        assert (await s.get(Connection, other)).status == "active"
        row = await s.get(Source, uuid.UUID(source["id"]))
        # The error is the old selection's: not written on the edited source.
        assert row.status == "active" and row.last_error is None
    assert result["error"] is None


async def test_a_source_paused_while_it_syncs_stays_paused(a, tenant_id, alice, slack, monkeypatch):
    source = await add(a, tenant_id, alice, {"channels": ["C0PRODUCT"]})
    connector = base._registry["slack"]
    original = connector.sync

    async def pausing(config, credential, cursor, **kw):
        async for event in original(config, credential, cursor, **kw):
            yield event
        async with tenant_session(tenant_id) as s:
            row = await s.get(Source, uuid.UUID(source["id"]))
            row.status = "paused"
            await s.commit()

    monkeypatch.setattr(connector, "sync", pausing)
    result = await sync(a, source)
    assert result["source"]["status"] == "paused"
    assert len(await items(tenant_id, source)) == 3


# --- Narrowing takes effect on save (S5, owner 2026-10-20) ---------------------------


async def test_saving_a_narrower_allowlist_deletes_what_falls_outside_at_once(
    a, tenant_id, alice, slack
):
    source = await add(a, tenant_id, alice, {"channels": BOTH})
    await sync(a, source)
    roadmap = f"C0ROADMAP:{ts('2025-10-03')}"
    assert (await items(tenant_id, source))[roadmap] is True

    saved = await patch(a, source, {"config": {"channels": ["C0PRODUCT"], "since": "2025-10-04"}})
    # In the save itself, before any sync: the removed channel and the older message.
    stored = await items(tenant_id, source)
    assert stored[roadmap] is False
    assert stored[f"C0PRODUCT:{ts('2025-10-01')}"] is False
    assert stored[PRICING] is True
    assert saved["item_count"] == 2
    # Soft: the versions stay (frozen shares and audit read them).
    async with tenant_session(tenant_id) as s:
        row = await s.scalar(
            select(SourceItem).where(
                SourceItem.source_id == uuid.UUID(source["id"]), SourceItem.external_id == roadmap
            )
        )
        assert row.deleted_at is not None

    # The next sync only re-reads what remains.
    slack.calls.clear()
    result = await sync(a, source)
    assert result["deleted"] == 0
    assert not [p for m, p in slack.calls if p.get("channel") == "C0ROADMAP"]
    assert sum(live for live in (await items(tenant_id, source)).values()) == 2
