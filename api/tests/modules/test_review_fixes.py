"""Review fixes on the composition routes (PR #14 review).

MAJOR 1: a person's decisions are cumulative across revisions.
MAJOR 2: a working save never supersedes the confirmed revision nor records changes;
publishing pins the latest confirmed revision.
Minors: reads never write, manifests refuse archived modules and unknown sections, a
company module policy change is recorded for existing compositions.
"""

from datetime import UTC, datetime

from sqlalchemy import func, select

from oracle import changes
from oracle.modules import service
from oracle.modules.catalog import builtin_contracts, builtin_packs
from oracle.templates.models import Template
from oracle.tenancy import tenant_session
from oracle.v2.models import (
    ChangeEvent,
    CompositionRevision,
    ModuleDefinition,
    ModuleVersion,
    TemplateModuleAssignment,
)
from tests.baseline_helpers import make_ctx
from tests.modules.helpers import draft, import_md, seeded_ctx

SLUG = "placeholder-platform"
PLATFORM = {
    "category": "ai_agent_platform",
    "scope": {"capabilities": ["tool_use", "memory"]},
    "signals": {"tenant_count": 12},
}


async def _doc(client, ctx, slug=SLUG):
    resp = await import_md(client, ctx.as_("approver"), slug, draft("oracle-default", slug))
    assert resp.status_code == 201, resp.text


async def _revise(client, ctx, base, reason, who="approver", **body):
    body = {"base_revision": base, "reason": reason, **body}
    resp = await client.post(
        f"/v1/documents/{SLUG}/composition/revisions", json=body, headers=ctx.as_(who)
    )
    return resp


def _mods(inspector, part="current"):
    return {m["key"]: m for m in inspector[part]["modules"]}


async def _events(ctx) -> list[ChangeEvent]:
    async with tenant_session(ctx.tenant_id) as s:
        return list((await s.scalars(select(ChangeEvent).order_by(ChangeEvent.created_at))).all())


# --- MAJOR 1 ----------------------------------------------------------------------------


async def test_decisions_are_cumulative_across_revisions(client):
    ctx = await seeded_ctx()
    await _doc(client, ctx)
    resp = await _revise(client, ctx, None, "First", inputs=PLATFORM, packs=["ai-agent.platform"])
    assert resp.status_code == 201, resp.text

    resp = await _revise(
        client, ctx, 1, "Memory is a later PRD", changes={"remove": ["agents.knowledge-memory"]}
    )
    assert resp.status_code == 201, resp.text

    seen: list[tuple[str, str | None]] = []

    async def record(db, event):
        seen.append((event.subject_kind, event.subject_ref))

    with changes.isolated_handlers():
        changes.register_handler("test.record", record)
        resp = await _revise(
            client, ctx, 2, "Customers brand agents", changes={"add": ["platform.brand-governance"]}
        )
    assert resp.status_code == 201, resp.text
    third = resp.json()
    m = _mods(third)
    # The removal of revision 2 holds in revision 3, with its reason and who decided.
    memory = m["agents.knowledge-memory"]
    assert not memory["included"] and memory["decided_by"] == "user"
    assert memory["user_reason"] == "Memory is a later PRD"
    assert memory["overridden_by"] == str(ctx.users["approver"].id)
    assert m["platform.brand-governance"]["included"]
    # The diff records only what this revision decided.
    diff = third["current"]["diff"]
    # (brand governance brings its dependency, configuration precedence, along).
    assert diff["added"] == ["platform.brand-governance", "platform.config-precedence"]
    assert diff["removed"] == []
    assert seen == [
        ("composition_revision", f"{SLUG}#composition@3"),
        ("document_section", f"{SLUG}#brand-governance"),
        ("document_section", f"{SLUG}#config-precedence"),
    ]

    # A custom order, then a later change: both the addition and the order survive.
    included = [k for k, v in sorted(m.items(), key=lambda kv: kv[1]["order"]) if v["included"]]
    wanted = list(included)
    wanted.remove("risks.register")
    wanted.insert(wanted.index("scope.non-goals"), "risks.register")
    resp = await _revise(client, ctx, 3, "Risks first", changes={"order": wanted})
    assert resp.status_code == 201, resp.text
    assert resp.json()["current"]["diff"]["reordered"] is True

    resp = await _revise(client, ctx, 4, "Add quotas", changes={"add": ["platform.cost-quotas"]})
    assert resp.status_code == 201, resp.text
    fifth = resp.json()
    m = _mods(fifth)
    order = [k for k, v in sorted(m.items(), key=lambda kv: kv[1]["order"]) if v["included"]]
    assert order.index("risks.register") < order.index("scope.non-goals")
    assert m["platform.brand-governance"]["included"]
    assert m["platform.brand-governance"]["user_reason"] == "Customers brand agents"
    assert not m["agents.knowledge-memory"]["included"]
    assert m["platform.cost-quotas"]["included"]
    # Quotas and its dependency (value and cost economics); nothing else.
    assert fifth["current"]["diff"]["added"] == ["economics.value", "platform.cost-quotas"]
    assert fifth["current"]["diff"]["removed"] == []

    # Reading recommends from the same decisions.
    rec = (
        await client.post(
            "/v1/compositions/recommend", json={"document": SLUG}, headers=ctx.as_("viewer")
        )
    ).json()
    rm = {x["key"]: x for x in rec["modules"]}
    assert not rm["agents.knowledge-memory"]["included"]
    assert rm["platform.brand-governance"]["included"]


async def test_a_later_add_of_a_removed_module_brings_it_back(client):
    ctx = await seeded_ctx()
    await _doc(client, ctx)
    assert (await _revise(client, ctx, None, "First", inputs=PLATFORM)).status_code == 201
    resp = await _revise(client, ctx, 1, "Later", changes={"remove": ["agents.knowledge-memory"]})
    assert resp.status_code == 201
    resp = await _revise(client, ctx, 2, "Now", changes={"add": ["agents.knowledge-memory"]})
    assert resp.status_code == 201, resp.text
    memory = _mods(resp.json())["agents.knowledge-memory"]
    assert memory["included"] and memory["user_reason"] == "Now"


# --- MAJOR 2 ----------------------------------------------------------------------------


async def test_a_working_save_never_supersedes_the_confirmed_revision(client):
    ctx = await seeded_ctx()
    await _doc(client, ctx)
    approver = ctx.as_("approver")
    assert (await _revise(client, ctx, None, "First", inputs=PLATFORM)).status_code == 201
    before = len(await _events(ctx))

    seen: list[str] = []

    async def record(db, event):
        seen.append(event.subject_kind)

    with changes.isolated_handlers():
        changes.register_handler("test.record", record)
        resp = await _revise(
            client,
            ctx,
            1,
            "Trying without memory",
            status="working",
            changes={"remove": ["agents.knowledge-memory"]},
        )
    assert resp.status_code == 201, resp.text
    out = resp.json()
    # No change events at all for a working save.
    assert seen == [] and len(await _events(ctx)) == before
    # The confirmed revision stays in force; the draft is shown beside it.
    assert out["current"]["number"] == 1 and out["current"]["status"] == "confirmed"
    assert out["working"]["number"] == 2 and out["working"]["status"] == "working"
    assert out["head_revision"] == 2
    assert not _mods(out, "working")["agents.knowledge-memory"]["included"]
    assert _mods(out)["agents.knowledge-memory"]["included"]
    statuses = [(r["number"], r["status"]) for r in out["revisions"]]
    assert statuses == [(2, "working"), (1, "confirmed")]

    # Publishing pins the latest confirmed revision, not the draft.
    resp = await client.post(f"/v1/documents/{SLUG}/versions/1/approve", headers=approver)
    assert resp.status_code == 200, resp.text
    resp = await client.post(
        f"/v1/documents/{SLUG}/composition/publish", json={"version": 1}, headers=approver
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["number"] == 1 and resp.json()["status"] == "published"

    # The next revision starts from the newest one: a stale base is a conflict.
    assert (await _revise(client, ctx, 1, "Stale")).status_code == 409
    # Confirming from the draft: the draft's decisions carry, the diff and the section
    # events are against the revision in force.
    with changes.isolated_handlers():
        seen.clear()
        changes.register_handler("test.record", record)
        resp = await _revise(client, ctx, 2, "Confirm the draft")
    assert resp.status_code == 201, resp.text
    out = resp.json()
    assert out["current"]["number"] == 3 and out["current"]["parent_number"] == 1
    assert out["current"]["diff"]["removed"] == ["agents.knowledge-memory"]
    assert out["working"] is None
    assert seen == ["composition_revision", "document_section"]
    statuses = [(r["number"], r["status"]) for r in out["revisions"]]
    assert statuses == [(3, "confirmed"), (2, "superseded"), (1, "published")]


async def test_a_first_working_save_leaves_the_document_legacy(client):
    ctx = await seeded_ctx()
    await _doc(client, ctx)
    # The import itself records a document_version change (the trace hook); the working
    # save adds none.
    before = len(await _events(ctx))
    resp = await _revise(client, ctx, None, "Draft", status="working", inputs=PLATFORM)
    assert resp.status_code == 201, resp.text
    out = resp.json()
    assert out["legacy"] and out["current"] is None and out["working"]["number"] == 1
    assert len(await _events(ctx)) == before
    resp = await client.post(
        f"/v1/documents/{SLUG}/composition/publish",
        json={"version": 1},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 409
    resp = await _revise(client, ctx, 1, "Confirm")
    assert resp.status_code == 201 and resp.json()["current"]["number"] == 2


# --- minors -----------------------------------------------------------------------------


async def _counts(tenant_id) -> tuple[int, ...]:
    async with tenant_session(tenant_id) as s:
        return tuple(
            [
                await s.scalar(select(func.count()).select_from(model))
                for model in (ModuleDefinition, ModuleVersion, TemplateModuleAssignment, Template)
            ]
        )


async def test_reads_never_write_as_a_viewer(client):
    ctx = await make_ctx()  # not seeded: as before startup or company creation seeds it
    await _doc(client, ctx)
    before = await _counts(ctx.tenant_id)
    viewer = ctx.as_("viewer")
    for path in (
        "/v1/module-catalog",
        "/v1/module-catalog/risks.register",
        "/v1/module-packs",
        "/v1/module-policy",
        "/v1/template-manifests/oracle-default",
        f"/v1/documents/{SLUG}/composition",
    ):
        resp = await client.get(path, headers=viewer)
        assert resp.status_code in (200, 404), (path, resp.text)
    resp = await client.post("/v1/compositions/recommend", json={"document": SLUG}, headers=viewer)
    assert resp.status_code in (200, 404, 422)
    assert await _counts(ctx.tenant_id) == before

    # Startup seeds every company; then reads see the whole catalogue.
    await service.seed_all_companies()
    assert (await _counts(ctx.tenant_id))[0] == len(builtin_contracts())
    catalogue = (await client.get("/v1/module-catalog", headers=viewer)).json()
    assert len(catalogue) == len(builtin_contracts())
    seeded = await _counts(ctx.tenant_id)
    assert (await client.get(f"/v1/documents/{SLUG}/composition", headers=viewer)).json()["legacy"]
    assert await _counts(ctx.tenant_id) == seeded


async def test_a_write_by_an_approver_seeds(client):
    ctx = await make_ctx()
    await _doc(client, ctx)
    resp = await _revise(client, ctx, None, "First")
    assert resp.status_code == 201, resp.text
    assert (await _counts(ctx.tenant_id))[0] == len(builtin_contracts())


async def test_manifest_refuses_archived_modules_and_unknown_sections(client):
    ctx = await seeded_ctx()
    approver = ctx.as_("approver")
    url = "/v1/template-manifests/one-pager"
    resp = await client.put(
        url,
        json={"modules": [{"module_key": "risks.register", "section_ids": ["no-such-section"],
                           "policy": "optional"}]},
        headers=approver,
    )  # fmt: skip
    assert resp.status_code == 422
    assert resp.json()["problems"][0]["code"] == "unknown_section"
    async with tenant_session(ctx.tenant_id) as s:
        d = await s.scalar(select(ModuleDefinition).where(ModuleDefinition.key == "risks.register"))
        d.archived_at = datetime.now(UTC)
        await s.commit()
    resp = await client.put(
        url,
        json={"modules": [{"module_key": "risks.register", "section_ids": ["top-risks"],
                           "policy": "optional"}]},
        headers=approver,
    )  # fmt: skip
    assert resp.status_code == 422
    assert resp.json()["problems"][0]["code"] == "archived_module"


async def test_a_module_policy_change_is_recorded_for_existing_compositions(client):
    ctx = await seeded_ctx()
    await _doc(client, ctx)
    assert (await _revise(client, ctx, None, "First")).status_code == 201
    owner = ctx.as_("owner")
    before = len(await _events(ctx))
    body = {"required": ["platform.tenant-isolation"]}
    assert (await client.put("/v1/module-policy", json=body, headers=owner)).status_code == 200
    events = (await _events(ctx))[before:]
    assert [(e.subject_kind, e.cause) for e in events] == [
        ("composition_revision", "module_policy_changed")
    ]
    event = events[0]
    assert event.subject_ref == f"{SLUG}#composition@1"
    assert event.data["added_required"] == ["platform.tenant-isolation"]
    async with tenant_session(ctx.tenant_id) as s:
        revision = await s.scalar(select(CompositionRevision))
        assert event.subject_id == revision.id
    # The same policy again changes nothing, so nothing is recorded.
    assert (await client.put("/v1/module-policy", json=body, headers=owner)).status_code == 200
    assert len(await _events(ctx)) == before + 1


# --- industry packs through the routes ---------------------------------------------------


async def test_the_catalogue_lists_the_industry_packs_and_they_are_overridable(client):
    ctx = await seeded_ctx()
    viewer, owner = ctx.as_("viewer"), ctx.as_("owner")
    packs = {p["id"]: p for p in (await client.get("/v1/module-packs", headers=viewer)).json()}
    assert list(packs) == list(builtin_packs())
    fintech = packs["fintech.payments"]
    assert fintech["title"] == "Fintech and payments"
    assert fintech["categories"] == ["fintech", "payments"]
    pack = builtin_packs()["fintech.payments"]
    assert [m["key"] for m in fintech["modules"]] == list(pack.modules)
    assert {m["policy"] for m in fintech["modules"] if m["key"] in pack.own} == {
        "required", "conditional", "optional"
    }  # fmt: skip
    listed = (await client.get("/v1/module-catalog?pack=fintech.payments", headers=viewer)).json()
    assert {m["key"] for m in listed} == set(pack.modules)

    key = pack.own[0]
    contract = (await client.get(f"/v1/module-catalog/{key}", headers=viewer)).json()["contract"]
    resp = await client.post(
        f"/v1/module-catalog/{key}/versions",
        json={"contract": {**contract, "version": "1.0.1", "instructions": "Our rubric."}},
        headers=owner,
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["origin"] == "company" and resp.json()["version"] == "1.0.1"


async def test_an_industry_pack_composes_for_a_document(client):
    ctx = await seeded_ctx()
    await _doc(client, ctx)
    resp = await client.post(
        "/v1/compositions/recommend",
        json={"document": SLUG, "inputs": {"category": "fintech"}},
        headers=ctx.as_("viewer"),
    )
    assert resp.status_code == 200, resp.text
    rec = resp.json()
    assert rec["valid"] and rec["packs"] == ["fintech.payments"]
    selections = {m["selection"] for m in rec["modules"] if m["key"].startswith("fintech.")}
    assert selections == {"mandatory", "optional"}
    assert all(m["reason"] for m in rec["modules"])
