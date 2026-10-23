"""C8 Priority order snapshot: a console approval of the priority stop while a blocking
problem is open (D3 Approve blocked by problems, "Console gate", decided 2026-10-20), against
the fake SwarmCloud.

Test card: protects=a counted console approval is recorded, not followed: the checkpoint
stays pending with console.needs = "confirm", nothing is posted to the workflow, the run
token stays read-only, and confirm is refused while the problem is open;
fails_when=the checkpoint is approved, the snapshot saved, an answer is posted, or the
token may write; no_claim=what SwarmCloud's workflow does with its own console answer.
"""

import uuid
from datetime import timedelta

from oracle.runs import service
from oracle.swarm import set_runtime
from oracle.tenancy import tenant_session
from tests.swarmcloud_fake import FakeSwarmCloud
from tests.test_adapter_v2 import _member, owner, settings  # noqa: F401 - fixtures
from tests.test_prd_scope import CLEAN, DOC, propose_feature
from tests.test_priority_run_order import BLOCKED, BLOCKING, seed_baseline, snapshots
from tests.test_runs import decide, get, pending, started, tick

# The Engineering check (on by default) briefs CLEAN's features; decide stages verdicts.
BRIEFS = "version: 1\ncode_map: {used: false, repos: []}\nfeatures:\n" + "".join(
    f"  - feature: {key}\n    title: {key}\n    approach: Reuse the address book\n"
    "    touches: []\n    reuse: []\n    risks: []\n    questions: []\n"
    "    size: m\n    depends_on: []\n    assumptions: [An address book exists]\n"
    for key in ("saved-addresses", "address-lookup", "bulk-edit")
)


async def test_console_approval_with_blocking_is_held(client, owner, monkeypatch):  # noqa: F811
    tenant_id, auth = owner
    await seed_baseline(tenant_id)
    swarm = FakeSwarmCloud(mcp=True, await_input=True, service_answer=True)
    set_runtime(swarm.runtime())
    try:
        swarm.step_files["feature_set-2-architect"] = {"feature_set.yaml": CLEAN}
        swarm.step_files["eng_review-1-architect"] = {"tech_briefs.yaml": BRIEFS}
        swarm.step_files["priority-1-prioritizer"] = {"priority.yaml": BLOCKING}
        await _member(tenant_id, "lead@example.com")
        run = await started(client, auth, document=DOC)
        await propose_feature(tenant_id, run["id"])
        for _ in range(8):
            await tick(client, auth)
            run = await get(client, auth, run["id"])
            if run["waiting_on"] == "priority_order":
                break
            if run["status"] == "awaiting_checkpoint" and pending(run).get("can_decide"):
                run = await decide(client, auth, run)
        assert run["waiting_on"] == "priority_order", run
        cp = pending(run)
        assert cp["cannot_approve"] == BLOCKED
        wf = cp["payload"]["wait"]["workflow_id"]
        posted = len(swarm.answers)
        swarm.console_answer(wf, "priority-review1", "MERGE", by="lead@example.com")
        real_now = service._now
        monkeypatch.setattr(service, "_now", lambda: real_now() + timedelta(seconds=61))
        await tick(client, auth)
        run = await get(client, auth, run["id"])
        cp = next(c for c in run["checkpoints"] if c["id"] == cp["id"])
        assert cp["status"] == "pending"
        assert cp["console"]["needs"] == "confirm"
        assert cp["console"]["reason"] == service.CONSOLE_BLOCKED
        assert len(swarm.answers) == posted
        async with tenant_session(tenant_id) as s:
            assert await service.token_hold(s, uuid.UUID(run["id"]), live=False) is not None
        resp = await client.post(
            f"/v1/runs/{run['id']}/checkpoints/{cp['id']}/decide",
            json={"decision": "confirm"},
            headers=auth,
        )
        assert resp.status_code == 409, resp.text
        detail = resp.json()["detail"]
        assert detail["code"] == "blocking_open"
        assert detail["message"] == BLOCKED
        assert [(x["item"], x["code"]) for x in detail["left"]] == [
            ("saved-addresses", "before_prerequisite")
        ]
        (snap,) = await snapshots(tenant_id, run["id"])
        assert snap.status == "proposed"
    finally:
        set_runtime(None)
