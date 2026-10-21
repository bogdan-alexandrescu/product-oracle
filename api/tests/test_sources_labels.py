"""Named picks (A4): a Slack or Notion source stores the display names of its picks
under ``labels``, as Fireflies does. Names only name things: a save that changes them
alone makes no provider call, sweeps nothing, keeps the cursor and the "not read" list,
and does not stop a running sync. It still bumps ``config_version`` and is refused when
stale (S5, owner 2026-10-20).

Cards (issue #143, Testing plan):
- unit: protects=names never change what is read; fails_when=a label alters scope or the
  fingerprint of an unlabelled config; no_claim=provider behaviour.
- API: protects=a rename is free and safe; fails_when=it calls the provider, clears
  not-read items or supersedes a sync; no_claim=the real Slack or Notion APIs (fakes
  stand in).
"""

import hashlib
import json
import uuid

import httpx
import pytest
from sqlalchemy import update

from oracle.connections.models import Connection
from oracle.sources import base, fireflies_browse, service
from oracle.sources.base import SCOPE_KEY
from oracle.sources.connectors import fireflies as fireflies_module
from oracle.sources.connectors.fireflies import FirefliesConnector
from oracle.sources.connectors.notion import NotionConnector
from oracle.sources.connectors.slack import MAX_CHANNELS, SlackConnector
from oracle.sources.models import Source
from oracle.sources.sync import fingerprint
from oracle.tenancy import tenant_session
from tests.connection_helpers import clear_provider_http, use_provider_http
from tests.connectors.test_notion import CHILD, DB, FakeNotion, full_routes
from tests.fireflies_fake import API_KEY, SAMPLE, STANDUP_CAL, FakeFireflies
from tests.slack_world import SlackWorld
from tests.sources_helpers import client_for, make_connection, make_user, patch_source

BOTH = ["C0PRODUCT", "C0ROADMAP"]
NAMES = {"C0PRODUCT": "#product", "C0ROADMAP": "#roadmap"}
STALE = {
    "code": "source_changed",
    "message": "This source changed since you opened it. Reload to see the current picks.",
}
UNAVAILABLE = [{"external_id": "C0ROADMAP:1", "reason": "No access: removed"}]


# --- Unit: selection, fingerprint, connector rules --------------------------------------


def test_selection_is_the_config_without_labels():
    config = {"channels": BOTH, "since": "2025-10-01", "labels": NAMES}
    assert base.selection(config) == {"channels": BOTH, "since": "2025-10-01"}
    assert base.selection({"channels": BOTH}) == {"channels": BOTH}


def test_an_unlabelled_fingerprint_is_unchanged_and_labels_do_not_count():
    """The hash below was recorded from ``sync.fingerprint`` at d4a8529 (before labels
    were left out): no existing source re-scopes after deploy."""
    conn = uuid.UUID("50000000-0000-4000-8000-000000000001")
    config = {"channels": BOTH, "since": "2025-10-01"}
    recorded = "7a1e3f074d7853ab08c4feaa154ddc8a1f81ca16227520d254f418ca06e51bdf"
    assert fingerprint(config, conn, "T0EXAMPLE") == recorded
    assert fingerprint({**config, "labels": NAMES}, conn, "T0EXAMPLE") == recorded


def test_slack_labels_must_map_ids_to_names_and_are_capped():
    slack = SlackConnector()
    slack.check_config({"channels": BOTH, "labels": NAMES})
    with pytest.raises(base.ConnectorConfigError, match="labels must map channel ids to names"):
        slack.check_config({"channels": BOTH, "labels": ["x"]})
    with pytest.raises(base.ConnectorConfigError, match="labels must map channel ids to names"):
        slack.check_config({"channels": BOTH, "labels": {"C0PRODUCT": 7}})
    many = {f"C0{i:04d}": f"#c{i}" for i in range(MAX_CHANNELS + 1)}
    with pytest.raises(base.ConnectorConfigError):
        slack.check_config({"channels": BOTH, "labels": many})


def test_slack_normalize_drops_unpicked_labels_and_trims_names():
    got = SlackConnector().normalize_config(
        {"channels": [" C0PRODUCT "], "labels": {"C0PRODUCT": "#" + "p" * 299, "C0GONE": "#gone"}}
    )
    assert got == {"channels": ["C0PRODUCT"], "labels": {"C0PRODUCT": "#" + "p" * 199}}


def test_notion_labels_must_map_page_ids_to_titles_and_are_capped():
    notion = NotionConnector()
    notion.check_config({"roots": [CHILD], "labels": {CHILD: "Product specs"}})
    with pytest.raises(base.ConnectorConfigError, match="labels must map page ids to titles"):
        notion.check_config({"roots": [CHILD], "labels": ["x"]})
    many = {f"{i:08d}-0000-4000-8000-000000000000": "A page" for i in range(201)}
    with pytest.raises(base.ConnectorConfigError):
        notion.check_config({"roots": [CHILD], "labels": many})
    with pytest.raises(base.ConnectorConfigError, match="roots"):
        notion.check_config({"pages": [CHILD]})


def test_notion_normalize_drops_unpicked_labels_and_trims_titles():
    got = NotionConnector().normalize_config(
        {"roots": [CHILD], "labels": {CHILD: "T" * 300, DB: "Gone"}, "other": 1}
    )
    assert got == {"roots": [CHILD], "labels": {CHILD: "T" * 200}, "other": 1}


# --- API: Slack ------------------------------------------------------------------------


@pytest.fixture
def slack(monkeypatch):
    world = SlackWorld()
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


async def _add(a, tenant_id, alice, kind: str, config: dict) -> dict:
    credential = {"access_token": "ntn_example"} if kind == "notion" else None
    conn = await make_connection(tenant_id, alice, kind, credential=credential)
    resp = await a.post(
        "/v1/sources",
        json={"kind": kind, "name": f"My {kind}", "connection_id": str(conn), "config": config},
    )
    assert resp.status_code == 201, resp.text
    sync = (await a.post(f"/v1/sources/{resp.json()['id']}/sync")).json()
    assert sync["outcome"] == "completed", sync
    return resp.json()


async def _row(tenant_id, sid) -> Source:
    async with tenant_session(tenant_id) as s:
        return await s.get(Source, uuid.UUID(sid))


async def _mark_unavailable(tenant_id, sid) -> None:
    async with tenant_session(tenant_id) as s:
        await s.execute(
            update(Source).where(Source.id == uuid.UUID(sid)).values(unavailable_items=UNAVAILABLE)
        )
        await s.commit()


async def test_a_labels_only_save_is_stored_without_calling_slack(a, tenant_id, alice, slack):
    source = await _add(a, tenant_id, alice, "slack", {"channels": BOTH})
    await _mark_unavailable(tenant_id, source["id"])
    before_row = await _row(tenant_id, source["id"])
    before = (await a.get(f"/v1/sources/{source['id']}")).json()
    slack.calls.clear()

    resp = await patch_source(
        a,
        source["id"],
        {"config": {"channels": BOTH, "labels": NAMES}, "base_version": before["config_version"]},
    )

    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["config"] == {"channels": BOTH, "labels": NAMES}
    assert out["config_version"] == before["config_version"] + 1
    assert out["item_count"] == before["item_count"] == 4
    assert out["status"] == before["status"] == "active"
    assert out["unavailable_items"] == before["unavailable_items"]
    assert len(out["unavailable_items"]) == 1
    after_row = await _row(tenant_id, source["id"])
    assert after_row.cursor == before_row.cursor
    assert slack.calls == []


async def test_a_stale_labels_only_save_is_refused_and_changes_nothing(a, tenant_id, alice, slack):
    source = await _add(a, tenant_id, alice, "slack", {"channels": BOTH})
    first = await patch_source(a, source["id"], {"name": "Renamed"})
    assert first.status_code == 200, first.text
    slack.calls.clear()

    stale = await a.patch(
        f"/v1/sources/{source['id']}",
        json={"config": {"channels": BOTH, "labels": NAMES}, "base_version": 1},
    )

    assert stale.status_code == 409, stale.text
    assert stale.json() == STALE
    after = (await a.get(f"/v1/sources/{source['id']}")).json()
    assert after["config"] == {"channels": BOTH}
    assert after["config_version"] == 2
    assert slack.calls == []


async def test_slack_labels_are_normalised_and_checked_on_save(a, tenant_id, alice, slack):
    source = await _add(a, tenant_id, alice, "slack", {"channels": BOTH})

    resp = await patch_source(
        a,
        source["id"],
        {"config": {"channels": BOTH, "labels": {"C0PRODUCT": "#" + "x" * 299, "C0GONE": "#x"}}},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["config"]["labels"] == {"C0PRODUCT": "#" + "x" * 199}

    bad = await patch_source(a, source["id"], {"config": {"channels": BOTH, "labels": ["x"]}})
    assert bad.status_code == 422, bad.text
    assert "labels must map channel ids to names" in bad.text

    many = {f"C0{i:04d}": f"#c{i}" for i in range(MAX_CHANNELS + 1)}
    over = await patch_source(a, source["id"], {"config": {"channels": BOTH, "labels": many}})
    assert over.status_code == 422, over.text

    after = (await a.get(f"/v1/sources/{source['id']}")).json()
    assert after["config"]["labels"] == {"C0PRODUCT": "#" + "x" * 199}


async def test_a_new_slack_source_with_bad_labels_is_a_422(a, tenant_id, alice, slack):
    conn = await make_connection(tenant_id, alice, "slack")
    slack.calls.clear()
    resp = await a.post(
        "/v1/sources",
        json={
            "kind": "slack",
            "name": "Chat",
            "connection_id": str(conn),
            "config": {"channels": BOTH, "labels": ["x"]},
        },
    )
    assert resp.status_code == 422, resp.text
    assert "labels must map channel ids to names" in resp.text
    assert slack.calls == []


# --- API: Notion -----------------------------------------------------------------------


@pytest.fixture
def notion(monkeypatch):
    service.load_connectors()
    fake = FakeNotion(full_routes())
    monkeypatch.setitem(base._registry, "notion", fake.connector())
    return fake


async def test_notion_labels_follow_the_same_rules(a, tenant_id, alice, notion):
    source = await _add(a, tenant_id, alice, "notion", {"roots": [CHILD, DB]})
    await _mark_unavailable(tenant_id, source["id"])
    before = (await a.get(f"/v1/sources/{source['id']}")).json()
    before_row = await _row(tenant_id, source["id"])
    notion.requests.clear()

    titles = {CHILD: "Product specs", DB: "R" * 300, "77777777-7777-4777-8777-777777777777": "x"}
    resp = await patch_source(a, source["id"], {"config": {"roots": [CHILD, DB], "labels": titles}})

    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["config"] == {
        "roots": [CHILD, DB],
        "labels": {CHILD: "Product specs", DB: "R" * 200},
    }
    assert out["config_version"] == before["config_version"] + 1
    assert out["item_count"] == before["item_count"]
    assert out["unavailable_items"] == before["unavailable_items"]
    assert [u["external_id"] for u in out["unavailable_items"]] == ["C0ROADMAP:1"]
    assert out["status"] == before["status"]
    assert (await _row(tenant_id, source["id"])).cursor == before_row.cursor
    assert notion.requests == []

    stale = await a.patch(
        f"/v1/sources/{source['id']}",
        json={"config": {"roots": [CHILD, DB], "labels": {}}, "base_version": 1},
    )
    assert stale.status_code == 409, stale.text

    bad = await patch_source(a, source["id"], {"config": {"roots": [CHILD, DB], "labels": ["x"]}})
    assert bad.status_code == 422, bad.text
    assert "labels must map page ids to titles" in bad.text

    many = {f"{i:08d}-0000-4000-8000-000000000000": "A page" for i in range(201)}
    over = await patch_source(a, source["id"], {"config": {"roots": [CHILD, DB], "labels": many}})
    assert over.status_code == 422, over.text
    assert notion.requests == []


# --- Fireflies: labels saved before this change -----------------------------------------


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


def _fingerprint_before(config, connection_id, account_id) -> str:
    """``sync.fingerprint`` as it was at d4a8529: the whole config, labels included."""
    raw = json.dumps(
        {
            "config": config,
            "connection": str(connection_id) if connection_id else None,
            "account": account_id,
        },
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
    return hashlib.sha256(raw.encode()).hexdigest()


async def test_a_fireflies_source_labelled_before_keeps_its_position(
    a, tenant_id, alice, fake, ff_connector
):
    standup = f"cal:{STANDUP_CAL}"
    config = {"mode": "selected", "series": [standup], "labels": {standup: "Daily standup"}}
    conn = await make_connection(
        tenant_id, alice, "fireflies", credential={"access_token": API_KEY}
    )
    source = await _add_with(a, conn, "fireflies", config)
    row = await _row(tenant_id, source["id"])
    async with tenant_session(tenant_id) as s:
        account = (await s.get(Connection, row.connection_id)).account_id
    normal = service.normalize_config("fireflies", row.config)
    # As the engine before this change stamped it: the whole config, labels included.
    old_stamp = _fingerprint_before(normal, row.connection_id, account)
    new_stamp = fingerprint(normal, row.connection_id, account)
    assert old_stamp != new_stamp
    async with tenant_session(tenant_id) as s:
        await s.execute(
            update(Source)
            .where(Source.id == row.id)
            .values(cursor={**row.cursor, SCOPE_KEY: old_stamp})
        )
        await s.commit()
    position = {k: v for k, v in row.cursor.items() if k != SCOPE_KEY}
    assert position.get("selection") == fireflies_module.fingerprint(config)
    fake.requests.clear()

    sync = (await a.post(f"/v1/sources/{source['id']}/sync")).json()

    assert sync["outcome"] == "completed", sync
    assert fake.detail_ids() == []
    after = (await _row(tenant_id, source["id"])).cursor
    assert after[SCOPE_KEY] == new_stamp


async def _add_with(a, conn, kind: str, config: dict) -> dict:
    resp = await a.post(
        "/v1/sources",
        json={"kind": kind, "name": f"My {kind}", "connection_id": str(conn), "config": config},
    )
    assert resp.status_code == 201, resp.text
    sync = (await a.post(f"/v1/sources/{resp.json()['id']}/sync")).json()
    assert sync["outcome"] == "completed", sync
    return resp.json()
