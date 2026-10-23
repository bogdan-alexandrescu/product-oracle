"""#481 fixes (owner decision, 2026-10-23): Reconcile on a spec version that may be stale
only proposes the regeneration. It settles nothing: the version stays Potentially stale,
and Approve stays refused, until the regenerated version is imported and supersedes it (or
someone presses Review). While the regeneration's run has not ended the spec names it
(``regeneration_run_id``), so the page reads "regeneration running" and offers no second
Reconcile. Against Postgres with the FakeRuntime."""

from tests import specs_helpers as h
from tests.fixtures import draft
from tests.test_specs import SECTIONS, generated, runtime, script  # noqa: F401 - fixture


async def _stale(client, runtime):  # noqa: F811
    """A spec whose run has ended, then PRD v2 (approved, adopting its requirements)
    changes s-5-2: its version 1 may be stale."""
    world = await h.make_world(client)
    created = await generated(client, runtime, world, checkpoint=False)
    owner = world.ctx.as_("owner")
    v2 = draft("prd_v1.md").replace(
        "Show the shipping cost on the cart page", "Show a shipping estimate on the cart page"
    )
    assert (await h.import_md(client, owner, v2)).status_code == 201
    resp = await client.post(f"/v1/documents/{h.PRD}/versions/2/approve", headers=owner)
    assert resp.status_code == 200, resp.text
    await h.adopt(world, 2)
    return world, created


async def test_reconcile_leaves_the_version_stale_and_approve_refused(client, runtime):  # noqa: F811
    """protects=#481 fixes item 1; fails_when=proposing the regeneration settles the
    version's staleness, Approve passes, the spec does not name the running regeneration,
    or a second one may be proposed; no_claim=the page's controls
    (web/e2e/spec-staleness.spec.ts)."""
    world, created = await _stale(client, runtime)
    owner, approver = world.ctx.as_("owner"), world.ctx.as_("approver")
    request_id = created["spec"]["request"]["id"]
    slug = created["spec"]["document_slug"]
    spec = await h.get_spec(client, owner, request_id)
    assert spec["versions"][0]["artifact_version"]["freshness"] == "potentially_stale"
    assert spec["regeneration_run_id"] is None

    resp = await client.post(
        f"/v1/spec-requests/{request_id}/regenerate",
        json={"reason": "The shipping step changed"},
        headers=approver,
    )
    assert resp.status_code == 201, resp.text
    run_id = resp.json()["run_id"]

    spec = await h.get_spec(client, owner, request_id)
    assert spec["versions"][0]["artifact_version"]["freshness"] == "potentially_stale"
    assert spec["freshness"] == "potentially_stale"
    assert spec["regeneration_run_id"] == run_id
    resp = await client.post(f"/v1/documents/{slug}/versions/1/approve", headers=owner)
    assert resp.status_code == 422 and "may be stale" in resp.json()["detail"], resp.text
    # No second Reconcile while one is running.
    resp = await client.post(
        f"/v1/spec-requests/{request_id}/regenerate", json={"reason": "again"}, headers=approver
    )
    assert resp.status_code == 409, resp.text


async def test_the_imported_regeneration_supersedes_the_stale_version(client, runtime):  # noqa: F811
    """protects=#481 fixes item 1; fails_when=the regenerated version does not supersede
    the stale one, or the spec still names a regeneration running once its run ended;
    no_claim=what the run writes (test_specs.py)."""
    world, created = await _stale(client, runtime)
    owner, approver = world.ctx.as_("owner"), world.ctx.as_("approver")
    request_id = created["spec"]["request"]["id"]
    resp = await client.post(
        f"/v1/spec-requests/{request_id}/regenerate", json={}, headers=approver
    )
    assert resp.status_code == 201, resp.text
    script(runtime, world)
    await h.start(client, approver, resp.json()["run_id"])
    await h.tick(client, owner)

    spec = await h.get_spec(client, owner, request_id)
    assert spec["latest_version"] == 2
    assert [v["artifact_version"]["status"] for v in spec["versions"]] == [
        "superseded",
        "in_review",
    ]
    assert spec["versions"][1]["artifact_version"]["freshness"] == "fresh"
    assert spec["regeneration_run_id"] is None
    # The superseded version is no longer listed as stale.
    assert spec["versions"][0]["artifact_version"]["id"] not in {
        v["artifact_version_id"] for v in spec["stale"]
    }
