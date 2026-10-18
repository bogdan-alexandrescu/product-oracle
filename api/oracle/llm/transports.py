"""How a model call reaches Claude, by credential kind.

- A Claude plan token (``claude setup-token``) runs the call through Claude Code in
  headless mode (``claude -p``), with ``CLAUDE_CODE_OAUTH_TOKEN`` set for that one
  process. Oracle never sends a plan token to the Messages API itself.
- An Anthropic API key calls the Messages API with ``x-api-key``.

Both implement :class:`Transport`; tests swap in a fake (``gateway.set_transports``).
"""

import asyncio
import json
import os
import tempfile
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any, Protocol

import httpx
from pydantic_settings import BaseSettings, SettingsConfigDict

from oracle.connections.providers import ANTHROPIC_API, ANTHROPIC_VERSION


class LlmSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="ORACLE_LLM_", env_file=".env", extra="ignore")

    # Model for Oracle's own calls, unless the caller names one.
    model: str = "claude-opus-5"
    # The Claude Code executable used for plan tokens.
    claude_bin: str = "claude"
    timeout_seconds: float = 300.0


@lru_cache
def get_llm_settings() -> LlmSettings:
    return LlmSettings()


class LlmError(Exception):
    """Base class of model call failures."""


class NoClaudePlan(LlmError):
    """Neither the user nor the company has a usable Claude connection."""


class LlmAuthError(LlmError):
    """Claude rejected the credential (expired, revoked, wrong token)."""


class LlmUnavailable(LlmError):
    """The call failed for another reason (network, rate limit, Claude Code missing)."""


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


class Transport(Protocol):
    async def complete(self, token: str, request: LlmRequest) -> TransportResult: ...


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
            "--output-format", "json",
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
        # environment can leak in or take precedence over the user's plan token.
        return {
            "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
            "HOME": home,
            "CLAUDE_CODE_OAUTH_TOKEN": token,
            "CLAUDE_CODE_MAX_OUTPUT_TOKENS": str(request.max_tokens),
            "DISABLE_AUTOUPDATER": "1",
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
        }

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
                proc.kill()
                await proc.wait()
                raise LlmUnavailable(f"Claude Code did not answer in {self.timeout:.0f}s") from None
        return self.parse(stdout, stderr, request)

    @staticmethod
    def parse(stdout: bytes, stderr: bytes, request: LlmRequest) -> TransportResult:
        try:
            out = json.loads(stdout)
        except ValueError:
            tail = (stderr or stdout).decode(errors="replace").strip()[-300:]
            raise LlmUnavailable(f"Claude Code failed: {tail or 'no output'}") from None
        message = str(out.get("result") or "")
        if out.get("is_error"):
            status = out.get("api_error_status")
            if status in (401, 403) or "authenticat" in message.lower():
                raise LlmAuthError(message or "Claude rejected the plan token")
            raise LlmUnavailable(message or f"Claude Code failed ({out.get('subtype')})")
        models = list((out.get("modelUsage") or {}).keys())
        return TransportResult(
            text=message,
            model=models[0] if models else request.model,
            stop_reason=out.get("stop_reason"),
            usage=out.get("usage") or {},
        )


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
