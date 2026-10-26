"""Live tokens (#710 section 3): one Ask reply's right to read its asker's sources live.

``replies._produce`` mints an ``olt_`` token for a reply in a private chat whose asker has
a live connection and hands it to the reply's Claude Code run as Oracle's MCP server's
bearer. Only its sha256 is stored. On ``/mcp`` it acts as the asker with the
``live:sources`` scope only (``tools/list`` shows the ``live_*`` tools alone); each tool's
in-process REST call carries the raw token in :data:`HEADER`, so the live route knows
the call is that reply's. The token lives :data:`TTL` at most and is revoked when the
reply ends (complete, failed or cancelled).

Every call made with a token re-checks, in one transaction (amendment C3), with the
discussion row ``FOR SHARE``: the token unexpired and unrevoked, its reply still
``streaming``, only the asker in the (private) discussion; then counts the reply's calls
(at most :data:`MAX_READS`, cached and failed ones included, C1) and writes the call's
``live_reads`` row before the source is asked. Adding a person, or opening the
discussion, takes the same row ``FOR UPDATE`` and is refused while a live read or a live
token is in the chat (:func:`holds_live_reads`), so no read happens after someone joined.
"""

import dataclasses
import secrets
import uuid
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException, Request, status
from sqlalchemy import DateTime, ForeignKey, Text, Uuid, exists, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Mapped, mapped_column

from oracle.auth.service import hash_token
from oracle.db import Base, TenantScoped
from oracle.live.models import LiveRead
from oracle.tenancy import unscoped_session

PREFIX = "olt_"
SCOPE = "live:sources"
TTL = timedelta(minutes=10)
MAX_READS = 8
# The in-process REST call of an olt_ caller's tool carries its token here.
HEADER = "x-oracle-live-token"

JOINED = "Live reads stopped: someone else joined this discussion."
ENDED = "Live reads stopped: this answer has ended."
CAP = f"This answer has used its {MAX_READS} live reads; ask a narrower question"
IN_CHAT_CODE = "live_reads_in_chat"
IN_CHAT = (
    "This chat holds what Oracle read from your sources. Use Share as discussion to share "
    "an edited summary instead."
)


class LiveToken(TenantScoped, Base):
    __tablename__ = "live_tokens"

    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    message_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("discussion_messages.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # sha256 hex of the raw token; globally unique so a token resolves its tenant.
    token_hash: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


def _now() -> datetime:
    return datetime.now(UTC)


async def mint(db: AsyncSession, user_id: uuid.UUID, message_id: uuid.UUID) -> str:
    """A token for ``message_id``'s run acting as ``user_id``; the raw token (the caller
    commits)."""
    raw = PREFIX + secrets.token_urlsafe(32)
    db.add(
        LiveToken(
            user_id=user_id,
            message_id=message_id,
            token_hash=hash_token(raw),
            expires_at=_now() + TTL,
        )
    )
    await db.flush()
    return raw


async def revoke(db: AsyncSession, message_id: uuid.UUID) -> int:
    """Revoke the reply's tokens (the caller commits); how many were active."""
    result = await db.execute(
        update(LiveToken)
        .where(LiveToken.message_id == message_id, LiveToken.revoked_at.is_(None))
        .values(revoked_at=_now())
        .execution_options(synchronize_session=False)
    )
    return result.rowcount


def _usable(token: LiveToken | None, now: datetime) -> bool:
    return token is not None and token.revoked_at is None and token.expires_at > now


async def verify_live_token(raw: str):
    """The MCP caller of an active ``olt_`` token: its person, ``live:sources`` only."""
    from oracle.auth import service
    from oracle.auth.models import User
    from oracle.mcp.auth import user_caller

    if not raw.startswith(PREFIX):
        return None
    now = _now()
    async with unscoped_session() as s:
        token = await s.scalar(select(LiveToken).where(LiveToken.token_hash == hash_token(raw)))
        if not _usable(token, now):
            return None
        assert token is not None
        user = await s.get(User, token.user_id)
        if not service.may_sign_in(user) or user.tenant_id != token.tenant_id:
            return None
        token.last_used_at = now
        await s.commit()
    caller = user_caller(user, scopes=frozenset({SCOPE}), token_id=token.id)
    return dataclasses.replace(
        caller, credentials={**caller.credentials, HEADER: raw}, read_only=True
    )


def _stopped(detail: str) -> HTTPException:
    return HTTPException(status.HTTP_403_FORBIDDEN, detail)


async def bound(db: AsyncSession, request: Request, user_id: uuid.UUID | None) -> LiveToken | None:
    """The live token a live call was made with (:data:`HEADER`), None without one; 403
    when it is unknown, another person's, revoked or expired."""
    raw = request.headers.get(HEADER)
    if not raw:
        return None
    token = await db.scalar(select(LiveToken).where(LiveToken.token_hash == hash_token(raw)))
    if token is None or token.user_id != user_id or not _usable(token, _now()):
        raise _stopped(ENDED)
    return token


async def reserve(
    db: AsyncSession,
    token: LiveToken,
    connection_id: uuid.UUID | None,
    tool: str,
    label: str,
    item_id: str | None,
) -> uuid.UUID:
    """C3: in one transaction, with the discussion row FOR SHARE, re-check that the
    token's reply may still read and record the call (``error`` until it succeeds, no
    ref). Commits; raises 403 or the 429 of the reply's 8 (rolled back)."""
    from oracle.discussions.models import Discussion, DiscussionMessage
    from oracle.discussions.replies import people_in

    try:
        reply = await db.scalar(
            select(DiscussionMessage).where(DiscussionMessage.id == token.message_id)
        )
        d = None
        if reply is not None:
            d = await db.scalar(
                select(Discussion)
                .where(Discussion.id == reply.discussion_id)
                .with_for_update(read=True)
                .execution_options(populate_existing=True)
            )
        # The calls of one reply one at a time: their count and their refs.
        held = await db.scalar(
            select(LiveToken)
            .where(LiveToken.id == token.id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        if d is None or reply is None or not _usable(held, _now()):
            raise _stopped(ENDED)
        await db.refresh(reply, ["status"])
        if reply.status != "streaming":
            raise _stopped(ENDED)
        if d.visibility != "private" or await people_in(db, d) != {token.user_id}:
            raise _stopped(JOINED)
        made = await db.scalar(
            select(func.count())
            .select_from(LiveRead)
            .where(LiveRead.message_id == token.message_id, LiveRead.read_at >= token.created_at)
        )
        if (made or 0) >= MAX_READS:
            raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, CAP)
    except HTTPException:
        await db.rollback()
        raise
    read = LiveRead(
        user_id=token.user_id,
        message_id=token.message_id,
        connection_id=connection_id,
        tool=tool,
        source_label=label,
        item_id=item_id,
        status="error",
    )
    db.add(read)
    held.last_used_at = _now()
    await db.commit()
    return read.id


async def settle(
    db: AsyncSession, token: LiveToken, read_id: uuid.UUID, outcome: str
) -> int | None:
    """A reserved call's outcome; a successful one (``ok`` or ``cached``) gets the reply's
    next ref (C1: in call order, failed calls get none). Commits."""
    if outcome == "error":
        return None
    await db.scalar(select(LiveToken.id).where(LiveToken.id == token.id).with_for_update())
    last = await db.scalar(
        select(func.max(LiveRead.ref_n)).where(LiveRead.message_id == token.message_id)
    )
    n = (last or 0) + 1
    await db.execute(
        update(LiveRead)
        .where(LiveRead.id == read_id)
        .values(status=outcome, ref_n=n)
        .execution_options(synchronize_session=False)
    )
    await db.commit()
    return n


async def holds_live_reads(db: AsyncSession, discussion_id: uuid.UUID) -> bool:
    """Whether a message of the discussion has a live read, or an unrevoked unexpired
    live token (a reply that may read right now)."""
    from oracle.discussions.models import DiscussionMessage

    messages = select(DiscussionMessage.id).where(DiscussionMessage.discussion_id == discussion_id)
    reads = exists().where(LiveRead.message_id.in_(messages))
    live = exists().where(
        LiveToken.message_id.in_(messages),
        LiveToken.revoked_at.is_(None),
        LiveToken.expires_at > func.now(),
    )
    return bool(await db.scalar(select(or_(reads, live))))
