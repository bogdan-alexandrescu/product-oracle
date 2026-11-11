"""home-decisions-one-list: everything that waits on the signed-in person, as one list Home's
waiting cards, the Decisions page's "Waiting for you" and the rail's counts read
(GET /v1/simple/decisions/waiting ``items``): the run stops they may decide, the roadmap's
broken links on items they decide, the drafts waiting for their approval, the PRD questions
they own, the decision-log calls proposed to them, the proposals on their items, the dates to
confirm, the goal suggestions they decide, the proposed goals they may confirm, and the
Inbox's other counted "Needs you" rows (Add predictions, launches, rituals, metrics,
requests), so Home and the Inbox agree. Each item
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
    "baseline_confirm": "Confirm the Ground Truth",
}


async def _stops(db: AsyncSession, principal: Any) -> list[SimpleWaitingItem]:
    # The Inbox's own stops (the same deciders and hidden runs), read alone: building the
    # whole Inbox here made every read grow with the company's open runs.
    from oracle.runs import service as runs

    return [
        SimpleWaitingItem(
            kind="run_stop",
            key=f"run_stop:{c.id}",
            ref_id=str(c.id),
            title=_STOP_ACTION.get(c.kind, "Open the stop"),
            detail=_stop_for(c),
            action=_STOP_ACTION.get(c.kind, "Open the stop"),
            href=f"/runs/{c.run_id}",
            at=c.created_at,
        )  # fmt: skip
        for c in await runs.waiting_stops(db, principal)
    ]


def _stop_for(c: Any) -> str:
    """What the run is for, as Home's stop card says it: its PRD, else the flow."""
    if c.document_title:
        return c.document_title
    if c.document_slug:
        words = c.document_slug.replace("-", " ")
        return f"{words[:1].upper()}{words[1:]} PRD"
    return c.flow_title or "A run"


async def _roadmap(db: AsyncSession, principal: Any, read_: Any) -> list[SimpleWaitingItem]:
    """Broken links on the items this person decides (the others only propose fixes) and
    the dates Oracle suggests for items they decide: each item as the roadmap's GET shows it
    (service.build's item_out: its code-less name, flags and suggestion), read from the list's
    one roadmap read rather than a whole build."""
    from oracle.roadmap import codes
    from oracle.simple import service

    today = await company_time.company_today(db)
    # service.item_codes's codes, without writing them onto the shared read's entries.
    fids = {e.row.feature_id for e in read_.entries if e.row.feature_id}
    by_feature = await codes.feature_codes(db) if fids else {}

    def title_of(e: Any) -> str:
        return service.coded_title(e.row.title, codes.code_of(e.row, by_feature))[1]

    titles = {e.row.id: title_of(e) for e in read_.entries}
    out = []
    for e in read_.entries:
        if not service.can_decide(principal, e, read_.deciders):
            continue
        iid, title = e.row.id, titles[e.row.id]
        for f in e.flags:
            # qa-simple-home-3: a broken link is every red flag with a one-click fix (an end past
            # its milestone too), as Home's tile and the walk count them (chat.broken_links).
            if f.state != "red" or not f.fixes:
                continue
            dep = titles.get(_uuid(f.subject)) if f.subject else None
            out.append(SimpleWaitingItem(
                kind="broken_link", key=f"broken_link:{iid}:{f.kind}:{f.subject or ''}",
                ref_id=str(iid), title=title,
                detail=f"{f.reason}" + (f" ({dep})" if dep and dep not in f.reason else ""),
                action="Fix the link", href=f"/simple/roadmap?item={iid}",
            ))  # fmt: skip
        s = e.suggestion
        if s is not None and s.status == "open":
            start, end = e.suggestion_span or (s.start_date, s.end_date)
            out.append(SimpleWaitingItem(
                kind="date", key=f"date:{s.id}", ref_id=str(s.id), title=title,
                detail=f"Oracle suggests {_day(start, today)} – {_day(end, today)}",
                action="Confirm the dates", href=f"/simple/roadmap?item={iid}",
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
        # A required reviewer's, or the decider's whose final approval is not in yet (the
        # drafts drafts.inbox_rows lists to them): can_approve says both.
        if not d.can_approve:
            continue
        out.append(SimpleWaitingItem(
            kind="draft", key=f"draft:{d.id}", ref_id=str(d.id), title=d.document.title,
            detail="A roadmap draft waits for your approval", action="Approve",
            href=f"/simple/roadmap?roadmap={d.document.id}",
        ))  # fmt: skip
    return out


async def _proposals(db: AsyncSession, principal: Any, read_: Any) -> list[SimpleWaitingItem]:
    from oracle.simple import waiting_reads

    out = []
    for c, words, by_name in await waiting_reads.proposals(db, principal, read_):
        item = (c.target or {}).get("item_id")
        date = c.op == "accept_date_suggestion"
        out.append(SimpleWaitingItem(
            kind="date" if date else "proposal", key=f"proposal:{c.id}", ref_id=str(c.id),
            title=words or ("New dates proposed" if date else "A proposed change"),
            detail=f"Proposed by {by_name}", action="Accept",
            href=f"/simple/roadmap?item={item}" if item else "/simple/roadmap",
            at=c.at, op=c.op,
        ))  # fmt: skip
    return out


async def _goal_suggestions(
    db: AsyncSession, principal: Any, read_: Any
) -> list[SimpleWaitingItem]:
    from oracle.simple import waiting_reads

    return [
        SimpleWaitingItem(
            kind="goal_suggestion",
            key=f"goal_suggestion:{s.id}",
            ref_id=str(s.id),
            title=s.title,
            detail=f"Suggested for {goal}",
            action="Confirm",
            href="/simple/goals",
            at=s.created_at,
        )  # fmt: skip
        for s, goal in await waiting_reads.goal_suggestions(db, principal, read_)
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


async def _inbox(db: AsyncSession, principal: Any) -> list[SimpleWaitingItem]:
    """The Inbox's other counted "Needs you" rows, read by the Inbox's own row builders and
    worded as the Inbox words them (web/app/inbox/_needs.tsx): Add predictions and Outcome
    check due, the launches, rituals, unusual weeks and requests waiting on this person."""
    from oracle.launches import service as launches
    from oracle.metrics.review import inbox_rows as metric_rows
    from oracle.quality.outcomes import inbox_rows as outcome_rows
    from oracle.requests.inbox import inbox_rows as request_rows
    from oracle.rituals.service import inbox_rows as ritual_rows

    def row(key: str, title: str, detail: str, href: str, at: Any = None, action: str = "Open",
            ref_id: str | None = None) -> SimpleWaitingItem:  # fmt: skip
        return SimpleWaitingItem(
            kind="inbox", key=key, ref_id=ref_id or key.rsplit(":", 1)[-1],
            title=title, detail=detail, action=action, href=href, at=at,
        )  # fmt: skip

    out = [
        row(
            f"outcome:{o.reason}:{o.id}",
            o.title,
            "Plan › Outcomes",
            f"/plan/outcomes?outcome={o.id}",
        )  # fmt: skip
        for o in await outcome_rows(db, principal)
        if o.counts
    ]
    out += [
        row(
            f"launch:{r.reason}:{r.launch_id}",
            f"{_LAUNCH.get(r.reason, 'Launch')} · {r.title}",
            r.item,
            f"/roadmap/launches?launch={r.launch_id}",
            r.at,
        )  # fmt: skip
        for r in await launches.inbox_rows(db, principal)
        if r.counted
    ]
    # A ritual that failed to prepare is retried in place (its ritual's POST
    # /v1/rituals/{id}/prepare) and opens Company > Rituals, as the Inbox's row does.
    out += [
        row(
            f"ritual:{r.reason}:{r.occurrence_id}",
            f"{_RITUAL[r.reason]} · {r.title}",
            "Rituals",
            "/company/rituals" if r.reason == "failed" else f"/company/rituals/{r.occurrence_id}",
            r.due_at,
            "Retry" if r.reason == "failed" else "Open",
            str(r.ritual_id) if r.reason == "failed" else None,
        )  # fmt: skip
        for r in await ritual_rows(db, principal)
        if r.counts and r.state in ("new", "open")
    ]
    out += [
        row(
            f"metric:{m.reason}:{m.variance_id or m.metric_id}",
            f"{_METRIC[m.reason]} · {m.metric_title}",
            "Metrics",
            f"/company/rituals/{m.occurrence_id}"
            if m.reason != "pull_failed" and m.occurrence_id
            else f"/company/metrics?metric={m.metric_id}",
        )  # fmt: skip
        for m in await metric_rows(db, principal)
        if m.counts
    ]
    out += [
        row(
            f"request:{r.reason}:{r.request_id}",
            f"{_REQUEST[r.reason]} · {r.title}",
            "Requests",
            f"/requests?request={r.request_id}",
            r.at,
        )  # fmt: skip
        for r in await request_rows(db, principal)
        if r.counts
    ]
    return out


# The Inbox's words for each row (web/app/inbox/_needs.tsx).
_LAUNCH = {"ready": "Ready to launch", "set_tier": "Set tier", "notes_to_send": "Notes to send"}
_RITUAL = {"pre_read": "Pre-read ready", "record_notes": "Record notes",
           "failed": "Ritual failed to prepare"}  # fmt: skip
_METRIC = {"explain": "Explain an unusual week", "find_out": "Find out",
           "pull_failed": "Metric not read for a day"}  # fmt: skip
_REQUEST = {"replies_to_send": "Replies to send", "asked_again": "Asked again since you said no",
            "answer": "Answer to your request"}  # fmt: skip


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
    drafts, proposals, goal suggestions and proposed goals, then the Inbox's other counted
    rows (Add predictions, launches, rituals, metrics, requests). Each source keeps its own
    page's rules, so what this person cannot see or decide is never here; the roadmap is read
    once for all of them (tests/test_simple_waiting_speed.py)."""
    if getattr(principal, "user_id", None) is None:
        return []
    from oracle.simple import drafts, service

    out = await _stops(db, principal)
    out += _questions(qs)
    out += await _calls(db, principal)
    # The roadmap as this person reads it (their drafts' changes in), read once for the
    # roadmap's links and dates, the proposals and the goal suggestions.
    read_ = await service.load(db, await drafts.overlays_for(db, principal))
    out += await _roadmap(db, principal, read_)
    out += await _drafts(db, principal)
    out += await _proposals(db, principal, read_)
    out += await _goal_suggestions(db, principal, read_)
    out += await _goals(db, principal)
    out += await _inbox(db, principal)
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
