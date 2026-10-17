"""Tenant-scoped sessions.

Every session carries a tenant id in ``session.info``. A session without one refuses
to execute anything (``TenantRequiredError``), so a forgotten scope fails loudly instead
of leaking rows across tenants.

With a tenant set:
- every ORM SELECT / UPDATE / DELETE gets ``tenant_id = :tenant`` added for each
  :class:`~oracle.db.TenantScoped` entity it touches (including relationship loads);
- every new ``TenantScoped`` object is stamped with the tenant on flush, and an object
  of another tenant cannot be inserted, updated or deleted.

Limits: filtering applies to ORM entities. Core statements against ``Table`` objects
and ``text()`` are not rewritten; avoid them in request code.

``unscoped_session()`` skips all of this. It exists for the two places that must work
before a tenant is known (authentication lookups, the seed command) and nowhere else.
"""

import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import ORMExecuteState, Session, with_loader_criteria

from oracle.db import TenantScoped, get_sessionmaker

TENANT_KEY = "tenant_id"
UNSCOPED_KEY = "unscoped"


class TenantRequiredError(RuntimeError):
    """Raised when a session is used without a tenant scope."""


class TenantMismatchError(RuntimeError):
    """Raised when an object of another tenant is flushed in a scoped session."""


class TenantSession(Session):
    """Sync session class behind every ``AsyncSession`` the app creates."""


def set_tenant(session: AsyncSession | Session, tenant_id: uuid.UUID) -> None:
    if tenant_id is None:
        raise TenantRequiredError("tenant_id must not be None")
    session.info[TENANT_KEY] = tenant_id


def current_tenant(session: AsyncSession | Session) -> uuid.UUID:
    tenant_id = session.info.get(TENANT_KEY)
    if tenant_id is None:
        raise TenantRequiredError("this session has no tenant scope")
    return tenant_id


def _scope(session: Session) -> uuid.UUID | None:
    """Tenant id for this session, ``None`` when explicitly unscoped, else raise."""
    if session.info.get(UNSCOPED_KEY):
        return None
    tenant_id = session.info.get(TENANT_KEY)
    if tenant_id is None:
        raise TenantRequiredError(
            "refusing to run a query without a tenant: use tenant_session(tenant_id) "
            "or set_tenant(session, tenant_id)"
        )
    return tenant_id


@event.listens_for(TenantSession, "do_orm_execute")
def _add_tenant_criteria(state: ORMExecuteState) -> None:
    tenant_id = _scope(state.session)
    if tenant_id is None:
        return
    if state.is_select or state.is_update or state.is_delete:
        from oracle.models import Tenant

        state.statement = state.statement.options(
            with_loader_criteria(
                TenantScoped,
                lambda cls: cls.tenant_id == tenant_id,
                include_aliases=True,
            ),
            with_loader_criteria(Tenant, lambda cls: cls.id == tenant_id),
        )


@event.listens_for(TenantSession, "before_flush")
def _stamp_and_check(session: Session, flush_context, instances) -> None:
    tenant_id = _scope(session)
    if tenant_id is None:
        return
    for obj in session.new:
        if isinstance(obj, TenantScoped):
            if obj.tenant_id is None:
                obj.tenant_id = tenant_id
            elif obj.tenant_id != tenant_id:
                raise TenantMismatchError(f"{type(obj).__name__} belongs to another tenant")
    for obj in (*session.dirty, *session.deleted):
        if isinstance(obj, TenantScoped) and obj.tenant_id != tenant_id:
            raise TenantMismatchError(f"{type(obj).__name__} belongs to another tenant")


@asynccontextmanager
async def tenant_session(tenant_id: uuid.UUID) -> AsyncIterator[AsyncSession]:
    """A session scoped to ``tenant_id``. Commit is the caller's job."""
    if tenant_id is None:
        raise TenantRequiredError("tenant_id must not be None")
    async with get_sessionmaker()() as session:
        set_tenant(session, tenant_id)
        yield session


@asynccontextmanager
async def unscoped_session() -> AsyncIterator[AsyncSession]:
    """A session with tenant scoping OFF. Auth lookups and seeding only."""
    async with get_sessionmaker()() as session:
        session.info[UNSCOPED_KEY] = True
        yield session


@asynccontextmanager
async def bare_session() -> AsyncIterator[AsyncSession]:
    """A session with no tenant yet; it refuses to query until ``set_tenant`` is called."""
    async with get_sessionmaker()() as session:
        yield session
