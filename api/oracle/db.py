"""Engine, declarative base and session factory.

Sessions come from :mod:`oracle.tenancy`; do not build ``AsyncSession`` objects by hand.
"""

import time
import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, ForeignKey, MetaData, Uuid, event, func
from sqlalchemy.exc import InvalidatePoolError
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, declared_attr, mapped_column

from oracle.config import get_settings

NAMING_CONVENTION = {
    "ix": "ix_%(table_name)s_%(column_0_N_name)s",
    "uq": "uq_%(table_name)s_%(column_0_N_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING_CONVENTION)


class IdMixin:
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class TenantScoped(IdMixin):
    """Mixin for every tenant-owned table. The tenancy layer filters and stamps it."""

    @declared_attr
    def tenant_id(cls) -> Mapped[uuid.UUID]:  # noqa: N805
        return mapped_column(
            Uuid, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True
        )


_engine: AsyncEngine | None = None
_sessionmaker: async_sessionmaker | None = None


def get_engine() -> AsyncEngine:
    global _engine
    if _engine is None:
        settings = get_settings()
        idle = settings.db_ping_after_idle_seconds
        _engine = create_async_engine(
            settings.database_url,
            echo=settings.sql_echo,
            pool_pre_ping=idle <= 0,
            pool_size=settings.db_pool_size,
            max_overflow=settings.db_max_overflow,
            pool_recycle=settings.db_pool_recycle_seconds,
        )
        if idle > 0:
            ping_when_idle(_engine, idle)
    return _engine


_USED_AT = "oracle_used_at"


def ping_when_idle(engine: AsyncEngine, idle_seconds: float) -> None:
    """simple-speed: ``pool_pre_ping`` for connections that sat idle only.

    A request checks a connection out two or three times (who is signing in, then its own
    session), and ``pool_pre_ping`` pings on each: BEGIN, an empty statement and ROLLBACK,
    three round trips before the first query. A connection used within ``idle_seconds`` is
    handed out as it is; one idle for longer (or never used) is pinged as before, and a
    failed ping replaces it and every older connection, as ``pool_pre_ping`` does."""
    pool = engine.sync_engine.pool
    dialect = engine.sync_engine.dialect

    def used(_dbapi_connection: Any, record: Any) -> None:
        if record is not None:
            record.info[_USED_AT] = time.time()

    def check(dbapi_connection: Any, record: Any, _proxy: Any) -> None:
        used_at = record.info.get(_USED_AT)
        # A clock set back reads as idle: ping.
        if used_at is not None and 0 <= time.time() - used_at < idle_seconds:
            return
        if not dialect._do_ping_w_event(dbapi_connection):
            raise InvalidatePoolError()

    # A connection just made is not idle.
    event.listen(pool, "connect", used)
    event.listen(pool, "checkin", used)
    event.listen(pool, "checkout", check)


def get_sessionmaker() -> async_sessionmaker:
    global _sessionmaker
    if _sessionmaker is None:
        from oracle.tenancy import TenantSession

        _sessionmaker = async_sessionmaker(
            get_engine(), expire_on_commit=False, sync_session_class=TenantSession
        )
    return _sessionmaker


async def dispose_engine() -> None:
    global _engine, _sessionmaker
    if _engine is not None:
        await _engine.dispose()
    _engine = None
    _sessionmaker = None
