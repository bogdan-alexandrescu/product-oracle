"""A run reads a shared item's score frozen at its pin on every baseline route (S6, owner
2026-10-20), not only the entity detail: graph, entities, edges, trace, priorities and a
blocker view all agree with the detail, so a run never learns a newer version exists.
People keep the live value. Synthetic placeholders only."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest

from oracle.baseline import scoring
from oracle.tenancy import tenant_session
from tests.baseline_helpers import cite, edge, entity, make_ctx, make_item
from tests.blocker_helpers import create_blocker
from tests.test_evidence_freshness import _changed_upstream, _rescore, _run_pinned_at

B = "/v1/baseline"


@pytest.fixture
async def ctx():
    return await make_ctx()


async def _get(client, url: str, headers: dict):
    resp = await client.get(url, headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _reads(client, ctx, feat, other, link, blocker, headers) -> dict:
    """The confidence of the same targets on every route, as ``headers`` read them."""
    graph = await _get(client, f"{B}/graph", headers)
    listed = await _get(client, f"{B}/entities", headers)
    edges = await _get(client, f"{B}/edges", headers)
    trace = await _get(client, f"{B}/trace", headers)
    ranking = await _get(client, "/v1/priorities", headers)
    strategy = await _get(client, f"/v1/blockers/{blocker['id']}", headers)
    detail = await _get(client, f"{B}/entities/{feat['id']}", headers)
    edge_detail = await _get(client, f"{B}/edges/{link['id']}", headers)

    def of(rows, id_):
        return next(r for r in rows if r["id"] == id_)

    ranked = next(f for f in ranking["features"] if f["entity_id"] == feat["id"])
    return {
        "detail": detail["confidence"],
        "graph": of(graph["entities"], feat["id"])["confidence"],
        "entities": of(listed, feat["id"])["confidence"],
        "trace": of(trace["features"], feat["id"])["confidence"],
        "priorities": ranked["explanation"]["confidence"]["value"],
        "blocker": strategy["blocker"]["confidence"],
        "blocker_detail": (await _get(client, f"{B}/entities/{blocker['id']}", headers))[
            "confidence"
        ],
        "edge_detail": edge_detail["confidence"],
        "graph_edge": of(graph["edges"], link["id"])["confidence"],
        "edges": of(edges, link["id"])["confidence"],
    }


async def test_every_route_a_run_reads_scores_frozen_at_its_pin(client, ctx):
    feat = await entity(client, ctx, type="feature", key="guided-setup")
    other = await entity(client, ctx, type="feature", key="bulk-import")
    link = await edge(client, ctx, feat, other, "depends_on")
    blocker = (await create_blocker(client, ctx))["blocker"]
    now = datetime.now(UTC)
    updated = now - timedelta(days=10)
    for target, kind in ((feat, "entities"), (link, "edges"), (blocker, "entities")):
        item = await make_item(ctx, "owner", updated=updated)
        await cite(client, ctx, target, kind=kind, source_item_id=str(item))
        if target is feat:
            feat_item = item
    for target in (feat, blocker):
        await _rescore(ctx, target["id"], now)
    async with tenant_session(ctx.tenant_id) as s:
        await scoring.rescore_targets(s, edge_ids=[uuid.UUID(link["id"])], now=now)
        await s.commit()

    pin = now
    run = await _run_pinned_at(ctx, "owner", pin)
    frozen = await _reads(client, ctx, feat, other, link, blocker, run)
    assert len(set(frozen.values())) <= 3 and None not in frozen.values()
    assert frozen["detail"] == frozen["graph"] == frozen["entities"] == frozen["trace"]
    assert frozen["detail"] == frozen["priorities"]
    assert frozen["blocker"] == frozen["blocker_detail"]
    assert frozen["edge_detail"] == frozen["graph_edge"] == frozen["edges"]

    # The cited item changes upstream, newer: the stored live score rises.
    later = now + timedelta(days=30)
    await _changed_upstream(ctx, feat_item, later - timedelta(days=1))
    for target in (feat, blocker):
        await _rescore(ctx, target["id"], later)
    people = await _reads(client, ctx, feat, other, link, blocker, ctx.as_("owner"))
    assert people["detail"] > frozen["detail"]
    assert people["graph"] == people["entities"] == people["trace"] == people["detail"]

    # The run still reads exactly what it read, on every route.
    assert await _reads(client, ctx, feat, other, link, blocker, run) == frozen


async def test_a_run_without_a_pin_reads_the_stored_score_on_list_routes(client, ctx):
    """Unchanged: a run whose run pinned no snapshot reads the stored (live) value."""
    feat = await entity(client, ctx, type="feature", key="guided-setup")
    item = await make_item(ctx, "owner")
    await cite(client, ctx, feat, source_item_id=str(item))
    from oracle.auth.service import make_session_cookie
    from oracle.config import get_settings

    headers = {
        "Cookie": f"{get_settings().session_cookie_name}={make_session_cookie(ctx.users['owner'])}",
        "x-oracle-run-id": str(uuid.uuid4()),
    }
    theirs = await _get(client, f"{B}/entities", headers)
    mine = await _get(client, f"{B}/entities", ctx.as_("owner"))
    assert [e["confidence"] for e in theirs] == [e["confidence"] for e in mine]
