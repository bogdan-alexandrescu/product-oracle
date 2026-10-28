"""Module catalogue and composition routes: roles, company scoping, audit, change events,
publishing, and MCP parity."""

import uuid

import pytest
from sqlalchemy import select

from oracle import changes
from oracle.main import app
from oracle.mcp.tools import app_operations
from oracle.models import AuditEvent
from oracle.modules.catalog import builtin_contracts, builtin_packs
from oracle.tenancy import tenant_session
from oracle.v2.models import ChangeEvent, CompositionRevision, ProductIntake
from tests.modules.helpers import draft, import_md, seeded_ctx

SLUG = "placeholder-platform"
PLATFORM = {
    "category": "ai_agent_platform",
    "scope": {"capabilities": ["tool_use", "memory"]},
    "signals": {"tenant_count": 12},
}

ROUTES = [
    ("GET", "/v1/module-catalog"),
    ("GET", "/v1/module-catalog/risks.register"),
    ("POST", "/v1/module-catalog"),
    ("POST", "/v1/module-catalog/risks.register/versions"),
    ("GET", "/v1/module-packs"),
    ("GET", "/v1/module-policy"),
    ("PUT", "/v1/module-policy"),
    ("GET", "/v1/template-manifests/one-pager"),
    ("PUT", "/v1/template-manifests/one-pager"),
    ("POST", "/v1/compositions/recommend"),
    ("GET", f"/v1/documents/{SLUG}/composition"),
    ("POST", f"/v1/documents/{SLUG}/composition/revisions"),
    ("POST", f"/v1/documents/{SLUG}/composition/publish"),
]
OPERATIONS = {
    ("GET", "/v1/module-catalog"): "list_module_catalog",
    ("GET", "/v1/module-catalog/{key}"): "get_module_catalog_entry",
    ("POST", "/v1/module-catalog"): "create_company_module",
    ("POST", "/v1/module-catalog/{key}/versions"): "create_module_override",
    ("GET", "/v1/module-packs"): "list_module_packs",
    ("GET", "/v1/module-policy"): "get_module_policy",
    ("PUT", "/v1/module-policy"): "put_module_policy",
    ("GET", "/v1/template-manifests/{template}"): "get_template_manifest",
    ("PUT", "/v1/template-manifests/{template}"): "put_template_manifest",
    ("POST", "/v1/compositions/recommend"): "recommend_composition",
    ("GET", "/v1/documents/{doc}/composition"): "get_document_composition",
    ("POST", "/v1/documents/{doc}/composition/revisions"): "confirm_composition_revision",
    ("POST", "/v1/documents/{doc}/composition/publish"): "publish_composition",
}


async def _doc(client, ctx, slug=SLUG, template="oracle-default"):
    resp = await import_md(client, ctx.as_("approver"), slug, draft(template, slug))
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _confirm(client, ctx, who="approver", slug=SLUG, **body):
    body.setdefault("reason", "First composition")
    body.setdefault("base_revision", None)
    return await client.post(
        f"/v1/documents/{slug}/composition/revisions", json=body, headers=ctx.as_(who)
    )


def test_every_route_is_an_mcp_tool():
    ops = {(o.method, o.path): o for o in app_operations(app)}
    for key, tool in OPERATIONS.items():
        assert key in ops, key
        assert not ops[key].excluded and ops[key].tool_name == tool


@pytest.mark.parametrize(("method", "path"), ROUTES)
async def test_routes_require_auth(client, method, path):
    resp = await client.request(method, path, json={})
    assert resp.status_code == 401


async def test_a_viewer_reads_the_catalogue_packs_policy_and_manifests(client):
    ctx = await seeded_ctx()
    viewer = ctx.as_("viewer")
    catalogue = (await client.get("/v1/module-catalog", headers=viewer)).json()
    assert len(catalogue) == len(builtin_contracts())
    assert {m["origin"] for m in catalogue} == {"builtin"}
    assert (
        len((await client.get("/v1/module-catalog?pack=startup.standard", headers=viewer)).json())
        == 17
    )
    one = (await client.get("/v1/module-catalog/constraints.solutions", headers=viewer)).json()
    assert (
        one["contract"]["id"] == "constraints.solutions"
        and one["versions"][0]["version"] == "1.0.0"
    )
    assert (await client.get("/v1/module-catalog/no.such", headers=viewer)).status_code == 404
    packs = (await client.get("/v1/module-packs", headers=viewer)).json()
    assert [p["id"] for p in packs] == list(builtin_packs())
    policy = (await client.get("/v1/module-policy", headers=viewer)).json()
    assert policy["is_default"] and policy["required"] == []
    manifest = (await client.get("/v1/template-manifests/one-pager", headers=viewer)).json()
    assert not manifest["edited"]
    assert "brief-items" in manifest["unmapped_sections"]
    assert {m["module_key"] for m in manifest["modules"]} >= {
        "risks.register",
        "sources.data-points",
    }


async def test_writes_need_their_roles(client):
    ctx = await seeded_ctx()
    await _doc(client, ctx)
    contract = {"id": "company.extra", "version": "1.0.0", "title": "Extra", "policy": "optional"}
    for who in ("viewer", "commenter", "approver"):
        assert (
            await client.put("/v1/module-policy", json={}, headers=ctx.as_(who))
        ).status_code == 403
        resp = await client.post(
            "/v1/module-catalog", json={"contract": contract}, headers=ctx.as_(who)
        )
        assert resp.status_code == 403
    for who in ("viewer", "commenter"):
        assert (await _confirm(client, ctx, who)).status_code == 403
        resp = await client.put(
            "/v1/template-manifests/one-pager",
            json={"modules": [{"module_key": "risks.register", "policy": "optional"}]},
            headers=ctx.as_(who),
        )
        assert resp.status_code == 403
    # Viewers may ask for a recommendation: it changes nothing.
    resp = await client.post(
        "/v1/compositions/recommend", json={"document": SLUG}, headers=ctx.as_("viewer")
    )
    assert resp.status_code == 200


async def test_owner_adds_company_modules_and_overrides_with_audit(client):
    ctx = await seeded_ctx()
    owner = ctx.as_("owner")
    contract = {
        "id": "company.extra",
        "version": "1.0.0",
        "title": "Company extra",
        "policy": "optional",
        "applies_to": ["startup.standard"],
    }
    resp = await client.post("/v1/module-catalog", json={"contract": contract}, headers=owner)
    assert resp.status_code == 201, resp.text
    assert resp.json()["origin"] == "company" and not resp.json()["builtin"]
    risks = (await client.get("/v1/module-catalog/risks.register", headers=owner)).json()[
        "contract"
    ]
    resp = await client.post(
        "/v1/module-catalog/risks.register/versions",
        json={"contract": {**risks, "version": "1.0.1", "instructions": "Our rubric."}},
        headers=owner,
    )
    assert resp.status_code == 201 and resp.json()["origin"] == "company"
    assert [v["version"] for v in resp.json()["versions"]] == ["1.0.0", "1.0.1"]
    resp = await client.post(
        "/v1/module-catalog/risks.register/versions", json={"contract": risks}, headers=owner
    )
    assert resp.status_code == 422 and resp.json()["problems"][0]["code"] == "version_not_newer"
    async with tenant_session(ctx.tenant_id) as s:
        actions = set((await s.scalars(select(AuditEvent.action))).all())
    assert {"module.create", "module.override"} <= actions


async def test_recommend_for_an_intake_with_one_source(client):
    """§16 item 3 (this lane's part): a short brief plus one source gives a recommended
    existing PRD template with mandatory and conditional modules, each explained."""
    ctx = await seeded_ctx()
    async with tenant_session(ctx.tenant_id) as s:
        intake = ProductIntake(
            title="Agent tool permissions",
            brief="Let each customer configure which tools their agents may call, with "
            "multi-tenant isolation of tool credentials.",
            source_snapshot_ids=[uuid.uuid4()],
            analysis={"category": "ai_agent_platform", "scope": ["tool calling permissions"]},
        )
        s.add(intake)
        await s.commit()
        intake_id = intake.id
    resp = await client.post(
        "/v1/compositions/recommend",
        json={"intake_id": str(intake_id), "template": "prd-rfc"},
        headers=ctx.as_("viewer"),
    )
    assert resp.status_code == 200, resp.text
    rec = resp.json()
    assert rec["valid"] and rec["template"] == "prd-rfc" and rec["packs"] == ["ai-agent.platform"]
    assert rec["inputs"]["sources"]["snapshot_count"] == 1
    m = {x["key"]: x for x in rec["modules"]}
    assert m["constraints.solutions"]["selection"] == "mandatory"
    tools = m["agents.tool-policies"]
    assert tools["selection"] == "suggested" and tools["included"]
    held = [b for b in tools["basis"] if b["holds"]][0]
    assert held["knowledge_state"] == "ai_inference" and "intake brief" in held["source"]
    assert m["platform.brand-governance"]["selection"] == "optional"
    assert rec["summary"]["mandatory"] >= 15 and rec["summary"]["suggested"] >= 1


async def test_composition_lifecycle_records_who_why_changes_and_publish(client):
    ctx = await seeded_ctx()
    doc = await _doc(client, ctx)
    viewer, approver = ctx.as_("viewer"), ctx.as_("approver")

    # A legacy document: no composition, a recommendation, and nothing written.
    legacy = (await client.get(f"/v1/documents/{SLUG}/composition", headers=viewer)).json()
    assert legacy["legacy"] and legacy["current"] is None and legacy["recommendation"]["valid"]
    async with tenant_session(ctx.tenant_id) as s:
        assert not (await s.scalars(select(CompositionRevision))).all()

    seen: list[tuple[str, str | None]] = []

    async def record(db, event):
        seen.append((event.subject_kind, event.subject_ref))

    with changes.isolated_handlers():
        changes.register_handler("test.record", record)
        resp = await _confirm(client, ctx, inputs=PLATFORM, packs=["ai-agent.platform"])
        assert resp.status_code == 201, resp.text
        first = resp.json()["current"]
        assert first["number"] == 1 and first["status"] == "confirmed"
        assert first["decided_by"] == str(ctx.users["approver"].id)
        assert first["reason"] == "First composition"
        # The first composition changes no section, so only the revision is recorded.
        assert seen == [("composition_revision", f"{SLUG}#composition@1")]

        # A stale base is a conflict, never a silent overwrite.
        assert (await _confirm(client, ctx, base_revision=None)).status_code == 409

        # Mandatory modules are never removed silently.
        resp = await _confirm(
            client, ctx, base_revision=1, reason="shorter", changes={"remove": ["risks.register"]}
        )
        assert resp.status_code == 422
        assert resp.json()["problems"][0]["code"] == "required_module"

        seen.clear()
        resp = await _confirm(
            client,
            ctx,
            base_revision=1,
            reason="Memory is a later PRD",
            changes={"remove": ["agents.knowledge-memory"]},
        )
        assert resp.status_code == 201, resp.text
        second = resp.json()
        assert second["current"]["number"] == 2 and second["current"]["parent_number"] == 1
        assert second["current"]["diff"]["removed"] == ["agents.knowledge-memory"]
        assert second["current"]["diff"]["material"] is True
        assert seen == [
            ("composition_revision", f"{SLUG}#composition@2"),
            ("document_section", f"{SLUG}#knowledge-memory"),
        ]
        memory = {m["key"]: m for m in second["current"]["modules"]}["agents.knowledge-memory"]
        assert memory["user_reason"] == "Memory is a later PRD" and not memory["included"]
        statuses = [(r["number"], r["status"]) for r in second["revisions"]]
        assert statuses == [(2, "confirmed"), (1, "superseded")]

    async with tenant_session(ctx.tenant_id) as s:
        events = (await s.scalars(select(ChangeEvent).order_by(ChangeEvent.created_at))).all()
        assert [e.subject_kind for e in events][-2:] == ["composition_revision", "document_section"]
        assert events[-1].data["change"] == "module_removed"
        audits = (
            await s.scalars(select(AuditEvent).where(AuditEvent.action == "composition.revision"))
        ).all()
        assert len(audits) == 2 and audits[-1].data["reason"] == "Memory is a later PRD"

    # Publishing needs an approved version, then pins template and module versions.
    publish = f"/v1/documents/{SLUG}/composition/publish"
    assert (await client.post(publish, json={"version": 1}, headers=approver)).status_code == 409
    resp = await client.post(f"/v1/documents/{SLUG}/versions/1/approve", headers=approver)
    assert resp.status_code == 200, resp.text
    resp = await client.post(publish, json={"version": 1}, headers=approver)
    assert resp.status_code == 200, resp.text
    pinned = resp.json()
    assert pinned["status"] == "published" and pinned["number"] == 2
    assert pinned["inputs"]["template"]["key"] == "oracle-default"
    assert pinned["inputs"]["template"]["version"] == "1"  # the draft's own version
    assert pinned["inputs"]["policy"]["packs"] == ["ai-agent.platform"]
    assert {m["key"]: m["version"] for m in pinned["modules"]}["risks.register"] == "1.0.0"
    assert (await client.post(publish, json={"version": 1}, headers=approver)).status_code == 200

    # A later revision never changes the published one.
    resp = await _confirm(client, ctx, base_revision=2, reason="Add quotas",
                          changes={"add": ["platform.cost-quotas"]})  # fmt: skip
    assert resp.status_code == 201, resp.text
    statuses = [(r["number"], r["status"]) for r in resp.json()["revisions"]]
    assert statuses == [(3, "confirmed"), (2, "published"), (1, "superseded")]
    quotas = {m["key"]: m for m in resp.json()["current"]["modules"]}
    assert quotas["economics.value"]["decided_by"] == "dependency"
    assert doc["number"] == 1


async def test_a_published_document_version_event_pins_the_composition(client):
    ctx = await seeded_ctx()
    doc = await _doc(client, ctx)
    assert (await _confirm(client, ctx)).status_code == 201
    await client.post(f"/v1/documents/{SLUG}/versions/1/approve", headers=ctx.as_("approver"))
    async with tenant_session(ctx.tenant_id) as s:
        await changes.record_change(
            s, "document_version", cause="published", actor="system",
            subject_id=uuid.UUID(doc["id"]), document_id=uuid.UUID(doc["document_id"]),
        )  # fmt: skip
        await s.commit()
        revision = await s.scalar(select(CompositionRevision))
        assert revision.status == "published" and revision.document_version_id == uuid.UUID(
            doc["id"]
        )


async def test_the_company_policy_route_changes_recommendations(client):
    ctx = await seeded_ctx()
    await _doc(client, ctx)
    owner = ctx.as_("owner")
    resp = await client.put(
        "/v1/module-policy", json={"required": ["platform.tenant-isolation"]}, headers=owner
    )
    assert resp.status_code == 200 and not resp.json()["is_default"]
    rec = (
        await client.post("/v1/compositions/recommend", json={"document": SLUG}, headers=owner)
    ).json()
    tenants = {m["key"]: m for m in rec["modules"]}["platform.tenant-isolation"]
    assert tenants["selection"] == "mandatory" and tenants["policy_source"] == "company"
    resp = await client.put("/v1/module-policy", json={"required": ["no.such"]}, headers=owner)
    assert resp.status_code == 422 and resp.json()["problems"][0]["code"] == "unknown_module"


async def test_template_manifest_edits_are_company_edits(client):
    ctx = await seeded_ctx()
    resp = await client.put(
        "/v1/template-manifests/one-pager",
        json={"modules": [{"module_key": "risks.register", "section_ids": ["top-risks"],
                           "policy": "required"}]},
        headers=ctx.as_("approver"),
    )  # fmt: skip
    assert resp.status_code == 200, resp.text
    assert resp.json()["edited"] and len(resp.json()["modules"]) == 1
    resp = await client.put(
        "/v1/template-manifests/now-next-later",
        json={"modules": [{"module_key": "risks.register", "policy": "optional"}]},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 422
    assert (
        await client.get("/v1/template-manifests/nope", headers=ctx.as_("viewer"))
    ).status_code == 404


async def test_roadmaps_have_no_composition(client):
    ctx = await seeded_ctx()
    roadmap = "---\ndocument: placeholder-roadmap\ntitle: Roadmap\nkind: roadmap\n---\n# R {#r}\n"
    resp = await import_md(client, ctx.as_("approver"), "placeholder-roadmap", roadmap)
    assert resp.status_code == 201, resp.text
    resp = await client.get(
        "/v1/documents/placeholder-roadmap/composition", headers=ctx.as_("viewer")
    )
    assert resp.status_code == 422


async def test_another_companys_compositions_are_invisible(client):
    """Negative cross-company test for every route that names a record."""
    a = await seeded_ctx("Company A")
    b = await seeded_ctx("Company B")
    await _doc(client, b, slug="theirs")
    assert (await _confirm(client, b, slug="theirs")).status_code == 201
    async with tenant_session(b.tenant_id) as s:
        intake = ProductIntake(title="T", brief="Their brief")
        s.add(intake)
        await s.commit()
        their_intake = intake.id
    contract = {"id": "their.module", "version": "1.0.0", "title": "Theirs", "policy": "optional"}
    assert (
        await client.post("/v1/module-catalog", json={"contract": contract}, headers=b.as_("owner"))
    ).status_code == 201
    await client.put(
        "/v1/module-policy", json={"required": ["their.module"]}, headers=b.as_("owner")
    )

    for who in ("viewer", "owner", "token"):
        h = a.as_(who)
        assert (await client.get("/v1/documents/theirs/composition", headers=h)).status_code == 404
        resp = await client.post(
            "/v1/compositions/recommend", json={"document": "theirs"}, headers=h
        )
        assert resp.status_code == 404
        resp = await client.post(
            "/v1/compositions/recommend", json={"intake_id": str(their_intake)}, headers=h
        )
        assert resp.status_code == 404
        assert (await client.get("/v1/module-catalog/their.module", headers=h)).status_code == 404
    owner = a.as_("owner")
    assert (await _confirm(client, a, who="owner", slug="theirs")).status_code == 404
    resp = await client.post(
        "/v1/documents/theirs/composition/publish", json={"version": 1}, headers=owner
    )
    assert resp.status_code == 404
    assert "their.module" not in {
        m["key"] for m in (await client.get("/v1/module-catalog", headers=owner)).json()
    }
    assert (await client.get("/v1/module-policy", headers=owner)).json()["required"] == []


async def test_confirming_keeps_the_brief_sections_of_the_outline(client):
    """QA docs-1: after a confirm, the next revision's preview still lists the brief."""
    ctx = await seeded_ctx()
    await _doc(client, ctx)
    approver = ctx.as_("approver")

    async def brief() -> list[str]:
        resp = await client.post(
            "/v1/compositions/recommend", json={"document": SLUG}, headers=approver
        )
        assert resp.status_code == 200, resp.text
        return [o["section_id"] for o in resp.json()["outline"] if o["layer"] == "brief"]

    before = await brief()
    assert before, "the template has a brief layer"
    resp = await _confirm(client, ctx)
    assert resp.status_code == 201, resp.text
    assert await brief() == before
    resp = await _confirm(client, ctx, base_revision=1, reason="Second look")
    assert resp.status_code == 201, resp.text
    assert await brief() == before


async def test_reasons_name_the_pack_by_its_title(client):
    """QA docs-27: a mandatory module's reason names the pack as people know it, not its id."""
    ctx = await seeded_ctx()
    await _doc(client, ctx)
    rec = (
        await client.post(
            "/v1/compositions/recommend", json={"document": SLUG}, headers=ctx.as_("viewer")
        )
    ).json()
    packs = builtin_packs()
    titles = ", ".join(packs[p].title for p in rec["packs"])
    by_pack = [
        m for m in rec["modules"] if m["policy_source"] == "pack" and m["selection"] == "mandatory"
    ]
    assert by_pack
    for m in by_pack:
        assert m["reason"] == f"Mandatory in the {titles} pack."
        said = m["reason"] + " ".join(m["explanation"])
        assert not any(pid in said for pid in packs), said
