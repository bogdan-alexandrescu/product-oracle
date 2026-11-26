"""inbox-2 (#1893): which open proposals wait for a person, one rule for the Inbox's count
(changes.inbox_rows) and Decisions' Waiting for you (waiting_reads.proposals)."""

from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.simple import changes, service
from oracle.simple.models import SimpleChange, SimpleSession


async def waiting_for(
    db: AsyncSession, me: uuid.UUID, rows: list[SimpleChange], read_: service.Read
) -> list[SimpleChange]:
    """The open proposals of ``rows`` waiting for ``me``, as the Inbox counts them (inbox_rows)
    and Decisions' Waiting for you lists them (inbox-2, #1893): routed to me now
    (current_route), less a question decided since."""
    owners = await changes._company_owners(db)
    by_id = read_.by_id()
    qs = await changes._questions(db, rows)
    met = set(
        await db.scalars(
            select(SimpleSession.id).where(
                SimpleSession.id.in_({c.session_id for c in rows if c.session_id}),
                SimpleSession.kind == "meeting",
            )
        )
    )
    return [
        c
        for c in rows
        if c.status == "proposed"
        and me in changes.current_route(c, by_id, read_.deciders, owners, qs, c.session_id in met)
        # A question decided since (on Decisions, in a meeting) leaves nothing to decide.
        and not (
            c.op in changes.QUESTION_OPS
            and (d := qs.get(str(c.target.get("decision_id")))) is not None
            and d.status != "proposed"
        )
    ]
