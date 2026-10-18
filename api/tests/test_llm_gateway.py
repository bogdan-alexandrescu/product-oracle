"""The LLM gateway: which Claude plan pays, and how each credential kind is called."""

import json
import os
import stat
import uuid

import httpx
import pytest

from oracle.connections.models import Connection
from oracle.connections.providers import API_KEY_PREFIX, PLAN_TOKEN_PREFIX
from oracle.llm import NoClaudePlan, gateway
from oracle.llm.transports import (
    ClaudeCodeTransport,
    LlmAuthError,
    LlmRequest,
    LlmUnavailable,
    MessagesApiTransport,
    TransportResult,
    render_prompt,
)
from oracle.tenancy import tenant_session
from oracle.tenant_settings import TenantSetting
from tests.connection_helpers import add_connection, make_person


class FakeTransport:
    def __init__(self, name: str, error: Exception | None = None):
        self.name = name
        self.error = error
        self.calls: list[tuple[str, LlmRequest]] = []

    async def complete(self, token: str, request: LlmRequest) -> TransportResult:
        self.calls.append((token, request))
        if self.error:
            raise self.error
        return TransportResult(text=f"{self.name} answer", model=request.model)


@pytest.fixture
def fakes():
    plan, api = FakeTransport("plan"), FakeTransport("api")
    return gateway.Transports(plan=plan, api_key=api)


async def _claude(tenant_id, user_id, kind="plan", status="active", token=None):
    token = token or (PLAN_TOKEN_PREFIX if kind == "plan" else API_KEY_PREFIX) + uuid.uuid4().hex
    conn = await add_connection(
        tenant_id, user_id, "claude", account_id=kind, status=status,
        bundle={"access_token": token, "kind": kind},
    )  # fmt: skip
    return conn, token


async def _set_default(tenant_id, conn_id):
    async with tenant_session(tenant_id) as s:
        s.add(TenantSetting(key="default_claude_connection_id", value=str(conn_id)))
        await s.commit()


MESSAGES = [{"role": "user", "content": "Summarise the goals."}]


async def test_uses_the_users_own_plan(tenant_id, fakes):
    alice = await make_person(tenant_id, "alice@example.com")
    conn, token = await _claude(tenant_id, alice.id)
    async with tenant_session(tenant_id) as s:
        out = await gateway.complete(s, alice.id, "Be brief.", MESSAGES, 512, transports=fakes)
    assert out.text == "plan answer"
    assert (out.plan, out.via, out.connection_id) == ("own", "plan", conn.id)
    token_seen, request = fakes.plan.calls[0]
    assert token_seen == token
    assert request.system == "Be brief."  # passed as is: no prelude added
    assert request.messages == MESSAGES and request.max_tokens == 512
    assert fakes.api_key.calls == []


async def test_api_key_goes_to_the_messages_transport(tenant_id, fakes):
    alice = await make_person(tenant_id, "alice@example.com")
    _, key = await _claude(tenant_id, alice.id, kind="api_key")
    async with tenant_session(tenant_id) as s:
        out = await gateway.complete(s, alice.id, "s", MESSAGES, 64, transports=fakes)
    assert (out.text, out.via) == ("api answer", "api_key")
    assert fakes.api_key.calls[0][0] == key
    assert fakes.plan.calls == []


async def test_falls_back_to_the_company_default(tenant_id, fakes):
    owner = await make_person(tenant_id, "owner@example.com", "owner")
    bob = await make_person(tenant_id, "bob@example.com", "commenter")
    conn, token = await _claude(tenant_id, owner.id)
    await _set_default(tenant_id, conn.id)
    async with tenant_session(tenant_id) as s:
        out = await gateway.complete(s, bob.id, "s", MESSAGES, 64, transports=fakes)
    assert (out.plan, out.connection_id) == ("company", conn.id)
    assert fakes.plan.calls[0][0] == token

    # Bob's own plan wins over the default once he has one.
    own, own_token = await _claude(tenant_id, bob.id)
    async with tenant_session(tenant_id) as s:
        out = await gateway.complete(s, bob.id, "s", MESSAGES, 64, transports=fakes)
    assert (out.plan, out.connection_id) == ("own", own.id)
    assert fakes.plan.calls[-1][0] == own_token


async def test_no_plan_is_a_clear_error(tenant_id, fakes):
    bob = await make_person(tenant_id, "bob@example.com", "commenter")
    async with tenant_session(tenant_id) as s:
        with pytest.raises(NoClaudePlan, match="No Claude plan connected"):
            await gateway.complete(s, bob.id, "s", MESSAGES, 64, transports=fakes)

    # Another user's plan that is not the default is never used.
    owner = await make_person(tenant_id, "owner@example.com")
    await _claude(tenant_id, owner.id)
    async with tenant_session(tenant_id) as s:
        with pytest.raises(NoClaudePlan):
            await gateway.complete(s, bob.id, "s", MESSAGES, 64, transports=fakes)
    assert fakes.plan.calls == []


async def test_inactive_default_or_own_plan_is_not_used(tenant_id, fakes):
    owner = await make_person(tenant_id, "owner@example.com")
    bob = await make_person(tenant_id, "bob@example.com", "viewer")
    conn, _ = await _claude(tenant_id, owner.id, status="expired")
    await _set_default(tenant_id, conn.id)
    await _claude(tenant_id, bob.id, status="error")
    async with tenant_session(tenant_id) as s:
        with pytest.raises(NoClaudePlan, match="default Claude plan is expired"):
            await gateway.complete(s, bob.id, "s", MESSAGES, 64, transports=fakes)


async def test_rejected_credential_marks_the_connection_expired(tenant_id):
    alice = await make_person(tenant_id, "alice@example.com")
    conn, _ = await _claude(tenant_id, alice.id)
    failing = gateway.Transports(
        plan=FakeTransport("plan", LlmAuthError("401 OAuth access token is invalid")),
        api_key=FakeTransport("api"),
    )
    async with tenant_session(tenant_id) as s:
        with pytest.raises(LlmAuthError):
            await gateway.complete(s, alice.id, "s", MESSAGES, 64, transports=failing)
    async with tenant_session(tenant_id) as s:
        row = await s.get(Connection, conn.id)
        assert row.status == "expired"
        assert "invalid" in row.last_error


async def test_claude_plan_endpoint(client, tenant_id):
    owner = await make_person(tenant_id, "owner@example.com")
    bob = await make_person(tenant_id, "bob@example.com", "commenter")
    none = (await client.get("/v1/claude-plan", headers=bob.headers)).json()
    assert none["source"] == "none" and "No Claude plan" in none["reason"]

    conn, _ = await _claude(tenant_id, owner.id)
    await _set_default(tenant_id, conn.id)
    company = (await client.get("/v1/claude-plan", headers=bob.headers)).json()
    assert company["source"] == "company"
    assert company["account_label"] is None
    own = (await client.get("/v1/claude-plan", headers=owner.headers)).json()
    assert own["source"] == "own" and own["via"] == "plan"


async def test_connect_claude_plan_via_api(client, tenant_id, fakes):
    alice = await make_person(tenant_id, "alice@example.com", "viewer")
    previous = gateway.set_transports(fakes)
    try:
        resp = await client.post(
            "/v1/connections/claude/token",
            json={"token": PLAN_TOKEN_PREFIX + "01-example-abcd"},
            headers=alice.headers,
        )
    finally:
        gateway.set_transports(previous)
    assert resp.status_code == 200, resp.text
    assert resp.json()["account_label"] == "Claude plan (setup-token …abcd)"
    assert resp.json()["auth_mode"] == "token"
    assert PLAN_TOKEN_PREFIX not in resp.text
    assert fakes.plan.calls[0][0] == PLAN_TOKEN_PREFIX + "01-example-abcd"

    wrong = await client.post(
        "/v1/connections/claude/token", json={"token": "not-a-claude-token"}, headers=alice.headers
    )
    assert wrong.status_code == 400
    assert "claude setup-token" in wrong.json()["detail"]


# --- Transports ---------------------------------------------------------------------


def _request(**kw) -> LlmRequest:
    return LlmRequest(
        system=kw.get("system", "Be brief."),
        messages=kw.get("messages", MESSAGES),
        max_tokens=kw.get("max_tokens", 256),
        model=kw.get("model", "claude-opus-5"),
    )


async def test_messages_api_transport_uses_x_api_key():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url == "https://api.anthropic.com/v1/messages"
        assert request.headers["x-api-key"] == API_KEY_PREFIX + "03-key"
        assert "authorization" not in request.headers
        assert request.headers["anthropic-version"] == "2023-06-01"
        body = json.loads(request.content)
        assert body == {
            "model": "claude-opus-5",
            "max_tokens": 256,
            "system": "Be brief.",
            "messages": MESSAGES,
        }
        return httpx.Response(
            200,
            json={
                "model": "claude-opus-5",
                "content": [{"type": "text", "text": "Hello"}, {"type": "text", "text": "!"}],
                "stop_reason": "end_turn",
                "usage": {"input_tokens": 3, "output_tokens": 2},
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        out = await MessagesApiTransport(http).complete(API_KEY_PREFIX + "03-key", _request())
    assert (out.text, out.stop_reason) == ("Hello!", "end_turn")

    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(401))) as h:
        with pytest.raises(LlmAuthError):
            await MessagesApiTransport(h).complete("bad", _request())
    overloaded = httpx.MockTransport(
        lambda r: httpx.Response(529, json={"error": {"message": "Overloaded"}})
    )
    async with httpx.AsyncClient(transport=overloaded) as h:
        with pytest.raises(LlmUnavailable, match="Overloaded"):
            await MessagesApiTransport(h).complete("k", _request())


PLAN_BAD = PLAN_TOKEN_PREFIX + "01-bad"
FAKE_CLAUDE = """#!/usr/bin/env python3
import json, os, sys
prompt = sys.stdin.read()
record = {"argv": sys.argv[1:], "prompt": prompt, "cwd": os.getcwd(),
          "env": {k: os.environ.get(k) for k in (
              "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
              "HOME")}}
open(__LOG__, "w").write(json.dumps(record))
if record["env"]["CLAUDE_CODE_OAUTH_TOKEN"] == __BAD__:
    print(json.dumps({"type": "result", "is_error": True, "api_error_status": 401,
                      "result": "API Error: 401 OAuth access token is invalid."}))
    sys.exit(1)
print(json.dumps({"type": "result", "subtype": "success", "is_error": False,
                  "result": "Plan answer", "stop_reason": "end_turn",
                  "usage": {"output_tokens": 2}, "modelUsage": {"claude-opus-5": {}}}))
"""


@pytest.fixture
def fake_claude(tmp_path, monkeypatch):
    log = tmp_path / "call.json"
    script = tmp_path / "claude"
    body = FAKE_CLAUDE.replace("__LOG__", repr(str(log))).replace("__BAD__", repr(PLAN_BAD))
    script.write_text(body)
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    # The server's own credentials must never reach the subprocess.
    monkeypatch.setenv("ANTHROPIC_API_KEY", API_KEY_PREFIX + "03-server-key")
    return str(script), log


async def test_claude_code_transport_runs_headless_with_the_plan_token(fake_claude):
    script, log = fake_claude
    transport = ClaudeCodeTransport(claude_bin=script, timeout=30)
    out = await transport.complete(PLAN_TOKEN_PREFIX + "01-good", _request())
    assert (out.text, out.model, out.stop_reason) == ("Plan answer", "claude-opus-5", "end_turn")

    call = json.loads(log.read_text())
    assert call["prompt"] == "Summarise the goals."
    assert call["env"]["CLAUDE_CODE_OAUTH_TOKEN"] == PLAN_TOKEN_PREFIX + "01-good"
    assert call["env"]["ANTHROPIC_API_KEY"] is None
    assert call["env"]["CLAUDE_CODE_MAX_OUTPUT_TOKENS"] == "256"
    assert call["env"]["HOME"] != os.environ.get("HOME")
    argv = call["argv"]
    assert argv[0] == "-p"
    assert argv[argv.index("--system-prompt") + 1] == "Be brief."
    assert argv[argv.index("--tools") + 1] == ""
    assert argv[argv.index("--model") + 1] == "claude-opus-5"
    # The token is in the environment of that one process, never on the command line.
    assert PLAN_TOKEN_PREFIX + "01-good" not in " ".join(argv)
    assert "CLAUDE_CODE_OAUTH_TOKEN" not in os.environ

    with pytest.raises(LlmAuthError):
        await transport.complete(PLAN_TOKEN_PREFIX + "01-bad", _request())


async def test_claude_code_transport_missing_binary_or_garbage():
    with pytest.raises(LlmUnavailable, match="not installed"):
        await ClaudeCodeTransport(claude_bin="/nonexistent/claude").complete("t", _request())
    with pytest.raises(LlmUnavailable, match="boom"):
        ClaudeCodeTransport.parse(b"", b"boom", _request())


def test_render_prompt_for_multi_turn():
    assert render_prompt(MESSAGES) == "Summarise the goals."
    turns = [
        {"role": "user", "content": "A?"},
        {"role": "assistant", "content": [{"type": "text", "text": "B."}]},
        {"role": "user", "content": "C?"},
    ]
    assert render_prompt(turns) == (
        "<user>\nA?\n</user>\n\n<assistant>\nB.\n</assistant>\n\n<user>\nC?\n</user>"
    )
