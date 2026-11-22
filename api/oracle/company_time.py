"""The company's time zone, and a moment in it as a person reads it.

The company's zone is the Company time zone (Settings › Company, ``company_timezone``),
which the weekly alignment report also runs in.
Times a person reads are worded, "Sun Oct 25, 2:59 PM PDT", never ISO; days, "Oct 25"
(#463). Text the API writes for a person names its days and times through these
helpers; machine fields (ISO timestamps, ids) stay UTC.

The read is three-state (#1677): fetched (the company's zone), unavailable (its settings
could not be read; the default zone is used) or not_applicable (no company context). A
request records the state its dates used (:func:`zone_state_used`), and the API answers it
in the ``X-Company-Time-Zone-State`` header (:class:`ZoneStateMiddleware`) and on GET /v1/me.
"""

import logging
from contextvars import ContextVar
from datetime import UTC, date, datetime, time
from typing import Literal, NamedTuple
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy.ext.asyncio import AsyncSession

log = logging.getLogger(__name__)

DEFAULT_ZONE = "America/Los_Angeles"

ZoneState = Literal["fetched", "unavailable", "not_applicable"]
STATE_HEADER = "X-Company-Time-Zone-State"


class ZoneRead(NamedTuple):
    """The zone dates are shown in, and how it was read."""

    zone: str
    state: ZoneState


NOT_APPLICABLE = ZoneRead(DEFAULT_ZONE, "not_applicable")

# The states the request's reads gave; the middleware sets a fresh list per request, so
# reads in tasks the request starts land in the same one.
_used: ContextVar[list[ZoneState] | None] = ContextVar("company_zone_used", default=None)
# The state a response names when several reads disagree: the worst wins.
_RANK: dict[ZoneState, int] = {"not_applicable": 0, "fetched": 1, "unavailable": 2}


def zone_state_used() -> ZoneState | None:
    """The state the dates of this request were formatted with; None when none was read."""
    used = _used.get()
    return max(used, key=_RANK.__getitem__) if used else None


async def company_time_zone_read(db: AsyncSession | None) -> ZoneRead:
    """The Company time zone (read through the alignment report's settings, which carry
    it) and its state: the default, unavailable, when it cannot be read; not_applicable
    without a session."""
    from oracle.runs import batch

    # Read once per Inbox call (oracle.runs.batch), however many rows tell the day.
    read = NOT_APPLICABLE if db is None else await batch.once(
        "company_time_zone", lambda: _time_zone(db)
    )  # fmt: skip
    used = _used.get()
    if used is not None:
        used.append(read.state)
    return read


async def company_time_zone(db: AsyncSession | None) -> str:
    """The Company time zone; its state is recorded for the response
    (:func:`company_time_zone_read` returns it)."""
    return (await company_time_zone_read(db)).zone


async def _time_zone(db: AsyncSession) -> ZoneRead:
    from oracle.reports import alignment

    try:
        return ZoneRead((await alignment.load_settings(db)).timezone, "fetched")
    except Exception:
        log.exception("could not read the company's time zone; using the default")
        return ZoneRead(DEFAULT_ZONE, "unavailable")


class ZoneStateMiddleware:
    """Names the state a response's dates used in :data:`STATE_HEADER` (pure ASGI, so
    the endpoint's reads land before the response starts)."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        token = _used.set([])

        async def named(message):
            if message["type"] == "http.response.start":
                state = zone_state_used()
                if state is not None:
                    headers = list(message.get("headers", []))
                    headers.append((STATE_HEADER.lower().encode(), state.encode()))
                    message = {**message, "headers": headers}
            await send(message)

        try:
            await self.app(scope, receive, send=named)
        finally:
            _used.reset(token)


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


def calendar_day(d: date | str, today: date | None = None) -> str:
    """A calendar day (no zone: a milestone's, a tracker issue's target) as "Nov 30"; given
    ``today`` (the company's), "Nov 30, 2027" when it falls in another year."""
    if isinstance(d, str):
        d = date.fromisoformat(d[:10])
    if today is not None and d.year != today.year:
        return f"{d:%b} {d.day}, {d.year}"
    return f"{d:%b} {d.day}"


def calendar_day_with_year(d: date | str | None) -> str:
    """A calendar day (no zone) with its year as "Nov 30, 2026" (the plan tables, the
    company queue, a draft's dates); empty for no day."""
    if not d:
        return ""
    if isinstance(d, str):
        d = date.fromisoformat(d[:10])
    return f"{calendar_day(d)}, {d.year}"


def calendar_month(d: date) -> str:
    """A calendar day's month (no zone: a metric week's Monday, a milestone's) as "Nov"."""
    return f"{d:%b}"


def month_in_words(moment: datetime | str, zone: str = DEFAULT_ZONE) -> str:
    """The company's month at ``moment`` as "Oct"."""
    return calendar_month(day(moment, zone))


def day_first_in_words(moment: datetime | str, zone: str = DEFAULT_ZONE) -> str:
    """The company's day at ``moment`` as "25 Oct"."""
    local = _local(moment, zone)
    return f"{local.day} {local:%b}"


def stamp(moment: datetime | str, zone: str = DEFAULT_ZONE) -> str:
    """``moment`` in ``zone`` as "Oct 25, 2026, 2:59 PM PDT" (exports, pre-reads): month
    first, as every other date (e2e-pdf-export, 2026-10-30)."""
    local = _local(moment, zone)
    hour = local.hour % 12 or 12
    return (
        f"{local:%b} {local.day}, {local.year}, {hour}:{local:%M} "
        f"{'AM' if local.hour < 12 else 'PM'} {local.tzname()}"
    )


def moment_in_words(moment: datetime | str, zone: str = DEFAULT_ZONE) -> str:
    """``moment`` in ``zone``, month first, as people read it: "Oct 30, 1:28 PM PDT"."""
    local = _local(moment, zone)
    hour = local.hour % 12 or 12
    return (
        f"{local:%b} {local.day}, {hour}:{local:%M} {'AM' if local.hour < 12 else 'PM'} "
        f"{local.tzname()}"
    )


def in_words(moment: datetime, zone: str = DEFAULT_ZONE) -> str:
    """``moment`` in ``zone`` as "Sun Oct 25, 2:59 PM PDT"."""
    local = _local(moment, zone)
    hour = local.hour % 12 or 12
    return (
        f"{local:%a %b} {local.day}, {hour}:{local:%M} {'AM' if local.hour < 12 else 'PM'} "
        f"{local.tzname()}"
    )


def until_in_words(moment: datetime, zone: str = DEFAULT_ZONE) -> str:
    """``moment`` in ``zone`` as "Wed Nov 18, 9:59 AM", with its year ("Tue Jan 5, 2027,
    9:59 AM") only when that is not this year in ``zone``."""
    local = _local(moment, zone)
    hour = local.hour % 12 or 12
    year = f", {local.year}" if local.year != today(zone).year else ""
    return f"{local:%a %b} {local.day}{year}, {hour}:{local:%M} {'AM' if local.hour < 12 else 'PM'}"
