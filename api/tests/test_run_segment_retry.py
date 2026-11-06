"""A failed run segment says why in plain words and can be retried from its stop, with
the approvals before it kept (owner's demo walk, Nov 6: "prd_draft: the workflow ended
failed: claude-code exited 1:" and only Delete)."""

import pytest

from oracle.runs import flows, workflow
from oracle.swarm import Outcome
from tests.test_runs import as_user, decide, get, owner, runtime, started, tick  # noqa: F401

OUT_OF_ROOM = "claude-code exited 1: prompt is too long: 218009 tokens > 200000 maximum"


def test_plain_failure_words():
    assert workflow.plain_failure(OUT_OF_ROOM, "writer") == (
        "The writer stopped: its session ran out of room."
    )
    assert workflow.plain_failure("claude-code exited 1:", "writer") == (
        "The writer stopped: its session ended with an error and gave no reason."
    )
    # Any other runtime text stays in the logs, never on the run page.
    assert workflow.plain_failure("agent crashed at /srv/example/run.py", "analyst") == (
        "The analyst stopped. Retry this step."
    )
    assert workflow.plain_failure(None, None) == "The agents stopped and gave no reason."


async def failed_at_draft(client, auth, runtime):  # noqa: F811
    """A run whose baseline stop was approved, failed at its PRD draft."""
    runtime.script["prd_draft"] = [Outcome(state="failed", error=OUT_OF_ROOM)]
    knobs = dict.fromkeys(flows.FLOWS["baseline_to_prd"].checkpoints, False)
    knobs["baseline_confirm"] = True
    run = await started(client, auth, checkpoints=knobs)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "awaiting_checkpoint", run["status"]
    run = await decide(client, auth, run)
    for _ in range(6):
        run = await get(client, auth, run["id"])
        if run["status"] == "failed":
            break
        await tick(client, auth)
    assert run["status"] == "failed", run["status"]
    return run


def draft_of(run):
    return next(s for s in run["segments"] if s["name"] == "prd_draft")


async def test_a_failed_segment_says_why_in_plain_words(client, owner, runtime):  # noqa: F811
    _, auth = owner
    run = await failed_at_draft(client, auth, runtime)
    seg = draft_of(run)
    assert seg["status"] == "failed"
    assert seg["error"].startswith("The writer stopped: its session ran out of room."), seg
    assert "PRD draft" in run["error"] and "ran out of room" in run["error"]
    assert "claude-code" not in run["error"]
    assert seg["can_retry"] is True
    # Only the failed segment offers Retry.
    assert [s["can_retry"] for s in run["segments"]].count(True) == 1


async def test_retry_redispatches_only_the_failed_segment(client, owner, runtime):  # noqa: F811
    _, auth = owner
    run = await failed_at_draft(client, auth, runtime)
    before = {s["name"]: len(s["attempts"]) for s in run["segments"]}
    approved = [c["id"] for c in run["checkpoints"] if c["status"] == "approved"]
    assert approved
    submitted = len(runtime.submitted)
    seq = draft_of(run)["seq"]
    resp = await client.post(f"/v1/runs/{run['id']}/segments/{seq}/retry", headers=auth)
    assert resp.status_code == 200, resp.text
    run = resp.json()
    assert run["status"] == "running" and run["error"] is None
    assert draft_of(run)["status"] in ("pending", "running")
    assert draft_of(run)["can_retry"] is False
    # One new submission, for the failed segment only; the approvals before it kept.
    assert len(runtime.submitted) == submitted + 1
    assert runtime.submitted[-1].labels["segment"] == "prd_draft"
    assert [c["id"] for c in run["checkpoints"] if c["status"] == "approved"] == approved
    for name, n in before.items():
        if name != "prd_draft":
            assert len(next(s for s in run["segments"] if s["name"] == name)["attempts"]) == n
    for _ in range(4):
        await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert draft_of(run)["status"] == "succeeded"
    assert run["status"] == "succeeded"


@pytest.mark.parametrize("role", ["viewer", "commenter"])
async def test_retry_is_refused_to_a_viewer(client, owner, runtime, role):  # noqa: F811
    tenant_id, auth = owner
    run = await failed_at_draft(client, auth, runtime)
    seq = draft_of(run)["seq"]
    them = await as_user(tenant_id, role)
    seen = await get(client, them, run["id"])
    assert draft_of(seen)["can_retry"] is False
    resp = await client.post(f"/v1/runs/{run['id']}/segments/{seq}/retry", headers=them)
    assert resp.status_code == 403, resp.text
    assert (await get(client, auth, run["id"]))["status"] == "failed"


async def test_retry_needs_a_failed_segment(client, owner, runtime):  # noqa: F811
    _, auth = owner
    run = await failed_at_draft(client, auth, runtime)
    first = run["segments"][0]["seq"]
    resp = await client.post(f"/v1/runs/{run['id']}/segments/{first}/retry", headers=auth)
    assert resp.status_code == 409, resp.text


async def test_a_second_retry_while_queued_or_running_is_refused(client, owner, runtime):  # noqa: F811
    _, auth = owner
    run = await failed_at_draft(client, auth, runtime)
    seq = draft_of(run)["seq"]
    url = f"/v1/runs/{run['id']}/segments/{seq}/retry"
    assert (await client.post(url, headers=auth)).status_code == 200
    submitted = len(runtime.submitted)
    again = await client.post(url, headers=auth)
    assert again.status_code == 409, again.text
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert draft_of(run)["status"] in ("pending", "running", "succeeded")
    if draft_of(run)["status"] != "succeeded":
        assert (await client.post(url, headers=auth)).status_code == 409
    assert len(runtime.submitted) == submitted


async def test_retry_is_refused_to_an_approver_who_did_not_create_the_run(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    run = await failed_at_draft(client, auth, runtime)
    seq = draft_of(run)["seq"]
    them = await as_user(tenant_id, "approver")
    assert draft_of(await get(client, them, run["id"]))["can_retry"] is False
    resp = await client.post(f"/v1/runs/{run['id']}/segments/{seq}/retry", headers=them)
    assert resp.status_code == 403, resp.text
    assert (await get(client, auth, run["id"]))["status"] == "failed"
