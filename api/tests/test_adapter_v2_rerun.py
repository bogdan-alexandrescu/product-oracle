"""D5 Re-run keeps its output (#163) against the fake SwarmCloud API: with the run token
attached the previous files are named for get_run_output (which reads the previous
attempt with ``attempt``), and a person's Request changes at the last segment's review
posts the problems Oracle's check found as findings after the note."""

import pytest

from tests.fixtures import seed_auth
from tests.swarmcloud_fake import EGRESS, FakeSwarmCloud
from tests.test_adapter_v2 import LB, mcp_session, token_of, use
from tests.test_adapter_v2 import settings as _v2_settings
from tests.test_draft_sent_back import BAD_PRD, WRITER, _feedback_run
from tests.test_runs import decide, get, pending, started, tick

# The same environment as test_adapter_v2 (Oracle's public URL, default timings).
settings = _v2_settings

ANALYST = "baseline-2-analyst"


@pytest.fixture
async def owner():
    return await seed_auth()


async def test_attached_agents_read_the_previous_files_with_get_run_output(client, owner):
    """AC2: the prompt names get_run_output(seq=1, name=...) instead of pasting, and
    get_run_output with attempt 1 returns the previous file once attempt 2 is harvested."""
    _, auth = owner
    # Caller MCP on, waits off: one workflow per segment, the run token attached.
    swarm = FakeSwarmCloud(mcp=True, await_input=False, service_answer=False)
    swarm.step_files[ANALYST] = {"summary.md": "First summary of the baseline"}
    use(swarm)
    run = await started(client, auth)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["waiting_on"] == "baseline_confirm", run
    swarm.step_files[ANALYST] = {"summary.md": "Second summary of the baseline"}
    run = await decide(client, auth, run, "changes_requested", note="Name the owner of G1")
    body = swarm.submissions()[-1]
    first = body["steps"][0]["input"]["prompt"]
    assert "Your previous attempt (attempt 1) wrote these files" in first
    assert "get_run_output(seq=1, name=summary.md)" in first
    assert "get_run_output(seq=1, name=baseline.yaml)" in first
    assert "First summary of the baseline" not in first

    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["segments"][0]["previous_attempt"]["attempt"] == 1
    # The next segment's agents (a live run token) read both attempts.
    run = await decide(client, auth, run, note="ok")
    assert len(swarm.submissions()) == 3
    token = token_of(swarm)
    async with mcp_session(token, f"{EGRESS[0]}, {LB}") as c:
        now = await c.call_tool("get_run_output", {"seq": 1, "name": "summary.md"})
        assert not now.is_error and "Second summary" in now.content[0].text
        before = await c.call_tool("get_run_output", {"seq": 1, "name": "summary.md", "attempt": 1})
        assert not before.is_error and "First summary" in before.content[0].text
        older = await c.call_tool("get_run_output", {"seq": 1, "name": "summary.md", "attempt": 0})
        assert older.is_error


async def test_a_person_s_not_yet_posts_the_problems_after_the_note(client, owner):
    """AC6: the last segment's review, a draft still refused: the findings are the note,
    then a lead line and the import's problems."""
    tenant_id, auth = owner
    swarm = FakeSwarmCloud(mcp=True, await_input=True, service_answer=True)
    swarm.step_files[WRITER] = {"prd.md": BAD_PRD}
    swarm.step_files["next_draft-revise1"] = {"prd.md": BAD_PRD}
    run = await _feedback_run(client, auth, tenant_id, swarm)
    await tick(client, auth)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    cp = pending(run)
    assert cp["payload"]["wait"]["step_id"] == "next_draft-review2"
    summary = cp["payload"]["import"]["summary"]
    run = await decide(client, auth, run, "changes_requested", note="Cite the Slack thread")
    answer = swarm.answers[-1]
    assert answer["step_id"] == "next_draft-review2"
    assert answer["payload"]["verdict"] == "NOT_YET"
    assert answer["payload"]["findings"] == [
        "Cite the Slack thread",
        "Oracle's check found these problems in prd.md; fix each one:",
        summary,
    ]


async def test_a_person_s_not_yet_with_no_problems_posts_the_note_only(client, owner):
    """AC6: no problems: the findings are the document's open feedback (D10, one line
    per entry), then the note."""
    tenant_id, auth = owner
    swarm = FakeSwarmCloud(mcp=True, await_input=True, service_answer=True)
    run = await _feedback_run(client, auth, tenant_id, swarm)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert pending(run)["payload"]["import"]["version"] == 2
    await decide(client, auth, run, "changes_requested", note="Add a guardrail metric")
    [item] = (await client.get("/v1/documents/checkout-redesign/feedback", headers=auth)).json()
    assert swarm.answers[-1]["payload"] == {
        "verdict": "NOT_YET",
        "findings": [f"general: Add a metric [{item['id']}]", "Add a guardrail metric"],
    }


async def test_an_earlier_segment_sent_back_mid_workflow_gets_its_previous_files(client, owner):
    """Workflow mode, an earlier segment: the change request re-runs it as a new workflow
    through the segment-mode path, with its previous files."""
    _, auth = owner
    swarm = FakeSwarmCloud(mcp=True, await_input=True, service_answer=True)
    use(swarm)
    run = await started(client, auth)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    await decide(client, auth, run, "changes_requested", note="Name the owner of G1")
    assert len(swarm.submissions()) == 2
    first = swarm.submissions()[-1]["steps"][0]["input"]["prompt"]
    assert "Your previous attempt (attempt 1) wrote these files" in first
    assert "get_run_output(seq=1, name=summary.md)" in first
