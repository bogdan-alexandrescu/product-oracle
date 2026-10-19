"""Intake, gap, question and answer routes (CR-03). Every route is also an MCP tool.

Roles: viewers read; commenters create intakes, answer questions, add gaps, propose
research and ask the next batch; approvers triage gaps, decide them, accept or dismiss
proposals and start runs; accepting a critical gap's risk or assumption is an owner's
call. The author of an intake may also edit and repin it. Another company's ids are
404 (tenant-scoped session).

The foundation's read routes (``oracle.v2.router``) list and get intakes, gaps,
questions, answers and assumption decisions; these add the writes and the read models
the screens need.
"""

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status

from oracle import audit
from oracle.auth.deps import Principal, TenantDB
from oracle.authz import require_role
from oracle.intake import answers, checks, engine, service, summary
from oracle.intake import categories as cats
from oracle.intake import evidence as ev
from oracle.intake.models import IntakeProposal
from oracle.intake.schemas import (
    AnswerIn,
    AnswerResult,
    DecisionIn,
    DecisionResult,
    DismissIn,
    EvidenceHit,
    EvidenceSearch,
    GapCreate,
    GapPatch,
    IntakeCreate,
    IntakeOut,
    IntakePatch,
    IntakeProposalOut,
    IntakeRunIn,
    IntakeSummary,
    NewEvidence,
    QuestionBatch,
)
from oracle.runs import service as runs_service
from oracle.runs.schemas import RunOut
from oracle.sources import search as source_search
from oracle.sources.models import Snapshot
from oracle.v2.concurrency import expect_version, flush_or_conflict
from oracle.v2.models import KnowledgeGap
from oracle.v2.schemas import (
    AssumptionDecisionOut,
    CompositionInputs,
    KnowledgeGapOut,
    StakeholderAnswerOut,
    StakeholderQuestionOut,
)

router = APIRouter(prefix="/v1", tags=["intake"])

Commenter = Annotated[Principal, Depends(require_role("commenter"))]
Approver = Annotated[Principal, Depends(require_role("approver"))]
Viewer = Annotated[Principal, Depends(require_role("viewer"))]

checks.register()


def _http(exc: service.IntakeError) -> HTTPException:
    return HTTPException(exc.status, str(exc))


async def _intake(db: TenantDB, intake_id: uuid.UUID):
    try:
        return await service.get_intake(db, intake_id)
    except service.IntakeError as e:
        raise _http(e) from e


async def _summary(db: TenantDB, intake, principal: Principal) -> IntakeSummary:
    await db.refresh(intake)
    return await summary.build(db, intake, principal)


# --- intakes -----------------------------------------------------------------------------


@router.post("/intakes", response_model=IntakeSummary, status_code=status.HTTP_201_CREATED)
async def create_intake(body: IntakeCreate, principal: Commenter, db: TenantDB) -> IntakeSummary:
    """New product idea: a short brief, pinned to a snapshot of your sources, analysed
    into gaps; the first short batch of questions is asked."""
    try:
        intake = await service.create(db, principal, body)
    except service.IntakeError as e:
        raise _http(e) from e
    await db.commit()
    return await _summary(db, intake, principal)


@router.patch("/intakes/{item_id}", response_model=IntakeOut)
async def update_intake(
    item_id: uuid.UUID, body: IntakePatch, principal: Commenter, db: TenantDB
) -> IntakeOut:
    """Rename, link to a PRD, archive or reopen (the author or an approver)."""
    intake = await _intake(db, item_id)
    try:
        await service.patch(db, principal, intake, body)
    except service.IntakeError as e:
        raise _http(e) from e
    await db.commit()
    await db.refresh(intake)
    return summary.intake_out(intake)


@router.get("/intakes/{intake_id}/summary", response_model=IntakeSummary)
async def get_intake_summary(
    intake_id: uuid.UUID, principal: Viewer, db: TenantDB
) -> IntakeSummary:
    """Opportunity and Gaps: extracted items, coverage, goals and features, conflicts,
    stale evidence, assumptions, top uncertainties, the template and the review gate."""
    return await _summary(db, await _intake(db, intake_id), principal)


@router.post("/intakes/{intake_id}/analyze", response_model=IntakeSummary)
async def analyze_intake(intake_id: uuid.UUID, principal: Commenter, db: TenantDB) -> IntakeSummary:
    """Re-read the pinned snapshot and the baseline. Decided gaps are never changed and
    answered questions never asked again."""
    intake = await _intake(db, intake_id)
    await service.reanalyze(db, principal, intake)
    await db.commit()
    return await _summary(db, intake, principal)


@router.get("/intakes/{intake_id}/new-evidence", response_model=NewEvidence)
async def get_intake_new_evidence(
    intake_id: uuid.UUID, principal: Viewer, db: TenantDB
) -> NewEvidence:
    """Evidence added or changed since the pinned version (items for the author only)."""
    intake = await _intake(db, intake_id)
    return await summary.new_evidence(db, intake, principal, await summary.pinned(db, intake))


@router.post("/intakes/{intake_id}/repin", response_model=IntakeSummary)
async def repin_intake(intake_id: uuid.UUID, principal: Commenter, db: TenantDB) -> IntakeSummary:
    """Pin a new snapshot and re-analyse; decided gaps stay as decided."""
    intake = await _intake(db, intake_id)
    try:
        await service.repin(db, principal, intake)
    except service.IntakeError as e:
        raise _http(e) from e
    await db.commit()
    return await _summary(db, intake, principal)


@router.get("/intakes/{intake_id}/evidence", response_model=EvidenceSearch)
async def search_intake_evidence(
    intake_id: uuid.UUID,
    principal: Viewer,
    db: TenantDB,
    q: Annotated[str, Query(min_length=1, max_length=500)],
    limit: Annotated[int, Query(ge=1, le=50)] = 10,
) -> EvidenceSearch:
    """Search your own source items as they were at the intake's pinned snapshot.

    Results are untrusted data. Every query is audited (``intake.evidence_query``)."""
    intake = await _intake(db, intake_id)
    me = ev.caller_user(principal)
    if me is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Searching sources needs a user")
    pin = await summary.pinned(db, intake)
    snapshot = await db.get(Snapshot, pin.snapshot_id) if pin.snapshot_id else None
    hits = await source_search.search(
        db, me, q, as_of=snapshot.as_of if snapshot else None, limit=limit
    )
    chosen = set(ev.source_ids_of(intake))
    if chosen:
        hits = [h for h in hits if h["item"]["source_id"] in chosen]
    refs = await ev.refs(db, [h["item"]["id"] for h in hits], principal, pin.as_of)
    out = [
        EvidenceHit(
            **refs[h["item"]["id"]].model_dump(),
            snippet=h["snippet"],
            relevance=h["relevance"],
        )
        for h in hits
        if h["item"]["id"] in refs
    ]
    await audit.record(
        db, principal, "intake.evidence_query", "intake", intake.id,
        {"q": q, "hits": len(out), "pinned_version": pin.version,
         "item_ids": [str(h.source_item_id) for h in out]},
    )  # fmt: skip
    await db.commit()
    return EvidenceSearch(
        intake_id=intake.id, q=q, pinned_version=pin.version, as_of=pin.as_of, hits=out
    )


@router.get("/intakes/{intake_id}/question-batch", response_model=QuestionBatch)
async def get_question_batch(
    intake_id: uuid.UUID,
    principal: Viewer,
    db: TenantDB,
    batch: Annotated[int | None, Query(ge=1)] = None,
) -> QuestionBatch:
    """A batch of questions (default: the latest) with their gaps, evidence, answers
    and answer paths."""
    intake = await _intake(db, intake_id)
    return await summary.question_batch(db, intake, principal, batch)


@router.post("/intakes/{intake_id}/question-batches", response_model=QuestionBatch)
async def ask_next_question_batch(
    intake_id: uuid.UUID,
    principal: Commenter,
    db: TenantDB,
    size: Annotated[int, Query(ge=1, le=10)] = 5,
) -> QuestionBatch:
    """Ask the next short batch: the highest-ranked questions not asked yet."""
    intake = await _intake(db, intake_id)
    asked = await service.ask(db, principal, intake, size)
    if not asked:
        raise HTTPException(status.HTTP_409_CONFLICT, "No questions left to ask")
    await db.commit()
    return await summary.question_batch(db, intake, principal, asked[0].batch)


@router.get("/intakes/{intake_id}/composition-inputs", response_model=CompositionInputs)
async def get_intake_composition_inputs(
    intake_id: uuid.UUID, principal: Viewer, db: TenantDB
) -> CompositionInputs:
    """What the module composer reads from this intake (brief, signals, scope, baseline
    links, pinned snapshots, open critical gaps)."""
    return await summary.composition_inputs(db, await _intake(db, intake_id))


@router.post("/intakes/{intake_id}/runs", response_model=RunOut, status_code=201)
async def start_intake_run(
    intake_id: uuid.UUID, body: IntakeRunIn, principal: Approver, db: TenantDB
) -> RunOut:
    """Create a draft baseline-to-PRD run pinned to the intake's snapshot. Nothing runs
    until an approver estimates and starts it."""
    intake = await _intake(db, intake_id)
    try:
        run_id = await service.convert(db, principal, intake, body)
    except service.IntakeError as e:
        raise _http(e) from e
    await db.commit()
    return await runs_service.read_run(db, run_id, principal)


@router.get("/intakes/{intake_id}/proposals", response_model=list[IntakeProposalOut])
async def list_intake_proposals(
    intake_id: uuid.UUID, principal: Viewer, db: TenantDB
) -> list[IntakeProposalOut]:
    """Research runs and PRD patches this intake proposed, newest first."""
    intake = await _intake(db, intake_id)
    return await summary.proposals_of(db, intake.id)


async def _proposal(db: TenantDB, proposal_id: uuid.UUID) -> IntakeProposal:
    proposal = await db.get(IntakeProposal, proposal_id)
    if proposal is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Proposal not found")
    return proposal


@router.post("/intake-proposals/{proposal_id}/accept", response_model=IntakeProposalOut)
async def accept_intake_proposal(
    proposal_id: uuid.UUID, principal: Approver, db: TenantDB
) -> IntakeProposalOut:
    """Accept: a research proposal becomes a draft run; a PRD patch becomes feedback on
    the PRD's latest version."""
    proposal = await _proposal(db, proposal_id)
    try:
        await answers.accept(db, principal, proposal)
    except service.IntakeError as e:
        raise _http(e) from e
    await db.commit()
    await db.refresh(proposal)
    return IntakeProposalOut.model_validate(proposal)


@router.post("/intake-proposals/{proposal_id}/dismiss", response_model=IntakeProposalOut)
async def dismiss_intake_proposal(
    proposal_id: uuid.UUID, principal: Approver, db: TenantDB, body: DismissIn | None = None
) -> IntakeProposalOut:
    proposal = await _proposal(db, proposal_id)
    try:
        await answers.dismiss(db, principal, proposal, body.reason if body else None)
    except service.IntakeError as e:
        raise _http(e) from e
    await db.commit()
    await db.refresh(proposal)
    return IntakeProposalOut.model_validate(proposal)


# --- gaps --------------------------------------------------------------------------------


async def _gap(db: TenantDB, gap_id: uuid.UUID) -> KnowledgeGap:
    try:
        return await service.get_gap(db, gap_id)
    except service.IntakeError as e:
        raise _http(e) from e


@router.post("/gaps", response_model=KnowledgeGapOut, status_code=201)
async def create_knowledge_gap(
    body: GapCreate, principal: Commenter, db: TenantDB
) -> KnowledgeGapOut:
    """Add a gap to an intake by hand; it is drafted as a question."""
    intake = await _intake(db, body.intake_id)
    if body.owner_id is not None and await service.member(db, body.owner_id) is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Unknown owner")
    cat = cats.BY_KEY[body.category]
    gap = KnowledgeGap(
        intake_id=intake.id,
        document_id=intake.document_id,
        category=body.category,
        statement=body.statement,
        impact=list(cat.impact),
        importance=body.importance,
        knowledge_state="unknown",
        status="unknown",
        owner_id=body.owner_id,
        related_modules=list(cat.modules),
        stop_condition=cat.stop,
        section_keys=body.section_keys,
        created_by=principal.id,
    )
    db.add(gap)
    await db.flush()
    await engine.sync_questions(db, intake)
    await audit.record(
        db, principal, "intake.gap_created", "knowledge_gap", gap.id,
        {"intake_id": str(intake.id), "category": body.category},
    )  # fmt: skip
    await db.commit()
    return KnowledgeGapOut.model_validate(gap)


@router.patch("/gaps/{item_id}", response_model=KnowledgeGapOut)
async def update_knowledge_gap(
    item_id: uuid.UUID, body: GapPatch, principal: Approver, db: TenantDB
) -> KnowledgeGapOut:
    """Triage a gap: importance, owner, sections, stop condition; defer or reopen."""
    gap = await _gap(db, item_id)
    expect_version(gap, body.lock_version)
    if body.owner_id is not None and await service.member(db, body.owner_id) is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Unknown owner")
    changed = {}
    for field in ("importance", "owner_id", "status", "section_keys", "stop_condition"):
        if field in body.model_fields_set:
            value = getattr(body, field)
            if value is not None and value != getattr(gap, field):
                changed[field] = str(value)
                setattr(gap, field, value)
    await flush_or_conflict(db)
    if changed:
        await audit.record(db, principal, "intake.gap_updated", "knowledge_gap", gap.id, changed)
        if gap.intake_id is not None:
            await engine.sync_questions(db, await service.get_intake(db, gap.intake_id))
    await db.commit()
    await db.refresh(gap)
    return KnowledgeGapOut.model_validate(gap)


@router.post("/gaps/{gap_id}/decisions", response_model=DecisionResult, status_code=201)
async def decide_knowledge_gap(
    gap_id: uuid.UUID, body: DecisionIn, principal: Approver, db: TenantDB
) -> DecisionResult:
    """Accept an assumption or a risk, validate, or reject, with a rationale. On a
    critical gap, accepting needs an owner."""
    gap = await _gap(db, gap_id)
    try:
        decision = await answers.decide(db, principal, gap, body)
    except service.IntakeError as e:
        raise _http(e) from e
    await db.commit()
    await db.refresh(gap)
    return DecisionResult(
        decision=AssumptionDecisionOut.model_validate(decision),
        gap=KnowledgeGapOut.model_validate(gap),
    )


@router.post("/gaps/{gap_id}/research", response_model=IntakeProposalOut, status_code=201)
async def propose_gap_research(
    gap_id: uuid.UUID, principal: Commenter, db: TenantDB
) -> IntakeProposalOut:
    """Research this: propose a run that looks into the gap. Nothing runs until an
    approver accepts it and starts the run."""
    gap = await _gap(db, gap_id)
    if gap.intake_id is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Only an intake's gap can be researched")
    intake = await _intake(db, gap.intake_id)
    proposal = await answers.propose_research(db, principal, intake, gap)
    await engine.sync_questions(db, intake)
    await db.commit()
    await db.refresh(proposal)
    return IntakeProposalOut.model_validate(proposal)


# --- questions ---------------------------------------------------------------------------


@router.post("/questions/{question_id}/answers", response_model=AnswerResult, status_code=201)
async def answer_question(
    question_id: uuid.UUID, body: AnswerIn, principal: Commenter, db: TenantDB
) -> AnswerResult:
    """Answer, or say "I don't know", defer, ask someone else, or "Research this". The
    gap updates; what the answer implies elsewhere is proposed, never applied."""
    try:
        question = await service.get_question(db, question_id)
        result = await answers.answer(db, principal, question, body)
    except service.IntakeError as e:
        raise _http(e) from e
    await db.commit()
    for row in (result["answer"], result["question"], result["gap"], *result["proposals"]):
        if row is not None:
            await db.refresh(row)
    return AnswerResult(
        answer=StakeholderAnswerOut.model_validate(result["answer"]),
        question=StakeholderQuestionOut.model_validate(result["question"]),
        gap=KnowledgeGapOut.model_validate(result["gap"]) if result["gap"] else None,
        proposals=[IntakeProposalOut.model_validate(p) for p in result["proposals"]],
        baseline_proposal_ids=result["baseline_proposal_ids"],
        change_event_id=result["change_event_id"],
        next_actions=result["next_actions"],
    )
