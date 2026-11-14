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
- test_app_import_within_budget: protects=importing the app and then reading the role map
  (the first page load's GET /v1/me/capabilities) on one CPU (taskset -c 0, as Cloud Run's
  one vCPU), cold, with collection off as oracle.startup does, stays under IMPORT_BUDGET_S,
  the role map alone under ROLE_MAP_BUDGET_S; fails_when=the import goes back to building
  every route's dependency tree and fields at declaration, or the role map builds them at
  the first request instead; no_claim=Cloud Run's own time.
- test_role_map_builds_no_route: protects=the role map (GET /v1/me/capabilities, read on
  every page load) builds no route; fails_when=it reads route.dependant, which builds all
  500+ routes inside the async handler (1.1-2.0 s on one CPU, the event loop blocked).
- test_a_route_read_during_its_build_waits_for_it: protects=a second thread reading a route
  that another thread is building gets the built part; fails_when=it gets AttributeError.
- test_a_failed_build_is_tried_again: protects=a route whose build raises raises the same
  error on the next read, and builds once the cause is gone; fails_when=it is left with
  neither its declaration nor its build (AttributeError on every read).
- test_routes_are_built_at_first_use: protects=importing the app builds no included route's
  dependency tree, fields or handler (FastAPI builds them again per inclusion at the first
  request); fails_when=a router goes back to fastapi.APIRouter's eager routes.
- test_declared_settings_match_fastapis_build: protects=every route's declared settings
  (path, methods, response model, operation id, ...) set at import equal what FastAPI's own
  build sets; fails_when=oracle.routing's copy of the declared part drifts from FastAPI
  (a route served or documented differently).
- test_a_failed_check_stops_the_start: protects=the head check, run beside the app's
  import, still decides before anything is served; fails_when=its error is lost in its
  thread and the server starts on a database it could not read.
- test_head_check_runs_outside_the_importing_process: protects=the head check runs in its
  own process, so it never holds the importing interpreter's GIL; fails_when=it goes back to a
  thread beside the import (Cloud Run, Nov 13: "migrations checked in 11.7 s, app imported in
  19.6 s", both slowed by sharing one interpreter on one CPU); no_claim=the time it takes.
- test_a_failed_import_does_not_wait_on_the_check: protects=an app import that fails ends
  the start at once, its check stopped; fails_when=the process stays alive waiting on the
  check's database connection (a non-daemon thread, or a check process left running).
- test_defer_build_only_on_oracles_models: protects=only Oracle's own pydantic models build
  at first use; fails_when=defer_build is set on pydantic's BaseModel, deferring the SDKs'
  and FastAPI's models too (two threadpool threads can then race to build one), or an Oracle
  model is left out of the project base.
- test_lazy_module_imports_once: protects=a LazyModule imports its module at the first read
  only; fails_when=every attribute read goes through importlib again.
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
import shutil
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


# The lane's machine on one CPU (taskset -c 0): 2.9-3.0 s before (every route built at
# declaration), 2.2-2.4 s after when the host is quiet, 3.1-3.2 s with the shared host
# loaded. The first page load reads the role map (GET /v1/me/capabilities): 1.1-2.0 s when
# it built every route's dependency tree, 0.04-0.07 s from the declared dependencies. The
# total is a coarse guard: test_routes_are_built_at_first_use and
# test_role_map_builds_no_route catch those regressions on any host.
IMPORT_BUDGET_S = 3.5
ROLE_MAP_BUDGET_S = 0.3
ONE_CPU = ["taskset", "-c", "0"] if shutil.which("taskset") else []


@pytest.mark.timing
def test_app_import_within_budget():
    code = (
        "import gc, time; gc.disable(); t = time.perf_counter(); import oracle.main; "
        "i = time.perf_counter(); from oracle.capabilities import capabilities; "
        "capabilities(oracle.main.app, 'viewer', engineering_lead=True); "
        "print(i - t, time.perf_counter() - i)"
    )
    took, role_map = [], []
    for _ in range(3):
        out = subprocess.run(
            [*ONE_CPU, sys.executable, "-c", code],
            cwd=API_DIR,
            capture_output=True,
            text=True,
            check=True,
        )
        imported, roles = map(float, out.stdout.strip().splitlines()[-1].split())
        took.append(imported + roles)
        role_map.append(roles)
    assert min(role_map) < ROLE_MAP_BUDGET_S, role_map
    assert min(took) < IMPORT_BUDGET_S, took


_ROUTES = """
import oracle.main
from oracle.capabilities import _routes

included = [
    r for inc in oracle.main.app.router.routes if hasattr(inc, "original_router")
    for r in _routes(inc.original_router.routes)
]
"""


def test_routes_are_built_at_first_use():
    code = _ROUTES + (
        "built = sorted(r.path for r in included if 'dependant' in vars(r))\n"
        "print(len(included), built)\n"
    )
    out = subprocess.run([sys.executable, "-c", code], cwd=API_DIR, capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    count, built = out.stdout.strip().split(" ", 1)
    assert int(count) > 500
    assert built == "[]"


def test_declared_settings_match_fastapis_build():
    code = _ROUTES + (
        "drift = []\n"
        "for r in included:\n"
        "    declared = {k: v for k, v in vars(r).items() if not k.startswith('_')}\n"
        # The first read of a built part runs FastAPI's own build over the same route.
        "    assert r.dependant and r.app\n"
        "    drift += [(r.path, k) for k, v in declared.items() if vars(r)[k] != v]\n"
        "print(drift)\n"
    )
    out = subprocess.run([sys.executable, "-c", code], cwd=API_DIR, capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    assert out.stdout.strip() == "[]"


def test_role_map_builds_no_route():
    code = _ROUTES + (
        "from oracle.capabilities import capabilities\n"
        "capabilities(oracle.main.app, 'viewer', engineering_lead=True)\n"
        "print(sorted(r.path for r in included if 'dependant' in vars(r)))\n"
    )
    out = subprocess.run([sys.executable, "-c", code], cwd=API_DIR, capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    assert out.stdout.strip() == "[]"


def _endpoint() -> dict:
    return {}


def test_a_route_read_during_its_build_waits_for_it(monkeypatch):
    import threading

    from fastapi.routing import APIRoute

    from oracle.routing import LazyAPIRoute

    real, started = APIRoute.__init__, threading.Event()

    def slow(self, *args, **kwargs):
        started.set()
        time.sleep(0.2)
        real(self, *args, **kwargs)

    monkeypatch.setattr(APIRoute, "__init__", slow)
    route = LazyAPIRoute("/x", _endpoint)
    first = threading.Thread(target=lambda: route.dependant)
    first.start()
    started.wait()
    assert route.dependant.call is _endpoint
    first.join()


def test_a_failed_build_is_tried_again(monkeypatch):
    from fastapi.routing import APIRoute

    from oracle.routing import LazyAPIRoute

    def boom(self, *args, **kwargs):
        raise RuntimeError("build failed")

    route = LazyAPIRoute("/x", _endpoint)
    with monkeypatch.context() as patch:
        patch.setattr(APIRoute, "__init__", boom)
        with pytest.raises(RuntimeError, match="build failed"):
            route.dependant  # noqa: B018 (the read builds)
        with pytest.raises(RuntimeError, match="build failed"):
            route.dependant  # noqa: B018
    assert route.dependant.call is _endpoint


def test_a_failed_check_stops_the_start(served, monkeypatch):
    def unreachable(connect_args):
        raise OSError("connection refused")

    monkeypatch.setattr(startup, "at_head", unreachable)

    with pytest.raises(OSError, match="connection refused"):
        startup.main()

    assert served == []


def test_head_check_runs_outside_the_importing_process(at_head, served, monkeypatch, tmp_path):
    seen = tmp_path / "check.txt"

    def recording(connect_args):
        seen.write_text(str(os.getpid()))
        return True

    monkeypatch.setattr(startup, "at_head", recording)

    startup.main()

    assert int(seen.read_text()) != os.getpid()
    assert len(served) == 1


def test_a_failed_import_does_not_wait_on_the_check():
    code = (
        "import sys, time\n"
        "from oracle import startup\n"
        "startup.at_head = lambda connect_args: time.sleep(60) or True\n"
        "sys.modules['oracle.main'] = None\n"
        "startup.main()\n"
    )
    started = time.monotonic()
    out = subprocess.run(
        [sys.executable, "-c", code], cwd=API_DIR, capture_output=True, text=True, timeout=30
    )
    assert out.returncode != 0
    assert "import of oracle.main halted" in out.stderr, out.stderr
    assert time.monotonic() - started < 20


def test_defer_build_only_on_oracles_models():
    code = (
        "import pydantic, pydantic_settings, oracle.main\n"
        "from oracle.base_model import BaseModel\n"
        "def every(cls):\n"
        "    for sub in cls.__subclasses__():\n"
        "        yield sub\n"
        "        yield from every(sub)\n"
        "print(pydantic.BaseModel.model_config.get('defer_build'))\n"
        "print(BaseModel.model_config.get('defer_build'))\n"
        "print(sorted({c.__module__ + '.' + c.__qualname__ for c in every(pydantic.BaseModel)\n"
        "    if c.__module__.startswith('oracle.') and '[' not in c.__qualname__\n"
        "    and not issubclass(c, (BaseModel, pydantic_settings.BaseSettings))}))\n"
    )
    out = subprocess.run([sys.executable, "-c", code], cwd=API_DIR, capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    pydantics, oracles, left_out = out.stdout.strip().splitlines()
    assert pydantics == "None"
    assert oracles == "True"
    assert left_out == "[]"


def test_lazy_module_imports_once(monkeypatch):
    import importlib
    import json

    from oracle.lazy import LazyModule

    imported: list[str] = []
    real = importlib.import_module
    monkeypatch.setattr(
        importlib, "import_module", lambda name: imported.append(name) or real(name)
    )
    lazy = LazyModule("json")

    assert lazy.dumps is json.dumps
    assert lazy.loads is json.loads
    assert imported == ["json"]


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
