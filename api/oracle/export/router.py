"""Export a version to HTML / PDF / markdown. Lane 3 implements; stub returns 501."""

from typing import Literal

from fastapi import APIRouter, Query, Response

from oracle.auth.deps import TenantDB
from oracle.http import not_implemented

router = APIRouter(prefix="/v1", tags=["export"])


@router.get(
    "/documents/{doc}/versions/{n}/export",
    response_class=Response,
    responses={
        200: {
            "description": "The exported file, with a version banner",
            "content": {
                "text/html": {"schema": {"type": "string"}},
                "application/pdf": {"schema": {"type": "string", "format": "binary"}},
                "text/markdown": {"schema": {"type": "string"}},
            },
        }
    },
)
async def export_version(
    doc: str,
    n: int,
    db: TenantDB,
    fmt: Literal["html", "pdf", "md"] = Query("html", alias="format"),
) -> Response:
    raise not_implemented("3")
