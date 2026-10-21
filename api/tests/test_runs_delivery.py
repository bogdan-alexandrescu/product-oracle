"""PR #128: an Inbox checkpoint decision is recorded, then delivered to the run's workflow
("decide then post"). Owner decisions, 2026-10-20: a recorded decision is final (a second
decision through Oracle gets 409 "already decided"), and a decision not delivered yet is
shown on the run page and in the Inbox. Synthetic placeholders only."""

import json
import uuid
from types import SimpleNamespace

import httpx
import pytest
from sqlalchemy import select

from oracle.auth.service import create_api_token
from oracle.models import AuditEvent
from oracle.runs import service
from oracle.runs.models import Checkpoint
from oracle.tenancy import tenant_session
from tests.fixtures import seed_auth
from tests.review_v2_helpers import person
from tests.test_adapter_v2 import _ceiling, _decide_raw, _knobs_of, _waiting, on
from tests.test_adapter_v2 import settings as _v2_settings
from tests.test_adapter_v2_round7 import _wf_cost
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


# --- C. an owed decision does not starve the tick ---------------------------------------


async def _tick_raw(client, auth) -> dict:
    """A tick whose errors the test reads (a post SwarmCloud refuses is one)."""
    resp = await client.post("/v1/internal/tick", headers=auth)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _owed(tenant_id, run_id: str) -> dict | None:
    async with tenant_session(tenant_id) as s:
        cps = await s.scalars(select(Checkpoint).where(Checkpoint.run_id == uuid.UUID(run_id)))
        return next(
            (c.payload["wait"]["posting"] for c in cps if "posting" in c.payload.get("wait", {})),
            None,
        )


async def _refused_decision(client, auth, tenant_id, swarm) -> tuple[dict, dict]:
    """A run whose changes request is recorded and SwarmCloud did not take its post."""
    run = await _waiting(client, auth, tenant_id, swarm)
    cp = pending(run)
    swarm.fail_next_answer = httpx.Response(503, json=_UNAVAILABLE)
    resp = await _decide_raw(client, auth, run, "changes_requested", "Cover returns")
    assert resp.status_code == 503 and "recorded" in resp.text, resp.text
    return run, cp


async def test_the_tick_still_reads_the_run_while_its_decision_post_keeps_failing(client, owner):
    """The tick tries the owed post, then still runs the run's normal pass: the workflow's
    cost is read while SwarmCloud keeps refusing the post. The run is counted once."""
    tenant_id, auth = owner
    swarm = on()
    run, _ = await _refused_decision(client, auth, tenant_id, swarm)
    for _ in range(2):
        swarm.workflows["wf_1"].steps[0].cost += 2.0  # spends while the decision is owed
        swarm.fail_next_answer = httpx.Response(503, json=_UNAVAILABLE)
        out = await _tick_raw(client, auth)
        assert out["runs_checked"] == 1, out
        assert any("recorded" in e for e in out["errors"]), out
        got = await get(client, auth, run["id"])
        assert got["spent_usd"] == pytest.approx(_wf_cost(swarm, "wf_1"))
    assert swarm.answers == [] and (await _owed(tenant_id, run["id"]))["tries"] == 3
    await tick(client, auth)
    assert len(swarm.answers) == 1 and await _owed(tenant_id, run["id"]) is None
    # Delivered, and the same tick's pass followed the workflow on (its revision, then the
    # next round's wait).
    got = await get(client, auth, run["id"])
    assert [c["status"] for c in got["checkpoints"]][:1] == ["changes_requested"]


async def test_an_owed_decision_survives_a_pause_on_overrun_and_resume(client, owner):
    """Owed, the run goes over its ceiling and pauses (its workflow cancelled): the
    decision stays owed; resumed, the run waits on its delivery again, and the tick
    delivers it as a new workflow."""
    tenant_id, auth = owner
    swarm = on()
    run, cp = await _refused_decision(client, auth, tenant_id, swarm)
    await _ceiling(tenant_id, run["id"], "0.01")
    swarm.workflows["wf_1"].steps[0].cost += 1.0
    swarm.fail_next_answer = httpx.Response(503, json=_UNAVAILABLE)
    await _tick_raw(client, auth)
    got = await get(client, auth, run["id"])
    assert got["status"] == "paused_overrun", got["status"]
    assert swarm.workflows["wf_1"].state == "CANCELLED"
    await _tick_raw(client, auth)
    assert await _owed(tenant_id, run["id"]) is not None
    after = next(c for c in got["checkpoints"] if c["id"] == cp["id"])
    assert after["status"] == "changes_requested"
    resp = await client.post(f"/v1/runs/{run['id']}/resume", headers=auth)
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "awaiting_checkpoint"
    await tick(client, auth)
    got = await get(client, auth, run["id"])
    assert got["status"] == "running" and await _owed(tenant_id, run["id"]) is None
    assert len(swarm.submissions()) == 2 and swarm.answers == []
    assert "Cover returns" in json.dumps(swarm.submissions()[1])


async def _redo_not_cancelled(client, auth, tenant_id, swarm) -> dict:
    """A run whose approver chose Redo (on a console verdict Oracle could not read) and
    whose workflow's cancel SwarmCloud did not confirm: the decision is owed."""
    run = await _waiting(client, auth, tenant_id, swarm)
    swarm.console_answer("wf_1", "next_draft-review1", "NOT_YET", ["x"], by="lead@example.com")
    step = swarm.workflows["wf_1"].step("next_draft-review1")
    step.files["review1.json"] = json.dumps({"verdict": "NOT_YET", "findings": ["y" * 300_000]})
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert pending(run)["console"]["needs"] == "unreadable"
    swarm.fail_cancels = 1
    resp = await _decide_raw(client, auth, run, "redo", "Cover refunds")
    assert resp.status_code == 503 and "recorded" in resp.text, resp.text
    return run


async def test_a_redo_whose_cancel_is_not_confirmed_keeps_its_cancel_marker(client, owner):
    """Redo cancels the workflow; SwarmCloud does not confirm the cancel: the decision is
    recorded and the cancel's marker is kept, counted on every try, so a cancel answered
    with 404s that prove nothing reaches the Inbox's Cancel / Stop cancelling."""
    tenant_id, auth = owner
    swarm = on()
    run = await _redo_not_cancelled(client, auth, tenant_id, swarm)
    wf = (await _knobs_of(tenant_id, run["id"]))["workflow"]
    assert wf["state"] == "live" and wf["cancel_pending"]["tries"] == 1, wf
    assert await _owed(tenant_id, run["id"]) is not None
    swarm.html_404_cancel = True
    for _ in range(service.NOT_FOUND_TRIES):
        await _tick_raw(client, auth)
    wf = (await _knobs_of(tenant_id, run["id"]))["workflow"]
    assert wf["cancel_pending"].get("stuck") is True, wf
    [item] = (await client.get("/v1/inbox", headers=auth)).json()["lookups"]
    assert item["id"] == run["id"] and item["can_stop_cancelling"] is True
    assert len(swarm.submissions()) == 1


# --- minors ---------------------------------------------------------------------------


async def test_what_an_owed_decisions_cancel_counts_is_the_ticks(client, owner):
    """The owed decision's delivery retries the cancel it needs; still not confirmed and
    over the ceiling, it pauses the run. That pause is the tick's (runs_paused), not
    counted on a throwaway (PR #128 minor)."""
    tenant_id, auth = owner
    swarm = on()
    run = await _redo_not_cancelled(client, auth, tenant_id, swarm)
    await _ceiling(tenant_id, run["id"], "0.01")
    swarm.workflows["wf_1"].steps[0].cost += 1.0
    swarm.fail_cancels = 10
    out = await _tick_raw(client, auth)
    assert (await get(client, auth, run["id"]))["status"] == "paused_overrun"
    assert out["runs_paused"] == 1, out


async def test_a_runtime_failure_after_the_decision_is_recorded_is_a_503(
    client, owner, monkeypatch
):
    """The decision is committed before SwarmCloud is called: a runtime failure after that
    (here the replay limit) reaches the client as 503 "recorded", never a 500, and the
    failed try is recorded for the tick (PR #128 minor)."""
    tenant_id, auth = owner
    swarm = on()
    run = await _waiting(client, auth, tenant_id, swarm)
    monkeypatch.setattr(service, "REPLAY_LIMIT", 1)
    resp = await _decide_raw(client, auth, run, "changes_requested", "Cover returns")
    assert resp.status_code == 503 and "recorded" in resp.text, resp.text
    posting = await _owed(tenant_id, run["id"])
    assert posting["tries"] == 1 and posting["error"], posting
    monkeypatch.setattr(service, "REPLAY_LIMIT", 64)
    await tick(client, auth)
    assert len(swarm.answers) == 1 and await _owed(tenant_id, run["id"]) is None


# --- the delivering state is visible (owner decision 2026-10-20) ------------------------


def _cp(run: dict, cp_id: str) -> dict:
    return next(c for c in run["checkpoints"] if c["id"] == cp_id)


async def test_an_undelivered_decision_shows_who_decided_and_why_it_waits(client, owner):
    """The run page reads ``delivery``: who decided, since when, the tries that did not
    deliver it and SwarmCloud's last answer in a few words. The payload keeps no decider
    ids. Delivered, ``delivery`` is gone."""
    tenant_id, auth = owner
    swarm = on()
    run, cp = await _refused_decision(client, auth, tenant_id, swarm)
    got = _cp(await get(client, auth, run["id"]), cp["id"])
    assert got["status"] == "changes_requested"
    delivery = got["delivery"]
    assert delivery["decided_by_name"] == "admin@example.com", delivery
    assert delivery["tries"] == 1, delivery
    assert delivery["last_error"] == "SwarmCloud HTTP 503 unavailable", delivery
    assert delivery["since"] and delivery["last_tried_at"], delivery
    posting = got["payload"]["wait"]["posting"]
    assert not {"user_id", "token_id", "grant_id"} & set(posting), posting
    swarm.fail_next_answer = httpx.Response(429, json={"code": "rate_limited"})
    await _tick_raw(client, auth)
    delivery = _cp(await get(client, auth, run["id"]), cp["id"])["delivery"]
    assert delivery["tries"] == 2, delivery
    assert delivery["last_error"] == "SwarmCloud HTTP 429 rate_limited", delivery
    await tick(client, auth)
    got = _cp(await get(client, auth, run["id"]), cp["id"])
    assert got["delivery"] is None and got["status"] == "changes_requested"


async def test_a_decision_made_with_an_api_token_names_the_token(client, owner):
    """An API token that acts for no member decided: ``decided_by_name`` is its name."""
    tenant_id, auth = owner
    swarm = on()
    run = await _waiting(client, auth, tenant_id, swarm)
    cp = pending(run)
    async with tenant_session(tenant_id) as s:
        _, raw = await create_api_token(s, "release-bot")
        await s.commit()
    swarm.fail_next_answer = httpx.Response(503, json=_UNAVAILABLE)
    resp = await _decide_raw(client, {"Authorization": f"Bearer {raw}"}, run, "approved")
    assert resp.status_code == 503 and "recorded" in resp.text, resp.text
    delivery = _cp(await get(client, auth, run["id"]), cp["id"])["delivery"]
    assert delivery["decided_by_name"] == "release-bot", delivery


async def test_the_inbox_shows_an_undelivered_decision_to_its_approvers(client, owner):
    """``deliveries``: shown to the checkpoint's approver role and above, not counted in
    ``total`` (nothing to decide), and gone once the tick delivers the decision."""
    tenant_id, auth = owner
    swarm = on()
    run, cp = await _refused_decision(client, auth, tenant_id, swarm)
    approver = await person(tenant_id, "approver", "approver")
    commenter = await person(tenant_id, "commenter", "commenter")
    box = (await client.get("/v1/inbox", headers=auth)).json()
    [item] = box["deliveries"]
    assert item["id"] == cp["id"] and item["run_id"] == run["id"], item
    assert item["status"] == "changes_requested" and item["segment_title"], item
    assert item["delivery"]["last_error"] == "SwarmCloud HTTP 503 unavailable", item
    assert item["delivery"]["decided_by_name"] == "admin@example.com", item
    assert not {"user_id", "token_id", "grant_id"} & set(item["payload"]["wait"]["posting"])
    assert box["checkpoints"] == [] and box["total"] == 0, box
    mine = (await client.get("/v1/inbox", headers=approver.headers)).json()
    assert len(mine["deliveries"]) == 1, mine
    theirs = (await client.get("/v1/inbox", headers=commenter.headers)).json()
    assert theirs["deliveries"] == [], theirs
    await tick(client, auth)
    assert (await client.get("/v1/inbox", headers=auth)).json()["deliveries"] == []
