"""A roadmap is built only from an approved PRD version and records that exact version;
later PRD versions do not move it (build prompt §11.4, §16.18; O4, O4b)."""

import pytest
from sqlalchemy import select

from oracle.docs.models import Document, DocumentVersion
from oracle.swarm import FakeRuntime, Outcome, set_runtime
from oracle.tenancy import tenant_session
from tests.fixtures import seed_auth
from tests.legacy.helpers import DOC, add_feedback, fixture, import_md

ROADMAP = "legacy-onboarding-roadmap"
ITEMS = fixture("legacy_roadmap_items.yaml")
ROADMAP_MD = fixture("legacy_roadmap.md")


@pytest.fixture
def runtime():
    fake = FakeRuntime()
    set_runtime(fake)
    yield fake
    set_runtime(None)


async def _run(client, auth, runtime, **body) -> dict:
    """A prd_to_roadmap run with both checkpoints off, ticked to the end."""
    runtime.script["roadmap_items"] = [Outcome(artifacts={"roadmap_items.yaml": ITEMS})]
    runtime.script["roadmap_draft"] = [Outcome(artifacts={"roadmap.md": ROADMAP_MD})]
    off = {"roadmap_items": False, "roadmap_review": False}
    resp = await client.post(
        "/v1/runs",
        json={"flow": "prd_to_roadmap", "source": DOC, "knobs": {"checkpoints": off}, **body},
        headers=auth,
    )
    assert resp.status_code == 201, resp.text
    run = resp.json()
    assert (await client.post(f"/v1/runs/{run['id']}/estimate", headers=auth)).status_code == 200
    started = await client.post(f"/v1/runs/{run['id']}/start", headers=auth)
    assert started.status_code == 200, started.text
    for _ in range(2):
        tick = await client.post("/v1/internal/tick", headers=auth)
        assert tick.status_code == 200 and tick.json()["errors"] == [], tick.text
    run = (await client.get(f"/v1/runs/{run['id']}", headers=auth)).json()
    assert run["status"] == "succeeded", run
    return run


async def test_no_roadmap_from_an_unapproved_prd(client, runtime):
    _, auth = await seed_auth()
    assert (await import_md(client, auth, fixture("legacy_prd_v1.md"))).status_code == 201
    resp = await client.post(
        "/v1/runs", json={"flow": "prd_to_roadmap", "source": DOC}, headers=auth
    )
    assert resp.status_code == 422
    assert "no approved version" in resp.json()["detail"]
    assert runtime.submitted == []


async def test_roadmap_records_the_approved_prd_version_and_keeps_it(client, runtime):
    tenant_id, auth = await seed_auth()
    v1 = (await import_md(client, auth, fixture("legacy_prd_v1.md"))).json()
    approve = await client.post(f"/v1/documents/{DOC}/versions/1/approve", headers=auth)
    assert approve.status_code == 200, approve.text

    run = await _run(client, auth, runtime)
    assert run["source"]["slug"] == DOC and run["source"]["version"] == 1
    imp = run["segments"][1]["draft_import"]
    assert (imp["slug"], imp["kind"], imp["version"]) == (ROADMAP, "roadmap", 1)
    assert imp["prd_links"] == {"resolved": 2, "unresolved": []}

    doc = (await client.get(f"/v1/documents/{ROADMAP}", headers=auth)).json()
    assert (doc["kind"], doc["template"], doc["theme"]) == (
        "roadmap",
        "now-next-later",
        "roadmap-board",
    )
    assert (doc["source"]["slug"], doc["source"]["version"]) == (DOC, 1)
    assert doc["source"]["title"] == "Onboarding checklist PRD"

    # A later PRD draft (unapproved) does not move the roadmap's provenance.
    await add_feedback(tenant_id, v1["document_id"])
    assert (await import_md(client, auth, fixture("legacy_prd_v2.md"))).status_code == 201
    version = (await client.get(f"/v1/documents/{ROADMAP}/versions/1", headers=auth)).json()
    assert (version["source"]["slug"], version["source"]["version"]) == (DOC, 1)
    async with tenant_session(tenant_id) as s:
        roadmap_v1 = await s.scalar(
            select(DocumentVersion)
            .join(Document, Document.id == DocumentVersion.document_id)
            .where(Document.slug == ROADMAP)
        )
        assert str(roadmap_v1.source_version_id) == v1["id"]

    # The exports carry the provenance banner.
    md = await client.get(f"/v1/documents/{ROADMAP}/versions/1/export?format=md", headers=auth)
    assert "from Onboarding checklist PRD (legacy-onboarding) version 1" in md.text
    # The run needs an approved version to start a second roadmap too.
    again = await client.post(
        "/v1/runs",
        json={"flow": "prd_to_roadmap", "source": DOC, "source_version": 2},
        headers=auth,
    )
    assert again.status_code == 422 and "not approved" in again.json()["detail"]


async def test_a_roadmap_draft_pushed_by_hand_keeps_its_kind(client):
    _, auth = await seed_auth()
    resp = await import_md(client, auth, ROADMAP_MD, doc=ROADMAP)
    assert resp.status_code == 201, resp.text
    assert resp.json()["brief_source"] == "draft"
    doc = (await client.get(f"/v1/documents/{ROADMAP}", headers=auth)).json()
    assert doc["kind"] == "roadmap" and doc["source"] is None
    # A PRD draft never imports into a roadmap document.
    prd = fixture("legacy_prd_v1.md").replace(f"document: {DOC}", f"document: {ROADMAP}")
    wrong = await import_md(client, auth, prd, doc=ROADMAP)
    assert wrong.status_code == 422
