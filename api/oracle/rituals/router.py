"""H2 Cadence engine: ``/v1/rituals`` and ``/v1/ritual-occurrences``.

Everyone signed in reads rituals and pre-reads (run tokens with ``read:baseline`` too);
owners create, edit, pause, resume, prepare and delete them and choose the summaries
mode; the ritual's owner records an occurrence (held or skipped); approvers and owners
ask Oracle for a summary. Each route is an MCP tool by its operation id.
``/v1/rituals/summaries`` is declared before ``/v1/rituals/{ritual_id}``.
"""

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response, status
from fastapi.responses import PlainTextResponse

from oracle.auth.deps import Principal, TenantDB
from oracle.authz import require_role, require_role_now
from oracle.rituals import service, summaries
from oracle.rituals.schemas import (
    HeldIn,
    OccurrenceOut,
    OccurrenceSummary,
    RitualCreate,
    RitualOut,
    RitualPatch,
    SkipIn,
    SummarySettingsIn,
    SummarySettingsOut,
)
from oracle.runs.schemas import RunOut

router = APIRouter(prefix="/v1", tags=["rituals"])
Viewer = Annotated[Principal, Depends(require_role("viewer"))]
ViewerNow = Annotated[Principal, Depends(require_role_now("viewer"))]
ApproverNow = Annotated[Principal, Depends(require_role_now("approver"))]
OwnerNow = Annotated[Principal, Depends(require_role_now("owner"))]
ERRORS = {
    403: {"description": "Role too low, or not the ritual's owner"},
    404: {"description": "No such ritual or occurrence in this company"},
    409: {"description": "Stale lock_version, a built-in deleted, or a summary under way"},
    422: {"description": "Invalid schedule, length, lead time or attendees"},
}


def _call(e: service.RitualError):
    return service.raise_for(e)


@router.get("/rituals/summaries", response_model=SummarySettingsOut)
async def get_ritual_summary_settings(db: TenantDB, principal: Viewer) -> SummarySettingsOut:
    """The summaries mode (on_demand or always) and the monthly estimate of Every
    pre-read over the active rituals it would cover."""
    return await summaries.settings_out(db)


@router.put("/rituals/summaries", response_model=SummarySettingsOut, responses=ERRORS)
async def put_ritual_summary_settings(
    body: SummarySettingsIn, db: TenantDB, principal: OwnerNow
) -> SummarySettingsOut:
    """Owners: On demand, or Every pre-read (Oracle summarises each covered pre-read)."""
    return await summaries.set_mode(db, principal, body.mode)


@router.get("/rituals", response_model=list[RitualOut])
async def list_rituals(db: TenantDB, principal: Viewer) -> list[RitualOut]:
    """The company's rituals: built-ins first."""
    return [await service.ritual_out(db, r) for r in await service.list_rituals(db)]


@router.post("/rituals", response_model=RitualOut, status_code=201, responses=ERRORS)
async def create_ritual(body: RitualCreate, db: TenantDB, principal: OwnerNow) -> RitualOut:
    """Owners: a custom ritual, or a built-in kind the company does not have."""
    try:
        return await service.ritual_out(db, await service.create(db, principal, body))
    except service.RitualError as e:
        raise _call(e) from e


@router.get("/rituals/{ritual_id}", response_model=RitualOut, responses=ERRORS)
async def get_ritual(ritual_id: uuid.UUID, db: TenantDB, principal: Viewer) -> RitualOut:
    try:
        return await service.ritual_out(db, await service.get_ritual(db, ritual_id))
    except service.RitualError as e:
        raise _call(e) from e


@router.patch("/rituals/{ritual_id}", response_model=RitualOut, responses=ERRORS)
async def update_ritual(
    ritual_id: uuid.UUID, body: RitualPatch, db: TenantDB, principal: OwnerNow
) -> RitualOut:
    """Owners: schedule, length, lead time, owner, attendees or title."""
    try:
        return await service.ritual_out(db, await service.update(db, principal, ritual_id, body))
    except service.RitualError as e:
        raise _call(e) from e


@router.post("/rituals/{ritual_id}/pause", response_model=RitualOut, responses=ERRORS)
async def pause_ritual(ritual_id: uuid.UUID, db: TenantDB, principal: OwnerNow) -> RitualOut:
    try:
        r = await service.set_status(db, principal, ritual_id, "paused")
        return await service.ritual_out(db, r)
    except service.RitualError as e:
        raise _call(e) from e


@router.post("/rituals/{ritual_id}/resume", response_model=RitualOut, responses=ERRORS)
async def resume_ritual(ritual_id: uuid.UUID, db: TenantDB, principal: OwnerNow) -> RitualOut:
    try:
        r = await service.set_status(db, principal, ritual_id, "active")
        return await service.ritual_out(db, r)
    except service.RitualError as e:
        raise _call(e) from e


@router.post("/rituals/{ritual_id}/prepare", response_model=OccurrenceOut, responses=ERRORS)
async def prepare_ritual(ritual_id: uuid.UUID, db: TenantDB, principal: OwnerNow) -> OccurrenceOut:
    """Owners: Prepare now (builds the next pre-read at once), or Retry a failed one."""
    try:
        occ = await service.prepare(db, principal, ritual_id)
        occ, ritual = await service.get_occurrence(db, occ.id)
        return await service.occurrence_out(db, principal, occ, ritual)
    except service.RitualError as e:
        raise _call(e) from e


@router.delete("/rituals/{ritual_id}", status_code=204, responses=ERRORS)
async def delete_ritual(ritual_id: uuid.UUID, db: TenantDB, principal: OwnerNow) -> Response:
    """Owners: custom rituals only; built-ins pause (409)."""
    try:
        await service.delete(db, principal, ritual_id)
    except service.RitualError as e:
        raise _call(e) from e
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get(
    "/rituals/{ritual_id}/occurrences", response_model=list[OccurrenceSummary], responses=ERRORS
)
async def list_ritual_occurrences(
    ritual_id: uuid.UUID,
    db: TenantDB,
    principal: Viewer,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
) -> list[OccurrenceSummary]:
    """The ritual's recent occurrences, newest first."""
    try:
        return await service.list_occurrences(db, ritual_id, limit)
    except service.RitualError as e:
        raise _call(e) from e


@router.get("/ritual-occurrences/{occurrence_id}", response_model=OccurrenceOut, responses=ERRORS)
async def get_ritual_occurrence(
    occurrence_id: uuid.UUID, db: TenantDB, principal: Viewer
) -> OccurrenceOut:
    """One occurrence: its pre-read blocks, state, notes and summary."""
    try:
        occ, ritual = await service.get_occurrence(db, occurrence_id)
        return await service.occurrence_out(db, principal, occ, ritual)
    except service.RitualError as e:
        raise _call(e) from e


@router.get(
    "/ritual-occurrences/{occurrence_id}/pre-read.md",
    response_class=PlainTextResponse,
    responses={**ERRORS, 200: {"content": {"text/markdown": {}}}},
)
async def get_ritual_occurrence_pre_read(
    occurrence_id: uuid.UUID, db: TenantDB, principal: Viewer
) -> PlainTextResponse:
    """The pre-read as markdown, for agents and export."""
    try:
        occ, ritual = await service.get_occurrence(db, occurrence_id)
    except service.RitualError as e:
        raise _call(e) from e
    return PlainTextResponse(
        service.pre_read_markdown(occ, ritual), media_type="text/markdown; charset=utf-8"
    )


@router.post("/ritual-occurrences/{occurrence_id}/read", status_code=204, responses=ERRORS)
async def read_ritual_occurrence(
    occurrence_id: uuid.UUID, db: TenantDB, principal: ViewerNow
) -> Response:
    """Marks the pre-read read for me: its Inbox row is done."""
    try:
        await service.mark_read(db, principal, occurrence_id)
    except service.RitualError as e:
        raise _call(e) from e
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/ritual-occurrences/{occurrence_id}/held", response_model=OccurrenceOut, responses=ERRORS
)
async def hold_ritual_occurrence(
    occurrence_id: uuid.UUID, body: HeldIn, db: TenantDB, principal: ViewerNow
) -> OccurrenceOut:
    """The ritual's owner: Mark held, with the notes and the decisions recorded."""
    try:
        occ, ritual = await service.hold(db, principal, occurrence_id, body)
        return await service.occurrence_out(db, principal, occ, ritual)
    except service.RitualError as e:
        raise _call(e) from e


@router.post(
    "/ritual-occurrences/{occurrence_id}/skip", response_model=OccurrenceOut, responses=ERRORS
)
async def skip_ritual_occurrence(
    occurrence_id: uuid.UUID, body: SkipIn, db: TenantDB, principal: ViewerNow
) -> OccurrenceOut:
    """The ritual's owner: Skip, with a reason."""
    try:
        occ, ritual = await service.skip(db, principal, occurrence_id, body.reason)
        return await service.occurrence_out(db, principal, occ, ritual)
    except service.RitualError as e:
        raise _call(e) from e


@router.post(
    "/ritual-occurrences/{occurrence_id}/summary",
    response_model=RunOut,
    status_code=201,
    responses=ERRORS,
)
async def summarize_ritual_occurrence(
    occurrence_id: uuid.UUID, db: TenantDB, principal: ApproverNow
) -> RunOut:
    """Summarize with Oracle: one ritual_summary run ($3.00 at quick depth); 409 while
    this occurrence's summary run is under way."""
    from oracle.runs import service as runs_service

    try:
        occ, _ = await service.get_occurrence(db, occurrence_id, lock=True)
        run_id = await summaries.on_demand(db, principal, occ)
    except service.RitualError as e:
        raise _call(e) from e
    return await runs_service.read_run(db, run_id, principal)
