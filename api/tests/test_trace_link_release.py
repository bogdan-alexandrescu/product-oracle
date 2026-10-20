"""Deleting a baseline entity or edge releases the section links that cite it, its
evidence or its edges' evidence, the way removing evidence does (oracle.v2.links): a link
that keeps another target only drops the deleted one, a link left with no target goes and
is kept on the change, and the sections citing the deleted evidence are marked potentially
stale. Directly, over REST, over MCP and through an accepted delete proposal. Synthetic
placeholders only."""

import uuid

import pytest
from sqlalchemy import select

import oracle.main  # noqa: F401  (registers the lanes' change handlers)
from oracle.baseline import service
from oracle.baseline.models import Edge, Entity, Evidence
from oracle.tenancy import tenant_session
from oracle.v2 import models as m
from tests.baseline_helpers import make_ctx, make_item
from tests.test_mcp import mcp_client
from tests.trace_helpers import (
    depend,
    dependency,
    link_section,
    prd_v1,
    seed_chain,
    stub_artifact,
)

B = "/v1/baseline"
VIAS = ["rest", "mcp", "proposal", "service"]


async def _changes(tenant_id: uuid.UUID, cause: str) -> list[m.ChangeEvent]:
    async with tenant_session(tenant_id) as s:
        rows = await s.scalars(
            select(m.ChangeEvent).where(m.ChangeEvent.cause == cause)
            .order_by(m.ChangeEvent.created_at)
        )  # fmt: skip
        return list(rows.all())


async def _link(tenant_id: uuid.UUID, link_id: uuid.UUID) -> m.DocumentSectionLink | None:
    async with tenant_session(tenant_id) as s:
        return await s.get(m.DocumentSectionLink, link_id)


def _snapshotted(change: m.ChangeEvent) -> set[str]:
    return {lk["id"] for lk in change.data["trace"]["links"]}


async def _add_evidence(tenant_id, *, entity_id=None, edge_id=None, ref="notes.md") -> uuid.UUID:
    async with tenant_session(tenant_id) as s:
        ev = Evidence(entity_id=entity_id, edge_id=edge_id, ref=ref, excerpt="Placeholder")
        s.add(ev)
        await s.commit()
        return ev.id


async def _edge_id(tenant_id, src: uuid.UUID, dst: uuid.UUID, type_: str) -> uuid.UUID:
    async with tenant_session(tenant_id) as s:
        return await s.scalar(
            select(Edge.id).where(Edge.src_id == src, Edge.dst_id == dst, Edge.type == type_)
        )


async def _set(tenant_id, model, ident: uuid.UUID, **values) -> None:
    async with tenant_session(tenant_id) as s:
        row = await s.get(model, ident)
        for k, v in values.items():
            setattr(row, k, v)
        await s.commit()


async def _delete(client, ctx, kind: str, ident: uuid.UUID, via: str) -> None:
    """Delete an entity or an edge: over REST, MCP, an accepted proposal or the service."""
    path = f"{B}/{'entities' if kind == 'entity' else 'edges'}/{ident}"
    if via == "rest":
        resp = await client.delete(path, headers=ctx.as_("approver"))
        assert resp.status_code == 204, resp.text
    elif via == "mcp":
        async with mcp_client(ctx.token) as c:
            result = await c.call_tool(f"delete_{kind}", {f"{kind}_id": str(ident)})
        assert not result.is_error, result
    elif via == "proposal":
        await _set(ctx.tenant_id, Entity if kind == "entity" else Edge, ident, locked=True)
        resp = await client.delete(f"{path}?origin=agent", headers=ctx.as_("approver"))
        assert resp.status_code == 202, resp.text
        proposal_id = resp.json()["id"]
        resp = await client.post(
            f"{B}/proposals/{proposal_id}/accept", json={}, headers=ctx.as_("approver")
        )
        assert resp.status_code == 200, resp.text
    else:
        # No request rollback to hide it: no IntegrityError from a link's target check.
        async with tenant_session(ctx.tenant_id) as s:
            writer = service.Writer(None, "user")
            if kind == "entity":
                await service.delete_entity(s, writer, await s.get(Entity, ident))
            else:
                await service.delete_edge(s, writer, await s.get(Edge, ident))
            await s.commit()
    async with tenant_session(ctx.tenant_id) as s:
        assert await s.get(Entity if kind == "entity" else Edge, ident) is None


# --- entities ---------------------------------------------------------------------------------


@pytest.mark.parametrize("via", VIAS)
async def test_deleting_an_entity_releases_its_links(client, via):
    ctx = await make_ctx()
    chain = await seed_chain(ctx.tenant_id)
    v1 = await prd_v1(client, ctx)
    doc, ver, tid = v1.document_id, v1.id, ctx.tenant_id
    feature, decision = chain["feature"], chain["decision"]
    ev = await _add_evidence(tid, entity_id=feature)
    supports = await _edge_id(tid, feature, chain["goal"], "supports")
    edge_ev = await _add_evidence(tid, edge_id=supports, ref="edge-notes.md")
    item_id = await make_item(ctx, "owner")

    # Keep another target: only the deleted one is dropped.
    ev_and_entity = await link_section(
        tid, doc, ver, "risks", evidence_id=ev, entity_id=decision, kind="evidences"
    )
    entity_and_item = await link_section(
        tid, doc, ver, "summary", entity_id=feature, source_item_id=item_id, kind="implements"
    )
    edge_ev_and_entity = await link_section(
        tid, doc, ver, "risks", evidence_id=edge_ev, entity_id=decision, kind="evidences"
    )
    # Left with no target: deleted, and kept on the change.
    ev_only = await link_section(tid, doc, ver, "metrics", evidence_id=ev, kind="evidences")
    entity_only = await link_section(tid, doc, ver, "summary", entity_id=feature)
    entity_and_own_ev = await link_section(
        tid, doc, ver, "summary", entity_id=feature, evidence_id=ev, kind="claims"
    )
    edge_ev_only = await link_section(
        tid, doc, ver, "sources", evidence_id=edge_ev, kind="evidences"
    )
    _, av = await stub_artifact(tid, doc, ver, kind="wireframe")
    on_metrics = await depend(tid, artifact_version_id=av, upstream_version_id=ver,
                              section_key="metrics")  # fmt: skip
    on_sources = await depend(tid, artifact_version_id=av, upstream_version_id=ver,
                              section_key="sources")  # fmt: skip

    await _delete(client, ctx, "entity", feature, via)

    kept = await _link(tid, ev_and_entity)
    assert kept is not None and kept.entity_id == decision and kept.evidence_id is None
    kept = await _link(tid, entity_and_item)
    assert kept is not None and kept.entity_id is None and kept.source_item_id == item_id
    kept = await _link(tid, edge_ev_and_entity)
    assert kept is not None and kept.entity_id == decision and kept.evidence_id is None
    for gone in (ev_only, entity_only, entity_and_own_ev, edge_ev_only):
        assert await _link(tid, gone) is None
    (change,) = await _changes(tid, "entity_deleted")
    assert change.subject_id == feature
    assert _snapshotted(change) == {
        str(ev_only),
        str(entity_only),
        str(entity_and_own_ev),
        str(edge_ev_only),
    }
    # The sections citing the deleted evidence are potentially stale, through this change.
    marked = {x["id"]: x for x in change.data["trace"]["marked"]}
    for dep_id, key in ((on_metrics, "metrics"), (on_sources, "sources")):
        dep = await dependency(tid, dep_id)
        assert dep.freshness == "potentially_stale"
        assert dep.caused_by_change_id == change.id
        assert any(
            f"section {key}" in r and "cites evidence that was deleted" in r
            for r in marked[str(dep_id)]["reasons"]
        )


async def test_a_kept_link_still_traces_to_its_other_entity(client):
    """A link that kept its other entity still makes a later change to that entity reach
    the section."""
    ctx = await make_ctx()
    chain = await seed_chain(ctx.tenant_id)
    v1 = await prd_v1(client, ctx)
    tid = ctx.tenant_id
    ev = await _add_evidence(tid, entity_id=chain["orphan"])
    link = await link_section(
        tid, v1.document_id, v1.id, "risks", evidence_id=ev, entity_id=chain["decision"]
    )
    await _delete(client, ctx, "entity", chain["orphan"], "rest")
    assert (await _link(tid, link)).evidence_id is None

    _, av = await stub_artifact(tid, v1.document_id, v1.id, kind="wireframe")
    dep_id = await depend(tid, artifact_version_id=av, upstream_version_id=v1.id,
                          section_key="risks")  # fmt: skip
    resp = await client.patch(
        f"{B}/entities/{chain['decision']}", json={"title": "Store addresses with a vendor"},
        headers=ctx.as_("approver"),
    )  # fmt: skip
    assert resp.status_code == 200, resp.text
    assert (await dependency(tid, dep_id)).freshness == "potentially_stale"


async def test_deleting_an_entity_without_links_records_as_before(client):
    ctx = await make_ctx()
    chain = await seed_chain(ctx.tenant_id)
    await _delete(client, ctx, "entity", chain["orphan"], "rest")
    (change,) = await _changes(ctx.tenant_id, "entity_deleted")
    assert change.data["trace"]["links"] == []
    assert await _changes(ctx.tenant_id, "evidence_deleted") == []


# --- edges ------------------------------------------------------------------------------------


@pytest.mark.parametrize("via", VIAS)
async def test_deleting_an_edge_releases_its_evidence_links(client, via):
    ctx = await make_ctx()
    chain = await seed_chain(ctx.tenant_id)
    v1 = await prd_v1(client, ctx)
    doc, ver, tid = v1.document_id, v1.id, ctx.tenant_id
    supports = await _edge_id(tid, chain["feature"], chain["goal"], "supports")
    ev = await _add_evidence(tid, edge_id=supports)
    keeps = await link_section(
        tid, doc, ver, "risks", evidence_id=ev, entity_id=chain["decision"], kind="evidences"
    )
    only = await link_section(tid, doc, ver, "metrics", evidence_id=ev, kind="evidences")
    _, av = await stub_artifact(tid, doc, ver, kind="wireframe")
    dep_id = await depend(tid, artifact_version_id=av, upstream_version_id=ver,
                          section_key="metrics")  # fmt: skip

    await _delete(client, ctx, "edge", supports, via)

    kept = await _link(tid, keeps)
    assert kept is not None and kept.entity_id == chain["decision"] and kept.evidence_id is None
    assert await _link(tid, only) is None
    (change,) = await _changes(tid, "evidence_deleted")
    assert change.subject_kind == "source_permission"
    assert change.data["evidence_ids"] == [str(ev)]
    assert _snapshotted(change) == {str(only)}
    dep = await dependency(tid, dep_id)
    assert dep.freshness == "potentially_stale"
    marked = {x["id"]: x for x in change.data["trace"]["marked"]}
    assert any("cites evidence that was deleted" in r for r in marked[str(dep_id)]["reasons"])
    # The edge's own change is recorded as before.
    assert len(await _changes(tid, "edge_deleted")) == 1


async def test_deleting_a_proposed_edge_releases_its_evidence_links(client):
    """A proposed edge records no edge change, but the evidence it takes is still cited."""
    ctx = await make_ctx()
    chain = await seed_chain(ctx.tenant_id)
    v1 = await prd_v1(client, ctx)
    tid = ctx.tenant_id
    supports = await _edge_id(tid, chain["feature"], chain["goal"], "supports")
    await _set(tid, Edge, supports, status="proposed")
    ev = await _add_evidence(tid, edge_id=supports)
    keeps = await link_section(
        tid, v1.document_id, v1.id, "risks", evidence_id=ev, entity_id=chain["decision"]
    )
    await _delete(client, ctx, "edge", supports, "rest")
    kept = await _link(tid, keeps)
    assert kept is not None and kept.evidence_id is None
    assert await _changes(tid, "edge_deleted") == []
    (change,) = await _changes(tid, "evidence_deleted")
    assert _snapshotted(change) == set()


async def test_deleting_an_edge_whose_evidence_nothing_cites_records_as_before(client):
    ctx = await make_ctx()
    chain = await seed_chain(ctx.tenant_id)
    tid = ctx.tenant_id
    supports = await _edge_id(tid, chain["feature"], chain["goal"], "supports")
    await _add_evidence(tid, edge_id=supports)
    await _delete(client, ctx, "edge", supports, "rest")
    assert await _changes(tid, "evidence_deleted") == []
    assert len(await _changes(tid, "edge_deleted")) == 1


# --- YAML import --------------------------------------------------------------------------


async def test_a_yaml_import_that_drops_an_entity_keeps_it_and_its_links(client):
    """An import leaves items not in the file alone: nothing is deleted, so nothing is
    released and no link is lost."""
    ctx = await make_ctx()
    chain = await seed_chain(ctx.tenant_id)
    v1 = await prd_v1(client, ctx)
    tid = ctx.tenant_id
    ev = await _add_evidence(tid, entity_id=chain["orphan"])
    link = await link_section(tid, v1.document_id, v1.id, "risks", evidence_id=ev,
                              entity_id=chain["orphan"])  # fmt: skip
    yaml_text = (
        "version: 1\nentities:\n"
        "  - {type: decision, key: store-in-house, title: Store addresses in-house}\n"
    )
    resp = await client.post(
        f"{B}/yaml", content=yaml_text.encode(),
        headers={**ctx.as_("approver"), "Content-Type": "application/yaml"},
    )  # fmt: skip
    assert resp.status_code == 200, resp.text
    kept = await _link(tid, link)
    assert kept is not None
    assert kept.entity_id == chain["orphan"] and kept.evidence_id == ev
    assert await _changes(tid, "entity_deleted") == []
