"""Retry on a failed "Roadmap items for a PRD draft" run re-opens its draft roadmap: the
row reads running again (no stale failure, no second Derive racing it), and a PRD run's
Engineering dates waits for it instead of skipping. A failed run stopped at its budget
is not retried. Against Postgres with the FakeRuntime; invented example data only."""

import uuid
from decimal import Decimal

from sqlalchemy import select

from oracle.roadmap.models import DraftRoadmap
from oracle.runs.models import Run
from oracle.swarm import Outcome
from oracle.tenancy import tenant_session
from tests.test_draft_roadmaps import (  # noqa: F401
    ITEMS_PATH,
    PRD,
    derivations_start,
    draft_runs,
    new_version,
    owner,
    person,
    read,
    runtime,
    tick,
)
from tests.test_run_segment_retry import OUT_OF_ROOM, draft_of, failed_at_draft
from tests.test_runs import get

RETRY = "/v1/runs/{run}/segments/{seq}/retry"


async def failed_items_run(client, owner, runtime, then: Outcome) -> dict:  # noqa: F811
    """v1's items run, failed at its writer; ``then`` is what its retry does."""
    tenant_id, auth = owner
    runtime.script["roadmap_items"] = [Outcome(state="failed", error=OUT_OF_ROOM), then]
    await new_version(client, auth, 1)
    await tick(client, auth)
    await tick(client, auth)
    body = await read(client, auth, 1)
    assert body["status"] == "failed", body
    (run,) = [r for r in await draft_runs(tenant_id) if r.status == "failed"]
    return await get(client, auth, run.id)


async def test_retry_reopens_the_draft_roadmap_and_derive_waits(client, owner, runtime):  # noqa: F811
    """protects: review r1 blocker; fails_when: the row stays failed with the old error
    while its run runs again, or Derive starts a second run on the same row; no_claim:
    the web's Roadmap tab (its own spec)."""
    tenant_id, auth = owner
    run = await failed_items_run(client, owner, runtime, Outcome(polls=3))
    seg = next(s for s in run["segments"] if s["can_retry"])
    resp = await client.post(RETRY.format(run=run["id"], seq=seg["seq"]), headers=auth)
    assert resp.status_code == 200, resp.text
    body = await read(client, auth, 1)
    assert body["status"] == "running" and body["error"] is None, body
    _, approver = await person(tenant_id, "approver")
    derive = await client.post(ITEMS_PATH.format(doc=PRD, n=1) + "/derive", headers=approver)
    assert derive.status_code == 409 and "already being derived" in derive.text
    assert len(await draft_runs(tenant_id)) == 1
    for _ in range(6):
        await tick(client, auth)
    assert (await read(client, auth, 1))["status"] == "ready"
    assert (await get(client, auth, run["id"]))["status"] == "succeeded"


async def test_retry_leaves_a_row_derived_again_since(client, owner, runtime):  # noqa: F811
    """protects: the row is the run's own only; fails_when: a retried run takes back a
    row a person derived again since; no_claim: -."""
    tenant_id, auth = owner
    run = await failed_items_run(client, owner, runtime, Outcome(polls=3))
    async with tenant_session(tenant_id) as s:
        row = await s.scalar(select(DraftRoadmap))
        row.run_id = None
        row.status = "failed"
        await s.commit()
    seg = next(s for s in run["segments"] if s["can_retry"])
    resp = await client.post(RETRY.format(run=run["id"], seq=seg["seq"]), headers=auth)
    assert resp.status_code == 200, resp.text
    async with tenant_session(tenant_id) as s:
        row = await s.scalar(select(DraftRoadmap))
        assert row.status == "failed" and row.run_id is None


async def test_a_run_stopped_at_its_budget_is_not_retried(client, owner, runtime):  # noqa: F811
    """protects: review r1 minor (c); fails_when: Retry is offered or accepted on a failed
    run whose spend is over its ceiling; no_claim: Resume of a paused run."""
    tenant_id, auth = owner
    run = await failed_at_draft(client, auth, runtime)
    async with tenant_session(tenant_id) as s:
        row = await s.get(Run, uuid.UUID(run["id"]))
        row.knobs = {**row.knobs, "spend_ceiling_usd": "0.50"}
        row.spent_usd = Decimal("2.00")
        await s.commit()
    run = await get(client, auth, run["id"])
    assert all(s["can_retry"] is False for s in run["segments"])
    submitted = len(runtime.submitted)
    resp = await client.post(RETRY.format(run=run["id"], seq=draft_of(run)["seq"]), headers=auth)
    assert resp.status_code == 409, resp.text
    assert "stopped at its budget; start it again with a new estimate" in resp.text
    assert (await get(client, auth, run["id"]))["status"] == "failed"
    assert len(runtime.submitted) == submitted
