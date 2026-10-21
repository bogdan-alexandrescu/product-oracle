"""The one ship-signal rule (H6 Launches; H3 Predicted versus actual calls it too).

An item of a track has shipped when:

- every tracker record matched to it (``tracker_records.track_id`` and ``item_key``) is
  ``done``: at the latest ``observed_at`` of those records (kind ``tracker``); or
- every milestone of the track listing it is ``done`` (dropped ones aside, at least one
  done): at the latest milestone ``updated_at`` (kind ``milestone``).

Items with neither signal are not in the answer. Read-only: Oracle never writes to a
tracker (E1).
"""

import uuid
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.roadmap.models import TrackerRecord, TrackMilestone


async def shipped_items(db: AsyncSession, track_id: uuid.UUID) -> dict[str, tuple[str, datetime]]:
    """``{item_key: (kind, at)}`` for the track's items that have shipped."""
    out: dict[str, tuple[str, datetime]] = {}
    records: dict[str, list[TrackerRecord]] = {}
    for r in await db.scalars(
        select(TrackerRecord).where(
            TrackerRecord.track_id == track_id, TrackerRecord.item_key.is_not(None)
        )
    ):
        records.setdefault(r.item_key, []).append(r)  # type: ignore[arg-type]
    for key, rows in records.items():
        if all(r.state == "done" for r in rows):
            out[key] = ("tracker", max(r.observed_at for r in rows))
    milestones: dict[str, list[TrackMilestone]] = {}
    for m in await db.scalars(
        select(TrackMilestone).where(
            TrackMilestone.track_id == track_id, TrackMilestone.status != "dropped"
        )
    ):
        for key in m.item_keys or []:
            milestones.setdefault(key, []).append(m)
    for key, rows in milestones.items():
        if key not in out and rows and all(m.status == "done" for m in rows):
            out[key] = ("milestone", max(m.updated_at for m in rows))
    return out
