"""The baseline graph API (B1-B3).

Everyone reads (viewer+). Approvers and owners write: a person's (or an API token's)
edit locks the item; ``origin: agent`` writes to a locked item become proposals.
Commenters may only propose (POST /v1/baseline/proposals).
"""

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import JSONResponse, PlainTextResponse
from sqlalchemy import inspect

from oracle.auth.deps import Principal, TenantDB
from oracle.authz import require_role
from oracle.baseline import conflicts, evidence, public_links, scoring, service, trace, yaml_io
from oracle.baseline.models import Edge, Entity
from oracle.baseline.schemas import (
    ConflictCreate,
    ConflictOut,
    ConflictResolve,
    ConflictStatus,
    EdgeCreate,
    EdgeDetail,
    EdgeOut,
    EdgePatch,
    EdgeType,
    EdgeWriteOut,
    EntityCreate,
    EntityDetail,
    EntityOut,
    EntityPatch,
    EntityType,
    EntityWriteOut,
    EvidenceCreate,
    EvidenceLinkCreate,
    EvidenceOut,
    GraphOut,
    LinkErrorOut,
    LinkPreviewOut,
    LinkTarget,
    NodeStatus,
    OriginIn,
    ProposalCreate,
    ProposalDecision,
    ProposalOut,
    ProposalStatus,
    RescoreResult,
    RevisionOut,
    TraceReport,
    WriteOrigin,
    YamlImportError,
    YamlImportResult,
)
from oracle.http import read_capped_body

router = APIRouter(prefix="/v1/baseline", tags=["baseline"])

Reader = Annotated[Principal, Depends(require_role("viewer"))]
Commenter = Annotated[Principal, Depends(require_role("commenter"))]
Approver = Annotated[Principal, Depends(require_role("approver"))]


async def _fresh(db, *rows):
    """Reload server-set columns (created_at, updated_at) expired by a flush."""
    for row in rows:
        if row is not None and inspect(row).expired_attributes:
            await db.refresh(row)


def _fail(exc: service.BaselineError) -> HTTPException:
    return HTTPException(exc.status_code, str(exc))


def _writer(principal: Principal, body: OriginIn | EntityCreate | EdgeCreate) -> service.Writer:
    return service.Writer(principal, body.origin, run_id=body.run_id, reason=body.reason)


async def _entities_out(db, rows: list[Entity]) -> list[EntityOut]:
    await _fresh(db, *rows)
    counts = await service.evidence_counts(db, entity_ids=[e.id for e in rows])
    return [
        EntityOut.model_validate(e).model_copy(update={"evidence_count": counts.get(e.id, 0)})
        for e in rows
    ]


async def _edges_out(db, rows: list[Edge]) -> list[EdgeOut]:
    await _fresh(db, *rows)
    counts = await service.evidence_counts(db, edge_ids=[e.id for e in rows])
    return [
        EdgeOut.model_validate(e).model_copy(update={"evidence_count": counts.get(e.id, 0)})
        for e in rows
    ]


async def _entity_write(db, result: service.WriteResult, created: bool = False) -> JSONResponse:
    await db.commit()
    await _fresh(db, result.proposal)
    body = EntityWriteOut(
        applied=result.applied,
        entity=(await _entities_out(db, [result.entity]))[0] if result.entity else None,
        proposal=ProposalOut.model_validate(result.proposal) if result.proposal else None,
    )
    code = status.HTTP_202_ACCEPTED if result.proposal else (201 if created else 200)
    return JSONResponse(body.model_dump(mode="json"), code)


async def _edge_write(db, result: service.WriteResult, created: bool = False) -> JSONResponse:
    await db.commit()
    await _fresh(db, result.proposal)
    body = EdgeWriteOut(
        applied=result.applied,
        edge=(await _edges_out(db, [result.edge]))[0] if result.edge else None,
        proposal=ProposalOut.model_validate(result.proposal) if result.proposal else None,
    )
    code = status.HTTP_202_ACCEPTED if result.proposal else (201 if created else 200)
    return JSONResponse(body.model_dump(mode="json"), code)


_WRITE_RESPONSES = {202: {"description": "The item is locked: the change became a proposal"}}


# --- graph ---------------------------------------------------------------------------------


@router.get("/graph", response_model=GraphOut)
async def get_graph(principal: Reader, db: TenantDB) -> GraphOut:
    """Every entity and edge (no evidence bodies): what the Baseline screen draws."""
    return GraphOut(
        entities=await _entities_out(db, await service.list_entities(db)),
        edges=await _edges_out(db, await service.list_edges(db)),
    )


# --- entities ------------------------------------------------------------------------------


@router.get("/entities", response_model=list[EntityOut])
async def list_entities(
    principal: Reader,
    db: TenantDB,
    type: EntityType | None = None,
    status: NodeStatus | None = None,
) -> list[EntityOut]:
    return await _entities_out(db, await service.list_entities(db, type, status))


@router.post(
    "/entities",
    response_model=EntityWriteOut,
    status_code=status.HTTP_201_CREATED,
    responses=_WRITE_RESPONSES,
)
async def create_entity(body: EntityCreate, principal: Approver, db: TenantDB) -> JSONResponse:
    try:
        result = await service.create_entity(
            db,
            _writer(principal, body),
            type_=body.type,
            key=body.key,
            title=body.title,
            body=body.body,
            attrs=body.attrs,
            status=body.status,
        )
    except service.BaselineError as exc:
        raise _fail(exc) from exc
    return await _entity_write(db, result, created=True)


@router.get("/entities/{entity_id}", response_model=EntityDetail)
async def get_entity(entity_id: uuid.UUID, principal: Reader, db: TenantDB) -> EntityDetail:
    try:
        entity = await service.get_entity(db, entity_id)
    except service.BaselineError as exc:
        raise _fail(exc) from exc
    edges = await service.list_edges(db, entity_id=entity.id)
    proposals = [p for p in await service.list_proposals(db, "open") if p.entity_id == entity.id]
    base = (await _entities_out(db, [entity]))[0]
    return EntityDetail(
        **base.model_dump(),
        evidence=await evidence.present(
            db, principal, await evidence.list_for(db, entity_id=entity.id)
        ),
        edges_out=await _edges_out(db, [e for e in edges if e.src_id == entity.id]),
        edges_in=await _edges_out(db, [e for e in edges if e.dst_id == entity.id]),
        open_proposals=len(proposals),
    )


@router.patch("/entities/{entity_id}", response_model=EntityWriteOut, responses=_WRITE_RESPONSES)
async def update_entity(
    entity_id: uuid.UUID, body: EntityPatch, principal: Approver, db: TenantDB
) -> JSONResponse:
    changes = body.model_dump(exclude_unset=True, exclude={"origin", "run_id", "reason"})
    try:
        entity = await service.get_entity(db, entity_id)
        result = await service.update_entity(db, _writer(principal, body), entity, changes)
    except service.BaselineError as exc:
        raise _fail(exc) from exc
    return await _entity_write(db, result)


@router.delete(
    "/entities/{entity_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    responses={202: {"model": ProposalOut, "description": "Locked: became a proposal"}},
)
async def delete_entity(
    entity_id: uuid.UUID,
    principal: Approver,
    db: TenantDB,
    origin: WriteOrigin = "user",
    run_id: uuid.UUID | None = None,
) -> Response:
    try:
        entity = await service.get_entity(db, entity_id)
        result = await service.delete_entity(
            db, service.Writer(principal, origin, run_id=run_id), entity
        )
    except service.BaselineError as exc:
        raise _fail(exc) from exc
    await db.commit()
    await _fresh(db, result.proposal)
    if result.proposal:
        return JSONResponse(
            ProposalOut.model_validate(result.proposal).model_dump(mode="json"), 202
        )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/entities/{entity_id}/confirm", response_model=EntityOut)
async def confirm_entity(
    entity_id: uuid.UUID, principal: Approver, db: TenantDB, body: ProposalDecision | None = None
) -> EntityOut:
    """Confirm a proposed entity; goals are confirmed this way only (B2)."""
    return await _set_status(db, principal, entity_id, "confirmed", body)


@router.post("/entities/{entity_id}/reject", response_model=EntityOut)
async def reject_entity(
    entity_id: uuid.UUID, principal: Approver, db: TenantDB, body: ProposalDecision | None = None
) -> EntityOut:
    return await _set_status(db, principal, entity_id, "rejected", body)


async def _set_status(db, principal, entity_id, status_, body) -> EntityOut:
    try:
        entity = await service.get_entity(db, entity_id)
        await service.set_entity_status(db, principal, entity, status_, body.note if body else None)
    except service.BaselineError as exc:
        raise _fail(exc) from exc
    await db.commit()
    return (await _entities_out(db, [entity]))[0]


@router.post("/entities/{entity_id}/unlock", response_model=EntityOut)
async def unlock_entity(entity_id: uuid.UUID, principal: Approver, db: TenantDB) -> EntityOut:
    """Let agents write to it again."""
    try:
        entity = await service.get_entity(db, entity_id)
    except service.BaselineError as exc:
        raise _fail(exc) from exc
    await service.unlock(db, principal, entity)
    await db.commit()
    return (await _entities_out(db, [entity]))[0]


@router.get("/entities/{entity_id}/revisions", response_model=list[RevisionOut])
async def list_entity_revisions(
    entity_id: uuid.UUID,
    principal: Reader,
    db: TenantDB,
    limit: Annotated[int | None, Query(ge=1, le=500)] = None,
) -> list[RevisionOut]:
    """The entity's revisions, newest first; ``limit`` keeps only the newest (Home's trend)."""
    rows = await service.revisions(db, entity_id=entity_id, limit=limit)
    return [RevisionOut.model_validate(r) for r in rows]


# --- edges ----------------------------------------------------------------------------------


@router.get("/edges", response_model=list[EdgeOut])
async def list_edges(
    principal: Reader,
    db: TenantDB,
    type: EdgeType | None = None,
    entity_id: uuid.UUID | None = None,
) -> list[EdgeOut]:
    return await _edges_out(db, await service.list_edges(db, type, entity_id))


@router.post(
    "/edges",
    response_model=EdgeWriteOut,
    status_code=status.HTTP_201_CREATED,
    responses=_WRITE_RESPONSES,
)
async def create_edge(body: EdgeCreate, principal: Approver, db: TenantDB) -> JSONResponse:
    try:
        result = await service.create_edge(
            db,
            _writer(principal, body),
            src_id=body.src_id,
            dst_id=body.dst_id,
            type_=body.type,
            attrs=body.attrs,
            status=body.status,
        )
    except service.BaselineError as exc:
        raise _fail(exc) from exc
    return await _edge_write(db, result, created=True)


@router.get("/edges/{edge_id}", response_model=EdgeDetail)
async def get_edge(edge_id: uuid.UUID, principal: Reader, db: TenantDB) -> EdgeDetail:
    try:
        edge = await service.get_edge(db, edge_id)
    except service.BaselineError as exc:
        raise _fail(exc) from exc
    base = (await _edges_out(db, [edge]))[0]
    return EdgeDetail(
        **base.model_dump(),
        evidence=await evidence.present(
            db, principal, await evidence.list_for(db, edge_id=edge.id)
        ),
    )


@router.patch("/edges/{edge_id}", response_model=EdgeWriteOut, responses=_WRITE_RESPONSES)
async def update_edge(
    edge_id: uuid.UUID, body: EdgePatch, principal: Approver, db: TenantDB
) -> JSONResponse:
    changes = body.model_dump(exclude_unset=True, exclude={"origin", "run_id", "reason"})
    try:
        edge = await service.get_edge(db, edge_id)
        result = await service.update_edge(db, _writer(principal, body), edge, changes)
    except service.BaselineError as exc:
        raise _fail(exc) from exc
    return await _edge_write(db, result)


@router.delete(
    "/edges/{edge_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    responses={202: {"model": ProposalOut, "description": "Locked: became a proposal"}},
)
async def delete_edge(
    edge_id: uuid.UUID,
    principal: Approver,
    db: TenantDB,
    origin: WriteOrigin = "user",
    run_id: uuid.UUID | None = None,
) -> Response:
    try:
        edge = await service.get_edge(db, edge_id)
        result = await service.delete_edge(
            db, service.Writer(principal, origin, run_id=run_id), edge
        )
    except service.BaselineError as exc:
        raise _fail(exc) from exc
    await db.commit()
    await _fresh(db, result.proposal)
    if result.proposal:
        return JSONResponse(
            ProposalOut.model_validate(result.proposal).model_dump(mode="json"), 202
        )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/edges/{edge_id}/unlock", response_model=EdgeOut)
async def unlock_edge(edge_id: uuid.UUID, principal: Approver, db: TenantDB) -> EdgeOut:
    try:
        edge = await service.get_edge(db, edge_id)
    except service.BaselineError as exc:
        raise _fail(exc) from exc
    await service.unlock(db, principal, edge)
    await db.commit()
    return (await _edges_out(db, [edge]))[0]


@router.get("/edges/{edge_id}/revisions", response_model=list[RevisionOut])
async def list_edge_revisions(
    edge_id: uuid.UUID, principal: Reader, db: TenantDB
) -> list[RevisionOut]:
    return [RevisionOut.model_validate(r) for r in await service.revisions(db, edge_id=edge_id)]


# --- evidence -------------------------------------------------------------------------------


@router.get("/evidence", response_model=list[EvidenceOut])
async def list_evidence(
    principal: Reader,
    db: TenantDB,
    entity_id: uuid.UUID | None = None,
    edge_id: uuid.UUID | None = None,
) -> list[EvidenceOut]:
    if (entity_id is None) == (edge_id is None):
        raise HTTPException(422, "pass exactly one of entity_id or edge_id")
    rows = await evidence.list_for(db, entity_id=entity_id, edge_id=edge_id)
    return await evidence.present(db, principal, rows)


@router.post(
    "/entities/{entity_id}/evidence",
    response_model=EvidenceOut,
    status_code=status.HTTP_201_CREATED,
)
async def add_entity_evidence(
    entity_id: uuid.UUID, body: EvidenceCreate, principal: Approver, db: TenantDB
) -> EvidenceOut:
    """Cite one of your own source items (its url, ref and an excerpt are copied), or
    a free-standing url / ref / excerpt."""
    try:
        entity = await service.get_entity(db, entity_id)
        ev = await evidence.attach(db, principal, body, entity=entity)
    except service.BaselineError as exc:
        raise _fail(exc) from exc
    await db.commit()
    await _fresh(db, ev)
    return (await evidence.present(db, principal, [ev]))[0]


@router.post(
    "/edges/{edge_id}/evidence", response_model=EvidenceOut, status_code=status.HTTP_201_CREATED
)
async def add_edge_evidence(
    edge_id: uuid.UUID, body: EvidenceCreate, principal: Approver, db: TenantDB
) -> EvidenceOut:
    try:
        edge = await service.get_edge(db, edge_id)
        ev = await evidence.attach(db, principal, body, edge=edge)
    except service.BaselineError as exc:
        raise _fail(exc) from exc
    await db.commit()
    await _fresh(db, ev)
    return (await evidence.present(db, principal, [ev]))[0]


Fetcher = Annotated[public_links.LinkFetcher, Depends(public_links.get_link_fetcher)]
_LINK_RESPONSES = {
    422: {"model": LinkErrorOut, "description": "The link cannot be used (e.g. not public)"},
    502: {"model": LinkErrorOut, "description": "The page could not be fetched"},
    504: {"model": LinkErrorOut, "description": "The page took too long to respond"},
}


def _link_failed(exc: public_links.LinkError) -> JSONResponse:
    return JSONResponse({"detail": str(exc), "code": exc.code}, exc.status_code)


@router.post("/evidence/link/preview", response_model=LinkPreviewOut, responses=_LINK_RESPONSES)
async def preview_link_evidence(
    body: LinkTarget, principal: Commenter, db: TenantDB, fetcher: Fetcher
) -> LinkPreviewOut | JSONResponse:
    """Fetch a public link and show its title, excerpt and confidence; saves nothing."""
    try:
        return await evidence.preview_link(db, body, fetcher)
    except public_links.LinkError as exc:
        return _link_failed(exc)
    except service.BaselineError as exc:
        raise _fail(exc) from exc


@router.post(
    "/evidence/link",
    response_model=EvidenceOut,
    status_code=status.HTTP_201_CREATED,
    responses=_LINK_RESPONSES,
)
async def add_link_evidence(
    body: EvidenceLinkCreate, principal: Commenter, db: TenantDB, fetcher: Fetcher
) -> EvidenceOut | JSONResponse:
    """Cite a public page (a public Notion page, a Google Doc shared with anyone with
    the link, or a public web page) on an entity or edge. Oracle fetches it without
    any credential and keeps a snapshot; everyone sees it. Commenters and up."""
    try:
        ev = await evidence.add_link(db, principal, body, fetcher)
    except public_links.LinkError as exc:
        return _link_failed(exc)
    except service.BaselineError as exc:
        raise _fail(exc) from exc
    await db.commit()
    await _fresh(db, ev)
    return (await evidence.present(db, principal, [ev]))[0]


@router.post(
    "/evidence/{evidence_id}/refresh", response_model=EvidenceOut, responses=_LINK_RESPONSES
)
async def refresh_link_evidence(
    evidence_id: uuid.UUID, principal: Commenter, db: TenantDB, fetcher: Fetcher
) -> EvidenceOut | JSONResponse:
    """Fetch a public link again: update its snapshot and excerpt, then rescore."""
    try:
        ev = await evidence.refresh_link(db, principal, evidence_id, fetcher)
    except public_links.LinkError as exc:
        return _link_failed(exc)
    except service.BaselineError as exc:
        raise _fail(exc) from exc
    await db.commit()
    await _fresh(db, ev)
    return (await evidence.present(db, principal, [ev]))[0]


@router.delete("/evidence/{evidence_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_evidence(evidence_id: uuid.UUID, principal: Commenter, db: TenantDB) -> Response:
    try:
        await evidence.detach(db, principal, evidence_id)
    except service.BaselineError as exc:
        raise _fail(exc) from exc
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/rescore", response_model=RescoreResult)
async def rescore(principal: Approver, db: TenantDB) -> RescoreResult:
    """Rescore all evidence, e.g. after changing the confidence_weights setting."""
    n_evidence, n_entities, n_edges = await scoring.rescore_all(db)
    await db.commit()
    return RescoreResult(evidence=n_evidence, entities=n_entities, edges=n_edges)


# --- proposals ------------------------------------------------------------------------------


@router.get("/proposals", response_model=list[ProposalOut])
async def list_proposals(
    principal: Reader, db: TenantDB, status: ProposalStatus | None = None
) -> list[ProposalOut]:
    return [ProposalOut.model_validate(p) for p in await service.list_proposals(db, status)]


@router.post("/proposals", response_model=ProposalOut, status_code=status.HTTP_201_CREATED)
async def create_proposal(body: ProposalCreate, principal: Commenter, db: TenantDB) -> ProposalOut:
    """Suggest a change; an approver accepts or rejects it."""
    writer = service.Writer(principal, "agent", run_id=body.run_id, reason=body.reason)
    try:
        proposal = await service.submit_proposal(
            db,
            writer,
            op=body.op,
            kind=body.kind,
            fields=body.fields,
            entity_id=body.entity_id,
            edge_id=body.edge_id,
        )
    except service.BaselineError as exc:
        raise _fail(exc) from exc
    await db.commit()
    await _fresh(db, proposal)
    return ProposalOut.model_validate(proposal)


@router.post("/proposals/{proposal_id}/accept", response_model=ProposalOut)
async def accept_proposal(
    proposal_id: uuid.UUID, principal: Approver, db: TenantDB, body: ProposalDecision | None = None
) -> ProposalOut:
    """Apply the change as your own edit (it locks the item)."""
    return await _decide(db, principal, proposal_id, True, body)


@router.post("/proposals/{proposal_id}/reject", response_model=ProposalOut)
async def reject_proposal(
    proposal_id: uuid.UUID, principal: Approver, db: TenantDB, body: ProposalDecision | None = None
) -> ProposalOut:
    return await _decide(db, principal, proposal_id, False, body)


async def _decide(db, principal, proposal_id, accept, body) -> ProposalOut:
    try:
        proposal = await service.decide_proposal(
            db, proposal_id, principal, accept, body.note if body else None
        )
    except service.BaselineError as exc:
        await db.rollback()
        raise _fail(exc) from exc
    await db.commit()
    await _fresh(db, proposal)
    return ProposalOut.model_validate(proposal)


# --- conflicts ------------------------------------------------------------------------------


@router.get("/conflicts", response_model=list[ConflictOut])
async def list_conflicts(
    principal: Reader,
    db: TenantDB,
    status: ConflictStatus | None = None,
    material: bool | None = None,
) -> list[ConflictOut]:
    return [
        ConflictOut.model_validate(c) for c in await conflicts.list_conflicts(db, status, material)
    ]


@router.post("/conflicts", response_model=ConflictOut, status_code=status.HTTP_201_CREATED)
async def record_conflict(body: ConflictCreate, principal: Approver, db: TenantDB) -> ConflictOut:
    """Record competing claims. Resolved by confidence, then precedence; material ones
    (a feature's status, a goal link, a priority input) stay open for an approver."""
    try:
        conflict = await conflicts.record(
            db,
            principal,
            entity_id=body.entity_id,
            edge_id=body.edge_id,
            field=body.field,
            claims=body.claims,
            run_id=body.run_id,
        )
    except service.BaselineError as exc:
        raise _fail(exc) from exc
    await db.commit()
    await _fresh(db, conflict)
    return ConflictOut.model_validate(conflict)


@router.post("/conflicts/{conflict_id}/resolve", response_model=ConflictOut)
async def resolve_conflict(
    conflict_id: uuid.UUID, body: ConflictResolve, principal: Approver, db: TenantDB
) -> ConflictOut:
    try:
        conflict = await conflicts.resolve(
            db, principal, conflict_id, claim=body.claim, value=body.value, note=body.note
        )
    except service.BaselineError as exc:
        raise _fail(exc) from exc
    await db.commit()
    await _fresh(db, conflict)
    return ConflictOut.model_validate(conflict)


# --- traceability and YAML ------------------------------------------------------------------


@router.get("/trace", response_model=TraceReport)
async def get_trace(principal: Reader, db: TenantDB) -> TraceReport:
    """Features that serve no confirmed goal, or rest on weak evidence; goal coverage."""
    return await trace.report(db)


@router.get(
    "/yaml",
    response_class=PlainTextResponse,
    responses={200: {"content": {"application/yaml": {"schema": {"type": "string"}}}}},
)
async def export_yaml(principal: Reader, db: TenantDB) -> PlainTextResponse:
    """The whole graph (entities, edges, evidence) as YAML."""
    return PlainTextResponse(
        await yaml_io.export(db, principal), media_type="application/yaml; charset=utf-8"
    )


@router.post(
    "/yaml",
    response_model=YamlImportResult,
    responses={
        403: {"model": YamlImportError, "description": "A change the caller's role may not make"},
        413: {"description": "File larger than 1 MiB (ORACLE_MAX_BODY_BYTES)"},
        422: {"model": YamlImportError, "description": "File rejected"},
    },
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {"application/yaml": {"schema": {"type": "string"}}},
        }
    },
)
async def import_yaml(
    request: Request, principal: Approver, db: TenantDB, run_id: uuid.UUID | None = None
) -> YamlImportResult | JSONResponse:
    """Merge a YAML graph in, idempotent by (type, key); locked items get proposals."""
    try:
        text = (await read_capped_body(request)).decode("utf-8")
    except UnicodeDecodeError:
        text = None
    try:
        if text is None:
            raise yaml_io.YamlInvalid([])
        result = await yaml_io.import_yaml(db, principal, text, run_id=run_id)
    except yaml_io.YamlForbidden as exc:
        await db.rollback()
        body = YamlImportError(detail=exc.message, errors=exc.problems)
        return JSONResponse(body.model_dump(mode="json"), 403)
    except yaml_io.YamlInvalid as exc:
        await db.rollback()
        problems = exc.problems or []
        detail = f"file rejected: {len(problems)} problem(s)" if problems else "body must be UTF-8"
        body = YamlImportError(detail=detail, errors=problems)
        return JSONResponse(body.model_dump(mode="json"), 422)
    await db.commit()
    return result
