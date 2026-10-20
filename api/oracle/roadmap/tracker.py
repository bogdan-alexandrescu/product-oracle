"""Engineering status from a tracker, read-only (E1, §11.1, CR-11).

Oracle reads engineering's state back and compares it with the roadmap; it does not write
to a tracker. Tracker records arrive through ``POST /v1/tracker/records`` (an export, the
CLI, or an agent with read access to the tracker) and are upserted by tracker and issue
key. The read-only alignment report (oracle.roadmap.views) is the path that works without
write permission.

The two-way connector (approved PRD -> epics and issues) stays behind a gate that is off
(``ORACLE_TRACKER_TWO_WAY_ENABLED``). Even on, no connector is verified yet, so a push is
refused (501) and nothing is written: no unattended external writes. ``tracker_plan``
previews what a connector would create, without writing.
"""

import uuid
from datetime import UTC, date, datetime
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.auth.deps import Principal
from oracle.config import get_settings
from oracle.roadmap.models import ProductTrack, RoadmapItem, TrackerRecord
from oracle.roadmap.schemas import (
    DriftEntry,
    TrackerConnectorOut,
    TrackerRecordIn,
    TrackerRecordRef,
)

OFF_REASON = (
    "Two-way tracker sync is off: Oracle makes no tracker writes. "
    "Use the read-only alignment report."
)
UNVERIFIED_REASON = (
    "Two-way tracker sync is switched on, but no tracker connector has been verified "
    "end to end, so Oracle still writes nothing."
)


class TrackerError(Exception):
    status_code = 422


class WritesOff(TrackerError):
    status_code = 409


class NotVerified(TrackerError):
    status_code = 501


def connector() -> TrackerConnectorOut:
    on = get_settings().tracker_two_way_enabled
    return TrackerConnectorOut(
        two_way_enabled=on,
        writes_allowed=False,
        read_only_alignment=True,
        reason=UNVERIFIED_REASON if on else OFF_REASON,
    )


def refuse_push() -> None:
    """Every tracker write is refused: off (409) or on but unverified (501)."""
    if not get_settings().tracker_two_way_enabled:
        raise WritesOff(OFF_REASON)
    raise NotVerified(UNVERIFIED_REASON)


async def import_records(
    db: AsyncSession, principal: Principal, tracker: str, records: list[TrackerRecordIn]
) -> tuple[int, int, list[TrackerRecord]]:
    """Upsert the records (latest state per tracker issue). Track ids must be this
    company's. The caller commits."""
    track_ids = {r.track_id for r in records if r.track_id}
    if track_ids:
        known = set(await db.scalars(select(ProductTrack.id).where(ProductTrack.id.in_(track_ids))))
        if unknown := track_ids - known:
            raise TrackerError(f"unknown track: {', '.join(sorted(map(str, unknown)))}")
    refs = [r.external_ref for r in records]
    if len(set(refs)) != len(refs):
        raise TrackerError("an issue is listed twice")
    # Imports of one tracker run one at a time (the upsert reads, then writes).
    await db.execute(
        text("SELECT pg_advisory_xact_lock(hashtext(:k))"),
        {"k": f"tracker:{principal.tenant_id}:{tracker}"},
    )
    existing = {
        r.external_ref: r
        for r in await db.scalars(
            select(TrackerRecord).where(
                TrackerRecord.tracker == tracker, TrackerRecord.external_ref.in_(refs)
            )
        )
    }
    now = datetime.now(UTC)
    created = updated = 0
    rows = []
    for rec in records:
        values: dict[str, Any] = rec.model_dump()
        values["observed_at"] = rec.observed_at or now
        row = existing.get(rec.external_ref)
        if row is None:
            row = TrackerRecord(tracker=tracker, recorded_by=principal.id, **values)
            db.add(row)
            created += 1
        else:
            for k, v in values.items():
                setattr(row, k, v)
            row.recorded_by = principal.id
            updated += 1
        rows.append(row)
    await db.flush()
    await audit.record(
        db,
        principal,
        "tracker.records_imported",
        "tracker_record",
        None,
        {"tracker": tracker, "created": created, "updated": updated, "refs": refs[:50]},
    )
    return created, updated, rows


def ref(r: TrackerRecord) -> TrackerRecordRef:
    return TrackerRecordRef(
        tracker=r.tracker,  # type: ignore[arg-type]
        external_ref=r.external_ref,
        state=r.state,  # type: ignore[arg-type]
        raw_status=r.raw_status,
        target_date=r.target_date,
        estimate=r.estimate,
        url=r.url,
    )


async def records_for_track(db: AsyncSession, track_id: uuid.UUID | None) -> list[TrackerRecord]:
    if track_id is None:
        return []
    rows = await db.scalars(
        select(TrackerRecord)
        .where(TrackerRecord.track_id == track_id)
        .order_by(TrackerRecord.tracker, TrackerRecord.external_ref)
    )
    return list(rows)


def milestone_date(
    item: RoadmapItem, dated: dict[str, date], milestone: dict[str, Any] | None
) -> date | None:
    """The earliest verified date the item must meet: its own milestone's as re-checked
    now (``milestone``, oracle.roadmap.items.live_milestones), or a dated track
    milestone's that lists it."""
    days = [d for d in (dated.get(item.item_key),) if d is not None]
    own = (milestone or {}).get("date")
    if own:
        try:
            days.append(date.fromisoformat(own))
        except ValueError:
            pass
    return min(days) if days else None


def drift_of(
    item: RoadmapItem, records: list[TrackerRecord], when: date | None, today: date
) -> list[DriftEntry]:
    """How engineering's state differs from the plan for one item (both ways, E1)."""
    out: list[DriftEntry] = []
    if not records:
        return out
    states = {r.state for r in records}
    if item.horizon in ("next", "later") and states & {"in_progress", "done"}:
        out.append(
            DriftEntry(
                kind="ahead",
                item_key=item.item_key,
                detail=f"Engineering has started work planned for {item.horizon}.",
            )
        )
    if states == {"cancelled"}:
        out.append(
            DriftEntry(
                kind="cancelled",
                item_key=item.item_key,
                detail="Every tracker issue for this item is cancelled.",
            )
        )
    if when is not None:
        for r in records:
            if r.state in ("done", "cancelled"):
                continue
            if r.target_date and r.target_date > when:
                out.append(
                    DriftEntry(
                        kind="date_slip",
                        item_key=item.item_key,
                        tracker_ref=r.external_ref,
                        detail=f"{r.external_ref} targets {r.target_date}, after the "
                        f"milestone date {when}.",
                    )
                )
        if when < today and not states <= {"done", "cancelled"}:
            out.append(
                DriftEntry(
                    kind="overdue",
                    item_key=item.item_key,
                    detail=f"The milestone date {when} has passed and the work is not done.",
                )
            )
    return out


def unplanned(records: list[TrackerRecord], keys: set[str]) -> list[DriftEntry]:
    return [
        DriftEntry(
            kind="unplanned",
            tracker_ref=r.external_ref,
            item_key=r.item_key,
            detail=f"{r.external_ref} ({r.title or 'untitled'}) is not on the roadmap.",
        )
        for r in records
        if r.state != "cancelled" and (r.item_key is None or r.item_key not in keys)
    ]
