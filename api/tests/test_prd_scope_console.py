"""C6 Feature set: a console approval while a blocking problem is open (D3 Approve
blocked by problems, "Console gate", decided 2026-10-20), against the fake SwarmCloud.

Test card: protects=a counted console approval is recorded, not followed: the checkpoint
stays pending with console.needs = "confirm", nothing is posted to the workflow, the run
token stays read-only, and confirm is refused while the problem is open;
fails_when=the checkpoint is approved, the scope approved, or the token may write;
no_claim=what SwarmCloud's workflow does with its own console answer.
"""

import uuid
from datetime import timedelta

import pytest

from oracle.runs import service
from oracle.runs.models import Checkpoint
from oracle.swarm import set_runtime
from oracle.tenancy import tenant_session
from tests.swarmcloud_fake import FakeSwarmCloud
from tests.test_adapter_v2 import _member, owner, settings  # noqa: F401 - fixtures
from tests.test_prd_scope import (
    BLOCKING,
    DOC,
    ONLY_IN_THE_FILE,
    propose_feature,
    scopes,
    seed_baseline,
)
from tests.test_runs import decide, get, pending, started, tick


@pytest.mark.parametrize("case", ["depends_on_excluded", "duplicate_key", "no_goals", "keyless"])
async def test_console_approval_with_blocking_is_recorded_not_followed(
    client,
    owner,  # noqa: F811
    monkeypatch,
    case,
):
    """Also when the problem is one only the file shows (a duplicate key, a feature without
    goals or without a key): the re-check before the console approval keeps it."""
    tenant_id, auth = owner
    text = BLOCKING if case == "depends_on_excluded" else ONLY_IN_THE_FILE[case][0]
    await seed_baseline(tenant_id)
    swarm = FakeSwarmCloud(mcp=True, await_input=True, service_answer=True)
    set_runtime(swarm.runtime())
    try:
        swarm.step_files["feature_set-2-architect"] = {"feature_set.yaml": text}
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
        assert cp["cannot_approve"].startswith("1 blocking problem left")
        wf = cp["payload"]["wait"]["workflow_id"]
        posted = len(swarm.answers)
        swarm.console_answer(wf, "feature_set-review1", "MERGE", by="lead@example.com")
        # The tick reads a waiting step at most once a minute: a minute later.
        real_now = service._now
        monkeypatch.setattr(service, "_now", lambda: real_now() + timedelta(seconds=61))
        await tick(client, auth)
        run = await get(client, auth, run["id"])
        cp = next(c for c in run["checkpoints"] if c["id"] == cp["id"])
        assert cp["status"] == "pending"
        assert cp["console"]["needs"] == "confirm"
        assert cp["console"]["reason"] == (
            "Blocking problems are open: fix or waive them, then confirm"
        )
        assert len(swarm.answers) == posted  # nothing posted to the workflow
        async with tenant_session(tenant_id) as s:
            assert await service.token_hold(s, uuid.UUID(run["id"]), live=False) is not None
            row = await s.get(Checkpoint, uuid.UUID(cp["id"]))
            assert row.status == "pending"
        resp = await client.post(
            f"/v1/runs/{run['id']}/checkpoints/{cp['id']}/decide",
            json={"decision": "confirm"},
            headers=auth,
        )
        assert resp.status_code == 409, resp.text
        assert resp.json()["detail"]["code"] == "blocking_open"
        (scope,) = await scopes(tenant_id, run["id"])
        assert scope.status == "proposed"
    finally:
        set_runtime(None)
