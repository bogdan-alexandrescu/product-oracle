"""E1 part B (decided 2026-10-21, "Reuse items"): Build roadmap on an approved PRD version
whose draft roadmap is ready reuses those items. The roadmap_items segment is estimated
at $0, nothing is submitted for it, and its stop opens at once on the draft's items; the
knob ``reuse_draft_items: false`` derives them again as before. Against Postgres with the
FakeRuntime."""

import pytest
from sqlalchemy import select

from oracle.models import AuditEvent
from oracle.roadmap.models import RoadmapItem
from oracle.swarm import FakeRuntime, Outcome, set_runtime
from oracle.tenancy import tenant_session
from tests.fixtures import draft, import_draft, seed_auth
from tests.test_draft_roadmaps import (
    derivations_start,  # noqa: F401 - autouse fixture
    items_file,
    rows,
)
from tests.test_draft_roadmaps import tick as tick_ok
from tests.test_roadmap import ROADMAP_MD, create, get, pending, verified_estimate

PRD = "checkout-redesign"


@pytest.fixture
def runtime():
    fake = FakeRuntime()
    set_runtime(fake)
    yield fake
    set_runtime(None)


@pytest.fixture
async def owner():
    return await seed_auth()


async def approved_with_draft_items(client, auth, runtime, tenant_id) -> None:
    """checkout-redesign v1 with its draft items derived (2 items), then approved."""
    assert (await import_draft(client, auth, draft("prd_v1.md"))).status_code == 201
    await verified_estimate(client, auth)
    runtime.script["roadmap_items"] = [Outcome(artifacts={"roadmap_items.yaml": items_file(1)})]
    await tick_ok(client, auth)
    await tick_ok(client, auth)
    assert (await rows(tenant_id))[1].status == "ready"
    resp = await client.post(f"/v1/documents/{PRD}/versions/1/approve", headers=auth)
    assert resp.status_code == 200, resp.text
    runtime.submitted.clear()
    runtime.script["roadmap_items"] = [Outcome(artifacts={"roadmap_items.yaml": items_file(1)})]
    runtime.script["roadmap_draft"] = [Outcome(artifacts={"roadmap.md": ROADMAP_MD})]


async def estimate(client, headers, run) -> dict:
    resp = await client.post(f"/v1/runs/{run['id']}/estimate", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def test_the_items_segment_is_estimated_at_zero_unless_derived_again(client, owner, runtime):
    """protects: criterion 21 (estimate), a ready draft makes the items step free and the
    knob brings back today's $5.50; fails_when: the reused segment costs anything, the
    total is not $9.00, or reuse_draft_items false still reuses; no_claim: the note's
    exact date format."""
    tenant_id, auth = owner
    await approved_with_draft_items(client, auth, runtime, tenant_id)
    run = await create(client, auth, source=PRD)
    assert run["knobs"]["reuse_draft_items"] is True
    est = await estimate(client, auth, run)
    items, draft_seg = est["segments"]
    assert items["name"] == "roadmap_items" and items["estimate_usd"] == 0
    assert items["reused"] is True and items["reused_from_version"] == 1
    assert items["note"].startswith("Reused: the roadmap items of v1, derived ")
    assert draft_seg["estimate_usd"] == 9.0 and est["total_usd"] == 9.0
    resp = await client.patch(
        f"/v1/runs/{run['id']}", json={"knobs": {"reuse_draft_items": False}}, headers=auth
    )
    assert resp.status_code == 200, resp.text
    assert (await get(client, auth, run["id"]))["knobs"]["reuse_draft_items"] is False
    est = await estimate(client, auth, run)
    assert est["segments"][0]["estimate_usd"] == 5.5 and not est["segments"][0]["reused"]
    assert est["total_usd"] == 14.5


async def test_starting_opens_the_items_stop_on_the_draft_items(client, owner, runtime):
    """protects: criterion 21 (start), the stop opens at once on the draft's items and no
    workflow runs for them; approving it writes only the roadmap document; fails_when: a
    workflow is submitted for roadmap_items, the stop waits for a tick, or the keys or
    horizons differ from the draft's; no_claim: the roadmap draft's content."""
    tenant_id, auth = owner
    await approved_with_draft_items(client, auth, runtime, tenant_id)
    run = await create(client, auth, source=PRD)
    await estimate(client, auth, run)
    resp = await client.post(f"/v1/runs/{run['id']}/start", headers=auth)
    assert resp.status_code == 200, resp.text
    assert runtime.submitted == []
    run = await get(client, auth, run["id"])
    assert run["status"] == "awaiting_checkpoint" and run["waiting_on"] == "roadmap_items"
    seg = run["segments"][0]
    assert seg["status"] == "succeeded" and seg["cost_usd"] == 0
    assert seg["artifacts"] == ["roadmap_items.yaml"]
    assert seg["items_check"]["problems"] == []
    assert pending(run)["payload"]["items_check"]["by_horizon"] == {
        "now": 1,
        "next": 1,
        "later": 0,
    }
    async with tenant_session(tenant_id) as s:
        drafted = [
            (i.item_key, i.horizon)
            for i in await s.scalars(
                select(RoadmapItem)
                .where(RoadmapItem.draft_roadmap_id.is_not(None))
                .order_by(RoadmapItem.position)
            )
        ]
        audits = list(
            await s.scalars(select(AuditEvent).where(AuditEvent.action == "run.items_reused"))
        )
    assert drafted == [("payment-step", "now"), ("shipping-step", "next")]
    assert len(audits) == 1 and audits[0].data["version"] == 1
    resp = await client.get(
        f"/v1/runs/{run['id']}/segments/1/artifacts/roadmap_items.yaml", headers=auth
    )
    assert resp.status_code == 200, resp.text
    assert "id: payment-step" in resp.text and "horizon: next" in resp.text
    resp = await client.post(
        f"/v1/runs/{run['id']}/checkpoints/{pending(run)['id']}/decide",
        json={"decision": "approved"},
        headers=auth,
    )
    assert resp.status_code == 200, resp.text
    (spec,) = runtime.submitted
    assert spec.outputs == ("roadmap.md",)
    prompt = spec.steps[-1].prompt
    assert "--- roadmap_items.yaml ---" in prompt
    assert "id: payment-step" in prompt and "id: shipping-step" in prompt
    assert "date: '2026-11-30'" in prompt or "date: 2026-11-30" in prompt


async def test_derive_again_or_no_ready_draft_runs_the_items_step(client, owner, runtime):
    """protects: criterion 21 (fallback), with reuse_draft_items false, or a version whose
    draft items are not ready, the items step runs as today; fails_when: a reused segment
    appears, or nothing is submitted for roadmap_items; no_claim: the agents' output."""
    tenant_id, auth = owner
    await approved_with_draft_items(client, auth, runtime, tenant_id)
    run = await create(client, auth, source=PRD, knobs={"reuse_draft_items": False})
    assert run["knobs"]["reuse_draft_items"] is False
    est = await estimate(client, auth, run)
    assert est["total_usd"] == 14.5
    resp = await client.post(f"/v1/runs/{run['id']}/start", headers=auth)
    assert resp.status_code == 200, resp.text
    (spec,) = runtime.submitted
    assert spec.outputs == ("roadmap_items.yaml",)
    # A ready draft with no items reused: derive v1 again, so it is queued (not ready).
    resp = await client.post(f"/v1/documents/{PRD}/versions/1/roadmap-items/derive", headers=auth)
    assert resp.status_code == 202, resp.text
    run = await create(client, auth, source=PRD)
    est = await estimate(client, auth, run)
    assert est["total_usd"] == 14.5 and not est["segments"][0]["reused"]
