"""Citations of a source item that was narrowed out or deleted upstream (S5, owner
2026-10-20): the item is soft-deleted (``deleted_at``), and every citation of it says
'source removed', in the API (and so over MCP), in exports and in the web view. What
the existing visibility rules already show (the stored title for its owner, evidence's
copied excerpt) stays, since stored versions are kept."""

import re
import uuid
from datetime import UTC, datetime

import pytest

from oracle.baseline.models import Evidence
from oracle.blockers import views as blocker_views
from oracle.sources.models import SourceItem
from oracle.tenancy import tenant_session
from tests.baseline_helpers import cite, entity, make_ctx, make_item
from tests.test_mcp import mcp_client
from tests.test_trace_views import _evidence_setup
from tests.trace_helpers import DOC, link_section

B = "/v1/baseline"


@pytest.fixture
async def ctx():
    return await make_ctx()


async def remove(tenant_id: uuid.UUID, item_id: uuid.UUID) -> None:
    async with tenant_session(tenant_id) as s:
        (await s.get(SourceItem, item_id)).deleted_at = datetime.now(UTC)
        await s.commit()


async def test_evidence_of_a_removed_item_says_source_removed(client, ctx):
    feat = await entity(client, ctx, type="feature", key="guided-setup")
    kept = await make_item(ctx, "owner", title="kept thread")
    gone = await make_item(ctx, "owner", title="#product thread", content="Top request")
    ev_kept = await cite(client, ctx, feat, source_item_id=str(kept))
    ev_gone = await cite(client, ctx, feat, source_item_id=str(gone))
    free = await cite(client, ctx, feat, url="https://notes.example.com/a", excerpt="Plan")
    assert ev_gone["source_removed"] is False
    await remove(ctx.tenant_id, gone)

    for who in ("owner", "viewer", "token"):
        rows = (
            await client.get(
                f"{B}/evidence", params={"entity_id": feat["id"]}, headers=ctx.as_(who)
            )
        ).json()
        by_id = {r["id"]: r for r in rows}
        assert by_id[ev_gone["id"]]["source_removed"] is True, who
        assert by_id[ev_kept["id"]]["source_removed"] is False, who
        assert by_id[free["id"]]["source_removed"] is False, who
        # The copied excerpt stays (the stored version is kept).
        assert by_id[ev_gone["id"]]["excerpt"] == ev_gone["excerpt"]
        detail = (await client.get(f"{B}/entities/{feat['id']}", headers=ctx.as_(who))).json()
        flags = {e["id"]: e["source_removed"] for e in detail["evidence"]}
        assert flags[ev_gone["id"]] is True and flags[ev_kept["id"]] is False, who
    # Its owner still sees the item's stored title; others still never see the item.
    owner_rows = (
        await client.get(
            f"{B}/evidence", params={"entity_id": feat["id"]}, headers=ctx.as_("owner")
        )
    ).json()
    mine = {r["id"]: r for r in owner_rows}[ev_gone["id"]]
    assert mine["source_item"]["title"] == "#product thread"
    viewer_rows = (
        await client.get(
            f"{B}/evidence", params={"entity_id": feat["id"]}, headers=ctx.as_("viewer")
        )
    ).json()
    assert {r["id"]: r for r in viewer_rows}[ev_gone["id"]]["source_item"] is None

    # Over MCP (the REST JSON passes through).
    async with mcp_client(ctx.token) as c:
        res = await c.call_tool("list_evidence", {"entity_id": feat["id"]})
        assert not res.is_error
        data = res.structured_content
        rows = data.get("result", data) if isinstance(data, dict) else data
        flags = {r["id"]: r["source_removed"] for r in rows}
        assert flags[ev_gone["id"]] is True and flags[ev_kept["id"]] is False


async def test_the_baseline_yaml_marks_evidence_of_a_removed_item(client, ctx):
    feat = await entity(client, ctx, type="feature", key="guided-setup")
    gone = await make_item(ctx, "owner")
    kept = await make_item(ctx, "owner", url="https://chat.example.com/archives/C1/p2")
    await cite(client, ctx, feat, source_item_id=str(gone), excerpt="gone one")
    await cite(client, ctx, feat, source_item_id=str(kept), excerpt="kept one")
    await remove(ctx.tenant_id, gone)
    for who in ("owner", "viewer"):
        text = (await client.get(f"{B}/yaml", headers=ctx.as_(who))).text
        assert text.count("source_removed: true") == 1, (who, text)
    # The marker is ignored on import: a round trip adds nothing.
    text = (await client.get(f"{B}/yaml", headers=ctx.as_("owner"))).text
    resp = await client.post(
        f"{B}/yaml", content=text, headers={**ctx.as_("owner"), "Content-Type": "application/yaml"}
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["evidence_added"] == 0


async def test_section_links_to_a_removed_item_say_source_removed(client):
    ctx, chain, v1, weak, strong, item = await _evidence_setup(client)
    async with tenant_session(ctx.tenant_id) as s:
        # Evidence copied from the same item.
        from_item = Evidence(
            entity_id=chain["requirement"], ref="owner notes", excerpt="Kept excerpt",
            source_item_id=item, confidence=0.5,
        )  # fmt: skip
        s.add(from_item)
        await s.commit()
    await link_section(
        ctx.tenant_id, v1.document_id, v1.id, "metrics", source_item_id=item, kind="evidences"
    )
    await link_section(
        ctx.tenant_id, v1.document_id, v1.id, "metrics", evidence_id=from_item.id, kind="claims"
    )
    await link_section(
        ctx.tenant_id, v1.document_id, v1.id, "metrics", evidence_id=strong, kind="claims"
    )
    await remove(ctx.tenant_id, item)

    url = f"/v1/documents/{DOC}/versions/1/evidence"
    for who in ("viewer", "owner"):
        out = (await client.get(url, headers=ctx.as_(who))).json()
        links = {s["section_key"]: s for s in out["sections"]}["metrics"]["links"]
        by_target = {lk["target"]["id"]: lk["target"] for lk in links}
        assert by_target[str(item)]["source_removed"] is True, who
        assert by_target[str(from_item.id)]["source_removed"] is True, who
        assert by_target[str(from_item.id)]["excerpt"] == "Kept excerpt"
        assert by_target[str(strong)]["source_removed"] is False, who
    # Its owner still sees the stored title; others still only its kind.
    owner = (await client.get(url, headers=ctx.as_("owner"))).json()
    t = {lk["target"]["id"]: lk["target"] for s in owner["sections"] for lk in s["links"]}
    assert t[str(item)]["title"] == "Owner-only notes"
    viewer = (await client.get(url, headers=ctx.as_("viewer"))).json()
    vt = {lk["target"]["id"]: lk["target"] for s in viewer["sections"] for lk in s["links"]}
    assert vt[str(item)]["title"] is None and vt[str(item)]["restricted"] is True

    # Over MCP.
    async with mcp_client(ctx.token) as c:
        res = await c.call_tool("get_version_evidence", {"doc": DOC, "n": 1})
        assert not res.is_error
        sections = {s["section_key"]: s for s in res.structured_content["sections"]}
        mt = {lk["target"]["id"]: lk["target"] for lk in sections["metrics"]["links"]}
        assert mt[str(item)]["source_removed"] is True
        assert mt[str(strong)]["source_removed"] is False

    # Exports: the appendix says so.
    html = (
        await client.get(
            f"/v1/documents/{DOC}/versions/1/export?format=html", headers=ctx.as_("viewer")
        )
    ).text
    links_html = html.split('id="sources-evidence-links"', 1)[1]
    assert re.search(r"upload source item \(source removed\)", links_html)
    assert links_html.count("source removed") == 2
    assert "Owner-only notes" not in html


async def test_blocker_citations_of_a_removed_item_say_source_removed(client, ctx):
    feat = await entity(client, ctx, type="feature", key="guided-setup")
    gone = await make_item(ctx, "owner")
    kept = await make_item(ctx, "owner", url="https://chat.example.com/archives/C1/p2")
    ev_gone = await cite(client, ctx, feat, source_item_id=str(gone))
    ev_kept = await cite(client, ctx, feat, source_item_id=str(kept))
    await remove(ctx.tenant_id, gone)
    async with tenant_session(ctx.tenant_id) as s:
        refs = await blocker_views._evidence_refs(
            s, {uuid.UUID(ev_gone["id"]), uuid.UUID(ev_kept["id"])}
        )
    assert refs[uuid.UUID(ev_gone["id"])].title == "source removed"
    assert refs[uuid.UUID(ev_kept["id"])].title is None


async def test_priorities_mark_evidence_of_a_removed_item(client, ctx):
    feat = await entity(client, ctx, type="feature", key="guided-setup")
    gone = await make_item(ctx, "owner")
    kept = await make_item(ctx, "owner", url="https://chat.example.com/archives/C1/p2")
    ev_gone = await cite(client, ctx, feat, source_item_id=str(gone))
    ev_kept = await cite(client, ctx, feat, source_item_id=str(kept))
    await remove(ctx.tenant_id, gone)
    out = (await client.get("/v1/priorities", headers=ctx.as_("viewer"))).json()
    (f,) = [f for f in out["features"] if f["key"] == "guided-setup"]
    used = {e["id"]: e for e in f["explanation"]["confidence"]["evidence"]}
    assert used[ev_gone["id"]]["source_removed"] is True
    assert used[ev_kept["id"]]["source_removed"] is False
