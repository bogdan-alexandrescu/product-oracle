"""Simple S2 (#723): Oracle's date suggestions for undated roadmap items. Deterministic: no
model call (oracle.simple.dates.suggest has the rule).

- :func:`regenerate`: every undated item of the company-wide roadmap (read as Oracle)
  gets one open suggestion, replaced when the rule now gives other dates; an item no
  longer undated loses its open one; after a person dismisses one, the item is offered
  nothing for 30 days, and never the dismissed dates again.
- :func:`daily`: :func:`regenerate` once a company day, from the minute tick
  (oracle.ticker.body); the last day it ran is the internal company setting
  :data:`DAY_SETTING`.
- :func:`accept`: accept or edit (D-b) through the change engine
  (oracle.simple.changes, op ``accept_date_suggestion``): a change row, the ``before``
  check (the undated item the suggestion was made for: 409 ``outdated`` otherwise), undo,
  and the review policy (a non-decider's is a proposal); the dates go into the roadmap's
  working draft, never the published version.
- :func:`decide`: dismiss. Who may: oracle.simple.service.can_decide.
"""

import uuid
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, company_time
from oracle.docs import visibility
from oracle.roadmap.models import RoadmapItem
from oracle.simple import dates, service
from oracle.simple.models import RoadmapDateSuggestion
from oracle.tenancy import current_tenant
from oracle.tenant_settings import TenantSetting

# ``{"day": "YYYY-MM-DD"}``: the company day the suggestions were last regenerated on.
DAY_SETTING = "simple_date_suggestions"
# A dismissed suggestion's item is offered nothing new for this long (and never the same
# dates again).
DISMISSED_QUIET = timedelta(days=30)
# A failed daily run's next try.
RETRY_AFTER = timedelta(hours=1)


class SuggestionError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


async def regenerate(db: AsyncSession) -> int:
    """Regenerate the open suggestions (the caller commits); how many are open after.
    One regeneration at a time per company: two crossing refreshes never meet on the open
    suggestion's unique index (the second reads what the first committed)."""
    await db.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:k, 0))"),
        {"k": f"simple_date_suggestions:{current_tenant(db)}"},
    )
    principal = visibility.principal_of(db)
    visibility.bind(db, None)
    try:
        read = await service.load(db)
    finally:
        visibility.bind(db, principal)
    entries = read.entries
    durations: dict[str | None, list[int]] = defaultdict(list)
    for e in entries:
        if not e.resolved.start.estimated and not e.resolved.end.estimated:
            durations[e.row.confidence].append(e.resolved.days)
    by_id = read.by_id()
    ids = [e.row.id for e in entries]
    existing: dict[uuid.UUID, list[RoadmapDateSuggestion]] = defaultdict(list)
    if ids:
        for s in await db.scalars(
            select(RoadmapDateSuggestion).where(
                RoadmapDateSuggestion.item_id.in_(ids),
                RoadmapDateSuggestion.status.in_(("open", "dismissed")),
            )
        ):
            existing[s.item_id].append(s)
    now = company_time.now()
    count = 0
    for e in entries:
        rows = existing.get(e.row.id, [])
        current = next((s for s in rows if s.status == "open"), None)
        if not e.resolved.undated or e.status in ("cut", "done"):
            if current is not None:
                await db.delete(current)
            continue
        deps = [(by_id[d].row.title, by_id[d].resolved.end.date) for d in e.depends_on]
        s = dates.suggest(e.window, deps, durations.get(e.row.confidence, []),
                          e.row.confidence, e.row.horizon)  # fmt: skip
        if any(
            r.status == "dismissed"
            and ((r.start_date, r.end_date) == (s.start, s.end) or _recent(r, now))
            for r in rows
        ):
            if current is not None:
                await db.delete(current)
            continue
        count += 1
        if current is not None:
            if (current.start_date, current.end_date, current.basis) != (s.start, s.end, s.basis):
                current.start_date, current.end_date, current.basis = s.start, s.end, s.basis
                current.created_at = now
            continue
        db.add(RoadmapDateSuggestion(item_id=e.row.id, start_date=s.start, end_date=s.end,
                                     basis=s.basis, status="open", created_at=now))  # fmt: skip
    await db.flush()
    return count


async def daily(db: AsyncSession) -> bool:
    """Regenerate once a company day (the caller commits); whether it ran. After a failed
    run (:func:`failed`) the next try waits for ``retry_at``."""
    today = (await company_time.company_today(db)).isoformat()
    row = await db.scalar(select(TenantSetting).where(TenantSetting.key == DAY_SETTING))
    value = row.value if row is not None and isinstance(row.value, dict) else {}
    if value.get("day") == today:
        return False
    retry = value.get("retry_at")
    if retry and company_time.now() < datetime.fromisoformat(retry):
        return False
    await regenerate(db)
    if row is None:
        db.add(TenantSetting(key=DAY_SETTING, value={"day": today}))
    else:
        row.value = {"day": today}
    await db.flush()
    return True


async def failed(db: AsyncSession) -> None:
    """A daily run failed (S2-minor: never a retry every minute tick, each reloading the
    whole roadmap): the next try is an hour later; a second failure that day waits for the
    next day's run (the caller commits)."""
    today = (await company_time.company_today(db)).isoformat()
    row = await db.scalar(select(TenantSetting).where(TenantSetting.key == DAY_SETTING))
    value = dict(row.value) if row is not None and isinstance(row.value, dict) else {}
    if value.get("failed_day") == today:
        value.pop("retry_at", None)
        value["day"] = today
    else:
        value["failed_day"] = today
        value["retry_at"] = (company_time.now() + RETRY_AFTER).isoformat()
    if row is None:
        db.add(TenantSetting(key=DAY_SETTING, value=value))
    else:
        row.value = value
    await db.flush()


async def visible(
    db: AsyncSession, principal: Any
) -> list[tuple[RoadmapDateSuggestion, service.Entry, bool]]:
    """The suggestions of the items the reader may see, with their item's entry."""
    read = await service.load(db)
    out = []
    by_id = read.by_id()
    rows = await db.scalars(
        select(RoadmapDateSuggestion).order_by(RoadmapDateSuggestion.created_at.desc())
    )
    for s in rows:
        e = by_id.get(s.item_id)
        if e is not None:
            out.append((s, e, service.can_decide(principal, e, read.deciders)))
    return out


async def accept(
    db: AsyncSession, principal: Any, suggestion_id: uuid.UUID, start: Any = None, end: Any = None
) -> Any:
    """Accept (or, with dates, edit) one suggestion as a change (commits)."""
    from oracle.simple import changes
    from oracle.simple.schemas import SimpleChangeIn

    s = await db.get(RoadmapDateSuggestion, suggestion_id)
    if s is None:
        raise SuggestionError(404, "No such date suggestion")
    after = (
        {"start_date": _iso(start), "end_date": _iso(end)}
        if start is not None or end is not None
        else {}
    )
    body = SimpleChangeIn(
        op="accept_date_suggestion",
        target={"item_id": str(s.item_id), "suggestion_id": str(s.id)},
        before={"start_date": None, "end_date": None},
        after=after,
    )
    return await changes.create(db, principal, body)


async def decide(
    db: AsyncSession, principal: Any, suggestion_id: uuid.UUID, action: str
) -> tuple[RoadmapDateSuggestion, RoadmapItem, bool]:
    """Dismiss one suggestion (commits); accept and edit are :func:`accept`'s."""
    read = await service.load(db)
    s = await db.get(RoadmapDateSuggestion, suggestion_id, with_for_update=True)
    entry = read.by_id().get(s.item_id) if s is not None else None
    if s is None or entry is None:
        raise SuggestionError(404, "No such date suggestion")
    if not service.can_decide(principal, entry, read.deciders):
        raise SuggestionError(
            403,
            "Only an owner or the roadmap's decider (with no decider, its owner) decides "
            "date suggestions",
        )
    if s.status != "open":
        raise SuggestionError(409, f"This suggestion is {s.status} already")
    if action != "dismiss":
        raise SuggestionError(422, "Accept and edit go through the change engine")
    item = entry.row
    s.status = "dismissed"
    s.decided_by = getattr(principal, "user_id", None) or getattr(principal, "id", None)
    s.decided_at = company_time.now()
    await audit.record(
        db, principal, "roadmap_date_suggestion.dismiss", "roadmap_date_suggestion", s.id,
        data={"item_id": str(item.id), "start_date": _iso(s.start_date),
              "end_date": _iso(s.end_date)},
    )  # fmt: skip
    await db.commit()
    await db.refresh(s)
    return s, item, True


def _recent(s: RoadmapDateSuggestion, now: datetime) -> bool:
    return s.decided_at is not None and now - s.decided_at < DISMISSED_QUIET


def _iso(d: Any) -> str | None:
    return d.isoformat() if d is not None else None
