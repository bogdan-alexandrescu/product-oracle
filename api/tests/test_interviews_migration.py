"""Migration 0032_interviews: two new tables, the request FK, interview jobs; reversible.

Sync tests on purpose (Alembic runs its own event loop); own scratch database.
"""

import asyncio
import uuid

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import make_url

from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

REVISION = "0032_interviews"
BEFORE = "0031_basis_verification"
SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_interviews")
    .render_as_string(hide_password=False)
)


def _cfg() -> Config:
    cfg = Config(str(API_DIR / "alembic.ini"))
    cfg.attributes["database_url"] = SCRATCH_URL
    return cfg


def _run(sql: str, **params):
    async def go():
        from sqlalchemy.ext.asyncio import create_async_engine

        engine = create_async_engine(SCRATCH_URL)
        async with engine.begin() as conn:
            result = await conn.execute(text(sql), params)
            rows = result.all() if result.returns_rows else None
        await engine.dispose()
        return rows

    return asyncio.run(go())


def _tables() -> set[str]:
    rows = _run(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN "
        "('interviews', 'interview_messages')"
    )
    return {r[0] for r in rows}


def _check(constraint: str) -> str:
    return _run(
        "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = :n", n=constraint
    )[0][0]


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def test_chains_after_mains_head_with_a_single_head():
    """protects=one alembic head; fails_when=the migration forks the chain;
    no_claim=other lanes' later migrations."""
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision(REVISION).down_revision == BEFORE
    assert script.get_heads() == ["0072_live_tokens"]


def test_the_migration_imports_no_application_code():
    """protects=a migration runs as written forever; fails_when=it imports oracle code
    that can change after it ships; no_claim=what the frozen helpers do."""
    source = (API_DIR / "migrations" / "versions" / f"{REVISION}.py").read_text()
    assert "from oracle" not in source and "import oracle" not in source


def test_upgrade_on_a_seeded_db_and_downgrade_reverses(scratch_db):
    """protects=additive tables, checks and FKs, a clean downgrade that keeps requests;
    fails_when=a check is missing, other lanes' job kinds are dropped, or the downgrade
    leaves a table or loses a request; no_claim=the routes."""
    cfg = _cfg()
    command.upgrade(cfg, BEFORE)
    t, user = uuid.uuid4(), uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Example Co')", t=t)
    kinds_before = _check("ck_llm_jobs_kind")

    command.upgrade(cfg, REVISION)
    assert _tables() == {"interviews", "interview_messages"}
    for kind in ("interview_guide", "interview_snapshot", "decision_options", "intake_analysis"):
        assert f"'{kind}'" in _check("ck_llm_jobs_kind")
    assert "interview_id IS NOT NULL" in _check("ck_llm_jobs_subject")
    assert "decision_id IS NOT NULL" in _check("ck_llm_jobs_subject")
    iv = uuid.uuid4()
    with pytest.raises(Exception, match="ck_interviews_customer"):
        _run(
            "INSERT INTO interviews (id, tenant_id, kind, title, created_by) "
            "VALUES (:i, :t, 'customer', 'Reordering', :u)",
            i=iv, t=t, u=user,
        )  # fmt: skip
    _run(
        "INSERT INTO interviews (id, tenant_id, kind, title, topic, interviewee_name, created_by)"
        " VALUES (:i, :t, 'customer', 'Reordering', 'Reordering', 'Ana Lima', :u)",
        i=iv, t=t, u=user,
    )  # fmt: skip
    assert _run("SELECT status, position, followed_up, lock_version FROM interviews") == [
        ("draft", 0, False, 1)
    ]
    _run(
        "INSERT INTO llm_jobs (id, tenant_id, kind, status, interview_id) "
        "VALUES (gen_random_uuid(), :t, 'interview_guide', 'queued', :i)",
        t=t, i=iv,
    )  # fmt: skip
    _run(
        "INSERT INTO product_requests (id, tenant_id, title, channel, origin, interview_id, "
        "verified) VALUES (gen_random_uuid(), :t, 'Keep the address', 'interview', 'interview', "
        ":i, false)",
        t=t, i=iv,
    )  # fmt: skip
    with pytest.raises(Exception, match="fk_product_requests_interview_id_interviews"):
        _run("UPDATE product_requests SET interview_id = gen_random_uuid()")

    command.downgrade(cfg, BEFORE)
    assert _tables() == set()
    assert _check("ck_llm_jobs_kind") == kinds_before
    assert _run("SELECT title, interview_id FROM product_requests") == [("Keep the address", None)]
    assert _run("SELECT count(*) FROM llm_jobs") == [(0,)]
    command.upgrade(cfg, REVISION)


def test_the_models_match_the_migrated_checks(scratch_db):
    """protects=one list per check in the models; fails_when=the database allows a job
    kind the models do not name; no_claim=the job runners."""
    from oracle.jobs.models import ALL_JOB_KINDS

    command.upgrade(_cfg(), "head")
    assert set(_check("ck_llm_jobs_kind").split("'")[1::2]) == set(ALL_JOB_KINDS)
