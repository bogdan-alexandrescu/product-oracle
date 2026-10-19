"""Review fixes for the trace lane (PR #20): staleness survives an upstream deletion,
a rejection propagates, write-path walks are scoped and flag truncation, edge changes
are recorded, bulk writes record one closure per subject, the staleness list pages,
and the export appendix leaves out rejected items. Synthetic placeholders only."""

import uuid

from sqlalchemy import event, func, select

import oracle.main  # noqa: F401  (registers the lanes' change handlers)
from oracle.baseline.models import Edge, Entity
from oracle.db import get_engine
from oracle.tenancy import tenant_session
from oracle.trace import graph as graph_mod
from oracle.v2 import models as m
from tests.baseline_helpers import make_ctx
from tests.trace_helpers import (
    DOC,
    PRD_V2,
    artifact_version,
    depend,
    dependency,
    import_md,
    link_section,
    prd_v1,
    seed_chain,
    stub_artifact,
    version_row,
)

ACTIONS = "/v1/trace/staleness/actions"
B = "/v1/baseline"


async def _changes(tenant_id: uuid.UUID) -> list[m.ChangeEvent]:
    async with tenant_session(tenant_id) as s:
        return list(
            (await s.scalars(select(m.ChangeEvent).order_by(m.ChangeEvent.created_at))).all()
        )


# --- MAJOR 1: a deleted upstream leaves its dependants potentially stale ----------------------


async def test_deleting_an_entity_keeps_its_dependants_stale_with_a_deleted_cause(client):
    ctx = await make_ctx()
    chain = await seed_chain(ctx.tenant_id)
    v1 = await prd_v1(client, ctx)
    await link_section(
        ctx.tenant_id, v1.document_id, v1.id, "requirements", entity_id=chain["requirement"]
    )
    _, spec = await stub_artifact(ctx.tenant_id, v1.document_id, v1.id)
    _, wire = await stub_artifact(ctx.tenant_id, v1.document_id, v1.id, kind="wireframe")
    # The spec depends only on the requirement; the wireframe on the section linking it.
    only = await depend(ctx.tenant_id, artifact_version_id=spec, entity_id=chain["requirement"])
    on_section = await depend(
        ctx.tenant_id, artifact_version_id=wire, upstream_version_id=v1.id,
        section_key="requirements",
    )  # fmt: skip

    resp = await client.delete(f"{B}/entities/{chain['requirement']}", headers=ctx.as_("approver"))
    assert resp.status_code == 204, resp.text

    dep = await dependency(ctx.tenant_id, only)
    assert dep is not None, "the dependency row survives its upstream's deletion"
    assert dep.freshness == "potentially_stale"
    assert dep.upstream_entity_id is None
    assert dep.upstream_deleted_at is not None
    assert dep.upstream_snapshot["key"] == "save-five"
    assert dep.upstream_snapshot["type"] == "requirement"
    assert dep.upstream_snapshot["id"] == str(chain["requirement"])
    assert (await artifact_version(ctx.tenant_id, spec)).freshness == "potentially_stale"
    assert (await dependency(ctx.tenant_id, on_section)).freshness == "potentially_stale"
    async with tenant_session(ctx.tenant_id) as s:
        cause = await s.get(m.ChangeEvent, dep.caused_by_change_id)
    assert cause.cause == "entity_deleted"
    marked = {x["id"]: x for x in cause.data["trace"]["marked"]}
    assert any("deleted" in r for r in marked[str(only)]["reasons"])
    assert any("deleted" in r for r in marked[str(on_section)]["reasons"])

    # The staleness list shows it, with what it pointed at and why.
    page = (await client.get("/v1/trace/staleness", headers=ctx.as_("viewer"))).json()
    out = next(o for o in page["items"] if o["artifact_version_id"] == str(spec))
    assert out["freshness"] == "potentially_stale"
    (d,) = out["dependencies"]
    assert d["upstream"]["deleted"] is True
    assert d["upstream"]["entity"]["key"] == "save-five"
    assert d["caused_by_change_id"] == str(cause.id)
    assert any("deleted" in r for r in out["reasons"])
    impact = (
        await client.get(f"/v1/trace/changes/{cause.id}/impact", headers=ctx.as_("viewer"))
    ).json()
    assert str(spec) in {o["artifact_version_id"] for o in impact["affected"]}
    assert impact["subject"]["title"] == "Save up to five addresses"

    # The review action works on it, and so does reconciling.
    body = {"action": "review", "artifact_version_id": str(spec)}
    resp = await client.post(ACTIONS, json=body, headers=ctx.as_("approver"))
    assert resp.status_code == 200, resp.text
    assert resp.json()["freshness"] == "under_review"
    resp = await client.post(
        ACTIONS,
        json={"action": "reconcile", "artifact_version_id": str(spec),
              "reason": "The spec no longer relies on the removed requirement"},
        headers=ctx.as_("approver"),
    )  # fmt: skip
    assert resp.status_code == 200, resp.text
    assert (await dependency(ctx.tenant_id, only)).freshness == "reconciled"


# --- MAJOR 2: a rejection propagates downstream ------------------------------------------------


async def test_rejecting_an_entity_marks_its_criteria_features_sections_and_outputs(client):
    ctx = await make_ctx()
    chain = await seed_chain(ctx.tenant_id)
    v1 = await prd_v1(client, ctx)
    await link_section(
        ctx.tenant_id, v1.document_id, v1.id, "requirements", entity_id=chain["requirement"]
    )
    await link_section(ctx.tenant_id, v1.document_id, v1.id, "metrics", entity_id=chain["ac"])
    outputs = {}
    for kind in ("engineering_spec", "acceptance_tests", "wireframe", "prototype"):
        _, outputs[kind] = await stub_artifact(ctx.tenant_id, v1.document_id, v1.id, kind=kind)
    on_req = await depend(
        ctx.tenant_id, artifact_version_id=outputs["engineering_spec"],
        entity_id=chain["requirement"],
    )  # fmt: skip
    on_ac = await depend(
        ctx.tenant_id, artifact_version_id=outputs["acceptance_tests"], entity_id=chain["ac"]
    )
    on_feature = await depend(
        ctx.tenant_id, artifact_version_id=outputs["wireframe"], entity_id=chain["feature"]
    )
    on_ac_section = await depend(
        ctx.tenant_id, artifact_version_id=outputs["prototype"], upstream_version_id=v1.id,
        section_key="metrics",
    )  # fmt: skip

    resp = await client.post(
        f"{B}/entities/{chain['requirement']}/reject", headers=ctx.as_("approver")
    )
    assert resp.status_code == 200, resp.text

    for dep_id in (on_req, on_ac, on_feature, on_ac_section):
        assert (await dependency(ctx.tenant_id, dep_id)).freshness == "potentially_stale"
    for version_id in outputs.values():
        assert (await artifact_version(ctx.tenant_id, version_id)).freshness == "potentially_stale"
    (change,) = [c for c in await _changes(ctx.tenant_id) if c.cause == "entity_rejected"]
    reached = set(change.data["trace"]["entity_ids"])
    assert {str(chain["ac"]), str(chain["feature"])} <= reached
    reasons = [r for x in change.data["trace"]["marked"] for r in x["reasons"]]
    assert any("rejected" in r for r in reasons)


# --- MAJOR 3: scoped walks, truncation, bulk writes, paging, the version trace N+1 -------------


async def test_the_write_path_walks_only_the_neighbourhood_of_the_change(client):
    ctx = await make_ctx()
    chain = await seed_chain(ctx.tenant_id)
    async with tenant_session(ctx.tenant_id) as s:
        g = await graph_mod.load_around(s, [chain["requirement"]], up=False, down=True)
    assert chain["ac"] in g.entities and chain["requirement"] in g.entities
    # Upstream items and unrelated features are not loaded for a downstream closure.
    assert chain["orphan"] not in g.entities
    assert chain["goal"] not in g.entities
    assert g.truncated is False


async def test_a_walk_that_hits_the_node_limit_is_flagged_and_recorded(client, monkeypatch):
    ctx = await make_ctx()
    chain = await seed_chain(ctx.tenant_id)
    monkeypatch.setattr(graph_mod, "MAX_NODES", 2)
    resp = await client.patch(
        f"{B}/entities/{chain['outcome']}",
        json={"title": "Much faster repeat checkout", "origin": "user"},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 200, resp.text
    (change,) = [c for c in await _changes(ctx.tenant_id) if c.subject_id == chain["outcome"]]
    assert change.data["trace"]["truncated"] is True
    impact = (
        await client.get(f"/v1/baseline/entities/{chain['outcome']}/impact",
                         headers=ctx.as_("viewer"))
    ).json()  # fmt: skip
    assert impact["truncated"] is True
    trace = (
        await client.get(f"/v1/baseline/entities/{chain['outcome']}/trace",
                         headers=ctx.as_("viewer"))
    ).json()  # fmt: skip
    assert trace["truncated"] is True
    monkeypatch.setattr(graph_mod, "MAX_NODES", 2000)
    resp = await client.patch(
        f"{B}/entities/{chain['outcome']}",
        json={"title": "Faster repeat checkout again", "origin": "user"},
        headers=ctx.as_("approver"),
    )
    last = (await _changes(ctx.tenant_id))[-1]
    assert last.data["trace"]["truncated"] is False


BULK = """\
version: 1
entities:
  - type: outcome
    key: faster-repeat-checkout
    title: Much faster repeat checkout
  - type: feature
    key: saved-addresses
    title: Saved and named addresses
    attrs: {effort: 2, confidence: 0.8}
  - type: acceptance_criterion
    key: pick-saved
    title: Pick a saved address in one tap
  - type: decision
    key: store-in-house
    title: Store addresses in-house, encrypted
"""


async def test_a_bulk_import_records_one_closure_per_subject_kind(client):
    ctx = await make_ctx()
    chain = await seed_chain(ctx.tenant_id)
    v1 = await prd_v1(client, ctx)
    _, spec = await stub_artifact(ctx.tenant_id, v1.document_id, v1.id)
    on_ac = await depend(ctx.tenant_id, artifact_version_id=spec, entity_id=chain["ac"])
    before = len(await _changes(ctx.tenant_id))

    resp = await client.post(
        f"{B}/yaml", content=BULK.encode(),
        headers={**ctx.as_("owner"), "Content-Type": "application/yaml"},
    )  # fmt: skip
    assert resp.status_code == 200, resp.text

    new = (await _changes(ctx.tenant_id))[before:]
    kinds = [c.subject_kind for c in new]
    assert sorted(kinds) == ["decision", "entity"], kinds
    entity_change = next(c for c in new if c.subject_kind == "entity")
    assert sorted(entity_change.data["entity_ids"]) == sorted(
        str(chain[k]) for k in ("outcome", "feature", "ac")
    )
    assert entity_change.subject_id is None
    assert "trace.mark_stale" in entity_change.handled_by
    dep = await dependency(ctx.tenant_id, on_ac)
    assert dep.freshness == "potentially_stale"
    # The criterion changed itself, and the decision affects its requirement: both
    # events marked it, the later one is its cause.
    assert str(on_ac) in entity_change.data["trace"]["dependency_ids"]
    assert dep.caused_by_change_id in {c.id for c in new}


async def test_the_staleness_list_pages_and_explains_each_output(client):
    ctx = await make_ctx()
    v1 = await prd_v1(client, ctx)
    ids = []
    for kind in ("engineering_spec", "wireframe", "acceptance_tests"):
        _, av = await stub_artifact(ctx.tenant_id, v1.document_id, v1.id, kind=kind)
        await depend(
            ctx.tenant_id, artifact_version_id=av, upstream_version_id=v1.id,
            section_key="requirements",
        )  # fmt: skip
        ids.append(str(av))
    _, fresh = await stub_artifact(ctx.tenant_id, v1.document_id, v1.id, kind="prototype")
    await depend(
        ctx.tenant_id, artifact_version_id=fresh, upstream_version_id=v1.id, section_key="metrics"
    )
    assert (await import_md(client, ctx.as_("approver"), PRD_V2)).status_code == 201

    first = (await client.get("/v1/trace/staleness?limit=2", headers=ctx.as_("viewer"))).json()
    assert first["total"] == 3 and first["limit"] == 2 and first["offset"] == 0
    assert len(first["items"]) == 2 and first["next_offset"] == 2
    rest = (
        await client.get("/v1/trace/staleness?limit=2&offset=2", headers=ctx.as_("viewer"))
    ).json()
    assert len(rest["items"]) == 1 and rest["next_offset"] is None
    listed = [o["artifact_version_id"] for o in first["items"] + rest["items"]]
    assert sorted(listed) == sorted(ids)
    for out in first["items"] + rest["items"]:
        assert out["freshness"] == "potentially_stale"
        assert out["dependencies"][0]["upstream"]["section_key"] == "requirements"
        assert any("requirements" in r for r in out["reasons"])
    doc = await version_row(ctx.tenant_id, 1)
    filtered = (
        await client.get(
            f"/v1/trace/staleness?document_id={doc.document_id}&freshness=fresh",
            headers=ctx.as_("viewer"),
        )
    ).json()
    assert [o["artifact_version_id"] for o in filtered["items"]] == [str(fresh)]
    assert (
        await client.get("/v1/trace/staleness?limit=0", headers=ctx.as_("viewer"))
    ).status_code == 422


async def _count_queries(coro) -> int:
    n = 0

    def count(*_args, **_kw):
        nonlocal n
        n += 1

    engine = get_engine().sync_engine
    event.listen(engine, "before_cursor_execute", count)
    try:
        await coro
    finally:
        event.remove(engine, "before_cursor_execute", count)
    return n


async def test_the_version_trace_query_count_does_not_grow_with_sections(client):
    ctx = await make_ctx()
    chain = await seed_chain(ctx.tenant_id)
    v1 = await prd_v1(client, ctx)
    _, spec = await stub_artifact(ctx.tenant_id, v1.document_id, v1.id)
    await depend(
        ctx.tenant_id, artifact_version_id=spec, upstream_version_id=v1.id, section_key="summary"
    )
    await link_section(
        ctx.tenant_id, v1.document_id, v1.id, "summary", entity_id=chain["requirement"]
    )
    url = f"/v1/documents/{DOC}/versions/1/trace"
    few = await _count_queries(client.get(url, headers=ctx.as_("viewer")))
    for key in ("requirements", "metrics", "risks"):
        _, av = await stub_artifact(ctx.tenant_id, v1.document_id, v1.id, kind="wireframe")
        await depend(
            ctx.tenant_id, artifact_version_id=av, upstream_version_id=v1.id, section_key=key
        )
        await link_section(ctx.tenant_id, v1.document_id, v1.id, key, entity_id=chain["ac"])
    many = await _count_queries(client.get(url, headers=ctx.as_("viewer")))
    assert many == few
    trace = (await client.get(url, headers=ctx.as_("viewer"))).json()
    by_key = {s["section_key"]: s for s in trace["sections"]}
    for key in ("summary", "requirements", "metrics", "risks"):
        assert len(by_key[key]["downstream"]) == 1, key
    assert by_key["summary"]["goals"][0]["key"] == "repeat-purchase"


# --- minors ---------------------------------------------------------------------------------


async def test_creating_removing_and_reparenting_an_edge_records_a_change(client):
    ctx = await make_ctx()
    chain = await seed_chain(ctx.tenant_id)
    v1 = await prd_v1(client, ctx)
    _, spec = await stub_artifact(ctx.tenant_id, v1.document_id, v1.id)
    _, wire = await stub_artifact(ctx.tenant_id, v1.document_id, v1.id, kind="wireframe")
    _, tests_ = await stub_artifact(ctx.tenant_id, v1.document_id, v1.id, kind="acceptance_tests")
    on_old = await depend(ctx.tenant_id, artifact_version_id=spec, entity_id=chain["feature"])
    on_new = await depend(ctx.tenant_id, artifact_version_id=wire, entity_id=chain["orphan"])
    on_ac = await depend(ctx.tenant_id, artifact_version_id=tests_, entity_id=chain["ac"])
    async with tenant_session(ctx.tenant_id) as s:
        part_of = await s.scalar(
            select(Edge.id).where(Edge.src_id == chain["requirement"], Edge.type == "part_of")
        )

    # Re-parent: the requirement moves from one feature to another.
    resp = await client.delete(f"{B}/edges/{part_of}", headers=ctx.as_("approver"))
    assert resp.status_code == 204, resp.text
    resp = await client.post(
        f"{B}/edges",
        json={"src_id": str(chain["requirement"]), "dst_id": str(chain["orphan"]),
              "type": "part_of"},
        headers=ctx.as_("approver"),
    )  # fmt: skip
    assert resp.status_code == 201, resp.text
    edge_id = resp.json()["edge"]["id"]
    resp = await client.patch(
        f"{B}/edges/{edge_id}", json={"status": "rejected"}, headers=ctx.as_("approver")
    )
    assert resp.status_code == 200, resp.text

    edge_changes = [c for c in await _changes(ctx.tenant_id) if c.cause.startswith("edge_")]
    causes = [(c.cause, c.subject_kind, c.subject_id) for c in edge_changes]
    assert causes == [
        ("edge_deleted", "requirement", chain["requirement"]),
        ("edge_created", "requirement", chain["requirement"]),
        ("edge_updated", "requirement", chain["requirement"]),
    ]
    for dep_id in (on_old, on_new, on_ac):
        assert (await dependency(ctx.tenant_id, dep_id)).freshness == "potentially_stale"
    assert edge_changes[0].data["edge"]["type"] == "part_of"


async def test_an_owner_edge_records_no_content_change(client):
    ctx = await make_ctx()
    chain = await seed_chain(ctx.tenant_id)
    resp = await client.post(
        f"{B}/edges",
        json={"src_id": str(chain["feature"]), "dst_id": str(chain["owner"]),
              "type": "owned_by"},
        headers=ctx.as_("approver"),
    )  # fmt: skip
    assert resp.status_code == 201, resp.text
    assert [c for c in await _changes(ctx.tenant_id) if c.cause.startswith("edge_")] == []


async def test_an_entity_change_reaches_links_made_on_a_newer_version(client):
    ctx = await make_ctx()
    chain = await seed_chain(ctx.tenant_id)
    v1 = await prd_v1(client, ctx)
    _, spec = await stub_artifact(ctx.tenant_id, v1.document_id, v1.id)
    # Built from v1's metrics section, which v2 does not change.
    dep = await depend(
        ctx.tenant_id, artifact_version_id=spec, upstream_version_id=v1.id, section_key="metrics"
    )
    assert (await import_md(client, ctx.as_("approver"), PRD_V2)).status_code == 201
    v2 = await version_row(ctx.tenant_id, 2)
    assert (await dependency(ctx.tenant_id, dep)).freshness == "fresh"
    # The link is made on v2, later than the dependency's anchor.
    await link_section(ctx.tenant_id, v2.document_id, v2.id, "metrics", entity_id=chain["ac"])

    resp = await client.patch(
        f"{B}/entities/{chain['ac']}",
        json={"title": "Pick a saved address in one tap", "origin": "user"},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 200, resp.text
    assert (await dependency(ctx.tenant_id, dep)).freshness == "potentially_stale"


async def test_dependencies_cannot_cross_companies(client):
    a = await make_ctx("Company A")
    b = await make_ctx("Company B")
    chain_b = await seed_chain(b.tenant_id)
    v1_b = await prd_v1(client, b)
    _, theirs = await stub_artifact(b.tenant_id, v1_b.document_id, v1_b.id)
    v1_a = await prd_v1(client, a)
    _, ours = await stub_artifact(a.tenant_id, v1_a.document_id, v1_a.id)
    url = "/v1/trace/dependencies"

    # Another company's output: it does not exist.
    resp = await client.post(
        url,
        json={"artifact_version_id": str(theirs),
              "upstream": [{"version_id": str(v1_a.id), "section_key": "summary"}]},
        headers=a.as_("owner"),
    )  # fmt: skip
    assert resp.status_code == 404
    resp = await client.post(
        url,
        json={"document_version_id": str(v1_b.id), "upstream": [{"version_id": str(v1_a.id)}]},
        headers=a.as_("owner"),
    )
    assert resp.status_code == 404
    # Another company's upstream (entity or version) is unknown.
    for upstream in (
        {"entity_id": str(chain_b["requirement"])},
        {"version_id": str(v1_b.id)},
        {"version_id": str(v1_b.id), "section_key": "summary"},
    ):
        resp = await client.post(
            url, json={"artifact_version_id": str(ours), "upstream": [upstream]},
            headers=a.as_("owner"),
        )  # fmt: skip
        assert resp.status_code == 422, upstream
    async with tenant_session(b.tenant_id) as s:
        n = await s.scalar(select(func.count()).select_from(m.ArtifactDependency))
    assert n == 0
    async with tenant_session(a.tenant_id) as s:
        n = await s.scalar(select(func.count()).select_from(m.ArtifactDependency))
    assert n == 0


async def _export(client, ctx) -> str:
    resp = await client.get(
        f"/v1/documents/{DOC}/versions/1/export?format=html", headers=ctx.as_("viewer")
    )
    assert resp.status_code == 200
    return resp.text.split('id="sources-evidence-links"', 1)[1]


async def test_the_appendix_leaves_out_rejected_items(client):
    ctx = await make_ctx()
    chain = await seed_chain(ctx.tenant_id)
    v1 = await prd_v1(client, ctx)
    await link_section(
        ctx.tenant_id, v1.document_id, v1.id, "metrics", entity_id=chain["decision"],
        kind="claims", claim="Repeat checkout takes under a minute",
    )  # fmt: skip
    await link_section(
        ctx.tenant_id, v1.document_id, v1.id, "metrics", entity_id=chain["orphan"], kind="claims"
    )
    async with tenant_session(ctx.tenant_id) as s:
        (await s.get(Entity, chain["orphan"])).status = "rejected"
        await s.commit()
    links = await _export(client, ctx)
    assert "Store addresses in-house" in links
    assert "Gift wrap" not in links


async def test_document_wide_links_are_exported_under_their_section(client):
    ctx = await make_ctx()
    chain = await seed_chain(ctx.tenant_id)
    v1 = await prd_v1(client, ctx)
    async with tenant_session(ctx.tenant_id) as s:
        s.add(
            m.DocumentSectionLink(
                document_id=v1.document_id, version_id=None, section_key="risks",
                kind="claims", entity_id=chain["risk"], precision="section",
            )
        )  # fmt: skip
        # A document-wide link may name its section by stable reference (slug#key).
        s.add(
            m.DocumentSectionLink(
                document_id=v1.document_id, version_id=None, section_key=f"{DOC}#metrics",
                kind="claims", entity_id=chain["decision"], precision="section",
            )
        )  # fmt: skip
        await s.commit()
    links = await _export(client, ctx)
    metrics = links.split('href="#metrics"', 1)[1]
    assert "Store addresses in-house" in metrics.split("section-link", 1)[0]
    inspector = (
        await client.get(f"/v1/documents/{DOC}/versions/1/evidence", headers=ctx.as_("viewer"))
    ).json()
    by_key = {s["section_key"]: s for s in inspector["sections"]}
    assert [lk["target"]["title"] for lk in by_key["metrics"]["links"]] == [
        "Store addresses in-house"
    ]
    risks = links.split('href="#risks"', 1)[1]
    assert "Personal data exposure" in risks.split("section-link", 1)[0]
