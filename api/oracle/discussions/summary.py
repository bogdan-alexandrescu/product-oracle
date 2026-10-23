"""Oracle's summary draft of a discussion (G3 3.6, c5): what agents get, with the typed
changes and a link.

At most 1,200 characters in three parts ("Decided:", "Open:", "Context:"), drafted from
the same context rules as replies (G2 3.3). On demand (``POST …/summary``), and for the
minute tick once a discussion is closed or its first change is staged, so G5 always has
one to give the agents. A summary the starter confirmed is replaced only when the starter
asks.
"""

import asyncio
import logging
import uuid
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from sqlalchemy import exists, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.discussions import access, context, kinds
from oracle.discussions.models import MAX_SUMMARY, Discussion, DiscussionChange
from oracle.jobs import prompting
from oracle.llm import gateway
from oracle.llm.transports import get_llm_settings
from oracle.tenancy import tenant_session

if TYPE_CHECKING:
    from oracle.auth.deps import Principal

log = logging.getLogger(__name__)

JOB = "discussion_summary"
MAX_TOKENS = 600
TIMEOUT = 60.0
CONFIRMED = "The starter confirmed this summary. They can ask Oracle for a new draft."
QUEUED = "discussion.summary_queued"


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


def _due():
    handled = exists().where(
        DiscussionChange.discussion_id == Discussion.id,
        DiscussionChange.status.in_(("staged", "done")),
    )
    return select(Discussion).where(
        Discussion.summary_status == "none", (Discussion.status == "closed") | handled
    )


async def run_queued(tenant_id: uuid.UUID, limit: int = 5) -> int:
    """The tick: draft the summaries waiting; how many were written."""
    async with tenant_session(tenant_id) as db:
        ids = list(await db.scalars(_due().with_only_columns(Discussion.id).limit(limit)))
    written = 0
    for discussion_id in ids:
        async with tenant_session(tenant_id) as db:
            d = await db.get(Discussion, discussion_id, with_for_update=True)
            if d is None or d.summary_status != "none":
                continue
            try:
                text = await draft(db, d)
            except Exception as e:
                log.info("discussion summary %s failed: %s", discussion_id, type(e).__name__)
                continue
            _store(d, text)
            await db.commit()
            written += 1
    return written
