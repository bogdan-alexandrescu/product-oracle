"""Trash and Regenerate on tech briefs (#482 lane A fixes): a trashed spec leaves the spec
requests, estimating a spec's regeneration changes nothing, and Restore says what could not
come back (its PRD purged meanwhile, or a dependent trashed in a separate delete)."""

import pytest
from sqlalchemy import select

from oracle.docs.models import Document, DocumentVersion
from oracle.models import AuditEvent
from oracle.runs.models import Run
from oracle.swarm import FakeRuntime, set_runtime
from oracle.tenancy import tenant_session
from oracle.v2.models import ArtifactRequest
from tests.specs_helpers import PRD, get_run, get_spec, make_world, pending, tick
from tests.test_specs import generated, script


@pytest.fixture
def runtime():
    fake = FakeRuntime()
    set_runtime(fake)
    yield fake
    set_runtime(None)


async def _spec_world(client, runtime):
    """An approved PRD with a tech brief whose run finished (its review approved)."""
    world = await make_world(client)
    created = await generated(client, runtime, world)
    owner = world.ctx.as_("owner")
    run = await get_run(client, owner, created["run_id"])
    resp = await client.post(
        f"/v1/runs/{run['id']}/checkpoints/{pending(run)['id']}/decide",
        json={"decision": "approved"},
        headers=owner,
    )
    assert resp.status_code == 200, resp.text
    request_id = created["spec"]["request"]["id"]
    spec = await get_spec(client, owner, request_id)
    assert spec["document_slug"]
    return world, owner, request_id, spec["document_slug"]


async def _slugs(client, headers) -> set[str]:
    return {d["slug"] for d in (await client.get("/v1/documents", headers=headers)).json()}


async def test_a_trashed_spec_leaves_the_spec_requests(client, runtime):
    world, owner, request_id, slug = await _spec_world(client, runtime)
    listed = await client.get("/v1/spec-requests", headers=owner)
    assert request_id in {s["request"]["id"] for s in listed.json()}

    # Deleting the spec alone (a single dependent): its PRD stays.
    resp = await client.request("DELETE", f"/v1/documents/{slug}", headers=owner)
    assert resp.status_code == 200, resp.text
    assert resp.json()["root"]["slug"] == slug
    assert not [i for i in resp.json()["items"] if i["type"] == "document"]
    slugs = await _slugs(client, owner)
    assert PRD in slugs and slug not in slugs

    listed = await client.get("/v1/spec-requests", headers=owner)
    assert request_id not in {s["request"]["id"] for s in listed.json()}
    by_prd = await client.get("/v1/spec-requests", params={"prd": PRD}, headers=owner)
    assert request_id not in {s["request"]["id"] for s in by_prd.json()}
    gone = await client.get(f"/v1/spec-requests/{request_id}", headers=owner)
    assert gone.status_code == 404, gone.text

    back = await client.post(f"/v1/documents/{slug}/restore", headers=owner)
    assert back.status_code == 200, back.text
    assert back.json()["not_restored"] == []
    assert (await get_spec(client, owner, request_id))["document_slug"] == slug


async def test_a_prds_tech_brief_goes_to_trash_with_it_and_comes_back(client, runtime):
    """A tech brief made through the spec request (no source_version_id on its versions)
    is the PRD's dependent: listed, trashed with it and restored with it (#482 follow-up)."""
    world, owner, request_id, slug = await _spec_world(client, runtime)
    async with tenant_session(world.ctx.tenant_id) as s:
        sources = await s.scalars(
            select(DocumentVersion.source_version_id)
            .join(Document, Document.id == DocumentVersion.document_id)
            .where(Document.slug == slug)
        )
        assert set(sources) == {None}

    deps = await client.get(f"/v1/documents/{PRD}/dependents", headers=owner)
    assert deps.status_code == 200, deps.text
    assert slug in {i["slug"] for i in deps.json()["items"] if i["type"] == "document"}

    resp = await client.request("DELETE", f"/v1/documents/{PRD}", headers=owner)
    assert resp.status_code == 200, resp.text
    entry = resp.json()
    assert slug in {i["slug"] for i in entry["items"] if i["type"] == "document"}
    assert not {PRD, slug} & await _slugs(client, owner)
    assert (await client.get(f"/v1/documents/{slug}", headers=owner)).status_code == 404
    assert (await client.get(f"/v1/documents/{PRD}", headers=owner)).status_code == 404
    listed = await client.get("/v1/spec-requests", headers=owner)
    assert request_id not in {s["request"]["id"] for s in listed.json()}
    by_prd = await client.get("/v1/spec-requests", params={"prd": PRD}, headers=owner)
    assert request_id not in {s["request"]["id"] for s in by_prd.json()}

    back = await client.post(f"/v1/trash/{entry['id']}/restore", headers=owner)
    assert back.status_code == 200, back.text
    assert back.json()["not_restored"] == []
    assert {PRD, slug} <= await _slugs(client, owner)
    by_prd = await client.get("/v1/spec-requests", params={"prd": PRD}, headers=owner)
    assert request_id in {s["request"]["id"] for s in by_prd.json()}
    assert (await get_spec(client, owner, request_id))["document_slug"] == slug
    assert (await client.get("/v1/trash", headers=owner)).json() == []


async def test_a_run_working_on_a_prds_tech_brief_refuses_the_prds_delete(client, runtime):
    world, owner, request_id, slug = await _spec_world(client, runtime)
    async with tenant_session(world.ctx.tenant_id) as s:
        spec = await s.scalar(select(Document).where(Document.slug == slug))
        prd = await s.scalar(select(Document).where(Document.slug == PRD))
        s.add(Run(flow="prd_to_spec", status="running", document_id=spec.id))
        await s.commit()
        prd_id = prd.id
    resp = await client.request("DELETE", f"/v1/documents/{PRD}", headers=owner)
    assert resp.status_code == 409, resp.text
    assert "cancel it first" in resp.text
    async with tenant_session(world.ctx.tenant_id) as s:
        assert (await s.get(Document, prd_id)).deleted_at is None


async def test_estimating_a_spec_regeneration_changes_nothing(client, runtime):
    world, owner, request_id, slug = await _spec_world(client, runtime)
    approver = world.ctx.as_("approver")
    async with tenant_session(world.ctx.tenant_id) as s:
        before = await s.get(ArtifactRequest, request_id)
        run_before, params_before = before.run_id, dict(before.params)

    note = "Keep the saved cards first"
    first = await client.post(
        f"/v1/documents/{slug}/regenerate/estimate", json={"note": note}, headers=approver
    )
    assert first.status_code == 200, first.text
    # Estimating again works: the first estimate proposed nothing.
    again = await client.post(
        f"/v1/documents/{slug}/regenerate/estimate", json={"note": note}, headers=approver
    )
    assert again.status_code == 200, again.text
    async with tenant_session(world.ctx.tenant_id) as s:
        after = await s.get(ArtifactRequest, request_id)
        assert after.run_id == run_before
        assert after.params == params_before
        actions = set(await s.scalars(select(AuditEvent.action)))
    assert "spec.regeneration_proposed" not in actions
    spec = await get_spec(client, owner, request_id)
    assert spec["run_id"] == str(run_before)

    # Starting it proposes the regeneration, and its agents get the note.
    script(runtime, world)
    started = await client.post(
        f"/v1/documents/{slug}/regenerate",
        json={"run_id": again.json()["run_id"], "note": note},
        headers=approver,
    )
    assert started.status_code == 200, started.text
    spec = await get_spec(client, owner, request_id)
    assert spec["run_id"] == again.json()["run_id"]
    await tick(client, owner)
    assert any(note in step.prompt for spec_ in runtime.submitted for step in spec_.steps)


async def test_restore_a_spec_whose_prd_was_purged_meanwhile(client, runtime):
    world, owner, request_id, slug = await _spec_world(client, runtime)
    spec_entry = (await client.request("DELETE", f"/v1/documents/{slug}", headers=owner)).json()
    prd_entry = await client.request("DELETE", f"/v1/documents/{PRD}", headers=owner)
    assert prd_entry.status_code == 200, prd_entry.text
    # The spec went in its own delete: the PRD's does not take it again.
    assert slug not in {i["slug"] for i in prd_entry.json()["items"]}
    purged = await client.request("DELETE", f"/v1/trash/{prd_entry.json()['id']}", headers=owner)
    assert purged.status_code == 204, purged.text

    resp = await client.post(f"/v1/trash/{spec_entry['id']}/restore", headers=owner)
    assert resp.status_code == 200, resp.text
    assert slug in await _slugs(client, owner)
    [missing] = resp.json()["not_restored"]
    assert missing["item"]["slug"] == PRD
    assert "deleted for good" in missing["reason"]


async def test_restore_a_prd_whose_spec_was_trashed_separately(client, runtime):
    world, owner, request_id, slug = await _spec_world(client, runtime)
    await client.request("DELETE", f"/v1/documents/{slug}", headers=owner)
    prd_entry = (await client.request("DELETE", f"/v1/documents/{PRD}", headers=owner)).json()

    resp = await client.post(f"/v1/trash/{prd_entry['id']}/restore", headers=owner)
    assert resp.status_code == 200, resp.text
    slugs = await _slugs(client, owner)
    assert PRD in slugs and slug not in slugs
    [left] = resp.json()["not_restored"]
    assert left["item"]["slug"] == slug
    assert "Trash" in left["reason"]
    # It is still in Trash, on its own, and comes back from there.
    [entry] = (await client.get("/v1/trash", headers=owner)).json()
    assert entry["root"]["slug"] == slug
    back = await client.post(f"/v1/trash/{entry['id']}/restore", headers=owner)
    assert back.status_code == 200, back.text
    assert back.json()["not_restored"] == []
    assert slug in await _slugs(client, owner)


async def test_restore_a_spec_while_its_prd_is_still_in_trash(client, runtime):
    world, owner, request_id, slug = await _spec_world(client, runtime)
    spec_entry = (await client.request("DELETE", f"/v1/documents/{slug}", headers=owner)).json()
    await client.request("DELETE", f"/v1/documents/{PRD}", headers=owner)
    resp = await client.post(f"/v1/trash/{spec_entry['id']}/restore", headers=owner)
    assert resp.status_code == 200, resp.text
    [missing] = resp.json()["not_restored"]
    assert missing["item"]["slug"] == PRD and "Trash" in missing["reason"]
