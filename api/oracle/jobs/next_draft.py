"""C1e: staged changes and the next draft built from them in one job.

Accepting a section-text suggestion stages it: nothing is applied per item. The staged
changes of a document are every accepted section-text suggestion not applied in any
draft yet, whichever draft it was raised on. **Build next draft** queues one
``refinement_batch`` job over the latest version (the approver may untick items); the
approver sees one combined preview, may drop sections or edit them, and **Apply**
imports exactly one new version. Suggestions of dropped (or skipped) sections stay
staged, and so does everything when the build is discarded.

Service functions flush but never commit, except :func:`apply`, which imports a
version through the document importer (it commits) and then records what was applied.
"""

import uuid
from datetime import UTC, datetime
from decimal import Decimal
from typing import TYPE_CHECKING

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.auth.models import ApiToken, User
from oracle.docs import service as docs_service
from oracle.docs.models import Document, DocumentVersion, Section
from oracle.docs.schemas import VersionOut
from oracle.jobs import kinds, prompting
from oracle.jobs.models import LlmJob, LlmSuggestion
from oracle.jobs.schemas import (
    NextDraftFeedback,
    NextDraftPreview,
    NextDraftSection,
    SkippedSection,
    StagedChange,
    StagedChanges,
)
from oracle.jobs.service import (
    JobError,
    _data_point_lines,
    _is_sources,
    compose_markdown,
    enqueue,
    get_document,
    job_out,
    latest_number,
    on_version_imported,
)
from oracle.review.models import FeedbackItem
from oracle.review.service import locked_section_keys

if TYPE_CHECKING:
    from oracle.auth.deps import Principal

KIND = "refinement_batch"
#: Earlier refinements a cost estimate is drawn from.
ESTIMATE_SAMPLE = 20


def _now() -> datetime:
    return datetime.now(UTC)


async def names(db: AsyncSession, ids: set[uuid.UUID]) -> dict[uuid.UUID, str]:
    """A label for each user (email) or API token (name) id."""
    ids = {i for i in ids if i}
    if not ids:
        return {}
    out: dict[uuid.UUID, str] = dict(
        (await db.execute(select(User.id, User.email).where(User.id.in_(ids)))).all()
    )
    rest = ids - set(out)
    if rest:
        out.update(
            (
                await db.execute(select(ApiToken.id, ApiToken.name).where(ApiToken.id.in_(rest)))
            ).all()
        )
    return out


async def _latest(db: AsyncSession, document: Document) -> DocumentVersion | None:
    return await db.scalar(
        select(DocumentVersion)
        .where(DocumentVersion.document_id == document.id)
        .order_by(DocumentVersion.number.desc())
        .limit(1)
    )


async def _sections(db: AsyncSession, version: DocumentVersion | None) -> list[Section]:
    if version is None:
        return []
    return list(
        await db.scalars(
            select(Section).where(Section.version_id == version.id).order_by(Section.ordinal)
        )
    )


def _discarded(job: LlmJob) -> bool:
    return bool((job.output or {}).get("discarded_at"))


def _applied(job: LlmJob) -> int | None:
    return (job.output or {}).get("applied_version")


async def current_job(db: AsyncSession, document_id: uuid.UUID) -> LlmJob | None:
    """The document's latest next-draft build while it is still pending (queued,
    running, failed or ready to preview); None once applied, discarded or cancelled."""
    job = await db.scalar(
        select(LlmJob)
        .where(LlmJob.document_id == document_id, LlmJob.kind == KIND)
        .order_by(LlmJob.created_at.desc(), LlmJob.id.desc())
        .limit(1)
    )
    if job is None or job.status == "cancelled" or _applied(job) or _discarded(job):
        return None
    return job


async def _estimate(db: AsyncSession, sections: int) -> float | None:
    """Typical cost per section of recent refinements, times the sections to build."""
    rows = list(
        await db.scalars(
            select(LlmJob)
            .where(
                LlmJob.kind.in_(("refinement", KIND)),
                LlmJob.status == "succeeded",
                LlmJob.cost_usd.is_not(None),
            )
            .order_by(LlmJob.finished_at.desc().nulls_last())
            .limit(ESTIMATE_SAMPLE)
        )
    )
    per: list[Decimal] = []
    for j in rows:
        n = len((j.output or {}).get("sections") or []) if j.kind == KIND else 1
        if n and j.cost_usd is not None:
            per.append(j.cost_usd / n)
    if not per or not sections:
        return None
    return round(float(sum(per) / len(per)) * sections, 4)


# --- staged changes -----------------------------------------------------------------------


async def staged_changes(db: AsyncSession, doc: str, include_gone: bool = False) -> StagedChanges:
    document = await get_document(db, doc)
    latest = await _latest(db, document)
    sections = await _sections(db, latest)
    headings = {s.section_key: s.heading for s in sections}
    locked = await locked_section_keys(db, latest.id) if latest else set()
    rows = await kinds.staged_suggestions(db, document.id)
    items = {
        f.id: f
        for f in await db.scalars(
            select(FeedbackItem).where(FeedbackItem.id.in_([r.feedback_item_id for r in rows]))
        )
    }
    # The heading of a gone section, from the draft its suggestion was written against.
    old_headings: dict[tuple[int, str], str] = {}
    gone_rows = [r for r in rows if r.section_key not in headings]
    if gone_rows:
        old_headings = {
            (n, k): h
            for n, k, h in (
                await db.execute(
                    select(DocumentVersion.number, Section.section_key, Section.heading)
                    .join(Section, Section.version_id == DocumentVersion.id)
                    .where(
                        DocumentVersion.document_id == document.id,
                        Section.section_key.in_({r.section_key for r in gone_rows}),
                    )
                )
            ).all()
        }
    who = await names(db, {r.decided_by for r in rows if r.decided_by})
    out: list[StagedChange] = []
    gone = 0
    for r in rows:
        key = r.section_key or ""
        is_gone = key not in headings
        gone += is_gone
        if is_gone and not include_gone:
            continue
        item = items.get(r.feedback_item_id)
        heading = headings.get(key) or next(
            (
                h
                for (n, k), h in sorted(old_headings.items(), reverse=True)
                if k == key and n <= r.version_number
            ),
            key,
        )
        out.append(
            StagedChange(
                suggestion_id=r.id,
                feedback_item_id=r.feedback_item_id,
                section_key=key,
                section_heading=heading,
                feedback_summary=item.summary if item else "",
                text=r.edited_text or r.text or "",
                accepted_by=r.decided_by,
                accepted_by_name=who.get(r.decided_by) if r.decided_by else None,
                accepted_at=r.decided_at,
                raised_on_version=item.raised_on_version if item else r.version_number,
                suggested_on_version=r.version_number,
                section_gone=is_gone,
                section_locked=key in locked,
            )
        )
    job = await current_job(db, document.id)
    buildable = {c.section_key for c in out if not c.section_gone}
    return StagedChanges(
        document_id=document.id,
        slug=document.slug,
        latest_version=latest.number if latest else None,
        next_version=(latest.number if latest else 0) + 1,
        items=out,
        gone_count=gone,
        estimate_usd=await _estimate(db, len(buildable)),
        draft_job=await job_out(db, job) if job else None,
    )


# --- build --------------------------------------------------------------------------------


async def build(
    db: AsyncSession, principal: "Principal", doc: str, suggestion_ids: list[uuid.UUID] | None
) -> LlmJob:
    document = await get_document(db, doc)
    # Serialise builds per document: the row lock is held until the request commits, so a
    # double click or two approvers cannot both pass the pending check below.
    await db.execute(select(Document.id).where(Document.id == document.id).with_for_update())
    latest = await _latest(db, document)
    if latest is None:
        raise JobError(409, f"'{document.slug}' has no version yet")
    pending = await current_job(db, document.id)
    if pending is not None and pending.status in ("queued", "running"):
        raise JobError(
            409,
            f"a build is already running (job {pending.id}); wait for it or discard it",
        )
    sections = await _sections(db, latest)
    headings = {s.section_key: s.heading for s in sections}
    ids = [str(i) for i in suggestion_ids] if suggestion_ids is not None else None
    rows = await kinds.staged_suggestions(db, document.id, ids)
    if ids is not None and len(rows) != len(set(ids)):
        raise JobError(422, "every suggestion must be a staged (accepted, not applied) change")
    gone = [r for r in rows if r.section_key not in headings]
    if ids is None:
        rows = [r for r in rows if r.section_key in headings]
    elif gone:
        keys = ", ".join(sorted({r.section_key or "?" for r in gone}))
        raise JobError(
            422, f"section(s) {keys} are no longer in version {latest.number}; untick them"
        )
    if not rows:
        raise JobError(422, "nothing is staged for the next draft")
    locked = await locked_section_keys(db, latest.id)
    hit = [
        s
        for s in sections
        if s.section_key in locked and s.section_key in {r.section_key for r in rows}
    ]
    if hit:
        named = ", ".join(f"{s.heading} ({s.section_key})" for s in hit)
        raise JobError(409, f"approved and locked, never changed: {named}; untick them")
    return await enqueue(
        db,
        document,
        KIND,
        version=latest,
        input={"suggestion_ids": [str(r.id) for r in rows]},
        principal=principal,
    )


# --- preview ------------------------------------------------------------------------------


async def _job(db: AsyncSession, document: Document, job_id: uuid.UUID, lock: bool = False):
    stmt = select(LlmJob).where(LlmJob.id == job_id)
    if lock:
        stmt = stmt.with_for_update()
    job = await db.scalar(stmt)
    if job is None or job.document_id != document.id or job.kind != KIND:
        raise JobError(404, f"next-draft build {job_id} not found on '{document.slug}'")
    return job


async def preview(db: AsyncSession, doc: str, job_id: uuid.UUID) -> NextDraftPreview:
    document = await get_document(db, doc)
    job = await _job(db, document, job_id)
    latest = await latest_number(db, document.id)
    base = (job.input or {}).get("version")
    out = NextDraftPreview(
        job=await job_out(db, job),
        base_version=base,
        next_version=base + 1 if base else None,
        latest_version=latest,
        stale=bool(base and latest and latest != base and not _applied(job)),
        applied_version=_applied(job),
        discarded=_discarded(job),
    )
    if job.status != "succeeded" or not job.output:
        return out
    data = job.output
    fids = {
        uuid.UUID(r["feedback_id"]) for s in data.get("sections") or [] for r in s["resolutions"]
    }
    summaries = dict(
        (
            await db.execute(
                select(FeedbackItem.id, FeedbackItem.summary).where(FeedbackItem.id.in_(fids))
            )
        ).all()
    )
    out.notes = data.get("notes") or ""
    out.skipped = [SkippedSection.model_validate(x) for x in data.get("skipped") or []]
    out.sections = [
        NextDraftSection(
            section_key=s["section_key"],
            heading=s["heading"],
            before_heading=s["before"]["heading"],
            before_body_md=s["before"]["body_md"],
            body_md=s["body_md"],
            words=s.get("preview") or [],
            notes=s.get("notes") or "",
            o1c_fixes=s.get("o1c_fixes") or [],
            data_points=s.get("data_points") or [],
            resolutions=s.get("resolutions") or [],
            suggestion_ids=s.get("suggestion_ids") or [],
            feedback=[
                NextDraftFeedback(
                    id=r["feedback_id"], summary=summaries.get(uuid.UUID(r["feedback_id"]), "")
                )
                for r in s.get("resolutions") or []
            ],
        )
        for s in data.get("sections") or []
    ]
    return out


# --- apply and discard --------------------------------------------------------------------


async def apply(
    db: AsyncSession,
    principal: "Principal",
    doc: str,
    job_id: uuid.UUID,
    drop_sections: list[str],
    edits: dict[str, str],
) -> VersionOut:
    """Import exactly one new version: the latest with every kept section replaced."""
    document = await get_document(db, doc)
    job = await _job(db, document, job_id, lock=True)
    if _discarded(job):
        raise JobError(409, "this next draft was discarded; build it again")
    if _applied(job):
        raise JobError(409, f"already applied as version {_applied(job)}")
    if job.status != "succeeded" or not job.output:
        raise JobError(409, "only a finished next-draft build can be applied")
    out = job.output
    base = await db.scalar(
        select(DocumentVersion).where(
            DocumentVersion.document_id == document.id,
            DocumentVersion.number == int(out["base_version"]),
        )
    )
    if base is None or base.number != await latest_number(db, document.id):
        raise JobError(409, "a newer version exists since this draft was built; build it again")
    built = {s["section_key"]: s for s in out.get("sections") or []}
    unknown = sorted((set(drop_sections) | set(edits)) - set(built))
    if unknown:
        raise JobError(422, f"not in this draft: {', '.join(unknown)}")
    kept = [k for k in built if k not in set(drop_sections)]
    if not kept:
        raise JobError(422, "keep at least one section, or discard the draft")
    bad_edits = sorted(k for k in edits if k not in kept)
    if bad_edits:
        raise JobError(422, f"edits for dropped section(s): {', '.join(bad_edits)}")
    sections = await _sections(db, base)
    by_key = {s.section_key: s for s in sections}
    missing = [k for k in kept if k not in by_key]
    if missing:
        raise JobError(409, f"section(s) {', '.join(missing)} are no longer in the latest version")
    locked = await locked_section_keys(db, base.id)
    hit = [by_key[k] for k in kept if k in locked]
    if hit:
        named = ", ".join(f"{s.heading} ({s.section_key})" for s in hit)
        raise JobError(409, f"approved and locked since the build, never changed: {named}")

    # A suggestion dismissed (or no longer staged) since the build is not applied, and a
    # section whose every suggestion left staging is dropped from the new version.
    wanted = [uuid.UUID(i) for k in kept for i in built[k].get("suggestion_ids") or []]
    used = list(
        await db.scalars(
            select(LlmSuggestion).where(
                LlmSuggestion.id.in_(wanted), LlmSuggestion.status == "accepted"
            )
        )
    )
    still = {str(u.id) for u in used}
    kept = [
        k
        for k in kept
        if not built[k].get("suggestion_ids") or set(built[k]["suggestion_ids"]) & still
    ]
    if not kept:
        raise JobError(409, "every suggestion in this draft was dismissed since the build")
    used = [u for u in used if any(str(u.id) in built[k].get("suggestion_ids", []) for k in kept)]

    replace: dict[str, tuple[str, str]] = {}
    for k in kept:
        s = built[k]
        body = prompting.clean_body(edits[k], s["heading"]).text if k in edits else s["body_md"]
        replace[k] = (s["heading"], body)
    placed = False
    sources = next((s for s in sections if _is_sources(s)), None)
    additions = [
        f"#### Data points for {replace[k][0]}\n\n{_data_point_lines(built[k]['data_points'])}"
        for k in kept
        if built[k].get("data_points")
    ]
    if additions and sources is not None and sources.section_key not in locked:
        heading, body = replace.get(sources.section_key, (sources.heading, sources.body_md))
        joined = "\n\n".join(additions)
        replace[sources.section_key] = (heading, f"{body.rstrip()}\n\n{joined}".strip())
        placed = True

    live = {str(u.feedback_item_id) for u in used}
    resolutions = [
        r for k in kept for r in built[k].get("resolutions") or [] if r["feedback_id"] in live
    ]
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
    known = {r["feedback_id"] for r in resolutions}
    for d in dupes:
        if str(d.feedback_item_id) not in known:
            resolutions.append(
                {
                    "feedback_id": str(d.feedback_item_id),
                    "status": "addressed",
                    "note": "Addressed with the item it duplicates",
                }
            )
    open_items = set(
        await db.scalars(
            select(FeedbackItem.id).where(
                FeedbackItem.document_id == document.id, FeedbackItem.status == "open"
            )
        )
    )
    resolutions = [r for r in resolutions if uuid.UUID(r["feedback_id"]) in open_items]
    markdown = compose_markdown(base.front_matter, sections, replace, resolutions)
    try:
        result = await docs_service.import_draft(db, document.slug, markdown, principal)
    except docs_service.DraftError as e:
        await db.rollback()
        raise JobError(422, f"the next draft does not import: {e}") from e
    except docs_service.ImportConflictError as e:
        raise JobError(409, str(e)) from e
    if not result.created:
        raise JobError(409, "the next draft is identical to an existing version")
    number = result.version.number
    job = await db.get(LlmJob, job_id)
    job.output = {
        **job.output,
        "applied_version": number,
        "applied_by": str(principal.id),
        "applied_sections": kept,
        "dropped_sections": [k for k in built if k not in kept],
        "edited_sections": sorted(edits),
        "data_points_placed": placed,
    }
    for s in [*used, *dupes]:
        s.status = "applied"
        s.applied_in_version = number
    await audit.record(
        db,
        principal,
        "next_draft.apply",
        "llm_job",
        job.id,
        {
            "version": number,
            "sections": kept,
            "dropped": [k for k in built if k not in kept],
            "resolutions": len(resolutions),
        },
    )
    await on_version_imported(db, document.id, number, principal)
    await db.commit()
    return result.version


async def discard(db: AsyncSession, principal: "Principal", doc: str, job_id: uuid.UUID) -> LlmJob:
    """Drop a build: a queued or running one is cancelled; a finished one is set aside.
    Every staged suggestion stays staged."""
    document = await get_document(db, doc)
    job = await _job(db, document, job_id, lock=True)
    if _applied(job):
        raise JobError(409, f"already applied as version {_applied(job)}")
    if job.status == "cancelled" or _discarded(job):
        raise JobError(409, "this next draft was already discarded")
    before = job.status
    if job.status in ("queued", "running"):
        job.status = "cancelled"
        job.finished_at = _now()
    else:
        job.output = {
            **(job.output or {}),
            "discarded_at": _now().isoformat(),
            "discarded_by": str(principal.id),
        }
    await db.flush()
    await audit.record(db, principal, "next_draft.discard", "llm_job", job.id, {"from": before})
    return job
