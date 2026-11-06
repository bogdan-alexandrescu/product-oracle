"""GET /v1/rebuilds: the rebuild sign beside a document's version (``oracle.rebuilds``).

Its own router (not oracle.runs'): it reads runs through GET /v1/runs' visibility only.
"""

from typing import Annotated

from fastapi import APIRouter, Depends

from oracle.auth.deps import Principal, TenantDB
from oracle.authz import require_role
from oracle.discussions import research as discussion_research
from oracle.rebuilds import service
from oracle.rebuilds.schemas import RebuildsOut
from oracle.runs import service as runs_service

router = APIRouter(prefix="/v1", tags=["runs"])

Reader = Annotated[Principal, Depends(require_role("viewer"))]


@router.get("/rebuilds", response_model=RebuildsOut)
async def list_rebuilds(principal: Reader, db: TenantDB) -> RebuildsOut:
    """The rebuild sign: the runs that will make a new version of a document the caller
    may read (scheduled, running, waiting, stopped, or landed and not approved yet)."""
    hidden = await discussion_research.hidden_runs(db, principal)
    visible = [r for r in await runs_service.list_runs(db) if r.id not in hidden]
    return await service.list_rebuilds(db, visible)
