"""Runs: a run's workflow read on each tick, and submissions given up on, looked for until
found and cancelled, or ruled out."""

import copy
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.engineering import dates as eng_dates
from oracle.priorities import run_order
from oracle.runs import feature_set, flows, service, waits, workflow
from oracle.runs.models import Run, RunSegment
from oracle.runs.service import (
    COST_UNKNOWN_SECONDS,
    FINAL,
    ITEMS_FILE,
    NOT_FOUND_TRIES,
    SEARCH_SECONDS,
    STUCK_LOOKUP_SECONDS,
    _advance,
    _art,
    _attempts_cost,
    _cancel_call,
    _Cancelled,
    _current_attempt,
    _detach,
    _drivable,
    _finish,
    _flow,
    _known_sum,
    _live,
    _not_found,
    _note,
    _note_art,
    _parse_at,
    _plan_entry,
    _recompute_spend,
    _record_workflow_wait,
    _rt,
    _set_art,
    _set_knob,
    _shown,
    _spent,
    _submit,
    _target_kind,
    _TickStats,
    log,
)
from oracle.swarm import RuntimeUnavailable, WorkflowStatus
from oracle.swarm.settings import get_runtime_settings


def _credential_end(info: dict[str, Any]) -> str | None:
    """When a submission's run credential ends, if it was sent one (attached): its agents
    lose Oracle's data then. A submission sent without it is not bounded by the run
    token's lifetime: None (the default bound applies, :data:`SEARCH_SECONDS`)."""
    if info.get("credential_seconds"):
        return info.get("expires_at")
    return info.get("lookup_until")


def _search_end(entry: dict[str, Any]) -> datetime:
    """Past this, a search gives up while SwarmCloud neither shows the submission nor
    rules it out, or does not serve its status: the credential's end (else
    :data:`SEARCH_SECONDS` after it was sent) plus a step's timeout of slack, for a step
    already running then. A workflow whose status reads is followed until it ends."""
    sent = _parse_at(entry.get("submitted_at")) or service._now()
    end = _parse_at(entry.get("until")) or sent + timedelta(seconds=SEARCH_SECONDS)
    return end + timedelta(seconds=get_runtime_settings().step_seconds)


def _cost_cap(entry: dict[str, Any]) -> datetime:
    """A searched workflow whose cost is unknown (its status does not read) is read again
    now and then until this, shown in the Inbox with it: :func:`_search_end` plus
    :data:`COST_UNKNOWN_SECONDS`."""
    return _search_end(entry) + timedelta(seconds=COST_UNKNOWN_SECONDS)


def _search_for(
    run: Run,
    *,
    label: str,
    seq: int | None,
    submitted_at: str | None,
    until: str | None,
    why: str,
    workflow_id: str | None = None,
    cancel: bool = True,  # noqa: F811
    cancelled: bool = False,
    costed: bool = False,
) -> None:
    """Keep checking work the run gave up on: the run's ``searches``. A submission whose
    answer was lost (Retry submitted the segment again, or a cancelled run stopped looking
    for it on every tick) is looked for by its label; a workflow known by its id (found,
    or one an approver stopped cancelling: ``cancel`` False; ``cancelled``: its cancel was
    confirmed and only its status and cost are left to read) has its status and cost read
    until it ends. The first look is on the next tick. One entry per submission (its id,
    or its label and when it was sent, compared as times; a label-only look that does
    not say when merges into the label's): a second call merges into it."""
    entries = copy.deepcopy(list((run.knobs or {}).get("searches") or []))
    if not label:
        return
    at = _parse_at(submitted_at)
    for e in entries:
        same_id = bool(workflow_id) and e.get("id") == workflow_id
        same_sent = (
            e.get("label") == label
            and at is not None
            and _parse_at(e.get("submitted_at")) == at
            and (not workflow_id or not e.get("id") or e.get("id") == workflow_id)
        )
        # Two looks for the same label, neither known by its id: when this one does not
        # say when it was sent, it is the one already looked for.
        same_label = not workflow_id and not e.get("id") and e.get("label") == label and at is None
        if same_id or same_sent or same_label:
            if workflow_id and not e.get("id"):
                e["id"] = workflow_id
            if not cancel:
                e["cancel"] = False
            if cancelled:
                e["cancelled"] = True
            if costed:
                e["costed"] = True
            _set_knob(run, "searches", entries)
            return
    sent = at or service._now()
    end = _parse_at(until) or sent + timedelta(seconds=SEARCH_SECONDS)
    entry: dict[str, Any] = {
        "label": label,
        "seq": seq,
        "submitted_at": sent.isoformat(),
        "until": end.isoformat(),
        "why": why,
        "looked_at": None,
        "lookups": 0,
    }
    if workflow_id:
        entry["id"] = workflow_id
    if not cancel:
        entry["cancel"] = False
    if cancelled:
        entry["cancelled"] = True
    if costed:
        entry["costed"] = True
    entries.append(entry)
    _set_knob(run, "searches", entries)


def _searching(run: Run) -> str | None:
    """What the Inbox says while Oracle checks work the run gave up on."""
    entries = (run.knobs or {}).get("searches") or []
    if not entries:
        return None
    every = service._duration(STUCK_LOOKUP_SECONDS)
    says: list[str] = []
    lost = [str(e.get("label")) for e in entries if not e.get("id")]
    if lost:
        says.append(
            f"Oracle is looking for an earlier submission ({', '.join(lost)}) every {every}: "
            "if it landed, Oracle cancels it and counts its cost in the run's spend; it stops "
            "once it is ruled out, or when its credential would have expired."
        )
    for e in entries:
        if not e.get("id"):
            continue
        if e.get("cancel") is False:
            says.append(
                f"Oracle stopped cancelling workflow {e['id']} ({e.get('label')}), and reads "
                "its status and cost on every tick until it ends, counting its spend on the "
                "run."
            )
        else:
            # Plain words: the earlier workflow may well have succeeded; only its unused
            # steps are stopped, never a failure.
            says.append(
                "Oracle is stopping the unused steps of an earlier workflow of this run, and "
                "counts what it spent on the run until it ends."
            )
    return " ".join(says)


def _cost_on(run: Run, segments: list[RunSegment], entry: dict[str, Any], cost: Decimal) -> None:
    """A searched workflow's cost on its segment's first attempt with its id (a revision
    inside a workflow counts nothing again), never lower than one already recorded.

    #258: what other segments started in the workflow carry (their own agents' spend,
    :func:`_take_cost`) is not counted again: the segment carries the rest."""
    segment = next((s for s in segments if s.seq == entry.get("seq")), None)
    if segment is None:
        return
    others = _known_sum(
        a.get("cost_usd")
        for s in segments
        if s is not segment
        for a in _art(s)["attempts"]
        if a.get("workflow_id") == entry["id"]
    ) or Decimal(0)
    art = _art(segment)
    first = True
    for a in art["attempts"]:
        if a.get("workflow_id") == entry["id"]:
            if first:
                total = _higher(cost, a.get("workflow_cost_usd", a.get("cost_usd")))
                a["workflow_cost_usd"] = total
                a["cost_usd"] = None if total is None else max(total - float(others), 0)
            else:
                a["cost_usd"] = 0
            first = False
    segment.cost_usd = _attempts_cost(art)
    _set_art(segment, art)
    _recompute_spend(run, segments)


def _higher(cost: Decimal | None, recorded: Any) -> float | None:
    """A cost read now, never lower than the one recorded: SwarmCloud's costs only grow,
    so a lower reading is an older one (read before a newer one was recorded). #1572:
    None while neither is known (a zero read with nothing recorded is not a report)."""
    if recorded is None and not cost:
        return None
    return max(float(cost or 0), float(recorded or 0))


def _rests(at: Any) -> bool:
    looked = _parse_at(at)
    return looked is not None and (service._now() - looked).total_seconds() < STUCK_LOOKUP_SECONDS


async def _read_call(workflow_id: str) -> _Cancelled:
    """Read a workflow Oracle no longer cancels (stopped, or its cancel confirmed): its
    cost and whether it ended. A call only, nothing written."""
    out = _Cancelled()
    try:
        out.final = await _rt().status(workflow_id)
    except RuntimeUnavailable as exc:
        if exc.gone:
            out.gone = True
        else:
            out.unread = exc
    return out


async def _search_earlier(
    db: AsyncSession, run: Run, segments: list[RunSegment], stats: _TickStats
) -> None:
    """Check the work the run gave up on (``searches``), each every
    :data:`STUCK_LOOKUP_SECONDS` (the first on the next tick). A submission looked for by
    its label: found, it is cancelled and its cost counted in the run's spend (as
    :func:`_adopt` does); ruled out by the listing, it is dropped; neither, past
    :func:`_search_end`, dropped (noted). A workflow known by its id (:func:`_read_found`)
    is cancelled (unless an approver stopped cancelling it) and its status and cost read
    until it ends. Whatever the run's state: a landed one spends otherwise."""
    entries = copy.deepcopy((run.knobs or {}).get("searches") or [])
    if not entries:
        return
    runtime = _rt()
    target = segments[0] if segments else None
    keep: list[dict[str, Any]] = []
    dropped: list[dict[str, Any]] = []
    for e in entries:
        label = str(e.get("label") or "")
        segment = next((s for s in segments if s.seq == e.get("seq")), target)
        if not e.get("id"):
            if _rests(e.get("looked_at")):
                keep.append(e)
                continue
            e["looked_at"] = service._now().isoformat()
            try:
                found = await runtime.find_by_label(label, since=_parse_at(e.get("submitted_at")))
            except RuntimeUnavailable as exc:
                e["lookups"] = int(e.get("lookups") or 0) + 1
                e["error"] = _shown(exc)
                if service._now() >= _search_end(e):
                    if segment is not None:
                        _note(
                            segment,
                            f"Oracle stopped looking for submission {label}: its credential "
                            "would have expired, and SwarmCloud's task listing never showed "
                            f"it nor ruled it out ({_shown(exc)}). If it landed, cancel it in "
                            "SwarmCloud's console; its cost is not counted here.",
                        )
                    continue
                keep.append(e)
                continue
            if not found:
                log.info("run %s: submission %s ruled out", run.id, label)
                continue
            e["id"] = found
            if segment is not None:
                service._add_attempt(segment, found, label, "cancelled", mode="abandoned")
        elif e.get("unread") and _rests(e.get("read_at")):
            # Its last read failed: read again now and then. One that reads is read on
            # every tick until it ends, so the ceiling is never overshot by a rest.
            keep.append(e)
            continue
        e["read_at"] = service._now().isoformat()
        if await _read_found(run, segments, segment, e):
            keep.append(e)
        elif e.get("dropped"):
            dropped.append(e)
    _set_knob(run, "searches", keep or None)
    await _after_search(db, run, target, stats, dropped)


async def _after_search(
    db: AsyncSession,
    run: Run,
    target: RunSegment | None,
    stats: _TickStats,
    dropped: list[dict[str, Any]],
) -> None:
    """After a look at the run's searches: workflows dropped at their cap are audited,
    and the spend is held to the ceiling (a run still spending pauses; one that ended
    records the overrun, whether or not anything is left to read)."""
    for e in dropped:
        await audit.record(
            db,
            None,
            "run.search_dropped",
            "run",
            run.id,
            {
                "workflow_id": e.get("id"),
                "label": e.get("label"),
                "reason": e.get("dropped"),
                "cost_unknown_since": e.get("cost_unknown"),
                "cancelling_since": e.get("winding_since"),
            },
        )
    if (ceiling := service._overrun(run)) is not None:
        if run.status in service._SPENDING:
            await service._pause_overrun(db, run, ceiling, stats)
        elif run.status in FINAL and _new_overrun_after_end(run, ceiling):
            await _overrun_after_end(db, run, ceiling, target)


def _new_overrun_after_end(run: Run, ceiling: Decimal) -> bool:
    """Whether an ended run's spend over its ceiling is an overrun after its end to
    record: spend that arrived after the end (past the spend it ended with, when that was
    over the ceiling already: an earlier overrun keeps its own kind and wording), and
    past the last one recorded. One recorded and not dismissed is shown already; a
    dismissed one does not block a new one once the spend grows past it."""
    knobs = run.knobs or {}
    at_end = knobs.get("spent_at_end")
    if at_end is not None and _spent(run) <= Decimal(str(at_end)):
        return False
    over = knobs.get("overrun_after_end")
    if not isinstance(over, dict):
        return True
    return bool(over.get("dismissed_at")) and _spent(run) > Decimal(str(over.get("spent_usd") or 0))


def _usd_text(value: Any) -> str:
    return "\u2014" if value is None else f"${Decimal(str(value)):.2f}"


async def _overrun_after_end(
    db: AsyncSession, run: Run, ceiling: Decimal, segment: RunSegment | None
) -> None:
    """The ceiling trips on a run that ended (P3d: a workflow it no longer cancels, or
    one read for its last cost, counts on the run): nothing is left to pause, so the
    overrun is recorded, audited and shown in the Inbox, with Cancel again for a stopped
    workflow that still runs, until an owner or the run's creator dismisses it (once
    nothing is left to read). Kept on the run after that."""
    knobs = run.knobs or {}
    running = [str(e["id"]) for e in knobs.get("searches") or [] if e.get("id")]
    record: dict[str, Any] = {
        "spent_usd": str(run.spent_usd),
        "ceiling_usd": str(ceiling),
        "at": service._now().isoformat(),
        "running": running,
    }
    at_end = knobs.get("spent_at_end")
    already = at_end is not None and Decimal(str(at_end)) > ceiling
    if already:
        record["spent_at_end"] = str(at_end)
    previous = knobs.get("overrun_after_end")
    if isinstance(previous, dict) and previous.get("dismissed_at"):
        record["earlier"] = [*(previous.get("earlier") or []), previous]
    _set_knob(run, "overrun_after_end", record)
    if segment is not None:
        still = (
            f"workflow {', '.join(running)} still runs in SwarmCloud"
            if running
            else "the last read of a workflow it no longer drives found it"
        )
        if already:
            said = (
                f"The run was already over its {_usd_text(ceiling)} ceiling when it ended "
                f"({_usd_text(at_end)}); after it ended its spend grew to "
                f"{_usd_text(run.spent_usd)}: {still}."
            )
        else:
            said = (
                f"After the run ended its spend reached {_usd_text(run.spent_usd)}, over its "
                f"{_usd_text(ceiling)} ceiling: {still}."
            )
        _note(segment, said)
    await audit.record(
        db,
        None,
        "run.overrun_after_end",
        "run",
        run.id,
        {"spent_usd": str(run.spent_usd), "ceiling_usd": str(ceiling)},
    )


def _found_cancels(e: dict[str, Any]) -> bool:
    """Whether the next look at a searched workflow cancels it: not one an approver
    stopped cancelling, not one whose cancel was confirmed, and the cancel call rests
    between tries (its status and cost are read every tick)."""
    return bool(
        e.get("cancel", True) and not e.get("cancelled") and not _rests(e.get("cancel_tried_at"))
    )


async def _found_call(e: dict[str, Any]) -> _Cancelled:
    """The network half of a look at a searched workflow (:func:`_found_apply` records
    it): calls only, nothing written, so the caller may hold no lock."""
    wid = e["id"]
    return await (_cancel_call({"id": wid}) if _found_cancels(e) else _read_call(wid))


def _last_cost(segment: RunSegment | None, wid: str) -> float:
    """What was counted on the run's spend (nothing known: nothing counted)."""
    if segment is None:
        return 0.0
    attempts = _art(segment)["attempts"]
    counted = _known_sum(a.get("cost_usd") for a in attempts if a.get("workflow_id") == wid)
    return float(counted or 0)


def _found_apply(
    run: Run,
    segments: list[RunSegment],
    segment: RunSegment | None,
    e: dict[str, Any],
    out: _Cancelled,
    cancelling: bool,
) -> bool:
    """Record one look at a searched workflow (:func:`_found_call`; ``cancelling``: it
    was a cancel). Returns True to keep it. A workflow dropped at its cap is marked
    ``dropped`` (audited by the caller)."""
    label, wid = e.get("label"), e["id"]
    if cancelling:
        e["cancel_tried_at"] = service._now().isoformat()
        if out.error is None and not out.gone:
            e["cancelled"] = True  # confirmed: its status and cost are left to read
    final = out.final
    if final is not None:
        _cost_on(run, segments, e, final.cost_usd)
        e["costed"] = True
        e.pop("gone_reads", None)
        if final.terminal:
            if segment is not None:
                if e.get("cancel") is False:
                    said = (
                        f"Workflow {wid}, which an approver stopped cancelling, ended "
                        f"{final.state} in SwarmCloud: ${final.cost_usd} counted in the "
                        "run's spend."
                    )
                else:
                    said = (
                        f"Oracle cancelled workflow {wid} (submission {label}), given up on "
                        f"earlier; it ended {final.state} (${final.cost_usd} counted in the "
                        "run's spend)."
                    )
                _note(segment, said)
            return False
        for key in ("unread", "not_found", "stuck", "error", "cost_unknown"):
            e.pop(key, None)
        if e.get("cancelled") and service._now() >= _search_end(e):
            # P3d 'Stuck cancels' (owner, 2026-10-20): its cancel was confirmed long ago
            # and it still reads as not ended. Its cost reads, so it is counted and not
            # 'cost unknown'; it is dropped at the same cap, with a note on the run.
            e["winding"] = True
            e.setdefault("winding_since", service._now().isoformat())
            return _under_cap(segment, e)
        e.pop("winding", None)
        e.pop("winding_since", None)
        return True  # still running, or winding down: read again (its cost counts)
    if (out.forgotten or (out.gone and e.get("cancelled"))) and not e.get("gone_reads"):
        # After its confirmed cancel SwarmCloud does not know it: its cost is read once
        # more before it is taken as ended, so that what it spent since Oracle's last
        # read (up to the cancel) is counted, and SwarmCloud may lag. That read failing,
        # the cost-unknown rules apply.
        e["gone_reads"] = 1
        e["error"] = "SwarmCloud did not know it right after confirming its cancel"
        return True
    if out.forgotten or (out.gone and e.get("cancelled")):
        if segment is not None:
            _note(
                segment,
                f"SwarmCloud no longer knows workflow {wid} (submission {label}, HTTP 404) "
                "after it confirmed its cancel: Oracle takes it as ended, its cost what "
                f"Oracle last read (${_last_cost(segment, wid):g} counted in the run's "
                "spend).",
            )
        return False
    if out.gone:
        if segment is not None:
            _note(
                segment,
                f"SwarmCloud does not know workflow {wid} (submission {label}, HTTP 404): "
                "Oracle stopped checking it; its cost is what Oracle last read.",
            )
        return False
    # Nothing read this time: its cost is unknown (whether or not it was winding down).
    e.pop("winding", None)
    e["error"] = _shown(out.error or out.unread) or "its status was not read"
    e["unread"] = int(e.get("unread") or 0) + 1
    if _not_found(out.error) or _not_found(out.unread):
        e["not_found"] = int(e.get("not_found") or 0) + 1
        if e["not_found"] >= NOT_FOUND_TRIES:
            e["stuck"] = True
    if e.get("stuck") or service._now() >= _search_end(e):
        e.setdefault("cost_unknown", service._now().isoformat())
    return _under_cap(segment, e)


def _under_cap(segment: RunSegment | None, e: dict[str, Any]) -> bool:
    """A searched workflow whose cost is unknown, or whose confirmed cancel still reads
    CANCELLING past its search's end (its cost read and counted), is kept until
    :func:`_cost_cap`, then dropped (noted, and marked ``dropped`` for the audit)."""
    if not (e.get("cost_unknown") or e.get("winding")) or service._now() < _cost_cap(e):
        return True
    wid, label = e["id"], e.get("label")
    stopped = f"Oracle stopped reading it at its cap ({_cost_cap(e).isoformat(timespec='minutes')})"
    if segment is not None:
        if e.get("winding") and not e.get("cost_unknown"):
            _note(
                segment,
                f"Workflow {wid} (submission {label}) still read CANCELLING after SwarmCloud "
                f"confirmed its cancel, since {str(e.get('winding_since'))[:16]}. {stopped}; "
                f"its cost was read and counted until then (${_last_cost(segment, wid):g} "
                "in the run's spend). If it still runs, cancel it in SwarmCloud's console.",
            )
        else:
            _note(
                segment,
                f"Cost unknown for workflow {wid} (submission {label}): SwarmCloud has not "
                f"served its status since {str(e.get('cost_unknown'))[:16]} "
                f"({e.get('error')}). {stopped}, and the run's spend has what Oracle last "
                "read. If it still runs, cancel it in SwarmCloud's console.",
            )
    e["dropped"] = "cost_unknown_cap"
    return False


async def _read_found(
    run: Run, segments: list[RunSegment], segment: RunSegment | None, e: dict[str, Any]
) -> bool:
    """One look at a searched workflow known by its id: cancel it (until SwarmCloud
    confirms; not one an approver stopped cancelling) and read its status and cost, the
    cost counted in the run's spend. Returns True to keep it: until its status reads
    terminal (a confirmed cancel still winding down is read on, its cost counted, until
    :func:`_search_end`; past it, it is capped like a cost unknown), or SwarmCloud says
    it does not exist (after a confirmed cancel: read once more first, then it ended,
    its last read cost counted, noted). When nothing could be
    read, 404s that prove nothing are counted; past :data:`NOT_FOUND_TRIES` of them, or
    past :func:`_search_end`, its cost is unknown: shown in the Inbox (Retry lookup) and
    read again now and then until :func:`_cost_cap`, then dropped (noted, audited)."""
    cancelling = _found_cancels(e)
    out = await _found_call(e)
    return _found_apply(run, segments, segment, e, out, cancelling)


async def _import_names(db: AsyncSession, run: Run, segment: RunSegment) -> set[str]:
    """The files :func:`_advance` imports or checks from ``segment``: without one, its
    import fails or reads as empty."""
    sdef = _flow(run).segment(segment.name)
    names = {
        name
        for name in (
            ITEMS_FILE,
            feature_set.FILE,
            run_order.FILE,
            flows.LAUNCH_FILE,
            flows.TRIAGE_FILE,
            flows.BRIEFS_FILE,
        )
        if name in sdef.outputs
    }
    if sdef.imports_baseline:
        names.add("baseline.yaml")
    if sdef.checkpoint == eng_dates.KIND:
        names.add(eng_dates.FILE)
    if sdef.imports_draft:
        names.add(flows.draft_file(await _target_kind(db, run)))
    return names


def _note_refused(
    run: Run, segment: RunSegment, art: dict[str, Any], skipped: dict[str, str], needed: set[str]
) -> str | None:
    """Notes each file SwarmCloud refused to serve, once per file name (its refusal's
    words may carry a request id that changes on every read). Returns what to say
    when one of them is a file the segment's import needs: its results are not taken."""
    refused = art.setdefault("refused_files", {})
    held: list[str] = []
    for name, why in sorted(skipped.items()):
        why = _shown(why) or "no reason given"
        if name in needed:
            held.append(f"{name} ({why})")
            note = (
                f"SwarmCloud refused to send {name} ({why}), the file this step's results "
                "are imported from, so they were not imported. Oracle asks again each "
                "minute; if SwarmCloud keeps refusing it, ask whoever runs SwarmCloud why "
                "it refuses this file: it goes by the file's name, so running the step "
                "again will not help."
            )
        else:
            note = (
                f"SwarmCloud refused to send {name} ({why}), so this step's results were "
                "imported without it."
            )
        if name not in refused:
            refused[name] = why
            _note_art(art, note)
    if not held:
        return None
    # Read on the run page as it is (after "run <id>: "): words only.
    return (
        f"run {run.id}: SwarmCloud refused to send {', '.join(held)}, which the "
        f"{_flow(run).segment(segment.name).title} step needs to import its results"
    )


async def _harvest(
    db: AsyncSession, run: Run, segment: RunSegment, workflow_id: str, steps: tuple[str, ...]
) -> str | None:
    """A segment's files from the steps that wrote them (read by task id), in step order:
    a later step's file of the same name wins. A file SwarmCloud refuses to serve for good
    is noted and left out; when the import needs it, nothing is taken and the reason is
    returned (the segment keeps running and is read again)."""
    files, skipped = await _rt().read_artifacts(workflow_id, steps)
    art = _art(segment)
    if skipped:
        held = _note_refused(run, segment, art, skipped, await _import_names(db, run, segment))
        if held is not None:
            _set_art(segment, art)
            return held
    art["files"] = {**art["files"], **files}
    if art["attempts"]:
        _current_attempt(art, segment)["state"] = "succeeded"
    _set_art(segment, art)
    segment.status = "succeeded"
    segment.finished_at = service._now()
    return None


# A step state that is neither a failure nor an expiry.
_OPEN_OR_DONE = ("PENDING", "RUNNING", "PARKED", "SUCCEEDED", "SKIPPED")


async def _tick_workflow(
    db: AsyncSession,
    run: Run,
    wf: dict[str, Any],
    segments: list[RunSegment],
    stats: _TickStats,
    status: WorkflowStatus | None = None,
) -> None:
    """Advance a run that is one live workflow: record its cost, take each segment's files
    when the wait after it opens (or when it is done, checkpoint off), open the checkpoint
    with the wait to answer, and notice expiry, failures and the end. ``status``: the
    workflow's status, when the pass read it already."""
    if status is None:
        status = await _rt().status(wf["id"])
    start = service._take_cost(run, wf, status, segments)
    current = next((s for s in segments if s.status == "running"), None)
    service._record_running(wf, status, segments)
    _record_workflow_wait(run, wf, status, segments)
    expired = [p for p in status.parked if p.mcp_expired]
    if expired:
        # Its key expired while the step waited in SwarmCloud's queue: renewed after this
        # pass commits (:func:`refresh_key`), once per park.
        wf = service._mark_key_refresh(run, wf, status, expired)
    for parked in status.parked:
        if parked.reason == "CREDENTIAL_MISSING" and not parked.mcp_expired:
            _note(
                current or start or segments[0], workflow.ADVICE[service._key_park_advice(parked)]
            )
    if run.status == "paused_overrun":
        await service._pause_workflow(db, run, wf, status, segments)
        return
    # The ceiling first, before anything that follows an answer or submits: it holds while
    # the run waits too (a workflow can spend while its run waits on a checkpoint).
    if (ceiling := service._overrun(run)) is not None:
        await service._pause_overrun(db, run, ceiling, stats)
        await service._pause_workflow(db, run, wf, status, segments)
        return
    if run.status == "awaiting_checkpoint":
        # An answer given outside the Inbox is followed; the workflow ending is noticed.
        await service._watch_wait(db, run, wf, status, segments)
        followed = _drivable(run)
        if run.status != "running" or followed is None or followed["id"] != wf["id"]:
            service._record_running(wf, status, segments)
            return  # still waiting, or done with this workflow
        wf = followed

    while run.status == "running":
        current = next((s for s in segments if s.status == "running"), None)
        entry = _plan_entry(wf, current.seq) if current is not None else None
        if current is None or entry is None:
            break
        round_ = int(entry.get("round") or 1)
        producers = tuple(entry["work"]) if round_ == 1 else (entry["revises"][round_ - 2],)
        done = status.step(producers[-1])
        if done is None or done.state != "SUCCEEDED":
            break
        reviews = entry.get("reviews") or []
        if entry.get("checkpoint") and round_ <= len(reviews):
            review = reviews[round_ - 1]
            parked = next(
                (p for p in status.parked if p.step_id == review and p.reason == "AWAITING_INPUT"),
                None,
            )
            ended = status.step(review)
            # Answered before Oracle opened its checkpoint (in SwarmCloud's console): the
            # checkpoint opens, and the next look at the wait follows that answer.
            answered = ended is not None and ended.state == "SUCCEEDED"
            closed = status.terminal and ended is not None and ended.state not in _OPEN_OR_DONE
            if parked is None and not answered and not closed:
                break
            if (held := await _harvest(db, run, current, wf["id"], producers)) is not None:
                stats.errors.append(held)
                break
            wait: dict[str, Any] = {
                "workflow_id": wf["id"],
                "step_id": review,
                "round": round_,
                "artifact": workflow.review_artifact(round_),
            }
            if parked is not None:
                wait["task_id"] = parked.task_id
                wait["opened_at"] = parked.opened_at.isoformat() if parked.opened_at else None
                wait["expires_at"] = parked.expires_at.isoformat() if parked.expires_at else None
            elif answered:
                wait["task_id"] = ended.task_id  # type: ignore[union-attr]
                # W5: answered and not read yet, so held from the start; the next look
                # at the wait reads it and applies the approver rule.
                wait["console"] = service._unread_console(
                    run, current, wf, wait, "answered before Oracle opened the checkpoint"
                )
            else:
                # The wait ended before Oracle opened its checkpoint (it expired while the
                # run was paused): the checkpoint opens in the Inbox only.
                wait["ended"] = "expired"
                wait["ended_at"] = service._now().isoformat()
                _note(current, workflow.ADVICE["expired"])
                await _detach(db, run, cancel=False, state="expired")
            stats.finished += 1
            if await _advance(db, run, current, segments, wait=wait):
                stats.advanced += 1
            break
        # Checkpoint off, or the last round's revision is done: the files are final.
        if (held := await _harvest(db, run, current, wf["id"], producers)) is not None:
            stats.errors.append(held)
            break
        stats.finished += 1
        if entry.get("checkpoint"):
            # Its checkpoint waits in the Inbox only: the workflow has nothing left.
            await _detach(db, run, cancel=False, state="ended")
        if await _advance(db, run, current, segments):
            stats.advanced += 1
    # A segment that started during this check shows what the check read.
    service._record_running(wf, status, segments)
    _record_workflow_wait(run, wf, status, segments)

    if status.terminal and run.status == "running" and _live(run) is not None:
        current = next((s for s in segments if s.status == "running"), None)
        if status.state == "succeeded":
            if current is None:
                await _detach(db, run, cancel=False, state="ended")
                return
            error = f"the workflow ended before '{current.name}' wrote its files"
        else:
            fallback = (
                _failed_why(run, current, status)
                if status.state == "failed"
                else f"the workflow ended {status.state}: {status.error or 'no reason given'}"
            )
            error = workflow.advice(status.error_code, fallback)
            waited = (
                _queued_expiry(run, wf, status)
                if status.error_code == "mcp_credential_expired" and current is not None
                else None
            )
            if waited is not None and current is not None:
                if _may_restart(run, wf, status, current):
                    await _restart_queued(db, run, wf, current, segments, waited)
                    return
                error = waits.queued_expiry(waited, restarted="queue_restart" in run.knobs)
        if current is not None:
            current.status = "failed" if status.state != "cancelled" else "cancelled"
            current.error = error
            current.finished_at = service._now()
        await _finish(db, run, "failed", f"{_title(run, current)}: {error}")
        await audit.record(db, None, "run.failed", "run", run.id, {"workflow": wf["id"]})


def _title(run: Run, segment: RunSegment | None) -> str:
    """A segment's name as people read it (PRD draft), for the run's error."""
    if segment is None:
        return "The workflow"
    try:
        return _flow(run).segment(segment.name).title
    except (KeyError, StopIteration):
        return segment.name


def _failed_why(run: Run, segment: RunSegment | None, status: WorkflowStatus) -> str:
    """Why a failed workflow's step stopped, in plain words (Nov 6: "the workflow ended
    failed: claude-code exited 1:" told no one anything): the failed step's role and the
    cause read from its task's last error, else the workflow's."""
    step = next((st for st in status.steps if st.state in ("FAILED", "DEAD_LETTERED")), None)
    role = step.role if step is not None and step.role else None
    if role is None and step is not None:
        role = step.step_id.rsplit("-", 1)[-1]
    if role not in flows.ROLES and segment is not None:
        try:
            role = _flow(run).segment(segment.name).roles[0]
        except (KeyError, StopIteration, IndexError):
            role = None
    title = flows.ROLES[role].title.lower() if role in flows.ROLES else None
    raw = (step.error if step else None) or status.error
    log.warning("run %s step %s failed: %s", run.id, step.step_id if step else None, raw)
    return workflow.plain_failure(raw, title)


def _queued_expiry(run: Run, wf: dict[str, Any], status: WorkflowStatus) -> float | None:
    """How long the failing step waited in SwarmCloud's queue when the workflow's key
    expired before it started (mcp_credential_expired), else None: it started before
    the key's ``expires_at`` (SwarmCloud's start time, else Oracle saw it working), or
    the failure came before that moment (its start time not served)."""
    expires = _parse_at(wf.get("expires_at"))
    failed = next((st for st in status.steps if st.state in ("FAILED", "DEAD_LETTERED")), None)
    if expires is None or failed is None:
        return None
    qw = (run.knobs or {}).get("queue_wait") or {}
    if qw.get("workflow_id") != wf.get("id"):
        qw = {}
    if failed.step_id in (qw.get("started_steps") or []):
        return None
    if failed.started_at is not None:
        if failed.started_at < expires:
            return None
    elif service._now() < expires:
        return None
    submitted = _parse_at(wf.get("submitted_at"))
    since = _parse_at((qw.get("waiting") or {}).get(failed.step_id)) or submitted or expires
    if submitted is not None:
        since = max(since, submitted)
    return max((expires - since).total_seconds(), 0.0)


def _may_restart(run: Run, wf: dict[str, Any], status: WorkflowStatus, current: RunSegment) -> bool:
    """A queued expiry restarts once per run, and never when the segment's failed attempt
    (or its failing step) cost anything."""
    if "queue_restart" in (run.knobs or {}):
        return False
    spent = _known_sum(
        a.get("cost_usd") for a in _art(current)["attempts"] if a.get("workflow_id") == wf.get("id")
    )
    failed = next((st for st in status.steps if st.state in ("FAILED", "DEAD_LETTERED")), None)
    return not spent and not (failed is not None and failed.cost_usd)


async def _restart_queued(
    db: AsyncSession,
    run: Run,
    wf: dict[str, Any],
    current: RunSegment,
    segments: list[RunSegment],
    waited: float,
) -> None:
    """Owner, 2026-10-26: a run whose key expired while its step waited in SwarmCloud's
    queue is submitted again once, as a new attempt of the same segment with the same
    knobs and a fresh key (:func:`_submit`, which the spend ceiling rules as any other)."""
    art = _art(current)
    attempt = _current_attempt(art, current)
    if attempt:
        attempt["state"] = "failed"
    _set_art(current, art)
    _note(current, waits.restarted_note(waited))
    _set_knob(
        run,
        "queue_restart",
        {
            "seq": current.seq,
            "workflow_id": wf.get("id"),
            "at": service._now().isoformat(),
            "waited_seconds": round(waited),
        },
    )
    _set_knob(run, "queue_wait", None)
    await _detach(db, run, cancel=False, state="ended")
    await _submit(db, run, current, segments)
    await audit.record(
        db,
        None,
        "run.restarted",
        "run",
        run.id,
        {"workflow": wf.get("id"), "reason": "mcp_credential_expired"},
    )
