"""Export a version to HTML / PDF / markdown / PPTX, each with a version banner.

O1f: ``layer=full`` (default) exports every section as before; ``layer=brief`` the
brief sections and the Sources and data points appendix (HTML, PDF); ``layer=deck``
the brief as slides (PDF, PPTX; HTML is the page the PDF is printed from).
``/deck`` returns the slides as JSON for Present mode.
"""

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from starlette.concurrency import run_in_threadpool

from oracle.auth.deps import TenantDB
from oracle.authz import require_role
from oracle.docs.service import version_guidance
from oracle.export.deck import build_deck, render_deck_html, theme_class
from oracle.export.pdf import PdfUnavailable, html_to_pdf
from oracle.export.render import (
    NoBrief,
    NotFound,
    apply_layer,
    load_export_version,
    render_html,
    render_markdown,
)
from oracle.export.schemas import (
    LAYER_FORMATS,
    DeckOut,
    ExpandOut,
    ExportFormat,
    ExportLayer,
    SlideOut,
)

router = APIRouter(prefix="/v1", tags=["export"], dependencies=[Depends(require_role("viewer"))])

PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
MEDIA_TYPES = {
    "html": "text/html; charset=utf-8",
    "pdf": "application/pdf",
    "md": "text/markdown; charset=utf-8",
    "pptx": PPTX,
}


async def _load(db, doc: str, n: int, layer: str):
    try:
        ev = await load_export_version(db, doc, n)
    except NotFound as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(e)) from None
    try:
        return apply_layer(ev, layer)
    except NoBrief as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(e)) from None


async def _pdf(html: str) -> bytes:
    # CPU-bound and synchronous: keep it off the event loop.
    try:
        return await run_in_threadpool(html_to_pdf, html)
    except PdfUnavailable as e:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(e)) from None


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
                PPTX: {"schema": {"type": "string", "format": "binary"}},
            },
        },
        422: {"description": "Format not offered for the layer, or the version has no brief"},
    },
)
async def export_version(
    doc: str,
    n: int,
    db: TenantDB,
    fmt: ExportFormat = Query("html", alias="format"),
    layer: ExportLayer = Query("full"),
) -> Response:
    """Full: html, pdf, md. Brief: html, pdf. Deck: pdf, pptx (html: the printable
    slides)."""
    if fmt not in LAYER_FORMATS[layer]:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f"the {layer} layer exports as {', '.join(LAYER_FORMATS[layer])}, not {fmt}",
        )
    ev = await _load(db, doc, n, layer)
    content: str | bytes
    if layer == "deck":
        deck = build_deck(ev, await version_guidance(db, ev.version))
        if fmt == "pptx":
            from oracle.export.pptx import deck_to_pptx

            content = await run_in_threadpool(deck_to_pptx, deck)
        else:
            content = render_deck_html(deck)
            if fmt == "pdf":
                content = await _pdf(content)
    elif fmt == "md":
        content = render_markdown(ev)
    else:
        content = render_html(ev)
        if fmt == "pdf":
            content = await _pdf(content)
    return Response(
        content=content,
        media_type=MEDIA_TYPES[fmt],
        headers={"Content-Disposition": f'attachment; filename="{ev.filename_stem}.{fmt}"'},
    )


@router.get("/documents/{doc}/versions/{n}/deck", response_model=DeckOut)
async def get_deck(doc: str, n: int, db: TenantDB) -> DeckOut:
    """The brief layer as slides in the document's theme (its slide variant), with
    presenter notes and the detail each slide can expand. 422 when the version has no
    brief sections."""
    ev = await _load(db, doc, n, "deck")
    deck = build_deck(ev, await version_guidance(db, ev.version))
    return DeckOut(
        document_id=ev.document.id,
        slug=deck.slug,
        title=deck.title,
        number=deck.number,
        latest_number=deck.latest_number,
        status=deck.status,
        as_of=deck.as_of,
        banner=deck.banner,
        theme=deck.theme_key,
        theme_name=deck.theme_name,
        theme_class=theme_class(deck),
        css=str(deck.css),
        slides=[
            SlideOut(
                index=s.index,
                kind=s.kind,
                heading=s.heading,
                section_key=s.section_key,
                html=str(s.html),
                notes=s.notes,
                expand=[
                    ExpandOut(section_key=e.section_key, heading=e.heading, html=str(e.html))
                    for e in s.expand
                ],
            )
            for s in deck.slides
        ],
    )
