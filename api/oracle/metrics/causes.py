"""Possible causes of a variance (H5, deterministic, free): what happened in the 14 days
before the week's end, each linked to its Oracle page, at most 8.

1. launches marked launched whose roadmap items' features support the metric's goal
   (or the goal of the output an input drives), then every other launch;
2. changelog entries published (public and internal);
3. roadmap items whose tracker records turned done (the ``done_items`` rule);
4. decisions decided whose ``entity_ids`` or ``subjects`` include the goal;
5. a change of the metric's definition in that week.
"""

import uuid
from datetime import date, datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import company_time
from oracle.baseline.models import Edge
from oracle.decisions.models import Decision
from oracle.launches import tiers
from oracle.launches.models import ChangelogEntry, Launch
from oracle.metrics.models import Metric
from oracle.roadmap.models import TrackerRecord

MAX_CAUSES = 8
WINDOW = timedelta(days=14)
DEFINITION_CHANGED = "The metric's definition changed"


async def goal_of(db: AsyncSession, metric: Metric) -> uuid.UUID | None:
    """The metric's goal, or the goal of the output an input drives."""
    if metric.goal_id is not None:
        return metric.goal_id
    if metric.drives_metric_id is not None:
        output = await db.get(Metric, metric.drives_metric_id)
        return output.goal_id if output is not None else None
    return None


async def _serves(db: AsyncSession, launch: Launch, goal_id: uuid.UUID | None) -> bool:
    if goal_id is None:
        return False
    for item in await tiers.items_of(db, launch):
        feature = await tiers._feature(db, item)
        if feature is None:
            continue
        found = await db.scalar(
            select(Edge.id).where(
                Edge.src_id == feature.id,
                Edge.dst_id == goal_id,
                Edge.type == "supports",
                Edge.status == "confirmed",
            )
        )
        if found is not None:
            return True
    return False


def _on(moment: datetime, zone: str) -> str:
    return company_time.day(moment, zone).isoformat()


def _subject_ids(decision: Decision) -> set[str]:
    return {str(s.get("id")) for s in decision.subjects or [] if isinstance(s, dict)}


async def possible_causes(
    db: AsyncSession, metric: Metric, week: date, zone: str
) -> list[dict[str, Any]]:
    from oracle.metrics.pull import week_bounds

    week_from, end = week_bounds(week, zone)
    start = end - WINDOW
    goal_id = await goal_of(db, metric)
    out: list[dict[str, Any]] = []

    serving, others = [], []
    for launch in await db.scalars(
        select(Launch)
        .where(Launch.state == "launched", Launch.launched_at >= start, Launch.launched_at < end)
        .order_by(Launch.launched_at, Launch.title)
    ):
        row = {"kind": "launch", "title": launch.title, "on": _on(launch.launched_at, zone),
               "href": f"/roadmap/launches?launch={launch.id}"}  # fmt: skip
        (serving if await _serves(db, launch, goal_id) else others).append(row)
    out += serving + others

    for entry in await db.scalars(
        select(ChangelogEntry)
        .where(
            ChangelogEntry.status == "published",
            ChangelogEntry.published_at >= start,
            ChangelogEntry.published_at < end,
        )
        .order_by(ChangelogEntry.published_at)
    ):
        out.append({"kind": "changelog", "title": entry.title,
                    "on": _on(entry.published_at, zone), "href": "/roadmap/changelog"})  # fmt: skip

    for record in await db.scalars(
        select(TrackerRecord)
        .where(
            TrackerRecord.state == "done",
            TrackerRecord.item_key.is_not(None),
            TrackerRecord.observed_at >= start,
            TrackerRecord.observed_at < end,
        )
        .order_by(TrackerRecord.observed_at)
    ):
        out.append({
            "kind": "roadmap_item", "title": record.title or record.external_ref,
            "on": _on(record.observed_at, zone),
            "href": f"/roadmap?track={record.track_id}" if record.track_id else "/roadmap",
        })  # fmt: skip

    if goal_id is not None:
        for decision in await db.scalars(
            select(Decision)
            .where(
                Decision.status == "decided",
                Decision.decided_at >= start,
                Decision.decided_at < end,
            )
            .order_by(Decision.decided_at)
        ):
            if goal_id in (decision.entity_ids or []) or str(goal_id) in _subject_ids(decision):
                out.append({"kind": "decision", "title": decision.title,
                            "on": _on(decision.decided_at, zone),
                            "href": f"/company/decisions?d={decision.number}"})  # fmt: skip

    changed = []
    for d in metric.definitions or []:
        at = d.get("at")
        if d.get("version", 1) <= 1 or not at:
            continue
        moment = datetime.fromisoformat(at)
        if week_from <= moment < end:
            changed.append({"kind": "definition", "title": DEFINITION_CHANGED,
                        "on": _on(moment, zone),
                        "href": f"/company/metrics?metric={metric.id}"})  # fmt: skip
    # A definition change is kept whatever else happened that fortnight.
    return out[: MAX_CAUSES - len(changed[:1])] + changed[:1]
