"""Documents and versions: import, read, diff.

``{doc}`` is a document slug or id; ``{n}`` is a version number.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import JSONResponse, PlainTextResponse

from oracle.auth.deps import CurrentPrincipal, Principal, TenantDB
from oracle.authz import recheck_caller, require_role, require_role_now
from oracle.docs import service
from oracle.docs.parser import DraftError
from oracle.docs.schemas import (
    DiffOut,
    DocumentKind,
    DocumentOut,
    DocumentSummary,
    DraftNewItems,
    ImportErrorResponse,
    ImportProblem,
    VersionOut,
    VersionSummary,
    VisibilityIn,
)
from oracle.http import read_capped_body
from oracle.jobs import service as jobs_service
from oracle.review.schemas import ConflictResponse
from oracle.runs import feature_set
from oracle.runs.schemas import PrdScopeOut

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


@router.patch(
    "/{doc}/visibility",
    response_model=DocumentOut,
    responses={403: {"description": "Not an owner"}, 404: {"description": "No such document"}},
)
async def set_document_visibility(
    doc: str,
    data: VisibilityIn,
    principal: Annotated[Principal, Depends(require_role_now("owner"))],
    db: TenantDB,
) -> DocumentOut:
    """Who sees an update (H8): ``company`` (every member) or ``approvers`` (owners and
    approvers only, an update's default); any other kind is a 422. Owners only, with a
    reason; audited as ``document.visibility`` with the values before and after."""
    try:
        return await service.set_visibility(db, doc, data.visibility, data.reason, principal)
    except service.NotFoundError as exc:
        raise _not_found(exc) from exc
    except service.VisibilityKindError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from exc


@router.post(
    "/{doc}/versions",
    response_model=VersionOut,
    status_code=status.HTTP_201_CREATED,
    responses={
        200: {"model": VersionOut, "description": "Same content as an existing version"},
        409: {
            "model": ConflictResponse,
            "description": "The draft's base version is older than the latest, and the "
            "draft would overwrite sections changed since",
        },
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
    doc: str,
    request: Request,
    principal: Approver,
    db: TenantDB,
    base_version: Annotated[int | None, Query(ge=0)] = None,
) -> VersionOut | JSONResponse:
    """Import a draft (markdown + YAML front matter). Creates the document on first import.

    ``base_version``: the version the draft was written on (0: the draft creates the
    document). When a newer version changed sections (or the front matter) the draft
    does not have as the latest has them, the import is a 409 naming both versions and
    those sections (never a silent overwrite). Without it the import works as before,
    and the version carries a ``base_version_missing`` note."""
    raw = await read_capped_body(request)
    # The body is in before the gate is taken (and the caller re-read under it).
    await recheck_caller(db, principal, "approver")
    try:
        markdown = raw.decode("utf-8")
    except UnicodeDecodeError:
        return _draft_rejected(
            DraftError([ImportProblem(code="invalid_encoding", message="body must be UTF-8")])
        )
    try:
        result = await service.import_draft(db, doc, markdown, principal, base_version=base_version)
    except DraftError as exc:
        return _draft_rejected(exc)
    except service.NotFoundError as exc:
        raise _not_found(exc) from exc
    except service.BaseVersionConflictError as exc:
        body = ConflictResponse(
            detail=str(exc),
            code=exc.code,  # type: ignore[arg-type]
            base_version=exc.base,
            latest_version=exc.latest,
            sections=exc.sections,  # type: ignore[arg-type]
            front_matter_changed=exc.front_matter_changed,
        )
        return JSONResponse(body.model_dump(mode="json"), status.HTTP_409_CONFLICT)
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


@router.get("/{doc}/scope", response_model=PrdScopeOut)
async def get_document_scope(doc: str, db: TenantDB) -> PrdScopeOut:
    """The document's approved PRD scope (C6): the features and requirements its last
    approved feature set includes, excludes or defers. 404 when none is approved yet."""
    try:
        document = await service.get_document_or_404(db, doc)
    except service.NotFoundError as exc:
        raise _not_found(exc) from exc
    scope = await feature_set.approved_scope(db, document_id=document.id)
    if scope is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, f"document '{doc}' has no approved PRD scope"
        )
    return feature_set.scope_out(scope, await feature_set.scope_items(db, scope.id))


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
    "/{doc}/versions/{n}/new-items",
    response_model=DraftNewItems,
    operation_id="get_draft_new_items",
)
async def get_draft_new_items(
    doc: str, n: int, principal: CurrentPrincipal, db: TenantDB
) -> DraftNewItems:
    """S4: how many items of the draft's author's own sources are new, changed or deleted
    since the sources the draft was written from ("N new items since draft k, refresh?").
    Only the author sees the number (``oracle.docs.fresh``)."""
    from oracle.docs import fresh

    try:
        document = await service.get_document_or_404(db, doc)
        version = await service.get_version_row(db, document, n)
    except service.NotFoundError as exc:
        raise _not_found(exc) from exc
    return await fresh.new_items(db, principal, document, version)


@router.get(
    "/{doc}/versions/{n}/markdown",
    response_class=PlainTextResponse,
    responses={200: {"content": {"text/markdown": {"schema": {"type": "string"}}}}},
)
async def get_version_markdown(doc: str, n: int, db: TenantDB) -> PlainTextResponse:
    """The version's markdown as stored; a roadmap's date that rests on no verified basis
    now has ``<!-- oracle: date unverified -->`` (or ``date withdrawn``) after it, which
    an import drops."""
    try:
        document = await service.get_document_or_404(db, doc)
        version = await service.get_version_row(db, document, n)
    except service.NotFoundError as exc:
        raise _not_found(exc) from exc
    if await service.is_spec_version(db, version):
        # E1: a spec version's markdown carries its state labels and Added sources.
        markdown = await service.spec_markdown(db, version)
    else:
        # A roadmap's flagged dates carry an HTML comment after each (O4 'document dates').
        markdown, _ = await service.version_markdown(db, version)
    return PlainTextResponse(markdown, media_type="text/markdown; charset=utf-8")


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
