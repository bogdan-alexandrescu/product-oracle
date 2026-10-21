"""``company_integrations`` (F6, migration 0020_alignment_reports).

One row per company, provider and purpose: Oracle's Slack app for notifications is
installed once per company ("Slack poster", decided 2026-10-20). The bot token is
encrypted with :mod:`oracle.crypto` and never returned by any endpoint, logged or audited.
"""

import uuid

from sqlalchemy import CheckConstraint, Integer, LargeBinary, Text, UniqueConstraint, Uuid
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Mapped, mapped_column

from oracle.db import Base, TenantScoped
from oracle.docs.models import _in

INTEGRATION_PROVIDERS = ("slack",)
INTEGRATION_PURPOSES = ("notifications",)
INTEGRATION_STATUSES = ("active", "revoked", "error")


class CompanyIntegration(TenantScoped, Base):
    __tablename__ = "company_integrations"
    __table_args__ = (
        UniqueConstraint("tenant_id", "provider", "purpose"),
        CheckConstraint(_in("provider", INTEGRATION_PROVIDERS), name="provider"),
        CheckConstraint(_in("purpose", INTEGRATION_PURPOSES), name="purpose"),
        CheckConstraint(_in("status", INTEGRATION_STATUSES), name="status"),
    )

    provider: Mapped[str] = mapped_column(Text, nullable=False)
    purpose: Mapped[str] = mapped_column(Text, nullable=False)
    # Slack's team (workspace) id, and its name as the UI shows it.
    account_id: Mapped[str] = mapped_column(Text, nullable=False)
    account_label: Mapped[str | None] = mapped_column(Text)
    ciphertext: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    key_version: Mapped[int] = mapped_column(Integer, nullable=False)
    scopes: Mapped[list[str]] = mapped_column(ARRAY(Text), nullable=False, server_default="{}")
    status: Mapped[str] = mapped_column(
        Text, nullable=False, default="active", server_default="active"
    )
    last_error: Mapped[str | None] = mapped_column(Text)
    # The owner who installed it (a user id).
    installed_by: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
