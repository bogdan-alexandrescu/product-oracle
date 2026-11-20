"""Simple meetings: the inbox, decided-in titles, flows and the Decisions page."""

import re
import uuid
from datetime import date, datetime, timedelta
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import company_time
from oracle.baseline.goal_order import sort_goals
from oracle.decisions.models import Decision
from oracle.docs.models import Document
from oracle.docs.prd_order import sort_prds
from oracle.roadmap.models import RoadmapItem
from oracle.simple.meetings_common import (
    INBOX_DAYS,
    PRODUCT,
    MeetingError,
    _decisions,
    _me,
    _note_authors,
    _prd_items,
    _readable,
    _ref,
    may_retry,
)
from oracle.simple.models import SimpleChange, SimpleMeeting
from oracle.simple.models import SimpleMeetingDecision as MeetingDecisionRow
from oracle.simple.schemas import (
    InboxSimpleMinutes,
    SimpleDecidedFlow,
    SimpleDecidedRef,
    SimpleDecisionRow,
    SimpleDecisionsOut,
    SimpleFilterOption,
    SimpleLeftOut,
    SimpleMeetingGroup,
    SimpleMeetingRef,
    SimpleMinutes,
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


# --------------------------------------------------------------------------- titles


async def decided_in(
    db: AsyncSession, subjects: list[dict], left: list | None = None
) -> dict[tuple[str, str, str | None], list[SimpleDecidedRef]]:
    """The decided decisions naming each subject ``(kind, id, ref)``, newest first, with
    who decided, when and the meeting's minutes (decided_refs). Those no longer standing
    are left out and, given ``left``, added to it (standing.LeftOut) for the sources."""
    out: dict[tuple[str, str, str | None], list[Decision]] = {}
    if not subjects:
        return out
    wanted = {(s["kind"], s["id"], s.get("ref")) for s in subjects}
    from oracle.decisions import standing

    # Lapsed ones (reversed, withdrawn, replaced) are read too, so standing.split names them
    # in the left-out line; only decided ones are kept.
    # roadmap-speed: the decisions naming one of the subjects' kinds, matched here by kind and
    # id (what ``subjects @> [{kind, id}]`` matches), then read whole: one OR arm per subject
    # (a roadmap names every item of every version) cost more than the read.
    pairs = {(k, i) for k, i, _ in wanted}
    naming = [
        did
        for did, subs in await db.execute(
            select(Decision.id, Decision.subjects)
            .where(Decision.status.in_(("decided", *standing.LAPSED)))
            .where(or_(*[Decision.subjects.contains([{"kind": k}]) for k in {k for k, _ in pairs}]))
        )
        if isinstance(subs, list)
        and any(
            isinstance(s, dict)
            and isinstance(s.get("kind"), str)
            and isinstance(s.get("id"), str)
            and (s["kind"], s["id"]) in pairs
            for s in subs
        )
    ]
    rows = (
        await db.scalars(
            select(Decision).where(Decision.id.in_(naming)).order_by(Decision.number.desc())
        )
        if naming
        else []
    )

    # None about something in Trash (decisions-reversed-or-trashed).
    kept, gone = await standing.split(db, list(rows))
    if left is not None:
        left.extend(x for x in gone if all(y.decision.id != x.decision.id for y in left))
    for d in kept:
        for s in d.subjects or []:
            for key in (
                (s.get("kind"), s.get("id"), s.get("ref")),
                (s.get("kind"), s.get("id"), None),
            ):
                if key in wanted:
                    lst = out.setdefault(key, [])  # type: ignore[arg-type]
                    if all(x.id != d.id for x in lst):
                        lst.append(d)  # type: ignore[arg-type]
    decisions = {d.id: d for lst in out.values() for d in lst}  # type: ignore[union-attr]
    refs = await decided_refs(db, list(decisions.values()))  # type: ignore[arg-type]
    return {k: [refs[d.id] for d in lst] for k, lst in out.items()}


async def decided_refs(db: AsyncSession, ds: list[Decision]) -> dict[uuid.UUID, SimpleDecidedRef]:
    """walkc-roadmap-tasks: each decision with who decided it, when, and the meeting (and
    its minutes' page, /simple/meetings/<id>) it was taken in, if any."""
    if not ds:
        return {}
    from oracle.simple import meetings

    links = {
        row.decision_id: (row, m)
        for row, m in (
            await db.execute(
                select(MeetingDecisionRow, SimpleMeeting)
                .join(SimpleMeeting, SimpleMeeting.id == MeetingDecisionRow.meeting_id)
                .where(MeetingDecisionRow.decision_id.in_([d.id for d in ds]))
            )
        ).all()
    }
    names = await meetings._names(db, {i for d in ds if (i := d.decided_by or d.approver_id)})
    out: dict[uuid.UUID, SimpleDecidedRef] = {}
    for d in ds:
        row, m = links.get(d.id, (None, None))
        who = d.decided_by or d.approver_id
        out[d.id] = SimpleDecidedRef(
            id=d.id,
            number=d.number,
            title=d.title,
            decided_by=_ref(who, names) if who else None,
            decided_at=d.decided_at or (row.at if row else None),
            meeting=SimpleMeetingRef(id=m.id, title=m.title) if m else None,
            minutes_url=f"/simple/meetings/{m.id}" if m else None,
        )
    return out


# --------------------------------------------------------------------------- the page


async def decisions_page(
    db: AsyncSession,
    principal: Any,
    prd: str | None = None,
    goal: str | None = None,
    meeting: uuid.UUID | None = None,
) -> SimpleDecisionsOut:
    """Direction B "By meeting": each meeting's decisions under it, beside its minutes,
    newest first; then the decisions taken outside meetings. Filters: a PRD (slug or id),
    a goal (key or id), a meeting."""

    ms = list(await db.scalars(select(SimpleMeeting).order_by(SimpleMeeting.started_at.desc())))
    docs = {d.id: d for d in await db.scalars(
        select(Document).where(Document.kind == "prd", Document.deleted_at.is_(None)))}  # fmt: skip
    readable = {i for i, d in docs.items() if await _readable(db, principal, d)}
    # simple-replaced-prds: a replaced PRD leaves the PRD filter and its open questions; its
    # past meetings, their decisions and its decided questions stay as history.
    from oracle.roadmap import company

    replaced = readable & await company.replaced_prd_ids(db)
    ms = [m for m in ms if m.prd_document_id in readable]
    from oracle.simple import meetings

    await meetings._settle(db, ms)
    from oracle.simple import questions as prd_questions

    # The PRDs' questions read first: a decided one belongs with the decisions below
    # (read-speed: all PRDs' in three statements, not three each).
    await prd_questions.ensure_all(db, [docs[i] for i in readable])
    from oracle.simple import drafts

    # read-speed: the rest writes nothing, so the members, documents and tracks its parts
    # read are read once (drafts.one_read), as the roadmap read does.
    with drafts.one_read():
        return await _decisions_page(
            db, principal, prd, goal, meeting, ms, docs, readable, replaced
        )


async def _decisions_page(
    db: AsyncSession,
    principal: Any,
    prd: str | None,
    goal: str | None,
    meeting: uuid.UUID | None,
    ms: list[SimpleMeeting],
    docs: dict[uuid.UUID, Document],
    readable: set[uuid.UUID],
    replaced: set[uuid.UUID],
) -> SimpleDecisionsOut:
    from oracle.simple import meetings, service

    read = await service.load(db)
    goals = {e.goal.id: e.goal for e in read.entries if e.goal is not None}
    prd_doc = None
    if prd:
        prd_doc = next((d for d in docs.values() if prd in (str(d.id), d.slug)), None)
        if prd_doc is None or prd_doc.id not in readable or prd_doc.id in replaced:
            raise MeetingError(404, "No such PRD")
    goal_ent = None
    if goal:
        goal_ent = next((g for g in goals.values() if goal in (str(g.id), g.key)), None)
        if goal_ent is None:
            raise MeetingError(404, "No such goal")
    # Subject ids each filter matches.
    match: set[str] | None = None
    if prd_doc is not None or goal_ent is not None:
        entries = [
            e for e in read.entries
            if (prd_doc is None or (e.prd is not None and e.prd.id == prd_doc.id))
            and (goal_ent is None or (e.goal is not None and e.goal.id == goal_ent.id))
        ]  # fmt: skip
        match = {str(e.row.id) for e in entries}
        if prd_doc is not None:
            match.add(str(prd_doc.id))
            all_items, _ = await _prd_items(db, prd_doc)
            if goal_ent is None:
                match |= {str(i) for i in all_items}
        if goal_ent is not None:
            match.add(str(goal_ent.id))

    def keep(d: Decision) -> bool:
        return match is None or any(str(s.get("id")) in match for s in d.subjects or [])

    links = await _decisions(db, [m.id for m in ms])
    in_meetings = {d.id for lst in links.values() for _, d in lst}
    shown_ms = [m for m in ms if meeting is None or m.id == meeting]
    if prd_doc is not None:
        shown_ms = [m for m in shown_ms if m.prd_document_id == prd_doc.id
                    or any(keep(d) for _, d in links[m.id])]  # fmt: skip
    elif match is not None:
        shown_ms = [m for m in shown_ms if any(keep(d) for _, d in links[m.id])]
    others: list[Decision] = []
    if meeting is None:
        # A PRD's open question is listed as a question (Waiting for you), not here.
        q = select(Decision).where(Decision.origin != "meeting", PRODUCT, or_(
            Decision.origin != "prd", Decision.status == "decided"))  # fmt: skip
        if in_meetings:
            q = q.where(Decision.id.not_in(in_meetings))
        if match is not None:
            # The filter before the limit: an older matching decision is not crowded out.
            q = q.where(or_(*[Decision.subjects.contains([{"id": i}]) for i in match]))
        q = q.order_by(Decision.number.desc()).limit(200)
        others = [d for d in await db.scalars(q) if keep(d)]
    from oracle.simple import decision_sheet

    edited = await decision_sheet.edits(
        db, {d.id for lst in links.values() for _, d in lst} | {d.id for d in others}
    )
    names = await meetings._names(db, {d.approver_id for lst in links.values() for _, d in lst}
                         | {d.approver_id for d in others} | _note_authors(shown_ms)
                         | {by for _, by in edited.values()})  # fmt: skip
    flows = await decided_flows(db, [x for m in shown_ms for x in links[m.id]])
    # The PRDs this reader reads, by id: a decided question's row names its PRD.
    prds = {str(i): docs[i].title for i in readable}
    groups = []
    for b, m in zip(await meetings.briefs(db, shown_ms), shown_ms, strict=True):
        minutes = SimpleMinutes.model_validate(m.minutes) if m.minutes else None
        # A PRD's own meeting shows all its decisions; otherwise those the filter names.
        whole = prd_doc is not None and goal_ent is None and m.prd_document_id == prd_doc.id
        groups.append(SimpleMeetingGroup(
            meeting=b,
            minutes=await meetings._named(db, minutes) if minutes else None,
            decisions=[_row(d, names, principal, edited, prds).model_copy(
                           update={"flow": flows.get(d.id)})
                       for _, d in links[m.id] if whole or keep(d)],
            notes=[n for n in await meetings._notes_out(db, m, names)
                   if n.kind in ("note", "comment")],
            delivery=await meetings.delivery_out(db, m) if m.minutes_state == "sent" else None,
            can_retry_delivery=m.minutes_state == "sent" and may_retry(principal, m),
        ))  # fmt: skip
    # An open decision a shown meeting's minutes name as an open question ("D-12: ...")
    # is listed there, not again outside meetings; once decided it is listed here.
    named = {int(g.group(1)) for m in shown_ms
             for q in (m.minutes or {}).get("open_questions") or []
             if (g := _OPEN_DECISION.match(str(q)))}  # fmt: skip
    others = [d for d in others if d.status == "decided" or d.number not in named]
    from oracle.simple import questions

    # The questions follow the filters too: the PRD's, the goal's PRDs', the meeting's.
    qdocs = {prd_doc.id} if prd_doc is not None else set(readable)
    if goal_ent is not None:
        qdocs &= {
            e.prd.id
            for e in read.entries
            if e.prd is not None and e.goal is not None and e.goal.id == goal_ent.id
        }
    only = {d.id for _, d in links.get(meeting, [])} if meeting is not None else None
    run_groups = (
        []
        if meeting is not None or goal_ent is not None
        else await _run_groups(db, principal, {i: docs[i] for i in qdocs})
    )
    return SimpleDecisionsOut(
        **await questions.page_fields(db, principal, qdocs, only, replaced),
        meetings=groups,
        other=[_row(d, names, principal, edited, prds) for d in others],
        # prd-order: the PRD filter lists the PRDs in the company PRD order.
        prds=[SimpleFilterOption(id=d.slug, title=d.title)
              for d in await sort_prds(db, docs.values())
              if d.id in readable and d.id not in replaced],
        # goal-order: the Goal filter lists the goals in the one goal order.
        goals=[SimpleFilterOption(id=g.key, title=g.title)
               for g in sort_goals(goals.values())],
        meeting_options=[SimpleFilterOption(id=str(m.id), title=_meeting_option_title(m))
                         for m in ms],  # fmt: skip
        runs=run_groups,
    )  # fmt: skip
