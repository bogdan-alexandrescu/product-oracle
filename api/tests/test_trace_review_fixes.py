"""Review fixes for the trace lane (PR #20): staleness survives an upstream deletion,
a rejection propagates, write-path walks are scoped and flag truncation, edge changes
are recorded, bulk writes record one closure per subject, the staleness list pages,
and the export appendix leaves out rejected items. Synthetic placeholders only."""

import uuid

import pytest
from sqlalchemy import event, func, select

import oracle.main  # noqa: F401  (registers the lanes' change handlers)
from oracle.auth.service import create_api_token
from oracle.baseline.models import Edge, Entity
from oracle.db import get_engine
from oracle.sources import service as sources_service
from oracle.sources.models import Source, SourceItem
from oracle.tenancy import tenant_session
from oracle.trace import graph as graph_mod
from oracle.trace import staleness
from oracle.v2 import models as m
from tests.baseline_helpers import make_ctx, make_item
from tests.test_mcp import mcp_client
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


# -----------------------------------------------------------------------------
# Review fixes for the trace lane, round 2 (PR #26): removing evidence or a source marks
# what was built on it, a source item link survives its source's deletion check, scoped
# walks cap their roots and do not report a cycle as truncation, walks stay in their
# company, a removed part reaches what is downstream of its whole, proposed edges record
# nothing, and a reconciled deleted upstream stays settled. Synthetic placeholders only.


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


# -----------------------------------------------------------------------------
# Review fixes for the trace lane, round 3 (PR #30): deleting a source or removing
# evidence keeps a section link that names another target (its traceability to an entity
# survives, and a later change to that entity still reaches the section); only a link left
# with no target is deleted, and that one is kept on the change. Synthetic placeholders
# only.


async def _changes_fixes3(tenant_id: uuid.UUID, cause: str) -> list[m.ChangeEvent]:
    async with tenant_session(tenant_id) as s:
        rows = await s.scalars(
            select(m.ChangeEvent).where(m.ChangeEvent.cause == cause)
            .order_by(m.ChangeEvent.created_at)
        )  # fmt: skip
        return list(rows.all())


def _snapshotted(change: m.ChangeEvent) -> set[str]:
    return {lk["id"] for lk in change.data["trace"]["links"]}


async def _source_of(tenant_id: uuid.UUID, item_id: uuid.UUID) -> uuid.UUID:
    async with tenant_session(tenant_id) as s:
        return (await s.get(SourceItem, item_id)).source_id


async def _delete_source(client, ctx, source_id: uuid.UUID, via: str) -> None:
    if via == "rest":
        resp = await client.delete(f"/v1/sources/{source_id}", headers=ctx.as_("owner"))
        assert resp.status_code == 204, resp.text
        return
    async with tenant_session(ctx.tenant_id) as s:
        _, raw = await create_api_token(s, "agent", user_id=ctx.users["owner"].id)
        await s.commit()
    async with mcp_client(raw) as c:
        result = await c.call_tool("delete_source", {"source_id": str(source_id)})
    assert not result.is_error, result


async def _remove_evidence(client, ctx, evidence_id: uuid.UUID, via: str) -> None:
    if via == "rest":
        resp = await client.delete(f"{B}/evidence/{evidence_id}", headers=ctx.as_("approver"))
        assert resp.status_code == 204, resp.text
        return
    async with mcp_client(ctx.token) as c:
        result = await c.call_tool("remove_evidence", {"evidence_id": str(evidence_id)})
    assert not result.is_error, result


async def _assert_section_follows(client, ctx, v1, feature: uuid.UUID, section: str) -> None:
    """A dependency on ``section`` made now goes stale when the feature changes: the
    section still links it."""
    _, av = await stub_artifact(ctx.tenant_id, v1.document_id, v1.id, kind="wireframe")
    dep_id = await depend(
        ctx.tenant_id, artifact_version_id=av, upstream_version_id=v1.id, section_key=section
    )
    resp = await client.patch(
        f"{B}/entities/{feature}", json={"title": "Saved delivery addresses"},
        headers=ctx.as_("approver"),
    )  # fmt: skip
    assert resp.status_code == 200, resp.text
    dep = await dependency(ctx.tenant_id, dep_id)
    assert dep.freshness == "potentially_stale"
    async with tenant_session(ctx.tenant_id) as s:
        change = await s.get(m.ChangeEvent, dep.caused_by_change_id)
    assert change.subject_id == feature
    marked = {x["id"]: x for x in change.data["trace"]["marked"]}
    assert any(
        # qa-plan-10: the feature by its title, never its baseline key.
        section in r
        and ("links Saved delivery addresses" in r or "links Saved addresses" in r)
        and "feature saved-addresses" not in r
        for r in marked[str(dep_id)]["reasons"]
    ), marked[str(dep_id)]["reasons"]


# --- MAJOR: a link that names an entity survives its source's deletion ------------------------


@pytest.mark.parametrize("via", ["rest", "mcp"])
async def test_a_link_naming_an_entity_survives_its_sources_deletion(client, via):
    ctx = await make_ctx()
    chain = await seed_chain(ctx.tenant_id)
    v1 = await prd_v1(client, ctx)
    item_id = await make_item(ctx, "owner")
    both = await link_section(
        ctx.tenant_id, v1.document_id, v1.id, "sources", entity_id=chain["feature"],
        source_item_id=item_id, kind="implements",
    )  # fmt: skip
    item_only = await link_section(
        ctx.tenant_id, v1.document_id, v1.id, "sources", source_item_id=item_id, kind="evidences"
    )

    await _delete_source(client, ctx, await _source_of(ctx.tenant_id, item_id), via)

    kept = await _link(ctx.tenant_id, both)
    assert kept is not None
    assert kept.entity_id == chain["feature"] and kept.source_item_id is None
    assert await _link(ctx.tenant_id, item_only) is None
    (change,) = await _changes_fixes3(ctx.tenant_id, "source_deleted")
    # Only what was deleted is kept on the change; the surviving link is still in the table.
    assert _snapshotted(change) == {str(item_only)}
    await _assert_section_follows(client, ctx, v1, chain["feature"], "sources")


async def test_a_link_naming_evidence_keeps_it_when_the_source_goes(client):
    """Evidence outlives its source item (its excerpt was copied): a link naming both
    keeps the evidence."""
    ctx = await make_ctx()
    chain = await seed_chain(ctx.tenant_id)
    v1 = await prd_v1(client, ctx)
    item_id = await make_item(ctx, "owner")
    resp = await client.post(
        f"{B}/entities/{chain['feature']}/evidence",
        json={"source_item_id": str(item_id)},
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 201, resp.text
    evidence_id = uuid.UUID(resp.json()["id"])
    link = await link_section(
        ctx.tenant_id, v1.document_id, v1.id, "sources", evidence_id=evidence_id,
        source_item_id=item_id, kind="evidences",
    )  # fmt: skip

    await _delete_source(client, ctx, await _source_of(ctx.tenant_id, item_id), "rest")

    kept = await _link(ctx.tenant_id, link)
    assert kept is not None
    assert kept.evidence_id == evidence_id and kept.source_item_id is None
    (change,) = await _changes_fixes3(ctx.tenant_id, "source_deleted")
    assert _snapshotted(change) == set()


async def test_an_item_only_link_is_deleted_with_its_source(client):
    """Called directly (no request rollback to hide it): no IntegrityError from the
    link's target check, and the link is gone."""
    ctx = await make_ctx()
    v1 = await prd_v1(client, ctx)
    item_id = await make_item(ctx, "owner")
    link = await link_section(
        ctx.tenant_id, v1.document_id, v1.id, "sources", source_item_id=item_id, kind="mentions"
    )
    async with tenant_session(ctx.tenant_id) as s:
        source = await s.get(Source, await _source_of(ctx.tenant_id, item_id))
        await sources_service.delete_source(s, source, actor="test")
    assert await _link(ctx.tenant_id, link) is None
    async with tenant_session(ctx.tenant_id) as s:
        assert await s.get(SourceItem, item_id) is None


# --- the same for removed evidence --------------------------------------------------------------


@pytest.mark.parametrize("via", ["rest", "mcp"])
async def test_a_link_naming_an_entity_survives_its_evidences_removal(client, via):
    ctx = await make_ctx()
    chain = await seed_chain(ctx.tenant_id)
    v1 = await prd_v1(client, ctx)
    resp = await client.post(
        f"{B}/entities/{chain['feature']}/evidence",
        json={"ref": "checkout-notes.md", "excerpt": "Buyers retype their address"},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 201, resp.text
    evidence_id = uuid.UUID(resp.json()["id"])
    both = await link_section(
        ctx.tenant_id, v1.document_id, v1.id, "sources", entity_id=chain["feature"],
        evidence_id=evidence_id, kind="implements",
    )  # fmt: skip
    evidence_only = await link_section(
        ctx.tenant_id, v1.document_id, v1.id, "sources", evidence_id=evidence_id,
        kind="evidences",
    )  # fmt: skip

    await _remove_evidence(client, ctx, evidence_id, via)

    kept = await _link(ctx.tenant_id, both)
    assert kept is not None
    assert kept.entity_id == chain["feature"] and kept.evidence_id is None
    assert await _link(ctx.tenant_id, evidence_only) is None
    (change,) = await _changes_fixes3(ctx.tenant_id, "evidence_deleted")
    assert _snapshotted(change) == {str(evidence_only)}
    await _assert_section_follows(client, ctx, v1, chain["feature"], "sources")
