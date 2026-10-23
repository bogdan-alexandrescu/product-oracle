"""The fallback credential: what built-in jobs run on while no account is registered.

SwarmCloud's tenant secret (``swarm-tenant-<id>-anthropic``) in Oracle's database: a
``claude setup-token`` value (run through Claude Code) or an Anthropic API key (the
Messages API), encrypted with oracle.crypto. It is used ONLY when the pool answers
``no_accounts_registered``; a pool whose accounts are spent or paused is a wait, and
must not quietly fall back to one shared credential.
"""

import os
import uuid
from dataclasses import dataclass

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import crypto
from oracle.claude_accounts.models import ClaudeFallbackCredential

# Built from parts so the source holds no credential-shaped literal.
PLAN_TOKEN_PREFIX = "-".join(("sk", "ant", "oat"))
API_KEY_PREFIX = "-".join(("sk", "ant", "api"))
# ``ORACLE_ANTHROPIC_API_URL``: where the Messages API is (a fake one in the real-stack test).
ANTHROPIC_API = os.environ.get("ORACLE_ANTHROPIC_API_URL", "https://api.anthropic.com").rstrip("/")
ANTHROPIC_VERSION = "2023-06-01"


class NotAClaudeCredential(ValueError):
    pass


def token_kind(token: str) -> str:
    """``plan`` for a ``claude setup-token`` value, ``api_key`` for an API key."""
    if token.startswith(PLAN_TOKEN_PREFIX):
        return "plan"
    if token.startswith(API_KEY_PREFIX):
        return "api_key"
    raise NotAClaudeCredential(
        "Not a Claude credential: paste the value printed by `claude setup-token` "
        "or an Anthropic API key"
    )


def label_for(kind: str, token: str) -> str:
    tail = token[-4:]
    return f"Claude setup-token …{tail}" if kind == "plan" else f"Anthropic API key …{tail}"


@dataclass(frozen=True)
class Fallback:
    kind: str
    label: str
    token: str


async def describe(session: AsyncSession) -> ClaudeFallbackCredential | None:
    return await session.scalar(select(ClaudeFallbackCredential))


async def load(session: AsyncSession) -> Fallback | None:
    row = await describe(session)
    if row is None:
        return None
    return Fallback(row.kind, row.label, crypto.decrypt(row.ciphertext).decode())


async def store(
    session: AsyncSession, token: str, updated_by: uuid.UUID | None
) -> ClaudeFallbackCredential:
    """Replace the fallback credential (the caller commits)."""
    token = token.strip()
    kind = token_kind(token)
    row = await describe(session)
    if row is None:
        row = ClaudeFallbackCredential(kind=kind, label="", ciphertext=b"", key_version=0)
        session.add(row)
    row.kind = kind
    row.label = label_for(kind, token)
    row.ciphertext = crypto.encrypt(token.encode())
    row.key_version = crypto.KEY_VERSION
    row.updated_by = updated_by
    await session.flush()
    return row


async def clear(session: AsyncSession) -> None:
    await session.execute(delete(ClaudeFallbackCredential))
