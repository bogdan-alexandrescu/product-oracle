"""The readiness dashboard of a document version, stored evaluations and model reviews.

The dashboard is live: it runs every registered readiness check (this lane's ten advisory
criteria and two hard checks, and the other lanes' checks) and shows beside each one the
latest model view and the human ratings of the version. It stores nothing. A stored
report is a snapshot someone asked for; nothing requires one.

Service functions flush but never commit; the router commits.
"""

import uuid
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, readiness
from oracle.docs import service as docs_service
from oracle.docs.models import Document, DocumentVersion
from oracle.jobs import service as jobs_service
from oracle.jobs.models import LlmJob
from oracle.quality import criteria, judge
from oracle.quality.schemas import (
    Agreement,
    HumanRatingIn,
    HumanView,
    ModelReviewInfo,
    ModelView,
    ReadinessDashboard,
    ReadinessItem,
    ReportRef,
)
from oracle.readiness import Purpose, ReadinessContext, ReadinessReport
from oracle.v2 import models as m
from oracle.v2.schemas import EvaluationFindingOut, EvaluationReportDetail

if TYPE_CHECKING:
    from oracle.auth.deps import Principal

POLICY_NOTE = (
    "T2 (owner decision, 2026-10-19): the evaluation is advisory. A criterion's critical is "
    "shown, never a stop. A publish is refused only by a hard check that is critical: the "
    "review and publish invariants, a critical unresolved hard blocker, or a failed critical "
    "security or policy check (unsupported third-party operation included). There is no "
    "numeric publish score."
)

# The other lanes' readiness checks, in plain words (qa-docs-57): what each one checks.
OTHER_CHECKS: dict[str, tuple[str, str]] = {
    "critical_blockers": (
        "Critical blockers",
        "Is any critical blocker still unresolved, with no accepted risk or approved "
        "experiment behind it?",
    ),
    "review_approvals": (
        "Review approvals",
        "Are the approvals and required sections of this version current?",
    ),
    "intake.critical_blockers": (
        "Critical open questions",
        "Is a critical question about blockers or policy still unanswered?",
    ),
    "intake.open_decisions": (
        "Open decisions",
        "Is a decision this PRD depends on still open?",
    ),
}
OTHER_CHECK_QUESTION = "Another readiness check this version must meet before it is published."


def check_words(key: str) -> tuple[str, str]:
    """A check's title and the question it answers, in plain words; never its key."""
    info = criteria.BY_KEY.get(key)
    if info:
        return info.title, info.question
    if key in OTHER_CHECKS:
        return OTHER_CHECKS[key]
    words = key.rsplit(".", 1)[-1].replace("_", " ").strip()
    return words.capitalize() or "Readiness check", OTHER_CHECK_QUESTION


STATUSES = ("pass", "warning", "critical", "not_applicable")


class QualityError(Exception):
    def __init__(self, status: int, message: str):
        self.status = status
        super().__init__(message)


async def get_version(db: AsyncSession, doc: str, n: int) -> tuple[Document, DocumentVersion]:
    try:
        document = await docs_service.get_document_or_404(db, doc)
        return document, await docs_service.get_version_row(db, document, n)
    except docs_service.NotFoundError as e:
        raise QualityError(404, str(e)) from e


async def evaluate(
    db: AsyncSession,
    document: Document,
    version: DocumentVersion,
    purpose: Purpose = "advisory",
) -> ReadinessReport:
    from oracle.review.publish import REVIEW_CHECK_KEY

    # The review invariants (approvals, required sections) are the publish check's, not a
    # quality result: counted there once, they never block the dashboard or a report.
    keys = [r.key for r in readiness.checks() if r.key != REVIEW_CHECK_KEY]
    return await readiness.evaluate(
        ReadinessContext(db, document.id, version.id, purpose=purpose), keys=keys
    )


def _counts(statuses: list[str]) -> dict[str, int]:
    return {s: statuses.count(s) for s in STATUSES}


async def _reports(
    db: AsyncSession, version_id: uuid.UUID, evaluator: str
) -> list[m.EvaluationReport]:
    return list(
        await db.scalars(
            select(m.EvaluationReport)
            .where(
                m.EvaluationReport.version_id == version_id,
                m.EvaluationReport.evaluator == evaluator,
                m.EvaluationReport.status == "complete",
            )
            .order_by(m.EvaluationReport.created_at.desc(), m.EvaluationReport.id)
        )
    )


async def _findings(db: AsyncSession, ids: list[uuid.UUID]) -> list[m.EvaluationFinding]:
    if not ids:
        return []
    return list(
        await db.scalars(
            select(m.EvaluationFinding)
            .where(m.EvaluationFinding.report_id.in_(ids))
            .order_by(m.EvaluationFinding.created_at)
        )
    )


async def dashboard(
    db: AsyncSession, doc: str, n: int, purpose: Purpose = "advisory"
) -> ReadinessDashboard:
    document, version = await get_version(db, doc, n)
    report = await evaluate(db, document, version, purpose)

    model_reports = await _reports(db, version.id, "llm_job")
    latest_model = model_reports[0] if model_reports else None
    model: dict[str, ModelView] = {}
    model_info = None
    if latest_model is not None:
        for f in await _findings(db, [latest_model.id]):
            model[f.criterion] = ModelView(
                status=f.status, rationale=f.rationale, section_keys=f.section_keys,
                report_id=latest_model.id,
            )  # fmt: skip
        job_id = latest_model.summary.get("job_id")
        job = await db.get(LlmJob, uuid.UUID(job_id)) if job_id else None
        model_info = ModelReviewInfo(
            report_id=latest_model.id,
            job_id=job.id if job else None,
            model=job.model if job else None,
            created_at=latest_model.created_at,
            disclaimer=latest_model.summary.get("disclaimer") or judge.DISCLAIMER,
        )

    # Human ratings: each rater's latest rating of each criterion.
    human: dict[str, list[HumanView]] = {}
    human_reports = await _reports(db, version.id, "human")
    by_report = {r.id: r for r in human_reports}
    seen: set[tuple[str, uuid.UUID | None]] = set()
    for f in reversed(await _findings(db, list(by_report))):
        r = by_report[f.report_id]
        if (f.criterion, r.created_by) in seen:
            continue
        seen.add((f.criterion, r.created_by))
        human.setdefault(f.criterion, []).append(
            HumanView(
                status=f.status, rationale=f.rationale, rater_id=r.created_by, report_id=r.id,
                created_at=r.created_at,
            )
        )  # fmt: skip

    items = []
    for r in report.results:
        title, question = check_words(r.key)
        views = human.get(r.key, [])
        mv = model.get(r.key)
        items.append(
            ReadinessItem(
                key=r.key,
                title=title,
                question=question,
                hard=r.hard,
                status=r.status,
                rationale=r.rationale,
                evidence_ids=r.evidence_ids,
                owner_id=r.owner_id,
                section_keys=r.section_keys,
                error=r.error,
                model=mv,
                human=views,
                agreement=Agreement(
                    model=None if mv is None else mv.status == r.status,
                    human=(
                        sum(v.status == r.status for v in views) / len(views) if views else None
                    ),
                ),
            )
        )
    latest_rules = await _reports(db, version.id, "rules")
    return ReadinessDashboard(
        document_id=document.id,
        slug=document.slug,
        version=version.number,
        version_id=version.id,
        composition_revision=await _composition_revision(db, document.id),
        policy_note=POLICY_NOTE,
        purpose=purpose,
        evaluated_at=datetime.now(UTC),
        blocked=report.blocked,
        blocking=[r.key for r in report.blocking],
        counts=_counts([i.status for i in items]),
        items=items,
        model_review=model_info,
        latest_report=(
            ReportRef(id=latest_rules[0].id, created_at=latest_rules[0].created_at)
            if latest_rules
            else None
        ),
    )


async def _composition_revision(db: AsyncSession, document_id: uuid.UUID) -> int | None:
    return await db.scalar(
        select(m.DocumentComposition.current_revision).where(
            m.DocumentComposition.document_id == document_id
        )
    )


async def _detail(db: AsyncSession, report: m.EvaluationReport) -> EvaluationReportDetail:
    out = EvaluationReportDetail.model_validate(report)
    out.findings = [
        EvaluationFindingOut.model_validate(f)
        for f in sorted(await _findings(db, [report.id]), key=lambda f: f.criterion)
    ]
    return out


async def store_report(
    db: AsyncSession, principal: "Principal", doc: str, n: int
) -> EvaluationReportDetail:
    """Snapshot the rules' evaluation of a version (every registered check)."""
    document, version = await get_version(db, doc, n)
    result = await evaluate(db, document, version)
    statuses = [r.status for r in result.results]
    row = m.EvaluationReport(
        document_id=document.id,
        version_id=version.id,
        composition_revision=await _composition_revision(db, document.id),
        evaluator="rules",
        policy="advisory",
        status="complete",
        summary={
            "counts": _counts(statuses),
            "blocked": result.blocked,
            "blocking": [r.key for r in result.blocking],
            "errors": [r.key for r in result.results if r.error],
        },
        created_by=principal.id,
    )
    db.add(row)
    await db.flush()
    for r in result.results:
        db.add(
            m.EvaluationFinding(
                report_id=row.id, criterion=r.key, status=r.status, hard=r.hard,
                rationale=r.rationale, evidence_ids=r.evidence_ids, owner_id=r.owner_id,
                section_keys=r.section_keys,
            )
        )  # fmt: skip
    await db.flush()
    await audit.record(
        db,
        principal,
        "evaluation_report.created",
        "evaluation_report",
        row.id,
        {
            "document_id": str(document.id),
            "version": version.number,
            "evaluator": "rules",
            "counts": row.summary["counts"],
            "blocked": result.blocked,
        },
    )
    return await _detail(db, row)


async def store_human_rating(
    db: AsyncSession, principal: "Principal", doc: str, n: int, data: HumanRatingIn
) -> EvaluationReportDetail:
    document, version = await get_version(db, doc, n)
    unknown = sorted({r.criterion for r in data.ratings} - set(criteria.KEYS))
    if unknown:
        raise QualityError(
            422,
            f"unknown criteria: {', '.join(unknown)}; expected one of {', '.join(criteria.KEYS)}",
        )
    if len({r.criterion for r in data.ratings}) != len(data.ratings):
        raise QualityError(422, "rate each criterion once")
    statuses = [r.status for r in data.ratings]
    row = m.EvaluationReport(
        document_id=document.id,
        version_id=version.id,
        composition_revision=await _composition_revision(db, document.id),
        evaluator="human",
        policy="advisory",
        status="complete",
        summary={"counts": _counts(statuses), "note": data.note},
        created_by=principal.id,
    )
    db.add(row)
    await db.flush()
    for r in data.ratings:
        db.add(
            m.EvaluationFinding(
                report_id=row.id, criterion=r.criterion, status=r.status, hard=False,
                rationale=r.rationale, section_keys=r.section_keys, owner_id=principal.id,
            )
        )  # fmt: skip
    await db.flush()
    await audit.record(
        db,
        principal,
        "evaluation_report.created",
        "evaluation_report",
        row.id,
        {"document_id": str(document.id), "version": version.number, "evaluator": "human"},
    )
    return await _detail(db, row)


async def queue_model_review(db: AsyncSession, principal: "Principal", doc: str, n: int) -> LlmJob:
    document, version = await get_version(db, doc, n)
    try:
        return await jobs_service.enqueue(
            db, document, "quality_review", version=version, principal=principal
        )
    except jobs_service.JobError as e:
        raise QualityError(e.status, str(e)) from e
