"""F4 Engineering review stop, lane A: the Engineering check in workflow mode against the
fake SwarmCloud: console answers (W5, D3 "Console gate"), the Inbox, and a whole run.

Every test states its card: protects / fails_when / no_claim. The SwarmCloud fake stands
in for SwarmCloud and its agents (no model is called). Synthetic placeholders only.
"""

import uuid
from datetime import timedelta

from oracle.auth.models import User
from oracle.runs import service
from oracle.swarm import set_runtime
from oracle.tenancy import tenant_session
from tests.review_v2_helpers import person
from tests.swarmcloud_fake import FakeSwarmCloud
from tests.test_adapter_v2 import owner, settings  # noqa: F401 - fixtures
from tests.test_runs import decide, get, pending, stage_verdicts, started, tick


def _swarm() -> FakeSwarmCloud:
    swarm = FakeSwarmCloud(mcp=True, await_input=True, service_answer=True)
    set_runtime(swarm.runtime())
    return swarm


async def _at_check(client, auth) -> dict:
    """A workflow-mode run waiting at the Engineering check."""
    run = await started(client, auth)
    for _ in range(6):
        await tick(client, auth)
        run = await get(client, auth, run["id"])
        if run["waiting_on"] == "eng_review":
            return run
        if run["status"] == "awaiting_checkpoint":
            run = await decide(client, auth, run)
    raise AssertionError(run)


async def _lead(client, auth, tenant_id):
    """A commenter named engineering lead, and their email."""
    lead = await person(tenant_id, "commenter", "lead")
    resp = await client.patch(
        f"/v1/members/{lead.user_id}", json={"engineering_lead": True}, headers=auth
    )
    assert resp.status_code == 200, resp.text
    return lead, await _email(tenant_id, lead.user_id)


async def _email(tenant_id, user_id) -> str:
    async with tenant_session(tenant_id) as s:
        return (await s.get(User, user_id)).email


async def _read(client, auth, run, monkeypatch) -> dict:
    """Tick past the console poll and read the check again."""
    real_now = service._now
    monkeypatch.setattr(service, "_now", lambda: real_now() + timedelta(seconds=61))
    await tick(client, auth)
    return await get(client, auth, run["id"])


async def test_a_console_approval_by_an_approver_not_lead_does_not_count(
    client,
    owner,  # noqa: F811
    monkeypatch,
):
    # protects=Done-when 5 (first half): with a lead named, a console MERGE by an approver
    # who is not the lead is not counted; the check stays open and shows what the console
    # said; fails_when=the answer approves the check or nothing shows it; no_claim=the
    # console's own UI.
    tenant_id, auth = owner
    swarm = _swarm()
    try:
        run = await _at_check(client, auth)
        cp = pending(run)
        _, _lead_email = await _lead(client, auth, tenant_id)
        approver = await person(tenant_id, "approver")
        email = await _email(tenant_id, approver.user_id)
        wf = cp["payload"]["wait"]["workflow_id"]
        swarm.console_answer(wf, "eng_review-review1", "MERGE", by=email)
        run = await _read(client, auth, run, monkeypatch)
        assert run["status"] == "awaiting_checkpoint" and pending(run)["id"] == cp["id"]
        console = pending(run)["console"]
        assert console["counted"] is False
        assert console["reason"] == f"{email} is not an engineering lead"
    finally:
        set_runtime(None)


async def test_a_console_approval_by_the_lead_with_a_verdict_missing_is_held(
    client,
    owner,  # noqa: F811
    monkeypatch,
):
    # protects=Done-when 5 (second half, D3 "Console gate"): the lead's console MERGE
    # while a feature has no verdict is held: pending with console.needs = "confirm",
    # nothing posted to the workflow, the run token read-only, confirming 409 until the
    # verdict is staged, then the confirm lands; fails_when=the check is approved by the
    # console, an answer is posted, the token may write or confirm passes the gate;
    # no_claim=what SwarmCloud does with its own console answer.
    tenant_id, auth = owner
    swarm = _swarm()
    try:
        run = await _at_check(client, auth)
        cp = pending(run)
        lead, lead_email = await _lead(client, auth, tenant_id)
        wf = cp["payload"]["wait"]["workflow_id"]
        posted = len(swarm.answers)
        swarm.console_answer(wf, "eng_review-review1", "MERGE", by=lead_email)
        run = await _read(client, auth, run, monkeypatch)
        cp = next(c for c in run["checkpoints"] if c["id"] == cp["id"])
        assert cp["status"] == "pending"
        assert cp["console"]["needs"] == "confirm"
        assert cp["console"]["reason"] == service.CONSOLE_BLOCKED
        assert len(swarm.answers) == posted
        async with tenant_session(tenant_id) as s:
            assert await service.token_hold(s, uuid.UUID(run["id"]), live=False) is not None
        url = f"/v1/runs/{run['id']}/checkpoints/{cp['id']}/decide"
        resp = await client.post(url, json={"decision": "confirm"}, headers=lead.headers)
        assert resp.status_code == 409, resp.text
        detail = resp.json()["detail"]
        assert detail["code"] == "blocking_open"
        assert [(x["item"], x["code"]) for x in detail["left"]] == [("price-early", "no_verdict")]

        await stage_verdicts(client, lead.headers, run)
        resp = await client.post(url, json={"decision": "confirm"}, headers=lead.headers)
        assert resp.status_code == 200, resp.text
        run = await get(client, auth, run["id"])
        assert next(c for c in run["checkpoints"] if c["id"] == cp["id"])["status"] == "approved"
    finally:
        set_runtime(None)


async def test_the_inbox_lists_the_check_for_the_lead_and_owners_only(
    client,
    owner,  # noqa: F811
):
    # protects=Done-when 15 (the check; the dates stop is lane B): with a lead named, the
    # Inbox lists the Engineering check for the lead and owners, titled by its segment,
    # with its open blocking reasons, and not for an approver; fails_when=an approver sees
    # it, the lead does not, or the row lacks its title or gate; no_claim=D9's summary line
    # (not on main yet).
    tenant_id, auth = owner
    _swarm()
    try:
        run = await _at_check(client, auth)
        cp = pending(run)
        lead, _ = await _lead(client, auth, tenant_id)
        approver = await person(tenant_id, "approver")

        async def rows(headers) -> list[dict]:
            resp = await client.get("/v1/inbox", headers=headers)
            assert resp.status_code == 200, resp.text
            return [c for c in resp.json()["checkpoints"] if c["id"] == cp["id"]]

        for headers in (lead.headers, auth):
            [row] = await rows(headers)
            assert row["kind"] == "eng_review" and row["segment_title"] == "Engineering check"
            assert row["can_decide"] is True
            assert [(x["item"], x["code"]) for x in row["gate"]["left"]] == [
                ("price-early", "no_verdict")
            ]
        assert await rows(approver.headers) == []
    finally:
        set_runtime(None)


async def test_workflow_mode_runs_the_check_and_a_prd_review_send_back_revises_the_draft(
    client,
    owner,  # noqa: F811
):
    # protects=Done-when 16 for lane A: in workflow mode the check's step runs in the
    # run's one workflow after the feature set, and a PRD review send-back still revises
    # prd_draft (the importing segment), then the run goes on to the dates stop (lane B,
    # AC16: it waits for the draft's items, outside the workflow); fails_when=the check is
    # missing from the workflow, its stop is not answered there, the send-back has no
    # revise step, or the dates step is planned inside the workflow; no_claim=the dates
    # stop's own path (test_eng_dates_stop.py).
    _, auth = owner
    swarm = _swarm()
    try:
        run = await started(client, auth)
        expected = ["baseline_confirm", "feature_set", "eng_review", "priority_order"]
        for kind in expected:
            await tick(client, auth)
            run = await get(client, auth, run["id"])
            assert run["waiting_on"] == kind, run
            run = await decide(client, auth, run)
        await tick(client, auth)
        run = await get(client, auth, run["id"])
        assert run["waiting_on"] == "prd_review", run
        run = await decide(client, auth, run, "changes_requested", note="Name the metric")
        await tick(client, auth)
        run = await get(client, auth, run["id"])
        assert run["waiting_on"] == "prd_review", run
        run = await decide(client, auth, run)
        assert run["status"] == "running", run
        assert run["waiting_for"] == {"kind": "draft_items", "version": 2}, run
        assert len(swarm.submissions()) == 1
        steps = [s["step_id"] for s in swarm.submissions()[0]["steps"]]
        assert "eng_review-review1" in steps and "prd_draft-revise1" in steps
        assert not any(s.startswith("eng_dates") for s in steps)
        assert [a["step_id"] for a in swarm.answers][:3] == [
            "baseline-review1", "feature_set-review1", "eng_review-review1",
        ]  # fmt: skip
        seg = next(s for s in run["segments"] if s["name"] == "eng_review")
        assert seg["workflow_id"] == "wf_1" and seg["status"] == "succeeded"
    finally:
        set_runtime(None)
