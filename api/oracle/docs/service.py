"""Document import, reads and diff. The caller (router) owns the HTTP layer.

Import runs in one transaction: parse -> find or create the document -> dedupe by
content hash -> write version, sections, citations -> locked-section warning ->
apply resolutions -> audit -> commit.
"""

import uuid
from dataclasses import dataclass

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.auth.deps import Principal
from oracle.docs.diff import diff_sections
from oracle.docs.models import Citation, Document, DocumentVersion, Section
from oracle.docs.parser import DraftError, ParsedDraft, is_uuid, parse_draft
from oracle.docs.schemas import (
    CitationOut,
    DiffOut,
    DocumentOut,
    DocumentSummary,
    ImportProblem,
    SectionOut,
    SectionVerdict,
    VersionOut,
    VersionSummary,
    VersionWarning,
)
from oracle.review import service as review_service
from oracle.review.models import SectionReview


class NotFoundError(LookupError):
    pass


class ImportConflictError(RuntimeError):
    """A concurrent import won the race for the version number or slug."""


@dataclass
class ImportResult:
    version: VersionOut
    created: bool


async def find_document(db: AsyncSession, doc: str, *, for_update: bool = False) -> Document | None:
    """Look a document up by id (when ``doc`` is a uuid) or slug."""
    column = Document.id if is_uuid(doc) else Document.slug
    stmt = select(Document).where(column == (uuid.UUID(doc) if is_uuid(doc) else doc))
    if for_update:
        stmt = stmt.with_for_update()
    return await db.scalar(stmt)


async def get_document_or_404(db: AsyncSession, doc: str) -> Document:
    document = await find_document(db, doc)
    if document is None:
        raise NotFoundError(f"document '{doc}' not found")
    return document


async def get_version_row(db: AsyncSession, document: Document, number: int) -> DocumentVersion:
    version = await db.scalar(
        select(DocumentVersion).where(
            DocumentVersion.document_id == document.id, DocumentVersion.number == number
        )
    )
    if version is None:
        raise NotFoundError(f"version {number} of '{document.slug}' not found")
    return version


async def _latest_numbers(db: AsyncSession, ids: list[uuid.UUID]) -> dict[uuid.UUID, int]:
    if not ids:
        return {}
    rows = await db.execute(
        select(DocumentVersion.document_id, func.max(DocumentVersion.number))
        .where(DocumentVersion.document_id.in_(ids))
        .group_by(DocumentVersion.document_id)
    )
    return dict(rows.all())


def _summary(document: Document, latest: int | None) -> dict:
    return {
        **DocumentSummary.model_validate(document).model_dump(exclude={"latest_version"}),
        "latest_version": latest,
    }


async def list_documents(db: AsyncSession) -> list[DocumentSummary]:
    documents = list(await db.scalars(select(Document).order_by(Document.updated_at.desc())))
    latest = await _latest_numbers(db, [d.id for d in documents])
    return [DocumentSummary(**_summary(d, latest.get(d.id))) for d in documents]


async def list_versions(db: AsyncSession, document: Document) -> list[VersionSummary]:
    rows = await db.scalars(
        select(DocumentVersion)
        .where(DocumentVersion.document_id == document.id)
        .order_by(DocumentVersion.number)
    )
    return [VersionSummary.model_validate(v) for v in rows]


async def read_document(db: AsyncSession, doc: str) -> DocumentOut:
    document = await get_document_or_404(db, doc)
    versions = await list_versions(db, document)
    latest = versions[-1].number if versions else None
    return DocumentOut(**_summary(document, latest), versions=versions)


async def _latest_verdicts(db: AsyncSession, version_id: uuid.UUID) -> dict[str, SectionVerdict]:
    rows = await db.scalars(
        select(SectionReview)
        .where(SectionReview.version_id == version_id)
        .order_by(SectionReview.created_at, SectionReview.id)
    )
    return {r.section_key: SectionVerdict.model_validate(r) for r in rows}


async def read_version(db: AsyncSession, version: DocumentVersion) -> VersionOut:
    sections = list(
        await db.scalars(
            select(Section).where(Section.version_id == version.id).order_by(Section.ordinal)
        )
    )
    citations = list(
        await db.scalars(
            select(Citation).where(Citation.version_id == version.id).order_by(Citation.cite_key)
        )
    )
    verdicts = await _latest_verdicts(db, version.id)
    return VersionOut(
        **VersionSummary.model_validate(version).model_dump(),
        front_matter=version.front_matter,
        sections=[
            SectionOut.model_validate(s).model_copy(update={"verdict": verdicts.get(s.section_key)})
            for s in sections
        ],
        citations=[CitationOut.model_validate(c) for c in citations],
    )


def _document_mismatch(slug: str, draft: ParsedDraft) -> DraftError:
    return DraftError(
        [
            ImportProblem(
                code="document_mismatch",
                message=f"front matter document '{draft.document}' does not match "
                f"the target document '{slug}'",
            )
        ]
    )


async def import_draft(
    db: AsyncSession, doc: str, markdown: str, principal: Principal
) -> ImportResult:
    """Import a draft as the next version of ``doc``.

    Raises :class:`DraftError` (422), :class:`NotFoundError` (404, ``doc`` is an
    unknown id) or :class:`ImportConflictError` (409, lost a concurrent import race).
    """
    draft = parse_draft(markdown)

    document = await find_document(db, doc, for_update=True)
    if document is None:
        if is_uuid(doc):
            raise NotFoundError(f"document '{doc}' not found")
        if draft.document is not None and draft.document != doc:
            raise _document_mismatch(doc, draft)
        document = Document(
            slug=doc,
            title=draft.title,
            status="draft",
            template=draft.template,
            template_version=draft.template_version,
        )
        db.add(document)
        try:
            await db.flush()
        except IntegrityError as exc:
            await db.rollback()
            raise ImportConflictError(f"document '{doc}' was created concurrently") from exc
        previous = None
    else:
        if draft.document is not None and draft.document != document.slug:
            raise _document_mismatch(document.slug, draft)
        existing = await db.scalar(
            select(DocumentVersion).where(
                DocumentVersion.document_id == document.id,
                DocumentVersion.content_hash == draft.content_hash,
            )
        )
        if existing is not None:
            return ImportResult(version=await read_version(db, existing), created=False)
        previous = await db.scalar(
            select(DocumentVersion)
            .where(DocumentVersion.document_id == document.id)
            .order_by(DocumentVersion.number.desc())
            .limit(1)
        )

    warnings: list[VersionWarning] = []
    if previous is not None:
        locked = await review_service.locked_section_keys(db, previous.id)
        if locked:
            before = dict(
                (
                    await db.execute(
                        select(Section.section_key, Section.content_hash).where(
                            Section.version_id == previous.id,
                            Section.section_key.in_(locked),
                        )
                    )
                ).all()
            )
            now = {s.section_key: s.content_hash for s in draft.sections}
            changed = sorted(k for k in locked if k in before and now.get(k) != before[k])
            if changed:
                warnings.append(
                    VersionWarning(
                        code="locked_section_changed",
                        message="sections approved in version "
                        f"{previous.number} changed: {', '.join(changed)}",
                        section_keys=changed,
                    )
                )

    version = DocumentVersion(
        document_id=document.id,
        number=(previous.number + 1) if previous else 1,
        markdown=draft.markdown,
        content_hash=draft.content_hash,
        front_matter=draft.front_matter,
        snapshot=draft.snapshot,
        warnings=[w.model_dump() for w in warnings],
        imported_by=principal.id,
    )
    db.add(version)
    try:
        await db.flush()
    except IntegrityError as exc:
        await db.rollback()
        raise ImportConflictError("another version was imported concurrently") from exc

    db.add_all(
        Section(
            version_id=version.id,
            section_key=s.section_key,
            ordinal=s.ordinal,
            level=s.level,
            heading=s.heading,
            body_md=s.body_md,
            body_text=s.body_text,
            content_hash=s.content_hash,
            citation_keys=s.citation_keys,
        )
        for s in draft.sections
    )
    db.add_all(
        Citation(
            version_id=version.id,
            cite_key=c.id,
            source=c.source,
            ref=c.ref,
            title=c.title,
            excerpt=c.excerpt,
            retrieved_at=c.retrieved_at,
        )
        for c in draft.citations
    )
    await db.flush()

    try:
        await review_service.apply_resolutions(db, document.id, version.id, draft.resolutions)
    except review_service.UnknownFeedbackItemsError as exc:
        await db.rollback()
        raise DraftError(
            [
                ImportProblem(
                    code="unknown_feedback_item",
                    message=f"resolution references unknown feedback item {fid}",
                )
                for fid in exc.feedback_ids
            ]
        ) from exc

    document.title = draft.title
    document.template = draft.template
    document.template_version = draft.template_version
    if document.status == "approved":
        # A newer, unapproved version now exists.
        document.status = "in_review"

    await audit.record(
        db,
        principal,
        "document.version_imported",
        "document_version",
        version.id,
        {
            "document_id": str(document.id),
            "number": version.number,
            "content_hash": version.content_hash,
            "resolutions": len(draft.resolutions),
            "warnings": [w.code for w in warnings],
        },
    )
    await db.commit()
    return ImportResult(version=await read_version(db, version), created=True)


async def diff(db: AsyncSession, doc: str, from_number: int, to_number: int) -> DiffOut:
    document = await get_document_or_404(db, doc)
    old = await get_version_row(db, document, from_number)
    new = await get_version_row(db, document, to_number)
    rows = await db.scalars(
        select(Section).where(Section.version_id.in_([old.id, new.id])).order_by(Section.ordinal)
    )
    old_sections, new_sections = [], []
    for s in rows:
        (old_sections if s.version_id == old.id else new_sections).append(s)
    if old.id == new.id:
        new_sections = old_sections
    return DiffOut(
        document_id=document.id,
        from_version=from_number,
        to_version=to_number,
        sections=diff_sections(old_sections, new_sections),
    )
