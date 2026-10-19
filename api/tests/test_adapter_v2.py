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
from tests.swarmcloud_fake import EGRESS, FakeSwarmCloud
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
    swarm = FakeSwarmCloud()
    for mcp, wait, answer in [
        (False, False, False),
        (True, False, False),
        (True, True, False),
        (True, True, True),
        (False, True, True),
    ]:
        swarm.mcp, swarm.await_input, swarm.service_answer = mcp, wait, answer
        use(swarm)
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
    assert RuntimeSettings().checkpoint_wait_seconds == 86400
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
    patch = next(r for r in swarm.requests if r.method == "PATCH")
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
    assert body["metadata"]["label"] == f"oracle-{run['id']}-baseline-1"
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
            "expires_after_seconds": 86400,
            "on_expire": "fail",
            "remind": [],
        }
        assert "when" not in s
    # The token is only in the credential map, never in a step.
    assert token not in json.dumps(body["steps"]) and token not in json.dumps(body["metadata"])
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

    # The same answer again is a replay (200, or a 409 for the same body): success.
    runtime = swarm.runtime()
    first = swarm.answers[0]
    again = await runtime.answer(
        "wf_1", "next_draft-review1", answer_id=first["answer_id"], payload=first["payload"]
    )
    assert again.replayed is True
    swarm.replay_as_409 = True
    again = await runtime.answer(
        "wf_1", "next_draft-review1", answer_id=first["answer_id"], payload=first["payload"]
    )
    assert again.replayed is True
    with pytest.raises(RuntimeUnavailable) as exc:
        await runtime.answer(
            "wf_1", "next_draft-review1", answer_id="other", payload={"verdict": "MERGE"}
        )
    assert exc.value.code == "already_answered" and exc.value.status == 409

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
    assert second["metadata"]["label"] == f"oracle-{run['id']}-baseline-2"
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


async def test_refused_answers_continue_as_a_new_workflow(client, owner):
    tenant_id, auth = owner
    swarm = on()
    use(swarm)
    await feedback_doc(client, auth, tenant_id)
    run = await started(client, auth, flow="feedback_loop", document="checkout-redesign")
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    # Before SwarmCloud lets a service principal answer: person_required.
    swarm.service_answer = False
    run = await decide(client, auth, run, "approved")
    assert any("person_required" in n for n in run["notes"])
    assert swarm.workflows["wf_1"].state == "CANCELLED"
    # Approved at the last checkpoint: the run is done; the next run is per segment.
    assert run["status"] == "succeeded"
    status = (await client.get("/v1/runtime/status", headers=auth)).json()
    assert status["features"]["service_answer"] == "off"


async def test_someone_else_answered_continues_as_a_new_workflow(client, owner):
    tenant_id, auth = owner
    swarm = on()
    runtime = use(swarm)
    await feedback_doc(client, auth, tenant_id)
    run = await started(client, auth, flow="feedback_loop", document="checkout-redesign")
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    await runtime.answer(
        "wf_1", "next_draft-review1", answer_id="console", payload={"verdict": "MERGE"}
    )
    swarm.answers.clear()
    run = await decide(client, auth, run, "changes_requested", note="Rework the metric")
    assert any("already_answered" in n for n in run["notes"])
    assert len(swarm.submissions()) == 2 and run["status"] == "running"


# --------------------------------------------------------------------------- labels


async def test_a_lost_submit_is_found_by_its_label(client, owner):
    _, auth = owner
    swarm = on()
    use(swarm)
    swarm.lose_next_submit = True
    run = await started(client, auth)
    # Created in SwarmCloud, answer lost: found by its label, not submitted twice.
    assert len(swarm.workflows) == 1 and len(swarm.submissions()) == 1
    assert run["segments"][0]["workflow_id"] == "wf_1" and run["status"] == "running"
    gets = [r for r in swarm.requests if r.method == "GET" and r.url.path == "/v1/workflows"]
    assert gets[0].url.params["label"] == f"oracle-{run['id']}-baseline-1"
    # The token the lost submission carried is the run's live one.
    assert await verify_run_token(token_of(swarm)) is not None


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
    labels = [b["metadata"]["label"] for b in swarm.submissions()]
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
        422, json={"detail": {"code": "mcp_credential_shape", "message": f"bad {token}"}}
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


async def test_a_wait_that_expires_while_the_run_is_paused_opens_in_the_inbox(client, owner):
    tenant_id, auth = owner
    swarm = on()
    use(swarm)
    await feedback_doc(client, auth, tenant_id)
    run = await started(client, auth, flow="feedback_loop", document="checkout-redesign")
    async with tenant_session(tenant_id) as s:
        row = await s.get(Run, uuid.UUID(run["id"]))
        row.knobs = {**row.knobs, "spend_ceiling_usd": "0.5"}
        await s.commit()
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "paused_overrun"
    swarm.tick(86400 + 1)
    resp = await client.post(f"/v1/runs/{run['id']}/resume", headers=auth)
    assert resp.status_code == 200, resp.text
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "awaiting_checkpoint"
    assert pending(run)["payload"]["wait"]["ended"] == "expired"
    assert any("expired" in n for n in run["notes"])
    run = await decide(client, auth, run, "approved")
    assert run["status"] == "succeeded" and swarm.answers == []
