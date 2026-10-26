"""Migration 0056_public_texts (O5 lane 2): up, down and up again."""

import uuid

import pytest
from alembic import command
from sqlalchemy.exc import IntegrityError

from tests.test_migrations import _cfg, _run, scratch_db  # noqa: F401


def _tables() -> set[str]:
    rows = _run(
        "SELECT table_name FROM information_schema.tables "
        "WHERE table_name IN ('roadmap_public_texts', 'roadmap_public_checks')"
    )
    return {r[0] for r in rows}


def _doc_columns() -> set[str]:
    rows = _run(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'documents' "
        "AND column_name IN ('public_title', 'public_intro')"
    )
    return {r[0] for r in rows}


def test_0056_up_down_up(scratch_db):  # noqa: F811
    cfg = _cfg()
    command.upgrade(cfg, "0055_roadmap_audience")
    assert _tables() == set() and _doc_columns() == set()

    command.upgrade(cfg, "0056_public_texts")
    assert _tables() == {"roadmap_public_texts", "roadmap_public_checks"}
    assert _doc_columns() == {"public_title", "public_intro"}
    tenant, doc = uuid.uuid4(), uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:id, 'Example Labs')", id=tenant)
    _run(
        "INSERT INTO documents (id, tenant_id, slug, title, kind, status) "
        "VALUES (:d, :t, 'example-roadmap', 'Roadmap', 'roadmap', 'draft')",
        d=doc,
        t=tenant,
    )
    insert = (
        "INSERT INTO roadmap_public_texts (id, tenant_id, document_id, item_key, title, stage, "
        "drafted_by, source_hash, announced_quarter) "
        "VALUES (:i, :t, :d, :k, 'Import in one go', 'planned', 'oracle', 'h', :q)"
    )
    _run(insert, i=uuid.uuid4(), t=tenant, d=doc, k="bulk-import", q="2026-Q4")
    # A quarter is a quarter, never a day; one text per item.
    with pytest.raises(IntegrityError):
        _run(insert, i=uuid.uuid4(), t=tenant, d=doc, k="other", q="2026-11-03")
    with pytest.raises(IntegrityError):
        _run(insert, i=uuid.uuid4(), t=tenant, d=doc, k="bulk-import", q=None)
    _run(
        "INSERT INTO llm_jobs (id, tenant_id, kind, document_id, status, input, attempts) "
        "VALUES (:j, :t, 'public_text', :d, 'queued', '{}', 0)",
        j=uuid.uuid4(),
        t=tenant,
        d=doc,
    )

    command.downgrade(cfg, "0055_roadmap_audience")
    assert _tables() == set() and _doc_columns() == set()
    assert _run("SELECT count(*) FROM llm_jobs") == [(0,)]

    command.upgrade(cfg, "head")
    assert _tables() == {"roadmap_public_texts", "roadmap_public_checks"}
