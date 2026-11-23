"""simple-speed: the API's connection pool (oracle.db). Against Postgres.

Test cards (protects / fails_when / no_claim):

- test_the_pool_keeps_a_page_loads_connections: protects=the pool keeps some connections
  between page loads, and every instance of a release (old and new revisions side by side)
  at its pool's ceiling still fits the database's connection limit beside the start-up
  migrations and the scheduler; fails_when=each process may hold more than its share (15
  kept: 3 instances hold 45 of about 50 for good, and a release runs out of connections), or
  held connections are never recycled; no_claim=the database's own max_connections.
- test_a_connection_just_used_is_not_pinged: protects=three sessions in a row ping nothing
  (a ping is three round trips before the first query); fails_when=every checkout pings
  again (pool_pre_ping); no_claim=connections idle past the setting.
- test_an_idle_connection_is_pinged: protects=a connection idle for longer than
  db_ping_after_idle_seconds is pinged once before it is handed out; fails_when=idle
  connections are trusted; no_claim=how long the database keeps an idle connection.
- test_a_dead_idle_connection_is_replaced: protects=when that ping fails the session still
  answers, on a new connection; fails_when=the dead connection reaches the query;
  no_claim=a connection that dies within the idle window (the query fails, as any query
  whose connection dies does, and the pool is invalidated).
"""

from sqlalchemy import event, text

from oracle import db as oracle_db
from oracle.config import get_settings
from oracle.db import get_engine
from oracle.tenancy import unscoped_session


async def _one() -> int:
    async with unscoped_session() as s:
        return await s.scalar(text("SELECT 1"))


def _count_pings(monkeypatch) -> list[int]:
    dialect = get_engine().sync_engine.dialect
    real = dialect.do_ping
    pings: list[int] = []

    def counted(dbapi_connection):
        pings.append(1)
        return real(dbapi_connection)

    monkeypatch.setattr(dialect, "do_ping", counted)
    return pings


async def test_the_pool_keeps_a_page_loads_connections():
    """The pool keeps a page load's connections instead of making them anew each time."""
    pool = get_engine().sync_engine.pool
    settings = get_settings()
    assert settings.db_pool_size == pool.size() == 5, pool.status()
    assert pool._max_overflow == settings.db_max_overflow == 2, pool.status()
    assert pool._recycle == settings.db_pool_recycle_seconds == 300, pool.status()
    # About 50 connections, 3 reserved for superusers; up to 3 instances, 6 while a release
    # runs old and new side by side; one for the start-up migrations, one for the scheduler.
    assert 6 * (pool.size() + pool._max_overflow) + 1 + 1 <= 50 - 3


async def test_a_connection_just_used_is_not_pinged(monkeypatch):
    """A connection used a moment ago is handed out without a ping."""
    await _one()
    pings = _count_pings(monkeypatch)
    for _ in range(3):
        assert await _one() == 1
    assert pings == []


async def test_an_idle_connection_is_pinged(monkeypatch):
    """A connection that sat idle is pinged before it is handed out."""
    await get_engine().dispose()  # one connection in the pool: the one this test uses
    await _one()
    pings = _count_pings(monkeypatch)
    later = oracle_db.time.time() + get_settings().db_ping_after_idle_seconds + 1
    monkeypatch.setattr(oracle_db.time, "time", lambda: later)
    assert await _one() == 1
    assert pings == [1]
    # Used a moment ago now: not pinged again.
    assert await _one() == 1
    assert pings == [1]


async def test_a_dead_idle_connection_is_replaced(monkeypatch):
    """An idle connection that died is replaced before the query runs."""
    await get_engine().dispose()  # one connection in the pool: the one this test uses
    await _one()
    engine = get_engine().sync_engine
    later = oracle_db.time.time() + get_settings().db_ping_after_idle_seconds + 1
    monkeypatch.setattr(oracle_db.time, "time", lambda: later)
    failed: list[int] = []

    def dead(dbapi_connection):
        failed.append(1)
        return False

    monkeypatch.setattr(engine.dialect, "_do_ping_w_event", dead)
    made: list[int] = []

    def connected(dbapi_connection, record):
        made.append(1)

    event.listen(engine.pool, "connect", connected)
    try:
        assert await _one() == 1
    finally:
        event.remove(engine.pool, "connect", connected)
    assert failed == [1]
    assert made == [1]
