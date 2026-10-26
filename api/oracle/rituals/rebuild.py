"""The Baseline rebuild ritual: B1's Build the baseline run on the ritual clock (the
``baseline_rebuild`` kind, seeded paused).

H11's "Keep the baseline current" (``baseline``) decides what Oracle does when an
occurrence falls due:

- **Observe**: it only reminds. No run; the pre-read's Inbox row reaches the attendees
  and its block links B1's Build the baseline sheet (``/baseline?build=1``);
- **Draft or above**: it starts one ``baseline`` run (standard depth, Confirm the
  baseline on), created by the ritual's owner, then tells the owner ("Oracle did", with
  the estimate; Undo cancels the run). No ritual cost cap applies (Run rituals'
  ``max_run_usd`` is not read): only P3's, so a run over $50 waits for an owner's
  approval and the occurrence says so.

With a build already under way (B1: one at a time), with an owner who can no longer start
runs, or when starting the run fails, nothing starts and the occurrence says why. The run is B1's:
its proposals land for review the way a person's build's do (Draft and Recommend make
every agent write a proposal, H11), and it waits at Confirm the baseline for a person.

The occurrence's ``summary_*`` fields carry the build: ``running`` while the run is under
way, ``ready`` once it succeeded, ``failed`` when it failed or was cancelled, and
``not_started`` with the reason.
"""

import logging
import uuid
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, autonomy, company_time
from oracle.auth.models import User
from oracle.authz import has_role
from oracle.rituals.models import Ritual, RitualOccurrence
from oracle.runs import flows
from oracle.runs.models import Run

log = logging.getLogger(__name__)

KIND = "baseline_rebuild"
FLOW = "baseline"
DEPTH = "standard"
BLOCK = "baseline_rebuild"
TITLES = {BLOCK: "Baseline rebuild"}
BUILD_HREF = "/baseline?build=1"
BUILD_HERE = "Build it from the Baseline page."
OBSERVE = f"Not started: Oracle is set to observe the baseline. {BUILD_HERE}"
OWNER_CANNOT = "Not started: the ritual's owner can no longer start runs"
FAILED = "The baseline build did not finish · Build it from the Baseline page"
ON_DEMAND = "Start the baseline rebuild from the Baseline page"
NOT_STARTED = "Not started: Oracle could not start the build. Build it from the Baseline page."
WAITS = " · Waits for an owner's approval"
UNDER_WAY = ("draft", "awaiting_approval", "running", "awaiting_checkpoint", "paused_overrun")


def estimate_usd() -> Decimal:
    """The build at the ritual's knobs: standard depth, default roles ($7.00)."""
    flow = flows.FLOWS[FLOW]
    knobs = flows.resolve_knobs(flow, {"depth": DEPTH})
    return sum((flows.segment_estimate(s, knobs) for s in flow.segments), Decimal(0))


def _usd(value: Decimal | float) -> str:
    return f"${Decimal(str(value)):.2f}"


def _over_approval(usd: Decimal) -> bool:
    return usd > flows.APPROVAL_THRESHOLD_USD


def approval_note(usd: Decimal) -> str:
    """P3: why a started build waits."""
    return (
        f"Waiting for an owner's approval: the estimate {_usd(usd)} is over "
        f"${flows.APPROVAL_THRESHOLD_USD:g}"
    )


async def blocked(db: AsyncSession) -> str | None:
    """Why Oracle starts no build now (read per call), or None: Observe. No ritual cost
    cap applies; over $50 the run it starts waits for an owner (P3)."""
    if not await autonomy.allows(db, "baseline", "draft"):
        return OBSERVE
    return None


async def block(db: AsyncSession, ctx: Any) -> list[dict[str, Any]]:
    """The pre-read: the last build, the estimate, and what Oracle does now (no model
    call)."""
    last = await db.scalar(
        select(Run)
        .where(Run.flow == FLOW, Run.status == "succeeded")
        .order_by(Run.created_at.desc())
        .limit(1)
    )
    rows: list[dict[str, Any]] = []
    if last is None:
        rows.append({"text": "No baseline build yet", "href": None})
    else:
        zone = await company_time.company_time_zone(db)
        when = company_time.stamp(last.created_at, zone)
        rows.append({"text": f"Last built {when}", "href": f"/runs/{last.id}"})
    rows.append({"text": f"Estimate {_usd(estimate_usd())} at {DEPTH} depth", "href": None})
    why = await blocked(db)
    if why is None and _over_approval(estimate_usd()):
        rows.append({"text": "Oracle starts the build; over "
                     f"${flows.APPROVAL_THRESHOLD_USD:g} it waits for an owner's approval",
                     "href": "/baseline"})  # fmt: skip
    elif why is None:
        rows.append({"text": "Oracle starts the build; its proposals wait for review",
                     "href": "/baseline"})  # fmt: skip
    else:
        rows.append({"text": why, "href": None})
        rows.append({"text": "Build the baseline", "label": "Build the baseline",
                     "href": BUILD_HREF})  # fmt: skip
    return rows


async def _note(db: AsyncSession, occ: RitualOccurrence, note: str) -> None:
    occ.summary_state = "not_started"
    occ.summary_note = note
    await db.commit()


async def after_ready(db: AsyncSession, occ_id: uuid.UUID, ritual: Ritual) -> None:
    """Start the build of an occurrence that just became ready, once (see the module
    docstring). Never raises: the pre-read stays as it is."""
    from oracle.runs import service as runs_service
    from oracle.runs.schemas import KnobsIn, RunCreate

    try:
        ritual_id, owner_id = ritual.id, ritual.owner_id
        occ = await db.get(RitualOccurrence, occ_id, with_for_update=True)
        if occ is None or occ.summary_state != "none" or occ.summary_run_id is not None:
            await db.rollback()
            return
        why = await blocked(db)
        if why is not None:
            await _note(db, occ, why)
            return
        owner = await db.get(User, owner_id)
        if owner is None or owner.disabled_at is not None or not has_role(owner.role, "approver"):
            await _note(db, occ, OWNER_CANNOT)
            return
        body = RunCreate(
            flow=FLOW,  # type: ignore[arg-type]
            knobs=KnobsIn(depth=DEPTH, checkpoints={"baseline_confirm": True}),
        )
        try:
            run_id = await runs_service.create_run(
                db, audit.ORACLE, body, entry_knobs={"ritual_occurrence_id": str(occ_id)},
                commit=False, created_by=owner.id,
            )  # fmt: skip
        except runs_service.RunError as exc:
            await db.rollback()
            occ = await db.get(RitualOccurrence, occ_id, with_for_update=True)
            if occ is not None:
                await _note(db, occ, f"Not started: {str(exc)[:1].lower()}{str(exc)[1:]}")
            return
        occ.summary_run_id = run_id
        occ.summary_state = "running"
        occ.summary_note = None
        occ.summary = None
        await audit.record(db, audit.ORACLE, "ritual.rebuild_started", "ritual_occurrence",
                           occ_id, {"run_id": str(run_id), "flow": FLOW})  # fmt: skip
        await db.commit()
        try:
            await runs_service.estimate(db, audit.ORACLE, run_id)
            await runs_service.start(db, audit.ORACLE, run_id)
        except Exception as exc:
            # The run stays a draft (B1 counts no draft as a build under way): the
            # occurrence says it did not start, rather than "running" forever.
            log.exception("rituals: the baseline rebuild run %s did not start", run_id)
            await db.rollback()
            occ = await db.get(RitualOccurrence, occ_id, with_for_update=True)
            run = await db.get(Run, run_id)
            if occ is not None and run is not None and run.status == "draft":
                occ.summary_run_id = None
                msg = str(exc) if isinstance(exc, runs_service.RunError) else ""
                await _note(db, occ, f"Not started: {msg[:1].lower()}{msg[1:]}" if msg
                            else NOT_STARTED)  # fmt: skip
            return
        run = await db.get(Run, run_id)
        usd = run.estimate_usd if run is not None and run.estimate_usd else estimate_usd()
        waits = run is not None and run.status == "awaiting_approval"
        if waits:
            occ = await db.get(RitualOccurrence, occ_id)
            if occ is not None:
                occ.summary_note = approval_note(usd)
        await autonomy.acted(
            db,
            "baseline",
            summary=f"Started the baseline rebuild · Estimate {_usd(usd)}{WAITS if waits else ''}",
            subject={"kind": "ritual", "key": str(ritual_id), "href": f"/company/rituals/{occ_id}"},
            undo={"method": "POST", "path": f"/v1/runs/{run_id}/cancel", "body": None},
            notify=[owner_id],
        )
        await db.commit()
    except Exception:
        log.exception("rituals: the baseline rebuild of %s did not start", occ_id)
        await db.rollback()


async def sync_state(
    db: AsyncSession, occ: RitualOccurrence, status: str | None, usd: Decimal | None = None
) -> None:
    """A build that ended: ``ready`` once it succeeded, else ``failed``; one under way
    says it waits for an owner's approval only while it does (P3)."""
    if status == "succeeded":
        occ.summary_state, occ.summary_note = "ready", None
    elif status not in UNDER_WAY:
        occ.summary_state, occ.summary_note = "failed", FAILED
    else:
        note = approval_note(usd or estimate_usd()) if status == "awaiting_approval" else None
        if occ.summary_note == note:
            return
        occ.summary_note = note
    await db.commit()
