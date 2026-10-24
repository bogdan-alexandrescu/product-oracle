"""The company's day for tests (#519): "today" as the API reads it, in the Company time
zone, never the machine's day (CI runs in UTC, a day ahead of Pacific from 5 PM)."""

from datetime import UTC, date, datetime

from oracle import company_time


def company_today(zone: str = company_time.DEFAULT_ZONE, at: datetime | None = None) -> date:
    """The company's day in ``zone`` (the default Company time zone unless a test sets
    another) now, or at ``at``."""
    return company_time.day(at or datetime.now(UTC), zone)
