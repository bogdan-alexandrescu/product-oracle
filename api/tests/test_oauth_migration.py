"""Migration 0004 (OAuth for MCP clients): up, down and up again on a scratch database."""

import uuid

from alembic import command

from tests.test_migrations import _cfg, _run, _tables, scratch_db  # noqa: F401

OAUTH_TABLES = {"oauth_clients", "oauth_codes", "oauth_tokens"}


def test_0004_up_down_up(scratch_db):  # noqa: F811
    cfg = _cfg()
    command.upgrade(cfg, "0003")
    assert not (OAUTH_TABLES & _tables())

    command.upgrade(cfg, "0004")
    assert OAUTH_TABLES <= _tables()
    tenant, user, client = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:id, 'Example Co')", id=tenant)
    _run(
        "INSERT INTO users (id, tenant_id, email, password_hash, role) "
        "VALUES (:u, :t, 'admin@example.com', 'x', 'owner')",
        u=user,
        t=tenant,
    )
    _run(
        "INSERT INTO oauth_clients (id, tenant_id, client_id, name, redirect_uris) "
        "VALUES (:c, :t, 'pocl_1', 'Example Agent', ARRAY['https://agent.example.com/cb'])",
        c=client,
        t=tenant,
    )
    _run(
        "INSERT INTO oauth_tokens (id, tenant_id, access_hash, refresh_hash, client_id, user_id, "
        "scope, expires_at, refresh_expires_at, family_id) VALUES (:i, :t, 'a', 'r', :c, :u, "
        "'oracle:read', now(), now(), :i)",
        i=uuid.uuid4(),
        t=tenant,
        c=client,
        u=user,
    )
    # Hashes are unique: the same access token cannot be stored twice.
    try:
        _run(
            "INSERT INTO oauth_tokens (id, tenant_id, access_hash, refresh_hash, client_id, "
            "user_id, scope, expires_at, refresh_expires_at, family_id) VALUES (:i, :t, 'a', "
            "'r2', :c, :u, 'oracle:read', now(), now(), :i)",
            i=uuid.uuid4(),
            t=tenant,
            c=client,
            u=user,
        )
        raise AssertionError("duplicate access hash accepted")
    except Exception as e:
        assert "uq_oauth_tokens_access_hash" in str(e)
    # Deleting a user removes their tokens.
    _run("DELETE FROM users WHERE id = :u", u=user)
    assert _run("SELECT count(*) FROM oauth_tokens") == [(0,)]

    command.downgrade(cfg, "0003")
    assert not (OAUTH_TABLES & _tables())
    assert _run("SELECT count(*) FROM tenants") == [(1,)]

    command.upgrade(cfg, "head")
    assert OAUTH_TABLES <= _tables()
