"""The company's time zone, and a moment in it as a person reads it.

The company's zone is the Company time zone (Settings › Company, ``company_timezone``),
which the weekly alignment report also runs in.
Times a person reads are worded, "Sun Oct 25, 2:59 PM PDT", never ISO; days, "Oct 25"
(#463). Text the API writes for a person names its days and times through these
helpers; machine fields (ISO timestamps, ids) stay UTC.
"""

import logging
from datetime import UTC, date, datetime, time
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy.ext.asyncio import AsyncSession

log = logging.getLogger(__name__)

DEFAULT_ZONE = "America/Los_Angeles"


async def company_time_zone(db: AsyncSession) -> str:
    """The Company time zone (read through the alignment report's settings, which carry
    it); the default when it cannot be read."""
    from oracle.reports.alignment import load_settings

    try:
        return (await load_settings(db)).timezone
    except Exception:
        log.exception("could not read the company's time zone; using the default")
        return DEFAULT_ZONE


def _local(moment: datetime | str, zone: str) -> datetime:
    """``moment`` (an ISO string too; naive reads as UTC) in ``zone``, else the default."""
    if isinstance(moment, str):
        moment = datetime.fromisoformat(moment)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    try:
        tz = ZoneInfo(zone)
    except (ValueError, ZoneInfoNotFoundError):
        tz = ZoneInfo(DEFAULT_ZONE)
    return moment.astimezone(tz)


def day(moment: datetime | str, zone: str = DEFAULT_ZONE) -> date:
    """The company's day at ``moment``."""
    return _local(moment, zone).date()


def now() -> datetime:
    """The moment now, in UTC (tests move it)."""
    return datetime.now(UTC)


def today(zone: str = DEFAULT_ZONE) -> date:
    """The company's day now in ``zone``: day logic ("due today", "review is due") reads
    this, never the server's day (a day ahead of Pacific from 5 PM)."""
    return day(now(), zone)


async def company_today(db: AsyncSession) -> date:
    """The company's day now, in the Company time zone."""
    return today(await company_time_zone(db))


def day_start(on: date, zone: str = DEFAULT_ZONE) -> datetime:
    """The moment the company's day ``on`` starts in ``zone``, in UTC."""
    local = datetime.combine(on, time.min, tzinfo=_local(now(), zone).tzinfo)
    return local.astimezone(UTC)


def day_in_words(moment: datetime | str, zone: str = DEFAULT_ZONE) -> str:
    """The company's day at ``moment`` as "Oct 25"."""
    local = _local(moment, zone)
    return f"{local:%b} {local.day}"


def date_in_words(on: date) -> str:
    """A calendar day (already the company's) as "Fri Nov 6" (prd-questions' due days)."""
    return f"{on:%a} {on:%b} {on.day}"


def day_first_in_words(moment: datetime | str, zone: str = DEFAULT_ZONE) -> str:
    """The company's day at ``moment`` as "25 Oct"."""
    local = _local(moment, zone)
    return f"{local.day} {local:%b}"


def stamp(moment: datetime | str, zone: str = DEFAULT_ZONE) -> str:
    """``moment`` in ``zone`` as "2026-10-25 14:59 PDT" (exports, pre-reads)."""
    local = _local(moment, zone)
    return f"{local:%Y-%m-%d %H:%M} {local.tzname()}"


def in_words(moment: datetime, zone: str = DEFAULT_ZONE) -> str:
    """``moment`` in ``zone`` as "Sun Oct 25, 2:59 PM PDT"."""
    local = _local(moment, zone)
    hour = local.hour % 12 or 12
    return (
        f"{local:%a %b} {local.day}, {hour}:{local:%M} {'AM' if local.hour < 12 else 'PM'} "
        f"{local.tzname()}"
    )
