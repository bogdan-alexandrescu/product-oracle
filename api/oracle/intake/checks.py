"""The intake's readiness checks (§5 step 8, ``oracle.readiness``).

- ``intake.critical_blockers`` (**hard**): a critical gap about blockers or third-party
  policy that nobody resolved. T2 lets only a critical unresolved hard blocker or an
  unsupported third-party operation block a publish; an owner can lift it by accepting
  the risk explicitly (``POST /v1/gaps/{id}/decisions``).
- ``intake.open_decisions`` (advisory): any other critical gap still open; it warns.

A document's gaps are its own and those of every intake linked to it, as everyone may
see them (S6): a model-written gap its author has not shared does not count here (the
rule-made gap of the same category does), a gap shared as a summary is named by its
summary line, and evidence the author has not shared is not listed. A critical gap
from the author's private sources blocks publishing only once its author shares it at
counts or above (owner, 2026-10-19), named then by its id and category alone; while it
is private, publish passes and the author alone, reading an advisory report
(``ReadinessContext.viewer``; never a publish report, which is stored), is warned. A
critical gap answered below the owner role (``answered_pending_review``) stays
unresolved (B4).
"""

from sqlalchemy import or_, select

from oracle import readiness
from oracle.intake import categories as cats
from oracle.intake import engine, sharing
from oracle.readiness import CheckOutcome, ReadinessContext
from oracle.v2.models import KnowledgeGap, ProductIntake

CRITICAL_BLOCKERS = "intake.critical_blockers"
OPEN_DECISIONS = "intake.open_decisions"


async def document_gaps(ctx: ReadinessContext) -> tuple[list, list]:
    """(the gaps as the gate counts them for everyone, the reader's own private gaps)."""
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
    owners: dict = {}
    public, private = [], []
    # A publish report is stored with the gate: it never carries one reader's private
    # findings, whoever asks (S6).
    reader = None if ctx.purpose == "publish" else ctx.viewer
    for gap in rows:
        if gap.intake_id is not None and gap.intake_id not in owners:
            intake = await ctx.db.get(ProductIntake, gap.intake_id)
            owners[gap.intake_id] = (sharing.registry(intake) if intake else {}, intake)
        reg, intake = owners.get(gap.intake_id) or ({}, None)
        view = sharing.gating_view(gap, reg)
        if view is not None:
            public.append(view)
        elif intake is not None and sharing.is_author(reader, intake):
            private.append(gap)
    return public, private


def _unresolved(gaps: list, hard: bool) -> list:
    return [
        g
        for g in gaps
        if g.importance == "critical"
        and g.status not in engine.DECIDED
        and (g.category in cats.HARD_BLOCKER_CATEGORIES) == hard
    ]


def _listed(gaps: list) -> str:
    return "; ".join(f"{g.id} ({g.category}: {g.statement})" for g in gaps)


def _outcome(gaps: list, open_: list, mine: list, bad: str, what: str):
    if not gaps and not mine:
        return CheckOutcome(status="not_applicable", rationale="No intake gaps for this PRD.")
    note = (
        f" Only you see this: your private critical {what} {_listed(mine)} gate nothing "
        "until you share them (counts or above)."
        if mine
        else ""
    )
    if not open_:
        return CheckOutcome(
            status="warning" if mine else "pass",
            rationale=f"No unresolved critical {what} others see.{note}"
            if mine
            else f"No unresolved critical {what}.",
        )
    return CheckOutcome(
        status=bad,  # type: ignore[arg-type]
        rationale=f"Unresolved critical {what}: {_listed(open_)}. Answer them, or an owner "
        f"accepts the risk explicitly.{note}",
        evidence_ids=[i for g in open_ for i in g.evidence_ids],
        owner_id=next((g.owner_id for g in open_ if g.owner_id), None),
        section_keys=sorted({k for g in open_ for k in g.section_keys}),
    )


async def critical_blockers(ctx: ReadinessContext) -> CheckOutcome:
    gaps, mine = await document_gaps(ctx)
    return _outcome(
        gaps, _unresolved(gaps, hard=True), _unresolved(mine, hard=True),
        "critical", "blocker or policy gaps",
    )  # fmt: skip


async def open_decisions(ctx: ReadinessContext) -> CheckOutcome:
    gaps, mine = await document_gaps(ctx)
    return _outcome(
        gaps, _unresolved(gaps, hard=False), _unresolved(mine, hard=False), "warning", "decisions"
    )


def register() -> None:
    readiness.register_check(CRITICAL_BLOCKERS, critical_blockers, hard=True)
    readiness.register_check(OPEN_DECISIONS, open_decisions)
