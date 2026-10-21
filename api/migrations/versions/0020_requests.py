"""Requests (C1): request themes, product requests and the requests Oracle found in a
person's own sources; runs and checkpoints may be ``request_triage``.

Additive: three new tables, and ``ck_runs_flow`` and ``ck_checkpoints_kind`` each gain
``'request_triage'`` (read from the database at upgrade time, so values other lanes
added stay). No existing table changes shape.

The downgrade drops the three tables (the requests are lost) and removes the two values;
it refuses while a ``request_triage`` run or checkpoint exists (delete those runs first).


Revision ID: 0020_requests
Revises: 0014_member_follow_up_retry
"""

import re
from collections.abc import Sequence
from typing import Any

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0020_requests"
down_revision: str | None = "0020_alignment_reports"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Only this migration's values: the checks keep whatever other lanes' migrations added.
# oracle.runs.models.FLOWS and CHECKPOINT_KINDS stay the one list of every value.
FLOW = ("request_triage",)
CHECKS = (
    ("runs", "ck_runs_flow", "flow"),
    ("checkpoints", "ck_checkpoints_kind", "kind"),
)

CHANNELS = ("support", "sales", "team", "interview", "slack", "meeting", "doc", "other")
DISQUALIFY_REASONS = ("no_goal", "out_of_scope", "duplicate", "not_a_request", "wont_do", "other")


# --- oracle.migration_checks, frozen here as of this revision ----------------------------
# A migration must not import application code that can change after it ships; this is
# that module's behaviour, copied.

_VALUE = re.compile(r"'((?:[^']|'')*)'")


def check_values(table: str, constraint: str) -> list[str]:
    """The values a ``column IN (...)`` check constraint allows now, in its order."""
    definition = op.get_bind().scalar(
        sa.text(
            "SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c "
            "JOIN pg_class t ON t.oid = c.conrelid "
            "WHERE c.conname = :name AND t.relname = :table AND c.contype = 'c'"
        ),
        {"name": constraint, "table": table},
    )
    if definition is None:
        raise RuntimeError(f"check constraint {constraint} on {table} not found")
    return [v.replace("''", "'") for v in _VALUE.findall(definition)]


def _replace(table: str, constraint: str, column: str, values: list[str]) -> None:
    listed = ", ".join("'" + v.replace("'", "''") + "'" for v in values)
    op.drop_constraint(op.f(constraint), table, type_="check")
    op.create_check_constraint(op.f(constraint), table, f"{column} IN ({listed})")


def add_check_values(table: str, constraint: str, column: str, values: tuple[str, ...]) -> None:
    """Allow ``values`` too, keeping every value the constraint already allows."""
    now = check_values(table, constraint)
    missing = [v for v in values if v not in now]
    if missing:
        _replace(table, constraint, column, now + missing)


def remove_check_values(table: str, constraint: str, column: str, values: tuple[str, ...]) -> None:
    """Stop allowing ``values`` only, keeping every other value the constraint allows."""
    now = check_values(table, constraint)
    kept = [v for v in now if v not in values]
    if kept != now:
        _replace(table, constraint, column, kept)


# --- tables ------------------------------------------------------------------------------


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


def _base(table: str) -> list[Any]:
    """The id, company and creation columns every company table has."""
    return [
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),  # fmt: skip
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f(f"fk_{table}_tenant_id_tenants"),
            ondelete="CASCADE",
        ),  # fmt: skip
        sa.PrimaryKeyConstraint("id", name=op.f(f"pk_{table}")),
    ]


def _updated_at() -> sa.Column:
    return sa.Column(
        "updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
    )


def _lock_version() -> sa.Column:
    return sa.Column("lock_version", sa.Integer(), server_default="1", nullable=False)


def _uuids(name: str) -> sa.Column:
    return sa.Column(name, postgresql.ARRAY(sa.Uuid()), server_default="{}", nullable=False)


def _fk(table: str, column: str, target: str, ondelete: str) -> sa.ForeignKeyConstraint:
    return sa.ForeignKeyConstraint(
        [column], [f"{target}.id"], name=op.f(f"fk_{table}_{column}_{target}"), ondelete=ondelete
    )


def _index(table: str, *columns: str) -> None:
    op.create_index(op.f(f"ix_{table}_{'_'.join(columns)}"), table, list(columns))


def upgrade() -> None:
    for check in CHECKS:
        add_check_values(*check, FLOW)

    op.create_table(
        "request_themes",
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        _uuids("goal_ids"),
        sa.Column("origin", sa.Text(), nullable=False),
        sa.Column("created_by", sa.Uuid(), nullable=True),
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
        _updated_at(),
        _lock_version(),
        *_base("request_themes"),
        sa.CheckConstraint(
            _in("origin", ("person", "oracle")), name=op.f("ck_request_themes_origin")
        ),
    )
    _index("request_themes", "tenant_id")
    op.create_index(
        "ux_request_themes_title",
        "request_themes",
        ["tenant_id", sa.text("lower(title)")],
        unique=True,
        postgresql_where=sa.text("archived_at IS NULL"),
    )

    t = "product_requests"
    op.create_table(
        t,
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("body", sa.Text(), nullable=True),
        sa.Column("channel", sa.Text(), nullable=False),
        sa.Column("origin", sa.Text(), nullable=False),
        sa.Column("requester_name", sa.Text(), nullable=True),
        sa.Column("requester_kind", sa.Text(), server_default="unknown", nullable=False),
        sa.Column("verified", sa.Boolean(), server_default=sa.true(), nullable=False),
        sa.Column("source_item_id", sa.Uuid(), nullable=True),
        sa.Column("source_title", sa.Text(), nullable=True),
        sa.Column("source_url", sa.Text(), nullable=True),
        sa.Column("source_kind", sa.Text(), nullable=True),
        sa.Column("source_excerpt", sa.Text(), nullable=True),
        sa.Column("interview_id", sa.Uuid(), nullable=True),
        sa.Column("state", sa.Text(), server_default="new", nullable=False),
        sa.Column("merged_into_id", sa.Uuid(), nullable=True),
        sa.Column("disqualify_reason", sa.Text(), nullable=True),
        sa.Column("decision_note", sa.Text(), nullable=True),
        sa.Column("theme_id", sa.Uuid(), nullable=True),
        _uuids("goal_ids"),
        sa.Column("feature_id", sa.Uuid(), nullable=True),
        sa.Column("document_id", sa.Uuid(), nullable=True),
        sa.Column("intake_id", sa.Uuid(), nullable=True),
        sa.Column(
            "suggestion",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="{}",
            nullable=False,
        ),  # fmt: skip
        sa.Column("filed_by", sa.Uuid(), nullable=True),
        sa.Column("decided_by", sa.Uuid(), nullable=True),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        _updated_at(),
        _lock_version(),
        *_base(t),
        _fk(t, "source_item_id", "source_items", "SET NULL"),
        _fk(t, "merged_into_id", "product_requests", "SET NULL"),
        _fk(t, "theme_id", "request_themes", "SET NULL"),
        _fk(t, "feature_id", "entities", "SET NULL"),
        _fk(t, "document_id", "documents", "SET NULL"),
        _fk(t, "intake_id", "product_intakes", "SET NULL"),
        sa.CheckConstraint(_in("channel", CHANNELS), name=op.f(f"ck_{t}_channel")),
        sa.CheckConstraint(
            _in("origin", ("person", "oracle", "interview")), name=op.f(f"ck_{t}_origin")
        ),
        sa.CheckConstraint(
            _in("requester_kind", ("customer", "team", "unknown")),
            name=op.f(f"ck_{t}_requester_kind"),
        ),
        sa.CheckConstraint(
            _in("state", ("new", "qualified", "merged", "disqualified")),
            name=op.f(f"ck_{t}_state"),
        ),
        sa.CheckConstraint(
            _in("disqualify_reason", DISQUALIFY_REASONS), name=op.f(f"ck_{t}_disqualify_reason")
        ),
        sa.CheckConstraint("length(source_excerpt) <= 400", name=op.f(f"ck_{t}_source_excerpt")),
        sa.CheckConstraint(
            "(state = 'merged') = (merged_into_id IS NOT NULL)", name=op.f(f"ck_{t}_merged")
        ),
        sa.CheckConstraint(
            "(state = 'disqualified') = (disqualify_reason IS NOT NULL)",
            name=op.f(f"ck_{t}_disqualified"),
        ),
        sa.CheckConstraint(
            "merged_into_id IS NULL OR merged_into_id <> id", name=op.f(f"ck_{t}_not_self")
        ),
    )
    for column in (
        "tenant_id",
        "source_item_id",
        "merged_into_id",
        "theme_id",
        "feature_id",
        "document_id",
        "intake_id",
    ):
        _index(t, column)
    op.create_index(
        "ix_product_requests_state", t, ["tenant_id", "state", sa.text("created_at DESC")]
    )

    c = "request_candidates"
    op.create_table(
        c,
        sa.Column("owner_user_id", sa.Uuid(), nullable=False),
        sa.Column("run_id", sa.Uuid(), nullable=True),
        sa.Column("source_item_id", sa.Uuid(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("body", sa.Text(), nullable=True),
        sa.Column("requester_name", sa.Text(), nullable=True),
        sa.Column("channel", sa.Text(), nullable=False),
        sa.Column("theme_title", sa.Text(), nullable=True),
        _uuids("goal_ids"),
        sa.Column("confidence", sa.Numeric(4, 3), nullable=True),
        sa.Column("rationale", sa.Text(), nullable=True),
        sa.Column("status", sa.Text(), server_default="open", nullable=False),
        sa.Column("request_id", sa.Uuid(), nullable=True),
        _updated_at(),
        *_base(c),
        _fk(c, "run_id", "runs", "SET NULL"),
        _fk(c, "source_item_id", "source_items", "CASCADE"),
        _fk(c, "request_id", "product_requests", "SET NULL"),
        sa.CheckConstraint(
            _in("status", ("open", "filed", "dismissed")), name=op.f(f"ck_{c}_status")
        ),
        sa.UniqueConstraint("owner_user_id", "source_item_id", name="ux_request_candidates_item"),
    )
    for column in ("tenant_id", "run_id", "request_id"):
        _index(c, column)


def downgrade() -> None:
    bind = op.get_bind()
    for table, _, column in CHECKS:
        live = bind.scalar(
            sa.text(f"SELECT count(*) FROM {table} WHERE {column} = ANY(:values)"),
            {"values": list(FLOW)},
        )
        if live:
            raise RuntimeError(
                f"{live} {table} row(s) are request_triage: delete those runs before "
                "downgrading below 0020_requests"
            )
    op.drop_table("request_candidates")
    op.drop_table("product_requests")
    op.drop_table("request_themes")
    for check in CHECKS:
        remove_check_values(*check, FLOW)
