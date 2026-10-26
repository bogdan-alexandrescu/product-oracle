"""Run tokens: short-lived, run-scoped credentials for agents calling Oracle's MCP server.

A raw token (``ort_...``) is shown once, at mint time; only its sha256 is stored, like
API tokens. ``verify_run_token`` runs before a tenant is known, so it is an unscoped
lookup, and returns the claims only for a known, unexpired, unrevoked token.
"""

import secrets
import uuid
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Text, Uuid, select, update
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Mapped, mapped_column

from oracle.auth.service import hash_token
from oracle.db import Base, TenantScoped
from oracle.tenancy import unscoped_session

RUN_TOKEN_PREFIX = "ort_"
SCOPES = (
    "read:sources",
    "read:baseline",
    "read:documents",
    "write:proposals",
    "write:drafts",
    # H7: Oracle's web tools (search_web, fetch_web_page); the competitive digest's
    # segment only (migration 0052_market).
    "read:web",
    # INT2: the one run-bound read of an intake's analysis input (the job's payload); the
    # intake_analysis segment only (migration 0068_intake_read).
    "read:intake-input",
)


class RunToken(TenantScoped, Base):
    __tablename__ = "run_tokens"
    __table_args__ = (
        CheckConstraint(
            "cardinality(scopes) > 0 AND scopes <@ ARRAY["
            + ", ".join(repr(s) for s in SCOPES)
            + "]::text[]",
            name="scopes",
        ),
    )

    run_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("runs.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # sha256 hex of the raw token; globally unique so a token resolves its tenant.
    token_hash: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    scopes: Mapped[list[str]] = mapped_column(ARRAY(Text), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class UnknownScopeError(ValueError):
    """A scope outside :data:`SCOPES` was requested."""


@dataclass(frozen=True)
class RunTokenClaims:
    tenant_id: uuid.UUID
    run_id: uuid.UUID
    scopes: frozenset[str]
    token_id: uuid.UUID
    expires_at: datetime


async def mint_run_token(
    session: AsyncSession, run_id: uuid.UUID, scopes: Iterable[str], ttl_seconds: int
) -> str:
    """Create a token for a run of the session's tenant. Returns the raw token; show once."""
    from oracle.runs.models import Run

    wanted = sorted(set(scopes))
    unknown = [s for s in wanted if s not in SCOPES]
    if unknown:
        raise UnknownScopeError(f"unknown run-token scopes: {', '.join(unknown)}")
    if not wanted:
        raise UnknownScopeError("a run token needs at least one scope")
    if ttl_seconds <= 0:
        raise ValueError("ttl_seconds must be positive")
    # Scoped get: a run of another tenant is not found.
    if await session.get(Run, run_id) is None:
        raise LookupError(f"run {run_id} not found")
    raw = RUN_TOKEN_PREFIX + secrets.token_urlsafe(32)
    session.add(
        RunToken(
            run_id=run_id,
            token_hash=hash_token(raw),
            scopes=wanted,
            expires_at=datetime.now(UTC) + timedelta(seconds=ttl_seconds),
        )
    )
    await session.flush()
    return raw


async def verify_run_token(raw: str) -> RunTokenClaims | None:
    """Claims of an active token and record its use; ``None`` if unknown, expired or revoked."""
    if not raw.startswith(RUN_TOKEN_PREFIX):
        return None
    now = datetime.now(UTC)
    async with unscoped_session() as s:
        token = await s.scalar(select(RunToken).where(RunToken.token_hash == hash_token(raw)))
        if token is None or token.revoked_at is not None or token.expires_at <= now:
            return None
        token.last_used_at = now
        await s.commit()
        return RunTokenClaims(
            tenant_id=token.tenant_id,
            run_id=token.run_id,
            scopes=frozenset(token.scopes),
            token_id=token.id,
            expires_at=token.expires_at,
        )


async def revoke_run_tokens(session: AsyncSession, run_id: uuid.UUID) -> int:
    """Revoke every active token of a run (the caller commits). Returns how many."""
    result = await session.execute(
        update(RunToken)
        .where(RunToken.run_id == run_id, RunToken.revoked_at.is_(None))
        .values(revoked_at=datetime.now(UTC))
        .execution_options(synchronize_session=False)
    )
    return result.rowcount
