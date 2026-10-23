"""How a model call reaches Claude, by credential kind.

- A subscription token (a pool account's access token, or a ``claude setup-token``
  fallback) runs the call through Claude Code in headless mode
  (``claude -p --output-format stream-json``), with ``CLAUDE_CODE_OAUTH_TOKEN`` set for
  that one process. The stream's ``rate_limit_event`` lines are the account's window
  readings (SwarmCloud's ``runners/cliagent.py``: ``_reading_of``); a REJECTED one says
  the account is spent. Oracle never sends a subscription token to the Messages API.
- An Anthropic API key (fallback only) calls the Messages API with ``x-api-key``.

Both implement :class:`Transport`; tests swap in a fake (``gateway.set_transports``).
"""

import asyncio
import contextlib
import ctypes
import json
import os
import re
import signal
import sys
import tempfile
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from functools import lru_cache
from typing import Any, Protocol

import httpx
from pydantic_settings import BaseSettings, SettingsConfigDict

from oracle.claude_accounts.fallback import ANTHROPIC_API, ANTHROPIC_VERSION


class LlmSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="ORACLE_LLM_", env_file=".env", extra="ignore")

    # Model for Oracle's own calls, unless the caller names one.
    model: str = "claude-opus-5"
    # The Claude Code executable used for subscription tokens.
    claude_bin: str = "claude"
    # One call's limit. 180 s (with a job's 5 s around it) fits in a run ticker's 240 s,
    # so the scheduled tick and `oracle tick` run built-in jobs; over 235 no job fits.
    timeout_seconds: float = 180.0
    # G2 Live replies: what a person waits for. Empty: ``model``.
    chat_model: str = ""
    chat_timeout_seconds: float = 120.0


@lru_cache
def get_llm_settings() -> LlmSettings:
    return LlmSettings()


class LlmError(Exception):
    """Base class of model call failures."""


class NoClaudeAccount(LlmError):
    """No pool account can take the call and no fallback credential applies."""

    def __init__(self, message: str, reason: str = "", next_reset_at: str | None = None):
        super().__init__(message)
        self.reason = reason
        self.next_reset_at = next_reset_at


class LlmAuthError(LlmError):
    """Claude rejected the credential (expired, revoked, wrong token)."""


class LlmUnavailable(LlmError):
    """The call failed for another reason (network, rate limit, Claude Code missing)."""


class LlmOutOfTime(LlmUnavailable):
    """No time left before the caller's deadline for another whole call; not started."""


class LlmRateLimited(LlmUnavailable):
    """The account the call ran on is out of quota: move to another one."""

    def __init__(self, message: str, readings: dict[str, dict[str, Any]] | None = None):
        super().__init__(message)
        self.readings = readings or {}


@dataclass(frozen=True)
class LlmRequest:
    system: str
    # Messages API shape: [{"role": "user" | "assistant", "content": str | [blocks]}].
    messages: list[dict[str, Any]]
    max_tokens: int
    model: str


@dataclass(frozen=True)
class TransportResult:
    text: str
    model: str
    stop_reason: str | None = None
    usage: dict[str, Any] = field(default_factory=dict)
    # Window readings from ``rate_limit_event``: {window: {utilization, resets_at}}.
    readings: dict[str, dict[str, Any]] = field(default_factory=dict)


#: Told each piece of text as it arrives (G2 Live replies).
OnText = Callable[[str], Awaitable[None]]


class Transport(Protocol):
    async def complete(self, token: str, request: LlmRequest) -> TransportResult: ...

    async def stream(self, token: str, request: LlmRequest, on_text: OnText) -> TransportResult: ...


def _text(content: Any) -> str:
    if isinstance(content, str):
        return content
    return "".join(
        b.get("text", "") for b in content or [] if isinstance(b, dict) and b.get("type") == "text"
    )


def render_prompt(messages: list[dict[str, Any]]) -> str:
    """The prompt for ``claude -p``: the message itself, or the turns as a transcript."""
    if len(messages) == 1 and messages[0].get("role") == "user":
        return _text(messages[0]["content"])
    turns = []
    for m in messages:
        tag = "assistant" if m.get("role") == "assistant" else "user"
        turns.append(f"<{tag}>\n{_text(m['content'])}\n</{tag}>")
    return "\n\n".join(turns)


_WINDOW_NAME = re.compile(r"^[a-z0-9_]{1,40}$")


def reading_of(event: dict[str, Any]) -> tuple[str, dict[str, Any]] | None:
    """(window, {utilization, resets_at}) from one ``rate_limit_event``, or None.

    ``rateLimitType`` names the window, ``resetsAt`` is epoch seconds, ``utilization``
    the 0-1 fraction. A REJECTED reading with no utilization is a full window. Anything
    that does not say all of that is dropped rather than guessed at.
    """
    info = event.get("rate_limit_info")
    if not isinstance(info, dict):
        return None
    name = info.get("rateLimitType")
    resets = info.get("resetsAt")
    if not isinstance(name, str) or not _WINDOW_NAME.match(name):
        return None
    if isinstance(resets, bool) or not isinstance(resets, int | float):
        return None
    utilization = info.get("utilization")
    if utilization is None and info.get("status") == "rejected":
        utilization = 1.0
    if isinstance(utilization, bool) or not isinstance(utilization, int | float):
        return None
    if not 0.0 <= float(utilization) <= 1.0:
        return None
    try:
        at = datetime.fromtimestamp(float(resets), tz=UTC)
    except (OverflowError, OSError, ValueError):
        return None
    return name, {"utilization": float(utilization), "resets_at": at.isoformat()}


class ClaudeCodeTransport:
    """``claude -p`` with tools, settings, MCP, slash commands and sessions all off."""

    def __init__(self, claude_bin: str | None = None, timeout: float | None = None):
        settings = get_llm_settings()
        self.claude_bin = claude_bin or settings.claude_bin
        self.timeout = timeout or settings.timeout_seconds

    def command(self, request: LlmRequest) -> list[str]:
        return [
            self.claude_bin,
            "-p",
            "--output-format", "stream-json",
            "--verbose",
            "--model", request.model,
            "--system-prompt", request.system,
            "--tools", "",
            "--setting-sources", "",
            "--strict-mcp-config",
            "--disable-slash-commands",
            "--no-session-persistence",
        ]  # fmt: skip

    def environment(self, token: str, request: LlmRequest, home: str) -> dict[str, str]:
        # Built from scratch: no ANTHROPIC_API_KEY or other credential from the server's
        # environment can leak in or take precedence over this call's token.
        return {
            "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
            "HOME": home,
            "CLAUDE_CODE_OAUTH_TOKEN": token,
            "CLAUDE_CODE_MAX_OUTPUT_TOKENS": str(request.max_tokens),
            "DISABLE_AUTOUPDATER": "1",
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
        }

    async def _spawn(
        self, token: str, request: LlmRequest, home: str, extra: tuple[str, ...] = ()
    ) -> asyncio.subprocess.Process:
        try:
            return await asyncio.create_subprocess_exec(
                *self.command(request),
                *extra,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=home,
                env=self.environment(token, request, home),
                start_new_session=True,
                preexec_fn=_die_with_parent(),
            )
        except FileNotFoundError:
            raise LlmUnavailable(
                f"Claude Code ({self.claude_bin}) is not installed on the server"
            ) from None

    async def stream(self, token: str, request: LlmRequest, on_text: OnText) -> TransportResult:
        """As :meth:`complete`, reading stdout line by line: each ``text_delta`` of a
        ``stream_event`` (``--include-partial-messages``) goes to ``on_text`` as it
        arrives; the readings and the final ``result`` line are read as ``parse`` reads
        them. A timeout or a cancel kills the process group first."""
        with tempfile.TemporaryDirectory(prefix="oracle-claude-") as home:
            proc = await self._spawn(token, request, home, ("--include-partial-messages",))
            assert proc.stdin is not None and proc.stdout is not None
            lines: list[bytes] = []

            async def read() -> bytes:
                assert proc.stdin is not None and proc.stdout is not None
                proc.stdin.write(render_prompt(request.messages).encode())
                await proc.stdin.drain()
                proc.stdin.close()
                async for raw in proc.stdout:
                    lines.append(raw)
                    text = _delta_text(raw)
                    if text:
                        await on_text(text)
                assert proc.stderr is not None
                stderr = await proc.stderr.read()
                await proc.wait()
                return stderr

            try:
                stderr = await asyncio.wait_for(read(), self.timeout)
            except TimeoutError:
                await _kill(proc)
                raise LlmUnavailable(f"Claude Code did not answer in {self.timeout:.0f}s") from None
            except BaseException:
                await _kill(proc)
                raise
        return self.parse(b"".join(lines), stderr, request)

    async def complete(self, token: str, request: LlmRequest) -> TransportResult:
        with tempfile.TemporaryDirectory(prefix="oracle-claude-") as home:
            try:
                proc = await asyncio.create_subprocess_exec(
                    *self.command(request),
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    cwd=home,
                    env=self.environment(token, request, home),
                    # Its own process group, so a kill reaches anything it started.
                    start_new_session=True,
                    preexec_fn=_die_with_parent(),
                )
            except FileNotFoundError:
                raise LlmUnavailable(
                    f"Claude Code ({self.claude_bin}) is not installed on the server"
                ) from None
            try:
                stdout, stderr = await asyncio.wait_for(
                    proc.communicate(render_prompt(request.messages).encode()), self.timeout
                )
            except TimeoutError:
                await _kill(proc)
                raise LlmUnavailable(f"Claude Code did not answer in {self.timeout:.0f}s") from None
            except BaseException:
                # Cancelled (the run ticker's time limit) or anything else: Claude Code
                # must be gone before the caller gives the account's hold back.
                await _kill(proc)
                raise
        return self.parse(stdout, stderr, request)

    @staticmethod
    def events(stdout: bytes) -> list[dict[str, Any]]:
        events: list[dict[str, Any]] = []
        for raw in stdout.splitlines():
            raw = raw.strip()
            if not raw.startswith(b"{"):
                continue
            try:
                event = json.loads(raw)
            except (ValueError, UnicodeDecodeError):
                continue
            if isinstance(event, dict):
                events.append(event)
        return events

    @classmethod
    def parse(cls, stdout: bytes, stderr: bytes, request: LlmRequest) -> TransportResult:
        readings: dict[str, dict[str, Any]] = {}
        rejected = False
        out: dict[str, Any] | None = None
        for event in cls.events(stdout):
            kind = event.get("type")
            if kind == "rate_limit_event":
                reading = reading_of(event)
                if reading is not None:
                    readings[reading[0]] = reading[1]
                info = event.get("rate_limit_info")
                status = info.get("status") if isinstance(info, dict) else None
                if (status or event.get("status")) == "rejected":
                    rejected = True
            elif kind == "result":
                out = event
        if out is None:
            tail = (stderr or stdout).decode(errors="replace").strip()[-300:]
            if rejected:
                raise LlmRateLimited("the account is out of quota", readings)
            raise LlmUnavailable(f"Claude Code failed: {tail or 'no output'}")
        message = str(out.get("result") or "")
        if out.get("is_error"):
            status = out.get("api_error_status")
            if rejected or status == 429:
                raise LlmRateLimited(message or "the account is out of quota", readings)
            if status in (401, 403) or "authenticat" in message.lower():
                raise LlmAuthError(message or "Claude rejected the token")
            raise LlmUnavailable(message or f"Claude Code failed ({out.get('subtype')})")
        models = list((out.get("modelUsage") or {}).keys())
        usage = dict(out.get("usage") or {})
        # What Claude Code reports the call cost, for the job's record.
        cost = out.get("total_cost_usd")
        if isinstance(cost, int | float) and not isinstance(cost, bool):
            usage["total_cost_usd"] = cost
        return TransportResult(
            text=message,
            model=models[0] if models else request.model,
            stop_reason=out.get("stop_reason"),
            usage=usage,
            readings=readings,
        )


def _delta_text(raw: bytes) -> str:
    """The text of one ``stream_event`` line carrying a ``text_delta``, else ''."""
    raw = raw.strip()
    if not raw.startswith(b"{"):
        return ""
    try:
        event = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        return ""
    if not isinstance(event, dict) or event.get("type") != "stream_event":
        return ""
    inner = event.get("event")
    if not isinstance(inner, dict) or inner.get("type") != "content_block_delta":
        return ""
    delta = inner.get("delta")
    if isinstance(delta, dict) and delta.get("type") == "text_delta":
        return str(delta.get("text") or "")
    return ""


#: prctl(2) option: the signal the calling process gets when its parent dies.
PR_SET_PDEATHSIG = 1


def _die_with_parent() -> Callable[[], None] | None:
    """On Linux, what makes Claude Code die (SIGKILL) when the API process does.

    A cancelled call kills the process group itself (``_kill``); this covers the API
    process dying first, SIGKILLed or OOM-killed, which runs no ``finally``. It reaches
    Claude Code only, not what Claude Code started (``--tools ""``: nothing, normally),
    and fires when the thread that started it exits (the event loop's thread). Elsewhere,
    and for those, nothing kills them but the container's end (Cloud Run's instance
    shutdown, or a restart); the account's hold expires meanwhile and the sweep
    reclaims it (``store.prune_holds``).
    """
    if not sys.platform.startswith("linux"):
        return None
    prctl = _prctl()
    if prctl is None:
        return None
    parent = os.getpid()

    def preexec() -> None:
        # In the child, after fork and setsid, before exec: no allocation, no locks.
        prctl(PR_SET_PDEATHSIG, signal.SIGKILL, 0, 0, 0)
        if os.getppid() != parent:
            os._exit(1)  # the parent died before the signal was armed

    return preexec


@lru_cache
def _prctl() -> Callable[..., int] | None:
    # Resolved before any fork: loading a library in the child is not safe.
    try:
        return ctypes.CDLL(None, use_errno=True).prctl
    except (OSError, AttributeError):
        return None


async def _kill(proc: asyncio.subprocess.Process) -> None:
    """Kill Claude Code's process group and wait until it is gone, even if cancelled."""
    if proc.returncode is None:
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(proc.pid, signal.SIGKILL)
        with contextlib.suppress(ProcessLookupError):
            proc.kill()
    waiting = asyncio.ensure_future(proc.wait())
    cancelled = False
    while not waiting.done():
        try:
            await asyncio.shield(waiting)
        except asyncio.CancelledError:
            cancelled = True
    if cancelled:
        raise asyncio.CancelledError


class MessagesApiTransport:
    """``POST /v1/messages`` with an API key."""

    def __init__(self, http: httpx.AsyncClient | None = None, base_url: str = ANTHROPIC_API):
        self.http = http
        self.base_url = base_url

    async def complete(self, token: str, request: LlmRequest) -> TransportResult:
        body = {
            "model": request.model,
            "max_tokens": request.max_tokens,
            "system": request.system,
            "messages": request.messages,
        }
        headers = {
            "x-api-key": token,
            "anthropic-version": ANTHROPIC_VERSION,
            "content-type": "application/json",
        }
        timeout = get_llm_settings().timeout_seconds
        try:
            if self.http is not None:
                resp = await self.http.post(
                    f"{self.base_url}/v1/messages", json=body, headers=headers, timeout=timeout
                )
            else:
                async with httpx.AsyncClient(timeout=timeout) as http:
                    resp = await http.post(
                        f"{self.base_url}/v1/messages", json=body, headers=headers
                    )
        except httpx.HTTPError as e:
            raise LlmUnavailable(f"Cannot reach the Claude API: {e}") from e
        if resp.status_code in (401, 403):
            raise LlmAuthError(f"Claude rejected the API key ({resp.status_code})")
        if resp.status_code >= 400:
            try:
                detail = resp.json().get("error", {}).get("message", "")
            except ValueError:
                detail = ""
            raise LlmUnavailable(f"Claude API answered {resp.status_code}: {detail}".rstrip(": "))
        data = resp.json()
        blocks = data.get("content", [])
        text = "".join(b.get("text", "") for b in blocks if b.get("type") == "text")
        return TransportResult(
            text=text,
            model=data.get("model", request.model),
            stop_reason=data.get("stop_reason"),
            usage=data.get("usage") or {},
        )

    async def stream(self, token: str, request: LlmRequest, on_text: OnText) -> TransportResult:
        """``"stream": true``: each ``content_block_delta`` text goes to ``on_text``; the
        usage comes from ``message_start`` and ``message_delta``."""
        body = {
            "model": request.model,
            "max_tokens": request.max_tokens,
            "system": request.system,
            "messages": request.messages,
            "stream": True,
        }
        headers = {
            "x-api-key": token,
            "anthropic-version": ANTHROPIC_VERSION,
            "content-type": "application/json",
        }
        timeout = get_llm_settings().timeout_seconds
        parts: list[str] = []
        usage: dict[str, Any] = {}
        model, stop_reason = request.model, None
        own = self.http is None
        http = httpx.AsyncClient(timeout=timeout) if own else self.http
        assert http is not None
        try:
            async with http.stream(
                "POST", f"{self.base_url}/v1/messages", json=body, headers=headers, timeout=timeout
            ) as resp:
                if resp.status_code in (401, 403):
                    raise LlmAuthError(f"Claude rejected the API key ({resp.status_code})")
                if resp.status_code >= 400:
                    await resp.aread()
                    raise LlmUnavailable(f"Claude API answered {resp.status_code}")
                async for event, data in sse_events(resp.aiter_lines()):
                    if event == "content_block_delta":
                        delta = data.get("delta") or {}
                        if delta.get("type") == "text_delta" and delta.get("text"):
                            parts.append(delta["text"])
                            await on_text(delta["text"])
                    elif event == "message_start":
                        message = data.get("message") or {}
                        model = message.get("model") or model
                        usage.update(message.get("usage") or {})
                    elif event == "message_delta":
                        usage.update(data.get("usage") or {})
                        stop_reason = (data.get("delta") or {}).get("stop_reason") or stop_reason
                    elif event == "error":
                        error = data.get("error") or {}
                        raise LlmUnavailable(f"Claude API failed: {error.get('message', '')}")
                    elif event == "message_stop":
                        break
        except httpx.HTTPError as e:
            raise LlmUnavailable(f"Cannot reach the Claude API: {e}") from e
        finally:
            if own:
                await http.aclose()
        return TransportResult(
            text="".join(parts), model=model, stop_reason=stop_reason, usage=usage
        )


async def sse_events(lines: Any) -> Any:
    """(event, data) of each server-sent event whose data is a JSON object."""
    event, data = "", []
    async for line in lines:
        if line == "":
            if data:
                try:
                    parsed = json.loads("\n".join(data))
                except ValueError:
                    parsed = None
                if isinstance(parsed, dict):
                    yield event or str(parsed.get("type") or ""), parsed
            event, data = "", []
        elif line.startswith("event:"):
            event = line[6:].strip()
        elif line.startswith("data:"):
            data.append(line[5:].strip())
    if data:
        try:
            parsed = json.loads("\n".join(data))
        except ValueError:
            return
        if isinstance(parsed, dict):
            yield event or str(parsed.get("type") or ""), parsed
