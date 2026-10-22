"""B1 Build the baseline: the ``baseline`` flow, its one segment, no document, one at a time.

Runs against Postgres with the FakeRuntime standing in for SwarmCloud (its baseline.yaml
is the one feature it always writes, or a test's own). Nothing here proves the web draws
it (web/e2e/baseline-build.spec.ts).
"""

from dataclasses import fields

import pytest
from sqlalchemy import func, select

from oracle.docs.models import Document
from oracle.runs import flows
from oracle.swarm import Outcome
from oracle.tenancy import tenant_session
from tests.test_runs import RUN_BASELINE, as_user, decide, get, tick
from tests.test_runs import owner as owner  # (tenant id, owner token headers)
from tests.test_runs import runtime as runtime  # the FakeRuntime fixture

NO_DOCUMENT = "the Build the baseline flow writes no document"


async def create(client, headers, **knobs):
    resp = await client.post("/v1/runs", json={"flow": "baseline", "knobs": knobs}, headers=headers)
    assert resp.status_code == 201, resp.text
    return resp.json()


async def estimate(client, headers, run_id):
    resp = await client.post(f"/v1/runs/{run_id}/estimate", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def started(client, headers, **knobs):
    run = await create(client, headers, **knobs)
    await estimate(client, headers, run["id"])
    resp = await client.post(f"/v1/runs/{run['id']}/start", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def documents(tenant_id) -> int:
    async with tenant_session(tenant_id) as s:
        return await s.scalar(select(func.count()).select_from(Document))


# --------------------------------------------------------------------------- the flow


def test_the_baseline_flow_is_the_baseline_segment_alone():
    # protects=one built-in flow, one segment, no document, its D12 pointer; fails_when=the
    # flow has another segment, writes a document or is offered in the New run dialog;
    # no_claim=the segment's prompt (unchanged, owned by baseline_to_prd's tests).
    flow = flows.FLOWS["baseline"]
    assert flow.title == "Build the baseline"
    assert [s.name for s in flow.segments] == ["baseline"]
    assert flow.segments[0].checkpoint == "baseline_confirm"
    assert flow.writes_document is False and flow.target_kind is None
    assert flow.requires_document is False and flow.source_kind is None
    assert flow.in_new_run_dialog is False
    assert flow.starts_from == ("Build the baseline · Baseline", "/baseline?build=1")


def test_baseline_to_prd_shares_the_one_baseline_segment():
    # protects=the two flows can never drift (criterion 9); fails_when=baseline_to_prd's
    # first segment differs from the new flow's in any field, or it loses a segment;
    # no_claim=the later segments' content.
    b2p = flows.FLOWS["baseline_to_prd"]
    assert len(b2p.segments) == 4
    assert b2p.segments[0] is flows.BASELINE_SEGMENT
    assert flows.FLOWS["baseline"].segments == (flows.BASELINE_SEGMENT,)
    for f in fields(flows.SegmentDef):
        assert getattr(b2p.segments[0], f.name) == getattr(flows.BASELINE_SEGMENT, f.name)
    assert flows.BASELINE_SEGMENT.imports_baseline is True
    assert flows.BASELINE_SEGMENT.roles == ("researcher", "analyst")


async def test_the_catalog_lists_build_the_baseline(client, owner, runtime):
    # protects=GET /v1/flows (criterion 1); fails_when=the flow, its segment, its
    # writes_document or its pointer line is missing, or an existing flow reports
    # writes_document false; no_claim=how the web draws the catalog.
    _, auth = owner
    resp = await client.get("/v1/flows", headers=auth)
    assert resp.status_code == 200, resp.text
    by_key = {f["key"]: f for f in resp.json()["flows"]}
    flow = by_key["baseline"]
    assert flow["title"] == "Build the baseline"
    assert flow["description"] == (
        "Read the sources and propose goals, products, features, constraints and evidence "
        "for you to review."
    )
    assert flow["requires_document"] is False and flow["writes_document"] is False
    assert flow["target_kind"] is None and flow["source_kind"] is None
    assert [(s["name"], s["checkpoint"]) for s in flow["segments"]] == [
        ("baseline", "baseline_confirm")
    ]
    assert flow["in_new_run_dialog"] is False
    assert flow["starts_from"] == {
        "label": "Build the baseline · Baseline",
        "href": "/baseline?build=1",
    }
    for key in ("baseline_to_prd", "feedback_loop", "prd_to_roadmap"):
        assert by_key[key]["writes_document"] is True


# --------------------------------------------------------------------------- create


async def test_an_approver_creates_a_run_with_no_document(client, owner, runtime):
    # protects=POST /v1/runs {"flow": "baseline"} (criterion 2); fails_when=an approver is
    # refused, the run names a document, or a commenter may create one; no_claim=MCP
    # clients (same operation).
    tenant_id, _ = owner
    approver = await as_user(tenant_id, "approver")
    run = await create(client, approver, depth="standard", checkpoints={"baseline_confirm": True})
    assert run["flow"] == "baseline" and run["flow_title"] == "Build the baseline"
    assert run["status"] == "draft"
    assert run["document_id"] is None and run["document_slug"] is None
    assert [s["name"] for s in run["segments"]] == ["baseline"]

    commenter = await as_user(tenant_id, "commenter")
    resp = await client.post("/v1/runs", json={"flow": "baseline"}, headers=commenter)
    assert resp.status_code == 403, resp.text


@pytest.mark.parametrize(
    "extra",
    [
        {"document": "anything"},
        {"source": "example-prd"},
        {"source_version": 1},
        {"template": "now-next-later"},
        {"theme": "roadmap-board"},
    ],
)
async def test_a_document_source_template_or_theme_is_refused(client, owner, runtime, extra):
    # protects=the flow writes and reads no document (criterion 3); fails_when=any of the
    # five inputs is accepted or answers another message; no_claim=PATCH (same check).
    _, auth = owner
    resp = await client.post("/v1/runs", json={"flow": "baseline", **extra}, headers=auth)
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"] == NO_DOCUMENT


async def test_the_estimate_follows_the_depth(client, owner, runtime):
    # protects=the start sheet's figure (criterion 4): $3.50 / $7.00 / $14.00 at default
    # roles; fails_when=the flow costs more segments than its one, or depth is ignored;
    # no_claim=what SwarmCloud bills.
    _, auth = owner
    for depth, total in (("quick", 3.5), ("standard", 7.0), ("deep", 14.0)):
        run = await create(client, auth, depth=depth)
        body = await estimate(client, auth, run["id"])
        assert body["total_usd"] == total
        assert body["needs_approval"] is False
        assert [(s["seq"], s["name"], s["title"], s["roles"]) for s in body["segments"]] == [
            (1, "baseline", "Baseline proposal", ["researcher", "analyst"])
        ]


# --------------------------------------------------------------------------- running


async def test_baseline_run_writes_no_document(client, owner, runtime):
    # protects=a baseline run never creates a document (criteria 5 and 8); fails_when=
    # approving the checkpoint creates or names a document, the run does not stop at
    # Confirm the baseline, or its entities and proposals lack the run's id; no_claim=the
    # fake runtime stands in for SwarmCloud.
    tenant_id, auth = owner
    resp = await client.post(
        "/v1/baseline/entities",
        json={"type": "feature", "key": "checkout", "title": "Checkout"},
        headers=auth,
    )
    assert resp.status_code == 201, resp.text
    runtime.script["baseline"] = [
        Outcome(artifacts={"baseline.yaml": RUN_BASELINE, "summary.md": "# Summary\n"})
    ]
    run = await started(client, auth)
    assert run["snapshot_id"] is not None  # the sources pinned at start (S4)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "awaiting_checkpoint" and run["waiting_on"] == "baseline_confirm"
    cps = run["checkpoints"]
    assert [(c["kind"], c["status"]) for c in cps] == [("baseline_confirm", "pending")]
    assert "baseline_import" in cps[0]["payload"]

    graph = (await client.get("/v1/baseline/graph", headers=auth)).json()
    by_key = {e["key"]: e for e in graph["entities"]}
    assert by_key["guided-setup"]["run_id"] == run["id"]
    assert by_key["activation"]["run_id"] == run["id"]
    proposals = (await client.get("/v1/baseline/proposals", headers=auth)).json()
    assert [p["run_id"] for p in proposals] == [run["id"]]

    run = await decide(client, auth, run)
    assert run["status"] == "succeeded"
    assert run["document_id"] is None and run["document_slug"] is None
    assert await documents(tenant_id) == 0


async def test_request_changes_reruns_the_segment(client, owner, runtime):
    # protects=Request changes re-runs the one segment with the note, as today;
    # fails_when=the run ends or moves on; no_claim=what the agents do with the note.
    _, auth = owner
    run = await started(client, auth)
    await tick(client, auth)
    run = await decide(client, auth, await get(client, auth, run["id"]), "changes_requested", "x")
    assert run["status"] == "running"
    assert run["segments"][0]["attempts"][-1]["note"] == "x"


async def test_review_off_finishes_after_the_import(client, owner, runtime):
    # protects=the Stop for my review knob (criterion 6); fails_when=the run waits, the
    # checkpoint is not recorded skipped, or a goal lands confirmed; no_claim=the web.
    _, auth = owner
    runtime.script["baseline"] = [
        Outcome(artifacts={"baseline.yaml": RUN_BASELINE, "summary.md": "# Summary\n"})
    ]
    run = await started(client, auth, checkpoints={"baseline_confirm": False})
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "succeeded"
    assert [(c["kind"], c["status"]) for c in run["checkpoints"]] == [
        ("baseline_confirm", "skipped")
    ]
    graph = (await client.get("/v1/baseline/graph", headers=auth)).json()
    goal = next(e for e in graph["entities"] if e["key"] == "activation")
    assert goal["status"] == "proposed"  # only a person confirms a goal


async def test_second_baseline_build_refused(client, owner, runtime):
    # protects=one build at a time (criterion 7); fails_when=two runs reach running, the
    # 409 does not name the first run, or a build after the first ended is refused;
    # no_claim=does not test two builds racing in separate transactions at the same
    # instant (the check runs under the run row lock of the request).
    _, auth = owner
    waiting = await create(client, auth)  # a draft is not under way
    await estimate(client, auth, waiting["id"])
    first = await started(client, auth)
    assert first["status"] == "running"
    refusal = f"A baseline build is already under way (run {first['id']})"

    resp = await client.post("/v1/runs", json={"flow": "baseline"}, headers=auth)
    assert resp.status_code == 409 and resp.json()["detail"] == refusal
    resp = await client.post(f"/v1/runs/{waiting['id']}/start", headers=auth)
    assert resp.status_code == 409 and resp.json()["detail"] == refusal

    await tick(client, auth)
    first = await get(client, auth, first["id"])
    assert first["status"] == "awaiting_checkpoint"
    resp = await client.post("/v1/runs", json={"flow": "baseline"}, headers=auth)
    assert resp.status_code == 409 and resp.json()["detail"] == refusal
    # Another flow is not held up by a build.
    resp = await client.post(
        "/v1/runs", json={"flow": "baseline_to_prd", "document": "example-prd"}, headers=auth
    )
    assert resp.status_code == 201, resp.text

    await decide(client, auth, first)
    resp = await client.post(f"/v1/runs/{waiting['id']}/start", headers=auth)
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "running"
