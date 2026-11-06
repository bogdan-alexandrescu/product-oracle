"""The rebuild sign (owner's pick A, PR 1232): GET /v1/rebuilds lists the runs that will
make a new version of a document a person may read: scheduled (not started yet), running,
waiting at a stop on a person, stopped, and done until the new version is approved."""

from datetime import UTC, datetime

from sqlalchemy import select, update

from oracle.auth.models import User
from oracle.docs.models import Document, DocumentVersion
from oracle.runs.models import Run
from oracle.tenancy import tenant_session
from tests.conftest import make_tenant
from tests.fixtures import seed_auth
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


async def test_a_roadmap_run_carries_the_prd_it_reads(client, runtime):
    """A prd_to_roadmap run names the PRD it reads (``source_slug``), so the PRD's sign lists
    it beside the PRD's own regenerate (frame a-one-pager-running-rbcasetwo)."""
    from tests.test_roadmap import PRD, approved_prd
    from tests.test_roadmap import create as create_roadmap_run

    _, auth = await seed_auth()
    await approved_prd(client, auth)
    run = await create_roadmap_run(client, auth, source=PRD)
    body = await _rebuilds(client, auth)
    [rb] = [r for r in body["rebuilds"] if r["run_id"] == run["id"]]
    assert rb["source_slug"] == PRD
    assert rb["document_kind"] == "roadmap"


async def test_a_prd_run_carries_no_source(client, owner, runtime):
    _, auth = owner
    await create(client, auth)
    [rb] = (await _rebuilds(client, auth))["rebuilds"]
    assert rb["source_slug"] is None


async def test_a_document_the_reader_may_not_see_has_no_sign(client, owner, runtime):
    tenant_id, auth = owner
    async with tenant_session(tenant_id) as s:
        s.add(Document(slug="example-prd", title="Example PRD", kind="prd", visibility="approvers"))
        await s.commit()
    await started(client, auth, checkpoints={"eng_dates": False})
    commenter = await as_user(tenant_id, "commenter")
    body = await _rebuilds(client, commenter)
    assert body["rebuilds"] == []
    # The owner still reads it.
    assert [r["state"] for r in (await _rebuilds(client, auth))["rebuilds"]] == ["running"]


async def test_the_prd_count_is_what_the_reader_may_see(client, owner, runtime):
    tenant_id, auth = owner
    async with tenant_session(tenant_id) as s:
        s.add(
            Document(
                slug="example-roadmap",
                title="Example roadmap",
                kind="roadmap",
                company_roadmap=True,
            )
        )
        s.add(Document(slug="open-prd", title="Open PRD", kind="prd"))
        s.add(Document(slug="closed-prd", title="Closed PRD", kind="prd", visibility="approvers"))
        await s.commit()
    assert (await _rebuilds(client, auth))["company_roadmap"]["prds"] == 2
    commenter = await as_user(tenant_id, "commenter")
    assert (await _rebuilds(client, commenter))["company_roadmap"]["prds"] == 1


async def test_another_tenants_runs_are_not_listed(client, owner, runtime):
    _, auth = owner
    await started(client, auth, checkpoints={"eng_dates": False})
    other = await as_user(await make_tenant("Other Example Co"), "owner")
    assert (await _rebuilds(client, other))["rebuilds"] == []


async def test_a_flow_that_writes_no_document_is_not_listed(client, runtime):
    """prd_draft_items reads a PRD draft and writes no version of any document."""
    from oracle.runs import flows
    from tests.test_roadmap import PRD, approved_prd

    assert not any(g.imports_draft for g in flows.FLOWS["prd_draft_items"].segments)
    _, auth = await seed_auth()
    await approved_prd(client, auth, approve=False)
    resp = await client.post(
        "/v1/runs",
        json={"flow": "prd_draft_items", "source": PRD, "source_version": 1},
        headers=auth,
    )
    assert resp.status_code == 201, resp.text
    assert (await _rebuilds(client, auth))["rebuilds"] == []


async def test_many_runs_read_in_a_few_queries(client, owner, runtime):
    """Batched: the number of queries does not grow with the runs or their documents."""
    from sqlalchemy import event

    from oracle.db import get_engine

    tenant_id, auth = owner
    await create(client, auth)
    counts = []
    for n in range(2):
        statements = []

        def count(*_a, _s=statements, **_k):
            _s.append(1)

        event.listen(get_engine().sync_engine, "before_cursor_execute", count)
        try:
            await _rebuilds(client, auth)
        finally:
            event.remove(get_engine().sync_engine, "before_cursor_execute", count)
        counts.append(len(statements))
        for i in range(3):
            await create(client, auth, document=f"example-prd-{n}-{i}")
    body = await _rebuilds(client, auth)
    assert len(body["rebuilds"]) == 7
    assert counts[1] == counts[0]


async def test_a_run_writing_a_new_prd_is_listed_as_new_until_its_first_version(
    client, owner, runtime
):
    """Baseline to PRD making a new PRD: no document yet (its slug only on the run), so
    the sign says a new PRD is being written and links the run, not a page that is not
    there yet; once its first version lands, it is the PRD's own."""
    tenant_id, auth = owner
    await _name_owner(tenant_id)
    run = await started(client, auth, checkpoints={"eng_dates": False})
    assert run["document_id"] is None
    [rb] = (await _rebuilds(client, auth))["rebuilds"]
    assert rb["run_id"] == run["id"] and rb["document_slug"] == "example-prd"
    assert rb["new_document"] is True
    await tick(client, auth)
    [rb] = (await _rebuilds(client, auth))["rebuilds"]
    assert rb["state"] == "waiting" and rb["new_document"] is True
    for _ in range(5):
        run = await decide(client, auth, await get(client, auth, run["id"]))
        await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "succeeded"
    [rb] = (await _rebuilds(client, auth))["rebuilds"]
    assert rb["state"] == "done" and rb["new_document"] is False


async def test_a_scheduled_run_for_a_new_prd_is_new(client, owner, runtime):
    _, auth = owner
    await create(client, auth, document="team-onboarding-example")
    [rb] = (await _rebuilds(client, auth))["rebuilds"]
    assert rb["state"] == "scheduled" and rb["new_document"] is True
    assert rb["document_slug"] == "team-onboarding-example"
