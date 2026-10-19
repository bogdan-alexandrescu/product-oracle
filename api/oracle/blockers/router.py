"""Blocker strategy routes (CR-04, build prompt §6).

Shaped for the blocker strategy view, reachable from the baseline (``/v1/blockers/{id}``)
and from a document (``/v1/documents/{doc}/blocker-strategy``): compare options, select
one with a reason, run experiments, accept a risk or approve a feasibility scope.

Everyone reads (viewer+). Commenters propose options; approvers and owners decide
(create and edit blockers, review compliance, select, run experiments, accept risks),
as they write the baseline. The foundation's read routes for options, experiments and
events (``/v1/blocker-options`` ...) stay; the writes below sit on the same paths.
Importing this module registers the ``critical_blockers`` readiness check.
"""

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status

from oracle.auth.deps import Principal, TenantDB
from oracle.authz import require_role
from oracle.blockers import readiness as _readiness  # noqa: F401 - registers the check
from oracle.blockers import service, views
from oracle.blockers.policy import LimitKind
from oracle.blockers.schemas import (
    BlockerCreate,
    BlockerModuleRender,
    BlockerOptionCreate,
    BlockerOptionDecision,
    BlockerOptionFallback,
    BlockerOptionPatch,
    BlockerOptionView,
    BlockerPatch,
    BlockerRiskAcceptanceIn,
    BlockerStatusIn,
    BlockerStrategy,
    BlockerSummary,
    BlockerType,
    DocumentBlockerStrategy,
    FeasibilityExperimentCreate,
    FeasibilityExperimentPatch,
    FeasibilityScopeIn,
)
from oracle.docs import service as docs_service
from oracle.v2.schemas import BlockerStatus, FeasibilityExperimentOut, Importance

router = APIRouter(prefix="/v1", tags=["blockers"])

Reader = Annotated[Principal, Depends(require_role("viewer"))]
Commenter = Annotated[Principal, Depends(require_role("commenter"))]
Approver = Annotated[Principal, Depends(require_role("approver"))]


def _fail(exc: service.BlockerError) -> HTTPException:
    return HTTPException(exc.status_code, str(exc))


async def _commit_strategy(db, principal: Principal, entity_id: uuid.UUID) -> BlockerStrategy:
    await db.commit()
    return await views.strategy(db, principal, entity_id)


async def _option_view(db, option) -> BlockerOptionView:
    await db.commit()
    await db.refresh(option)
    return BlockerOptionView.model_validate(option).model_copy(
        update={"policy_flags": service.flags_of(option)}
    )


async def _document(db, doc: str):
    try:
        return await docs_service.get_document_or_404(db, doc)
    except docs_service.NotFoundError as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(e)) from e


# --- blockers -------------------------------------------------------------------------------


@router.get("/blockers", response_model=list[BlockerSummary])
async def list_blockers(
    principal: Reader,
    db: TenantDB,
    document_id: uuid.UUID | None = None,
    status_: Annotated[BlockerStatus | None, Query(alias="status")] = None,
    type_: Annotated[BlockerType | None, Query(alias="type")] = None,
    severity: Importance | None = None,
    limit_kind: LimitKind | None = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> list[BlockerSummary]:
    """Blockers (baseline constraints with a strategy), most severe first. Third-party
    limits filter by ``limit_kind``: capacity, eligibility, permission or policy."""
    if document_id is not None:
        entities = await service.blockers_for_document(db, document_id)
    else:
        entities = await service.all_blockers(db)
    rows = await views.summaries(db, entities)
    rows = [
        r
        for r in rows
        if (status_ is None or r.status == status_)
        and (type_ is None or r.type == type_)
        and (severity is None or r.severity == severity)
        and (limit_kind is None or r.limit_kind == limit_kind)
    ]
    order = {"critical": 0, "warning": 1, "pass": 2, "not_applicable": 3}
    rows.sort(
        key=lambda r: (
            service.SEVERITY_RANK[r.severity],
            order[r.gate.status],
            r.statement.lower(),
            str(r.id),
        )
    )
    return rows[offset : offset + limit]


@router.post("/blockers", response_model=BlockerStrategy, status_code=status.HTTP_201_CREATED)
async def create_blocker(principal: Approver, db: TenantDB, body: BlockerCreate) -> BlockerStrategy:
    """Record a blocker: an existing constraint entity (``entity_id``), or a new one."""
    try:
        entity = await service.create_blocker(db, principal, body)
    except service.BlockerError as e:
        raise _fail(e) from e
    return await _commit_strategy(db, principal, entity.id)


@router.get("/blockers/{blocker_id}", response_model=BlockerStrategy)
async def get_blocker_strategy(
    blocker_id: uuid.UUID, principal: Reader, db: TenantDB
) -> BlockerStrategy:
    """The blocker strategy view: the blocker, evidence, options to compare (with policy
    flags and the recommended compliant one), experiments, events and its gate."""
    try:
        return await views.strategy(db, principal, blocker_id)
    except service.BlockerError as e:
        raise _fail(e) from e


@router.patch("/blockers/{blocker_id}", response_model=BlockerStrategy)
async def update_blocker(
    blocker_id: uuid.UUID, principal: Approver, db: TenantDB, body: BlockerPatch
) -> BlockerStrategy:
    """Edit a blocker. ``revision`` is the one you loaded; a stale one is a 409. The
    status changes only through the status, risk and feasibility routes."""
    try:
        await service.update_blocker(db, principal, blocker_id, body)
    except service.BlockerError as e:
        raise _fail(e) from e
    return await _commit_strategy(db, principal, blocker_id)


@router.post("/blockers/{blocker_id}/status", response_model=BlockerStrategy)
async def set_blocker_status(
    blocker_id: uuid.UUID, principal: Approver, db: TenantDB, body: BlockerStatusIn
) -> BlockerStrategy:
    """Open, mitigating or resolved (resolving needs a reason). Records a resolution
    event and a ``blocker_status`` change event."""
    try:
        await service.set_status(db, principal, blocker_id, body)
    except service.BlockerError as e:
        raise _fail(e) from e
    return await _commit_strategy(db, principal, blocker_id)


@router.post("/blockers/{blocker_id}/accept-risk", response_model=BlockerStrategy)
async def accept_blocker_risk(
    blocker_id: uuid.UUID, principal: Approver, db: TenantDB, body: BlockerRiskAcceptanceIn
) -> BlockerStrategy:
    """Accept the risk of an unresolved blocker: who and why are recorded (an assumption
    decision, a resolution event, an audit event) until the review date."""
    try:
        await service.accept_risk(db, principal, blocker_id, body)
    except service.BlockerError as e:
        raise _fail(e) from e
    return await _commit_strategy(db, principal, blocker_id)


@router.post("/blockers/{blocker_id}/feasibility-scope", response_model=BlockerStrategy)
async def approve_feasibility_scope(
    blocker_id: uuid.UUID, principal: Approver, db: TenantDB, body: FeasibilityScopeIn
) -> BlockerStrategy:
    """Proceed only as a scoped feasibility experiment (owner, success threshold and
    decision gate required). If the experiment fails or is cancelled, the blocker
    reopens."""
    try:
        await service.approve_feasibility_scope(db, principal, blocker_id, body)
    except service.BlockerError as e:
        raise _fail(e) from e
    return await _commit_strategy(db, principal, blocker_id)


# --- options --------------------------------------------------------------------------------


@router.post(
    "/blockers/{blocker_id}/options",
    response_model=BlockerOptionView,
    status_code=status.HTTP_201_CREATED,
)
async def create_blocker_option(
    blocker_id: uuid.UUID, principal: Commenter, db: TenantDB, body: BlockerOptionCreate
) -> BlockerOptionView:
    """Propose a solution option. It starts as ``needs_review``; text that evades platform
    rules, abuses accounts or messages people without permission is stored as
    ``non_compliant`` and ``rejected``, with the flags."""
    try:
        option = await service.create_option(db, principal, blocker_id, body)
    except service.BlockerError as e:
        raise _fail(e) from e
    return await _option_view(db, option)


@router.patch("/blocker-options/{item_id}", response_model=BlockerOptionView)
async def update_blocker_option(
    item_id: uuid.UUID, principal: Approver, db: TenantDB, body: BlockerOptionPatch
) -> BlockerOptionView:
    """Edit an option or record its compliance review (``lock_version`` required)."""
    try:
        option = await service.update_option(db, principal, item_id, body)
    except service.BlockerError as e:
        raise _fail(e) from e
    return await _option_view(db, option)


@router.post("/blocker-options/{item_id}/select", response_model=BlockerStrategy)
async def select_blocker_option(
    item_id: uuid.UUID, principal: Approver, db: TenantDB, body: BlockerOptionDecision
) -> BlockerStrategy:
    """Select a compliant option with a reason; a previous selection goes back to
    evaluating."""
    try:
        entity = await service.select_option(db, principal, item_id, body)
    except service.BlockerError as e:
        raise _fail(e) from e
    return await _commit_strategy(db, principal, entity.id)


@router.post("/blocker-options/{item_id}/fallback", response_model=BlockerOptionView)
async def mark_blocker_option_fallback(
    item_id: uuid.UUID, principal: Approver, db: TenantDB, body: BlockerOptionFallback
) -> BlockerOptionView:
    """Keep a compliant option as the fallback."""
    try:
        option = await service.mark_fallback(db, principal, item_id, body)
    except service.BlockerError as e:
        raise _fail(e) from e
    return await _option_view(db, option)


@router.post("/blocker-options/{item_id}/reject", response_model=BlockerOptionView)
async def reject_blocker_option(
    item_id: uuid.UUID, principal: Approver, db: TenantDB, body: BlockerOptionDecision
) -> BlockerOptionView:
    """Reject an option with a reason (a selected one leaves the blocker unselected)."""
    try:
        option = await service.reject_option(db, principal, item_id, body)
    except service.BlockerError as e:
        raise _fail(e) from e
    return await _option_view(db, option)


# --- experiments ----------------------------------------------------------------------------


@router.post(
    "/blockers/{blocker_id}/experiments",
    response_model=FeasibilityExperimentOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_feasibility_experiment(
    blocker_id: uuid.UUID, principal: Approver, db: TenantDB, body: FeasibilityExperimentCreate
) -> FeasibilityExperimentOut:
    """Plan a validation of the blocker or one of its options."""
    try:
        exp = await service.create_experiment(db, principal, blocker_id, body)
    except service.BlockerError as e:
        raise _fail(e) from e
    await db.commit()
    await db.refresh(exp)
    return FeasibilityExperimentOut.model_validate(exp)


@router.patch("/feasibility-experiments/{item_id}", response_model=FeasibilityExperimentOut)
async def update_feasibility_experiment(
    item_id: uuid.UUID, principal: Approver, db: TenantDB, body: FeasibilityExperimentPatch
) -> FeasibilityExperimentOut:
    """Edit, start or conclude an experiment (a result is needed to conclude)."""
    try:
        exp = await service.update_experiment(db, principal, item_id, body)
    except service.BlockerError as e:
        raise _fail(e) from e
    await db.commit()
    await db.refresh(exp)
    return FeasibilityExperimentOut.model_validate(exp)


# --- from a document ------------------------------------------------------------------------


@router.get("/documents/{doc}/blocker-strategy", response_model=DocumentBlockerStrategy)
async def get_document_blocker_strategy(
    doc: str, principal: Reader, db: TenantDB
) -> DocumentBlockerStrategy:
    """Every blocker that gates this document (listed on the blocker or linked from a
    section), most severe first, with the ``critical_blockers`` readiness outcome."""
    document = await _document(db, doc)
    return await views.document_strategy(db, principal, document)


@router.get("/documents/{doc}/blocker-strategy/render", response_model=BlockerModuleRender)
async def render_document_blocker_strategy(
    doc: str, principal: Reader, db: TenantDB
) -> BlockerModuleRender:
    """The ``constraints.solutions`` module in the draft format: a brief section, a full
    section, and the citations and appendix lines for Sources and data points (O1c)."""
    document = await _document(db, doc)
    return await views.render_document(db, document)
