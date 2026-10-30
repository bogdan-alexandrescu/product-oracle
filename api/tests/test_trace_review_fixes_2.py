"""Review fixes for the trace lane, round 2 (PR #26): removing evidence or a source marks
what was built on it, a source item link survives its source's deletion check, scoped
walks cap their roots and do not report a cycle as truncation, walks stay in their
company, a removed part reaches what is downstream of its whole, proposed edges record
nothing, and a reconciled deleted upstream stays settled. Synthetic placeholders only."""

import uuid

from sqlalchemy import select

import oracle.main  # noqa: F401  (registers the lanes' change handlers)
from oracle.auth.service import create_api_token
from oracle.baseline.models import Edge, Entity
from oracle.sources import service as sources_service
from oracle.sources.models import Source, SourceItem
from oracle.tenancy import tenant_session
from oracle.trace import graph as graph_mod
from oracle.trace import staleness
from oracle.v2 import models as m
from tests.baseline_helpers import make_ctx, make_item
from tests.test_mcp import mcp_client
from tests.trace_helpers import (
    artifact_version,
    depend,
    dependency,
    link_section,
    prd_v1,
    seed_chain,
    stub_artifact,
)

ACTIONS = "/v1/trace/staleness/actions"
B = "/v1/baseline"


async def _changes(tenant_id: uuid.UUID) -> list[m.ChangeEvent]:
    async with tenant_session(tenant_id) as s:
        return list(
            (await s.scalars(select(m.ChangeEvent).order_by(m.ChangeEvent.created_at))).all()
        )


async def _link(tenant_id: uuid.UUID, link_id: uuid.UUID) -> m.DocumentSectionLink | None:
    async with tenant_session(tenant_id) as s:
        return await s.get(m.DocumentSectionLink, link_id)


def _reasons(change: m.ChangeEvent, dep_id: uuid.UUID) -> list[str]:
    marked = {x["id"]: x for x in change.data["trace"]["marked"]}
    return marked[str(dep_id)]["reasons"]


# --- MAJOR: removing evidence marks the sections citing it and their outputs -------------------


async def _evidence_setup(client, ctx):
    """Evidence E on the feature, cited by the PRD's sources section; one output built on
    that section, one on the feature."""
    chain = await seed_chain(ctx.tenant_id)
    v1 = await prd_v1(client, ctx)
    resp = await client.post(
        f"{B}/entities/{chain['feature']}/evidence",
        json={"ref": "checkout-notes.md", "excerpt": "Buyers retype their address"},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 201, resp.text
    evidence_id = uuid.UUID(resp.json()["id"])
    link = await link_section(
        ctx.tenant_id, v1.document_id, v1.id, "sources", evidence_id=evidence_id,
        kind="evidences",
    )  # fmt: skip
    _, wire = await stub_artifact(ctx.tenant_id, v1.document_id, v1.id, kind="wireframe")
    _, spec = await stub_artifact(ctx.tenant_id, v1.document_id, v1.id)
    on_section = await depend(
        ctx.tenant_id, artifact_version_id=wire, upstream_version_id=v1.id, section_key="sources"
    )
    on_feature = await depend(ctx.tenant_id, artifact_version_id=spec, entity_id=chain["feature"])
    return chain, evidence_id, link, (wire, on_section), (spec, on_feature)


async def _assert_evidence_removal(ctx, evidence_id, link, wire, spec):
    (wire_id, on_section), (spec_id, on_feature) = wire, spec
    # The section link (its only target the evidence) went with it; the dependencies stay.
    assert await _link(ctx.tenant_id, link) is None
    for dep_id in (on_section, on_feature):
        dep = await dependency(ctx.tenant_id, dep_id)
        assert dep is not None and dep.freshness == "potentially_stale", dep_id
    for av in (wire_id, spec_id):
        assert (await artifact_version(ctx.tenant_id, av)).freshness == "potentially_stale"
    (change,) = [c for c in await _changes(ctx.tenant_id) if c.cause == "evidence_deleted"]
    assert change.subject_kind == "source_permission"
    assert change.subject_id == evidence_id
    assert (await dependency(ctx.tenant_id, on_section)).caused_by_change_id == change.id
    # What was removed is kept on the change, since its rows are gone.
    assert change.data["evidence"][0]["ref"] == "checkout-notes.md"
    assert str(link) in {lk["id"] for lk in change.data["trace"]["links"]}
    assert any(
        "sources" in r and "evidence that was deleted" in r for r in _reasons(change, on_section)
    )
    assert any("Saved addresses" in r and "evidence" in r
               for r in _reasons(change, on_feature))  # fmt: skip


async def test_removing_evidence_marks_the_sections_citing_it_and_their_outputs(client):
    ctx = await make_ctx()
    _, evidence_id, link, wire, spec = await _evidence_setup(client, ctx)

    resp = await client.delete(f"{B}/evidence/{evidence_id}", headers=ctx.as_("approver"))
    assert resp.status_code == 204, resp.text

    await _assert_evidence_removal(ctx, evidence_id, link, wire, spec)


async def test_removing_evidence_over_mcp_marks_the_same(client):
    ctx = await make_ctx()
    _, evidence_id, link, wire, spec = await _evidence_setup(client, ctx)

    async with mcp_client(ctx.token) as c:
        result = await c.call_tool("remove_evidence", {"evidence_id": str(evidence_id)})
    assert not result.is_error, result

    await _assert_evidence_removal(ctx, evidence_id, link, wire, spec)


# --- MAJOR: deleting a source marks what its items' evidence backs ----------------------------


async def _source_setup(client, ctx):
    """The owner's source item backs evidence on the feature (cited by the requirements
    section) and is cited directly by the sources section (a link with only a source
    item: deleting the source must not violate the link's target check)."""
    chain = await seed_chain(ctx.tenant_id)
    v1 = await prd_v1(client, ctx)
    item_id = await make_item(ctx, "owner", content="Buyers retype their address every time.")
    async with tenant_session(ctx.tenant_id) as s:
        source_id = (await s.get(SourceItem, item_id)).source_id
    resp = await client.post(
        f"{B}/entities/{chain['feature']}/evidence",
        json={"source_item_id": str(item_id)},
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 201, resp.text
    evidence_id = uuid.UUID(resp.json()["id"])
    by_evidence = await link_section(
        ctx.tenant_id, v1.document_id, v1.id, "requirements", evidence_id=evidence_id,
        kind="evidences",
    )  # fmt: skip
    by_item = await link_section(
        ctx.tenant_id, v1.document_id, v1.id, "sources", source_item_id=item_id, kind="evidences"
    )
    outputs, deps = {}, {}
    for kind, key in (("wireframe", "sources"), ("prototype", "requirements")):
        _, outputs[kind] = await stub_artifact(ctx.tenant_id, v1.document_id, v1.id, kind=kind)
        deps[kind] = await depend(
            ctx.tenant_id, artifact_version_id=outputs[kind], upstream_version_id=v1.id,
            section_key=key,
        )  # fmt: skip
    _, outputs["spec"] = await stub_artifact(ctx.tenant_id, v1.document_id, v1.id)
    deps["spec"] = await depend(
        ctx.tenant_id, artifact_version_id=outputs["spec"], entity_id=chain["feature"]
    )
    return source_id, evidence_id, by_evidence, by_item, outputs, deps


async def _assert_source_removal(ctx, source_id, evidence_id, by_evidence, by_item, outputs, deps):
    async with tenant_session(ctx.tenant_id) as s:
        assert await s.get(Source, source_id) is None
    # A link to the item alone goes with it; the evidence stays (its excerpt was copied).
    assert await _link(ctx.tenant_id, by_item) is None
    assert await _link(ctx.tenant_id, by_evidence) is not None
    for name, dep_id in deps.items():
        assert (await dependency(ctx.tenant_id, dep_id)).freshness == "potentially_stale", name
    for av in outputs.values():
        assert (await artifact_version(ctx.tenant_id, av)).freshness == "potentially_stale"
    (change,) = [c for c in await _changes(ctx.tenant_id) if c.cause == "source_deleted"]
    assert change.subject_kind == "source_permission"
    assert change.subject_id == source_id
    assert change.data["source"]["kind"] == "slack"
    assert str(by_item) in {lk["id"] for lk in change.data["trace"]["links"]}
    assert any("source was deleted" in r for r in _reasons(change, deps["wireframe"]))
    assert any("source was deleted" in r for r in _reasons(change, deps["prototype"]))
    assert any("Saved addresses" in r for r in _reasons(change, deps["spec"]))


async def test_deleting_a_source_marks_what_its_items_back(client):
    ctx = await make_ctx()
    setup = await _source_setup(client, ctx)

    resp = await client.delete(f"/v1/sources/{setup[0]}", headers=ctx.as_("owner"))
    assert resp.status_code == 204, resp.text

    await _assert_source_removal(ctx, *setup)


async def test_deleting_a_source_over_mcp_marks_the_same(client):
    ctx = await make_ctx()
    setup = await _source_setup(client, ctx)
    async with tenant_session(ctx.tenant_id) as s:
        _, raw = await create_api_token(s, "agent", user_id=ctx.users["owner"].id)
        await s.commit()

    async with mcp_client(raw) as c:
        result = await c.call_tool("delete_source", {"source_id": str(setup[0])})
    assert not result.is_error, result

    await _assert_source_removal(ctx, *setup)


async def test_a_link_to_a_source_item_alone_goes_with_its_source(client):
    ctx = await make_ctx()
    v1 = await prd_v1(client, ctx)
    item_id = await make_item(ctx, "owner")
    link = await link_section(
        ctx.tenant_id, v1.document_id, v1.id, "sources", source_item_id=item_id, kind="mentions"
    )
    async with tenant_session(ctx.tenant_id) as s:
        source = await s.get(Source, (await s.get(SourceItem, item_id)).source_id)
        await sources_service.delete_source(s, source, actor="test")
    assert await _link(ctx.tenant_id, link) is None


# --- minors: scoped loads --------------------------------------------------------------------


async def _entities(tenant_id: uuid.UUID, n: int, prefix: str = "f") -> list[uuid.UUID]:
    async with tenant_session(tenant_id) as s:
        rows = [
            Entity(type="feature", key=f"{prefix}-{i}", title=f"Feature {i}", status="confirmed",
                   origin="user")
            for i in range(n)
        ]  # fmt: skip
        s.add_all(rows)
        await s.commit()
        return [e.id for e in rows]


async def _edges(tenant_id: uuid.UUID, pairs, type_: str = "depends_on") -> None:
    async with tenant_session(tenant_id) as s:
        for src, dst in pairs:
            s.add(Edge(src_id=src, dst_id=dst, type=type_, status="confirmed", origin="user"))
        await s.commit()


async def test_load_around_caps_its_roots_and_says_so(client, monkeypatch):
    ctx = await make_ctx()
    roots = await _entities(ctx.tenant_id, 4)
    (child,) = await _entities(ctx.tenant_id, 1, prefix="child")
    await _edges(ctx.tenant_id, [(child, roots[0])])
    monkeypatch.setattr(graph_mod, "MAX_ROOTS", 2)
    monkeypatch.setattr(graph_mod, "MAX_NODES", 3)
    async with tenant_session(ctx.tenant_id) as s:
        g = await graph_mod.load_around(s, roots, down=True)
    assert g.truncated is True
    # Two roots loaded, leaving room for the first root's neighbour.
    assert sum(r in g.entities for r in roots) == 2
    assert child in g.entities


async def test_a_cycle_that_ends_at_the_depth_bound_is_not_truncation(client, monkeypatch):
    ctx = await make_ctx()
    root, a, b = await _entities(ctx.tenant_id, 3)
    # a and b are downstream of root; root depends on b again: a cycle of three.
    await _edges(ctx.tenant_id, [(a, root), (b, a), (root, b)])
    monkeypatch.setattr(graph_mod, "MAX_DEPTH", 2)
    async with tenant_session(ctx.tenant_id) as s:
        g = await graph_mod.load_around(s, [root], down=True)
    assert {root, a, b} <= set(g.entities)
    assert [st.entity_id for st in g.downstream(root)] == [a, b]
    assert g.truncated is False


async def test_a_chain_longer_than_the_depth_bound_is_truncated(client, monkeypatch):
    ctx = await make_ctx()
    ids = await _entities(ctx.tenant_id, 5)
    await _edges(ctx.tenant_id, [(ids[i + 1], ids[i]) for i in range(4)])
    monkeypatch.setattr(graph_mod, "MAX_DEPTH", 2)
    async with tenant_session(ctx.tenant_id) as s:
        g = await graph_mod.load_around(s, [ids[0]], down=True)
    assert set(ids[:3]) <= set(g.entities)
    assert ids[3] not in g.entities and ids[4] not in g.entities
    assert g.truncated is True
    assert [st.entity_id for st in g.downstream(ids[0])] == ids[1:3]


async def test_a_walk_never_follows_an_edge_into_another_company(client):
    a = await make_ctx("Company A")
    b = await make_ctx("Company B")
    (ours,) = await _entities(a.tenant_id, 1, prefix="ours")
    (theirs,) = await _entities(b.tenant_id, 1, prefix="theirs")
    # Seeded across companies, one edge in each: neither may be followed from A.
    await _edges(a.tenant_id, [(theirs, ours)])
    await _edges(b.tenant_id, [(theirs, ours)], type_="part_of")
    await _edges(b.tenant_id, [(ours, theirs)], type_="part_of")
    async with tenant_session(a.tenant_id) as s:
        g = await graph_mod.load_around(s, [ours], down=True, up=True, related=True)
        assert set(g.entities) == {ours}
        assert g.truncated is False
        # The column-only select of a removal's wholes is scoped to the company too.
        (root,) = await staleness._removal_wholes(s, [staleness.Root(ours, "entity_deleted")])
        assert root.wholes == ()


# --- minors: what a change reaches -----------------------------------------------------------


async def test_removing_a_part_reaches_what_is_downstream_of_its_whole(client):
    ctx = await make_ctx()
    chain = await seed_chain(ctx.tenant_id)
    v1 = await prd_v1(client, ctx)
    sibling, sibling_ac = await _entities(ctx.tenant_id, 2, prefix="sibling")
    await _edges(ctx.tenant_id, [(sibling, chain["feature"])], type_="part_of")
    await _edges(ctx.tenant_id, [(sibling_ac, sibling)], type_="verifies")
    _, tests_ = await stub_artifact(ctx.tenant_id, v1.document_id, v1.id, kind="acceptance_tests")
    on_sibling_ac = await depend(ctx.tenant_id, artifact_version_id=tests_, entity_id=sibling_ac)

    resp = await client.delete(f"{B}/entities/{chain['requirement']}", headers=ctx.as_("approver"))
    assert resp.status_code == 204, resp.text

    assert (await dependency(ctx.tenant_id, on_sibling_ac)).freshness == "potentially_stale"
    (change,) = [c for c in await _changes(ctx.tenant_id) if c.cause == "entity_deleted"]
    assert any("Saved addresses" in r and "deleted" in r
               for r in _reasons(change, on_sibling_ac))  # fmt: skip


async def test_a_proposed_edge_records_no_change_until_it_is_confirmed(client):
    ctx = await make_ctx()
    chain = await seed_chain(ctx.tenant_id)
    v1 = await prd_v1(client, ctx)
    _, spec = await stub_artifact(ctx.tenant_id, v1.document_id, v1.id)
    on_orphan = await depend(ctx.tenant_id, artifact_version_id=spec, entity_id=chain["orphan"])
    body = {"src_id": str(chain["orphan"]), "dst_id": str(chain["goal"]), "type": "supports",
            "attrs": {"contribution": 1}, "status": "proposed"}  # fmt: skip

    resp = await client.post(f"{B}/edges", json=body, headers=ctx.as_("approver"))
    assert resp.status_code == 201, resp.text
    edge_id = resp.json()["edge"]["id"]
    resp = await client.patch(
        f"{B}/edges/{edge_id}", json={"attrs": {"contribution": 2}}, headers=ctx.as_("approver")
    )
    assert resp.status_code == 200, resp.text
    resp = await client.patch(
        f"{B}/edges/{edge_id}", json={"status": "rejected"}, headers=ctx.as_("approver")
    )
    assert resp.status_code == 200, resp.text
    resp = await client.delete(f"{B}/edges/{edge_id}", headers=ctx.as_("approver"))
    assert resp.status_code == 204, resp.text
    assert [c for c in await _changes(ctx.tenant_id) if c.cause.startswith("edge_")] == []
    assert (await dependency(ctx.tenant_id, on_orphan)).freshness == "fresh"

    # Confirming a proposed edge puts it in the trace: that is a change.
    resp = await client.post(f"{B}/edges", json=body, headers=ctx.as_("approver"))
    edge_id = resp.json()["edge"]["id"]
    resp = await client.patch(
        f"{B}/edges/{edge_id}", json={"status": "confirmed"}, headers=ctx.as_("approver")
    )
    assert resp.status_code == 200, resp.text
    causes = [c.cause for c in await _changes(ctx.tenant_id) if c.cause.startswith("edge_")]
    assert causes == ["edge_updated"]
    assert (await dependency(ctx.tenant_id, on_orphan)).freshness == "potentially_stale"


async def test_a_reconciled_deleted_upstream_stays_settled(client):
    ctx = await make_ctx()
    chain = await seed_chain(ctx.tenant_id)
    v1 = await prd_v1(client, ctx)
    _, spec = await stub_artifact(ctx.tenant_id, v1.document_id, v1.id)
    dep_id = await depend(ctx.tenant_id, artifact_version_id=spec, entity_id=chain["ac"])
    resp = await client.delete(f"{B}/entities/{chain['ac']}", headers=ctx.as_("approver"))
    assert resp.status_code == 204, resp.text
    resp = await client.post(
        ACTIONS,
        json={"action": "reconcile", "artifact_version_id": str(spec),
              "reason": "The criterion was folded into the requirement"},
        headers=ctx.as_("approver"),
    )  # fmt: skip
    assert resp.status_code == 200, resp.text
    dep = await dependency(ctx.tenant_id, dep_id)
    assert dep.freshness == "reconciled"
    assert dep.upstream_entity_id is None and dep.upstream_snapshot["key"] == "pick-saved"
    async with tenant_session(ctx.tenant_id) as s:
        event = await s.scalar(
            select(m.ArtifactReviewEvent).where(
                m.ArtifactReviewEvent.version_id == spec, m.ArtifactReviewEvent.kind == "reconciled"
            )
        )
    (entry,) = event.data["dependencies"]
    assert entry["anchor_before"]["upstream_snapshot"]["key"] == "pick-saved"
    assert entry["retired"] is True

    # An entity made again with the same key is a new entity: the row is not re-anchored
    # on it, and nothing upstream can mark it again.
    resp = await client.post(
        f"{B}/entities",
        json={"type": "acceptance_criterion", "key": "pick-saved", "title": "Pick a saved one"},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 201, resp.text
    new_id = resp.json()["entity"]["id"]
    resp = await client.patch(
        f"{B}/entities/{new_id}", json={"title": "Pick a saved address"},
        headers=ctx.as_("approver"),
    )  # fmt: skip
    assert resp.status_code == 200, resp.text
    dep = await dependency(ctx.tenant_id, dep_id)
    assert dep.freshness == "reconciled" and dep.upstream_entity_id is None
    resp = await client.post(
        ACTIONS,
        json={"action": "reconcile", "artifact_version_id": str(spec), "reason": "Again"},
        headers=ctx.as_("approver"),
    )  # fmt: skip
    assert resp.status_code == 409, resp.text
