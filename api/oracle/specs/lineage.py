"""Artifact versions, provenance and dependencies for specs, flows and wireframes (§11.5).

Every spec document version has exactly one artifact version under its spec request
(kind ``tech_brief`` or ``engineering_spec``). It carries the provenance (PRD version,
requirement ids, run, runner profile, prompt version, or the person who edited it) and the
dependencies that make it ``potentially_stale`` when its PRD sections or requirements
change (``oracle.trace`` marks them through ``oracle.changes``). The spec's markdown lives
once, in its document version (§14); the artifact output ``spec.md`` points at it.

The ``specs.lineage`` change handler runs inside every document import:

- a version a spec run imports (inside :func:`generating`) gets an artifact version with
  the run's provenance and fresh dependencies on the PRD sections and requirements;
- a version a person imports (``oracle push``, the API) gets an artifact version that
  copies the previous one's dependencies as they are (anchors, freshness and the change
  that marked them): an edit does not make a stale spec fresh;
- a new spec document that no spec request owns is refused: every spec has lineage.

Flows and wireframes are stored by :func:`record_design`. Nothing here rewrites an
existing version, output or approval: a new version supersedes older unapproved ones, and
an approved one stays until a newer one is approved.
"""

import hashlib
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.auth.deps import Principal
from oracle.docs.models import Document, DocumentVersion
from oracle.docs.parser import DraftError
from oracle.docs.schemas import ImportProblem
from oracle.specs.design import CheckedOutput
from oracle.trace import outputs as trace_outputs
from oracle.trace import staleness
from oracle.trace.schemas import TraceUpstreamRef
from oracle.v2.models import (
    ArtifactDependency,
    ArtifactOutput,
    ArtifactRequest,
    ArtifactReviewEvent,
    ArtifactVersion,
    ChangeEvent,
)

HANDLER = "specs.lineage"
SPEC_KINDS = ("tech_brief", "engineering_spec")
DESIGN_KINDS = ("user_flow", "wireframe")
# The prompt version recorded in provenance; bump it when the spec prompt changes.
PROMPT_VERSION = "prd_to_spec/1"
# Statuses a newer version supersedes.
OPEN = ("draft", "in_review")


@dataclass
class Generation:
    """What a spec run's import records: set around ``import_draft`` by the importer."""

    request_id: uuid.UUID
    document_slug: str
    source_version_id: uuid.UUID
    upstream: list[TraceUpstreamRef]
    provenance: dict[str, Any] = field(default_factory=dict)
    # Filled by the handler: the artifact version it created.
    artifact_version_id: uuid.UUID | None = None


_generation: ContextVar[Generation | None] = ContextVar("spec_generation", default=None)


@contextmanager
def generating(gen: Generation) -> Iterator[Generation]:
    token = _generation.set(gen)
    try:
        yield gen
    finally:
        _generation.reset(token)


async def request_for_document(db: AsyncSession, document_id: uuid.UUID) -> ArtifactRequest | None:
    return await db.scalar(
        select(ArtifactRequest)
        .where(
            ArtifactRequest.kind.in_(SPEC_KINDS),
            ArtifactRequest.params["document_id"].astext == str(document_id),
        )
        .order_by(ArtifactRequest.created_at)
        .limit(1)
    )


async def version_for_document_version(
    db: AsyncSession, document_version_id: uuid.UUID
) -> ArtifactVersion | None:
    return await db.scalar(
        select(ArtifactVersion).where(
            ArtifactVersion.provenance["document_version_id"].astext == str(document_version_id)
        )
    )


async def next_number(db: AsyncSession, request_id: uuid.UUID) -> int:
    latest = await db.scalar(
        select(func.max(ArtifactVersion.number)).where(ArtifactVersion.request_id == request_id)
    )
    return (latest or 0) + 1


async def supersede_open(db: AsyncSession, request_id: uuid.UUID, keep: uuid.UUID) -> None:
    """Older unapproved versions of the request are superseded by ``keep``."""
    rows = await db.scalars(
        select(ArtifactVersion).where(
            ArtifactVersion.request_id == request_id,
            ArtifactVersion.id != keep,
            ArtifactVersion.status.in_(OPEN),
        )
    )
    for av in rows:
        av.status = "superseded"


async def supersede_approved(db: AsyncSession, approved: ArtifactVersion) -> None:
    """When a version is approved, the earlier (lower-numbered) approved and open ones are
    superseded; newer ones are left alone."""
    rows = await db.scalars(
        select(ArtifactVersion).where(
            ArtifactVersion.request_id == approved.request_id,
            ArtifactVersion.number < approved.number,
            ArtifactVersion.status.in_(("approved", *OPEN)),
        )
    )
    for av in rows:
        av.status = "superseded"


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


async def _copy_dependencies(db: AsyncSession, src: uuid.UUID, dst: uuid.UUID) -> int:
    deps = (
        await db.scalars(
            select(ArtifactDependency).where(ArtifactDependency.artifact_version_id == src)
        )
    ).all()
    for d in deps:
        db.add(
            ArtifactDependency(
                artifact_version_id=dst,
                upstream_version_id=d.upstream_version_id,
                upstream_section_key=d.upstream_section_key,
                upstream_section_hash=d.upstream_section_hash,
                upstream_entity_id=d.upstream_entity_id,
                upstream_snapshot=d.upstream_snapshot,
                upstream_deleted_at=d.upstream_deleted_at,
                composition_revision=d.composition_revision,
                freshness=d.freshness,
                caused_by_change_id=d.caused_by_change_id,
                stale_since=d.stale_since,
                reconciled_by=d.reconciled_by,
                reconciled_at=d.reconciled_at,
                note="carried from the spec version this one edits",
            )
        )
    await db.flush()
    return len(deps)


def _spec_output(av: ArtifactVersion, version: DocumentVersion, slug: str) -> ArtifactOutput:
    return ArtifactOutput(
        version_id=av.id,
        name="spec.md",
        media_type="text/markdown",
        size_bytes=len(version.markdown.encode("utf-8")),
        sha256=_sha(version.markdown),
        content=None,
        # The markdown lives once, in the document version (§14).
        storage_ref=f"document_versions/{version.id}",
        meta={"document": slug, "version": version.number},
    )


async def on_document_version(db: AsyncSession, event: ChangeEvent) -> None:
    """The ``specs.lineage`` handler: lineage for every new spec document version."""
    if event.subject_kind != "document_version" or event.subject_id is None:
        return
    version = await db.get(DocumentVersion, event.subject_id)
    if version is None:
        return
    document = await db.get(Document, version.document_id)
    if document is None or document.kind != "spec":
        return
    gen = _generation.get()
    if gen is not None and gen.document_slug == document.slug:
        request = await db.get(ArtifactRequest, gen.request_id)
        if request is None:
            raise LookupError(f"spec request {gen.request_id} is gone")
        owner = await request_for_document(db, document.id)
        if owner is not None and owner.id != request.id:
            raise DraftError(
                [
                    ImportProblem(
                        code="spec_owned_elsewhere",
                        message=f"spec '{document.slug}' belongs to another spec request",
                    )
                ]
            )
        request.params = {**(request.params or {}), "document_id": str(document.id)}
        av = ArtifactVersion(
            request_id=request.id,
            number=await next_number(db, request.id),
            status="in_review",
            source_version_id=gen.source_version_id,
            content_hash=version.content_hash,
            summary=f"{document.title}, version {version.number}",
            provenance={
                **gen.provenance,
                "origin": "run",
                "document_id": str(document.id),
                "document_version_id": str(version.id),
                "document_version": version.number,
            },
            created_by=version.imported_by,
        )
        db.add(av)
        await db.flush()
        db.add(_spec_output(av, version, document.slug))
        await staleness.add_dependencies(
            db,
            None,  # type: ignore[arg-type]
            artifact_version_id=av.id,
            document_version_id=None,
            upstream=gen.upstream,
        )
        gen.artifact_version_id = av.id
    else:
        request = await request_for_document(db, document.id)
        if request is None:
            raise DraftError(
                [
                    ImportProblem(
                        code="spec_without_request",
                        message="a spec is created from an approved PRD through a spec request "
                        "(POST /v1/spec-requests), so it keeps its lineage; import new versions "
                        "of an existing spec instead",
                    )
                ]
            )
        previous = await db.scalar(
            select(ArtifactVersion)
            .where(ArtifactVersion.request_id == request.id)
            .order_by(ArtifactVersion.number.desc())
            .limit(1)
        )
        av = ArtifactVersion(
            request_id=request.id,
            number=await next_number(db, request.id),
            status="in_review",
            source_version_id=previous.source_version_id if previous else request.source_version_id,
            content_hash=version.content_hash,
            summary=f"{document.title}, version {version.number} (edited)",
            provenance={
                "origin": "edit",
                "edited_by": event.actor,
                "based_on_artifact_version_id": str(previous.id) if previous else None,
                "prd_version_id": (previous.provenance or {}).get("prd_version_id")
                if previous
                else None,
                "requirement_ids": [str(r) for r in request.requirement_ids],
                "document_id": str(document.id),
                "document_version_id": str(version.id),
                "document_version": version.number,
            },
            created_by=version.imported_by,
        )
        db.add(av)
        await db.flush()
        db.add(_spec_output(av, version, document.slug))
        if previous is not None:
            await _copy_dependencies(db, previous.id, av.id)
    await supersede_open(db, request.id, av.id)
    await db.flush()
    await trace_outputs.refresh_aggregates(db, {av.id})
    await audit.record(
        db,
        None,
        "spec.version_recorded",
        "artifact_version",
        av.id,
        {
            "request_id": str(request.id),
            "document_version_id": str(version.id),
            "origin": av.provenance.get("origin"),
            "change_id": str(event.id),
        },
    )


async def record_design(
    db: AsyncSession,
    principal: Principal | None,
    request: ArtifactRequest,
    outputs: list[CheckedOutput],
    *,
    source_version_id: uuid.UUID,
    provenance: dict[str, Any],
    prd_version_id: uuid.UUID,
) -> ArtifactVersion:
    """One artifact version of a flow or wireframe request, with its validated outputs
    and its dependencies on the PRD sections and requirements they link. The caller
    commits."""
    content_hash = _sha("\n".join(f"{o.name}:{o.sha256}" for o in outputs))
    av = ArtifactVersion(
        request_id=request.id,
        number=await next_number(db, request.id),
        status="in_review",
        source_version_id=source_version_id,
        content_hash=content_hash,
        summary=", ".join(o.title for o in outputs)[:500],
        provenance={**provenance, "origin": "run"},
        created_by=principal.id if principal else None,
    )
    db.add(av)
    await db.flush()
    for o in outputs:
        db.add(
            ArtifactOutput(
                version_id=av.id,
                name=o.name,
                media_type=o.media_type,
                size_bytes=o.size_bytes,
                sha256=o.sha256,
                content=o.content,
                meta=o.meta(),
            )
        )
    sections = list(dict.fromkeys(k for o in outputs for k in o.section_keys))
    entities = list(dict.fromkeys(r for o in outputs for r in o.requirement_ids))
    upstream = [TraceUpstreamRef(version_id=prd_version_id, section_key=k) for k in sections] + [
        TraceUpstreamRef(entity_id=uuid.UUID(r)) for r in entities
    ]
    await staleness.add_dependencies(
        db, principal, artifact_version_id=av.id, document_version_id=None, upstream=upstream
    )
    await supersede_open(db, request.id, av.id)
    await db.flush()
    await trace_outputs.refresh_aggregates(db, {av.id})
    return av


def review_event(av: ArtifactVersion, kind: str, actor: str, body: str | None, data: dict):
    return ArtifactReviewEvent(version_id=av.id, kind=kind, body=body, actor=actor, data=data)
