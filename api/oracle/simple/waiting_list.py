"""home-decisions-one-list: everything that waits on the signed-in person, as one list Home's
waiting cards, the Decisions page's "Waiting for you" and the rail's counts read
(GET /v1/simple/decisions/waiting ``items``): the run stops they may decide, the roadmap's
broken links on items they decide, the drafts waiting for their approval, the PRD questions
they own, the proposals on their items, the dates to confirm and the goal suggestions they
decide. Each item says what it is, its action in words and where it is done; acting on it
(through that kind's own endpoint) drops it from the next read, so every page and the rail
agree.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from oracle.simple.schemas import SimpleQuestion, SimpleWaitingItem

# What a run stop asks, in plain words (web/app/simple/_home/run-stops.tsx ACTION).
_STOP_ACTION = {
    "feature_set": "Check the feature set",
    "eng_review": "Check the engineering review",
    "priority_order": "Set the order",
    "prd_review": "Review the PRD",
    "eng_dates": "Review the dates",
    "roadmap_items": "Check the roadmap items",
    "baseline_confirm": "Confirm the baseline",
}


async def _stops(db: AsyncSession, principal: Any) -> list[SimpleWaitingItem]:
    from oracle.runs import service as runs

    inbox = await runs.inbox(db, principal)
    out = []
    for c in sorted(inbox.checkpoints, key=lambda c: c.created_at):
        if not c.can_decide or c.status != "pending":
            continue
        out.append(SimpleWaitingItem(
            kind="run_stop", key=f"run_stop:{c.id}", ref_id=str(c.id),
            title=_STOP_ACTION.get(c.kind, "Open the stop"),
            detail=c.document_title or c.flow_title or "A run",
            action=_STOP_ACTION.get(c.kind, "Open the stop"),
            href=f"/runs/{c.run_id}", at=c.created_at,
        ))  # fmt: skip
    return out


async def _roadmap(db: AsyncSession, principal: Any) -> list[SimpleWaitingItem]:
    """Broken links on the items this person decides (the others only propose fixes) and
    the dates Oracle suggests for items they decide."""
    from oracle.simple import service

    rm = await service.build(db, principal)
    titles = {i.id: i.title for i in rm.items}
    out = []
    for i in rm.items:
        if not i.can_decide:
            continue
        for f in i.flags:
            if f.state != "red" or not f.fixes:
                continue
            dep = titles.get(_uuid(f.subject)) if f.subject else None
            out.append(SimpleWaitingItem(
                kind="broken_link", key=f"broken_link:{i.id}:{f.kind}:{f.subject or ''}",
                ref_id=str(i.id), title=i.title,
                detail=f"{f.reason}" + (f" ({dep})" if dep and dep not in f.reason else ""),
                action="Fix the link", href=f"/simple/roadmap?item={i.id}",
            ))  # fmt: skip
        s = i.suggestion
        if s is not None and s.status == "open" and s.can_decide:
            out.append(SimpleWaitingItem(
                kind="date", key=f"date:{s.id}", ref_id=str(s.id), title=i.title,
                detail=f"Oracle suggests {_day(s.start_date)} – {_day(s.end_date)}",
                action="Confirm the dates", href=f"/simple/roadmap?item={i.id}",
                at=s.created_at,
            ))  # fmt: skip
    return out


async def _drafts(db: AsyncSession, principal: Any) -> list[SimpleWaitingItem]:
    from oracle.simple import drafts

    me = getattr(principal, "user_id", None)
    if me is None:
        return []
    out = []
    for d in await drafts.listing(db, principal):
        if me not in d.waiting_on:
            continue
        out.append(SimpleWaitingItem(
            kind="draft", key=f"draft:{d.id}", ref_id=str(d.id), title=d.document.title,
            detail="A roadmap draft waits for your approval", action="Approve",
            href=f"/simple/roadmap?roadmap={d.document.id}",
        ))  # fmt: skip
    return out


async def _proposals(db: AsyncSession, principal: Any) -> list[SimpleWaitingItem]:
    from oracle.simple import changes

    out = []
    for c in await changes.listing(db, principal, None, None, "proposed", False):
        if not c.can_decide:
            continue
        item = (c.target or {}).get("item_id")
        date = c.op == "accept_date_suggestion"
        out.append(SimpleWaitingItem(
            kind="date" if date else "proposal", key=f"proposal:{c.id}", ref_id=str(c.id),
            title=c.words or ("New dates proposed" if date else "A proposed change"),
            detail=f"Proposed by {c.by_name}", action="Accept",
            href=f"/simple/roadmap?item={item}" if item else "/simple/roadmap",
            at=c.at, op=c.op,
        ))  # fmt: skip
    return out


async def _goal_suggestions(db: AsyncSession, principal: Any) -> list[SimpleWaitingItem]:
    from oracle.simple import additions

    got = await additions.listing(db, principal, None, "open")
    return [
        SimpleWaitingItem(
            kind="goal_suggestion",
            key=f"goal_suggestion:{s.id}",
            ref_id=str(s.id),
            title=s.title,
            detail=f"Suggested for {s.goal.title}",
            action="Confirm",
            href="/simple/goals",
            at=s.created_at,
        )  # fmt: skip
        for s in got.suggestions
        if s.status == "open" and s.can_accept
    ]


def _questions(qs: list[SimpleQuestion]) -> list[SimpleWaitingItem]:
    return [
        SimpleWaitingItem(
            kind="question",
            key=f"question:{q.id}",
            ref_id=str(q.id),
            title=f"{q.code} {q.title}".strip(),
            detail=q.prd.title,
            action="Decide",
            href=f"/simple/decisions?prd={q.prd.slug}",
        )  # fmt: skip
        for q in qs
    ]


async def items(
    db: AsyncSession, principal: Any, qs: list[SimpleQuestion]
) -> list[SimpleWaitingItem]:
    """The one list, run stops first, then the questions, roadmap, drafts, proposals and
    goal suggestions. Each source is read as its own page reads it, so what this
    person cannot see or decide is never here."""
    if getattr(principal, "user_id", None) is None:
        return []
    out = await _stops(db, principal)
    out += _questions(qs)
    out += await _roadmap(db, principal)
    out += await _drafts(db, principal)
    out += await _proposals(db, principal)
    out += await _goal_suggestions(db, principal)
    return out


def _uuid(v: str | None) -> Any:
    import uuid

    try:
        return uuid.UUID(str(v))
    except ValueError:
        return None


def _day(d: Any) -> str:
    """ "Nov 4" (the year too when it is not this year's)."""
    from oracle import company_time

    today = company_time.now().date()
    return d.strftime("%b %-d") if d.year == today.year else d.strftime("%b %-d, %Y")
