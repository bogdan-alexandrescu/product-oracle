"""Use the current baseline (decided 2026-10-21, B1 Build baseline "Reuse base").

A Baseline to PRD run may skip its baseline segment and its Confirm the baseline stop
when the current baseline is reusable: the last baseline review was approved in the past
30 days and no baseline build is under way.

- **The last baseline review**: the newest ``baseline_confirm`` checkpoint with status
  ``approved``, from a Baseline to PRD run or a Build the baseline run (``baseline``
  flow). A run started with that stop off leaves no review (its checkpoint is
  ``skipped``), and neither does a run that reused the baseline.
- **A baseline build under way**: a ``baseline`` run in ``awaiting_approval``,
  ``running``, ``awaiting_checkpoint`` or ``paused_overrun`` (B1's one-build rule), or a
  Baseline to PRD run in one of those states whose baseline segment is not yet
  approved: it has no ``baseline_confirm`` checkpoint ``approved`` or ``skipped`` (a
  pending or sent-back review, or the segment still working). A draft run has not
  started and builds nothing, and neither does a run reusing the baseline (its
  ``reuse_baseline`` knob), even while it waits for an owner's cost approval with no
  checkpoint yet.
"""

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import and_, exists, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import company_time
from oracle.runs import flows
from oracle.runs.models import Checkpoint, Run

REUSE_DAYS = 30
REVIEW_FLOWS = ("baseline_to_prd", "baseline")
# B1's one-build rule (oracle.runs.service.BUILD_UNDER_WAY).
UNDER_WAY = ("awaiting_approval", "running", "awaiting_checkpoint", "paused_overrun")
# A baseline segment that ended: reviewed, or its stop off (or reused).
_ENDED = ("approved", "skipped")


@dataclass(frozen=True)
class ReviewStatus:
    last_approved_at: datetime | None
    checkpoint_id: uuid.UUID | None
    run_id: uuid.UUID | None
    age_days: int | None
    build_under_way: bool
    reusable: bool
    # too_old | never_reviewed | build_under_way when not reusable.
    reason: str | None
    baseline_segment_usd: dict[str, float]

    def knob(self) -> dict[str, Any]:
        """What the ``reuse_baseline`` knob stores: the review it reuses."""
        assert self.checkpoint_id is not None and self.last_approved_at is not None
        return {
            "checkpoint_id": str(self.checkpoint_id),
            "approved_at": self.last_approved_at.isoformat(),
        }


def baseline_segment_usd() -> dict[str, float]:
    """The baseline segment's estimate per depth, from the run estimate's own figures."""
    flow = flows.FLOWS["baseline_to_prd"]
    sdef = flow.segment("baseline")
    return {
        depth: float(segment_usd(flows.resolve_knobs(flow, {"depth": depth}), sdef))
        for depth in ("quick", "standard", "deep")
    }


def segment_usd(knobs: flows.Knobs, sdef: flows.SegmentDef | None = None) -> Decimal:
    return flows.segment_estimate(sdef or flows.FLOWS["baseline_to_prd"].segment("baseline"), knobs)


def short_date(at: datetime | str, zone: str) -> str:
    """'Oct 12', the Company time zone's day (#463)."""
    return company_time.day_in_words(at, zone)


async def build_under_way(db: AsyncSession) -> bool:
    ended = exists().where(
        Checkpoint.run_id == Run.id,
        Checkpoint.kind == "baseline_confirm",
        Checkpoint.status.in_(_ENDED),
    )
    found = await db.scalar(
        select(Run.id)
        .where(
            Run.status.in_(UNDER_WAY),
            or_(
                Run.flow == "baseline",
                and_(
                    Run.flow == "baseline_to_prd",
                    ~ended,
                    # A run reusing the baseline builds none (it skips its segment at start).
                    ~Run.knobs.has_key("reuse_baseline"),
                ),
            ),
        )
        .limit(1)
    )
    return found is not None


async def review_status(db: AsyncSession, *, now: datetime | None = None) -> ReviewStatus:
    now = now or datetime.now(UTC)
    row = (
        await db.execute(
            select(Checkpoint.id, Checkpoint.run_id, Checkpoint.decided_at)
            .join(Run, Run.id == Checkpoint.run_id)
            .where(
                Checkpoint.kind == "baseline_confirm",
                Checkpoint.status == "approved",
                Checkpoint.decided_at.is_not(None),
                Run.flow.in_(REVIEW_FLOWS),
            )
            .order_by(Checkpoint.decided_at.desc(), Checkpoint.id.desc())
            .limit(1)
        )
    ).first()
    under_way = await build_under_way(db)
    approved_at = row.decided_at if row else None
    age = now - approved_at if approved_at else None
    if under_way:
        reason: str | None = "build_under_way"
    elif approved_at is None:
        reason = "never_reviewed"
    elif age is not None and age > timedelta(days=REUSE_DAYS):
        reason = "too_old"
    else:
        reason = None
    return ReviewStatus(
        last_approved_at=approved_at,
        checkpoint_id=row.id if row else None,
        run_id=row.run_id if row else None,
        age_days=age.days if age is not None else None,
        build_under_way=under_way,
        reusable=reason is None,
        reason=reason,
        baseline_segment_usd=baseline_segment_usd(),
    )
