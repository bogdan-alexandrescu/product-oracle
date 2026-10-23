"""The company's time zone, and a moment in it as a person reads it.

Until Oracle has a Company time zone setting, the company's zone is the one its weekly
alignment report is set up in (Settings > Notifications), as the invite rows show it.
Times a person reads are worded, "Sun Oct 25, 2:59 PM PDT", never ISO.
"""

import logging
from datetime import datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy.ext.asyncio import AsyncSession

log = logging.getLogger(__name__)

DEFAULT_ZONE = "America/Los_Angeles"


async def company_time_zone(db: AsyncSession) -> str:
    """The zone the alignment report uses; the default when it cannot be read."""
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
