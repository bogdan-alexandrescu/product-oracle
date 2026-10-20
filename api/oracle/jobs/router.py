"""Built-in model jobs: the Jobs panel, suggestions, refinement and version reports.

Viewers read jobs, suggestions and reports; approvers queue, retry and cancel jobs,
accept, edit and dismiss suggestions, and refine sections; owners turn job kinds on or
off per document. Approvers build the next draft from the staged changes (C1e) in one
job, preview it, apply it as one version or discard it. An intake job's output (what it
read and wrote from the author's sources) is shown to the intake's author only (S6).
Logic lives in :mod:`oracle.jobs.service` and :mod:`oracle.jobs.next_draft`; each
handler commits once.
"""

import uuid
from collections.abc import Awaitable
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from markdown_it import MarkdownIt
from markupsafe import escape

from oracle.auth.deps import Principal, TenantDB
from oracle.authz import require_role
from oracle.docs.schemas import VersionOut
from oracle.intake import sharing
from oracle.jobs import next_draft, service
from oracle.jobs.schemas import (
    JobCreate,
    JobSettings,
    LlmJobOut,
    NextDraftApply,
    NextDraftIn,
    NextDraftPreview,
    RefineIn,
    RefinementApply,
    RefinementPreview,
    StagedChanges,
    SuggestionAccept,
    SuggestionDismiss,
    SuggestionOut,
    SuggestionPatch,
    SuggestionStatus,
    VersionReports,
)
from oracle.v2.models import ProductIntake

router = APIRouter(prefix="/v1", tags=["llm-jobs"], dependencies=[Depends(require_role("viewer"))])
Approver = Annotated[Principal, Depends(require_role("approver"))]
Viewer = Annotated[Principal, Depends(require_role("viewer"))]
Owner = Annotated[Principal, Depends(require_role("owner"))]
DOC = "/documents/{doc}"
VERSION = DOC + "/versions/{n}"


async def _call[T](op: Awaitable[T]) -> T:
    try:
        return await op
    except service.JobError as e:
        raise HTTPException(e.status, str(e)) from e


async def _shown(db: TenantDB, principal: Principal, job) -> LlmJobOut:
    """The job as the caller may see it: an intake job's output counts how many items
    and gaps it drew from the author's sources, and its usage (tokens, cost) how much
    it read and wrote from them, so only the author sees either (S6)."""
    out = await service.job_out(db, job)
    if out.intake_id is not None:
        intake = await db.get(ProductIntake, out.intake_id)
        if intake is None or not sharing.is_author(principal, intake):
            out.output = None
            out.input_tokens = out.output_tokens = out.cost_usd = None
    return out


# --- jobs -----------------------------------------------------------------------------


@router.get(DOC + "/llm-jobs", response_model=list[LlmJobOut])
async def list_llm_jobs(doc: str, db: TenantDB) -> list[LlmJobOut]:
    """The document's built-in jobs, newest first."""
    return await _call(service.list_jobs(db, doc))


@router.post(DOC + "/llm-jobs", response_model=LlmJobOut, status_code=201)
async def create_llm_job(doc: str, body: JobCreate, principal: Approver, db: TenantDB) -> LlmJobOut:
    """Queue review comments or reporting by hand (they also queue themselves)."""
    job = await _call(service.create_job(db, principal, doc, body.kind, body.version, body.since))
    await db.commit()
    return await service.job_out(db, job)


@router.get(DOC + "/llm-jobs/settings", response_model=JobSettings)
async def get_llm_job_settings(doc: str, db: TenantDB) -> JobSettings:
    return service.settings_of(await _call(service.get_document(db, doc)))


@router.put(DOC + "/llm-jobs/settings", response_model=JobSettings)
async def put_llm_job_settings(
    doc: str, body: JobSettings, principal: Owner, db: TenantDB
) -> JobSettings:
    """Turn each built-in job kind on or off for this document."""
    out = await _call(service.update_settings(db, principal, doc, body))
    await db.commit()
    return out


@router.get("/llm-jobs/{job_id}", response_model=LlmJobOut)
async def get_llm_job(job_id: uuid.UUID, principal: Viewer, db: TenantDB) -> LlmJobOut:
    return await _shown(db, principal, await _call(service.get_job(db, job_id)))


@router.post("/llm-jobs/{job_id}/cancel", response_model=LlmJobOut)
async def cancel_llm_job(job_id: uuid.UUID, principal: Approver, db: TenantDB) -> LlmJobOut:
    job = await _call(service.cancel(db, principal, job_id))
    await db.commit()
    return await _shown(db, principal, job)


@router.post("/llm-jobs/{job_id}/retry", response_model=LlmJobOut)
async def retry_llm_job(job_id: uuid.UUID, principal: Approver, db: TenantDB) -> LlmJobOut:
    job = await _call(service.retry(db, principal, job_id))
    await db.commit()
    return await _shown(db, principal, job)


# --- refinement -----------------------------------------------------------------------


@router.post(VERSION + "/sections/{key}/refine", response_model=LlmJobOut, status_code=201)
async def refine_section(
    doc: str, n: int, key: str, body: RefineIn, principal: Approver, db: TenantDB
) -> LlmJobOut:
    """Queue a refinement of one section from accepted suggestions and/or an instruction.

    Locked (approved) sections are refused (409)."""
    job = await _call(
        service.request_refinement(
            db, principal, doc, n, key, body.suggestion_ids, body.instruction
        )
    )
    await db.commit()
    return await service.job_out(db, job)


@router.get("/llm-jobs/{job_id}/preview", response_model=RefinementPreview)
async def preview_refinement(job_id: uuid.UUID, db: TenantDB) -> RefinementPreview:
    """The revised section and its word diff against the current text."""
    job = await _call(service.get_job(db, job_id))
    if job.kind != "refinement" or job.status != "succeeded" or not job.output:
        raise HTTPException(409, "only a finished refinement has a preview")
    return service.preview_of(job)


@router.post("/llm-jobs/{job_id}/apply", response_model=VersionOut, status_code=201)
async def apply_refinement(
    job_id: uuid.UUID, body: RefinementApply, principal: Approver, db: TenantDB
) -> VersionOut:
    """Accept a refinement: import it as the next version, with its resolutions."""
    return await _call(service.apply_refinement(db, principal, job_id, body.heading, body.body_md))


# --- next draft from staged changes (C1e) ----------------------------------------------


@router.get(DOC + "/staged-changes", response_model=StagedChanges)
async def list_staged_changes(
    doc: str,
    db: TenantDB,
    include_gone: Annotated[
        bool, Query(description="Also list staged items whose section is gone")
    ] = False,
) -> StagedChanges:
    """Accepted suggestions waiting for the next draft, from whichever draft they were
    raised on, with who accepted them and when, and the build in progress if any."""
    return await _call(next_draft.staged_changes(db, doc, include_gone))


@router.post(DOC + "/next-draft", response_model=LlmJobOut, status_code=201)
async def build_next_draft(
    doc: str, body: NextDraftIn, principal: Approver, db: TenantDB
) -> LlmJobOut:
    """Build the next draft: one job rewrites every section the chosen staged suggestions
    touch (default: all staged), over the latest version. Locked sections are refused
    (409, naming them)."""
    job = await _call(next_draft.build(db, principal, doc, body.suggestion_ids))
    await db.commit()
    return await service.job_out(db, job)


@router.get(DOC + "/next-draft/{job_id}", response_model=NextDraftPreview)
async def preview_next_draft(doc: str, job_id: uuid.UUID, db: TenantDB) -> NextDraftPreview:
    """The combined preview: each revised section with its word diff, notes and
    resolutions. Sections are empty until the build has finished."""
    return await _call(next_draft.preview(db, doc, job_id))


@router.post(DOC + "/next-draft/{job_id}/apply", response_model=VersionOut, status_code=201)
async def apply_next_draft(
    doc: str, job_id: uuid.UUID, body: NextDraftApply, principal: Approver, db: TenantDB
) -> VersionOut:
    """Apply as ONE new version, without the dropped sections (they stay staged).
    Refused (409) when a newer version appeared since the build started."""
    return await _call(next_draft.apply(db, principal, doc, job_id, body.drop_sections, body.edits))


@router.post(DOC + "/next-draft/{job_id}/discard", response_model=LlmJobOut)
async def discard_next_draft(
    doc: str, job_id: uuid.UUID, principal: Approver, db: TenantDB
) -> LlmJobOut:
    """Discard a build (cancel it while it runs); every staged item stays staged."""
    job = await _call(next_draft.discard(db, principal, doc, job_id))
    await db.commit()
    return await service.job_out(db, job)


# --- suggestions ----------------------------------------------------------------------


@router.get(DOC + "/suggestions", response_model=list[SuggestionOut])
async def list_suggestions(
    doc: str,
    db: TenantDB,
    status: SuggestionStatus | None = None,
    section_key: str | None = None,
) -> list[SuggestionOut]:
    return await _call(service.list_suggestions(db, doc, status, section_key))


@router.patch("/suggestions/{suggestion_id}", response_model=SuggestionOut)
async def edit_suggestion(
    suggestion_id: uuid.UUID, body: SuggestionPatch, principal: Approver, db: TenantDB
) -> SuggestionOut:
    row = await _call(service.edit_suggestion(db, principal, suggestion_id, body.text))
    await db.commit()
    await db.refresh(row)
    return SuggestionOut.model_validate(row)


@router.post("/suggestions/{suggestion_id}/accept", response_model=SuggestionOut)
async def accept_suggestion(
    suggestion_id: uuid.UUID, body: SuggestionAccept, principal: Approver, db: TenantDB
) -> SuggestionOut:
    """Accept (optionally with an edit). Nothing changes the document until a refinement
    built from it is accepted."""
    row = await _call(
        service.accept_suggestion(db, principal, suggestion_id, body.text, body.reason)
    )
    await db.commit()
    await db.refresh(row)
    return SuggestionOut.model_validate(row)


@router.post("/suggestions/{suggestion_id}/dismiss", response_model=SuggestionOut)
async def dismiss_suggestion(
    suggestion_id: uuid.UUID, body: SuggestionDismiss, principal: Approver, db: TenantDB
) -> SuggestionOut:
    row = await _call(
        service.dismiss_suggestion(db, principal, suggestion_id, body.reason, body.decline)
    )
    await db.commit()
    await db.refresh(row)
    return SuggestionOut.model_validate(row)


# --- reports --------------------------------------------------------------------------


@router.get(VERSION + "/reports", response_model=VersionReports)
async def get_version_reports(doc: str, n: int, db: TenantDB) -> VersionReports:
    """The resolution report and 'what changed' summary of a version."""
    return await _call(service.version_reports(db, doc, n))


_md = MarkdownIt("commonmark", {"html": False})


@router.get(
    VERSION + "/reports/export",
    response_class=Response,
    responses={
        200: {
            "description": "The version's reports, exportable with the version",
            "content": {
                "text/markdown": {"schema": {"type": "string"}},
                "text/html": {"schema": {"type": "string"}},
            },
        }
    },
)
async def export_version_reports(
    doc: str,
    n: int,
    db: TenantDB,
    fmt: Literal["md", "html"] = Query("md", alias="format"),
) -> Response:
    document = await _call(service.get_document(db, doc))
    reports = await _call(service.version_reports(db, doc, n))
    text = service.reports_markdown(document, reports)
    stem = f"{document.slug}-v{n}-reports"
    if fmt == "md":
        return Response(
            text,
            media_type="text/markdown; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{stem}.md"'},
        )
    title = escape(f"{document.title}: reports for version {n}")
    html = (
        f'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>{title}</title>'
        "<style>body{font:15px/1.55 system-ui,sans-serif;max-width:46rem;margin:2rem auto;"
        "padding:0 1rem;color:#171717}h1{font-size:1.5rem}h2{font-size:1.15rem;margin-top:2rem}"
        "</style></head><body>" + _md.render(text) + "</body></html>"
    )
    return Response(
        html,
        media_type="text/html; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{stem}.html"'},
    )
