"""Scratch databases for the migration tests, cloned at the revision they start from.

A migration test used to replay every revision from an empty database to the one it
starts at. Here the first ``upgrade`` of an empty scratch database instead clones a
template database at that revision (``CREATE DATABASE ... TEMPLATE``). Each template is
made once a session, from the nearest earlier template, so a whole run walks the chain
about once. ``tests/test_migration_graph.py`` walks it whole: one head, up, down, up.

Sync on purpose (Alembic runs its own event loop).
"""

import asyncio

from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from alembic.util.exc import CommandError
from sqlalchemy import make_url, text
from sqlalchemy.ext.asyncio import create_async_engine

from tests.conftest import API_DIR, BASE_TEST_DATABASE_URL, TEST_DATABASE_URL

# This worker's templates, by revision: oracle_test_gw0_tpl_0, ...
_TEMPLATE_PREFIX = make_url(TEST_DATABASE_URL).database + "_tpl_"
_templates: dict[str, str] = {}


def _config(url: str) -> Config:
    cfg = Config(str(API_DIR / "alembic.ini"))
    cfg.attributes["database_url"] = url
    return cfg


def _url(database: str) -> str:
    return make_url(TEST_DATABASE_URL).set(database=database).render_as_string(hide_password=False)


async def _admin(*statements: str) -> list:
    """Run ``statements`` outside a transaction on the base test database; the rows of the
    last one."""
    engine = create_async_engine(BASE_TEST_DATABASE_URL, isolation_level="AUTOCOMMIT")
    try:
        async with engine.connect() as conn:
            for sql in statements:
                result = await conn.execute(text(sql))
            return result.all() if result.returns_rows else []
    finally:
        await engine.dispose()


async def _is_empty(url: str) -> bool:
    """True when ``url``'s public schema holds nothing: no table, sequence or type."""
    engine = create_async_engine(url)
    try:
        async with engine.connect() as conn:
            n = await conn.scalar(
                text(
                    "SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace s "
                    "ON s.oid = c.relnamespace WHERE s.nspname = 'public') + "
                    "(SELECT count(*) FROM pg_type t JOIN pg_namespace s "
                    "ON s.oid = t.typnamespace WHERE s.nspname = 'public')"
                )
            )
        return n == 0
    finally:
        await engine.dispose()


def drop_templates() -> None:
    """Drop this worker's templates, the ones a past run left too."""
    _templates.clear()
    rows = asyncio.run(
        _admin(f"SELECT datname FROM pg_database WHERE datname LIKE '{_TEMPLATE_PREFIX}%'")
    )
    for (name,) in rows:
        asyncio.run(_admin(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))


def _template_at(revision: str) -> str:
    """The name of a template database at ``revision``, made from the nearest earlier one."""
    if revision in _templates:
        return _templates[revision]
    if not _templates:
        drop_templates()
    name = f"{_TEMPLATE_PREFIX}{len(_templates)}"
    script = ScriptDirectory.from_config(_config(TEST_DATABASE_URL))
    source = next(
        (
            _templates[r.revision]
            for r in script.iterate_revisions(revision, "base")
            if r.revision in _templates
        ),
        None,
    )
    template = f' TEMPLATE "{source}"' if source else ""
    asyncio.run(_admin(f'CREATE DATABASE "{name}"{template}'))
    command.upgrade(_config(_url(name)), revision)
    _templates[revision] = name
    return name


def upgrade(cfg: Config, revision: str) -> None:
    """``command.upgrade``, except that an empty scratch database becomes a clone of the
    template at ``revision`` instead of replaying every revision up to it."""
    url = cfg.attributes["database_url"]
    try:
        target = ScriptDirectory.from_config(cfg).get_revision(revision)
    except CommandError:
        target = None
    if target is None or cfg.cmd_opts is not None or not asyncio.run(_is_empty(url)):
        command.upgrade(cfg, revision)
        return
    template = _template_at(target.revision)
    name = make_url(url).database
    asyncio.run(
        _admin(
            f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)',
            f'CREATE DATABASE "{name}" TEMPLATE "{template}"',
        )
    )
