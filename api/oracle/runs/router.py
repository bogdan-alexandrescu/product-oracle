"""Runs, checkpoints, the Inbox and the tick that advances runs.

Roles: anyone signed in reads runs; an approver creates, estimates and starts one; an
owner approves a run over the cost threshold and resumes one paused on overrun; an
owner or the approver who created a run cancels it; a checkpoint is decided by its
``approver_role`` or above, who may also retry importing the draft it waits on after the
import was refused (owners also once the run finished). The tick takes an owner or an API
token.
"""

import asyncio
import time
import uuid
from collections.abc import Awaitable
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import PlainTextResponse

from oracle.auth.deps import CurrentPrincipal, Principal, TenantDB, same_origin
from oracle.authz import require_role, require_role_now
from oracle.claude_accounts.sweep import summarise_sweep
from oracle.connections.router import ProviderHttp
from oracle.jobs.worker import run_pending as run_llm_jobs
from oracle.runs import service
from oracle.runs.schemas import (
    CancelAgain,
    CheckpointDecision,
    EstimateOut,
    FlowCatalog,
    InboxOut,
    McpServerRegistration,
    RunCreate,
    RunDecision,
    RunOut,
    RunPatch,
    RunStatus,
    RunSummary,
    RuntimeFeatures,
    RuntimeStatusOut,
    TickOut,
)
from oracle.swarm import Features, RuntimeUnavailable, get_runtime, load_learned
from oracle.swarm.runtime import MCP_SERVER
from oracle.swarm.settings import get_runtime_settings
from oracle.ticker import body as tick_body
from oracle.ticker import router as scheduler_tick

router = APIRouter(prefix="/v1", tags=["runs"])

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
    """Call the agent runtime as Oracle and report what it answers: reachable, as which
    tenant, and which adapter v2 features are on (mcp, await_input, service_answer: on,
    off or unknown; read briefly cached, never longer than the runtime's timeout). Owner
    only. Never shows a credential."""
    runtime = get_runtime()
    # Both calls at once: each holds its own deadline, so the answer takes at most one.
    me, feats = await asyncio.gather(runtime.whoami(), runtime.features(), return_exceptions=True)
    out = RuntimeStatusOut(
        runtime=runtime.name,
        auth=get_runtime_settings().swarmcloud_auth if runtime.name == "swarmcloud" else None,
        reachable=False,
        can_reach_oracle=runtime.can_reach_oracle,
        notes=runtime.notes(),
    )
    if isinstance(feats, Features):
        out.features = RuntimeFeatures(**feats.as_dict())
        out.feature_reasons = {
            k: v for k, v in feats.reasons.items() if getattr(feats, k, "on") != "on"
        }
    elif isinstance(feats, BaseException) and not isinstance(feats, RuntimeUnavailable):
        raise feats
    if isinstance(me, RuntimeUnavailable):
        out.error = str(me)
        return out
    if isinstance(me, BaseException):
        raise me
    out.reachable = True
    out.tenant_id = me.get("tenant_id")
    return out


@router.post("/runtime/mcp-server", response_model=McpServerRegistration)
async def register_mcp_server(_: Owner) -> McpServerRegistration:
    """Register Oracle's MCP server in the agent runtime, idempotently: created when
    missing, its URL updated when ORACLE_PUBLIC_URL changed, else unchanged. Runs do this
    on their own before the first run token is sent; this is for owners and the
    switch-on check. Owner only."""
    url = get_runtime_settings().public_url.rstrip("/") + "/mcp"
    try:
        result = await get_runtime().ensure_mcp_server(url)
    except RuntimeUnavailable as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)) from None
    return McpServerRegistration(name=MCP_SERVER, url=url, result=result)  # type: ignore[arg-type]


@router.get("/flows", response_model=FlowCatalog)
async def list_flows(principal: CurrentPrincipal) -> FlowCatalog:
    """The built-in flows with their segments, checkpoints, agent roles and cost table."""
    # The runtime notes say what the runtime can do: as every instance learned it.
    await load_learned(get_runtime())
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


@router.get("/runs/{run_id}/decisions", response_model=list[RunDecision])
async def list_run_decisions(
    run_id: uuid.UUID, principal: CurrentPrincipal, db: TenantDB
) -> list[RunDecision]:
    """What people decided at the run's checkpoints, by segment then decided time: role
    (never a name), when, the decision, the note, the edits applied and the review sent
    back. Pending checkpoints are not listed. A run's agents read their own run's with
    the get_checkpoint_review tool."""
    return await _call(service.list_decisions(db, run_id, principal))


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


@router.post("/runs/{run_id}/retry", response_model=RunOut)
async def retry_run(run_id: uuid.UUID, principal: ApproverNow, db: TenantDB) -> RunOut:
    """Retry a run whose lost submission Oracle could neither find nor rule out (Inbox:
    lookups): looked up once more, else the segment is submitted again."""
    await _call(service.retry(db, principal, run_id))
    # The segment is queued under the gate; submitted here, with nothing held.
    await service.submit_queued(db, run_id)
    return await service.read_run(db, run_id, principal)


@router.post("/runs/{run_id}/cancel", response_model=RunOut)
async def cancel_run(run_id: uuid.UUID, principal: ApproverNow, db: TenantDB) -> RunOut:
    await _call(service.cancel(db, principal, run_id))
    return await service.read_run(db, run_id, principal)


@router.post("/runs/{run_id}/stop-cancelling", response_model=RunOut)
async def stop_cancelling_run(run_id: uuid.UUID, principal: ApproverNow, db: TenantDB) -> RunOut:
    """Stop cancelling a workflow whose cancel SwarmCloud keeps answering with a 404 that
    proves nothing (Inbox: ``can_stop_cancelling``): the cancel calls stop and the Inbox
    item clears. A run that has not ended ends (cancelled, the reason recorded) and no
    second workflow starts for that segment; Oracle keeps reading the stopped workflow's
    status and cost on every tick until it ends, and counts its spend on the run (P3d)."""
    await _call(service.stop_cancelling(db, principal, run_id))
    return await service.read_run(db, run_id, principal)


@router.post("/runs/{run_id}/retry-lookup", response_model=RunOut)
async def retry_lookup_run(run_id: uuid.UUID, principal: ApproverNow, db: TenantDB) -> RunOut:
    """Read a workflow whose cost is unknown now (Inbox: ``can_retry_lookup``): its status
    did not read past its search's end, or SwarmCloud answered it with 404s that prove
    nothing, or its confirmed cancel still reads CANCELLING. Read, its cost is counted
    on the run and it is followed until it ends. That workflow only, at most once per
    30 s per run (429 sooner)."""
    await _call(service.retry_lookup(db, principal, run_id))
    return await service.read_run(db, run_id, principal)


@router.post("/runs/{run_id}/retry-import", response_model=RunOut)
async def retry_import_run(run_id: uuid.UUID, principal: OwnerNow, db: TenantDB) -> RunOut:
    """Retry importing a step's output (Inbox: ``imports``, ``can_retry_import``): Oracle
    stopped after its resumed advance failed 5 times in a row; the next tick tries again,
    the count reset. Owners only; audited."""
    await _call(service.retry_import(db, principal, run_id))
    return await service.read_run(db, run_id, principal)


@router.post("/runs/{run_id}/segments/{seq}/retry-draft-import", response_model=RunOut)
async def retry_draft_import(
    run_id: uuid.UUID, seq: int, principal: CurrentPrincipal, db: TenantDB
) -> RunOut:
    """Import a segment's draft again after its import at segment end was refused
    (``segments[].can_retry_draft_import``; the refusal is ``segments[].draft_import.error``,
    its problems ``draft_import.problems`` and their summary ``draft_import.summary``).
    While the run waits at that segment's review: the review's approver role or above, and
    nothing is decided (the review stays open for a person). After the run finished with
    the review approved past the refusal: owners only, while no version from the run
    exists; the run's checkpoints do not change. Imported, the run names the document and
    the error is replaced by the import; refused again, by the new error (200 either way:
    read ``draft_import``). 409 when there is nothing to retry (imported already, a version
    from the run exists, no draft file, changes requested, the run cancelled or failed).
    Audited. Not the stopped advance of ``retry_import_run``."""
    await _call(service.retry_draft_import(db, principal, run_id, seq))
    return await service.read_run(db, run_id, principal)


@router.post("/runs/{run_id}/cancel-again", response_model=RunOut)
async def cancel_again_run(
    run_id: uuid.UUID, body: CancelAgain, principal: ApproverNow, db: TenantDB
) -> RunOut:
    """Cancel again (Inbox: ``cancel_again``): a workflow an approver stopped cancelling,
    whose spend took the ended run over its ceiling, has Oracle's cancel calls turned
    back on; its status and cost are still read until it ends, and nothing restarts
    (P3d). An owner or the approver who created the run; audited."""
    await _call(service.cancel_again(db, principal, run_id, body.workflow_id))
    return await service.read_run(db, run_id, principal)


@router.post("/runs/{run_id}/dismiss-overrun", response_model=RunOut)
async def dismiss_overrun_run(run_id: uuid.UUID, principal: ApproverNow, db: TenantDB) -> RunOut:
    """Clear an ended run's overrun from the Inbox (``can_dismiss_overrun``: nothing of
    the run is left to read). The overrun stays recorded on the run; audited."""
    await _call(service.dismiss_overrun(db, principal, run_id))
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
    runs again with the note). Approving is refused (409) while the draft its segment left
    is not imported (``cannot_approve``): retry the import, or request changes."""
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
    run_id: uuid.UUID,
    seq: int,
    name: str,
    db: TenantDB,
    attempt: Annotated[
        int | None,
        Query(
            description="The attempt whose file to read: the current one, or the previous one "
            "a send-back kept. Older attempts are not kept (404)."
        ),
    ] = None,
) -> PlainTextResponse:
    content = await _call(service.read_artifact(db, run_id, seq, name, attempt))
    return PlainTextResponse(content, media_type="text/plain; charset=utf-8")


@router.get("/inbox", response_model=InboxOut)
async def get_inbox(
    principal: CurrentPrincipal,
    db: TenantDB,
    mark_seen: Annotated[
        bool, Query(description="Record this visit as my last one (what 'new' is measured from)")
    ] = False,
) -> InboxOut:
    """What waits on me: checkpoints for my role, runs waiting for an owner's approval
    or overrun decision, and feedback on documents I can approve, by state (new, open,
    staged for the next draft, declined, done) with the staged rows per document."""
    return await service.inbox(db, principal, mark_seen)


@router.post("/internal/tick", response_model=TickOut)
async def tick(principal: CurrentPrincipal, db: TenantDB, http: ProviderHttp) -> TickOut:
    """Advance this company's active runs, sweep its Claude account pool, run its
    queued built-in model jobs and retry the provider and runtime calls a member's
    disable still owes (``oracle tick`` calls it on a schedule)."""
    if principal.kind != "token" and principal.role != "owner":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Requires the owner role or an API token")
    if principal.kind == "token" and principal.role == "viewer":
        # The tick submits workflows and spends: a read-only token does not run it.
        raise HTTPException(status.HTTP_403_FORBIDDEN, "A viewer API token cannot run the tick")
    started = time.monotonic()
    # The scheduled ticker's body, for this company (oracle.ticker.body).
    company = await tick_body.tick_company(db, principal.tenant_id, principal)
    try:
        # The scheduled tick's time limit, from the start of this request: no job is
        # claimed, and no call started, that could not finish inside it.
        budget = scheduler_tick.HARD_LIMIT_SECONDS - (time.monotonic() - started)
        llm_jobs = await run_llm_jobs(principal.tenant_id, budget_seconds=budget)
    finally:
        # Last, within their own time budget: they never hold up runs and jobs, and a
        # failure of those never skips them.
        await tick_body.settle_company(db, principal.tenant_id, http, company, principal)
    if company.errors:
        raise company.errors[0]
    out = company.runs
    assert out is not None
    # Only when due, at most every five minutes however often this is called.
    out.claude_accounts = summarise_sweep(company.sweep)
    out.llm_jobs = llm_jobs
    out.member_follow_ups = company.follow_ups
    return out
