"""Simple meetings: the inbox, decided-in titles, flows and the Decisions page's rows."""

import re
import uuid
from datetime import date, datetime, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import company_time
from oracle.decisions.models import Decision
from oracle.docs.models import Document
from oracle.roadmap.models import RoadmapItem
from oracle.simple.meetings_common import (
    INBOX_DAYS,
    _me,
    _ref,
)
from oracle.simple.models import SimpleChange, SimpleMeeting
from oracle.simple.models import SimpleMeetingDecision as MeetingDecisionRow
from oracle.simple.schemas import (
    InboxSimpleMinutes,
    SimpleDecidedFlow,
    SimpleDecisionRow,
    SimpleFilterOption,
    SimpleLeftOut,
    SimpleQuestionOption,
    SimpleRunGroup,
    SimpleRunStepOut,
    SimpleRunStopOut,
)

# --------------------------------------------------------------------------- inbox


async def inbox_rows(db: AsyncSession, principal: Any, seen: Any) -> list[InboxSimpleMinutes]:
    """Minutes sent to me as an attendee in the last 30 days."""
    me = _me(principal)
    if me is None or getattr(principal, "run_token_id", None) is not None:
        return []
    since = company_time.now() - timedelta(days=INBOX_DAYS)
    ms = list(
        await db.scalars(
            select(SimpleMeeting)
            .where(
                SimpleMeeting.minutes_state == "sent",
                SimpleMeeting.sent_at >= since,
                SimpleMeeting.attendee_ids.contains([me]),
            )
            .order_by(SimpleMeeting.sent_at.desc())
        )
    )
    counts = dict(
        (
            await db.execute(
                select(MeetingDecisionRow.meeting_id, func.count())
                .where(MeetingDecisionRow.meeting_id.in_([m.id for m in ms]))
                .group_by(MeetingDecisionRow.meeting_id)
            )
        ).all()
    ) if ms else {}  # fmt: skip
    return [
        InboxSimpleMinutes(
            meeting_id=m.id,
            title=m.title,
            ended_at=m.ended_at,
            sent_at=m.sent_at,
            decisions=counts.get(m.id, 0),
            state="new" if seen is None or (m.sent_at and m.sent_at > seen) else "open",
        )  # fmt: skip
        for m in ms
    ]


async def titles_by_session(db: AsyncSession, ids: set[uuid.UUID]) -> dict[uuid.UUID, str]:
    """Meeting titles by session id (train T's notes: "…, in <meeting title>")."""
    ids = {i for i in ids if i}
    if not ids:
        return {}
    return dict(
        (
            await db.execute(
                select(SimpleMeeting.session_id, SimpleMeeting.title).where(
                    SimpleMeeting.session_id.in_(ids)
                )
            )
        ).all()
    )


def left_out_entry(left: list) -> SimpleLeftOut | None:
    """A read's sources entry for the decisions decided_in left out, if any."""
    from oracle.decisions import standing

    entry = standing.sources_entry(left)
    return SimpleLeftOut(**entry) if entry else None


# --------------------------------------------------------------------------- flows


async def decided_flows(db: AsyncSession, links: list) -> dict[uuid.UUID, SimpleDecidedFlow]:
    """Each meeting decision on a new flow or feature (a change to a draft item): that
    item and its flow from S10 (None until drawn, or without S10's module)."""
    try:
        from oracle.simple import visuals
    except ImportError:
        visuals = None
    change_ids = {c for link, _ in links for c in link.change_ids or []}
    if not change_ids:
        return {}
    item_of = {}
    for c in await db.scalars(select(SimpleChange).where(SimpleChange.id.in_(change_ids))):
        try:
            item_of[c.id] = uuid.UUID(str((c.target or {}).get("item_id")))
        except ValueError:
            continue
    rows = {
        r.id: r
        for r in await db.scalars(
            select(RoadmapItem).where(
                RoadmapItem.id.in_(set(item_of.values())), RoadmapItem.draft.is_(True)
            )
        )
    } if item_of else {}  # fmt: skip
    out: dict[uuid.UUID, SimpleDecidedFlow] = {}
    flows: dict[uuid.UUID, Any] = {}
    for link, d in links:
        row = next((rows[item_of[c]] for c in link.change_ids or []
                    if item_of.get(c) in rows), None)  # fmt: skip
        if row is None:
            continue
        if row.id not in flows:
            flows[row.id] = (
                await visuals.flow_for(db, "draft_item", row.id) if visuals is not None else None
            )
        out[d.id] = SimpleDecidedFlow(kind="draft_item", id=row.id, title=row.title,
                                      flow=flows[row.id])  # fmt: skip
    return out


def _row(d: Decision, names: dict, principal: Any = None, edited: dict | None = None,
         prds: dict | None = None) -> SimpleDecisionRow:  # fmt: skip
    from oracle.simple import decision_sheet

    chosen = next(
        (o.get("label") for o in d.options or [] if o.get("key") == d.chosen_option), None
    )
    at, by = (edited or {}).get(str(d.id), (None, None))
    return SimpleDecisionRow(
        id=d.id, number=d.number, title=d.title, origin=d.origin, status=d.status,
        approver=_ref(d.approver_id, names) if d.approver_id else None,
        decided_at=d.decided_at, created_at=d.created_at, subjects=list(d.subjects or []),
        code=(d.prd_question or {}).get("code") if d.origin == "prd" else None,
        # QA (unique codes): its PRD's name, for a code another PRD's run repeats.
        prd_title=(prds or {}).get(str((d.prd_question or {}).get("document_id")))
        if d.origin == "prd" else None,
        chosen=chosen,
        # edit-decisions (ec1 b): the sheet's fields and rights.
        question=d.question, context=d.context,
        options=[SimpleQuestionOption(key=str(o.get("key")), label=str(o.get("label")))
                 for o in d.options or []],
        review_at=d.review_at, can=decision_sheet.can(principal, d),
        edited_at=at, edited_by=_ref(by, names) if by else None,
    )  # fmt: skip


_OPEN_DECISION = re.compile(r"^D-(\d+):")


def _meeting_option_title(m: SimpleMeeting) -> str:
    """The Decisions page's meeting filter (qa-simple-decide-11): the meeting's title,
    its day in the company's zone ("Thu Oct 22"), and " · live" while it still is."""
    words = company_time.date_in_words(company_time.day(m.started_at))
    return f"{m.title} · {words}" + (" · live" if m.status == "live" else "")


# build-rundecide RD1 a: a run's stops as people name them in Simple.
_STOP_WORDS = {
    "baseline_confirm": "Ground Truth",
    "feature_set": "Feature set",
    "eng_review": "Engineering check",
    "priority_order": "Order",
    "prd_review": "PRD review",
    "eng_dates": "Dates",
    "roadmap_items": "Roadmap items",
    "roadmap_review": "Roadmap review",
}
_STEP_WORDS = {"approved": "Approved", "changes_requested": "Sent back", "skipped": "Skipped"}


def _approved_words(changed: int) -> str:
    """ "Approved with one date changed" for a Dates stop whose approval changed a date."""
    if not changed:
        return "Approved"
    return f"Approved with {'one date' if changed == 1 else f'{changed} dates'} changed"


def _run_name(doc: Document) -> str:
    """ "Usage alerts plan" for the Usage alerts PRD."""
    title = re.sub(r"\s+PRD$", "", doc.title.strip(), flags=re.I)
    return f"{title} plan"


async def _run_groups(
    db: AsyncSession, principal: Any, docs: dict[uuid.UUID, Document]
) -> list[SimpleRunGroup]:
    """Each run on a readable PRD with a decided stop, newest first: its stops in order,
    one row per stop; a stop sent back and then approved is one row with its steps."""
    from oracle.engineering import dates as eng_dates
    from oracle.runs import service as runs_service
    from oracle.runs.models import Checkpoint, Run

    if not docs:
        return []
    runs = list(await db.scalars(
        select(Run).where(Run.document_id.in_(docs), Run.deleted_at.is_(None))
        .order_by(Run.created_at.desc()).limit(20)))  # fmt: skip
    # The runs list_decisions reads (the docs are the readable PRDs; a run's call reads its
    # own run only), with one read of the stops for all of them.
    runs = [r for r in runs if not runs_service.creator_only_hidden(db, r)
            and getattr(principal, "run_id", None) in (None, r.id)]  # fmt: skip
    decisions = await runs_service.decisions_of_runs(db, runs)
    zone = await company_time.company_time_zone(db)
    # The dates each approval at a Dates stop changed, in one read.
    dated = [d.checkpoint_id for ds in decisions.values() for d in ds
             if d.kind == eng_dates.KIND and d.status == "approved"]  # fmt: skip
    changed: dict[uuid.UUID, int] = {}
    if dated:
        rows = await db.execute(
            select(Checkpoint.id, Checkpoint.payload).where(Checkpoint.id.in_(dated))
        )
        changed = {i: eng_dates.changed_count(p) for i, p in rows.all()}

    def what(d: Any) -> str:
        if d.status == "approved":
            return _approved_words(changed.get(d.checkpoint_id, 0))
        return _STEP_WORDS.get(d.status, d.status)

    def on(at: datetime | None) -> date | None:
        return company_time.day(at, zone) if at else None

    out: list[SimpleRunGroup] = []
    for run in runs:
        # A stop turned off when the run started was not a person's decision.
        decided = [d for d in decisions[run.id] if d.status != "skipped"]
        stops: list[SimpleRunStopOut] = []
        by_kind: dict[tuple[int, str], list[Any]] = {}
        for d in decided:
            by_kind.setdefault((d.segment_seq or 0, d.kind), []).append(d)
        for (_, kind), steps in by_kind.items():
            last = steps[-1]
            sent_back = any(s.status == "changes_requested" for s in steps[:-1])
            outcome = what(last)
            if last.status == "approved" and sent_back:
                outcome = "Approved after a change"
            stops.append(SimpleRunStopOut(
                checkpoint_id=last.checkpoint_id, kind=kind,
                stop=_STOP_WORDS.get(kind, kind.replace("_", " ").capitalize()),
                outcome=outcome, dates_changed=changed.get(last.checkpoint_id, 0),
                who=last.decided_by_name,
                role=(last.decided_by_role or "").replace("_", " ") or None,
                day=on(last.decided_at), note=last.note,
                trail=[SimpleRunStepOut(what=what(s),
                                        who=s.decided_by_name, day=on(s.decided_at), note=s.note)
                       for s in steps] if len(steps) > 1 else [],
            ))  # fmt: skip
        if not stops:
            continue
        doc = docs[run.document_id]  # type: ignore[index]
        out.append(SimpleRunGroup(
            run_id=run.id, name=_run_name(doc),
            prd=SimpleFilterOption(id=doc.slug, title=doc.title), stops=stops))  # fmt: skip
    return out
