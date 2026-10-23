"""The baseline graph API (B1-B3).

Everyone reads (viewer+). Approvers and owners write: a person's (or an API token's)
edit locks the item; ``origin: agent`` writes to a locked item become proposals.
Commenters may only propose (POST /v1/baseline/proposals).
"""

import uuid
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import JSONResponse, PlainTextResponse
from sqlalchemy import inspect

from oracle import autonomy
from oracle.auth.deps import Principal, TenantDB
from oracle.authz import recheck_caller, require_role, require_role_now
from oracle.baseline import (
    conflicts,
    describe,
    evidence,
    measurements,
    public_links,
    scoring,
    service,
    trace,
    yaml_io,
)
from oracle.baseline.models import Edge, Entity, Proposal
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
    FillFromTextResult,
    GraphOut,
    LinkErrorOut,
    LinkPreviewOut,
    LinkTarget,
    MeasurementCreate,
    MeasurementOut,
    NodeStatus,
    OriginIn,
    ProposalCreate,
    ProposalDecision,
    ProposalOut,
    ProposalStatus,
    RescoreResult,
    ReviewStatusOut,
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
ApproverNow = Annotated[Principal, Depends(require_role_now("approver"))]
# H11: a run's propose_change while the baseline is at observe.
OBSERVING_BASELINE = "Oracle is set to observe the baseline"


async def _fresh(db, *rows):
    """Reload server-set columns (created_at, updated_at) expired by a flush."""
    for row in rows:
        if row is not None and inspect(row).expired_attributes:
            await db.refresh(row)


def _fail(exc: service.BaselineError) -> Exception:
    if isinstance(exc, service.GoalFieldsInvalid):
        # The app renders it: {"detail", "errors": [{code, message, where}]} (B5).
        return service.GoalFieldsInvalid(exc.problems)
    return HTTPException(exc.status_code, str(exc))


def _run_of(principal: Principal, run_id: uuid.UUID | None) -> uuid.UUID | None:
    """The run a write records: a run token's own (it may not name another run); a
    person or an API token names any run, or none."""
    if principal.run_id is None:
        return run_id
    if run_id is not None and run_id != principal.run_id:
        raise HTTPException(422, "a run can only propose for itself")
    return principal.run_id


def _writer(principal: Principal, body: OriginIn | EntityCreate | EdgeCreate) -> service.Writer:
    return service.Writer(
        principal, body.origin, run_id=_run_of(principal, body.run_id), reason=body.reason
    )


_PROPOSAL_COLUMNS = (
    "id", "entity_id", "edge_id", "payload", "run_id", "actor", "status", "decided_by",
    "decided_at", "created_at",
)  # fmt: skip


async def _proposals_out(db, rows: list[Proposal]) -> list[ProposalOut]:
    """ProposalOut with the run that made each, its sentence and who made it (B4), built
    in one pass for the whole list."""
    runs = await service.proposal_runs(db, (p.run_id for p in rows))
    sentences = await describe.summaries(db, rows)
    who = await describe.proposers(db, rows, runs)
    return [
        ProposalOut(
            **{c: getattr(p, c) for c in _PROPOSAL_COLUMNS},
            run=runs.get(p.run_id),
            summary=sentences[p.id],
            proposer=who[p.id],
        )
        for p in rows
    ]


async def _proposal_out(db, row: Proposal | None) -> ProposalOut | None:
    return (await _proposals_out(db, [row]))[0] if row is not None else None


async def _entities_out(
    db, rows: list[Entity], principal: Principal | None = None
) -> list[EntityOut]:
    await _fresh(db, *rows)
    counts = await service.evidence_counts(db, entity_ids=[e.id for e in rows])
    view = await evidence.run_view(db, principal, entity_ids=[e.id for e in rows])
    out = []
    for e in rows:
        o = EntityOut.model_validate(e).model_copy(update={"evidence_count": counts.get(e.id, 0)})
        if view is not None:
            o = o.model_copy(update={"confidence": view.confidence("entity", e.id)})
        out.append(o)
    return out


async def _edges_out(db, rows: list[Edge], principal: Principal | None = None) -> list[EdgeOut]:
    await _fresh(db, *rows)
    counts = await service.evidence_counts(db, edge_ids=[e.id for e in rows])
    view = await evidence.run_view(db, principal, edge_ids=[e.id for e in rows])
    out = []
    for e in rows:
        o = EdgeOut.model_validate(e).model_copy(update={"evidence_count": counts.get(e.id, 0)})
        if view is not None:
            o = o.model_copy(update={"confidence": view.confidence("edge", e.id)})
        out.append(o)
    return out


async def _entity_write(db, result: service.WriteResult, created: bool = False) -> JSONResponse:
    await db.commit()
    await _fresh(db, result.proposal)
    body = EntityWriteOut(
        applied=result.applied,
        entity=(await _entities_out(db, [result.entity]))[0] if result.entity else None,
        proposal=await _proposal_out(db, result.proposal),
    )
    code = status.HTTP_202_ACCEPTED if result.proposal else (201 if created else 200)
    return JSONResponse(body.model_dump(mode="json"), code)


async def _edge_write(db, result: service.WriteResult, created: bool = False) -> JSONResponse:
    await db.commit()
    await _fresh(db, result.proposal)
    body = EdgeWriteOut(
        applied=result.applied,
        edge=(await _edges_out(db, [result.edge]))[0] if result.edge else None,
        proposal=await _proposal_out(db, result.proposal),
    )
    code = status.HTTP_202_ACCEPTED if result.proposal else (201 if created else 200)
    return JSONResponse(body.model_dump(mode="json"), code)


_WRITE_RESPONSES = {202: {"description": "The item is locked: the change became a proposal"}}
_ENTITY_WRITE_RESPONSES = {
    **_WRITE_RESPONSES,
    422: {"model": YamlImportError, "description": "Goal fields rejected (B5), every problem"},
}


# --- graph ---------------------------------------------------------------------------------


@router.get("/graph", response_model=GraphOut)
async def get_graph(principal: Reader, db: TenantDB) -> GraphOut:
    """Every entity and edge (no evidence bodies): what the Baseline screen draws."""
    return GraphOut(
        entities=await _entities_out(db, await service.list_entities(db), principal),
        edges=await _edges_out(db, await service.list_edges(db), principal),
    )


@router.get("/review-status", response_model=ReviewStatusOut)
async def get_baseline_review_status(principal: Reader, db: TenantDB) -> ReviewStatusOut:
    """Whether a new PRD run may use the current baseline instead of rebuilding it: the
    last baseline review, its age, whether a baseline build is under way, and the
    baseline segment's estimate per depth (B1 "Reuse base")."""
    from oracle.runs import reuse

    st = await reuse.review_status(db)
    return ReviewStatusOut(
        last_approved_at=st.last_approved_at,
        checkpoint_id=st.checkpoint_id,
        run_id=st.run_id,
        age_days=st.age_days,
        build_under_way=st.build_under_way,
        reusable=st.reusable,
        reason=st.reason,  # type: ignore[arg-type]
        baseline_segment_usd=st.baseline_segment_usd,  # type: ignore[arg-type]
    )


# --- entities ------------------------------------------------------------------------------


@router.get("/entities", response_model=list[EntityOut])
async def list_entities(
    principal: Reader,
    db: TenantDB,
    type: EntityType | None = None,
    status: NodeStatus | None = None,
) -> list[EntityOut]:
    return await _entities_out(db, await service.list_entities(db, type, status), principal)


@router.post(
    "/entities",
    response_model=EntityWriteOut,
    status_code=status.HTTP_201_CREATED,
    responses=_ENTITY_WRITE_RESPONSES,
)
async def create_entity(body: EntityCreate, principal: ApproverNow, db: TenantDB) -> JSONResponse:
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
    base = (await _entities_out(db, [entity], principal))[0]
    rows = await evidence.present(db, principal, await evidence.list_for(db, entity_id=entity.id))
    return EntityDetail(
        **base.model_dump(exclude={"confidence"}),
        confidence=evidence.as_read(principal, base.confidence, rows),
        evidence=rows,
        edges_out=await _edges_out(db, [e for e in edges if e.src_id == entity.id], principal),
        edges_in=await _edges_out(db, [e for e in edges if e.dst_id == entity.id], principal),
        open_proposals=len(proposals),
    )


@router.patch(
    "/entities/{entity_id}", response_model=EntityWriteOut, responses=_ENTITY_WRITE_RESPONSES
)
async def update_entity(
    entity_id: uuid.UUID, body: EntityPatch, principal: ApproverNow, db: TenantDB
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
    principal: ApproverNow,
    db: TenantDB,
    origin: WriteOrigin = "user",
    run_id: uuid.UUID | None = None,
) -> Response:
    try:
        entity = await service.get_entity(db, entity_id)
        result = await service.delete_entity(
            db, service.Writer(principal, origin, run_id=_run_of(principal, run_id)), entity
        )
    except service.BaselineError as exc:
        raise _fail(exc) from exc
    await db.commit()
    await _fresh(db, result.proposal)
    if result.proposal:
        return JSONResponse((await _proposal_out(db, result.proposal)).model_dump(mode="json"), 202)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/entities/{entity_id}/confirm", response_model=EntityOut)
async def confirm_entity(
    entity_id: uuid.UUID, principal: ApproverNow, db: TenantDB, body: ProposalDecision | None = None
) -> EntityOut:
    """Confirm a proposed entity; goals are confirmed this way only (B2)."""
    return await _set_status(db, principal, entity_id, "confirmed", body)


@router.post("/entities/{entity_id}/reject", response_model=EntityOut)
async def reject_entity(
    entity_id: uuid.UUID, principal: ApproverNow, db: TenantDB, body: ProposalDecision | None = None
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
async def unlock_entity(entity_id: uuid.UUID, principal: ApproverNow, db: TenantDB) -> EntityOut:
    """Let agents write to it again."""
    try:
        entity = await service.get_entity(db, entity_id)
    except service.BaselineError as exc:
        raise _fail(exc) from exc
    await service.unlock(db, principal, entity)
    await db.commit()
    return (await _entities_out(db, [entity]))[0]


# --- goal measurements and Fill from text (B5) ------------------------------------------


@router.get("/entities/{entity_id}/measurements", response_model=list[MeasurementOut])
async def list_goal_measurements(
    entity_id: uuid.UUID, principal: Reader, db: TenantDB
) -> list[MeasurementOut]:
    """A goal's dated values, latest day first."""
    try:
        rows = await measurements.list_for(db, entity_id)
    except service.BaselineError as exc:
        raise _fail(exc) from exc
    return [MeasurementOut.model_validate(r) for r in rows]


@router.post(
    "/entities/{entity_id}/measurements",
    response_model=MeasurementOut,
    status_code=status.HTTP_201_CREATED,
)
async def record_goal_measurement(
    entity_id: uuid.UUID, body: MeasurementCreate, principal: ApproverNow, db: TenantDB
) -> MeasurementOut:
    """Record a goal's value on a day (a second on the same day replaces it); the latest
    by day becomes the goal's ``current``. 422 when the entity is not a goal, the goal has
    no unit yet, or the day is in the future."""
    try:
        row = await measurements.record(
            db,
            principal,
            entity_id,
            value=body.value,
            measured_on=body.measured_on,
            note=body.note,
            evidence_id=body.evidence_id,
        )
    except service.BaselineError as exc:
        raise _fail(exc) from exc
    await db.commit()
    await db.refresh(row)
    return MeasurementOut.model_validate(row)


@router.delete("/measurements/{measurement_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_goal_measurement(
    measurement_id: uuid.UUID, principal: ApproverNow, db: TenantDB
) -> Response:
    try:
        await measurements.delete(db, principal, measurement_id)
    except service.BaselineError as exc:
        raise _fail(exc) from exc
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/goals/fill-from-text", response_model=FillFromTextResult)
async def fill_goals_from_text(principal: ApproverNow, db: TenantDB) -> FillFromTextResult:
    """Read each goal's ``*_text`` values (Home's rules, no model call) and write what they
    say as an Oracle write: applied to an unlocked goal, a proposal on a locked one."""
    try:
        result = await measurements.fill_from_text(db, principal)
    except service.BaselineError as exc:
        raise _fail(exc) from exc
    await db.commit()
    return FillFromTextResult(**result)


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
    return await _edges_out(db, await service.list_edges(db, type, entity_id), principal)


@router.post(
    "/edges",
    response_model=EdgeWriteOut,
    status_code=status.HTTP_201_CREATED,
    responses=_WRITE_RESPONSES,
)
async def create_edge(body: EdgeCreate, principal: ApproverNow, db: TenantDB) -> JSONResponse:
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
    base = (await _edges_out(db, [edge], principal))[0]
    rows = await evidence.present(db, principal, await evidence.list_for(db, edge_id=edge.id))
    return EdgeDetail(
        **base.model_dump(exclude={"confidence"}),
        confidence=evidence.as_read(principal, base.confidence, rows),
        evidence=rows,
    )


@router.patch("/edges/{edge_id}", response_model=EdgeWriteOut, responses=_WRITE_RESPONSES)
async def update_edge(
    edge_id: uuid.UUID, body: EdgePatch, principal: ApproverNow, db: TenantDB
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
    principal: ApproverNow,
    db: TenantDB,
    origin: WriteOrigin = "user",
    run_id: uuid.UUID | None = None,
) -> Response:
    try:
        edge = await service.get_edge(db, edge_id)
        result = await service.delete_edge(
            db, service.Writer(principal, origin, run_id=_run_of(principal, run_id)), edge
        )
    except service.BaselineError as exc:
        raise _fail(exc) from exc
    await db.commit()
    await _fresh(db, result.proposal)
    if result.proposal:
        return JSONResponse((await _proposal_out(db, result.proposal)).model_dump(mode="json"), 202)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/edges/{edge_id}/unlock", response_model=EdgeOut)
async def unlock_edge(edge_id: uuid.UUID, principal: ApproverNow, db: TenantDB) -> EdgeOut:
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
    entity_id: uuid.UUID, body: EvidenceCreate, principal: ApproverNow, db: TenantDB
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
    edge_id: uuid.UUID, body: EvidenceCreate, principal: ApproverNow, db: TenantDB
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
async def rescore(principal: ApproverNow, db: TenantDB) -> RescoreResult:
    """Rescore all evidence, e.g. after changing the confidence_weights setting."""
    n_evidence, n_entities, n_edges = await scoring.rescore_all(db)
    await db.commit()
    return RescoreResult(evidence=n_evidence, entities=n_entities, edges=n_edges)


# --- proposals ------------------------------------------------------------------------------


@router.get("/proposals", response_model=list[ProposalOut])
async def list_proposals(
    principal: Reader,
    db: TenantDB,
    status: ProposalStatus | None = None,
    run_id: Annotated[
        str | None,
        Query(description="A run's id for that run's proposals, or `none` for those of no run"),
    ] = None,
) -> list[ProposalOut]:
    run: uuid.UUID | Literal["none"] | None = None
    if run_id is not None:
        try:
            run = "none" if run_id == "none" else uuid.UUID(run_id)
        except ValueError:
            raise HTTPException(422, "run_id must be a run's id or none") from None
    return await _proposals_out(db, await service.list_proposals(db, status, run))


@router.post("/proposals", response_model=ProposalOut, status_code=status.HTTP_201_CREATED)
async def create_proposal(body: ProposalCreate, principal: Commenter, db: TenantDB) -> ProposalOut:
    """Suggest a change; an approver accepts or rejects it. A run's proposal records
    the run, and is refused while Oracle is set to observe the baseline (H11); a
    person's never is."""
    if principal.is_run and await autonomy.level(db, "baseline") == "observe":
        raise HTTPException(status.HTTP_403_FORBIDDEN, OBSERVING_BASELINE)
    run_id = _run_of(principal, body.run_id)
    writer = service.Writer(principal, "agent", run_id=run_id, reason=body.reason)
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
    return await _proposal_out(db, proposal)


@router.post("/proposals/{proposal_id}/accept", response_model=ProposalOut)
async def accept_proposal(
    proposal_id: uuid.UUID,
    principal: ApproverNow,
    db: TenantDB,
    body: ProposalDecision | None = None,
) -> ProposalOut:
    """Apply the change as your own edit (it locks the item)."""
    return await _decide(db, principal, proposal_id, True, body)


@router.post("/proposals/{proposal_id}/reject", response_model=ProposalOut)
async def reject_proposal(
    proposal_id: uuid.UUID,
    principal: ApproverNow,
    db: TenantDB,
    body: ProposalDecision | None = None,
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
    return await _proposal_out(db, proposal)


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
async def record_conflict(
    body: ConflictCreate, principal: ApproverNow, db: TenantDB
) -> ConflictOut:
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
    conflict_id: uuid.UUID, body: ConflictResolve, principal: ApproverNow, db: TenantDB
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
    return await trace.report(db, principal)


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
    raw = await read_capped_body(request)
    # The body is in before the gate is taken (and the caller re-read under it).
    await recheck_caller(db, principal, "approver")
    try:
        text = raw.decode("utf-8")
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
