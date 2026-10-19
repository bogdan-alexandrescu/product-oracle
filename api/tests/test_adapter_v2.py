"""Adapter v2 (docs/swarmcloud-interface.md) against a fake SwarmCloud API: feature
detection, the MCP server's registration, run tokens through SwarmCloud, checkpoints as
waits for a person, answers, expiry, the tail rule, label de-duplication, the egress
check and the fallback while a switch is off."""

import json
import logging
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta

import httpx
import httpx2
import pytest
from mcp import Client
from mcp.client.streamable_http import streamable_http_client
from sqlalchemy import select
from sqlalchemy import text as sa_text

from oracle.main import app
from oracle.mcp.egress import client_address
from oracle.review.models import FeedbackItem
from oracle.runs import service, workflow
from oracle.runs.models import Run
from oracle.runtokens import RunToken, verify_run_token
from oracle.swarm import RuntimeUnavailable, WorkflowSpec, set_runtime
from oracle.swarm.settings import RuntimeSettings, get_runtime_settings
from oracle.swarm.swarmcloud import mcp_server_body
from oracle.tenancy import tenant_session
from tests.fixtures import draft, import_draft, seed_auth
from tests.swarmcloud_fake import EGRESS, SERVICE_PRINCIPAL, FakeSwarmCloud
from tests.test_runs import as_user, decide, get, pending, started, tick

PUBLIC = "https://oracle.swarm.saga.xyz"
MCP_URL = PUBLIC + "/mcp"
# The client as Google's load balancer appends it: "<client>, <load balancer>".
LB = "35.191.0.1"
CONTRACT_BODY = {
    "name": "oracle",
    "url": "https://oracle.swarm.saga.xyz/mcp",
    "transport": "streamable-http",
    "description": "Oracle knowledge",
    "auth": {"mode": "dispatch", "header": "Authorization", "scheme": "Bearer"},
    "allowed_profiles": ["claude-code"],
    "allowed_tools": [],
    "enabled": True,
    "limits": {
        "max_request_bytes": 1048576,
        "max_response_bytes": 4194304,
        "calls_per_minute": 60,
        "call_timeout_seconds": 60,
    },
}


@pytest.fixture(autouse=True)
def settings(monkeypatch):
    monkeypatch.setenv("ORACLE_PUBLIC_URL", PUBLIC)
    for key in (
        "ORACLE_CHECKPOINT_WAIT_SECONDS",
        "ORACLE_CHECKPOINT_TAIL_SECONDS",
        "ORACLE_STEP_SECONDS",
        "ORACLE_TRUSTED_PROXY_HOPS",
    ):
        monkeypatch.delenv(key, raising=False)
    get_runtime_settings.cache_clear()
    yield
    get_runtime_settings.cache_clear()
    set_runtime(None)


def use(swarm: FakeSwarmCloud, **kw):
    runtime = swarm.runtime(**kw)
    set_runtime(runtime)
    return runtime


def on() -> FakeSwarmCloud:
    return FakeSwarmCloud(mcp=True, await_input=True, service_answer=True)


@pytest.fixture
async def owner():
    return await seed_auth()


async def feedback_doc(client, auth, tenant_id) -> None:
    assert (await import_draft(client, auth, draft("prd_v1.md"))).status_code == 201
    async with tenant_session(tenant_id) as s:
        from oracle.docs.models import Document

        doc = await s.scalar(select(Document))
        s.add(
            FeedbackItem(
                document_id=doc.id, raised_on_version=1, kind="general", summary="Add a metric"
            )
        )
        await s.commit()


def token_of(swarm: FakeSwarmCloud, n: int = -1) -> str:
    return swarm.submissions()[n]["mcp_credentials"]["oracle"]["value"]


async def run_token_row(tenant_id, raw: str) -> RunToken:
    from oracle.auth.service import hash_token

    async with tenant_session(tenant_id) as s:
        return await s.scalar(select(RunToken).where(RunToken.token_hash == hash_token(raw)))


# --------------------------------------------------------------------------- features


async def test_features_follow_each_switch(client, owner):
    _, auth = owner
    for mcp, wait, answer in [
        (False, False, False),
        (True, False, False),
        (True, True, False),
        (True, True, True),
        (False, True, True),
    ]:
        swarm = FakeSwarmCloud(mcp=mcp, await_input=wait, service_answer=answer)
        use(swarm)
        # SwarmCloud serves reads while caller MCP is off: listing MCP servers proves
        # nothing, so MCP is not "on" before a registration is accepted.
        body = (await client.get("/v1/runtime/status", headers=auth)).json()
        assert body["features"]["mcp"] == "unknown", body
        assert "not confirmed" in body["feature_reasons"]["mcp"]
        assert body["can_reach_oracle"] is False
        resp = await client.post("/v1/runtime/mcp-server", headers=auth)
        assert resp.status_code == (200 if mcp else 503), resp.text
        body = (await client.get("/v1/runtime/status", headers=auth)).json()
        state = {True: "on", False: "off"}
        assert body["features"] == {
            "mcp": state[mcp],
            "await_input": state[wait],
            "service_answer": state[answer],
        }, body
        assert body["can_reach_oracle"] is mcp
        assert body["reachable"] and body["tenant_id"] == "u-or-9a0792"
        if not mcp:
            assert "mcp_unavailable" in body["feature_reasons"]["mcp"]
        assert "sc-bearer" not in json.dumps(body)

    # Registered earlier and unchanged: a fresh process confirms caller MCP with a write
    # (the same URL, PATCHed) before any run token is sent; reads alone never do.
    swarm = on()
    await swarm.runtime().ensure_mcp_server(MCP_URL)
    runtime = use(swarm)
    assert (await runtime.features(refresh=True)).mcp == "unknown"
    assert await runtime.ensure_mcp_server(MCP_URL) == "unchanged"
    patch = [r for r in swarm.requests if r.method == "PATCH"]
    assert [json.loads(r.content) for r in patch] == [{"url": MCP_URL}]
    assert (await runtime.features(refresh=True)).mcp == "on"
    await started(client, auth)
    assert swarm.submissions()[-1]["mcp_credentials"]["oracle"]["value"]

    # Not reported by SwarmCloud: unknown, learned at submit or answer.
    swarm.report_capacity = False
    use(swarm)
    body = (await client.get("/v1/runtime/status", headers=auth)).json()
    assert body["features"]["await_input"] == "unknown"
    assert "learned at submit" in body["feature_reasons"]["await_input"]


async def test_features_are_cached_and_bounded_by_the_timeout():
    import asyncio

    swarm = on()
    runtime = swarm.runtime(features_ttl=60)
    await runtime.features()
    calls = len(swarm.requests)
    await runtime.features()
    assert len(swarm.requests) == calls  # cached
    await runtime.features(refresh=True)
    assert len(swarm.requests) == 2 * calls

    async def slow(request):
        await asyncio.sleep(5)
        return httpx.Response(200, json={})

    from oracle.swarm import SwarmCloudRuntime
    from oracle.swarm.swarmcloud import StaticBearer

    runtime = SwarmCloudRuntime(
        "https://swarm.test", StaticBearer("x"), timeout=0.2, transport=httpx.MockTransport(slow)
    )
    started_at = asyncio.get_running_loop().time()
    feats = await runtime.features()
    assert asyncio.get_running_loop().time() - started_at < 1
    assert set(feats.as_dict().values()) == {"unknown"}
    assert "within 0.2 s" in feats.reasons["mcp"]


def test_wait_setting_is_held_to_300_86400():
    assert RuntimeSettings(checkpoint_wait_seconds=10).checkpoint_wait_seconds == 300
    assert RuntimeSettings(checkpoint_wait_seconds=10**6).checkpoint_wait_seconds == 86400
    assert RuntimeSettings().checkpoint_wait_seconds == 72000  # W2b: 20 h
    assert RuntimeSettings().checkpoint_tail_seconds == 7200


# --------------------------------------------------------------------------- registration


async def test_registration_is_idempotent(client, owner):
    _, auth = owner
    swarm = FakeSwarmCloud(mcp=True)
    runtime = use(swarm)
    assert mcp_server_body(MCP_URL) == CONTRACT_BODY

    assert await runtime.ensure_mcp_server(MCP_URL) == "created"
    posts = [r for r in swarm.requests if r.method == "POST"]
    assert len(posts) == 1 and json.loads(posts[0].content) == CONTRACT_BODY
    # Again, in this process and in a fresh one: nothing is created twice.
    assert await runtime.ensure_mcp_server(MCP_URL) == "unchanged"
    resp = await client.post("/v1/runtime/mcp-server", headers=auth)
    assert resp.status_code == 200 and resp.json() == {
        "name": "oracle",
        "url": MCP_URL,
        "result": "unchanged",
    }
    use(swarm)
    assert (await client.post("/v1/runtime/mcp-server", headers=auth)).json()["result"] == (
        "unchanged"
    )
    assert len([r for r in swarm.requests if r.method == "POST"]) == 1
    # A new public URL: PATCHed, not created.
    other = swarm.runtime()
    assert await other.ensure_mcp_server("https://oracle.example.com/mcp") == "updated"
    patch = [r for r in swarm.requests if r.method == "PATCH"][-1]
    assert json.loads(patch.content) == {"url": "https://oracle.example.com/mcp"}
    assert swarm.servers["oracle"]["url"] == "https://oracle.example.com/mcp"
    assert all("x-swarm-tenant" not in r.headers for r in swarm.requests)

    # While caller MCP is off: a clear 503, nothing registered.
    use(FakeSwarmCloud())
    resp = await client.post("/v1/runtime/mcp-server", headers=auth)
    assert resp.status_code == 503 and "mcp_unavailable" in resp.text


# --------------------------------------------------------------------------- the workflow


async def test_one_workflow_credential_map_and_step_inputs(client, owner):
    tenant_id, auth = owner
    swarm = on()
    use(swarm)
    run = await started(client, auth)
    assert run["status"] == "running"
    # Registered first, then one workflow for the whole run.
    assert swarm.servers["oracle"]["url"] == MCP_URL
    [body] = swarm.submissions()
    token = body["mcp_credentials"]["oracle"]["value"]
    assert body["mcp_credentials"] == {"oracle": {"value": token, "expires_in": 86400}}
    assert body["strategy"] == "collect"
    # A workflow keeps no metadata: the key is in every step's own metadata, plain.
    assert "metadata" not in body
    key = f"oracle-{run['id']}-baseline-1"
    for s in body["steps"]:
        assert s["metadata"]["oracle_key"] == key
        assert all(isinstance(v, str) for v in s["metadata"].values())
    agents = [s for s in body["steps"] if s["runner_profile"] == "claude-code"]
    waits = [s for s in body["steps"] if s["runner_profile"] == "await-input"]
    # 7 agent steps and 2 revisions; 4 checkpoints, the last in 2 rounds.
    assert len(agents) == 7 + 2 and len(waits) == 5
    for s in agents:
        assert set(s["input"]) == {"prompt", "mcp_servers"}
        assert s["input"]["mcp_servers"] == ["oracle"]
    for s in waits:
        assert s["input"] == {"prompt": s["input"]["prompt"]}
        assert s["await_input"] == {
            "form": "verdict",
            "artifact": s["step_id"][-1].join(("review", ".json")),
            "max_files": 0,
            "expires_after_seconds": 72000,
            "on_expire": "fail",
            "remind": [],
        }
        assert "when" not in s
    # The token is only in the credential map, never in a step.
    assert token not in json.dumps(body["steps"])
    # The run token lives exactly as long as the credential.
    row = await run_token_row(tenant_id, token)
    submitted = datetime.fromisoformat((await _wf(tenant_id, run["id"]))["submitted_at"])
    assert abs(row.expires_at - submitted - timedelta(seconds=86400)) < timedelta(seconds=2)
    assert set(row.scopes) == {
        "read:sources",
        "read:baseline",
        "read:documents",
        "write:proposals",
        "write:drafts",
    }
    # Prompts name the tools; nothing earlier is pasted.
    second = next(s for s in agents if s["step_id"].startswith("feature_set-1"))
    assert "get_run_output(seq, name)" in second["input"]["prompt"]
    assert "seq 1 (Baseline proposal): baseline.yaml, summary.md" in second["input"]["prompt"]
    assert "Outputs of earlier segments:" not in second["input"]["prompt"]
    assert second["depends_on"] == ["baseline-review1"]
    body = (await client.get("/v1/runtime/status", headers=auth)).json()
    assert body["can_reach_oracle"] is True


async def _wf(tenant_id, run_id) -> dict:
    async with tenant_session(tenant_id) as s:
        run = await s.get(Run, uuid.UUID(run_id))
        return run.knobs["workflow"]


async def test_credential_lifetime_is_the_budget_and_never_over_86400(client, owner, monkeypatch):
    tenant_id, auth = owner
    monkeypatch.setenv("ORACLE_CHECKPOINT_WAIT_SECONDS", "600")
    monkeypatch.setenv("ORACLE_STEP_SECONDS", "900")
    get_runtime_settings.cache_clear()
    swarm = on()
    use(swarm)
    await feedback_doc(client, auth, tenant_id)
    run = await started(client, auth, flow="feedback_loop", document="checkout-redesign")
    [body] = swarm.submissions()
    # 2 agents + 2 revisions at 900 s, 2 waits at 600 s.
    expected = 4 * 900 + 2 * 600
    assert body["mcp_credentials"]["oracle"]["expires_in"] == expected
    row = await run_token_row(tenant_id, token_of(swarm))
    submitted = datetime.fromisoformat((await _wf(tenant_id, run["id"]))["submitted_at"])
    assert abs(row.expires_at - submitted - timedelta(seconds=expected)) < timedelta(seconds=2)

    # The whole budget above the cap: held to 86400, the token too.
    defaults = RuntimeSettings(step_seconds=7200, checkpoint_wait_seconds=86400)
    assert workflow.credential_seconds(40, 3, defaults) == 86400
    assert workflow.credential_seconds(1, 1, defaults) == 86400
    assert workflow.credential_seconds(0, 0, defaults) == 60


async def test_two_round_workflow_answers_replay_and_the_revise_step(client, owner):
    tenant_id, auth = owner
    swarm = on()
    use(swarm)
    await feedback_doc(client, auth, tenant_id)
    approver = await as_user(tenant_id, "approver", "pm@example.com")
    run = await started(client, auth, flow="feedback_loop", document="checkout-redesign")
    [body] = swarm.submissions()
    shape = [(s["step_id"], s["runner_profile"], s.get("when")) for s in body["steps"]]
    assert shape == [
        ("next_draft-1-analyst", "claude-code", None),
        ("next_draft-2-writer", "claude-code", None),
        ("next_draft-review1", "await-input", None),
        ("next_draft-revise1", "claude-code", None),
        ("next_draft-review2", "await-input", None),
        (
            "next_draft-revise2",
            "claude-code",
            {"step": "next_draft-review2", "verdict_in": ["NOT_YET"]},
        ),
    ]
    steps = {s["step_id"]: s for s in body["steps"]}
    assert steps["next_draft-revise1"]["input_from"] == {
        "next_draft-review1": "review1.json",
        "next_draft-2-writer": "prd.md",
    }
    assert steps["next_draft-review2"]["depends_on"] == ["next_draft-revise1"]

    # The workflow parks on review1: the run waits on that checkpoint.
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "awaiting_checkpoint" and run["waiting_on"] == "prd_review"
    cp = pending(run)
    assert cp["payload"]["wait"]["step_id"] == "next_draft-review1"
    assert cp["payload"]["wait"]["round"] == 1 and cp["payload"]["wait"]["expires_at"]
    assert cp["payload"]["import"]["version"] == 2
    inbox = (await client.get("/v1/inbox", headers=auth)).json()
    assert [c["id"] for c in inbox["checkpoints"]] == [cp["id"]]
    # Still waiting: the tick changes nothing.
    await tick(client, auth)
    assert (await get(client, auth, run["id"]))["status"] == "awaiting_checkpoint"

    # Changes requested: posted as NOT_YET for the deciding user, the same workflow goes on.
    run = await decide(client, approver, run, "changes_requested", note="Add a guardrail metric")
    assert run["status"] == "running"
    assert swarm.answers == [
        {
            "workflow_id": "wf_1",
            "step_id": "next_draft-review1",
            "answer_id": cp["id"],
            "payload": {"verdict": "NOT_YET", "findings": ["Add a guardrail metric"]},
            "via": "mcp",
            "on_behalf_of": "pm@example.com",
        }
    ]
    # The revision ran with review1.json staged, then the second wait opened.
    await tick(client, auth)
    revise = swarm.workflows["wf_1"].step("next_draft-revise1")
    assert json.loads(revise.staged["review1.json"])["verdict"] == "NOT_YET"
    assert "Draft 1" in revise.staged["prd.md"]
    run = await get(client, auth, run["id"])
    assert run["status"] == "awaiting_checkpoint"
    cp2 = pending(run)
    assert cp2["id"] != cp["id"] and cp2["payload"]["wait"]["step_id"] == "next_draft-review2"
    assert cp2["payload"]["import"]["version"] == 3
    assert len(run["segments"][0]["attempts"]) == 2

    # The same answer again (answer_id, payload, on_behalf_of and files) is a 200 replay.
    runtime = swarm.runtime()
    first = swarm.answers[0]
    again = await runtime.answer(
        "wf_1",
        "next_draft-review1",
        answer_id=first["answer_id"],
        payload=first["payload"],
        on_behalf_of=first["on_behalf_of"],
    )
    assert again.replayed is True
    # The same answer_id with any difference, or another answer: 409 already_answered.
    for answer_id, payload, on_behalf_of in [
        (first["answer_id"], {"verdict": "NOT_YET", "findings": ["Other words"]}, "pm@example.com"),
        (first["answer_id"], first["payload"], None),
        (first["answer_id"], first["payload"], "someone@example.com"),
        ("other", {"verdict": "MERGE", "findings": []}, None),
    ]:
        with pytest.raises(RuntimeUnavailable) as exc:
            await runtime.answer(
                "wf_1",
                "next_draft-review1",
                answer_id=answer_id,
                payload=payload,
                on_behalf_of=on_behalf_of,
            )
        assert exc.value.code == "already_answered" and exc.value.status == 409
        assert exc.value.detail["answered_by"] == SERVICE_PRINCIPAL
    # What SwarmCloud serves back: the record, never the payload.
    record = await runtime.answer_record("wf_1", "next_draft-review1", "review1.json")
    assert record.answer_id == cp["id"] and record.verdict == "NOT_YET"
    assert record.findings == ("Add a guardrail metric",)
    assert record.on_behalf_of == "pm@example.com" and record.via == "mcp"
    served = swarm.workflows["wf_1"].step("next_draft-review1").answer
    assert "payload" not in served and served["sha256"]

    # Approved: MERGE, the gated revise2 is skipped, the run and its token end.
    run = await decide(client, approver, run, "approved")
    assert run["status"] == "succeeded"
    assert swarm.answers[-1]["payload"] == {"verdict": "MERGE", "findings": []}
    assert swarm.answers[-1]["answer_id"] == cp2["id"]
    wf = swarm.workflows["wf_1"]
    swarm._advance(wf)
    assert wf.state == "SUCCEEDED" and wf.step("next_draft-revise2").state == "SKIPPED"
    assert len(swarm.submissions()) == 1
    assert await verify_run_token(token_of(swarm)) is None


async def test_multi_segment_run_is_one_workflow(client, owner):
    _, auth = owner
    swarm = on()
    use(swarm)
    run = await started(client, auth)
    expected = ["baseline_confirm", "feature_set", "priority_order", "prd_review"]
    for i, kind in enumerate(expected):
        await tick(client, auth)
        run = await get(client, auth, run["id"])
        assert run["status"] == "awaiting_checkpoint" and run["waiting_on"] == kind, run
        assert run["segments"][i]["status"] == "succeeded"
        assert run["segments"][i]["workflow_id"] == "wf_1"
        run = await decide(client, auth, run, note=f"ok {kind}")
    assert run["status"] == "succeeded"
    assert len(swarm.submissions()) == 1
    assert [a["step_id"] for a in swarm.answers] == [
        "baseline-review1",
        "feature_set-review1",
        "priority-review1",
        "prd_draft-review1",
    ]
    # The last checkpoint approved in round 1: the pass-through rest was cancelled.
    assert swarm.workflows["wf_1"].state == "CANCELLED"
    assert run["segments"][3]["draft_import"]["version"] == 1
    assert run["spent_usd"] > 0
    # Each segment's files are in Oracle for get_run_output.
    art = await client.get(f"/v1/runs/{run['id']}/segments/2/artifacts/design.md", headers=auth)
    assert art.status_code == 200


async def test_changes_mid_workflow_continue_as_a_new_workflow(client, owner):
    _, auth = owner
    swarm = on()
    use(swarm)
    run = await started(client, auth)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    run = await decide(client, auth, run, "changes_requested", note="Name the owner of G1")
    # Not posted: the workflow's next steps assume approval.
    assert swarm.answers == []
    assert swarm.workflows["wf_1"].state == "CANCELLED"
    assert len(swarm.submissions()) == 2
    second = swarm.submissions()[1]
    assert {s["metadata"]["oracle_key"] for s in second["steps"]} == {
        f"oracle-{run['id']}-baseline-2"
    }
    assert "Name the owner of G1" in second["steps"][0]["input"]["prompt"]
    assert any("no revision step" in n for n in run["notes"])
    assert token_of(swarm, 0) != token_of(swarm, 1)
    assert await verify_run_token(token_of(swarm, 0)) is None


# --------------------------------------------------------------------------- tail, expiry


async def test_late_decision_cancels_and_continues_early_one_is_posted(client, owner, monkeypatch):
    tenant_id, auth = owner
    swarm = on()
    use(swarm)
    await feedback_doc(client, auth, tenant_id)
    run = await started(client, auth, flow="feedback_loop", document="checkout-redesign")
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    # Early: 24 h of credential left, more than the 2 h tail: posted.
    run = await decide(client, auth, run, "changes_requested", note="Tighten the scope")
    assert len(swarm.answers) == 1
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert pending(run)["payload"]["wait"]["round"] == 2

    # Late: 23 h later, less than the tail is left.
    real_now = service._now
    monkeypatch.setattr(service, "_now", lambda: real_now() + timedelta(hours=23))
    old_token = token_of(swarm)
    run = await decide(client, auth, run, "changes_requested", note="Still too broad")
    assert len(swarm.answers) == 1  # not posted
    assert swarm.workflows["wf_1"].state == "CANCELLED"
    assert len(swarm.submissions()) == 2
    assert "Still too broad" in swarm.submissions()[1]["steps"][0]["input"]["prompt"]
    assert token_of(swarm) != old_token and await verify_run_token(old_token) is None
    assert any("under the 2 h 0 min tail" in n for n in run["notes"]), run["notes"]
    assert run["status"] == "running"


def test_tail_covers_the_agent_steps_after_the_wait():
    plan = [
        {"seq": 1, "work": ["a", "b"], "checkpoint": True, "reviews": ["r"], "revises": []},
        {"seq": 2, "work": ["c", "d"], "checkpoint": False, "reviews": [], "revises": []},
        {"seq": 3, "work": ["e"], "checkpoint": True, "reviews": ["r3"], "revises": []},
        {"seq": 4, "work": ["f"], "checkpoint": True, "reviews": ["x", "y"], "revises": ["p", "q"]},
    ]
    # Approved: the next segments' work up to the next checkpoint (2 + 1).
    assert workflow.agent_steps_after(plan, 1, True, 1) == 3
    assert workflow.agent_steps_after(plan, 3, True, 1) == 1
    # Changes in the last segment: its revision; approved there: nothing (Oracle stops it).
    assert workflow.agent_steps_after(plan, 4, False, 1) == 1
    assert workflow.agent_steps_after(plan, 4, False, 2) == 1
    assert workflow.agent_steps_after(plan, 4, True, 1) == 0
    settings = RuntimeSettings(step_seconds=3600, checkpoint_tail_seconds=7200)
    assert workflow.tail_seconds(3, settings) == 3 * 3600
    assert workflow.tail_seconds(1, settings) == 7200  # the setting is the least
    assert workflow.tail_seconds(0, settings) == 0


async def test_a_decision_leaving_too_little_for_the_next_steps_continues(
    client, owner, monkeypatch
):
    """The tail covers the agent steps after the wait (2 x 2 h for feature_set), not a
    fixed 2 h: with 3 h left, the decision is not posted (it would fail later with
    mcp_credential_expired); the run continues as a new workflow."""
    _, auth = owner
    swarm = on()
    use(swarm)
    run = await started(client, auth)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    real_now = service._now
    monkeypatch.setattr(service, "_now", lambda: real_now() + timedelta(hours=21))
    run = await decide(client, auth, run, "approved")
    assert swarm.answers == [] and swarm.workflows["wf_1"].state == "CANCELLED"
    assert len(swarm.submissions()) == 2
    assert swarm.submissions()[1]["steps"][0]["step_id"].startswith("feature_set-")
    assert any("under the 4 h 0 min tail" in n and "2 agent step" in n for n in run["notes"])


async def test_a_decision_with_enough_left_for_the_next_steps_is_posted(client, owner, monkeypatch):
    _, auth = owner
    swarm = on()
    use(swarm)
    run = await started(client, auth)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    real_now = service._now
    monkeypatch.setattr(service, "_now", lambda: real_now() + timedelta(hours=19))
    run = await decide(client, auth, run, "approved")
    assert len(swarm.answers) == 1 and len(swarm.submissions()) == 1
    assert run["status"] == "running"


async def test_expiry_keeps_the_checkpoint_open_and_continues_as_a_new_workflow(client, owner):
    tenant_id, auth = owner
    swarm = on()
    use(swarm)
    await feedback_doc(client, auth, tenant_id)
    run = await started(client, auth, flow="feedback_loop", document="checkout-redesign")
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    cp = pending(run)
    swarm.tick(86400 + 1)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    # W2b: nothing approved by default; the checkpoint stays open in the Inbox.
    assert run["status"] == "awaiting_checkpoint" and pending(run)["id"] == cp["id"]
    assert pending(run)["payload"]["wait"]["ended"] == "expired"
    assert any("expired" in n for n in run["notes"])
    assert swarm.workflows["wf_1"].step("next_draft-review1").answer_state == "expired"
    assert await verify_run_token(token_of(swarm)) is None
    inbox = (await client.get("/v1/inbox", headers=auth)).json()
    assert [c["id"] for c in inbox["checkpoints"]] == [cp["id"]]

    # Deciding continues the run as a new workflow (today's flow), with a fresh token.
    run = await decide(client, auth, run, "changes_requested", note="Cover returns too")
    assert swarm.answers == []
    assert len(swarm.submissions()) == 2 and run["status"] == "running"
    assert await verify_run_token(token_of(swarm)) is not None


async def test_person_required_falls_back_to_todays_flow(client, owner):
    tenant_id, auth = owner
    swarm = on()
    use(swarm)
    await feedback_doc(client, auth, tenant_id)
    run = await started(client, auth, flow="feedback_loop", document="checkout-redesign")
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    # Before SwarmCloud lets a service principal answer: 403 forbidden, person_required.
    swarm.service_answer = False
    run = await decide(client, auth, run, "changes_requested", note="Cover refunds")
    # Not "decide again": the run continues as a new workflow with the decision.
    assert any("person_required" in n for n in run["notes"])
    assert swarm.workflows["wf_1"].state == "CANCELLED"
    assert run["status"] == "running" and len(swarm.submissions()) == 2
    second = swarm.submissions()[1]
    assert all(s["runner_profile"] == "claude-code" for s in second["steps"])
    assert "Cover refunds" in second["steps"][0]["input"]["prompt"]
    # Recorded as off, cached like the other features: the next run is per segment.
    status = (await client.get("/v1/runtime/status", headers=auth)).json()
    assert status["features"]["service_answer"] == "off"
    assert "person_required" in status["feature_reasons"]["service_answer"]
    await started(client, auth, flow="feedback_loop", document="checkout-redesign")
    third = swarm.submissions()[-1]
    assert all(s["runner_profile"] == "claude-code" for s in third["steps"])
    assert third["mcp_credentials"]["oracle"]["value"]  # MCP stays on


async def _waiting(client, auth, tenant_id, swarm: FakeSwarmCloud) -> dict:
    use(swarm)
    await feedback_doc(client, auth, tenant_id)
    run = await started(client, auth, flow="feedback_loop", document="checkout-redesign")
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "awaiting_checkpoint"
    return run


async def _decide_raw(client, auth, run, decision, note=None):
    cp = pending(run)
    return await client.post(
        f"/v1/runs/{run['id']}/checkpoints/{cp['id']}/decide",
        json={"decision": decision, "note": note},
        headers=auth,
    )


def _live_with(swarm: FakeSwarmCloud, step_prefix: str) -> list[str]:
    """Workflows not cancelled that hold a step of the segment (never more than one)."""
    return [
        w.workflow_id
        for w in swarm.workflows.values()
        if w.state != "CANCELLED" and any(s.step_id.startswith(step_prefix) for s in w.steps)
    ]


async def test_already_answered_by_oracles_lost_post_with_the_same_verdict(client, owner):
    """(b) Oracle's earlier post was recorded but its response lost; deciding again with
    other words gets 409 already_answered: same verdict, so the run follows the workflow
    and notes that SwarmCloud kept the earlier wording."""
    tenant_id, auth = owner
    swarm = on()
    run = await _waiting(client, auth, tenant_id, swarm)
    cp = pending(run)
    swarm.lose_next_answer = True
    resp = await _decide_raw(client, auth, run, "changes_requested", "Add a guardrail metric")
    assert resp.status_code == 503 and "decide again" in resp.text
    run = await get(client, auth, run["id"])
    assert run["status"] == "awaiting_checkpoint" and pending(run)["id"] == cp["id"]
    # Meanwhile the workflow went on with the recorded answer.
    assert swarm.workflows["wf_1"].step("next_draft-revise1").state == "SUCCEEDED"
    run = await decide(client, auth, run, "changes_requested", note="Add a guardrail KPI")
    assert run["status"] == "running"
    assert len(swarm.submissions()) == 1 and _live_with(swarm, "next_draft") == ["wf_1"]
    assert any("kept the earlier wording" in n for n in run["notes"]), run["notes"]
    assert not any("decided outside Oracle" in n for n in run["notes"])
    decided = next(c for c in run["checkpoints"] if c["id"] == cp["id"])
    answered = decided["payload"]["wait"]["answered"]
    assert answered["answer_id"] == cp["id"] and answered["kept_earlier"] is True
    assert answered["answered_by"] == SERVICE_PRINCIPAL and answered["at"]
    # What was applied is SwarmCloud's recorded wording, by whom; the Inbox's is kept apart.
    recorded = decided["payload"]["wait"]["recorded"]
    assert recorded["findings"] == ["Add a guardrail metric"]
    assert answered["not_applied"] == "Add a guardrail KPI"
    attempt = run["segments"][0]["attempts"][-1]
    assert attempt["note"] == "Add a guardrail metric"
    # Whose: who SwarmCloud recorded as answering (answered_by), never the label.
    assert attempt["note_by"] == recorded["answered_by"] == SERVICE_PRINCIPAL
    assert attempt["not_applied"] == "Add a guardrail KPI"
    # The revision used the first wording; the run goes on to round 2 in the same workflow.
    staged = json.loads(swarm.workflows["wf_1"].step("next_draft-revise1").staged["review1.json"])
    assert staged["findings"] == ["Add a guardrail metric"]
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "awaiting_checkpoint"
    assert pending(run)["payload"]["wait"]["step_id"] == "next_draft-review2"
    assert len(swarm.submissions()) == 1


async def test_a_lost_approval_corrected_to_changes_continues_as_a_new_workflow(client, owner):
    """(c) A lost approval, then a request for changes: the recorded MERGE differs, so the
    Inbox decision is a correction. The workflow is cancelled and the run continues as a
    new workflow carrying it, with no segment running twice."""
    tenant_id, auth = owner
    swarm = on()
    run = await _waiting(client, auth, tenant_id, swarm)
    swarm.lose_next_answer = True
    resp = await _decide_raw(client, auth, run, "approved")
    assert resp.status_code == 503
    assert swarm.verdict("wf_1", "next_draft-review1") == "MERGE"
    run = await get(client, auth, run["id"])
    run = await decide(client, auth, run, "changes_requested", note="Split the rollout")
    assert swarm.workflows["wf_1"].state == "CANCELLED"
    assert len(swarm.submissions()) == 2 and run["status"] == "running"
    assert "Split the rollout" in swarm.submissions()[1]["steps"][0]["input"]["prompt"]
    assert _live_with(swarm, "next_draft") == ["wf_2"]
    assert any("correction" in n for n in run["notes"]), run["notes"]
    # One answer posted (the lost one); nothing posted to the new workflow yet.
    assert [a["payload"]["verdict"] for a in swarm.answers] == ["MERGE"]


async def test_answered_in_the_console_with_the_same_verdict_is_followed(client, owner):
    """(d) + (b): someone answered in SwarmCloud's console; same verdict as the Inbox."""
    tenant_id, auth = owner
    swarm = on()
    run = await _waiting(client, auth, tenant_id, swarm)
    swarm.console_answer("wf_1", "next_draft-review1", "MERGE", by="lead@example.com")
    run = await decide(client, auth, run, "approved")
    assert run["status"] == "succeeded" and swarm.answers == []
    assert len(swarm.submissions()) == 1
    notes = " ".join(run["notes"])
    assert "decided outside Oracle" in notes and "lead@example.com" in notes
    assert "via console" in notes
    cp = next(c for c in run["checkpoints"] if c["payload"].get("wait"))
    assert cp["payload"]["wait"]["recorded"]["outside_oracle"] is True
    assert cp["payload"]["wait"]["answered"]["answered_by"] == "lead@example.com"


async def test_console_changes_at_the_last_checkpoint_then_approval_stops_the_rest(client, owner):
    """(d): the console answered NOT_YET at the last checkpoint; Oracle approves. The
    approval needs no work the workflow did not do: the run ends on the draft it showed,
    and the workflow's revision (work nobody uses) is stopped. Nothing is resubmitted."""
    tenant_id, auth = owner
    swarm = on()
    run = await _waiting(client, auth, tenant_id, swarm)
    swarm.console_answer("wf_1", "next_draft-review1", "NOT_YET", ["Shorter"], by="cto@example.com")
    run = await decide(client, auth, run, "approved")
    assert swarm.workflows["wf_1"].state == "CANCELLED"
    assert run["status"] == "succeeded" and len(swarm.submissions()) == 1
    notes = " ".join(run["notes"])
    assert "decided outside Oracle" in notes and "cto@example.com" in notes
    assert "console recorded NOT_YET" in notes and "Shorter" in notes
    assert "correction" not in notes


async def test_console_changes_mid_run_then_approval_continues_once(client, owner):
    """(d) mid-run: the console answered NOT_YET at the first checkpoint, which has no
    revise step and no gate, so the workflow went on into the next segment, exactly what
    Oracle's approval needs. Oracle follows it: feature_set runs once, in wf_1, and a
    note records what the console answered."""
    _, auth = owner
    swarm = on()
    use(swarm)
    run = await started(client, auth)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    swarm.console_answer("wf_1", "baseline-review1", "NOT_YET", ["Missing goal"], by="cto@x.test")
    # The workflow went on with the console's answer, into the next segment.
    went_on = [s for s in swarm.workflows["wf_1"].steps if s.step_id.startswith("feature_set-1")]
    assert went_on and went_on[0].state == "SUCCEEDED"
    run = await decide(client, auth, run, "approved")
    assert swarm.workflows["wf_1"].state == "RUNNING" and swarm.cancels == []
    assert len(swarm.submissions()) == 1
    assert _live_with(swarm, "feature_set") == ["wf_1"]
    assert run["status"] == "running" and run["segments"][1]["status"] == "running"
    notes = " ".join(run["notes"])
    assert "console recorded NOT_YET" in notes and "cto@x.test" in notes
    assert "via console" in notes and "Missing goal" in notes
    assert "correction" not in notes
    # feature_set's checkpoint opens from wf_1: it ran once, nothing is resubmitted.
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "awaiting_checkpoint" and run["waiting_on"] == "feature_set"
    assert pending(run)["payload"]["wait"]["workflow_id"] == "wf_1"
    assert len(swarm.submissions()) == 1
    ran = [s for s in swarm.workflows["wf_1"].steps if s.step_id.startswith("feature_set-")]
    assert all(s.state == "SUCCEEDED" for s in ran if s.profile == "claude-code")


@pytest.mark.parametrize("reason", ["not_open", "expired", "cancelled"])
async def test_a_closed_wait_continues_as_a_new_workflow(client, owner, reason):
    tenant_id, auth = owner
    swarm = on()
    run = await _waiting(client, auth, tenant_id, swarm)
    swarm.fail_next_answer = httpx.Response(
        409,
        json={
            "code": "conflict",
            "message": f"the step is {reason}",
            "detail": {"reason": reason, "state": reason},
        },
    )
    run = await decide(client, auth, run, "changes_requested", note="Cover returns")
    assert run["status"] == "running" and len(swarm.submissions()) == 2
    assert swarm.workflows["wf_1"].state == "CANCELLED"
    assert _live_with(swarm, "next_draft") == ["wf_2"]
    assert any(reason in n for n in run["notes"]), run["notes"]


@pytest.mark.parametrize(
    "status,reason",
    [
        (422, "invalid_form"),
        (404, "not_found"),
        (403, "not_a_member"),
        (403, "role_member_required"),
    ],
)
async def test_other_refusals_are_not_posted_and_continue(client, owner, status, reason):
    tenant_id, auth = owner
    swarm = on()
    run = await _waiting(client, auth, tenant_id, swarm)
    generic = {403: "forbidden", 404: "not_found", 422: "validation_error"}[status]
    swarm.fail_next_answer = httpx.Response(
        status, json={"code": generic, "message": "no", "detail": {"reason": reason}}
    )
    run = await decide(client, auth, run, "approved")
    # Not posted, and not "decide again": approved at the last checkpoint, the run ends.
    assert run["status"] == "succeeded" and swarm.answers == []
    assert swarm.workflows["wf_1"].state == "CANCELLED"
    assert any("was not posted" in n and reason in n for n in run["notes"]), run["notes"]


@pytest.mark.parametrize("reason", ["membership_unavailable", "role_unavailable", "unavailable"])
async def test_503_is_retried(client, owner, reason):
    tenant_id, auth = owner
    swarm = on()
    run = await _waiting(client, auth, tenant_id, swarm)
    swarm.fail_next_answer = httpx.Response(
        503, json={"code": "unavailable", "message": "try later", "detail": {"reason": reason}}
    )
    resp = await _decide_raw(client, auth, run, "changes_requested", "Cover returns")
    assert resp.status_code == 503 and "decide again" in resp.text
    run = await get(client, auth, run["id"])
    assert run["status"] == "awaiting_checkpoint" and swarm.answers == []
    run = await decide(client, auth, run, "changes_requested", note="Cover returns")
    assert len(swarm.answers) == 1 and len(swarm.submissions()) == 1
    assert run["status"] == "running"


# --------------------------------------------------------------------------- labels


def _task_lookups(swarm: FakeSwarmCloud) -> list[httpx.Request]:
    return [r for r in swarm.requests if r.method == "GET" and r.url.path == "/v1/tasks"]


async def test_a_lost_submit_is_found_by_its_key(client, owner):
    _, auth = owner
    swarm = on()
    use(swarm)
    swarm.lose_next_submit = True
    run = await started(client, auth)
    # Created in SwarmCloud, answer lost: found by its key, not submitted twice.
    assert len(swarm.workflows) == 1 and len(swarm.submissions()) == 1
    assert run["segments"][0]["workflow_id"] == "wf_1" and run["status"] == "running"
    # Oracle's own tasks, submitted_by alone (other filters would short the pages).
    [lookup] = _task_lookups(swarm)
    assert dict(lookup.url.params) == {"submitted_by": "me", "limit": "50"}
    # The token the lost submission carried is the run's live one.
    assert await verify_run_token(token_of(swarm)) is not None
    # Played to the end: one workflow ran, and the run was charged for it once.
    for _ in range(4):
        await tick(client, auth)
        run = await get(client, auth, run["id"])
        if run["status"] == "awaiting_checkpoint":
            run = await decide(client, auth, run)
    assert run["status"] == "succeeded", run
    assert len(swarm.workflows) == 1 and len(swarm.submissions()) == 1
    assert run["spent_usd"] > 0
    assert run["spent_usd"] <= sum(s.cost for s in swarm.workflows["wf_1"].steps)


async def test_a_lost_submit_is_found_on_a_later_page(client, owner):
    _, auth = owner
    swarm = on()
    use(swarm)
    swarm.other_tasks = 120  # newer tasks of Oracle's: the key is on the third page
    swarm.lose_next_submit = True
    run = await started(client, auth)
    assert len(swarm.workflows) == 1 and run["segments"][0]["workflow_id"] == "wf_1"
    lookups = _task_lookups(swarm)
    assert [r.url.params.get("page_token") for r in lookups] == [None, "50", "100"]
    for r in lookups:
        assert set(r.url.params) <= {"submitted_by", "limit", "page_token"}


async def test_a_lost_submit_and_lookup_is_looked_up_again_before_resubmitting(client, owner):
    _, auth = owner
    swarm = on()
    use(swarm)
    swarm.lose_next_submit = True
    swarm.lose_next_lookup = True
    run = await started(client, auth)
    assert run["segments"][0]["status"] == "pending"
    assert "looks for submission" in run["segments"][0]["error"]
    assert await verify_run_token(token_of(swarm)) is not None  # kept for the workflow
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["segments"][0]["workflow_id"] == "wf_1" and run["status"] == "running"
    assert len(swarm.workflows) == 1 and len(swarm.submissions()) == 1


async def test_a_submit_lost_before_swarmcloud_created_it_is_sent_again(client, owner):
    _, auth = owner
    swarm = on()
    use(swarm)
    swarm.fail_next_submit = httpx.Response(502, text="bad gateway")
    run = await started(client, auth)
    assert run["segments"][0]["status"] == "pending"
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    labels = [b["steps"][0]["metadata"]["oracle_key"] for b in swarm.submissions()]
    assert labels == [f"oracle-{run['id']}-baseline-1"] * 2
    assert len(swarm.workflows) == 1 and run["segments"][0]["workflow_id"] == "wf_1"


# --------------------------------------------------------------------------- fallback


async def test_fallback_while_switches_are_off(client, owner):
    _, auth = owner
    swarm = FakeSwarmCloud()
    use(swarm)
    run = await started(client, auth)
    [body] = swarm.submissions()
    # Today's flow: one workflow per segment, nothing attached.
    assert "mcp_credentials" not in body
    assert all("mcp_servers" not in s["input"] for s in body["steps"])
    assert all(s["runner_profile"] == "claude-code" for s in body["steps"])
    assert [s["step_id"] for s in body["steps"]] == ["baseline-1-researcher", "baseline-2-analyst"]
    assert any("mcp_unavailable" in n for n in run["notes"])
    assert any("one workflow per segment" in n for n in run["notes"])
    assert swarm.servers == {}
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "awaiting_checkpoint" and "wait" not in pending(run)["payload"]
    await decide(client, auth, run)
    assert len(swarm.submissions()) == 2
    second = swarm.submissions()[1]["steps"][0]["input"]["prompt"]
    assert "Outputs of earlier segments:" in second  # pasted, as today


async def test_await_input_refused_at_submit_falls_back_per_segment(client, owner):
    _, auth = owner
    # await-input not reported: tried, refused with 422, submitted per segment with MCP.
    swarm = FakeSwarmCloud(mcp=True, service_answer=True, report_capacity=False)
    use(swarm)
    run = await started(client, auth)
    first, second = swarm.submissions()
    assert any(s["runner_profile"] == "await-input" for s in first["steps"])
    assert all(s["runner_profile"] == "claude-code" for s in second["steps"])
    assert second["mcp_credentials"]["oracle"]["expires_in"] == 2 * 7200
    assert all(s["input"]["mcp_servers"] == ["oracle"] for s in second["steps"])
    assert any("await-input is disabled" in n for n in run["notes"])
    status = (await client.get("/v1/runtime/status", headers=auth)).json()
    assert status["features"]["await_input"] == "off"
    assert len(swarm.workflows) == 1


async def test_segment_mode_attaches_the_token_whenever_mcp_is_on(client, owner):
    """MCP on, await-input off: one workflow per segment, and the run token attached on
    purpose (agents read Oracle's data whenever MCP is on); the notes say so."""
    _, auth = owner
    swarm = FakeSwarmCloud(mcp=True, service_answer=True)
    use(swarm)
    run = await started(client, auth)
    [body] = swarm.submissions()
    assert all(s["runner_profile"] == "claude-code" for s in body["steps"])
    assert body["mcp_credentials"]["oracle"]["value"]
    assert all(s["input"]["mcp_servers"] == ["oracle"] for s in body["steps"])
    assert any("agents read Oracle's data whenever MCP is on" in n for n in run["notes"])


async def test_mcp_switched_off_before_submit_falls_back(client, owner):
    _, auth = owner
    # Caller MCP read as on, switched off before the submit: 503, nothing attached.
    swarm = on()
    runtime = use(swarm)
    await runtime.features()
    await runtime.ensure_mcp_server(MCP_URL)
    swarm.mcp = False
    run = await started(client, auth)
    last = swarm.submissions()[-1]
    assert "mcp_credentials" not in last and len(swarm.workflows) == 1
    assert all("mcp_servers" not in s["input"] for s in last["steps"])
    assert any("mcp_unavailable" in n for n in run["notes"])


async def test_unregistered_server_is_registered_again(client, owner):
    _, auth = owner
    swarm = on()
    runtime = use(swarm)
    await runtime.ensure_mcp_server(MCP_URL)
    swarm.servers.clear()  # SwarmCloud lost it
    run = await started(client, auth)
    assert run["status"] == "running" and swarm.servers["oracle"]["url"] == MCP_URL
    assert len(swarm.workflows) == 1 and "mcp_credentials" in swarm.submissions()[-1]


# --------------------------------------------------------------------------- step failures


@pytest.mark.parametrize(
    "code,says",
    [
        ("mcp_server_withheld", "ORACLE_PUBLIC_URL/mcp"),
        ("mcp_credential_expired", "run token expired"),
    ],
)
async def test_step_failures_say_what_to_do(client, owner, code, says):
    _, auth = owner
    swarm = on()
    use(swarm)
    swarm.step_failure["baseline-1-researcher"] = (code, "from the fake")
    run = await started(client, auth)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "failed" and code in run["error"] and says in run["error"]


async def test_credential_missing_park_is_noted(client, owner):
    _, auth = owner
    swarm = on()
    use(swarm)
    await swarm.runtime().ensure_mcp_server(MCP_URL)
    swarm.servers["oracle"]["enabled"] = False
    run = await started(client, auth)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "running"
    assert any("CREDENTIAL_MISSING" in n for n in run["notes"])


def test_every_contract_code_has_advice():
    for code in (
        "mcp_server_unregistered",
        "mcp_server_profile_refused",
        "mcp_credential_missing",
        "mcp_credential_unexpected",
        "mcp_credential_shape",
        "mcp_credential_expired",
        "mcp_server_withheld",
        "CREDENTIAL_MISSING",
        "already_answered",
        "not_open",
        "expired",
        "person_required",
        "mcp_unavailable",
        "await_input_disabled",
    ):
        assert code in workflow.ADVICE and len(workflow.ADVICE[code]) > 40


# --------------------------------------------------------------------------- egress


@asynccontextmanager
async def mcp_session(token: str, forwarded: str | None):
    headers = {"Authorization": f"Bearer {token}"}
    if forwarded is not None:
        headers["X-Forwarded-For"] = forwarded
    http = httpx2.AsyncClient(
        transport=httpx2.ASGITransport(app=app), base_url="http://test", headers=headers
    )
    client = Client(streamable_http_client("http://test/mcp", http_client=http), mode="legacy")
    async with http, client as c:
        yield c


def test_client_address_takes_the_right_hop():
    from starlette.requests import Request

    def req(*values: str) -> Request:
        headers = [(b"x-forwarded-for", v.encode()) for v in values]
        return Request({"type": "http", "headers": headers, "client": ("10.0.0.9", 1)})

    assert client_address(req(f"203.0.113.7, {LB}"), 1) == "203.0.113.7"
    # A spoofed first entry is never taken.
    assert client_address(req(f"203.0.113.7, 198.51.100.20, {LB}"), 1) == "198.51.100.20"
    assert client_address(req("203.0.113.7", f"198.51.100.20, {LB}"), 1) == "198.51.100.20"
    assert client_address(req(LB), 1) is None
    assert client_address(req(), 1) is None
    assert client_address(req("1.2.3.4"), 0) == "10.0.0.9"


async def test_run_tokens_only_from_swarmclouds_egress(client, owner):
    tenant_id, auth = owner
    swarm = on()
    use(swarm)
    run = await started(client, auth)
    token = token_of(swarm)
    ping = {"jsonrpc": "2.0", "id": 1, "method": "ping"}

    def headers(forwarded: str | None) -> dict[str, str]:
        h = {"Authorization": f"Bearer {token}", "Accept": "application/json, text/event-stream"}
        if forwarded is not None:
            h["X-Forwarded-For"] = forwarded
        return h

    ok = await client.post("/mcp", json=ping, headers=headers(f"{EGRESS[0]}, {LB}"))
    assert ok.status_code == 200, ok.text
    for forwarded in (
        f"{EGRESS[0]}, 198.51.100.20, {LB}",  # the spoof: SwarmCloud's address first
        f"198.51.100.20, {LB}",
        EGRESS[0],  # no load balancer hop
        None,
    ):
        resp = await client.post("/mcp", json=ping, headers=headers(forwarded))
        assert resp.status_code == 403, forwarded
        assert token not in resp.text
    # People's API tokens work from any address.
    resp = await client.post(
        "/mcp",
        json=ping,
        headers={
            **auth,
            "Accept": "application/json, text/event-stream",
            "X-Forwarded-For": "1.1.1.1",
        },
    )
    assert resp.status_code == 200

    # An agent reads the run's earlier outputs through get_run_output.
    await tick(client, auth)
    async with mcp_session(token, f"{EGRESS[1]}, {LB}") as c:
        names = {t.name for t in (await c.list_tools()).tools}
        assert "get_run_output" in names
        out = await c.call_tool("get_run_output", {"seq": 1, "name": "summary.md"})
        assert not out.is_error and "baseline" in out.content[0].text
    with pytest.raises(BaseException):  # noqa: B017 - the client fails on the 403
        async with mcp_session(token, f"198.51.100.20, {LB}") as c:
            await c.list_tools()

    # The egress list is SwarmCloud's, refreshed: a new address is honoured.
    swarm.egress = ["192.0.2.50"]
    runtime = use(swarm, egress_refresh=0)
    assert await runtime.egress_addresses() == frozenset({"192.0.2.50"})
    resp = await client.post("/mcp", json=ping, headers=headers(f"192.0.2.50, {LB}"))
    assert resp.status_code == 200
    assert run["status"] == "awaiting_checkpoint" or run["status"] == "running"


async def test_an_egress_listing_without_addresses_is_not_reread_per_request():
    swarm = on()
    swarm.egress = None  # type: ignore[assignment]
    runtime = swarm.runtime(egress_refresh=300)

    def listings() -> int:
        return sum(1 for r in swarm.requests if r.url.path == "/v1/mcp-servers")

    assert await runtime.egress_addresses() == frozenset()
    for _ in range(5):
        assert await runtime.egress_addresses() == frozenset()
    assert listings() == 1


async def test_unauthenticated_run_tokens_do_not_each_call_swarmcloud(client, owner):
    swarm = on()
    swarm.egress = None  # type: ignore[assignment]
    use(swarm)
    ping = {"jsonrpc": "2.0", "id": 1, "method": "ping"}
    for _ in range(5):
        resp = await client.post(
            "/mcp",
            json=ping,
            headers={
                "Authorization": "Bearer ort_x",
                "Accept": "application/json, text/event-stream",
                "X-Forwarded-For": f"198.51.100.20, {LB}",
            },
        )
        assert resp.status_code in (401, 403)
    assert sum(1 for r in swarm.requests if r.url.path == "/v1/mcp-servers") <= 1


async def test_get_run_output_takes_a_whole_seq_and_a_plain_file_name(client, owner):
    _, auth = owner
    swarm = on()
    use(swarm)
    run = await started(client, auth)
    await tick(client, auth)
    token = token_of(swarm)
    async with mcp_session(token, f"{EGRESS[0]}, {LB}") as c:
        ok = await c.call_tool("get_run_output", {"seq": 1, "name": "summary.md"})
        assert not ok.is_error
        for args in (
            {"seq": "1; drop", "name": "summary.md"},
            {"seq": 1.5, "name": "summary.md"},
            {"seq": True, "name": "summary.md"},
            {"seq": 0, "name": "summary.md"},
            {"seq": 1, "name": "../1/summary.md"},
            {"seq": 1, "name": "a/b.md"},
            {"seq": 1, "name": ".."},
            {"seq": 1, "name": "x\\..\\y"},
        ):
            out = await c.call_tool("get_run_output", args)
            # Refused by the tool itself, before any request is built from the arguments.
            said = out.content[0].text
            assert out.is_error and ("whole number" in said or "plain file name" in said), args
    assert run["id"]


# --------------------------------------------------------------------------- secrecy


async def test_no_credential_in_any_response_note_or_log(client, owner, caplog):
    tenant_id, auth = owner
    caplog.set_level(logging.DEBUG)
    swarm = on()
    use(swarm)
    await feedback_doc(client, auth, tenant_id)
    run = await started(client, auth, flow="feedback_loop", document="checkout-redesign")
    token = token_of(swarm)
    seen: list[str] = []
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    seen.append(json.dumps(run))
    run = await decide(client, auth, run, "changes_requested", note="More detail")
    seen.append(json.dumps(run))
    await tick(client, auth)
    paths = ("/v1/runs", f"/v1/runs/{run['id']}", "/v1/inbox", "/v1/runtime/status", "/v1/flows")
    for path in paths:
        seen.append((await client.get(path, headers=auth)).text)
    # A refusal echoing the token is withheld.
    swarm.fail_next_submit = httpx.Response(
        422,
        json={
            "code": "validation_error",
            "message": f"bad {token}",
            "detail": {"reason": "mcp_credential_shape"},
        },
    )
    try:
        await swarm.runtime().submit(WorkflowSpec(name="x", steps=()))
    except RuntimeUnavailable as exc:
        seen.append(str(exc))
    seen.append(caplog.text)
    async with tenant_session(tenant_id) as s:
        for r in await s.scalars(select(Run)):
            seen.append(json.dumps(r.knobs, default=str))
    for text in seen:
        assert token not in text
    # SwarmCloud saw it in the credential map only.
    for r in swarm.requests:
        content = r.content.decode() if r.content else ""
        if token in content:
            assert r.method == "POST" and r.url.path == "/v1/workflows"
            assert json.loads(content)["mcp_credentials"]["oracle"]["value"] == token
        assert token not in str(r.url) and token not in json.dumps(dict(r.headers))
    # Gone once the run ends.
    run = await decide(client, auth, await get(client, auth, run["id"]), "approved")
    assert await verify_run_token(token) is None


async def _ceiling(tenant_id, run_id: str, usd: str) -> None:
    async with tenant_session(tenant_id) as s:
        row = await s.get(Run, uuid.UUID(run_id))
        row.knobs = {**row.knobs, "spend_ceiling_usd": usd}
        await s.commit()


async def test_a_run_paused_on_overrun_cancels_its_workflow_and_opens_in_the_inbox(client, owner):
    tenant_id, auth = owner
    swarm = on()
    use(swarm)
    await feedback_doc(client, auth, tenant_id)
    run = await started(client, auth, flow="feedback_loop", document="checkout-redesign")
    await _ceiling(tenant_id, run["id"], "0.5")
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "paused_overrun"
    # Nothing more is spent: the workflow is cancelled and its token revoked.
    assert swarm.workflows["wf_1"].state == "CANCELLED"
    assert await verify_run_token(token_of(swarm)) is None
    assert any("cancelled the run's SwarmCloud workflow" in n for n in run["notes"])
    swarm.tick(86400 + 1)
    resp = await client.post(f"/v1/runs/{run['id']}/resume", headers=auth)
    assert resp.status_code == 200, resp.text
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    # The draft was written before the pause: its checkpoint opens in the Inbox only.
    assert run["status"] == "awaiting_checkpoint"
    assert "wait" not in pending(run)["payload"]
    run = await decide(client, auth, run, "approved")
    assert run["status"] == "succeeded" and swarm.answers == []
    assert len(swarm.submissions()) == 1


async def test_checkpoint_off_segments_stop_spending_when_paused(client, owner):
    tenant_id, auth = owner
    swarm = on()
    use(swarm)
    off = {"baseline_confirm": False, "feature_set": False, "priority_order": False}
    run = await started(client, auth, checkpoints=off)
    [body] = swarm.submissions()
    assert [s["step_id"] for s in body["steps"] if s["runner_profile"] == "await-input"] == [
        "prd_draft-review1",
        "prd_draft-review2",
    ]
    await _ceiling(tenant_id, run["id"], "0.5")
    # The engine runs one step per poll here: the first poll finds baseline's researcher
    # done (and over the ceiling) while the rest have not started.
    swarm.steps_per_poll = 1
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "paused_overrun"
    wf = swarm.workflows["wf_1"]
    assert wf.state == "CANCELLED"
    spent = sum(s.cost for s in wf.steps)
    assert not any(s.state == "SUCCEEDED" for s in wf.steps if s.step_id.startswith("feature_set"))
    swarm._advance(wf)
    assert sum(s.cost for s in wf.steps) == spent  # nothing more ran
    # Resumed: the unfinished segment is submitted again as a new workflow.
    seg = run["segments"][0]
    assert seg["status"] == "pending" and "resuming submits" in seg["error"]
    resp = await client.post(f"/v1/runs/{run['id']}/resume", headers=auth)
    assert resp.status_code == 200, resp.text
    await tick(client, auth)
    assert len(swarm.submissions()) == 2
    assert swarm.submissions()[1]["steps"][0]["step_id"] == "baseline-1-researcher"
    assert _live_with(swarm, "baseline") == ["wf_2"]


# --------------------------------------------------------------------------- review fixes, round 2
# The invariant: no segment ever runs in two workflows, and spend never escapes the ceiling.


def _input_reads(swarm: FakeSwarmCloud, step_id: str) -> int:
    path = f"/steps/{step_id}/input"
    return sum(1 for r in swarm.requests if r.method == "GET" and r.url.path.endswith(path))


async def _knobs_of(tenant_id, run_id: str) -> dict:
    async with tenant_session(tenant_id) as s:
        return (await s.get(Run, uuid.UUID(run_id))).knobs


async def test_console_approval_mid_run_then_changes_is_a_correction(client, owner):
    """The console answered MERGE at the first checkpoint and the workflow moved on; the
    Inbox requests changes, which needs a revision the workflow never ran: the workflow
    is cancelled and the segment runs again, once, as a new workflow."""
    _, auth = owner
    swarm = on()
    use(swarm)
    run = await started(client, auth)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    swarm.console_answer("wf_1", "baseline-review1", "MERGE")
    run = await decide(client, auth, run, "changes_requested", note="Name the owner of G1")
    assert swarm.workflows["wf_1"].state == "CANCELLED"
    assert len(swarm.submissions()) == 2
    assert swarm.submissions()[1]["steps"][0]["step_id"].startswith("baseline-")
    assert "Name the owner of G1" in swarm.submissions()[1]["steps"][0]["input"]["prompt"]
    assert _live_with(swarm, "baseline") == ["wf_2"]
    assert _live_with(swarm, "feature_set") == ["wf_2"]
    # Not posted: a change request there has no revise step to go to.
    assert any("no revision step" in n for n in run["notes"])


async def test_an_unreadable_recorded_verdict_is_never_a_correction(client, owner):
    """409 already_answered, and the form artifact cannot be read: Oracle reads it again,
    then says "decide again"; it never cancels on a verdict it could not see."""
    tenant_id, auth = owner
    swarm = on()
    run = await _waiting(client, auth, tenant_id, swarm)
    swarm.console_answer("wf_1", "next_draft-review1", "MERGE")
    step = swarm.workflows["wf_1"].step("next_draft-review1")
    form = step.files.pop("review1.json")
    resp = await _decide_raw(client, auth, run, "changes_requested", "Cover returns")
    assert resp.status_code == 503 and "decide again" in resp.text
    reads = [
        r
        for r in swarm.requests
        if r.url.path.endswith("/artifacts/raw") and r.url.params.get("name") == "review1.json"
    ]
    assert len(reads) == 2  # read again before giving up
    assert swarm.cancels == [] and len(swarm.submissions()) == 1
    run = await get(client, auth, run["id"])
    assert run["status"] == "awaiting_checkpoint"
    # Readable again: the decision is the correction it is.
    step.files["review1.json"] = form
    run = await decide(client, auth, run, "changes_requested", note="Cover returns")
    assert swarm.workflows["wf_1"].state == "CANCELLED" and len(swarm.submissions()) == 2


async def test_same_verdict_other_findings_records_what_was_applied(client, owner):
    tenant_id, auth = owner
    swarm = on()
    run = await _waiting(client, auth, tenant_id, swarm)
    cp = pending(run)
    swarm.console_answer("wf_1", "next_draft-review1", "NOT_YET", ["Shorter"], by="cto@example.com")
    run = await decide(client, auth, run, "changes_requested", note="Longer")
    assert run["status"] == "running" and len(swarm.submissions()) == 1
    attempt = run["segments"][0]["attempts"][-1]
    assert attempt["note"] == "Shorter" and attempt["note_by"] == "cto@example.com"
    assert attempt["not_applied"] == "Longer"
    wait = next(c for c in run["checkpoints"] if c["id"] == cp["id"])["payload"]["wait"]
    assert wait["recorded"]["findings"] == ["Shorter"]
    assert wait["answered"]["not_applied"] == "Longer"


# A failed cancel: the workflow stays attached and nothing is submitted after it.

_DECIDE_PATHS = ["correction", "closed", "tail", "no_revise", "refused", "stop_rest"]


async def _arm(client, auth, tenant_id, swarm, path, monkeypatch):
    """A run waiting on a checkpoint, set up so that deciding it cancels the workflow."""
    if path == "no_revise":
        use(swarm)
        run = await started(client, auth)
        await tick(client, auth)
        return await get(client, auth, run["id"]), "changes_requested", "baseline"
    run = await _waiting(client, auth, tenant_id, swarm)
    decision = "approved" if path == "stop_rest" else "changes_requested"
    if path == "correction":
        swarm.console_answer("wf_1", "next_draft-review1", "MERGE")
    elif path == "tail":
        real_now = service._now
        monkeypatch.setattr(service, "_now", lambda: real_now() + timedelta(hours=23))
    elif path == "refused":
        swarm.service_answer = False
    return run, decision, "next_draft"


def _refuse_closed(swarm: FakeSwarmCloud) -> None:
    swarm.fail_next_answer = httpx.Response(
        409,
        json={"code": "conflict", "message": "x", "detail": {"reason": "not_open"}},
    )


@pytest.mark.parametrize("path", _DECIDE_PATHS)
async def test_a_failed_cancel_on_a_decision_says_decide_again(client, owner, monkeypatch, path):
    tenant_id, auth = owner
    swarm = on()
    run, decision, prefix = await _arm(client, auth, tenant_id, swarm, path, monkeypatch)
    cp = pending(run)
    token = token_of(swarm)
    if path == "closed":
        _refuse_closed(swarm)
    swarm.fail_cancels = 1
    resp = await _decide_raw(client, auth, run, decision, "Cover returns")
    assert resp.status_code == 503 and "decide again" in resp.text, resp.text
    assert swarm.cancels == ["wf_1"]  # tried, not confirmed
    assert swarm.workflows["wf_1"].state != "CANCELLED"
    # Nothing submitted after it, and nothing changed in Oracle.
    assert len(swarm.submissions()) == 1
    run = await get(client, auth, run["id"])
    assert run["status"] == "awaiting_checkpoint" and pending(run)["id"] == cp["id"]
    assert await verify_run_token(token) is not None
    # Deciding again: the cancel is confirmed first, then the run goes on.
    if path == "closed":
        _refuse_closed(swarm)
    run = await decide(client, auth, run, decision, note="Cover returns")
    assert swarm.workflows["wf_1"].state == "CANCELLED"
    if path == "stop_rest":
        assert run["status"] == "succeeded" and len(swarm.submissions()) == 1
    else:
        assert len(swarm.submissions()) == 2 and _live_with(swarm, prefix) == ["wf_2"]


async def test_a_failed_cancel_on_overrun_keeps_the_workflow_attached(client, owner):
    tenant_id, auth = owner
    swarm = on()
    use(swarm)
    off = {"baseline_confirm": False, "feature_set": False, "priority_order": False}
    run = await started(client, auth, checkpoints=off)
    await _ceiling(tenant_id, run["id"], "0.5")
    swarm.steps_per_poll = 1
    swarm.fail_cancels = 1
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "paused_overrun"
    wf = (await _knobs_of(tenant_id, run["id"]))["workflow"]
    assert wf["state"] == "live" and wf["cancel_pending"]
    assert swarm.workflows["wf_1"].state == "RUNNING"
    spent = run["spent_usd"]
    # Still not cancelled: its cost is read on every tick, so the spend stays in view.
    swarm.fail_cancels = 1
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["spent_usd"] > spent
    assert len(swarm.cancels) == 2 and len(swarm.submissions()) == 1
    # Resumed while the cancel is unconfirmed: nothing is submitted.
    resp = await client.post(f"/v1/runs/{run['id']}/resume", headers=auth)
    assert resp.status_code == 200, resp.text
    assert len(swarm.submissions()) == 1
    # The cancel is confirmed on the next tick; only then is the segment submitted again.
    await tick(client, auth)
    assert swarm.workflows["wf_1"].state == "CANCELLED"
    assert len(swarm.submissions()) == 2
    assert _live_with(swarm, "baseline") == ["wf_2"]
    # Everything wf_1 spent is in the run's spend.
    run = await get(client, auth, run["id"])
    assert run["spent_usd"] == sum(s.cost for s in swarm.workflows["wf_1"].steps)


async def test_a_cancelled_run_whose_cancel_failed_is_cancelled_by_the_tick(client, owner):
    tenant_id, auth = owner
    swarm = on()
    use(swarm)
    run = await started(client, auth)
    swarm.fail_cancels = 1
    resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=auth)
    assert resp.status_code == 200, resp.text
    run = await get(client, auth, run["id"])
    assert run["status"] == "cancelled"
    assert swarm.workflows["wf_1"].state == "RUNNING"
    await tick(client, auth)
    assert swarm.workflows["wf_1"].state == "CANCELLED"
    run = await get(client, auth, run["id"])
    assert run["spent_usd"] == sum(s.cost for s in swarm.workflows["wf_1"].steps)
    assert (await _knobs_of(tenant_id, run["id"]))["workflow"]["state"] != "live"
    assert len(swarm.submissions()) == 1


# Answers given outside Oracle, noticed while the run waits.


async def test_a_console_answer_while_waiting_is_followed_by_the_tick(client, owner):
    tenant_id, auth = owner
    swarm = on()
    await as_user(tenant_id, "approver", "lead@example.com")  # an Oracle approver (W5)
    run = await _waiting(client, auth, tenant_id, swarm)
    cp = pending(run)
    swarm.console_answer(
        "wf_1", "next_draft-review1", "NOT_YET", ["Cover refunds"], by="lead@example.com"
    )
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    decided = next(c for c in run["checkpoints"] if c["id"] == cp["id"])
    assert decided["status"] == "changes_requested" and decided["decided_by"]
    assert decided["note"] == "Cover refunds" and decided["decided_at"]
    recorded = decided["payload"]["wait"]["recorded"]
    assert recorded["answered_by"] == "lead@example.com" and recorded["via"] == "console"
    assert recorded["verdict"] == "NOT_YET" and recorded["findings"] == ["Cover refunds"]
    assert recorded["answered_at"] and recorded["outside_oracle"] is True
    assert swarm.answers == []
    # Followed: the same workflow revised, and its second wait is the open checkpoint.
    assert run["status"] == "awaiting_checkpoint"
    assert pending(run)["payload"]["wait"]["step_id"] == "next_draft-review2"
    assert len(swarm.submissions()) == 1
    attempt = run["segments"][0]["attempts"][1]
    assert attempt["note"] == "Cover refunds" and attempt["note_by"] == "lead@example.com"
    assert any("decided outside Oracle" in n and "lead@example.com" in n for n in run["notes"])


async def test_the_tick_reads_a_waiting_step_at_most_once_a_minute(client, owner, monkeypatch):
    tenant_id, auth = owner
    swarm = on()
    run = await _waiting(client, auth, tenant_id, swarm)
    assert _input_reads(swarm, "next_draft-review1") == 0
    await tick(client, auth)
    assert _input_reads(swarm, "next_draft-review1") == 1
    await tick(client, auth)
    assert _input_reads(swarm, "next_draft-review1") == 1
    real_now = service._now
    monkeypatch.setattr(service, "_now", lambda: real_now() + timedelta(seconds=61))
    await tick(client, auth)
    assert _input_reads(swarm, "next_draft-review1") == 2
    assert (await get(client, auth, run["id"]))["status"] == "awaiting_checkpoint"


async def test_spend_over_the_ceiling_while_waiting_pauses_the_run(client, owner):
    tenant_id, auth = owner
    swarm = on()
    run = await _waiting(client, auth, tenant_id, swarm)
    cp = pending(run)
    await _ceiling(tenant_id, run["id"], "0.5")
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "paused_overrun"
    assert swarm.workflows["wf_1"].state == "CANCELLED"
    # Resumed: the checkpoint is still open, now in the Inbox only.
    resp = await client.post(f"/v1/runs/{run['id']}/resume", headers=auth)
    assert resp.status_code == 200, resp.text
    run = await get(client, auth, run["id"])
    assert run["status"] == "awaiting_checkpoint" and pending(run)["id"] == cp["id"]
    run = await decide(client, auth, run, "approved")
    assert run["status"] == "succeeded" and swarm.answers == []
    assert len(swarm.submissions()) == 1


async def test_a_console_merge_with_later_checkpoints_off_completes_from_the_harvest(client, owner):
    """Checkpoint 1 answered MERGE in the console, the later checkpoints off: the workflow
    ran to SUCCEEDED. The tick follows the answer and takes every segment's files from
    the steps that wrote them: nothing is resubmitted, the run completes."""
    tenant_id, auth = owner
    swarm = on()
    use(swarm)
    await as_user(tenant_id, "approver", "lead@example.com")  # an Oracle approver (W5)
    off = {"feature_set": False, "priority_order": False, "prd_review": False}
    run = await started(client, auth, checkpoints=off)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "awaiting_checkpoint" and run["waiting_on"] == "baseline_confirm"
    cp = pending(run)
    swarm.console_answer("wf_1", "baseline-review1", "MERGE", by="lead@example.com")
    assert swarm.workflows["wf_1"].state == "SUCCEEDED"
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "succeeded", run
    assert len(swarm.submissions()) == 1 and swarm.answers == []
    assert all(s["status"] == "succeeded" and s["workflow_id"] == "wf_1" for s in run["segments"])
    assert run["segments"][3]["draft_import"]["version"] == 1
    decided = next(c for c in run["checkpoints"] if c["id"] == cp["id"])
    assert decided["status"] == "approved"
    assert decided["payload"]["wait"]["recorded"]["answered_by"] == "lead@example.com"


# Minors.


async def test_the_run_token_is_sent_only_once_caller_mcp_is_confirmed(client, owner):
    _, auth = owner
    swarm = on()
    await swarm.runtime().ensure_mcp_server(MCP_URL)  # registered by an earlier process
    use(swarm)
    swarm.fail_next_server_write = httpx.Response(500, json={"code": "internal"})
    await started(client, auth)
    body = swarm.submissions()[-1]
    assert "mcp_credentials" not in body
    assert all("mcp_servers" not in s["input"] for s in body["steps"])
    # The confirming write is accepted: the next run carries the token.
    await started(client, auth)
    assert swarm.submissions()[-1]["mcp_credentials"]["oracle"]["value"]
    methods = [r.method for r in swarm.requests if r.url.path.startswith("/v1/mcp-servers/")]
    assert methods.count("PATCH") == 2


async def test_refusal_codes_and_details_are_redacted_everywhere(client, owner):
    tenant_id, auth = owner
    swarm = on()
    run = await _waiting(client, auth, tenant_id, swarm)
    secret = "ghp_" + "a" * 30
    swarm.fail_next_answer = httpx.Response(
        403,
        json={
            "code": "forbidden",
            "message": "no",
            "detail": {"reason": secret, "who": {"token": f"Bearer {secret}"}, "list": [secret]},
        },
    )
    run = await decide(client, auth, run, "approved")
    assert run["status"] == "succeeded"
    async with tenant_session(tenant_id) as s:
        from oracle.runs.models import Checkpoint, RunSegment

        rows = [json.dumps(r.knobs, default=str) for r in await s.scalars(select(Run))]
        rows += [json.dumps(c.payload, default=str) for c in await s.scalars(select(Checkpoint))]
        rows += [json.dumps(g.artifacts, default=str) for g in await s.scalars(select(RunSegment))]
    assert all(secret not in r for r in rows)
    # The runtime's exception carries them redacted, however deep.
    swarm.fail_next_answer = httpx.Response(
        403,
        json={
            "code": f"x {secret}",
            "detail": {"reason": secret, "n": {"a": [f"Bearer {secret}"]}},
        },
    )
    with pytest.raises(RuntimeUnavailable) as exc:
        await swarm.runtime().answer(
            "wf_1", "next_draft-review1", answer_id="x", payload={"verdict": "MERGE"}
        )
    assert secret not in (exc.value.code or "") and secret not in json.dumps(exc.value.detail)


def test_the_reason_wins_over_the_message():
    from oracle.swarm.swarmcloud import _code

    def resp(reason: str, message: str) -> httpx.Response:
        body = {"code": "validation_error", "message": message, "detail": {"reason": reason}}
        return httpx.Response(422, json=body)

    disabled = "runner_profile 'await-input' is disabled"
    assert _code(resp("mcp_credential_shape", disabled)) == "mcp_credential_shape"
    assert _code(resp("not_open", "already_answered")) == "not_open"
    # A generic reason says nothing more than the status: the message is read.
    assert _code(resp("validation_error", disabled)) == "await_input_disabled"


async def test_an_answer_reusing_oracles_answer_id_from_the_console_is_not_oracles(client, owner):
    tenant_id, auth = owner
    swarm = on()
    run = await _waiting(client, auth, tenant_id, swarm)
    cp = pending(run)
    swarm.console_answer(
        "wf_1", "next_draft-review1", "MERGE", by="mallory@example.com", answer_id=cp["id"]
    )
    run = await decide(client, auth, run, "approved")
    assert any("decided outside Oracle" in n and "mallory" in n for n in run["notes"])
    decided = next(c for c in run["checkpoints"] if c["id"] == cp["id"])
    assert decided["payload"]["wait"]["recorded"]["outside_oracle"] is True


async def test_already_answered_does_not_switch_service_answers_on(client, owner):
    from oracle.swarm import get_runtime

    tenant_id, auth = owner
    swarm = on()
    await _waiting(client, auth, tenant_id, swarm)
    swarm.console_answer("wf_1", "next_draft-review1", "MERGE")
    runtime = get_runtime()
    runtime.learn("service_answer", "off", "test")
    with pytest.raises(RuntimeUnavailable) as exc:
        await runtime.answer(
            "wf_1",
            "next_draft-review1",
            answer_id="x",
            payload={"verdict": "MERGE", "findings": []},
        )
    assert exc.value.code == "already_answered"
    assert (await runtime.features()).service_answer == "off"


def _one_wait_spec() -> WorkflowSpec:
    from oracle.swarm import StepSpec

    return WorkflowSpec(
        name="x",
        steps=(
            StepSpec("a", "writer", "claude-code", "Write these files as artifacts: a.md.\n"),
            StepSpec(
                "r",
                "reviewer",
                "await-input",
                "ok",
                ("a",),
                {"a": "a.md"},
                await_input=workflow.await_input(1, RuntimeSettings()),
            ),
        ),
        label="k",
    )


async def test_person_required_keeps_service_answers_off_past_the_cache(monkeypatch):
    import time
    from types import SimpleNamespace

    from oracle.swarm import swarmcloud

    swarm = on()
    swarm.report_capacity = False
    runtime = swarm.runtime(features_ttl=60)
    wid = await runtime.submit(_one_wait_spec())
    await runtime.status(wid)
    swarm.service_answer = False
    with pytest.raises(RuntimeUnavailable):
        await runtime.answer(wid, "r", answer_id="1", payload={"verdict": "MERGE", "findings": []})
    assert (await runtime.features(refresh=True)).service_answer == "off"
    later = time.monotonic() + 3600
    monkeypatch.setattr(
        swarmcloud, "time", SimpleNamespace(monotonic=lambda: later, time=time.time)
    )
    feats = await runtime.features(refresh=True)
    assert feats.service_answer == "off" and "person_required" in feats.reasons["service_answer"]
    # Until SwarmCloud reports service answers on.
    swarm.report_capacity = swarm.service_answer = True
    assert (await runtime.features(refresh=True)).service_answer == "on"


async def test_find_by_label_stops_on_a_repeated_cursor():
    from oracle.swarm import SwarmCloudRuntime
    from oracle.swarm.swarmcloud import StaticBearer

    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(200, json={"tasks": [], "next_page_token": "same"})

    runtime = SwarmCloudRuntime(
        "https://swarm.test", StaticBearer("x"), transport=httpx.MockTransport(handler)
    )
    # Inconclusive, not "not found": the caller holds the submission and looks again.
    with pytest.raises(RuntimeUnavailable) as exc:
        await runtime.find_by_label("k")
    assert "inconclusive" in str(exc.value) and exc.value.retryable
    assert len(calls) == 2


@pytest.mark.parametrize(
    "workflow_body,form",
    [
        ({"workflow": {"steps": ["junk", 5, {"step_id": "r", "task_id": "t1"}]}}, "big"),
        ({"workflow": "nope"}, "ok"),
        ({"workflow": {"steps": "nope"}}, "ok"),
        ({"workflow": {"steps": [{"step_id": "r", "task_id": {"x": 1}}]}}, "ok"),
        ({"workflow": {"steps": [{"step_id": "r", "task_id": "t1"}]}}, "list"),
    ],
)
async def test_answer_record_survives_odd_bodies(workflow_body, form):
    from oracle.swarm import SwarmCloudRuntime
    from oracle.swarm.swarmcloud import StaticBearer

    forms = {
        "big": json.dumps({"verdict": "MERGE", "findings": ["x" * (2 * 1024 * 1024)]}),
        "ok": json.dumps({"verdict": "MERGE", "findings": []}),
        "list": json.dumps(["MERGE"]),
    }

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("/input"):
            return httpx.Response(
                200, json={"state": "answered", "answer": {"answer_id": "a", "answered_by": "p"}}
            )
        if path == "/v1/workflows/w":
            return httpx.Response(200, json=workflow_body)
        return httpx.Response(200, text=forms[form])

    runtime = SwarmCloudRuntime(
        "https://swarm.test", StaticBearer("x"), transport=httpx.MockTransport(handler)
    )
    record = await runtime.answer_record("w", "r", "review1.json")
    assert record.answered_by == "p" and record.verdict is None


async def test_a_5xx_submit_that_landed_is_found_before_resubmitting(client, owner):
    _, auth = owner
    swarm = on()
    use(swarm)
    swarm.fail_after_create = httpx.Response(
        500, json={"code": "internal", "message": "boom", "detail": {"reason": "internal"}}
    )
    run = await started(client, auth)
    assert len(swarm.workflows) == 1 and run["segments"][0]["workflow_id"] == "wf_1"
    await tick(client, auth)
    assert len(swarm.workflows) == 1 and len(swarm.submissions()) == 1


def test_plain_file_names_refuse_dots_and_blanks():
    from oracle.mcp.curated import _plain_file_name

    for bad in (".", "..", " ", "   ", " . ", "", "a/b", "x\\y", "a..b"):
        assert not _plain_file_name(bad), bad
    for good in ("summary.md", "baseline.yaml", ".notes.md"):
        assert _plain_file_name(good), good


async def test_a_listing_without_addresses_does_not_keep_the_old_list_fresh(monkeypatch):
    import time
    from types import SimpleNamespace

    from oracle.swarm import swarmcloud

    swarm = on()
    runtime = swarm.runtime(egress_refresh=300)

    def listings() -> int:
        return sum(1 for r in swarm.requests if r.url.path == "/v1/mcp-servers")

    assert await runtime.egress_addresses() == frozenset(EGRESS)
    now = [time.monotonic()]
    monkeypatch.setattr(
        swarmcloud, "time", SimpleNamespace(monotonic=lambda: now[0], time=time.time)
    )
    swarm.egress = None  # type: ignore[assignment]
    now[0] += 301
    assert await runtime.egress_addresses() == frozenset(EGRESS)  # kept, not refreshed
    seen = listings()
    now[0] += 31
    await runtime.egress_addresses()
    assert listings() == seen + 1  # re-read soon, not in another 300 s


# --------------------------------------------------------------------------- review fixes, round 3
# W5 (owner, 2026-10-19): a console answer counts only if its answerer (answered_by, never
# on_behalf_of) is an Oracle member whose role meets the checkpoint's approver role; a
# counted console NOT_YET at an earlier checkpoint waits for an approver's "Redo from
# <segment>" or "Continue". Nothing re-runs without that choice, and spend never escapes
# the ceiling.


async def _member(tenant_id, email: str, role: str = "approver") -> None:
    await as_user(tenant_id, role, email)


async def _at_baseline(client, auth, swarm: FakeSwarmCloud, **kw) -> dict:
    """A baseline_to_prd run waiting on its first checkpoint (no revise step there)."""
    use(swarm)
    run = await started(client, auth, **kw)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "awaiting_checkpoint" and run["waiting_on"] == "baseline_confirm"
    return run


def _console(run: dict, cp_id: str) -> dict | None:
    cp = next(c for c in run["checkpoints"] if c["id"] == cp_id)
    return cp["console"]


async def _tick_errors(client, auth) -> list[str]:
    resp = await client.post("/v1/internal/tick", headers=auth)
    assert resp.status_code == 200, resp.text
    return resp.json()["errors"]


# MAJOR A: the ceiling on every tick path.


async def test_a_failing_wait_read_still_reads_spend_and_pauses_on_the_ceiling(client, owner):
    tenant_id, auth = owner
    swarm = on()
    run = await _at_baseline(client, auth, swarm)
    spent = run["spent_usd"]
    # The console answers; the workflow goes on into feature_set and spends.
    swarm.console_answer("wf_1", "baseline-review1", "MERGE")
    swarm.fail_input_reads = 100
    await _ceiling(tenant_id, run["id"], str(spent + 0.01))
    assert await _tick_errors(client, auth) == []
    run = await get(client, auth, run["id"])
    assert run["spent_usd"] > spent
    assert run["status"] == "paused_overrun"
    assert swarm.workflows["wf_1"].state == "CANCELLED"


async def test_a_retryable_wait_read_error_is_retried_next_tick(client, owner):
    tenant_id, auth = owner
    swarm = on()
    run = await _waiting(client, auth, tenant_id, swarm)
    swarm.fail_input_reads = 1
    assert await _tick_errors(client, auth) == []
    assert _input_reads(swarm, "next_draft-review1") == 1
    # Not throttled for a minute: the failed read is tried again on the next tick.
    assert await _tick_errors(client, auth) == []
    assert _input_reads(swarm, "next_draft-review1") == 2
    assert (await get(client, auth, run["id"]))["status"] == "awaiting_checkpoint"


async def test_a_console_change_request_over_the_ceiling_pauses_and_reruns_nothing(client, owner):
    tenant_id, auth = owner
    swarm = on()
    await _member(tenant_id, "lead@example.com")
    run = await _at_baseline(client, auth, swarm)
    await _ceiling(tenant_id, run["id"], str(run["spent_usd"] + 0.01))
    swarm.console_answer(
        "wf_1", "baseline-review1", "NOT_YET", ["Missing goal"], by="lead@example.com"
    )
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "paused_overrun"
    assert len(swarm.submissions()) == 1


async def test_a_cancel_confirmed_as_the_cost_crosses_the_ceiling_submits_nothing(client, owner):
    tenant_id, auth = owner
    swarm = on()
    use(swarm)
    off = {"baseline_confirm": False, "feature_set": False, "priority_order": False}
    run = await started(client, auth, checkpoints=off)
    await _ceiling(tenant_id, run["id"], "0.5")
    swarm.steps_per_poll = 1
    swarm.fail_cancels = 1
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "paused_overrun"
    resp = await client.post(f"/v1/runs/{run['id']}/resume", headers=auth)
    assert resp.status_code == 200, resp.text
    # The workflow, still not cancelled, spends past the new ceiling before the next tick,
    # which confirms the cancel: the held-back segment is not submitted.
    await _ceiling(tenant_id, run["id"], str(run["spent_usd"]))
    await tick(client, auth)
    assert swarm.workflows["wf_1"].state == "CANCELLED"
    run = await get(client, auth, run["id"])
    assert run["status"] == "paused_overrun"
    assert len(swarm.submissions()) == 1


# MAJOR B: no findings is not "use the Inbox note".


async def test_a_console_not_yet_without_findings_does_not_take_the_inbox_note(client, owner):
    tenant_id, auth = owner
    swarm = on()
    run = await _waiting(client, auth, tenant_id, swarm)
    swarm.console_answer("wf_1", "next_draft-review1", "NOT_YET", [], by="cto@example.com")
    run = await decide(client, auth, run, "changes_requested", note="Longer")
    attempt = run["segments"][0]["attempts"][-1]
    assert attempt["note"] is None and attempt["note_by"] is None
    assert attempt["not_applied"] == "Longer"


# W5: who a console answer counts for.


async def test_a_console_answer_by_a_non_member_stays_open_for_an_approver(client, owner):
    tenant_id, auth = owner
    swarm = on()
    run = await _waiting(client, auth, tenant_id, swarm)
    cp = pending(run)
    swarm.console_answer("wf_1", "next_draft-review1", "MERGE", by="stranger@example.com")
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "awaiting_checkpoint" and pending(run)["id"] == cp["id"]
    console = _console(run, cp["id"])
    assert console["answered_by"] == "stranger@example.com" and console["verdict"] == "MERGE"
    assert console["counted"] is False and console["needs"] == "confirm"
    assert "not an Oracle member" in console["reason"]
    assert any("answered in SwarmCloud by stranger@example.com" in n for n in run["notes"])
    inbox = (await client.get("/v1/inbox", headers=auth)).json()
    assert [c["console"]["needs"] for c in inbox["checkpoints"]] == ["confirm"]
    # Read once: the first answer is final, so the tick does not read it again.
    reads = _input_reads(swarm, "next_draft-review1")
    await tick(client, auth)
    assert _input_reads(swarm, "next_draft-review1") == reads
    # An approver confirms it: the console's MERGE is the decision.
    run = await decide(client, auth, run, "confirm")
    assert run["status"] == "succeeded" and len(swarm.submissions()) == 1
    assert next(c for c in run["checkpoints"] if c["id"] == cp["id"])["status"] == "approved"


async def test_a_console_answer_by_a_viewer_does_not_count(client, owner):
    tenant_id, auth = owner
    swarm = on()
    await _member(tenant_id, "viewer@example.com", "viewer")
    run = await _at_baseline(client, auth, swarm)
    cp = pending(run)
    swarm.console_answer(
        "wf_1", "baseline-review1", "NOT_YET", ["Missing goal"], by="viewer@example.com"
    )
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert pending(run)["id"] == cp["id"] and len(swarm.submissions()) == 1
    console = _console(run, cp["id"])
    assert console["counted"] is False and console["needs"] == "confirm"
    assert "viewer" in console["reason"]
    # Confirmed by an approver: now a counted NOT_YET at an earlier checkpoint, which
    # waits for Redo or Continue.
    run = await decide(client, auth, run, "confirm")
    assert run["status"] == "awaiting_checkpoint" and pending(run)["id"] == cp["id"]
    console = _console(run, cp["id"])
    assert console["counted"] is True and console["needs"] == "redo_or_continue"
    assert len(swarm.submissions()) == 1 and swarm.cancels == []


async def test_a_counted_console_not_yet_mid_run_waits_and_continue_follows(client, owner):
    tenant_id, auth = owner
    swarm = on()
    await _member(tenant_id, "lead@example.com")
    run = await _at_baseline(client, auth, swarm)
    cp = pending(run)
    swarm.console_answer(
        "wf_1", "baseline-review1", "NOT_YET", ["Missing goal"], by="lead@example.com"
    )
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    # Never re-run automatically: the Inbox shows the findings and two choices.
    assert run["status"] == "awaiting_checkpoint" and pending(run)["id"] == cp["id"]
    console = _console(run, cp["id"])
    assert console["counted"] is True and console["needs"] == "redo_or_continue"
    assert console["findings"] == ["Missing goal"]
    assert console["redo_segment"] and console["redo_cost_usd"] > 0
    assert len(swarm.submissions()) == 1 and swarm.cancels == []
    run = await decide(client, auth, run, "continue", note="Good enough for now")
    assert run["status"] == "running" and swarm.cancels == []
    assert len(swarm.submissions()) == 1 and _live_with(swarm, "feature_set") == ["wf_1"]
    decided = next(c for c in run["checkpoints"] if c["id"] == cp["id"])
    assert decided["status"] == "approved" and decided["note"] == "Good enough for now"
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["waiting_on"] == "feature_set" and len(swarm.submissions()) == 1


async def test_redo_from_a_console_not_yet_reruns_the_segment_once_with_the_findings(client, owner):
    tenant_id, auth = owner
    swarm = on()
    await _member(tenant_id, "lead@example.com")
    run = await _at_baseline(client, auth, swarm)
    finding = "Missing goal: " + "the retention target for Q3 " * 20
    assert len(finding) > 200
    swarm.console_answer("wf_1", "baseline-review1", "NOT_YET", [finding], by="lead@example.com")
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    swarm.fail_cancels = 1
    resp = await _decide_raw(client, auth, run, "redo")
    assert resp.status_code == 503 and "decide again" in resp.text
    assert len(swarm.submissions()) == 1
    run = await decide(client, auth, await get(client, auth, run["id"]), "redo")
    assert swarm.workflows["wf_1"].state == "CANCELLED"
    assert len(swarm.submissions()) == 2
    # The findings go to the agents whole (only what is logged is clipped).
    assert finding.strip() in swarm.submissions()[1]["steps"][0]["input"]["prompt"]
    assert _live_with(swarm, "baseline") == ["wf_2"]
    assert _live_with(swarm, "feature_set") == ["wf_2"]


async def test_redo_and_continue_need_a_counted_console_change_request(client, owner):
    tenant_id, auth = owner
    swarm = on()
    run = await _waiting(client, auth, tenant_id, swarm)
    for decision in ("redo", "continue", "confirm"):
        resp = await _decide_raw(client, auth, run, decision)
        assert resp.status_code == 422, resp.text


async def test_a_counted_console_answer_is_attributed_to_answered_by(client, owner):
    from oracle.models import AuditEvent

    tenant_id, auth = owner
    swarm = on()
    await _member(tenant_id, "lead@example.com")
    run = await _waiting(client, auth, tenant_id, swarm)
    cp = pending(run)
    swarm.console_answer(
        "wf_1",
        "next_draft-review1",
        "NOT_YET",
        ["Cover refunds"],
        by="lead@example.com",
        on_behalf_of="ceo@example.com",
    )
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    attempt = run["segments"][0]["attempts"][-1]
    assert attempt["note"] == "Cover refunds" and attempt["note_by"] == "lead@example.com"
    async with tenant_session(tenant_id) as s:
        events = list(
            await s.scalars(select(AuditEvent).where(AuditEvent.entity_id == uuid.UUID(cp["id"])))
        )
    assert [e.data["answered_by"] for e in events] == ["lead@example.com"]


# Minors.


async def test_a_failed_registration_patch_sends_no_run_token(client, owner, monkeypatch):
    _, auth = owner
    swarm = on()
    use(swarm)
    await started(client, auth)
    assert swarm.submissions()[-1]["mcp_credentials"]
    monkeypatch.setenv("ORACLE_PUBLIC_URL", "https://oracle.example.org")
    get_runtime_settings.cache_clear()
    swarm.fail_next_server_write = httpx.Response(500, json={"code": "internal"})
    await started(client, auth)
    body = swarm.submissions()[-1]
    assert "mcp_credentials" not in body
    assert all("mcp_servers" not in s["input"] for s in body["steps"])


async def test_a_refused_wait_read_on_an_answered_step_is_not_unanswered(client, owner):
    tenant_id, auth = owner
    swarm = on()
    off = {"feature_set": False, "priority_order": False, "prd_review": False}
    run = await _at_baseline(client, auth, swarm, checkpoints=off)
    cp = pending(run)
    swarm.console_answer("wf_1", "baseline-review1", "MERGE", by="stranger@example.com")
    assert swarm.workflows["wf_1"].state == "SUCCEEDED"
    swarm.fail_input_reads, swarm.fail_input_status = 100, 403
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    # Answered (its step SUCCEEDED), not "ended unanswered": still attached, still open.
    assert (await _knobs_of(tenant_id, run["id"]))["workflow"]["state"] == "live"
    assert pending(run)["id"] == cp["id"]
    assert _console(run, cp["id"])["needs"] == "unreadable"
    assert not any("ended succeeded" in n for n in run["notes"])
    # An approval needs nothing the workflow did not do: it is followed, and the run
    # completes from the workflow's files.
    run = await decide(client, auth, run, "approved")
    assert run["status"] == "running" and swarm.cancels == []
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "succeeded" and len(swarm.submissions()) == 1


async def test_an_unreadable_console_verdict_surfaces_in_the_inbox_with_a_way_out(client, owner):
    tenant_id, auth = owner
    swarm = on()
    run = await _waiting(client, auth, tenant_id, swarm)
    cp = pending(run)
    swarm.console_answer("wf_1", "next_draft-review1", "NOT_YET", ["x"], by="lead@example.com")
    step = swarm.workflows["wf_1"].step("next_draft-review1")
    step.files["review1.json"] = json.dumps({"verdict": "NOT_YET", "findings": ["y" * 300_000]})
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert pending(run)["id"] == cp["id"]
    console = _console(run, cp["id"])
    assert console["needs"] == "unreadable" and console["answered_by"] == "lead@example.com"
    assert any("could not read" in n for n in run["notes"])
    inbox = (await client.get("/v1/inbox", headers=auth)).json()
    assert inbox["checkpoints"][0]["console"]["needs"] == "unreadable"
    # A way out other than cancelling the run: Redo from the segment, as a new workflow.
    run = await decide(client, auth, run, "redo", note="Cover refunds")
    assert swarm.workflows["wf_1"].state == "CANCELLED" and len(swarm.submissions()) == 2
    assert "Cover refunds" in swarm.submissions()[1]["steps"][0]["input"]["prompt"]
    assert run["status"] == "running"


def _metadata_handler(answered_by: str, token_email: str):
    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if request.url.host == "metadata.google.internal":
            if path.endswith("/token"):
                token = ".".join(["test", "access", "token"])  # built at runtime
                return httpx.Response(200, json={"access_token": token, "expires_in": 3600})
            if path.endswith("/email"):
                return httpx.Response(200, text=token_email)
            return httpx.Response(404)
        if path.endswith("/input"):
            record = {"answer_id": "cp1", "answered_by": answered_by, "via": "mcp"}
            return httpx.Response(200, json={"state": "answered", "answer": record})
        if path == "/v1/workflows/w":
            return httpx.Response(
                200, json={"workflow": {"steps": [{"step_id": "r", "task_id": "t1"}]}}
            )
        return httpx.Response(200, json={"verdict": "MERGE", "findings": []})

    return handler


async def test_oracles_principal_is_resolved_from_an_access_token():
    from oracle.swarm import SwarmCloudRuntime
    from oracle.swarm.swarmcloud import GoogleAccessToken

    runtime = SwarmCloudRuntime(
        "https://swarm.test",
        GoogleAccessToken(),
        transport=httpx.MockTransport(_metadata_handler(SERVICE_PRINCIPAL, SERVICE_PRINCIPAL)),
    )
    record = await runtime.answer_record("w", "r", "review1.json")
    assert record.by_oracle is True
    other = SwarmCloudRuntime(
        "https://swarm.test",
        GoogleAccessToken(),
        transport=httpx.MockTransport(_metadata_handler("someone@example.com", SERVICE_PRINCIPAL)),
    )
    assert (await other.answer_record("w", "r", "review1.json")).by_oracle is False


async def test_oracles_principal_is_resolved_from_a_jwt_bearer():
    import jwt as pyjwt

    from oracle.swarm import SwarmCloudRuntime
    from oracle.swarm.swarmcloud import StaticBearer

    token = pyjwt.encode({"email": SERVICE_PRINCIPAL}, "k" * 32, algorithm="HS256")
    runtime = SwarmCloudRuntime(
        "https://swarm.test",
        StaticBearer(token),
        transport=httpx.MockTransport(_metadata_handler(SERVICE_PRINCIPAL, "")),
    )
    assert (await runtime.answer_record("w", "r", "review1.json")).by_oracle is True


def test_a_specific_top_level_code_wins_over_a_generic_reason():
    from oracle.swarm.swarmcloud import _code

    body = {"code": "already_answered", "message": "x", "detail": {"reason": "conflict"}}
    assert _code(httpx.Response(409, json=body)) == "already_answered"
    generic = {"code": "conflict", "message": "x", "detail": {"reason": "conflict"}}
    assert _code(httpx.Response(409, json=generic)) == "conflict"


async def test_a_non_json_5xx_is_never_a_definite_refusal():
    from oracle.swarm import SwarmCloudRuntime
    from oracle.swarm.swarmcloud import StaticBearer

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(502, text="<html>upstream mcp_unavailable</html>")

    runtime = SwarmCloudRuntime(
        "https://swarm.test", StaticBearer("x"), transport=httpx.MockTransport(handler)
    )
    with pytest.raises(RuntimeUnavailable) as exc:
        await runtime.submit(WorkflowSpec(name="x", steps=()))
    assert exc.value.lost is True


async def test_the_run_token_is_revoked_while_a_cancel_is_pending(client, owner):
    tenant_id, auth = owner
    swarm = on()
    run = await _waiting(client, auth, tenant_id, swarm)
    token = token_of(swarm)
    await _ceiling(tenant_id, run["id"], "0.5")
    swarm.fail_cancels = 1
    await tick(client, auth)
    assert (await _knobs_of(tenant_id, run["id"]))["workflow"]["cancel_pending"]
    assert await verify_run_token(token) is None


async def test_a_confirmed_cancel_reads_the_final_cost(client, owner):
    tenant_id, auth = owner
    swarm = on()
    run = await _at_baseline(client, auth, swarm)
    # The console answers; the workflow goes on (and spends) before Oracle reads it again.
    swarm.console_answer("wf_1", "baseline-review1", "MERGE")
    run = await decide(client, auth, run, "changes_requested", note="Name the owner of G1")
    assert swarm.workflows["wf_1"].state == "CANCELLED"
    assert run["spent_usd"] == sum(s.cost for s in swarm.workflows["wf_1"].steps)


async def test_cancelling_a_run_cancels_a_lost_submission_that_landed(client, owner):
    _, auth = owner
    swarm = on()
    use(swarm)
    swarm.lose_next_submit = True
    swarm.lose_next_lookup = True
    run = await started(client, auth)
    assert run["segments"][0]["status"] == "pending" and len(swarm.workflows) == 1
    resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=auth)
    assert resp.status_code == 200, resp.text
    assert swarm.workflows["wf_1"].state == "CANCELLED"
    await tick(client, auth)
    assert len(swarm.workflows) == 1


async def test_cancelling_a_run_retries_the_lookup_of_a_lost_submission(client, owner):
    tenant_id, auth = owner
    swarm = on()
    use(swarm)
    swarm.lose_next_submit = True
    swarm.lose_next_lookup = True
    run = await started(client, auth)
    swarm.lose_next_lookup = True
    resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=auth)
    assert resp.status_code == 200, resp.text
    assert swarm.workflows["wf_1"].state == "RUNNING"
    await tick(client, auth)
    assert swarm.workflows["wf_1"].state == "CANCELLED"
    assert (await _knobs_of(tenant_id, run["id"]))["workflow"]["state"] != "live"


async def test_an_inconclusive_lookup_holds_the_submission(client, owner):
    _, auth = owner
    swarm = on()
    use(swarm)
    swarm.other_tasks = 1100  # more than Oracle pages through
    swarm.lose_next_submit = True
    run = await started(client, auth)
    assert run["segments"][0]["status"] == "pending"
    await tick(client, auth)
    assert len(swarm.workflows) == 1 and len(swarm.submissions()) == 1
    run = await get(client, auth, run["id"])
    assert run["segments"][0]["status"] == "pending"
    assert "inconclusive" in run["segments"][0]["error"]


class _Endless(httpx.AsyncByteStream):
    """A body that fails the test if more than ``limit`` bytes are read from it."""

    def __init__(self, limit: int) -> None:
        self.limit = limit

    async def __aiter__(self):
        sent = 0
        while True:
            assert sent <= self.limit, "read past the form limit"
            sent += 64 * 1024
            yield b"x" * (64 * 1024)


@pytest.mark.parametrize("declared", [True, False])
async def test_answer_record_never_reads_a_form_past_its_limit(declared):
    from oracle.swarm import SwarmCloudRuntime
    from oracle.swarm.swarmcloud import MAX_FORM_BYTES, StaticBearer

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("/input"):
            return httpx.Response(200, json={"state": "answered", "answer": {"answer_id": "a"}})
        if path == "/v1/workflows/w":
            return httpx.Response(
                200, json={"workflow": {"steps": [{"step_id": "r", "task_id": "t1"}]}}
            )
        headers = {"content-length": str(10**9)} if declared else {}
        return httpx.Response(200, headers=headers, stream=_Endless(MAX_FORM_BYTES + 128 * 1024))

    runtime = SwarmCloudRuntime(
        "https://swarm.test", StaticBearer("x"), transport=httpx.MockTransport(handler)
    )
    record = await runtime.answer_record("w", "r", "review1.json")
    assert record.answered and record.verdict is None


def test_run_tokens_joined_by_an_underscore_are_redacted():
    from oracle.swarm.swarmcloud import _redact

    for text in ("credential_ort_abcdefgh12345", "x_po_abcdefgh12345", "id=poa_abcdefgh123"):
        assert "abcdefgh" not in _redact(text), text
    assert _redact("support_ticket") == "support_ticket"


async def test_a_pending_cancel_of_an_unknown_workflow_gives_up_cleanly(client, owner):
    tenant_id, auth = owner
    swarm = on()
    use(swarm)
    run = await started(client, auth)
    swarm.fail_cancels = 1
    resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=auth)
    assert resp.status_code == 200, resp.text
    del swarm.workflows["wf_1"]
    await tick(client, auth)  # no error
    wf = (await _knobs_of(tenant_id, run["id"]))["workflow"]
    assert wf["state"] != "live" and wf["gone"]
    run = await get(client, auth, run["id"])
    assert any("does not know workflow wf_1" in n for n in run["notes"])


async def test_a_per_segment_cancel_is_retried_by_the_tick(client, owner):
    tenant_id, auth = owner
    swarm = FakeSwarmCloud(mcp=True)  # one workflow per segment
    use(swarm)
    run = await started(client, auth)
    assert not (await _knobs_of(tenant_id, run["id"])).get("workflow")
    swarm.steps_per_poll = 0  # still running whenever Oracle reads it
    swarm.fail_cancels = 1
    resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=auth)
    assert resp.status_code == 200, resp.text
    assert swarm.workflows["wf_1"].state == "RUNNING"
    await tick(client, auth)
    assert swarm.workflows["wf_1"].state == "CANCELLED" and swarm.cancels == ["wf_1", "wf_1"]
    assert (await _knobs_of(tenant_id, run["id"]))["workflow"]["state"] != "live"


# --------------------------------------------------------------------------- round 4
# MAJOR 1: a lookup that cannot finish.


async def test_a_lookup_past_older_tasks_concludes_and_resubmits_once(client, owner):
    """1100 of Oracle's tasks older than the lost submission: the lookup stops at the
    first row older than it (less a clock-skew margin) and says "not found", so the
    segment is submitted again, once."""
    _, auth = owner
    swarm = on()
    use(swarm)
    swarm.older_tasks = 1100
    swarm.fail_next_submit = httpx.Response(502, text="bad gateway")  # nothing created
    run = await started(client, auth)
    assert run["segments"][0]["status"] == "pending"
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["segments"][0]["workflow_id"] == "wf_1" and run["status"] == "running"
    assert len(swarm.submissions()) == 2 and len(swarm.workflows) == 1
    # One page each time: the first row older than the submission ends the search.
    assert [r.url.params.get("page_token") for r in _task_lookups(swarm)] == [None, None]
    await tick(client, auth)
    assert len(swarm.submissions()) == 2


async def test_a_lost_submission_that_landed_is_found_before_older_tasks(client, owner):
    _, auth = owner
    swarm = on()
    use(swarm)
    swarm.older_tasks = 1100
    swarm.lose_next_submit = True
    run = await started(client, auth)
    assert run["segments"][0]["workflow_id"] == "wf_1" and len(swarm.submissions()) == 1


async def test_find_by_label_without_times_is_still_inconclusive():
    """Rows that carry no time prove nothing about older submissions: past the page
    limit the search is inconclusive, never "not found"."""
    from oracle.swarm import SwarmCloudRuntime
    from oracle.swarm.swarmcloud import StaticBearer

    def handler(request: httpx.Request) -> httpx.Response:
        start = int(request.url.params.get("page_token") or 0)
        rows = [{"id": f"t{start + i}", "workflow_id": "w", "metadata": {}} for i in range(50)]
        return httpx.Response(200, json={"tasks": rows, "next_page_token": str(start + 50)})

    runtime = SwarmCloudRuntime(
        "https://swarm.test", StaticBearer("x"), transport=httpx.MockTransport(handler)
    )
    with pytest.raises(RuntimeUnavailable) as exc:
        await runtime.find_by_label("k", since=datetime.now(service.UTC))
    assert exc.value.retryable


async def _past_the_lookup_cap(monkeypatch) -> None:
    later = service._now() + timedelta(seconds=service.LOST_LOOKUP_SECONDS + 60)
    monkeypatch.setattr(service, "_now", lambda: later)


async def test_an_endless_lookup_surfaces_in_the_inbox_and_retry_submits_once(
    client, owner, monkeypatch
):
    tenant_id, auth = owner
    swarm = on()
    use(swarm)
    swarm.other_tasks = 1100  # newer than the submission: no time to stop at
    swarm.lose_next_submit = True
    run = await started(client, auth)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["segments"][0]["status"] == "pending"
    inbox = (await client.get("/v1/inbox", headers=auth)).json()
    assert inbox["lookups"] == []
    await _past_the_lookup_cap(monkeypatch)
    await tick(client, auth)
    inbox = (await client.get("/v1/inbox", headers=auth)).json()
    [stuck] = inbox["lookups"]
    assert stuck["id"] == run["id"] and "Retry" in stuck["stuck"] and "Cancel" in stuck["stuck"]
    assert len(swarm.submissions()) == 1
    # Waiting in the Inbox, it is looked up again now and then, not on every tick.
    pages = len(_task_lookups(swarm))
    await tick(client, auth)
    assert len(_task_lookups(swarm)) == pages
    # Nobody but an owner or the run's creator retries it.
    viewer = await as_user(tenant_id, "viewer")
    resp = await client.post(f"/v1/runs/{run['id']}/retry", headers=viewer)
    assert resp.status_code == 403
    resp = await client.post(f"/v1/runs/{run['id']}/retry", headers=auth)
    assert resp.status_code == 200, resp.text
    run = resp.json()
    assert run["status"] == "running" and run["segments"][0]["workflow_id"] == "wf_2"
    labels = {b["steps"][0]["metadata"]["oracle_key"] for b in swarm.submissions()}
    assert len(labels) == 2  # a new key: the abandoned one is never adopted for it
    assert (await client.get("/v1/inbox", headers=auth)).json()["lookups"] == []
    # The retry is not repeated by the tick, and the token of the lost one is revoked.
    await tick(client, auth)
    assert len(swarm.submissions()) == 2
    assert await verify_run_token(token_of(swarm, 0)) is None
    resp = await client.post(f"/v1/runs/{run['id']}/retry", headers=auth)
    assert resp.status_code == 409


async def test_an_endless_lookup_cancelled_from_the_inbox_gives_up_cleanly(
    client, owner, monkeypatch
):
    tenant_id, auth = owner
    swarm = on()
    use(swarm)
    swarm.other_tasks = 1100
    swarm.lose_next_submit = True
    run = await started(client, auth)
    resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=auth)
    assert resp.status_code == 200, resp.text
    wf = (await _knobs_of(tenant_id, run["id"]))["workflow"]
    assert wf["state"] == "live" and wf["id"] is None  # still looking for it
    await tick(client, auth)
    assert (await _knobs_of(tenant_id, run["id"]))["workflow"]["state"] == "live"
    await _past_the_lookup_cap(monkeypatch)
    assert await _tick_errors(client, auth) == []
    knobs = await _knobs_of(tenant_id, run["id"])
    assert knobs["workflow"]["state"] != "live"
    # No longer on every tick: in the background, until found or ruled out (round 5).
    [search] = knobs["searches"]
    assert search["label"] == knobs["workflow"]["lookup"] and search["why"] == "cancel"
    run = await get(client, auth, run["id"])
    assert run["status"] == "cancelled" and run["searching"]
    assert any("in the background" in n for n in run["notes"])


async def test_a_no_id_cancel_ends_when_the_lookup_concludes_not_found(client, owner):
    tenant_id, auth = owner
    swarm = on()
    use(swarm)
    swarm.older_tasks = 1100
    swarm.fail_next_submit = httpx.Response(502, text="bad gateway")  # nothing created
    run = await started(client, auth)
    swarm.lose_next_lookup = True  # the cancel's own lookup is lost
    resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=auth)
    assert resp.status_code == 200, resp.text
    assert (await _knobs_of(tenant_id, run["id"]))["workflow"]["id"] is None
    assert await _tick_errors(client, auth) == []
    wf = (await _knobs_of(tenant_id, run["id"]))["workflow"]
    assert wf["state"] == "cancelled" and swarm.workflows == {}


# W5 (owner, 2026-10-19): a console answer that did not count makes the run token
# read-only until an approver confirms it or decides.


def _draft_markdown() -> str:
    return draft("prd_v1.md")


async def _writes(token: str) -> dict[str, str]:
    """What the run's agents get back for each kind of write, and for a read."""
    out: dict[str, str] = {}
    async with mcp_session(token, f"{EGRESS[0]}, {LB}") as c:
        names = {t.name for t in (await c.list_tools()).tools}
        assert {"push_draft", "import_version", "propose_change"} <= names
        for name, args in (
            ("push_draft", {"doc": "w5-draft", "markdown": _draft_markdown()}),
            ("import_version", {"doc": "w5-draft-2", "body": _draft_markdown()}),
            ("propose_change", {"body": {"op": "add", "kind": "goal", "data": {}}}),
            ("get_run_output", {"seq": 1, "name": "summary.md"}),
        ):
            res = await c.call_tool(name, args)
            out[name] = ("ERROR " if res.is_error else "OK ") + res.content[0].text
    return out


async def test_a_console_answer_that_does_not_count_makes_the_run_token_read_only(client, owner):
    tenant_id, auth = owner
    swarm = on()
    await _member(tenant_id, "viewer@example.com", "viewer")
    run = await _at_baseline(client, auth, swarm)
    token = token_of(swarm)
    assert run["token_read_only"] is False
    before = await _writes(token)
    assert all("waiting for approval" not in v for v in before.values()), before
    swarm.console_answer(
        "wf_1", "baseline-review1", "NOT_YET", ["Missing goal"], by="viewer@example.com"
    )
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert _console(run, pending(run)["id"])["needs"] == "confirm"
    # Shown through REST, and refused through the MCP tools: writes only.
    assert run["token_read_only"] is True
    held = await _writes(token)
    for name in ("push_draft", "import_version", "propose_change"):
        assert held[name].startswith("ERROR") and "403" in held[name], held[name]
        assert "waiting for approval" in held[name]
    assert held["get_run_output"].startswith("OK")
    assert await verify_run_token(token) is not None  # narrowed, not revoked
    # An approver confirms: the token is whole again (Redo or Continue come next).
    run = await decide(client, auth, run, "confirm")
    assert _console(run, pending(run)["id"])["needs"] == "redo_or_continue"
    assert run["token_read_only"] is False
    after = await _writes(token)
    assert all("waiting for approval" not in v for v in after.values()), after


async def test_deciding_over_a_console_answer_that_did_not_count_ends_the_hold(client, owner):
    tenant_id, auth = owner
    swarm = on()
    run = await _waiting(client, auth, tenant_id, swarm)
    token = token_of(swarm)
    swarm.console_answer("wf_1", "next_draft-review1", "NOT_YET", ["Add a metric"], by="x@y.z")
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["token_read_only"] is True
    async with mcp_session(token, f"{EGRESS[0]}, {LB}") as c:
        res = await c.call_tool("push_draft", {"doc": "w5", "markdown": _draft_markdown()})
        assert res.is_error and "waiting for approval" in res.content[0].text
    # Requesting changes (the workflow's revision runs with them): the hold ends.
    run = await decide(client, auth, run, "changes_requested", note="Add a metric")
    assert run["token_read_only"] is False and run["status"] == "running"
    async with mcp_session(token, f"{EGRESS[0]}, {LB}") as c:
        res = await c.call_tool("push_draft", {"doc": "w5", "markdown": _draft_markdown()})
        assert "waiting for approval" not in res.content[0].text


# MAJOR 2: a 404 that is not SwarmCloud's envelope proves nothing.


async def test_a_bare_html_404_never_gives_up_cancelling(client, owner):
    tenant_id, auth = owner
    swarm = on()
    use(swarm)
    run = await started(client, auth)
    swarm.html_404 = True
    resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=auth)
    assert resp.status_code == 200, resp.text
    wf = (await _knobs_of(tenant_id, run["id"]))["workflow"]
    assert wf["state"] == "live" and wf["cancel_pending"] and not wf.get("gone")
    # Retried on every tick (reported, not given up).
    assert any("HTTP 404" in e for e in await _tick_errors(client, auth))
    wf = (await _knobs_of(tenant_id, run["id"]))["workflow"]
    assert wf["state"] == "live" and not wf.get("gone")
    swarm.html_404 = False
    assert await _tick_errors(client, auth) == []
    assert swarm.workflows["wf_1"].state == "CANCELLED"
    assert (await _knobs_of(tenant_id, run["id"]))["workflow"]["state"] == "cancelled"


def test_only_an_enveloped_not_found_says_the_workflow_is_gone():
    from oracle.swarm.swarmcloud import _refusal

    enveloped = httpx.Response(
        404, json={"code": "not_found", "message": "no", "detail": {"reason": "not_found"}}
    )
    assert _refusal(enveloped, "GET", "/v1/workflows/w").gone
    for resp in (
        httpx.Response(404, text="<html>Not Found</html>"),
        httpx.Response(404, json={"detail": "Not Found"}),
        httpx.Response(404, text="not_found"),
    ):
        exc = _refusal(resp, "GET", "/v1/workflows/w")
        assert not exc.gone and exc.retryable, resp.text


# Minors.


def _record_runtime(form_response: httpx.Response):
    from oracle.swarm import SwarmCloudRuntime
    from oracle.swarm.swarmcloud import StaticBearer

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("/input"):
            return httpx.Response(200, json={"state": "answered", "answer": {"answer_id": "a"}})
        if path == "/v1/workflows/w":
            return httpx.Response(
                200, json={"workflow": {"steps": [{"step_id": "r", "task_id": "t1"}]}}
            )
        return form_response

    return SwarmCloudRuntime(
        "https://swarm.test", StaticBearer("x"), transport=httpx.MockTransport(handler)
    )


@pytest.mark.parametrize("valid", [True, False])
async def test_a_gzip_encoded_error_body_is_runtime_unavailable(valid):
    import gzip

    envelope = json.dumps({"code": "unavailable", "detail": {"reason": "unavailable"}}).encode()
    body = gzip.compress(envelope) if valid else b"not gzip at all"
    runtime = _record_runtime(
        httpx.Response(503, headers={"content-encoding": "gzip"}, stream=httpx.ByteStream(body))
    )
    with pytest.raises(RuntimeUnavailable) as exc:
        await runtime.answer_record("w", "r", "review1.json")
    assert exc.value.retryable


async def test_a_large_error_body_is_an_error_not_unreadable():
    runtime = _record_runtime(
        httpx.Response(503, headers={"content-length": str(10**9)}, stream=_Endless(10**6))
    )
    with pytest.raises(RuntimeUnavailable) as exc:
        await runtime.answer_record("w", "r", "review1.json")
    assert exc.value.status == 503 and exc.value.retryable


async def test_an_unread_final_cost_keeps_the_workflow_for_one_more_read(client, owner):
    tenant_id, auth = owner
    swarm = on()
    use(swarm)
    run = await started(client, auth)
    swarm._advance(swarm.workflows["wf_1"])  # it spends before Oracle reads it again
    swarm.fail_reads_after_cancel = 1
    resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=auth)
    assert resp.status_code == 200, resp.text
    assert swarm.workflows["wf_1"].state == "CANCELLED"
    # Cancelled, its last cost not read: kept attached for one more read.
    wf = (await _knobs_of(tenant_id, run["id"]))["workflow"]
    assert wf["state"] == "live" and wf["cancel_pending"]["confirmed"]
    await tick(client, auth)
    assert (await _knobs_of(tenant_id, run["id"]))["workflow"]["state"] == "cancelled"
    run = await get(client, auth, run["id"])
    assert run["spent_usd"] == sum(s.cost for s in swarm.workflows["wf_1"].steps) > 0


async def test_a_final_cost_unread_twice_detaches(client, owner):
    tenant_id, auth = owner
    swarm = on()
    use(swarm)
    run = await started(client, auth)
    swarm.fail_reads_after_cancel = 2
    resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=auth)
    assert resp.status_code == 200, resp.text
    assert await _tick_errors(client, auth) == []
    wf = (await _knobs_of(tenant_id, run["id"]))["workflow"]
    assert wf["state"] == "cancelled"
    run = await get(client, auth, run["id"])
    assert any("last cost" in n for n in run["notes"])


async def test_a_redacted_answerer_is_never_matched_to_a_member(client, owner):
    tenant_id, auth = owner
    swarm = on()
    member = "x" * 188 + "@example.com"
    assert len(member) == 200
    await _member(tenant_id, member)
    run = await _at_baseline(client, auth, swarm)
    # Kept as 200 characters, it reads as the member's address; it is not theirs.
    swarm.console_answer("wf_1", "baseline-review1", "MERGE", by=member + ".evil.example")
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    console = _console(run, pending(run)["id"])
    assert console["counted"] is False and console["needs"] == "confirm"
    assert "could not be read as recorded" in console["reason"]


async def test_console_answerers_differing_only_by_case_are_matched_deterministically(
    client, owner
):
    tenant_id, auth = owner
    async with tenant_session(tenant_id) as s:
        from oracle.auth.models import User
        from oracle.auth.service import hash_password

        # Created before emails were lowercased: two members differing only by case.
        s.add(User(email="Lead@example.com", password_hash=hash_password("pw"), role="viewer"))
        s.add(User(email="lead@example.com", password_hash=hash_password("pw"), role="approver"))
        await s.commit()
    swarm = on()
    run = await _at_baseline(client, auth, swarm)
    cp = pending(run)
    # Neither matches exactly: ambiguous, so it does not count.
    swarm.console_answer("wf_1", "baseline-review1", "MERGE", by="LEAD@EXAMPLE.COM")
    await tick(client, auth)
    console = _console(await get(client, auth, run["id"]), cp["id"])
    assert console["counted"] is False and "more than one" in console["reason"]

    # An exact match wins; the result is the same however the rows come back.
    from oracle.runs.models import Checkpoint

    probe = Checkpoint(run_id=uuid.uuid4(), kind="baseline_confirm", approver_role="approver")
    async with tenant_session(tenant_id) as s:
        for by, role, counted in (
            ("Lead@example.com", "viewer", False),
            ("lead@example.com", "approver", True),
        ):
            for _ in range(3):
                member, reason = await service._console_member(s, probe, by)
                assert member is not None and member.role == role, by
                assert (reason is None) is counted, (by, reason)


# Built from pieces at runtime: no credential-shaped literal in the source.
_TAIL = "abcdefgh" + "12345"
_RUN = "ort" + "_" + _TAIL


@pytest.mark.parametrize(
    "text",
    [
        "Authorization: Bearer%20" + _RUN,
        "line one\\n" + _RUN,
        "line one\n" + _RUN,
        "token" + "=" + "123" + _RUN,
        "id 7" + "po" + "_" + _TAIL,
        "Bearer%20" + "sc-" + "secret-1",
    ],
)
def test_run_tokens_however_joined_are_redacted(text):
    from oracle.swarm.swarmcloud import _redact, redact_whole

    for fn in (_redact, redact_whole):
        out = fn(text)
        assert "abcdefgh" not in out and "secret" not in out, out
        assert "<withheld>" in out


@pytest.mark.parametrize(
    "text",
    [
        "bearer token handling",
        "Bearer tokens are rotated daily.",
        "The bearer: someone",
        "support_ticket and import_policy",
    ],
)
def test_ordinary_words_are_not_withheld(text):
    from oracle.swarm.swarmcloud import _redact, redact_whole

    assert _redact(text) == text and redact_whole(text) == text


async def test_redo_needs_findings_or_a_note(client, owner):
    tenant_id, auth = owner
    swarm = on()
    await _member(tenant_id, "lead@example.com")
    run = await _at_baseline(client, auth, swarm)
    cp = pending(run)
    swarm.console_answer("wf_1", "baseline-review1", "NOT_YET", ["  "], by="lead@example.com")
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    console = _console(run, cp["id"])
    assert console["needs"] == "redo_or_continue" and console["can_redo"] is False
    resp = await _decide_raw(client, auth, run, "redo")
    assert resp.status_code == 422 and "note" in resp.text
    assert len(swarm.submissions()) == 1
    run = await decide(client, auth, run, "redo", note="Add the retention goal")
    assert len(swarm.submissions()) == 2


async def test_take_cost_does_not_double_count_in_workflow_revisions(client, owner):
    """A revision inside the workflow at its start segment is another attempt of that
    segment on the same workflow: the workflow's cost is counted once, not per attempt."""
    tenant_id, auth = owner
    swarm = on()
    run = await _waiting(client, auth, tenant_id, swarm)
    run = await decide(client, auth, run, "changes_requested", note="Add a metric")
    attempts = run["segments"][0]["attempts"]
    assert [a["workflow_id"] for a in attempts] == ["wf_1", "wf_1"]
    for _ in range(3):
        await tick(client, auth)
    run = await get(client, auth, run["id"])
    total = sum(s.cost for s in swarm.workflows["wf_1"].steps)
    assert total > 0
    assert run["segments"][0]["cost_usd"] == total
    assert run["spent_usd"] == total


# --------------------------------------------------------------------------- round 5


class _Clock:
    """Oracle's clock, moved forward by the test (SwarmCloud's fake keeps its own)."""

    def __init__(self, monkeypatch) -> None:
        self.offset = timedelta(0)
        real = service._now
        monkeypatch.setattr(service, "_now", lambda: real() + self.offset)

    def forward(self, seconds: float) -> None:
        self.offset += timedelta(seconds=seconds)


async def _inbox(client, auth) -> dict:
    resp = await client.get("/v1/inbox", headers=auth)
    assert resp.status_code == 200, resp.text
    return resp.json()


# MAJOR 1 (W5): any console answer that did not count holds the token, unreadable too.


@pytest.mark.parametrize("cause", ["oversized_form", "odd_verdict", "refused_read"])
async def test_an_unreadable_console_answer_makes_the_run_token_read_only(client, owner, cause):
    tenant_id, auth = owner
    swarm = on()
    run = await _at_baseline(client, auth, swarm)
    token = token_of(swarm)
    swarm.console_answer("wf_1", "baseline-review1", "NOT_YET", ["x"], by="lead@example.com")
    step = swarm.workflows["wf_1"].step("baseline-review1")
    if cause == "oversized_form":
        step.files["review1.json"] = json.dumps({"verdict": "NOT_YET", "findings": ["y" * 300_000]})
    elif cause == "odd_verdict":
        step.files["review1.json"] = json.dumps({"verdict": "MAYBE", "findings": []})
    else:
        # A refused read after the step SUCCEEDED: answered, the verdict unread.
        swarm.fail_input_reads, swarm.fail_input_status = 100, 403
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert _console(run, pending(run)["id"])["needs"] == "unreadable"
    assert run["token_read_only"] is True
    held = await _writes(token)
    for name in ("push_draft", "import_version", "propose_change"):
        assert held[name].startswith("ERROR") and "waiting for approval" in held[name], held
    assert held["get_run_output"].startswith("OK")
    # An approver decides (an approval needs nothing the workflow did not do): released.
    run = await decide(client, auth, run, "approved")
    assert run["token_read_only"] is False


# MAJOR 2 (ceiling): a submission given up by Retry or Cancel is looked for until found
# (then cancelled and costed) or ruled out, within its credential's lifetime.


async def _retried(client, auth, swarm, clock) -> dict:
    """A lost submission past the lookup cap, retried from the Inbox: wf_1 landed (lost
    behind 1100 newer tasks) and wf_2 is the segment's workflow."""
    use(swarm)
    swarm.other_tasks = 1100
    swarm.lose_next_submit = True
    run = await started(client, auth)
    clock.forward(service.LOST_LOOKUP_SECONDS + 60)
    await tick(client, auth)
    assert (await _inbox(client, auth))["lookups"]
    resp = await client.post(f"/v1/runs/{run['id']}/retry", headers=auth)
    assert resp.status_code == 200, resp.text
    run = resp.json()
    assert run["segments"][0]["workflow_id"] == "wf_2"
    return run


async def test_a_retried_lost_submission_is_found_later_cancelled_and_costed(
    client, owner, monkeypatch
):
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    run = await _retried(client, auth, swarm, clock)
    # The attempt number Oracle shows is the one in the new submission's key.
    keys = [b["steps"][0]["metadata"]["oracle_key"] for b in swarm.submissions()]
    assert keys[1].endswith("-2")
    assert run["segments"][0]["attempts"][-1]["attempt"] == 2
    # Given up on, not forgotten: shown while Oracle looks for it.
    assert "looking for an earlier submission" in (run["searching"] or "")
    [shown] = (await _inbox(client, auth))["searches"]
    assert shown["id"] == run["id"] and keys[0] in shown["searching"]
    # The lost workflow spends on its own budget meanwhile.
    swarm._advance(swarm.workflows["wf_1"])
    # The listing fails, then recovers.
    swarm.other_tasks = 0
    swarm.fail_lookups = 1
    clock.forward(service.STUCK_LOOKUP_SECONDS + 1)
    await tick(client, auth)
    assert swarm.workflows["wf_1"].state == "RUNNING"
    assert (await _inbox(client, auth))["searches"]
    # Looked up every STUCK_LOOKUP_SECONDS, not on every tick.
    lookups = len(_task_lookups(swarm))
    await tick(client, auth)
    assert len(_task_lookups(swarm)) == lookups
    clock.forward(service.STUCK_LOOKUP_SECONDS + 1)
    assert await _tick_errors(client, auth) == []
    assert swarm.workflows["wf_1"].state == "CANCELLED"
    lost_cost = sum(s.cost for s in swarm.workflows["wf_1"].steps)
    assert lost_cost > 0
    run = await get(client, auth, run["id"])
    found = [a for a in run["segments"][0]["attempts"] if a["workflow_id"] == "wf_1"]
    assert [a["cost_usd"] for a in found] == [lost_cost] and found[0]["attempt"] == 1
    assert run["spent_usd"] >= lost_cost
    assert run["searching"] is None and (await _inbox(client, auth))["searches"] == []
    assert any("found" in n and keys[0] in n for n in run["notes"])
    # Nothing else is submitted, and wf_2 goes on.
    assert len(swarm.submissions()) == 2 and swarm.workflows["wf_2"].state != "CANCELLED"


async def test_a_background_search_ends_when_the_credential_would_have_expired(
    client, owner, monkeypatch
):
    _, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    run = await _retried(client, auth, swarm, clock)
    clock.forward(service.STUCK_LOOKUP_SECONDS + 1)
    await tick(client, auth)
    assert (await get(client, auth, run["id"]))["searching"]
    # Past the lost submission's credential (at most 24 h) and the slack for a step that
    # was running then (round 6).
    clock.forward(86400 + get_runtime_settings().step_seconds + 60)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["searching"] is None
    assert any("stopped looking" in n for n in run["notes"])


async def test_a_cancelled_runs_lost_submission_is_found_later_cancelled_and_costed(
    client, owner, monkeypatch
):
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    use(swarm)
    swarm.other_tasks = 1100
    swarm.lose_next_submit = True
    run = await started(client, auth)
    resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=auth)
    assert resp.status_code == 200, resp.text
    clock.forward(service.LOST_LOOKUP_SECONDS + 60)
    assert await _tick_errors(client, auth) == []
    knobs = await _knobs_of(tenant_id, run["id"])
    assert knobs["workflow"]["state"] != "live"
    run = await get(client, auth, run["id"])
    assert run["status"] == "cancelled" and run["searching"]
    assert (await _inbox(client, auth))["searches"]
    swarm._advance(swarm.workflows["wf_1"])
    swarm.other_tasks = 0
    clock.forward(service.STUCK_LOOKUP_SECONDS + 1)
    assert await _tick_errors(client, auth) == []
    assert swarm.workflows["wf_1"].state == "CANCELLED"
    run = await get(client, auth, run["id"])
    lost_cost = sum(s.cost for s in swarm.workflows["wf_1"].steps)
    assert lost_cost > 0 and run["spent_usd"] == lost_cost
    assert run["searching"] is None


async def test_a_ruled_out_background_search_ends_quietly(client, owner, monkeypatch):
    _, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    run = await _retried(client, auth, swarm, clock)
    # The lost one never landed after all, and the listing now reaches older tasks.
    del swarm.workflows["wf_1"]
    swarm.other_tasks = 0
    swarm.older_tasks = 5
    clock.forward(service.STUCK_LOOKUP_SECONDS + 1)
    assert await _tick_errors(client, auth) == []
    run = await get(client, auth, run["id"])
    assert run["searching"] is None and run["status"] in ("running", "awaiting_checkpoint")
    assert swarm.workflows["wf_2"].state != "CANCELLED" and len(swarm.submissions()) == 2
    assert not any("found submission" in n for n in run["notes"])


# Minors.


@pytest.mark.parametrize(
    "refusal",
    [
        httpx.Response(404, text="<html><body>Not Found</body></html>"),
        httpx.Response(
            404, json={"code": "not_found", "message": "x", "detail": {"reason": "no_step"}}
        ),
    ],
)
async def test_a_404_on_an_answer_post_surfaces_in_the_inbox_after_n_tries(client, owner, refusal):
    _, auth = owner
    swarm = on()
    run = await _at_baseline(client, auth, swarm)
    for i in range(service.NOT_FOUND_TRIES):
        swarm.fail_next_answer = refusal
        resp = await _decide_raw(client, auth, run, "approved")
        assert resp.status_code == 503, resp.text
        assert ("Cancel" in resp.text) is (i == service.NOT_FOUND_TRIES - 1), resp.text
    [stuck] = (await _inbox(client, auth))["lookups"]
    assert stuck["id"] == run["id"] and "404" in stuck["stuck"] and "Cancel" in stuck["stuck"]
    assert stuck["can_retry"] is False
    resp = await client.post(f"/v1/runs/{run['id']}/retry", headers=auth)
    assert resp.status_code == 409
    resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=auth)
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "cancelled"
    assert (await _inbox(client, auth))["lookups"] == []


async def test_an_answer_post_that_works_after_a_404_clears_the_count(client, owner):
    _, auth = owner
    swarm = on()
    run = await _at_baseline(client, auth, swarm)
    swarm.fail_next_answer = httpx.Response(404, text="Not Found")
    assert (await _decide_raw(client, auth, run, "approved")).status_code == 503
    run = await decide(client, auth, run, "approved")
    assert run["stuck"] is None and run["status"] == "running"


async def test_a_bare_404_while_cancelling_surfaces_in_the_inbox_after_n_tries(
    client, owner, monkeypatch
):
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    use(swarm)
    run = await started(client, auth)
    swarm.html_404 = True
    resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=auth)
    assert resp.status_code == 200, resp.text
    assert (await _inbox(client, auth))["lookups"] == []
    for _ in range(service.NOT_FOUND_TRIES):
        clock.forward(service.STUCK_LOOKUP_SECONDS + 1)
        assert any("HTTP 404" in e for e in await _tick_errors(client, auth))
    [stuck] = (await _inbox(client, auth))["lookups"]
    assert stuck["id"] == run["id"] and "404" in stuck["stuck"] and stuck["can_retry"] is False
    # Past the cap the cancel call is tried again now and then, not on every tick (its
    # status is still read every tick: round 6).
    calls = len([r for r in swarm.requests if r.url.path.endswith("/cancel")])
    assert await _tick_errors(client, auth) == []
    assert len([r for r in swarm.requests if r.url.path.endswith("/cancel")]) == calls
    # Cancel from the Inbox stops trying, noted; its cost is still read (P3d, round 6).
    resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=auth)
    assert resp.status_code == 200, resp.text
    knobs = await _knobs_of(tenant_id, run["id"])
    assert knobs["workflow"]["state"] == "cancelled" and knobs["workflow"]["stopped"]
    assert [e["id"] for e in knobs["searches"]] == ["wf_1"]
    assert any("stopped cancelling" in n for n in resp.json()["notes"])
    assert (await _inbox(client, auth))["lookups"] == []


def test_the_fake_answers_a_missing_route_without_swarmclouds_envelope():
    from oracle.swarm.swarmcloud import _refusal

    swarm = on()
    request = httpx.Request(
        "GET", "https://swarm.test/v1/no-such-route", headers={"Authorization": "Bearer sc-bearer"}
    )
    resp = swarm(request)
    assert resp.status_code == 404 and resp.json() == {"detail": "Not Found"}
    exc = _refusal(resp, "GET", "/v1/no-such-route")
    assert not exc.gone and exc.retryable


def _listing_runtime(pages: list[list[dict]], *, date: datetime | None = None, endless=False):
    from email.utils import format_datetime

    from oracle.swarm import SwarmCloudRuntime
    from oracle.swarm.swarmcloud import StaticBearer

    def handler(request: httpx.Request) -> httpx.Response:
        n = int(request.url.params.get("page_token") or 0)
        rows = pages[min(n, len(pages) - 1)]
        more = endless or n + 1 < len(pages)
        headers = {"date": format_datetime(date, usegmt=True)} if date else {}
        return httpx.Response(
            200,
            headers=headers,
            json={"tasks": rows, "next_page_token": str(n + 1) if more else None},
        )

    return SwarmCloudRuntime(
        "https://swarm.test", StaticBearer("x"), transport=httpx.MockTransport(handler)
    )


def _row(task: str, at: datetime, key: str = "other", wf: str = "w") -> dict:
    meta = {"oracle_key": key}
    return {"id": task, "workflow_id": wf, "metadata": meta, "created_at": at.isoformat()}


async def test_find_by_label_does_not_conclude_on_a_listing_out_of_order():
    since = datetime.now(service.UTC)
    day = timedelta(days=1)
    # An old row, then a newer one: not newest first, so the old row proves nothing.
    shuffled = [_row("a", since - day), _row("b", since + timedelta(minutes=1))]
    runtime = _listing_runtime([shuffled, [_row("c", since, key="k", wf="wf_k")]])
    assert await runtime.find_by_label("k", since=since) == "wf_k"
    # Never found, never in order: inconclusive (the caller's attempt cap applies).
    runtime = _listing_runtime([shuffled], endless=True)
    with pytest.raises(RuntimeUnavailable) as exc:
        await runtime.find_by_label("k", since=since)
    assert exc.value.retryable
    # In order, the old row concludes "not found".
    ordered = [_row("b", since + timedelta(minutes=1)), _row("a", since - day)]
    runtime = _listing_runtime([ordered], endless=True)
    assert await runtime.find_by_label("k", since=since) is None


async def test_find_by_label_widens_the_skew_margin_when_oracles_clock_is_ahead():
    oracle_now = datetime.now(service.UTC)
    swarm_now = oracle_now - timedelta(minutes=30)  # Oracle's clock is 30 min ahead
    since = oracle_now - timedelta(minutes=1)
    pages = [
        [_row("newer", swarm_now - timedelta(seconds=20))],
        [_row("ours", swarm_now - timedelta(seconds=50), key="k", wf="wf_k")],
    ]
    runtime = _listing_runtime(pages, date=swarm_now)
    assert await runtime.find_by_label("k", since=since) == "wf_k"


async def test_read_limited_raises_for_an_error_body_over_the_limit():
    from oracle.swarm import SwarmCloudRuntime
    from oracle.swarm.swarmcloud import StaticBearer

    body = {"code": "unavailable", "message": "x" * 10_000, "detail": {"reason": "unavailable"}}
    runtime = SwarmCloudRuntime(
        "https://swarm.test",
        StaticBearer("x"),
        transport=httpx.MockTransport(lambda r: httpx.Response(503, json=body)),
    )
    async with runtime._client() as c:
        with pytest.raises(RuntimeUnavailable) as exc:
            await runtime._read_limited(c, "/v1/tasks/t/artifacts/raw", {"name": "f"}, 1024)
    assert exc.value.status == 503


async def test_a_broken_gzip_form_is_unreadable_not_lost():
    runtime = _record_runtime(
        httpx.Response(
            200, headers={"content-encoding": "gzip"}, stream=httpx.ByteStream(b"not gzip")
        )
    )
    record = await runtime.answer_record("w", "r", "review1.json")
    assert record.answered and record.verdict is None


@pytest.mark.parametrize(
    "text",
    [
        "bearer token-based auth",
        "Bearer token-based authentication is used",
        "max_po_lines_per_page",
        "write to alice_po_reviewer@corp.com",
        "the po_number field",
    ],
)
def test_round_5_ordinary_words_are_not_withheld(text):
    from oracle.swarm.swarmcloud import _redact, redact_whole

    assert _redact(text) == text and redact_whole(text) == text


@pytest.mark.parametrize(
    "text",
    [
        "line one\\u000a" + _RUN,
        "line one\\u000D" + _RUN,
        "Authorization=Bearer+" + _RUN,
        "Authorization=Bearer+" + "sc-" + "secret-1",
        "token: " + _RUN,
    ],
)
def test_round_5_run_tokens_however_joined_are_redacted(text):
    from oracle.swarm.swarmcloud import _redact, redact_whole

    for fn in (_redact, redact_whole):
        out = fn(text)
        assert "abcdefgh" not in out and "secret" not in out, out


async def test_a_pending_cancel_without_times_still_stops_looking(client, owner, monkeypatch):
    tenant_id, auth = owner
    swarm = on()
    use(swarm)
    swarm.other_tasks = 1100
    swarm.lose_next_submit = True
    run = await started(client, auth)
    resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=auth)
    assert resp.status_code == 200, resp.text
    async with tenant_session(tenant_id) as s:
        row = await s.get(Run, uuid.UUID(run["id"]))
        wf = dict(row.knobs["workflow"])
        wf["lookup_since"] = None
        wf["cancel_pending"] = {k: v for k, v in wf["cancel_pending"].items() if k != "since"}
        row.knobs = {**row.knobs, "workflow": wf}
        await s.commit()
    monkeypatch.setattr(service, "LOST_LOOKUP_TRIES", 3)
    for _ in range(3):
        await tick(client, auth)
    assert (await _knobs_of(tenant_id, run["id"]))["workflow"]["state"] != "live"


async def _row_is_free(tenant_id, run_id: str) -> bool:
    from sqlalchemy.exc import DBAPIError

    async with tenant_session(tenant_id) as s:
        try:
            await s.scalar(
                select(Run.id).where(Run.id == uuid.UUID(run_id)).with_for_update(nowait=True)
            )
        except DBAPIError:
            return False
        return True


async def test_retry_looks_up_outside_the_runs_row_lock_and_rechecks(client, owner, monkeypatch):
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    runtime = use(swarm)
    swarm.other_tasks = 1100
    swarm.lose_next_submit = True
    run = await started(client, auth)
    clock.forward(service.LOST_LOOKUP_SECONDS + 60)
    await tick(client, auth)
    free: list[bool] = []
    real = runtime.find_by_label

    async def find(label, since=None):
        free.append(await _row_is_free(tenant_id, run["id"]))
        # Meanwhile the run is cancelled elsewhere (never waiting on a held lock).
        async with tenant_session(tenant_id) as s:
            await s.execute(sa_text("SET LOCAL lock_timeout = '2s'"))
            row = await s.get(Run, uuid.UUID(run["id"]))
            row.status = "cancelled"
            await s.commit()
        return await real(label, since)

    monkeypatch.setattr(runtime, "find_by_label", find)
    resp = await client.post(f"/v1/runs/{run['id']}/retry", headers=auth)
    assert free == [True]
    assert resp.status_code == 409, resp.text  # re-checked: nothing waits for a retry now
    assert len(swarm.submissions()) == 1


async def test_cancel_calls_swarmcloud_outside_the_runs_row_lock(client, owner, monkeypatch):
    tenant_id, auth = owner
    swarm = on()
    runtime = use(swarm)
    run = await started(client, auth)
    free: list[bool] = []
    real = runtime.cancel

    async def cancel(workflow_id):
        free.append(await _row_is_free(tenant_id, run["id"]))
        return await real(workflow_id)

    monkeypatch.setattr(runtime, "cancel", cancel)
    resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=auth)
    assert resp.status_code == 200, resp.text
    assert free == [True] and swarm.workflows["wf_1"].state == "CANCELLED"
    assert (await _knobs_of(tenant_id, run["id"]))["workflow"]["state"] == "cancelled"
    assert resp.json()["spent_usd"] == sum(s.cost for s in swarm.workflows["wf_1"].steps)
