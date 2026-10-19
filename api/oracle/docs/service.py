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
from oracle.docs import layers
from oracle.docs.diff import diff_sections
from oracle.docs.models import DOCUMENT_KINDS, Citation, Document, DocumentVersion, Section
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
    VersionSource,
    VersionSummary,
    VersionWarning,
)
from oracle.review import service as review_service
from oracle.review.models import SectionReview
from oracle.templates.builtins import BUILTIN_TEMPLATES_BY_KEY
from oracle.templates.models import Template, TemplateVersion


class NotFoundError(LookupError):
    pass


class ImportConflictError(RuntimeError):
    """A concurrent import won the race for the version number or slug."""


class BaseVersionConflictError(ImportConflictError):
    """The draft was written on an older version than the latest, and saving it would
    overwrite sections changed since (409, never a silent last write).

    ``sections``: one dict per conflicting section with ``section_key``,
    ``base_revision``, ``current_revision``, ``your_revision``, ``current_heading`` and
    ``current_body_md``.
    """

    def __init__(
        self,
        base: int,
        latest: int,
        sections: list[dict],
        *,
        code: str = "version_conflict",
        message: str | None = None,
    ):
        self.base = base
        self.latest = latest
        self.sections = sections
        self.code = code
        keys = ", ".join(s["section_key"] for s in sections)
        super().__init__(
            message
            or f"the draft is based on version {base}, but version {latest} is the latest "
            f"and changed {keys} since; merge version {latest} and push again"
        )


# Why a version's sections changed, recorded on each change event (oracle.changes).
IMPORT_CAUSES = ("draft_imported", "section_edited", "patch_accepted", "run_draft")


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


async def _approved_numbers(db: AsyncSession, ids: list[uuid.UUID]) -> dict[uuid.UUID, int]:
    if not ids:
        return {}
    rows = await db.execute(
        select(DocumentVersion.document_id, func.max(DocumentVersion.number))
        .where(DocumentVersion.document_id.in_(ids), DocumentVersion.approved_at.is_not(None))
        .group_by(DocumentVersion.document_id)
    )
    return dict(rows.all())


async def version_sources(
    db: AsyncSession, source_ids: list[uuid.UUID | None]
) -> dict[uuid.UUID, VersionSource]:
    """Provenance by source version id: the document and version each one is."""
    ids = {i for i in source_ids if i is not None}
    if not ids:
        return {}
    rows = await db.execute(
        select(DocumentVersion, Document)
        .join(Document, Document.id == DocumentVersion.document_id)
        .where(DocumentVersion.id.in_(ids))
    )
    return {
        v.id: VersionSource(
            document_id=d.id,
            slug=d.slug,
            title=d.title,
            kind=d.kind,  # type: ignore[arg-type]
            version=v.number,
            version_id=v.id,
            approved_at=v.approved_at,
        )
        for v, d in rows.all()
    }


def _summary(
    document: Document,
    latest: int | None,
    approved: int | None = None,
    source: VersionSource | None = None,
) -> dict:
    return {
        **DocumentSummary.model_validate(document).model_dump(
            exclude={"latest_version", "approved_version", "source"}
        ),
        "latest_version": latest,
        "approved_version": approved,
        "source": source,
    }


async def list_documents(db: AsyncSession, kind: str | None = None) -> list[DocumentSummary]:
    stmt = select(Document).order_by(Document.updated_at.desc())
    if kind:
        stmt = stmt.where(Document.kind == kind)
    documents = list(await db.scalars(stmt))
    ids = [d.id for d in documents]
    latest = await _latest_numbers(db, ids)
    approved = await _approved_numbers(db, ids)
    # The latest version's provenance.
    latest_sources: dict[uuid.UUID, uuid.UUID | None] = {}
    if latest:
        rows = await db.execute(
            select(DocumentVersion.document_id, DocumentVersion.source_version_id)
            .where(
                DocumentVersion.document_id.in_(ids),
                DocumentVersion.source_version_id.is_not(None),
            )
            .order_by(DocumentVersion.number)
        )
        for doc_id, source_id in rows.all():
            latest_sources[doc_id] = source_id
    sources = await version_sources(db, list(latest_sources.values()))
    return [
        DocumentSummary(
            **_summary(
                d,
                latest.get(d.id),
                approved.get(d.id),
                sources.get(latest_sources.get(d.id)),  # type: ignore[arg-type]
            )
        )
        for d in documents
    ]


async def list_versions(db: AsyncSession, document: Document) -> list[VersionSummary]:
    rows = list(
        await db.scalars(
            select(DocumentVersion)
            .where(DocumentVersion.document_id == document.id)
            .order_by(DocumentVersion.number)
        )
    )
    sources = await version_sources(db, [v.source_version_id for v in rows])
    return [
        VersionSummary.model_validate(v).model_copy(
            update={"source": sources.get(v.source_version_id)}  # type: ignore[arg-type]
        )
        for v in rows
    ]


async def read_document(db: AsyncSession, doc: str) -> DocumentOut:
    document = await get_document_or_404(db, doc)
    versions = await list_versions(db, document)
    latest = versions[-1] if versions else None
    approved = max((v.number for v in versions if v.approved_at), default=None)
    return DocumentOut(
        **_summary(
            document, latest.number if latest else None, approved, latest.source if latest else None
        ),
        versions=versions,
    )


async def _latest_verdicts(db: AsyncSession, version_id: uuid.UUID) -> dict[str, SectionVerdict]:
    rows = await db.scalars(
        select(SectionReview)
        .where(SectionReview.version_id == version_id)
        .order_by(SectionReview.created_at, SectionReview.id)
    )
    return {r.section_key: SectionVerdict.model_validate(r) for r in rows}


async def template_body(
    db: AsyncSession, template: str | None, template_version: str | None
) -> str | None:
    """The body of a template version a draft names, if it exists (archived too)."""
    if not template or not template_version or not template_version.isdigit():
        return None
    return await db.scalar(
        select(TemplateVersion.body)
        .join(Template, Template.id == TemplateVersion.template_id)
        .where(Template.key == template, TemplateVersion.version == int(template_version))
    )


def _template_meta(body: str):
    # Cached per body (versions are immutable); imported late: templates imports docs.
    from oracle.templates.service import version_meta

    return version_meta(body)


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
    source = (await version_sources(db, [version.source_version_id])).get(
        version.source_version_id  # type: ignore[arg-type]
    )
    return VersionOut(
        **VersionSummary.model_validate(version).model_dump(exclude={"source"}),
        source=source,
        front_matter=version.front_matter,
        sections=[
            SectionOut.model_validate(s).model_copy(
                update={
                    "verdict": verdicts.get(s.section_key),
                    # O1g: computed on read, so every version follows the same rule.
                    "notes": layers.presenter_notes(s.body_md) if s.layer == "brief" else None,
                }
            )
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


def _kind_mismatch(slug: str, kind: str, expected: str) -> DraftError:
    return DraftError(
        [
            ImportProblem(
                code="kind_mismatch",
                message=f"document '{slug}' is a {kind}, not a {expected}",
            )
        ]
    )


async def _draft_kind(db: AsyncSession, draft: ParsedDraft) -> str | None:
    """The kind a draft says it is: its front matter's ``kind``, else its template's."""
    named = draft.front_matter.get("kind")
    if named in DOCUMENT_KINDS:
        return named
    if draft.template:
        stored = await db.scalar(select(Template.kind).where(Template.key == draft.template))
        builtin = BUILTIN_TEMPLATES_BY_KEY.get(draft.template)
        return stored or (builtin.kind if builtin else None)
    return None


async def import_draft(
    db: AsyncSession,
    doc: str,
    markdown: str,
    principal: Principal,
    *,
    kind: str | None = None,
    theme: str | None = None,
    template: tuple[str, str] | None = None,
    source_version_id: uuid.UUID | None = None,
    base_version: int | None = None,
    cause: str = "draft_imported",
    origin: str = "person",
    run_id: uuid.UUID | None = None,
) -> ImportResult:
    """Import a draft as the next version of ``doc``.

    ``kind`` (a run's target kind) is the kind of a document the import creates, and an
    existing document must be of it; without it a new document takes the front matter's
    ``kind`` (prd by default). ``theme`` is a new document's theme; ``template`` (key,
    version) is the document's template when the draft names none. ``source_version_id``
    is the version's provenance (a roadmap's PRD version).

    ``base_version`` is the version the draft was written on (stored as
    ``base_number``). When it is older than the latest version, every section changed
    since must already be in the draft as the latest has it; otherwise the import is a
    :class:`BaseVersionConflictError` naming both versions and the sections.

    ``cause`` goes on the ``document_section`` change event of every section whose
    revision changed (``oracle.changes``; review invalidates their approvals, trace
    marks what depends on them). ``origin="run"`` (an agent's draft) never replaces an
    approved section: the section keeps its approved text and the agent's text waits
    as a section patch, reviewed as a diff (§9).

    Raises :class:`DraftError` (422), :class:`NotFoundError` (404, ``doc`` is an
    unknown id) or :class:`ImportConflictError` (409, lost a concurrent import race,
    or a base version conflict).
    """
    draft = parse_draft(markdown)
    if draft.template is None and template is not None:
        draft.template, draft.template_version = template
    held: dict[str, tuple[str, str]] = {}

    document = await find_document(db, doc, for_update=True)
    if document is None:
        if is_uuid(doc):
            raise NotFoundError(f"document '{doc}' not found")
        if draft.document is not None and draft.document != doc:
            raise _document_mismatch(doc, draft)
        # The same kind the check on an existing document reads: the run's, else the
        # draft's front matter kind, else its template's.
        document = Document(
            slug=doc,
            title=draft.title,
            status="draft",
            kind=kind or await _draft_kind(db, draft) or "prd",
            template=draft.template,
            template_version=draft.template_version,
            theme=theme,
        )
        db.add(document)
        try:
            await db.flush()
        except IntegrityError as exc:
            await db.rollback()
            raise ImportConflictError(f"document '{doc}' was created concurrently") from exc
        previous = None
        if base_version is not None:
            raise _unknown_base(base_version, None)
    else:
        if draft.document is not None and draft.document != document.slug:
            raise _document_mismatch(document.slug, draft)
        if kind is not None and document.kind != kind:
            raise _kind_mismatch(document.slug, document.kind, kind)
        draft_kind = await _draft_kind(db, draft)
        if draft_kind is not None and draft_kind != document.kind:
            raise _kind_mismatch(document.slug, document.kind, draft_kind)
        previous = await db.scalar(
            select(DocumentVersion)
            .where(DocumentVersion.document_id == document.id)
            .order_by(DocumentVersion.number.desc())
            .limit(1)
        )
        if origin == "run" and previous is not None:
            draft, held = await _hold_approved_sections(db, document, previous, draft)
        existing = await db.scalar(
            select(DocumentVersion).where(
                DocumentVersion.document_id == document.id,
                DocumentVersion.content_hash == draft.content_hash,
            )
        )
        if existing is not None:
            return ImportResult(version=await read_version(db, existing), created=False)
        if base_version is not None and previous is not None:
            await _check_base(db, document, previous, base_version, draft)

    warnings: list[VersionWarning] = []
    if held:
        warnings.append(
            VersionWarning(
                code="approved_section_held",
                message="approved sections keep their approved text; the draft's changes "
                f"wait as section patches for review: {', '.join(sorted(held))}",
                section_keys=sorted(held),
            )
        )
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

    # O1f: the brief layer, from the draft, else its template's markers, else a
    # "Full version" heading.
    template_brief = None
    if draft.brief is None:
        named = (
            (draft.template, draft.template_version)
            if draft.template
            else (document.template, document.template_version)
        )
        body = await template_body(db, *named)
        template_brief = _template_meta(body).marked_brief if body else None
    brief, brief_source = layers.resolve_brief(
        [layers.SectionRef(s.section_key, s.level) for s in draft.sections],
        draft_brief=draft.brief,
        template_brief=template_brief,
    )
    layer_of = layers.layers((s.section_key for s in draft.sections), brief)

    version = DocumentVersion(
        document_id=document.id,
        number=(previous.number + 1) if previous else 1,
        markdown=draft.markdown,
        content_hash=draft.content_hash,
        front_matter=draft.front_matter,
        snapshot=draft.snapshot,
        warnings=[w.model_dump() for w in warnings],
        imported_by=principal.id,
        brief_source=brief_source,
        source_version_id=source_version_id,
        base_number=base_version,
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
            layer=layer_of[s.section_key],
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

    from oracle.review import patches, state

    await state.record_section_changes(
        db,
        principal,
        document,
        previous,
        version,
        {s.section_key: s.content_hash for s in draft.sections},
        cause,
    )
    if held:
        await patches.propose_held(
            db, principal, document, version, held, origin=origin, run_id=run_id
        )

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
            "brief_source": brief_source,
            **({"source_version_id": str(source_version_id)} if source_version_id else {}),
            **({"base_version": base_version} if base_version is not None else {}),
            **({"cause": cause} if cause != "draft_imported" else {}),
            **({"held_sections": sorted(held)} if held else {}),
        },
    )
    await db.commit()
    return ImportResult(version=await read_version(db, version), created=True)


def _unknown_base(base: int, latest: int | None) -> DraftError:
    where = f"the latest is {latest}" if latest is not None else "the document has none"
    return DraftError(
        [
            ImportProblem(
                code="unknown_base_version",
                message=f"base version {base} does not exist ({where})",
            )
        ]
    )


async def _section_rows(db: AsyncSession, version_id: uuid.UUID) -> dict[str, Section]:
    rows = await db.scalars(select(Section).where(Section.version_id == version_id))
    return {s.section_key: s for s in rows}


async def _check_base(
    db: AsyncSession,
    document: Document,
    latest: DocumentVersion,
    base_number: int,
    draft: ParsedDraft,
) -> None:
    """Refuse a draft on an older base that would overwrite what changed since.

    A section conflicts when it changed between the base and the latest version and
    the draft does not already have the latest text: either both sides changed it, or
    the draft still has the base text and would silently revert the newer change.
    """
    if base_number < 1 or base_number > latest.number:
        raise _unknown_base(base_number, latest.number)
    if base_number == latest.number:
        return
    base = await get_version_row(db, document, base_number)
    base_sections = await _section_rows(db, base.id)
    current = await _section_rows(db, latest.id)
    mine = {s.section_key: s.content_hash for s in draft.sections}
    conflicts = []
    for key in dict.fromkeys([*base_sections, *current]):
        before = base_sections.get(key)
        now = current.get(key)
        before_hash = before.content_hash if before else None
        now_hash = now.content_hash if now else None
        if before_hash == now_hash or mine.get(key) == now_hash:
            continue
        conflicts.append(
            {
                "section_key": key,
                "base_revision": before_hash,
                "current_revision": now_hash,
                "your_revision": mine.get(key),
                "current_heading": now.heading if now else None,
                "current_body_md": now.body_md if now else None,
            }
        )
    if conflicts:
        raise BaseVersionConflictError(base_number, latest.number, conflicts)


async def _hold_approved_sections(
    db: AsyncSession, document: Document, previous: DocumentVersion, draft: ParsedDraft
) -> tuple[ParsedDraft, dict[str, tuple[str, str]]]:
    """An agent's draft keeps every approved section's approved text (§9).

    Returns the draft to import and, per held section, the agent's (heading, body_md),
    which becomes a section patch.
    """
    from oracle.jobs.service import compose_markdown
    from oracle.review.state import approved_keys

    approved = await approved_keys(db, document.id, previous)
    if not approved:
        return draft, {}
    old = await _section_rows(db, previous.id)
    held = {
        s.section_key: (s.heading, s.body_md)
        for s in draft.sections
        if s.section_key in approved and s.content_hash != old[s.section_key].content_hash
    }
    if not held:
        return draft, {}
    sections = [old[s.section_key] if s.section_key in held else s for s in draft.sections]
    front_matter = dict(draft.front_matter)
    # The approved text may cite sources the agent's draft dropped: keep them.
    cited = {k for key in held for k in old[key].citation_keys}
    known = {c.get("id") for c in front_matter.get("citations") or [] if isinstance(c, dict)}
    missing = cited - known
    if missing:
        rows = await db.scalars(
            select(Citation).where(
                Citation.version_id == previous.id, Citation.cite_key.in_(missing)
            )
        )
        extra = [
            {
                "id": c.cite_key,
                "source": c.source,
                "ref": c.ref,
                **({"title": c.title} if c.title else {}),
                **({"excerpt": c.excerpt} if c.excerpt else {}),
                **({"retrieved_at": c.retrieved_at.isoformat()} if c.retrieved_at else {}),
            }
            for c in rows
        ]
        front_matter["citations"] = [*(front_matter.get("citations") or []), *extra]
    markdown = compose_markdown(
        front_matter, sections, {}, list(draft.front_matter.get("resolutions") or [])
    )
    return parse_draft(markdown), held


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
