"""Regenerate (#482): one route shape for every document kind with a flow behind it.

``POST /v1/documents/{doc}/regenerate/estimate`` makes a draft run of the kind's flow on
the document and estimates it (the inputs it will use, the cost, whether an owner must
approve it); ``POST /v1/documents/{doc}/regenerate`` starts that run through the same cost
gates as starting any run (over the threshold it waits for an owner; the 1.5x overrun
pause applies). The run imports its result as the document's next version: earlier
versions stay in history and diffs.

- PRD: Baseline to PRD on the PRD;
- roadmap: PRD to roadmap from the PRD its latest version was built from;
- tech brief (spec): the spec request's proposed regeneration (oracle.specs);
- update: Update draft (an owner's, as starting one is).
"""

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.auth.deps import Principal
from oracle.docs.models import Document, DocumentVersion
from oracle.runs import service as runs_service
from oracle.runs.models import Run
from oracle.runs.schemas import RunCreate
from oracle.trash.service import Forbidden, Invalid, NotFound

FLOWS = {"prd": "baseline_to_prd", "roadmap": "prd_to_roadmap", "spec": "prd_to_spec",
         "update": "update_draft"}  # fmt: skip


async def _document(db: AsyncSession, doc: str) -> Document:
    from oracle.docs import service as docs_service

    document = await docs_service.find_document(db, doc)
    if document is None:
        raise NotFound(f"document '{doc}' not found")
    return document


async def _may_regenerate(db: AsyncSession, principal: Principal, document: Document) -> None:
    """The document's decider (whatever their role) or any approver regenerates it."""
    from oracle.authz import has_role
    from oracle.review.state import effective_policy

    if has_role(principal.role, "approver"):
        return
    decider = (await effective_policy(db, document)).decider_id
    if decider is None or principal.user_id != decider:
        raise Forbidden("Only the document's decider or an approver can regenerate it")


async def _latest(db: AsyncSession, document: Document) -> DocumentVersion | None:
    return await db.scalar(
        select(DocumentVersion)
        .where(DocumentVersion.document_id == document.id)
        .order_by(DocumentVersion.number.desc())
        .limit(1)
    )


async def _source_of(db: AsyncSession, document: Document) -> tuple[Document, DocumentVersion]:
    """The document (and version) the latest version of ``document`` was built from."""
    latest = await _latest(db, document)
    source = None
    if latest is not None and latest.source_version_id is not None:
        source = await db.get(DocumentVersion, latest.source_version_id)
    parent = await db.get(Document, source.document_id) if source is not None else None
    if source is None or parent is None:
        raise Invalid(f"'{document.slug}' has no PRD it was built from to regenerate it from")
    return parent, source


async def _spec_request_id(db: AsyncSession, document: Document) -> uuid.UUID:
    """The spec request whose import wrote this tech brief (its provenance)."""
    from oracle.v2.models import ArtifactVersion

    versions = await db.scalars(
        select(DocumentVersion.id).where(DocumentVersion.document_id == document.id)
    )
    request_id = await db.scalar(
        select(ArtifactVersion.request_id)
        .where(
            ArtifactVersion.provenance["document_version_id"].astext.in_([str(v) for v in versions])
        )
        .order_by(ArtifactVersion.created_at.desc())
        .limit(1)
    )
    if request_id is None:
        raise Invalid(f"'{document.slug}' has no spec request to regenerate it from")
    return request_id


def _spec_error(exc: Exception) -> Exception:
    error = Invalid(str(exc))
    error.status = getattr(exc, "status", Invalid.status)
    return error


async def _regenerates(db: AsyncSession, document: Document, run: Run) -> bool:
    """Whether ``run`` is a draft regeneration of ``document``."""
    if run.flow != FLOWS.get(document.kind):
        return False
    if document.kind == "spec":
        wanted = str(await _spec_request_id(db, document))
        return str((run.knobs or {}).get("artifact_request_id")) == wanted
    return run.document_id == document.id


async def estimate(
    db: AsyncSession, principal: Principal, doc: str, note: str | None
) -> dict[str, Any]:
    document = await _document(db, doc)
    await _may_regenerate(db, principal, document)
    flow = FLOWS.get(document.kind)
    if flow is None:
        raise Invalid(f"no flow regenerates a {document.kind}: edit it instead")
    inputs = [f"{document.title} ({document.slug}), its latest version"]
    oracle_knobs = {"regenerate_note": note} if note else None
    if document.kind == "spec":
        from oracle.specs import service as specs_service
        from oracle.specs.schemas import RegenerateIn

        # Only the draft run to estimate: the regeneration is proposed when it starts.
        request_id = await _spec_request_id(db, document)
        try:
            run_id, prd_version = await specs_service.regeneration_draft(
                db, principal, request_id, RegenerateIn(reason=note)
            )
        except specs_service.SpecError as exc:
            raise _spec_error(exc) from exc
        inputs.append(f"The approved PRD, version {prd_version}")
    else:
        body: dict[str, Any] = {"flow": flow, "document": document.slug}
        if document.kind == "roadmap":
            prd, version = await _source_of(db, document)
            body["source"] = prd.slug
            inputs.append(f"{prd.title} ({prd.slug}), its latest approved version")
        run_id = await runs_service.create_run(
            db, principal, RunCreate(**body), oracle_knobs=oracle_knobs
        )
    out = await runs_service.estimate(db, principal, run_id)
    await audit.record(
        db,
        principal,
        "document.regenerate_estimate",
        "document",
        document.id,
        {"run_id": str(run_id), "flow": flow, "estimate_usd": out.total_usd, "note": note},
    )
    await db.commit()
    return {
        "run_id": run_id,
        "document_slug": document.slug,
        "kind": document.kind,
        "flow": flow,
        "inputs": inputs,
        "estimate_usd": out.total_usd,
        "approval_threshold_usd": out.approval_threshold_usd,
        "needs_owner_approval": out.needs_approval,
        "note": note,
    }


async def start(
    db: AsyncSession, principal: Principal, doc: str, run_id: uuid.UUID, note: str | None
) -> uuid.UUID:
    document = await _document(db, doc)
    await _may_regenerate(db, principal, document)
    run = await db.scalar(select(Run).where(Run.id == run_id))
    if run is None or not await _regenerates(db, document, run):
        raise NotFound(f"no regeneration of '{document.slug}' with run {run_id}")
    if document.kind == "spec":
        from oracle.specs import service as specs_service
        from oracle.specs.schemas import RegenerateIn

        # The spec's own proposal (its reason reaches the agents): made only now.
        try:
            await specs_service.regenerate(
                db,
                principal,
                uuid.UUID(run.knobs["artifact_request_id"]),
                RegenerateIn(reason=note),
                run_id=run_id,
            )
        except specs_service.SpecError as exc:
            raise _spec_error(exc) from exc
    elif note:
        run.knobs = {**(run.knobs or {}), "regenerate_note": note}
    await runs_service.start(db, principal, run_id)
    await audit.record(
        db,
        principal,
        "document.regenerate",
        "document",
        document.id,
        {"run_id": str(run_id), "flow": run.flow, "note": note},
    )
    await db.commit()
    await runs_service.submit_queued(db, run_id)
    return run_id
