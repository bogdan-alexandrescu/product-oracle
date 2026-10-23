"""Engineering specs, user flows and wireframes from an approved PRD (CR-09, §11.1-§11.2).

Viewers read; approvers request a spec and propose its regeneration; commenters comment on
flows, wireframes and their annotations; the spec's engineering approvers (or an owner)
approve. A spec document's sections, comments and approval use the PRD review routes
(``/v1/documents/{doc}/versions/{n}/...``). Logic: :mod:`oracle.specs.service`.

Importing this module registers the ``specs.lineage`` change handler and the
``prd_to_spec`` flow's prompt extension and importer.
"""

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response, status

from oracle import changes, wording
from oracle.auth.deps import Principal, TenantDB
from oracle.authz import require_role
from oracle.runs import extensions
from oracle.specs import lineage, service
from oracle.specs.schemas import (
    DesignArtifactOut,
    DesignReviewIn,
    DesignReviewOut,
    RegenerateIn,
    RegenerationOut,
    SpecOut,
    SpecRequestCreate,
    SpecRequestCreated,
    SpecSummary,
)

router = APIRouter(prefix="/v1", tags=["specs"], dependencies=[Depends(require_role("viewer"))])
Commenter = Annotated[Principal, Depends(require_role("commenter"))]
Approver = Annotated[Principal, Depends(require_role("approver"))]

changes.register_handler(
    lineage.HANDLER, lineage.on_document_version, subjects={"document_version"}
)
extensions.register_prompt_lines(service.FLOW, service.prompt_lines)
extensions.register_importer("spec", service.import_spec)


def _http(exc: service.SpecError) -> HTTPException:
    if exc.refs:
        return wording.Refused(exc.status, str(exc), exc.refs)
    return HTTPException(exc.status, str(exc))


@router.post(
    "/spec-requests", response_model=SpecRequestCreated, status_code=status.HTTP_201_CREATED
)
async def create_spec_request(
    body: SpecRequestCreate, principal: Approver, db: TenantDB
) -> SpecRequestCreated:
    """Request a technical brief (or full engineering spec) with its flows and wireframes
    from an approved PRD version. Creates the spec request and a draft prd_to_spec run:
    estimate and start it like any run (over $50 waits for an owner's approval)."""
    try:
        request_id, run_id = await service.create_request(db, principal, body)
    except service.SpecError as exc:
        raise _http(exc) from exc
    return SpecRequestCreated(spec=await service.read_spec(db, request_id), run_id=run_id)


@router.get("/spec-requests", response_model=list[SpecSummary])
async def list_spec_requests(db: TenantDB, prd: str | None = None) -> list[SpecSummary]:
    """Spec requests, newest first; ``prd`` (slug or id) narrows to one PRD's."""
    return await service.list_requests(db, prd)


@router.get("/spec-requests/{request_id}", response_model=SpecOut)
async def get_spec_request(request_id: uuid.UUID, db: TenantDB) -> SpecOut:
    """A spec: its requirements (from the PRD), versions with their approach status,
    sections by part, flows and wireframes, and whatever is stale and why."""
    try:
        return await service.read_spec(db, request_id)
    except service.SpecError as exc:
        raise _http(exc) from exc


@router.post(
    "/spec-requests/{request_id}/regenerate",
    response_model=RegenerationOut,
    status_code=status.HTTP_201_CREATED,
)
async def regenerate_spec(
    request_id: uuid.UUID, body: RegenerateIn, principal: Approver, db: TenantDB
) -> RegenerationOut:
    """Propose regenerating a spec and its design from the latest approved PRD version: a
    draft run, never an automatic rewrite. Current versions stay until new ones are
    approved."""
    try:
        return await service.regenerate(db, principal, request_id, body)
    except service.SpecError as exc:
        raise _http(exc) from exc


@router.get("/design-artifacts/{version_id}", response_model=DesignArtifactOut)
async def get_design_artifact(version_id: uuid.UUID, db: TenantDB) -> DesignArtifactOut:
    """A flow or wireframe version: its outputs, their PRD sections and requirement ids,
    annotations with their reviews, and lineage."""
    try:
        return await service.read_design(db, version_id)
    except service.SpecError as exc:
        raise _http(exc) from exc


@router.get(
    "/design-artifacts/{version_id}/outputs/{name}",
    response_class=Response,
    responses={200: {"content": {"image/svg+xml": {}, "text/html": {}}}},
)
async def get_design_output(version_id: uuid.UUID, name: str, db: TenantDB) -> Response:
    """A flow (SVG) or wireframe (HTML), sanitised when it was stored, served with a
    sandboxing Content-Security-Policy: no scripts, no network, no access to Oracle's
    cookies."""
    try:
        content, media_type = await service.design_output(db, version_id, name)
    except service.SpecError as exc:
        raise _http(exc) from exc
    return Response(
        content=content,
        media_type=f"{media_type}; charset=utf-8",
        headers=service.DOWNLOAD_HEADERS,
    )


@router.post(
    "/design-artifacts/{version_id}/reviews",
    response_model=DesignReviewOut,
    status_code=status.HTTP_201_CREATED,
)
async def review_design_artifact(
    version_id: uuid.UUID, body: DesignReviewIn, principal: Commenter, db: TenantDB
) -> DesignReviewOut:
    """Comment on a flow or wireframe version or one of its annotations (commenter), or
    approve, reject or request changes on the version (the spec's engineering approvers or
    an owner)."""
    try:
        return await service.review_design(db, principal, version_id, body)
    except service.SpecError as exc:
        raise _http(exc) from exc
