"""Migration 0014_member_disable backfill (C2, round 4): approvals by people demoted
before the disable change lapse for good, so a later promotion never revives them.

Sync tests on purpose: Alembic's env.py runs its own event loop. Own scratch database,
so it can run beside the other migration tests. Synthetic placeholders only.
"""

import asyncio
import uuid

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import text
from sqlalchemy.engine import make_url

from tests.conftest import API_DIR, TEST_DATABASE_URL, _reset_schema

SCRATCH_URL = (
    make_url(TEST_DATABASE_URL)
    .set(database=make_url(TEST_DATABASE_URL).database + "_migrations_c2")
    .render_as_string(hide_password=False)
)
REASON = "demoted before this change"


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


def _populate() -> dict[str, uuid.UUID]:
    """At 0014_review: two documents approved; one approver since demoted to commenter,
    one still an approver, one user-less owner token."""
    ids = {k: uuid.uuid4() for k in (
        "tenant", "demoted", "approver", "token",
        "doc_a", "doc_b", "a1", "b1", "b2",
        "r_demoted", "r_demoted_changes", "r_approver", "r_token",
    )}  # fmt: skip
    _run("INSERT INTO tenants (id, name) VALUES (:id, 'Example Co')", id=ids["tenant"])
    for key, role in (("demoted", "commenter"), ("approver", "approver")):
        _run(
            "INSERT INTO users (id, tenant_id, email, password_hash, role) "
            "VALUES (:u, :t, :e, 'x', :r)",
            u=ids[key],
            t=ids["tenant"],
            e=f"{key}@example.com",
            r=role,
        )
    _run(
        "INSERT INTO api_tokens (id, tenant_id, name, token_hash, role) "
        "VALUES (:i, :t, 'ci', 'h1', 'owner')",
        i=ids["token"],
        t=ids["tenant"],
    )
    for doc in ("doc_a", "doc_b"):
        _run(
            "INSERT INTO documents (id, tenant_id, slug, title, status) "
            "VALUES (:i, :t, :s, 'Doc', 'approved')",
            i=ids[doc],
            t=ids["tenant"],
            s=doc.replace("_", "-"),
        )
    # doc_a v1: approved by the demoted member only. doc_b v1 by the demoted member,
    # doc_b v2 by the current approver.
    for vid, doc, n, by in (
        ("a1", "doc_a", 1, "demoted"),
        ("b1", "doc_b", 1, "demoted"),
        ("b2", "doc_b", 2, "approver"),
    ):
        _run(
            "INSERT INTO document_versions (id, tenant_id, document_id, number, markdown, "
            "content_hash, approved_at, approved_by) "
            "VALUES (:i, :t, :d, :n, '# Doc', :h, now(), :by)",
            i=ids[vid],
            t=ids["tenant"],
            d=ids[doc],
            n=n,
            h=f"h{n}",
            by=ids[by],
        )
    for rid, by, verdict in (
        ("r_demoted", "demoted", "approved"),
        ("r_demoted_changes", "demoted", "changes_requested"),
        ("r_approver", "approver", "approved"),
        ("r_token", "token", "approved"),
    ):
        _run(
            "INSERT INTO section_reviews (id, tenant_id, version_id, section_key, verdict, "
            "reviewer_id) VALUES (:i, :t, :v, 'goal', :verdict, :by)",
            i=ids[rid],
            t=ids["tenant"],
            v=ids["a1"],
            verdict=verdict,
            by=ids[by],
        )
    return ids


def test_upgrade_lapses_approvals_of_members_demoted_before_it(scratch_db):
    cfg = _cfg()
    command.upgrade(cfg, "0014_review")
    ids = _populate()
    command.upgrade(cfg, "0014_member_disable")

    reviews = {
        r[0]: (r[1], r[2])
        for r in _run("SELECT id, lapsed_at IS NOT NULL, lapse_reason FROM section_reviews")
    }
    assert reviews[ids["r_demoted"]] == (True, REASON)
    # An objection never lapses; a current approver's and a token's approvals stand.
    assert reviews[ids["r_demoted_changes"]] == (False, None)
    assert reviews[ids["r_approver"]] == (False, None)
    assert reviews[ids["r_token"]] == (False, None)

    versions = {
        r[0]: r[1:]
        for r in _run(
            "SELECT id, approved_at IS NULL, approved_by, approval_lapsed_at IS NOT NULL, "
            "approval_lapsed_by, approval_lapse_reason FROM document_versions"
        )
    }
    for vid in ("a1", "b1"):
        assert versions[ids[vid]] == (True, None, True, ids["demoted"], REASON)
    # Kept in the version's lapse history too (a new approval never clears it).
    [(history,)] = _run("SELECT approval_lapses FROM document_versions WHERE id = :i", i=ids["a1"])
    [entry] = history
    assert entry["approved_by"] == str(ids["demoted"]) and entry["reason"] == REASON
    assert entry["approved_at"] and entry["lapsed_at"]
    assert versions[ids["b2"]] == (False, ids["approver"], False, None, None)

    status = dict(_run("SELECT id, status FROM documents"))
    # doc_a has no approved version left; doc_b keeps its current approver's.
    assert status[ids["doc_a"]] == "in_review"
    assert status[ids["doc_b"]] == "approved"

    # A promotion after the upgrade revives nothing: the lapse is recorded for good.
    _run("UPDATE users SET role = 'approver' WHERE id = :u", u=ids["demoted"])
    assert _run(
        "SELECT lapsed_at IS NOT NULL FROM section_reviews WHERE id = :i", i=ids["r_demoted"]
    ) == [(True,)]

    # The downgrade guard still refuses while an approval is lapsed.
    with pytest.raises(RuntimeError, match="lapsed"):
        command.downgrade(cfg, "0014_review")
