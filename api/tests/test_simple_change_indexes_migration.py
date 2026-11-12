"""Migration 0130_simple_change_indexes: its lock_timeout ends with it. Alembic runs every
pending migration in one transaction (migrations/env.py), so a SET LOCAL left standing would
bind the migrations after it. Sync on purpose (Alembic runs its own event loop); its own
scratch database.

Each test's card: protects=<the observable>; fails_when=<the wrong result it rejects>;
no_claim=<what green does not prove>.

- test_lock_timeout_does_not_outlive_the_migration: protects=after 0130's upgrade, and after
  its downgrade, the transaction's lock_timeout is what it was before; fails_when=the
  migration's 5 s lock_timeout stays set for the rest of the transaction; no_claim=the
  indexes' use (EXPLAIN in the migration's docstring).
- test_both_ways_wait_at_most_5s: protects=each of the four indexes is created by the
  upgrade and dropped by the downgrade under the 5 s lock_timeout; fails_when=either way
  takes its locks without it (waiting behind a long read for as long as it lasts);
  no_claim=Postgres honouring the timeout.
"""

import asyncio
import importlib.util

import pytest
from alembic import command
from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.operations import Operations
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import make_url

from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

REVISION = "0130_simple_change_indexes"
PREVIOUS = "0129_ritual_failed_at"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_change_ix")
    .render_as_string(hide_password=False)
)


def _cfg() -> Config:
    cfg = Config(str(API_DIR / "alembic.ini"))
    cfg.attributes["database_url"] = SCRATCH_URL
    return cfg


def _migration():
    script = ScriptDirectory.from_config(_cfg()).get_revision(REVISION)
    spec = importlib.util.spec_from_file_location(REVISION, script.path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def _timeouts(step: str) -> tuple[str, str]:
    """lock_timeout before and after the migration's ``step``, in one transaction."""
    migration = _migration()

    def run(conn) -> tuple[str, str]:
        was = conn.execute(text("SHOW lock_timeout")).scalar()
        with Operations.context(MigrationContext.configure(conn)):
            getattr(migration, step)()
        return was, conn.execute(text("SHOW lock_timeout")).scalar()

    async def go():
        from sqlalchemy.ext.asyncio import create_async_engine

        engine = create_async_engine(SCRATCH_URL)
        try:
            async with engine.begin() as conn:
                return await conn.run_sync(run)
        finally:
            await engine.dispose()

    return asyncio.run(go())


def test_lock_timeout_does_not_outlive_the_migration(scratch_db):
    command.upgrade(_cfg(), PREVIOUS)
    was, now = _timeouts("upgrade")
    assert now == was, (was, now)
    command.stamp(_cfg(), REVISION)
    was, now = _timeouts("downgrade")
    assert now == was, (was, now)


def _timeouts_at_each_index(step: str, monkeypatch) -> list[str]:
    """lock_timeout as the migration's ``step`` creates or drops each index."""
    seen: list[str] = []
    for name in ("create_index", "drop_index"):
        real = getattr(Operations, name)

        def watch(self, *args, _real=real, **kw):
            seen.append(self.get_bind().execute(text("SHOW lock_timeout")).scalar())
            return _real(self, *args, **kw)

        monkeypatch.setattr(Operations, name, watch)
    _timeouts(step)
    monkeypatch.undo()
    return seen


def test_both_ways_wait_at_most_5s(scratch_db, monkeypatch):
    command.upgrade(_cfg(), PREVIOUS)
    assert _timeouts_at_each_index("upgrade", monkeypatch) == ["5s"] * 4
    command.stamp(_cfg(), REVISION)
    assert _timeouts_at_each_index("downgrade", monkeypatch) == ["5s"] * 4
