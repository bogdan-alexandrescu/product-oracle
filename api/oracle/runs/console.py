"""Runs: a workflow's checkpoint waits read on each tick, and answers given in SwarmCloud."""

from datetime import datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.auth.models import User
from oracle.authz import has_role
from oracle.decisions import capture as decisions_capture
from oracle.engineering import check as eng_check
from oracle.engineering import dates as eng_dates
from oracle.members.leads import SPEC_FLOW, decides, engineering_leads, lead_stop
from oracle.runs import apply_edits, service, stop_answers, workflow
from oracle.runs.models import Checkpoint, CheckpointAction, Run, RunSegment
from oracle.runs.service import (
    _about,
    _checkpoints,
    _flow,
    _record_decider,
    _rt,
    _staged_actions,
    _usd,
    approve_gate_of,
    log,
)
from oracle.swarm import RecordedAnswer, RuntimeUnavailable, WorkflowStatus
from oracle.swarm.runtime import MERGE
from oracle.tenancy import current_tenant


async def _waiting_on(db: AsyncSession, run: Run, wf: dict[str, Any]) -> Checkpoint | None:
    """The run's open checkpoint whose wait is in workflow ``wf``."""
    return next(
        (
            c
            for c in await _checkpoints(db, [run.id])
            if c.status == "pending"
            and ((c.payload or {}).get("wait") or {}).get("workflow_id") == wf["id"]
        ),
        None,
    )


async def _watch_wait(
    db: AsyncSession,
    run: Run,
    wf: dict[str, Any],
    status: WorkflowStatus,
    segments: list[RunSegment],
) -> None:
    """While the run waits on a checkpoint in its workflow: read the wait (at most once
    a minute) and, when it was answered without the Inbox (in SwarmCloud's console, or
    by an earlier post of Oracle's whose response was lost), take that answer (W5: it is
    the decision only if it counts, and a counted change request the workflow has no
    revision for waits for an approver's Redo or Continue). A workflow that ended
    unanswered leaves the checkpoint in the Inbox.

    A read SwarmCloud did not serve is tried again on the next tick (the tick keeps this
    one's cost reading); a refused read of a step that SUCCEEDED is an answer Oracle
    cannot read, never "unanswered"."""
    cp = await _waiting_on(db, run, wf)
    if cp is None:
        if status.terminal:
            await _wait_ended(db, run, wf, status, segments)
        return
    wait = dict((cp.payload or {}).get("wait") or {})
    if ((wait.get("console") or {}).get("needs")) in ("confirm", "redo_or_continue"):
        return  # answered, and the first answer is final: an approver decides in the Inbox
    try:
        checked = datetime.fromisoformat(wait["checked_at"])
    except (KeyError, TypeError, ValueError):
        checked = None
    if checked is not None and (service._now() - checked).total_seconds() < service.WATCH_SECONDS:
        return
    round_ = int(wait.get("round") or 1)
    step = status.step(wait.get("step_id", ""))
    answered_step = step is not None and step.state == "SUCCEEDED"
    seq = (cp.payload or {}).get("segment_seq")
    segment = next(s for s in segments if s.seq == seq)
    try:
        record = await _rt().answer_record(
            wf["id"], wait["step_id"], wait.get("artifact") or workflow.review_artifact(round_)
        )
    except RuntimeUnavailable as exc:
        if exc.retryable:
            log.warning(
                "run %s: wait %s not read, again next tick: %s", run.id, wait["step_id"], exc
            )
            if answered_step:
                # W5: answered, not read yet: held until it is (read again next tick).
                _unread(
                    run,
                    cp,
                    segment,
                    wf,
                    wait,
                    f"SwarmCloud did not serve it ({service._shown(exc)})",
                )
            return
        log.warning("run %s: cannot read wait %s: %s", run.id, wait.get("step_id"), exc)
        record = RecordedAnswer(state="answered") if answered_step else RecordedAnswer()
    wait["checked_at"] = service._now().isoformat()
    service._set_wait(cp, wait)
    if record.answered:
        if record.verdict is None:
            # Never guessed: shown in the Inbox, and read again next time.
            _unreadable(run, cp, segment, wf, wait, record)
            return
        await _take_answer(db, run, cp, segment, segments, wf, wait, record)
        return
    if answered_step:
        # The record lags the step: answered, not read yet (W5), held; read again.
        _unread(run, cp, segment, wf, wait, "SwarmCloud's record does not show the answer yet")
        return
    if status.terminal:
        await _wait_ended(db, run, wf, status, segments)


async def _take_answer(
    db: AsyncSession,
    run: Run,
    cp: Checkpoint,
    segment: RunSegment,
    segments: list[RunSegment],
    wf: dict[str, Any],
    wait: dict[str, Any],
    record: RecordedAnswer,
) -> None:
    """A wait answered without the Inbox, noticed by the tick. SwarmCloud's first answer
    is final and the workflow goes on with it; what Oracle does follows W5:

    - Oracle's own answer (a post whose response was lost), or a console answer whose
      answerer (``answered_by``, never the unverified ``on_behalf_of``) is an Oracle member
      with the checkpoint's approver role: the checkpoint's decision, followed;
    - any other console answer: recorded, and the checkpoint stays open in the Inbox for
      an approver to confirm it or request changes;
    - a counted NOT_YET where the workflow has no revision step (an earlier checkpoint:
      it went on into the next segment regardless): never re-run on its own; the
      checkpoint stays open with the findings for an approver's Redo or Continue."""
    round_ = int(wait.get("round") or 1)
    ours = record.answer_id == str(cp.id) and record.by_oracle
    # Oracle's own post of a decision voided while it was delivered (its decider lost
    # standing, :func:`_void_owed`): it landed, but it is never the decision on its own.
    voided = ours and isinstance(wait.get("voided"), dict)
    at = record.answered_at.isoformat() if record.answered_at else service._now().isoformat()
    findings = list(record.findings)
    applied = "; ".join(findings) or None
    by = record.answered_by
    wait["recorded"] = _recorded(record, by, at, record.via, ours)
    entry = service._plan_entry(wf, segment.seq) or {}
    approved = record.verdict == MERGE
    revise = round_ <= len(entry.get("revises") or [])
    if voided:
        ours = False
        member, reason = (
            None,
            "Oracle posted it for a decision that was voided because its decider lost standing",
        )
    else:
        member, reason = (
            (None, None)
            if ours
            else await _console_member(
                db, cp, by, flow=run.flow, altered=record.answered_by_altered
            )
        )
    counted = ours or reason is None
    if counted and approved and not ours and cp.kind == "feature_set":
        # The gate below reads the scope as stored, re-checked now (C6).
        await service._recheck_scope(db, cp)
    if counted and approved and not ours and cp.kind == "priority_order":
        # And the goals the order's new features serve, as of now (C8).
        await service._recheck_order_goals(db, cp)
    if counted and approved and not ours:
        # D3 "Console gate": held while a blocking reason is not fixed or waived.
        shut = await approve_gate_of(db, cp)
        if shut is not None and not shut.open:
            await service._hold_console_approval(
                db, run, cp, segment, record, wait, at, revise, member
            )
            return
        if cp.kind in apply_edits.FILES and (
            unapplied := apply_edits.edit_count((await _staged_actions(db, [cp])).get(cp.id, []))
        ):
            service._note(segment, service._unapplied_note(unapplied))
    if not counted or (not approved and not revise):
        console = _console_record(run, segment, record, at, revise)
        console.update(
            counted=counted,
            reason=reason,
            needs="redo_or_continue" if counted else "confirm",
            role=member.role if member is not None else None,
            member_id=str(member.id) if member is not None else None,
        )
        wait["console"] = console
        service._set_wait(cp, wait)
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
                "answered_by": by,
                "verdict": record.verdict,
                "counted": counted,
            },
        )
        if not counted:
            label = f" (labelled for {record.on_behalf_of})" if record.on_behalf_of else ""
            service._note(
                segment,
                f"{cp.kind} (round {round_}) was answered in SwarmCloud by {by or 'someone'}"
                f"{label}: {_said(record, at)}. It does not count ({reason}), so the "
                "checkpoint stays open in the Inbox for an approver to confirm it or request "
                "changes.",
            )
        else:
            service._note(
                segment,
                f"{_outside_note(cp, round_, record, at)} The workflow has no revision step "
                "there and went on regardless; "
                f"nothing is re-run on its own. In the Inbox an approver chooses Redo from "
                f"'{console['redo_segment']}' (a new workflow: one more segment"
                f"{_about(console['redo_cost_usd'])}) or Continue.",
            )
        return
    wait.pop("console", None)
    wait["answered"] = {
        "verdict": record.verdict,
        "at": at,
        "replayed": False,
        "answer_id": record.answer_id,
        "answered_by": by,
        "on_behalf_of": record.on_behalf_of,
        "via": record.via,
        "seen_by": "tick",
    }
    cp.status = "approved" if approved else "changes_requested"
    cp.decided_at = record.answered_at or service._now()
    await stop_answers.record(db, run, cp)
    cp.note = applied
    if not ours:
        _record_decider(
            cp,
            member.role if member is not None else None,
            "swarmcloud_console",
            member.id if member is not None else None,
        )
    if member is not None:
        cp.decided_by = member.id
    elif ours and record.on_behalf_of:
        # Oracle's own post: the label is the one Oracle sent, for its Inbox user.
        cp.decided_by = await db.scalar(select(User.id).where(User.email == record.on_behalf_of))
    service._set_wait(cp, wait)
    if approved and cp.kind == eng_check.KIND and run.flow != SPEC_FLOW:
        # walk-eng-check: a counted console approval records the lead's verdicts, answers
        # and sizes as Oracle's Approve does (decide_checkpoint), so the later stages read
        # the answers.
        decider = member or (await db.get(User, cp.decided_by) if cp.decided_by else None)
        if decider is not None and decider.disabled_at is None:
            staged = await db.scalars(
                select(CheckpointAction).where(
                    CheckpointAction.checkpoint_id == cp.id, CheckpointAction.state == "staged"
                )
            )
            principal = service._creator(current_tenant(db), decider, None)
            await eng_check.on_approved(db, principal, run, cp, list(staged))
    if approved and cp.kind == eng_dates.KIND:
        # F4 lane B: a counted console approval records the dates as Oracle's Approve does
        # (decide_checkpoint), for the member who answered (or Oracle's own Inbox user).
        decider = member or (await db.get(User, cp.decided_by) if cp.decided_by else None)
        if decider is not None and decider.disabled_at is None:
            staged = await db.scalars(
                select(CheckpointAction)
                .where(CheckpointAction.checkpoint_id == cp.id, CheckpointAction.state == "staged")
                .order_by(CheckpointAction.created_at, CheckpointAction.id)
            )
            principal = service._creator(current_tenant(db), decider, None)
            await eng_dates.on_approved(db, principal, run, cp, list(staged))
    # H1: a counted answer from the console (or Oracle's own lost post) is the stop's
    # decision: a checkpoint record, unless one was recorded when it was decided here.
    await decisions_capture.checkpoint(
        db, None, run, cp, decided_via="oracle" if ours else "swarmcloud_console"
    )
    await service._scope_decided(db, None, run, cp)
    await audit.record(
        db,
        None,
        f"checkpoint.{cp.status}",
        "checkpoint",
        cp.id,
        {"run_id": str(run.id), "kind": cp.kind, "answered_in": "swarmcloud", "answered_by": by},
    )
    if ours:
        what = (
            f"{cp.kind} (round {round_}): SwarmCloud recorded Oracle's own answer "
            f"{record.verdict}{f' for {record.on_behalf_of}' if record.on_behalf_of else ''}, "
            "whose response was lost; Oracle follows it."
        )
    else:
        what = (
            _outside_note(cp, round_, record, at)
            + f" {by} is an Oracle {member.role if member else 'member'}, so it counts: "
            "Oracle follows that answer."
        )
    service._note(segment, what)
    await service._follow(
        db,
        run,
        cp,
        segment,
        segments,
        wf,
        entry,
        round_,
        approved,
        note=applied or "",
        note_by=by if applied else None,
        strict=False,
    )


async def _console_member(
    db: AsyncSession,
    cp: Checkpoint,
    answered_by: str | None,
    *,
    flow: str = "",
    altered: bool = False,
) -> tuple[User | None, str | None]:
    """The Oracle member who answered in SwarmCloud, and why their answer does not count
    (None when it does): matched by ``answered_by`` only, never one that redaction
    altered. Emails match case-insensitively; an exact match wins, and two members that
    differ only by case with neither exact is no match (the same answer every time). An
    engineering stop with a lead named counts only a lead's or an owner's (A3); ``flow``
    is the run's (prd_to_spec keeps its own rule)."""
    if not answered_by:
        return None, "SwarmCloud recorded no answerer"
    if altered:
        return None, "SwarmCloud's answerer could not be read as recorded"
    users = list(
        await db.scalars(
            select(User)
            .where(func.lower(User.email) == answered_by.lower())
            .order_by(User.email, User.id)
        )
    )
    exact = [u for u in users if u.email == answered_by]
    if exact:
        user = exact[0]
    elif len(users) == 1:
        user = users[0]
    elif users:
        return None, f"{answered_by} matches more than one Oracle member (by case)"
    else:
        return None, f"{answered_by} is not an Oracle member"
    leads = await engineering_leads(db)
    if lead_stop(cp.kind, flow, leads):
        if user.disabled_at is not None or not decides(user.role, user.id, cp, flow, leads):
            return user, f"{answered_by} is not an engineering lead"
        return user, None
    if not has_role(user.role, cp.approver_role):  # type: ignore[arg-type]
        return user, (
            f"{answered_by} is an Oracle {user.role}, below the checkpoint's "
            f"{cp.approver_role} role"
        )
    return user, None


def _console_record(
    run: Run, segment: RunSegment, record: RecordedAnswer, at: str | None, revise: bool
) -> dict[str, Any]:
    """What the console said, as the Inbox shows it, with what a Redo would cost."""
    return {
        "answer_id": record.answer_id,
        "answered_by": record.answered_by,
        "on_behalf_of": record.on_behalf_of,
        "answered_at": at,
        "via": record.via,
        "verdict": record.verdict,
        "findings": list(record.findings),
        "revise": revise,
        "redo_segment": _flow(run).segment(segment.name).title,
        "redo_cost_usd": _usd(segment.estimate_usd),
        "seen_at": service._now().isoformat(),
    }


def _unreadable(
    run: Run,
    cp: Checkpoint,
    segment: RunSegment,
    wf: dict[str, Any],
    wait: dict[str, Any],
    record: RecordedAnswer,
) -> None:
    """The wait was answered, and Oracle cannot read the verdict (the form artifact is
    missing, too large or odd, or the record was refused): shown in the Inbox, where an
    approver may approve (the workflow did what an approval needs, whatever was recorded)
    or Redo the segment as a new workflow. Read again each minute meanwhile."""
    round_ = int(wait.get("round") or 1)
    entry = service._plan_entry(wf, segment.seq) or {}
    at = record.answered_at.isoformat() if record.answered_at else None
    first = (wait.get("console") or {}).get("needs") != "unreadable"
    console = _console_record(run, segment, record, at, round_ <= len(entry.get("revises") or []))
    console.update(
        counted=None, reason="the recorded verdict could not be read", needs="unreadable"
    )
    wait["console"] = console
    service._set_wait(cp, wait)
    log.warning("run %s: wait %s answered, verdict not readable", run.id, wait.get("step_id"))
    if first:
        artifact = wait.get("artifact") or workflow.review_artifact(round_)
        service._note(
            segment,
            f"{cp.kind} (round {round_}) was answered in SwarmCloud"
            f"{f' by {record.answered_by}' if record.answered_by else ''}, but Oracle could not "
            f"read the recorded verdict ({artifact}); it reads it again each minute. In the "
            "Inbox an approver can approve (the workflow already did what an approval needs) "
            f"or choose Redo from '{console['redo_segment']}' as a new workflow.",
        )


def _unread_console(
    run: Run,
    segment: RunSegment,
    wf: dict[str, Any] | None,
    wait: dict[str, Any],
    why: str,
    *,
    by: str | None = None,
    at: str | None = None,
    via: str | None = None,
) -> dict[str, Any]:
    """What the Inbox shows of a wait answered in SwarmCloud that Oracle has not read
    yet (``needs: unread``)."""
    round_ = int(wait.get("round") or 1)
    entry = (service._plan_entry(wf, segment.seq) or {}) if wf is not None else {}
    earlier = wait.get("console") or {}
    console = _console_record(
        run, segment, RecordedAnswer(), None, round_ <= len(entry.get("revises") or [])
    )
    console.update(
        answered_by=by or earlier.get("answered_by"),
        answered_at=at or earlier.get("answered_at"),
        via=via or earlier.get("via"),
        counted=None,
        reason=f"Oracle has not read the recorded answer yet: {why}",
        needs="unread",
        seen_at=earlier.get("seen_at") or console["seen_at"],
    )
    return console


def _unread(
    run: Run,
    cp: Checkpoint,
    segment: RunSegment,
    wf: dict[str, Any],
    wait: dict[str, Any],
    why: str,
) -> None:
    """W5 (owner, 2026-10-19): the wait was answered (its step SUCCEEDED) and Oracle
    cannot read the answer yet (SwarmCloud errors, a 404, a lagging record): it counts as
    unconfirmed, so the run's token is read-only until the answer is read, and the Inbox
    shows the checkpoint waiting to read it. Read again on every tick; once read, the
    approver rule applies. An answer already shown (one that did not count, or could not
    be read) stays as it is."""
    needs = (wait.get("console") or {}).get("needs")
    if needs not in (None, "unread"):
        return
    wait["console"] = _unread_console(run, segment, wf, wait, why)
    service._set_wait(cp, wait)
    if needs is None:
        round_ = int(wait.get("round") or 1)
        service._note(
            segment,
            f"{cp.kind} (round {round_}) was answered in SwarmCloud, and Oracle cannot read "
            f"the answer yet ({service._clip(why)}). Until it does, the run's agents may read "
            "Oracle "
            "but not write to it; Oracle reads it again on every tick, then applies the "
            "approver rule.",
        )


def _recorded(
    record: RecordedAnswer, by: str | None, at: str | None, via: str | None, ours: bool
) -> dict[str, Any]:
    return {
        "answer_id": record.answer_id,
        "answered_by": by,
        "on_behalf_of": record.on_behalf_of,
        "answered_at": at,
        "via": via,
        "verdict": record.verdict,
        "findings": list(record.findings),
        "outside_oracle": not ours,
    }


def _said(record: RecordedAnswer, at: str | None) -> str:
    """What was answered in SwarmCloud, for a note: the verdict, findings, via and when."""
    findings = f" ({service._clip('; '.join(record.findings))})" if record.findings else ""
    return (
        f"{record.verdict or 'it'}{findings} in SwarmCloud"
        f"{f' via {record.via}' if record.via else ''}{f' at {at}' if at else ''}"
    )


def _outside_note(cp: Checkpoint, round_: int, record: RecordedAnswer, at: str | None) -> str:
    who = record.answered_by or "someone"
    if record.on_behalf_of:
        who += f" for {record.on_behalf_of}"
    return (
        f"{cp.kind} (round {round_}) was decided outside Oracle: {who} answered "
        f"{_said(record, at)}."
    )


async def _wait_ended(
    db: AsyncSession,
    run: Run,
    wf: dict[str, Any],
    status: WorkflowStatus,
    segments: list[RunSegment],
) -> None:
    """The workflow ended while a checkpoint waited in it, unanswered (W2b: the wait
    expired, or it ended otherwise; :func:`_watch_wait` read the wait first, and an
    answered one is followed, its finished steps harvested, instead). The checkpoint
    stays open in the Inbox; deciding it continues the run as a new workflow."""
    cp = await _waiting_on(db, run, wf)
    step = status.step(((cp.payload or {}).get("wait") or {}).get("step_id", "")) if cp else None
    expired = status.error_code == "expired" or (
        status.state == "failed" and step is not None and step.state != "SUCCEEDED"
    )
    if expired:
        note = workflow.ADVICE["expired"]
    else:
        note = (
            f"The workflow waiting on this run's checkpoint ended {status.state} in SwarmCloud"
            f"{f' ({status.error})' if status.error else ''}. The checkpoint stays open in the "
            "Inbox; deciding it continues the run as a new workflow."
        )
    if cp is not None:
        wait = dict((cp.payload or {}).get("wait") or {})
        wait["ended"] = "expired" if expired else status.state
        wait["ended_at"] = service._now().isoformat()
        service._set_wait(cp, wait)
        seq = (cp.payload or {}).get("segment_seq")
        target = next((s for s in segments if s.seq == seq), segments[0])
        service._note(target, note)
    await service._detach(db, run, cancel=False, state="expired" if expired else "ended")
