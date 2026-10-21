"""One company's tick: the body ``POST /v1/internal/tick`` (one company, ``oracle tick``)
and the scheduled ticker (``POST /internal/scheduler/tick``, every company) share.

A company's tick is, in this order: its runs and its Claude account sweep (when due,
:func:`tick_company`); its queued built-in model jobs (the caller's: the scheduled ticker
gives the companies turns across the whole tick); last, within their own time budget,
the calls a member's disable or a run's cancel still owes (provider revokes, runtime
cancels: :func:`settle_company`), so they never hold up runs and jobs. Each step stands
on its own: one that raises is logged and kept in ``errors``, and never skips the
others.
"""

import logging
import uuid
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.claude_accounts import sweep as claude_sweep

if TYPE_CHECKING:
    from oracle.auth.deps import Principal
    from oracle.runs.schemas import TickOut

log = logging.getLogger(__name__)


@dataclass
class CompanyTick:
    runs: "TickOut | None" = None
    # The sweep's result (``claude_sweep.sweep_if_due``): None when not due.
    sweep: dict[str, Any] | None = None
    swept: bool = False
    follow_ups: int = 0
    # What raised, step by step (logged); the other steps still ran.
    errors: list[BaseException] = field(default_factory=list)


async def tick_company(
    db: AsyncSession, tenant_id: uuid.UUID, principal: "Principal | None" = None
) -> CompanyTick:
    """The company's runs, then its account sweep when due."""
    from oracle.runs import service as runs_service

    out = CompanyTick()
    try:
        out.runs = await runs_service.tick(db, principal)
    except Exception as exc:
        log.exception("tick: runs failed for company %s", tenant_id)
        await db.rollback()
        out.errors.append(exc)
    try:
        out.sweep = await claude_sweep.sweep_if_due(tenant_id)
        out.swept = True
    except Exception as exc:
        log.exception("tick: the Claude account sweep failed for company %s", tenant_id)
        out.errors.append(exc)
    return out


async def settle_company(
    db: AsyncSession,
    tenant_id: uuid.UUID,
    http: httpx.AsyncClient,
    out: CompanyTick,
    principal: "Principal | None" = None,
    *,
    budget_seconds: float | None = None,
) -> CompanyTick:
    """Last: the follow-ups a member's disable or a run's cancel still owes that are due
    (``oracle.members.service.run_follow_ups``, within its own budget, or
    ``budget_seconds`` when less)."""
    from oracle.members import service as members_service

    try:
        await db.rollback()
        out.follow_ups = await members_service.run_follow_ups(
            db, principal, http, budget_seconds=budget_seconds
        )
    except Exception as exc:
        log.exception("tick: member follow-ups failed for company %s", tenant_id)
        await db.rollback()
        out.errors.append(exc)
    return out
