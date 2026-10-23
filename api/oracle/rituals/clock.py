"""The rituals' clock, one place tests set."""

from datetime import UTC, datetime


def now() -> datetime:
    return datetime.now(UTC)
