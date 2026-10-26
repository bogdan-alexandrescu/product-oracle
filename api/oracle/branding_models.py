"""O5 lane 4: the table of company logos (``oracle.branding`` reads and writes it)."""

import uuid

from sqlalchemy import Index, Integer, LargeBinary, Text, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from oracle.db import Base, TenantScoped


class BrandAsset(TenantScoped, Base):
    """A stored logo, re-encoded to PNG; addressed by the sha256 of its bytes."""

    __tablename__ = "brand_assets"
    __table_args__ = (Index("uq_brand_assets_sha256", "tenant_id", "sha256", unique=True),)

    sha256: Mapped[str] = mapped_column(Text, nullable=False)
    content_type: Mapped[str] = mapped_column(Text, nullable=False)
    bytes: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    width: Mapped[int] = mapped_column(Integer, nullable=False)
    height: Mapped[int] = mapped_column(Integer, nullable=False)
    created_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
