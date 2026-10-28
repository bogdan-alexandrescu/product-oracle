"""Document import, reads and diff. The caller (router) owns the HTTP layer.

Import runs in one transaction: parse -> find or create the document -> dedupe by
content hash -> write version, sections, citations -> locked-section warning ->
apply resolutions -> audit -> commit.
"""

import re
import uuid
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Literal

from sqlalchemy import func, select, tuple_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, changes, company_time, safe_yaml, webhooks, wording
from oracle.auth.deps import Principal
from oracle.auth.models import ApiToken, User
from oracle.docs import layers, named_codes
from oracle.docs.diff import diff_sections
from oracle.docs.models import DOCUMENT_KINDS, Citation, Document, DocumentVersion, Section
from oracle.docs.parser import (
    CitationIn,
    DraftError,
    ParsedDraft,
    cited_entries,
    is_uuid,
    parse_draft,
    parse_draft_async,
    section_revision,
)
from oracle.docs.schemas import (
    CitationOut,
    DiffOut,
    DocumentOut,
    DocumentSummary,
    ImportProblem,
    SectionOut,
    SectionVerdict,
    SpecPartState,
    VersionOut,
    VersionSource,
    VersionSummary,
    VersionWarning,
)
from oracle.docs.visibility import default_for as default_visibility
from oracle.members.names import display_name
from oracle.models import AuditEvent
from oracle.review import service as review_service
from oracle.review.models import SectionReview
from oracle.review.schemas import Resolution
from oracle.sources.models import SourceItem
from oracle.templates.builtins import BUILTIN_TEMPLATES_BY_KEY
from oracle.templates.models import Template, TemplateVersion


class NotFoundError(LookupError):
    pass


class VisibilityKindError(ValueError):
    """Only an update's visibility changes (H8): every other document stays company-wide."""


class ImportConflictError(RuntimeError):
    """A concurrent import won the race for the version number or slug."""


class SlugTakenError(ImportConflictError):
    """A run's import of the document it was to create (``run_creates``): the slug names
    a document none of the run's versions is in, which the run's draft is not added to."""


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
        front_matter_changed: bool = False,
    ):
        self.base = base
        self.latest = latest
        self.sections = sections
        self.code = code
        self.front_matter_changed = front_matter_changed
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
    # The draft's resolutions as parsed (all of them, applied or not): a caller reads them
    # here rather than parse the draft again on the event loop.
    resolutions: list[Resolution] = field(default_factory=list)


@dataclass(frozen=True)
class DraftDates:
    """The dates a roadmap draft's import found (``ref``: the day year-less dates were read
    against), kept for the version it stores."""

    ref: date
    found: tuple[Any, ...]


async def find_document(db: AsyncSession, doc: str, *, for_update: bool = False) -> Document | None:
    """Look a document up by id (when ``doc`` is a uuid) or slug."""
    column = Document.id if is_uuid(doc) else Document.slug
    stmt = select(Document).where(column == (uuid.UUID(doc) if is_uuid(doc) else doc))
    if for_update:
        stmt = stmt.with_for_update()
    return await db.scalar(stmt)


async def run_imported_into(db: AsyncSession, document_id: uuid.UUID, run_id: uuid.UUID) -> bool:
    """Whether a version of the document was imported for the run (its import is audited
    with the run's id: the run's own push_draft, or its import at segment end)."""
    found = await db.scalar(
        select(AuditEvent.id)
        .where(
            AuditEvent.action == "document.version_imported",
            AuditEvent.data["document_id"].astext == str(document_id),
            AuditEvent.data["run_id"].astext == str(run_id),
        )
        .limit(1)
    )
    return found is not None


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
    period: dict | None = None,
) -> dict:
    return {
        **DocumentSummary.model_validate(document).model_dump(
            exclude={"latest_version", "approved_version", "source", "period"}
        ),
        "latest_version": latest,
        "approved_version": approved,
        "source": source,
        "period": period,
    }


async def _update_periods(db: AsyncSession, documents: list[Document]) -> dict[uuid.UUID, dict]:
    """H8: each update's period, from its latest version's front matter."""
    from oracle.updates.frontmatter import parse_period

    ids = [d.id for d in documents if d.kind == "update"]
    if not ids:
        return {}
    latest = (
        select(DocumentVersion.document_id, func.max(DocumentVersion.number).label("n"))
        .where(DocumentVersion.document_id.in_(ids))
        .group_by(DocumentVersion.document_id)
        .subquery()
    )
    rows = await db.execute(
        select(DocumentVersion.document_id, DocumentVersion.front_matter).join(
            latest,
            (DocumentVersion.document_id == latest.c.document_id)
            & (DocumentVersion.number == latest.c.n),
        )
    )
    out: dict[uuid.UUID, dict] = {}
    for doc_id, fm in rows.all():
        period = parse_period((fm or {}).get("period"))
        if period is not None:
            out[doc_id] = {"from": period[0], "to": period[1]}
    return out


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
    periods = await _update_periods(db, documents)
    return [
        DocumentSummary(
            **_summary(
                d,
                latest.get(d.id),
                approved.get(d.id),
                sources.get(latest_sources.get(d.id)),  # type: ignore[arg-type]
                periods.get(d.id),
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
    names = await importer_names(db, rows)
    again = await imported_again(db, document.id, rows)
    return [
        VersionSummary.model_validate(v).model_copy(
            update={
                "source": sources.get(v.source_version_id),  # type: ignore[arg-type]
                "imported_by_name": names.get(v.id),
                "imported_again": again.get(v.id),
            }
        )
        for v in rows
    ]


async def importer_names(db: AsyncSession, versions: list[DocumentVersion]) -> dict[uuid.UUID, str]:
    """Who imported each version, by name, keyed by version id (#256): "Oracle" for a
    run's draft (its import's audit event names the run; ``imported_by`` is the person
    the run acted for), else the member's display name or "API token <its name>"."""
    ids = {v.imported_by for v in versions if v.imported_by}
    people: dict[uuid.UUID, str] = {
        uid: display_name(email)
        for uid, email in (
            await db.execute(select(User.id, User.email).where(User.id.in_(ids)))
        ).all()
    }
    # An API token says what it is, not only its name (qa-docs-26): "API token release-bot".
    tokens: dict[uuid.UUID, str] = {
        tid: f"API token {name}"
        for tid, name in (
            await db.execute(
                select(ApiToken.id, ApiToken.name).where(ApiToken.id.in_(ids - set(people)))
            )
        ).all()
    }
    by_run = set(
        await db.scalars(
            select(AuditEvent.entity_id).where(
                AuditEvent.action == "document.version_imported",
                AuditEvent.entity_id.in_([v.id for v in versions]),
                AuditEvent.data.has_key("run_id"),
            )
        )
    )
    names = {**people, **tokens}
    out: dict[uuid.UUID, str] = {}
    for v in versions:
        if v.id in by_run:
            out[v.id] = "Oracle"
        elif v.imported_by in names:
            out[v.id] = names[v.imported_by]
    return out


async def imported_again(
    db: AsyncSession, document_id: uuid.UUID, versions: list[DocumentVersion]
) -> dict[uuid.UUID, str]:
    """Versions a person imported again from a run's refused draft (Retry import), keyed by
    version id: "imported again by <name> on <stamp>", the retry's audit event (its actor
    and time) in the Company time zone (owner, 2026-10-25)."""
    from oracle.company_time import company_time_zone, stamp

    numbers = {v.number: v.id for v in versions}
    events = [
        e
        for e in await db.scalars(
            select(AuditEvent)
            .where(
                AuditEvent.action == "run.draft_import_retried",
                AuditEvent.data["document_id"].astext == str(document_id),
            )
            .order_by(AuditEvent.created_at)
        )
        if (e.data or {}).get("version") in numbers
    ]
    if not events:
        return {}
    # The actor names a member or an API token by id, else Oracle or the system.
    ids = {
        uuid.UUID(e.actor.partition(":")[2])
        for e in events
        if e.actor.partition(":")[0] in ("user", "token")
    }
    people = {
        uid: display_name(email, name)
        for uid, email, name in (
            await db.execute(select(User.id, User.email, User.name).where(User.id.in_(ids)))
        ).all()
    }
    tokens = dict(
        (await db.execute(select(ApiToken.id, ApiToken.name).where(ApiToken.id.in_(ids)))).all()
    )
    zone = await company_time_zone(db)
    out: dict[uuid.UUID, str] = {}
    for e in events:
        who = e.actor.split(":", 1)[-1]
        try:
            name = people.get(uuid.UUID(who)) or tokens.get(uuid.UUID(who))
        except ValueError:
            # Not a member or a token: Oracle's or the system's own retry (#583 review).
            name = {audit.ORACLE: "Oracle", "system": "the system"}.get(e.actor)
        out[numbers[e.data["version"]]] = (
            f"imported again by {name or 'a former member'} on {stamp(e.created_at, zone)}"
        )
    return out


async def read_document(db: AsyncSession, doc: str) -> DocumentOut:
    from oracle.simple import drafts as simple_drafts

    document = await get_document_or_404(db, doc)
    versions = await list_versions(db, document)
    latest = versions[-1] if versions else None
    approved = max((v.number for v in versions if v.approved_at), default=None)
    return DocumentOut(
        **_summary(
            document,
            latest.number if latest else None,
            approved,
            latest.source if latest else None,
            (await _update_periods(db, [document])).get(document.id),
        ),
        versions=versions,
        changes_in_review=await simple_drafts.changes_in_review(db, document.id),
    )


async def set_visibility(
    db: AsyncSession, doc: str, visibility: str, reason: str, principal: Principal
) -> DocumentOut:
    """H8: an owner opens an update to the company, or back to owners and approvers, with
    a reason (audited ``document.visibility``, before and after). Any other kind is a
    :class:`VisibilityKindError`."""
    document = await find_document(db, doc, for_update=True)
    if document is None:
        raise NotFoundError(f"document '{doc}' not found")
    if document.kind not in ("update", "pricing"):
        raise VisibilityKindError(
            "Only an update or a pricing memo can be limited to owners and approvers; every "
            "other document is visible to the whole company"
        )
    before = document.visibility
    if before != visibility:
        document.visibility = visibility
        if visibility != "company":
            # O5: a document limited to owners and approvers is shared by no link.
            from oracle.shares import service as shares

            await shares.revoke_documents(db, principal, {document.id}, shares.DOCUMENT_LIMITED)
        await audit.record(
            db,
            principal,
            "document.visibility",
            "document",
            document.id,
            {"before": before, "after": visibility, "reason": reason},
        )
        await db.commit()
    return await read_document(db, str(document.id))


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


async def is_spec_version(db: AsyncSession, version: DocumentVersion) -> bool:
    document = await db.get(Document, version.document_id)
    return document is not None and document.kind == "spec"


async def _spec_states(
    db: AsyncSession, version: DocumentVersion, sections: list[Section]
) -> dict[str, list[SpecPartState]]:
    """E1: the state of each part of a spec version's sections (none for other kinds)."""
    if not await is_spec_version(db, version):
        return {}
    from oracle.specs import contract, lineage

    approved = await lineage.approach_approved(db, version)
    keys = contract.keys_of(version.front_matter)
    return {
        s.section_key: [
            SpecPartState(
                label=p.label,
                decided=p.decided,
                added=p.added,
                half=p.half,
                starts_at=contract.ACCEPTANCE_PROPOSED_LABEL if p.half == "proposed" else None,
            )
            for p in contract.part_states(s.section_key, s.body_md, approved, keys)
        ]
        for s in sections
        if s.section_key not in contract.UNLABELLED
    }


async def spec_markdown(db: AsyncSession, version: DocumentVersion) -> str:
    """A version's markdown as it is served (GET .../markdown, MCP get_document_markdown,
    the markdown export, the feedback package): a spec version's carries its state labels
    and names its added sources (E1). It fails closed: a spec version that can not carry
    its labels raises DraftError rather than being served without them."""
    if not await is_spec_version(db, version):
        return version.markdown
    from oracle.specs import contract, lineage

    # Off the event loop: the version's text is an edit's (oracle.safe_yaml).
    return await safe_yaml.run_parse(
        contract.label_markdown,
        version.markdown,
        await lineage.approach_approved(db, version),
        await lineage.oracle_citation_keys(db, version),
    )


async def _citations_out(
    db: AsyncSession, version: DocumentVersion, citations: list[Citation]
) -> list[CitationOut]:
    """A version's citations; a spec version's added in an edit carry ``added`` and the
    'Proposed · added in an edit' label (E1, owner, 2026-10-20)."""
    out = [CitationOut.model_validate(c) for c in citations]
    if not out or not await is_spec_version(db, version):
        return out
    from oracle.specs import contract, lineage

    oracle = await lineage.oracle_citation_keys(db, version)
    for c in out:
        if oracle is None or c.cite_key not in oracle:
            c.added, c.state_label = True, contract.ADDED_LABEL
    return out


async def _template_meta_async(db: AsyncSession, body: str):
    """:func:`_template_meta` on the parse pool (a template body is markdown too), within
    ``PARSE_SECONDS``: past it the import is refused (``too_slow``)."""
    try:
        return await safe_yaml.run_parse_within(_template_meta, body, name="the template")
    except safe_yaml.ParseTimeout as exc:
        await db.rollback()
        raise DraftError([ImportProblem(code=exc.code, message=str(exc))]) from None


async def read_version(
    db: AsyncSession, version: DocumentVersion, *, require_dates: bool = True
) -> VersionOut:
    """The version with its sections, citations and, for a roadmap, its date markers.

    A roadmap's dates are read off the event loop, once per version
    (oracle.roadmap.doc_dates.found_for_version): while they are still being found the
    read is refused (``DatesUnavailable``, 503), unless ``require_dates`` is False (an
    import's result, whose dates the import itself checked), which then has no markers."""
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
    states = await _spec_states(db, version, sections)
    source = (await version_sources(db, [version.source_version_id])).get(
        version.source_version_id  # type: ignore[arg-type]
    )
    date_marks: list[dict] = []
    # One query for the kind and, for a roadmap built from a PRD version, that PRD.
    kind, built_prd = (
        await db.execute(
            select(Document.kind, DocumentVersion.document_id)
            .select_from(Document)
            .outerjoin(DocumentVersion, DocumentVersion.id == version.source_version_id)
            .where(Document.id == version.document_id)
        )
    ).one()
    if kind in ("roadmap", "update"):
        from oracle.roadmap import doc_dates

        try:
            marks = await doc_dates.occurrences_for_version(db, version, sections, prd=built_prd)
        except doc_dates.DatesUnavailable:
            if require_dates:
                raise
            marks = []
        date_marks = [m.as_json() for m in doc_dates.per_section(marks)]
    return VersionOut(
        **VersionSummary.model_validate(version).model_dump(
            exclude={"source", "imported_by_name", "imported_again"}
        ),
        source=source,
        imported_by_name=(await importer_names(db, [version])).get(version.id),
        imported_again=(await imported_again(db, version.document_id, [version])).get(version.id),
        approval_lapses=version.approval_lapses or [],
        front_matter=version.front_matter,
        sections=[
            SectionOut.model_validate(s).model_copy(
                update={
                    "verdict": verdicts.get(s.section_key),
                    # O1g: computed on read, so every version follows the same rule.
                    "notes": layers.presenter_notes(s.body_md) if s.layer == "brief" else None,
                    "spec_states": states.get(s.section_key, []),
                }
            )
            for s in sections
        ],
        citations=await _citations_out(db, version, citations),
        date_marks=date_marks,
        draft_roadmap=await _draft_roadmap(db, version) if kind == "prd" else None,
    )


async def _draft_roadmap(db: AsyncSession, version: DocumentVersion):
    """E1: a PRD version's derivation, for its Roadmap tab's label."""
    from oracle.roadmap import draft_items

    return await draft_items.summary(db, version)


async def version_markdown(db: AsyncSession, version: DocumentVersion) -> tuple[str, list[dict]]:
    """A version's stored markdown and, for a roadmap, the dates it writes that rest on no
    verified basis now: the markdown carries an HTML comment after each
    (``<!-- oracle: date unverified -->``, ``<!-- oracle: date withdrawn -->``; the import
    drops them), and the list names them (O4 'document dates')."""
    kind = await db.scalar(select(Document.kind).where(Document.id == version.document_id))
    if kind not in ("roadmap", "update"):
        return version.markdown, []
    from oracle.roadmap import doc_dates

    sections = list(
        await db.scalars(
            select(Section).where(Section.version_id == version.id).order_by(Section.ordinal)
        )
    )
    marks = doc_dates.flagged(await doc_dates.occurrences_for_version(db, version, sections))
    if not marks:
        return version.markdown, []
    markdown = doc_dates.annotate_markdown(version.markdown, sections, marks)
    return markdown, [m.as_json() for m in doc_dates.per_section(marks)]


async def _check_document_dates(
    db: AsyncSession,
    document: Document,
    draft: ParsedDraft,
    source_version_id: uuid.UUID | None,
    *,
    refuse: bool,
    only_sections: set[str] | None = None,
    template_body: str | None = None,
) -> tuple[list[VersionWarning], DraftDates]:
    """Every date the roadmap's text writes against its PRD's verified bases: refused
    (DraftError, nothing stored) or one ``unverified_date`` warning each. Also returns
    the dates found, which the stored version keeps.

    ``only_sections``: Oracle's own revisions (refinement, start-draft) check only the
    sections they change (a date in an untouched section is the previous version's,
    marked there); the title only when ``""`` is in it. A date the company's template
    (``template_body``) writes literally in the same section is exempt: it is the
    company's text, not a schedule claim.

    The text is read off the event loop (oracle.roadmap.doc_dates.found_for_draft): a
    draft whose dates take longer than ``doc_dates.WAIT_SECONDS`` to find is refused
    (``too_slow``), and one that writes more than ``doc_dates.MAX_DATES`` dates
    (``too_many_dates``), whatever kind of import."""
    from oracle.roadmap import doc_dates

    title = draft.front_matter.get("title")
    ref = doc_dates.import_day(await company_time.company_time_zone(db))
    try:
        found = await doc_dates.found_for_draft(
            draft.sections, title=title if isinstance(title, str) else None, ref=ref
        )
        exempt = await doc_dates.template_dates_async(template_body, ref) if template_body else None
    except (safe_yaml.ParseTimeout, doc_dates.DatesUnavailable):
        await db.rollback()
        raise DraftError(
            [
                ImportProblem(
                    code="too_slow",
                    message=f"the roadmap's dates took more than {doc_dates.WAIT_SECONDS:g} s "
                    "to check; keep it small and plain",
                )
            ]
        ) from None
    if len(found) > doc_dates.MAX_DATES:
        # What a version keeps stays small (oracle.roadmap.doc_dates: a pathological date
        # count is refused here, not kept and re-read).
        await db.rollback()
        raise DraftError(
            [
                ImportProblem(
                    code="too_many_dates",
                    message=f"the roadmap writes {len(found):,} dates; Oracle checks at most "
                    f"{doc_dates.MAX_DATES:,} in one version. Split it or write fewer dates",
                )
            ]
        )
    dates = DraftDates(ref, found)

    problems: list[ImportProblem] = []
    sc = doc_dates.scope(draft.sections)
    if sc.misplaced_sources:
        problems.append(
            ImportProblem(
                code="sources_not_last",
                message=doc_dates.SOURCES_NOT_LAST,
                section_key=doc_dates.SOURCES_KEY,
            )
        )
    if document.kind == "update":
        # H8: every PRD with an active product track, not one roadmap's PRD.
        prds = await doc_dates.prds_with_active_track(db)
        prd_id = None
    else:
        prd_id = await doc_dates.prd_of(db, document.id, source_version_id, draft.front_matter)
        prds = [prd_id] if prd_id is not None else []
    marks = await doc_dates.check(db, found, prds, exempt=exempt)
    bad = [
        m
        for m in doc_dates.flagged(marks)
        if only_sections is None or m.section_key in only_sections
    ]
    if not bad and not problems:
        return [], dates
    prd = (
        (await db.execute(select(Document.slug, Document.title).where(Document.id == prd_id)))
        .tuples()
        .first()
        if prd_id
        else None
    )
    prd_slug, prd_title = prd or (None, None)
    headings = {sec.section_key: sec.heading for sec in draft.sections}
    problems += [
        ImportProblem(
            code="unverified_date",
            message=doc_dates.problem_message(
                m,
                prd_title,
                update=document.kind == "update",
                heading=headings.get(m.section_key),
            ),
            section_key=m.section_key or None,
            refs=doc_dates.problem_refs(m, prd_slug),
        )
        for m in bad
    ]
    if refuse:
        await db.rollback()
        raise DraftError(problems)
    return [
        VersionWarning(
            code=p.code,
            message=p.message,
            section_keys=[p.section_key] if p.section_key else [],
            refs=p.refs,
        )
        for p in problems
    ], dates


# An oracle citation's ref names a baseline item: "baseline <kind> <key>", then free text
# ("baseline goal g1 (activation), locked").
ORACLE_REF_RE = re.compile(r"^\s*baseline\s+(?P<type>[a-z_]+)\s+(?P<key>[^\s,;()]+)")


async def _oracle_ref_problems(
    db: AsyncSession, citations: list[CitationIn]
) -> list[ImportProblem]:
    """An ``invalid_citation`` problem per oracle citation whose ref names no baseline item
    of this company (the session is tenant-scoped; a rejected item is none): every citation
    counts in the quality criteria (oracle.quality.criteria), so a made-up one is refused,
    not kept."""
    from oracle.baseline.models import Entity

    named: dict[int, tuple[str, str] | None] = {}
    for i, c in enumerate(citations):
        if c.source == "oracle":
            m = ORACLE_REF_RE.match(c.ref)
            named[i] = (m["type"], m["key"].rstrip(".:")) if m else None
    wanted = {pair for pair in named.values() if pair is not None}
    found: set[tuple[str, str]] = set()
    if wanted:
        rows = await db.execute(
            select(Entity.type, Entity.key).where(
                tuple_(Entity.type, Entity.key).in_(sorted(wanted)),
                Entity.status != "rejected",
            )
        )
        found = {(t, k) for t, k in rows}
    # The citation's id is the key the draft's author wrote (as the parser's refusals
    # echo it), not a database id.
    keys = {i: citations[i].id for i, pair in named.items() if pair not in found}
    return [
        ImportProblem(
            code="invalid_citation",
            message=f"citation #{i + 1} ({key}) is invalid: ref names no "
            "baseline item of this company",
            cite_key=key,
        )
        for i, key in keys.items()
    ]


async def _citation_items(
    db: AsyncSession, draft: ParsedDraft
) -> tuple[dict[str, uuid.UUID], list[VersionWarning]]:
    """The source item each citation names, when this company has it (the session is
    tenant-scoped, so another company's item is not found). Any other value is dropped
    with an ``unknown_citation_item`` warning naming the sections that cite it; never a
    refusal: the citation itself is kept."""
    named = {c.id: c.item for c in draft.citations if c.item is not None}
    ids = {key: uuid.UUID(value) for key, value in named.items() if is_uuid(value)}
    found = (
        set(await db.scalars(select(SourceItem.id).where(SourceItem.id.in_(set(ids.values())))))
        if ids
        else set()
    )
    warnings = []
    for key, value in named.items():
        if ids.get(key) in found:
            continue
        citing = [s for s in draft.sections if key in s.citation_keys]
        warnings.append(
            VersionWarning(
                code="unknown_citation_item",
                message=wording.unknown_source_item([s.heading for s in citing]),
                section_keys=[s.section_key for s in citing],
                refs={"cite_key": key, "source_item": value},
            )
        )
    return {key: item for key, item in ids.items() if item in found}, warnings


def unknown_feedback_item(fid: uuid.UUID) -> ImportProblem:
    """A resolution naming feedback the document does not have: the import's refusal to
    the agent that wrote it, which echoes the id it sent (and keeps it in ``refs``)."""
    return ImportProblem(
        code="unknown_feedback_item",
        message=f"resolution references unknown feedback item {fid}",
        refs={"feedback_item": str(fid)},
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


@dataclass
class HeldSection:
    """An approved section an agent's draft changed or dropped: the agent's text waits
    as a section patch (``action`` "replace"), or its removal does ("remove")."""

    heading: str
    body_md: str
    action: str = "replace"


def _without_resolutions(front_matter: dict | None) -> dict:
    return {k: v for k, v in (front_matter or {}).items() if k != "resolutions"}


async def _layers(
    db: AsyncSession, document: Document, draft: ParsedDraft
) -> tuple[list[str], str, dict[str, str]]:
    """O1f: the brief layer, from the draft, else its template's markers, else a
    "Full version" heading. Returns (brief keys, brief source, layer by key)."""
    template_brief = None
    if draft.brief is None:
        named = (
            (draft.template, draft.template_version)
            if draft.template
            else (document.template, document.template_version)
        )
        body = await template_body(db, *named)
        template_brief = (await _template_meta_async(db, body)).marked_brief if body else None
    brief, brief_source = layers.resolve_brief(
        [layers.SectionRef(s.section_key, s.level) for s in draft.sections],
        draft_brief=draft.brief,
        template_brief=template_brief,
    )
    return brief, brief_source, layers.layers((s.section_key for s in draft.sections), brief)


def draft_revisions(draft: ParsedDraft, layer_of: dict[str, str]) -> dict[str, str]:
    """Each section's review revision: its text, the citation entries it cites and its
    layer (:func:`oracle.docs.parser.section_revision`)."""
    cites = {c.id: c for c in draft.citations}
    return {
        s.section_key: section_revision(
            s.content_hash, layer_of[s.section_key], cited_entries(s.citation_keys, cites)
        )
        for s in draft.sections
    }


# #541 part 5: a run that reads as a member wrote a draft naming what a member may not see.
NAMES_HIDDEN = "names_hidden"


async def check_member_draft(db: AsyncSession, run_id: uuid.UUID, markdown: str) -> None:
    """Refuse the draft of a run that reads as a member (a draft of a company-wide
    document, oracle.runs.service.reads_as_member) when it names a decision or a
    document a commenter may not see (its number, title or id: oracle.docs.visibility
    ``Hidden.names``). The refusal names nothing hidden; the run sends it back to the
    writer as any refused draft."""
    from oracle.docs import visibility
    from oracle.runs.models import Run
    from oracle.runs.service import reads_as_member

    run = await db.get(Run, run_id)
    if run is None or not await reads_as_member(db, run):
        return
    hidden = await visibility.hidden_for_reader(db, as_member=True)
    if hidden is not None and hidden.names(markdown):
        raise DraftError([ImportProblem(
            code=NAMES_HIDDEN,
            message="the draft names a decision or a document that only owners and approvers "
            "may see (its number, title or id), and every member reads this document: leave "
            "it out",
        )])  # fmt: skip


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
    unverified_dates: Literal["refuse", "mark"] = "refuse",
    date_sections: set[str] | None = None,
    commit: bool = True,
    template_only: bool = False,
    run_creates: bool = False,
) -> ImportResult:
    """Import a draft as the next version of ``doc``.

    ``kind`` (a run's target kind) is the kind of a document the import creates, and an
    existing document must be of it; without it a new document takes the front matter's
    ``kind`` (prd by default). ``theme`` is a new document's theme; ``template`` (key,
    version) is the document's template when the draft names none. ``source_version_id``
    is the version's provenance (a roadmap's PRD version).

    ``base_version`` is the version the draft was written on (stored as
    ``base_number``; 0 = the draft creates the document). When it is older than the
    latest version, every section changed since must already be in the draft as the
    latest has it, and so must the front matter if it changed; otherwise the import is
    a :class:`BaseVersionConflictError` naming both versions and the sections. A
    draft import without a base onto an existing document still works, and the version
    carries a ``base_version_missing`` note.

    ``cause`` goes on the ``document_section`` change event of every section whose
    revision changed (``oracle.changes``; review invalidates their approvals, trace
    marks what depends on them). ``origin="run"`` (an agent's draft) never replaces,
    removes or re-cites an approved section: the section keeps its approved text, its
    citation entries and its layer, and the agent's change waits as a section patch,
    reviewed as a diff (§9). A principal acting for a run (``principal.run_id``, a run
    token's call) always imports with ``origin="run"``.

    A roadmap's dates (O4 'document dates', oracle.roadmap.doc_dates) must each rest on
    a verified schedule basis of its PRD: ``unverified_dates="refuse"`` (a person's
    import, Oracle's own revisions) refuses the draft; ``"mark"`` (a run's import) keeps
    it and records an ``unverified_date`` warning per date, which the views mark (and
    approval is refused until each is resolved). ``date_sections``: Oracle's own
    revisions check only the sections they change (``""``: the title). ``template_only``:
    the draft is a template's skeleton (a ``template_only`` note on the version, #255).

    ``run_creates``: ``doc`` is the slug of the document run ``run_id`` was to create.
    Checked under the document's row lock: when a document of it exists that none of the
    run's versions is in (a member created it meanwhile), the import is a
    :class:`SlugTakenError`, never a version of that document.

    ``commit=False`` flushes the version and leaves the commit to the caller, which writes
    more in the same transaction (a roadmap change set's proposal, oracle.roadmap.changeset).

    Raises :class:`DraftError` (422), :class:`NotFoundError` (404, ``doc`` is an
    unknown id) or :class:`ImportConflictError` (409, lost a concurrent import race,
    or a base version conflict).
    """
    acting_for_run = getattr(principal, "run_id", None)
    if acting_for_run is not None:
        origin = "run"
        run_id = run_id or acting_for_run
        if cause == "draft_imported":
            cause = "run_draft"
    # E1: the state labels a spec's markdown is served with are never stored. They are
    # stripped before the draft's one parse (the kind read without the row lock, which is
    # taken after the parse).
    found = await find_document(db, doc)
    if found is not None and found.kind == "spec":
        from oracle.specs.contract import strip_state_labels

        try:
            markdown = await safe_yaml.run_parse_within(
                strip_state_labels, markdown, name="the draft"
            )
        except safe_yaml.ParseTimeout as exc:
            raise DraftError([ImportProblem(code=exc.code, message=str(exc))]) from exc
    # Off the event loop, time-capped: the draft is untrusted text (oracle.safe_yaml).
    try:
        draft = await parse_draft_async(markdown)
    except DraftError as exc:
        # The oracle refs of the citations that parsed are checked too: one refusal names
        # every problem, not the parse's first and the refs' on the next try.
        if refused := await _oracle_ref_problems(db, exc.citations):
            raise DraftError([*exc.problems, *refused], citations=exc.citations) from exc
        raise
    if refused := await _oracle_ref_problems(db, draft.citations):
        raise DraftError(refused)
    if draft.template is None and template is not None:
        draft.template, draft.template_version = template
    if run_id is not None:
        await check_member_draft(db, run_id, markdown)
    held: dict[str, HeldSection] = {}

    document = await find_document(db, doc, for_update=True)
    if (
        run_creates
        and document is not None
        and not (run_id is not None and await run_imported_into(db, document.id, run_id))
    ):
        raise SlugTakenError(
            f"{doc} now names another document: the run's draft is not added to it"
        )
    if document is None:
        if is_uuid(doc):
            raise NotFoundError(f"document '{doc}' not found")
        if draft.document is not None and draft.document != doc:
            raise _document_mismatch(doc, draft)
        if base_version:
            raise _unknown_base(base_version, None)
        # The same kind the check on an existing document reads: the run's, else the
        # draft's front matter kind, else its template's.
        new_kind = kind or await _draft_kind(db, draft) or "prd"
        document = Document(
            slug=doc,
            title=draft.title,
            status="draft",
            kind=new_kind,
            visibility=default_visibility(new_kind),
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
        if base_version == 0 and previous is not None:
            raise BaseVersionConflictError(
                0,
                previous.number,
                [],
                message=f"document '{document.slug}' already exists and version "
                f"{previous.number} is the latest; merge it and push with base_version "
                f"{previous.number}",
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
            if held and existing.id == previous.id:
                # The agent changed approved sections only: no new version, but its
                # changes still wait as patches.
                from oracle.review import patches

                await patches.propose_held(
                    db, principal, document, previous, held, origin=origin, run_id=run_id
                )
                await (db.commit() if commit else db.flush())
            return ImportResult(
                version=await read_version(db, existing, require_dates=False),
                created=False,
                resolutions=draft.resolutions,
            )

    brief, brief_source, layer_of = await _layers(db, document, draft)
    revisions = draft_revisions(draft, layer_of)
    if base_version and previous is not None:
        await _check_base(db, document, previous, base_version, draft, revisions)

    warnings: list[VersionWarning] = []
    dates: DraftDates | None = None
    if held:
        warnings.append(
            VersionWarning(
                code="approved_section_held",
                message="approved sections keep their approved text; the draft's changes "
                f"wait as section patches for review: {', '.join(sorted(held))}",
                section_keys=sorted(held),
            )
        )
    resolutions = draft.resolutions
    if origin == "run" and previous is not None and resolutions:
        resolutions, skipped = await _run_resolutions(db, document, previous, draft, revisions)
        if skipped:
            # #396: the sections by heading; the feedback ids in refs.
            message, refs = wording.feedback_left_open(
                skipped, {s.section_key: s.heading for s in draft.sections}
            )
            warnings.append(
                VersionWarning(
                    code="resolution_not_applied",
                    message=message,
                    section_keys=sorted({k for k in skipped.values() if k}),
                    refs=refs,
                )
            )
    notes: list[VersionWarning] = []
    if previous is not None and base_version is None and cause == "draft_imported":
        notes.append(
            VersionWarning(
                code="base_version_missing",
                message="imported without base_version: nothing checked that this draft "
                "keeps the changes made since the version it was written on",
            )
        )
    if template_only:
        # #255: the template's skeleton, no content yet: the document offers Draft with
        # Oracle before Publish until a draft replaces this version.
        notes.append(
            VersionWarning(
                code="template_only", message="the template's skeleton, with no content yet"
            )
        )
    if document.kind in ("roadmap", "update"):
        date_warnings, dates = await _check_document_dates(
            db,
            document,
            draft,
            source_version_id,
            refuse=unverified_dates == "refuse",
            only_sections=date_sections,
            template_body=await template_body(
                db,
                *(
                    (draft.template, draft.template_version)
                    if draft.template
                    else (document.template, document.template_version)
                ),
            ),
        )
        warnings += date_warnings
    if document.kind in ("strategy", "vision"):
        # H4: a strategy's choices each have their section; its goal and feature keys,
        # focus count and goalless focus are warnings. A vision's beliefs are well formed.
        from oracle.strategy import frontmatter

        warnings += await frontmatter.check_import(
            db, document.kind, draft.front_matter, {s.section_key for s in draft.sections}
        )
    if document.kind == "update":
        # H8: the numbers come first, the period is set, every figure cites, and Asks is
        # the owner's (a run's text there is flagged).
        from oracle.updates import frontmatter as update_frontmatter

        named = update_frontmatter.template_of(draft.front_matter, document.template)
        body = await template_body(
            db,
            *(
                (draft.template, draft.template_version)
                if draft.template
                else (document.template, document.template_version)
            ),
        )
        try:
            warnings += update_frontmatter.check_import(
                draft.front_matter,
                draft.sections,
                brief,
                template=named,
                template_body=body,
                from_run=origin == "run",
            )
        except DraftError:
            await db.rollback()
            raise
    if document.kind == "pricing":
        # H9: one question, two to four options each with its section, one recommendation
        # at most (and only at Recommend), cited prices, a research plan.
        from oracle import autonomy
        from oracle.pricing import frontmatter as pricing_frontmatter

        try:
            warnings += pricing_frontmatter.check_import(
                draft.front_matter,
                draft.sections,
                level=await autonomy.level(db, "pricing_input") if origin == "run" else None,
                template_only=template_only,
            )
        except DraftError:
            await db.rollback()
            raise
    if origin == "run" and document.kind == "prd":
        # #306: an agent names the codes it writes; a draft that does not is flagged.
        warnings += named_codes.check(draft.sections)
    if previous is not None:
        locked = await review_service.locked_section_keys(db, previous.id)
        if locked:
            before = dict(
                (
                    await db.execute(
                        select(Section.section_key, Section.revision).where(
                            Section.version_id == previous.id,
                            Section.section_key.in_(locked),
                        )
                    )
                ).all()
            )
            changed = sorted(k for k in locked if k in before and revisions.get(k) != before[k])
            if changed:
                warnings.append(
                    VersionWarning(
                        code="locked_section_changed",
                        message="sections approved in version "
                        f"{previous.number} changed: {', '.join(changed)}",
                        section_keys=changed,
                    )
                )

    items, item_warnings = await _citation_items(db, draft)
    warnings += item_warnings

    version = DocumentVersion(
        document_id=document.id,
        number=(previous.number + 1) if previous else 1,
        markdown=draft.markdown,
        content_hash=draft.content_hash,
        front_matter=draft.front_matter,
        snapshot=draft.snapshot,
        warnings=[w.model_dump() for w in warnings],
        notes=[n.model_dump() for n in notes],
        imported_by=principal.id,
        brief_source=brief_source,
        source_version_id=source_version_id,
        base_number=base_version or None,
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
            revision=revisions[s.section_key],
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
            item_id=items.get(c.id),
            confidence=c.confidence,
            confidence_note=c.confidence_note,
            low_confidence=c.low_confidence,
        )
        for c in draft.citations
    )
    await db.flush()

    try:
        await review_service.apply_resolutions(
            db, document.id, version.id, resolutions, principal=principal
        )
    except review_service.UnknownFeedbackItemsError as exc:
        await db.rollback()
        raise DraftError([unknown_feedback_item(fid) for fid in exc.feedback_ids]) from exc

    from oracle.review import patches, state

    if document.kind == "spec":
        # The spec lineage handler checks the edit on this parse (oracle.specs.lineage).
        db.info.setdefault("spec_drafts", {})[version.id] = draft
    # v2 hook: outputs built on earlier versions may now be stale (oracle.trace). One
    # change: the review lane's per-section changes below are parts of it, and the trace
    # marks what the version reaches once, from this event.
    version_change = await changes.record_change(
        db,
        "document_version",
        cause="version_imported",
        actor=principal,
        subject_id=version.id,
        subject_ref=f"{document.slug}@{version.number}",
        document_id=document.id,
        data={
            "number": version.number,
            "previous_version_id": str(previous.id) if previous else None,
            # E1: a template's empty skeleton derives no roadmap items.
            **({"template_only": True} if template_only else {}),
        },
    )
    await state.record_section_changes(
        db, principal, document, previous, version, revisions, cause, part_of=version_change.id
    )
    if held:
        await patches.propose_held(
            db, principal, document, version, held, origin=origin, run_id=run_id
        )

    if run_id is not None and document.kind == "prd":
        # F5-1: the run's approved tech briefs are registered with its PRD draft, in
        # this transaction (oracle.engineering.store).
        from oracle.engineering import store as brief_store

        await brief_store.on_draft_imported(db, principal, run_id, document, version)

    document.title = draft.title
    document.template = draft.template
    document.template_version = draft.template_version
    to_review = document.status == "approved"
    if to_review:
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
            **({"notes": [n.code for n in notes]} if notes else {}),
            "brief_source": brief_source,
            **({"source_version_id": str(source_version_id)} if source_version_id else {}),
            **({"base_version": base_version} if base_version is not None else {}),
            **({"cause": cause} if cause != "draft_imported" else {}),
            **({"run_id": str(run_id)} if run_id else {}),
            **({"held_sections": sorted(held)} if held else {}),
        },
    )
    if not template_only:
        # Slack pings: the reviewers who chose "draft ready" (oracle.slack.pings).
        from oracle.slack import pings

        await pings.draft_ready(
            db, document, version.number, principal.user_id if principal else None
        )
    await webhooks.capture(
        db,
        "draft.version_created",
        principal,
        document_id=document.id,
        version=version.number,
        origin=origin,
    )
    if to_review:
        await webhooks.capture(
            db, "draft.in_review", principal, document_id=document.id, version=version.number
        )
    await (db.commit() if commit else db.flush())
    if dates is not None:
        # The version's text is the draft's: reading it parses nothing again.
        from oracle.roadmap import doc_dates

        doc_dates.keep_for_version(version.id, dates.ref, dates.found)
    return ImportResult(
        version=await read_version(db, version, require_dates=False),
        created=True,
        resolutions=draft.resolutions,
    )


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
    rows = await db.scalars(
        select(Section).where(Section.version_id == version_id).order_by(Section.ordinal)
    )
    return {s.section_key: s for s in rows}


async def _check_base(
    db: AsyncSession,
    document: Document,
    latest: DocumentVersion,
    base_number: int,
    draft: ParsedDraft,
    revisions: dict[str, str],
) -> None:
    """Refuse a draft on an older base that would overwrite what changed since.

    A section conflicts when its revision changed between the base and the latest
    version and the draft does not already have the latest revision: either both sides
    changed it, or the draft still has the base text and would silently revert the
    newer change. The front matter (outside ``resolutions``) conflicts the same way.
    """
    if base_number < 1 or base_number > latest.number:
        raise _unknown_base(base_number, latest.number)
    if base_number == latest.number:
        return
    base = await get_version_row(db, document, base_number)
    base_sections = await _section_rows(db, base.id)
    current = await _section_rows(db, latest.id)
    conflicts = []
    for key in dict.fromkeys([*base_sections, *current]):
        before = base_sections.get(key)
        now = current.get(key)
        before_hash = before.revision if before else None
        now_hash = now.revision if now else None
        if before_hash == now_hash or revisions.get(key) == now_hash:
            continue
        conflicts.append(
            {
                "section_key": key,
                "base_revision": before_hash,
                "current_revision": now_hash,
                "your_revision": revisions.get(key),
                "current_heading": now.heading if now else None,
                "current_body_md": now.body_md if now else None,
            }
        )
    latest_fm = _without_resolutions(latest.front_matter)
    front_matter_changed = _without_resolutions(
        base.front_matter
    ) != latest_fm and latest_fm != _without_resolutions(draft.front_matter)
    if conflicts or front_matter_changed:
        message = None
        if front_matter_changed and not conflicts:
            message = (
                f"the draft is based on version {base_number}, but version {latest.number} "
                f"is the latest and changed the front matter since; merge version "
                f"{latest.number} and push again"
            )
        raise BaseVersionConflictError(
            base_number,
            latest.number,
            conflicts,
            message=message,
            front_matter_changed=front_matter_changed,
        )


async def _run_resolutions(
    db: AsyncSession,
    document: Document,
    previous: DocumentVersion,
    draft: ParsedDraft,
    revisions: dict[str, str],
) -> tuple[list, dict[str, str | None]]:
    """The resolutions of an agent's draft it may apply, and the ones it may not (feedback
    id -> section key). An agent closes a feedback item only as ``addressed`` and only
    when the item is on a section whose revision this version changes: it never
    declines feedback, never closes a document-level item, and never closes an item on a
    section it left alone (an approved section it changed is held, so it is left alone
    until its patch is accepted). Unknown ids pass through (the import refuses them)."""
    from oracle.review.models import FeedbackItem

    before = {k: s.revision for k, s in (await _section_rows(db, previous.id)).items()}
    changed = {k for k, r in revisions.items() if before.get(k) != r}
    ids = [r.feedback_id for r in draft.resolutions]
    items = {
        i.id: i
        for i in await db.scalars(
            select(FeedbackItem).where(
                FeedbackItem.document_id == document.id, FeedbackItem.id.in_(ids)
            )
        )
    }
    keep, skipped = [], {}
    for res in draft.resolutions:
        item = items.get(res.feedback_id)
        if item is None or (
            res.status == "addressed" and item.section_key and item.section_key in changed
        ):
            keep.append(res)
        else:
            skipped[str(res.feedback_id)] = item.section_key
    return keep, skipped


async def _hold_approved_sections(
    db: AsyncSession, document: Document, previous: DocumentVersion, draft: ParsedDraft
) -> tuple[ParsedDraft, dict[str, HeldSection]]:
    """An agent's draft keeps every approved section as approved (§9): its text and
    level, its place when the draft dropped or renamed it, the citation entries it
    cites (the draft's front matter cannot redefine them) and its brief membership.

    Returns the draft to import and, per held section, the agent's change, which
    becomes a section patch.
    """
    from oracle.jobs.service import compose_markdown
    from oracle.review.state import approved_keys

    approved = await approved_keys(db, document.id, previous)
    if not approved:
        return draft, {}
    old = await _section_rows(db, previous.id)
    old_order = list(old.values())
    mine = {s.section_key: s for s in draft.sections}
    held: dict[str, HeldSection] = {}
    for key in sorted(approved):
        o, m = old[key], mine.get(key)
        if m is None:
            held[key] = HeldSection(o.heading, "", action="remove")
        elif (m.level, m.heading, m.body_md) != (o.level, o.heading, o.body_md):
            held[key] = HeldSection(m.heading, m.body_md)
    sections: list = [
        old[s.section_key] if s.section_key in approved else s for s in draft.sections
    ]
    # A dropped (or renamed) approved section stays, after the nearest section that
    # preceded it in the approved version.
    for i, o in enumerate(old_order):
        if o.section_key not in approved or o.section_key in mine:
            continue
        keys = [s.section_key for s in sections]
        at = next(
            (
                keys.index(p.section_key) + 1
                for p in reversed(old_order[:i])
                if p.section_key in keys
            ),
            0,
        )
        sections.insert(at, o)

    front_matter = dict(draft.front_matter)
    cited = {k for key in approved for k in old[key].citation_keys}
    if cited:
        rows = await db.scalars(
            select(Citation).where(Citation.version_id == previous.id, Citation.cite_key.in_(cited))
        )
        entries = {
            c.cite_key: {
                "id": c.cite_key,
                "source": c.source,
                "ref": c.ref,
                **({"title": c.title} if c.title else {}),
                **({"excerpt": c.excerpt} if c.excerpt else {}),
                **({"retrieved_at": c.retrieved_at.isoformat()} if c.retrieved_at else {}),
            }
            for c in rows
        }
        listed = [c for c in front_matter.get("citations") or [] if isinstance(c, dict)]
        known = {str(c.get("id")) for c in listed}
        merged = [entries.get(str(c.get("id")), c) for c in listed]
        merged += [e for k, e in entries.items() if k not in known]
        if merged != listed:
            front_matter["citations"] = merged
    resolutions = list(draft.front_matter.get("resolutions") or [])
    if not held and front_matter == draft.front_matter:
        out = draft
    else:
        out = parse_draft(compose_markdown(front_matter, sections, {}, resolutions))

    # Approved sections keep their brief membership.
    _, _, layer_of = await _layers(db, document, out)
    if any(layer_of.get(k) != old[k].layer for k in approved):
        front_matter["brief"] = [
            s.section_key
            for s in out.sections
            if (old[s.section_key].layer if s.section_key in approved else layer_of[s.section_key])
            == layers.BRIEF
        ]
        out = parse_draft(compose_markdown(front_matter, sections, {}, resolutions))
        _, _, layer_of = await _layers(db, document, out)
    # As a section edit is checked (oracle.docs.edit._confined): the draft to import has
    # every approved section with its approved revision, or it is refused.
    revisions = draft_revisions(out, layer_of)
    lost = [k for k in sorted(approved) if revisions.get(k) != old[k].revision]
    if lost:
        raise DraftError(
            [
                ImportProblem(
                    code="approved_section_not_held",
                    message=f"approved section {k!r} would not keep its approved text, "
                    "evidence and place in this draft; close code fences and keep its "
                    "heading on its own line",
                    section_key=k,
                )
                for k in lost
            ]
        )
    return out, held


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
    sections = diff_sections(old_sections, new_sections)
    new_states = await _spec_states(db, new, new_sections)
    if new_states:
        old_states = await _spec_states(db, old, old_sections)
        for d in sections:
            states = old_states if d.status == "removed" else new_states
            d.spec_states = states.get(d.section_key, [])
    return DiffOut(
        document_id=document.id,
        from_version=from_number,
        to_version=to_number,
        sections=sections,
    )
