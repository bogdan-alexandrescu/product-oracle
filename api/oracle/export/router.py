"""Export a version to HTML / PDF / markdown, each with a version banner."""

from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Response, status
from starlette.concurrency import run_in_threadpool

from oracle.auth.deps import TenantDB
from oracle.export.pdf import PdfUnavailable, html_to_pdf
from oracle.export.render import NotFound, load_export_version, render_html, render_markdown

router = APIRouter(prefix="/v1", tags=["export"])

MEDIA_TYPES = {
    "html": "text/html; charset=utf-8",
    "pdf": "application/pdf",
    "md": "text/markdown; charset=utf-8",
}


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
    try:
        ev = await load_export_version(db, doc, n)
    except NotFound as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(e)) from None
    if fmt == "md":
        content: str | bytes = render_markdown(ev)
    else:
        content = render_html(ev)
        if fmt == "pdf":
            # CPU-bound and synchronous: keep it off the event loop.
            try:
                content = await run_in_threadpool(html_to_pdf, content)
            except PdfUnavailable as e:
                raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(e)) from None
    return Response(
        content=content,
        media_type=MEDIA_TYPES[fmt],
        headers={"Content-Disposition": f'attachment; filename="{ev.filename_stem}.{fmt}"'},
    )
