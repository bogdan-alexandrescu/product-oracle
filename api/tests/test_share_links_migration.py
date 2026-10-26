"""Migration 0073_share_links (O5 lane 3): up, down and up again."""

import uuid

import pytest
from alembic import command
from sqlalchemy.exc import IntegrityError

from tests.test_migrations import _cfg, _run, scratch_db  # noqa: F401


def _tables() -> set[str]:
    rows = _run(
        "SELECT table_name FROM information_schema.tables "
        "WHERE table_name IN ('share_links', 'share_link_views')"
    )
    return {r[0] for r in rows}


def _columns(table: str) -> set[str]:
    rows = _run("SELECT column_name FROM information_schema.columns WHERE table_name = :t", t=table)
    return {r[0] for r in rows}


def test_0057_up_down_up(scratch_db):  # noqa: F811
    cfg = _cfg()
    command.upgrade(cfg, "0072_public_texts")
    assert _tables() == set()
    command.upgrade(cfg, "0073_share_links")
    assert _tables() == {"share_links", "share_link_views"}
    # Counts only (O5-Q4): no column could hold an address or an identity.
    assert not _columns("share_link_views") & {"ip", "address", "user_agent", "user_id"}
    assert "passcode_hash" in _columns("share_links")
    tenant, doc, version, pub = (uuid.uuid4() for _ in range(4))
    _run("INSERT INTO tenants (id, name) VALUES (:id, 'Example Labs')", id=tenant)
    _run(
        "INSERT INTO documents (id, tenant_id, slug, title, kind, status) "
        "VALUES (:d, :t, 'example-roadmap', 'Roadmap', 'roadmap', 'approved')",
        d=doc,
        t=tenant,
    )
    insert = (
        "INSERT INTO share_links (id, tenant_id, document_id, publication_id, audience, "
        "label, token_hash, passcode_hash, created_by, expires_at) "
        "VALUES (:i, :t, :d, :p, :a, 'Board, October meeting', :h, '$argon2id$x', :t, "
        "now() + interval '14 days')"
    )
    # The publication must exist.
    with pytest.raises(IntegrityError):
        _run(insert, i=uuid.uuid4(), t=tenant, d=doc, p=pub, a="board", h="a" * 64)
    assert version is not None
    command.downgrade(cfg, "0072_public_texts")
    assert _tables() == set()
    command.upgrade(cfg, "0073_share_links")
    assert _tables() == {"share_links", "share_link_views"}
