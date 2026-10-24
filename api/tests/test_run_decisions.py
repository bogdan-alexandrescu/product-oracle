"""D11 Checkpoint decisions over MCP (#169): every decided checkpoint of a run, read by
people at ``GET /v1/runs/{id}/decisions`` and by the run's own agents through the
curated ``get_checkpoint_review`` tool, so approvals made after a workflow was planned
reach its later segments; and the prompts that tell the agents to read them.

Segment-mode tests run on the FakeRuntime; the workflow-mode and console tests on the
fake SwarmCloud of tests/test_adapter_v2.py."""

import json
import uuid
from dataclasses import replace

import pytest
from sqlalchemy import select

from oracle.mcp.curated import CURATED
from oracle.runs import flows
from oracle.runs.models import Checkpoint
from oracle.runtokens import mint_run_token
from oracle.swarm import FakeRuntime, set_runtime
from oracle.swarm.settings import get_runtime_settings
from oracle.tenancy import tenant_session
from tests.fixtures import seed_auth
from tests.swarmcloud_fake import EGRESS
from tests.test_adapter_v2 import (
    LB,
    PUBLIC,
    _at_baseline,
    _console,
    _member,
    mcp_session,
    on,
    token_of,
    use,
)
from tests.test_mcp import api_token, mcp_client, text_of
from tests.test_runs import as_user, decide, get, pending, started, tick

READ_FIRST = (
    "Before you start, read the run's checkpoint decisions with get_checkpoint_review: "
    "approvals made after this workflow was planned are only there. Follow them; if one "
    "conflicts with your task, say so in your output."
)
NOTE = "Keep bulk import out of v1"
FIELDS = {
    "checkpoint_id",
    "kind",
    "segment_seq",
    "segment_title",
    "attempt",
    "status",
    "decided_at",
    "decided_by_role",
    "via",
    "note",
    "edits",
    "review",
    "delivered",
    "summary",
}


@pytest.fixture
def runtime():
    fake = FakeRuntime()
    set_runtime(fake)
    yield fake
    set_runtime(None)


@pytest.fixture
async def owner():
    return await seed_auth()


@pytest.fixture
def swarmcloud(monkeypatch):
    """The fake SwarmCloud's settings, as tests/test_adapter_v2.py sets them."""
    monkeypatch.setenv("ORACLE_PUBLIC_URL", PUBLIC)
    for key in (
        "ORACLE_CHECKPOINT_WAIT_SECONDS",
        "ORACLE_CHECKPOINT_TAIL_SECONDS",
        "ORACLE_STEP_SECONDS",
        "ORACLE_TRUSTED_PROXY_HOPS",
    ):
        monkeypatch.delenv(key, raising=False)
    get_runtime_settings.cache_clear()
    yield on()
    get_runtime_settings.cache_clear()
    set_runtime(None)


async def decisions(client, headers, run_id: str) -> list[dict]:
    resp = await client.get(f"/v1/runs/{run_id}/decisions", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def at(client, auth, run_id: str, kind: str) -> dict:
    await tick(client, auth)
    run = await get(client, auth, run_id)
    assert run["status"] == "awaiting_checkpoint" and run["waiting_on"] == kind, run
    return run


async def mint(tenant_id, run_id: str) -> str:
    async with tenant_session(tenant_id) as s:
        raw = await mint_run_token(s, uuid.UUID(run_id), ["read:baseline"], ttl_seconds=600)
        await s.commit()
    return raw


def review_of(result) -> list[dict]:
    assert not result.is_error, text_of(result)
    return json.loads(result.content[0].text)


# --------------------------------------------------------------------------- REST


async def test_decided_checkpoints_in_segment_then_decided_order_and_no_names(
    client, owner, runtime
):
    tenant_id, auth = owner
    approver = await as_user(tenant_id, "approver", "pat.approver@example.com")
    viewer = await as_user(tenant_id, "viewer")
    run = await started(client, auth)
    run = await at(client, auth, run["id"], "baseline_confirm")
    run = await decide(client, approver, run, "changes_requested", note="Name the owner of G1")
    run = await at(client, auth, run["id"], "baseline_confirm")
    run = await decide(client, approver, run, note="Good enough")
    run = await at(client, auth, run["id"], "feature_set")
    run = await decide(client, auth, run, note=NOTE)
    run = await at(client, auth, run["id"], "eng_review")

    # Any member reads them, a viewer included.
    body = await decisions(client, viewer, run["id"])
    assert [(d["kind"], d["segment_seq"], d["attempt"], d["status"]) for d in body] == [
        ("baseline_confirm", 1, 1, "changes_requested"),
        ("baseline_confirm", 1, 2, "approved"),
        ("feature_set", 2, 1, "approved"),
    ]
    assert all(set(d) == FIELDS for d in body)
    first, second, third = body
    assert first["decided_at"] <= second["decided_at"]
    assert first["note"] == "Name the owner of G1" and first["decided_by_role"] == "approver"
    assert third == {
        **third,
        "segment_title": "Feature set, dependencies and design",
        "decided_by_role": "owner",
        "via": "oracle",
        "note": NOTE,
        "edits": None,
        "review": None,
        "delivered": True,
        "summary": f"Feature set · approved by an owner · note: {NOTE}",
    }
    assert second["summary"] == "Baseline · approved by an approver · note: Good enough"
    assert first["summary"] == (
        "Baseline · changes requested by an approver · note: Name the owner of G1"
    )
    # The pending Engineering check is absent.
    assert pending(run)["kind"] == "eng_review"
    assert all(d["kind"] != "eng_review" for d in body)
    # No member's name, email or id reaches the list.
    raw = json.dumps(body)
    assert "pat.approver" not in raw and "@" not in raw
    for cp in run["checkpoints"]:
        if cp["decided_by"]:
            assert cp["decided_by"] not in raw


async def test_skipped_checkpoints_are_listed_and_a_run_without_decisions_is_empty(
    client, owner, runtime
):
    _, auth = owner
    run = await started(client, auth, checkpoints={"baseline_confirm": False})
    assert await decisions(client, auth, run["id"]) == []
    await tick(client, auth)  # the baseline, with no stop after it
    run = await at(client, auth, run["id"], "feature_set")
    [skipped] = await decisions(client, auth, run["id"])
    assert skipped["kind"] == "baseline_confirm" and skipped["status"] == "skipped"
    assert skipped["note"] == "Turned off when the run started."
    assert skipped["decided_by_role"] is None and skipped["via"] == "oracle"
    assert skipped["summary"] == "Baseline · skipped · note: Turned off when the run started."


async def test_an_unknown_run_gets_nothing(client, owner, runtime):
    _, auth = owner
    resp = await client.get(f"/v1/runs/{uuid.uuid4()}/decisions", headers=auth)
    assert resp.status_code == 404
    resp = await client.get("/v1/runs/x/decisions", headers=auth)
    assert resp.status_code == 422


async def test_edits_and_review_are_passed_through_when_recorded(client, owner, runtime):
    tenant_id, auth = owner
    run = await started(client, auth)
    run = await at(client, auth, run["id"], "baseline_confirm")
    run = await decide(client, auth, run, note="ok")
    edits = {"count": 1, "applied": [{"id": "g1", "action": "change", "changes": {"x": 1}}]}
    review = {"verdict": "changes_requested", "items": [{"section": "s-1", "ask": "Cut"}]}
    async with tenant_session(tenant_id) as s:
        cp = await s.scalar(select(Checkpoint).where(Checkpoint.kind == "baseline_confirm"))
        cp.payload = {**cp.payload, "review": {"edits": edits, "review": review}}
        await s.commit()
    [d] = await decisions(client, auth, run["id"])
    assert d["edits"] == edits and d["review"] == review


# --------------------------------------------------------------------------- MCP


async def test_a_run_token_reads_its_own_runs_decisions_filtered(client, owner, runtime):
    tenant_id, auth = owner
    run = await started(client, auth)
    run = await at(client, auth, run["id"], "baseline_confirm")
    run = await decide(client, auth, run, note="ok baseline")
    run = await at(client, auth, run["id"], "feature_set")
    run = await decide(client, auth, run, note=NOTE)
    other = await started(client, auth)
    other = await at(client, auth, other["id"], "baseline_confirm")
    await decide(client, auth, other, note="the other run's note")

    token = await mint(tenant_id, run["id"])
    async with mcp_client(token) as c:
        tools = {t.name: t for t in (await c.list_tools()).tools}
        assert "get_checkpoint_review" in tools
        assert tools["get_checkpoint_review"].annotations.read_only_hint is True
        props = tools["get_checkpoint_review"].input_schema["properties"]
        assert props["kind"]["type"] == "string" and props["seq"]["type"] == "integer"
        assert not tools["get_checkpoint_review"].input_schema.get("required")

        everything = review_of(await c.call_tool("get_checkpoint_review", {}))
        assert [d["note"] for d in everything] == ["ok baseline", NOTE]
        assert "the other run's note" not in json.dumps(everything)
        only = review_of(await c.call_tool("get_checkpoint_review", {"kind": "feature_set"}))
        assert [d["kind"] for d in only] == ["feature_set"] and only[0]["note"] == NOTE
        by_seq = review_of(await c.call_tool("get_checkpoint_review", {"seq": 1}))
        assert [d["kind"] for d in by_seq] == ["baseline_confirm"]
        for args in ({"seq": 0}, {"seq": "1; x"}, {"seq": True}, {"kind": 3}):
            out = await c.call_tool("get_checkpoint_review", args)
            assert out.is_error, args

    # The other run's token reads its own run only.
    other_token = await mint(tenant_id, other["id"])
    async with mcp_client(other_token) as c:
        mine = review_of(await c.call_tool("get_checkpoint_review", {}))
        assert [d["note"] for d in mine] == ["the other run's note"]


async def test_people_get_the_run_token_error_and_use_the_generated_tool(client, owner, runtime):
    tenant_id, auth = owner
    run = await started(client, auth)
    run = await at(client, auth, run["id"], "baseline_confirm")
    await decide(client, auth, run, note="ok baseline")
    token = await api_token(tenant_id, "viewer")
    async with mcp_client(token) as c:
        names = {t.name for t in (await c.list_tools()).tools}
        assert "get_checkpoint_review" not in names and "list_run_decisions" in names
        out = await c.call_tool("get_checkpoint_review", {})
        assert out.is_error
        assert text_of(out) == "get_checkpoint_review is for a run's own agents (a run token)."
        listed = await c.call_tool("list_run_decisions", {"run_id": run["id"]})
        assert not listed.is_error and "ok baseline" in text_of(listed)
    # A run token cannot reach the generated tool: only the curated one, bound to its run.
    run_token = await mint(tenant_id, run["id"])
    async with mcp_client(run_token) as c:
        names = {t.name for t in (await c.list_tools()).tools}
        assert "list_run_decisions" not in names
        out = await c.call_tool("list_run_decisions", {"run_id": run["id"]})
        assert out.is_error


def test_the_curated_tool_is_own_run_and_reads_list_run_decisions():
    tool = next(c for c in CURATED if c.name == "get_checkpoint_review")
    assert tool.own_run is True
    assert "decisions made after your prompt was written are only here" in tool.description


# --------------------------------------------------------------------------- workflow mode


async def test_an_approval_after_the_workflow_was_planned_reaches_its_agents(
    client, owner, swarmcloud
):
    _, auth = owner
    swarm = swarmcloud
    use(swarm)
    run = await started(client, auth)
    run = await at(client, auth, run["id"], "baseline_confirm")
    run = await decide(client, auth, run, note="ok baseline")
    run = await at(client, auth, run["id"], "feature_set")
    run = await decide(client, auth, run, note=NOTE)
    # One workflow, planned before either approval: no prompt carries the note.
    assert len(swarm.submissions()) == 1
    # The agents' steps (the waits are a person's).
    prompts = [
        s["input"]["prompt"] for s in swarm.submissions()[0]["steps"] if "await_input" not in s
    ]
    assert prompts and all(NOTE not in p for p in prompts)
    assert all(READ_FIRST in p and "get_checkpoint_review" in p for p in prompts)
    # The run's agents read it with the run token.
    async with mcp_session(token_of(swarm), f"{EGRESS[0]}, {LB}") as c:
        got = review_of(await c.call_tool("get_checkpoint_review", {"kind": "feature_set"}))
    assert [(d["status"], d["note"], d["via"]) for d in got] == [("approved", NOTE, "oracle")]


async def test_a_held_console_approval_is_absent_until_an_approver_confirms_it(
    client, owner, swarmcloud
):
    tenant_id, auth = owner
    swarm = swarmcloud
    await _member(tenant_id, "viewer.console@example.com", "viewer")
    run = await _at_baseline(client, auth, swarm)
    cp = pending(run)
    token = token_of(swarm)
    swarm.steps_per_poll = 0
    swarm.console_answer("wf_1", "baseline-review1", "MERGE", by="viewer.console@example.com")
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert _console(run, cp["id"])["needs"] == "confirm" and run["token_read_only"] is True
    # Recorded, not followed: no decision yet, and the read succeeds while the token is
    # read-only.
    assert await decisions(client, auth, run["id"]) == []
    async with mcp_session(token, f"{EGRESS[0]}, {LB}") as c:
        assert review_of(await c.call_tool("get_checkpoint_review", {})) == []
    # An approver confirms it: listed once, as the console's answer.
    run = await decide(client, auth, run, "confirm")
    [d] = await decisions(client, auth, run["id"])
    assert d["checkpoint_id"] == cp["id"] and d["status"] == "approved"
    assert d["via"] == "swarmcloud_console" and d["decided_by_role"] == "viewer"
    assert "viewer.console" not in json.dumps(d)
    assert d["summary"].startswith("Baseline · approved by a viewer in SwarmCloud's console")


async def test_a_counted_console_answer_is_listed_as_the_consoles(client, owner, swarmcloud):
    tenant_id, auth = owner
    swarm = swarmcloud
    await _member(tenant_id, "approver.console@example.com", "approver")
    run = await _at_baseline(client, auth, swarm)
    swarm.console_answer("wf_1", "baseline-review1", "MERGE", by="approver.console@example.com")
    await tick(client, auth)
    [d] = await decisions(client, auth, run["id"])
    assert d["status"] == "approved" and d["via"] == "swarmcloud_console"
    assert d["decided_by_role"] == "approver"


# --------------------------------------------------------------------------- prompts


def _ctx(**kw) -> flows.PromptContext:
    base = flows.PromptContext(
        run_id="r1", document="checkout-redesign", snapshot_as_of=None, low_confidence=0.4
    )
    return replace(base, **kw)


# Flows whose spec lists their tools exactly and that have no checkpoint to read: H7's
# competitive digest (#518; test_market_digest pins its tools).
WITHOUT_CHECKPOINT_REVIEW = {"competitive_digest"}


def test_every_segment_prompt_of_every_flow_names_the_tool():
    assert "get_checkpoint_review" in flows.MCP_TOOLS
    for flow in flows.FLOWS.values():
        if flow.key in WITHOUT_CHECKPOINT_REVIEW:
            assert all(s.checkpoint is None for s in flow.segments), flow.key
            continue
        for sdef in flow.segments:
            assert "get_checkpoint_review" in sdef.tools, (flow.key, sdef.name)
            for reachable in (True, False):
                prompt = flows.step_prompt(
                    flow, sdef, sdef.roles[0], last=True, ctx=_ctx(mcp_reachable=reachable)
                )
                assert f"- get_checkpoint_review: {flows.MCP_TOOLS['get_checkpoint_review']}" in (
                    prompt
                )


def test_the_read_first_sentence_only_where_mcp_reaches_and_the_run_has_more_segments():
    multi = flows.FLOWS["baseline_to_prd"]
    single = flows.FLOWS["feedback_loop"]
    sdef = multi.segment("prd_draft")
    attached = _ctx(mcp_reachable=True, mcp_attached=True)
    assert READ_FIRST in flows.step_prompt(multi, sdef, "writer", last=True, ctx=attached)
    unreachable = _ctx(mcp_reachable=False)
    assert READ_FIRST not in flows.step_prompt(multi, sdef, "writer", last=True, ctx=unreachable)
    one = single.segments[0]
    assert READ_FIRST not in flows.step_prompt(single, one, "writer", last=True, ctx=attached)
    # Segment mode keeps the pasted notes (current when the prompt is built) and names the
    # tool.
    pasted = _ctx(mcp_reachable=False, reviewer_notes=[f"feature_set: {NOTE}"])
    prompt = flows.step_prompt(multi, sdef, "writer", last=True, ctx=pasted)
    assert f"- feature_set: {NOTE}" in prompt and "get_checkpoint_review" in prompt
