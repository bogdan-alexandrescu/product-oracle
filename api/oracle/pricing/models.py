"""Win and loss records (H9): one deal's result and its main reason. No contact details;
``account`` is the label as given and Oracle never looks it up."""

import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import CheckConstraint, Date, Index, Numeric, Text, Uuid, text
from sqlalchemy.orm import Mapped, mapped_column

from oracle.db import Base, TenantScoped
from oracle.docs.models import _in
from oracle.v2.models import _fk, _lock_version, _updated_at

RESULTS = ("won", "lost", "no_decision", "churned")
REASONS = (
    "price",
    "value",
    "product_gap",
    "alternative",
    "timing",
    "no_budget",
    "champion",
    "other",
)
CURRENCIES = ("USD", "EUR", "GBP")
ACCOUNT_MAX = 120


class DealOutcome(TenantScoped, Base):
    __tablename__ = "deal_outcomes"
    __table_args__ = (
        CheckConstraint(_in("result", RESULTS), name="result"),
        CheckConstraint(f"length(account) <= {ACCOUNT_MAX}", name="account"),
        CheckConstraint("annual_value IS NULL OR annual_value >= 0", name="annual_value"),
        CheckConstraint(f"currency IS NULL OR {_in('currency', CURRENCIES)}", name="currency"),
        CheckConstraint(_in("reason", REASONS), name="reason"),
        CheckConstraint("reason <> 'other' OR reason_note IS NOT NULL", name="other_note"),
        CheckConstraint("(annual_value IS NULL) = (currency IS NULL)", name="value_currency"),
        Index("ix_deal_outcomes_when", "tenant_id", text("decided_on DESC")),
    )

    updated_at: Mapped[datetime] = _updated_at()
    result: Mapped[str] = mapped_column(Text, nullable=False)
    account: Mapped[str] = mapped_column(Text, nullable=False)
    segment: Mapped[str | None] = mapped_column(Text)
    plan: Mapped[str | None] = mapped_column(Text)
    annual_value: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    currency: Mapped[str | None] = mapped_column(Text)
    decided_on: Mapped[date] = mapped_column(Date, nullable=False)
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    reason_note: Mapped[str | None] = mapped_column(Text)
    price_quoted: Mapped[str | None] = mapped_column(Text)
    # H7's alternative (oracle.market), when the record names one of the company's.
    competitor_id: Mapped[uuid.UUID | None] = _fk("competitors", "SET NULL")
    source_item_id: Mapped[uuid.UUID | None] = _fk("source_items", "SET NULL")
    # User or API token id, no FK, as elsewhere.
    recorded_by: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    lock_version: Mapped[int] = _lock_version()
    __mapper_args__ = {"version_id_col": lock_version}
