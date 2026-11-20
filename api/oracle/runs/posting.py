"""Runs: a decision posted to the run's SwarmCloud workflow as the answer to its wait, and
what Oracle does when SwarmCloud did not take it."""

import uuid
from dataclasses import replace
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.auth.models import User
from oracle.decisions import capture as decisions_capture
from oracle.errors import exception_text
from oracle.runs import flows, service, workflow
from oracle.runs.models import Checkpoint, Run, RunSegment
from oracle.runs.service import (
    DECIDED,
    ITEMS_FILE,
    Invalid,
    Unavailable,
    _art,
    _console_findings,
    _flow,
    _next,
    _rt,
    _segments,
    _set_art,
    _set_knob,
    _target_kind,
)
from oracle.swarm import RecordedAnswer, RuntimeUnavailable
from oracle.swarm.runtime import MERGE, NOT_YET
from oracle.swarm.settings import get_runtime_settings


class _PostNotFound(Unavailable):
    """An answer post SwarmCloud answered with a 404 that proves nothing (not its
    not_found envelope): nothing recorded, "decide again", and counted."""

    def __init__(self, cause: RuntimeUnavailable) -> None:
        super().__init__(
            f"SwarmCloud did not confirm the decision ({cause}); decide again, it is safe to repeat"
        )
        self.cause = cause


class _Unread(Unavailable):
    """The wait was answered (409 already_answered, or the answer the Inbox showed) and
    Oracle cannot read the recorded answer: "decide again", nothing recorded, and the
    run's token is held read-only until it is read (W5; :func:`_hold_unread`)."""

    def __init__(
        self,
        message: str,
        *,
        needs: str,
        by: str | None = None,
        at: str | None = None,
        via: str | None = None,
    ) -> None:
        super().__init__(message)
        self.needs, self.by, self.at, self.via = needs, by, at, via


async def _undecide(db: AsyncSession, run: Run, cp: Checkpoint) -> bool:
    """A decision recorded for posting (:func:`decide_checkpoint`) that needs a person
    again (the wait was answered and the answer cannot be read, or SwarmCloud answered a
    404 that proves nothing): the checkpoint waits again, as if not decided. False when
    it holds no such decision."""
    wait = dict((cp.payload or {}).get("wait") or {})
    if cp.status not in DECIDED or not isinstance(wait.get("posting"), dict):
        return False
    wait.pop("posting")
    service._set_wait(cp, wait)
    decided_by, kind = cp.decided_by, cp.status
    await service._restore_agents_file(db, run, cp)
    cp.status = "pending"
    cp.decided_by = None
    cp.decided_at = None
    cp.note = None
    cp.review = None
    # H1: a decision voided before it reached the run is not in the decision log.
    await decisions_capture.checkpoint_voided(db, cp.id)
    await service._scope_reopened(db, cp)
    await audit.record(
        db, None, "checkpoint.decision_not_posted", "checkpoint", cp.id,
        {"run_id": str(run.id), "decision": kind, "decided_by": str(decided_by)},
    )  # fmt: skip
    return True


async def _hold_unread(
    db: AsyncSession, run_id: uuid.UUID, checkpoint_id: uuid.UUID, exc: _Unread
) -> None:
    """W5 (owner, 2026-10-19): an answered checkpoint Oracle cannot read yet counts as
    unconfirmed. The decision itself rolls back; the hold is written on its own (the
    checkpoint shows in the Inbox waiting to read the answer, the tick reads it again),
    unless the checkpoint already shows what the console recorded."""
    await db.rollback()
    run = await service._get_run(db, run_id, lock=True)
    cp = await db.scalar(
        select(Checkpoint).where(Checkpoint.id == checkpoint_id, Checkpoint.run_id == run.id)
    )
    # The decision was recorded before it was posted: not posted, an approver decides again.
    undone = cp is not None and await _undecide(db, run, cp)
    wait = dict(((cp.payload or {}).get("wait") or {}) if cp is not None else {})
    if cp is None or cp.status != "pending" or not wait:
        await db.commit() if undone else await db.rollback()
        return
    if ((wait.get("console") or {}).get("needs")) not in (None, "unread"):
        await db.commit() if undone else await db.rollback()
        return
    segments = await _segments(db, run.id)
    segment = next((s for s in segments if s.seq == (cp.payload or {}).get("segment_seq")), None)
    if segment is None:
        await db.commit() if undone else await db.rollback()
        return
    why = "SwarmCloud did not serve it" if exc.needs == "unread" else "its verdict is unreadable"
    console = service._unread_console(
        run, segment, service._live(run), wait, why, by=exc.by, at=exc.at, via=exc.via
    )
    if exc.needs == "unreadable":
        console.update(reason="the recorded verdict could not be read", needs="unreadable")
    wait["console"] = console
    service._set_wait(cp, wait)
    service._note(
        segment,
        f"{cp.kind} was already answered in SwarmCloud, and Oracle could not read the answer "
        f"({why}). Until it does, the run's agents may read Oracle but not write to it; "
        "Oracle reads it again on every tick, and an approver may decide again.",
    )
    await db.commit()


async def _count_post_404(
    db: AsyncSession, run_id: uuid.UUID, checkpoint_id: uuid.UUID, cause: RuntimeUnavailable
) -> None:
    """Count a 404 on an answer post (the decision itself rolled back): past
    :data:`NOT_FOUND_TRIES` for the checkpoint, the run shows in the Inbox with Cancel."""
    await db.rollback()
    run = await service._get_run(db, run_id, lock=True)
    cp = await db.scalar(
        select(Checkpoint).where(Checkpoint.id == checkpoint_id, Checkpoint.run_id == run.id)
    )
    if cp is not None:
        await _undecide(db, run, cp)  # recorded before it was posted, not posted: decide again
    post = (run.knobs or {}).get("post_404") or {}
    same = post.get("checkpoint_id") == str(checkpoint_id)
    tries = (int(post.get("tries") or 0) if same else 0) + 1
    _set_knob(
        run,
        "post_404",
        {
            "checkpoint_id": str(checkpoint_id),
            "tries": tries,
            "error": service._shown(cause),
            "at": service._now().isoformat(),
        },
    )
    await db.commit()
    if tries >= service.NOT_FOUND_TRIES:
        raise Unavailable(
            f"SwarmCloud did not confirm the decision: it answered HTTP 404 {tries} times "
            f"without saying the wait does not exist ({service._shown(cause)}). Decide again "
            "later, "
            "or in the Inbox, Cancel ends the run."
        ) from None


def _console_choice(
    cp: Checkpoint, wait: dict[str, Any], choice: str, note: str | None
) -> tuple[str, str | None, bool]:
    """An Inbox choice about what SwarmCloud's console recorded (W5), as a decision:
    (decision, note, redo). ``confirm`` takes an answer that did not count as the decision
    (a change request where the workflow has no revision step comes back as ``confirm``:
    it then waits for Redo or Continue); ``redo`` re-runs the segment as a new workflow
    with the findings; ``continue`` follows the workflow, which went on regardless."""
    console = wait.get("console") or {}
    needs = console.get("needs")
    findings = "; ".join(_console_findings(console))
    with_note = "\n\n".join(x for x in (findings, note) if x) or None
    if choice == "confirm":
        if needs != "confirm" or console.get("verdict") not in (MERGE, NOT_YET):
            raise Invalid("nothing recorded in SwarmCloud's console waits to be confirmed here")
        if console["verdict"] == MERGE:
            return "approved", note, False
        if console.get("revise"):
            return "changes_requested", with_note, False
        return "confirm", None, False
    if needs not in ("redo_or_continue", "unreadable", "unread"):
        raise Invalid(
            f"{choice} answers a change request recorded in SwarmCloud's console that the "
            "workflow has no revision step for (or one Oracle could not read); there is none "
            "here"
        )
    if choice == "redo":
        if not with_note:
            raise Invalid("say what to change: a note is required to redo the segment")
        return "changes_requested", with_note, True
    return "approved", note, False


def _left(wf: dict[str, Any]) -> float:
    """Seconds left of the live workflow's run credential."""
    try:
        expires = datetime.fromisoformat(wf["expires_at"])
    except (KeyError, TypeError, ValueError):
        return 0.0
    return (expires - service._now()).total_seconds()


def _duration(seconds: float) -> str:
    seconds = max(0, int(seconds))
    hours, rest = divmod(seconds, 3600)
    return f"{hours} h {rest // 60} min" if hours else f"{rest // 60} min {rest % 60} s"


async def _email(db: AsyncSession, user_id: uuid.UUID | None) -> str | None:
    """The deciding user's email, recorded by SwarmCloud as ``on_behalf_of``."""
    if user_id is None:
        return None
    user = await db.get(User, user_id)
    return user.email if user is not None else None


async def _decide_in_workflow(
    db: AsyncSession,
    run: Run,
    cp: Checkpoint,
    segment: RunSegment,
    segments: list[RunSegment],
    wf: dict[str, Any],
    user_id: uuid.UUID | None,
) -> bool:
    """Post an Inbox decision (recorded already, :func:`decide_checkpoint`) to the wait in
    the live workflow, by the user who decided it (``user_id``). Returns False when the
    run continues as a new workflow instead (the caller does that, carrying the decision):
    the workflow has no step for the decision, too little of the credential is left for
    the agent steps after the wait (the tail rule), the wait is closed, SwarmCloud refuses
    the answer, or it holds a different verdict (Oracle's decision is then a correction).
    In every such case the live workflow is cancelled first, so a segment never runs in
    two workflows. Raises Unavailable only when nothing was recorded and the same decision
    may simply be sent again."""
    settings = get_runtime_settings()
    wait = dict((cp.payload or {}).get("wait") or {})
    entry = service._plan_entry(wf, segment.seq) or {}
    round_ = int(wait.get("round") or 1)
    approved = cp.status == "approved"
    answered = bool(wait.get("console")) and (approved or round_ <= len(entry.get("revises") or []))
    if answered:
        # Answered in SwarmCloud already (the Inbox shows it): nothing to post, and the
        # steps after the wait already have the credential they had; the recorded
        # answer is followed, or corrected.
        verdict = MERGE if approved else NOT_YET
        return await _already_answered(db, run, cp, segment, segments, wf, wait, verdict, None)
    if not approved and round_ > len(entry.get("revises") or []):
        # The workflow's next steps assume approval: re-run the segment on its own.
        service._note(
            segment,
            f"Changes requested at {cp.kind} (round {round_}): the workflow had no revision "
            "step for it, so Oracle cancelled it and re-runs the segment as a new workflow.",
        )
        if not await service._detach(db, run, cancel=True, state="cancelled"):
            raise service._unconfirmed("re-run the segment")
        return False
    left = _left(wf)
    steps = workflow.agent_steps_after(wf.get("segments") or [], segment.seq, approved, round_)
    tail = workflow.tail_seconds(steps, settings)
    if left < tail:
        service._note(
            segment,
            f"Decided at {cp.kind} with {_duration(left)} of the run's credential left, under "
            f"the {_duration(tail)} tail that the {steps} agent step(s) after the wait need: "
            "Oracle did not post the decision to SwarmCloud, cancelled the waiting workflow "
            "and continued as a new workflow with a fresh run token.",
        )
        if not await service._detach(db, run, cancel=True, state="tail"):
            raise service._unconfirmed("continue the run as a new workflow")
        return False
    edits = cp.review if isinstance(cp.review, dict) and cp.review.get("kind") == "edits" else None
    payload: dict[str, Any] = (
        {"verdict": MERGE, "findings": [edits["summary"]] if edits else []}
        if approved
        else {
            "verdict": NOT_YET,
            "findings": await _send_back_findings(db, run, cp),
        }
    )
    on_behalf_of = await _email(db, user_id)
    runtime = _rt()
    try:
        answer = await runtime.answer(
            wf["id"],
            wait["step_id"],
            answer_id=str(cp.id),
            payload=payload,
            on_behalf_of=on_behalf_of,
        )
    except RuntimeUnavailable as exc:
        if exc.code == "already_answered":
            return await _already_answered(
                db, run, cp, segment, segments, wf, wait, payload["verdict"], exc
            )
        if service._not_found(exc):
            # Proves nothing, and is counted (decide_checkpoint): past NOT_FOUND_TRIES the
            # run shows in the Inbox with Cancel.
            raise _PostNotFound(exc) from None
        if exc.retryable:
            # Nothing was recorded: the same decision is safe to send again (same
            # answer_id, same body).
            raise Unavailable(
                f"SwarmCloud did not confirm the decision ({exception_text(exc)}); "
                "the decision is recorded and Oracle posts it again on its next tick, "
                "there is no need to decide again",
                cause=exc,
            ) from None
        # Refused (the wait is closed, a person is required, or another refusal): not
        # posted, so the run continues as a new workflow with the decision.
        fallback = (
            f"SwarmCloud refused Oracle's answer to {cp.kind} ({exception_text(exc)}), "
            "so the decision was not posted: Oracle cancelled the workflow and continued "
            "the run as a new workflow "
            "from the Inbox decision."
        )
        service._note(segment, workflow.advice(exc.code, fallback))
        if not await service._detach(
            db, run, cancel=True, state=service._shown(exc.code) or "refused"
        ):
            raise service._unconfirmed("continue the run as a new workflow") from None
        return False
    _set_knob(run, "post_404", None)
    wait["answered"] = {
        "verdict": payload["verdict"],
        "at": service._now().isoformat(),
        "replayed": answer.replayed,
        "answer_id": str(cp.id),
        "on_behalf_of": on_behalf_of,
        "via": "mcp",
    }
    service._set_wait(cp, wait)
    if not await _follow(
        db, run, cp, segment, segments, wf, entry, round_, approved, note_by=on_behalf_of
    ):
        raise service._unconfirmed("end the run")
    return True


async def _send_back_findings(db: AsyncSession, run: Run, cp: Checkpoint) -> list[str]:
    """What a send-back posts to the revise step: the structured review (D4), one line per
    entry, with Oracle's check; the note and the check for a decision stored without one."""
    problems = await _problem_findings(db, run, cp)
    if cp.review:
        from oracle.runs import review_file

        return review_file.findings(cp.review, problems)
    return ([cp.note] if cp.note else []) + problems


async def _problem_findings(db: AsyncSession, run: Run, cp: Checkpoint) -> list[str]:
    """What Oracle's check found in the files a review shows (D5): the items check's
    blocking problems and a refused draft's import problems, after the person's note."""
    payload = cp.payload or {}
    imported = payload.get("import") or {}
    return workflow.check_findings(
        ITEMS_FILE, payload.get("items_check"), []
    ) + workflow.check_findings(
        flows.draft_file(await _target_kind(db, run)),
        None,
        list(imported.get("problems") or []),
        list(imported.get("code_names") or []),
    )


async def _already_answered(
    db: AsyncSession,
    run: Run,
    cp: Checkpoint,
    segment: RunSegment,
    segments: list[RunSegment],
    wf: dict[str, Any],
    wait: dict[str, Any],
    verdict: str,
    exc: RuntimeUnavailable | None,
) -> bool:
    """409 already_answered: Oracle's post was not recorded, but the wait was answered
    (someone in SwarmCloud's console, or an earlier, different post of Oracle's whose
    response was lost), and the workflow already goes on with that first answer.

    Oracle follows the workflow whenever it ran what the Inbox decision needs: the same
    verdict, or an approval over a recorded NOT_YET (at a checkpoint that is not the
    last, the next segment depends on the wait whatever its verdict, so the workflow went
    on into it; at the last, the approval ends the run on the draft it showed and stops
    the workflow's revision). Only a change request over a recorded MERGE needs work the
    workflow did not do: that is a correction, so the workflow is cancelled and the run
    continues as a new workflow carrying it. A verdict Oracle cannot read is never taken
    for either: it says "decide again", unless the decision is an approval, which needs
    nothing the workflow did not do whatever was recorded (or the approver chooses Redo).

    ``exc``: the 409 (None when the Inbox already showed the recorded answer)."""
    round_ = int(wait.get("round") or 1)
    artifact = wait.get("artifact") or workflow.review_artifact(round_)
    record = await _read_recorded(cp, wf, wait, artifact)
    detail = exc.detail if exc is not None else {}
    console = wait.get("console") or {}
    by = (
        record.answered_by
        or service._shown(detail.get("answered_by"))
        or console.get("answered_by")
    )
    at = (
        record.answered_at.isoformat()
        if record.answered_at
        else service._shown(detail.get("answered_at")) or console.get("answered_at")
    )
    via = record.via or service._shown(detail.get("via")) or console.get("via")
    ours = record.answer_id == str(cp.id) and record.by_oracle
    approved = verdict == MERGE
    if record.verdict is None and not approved:
        title = _flow(run).segment(segment.name).title
        raise _Unread(
            f"SwarmCloud says {cp.kind} was already answered, but Oracle could not read the "
            f"recorded verdict ({artifact}); decide again, it is safe to repeat, or choose "
            f"Redo from '{title}' to run it again as a new workflow",
            needs="unreadable" if record.answered else "unread",
            by=by,
            at=at,
            via=via,
        )
    wait.pop("console", None)
    wait["recorded"] = service._recorded(record, by, at, via, ours)
    if not ours:
        service._note(
            segment, service._outside_note(cp, round_, replace(record, answered_by=by, via=via), at)
        )
    if record.verdict is None:
        service._note(
            segment,
            f"Oracle could not read the verdict SwarmCloud recorded for {cp.kind} (round "
            f"{round_}); the Inbox approved, which needs no work the workflow did not do "
            "whatever was recorded, so the run follows the workflow.",
        )
    if record.verdict == verdict or approved:
        # What SwarmCloud recorded is what the revision (if any) applies; the Inbox
        # note, when it differs, is kept apart as not applied. No recorded findings
        # means none were applied, never the Inbox note.
        applied = "; ".join(record.findings) or None
        not_applied = cp.note if not approved and cp.note and cp.note != applied else None
        if record.verdict is None:
            pass
        elif record.verdict == verdict:
            service._note(
                segment,
                f"SwarmCloud already held a {verdict} answer for {cp.kind} (round {round_}), "
                "the same verdict as the Inbox decision, so the run follows the workflow on "
                "it. SwarmCloud kept the earlier wording: its findings, notes and on_behalf_of "
                "stand, not this decision's.",
            )
        else:
            last = bool(wf.get("segments")) and wf["segments"][-1].get("seq") == segment.seq
            how = (
                "the run ends on the draft the checkpoint showed, and Oracle stops the "
                "workflow's revision"
                if last
                else "the next segment depends on this wait whatever its verdict, so the "
                "workflow went on into it, as the approval needs, and Oracle follows it"
            )
            service._note(
                segment,
                f"SwarmCloud's console recorded NOT_YET for {cp.kind} (round {round_})"
                f" ({by or 'someone'}{f' via {via}' if via else ''}"
                f"{': ' + service._clip(applied) if applied else ''}), but the Inbox approved. The "
                f"approval needs no work the workflow did not do: {how}.",
            )
        wait["answered"] = {
            "verdict": record.verdict,
            "decision": verdict,
            "at": at or service._now().isoformat(),
            "replayed": False,
            "answer_id": record.answer_id,
            "answered_by": by,
            "on_behalf_of": record.on_behalf_of,
            "via": via,
            "kept_earlier": True,
            "not_applied": not_applied,
        }
        service._set_wait(cp, wait)
        entry = service._plan_entry(wf, segment.seq) or {}
        if not await _follow(
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
            not_applied=not_applied,
            stop_rest=record.verdict != verdict,
        ):
            raise service._unconfirmed("end the run")
        return True
    service._note(
        segment,
        f"SwarmCloud held {record.verdict} for {cp.kind} (round {round_}), but the latest "
        f"Inbox decision is {verdict}, which needs a revision the workflow did not run: Oracle "
        "takes its decision as a correction, cancelled the workflow (which had gone on with "
        "the recorded answer) and continued as a new workflow carrying the decision.",
    )
    service._set_wait(cp, wait)
    if not await service._detach(db, run, cancel=True, state="corrected"):
        raise service._unconfirmed("continue the run as a new workflow")
    return False


async def _read_recorded(
    cp: Checkpoint, wf: dict[str, Any], wait: dict[str, Any], artifact: str
) -> RecordedAnswer:
    """The answer the wait holds, read twice at most for its verdict; still unreadable,
    it comes back without one (never taken for a correction: the caller says "decide
    again", or follows an approval)."""
    record = RecordedAnswer()
    for _ in range(2):
        try:
            record = await _rt().answer_record(wf["id"], wait["step_id"], artifact)
        except RuntimeUnavailable as read:
            if read.retryable:
                # Answered, not read yet (W5): held until it is (decide_checkpoint).
                raise _Unread(
                    f"SwarmCloud says {cp.kind} was already answered but did not show the "
                    f"answer ({read}); decide again, it is safe to repeat",
                    needs="unread",
                ) from None
            record = RecordedAnswer()
        if record.verdict is not None:
            return record
    return record


async def _follow(
    db: AsyncSession,
    run: Run,
    cp: Checkpoint | None,
    segment: RunSegment,
    segments: list[RunSegment],
    wf: dict[str, Any],
    entry: dict[str, Any],
    round_: int,
    approved: bool,
    *,
    note: str | None = None,
    note_by: str | None = None,
    not_applied: str | None = None,
    stop_rest: bool = False,
    strict: bool = True,
) -> bool:
    """The wait is answered with the run's verdict: keep following the workflow.

    ``note``/``note_by``: the findings the revision applies and whose they are; None for
    the Inbox note (Oracle's own answer was posted), "" for none (SwarmCloud recorded no
    findings: the Inbox note is not what was applied). ``cp`` None: no checkpoint stands
    for the wait (Oracle sent a refused draft back, :func:`_send_back`). ``stop_rest``:
    after an approval at the last checkpoint, the workflow's rest is work nobody uses (a
    recorded NOT_YET's revision). Returns False, when ``strict`` (the Inbox decision
    path), if stopping the rest was not confirmed: the caller says "decide again".
    Otherwise the run goes on and the tick cancels the workflow again."""
    run.status = "running"
    last = wf["segments"][-1].get("seq") == segment.seq if wf.get("segments") else True
    if approved:
        if last:
            # What follows a MERGE in the last round's shape is pass-through: stop it.
            more = round_ < len(entry.get("reviews") or []) or stop_rest
            if not await service._detach(db, run, cancel=more, state="ended") and strict:
                return False
        await _next(db, run, segment, segments)
        return True
    # NOT_YET: the revision step runs in the workflow, then the next round's wait.
    entry["round"] = round_ + 1
    _set_knob(
        run,
        "workflow",
        {
            **wf,
            "segments": [entry if e.get("seq") == segment.seq else e for e in wf["segments"]],
        },
    )
    art = _art(segment)
    art["attempts"].append(
        {
            "attempt": len(art["attempts"]) + 1,
            "workflow_id": wf["id"],
            "submitted_at": service._now().isoformat(),
            "cost_usd": None,
            "note": (cp.note if cp is not None else None) if note is None else (note or None),
            "note_by": note_by,
            "not_applied": not_applied,
            "state": "running",
            "label": wf.get("label"),
            "mode": "workflow",
        }
    )
    _set_art(segment, art)
    segment.status = "running"
    segment.finished_at = None
    return True


def _attach_for_cancel(
    run: Run,
    segment: RunSegment,
    workflow_id: str | None,
    lookup: str | None = None,
    lookup_since: str | None = None,
    lookup_until: str | None = None,
) -> dict[str, Any]:
    """A workflow Oracle does not drive as the run's (one per segment, or a lost
    submission), attached so that cancelling the run cancels it the same way: retried by
    the tick, its cost counted, given up on SwarmCloud's 404. ``lookup``: the label to
    find it by while its id is unknown, and ``lookup_since`` when it was submitted (the
    search ends at an older task, and moves to the background past the lookup cap, until
    ``lookup_until``, its credential's end)."""
    last = (_art(segment)["attempts"] or [{}])[-1]
    wf = {
        "id": workflow_id,
        "label": lookup or last.get("label"),
        # When it was sent: a search for it is bounded from then (_credential_end).
        "submitted_at": lookup_since or (last.get("submitted_at") if workflow_id else None),
        "lookup": lookup,
        "lookup_since": lookup_since,
        "lookup_until": lookup_until,
        "state": "live",
        "start_seq": segment.seq,
        "mode": "segment",
        "segments": [],
    }
    _set_knob(run, "workflow", wf)
    return wf
