"""How many Fireflies calls a connection may make, shared by the picker and live reads.

Both count in ``browse_calls`` (oracle.connections.browse.reserve): the Fireflies picker
(oracle.sources.fireflies_browse) as ``browse``, live reads (#710) as ``live``.

- The picker: 10 a minute and 25 a day on Fireflies' own hosts (the lower Fireflies
  plans allow 50 API calls a day), 60 and 1,000 on another host. On ``api.fireflies.ai``
  it counts every kind (one Fireflies quota); on every other host only its own
  (``browse``) calls, so live reads never block it (BGD, after #717's review).
- Live reads (BGD, 2026-10-26): on ``api.fireflies.ai`` they share the picker's 10 a
  minute and 25 a day (every kind counts, one Fireflies quota); on another host (the
  archive key allows 1,500 a minute) 120 a minute and 3,000 a day of live calls.
"""

import math
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from oracle.connections import browse

LIVE = "live"
MINUTE = timedelta(minutes=1)
DAY = timedelta(days=1)

# (window, limit, what the window is called: "minute" or "day").
Windows = tuple[tuple[timedelta, int, str], ...]

PICKER_CALLS_PER_MINUTE = 10
PICKER_CALLS_PER_DAY = 25
PICKER_OTHER_HOST_CALLS_PER_MINUTE = 60
PICKER_OTHER_HOST_CALLS_PER_DAY = 1000
LIVE_OTHER_HOST_CALLS_PER_MINUTE = 120
LIVE_OTHER_HOST_CALLS_PER_DAY = 3000

LIVE_API_WINDOWS: Windows = (
    (MINUTE, PICKER_CALLS_PER_MINUTE, "minute"),
    (DAY, PICKER_CALLS_PER_DAY, "day"),
)
LIVE_OTHER_HOST_WINDOWS: Windows = (
    (MINUTE, LIVE_OTHER_HOST_CALLS_PER_MINUTE, "minute"),
    (DAY, LIVE_OTHER_HOST_CALLS_PER_DAY, "day"),
)


@dataclass(frozen=True)
class Refusal:
    seconds: int
    limit: int
    per: str  # "minute" | "day"


def later(seconds: int) -> str:
    """A wait in words: "40 seconds", "5 minutes", "3 hours"."""
    if seconds < 120:
        return f"{seconds} seconds"
    if seconds < 7200:
        return f"{math.ceil(seconds / 60)} minutes"
    return f"{math.ceil(seconds / 3600)} hours"


async def spend(
    db: AsyncSession,
    connection_id: uuid.UUID,
    calls: int,
    windows: Windows,
    now: datetime,
    *,
    kind: str = "browse",
    counted: tuple[str, ...] | None = None,
) -> Refusal | None:
    """Reserve ``calls`` for the connection as ``kind``: None when reserved, else which
    window refused them and when they fit. ``counted``: the kinds the windows count
    (None: all). Commits."""
    refused = await browse.reserve(
        db,
        connection_id,
        calls,
        tuple((window, limit) for window, limit, _ in windows),
        now,
        kind=kind,
        counted=counted,
    )
    if refused is None:
        return None
    seconds, index = refused
    _, limit, per = windows[index]
    return Refusal(seconds=seconds, limit=limit, per=per)


BROWSE = "browse"


def picker_counted(api_host: bool) -> tuple[str, ...] | None:
    """The kinds the picker's windows count: every kind on api.fireflies.ai, else only
    the picker's own calls."""
    return None if api_host else (BROWSE,)


def live_windows(api_host: bool) -> tuple[Windows, tuple[str, ...] | None]:
    """A live read's windows and the kinds they count: on api.fireflies.ai the picker's,
    counting every kind; elsewhere the live ones, counting live calls."""
    if api_host:
        return LIVE_API_WINDOWS, None
    return LIVE_OTHER_HOST_WINDOWS, (LIVE,)
