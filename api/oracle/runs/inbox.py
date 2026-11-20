"""Runs: the Inbox, what waits for a person across runs and the company's other work."""

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any

from sqlalchemy import ColumnElement, func, literal, literal_column, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.auth.deps import Principal
from oracle.authz import has_role
from oracle.docs import visibility
from oracle.docs.models import Document, DocumentVersion
from oracle.members.leads import engineering_leads, may_decide
from oracle.review import inbox as inbox_states
from oracle.review.models import FeedbackItem
from oracle.runs import flows, service
from oracle.runs.batch import batched
from oracle.runs.models import Checkpoint, Run, RunSegment
from oracle.runs.schemas import (
    InboxAccessFailure,
    InboxAccessRequest,
    InboxCheckpoint,
    InboxCounts,
    InboxCountsOut,
    InboxDocument,
    InboxFeedbackCounts,
    InboxFeedbackItem,
    InboxOut,
    InboxRevokeFailure,
    InboxShareRevocation,
    InboxStaged,
    InboxStrategy,
    RunSummary,
)
from oracle.runs.service import (
    DECIDED,
    FINAL,
    _checkpoint_out,
    _decider_names,
    _flow,
    _import_failed,
    _live_reasons,
    _open_questions,
    _owes,
    _pending_titles,
    _Refs,
    _refs,
    _sent_back,
    _staged_actions,
    _stuck,
    _summary,
    recheck_briefs,
)


def _waits_for(item: FeedbackItem, suggestion: str | None) -> str:
    """The InboxFeedbackCounts field an open item counts under."""
    if suggestion == "open":
        return "suggestions"
    if suggestion == "accepted":
        return "accepted"
    if item.kind == "comment":
        return "comments"
    if item.kind == "section_review":
        return "verdicts"
    return "other"


async def _date_rows(db: AsyncSession, principal: Principal, leads: frozenset[uuid.UUID]) -> list:
    """F3 Date bases: the proposed schedule bases, for the engineering leads (and the owners
    while no lead is named), oldest first, each with its PRD."""
    from oracle.roadmap.models import ScheduleBasis
    from oracle.roadmap.schemas import DocumentRef, InboxDateBasis, ScheduleBasisOut

    lead = (
        principal.user_id is not None
        and principal.user_id in leads
        and has_role(principal.role, "commenter")
    )
    if not (lead or (principal.role == "owner" and not leads)):
        return []
    rows = (
        await db.execute(
            select(ScheduleBasis, Document.slug, Document.title)
            .join(Document, Document.id == ScheduleBasis.prd_document_id)
            .where(ScheduleBasis.status == "proposed")
            .order_by(ScheduleBasis.proposed_at, ScheduleBasis.id)
        )
    ).all()
    return [
        InboxDateBasis(
            **ScheduleBasisOut.model_validate(b).model_dump(),
            prd=DocumentRef(id=b.prd_document_id, slug=slug, title=title),
        )
        for b, slug, title in rows
    ]


# Runs that finished before the No document row shipped get none (#583 review): the Inbox
# does not fill with every past refused run at once. Their run pages still offer Retry
# import; the row is for runs that finish from here on.
NO_DOCUMENT_SINCE = datetime(2026, 10, 25, tzinfo=UTC)


async def _no_documents(db: AsyncSession) -> list[RunSummary]:
    """The owners' Inbox rows for runs that finished with no document (owner, 2026-10-25):
    a segment's draft was refused at import, the run succeeded past it (its review
    approved, e.g. by a console MERGE) and no attempt imported a version. Each carries
    ``no_document``: why, and the action (Retry import, else a new run).

    A row clears itself (#583 review): on a successful Retry import (the run imported a
    version), and once the run's document has a version made after the run finished (a
    later run imported it). Only runs that finished since :data:`NO_DOCUMENT_SINCE`.
    Filtered in SQL, reading only the refused import and the names of the kept files,
    never the drafts."""
    imp = RunSegment.artifacts["import"]
    imported_segment = (
        select(RunSegment.id)
        .where(
            RunSegment.run_id == Run.id,
            RunSegment.artifacts["import"]["version"].astext.is_not(None),
            func.coalesce(RunSegment.artifacts["import"]["error"].astext, "") == "",
        )
        .correlate(Run)
        .exists()
    )
    imported_review = (
        select(Checkpoint.id)
        .where(
            Checkpoint.run_id == Run.id,
            Checkpoint.payload["import"]["version"].astext.is_not(None),
            func.coalesce(Checkpoint.payload["import"]["error"].astext, "") == "",
        )
        .correlate(Run)
        .exists()
    )
    later_version = (
        select(DocumentVersion.id)
        .join(Document, Document.id == DocumentVersion.document_id)
        .where(
            or_(
                Document.id == Run.document_id,
                Document.slug == Run.knobs["document_slug"].astext,
            ),
            DocumentVersion.created_at > Run.finished_at,
        )
        .correlate(Run)
        .exists()
    )
    rows = (
        await db.execute(
            select(
                Run,
                RunSegment.seq,
                RunSegment.name,
                imp,
                func.jsonb_path_query_array(
                    RunSegment.artifacts["files"], literal_column("'$.keyvalue().key'::jsonpath")
                ),
            )
            .join(RunSegment, RunSegment.run_id == Run.id)
            .where(
                Run.status == "succeeded",
                Run.finished_at >= NO_DOCUMENT_SINCE,
                func.coalesce(imp["error"].astext, "") != "",
                ~imported_segment,
                ~imported_review,
                ~later_version,
            )
            .order_by(Run.created_at, Run.id, RunSegment.seq)
        )
    ).all()
    refused: dict[uuid.UUID, tuple[Run, RunSegment]] = {}
    for run, seq, name, refusal, files in rows:
        # Only what the retry check reads: the refusal, and which files were kept.
        light = RunSegment(
            seq=seq,
            name=name,
            artifacts={"import": refusal, "files": dict.fromkeys(files or [], "")},
        )
        refused.setdefault(run.id, (run, light))
    if not refused:
        return []
    # Each segment's review: its latest checkpoint's status, nothing else.
    reviews: dict[tuple[uuid.UUID, int], Checkpoint] = {}
    for run_id, seq, status in (
        await db.execute(
            select(
                Checkpoint.run_id, Checkpoint.payload["segment_seq"].as_integer(), Checkpoint.status
            )
            .where(Checkpoint.run_id.in_(refused))
            .order_by(Checkpoint.created_at)
        )
    ).all():
        reviews[(run_id, seq)] = Checkpoint(status=status)
    runs = [run for run, _ in refused.values()]
    kinds = dict(
        (
            await db.execute(
                select(Document.id, Document.kind).where(
                    Document.id.in_({r.document_id for r in runs if r.document_id})
                )
            )
        ).all()
    )
    refs = await _refs(db, runs)
    out: list[RunSummary] = []
    for run, segment in refused.values():
        kind = _flow(run).target_kind or kinds.get(run.document_id) or "prd"
        review = reviews.get((run.id, segment.seq))
        retry = service._draft_retry_refusal(run, segment, review, kind, None) is None
        out.append(
            _summary(run, refs, None).model_copy(
                update={"no_document": _no_document_text(run, refs, segment, retry)}
            )
        )
    return out


def _no_document_text(run: Run, refs: "_Refs", segment: RunSegment, retry: bool) -> str:
    """Why a run finished with no document, in plain words, and what to do."""
    name = (refs.get(run.document_id) if run.document_id else None) or (run.knobs or {}).get(
        "document_slug"
    )
    what = f"{name}" if name else f"The {_flow(run).title} run"
    imp = (segment.artifacts or {}).get("import") or {}
    why = imp.get("summary") or imp.get("error")
    action = (
        "Open the run and use Retry import once the problems are fixed, or start a new run."
        if retry
        else "Start a new run to draft it again."
    )
    return (
        f"{what} finished without a document: Oracle refused its draft ({why}) and the run "
        f"was approved past it. {action}"
    )


async def _revising(db: AsyncSession, principal: Principal) -> list[RunSummary]:
    """The Inbox's Revising rows (owner, 2026-10-20): runs whose refused draft Oracle sent
    back to the writer itself (:func:`_sent_back`), for those with that review's approver
    role or above, who would decide it otherwise. Shown only: nothing to decide, so not
    counted. Each carries ``sent_back``, the summary of what Oracle refused."""
    rows = (
        await db.execute(
            select(Run, RunSegment)
            .join(RunSegment, RunSegment.run_id == Run.id)
            .where(Run.status.not_in(FINAL), RunSegment.artifacts.has_key("import"))
            .order_by(Run.created_at, Run.id, RunSegment.seq)
        )
    ).all()
    runs: dict[uuid.UUID, Run] = {}
    leads = await engineering_leads(db) if rows else frozenset()
    for run, segment in rows:
        sdef = _flow(run).segment(segment.name)
        stop = SimpleNamespace(kind=sdef.checkpoint, approver_role=sdef.approver_role)
        if _sent_back(run, segment) and may_decide(principal, stop, run.flow, leads):
            runs.setdefault(run.id, run)
    for run_id in await _hidden_runs(db, principal, runs.values()):
        runs.pop(run_id)
    if not runs:
        return []
    refs = await _refs(db, list(runs.values()))
    segments: dict[uuid.UUID, list[RunSegment]] = {i: [] for i in runs}
    for seg in await db.scalars(
        select(RunSegment).where(RunSegment.run_id.in_(runs)).order_by(RunSegment.seq)
    ):
        segments[seg.run_id].append(seg)
    # Embedded in the Inbox: without its progress, as the Inbox's other run rows.
    return [
        _summary(r, refs, None, segments[r.id]).model_copy(update={"progress": None})
        for r in runs.values()
    ]


async def _hidden_runs(db: AsyncSession, principal: Principal, runs: Any) -> set[uuid.UUID]:
    """#541 part 5: the runs whose Inbox rows a reader who may not see approvers-only
    documents (oracle.docs.visibility.restricted: a commenter, a viewer, or a call made
    through a run that reads as a member, with its starter's cookie) is not shown: a run
    on such a document, or of a flow that writes only such documents (a pricing memo, an
    update), whose rows name it (its slug, its id)."""
    runs = list(runs)
    if not runs or not visibility.restricted(principal):
        return set()
    hidden_docs = await visibility.hidden_document_ids(db, [r.document_id for r in runs])
    only_hidden = {
        k
        for k, f in flows.FLOWS.items()
        if f.document_kinds
        and all(visibility.default_for(kind) == visibility.APPROVERS for kind in f.document_kinds)
    }
    return {r.id for r in runs if r.document_id in hidden_docs or r.flow in only_hidden}


@dataclass
class WaitingStop:
    """A pending run stop the reader may decide, as the one waiting list names it."""

    id: uuid.UUID
    run_id: uuid.UUID
    kind: str
    created_at: datetime
    flow_title: str
    document_title: str | None
    document_slug: str | None


async def waiting_stops(db: AsyncSession, principal: Principal) -> list[WaitingStop]:
    """The pending stops :func:`inbox` lists as the reader's ``checkpoints`` (the same
    deciders, the same hidden runs), oldest first, without the Inbox's review summaries and
    other rows: the Simple one list (oracle.simple.waiting_list) reads only these, in a
    fixed number of statements however many runs wait."""
    pending = list(
        await db.scalars(
            select(Checkpoint)
            .where(Checkpoint.status == "pending")
            .order_by(Checkpoint.created_at, Checkpoint.id)
        )
    )
    if not pending:
        return []
    runs = {
        r.id: r
        for r in await db.scalars(select(Run).where(Run.id.in_({c.run_id for c in pending})))
    }
    leads = await engineering_leads(db)
    hidden = await _hidden_runs(db, principal, runs.values())
    mine = [
        c
        for c in pending
        if c.run_id not in hidden and may_decide(principal, c, runs[c.run_id].flow, leads)
    ]
    if not mine:
        return []
    ids = {runs[c.run_id].document_id for c in mine} - {None}
    docs: dict[uuid.UUID, tuple[str, str]] = {}
    if ids:
        rows = await db.execute(
            select(Document.id, Document.slug, Document.title).where(Document.id.in_(ids))
        )
        docs = {i: (slug, title) for i, slug, title in rows.all()}
    pending_titles = await _pending_titles(db, [runs[c.run_id] for c in mine])
    out = []
    for c in mine:
        run = runs[c.run_id]
        slug, title = docs.get(run.document_id, (None, None)) if run.document_id else (None, None)
        out.append(
            WaitingStop(
                id=c.id,
                run_id=c.run_id,
                kind=c.kind,
                created_at=c.created_at,
                flow_title=_flow(run).title,
                document_title=title if run.document_id else pending_titles.get(run.id),
                document_slug=slug,
            )
        )
    return out


async def inbox(db: AsyncSession, principal: Principal, mark_seen: bool = False) -> InboxOut:
    """``mark_seen``: record this visit as my last one (after reading what was new). The
    company-wide reads its rows share (the time zone, ...) are read once (oracle.runs.batch)."""
    with batched():
        return await _inbox(db, principal, mark_seen)


# Proposals on a PRD question or a one-pager line or number: not the roadmap's.
_NOT_ROADMAP_OPS = frozenset(("decide_question", "name_decider", "edit_line", "set_section_number"))


async def inbox_counts(db: AsyncSession, principal: Principal) -> InboxCountsOut:
    """inbox-reads: the Inbox's total and its Roadmap part, for the rails' badges; the rows
    shown only (never counted) are not read."""
    with batched():
        out = await _inbox(db, principal, False, counts_only=True)
    roadmap = (
        sum(1 for p in out.simple_proposals if p.op not in _NOT_ROADMAP_OPS)
        + len(out.simple_approvals)
        + len(out.simple_goal_suggestions)
        + sum(1 for t in out.simple_track_suggestions if not t.proposed)
    )
    return InboxCountsOut(total=out.total, roadmap=roadmap)


async def mark_inbox_seen(db: AsyncSession, principal: Principal) -> None:
    """inbox-reads: records this visit as my last one (what "new" is measured from next
    time), without reading the Inbox."""
    await inbox_states.mark_seen(db, principal.id)
    await db.commit()


async def _inbox(
    db: AsyncSession, principal: Principal, mark_seen: bool, counts_only: bool = False
) -> InboxOut:
    """``counts_only`` (inbox-reads): the rows shown only are left unread (empty)."""
    pending = list(
        await db.scalars(
            select(Checkpoint)
            .where(Checkpoint.status == "pending")
            .order_by(Checkpoint.created_at, Checkpoint.id)
        )
    )
    # Decisions recorded and not delivered to the run yet (shown, nothing to decide).
    owing = [
        c
        for c in await db.scalars(
            select(Checkpoint)
            .where(Checkpoint.status.in_(DECIDED), Checkpoint.payload["wait"].has_key("posting"))
            .order_by(Checkpoint.decided_at, Checkpoint.id)
        )
        if _owes(c)
    ]
    run_ids = {c.run_id for c in [*pending, *owing]}
    runs: dict[uuid.UUID, Run] = {}
    if run_ids:
        runs = {r.id: r for r in await db.scalars(select(Run).where(Run.id.in_(run_ids)))}
    # Who decides each (A3): the engineering stops go to the leads and owners once one is
    # named; the runs' flows come from the query above, the leads in one more.
    leads = await engineering_leads(db)
    hidden_runs = await _hidden_runs(db, principal, runs.values())
    mine = [
        c
        for c in pending
        if c.run_id not in hidden_runs and may_decide(principal, c, runs[c.run_id].flow, leads)
    ]
    owed = [
        c
        for c in owing
        if c.run_id not in hidden_runs and may_decide(principal, c, runs[c.run_id].flow, leads)
    ]
    for c in mine:
        # Each row's gate counts the problems its stop's page shows.
        await recheck_briefs(db, runs[c.run_id], [c])
    names = await _decider_names(db, owed)
    staged = await _staged_actions(db, mine)
    asked = await _open_questions(db, staged)
    owner = principal.role == "owner"
    # inbox-reads: the runs waiting for an owner's approval, those stuck (below) and, for owners,
    # those whose import failed, in one read; each row says which it is.
    # Lost submissions past the lookup cap (Retry or Cancel), cancels past NOT_FOUND_TRIES
    # 404s (Stop cancelling), answer posts past them (Cancel), and searched workflows past
    # them (shown), by those who manage the run.
    live = Run.knobs["workflow"]["state"].astext == "live"
    is_managed = (
        Run.knobs.has_key("stuck_lookup")
        | Run.knobs.has_key("post_404")
        | Run.knobs.has_key("searches")
        | Run.knobs.has_key("overrun_after_end")
        # A running run's wait, before any agent of its workflow started: the knob
        # stays while it runs (later steps' holds), never after it ended.
        | (
            Run.knobs.has_key("queue_wait")
            & (Run.status == "running")
            & Run.knobs["queue_wait"]["started"].astext.is_distinct_from("true")
        )
        | live
    )
    is_waiting = Run.status.in_(("awaiting_approval", "paused_overrun"))
    is_failed = Run.knobs.has_key("import_failed")
    run_rows = (
        await db.execute(
            select(Run, is_managed, is_waiting, is_failed)
            .where(is_managed | is_waiting | is_failed if owner else is_managed)
            .order_by(Run.created_at)
        )
    ).all()
    waiting_runs: list[Run] = []
    if owner:
        waiting_runs = [r for r, _, waits, _ in run_rows if waits]
        hidden_waiting = await _hidden_runs(db, principal, waiting_runs)
        waiting_runs = [r for r in waiting_runs if r.id not in hidden_waiting]
    shown = {c.run_id for c in [*mine, *owed]}
    refs = await _refs(db, [*(r for r in runs.values() if r.id in shown), *waiting_runs])

    def item(c: Checkpoint) -> InboxCheckpoint:
        run = runs[c.run_id]
        seq = (c.payload or {}).get("segment_seq")
        sdef = _flow(run).segments[seq - 1] if seq else None
        return InboxCheckpoint(
            **_checkpoint_out(
                c,
                principal,
                names,
                flow=run.flow,
                leads=leads,
                staged=staged,
                live=live,
                open_questions=asked,
            ).model_dump(),
            flow=run.flow,  # type: ignore[arg-type]
            flow_title=_flow(run).title,
            document_slug=refs.get(run.document_id),
            document_title=refs.title(run),
            segment_title=sdef.title if sdef else None,
        )

    # D9: what each needs of me and how much, one review read each; the company-wide reads,
    # the stops' draft actions, each item's trace and the baseline rows of the runs at Confirm
    # the baseline once for them all, shared by each stop's gate (``live``) and summary.
    from oracle.runs import actions

    with batched():
        await actions.read_ahead(db, [c for c in mine if c.kind in actions.SUMMARIES], runs)
        live = await _live_reasons(db, mine)
        checkpoints = [item(c) for c in mine]
        deliveries = [item(c) for c in owed]
        for c, row in zip(mine, checkpoints, strict=True):
            row.summary = await actions.inbox_summary(
                db, c, principal, run=runs[c.run_id], console=row.console
            )

    feedback: list[InboxDocument] = []
    states: list[InboxFeedbackItem] = []
    counts = InboxCounts()
    staged: list[InboxStaged] = []
    from oracle.intake.read import inbox_due as intake_reads_due

    # INT2's intake-read rows, read below only for a reader who has one.
    # F-7: my unread webhook notices ride on the same read (R-1: no read of their own).
    seen, (has_intake_reads,), webhook_notices = await inbox_states.last_seen_and(
        db, principal.id, intake_reads_due(principal), count=_unread_webhook_notices(principal)
    )
    if has_role(principal.role, "approver"):
        # inbox-reads: the open items, their suggestions, documents and latest versions come
        # from the states' own reads, not read again.
        kept: dict[str, Any] = {}
        states, counts = await inbox_states.feedback_states(db, seen, kept)
        # Shown only (never counted): left unread for the counts alone.
        staged = [] if counts_only else await inbox_states.staged_rows(db)
        # Open feedback: what still needs a decision (staged, declined and done do not).
        waiting = {i.id for i in states if i.state in ("new", "open")}
        # Newest first, then by id (as Postgres orders uuids: by their bytes).
        items = sorted(
            sorted((f for f in kept["rows"] if f.id in waiting), key=lambda f: f.id),
            key=lambda f: f.created_at,
            reverse=True,
        )
        by_id = {i.id: i for i in states}
        by_doc: dict[uuid.UUID, list[FeedbackItem]] = {}
        for f in items:
            by_doc.setdefault(f.document_id, []).append(f)
        suggestion_status = {
            f.id: s.status for f in items if (s := kept["suggestions"].get(f.id)) is not None
        }
        if by_doc:
            docs = kept["docs"]
            latest = kept["latest"]
            for doc_id, doc_items in by_doc.items():
                d = docs[doc_id]
                waits = InboxFeedbackCounts()
                for f in doc_items:
                    field = _waits_for(f, suggestion_status.get(f.id))
                    setattr(waits, field, getattr(waits, field) + 1)
                # The review panel lists items by version raised on, then age.
                first = min(
                    (f for f in doc_items if f.section_key),
                    key=lambda f: (f.raised_on_version, f.created_at, str(f.id)),
                    default=None,
                )
                feedback.append(
                    InboxDocument(
                        document_id=d.id,
                        slug=d.slug,
                        title=d.title,
                        latest_version=latest.get(d.id),
                        open_count=len(doc_items),
                        counts=waits,
                        first_section_key=first.section_key if first else None,
                        items=[by_id[f.id] for f in doc_items[:5]],
                    )
                )
            feedback.sort(key=lambda d: d.items[0].created_at, reverse=True)

    approvals = [_summary(r, refs, None) for r in waiting_runs if r.status == "awaiting_approval"]
    overruns = [_summary(r, refs, None) for r in waiting_runs if r.status == "paused_overrun"]
    revoke_failures = await _revoke_failures(db) if owner else []
    share_revocations: list[InboxShareRevocation] = []
    if owner:
        from oracle.shares.service import inbox_rows as share_rows

        share_revocations = [InboxShareRevocation.model_validate(r) for r in await share_rows(db)]
    access_failures = await _access_failures(db) if owner else []
    access_requests = await _access_requests(db, principal)
    strategy = None
    if owner:
        from oracle.strategy import drift

        row = await drift.inbox_row(db)
        strategy = InboxStrategy.model_validate(row) if row else None
    # The stuck runs, from the runs' one read above.
    managed = [r for r, manages, _, _ in run_rows if manages and service._manages(principal, r)]
    stuck_runs = [r for r in managed if _stuck(r)]
    # Submissions given up on, still looked for (shown, nothing to do): from the same read.
    searching_runs = [r for r in managed if "searches" in (r.knobs or {})]
    stuck_refs = await _refs(db, [*stuck_runs, *searching_runs])
    lookups = [_summary(r, stuck_refs, None) for r in stuck_runs]
    searches = [_summary(r, stuck_refs, None) for r in searching_runs]
    # Owners only: a run's output Oracle stopped trying to import (Retry).
    imports: list[RunSummary] = []
    if owner:
        failed_runs = [r for r, _, _, fails in run_rows if fails and _import_failed(r) is not None]
        failed_refs = await _refs(db, failed_runs)
        imports = [_summary(r, failed_refs, None) for r in failed_runs]
    no_documents = await service._no_documents(db) if owner else []
    revising = [] if counts_only else await _revising(db, principal)
    from oracle.decisions.service import inbox_rows as decision_rows
    from oracle.reports.service import inbox_rows

    reports, report_failures = await inbox_rows(db, principal)
    decisions = await decision_rows(db, principal, seen)
    counted = sum(1 for d in decisions if d.counts)
    from oracle.launches import service as launches_service

    launch_rows = await launches_service.inbox_rows(db, principal)
    from oracle.rituals.service import inbox_rows as ritual_rows

    rituals = await ritual_rows(db, principal)
    counted += sum(1 for r in rituals if r.counts)
    from oracle.metrics.review import inbox_rows as metric_rows

    metrics = await metric_rows(db, principal)
    counted += sum(1 for m in metrics if m.counts)
    from oracle.quality.outcomes import inbox_rows as outcome_rows

    outcome_inbox = await outcome_rows(db, principal)
    # H11: what Oracle did on its own, for those it notified (open ones count).
    from oracle.autonomy_router import inbox_actions

    oracle_actions = await inbox_actions(db, principal)
    dates = await _date_rows(db, principal, leads)
    from oracle.roadmap.alerts import inbox_rows as track_rows

    track_groups = await track_rows(db, principal, seen)
    # G6: invitations, mentions and changes proposed in discussions I can read.
    from oracle.discussions import inbox as discussion_inbox

    discussions = await discussion_inbox.rows(db, principal, seen)
    # H10: replies to send, asked again, answers to my own requests.
    from oracle.requests.inbox import inbox_rows as request_rows

    request_inbox = await request_rows(db, principal)
    counted += sum(1 for r in request_inbox if r.counts)
    # INT2: intakes of mine Oracle couldn't read twice in a row.
    from oracle.intake.read import inbox_rows as intake_read_rows

    intake_reads = await intake_read_rows(db, principal) if has_intake_reads else []
    counted += len(intake_reads)
    # inbox-reads: the Simple rows below share the tables each reads whole (documents, members,
    # tracks, deciders: oracle.simple.drafts.one_read), read once for them all, not once each.
    from oracle.simple.drafts import one_read

    with one_read():
        # Simple S3a: proposals waiting for me, and the decisions on mine.
        from oracle.simple.changes import inbox_rows as simple_rows

        with batched():
            # inbox-perf: each meeting's agenda (oracle.simple.agenda) in one read for them all.
            simple_proposals, simple_decisions = await simple_rows(db, principal, seen)
        counted += len(simple_proposals)
        # Simple S3b: versions from Simple drafts waiting for my approval as a required reviewer;
        # inbox-meeting-proposals fix: open date and goal suggestions I may decide; tracks-goal:
        # the PRDs waiting on Oracle's suggested track. The four are read together, in one read.
        from oracle.simple.additions import inbox_rows as goal_suggestion_rows
        from oracle.simple.drafts import inbox_rows as simple_approval_rows
        from oracle.simple.drafts import waiting as simple_waiting
        from oracle.simple.suggestions import inbox_rows as date_suggestion_rows

        simple_open = await simple_waiting(db)
        simple_approvals = await simple_approval_rows(db, principal, seen, simple_open.drafts)
        counted += len(simple_approvals)
        simple_date_suggestions = await date_suggestion_rows(db, principal, seen, simple_open.dates)
        simple_goal_suggestions = await goal_suggestion_rows(db, principal, seen, simple_open.goals)
        counted += len(simple_date_suggestions) + len(simple_goal_suggestions)
        # tracks-goal: Oracle's suggested track for a newly accepted PRD of mine with none.
        from oracle.simple.track_suggestions import inbox_rows as track_suggestion_rows

        simple_track_suggestions = await track_suggestion_rows(
            db, principal, seen, simple_open.tracks
        )
        # One waiting for its track's decider asks nothing of me: not counted.
        counted += sum(1 for s in simple_track_suggestions if s.proposed is None)
        # Simple S8: meeting minutes sent to me as an attendee (nothing to decide: not counted).
        from oracle.simple.meetings import inbox_rows as simple_minutes_rows

        simple_minutes = [] if counts_only else await simple_minutes_rows(db, principal, seen)
    if mark_seen:
        await inbox_states.mark_seen(db, principal.id)
        await db.commit()
    return InboxOut(
        checkpoints=checkpoints,
        # Not in ``total``: nothing to decide, Oracle delivers them on every tick.
        deliveries=deliveries,
        approvals=approvals,
        overruns=overruns,
        lookups=lookups,
        searches=searches,
        revising=revising,
        imports=imports,
        no_documents=no_documents,
        feedback=feedback,
        revoke_failures=revoke_failures,
        share_revocations=share_revocations,
        access_failures=access_failures,
        access_requests=access_requests,
        reports=reports,
        report_failures=report_failures,
        strategy=strategy,
        oracle_actions=oracle_actions,
        dates=dates,
        # Every new or open item (C1e, owner 2026-10-20): the rail badge, = New + Open.
        total=len(checkpoints)
        + len(dates)
        + len(approvals)
        + len(overruns)
        + len(lookups)
        + len(imports)
        + len(no_documents)
        + counts.new
        + counts.open
        + len(revoke_failures)
        + len(share_revocations)
        + len(access_failures)
        # Pending access requests (A5), for those who may approve them.
        + len(access_requests)
        + sum(1 for r in reports if not r.read)
        + len(report_failures)
        # Strategy drift: one row, however many findings.
        + (1 if strategy else 0)
        + sum(1 for r in launch_rows if r.counted)
        + sum(1 for r in outcome_inbox if r.counts)
        + sum(a.counts for a in oracle_actions)
        + sum(1 for r in discussions if r.state in ("new", "open"))
        # A track is one row, its open alerts its children (#514: as a checkpoint's items).
        + sum(1 for t in track_groups if t.counts.new + t.counts.open > 0)
        + webhook_notices
        + counted,
        webhooks=webhook_notices,
        tracks=track_groups,
        launches=launch_rows,
        rituals=rituals,
        metrics=metrics,
        outcomes=outcome_inbox,
        items=states,
        counts=counts,
        staged=staged,
        decisions=decisions,
        needs_me=counts.new + counts.open + counted,
        last_seen_at=seen,
        discussions=discussions,
        requests=request_inbox,
        intake_reads=intake_reads,
        simple_proposals=simple_proposals,
        simple_decisions=simple_decisions,
        simple_approvals=simple_approvals,
        simple_date_suggestions=simple_date_suggestions,
        simple_goal_suggestions=simple_goal_suggestions,
        simple_track_suggestions=simple_track_suggestions,
        simple_minutes=simple_minutes,
    )


WEBHOOK_NOTICE_KINDS = ("webhook_paused", "webhook_url_changed")


def _unread_webhook_notices(principal: Principal) -> ColumnElement[int]:
    """How many of my webhook notices (paused, address changed) are unread, counted Inbox
    rows (F-7), as a clause the Inbox reads in a query it makes anyway; none for a role that
    cannot open Settings › Webhooks (F-25)."""
    from oracle.authz import has_role
    from oracle.review.models import Notification

    if principal.user_id is None or not has_role(principal.role, "approver"):
        return literal(0)
    return (
        select(func.count())
        .select_from(Notification)
        .where(
            Notification.user_id == principal.user_id,
            Notification.kind.in_(WEBHOOK_NOTICE_KINDS),
            Notification.read_at.is_(None),
        )
        .scalar_subquery()
    )


async def _access_requests(db: AsyncSession, principal: Principal) -> list[InboxAccessRequest]:
    """Pending access requests, oldest first, for callers who may approve them (A5)."""
    from oracle.members import access
    from oracle.members.models import AccessRequest

    roles = list(access.invite_roles(principal))
    preset = await access.preset_role(db, principal)
    if preset is None:
        return []
    rows = await db.scalars(
        select(AccessRequest)
        .where(AccessRequest.status == "pending")
        .order_by(AccessRequest.created_at, AccessRequest.id)
    )
    return [
        InboxAccessRequest(
            id=r.id, email=r.email, note=r.note, requested_at=r.created_at,
            last_seen_at=r.last_seen_at, default_role=preset, roles=roles,
        )
        for r in rows
    ]  # fmt: skip


async def _access_failures(db: AsyncSession) -> list[InboxAccessFailure]:
    """IAP access changes still failing after 24 hours (#245): marked failed, retried
    once a day; done or no longer needed closes them."""
    from oracle.members.models import MemberFollowUp
    from oracle.members.service import ACCESS_KINDS

    rows = await db.scalars(
        select(MemberFollowUp)
        .where(MemberFollowUp.kind.in_(ACCESS_KINDS), MemberFollowUp.status == "failed")
        .order_by(MemberFollowUp.created_at, MemberFollowUp.id)
    )
    return [
        InboxAccessFailure(
            id=row.id,
            kind=row.kind,  # type: ignore[arg-type]
            email=row.email or "",
            owed="Access not removed" if row.kind == "iap_revoke" else "Access not granted",
            last_error=row.last_error,
            attempts=row.attempts,
            created_at=row.created_at,
            next_attempt_at=row.next_attempt_at,
        )
        for row in rows
    ]


async def _revoke_failures(db: AsyncSession) -> list[InboxRevokeFailure]:
    """Provider revokes a disable still owes whose last attempt did not revoke."""
    from oracle.auth.models import User
    from oracle.connections.providers import get_provider
    from oracle.members.models import MemberFollowUp
    from oracle.members.service import CALL_DONE, FOLLOW_UP_OPEN, FOLLOW_UP_RETRY_WINDOW

    rows = (
        await db.execute(
            select(MemberFollowUp, User.email)
            .outerjoin(User, User.id == MemberFollowUp.member_id)
            .where(
                MemberFollowUp.kind == "provider_revoke",
                MemberFollowUp.status.in_(FOLLOW_UP_OPEN),
                MemberFollowUp.attempts > 0,
                # Revoked, only the saving of it failed: done at the next attempt.
                or_(MemberFollowUp.outcome.is_(None), MemberFollowUp.outcome.not_in(CALL_DONE)),
            )
            .order_by(MemberFollowUp.created_at, MemberFollowUp.id)
        )
    ).all()
    out = []
    for row, email in rows:
        provider = get_provider(row.provider or "")
        name = provider.name if provider else (row.provider or "the provider")
        out.append(
            InboxRevokeFailure(
                id=row.id,
                member_id=row.member_id,
                member_email=email,
                provider=row.provider,
                provider_name=name,
                title=f"Couldn't revoke {email or 'a removed member'}'s {name} access at {name}",
                status=row.status,  # type: ignore[arg-type]
                outcome=row.outcome,
                last_error=row.last_error,
                attempts=row.attempts,
                created_at=row.created_at,
                next_attempt_at=row.next_attempt_at,
                retry_until=row.created_at + FOLLOW_UP_RETRY_WINDOW,
            )
        )
    return out
