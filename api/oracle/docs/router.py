"""Documents and versions. Lane 1 implements; stubs return 501.

``{doc}`` is a document slug or id; ``{n}`` is a version number.
"""

from fastapi import APIRouter, Query, Request, status
from fastapi.responses import PlainTextResponse

from oracle.auth.deps import CurrentPrincipal, TenantDB
from oracle.docs.schemas import (
    DiffOut,
    DocumentOut,
    DocumentSummary,
    ImportErrorResponse,
    VersionOut,
    VersionSummary,
)
from oracle.http import not_implemented

router = APIRouter(prefix="/v1/documents", tags=["documents"])


@router.get("", response_model=list[DocumentSummary])
async def list_documents(db: TenantDB) -> list[DocumentSummary]:
    raise not_implemented("1")


@router.get("/{doc}", response_model=DocumentOut)
async def get_document(doc: str, db: TenantDB) -> DocumentOut:
    raise not_implemented("1")


@router.post(
    "/{doc}/versions",
    response_model=VersionOut,
    status_code=status.HTTP_201_CREATED,
    responses={
        200: {"model": VersionOut, "description": "Same content as an existing version"},
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
    doc: str, request: Request, principal: CurrentPrincipal, db: TenantDB
) -> VersionOut:
    """Import a draft (markdown + YAML front matter). Creates the document on first import."""
    raise not_implemented("1")


@router.get("/{doc}/versions", response_model=list[VersionSummary])
async def list_versions(doc: str, db: TenantDB) -> list[VersionSummary]:
    raise not_implemented("1")


@router.get("/{doc}/versions/{n}", response_model=VersionOut)
async def get_version(doc: str, n: int, db: TenantDB) -> VersionOut:
    raise not_implemented("1")


@router.get(
    "/{doc}/versions/{n}/markdown",
    response_class=PlainTextResponse,
    responses={200: {"content": {"text/markdown": {"schema": {"type": "string"}}}}},
)
async def get_version_markdown(doc: str, n: int, db: TenantDB) -> PlainTextResponse:
    raise not_implemented("1")


@router.get("/{doc}/diff", response_model=DiffOut)
async def diff_versions(
    doc: str,
    db: TenantDB,
    from_: int = Query(alias="from", ge=1),
    to: int = Query(ge=1),
) -> DiffOut:
    raise not_implemented("1")
