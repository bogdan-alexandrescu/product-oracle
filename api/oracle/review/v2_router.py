"""v2 review routes (CR-06): section review state, assignments and due dates, review
policy, section edits with optimistic concurrency, section patches, feedback campaigns,
in-app notifications, the publish check, the publish transaction and publications.

Logic lives in :mod:`oracle.review.state`, :mod:`~oracle.review.collab`,
:mod:`~oracle.review.patches`, :mod:`~oracle.review.publish` and
:mod:`oracle.docs.edit`. Every route is company scoped (the tenant session) and role
guarded; state changes write audit events. MCP tools derive from these operations.
"""

import uuid
from collections.abc import Awaitable
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from fastapi.responses import JSONResponse
from sqlalchemy import select
from starlette.concurrency import run_in_threadpool

from oracle import audit
from oracle.auth.deps import Principal, TenantDB
from oracle.authz import has_role, recheck_caller, require_role, require_role_now
from oracle.docs import service as docs_service
from oracle.docs.edit import EditForbidden, EditRefused, edit_section
from oracle.docs.parser import DraftError
from oracle.docs.schemas import ImportErrorResponse, VersionOut
from oracle.jobs import service as jobs_service
from oracle.review import collab, patches, publish, state
from oracle.review.models import DocumentPublication, SectionReviewState
from oracle.review.schemas import (
    CampaignCreate,
    CampaignOut,
    CampaignPatch,
    ConflictResponse,
    NotificationOut,
    NotificationsRead,
    PatchStatus,
    PublicationOut,
    PublicationSummary,
    PublishCheckOut,
    PublishRefused,
    ReviewPolicyIn,
    ReviewPolicyOut,
    ReviewQueueItem,
    SectionAssignmentIn,
    SectionAssignmentOut,
    SectionEditIn,
    SectionPatchAccept,
    SectionPatchDetail,
    SectionPatchOut,
    SectionPatchReject,
    SectionStatesOut,
    VersionPublishIn,
)
from oracle.review.service import ReviewError, get_document, get_version
from oracle.v2.concurrency import VersionConflict

router = APIRouter(prefix="/v1", tags=["review"], dependencies=[Depends(require_role("viewer"))])
Viewer = Annotated[Principal, Depends(require_role("viewer"))]
Commenter = Annotated[Principal, Depends(require_role("commenter"))]
Approver = Annotated[Principal, Depends(require_role("approver"))]
Owner = Annotated[Principal, Depends(require_role("owner"))]
ApproverNow = Annotated[Principal, Depends(require_role_now("approver"))]
DOC = "/documents/{doc}"
VERSION = DOC + "/versions/{n}"

CONFLICT = {409: {"model": ConflictResponse, "description": "Changed since you loaded it"}}
_STATUS = {
    "not_found": status.HTTP_404_NOT_FOUND,
    "invalid": 422,
    "forbidden": status.HTTP_403_FORBIDDEN,
    "conflict": status.HTTP_409_CONFLICT,
}


def conflict_response(body: ConflictResponse) -> JSONResponse:
    return JSONResponse(body.model_dump(mode="json"), status.HTTP_409_CONFLICT)


def lock_conflict(e: VersionConflict) -> JSONResponse:
    return conflict_response(
        ConflictResponse(
            detail=str(e.detail), code="stale_lock_version", current_lock_version=e.current
        )
    )


def import_conflict(e: docs_service.BaseVersionConflictError) -> JSONResponse:
    return conflict_response(
        ConflictResponse(
            detail=str(e),
            code=e.code,  # type: ignore[arg-type]
            base_version=e.base,
            latest_version=e.latest,
            sections=e.sections,  # type: ignore[arg-type]
            front_matter_changed=e.front_matter_changed,
        )
    )


async def _call[T](op: Awaitable[T]) -> T:
    try:
        return await op
    except (ReviewError, collab.CollabError, patches.PatchError) as e:
        kind = "conflict" if e.kind == "conflict" else e.kind
        raise HTTPException(_STATUS[kind], e.message) from e
    except state.PolicyError as e:
        raise HTTPException(422, str(e)) from e


# --- section review state ---------------------------------------------------------------


@router.get(VERSION + "/section-states", response_model=SectionStatesOut)
async def get_section_states(doc: str, n: int, db: TenantDB) -> SectionStatesOut:
    """Review status of every section of a version: its revision, status (approved on
    this revision, stale, changes requested...), the approval it holds, owner,
    reviewers, due date, open feedback by severity, and whether a publish needs it."""
    version = await _call(get_version(db, doc, n))
    document = await get_document(db, doc)
    return await state.section_states(db, document, version)


@router.get(DOC + "/section-assignments", response_model=list[SectionAssignmentOut])
async def list_section_assignments(doc: str, db: TenantDB) -> list[SectionAssignmentOut]:
    document = await _call(get_document(db, doc))
    return await collab.list_assignments(db, document)


@router.put(
    DOC + "/sections/{key}/assignment", response_model=SectionAssignmentOut, responses=CONFLICT
)
async def put_section_assignment(
    doc: str, key: str, body: SectionAssignmentIn, principal: ApproverNow, db: TenantDB
) -> SectionAssignmentOut | JSONResponse:
    """Set a section's owner, reviewer assignees and due date. Send the ``lock_version``
    from the section states (null for a section with none); a stale one is a 409."""
    document = await _call(get_document(db, doc))
    try:
        out = await _call(collab.set_assignment(db, principal, document, key, body))
    except VersionConflict as e:
        return lock_conflict(e)
    await db.commit()
    return out


@router.get("/me/review-queue", response_model=list[ReviewQueueItem])
async def get_my_review_queue(principal: Viewer, db: TenantDB) -> list[ReviewQueueItem]:
    """Sections the caller owns or was asked to review, soonest due first."""
    return await collab.review_queue(db, principal)


@router.get(DOC + "/review-policy", response_model=ReviewPolicyOut)
async def get_review_policy(doc: str, db: TenantDB) -> ReviewPolicyOut:
    """The document's review policy, else the company's ``review_policy`` setting."""
    document = await _call(get_document(db, doc))
    return await state.effective_policy(db, document)


@router.put(DOC + "/review-policy", response_model=ReviewPolicyOut, responses=CONFLICT)
async def put_review_policy(
    doc: str, body: ReviewPolicyIn, principal: Owner, db: TenantDB
) -> ReviewPolicyOut | JSONResponse:
    """Designated decider, mandatory reviewers, extra required sections, which sections
    need approval before a publish, and whether a change requests re-review."""
    document = await _call(get_document(db, doc))
    try:
        out = await _call(state.set_policy(db, principal, document, body))
    except VersionConflict as e:
        return lock_conflict(e)
    await db.commit()
    return out


# --- section edits ----------------------------------------------------------------------


@router.put(
    DOC + "/sections/{key}",
    response_model=VersionOut,
    status_code=status.HTTP_201_CREATED,
    responses={
        200: {"model": VersionOut, "description": "Nothing changed"},
        422: {"model": ImportErrorResponse, "description": "The edited draft is invalid"},
        **CONFLICT,
    },
)
async def edit_document_section(
    doc: str, key: str, body: SectionEditIn, principal: Commenter, db: TenantDB
) -> VersionOut | JSONResponse:
    """Save one section as the next version. Send the version and section revision you
    loaded: another section changed since is fine (the edit applies on the latest
    version); the same section changed since is a 409 with its current text. Approvers
    edit any section; a section's owner edits their own, and their ``resolutions`` close
    only that section's feedback (403 otherwise). An edit that reaches outside its
    section (adds, rewrites or swallows another section) is a 422."""
    document = await _call(get_document(db, doc))
    approver = has_role(principal.role, "approver")
    if approver:
        # Any section, and any feedback closed: the role is read now, under the gate.
        await recheck_caller(db, principal, "approver")
    else:
        owner = await db.scalar(
            select(SectionReviewState.owner_id).where(
                SectionReviewState.document_id == document.id,
                SectionReviewState.section_key == key,
            )
        )
        if owner is None or owner != principal.user_id:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN, "Only an approver or the section's owner edits it"
            )
    try:
        result = await edit_section(
            db,
            principal,
            str(document.id),
            key,
            base_version=body.base_version,
            base_revision=body.base_revision,
            heading=body.heading,
            body_md=body.body_md,
            resolutions=[r.model_dump(mode="json") for r in body.resolutions],
            resolve_any=approver,
        )
    except docs_service.BaseVersionConflictError as e:
        return import_conflict(e)
    except docs_service.ImportConflictError as e:
        raise HTTPException(status.HTTP_409_CONFLICT, str(e)) from e
    except EditRefused as e:
        raise HTTPException(422, str(e)) from e
    except EditForbidden as e:
        raise HTTPException(status.HTTP_403_FORBIDDEN, str(e)) from e
    except DraftError as e:
        body_out = ImportErrorResponse(
            detail=f"edit rejected: {len(e.problems)} problem(s)", errors=e.problems
        )
        return JSONResponse(body_out.model_dump(mode="json"), 422)
    if result.created:
        await jobs_service.on_version_imported(
            db, result.version.document_id, result.version.number, principal
        )
        await db.commit()
    return JSONResponse(
        result.version.model_dump(mode="json"),
        status.HTTP_201_CREATED if result.created else status.HTTP_200_OK,
    )


# --- section patches --------------------------------------------------------------------


@router.get(DOC + "/section-patches", response_model=list[SectionPatchOut])
async def list_section_patches(
    doc: str, db: TenantDB, status: PatchStatus | None = None
) -> list[SectionPatchOut]:
    """Proposed replacements of section text (an agent rewrite of an approved
    section), newest first."""
    document = await _call(get_document(db, doc))
    return await patches.list_patches(db, document, status)


@router.get("/section-patches/{patch_id}", response_model=SectionPatchDetail)
async def get_section_patch(patch_id: uuid.UUID, db: TenantDB) -> SectionPatchDetail:
    """A patch with its word diff against the section's current text."""
    row = await _call(patches.get_patch(db, patch_id))
    return await patches.patch_detail(db, row)


@router.post(
    "/section-patches/{patch_id}/accept",
    response_model=VersionOut,
    status_code=status.HTTP_201_CREATED,
    responses=CONFLICT,
)
async def accept_section_patch(
    patch_id: uuid.UUID, body: SectionPatchAccept, principal: ApproverNow, db: TenantDB
) -> VersionOut | JSONResponse:
    """Accept a patch (optionally edited): the section's next revision, as a new
    version. ``base_revision`` is the current revision you compared against."""
    try:
        result = await _call(
            patches.accept_patch(
                db,
                principal,
                patch_id,
                base_revision=body.base_revision,
                lock_version=body.lock_version,
                heading=body.heading,
                body_md=body.body_md,
                note=body.note,
            )
        )
    except VersionConflict as e:
        return lock_conflict(e)
    except docs_service.BaseVersionConflictError as e:
        return import_conflict(e)
    except (EditRefused, DraftError) as e:
        raise HTTPException(422, str(e)) from e
    if result.created:
        await jobs_service.on_version_imported(
            db, result.version.document_id, result.version.number, principal
        )
        await db.commit()
    return JSONResponse(
        result.version.model_dump(mode="json"),
        status.HTTP_201_CREATED if result.created else status.HTTP_200_OK,
    )


@router.post(
    "/section-patches/{patch_id}/reject", response_model=SectionPatchOut, responses=CONFLICT
)
async def reject_section_patch(
    patch_id: uuid.UUID, body: SectionPatchReject, principal: ApproverNow, db: TenantDB
) -> SectionPatchOut | JSONResponse:
    try:
        row = await _call(
            patches.reject_patch(db, principal, patch_id, body.lock_version, body.note)
        )
    except VersionConflict as e:
        return lock_conflict(e)
    await db.commit()
    await db.refresh(row)
    return SectionPatchOut.model_validate(row)


# --- campaigns --------------------------------------------------------------------------


@router.post(DOC + "/campaigns", response_model=CampaignOut, status_code=status.HTTP_201_CREATED)
async def create_review_campaign(
    doc: str, body: CampaignCreate, principal: ApproverNow, db: TenantDB
) -> CampaignOut:
    """Ask the organization for feedback on a version: everyone with an audience role
    is notified. Comments are gathered; approval stays with the decider."""
    document = await _call(get_document(db, doc))
    out = await _call(collab.create_campaign(db, principal, document, body))
    await db.commit()
    return out


@router.get(DOC + "/campaigns", response_model=list[CampaignOut])
async def list_review_campaigns(doc: str, db: TenantDB) -> list[CampaignOut]:
    document = await _call(get_document(db, doc))
    return await collab.list_campaigns(db, document)


@router.get("/campaigns/{campaign_id}", response_model=CampaignOut)
async def get_review_campaign(campaign_id: uuid.UUID, db: TenantDB) -> CampaignOut:
    row = await _call(collab.get_campaign(db, campaign_id))
    return await collab.campaign_out(db, row)


@router.patch("/campaigns/{campaign_id}", response_model=CampaignOut, responses=CONFLICT)
async def update_review_campaign(
    campaign_id: uuid.UUID, body: CampaignPatch, principal: ApproverNow, db: TenantDB
) -> CampaignOut | JSONResponse:
    """Close (or reopen) a campaign."""
    try:
        out = await _call(
            collab.update_campaign(db, principal, campaign_id, body.status, body.lock_version)
        )
    except VersionConflict as e:
        return lock_conflict(e)
    await db.commit()
    return out


# --- notifications ----------------------------------------------------------------------


@router.get("/me/notifications", response_model=list[NotificationOut])
async def list_my_notifications(
    principal: Viewer,
    db: TenantDB,
    unread: bool = False,
    limit: int = Query(50, ge=1, le=200),
) -> list[NotificationOut]:
    """The caller's in-app notifications, newest first (empty for API tokens)."""
    rows = await collab.list_notifications(db, principal, unread, limit)
    return [NotificationOut.model_validate(r) for r in rows]


@router.post("/notifications/{notification_id}/read", response_model=NotificationOut)
async def read_notification(
    notification_id: uuid.UUID, principal: Viewer, db: TenantDB
) -> NotificationOut:
    row = await _call(collab.mark_read(db, principal, notification_id))
    await audit.record(db, principal, "notification.read", "notification", row.id, {})
    await db.commit()
    await db.refresh(row)
    return NotificationOut.model_validate(row)


@router.post("/me/notifications/read-all", response_model=NotificationsRead)
async def read_all_notifications(principal: Viewer, db: TenantDB) -> NotificationsRead:
    marked = await collab.mark_all_read(db, principal)
    if marked:
        await audit.record(
            db, principal, "notification.read_all", "notification", None, {"marked": marked}
        )
    await db.commit()
    return NotificationsRead(marked=marked)


# --- publish ----------------------------------------------------------------------------


@router.get(VERSION + "/publish-check", response_model=PublishCheckOut)
async def get_publish_check(doc: str, n: int, db: TenantDB) -> PublishCheckOut:
    """Everything that blocks publishing this version, and the advisory warnings."""
    version = await _call(get_version(db, doc, n))
    document = await get_document(db, doc)
    return await publish.publish_check(db, document, version)


def _summary(row: DocumentPublication) -> dict[str, Any]:
    return {
        **PublicationSummary.model_validate(row).model_dump(exclude={"has_brief"}),
        "has_brief": row.html_brief is not None,
    }


@router.post(
    VERSION + "/publish",
    response_model=PublicationOut,
    status_code=status.HTTP_201_CREATED,
    responses={409: {"model": PublishRefused, "description": "The publish was refused"}},
)
async def publish_version(
    doc: str, n: int, body: VersionPublishIn, principal: ApproverNow, db: TenantDB
) -> PublicationOut | JSONResponse:
    """Publish an approved version, immutably. Refused (409, nothing written) while
    the publish check lists a blocker."""
    version = await _call(get_version(db, doc, n))
    document = await get_document(db, doc)
    try:
        row = await publish.publish(
            db, principal, document, version, content_hash=body.content_hash, note=body.note
        )
    except publish.PublishRefusedError as e:
        await db.rollback()
        refused = PublishRefused(detail=str(e), check=e.check)
        return JSONResponse(refused.model_dump(mode="json"), status.HTTP_409_CONFLICT)
    await db.commit()
    await db.refresh(row)
    return PublicationOut(**_summary(row), manifest=row.manifest, markdown=row.markdown)


async def _publication(db: TenantDB, doc: str, p: int) -> DocumentPublication:
    document = await _call(get_document(db, doc))
    row = await db.scalar(
        select(DocumentPublication).where(
            DocumentPublication.document_id == document.id, DocumentPublication.number == p
        )
    )
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Publication {p} of {doc!r} not found")
    return row


@router.get(DOC + "/publications", response_model=list[PublicationSummary])
async def list_publications(doc: str, db: TenantDB) -> list[PublicationSummary]:
    document = await _call(get_document(db, doc))
    rows = await db.scalars(
        select(DocumentPublication)
        .where(DocumentPublication.document_id == document.id)
        .order_by(DocumentPublication.number)
    )
    return [PublicationSummary(**_summary(r)) for r in rows]


@router.get(DOC + "/publications/{p}", response_model=PublicationOut)
async def get_publication(doc: str, p: int, db: TenantDB) -> PublicationOut:
    """A publication with everything it pinned."""
    row = await _publication(db, doc, p)
    return PublicationOut(**_summary(row), manifest=row.manifest, markdown=row.markdown)


MEDIA = {"html": "text/html; charset=utf-8", "pdf": "application/pdf", "md": "text/markdown"}


@router.get(
    DOC + "/publications/{p}/export",
    response_class=Response,
    responses={
        200: {
            "description": "The published file, exactly as published",
            "content": {
                "text/html": {"schema": {"type": "string"}},
                "application/pdf": {"schema": {"type": "string", "format": "binary"}},
                "text/markdown": {"schema": {"type": "string"}},
            },
        },
        422: {"description": "Format not offered for the layer, or no brief"},
    },
)
async def export_publication(
    doc: str,
    p: int,
    db: TenantDB,
    fmt: Literal["html", "pdf", "md"] = Query("html", alias="format"),
    layer: Literal["full", "brief", "deck"] = Query("full"),
) -> Response:
    """The published HTML (full, brief or deck), its PDF, or the full markdown. Served
    from what was stored at publish time, so later edits, theme changes and source
    updates never change it."""
    from oracle.export.pdf import PdfUnavailable, html_to_pdf

    row = await _publication(db, doc, p)
    if fmt == "md" and layer != "full":
        raise HTTPException(422, "markdown is offered for the full layer only")
    html = {"full": row.html_full, "brief": row.html_brief, "deck": row.html_deck}[layer]
    if html is None:
        raise HTTPException(422, f"publication {p} has no {layer} layer")
    content: str | bytes
    if fmt == "md":
        content = publish.published_markdown(row)
    elif fmt == "pdf":
        try:
            content = await run_in_threadpool(html_to_pdf, html)
        except PdfUnavailable as e:
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(e)) from None
    else:
        content = html
    suffix = "" if layer == "full" else f"-{layer}"
    name = f"{row.manifest['document']['slug']}-v{row.version_number}-published-{p}{suffix}"
    return Response(
        content=content,
        media_type=MEDIA[fmt],
        headers={"Content-Disposition": f'attachment; filename="{name}.{fmt}"'},
    )
