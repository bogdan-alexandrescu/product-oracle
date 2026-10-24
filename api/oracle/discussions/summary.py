"""Oracle's summary draft of a discussion (G3 3.6, c5): what agents get, with the typed
changes and a link.

At most 1,200 characters in three parts ("Decided:", "Open:", "Context:"), drafted from
the same context rules as replies (G2 3.3). On demand (``POST …/summary``), and for the
minute tick once a discussion is closed or its first change is staged, so G5 always has
one to give the agents. A summary the starter confirmed is replaced only when the starter
asks.

The queue drafts the discussion waiting longest first (closed, or last changed, earliest). A
failed draft is audited (``discussion.summary_failed``, the error's class, never text) and
waits ``BACKOFF`` doubled per failure, at most ``MAX_BACKOFF``, before the tick tries again.
Oracle drafts without holding the discussion's row lock; the draft is stored under the lock
only if the discussion still has no summary.
"""

import asyncio
import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING

from sqlalchemy import exists, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.discussions import access, context, kinds
from oracle.discussions.models import MAX_SUMMARY, Discussion, DiscussionChange
from oracle.jobs import prompting
from oracle.llm import gateway
from oracle.llm.transports import get_llm_settings
from oracle.models import AuditEvent
from oracle.tenancy import tenant_session

if TYPE_CHECKING:
    from oracle.auth.deps import Principal

log = logging.getLogger(__name__)

JOB = "discussion_summary"
MAX_TOKENS = 600
TIMEOUT = 60.0
CONFIRMED = "The starter confirmed this summary. They can ask Oracle for a new draft."
QUEUED = "discussion.summary_queued"
FAILED = "discussion.summary_failed"
BACKOFF = timedelta(minutes=2)
MAX_BACKOFF = timedelta(hours=2)
# 2 min doubled per failure: 2, 4, 8, ... minutes, at most MAX_BACKOFF.
_MAX_DOUBLINGS = 6


async def draft(db: AsyncSession, d: Discussion) -> str:
    """Oracle's draft for the discussion, cut to 1,200 characters."""
    ctx = await context.build(db, d, uuid.uuid4())
    rows = await db.scalars(
        select(DiscussionChange).where(
            DiscussionChange.discussion_id == d.id,
            DiscussionChange.status.in_(("staged", "done")),
        )
    )
    done = [f"- {c.status}: {kinds.label(c.kind, c.edited_payload or c.payload)}" for c in rows]
    _name, system = prompting.current(JOB)
    user = "\n".join(
        [ctx.text(), "Staged or done changes:", *(done or ["- none"]),
         "Summarize this discussion."]
    )  # fmt: skip
    answer = await asyncio.wait_for(
        gateway.complete(
            db, system, [{"role": "user", "content": user}], MAX_TOKENS, job=JOB,
            model=get_llm_settings().chat_model or None,
        ),
        TIMEOUT,
    )  # fmt: skip
    text = prompting.as_str(answer.text, MAX_SUMMARY)
    return text or "Decided: nothing yet."


def _store(d: Discussion, text: str) -> None:
    d.summary, d.summary_status = text, "draft"
    d.summary_by, d.summary_at = None, datetime.now(UTC)


async def ask(
    db: AsyncSession, principal: "Principal", discussion_id: uuid.UUID, replace: bool
) -> Discussion:
    """``POST /v1/discussions/{id}/summary``: a writer in it asks for a draft now."""
    from oracle.authz import recheck_caller
    from oracle.discussions import service

    await recheck_caller(db, principal, "viewer")
    d, _parts, seat = await service.readable(db, principal, discussion_id)
    if not access.can_write(seat):
        raise service.DiscussionError(403, service.VIEWERS_READ)
    if d.summary_status == "confirmed" and not (replace and seat.starter):
        raise service.DiscussionError(409, CONFIRMED)
    text = await draft(db, d)
    _store(d, text)
    await audit.record(
        db, principal, "discussion.summary_draft", service.ENTITY, d.id, {"length": len(text)}
    )
    await db.flush()
    return d


async def queue(db: AsyncSession, d: Discussion) -> None:
    """Queued for the minute tick: a closed discussion, or its first change staged, with
    no summary yet (:func:`run_queued` finds them)."""
    if d.summary_status == "none":
        await audit.record(db, None, QUEUED, "discussion", d.id, {})


def _failures():
    """Each discussion's failed drafts: how many, and the last one's time."""
    return (
        select(
            AuditEvent.entity_id.label("discussion_id"),
            func.count().label("n"),
            func.max(AuditEvent.created_at).label("at"),
        )
        .where(AuditEvent.action == FAILED, AuditEvent.entity == "discussion")
        .group_by(AuditEvent.entity_id)
        .subquery()
    )


def _due():
    """The discussions waiting for a draft whose backoff is over, longest waiting first."""
    handled = exists().where(
        DiscussionChange.discussion_id == Discussion.id,
        DiscussionChange.status.in_(("staged", "done")),
    )
    fails = _failures()
    seconds = func.least(
        BACKOFF.total_seconds() * func.power(2, func.least(fails.c.n - 1, _MAX_DOUBLINGS)),
        MAX_BACKOFF.total_seconds(),
    )
    wait = func.make_interval(0, 0, 0, 0, 0, 0, seconds)
    return (
        select(Discussion.id)
        .outerjoin(fails, fails.c.discussion_id == Discussion.id)
        .where(
            Discussion.summary_status == "none",
            (Discussion.status == "closed") | handled,
            fails.c.n.is_(None) | (fails.c.at + wait <= func.now()),
        )
        .order_by(func.coalesce(Discussion.closed_at, Discussion.updated_at), Discussion.id)
    )


async def run_queued(tenant_id: uuid.UUID, limit: int = 5) -> int:
    """The tick: draft the summaries waiting, longest waiting first; how many were written."""
    async with tenant_session(tenant_id) as db:
        ids = list(await db.scalars(_due().limit(limit)))
    written = 0
    for discussion_id in ids:
        # Drafted without a row lock: a close, rename or message never waits on Oracle.
        async with tenant_session(tenant_id) as db:
            d = await db.get(Discussion, discussion_id)
            if d is None or d.summary_status != "none":
                continue
            try:
                text = await draft(db, d)
            except Exception as e:
                log.info("discussion summary %s failed: %s", discussion_id, type(e).__name__)
                await db.rollback()
                attempt = 1 + (
                    await db.scalar(
                        select(func.count()).where(
                            AuditEvent.action == FAILED, AuditEvent.entity_id == discussion_id
                        )
                    )
                    or 0
                )
                await audit.record(
                    db, None, FAILED, "discussion", discussion_id,
                    {"error": type(e).__name__, "attempt": attempt},
                )  # fmt: skip
                await db.commit()
                continue
            await db.rollback()
        async with tenant_session(tenant_id) as db:
            d = await db.get(Discussion, discussion_id, with_for_update=True)
            if d is None or d.summary_status != "none":
                continue
            _store(d, text)
            await db.commit()
            written += 1
    return written
