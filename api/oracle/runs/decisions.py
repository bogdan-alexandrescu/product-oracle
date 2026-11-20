"""Runs: a person's decision on a checkpoint, its staged edits, and decisions owed or voided."""

import copy
import hashlib
import uuid
from dataclasses import dataclass
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, company_time, safe_yaml, webhooks
from oracle.auth.deps import Principal
from oracle.auth.models import User
from oracle.authz import has_role
from oracle.decisions import capture as decisions_capture
from oracle.engineering import check as eng_check
from oracle.engineering import dates as eng_dates
from oracle.errors import exception_text
from oracle.members.leads import (
    ENGINEERING_KINDS,
    LEAD_ONLY,
    SPEC_FLOW,
    engineering_leads,
    lead_now,
    lead_refusal,
    lead_stop,
    may_decide,
)
from oracle.runs import (
    apply_edits,
    gate,
    reasons,
    review_link,
    service,
    stop_answers,
)
from oracle.runs.models import Checkpoint, CheckpointAction, Run, RunSegment
from oracle.runs.service import (
    DECIDED,
    FINAL,
    NOTHING_TO_SEND,
    Forbidden,
    Invalid,
    NotFound,
    RunError,
    Unavailable,
    _about,
    _art,
    _checkpoints,
    _flow,
    _open_questions,
    _record_decider,
    _segments,
    _set_art,
    _set_knob,
    _staged_actions,
    _TickStats,
    approve_gate_of,
    blocking_open,
    log,
)
from oracle.runtokens import revoke_run_tokens
from oracle.swarm import RuntimeUnavailable
from oracle.tenancy import current_tenant


async def decide_checkpoint(
    db: AsyncSession,
    principal: Principal,
    run_id: uuid.UUID,
    checkpoint_id: uuid.UUID,
    decision: str,
    note: str | None,
    expected_revision: int | None = None,
    audit_via: str | None = None,
) -> None:
    """``audit_via``: ``document_review`` when the version's review decided it (D10)."""
    from oracle.auth.service import caller_refusal
    from oracle.review import publish

    # Approving starts the next segment and spends money: the caller must hold the
    # checkpoint's role when the decision lands, read under the gate (a disable or a
    # demotion that commits first wins). A disable voids a decision whose segment has
    # not been submitted yet (oracle.members.service._void_checkpoint_decisions).
    await publish.gate_lock(db, shared=True)
    run = await service._get_run(db, run_id, lock=True)
    cp = await db.scalar(
        select(Checkpoint).where(Checkpoint.id == checkpoint_id, Checkpoint.run_id == run.id)
    )
    if cp is None:
        raise NotFound(f"checkpoint {checkpoint_id} not found")
    # A3: an engineering stop waits for the engineering leads and owners once a lead is
    # named (C2 Multiple reviewers); the flag is re-read here, under the run's lock.
    leads = await engineering_leads(db)
    by_lead = lead_stop(cp.kind, run.flow, leads)
    if not may_decide(principal, cp, run.flow, leads):
        raise Forbidden(LEAD_ONLY if by_lead else f"Requires the {cp.approver_role} role")
    refusal = (
        await lead_refusal(db, principal)
        if by_lead
        else await caller_refusal(db, principal, cp.approver_role)  # type: ignore[arg-type]
    )
    if refusal is not None:
        raise Forbidden(refusal)
    if (
        audit_via is None
        and cp.kind in review_link.KINDS
        and not review_link.is_decider(principal, await review_link.decider_of(db, cp))
    ):
        # D10: Approve draft and Send back are the designated decider's, as approve_version.
        raise Forbidden(review_link.DECIDER_ONLY)
    if cp.status in DECIDED:
        # A recorded decision is final (owner, 2026-10-20), delivered to the run or not
        # yet: the same decision again, or the other one, changes nothing. A different
        # verdict entered in SwarmCloud's console is still taken as a correction.
        raise RunError(
            f"already decided: this checkpoint is {cp.status.replace('_', ' ')}; a recorded "
            "decision is final"
        )
    if cp.status != "pending" or run.status != "awaiting_checkpoint":
        raise RunError(f"checkpoint is {cp.status}; run is {run.status}")
    if expected_revision is not None and expected_revision != (cp.draft_revision or 0):
        # D8: the shared draft changed since the decider loaded it (a console confirm
        # too): nothing is decided; they look again.
        from oracle.runs import actions

        raise await actions.review_changed(db, cp, expected_revision)
    # A run already waiting at the Engineering check is decided as the rules now are.
    await eng_check.refresh(db, run, await _segments(db, run.id), [cp])
    # The note defaults to the shared draft's (D8).
    note = (note if note is not None else cp.draft_note or "").strip() or None
    # D4: an Inbox send-back delivers a structured review of the shared draft (a console
    # Redo carries the console's findings instead).
    send_back = decision == "changes_requested"
    wait = (cp.payload or {}).get("wait") or {}
    redo = False
    # A choice about an answer SwarmCloud's console recorded is decided through it (H1).
    via = "swarmcloud_console" if decision in ("confirm", "redo", "continue") else "oracle"
    # Who decided, as the run's agents read it (list_decisions): the Inbox's decider, or
    # for a confirmed console answer its author, by role.
    decider: tuple[str | None, str, str | uuid.UUID | None] = (
        principal.role,
        "oracle",
        principal.id,
    )
    if decision in ("confirm", "redo", "continue"):
        if decision == "confirm":
            held = wait.get("console") or {}
            role, member_id = held.get("role"), held.get("member_id")
            if member_id is None and held.get("answered_by"):
                # Held before its author's id was kept: matched by email, as when it was
                # recorded.
                member, _ = await service._console_member(
                    db, cp, held["answered_by"], flow=run.flow
                )
                if member is not None:
                    role, member_id = role or member.role, member.id
            decider = (role, "swarmcloud_console", member_id)
        decision, note, redo = service._console_choice(cp, wait, decision, note)
        if decision == "confirm":
            # A console change request where the workflow has no revision step: now
            # counted, it waits for Redo or Continue.
            console = {
                **wait["console"],
                "counted": True,
                "needs": "redo_or_continue",
                "confirmed_by": str(principal.id),
                "confirmed_at": service._now().isoformat(),
            }
            cp.payload = {**(cp.payload or {}), "wait": {**wait, "console": console}}
            await audit.record(
                db,
                principal,
                "checkpoint.console_confirmed",
                "checkpoint",
                cp.id,
                {"run_id": str(run.id), "kind": cp.kind, "answered_by": console["answered_by"]},
            )
            await db.commit()
            return
    if decision == "approved" and cp.kind == "feature_set" and await service._recheck_scope(db, cp):
        # The scope as stored still has blocking problems: unless each is waived, the
        # refreshed check is kept for the run page and the Inbox, and nothing is decided.
        if (shut := await approve_gate_of(db, cp)) and not shut.open:
            await db.commit()
            raise blocking_open(shut)
    if (
        decision == "approved"
        and cp.kind == "priority_order"
        and (stale := await service._recheck_order_goals(db, cp))
    ):
        # A goal a new feature serves was rejected since the order was checked: the order
        # keeps the problem for the band and the Inbox, and nothing is decided.
        if (shut := await approve_gate_of(db, cp)) and not shut.open:
            await db.commit()
            error = blocking_open(shut)
            message = "; ".join(p["message"] for p in stale)
            error.args = (message,)
            error.detail["message"] = message  # type: ignore[attr-defined]
            raise error
    if decision == "approved" and (blocked := service._cannot_approve(cp)):
        # Approve, a confirmed console approval and Continue alike: nothing is decided.
        raise RunError(blocked)
    edited: _Edited | None = None
    if decision == "approved" and via == "oracle" and cp.kind in apply_edits.FILES:
        # D7: the staged edits are applied to the file and the result re-checked under the
        # same gate; a refusal raises before anything is written.
        edited = await _apply_staged_edits(db, principal, run, cp)
    if (
        decision == "approved"
        and edited is None
        and (shut := await approve_gate_of(db, cp))
        and not shut.open
    ):
        # D3: the same for a blocking reason not fixed or waived (one gate for every path).
        raise blocking_open(shut)
    # D7: a console approval never applies staged edits (its answerer did not see them).
    unapplied = (
        apply_edits.edit_count((await _staged_actions(db, [cp])).get(cp.id, []))
        if decision == "approved" and via == "swarmcloud_console"
        else 0
    )
    # D10: a PRD or roadmap review sends back D4's review of the document's own feedback,
    # the note optional (cp.note stays the person's).
    document_review = (
        await review_link.review_file(db, cp, note) if decision == "changes_requested" else None
    )
    # A refused draft goes back to its writer with the import's problems (Nov 3): no note
    # is needed for that (Send back to writer on the run page).
    refused_draft = bool(((cp.payload or {}).get("import") or {}).get("error"))
    if (
        decision == "changes_requested"
        and not note
        and document_review is None
        and not refused_draft
    ):
        if not send_back:
            raise Invalid("say what to change: a note is required to request changes")
        sent = select(func.count()).where(
            CheckpointAction.checkpoint_id == cp.id, CheckpointAction.state == "staged"
        )
        if cp.kind == "feature_set":
            # C7: an edit or an add is the scope's rows (counted below), never a staged
            # action the review file carries.
            sent = sent.where(CheckpointAction.kind.not_in(("edit", "add")))
        staged = await db.scalar(sent.select_from(CheckpointAction))
        if not staged and cp.kind == "feature_set":
            # C7: the rows a person changed are what is sent back.
            from oracle.runs import scope_review

            staged = await scope_review.edits_count(db, cp)
        if not staged:
            raise Invalid(NOTHING_TO_SEND)
    segments = await _segments(db, run.id)
    seq = (cp.payload or {}).get("segment_seq")
    segment = next((s for s in segments if s.seq == seq), None)
    # Only a segment in the state its checkpoint expects is started: the checkpoint's
    # segment succeeded, and the next one (approved) has not run.
    later = next(
        (s for s in segments if segment and s.seq > segment.seq and s.status != "skipped"), None
    )
    if segment is None or segment.status != "succeeded":
        raise RunError(f"the checkpoint's segment is {segment.status if segment else 'missing'}")
    if decision == "approved" and later is not None and later.status != "pending":
        raise RunError(f"the next segment is {later.status}, not waiting to start")
    cp.status = decision
    cp.decided_by = principal.id
    cp.decided_at = service._now()
    cp.note = note
    # The stop's answered cards, kept as it is decided: a send-back reruns the segment,
    # whose next files replace the questions.
    await stop_answers.record(db, run, cp)
    if document_review is not None:
        cp.review = document_review
    elif send_back:
        from oracle.runs import review_file

        cp.review = await review_file.sent_review(db, principal, run, cp, note)
    if edited is not None:
        _write_edits(run, cp, segment, edited)
    if unapplied:
        service._note(segment, _unapplied_note(unapplied))
    _record_decider(cp, *decider)
    data: dict[str, Any] = {"run_id": str(run.id), "kind": cp.kind}
    if edited is not None:
        data.update(edited.audit)
    if audit_via is not None:
        data["via"] = audit_via
    if cp.kind in ENGINEERING_KINDS and run.flow != SPEC_FLOW:
        # F4 Engineering review stop reads whether a lead was named when it was decided.
        data["engineering_lead_named"] = bool(leads)
    if via == "swarmcloud_console":
        data["via"] = via
    await audit.record(db, principal, f"checkpoint.{decision}", "checkpoint", cp.id, data)
    await webhooks.capture(
        db, "run.checkpoint_decided", principal, run_id=run.id, checkpoint_id=cp.id,
        outcome=decision,
    )  # fmt: skip
    # H1: the stop's decision is a checkpoint record, in this transaction.
    await decisions_capture.checkpoint(db, principal, run, cp, decided_via=via)
    await service._scope_decided(db, principal, run, cp)
    # G4: the discussion changes behind the shared draft's actions follow the decision.
    from oracle.staging import hooks as staging_hooks

    await staging_hooks.decided(db, cp, decision)
    if decision == "approved" and cp.kind == eng_check.KIND and run.flow != SPEC_FLOW:
        # F4: the lead's verdicts, answers and sizes, in this transaction.
        staged = await db.scalars(
            select(CheckpointAction).where(
                CheckpointAction.checkpoint_id == cp.id, CheckpointAction.state == "staged"
            )
        )
        await eng_check.on_approved(db, principal, run, cp, list(staged))
    if decision == "approved" and cp.kind == eng_dates.KIND:
        # F4 lane B: the lead's dates become verified bases, the draft's items re-checked.
        staged = await db.scalars(
            select(CheckpointAction)
            .where(CheckpointAction.checkpoint_id == cp.id, CheckpointAction.state == "staged")
            .order_by(CheckpointAction.created_at, CheckpointAction.id)
        )
        await eng_dates.on_approved(db, principal, run, cp, list(staged))
    if decision == "approved":
        # F5-1: an approved Engineering check registers its tech briefs when the run's
        # PRD exists (else the prd_draft import does), in this transaction.
        from oracle.engineering import store as brief_store

        await brief_store.on_checkpoint_approved(db, principal, run, cp, segment)
    wf = service._drivable(run)
    live = (
        (redo and wf is not None)
        or (wf is not None and wait.get("workflow_id") == wf["id"])
        or service._cancel_pending(run)
    )
    if redo:
        title = _flow(run).segment(segment.name).title
        service._note(
            segment,
            f"An approver chose Redo from '{title}' at {cp.kind}: Oracle cancels the run's "
            "workflow and runs the segment again as a new workflow with the findings (one more "
            f"segment{_about(segment.estimate_usd)}).",
        )
    if live:
        # SwarmCloud is called after this commits: the decision is recorded under the gate
        # (the caller was checked above), and its post, or the cancel it needs, is made
        # with the gate and the run's row lock released (:func:`_finish_decision`). A post
        # that does not finish leaves this marker for the tick to complete.
        service._set_wait(
            cp,
            {
                **wait,
                "posting": {
                    "redo": redo,
                    # Who decided, as they authenticated: re-read under the gate before
                    # each try (_finish_decision_now), so a decider who lost standing
                    # meanwhile never has the decision delivered.
                    "user_id": str(principal.user_id) if principal.user_id else None,
                    "token_id": str(principal.token_id) if principal.token_id else None,
                    "grant_id": str(principal.grant_id) if principal.grant_id else None,
                    "at": service._now().isoformat(),
                    "tries": 0,
                },
            },
        )
        await db.commit()
        checkpoint_id = cp.id
        await _complete_decision(db, run_id, checkpoint_id, None)
        voided = await _voided_while_delivered(db, checkpoint_id)
        if voided is not None:
            raise Forbidden(f"{voided}: the decision was voided before it reached the run")
        return
    await _continue_decided(db, run, cp, segment, segments, later, decision, note)
    if service._cancel_pending(run):
        # Nothing is submitted after a workflow SwarmCloud may still be running.
        raise service._unconfirmed("continue the run as a new workflow")
    await db.commit()  # the router submits it (submit_queued), outside the gate


def _unapplied_note(n: int) -> str:
    return (
        f"Approved in the runtime's console: {n} staged edit{' was' if n == 1 else 's were'} "
        "not applied"
    )


@dataclass
class _Edited:
    """Staged edits applied and re-checked (D7), not written yet."""

    name: str
    agents: str
    text: str
    attempt: int
    check: dict[str, Any]
    revision: dict[str, Any]
    review: dict[str, Any]
    audit: dict[str, Any]


def _edits_refused(code: str, message: str, **extra: Any) -> RunError:
    error = RunError(message)
    error.detail = {"code": code, "message": message, **extra}  # type: ignore[attr-defined]
    return error


async def _member_name(db: AsyncSession, principal: Principal) -> str:
    user = await db.get(User, principal.user_id) if principal.user_id else None
    if user is None:
        return "an API token"
    from oracle.members.names import display_name

    return display_name(user.email)


async def _apply_staged_edits(
    db: AsyncSession, principal: Principal, run: Run, cp: Checkpoint
) -> _Edited | None:
    """D7 Approve with edits: the staged actions of ``cp``'s draft applied to the agents'
    file (no model, nothing spent), re-checked (``check_items`` and the D2 reasons) and
    gated (D3) on that check. None when nothing staged changes the file (a plain
    approval). Raises 409 ``needs_agents`` or ``edits_leave_problems`` having written
    nothing: the edits stay staged."""
    staged = list(
        await db.scalars(
            select(CheckpointAction)
            .where(CheckpointAction.checkpoint_id == cp.id, CheckpointAction.state == "staged")
            .order_by(CheckpointAction.created_at, CheckpointAction.id)
        )
    )
    blocked = apply_edits.needs_agents(staged, await _open_questions(db, {cp.id: staged}))
    if blocked:
        raise _edits_refused(
            "needs_agents", apply_edits.refusal(blocked), actions=[str(a.id) for a in blocked]
        )
    n = apply_edits.edit_count(staged)
    if not n:
        return None
    name = apply_edits.FILES[cp.kind]
    segment = await db.scalar(
        select(RunSegment).where(
            RunSegment.run_id == run.id, RunSegment.seq == (cp.payload or {}).get("segment_seq")
        )
    )
    art = (segment.artifacts or {}) if segment is not None else {}
    agents = (art.get("files") or {}).get(name)
    if not isinstance(agents, str):
        raise RunError(f"the checkpoint's segment left no {name} to apply the edits to")
    _, base = await reasons._base(db, run)
    try:
        body, applied = apply_edits.apply(
            agents, staged, {k: v.get("raw") or {} for k, v in base.items()}
        )
    except apply_edits.EditError as exc:
        raise _edits_refused(
            "edit_cannot_apply",
            f"{exception_text(exc)}: remove that edit, or send back to the agents",
            actions=[str(exc.action_id)],
        ) from None  # fmt: skip
    except safe_yaml.SafeYamlError as exc:
        raise _edits_refused(
            "edit_cannot_apply",
            f"{name} cannot be edited ({exception_text(exc)}): send back to the agents",
        ) from None
    attempts = art.get("attempts") or []
    attempt = int(attempts[-1].get("attempt") or len(attempts)) if attempts else 1
    now = service._now()
    on = now.astimezone(apply_edits.COMPANY_ZONE).date()
    text = apply_edits.header(await _member_name(db, principal), on, n, attempt) + body
    check = await service._check_items(db, run, text)
    # The gate on the re-checked file, read from a copy: a refusal leaves the stored check.
    shut = gate.approve_gate(
        Checkpoint(kind=cp.kind, payload={**(cp.payload or {}), "items_check": check}),
        None,
        staged,
    )
    if shut is not None and not shut.open:
        left = gate.left_count(shut)
        what = "; ".join(f"{x.item}: {x.label}" for x in shut.left) or "a problem of the file"
        raise _edits_refused(
            "edits_leave_problems",
            f"After the edits, {left} blocking problem{' is' if left == 1 else 's are'} left: "
            f"{what}",
            left=[x.model_dump() for x in shut.left],
        )
    ids = [str(a.id) for a in staged]
    sha = hashlib.sha256(text.encode()).hexdigest()
    revision = {
        "attempt": attempt,
        "by": str(principal.user_id or principal.token_id),
        "at": now.isoformat(),
        "actions": ids,
        "agent_sha256": hashlib.sha256(agents.encode()).hexdigest(),
        "edited_sha256": sha,
    }
    review = {
        "kind": "edits",
        "file": name,
        "applied": applied,
        "edits": n,
        "summary": apply_edits.summary(applied),
    }
    audit_data = {"edits": n, "actions": ids, "edited_sha256": sha}
    return _Edited(name, agents, text, attempt, check, revision, review, audit_data)


def _write_edits(run: Run, cp: Checkpoint, segment: RunSegment, edited: _Edited) -> None:
    """The edited file as the segment's current one; the agents' text kept per attempt."""
    art = _art(segment)
    agent_files = copy.deepcopy(art.get("agent_files") or {})
    agent_files.setdefault(str(edited.attempt), {}).setdefault(edited.name, edited.agents)
    revisions = [*(art.get("revisions") or []), edited.revision]
    art["files"] = {**(art.get("files") or {}), edited.name: edited.text}
    art["agent_files"] = agent_files
    art["revisions"] = revisions
    art["items_check"] = edited.check
    _set_art(segment, art)
    cp.payload = {**(cp.payload or {}), "items_check": edited.check}
    cp.review = {**edited.review, "revision": len(revisions)}


async def _restore_agents_file(db: AsyncSession, run: Run, cp: Checkpoint) -> None:
    """A voided approval with edits (D7): the agents' file is the current one again,
    re-checked; the edits are staged as they were."""
    if not isinstance(cp.review, dict) or cp.review.get("kind") != "edits":
        return
    name = cp.review.get("file") or apply_edits.FILE
    segment = await db.scalar(
        select(RunSegment).where(
            RunSegment.run_id == run.id, RunSegment.seq == (cp.payload or {}).get("segment_seq")
        )
    )
    art = _art(segment) if segment is not None else {}
    revisions = art.get("revisions") or []
    attempt = str(revisions[-1].get("attempt")) if revisions else "1"
    agents = ((art.get("agent_files") or {}).get(attempt) or {}).get(name)
    if segment is None or not isinstance(agents, str):
        return
    check = await service._check_items(db, run, agents)
    art["files"] = {**(art.get("files") or {}), name: agents}
    art["items_check"] = check
    _set_art(segment, art)
    cp.payload = {**(cp.payload or {}), "items_check": check}


async def read_review_file(db: AsyncSession, run_id: uuid.UUID, checkpoint_id: uuid.UUID) -> str:
    """The ``review.yaml`` a send-back at the checkpoint delivered (D4)."""
    from oracle.runs import review_file

    run = await service._get_run(db, run_id)
    cp = await db.scalar(
        select(Checkpoint).where(Checkpoint.id == checkpoint_id, Checkpoint.run_id == run.id)
    )
    if cp is None:
        raise NotFound(f"checkpoint {checkpoint_id} not found")
    if cp.status == "pending" or not cp.review or cp.review.get("kind") == "edits":
        raise NotFound("no review was sent back at this checkpoint")
    zone = await company_time.company_time_zone(db)
    return review_file.render_yaml(cp.review, cp.decided_at, zone)


async def _continue_decided(
    db: AsyncSession,
    run: Run,
    cp: Checkpoint,
    segment: RunSegment,
    segments: list[RunSegment],
    later: RunSegment | None,
    decision: str,
    note: str | None,
) -> None:
    """The run goes on with a decided checkpoint as a new workflow (the caller commits;
    the next segment is queued, :func:`submit_queued` submits it): the next segment when
    approved, the checkpoint's segment again (with the note) when changes were requested,
    the end of the run when there is none."""
    run.status = "running"
    if decision == "approved":
        target = later
        restore = "pending"
    else:
        target, restore = segment, segment.status
        segment.status = "pending"
    if target is None:
        await service._finish(db, run, "succeeded")
        return
    # Until its workflow is submitted, the segment remembers the decision that started
    # it: a disable of the decider voids it.
    art = _art(target)
    if target is segment and art.pop("reused_items", None) is not None:
        # E1 part B: a send-back derives the reused items again; they are no longer reused.
        art.pop("note", None)
    art["decision"] = {
        "checkpoint_id": str(cp.id),
        "decided_by": str(cp.decided_by),
        "restore": restore,
    }
    _set_art(target, art)
    review = None
    if decision != "approved" and cp.review:
        from oracle.runs import review_file

        zone = await company_time.company_time_zone(db)
        review = review_file.change_request(cp.review, cp.decided_at, zone)
        # A refused draft's import problems go with it (the workflow's revise step gets
        # them as findings, _send_back_findings): the writer fixes what Oracle refused.
        if problems := await service._problem_findings(db, run, cp):
            review += "\n" + "\n".join(problems) + "\n"
    await service._submit(db, run, target, segments, change_request=note, review=review)


def _owes(cp: Checkpoint) -> bool:
    """A decision recorded on ``cp`` whose post to SwarmCloud (or the cancel it needs) is
    not finished (:func:`_finish_decision`)."""
    return cp.status in DECIDED and isinstance(
        ((cp.payload or {}).get("wait") or {}).get("posting"), dict
    )


async def _owed_decision(db: AsyncSession, run_id: uuid.UUID) -> uuid.UUID | None:
    """The run's checkpoint whose recorded decision is owed (:func:`_owes`), read without
    a lock."""
    owed = next((c.id for c in await _checkpoints(db, [run_id]) if _owes(c)), None)
    await db.rollback()
    return owed


async def _complete_decision(
    db: AsyncSession,
    run_id: uuid.UUID,
    checkpoint_id: uuid.UUID,
    deadline: float | None,
    stats: _TickStats | None = None,
) -> None:
    """Finish a recorded decision: the request that recorded it does so right after its
    commit; the tick does for one that never finished (a crash, a failed post). The calls
    to SwarmCloud are made outside the review gate and the run's row lock
    (:func:`_replay`). Commits; raises Unavailable when it did not finish (the marker
    stays with the failed try counted, the tick tries again), a runtime failure outside
    the post itself (the replay limit, say) included. ``stats``: the tick's, for what the
    cancel it may need counts (its errors, a pause on the ceiling); a request logs those."""
    mine = stats or _TickStats()
    try:
        await service._replay(
            db,
            deadline,
            lambda: _finish_decision(db, run_id, checkpoint_id, mine),
            reset=service._resetter(mine),
        )
    except (service._PostNotFound, service._Unread):
        raise  # the decision was undone: a person decides again (_finish_decision)
    except (Unavailable, RuntimeUnavailable) as exc:
        await _failed_try(db, run_id, checkpoint_id, exc)
        if isinstance(exc, RuntimeUnavailable):
            raise Unavailable(
                f"SwarmCloud did not confirm the decision ({service._shown(exc)}); the decision is "
                "recorded and Oracle delivers it on its next tick, there is no need to decide "
                "again",
                cause=exc,
            ) from None
        raise
    finally:
        if stats is None:
            for error in mine.errors:
                log.warning("decision on run %s: %s", run_id, error)


async def _failed_try(
    db: AsyncSession,
    run_id: uuid.UUID,
    checkpoint_id: uuid.UUID,
    exc: Unavailable | RuntimeUnavailable,
) -> None:
    """A try at delivering a recorded decision that did not finish, nothing of it written:
    what is left is the marker, with the try counted and why (shown on the run page and
    in the Inbox), and the cancel marker the failed pass left (``exc.held``). Commits."""
    await db.rollback()
    run = await service._get_run(db, run_id, lock=True)
    cp = await db.scalar(
        select(Checkpoint).where(Checkpoint.id == checkpoint_id, Checkpoint.run_id == run.id)
    )
    wait = dict(((cp.payload or {}).get("wait") or {}) if cp is not None else {})
    posting = wait.get("posting")
    held = exc.held if isinstance(exc, Unavailable) else None
    now_wf = service._live(run)
    if held is not None and now_wf is not None and now_wf.get("id") == held["id"]:
        # The cancel's marker (its tries, a 404 count), as the failed pass left it.
        _set_knob(run, "workflow", {**now_wf, "cancel_pending": held["cancel_pending"]})
        await revoke_run_tokens(db, run.id)
    if cp is not None and cp.status in DECIDED and isinstance(posting, dict):
        first = not posting.get("error")
        why = service._cause(exc)
        wait["posting"] = {
            **posting,
            "tries": int(posting.get("tries") or 0) + 1,
            "error": why,
            "tried_at": service._now().isoformat(),
        }
        service._set_wait(cp, wait)
        if first:
            segments = await _segments(db, run.id)
            seq = (cp.payload or {}).get("segment_seq")
            target = next((x for x in segments if x.seq == seq), None) or segments[0]
            service._note(
                target,
                f"The decision at {cp.kind} is recorded; SwarmCloud did not take it yet "
                f"({why}). Oracle tries again on every tick.",
            )
    await db.commit()


async def _finish_decision(
    db: AsyncSession, run_id: uuid.UUID, checkpoint_id: uuid.UUID, stats: _TickStats
) -> None:
    """The follow-through of a decision recorded by :func:`decide_checkpoint`, on the run
    as it is now (locked, read afresh): post it to the wait in the live workflow (the same
    answer id and body every time, so a post made twice is one answer), or cancel the
    workflow and go on as a new one. Done, the marker is dropped, in the same commit as
    its effect. A try that does not finish is counted by :func:`_complete_decision`."""
    try:
        await _finish_decision_now(db, run_id, checkpoint_id, stats)
    except service._PostNotFound as exc:
        await service._count_post_404(
            db, run_id, checkpoint_id, exc.cause
        )  # decided again by a person
        raise
    except service._Unread as exc:
        await service._hold_unread(db, run_id, checkpoint_id, exc)  # decided again by a person
        raise


async def _finish_decision_now(
    db: AsyncSession, run_id: uuid.UUID, checkpoint_id: uuid.UUID, stats: _TickStats
) -> None:
    from oracle.review import publish

    # Under the review gate, every pass (each try, and each replay after a runtime call):
    # the decider is read again, so a decision whose decider lost standing since it was
    # recorded is never delivered (a disable and a demotion also void it as they commit,
    # void_owed_decisions). The gate is released with every runtime call (_replay).
    await publish.gate_lock(db, shared=True)
    run = await service._get_run(db, run_id, lock=True)
    cp = await db.scalar(
        select(Checkpoint).where(Checkpoint.id == checkpoint_id, Checkpoint.run_id == run.id)
    )
    wait = dict(((cp.payload or {}).get("wait") or {}) if cp is not None else {})
    posting = wait.get("posting")
    if cp is None or not isinstance(posting, dict):
        await db.rollback()
        return
    if cp.status not in DECIDED or run.status not in ("awaiting_checkpoint", "paused_overrun"):
        # Voided, or the run ended meanwhile (cancelled, failed): nothing is owed.
        wait.pop("posting")
        service._set_wait(cp, wait)
        await db.commit()
        return
    if run.status == "paused_overrun":
        # Paused on overrun (its workflow cancelled): the decision stays owed, and is
        # delivered once an owner resumes the run (resume: awaiting_checkpoint again).
        await db.rollback()
        return
    role = cp.approver_role
    lead = _posting_id(posting, "user_id")
    if cp.kind in ENGINEERING_KINDS and run.flow != SPEC_FLOW and lead is not None:
        # A3: an engineering lead decided it (any commenter or above may carry the flag);
        # an unflagged lead's owed decision was voided with the flag (set_engineering_lead).
        if await lead_now(db, lead):
            role = "commenter"
    refusal = await _decider_refusal(db, posting, role)
    if refusal is not None:
        await _void_owed(db, None, run, cp, refusal, {"via": "decision.recheck"})
        await db.commit()
        return
    try:
        await _deliver_decision(db, run, cp, wait, posting, stats)
    except Unavailable as exc:
        held = service._live(run)
        if held is not None and held.get("cancel_pending"):
            # A cancel SwarmCloud did not confirm: its marker outlives the rollback, so
            # its tries are counted and a cancel stuck on 404s reaches the Inbox.
            exc.held = {"id": held.get("id"), "cancel_pending": held["cancel_pending"]}
        raise


async def _deliver_decision(
    db: AsyncSession,
    run: Run,
    cp: Checkpoint,
    wait: dict[str, Any],
    posting: dict[str, Any],
    stats: _TickStats,
) -> None:
    segments = await _segments(db, run.id)
    seq = (cp.payload or {}).get("segment_seq")
    segment = next((x for x in segments if x.seq == seq), None)
    if segment is None:
        await db.rollback()
        raise RunError("the checkpoint's segment is missing")
    later = next((x for x in segments if x.seq > segment.seq), None)
    decision, note, redo = cp.status, cp.note, bool(posting.get("redo"))
    user_id = uuid.UUID(posting["user_id"]) if posting.get("user_id") else None
    held = service._live(run)
    if held is not None and held.get("cancel_pending"):
        # A cancel not confirmed yet (an earlier try, or the one the run was cancelled
        # with): made again; nothing is submitted after a workflow that may still run.
        if not await service._retry_pending_cancel(db, run, held, segments, stats):
            await db.commit()  # the cancel's tries and cost, counted
            raise service._unconfirmed("go on with the decision")
    wf = service._drivable(run)
    if redo:
        if wf is not None and not await service._detach(db, run, cancel=True, state="redo"):
            raise service._unconfirmed("redo the segment")
    elif wf is not None and wait.get("workflow_id") == wf["id"]:
        posted = await service._decide_in_workflow(db, run, cp, segment, segments, wf, user_id)
        if posted:
            if service._cancel_pending(run):
                raise service._unconfirmed("go on with the decision")
            _finished_posting(cp)
            await db.commit()
            return
    await _continue_decided(db, run, cp, segment, segments, later, decision, note)
    if service._cancel_pending(run):
        # Nothing is submitted after a workflow SwarmCloud may still be running.
        raise service._unconfirmed("continue the run as a new workflow")
    _finished_posting(cp)
    await db.commit()  # the router submits it (submit_queued), outside the gate


def _finished_posting(cp: Checkpoint) -> None:
    wait = dict((cp.payload or {}).get("wait") or {})
    wait.pop("posting", None)
    wait.pop("voided", None)
    service._set_wait(cp, wait)


def _posting_id(posting: dict[str, Any], key: str) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(posting[key])) if posting.get(key) else None
    except ValueError:
        return None


async def _decider_refusal(db: AsyncSession, posting: dict[str, Any], role: str) -> str | None:
    """Why the decider of an owed decision may no longer decide a checkpoint of ``role``,
    read now (the caller holds the gate), or None: their API token or grant still active,
    the person behind it still an active member with the role. A decision that names no
    decider is never delivered."""
    from oracle.auth.service import caller_refusal

    user_id = _posting_id(posting, "user_id")
    token_id = _posting_id(posting, "token_id")
    if user_id is None and token_id is None:
        return "The decision names no decider"
    decider = Principal(
        tenant_id=current_tenant(db),
        kind="user" if user_id is not None else "token",
        role=role,  # type: ignore[arg-type]
        user_id=user_id,
        token_id=token_id,
        grant_id=_posting_id(posting, "grant_id"),
    )
    return await caller_refusal(db, decider, role)  # type: ignore[arg-type]


async def _void_owed(
    db: AsyncSession,
    principal: Principal | None,
    run: Run,
    cp: Checkpoint,
    why: str,
    via: dict[str, str],
) -> None:
    """Undo a decision recorded and not delivered yet (both locked by the caller, who
    commits): the checkpoint waits for a decision again, nothing of the decision is
    posted or submitted. ``voided`` stays on the wait: should the post have landed in
    SwarmCloud while its decider lost standing, the tick never follows that answer on its
    own (an approver confirms it in the Inbox, :func:`_take_answer`)."""
    wait = dict((cp.payload or {}).get("wait") or {})
    wait.pop("posting", None)
    wait["voided"] = {
        "decided_by": str(cp.decided_by),
        "why": why,
        "at": service._now().isoformat(),
    }
    service._set_wait(cp, wait)
    decided_by, kind = cp.decided_by, cp.status
    await _restore_agents_file(db, run, cp)
    cp.status = "pending"
    cp.decided_by = None
    cp.decided_at = None
    cp.note = None
    cp.review = None
    # H1: a decision voided before it reached the run is not in the decision log.
    await decisions_capture.checkpoint_voided(db, cp.id)
    await service._scope_reopened(db, cp)
    segments = await _segments(db, run.id)
    target = next((s for s in segments if s.seq == (cp.payload or {}).get("segment_seq")), None)
    if target is not None:
        service._note(
            target,
            f"The decision at {cp.kind} was voided before it reached the run ({why}): "
            "the checkpoint waits for an approver's decision again.",
        )
    await audit.record(
        db, principal, "checkpoint.decision_voided", "checkpoint", cp.id,
        {"run_id": str(run.id), "decision": kind, "decided_by": str(decided_by),
         "reason": why, **via},
    )  # fmt: skip
    await webhooks.capture(
        db, "run.checkpoint_voided", principal, run_id=run.id, checkpoint_id=cp.id
    )


async def void_owed_decisions(
    db: AsyncSession,
    principal: Principal | None,
    deciders: set[uuid.UUID],
    why: str,
    via: dict[str, str],
    *,
    role: str | None = None,
    kinds: tuple[str, ...] | None = None,
) -> list[uuid.UUID]:
    """Void the decisions ``deciders`` recorded that are not delivered to their run yet
    (``wait.posting``): a disable (every one), or a demotion to ``role`` (those whose
    checkpoint needs more than ``role``). With ``kinds`` (an engineering lead unflagged,
    A3), only those kinds outside prd_to_spec. The caller holds the gate exclusively and
    commits; a delivery under way re-reads the checkpoint under the gate and finds nothing
    owed (:func:`_finish_decision_now`). Returns the checkpoints voided."""
    if not deciders:
        return []
    candidates = list(await db.execute(_owed_q(deciders)))
    voided: list[uuid.UUID] = []
    for checkpoint_id, run_id in candidates:
        fresh = {"populate_existing": True}
        run = await db.scalar(
            select(Run).where(Run.id == run_id).with_for_update().execution_options(**fresh)
        )
        cp = await db.scalar(
            select(Checkpoint)
            .where(Checkpoint.id == checkpoint_id)
            .with_for_update()
            .execution_options(**fresh)
        )
        if not _owed_voids(run, cp, deciders, role, kinds):
            continue
        await _void_owed(db, principal, run, cp, why, via)
        voided.append(cp.id)
    return voided


def _owed_q(deciders: set[uuid.UUID]):
    return (
        select(Checkpoint.id, Checkpoint.run_id)
        .where(
            Checkpoint.status.in_(DECIDED),
            Checkpoint.payload["wait"].has_key("posting"),
            Checkpoint.decided_by.in_(deciders),
        )
        .order_by(Checkpoint.run_id, Checkpoint.id)
    )


def _owed_voids(
    run: Run | None,
    cp: Checkpoint | None,
    deciders: set[uuid.UUID],
    role: str | None,
    kinds: tuple[str, ...] | None,
) -> bool:
    """Whether :func:`void_owed_decisions` voids ``cp`` (read under its locks there,
    without them in :func:`select_owed_decisions`)."""
    if run is None or cp is None or cp.status not in DECIDED or run.status in FINAL:
        return False  # an ended run drops what it owed (_finish_decision_now)
    if not isinstance(((cp.payload or {}).get("wait") or {}).get("posting"), dict):
        return False
    if cp.decided_by not in deciders:
        return False
    if kinds is not None and (cp.kind not in kinds or run.flow == SPEC_FLOW):
        return False
    # The new role still decides this checkpoint: kept.
    return not (role is not None and has_role(role, cp.approver_role))  # type: ignore[arg-type]


async def select_owed_decisions(
    db: AsyncSession,
    deciders: set[uuid.UUID],
    *,
    role: str | None = None,
    kinds: tuple[str, ...] | None = None,
) -> list[tuple[Run, Checkpoint]]:
    """The (run, checkpoint) :func:`void_owed_decisions` would void: no locks, no writes
    (A5's preview)."""
    if not deciders:
        return []
    out = []
    for checkpoint_id, run_id in list(await db.execute(_owed_q(deciders))):
        run = await db.get(Run, run_id)
        cp = await db.get(Checkpoint, checkpoint_id)
        if _owed_voids(run, cp, deciders, role, kinds):
            out.append((run, cp))
    return out


async def _voided_while_delivered(db: AsyncSession, checkpoint_id: uuid.UUID) -> str | None:
    """Why the decision just recorded on ``checkpoint_id`` was voided while Oracle
    delivered it (its decider lost standing), or None."""
    cp = await db.scalar(
        select(Checkpoint)
        .where(Checkpoint.id == checkpoint_id)
        .execution_options(populate_existing=True)
    )
    voided = (((cp.payload or {}).get("wait") or {}).get("voided")) if cp is not None else None
    why = (
        str(voided.get("why") or "its decider lost standing")
        if cp is not None and cp.status == "pending" and isinstance(voided, dict)
        else None
    )
    await db.rollback()
    return why


async def void_decision(
    db: AsyncSession,
    principal: Principal | None,
    run: Run,
    segment: RunSegment,
    cp: Checkpoint,
    via: dict[str, str],
) -> None:
    """Undo a checkpoint decision whose segment has not been submitted (both locked by
    the caller, who commits): the checkpoint waits again, the segment is as before the
    decision, the run's tokens die. A submission under way finds it so and cancels its
    workflow (:func:`submit_queued`)."""
    decision = (segment.artifacts or {}).get("decision") or {}
    service.unqueue(segment)
    art = _art(segment)
    art.pop("pending_note", None)
    art.pop("pending_review", None)
    _set_art(segment, art)
    segment.status = decision.get("restore") or "pending"
    decided_by, kind = cp.decided_by, cp.status
    await _restore_agents_file(db, run, cp)
    cp.status = "pending"
    cp.decided_by = None
    cp.decided_at = None
    cp.note = None
    cp.review = None
    # H1: a decision voided before it reached the run is not in the decision log.
    await decisions_capture.checkpoint_voided(db, cp.id)
    await service._scope_reopened(db, cp)
    run.status = "awaiting_checkpoint"
    await revoke_run_tokens(db, run.id)
    await audit.record(
        db, principal, "checkpoint.decision_voided", "checkpoint", cp.id,
        {"run_id": str(run.id), "decision": kind, "decided_by": str(decided_by), **via},
    )  # fmt: skip
    for event_type in ("run.checkpoint_voided", "run.checkpoint_waiting"):
        await webhooks.capture(db, event_type, principal, run_id=run.id, checkpoint_id=cp.id)
