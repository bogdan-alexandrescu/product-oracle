"""Documents and versions: import, read, diff.

``{doc}`` is a document slug or id; ``{n}`` is a version number.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import JSONResponse, PlainTextResponse

from oracle.auth.deps import Principal, TenantDB
from oracle.authz import require_role
from oracle.docs import service
from oracle.docs.parser import DraftError
from oracle.docs.schemas import (
    DiffOut,
    DocumentKind,
    DocumentOut,
    DocumentSummary,
    ImportErrorResponse,
    ImportProblem,
    VersionOut,
    VersionSummary,
)
from oracle.http import read_capped_body
from oracle.jobs import service as jobs_service

# Every route needs at least a viewer; importing a version needs an approver.
router = APIRouter(
    prefix="/v1/documents", tags=["documents"], dependencies=[Depends(require_role("viewer"))]
)
Approver = Annotated[Principal, Depends(require_role("approver"))]


def _not_found(exc: service.NotFoundError) -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, str(exc))


def _draft_rejected(exc: DraftError) -> JSONResponse:
    body = ImportErrorResponse(
        detail=f"draft rejected: {len(exc.problems)} problem(s)", errors=exc.problems
    )
    return JSONResponse(body.model_dump(mode="json"), 422)


@router.get("", response_model=list[DocumentSummary])
async def list_documents(db: TenantDB, kind: DocumentKind | None = None) -> list[DocumentSummary]:
    """Documents, newest first; ``kind`` lists only PRDs or only roadmaps. Each carries
    its latest and latest approved version and the latest version's provenance."""
    return await service.list_documents(db, kind)


@router.get("/{doc}", response_model=DocumentOut)
async def get_document(doc: str, db: TenantDB) -> DocumentOut:
    try:
        return await service.read_document(db, doc)
    except service.NotFoundError as exc:
        raise _not_found(exc) from exc


@router.post(
    "/{doc}/versions",
    response_model=VersionOut,
    status_code=status.HTTP_201_CREATED,
    responses={
        200: {"model": VersionOut, "description": "Same content as an existing version"},
        413: {"description": "Draft larger than 1 MiB (ORACLE_MAX_BODY_BYTES)"},
        422: {"model": ImportErrorResponse, "description": "Draft rejected"},
    },
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {"text/markdown": {"schema": {"type": "string"}}},
        }
    },
)
async def import_version(
    doc: str, request: Request, principal: Approver, db: TenantDB
) -> VersionOut | JSONResponse:
    """Import a draft (markdown + YAML front matter). Creates the document on first import."""
    raw = await read_capped_body(request)
    try:
        markdown = raw.decode("utf-8")
    except UnicodeDecodeError:
        return _draft_rejected(
            DraftError([ImportProblem(code="invalid_encoding", message="body must be UTF-8")])
        )
    try:
        result = await service.import_draft(db, doc, markdown, principal)
    except DraftError as exc:
        return _draft_rejected(exc)
    except service.NotFoundError as exc:
        raise _not_found(exc) from exc
    except service.ImportConflictError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    if result.created:
        # Oracle's reporting job writes this version's reports (when it is on).
        await jobs_service.on_version_imported(
            db, result.version.document_id, result.version.number, principal
        )
        await db.commit()
    return JSONResponse(
        result.version.model_dump(mode="json"),
        status.HTTP_201_CREATED if result.created else status.HTTP_200_OK,
    )


@router.get("/{doc}/versions", response_model=list[VersionSummary])
async def list_versions(doc: str, db: TenantDB) -> list[VersionSummary]:
    try:
        document = await service.get_document_or_404(db, doc)
    except service.NotFoundError as exc:
        raise _not_found(exc) from exc
    return await service.list_versions(db, document)


@router.get("/{doc}/versions/{n}", response_model=VersionOut)
async def get_version(doc: str, n: int, db: TenantDB) -> VersionOut:
    try:
        document = await service.get_document_or_404(db, doc)
        version = await service.get_version_row(db, document, n)
    except service.NotFoundError as exc:
        raise _not_found(exc) from exc
    return await service.read_version(db, version)


@router.get(
    "/{doc}/versions/{n}/markdown",
    response_class=PlainTextResponse,
    responses={200: {"content": {"text/markdown": {"schema": {"type": "string"}}}}},
)
async def get_version_markdown(doc: str, n: int, db: TenantDB) -> PlainTextResponse:
    try:
        document = await service.get_document_or_404(db, doc)
        version = await service.get_version_row(db, document, n)
    except service.NotFoundError as exc:
        raise _not_found(exc) from exc
    return PlainTextResponse(version.markdown, media_type="text/markdown; charset=utf-8")


@router.get("/{doc}/diff", response_model=DiffOut)
async def diff_versions(
    doc: str,
    db: TenantDB,
    from_: int = Query(alias="from", ge=1),
    to: int = Query(ge=1),
) -> DiffOut:
    try:
        return await service.diff(db, doc, from_, to)
    except service.NotFoundError as exc:
        raise _not_found(exc) from exc
