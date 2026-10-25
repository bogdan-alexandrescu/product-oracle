"""The Baseline rebuild ritual: B1's Build the baseline run on the ritual clock (the
``baseline_rebuild`` kind, seeded paused).

H11's "Keep the baseline current" (``baseline``) decides what Oracle does when an
occurrence falls due:

- **Observe**: it only reminds. No run; the pre-read's Inbox row reaches the attendees
  and its block links B1's Build the baseline sheet (``/baseline?build=1``);
- **Draft or above**: it starts one ``baseline`` run (standard depth, Confirm the
  baseline on), created by the ritual's owner, when the run's estimate is within Run
  rituals' ``max_run_usd`` (the cost limit Oracle's ritual runs share), then tells the
  owner ("Oracle did", with the estimate; Undo cancels the run).

Above the limit, with a build already under way (B1: one at a time), or with an owner who
can no longer start runs, nothing starts and the occurrence says why. The run is B1's:
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
UNDER_WAY = ("draft", "awaiting_approval", "running", "awaiting_checkpoint", "paused_overrun")


def estimate_usd() -> Decimal:
    """The build at the ritual's knobs: standard depth, default roles ($7.00)."""
    flow = flows.FLOWS[FLOW]
    knobs = flows.resolve_knobs(flow, {"depth": DEPTH})
    return sum((flows.segment_estimate(s, knobs) for s in flow.segments), Decimal(0))


def _usd(value: Decimal | float) -> str:
    return f"${Decimal(str(value)):.2f}"


async def blocked(db: AsyncSession) -> str | None:
    """Why Oracle starts no build now (read per call), or None: Observe, or the estimate
    above Run rituals' cost limit."""
    if not await autonomy.allows(db, "baseline", "draft"):
        return OBSERVE
    limits = await autonomy.limits(db, "rituals")
    cap = getattr(limits, "max_run_usd", None)
    if cap is None:
        return f"Not started: there is no cost limit a run. {BUILD_HERE}"
    if estimate_usd() > Decimal(str(cap)):
        return (
            f"Not started: the estimate {_usd(estimate_usd())} is above your ${cap:g} limit "
            f"a run. {BUILD_HERE}"
        )
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
    if why is None:
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
        await runs_service.estimate(db, audit.ORACLE, run_id)
        await runs_service.start(db, audit.ORACLE, run_id)
        cap = getattr(await autonomy.limits(db, "rituals"), "max_run_usd", 0)
        await autonomy.acted(
            db,
            "baseline",
            summary=(
                f"Started the baseline rebuild · Estimate {_usd(estimate_usd())}, "
                f"within your ${cap:g} limit"
            ),
            subject={"kind": "ritual", "key": str(ritual_id), "href": f"/company/rituals/{occ_id}"},
            undo={"method": "POST", "path": f"/v1/runs/{run_id}/cancel", "body": None},
            notify=[owner_id],
        )
        await db.commit()
    except Exception:
        log.exception("rituals: the baseline rebuild of %s did not start", occ_id)
        await db.rollback()


async def sync_state(db: AsyncSession, occ: RitualOccurrence, status: str | None) -> None:
    """A build that ended: ``ready`` once it succeeded, else ``failed``."""
    if status == "succeeded":
        occ.summary_state, occ.summary_note = "ready", None
    elif status not in UNDER_WAY:
        occ.summary_state, occ.summary_note = "failed", FAILED
    else:
        return
    await db.commit()
