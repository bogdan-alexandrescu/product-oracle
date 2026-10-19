"""The impact explorer (§7, §11.5): for a change, which specs, wireframes, roadmaps,
prototypes and acceptance tests may need updating, why, and a targeted regeneration
plan. Proposals only: reading an impact never changes anything."""

import uuid

import oracle.main  # noqa: F401
from tests.baseline_helpers import make_ctx
from tests.trace_helpers import (
    PRD_V2,
    artifact_version,
    dependency,
    depend,
    import_md,
    link_section,
    prd_v1,
    seed_chain,
    stub_artifact,
    version_row,
)


async def _scenario(client):
    ctx = await make_ctx()
    chain = await seed_chain(ctx.tenant_id)
    v1 = await prd_v1(client, ctx)
    await link_section(
        ctx.tenant_id, v1.document_id, v1.id, "requirements", entity_id=chain["requirement"]
    )
    arts = {}
    for kind, status in (
        ("engineering_spec", "approved"),
        ("wireframe", "in_review"),
        ("prototype", "draft"),
        ("acceptance_tests", "approved"),
        ("tech_brief", "approved"),
    ):
        _, arts[kind] = await stub_artifact(
            ctx.tenant_id, v1.document_id, v1.id, kind=kind, status=status
        )
    deps = {
        "engineering_spec": await depend(
            ctx.tenant_id, artifact_version_id=arts["engineering_spec"],
            upstream_version_id=v1.id, section_key="requirements",
        ),
        "wireframe": await depend(
            ctx.tenant_id, artifact_version_id=arts["wireframe"], upstream_version_id=v1.id,
            section_key="requirements",
        ),
        "prototype": await depend(
            ctx.tenant_id, artifact_version_id=arts["prototype"], upstream_version_id=v1.id,
        ),
        "acceptance_tests": await depend(
            ctx.tenant_id, artifact_version_id=arts["acceptance_tests"], entity_id=chain["ac"]
        ),
        # Depends on an unchanged section: not affected.
        "tech_brief": await depend(
            ctx.tenant_id, artifact_version_id=arts["tech_brief"], upstream_version_id=v1.id,
            section_key="summary",
        ),
    }  # fmt: skip
    return ctx, chain, v1, arts, deps


async def test_impact_of_a_recorded_change_lists_outputs_reasons_and_a_plan(client):
    ctx, chain, v1, arts, deps = await _scenario(client)
    assert (await import_md(client, ctx.as_("approver"), PRD_V2)).status_code == 201
    change_id = (await dependency(ctx.tenant_id, deps["engineering_spec"])).caused_by_change_id

    resp = await client.get(f"/v1/trace/changes/{change_id}/impact", headers=ctx.as_("viewer"))
    assert resp.status_code == 200, resp.text
    report = resp.json()
    assert report["preview"] is False
    assert report["change"]["id"] == str(change_id)
    by_kind = {a["artifact_kind"]: a for a in report["affected"]}
    # The new version changed "requirements": the spec and wireframe on it, and the
    # prototype on the whole document. Not the tech brief on "summary".
    assert set(by_kind) == {"engineering_spec", "wireframe", "prototype"}
    assert by_kind["engineering_spec"]["category"] == "engineering_spec"
    assert by_kind["wireframe"]["category"] == "wireframe"
    assert by_kind["prototype"]["category"] == "prototype"
    assert any("requirements" in r for r in by_kind["engineering_spec"]["reasons"])
    assert all(a["freshness"] == "potentially_stale" for a in report["affected"])
    assert by_kind["engineering_spec"]["approved"] is True

    plan = {p["artifact_version_id"]: p for p in report["plan"]}
    spec_plan = plan[str(arts["engineering_spec"])]
    assert spec_plan["action"] == "regenerate"
    assert spec_plan["section_keys"] == ["requirements"]
    # Proposals only, and an approved output is never overwritten.
    assert spec_plan["keeps_approved_version"] is True
    assert "new version" in spec_plan["how"]
    assert report["counts"]["engineering_spec"] == 1


async def test_impact_of_a_requirement_change_reaches_acceptance_tests(client):
    ctx, chain, v1, arts, deps = await _scenario(client)
    resp = await client.patch(
        f"/v1/baseline/entities/{chain['requirement']}",
        json={"body": "Ten addresses", "origin": "user"},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 200
    change_id = (await dependency(ctx.tenant_id, deps["acceptance_tests"])).caused_by_change_id
    report = (
        await client.get(f"/v1/trace/changes/{change_id}/impact", headers=ctx.as_("viewer"))
    ).json()
    kinds = {a["artifact_kind"] for a in report["affected"]}
    # Spec and wireframe hang off the section that implements the requirement; the
    # acceptance tests off the criterion that verifies it.
    assert {"engineering_spec", "wireframe", "acceptance_tests"} <= kinds
    assert "tech_brief" not in kinds
    assert str(chain["ac"]) in {e["id"] for e in report["affected_entities"]}
    tests_item = next(a for a in report["affected"] if a["artifact_kind"] == "acceptance_tests")
    assert any("pick-saved" in r for r in tests_item["reasons"])


async def test_previewing_an_entity_impact_changes_nothing(client):
    ctx, chain, v1, arts, deps = await _scenario(client)
    resp = await client.get(
        f"/v1/baseline/entities/{chain['requirement']}/impact", headers=ctx.as_("viewer")
    )
    assert resp.status_code == 200, resp.text
    report = resp.json()
    assert report["preview"] is True and report["change"] is None
    assert report["subject"]["kind"] == "requirement"
    kinds = {a["artifact_kind"] for a in report["affected"]}
    assert {"engineering_spec", "wireframe", "acceptance_tests"} <= kinds
    # Preview: still fresh everywhere.
    for dep_id in deps.values():
        assert (await dependency(ctx.tenant_id, dep_id)).freshness == "fresh"
    assert (await artifact_version(ctx.tenant_id, arts["engineering_spec"])).freshness == "fresh"
    assert all(p["action"] in ("regenerate", "review") for p in report["plan"])


async def test_impact_from_a_document_version(client):
    ctx, chain, v1, arts, deps = await _scenario(client)
    assert (await import_md(client, ctx.as_("approver"), PRD_V2)).status_code == 201
    v2 = await version_row(ctx.tenant_id, 2)
    resp = await client.get(
        "/v1/documents/saved-addresses/versions/2/impact", headers=ctx.as_("viewer")
    )
    assert resp.status_code == 200, resp.text
    report = resp.json()
    assert report["subject"]["kind"] == "document_version"
    assert report["subject"]["id"] == str(v2.id)
    assert {a["artifact_kind"] for a in report["affected"]} == {
        "engineering_spec",
        "wireframe",
        "prototype",
    }
    assert [c["subject_id"] for c in report["changes"]] == [str(v2.id)]


async def test_impact_routes_are_company_scoped_and_need_auth(client):
    a = await make_ctx("Company A")
    ctx, chain, v1, arts, deps = await _scenario(client)
    await import_md(client, ctx.as_("approver"), PRD_V2)
    change_id = (await dependency(ctx.tenant_id, deps["engineering_spec"])).caused_by_change_id
    for path in (
        f"/v1/trace/changes/{change_id}/impact",
        f"/v1/baseline/entities/{chain['requirement']}/impact",
        "/v1/documents/saved-addresses/versions/2/impact",
        f"/v1/trace/changes/{uuid.uuid4()}/impact",
    ):
        assert (await client.get(path)).status_code == 401, path
        assert (await client.get(path, headers=a.as_("owner"))).status_code == 404, path
