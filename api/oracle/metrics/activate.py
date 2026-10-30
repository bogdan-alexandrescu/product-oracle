"""The weekly metrics review takes over the goals check-in (H5; "Weekly check",
2026-10-21: the goals check-in stands in "until H5").

When a company's first metric gets its first weekly value, :func:`activate_review` runs
once per company (audit ``ritual.replaced``): it resumes ``metrics_review`` with
``goals_checkin``'s schedule, owner and attendees and pauses ``goals_checkin``, whose
row then reads "Replaced by Weekly metrics review". An owner may resume either one; a
later value changes nothing. The caller commits.
"""

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.models import AuditEvent
from oracle.rituals import clock
from oracle.rituals.models import Ritual, RitualOccurrence
from oracle.rituals.schedule import next_occurrence
from oracle.tenancy import current_tenant

REVIEW = "metrics_review"
CHECKIN = "goals_checkin"
ACTION = "ritual.replaced"


async def activated(db: AsyncSession) -> bool:
    return (
        await db.scalar(select(AuditEvent.id).where(AuditEvent.action == ACTION).limit(1))
    ) is not None


async def activate_review(db: AsyncSession) -> bool:
    """Once per company: the review on the check-in's schedule, owner and attendees,
    and the check-in paused. False when it already ran, or when the company has no
    rituals yet (its first tick seeds them, and the next value tries again)."""
    if await activated(db):
        return False
    tenant = current_tenant(db)
    await db.execute(
        text("SELECT pg_advisory_xact_lock(hashtext('metrics.activate:' || :t))"),
        {"t": str(tenant)},
    )
    if await activated(db):
        return False
    from oracle.rituals import service as rituals

    await rituals.seed(db)
    found = {
        r.kind: r
        for r in await db.scalars(
            select(Ritual)
            .where(Ritual.builtin, Ritual.kind.in_((REVIEW, CHECKIN)))
            .with_for_update()
        )
    }
    review, checkin = found.get(REVIEW), found.get(CHECKIN)
    if review is None:
        return False
    if checkin is not None:
        review.schedule = dict(checkin.schedule)
        review.owner_id = checkin.owner_id
        review.attendee_ids = list(checkin.attendee_ids)
    review.status = "active"
    review.next_due_at = next_occurrence(review.schedule, clock.now())
    review.lock_version += 1
    if checkin is not None and checkin.waits_for_goal:
        # Replaced while it waited for the first goal: that goal leaves it paused.
        checkin.waits_for_goal = False
        checkin.lock_version += 1
    if checkin is not None and checkin.status == "active":
        checkin.status, checkin.next_due_at = "paused", None
        checkin.lock_version += 1
        # As pausing it on Company › Rituals does: its failed preparation leaves the Inbox.
        for occ in await db.scalars(
            select(RitualOccurrence).where(
                RitualOccurrence.ritual_id == checkin.id, RitualOccurrence.status == "failed"
            )
        ):
            occ.status, occ.skip_reason = "skipped", "Replaced by Weekly metrics review"
    await audit.record(db, audit.ORACLE, ACTION, "ritual", review.id,
                       {"replaced": CHECKIN, "by": REVIEW})  # fmt: skip
    await db.flush()
    return True


async def replaced_by(db: AsyncSession, ritual: Ritual) -> str | None:
    """ "Weekly metrics review" on a paused goals check-in the review replaced, while the
    review is active."""
    if ritual.kind != CHECKIN or not ritual.builtin or ritual.status != "paused":
        return None
    review = await db.scalar(select(Ritual).where(Ritual.kind == REVIEW, Ritual.builtin))
    if review is None or review.status != "active" or not await activated(db):
        return None
    return review.title
