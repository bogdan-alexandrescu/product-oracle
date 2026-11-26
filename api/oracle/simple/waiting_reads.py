"""The narrow reads the one waiting list (oracle.simple.waiting_list) makes of the roadmap's
proposals and the goals' suggestions: the same rows and rules as changes.listing and
additions.listing (changes.visible, additions.readable and additions.deciding, shared), over a
roadmap read (service.load) the list reads once for every source, without the fields the list
never shows (a change's meeting, a suggestion's look-alikes and flow, its decider's name).
tests/test_simple_waiting_speed.py holds the list's answer to the pages' own reads."""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.simple import additions, changes, inbox_route, service
from oracle.simple.models import SimpleChange, SimpleGoalSuggestion


async def proposals(
    db: AsyncSession, principal: Any, read_: service.Read
) -> list[tuple[SimpleChange, str, str, bool]]:
    """The proposed changes the reader may decide, as changes.listing(status="proposed")
    lists them (at most the newest 500 read), and every one the Inbox counts for them
    (changes.waiting_for, inbox-2 #1893), newest first: (the change, its words, its author's
    name, whether the reader may decide it now)."""
    rows = list(
        await db.scalars(
            select(SimpleChange)
            .where(SimpleChange.status == "proposed")
            .order_by(SimpleChange.at.desc(), SimpleChange.seq.desc())
        )
    )
    me = getattr(principal, "user_id", None)
    if not rows or me is None:
        return []
    routed = {c.id for c in await inbox_route.waiting_for(db, me, rows, read_)}
    rows = [c for n, c in enumerate(rows) if n < 500 or c.id in routed]
    v, seen, _ = await changes.visible(db, principal, rows, read_)
    listed = {c.id for c in seen}
    out = [c for c in rows if c.id in routed or (c.id in listed and v.may_decide(c))]
    names = await changes._names(db, {c.by for c in out})
    return [
        (c, changes.words(c, v, names), names.get(c.by, "someone"), v.may_decide(c)) for c in out
    ]


async def goal_suggestions(
    db: AsyncSession, principal: Any, read_: service.Read
) -> list[tuple[SimpleGoalSuggestion, str]]:
    """The open goal suggestions the reader may accept, as additions.listing(status="open")
    lists them (oldest first; a failed-checks one only to owners): (the suggestion, its
    goal's title)."""
    goals, rows, _ = await additions.readable(db, principal, None, "open")
    if not rows:
        return []
    asked = {r.goal_id for r in rows}
    goals = [g for g in goals if g.id in asked]
    rule = await additions.deciding(db, principal, goals, read_, who=False)
    titles = {g.id: g.title for g in goals}
    return [(r, titles[r.goal_id]) for r in rows if rule[r.goal_id][0]]
