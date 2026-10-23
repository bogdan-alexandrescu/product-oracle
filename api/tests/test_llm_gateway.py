"""Built-in model calls on the Claude account pool, and how each credential is called."""

import asyncio
import contextlib
import json
import os
import signal
import stat
import sys
import time
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from oracle.claude_accounts import store
from oracle.claude_accounts.accounts import AccountState
from oracle.claude_accounts.fallback import API_KEY_PREFIX, PLAN_TOKEN_PREFIX
from oracle.llm import NoClaudeAccount, gateway
from oracle.llm.transports import (
    ClaudeCodeTransport,
    LlmAuthError,
    LlmOutOfTime,
    LlmRateLimited,
    LlmRequest,
    LlmUnavailable,
    MessagesApiTransport,
    TransportResult,
    get_llm_settings,
    reading_of,
    render_prompt,
)
from oracle.tenancy import tenant_session
from tests.claude_account_helpers import add_account, get_account, now, window

MESSAGES = [{"role": "user", "content": "Summarise the goals."}]
RESETS = int((datetime.now(UTC) + timedelta(hours=3)).timestamp())


class FakeTransport:
    """Answers per token: an exception, or text with readings."""

    def __init__(self, name: str, answers: dict[str, object] | None = None):
        self.name = name
        self.answers = answers or {}
        self.calls: list[tuple[str, LlmRequest]] = []

    async def complete(self, token: str, request: LlmRequest) -> TransportResult:
        self.calls.append((token, request))
        answer = self.answers.get(token)
        if isinstance(answer, Exception):
            raise answer
        readings = answer if isinstance(answer, dict) else {}
        return TransportResult(text=f"{self.name} answer", model=request.model, readings=readings)


@pytest.fixture
def fakes():
    return gateway.Transports(plan=FakeTransport("plan"), api_key=FakeTransport("api"))


def _reading(utilization: float) -> dict[str, object]:
    return {
        "five_hour": {
            "utilization": utilization,
            "resets_at": datetime.fromtimestamp(RESETS, tz=UTC).isoformat(),
        }
    }


async def _call(tenant_id, fakes, job="reporting"):
    async with tenant_session(tenant_id) as s:
        return await gateway.complete(s, "Be brief.", MESSAGES, 256, job=job, transports=fakes)


async def test_a_call_runs_on_the_account_with_most_headroom_and_records_its_reading(
    tenant_id, fakes
):
    await add_account(tenant_id, "busy", windows={"five_hour": window(0.8)})
    roomy = await add_account(tenant_id, "roomy", windows={"five_hour": window(0.1)})
    fakes.plan.answers["acc-roomy"] = _reading(0.33)
    out = await _call(tenant_id, fakes)
    assert (out.text, out.via, out.account_label) == ("plan answer", "account", "roomy")
    assert fakes.plan.calls[0][0] == "acc-roomy"
    after = await get_account(tenant_id, roomy.account_id)
    assert after.windows["five_hour"].utilization == pytest.approx(0.33)
    # The hold was given back when the call ended, and the log says so.
    assert after.assigned == 0 and after.last_assigned_at is not None


async def test_an_exhausted_account_is_swapped_at_the_turn_boundary(tenant_id, fakes):
    spent = await add_account(tenant_id, "alpha")
    spare = await add_account(tenant_id, "bravo", windows={"five_hour": window(0.5)})
    fakes.plan.answers["acc-alpha"] = LlmRateLimited("out of quota", _reading(1.0))
    out = await _call(tenant_id, fakes)
    assert out.account_label == "bravo"
    assert out.swaps == [(spent.account_id, "exhausted")]
    assert [t for t, _ in fakes.plan.calls] == ["acc-alpha", "acc-bravo"]
    # The rejected reading is recorded, so the next call does not try it.
    assert (await get_account(tenant_id, spent.account_id)).windows["five_hour"].utilization == 1.0
    assert (await get_account(tenant_id, spare.account_id)).assigned == 0
    again = await _call(tenant_id, fakes)
    assert again.account_label == "bravo" and again.swaps == []


async def test_a_draining_account_moves_its_hold_before_the_next_turn(tenant_id, fakes):
    a = await add_account(tenant_id, "alpha")
    b = await add_account(tenant_id, "bravo", windows={"five_hour": window(0.5)})
    real_must_move = gateway.pool.must_move
    drained = False

    async def drain_once(tenant, assignment):
        nonlocal drained
        if not drained:
            drained = True
            await store.set_state_and_moves(
                tenant, a.account_id, AccountState.DRAINING, "", now=now()
            )
        return await real_must_move(tenant, assignment)

    gateway.pool.must_move = drain_once  # type: ignore[assignment]
    try:
        out = await _call(tenant_id, fakes)
    finally:
        gateway.pool.must_move = real_must_move  # type: ignore[assignment]
    assert out.account_id == b.account_id
    assert out.swaps == [(a.account_id, "drain")]


async def test_no_other_account_says_why_and_gives_the_hold_back(tenant_id, fakes):
    a = await add_account(tenant_id, "alpha")
    fakes.plan.answers["acc-alpha"] = LlmRateLimited("out of quota", _reading(1.0))
    with pytest.raises(NoClaudeAccount) as info:
        await _call(tenant_id, fakes)
    assert info.value.reason == "no_account_available"
    assert info.value.next_reset_at is not None
    assert (await get_account(tenant_id, a.account_id)).assigned == 0


async def test_a_paused_pool_is_a_wait_never_the_fallback(tenant_id, fakes):
    from oracle.claude_accounts import fallback

    await add_account(tenant_id, "alpha", state=AccountState.PAUSED)
    async with tenant_session(tenant_id) as s:
        await fallback.store(s, PLAN_TOKEN_PREFIX + "01-spare", None)
        await s.commit()
    with pytest.raises(NoClaudeAccount) as info:
        await _call(tenant_id, fakes)
    assert info.value.reason == "pool_paused"
    assert fakes.plan.calls == []


async def test_with_no_account_the_fallback_credential_is_used(tenant_id, fakes):
    from oracle.claude_accounts import fallback

    with pytest.raises(NoClaudeAccount, match="Settings > Claude accounts"):
        await _call(tenant_id, fakes)
    async with tenant_session(tenant_id) as s:
        await fallback.store(s, PLAN_TOKEN_PREFIX + "01-spare", None)
        await s.commit()
    out = await _call(tenant_id, fakes)
    assert (out.via, out.account_id) == ("fallback_plan", None)
    assert fakes.plan.calls[-1][0] == PLAN_TOKEN_PREFIX + "01-spare"
    async with tenant_session(tenant_id) as s:
        await fallback.store(s, API_KEY_PREFIX + "03-key", None)
        await s.commit()
    out = await _call(tenant_id, fakes)
    assert out.via == "fallback_api_key"
    assert fakes.api_key.calls[-1][0] == API_KEY_PREFIX + "03-key"


async def test_an_unreadable_credential_moves_the_call_and_marks_the_account(tenant_id, fakes):
    a = await add_account(tenant_id, "alpha")
    b = await add_account(tenant_id, "bravo", windows={"five_hour": window(0.5)})
    async with tenant_session(tenant_id) as s:
        row = await store.get_row(s, a.account_id)
        row.access_ciphertext = None
        await s.commit()
    out = await _call(tenant_id, fakes)
    assert out.account_id == b.account_id
    assert out.swaps == [(a.account_id, "unusable")]
    assert (await get_account(tenant_id, a.account_id)).is_unreadable(now())


async def test_only_the_built_in_jobs_run_on_the_pool(tenant_id, fakes):
    with pytest.raises(ValueError, match="review_comments"):
        await _call(tenant_id, fakes, job="agent_workflow")


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
PLAN_SPENT = PLAN_TOKEN_PREFIX + "01-spent"
FAKE_CLAUDE = """#!/usr/bin/env python3
import json, os, sys
prompt = sys.stdin.read()
record = {"argv": sys.argv[1:], "prompt": prompt, "cwd": os.getcwd(),
          "env": {k: os.environ.get(k) for k in (
              "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
              "HOME")}}
open(__LOG__, "w").write(json.dumps(record))
token = record["env"]["CLAUDE_CODE_OAUTH_TOKEN"]
print(json.dumps({"type": "system", "subtype": "init", "session_id": "s-12345678"}))
if token == __BAD__:
    print(json.dumps({"type": "result", "is_error": True, "api_error_status": 401,
                      "result": "API Error: 401 OAuth access token is invalid."}))
    sys.exit(1)
if token == __SPENT__:
    print(json.dumps({"type": "rate_limit_event", "rate_limit_info": {
        "status": "rejected", "rateLimitType": "five_hour", "resetsAt": __RESETS__}}))
    print(json.dumps({"type": "result", "is_error": True, "result": "Usage limit reached"}))
    sys.exit(1)
print(json.dumps({"type": "rate_limit_event", "rate_limit_info": {
    "status": "allowed", "rateLimitType": "five_hour", "utilization": 0.25,
    "resetsAt": __RESETS__}}))
print(json.dumps({"type": "rate_limit_event", "rate_limit_info": {
    "status": "allowed_warning", "rateLimitType": "seven_day", "utilization": 0.81,
    "resetsAt": __RESETS__}}))
print(json.dumps({"type": "result", "subtype": "success", "is_error": False,
                  "result": "Plan answer", "stop_reason": "end_turn",
                  "usage": {"output_tokens": 2}, "modelUsage": {"claude-opus-5": {}}}))
"""


@pytest.fixture
def fake_claude(tmp_path, monkeypatch):
    log = tmp_path / "call.json"
    script = tmp_path / "claude"
    body = (
        FAKE_CLAUDE.replace("__LOG__", repr(str(log)))
        .replace("__BAD__", repr(PLAN_BAD))
        .replace("__SPENT__", repr(PLAN_SPENT))
        .replace("__RESETS__", str(RESETS))
    )
    script.write_text(body)
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    # The server's own credentials must never reach the subprocess.
    monkeypatch.setenv("ANTHROPIC_API_KEY", API_KEY_PREFIX + "03-server-key")
    return str(script), log


async def test_claude_code_transport_runs_headless_with_the_token_and_reads_the_windows(
    fake_claude,
):
    script, log = fake_claude
    transport = ClaudeCodeTransport(claude_bin=script, timeout=30)
    out = await transport.complete(PLAN_TOKEN_PREFIX + "01-good", _request())
    assert (out.text, out.model, out.stop_reason) == ("Plan answer", "claude-opus-5", "end_turn")
    assert out.readings["five_hour"]["utilization"] == 0.25
    assert out.readings["seven_day"]["utilization"] == 0.81

    call = json.loads(log.read_text())
    assert call["prompt"] == "Summarise the goals."
    assert call["env"]["CLAUDE_CODE_OAUTH_TOKEN"] == PLAN_TOKEN_PREFIX + "01-good"
    assert call["env"]["ANTHROPIC_API_KEY"] is None
    assert call["env"]["CLAUDE_CODE_MAX_OUTPUT_TOKENS"] == "256"
    assert call["env"]["HOME"] != os.environ.get("HOME")
    argv = call["argv"]
    assert argv[0] == "-p"
    assert argv[argv.index("--output-format") + 1] == "stream-json"
    assert argv[argv.index("--system-prompt") + 1] == "Be brief."
    assert argv[argv.index("--tools") + 1] == ""
    assert argv[argv.index("--model") + 1] == "claude-opus-5"
    # The token is in the environment of that one process, never on the command line.
    assert PLAN_TOKEN_PREFIX + "01-good" not in " ".join(argv)
    assert "CLAUDE_CODE_OAUTH_TOKEN" not in os.environ

    with pytest.raises(LlmAuthError):
        await transport.complete(PLAN_TOKEN_PREFIX + "01-bad", _request())
    with pytest.raises(LlmRateLimited) as info:
        await transport.complete(PLAN_SPENT, _request())
    assert info.value.readings["five_hour"]["utilization"] == 1.0


def test_a_rate_limit_event_is_a_reading_only_when_it_says_everything():
    def event(**info):
        return {"type": "rate_limit_event", "rate_limit_info": info}

    name, r = reading_of(event(rateLimitType="five_hour", utilization=0.5, resetsAt=RESETS))
    assert name == "five_hour" and r["utilization"] == 0.5
    assert (
        reading_of(event(rateLimitType="seven_day", status="rejected", resetsAt=RESETS))[1][
            "utilization"
        ]
        == 1.0
    )
    for bad in (
        event(rateLimitType="five_hour", utilization=0.5),
        event(rateLimitType="Five Hour", utilization=0.5, resetsAt=RESETS),
        event(rateLimitType="five_hour", utilization=1.5, resetsAt=RESETS),
        event(rateLimitType="five_hour", utilization=True, resetsAt=RESETS),
        {"type": "rate_limit_event"},
    ):
        assert reading_of(bad) is None


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


def test_claude_code_transport_passes_the_reported_cost_on():
    stdout = json.dumps(
        {
            "type": "result",
            "subtype": "success",
            "is_error": False,
            "result": "ok",
            "usage": {"input_tokens": 10, "output_tokens": 2},
            "total_cost_usd": 0.0123,
        }
    ).encode()
    out = ClaudeCodeTransport.parse(stdout, b"", _request())
    assert out.usage == {"input_tokens": 10, "output_tokens": 2, "total_cost_usd": 0.0123}


# --- a deadline: no swap or call starts that cannot finish before it ------------------


async def _call_by(tenant_id, fakes, deadline, on_call=None):
    async with tenant_session(tenant_id) as s:
        return await gateway.complete(
            s,
            "Be brief.",
            MESSAGES,
            256,
            job="reporting",
            transports=fakes,
            deadline=deadline,
            on_call=on_call,
        )


async def test_no_swap_starts_that_cannot_finish_before_the_deadline(tenant_id, fakes, monkeypatch):
    monkeypatch.setattr(get_llm_settings(), "timeout_seconds", 1.0)
    spent = await add_account(tenant_id, "alpha")
    spare = await add_account(tenant_id, "bravo", windows={"five_hour": window(0.5)})
    fakes.plan.answers["acc-alpha"] = LlmRateLimited("out of quota", _reading(1.0))
    started: list[tuple[str | None, str]] = []
    real_complete = fakes.plan.complete

    async def slow(token, request):
        await asyncio.sleep(0.6)
        return await real_complete(token, request)

    monkeypatch.setattr(fakes.plan, "complete", slow)
    # Time for one call, not for a second one on another account.
    with pytest.raises(LlmOutOfTime) as info:
        await _call_by(
            tenant_id,
            fakes,
            time.monotonic() + 1.5,
            lambda label, via: started.append((label, via)),
        )
    # A transient outcome: the job counts the attempt and retries later.
    assert isinstance(info.value, LlmUnavailable)
    assert [token for token, _ in fakes.plan.calls] == ["acc-alpha"]
    assert started == [("alpha", "account")]
    # The rate limit's reading was still kept, and every hold given back.
    after = await get_account(tenant_id, spent.account_id)
    assert after.windows["five_hour"].utilization == 1.0 and after.assigned == 0
    assert (await get_account(tenant_id, spare.account_id)).assigned == 0


async def test_no_call_starts_that_cannot_finish_before_the_deadline(tenant_id, fakes, monkeypatch):
    monkeypatch.setattr(get_llm_settings(), "timeout_seconds", 10.0)
    account = await add_account(tenant_id, "alpha")
    with pytest.raises(LlmOutOfTime):
        await _call_by(tenant_id, fakes, time.monotonic() + 5)
    assert fakes.plan.calls == []
    assert (await get_account(tenant_id, account.account_id)).assigned == 0
    # With the time, it runs.
    out = await _call_by(tenant_id, fakes, time.monotonic() + 30)
    assert out.account_label == "alpha"


async def test_the_fallback_call_respects_the_deadline_too(tenant_id, fakes, monkeypatch):
    monkeypatch.setattr(get_llm_settings(), "timeout_seconds", 10.0)
    async with tenant_session(tenant_id) as s:
        from oracle.claude_accounts import fallback

        await fallback.store(s, PLAN_TOKEN_PREFIX + "01-spare", None)
        await s.commit()
    with pytest.raises(LlmOutOfTime):
        await _call_by(tenant_id, fakes, time.monotonic() + 5)
    assert fakes.plan.calls == [] and fakes.api_key.calls == []


SLOW_CLAUDE = """#!/usr/bin/env python3
import os, time
with open(__PID__, "w") as f:
    f.write(str(os.getpid()))
time.sleep(120)
"""


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


@pytest.fixture
def slow_claude(tmp_path):
    pidfile = tmp_path / "pid"
    script = tmp_path / "claude"
    script.write_text(SLOW_CLAUDE.replace("__PID__", repr(str(pidfile))))
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    return str(script), pidfile


async def _started_pid(pidfile) -> int:
    for _ in range(400):
        if pidfile.exists() and pidfile.read_text():
            return int(pidfile.read_text())
        await asyncio.sleep(0.025)
    raise AssertionError("Claude Code never started")


async def test_a_cancelled_call_leaves_no_claude_code_process(slow_claude):
    script, pidfile = slow_claude
    transport = ClaudeCodeTransport(claude_bin=script, timeout=120)
    task = asyncio.create_task(transport.complete(PLAN_TOKEN_PREFIX + "01-good", _request()))
    pid = await _started_pid(pidfile)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert not _alive(pid)


async def test_a_cancelled_call_gives_its_hold_back_only_once_the_process_is_gone(
    tenant_id, slow_claude, monkeypatch
):
    script, pidfile = slow_claude
    account = await add_account(tenant_id, "alpha")
    real_release = gateway.pool.release
    alive_at_release: list[bool] = []

    async def release(tenant, assignment, **kw):
        alive_at_release.append(_alive(int(pidfile.read_text())))
        return await real_release(tenant, assignment, **kw)

    monkeypatch.setattr(gateway.pool, "release", release)
    plan = ClaudeCodeTransport(claude_bin=script, timeout=120)
    fakes = gateway.Transports(plan=plan, api_key=FakeTransport("api"))
    task = asyncio.create_task(_call(tenant_id, fakes))
    pid = await _started_pid(pidfile)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert alive_at_release == [False] and not _alive(pid)
    assert (await get_account(tenant_id, account.account_id)).assigned == 0


async def test_a_cancel_while_the_account_is_assigned_gives_the_hold_back(
    tenant_id, fakes, monkeypatch
):
    account = await add_account(tenant_id, "alpha")
    real_assign = gateway.pool.assign
    taken = asyncio.Event()

    async def slow_assign(*args, **kw):
        got = await real_assign(*args, **kw)
        # The hold is committed; the assignment has not reached the caller yet.
        taken.set()
        await asyncio.sleep(0.5)
        return got

    monkeypatch.setattr(gateway.pool, "assign", slow_assign)
    task = asyncio.create_task(_call(tenant_id, fakes))
    await taken.wait()
    assert (await get_account(tenant_id, account.account_id)).assigned == 1
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert fakes.plan.calls == []
    assert (await get_account(tenant_id, account.account_id)).assigned == 0


API_PROCESS = """
import asyncio, sys
from oracle.llm.transports import ClaudeCodeTransport, LlmRequest
request = LlmRequest(system="s", messages=[{"role": "user", "content": "hi"}],
                     max_tokens=10, model="claude-opus-5")
asyncio.run(ClaudeCodeTransport(claude_bin=sys.argv[1], timeout=120).complete("t", request))
"""


def _running(pid: int) -> bool:
    """Alive and not a zombie (an orphan nobody reaps stays one, but is gone)."""
    try:
        with open(f"/proc/{pid}/stat") as f:
            return f.read().rsplit(")", 1)[1].split()[0] != "Z"
    except FileNotFoundError:
        return False


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="PR_SET_PDEATHSIG is Linux's")
async def test_claude_code_dies_with_the_api_process(slow_claude):
    script, pidfile = slow_claude
    api = await asyncio.create_subprocess_exec(sys.executable, "-c", API_PROCESS, script)
    pid = await _started_pid(pidfile)
    try:
        # SIGKILL: no handler, no finally, nothing of the API process's own runs.
        api.kill()
        await api.wait()
        for _ in range(200):
            if not _running(pid):
                break
            await asyncio.sleep(0.025)
        assert not _running(pid)
    finally:
        with contextlib.suppress(ProcessLookupError):
            os.kill(pid, signal.SIGKILL)


# --- refusals a person reads (#403) -------------------------------------------------


def test_a_refusal_gives_the_clearing_time_in_words_in_the_zone():
    from oracle.claude_accounts.accounts import Unavailable
    from oracle.claude_accounts.pool import NoAccount

    at = datetime(2026, 10, 25, 21, 59, 59, 807205, tzinfo=UTC)
    refused = NoAccount(Unavailable.NO_ACCOUNT_AVAILABLE, at)
    assert refused.message("America/Los_Angeles") == (
        "every Claude account is spent; the earliest window clears Sun Oct 25, 2:59 PM PDT"
    )
    assert refused.message("Europe/Berlin").endswith("clears Sun Oct 25, 10:59 PM CET")
    assert "2026-10-25T" not in refused.message()


async def test_a_spent_pool_refuses_in_the_company_time_zone_never_iso(tenant_id, fakes):
    from oracle.tenant_settings import TenantSetting

    await add_account(tenant_id, "weekly", windows={"seven_day": window(0.97, timedelta(days=2))})
    async with tenant_session(tenant_id) as s:
        s.add(TenantSetting(key="alignment_report", value={"timezone": "Asia/Tokyo"}))
        await s.commit()
    with pytest.raises(NoClaudeAccount) as info:
        await _call(tenant_id, fakes)
    message = str(info.value)
    assert message.startswith("No Claude account can take this call: every Claude account is spent")
    assert message.endswith(" JST"), message
    assert "T" not in message.split("clears ")[1].split(",")[0]
    assert "+00:00" not in message
    assert info.value.next_reset_at is not None


# --- a spent pool and the fallback credential (#403, owner decision 2026-10-23) ------


async def test_a_spent_pool_with_a_fallback_runs_the_call_on_the_fallback(tenant_id, fakes):
    from oracle.claude_accounts import fallback

    weekly = await add_account(
        tenant_id, "weekly", windows={"seven_day": window(0.97, timedelta(days=2))}
    )
    async with tenant_session(tenant_id) as s:
        await fallback.store(s, PLAN_TOKEN_PREFIX + "01-spare", None)
        await s.commit()
    told: list[tuple[str | None, str]] = []
    async with tenant_session(tenant_id) as s:
        out = await gateway.complete(
            s,
            "Be brief.",
            MESSAGES,
            256,
            job="reporting",
            transports=fakes,
            on_call=lambda label, via: told.append((label, via)),
        )
    # Which credential ran it: the fallback, never the spent account.
    assert (out.via, out.account_id, out.account_label) == ("fallback_plan", None, None)
    assert told == [(None, "fallback_plan")]
    assert [t for t, _ in fakes.plan.calls] == [PLAN_TOKEN_PREFIX + "01-spare"]
    assert (await get_account(tenant_id, weekly.account_id)).assigned == 0


async def test_a_spent_pool_without_a_fallback_still_refuses_with_the_worded_time(tenant_id, fakes):
    await add_account(tenant_id, "weekly", windows={"seven_day": window(0.97, timedelta(days=2))})
    with pytest.raises(NoClaudeAccount) as info:
        await _call(tenant_id, fakes)
    assert info.value.reason == "no_account_available"
    message = str(info.value)
    assert message.startswith(
        "No Claude account can take this call: every Claude account is spent; "
        "the earliest window clears "
    )
    assert message.endswith((" PDT", " PST")), message
    assert "+00:00" not in message
    assert fakes.plan.calls == []
