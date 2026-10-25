"""Traceability views (§7, §16.6) and the evidence inspector (§16.9).

- A baseline node's trace: the chain up to goals and down to acceptance criteria,
  document sections, artifacts and roadmap items, plus the assumptions, blockers,
  alternatives, experiments, decisions, owners and risks linked to a requirement.
- Goal-to-feature traceability keeps working: a feature serving no confirmed goal is
  flagged, with its prioritization rationale.
- A document version's trace carries its version anchors.
- A section's internal claim-to-source links are inspectable and exported in the
  Sources and data points appendix; the rendered body has no inline citations (O1c).
"""

import re
import uuid

import pytest

import oracle.main  # noqa: F401
from oracle.baseline.models import Entity, Evidence
from oracle.main import app
from oracle.mcp.tools import app_operations
from oracle.sources.models import Source, SourceItem
from oracle.tenancy import tenant_session
from oracle.v2 import models as m
from tests.baseline_helpers import make_ctx
from tests.trace_helpers import DOC, depend, link_section, prd_v1, seed_chain, stub_artifact

TRACE_ROUTES = [
    ("GET", "/v1/documents/{doc}/versions/{n}/trace", "get_version_trace"),
    ("GET", "/v1/documents/{doc}/versions/{n}/evidence", "get_version_evidence"),
    ("GET", "/v1/documents/{doc}/versions/{n}/impact", "get_version_impact"),
    ("POST", "/v1/documents/{doc}/versions/{n}/section-links", "create_section_links"),
    ("DELETE", "/v1/section-links/{item_id}", "delete_section_link"),
    ("GET", "/v1/baseline/entities/{entity_id}/trace", "get_entity_trace"),
    ("GET", "/v1/baseline/entities/{entity_id}/impact", "get_entity_impact"),
    ("GET", "/v1/trace/changes/{change_id}/impact", "get_change_impact"),
    ("GET", "/v1/trace/staleness", "list_stale_outputs"),
    ("POST", "/v1/trace/staleness/actions", "act_on_staleness"),
    ("POST", "/v1/trace/dependencies", "create_artifact_dependencies"),
]


def test_every_trace_route_is_in_openapi_and_an_mcp_tool():
    paths = app.openapi()["paths"]
    ops = {(o.method, o.path): o for o in app_operations(app)}
    for method, path, name in TRACE_ROUTES:
        assert method.lower() in paths[path], path
        op = ops[(method, path)]
        assert not op.excluded, path
        assert op.tool_name == name


def _path(path: str, **kw) -> str:
    for k, v in kw.items():
        path = path.replace("{" + k + "}", str(v))
    return path


async def test_trace_routes_need_auth(client):
    ids = dict(doc=DOC, n=1, item_id=uuid.uuid4(), entity_id=uuid.uuid4(), change_id=uuid.uuid4())
    for method, path, _ in TRACE_ROUTES:
        resp = await client.request(method, _path(path, **ids), json={})
        assert resp.status_code == 401, path


async def test_a_requirement_trace_shows_the_chain_and_its_linked_decisions(client):
    ctx = await make_ctx()
    chain = await seed_chain(ctx.tenant_id)
    v1 = await prd_v1(client, ctx)
    await link_section(
        ctx.tenant_id, v1.document_id, v1.id, "requirements", entity_id=chain["requirement"]
    )
    _, spec = await stub_artifact(ctx.tenant_id, v1.document_id, v1.id)
    await depend(
        ctx.tenant_id, artifact_version_id=spec, upstream_version_id=v1.id,
        section_key="requirements",
    )  # fmt: skip

    resp = await client.get(
        f"/v1/baseline/entities/{chain['requirement']}/trace", headers=ctx.as_("viewer")
    )
    assert resp.status_code == 200, resp.text
    t = resp.json()
    assert t["entity"]["type"] == "requirement"
    # Locked and confirmed nodes keep their protections: reading never unlocks.
    assert t["entity"]["locked"] is True and t["entity"]["status"] == "confirmed"
    up = {(u["entity"]["key"], u["edge_type"]) for u in t["upstream"]}
    assert ("saved-addresses", "part_of") in up
    assert ("faster-repeat-checkout", "derived_from") in up
    assert "repeat-purchase" in {u["entity"]["key"] for u in t["upstream"]}
    assert [g["key"] for g in t["goals"]] == ["repeat-purchase"]
    assert {d["entity"]["key"] for d in t["downstream"]} == {"pick-saved"}
    rel = t["related"]
    assert [e["key"] for e in rel["assumptions"]] == ["buyers-reuse"]
    assert [e["key"] for e in rel["blockers"]] == ["address-api-quota"]
    assert [e["key"] for e in rel["decisions"]] == ["store-in-house"]
    assert [e["key"] for e in rel["risks"]] == ["personal-data"]
    assert [e["key"] for e in rel["owners"]] == ["pm-placeholder"]
    assert [a["title"] for a in rel["alternatives"]] == ["Cache lookups within the published quota"]
    assert [x["hypothesis"] for x in rel["experiments"]] == ["Caching halves quota use"]
    assert [d["decision"] for d in rel["assumption_decisions"]] == ["accept_assumption"]
    assert [(s["document_slug"], s["version_number"], s["section_key"]) for s in t["sections"]] == [
        (DOC, 1, "requirements")
    ]
    assert [o["artifact_version_id"] for o in t["outputs"]] == [str(spec)]
    assert t["flags"] == []

    async with tenant_session(ctx.tenant_id) as s:
        req = await s.get(Entity, chain["requirement"])
        assert req.locked is True and req.status == "confirmed"


async def test_goal_to_feature_traceability_flags_a_feature_serving_no_confirmed_goal(client):
    ctx = await make_ctx()
    chain = await seed_chain(ctx.tenant_id)
    # The existing report still works and flags the orphan feature (F3b).
    report = (await client.get("/v1/baseline/trace", headers=ctx.as_("viewer"))).json()
    flagged = {f["key"]: f["flags"] for f in report["flagged"]}
    assert "serves_no_goal" in flagged["gift-wrap"]
    assert "saved-addresses" not in flagged

    orphan = (
        await client.get(
            f"/v1/baseline/entities/{chain['orphan']}/trace", headers=ctx.as_("viewer")
        )
    ).json()
    assert "serves_no_goal" in orphan["flags"]
    assert orphan["goals"] == []
    # Its prioritization rationale is shown with it.
    assert orphan["priority"]["key"] == "gift-wrap"
    assert orphan["priority"]["serves_goal"] is False
    assert "no_confirmed_goal" in orphan["priority"]["flags"]
    assert orphan["priority"]["explanation"]["formula"]

    served = (
        await client.get(
            f"/v1/baseline/entities/{chain['feature']}/trace", headers=ctx.as_("viewer")
        )
    ).json()
    assert "serves_no_goal" not in served["flags"]
    assert served["priority"]["serves_goal"] is True
    assert [g["key"] for g in served["goals"]] == ["repeat-purchase"]
    # Evidence is ranked by confidence (source ranking).
    assert [e["ref"] for e in served["evidence"]] == ["buyer-interviews.md"]


async def test_an_unconfirmed_goal_does_not_count(client):
    ctx = await make_ctx()
    chain = await seed_chain(ctx.tenant_id, goal_status="proposed")
    t = (
        await client.get(
            f"/v1/baseline/entities/{chain['requirement']}/trace", headers=ctx.as_("viewer")
        )
    ).json()
    assert "serves_no_goal" in t["flags"]


async def test_a_version_trace_carries_its_anchors(client):
    ctx = await make_ctx()
    chain = await seed_chain(ctx.tenant_id)
    v1 = await prd_v1(client, ctx)
    snapshot_id = uuid.uuid4()
    async with tenant_session(ctx.tenant_id) as s:
        comp = m.DocumentComposition(
            document_id=v1.document_id, template="oracle-default", template_version="1",
            current_revision=1,
        )  # fmt: skip
        s.add(comp)
        await s.flush()
        s.add(
            m.CompositionRevision(
                composition_id=comp.id, number=1, status="confirmed", modules=[],
                inputs={"baseline_snapshot_id": str(snapshot_id),
                        "source_snapshot_ids": [str(snapshot_id)]},
                document_version_id=v1.id,
            )
        )  # fmt: skip
        await s.commit()
    await link_section(
        ctx.tenant_id, v1.document_id, v1.id, "requirements", entity_id=chain["requirement"]
    )
    _, spec = await stub_artifact(ctx.tenant_id, v1.document_id, v1.id)
    await depend(
        ctx.tenant_id, artifact_version_id=spec, upstream_version_id=v1.id,
        section_key="requirements",
    )  # fmt: skip

    resp = await client.get(f"/v1/documents/{DOC}/versions/1/trace", headers=ctx.as_("viewer"))
    assert resp.status_code == 200, resp.text
    t = resp.json()
    a = t["anchors"]
    assert a["document_id"] == str(v1.document_id)
    assert a["version_id"] == str(v1.id) and a["number"] == 1
    assert a["template"] == "oracle-default" and a["template_version"] == "1"
    assert a["composition_revision"] == 1
    assert a["baseline_snapshot_id"] == str(snapshot_id)
    assert a["source_snapshot_ids"] == [str(snapshot_id)]
    sections = {s["section_key"]: s for s in t["sections"]}
    req = sections["requirements"]
    assert req["section_hash"]
    assert [e["key"] for e in req["entities"]] == ["save-five"]
    assert [g["key"] for g in req["goals"]] == ["repeat-purchase"]
    assert [d["artifact_version_id"] for d in req["downstream"]] == [str(spec)]
    assert req["downstream"][0]["freshness"] == "fresh"
    assert sections["summary"]["entities"] == []


async def _evidence_setup(client):
    ctx = await make_ctx()
    chain = await seed_chain(ctx.tenant_id)
    v1 = await prd_v1(client, ctx)
    async with tenant_session(ctx.tenant_id) as s:
        weak = Evidence(entity_id=chain["requirement"], ref="forum-post", confidence=0.3)
        strong = Evidence(
            entity_id=chain["requirement"], ref="support-tickets-q3", confidence=0.9,
            excerpt="Address entry is the top checkout complaint",
        )  # fmt: skip
        source = Source(owner_user_id=ctx.users["owner"].id, kind="upload", name="private notes")
        s.add_all([weak, strong, source])
        await s.flush()
        item = SourceItem(
            source_id=source.id, external_id="n1", kind="file", title="Owner-only notes"
        )
        s.add(item)
        await s.commit()
    return ctx, chain, v1, weak.id, strong.id, item.id


async def test_section_links_are_created_by_approvers_on_existing_sections(client):
    ctx, chain, v1, weak, strong, item = await _evidence_setup(client)
    url = f"/v1/documents/{DOC}/versions/1/section-links"
    body = {
        "links": [
            {
                "section_key": "metrics",
                "kind": "claims",
                "precision": "claim",
                "claim": "Repeat checkout takes under a minute",
                "evidence_id": str(weak),
            },
            {
                "section_key": "metrics",
                "kind": "claims",
                "precision": "claim",
                "claim": "Repeat checkout takes under a minute",
                "evidence_id": str(strong),
            },
            {
                "section_key": "requirements",
                "kind": "implements",
                "entity_id": str(chain["decision"]),
            },
        ]
    }
    assert (await client.post(url, json=body, headers=ctx.as_("commenter"))).status_code == 403
    resp = await client.post(url, json=body, headers=ctx.as_("approver"))
    assert resp.status_code == 201, resp.text
    created = resp.json()
    assert len(created) == 3
    assert all(c["version_id"] == str(v1.id) and c["section_hash"] for c in created)

    # A source item: only its owner may link it; to others it does not exist (AUD-9).
    own = {"links": [{"section_key": "metrics", "kind": "evidences", "source_item_id": str(item)}]}
    assert (await client.post(url, json=own, headers=ctx.as_("approver"))).status_code == 422
    resp = await client.post(url, json=own, headers=ctx.as_("owner"))
    assert resp.status_code == 201, resp.text

    for bad in (
        {"section_key": "no-such-section", "kind": "claims", "evidence_id": str(weak)},
        {"section_key": "metrics", "kind": "claims"},
        {"section_key": "metrics", "kind": "claims", "entity_id": str(uuid.uuid4())},
    ):
        resp = await client.post(url, json={"links": [bad]}, headers=ctx.as_("approver"))
        assert resp.status_code == 422, bad

    # Delete one; approvers only.
    one = created[0]["id"]
    assert (
        await client.delete(f"/v1/section-links/{one}", headers=ctx.as_("commenter"))
    ).status_code == 403
    assert (
        await client.delete(f"/v1/section-links/{one}", headers=ctx.as_("approver"))
    ).status_code == 204
    assert (
        await client.delete(f"/v1/section-links/{one}", headers=ctx.as_("approver"))
    ).status_code == 404


async def test_an_approved_versions_evidence_links_are_pinned(client):
    ctx, chain, v1, weak, strong, item = await _evidence_setup(client)
    link = await link_section(
        ctx.tenant_id, v1.document_id, v1.id, "metrics", evidence_id=strong, kind="claims"
    )
    async with tenant_session(ctx.tenant_id) as s:
        from oracle.docs.models import DocumentVersion

        (await s.get(DocumentVersion, v1.id)).approved_at = v1.created_at
        await s.commit()
    body = {"links": [{"section_key": "metrics", "kind": "claims", "evidence_id": str(weak)}]}
    resp = await client.post(
        f"/v1/documents/{DOC}/versions/1/section-links", json=body, headers=ctx.as_("approver")
    )
    assert resp.status_code == 409
    resp = await client.delete(f"/v1/section-links/{link}", headers=ctx.as_("approver"))
    assert resp.status_code == 409


async def test_the_evidence_inspector_shows_each_sections_claim_links(client):
    ctx, chain, v1, weak, strong, item = await _evidence_setup(client)
    claim = "Repeat checkout takes under a minute"
    await link_section(
        ctx.tenant_id, v1.document_id, v1.id, "metrics", evidence_id=weak, kind="claims",
        claim=claim,
    )  # fmt: skip
    await link_section(
        ctx.tenant_id, v1.document_id, v1.id, "metrics", evidence_id=strong, kind="claims",
        claim=claim,
    )  # fmt: skip
    await link_section(
        ctx.tenant_id, v1.document_id, v1.id, "metrics", source_item_id=item, kind="evidences"
    )
    await link_section(
        ctx.tenant_id, v1.document_id, v1.id, "requirements", entity_id=chain["decision"],
        kind="claims", claim="Addresses stay in-house",
    )  # fmt: skip

    resp = await client.get(f"/v1/documents/{DOC}/versions/1/evidence", headers=ctx.as_("viewer"))
    assert resp.status_code == 200, resp.text
    out = resp.json()
    sections = {s["section_key"]: s for s in out["sections"]}
    metrics = sections["metrics"]
    # Ranked: the strongest source first, then weaker, then unscored.
    refs = [link["target"].get("ref") for link in metrics["links"]]
    assert refs[:2] == ["support-tickets-q3", "forum-post"]
    assert metrics["links"][0]["claim"] == claim
    assert metrics["links"][0]["current"] is True
    assert metrics["links"][0]["target"]["confidence"] == 0.9
    # Someone else's source item: the viewer sees that it exists, not what it says.
    restricted = metrics["links"][2]["target"]
    assert restricted["type"] == "source_item" and restricted["restricted"] is True
    assert restricted["title"] is None and restricted["source_kind"] == "upload"
    # Its owner sees it.
    owner_view = (
        await client.get(f"/v1/documents/{DOC}/versions/1/evidence", headers=ctx.as_("owner"))
    ).json()
    owned = {s["section_key"]: s for s in owner_view["sections"]}["metrics"]["links"][2]
    assert owned["target"]["restricted"] is False
    assert owned["target"]["title"] == "Owner-only notes"
    # Decision links and the draft's own per-claim citations ([c:id]) are both there.
    req = sections["requirements"]
    assert req["links"][0]["target"]["entity_type"] == "decision"
    assert [c["cite_key"] for c in req["citations"]] == ["c1"]
    assert req["citations"][0]["title"] == "Buyer interviews"
    one = (
        await client.get(
            f"/v1/documents/{DOC}/versions/1/evidence?section=metrics", headers=ctx.as_("viewer")
        )
    ).json()
    assert [s["section_key"] for s in one["sections"]] == ["metrics"]


async def test_section_links_are_exported_in_the_appendix_never_in_the_body(client):
    ctx, chain, v1, weak, strong, item = await _evidence_setup(client)
    claim = "Repeat checkout takes under a minute"
    await link_section(
        ctx.tenant_id, v1.document_id, v1.id, "metrics", evidence_id=strong, kind="claims",
        claim=claim,
    )  # fmt: skip
    await link_section(
        ctx.tenant_id, v1.document_id, v1.id, "metrics", source_item_id=item, kind="evidences"
    )
    resp = await client.get(
        f"/v1/documents/{DOC}/versions/1/export?format=html", headers=ctx.as_("viewer")
    )
    assert resp.status_code == 200
    html = resp.text
    body = html.split("<main", 1)[1].split("</main>", 1)[0]
    # O1c: no citation markers, chips or evidence in the narrative body.
    assert "[c:" not in body and "src-refs" not in body
    assert "support-tickets-q3" not in body and "evidence-links" not in body
    appendix = html.split("</main>", 1)[1]
    assert 'id="sources-evidence-links"' in appendix
    links = appendix.split('id="sources-evidence-links"', 1)[1]
    assert '<a class="section-link" href="#metrics">Metrics</a>' in links
    assert claim in links and "support-tickets-q3" in links
    # A source item is listed by kind only: its title stays with its owner (AUD-9).
    assert "Owner-only notes" not in html
    assert re.search(r"upload source item", links)


async def test_a_version_without_links_exports_exactly_as_before(client):
    ctx = await make_ctx()
    await prd_v1(client, ctx)
    html = (
        await client.get(
            f"/v1/documents/{DOC}/versions/1/export?format=html", headers=ctx.as_("viewer")
        )
    ).text
    assert "sources-evidence-links" not in html


@pytest.mark.parametrize("who", ["viewer", "owner", "token"])
async def test_trace_views_are_company_scoped(client, who):
    a = await make_ctx("Company A")
    b = await make_ctx("Company B")
    chain = await seed_chain(b.tenant_id)
    v1 = await prd_v1(client, b)
    link = await link_section(
        b.tenant_id, v1.document_id, v1.id, "requirements", entity_id=chain["requirement"]
    )
    for path in (
        f"/v1/documents/{DOC}/versions/1/trace",
        f"/v1/documents/{DOC}/versions/1/evidence",
        f"/v1/baseline/entities/{chain['requirement']}/trace",
    ):
        assert (await client.get(path, headers=a.as_(who))).status_code == 404, path
    if who != "viewer":
        resp = await client.delete(f"/v1/section-links/{link}", headers=a.as_(who))
        assert resp.status_code == 404
        resp = await client.post(
            f"/v1/documents/{v1.document_id}/versions/1/section-links",
            json={"links": [{"section_key": "summary", "kind": "claims",
                             "entity_id": str(chain["requirement"])}]},
            headers=a.as_(who),
        )  # fmt: skip
        assert resp.status_code == 404
    # A's own document cannot point at B's entities.
    await prd_v1(client, a)
    resp = await client.post(
        f"/v1/documents/{DOC}/versions/1/section-links",
        json={"links": [{"section_key": "summary", "kind": "claims",
                         "entity_id": str(chain["requirement"])}]},
        headers=a.as_("approver"),
    )  # fmt: skip
    assert resp.status_code == 422


def test_the_evidence_inspector_needs_read_sources_too_for_a_run_token():
    """Owner, 2026-10-25: the inspector shows source-item titles and links, so a run token
    reads it with read:sources as well as read:documents, as the intake routes."""
    from oracle.mcp import scopes

    path = "/v1/documents/{doc}/versions/{n}/evidence"
    assert scopes.allowed(frozenset({"read:documents", "read:sources"}), "GET", path)
    assert not scopes.allowed(frozenset({"read:documents"}), "GET", path)
    assert not scopes.allowed(frozenset({"read:sources"}), "GET", path)
    # The version's trace and impact carry no source text: read:documents alone.
    for leaf in ("trace", "impact"):
        assert scopes.allowed(
            frozenset({"read:documents"}), "GET", f"/v1/documents/{{doc}}/versions/{{n}}/{leaf}"
        )


async def test_a_run_reads_the_inspector_with_read_sources_and_its_users_items_live(client):
    from tests.test_mcp import mcp_client, run_token, text_of

    ctx, chain, v1, weak, strong, item = await _evidence_setup(client)
    await link_section(
        ctx.tenant_id, v1.document_id, v1.id, "metrics", source_item_id=item, kind="evidences"
    )
    args = {"doc": DOC, "n": 1}
    docs_only = await run_token(ctx.tenant_id, ["read:documents"], ctx.users["owner"].id)
    async with mcp_client(docs_only) as c:
        refused = await c.call_tool("get_version_evidence", args)
        assert refused.is_error and "read:sources" in text_of(refused)
    # A run reads its own user's never-shared item live, title included (no change).
    both = await run_token(
        ctx.tenant_id, ["read:documents", "read:sources"], ctx.users["owner"].id
    )
    async with mcp_client(both) as c:
        ok = await c.call_tool("get_version_evidence", args)
        assert not ok.is_error, text_of(ok)
        assert "Owner-only notes" in text_of(ok)
    # Another user's run sees that it exists, not what it says.
    theirs = await run_token(
        ctx.tenant_id, ["read:documents", "read:sources"], ctx.users["viewer"].id
    )
    async with mcp_client(theirs) as c:
        ok = await c.call_tool("get_version_evidence", args)
        assert not ok.is_error and "Owner-only notes" not in text_of(ok)
