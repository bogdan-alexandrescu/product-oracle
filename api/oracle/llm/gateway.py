"""Oracle's own model calls, paid for by a connected Claude plan.

    text = (await gateway.complete(session, user_id, system, messages, max_tokens)).text

Which Claude connection pays: the user's own active one (the most recently updated if
they have a plan and an API key), else the company default
(``default_claude_connection_id``), else :class:`NoClaudePlan`. A plan token runs
through Claude Code headless; an API key calls the Messages API (``transports``).
When Claude rejects the credential the connection is marked ``expired``.
"""

import uuid
from dataclasses import dataclass, field
from typing import Any, Literal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.connections import service
from oracle.connections.models import Connection
from oracle.connections.providers import CredentialRejected, ProviderUnavailable
from oracle.llm.transports import (
    ClaudeCodeTransport,
    LlmAuthError,
    LlmRequest,
    LlmUnavailable,
    MessagesApiTransport,
    NoClaudePlan,
    Transport,
    get_llm_settings,
)

NO_PLAN_MESSAGE = (
    "No Claude plan connected: connect yours in Settings > Connections "
    "(`claude setup-token`), or ask an owner to set a company default plan"
)


@dataclass
class Transports:
    plan: Transport = field(default_factory=ClaudeCodeTransport)
    api_key: Transport = field(default_factory=MessagesApiTransport)

    def for_kind(self, kind: str) -> Transport:
        return self.api_key if kind == "api_key" else self.plan


_transports: Transports | None = None


def get_transports() -> Transports:
    global _transports
    if _transports is None:
        _transports = Transports()
    return _transports


def set_transports(transports: Transports | None) -> Transports | None:
    """Replace the transports (tests); returns the previous ones."""
    global _transports
    previous, _transports = _transports, transports
    return previous


@dataclass(frozen=True)
class Completion:
    text: str
    model: str
    stop_reason: str | None
    usage: dict[str, Any]
    connection_id: uuid.UUID
    # Whose plan paid: the user's own or the company default.
    plan: Literal["own", "company"]
    via: Literal["plan", "api_key"]


@dataclass(frozen=True)
class PlanChoice:
    connection: Connection | None
    source: Literal["own", "company", "none"]
    # Why there is no usable plan, for the UI and the error.
    reason: str | None = None


async def choose_plan(session: AsyncSession, user_id: uuid.UUID) -> PlanChoice:
    own = await session.scalar(
        select(Connection)
        .where(
            Connection.user_id == user_id,
            Connection.provider == "claude",
            Connection.status == "active",
        )
        .order_by(Connection.updated_at.desc())
        .limit(1)
    )
    if own is not None:
        return PlanChoice(own, "own")

    from oracle.tenant_settings_api import get_setting

    default_id = await get_setting(session, "default_claude_connection_id")
    if not default_id:
        return PlanChoice(None, "none", NO_PLAN_MESSAGE)
    default = await session.get(Connection, uuid.UUID(default_id))
    if default is None or default.provider != "claude":
        return PlanChoice(None, "none", NO_PLAN_MESSAGE)
    if default.status != "active":
        return PlanChoice(
            None,
            "none",
            f"The company's default Claude plan is {default.status}; connect your own plan "
            "or ask an owner to reconnect it",
        )
    return PlanChoice(default, "company")


async def complete(
    session: AsyncSession,
    user_id: uuid.UUID,
    system: str,
    messages: list[dict[str, Any]],
    max_tokens: int,
    *,
    model: str | None = None,
    transports: Transports | None = None,
) -> Completion:
    """Run one model call for ``user_id``. Commits the session (connection bookkeeping)."""
    choice = await choose_plan(session, user_id)
    if choice.connection is None:
        raise NoClaudePlan(choice.reason or NO_PLAN_MESSAGE)
    conn = choice.connection
    try:
        credential = await service.credential_for(session, conn)
    except service.ConnectionUnavailable as e:
        raise NoClaudePlan(str(e)) from e
    kind = credential.extra.get("kind", "plan")
    request = LlmRequest(
        system=system,
        messages=messages,
        max_tokens=max_tokens,
        model=model or get_llm_settings().model,
    )
    transport = (transports or get_transports()).for_kind(kind)
    try:
        result = await transport.complete(credential.access_token, request)
    except LlmAuthError as e:
        await service.mark_failure(session, conn, "expired", str(e))
        raise
    return Completion(
        text=result.text,
        model=result.model,
        stop_reason=result.stop_reason,
        usage=result.usage,
        connection_id=conn.id,
        plan=choice.source,  # type: ignore[arg-type]
        via=kind,
    )


async def verify_plan_token(token: str, transports: Transports | None = None) -> None:
    """Check a ``claude setup-token`` value with a tiny call through Claude Code."""
    request = LlmRequest(
        system="Reply with the single word OK.",
        messages=[{"role": "user", "content": "OK?"}],
        max_tokens=16,
        model=get_llm_settings().model,
    )
    try:
        await (transports or get_transports()).plan.complete(token, request)
    except LlmAuthError as e:
        raise CredentialRejected(f"Claude rejected the plan token: {e}") from e
    except LlmUnavailable as e:
        raise ProviderUnavailable(str(e)) from e
