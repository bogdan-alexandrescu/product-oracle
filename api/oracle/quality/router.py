"""PRD quality and readiness, outcome tracking and learnings (CR-08).

Viewers read the criteria, the readiness dashboard, outcomes, learnings and signals.
Commenters store an evaluation snapshot or a human rating; approvers queue a model
review, track outcomes, assess them and keep or retire learnings. Every write is audited,
and each handler commits once. Logic lives in :mod:`oracle.quality.service` and
:mod:`oracle.quality.outcomes`.

Importing this module registers the quality checks in :mod:`oracle.readiness` (T2:
the ten criteria advisory, ``security_policy`` and ``third_party_support`` hard).
"""

import uuid
from collections.abc import Awaitable
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query

from oracle.auth.deps import Principal, TenantDB
from oracle.authz import require_role
from oracle.jobs import service as jobs_service
from oracle.jobs.schemas import LlmJobOut
from oracle.quality import criteria, outcomes, service
from oracle.quality.schemas import (
    AssessmentIn,
    AssessmentResult,
    CriterionInfo,
    HumanRatingIn,
    LearningCreate,
    LearningOut,
    LearningRetire,
    LearningSignal,
    LearningStatus,
    LearningTarget,
    OutcomeCreate,
    OutcomeOut,
    OutcomeStatus,
    ReadinessDashboard,
)
from oracle.v2.schemas import EvaluationReportDetail

criteria.register()

router = APIRouter(prefix="/v1", tags=["quality"], dependencies=[Depends(require_role("viewer"))])
Commenter = Annotated[Principal, Depends(require_role("commenter"))]
Approver = Annotated[Principal, Depends(require_role("approver"))]
VERSION = "/documents/{doc}/versions/{n}"
Limit = Annotated[int, Query(ge=1, le=500)]
Offset = Annotated[int, Query(ge=0)]


async def _call[T](op: Awaitable[T]) -> T:
    try:
        return await op
    except (service.QualityError, outcomes.OutcomeError) as e:
        raise HTTPException(e.status, str(e)) from e


@router.get("/quality/criteria", response_model=list[CriterionInfo])
async def list_quality_criteria() -> list[CriterionInfo]:
    """The ten advisory quality criteria, then the hard checks this lane registers."""
    return criteria.catalogue()


@router.get(VERSION + "/readiness", response_model=ReadinessDashboard)
async def get_document_readiness(doc: str, n: int, db: TenantDB) -> ReadinessDashboard:
    """The soft readiness dashboard of a version, criterion by criterion (stores nothing).

    Every registered readiness check runs live. Advisory criteria never block (T2);
    ``blocked`` is true only when a hard check is critical. The latest model review and
    the human ratings of the version are shown beside each criterion, with agreement.
    """
    return await _call(service.dashboard(db, doc, n))


@router.post(VERSION + "/evaluations", response_model=EvaluationReportDetail, status_code=201)
async def create_evaluation_report(
    doc: str, n: int, principal: Commenter, db: TenantDB
) -> EvaluationReportDetail:
    """Store a snapshot of the rules' evaluation of a version (evaluator ``rules``)."""
    out = await _call(service.store_report(db, principal, doc, n))
    await db.commit()
    return out


@router.post(VERSION + "/evaluations/human", response_model=EvaluationReportDetail, status_code=201)
async def create_human_rating(
    doc: str, n: int, body: HumanRatingIn, principal: Commenter, db: TenantDB
) -> EvaluationReportDetail:
    """A person's rating of some or all of the ten criteria, compared with the rules."""
    out = await _call(service.store_human_rating(db, principal, doc, n, body))
    await db.commit()
    return out


@router.post(VERSION + "/quality-review", response_model=LlmJobOut, status_code=201)
async def queue_quality_review(doc: str, n: int, principal: Approver, db: TenantDB) -> LlmJobOut:
    """Queue the built-in model's quality review of a version.

    Its answer is stored as an evaluation report labelled model output: shown beside the
    rules, never ground truth, never a block.
    """
    job = await _call(service.queue_model_review(db, principal, doc, n))
    await db.commit()
    return await jobs_service.job_out(db, job)


# --- outcomes -------------------------------------------------------------------------


@router.post("/outcomes", response_model=OutcomeOut, status_code=201)
async def create_outcome(body: OutcomeCreate, principal: Approver, db: TenantDB) -> OutcomeOut:
    """Track a launched PRD version, roadmap item or experiment against its goal."""
    out = await _call(outcomes.create_outcome(db, principal, body))
    await db.commit()
    return out


@router.get("/outcomes", response_model=list[OutcomeOut])
async def list_outcomes(
    db: TenantDB,
    goal_id: uuid.UUID | None = None,
    document_id: uuid.UUID | None = None,
    status: OutcomeStatus | None = None,
    limit: Limit = 100,
    offset: Offset = 0,
) -> list[OutcomeOut]:
    return await outcomes.list_outcomes(
        db, goal_id=goal_id, document_id=document_id, status=status, limit=limit, offset=offset
    )


@router.get("/outcomes/{outcome_id}", response_model=OutcomeOut)
async def get_outcome(outcome_id: uuid.UUID, db: TenantDB) -> OutcomeOut:
    return OutcomeOut.model_validate(await _call(outcomes.get_outcome(db, outcome_id)))


@router.post("/outcomes/{outcome_id}/assessments", response_model=AssessmentResult)
async def assess_outcome(
    outcome_id: uuid.UUID, body: AssessmentIn, principal: Approver, db: TenantDB
) -> AssessmentResult:
    """Record whether the prediction held; returns drafted learnings to keep or drop."""
    out = await _call(outcomes.assess(db, principal, outcome_id, body))
    await db.commit()
    return out


# --- learnings ------------------------------------------------------------------------


@router.post("/learnings", response_model=LearningOut, status_code=201)
async def create_learning(body: LearningCreate, principal: Approver, db: TenantDB) -> LearningOut:
    out = await _call(outcomes.create_learning(db, principal, body))
    await db.commit()
    return out


@router.get("/learnings", response_model=list[LearningOut])
async def list_learnings(
    db: TenantDB,
    applies_to: LearningTarget | None = None,
    target: str | None = None,
    status: LearningStatus | None = None,
    limit: Limit = 100,
    offset: Offset = 0,
) -> list[LearningOut]:
    return await outcomes.list_learnings(
        db, applies_to=applies_to, target=target, status=status, limit=limit, offset=offset
    )


@router.get("/learnings/signals", response_model=list[LearningSignal])
async def get_learning_signals(
    db: TenantDB, applies_to: LearningTarget | None = None
) -> list[LearningSignal]:
    """Net signal of active learnings per module, question category or criterion.

    Advisory input for module and question recommendations; it changes no document.
    """
    return await outcomes.signals(db, applies_to)


@router.post("/learnings/{learning_id}/retire", response_model=LearningOut)
async def retire_learning(
    learning_id: uuid.UUID, body: LearningRetire, principal: Approver, db: TenantDB
) -> LearningOut:
    out = await _call(outcomes.retire_learning(db, principal, learning_id, body.reason))
    await db.commit()
    return out
