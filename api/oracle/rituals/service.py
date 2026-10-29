"""Rituals and their occurrences: seeding, the ticker step, the pre-read, the routes'
work and the Inbox rows.

The ticker step (:func:`tick_due`, from ``oracle.ticker.router._tick_company`` in its
own ``try``), per company and per tick:

1. seed the built-in rituals (oracle.rituals.kinds) a company does not have yet;
2. for each active ritual whose ``next_due_at - prep_hours`` has come, create its
   occurrence (unique ``(ritual_id, due_at)``: idempotent across ticks and overlapping
   calls) and advance ``next_due_at``;
3. build each scheduled occurrence's pre-read in a savepoint (the ``monitor_due``
   pattern): ready, or ``attempts`` + 1 and ``failed`` after :data:`MAX_ATTEMPTS`; then,
   with summaries on Every pre-read, or Run rituals at "Act within limits" (H11) and
   the run within its limit, start its summary run (oracle.rituals.summaries);
3b. F6's catch-up: this week's alignment report occurrence, built while there was no
   track to report, is built again once there is (:func:`_alignment_catch_up`); a
   rebuild that fails leaves it ready as it was, and one that succeeds starts its
   summary again (the old one summarised the pre-read it no longer has);
4. mark ready occurrences ``missed`` :data:`MISSED_AFTER` after their end when nothing
   was recorded;
5. send the weekly alignment report's Slack posts that are due (F6: its report is the
   ``alignment_report`` ritual's pre-read; this is the report's only clock).

At most :data:`PER_TICK` occurrences per company per tick; the rest wait for the next
minute. Building a pre-read makes no model call.
"""

import logging
import uuid
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import func, or_, select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, company_time
from oracle.auth.deps import Principal
from oracle.auth.models import User
from oracle.authz import has_role
from oracle.docs import visibility
from oracle.rituals import blocks, clock
from oracle.rituals.kinds import KINDS, available, builtins
from oracle.rituals.models import Ritual, RitualOccurrence, RitualRead
from oracle.rituals.schedule import (
    DEFAULT_ZONE,
    RitualSchedule,
    Schedule,
    lookback_days,
    next_occurrence,
)
from oracle.rituals.schemas import (
    HeldIn,
    InboxRitual,
    OccurrenceDecision,
    OccurrenceOut,
    OccurrenceSummary,
    Period,
    PreRead,
    RitualCreate,
    RitualOut,
    RitualPatch,
)
from oracle.tenancy import current_tenant

log = logging.getLogger(__name__)

MAX_ATTEMPTS = 3
MISSED_AFTER = timedelta(days=7)
PER_TICK = 20
BUILTIN_DELETE = "Built-in rituals pause; they are not deleted"


class RitualError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


def parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


async def company_timezone(db: AsyncSession) -> str:
    from oracle.tenant_settings_api import get_setting

    return str(await get_setting(db, "company_timezone"))


async def _active_users(db: AsyncSession) -> list[User]:
    return list(
        await db.scalars(
            select(User).where(User.disabled_at.is_(None)).order_by(User.created_at, User.id)
        )
    )


# --- seeding and the ticker -------------------------------------------------------------


async def _alignment_schedule(db: AsyncSession) -> tuple[Schedule, bool]:
    """The ``alignment_report`` ritual's schedule and whether it is on: F6's stored day,
    time and zone (oracle.reports.alignment settings)."""
    from oracle.reports import alignment

    settings = await alignment.load_settings(db)
    schedule = Schedule(
        freq="weekly", weekday=alignment.WEEKDAYS.index(settings.weekday), time=settings.time,
        timezone=settings.timezone,
    )  # fmt: skip
    return schedule, settings.enabled


def _first_alignment_due(schedule: Schedule, now: datetime) -> datetime:
    """F6's catch-up, kept: when this local week's moment has already passed, the week
    that just ended is reported on the first tick (its block finds a report already
    built); otherwise the next moment."""
    from oracle.reports.alignment import week_start_of

    passed = next_occurrence(schedule, now - timedelta(days=7))
    if passed <= now and week_start_of(passed, schedule.timezone) == week_start_of(
        now, schedule.timezone
    ):
        return passed
    return next_occurrence(schedule, now)


async def seed(db: AsyncSession) -> int:
    """The built-in rituals a company does not have yet (all of them on its first tick;
    a kind whose feature lands later on a later tick): each kind's defaults in the
    company's time zone, owned by its earliest active owner, with every owner and
    approver attending. ``alignment_report`` takes F6's stored schedule. Returns how many
    were added; the caller commits."""
    tenant = current_tenant(db)
    await db.execute(
        text("SELECT pg_advisory_xact_lock(hashtext('rituals.seed:' || :t))"), {"t": str(tenant)}
    )
    have = set(await db.scalars(select(Ritual.kind).where(Ritual.builtin)))
    missing = [k for k in builtins() if k.key not in have]
    if not missing:
        return 0
    users = await _active_users(db)
    owners = [u for u in users if u.role == "owner"]
    if not owners:
        return 0
    attendees = [u.id for u in users if u.role in ("owner", "approver")]
    tz = await company_timezone(db)
    now = clock.now()
    for kind in missing:
        schedule = Schedule(**{**kind.default_schedule, "timezone": tz})
        active = kind.enabled_by_default
        first = next_occurrence(schedule, now)
        if kind.key == "alignment_report":
            schedule, active = await _alignment_schedule(db)
            first = _first_alignment_due(schedule, now)
        db.add(
            Ritual(
                kind=kind.key, title=kind.title, builtin=True,
                schedule=schedule.model_dump(), duration_min=kind.duration_min,
                prep_hours=kind.prep_hours, owner_id=owners[0].id, attendee_ids=attendees,
                status="active" if active else "paused",
                next_due_at=first if active else None,
            )
        )  # fmt: skip
    await db.flush()
    return len(missing)


async def follow_alignment_setting(db: AsyncSession) -> None:
    """F6's ``alignment_report`` setting changed: its ritual takes the new day, time and
    zone, and is paused while the report is disabled. The caller commits."""
    ritual = await db.scalar(
        select(Ritual).where(Ritual.kind == "alignment_report", Ritual.builtin).with_for_update()
    )
    if ritual is None:
        return
    schedule, enabled = await _alignment_schedule(db)
    if ritual.schedule == schedule.model_dump() and (ritual.status == "active") == enabled:
        return
    ritual.schedule = schedule.model_dump()
    ritual.status = "active" if enabled else "paused"
    ritual.next_due_at = _first_alignment_due(schedule, clock.now()) if enabled else None
    ritual.lock_version += 1


async def _store_alignment_schedule(
    db: AsyncSession, principal: Principal, schedule: RitualSchedule
) -> None:
    """A new schedule for the weekly alignment report's ritual: weekly, in the Company
    time zone (the report counts its weeks there), and stored as the report's own day
    and time (F6's ``alignment_report`` setting), so the two never disagree."""
    from oracle.reports import alignment
    from oracle.tenant_settings import TenantSetting
    from oracle.tenant_settings_api import get_setting

    if schedule.freq != "weekly":
        raise RitualError(422, "schedule.freq: the weekly alignment report is weekly")
    value = alignment.validate_setting(
        {**alignment.validate_setting(await get_setting(db, alignment.SETTING_KEY)),
         "weekday": alignment.WEEKDAYS[schedule.weekday], "time": schedule.time}
    )  # fmt: skip
    row = await db.scalar(select(TenantSetting).where(TenantSetting.key == alignment.SETTING_KEY))
    if row is None:
        db.add(TenantSetting(key=alignment.SETTING_KEY, value=value, updated_by=principal.id))
    else:
        row.value, row.updated_by = value, principal.id


async def follow_company_timezone(db: AsyncSession, old: str) -> None:
    """The Company time zone changed from ``old``: every ritual takes the new zone and its
    next date in it (one zone, owner decision 2026-10-22), and the alignment report's
    ritual follows its setting. The caller commits."""
    new = await company_timezone(db)
    rows = await db.scalars(select(Ritual).order_by(Ritual.id).with_for_update())
    for ritual in rows.all():
        if (ritual.kind == "alignment_report" and ritual.builtin) or ritual.schedule.get(
            "timezone"
        ) == new:
            continue
        schedule = Schedule(**{**ritual.schedule, "timezone": new})
        ritual.schedule = schedule.model_dump()
        if ritual.status == "active":
            ritual.next_due_at = next_occurrence(schedule, clock.now())
        ritual.lock_version += 1
    await follow_alignment_setting(db)


async def _previous_due(db: AsyncSession, ritual_id: uuid.UUID, due_at: datetime):
    return await db.scalar(
        select(func.max(RitualOccurrence.due_at)).where(
            RitualOccurrence.ritual_id == ritual_id, RitualOccurrence.due_at < due_at
        )
    )


async def _create_occurrence(db: AsyncSession, ritual: Ritual, due_at: datetime) -> uuid.UUID:
    """The ritual's occurrence at ``due_at``, created once (unique ``(ritual_id,
    due_at)``); returns its id."""
    previous = await _previous_due(db, ritual.id, due_at)
    period_from = previous or due_at - timedelta(days=lookback_days(ritual.schedule))
    stmt = (
        insert(RitualOccurrence)
        .values(
            id=uuid.uuid4(), tenant_id=current_tenant(db), ritual_id=ritual.id, due_at=due_at,
            ends_at=due_at + timedelta(minutes=ritual.duration_min),
            period_from=period_from, period_to=due_at,
        )
        .on_conflict_do_nothing(index_elements=["ritual_id", "due_at"])
    )  # fmt: skip
    await db.execute(stmt)
    occ_id = await db.scalar(
        select(RitualOccurrence.id).where(
            RitualOccurrence.ritual_id == ritual.id, RitualOccurrence.due_at == due_at
        )
    )
    assert occ_id is not None
    return occ_id


async def _build(
    db: AsyncSession, occ: RitualOccurrence, ritual: Ritual, *, rebuild: bool = False
) -> bool:
    """Build the occurrence's pre-read in a savepoint: ready, or attempts + 1 (failed
    after :data:`MAX_ATTEMPTS`). ``rebuild``: the occurrence is ready already; a failure
    leaves it as it was, and a success clears the summary of the pre-read it replaced.
    Never raises what a builder raises."""
    kind = KINDS.get(ritual.kind, KINDS["custom"])
    now = clock.now()
    ctx = blocks.BlockCtx(
        ritual_owner_id=ritual.owner_id,
        period_from=occ.period_from or occ.due_at - timedelta(days=7),
        period_to=occ.period_to or occ.due_at,
        now=now,
        occurrence_id=occ.id,
    )
    try:
        async with db.begin_nested():
            built = await blocks.build(db, kind.blocks, ctx)
    except Exception as exc:
        log.warning("rituals: the pre-read of occurrence %s failed: %s", occ.id, exc)
        if rebuild:
            return False
        occ.attempts += 1
        occ.error = f"{type(exc).__name__}: {exc}"[:2000]
        if occ.attempts >= MAX_ATTEMPTS:
            occ.status = "failed"
        return False
    occ.pre_read = {
        "built_at": now.isoformat(),
        "blocks": built,
        "markdown": blocks.markdown(
            ritual.title, occ.due_at, built, await company_time.company_time_zone(db)
        ),
    }
    occ.pre_read_built_at = now
    occ.status = "ready"
    occ.error = None
    if rebuild:
        # A summary run still under way finds another run named and imports nothing.
        occ.summary, occ.summary_run_id = None, None
        occ.summary_state, occ.summary_note = "none", None
    return True


async def _alignment_catch_up(
    db: AsyncSession, now: datetime
) -> tuple[uuid.UUID, uuid.UUID] | None:
    """F6's catch-up within the week, kept by its ritual: this week's occurrence of the
    weekly alignment report, built when there was nothing to report (no active or paused
    track), is built again on a later tick of the same local week once there is, so the
    week that just ended is still reported. One cheap check per tick otherwise. Returns
    the rebuilt occurrence's and its ritual's ids."""
    from oracle.reports import alignment
    from oracle.reports.models import AlignmentReport
    from oracle.roadmap.models import ProductTrack

    ritual = await db.scalar(
        select(Ritual).where(
            Ritual.kind == "alignment_report", Ritual.builtin, Ritual.status == "active"
        )
    )
    if ritual is None:
        return None
    schedule = Schedule(**ritual.schedule)
    due = _first_alignment_due(schedule, now)
    if due > now:
        return None
    occ = await db.scalar(
        select(RitualOccurrence)
        .where(RitualOccurrence.ritual_id == ritual.id, RitualOccurrence.due_at == due,
               RitualOccurrence.status == "ready")
        .with_for_update(skip_locked=True)
    )  # fmt: skip
    if occ is None:
        return None
    week = alignment.week_start_of(due, schedule.timezone) - timedelta(days=7)
    if await db.scalar(
        select(AlignmentReport.id).where(
            AlignmentReport.kind == "weekly", AlignmentReport.week_start == week
        )
    ):
        return None
    reportable = select(ProductTrack.id).where(ProductTrack.status.in_(alignment.REPORTED_STATUSES))
    if await db.scalar(reportable.limit(1)) is None:
        return None
    return (occ.id, ritual.id) if await _build(db, occ, ritual, rebuild=True) else None


async def tick_due(db: AsyncSession) -> dict[str, int]:
    """One company's ritual work for this tick (see the module docstring); commits."""
    from oracle.rituals import summaries

    out = {"seeded": 0, "created": 0, "ready": 0, "failed": 0, "missed": 0}
    out["seeded"] = await seed(db)
    await db.commit()
    now = clock.now()
    budget = PER_TICK
    due = list(
        await db.scalars(
            select(Ritual)
            .where(
                Ritual.status == "active",
                Ritual.next_due_at.is_not(None),
                Ritual.next_due_at - func.make_interval(0, 0, 0, 0, Ritual.prep_hours) <= now,
            )
            .order_by(Ritual.next_due_at)
            .limit(budget)
            .with_for_update(skip_locked=True)
        )
    )
    for ritual in due:
        assert ritual.next_due_at is not None
        await _create_occurrence(db, ritual, ritual.next_due_at)
        # After an outage, the occurrences the ticker missed are not caught up one by one.
        ritual.next_due_at = next_occurrence(ritual.schedule, max(ritual.next_due_at, now))
        out["created"] += 1
    await db.commit()

    scheduled = list(
        await db.scalars(
            select(RitualOccurrence)
            .where(RitualOccurrence.status == "scheduled")
            .order_by(RitualOccurrence.due_at)
            .limit(budget)
            .with_for_update(skip_locked=True)
        )
    )
    # Ids, not objects: each summary start commits, which expires the session's objects.
    built: list[tuple[uuid.UUID, uuid.UUID]] = []
    for occ in scheduled:
        ritual = await db.get(Ritual, occ.ritual_id)
        assert ritual is not None
        if await _build(db, occ, ritual):
            built.append((occ.id, ritual.id))
            out["ready"] += 1
        elif occ.status == "failed":
            out["failed"] += 1
    await db.commit()
    for occ_id, ritual_id in built:
        await summaries.after_ready(db, occ_id, ritual_id)

    rebuilt = await _alignment_catch_up(db, now)
    await db.commit()
    if rebuilt:
        out["ready"] += 1
        await summaries.after_ready(db, *rebuilt)

    for occ in await db.scalars(
        select(RitualOccurrence).where(
            RitualOccurrence.status == "ready", RitualOccurrence.ends_at + MISSED_AFTER <= now
        )
    ):
        occ.status = "missed"
        out["missed"] += 1
    await db.commit()
    # The weekly alignment report's Slack posts that are due (F6), after its ritual built
    # it: the report goes out on the tick that made it, and failed posts retry here.
    from oracle.reports import slack as report_slack

    await report_slack.deliver_due(db)
    await db.commit()
    return out


# --- rituals -----------------------------------------------------------------------------


async def get_ritual(db: AsyncSession, ritual_id: uuid.UUID, *, lock: bool = False) -> Ritual:
    ritual = await db.get(Ritual, ritual_id, with_for_update=lock or None)
    if ritual is None:
        raise RitualError(404, "No such ritual")
    return ritual


async def _last_pre_read(db: AsyncSession, ritual_id: uuid.UUID) -> OccurrenceSummary | None:
    occ = await db.scalar(
        select(RitualOccurrence)
        .where(RitualOccurrence.ritual_id == ritual_id,
               RitualOccurrence.pre_read_built_at.is_not(None))
        .order_by(RitualOccurrence.due_at.desc())
        .limit(1)
    )  # fmt: skip
    return _summary(occ) if occ is not None else None


async def ritual_out(db: AsyncSession, r: Ritual) -> RitualOut:
    from oracle.metrics.activate import replaced_by

    return RitualOut(
        id=r.id, kind=r.kind, title=r.title, builtin=r.builtin, schedule=r.schedule,
        duration_min=r.duration_min, prep_hours=r.prep_hours, owner_id=r.owner_id,
        attendee_ids=list(r.attendee_ids), status=r.status,  # type: ignore[arg-type]
        next_due_at=r.next_due_at, lock_version=r.lock_version,
        last_pre_read=await _last_pre_read(db, r.id),
        replaced_by=await replaced_by(db, r),
    )  # fmt: skip


async def list_rituals(db: AsyncSession) -> list[Ritual]:
    rows = await db.scalars(select(Ritual).order_by(Ritual.builtin.desc(), Ritual.created_at))
    return [r for r in rows if r.kind == "custom" or available(KINDS[r.kind])]


async def _check_members(db: AsyncSession, ids: list[uuid.UUID], field: str) -> None:
    members = {u.id for u in await _active_users(db)}
    strangers = [str(i) for i in ids if i not in members]
    if strangers:
        raise RitualError(422, f"{field}: not members of this company: {', '.join(strangers)}")


async def create(db: AsyncSession, principal: Principal, body: RitualCreate) -> Ritual:
    kind = KINDS.get(body.kind)
    if kind is None or not available(kind):
        raise RitualError(422, f"kind: unknown ritual kind {body.kind!r}")
    builtin = body.kind != "custom"
    if builtin and await db.scalar(
        select(Ritual.id).where(Ritual.kind == body.kind, Ritual.builtin)
    ):
        raise RitualError(409, f"This company already has the {kind.title}")
    owner_id = body.owner_id or principal.id
    await _check_members(db, [owner_id], "owner_id")
    await _check_members(db, body.attendee_ids, "attendee_ids")
    zone = await company_timezone(db)
    schedule = (
        body.schedule.in_zone(zone)
        if body.schedule
        else Schedule(**{**kind.default_schedule, "timezone": zone})
    )
    ritual = Ritual(
        kind=body.kind, title=body.title, builtin=builtin, schedule=schedule.model_dump(),
        duration_min=body.duration_min or kind.duration_min,
        prep_hours=kind.prep_hours if body.prep_hours is None else body.prep_hours,
        owner_id=owner_id, attendee_ids=body.attendee_ids, status="active",
        next_due_at=next_occurrence(schedule, clock.now()), created_by=principal.id,
    )  # fmt: skip
    db.add(ritual)
    await db.flush()
    await audit.record(db, principal, "ritual.created", "ritual", ritual.id, {"kind": body.kind})
    await db.commit()
    return ritual


async def update(
    db: AsyncSession, principal: Principal, ritual_id: uuid.UUID, body: RitualPatch
) -> Ritual:
    ritual = await get_ritual(db, ritual_id, lock=True)
    if body.lock_version != ritual.lock_version:
        raise RitualError(409, "This ritual changed since you loaded it; reload and try again")
    changed = body.model_dump(exclude_unset=True, exclude={"lock_version"})
    if body.owner_id is not None:
        await _check_members(db, [body.owner_id], "owner_id")
        ritual.owner_id = body.owner_id
    if body.attendee_ids is not None:
        await _check_members(db, body.attendee_ids, "attendee_ids")
        if list(body.attendee_ids) != list(ritual.attendee_ids or []):
            ritual.attendees_edited_at = clock.now()
        ritual.attendee_ids = body.attendee_ids
    if body.title is not None:
        ritual.title = body.title
    if body.duration_min is not None:
        ritual.duration_min = body.duration_min
    if body.prep_hours is not None:
        ritual.prep_hours = body.prep_hours
    if body.schedule is not None:
        if ritual.kind == "alignment_report" and ritual.builtin:
            await _store_alignment_schedule(db, principal, body.schedule)
        schedule = body.schedule.in_zone(await company_timezone(db))
        ritual.schedule = schedule.model_dump()
        if ritual.status == "active":
            ritual.next_due_at = next_occurrence(schedule, clock.now())
    ritual.lock_version += 1
    await audit.record(
        db, principal, "ritual.updated", "ritual", ritual.id, {"fields": sorted(changed)}
    )
    await db.commit()
    return ritual


async def set_status(
    db: AsyncSession, principal: Principal, ritual_id: uuid.UUID, status: str
) -> Ritual:
    ritual = await get_ritual(db, ritual_id, lock=True)
    if ritual.status != status:
        ritual.status = status
        ritual.next_due_at = None
        if status == "active":
            ritual.next_due_at = (
                _first_alignment_due(Schedule(**ritual.schedule), clock.now())
                if ritual.kind == "alignment_report" and ritual.builtin
                else next_occurrence(ritual.schedule, clock.now())
            )
        ritual.lock_version += 1
        if status == "paused":
            # A paused ritual's failed preparation leaves the owners' Inbox.
            for occ in await db.scalars(
                select(RitualOccurrence).where(
                    RitualOccurrence.ritual_id == ritual.id, RitualOccurrence.status == "failed"
                )
            ):
                occ.status = "skipped"
                occ.skip_reason = "The ritual was paused"
        await audit.record(db, principal, f"ritual.{'resumed' if status == 'active' else 'paused'}",
                           "ritual", ritual.id)  # fmt: skip
        await db.commit()
    return ritual


async def delete(db: AsyncSession, principal: Principal, ritual_id: uuid.UUID) -> None:
    ritual = await get_ritual(db, ritual_id, lock=True)
    if ritual.builtin:
        raise RitualError(409, BUILTIN_DELETE)
    await audit.record(
        db, principal, "ritual.deleted", "ritual", ritual.id, {"title": ritual.title}
    )
    await db.delete(ritual)
    await db.commit()


async def prepare(db: AsyncSession, principal: Principal, ritual_id: uuid.UUID) -> RitualOccurrence:
    """Prepare now: retry the ritual's failed (or still scheduled) occurrence, else
    create the next one and build its pre-read at once."""
    from oracle.rituals import summaries

    ritual = await get_ritual(db, ritual_id, lock=True)
    occ = await db.scalar(
        select(RitualOccurrence)
        .where(
            RitualOccurrence.ritual_id == ritual.id,
            RitualOccurrence.status.in_(("failed", "scheduled")),
        )
        .order_by(RitualOccurrence.due_at.desc())
        .limit(1)
    )
    if occ is None:
        due = ritual.next_due_at or next_occurrence(ritual.schedule, clock.now())
        occ_id = await _create_occurrence(db, ritual, due)
        if ritual.status == "active":
            ritual.next_due_at = next_occurrence(ritual.schedule, due)
        occ = await db.get(RitualOccurrence, occ_id)
        assert occ is not None
    occ.status, occ.attempts = "scheduled", 0
    built = await _build(db, occ, ritual)
    await audit.record(db, principal, "ritual.prepared", "ritual_occurrence", occ.id)
    await db.commit()
    if built:
        await summaries.after_ready(db, occ.id, ritual.id)
    return occ


# --- occurrences -------------------------------------------------------------------------


def _summary(o: RitualOccurrence) -> OccurrenceSummary:
    return OccurrenceSummary(id=o.id, ritual_id=o.ritual_id, due_at=o.due_at, ends_at=o.ends_at,
                             status=o.status)  # type: ignore[arg-type]  # fmt: skip


async def list_occurrences(
    db: AsyncSession, ritual_id: uuid.UUID, limit: int
) -> list[OccurrenceSummary]:
    await get_ritual(db, ritual_id)
    rows = await db.scalars(
        select(RitualOccurrence)
        .where(RitualOccurrence.ritual_id == ritual_id)
        .order_by(RitualOccurrence.due_at.desc())
        .limit(limit)
    )
    return [_summary(o) for o in rows]


async def get_occurrence(
    db: AsyncSession, occ_id: uuid.UUID, *, lock: bool = False
) -> tuple[RitualOccurrence, Ritual]:
    occ = await db.get(RitualOccurrence, occ_id, with_for_update=lock or None)
    if occ is None:
        raise RitualError(404, "No such ritual occurrence")
    ritual = await db.get(Ritual, occ.ritual_id)
    assert ritual is not None
    return occ, ritual


async def occurrence_out(
    db: AsyncSession, principal: Principal, occ: RitualOccurrence, ritual: Ritual
) -> OccurrenceOut:
    from oracle.rituals import summaries

    await summaries.sync_state(db, occ)
    read = await db.scalar(
        select(RitualRead.id).where(
            RitualRead.occurrence_id == occ.id, RitualRead.user_id == principal.id
        )
    )
    as_member = _as_member(principal)
    shown, _md, dropped = await pre_read_view(db, occ, ritual, as_member=as_member)
    hidden = await visibility.hidden_decision_ids(db, occ.decision_ids, as_member=as_member)
    summary, state, note = occ.summary, occ.summary_state, occ.summary_note
    if summary and (
        (dropped and not await summaries.member_view(db, occ.summary_run_id))
        or await _names_hidden(db, summary)
    ):
        # Written before runs read the member view (its text may name a dropped row), or
        # naming a decision or a document the reader may not see: one a run read with its
        # creator's role before #541 part 4, or one made approvers-only since.
        summary, state, note = None, "none", None
    pre = occ.pre_read or {}
    return OccurrenceOut(
        id=occ.id, ritual_id=ritual.id, kind=ritual.kind, title=ritual.title, due_at=occ.due_at,
        ends_at=occ.ends_at, duration_min=ritual.duration_min, owner_id=ritual.owner_id,
        attendee_ids=list(ritual.attendee_ids),
        timezone=ritual.schedule.get("timezone", DEFAULT_ZONE),
        status=occ.status,  # type: ignore[arg-type]
        period=Period(from_=occ.period_from, to=occ.period_to),
        pre_read=PreRead(built_at=pre.get("built_at"), blocks=shown),
        attempts=occ.attempts, error=occ.error, notes=occ.notes, skip_reason=occ.skip_reason,
        decision_ids=[i for i in occ.decision_ids if i not in hidden],
        summary_run_id=occ.summary_run_id, summary=summary,
        summary_state=state,  # type: ignore[arg-type]
        summary_note=note, read_by_me=read is not None,
        summary_offered=await summaries.offered(db, ritual.kind),
        decisions=[
            OccurrenceDecision(id=d.id, number=d.number, title=d.title,
                               href=f"/company/decisions?d={d.number}")
            for d in await _decisions_of(db, occ)
        ],
    )  # fmt: skip


async def _decisions_of(db: AsyncSession, occ: RitualOccurrence, extra=()) -> list[Any]:
    """The decisions recorded with ``occ``: those it names (and ``extra``), and those
    whose subject it is (Record decision), in number order."""
    from oracle.decisions.models import Decision

    subject = Decision.subjects.contains([{"kind": "ritual_occurrence", "id": str(occ.id)}])
    named = [*occ.decision_ids, *extra]
    where = or_(subject, Decision.id.in_(named)) if named else subject
    return list(await db.scalars(select(Decision).where(where).order_by(Decision.number)))


async def _names_hidden(db: AsyncSession, text: str) -> bool:
    hidden = await visibility.hidden_for_reader(db)
    return hidden is not None and hidden.names(text)


def _as_member(principal: Principal) -> bool:
    """A run reads a pre-read as a commenter would, whoever started it: what it writes
    from one (a summary, a digest) is shown to every member."""
    return principal.is_run


async def pre_read_view(
    db: AsyncSession, occ: RitualOccurrence, ritual: Ritual, *, as_member: bool = False
) -> tuple[list[dict[str, Any]], str | None, bool]:
    """The stored pre-read as the session's principal (``as_member``: a commenter) may
    see it: (its blocks, its markdown, whether rows were dropped). The markdown is the
    stored one unless a row was dropped; then it is rendered again from what is left."""
    pre = occ.pre_read or {}
    built = pre.get("blocks") or []
    kept = await blocks.for_reader(db, built, as_member=as_member)
    if kept is None:
        md = pre.get("markdown")
        return built, str(md) if md else None, False
    zone = await company_time.company_time_zone(db)
    return kept, blocks.markdown(ritual.title, occ.due_at, kept, zone), True


async def pre_read_markdown(
    db: AsyncSession, principal: Principal, occ: RitualOccurrence, ritual: Ritual
) -> str:
    _blocks, md, _dropped = await pre_read_view(db, occ, ritual, as_member=_as_member(principal))
    if md:
        return md
    return f"# {ritual.title}\n\nThe pre-read is not ready yet.\n"


async def mark_read(db: AsyncSession, principal: Principal, occ_id: uuid.UUID) -> None:
    await get_occurrence(db, occ_id)
    await db.execute(
        insert(RitualRead)
        .values(id=uuid.uuid4(), tenant_id=current_tenant(db), occurrence_id=occ_id,
                user_id=principal.id)
        .on_conflict_do_nothing(index_elements=["occurrence_id", "user_id"])
    )  # fmt: skip
    await db.commit()


def _owner_only(principal: Principal, ritual: Ritual) -> None:
    if principal.id != ritual.owner_id:
        raise RitualError(403, "Only the ritual's owner records it")


def _recordable(occ: RitualOccurrence) -> None:
    if occ.status not in ("ready", "missed"):
        raise RitualError(409, f"This occurrence is {occ.status}")


def _by_a_meeting(occ: RitualOccurrence) -> bool:
    """Held when its Simple review meeting ended (oracle.simple.meetings.end), with nothing
    recorded on it yet: the owner still records the notes and decisions."""
    return occ.status == "held" and not occ.notes and not occ.decision_ids


async def hold(db: AsyncSession, principal: Principal, occ_id: uuid.UUID, body: HeldIn):
    occ, ritual = await get_occurrence(db, occ_id, lock=True)
    _owner_only(principal, ritual)
    held_by_meeting = _by_a_meeting(occ)
    if not held_by_meeting:
        _recordable(occ)
    decisions = await _decisions_of(db, occ, body.decision_ids)
    unknown = set(body.decision_ids) - {d.id for d in decisions}
    if unknown:
        raise RitualError(422, f"decision_ids: no such decision: {', '.join(map(str, unknown))}")
    occ.status, occ.notes = "held", body.notes or None
    occ.decision_ids = [d.id for d in decisions]
    if held_by_meeting:
        await audit.record(db, principal, "ritual.recorded", "ritual_occurrence", occ.id)
    else:
        occ.held_by, occ.held_at = principal.id, clock.now()
        await audit.record(db, principal, "ritual.held", "ritual_occurrence", occ.id)
    await db.commit()
    return occ, ritual


async def skip(db: AsyncSession, principal: Principal, occ_id: uuid.UUID, reason: str):
    occ, ritual = await get_occurrence(db, occ_id, lock=True)
    _owner_only(principal, ritual)
    _recordable(occ)
    occ.status, occ.skip_reason = "skipped", reason
    await audit.record(db, principal, "ritual.skipped", "ritual_occurrence", occ.id,
                       {"reason": reason})  # fmt: skip
    await db.commit()
    return occ, ritual


# --- the Inbox ---------------------------------------------------------------------------


async def inbox_rows(db: AsyncSession, principal: Principal) -> list[InboxRitual]:
    """The caller's ritual rows: Pre-read ready while ready and before the end (owner and
    attendees; done once opened), Record notes after the end (the ritual's owner), and
    Ritual failed to prepare (owners, while the ritual is active)."""
    me = principal.id
    now = clock.now()
    rows: list[InboxRitual] = []
    pairs = (
        await db.execute(
            select(RitualOccurrence, Ritual)
            .join(Ritual, Ritual.id == RitualOccurrence.ritual_id)
            .where(RitualOccurrence.status.in_(("ready", "failed")))
            .order_by(RitualOccurrence.due_at)
        )
    ).all()
    if not pairs:
        return rows
    read = set(
        await db.scalars(
            select(RitualRead.occurrence_id).where(
                RitualRead.user_id == me,
                RitualRead.occurrence_id.in_([o.id for o, _ in pairs]),
            )
        )
    )

    def row(o: RitualOccurrence, r: Ritual, reason: str, state: str, counts: bool) -> InboxRitual:
        return InboxRitual(occurrence_id=o.id, ritual_id=r.id, title=r.title, due_at=o.due_at,
                           reason=reason, state=state, counts=counts)  # type: ignore[arg-type]  # fmt: skip

    for o, r in pairs:
        if r.kind == "alignment_report" and o.status != "failed":
            # The report has its own Inbox row (oracle.reports.service); no meeting to note.
            continue
        if o.status == "failed":
            if r.status == "active" and has_role(principal.role, "owner"):
                rows.append(row(o, r, "failed", "open", True))
        elif now < o.ends_at:
            if me == r.owner_id or me in (r.attendee_ids or []):
                done = o.id in read
                rows.append(row(o, r, "pre_read", "done" if done else "new", not done))
        elif me == r.owner_id:
            rows.append(row(o, r, "record_notes", "open", True))
    return rows


def raise_for(e: RitualError) -> Any:
    from fastapi import HTTPException

    return HTTPException(e.status, e.message)
