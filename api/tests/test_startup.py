"""The API image's start (oracle.startup): the database is brought to head before the app
serves, and a database already at head costs no migration work. Cloud Run, Nov 12: a new
instance took about 34 s before serving, 9 s of it before Alembic's first log line and its
migration scripts loaded on every start. Sync on purpose (Alembic runs its own event loop);
its own scratch database.

Each test's card: protects=<the observable>; fails_when=<the wrong result it rejects>;
no_claim=<what green does not prove>.

- test_at_head_no_migration_script_is_loaded: protects=a start against a database at head
  serves without Alembic loading env.py or any revision script; fails_when=every start runs
  the migration environment (the 9 s+ before serving); no_claim=the time it takes.
- test_one_revision_behind_is_upgraded_before_serving: protects=a database one revision
  behind is at head when the server is started; fails_when=the cheap check skips a pending
  migration, or the server starts first; no_claim=data migrations' contents.
- test_empty_database_is_migrated: protects=a database with no alembic_version table is
  brought to head; fails_when=the missing table is read as "nothing to do".
- test_at_head_check_is_one_read_without_alembic: protects=at head, the check is one
  statement (SELECT version_num FROM alembic_version) and builds no Alembic environment;
  fails_when=the check reads the catalog first, or goes through an engine whose dialect
  set-up runs its own statements (each a round trip to Cloud SQL on a new instance);
  no_claim=the time it takes.
- test_empty_database_check_is_one_read: protects=a database with no alembic_version table
  costs the check one statement too, then a full upgrade.
- test_app_import_leaves_heavy_libraries_unloaded: protects=importing the app (a clean
  interpreter, as a new instance does) loads no MCP SDK, PDF reader, SQL parser or
  template engine; fails_when=a route module imports one at its top again (Cloud Run, Nov
  13: the app's import took 13.9 s of a 20 s start); no_claim=they still load when used.
- test_app_import_within_budget: protects=the app's import in a clean interpreter, gc off
  as oracle.startup does, stays under IMPORT_BUDGET_S; fails_when=the import goes back to
  building every pydantic schema and loading every library at import (5.8-6.1 s on the
  lane's machine, 4.2-4.7 s after); no_claim=Cloud Run's own time (about 2.3 times this
  machine's).
- test_a_failed_check_stops_the_start: protects=the head check, run beside the app's
  import, still decides before anything is served; fails_when=its error is lost in its
  thread and the server starts on a database it could not read.
- test_script_head_is_alembics_head: protects=the head read from the scripts' text is the
  one Alembic computes; fails_when=the cheap parse drifts from Alembic (a stale head would
  skip a migration).
- test_unreadable_script_means_full_upgrade: protects=a revision file the parse can not read
  makes the head unknown; fails_when=such a file is ignored and its parent taken for head.
- test_migrating_in_process_keeps_app_logging: protects=running Alembic in the server's
  process leaves the app's loggers on; fails_when=alembic.ini's fileConfig disables every
  logger made before it (oracle.* imported by env.py).
- test_image_starts_through_startup: protects=the image's CMD is this start path on port
  8000; fails_when=it goes back to a separate `alembic upgrade head` process.
- test_start_as_the_image_does_serves_at_head: protects=`python -m oracle.startup` against a
  database at head answers /healthz on its port and says it ran no migration; fails_when=the
  real start path breaks (logging set up for the wrong name under -m, the server never
  listening); no_claim=Cloud Run's probe itself.
- test_image_ships_the_apps_bytecode: protects=the image holds compiled bytecode for the
  app's own modules and the migration scripts; fails_when=each new instance compiles them
  again (.dockerignore drops __pycache__, and UV_COMPILE_BYTECODE covers only installed
  packages, not the editable app: 6.4 s against 4.5 s for the app's import on one CPU);
  no_claim=the image build itself (not run by the tests).
"""

import asyncio
import logging
import os
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import create_async_engine

from oracle import startup
from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_startup")
    .render_as_string(hide_password=False)
)


def _cfg() -> Config:
    cfg = Config(str(API_DIR / "alembic.ini"))
    cfg.attributes["database_url"] = SCRATCH_URL
    return cfg


def _head() -> str:
    return ScriptDirectory.from_config(_cfg()).get_current_head()


def _stored() -> set[str]:
    async def read() -> set[str]:
        engine = create_async_engine(SCRATCH_URL)
        try:
            async with engine.connect() as conn:
                rows = await conn.execute(text("SELECT version_num FROM alembic_version"))
                return {r[0] for r in rows}
        finally:
            await engine.dispose()

    return asyncio.run(read())


@pytest.fixture(scope="module")
def at_head():
    """A scratch database at head (migrated once for the module; tests that move it put it
    back)."""
    asyncio.run(_reset_schema(SCRATCH_URL))
    command.upgrade(_cfg(), "head")
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


@pytest.fixture
def served(monkeypatch):
    """Runs startup.main() against the scratch database with the server stubbed: the list
    gets, for each server start, the app and the database's revisions at that moment."""
    calls: list[tuple[object, set[str]]] = []

    def fake_run(app, **kwargs):
        assert kwargs.get("port") == 8000
        calls.append((app, _stored()))

    monkeypatch.setattr(startup, "database_url", lambda: SCRATCH_URL)
    monkeypatch.setattr("uvicorn.run", fake_run)
    return calls


@pytest.fixture
def loaded_scripts(monkeypatch):
    """Every Python file Alembic loads (env.py and each revision script)."""
    import alembic.util

    loaded: list[str] = []
    real = alembic.util.load_python_file

    def spy(dir_, filename):
        loaded.append(str(filename))
        return real(dir_, filename)

    monkeypatch.setattr(alembic.util, "load_python_file", spy)
    return loaded


def test_at_head_no_migration_script_is_loaded(at_head, served, loaded_scripts):
    startup.main()

    import oracle.main

    assert loaded_scripts == []
    assert served == [(oracle.main.app, {_head()})]


def test_one_revision_behind_is_upgraded_before_serving(at_head, served, loaded_scripts):
    command.downgrade(_cfg(), "-1")
    behind = _stored()
    assert behind != {_head()}
    loaded_scripts.clear()

    startup.main()

    assert len(served) == 1
    assert served[0][1] == {_head()}
    assert "env.py" in loaded_scripts


def test_empty_database_is_migrated(at_head, served):
    asyncio.run(_reset_schema(SCRATCH_URL))

    startup.main()

    assert len(served) == 1
    assert served[0][1] == {_head()}


@pytest.fixture
def statements(monkeypatch):
    """Every statement sent to Postgres through asyncpg (prepared or simple), and a guard
    that fails if an Alembic migration environment is built."""
    import asyncpg.connection
    from alembic.runtime.environment import EnvironmentContext

    sent: list[str] = []
    get_statement = asyncpg.connection.Connection._get_statement
    execute = asyncpg.connection.Connection.execute

    async def spy_get_statement(self, query, *args, **kwargs):
        sent.append(query)
        return await get_statement(self, query, *args, **kwargs)

    async def spy_execute(self, query, *args, **kwargs):
        if not args:
            sent.append(query)
        return await execute(self, query, *args, **kwargs)

    def no_environment(*args, **kwargs):
        raise AssertionError("an Alembic environment was built")

    monkeypatch.setattr(asyncpg.connection.Connection, "_get_statement", spy_get_statement)
    monkeypatch.setattr(asyncpg.connection.Connection, "execute", spy_execute)
    monkeypatch.setattr(EnvironmentContext, "__init__", no_environment)
    return sent


def test_at_head_check_is_one_read_without_alembic(at_head, statements):
    assert startup.migrate(SCRATCH_URL) is False

    assert statements == ["SELECT version_num FROM alembic_version"]


def test_empty_database_check_is_one_read(at_head, monkeypatch, statements):
    asyncio.run(_reset_schema(SCRATCH_URL))
    statements.clear()
    upgrades: list[str] = []
    monkeypatch.setattr(command, "upgrade", lambda cfg, rev: upgrades.append(rev))

    try:
        assert startup.migrate(SCRATCH_URL) is True

        assert statements == ["SELECT version_num FROM alembic_version"]
        assert upgrades == ["head"]
    finally:
        monkeypatch.undo()
        command.upgrade(_cfg(), "head")


HEAVY = ("mcp", "mcp_types", "pypdf", "sqlglot", "jinja2")


def test_app_import_leaves_heavy_libraries_unloaded():
    code = (
        f"import sys; import oracle.main; print(sorted(m for m in {HEAVY!r} if m in sys.modules))"
    )
    out = subprocess.run(
        [sys.executable, "-c", code], cwd=API_DIR, capture_output=True, text=True, check=True
    )
    assert out.stdout.strip() == "[]", out.stdout + out.stderr


# The lane's machine: 5.8-6.1 s before (every schema built, every library loaded at
# import), 4.2-4.7 s after; the budget leaves headroom over the after.
IMPORT_BUDGET_S = 5.4


@pytest.mark.timing
def test_app_import_within_budget():
    code = (
        "import gc, time; gc.disable(); t = time.perf_counter(); import oracle.main; "
        "print(time.perf_counter() - t)"
    )
    took = []
    for _ in range(2):
        out = subprocess.run(
            [sys.executable, "-c", code], cwd=API_DIR, capture_output=True, text=True, check=True
        )
        took.append(float(out.stdout.strip().splitlines()[-1]))
    assert min(took) < IMPORT_BUDGET_S, took


def test_a_failed_check_stops_the_start(served, monkeypatch):
    def unreachable(connect_args):
        raise OSError("connection refused")

    monkeypatch.setattr(startup, "at_head", unreachable)

    with pytest.raises(OSError, match="connection refused"):
        startup.main()

    assert served == []


def test_script_head_is_alembics_head():
    assert startup.script_head() == _head()


def test_unreadable_script_means_full_upgrade(tmp_path: Path):
    versions = API_DIR / "migrations" / "versions"
    for path in versions.glob("*.py"):
        (tmp_path / path.name).write_text(path.read_text())
    assert startup.script_head(tmp_path) == _head()
    # A new revision whose id the parse can not read (not a string literal).
    (tmp_path / "9999_odd.py").write_text(
        f'"""Odd."""\nREV = "9999_odd"\nrevision = REV\ndown_revision = "{_head()}"\n'
    )
    assert startup.script_head(tmp_path) is None


def _oracle_loggers() -> list[logging.Logger]:
    return [
        logger
        for name, logger in logging.Logger.manager.loggerDict.items()
        if name.startswith("oracle") and isinstance(logger, logging.Logger)
    ]


def test_migrating_in_process_keeps_app_logging(at_head):
    command.downgrade(_cfg(), "-1")
    # The harness's own migration (tests/conftest.py) ran alembic.ini's logging config.
    for logger in _oracle_loggers():
        logger.disabled = False
    log = logging.getLogger("oracle.startup_test_probe")

    assert startup.migrate(SCRATCH_URL) is True

    assert _stored() == {_head()}
    assert not log.disabled
    assert [logger.name for logger in _oracle_loggers() if logger.disabled] == []


def test_image_starts_through_startup():
    dockerfile = (API_DIR / "Dockerfile").read_text()
    cmd = [line for line in dockerfile.splitlines() if line.startswith("CMD")]
    assert cmd == ['CMD ["python", "-m", "oracle.startup"]']
    assert "alembic upgrade" not in cmd[0]
    assert startup.PORT == 8000


def test_image_ships_the_apps_bytecode():
    lines = (API_DIR / "Dockerfile").read_text().splitlines()
    compiles = [i for i, line in enumerate(lines) if line.startswith("RUN python -m compileall")]
    assert len(compiles) == 1
    compile_line = lines[compiles[0]]
    assert " oracle" in compile_line and " migrations" in compile_line
    # After the sources are copied in, before the image starts.
    assert compiles[0] > lines.index("COPY . .")


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def test_start_as_the_image_does_serves_at_head(at_head, tmp_path: Path):
    port = _free_port()
    out = tmp_path / "start.log"
    env = {**os.environ, "ORACLE_DATABASE_URL": SCRATCH_URL, "PORT": str(port)}
    with out.open("w") as log_file:
        proc = subprocess.Popen(
            [sys.executable, "-m", "oracle.startup"],
            cwd=API_DIR,
            env=env,
            stdout=log_file,
            stderr=subprocess.STDOUT,
        )
    try:
        status = None
        deadline = time.monotonic() + 90
        while status != 200 and time.monotonic() < deadline and proc.poll() is None:
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=2) as r:
                    status = r.status
            except OSError:
                time.sleep(0.2)
    finally:
        proc.terminate()
        proc.wait(20)
    log = out.read_text()
    assert status == 200, log
    assert f"[oracle.startup] database at head {_head()}: no migration to run" in log
    assert "Running upgrade" not in log
