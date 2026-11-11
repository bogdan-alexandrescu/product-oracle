"""The narrow reads the one waiting list (oracle.simple.waiting_list) makes of the roadmap's
proposals and the goals' suggestions: the same rows and rules as changes.listing and
additions.listing, over a roadmap read (service.load) the list reads once for every source,
without the fields the list never shows (a change's meeting, a suggestion's look-alikes and
flow, its decider's name). tests/test_simple_waiting_speed.py holds the list's answer to the
pages' own reads."""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.authz import has_role
from oracle.simple import changes, drafts, service
from oracle.simple.models import SimpleChange, SimpleDraft, SimpleGoalSuggestion, SimpleSession


async def _view(
    db: AsyncSession, principal: Any, rows: list[SimpleChange], read_: service.Read
) -> changes._View:
    """changes._view over ``read_`` (the reader's roadmap with their drafts), not a read of
    its own."""
    sids = {c.session_id for c in rows if c.session_id}
    sessions = (
        {s.id: s for s in await db.scalars(select(SimpleSession).where(SimpleSession.id.in_(sids)))}
        if sids
        else {}
    )
    cids = [c.id for c in rows]
    undone = (
        set(
            await db.scalars(select(SimpleChange.undoes_id).where(SimpleChange.undoes_id.in_(cids)))
        )
        if cids
        else set()
    )
    dids = {d for c in rows for d in c.draft_ids or []}
    participants = (
        {
            d.id: {d.created_by, *(d.participant_ids or [])}
            for d in await db.scalars(select(SimpleDraft).where(SimpleDraft.id.in_(dids)))
        }
        if dids
        else {}
    )
    owners = (await drafts.who(db, {c.document_id for c in rows if c.document_id})).owners
    people = {"drafts": participants, "owners": owners}
    company = await changes._company_owners(db) if any(c.status == "proposed" for c in rows) else []
    v = changes._View(
        principal, read_, await changes._reviewers(db), sessions, undone, people, company
    )
    v.questions = await changes._questions(db, rows)
    v.agendas = await changes._agendas(db, sids)
    v.deleted = await changes._deleted(db, rows, v)
    return v


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
    v = await _view(db, principal, rows, read_)
    gone = await changes._on_replaced_prds(db, rows)
    shown = [c for c in rows if v.sees(c) and c.id not in gone and v.may_decide(c)]
    names = await changes._names(db, {c.by for c in shown})
    return [
        (c, changes._words(c, v, names, changes._target(c, v)), names.get(c.by, "someone"))
        for c in shown
    ]


async def goal_suggestions(
    db: AsyncSession, principal: Any, read_: service.Read
) -> list[tuple[SimpleGoalSuggestion, str]]:
    """The open goal suggestions the reader may accept, as additions.listing(status="open")
    lists them (oldest first; a failed-checks one only to owners): (the suggestion, its
    goal's title)."""
    from oracle.roadmap import company
    from oracle.simple import additions

    goals = await additions._goals(db)
    by_id = {g.id: g for g in goals}
    rows = list(
        await db.scalars(
            select(SimpleGoalSuggestion)
            .where(
                SimpleGoalSuggestion.goal_id.in_(list(by_id)),
                SimpleGoalSuggestion.status == "open",
            )
            .order_by(SimpleGoalSuggestion.created_at, SimpleGoalSuggestion.id)
        )
    )
    owner = has_role(principal.role, "owner")
    rows = [r for r in rows if owner or not r.checks]
    if not rows:
        return []
    # additions.deciding's rule (whether the reader decides), its goals' roadmaps found as
    # additions._job_document finds them, the company roadmap read once.
    active = await company.active(db)
    first: list[Any] = []

    async def document(goal_id: uuid.UUID) -> Any:
        if active is not None:
            return active
        for e in read_.entries:
            if e.goal is not None and e.goal.id == goal_id:
                return e.roadmap
        if not first:
            from oracle.docs.models import Document

            first.append(
                await db.scalar(
                    select(Document)
                    .where(Document.kind == "roadmap")
                    .order_by(Document.created_at)
                    .limit(1)
                )
            )
        return first[0]

    docs = {g: await document(g) for g in {r.goal_id for r in rows}}
    w = await drafts.who(db, {d.id for d in docs.values() if d is not None})
    me = additions._me_or_none(principal)

    def may(goal_id: uuid.UUID) -> bool:
        d = docs[goal_id]
        if d is None:
            return owner and me is not None
        return drafts.can_edit(principal, d.id, w)

    return [(r, by_id[r.goal_id].title) for r in rows if may(r.goal_id)]
