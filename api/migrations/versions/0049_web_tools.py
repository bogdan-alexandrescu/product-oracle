"""H7 Competitive digest, lane 1: Oracle's web tools

``web_searches`` (one row per search sent to the provider) and ``web_results`` (every
search result and page a run read, under a ref ``w-<n>`` unique in the run), and the
``read:web`` run-token scope. The scope is added to the ``run_tokens`` check as it is
now, so scopes other lanes add to it survive. The ``web_searches_per_month`` setting
needs no schema: its default lives in ``oracle.tenant_settings_api.DEFAULTS``.

Live-safe: two new tables, and a check rebuilt on ``run_tokens`` (a short lock; the wait
for it is capped by LOCK_TIMEOUT).

The downgrade refuses while a live run token holds ``read:web``. Otherwise it deletes the
expired tokens that held it, drops the tables, the scope and any stored
``web_searches_per_month`` setting.

Revision ID: 0049_web_tools
Revises: 0048_scope_review
"""

import re
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy import text

revision: str = "0049_web_tools"
down_revision: str | None = "0048_scope_review"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"
SCOPE = "read:web"
CHECK = "ck_run_tokens_scopes"
_VALUE = re.compile(r"'((?:[^']|'')*)'")


def _scopes() -> list[str]:
    definition = op.get_bind().scalar(
        text(
            "SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c "
            "JOIN pg_class t ON t.oid = c.conrelid "
            "WHERE c.conname = :name AND t.relname = 'run_tokens' AND c.contype = 'c'"
        ),
        {"name": CHECK},
    )
    if definition is None:
        raise RuntimeError(f"check constraint {CHECK} on run_tokens not found")
    return [v.replace("''", "'") for v in _VALUE.findall(definition)]


def _set_scopes(values: list[str]) -> None:
    listed = ", ".join("'" + v.replace("'", "''") + "'" for v in values)
    op.drop_constraint(op.f(CHECK), "run_tokens", type_="check")
    op.create_check_constraint(
        op.f(CHECK), "run_tokens", f"cardinality(scopes) > 0 AND scopes <@ ARRAY[{listed}]::text[]"
    )


def _tenant_fk(table: str) -> sa.ForeignKeyConstraint:
    return sa.ForeignKeyConstraint(
        ["tenant_id"],
        ["tenants.id"],
        name=op.f(f"fk_{table}_tenant_id_tenants"),
        ondelete="CASCADE",
    )


def _run_fk(table: str) -> sa.ForeignKeyConstraint:
    return sa.ForeignKeyConstraint(
        ["run_id"], ["runs.id"], name=op.f(f"fk_{table}_run_id_runs"), ondelete="CASCADE"
    )


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.create_table(
        "web_searches",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("run_id", sa.Uuid(), nullable=False),
        sa.Column("query", sa.Text(), nullable=False),
        sa.Column("results", sa.Integer(), nullable=False),
        sa.Column(
            "searched_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        _tenant_fk("web_searches"),
        _run_fk("web_searches"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_web_searches")),
    )
    op.create_index(op.f("ix_web_searches_tenant_id"), "web_searches", ["tenant_id"])
    op.create_index(op.f("ix_web_searches_run_id"), "web_searches", ["run_id"])
    op.create_index("ix_web_searches_month", "web_searches", ["tenant_id", "searched_at"])
    op.create_table(
        "web_results",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("run_id", sa.Uuid(), nullable=False),
        sa.Column("ref", sa.Text(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("query", sa.Text(), nullable=True),
        sa.Column("url", sa.Text(), nullable=False),
        sa.Column("host", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=True),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("published_on", sa.Date(), nullable=True),
        sa.Column(
            "fetched_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint("kind IN ('search_result', 'page')", name=op.f("ck_web_results_kind")),
        _tenant_fk("web_results"),
        _run_fk("web_results"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_web_results")),
        sa.UniqueConstraint("run_id", "ref", name=op.f("uq_web_results_run_id_ref")),
    )
    op.create_index(op.f("ix_web_results_tenant_id"), "web_results", ["tenant_id"])
    op.create_index("ix_web_results_month", "web_results", ["tenant_id", "fetched_at"])
    now = _scopes()
    if SCOPE not in now:
        _set_scopes([*now, SCOPE])


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    bind = op.get_bind()
    live = bind.scalar(
        text(
            "SELECT count(*) FROM run_tokens WHERE :s = ANY(scopes) "
            "AND revoked_at IS NULL AND expires_at > now()"
        ),
        {"s": SCOPE},
    )
    if live:
        raise RuntimeError(
            f"{live} live run token(s) hold {SCOPE}: let them expire (or revoke them) first"
        )
    bind.execute(text("DELETE FROM run_tokens WHERE :s = ANY(scopes)"), {"s": SCOPE})
    bind.execute(text("DELETE FROM tenant_settings WHERE key = 'web_searches_per_month'"))
    op.drop_table("web_results")
    op.drop_table("web_searches")
    now = _scopes()
    if SCOPE in now:
        _set_scopes([v for v in now if v != SCOPE])
