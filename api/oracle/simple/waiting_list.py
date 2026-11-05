"""home-decisions-one-list: everything that waits on the signed-in person, as one list Home's
waiting cards, the Decisions page's "Waiting for you" and the rail's counts read
(GET /v1/simple/decisions/waiting ``items``): the run stops they may decide, the roadmap's
broken links on items they decide, the drafts waiting for their approval, the PRD questions
they own, the decision-log calls proposed to them, the proposals on their items, the dates to
confirm, the goal suggestions they decide and the proposed goals they may confirm. Each item
says what it is, its action in words and where it is done; acting on it (through that kind's
own endpoint) drops it from the next read, so every page and the rail agree.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import company_time
from oracle.authz import has_role
from oracle.baseline.models import Entity
from oracle.decisions.models import Decision
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
            detail=_stop_for(c),
            action=_STOP_ACTION.get(c.kind, "Open the stop"),
            href=f"/runs/{c.run_id}", at=c.created_at,
        ))  # fmt: skip
    return out


def _stop_for(c: Any) -> str:
    """What the run is for, as Home's stop card says it: its PRD, else the flow."""
    if c.document_title:
        return c.document_title
    if c.document_slug:
        words = c.document_slug.replace("-", " ")
        return f"{words[:1].upper()}{words[1:]} PRD"
    return c.flow_title or "A run"


async def _roadmap(db: AsyncSession, principal: Any) -> list[SimpleWaitingItem]:
    """Broken links on the items this person decides (the others only propose fixes) and
    the dates Oracle suggests for items they decide."""
    from oracle.simple import service

    rm = await service.build(db, principal)
    today = await company_time.company_today(db)
    titles = {i.id: i.title for i in rm.items}
    out = []
    for i in rm.items:
        if not i.can_decide:
            continue
        for f in i.flags:
            # roadmap-decide: a broken link is a dependency out of order or a cut item others
            # depend on (service.LINK_KINDS), as Home, the roadmap's strip and the side menu count.
            if f.state != "red" or not f.fixes or f.kind not in service.LINK_KINDS:
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
                detail=f"Oracle suggests {_day(s.start_date, today)} – {_day(s.end_date, today)}",
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


async def _goals(db: AsyncSession, principal: Any) -> list[SimpleWaitingItem]:
    """Proposed goals, for whoever may confirm them (POST /v1/baseline/entities/{id}/confirm
    takes an approver), confirmed or set aside in place as Home's goals card does."""
    if not has_role(getattr(principal, "role", ""), "approver"):
        return []
    rows = await db.scalars(
        select(Entity)
        .where(Entity.type == "goal", Entity.status == "proposed")
        .order_by(Entity.created_at)
    )
    return [
        SimpleWaitingItem(
            kind="goal",
            key=f"goal:{g.id}",
            ref_id=str(g.id),
            title=g.title,
            # Its row reads "Proposed goal · <name>", as Home's does; no second line repeats it.
            detail="",
            action="Confirm",
            href="/simple",
            at=g.created_at,
        )  # fmt: skip
        for g in rows
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


async def _calls(db: AsyncSession, principal: Any) -> list[SimpleWaitingItem]:
    """The decision log's calls proposed to this person (neither a PRD's question nor Oracle's
    run approval: the ``others`` the decisions count holds), decided in place by number."""
    rows = await db.scalars(select(Decision).where(
        Decision.status == "proposed", Decision.approver_id == principal.user_id,
        Decision.origin.not_in(("prd", "checkpoint"))).order_by(Decision.number))  # fmt: skip
    return [
        SimpleWaitingItem(
            kind="decision",
            key=f"decision:{d.id}",
            ref_id=str(d.number),
            title=d.title,
            detail=d.question or "",
            action="Decide",
            href=f"/company/decisions?d={d.number}",
            at=d.created_at,
        )  # fmt: skip
        for d in rows
    ]


async def items(
    db: AsyncSession, principal: Any, qs: list[SimpleQuestion]
) -> list[SimpleWaitingItem]:
    """The one list, run stops first, then the questions, decision-log calls, roadmap,
    drafts, proposals, goal suggestions and proposed goals. Each source is read as its own
    page reads it, so what this person cannot see or decide is never here."""
    if getattr(principal, "user_id", None) is None:
        return []
    out = await _stops(db, principal)
    out += _questions(qs)
    out += await _calls(db, principal)
    out += await _roadmap(db, principal)
    out += await _drafts(db, principal)
    out += await _proposals(db, principal)
    out += await _goal_suggestions(db, principal)
    out += await _goals(db, principal)
    return out


def _uuid(v: str | None) -> Any:
    import uuid

    try:
        return uuid.UUID(str(v))
    except ValueError:
        return None


def _day(d: Any, today: Any) -> str:
    """ "Nov 4" (the year too when it is not ``today``'s, the company's day)."""
    return company_time.calendar_day(d, today)
