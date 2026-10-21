"""PR #128: an Inbox checkpoint decision is recorded, then delivered to the run's workflow
("decide then post"). Owner decisions, 2026-10-20: a recorded decision is final (a second
decision through Oracle gets 409 "already decided"), and a decision not delivered yet is
shown on the run page and in the Inbox. Synthetic placeholders only."""

import httpx
import pytest

from tests.fixtures import seed_auth
from tests.test_adapter_v2 import _decide_raw, _waiting, on
from tests.test_adapter_v2 import settings as _v2_settings
from tests.test_runs import get, pending, started, tick
from tests.test_runs import runtime as runtime  # the FakeRuntime fixture

# The same environment as test_adapter_v2 (Oracle's public URL, default timings).
settings = _v2_settings

_UNAVAILABLE = {"code": "unavailable", "message": "try later", "detail": {"reason": "unavailable"}}


@pytest.fixture
async def owner():
    return await seed_auth()


def _decide_id(client, auth, run_id, cp_id, decision, note=None):
    return client.post(
        f"/v1/runs/{run_id}/checkpoints/{cp_id}/decide",
        json={"decision": decision, "note": note},
        headers=auth,
    )


# --- 1. a recorded decision is final ---------------------------------------------------


@pytest.mark.parametrize("first", ["approved", "changes_requested"])
@pytest.mark.parametrize("second", ["approved", "changes_requested"])
async def test_a_decided_checkpoint_is_not_decided_again(client, owner, runtime, first, second):
    """The same decision repeated, or the other one: 409 "already decided", nothing
    changes."""
    _, auth = owner
    run = await started(client, auth)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    cp = pending(run)
    resp = await _decide_id(client, auth, run["id"], cp["id"], first, "Cite G1")
    assert resp.status_code == 200, resp.text
    submitted = len(runtime.submitted)
    resp = await _decide_id(client, auth, run["id"], cp["id"], second, "Cite G2")
    assert resp.status_code == 409, resp.text
    assert "already decided" in resp.json()["detail"], resp.text
    run = await get(client, auth, run["id"])
    after = next(c for c in run["checkpoints"] if c["id"] == cp["id"])
    assert after["status"] == first and after["note"] == "Cite G1"
    assert len(runtime.submitted) == submitted


@pytest.mark.parametrize("second", ["approved", "changes_requested"])
async def test_a_decision_not_delivered_yet_is_final_too(client, owner, second):
    """SwarmCloud did not take the decision (503): it is recorded, and deciding again,
    the same way or not, gets 409 "already decided". The tick delivers the first one,
    once."""
    tenant_id, auth = owner
    swarm = on()
    run = await _waiting(client, auth, tenant_id, swarm)
    cp = pending(run)
    swarm.fail_next_answer = httpx.Response(503, json=_UNAVAILABLE)
    resp = await _decide_raw(client, auth, run, "changes_requested", "Cover returns")
    assert resp.status_code == 503 and "recorded" in resp.text, resp.text
    resp = await _decide_id(client, auth, run["id"], cp["id"], second, "Something else")
    assert resp.status_code == 409, resp.text
    assert "already decided" in resp.json()["detail"], resp.text
    assert swarm.answers == []
    run = await get(client, auth, run["id"])
    after = next(c for c in run["checkpoints"] if c["id"] == cp["id"])
    assert after["status"] == "changes_requested" and after["note"] == "Cover returns"
    await tick(client, auth)
    assert len(swarm.answers) == 1
    assert swarm.answers[0]["payload"] == {"verdict": "NOT_YET", "findings": ["Cover returns"]}
