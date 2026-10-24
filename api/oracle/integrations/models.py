"""``company_integrations`` (F6, migration 0020_alignment_reports).

One row per company, provider and purpose: Oracle's Slack app for notifications is
installed once per company ("Slack poster", decided 2026-10-20). The bot token is
encrypted with :mod:`oracle.crypto` and never returned by any endpoint, logged or audited.
H5's PostHog query connection (provider ``posthog``, purpose ``metrics``) keeps its
personal API key the same way, and its host and project id in ``config``.
"""

import uuid
from typing import Any

from sqlalchemy import (
    CheckConstraint,
    Index,
    Integer,
    LargeBinary,
    Text,
    UniqueConstraint,
    Uuid,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from oracle.db import Base, TenantScoped
from oracle.docs.models import _in

INTEGRATION_PROVIDERS = ("slack", "posthog")
INTEGRATION_PURPOSES = ("notifications", "metrics")
INTEGRATION_STATUSES = ("active", "revoked", "error")


class CompanyIntegration(TenantScoped, Base):
    __tablename__ = "company_integrations"
    __table_args__ = (
        UniqueConstraint("tenant_id", "provider", "purpose"),
        CheckConstraint(_in("provider", INTEGRATION_PROVIDERS), name="provider"),
        CheckConstraint(_in("purpose", INTEGRATION_PURPOSES), name="purpose"),
        CheckConstraint(_in("status", INTEGRATION_STATUSES), name="status"),
        # G8: an event's team id resolves one company.
        Index(
            "uq_company_integrations_slack_team",
            "provider",
            "account_id",
            unique=True,
            postgresql_where=text("status = 'active' AND provider = 'slack'"),
        ),
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
    # G8: the app's own Slack user (``oauth.v2.access``'s ``bot_user_id``): its posts never
    # come back as messages or as source evidence.
    bot_user_id: Mapped[str | None] = mapped_column(Text)
    # The app's users in the Slacks it was connected to before (a reconnect to another
    # Slack): Oracle's posts there still never become source evidence.
    former_bot_user_ids: Mapped[list[str]] = mapped_column(
        ARRAY(Text), nullable=False, default=list, server_default="{}"
    )
    # H5 PostHog: {"host": "us" | "eu" | "https://...", "project_id": "..."}.
    config: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, default=dict, server_default="{}"
    )
