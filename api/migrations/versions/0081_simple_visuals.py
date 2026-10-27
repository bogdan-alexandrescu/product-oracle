"""Simple S10 (#723, D26): visual proposals.

- ``simple_visuals``: one visual per subject (``subject_kind``, ``subject_id``) with the
  document it belongs to and the drafting brief (oracle.simple.visuals).
- ``simple_visual_versions``: its drawings (steps, screen, sanitised SVG flow and HTML
  wireframe, numbered annotations), version 1 the draft, each revise the next.
- ``simple_visual_comments``: comments on a version (or one annotation), addressed by the
  version a revise drew.
- ``llm_jobs`` gains ``visual_id`` (a job's seventh possible subject) and the
  ``simple_visual`` kind (widened through oracle.migration_checks).

The downgrade deletes the ``simple_visual`` jobs and drops the tables.

Revision ID: 0081_simple_visuals
Revises: 0080_simple_one_pagers
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

from oracle.migration_checks import add_check_values, remove_check_values

revision: str = "0081_simple_visuals"
down_revision: str | None = "0080_simple_one_pagers"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"
KIND_CHECK = ("llm_jobs", "ck_llm_jobs_kind", "kind")
SUBJECT_BEFORE = (
    "document_id IS NOT NULL OR intake_id IS NOT NULL OR decision_id IS NOT NULL "
    "OR interview_id IS NOT NULL OR scope_id IS NOT NULL OR request_id IS NOT NULL"
)
SUBJECT_AFTER = f"{SUBJECT_BEFORE} OR visual_id IS NOT NULL"
KINDS = ("suggestion", "draft_item", "change", "chat_card", "one_pager_line", "feature")


def _base(t: str) -> list:
    return [
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f(f"fk_{t}_tenant_id_tenants"),
            ondelete="CASCADE",
        ),  # fmt: skip
        sa.PrimaryKeyConstraint("id", name=op.f(f"pk_{t}")),
    ]


def _visual_fk(t: str) -> sa.ForeignKeyConstraint:
    return sa.ForeignKeyConstraint(
        ["visual_id"], ["simple_visuals.id"], name=op.f(f"fk_{t}_visual_id_simple_visuals"),
        ondelete="CASCADE",
    )  # fmt: skip


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    t = "simple_visuals"
    kinds = ", ".join(f"'{k}'" for k in KINDS)
    op.create_table(
        t,
        *_base(t),
        sa.Column("subject_kind", sa.Text(), nullable=False),
        sa.Column("subject_id", sa.Uuid(), nullable=False),
        sa.Column("document_id", sa.Uuid(), nullable=True),
        sa.Column("brief", sa.Text(), nullable=False),
        sa.Column("requested_by", sa.Uuid(), nullable=True),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint(f"subject_kind IN ({kinds})", name=op.f(f"ck_{t}_subject_kind")),
        sa.ForeignKeyConstraint(
            ["document_id"],
            ["documents.id"],
            name=op.f(f"fk_{t}_document_id_documents"),
            ondelete="CASCADE",
        ),  # fmt: skip
        sa.UniqueConstraint(
            "tenant_id",
            "subject_kind",
            "subject_id",
            name=op.f(f"uq_{t}_tenant_id_subject_kind_subject_id"),
        ),  # fmt: skip
    )
    op.create_index(op.f(f"ix_{t}_tenant_id"), t, ["tenant_id"])
    op.create_index(op.f(f"ix_{t}_document_id"), t, ["document_id"])

    t = "simple_visual_versions"
    op.create_table(
        t,
        *_base(t),
        sa.Column("visual_id", sa.Uuid(), nullable=False),
        sa.Column("number", sa.Integer(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("goal", sa.Text(), nullable=True),
        sa.Column("steps", postgresql.JSONB(), nullable=False),
        sa.Column("screen", postgresql.JSONB(), nullable=True),
        sa.Column("flow_svg", sa.Text(), nullable=False),
        sa.Column("wireframe_html", sa.Text(), nullable=True),
        sa.Column("annotations", postgresql.JSONB(), server_default="[]", nullable=False),
        sa.Column("removed", postgresql.JSONB(), server_default="[]", nullable=False),
        sa.Column("job_id", sa.Uuid(), nullable=True),
        sa.Column("made_by", sa.Uuid(), nullable=True),
        _visual_fk(t),
        sa.UniqueConstraint("visual_id", "number", name=op.f(f"uq_{t}_visual_id_number")),
    )
    op.create_index(op.f(f"ix_{t}_tenant_id"), t, ["tenant_id"])
    op.create_index(op.f(f"ix_{t}_visual_id"), t, ["visual_id"])

    t = "simple_visual_comments"
    op.create_table(
        t,
        *_base(t),
        sa.Column("visual_id", sa.Uuid(), nullable=False),
        sa.Column("version_number", sa.Integer(), nullable=False),
        sa.Column("annotation", sa.Integer(), nullable=True),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("author_id", sa.Uuid(), nullable=False),
        sa.Column("addressed_in", sa.Integer(), nullable=True),
        _visual_fk(t),
    )
    op.create_index(op.f(f"ix_{t}_tenant_id"), t, ["tenant_id"])
    op.create_index(op.f(f"ix_{t}_visual_id"), t, ["visual_id"])

    op.add_column("llm_jobs", sa.Column("visual_id", sa.Uuid(), nullable=True))
    op.create_index(op.f("ix_llm_jobs_visual_id"), "llm_jobs", ["visual_id"], unique=False)
    op.create_foreign_key(
        op.f("fk_llm_jobs_visual_id_simple_visuals"), "llm_jobs", "simple_visuals",
        ["visual_id"], ["id"], ondelete="CASCADE",
    )  # fmt: skip
    add_check_values(*KIND_CHECK, ("simple_visual",))
    op.drop_constraint(op.f("ck_llm_jobs_subject"), "llm_jobs", type_="check")
    op.create_check_constraint(op.f("ck_llm_jobs_subject"), "llm_jobs", SUBJECT_AFTER)


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.execute("DELETE FROM llm_jobs WHERE visual_id IS NOT NULL OR kind = 'simple_visual'")
    op.drop_constraint(op.f("ck_llm_jobs_subject"), "llm_jobs", type_="check")
    op.create_check_constraint(op.f("ck_llm_jobs_subject"), "llm_jobs", SUBJECT_BEFORE)
    remove_check_values(*KIND_CHECK, ("simple_visual",))
    op.drop_constraint(op.f("fk_llm_jobs_visual_id_simple_visuals"), "llm_jobs", type_="foreignkey")
    op.drop_index(op.f("ix_llm_jobs_visual_id"), table_name="llm_jobs")
    op.drop_column("llm_jobs", "visual_id")
    op.drop_table("simple_visual_comments")
    op.drop_table("simple_visual_versions")
    op.drop_table("simple_visuals")
