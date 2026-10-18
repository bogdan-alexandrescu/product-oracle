"""Migration 0005 (API tokens can act for a user): up, down and up again."""

import uuid

from alembic import command

from tests.test_migrations import _cfg, _run, scratch_db  # noqa: F401


def _columns() -> set[str]:
    rows = _run(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'api_tokens'"
    )
    return {r[0] for r in rows}


def test_0005_up_down_up(scratch_db):  # noqa: F811
    cfg = _cfg()
    command.upgrade(cfg, "0004")
    tenant, user = uuid.uuid4(), uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:id, 'Example Co')", id=tenant)
    _run(
        "INSERT INTO users (id, tenant_id, email, password_hash, role) "
        "VALUES (:u, :t, 'admin@example.com', 'x', 'owner')",
        u=user,
        t=tenant,
    )
    # A token from before 0005 keeps working without a user.
    _run(
        "INSERT INTO api_tokens (id, tenant_id, name, token_hash) VALUES (:i, :t, 'ci', 'h1')",
        i=uuid.uuid4(),
        t=tenant,
    )
    assert "user_id" not in _columns()

    command.upgrade(cfg, "0005")
    assert "user_id" in _columns()
    assert _run("SELECT user_id FROM api_tokens") == [(None,)]
    _run(
        "INSERT INTO api_tokens (id, tenant_id, name, token_hash, user_id) "
        "VALUES (:i, :t, 'cli', 'h2', :u)",
        i=uuid.uuid4(),
        t=tenant,
        u=user,
    )
    # Deleting the user removes the tokens that act for them, not the others.
    _run("DELETE FROM users WHERE id = :u", u=user)
    assert _run("SELECT name FROM api_tokens") == [("ci",)]

    command.downgrade(cfg, "0004")
    assert "user_id" not in _columns()
    assert _run("SELECT count(*) FROM api_tokens") == [(1,)]

    command.upgrade(cfg, "head")
    assert "user_id" in _columns()
