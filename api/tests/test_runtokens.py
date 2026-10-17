import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select, update

from oracle.runs.models import Run
from oracle.runtokens import (
    SCOPES,
    RunToken,
    UnknownScopeError,
    mint_run_token,
    revoke_run_tokens,
    verify_run_token,
)
from oracle.tenancy import tenant_session
from tests.conftest import make_tenant


async def _run(db) -> uuid.UUID:
    run = Run(flow="baseline_to_prd")
    db.add(run)
    await db.flush()
    return run.id


async def test_mint_and_verify(db, tenant_id):
    run_id = await _run(db)
    raw = await mint_run_token(db, run_id, ["read:sources", "write:proposals"], ttl_seconds=600)
    await db.commit()
    assert raw.startswith("ort_")

    token = await db.scalar(select(RunToken))
    assert token.token_hash != raw and raw not in token.token_hash
    assert token.expires_at > datetime.now(UTC) + timedelta(seconds=590)

    claims = await verify_run_token(raw)
    assert claims is not None
    assert (claims.tenant_id, claims.run_id) == (tenant_id, run_id)
    assert claims.scopes == {"read:sources", "write:proposals"}

    await db.refresh(token)
    assert token.last_used_at is not None


async def test_unknown_tokens_are_refused(db):
    run_id = await _run(db)
    raw = await mint_run_token(db, run_id, SCOPES, ttl_seconds=60)
    await db.commit()
    assert await verify_run_token(raw + "x") is None
    assert await verify_run_token("ort_" + "a" * 43) is None
    assert await verify_run_token("") is None
    assert await verify_run_token(raw.removeprefix("ort_")) is None


async def test_expired_token_is_refused(db):
    run_id = await _run(db)
    raw = await mint_run_token(db, run_id, ["read:baseline"], ttl_seconds=60)
    await db.execute(update(RunToken).values(expires_at=datetime.now(UTC) - timedelta(seconds=1)))
    await db.commit()
    assert await verify_run_token(raw) is None


async def test_revoke_only_affects_that_run(db):
    run_a, run_b = await _run(db), await _run(db)
    a1 = await mint_run_token(db, run_a, ["read:documents"], ttl_seconds=60)
    a2 = await mint_run_token(db, run_a, ["write:drafts"], ttl_seconds=60)
    b1 = await mint_run_token(db, run_b, ["read:documents"], ttl_seconds=60)
    await db.commit()

    assert await revoke_run_tokens(db, run_a) == 2
    await db.commit()
    assert await verify_run_token(a1) is None
    assert await verify_run_token(a2) is None
    assert await verify_run_token(b1) is not None
    assert await revoke_run_tokens(db, run_a) == 0


async def test_unknown_or_missing_scopes_are_refused(db):
    run_id = await _run(db)
    with pytest.raises(UnknownScopeError, match="admin"):
        await mint_run_token(db, run_id, ["read:sources", "admin"], ttl_seconds=60)
    with pytest.raises(UnknownScopeError):
        await mint_run_token(db, run_id, [], ttl_seconds=60)
    with pytest.raises(ValueError):
        await mint_run_token(db, run_id, ["read:sources"], ttl_seconds=0)
    assert (await db.scalars(select(RunToken))).all() == []


async def test_the_database_refuses_unknown_scopes_too(db):
    from sqlalchemy.exc import IntegrityError

    run_id = await _run(db)
    db.add(
        RunToken(
            run_id=run_id,
            token_hash="x" * 64,
            scopes=["write:everything"],
            expires_at=datetime.now(UTC),
        )
    )
    with pytest.raises(IntegrityError, match="ck_run_tokens_scopes"):
        await db.flush()


async def test_cannot_mint_for_another_tenants_run(db):
    run_id = await _run(db)
    await db.commit()
    other = await make_tenant("Other Co")
    async with tenant_session(other) as s:
        with pytest.raises(LookupError):
            await mint_run_token(s, run_id, ["read:sources"], ttl_seconds=60)

    raw = await mint_run_token(db, run_id, ["read:sources"], ttl_seconds=60)
    await db.commit()
    async with tenant_session(other) as s:
        assert await revoke_run_tokens(s, run_id) == 0
        await s.commit()
    assert await verify_run_token(raw) is not None
