"""The cost policy as decided (P3, P3c): an estimate above $50 waits for an owner; the
budget gates the estimate; spend past 1.5x the estimate pauses the run after the
running segment, which keeps its output, and an owner resumes or cancels (build prompt
§1, §8.9, §16.16)."""

from decimal import Decimal

import pytest

from oracle.runs import flows
from oracle.swarm import FakeRuntime, Outcome, set_runtime
from tests.fixtures import seed_auth
from tests.legacy.helpers import DOC, fixture, import_md, user_cookie

# Base role costs summing to 25, doubled by deep depth: exactly $50.
ROLES_AT_50 = {
    "baseline": ["researcher"],
    "feature_set": ["researcher"],
    "priority": ["prioritizer", "analyst"],
    "prd_draft": ["writer", "critic", "prioritizer"],
}


@pytest.fixture
def runtime():
    fake = FakeRuntime()
    set_runtime(fake)
    yield fake
    set_runtime(None)


async def _create(client, headers, **body) -> dict:
    body.setdefault("flow", "baseline_to_prd")
    if body["flow"] == "baseline_to_prd":
        body.setdefault("document", "legacy-cost-prd")
    resp = await client.post("/v1/runs", json=body, headers=headers)
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _estimate(client, headers, run) -> dict:
    resp = await client.post(f"/v1/runs/{run['id']}/estimate", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _tick(client, headers) -> dict:
    resp = await client.post("/v1/internal/tick", headers=headers)
    assert resp.status_code == 200 and resp.json()["errors"] == [], resp.text
    return resp.json()


async def _get(client, headers, run) -> dict:
    return (await client.get(f"/v1/runs/{run['id']}", headers=headers)).json()


def test_the_thresholds_are_the_decided_ones():
    assert flows.APPROVAL_THRESHOLD_USD == Decimal(50)
    assert flows.OVERRUN_FACTOR == Decimal("1.5")


async def test_over_50_waits_for_an_owner_and_only_an_owner_approves(client, runtime):
    tenant_id, owner = await seed_auth()
    approver = await user_cookie(tenant_id, "approver")
    run = await _create(client, approver, knobs={"depth": "deep"})
    est = await _estimate(client, approver, run)
    assert est["total_usd"] > 50 and est["needs_approval"] is True
    assert est["approval_threshold_usd"] == 50.0

    started = await client.post(f"/v1/runs/{run['id']}/start", headers=approver)
    assert started.json()["status"] == "awaiting_approval"
    assert runtime.submitted == []  # nothing dispatched before the owner approves
    assert (await _tick(client, owner))["runs_checked"] == 0
    inbox = (await client.get("/v1/inbox", headers=owner)).json()
    assert [r["id"] for r in inbox["approvals"]] == [run["id"]]

    denied = await client.post(f"/v1/runs/{run['id']}/approve", headers=approver)
    assert denied.status_code == 403
    approved = await client.post(f"/v1/runs/{run['id']}/approve", headers=owner)
    assert approved.status_code == 200 and approved.json()["status"] == "running"
    assert len(runtime.submitted) == 1


async def test_exactly_50_starts_without_approval(client, runtime):
    _, owner = await seed_auth()
    run = await _create(client, owner, knobs={"depth": "deep", "roles": ROLES_AT_50})
    est = await _estimate(client, owner, run)
    assert est["total_usd"] == 50.0 and est["needs_approval"] is False
    started = await client.post(f"/v1/runs/{run['id']}/start", headers=owner)
    assert started.json()["status"] == "running"
    assert started.json()["overrun_ceiling_usd"] == pytest.approx(75.0)


async def test_the_budget_gates_the_estimate(client, runtime):
    _, owner = await seed_auth()
    run = await _create(client, owner, knobs={"budget_usd": 20})
    assert (await _estimate(client, owner, run))["within_budget"] is False
    resp = await client.post(f"/v1/runs/{run['id']}/start", headers=owner)
    assert resp.status_code == 422 and "budget" in resp.json()["detail"]
    assert runtime.submitted == []


async def test_overrun_pauses_after_the_segment_and_only_an_owner_resumes(client, runtime):
    tenant_id, owner = await seed_auth()
    approver = await user_cookie(tenant_id, "approver")
    runtime.script["baseline"] = [Outcome(cost_usd=Decimal(50), polls=1)]
    run = await _create(client, owner)
    estimate = (await _estimate(client, owner, run))["total_usd"]
    started = await client.post(f"/v1/runs/{run['id']}/start", headers=owner)
    ceiling = started.json()["overrun_ceiling_usd"]
    assert ceiling == pytest.approx(estimate * 1.5) and ceiling < 50

    await _tick(client, owner)  # half the segment's cost so far: below the ceiling
    assert (await _get(client, owner, run))["status"] == "running"
    assert (await _tick(client, owner))["runs_paused"] == 1
    paused = await _get(client, owner, run)
    assert paused["status"] == "paused_overrun"
    # The running segment finished and keeps its output; nothing further started.
    assert paused["segments"][0]["status"] == "succeeded"
    assert paused["checkpoints"] == []
    assert len(runtime.submitted) == 1
    inbox = (await client.get("/v1/inbox", headers=owner)).json()
    assert [r["id"] for r in inbox["overruns"]] == [run["id"]]

    assert (await client.post(f"/v1/runs/{run['id']}/resume", headers=approver)).status_code == 403
    resumed = await client.post(f"/v1/runs/{run['id']}/resume", headers=owner)
    assert resumed.status_code == 200, resumed.text
    assert resumed.json()["overrun_ceiling_usd"] == pytest.approx(50 + estimate * 0.5)
    assert resumed.json()["status"] == "awaiting_checkpoint"


async def test_an_owner_cancels_a_paused_run(client, runtime):
    _, owner = await seed_auth()
    runtime.script["baseline"] = [Outcome(cost_usd=Decimal(50), polls=1)]
    run = await _create(client, owner)
    await _estimate(client, owner, run)
    await client.post(f"/v1/runs/{run['id']}/start", headers=owner)
    await _tick(client, owner)
    await _tick(client, owner)
    assert (await _get(client, owner, run))["status"] == "paused_overrun"
    resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=owner)
    assert resp.status_code == 200 and resp.json()["status"] == "cancelled"


async def test_the_roadmap_flow_has_the_same_approval_gate(client, runtime):
    tenant_id, owner = await seed_auth()
    assert (await import_md(client, owner, fixture("legacy_prd_v1.md"))).status_code == 201
    approve = await client.post(f"/v1/documents/{DOC}/versions/1/approve", headers=owner)
    assert approve.status_code == 200
    approver = await user_cookie(tenant_id, "approver")
    roles = {
        "roadmap_items": ["researcher", "analyst", "architect", "prioritizer"],
        "roadmap_draft": ["writer", "critic", "researcher", "architect"],
    }
    run = await _create(
        client, approver, flow="prd_to_roadmap", source=DOC, knobs={"depth": "deep", "roles": roles}
    )
    est = await _estimate(client, approver, run)
    assert est["total_usd"] > 50 and est["needs_approval"] is True
    started = await client.post(f"/v1/runs/{run['id']}/start", headers=approver)
    assert started.json()["status"] == "awaiting_approval"
    assert runtime.submitted == []
    assert (await client.post(f"/v1/runs/{run['id']}/approve", headers=approver)).status_code == 403
