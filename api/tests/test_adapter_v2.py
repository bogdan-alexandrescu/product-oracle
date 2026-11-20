"""Adapter v2 (docs/swarmcloud-interface.md) against a fake SwarmCloud API: feature
detection, the MCP server's registration, run tokens through SwarmCloud, checkpoints as
waits for a person, answers, expiry, the tail rule, label de-duplication, the egress
check and the fallback while a switch is off."""

import asyncio
import json
import logging
import uuid
from contextlib import asynccontextmanager
from dataclasses import replace
from datetime import datetime, timedelta
from decimal import Decimal

import httpx
import httpx2
import pytest
from mcp import Client
from mcp.client.streamable_http import streamable_http_client
from sqlalchemy import select, text
from sqlalchemy import text as sa_text

from oracle import wording
from oracle.auth.service import create_user, make_session_cookie
from oracle.config import get_settings
from oracle.db import get_engine
from oracle.main import app
from oracle.mcp import server as mcp_server
from oracle.mcp.egress import client_address
from oracle.models import AuditEvent
from oracle.review.models import FeedbackItem
from oracle.runs import service, workflow
from oracle.runs.models import Run, RunSegment
from oracle.runtokens import RunToken, verify_run_token
from oracle.swarm import RuntimeUnavailable, WorkflowSpec, set_runtime
from oracle.swarm.runtime import StepStatus, WorkflowStatus
from oracle.swarm.settings import RuntimeSettings, get_runtime_settings
from oracle.swarm.swarmcloud import StaticBearer, SwarmCloudRuntime, mcp_server_body
from oracle.tenancy import tenant_session
from tests.conftest import make_tenant
from tests.fixtures import draft, import_draft, seed_auth
from tests.swarmcloud_fake import EGRESS, SERVICE_PRINCIPAL, FakeSwarmCloud
from tests.test_runs import as_user, decide, get, pending, started, tick

PUBLIC = "https://oracle.swarm.saga.xyz"
MCP_URL = PUBLIC + "/mcp"
# D4: the lead line of a note-only send-back's findings (oracle.runs.review_file.findings).
REVIEW_LEAD = (
    "Structured review of the next_draft output, attempt {attempt}: 0 entries. "
    "The full review: get_checkpoint_review."
)
# D10: a PRD review's send-back is D4's review of prd.md, one entry per feedback item.
DOC_REVIEW_LEAD = (
    "Structured review of prd.md, attempt {attempt}: {n} {entries}. "
    "The full review: get_checkpoint_review."
)


def doc_findings(item_id: str, note: str, summary: str = "Add a metric") -> list[str]:
    """The findings of a PRD review sent back with one open feedback item and a note."""
    return [
        DOC_REVIEW_LEAD.format(attempt=1, n=1, entries="entry"),
        f'{item_id}: change section general; summary "{summary}"',
        f"Note: {note}",
    ]


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


class _LoopClock:
    """The event loop's clock, moved forward by the test: a timeout under test is
    reached at once, with no real wait."""

    def __init__(self, monkeypatch) -> None:
        self.offset = 0.0
        loop = asyncio.get_running_loop()
        real = loop.time
        monkeypatch.setattr(loop, "time", lambda: real() + self.offset)

    def forward(self, seconds: float) -> None:
        self.offset += seconds


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


@pytest.mark.timing
async def test_features_are_cached_and_bounded_by_the_timeout(monkeypatch):
    import asyncio
    import time

    swarm = on()
    runtime = swarm.runtime(features_ttl=60)
    await runtime.features()
    calls = len(swarm.requests)
    await runtime.features()
    assert len(swarm.requests) == calls  # cached
    await runtime.features(refresh=True)
    assert len(swarm.requests) == 2 * calls

    clock = _LoopClock(monkeypatch)

    async def slow(request):
        clock.forward(0.2)  # the 0.2 s timeout is reached on the loop's clock, not waited
        await asyncio.sleep(5)  # ends only if the timeout does not
        return httpx.Response(200, json={})

    from oracle.swarm import SwarmCloudRuntime
    from oracle.swarm.swarmcloud import StaticBearer

    runtime = SwarmCloudRuntime(
        "https://swarm.test", StaticBearer("x"), timeout=0.2, transport=httpx.MockTransport(slow)
    )
    started_at = time.monotonic()
    feats = await runtime.features()
    assert time.monotonic() - started_at < 1
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
    # 8 agent steps and 2 revisions; 5 checkpoints, the last in 2 rounds.
    assert len(agents) == 8 + 2 and len(waits) == 6
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
    assert "seq 1 (Ground Truth proposal): baseline.yaml, summary.md" in second["input"]["prompt"]
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
    # SwarmCloud stages files only from direct dependencies (422 invalid_dag otherwise).
    assert steps["next_draft-revise1"]["depends_on"] == [
        "next_draft-review1",
        "next_draft-2-writer",
    ]
    assert steps["next_draft-revise2"]["depends_on"] == [
        "next_draft-review2",
        "next_draft-revise1",
    ]

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
    # D10: a PRD review sends back D4's review of the document's open feedback, one
    # finding per item, then the note.
    run = await decide(client, approver, run, "changes_requested", note="Add a guardrail metric")
    assert run["status"] == "running"
    [item] = (await client.get("/v1/documents/checkout-redesign/feedback", headers=auth)).json()
    findings = doc_findings(item["id"], "Add a guardrail metric")
    assert swarm.answers == [
        {
            "workflow_id": "wf_1",
            "step_id": "next_draft-review1",
            "answer_id": cp["id"],
            "payload": {"verdict": "NOT_YET", "findings": findings},
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
    assert record.findings == tuple(findings)
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
    run = await started(client, auth, checkpoints={"eng_dates": False})
    expected = ["baseline_confirm", "feature_set", "eng_review", "priority_order", "prd_review"]
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
        "eng_review-review1",
        "priority-review1",
        "prd_draft-review1",
    ]
    # The last checkpoint approved in round 1: the pass-through rest was cancelled.
    assert swarm.workflows["wf_1"].state == "CANCELLED"
    assert run["segments"][4]["draft_import"]["version"] == 1
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
    # Not "decide again": the run continues as a new workflow with the decision. #481: the
    # note says what happened and who acts, in a person's words; the code is in its refs.
    _person_note(run, "person_required", "only a person", "nobody needs to act")
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
    assert resp.status_code == 503 and "recorded" in resp.text
    run = await get(client, auth, run["id"])
    # The decision is recorded (nothing to decide again); the post is the tick's.
    assert run["status"] == "awaiting_checkpoint"
    assert next(c for c in run["checkpoints"] if c["id"] == cp["id"])["status"] == (
        "changes_requested"
    )
    # Meanwhile the workflow went on with the recorded answer.
    assert swarm.workflows["wf_1"].step("next_draft-revise1").state == "SUCCEEDED"
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    # Delivered (replayed); the same tick's pass follows the workflow into round 2's wait.
    assert run["status"] == "awaiting_checkpoint" and len(swarm.answers) == 1
    assert len(swarm.submissions()) == 1 and _live_with(swarm, "next_draft") == ["wf_1"]
    assert not any("decided outside Oracle" in n for n in run["notes"])
    decided = next(c for c in run["checkpoints"] if c["id"] == cp["id"])
    answered = decided["payload"]["wait"]["answered"]
    assert answered["answer_id"] == cp["id"] and answered["replayed"] is True
    assert answered["at"]
    # The replay carries the first wording, so the revision applies it.
    attempt = run["segments"][0]["attempts"][-1]
    assert attempt["note"] == "Add a guardrail metric"
    # The revision used the first wording; the run goes on to round 2 in the same workflow.
    staged = json.loads(swarm.workflows["wf_1"].step("next_draft-revise1").staged["review1.json"])
    # D10: the document's open item goes back with the note, one finding each.
    [item] = (await client.get("/v1/documents/checkout-redesign/feedback", headers=auth)).json()
    assert staged["findings"] == doc_findings(item["id"], "Add a guardrail metric")
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "awaiting_checkpoint"
    assert pending(run)["payload"]["wait"]["step_id"] == "next_draft-review2"
    assert len(swarm.submissions()) == 1


async def test_a_lost_approval_corrected_to_changes_continues_as_a_new_workflow(client, owner):
    """(c) A lost approval: the decision is recorded and cannot be changed (no second
    decision, so no double answer); the tick posts it again (the same answer id, so one
    answer) and the run follows the approval. A different verdict recorded outside Oracle
    is still a correction (below)."""
    tenant_id, auth = owner
    swarm = on()
    run = await _waiting(client, auth, tenant_id, swarm)
    swarm.lose_next_answer = True
    resp = await _decide_raw(client, auth, run, "approved")
    assert resp.status_code == 503
    assert swarm.verdict("wf_1", "next_draft-review1") == "MERGE"
    # Decided already: a second decision is refused, never a second answer.
    again = await client.post(
        f"/v1/runs/{run['id']}/checkpoints/{pending(run)['id']}/decide",
        json={"decision": "changes_requested", "note": "Split the rollout"},
        headers=auth,
    )
    assert again.status_code == 409, again.text
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "succeeded"
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
    assert resp.status_code == 503 and "recorded" in resp.text
    run = await get(client, auth, run["id"])
    assert run["status"] == "awaiting_checkpoint" and swarm.answers == []
    await tick(client, auth)  # the recorded decision is posted
    run = await get(client, auth, run["id"])
    assert len(swarm.answers) == 1 and len(swarm.submissions()) == 1
    # Delivered; the same tick's pass then follows the workflow into round 2's wait.
    assert run["status"] == "awaiting_checkpoint"
    assert pending(run)["payload"]["wait"]["step_id"] == "next_draft-review2"


# --------------------------------------------------------------------------- labels


def _task_lookups(swarm: FakeSwarmCloud) -> list[httpx.Request]:
    return [r for r in swarm.requests if r.method == "GET" and r.url.path == "/v1/tasks"]


async def test_a_lost_submit_is_found_by_its_key(client, owner):
    _, auth = owner
    swarm = on()
    use(swarm)
    swarm.lose_next_submit = True
    run = await started(client, auth, checkpoints={"eng_dates": False})
    # Created in SwarmCloud, answer lost: found by its key, not submitted twice.
    assert len(swarm.workflows) == 1 and len(swarm.submissions()) == 1
    assert run["segments"][0]["workflow_id"] == "wf_1" and run["status"] == "running"
    # Oracle's own tasks, submitted_by alone (other filters would short the pages).
    [lookup] = _task_lookups(swarm)
    assert dict(lookup.url.params) == {"submitted_by": "me", "limit": "50"}
    # The token the lost submission carried is the run's live one.
    assert await verify_run_token(token_of(swarm)) is not None
    # Played to the end: one workflow ran, and the run was charged for it once.
    for _ in range(5):
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
    refs = _person_note(run, "CREDENTIAL_MISSING", "switched off", "switches it back on")
    assert "/v1/mcp-servers/oracle" in refs["operator_action"]


def _person_note(run: dict, code: str, *says: str) -> dict:
    """#481: the run's note for SwarmCloud's ``code``, read by a person: what happened and
    who acts, with no route, method, code or id in its text; the operator detail is in the
    note's refs. Returns those refs."""
    [ref] = [r for r in run["note_refs"] if r["refs"].get("code") == code]
    assert ref["note"] in run["notes"]
    assert wording.api_words(ref["note"]) == [] and code not in ref["note"], ref["note"]
    for words in says:
        assert words in ref["note"], ref["note"]
    return ref["refs"]


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


OLD_CREDENTIAL_MISSING = (
    "SwarmCloud parked a step with CREDENTIAL_MISSING: Oracle's MCP server is disabled there. "
    "Enable it (PATCH /v1/mcp-servers/oracle, enabled: true); the step resumes on its own."
)


def test_the_two_operator_notes_read_for_a_person_with_their_detail_in_refs():
    """protects=#481 Build 4: CREDENTIAL_MISSING and person_required, as a run's notes;
    fails_when=a note carries a route, a method or its code, its refs lose the operator
    detail, or a note stored before #481 is served as it was; no_claim=the other advice
    (tests/test_warning_wording.py scans them all)."""
    for code in ("CREDENTIAL_MISSING", "person_required"):
        note, refs = workflow.noted(workflow.ADVICE[code])
        assert note == workflow.ADVICE[code]
        assert wording.api_words(note) == [] and code not in note, note
        assert refs["code"] == code and wording.api_words(" ".join(map(str, refs.values())))
    # A note stored before #481 is served in the new words, its detail in refs.
    note, refs = workflow.noted(OLD_CREDENTIAL_MISSING)
    assert note == workflow.ADVICE["CREDENTIAL_MISSING"] and refs["code"] == "CREDENTIAL_MISSING"
    # Any other note is served as it is, with no refs.
    assert workflow.noted(workflow.ADVICE["expired"]) == (workflow.ADVICE["expired"], {})


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
    for said in seen:
        assert token not in said
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
    off = {
        "baseline_confirm": False,
        "feature_set": False,
        "eng_review": False,
        "priority_order": False,
        "eng_dates": False,
    }
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
async def test_a_failed_cancel_on_a_decision_is_finished_by_the_tick(
    client, owner, monkeypatch, path
):
    tenant_id, auth = owner
    swarm = on()
    run, decision, prefix = await _arm(client, auth, tenant_id, swarm, path, monkeypatch)
    cp = pending(run)
    token = token_of(swarm)
    if path == "closed":
        _refuse_closed(swarm)
    swarm.fail_cancels = 1
    resp = await _decide_raw(client, auth, run, decision, "Cover returns")
    assert resp.status_code == 503 and "recorded" in resp.text, resp.text
    assert swarm.cancels == ["wf_1"]  # tried, not confirmed
    assert swarm.workflows["wf_1"].state != "CANCELLED"
    # Nothing submitted after it; the decision is recorded, the run still waits.
    assert len(swarm.submissions()) == 1
    run = await get(client, auth, run["id"])
    assert run["status"] == "awaiting_checkpoint"
    assert next(c for c in run["checkpoints"] if c["id"] == cp["id"])["status"] == decision
    # The cancel's marker is kept (its tries counted): nothing Oracle drives runs in the
    # workflow any more, so its token is dead now, not when SwarmCloud confirms.
    assert (await _knobs_of(tenant_id, run["id"]))["workflow"]["cancel_pending"]["tries"] == 1
    assert await verify_run_token(token) is None
    # The tick makes the decision's calls again: the cancel is confirmed first, then the
    # run goes on.
    if path == "closed":
        _refuse_closed(swarm)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert swarm.workflows["wf_1"].state == "CANCELLED"
    if path == "stop_rest":
        assert run["status"] == "succeeded" and len(swarm.submissions()) == 1
    else:
        assert len(swarm.submissions()) == 2 and _live_with(swarm, prefix) == ["wf_2"]


async def test_a_failed_cancel_on_overrun_keeps_the_workflow_attached(client, owner):
    tenant_id, auth = owner
    swarm = on()
    use(swarm)
    off = {
        "baseline_confirm": False,
        "feature_set": False,
        "priority_order": False,
        "eng_dates": False,
    }
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
    off = {
        "feature_set": False,
        "eng_review": False,
        "priority_order": False,
        "prd_review": False,
        "eng_dates": False,
    }
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
    # The Engineering check and dates, off, ran no step: skipped, every other segment
    # from wf_1.
    ran = [s for s in run["segments"] if s["name"] not in ("eng_review", "eng_dates")]
    assert all(s["status"] == "succeeded" and s["workflow_id"] == "wf_1" for s in ran)
    assert run["segments"][2]["status"] == "skipped"
    assert run["segments"][4]["draft_import"]["version"] == 1
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
    off = {
        "baseline_confirm": False,
        "feature_set": False,
        "priority_order": False,
        "eng_dates": False,
    }
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
    assert resp.status_code == 503 and "recorded" in resp.text
    assert len(swarm.submissions()) == 1
    await tick(client, auth)
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
    off = {
        "feature_set": False,
        "eng_review": False,
        "priority_order": False,
        "prd_review": False,
        "eng_dates": False,
    }
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

    for said in ("credential_ort_abcdefgh12345", "x_po_abcdefgh12345", "id=poa_abcdefgh123"):
        assert "abcdefgh" not in _redact(said), said
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
            ("push_draft", {"doc": "w5-draft", "markdown": _draft_markdown(), "base_version": 0}),
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
    # W5 'Open waits' (owner, 2026-10-19): the open wait holds the token already.
    assert run["token_read_only"] is True
    before = await _writes(token)
    assert all("waiting for approval" in before[n] for n in ("push_draft", "import_version")), (
        before
    )
    swarm.steps_per_poll = 0  # the next segment's agents (and its wait) wait for the test
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
    # The revision (and the wait after it) runs when the test lets it: W5 holds the
    # token again once the next wait opens.
    swarm.steps_per_poll = 0
    swarm.console_answer("wf_1", "next_draft-review1", "NOT_YET", ["Add a metric"], by="x@y.z")
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["token_read_only"] is True
    async with mcp_session(token, f"{EGRESS[0]}, {LB}") as c:
        res = await c.call_tool(
            "push_draft", {"doc": "w5", "markdown": _draft_markdown(), "base_version": 0}
        )
        assert res.is_error and "waiting for approval" in res.content[0].text
    # Requesting changes (the workflow's revision runs with them): the hold ends.
    run = await decide(client, auth, run, "changes_requested", note="Add a metric")
    assert run["token_read_only"] is False and run["status"] == "running"
    async with mcp_session(token, f"{EGRESS[0]}, {LB}") as c:
        res = await c.call_tool(
            "push_draft", {"doc": "w5", "markdown": _draft_markdown(), "base_version": 0}
        )
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
    assert resp.json()["spent_usd"] == (sum(s.cost for s in swarm.workflows["wf_1"].steps) or None)


# -----------------------------------------------------------------------------
# Adapter v2 review fixes, round 6: an answer Oracle cannot read yet holds the run token
# (W5), 'Stop cancelling' keeps counting the workflow's spend (P3d), cancel() never
# reuses a lookup made for an earlier submission under the same label, and the minors.


# The same environment as test_adapter_v2 (Oracle's public URL, default timings).


# Built from pieces at runtime: no credential-shaped literal in the source.


def _wf_cost(swarm: FakeSwarmCloud, wid: str) -> float:
    return sum(s.cost for s in swarm.workflows[wid].steps)


async def _segment_art(tenant_id, run_id: str, seq: int = 1) -> dict:
    async with tenant_session(tenant_id) as s:
        seg = await s.scalar(
            select(RunSegment).where(RunSegment.run_id == uuid.UUID(run_id), RunSegment.seq == seq)
        )
        return dict(seg.artifacts or {})


# --------------------------------------------------------------------------- MAJOR 1 (W5)


@pytest.mark.parametrize("fault", ["form_502", "form_bare_404", "lagging_record"])
async def test_an_answer_oracle_cannot_read_yet_holds_the_token(client, owner, monkeypatch, fault):
    """A non-approver answers MERGE in the console; the form keeps answering 502, a bare
    404, or the record lags the step, and the workflow moves on: the token is read-only
    and the Inbox shows the run waiting to read the answer, until it is read."""
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    await _member(tenant_id, "commenter@example.com", "commenter")
    run = await _at_baseline(client, auth, swarm)
    token = token_of(swarm)
    if fault == "form_502":
        swarm.form_status = 502
    elif fault == "form_bare_404":
        swarm.form_status = 404
    else:
        swarm.lag_records = True
    swarm.console_answer("wf_1", "baseline-review1", "MERGE", by="commenter@example.com")
    for _ in range(3):
        clock.forward(service.WATCH_SECONDS + 1)
        await _tick_errors(client, auth)
    # The workflow went on past the wait (its next segment's agents ran).
    assert swarm.workflows["wf_1"].step("baseline-review1").state == "SUCCEEDED"
    run = await get(client, auth, run["id"])
    cp = pending(run)
    assert run["status"] == "awaiting_checkpoint"
    assert run["token_read_only"] is True
    assert _console(run, cp["id"])["needs"] == "unread"
    held = await _writes(token)
    for name in ("push_draft", "import_version", "propose_change"):
        assert held[name].startswith("ERROR") and "waiting for approval" in held[name], held
    assert held["get_run_output"].startswith("OK")
    [shown] = [c for c in (await _inbox(client, auth))["checkpoints"] if c["id"] == cp["id"]]
    assert shown["console"]["needs"] == "unread"
    # Read at last: the answerer is not an approver, so it still waits (W5), held.
    swarm.form_status, swarm.lag_records = None, False
    clock.forward(service.WATCH_SECONDS + 1)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert _console(run, cp["id"])["needs"] == "confirm"
    assert run["token_read_only"] is True
    # An approver decides: released.
    run = await decide(client, auth, run, "approved")
    assert run["token_read_only"] is False


@pytest.mark.parametrize("cause", ["retryable_read", "no_verdict"])
async def test_an_already_answered_post_oracle_cannot_read_holds_the_token(
    client, owner, monkeypatch, cause
):
    """The approver's Inbox post gets 409 already_answered and the recorded answer cannot
    be read (a retryable read, or no verdict on a change request): "decide again", and
    the run's token is read-only meanwhile, the run in the Inbox; once read, released."""
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    run = await _waiting(client, auth, tenant_id, swarm)
    token = token_of(swarm)
    swarm.console_answer("wf_1", "next_draft-review1", "NOT_YET", ["x"], by="stranger@x.io")
    step = swarm.workflows["wf_1"].step("next_draft-review1")
    if cause == "retryable_read":
        swarm.form_status = 502
        resp = await _decide_raw(client, auth, run, "approved")
    else:
        step.files["review1.json"] = '{"verdict": "MAYBE", "findings": []}'
        resp = await _decide_raw(client, auth, run, "changes_requested", "Add a metric")
    assert resp.status_code == 503 and "decide again" in resp.text, resp.text
    run = await get(client, auth, run["id"])
    cp = pending(run)
    assert _console(run, cp["id"])["needs"] in ("unread", "unreadable")
    assert run["token_read_only"] is True
    async with mcp_session(token, f"{EGRESS[0]}, {LB}") as c:
        res = await c.call_tool(
            "push_draft", {"doc": "w5", "markdown": _draft_markdown(), "base_version": 0}
        )
        assert res.is_error and "waiting for approval" in res.content[0].text
    assert any(c["id"] == cp["id"] for c in (await _inbox(client, auth))["checkpoints"])
    # Readable again: the approver rule applies (an approver decides: followed).
    swarm.form_status = None
    step.files["review1.json"] = '{"findings": ["x"], "verdict": "NOT_YET"}'
    clock.forward(service.WATCH_SECONDS + 1)
    run = await decide(client, auth, run, "changes_requested", note="x")
    assert run["token_read_only"] is False and run["status"] == "running"


# --------------------------------------------------------------------------- MAJOR 2 (P3d)


async def _stuck_cancel(client, auth, tenant_id, swarm, clock) -> dict:
    """A run paused on overrun whose workflow's cancel SwarmCloud answers with a bare 404
    (reads work) NOT_FOUND_TRIES times, the workflow spending all along."""
    run = await _at_baseline(client, auth, swarm)
    swarm.html_404_cancel = True
    wf = swarm.workflows["wf_1"]
    await _ceiling(tenant_id, run["id"], str(run["spent_usd"] + 0.5))
    for _ in range(service.NOT_FOUND_TRIES):
        wf.steps[0].cost += 1.0  # it keeps spending
        await _tick_errors(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "paused_overrun"
    [stuck] = (await _inbox(client, auth))["lookups"]
    assert stuck["id"] == run["id"] and "404" in stuck["stuck"]
    assert stuck["can_stop_cancelling"] is True
    return run


async def test_stop_cancelling_keeps_counting_the_spend_and_the_ceiling_still_trips(
    client, owner, monkeypatch
):
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    run = await _stuck_cancel(client, auth, tenant_id, swarm, clock)
    wf = swarm.workflows["wf_1"]
    # Resting (past the cap): the cancel call rests, the cost is still read every tick.
    cancels = len(swarm.cancels)
    wf.steps[0].cost += 1.0
    await _tick_errors(client, auth)
    run = await get(client, auth, run["id"])
    assert run["spent_usd"] == _wf_cost(swarm, "wf_1")
    assert len(swarm.cancels) == cancels
    # Stop cancelling (a short confirm in the web): the Inbox item clears, and Oracle
    # keeps reading the workflow's status and cost in the background.
    resp = await client.post(f"/v1/runs/{run['id']}/stop-cancelling", headers=auth)
    assert resp.status_code == 200, resp.text
    assert (await _inbox(client, auth))["lookups"] == []
    assert "wf_1" in (resp.json()["searching"] or "")
    entry = (await _knobs_of(tenant_id, run["id"]))["searches"][0]
    assert entry["id"] == "wf_1"
    # Round 7 (P3d, owner 2026-10-19): the run had not ended, so Stop cancelling ended it.
    assert resp.json()["status"] == "cancelled"
    # A ceiling just over the spend: the stopped workflow's spend trips it (Inbox).
    await _ceiling(tenant_id, run["id"], str(run["spent_usd"] + 0.5))
    wf.steps[0].cost += 1.0
    clock.forward(service.STUCK_LOOKUP_SECONDS + 1)
    await _tick_errors(client, auth)
    run = await get(client, auth, run["id"])
    assert run["spent_usd"] == _wf_cost(swarm, "wf_1")
    assert "ceiling" in ((await _inbox(client, auth))["lookups"][0]["stuck"] or "")
    assert len(swarm.cancels) == cancels and len(swarm.submissions()) == 1
    # Once SwarmCloud says it ended, its last cost lands and the search ends.
    wf.steps[0].cost += 1.0
    swarm._cancel(wf)
    clock.forward(service.STUCK_LOOKUP_SECONDS + 1)
    await _tick_errors(client, auth)
    run = await get(client, auth, run["id"])
    assert run["spent_usd"] == _wf_cost(swarm, "wf_1") and run["searching"] is None


async def test_stop_cancelling_a_cancelled_run_still_counts_its_spend(client, owner, monkeypatch):
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    run = await _at_baseline(client, auth, swarm)
    swarm.html_404_cancel = True
    resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=auth)
    assert resp.status_code == 200, resp.text
    wf = swarm.workflows["wf_1"]
    for _ in range(service.NOT_FOUND_TRIES):
        clock.forward(service.STUCK_LOOKUP_SECONDS + 1)
        await _tick_errors(client, auth)
    assert (await _inbox(client, auth))["lookups"][0]["can_stop_cancelling"] is True
    resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=auth)  # Stop cancelling
    assert resp.status_code == 200, resp.text
    assert (await _inbox(client, auth))["lookups"] == []
    wf.steps[0].cost += 2.0
    clock.forward(service.STUCK_LOOKUP_SECONDS + 1)
    await _tick_errors(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "cancelled" and run["spent_usd"] == _wf_cost(swarm, "wf_1")


async def test_a_plain_cancel_on_a_stuck_run_tries_one_more_cancel_first(
    client, owner, monkeypatch
):
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    run = await _stuck_cancel(client, auth, tenant_id, swarm, clock)
    swarm.html_404_cancel = False  # SwarmCloud's cancel route works again
    resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=auth)
    assert resp.status_code == 200, resp.text
    assert swarm.workflows["wf_1"].state == "CANCELLED"
    run = resp.json()
    assert run["status"] == "cancelled" and run["spent_usd"] == _wf_cost(swarm, "wf_1")
    assert (await _knobs_of(tenant_id, run["id"])).get("searches") is None


# --------------------------------------------------------------------------- MAJOR 3


async def test_cancel_never_reuses_a_lookup_of_an_earlier_submission_under_the_same_label(
    client, owner, monkeypatch
):
    """cancel() looks up the lost submission outside the row lock; meanwhile the ticker
    rules it out and resubmits under the same label, losing the answer again. Under the
    lock cancel() must not take the stale "not found" for the new submission."""
    tenant_id, auth = owner
    swarm = on()
    runtime = use(swarm)
    swarm.other_tasks = 1100
    swarm.lose_next_submit = True
    run = await started(client, auth)
    first = (await _segment_art(tenant_id, run["id"]))["lost"]
    real = runtime.find_by_label
    calls: list[str] = []

    async def find(label, since=None):
        calls.append(label)
        if len(calls) == 1:
            # cancel()'s lookup, outside the lock: the ticker runs meanwhile. The first
            # submission never landed; the ticker rules it out and submits again under
            # the same label, and that answer is lost too (its lookup inconclusive).
            del swarm.workflows["wf_1"]
            swarm.other_tasks, swarm.older_tasks = 0, 5
            swarm.lose_next_submit = True
            await tick(client, auth)
            swarm.other_tasks = 0
            return None  # true of the first submission
        if len(calls) == 3:
            # The ticker's lookup right after its own lost submission: inconclusive.
            raise RuntimeUnavailable("listing too deep", lost=True)
        return await real(label, since)

    monkeypatch.setattr(runtime, "find_by_label", find)
    resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=auth)
    assert resp.status_code == 200, resp.text
    # The ticker's resubmission, under the same label.
    assert swarm.submissions()[1]["steps"][0]["metadata"]["oracle_key"] == first["label"]
    # The resubmission is found under the lock and cancelled, its cost counted.
    assert swarm.workflows["wf_2"].state == "CANCELLED"
    run = await get(client, auth, run["id"])
    assert any(a["workflow_id"] == "wf_2" for a in run["segments"][0]["attempts"])


# --------------------------------------------------------------------------- minors


async def test_search_results_are_kept_when_the_rest_of_the_tick_fails(client, owner, monkeypatch):
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    run = await _retried(client, auth, swarm, clock)
    swarm._advance(swarm.workflows["wf_1"])
    swarm.other_tasks = 0
    clock.forward(service.STUCK_LOOKUP_SECONDS + 1)  # due for a lookup
    runtime = use(swarm)
    real = runtime.status

    async def status(workflow_id):
        if workflow_id == "wf_2":
            raise RuntimeUnavailable("SwarmCloud is unavailable", status=503)
        return await real(workflow_id)

    monkeypatch.setattr(runtime, "status", status)
    errors = await _tick_errors(client, auth)
    assert errors, "the rest of the tick failed"
    assert swarm.workflows["wf_1"].state == "CANCELLED"
    knobs = await _knobs_of(tenant_id, run["id"])
    assert not knobs.get("searches")
    run = await get(client, auth, run["id"])
    found = [a for a in run["segments"][0]["attempts"] if a["workflow_id"] == "wf_1"]
    assert found and found[0]["cost_usd"] == _wf_cost(swarm, "wf_1")


async def test_a_found_search_answered_with_bare_404s_rests_and_surfaces_in_the_inbox(
    client, owner, monkeypatch
):
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    run = await _retried(client, auth, swarm, clock)
    swarm.other_tasks = 0
    clock.forward(service.STUCK_LOOKUP_SECONDS + 1)  # due for a lookup
    swarm.html_404_ids = {"wf_1"}
    await _tick_errors(client, auth)  # found: its cancel and status bare-404
    entry = (await _knobs_of(tenant_id, run["id"]))["searches"][0]
    assert entry["id"] == "wf_1" and entry["not_found"] == 1
    # Resting between reads, not every tick.
    calls = len([r for r in swarm.requests if "wf_1" in r.url.path])
    await _tick_errors(client, auth)
    assert len([r for r in swarm.requests if "wf_1" in r.url.path]) == calls
    for _ in range(service.NOT_FOUND_TRIES - 1):
        clock.forward(service.STUCK_LOOKUP_SECONDS + 1)
        await _tick_errors(client, auth)
    [stuck] = (await _inbox(client, auth))["lookups"]
    assert stuck["id"] == run["id"] and "wf_1" in stuck["stuck"] and "404" in stuck["stuck"]


async def test_a_confirmed_cancel_with_a_gone_read_keeps_the_entry_until_its_cost_is_read(
    client, owner, monkeypatch
):
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    run = await _retried(client, auth, swarm, clock)
    swarm._advance(swarm.workflows["wf_1"])
    swarm.other_tasks = 0
    clock.forward(service.STUCK_LOOKUP_SECONDS + 1)  # due for a lookup
    swarm.gone_reads_after_cancel = 1
    await _tick_errors(client, auth)
    assert swarm.workflows["wf_1"].state == "CANCELLED"
    knobs = await _knobs_of(tenant_id, run["id"])
    assert knobs.get("searches"), "kept: its cost is not read yet"
    clock.forward(service.STUCK_LOOKUP_SECONDS + 1)
    await _tick_errors(client, auth)
    run = await get(client, auth, run["id"])
    found = [a for a in run["segments"][0]["attempts"] if a["workflow_id"] == "wf_1"]
    assert found[0]["cost_usd"] == _wf_cost(swarm, "wf_1") > 0
    assert run["searching"] is None


async def test_a_background_search_allows_slack_past_the_credentials_end(
    client, owner, monkeypatch
):
    _, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    run = await _retried(client, auth, swarm, clock)
    clock.forward(86400 + 60)  # past the credential, within the slack
    await tick(client, auth)
    assert (await get(client, auth, run["id"]))["searching"]


async def test_a_non_attach_submissions_search_is_not_bounded_by_the_run_token_ttl(
    client, owner, monkeypatch
):
    _, auth = owner
    swarm = FakeSwarmCloud()  # caller MCP off: nothing attached, no credential bound
    clock = _Clock(monkeypatch)
    run = await _retried(client, auth, swarm, clock)
    clock.forward(6 * 3600 + 60)  # past the run token's TTL
    await tick(client, auth)
    assert (await get(client, auth, run["id"]))["searching"]


async def test_a_found_search_still_running_past_its_end_is_read_until_it_ends(
    client, owner, monkeypatch
):
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    run = await _retried(client, auth, swarm, clock)
    swarm.other_tasks = 0
    clock.forward(service.STUCK_LOOKUP_SECONDS + 1)  # due for a lookup
    swarm.html_404_cancel = True  # its cancel is never confirmed; its status reads
    await _tick_errors(client, auth)
    clock.forward(86400 + 4 * 3600)
    await _tick_errors(client, auth)
    assert (await _knobs_of(tenant_id, run["id"])).get("searches")
    swarm._cancel(swarm.workflows["wf_1"])
    clock.forward(service.STUCK_LOOKUP_SECONDS + 1)
    await _tick_errors(client, auth)
    assert not (await _knobs_of(tenant_id, run["id"])).get("searches")


async def test_the_first_background_lookup_comes_on_the_next_tick_after_retry(
    client, owner, monkeypatch
):
    _, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    await _retried(client, auth, swarm, clock)
    lookups = len(_task_lookups(swarm))
    await tick(client, auth)
    assert len(_task_lookups(swarm)) > lookups


async def test_cancel_never_lowers_a_recorded_cost(client, owner, monkeypatch):
    _, auth = owner
    swarm = on()
    run = await _at_baseline(client, auth, swarm)
    spent = run["spent_usd"]
    assert spent > 0
    runtime = use(swarm)
    real = runtime.status

    async def stale(workflow_id):
        # A read older than the tick's (served by a lagging replica, say).
        return replace(await real(workflow_id), cost_usd=Decimal("0"))

    monkeypatch.setattr(runtime, "status", stale)
    resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=auth)
    assert resp.status_code == 200, resp.text
    assert resp.json()["spent_usd"] == spent


async def test_retry_rechecks_under_the_lock_before_clearing_a_stuck_lookup(
    client, owner, monkeypatch
):
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    use(swarm)
    swarm.other_tasks = 1100
    swarm.lose_next_submit = True
    run = await started(client, auth)
    clock.forward(service.LOST_LOOKUP_SECONDS + 60)
    await tick(client, auth)
    run_id = uuid.UUID(run["id"])

    async def set_lost(value):
        async with tenant_session(tenant_id) as s:
            seg = await s.scalar(
                select(RunSegment).where(RunSegment.run_id == run_id, RunSegment.seq == 1)
            )
            art = dict(seg.artifacts)
            if value is None:
                art.pop("lost")
            else:
                art["lost"] = value
            seg.artifacts = art
            await s.commit()

    lost = (await _segment_art(tenant_id, run["id"]))["lost"]
    await set_lost(None)  # what retry() reads without the lock: resolved
    real = service._get_run

    async def get_run(db, rid, *, lock=False):
        if lock:
            await set_lost(lost)  # meanwhile: unresolved again
        return await real(db, rid, lock=lock)

    monkeypatch.setattr(service, "_get_run", get_run)
    resp = await client.post(f"/v1/runs/{run['id']}/retry", headers=auth)
    assert resp.status_code == 409, resp.text
    assert (await _knobs_of(tenant_id, run["id"])).get("stuck_lookup")


async def test_advance_takes_the_current_attempt_not_the_last_listed(client, owner):
    tenant_id, auth = owner
    swarm = FakeSwarmCloud()  # one workflow per segment
    use(swarm)
    run = await started(client, auth)
    async with tenant_session(tenant_id) as s:
        # The first segment: the run has more, and an unordered read returns whichever
        # row the scan meets first (after an update, under load, not always this one).
        seg = await s.scalar(
            select(RunSegment).where(RunSegment.run_id == uuid.UUID(run["id"]), RunSegment.seq == 1)
        )
        art = dict(seg.artifacts)
        # A found earlier submission listed after the current one (a higher number).
        art["attempts"] = [
            *art["attempts"],
            {"attempt": 7, "workflow_id": "wf_9", "cost_usd": 0, "state": "cancelled"},
        ]
        seg.artifacts = art
        await s.commit()
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    cp = pending(run)
    assert cp["payload"]["attempt"] == 1
    states = {a["workflow_id"]: a["state"] for a in run["segments"][0]["attempts"]}
    assert states == {"wf_1": "succeeded", "wf_9": "cancelled"}


# --------------------------------------------------------------------------- redaction


@pytest.mark.parametrize(
    "text",
    [
        # Joined by a percent-escape that ends in a hex letter.
        "token%3Dort_" + _TAIL,
        "a%2Bort_" + _TAIL,
        "key%3Aort_" + _TAIL,
        "x%3dpo_" + _TAIL,
        # By an escaped \x0a, \b or \f.
        "line one\\x0aort_" + _TAIL,
        "line one\\bort_" + _TAIL,
        "line one\\fort_" + _TAIL,
        # The OAuth refresh and code prefixes.
        "refresh por_" + _TAIL,
        "code=poc_" + _TAIL,
        "%3Dpor_" + _TAIL,
        # Bearer with an escaped line break, or a quoted value.
        "Authorization: Bearer\\n" + "sc-" + "secret-1",
        'Authorization: Bearer "' + "sc-" + 'secret-1"',
        'Authorization: Bearer \\"' + "sc-" + 'secret-1\\"',
        # Bearer header-<letters> and token-<letters>.
        "Authorization: Bearer header-" + "secretabcdefgh",
        "Authorization: Bearer token-" + "secretabcdefgh",
    ],
)
def test_round_6_tokens_however_joined_are_redacted(text):
    from oracle.swarm.swarmcloud import _redact, redact_whole

    for fn in (_redact, redact_whole):
        out = fn(text)
        assert "abcdefgh" not in out and "secret" not in out, out
        assert "<withheld>" in out


@pytest.mark.parametrize(
    "text",
    [
        "max_po_lines_per_page",
        "write to alice_po_reviewer@corp.com",
        "bearer token-based auth",
        "Bearer token-based authentication is used",
        "the bearer header-only scheme",
        "a 100%25 portion",
        "the por_table and poc_draft names",
        "use a Bearer token",
        "support_ticket and import_policy",
    ],
)
def test_round_6_ordinary_words_are_not_withheld(text):
    from oracle.swarm.swarmcloud import _redact, redact_whole

    assert _redact(text) == text and redact_whole(text) == text


# -----------------------------------------------------------------------------
# Adapter v2 review fixes, round 7: an open checkpoint wait holds the run token from the
# moment it opens (W5, owner 2026-10-19), 'Stop cancelling' on a run that has not ended
# ends it while its workflow's spend still counts (P3d, owner 2026-10-19), and the minors
# of the round-6 review.


# The same environment as test_adapter_v2 (Oracle's public URL, default timings).


def _refused(held: dict[str, str]) -> bool:
    return all(
        held[n].startswith("ERROR") and "waiting for approval" in held[n]
        for n in ("push_draft", "import_version", "propose_change")
    )


def _allowed(held: dict[str, str]) -> bool:
    return all("waiting for approval" not in v for v in held.values())


# --------------------------------------------------------------------------- item 1 (W5)


async def test_an_open_wait_holds_the_token_until_an_answer_that_counts_is_read(
    client, owner, monkeypatch
):
    """W5 'Open waits' (owner, 2026-10-19): from the moment the workflow reaches a
    checkpoint the run token is read-only, before any answer and before Oracle's next
    tick; a non-approver's console MERGE (the workflow moves on) keeps it so, the
    60-second watch throttle included; an approver's answer read by Oracle releases it."""
    tenant_id, auth = owner
    swarm = on()
    use(swarm)
    clock = _Clock(monkeypatch)
    await _member(tenant_id, "commenter@example.com", "commenter")
    run = await started(client, auth)
    token = token_of(swarm)
    # No tick yet: SwarmCloud runs the baseline step and parks on its wait.
    held = await _writes(token)
    assert _refused(held), held
    assert held["get_run_output"].startswith("OK") or "not found" in held["get_run_output"]
    assert swarm.workflows["wf_1"].step("baseline-review1").state == "PARKED"
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "awaiting_checkpoint" and run["token_read_only"] is True
    await tick(client, auth)  # the tick's look at the wait: unanswered
    # The next segment's agents start only when the test lets them.
    swarm.steps_per_poll = 0
    # A non-approver answers MERGE inside the watch throttle: the workflow moves on, the
    # tick does not read the wait yet, and the token stays read-only.
    swarm.console_answer("wf_1", "baseline-review1", "MERGE", by="commenter@example.com")
    assert swarm.workflows["wf_1"].step("baseline-review1").state == "SUCCEEDED"
    await tick(client, auth)
    assert _refused(await _writes(token))
    assert (await get(client, auth, run["id"]))["token_read_only"] is True
    # Read: it does not count (a commenter), so it still holds.
    clock.forward(service.WATCH_SECONDS + 1)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert _console(run, pending(run)["id"])["needs"] == "confirm"
    assert run["token_read_only"] is True and _refused(await _writes(token))
    # An approver decides in the Inbox: an answer that counts, read: writable again.
    run = await decide(client, auth, run, "approved")
    assert run["token_read_only"] is False
    assert _allowed(await _writes(token))


async def test_an_approvers_console_answer_holds_until_oracle_reads_it(client, owner, monkeypatch):
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    await _member(tenant_id, "lead@example.com", "approver")
    run = await _at_baseline(client, auth, swarm)
    token = token_of(swarm)
    await tick(client, auth)  # the tick's look at the wait: unanswered
    swarm.steps_per_poll = 0
    swarm.console_answer("wf_1", "baseline-review1", "MERGE", by="lead@example.com")
    # Answered by an approver, not read yet (inside the throttle): held.
    await tick(client, auth)
    assert _refused(await _writes(token))
    # Read: it counts, the run follows it, and the token is whole again.
    clock.forward(service.WATCH_SECONDS + 1)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "running" and run["token_read_only"] is False
    assert _allowed(await _writes(token))
    # The next segment reaches its wait: held again, before any tick.
    swarm.steps_per_poll = None
    assert _refused(await _writes(token))


async def test_a_wait_answered_before_its_checkpoint_opens_is_held_through_the_import(
    client, owner, monkeypatch
):
    """The answered-before-it-opened path: _advance commits the import before it adds the
    checkpoint; the hold is in place across that commit."""
    tenant_id, auth = owner
    swarm = on()
    use(swarm)
    await _member(tenant_id, "lead@example.com", "approver")
    run = await started(client, auth)
    token = token_of(swarm)
    swarm.console_answer("wf_1", "baseline-review1", "MERGE", by="lead@example.com")
    swarm.steps_per_poll = 0
    seen: list[str | None] = []
    real = service._import_baseline

    async def spy(db, run_, text):
        # Inside _advance, after its first commit: what a token check sees now.
        async with tenant_session(tenant_id) as s:
            seen.append(await service.token_hold(s, run_.id))
        return await real(db, run_, text)

    monkeypatch.setattr(service, "_import_baseline", spy)
    await tick(client, auth)
    assert seen and seen[0] is not None, seen
    assert _refused(await _writes(token))
    run = await get(client, auth, run["id"])
    assert run["token_read_only"] is True


# --------------------------------------------------------------------------- item 2 (P3d)


@pytest.mark.parametrize("resumed", [False, True])
async def test_stop_cancelling_a_run_that_has_not_ended_ends_it_and_keeps_counting(
    client, owner, monkeypatch, resumed
):
    """P3d (owner, 2026-10-19): Stop cancelling on a run that has not ended (paused on
    overrun, or resumed and running while its cancel is still stuck) ends the run; the
    stopped workflow's status and cost are read until it ends and counted on the run,
    the ceiling still trips, and no second workflow starts for that segment."""
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    run = await _stuck_cancel(client, auth, tenant_id, swarm, clock)
    wf = swarm.workflows["wf_1"]
    if resumed:
        resp = await client.post(f"/v1/runs/{run['id']}/resume", headers=auth)
        assert resp.status_code == 200, resp.text
        assert resp.json()["status"] in ("running", "awaiting_checkpoint")
    resp = await client.post(f"/v1/runs/{run['id']}/stop-cancelling", headers=auth)
    assert resp.status_code == 200, resp.text
    run = resp.json()
    assert run["status"] == "cancelled" and run["finished_at"]
    assert "Stop cancelling" in (run["error"] or ""), run["error"]
    assert all(s["status"] not in ("running", "pending") for s in run["segments"])
    assert all(c["status"] != "pending" for c in run["checkpoints"])
    assert "wf_1" in (run["searching"] or "")
    assert (await _inbox(client, auth))["lookups"] == []
    # It ended: Resume has nothing to resume.
    resp = await client.post(f"/v1/runs/{run['id']}/resume", headers=auth)
    assert resp.status_code == 409, resp.text
    # Its cost is read on every tick (no rest), and nothing new is submitted.
    for _ in range(3):
        wf.steps[0].cost += 1.0
        await _tick_errors(client, auth)
        run = await get(client, auth, run["id"])
        assert run["spent_usd"] == _wf_cost(swarm, "wf_1")
    assert len(swarm.submissions()) == 1
    # The ceiling still trips: the overrun shows in the Inbox, with what it spent.
    await _ceiling(tenant_id, run["id"], str(run["spent_usd"] + 0.5))
    wf.steps[0].cost += 1.0
    await _tick_errors(client, auth)
    [over] = (await _inbox(client, auth))["lookups"]
    assert over["id"] == run["id"] and "ceiling" in over["stuck"] and "wf_1" in over["stuck"]
    assert (await _knobs_of(tenant_id, run["id"]))["overrun_after_end"]
    # SwarmCloud stops it: its last cost lands, the search and the Inbox item end.
    wf.steps[0].cost += 1.0
    swarm._cancel(wf)
    await _tick_errors(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "cancelled" and run["spent_usd"] == _wf_cost(swarm, "wf_1")
    assert run["searching"] is None
    # Round 8: the overrun stays in the Inbox (nothing left to cancel) until dismissed.
    [over] = (await _inbox(client, auth))["lookups"]
    assert over["cancel_again"] == [] and over["can_dismiss_overrun"] is True
    resp = await client.post(f"/v1/runs/{run['id']}/dismiss-overrun", headers=auth)
    assert resp.status_code == 200, resp.text
    assert (await _inbox(client, auth))["lookups"] == []
    assert len(swarm.submissions()) == 1


# --------------------------------------------------------------------------- minors


async def _stopped(client, auth, tenant_id, swarm, clock) -> dict:
    """A cancelled run whose workflow's cancel is stuck on bare 404s, then stopped (Cancel
    on the ended run): wf_1 still runs, on ``searches`` with ``cancel`` False."""
    run = await _at_baseline(client, auth, swarm)
    swarm.html_404_cancel = True
    resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=auth)
    assert resp.status_code == 200, resp.text
    for _ in range(service.NOT_FOUND_TRIES):
        clock.forward(service.STUCK_LOOKUP_SECONDS + 1)
        await _tick_errors(client, auth)
    resp = await client.post(f"/v1/runs/{run['id']}/stop-cancelling", headers=auth)
    assert resp.status_code == 200, resp.text
    [entry] = (await _knobs_of(tenant_id, run["id"]))["searches"]
    assert entry["id"] == "wf_1" and entry["cancel"] is False
    return resp.json()


async def test_a_stopped_workflow_is_read_on_every_tick(client, owner, monkeypatch):
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    run = await _stopped(client, auth, tenant_id, swarm, clock)
    for _ in range(2):
        swarm.workflows["wf_1"].steps[0].cost += 2.0
        await _tick_errors(client, auth)  # no clock forward: no rest between reads
        run = await get(client, auth, run["id"])
        assert run["spent_usd"] == _wf_cost(swarm, "wf_1")


async def test_a_stopped_workflow_whose_status_never_reads_shows_as_cost_unknown(
    client, owner, monkeypatch
):
    """Past the credential's end plus a step's timeout it is kept, shown in the Inbox as
    'Cost unknown for workflow ...' with the cap; only past that cap is it dropped
    (noted)."""
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    run = await _stopped(client, auth, tenant_id, swarm, clock)
    runtime = use(swarm)
    real = runtime.status

    async def status(workflow_id):
        if workflow_id == "wf_1":
            raise RuntimeUnavailable("SwarmCloud is unavailable", status=503)
        return await real(workflow_id)

    monkeypatch.setattr(runtime, "status", status)
    clock.forward(86400 + get_runtime_settings().step_seconds + 60)
    await _tick_errors(client, auth)
    assert (await _knobs_of(tenant_id, run["id"])).get("searches"), "kept"
    [item] = (await _inbox(client, auth))["lookups"]
    assert item["id"] == run["id"] and item["can_retry_lookup"] is True
    assert "Cost unknown for workflow wf_1" in item["stuck"] and "until" in item["stuck"]
    clock.forward(service.COST_UNKNOWN_SECONDS + 60)
    await _tick_errors(client, auth)
    assert not (await _knobs_of(tenant_id, run["id"])).get("searches")
    assert (await _inbox(client, auth))["lookups"] == []
    run = await get(client, auth, run["id"])
    assert any("wf_1" in n and "unknown" in n for n in run["notes"]), run["notes"]


async def test_bare_404s_on_a_stopped_workflow_offer_retry_lookup(client, owner, monkeypatch):
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    run = await _stopped(client, auth, tenant_id, swarm, clock)
    swarm.html_404_ids = {"wf_1"}
    for _ in range(service.NOT_FOUND_TRIES):
        clock.forward(service.STUCK_LOOKUP_SECONDS + 1)
        await _tick_errors(client, auth)
    [item] = (await _inbox(client, auth))["lookups"]
    assert "Cost unknown for workflow wf_1" in item["stuck"] and "404" in item["stuck"]
    assert item["can_retry_lookup"] is True
    # SwarmCloud serves it again: Retry lookup reads it now.
    swarm.html_404_ids = set()
    swarm.workflows["wf_1"].steps[0].cost += 3.0
    resp = await client.post(f"/v1/runs/{run['id']}/retry-lookup", headers=auth)
    assert resp.status_code == 200, resp.text
    assert resp.json()["spent_usd"] == _wf_cost(swarm, "wf_1")
    assert (await _inbox(client, auth))["lookups"] == []
    assert (await _knobs_of(tenant_id, run["id"]))["searches"][0]["id"] == "wf_1"


async def test_retry_lookup_needs_a_cost_unknown_workflow(client, owner):
    _, auth = owner
    use(on())
    run = await started(client, auth)
    resp = await client.post(f"/v1/runs/{run['id']}/retry-lookup", headers=auth)
    assert resp.status_code == 409, resp.text


def _label_search(at: str) -> dict:
    return {
        "label": "oracle-r-baseline-1",
        "seq": 1,
        "submitted_at": at,
        "until": "2026-10-20T10:00:00+00:00",
        "why": "cancel",
        "looked_at": None,
        "lookups": 0,
    }


def test_search_for_merges_a_stop_into_the_label_search_of_the_same_submission():
    run = Run(knobs={"searches": [_label_search("2026-10-19T10:00:00+00:00")]})
    service._search_for(
        run,
        label="oracle-r-baseline-1",
        seq=1,
        submitted_at="2026-10-19T10:00:00Z",
        until=None,
        why="stopped",
        workflow_id="wf_9",
        cancel=False,
    )
    [entry] = run.knobs["searches"]
    assert entry["id"] == "wf_9" and entry["cancel"] is False
    # And a stop on an entry known by its id.
    run = Run(knobs={"searches": [{**_label_search("2026-10-19T10:00:00+00:00"), "id": "wf_9"}]})
    service._search_for(
        run,
        label="x",
        seq=1,
        submitted_at=None,
        until=None,
        why="stopped",
        workflow_id="wf_9",
        cancel=False,
    )
    [entry] = run.knobs["searches"]
    assert entry["cancel"] is False


def test_search_for_compares_normalised_submission_times():
    run = Run(knobs={})
    for at in ("2026-10-19T10:00:00", "2026-10-19T10:00:00", "2026-10-19T10:00:00+00:00"):
        service._search_for(
            run, label="oracle-r-baseline-1", seq=1, submitted_at=at, until=None, why="retry"
        )
    assert len(run.knobs["searches"]) == 1


async def test_cancel_keeps_a_confirmed_cancel_whose_status_is_unread_on_searches(
    client, owner, monkeypatch
):
    """A running segment not on the run's live workflow: its cancel is confirmed, its
    status not read; it goes on searches, so its last cost is read and counted."""
    tenant_id, auth = owner
    swarm = FakeSwarmCloud(mcp=True)  # one workflow per segment
    use(swarm)
    swarm.steps_per_poll = 1
    run = await started(client, auth)
    await tick(client, auth)
    assert (await get(client, auth, run["id"]))["segments"][0]["status"] == "running"
    async with tenant_session(tenant_id) as s:
        r = await s.get(Run, uuid.UUID(run["id"]))
        r.knobs = {
            **r.knobs,
            # Another workflow attached as the run's (one SwarmCloud no longer knows).
            "workflow": {"id": "wf_gone", "state": "live", "start_seq": 1, "segments": []},
        }
        await s.commit()
    swarm.workflows["wf_1"].steps[0].cost += 2.0
    swarm.fail_reads_after_cancel = 1
    resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=auth)
    assert resp.status_code == 200, resp.text
    assert swarm.workflows["wf_1"].state == "CANCELLED"
    entries = (await _knobs_of(tenant_id, run["id"])).get("searches") or []
    assert [e["id"] for e in entries] == ["wf_1"], entries
    await _tick_errors(client, auth)
    run = await get(client, auth, run["id"])
    assert run["spent_usd"] == _wf_cost(swarm, "wf_1") and run["searching"] is None


async def test_a_found_searchs_confirmed_cancel_is_read_until_it_is_terminal(
    client, owner, monkeypatch
):
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    run = await _retried(client, auth, swarm, clock)
    swarm._advance(swarm.workflows["wf_1"])
    swarm.other_tasks = 0
    clock.forward(service.STUCK_LOOKUP_SECONDS + 1)  # due for a lookup
    swarm.wind_down_reads = 2
    await _tick_errors(client, auth)
    wf = swarm.workflows["wf_1"]
    assert wf.state == "CANCELLING"
    assert (await _knobs_of(tenant_id, run["id"])).get("searches"), "kept: still winding down"
    wf.steps[0].cost += 1.0  # spent while winding down
    for _ in range(3):
        await _tick_errors(client, auth)
    run = await get(client, auth, run["id"])
    found = [a for a in run["segments"][0]["attempts"] if a["workflow_id"] == "wf_1"]
    assert found[0]["cost_usd"] == _wf_cost(swarm, "wf_1")
    assert run["searching"] is None


async def test_a_confirmed_cancel_on_the_main_path_is_read_until_it_is_terminal(
    client, owner, monkeypatch
):
    tenant_id, auth = owner
    swarm = on()
    run = await _at_baseline(client, auth, swarm)
    swarm.wind_down_reads = 1
    resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=auth)
    assert resp.status_code == 200, resp.text
    assert swarm.workflows["wf_1"].state == "CANCELLING"
    swarm.workflows["wf_1"].steps[0].cost += 1.0  # spent while winding down
    for _ in range(2):
        await _tick_errors(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "cancelled"
    assert run["spent_usd"] == _wf_cost(swarm, "wf_1") and run["searching"] is None


async def test_a_later_segment_left_running_on_a_detached_workflow_is_not_counted_twice(
    client, owner
):
    tenant_id, auth = owner
    swarm = on()
    run = await _at_baseline(client, auth, swarm)
    swarm.steps_per_poll = 0
    run = await decide(client, auth, run, "approved")
    assert run["segments"][1]["status"] == "running"
    assert run["segments"][1]["workflow_id"] == "wf_1"
    async with tenant_session(tenant_id) as s:
        r = await s.get(Run, uuid.UUID(run["id"]))
        r.knobs = {**r.knobs, "workflow": {**r.knobs["workflow"], "state": "ended"}}
        await s.commit()
    swarm.workflows["wf_1"].steps[0].cost += 1.0
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["spent_usd"] == _wf_cost(swarm, "wf_1")


async def test_a_pause_over_an_unread_answer_leaves_it_for_an_approver(client, owner, monkeypatch):
    """Paused on overrun while an answer waits to be read: the workflow is cancelled, so
    the answer is never read; the Inbox asks an approver to decide instead of showing
    the run waiting forever to read it."""
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    await _member(tenant_id, "commenter@example.com", "commenter")
    run = await _at_baseline(client, auth, swarm)
    swarm.form_status = 502
    swarm.console_answer("wf_1", "baseline-review1", "MERGE", by="commenter@example.com")
    clock.forward(service.WATCH_SECONDS + 1)
    await _tick_errors(client, auth)
    run = await get(client, auth, run["id"])
    assert _console(run, pending(run)["id"])["needs"] == "unread"
    await _ceiling(tenant_id, run["id"], str(run["spent_usd"]))
    swarm.workflows["wf_1"].steps[0].cost += 1.0
    await _tick_errors(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "paused_overrun"
    console = _console(run, pending(run)["id"])
    assert console["needs"] == "unreadable" and "paused" in console["reason"]


def test_a_per_segment_attach_carries_its_submission_time():
    seg = RunSegment(
        seq=1,
        name="baseline",
        artifacts={
            "files": {},
            "notes": [],
            "attempts": [
                {"workflow_id": "wf_1", "label": "L", "submitted_at": "2026-10-19T10:00:00+00:00"}
            ],
        },
    )
    run = Run(knobs={})
    wf = service._attach_for_cancel(run, seg, "wf_1")
    assert wf["submitted_at"] == "2026-10-19T10:00:00+00:00"


async def test_a_searched_workflows_cancel_call_rests_while_its_cost_is_read_every_tick(
    client, owner, monkeypatch
):
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    run = await _retried(client, auth, swarm, clock)
    swarm.other_tasks = 0
    clock.forward(service.STUCK_LOOKUP_SECONDS + 1)  # due for a lookup
    swarm.html_404_cancel = True  # its cancel is never confirmed; its status reads
    await _tick_errors(client, auth)
    cancels = swarm.cancels.count("wf_1")
    swarm.workflows["wf_1"].steps[0].cost += 2.0
    await _tick_errors(client, auth)
    assert swarm.cancels.count("wf_1") == cancels  # the cancel call rests
    run = await get(client, auth, run["id"])
    found = [a for a in run["segments"][0]["attempts"] if a["workflow_id"] == "wf_1"]
    assert found[0]["cost_usd"] == _wf_cost(swarm, "wf_1")  # its cost read meanwhile
    clock.forward(service.STUCK_LOOKUP_SECONDS + 1)
    await _tick_errors(client, auth)
    assert swarm.cancels.count("wf_1") == cancels + 1


# -----------------------------------------------------------------------------
# Adapter v2 review fixes, round 8: 'Cancel again' on a stopped workflow over the run's
# ceiling (P3d, owner 2026-10-19), the 5-second read-only cache (W5, owner 2026-10-19),
# the run token's hold decided when a write runs (never on reads, with the database
# released before SwarmCloud is called, one bounded and shared read), the overrun on a
# search's final read, and the minors of the round-7 review.


# The same environment as test_adapter_v2 (Oracle's public URL, default timings).

FORWARDED = f"{EGRESS[0]}, {LB}"


def _reads(swarm, wid: str = "wf_1") -> int:
    """SwarmCloud status reads of workflow ``wid``."""
    return sum(
        1 for r in swarm.requests if r.method == "GET" and r.url.path == f"/v1/workflows/{wid}"
    )


async def _push(token: str, doc: str = "r8-draft") -> tuple[bool, str]:
    async with mcp_session(token, FORWARDED) as c:
        res = await c.call_tool(
            "push_draft", {"doc": doc, "markdown": _draft_markdown(), "base_version": 0}
        )
    return res.is_error, res.content[0].text


async def _audits(tenant_id, action: str) -> list[AuditEvent]:
    async with tenant_session(tenant_id) as s:
        return list(await s.scalars(select(AuditEvent).where(AuditEvent.action == action)))


# --------------------------------------------------------------------------- MAJOR 1


async def test_reads_initialize_and_tools_list_never_read_swarmcloud(client, owner):
    """The live read is made only when a write is about to run: never for initialize,
    tools/list or a read tool."""
    _, auth = owner
    swarm = on()
    use(swarm)
    await started(client, auth)
    token = token_of(swarm)
    before = _reads(swarm)
    async with mcp_session(token, FORWARDED) as c:
        await c.list_tools()
        await c.call_tool("get_run_output", {"seq": 1, "name": "summary.md"})
    assert _reads(swarm) == before


# A wall-clock ceiling for each wait of the test below: it is never reached while the
# shared read works (the test waits on events, not on the runner's speed), and only stops
# a hang from hanging CI.
CEILING = 60


async def _until(done, what, ceiling: float = CEILING) -> None:
    """Waits until ``done()``; at the ceiling fails with ``what()``, what it waited for."""
    try:
        async with asyncio.timeout(ceiling):
            while not done():
                await asyncio.sleep(0.05)
    except TimeoutError:
        raise AssertionError(f"{what()} after {ceiling} s") from None


@pytest.mark.timing
async def test_thirty_concurrent_writes_on_a_slow_status_share_one_bounded_read(
    client, owner, monkeypatch
):
    """protects=W5 (owner 2026-10-20): 30 run-token writes while SwarmCloud's status hangs
    all join ONE status read; while it hangs no database connection is held (none is
    checked out, and a cookie request is served); its deadline (HOLD_READ_SECONDS) ends
    it and every write is refused read-only ('status unknown'), with no second read.
    fails_when=a write makes a read of its own, holds a database connection over the
    read, or is not answered once the read's deadline passes.
    no_claim=how fast the runner serves 30 MCP sessions: the test waits on what happens
    (each write reaching the read, the deadline) and fires the read's real deadline
    itself, with a 60 s ceiling per wait only against a hang."""
    tenant_id, auth = owner
    swarm = on()
    runtime = use(swarm)
    run = await started(client, auth)
    token = token_of(swarm)
    cookie = await as_user(tenant_id, "owner")
    # The first MCP session of a process builds the app's OpenAPI document for the tool
    # catalog (seconds of CPU on a shared runner): built here, before the writes, as a
    # running server has it.
    async with mcp_session(token, FORWARDED) as c:
        await c.list_tools()
    monkeypatch.setattr(service, "HOLD_READ_SECONDS", 1.0, raising=False)
    # The read's deadline is the real one, made with HOLD_READ_SECONDS; the test, not
    # the runner's clock, says when it passes.
    deadlines: list[tuple[float, asyncio.Timeout]] = []

    def deadline(seconds: float) -> asyncio.Timeout:
        made = asyncio.timeout(3600)
        deadlines.append((seconds, made))
        return made

    monkeypatch.setattr(service, "_hold_deadline", deadline)
    joined = 0
    live_hold = service._live_hold

    async def counted(*a, **kw):
        nonlocal joined
        joined += 1
        return await live_hold(*a, **kw)

    monkeypatch.setattr(service, "_live_hold", counted)
    reading = asyncio.Event()
    release = asyncio.Event()
    calls = 0
    real = runtime.status

    async def slow(workflow_id):
        nonlocal calls
        calls += 1
        reading.set()
        await release.wait()
        return await real(workflow_id)

    monkeypatch.setattr(runtime, "status", slow)

    writes = [asyncio.create_task(_push(token, f"r8-{n}")) for n in range(30)]
    try:
        # A write that holds a connection over the read exhausts the pool: the others
        # never reach the read, and the wait says so.
        await _until(
            lambda: joined >= 30 and reading.is_set(),
            lambda: (
                f"{joined}/30 writes reached the status read ({calls} reads); "
                f"{get_engine().pool.checkedout()} database connections checked out"
            ),
        )
        # All 30 wait on the one read, which hangs: no connection is held over it, and a
        # cookie request is served meanwhile.
        assert calls == 1 and not any(w.done() for w in writes)
        assert get_engine().pool.checkedout() == 0
        resp = await asyncio.wait_for(client.get(f"/v1/runs/{run['id']}", headers=cookie), CEILING)
        assert resp.status_code == 200, resp.text
        assert not any(w.done() for w in writes)
        [(seconds, read_deadline)] = deadlines
        assert seconds == 1.0
        read_deadline.reschedule(asyncio.get_running_loop().time())
        results = await asyncio.wait_for(asyncio.gather(*writes), CEILING)
    finally:
        release.set()
        await asyncio.gather(*writes, return_exceptions=True)
    assert all(err and "status unknown" in said for err, said in results), results[:2]
    assert calls == 1 and joined == 30


async def test_a_wait_that_never_comes_says_what_it_waited_for():
    """A wait of the shared-read test that reaches its ceiling fails with what it
    waited for (how many writes reached the read, the connections checked out), not
    with a bare TimeoutError."""
    with pytest.raises(AssertionError, match=r"3/30 writes .* 2 database connections"):
        await _until(
            lambda: False,
            lambda: "3/30 writes reached the status read; 2 database connections checked out",
            ceiling=0.1,
        )


async def test_a_slow_status_read_times_out_to_read_only(client, owner, monkeypatch):
    _, auth = owner
    swarm = on()
    runtime = use(swarm)
    await started(client, auth)
    token = token_of(swarm)
    monkeypatch.setattr(service, "HOLD_READ_SECONDS", 0.3, raising=False)
    clock = _LoopClock(monkeypatch)

    async def hangs(workflow_id):
        clock.forward(0.3)  # the read's timeout is reached on the loop's clock, not waited
        await asyncio.sleep(5)  # ends only if the timeout does not

    monkeypatch.setattr(runtime, "status", hangs)
    err, said = await asyncio.wait_for(_push(token), 10)
    assert err and "waiting for approval" in said and "status unknown" in said


async def test_the_swarmcloud_runtime_reuses_one_http_client(monkeypatch):
    made: list[int] = []
    real = httpx.AsyncClient

    class Counting(real):  # type: ignore[misc,valid-type]
        def __init__(self, *a, **kw):
            made.append(1)
            super().__init__(*a, **kw)

    monkeypatch.setattr(httpx, "AsyncClient", Counting)
    runtime = on().runtime()
    for _ in range(3):
        with pytest.raises(RuntimeUnavailable):
            await runtime.status("wf_none")
    assert len(made) == 1


# --------------------------------------------------------------------------- MAJOR 2


async def _writable_between_waits(client, auth, tenant_id, swarm, clock) -> dict:
    """The baseline checkpoint answered by an approver and read: the run goes on, its
    next segment's agents wait for the test (the next wait is not open), writable."""
    await _member(tenant_id, "lead@example.com", "approver")
    run = await _at_baseline(client, auth, swarm)
    await tick(client, auth)
    swarm.steps_per_poll = 0
    swarm.console_answer("wf_1", "baseline-review1", "MERGE", by="lead@example.com")
    clock.forward(service.WATCH_SECONDS + 1)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "running" and run["token_read_only"] is False
    return run


async def test_a_wait_that_opens_after_the_request_starts_refuses_the_write(
    client, owner, monkeypatch
):
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    await _writable_between_waits(client, auth, tenant_id, swarm, clock)
    token = token_of(swarm)
    real = mcp_server.Catalog.call

    async def wait_opens_first(self, name, args):
        # After the request was authenticated, before its write runs: the next segment's
        # agents finish and its wait opens.
        swarm.steps_per_poll = None
        swarm._advance(swarm.workflows["wf_1"])
        assert any(s.state == "PARKED" for s in swarm.workflows["wf_1"].steps[1:])
        return await real(self, name, args)

    monkeypatch.setattr(mcp_server.Catalog, "call", wait_opens_first)
    err, said = await _push(token)
    assert err and "waiting for approval" in said, said


# --------------------------------------------------------------------------- MAJOR 3


async def test_an_overrun_on_a_stopped_workflows_final_read_is_recorded(client, owner, monkeypatch):
    """$10 ceiling, $9 spent; the stopped workflow is read at $12 as SUCCEEDED: the
    overrun is audited, noted and shown in the Inbox (no Cancel again: it ended)."""
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    run = await _stopped(client, auth, tenant_id, swarm, clock)
    await _ceiling(tenant_id, run["id"], "10")
    wf = swarm.workflows["wf_1"]
    others = _wf_cost(swarm, "wf_1") - wf.steps[0].cost
    wf.steps[0].cost = 9.0 - others
    await _tick_errors(client, auth)
    run = await get(client, auth, run["id"])
    assert run["spent_usd"] == pytest.approx(9.0)
    assert await _audits(tenant_id, "run.overrun_after_end") == []
    wf.steps[0].cost = 12.0 - others
    wf.state = "SUCCEEDED"
    await _tick_errors(client, auth)
    run = await get(client, auth, run["id"])
    assert run["spent_usd"] == pytest.approx(12.0) and run["searching"] is None
    [event] = await _audits(tenant_id, "run.overrun_after_end")
    assert event.data["ceiling_usd"] == "10"
    assert any("ceiling" in n for n in run["notes"]), run["notes"]
    [item] = (await _inbox(client, auth))["lookups"]
    assert item["id"] == run["id"] and "ceiling" in item["stuck"]
    assert item["cancel_again"] == [] and item["can_dismiss_overrun"] is True
    # Dismissed by the owner: the Inbox item goes, the record stays.
    resp = await client.post(f"/v1/runs/{run['id']}/dismiss-overrun", headers=auth)
    assert resp.status_code == 200, resp.text
    assert (await _inbox(client, auth))["lookups"] == []
    assert await _audits(tenant_id, "run.overrun_dismissed")


# --------------------------------------------------------------------------- A (P3d)


async def test_cancel_again_turns_the_cancel_calls_back_on(client, owner, monkeypatch):
    """P3d (owner, 2026-10-19): a stopped workflow whose spend passes the run's ceiling
    shows in the Inbox with its spend, the ceiling and Cancel again; Cancel again (an
    owner, or the approver who created the run) turns Oracle's cancel calls back on."""
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    run = await _stopped(client, auth, tenant_id, swarm, clock)
    await _ceiling(tenant_id, run["id"], str(run["spent_usd"] + 0.5))
    wf = swarm.workflows["wf_1"]
    wf.steps[0].cost += 1.0
    cancels = swarm.cancels.count("wf_1")
    await _tick_errors(client, auth)
    assert swarm.cancels.count("wf_1") == cancels  # stopped: no cancel call
    [item] = (await _inbox(client, auth))["lookups"]
    assert item["cancel_again"] == ["wf_1"]
    assert "ceiling" in item["stuck"] and f"${item['spent_usd']:.2f}" in item["stuck"]
    # Not the run's creator: refused.
    other = await as_user(tenant_id, "approver")
    resp = await client.post(
        f"/v1/runs/{run['id']}/cancel-again", json={"workflow_id": "wf_1"}, headers=other
    )
    assert resp.status_code == 403, resp.text
    resp = await client.post(
        f"/v1/runs/{run['id']}/cancel-again", json={"workflow_id": "wf_other"}, headers=auth
    )
    assert resp.status_code == 409, resp.text
    resp = await client.post(
        f"/v1/runs/{run['id']}/cancel-again", json={"workflow_id": "wf_1"}, headers=auth
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["cancel_again"] == []
    [event] = await _audits(tenant_id, "run.cancel_again")
    assert event.data == {"workflow_id": "wf_1"}
    assert len(swarm.submissions()) == 1  # nothing restarts
    # The cancel calls are on again: SwarmCloud takes this one.
    swarm.html_404_cancel = False
    await _tick_errors(client, auth)
    assert wf.state == "CANCELLED"
    run = await get(client, auth, run["id"])
    assert run["spent_usd"] == _wf_cost(swarm, "wf_1") and run["searching"] is None
    [item] = (await _inbox(client, auth))["lookups"]
    assert item["cancel_again"] == [] and item["can_dismiss_overrun"] is True
    assert len(swarm.submissions()) == 1


# --------------------------------------------------------------------------- B (W5)


async def test_a_read_only_answer_is_cached_for_five_seconds_and_may_write_never(
    client, owner, monkeypatch
):
    _, auth = owner
    swarm = on()
    use(swarm)
    now = [1000.0]
    monkeypatch.setattr(service, "_hold_clock", lambda: now[0], raising=False)
    swarm.steps_per_poll = 0
    await started(client, auth)
    token = token_of(swarm)
    # The wait is not reached: may write, read again for each write.
    reads = _reads(swarm)
    for n in range(2):
        err, said = await _push(token, f"r8-may-{n}")
        assert "waiting for approval" not in said, said
    assert _reads(swarm) == reads + 2
    # The wait opens: read-only, and that answer is reused for 5 seconds.
    swarm.steps_per_poll = None
    err, said = await _push(token)
    assert err and "waiting for approval" in said
    reads = _reads(swarm)
    now[0] += 4.5
    err, said = await _push(token)
    assert err and "waiting for approval" in said
    assert _reads(swarm) == reads
    now[0] += 1.0
    await _push(token)
    assert _reads(swarm) == reads + 1


# --------------------------------------------------------------------------- minors


@pytest.mark.parametrize("state", ["RUNNING", "AWAITING_INPUT", "RESUMING", "missing"])
async def test_a_review_step_reached_in_any_state_holds_the_token(
    client, owner, monkeypatch, state
):
    """Deny by default: from the moment the workflow reaches the review step, whatever
    state SwarmCloud reports it in (or no row for it), the token is read-only."""
    _, auth = owner
    swarm = on()
    runtime = use(swarm)
    swarm.steps_per_poll = 0
    await started(client, auth)
    token = token_of(swarm)
    real = runtime.status

    async def status(workflow_id):
        read = await real(workflow_id)
        steps = tuple(
            replace(s, state=state) if s.step_id == "baseline-review1" else s
            for s in read.steps
            if not (state == "missing" and s.step_id == "baseline-review1")
        )
        return replace(read, steps=steps)

    monkeypatch.setattr(runtime, "status", status)
    err, said = await _push(token)
    assert err and "waiting for approval" in said, said


async def test_a_lost_submission_holds_its_token(client, owner):
    """A submission whose answer was lost keeps its token alive (it may have landed):
    read-only until the submission is resolved."""
    _, auth = owner
    swarm = on()
    use(swarm)
    swarm.other_tasks = 1100  # the lookup does not reach it
    swarm.lose_next_submit = True
    run = await started(client, auth)
    run = await get(client, auth, run["id"])
    assert run["segments"][0]["status"] == "pending"
    token = token_of(swarm)
    err, said = await _push(token)
    assert err and "waiting for approval" in said and "status unknown" in said, said
    assert run["token_read_only"] is True


async def test_an_advance_interrupted_after_its_first_commit_recovers(client, owner, monkeypatch):
    """The import raises after _advance's first commit: the next tick opens the
    checkpoint (the import is idempotent) instead of leaving the run read-only with none."""
    tenant_id, auth = owner
    swarm = on()
    use(swarm)
    run = await started(client, auth)
    real = service._import_baseline
    calls = 0

    async def crashes_once(db, run_, body):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("import crashed")
        return await real(db, run_, body)

    monkeypatch.setattr(service, "_import_baseline", crashes_once)
    assert await _tick_errors(client, auth)
    assert "opening_wait" in await _knobs_of(tenant_id, run["id"])
    assert await _tick_errors(client, auth) == []
    run = await get(client, auth, run["id"])
    assert run["status"] == "awaiting_checkpoint" and run["waiting_on"] == "baseline_confirm"
    assert pending(run) and run["token_read_only"] is True
    assert "opening_wait" not in await _knobs_of(tenant_id, run["id"])
    assert calls == 2


async def test_the_cap_drop_is_audited_and_keeps_the_overrun(client, owner, monkeypatch):
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    run = await _stopped(client, auth, tenant_id, swarm, clock)
    # Round 9: only spend that arrives after the end is an overrun after the end.
    await _ceiling(tenant_id, run["id"], str(run["spent_usd"] + 0.5))
    swarm.workflows["wf_1"].steps[0].cost += 1.0
    runtime = use(swarm)
    real = runtime.status
    await _tick_errors(client, auth)

    async def status(workflow_id):
        if workflow_id == "wf_1":
            raise RuntimeUnavailable("SwarmCloud is unavailable", status=503)
        return await real(workflow_id)

    monkeypatch.setattr(runtime, "status", status)
    await _tick_errors(client, auth)
    assert (await _knobs_of(tenant_id, run["id"]))["overrun_after_end"]
    clock.forward(86400 + get_runtime_settings().step_seconds + 60)
    await _tick_errors(client, auth)
    clock.forward(service.COST_UNKNOWN_SECONDS + 60)
    await _tick_errors(client, auth)
    knobs = await _knobs_of(tenant_id, run["id"])
    assert not knobs.get("searches")
    assert knobs["overrun_after_end"], "the overrun mark is kept"
    [event] = await _audits(tenant_id, "run.search_dropped")
    assert event.data["workflow_id"] == "wf_1" and event.data["reason"] == "cost_unknown_cap"
    [item] = (await _inbox(client, auth))["lookups"]
    assert "ceiling" in item["stuck"] and item["cancel_again"] == []


async def _cost_unknown_stopped(client, auth, tenant_id, swarm, clock) -> dict:
    run = await _stopped(client, auth, tenant_id, swarm, clock)
    swarm.html_404_ids = {"wf_1"}
    for _ in range(service.NOT_FOUND_TRIES):
        clock.forward(service.STUCK_LOOKUP_SECONDS + 1)
        await _tick_errors(client, auth)
    [item] = (await _inbox(client, auth))["lookups"]
    assert item["can_retry_lookup"] is True
    return run


async def test_retry_lookup_reads_one_entry_outside_the_row_lock_with_a_cooldown(
    client, owner, monkeypatch
):
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    run = await _cost_unknown_stopped(client, auth, tenant_id, swarm, clock)
    # Another search on the run (a label not looked up yet): Retry lookup leaves it.
    async with tenant_session(tenant_id) as s:
        row = await s.get(Run, uuid.UUID(run["id"]))
        other = {
            "label": "oracle-other-1",
            "seq": 1,
            "submitted_at": "2026-10-19T10:00:00+00:00",
            "until": "2099-01-01T00:00:00+00:00",
            "why": "cancel",
            "looked_at": None,
            "lookups": 0,
        }
        row.knobs = {**row.knobs, "searches": [*row.knobs["searches"], other]}
        await s.commit()
    runtime = use(swarm)
    real = runtime.status
    locked: list[bool] = []

    async def status(workflow_id):
        async with tenant_session(tenant_id) as s:
            try:
                await s.execute(
                    text("SELECT id FROM runs WHERE id = :id FOR UPDATE NOWAIT"), {"id": run["id"]}
                )
                locked.append(False)
            except Exception:
                locked.append(True)
            await s.rollback()
        return await real(workflow_id)

    monkeypatch.setattr(runtime, "status", status)
    listings = sum(1 for r in swarm.requests if r.url.path == "/v1/tasks")
    resp = await client.post(f"/v1/runs/{run['id']}/retry-lookup", headers=auth)
    assert resp.status_code == 200, resp.text
    assert locked == [False]
    assert sum(1 for r in swarm.requests if r.url.path == "/v1/tasks") == listings
    entries = (await _knobs_of(tenant_id, run["id"]))["searches"]
    assert [e.get("looked_at") for e in entries if e["label"] == "oracle-other-1"] == [None]
    # A second click within 30 seconds is refused; after it, read again.
    resp = await client.post(f"/v1/runs/{run['id']}/retry-lookup", headers=auth)
    assert resp.status_code == 429, resp.text
    clock.forward(31)
    resp = await client.post(f"/v1/runs/{run['id']}/retry-lookup", headers=auth)
    assert resp.status_code == 200, resp.text
    assert len(locked) == 2


async def test_a_confirmed_cancel_stuck_cancelling_is_capped_like_cost_unknown(
    client, owner, monkeypatch
):
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    run = await _at_baseline(client, auth, swarm)
    swarm.wind_down_reads = 10**6
    resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=auth)
    assert resp.status_code == 200, resp.text
    assert swarm.workflows["wf_1"].state == "CANCELLING"
    await _tick_errors(client, auth)
    assert (await _inbox(client, auth))["lookups"] == []
    clock.forward(86400 + get_runtime_settings().step_seconds + 60)
    await _tick_errors(client, auth)
    [item] = (await _inbox(client, auth))["lookups"]
    # Round 9 (P3d 'Stuck cancels', owner 2026-10-20): its cost reads, so it is shown
    # without 'Cost unknown' and Retry lookup (it is read on every tick).
    assert item["can_retry_lookup"] is False
    assert "wf_1" in item["stuck"] and "CANCELLING" in item["stuck"], item["stuck"]
    assert "Cost unknown" not in item["stuck"], item["stuck"]
    clock.forward(service.COST_UNKNOWN_SECONDS + 60)
    await _tick_errors(client, auth)
    assert not (await _knobs_of(tenant_id, run["id"])).get("searches")
    assert (await _inbox(client, auth))["lookups"] == []
    run = await get(client, auth, run["id"])
    assert any("wf_1" in n and "CANCELLING" in n for n in run["notes"]), run["notes"]
    assert await _audits(tenant_id, "run.search_dropped")


async def test_a_confirmed_cancel_later_read_as_gone_has_ended(client, owner):
    tenant_id, auth = owner
    swarm = on()
    run = await _at_baseline(client, auth, swarm)
    swarm.wind_down_reads = 1
    resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=auth)
    assert resp.status_code == 200, resp.text
    [entry] = (await _knobs_of(tenant_id, run["id"]))["searches"]
    assert entry["cancelled"] is True
    swarm.gone_reads_after_cancel = 0
    swarm._gone_reads = 100  # SwarmCloud forgot it
    await _tick_errors(client, auth)
    # Round 9: its cost is read once more before it is taken as ended.
    assert (await _knobs_of(tenant_id, run["id"])).get("searches")
    await _tick_errors(client, auth)
    assert not (await _knobs_of(tenant_id, run["id"])).get("searches")
    assert (await _inbox(client, auth))["lookups"] == []
    run = await get(client, auth, run["id"])
    assert any("wf_1" in n and "ended" in n for n in run["notes"]), run["notes"]


def test_two_label_only_searches_merge():
    run = Run(knobs={})
    for _ in range(2):
        service._search_for(
            run, label="oracle-r-baseline-1", seq=1, submitted_at=None, until=None, why="cancel"
        )
    assert len(run.knobs["searches"]) == 1


async def test_the_hold_reason_never_carries_swarmclouds_error_text(client, owner, monkeypatch):
    """A failed live read is read-only, and agents see a fixed reason."""
    _, auth = owner
    swarm = on()
    runtime = use(swarm)
    await started(client, auth)
    token = token_of(swarm)

    async def fails(workflow_id):
        raise RuntimeUnavailable("cannot reach SwarmCloud: upstream-secret-detail-42", status=503)

    monkeypatch.setattr(runtime, "status", fails)
    err, said = await _push(token)
    assert err and "status unknown" in said and "upstream-secret-detail-42" not in said, said


async def test_a_checkpoint_hold_sends_a_fixed_reason(client, owner):
    """The MCP write refused during a hold (here: an open checkpoint wait): a fixed
    reason, not what Oracle records about the checkpoint."""
    _, auth = owner
    swarm = on()
    await _at_baseline(client, auth, swarm)
    err, said = await _push(token_of(swarm))
    assert err and "waiting for a checkpoint decision" in said, said
    assert "baseline_confirm" not in said and "SwarmCloud" not in said


# -----------------------------------------------------------------------------
# Adapter v2 review fixes, round 9: a resumed advance that keeps failing (counted,
# stopped at 5, in the Inbox with Retry, the workflow still read meanwhile), shared status
# checks share only a read-only answer (W5, owner 2026-10-20), a stuck cancel's cost is
# read and not 'unknown' (P3d), Cancel again enforced by the service, the overrun's kind,
# the shared HTTP client, and one more read after a 'gone' that follows a confirmed
# cancel.


# The same environment as test_adapter_v2 (Oracle's public URL, default timings).


async def _segment(tenant_id, run_id: str, seq: int = 1) -> RunSegment:
    async with tenant_session(tenant_id) as s:
        return await s.scalar(
            select(RunSegment).where(RunSegment.run_id == uuid.UUID(run_id), RunSegment.seq == seq)
        )


async def _user(tenant_id, role: str) -> tuple[uuid.UUID, dict[str, str]]:
    """A member of ``role`` and their session cookie."""
    async with tenant_session(tenant_id) as s:
        user = await create_user(s, f"{role}-{uuid.uuid4().hex[:6]}@example.com", "pw")
        user.role = role
        await s.commit()
    return user.id, {"Cookie": f"{get_settings().session_cookie_name}={make_session_cookie(user)}"}


async def _created_by(tenant_id, run_id: str, user_id: uuid.UUID) -> None:
    async with tenant_session(tenant_id) as s:
        row = await s.get(Run, uuid.UUID(run_id))
        row.created_by = user_id
        await s.commit()


async def _other_tenant_owner() -> dict[str, str]:
    return await as_user(await make_tenant("Other Co"), "owner")


# --------------------------------------------------------------------------- item 1


class _ImportFails:
    """baseline.yaml's import raises every time (an error none of the import's own
    refusals covers), with agent content in its message."""

    def __init__(self, monkeypatch) -> None:
        self.calls = 0
        self.real = service._import_baseline
        self.failing = True
        monkeypatch.setattr(service, "_import_baseline", self)

    async def __call__(self, db, run, text):
        self.calls += 1
        if self.failing:
            raise ValueError("agent wrote: secret-agent-content-77")
        return await self.real(db, run, text)


async def _interrupted(client, auth, monkeypatch, swarm) -> tuple[dict, _ImportFails]:
    """A run whose advance raised in its import after the first commit."""
    use(swarm)
    run = await started(client, auth)
    fails = _ImportFails(monkeypatch)
    assert await _tick_errors(client, auth)
    assert fails.calls == 1
    return run, fails


async def test_a_resume_that_keeps_failing_stops_at_five_and_still_reads_the_workflow(
    client, owner, monkeypatch
):
    tenant_id, auth = owner
    swarm = on()
    run, fails = await _interrupted(client, auth, monkeypatch, swarm)
    for n in range(1, service.RESUME_TRIES + 1):
        swarm.workflows["wf_1"].steps[0].cost += 1.0  # spent meanwhile
        errors = await _tick_errors(client, auth)
        assert errors and all("secret-agent-content" not in e for e in errors), errors
        assert fails.calls == 1 + n
        got = await get(client, auth, run["id"])
        assert got["spent_usd"] == pytest.approx(_wf_cost(swarm, "wf_1")), n
        seg = await _segment(tenant_id, run["id"])
        attempt = seg.artifacts["attempts"][-1]
        assert attempt["resume_failures"]["count"] == n
        assert attempt["resume_failures"]["error"] == "ValueError"
        assert attempt["resume_failures"]["at"]
    # Stopped: no more tries, the step failed with a clear reason, in the owners' Inbox.
    await _tick_errors(client, auth)
    assert fails.calls == 1 + service.RESUME_TRIES
    got = await get(client, auth, run["id"])
    seg = got["segments"][0]
    assert seg["status"] == "failed" and "ValueError" in (seg["error"] or ""), seg
    assert "secret-agent-content" not in str(got)
    [item] = (await _inbox(client, auth))["imports"]
    assert item["id"] == run["id"] and item["can_retry_import"] is True
    assert (
        item["import_failed"].startswith("Couldn't import")
        and "ValueError" in (item["import_failed"])
    )
    assert "secret-agent-content" not in item["import_failed"]
    assert await _audits(tenant_id, "run.import_failed")
    # Approvers do not see it (an owner's Retry).
    lead = await as_user(tenant_id, "approver")
    assert (await _inbox(client, lead))["imports"] == []


async def test_a_failing_resume_does_not_skip_the_ceiling(client, owner, monkeypatch):
    tenant_id, auth = owner
    swarm = on()
    run, _ = await _interrupted(client, auth, monkeypatch, swarm)
    await _ceiling(tenant_id, run["id"], "0.01")
    swarm.workflows["wf_1"].steps[0].cost += 5.0
    await _tick_errors(client, auth)
    got = await get(client, auth, run["id"])
    assert got["status"] == "paused_overrun", got["status"]


async def test_a_failing_resume_is_tried_and_counted_once_per_tick(client, owner, monkeypatch):
    """PR #128 minor: the pass that pauses on the ceiling cancels the workflow (a runtime
    call), so it runs again (_replay): the resumed advance is not tried again in that
    tick, and its failure is counted once, its error reported once."""
    tenant_id, auth = owner
    swarm = on()
    run, fails = await _interrupted(client, auth, monkeypatch, swarm)
    await _ceiling(tenant_id, run["id"], "0.01")
    swarm.workflows["wf_1"].steps[0].cost += 5.0
    errors = await _tick_errors(client, auth)
    assert (await get(client, auth, run["id"]))["status"] == "paused_overrun"
    seg = await _segment(tenant_id, run["id"])
    assert seg.artifacts["attempts"][-1]["resume_failures"]["count"] == 1
    assert fails.calls == 2
    assert len([e for e in errors if "importing" in e]) == 1, errors


async def test_a_failing_resume_does_not_skip_a_workflow_that_ended(client, owner, monkeypatch):
    _, auth = owner
    swarm = on()
    run, _ = await _interrupted(client, auth, monkeypatch, swarm)
    wf = swarm.workflows["wf_1"]
    wf.state = "FAILED"
    await _tick_errors(client, auth)
    got = await get(client, auth, run["id"])
    assert got["status"] == "failed", got["status"]


async def test_retry_import_is_an_owners_audited_and_resets_the_count(client, owner, monkeypatch):
    tenant_id, auth = owner
    swarm = on()
    run, fails = await _interrupted(client, auth, monkeypatch, swarm)
    for _ in range(service.RESUME_TRIES):
        await _tick_errors(client, auth)
    url = f"/v1/runs/{run['id']}/retry-import"
    # Owners only: not even an approver who created the run; another tenant's run is
    # not found.
    lead_id, lead = await _user(tenant_id, "approver")
    await _created_by(tenant_id, run["id"], lead_id)
    assert (await client.post(url, headers=lead)).status_code == 403
    assert (await client.post(url, headers=await _other_tenant_owner())).status_code == 404
    fails.failing = False
    resp = await client.post(url, headers=auth)
    assert resp.status_code == 200, resp.text
    assert await _audits(tenant_id, "run.import_retried")
    seg = await _segment(tenant_id, run["id"])
    assert seg.status == "succeeded" and "resume_failures" not in seg.artifacts["attempts"][-1]
    assert (await _inbox(client, auth))["imports"] == []
    # A second Retry has nothing to do.
    assert (await client.post(url, headers=auth)).status_code == 409
    await _tick_errors(client, auth)
    got = await get(client, auth, run["id"])
    assert got["status"] == "awaiting_checkpoint" and got["waiting_on"] == "baseline_confirm"


async def test_retry_import_resets_the_count_to_five_more_tries(client, owner, monkeypatch):
    tenant_id, auth = owner
    swarm = on()
    run, fails = await _interrupted(client, auth, monkeypatch, swarm)
    for _ in range(service.RESUME_TRIES):
        await _tick_errors(client, auth)
    resp = await client.post(f"/v1/runs/{run['id']}/retry-import", headers=auth)
    assert resp.status_code == 200, resp.text
    before = fails.calls
    await _tick_errors(client, auth)
    assert fails.calls == before + 1
    seg = await _segment(tenant_id, run["id"])
    assert seg.status == "succeeded"
    assert seg.artifacts["attempts"][-1]["resume_failures"]["count"] == 1


async def test_importing_baseline_again_makes_no_second_proposal_for_a_locked_item(client, owner):
    """A resume imports baseline.yaml again: a locked item it would change gets one
    proposal, not one per try."""
    from oracle.baseline.models import Entity, Proposal

    tenant_id, auth = owner
    use(on())
    run = await started(client, auth)
    first = "version: 1\nentities:\n  - type: feature\n    key: f1\n    title: First\nedges: []\n"
    async with tenant_session(tenant_id) as s:
        row = await s.get(Run, uuid.UUID(run["id"]))
        assert "error" not in await service._import_baseline(s, row, first)
        entity = await s.scalar(select(Entity))
        entity.locked = True
        await s.commit()
        for _ in range(3):
            out = await service._import_baseline(s, row, first.replace("First", "Second"))
            assert out.get("proposals") == 1, out
        proposals = list(await s.scalars(select(Proposal)))
    assert len(proposals) == 1


# --------------------------------------------------------------------------- item 2


# The one review step state that leaves the token writable (its predecessor ``w1``
# running): PARKED on its dependencies.
_DEP = "DEPENDENCY_INCOMPLETE"


class _Status:
    """A runtime whose status reads are counted; the first waits for ``gate``. Review
    step ``r1`` reads ``state`` (:data:`_DEP`: parked on its dependencies), after its
    predecessor ``w1``, running."""

    def __init__(self, state: str) -> None:
        self.state = state
        self.calls = 0
        self.gate = asyncio.Event()

    async def status(self, workflow_id):
        self.calls += 1
        if self.calls == 1:
            await self.gate.wait()
        review = (
            StepStatus("r1", "t1", "PARKED", park_reason=_DEP, task_read=True)
            if self.state == _DEP
            else StepStatus("r1", "t1", self.state, task_read=True)
        )
        return WorkflowStatus(
            "running", steps=(StepStatus("w1", "t0", "RUNNING", task_read=True), review)
        )


@pytest.fixture
def hold_runtime(monkeypatch):
    service._hold_cache.clear()
    service._hold_reads.clear()

    def make(state: str) -> _Status:
        runtime = _Status(state)
        monkeypatch.setattr(service, "get_runtime", lambda: runtime)
        return runtime

    yield make
    service._hold_cache.clear()
    service._hold_reads.clear()


async def test_a_joiner_on_a_may_write_check_reads_for_itself(hold_runtime):
    runtime = hold_runtime(_DEP)
    key = (uuid.uuid4(), "wf_x", (("r1", "w1"),))
    first = asyncio.create_task(service._live_hold(*key))
    await asyncio.sleep(0.01)
    joiners = [asyncio.create_task(service._live_hold(*key)) for _ in range(3)]
    await asyncio.sleep(0.01)
    assert runtime.calls == 1, "the joiners wait on the check in flight"
    runtime.gate.set()
    assert await first is None
    assert await asyncio.gather(*joiners) == [None, None, None]
    # The first used its own answer; each joiner made its own read.
    assert runtime.calls == 4


async def test_a_read_only_check_refuses_every_joiner_without_another_read(hold_runtime):
    runtime = hold_runtime("RUNNING")
    key = (uuid.uuid4(), "wf_x", (("r1", "w1"),))
    first = asyncio.create_task(service._live_hold(*key))
    await asyncio.sleep(0.01)
    joiners = [asyncio.create_task(service._live_hold(*key)) for _ in range(3)]
    await asyncio.sleep(0.01)
    runtime.gate.set()
    answers = [await first, *await asyncio.gather(*joiners)]
    assert answers == [service.HOLD_DECISION] * 4
    assert runtime.calls == 1
    # Cached for 5 seconds: a later request is refused without a read too.
    assert await service._live_hold(*key) == service.HOLD_DECISION
    assert runtime.calls == 1


# --------------------------------------------------------------------------- minors (W5)


async def test_the_hold_cache_does_not_leak_across_runs(hold_runtime):
    runtime = hold_runtime("RUNNING")
    runtime.gate.set()
    one = (uuid.uuid4(), "wf_1", (("r1", "w1"),))
    assert await service._live_hold(*one) == service.HOLD_DECISION
    runtime.state = _DEP
    # Another run on a workflow of the same id and review steps: its own read.
    other = (uuid.uuid4(), "wf_1", (("r1", "w1"),))
    assert await service._live_hold(*other) is None
    assert runtime.calls == 2
    assert await service._live_hold(*one) == service.HOLD_DECISION  # still cached
    assert runtime.calls == 2


async def test_expired_hold_answers_are_pruned_on_reads_too(hold_runtime, monkeypatch):
    runtime = hold_runtime("RUNNING")
    runtime.gate.set()
    now = [1000.0]
    monkeypatch.setattr(service, "_hold_clock", lambda: now[0])
    old = (uuid.uuid4(), "wf_1", (("r1", "w1"),))
    await service._live_hold(*old)
    assert old in service._hold_cache
    now[0] += service.HOLD_CACHE_SECONDS + 1
    fresh = (uuid.uuid4(), "wf_2", (("r1", "w1"),))
    service._hold_cache[fresh] = (now[0], service.HOLD_DECISION)
    # Served from the cache (no read), and the expired answer is gone.
    assert await service._live_hold(*fresh) == service.HOLD_DECISION
    assert runtime.calls == 1
    assert old not in service._hold_cache


def test_no_list_of_step_states_leaves_the_token_writable():
    # W5 structural rule (owner 2026-10-20): PENDING and SKIPPED no longer release.
    from oracle.swarm import runtime as swarm_runtime

    assert not hasattr(swarm_runtime, "NOT_REACHED_STATES")
    assert not hasattr(service, "_NOT_REACHED")


@pytest.mark.parametrize(
    "state",
    [_DEP, "PENDING", "SKIPPED", "RUNNING", "PARKED", "SUCCEEDED", "FAILED", "CANCELLED", "NEW"],
)
async def test_only_a_dependency_park_leaves_the_token_writable(hold_runtime, state):
    runtime = hold_runtime(state)
    runtime.gate.set()
    held = await service._live_hold(uuid.uuid4(), "wf_1", (("r1", "w1"),))
    assert (held is None) == (state == _DEP), held


async def _curated_writes(token: str) -> dict[str, tuple[bool, str]]:
    out = {}
    async with mcp_session(token, f"{EGRESS[0]}, {LB}") as c:
        for name, args in (
            ("push_draft", {"doc": "r9-held", "markdown": _draft_markdown(), "base_version": 0}),
            ("propose_change", {"body": {"op": "add", "kind": "goal", "data": {"key": "g9"}}}),
        ):
            res = await c.call_tool(name, args)
            out[name] = (res.is_error, res.content[0].text)
    return out


@pytest.mark.parametrize("why", ["open_checkpoint", "review_reached"])
async def test_curated_writes_are_refused_while_held_and_write_nothing(
    client, owner, monkeypatch, why
):
    from dataclasses import replace

    from oracle.baseline.models import Proposal
    from oracle.docs.models import Document

    tenant_id, auth = owner
    swarm = on()
    if why == "open_checkpoint":
        await _at_baseline(client, auth, swarm)
    else:
        # Oracle has not looked yet; the live read finds the review step reached.
        runtime = use(swarm)
        swarm.steps_per_poll = 0
        await started(client, auth)
        real = runtime.status

        async def status(workflow_id):
            read = await real(workflow_id)
            steps = tuple(
                replace(s, state="PARKED", park_reason=None)
                if s.step_id == "baseline-review1"
                else s
                for s in read.steps
            )
            return replace(read, steps=steps)

        monkeypatch.setattr(runtime, "status", status)
    out = await _curated_writes(token_of(swarm))
    for name, (err, said) in out.items():
        assert err and "waiting for approval" in said, (name, said)
    async with tenant_session(tenant_id) as s:
        assert await s.scalar(select(Document).where(Document.slug == "r9-held")) is None
        assert list(await s.scalars(select(Proposal))) == []


# --------------------------------------------------------------------------- item 3


async def test_a_stuck_cancel_is_not_cost_unknown_while_its_cost_reads(client, owner, monkeypatch):
    """P3d 'Stuck cancels' (owner, 2026-10-20): a confirmed cancel that keeps reading
    CANCELLING is dropped after 3 days with a note; until then its cost is read and
    counted, never labelled 'cost unknown'. Only a failed read makes it unknown."""
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    run = await _at_baseline(client, auth, swarm)
    swarm.wind_down_reads = 10**6
    resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=auth)
    assert resp.status_code == 200, resp.text
    await _tick_errors(client, auth)
    clock.forward(86400 + get_runtime_settings().step_seconds + 60)
    swarm.workflows["wf_1"].steps[0].cost += 2.0  # spent while winding down
    await _tick_errors(client, auth)
    got = await get(client, auth, run["id"])
    assert got["spent_usd"] == pytest.approx(_wf_cost(swarm, "wf_1"))
    assert got["can_retry_lookup"] is False
    assert "Cost unknown" not in (got["stuck"] or ""), got["stuck"]
    [entry] = (await _knobs_of(tenant_id, run["id"]))["searches"]
    assert not entry.get("cost_unknown"), entry
    items = (await _inbox(client, auth))["lookups"]
    assert all("Cost unknown" not in (i["stuck"] or "") for i in items), items
    # A read that fails: now its cost is unknown.
    runtime = use(swarm)
    real = runtime.status

    async def fails(workflow_id):
        raise RuntimeUnavailable("SwarmCloud is unavailable", status=503)

    monkeypatch.setattr(runtime, "status", fails)
    await _tick_errors(client, auth)
    got = await get(client, auth, run["id"])
    assert got["can_retry_lookup"] is True and "Cost unknown" in got["stuck"], got["stuck"]
    # It reads again: counted, and no longer unknown.
    monkeypatch.setattr(runtime, "status", real)
    clock.forward(service.STUCK_LOOKUP_SECONDS + 1)
    swarm.workflows["wf_1"].steps[0].cost += 1.0
    await _tick_errors(client, auth)
    got = await get(client, auth, run["id"])
    assert got["spent_usd"] == pytest.approx(_wf_cost(swarm, "wf_1"))
    assert "Cost unknown" not in (got["stuck"] or ""), got["stuck"]
    # Dropped at the cap, with a note on the run.
    clock.forward(service.COST_UNKNOWN_SECONDS + 60)
    await _tick_errors(client, auth)
    assert not (await _knobs_of(tenant_id, run["id"])).get("searches")
    got = await get(client, auth, run["id"])
    assert any("wf_1" in n and "CANCELLING" in n for n in got["notes"]), got["notes"]


# --------------------------------------------------------------------------- item 4


async def _over_after_stop(client, auth, tenant_id, swarm, clock) -> dict:
    """A cancelled run whose workflow wf_1 was stopped (Stop cancelling) and whose spend
    then passed its ceiling: the overrun is recorded, Cancel again is offered."""
    run = await _stopped(client, auth, tenant_id, swarm, clock)
    await _ceiling(tenant_id, run["id"], str(run["spent_usd"] + 0.5))
    swarm.workflows["wf_1"].steps[0].cost += 1.0
    await _tick_errors(client, auth)
    got = await get(client, auth, run["id"])
    assert got["cancel_again"] == ["wf_1"], got["cancel_again"]
    return got


async def _again(client, headers, run_id: str, wid: str = "wf_1"):
    return await client.post(
        f"/v1/runs/{run_id}/cancel-again", json={"workflow_id": wid}, headers=headers
    )


async def _edit_run(tenant_id, run_id: str, **changes) -> None:
    async with tenant_session(tenant_id) as s:
        row = await s.get(Run, uuid.UUID(run_id))
        knobs = dict(row.knobs or {})
        for key, value in changes.pop("knobs", {}).items():
            if value is None:
                knobs.pop(key, None)
            else:
                knobs[key] = value
        row.knobs = knobs
        for key, value in changes.items():
            setattr(row, key, value)
        await s.commit()


@pytest.mark.parametrize("case", ["no_overrun", "dismissed", "not_ended", "not_stopped"])
async def test_cancel_again_is_refused_unless_the_ui_would_offer_it(
    client, owner, monkeypatch, case
):
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    run = await _over_after_stop(client, auth, tenant_id, swarm, clock)
    knobs = await _knobs_of(tenant_id, run["id"])
    if case == "no_overrun":
        await _edit_run(tenant_id, run["id"], knobs={"overrun_after_end": None})
    elif case == "dismissed":
        over = {**knobs["overrun_after_end"], "dismissed_at": "2026-10-20T10:00:00+00:00"}
        await _edit_run(tenant_id, run["id"], knobs={"overrun_after_end": over})
    elif case == "not_ended":
        await _edit_run(tenant_id, run["id"], status="running", finished_at=None)
    else:
        searches = [{**e, "cancel": True} for e in knobs["searches"]]
        await _edit_run(tenant_id, run["id"], knobs={"searches": searches})
    resp = await _again(client, auth, run["id"])
    assert resp.status_code == 409, resp.text
    assert await _audits(tenant_id, "run.cancel_again") == []
    entries = (await _knobs_of(tenant_id, run["id"]))["searches"]
    assert not any(e.get("cancel_again_at") for e in entries)


async def test_cancel_again_who_and_which_run(client, owner, monkeypatch):
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    run = await _over_after_stop(client, auth, tenant_id, swarm, clock)
    # An approver who did not create the run: refused; another tenant: not found.
    _, lead = await _user(tenant_id, "approver")
    assert (await _again(client, lead, run["id"])).status_code == 403
    assert (await _again(client, await _other_tenant_owner(), run["id"])).status_code == 404
    # Another run's workflow (the run is otherwise eligible): refused.
    assert (await _again(client, auth, run["id"], "wf_2")).status_code == 409
    # The approver who created it may; a second call has no second effect.
    creator_id, creator = await _user(tenant_id, "approver")
    await _created_by(tenant_id, run["id"], creator_id)
    resp = await _again(client, creator, run["id"])
    assert resp.status_code == 200, resp.text
    notes = len((await get(client, auth, run["id"]))["notes"])
    resp = await _again(client, creator, run["id"])
    assert resp.status_code == 409, resp.text
    assert len(await _audits(tenant_id, "run.cancel_again")) == 1
    assert len((await get(client, auth, run["id"]))["notes"]) == notes


# --------------------------------------------------------------------------- item 5


async def test_an_overrun_from_before_the_end_is_not_recorded_as_after_the_end(
    client, owner, monkeypatch
):
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    run = await _at_baseline(client, auth, swarm)
    # Over its ceiling before it ends: cancelled before a tick pauses it.
    await _ceiling(tenant_id, run["id"], str(run["spent_usd"] - 0.5))
    swarm.html_404_cancel = True
    resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=auth)
    assert resp.status_code == 200, resp.text
    for _ in range(service.NOT_FOUND_TRIES):
        clock.forward(service.STUCK_LOOKUP_SECONDS + 1)
        await _tick_errors(client, auth)
    resp = await client.post(f"/v1/runs/{run['id']}/stop-cancelling", headers=auth)
    assert resp.status_code == 200, resp.text
    await _tick_errors(client, auth)  # the stopped workflow read: nothing new spent
    assert "overrun_after_end" not in await _knobs_of(tenant_id, run["id"])
    assert await _audits(tenant_id, "run.overrun_after_end") == []
    # Spend that arrives after the end is recorded, saying it was over already.
    swarm.workflows["wf_1"].steps[0].cost += 1.0
    await _tick_errors(client, auth)
    over = (await _knobs_of(tenant_id, run["id"]))["overrun_after_end"]
    assert float(over["spent_usd"]) == pytest.approx(_wf_cost(swarm, "wf_1"))
    got = await get(client, auth, run["id"])
    assert any("already" in n and "when it ended" in n for n in got["notes"]), got["notes"]


async def test_a_dismissed_overrun_does_not_block_a_new_one(client, owner, monkeypatch):
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    run = await _over_after_stop(client, auth, tenant_id, swarm, clock)
    knobs = await _knobs_of(tenant_id, run["id"])
    first = knobs["overrun_after_end"]
    dismissed = {**first, "dismissed_at": "2026-10-20T10:00:00+00:00"}
    await _edit_run(tenant_id, run["id"], knobs={"overrun_after_end": dismissed})
    # No new spend: nothing new is recorded.
    await _tick_errors(client, auth)
    assert (await _knobs_of(tenant_id, run["id"]))["overrun_after_end"] == dismissed
    # Spend grows past the last recorded amount: recorded again, shown again.
    swarm.workflows["wf_1"].steps[0].cost += 1.0
    await _tick_errors(client, auth)
    over = (await _knobs_of(tenant_id, run["id"]))["overrun_after_end"]
    assert not over.get("dismissed_at")
    assert float(over["spent_usd"]) > float(first["spent_usd"])
    assert len(await _audits(tenant_id, "run.overrun_after_end")) == 2
    got = await get(client, auth, run["id"])
    assert got["cancel_again"] == ["wf_1"]


# --------------------------------------------------------------------------- item 6


def _runtime_on(handler) -> SwarmCloudRuntime:
    return SwarmCloudRuntime(
        "https://swarm.test", StaticBearer("sc-bearer"), transport=httpx.MockTransport(handler)
    )


async def test_a_pool_timeout_never_left_so_it_is_not_lost():
    def handler(request):
        raise httpx.PoolTimeout("no connection free in the pool")

    with pytest.raises(RuntimeUnavailable) as caught:
        await _runtime_on(handler).status("wf_1")
    assert caught.value.lost is False and caught.value.retryable


async def test_a_submit_stuck_in_the_pool_is_not_lost_and_holds_nothing(client, owner, monkeypatch):
    tenant_id, auth = owner
    swarm = on()
    pool_timeouts = 1

    def handler(request):
        nonlocal pool_timeouts
        if request.method == "POST" and request.url.path == "/v1/workflows" and pool_timeouts:
            pool_timeouts -= 1
            raise httpx.PoolTimeout("no connection free in the pool")
        return swarm(request)

    runtime = swarm.runtime()
    runtime._transport = httpx.MockTransport(handler)
    set_runtime(runtime)
    run = await started(client, auth)
    seg = await _segment(tenant_id, run["id"])
    assert seg.status == "pending" and "lost" not in (seg.artifacts or {}), seg.artifacts
    got = await get(client, auth, run["id"])
    assert got["token_read_only"] is False
    assert not (await _inbox(client, auth))["lookups"]


async def test_cookies_are_not_shared_across_calls():
    seen: list[str | None] = []

    def handler(request):
        seen.append(request.headers.get("cookie"))
        return httpx.Response(
            404, json={"error": "not_found"}, headers={"set-cookie": "sticky=1; Path=/"}
        )

    runtime = _runtime_on(handler)
    for _ in range(2):
        with pytest.raises(RuntimeUnavailable):
            await runtime.status("wf_1")
    assert seen == [None, None]


def test_the_old_client_is_closed_when_the_event_loop_changes():
    def handler(request):
        return httpx.Response(404, json={"error": "not_found"})

    runtime = _runtime_on(handler)
    clients = []

    async def call():
        with pytest.raises(RuntimeUnavailable):
            await runtime.status("wf_1")
        clients.append(runtime._http)

    asyncio.run(call())
    asyncio.run(call())
    assert clients[0] is not clients[1]
    assert clients[0].is_closed and not clients[1].is_closed


# --------------------------------------------------------------------------- item 7


async def _cancel(client, auth, run) -> None:
    resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=auth)
    assert resp.status_code == 200, resp.text


async def test_gone_right_after_a_confirmed_cancel_reads_the_cost_once_more(client, owner):
    tenant_id, auth = owner
    swarm = on()
    run = await _at_baseline(client, auth, swarm)
    swarm.gone_reads_after_cancel = 1  # the read right after the cancel: 404 not_found
    await _cancel(client, auth, run)
    swarm.workflows["wf_1"].steps[0].cost += 1.0  # spent before the cancel took
    await _tick_errors(client, auth)
    got = await get(client, auth, run["id"])
    assert got["spent_usd"] == pytest.approx(_wf_cost(swarm, "wf_1"))
    assert not (await _knobs_of(tenant_id, run["id"])).get("searches")


async def test_gone_on_a_searched_cancelled_workflow_reads_once_more_even_if_costed(client, owner):
    tenant_id, auth = owner
    swarm = on()
    run = await _at_baseline(client, auth, swarm)
    swarm.wind_down_reads = 1
    await _cancel(client, auth, run)
    [entry] = (await _knobs_of(tenant_id, run["id"]))["searches"]
    assert entry["cancelled"] and entry["costed"]
    swarm._gone_reads = 1
    swarm.workflows["wf_1"].steps[0].cost += 1.0
    await _tick_errors(client, auth)
    assert (await _knobs_of(tenant_id, run["id"])).get("searches"), "read once more"
    await _tick_errors(client, auth)
    got = await get(client, auth, run["id"])
    assert got["spent_usd"] == pytest.approx(_wf_cost(swarm, "wf_1"))
    assert not (await _knobs_of(tenant_id, run["id"])).get("searches")


async def test_gone_on_the_ticks_read_after_a_confirmed_cancel_reads_once_more(client, owner):
    tenant_id, auth = owner
    swarm = on()
    run = await _at_baseline(client, auth, swarm)
    swarm.fail_reads_after_cancel = 1  # confirmed, its last cost not read
    await _cancel(client, auth, run)
    assert (await _knobs_of(tenant_id, run["id"]))["workflow"]["cancel_pending"]["confirmed"]
    swarm._gone_reads = 1
    swarm.workflows["wf_1"].steps[0].cost += 1.0
    await _tick_errors(client, auth)
    await _tick_errors(client, auth)
    got = await get(client, auth, run["id"])
    assert got["spent_usd"] == pytest.approx(_wf_cost(swarm, "wf_1"))
    assert not (await _knobs_of(tenant_id, run["id"])).get("searches")


async def test_a_failed_read_after_gone_follows_the_cost_unknown_rules(client, owner, monkeypatch):
    tenant_id, auth = owner
    swarm = on()
    run = await _at_baseline(client, auth, swarm)
    swarm.gone_reads_after_cancel = 1
    await _cancel(client, auth, run)
    runtime = use(swarm)

    async def fails(workflow_id):
        raise RuntimeUnavailable("SwarmCloud is unavailable", status=503)

    monkeypatch.setattr(runtime, "status", fails)
    await _tick_errors(client, auth)
    [entry] = (await _knobs_of(tenant_id, run["id"]))["searches"]
    assert entry["id"] == "wf_1" and entry["unread"] == 1, entry


def test_retrying_a_pending_cancel_is_not_named_like_cancel_again():
    """The tick's retry of a cancel SwarmCloud has not confirmed is not the Inbox's
    Cancel again (service.cancel_again)."""
    assert callable(service._retry_pending_cancel)
    assert not hasattr(service, "_cancel_again")


# ---------------------------------------- a step parked on its dependencies is not reached


async def _run_token_writes(token: str) -> bool:
    """True when the run token's propose_change was refused as held."""
    async with mcp_session(token, f"{EGRESS[0]}, {LB}") as c:
        res = await c.call_tool(
            "propose_change",
            {
                "body": {
                    "op": "create",
                    "kind": "entity",
                    "fields": {"type": "goal", "key": "g-dep", "title": "Dep"},
                    "reason": "seen",
                }
            },
        )
    if res.is_error:
        assert "waiting for" in res.content[0].text, res.content[0].text
    return res.is_error


async def test_a_step_parked_on_its_dependencies_does_not_hold_the_run_token(client, owner):
    """SwarmCloud makes a task for every step at submission; a step whose dependencies have
    not finished is PARKED with park_reason DEPENDENCY_INCOMPLETE. That is not reached:
    the token writes during work steps; it is held only from the open checkpoint on."""
    _, auth = owner
    swarm = on()
    runtime = use(swarm)
    swarm.steps_per_poll = 0  # the first segment's work step has not run
    run = await started(client, auth)
    review = swarm.workflows["wf_1"].step("baseline-review1")
    assert review.state == "PENDING"
    status = await runtime.status("wf_1")
    step = status.step("baseline-review1")
    assert (step.state, step.park_reason) == ("PARKED", "DEPENDENCY_INCOMPLETE")
    token = token_of(swarm)
    assert await _run_token_writes(token) is False

    # The work step runs; the review step opens (AWAITING_INPUT): held.
    swarm.steps_per_poll = None
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "awaiting_checkpoint"
    assert (await runtime.status("wf_1")).step("baseline-review1").park_reason == "AWAITING_INPUT"
    assert await _run_token_writes(token) is True

    # After the decision the checkpoint is closed and the next segment's work step is
    # running (its review is parked on it): released again.
    swarm.steps_per_poll = 0
    await decide(client, auth, run)
    service._hold_cache.clear()
    assert await _run_token_writes(token) is False


@pytest.mark.parametrize(
    ("state", "reason", "reached"),
    [
        ("PENDING", None, True),
        ("SKIPPED", None, True),
        ("PARKED", "DEPENDENCY_INCOMPLETE", False),
        ("PARKED", "AWAITING_INPUT", True),
        ("PARKED", "CREDENTIAL_MISSING", True),
        ("PARKED", None, True),
        ("RUNNING", "DEPENDENCY_INCOMPLETE", True),
        ("SUCCEEDED", None, True),
        ("PARKED", "dependency_incomplete", True),
        ("READY", None, True),
        ("CANCELLED", None, True),
        ("DEAD_LETTERED", None, True),
    ],
)
def test_not_reached_counts_a_step_parked_on_its_dependencies(state, reason, reached):
    from oracle.swarm.runtime import not_reached

    before = StepStatus("w", "t0", "RUNNING", task_read=True)
    step = StepStatus("s", "t", state, park_reason=reason, task_read=True)
    assert not_reached(step, before) is not reached


def test_not_reached_fails_closed_without_a_task_or_with_an_opened_wait():
    from oracle.swarm.runtime import not_reached

    before = StepStatus("w", "t0", "RUNNING", task_read=True)
    parked = dict(state="PARKED", park_reason="DEPENDENCY_INCOMPLETE")
    assert not_reached(StepStatus("s", "t", **parked, task_read=True), before) is True
    # The task page had no task for the step: reached (held), whatever the default says.
    assert not_reached(StepStatus("s", "t", **parked), before) is False
    assert not_reached(StepStatus("s", None, task_read=False), before) is False
    # An opened wait is reached whatever its park reason says.
    opened = StepStatus("s", "t", **parked, task_read=True, wait_opened=True)
    assert not_reached(opened, before) is False


async def test_a_review_step_with_no_task_in_the_page_holds_the_run_token_and_reads_cleanly(
    monkeypatch,
):
    from oracle.swarm.swarmcloud import SwarmCloudRuntime

    rt = object.__new__(SwarmCloudRuntime)

    async def read(workflow_id):
        return {
            "workflow": {
                "state": "running",
                "steps": [
                    {"step_id": "r1", "task_id": "t_missing"},
                    {"step_id": "r2", "task_id": "t_p", "state": "PARKED"},
                ],
            },
            "tasks": [
                {
                    "id": "t_p",
                    "state": "PARKED",
                    "park_reason": "DEPENDENCY_INCOMPLETE",
                    "metadata": {"await_input": {"opened_at": "2026-10-20T10:00:00+00:00"}},
                }
            ],
        }

    rt._read = read
    status = await rt.status("wf_1")
    missing, opened = status.step("r1"), status.step("r2")
    assert missing.state == "PENDING" and missing.task_read is False  # display unchanged
    assert opened.wait_opened is True and opened.park_reason == "DEPENDENCY_INCOMPLETE"

    service._hold_cache.clear()
    service._hold_reads.clear()
    for review in ("r1", "r2"):
        monkeypatch.setattr(service, "get_runtime", lambda: rt)
        service._hold_cache.clear()
        assert (
            await service._live_hold(uuid.uuid4(), "wf_1", ((review, "r0"),))
            == service.HOLD_DECISION
        )
    service._hold_cache.clear()
    service._hold_reads.clear()
