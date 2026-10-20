"""Light judging on the built-in model jobs (the ``quality_review`` job kind).

The job sends the version's sections and the ten criteria (never the rules' verdicts, so
the opinion is independent) and stores the answer as an evaluation report with evaluator
``llm_job``, labelled ``model_output``. Its findings are never hard and never feed a
readiness check: they are shown beside the rules and human ratings, and compared with
them, but they are not ground truth and never block a publish.
"""

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from oracle.jobs import prompting
from oracle.jobs.models import LlmJob
from oracle.quality import criteria
from oracle.v2 import models as m

DISCLAIMER = (
    "Model output from Oracle's built-in quality review job: an opinion to compare with the "
    "rules and human ratings, not independent ground truth. It never blocks a publish."
)
LABEL = "model_output"
STATUSES = ("pass", "warning", "critical", "not_applicable")
MAX_SECTION_CHARS = 2500


def payload(ctx: Any) -> dict[str, Any]:
    return {
        "document": {
            "title": ctx.document.title,
            "slug": ctx.document.slug,
            "version": ctx.version.number,
        },
        "sections": [
            {
                "section_key": s.section_key,
                "heading": s.heading,
                "layer": s.layer,
                "body": prompting.as_str(s.body_text, MAX_SECTION_CHARS),
            }
            for s in ctx.sections
        ],
        "criteria": [
            {"key": c.key, "title": c.title, "question": c.question} for c in criteria.CRITERIA
        ],
    }


def parse(answer: dict[str, Any], section_keys: set[str]) -> list[dict[str, Any]]:
    """Valid criteria only: known keys and statuses, one per key (the first wins)."""
    out: dict[str, dict[str, Any]] = {}
    for item in answer.get("criteria") or []:
        if not isinstance(item, dict):
            continue
        key, status = item.get("key"), item.get("status")
        if key not in criteria.KEYS or status not in STATUSES or key in out:
            continue
        keys = item.get("section_keys") or []
        out[key] = {
            "criterion": key,
            "status": status,
            "rationale": prompting.as_str(item.get("rationale"), 2000) or "No rationale given.",
            "section_keys": [k for k in keys if isinstance(k, str) and k in section_keys][:20],
        }
    return list(out.values())


async def run(s: AsyncSession, job: LlmJob, ask: Any, ctx: Any) -> dict[str, Any]:
    answer = await ask("quality_review", payload(ctx))
    findings = parse(answer, {x.section_key for x in ctx.sections})
    if not findings:
        raise prompting.AnswerError("the quality review judged no known criterion")
    counts: dict[str, int] = {}
    for f in findings:
        counts[f["status"]] = counts.get(f["status"], 0) + 1
    summary = prompting.as_str(answer.get("summary"), 2000)
    report = m.EvaluationReport(
        document_id=ctx.document.id,
        version_id=ctx.version.id,
        evaluator="llm_job",
        policy="advisory",
        status="complete",
        summary={
            "label": LABEL,
            "disclaimer": DISCLAIMER,
            "job_id": str(job.id),
            "counts": counts,
            "summary": summary,
        },
        created_by=job.requested_by,
    )
    s.add(report)
    await s.flush()
    for f in findings:
        s.add(m.EvaluationFinding(report_id=report.id, hard=False, **f))
    await s.flush()
    return {
        "report_id": str(report.id),
        "label": LABEL,
        "criteria": len(findings),
        "counts": counts,
        "summary": summary,
    }
