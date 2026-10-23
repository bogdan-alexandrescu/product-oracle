"""C7 Scope review: a console approval held while a blocking reason is open (D3 Approve
blocked by problems, "Console gate", decided 2026-10-20), confirmed once the approver
waives it from the review screen, against the fake SwarmCloud.

Test card (criterion 2): protects=a counted console approval stays pending with
console.needs = "confirm" and confirm is 409 blocking_open while the depends_on_excluded
reason is open; after a D8 waive with a note, confirm approves the checkpoint and the
scope, and the approval audit lists the waived code; fails_when=confirm passes with the
reason open, stays refused after the waiver, or the audit misses the waiver;
no_claim=what SwarmCloud's workflow does with its own console answer.
"""

import uuid
from datetime import timedelta

from sqlalchemy import select

from oracle.models import AuditEvent
from oracle.runs import service
from oracle.swarm import set_runtime
from oracle.tenancy import tenant_session
from tests.swarmcloud_fake import FakeSwarmCloud
from tests.test_adapter_v2 import _member, owner, settings  # noqa: F401 - fixtures
from tests.test_prd_scope import BLOCKING, DOC, propose_feature, scopes, seed_baseline
from tests.test_runs import decide, get, pending, started, tick


async def test_held_console_approval_confirms_after_a_waiver(client, owner, monkeypatch):  # noqa: F811
    tenant_id, auth = owner
    await seed_baseline(tenant_id)
    swarm = FakeSwarmCloud(mcp=True, await_input=True, service_answer=True)
    set_runtime(swarm.runtime())
    try:
        swarm.step_files["feature_set-2-architect"] = {"feature_set.yaml": BLOCKING}
        await _member(tenant_id, "lead@example.com")
        run = await started(client, auth, document=DOC)
        await propose_feature(tenant_id, run["id"])
        await tick(client, auth)
        run = await decide(client, auth, await get(client, auth, run["id"]))
        await tick(client, auth)
        await tick(client, auth)
        run = await get(client, auth, run["id"])
        assert run["waiting_on"] == "feature_set", run
        cp = pending(run)
        wf = cp["payload"]["wait"]["workflow_id"]
        swarm.console_answer(wf, "feature_set-review1", "MERGE", by="lead@example.com")
        real_now = service._now
        monkeypatch.setattr(service, "_now", lambda: real_now() + timedelta(seconds=61))
        await tick(client, auth)
        run = await get(client, auth, run["id"])
        cp = next(c for c in run["checkpoints"] if c["id"] == cp["id"])
        assert cp["status"] == "pending" and cp["console"]["needs"] == "confirm"
        base = f"/v1/runs/{run['id']}/checkpoints/{cp['id']}"
        resp = await client.post(f"{base}/decide", json={"decision": "confirm"}, headers=auth)
        assert resp.status_code == 409, resp.text
        assert resp.json()["detail"]["code"] == "blocking_open"

        resp = await client.post(
            f"{base}/actions",
            json={"item_key": "saved-addresses", "kind": "waive",
                  "answers": ["depends_on_excluded"],
                  "value": {"reason": "Address sharing ships in the same release"}},
            headers=auth,
        )  # fmt: skip
        assert resp.status_code == 200, resp.text
        revision = resp.json()["revision"]
        resp = await client.post(
            f"{base}/decide",
            json={"decision": "confirm", "expected_revision": revision},
            headers=auth,
        )
        assert resp.status_code == 200, resp.text
        cp = next(c for c in resp.json()["checkpoints"] if c["id"] == cp["id"])
        assert cp["status"] == "approved"
        (scope,) = await scopes(tenant_id, run["id"])
        assert scope.status == "approved"
        async with tenant_session(tenant_id) as s:
            event = await s.scalar(
                select(AuditEvent).where(
                    AuditEvent.action == "prd_scope.approved",
                    AuditEvent.entity_id == scope.id,
                )
            )
        assert event is not None and event.data["waived"] == ["depends_on_excluded"]
        assert event.data["checkpoint_id"] == str(uuid.UUID(cp["id"]))
    finally:
        set_runtime(None)
