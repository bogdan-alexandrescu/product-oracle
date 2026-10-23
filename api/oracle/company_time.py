"""The company's time zone, and a moment in it as a person reads it.

The company's zone is the Company time zone (Settings › Company, ``company_timezone``),
which the weekly alignment report also runs in.
Times a person reads are worded, "Sun Oct 25, 2:59 PM PDT", never ISO.
"""

import logging
from datetime import datetime
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


def in_words(moment: datetime, zone: str = DEFAULT_ZONE) -> str:
    """``moment`` in ``zone`` as "Sun Oct 25, 2:59 PM PDT"."""
    try:
        tz = ZoneInfo(zone)
    except (ValueError, ZoneInfoNotFoundError):
        tz = ZoneInfo(DEFAULT_ZONE)
    local = moment.astimezone(tz)
    hour = local.hour % 12 or 12
    return (
        f"{local:%a %b} {local.day}, {hour}:{local:%M} {'AM' if local.hour < 12 else 'PM'} "
        f"{local.tzname()}"
    )
