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

from oracle.auth.deps import CurrentPrincipal, Principal, TenantDB
from oracle.authz import has_role, require_role
from oracle.docs.schemas import Audience
from oracle.export import offload, present
from oracle.export.deck import build_deck, render_deck_html, theme_class
from oracle.export.pdf import PdfUnavailable, html_to_pdf
from oracle.export.render import (
    ExportVersion,
    NoBrief,
    NotFound,
    apply_audience,
    apply_layer,
    check_audience,
    detached,
    load_audience,
    load_export_version,
    render_html,
    render_markdown,
)
from oracle.export.schemas import (
    LAYER_FORMATS,
    AudienceOut,
    DeckOut,
    ExpandOut,
    ExportFormat,
    ExportLayer,
    SlideOut,
)
from oracle.roadmap import variants

router = APIRouter(prefix="/v1", tags=["export"], dependencies=[Depends(require_role("viewer"))])

PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
MEDIA_TYPES = {
    "html": "text/html; charset=utf-8",
    "pdf": "application/pdf",
    "md": "text/markdown; charset=utf-8",
    "pptx": PPTX,
}


def check_audience_role(principal: Principal, audience: str | None) -> None:
    """O5: Board, Team and Engineering are open to every reader (they hide, never add).
    The Public audience needs an approver or above, never a run (agents get no public
    text), because before its check it names internal items."""
    if audience != "public":
        return
    if principal.is_run or principal.run_token_id is not None:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "A run's agents cannot read the Public audience"
        )
    if not has_role(principal.role, "approver"):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "The Public audience needs the approver role"
        )


async def with_audience(db, ev: ExportVersion, audience: str | None) -> ExportVersion:
    """``ev`` (already layered) rendered for ``audience``: 422 for a document that is not
    a roadmap, 409 ``public_not_ready`` for the Public audience (lane 2 builds it)."""
    if audience is None:
        return ev
    try:
        check_audience(ev, audience)
    except variants.PublicNotReady as e:
        raise HTTPException(status.HTTP_409_CONFLICT, {"code": e.code, "message": str(e)}) from None
    except variants.AudienceError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(e)) from None
    await load_audience(db, ev)
    return apply_audience(ev, audience)


async def _load(db, doc: str, n: int, layer: str, audience: str | None = None):
    try:
        ev = await load_export_version(db, doc, n)
    except NotFound as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(e)) from None
    try:
        ev = apply_layer(ev, layer)
    except NoBrief as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(e)) from None
    return await with_audience(db, ev, audience)


@router.get("/roadmap-audiences", response_model=list[AudienceOut], tags=["roadmaps"])
async def list_audiences() -> list[AudienceOut]:
    """O5: the audience registry (oracle.roadmap.variants): what each audience hides,
    which item fields it shows and how it groups them."""
    return [
        AudienceOut(
            key=v.key,
            label=v.label,
            hidden_sections=sorted(v.hidden_sections),
            item_fields=sorted(v.item_fields),
            group_by=v.group_by,
            max_items_per_horizon=v.max_items_per_horizon,
            appendix=v.appendix,
        )
        for v in variants.VARIANTS.values()
    ]


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
        403: {"description": "The Public audience below the approver role, or for a run"},
        409: {"description": "public_not_ready: the Public audience needs a public check"},
        422: {
            "description": "Format not offered for the layer, the version has no brief, or "
            "an audience for a document that is not a roadmap (or as markdown)"
        },
    },
)
async def export_version(
    doc: str,
    n: int,
    db: TenantDB,
    principal: CurrentPrincipal,
    fmt: ExportFormat = Query("html", alias="format"),
    layer: ExportLayer = Query("full"),
    audience: Audience | None = Query(None),
) -> Response:
    """Full: html, pdf, md. Brief: html, pdf. Deck: pdf, pptx (html: the printable
    slides). ``audience`` (roadmaps, O5): the rendering for Board, Team or Engineering;
    markdown is the stored text and has none."""
    if fmt not in LAYER_FORMATS[layer]:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f"the {layer} layer exports as {', '.join(LAYER_FORMATS[layer])}, not {fmt}",
        )
    check_audience_role(principal, audience)
    if audience is not None and fmt == "md":
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "markdown is the stored text; export an audience as html, pdf or pptx",
        )
    try:
        with offload.place(principal) as held:
            ev = detached(await _load(db, doc, n, layer, audience))
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
async def get_deck(
    doc: str,
    n: int,
    db: TenantDB,
    principal: CurrentPrincipal,
    audience: Audience | None = Query(None),
) -> Any:
    """The brief layer as slides in the document's theme (its slide variant), with
    presenter notes and the detail each slide can expand. 422 when the version has no
    brief sections."""
    # Present mode: kept, else built on the export pool in a Present place (owner decision
    # 2026-10-20).
    check_audience_role(principal, audience)
    ev = detached(await _load(db, doc, n, "deck", audience))
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
