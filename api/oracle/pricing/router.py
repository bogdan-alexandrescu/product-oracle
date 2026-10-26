"""H9 Pricing input: ``/v1/deal-outcomes`` and ``/v1/pricing-memos``. Every route is an
MCP tool.

Owners and approvers only. For a commenter or viewer the records are absent, not
disabled (H8): reads are 404 and writes 403. A run token acts as its run's creator, and
only reads (oracle.mcp.scopes: no write scope covers this area).
"""

import uuid
from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status

from oracle.auth.deps import Principal, TenantDB, body_type
from oracle.authz import recheck_caller, require_role, require_role_now, require_role_or_absent
from oracle.decisions import service as decisions_service
from oracle.decisions.schemas import DecisionOut
from oracle.http import read_capped_body
from oracle.pricing import decide, outcomes
from oracle.pricing.schemas import (
    DealOutcomeIn,
    DealOutcomeOut,
    DealOutcomePatch,
    DecideMemoIn,
    ImportOut,
    PricingMemoSummary,
    Reason,
    Result,
)

router = APIRouter(prefix="/v1", tags=["pricing"])

# H8: for a commenter or viewer the records and memos are absent, not disabled.
Hidden = Annotated[Principal, Depends(require_role_or_absent("approver"))]
Approver = Annotated[Principal, Depends(require_role("approver"))]
ApproverNow = Annotated[Principal, Depends(require_role_now("approver"))]


def _http(exc: outcomes.OutcomeError) -> HTTPException:
    return HTTPException(exc.status, str(exc))


# --------------------------------------------------------------------------- Win and loss

OUTCOME_ERRORS = {
    403: {"description": "Below approver (writes), or a run's agents"},
    404: {"description": "No such record in this company, or a reader below approver"},
    409: {"description": "Stale lock_version"},
    422: {"description": "A result or reason outside its list, Other without a note, a "
          "future decided_on, a value without its currency, or another person's source "
          "item"},
}  # fmt: skip


@router.get("/deal-outcomes", response_model=list[DealOutcomeOut], responses=OUTCOME_ERRORS)
async def list_deal_outcomes(
    db: TenantDB,
    principal: Hidden,
    result: Result | None = None,
    reason: Reason | None = None,
    date_from: Annotated[date | None, Query(alias="from")] = None,
    date_to: Annotated[date | None, Query(alias="to")] = None,
) -> list[DealOutcomeOut]:
    """Win and loss records, newest ``decided_on`` first; ``from`` and ``to`` are
    inclusive days."""
    return await outcomes.list_outcomes(
        db, result=result, reason=reason, date_from=date_from, date_to=date_to
    )


@router.post(
    "/deal-outcomes",
    response_model=DealOutcomeOut,
    status_code=status.HTTP_201_CREATED,
    responses=OUTCOME_ERRORS,
)
async def create_deal_outcome(
    body: DealOutcomeIn, db: TenantDB, principal: ApproverNow
) -> DealOutcomeOut:
    """Record one deal's result and its main reason."""
    try:
        row = await outcomes.create(db, principal, body)
    except outcomes.OutcomeError as e:
        raise _http(e) from e
    out = await outcomes.out(db, row)
    await db.commit()
    return out


@router.patch(
    "/deal-outcomes/{outcome_id}", response_model=DealOutcomeOut, responses=OUTCOME_ERRORS
)
async def update_deal_outcome(
    outcome_id: uuid.UUID, body: DealOutcomePatch, db: TenantDB, principal: ApproverNow
) -> DealOutcomeOut:
    """Change a record (lock_version required; null clears an optional field)."""
    try:
        row = await outcomes.patch(db, principal, outcome_id, body)
    except outcomes.OutcomeError as e:
        raise _http(e) from e
    out = await outcomes.out(db, row)
    await db.commit()
    return out


@router.delete(
    "/deal-outcomes/{outcome_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    responses=OUTCOME_ERRORS,
)
async def delete_deal_outcome(outcome_id: uuid.UUID, db: TenantDB, principal: ApproverNow) -> None:
    """Delete a record."""
    try:
        await outcomes.delete(db, principal, outcome_id)
    except outcomes.OutcomeError as e:
        raise _http(e) from e
    await db.commit()


@router.post(
    "/deal-outcomes/import",
    response_model=ImportOut,
    dependencies=[body_type("text/csv", "application/csv")],
    responses={
        **OUTCOME_ERRORS,
        422: {"description": "Over 1 MB or 2,000 rows, no header row, or not UTF-8 CSV"},
    },
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {"text/csv": {"schema": {"type": "string"}}},
        }
    },
)
async def import_deal_outcomes(
    request: Request, db: TenantDB, principal: Approver, dry_run: bool = False
) -> ImportOut:
    """Import records from CSV: a header row naming ``result, account, segment, plan,
    annual_value, currency, decided_on, reason, reason_note, alternative, price_quoted``,
    then at most 2,000 rows (1 MB). Bad rows are listed with their line number (the header
    is line 1) and good rows still import; ``dry_run`` creates nothing and returns the
    same counts. Result and reason take their keys or plain labels, in either case."""
    try:
        raw = await read_capped_body(request, outcomes.MAX_BYTES)
    except HTTPException as e:
        if e.status_code != status.HTTP_413_CONTENT_TOO_LARGE:
            raise
        raise HTTPException(422, "The file is larger than 1 MB") from e
    # The body is in before the gate is taken (and the caller re-read under it).
    await recheck_caller(db, principal, "approver")
    try:
        out = await outcomes.import_csv(db, principal, raw, dry_run=dry_run)
    except outcomes.OutcomeError as e:
        raise _http(e) from e
    await db.commit()
    return out


# --------------------------------------------------------------------------- Pricing memos

MEMO_ERRORS = {
    403: {"description": "Decide by anyone but the pricing owner"},
    404: {"description": "No such pricing memo in this company, or a reader below approver"},
    409: {"description": "Decide before the memo's latest version is approved"},
    422: {"description": "replaces names no decision"},
}


def _pricing_http(exc: decide.PricingError) -> HTTPException:
    return HTTPException(exc.status, str(exc))


@router.get("/pricing-memos", response_model=list[PricingMemoSummary], responses=MEMO_ERRORS)
async def list_pricing_memos(db: TenantDB, principal: Hidden) -> list[PricingMemoSummary]:
    """Pricing memos with their state (draft, in review, approved, decided) and their
    decision; owners and approvers only."""
    try:
        return await decide.list_memos(db, principal)
    except decide.PricingError as e:
        raise _pricing_http(e) from e


@router.post(
    "/pricing-memos/{doc}/decide",
    response_model=DecisionOut,
    status_code=status.HTTP_201_CREATED,
    responses={**MEMO_ERRORS, 200: {"description": "The memo's existing proposal"}},
)
async def decide_pricing_memo(
    doc: str,
    db: TenantDB,
    principal: Hidden,
    response: Response,
    body: DecideMemoIn | None = None,
) -> DecisionOut:
    """Decide: the pricing owner opens the approved memo's proposed decision in the
    decision log (created on the first call, the same one on a repeat), with the memo's
    options, the pricing owner as its approver and origin ``pricing``."""
    try:
        d, created = await decide.decide(
            db, principal, doc, replaces=body.replaces if body else None
        )
    except decide.PricingError as e:
        await db.rollback()
        raise _pricing_http(e) from e
    await db.commit()
    if not created:
        response.status_code = status.HTTP_200_OK
    return await decisions_service.out(db, principal, d)
