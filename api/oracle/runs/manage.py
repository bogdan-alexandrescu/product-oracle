"""Runs: an owner's controls on a run (cancel, stop, retry, resume, retry an import or a
lookup, stop cancelling) and the checks a decision on a scope, an order or a draft runs."""

import asyncio
import copy
import uuid
import weakref
from datetime import timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, webhooks
from oracle.auth.deps import Principal
from oracle.auth.models import ApiToken, User
from oracle.authz import has_role
from oracle.docs import service as docs_service
from oracle.docs.schemas import ImportProblem
from oracle.errors import exception_text
from oracle.priorities import run_order
from oracle.priorities.models import PrioritySnapshot
from oracle.runs import feature_set, flows, rejection, service
from oracle.runs.models import Checkpoint, Run, RunSegment
from oracle.runs.scope_models import PrdScope
from oracle.runs.service import (
    CANCEL_FOLLOW_UP_GRACE_SECONDS,
    CHECKPOINT_TITLES,
    FINAL,
    RESUME_VOIDED,
    STUCK_LOOKUP_SECONDS,
    Forbidden,
    NotFound,
    RunError,
    Unavailable,
    _accepted,
    _add_attempt,
    _adopt,
    _advance,
    _after_search,
    _art,
    _can_dismiss_overrun,
    _cancel_again_ids,
    _cancel_call,
    _cancel_follow_up,
    _cancel_pending,
    _Cancelled,
    _ceiling,
    _checkpoints,
    _cost_on,
    _cost_unknown,
    _creator,
    _credential_end,
    _current_attempt,
    _end_workflow,
    _finish,
    _flow,
    _found_apply,
    _found_call,
    _found_cancels,
    _import_draft,
    _import_failed,
    _link_requests,
    _live,
    _note,
    _note_art,
    _overrun,
    _parse_at,
    _search_for,
    _segments,
    _set_art,
    _set_knob,
    _set_wait,
    _settle_cancel_follow_ups,
    _shown,
    _submit,
    _target_kind,
    _TickStats,
    log,
    unqueue,
)
from oracle.runtokens import revoke_run_tokens
from oracle.swarm import RecordedAnswer, RuntimeUnavailable
from oracle.tenancy import current_tenant


async def _may_manage(db: AsyncSession, principal: Principal, run: Run) -> bool:
    """An owner, or the approver who created the run; the role read now (the caller
    holds the gate), not the one the request authenticated with."""
    from oracle.auth.service import caller_refusal

    if await caller_refusal(db, principal, "owner") is None:
        return True
    return principal.id == run.created_by and (
        await caller_refusal(db, principal, "approver") is None
    )


async def _still_manages(
    db: AsyncSession, principal: Principal, run_id: uuid.UUID, what: str
) -> Run:
    """After a runtime call made with nothing held: the review gate taken again (shared),
    the run locked and read as it is now, and the caller re-read under the gate (CR-06),
    as :func:`cancel` does: the transaction that checked them ended before the call, and a
    disable or a demotion may have committed while SwarmCloud answered. 403 if they may no
    longer ``what``."""
    from oracle.auth.service import caller_refusal
    from oracle.review import publish

    await publish.gate_lock(db, shared=True)
    run = await service._get_run(db, run_id, lock=True)
    if not await _may_manage(db, principal, run):
        raise Forbidden(f"Only an owner or the approver who created the run can {what}")
    refusal = await caller_refusal(db, principal, "approver")
    if refusal is not None:
        raise Forbidden(refusal)
    return run


def _manages(principal: Principal, run: Run) -> bool:
    """:func:`_may_manage` by the role the request authenticated with: for what the
    Inbox lists (every action re-reads the role)."""
    return principal.role == "owner" or (
        has_role(principal.role, "approver") and principal.id == run.created_by
    )


def _cancel_stuck(run: Run) -> dict[str, Any] | None:
    """The live workflow whose cancel is past :data:`NOT_FOUND_TRIES` 404s that prove
    nothing (in the Inbox with Cancel), if any."""
    wf = _live(run)
    return wf if wf is not None and (wf.get("cancel_pending") or {}).get("stuck") else None


async def _stop_cancelling(db: AsyncSession, run: Run) -> bool:
    """Stop cancelling a workflow whose cancel is stuck on 404s (P3d, owner 2026-10-19):
    the cancel calls stop and the Inbox item clears, but the workflow is never detached
    from the run's spend. It goes on ``searches`` with its id, so its status and cost are
    still read (on every tick) until SwarmCloud says it ended, its cost counted in the
    run's spend against the ceiling. A run that has not ended ends (:func:`_end_stopped`):
    no second workflow starts for that segment."""
    wf = _cancel_stuck(run)
    if wf is None:
        return False
    pending = wf.get("cancel_pending") or {}
    stopped = (
        f"An approver stopped cancelling workflow {wf.get('id')}: SwarmCloud answered HTTP "
        f"404 {pending.get('not_found')} times without saying it does not exist "
        f"({pending.get('error')}). Oracle no longer cancels it, but keeps reading its status "
        "and cost on every tick until it ends, and counts its spend on the run. If it still "
        "runs, cancel it in SwarmCloud's console."
    )
    log.warning("run %s: %s", run.id, stopped)
    _search_for(
        run,
        label=wf.get("label") or wf["id"],
        seq=wf.get("start_seq"),
        submitted_at=wf.get("submitted_at") or pending.get("since"),
        until=_credential_end(wf),
        why="stopped",
        workflow_id=wf["id"],
        cancel=False,
    )
    segments = await _segments(db, run.id)
    target = next((s for s in segments if s.seq == wf.get("start_seq")), None)
    if target is not None or segments:
        _note(target or segments[0], stopped)
    await _end_workflow(db, run, wf, pending.get("state") or "cancelled", stopped=True)
    if run.status not in FINAL:
        await _end_stopped(db, run, segments, wf)
    return True


async def _end_stopped(
    db: AsyncSession, run: Run, segments: list[RunSegment], wf: dict[str, Any]
) -> None:
    """P3d (owner, 2026-10-19): Stop cancelling on a run that has not ended ends the run
    (cancelled, the reason recorded). The stopped workflow stays on ``searches``; a lost
    submission of a pending segment is looked for in the background, as Cancel does."""
    for s in segments:
        if s.status not in ("running", "pending"):
            continue
        lost = _art(s).get("lost")
        if s.status == "pending" and isinstance(lost, dict) and lost.get("label"):
            _search_for(
                run,
                label=lost["label"],
                seq=s.seq,
                submitted_at=lost.get("submitted_at"),
                until=_credential_end(lost),
                why="cancel",
            )
        s.status = "cancelled"
        s.finished_at = s.finished_at or service._now()
    for cp in await _checkpoints(db, [run.id]):
        if cp.status == "pending":
            cp.status = "skipped"
            cp.note = "Run ended: an approver stopped cancelling its workflow."
            cp.decided_at = service._now()
    _set_knob(run, "stuck_lookup", None)
    _set_knob(run, "post_404", None)
    _set_knob(run, "queue_wait", None)
    run.status = "cancelled"
    run.finished_at = service._now()
    _set_knob(run, "spent_at_end", str(run.spent_usd or 0))
    run.error = (
        f"Stop cancelling ended the run: Oracle no longer cancels workflow {wf.get('id')}, "
        "and its spend still counts on the run until SwarmCloud stops it."
    )
    await revoke_run_tokens(db, run.id)


async def stop_cancelling(db: AsyncSession, principal: Principal, run_id: uuid.UUID) -> None:
    """Stop cancelling from the Inbox (a cancel stuck on 404s, whatever the run's state):
    see :func:`_stop_cancelling`."""
    run = await service._get_run(db, run_id, lock=True)
    if not await _may_manage(db, principal, run):
        raise Forbidden("Only an owner or the approver who created the run can stop this")
    ended = run.status not in FINAL
    if not await _stop_cancelling(db, run):
        raise RunError("nothing to stop: no cancel of this run waits on SwarmCloud's 404s")
    await audit.record(db, principal, "run.cancel_stopped", "run", run.id, {"ended_run": ended})
    await db.commit()


class TooSoon(RunError):
    status = 429


# Retry lookup reads one workflow now; once per run in this long.
RETRY_LOOKUP_SECONDS = 30


async def retry_lookup(db: AsyncSession, principal: Principal, run_id: uuid.UUID) -> None:
    """Retry lookup from the Inbox: the searched workflow whose cost is unknown (its
    status does not read) is read now, not at its next rest; read, it is followed as
    before. That one workflow only, SwarmCloud called without the run's row lock, and at
    most once per :data:`RETRY_LOOKUP_SECONDS` per run."""
    run = await service._get_run(db, run_id, lock=True)
    if not await _may_manage(db, principal, run):
        raise Forbidden("Only an owner or the approver who created the run can retry this")
    entry = _cost_unknown(run)
    if entry is None:
        raise RunError("nothing to look up: no workflow of this run has an unknown cost")
    last = _parse_at((run.knobs or {}).get("lookup_retried_at"))
    if last is not None and (service._now() - last).total_seconds() < RETRY_LOOKUP_SECONDS:
        raise TooSoon(
            f"Retry lookup read this run's workflow less than {RETRY_LOOKUP_SECONDS} s ago; "
            "try again shortly"
        )
    _set_knob(run, "lookup_retried_at", service._now().isoformat())
    entry = copy.deepcopy(entry)
    wid = entry["id"]
    # Committed: the cooldown holds for a second click, and the row lock is released
    # before SwarmCloud is called.
    await db.commit()
    cancelling = _found_cancels(entry)
    out = await _found_call(entry)

    # Under the gate and the lock, as the run and the caller are now.
    run = await _still_manages(db, principal, run_id, "retry this")
    segments = await _segments(db, run.id, fresh=True)
    entries = copy.deepcopy((run.knobs or {}).get("searches") or [])
    e = next((x for x in entries if x.get("id") == wid), None)
    if e is not None:
        target = segments[0] if segments else None
        segment = next((x for x in segments if x.seq == e.get("seq")), target)
        e["read_at"] = service._now().isoformat()
        dropped: list[dict[str, Any]] = []
        if not _found_apply(run, segments, segment, e, out, cancelling):
            entries.remove(e)
            if e.get("dropped"):
                dropped.append(e)
        _set_knob(run, "searches", entries or None)
        await _after_search(db, run, target, _TickStats(), dropped)
    await audit.record(db, principal, "run.lookup_retried", "run", run.id, {"workflow_id": wid})
    await db.commit()


async def retry_import(db: AsyncSession, principal: Principal, run_id: uuid.UUID) -> None:
    """Retry from the Inbox's "Couldn't import" (owners only): the step whose resumed
    advance stopped at :data:`RESUME_TRIES` is advanced again by the next tick, with its
    count reset. Audited."""
    if principal.role != "owner":
        raise Forbidden("Only an owner can retry importing a run's output")
    run = await service._get_run(db, run_id, lock=True)
    failed = _import_failed(run)
    if failed is None:
        raise RunError("nothing to retry: no import of this run has stopped")
    segments = await _segments(db, run.id)
    segment = next((s for s in segments if s.seq == failed.get("seq")), None)
    art = _art(segment) if segment is not None else {}
    attempt = _current_attempt(art, segment) if segment is not None else {}
    if segment is None or segment.status != "failed" or attempt.get("advanced") != "opening":
        _set_knob(run, "import_failed", None)
        await db.commit()
        raise RunError("nothing to retry: the run changed since its import stopped")
    attempt.pop("resume_failures", None)
    _note_art(
        art,
        f"An owner retried importing {segment.name}'s output (it failed with "
        f"{failed.get('error')} on {failed.get('count')} tries in a row).",
    )
    _set_art(segment, art)
    segment.status = "succeeded"
    segment.error = None
    _set_knob(run, "import_failed", None)
    await audit.record(
        db,
        principal,
        "run.import_retried",
        "run",
        run.id,
        {"segment": segment.name, "error": failed.get("error"), "tries": failed.get("count")},
    )
    await db.commit()


def _review_of(checkpoints: list[Checkpoint], seq: int) -> Checkpoint | None:
    """The segment's latest checkpoint (its review), open or decided."""
    ours = [c for c in checkpoints if (c.payload or {}).get("segment_seq") == seq]
    return ours[-1] if ours else None


async def _scope_of(db: AsyncSession, cp: Checkpoint) -> PrdScope | None:
    """The PRD scope a feature-set checkpoint decides (C6), if it has one."""
    if cp.kind != "feature_set":
        return None
    raw = (cp.payload or {}).get("scope_id")
    if raw:
        try:
            found = await db.get(PrdScope, uuid.UUID(str(raw)))
        except ValueError:
            found = None
        if found is not None:
            return found
    return await db.scalar(select(PrdScope).where(PrdScope.checkpoint_id == cp.id))


async def _recheck_scope(db: AsyncSession, cp: Checkpoint) -> int:
    """Re-check the scope a feature-set checkpoint decides as stored (C6 rule 3,
    :func:`feature_set.check_scope`) and keep the result on the checkpoint, so every
    approval path (the web, the Inbox, MCP, a console approval) refuses on the same
    problems. Returns the blocking problems now open (0 without a scope: a run from
    before scopes approves as before)."""
    scope = await _scope_of(db, cp)
    if scope is None:
        return 0
    check = (await feature_set.check_scope(db, scope)).as_json()
    cp.payload = {**(cp.payload or {}), "feature_set_check": check}
    return feature_set.blocking_of(check)


async def _recheck_order_goals(
    db: AsyncSession, cp: Checkpoint, *, add: bool = True
) -> list[dict[str, Any]]:
    """Re-check the goals a priority order's new features serve (C8), as of now: one
    rejected or deleted since the order was checked is a blocking problem kept on the
    order's check and the checkpoint's, so every approval path refuses on it; one whose goal
    is back (restored, confirmed again) is dropped, so Approve order accepts it. ``add``
    (approval): a newly stale goal is added; a read only drops what no longer holds.
    Returns the stale-goal problems open now."""
    if cp.kind != "priority_order" or cp.status != "pending":
        return []
    snapshot = await run_order.snapshot_for(db, cp)
    if snapshot is None or snapshot.status != "proposed":
        return []
    check, stale = await run_order.recheck_goals(db, snapshot, add=add)
    if check != (snapshot.check_result or {}):
        snapshot.check_result = check
        cp.payload = {**(cp.payload or {}), "priority_check": check}
    return stale


async def _scope_decided(
    db: AsyncSession, principal: Principal | None, run: Run, cp: Checkpoint
) -> None:
    """A feature-set checkpoint was decided (any path): approved, its scope is approved
    and supersedes the document's earlier approved one (rule 3); changes requested, the
    proposed scope is superseded (rule 4) and the re-run writes the next attempt's. A
    priority-order checkpoint's snapshot likewise (C8, :func:`_order_decided`)."""
    await _order_decided(db, principal, run, cp)
    scope = await _scope_of(db, cp)
    if scope is None:
        return
    if cp.status == "approved":
        # C7 Approve with edits: what people added or reworded becomes the approver's
        # own baseline writes, in this transaction (no agent round).
        from oracle.runs import scope_review

        edits = (
            await scope_review.approved(db, principal, run, cp, scope)
            if scope.status == "proposed"
            else {}
        )
        await feature_set.approve(db, scope, cp.decided_by, run.document_id)
        await audit.record(
            db,
            principal if principal is not None else audit.ORACLE,
            "prd_scope.approved",
            "prd_scope",
            scope.id,
            {"run_id": str(run.id), "checkpoint_id": str(cp.id), "by": str(cp.decided_by),
             **edits},
        )  # fmt: skip
    elif cp.status == "changes_requested" and scope.status == "proposed":
        scope.status = "superseded"
        scope.lock_version += 1


async def _scope_reopened(db: AsyncSession, cp: Checkpoint) -> None:
    """A feature-set decision was voided or not posted: its scope is proposed again (an
    earlier approved scope it superseded stays superseded until this one is decided). A
    priority-order decision's snapshot is proposed again too (C8)."""
    snapshot = await run_order.snapshot_for(db, cp)
    if snapshot is not None and snapshot.status != "proposed":
        run_order.reopen(snapshot)
    scope = await _scope_of(db, cp)
    if scope is None or scope.status == "proposed":
        return
    scope.status = "proposed"
    scope.approved_by = None
    scope.approved_at = None
    scope.lock_version += 1


async def _accept_new(
    db: AsyncSession,
    run: Run,
    snapshot: PrioritySnapshot,
    principal: Principal | None,
    decided_by: uuid.UUID | None = None,
) -> None:
    """RP1: an approved order adds its new features to the baseline as proposed, for
    ``principal``; with none (a console answer, or Oracle saved the order), for the member
    who decided, else for the run's creator. With no one to act for, the run's history says
    the features were not added."""
    if principal is None:
        user = await db.get(User, decided_by) if decided_by else None
        if user is None and run.created_by:
            user = await db.get(User, run.created_by)
        token = None if user or not run.created_by else await db.get(ApiToken, run.created_by)
        try:
            principal = _creator(current_tenant(db), user, token)
        except LookupError:
            principal = None
    if principal is None:
        if any(r.get("new") for r in snapshot.ranking or []):
            await audit.record(
                db,
                audit.ORACLE,
                "priority_snapshot.new_features_not_added",
                "priority_snapshot",
                snapshot.id,
                {"run_id": str(run.id), "reason": "no active member to act for"},
            )
        return
    await run_order.accept_new(db, snapshot, principal)


async def _order_decided(
    db: AsyncSession, principal: Principal | None, run: Run, cp: Checkpoint
) -> None:
    """C8 rules 3 and 4: a priority-order checkpoint approved saves its snapshot for the
    PRD (audited ``priority_snapshot.approved``); changes requested discards it."""
    snapshot = await run_order.snapshot_for(db, cp)
    if snapshot is None or snapshot.status != "proposed":
        return
    if cp.status == "approved":
        run_order.approve(snapshot, cp.decided_by, run.document_id)
        await _accept_new(db, run, snapshot, principal, cp.decided_by)
        await audit.record(
            db,
            principal if principal is not None else audit.ORACLE,
            "priority_snapshot.approved",
            "priority_snapshot",
            snapshot.id,
            {"run_id": str(run.id), "checkpoint_id": str(cp.id), "by": str(cp.decided_by)},
        )
    elif cp.status == "changes_requested":
        run_order.discard(snapshot, cp.decided_by)


# What the Inbox says of a console approval held while the feature set has blocking problems
# (D3 Approve blocked by problems, "Console gate", decided 2026-10-20).
CONSOLE_BLOCKED = "Blocking problems are open: fix or waive them, then confirm"


async def _hold_console_approval(
    db: AsyncSession,
    run: Run,
    cp: Checkpoint,
    segment: RunSegment,
    record: RecordedAnswer,
    wait: dict[str, Any],
    at: str | None,
    revise: bool,
    member: User | None,
) -> None:
    """A counted console approval of a feature set or a priority order with blocking
    problems open: recorded, not followed. The checkpoint stays pending with ``needs =
    "confirm"`` (so the run's token stays read-only, :func:`_holds_token`), nothing is
    posted to the workflow, and Confirm is refused like Approve until the problems are
    fixed or waived."""
    console = service._console_record(run, segment, record, at, revise)
    console.update(
        counted=True,
        reason=CONSOLE_BLOCKED,
        needs="confirm",
        role=member.role if member is not None else None,
        member_id=str(member.id) if member is not None else None,
        blocking=True,
    )
    wait["console"] = console
    _set_wait(cp, wait)
    await audit.record(
        db,
        None,
        "checkpoint.console_answer",
        "checkpoint",
        cp.id,
        {
            "run_id": str(run.id),
            "kind": cp.kind,
            "answered_in": "swarmcloud",
            "answered_by": record.answered_by,
            "verdict": record.verdict,
            "counted": True,
            "held": "blocking_problems",
        },
    )
    _note(
        segment,
        f"{cp.kind} was approved in SwarmCloud by {record.answered_by or 'someone'}: "
        f"{service._said(record, at)}. The {CHECKPOINT_TITLES.get(cp.kind, cp.kind).lower()} has "
        "blocking problems, so Oracle recorded the "
        "approval and did not follow it: the checkpoint stays open in the Inbox, and an "
        "approver confirms it once the problems are fixed or waived, or requests changes.",
    )


# Approving a review is refused while its draft is not imported (owner, 2026-10-20): a
# run approved past a refused draft finished with no document.
NOT_IMPORTED = "the draft was not imported: retry import, or send it back to the writer"


def _cannot_approve(cp: Checkpoint) -> str | None:
    """Why approving this checkpoint is refused now (web, Inbox and MCP alike): the draft
    its segment left was refused at import (until Retry import imports it). Blocking
    problems, the feature set's (C6) and the priority order's (C8) included, are the
    approve gate's (D3, oracle.runs.gate)."""
    imp = (cp.payload or {}).get("import")
    if cp.status == "pending" and isinstance(imp, dict) and imp.get("error"):
        return not_imported(imp)
    return None


def not_imported(imp: dict[str, Any]) -> str:
    """The stop's refusal of a draft not imported, naming what is wrong with it in plain
    words (Nov 3): "the draft was not imported: 1 resolution isn't valid;
    retry import, or send it back to the writer"."""
    problems = []
    for raw in imp.get("problems") or []:
        try:
            problems.append(ImportProblem.model_validate(raw))
        except ValueError:
            continue
    said = "; ".join(rejection.causes(problems)) if problems else ""
    if not said:
        return NOT_IMPORTED
    head, _, tail = NOT_IMPORTED.partition(": ")
    return f"{head}: {said}; {tail}"


def _run_version(segments: list[RunSegment], checkpoints: list[Checkpoint]) -> str | None:
    """A document version this run imported, any attempt (each attempt's import is on its
    checkpoint's payload, the current one on its segment), as ``slug vN``."""
    imports = [(s.artifacts or {}).get("import") for s in segments]
    imports += [(c.payload or {}).get("import") for c in checkpoints]
    for imp in imports:
        if isinstance(imp, dict) and imp.get("version") is not None and not imp.get("error"):
            return f"{imp.get('slug')} v{imp['version']}"
    return None


def one_version(version: str) -> str:
    """Why a finished run's refused draft is not imported once the run imported a version
    (owner, 2026-10-25), in plain words, with what to do instead."""
    return (
        f"this run already imported {version}, and a finished run imports one version only, "
        "so this draft is not imported. Start a new run to draft it again."
    )


def _draft_retry_refusal(
    run: Run,
    segment: RunSegment,
    review: Checkpoint | None,
    kind: str,
    version: str | None,
) -> str | None:
    """Why the segment's draft cannot be imported again now; None when it can: its import
    at segment end was refused, its draft file is kept, and either the run waits at its
    review, or the run finished (its review approved past the refusal) with no version
    imported by any of its attempts (``version``)."""
    name = flows.draft_file(kind)
    if not _flow(run).segment(segment.name).imports_draft:
        return f"{segment.name} imports no draft"
    art = segment.artifacts or {}
    imp = art.get("import")
    if not isinstance(imp, dict) or not imp.get("error"):
        if isinstance(imp, dict) and imp.get("version") is not None:
            return f"{name} of {segment.name} was imported ({imp.get('slug')} v{imp['version']})"
        return f"no import of {segment.name}'s {name} was refused"
    if run.status in ("cancelled", "failed"):
        return "the run was cancelled" if run.status == "cancelled" else "the run failed"
    if run.status == "succeeded":
        if review is None or review.status == "pending":
            return f"{segment.name} has no decided review"
        if version is not None:
            return one_version(version)
    elif review is not None and review.status != "pending":
        return f"{segment.name}'s review was decided ({review.status}); it is not waiting"
    elif review is None or run.status != "awaiting_checkpoint":
        return f"the run is {run.status}, not waiting at {segment.name}'s review"
    if (art.get("files") or {}).get(name) is None:
        return f"the segment left no {name} to import"
    return None


async def _slug_taken(db: AsyncSession, run: Run) -> str | None:
    """The slug of the document a run was to create (``knobs.document_slug``) when a
    document of it exists now that none of the run's versions is in: another document,
    which the run's import must not add a version to."""
    slug = None if run.document_id else (run.knobs or {}).get("document_slug")
    if not slug:
        return None
    doc = await docs_service.find_document(db, slug)
    if doc is None:
        return None
    # A version the run's agents imported themselves (push_draft) is the run's.
    return None if await docs_service.run_imported_into(db, doc.id, run.id) else slug


def _retry_refused(run: Run, segment: RunSegment, version: str | None) -> str | None:
    """The run page's plain why for a finished run's refused draft that stays refused
    because the run imported a version (owner, 2026-10-25): :func:`one_version`."""
    imp = (segment.artifacts or {}).get("import")
    if run.status != "succeeded" or version is None:
        return None
    if not isinstance(imp, dict) or not imp.get("error"):
        return None
    why = one_version(version)
    return why[:1].upper() + why[1:]


def _draft_retry_role(review: Checkpoint | None) -> str:
    """Who retries: the review's approver role or above while the run waits at it; once
    the run finished, owners only."""
    if review is not None and review.status == "pending":
        return review.approver_role
    return "owner"


def _draft_retries(
    run: Run,
    segments: list[RunSegment],
    checkpoints: list[Checkpoint],
    kind: str,
    principal: Principal | None,
) -> set[int]:
    """The segments whose refused draft ``principal`` may import again now (the run page's
    Retry import)."""
    if principal is None:
        return set()
    version = _run_version(segments, checkpoints)
    out: set[int] = set()
    for s in segments:
        review = _review_of(checkpoints, s.seq)
        if _draft_retry_refusal(run, s, review, kind, version) is None and has_role(
            principal.role,
            _draft_retry_role(review),  # type: ignore[arg-type]
        ):
            out.add(s.seq)
    return out


# A retry's import runs in a session of its own (:func:`_import_draft`), two connections
# each (no lock held): a burst imports this many at a time per process, the rest waiting
# with no connection held, so it cannot drain the pool.
DRAFT_RETRY_SLOTS = 2
_draft_retry_slots: weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Semaphore] = (
    weakref.WeakKeyDictionary()
)


def _retry_slots() -> asyncio.Semaphore:
    loop = asyncio.get_running_loop()
    slots = _draft_retry_slots.get(loop)
    if slots is None:
        slots = _draft_retry_slots[loop] = asyncio.Semaphore(DRAFT_RETRY_SLOTS)
    return slots


async def retry_draft_import(
    db: AsyncSession, principal: Principal, run_id: uuid.UUID, seq: int
) -> None:
    """:func:`_retry_draft_import`, :data:`DRAFT_RETRY_SLOTS` at a time: the request's
    connection goes back to the pool while it waits for a slot."""
    await db.commit()
    async with _retry_slots():
        await _retry_draft_import(db, principal, run_id, seq)


async def _retry_checked(
    db: AsyncSession, principal: Principal, run_id: uuid.UUID, seq: int
) -> tuple[Run, RunSegment, Checkpoint, str]:
    """The run (its row locked, under the review gate), the segment, its review and the
    run's kind, when ``principal`` may retry that segment's import now; raises otherwise."""
    from oracle.auth.service import caller_refusal
    from oracle.review import publish

    await publish.gate_lock(db, shared=True)
    run = await service._get_run(db, run_id, lock=True)
    segments = await _segments(db, run.id)
    segment = next((s for s in segments if s.seq == seq), None)
    if segment is None:
        raise NotFound(f"run {run_id} has no segment {seq}")
    checkpoints = await _checkpoints(db, [run.id])
    review = _review_of(checkpoints, seq)
    role = _draft_retry_role(review)
    if not has_role(principal.role, role):  # type: ignore[arg-type]
        if role == "owner":
            raise Forbidden("Only an owner can retry importing the draft of a finished run")
        raise Forbidden(f"Requires the {role} role")
    refused = await caller_refusal(db, principal, role)  # type: ignore[arg-type]
    if refused is not None:
        raise Forbidden(refused)
    kind = await _target_kind(db, run)
    refusal = _draft_retry_refusal(run, segment, review, kind, _run_version(segments, checkpoints))
    if refusal is not None or review is None:
        raise RunError(f"nothing to retry: {refusal}")
    return run, segment, review, kind


async def _retry_draft_import(
    db: AsyncSession, principal: Principal, run_id: uuid.UUID, seq: int
) -> None:
    """Retry import from the run page (owner, 2026-10-20): the draft a segment left, whose
    import at segment end was refused, is imported again as at segment end (an Oracle that
    now accepts it, or a cause that went away).

    While the run waits at that segment's review: by the review's approver role or above;
    the review stays open and its SwarmCloud wait is untouched, so the person still
    decides. After the run finished (the review was approved past the refusal, before that
    was refused): owners only, while no version from any of the run's attempts exists; the
    run's checkpoints do not change, and the new version goes through the document's own
    review. Refused on a cancelled or failed run.

    Imported, the run names the document and the import replaces the error on the segment
    and in the review's payload; refused again, the new error replaces the old. Either way
    noted on the segment and audited. Once imported there is nothing to retry (409).
    The import runs with nothing locked, as at segment end (:func:`_advance`): the checks
    are made under the run's row lock, committed, the draft imported in its own session,
    then the run locked and checked again before the result is written. A second retry
    that imported meanwhile finds nothing to retry then (its import of the same draft
    added nothing). The role the retry needs depends on the review (the checkpoint's
    approver role while it waits, an owner after the run finished), so it is read here:
    under the review gate, the caller is re-read with it (CR-06), before anything else."""
    run, segment, review, kind = await _retry_checked(db, principal, run_id, seq)
    if (taken := await _slug_taken(db, run)) is not None:
        raise RunError(f"{taken} now names another document: the run's draft is not added to it")
    name = flows.draft_file(kind)
    markdown = _art(segment)["files"][name]
    # Committed first: the import runs in its own transaction, with the run's row and the
    # review gate released (no second connection taken while they are held).
    await db.commit()
    imported = await _import_draft(db, run, kind, markdown)
    # Locked and checked again: the run may have been cancelled, or another retry imported.
    try:
        run, segment, review, kind = await _retry_checked(db, principal, run_id, seq)
    except RunError as exc:
        raise RunError(
            f"{exception_text(exc)} (the run changed while its draft was imported)"
        ) from exc
    finished = run.status == "succeeded"
    art = _art(segment)
    previous = art["import"]["error"]
    who = "An owner" if principal.role == "owner" else "An approver"
    after = " after the run finished" if finished else ""
    if imported.get("document_id"):
        # As at segment end (:func:`_advance`).
        run.document_id = uuid.UUID(imported["document_id"])
        _set_knob(run, "document_slug", None)
        await feature_set.fill_document(db, run.id, run.document_id)
        await run_order.fill_document(db, run.id, run.document_id)
        await _link_requests(db, run)
        _note_art(
            art,
            f"{who} retried importing {name}{after}: imported as {imported.get('slug')} "
            f"v{imported.get('version')}.",
        )
    else:
        _note_art(
            art,
            f"{who} retried importing {name}{after}: still not imported (the segment shows why).",
        )
    art["import"] = imported
    _set_art(segment, art)
    review.payload = {**(review.payload or {}), "import": imported}
    await audit.record(
        db,
        principal,
        "run.draft_import_retried",
        "run",
        run.id,
        {
            "segment": segment.name,
            "seq": seq,
            "file": name,
            "run_status": run.status,
            "previous_error": previous,
            "error": imported.get("error"),
            "document_id": imported.get("document_id"),
            "version": imported.get("version"),
        },
    )
    await db.commit()


async def cancel_again(
    db: AsyncSession, principal: Principal, run_id: uuid.UUID, workflow_id: str
) -> None:
    """Cancel again from the Inbox (P3d, owner 2026-10-19): a workflow an approver
    stopped cancelling has its cancel calls turned back on (the next tick cancels it,
    and they go on resting between tries as before). Its status and cost are still read
    on every tick until it ends; nothing restarts."""
    run = await service._get_run(db, run_id, lock=True)
    if not await _may_manage(db, principal, run):
        raise Forbidden("Only an owner or the approver who created the run can cancel this")
    # What the Inbox offers (:func:`_cancel_again_ids`), enforced here: a workflow of this
    # run that an approver stopped cancelling, on a run that has ended, whose overrun is
    # recorded and not dismissed.
    over = (run.knobs or {}).get("overrun_after_end")
    if run.status not in FINAL:
        raise RunError(f"nothing to cancel again: the run has not ended (it is {run.status})")
    if not isinstance(over, dict):
        raise RunError("nothing to cancel again: no overrun is recorded on this run")
    if over.get("dismissed_at"):
        raise RunError("nothing to cancel again: this run's overrun was dismissed")
    entries = copy.deepcopy((run.knobs or {}).get("searches") or [])
    e = next((x for x in entries if x.get("id") == workflow_id and x.get("cancel") is False), None)
    if e is None or workflow_id not in _cancel_again_ids(run):
        raise RunError(
            "nothing to cancel again: that workflow is not one Oracle stopped cancelling for "
            "this run",
            refs={"workflow": workflow_id},
        )
    for key in ("cancel", "cancel_tried_at", "cancelled"):
        e.pop(key, None)
    e["cancel_again_at"] = service._now().isoformat()
    _set_knob(run, "searches", entries)
    segments = await _segments(db, run.id)
    target = next((x for x in segments if x.seq == e.get("seq")), segments[0] if segments else None)
    if target is not None:
        _note(
            target,
            "Cancel again: Oracle cancels the workflow again (its cancel calls were stopped), "
            "and keeps reading its status and cost until it ends.",
        )
    await audit.record(
        db, principal, "run.cancel_again", "run", run.id, {"workflow_id": workflow_id}
    )
    await db.commit()


async def dismiss_overrun(db: AsyncSession, principal: Principal, run_id: uuid.UUID) -> None:
    """Dismiss an ended run's overrun from the Inbox once nothing of it is left to read:
    the item clears, the overrun stays recorded on the run."""
    run = await service._get_run(db, run_id, lock=True)
    if not await _may_manage(db, principal, run):
        raise Forbidden("Only an owner or the approver who created the run can dismiss this")
    if not _can_dismiss_overrun(run):
        raise RunError(
            "nothing to dismiss: no overrun of this run is shown, or a workflow of it is still read"
        )
    over = dict((run.knobs or {}).get("overrun_after_end") or {})
    over["dismissed_at"] = service._now().isoformat()
    _set_knob(run, "overrun_after_end", over)
    await audit.record(db, principal, "run.overrun_dismissed", "run", run.id, {})
    await db.commit()


async def end_as_oracle(db: AsyncSession, run_id: uuid.UUID, reason: str) -> bool:
    """Oracle ends a background run it started itself (INT2: a newer read of the same
    intake replaces it, or a read that could not start falls back to the built-in job):
    its live workflow is cancelled (one SwarmCloud does not confirm stays attached and the
    tick cancels it again), its open segments are cancelled and its tokens revoked. The
    caller commits. False when the run had already ended."""
    run = await service._get_run(db, run_id, lock=True)
    if run.status in FINAL:
        return False
    for segment in await _segments(db, run.id):
        if segment.status in ("pending", "running"):
            unqueue(segment)
            segment.status = "cancelled"
            segment.finished_at = service._now()
    await _finish(db, run, "cancelled", reason)
    await audit.record(db, audit.ORACLE, "run.cancelled", "run", run.id, {"reason": reason})
    return True


async def cancel(db: AsyncSession, principal: Principal, run_id: uuid.UUID) -> None:
    """Cancel the run: its workflows are cancelled (a lost submission looked up first, and
    cancelled if it landed), its checkpoints skipped. SwarmCloud is called without the
    run's row lock; the run is then read again under it and changed as it is now (what
    appeared meanwhile is called about under the lock, and a lookup is reused only for
    the very submission it was made for: its label and when it was sent). A cancel stuck
    on 404s is tried once more; still not confirmed, Oracle stops cancelling it and keeps
    reading its cost (:func:`_stop_cancelling`). On an ended run, Cancel is Stop
    cancelling."""
    run = await service._get_run(db, run_id)
    if not await _may_manage(db, principal, run):
        raise Forbidden("Only an owner or the approver who created the run can cancel it")
    if run.status in FINAL and _cancel_stuck(run) is None:
        raise RunError(f"run is already {run.status}")
    runtime = service.get_runtime()
    # What to ask SwarmCloud, read without the lock.
    wf = _live(run)
    ids: list[str] = []
    # The segment each workflow is cancelled for (its follow-up's target).
    targets: dict[str, uuid.UUID] = {}
    segments = await _segments(db, run.id)
    if wf is not None and wf.get("id") and run.status not in FINAL:
        ids.append(wf["id"])  # a stuck cancel too: one more try
        seg = next((x for x in segments if x.seq == wf.get("seq")), None) or next(
            (x for x in segments if x.swarm_workflow_id == wf["id"]), None
        )
        if seg is not None:
            targets[wf["id"]] = seg.id
    lookups: dict[tuple[str, str | None], str | None] = {}
    lost_in: dict[tuple[str, str | None], uuid.UUID] = {}
    for s in segments:
        lost = _art(s).get("lost")
        if s.status == "running" and s.swarm_workflow_id:
            ids.append(s.swarm_workflow_id)
            targets.setdefault(s.swarm_workflow_id, s.id)
        elif s.status == "pending" and isinstance(lost, dict) and lost.get("label"):
            lookups[(lost["label"], lost.get("submitted_at"))] = lost.get("submitted_at")
            lost_in[(lost["label"], lost.get("submitted_at"))] = s.id
    member_id = run.created_by or run.id
    await db.rollback()
    found: dict[tuple[str, str | None], str | None | RuntimeUnavailable] = {}
    for key, since in lookups.items():
        try:
            found[key] = await runtime.find_by_label(key[0], since=_parse_at(since))
        except RuntimeUnavailable as exc:
            log.warning("run %s: looking up %s: %s", run_id, key[0], exc)
            found[key] = exc
        if isinstance(found[key], str):
            ids.append(found[key])  # type: ignore[arg-type]
            targets.setdefault(found[key], lost_in[key])  # type: ignore[arg-type]
    ids = list(dict.fromkeys(ids))
    # Each cancel is recorded as a follow-up before SwarmCloud is called (no lock held):
    # a crash in between leaves it for the tick, after a grace that keeps the tick off
    # the call this request is making. Settled below, with the run's change.
    follow_ups = {i: _cancel_follow_up(db, member_id, targets.get(i, run_id), i) for i in ids}
    for row in follow_ups.values():
        row.next_attempt_at = service._now() + timedelta(seconds=CANCEL_FOLLOW_UP_GRACE_SECONDS)
    await db.commit()
    follow_up_ids = {i: row.id for i, row in follow_ups.items()}
    done = {i: await _cancel_call({"id": i}) for i in ids}

    # Under the review gate and the run's row lock, as the run is now: the caller is read
    # again (the transaction that checked it ended with the calls above), and what the run
    # shows now that was not asked about yet is asked about with nothing held, then the
    # run is locked and read again.
    from oracle.auth.service import caller_refusal
    from oracle.review import publish

    for _ in range(4):
        await publish.gate_lock(db, shared=True)
        run = await service._get_run(db, run_id, lock=True)
        if not await _may_manage(db, principal, run):
            raise Forbidden("Only an owner or the approver who created the run can cancel it")
        refusal = await caller_refusal(db, principal, "approver")
        if refusal is not None:
            raise Forbidden(refusal)
        if run.status in FINAL:
            break
        now_wf = _live(run)
        want_cancel: list[str] = []
        want_find: dict[tuple[str, str | None], str | None] = {}
        if now_wf is not None and now_wf.get("id"):
            want_cancel.append(now_wf["id"])
        for seg in await _segments(db, run.id, fresh=True):
            lost = _art(seg).get("lost")
            if seg.status == "running" and seg.swarm_workflow_id:
                want_cancel.append(seg.swarm_workflow_id)
            elif seg.status == "pending" and isinstance(lost, dict) and lost.get("label"):
                want_find[(lost["label"], lost.get("submitted_at"))] = lost.get("submitted_at")
        new_cancel = [i for i in dict.fromkeys(want_cancel) if i not in done]
        new_find = {k: v for k, v in want_find.items() if k not in found}
        if not new_cancel and not new_find:
            break
        await db.rollback()
        for i in new_cancel:
            done[i] = await _cancel_call({"id": i})
        for key, since in new_find.items():
            try:
                found[key] = await runtime.find_by_label(key[0], since=_parse_at(since))
            except RuntimeUnavailable as exc:
                log.warning("run %s: looking up %s: %s", run_id, key[0], exc)
                found[key] = exc
            hit = found[key]
            if isinstance(hit, str):
                done[hit] = await _cancel_call({"id": hit})
    else:
        await db.rollback()
        raise Unavailable("the run kept changing while Oracle cancelled it; cancel it again")
    await _settle_cancel_follow_ups(db, follow_up_ids, done)
    if run.status in FINAL:
        if not await _stop_cancelling(db, run):
            await db.commit()  # the follow-ups' outcomes
            raise RunError(f"run is already {run.status}")
        await audit.record(db, principal, "run.cancel_stopped", "run", run.id, {})
        await db.commit()
        return
    segments = await _segments(db, run.id)
    wf = _live(run)
    for s in segments:
        if s.status == "running" and wf is not None and s.swarm_workflow_id == wf["id"]:
            s.status = "cancelled"
            s.finished_at = service._now()
        elif s.status == "running" and s.swarm_workflow_id:
            if wf is None:
                # One workflow per segment: cancelled like the run's workflow below, and
                # cancelled again by the tick (its cost read) until SwarmCloud confirms.
                wf = service._attach_for_cancel(run, s, s.swarm_workflow_id)
            else:
                out = done.get(s.swarm_workflow_id) or await _cancel_call(
                    {"id": s.swarm_workflow_id}
                )
                if out.final is not None:
                    _cost_on(
                        run, segments, {"seq": s.seq, "id": s.swarm_workflow_id}, out.final.cost_usd
                    )
                attempt = _current_attempt(_art(s), s)
                label = attempt.get("label") or s.swarm_workflow_id
                if out.error is not None and not out.ended and not out.gone:
                    s.error = f"cancel not confirmed by the runtime: {_shown(out.error)}"
                    # Not attached (one workflow is): cancelled and costed in the
                    # background until SwarmCloud confirms.
                    _search_for(
                        run,
                        label=label,
                        seq=s.seq,
                        submitted_at=attempt.get("submitted_at"),
                        until=None,
                        why="cancel",
                        workflow_id=s.swarm_workflow_id,
                    )
                elif not out.gone and (out.final is None or not out.final.terminal):
                    # Confirmed, its status not read or not terminal yet (winding down):
                    # read in the background until it ends, its last cost counted.
                    _search_for(
                        run,
                        label=label,
                        seq=s.seq,
                        submitted_at=attempt.get("submitted_at"),
                        until=None,
                        why="cancel",
                        workflow_id=s.swarm_workflow_id,
                        cancelled=True,
                        costed=out.final is not None,
                    )
            s.status = "cancelled"
            s.finished_at = service._now()
        elif s.status == "pending":
            lost = _art(s).get("lost")
            if isinstance(lost, dict) and lost.get("label"):
                # A submission whose answer was lost may have landed: found, it is
                # cancelled; not looked up yet, the tick looks again and cancels it. Never
                # left behind: what cannot be attached is searched for in the background.
                label, since = lost["label"], lost.get("submitted_at")
                key = (label, since)
                if key in found:
                    result = found[key]
                else:
                    # Lost since Oracle looked (or sent again under the same label): the
                    # earlier lookup says nothing of it, so it is looked up now.
                    try:
                        result = await runtime.find_by_label(label, since=_parse_at(since))
                    except RuntimeUnavailable as exc:
                        result = exc
                until = _credential_end(lost)
                if isinstance(result, str):
                    if wf is None:
                        wf = service._attach_for_cancel(run, s, result, label, since, until)
                        _adopt(segments, wf)
                    else:
                        _add_attempt(s, result, label, "cancelled", mode=lost.get("mode"))
                        _search_for(
                            run,
                            label=label,
                            seq=s.seq,
                            submitted_at=since,
                            until=until,
                            why="cancel",
                            workflow_id=result,
                        )
                elif result is not None:  # neither found nor ruled out
                    if wf is None:
                        wf = service._attach_for_cancel(run, s, None, label, since, until)
                    else:
                        _search_for(
                            run,
                            label=label,
                            seq=s.seq,
                            submitted_at=since,
                            until=until,
                            why="cancel",
                        )
            s.status = "cancelled"
    for cp in await _checkpoints(db, [run.id]):
        if cp.status == "pending":
            cp.status = "skipped"
            cp.note = "Run cancelled."
            cp.decided_at = service._now()
    _set_knob(run, "stuck_lookup", None)
    # A cancel SwarmCloud does not confirm leaves the workflow attached: the tick cancels
    # it again and counts its cost. One stuck on 404s that this one more try did not
    # confirm either: Oracle stops cancelling it, and keeps reading its cost.
    await _finish(db, run, "cancelled", state="cancelled", done=done)
    await _stop_cancelling(db, run)
    if _cancel_pending(run) and segments:
        _note(
            segments[0],
            "Run cancelled; SwarmCloud did not confirm cancelling its workflow yet, so Oracle "
            "cancels it again on every tick and keeps counting its cost.",
        )
    await audit.record(db, principal, "run.cancelled", "run", run.id, {})
    await db.commit()


async def stop_run(
    db: AsyncSession,
    principal: Principal,
    run: Run,
    data: dict[str, Any] | None = None,
    *,
    deferred: list[RunSegment] | None = None,
) -> None:
    """Cancel a run that is not final (locked by the caller, who commits) without calling
    the runtime: its running segments are appended to ``deferred``, for the caller to
    cancel at the runtime after it commits (a disable, which holds the review gate); its
    pending segments and checkpoints end, its tokens die. The run's live workflow (adapter
    v2) stays attached as a cancel not confirmed yet: the tick cancels it again and reads
    its cost until SwarmCloud confirms (:func:`_apply_cancel`)."""
    segments = await _segments(db, run.id)
    for s in segments:
        if s.status == "running" and s.swarm_workflow_id:
            if deferred is not None:
                deferred.append(s)
            s.status = "cancelled"
            s.finished_at = service._now()
        elif s.status == "pending":
            unqueue(s)
            s.status = "cancelled"
    for cp in await _checkpoints(db, [run.id]):
        if cp.status == "pending":
            cp.status = "skipped"
            cp.note = "Run cancelled."
            cp.decided_at = service._now()
    wf = _live(run)
    done: dict[str, _Cancelled] = {}
    if wf is not None and wf.get("id"):
        done[wf["id"]] = _Cancelled(
            error=RuntimeUnavailable("cancelled at the runtime once the disable commits")
        )
    await _finish(db, run, "cancelled", state="cancelled", done=done)
    await audit.record(db, principal, "run.cancelled", "run", run.id, data or {})


# A failed run whose spend is over its ceiling: running a step again would only pause it.
BUDGET_STOPPED = "This run stopped at its budget; start it again with a new estimate"


def _retryable_seq(run: Run, segments: list[RunSegment]) -> int | None:
    """The segment a failed run can be retried from: the one that failed (its stop's
    approvals before it kept), while no workflow of the run is still attached and its
    spend is within its ceiling."""
    if run.status != "failed" or _live(run) is not None or _overrun(run) is not None:
        return None
    failed = [s for s in segments if s.status == "failed"]
    return failed[-1].seq if failed else None


async def retry_segment(
    db: AsyncSession, principal: Principal, run_id: uuid.UUID, seq: int
) -> None:
    """Retry a failed run from the segment that failed: that segment is queued again with
    the run's approved inputs (its snapshot, knobs and the checkpoints decided before it);
    the segments before it are not run again. An owner or the approver who created the
    run, as for Retry and Cancel. Audited; the caller commits nothing (this commits)."""
    from oracle.review import publish

    await publish.gate_lock(db, shared=True)
    run = await service._get_run(db, run_id, lock=True)
    if not await _may_manage(db, principal, run):
        raise Forbidden("Only an owner or the approver who created the run can retry it")
    segments = await _segments(db, run.id, fresh=True)
    segment = next((s for s in segments if s.seq == seq), None)
    if segment is None:
        raise NotFound("Segment not found")
    if run.status == "failed" and _overrun(run) is not None:
        raise RunError(BUDGET_STOPPED)
    if _retryable_seq(run, segments) != seq:
        raise RunError("nothing to retry: only the segment a failed run stopped at can be retried")
    was = segment.error
    art = _art(segment)
    _note_art(art, f"Retried by a person after it failed: {was or 'no reason given'}")
    _set_art(segment, art)
    segment.error = None
    segment.finished_at = None
    run.error = None
    run.finished_at = None
    if _flow(run).stores_draft_items:
        from oracle.roadmap import draft_items

        # Its draft roadmap runs again with it: no stale failure, and no Derive meanwhile.
        await draft_items.run_retried(db, run)
    await _submit(db, run, segment, segments)
    await audit.record(
        db, principal, "run.segment_retried", "run", run.id, {"seq": seq, "error": was}
    )
    await db.commit()


async def retry(db: AsyncSession, principal: Principal, run_id: uuid.UUID) -> None:
    """Retry from the Inbox: a lost submission Oracle could neither find nor rule out
    past the lookup cap. Looked up once more (without the run's row lock, then the run
    is read again under it: changed meanwhile, nothing is retried); found, it is the
    segment's workflow; else the segment is submitted again under a new key. The approver
    accepts that the lost one, if it landed, may run too (the web asks first: it can
    start a paid duplicate run): its run token is revoked, and Oracle keeps looking for
    it in the background (:func:`_search_earlier`) to cancel it and count its cost."""
    run = await service._get_run(db, run_id)
    if not await _may_manage(db, principal, run):
        raise Forbidden("Only an owner or the approver who created the run can retry it")
    stuck = (run.knobs or {}).get("stuck_lookup")
    if run.status != "running" or not isinstance(stuck, dict):
        raise RunError("nothing waits for a retry: no lost submission is past its lookup cap")
    segment = next((s for s in await _segments(db, run.id) if s.seq == stuck.get("seq")), None)
    lost = _art(segment).get("lost") if segment is not None else None
    if segment is None or segment.status != "pending" or not isinstance(lost, dict):
        # Resolved, as read without the lock: checked again under it before the marker
        # is cleared (the tick may have lost the submission again meanwhile).
        run = await service._get_run(db, run_id, lock=True)
        now = (run.knobs or {}).get("stuck_lookup")
        segment = next(
            (s for s in await _segments(db, run.id, fresh=True) if s.seq == (now or {}).get("seq")),
            None,
        )
        lost = _art(segment).get("lost") if segment is not None else None
        if now == stuck and (
            segment is None or segment.status != "pending" or not isinstance(lost, dict)
        ):
            _set_knob(run, "stuck_lookup", None)
            await db.commit()
            raise RunError("nothing waits for a retry: the submission was resolved")
        await db.rollback()
        raise RunError(
            "nothing was retried: the run changed while Oracle read it; look at it again"
        )
    label, since = lost["label"], lost.get("submitted_at")
    await db.rollback()
    runtime = service.get_runtime()
    found: str | None = None
    try:
        found = await runtime.find_by_label(label, since=_parse_at(since))
    except RuntimeUnavailable as exc:
        log.warning("run %s: retry: %s still not resolved: %s", run_id, label, exc)

    # Under the gate and the lock, as the run and the caller are now.
    run = await _still_manages(db, principal, run_id, "retry it")
    stuck = (run.knobs or {}).get("stuck_lookup")
    segments = await _segments(db, run.id)
    segment = next((s for s in segments if s.seq == (stuck or {}).get("seq")), None)
    art = _art(segment) if segment is not None else {}
    lost = art.get("lost")
    if (
        run.status != "running"
        or not isinstance(stuck, dict)
        or stuck.get("label") != label
        or segment is None
        or segment.status != "pending"
        or not isinstance(lost, dict)
        or lost.get("label") != label
    ):
        raise RunError(
            f"nothing waits for a retry: the run changed while Oracle looked for {label} "
            f"(it is {run.status}); look at it again"
        )
    _set_knob(run, "stuck_lookup", None)
    if found:
        art.pop("lost", None)
        _accepted(run, segment, art, found, lost, art.pop("pending_note", None), runtime)
    else:
        art.pop("lost", None)
        art["abandoned"] = [*(art.get("abandoned") or []), label]
        _search_for(
            run,
            label=label,
            seq=segment.seq,
            submitted_at=since,
            until=_credential_end(lost),
            why="retry",
        )
        _note_art(
            art,
            f"Retried from the Inbox by an approver: submission {label} was neither found "
            "nor ruled out, so the segment was submitted again under a new key. If the lost "
            "one landed it runs without Oracle's data (its token is revoked) until Oracle "
            f"finds it: Oracle looks for it every {service._duration(STUCK_LOOKUP_SECONDS)}, then "
            "cancels it and counts its cost.",
        )
        _set_art(segment, art)
        await revoke_run_tokens(db, run.id)
        await _submit(db, run, segment, segments)
    await audit.record(
        db, principal, "run.retried", "run", run.id, {"label": label, "found": found}
    )
    await db.commit()


async def resume(db: AsyncSession, principal: Principal, run_id: uuid.UUID) -> None:
    run = await service._get_run(db, run_id, lock=True)
    if run.status != "paused_overrun":
        raise RunError(f"run is {run.status}, not paused on overrun")
    # The owner accepts the spend so far plus another half of the estimate. A Resume is
    # a spend approval (C2): who gave it and the ceiling it replaced are kept, so a
    # demotion or disable can void it (oracle.members.service._void_spend_approvals).
    allowance = (run.estimate_usd or Decimal(0)) * (flows.OVERRUN_FACTOR - 1)
    ceiling = ((run.spent_usd or Decimal(0)) + allowance).quantize(Decimal("0.0001"))
    run.resumed_from_ceiling_usd = _ceiling(run)
    run.resumed_by = principal.id
    run.resumed_at = service._now()
    _set_knob(run, "spend_ceiling_usd", str(ceiling))
    run.status = "running"
    await audit.record(db, principal, "run.resumed", "run", run.id, {"ceiling_usd": str(ceiling)})
    await webhooks.capture(db, "run.resumed", principal, run_id=run.id)
    segments = await _segments(db, run.id)
    checkpoints = await _checkpoints(db, [run.id])
    if any(c.status == "pending" or service._owes(c) for c in checkpoints):
        # Paused while it waited on a checkpoint: it waits on it again, in the Inbox; or
        # on a decision recorded and not delivered yet, which the tick delivers now.
        run.status = "awaiting_checkpoint"
        waiting = next((c for c in checkpoints if c.status == "pending"), None)
        if waiting is not None:
            await webhooks.capture(
                db, "run.checkpoint_waiting", principal, run_id=run.id, checkpoint_id=waiting.id
            )
    elif not any(s.status == "running" for s in segments):
        # A Resume voided before its segment was submitted left that segment unqueued
        # (marked): queue it again; otherwise advance past the last segment that ran.
        voided = [s for s in segments if s.status == "pending" and _art(s).get(RESUME_VOIDED)]
        if voided:
            art = _art(voided[0])
            art.pop(RESUME_VOIDED, None)
            _set_art(voided[0], art)
            await _submit(db, run, voided[0], segments)
        else:
            done = [s for s in segments if s.status == "succeeded"]
            if done:
                await _advance(db, run, done[-1], segments, gate=True)
    await db.commit()  # the router submits what it queued (submit_queued), outside the gate
