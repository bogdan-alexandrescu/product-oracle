"""Built-in jobs on a document: queueing, settings, suggestions, refinement, reports.

Service functions flush but never commit (the router commits once per request), except
:func:`apply_refinement`, which imports a version through the document importer (it
commits) and then records what was applied.

Roles (checked by the router): viewers read; approvers queue, retry and cancel jobs,
decide suggestions and refine sections; owners turn job kinds on or off per document.
"""

import uuid
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

import yaml
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, company_time
from oracle.docs import service as docs_service
from oracle.docs.models import Document, DocumentVersion, Section
from oracle.docs.schemas import ImportProblem, VersionOut
from oracle.jobs import kinds, prompting
from oracle.jobs.models import LlmJob, LlmSuggestion
from oracle.jobs.schemas import (
    ChangesReport,
    JobSettings,
    LlmJobOut,
    RefinementPreview,
    ResolutionNarrative,
    SuggestionOut,
    VersionReports,
)
from oracle.review.models import Comment, FeedbackItem
from oracle.review.service import locked_section_keys

if TYPE_CHECKING:
    from oracle.auth.deps import Principal

#: Each per-document switch in the words History > Oracle's work shows (D15); the keys
#: stay the job kinds. A refusal names the switch the owner unticked.
SWITCH_LABELS = {
    "review_comments": "Suggest changes from feedback",
    "reporting": "Write reports",
    "refinement": "Rewrite sections and build drafts",
    "quality_review": "Quality review",
    "decision_options": "Decision options",
}
#: Kinds that share another kind's per-document switch: the next-draft batch is
#: refinement, so turning refinement off turns it off too.
SWITCH = {"refinement_batch": "refinement"}


def turned_off(kind: str) -> str:
    switch = SWITCH.get(kind, kind)
    return f'"{SWITCH_LABELS.get(switch, switch)}" is turned off for this document'


def observing(kind: str) -> str:
    """H11: a triage job refused while Oracle observes review feedback, in D15's words."""
    switch = SWITCH.get(kind, kind)
    return f'"{SWITCH_LABELS.get(switch, switch)}" is off: {OBSERVING_FEEDBACK}'


class JobError(Exception):
    def __init__(self, status: int, message: str):
        self.status = status
        super().__init__(message)


def _now() -> datetime:
    return datetime.now(UTC)


# --- lookups --------------------------------------------------------------------------


async def get_document(db: AsyncSession, doc: str) -> Document:
    try:
        return await docs_service.get_document_or_404(db, doc)
    except docs_service.NotFoundError as e:
        raise JobError(404, str(e)) from e


async def get_version(db: AsyncSession, document: Document, n: int | None) -> DocumentVersion:
    if n is None:
        version = await db.scalar(
            select(DocumentVersion)
            .where(DocumentVersion.document_id == document.id)
            .order_by(DocumentVersion.number.desc())
            .limit(1)
        )
        if version is None:
            raise JobError(409, f"'{document.slug}' has no version yet")
        return version
    try:
        return await docs_service.get_version_row(db, document, n)
    except docs_service.NotFoundError as e:
        raise JobError(404, str(e)) from e


async def latest_number(db: AsyncSession, document_id: uuid.UUID) -> int | None:
    return await db.scalar(
        select(DocumentVersion.number)
        .where(DocumentVersion.document_id == document_id)
        .order_by(DocumentVersion.number.desc())
        .limit(1)
    )


async def get_job(db: AsyncSession, job_id: uuid.UUID) -> LlmJob:
    job = await db.get(LlmJob, job_id)
    if job is not None and job.document_id is not None:
        # H8: a job on a document the caller may not see is not found
        # (oracle.docs.visibility).
        from oracle.docs import visibility

        if job.document_id in await visibility.hidden_document_ids(db, [job.document_id]):
            job = None
    if job is None:
        raise JobError(404, f"job {job_id} not found")
    return job


async def jobs_out(db: AsyncSession, jobs: list[LlmJob]) -> list[LlmJobOut]:
    ids = {j.version_id for j in jobs if j.version_id}
    numbers: dict[uuid.UUID, int] = {}
    if ids:
        numbers = dict(
            (
                await db.execute(
                    select(DocumentVersion.id, DocumentVersion.number).where(
                        DocumentVersion.id.in_(ids)
                    )
                )
            ).all()
        )
    out = []
    for j in jobs:
        o = LlmJobOut.model_validate(j)
        o.version_number = numbers.get(j.version_id) if j.version_id else None
        o.cost_usd = float(j.cost_usd) if j.cost_usd is not None else None
        out.append(o)
    return out


async def job_out(db: AsyncSession, job: LlmJob) -> LlmJobOut:
    return (await jobs_out(db, [job]))[0]


# --- settings -------------------------------------------------------------------------


def settings_of(document: Document) -> JobSettings:
    off = set(document.disabled_llm_jobs or [])
    return JobSettings(**{k: k not in off for k in JobSettings.model_fields})


async def update_settings(
    db: AsyncSession, principal: "Principal", doc: str, settings: JobSettings
) -> JobSettings:
    document = await get_document(db, doc)
    before = settings_of(document)
    document.disabled_llm_jobs = [k for k in JobSettings.model_fields if not getattr(settings, k)]
    await db.flush()
    if before != settings:
        await audit.record(
            db,
            principal,
            "llm_jobs.settings",
            "document",
            document.id,
            {"before": before.model_dump(), "after": settings.model_dump()},
        )
    return settings_of(document)


def enabled(document: Document, kind: str) -> bool:
    return SWITCH.get(kind, kind) not in (document.disabled_llm_jobs or [])


# The jobs that triage review feedback (H11 ``feedback_triage``): at observe they are off
# for every document; a document's own switch can still turn them off, never on.
TRIAGE_KINDS = ("review_comments", "reporting")
OBSERVING_FEEDBACK = "Oracle is set to observe review feedback (Settings, Autonomy)"


async def triage_on(db: AsyncSession, kind: str) -> bool:
    """False for a triage job while Oracle is set to observe review feedback."""
    from oracle import autonomy

    return kind not in TRIAGE_KINDS or await autonomy.allows(db, "feedback_triage", "draft")


# --- queueing -------------------------------------------------------------------------


async def enqueue(
    db: AsyncSession,
    document: Document,
    kind: str,
    *,
    version: DocumentVersion | None = None,
    section_key: str | None = None,
    input: dict[str, Any] | None = None,
    principal: "Principal | None" = None,
    coalesce: bool = False,
) -> LlmJob:
    """Queue a job. ``coalesce``: reuse a queued job of the same kind and version."""
    if not enabled(document, kind):
        raise JobError(409, turned_off(kind))
    if not await triage_on(db, kind):
        raise JobError(409, observing(kind))
    if coalesce:
        queued = await db.scalar(
            select(LlmJob)
            .where(
                LlmJob.document_id == document.id,
                LlmJob.kind == kind,
                LlmJob.status == "queued",
                LlmJob.version_id == (version.id if version else None),
            )
            .limit(1)
        )
        if queued is not None:
            return queued
    job = LlmJob(
        kind=kind,
        document_id=document.id,
        version_id=version.id if version else None,
        section_key=section_key,
        status="queued",
        input={**(input or {}), **({"version": version.number} if version else {})},
        requested_by=principal.id if principal else None,
        attempts=0,
    )
    db.add(job)
    await db.flush()
    if principal is None:
        # Oracle queued it itself (a comment arrived); the job row is the record.
        return job
    await audit.record(
        db,
        principal,
        "llm_job.queue",
        "llm_job",
        job.id,
        {"kind": kind, "document_id": str(document.id), "version": job.input.get("version")},
    )
    return job


async def on_feedback(db: AsyncSession, document_id: uuid.UUID, version_number: int) -> None:
    """A comment or section verdict arrived: queue review comments (when on)."""
    document = await db.get(Document, document_id)
    if document is None or not enabled(document, "review_comments"):
        return
    if not await triage_on(db, "review_comments"):
        return
    version = await get_version(db, document, version_number)
    await enqueue(db, document, "review_comments", version=version, coalesce=True)


async def on_version_imported(
    db: AsyncSession, document_id: uuid.UUID, number: int, principal: "Principal | None"
) -> None:
    """A version after the first was imported: queue its reports (when on)."""
    document = await db.get(Document, document_id)
    if number < 2 or document is None or not enabled(document, "reporting"):
        return
    if not await triage_on(db, "reporting"):
        return
    version = await get_version(db, document, number)
    await enqueue(db, document, "reporting", version=version, principal=principal, coalesce=True)


async def create_job(
    db: AsyncSession,
    principal: "Principal",
    doc: str,
    kind: str,
    n: int | None,
    since: int | None,
) -> LlmJob:
    document = await get_document(db, doc)
    version = await get_version(db, document, n)
    extra: dict[str, Any] = {}
    if kind == "reporting" and since is not None:
        if since >= version.number:
            raise JobError(422, "'since' must be an earlier version")
        await get_version(db, document, since)
        extra["since"] = since
    return await enqueue(db, document, kind, version=version, input=extra, principal=principal)


async def list_jobs(db: AsyncSession, doc: str, limit: int = 50) -> list[LlmJobOut]:
    document = await get_document(db, doc)
    jobs = list(
        await db.scalars(
            select(LlmJob)
            .where(LlmJob.document_id == document.id)
            .order_by(LlmJob.created_at.desc(), LlmJob.id)
            .limit(limit)
        )
    )
    return await jobs_out(db, jobs)


async def cancel(db: AsyncSession, principal: "Principal", job_id: uuid.UUID) -> LlmJob:
    job = await db.scalar(select(LlmJob).where(LlmJob.id == job_id).with_for_update())
    if job is None:
        raise JobError(404, f"job {job_id} not found")
    if job.status not in ("queued", "running"):
        raise JobError(409, f"a {job.status} job cannot be cancelled")
    before = job.status
    job.status = "cancelled"
    job.finished_at = _now()
    await db.flush()
    await audit.record(db, principal, "llm_job.cancel", "llm_job", job.id, {"from": before})
    return job


async def retry(db: AsyncSession, principal: "Principal", job_id: uuid.UUID) -> LlmJob:
    job = await db.scalar(select(LlmJob).where(LlmJob.id == job_id).with_for_update())
    if job is None:
        raise JobError(404, f"job {job_id} not found")
    if job.status not in ("failed", "cancelled"):
        raise JobError(409, f"a {job.status} job cannot be retried")
    document = await db.get(Document, job.document_id) if job.document_id else None
    if document is not None and not enabled(document, job.kind):
        raise JobError(409, turned_off(job.kind))
    if not await triage_on(db, job.kind):
        raise JobError(409, observing(job.kind))
    before = job.status
    job.status = "queued"
    job.attempts = 0
    job.error = job.error_reason = job.next_reset_at = None
    job.started_at = job.finished_at = None
    await db.flush()
    await audit.record(db, principal, "llm_job.retry", "llm_job", job.id, {"from": before})
    return job


# --- suggestions ----------------------------------------------------------------------


async def latest_suggestions(
    db: AsyncSession, feedback_ids: list[uuid.UUID]
) -> dict[uuid.UUID, LlmSuggestion]:
    """The live (not superseded) suggestion of each feedback item, newest first."""
    if not feedback_ids:
        return {}
    rows = await db.scalars(
        select(LlmSuggestion)
        .where(
            LlmSuggestion.feedback_item_id.in_(feedback_ids),
            LlmSuggestion.status != "superseded",
        )
        .order_by(LlmSuggestion.created_at)
    )
    return {r.feedback_item_id: r for r in rows}


async def list_suggestions(
    db: AsyncSession, doc: str, status: str | None = None, section_key: str | None = None
) -> list[SuggestionOut]:
    document = await get_document(db, doc)
    stmt = select(LlmSuggestion).where(LlmSuggestion.document_id == document.id)
    if status:
        stmt = stmt.where(LlmSuggestion.status == status)
    if section_key:
        stmt = stmt.where(LlmSuggestion.section_key == section_key)
    rows = await db.scalars(stmt.order_by(LlmSuggestion.created_at, LlmSuggestion.id))
    return [SuggestionOut.model_validate(r) for r in rows]


async def _suggestion(db: AsyncSession, suggestion_id: uuid.UUID) -> LlmSuggestion:
    row = await db.scalar(
        select(LlmSuggestion).where(LlmSuggestion.id == suggestion_id).with_for_update()
    )
    if row is None:
        raise JobError(404, f"suggestion {suggestion_id} not found")
    return row


async def _clean_text(row: LlmSuggestion, text: str) -> str:
    if row.kind != "section_text":
        return text.strip()
    return (await prompting.clean_body_in_thread(text)).text


async def _check_section_open(db: AsyncSession, row: LlmSuggestion) -> None:
    if row.kind != "section_text" or not row.section_key:
        return
    latest = await db.scalar(
        select(DocumentVersion)
        .where(DocumentVersion.document_id == row.document_id)
        .order_by(DocumentVersion.number.desc())
        .limit(1)
    )
    if latest is not None and row.section_key in await locked_section_keys(db, latest.id):
        raise JobError(409, f"section {row.section_key!r} is approved and locked")


async def edit_suggestion(
    db: AsyncSession, principal: "Principal", suggestion_id: uuid.UUID, text: str
) -> LlmSuggestion:
    row = await _suggestion(db, suggestion_id)
    if row.status != "open":
        raise JobError(409, f"an {row.status} suggestion cannot be edited")
    if row.kind not in ("section_text", "answer"):
        raise JobError(422, "only proposed section text or an answer can be edited")
    row.edited_text = await _clean_text(row, text)
    await db.flush()
    await audit.record(db, principal, "suggestion.edit", "llm_suggestion", row.id, {})
    return row


async def accept_suggestion(
    db: AsyncSession,
    principal: "Principal",
    suggestion_id: uuid.UUID,
    text: str | None,
    reason: str | None,
) -> LlmSuggestion:
    """Accept: section text waits for a refinement; an answer is posted to the comment
    thread and closes the item; "nothing to change" closes it; a duplicate supersedes it.
    Nothing here changes the document."""
    row = await _suggestion(db, suggestion_id)
    if row.status != "open":
        raise JobError(409, f"an {row.status} suggestion cannot be accepted")
    reason = (reason or "").strip() or None
    if row.pushback and not reason:
        raise JobError(
            422, "Oracle pushed back on this feedback: say why you keep your call (reason)"
        )
    await _check_section_open(db, row)
    if text is not None:
        if row.kind not in ("section_text", "answer"):
            raise JobError(422, "only proposed section text or an answer can be edited")
        row.edited_text = await _clean_text(row, text)
    row.status = "accepted"
    row.decided_by = principal.id
    row.decided_at = _now()
    row.override_reason = reason if row.pushback else None
    item = await db.get(FeedbackItem, row.feedback_item_id)
    final = row.edited_text or row.text
    latest = await latest_number(db, row.document_id)
    if item is not None and item.status == "open":
        if row.kind == "answer" and final:
            if item.comment_id:
                parent = await db.get(Comment, item.comment_id)
                if parent is not None:
                    db.add(
                        Comment(
                            version_id=parent.version_id,
                            section_key=parent.section_key,
                            body=final,
                            author_id=principal.id,
                            parent_id=parent.id,
                            created_at=_now(),
                        )
                    )
            item.status, item.resolution_note = "addressed", f"Answered: {final}"
            item.addressed_in_version = latest
        elif row.kind == "none":
            item.status = "addressed"
            item.resolution_note = row.rationale or "Nothing to change"
            item.addressed_in_version = latest
        elif row.kind == "duplicate":
            item.status = "superseded"
            item.resolution_note = f"Duplicate of feedback item {row.duplicate_of}"
    await db.flush()
    await audit.record(
        db,
        principal,
        "suggestion.accept",
        "llm_suggestion",
        row.id,
        {"kind": row.kind, "edited": row.edited_text is not None},
    )
    if row.pushback:
        # C1b: an override of Oracle's pushback is logged with its reason for review.
        await audit.record(
            db,
            principal,
            "suggestion.override",
            "llm_suggestion",
            row.id,
            {"reason": reason, "pushback": row.pushback.get("reason")},
        )
        # H1: the override is a judgement call in the decision log, reviewed in 90 days.
        from oracle.decisions import capture

        await capture.pushback_overridden(db, principal, row, reason or "")
    return row


async def _in_use(db: AsyncSession, row: LlmSuggestion) -> str | None:
    """Why an accepted change cannot go back to open: a draft is being built from it (the
    next-draft build or a section refinement not applied or set aside, or the agents' run
    sent it), or None."""
    sid = str(row.id)
    jobs = await db.scalars(
        select(LlmJob).where(
            LlmJob.document_id == row.document_id,
            LlmJob.kind.in_(("refinement", "refinement_batch")),
            LlmJob.status.in_(("queued", "running", "succeeded")),
        )
    )
    for job in jobs:
        out = job.output or {}
        if out.get("applied_version") or out.get("discarded_at"):
            continue
        if sid in [str(i) for i in (job.input or {}).get("suggestion_ids") or []]:
            return "the next draft being built uses it: discard that build first"
    from oracle.runs.models import Run

    runs = await db.scalars(
        select(Run).where(
            Run.document_id == row.document_id,
            Run.status.not_in(("succeeded", "failed", "cancelled")),
        )
    )
    for run in runs:
        if sid in [str(i) for i in (run.knobs or {}).get("suggestion_ids") or []]:
            return "the agents' next draft uses it: cancel that run first"
    return None


async def undo_accept(
    db: AsyncSession, principal: "Principal", suggestion_id: uuid.UUID
) -> LlmSuggestion:
    """Undo Accept (D14): the suggestion is open again and its item as it was before.
    Refused, with the reason, when Accept cannot be reverted: the answer is posted on the
    thread, a draft applied the change or is being built from it, or the item changed since.
    The decision log keeps an override of Oracle's pushback (the audit records the undo)."""
    row = await _suggestion(db, suggestion_id)
    if row.status == "applied":
        raise JobError(409, f"draft {row.applied_in_version} already applied it; it stays")
    if row.status != "accepted":
        raise JobError(409, f"an {row.status} suggestion has no accept to undo")
    item = await db.get(FeedbackItem, row.feedback_item_id)
    if row.kind == "answer":
        raise JobError(409, "the answer is posted on the comment thread: reply there to correct it")
    if row.kind == "section_text":
        if why := await _in_use(db, row):
            raise JobError(409, why)
    else:
        closed = {"none": "addressed", "duplicate": "superseded"}[row.kind]
        if item is not None and item.status != closed:
            raise JobError(409, f"the item is {item.status} since; open it to change it")
        if item is not None:
            item.status, item.resolution_note, item.addressed_in_version = "open", None, None
    row.status = "open"
    row.decided_by = row.decided_at = row.override_reason = None
    await db.flush()
    await audit.record(
        db, principal, "suggestion.undo_accept", "llm_suggestion", row.id, {"kind": row.kind}
    )
    return row


async def dismiss_suggestion(
    db: AsyncSession,
    principal: "Principal",
    suggestion_id: uuid.UUID,
    reason: str | None,
    decline: bool,
) -> LlmSuggestion:
    row = await _suggestion(db, suggestion_id)
    if row.status not in ("open", "accepted"):
        raise JobError(409, f"an {row.status} suggestion cannot be dismissed")
    row.status = "dismissed"
    row.decided_by = principal.id
    row.decided_at = _now()
    if decline:
        item = await db.get(FeedbackItem, row.feedback_item_id)
        if item is not None and item.status == "open":
            item.status = "declined"
            item.resolution_note = (
                reason or (row.pushback or {}).get("reason") or "Declined on Oracle's suggestion"
            )
            item.addressed_in_version = await latest_number(db, row.document_id)
    await db.flush()
    await audit.record(
        db,
        principal,
        "suggestion.dismiss",
        "llm_suggestion",
        row.id,
        {"reason": reason, "declined_feedback": decline},
    )
    return row


# --- refinement -----------------------------------------------------------------------


async def request_refinement(
    db: AsyncSession,
    principal: "Principal",
    doc: str,
    n: int,
    key: str,
    suggestion_ids: list[uuid.UUID] | None,
    instruction: str | None,
) -> LlmJob:
    document = await get_document(db, doc)
    version = await get_version(db, document, n)
    if version.number != await latest_number(db, document.id):
        raise JobError(409, "refine the latest version; a newer one exists")
    section = await db.scalar(
        select(Section).where(Section.version_id == version.id, Section.section_key == key)
    )
    if section is None:
        raise JobError(404, f"section {key!r} is not in version {n}")
    if key in await locked_section_keys(db, version.id):
        raise JobError(409, f"section {key!r} is approved and locked; it is never changed")
    instruction = (instruction or "").strip()
    ids = [str(i) for i in suggestion_ids] if suggestion_ids is not None else None
    accepted = await kinds.accepted_suggestions(db, document.id, key, ids)
    if ids is not None and len(accepted) != len(set(ids)):
        raise JobError(422, "every suggestion must be an accepted section-text suggestion here")
    if not accepted and not instruction:
        raise JobError(422, "accept a suggestion for this section or give an instruction")
    return await enqueue(
        db,
        document,
        "refinement",
        version=version,
        section_key=key,
        input={"suggestion_ids": [str(x.id) for x in accepted], "instruction": instruction},
        principal=principal,
    )


def preview_of(job: LlmJob) -> RefinementPreview:
    out = job.output or {}
    return RefinementPreview(
        section_key=out["section_key"],
        heading=out["heading"],
        body_md=out["body_md"],
        words=out.get("preview") or [],
    )


SOURCES_KEYS = ("sources", "sources-and-data-points", "sources-data-points")


def _is_sources(section: Section) -> bool:
    return section.section_key in SOURCES_KEYS or section.heading.lower().startswith("sources")


def _data_point_lines(points: list[dict[str, str]]) -> str:
    lines = []
    for p in points:
        extra = "; ".join(
            x for x in (p.get("as_of") and f"as of {p['as_of']}", p.get("source")) if x
        )
        lines.append(f"- {p['value']}" + (f" ({extra})" if extra else ""))
    return "\n".join(lines)


def compose_markdown(
    front_matter: dict[str, Any],
    sections: list[Section],
    replace: dict[str, tuple[str, str]],
    resolutions: list[dict[str, Any]],
) -> str:
    """A draft from a version's sections, with some sections' (heading, body) replaced.

    Untouched sections come out byte-for-byte as stored, so their content hash (and an
    approved section's lock) is unchanged. A body that leaves a code fence open is
    closed before the next section, so it cannot swallow the sections after it (a
    stored version never has one but in its last section). And the draft is checked:
    every section key must come out, in order, or it raises
    :class:`~oracle.docs.parser.DraftError` (``section_lost``) rather than drop one.
    """
    from oracle.docs import parser

    fm = {k: v for k, v in front_matter.items() if k != "resolutions"}
    if resolutions:
        fm["resolutions"] = resolutions
    head = yaml.safe_dump(fm, sort_keys=False, allow_unicode=True).strip()
    parts = [f"---\n{head}\n---\n"]
    for i, s in enumerate(sections):
        heading, body = replace.get(s.section_key, (s.heading, s.body_md))
        parts.append(f"{'#' * s.level} {heading} {{#{s.section_key}}}\n")
        if body and i + 1 < len(sections) and (marker := parser.unclosed_fence(body)):
            body = f"{body}\n{marker}"
        if body:
            parts.append(f"{body}\n")
    out = "\n".join(parts)
    lost = lost_sections([s.section_key for s in sections], out)
    if lost:
        raise parser.DraftError(
            [
                ImportProblem(
                    code="section_lost",
                    message=f"composing the draft would lose or add section {k!r}; "
                    "nothing was imported",
                    section_key=k,
                )
                for k in lost
            ]
        )
    return out


def lost_sections(expected: list[str], markdown: str) -> list[str]:
    """Where ``markdown``'s sections differ from ``expected``: the keys it does not have,
    else the first out of order, else the keys it adds (a heading inside the last
    section's body adds a section after it). Empty when they are exactly ``expected``."""
    from oracle.docs.parser import section_keys

    keys = section_keys(markdown)
    if keys == expected:
        return []
    return (
        [k for k in expected if k not in keys]
        or [k for k, got in zip(expected, keys, strict=False) if k != got][:1]
        or keys[len(expected) :]
    )


async def apply_refinement(
    db: AsyncSession,
    principal: "Principal",
    job_id: uuid.UUID,
    heading: str | None,
    body_md: str | None,
) -> VersionOut:
    """Import the refined section as the next version, with its resolutions."""
    job = await get_job(db, job_id)
    if job.kind != "refinement" or job.status != "succeeded" or not job.output:
        raise JobError(409, "only a finished refinement can be accepted")
    out = job.output
    if out.get("applied_version"):
        raise JobError(409, f"already accepted as version {out['applied_version']}")
    document = await db.get(Document, job.document_id)
    base = await get_version(db, document, int(out["base_version"]))
    if base.number != await latest_number(db, document.id):
        raise JobError(409, "a newer version exists; refine the section again")
    key = out["section_key"]
    locked = await locked_section_keys(db, base.id)
    if key in locked:
        raise JobError(409, f"section {key!r} is approved and locked; it is never changed")
    sections = list(
        await db.scalars(
            select(Section).where(Section.version_id == base.id).order_by(Section.ordinal)
        )
    )
    target = next((s for s in sections if s.section_key == key), None)
    if target is None:
        raise JobError(409, f"section {key!r} is no longer in version {base.number}")
    new_heading = kinds.clean_heading(heading or "", out["heading"]) if heading else out["heading"]
    new_body = (
        (await prompting.clean_body_in_thread(body_md, new_heading)).text
        if body_md is not None
        else out["body_md"]
    )
    replace = {key: (new_heading, new_body)}
    points = out.get("data_points") or []
    sources = next((s for s in sections if _is_sources(s) and s.section_key != key), None)
    placed = False
    if points and sources is not None and sources.section_key not in locked:
        body = sources.body_md.rstrip()
        addition = f"#### Data points for {new_heading}\n\n{_data_point_lines(points)}"
        replace[sources.section_key] = (sources.heading, f"{body}\n\n{addition}".strip())
        placed = True

    suggestion_ids = [uuid.UUID(i) for i in out.get("suggestion_ids") or []]
    used = list(await db.scalars(select(LlmSuggestion).where(LlmSuggestion.id.in_(suggestion_ids))))
    resolutions = list(out.get("resolutions") or [])
    known = {r["feedback_id"] for r in resolutions}
    # Duplicates of the items worked in are resolved with them.
    dupes = list(
        await db.scalars(
            select(LlmSuggestion).where(
                LlmSuggestion.document_id == document.id,
                LlmSuggestion.kind == "duplicate",
                LlmSuggestion.status.in_(("open", "accepted")),
                LlmSuggestion.duplicate_of.in_([u.feedback_item_id for u in used]),
            )
        )
    )
    open_items = set(
        await db.scalars(
            select(FeedbackItem.id).where(
                FeedbackItem.document_id == document.id, FeedbackItem.status == "open"
            )
        )
    )
    for d in dupes:
        if str(d.feedback_item_id) not in known:
            resolutions.append(
                {
                    "feedback_id": str(d.feedback_item_id),
                    "status": "addressed",
                    "note": "Addressed with the item it duplicates",
                }
            )
    resolutions = [r for r in resolutions if uuid.UUID(r["feedback_id"]) in open_items]
    try:
        markdown = compose_markdown(base.front_matter, sections, replace, resolutions)
    except docs_service.DraftError as e:
        raise JobError(422, f"the revised draft does not import: {e}") from e
    # Imported as a person, so nothing downstream holds sections: every section of the
    # base must survive, or nothing is imported.
    lost = lost_sections([s.section_key for s in sections], markdown)
    if lost:
        raise JobError(
            422,
            f"the revised draft would lose or add section(s) {', '.join(lost)}; "
            "nothing was imported",
        )
    try:
        # An accepted AI patch: the change event invalidates the section's approval.
        result = await docs_service.import_draft(
            db,
            document.slug,
            markdown,
            principal,
            base_version=base.number,
            cause="patch_accepted",
            # A roadmap's dates are checked in the sections this revision changes only (not
            # the title): a flagged date elsewhere is the previous version's, marked there.
            date_sections=set(replace),
        )
    except docs_service.DraftError as e:
        await db.rollback()
        raise JobError(422, f"the revised draft does not import: {e}") from e
    except docs_service.ImportConflictError as e:
        raise JobError(409, str(e)) from e
    if not result.created:
        raise JobError(409, "the revision is identical to an existing version")
    number = result.version.number
    job = await get_job(db, job_id)
    job.output = {
        **job.output,
        "applied_version": number,
        "applied_by": str(principal.id),
        "applied_heading": new_heading,
        "applied_body_md": new_body,
        "data_points_placed": placed,
    }
    for s in [*used, *dupes]:
        s.status = "applied"
        s.applied_in_version = number
    await audit.record(
        db,
        principal,
        "llm_job.apply",
        "llm_job",
        job.id,
        {"version": number, "section_key": key, "resolutions": len(resolutions)},
    )
    await on_version_imported(db, document.id, number, principal)
    await db.commit()
    return result.version


# --- reports --------------------------------------------------------------------------


async def version_reports(db: AsyncSession, doc: str, n: int) -> VersionReports:
    document = await get_document(db, doc)
    version = await get_version(db, document, n)
    jobs = list(
        await db.scalars(
            select(LlmJob)
            .where(LlmJob.version_id == version.id, LlmJob.kind == "reporting")
            .order_by(LlmJob.created_at.desc())
        )
    )
    done = next((j for j in jobs if j.status == "succeeded" and j.output), None)
    out = VersionReports(
        document_id=document.id,
        version=n,
        latest_job=await job_out(db, jobs[0]) if jobs else None,
    )
    if done is not None:
        out.report_job_id = done.id
        out.generated_at = done.finished_at
        out.resolution = ResolutionNarrative.model_validate(done.output["resolution"])
        out.changes = ChangesReport.model_validate(done.output["changes"])
    return out


STATUS_WORDS = {
    "addressed": "Addressed",
    "declined": "Declined",
    "superseded": "Superseded",
    "open": "Still open",
}


def reports_markdown(document: Document, reports: VersionReports, zone: str) -> str:
    """The version reports download; its times and days are the Company's, in ``zone`` (#463)."""
    lines = [
        f"# {document.title}: reports for version {reports.version}",
        "",
        f"Product Oracle · {document.slug} · version {reports.version}"
        + (
            f" · generated {company_time.stamp(reports.generated_at, zone)}"
            if reports.generated_at
            else ""
        ),
        "",
    ]
    r = reports.resolution
    if r is not None:
        lines += ["## How feedback was handled", "", r.summary, ""]
        if r.counts:
            lines += [
                ", ".join(f"{STATUS_WORDS.get(k, k)}: {v}" for k, v in sorted(r.counts.items())),
                "",
            ]
        for item in r.items:
            where = f" (#{item.section_key})" if item.section_key else ""
            lines.append(
                f"- **{STATUS_WORDS.get(item.status, item.status)}**{where}: {item.summary}"
            )
            detail = item.explanation or item.resolution_note
            if detail:
                lines.append(f"  {detail}")
        lines.append("")
    c = reports.changes
    if c is not None:
        title = f"What changed since version {c.since}" if c.since else "What changed"
        lines += [f"## {title}", "", c.summary, ""]
        for sec in c.sections:
            lines.append(
                f"- **{sec.heading}** ({sec.status})" + (f": {sec.summary}" if sec.summary else "")
            )
        if c.sections:
            lines.append("")
        if c.new_sources:
            lines += ["### New sources in the baseline", ""]
            for src in c.new_sources:
                about = f" (on {src.about})" if src.about else ""
                added = company_time.day(src.added_at, zone)
                lines.append(f"- {src.title}{about}, {src.kind}, added {added}")
            lines.append("")
    if r is None and c is None:
        lines += ["No reports have been generated for this version yet.", ""]
    return "\n".join(lines).rstrip() + "\n"
