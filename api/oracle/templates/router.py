"""Templates (PRD and roadmap), themes, and the new-draft picker.

Anyone signed in reads; approvers and owners add, edit, archive and restore, and
start drafts; only owners set the company default.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import HTMLResponse, JSONResponse

from oracle.auth.deps import CurrentPrincipal, Principal, TenantDB
from oracle.authz import require_role, require_role_now
from oracle.templates import service
from oracle.templates.schemas import (
    DraftDefaults,
    ProblemsResponse,
    Recommendation,
    RecommendIn,
    StartDraftIn,
    StartDraftOut,
    TemplateCreate,
    TemplateKind,
    TemplateOut,
    TemplateSummary,
    TemplateUpdate,
    TemplateValidateIn,
    TemplateValidateOut,
    TemplateVersionOut,
    ThemeCreate,
    ThemeKind,
    ThemeOut,
    ThemePreviewIn,
    ThemeUpdate,
    ThemeValidateIn,
    ThemeValidateOut,
)

router = APIRouter(prefix="/v1", tags=["templates"])

Approver = Annotated[Principal, Depends(require_role("approver"))]
Owner = Annotated[Principal, Depends(require_role("owner"))]
ApproverNow = Annotated[Principal, Depends(require_role_now("approver"))]
OwnerNow = Annotated[Principal, Depends(require_role_now("owner"))]
REJECTED = {422: {"model": ProblemsResponse, "description": "Validation problems"}}


def _not_found(e: service.NotFoundError) -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, str(e))


def _conflict(e: service.ConflictError) -> HTTPException:
    return HTTPException(status.HTTP_409_CONFLICT, str(e))


def _rejected(e: service.InvalidError) -> JSONResponse:
    body = ProblemsResponse(detail=e.detail, problems=e.problems)
    return JSONResponse(body.model_dump(mode="json"), 422)


# --- templates ----------------------------------------------------------------------


@router.get("/templates", response_model=list[TemplateSummary])
async def list_templates(
    db: TenantDB,
    _: CurrentPrincipal,
    kind: TemplateKind | None = None,
    include_archived: bool = False,
) -> list[TemplateSummary]:
    """Live templates (built-ins seeded on first use); archived ones on request."""
    return await service.list_templates(db, kind, include_archived)


@router.post(
    "/templates",
    response_model=TemplateOut,
    status_code=status.HTTP_201_CREATED,
    responses={**REJECTED, 409: {"description": "Key taken"}},
)
async def create_template(data: TemplateCreate, db: TenantDB, principal: ApproverNow):
    try:
        return await service.create_template(db, data, principal)
    except service.InvalidError as e:
        return _rejected(e)
    except service.ConflictError as e:
        raise _conflict(e) from e


@router.post("/templates/validate", response_model=TemplateValidateOut)
async def validate_template(
    data: TemplateValidateIn, db: TenantDB, _: CurrentPrincipal
) -> TemplateValidateOut:
    """Check a body without saving it: heading ids, citations only in the final
    Sources and data points section, that section present."""
    return await service.validate_template(db, data.body, data.required_sections)


@router.get("/templates/{key}", response_model=TemplateOut)
async def get_template(key: str, db: TenantDB, _: CurrentPrincipal) -> TemplateOut:
    """A template with every version, archived or not (documents keep resolving)."""
    try:
        return await service.read_template(db, key)
    except service.NotFoundError as e:
        raise _not_found(e) from e


@router.get("/templates/{key}/versions/{n}", response_model=TemplateVersionOut)
async def get_template_version(
    key: str, n: int, db: TenantDB, _: CurrentPrincipal
) -> TemplateVersionOut:
    try:
        return await service.read_template_version(db, key, n)
    except service.NotFoundError as e:
        raise _not_found(e) from e


@router.patch("/templates/{key}", response_model=TemplateOut, responses=REJECTED)
async def update_template(key: str, data: TemplateUpdate, db: TenantDB, principal: ApproverNow):
    """Rename or describe in place; a changed body adds a new immutable version."""
    try:
        return await service.update_template(db, key, data, principal)
    except service.NotFoundError as e:
        raise _not_found(e) from e
    except service.InvalidError as e:
        return _rejected(e)


@router.delete("/templates/{key}", response_model=TemplateOut)
async def archive_template(key: str, db: TenantDB, principal: ApproverNow) -> TemplateOut:
    """Delete = archive: hidden from pickers, still readable by the documents using it."""
    try:
        return await service.set_template_archived(db, key, True, principal)
    except service.NotFoundError as e:
        raise _not_found(e) from e


@router.post("/templates/{key}/restore", response_model=TemplateOut)
async def restore_template(key: str, db: TenantDB, principal: ApproverNow) -> TemplateOut:
    try:
        return await service.set_template_archived(db, key, False, principal)
    except service.NotFoundError as e:
        raise _not_found(e) from e


# --- themes -------------------------------------------------------------------------


@router.get("/themes", response_model=list[ThemeOut], tags=["themes"])
async def list_themes(
    db: TenantDB,
    _: CurrentPrincipal,
    kind: ThemeKind | None = None,
    include_archived: bool = False,
) -> list[ThemeOut]:
    """Live themes for a document kind (themes of kind ``any`` included)."""
    return [
        ThemeOut.model_validate(t)
        for t in await service.list_themes(db, kind if kind != "any" else None, include_archived)
    ]


@router.post(
    "/themes",
    response_model=ThemeOut,
    status_code=status.HTTP_201_CREATED,
    responses={**REJECTED, 409: {"description": "Key taken"}},
    tags=["themes"],
)
async def create_theme(data: ThemeCreate, db: TenantDB, principal: ApproverNow):
    """Rejected (422) when a text colour misses WCAG AA contrast on the background, or
    the CSS or slide CSS loads anything from outside the export."""
    try:
        return ThemeOut.model_validate(await service.create_theme(db, data, principal))
    except service.InvalidError as e:
        return _rejected(e)
    except service.ConflictError as e:
        raise _conflict(e) from e


@router.post("/themes/validate", response_model=ThemeValidateOut, tags=["themes"])
async def validate_theme(data: ThemeValidateIn, _: CurrentPrincipal) -> ThemeValidateOut:
    problems = service.check_theme(data.tokens, data.css, data.slide_css)
    return ThemeValidateOut(valid=not problems, problems=problems)


@router.post(
    "/themes/preview",
    response_class=HTMLResponse,
    responses={200: {"content": {"text/html": {"schema": {"type": "string"}}}}},
    tags=["themes"],
)
async def preview_theme(data: ThemePreviewIn, _: CurrentPrincipal) -> HTMLResponse:
    """A sample document rendered with unsaved tokens and CSS, for the live preview;
    with ``view: slides``, the sample's brief as Present mode slides with the slide CSS."""
    from oracle.templates.preview import render_preview, render_slide_preview

    if data.view == "slides":
        return HTMLResponse(
            render_slide_preview(data.tokens, data.slide_css, data.kind, data.slide_variant)
        )
    return HTMLResponse(render_preview(data.tokens, data.css, data.kind))


@router.get("/themes/{key}", response_model=ThemeOut, tags=["themes"])
async def get_theme(key: str, db: TenantDB, _: CurrentPrincipal) -> ThemeOut:
    try:
        return ThemeOut.model_validate(await service.theme_or_404(db, key))
    except service.NotFoundError as e:
        raise _not_found(e) from e


@router.patch("/themes/{key}", response_model=ThemeOut, responses=REJECTED, tags=["themes"])
async def update_theme(key: str, data: ThemeUpdate, db: TenantDB, principal: ApproverNow):
    try:
        return ThemeOut.model_validate(await service.update_theme(db, key, data, principal))
    except service.NotFoundError as e:
        raise _not_found(e) from e
    except service.InvalidError as e:
        return _rejected(e)


@router.delete("/themes/{key}", response_model=ThemeOut, tags=["themes"])
async def archive_theme(key: str, db: TenantDB, principal: ApproverNow) -> ThemeOut:
    """Delete = archive: documents that use the theme still export with it."""
    try:
        return ThemeOut.model_validate(await service.set_theme_archived(db, key, True, principal))
    except service.NotFoundError as e:
        raise _not_found(e) from e


@router.post("/themes/{key}/restore", response_model=ThemeOut, tags=["themes"])
async def restore_theme(key: str, db: TenantDB, principal: ApproverNow) -> ThemeOut:
    try:
        return ThemeOut.model_validate(await service.set_theme_archived(db, key, False, principal))
    except service.NotFoundError as e:
        raise _not_found(e) from e


# --- new-draft picker ---------------------------------------------------------------


@router.post("/drafts/recommend", response_model=Recommendation, tags=["drafts"])
async def recommend_draft(data: RecommendIn, db: TenantDB, _: CurrentPrincipal) -> Recommendation:
    """The template (with a one-line reason) and theme to start a PRD or roadmap with,
    from the picker answers; plus every live template and theme to override it."""
    try:
        return await service.recommend(db, data)
    except service.NotFoundError as e:
        raise _not_found(e) from e


@router.post(
    "/drafts",
    response_model=StartDraftOut,
    status_code=status.HTTP_201_CREATED,
    responses={**REJECTED, 409: {"description": "Slug taken"}},
    tags=["drafts"],
)
async def start_draft(data: StartDraftIn, db: TenantDB, principal: ApproverNow):
    """Create the document (kind, template + version, theme) and its version 1 from the
    template skeleton."""
    try:
        return await service.start_draft(db, data, principal)
    except service.NotFoundError as e:
        raise _not_found(e) from e
    except service.InvalidError as e:
        return _rejected(e)
    except service.ConflictError as e:
        raise _conflict(e) from e


@router.get("/drafts/defaults", response_model=DraftDefaults, tags=["drafts"])
async def get_draft_defaults(db: TenantDB, _: CurrentPrincipal) -> DraftDefaults:
    """The company default template and theme per document kind."""
    return await service.read_draft_defaults(db)


@router.put("/drafts/defaults", response_model=DraftDefaults, responses=REJECTED, tags=["drafts"])
async def set_draft_defaults(data: DraftDefaults, db: TenantDB, principal: OwnerNow):
    try:
        return await service.write_draft_defaults(db, data, principal)
    except service.InvalidError as e:
        return _rejected(e)
