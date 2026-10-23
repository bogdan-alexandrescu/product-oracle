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
   with summaries on Every pre-read, start its summary run (oracle.rituals.summaries);
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

from sqlalchemy import func, select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.auth.deps import Principal
from oracle.auth.models import User
from oracle.authz import has_role
from oracle.rituals import blocks, clock
from oracle.rituals.kinds import KINDS, available, builtins
from oracle.rituals.models import Ritual, RitualOccurrence, RitualRead
from oracle.rituals.schedule import Schedule, lookback_days, next_occurrence
from oracle.rituals.schemas import (
    HeldIn,
    InboxRitual,
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
    ritual.next_due_at = next_occurrence(schedule, clock.now()) if enabled else None
    ritual.lock_version += 1


async def follow_company_timezone(db: AsyncSession, old: str) -> None:
    """The Company time zone changed from ``old``: every ritual on it takes the new zone
    and its next date in it (a ritual an owner put in another zone keeps it), and the
    alignment report's ritual follows its setting. The caller commits."""
    new = await company_timezone(db)
    rows = await db.scalars(select(Ritual).order_by(Ritual.id).with_for_update())
    for ritual in rows.all():
        if (ritual.kind == "alignment_report" and ritual.builtin) or ritual.schedule.get(
            "timezone"
        ) != old:
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


async def _build(db: AsyncSession, occ: RitualOccurrence, ritual: Ritual) -> bool:
    """Build the occurrence's pre-read in a savepoint: ready, or attempts + 1 (failed
    after :data:`MAX_ATTEMPTS`). Never raises what a builder raises."""
    kind = KINDS.get(ritual.kind, KINDS["custom"])
    now = clock.now()
    ctx = blocks.BlockCtx(
        ritual_owner_id=ritual.owner_id,
        period_from=occ.period_from or occ.due_at - timedelta(days=7),
        period_to=occ.period_to or occ.due_at,
        now=now,
    )
    try:
        async with db.begin_nested():
            built = await blocks.build(db, kind.blocks, ctx)
    except Exception as exc:
        log.warning("rituals: the pre-read of occurrence %s failed: %s", occ.id, exc)
        occ.attempts += 1
        occ.error = f"{type(exc).__name__}: {exc}"[:2000]
        if occ.attempts >= MAX_ATTEMPTS:
            occ.status = "failed"
        return False
    occ.pre_read = {
        "built_at": now.isoformat(),
        "blocks": built,
        "markdown": blocks.markdown(ritual.title, occ.due_at, built),
    }
    occ.pre_read_built_at = now
    occ.status = "ready"
    occ.error = None
    return True


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
    return RitualOut(
        id=r.id, kind=r.kind, title=r.title, builtin=r.builtin, schedule=r.schedule,
        duration_min=r.duration_min, prep_hours=r.prep_hours, owner_id=r.owner_id,
        attendee_ids=list(r.attendee_ids), status=r.status,  # type: ignore[arg-type]
        next_due_at=r.next_due_at, lock_version=r.lock_version,
        last_pre_read=await _last_pre_read(db, r.id),
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
    schedule = body.schedule or Schedule(
        **{**kind.default_schedule, "timezone": await company_timezone(db)}
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
        ritual.attendee_ids = body.attendee_ids
    if body.title is not None:
        ritual.title = body.title
    if body.duration_min is not None:
        ritual.duration_min = body.duration_min
    if body.prep_hours is not None:
        ritual.prep_hours = body.prep_hours
    if body.schedule is not None:
        ritual.schedule = body.schedule.model_dump()
        if ritual.status == "active":
            ritual.next_due_at = next_occurrence(body.schedule, clock.now())
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
        ritual.next_due_at = (
            next_occurrence(ritual.schedule, clock.now()) if status == "active" else None
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
    pre = occ.pre_read or {}
    return OccurrenceOut(
        id=occ.id, ritual_id=ritual.id, kind=ritual.kind, title=ritual.title, due_at=occ.due_at,
        ends_at=occ.ends_at, duration_min=ritual.duration_min, owner_id=ritual.owner_id,
        attendee_ids=list(ritual.attendee_ids), timezone=ritual.schedule.get("timezone", "UTC"),
        status=occ.status,  # type: ignore[arg-type]
        period=Period(from_=occ.period_from, to=occ.period_to),
        pre_read=PreRead(built_at=pre.get("built_at"), blocks=pre.get("blocks") or []),
        attempts=occ.attempts, error=occ.error, notes=occ.notes, skip_reason=occ.skip_reason,
        decision_ids=list(occ.decision_ids), summary_run_id=occ.summary_run_id,
        summary=occ.summary, summary_state=occ.summary_state,  # type: ignore[arg-type]
        summary_note=occ.summary_note, read_by_me=read is not None,
    )  # fmt: skip


def pre_read_markdown(occ: RitualOccurrence, ritual: Ritual) -> str:
    md = (occ.pre_read or {}).get("markdown")
    if md:
        return str(md)
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


async def hold(db: AsyncSession, principal: Principal, occ_id: uuid.UUID, body: HeldIn):
    occ, ritual = await get_occurrence(db, occ_id, lock=True)
    _owner_only(principal, ritual)
    _recordable(occ)
    occ.status, occ.notes = "held", body.notes or None
    occ.decision_ids = body.decision_ids
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
