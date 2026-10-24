"""H10 Reasoned no

``request_replies``: one reply to one person who asked for a request said no to, or
reopened after one. ``product_requests`` gains ``basis`` (the record a no cites),
``loop_closed_on`` and ``asked_again_since``; ``request_themes`` gains the problem behind
the theme (``problem``, ``success``, ``constraints``, its state and Oracle's suggestion);
``llm_jobs`` gains ``request_id`` and the ``why_not_reply`` kind, with a request as a
job's sixth possible subject. ``disqualify_reason`` gains ``strategy_stop``,
``already_exists`` and ``few_customers``; ``decisions.origin`` gains ``request_decline``.
Check values are added to the checks as they are now (oracle.migration_checks), so values
other lanes add survive.

Live-safe: nullable columns and ones with a constant default take a short lock; the wait
for it is capped (LOCK_TIMEOUT).

The downgrade refuses, with a count, while a request is disqualified with a new reason
(change those reasons first). Decisions recorded from declines stay as ordinary decided
records (their origin stays allowed while one uses it). Then it deletes the
``why_not_reply`` jobs and drops the table and columns.

Revision ID: 0049_request_replies
Revises: 0048_scope_review
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

from oracle.migration_checks import add_check_values, remove_check_values

revision: str = "0049_request_replies"
down_revision: str | None = "0048_scope_review"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"
REASON_CHECK = ("product_requests", "ck_product_requests_disqualify_reason", "disqualify_reason")
REASONS = ("strategy_stop", "already_exists", "few_customers")
ORIGIN_CHECK = ("decisions", "ck_decisions_origin", "origin")
ORIGINS = ("request_decline",)
KIND_CHECK = ("llm_jobs", "ck_llm_jobs_kind", "kind")
KINDS = ("why_not_reply",)
SUBJECT_BEFORE = (
    "document_id IS NOT NULL OR intake_id IS NOT NULL OR decision_id IS NOT NULL "
    "OR interview_id IS NOT NULL OR scope_id IS NOT NULL"
)
SUBJECT_AFTER = f"{SUBJECT_BEFORE} OR request_id IS NOT NULL"
T = "request_replies"


def _fk(column: str, target: str, ondelete: str) -> sa.ForeignKeyConstraint:
    return sa.ForeignKeyConstraint(
        [column], [f"{target}.id"], name=op.f(f"fk_{T}_{column}_{target}"), ondelete=ondelete
    )


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.create_table(
        T,
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("request_id", sa.Uuid(), nullable=False),
        sa.Column("root_request_id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("decision_id", sa.Uuid(), nullable=True),
        sa.Column("asker", sa.Text(), nullable=True),
        sa.Column("asker_kind", sa.Text(), nullable=False),
        sa.Column("member_id", sa.Uuid(), nullable=True),
        sa.Column("asked", sa.Text(), nullable=True),
        sa.Column("body", sa.Text(), nullable=True),
        sa.Column("draft_source", sa.Text(), nullable=True),
        sa.Column("job_id", sa.Uuid(), nullable=True),
        sa.Column("warnings", postgresql.ARRAY(sa.Text()), server_default="{}", nullable=False),
        sa.Column("status", sa.Text(), server_default="drafted", nullable=False),
        sa.Column("channel", sa.Text(), nullable=True),
        sa.Column("sent_on", sa.Date(), nullable=True),
        sa.Column("sent_by", sa.Uuid(), nullable=True),
        sa.Column("skip_reason", sa.Text(), nullable=True),
        sa.Column("notified_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("lock_version", sa.Integer(), server_default="1", nullable=False),
        sa.CheckConstraint("kind IN ('no', 'reopened')", name=op.f(f"ck_{T}_kind")),
        sa.CheckConstraint(
            "asker_kind IN ('customer', 'team', 'unknown')", name=op.f(f"ck_{T}_asker_kind")
        ),
        sa.CheckConstraint(
            "draft_source IN ('oracle', 'template', 'person')", name=op.f(f"ck_{T}_draft_source")
        ),
        sa.CheckConstraint(
            "status IN ('drafted', 'sent', 'notified', 'skipped', 'withdrawn')",
            name=op.f(f"ck_{T}_status"),
        ),
        sa.CheckConstraint(
            "channel IS NULL OR channel IN ('email', 'slack', 'call', 'in_app', 'other')",
            name=op.f(f"ck_{T}_channel"),
        ),
        sa.CheckConstraint(
            "status <> 'skipped' OR skip_reason IS NOT NULL", name=op.f(f"ck_{T}_skipped")
        ),
        sa.CheckConstraint(
            "status <> 'sent' OR (channel IS NOT NULL AND sent_on IS NOT NULL)",
            name=op.f(f"ck_{T}_sent"),
        ),
        _fk("tenant_id", "tenants", "CASCADE"),
        _fk("request_id", "product_requests", "CASCADE"),
        _fk("root_request_id", "product_requests", "CASCADE"),
        _fk("decision_id", "decisions", "SET NULL"),
        _fk("job_id", "llm_jobs", "SET NULL"),
        sa.PrimaryKeyConstraint("id", name=op.f(f"pk_{T}")),
    )  # fmt: skip
    for column in ("tenant_id", "request_id", "root_request_id", "decision_id", "job_id"):
        op.create_index(op.f(f"ix_{T}_{column}"), T, [column])
    op.create_index("ux_request_replies", T, ["request_id", "kind", "decision_id"], unique=True)
    op.create_index(
        "ix_request_replies_open",
        T,
        ["tenant_id", "root_request_id"],
        postgresql_where=sa.text("status = 'drafted'"),
    )

    op.add_column(
        "product_requests",
        sa.Column("basis", postgresql.JSONB(), server_default="{}", nullable=False),
    )
    op.add_column("product_requests", sa.Column("loop_closed_on", sa.Date(), nullable=True))
    op.add_column(
        "product_requests",
        sa.Column("asked_again_since", sa.DateTime(timezone=True), nullable=True),
    )
    for name, kind in (("problem", sa.Text()), ("success", sa.Text()), ("constraints", sa.Text())):
        op.add_column("request_themes", sa.Column(name, kind, nullable=True))
    op.add_column(
        "request_themes",
        sa.Column("problem_state", sa.Text(), server_default="none", nullable=False),
    )
    op.add_column(
        "request_themes",
        sa.Column("problem_suggestion", postgresql.JSONB(), server_default="{}", nullable=False),
    )
    op.add_column("request_themes", sa.Column("problem_confirmed_by", sa.Uuid(), nullable=True))
    op.add_column(
        "request_themes",
        sa.Column("problem_confirmed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_check_constraint(
        op.f("ck_request_themes_problem_state"),
        "request_themes",
        "problem_state IN ('none', 'suggested', 'confirmed')",
    )

    op.add_column("llm_jobs", sa.Column("request_id", sa.Uuid(), nullable=True))
    op.create_index(op.f("ix_llm_jobs_request_id"), "llm_jobs", ["request_id"], unique=False)
    op.create_foreign_key(
        op.f("fk_llm_jobs_request_id_product_requests"),
        "llm_jobs",
        "product_requests",
        ["request_id"],
        ["id"],
        ondelete="CASCADE",
    )
    add_check_values(*KIND_CHECK, KINDS)
    op.drop_constraint(op.f("ck_llm_jobs_subject"), "llm_jobs", type_="check")
    op.create_check_constraint(op.f("ck_llm_jobs_subject"), "llm_jobs", SUBJECT_AFTER)
    add_check_values(*REASON_CHECK, REASONS)
    add_check_values(*ORIGIN_CHECK, ORIGINS)


def _refuse_while_used() -> None:
    bind = op.get_bind()
    reasons = bind.scalar(
        sa.text(
            "SELECT count(*) FROM product_requests WHERE disqualify_reason IN "
            "('strategy_stop', 'already_exists', 'few_customers')"
        )
    )
    if reasons:
        raise RuntimeError(
            f"{reasons} request(s) are disqualified as On the stop list, Already possible or "
            "Too few would use it: change their reason to one of the older ones first"
        )


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    _refuse_while_used()
    # Decisions recorded from declines stay in the log as ordinary decided records: the
    # origin stays allowed while one uses it.
    used = op.get_bind().scalar(
        sa.text("SELECT count(*) FROM decisions WHERE origin = 'request_decline'")
    )
    if not used:
        remove_check_values(*ORIGIN_CHECK, ORIGINS)
    remove_check_values(*REASON_CHECK, REASONS)
    op.execute("DELETE FROM llm_jobs WHERE request_id IS NOT NULL OR kind = 'why_not_reply'")
    op.drop_constraint(op.f("ck_llm_jobs_subject"), "llm_jobs", type_="check")
    op.create_check_constraint(op.f("ck_llm_jobs_subject"), "llm_jobs", SUBJECT_BEFORE)
    remove_check_values(*KIND_CHECK, KINDS)
    op.drop_constraint(
        op.f("fk_llm_jobs_request_id_product_requests"), "llm_jobs", type_="foreignkey"
    )
    op.drop_index(op.f("ix_llm_jobs_request_id"), table_name="llm_jobs")
    op.drop_column("llm_jobs", "request_id")
    op.drop_constraint(op.f("ck_request_themes_problem_state"), "request_themes", type_="check")
    for name in (
        "problem_confirmed_at",
        "problem_confirmed_by",
        "problem_suggestion",
        "problem_state",
        "constraints",
        "success",
        "problem",
    ):
        op.drop_column("request_themes", name)
    for name in ("asked_again_since", "loop_closed_on", "basis"):
        op.drop_column("product_requests", name)
    op.drop_table(T)
