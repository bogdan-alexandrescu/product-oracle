"""Spec requests, the prd_to_spec run's prompt and importer, views, reviews (§11.1-§11.2).

    POST /v1/spec-requests --> spec request (+ flow and wireframe requests) + a draft run
    run (estimate, >$50 approval, start, 1.5x pause: the runs framework) --> spec.md and
    design.json --> import_spec: compose and check the spec, import it as the spec
    document's next version (lineage: oracle.specs.lineage), check and sanitise the
    design, store flows and wireframes as artifact versions --> the eng_review checkpoint
    (E1, toggleable) --> engineering approval of the spec version (the PRD review route,
    with the request's engineering approvers)

Every product requirement comes from the approved PRD by requirement id; everything the
agents propose stays "proposed" until an engineering approver approves its version.
Nothing is ever rewritten: a stale spec, flow or wireframe gets a proposed regeneration
(a draft run), never an automatic one.
"""

import json
import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.auth.deps import Principal
from oracle.auth.models import User
from oracle.authz import has_role
from oracle.baseline.models import Edge, Entity
from oracle.docs import service as docs_service
from oracle.docs.models import Document, DocumentVersion, Section
from oracle.docs.parser import SLUG_RE as PARSER_SLUG_RE
from oracle.docs.parser import DraftError, is_uuid
from oracle.docs.schemas import ImportProblem
from oracle.review import service as review_service
from oracle.runs import service as runs_service
from oracle.runs.flows import MAX_SOURCE_CHARS
from oracle.runs.models import Run
from oracle.runs.schemas import RunCreate
from oracle.specs import contract, lineage
from oracle.specs.capabilities import capability_map
from oracle.specs.design import MAX_FILE_BYTES, check_design
from oracle.specs.sanitize import DOWNLOAD_CSP
from oracle.specs.schemas import (
    AnnotationOut,
    DesignArtifactOut,
    DesignOutputOut,
    DesignReviewIn,
    DesignReviewOut,
    RegenerateIn,
    RegenerationOut,
    RequirementOut,
    SpecOut,
    SpecRequestCreate,
    SpecSectionOut,
    SpecSummary,
    SpecVersionOut,
)
from oracle.swarm.settings import get_runtime_settings
from oracle.tenancy import current_tenant, tenant_session
from oracle.trace import outputs as trace_outputs
from oracle.trace.schemas import TraceUpstreamRef
from oracle.v2.models import (
    ArtifactDependency,
    ArtifactOutput,
    ArtifactRequest,
    ArtifactReviewEvent,
    ArtifactVersion,
    DocumentSectionLink,
)
from oracle.v2.schemas import ArtifactRequestOut, ArtifactReviewEventOut, ArtifactVersionOut

FLOW = "prd_to_spec"


class SpecError(Exception):
    status = 409


class NotFound(SpecError):
    status = 404


class Invalid(SpecError):
    status = 422


class Forbidden(SpecError):
    status = 403


def _now() -> datetime:
    return datetime.now(UTC)


# --------------------------------------------------------------------------- inputs


async def _approved_prd(
    db: AsyncSession, ref: str, number: int | None
) -> tuple[Document, DocumentVersion]:
    document = await docs_service.find_document(db, ref)
    if document is None:
        raise Invalid(f"document '{ref}' not found")
    if document.kind != "prd":
        raise Invalid(f"document '{ref}' is a {document.kind}, not a PRD")
    stmt = select(DocumentVersion).where(DocumentVersion.document_id == document.id)
    if number is not None:
        version = await db.scalar(stmt.where(DocumentVersion.number == number))
        if version is None:
            raise Invalid(f"version {number} of '{document.slug}' not found")
        if version.approved_at is None:
            raise Invalid(
                f"version {number} of '{document.slug}' is not approved: a spec is built from "
                "an approved PRD version"
            )
        return document, version
    version = await db.scalar(
        stmt.where(DocumentVersion.approved_at.is_not(None))
        .order_by(DocumentVersion.number.desc())
        .limit(1)
    )
    if version is None:
        raise Invalid(f"'{document.slug}' has no approved version: approve the PRD first")
    return document, version


async def _section_rows(db: AsyncSession, version_id: uuid.UUID) -> list[Section]:
    return list(
        await db.scalars(
            select(Section).where(Section.version_id == version_id).order_by(Section.ordinal)
        )
    )


async def _linked_sections(
    db: AsyncSession, document_id: uuid.UUID, version_id: uuid.UUID, entity_ids: list[uuid.UUID]
) -> dict[uuid.UUID, list[str]]:
    """PRD section keys that link each requirement (section links on the version, or
    document-wide ones)."""
    if not entity_ids:
        return {}
    rows = await db.execute(
        select(DocumentSectionLink.entity_id, DocumentSectionLink.section_key).where(
            DocumentSectionLink.document_id == document_id,
            DocumentSectionLink.entity_id.in_(entity_ids),
            (DocumentSectionLink.version_id == version_id)
            | DocumentSectionLink.version_id.is_(None),
        )
    )
    out: dict[uuid.UUID, list[str]] = {}
    for entity_id, key in rows.all():
        keys = out.setdefault(entity_id, [])
        if key not in keys:
            keys.append(key)
    return out


async def _requirements(db: AsyncSession, ids: list[uuid.UUID]) -> list[Entity]:
    rows = {e.id: e for e in await db.scalars(select(Entity).where(Entity.id.in_(ids)))}
    missing = [str(i) for i in ids if i not in rows]
    if missing:
        raise Invalid(f"unknown requirements: {', '.join(missing)}")
    wrong = [f"{e.key} ({e.type})" for e in rows.values() if e.type != "requirement"]
    if wrong:
        raise Invalid(f"not requirements: {', '.join(wrong)}")
    rejected = [e.key for e in rows.values() if e.status == "rejected"]
    if rejected:
        raise Invalid(f"rejected requirements cannot be specified: {', '.join(rejected)}")
    return [rows[i] for i in dict.fromkeys(ids)]


async def _acceptance(db: AsyncSession, ids: list[uuid.UUID]) -> dict[uuid.UUID, list[str]]:
    """Acceptance criteria in the baseline that verify each requirement."""
    if not ids:
        return {}
    rows = await db.execute(
        select(Edge.dst_id, Entity.title)
        .join(Entity, Entity.id == Edge.src_id)
        .where(
            Edge.type == "verifies",
            Edge.dst_id.in_(ids),
            Edge.status != "rejected",
            Entity.type == "acceptance_criterion",
            Entity.status != "rejected",
        )
        .order_by(Entity.key)
    )
    out: dict[uuid.UUID, list[str]] = {}
    for dst, title in rows.all():
        out.setdefault(dst, []).append(title)
    return out


async def _check_approvers(db: AsyncSession, ids: list[uuid.UUID]) -> None:
    if not ids:
        return
    users = {u.id: u for u in await db.scalars(select(User).where(User.id.in_(ids)))}
    unknown = [str(i) for i in ids if i not in users]
    if unknown:
        raise Invalid(f"unknown engineering approvers: {', '.join(unknown)}")
    low = [u.email for u in users.values() if not has_role(u.role, "approver")]  # type: ignore[arg-type]
    if low:
        raise Invalid(f"engineering approvers need the approver role: {', '.join(low)}")


def _knobs_for(body_knobs, design: bool):
    """Without design, the designer step is left out (unless the knobs name roles)."""
    knobs = body_knobs.model_copy(deep=True)
    if not design and "spec_draft" not in knobs.roles:
        knobs.roles = {**knobs.roles, "spec_draft": ["architect", "critic"]}
    return knobs


# --------------------------------------------------------------------------- create


async def create_request(
    db: AsyncSession, principal: Principal, body: SpecRequestCreate
) -> tuple[uuid.UUID, uuid.UUID]:
    """(spec request id, draft run id). One transaction: the requests, the run, the audit."""
    prd, version = await _approved_prd(db, body.prd, body.prd_version)
    entities = await _requirements(db, list(body.requirement_ids))
    sections = await _section_rows(db, version.id)
    keys = [s.section_key for s in sections]
    unknown = [k for k in body.section_keys if k not in keys]
    if unknown:
        raise Invalid(f"sections not in {prd.slug} v{version.number}: {', '.join(unknown)}")
    linked = await _linked_sections(db, prd.id, version.id, [e.id for e in entities])
    # E1: the spec lists under "Decided in the approved PRD" only requirements that PRD
    # version adopted (a section link on it, or a document-wide one).
    outside = [e.key for e in entities if not linked.get(e.id)]
    if outside:
        verb = "is" if len(outside) == 1 else "are"
        raise Invalid(f"{', '.join(outside)} {verb} not in PRD v{version.number}")
    wanted = set(body.section_keys) | {k for ks in linked.values() for k in ks if k in keys}
    if not wanted:
        raise Invalid(
            "name the PRD sections the spec covers (section_keys): no section of "
            f"{prd.slug} v{version.number} links these requirements"
        )
    section_keys = [k for k in keys if k in wanted]
    feature = None
    if body.feature_id is not None:
        feature = await db.get(Entity, body.feature_id)
        if feature is None or feature.type != "feature":
            raise Invalid("feature_id is not a baseline feature")
    await _check_approvers(db, list(body.engineering_approver_ids))

    subject = feature.title if feature else entities[0].title
    kind = "tech_brief" if body.depth == "brief" else "engineering_spec"
    noun = "technical brief" if body.depth == "brief" else "engineering spec"
    title = body.title or f"{subject}: {noun}"
    if body.document:
        if await docs_service.find_document(db, body.document) is not None:
            raise Invalid(
                f"document '{body.document}' exists: regenerate its spec request instead "
                "(POST /v1/spec-requests/{id}/regenerate)"
            )
        slug = body.document
        if not PARSER_SLUG_RE.fullmatch(slug):
            raise Invalid("a document slug is lowercase letters, digits and dashes")
    else:
        slug = await runs_service._free_slug(db, f"{prd.slug}-{contract.slugify(subject, 40)}-spec")

    request = ArtifactRequest(
        kind=kind,
        title=title,
        source_document_id=prd.id,
        source_version_id=version.id,
        requirement_ids=[e.id for e in entities],
        section_keys=section_keys,
        params={
            "document_slug": slug,
            "depth": body.depth,
            "design": body.design,
            "screens": body.screens,
            "feature_id": str(feature.id) if feature else None,
            "engineering_approver_ids": [str(i) for i in body.engineering_approver_ids],
        },
        status="queued",
        requested_by=principal.id,
    )
    db.add(request)
    await db.flush()
    children: dict[str, str] = {}
    if body.design:
        for child_kind, label in (("user_flow", "User flows"), ("wireframe", "Wireframes")):
            child = ArtifactRequest(
                kind=child_kind,
                title=f"{subject}: {label.lower()}",
                source_document_id=prd.id,
                source_version_id=version.id,
                requirement_ids=[e.id for e in entities],
                section_keys=section_keys,
                params={"parent_request_id": str(request.id), "screens": body.screens},
                status="queued",
                requested_by=principal.id,
            )
            db.add(child)
            await db.flush()
            children[child_kind] = str(child.id)
    request.params = {**request.params, "design_request_ids": children}
    try:
        run_id = await runs_service.create_run(
            db,
            principal,
            RunCreate(
                flow=FLOW,
                document=slug,
                source=str(prd.id),
                source_version=version.number,
                knobs=_knobs_for(body.knobs, body.design),
            ),
            entry_knobs={"artifact_request_id": str(request.id)},
            commit=False,
        )
    except runs_service.RunError as exc:
        raise Invalid(str(exc)) from exc
    for r in await _family(db, request):
        r.run_id = run_id
    await audit.record(
        db,
        principal,
        "spec.requested",
        "artifact_request",
        request.id,
        {
            "prd_version_id": str(version.id),
            "requirement_ids": [str(e.id) for e in entities],
            "section_keys": section_keys,
            "depth": body.depth,
            "design": body.design,
            "run_id": str(run_id),
        },
    )
    await db.commit()
    return request.id, run_id


async def _family(db: AsyncSession, request: ArtifactRequest) -> list[ArtifactRequest]:
    """The spec request and its flow and wireframe requests."""
    ids = [uuid.UUID(i) for i in ((request.params or {}).get("design_request_ids") or {}).values()]
    children = list(await db.scalars(select(ArtifactRequest).where(ArtifactRequest.id.in_(ids))))
    return [request, *children]


async def _spec_request(db: AsyncSession, request_id: uuid.UUID) -> ArtifactRequest:
    request = await db.get(ArtifactRequest, request_id)
    if request is None or request.kind not in lineage.SPEC_KINDS:
        raise NotFound("spec request not found")
    return request


# --------------------------------------------------------------------------- the run


async def _run_request(db: AsyncSession, run: Run) -> ArtifactRequest | None:
    raw = (run.knobs or {}).get("artifact_request_id")
    if not raw or not is_uuid(raw):
        return None
    return await db.get(ArtifactRequest, uuid.UUID(raw))


def _regeneration_for(request: ArtifactRequest, run: Run | None) -> dict[str, Any] | None:
    """The proposed regeneration ``run`` carries out, if it is one: its PRD version and
    sections apply to the request only when its run imports."""
    regen = (request.params or {}).get("regeneration") or {}
    if run is None or regen.get("run_id") != str(run.id) or not regen.get("prd_version_id"):
        return None
    return regen


async def _apply_regeneration(db: AsyncSession, request: ArtifactRequest, run: Run) -> None:
    regen = _regeneration_for(request, run)
    if regen is None:
        return
    for r in await _family(db, request):
        r.source_version_id = uuid.UUID(regen["prd_version_id"])
        r.section_keys = list(regen["section_keys"])


async def _inputs(
    db: AsyncSession,
    request: ArtifactRequest,
    run: Run | None,
    source_version_id: uuid.UUID | None = None,
) -> tuple[contract.SpecInputs, Document, DocumentVersion]:
    section_keys = list(request.section_keys)
    regen = _regeneration_for(request, run)
    if regen is not None and source_version_id is None:
        source_version_id = uuid.UUID(regen["prd_version_id"])
        section_keys = list(regen["section_keys"])
    version = await db.get(DocumentVersion, source_version_id or request.source_version_id)
    if version is None:
        raise Invalid("the PRD version this spec is built from no longer exists")
    prd = await db.get(Document, version.document_id)
    assert prd is not None
    sections = {s.section_key: s.heading for s in await _section_rows(db, version.id)}
    entities = {
        e.id: e
        for e in await db.scalars(select(Entity).where(Entity.id.in_(request.requirement_ids)))
    }
    linked = await _linked_sections(db, prd.id, version.id, list(entities))
    acceptance = await _acceptance(db, list(entities))
    params = request.params or {}
    feature = None
    if params.get("feature_id"):
        f = await db.get(Entity, uuid.UUID(params["feature_id"]))
        feature = f.title if f else None
    cmap = await capability_map(db)
    reqs = tuple(
        contract.RequirementRef(
            id=str(e.id),
            key=e.key,
            title=e.title,
            statement=e.body,
            section_keys=tuple(k for k in linked.get(e.id, []) if k in sections),
            acceptance=tuple(acceptance.get(e.id, [])),
        )
        for i in request.requirement_ids
        if (e := entities.get(i)) is not None
    )
    inputs = contract.SpecInputs(
        slug=params.get("document_slug") or "",
        title=request.title,
        depth=params.get("depth") or "brief",
        prd_slug=prd.slug,
        prd_title=prd.title,
        prd_version=version.number,
        sections=tuple((k, sections[k]) for k in section_keys if k in sections),
        requirements=reqs,
        capability_map=cmap is not None,
        prd_approved_at=version.approved_at,
        request_id=str(request.id),
        run_id=str(run.id) if run else None,
        feature=feature,
    )
    return inputs, prd, version


DESIGN_FORMAT = (
    'design.json: {"version": 1, "flows": [...], "wireframes": [...]}. A flow: name '
    '("<words>.svg"), title, svg (an SVG document), section_keys, requirement_ids, '
    'annotations. A wireframe: name ("<words>.html"), title, screen, html (the screen\'s '
    "HTML), section_keys, requirement_ids, annotations. An annotation: id (a-z, 0-9, -), "
    "target (an element id, or a data-annotation value, in the file), note, section_key, "
    "requirement_ids. Every section key and requirement id must be one listed above."
)
DESIGN_RULES = (
    "Wireframes are grayscale and low fidelity: boxes, labels, form controls and "
    "placeholder text; no colour, images, icons or brand styling. They are static: no "
    "scripts, no event handlers, no links except #fragments, no external URLs, fonts, "
    "images, frames or stylesheets, no CSS url() or @import. Oracle refuses a file that "
    "has any of these. Mark mocked behaviour as such in the screen's text."
)


async def prompt_lines(db: AsyncSession, run: Run) -> list[str]:
    """The prd_to_spec prompt: the spec contract, the requirements, the PRD version."""
    request = await _run_request(db, run)
    if request is None:
        return ["No spec request is attached to this run: write nothing."]
    try:
        inputs, prd, version = await _inputs(db, request, run)
    except Invalid as exc:
        return [f"{exc}: write nothing."]
    params = request.params or {}
    design = bool(params.get("design", True))
    noun = "technical brief" if inputs.depth == "brief" else "full engineering spec"
    lines = [
        f"Spec: a {noun}, '{inputs.title}', from approved PRD '{prd.title}' ({prd.slug}) "
        f"version {version.number}. Read it with get_document_markdown(doc={prd.slug}, "
        f"version={version.number}); it is below too.",
        "",
        "Product requirements (decided in the PRD; Oracle writes them into the spec, do not "
        "restate or change them):",
    ]
    for r in inputs.requirements:
        where = f" (PRD sections: {', '.join(r.section_keys)})" if r.section_keys else ""
        lines.append(f"- {r.id} {r.key}: {r.title}{where}")
        if r.statement:
            lines.append(f"  {r.statement.strip()[:500]}")
        for a in r.acceptance:
            lines.append(f"  Acceptance criterion: {a}")
    lines += [
        "PRD sections this spec covers: " + ", ".join(f"{k} ({h})" for k, h in inputs.sections),
        "",
        "spec.md: markdown, a {#id} on every heading, these sections in this order "
        "(Oracle adds the title, the requirements, the full-version heading and Sources):",
    ]
    for s in contract.agent_sections(inputs.depth):
        lines.append(f"- ## {s.title} {{#{s.key}}}: {s.guidance}")
    lines.append(
        "Everything you write is a proposal: the engineering approach is not decided until "
        "an engineering approver approves the version. No citations or evidence in the body."
    )
    if not inputs.capability_map:
        lines.append(
            "No code capability map is available: you cannot check the current code. State "
            "every assumption about existing code, systems and data in Assumptions, and do not "
            "present them as facts."
        )
    lines.append("")
    if design:
        lines += [
            f"Design (O2): one or more SVG user flows and {params.get('screens', 3)} "
            "low-fidelity wireframes of the key screens the requirements need. Each one links "
            "the exact PRD sections and requirement ids it shows, and annotates what a "
            "reviewer should check.",
            DESIGN_FORMAT,
            DESIGN_RULES,
        ]
    else:
        lines.append(
            'Design: not requested. Write design.json as {"version": 1, "flows": [], '
            '"wireframes": []}.'
        )
    machine = {
        "requirement_ids": [r.id for r in inputs.requirements],
        "section_keys": [k for k, _ in inputs.sections],
        "depth": inputs.depth,
        "design": design,
        "screens": params.get("screens", 3),
    }
    regen = params.get("regeneration") or {}
    if regen:
        lines += ["", "This run regenerates the spec after upstream changes. Address them:"]
        if regen.get("reason"):
            lines.append(f"- Reason given: {regen['reason']}")
        lines += [f"- {r}" for r in regen.get("reasons") or []]
    lines += ["", "Spec inputs (JSON): " + json.dumps(machine)]
    text = version.markdown[:MAX_SOURCE_CHARS]
    lines += ["", f"--- PRD {prd.slug} v{version.number} ---", text]
    if len(text) < len(version.markdown):
        lines.append("(truncated: read the rest with get_document_markdown)")
    return lines


def _provenance(run: Run, request: ArtifactRequest, version: DocumentVersion) -> dict[str, Any]:
    """Run provenance (§16.24): never a credential."""
    settings = get_runtime_settings()
    return {
        "run_id": str(run.id),
        "flow": run.flow,
        "runner_profile": settings.swarmcloud_profile,
        "runtime": settings.runtime,
        "prompt_version": lineage.PROMPT_VERSION,
        "prd_version_id": str(version.id),
        "prd_document_id": str(version.document_id),
        "prd_version": version.number,
        "requirement_ids": [str(r) for r in request.requirement_ids],
        "section_keys": list(request.section_keys),
        "source_snapshot_id": str(run.snapshot_id) if run.snapshot_id else None,
    }


async def import_spec(
    db: AsyncSession, run: Run, files: dict[str, str], principal: Principal
) -> dict[str, Any]:
    """The prd_to_spec importer: compose and import spec.md, then check and store
    design.json, in the run creator's name and its own transactions."""
    tenant_id = current_tenant(db)
    async with tenant_session(tenant_id) as s:
        request = await _run_request(s, run)
        if request is None:
            return {"error": "the run names no spec request"}
        run_row = await s.get(Run, run.id)
        try:
            inputs, prd, version = await _inputs(s, request, run_row or run)
        except Invalid as exc:
            return {"error": str(exc)}
        # A proposed regeneration moves the request to its PRD version now, as it imports.
        await _apply_regeneration(s, request, run_row or run)
        await s.flush()
        provenance = _provenance(run_row or run, request, version)
        params = request.params or {}
        # Plain ids: a refused import rolls the session back and expires its objects.
        request_id, version_id = request.id, version.id
        out: dict[str, Any] = {"kind": "spec", "slug": inputs.slug, "request_id": str(request_id)}

        composed = contract.compose(files.get("spec.md") or "", inputs)
        out["spec_check"] = [p.as_json() for p in composed.problems]
        if "spec.md" not in files:
            composed.markdown = None
            out["spec_check"].append(
                {"code": "missing_file", "message": "the run left no spec.md", "severity": "error"}
            )
        spec_ok = composed.ok and "spec.md" in files
        if spec_ok:
            upstream = [
                TraceUpstreamRef(version_id=version_id, section_key=k)
                for k in dict.fromkeys(
                    [k for k, _ in inputs.sections]
                    + [k for r in inputs.requirements for k in r.section_keys]
                )
            ] + [TraceUpstreamRef(entity_id=uuid.UUID(r.id)) for r in inputs.requirements]
            gen = lineage.Generation(
                request_id=request_id,
                document_slug=inputs.slug,
                source_version_id=version_id,
                upstream=upstream,
                provenance=provenance,
            )
            try:
                with lineage.generating(gen):
                    result = await docs_service.import_draft(
                        s, inputs.slug, composed.markdown or "", principal, kind="spec"
                    )
            except DraftError as exc:
                await s.rollback()
                problems = "; ".join(f"[{p.code}] {p.message}" for p in exc.problems)
                out["error"] = f"spec.md was rejected: {problems}"
                spec_ok = False
            except (docs_service.NotFoundError, docs_service.ImportConflictError) as exc:
                await s.rollback()
                out["error"] = f"spec.md was not imported: {exc}"
                spec_ok = False
            else:
                out.update(
                    document_id=str(result.version.document_id),
                    version=result.version.number,
                    created=result.created,
                    artifact_version_id=str(gen.artifact_version_id)
                    if gen.artifact_version_id
                    else None,
                )
                if not result.created:
                    out["note"] = (
                        "the spec text is identical to version "
                        f"{result.version.number}; no new version was written"
                    )
        else:
            errors = "; ".join(
                f"[{p['code']}] {p['message']}"
                for p in out["spec_check"]
                if p["severity"] == "error"
            )
            out["error"] = f"spec.md was rejected: {errors}"

        # Fresh objects after import_draft's commit.
        request = await s.get(ArtifactRequest, request_id)
        assert request is not None
        # Again: a refused spec import rolled the session back.
        run_row = await s.get(Run, run.id)
        await _apply_regeneration(s, request, run_row or run)
        design_status = "skipped"
        if params.get("design", True):
            check = check_design(
                files.get("design.json"),
                prd_sections={k for k, _ in await _section_keys(s, version_id)},
                requirement_ids={str(r) for r in request.requirement_ids},
                screens=int(params.get("screens") or 3),
            )
            out["design"] = check.as_json()
            design_status = "failed"
            if check.ok:
                created = {}
                for child in (await _family(s, request))[1:]:
                    outputs = check.flows if child.kind == "user_flow" else check.wireframes
                    if not outputs:
                        continue
                    av = await lineage.record_design(
                        s,
                        principal,
                        child,
                        outputs,
                        source_version_id=version_id,
                        provenance=provenance,
                        prd_version_id=version_id,
                    )
                    child.status = "succeeded"
                    created[child.kind] = str(av.id)
                    await audit.record(
                        s,
                        principal,
                        "spec.design_recorded",
                        "artifact_version",
                        av.id,
                        {"request_id": str(child.id), "outputs": [o.name for o in outputs]},
                    )
                out["design"]["artifact_versions"] = created
                design_status = "succeeded"
            else:
                for child in (await _family(s, request))[1:]:
                    child.status = "failed"
        if spec_ok and design_status in ("succeeded", "skipped"):
            request.status = "succeeded"
        elif spec_ok or design_status == "succeeded":
            request.status = "partial"
        else:
            request.status = "failed"
        await s.commit()
    return out


async def _section_keys(db: AsyncSession, version_id: uuid.UUID) -> list[tuple[str, str]]:
    return [(s.section_key, s.heading) for s in await _section_rows(db, version_id)]


# --------------------------------------------------------------------------- edits


async def check_edit(
    db: AsyncSession,
    request: ArtifactRequest,
    previous: ArtifactVersion | None,
    markdown: str,
) -> None:
    """E1: an edit of a spec version (the API, ``push_draft``, ``oracle push``) may change
    only its engineering parts and add sections. The sections Oracle writes (requirements,
    the decided half of the acceptance criteria, sources, the title and its intro, the
    "Full version" heading), their levels, order and brief listing, the labels on the
    engineering sections and the ``spec`` front matter must read as in the version Oracle
    wrote from the PRD version, or as the version the edit replaces has them; otherwise the
    edit is refused (DraftError, 422), naming what changed."""
    versions = await _versions(db, request.id)
    by_run = next(
        (v for v in reversed(versions) if (v.provenance or {}).get("origin") == "run"), None
    )
    run_id = (by_run.provenance or {}).get("run_id") if by_run else None
    run = await db.get(Run, uuid.UUID(run_id)) if run_id and is_uuid(run_id) else None
    source_version_id = by_run.source_version_id if by_run else None
    try:
        inputs, _, version = await _inputs(db, request, run, source_version_id)
    except Invalid as exc:
        raise DraftError([ImportProblem(code="spec_inputs", message=str(exc))]) from exc
    allowed: list[dict[str, object]] = []
    # As Oracle wrote them from the PRD version (not from today's baseline, which may
    # have moved on since), then as the version this edit replaces has them.
    for av in (by_run, previous):
        if av is not None and (dv_id := _doc_version_id(av)) is not None:
            dv = await db.get(DocumentVersion, dv_id)
            if dv is not None:
                allowed.append(contract.prd_parts(dv.markdown))
    if not allowed:
        allowed.append(contract.expected_prd_parts(inputs))
    submitted = contract.prd_parts(markdown)
    if submitted in allowed:
        return
    changed = min(
        (
            sorted(k for k in set(a) | set(submitted) if a.get(k) != submitted.get(k))
            for a in allowed
        ),
        key=len,
    )
    raise DraftError(
        [
            ImportProblem(
                code="prd_part_changed",
                message=f"Product requirements come from PRD v{version.number}. "
                f"Change them in the PRD. {_CHANGED.get(key, _CHANGED[None]).format(key=key)}",
                section_key=key if key in contract.ORACLE_PARTS else None,
            )
            for key in changed or [None]
        ]
    )


_CHANGED: dict[str | None, str] = {
    None: "The edit changes a part Oracle writes.",
    "front_matter": "The edit changes the spec: front matter (source and requirement ids).",
    "order": "Oracle's sections (spec, requirements, full, acceptance-criteria, sources) "
    "keep their place relative to each other.",
    "brief": "The brief: list keeps listing Oracle's sections (requirements).",
    "labels": "Engineering sections keep their Proposed or Assumed label, and the "
    "assumptions their note.",
    contract.TITLE_ID: "The title section and its intro (the approved PRD and version) are "
    "Oracle's.",
}
_CHANGED.update(
    {
        k: "The '{key}' section is Oracle's: its heading, level and text stay as written."
        for k in contract.PRD_PARTS + (contract.FULL_ID,)
    }
)


# --------------------------------------------------------------------------- views


async def _versions(db: AsyncSession, request_id: uuid.UUID) -> list[ArtifactVersion]:
    return list(
        await db.scalars(
            select(ArtifactVersion)
            .where(ArtifactVersion.request_id == request_id)
            .order_by(ArtifactVersion.number)
        )
    )


def _doc_version_id(av: ArtifactVersion) -> uuid.UUID | None:
    raw = (av.provenance or {}).get("document_version_id")
    return uuid.UUID(raw) if raw and is_uuid(raw) else None


async def _lineage(db: AsyncSession, avs: list[ArtifactVersion]):
    """TraceOutput per artifact version id (dependencies, freshness, reasons)."""
    if not avs:
        return {}
    deps = list(
        await db.scalars(
            select(ArtifactDependency).where(
                ArtifactDependency.artifact_version_id.in_([a.id for a in avs])
            )
        )
    )
    reasons = await trace_outputs.recorded_reasons(db, deps)
    views = await trace_outputs.describe(db, deps, reasons)
    return {v.artifact_version_id: v for v in views}


def _approved(av: ArtifactVersion, dv: DocumentVersion | None) -> bool:
    return av.status == "approved" or (dv is not None and dv.approved_at is not None)


async def _summary(db: AsyncSession, request: ArtifactRequest) -> SpecSummary:
    params = request.params or {}
    doc_id = params.get("document_id")
    document = await db.get(Document, uuid.UUID(doc_id)) if doc_id and is_uuid(doc_id) else None
    sources = await docs_service.version_sources(db, [request.source_version_id])
    avs = await _versions(db, request.id)
    latest = avs[-1] if avs else None
    dv = await db.get(DocumentVersion, _doc_version_id(latest)) if latest else None
    return SpecSummary(
        request=ArtifactRequestOut.model_validate(request),
        document_slug=document.slug if document else params.get("document_slug"),
        document_id=document.id if document else None,
        prd=sources.get(request.source_version_id),  # type: ignore[arg-type]
        depth=params.get("depth") or "brief",
        latest_version=dv.number if dv else None,
        approach_status=("approved" if _approved(latest, dv) else "proposed") if latest else None,
        freshness=latest.freshness if latest else None,
    )


async def list_requests(db: AsyncSession, prd: str | None = None) -> list[SpecSummary]:
    stmt = select(ArtifactRequest).where(ArtifactRequest.kind.in_(lineage.SPEC_KINDS))
    if prd is not None:
        document = await docs_service.find_document(db, prd)
        if document is None:
            return []
        stmt = stmt.where(ArtifactRequest.source_document_id == document.id)
    rows = await db.scalars(stmt.order_by(ArtifactRequest.created_at.desc()))
    return [await _summary(db, r) for r in rows]


def _content_url(av_id: uuid.UUID, name: str) -> str:
    return f"/v1/design-artifacts/{av_id}/outputs/{name}"


async def _design_view(
    db: AsyncSession, request: ArtifactRequest, av: ArtifactVersion, lineage_view=None
) -> DesignArtifactOut:
    outputs = list(
        await db.scalars(
            select(ArtifactOutput)
            .where(ArtifactOutput.version_id == av.id)
            .order_by(ArtifactOutput.name)
        )
    )
    events = list(
        await db.scalars(
            select(ArtifactReviewEvent)
            .where(ArtifactReviewEvent.version_id == av.id)
            .order_by(ArtifactReviewEvent.created_at, ArtifactReviewEvent.id)
        )
    )
    by_annotation: dict[tuple[str, str], list[ArtifactReviewEventOut]] = {}
    general: list[ArtifactReviewEventOut] = []
    for e in events:
        out = ArtifactReviewEventOut.model_validate(e)
        key = ((e.data or {}).get("output"), (e.data or {}).get("annotation_id"))
        if key[0] and key[1]:
            by_annotation.setdefault(key, []).append(out)  # type: ignore[arg-type]
        else:
            general.append(out)
    if lineage_view is None:
        lineage_view = (await _lineage(db, [av])).get(av.id)
    return DesignArtifactOut(
        request_id=request.id,
        kind=request.kind,  # type: ignore[arg-type]
        title=request.title,
        version=ArtifactVersionOut.model_validate(av),
        outputs=[
            DesignOutputOut(
                name=o.name,
                title=(o.meta or {}).get("title"),
                screen=(o.meta or {}).get("screen"),
                media_type=o.media_type,
                size_bytes=o.size_bytes,
                sha256=o.sha256,
                section_keys=(o.meta or {}).get("section_keys") or [],
                requirement_ids=(o.meta or {}).get("requirement_ids") or [],
                annotations=[
                    AnnotationOut(**a, reviews=by_annotation.get((o.name, a["id"]), []))
                    for a in (o.meta or {}).get("annotations") or []
                ],
                removed=((o.meta or {}).get("sanitized") or {}).get("removed") or [],
                content_url=_content_url(av.id, o.name),
            )
            for o in outputs
        ],
        reviews=general,
        lineage=lineage_view,
    )


async def read_spec(db: AsyncSession, request_id: uuid.UUID) -> SpecOut:
    request = await _spec_request(db, request_id)
    summary = await _summary(db, request)
    params = request.params or {}
    entities = {
        e.id: e
        for e in await db.scalars(select(Entity).where(Entity.id.in_(request.requirement_ids)))
    }
    linked: dict[uuid.UUID, list[str]] = {}
    version = await db.get(DocumentVersion, request.source_version_id)
    if version is not None:
        linked = await _linked_sections(
            db, version.document_id, version.id, list(request.requirement_ids)
        )
    requirements = [
        RequirementOut(
            id=i,
            key=e.key if e else None,
            title=e.title if e else None,
            status=e.status if e else None,
            section_keys=linked.get(i, []),
            missing=e is None,
        )
        for i in request.requirement_ids
        for e in [entities.get(i)]
    ]
    avs = await _versions(db, request.id)
    family = await _family(db, request)
    design_avs: dict[uuid.UUID, list[ArtifactVersion]] = {
        child.id: await _versions(db, child.id) for child in family[1:]
    }
    everything = avs + [a for v in design_avs.values() for a in v]
    views = await _lineage(db, everything)
    dvs = {
        dv.id: dv
        for dv in await db.scalars(
            select(DocumentVersion).where(
                DocumentVersion.id.in_([i for i in map(_doc_version_id, avs) if i])
            )
        )
    }
    versions = []
    for av in avs:
        dv = dvs.get(_doc_version_id(av))  # type: ignore[arg-type]
        approved = _approved(av, dv)
        versions.append(
            SpecVersionOut(
                artifact_version=ArtifactVersionOut.model_validate(av),
                document_version=dv.number if dv else None,
                document_version_id=dv.id if dv else None,
                approach_status="approved" if approved else "proposed",
                approved_by=(av.approved_by or (dv.approved_by if dv else None)),
                approved_at=(av.approved_at or (dv.approved_at if dv else None)),
                origin=(av.provenance or {}).get("origin"),
            )
        )
    sections: list[SpecSectionOut] = []
    if versions and versions[-1].document_version_id:
        latest_approved = versions[-1].approach_status == "approved"
        for s in await _section_rows(db, versions[-1].document_version_id):
            part = contract.part_of(s.section_key)
            sections.append(
                SpecSectionOut(
                    key=s.section_key,
                    heading=s.heading,
                    layer=s.layer,
                    part=part,
                    decided=part in ("product_requirement", "context")
                    or (latest_approved and part != "proposed"),
                )
            )
    design = []
    for child in family[1:]:
        latest = design_avs.get(child.id) or []
        if latest:
            design.append(await _design_view(db, child, latest[-1], views.get(latest[-1].id)))
    stale = [
        v
        for a in everything
        if (v := views.get(a.id)) is not None
        and v.freshness != "fresh"
        and a.status not in ("superseded", "rejected")
    ]
    run = await db.get(Run, request.run_id) if request.run_id else None
    cmap = await capability_map(db)
    return SpecOut(
        **summary.model_dump(),
        requirements=requirements,
        section_keys=list(request.section_keys),
        engineering_approver_ids=params.get("engineering_approver_ids") or [],
        code_capability_map="used" if cmap is not None else "unavailable",
        versions=versions,
        sections=sections,
        design=design,
        stale=stale,
        run_id=run.id if run else None,
        run_status=run.status if run else None,
    )


async def _design_version(
    db: AsyncSession, version_id: uuid.UUID
) -> tuple[ArtifactVersion, ArtifactRequest]:
    av = await db.get(ArtifactVersion, version_id)
    request = await db.get(ArtifactRequest, av.request_id) if av else None
    if av is None or request is None or request.kind not in lineage.DESIGN_KINDS:
        raise NotFound("design artifact version not found")
    return av, request


async def read_design(db: AsyncSession, version_id: uuid.UUID) -> DesignArtifactOut:
    av, request = await _design_version(db, version_id)
    return await _design_view(db, request, av)


async def design_output(db: AsyncSession, version_id: uuid.UUID, name: str) -> tuple[str, str]:
    """(content, media type) of a stored, sanitised design output."""
    av, _ = await _design_version(db, version_id)
    output = await db.scalar(
        select(ArtifactOutput).where(
            ArtifactOutput.version_id == av.id, ArtifactOutput.name == name
        )
    )
    if output is None or output.content is None or output.size_bytes > MAX_FILE_BYTES:
        raise NotFound(f"output {name!r} not found")
    return output.content, output.media_type


DOWNLOAD_HEADERS = {
    "Content-Security-Policy": DOWNLOAD_CSP,
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "private, no-store",
}


# --------------------------------------------------------------------------- reviews


def _approval_audit(principal: Principal, request: ArtifactRequest) -> dict[str, Any]:
    """E1: with no engineering approvers named, the requester may approve their own spec
    (as with PRDs); every approval says whether it was one."""
    named = (request.params or {}).get("engineering_approver_ids") or []
    return {
        "requested_by": str(request.requested_by) if request.requested_by else None,
        "engineering_approvers_named": bool(named),
        "self_approval": request.requested_by is not None and principal.id == request.requested_by,
    }


def _may_approve_engineering(principal: Principal, request: ArtifactRequest) -> bool:
    named = [str(i) for i in (request.params or {}).get("engineering_approver_ids") or []]
    if principal.role == "owner":
        return True
    if not has_role(principal.role, "approver"):  # type: ignore[arg-type]
        return False
    return not named or str(principal.id) in named


async def review_design(
    db: AsyncSession, principal: Principal, version_id: uuid.UUID, body: DesignReviewIn
) -> DesignReviewOut:
    av, request = await _design_version(db, version_id)
    parent_id = (request.params or {}).get("parent_request_id")
    parent = await db.get(ArtifactRequest, uuid.UUID(parent_id)) if parent_id else None
    data: dict[str, Any] = {}
    if body.annotation_id is not None or body.output is not None:
        if body.annotation_id is None or body.output is None:
            raise Invalid("name both the output and the annotation_id")
        output = await db.scalar(
            select(ArtifactOutput).where(
                ArtifactOutput.version_id == av.id, ArtifactOutput.name == body.output
            )
        )
        ids = (
            [a.get("id") for a in ((output.meta or {}).get("annotations") or [])] if output else []
        )
        if body.annotation_id not in ids:
            raise Invalid(f"no annotation {body.annotation_id!r} on {body.output!r}")
        data = {"output": body.output, "annotation_id": body.annotation_id}
    if body.kind != "comment":
        if data:
            raise Invalid("a verdict is on the version: approve, reject or request changes on it")
        if not _may_approve_engineering(principal, parent or request):
            raise Forbidden("only the spec's engineering approvers (or an owner) decide on it")
        if av.status in ("superseded", "rejected"):
            raise SpecError(f"version {av.number} is {av.status}")
        if body.kind == "approved" and av.freshness == "potentially_stale":
            raise SpecError(
                "the version may be stale: review or reconcile it (POST /v1/trace/staleness/"
                "actions), or regenerate it, before approving"
            )
        if body.kind in ("changes_requested", "rejected") and not (body.body or "").strip():
            raise Invalid("say why: a note is required to request changes or reject")
    elif not (body.body or "").strip():
        raise Invalid("a comment needs a body")
    event = lineage.review_event(av, body.kind, principal.actor, body.body, data)
    db.add(event)
    if body.kind == "approved":
        av.status = "approved"
        av.approved_by = principal.id
        av.approved_at = _now()
        await lineage.supersede_approved(db, av)
    elif body.kind == "rejected":
        av.status = "rejected"
    elif body.kind == "changes_requested" and av.status == "draft":
        av.status = "in_review"
    await db.flush()
    await audit.record(
        db,
        principal,
        f"spec.design_{body.kind}",
        "artifact_version",
        av.id,
        {
            "request_id": str(request.id),
            **data,
            **(_approval_audit(principal, parent or request) if body.kind == "approved" else {}),
        },
    )
    await db.commit()
    await db.refresh(event)
    await db.refresh(av)
    return DesignReviewOut(
        event=ArtifactReviewEventOut.model_validate(event),
        version=ArtifactVersionOut.model_validate(av),
    )


async def approve_version(
    session: AsyncSession, principal: Principal, doc: str, n: int
) -> tuple[Document, DocumentVersion]:
    """The PRD review's approval route on a spec version: the engineering approval of its
    proposed approach. Only the request's engineering approvers (or an owner) may, and not
    while the version may be stale. Then the PRD behaviour (approved_at, document status)
    applies, and its artifact version is approved."""
    version = await review_service.get_version(session, doc, n)
    av = await lineage.version_for_document_version(session, version.id)
    request = await session.get(ArtifactRequest, av.request_id) if av else None
    if av is None or request is None:
        raise review_service.ReviewError(
            "invalid", "this spec version has no lineage; it cannot be approved"
        )
    if not _may_approve_engineering(principal, request):
        raise review_service.ReviewError(
            "forbidden", "only the spec's engineering approvers (or an owner) approve its approach"
        )
    if av.status in ("superseded", "rejected"):
        raise review_service.ReviewError(
            "invalid", f"this spec version is {av.status}: approve the current version"
        )
    if av.freshness == "potentially_stale":
        raise review_service.ReviewError(
            "invalid",
            "this spec version may be stale: review or reconcile it (POST /v1/trace/staleness/"
            "actions), or regenerate it, before approving its approach",
        )
    document, version = await review_service.approve_version(session, principal, doc, n)
    if av.status != "approved":
        av.status = "approved"
        av.approved_by = principal.id
        av.approved_at = version.approved_at
        session.add(lineage.review_event(av, "approved", principal.actor, None, {}))
        await lineage.supersede_approved(session, av)
        await audit.record(
            session,
            principal,
            "spec.approach_approved",
            "artifact_version",
            av.id,
            {
                "request_id": str(request.id),
                "document_version_id": str(version.id),
                **_approval_audit(principal, request),
            },
        )
    await session.flush()
    return document, version


async def is_spec(session: AsyncSession, doc: str) -> bool:
    document = await docs_service.find_document(session, doc)
    return document is not None and document.kind == "spec"


# --------------------------------------------------------------------------- regenerate


async def regenerate(
    db: AsyncSession, principal: Principal, request_id: uuid.UUID, body: RegenerateIn
) -> RegenerationOut:
    """Propose a regeneration: a draft run on the latest approved PRD version (or the one
    named). Nothing is rewritten; the run writes new versions for review."""
    request = await _spec_request(db, request_id)
    if request.source_version_id is None:
        raise Invalid("the PRD version this spec was built from no longer exists")
    current = await db.get(DocumentVersion, request.source_version_id)
    assert current is not None
    prd, version = await _approved_prd(db, str(request.source_document_id), body.prd_version)
    if version.number < current.number:
        raise Invalid(
            f"{prd.slug} v{version.number} is older than v{current.number}, the version this "
            "spec is built from: regenerate from it or a newer approved version"
        )
    run = await db.get(Run, request.run_id) if request.run_id else None
    if run is not None and run.status not in ("succeeded", "failed", "cancelled"):
        raise SpecError(f"run {run.id} is still {run.status}: finish or cancel it first")
    keys = [s.section_key for s in await _section_rows(db, version.id)]
    kept = [k for k in request.section_keys if k in keys]
    dropped = [k for k in request.section_keys if k not in keys]
    if not kept:
        raise Invalid(
            f"none of the spec's PRD sections is in {prd.slug} v{version.number}: "
            "start a new spec request"
        )
    stale_views = [
        v
        for v in (
            await _lineage(
                db, [a for r in await _family(db, request) for a in await _versions(db, r.id)]
            )
        ).values()
        if v.freshness != "fresh"
    ]
    reasons = list(dict.fromkeys(r for v in stale_views for r in v.reasons))
    params = request.params or {}
    # Nothing on the request changes until the run imports (_apply_regeneration): a
    # proposal that is never started, or is cancelled, leaves the spec as it was.
    regeneration = {
        "reason": body.reason,
        "reasons": reasons[:20],
        "from_prd_version": current.number,
        "prd_version": version.number,
        "prd_version_id": str(version.id),
        "section_keys": kept,
    }
    document_id = params.get("document_id")
    try:
        run_id = await runs_service.create_run(
            db,
            principal,
            RunCreate(
                flow=FLOW,
                document=document_id or params.get("document_slug"),
                source=str(prd.id),
                source_version=version.number,
                knobs=_knobs_for(body.knobs, bool(params.get("design", True))),
            ),
            entry_knobs={"artifact_request_id": str(request.id)},
            commit=False,
        )
    except runs_service.RunError as exc:
        raise Invalid(str(exc)) from exc
    for r in await _family(db, request):
        r.run_id = run_id
    request.params = {**params, "regeneration": {**regeneration, "run_id": str(run_id)}}
    await audit.record(
        db,
        principal,
        "spec.regeneration_proposed",
        "artifact_request",
        request.id,
        {
            "run_id": str(run_id),
            "from_prd_version": current.number,
            "prd_version": version.number,
            "dropped_section_keys": dropped,
            "reason": body.reason,
        },
    )
    await db.commit()
    return RegenerationOut(
        request_id=request.id,
        run_id=run_id,
        prd_version=version.number,
        section_keys=kept,
        dropped_section_keys=dropped,
        reasons=reasons,
    )
