"""Read models for the blocker strategy view, reachable from the baseline (a blocker)
and from a document (every blocker that gates it). Built in bulk: one query per table."""

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.auth.deps import Principal
from oracle.auth.models import User
from oracle.baseline import evidence as baseline_evidence
from oracle.baseline.models import Entity, Evidence
from oracle.blockers import policy, render, service
from oracle.blockers.schemas import (
    BlockerDocumentRef,
    BlockerGate,
    BlockerImpactRef,
    BlockerOptionView,
    BlockerOut,
    BlockerSpec,
    BlockerStrategy,
    BlockerSummary,
    DocumentBlockerStrategy,
)
from oracle.docs.models import Document
from oracle.sources.models import Source, SourceItem
from oracle.v2.models import (
    BlockerOption,
    BlockerResolutionEvent,
    DocumentSectionLink,
    FeasibilityExperiment,
)
from oracle.v2.schemas import (
    AssumptionDecisionOut,
    BlockerResolutionEventOut,
    FeasibilityExperimentOut,
)


def _blocker_out(
    entity: Entity,
    spec: BlockerSpec,
    gate: BlockerGate,
    evidence_count: int,
    impacted: list[BlockerImpactRef],
) -> BlockerOut:
    return BlockerOut(
        id=entity.id,
        key=entity.key,
        statement=entity.title,
        detail=entity.body,
        entity_status=entity.status,
        locked=entity.locked,
        confidence=float(entity.confidence) if entity.confidence is not None else None,
        evidence_count=evidence_count,
        type=spec.type,
        limit_kind=spec.limit_kind,
        limit_kind_label=policy.LIMIT_KIND_LABELS[spec.limit_kind],
        third_party=spec.third_party,
        severity=spec.severity,
        status=spec.status,
        timing=spec.timing,
        threshold=spec.threshold,
        impacted_entity_ids=spec.impacted_entity_ids,
        impacted=impacted,
        impacted_users=spec.impacted_users,
        owner_id=spec.owner_id,
        review_at=spec.review_at,
        document_ids=spec.document_ids,
        scaling=spec.scaling,
        selected_option_id=spec.selected_option_id,
        revision=spec.revision,
        gate=gate,
        created_at=entity.created_at,
        updated_at=entity.updated_at,
    )


async def _rows(db: AsyncSession, model: Any, ids: list[uuid.UUID], order: Any) -> list[Any]:
    if not ids:
        return []
    return list(
        (
            await db.scalars(
                select(model).where(model.blocker_id.in_(ids)).order_by(order, model.id)
            )
        ).all()
    )


async def _entity_evidence(db: AsyncSession, ids: list[uuid.UUID]) -> list[Evidence]:
    """The blockers' own evidence, strongest first (as the baseline lists it)."""
    if not ids:
        return []
    stmt = (
        select(Evidence)
        .where(Evidence.entity_id.in_(ids))
        .order_by(Evidence.confidence.desc().nulls_last(), Evidence.created_at, Evidence.id)
    )
    return list((await db.scalars(stmt)).all())


async def _documents_of(
    db: AsyncSession, entities: list[Entity], specs: dict[uuid.UUID, BlockerSpec]
) -> dict[uuid.UUID, list[BlockerDocumentRef]]:
    ids = [e.id for e in entities]
    links: dict[uuid.UUID, list[uuid.UUID]] = {
        e.id: list(specs[e.id].document_ids) for e in entities
    }
    if ids:
        for entity_id, doc_id in (
            await db.execute(
                select(DocumentSectionLink.entity_id, DocumentSectionLink.document_id)
                .where(DocumentSectionLink.entity_id.in_(ids))
                .distinct()
            )
        ).all():
            if doc_id not in links[entity_id]:
                links[entity_id].append(doc_id)
    doc_ids = {d for ds in links.values() for d in ds}
    docs = {}
    if doc_ids:
        docs = {
            d.id: BlockerDocumentRef(id=d.id, slug=d.slug, title=d.title)
            for d in (await db.scalars(select(Document).where(Document.id.in_(doc_ids)))).all()
        }
    return {k: [docs[d] for d in v if d in docs] for k, v in links.items()}


async def _impacted(
    db: AsyncSession, specs: dict[uuid.UUID, BlockerSpec]
) -> dict[uuid.UUID, BlockerImpactRef]:
    ids = {i for s in specs.values() for i in s.impacted_entity_ids}
    if not ids:
        return {}
    rows = (await db.scalars(select(Entity).where(Entity.id.in_(ids)))).all()
    return {e.id: BlockerImpactRef(id=e.id, type=e.type, key=e.key, title=e.title) for e in rows}


async def strategies(
    db: AsyncSession, principal: Principal, entities: list[Entity]
) -> list[BlockerStrategy]:
    """The strategy view for each readable blocker, most severe first."""
    readable = [(e, service.safe_spec(e)) for e in entities]
    readable = [(e, s) for e, s in readable if s is not None]
    specs = {e.id: s for e, s in readable}
    ids = list(specs)
    inputs = await service.gate_inputs(db, ids)
    options = service.grouped(await _rows(db, BlockerOption, ids, BlockerOption.created_at))
    experiments = service.grouped(
        await _rows(db, FeasibilityExperiment, ids, FeasibilityExperiment.created_at)
    )
    events = service.grouped(
        await _rows(db, BlockerResolutionEvent, ids, BlockerResolutionEvent.created_at)
    )
    evidence_rows = service.grouped(await _entity_evidence(db, ids), "entity_id")
    documents = await _documents_of(db, [e for e, _ in readable], specs)
    impacted = await _impacted(db, specs)
    out = []
    for entity, spec in readable:
        gate = service.assess(entity, spec, inputs)
        last = inputs.last_event.get(entity.id)
        acceptance = None
        if spec.status == "accepted_risk" and last is not None and last.kind == "risk_accepted":
            raw = (last.data or {}).get("assumption_decision_id")
            decision = None
            try:
                decision = inputs.decisions.get(uuid.UUID(raw)) if raw else None
            except ValueError:
                decision = None
            acceptance = AssumptionDecisionOut.model_validate(decision) if decision else None
        opts = options.get(entity.id, [])
        recommended = service.recommended_option(opts)
        evidence = await baseline_evidence.present(db, principal, evidence_rows.get(entity.id, []))
        out.append(
            BlockerStrategy(
                blocker=_blocker_out(
                    entity,
                    spec,
                    gate,
                    len(evidence),
                    [impacted[i] for i in spec.impacted_entity_ids if i in impacted],
                ),
                gate=gate,
                evidence=evidence,
                options=[
                    BlockerOptionView.model_validate(o).model_copy(
                        update={
                            "policy_flags": service.flags_of(o),
                            "recommended": o.id == recommended,
                        }
                    )
                    for o in opts
                ],
                recommended_option_id=recommended,
                compliant_paths=policy.compliant_paths(spec.limit_kind),
                prohibited=policy.PROHIBITED,
                experiments=[
                    FeasibilityExperimentOut.model_validate(x)
                    for x in experiments.get(entity.id, [])
                ],
                events=[
                    BlockerResolutionEventOut.model_validate(x) for x in events.get(entity.id, [])
                ],
                risk_acceptance=acceptance,
                documents=documents.get(entity.id, []),
            )
        )
    out.sort(key=lambda s: _order(s))
    return out


def _order(s: BlockerStrategy) -> tuple:
    order = {"critical": 0, "warning": 1, "pass": 2, "not_applicable": 3}
    return (
        service.SEVERITY_RANK[s.blocker.severity],
        order[s.gate.status],
        s.blocker.statement.lower(),
        str(s.blocker.id),
    )


async def strategy(db: AsyncSession, principal: Principal, entity_id: uuid.UUID) -> BlockerStrategy:
    entity, _spec = await service.get_blocker(db, entity_id)
    return (await strategies(db, principal, [entity]))[0]


async def summaries(db: AsyncSession, entities: list[Entity]) -> list[BlockerSummary]:
    readable = [(e, service.safe_spec(e)) for e in entities]
    readable = [(e, s) for e, s in readable if s is not None]
    inputs = await service.gate_inputs(db, [e.id for e, _ in readable])
    return [
        BlockerSummary(
            id=e.id,
            key=e.key,
            statement=e.title,
            type=s.type,
            limit_kind=s.limit_kind,
            third_party=s.third_party,
            severity=s.severity,
            status=s.status,
            selected_option_id=s.selected_option_id,
            document_ids=s.document_ids,
            gate=service.assess(e, s, inputs),
            updated_at=e.updated_at,
        )
        for e, s in readable
    ]


async def document_strategy(
    db: AsyncSession, principal: Principal, document: Document
) -> DocumentBlockerStrategy:
    from oracle.blockers.readiness import critical_blockers
    from oracle.readiness import ReadinessContext

    entities = await service.blockers_for_document(db, document.id)
    outcome = await critical_blockers(ReadinessContext(db, document.id))
    return DocumentBlockerStrategy(
        document=BlockerDocumentRef(id=document.id, slug=document.slug, title=document.title),
        readiness=BlockerGate(status=outcome.status, rationale=outcome.rationale),
        blockers=await strategies(db, principal, entities),
    )


# --- rendering inputs ---------------------------------------------------------------------


async def _evidence_refs(
    db: AsyncSession, ids: set[uuid.UUID]
) -> dict[uuid.UUID, render.EvidenceRef]:
    if not ids:
        return {}
    rows = (
        await db.execute(
            select(Evidence, SourceItem, Source)
            .outerjoin(SourceItem, SourceItem.id == Evidence.source_item_id)
            .outerjoin(Source, Source.id == SourceItem.source_id)
            .where(Evidence.id.in_(ids))
        )
    ).all()
    out = {}
    for ev, item, source in rows:
        kind = ev.kind or (source.kind if source is not None else None)
        if kind is None and ev.url:
            kind = "web"
        out[ev.id] = render.EvidenceRef(
            id=ev.id,
            source=render.CITATION_SOURCES.get(kind) if kind else None,
            ref=ev.url or ev.ref or (item.url if item is not None else None),
            # The appendix shows what any user may see of evidence: never a private
            # item's title (AUD-9), only the excerpt, url and ref.
            title=None,
            excerpt=ev.excerpt,
            retrieved_at=ev.retrieved_at,
        )
    return out


async def render_document(db: AsyncSession, document: Document) -> Any:
    entities = await service.blockers_for_document(db, document.id)
    readable = [(e, service.safe_spec(e)) for e in entities]
    readable = [(e, s) for e, s in readable if s is not None]
    specs = {e.id: s for e, s in readable}
    ids = list(specs)
    inputs = await service.gate_inputs(db, ids)
    options = service.grouped(await _rows(db, BlockerOption, ids, BlockerOption.created_at))
    experiments = service.grouped(
        await _rows(db, FeasibilityExperiment, ids, FeasibilityExperiment.created_at)
    )
    entity_evidence = service.grouped(await _entity_evidence(db, ids), "entity_id")
    wanted: set[uuid.UUID] = {ev.id for evs in entity_evidence.values() for ev in evs}
    for rows in (*options.values(), *experiments.values()):
        for r in rows:
            wanted |= set(r.evidence_ids)
    refs = await _evidence_refs(db, wanted)
    impacted = await _impacted(db, specs)
    user_ids = {s.owner_id for s in specs.values() if s.owner_id}
    user_ids |= {x.owner_id for xs in experiments.values() for x in xs if x.owner_id}
    user_ids |= {o.owner_id for os in options.values() for o in os if o.owner_id}
    users = {}
    if user_ids:
        users = {
            u.id: u.email
            for u in (await db.scalars(select(User).where(User.id.in_(user_ids)))).all()
        }

    blockers = []
    for entity, spec in readable:
        gate = service.assess(entity, spec, inputs)
        last = inputs.last_event.get(entity.id)
        note = None
        if gate.status == "pass" and spec.status in ("accepted_risk", "feasibility_only") and last:
            note = (
                f"Risk accepted: {last.reason}"
                if spec.status == "accepted_risk"
                else f"Proceeds as a scoped feasibility experiment: {last.reason}"
            )
        opts = options.get(entity.id, [])
        exps = experiments.get(entity.id, [])
        ev_ids = [ev.id for ev in entity_evidence.get(entity.id, [])]
        for r in (*opts, *exps):
            ev_ids += [i for i in r.evidence_ids if i not in ev_ids]
        blockers.append(
            render.BlockerIn(
                key=entity.key,
                statement=entity.title,
                detail=entity.body,
                spec=spec,
                gate=gate,
                owner=users.get(spec.owner_id) if spec.owner_id else None,
                impacted=[impacted[i].title for i in spec.impacted_entity_ids if i in impacted],
                options=[
                    render.OptionIn(
                        id=o.id,
                        title=o.title,
                        approach=o.approach,
                        description=o.description,
                        technical_feasibility=o.technical_feasibility,
                        policy_feasibility=o.policy_feasibility,
                        compliance=o.compliance,
                        status=o.status,
                        details=o.details or {},
                        selected_reason=o.selected_reason,
                        owner=users.get(o.owner_id) if o.owner_id else None,
                        flagged=bool(service.flags_of(o)),
                    )
                    for o in opts
                ],
                experiments=[
                    render.ExperimentIn(
                        hypothesis=x.hypothesis,
                        method=x.method,
                        success_threshold=x.success_threshold,
                        owner=users.get(x.owner_id) if x.owner_id else None,
                        decision_gate_at=x.decision_gate_at,
                        status=x.status,
                        result=x.result,
                    )
                    for x in exps
                ],
                evidence=[refs[i] for i in ev_ids if i in refs],
                decision_note=note,
            )
        )
    order = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    blockers.sort(key=lambda b: (order[b.spec.severity], b.statement.lower(), b.key))
    return render.render(blockers)
