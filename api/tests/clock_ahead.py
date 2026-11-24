"""#1604: a finder for date time bombs, not a gate: ``uv run pytest -p tests.clock_ahead``
moves every Python read of now in oracle.* and tests.* CLOCK_AHEAD_DAYS (default 365)
ahead, so a test pairing a fixed date with today shows red long before that day comes.

Postgres now() does not move, so a test comparing the database's clock with Python's
(rate limits, expiry, newest-first order) fails too: read each failure, not the count.
Names bound at import (a module's TODAY) keep the real day: patching before import
breaks third-party modules (pydantic.v1) on the patched datetime's metaclass."""

import datetime as _dt
import os
import sys
import time as _time

OFFSET = _dt.timedelta(days=int(os.environ.get("CLOCK_AHEAD_DAYS", "365")))
# The C types, never a patched name, so a second import of this module stays sound.
_real_dt, _real_date = type(_dt.datetime.max), type(_dt.date.max)
_real_time = getattr(_time.time, "real", _time.time)


class _DtMeta(type):
    def __instancecheck__(cls, obj):
        return isinstance(obj, _real_dt)

    def __subclasscheck__(cls, sub):
        return issubclass(sub, _real_dt)


class _DateMeta(type):
    def __instancecheck__(cls, obj):
        return isinstance(obj, _real_date)

    def __subclasscheck__(cls, sub):
        return issubclass(sub, _real_date)


class FakeDatetime(_real_dt, metaclass=_DtMeta):
    @classmethod
    def now(cls, tz=None):
        return _real_dt.now(tz) + OFFSET

    @classmethod
    def utcnow(cls):
        return _real_dt.utcnow() + OFFSET

    @classmethod
    def today(cls):
        return _real_dt.today() + OFFSET

    def __new__(cls, *a, **k):
        return _real_dt(*a, **k)


class FakeDate(_real_date, metaclass=_DateMeta):
    @classmethod
    def today(cls):
        return _real_date.today() + OFFSET

    def __new__(cls, *a, **k):
        return _real_date(*a, **k)


def _patch():
    _dt.datetime, _dt.date = FakeDatetime, FakeDate

    def ahead() -> float:
        return _real_time() + OFFSET.total_seconds()

    ahead.real = _real_time  # type: ignore[attr-defined]
    _time.time = ahead
    for name, mod in list(sys.modules.items()):
        if not name.startswith(("oracle", "tests")) or mod is None or name == __name__:
            continue
        for attr, val in list(vars(mod).items()):
            if val is _real_dt:
                setattr(mod, attr, FakeDatetime)
            elif val is _real_date:
                setattr(mod, attr, FakeDate)


def pytest_collection_finish(session):
    import oracle.main  # noqa: F401  load the app's modules before patching them

    _patch()
