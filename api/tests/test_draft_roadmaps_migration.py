"""Migration 0034_draft_roadmaps (E1 Roadmap per PRD draft): additive, reversible, and a
roadmap version's items are byte-identical across upgrade, downgrade and upgrade.

Sync tests on purpose: Alembic's env.py runs its own event loop. Own scratch database.
"""

import uuid

import pytest
from alembic import command
from alembic.script import ScriptDirectory
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError

from tests import test_roadmap_migration as base
from tests.conftest import TEST_DATABASE_URL, _reset_schema

base.SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_draft_roadmaps")
    .render_as_string(hide_password=False)
)
REVISION = "0034_draft_roadmaps"
PREVIOUS = "0033_question_retired"
# Every column a roadmap version's item had before the migration.
ITEMS = "SELECT (to_jsonb(r) - 'draft_roadmap_id')::text FROM roadmap_items r ORDER BY id"


@pytest.fixture
def scratch_db():
    import asyncio

    asyncio.run(_reset_schema(base.SCRATCH_URL))
    yield
    asyncio.run(_reset_schema(base.SCRATCH_URL))


def test_0030_chains_on_the_single_head():
    script = ScriptDirectory.from_config(base._cfg())
    assert script.get_revision(REVISION).down_revision == PREVIOUS
    assert script.get_heads() == ["0092_bet_flow_line_key"]


def _seed() -> None:
    tenant, prd, rm = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    pv, rv = uuid.uuid4(), uuid.uuid4()
    run = base._run
    run("INSERT INTO tenants (id, name) VALUES (:id, 'Example Co')", id=tenant)
    for doc, slug, kind in ((prd, "example-prd", "prd"), (rm, "example-roadmap", "roadmap")):
        run(
            "INSERT INTO documents (id, tenant_id, slug, title, kind, status) "
            "VALUES (:id, :t, :s, 'Example', :k, 'draft')",
            id=doc, t=tenant, s=slug, k=kind,
        )  # fmt: skip
    for v, doc in ((pv, prd), (rv, rm)):
        run(
            "INSERT INTO document_versions (id, tenant_id, document_id, number, markdown, "
            "content_hash) VALUES (:id, :t, :d, 1, '# Example', 'h')",
            id=v, t=tenant, d=doc,
        )  # fmt: skip
    run(
        "INSERT INTO roadmap_items (id, tenant_id, roadmap_document_id, roadmap_version_id, "
        "item_key, position, title, horizon, prd_document_id, prd_version_id) "
        "VALUES (:id, :t, :rm, :rv, 'payment-step', 0, 'Payment step', 'now', :prd, :pv)",
        id=uuid.uuid4(), t=tenant, rm=rm, rv=rv, prd=prd, pv=pv,
    )  # fmt: skip
    return tenant, prd, pv


def test_upgrade_downgrade_upgrade_keeps_roadmap_items(scratch_db):
    """protects: criterion 15, the migration is additive and reversible; fails_when: a
    roadmap version's item changes, a draft item survives the downgrade, or an item
    with two owners is accepted; no_claim: live lock behaviour."""
    cfg = base._cfg()
    command.upgrade(cfg, PREVIOUS)
    tenant, prd, pv = _seed()
    before = base._run(ITEMS)
    command.upgrade(cfg, REVISION)
    assert base._run(ITEMS) == before
    assert {"draft_roadmaps"} <= base._tables()
    draft = uuid.uuid4()
    base._run(
        "INSERT INTO draft_roadmaps (id, tenant_id, prd_document_id, prd_version_id) "
        "VALUES (:id, :t, :d, :v)",
        id=draft, t=tenant, d=prd, v=pv,
    )  # fmt: skip
    base._run(
        "INSERT INTO roadmap_items (id, tenant_id, draft_roadmap_id, item_key, position, "
        "title, horizon) VALUES (:id, :t, :dr, 'payment-step', 0, 'Payment step', 'now')",
        id=uuid.uuid4(), t=tenant, dr=draft,
    )  # fmt: skip
    with pytest.raises(IntegrityError):
        base._run(
            "INSERT INTO roadmap_items (id, tenant_id, item_key, position, title, horizon) "
            "VALUES (:id, :t, 'orphan', 0, 'Orphan', 'now')",
            id=uuid.uuid4(), t=tenant,
        )  # fmt: skip
    base._run(
        "INSERT INTO runs (id, tenant_id, flow, status) VALUES (:id, :t, 'prd_draft_items', "
        "'draft')",
        id=uuid.uuid4(), t=tenant,
    )  # fmt: skip
    command.downgrade(cfg, PREVIOUS)
    assert base._run(ITEMS) == before
    assert "draft_roadmaps" not in base._tables()
    assert base._run("SELECT count(*) FROM runs") == [(0,)]
    command.upgrade(cfg, REVISION)
    assert base._run(ITEMS) == before
    assert base._run("SELECT draft_roadmap_auto FROM documents LIMIT 1") == [(True,)]
