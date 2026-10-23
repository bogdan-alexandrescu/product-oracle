"""Delete, restore, Trash and Regenerate (#482).

Roles: owners delete any document, intake or run, see Settings › Trash, restore and purge;
a document's approvers (approver role and above) regenerate it. Commenters and viewers do
none of these. A run's agents never do any of them (``not_for_runs``), and every
body-less write refuses another site's request (``same_origin``).
"""

import uuid
from collections.abc import Awaitable
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status

from oracle.auth.deps import Principal, TenantDB, same_origin
from oracle.authz import not_for_runs, require_role_now
from oracle.runs import service as runs_service
from oracle.runs.schemas import RunOut
from oracle.trash import regenerate, service
from oracle.trash.models import TrashEntry
from oracle.trash.schemas import (
    DependentsOut,
    RegenerateEstimateIn,
    RegenerateEstimateOut,
    RegenerateIn,
    TrashEntryOut,
)

router = APIRouter(prefix="/v1", tags=["trash"], dependencies=[Depends(not_for_runs)])

OwnerNow = Annotated[Principal, Depends(require_role_now("owner"))]
ApproverNow = Annotated[Principal, Depends(require_role_now("approver"))]
SAME_ORIGIN = [Depends(same_origin)]
Reason = Annotated[str | None, Query(max_length=2000)]


async def _call[T](op: Awaitable[T]) -> T:
    try:
        return await op
    except (service.TrashError, runs_service.RunError) as exc:
        raise HTTPException(exc.status, getattr(exc, "detail", None) or str(exc)) from exc


def _entry_out(entry: TrashEntry) -> TrashEntryOut:
    return TrashEntryOut(
        id=entry.id,
        root=entry.root,  # type: ignore[arg-type]
        items=entry.items,  # type: ignore[arg-type]
        deleted_by=entry.deleted_by,
        deleted_by_name=entry.deleted_by_name,
        deleted_at=entry.created_at,
        reason=entry.reason,
        published=entry.published,
        purge_after=entry.purge_after,
        days_left=service.days_left(entry),
    )


async def _dependents(db: TenantDB, root_type: str, ref: str) -> DependentsOut:
    root = await _call(service.find_root(db, root_type, ref))
    return DependentsOut(**service.preview(await service.resolve(db, root_type, root)))


async def _delete(
    db: TenantDB,
    principal: Principal,
    root_type: str,
    ref: str,
    reason: str | None,
    confirm_published: bool,
) -> TrashEntryOut:
    entry = await _call(
        service.delete_root(
            db, principal, root_type, ref, reason=reason, confirm_published=confirm_published
        )
    )
    out = _entry_out(entry)
    await db.commit()
    return out


async def _restore(db: TenantDB, principal: Principal, root_type: str, ref: str) -> TrashEntryOut:
    entry = await _call(service.restore_root(db, principal, root_type, ref))
    out = _entry_out(entry)
    await db.commit()
    return out


# --- documents ------------------------------------------------------------------------


@router.get("/documents/{doc}/dependents", response_model=DependentsOut)
async def document_dependents(doc: str, db: TenantDB, principal: OwnerNow) -> DependentsOut:
    """What a delete of this document takes to Trash with it (the delete dialog)."""
    return await _dependents(db, "document", doc)


@router.delete("/documents/{doc}", response_model=TrashEntryOut, dependencies=SAME_ORIGIN)
async def delete_document(
    doc: str,
    db: TenantDB,
    principal: OwnerNow,
    reason: Reason = None,
    confirm_published: bool = False,
) -> TrashEntryOut:
    """Move the document and its dependents to Trash (30 days, then purged). A published
    one needs ``confirm_published`` (409 without): its external copy stays where it is.
    409 while a run is working on any of them."""
    return await _delete(db, principal, "document", doc, reason, confirm_published)


@router.post("/documents/{doc}/restore", response_model=TrashEntryOut, dependencies=SAME_ORIGIN)
async def restore_document(doc: str, db: TenantDB, principal: OwnerNow) -> TrashEntryOut:
    """Restore the document with everything that went to Trash with it."""
    return await _restore(db, principal, "document", doc)


# --- intakes --------------------------------------------------------------------------


@router.get("/intakes/{intake_id}/dependents", response_model=DependentsOut)
async def intake_dependents(
    intake_id: uuid.UUID, db: TenantDB, principal: OwnerNow
) -> DependentsOut:
    return await _dependents(db, "intake", str(intake_id))


@router.delete("/intakes/{intake_id}", response_model=TrashEntryOut, dependencies=SAME_ORIGIN)
async def delete_intake(
    intake_id: uuid.UUID,
    db: TenantDB,
    principal: OwnerNow,
    reason: Reason = None,
    confirm_published: bool = False,
) -> TrashEntryOut:
    """Move the brief, the PRD it became and that PRD's dependents to Trash."""
    return await _delete(db, principal, "intake", str(intake_id), reason, confirm_published)


@router.post("/intakes/{intake_id}/restore", response_model=TrashEntryOut, dependencies=SAME_ORIGIN)
async def restore_intake(intake_id: uuid.UUID, db: TenantDB, principal: OwnerNow) -> TrashEntryOut:
    return await _restore(db, principal, "intake", str(intake_id))


# --- runs -----------------------------------------------------------------------------


@router.delete("/runs/{run_id}", response_model=TrashEntryOut, dependencies=SAME_ORIGIN)
async def delete_run(
    run_id: uuid.UUID, db: TenantDB, principal: OwnerNow, reason: Reason = None
) -> TrashEntryOut:
    """Move a finished, cancelled or draft run to Trash (409 while it works)."""
    return await _delete(db, principal, "run", str(run_id), reason, False)


@router.post("/runs/{run_id}/restore", response_model=TrashEntryOut, dependencies=SAME_ORIGIN)
async def restore_run(run_id: uuid.UUID, db: TenantDB, principal: OwnerNow) -> TrashEntryOut:
    return await _restore(db, principal, "run", str(run_id))


# --- Settings › Trash -----------------------------------------------------------------


@router.get("/trash", response_model=list[TrashEntryOut])
async def list_trash(db: TenantDB, principal: OwnerNow) -> list[TrashEntryOut]:
    """What is in Trash, newest first: who deleted it, when, why, what went with it and
    the days left before the ticker purges it."""
    return [_entry_out(e) for e in await service.list_entries(db)]


@router.post("/trash/{entry_id}/restore", response_model=TrashEntryOut, dependencies=SAME_ORIGIN)
async def restore_trash_entry(
    entry_id: uuid.UUID, db: TenantDB, principal: OwnerNow
) -> TrashEntryOut:
    """Restore everything the delete took, together."""
    entry = await _call(service.restore_entry(db, principal, entry_id))
    out = _entry_out(entry)
    await db.commit()
    return out


@router.delete(
    "/trash/{entry_id}", status_code=status.HTTP_204_NO_CONTENT, dependencies=SAME_ORIGIN
)
async def purge_trash_entry(entry_id: uuid.UUID, db: TenantDB, principal: OwnerNow) -> Response:
    """Delete for good now, without waiting for the 30 days."""
    entry = await _call(service.get_entry(db, entry_id))
    await service.purge_entry(db, principal, entry)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --- Regenerate -----------------------------------------------------------------------


@router.post("/documents/{doc}/regenerate/estimate", response_model=RegenerateEstimateOut)
async def estimate_regeneration(
    doc: str, body: RegenerateEstimateIn, db: TenantDB, principal: ApproverNow
) -> RegenerateEstimateOut:
    """A draft run of the document's flow, estimated: the inputs it will use and the cost.
    422 for a kind no flow writes (edit it instead)."""
    out = await _call(regenerate.estimate(db, principal, doc, body.note))
    return RegenerateEstimateOut(**out)


@router.post("/documents/{doc}/regenerate", response_model=RunOut)
async def start_regeneration(
    doc: str, body: RegenerateIn, db: TenantDB, principal: ApproverNow
) -> RunOut:
    """Start the estimated run, through the same cost gates as starting any run. Its
    result is imported as the document's next version."""
    run_id = await _call(regenerate.start(db, principal, doc, body.run_id, body.note))
    return await runs_service.read_run(db, run_id, principal)
