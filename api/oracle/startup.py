"""The API image's start (api/Dockerfile CMD): bring the database to head, then serve.

The image still migrates its own database before it serves (deploys never migrate first),
but in the server's own process, so the app's imports happen once, and without Alembic at
all when the database is already at head: the head is read from the revision scripts' text
and compared with ``alembic_version``. Only when they differ (or either can not be read) does
Alembic run, with every script, exactly as ``alembic upgrade head`` would.

Cloud Run, Nov 12: an added instance took about 34 s before serving (9 s to Alembic's first
log line, 24 s more to uvicorn's), so requests routed to it waited that long. Nov 13: about
20 s (3.9 s to check the head, then 13.9 s to import the app); the check then ran in a thread
while the app imported, as one statement, and both slowed (11.7 s and 19.6 s): it now runs in
a forked process.
"""

import asyncio
import gc
import logging
import os
import pickle
import re
import signal
import time
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
VERSIONS = API_DIR / "migrations" / "versions"
HOST = "0.0.0.0"
# Cloud Run's start probe is TCP on this port (Cloud Run sets PORT to the container port,
# 8000): it opens once the app is imported and its lifespan has run.
PORT = int(os.environ.get("PORT", "8000"))

# Named, not __name__: the image runs this module as __main__.
log = logging.getLogger("oracle.startup")

_STR = r"""(?:"([^"\n]+)"|'([^'\n]+)')"""
_REVISION = re.compile(rf"^revision(?:\s*:[^=\n]*)?\s*=\s*{_STR}\s*$", re.M)
_DOWN = re.compile(rf"^down_revision(?:\s*:[^=\n]*)?\s*=\s*(?:None|{_STR})\s*$", re.M)
_ANY_REVISION = re.compile(r"^revision\s*[:=]", re.M)
_ANY_DOWN = re.compile(r"^down_revision\s*[:=]", re.M)


def script_head(versions: Path = VERSIONS) -> str | None:
    """The one head of the revision scripts, read from their text without importing them;
    None when it can not be told for sure (a file whose ids are not plain strings, a merge
    revision, more than one head), and then the caller runs Alembic."""
    revisions: set[str] = set()
    parents: set[str] = set()
    for path in versions.glob("*.py"):
        source = path.read_text()
        rev, down = _REVISION.findall(source), _DOWN.findall(source)
        # Exactly one of each, and no other assignment to either the patterns missed.
        if len(rev) != 1 or len(down) != 1:
            return None
        if len(_ANY_REVISION.findall(source)) != 1 or len(_ANY_DOWN.findall(source)) != 1:
            return None
        revisions.add(rev[0][0] or rev[0][1])
        if parent := down[0][0] or down[0][1]:
            parents.add(parent)
    heads = revisions - parents
    return heads.pop() if len(heads) == 1 and parents <= revisions else None


def _connect_args(url: str) -> tuple[list, dict]:
    """asyncpg's connect arguments for ``url``: the engine's own reading of it (host, port,
    socket, ssl, ...), less the options that are SQLAlchemy's and not asyncpg's."""
    from sqlalchemy.dialects.postgresql.asyncpg import PGDialect_asyncpg
    from sqlalchemy.engine import make_url

    args, kwargs = PGDialect_asyncpg().create_connect_args(make_url(url))
    for option in (
        "async_creator_fn",
        "prepared_statement_cache_size",
        "prepared_statement_name_func",
    ):
        kwargs.pop(option, None)
    return args, kwargs


async def _stored_revisions(connect_args: tuple[list, dict]) -> set[str] | None:
    """The revisions ``alembic_version`` holds; None when there is no such table yet.

    One statement on one plain asyncpg connection: an engine's dialect set-up would send
    four more first (version, schema, isolation level, string quoting), each a round trip
    to Cloud SQL on a new instance."""
    import asyncpg

    args, kwargs = connect_args
    conn = await asyncpg.connect(*args, **kwargs)
    try:
        rows = await conn.fetch("SELECT version_num FROM alembic_version")
    except asyncpg.UndefinedTableError:
        return None
    finally:
        await conn.close()
    return {r[0] for r in rows}


def at_head(connect_args: tuple[list, dict]) -> bool:
    """True when the database is at the scripts' head (no Alembic needed)."""
    head = script_head()
    if head is not None and asyncio.run(_stored_revisions(connect_args)) == {head}:
        log.info("database at head %s: no migration to run", head)
        return True
    return False


def upgrade(url: str) -> None:
    """``alembic upgrade head``, in this process."""
    from alembic import command
    from alembic.config import Config

    cfg = Config(str(API_DIR / "alembic.ini"))
    cfg.attributes["database_url"] = url
    # alembic.ini's logging config would disable every logger made before it (the app's,
    # imported by env.py); Alembic's own lines go through the handler set up in main().
    cfg.attributes["configure_logger"] = False
    command.upgrade(cfg, "head")


def migrate(url: str) -> bool:
    """Bring the database at ``url`` to head; True when Alembic ran, False when the database
    was already at the scripts' head."""
    if at_head(_connect_args(url)):
        return False
    upgrade(url)
    return True


def database_url() -> str:
    from oracle.config import get_settings

    return get_settings().database_url


def _log_to_stderr(*names: str) -> None:
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(levelname)-5.5s [%(name)s] %(message)s"))
    for name in names:
        logger = logging.getLogger(name)
        logger.setLevel(logging.INFO)
        logger.addHandler(handler)
        logger.propagate = False


def _start_check(connect_args: tuple[list, dict]) -> tuple[int, int]:
    """Starts the head check in a forked process; returns its pid and the pipe its answer
    comes back on (a pickled ``(at_head, took, error)``).

    A process, not a thread: a thread shares the import's interpreter, and on one CPU each
    of them waited on the other's GIL (Cloud Run, Nov 13: "migrations checked in 11.7 s, app
    imported in 19.6 s"). The fork copies the loaded asyncpg and connect arguments, so the
    check imports nothing; it is forked before the app's import starts any thread."""
    started = time.perf_counter()
    read, write = os.pipe()
    pid = os.fork()
    if pid:
        os.close(write)
        return pid, read
    # The check's process: answer, then end at once (no atexit, no buffers of the parent's).
    code = 0
    try:
        os.close(read)
        try:
            answer = (at_head(connect_args), time.perf_counter() - started, None)
        except BaseException as e:  # raised again in the server's process
            answer = (None, time.perf_counter() - started, e)
        with os.fdopen(write, "wb") as out:
            try:
                pickle.dump(answer, out)
            except Exception as e:  # an error that does not pickle: its text
                pickle.dump((None, answer[1], RuntimeError(repr(answer[2] or e))), out)
    except BaseException:
        code = 1
    finally:
        os._exit(code)


def _check_answer(pid: int, read: int) -> tuple[bool, float]:
    """The forked check's answer: (at head, seconds it took); its error raised here."""
    with os.fdopen(read, "rb") as answers:
        data = answers.read()
    os.waitpid(pid, 0)
    if not data:
        raise RuntimeError("the migration head check ended without an answer")
    at, took, error = pickle.loads(data)
    if error is not None:
        raise error
    return at, took


def _stop_check(pid: int, read: int) -> None:
    """Ends the check's process (by its pid) when the start fails before reading it."""
    try:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
    except (ProcessLookupError, ChildProcessError):
        pass
    os.close(read)


def main() -> None:
    _log_to_stderr(log.name, "alembic")
    started = time.perf_counter()
    url = database_url()
    # The head check waits on the database (on a new Cloud Run instance, mostly its first
    # connection) while the app's modules load: it runs in its own process, and nothing is
    # served until it has answered and, if the database is behind, Alembic has brought it to
    # head.
    connect_args = _connect_args(url)
    # Loaded here, so the check's process imports nothing.
    import asyncpg  # noqa: F401

    pid, read = _start_check(connect_args)
    # No cyclic garbage collection while the app's modules load: they make a few hundred
    # thousand long-lived objects, and each collection on the way walks them all again (a
    # fifth of the import's time on one CPU). They are frozen out of later collections,
    # then collection goes on as usual.
    gc.disable()
    try:
        import uvicorn

        from oracle.main import app

        gc.freeze()
    except BaseException:
        # A failed import ends the start now, not when the check's connection answers.
        _stop_check(pid, read)
        raise
    finally:
        gc.enable()
    imported = time.perf_counter()
    at, migrated = _check_answer(pid, read)
    ran = not at
    if ran:
        upgrade(url)
        migrated += time.perf_counter() - imported
    log.info(
        "migrations %s in %.1f s, app imported in %.1f s",
        "ran" if ran else "checked",
        migrated,
        imported - started,
    )
    uvicorn.run(app, host=HOST, port=PORT)


if __name__ == "__main__":
    main()
