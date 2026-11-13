"""The API image's start (api/Dockerfile CMD): bring the database to head, then serve.

The image still migrates its own database before it serves (deploys never migrate first),
but in the server's own process, so the app's imports happen once, and without Alembic at
all when the database is already at head: the head is read from the revision scripts' text
and compared with ``alembic_version``. Only when they differ (or either can not be read) does
Alembic run, with every script, exactly as ``alembic upgrade head`` would.

Read errors are not guessed around. A revision script whose ids the parse can not tell for
sure (not plain strings, a merge, more than one head) only makes the head unknown, so
Alembic runs. A script file that can not be read at all (an OSError, bytes that are not
UTF-8) or a database that can not be reached raises, and the start exits 1 without
serving, as ``alembic upgrade head`` would have; so does a database at a revision these
scripts do not have (an older image started after a newer one migrated it).

Cloud Run, Nov 12: an added instance took about 34 s before serving (9 s to Alembic's first
log line, 24 s more to uvicorn's), so requests routed to it waited that long.
"""

import asyncio
import gc
import logging
import os
import re
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


async def _stored_revisions(url: str) -> set[str] | None:
    """The revisions ``alembic_version`` holds; None when there is no such table yet."""
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine
    from sqlalchemy.pool import NullPool

    engine = create_async_engine(url, poolclass=NullPool)
    try:
        async with engine.connect() as conn:
            if (await conn.scalar(text("SELECT to_regclass('alembic_version')"))) is None:
                return None
            rows = await conn.execute(text("SELECT version_num FROM alembic_version"))
            return {r[0] for r in rows}
    finally:
        await engine.dispose()


def migrate(url: str) -> bool:
    """Bring the database at ``url`` to head; True when Alembic ran, False when the database
    was already at the scripts' head."""
    head = script_head()
    if head is not None and asyncio.run(_stored_revisions(url)) == {head}:
        log.info("database at head %s: no migration to run", head)
        return False
    from alembic import command
    from alembic.config import Config

    cfg = Config(str(API_DIR / "alembic.ini"))
    cfg.attributes["database_url"] = url
    # alembic.ini's logging config would disable every logger made before it (the app's,
    # imported by env.py); Alembic's own lines go through the handler set up in main().
    cfg.attributes["configure_logger"] = False
    command.upgrade(cfg, "head")
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


def main() -> None:
    _log_to_stderr(log.name, "alembic")
    started = time.perf_counter()
    ran = migrate(database_url())
    migrated = time.perf_counter()
    # No cyclic garbage collection while the app's modules load: they make a few hundred
    # thousand long-lived objects, and each collection on the way walks them all again (a
    # fifth of the import's time on one CPU). They are frozen out of later collections,
    # then collection goes on as usual.
    gc.disable()
    try:
        import uvicorn

        from oracle.main import app

        gc.freeze()
    finally:
        gc.enable()
    imported = time.perf_counter()
    log.info(
        "migrations %s in %.1f s, app imported in %.1f s",
        "ran" if ran else "checked",
        migrated - started,
        imported - migrated,
    )
    uvicorn.run(app, host=HOST, port=PORT)


if __name__ == "__main__":
    main()
