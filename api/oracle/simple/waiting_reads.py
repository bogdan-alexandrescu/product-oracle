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

from oracle.simple import additions, changes, service
from oracle.simple.models import SimpleChange, SimpleGoalSuggestion


async def proposals(
    db: AsyncSession, principal: Any, read_: service.Read
) -> list[tuple[SimpleChange, str, str]]:
    """The proposed changes the reader may decide, as changes.listing(status="proposed")
    lists them (newest first, at most 500 read): (the change, its words, its author's name)."""
    rows = list(
        await db.scalars(
            select(SimpleChange)
            .where(SimpleChange.status == "proposed")
            .order_by(SimpleChange.at.desc(), SimpleChange.seq.desc())
            .limit(500)
        )
    )
    v, seen, names = await changes.visible(db, principal, rows, read_)
    return [
        (c, changes.words(c, v, names), names.get(c.by, "someone")) for c in seen if v.may_decide(c)
    ]


async def goal_suggestions(
    db: AsyncSession, principal: Any, read_: service.Read
) -> list[tuple[SimpleGoalSuggestion, str]]:
    """The open goal suggestions the reader may accept, as additions.listing(status="open")
    lists them (oldest first; a failed-checks one only to owners): (the suggestion, its
    goal's title)."""
    goals, rows = await additions.readable(db, principal, None, "open")
    if not rows:
        return []
    asked = {r.goal_id for r in rows}
    goals = [g for g in goals if g.id in asked]
    rule = await additions.deciding(db, principal, goals, read_, who=False)
    titles = {g.id: g.title for g in goals}
    return [(r, titles[r.goal_id]) for r in rows if rule[r.goal_id][0]]
