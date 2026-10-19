"""The publish check and the immutable publish transaction (CR-06, build prompt §9,
§16.11 and §16.17).

``publish_check`` lists everything that blocks publishing a version; ``publish`` runs
the same check under the document's row lock and either refuses (nothing written) or
writes one :class:`~oracle.review.models.DocumentPublication`.

A publish is refused for:

- a version the decider has not approved (or approved by someone other than the
  designated decider);
- missing required sections (template, composition and policy);
- stale or missing mandatory approvals: each section the policy requires must be
  approved on its current revision, and every mandatory reviewer must have approved it
  (no unanimity unless the company configures mandatory reviewers);
- a hard readiness check that is critical (``oracle.readiness.evaluate``; a critical
  unresolved blocker, a failed security or policy check). Advisory results never block
  (T2);
- invalidated source permissions: evidence of the version from a source item that was
  deleted, whose connection was revoked, or that a ``source_permission`` change event
  revoked;
- a version already published.

A publication pins the version (its markdown and content hash), the template version,
the composition revision, the last approval and the decider, every section's
approval, the evidence snapshot (citations and section links), the Sources and data
points appendix, the pushback override log, the readiness results and the rendered
HTML (full, brief and deck). A trigger refuses any UPDATE of the row, so later edits
and source updates never change it; its exports are served from the stored HTML.
"""

import hashlib
import json
import uuid
from typing import TYPE_CHECKING, Any

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, readiness
from oracle.connections.models import Connection
from oracle.docs.models import Citation, Document, DocumentVersion, Section
from oracle.jobs.models import LlmSuggestion
from oracle.readiness import CheckOutcome, ReadinessContext
from oracle.review.models import (
    DocumentPublication,
    FeedbackItem,
    SectionReviewState,
)
from oracle.review.schemas import (
    PublishCheckOut,
    PublishProblem,
    ReadinessResultOut,
    SectionStatesOut,
)
from oracle.review.state import (
    current_composition,
    effective_policy,
    required_sections,
    section_states,
)
from oracle.sources.models import Source, SourceItem
from oracle.v2.models import ChangeEvent, DocumentSectionLink

if TYPE_CHECKING:
    from oracle.auth.deps import Principal

# The hard readiness check this lane registers (the review invariants, for the
# readiness dashboard); the publish check computes them itself and skips it.
REVIEW_CHECK_KEY = "review_approvals"
# ``source_permission`` change-event causes that revoke and that restore access. A
# lane recording a permission change uses one of these, with ``subject_id`` the source
# or source item id (or ``document_id`` the document it affects).
REVOKING_CAUSES = frozenset(
    {"revoked", "permission_revoked", "source_revoked", "connection_revoked", "acl_narrowed"}
)
RESTORING_CAUSES = frozenset({"restored", "permission_restored", "granted"})
MANIFEST_FORMAT = 1


class PublishRefusedError(Exception):
    def __init__(self, check: PublishCheckOut, message: str | None = None):
        self.check = check
        codes = ", ".join(dict.fromkeys(b.code for b in check.blockers))
        super().__init__(message or f"publish refused: {codes}")


# --- source permissions -------------------------------------------------------------


async def source_permission_problems(
    db: AsyncSession, document: Document, version: DocumentVersion
) -> list[PublishProblem]:
    links = list(
        await db.scalars(
            select(DocumentSectionLink).where(
                DocumentSectionLink.document_id == document.id,
                (DocumentSectionLink.version_id == version.id)
                | DocumentSectionLink.version_id.is_(None),
            )
        )
    )
    item_keys: dict[uuid.UUID, set[str]] = {}
    for link in links:
        if link.source_item_id is not None:
            item_keys.setdefault(link.source_item_id, set()).add(link.section_key)
    # Citations name their source by URL: match them to ingested items.
    citations = list(await db.scalars(select(Citation).where(Citation.version_id == version.id)))
    refs = {c.ref for c in citations if c.ref}
    cite_sections: dict[str, set[str]] = {}
    for s in await db.scalars(select(Section).where(Section.version_id == version.id)):
        for key in s.citation_keys:
            cite_sections.setdefault(key, set()).add(s.section_key)
    if refs:
        for item in await db.scalars(select(SourceItem).where(SourceItem.url.in_(refs))):
            for c in citations:
                if c.ref == item.url:
                    item_keys.setdefault(item.id, set()).update(cite_sections.get(c.cite_key, ()))
    items = list(await db.scalars(select(SourceItem).where(SourceItem.id.in_(list(item_keys)))))
    sources = {
        s.id: s
        for s in await db.scalars(select(Source).where(Source.id.in_({i.source_id for i in items})))
    }
    connection_ids = {s.connection_id for s in sources.values() if s.connection_id}
    revoked_connections = set(
        await db.scalars(
            select(Connection.id).where(
                Connection.id.in_(connection_ids), Connection.status == "revoked"
            )
        )
    )
    subjects = {*item_keys, *(i.source_id for i in items)}
    events = await _revoking_events(db, subjects, document.id)
    by_subject = {e.subject_id for e in events}
    revoked: set[uuid.UUID] = set()
    for item in items:
        source = sources.get(item.source_id)
        if (
            item.deleted_at is not None
            or source is None
            or source.connection_id in revoked_connections
            or item.id in by_subject
            or item.source_id in by_subject
        ):
            revoked.add(item.id)
    # Linked items that no longer exist at all.
    revoked |= {i for i in item_keys if i not in {x.id for x in items}}
    whole_document = [e for e in events if e.subject_id is None or e.subject_id == document.id]
    if not revoked and not whole_document:
        return []
    keys = set().union(*(item_keys.get(i, set()) for i in revoked)) if revoked else set()
    problem = _revoked(keys, events)
    problem.ids = [*sorted(revoked, key=str), *problem.ids]
    return [problem]


def _revoked(keys: set[str], events: list[ChangeEvent]) -> PublishProblem:
    return PublishProblem(
        code="source_permission_revoked",
        message="Evidence comes from a source whose permission was revoked; remove or "
        "replace it before publishing",
        section_keys=sorted(keys),
        ids=[e.id for e in events],
    )


async def _revoking_events(
    db: AsyncSession, subjects: set[uuid.UUID], document_id: uuid.UUID
) -> list[ChangeEvent]:
    """``source_permission`` events whose latest word on their subject is a revoke."""
    rows = list(
        await db.scalars(
            select(ChangeEvent)
            .where(
                ChangeEvent.subject_kind == "source_permission",
                ChangeEvent.subject_id.in_(list(subjects))
                | (ChangeEvent.document_id == document_id),
            )
            .order_by(ChangeEvent.created_at, ChangeEvent.id)
        )
    )
    last: dict[Any, ChangeEvent] = {}
    for e in rows:
        if e.cause in REVOKING_CAUSES or e.cause in RESTORING_CAUSES:
            last[e.subject_id or e.document_id] = e
    return [e for e in last.values() if e.cause in REVOKING_CAUSES]


# --- the check ----------------------------------------------------------------------


def _problem(code: str, message: str, **kw: Any) -> PublishProblem:
    return PublishProblem(code=code, message=message, **kw)  # type: ignore[arg-type]


async def review_problems(
    db: AsyncSession, document: Document, version: DocumentVersion, states: SectionStatesOut
) -> tuple[list[PublishProblem], list[PublishProblem], list[str], list[str]]:
    """Blockers and warnings from the review invariants, the required sections and the
    approval-required sections."""
    policy = await effective_policy(db, document)
    required = await required_sections(db, document, version, policy)
    blockers: list[PublishProblem] = []
    warnings: list[PublishProblem] = []
    if version.approved_at is None:
        who = "the designated decider" if policy.decider_id else "an approver"
        blockers.append(
            _problem("version_not_approved", f"Version {version.number} needs {who}'s approval")
        )
    elif policy.decider_id is not None and version.approved_by != policy.decider_id:
        blockers.append(
            _problem(
                "approval_not_by_decider",
                "The version was approved by someone other than the designated decider",
                ids=[policy.decider_id],
            )
        )
    by_key = {s.section_key: s for s in states.sections}
    # A required section must be present (a heading-only section, such as the title or
    # a parent of sub-sections, counts).
    missing = [k for k in required if k not in by_key]
    if missing:
        blockers.append(
            _problem(
                "missing_required_section",
                "Required sections are missing: " + ", ".join(missing),
                section_keys=missing,
            )
        )
    scope = [s for s in states.sections if s.approval_required]
    stale = [s.section_key for s in scope if s.status == "approval_stale"]
    unapproved = [s.section_key for s in scope if s.status not in ("approved", "approval_stale")]
    if stale:
        blockers.append(
            _problem(
                "stale_approval",
                "These sections changed after they were approved; approve their current "
                "text: " + ", ".join(stale),
                section_keys=stale,
            )
        )
    if unapproved:
        blockers.append(
            _problem(
                "missing_approval",
                "These sections need an approval of their current text: " + ", ".join(unapproved),
                section_keys=unapproved,
            )
        )
    for reviewer in policy.mandatory_reviewer_ids:
        pending = [
            s.section_key
            for s in states.sections
            if any(m.reviewer_id == reviewer and not m.approved for m in s.mandatory_approvals)
        ]
        if pending:
            blockers.append(
                _problem(
                    "mandatory_reviewer_pending",
                    f"Mandatory reviewer {reviewer} has not approved the current text of: "
                    + ", ".join(pending),
                    section_keys=pending,
                    ids=[reviewer],
                )
            )
    optional_stale = [
        s.section_key
        for s in states.sections
        if not s.approval_required and s.status == "approval_stale"
    ]
    if optional_stale:
        warnings.append(
            _problem(
                "approval_stale_optional",
                "Approvals lapsed when these sections changed: " + ", ".join(optional_stale),
                section_keys=optional_stale,
            )
        )
    overdue = [s.section_key for s in states.sections if s.overdue]
    if overdue:
        warnings.append(
            _problem(
                "review_overdue",
                "Reviews are past due: " + ", ".join(overdue),
                section_keys=overdue,
            )
        )
    items = list(
        await db.scalars(
            select(FeedbackItem).where(
                FeedbackItem.document_id == document.id,
                FeedbackItem.status == "open",
                FeedbackItem.raised_on_version <= version.number,
            )
        )
    )
    critical = [i for i in items if i.severity == "critical"]
    if critical:
        warnings.append(
            _problem(
                "open_critical_change_request",
                f"{len(critical)} critical change request(s) are still open",
                section_keys=sorted({i.section_key for i in critical if i.section_key}),
                ids=[i.id for i in critical],
            )
        )
    others = [i for i in items if i.severity != "critical"]
    if others:
        warnings.append(
            _problem(
                "open_change_request",
                f"{len(others)} feedback item(s) are still open",
                ids=[i.id for i in others],
            )
        )
    approval_scope = [s.section_key for s in scope]
    return blockers, warnings, required, approval_scope


async def publish_check(
    db: AsyncSession, document: Document, version: DocumentVersion
) -> PublishCheckOut:
    states = await section_states(db, document, version)
    blockers, warnings, required, scope = await review_problems(db, document, version, states)
    policy = await effective_policy(db, document)

    composition = await current_composition(db, document.id)
    keys = [r.key for r in readiness.checks() if r.key != REVIEW_CHECK_KEY]
    report = await readiness.evaluate(
        ReadinessContext(
            db,
            document.id,
            version.id,
            composition_revision=composition.number if composition else None,
            purpose="publish",
        ),
        keys=keys,
    )
    for r in report.results:
        if r.hard and r.status == "critical":
            blockers.append(
                _problem(
                    "readiness_critical",
                    f"{r.key}: {r.rationale}",
                    check_key=r.key,
                    section_keys=r.section_keys,
                    ids=r.evidence_ids,
                )
            )
        elif r.status in ("critical", "warning"):
            warnings.append(
                _problem(
                    "readiness_warning",
                    f"{r.key}: {r.rationale}",
                    check_key=r.key,
                    section_keys=r.section_keys,
                    ids=r.evidence_ids,
                )
            )
    blockers += await source_permission_problems(db, document, version)
    published = await db.scalar(
        select(DocumentPublication.number).where(DocumentPublication.version_id == version.id)
    )
    if published is not None:
        blockers.append(
            _problem(
                "already_published",
                f"Version {version.number} is already publication {published}",
            )
        )
    return PublishCheckOut(
        document_id=document.id,
        version=version.number,
        content_hash=version.content_hash,
        can_publish=not blockers,
        blockers=blockers,
        warnings=warnings,
        required_sections=required,
        approval_required_sections=scope,
        decider_id=policy.decider_id,
        approved_at=version.approved_at,
        approved_by=version.approved_by,
        readiness=[ReadinessResultOut(**r.model_dump()) for r in report.results],
    )


async def _review_check(ctx: ReadinessContext) -> CheckOutcome:
    """The review invariants as a hard readiness check (for the readiness dashboard)."""
    document = await ctx.db.get(Document, ctx.document_id)
    if ctx.version_id is not None:
        version = await ctx.db.get(DocumentVersion, ctx.version_id)
    else:
        version = await ctx.db.scalar(
            select(DocumentVersion)
            .where(DocumentVersion.document_id == ctx.document_id)
            .order_by(DocumentVersion.number.desc())
            .limit(1)
        )
    if document is None or version is None:
        return CheckOutcome(status="not_applicable", rationale="No version to review")
    states = await section_states(ctx.db, document, version)
    blockers, _, _, _ = await review_problems(ctx.db, document, version, states)
    if not blockers:
        return CheckOutcome(status="pass", rationale="Approvals and required sections are current")
    keys = sorted({k for b in blockers for k in b.section_keys})
    return CheckOutcome(
        status="critical",
        rationale="; ".join(b.message for b in blockers),
        section_keys=keys,
    )


readiness.register_check(REVIEW_CHECK_KEY, _review_check, hard=True)


# --- the transaction ----------------------------------------------------------------


def _iso(value: Any) -> Any:
    return value.isoformat() if hasattr(value, "isoformat") else value


async def _manifest(
    db: AsyncSession,
    principal: "Principal",
    document: Document,
    version: DocumentVersion,
    check: PublishCheckOut,
    note: str | None,
) -> dict[str, Any]:
    from oracle.export.render import SOURCES_KEY, sources_keys
    from oracle.templates.models import Template, TemplateVersion

    policy = await effective_policy(db, document)
    states = await section_states(db, document, version)
    sections = list(
        await db.scalars(
            select(Section).where(Section.version_id == version.id).order_by(Section.ordinal)
        )
    )
    fm = version.front_matter or {}
    template_key = fm.get("template") or document.template
    template_version = str(fm.get("template_version") or document.template_version or "")
    template: dict[str, Any] | None = None
    if template_key:
        row = None
        if template_version.isdigit():
            row = await db.scalar(
                select(TemplateVersion)
                .join(Template, Template.id == TemplateVersion.template_id)
                .where(
                    Template.key == template_key,
                    TemplateVersion.version == int(template_version),
                )
            )
        template = {
            "key": template_key,
            "version": template_version or None,
            "body_sha256": hashlib.sha256(row.body.encode()).hexdigest() if row else None,
            "required_sections": list(row.required_sections or []) if row else [],
        }
    composition = await current_composition(db, document.id)
    citations = list(
        await db.scalars(
            select(Citation).where(Citation.version_id == version.id).order_by(Citation.cite_key)
        )
    )
    links = list(
        await db.scalars(
            select(DocumentSectionLink)
            .where(
                DocumentSectionLink.document_id == document.id,
                (DocumentSectionLink.version_id == version.id)
                | DocumentSectionLink.version_id.is_(None),
            )
            .order_by(DocumentSectionLink.created_at, DocumentSectionLink.id)
        )
    )
    appendix = sources_keys(sections)
    overrides = list(
        await db.scalars(
            select(LlmSuggestion)
            .where(
                LlmSuggestion.document_id == document.id,
                LlmSuggestion.override_reason.is_not(None),
            )
            .order_by(LlmSuggestion.decided_at, LlmSuggestion.id)
        )
    )
    by_key = {s.section_key: s for s in states.sections}
    return {
        "format": MANIFEST_FORMAT,
        "document": {
            "id": str(document.id),
            "slug": document.slug,
            "title": document.title,
            "kind": document.kind,
            "theme": document.theme,
        },
        "version": {
            "id": str(version.id),
            "number": version.number,
            "content_hash": version.content_hash,
            "base_number": version.base_number,
            "brief_source": version.brief_source,
            "imported_by": str(version.imported_by) if version.imported_by else None,
            "imported_at": _iso(version.created_at),
            "source_version_id": str(version.source_version_id)
            if version.source_version_id
            else None,
        },
        "template": template,
        "composition": {
            "revision": composition.number,
            "status": composition.status,
            "modules": composition.modules,
            "decided_by": str(composition.decided_by) if composition.decided_by else None,
            "decided_at": _iso(composition.decided_at),
        }
        if composition
        else None,
        "approval": {
            "approved_at": _iso(version.approved_at),
            "approved_by": str(version.approved_by) if version.approved_by else None,
            "decider_id": str(policy.decider_id) if policy.decider_id else None,
            "mandatory_reviewer_ids": [str(r) for r in policy.mandatory_reviewer_ids],
            "policy_source": policy.source,
        },
        "sections": [
            {
                "section_key": s.section_key,
                "heading": s.heading,
                "layer": s.layer,
                "revision": s.content_hash,
                "status": by_key[s.section_key].status,
                "approval": by_key[s.section_key].approval.model_dump(mode="json")
                if by_key[s.section_key].approval
                else None,
            }
            for s in sections
        ],
        "evidence": {
            "snapshot": version.snapshot,
            "citations": [
                {
                    "cite_key": c.cite_key,
                    "source": c.source,
                    "ref": c.ref,
                    "title": c.title,
                    "excerpt": c.excerpt,
                    "retrieved_at": _iso(c.retrieved_at),
                    "section_keys": sorted(
                        s.section_key for s in sections if c.cite_key in s.citation_keys
                    ),
                }
                for c in citations
            ],
            "section_links": [
                {
                    "id": str(link.id),
                    "section_key": link.section_key,
                    "section_hash": link.section_hash,
                    "kind": link.kind,
                    "precision": link.precision,
                    "claim": link.claim,
                    "entity_id": str(link.entity_id) if link.entity_id else None,
                    "evidence_id": str(link.evidence_id) if link.evidence_id else None,
                    "source_item_id": str(link.source_item_id) if link.source_item_id else None,
                }
                for link in links
            ],
        },
        "appendix": {
            "section_key": SOURCES_KEY if appendix else None,
            "section_keys": [s.section_key for s in sections if s.section_key in appendix],
            "markdown": "\n\n".join(
                f"{'#' * s.level} {s.heading} {{#{s.section_key}}}\n\n{s.body_md}".rstrip()
                for s in sections
                if s.section_key in appendix
            ),
        },
        "overrides": [
            {
                "suggestion_id": str(o.id),
                "feedback_item_id": str(o.feedback_item_id),
                "reason": o.override_reason,
                "pushback": (o.pushback or {}).get("reason"),
                "decided_by": str(o.decided_by) if o.decided_by else None,
                "decided_at": _iso(o.decided_at),
            }
            for o in overrides
        ],
        "readiness": [r.model_dump(mode="json") for r in check.readiness],
        "warnings": [w.model_dump(mode="json") for w in check.warnings],
        "published_by": str(principal.id),
        "note": note,
    }


async def _render(db: AsyncSession, document: Document, number: int) -> dict[str, str | None]:
    from oracle.export.deck import build_deck, render_deck_html
    from oracle.export.render import (
        NoBrief,
        apply_layer,
        load_export_version,
        render_html,
        render_markdown,
    )

    full = apply_layer(await load_export_version(db, str(document.id), number), "full")
    out: dict[str, str | None] = {
        "markdown": render_markdown(full),
        "html_full": render_html(full),
        "html_brief": None,
        "html_deck": None,
    }
    try:
        brief = apply_layer(await load_export_version(db, str(document.id), number), "brief")
        out["html_brief"] = render_html(brief)
        deck = apply_layer(await load_export_version(db, str(document.id), number), "deck")
        out["html_deck"] = render_deck_html(build_deck(deck))
    except NoBrief:
        pass
    return out


def published_markdown(row: DocumentPublication) -> str:
    """The pinned draft with a publication banner after its front matter (it can still
    be re-imported, like the markdown export)."""
    import re

    banner = (
        f"<!-- Product Oracle publication {row.number}: {row.manifest['document']['slug']} "
        f"version {row.version_number}, published {_iso(row.created_at)}, manifest "
        f"{row.manifest_hash} -->\n"
    )
    m = re.compile(r"^---[ \t]*\n.*?^(?:---|\.\.\.)[ \t]*(?:\n|\Z)", re.S | re.M).match(
        row.markdown
    )
    if m:
        return row.markdown[: m.end()] + banner + row.markdown[m.end() :]
    return banner + row.markdown


def manifest_hash(manifest: dict[str, Any], markdown: str) -> str:
    canonical = json.dumps(manifest, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(f"{canonical}\n{markdown}".encode()).hexdigest()


async def publish(
    db: AsyncSession,
    principal: "Principal",
    document: Document,
    version: DocumentVersion,
    *,
    content_hash: str | None,
    note: str | None,
) -> DocumentPublication:
    """Check and publish under the document's row lock. The caller commits."""
    locked = await db.scalar(select(Document).where(Document.id == document.id).with_for_update())
    check = await publish_check(db, locked, version)
    if content_hash is not None and content_hash != version.content_hash:
        raise PublishRefusedError(
            check, "the version's content is not the one you checked; check again"
        )
    if not check.can_publish:
        raise PublishRefusedError(check)
    manifest = await _manifest(db, principal, locked, version, check, note)
    rendered = await _render(db, locked, version.number)
    number = (
        await db.scalar(
            select(func.max(DocumentPublication.number)).where(
                DocumentPublication.document_id == locked.id
            )
        )
        or 0
    ) + 1
    row = DocumentPublication(
        document_id=locked.id,
        number=number,
        version_id=version.id,
        version_number=version.number,
        content_hash=version.content_hash,
        manifest=manifest,
        manifest_hash=manifest_hash(manifest, version.markdown),
        markdown=version.markdown,
        html_full=rendered["html_full"],
        html_brief=rendered["html_brief"],
        html_deck=rendered["html_deck"],
        published_by=principal.id,
    )
    db.add(row)
    try:
        await db.flush()
    except IntegrityError as e:
        await db.rollback()
        raise PublishRefusedError(check, "the version was published concurrently") from e
    await audit.record(
        db,
        principal,
        "document.publish",
        "document_publication",
        row.id,
        {
            "document_id": str(locked.id),
            "version": version.number,
            "publication": number,
            "manifest_hash": row.manifest_hash,
            "approved_by": manifest["approval"]["approved_by"],
            "decider_id": manifest["approval"]["decider_id"],
            "warnings": [w.code for w in check.warnings],
        },
    )
    from oracle.review import collab

    owners = await db.scalars(
        select(SectionReviewState.owner_id).where(SectionReviewState.document_id == locked.id)
    )
    await collab.notify(
        db,
        [version.approved_by, *owners],
        kind="published",
        title=f"{locked.title} v{version.number} was published",
        actor=principal.actor,
        document_id=locked.id,
        version_number=version.number,
        data={"publication": number},
    )
    return row
