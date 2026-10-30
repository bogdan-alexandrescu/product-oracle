"""plan-model: a PRD's plan (oracle.simple.plan). For people: a run's token is refused.

- ``GET /v1/simple/prds/{prd}/plan``: viewer and up who may read the PRD (404 otherwise):
  its milestones, slices, goals with targets per milestone, engineer-weeks per goal per
  milestone, planned vs capacity per milestone, the span and its label. Reading it after a
  new version is approved reads that version (its tables, else Oracle's job).
- ``POST /v1/simple/prds/{prd}/plan/read-again``: owners: read the approved version again.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status

from oracle import audit
from oracle.auth.deps import Principal, TenantDB
from oracle.simple import one_pager, plan
from oracle.simple.changes import ChangeError
from oracle.simple.router import _people
from oracle.simple.schemas import SimplePlanOut

router = APIRouter(prefix="/v1/simple/prds", tags=["simple"])

Reader = Annotated[Principal, Depends(_people("viewer"))]
Owner = Annotated[Principal, Depends(_people("owner"))]


async def _doc(db, principal, prd: str):
    try:
        return await one_pager._document(db, principal, prd)
    except ChangeError as e:
        raise HTTPException(e.status, e.detail) from e


@router.get("/{prd}/plan", response_model=SimplePlanOut)
async def get_simple_prd_plan(prd: str, principal: Reader, db: TenantDB) -> SimplePlanOut:
    """The PRD's plan as its latest approved version has it."""
    document = await _doc(db, principal, prd)
    row, v = await plan.ensure(db, document, persist=False)
    return await plan.plan_out(db, document, row, v, principal)


@router.post(
    "/{prd}/plan/read-again", response_model=SimplePlanOut, name="read_simple_prd_plan_again"
)
async def read_simple_prd_plan_again(prd: str, principal: Owner, db: TenantDB) -> SimplePlanOut:
    """Read the plan again from the approved version (its tables, else Oracle's job)."""
    document = await _doc(db, principal, prd)
    row, v = await plan.ensure(db, document, force=True)
    if v is None:
        raise HTTPException(status.HTTP_409_CONFLICT, plan.NO_VERSION)
    out = await plan.plan_out(db, document, row, v, principal)
    await audit.record(db, principal, "simple_prd_plan.read_again", "document", document.id,
                       data={"version": v.number})  # fmt: skip
    await db.commit()
    return out
