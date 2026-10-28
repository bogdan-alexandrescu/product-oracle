"""The decision log (H1): ``/v1/decisions``.

Everyone signed in reads it; commenters and above propose (run tokens with
``write:proposals``, as Oracle); only a decision's named approver decides and reviews it;
owners reassign. ``{decision}`` is a uuid, a number or a D-number. Each route is an MCP
tool by its operation id; run tokens never decide, review or reassign.
"""

import uuid
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status

from oracle.auth.deps import Principal, TenantDB
from oracle.authz import require_role, require_role_now
from oracle.decisions import service
from oracle.decisions.schemas import (
    DecideIn,
    DecisionCreate,
    DecisionOut,
    DecisionPatch,
    DecisionPerson,
    DecisionSummary,
    Origin,
    ReassignIn,
    ReviewIn,
    SubjectKind,
    WithdrawIn,
)
from oracle.jobs import service as jobs_service
from oracle.jobs.schemas import LlmJobOut

router = APIRouter(prefix="/v1", tags=["decisions"])
Viewer = Annotated[Principal, Depends(require_role("viewer"))]
# Deciding and reviewing are the named approver's, checked by the service (403 "Only <name>
# decides D-n" for everyone else); the caller is re-read under the review gate.
MemberNow = Annotated[Principal, Depends(require_role_now("viewer"))]
CommenterNow = Annotated[Principal, Depends(require_role_now("commenter"))]
ApproverNow = Annotated[Principal, Depends(require_role_now("approver"))]
OwnerNow = Annotated[Principal, Depends(require_role_now("owner"))]
ERRORS = {
    403: {"description": "Role, or not the named approver"},
    404: {"description": "No such decision in this company"},
    409: {"description": "Stale lock_version, a decided decision, or a checkpoint record"},
    422: {"description": "Invalid options, rationale, expected outcome or review date"},
}


def _raise(e: service.DecisionError) -> HTTPException:
    return HTTPException(e.status, e.message)


async def _get(db: TenantDB, key: str, *, lock: bool = False):
    try:
        return await service.resolve(db, key, lock=lock)
    except service.DecisionError as e:
        raise _raise(e) from e


@router.get("/decisions", response_model=list[DecisionSummary])
async def list_decisions(
    db: TenantDB,
    principal: Viewer,
    class_: Annotated[Literal["judgement", "checkpoint", "all"], Query(alias="class")] = "all",
    status_: Annotated[
        Literal["proposed", "decided", "review_due", "open", "superseded", "reversed", "withdrawn"]
        | None,
        Query(
            alias="status",
            description="open is proposed or review due: what waits on its approver",
        ),
    ] = None,
    approver: Annotated[str | None, Query(description="me or a member id")] = None,
    due: Annotated[
        bool | None,
        Query(description="true: only those whose review has come; false: none of them"),
    ] = None,
    origin: Annotated[
        str | None,
        Query(description=f"one or more of {', '.join(Origin.__args__)}, comma-separated"),
    ] = None,
    chosen: Annotated[
        str | None, Query(max_length=60, description="the chosen option's key")
    ] = None,
    run_id: uuid.UUID | None = None,
    subject_kind: SubjectKind | None = None,
    subject_id: str | None = None,
    q: Annotated[str | None, Query(max_length=200)] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> list[DecisionSummary]:
    """Decisions, newest D-number first. ``class`` defaults to ``all`` (both judgement calls
    and checkpoint records); agents pass ``class=judgement`` to read the company's decided
    calls, ``class=checkpoint`` for a run's stops approved and sent back. Every filter runs
    here, so ``limit`` and ``offset`` page through what matches."""
    filters = service.Filters(
        class_=class_,
        status=status_,
        approver=approver,
        due=due,
        origin=origin,
        chosen=chosen,
        run_id=run_id,
        subject_kind=subject_kind,
        subject_id=subject_id,
        q=q,
        limit=limit,
        offset=offset,
    )
    try:
        return await service.list_decisions(db, principal, filters)
    except service.DecisionError as e:
        raise _raise(e) from e


@router.get("/decisions/people", response_model=list[DecisionPerson])
async def list_decision_people(db: TenantDB, principal: Viewer) -> list[DecisionPerson]:
    """Active members (id, email, role): the approver is one with the approver role or
    above; contributors and informed are any member."""
    if principal.is_run:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "People are listed for people, not runs")
    return [DecisionPerson(id=u.id, email=u.email, role=u.role) for u in await service.people(db)]


@router.post(
    "/decisions",
    response_model=DecisionOut,
    status_code=status.HTTP_201_CREATED,
    responses=ERRORS,
)
async def create_decision(
    body: DecisionCreate, db: TenantDB, principal: CommenterNow
) -> DecisionOut:
    """Propose a decision (commenter and above). A run token's proposal is Oracle's
    (driver and origin ``oracle``); only the named approver decides it."""
    try:
        d = await service.create(db, principal, body)
    except service.DecisionError as e:
        raise _raise(e) from e
    await db.commit()
    return await service.out(db, principal, d)


@router.get("/decisions/{decision}", response_model=DecisionOut, responses=ERRORS)
async def get_decision(decision: str, db: TenantDB, principal: Viewer) -> DecisionOut:
    return await service.out(db, principal, await _get(db, decision))


@router.patch("/decisions/{decision}", response_model=DecisionOut, responses=ERRORS)
async def update_decision(
    decision: str, body: DecisionPatch, db: TenantDB, principal: CommenterNow
) -> DecisionOut:
    """Edit a proposed decision (its creator, its approver, an owner; lock_version)."""
    d = await _get(db, decision, lock=True)
    try:
        await service.update(db, principal, d, body)
    except service.DecisionError as e:
        raise _raise(e) from e
    await db.commit()
    return await service.out(db, principal, d)


@router.post("/decisions/{decision}/decide", response_model=DecisionOut, responses=ERRORS)
async def decide_decision(
    decision: str, body: DecideIn, db: TenantDB, principal: MemberNow
) -> DecisionOut:
    """Decide: only the named approver. Picks an option with a rationale, confirms
    reversibility, sets the review date (default plus 90 days) and the expected outcome;
    a prediction creates its outcome record."""
    d = await _get(db, decision, lock=True)
    try:
        await service.decide(db, principal, d, body)
    except service.DecisionError as e:
        raise _raise(e) from e
    await db.commit()
    return await service.out(db, principal, d)


@router.post("/decisions/{decision}/reassign", response_model=DecisionOut, responses=ERRORS)
async def reassign_decision(
    decision: str, body: ReassignIn, db: TenantDB, principal: OwnerNow
) -> DecisionOut:
    d = await _get(db, decision, lock=True)
    try:
        await service.reassign(db, principal, d, body)
    except service.DecisionError as e:
        raise _raise(e) from e
    await db.commit()
    return await service.out(db, principal, d)


@router.post("/decisions/{decision}/withdraw", response_model=DecisionOut, responses=ERRORS)
async def withdraw_decision(
    decision: str, body: WithdrawIn, db: TenantDB, principal: CommenterNow
) -> DecisionOut:
    d = await _get(db, decision, lock=True)
    try:
        await service.withdraw(db, principal, d, body.reason)
    except service.DecisionError as e:
        raise _raise(e) from e
    await db.commit()
    return await service.out(db, principal, d)


@router.post("/decisions/{decision}/reviews", response_model=DecisionOut, responses=ERRORS)
async def review_decision(
    decision: str, body: ReviewIn, db: TenantDB, principal: MemberNow
) -> DecisionOut:
    """Review a decided decision (its approver): reaffirm it with the next review date,
    revisit it (a new proposal that supersedes it once decided, ``revisit_id``), or
    reverse it."""
    d = await _get(db, decision, lock=True)
    try:
        await service.review(db, principal, d, body)
    except service.DecisionError as e:
        raise _raise(e) from e
    await db.commit()
    return await service.out(db, principal, d)


@router.post(
    "/decisions/{decision}/options-job",
    response_model=LlmJobOut,
    status_code=status.HTTP_201_CREATED,
    responses=ERRORS,
)
async def recommend_decision_options(
    decision: str, db: TenantDB, principal: ApproverNow
) -> LlmJobOut:
    """Ask Oracle for options (approver and above): a built-in job on Oracle's own model
    fills the options with evidence and marks the one it recommends."""
    d = await _get(db, decision, lock=True)
    try:
        job = await service.queue_options_job(db, principal, d)
    except service.DecisionError as e:
        raise _raise(e) from e
    await db.commit()
    return await jobs_service.job_out(db, job)
