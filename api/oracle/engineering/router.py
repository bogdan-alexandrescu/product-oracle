"""Tech brief reads (F5-1): ``GET /v1/tech-briefs`` and ``/v1/tech-briefs/{id}``.

Everyone reads (viewer+). A brief is an artifact version of kind ``tech_brief``
(:mod:`oracle.engineering.store` registers them); its content is its ``brief.json``
output. The tenant-scoped session keeps each company to its own briefs (another
company's id is a 404)."""

import json
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.auth.deps import Principal, TenantDB
from oracle.authz import require_role
from oracle.baseline.models import Entity
from oracle.docs import service as docs_service
from oracle.docs.models import Document, DocumentVersion
from oracle.engineering.briefs import Brief, CodeMapUse
from oracle.engineering.schemas import (
    TechBriefAnswer,
    TechBriefFeature,
    TechBriefOut,
    TechBriefPrd,
    TechBriefVerdict,
)
from oracle.engineering.store import KIND
from oracle.trace.outputs import recorded_reasons
from oracle.v2.models import ArtifactDependency, ArtifactOutput, ArtifactRequest, ArtifactVersion

router = APIRouter(prefix="/v1", tags=["engineering"])

Reader = Annotated[Principal, Depends(require_role("viewer"))]


def _404(detail: str) -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, detail)


async def _out(db: AsyncSession, av: ArtifactVersion, req: ArtifactRequest) -> TechBriefOut | None:
    raw = await db.scalar(
        select(ArtifactOutput.content).where(
            ArtifactOutput.version_id == av.id, ArtifactOutput.name == "brief.json"
        )
    )
    if raw is None:
        return None
    body = json.loads(raw)
    brief = Brief.model_validate(body)
    document = await db.get(Document, req.source_document_id)
    number = None
    if req.source_version_id is not None:
        number = await db.scalar(
            select(DocumentVersion.number).where(DocumentVersion.id == req.source_version_id)
        )
    deps = (
        await db.scalars(
            select(ArtifactDependency).where(ArtifactDependency.artifact_version_id == av.id)
        )
    ).all()
    feature_id = await db.scalar(
        select(Entity.id).where(
            Entity.id.in_([d.upstream_entity_id for d in deps if d.upstream_entity_id]),
            Entity.type == "feature",
        )
    )
    reasons: list[str] = []
    for why in (await recorded_reasons(db, list(deps))).values():
        reasons += [r for r in why if r not in reasons]
    verdict = (av.provenance or {}).get("verdict")
    answers = (av.provenance or {}).get("answers") or []
    return TechBriefOut(
        id=av.id,
        request_id=req.id,
        feature=TechBriefFeature(key=brief.feature, title=brief.title, entity_id=feature_id),
        prd=TechBriefPrd(slug=document.slug if document else "", version=number),
        run_id=req.run_id,
        status=av.status,
        code_map=CodeMapUse.model_validate(body.get("code_map") or {"used": False}),
        approach=brief.approach,
        touches=brief.touches,
        reuse=brief.reuse,
        risks=brief.risks,
        questions=brief.questions,
        answers=[TechBriefAnswer.model_validate(a) for a in answers],
        size=brief.size,
        size_why=brief.size_why,
        depends_on=brief.depends_on,
        assumptions=brief.assumptions,
        verdict=TechBriefVerdict.model_validate(verdict) if verdict else None,
        freshness=av.freshness,  # type: ignore[arg-type]
        stale_reasons=reasons,
        created_at=av.created_at,
    )


@router.get("/tech-briefs", response_model=list[TechBriefOut])
async def list_tech_briefs(
    principal: Reader,
    db: TenantDB,
    prd: Annotated[str | None, Query(description="A PRD's slug or id")] = None,
    feature: Annotated[str | None, Query(description="A feature key")] = None,
) -> list[TechBriefOut]:
    """Tech briefs (one per feature, from the Engineering check), the latest version of
    each, optionally of one PRD and one feature: approach, what it touches with code map
    refs, risks, questions and answers, size, the lead's verdict and freshness."""
    query = (
        select(ArtifactVersion, ArtifactRequest)
        .join(ArtifactRequest, ArtifactRequest.id == ArtifactVersion.request_id)
        .where(ArtifactRequest.kind == KIND)
        .order_by(ArtifactRequest.title, ArtifactRequest.created_at, ArtifactVersion.number.desc())
    )
    if prd is not None:
        document = await docs_service.find_document(db, prd)
        if document is None:
            raise _404(f"document '{prd}' not found")
        query = query.where(ArtifactRequest.source_document_id == document.id)
    if feature is not None:
        query = query.where(ArtifactRequest.params["feature_key"].astext == feature)
    out: list[TechBriefOut] = []
    seen: set[uuid.UUID] = set()
    for av, req in (await db.execute(query)).all():
        if req.id in seen:
            continue
        seen.add(req.id)
        view = await _out(db, av, req)
        if view is not None:
            out.append(view)
    return out


@router.get("/tech-briefs/{artifact_version_id}", response_model=TechBriefOut)
async def get_tech_brief(
    artifact_version_id: uuid.UUID, principal: Reader, db: TenantDB
) -> TechBriefOut:
    """One tech brief by its artifact version id."""
    row = (
        await db.execute(
            select(ArtifactVersion, ArtifactRequest)
            .join(ArtifactRequest, ArtifactRequest.id == ArtifactVersion.request_id)
            .where(ArtifactVersion.id == artifact_version_id, ArtifactRequest.kind == KIND)
        )
    ).first()
    view = await _out(db, *row) if row else None
    if view is None:
        raise _404("Tech brief not found")
    return view
