"""PR #128: an Inbox checkpoint decision is recorded, then delivered to the run's workflow
("decide then post"). Owner decisions, 2026-10-20: a recorded decision is final (a second
decision through Oracle gets 409 "already decided"), and a decision not delivered yet is
shown on the run page and in the Inbox. Synthetic placeholders only."""

from types import SimpleNamespace

import httpx
import pytest
from sqlalchemy import select

from oracle.models import AuditEvent
from oracle.tenancy import tenant_session
from tests.fixtures import seed_auth
from tests.review_v2_helpers import person
from tests.test_adapter_v2 import _decide_raw, _waiting, on
from tests.test_adapter_v2 import settings as _v2_settings
from tests.test_review_v2_security_3 import member_token
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


# --- B. the decision of a decider who lost standing is not delivered --------------------


async def _lose_standing(client, auth, how: str, user_id, token_id) -> None:
    """Through the API: a disable, a demotion to commenter, or the API token revoked."""
    if how == "disabled":
        resp = await client.post(f"/v1/members/{user_id}/disable", headers=auth)
    elif how == "demoted":
        resp = await client.patch(
            f"/v1/members/{user_id}", json={"role": "commenter"}, headers=auth
        )
    else:
        resp = await client.delete(f"/v1/api-tokens/{token_id}", headers=auth)
    assert resp.status_code in (200, 204), resp.text


async def _voided(tenant_id) -> list[dict]:
    async with tenant_session(tenant_id) as s:
        rows = await s.scalars(
            select(AuditEvent).where(AuditEvent.action == "checkpoint.decision_voided")
        )
        return [e.data for e in rows]


@pytest.mark.parametrize("how", ["disabled", "demoted", "token_revoked"])
async def test_an_owed_decision_of_a_decider_who_lost_standing_is_not_delivered(client, owner, how):
    """Approved; SwarmCloud did not take it (503); the approver is then disabled, demoted,
    or the API token they decided with revoked: the tick posts nothing, the checkpoint
    waits for a decision again, and no segment is queued for it."""
    tenant_id, auth = owner
    swarm = on()
    run = await _waiting(client, auth, tenant_id, swarm)
    approver = await person(tenant_id, "approver", "approver")
    token_id, bearer = await member_token(
        SimpleNamespace(tenant_id=tenant_id), approver.user_id, "approver-agent"
    )
    headers = bearer if how == "token_revoked" else approver.headers
    swarm.fail_next_answer = httpx.Response(503, json=_UNAVAILABLE)
    resp = await _decide_raw(client, headers, run, "approved")
    assert resp.status_code == 503 and "recorded" in resp.text, resp.text
    await _lose_standing(client, auth, how, approver.user_id, token_id)
    await tick(client, auth)
    await tick(client, auth)
    assert swarm.answers == []
    run = await get(client, auth, run["id"])
    assert run["status"] == "awaiting_checkpoint"
    cp = pending(run)
    assert cp["decided_by"] is None
    assert len(swarm.submissions()) == 1
    assert not [s for s in run["segments"] if s["status"] == "pending" and s["error"]]
    # A member's API token acts as the member: the decision is theirs either way.
    assert [v["decided_by"] for v in await _voided(tenant_id)] == [str(approver.user_id)]
    # Another approver decides it; this one is delivered.
    other = await person(tenant_id, "approver", "other")
    resp = await _decide_raw(client, other.headers, run, "approved")
    assert resp.status_code == 200, resp.text
    assert len(swarm.answers) == 1


async def test_a_voided_decision_whose_post_landed_waits_for_an_approver(client, owner):
    """The post landed in SwarmCloud but its response was lost (the decision is owed),
    then the approver is disabled: the tick does not follow the posted answer on its own;
    the checkpoint waits in the Inbox for an approver to confirm it."""
    tenant_id, auth = owner
    swarm = on()
    run = await _waiting(client, auth, tenant_id, swarm)
    approver = await person(tenant_id, "approver", "approver")
    swarm.lose_next_answer = True
    resp = await _decide_raw(client, approver.headers, run, "approved")
    assert resp.status_code == 503 and "recorded" in resp.text, resp.text
    await _lose_standing(client, auth, "disabled", approver.user_id, None)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "awaiting_checkpoint"
    cp = pending(run)
    assert cp["console"]["needs"] == "confirm", cp
    assert len(swarm.answers) == 1 and len(swarm.submissions()) == 1
