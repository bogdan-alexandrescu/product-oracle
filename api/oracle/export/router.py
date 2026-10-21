"""Export a version to HTML / PDF / markdown / PPTX, each with a version banner.

O1f: ``layer=full`` (default) exports every section as before; ``layer=brief`` the
brief sections and the Sources and data points appendix (HTML, PDF); ``layer=deck``
the brief as slides (PDF, PPTX; HTML is the page the PDF is printed from).
``/deck`` returns the slides as JSON for Present mode.

Every format renders on the export pool, never on the event loop (oracle.export.offload):
one export per person and two per company at a time (more: 429 ``export_busy_you``). A
``/deck`` build (Present mode) takes a place too: two per person at once, apart from the
person's exports (more: 429 ``present_busy_you``), within the company's two; a deck built
once is kept and served without a place (oracle.export.present; owner decision
2026-10-20). A
wait of more than ``offload.QUEUE_SECONDS`` for a worker is 503 ``export_busy``, and a
render that takes longer than ``offload.SECONDS`` from its start is refused: 422 "This
document is too large to export quickly". The request ends its transaction before it waits
and the render reads copies of the rows (:func:`oracle.export.render.detached`). A
roadmap's dates are read once per version, off the loop too (oracle.roadmap.doc_dates: 503
while they are still being found).
"""

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status

from oracle.auth.deps import CurrentPrincipal, TenantDB
from oracle.authz import require_role
from oracle.export import offload, present
from oracle.export.deck import build_deck, render_deck_html, theme_class
from oracle.export.pdf import PdfUnavailable, html_to_pdf
from oracle.export.render import (
    ExportVersion,
    NoBrief,
    NotFound,
    apply_layer,
    detached,
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


def render_export(ev: ExportVersion, layer: str, fmt: str) -> str | bytes:
    """The exported file. CPU-bound: run on the export pool (:func:`offload.run`)."""
    if layer == "deck":
        deck = build_deck(ev)
        if fmt == "pptx":
            from oracle.export.pptx import deck_to_pptx

            return deck_to_pptx(deck)
        html = render_deck_html(deck)
        return html_to_pdf(html) if fmt == "pdf" else html
    if fmt == "md":
        return render_markdown(ev)
    html = render_html(ev)
    return html_to_pdf(html) if fmt == "pdf" else html


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
    principal: CurrentPrincipal,
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
    try:
        with offload.place(principal) as held:
            ev = detached(await _load(db, doc, n, layer))
            await db.commit()  # no connection held while it waits for the pool
            content = await offload.run(held, render_export, ev, layer, fmt)
    except offload.Refused as e:
        return e.response()
    except PdfUnavailable as e:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(e)) from None
    return Response(
        content=content,
        media_type=MEDIA_TYPES[fmt],
        headers={"Content-Disposition": f'attachment; filename="{ev.filename_stem}.{fmt}"'},
    )


@router.get("/documents/{doc}/versions/{n}/deck", response_model=DeckOut)
async def get_deck(doc: str, n: int, db: TenantDB, principal: CurrentPrincipal) -> Any:
    """The brief layer as slides in the document's theme (its slide variant), with
    presenter notes and the detail each slide can expand. 422 when the version has no
    brief sections."""
    # Present mode: kept, else built on the export pool in a Present place (owner decision
    # 2026-10-20).
    ev = detached(await _load(db, doc, n, "deck"))
    await db.commit()  # no connection held while it waits for the pool
    try:
        deck = await present.deck_for(principal, ev, build_deck)
    except offload.Refused as e:
        return e.response()
    return DeckOut(
        document_id=ev.document.id,
        slug=deck.slug,
        title=deck.title,
        number=deck.number,
        latest_number=deck.latest_number,
        status=deck.status,
        as_of=deck.as_of,
        banner=deck.banner,
        source=ev.source,
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
                state=s.state,
                expand=[
                    ExpandOut(section_key=e.section_key, heading=e.heading, html=str(e.html))
                    for e in s.expand
                ],
            )
            for s in deck.slides
        ],
    )
