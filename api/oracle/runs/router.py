"""Runs, checkpoints, the Inbox and the tick that advances runs.

Roles: anyone signed in reads runs; an approver creates, estimates and starts one; an
owner approves a run over the cost threshold and resumes one paused on overrun; an
owner or the approver who created a run cancels it; a checkpoint is decided by its
``approver_role`` or above. The tick takes an owner or an API token.
"""

import uuid
from collections.abc import Awaitable
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import PlainTextResponse

from oracle.auth.deps import CurrentPrincipal, Principal, TenantDB, same_origin
from oracle.authz import require_role, require_role_now
from oracle.claude_accounts.sweep import summarise_sweep
from oracle.claude_accounts.sweep import sweep as sweep_claude_accounts
from oracle.connections.router import ProviderHttp
from oracle.jobs.worker import run_pending as run_llm_jobs
from oracle.members import service as members_service
from oracle.runs import service
from oracle.runs.schemas import (
    CheckpointDecision,
    EstimateOut,
    FlowCatalog,
    InboxOut,
    RunCreate,
    RunOut,
    RunPatch,
    RunStatus,
    RunSummary,
    RuntimeStatusOut,
    TickOut,
)
from oracle.swarm import RuntimeUnavailable, get_runtime
from oracle.swarm.settings import get_runtime_settings

router = APIRouter(prefix="/v1", tags=["runs"])

Approver = Annotated[Principal, Depends(require_role("approver"))]
Owner = Annotated[Principal, Depends(require_role("owner"))]
ApproverNow = Annotated[Principal, Depends(require_role_now("approver"))]
OwnerNow = Annotated[Principal, Depends(require_role_now("owner"))]


async def _call[T](op: Awaitable[T]) -> T:
    try:
        return await op
    except service.RunError as exc:
        raise HTTPException(exc.status, str(exc)) from exc


@router.get("/runtime/status", response_model=RuntimeStatusOut)
async def runtime_status(_: Owner) -> RuntimeStatusOut:
    """Call the agent runtime as Oracle and report what it answers: reachable, and as which
    tenant. Owner only. Never shows a credential."""
    runtime = get_runtime()
    out = RuntimeStatusOut(
        runtime=runtime.name,
        auth=get_runtime_settings().swarmcloud_auth if runtime.name == "swarmcloud" else None,
        reachable=False,
        can_reach_oracle=runtime.can_reach_oracle,
        notes=runtime.notes(),
    )
    try:
        me = await runtime.whoami()
    except RuntimeUnavailable as exc:
        out.error = str(exc)
        return out
    out.reachable = True
    out.tenant_id = me.get("tenant_id")
    return out


@router.get("/flows", response_model=FlowCatalog)
async def list_flows(principal: CurrentPrincipal) -> FlowCatalog:
    """The built-in flows with their segments, checkpoints, agent roles and cost table."""
    return service.flow_catalog()


@router.get("/runs", response_model=list[RunSummary])
async def list_runs(
    db: TenantDB, status_: Annotated[RunStatus | None, Query(alias="status")] = None
) -> list[RunSummary]:
    return await service.list_runs(db, status_)


@router.post("/runs", response_model=RunOut, status_code=status.HTTP_201_CREATED)
async def create_run(body: RunCreate, principal: ApproverNow, db: TenantDB) -> RunOut:
    """Create a draft run. Nothing runs and nothing is spent until it is started."""
    run_id = await _call(service.create_run(db, principal, body))
    return await service.read_run(db, run_id, principal)


@router.get("/runs/{run_id}", response_model=RunOut)
async def get_run(run_id: uuid.UUID, principal: CurrentPrincipal, db: TenantDB) -> RunOut:
    return await _call(service.read_run(db, run_id, principal))


@router.patch("/runs/{run_id}", response_model=RunOut)
async def update_run(
    run_id: uuid.UUID, body: RunPatch, principal: ApproverNow, db: TenantDB
) -> RunOut:
    """Change a draft's document or knobs; its estimate is cleared."""
    await _call(service.update_run(db, principal, run_id, body))
    return await service.read_run(db, run_id, principal)


@router.post("/runs/{run_id}/estimate", response_model=EstimateOut)
async def estimate_run(run_id: uuid.UUID, principal: ApproverNow, db: TenantDB) -> EstimateOut:
    """Per-segment cost estimate from the cost table; stored on the run."""
    return await _call(service.estimate(db, principal, run_id))


@router.post("/runs/{run_id}/start", response_model=RunOut)
async def start_run(run_id: uuid.UUID, principal: ApproverNow, db: TenantDB) -> RunOut:
    """Pin a snapshot and submit the first segment, or wait for an owner when the
    estimate is over the approval threshold ($50)."""
    await _call(service.start(db, principal, run_id))
    await service.submit_queued(db, run_id)
    return await service.read_run(db, run_id, principal)


@router.post("/runs/{run_id}/approve", response_model=RunOut, dependencies=[Depends(same_origin)])
async def approve_run(run_id: uuid.UUID, principal: OwnerNow, db: TenantDB) -> RunOut:
    """Approve the cost of a run awaiting approval and start it."""
    await _call(service.approve(db, principal, run_id))
    await service.submit_queued(db, run_id)
    return await service.read_run(db, run_id, principal)


@router.post("/runs/{run_id}/resume", response_model=RunOut, dependencies=[Depends(same_origin)])
async def resume_run(run_id: uuid.UUID, principal: OwnerNow, db: TenantDB) -> RunOut:
    """Resume a run paused on overrun; it may spend another half of its estimate."""
    await _call(service.resume(db, principal, run_id))
    await service.submit_queued(db, run_id)
    return await service.read_run(db, run_id, principal)


@router.post("/runs/{run_id}/cancel", response_model=RunOut)
async def cancel_run(run_id: uuid.UUID, principal: ApproverNow, db: TenantDB) -> RunOut:
    await _call(service.cancel(db, principal, run_id))
    return await service.read_run(db, run_id, principal)


@router.post("/runs/{run_id}/checkpoints/{checkpoint_id}/decide", response_model=RunOut)
async def decide_checkpoint(
    run_id: uuid.UUID,
    checkpoint_id: uuid.UUID,
    body: CheckpointDecision,
    principal: CurrentPrincipal,
    db: TenantDB,
) -> RunOut:
    """Approve a checkpoint (the next segment starts) or request changes (the segment
    runs again with the note)."""
    await _call(
        service.decide_checkpoint(db, principal, run_id, checkpoint_id, body.decision, body.note)
    )
    await service.submit_queued(db, run_id)
    return await service.read_run(db, run_id, principal)


@router.get(
    "/runs/{run_id}/segments/{seq}/artifacts/{name}",
    response_class=PlainTextResponse,
    responses={200: {"content": {"text/plain": {"schema": {"type": "string"}}}}},
)
async def get_run_artifact(
    run_id: uuid.UUID, seq: int, name: str, db: TenantDB
) -> PlainTextResponse:
    content = await _call(service.read_artifact(db, run_id, seq, name))
    return PlainTextResponse(content, media_type="text/plain; charset=utf-8")


@router.get("/inbox", response_model=InboxOut)
async def get_inbox(principal: CurrentPrincipal, db: TenantDB) -> InboxOut:
    """What waits on me: checkpoints for my role, runs waiting for an owner's approval
    or overrun decision, and open feedback on documents I can approve."""
    return await service.inbox(db, principal)


@router.post("/internal/tick", response_model=TickOut)
async def tick(principal: CurrentPrincipal, db: TenantDB, http: ProviderHttp) -> TickOut:
    """Advance this company's active runs, sweep its Claude account pool, run its
    queued built-in model jobs and retry the provider and runtime calls a member's
    disable still owes (``oracle tick`` calls it on a schedule)."""
    if principal.kind != "token" and principal.role != "owner":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Requires the owner role or an API token")
    try:
        out = await service.tick(db, principal)
        out.claude_accounts = summarise_sweep(await sweep_claude_accounts(principal.tenant_id))
        out.llm_jobs = await run_llm_jobs(principal.tenant_id)
    finally:
        # Last, within their own time budget: they never hold up runs and jobs, and a
        # failure of those never skips them.
        await db.rollback()
        follow_ups = await members_service.run_follow_ups(db, principal, http)
    out.member_follow_ups = follow_ups
    return out
