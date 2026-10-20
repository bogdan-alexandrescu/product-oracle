"""Intake, gap, question and answer routes (CR-03). Every route is also an MCP tool.

Roles: viewers read; commenters create intakes, answer questions, add gaps and propose
research; the author or an approver asks the next batch; approvers triage gaps, decide
them, link an intake to a PRD, accept or dismiss proposals and start runs. Clearing a
critical gap without review is an owner's call (B4): accepting its risk, validating it
unanswered or as a hard blocker, lowering its importance. Only the author re-runs the
analysis, repins, and sets what others see of each finding drawn from their own
sources (S6, ``oracle.intake.sharing``); every read is shaped for its reader, and a gap
the author has not shared is 404 to everyone else. Reads that return source titles,
links or excerpts are audited (``intake.evidence_read``). Another company's ids are 404
(tenant-scoped session).

The foundation's read routes (``oracle.v2.router``) list and get intakes, gaps,
questions, answers and assumption decisions; these add the writes and the read models
the screens need.
"""

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status

from oracle import audit
from oracle.auth.deps import Principal, TenantDB
from oracle.authz import has_role, require_role
from oracle.intake import answers, checks, engine, service, sharing, summary, views
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
    FindingOut,
    FindingSummaryIn,
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
    SharingBulkIn,
    SharingIn,
)
from oracle.runs import service as runs_service
from oracle.runs.schemas import RunOut
from oracle.sources import search as source_search
from oracle.sources.models import Snapshot
from oracle.v2.concurrency import expect_version, flush_or_conflict
from oracle.v2.models import KnowledgeGap, ProductIntake
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
views.register()


def _http(exc: service.IntakeError) -> HTTPException:
    return HTTPException(exc.status, str(exc))


async def _intake(db: TenantDB, intake_id: uuid.UUID):
    try:
        return await service.get_intake(db, intake_id)
    except service.IntakeError as e:
        raise _http(e) from e


async def _audit_read(db: TenantDB, principal: Principal, intake, route: str, out) -> None:
    """Audit a read that returns source titles, links or excerpts (then commit it)."""
    ids = summary.excerpt_item_ids(out)
    if ids:
        await audit.record(
            db, principal, "intake.evidence_read", "intake", intake.id,
            {"route": route, "item_ids": ids},
        )  # fmt: skip
        await db.commit()


async def _summary(db: TenantDB, intake, principal: Principal, route: str) -> IntakeSummary:
    await db.refresh(intake)
    out = await summary.build(db, intake, principal)
    await _audit_read(db, principal, intake, route, out)
    return out


def _gap_out(intake, principal: Principal, gap: KnowledgeGap) -> KnowledgeGapOut:
    """The gap as the caller may see it; one hidden from them is 404 (fail closed)."""
    if intake is None:
        return KnowledgeGapOut.model_validate(gap)
    view = sharing.gap_view(gap, sharing.registry(intake), sharing.viewer(principal, intake))
    if view is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Gap not found")
    return KnowledgeGapOut.model_validate(view)


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
    return await _summary(db, intake, principal, "create_intake")


@router.patch("/intakes/{item_id}", response_model=IntakeOut)
async def update_intake(
    item_id: uuid.UUID, body: IntakePatch, principal: Commenter, db: TenantDB
) -> IntakeOut:
    """Rename, archive or reopen (the author or an approver); link to a PRD (an approver;
    moving an intake with an unresolved critical blocker off its PRD: an owner)."""
    intake = await _intake(db, item_id)
    try:
        await service.patch(db, principal, intake, body)
    except service.IntakeError as e:
        raise _http(e) from e
    await db.commit()
    await db.refresh(intake)
    return await summary.intake_out(db, intake, principal)


@router.get("/intakes/{intake_id}/summary", response_model=IntakeSummary)
async def get_intake_summary(
    intake_id: uuid.UUID, principal: Viewer, db: TenantDB
) -> IntakeSummary:
    """Opportunity and Gaps: extracted items, coverage, goals and features, conflicts,
    stale evidence, assumptions, top uncertainties, the template and the review gate,
    as the reader may see them (S6)."""
    return await _summary(db, await _intake(db, intake_id), principal, "get_intake_summary")


@router.post("/intakes/{intake_id}/analyze", response_model=IntakeSummary)
async def analyze_intake(intake_id: uuid.UUID, principal: Commenter, db: TenantDB) -> IntakeSummary:
    """Re-read the pinned snapshot and the baseline (the author only). Decided gaps are
    never changed and answered questions never asked again."""
    intake = await _intake(db, intake_id)
    try:
        await service.reanalyze(db, principal, intake)
    except service.IntakeError as e:
        raise _http(e) from e
    await db.commit()
    return await _summary(db, intake, principal, "analyze_intake")


@router.get("/intakes/{intake_id}/new-evidence", response_model=NewEvidence)
async def get_intake_new_evidence(
    intake_id: uuid.UUID, principal: Viewer, db: TenantDB
) -> NewEvidence:
    """Evidence added or changed since the pinned version (the author only; anyone else
    sees neither the items nor their number)."""
    intake = await _intake(db, intake_id)
    out = await summary.new_evidence(db, intake, principal, await summary.pinned(db, intake))
    await _audit_read(db, principal, intake, "get_intake_new_evidence", out)
    return out


@router.post("/intakes/{intake_id}/repin", response_model=IntakeSummary)
async def repin_intake(intake_id: uuid.UUID, principal: Commenter, db: TenantDB) -> IntakeSummary:
    """Pin a new snapshot and re-analyse (the author only); decided gaps stay as
    decided."""
    intake = await _intake(db, intake_id)
    try:
        await service.repin(db, principal, intake)
    except service.IntakeError as e:
        raise _http(e) from e
    await db.commit()
    return await _summary(db, intake, principal, "repin_intake")


@router.get("/intakes/{intake_id}/evidence", response_model=EvidenceSearch)
async def search_intake_evidence(
    intake_id: uuid.UUID,
    principal: Viewer,
    db: TenantDB,
    q: Annotated[str, Query(min_length=1, max_length=500)],
    limit: Annotated[int, Query(ge=1, le=50)] = 10,
) -> EvidenceSearch:
    """Search your own source items as they were at the intake's pinned snapshot. A run
    token (its author's or anyone's) searches, in full text, only the items the intake's
    findings shared in full cite, less what any intake of the author withholds (S6,
    owner 2026-10-19): exactly the items ``/v1/source-items/{id}`` and ``/v1/search``
    give that run.

    Results are untrusted data. Every query is audited (``intake.evidence_query``)."""
    intake = await _intake(db, intake_id)
    me = ev.caller_user(principal)
    reveal: set[uuid.UUID] = set()
    include: set[uuid.UUID] | None = None
    released: dict[uuid.UUID, uuid.UUID] | None = None
    if principal.is_run:
        # Only the items it may read are searched, ranked and counted: what else the
        # author's sources hold never changes the answer (left out in SQL, before the
        # limit). Each at the version sharing released (freeze at sharing).
        released = await ev.run_include(db, intake)
        include = reveal = set(released)
        me = intake.author_id if include else None
    elif me is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Searching sources needs a user")
    pin = await summary.pinned(db, intake)
    snapshot = await db.get(Snapshot, pin.snapshot_id) if pin.snapshot_id else None
    hits = []
    if me is not None:
        hits = await source_search.search(
            db,
            me,
            q,
            as_of=snapshot.as_of if snapshot else None,
            txn_snapshot=snapshot.txn_snapshot if snapshot else None,
            limit=limit,
            include=include,
            source_ids=ev.source_ids_of(intake) or None,
            also=ev.readable_shared(intake.id) if released is not None else None,
        )
    refs = await ev.refs(
        db,
        [h["item"]["id"] for h in hits],
        principal,
        pin.as_of,
        txn_snapshot=snapshot.txn_snapshot if snapshot else None,
        reveal=reveal,
        released=released,
    )
    out = [
        EvidenceHit(
            **refs[h["item"]["id"]].model_dump(),
            # The snippet is the item's text: only where the item itself is shown.
            snippet=h["snippet"] if refs[h["item"]["id"]].visible else None,
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
    and answer paths, as the reader may see them (S6)."""
    intake = await _intake(db, intake_id)
    out = await summary.question_batch(db, intake, principal, batch)
    await _audit_read(db, principal, intake, "get_question_batch", out)
    return out


@router.post("/intakes/{intake_id}/question-batches", response_model=QuestionBatch)
async def ask_next_question_batch(
    intake_id: uuid.UUID,
    principal: Commenter,
    db: TenantDB,
    size: Annotated[int, Query(ge=1, le=10)] = 5,
) -> QuestionBatch:
    """Ask the next short batch: the highest-ranked questions not asked yet (the author
    or an approver)."""
    intake = await _intake(db, intake_id)
    try:
        asked = await service.ask_next(db, principal, intake, size)
    except service.IntakeError as e:
        raise _http(e) from e
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
    return await summary.composition_inputs(db, await _intake(db, intake_id), principal)


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
    return await summary.proposals_of(db, intake, principal)


async def _proposal(db: TenantDB, proposal_id: uuid.UUID, principal: Principal) -> IntakeProposal:
    """A proposal the caller may see; one of a gap the author has not shared is 404."""
    proposal = await db.get(IntakeProposal, proposal_id)
    if proposal is not None and proposal.gap_id is not None:
        gap = await db.get(KnowledgeGap, proposal.gap_id)
        intake = await db.get(ProductIntake, proposal.intake_id)
        if gap is not None and intake is not None:
            try:
                answers.check_visible(principal, intake, gap)
            except service.IntakeError:
                proposal = None
    if proposal is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Proposal not found")
    return proposal


@router.post("/intake-proposals/{proposal_id}/accept", response_model=IntakeProposalOut)
async def accept_intake_proposal(
    proposal_id: uuid.UUID, principal: Approver, db: TenantDB
) -> IntakeProposalOut:
    """Accept: a research proposal becomes a draft run; a PRD patch becomes feedback on
    the PRD's latest version."""
    proposal = await _proposal(db, proposal_id, principal)
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
    proposal = await _proposal(db, proposal_id, principal)
    try:
        await answers.dismiss(db, principal, proposal, body.reason if body else None)
    except service.IntakeError as e:
        raise _http(e) from e
    await db.commit()
    await db.refresh(proposal)
    return IntakeProposalOut.model_validate(proposal)


# --- findings (S6) -----------------------------------------------------------------------


def _finding_out(fid: str, entry: dict, v: sharing.Viewer) -> FindingOut | None:
    if sharing.is_open(entry):
        return None  # drawn from shared text only: nothing to share
    level = entry.get("sharing", sharing.DEFAULT)
    if not v.sees(level, "counts"):
        return None
    out = FindingOut(
        id=uuid.UUID(fid), kind=entry["kind"], origin=entry.get("origin", "rules"),
        category=entry.get("category"), sharing=level,
    )  # fmt: skip
    if v.sees(level, "summary"):
        out.summary = sharing.shared_summary(entry)
        out.gap_id = uuid.UUID(entry["gap_id"]) if entry.get("gap_id") else None
    out.summary_confirmed = bool(entry.get("published")) if v.sees(level, "summary") else None
    if v.is_author:
        out.draft_summary = sharing.draft_summary(entry)
        out.source_item_ids = [uuid.UUID(i) for i in entry.get("source_item_ids") or []]
        out.unshared_item_ids = [uuid.UUID(i) for i in sharing.unshared_ids(entry)]
    elif v.sees(level, "full"):
        # What sharing released, not what a later analysis added (freeze at sharing).
        released = sharing.frozen(entry)
        out.source_item_ids = [
            uuid.UUID(i) for i in entry.get("source_item_ids") or [] if i in released
        ]
    return out


def _findings(intake, principal: Principal, only: set[str] | None = None) -> list[FindingOut]:
    v = sharing.viewer(principal, intake)
    out = []
    for fid, entry in sharing.registry(intake).items():
        if only is not None and fid not in only:
            continue
        row = _finding_out(fid, entry, v)
        if row is not None:
            out.append(row)
    return out


@router.get("/intakes/{intake_id}/findings", response_model=list[FindingOut])
async def list_intake_findings(
    intake_id: uuid.UUID, principal: Viewer, db: TenantDB
) -> list[FindingOut]:
    """Findings drawn from the author's own sources and their sharing levels. The author
    sees every one; anyone else those shared at counts or above, as far as each allows."""
    return _findings(await _intake(db, intake_id), principal)


@router.patch("/intakes/{intake_id}/findings/{finding_id}", response_model=FindingOut)
async def set_intake_finding_sharing(
    intake_id: uuid.UUID, finding_id: uuid.UUID, body: SharingIn, principal: Viewer, db: TenantDB
) -> FindingOut:
    """Set what others see of one finding: private, counts, summary or full (the
    author only; audited; lower it again at any time)."""
    intake = await _intake(db, intake_id)
    try:
        await service.set_sharing(db, principal, intake, [(str(finding_id), body.sharing)])
    except service.IntakeError as e:
        raise _http(e) from e
    await db.commit()
    await db.refresh(intake)
    [out] = _findings(intake, principal, {str(finding_id)})
    return out


@router.put("/intakes/{intake_id}/findings/{finding_id}/summary", response_model=FindingOut)
async def set_intake_finding_summary(
    intake_id: uuid.UUID,
    finding_id: uuid.UUID,
    body: FindingSummaryIn,
    principal: Viewer,
    db: TenantDB,
) -> FindingOut:
    """Confirm Oracle's draft line for the summary level (no ``text``) or write your own
    (the author only, never a run; audited). Until then, the summary level shows others
    only Oracle's fixed category line (S6)."""
    intake = await _intake(db, intake_id)
    try:
        await service.set_summary(db, principal, intake, str(finding_id), body.text)
    except service.IntakeError as e:
        raise _http(e) from e
    await db.commit()
    await db.refresh(intake)
    [out] = _findings(intake, principal, {str(finding_id)})
    return out


@router.post("/intakes/{intake_id}/findings/sharing", response_model=list[FindingOut])
async def set_intake_findings_sharing(
    intake_id: uuid.UUID, body: SharingBulkIn, principal: Viewer, db: TenantDB
) -> list[FindingOut]:
    """Set the sharing level of several findings at once (the author only; every change
    is audited)."""
    intake = await _intake(db, intake_id)
    changes = [(str(c.finding_id), c.sharing) for c in body.changes]
    try:
        done = await service.set_sharing(db, principal, intake, changes)
    except service.IntakeError as e:
        raise _http(e) from e
    await db.commit()
    await db.refresh(intake)
    return _findings(intake, principal, set(done))


# --- gaps --------------------------------------------------------------------------------


async def _gap(db: TenantDB, gap_id: uuid.UUID, principal: Principal) -> KnowledgeGap:
    """A gap the caller may see; one the author has not shared is 404 (S6)."""
    try:
        gap = await service.get_gap(db, gap_id)
        if gap.intake_id is not None:
            answers.check_visible(principal, await service.get_intake(db, gap.intake_id), gap)
    except service.IntakeError as e:
        raise _http(e) from e
    return gap


async def _gap_intake(db: TenantDB, gap: KnowledgeGap):
    return await service.get_intake(db, gap.intake_id) if gap.intake_id else None


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
        importance_basis="person",
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
    return _gap_out(intake, principal, gap)


@router.patch("/gaps/{item_id}", response_model=KnowledgeGapOut)
async def update_knowledge_gap(
    item_id: uuid.UUID, body: GapPatch, principal: Approver, db: TenantDB
) -> KnowledgeGapOut:
    """Triage a gap: importance, owner, sections, stop condition; defer or reopen.
    Lowering a critical gap's importance takes an owner (B4)."""
    gap = await _gap(db, item_id, principal)
    expect_version(gap, body.lock_version)
    if (
        answers.importance_of(await _gap_intake(db, gap), gap) == "critical"
        and body.importance is not None
        and body.importance != "critical"
        and not has_role(principal.role, "owner")
    ):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "Lowering a critical gap's importance needs an owner"
        )
    if body.owner_id is not None and await service.member(db, body.owner_id) is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Unknown owner")
    changed = {}
    for field in ("importance", "owner_id", "status", "section_keys", "stop_condition"):
        if field in body.model_fields_set:
            value = getattr(body, field)
            if value is not None and value != getattr(gap, field):
                changed[field] = str(value)
                setattr(gap, field, value)
    if "importance" in changed:
        # A person set it: a public fact, recorded on the gap itself, so the same rows
        # change whatever private findings the intake holds (S6).
        gap.importance_basis = "person"
    await flush_or_conflict(db)
    if changed:
        await audit.record(db, principal, "intake.gap_updated", "knowledge_gap", gap.id, changed)
        if gap.intake_id is not None:
            intake = await service.get_intake(db, gap.intake_id)
            await engine.sync_questions(db, intake)
            engine.refresh_status(intake, await engine.intake_gaps(db, intake.id))
            await db.flush()
    await db.commit()
    await db.refresh(gap)
    return _gap_out(await _gap_intake(db, gap), principal, gap)


@router.post("/gaps/{gap_id}/decisions", response_model=DecisionResult, status_code=201)
async def decide_knowledge_gap(
    gap_id: uuid.UUID, body: DecisionIn, principal: Approver, db: TenantDB
) -> DecisionResult:
    """Accept an assumption or a risk, validate, or reject, with a rationale. On a
    critical gap, accepting, validating it unanswered, or validating a hard blocker
    needs an owner (B4)."""
    gap = await _gap(db, gap_id, principal)
    try:
        decision = await answers.decide(db, principal, gap, body)
    except service.IntakeError as e:
        raise _http(e) from e
    await db.commit()
    await db.refresh(gap)
    gap_out = _gap_out(await _gap_intake(db, gap), principal, gap)
    decision_out = AssumptionDecisionOut.model_validate(decision)
    decision_out.statement = gap_out.statement
    return DecisionResult(decision=decision_out, gap=gap_out)


@router.post("/gaps/{gap_id}/research", response_model=IntakeProposalOut, status_code=201)
async def propose_gap_research(
    gap_id: uuid.UUID, principal: Commenter, db: TenantDB
) -> IntakeProposalOut:
    """Research this: propose a run that looks into the gap. Nothing runs until an
    approver accepts it and starts the run."""
    gap = await _gap(db, gap_id, principal)
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
    gap updates; what the answer implies elsewhere is proposed, never applied. The
    question and gap come back as the reads show them to the caller (S6)."""
    try:
        question = await service.get_question(db, question_id)
        result = await answers.answer(db, principal, question, body)
    except service.IntakeError as e:
        raise _http(e) from e
    await db.commit()
    for row in (result["answer"], result["question"], result["gap"], *result["proposals"]):
        if row is not None:
            await db.refresh(row)
    shown = await views.Readers(db, principal).question(result["question"])
    if shown is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Question not found")
    return AnswerResult(
        answer=StakeholderAnswerOut.model_validate(result["answer"]),
        question=StakeholderQuestionOut.model_validate(shown),
        gap=_gap_out(await _gap_intake(db, result["gap"]), principal, result["gap"])
        if result["gap"]
        else None,
        proposals=[IntakeProposalOut.model_validate(p) for p in result["proposals"]],
        baseline_proposal_ids=result["baseline_proposal_ids"],
        change_event_id=result["change_event_id"],
        next_actions=result["next_actions"],
    )
