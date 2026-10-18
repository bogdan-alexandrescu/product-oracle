"""Company-wide settings, one JSON value per key.

Known keys: ``iap_default_role`` (role for a Google sign-in without an invite) and
``confidence_weights`` (oracle.baseline confidence scoring). The Claude account pool
behind Oracle's built-in model jobs has its own tables (oracle.claude_accounts).
"""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, Text, UniqueConstraint, Uuid, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from oracle.db import Base, TenantScoped


class TenantSetting(TenantScoped, Base):
    __tablename__ = "tenant_settings"
    __table_args__ = (UniqueConstraint("tenant_id", "key"),)

    key: Mapped[str] = mapped_column(Text, nullable=False)
    value: Mapped[Any] = mapped_column(JSONB, nullable=False)
    # User id or API token id; no FK because it can be either.
    updated_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )
