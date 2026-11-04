"""The rebuild sign (owner's pick A, PR 1232): GET /v1/rebuilds lists the runs that will
make a new version of a document a person may read: scheduled (not started yet), running,
waiting at a stop on a person, stopped, and done until the new version is approved."""

from datetime import UTC, datetime

from sqlalchemy import select, update

from oracle.auth.models import User
from oracle.docs.models import Document, DocumentVersion
from oracle.runs.models import Run
from oracle.tenancy import tenant_session
from tests.test_runs import as_user, create, decide, get, owner, runtime, started, tick

__all__ = ["owner", "runtime"]


async def _rebuilds(client, headers) -> dict:
    resp = await client.get("/v1/rebuilds", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _name_owner(tenant_id, name="Avery Example"):
    async with tenant_session(tenant_id) as s:
        await s.execute(update(User).where(User.role == "owner").values(name=name))
        await s.commit()


async def test_a_running_run_reads_its_step_of_its_steps_and_who_started_it(client, owner, runtime):
    tenant_id, auth = owner
    await _name_owner(tenant_id)
    run = await started(client, auth, checkpoints={"eng_dates": False})
    body = await _rebuilds(client, auth)
    [rb] = body["rebuilds"]
    assert rb["run_id"] == run["id"]
    assert rb["document_slug"] == "example-prd"
    assert rb["state"] == "running"
    assert rb["step"] == 1
    # The steps a person reads: the segments it runs, by their titles (skipped ones left out).
    assert all(rb["steps"])
    assert len(rb["steps"]) == 5
    assert rb["started_by"] == "Avery Example"
    assert rb["started_at"]
    # A new document: nothing is approved yet, and the run makes its version 1.
    assert rb["from_version"] is None and rb["to_version"] == 1
    # Its next stop, and who decides it.
    assert rb["next_stop"]
    assert rb["waits_on"] is None
    # No company roadmap yet: nothing a PRD's rebuild feeds.
    assert body["company_roadmap"] is None


async def test_a_run_at_a_stop_waits_on_a_person_with_their_action(client, owner, runtime):
    tenant_id, auth = owner
    await _name_owner(tenant_id)
    run = await started(client, auth, checkpoints={"eng_dates": False})
    await tick(client, auth)
    [rb] = (await _rebuilds(client, auth))["rebuilds"]
    assert rb["state"] == "waiting"
    assert rb["step"] == 1
    assert rb["waits_on"] == "Avery Example"
    assert rb["waits_on_action"]
    assert rb["review_link"] is None or rb["review_link"].startswith("/")
    assert run["id"] == rb["run_id"]


async def test_a_run_not_started_reads_as_scheduled(client, owner, runtime):
    _, auth = owner
    run = await create(client, auth)
    [rb] = (await _rebuilds(client, auth))["rebuilds"]
    assert rb["run_id"] == run["id"] and rb["state"] == "scheduled"


async def test_a_failed_run_says_where_it_stopped(client, owner, runtime):
    tenant_id, auth = owner
    run = await started(client, auth, checkpoints={"eng_dates": False})
    async with tenant_session(tenant_id) as s:
        await s.execute(
            update(Run)
            .where(Run.id == run["id"])
            .values(
                status="failed", error="Two sections came back empty", finished_at=datetime.now(UTC)
            )
        )
        await s.commit()
    [rb] = (await _rebuilds(client, auth))["rebuilds"]
    assert rb["state"] == "failed" and rb["step"] == 1
    assert rb["error"]


async def test_the_new_version_reads_done_until_it_is_approved(client, owner, runtime):
    tenant_id, auth = owner
    run = await started(client, auth, checkpoints={"eng_dates": False})
    for _ in range(5):
        await tick(client, auth)
        run = await decide(client, auth, await get(client, auth, run["id"]))
    assert run["status"] == "succeeded"
    [rb] = (await _rebuilds(client, auth))["rebuilds"]
    assert rb["state"] == "done" and rb["to_version"] == 1
    assert rb["step"] == len(rb["steps"])
    async with tenant_session(tenant_id) as s:
        doc = await s.scalar(select(Document).where(Document.slug == "example-prd"))
        await s.execute(
            update(DocumentVersion)
            .where(DocumentVersion.document_id == doc.id)
            .values(approved_at=datetime.now(UTC))
        )
        await s.commit()
    assert (await _rebuilds(client, auth))["rebuilds"] == []


async def test_a_reader_who_may_not_see_runs_still_reads_the_sign(client, owner, runtime):
    tenant_id, auth = owner
    await started(client, auth, checkpoints={"eng_dates": False})
    viewer = await as_user(tenant_id, "viewer")
    body = await _rebuilds(client, viewer)
    assert [r["state"] for r in body["rebuilds"]] == ["running"]
