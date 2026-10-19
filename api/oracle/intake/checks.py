"""The intake's readiness checks (§5 step 8, ``oracle.readiness``).

- ``intake.critical_blockers`` (**hard**): a critical gap about blockers or third-party
  policy that nobody resolved. T2 lets only a critical unresolved hard blocker or an
  unsupported third-party operation block a publish; an owner can lift it by accepting
  the risk explicitly (``POST /v1/gaps/{id}/decisions``).
- ``intake.open_decisions`` (advisory): any other critical gap still open; it warns.

A document's gaps are its own and those of every intake linked to it, as everyone may
see them (S6): a model-written gap its author has not shared does not count here (the
rule-made gap of the same category does), a gap shared as a summary is named by
Oracle's summary, and evidence the author has not shared is not listed. A critical gap
answered below the owner role (``answered_pending_review``) stays unresolved (B4).
"""

from sqlalchemy import or_, select

from oracle import readiness
from oracle.intake import categories as cats
from oracle.intake import engine, sharing
from oracle.readiness import CheckOutcome, ReadinessContext
from oracle.v2.models import KnowledgeGap, ProductIntake

CRITICAL_BLOCKERS = "intake.critical_blockers"
OPEN_DECISIONS = "intake.open_decisions"


async def document_gaps(ctx: ReadinessContext) -> list:
    intakes = select(ProductIntake.id).where(ProductIntake.document_id == ctx.document_id)
    rows = (
        await ctx.db.scalars(
            select(KnowledgeGap)
            .where(
                or_(
                    KnowledgeGap.document_id == ctx.document_id,
                    KnowledgeGap.intake_id.in_(intakes),
                )
            )
            .order_by(KnowledgeGap.created_at, KnowledgeGap.id)
        )
    ).all()
    registries: dict = {}
    out = []
    for gap in rows:
        if gap.intake_id is not None and gap.intake_id not in registries:
            intake = await ctx.db.get(ProductIntake, gap.intake_id)
            registries[gap.intake_id] = sharing.registry(intake) if intake else {}
        view = sharing.gap_view(gap, registries.get(gap.intake_id) or {}, sharing.EVERYONE)
        if view is not None:
            out.append(view)
    return out


def _unresolved(gaps: list, hard: bool) -> list:
    return [
        g
        for g in gaps
        if g.importance == "critical"
        and g.status not in engine.DECIDED
        and (g.category in cats.HARD_BLOCKER_CATEGORIES) == hard
    ]


def _outcome(gaps: list, open_: list, bad: str, what: str):
    if not gaps:
        return CheckOutcome(status="not_applicable", rationale="No intake gaps for this PRD.")
    if not open_:
        return CheckOutcome(status="pass", rationale=f"No unresolved critical {what}.")
    listed = "; ".join(f"{g.id} ({g.category}: {g.statement})" for g in open_)
    return CheckOutcome(
        status=bad,  # type: ignore[arg-type]
        rationale=f"Unresolved critical {what}: {listed}. Answer them, or an owner accepts "
        "the risk explicitly.",
        evidence_ids=[i for g in open_ for i in g.evidence_ids],
        owner_id=next((g.owner_id for g in open_ if g.owner_id), None),
        section_keys=sorted({k for g in open_ for k in g.section_keys}),
    )


async def critical_blockers(ctx: ReadinessContext) -> CheckOutcome:
    gaps = await document_gaps(ctx)
    return _outcome(gaps, _unresolved(gaps, hard=True), "critical", "blocker or policy gaps")


async def open_decisions(ctx: ReadinessContext) -> CheckOutcome:
    gaps = await document_gaps(ctx)
    return _outcome(gaps, _unresolved(gaps, hard=False), "warning", "decisions")


def register() -> None:
    readiness.register_check(CRITICAL_BLOCKERS, critical_blockers, hard=True)
    readiness.register_check(OPEN_DECISIONS, open_decisions)
