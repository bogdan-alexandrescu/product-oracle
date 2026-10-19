"""Migration 0014_intake: additive on 0013, document jobs untouched, reversible.

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

SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_intake")
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


@pytest.fixture
def scratch_db():
    asyncio.run(_reset_schema(SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(SCRATCH_URL))


def test_0014_intake_chains_on_the_foundation():
    script = ScriptDirectory.from_config(_cfg())
    assert script.get_revision("0014_intake").down_revision == "0013"


def test_upgrade_keeps_document_jobs_and_downgrade_reverses(scratch_db):
    cfg = _cfg()
    command.upgrade(cfg, "0013")
    t, doc = uuid.uuid4(), uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Example Co')", t=t)
    _run(
        "INSERT INTO documents (id, tenant_id, slug, title, status) "
        "VALUES (:d, :t, 'legacy', 'Legacy', 'draft')",
        d=doc,
        t=t,
    )
    _run(
        "INSERT INTO llm_jobs (id, tenant_id, kind, document_id, status) "
        "VALUES (gen_random_uuid(), :t, 'reporting', :d, 'queued')",
        t=t,
        d=doc,
    )

    command.upgrade(cfg, "0014_intake")
    assert _run("SELECT kind, document_id, intake_id FROM llm_jobs") == [("reporting", doc, None)]
    intake = uuid.uuid4()
    _run(
        "INSERT INTO product_intakes (id, tenant_id, title, brief) "
        "VALUES (:i, :t, 'Saved addresses', 'Returning buyers retype addresses.')",
        i=intake,
        t=t,
    )
    _run(
        "INSERT INTO llm_jobs (id, tenant_id, kind, intake_id, status) "
        "VALUES (gen_random_uuid(), :t, 'intake_analysis', :i, 'queued')",
        t=t,
        i=intake,
    )
    _run(
        "INSERT INTO intake_proposals (id, tenant_id, intake_id, kind, title) "
        "VALUES (gen_random_uuid(), :t, :i, 'research_run', 'Research the metric')",
        t=t,
        i=intake,
    )
    # A job belongs to a document or an intake; a proposal kind is checked.
    with pytest.raises(Exception, match="ck_llm_jobs_subject"):
        _run(
            "INSERT INTO llm_jobs (id, tenant_id, kind, status) "
            "VALUES (gen_random_uuid(), :t, 'reporting', 'queued')",
            t=t,
        )
    with pytest.raises(Exception, match="ck_intake_proposals_kind"):
        _run(
            "INSERT INTO intake_proposals (id, tenant_id, intake_id, kind, title) "
            "VALUES (gen_random_uuid(), :t, :i, 'run_now', 'x')",
            t=t,
            i=intake,
        )

    command.downgrade(cfg, "0013")
    assert _run("SELECT kind FROM llm_jobs") == [("reporting",)]
    with pytest.raises(Exception, match="ck_llm_jobs_kind"):
        _run(
            "INSERT INTO llm_jobs (id, tenant_id, kind, document_id, status) "
            "VALUES (gen_random_uuid(), :t, 'intake_analysis', :d, 'queued')",
            t=t,
            d=doc,
        )
    command.upgrade(cfg, "0014_intake")
    assert _run("SELECT count(*) FROM intake_proposals") == [(0,)]


def test_rule_made_gaps_are_keyed_by_category_not_by_text(scratch_db):
    """Round 3 (S6): a rule-made gap carries its category key, backfilled from the
    statements as they stand at this revision; model and person gaps carry none."""
    cfg = _cfg()
    command.upgrade(cfg, "0013")
    t, intake, person = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Example Co')", t=t)
    _run(
        "INSERT INTO product_intakes (id, tenant_id, title, brief) "
        "VALUES (:i, :t, 'Saved addresses', 'Returning buyers retype addresses.')",
        i=intake,
        t=t,
    )
    rows = {
        "rule": ("ownership", "No team or person owns the outcome.", None),
        "model": ("ownership", "Is the checkout team staffed for this?", None),
        "person": ("ownership", "No team or person owns the outcome.", person),
    }
    ids = {}
    for name, (category, statement, created_by) in rows.items():
        ids[name] = uuid.uuid4()
        _run(
            "INSERT INTO knowledge_gaps (id, tenant_id, intake_id, category, statement, "
            "impact, importance, created_by) VALUES (:g, :t, :i, :c, :s, '{}', 'high', :by)",
            g=ids[name], t=t, i=intake, c=category, s=statement, by=created_by,
        )  # fmt: skip
    command.upgrade(cfg, "0014_intake")
    keys = dict(_run("SELECT id, rule_key FROM knowledge_gaps"))
    assert keys == {ids["rule"]: "ownership", ids["model"]: None, ids["person"]: None}
    command.downgrade(cfg, "0013")
    columns = _run(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'knowledge_gaps'"
    )
    assert ("rule_key",) not in columns


def test_existing_intakes_withhold_everything_their_analysis_names(scratch_db):
    """Round 5 (S6, owner 2026-10-19): an intake analysed before reads were recorded
    withholds, fail closed, every item its stored analysis names from its author's
    runs; the legacy importance rows get their index."""
    import json

    cfg = _cfg()
    command.upgrade(cfg, "0013")
    t, intake, author = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    ids = [str(uuid.uuid4()) for _ in range(6)]
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Example Co')", t=t)
    analysis = {
        "relevant_item_ids": [ids[0]],
        "stale": [{"item_id": ids[1], "freshness": 0.1}],
        "conflicts": [{"claims": [{"item_id": ids[2]}, {"item_id": ids[0]}]}],
        "findings": {
            "f1": {"kind": "gap", "source_item_ids": [ids[3]], "sharing": "full"},
            "f2": {"kind": "gap", "evidence_ids": [ids[4]]},
        },
    }
    _run(
        "INSERT INTO product_intakes (id, tenant_id, title, brief, author_id, analysis) "
        "VALUES (:i, :t, 'Saved addresses', 'Returning buyers.', :a, CAST(:an AS jsonb))",
        i=intake,
        t=t,
        a=author,
        an=json.dumps(analysis),
    )
    command.upgrade(cfg, "0014_intake")
    rows = _run("SELECT intake_id, user_id, item_id FROM intake_withheld_items")
    assert {(r[0], r[1]) for r in rows} == {(intake, author)}
    assert sorted(str(r[2]) for r in rows) == sorted(ids[:5])
    names = [r[0] for r in _run("SELECT indexname FROM pg_indexes")]
    assert "ix_knowledge_gaps_legacy_importance" in names
    command.downgrade(cfg, "0013")
    command.upgrade(cfg, "0014_intake")


def test_the_backfills_skip_malformed_item_ids_and_record_full_findings(scratch_db):
    """Round 6: a stored analysis naming an id that is not a UUID never aborts the
    migration (the id is skipped); the items findings shared in full cite are recorded
    (intake_shared_items); proposals may be withdrawn."""
    import json

    cfg = _cfg()
    command.upgrade(cfg, "0013")
    t, intake, author = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    ids = [str(uuid.uuid4()) for _ in range(3)]
    _run("INSERT INTO tenants (id, name) VALUES (:t, 'Example Co')", t=t)
    analysis = {
        "read_item_ids": [ids[0], "not-a-uuid"],
        "stale": [{"item_id": "", "freshness": 0.1}],
        "findings": {
            "f1": {"kind": "gap", "source_item_ids": [ids[1], "item-7"], "sharing": "full"},
            "f2": {"kind": "gap", "source_item_ids": [ids[2]], "sharing": "summary"},
        },
    }
    _run(
        "INSERT INTO product_intakes (id, tenant_id, title, brief, author_id, analysis) "
        "VALUES (:i, :t, 'Saved addresses', 'Returning buyers.', :a, CAST(:an AS jsonb))",
        i=intake,
        t=t,
        a=author,
        an=json.dumps(analysis),
    )
    command.upgrade(cfg, "0014_intake")
    withheld = _run("SELECT item_id FROM intake_withheld_items")
    assert sorted(str(r[0]) for r in withheld) == sorted(ids)
    shared = _run("SELECT intake_id, user_id, item_id FROM intake_shared_items")
    assert [(r[0], r[1], str(r[2])) for r in shared] == [(intake, author, ids[1])]
    checks = _run(
        "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'ck_proposals_status'"
    )
    assert "withdrawn" in checks[0][0]
    command.downgrade(cfg, "0013")
    command.upgrade(cfg, "0014_intake")
