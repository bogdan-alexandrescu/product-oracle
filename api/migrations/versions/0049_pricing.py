"""H9 Pricing input: the pricing memo kind, its run and review, win and loss records, and
the pricing interview preset.

- ``pricing`` joins the document, template and theme kind checks, ``pricing`` the
  decision origins, ``pricing_memo`` the run flows and ``pricing_review`` the checkpoint
  kinds (widened through ``oracle.migration_checks``, so no other lane's value is dropped);
- ``deal_outcomes``: one deal's result and its main reason, with no contact details;
  ``competitor_id`` has no foreign key until H7's competitors table exists;
- ``interviews.preset``: ``pricing`` or null.

The downgrade refuses while a pricing document exists (move it to Trash and purge it
first). It then deletes the pricing runs and checkpoints, drops ``deal_outcomes`` and
``interviews.preset``, removes the ``pricing_owner`` setting and narrows the checks.
Decisions with origin ``pricing`` must be purged first too: the origin check would refuse
them.

Revision ID: 0049_pricing
Revises: 0048_scope_review
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

from oracle.migration_checks import add_check_values, remove_check_values

revision: str = "0049_pricing"
down_revision: str | None = "0048_scope_review"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"
CHECKS = (
    ("documents", "ck_documents_kind", "kind", ("pricing",)),
    ("templates", "ck_templates_kind", "kind", ("pricing",)),
    ("themes", "ck_themes_kind", "kind", ("pricing",)),
    ("decisions", "ck_decisions_origin", "origin", ("pricing",)),
    ("runs", "ck_runs_flow", "flow", ("pricing_memo",)),
    ("checkpoints", "ck_checkpoints_kind", "kind", ("pricing_review",)),
)


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    for table, name, column, values in CHECKS:
        add_check_values(table, name, column, values)
    op.create_table(
        "deal_outcomes",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("result", sa.Text(), nullable=False),
        sa.Column("account", sa.Text(), nullable=False),
        sa.Column("segment", sa.Text(), nullable=True),
        sa.Column("plan", sa.Text(), nullable=True),
        sa.Column("annual_value", sa.Numeric(14, 2), nullable=True),
        sa.Column("currency", sa.Text(), nullable=True),
        sa.Column("decided_on", sa.Date(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("reason_note", sa.Text(), nullable=True),
        sa.Column("price_quoted", sa.Text(), nullable=True),
        sa.Column("competitor_id", sa.Uuid(), nullable=True),
        sa.Column("source_item_id", sa.Uuid(), nullable=True),
        sa.Column("recorded_by", sa.Uuid(), nullable=False),
        sa.Column("lock_version", sa.Integer(), server_default="1", nullable=False),
        sa.CheckConstraint(
            "result IN ('won', 'lost', 'no_decision', 'churned')",
            name=op.f("ck_deal_outcomes_result"),
        ),
        sa.CheckConstraint("length(account) <= 120", name=op.f("ck_deal_outcomes_account")),
        sa.CheckConstraint(
            "annual_value IS NULL OR annual_value >= 0", name=op.f("ck_deal_outcomes_annual_value")
        ),
        sa.CheckConstraint(
            "currency IS NULL OR currency IN ('USD', 'EUR', 'GBP')",
            name=op.f("ck_deal_outcomes_currency"),
        ),
        sa.CheckConstraint(
            "reason IN ('price', 'value', 'product_gap', 'alternative', 'timing', "
            "'no_budget', 'champion', 'other')",
            name=op.f("ck_deal_outcomes_reason"),
        ),
        sa.CheckConstraint(
            "reason <> 'other' OR reason_note IS NOT NULL", name=op.f("ck_deal_outcomes_other_note")
        ),
        sa.CheckConstraint(
            "(annual_value IS NULL) = (currency IS NULL)",
            name=op.f("ck_deal_outcomes_value_currency"),
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_deal_outcomes_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["source_item_id"],
            ["source_items.id"],
            name=op.f("fk_deal_outcomes_source_item_id_source_items"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_deal_outcomes")),
    )
    op.create_index("ix_deal_outcomes_tenant_id", "deal_outcomes", ["tenant_id"])
    op.create_index("ix_deal_outcomes_source_item_id", "deal_outcomes", ["source_item_id"])
    op.create_index(
        "ix_deal_outcomes_when", "deal_outcomes", ["tenant_id", sa.text("decided_on DESC")]
    )
    op.add_column("interviews", sa.Column("preset", sa.Text(), nullable=True))
    op.create_check_constraint(
        op.f("ck_interviews_preset"), "interviews", "preset IS NULL OR preset IN ('pricing')"
    )


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    bind = op.get_bind()
    documents = bind.scalar(sa.text("SELECT count(*) FROM documents WHERE kind = 'pricing'"))
    if documents:
        raise RuntimeError(
            f"{documents} pricing memo(s) exist; move them to Trash and purge them "
            "(Settings › Trash) before downgrading"
        )
    op.execute("DELETE FROM checkpoints WHERE kind = 'pricing_review'")
    op.execute("DELETE FROM runs WHERE flow = 'pricing_memo'")
    op.execute("DELETE FROM templates WHERE kind = 'pricing'")
    op.execute("DELETE FROM themes WHERE kind = 'pricing'")
    op.execute("DELETE FROM tenant_settings WHERE key = 'pricing_owner'")
    op.drop_constraint(op.f("ck_interviews_preset"), "interviews", type_="check")
    op.drop_column("interviews", "preset")
    op.drop_index("ix_deal_outcomes_when", table_name="deal_outcomes")
    op.drop_index("ix_deal_outcomes_source_item_id", table_name="deal_outcomes")
    op.drop_index("ix_deal_outcomes_tenant_id", table_name="deal_outcomes")
    op.drop_table("deal_outcomes")
    for table, name, column, values in reversed(CHECKS):
        remove_check_values(table, name, column, values)
