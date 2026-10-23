"""C7 Scope review: the feature-set stop's rows, edited row by row (``/v1/prd-scopes``).

Roles: any member reads a scope; the checkpoint's approver role or above (approvers and
owners) decides, edits, adds and enhances rows. Commenters suggest through the D8 actions
of the same checkpoint (``POST /v1/runs/{run_id}/checkpoints/{checkpoint_id}/actions``).
Every write needs the scope ``proposed`` and its checkpoint pending (409 otherwise),
takes the row's ``lock_version`` where it edits one (409 on a stale one) and bumps the
checkpoint's draft revision, so a decision sent with an older one gets D8's 409
``review_changed``. Run tokens are refused on every write.
"""

import uuid

from fastapi import APIRouter, HTTPException, Response, status

from oracle.auth.deps import CurrentPrincipal, TenantDB
from oracle.jobs.schemas import LlmJobOut
from oracle.jobs.service import job_out
from oracle.runs import scope_review, service
from oracle.runs.schemas import (
    PrdScopeReview,
    ScopeEnhanceAccept,
    ScopeEnhanceIn,
    ScopeItemOut,
    ScopeItemPatch,
    ScopeRequirementIn,
)

router = APIRouter(prefix="/v1/prd-scopes", tags=["scope"])


async def _call[T](op) -> T:  # type: ignore[no-untyped-def]
    try:
        return await op
    except service.RunError as exc:
        raise HTTPException(exc.status, getattr(exc, "detail", None) or str(exc)) from exc


@router.get("/{scope_id}", response_model=PrdScopeReview, operation_id="get_prd_scope_review")
async def get_prd_scope_review(
    scope_id: uuid.UUID, principal: CurrentPrincipal, db: TenantDB
) -> PrdScopeReview:
    """A PRD scope as its review screen reads it, any member: each feature with its
    requirements, reasons (blocking and to confirm, answered by D8 waivers and accepts)
    and history, the tally, and the previous attempt's decisions for the Changed filter."""
    return await _call(scope_review.read(db, principal, scope_id))


@router.patch(
    "/{scope_id}/items/{item_id}", response_model=ScopeItemOut, operation_id="patch_scope_item"
)
async def patch_scope_item(
    scope_id: uuid.UUID,
    item_id: uuid.UUID,
    body: ScopeItemPatch,
    principal: CurrentPrincipal,
    db: TenantDB,
) -> ScopeItemOut:
    """Decide or edit one row (approver role or above): a feature's decision (a left-out
    one with its reason), goals (confirmed goals only), dependencies and blockers; a
    requirement's decision, text and acceptance; ``revert`` puts the agent's values back.
    The scope is re-checked: the answer carries the new tally."""
    return await _call(scope_review.patch_item(db, principal, scope_id, item_id, body))


@router.post(
    "/{scope_id}/items",
    response_model=ScopeItemOut,
    status_code=status.HTTP_201_CREATED,
    operation_id="add_scope_requirement",
)
async def add_scope_requirement(
    scope_id: uuid.UUID, body: ScopeRequirementIn, principal: CurrentPrincipal, db: TenantDB
) -> ScopeItemOut:
    """Add a requirement to a feature (approver role or above): ``origin: person``; its
    goals default to the feature's. Approving writes it to the baseline as the approver's."""
    return await _call(scope_review.add_requirement(db, principal, scope_id, body))


@router.delete(
    "/{scope_id}/items/{item_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    operation_id="delete_scope_item",
)
async def delete_scope_item(
    scope_id: uuid.UUID, item_id: uuid.UUID, principal: CurrentPrincipal, db: TenantDB
) -> Response:
    """Remove a requirement a person added (approver role or above); 409 for a row the
    agents wrote (cut it instead)."""
    await _call(scope_review.delete_item(db, principal, scope_id, item_id))
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/{scope_id}/items/{item_id}/enhance",
    response_model=LlmJobOut,
    status_code=status.HTTP_202_ACCEPTED,
    operation_id="enhance_scope_requirement",
)
async def enhance_scope_requirement(
    scope_id: uuid.UUID,
    item_id: uuid.UUID,
    body: ScopeEnhanceIn,
    principal: CurrentPrincipal,
    db: TenantDB,
) -> LlmJobOut:
    """Ask Oracle to deepen a requirement (approver role or above): a queued
    ``scope_enhance`` job on Oracle's own model; poll ``GET /v1/llm-jobs/{job_id}``. Its
    output is a suggestion: nothing changes until it is accepted."""
    job = await _call(scope_review.enhance(db, principal, scope_id, item_id, body))
    return await job_out(db, job)


@router.post(
    "/{scope_id}/items/{item_id}/enhance/{job_id}/accept",
    response_model=ScopeItemOut,
    operation_id="accept_scope_enhancement",
)
async def accept_scope_enhancement(
    scope_id: uuid.UUID,
    item_id: uuid.UUID,
    job_id: uuid.UUID,
    body: ScopeEnhanceAccept,
    principal: CurrentPrincipal,
    db: TenantDB,
) -> ScopeItemOut:
    """Accept an enhancement (approver role or above), as Oracle wrote it or edited: the
    requirement's text and acceptance become the person's."""
    return await _call(scope_review.accept_enhancement(db, principal, scope_id, item_id, job_id,
                                                       body))  # fmt: skip
