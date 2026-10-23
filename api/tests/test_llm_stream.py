"""G2 Live replies: streaming model calls on Oracle's own Claude accounts.

Card (gateway streaming): protects=holds released, swaps only before text, no duplicated
text; fails_when=a hold leaks, a swap after text, or text is repeated; no_claim=Claude's
real stream format (the fake transport and fake script stand in; the real-stack E2E covers
the proxy only). Synthetic placeholders only.
"""

import asyncio
import json
import stat
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from sqlalchemy import func, select

from oracle.claude_accounts.fallback import API_KEY_PREFIX, PLAN_TOKEN_PREFIX
from oracle.claude_accounts.models import ClaudeAccountHold
from oracle.llm import gateway
from oracle.llm.transports import (
    ClaudeCodeTransport,
    LlmRateLimited,
    LlmRequest,
    MessagesApiTransport,
    TransportResult,
)
from oracle.tenancy import tenant_session
from tests.claude_account_helpers import add_account, get_account

MESSAGES = [{"role": "user", "content": "Can caps ship without detection?"}]
CHUNKS = ["Yes, ", "if caps ", "read the plan ", "thresholds ", "only."]
RESETS = int((datetime.now(UTC) + timedelta(hours=3)).timestamp())


class StreamingFake:
    """Per token: an exception before any text, a number of chunks then an exception, or
    the five chunks."""

    def __init__(self, answers: dict[str, object] | None = None):
        self.answers = answers or {}
        self.calls: list[str] = []

    async def complete(self, token: str, request: LlmRequest) -> TransportResult:
        raise AssertionError("a streaming call must not run complete()")

    async def stream(self, token, request, on_text) -> TransportResult:
        self.calls.append(token)
        answer = self.answers.get(token)
        if isinstance(answer, Exception):
            raise answer
        if isinstance(answer, tuple):
            sent, error = answer
            for chunk in CHUNKS[:sent]:
                await on_text(chunk)
            raise error
        for chunk in CHUNKS:
            await on_text(chunk)
        return TransportResult(
            text="".join(CHUNKS),
            model=request.model,
            usage={"input_tokens": 10, "output_tokens": 5, "total_cost_usd": 0.01},
        )


async def _stream(tenant_id, fake: StreamingFake, seen: list[str]):
    async def on_text(text: str) -> None:
        seen.append(text)

    async with tenant_session(tenant_id) as s:
        return await gateway.stream(
            s, "Be brief.", MESSAGES, 256, job="discussion_reply", on_text=on_text,
            transports=gateway.Transports(plan=fake, api_key=fake),
        )  # fmt: skip


async def _holds(tenant_id) -> int:
    """Holds still open (a released hold keeps its row with ``released_at``)."""
    async with tenant_session(tenant_id) as s:
        return (
            await s.scalar(
                select(func.count())
                .select_from(ClaudeAccountHold)
                .where(ClaudeAccountHold.released_at.is_(None))
            )
            or 0
        )


# protects=criterion 1: five chunks reach on_text in order, with usage and the account,
# and the hold is gone afterwards; fails_when=a chunk is lost or reordered, or a hold
# leaks; no_claim=Claude's real stream.
async def test_stream_tells_each_chunk_in_order_and_releases_the_hold(tenant_id):
    acc = await add_account(tenant_id, "alpha")
    seen: list[str] = []
    out = await _stream(tenant_id, StreamingFake(), seen)
    assert seen == CHUNKS
    assert out.account_label == "alpha" and out.usage["output_tokens"] == 5
    assert await _holds(tenant_id) == 0
    assert (await get_account(tenant_id, acc.account_id)).assigned == 0


# protects=criterion 2: a rate limit before any text swaps accounts; after text it ends
# the call, so no text repeats; fails_when=a swap after text, or a repeated chunk;
# no_claim=the reply's stored body (test_discussion_replies).
async def test_a_swap_happens_only_before_the_first_text(tenant_id):
    await add_account(tenant_id, "alpha")
    await add_account(tenant_id, "bravo")
    spent = LlmRateLimited("out of quota")
    seen: list[str] = []
    fake = StreamingFake({"acc-alpha": spent})
    out = await _stream(tenant_id, fake, seen)
    assert out.account_label == "bravo" and fake.calls == ["acc-alpha", "acc-bravo"]
    assert seen == CHUNKS

    seen = []
    late = StreamingFake({"acc-alpha": (2, spent), "acc-bravo": (2, spent)})
    with pytest.raises(LlmRateLimited):
        await _stream(tenant_id, late, seen)
    assert len(late.calls) == 1 and seen == CHUNKS[:2]
    assert await _holds(tenant_id) == 0


STREAM_CLAUDE = """#!/usr/bin/env python3
import json, sys, time
sys.stdin.read()
open(__LOG__, "w").write(json.dumps(sys.argv[1:]))
open(__PID__, "w").write(str(__import__("os").getpid()))
def out(x):
    print(json.dumps(x), flush=True)
out({"type": "system", "subtype": "init"})
out({"type": "rate_limit_event", "rate_limit_info": {
    "status": "allowed", "rateLimitType": "five_hour", "utilization": 0.3,
    "resetsAt": __RESETS__}})
for t in ["Plan ", "answer ", "streams."]:
    out({"type": "stream_event", "event": {"type": "content_block_delta", "index": 0,
         "delta": {"type": "text_delta", "text": t}}})
    time.sleep(__PAUSE__)
out({"type": "result", "subtype": "success", "is_error": False,
     "result": "Plan answer streams.", "usage": {"output_tokens": 3},
     "modelUsage": {"claude-opus-5": {}}})
"""


def _script(tmp_path, pause: float):
    script = tmp_path / "claude"
    log, pid = tmp_path / "argv.json", tmp_path / "pid"
    script.write_text(
        STREAM_CLAUDE.replace("__LOG__", repr(str(log)))
        .replace("__PID__", repr(str(pid)))
        .replace("__RESETS__", str(RESETS))
        .replace("__PAUSE__", str(pause))
    )
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    return str(script), log, pid


def _request() -> LlmRequest:
    return LlmRequest(system="Be brief.", messages=MESSAGES, max_tokens=64, model="claude-opus-5")


# protects=criterion 3: Claude Code's stream_event deltas reach on_text one by one, with
# partial messages on and tools off, and the readings are kept; fails_when=text comes only
# at the end or the flags are missing; no_claim=the real claude binary.
async def test_claude_code_stream_tells_each_delta(tmp_path):
    script, log, _pid = _script(tmp_path, 0.01)
    seen: list[str] = []

    async def on_text(t: str) -> None:
        seen.append(t)

    out = await ClaudeCodeTransport(claude_bin=script, timeout=30).stream(
        PLAN_TOKEN_PREFIX + "01-good", _request(), on_text
    )
    assert seen == ["Plan ", "answer ", "streams."]
    assert out.text == "Plan answer streams." and out.readings["five_hour"]["utilization"] == 0.3
    argv = json.loads(log.read_text())
    assert "--include-partial-messages" in argv
    assert argv[argv.index("--tools") + 1] == ""


# protects=a cancelled stream kills Claude Code before it returns; fails_when=the process
# outlives the call; no_claim=what Claude does with a kill.
async def test_cancelling_a_claude_code_stream_kills_the_process(tmp_path):
    from tests.test_llm_gateway import _running

    script, _log, pidfile = _script(tmp_path, 30)
    first = asyncio.Event()

    async def on_text(t: str) -> None:
        first.set()

    task = asyncio.ensure_future(
        ClaudeCodeTransport(claude_bin=script, timeout=60).stream("t", _request(), on_text)
    )
    await asyncio.wait_for(first.wait(), 10)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert not _running(int(pidfile.read_text()))


# protects=SSE parsing of the Messages API stream: text deltas in order, usage and stop
# reason from message_start and message_delta; fails_when=a delta is lost or usage is
# missing; no_claim=Anthropic's exact wire format beyond these events.
async def test_messages_api_stream_parses_server_sent_events():
    events = [
        ("message_start", {"message": {"model": "claude-opus-5", "usage": {"input_tokens": 9}}}),
        ("content_block_delta", {"delta": {"type": "text_delta", "text": "Hel"}}),
        ("ping", {}),
        ("content_block_delta", {"delta": {"type": "text_delta", "text": "lo"}}),
        ("message_delta", {"delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 2}}),
        ("message_stop", {}),
    ]
    body = "".join(f"event: {e}\ndata: {json.dumps({'type': e, **d})}\n\n" for e, d in events)
    sent: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(json.loads(request.content))
        return httpx.Response(200, text=body, headers={"content-type": "text/event-stream"})

    seen: list[str] = []

    async def on_text(t: str) -> None:
        seen.append(t)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        out = await MessagesApiTransport(http).stream(
            API_KEY_PREFIX + "03-key", _request(), on_text
        )
    assert sent[0]["stream"] is True
    assert seen == ["Hel", "lo"] and out.text == "Hello"
    assert out.usage == {"input_tokens": 9, "output_tokens": 2}
    assert (out.model, out.stop_reason) == ("claude-opus-5", "end_turn")
