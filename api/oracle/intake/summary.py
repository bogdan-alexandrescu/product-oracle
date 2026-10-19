"""Read models for the screens: the Opportunity and Gaps summary, the question batch
view and the composition inputs the modules lane's composer reads.

The baseline parts (goals, features and their traceability flags, conflicts) are read
live, so a goal confirmed after the intake shows at once; gaps change only through the
engine, answers and decisions.
"""

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.auth.deps import Principal
from oracle.baseline import conflicts as baseline_conflicts
from oracle.baseline import scoring
from oracle.baseline import trace as baseline_trace
from oracle.baseline.models import Conflict, Entity
from oracle.intake import categories as cats
from oracle.intake import engine
from oracle.intake import evidence as ev
from oracle.intake.answers import next_actions
from oracle.intake.models import IntakeProposal
from oracle.intake.schemas import (
    ANSWER_PATHS,
    BatchState,
    ClaimOut,
    ConflictRecommendation,
    ConflictView,
    Coverage,
    EvidenceRef,
    ExtractedItem,
    FeatureTrace,
    GateView,
    GoalLink,
    IntakeOut,
    IntakeProposalOut,
    IntakeSummary,
    ModuleHint,
    NewEvidence,
    NewEvidenceItem,
    Pinned,
    PinnedVersion,
    QuestionBatch,
    QuestionCard,
    RankedGap,
    StaleEvidence,
    TemplateHint,
)
from oracle.sources.models import Snapshot
from oracle.templates import service as templates_service
from oracle.templates.schemas import PrdAnswers, RecommendIn
from oracle.v2.models import KnowledgeGap, ProductIntake, StakeholderAnswer, StakeholderQuestion
from oracle.v2.schemas import (
    CompositionInputs,
    KnowledgeGapOut,
    StakeholderAnswerOut,
    StakeholderQuestionOut,
)

TOP = 5
NO_GOAL = (
    "Serves no confirmed company goal. Under goal-weighted prioritisation (O3) its score "
    "is the sum of goal weight × contribution, so it scores zero and sinks to the bottom "
    "of the priority order. Link it to a confirmed goal, or record a decision to proceed "
    "anyway."
)


def intake_out(intake: ProductIntake) -> IntakeOut:
    out = IntakeOut.model_validate(intake)
    out.source_ids = ev.source_ids_of(intake)
    return out


async def pinned(db: AsyncSession, intake: ProductIntake) -> Pinned:
    ids = list(intake.source_snapshot_ids)
    rows = {s.id: s for s in (await db.scalars(select(Snapshot).where(Snapshot.id.in_(ids)))).all()}
    versions = [
        PinnedVersion(version=i, snapshot_id=sid, as_of=rows[sid].as_of if sid in rows else None)
        for i, sid in enumerate(ids, start=1)
    ]
    last = versions[-1] if versions else None
    return Pinned(
        version=len(versions),
        snapshot_id=last.snapshot_id if last else None,
        as_of=last.as_of if last else None,
        versions=versions,
    )


async def new_evidence(
    db: AsyncSession, intake: ProductIntake, principal: Principal | None, pin: Pinned
) -> NewEvidence:
    snapshot = await db.get(Snapshot, pin.snapshot_id) if pin.snapshot_id else None
    found = await ev.new_since(db, intake, snapshot)
    visible = principal is not None and principal.id == intake.author_id
    items: list[NewEvidenceItem] = []
    if visible and found:
        refs = await ev.refs(db, [i for i, _ in found], principal, None)
        items = [
            NewEvidenceItem(**refs[i].model_dump(), change=change)  # type: ignore[arg-type]
            for i, change in found
            if i in refs
        ]
    return NewEvidence(
        since_version=pin.version,
        as_of=pin.as_of,
        count=len(found),
        visible=visible,
        items=items,
    )


def ranked_gaps(gaps: list[KnowledgeGap], refs: dict[uuid.UUID, EvidenceRef]) -> list[RankedGap]:
    out = []
    for position, gap in enumerate(engine.ranked(gaps), start=1):
        cat = cats.BY_KEY[gap.category]
        base = KnowledgeGapOut.model_validate(gap).model_dump()
        out.append(
            RankedGap(
                **base,
                rank=position,
                score=engine.score_of(gap),
                rank_reason=cats.rank_reason(
                    cat, gap.importance, list(gap.impact), gap.knowledge_state
                ),
                evidence=[refs[i] for i in gap.evidence_ids if i in refs],
            )
        )
    return out


async def goals_and_features(
    db: AsyncSession, intake: ProductIntake
) -> tuple[list[GoalLink], list[FeatureTrace]]:
    baseline = await engine.read_baseline(db, intake.brief)
    goals: dict[uuid.UUID, GoalLink] = {}
    for g in baseline.goals:
        if g.status == "confirmed":
            goals[g.id] = GoalLink(
                entity_id=g.id, key=g.key, title=g.title, status=g.status,
                knowledge_state="user_decision", matched_on="brief",
            )  # fmt: skip
    for g in baseline.linked_goals:
        goals.setdefault(
            g.id,
            GoalLink(
                entity_id=g.id, key=g.key, title=g.title, status=g.status,
                knowledge_state="user_decision", matched_on="feature",
            ),
        )  # fmt: skip
    report = await baseline_trace.report(db)
    by_id = {f.id: f for f in report.features}
    linked_ids = {link.goal_id for f in report.features for link in f.goals}
    status_of = dict(
        (await db.execute(select(Entity.id, Entity.status).where(Entity.id.in_(linked_ids)))).all()
    )
    features: list[FeatureTrace] = []
    for f in baseline.features:
        traced = by_id.get(f.id)
        flags = list(traced.flags) if traced else ["serves_no_goal"]
        served = [
            link
            for link in (traced.goals if traced else [])
            if status_of.get(link.goal_id) == "confirmed"
        ]
        rationale = NO_GOAL
        if "serves_no_goal" not in flags:
            rationale = (
                "Serves "
                + ", ".join(f"{link.title} (contribution {link.contribution})" for link in served)
                + ": goal-weighted prioritisation (O3) counts each goal's weight × contribution."
            )
        features.append(
            FeatureTrace(
                title=f.title,
                entity_id=f.id,
                key=f.key,
                knowledge_state="user_decision" if f.status == "confirmed" else "hypothesis",
                goals=[
                    GoalLink(
                        entity_id=link.goal_id,
                        key=link.key,
                        title=link.title,
                        status="confirmed",
                        knowledge_state="user_decision",
                        matched_on="feature",
                    )
                    for link in served
                ],  # fmt: skip
                flags=flags,
                rationale=rationale,
            )
        )
    confirmed = list(goals.values())
    for text in (intake.analysis or {}).get("scope") or []:
        features.append(
            FeatureTrace(
                title=text,
                knowledge_state="hypothesis",
                goals=confirmed,
                flags=[] if confirmed else ["serves_no_goal"],
                rationale=(
                    "From the brief; it serves "
                    + ", ".join(g.title for g in confirmed)
                    + ", a confirmed goal."
                )
                if confirmed
                else NO_GOAL,
            )
        )
    return confirmed, features


async def conflicts(
    db: AsyncSession,
    intake: ProductIntake,
    refs: dict[uuid.UUID, EvidenceRef],
) -> list[ConflictView]:
    settings = await scoring.company_weights(db)
    out: list[ConflictView] = []
    for c in (intake.analysis or {}).get("conflicts") or []:
        claims = c["claims"]
        winner, reason = baseline_conflicts.pick_winner(claims, settings)
        out.append(
            ConflictView(
                kind="source",
                topic=c["topic"],
                claims=[
                    ClaimOut(
                        value=cl["value"],
                        source_kind=cl.get("source_kind"),
                        source_class=cl.get("source_class"),
                        observed_at=cl.get("observed_at"),
                        confidence=cl.get("confidence"),
                        evidence=[r for r in [refs.get(uuid.UUID(cl["item_id"]))] if r],
                    )
                    for cl in claims
                ],
                recommendation=ConflictRecommendation(winner=winner, reason=reason),
                # It changes the success metric's baseline, so a person settles it (B3).
                material=True,
            )
        )
    analysis = intake.analysis or {}
    ids = [
        uuid.UUID(i)
        for key in ("goal_ids", "feature_ids", "constraint_ids")
        for i in analysis.get(key) or []
    ]
    if ids:
        titles = {
            e.id: e.title
            for e in (await db.scalars(select(Entity).where(Entity.id.in_(ids)))).all()
        }
        rows = (
            await db.scalars(
                select(Conflict)
                .where(Conflict.entity_id.in_(ids), Conflict.status != "resolved")
                .order_by(Conflict.created_at)
            )
        ).all()
        for row in rows:
            resolution = row.resolution or {}
            winner = resolution.get("winner")
            reason = resolution.get("reason")
            if reason is None and len(row.claims) >= 2:
                winner, reason = baseline_conflicts.pick_winner(row.claims, settings)
            out.append(
                ConflictView(
                    kind="baseline",
                    topic=f"{titles.get(row.entity_id, 'Baseline item')}: {row.field}",
                    claims=[
                        ClaimOut(
                            value=cl.get("value"),
                            source_kind=cl.get("source_kind"),
                            source_class=cl.get("source_class"),
                            observed_at=cl.get("observed_at"),
                            confidence=cl.get("confidence"),
                        )
                        for cl in row.claims
                    ],
                    recommendation=ConflictRecommendation(
                        winner=winner, reason=reason or "Not enough claims to compare."
                    ),
                    material=row.material,
                    conflict_id=row.id,
                )
            )
    return out


async def template_hint(
    db: AsyncSession, intake: ProductIntake, gaps: list[KnowledgeGap]
) -> TemplateHint:
    signals = (intake.analysis or {}).get("signals") or {}
    size = (
        "new_product"
        if signals.get("new_product")
        else "small_change"
        if signals.get("small_change")
        else "new_feature"
    )
    rec = await templates_service.recommend(
        db,
        RecommendIn(
            kind="prd", prd=PrdAnswers(size=size, model_driven=bool(signals.get("ai")) or None)
        ),
    )
    modules: dict[str, ModuleHint] = {
        "goals.outcomes": ModuleHint(
            key="goals.outcomes", policy="required",
            reason="Every feature traces to a confirmed company goal (F3b).",
        ),
        "problem.evidence": ModuleHint(
            key="problem.evidence", policy="required",
            reason="The problem needs evidence or an explicitly accepted assumption.",
        ),
    }  # fmt: skip
    for gap in engine.ranked(gaps):
        if gap.status in engine.DECIDED and gap.status != "accepted_risk":
            continue
        if gap.importance not in ("critical", "high"):
            continue
        for key in gap.related_modules:
            hint = modules.get(key)
            if hint is None:
                cat = cats.BY_KEY[gap.category]
                hint = ModuleHint(
                    key=key,
                    policy="conditional",
                    reason=f"{cat.label} is {gap.importance} for this idea.",
                )
                modules[key] = hint
            if gap.id not in hint.gap_ids:
                hint.gap_ids.append(gap.id)
    return TemplateHint(
        key=rec.template.key,
        name=rec.template.name,
        reason=rec.reason,
        theme=rec.theme.key if rec.theme else None,
        modules=list(modules.values()),
    )


def gate(gaps: list[KnowledgeGap]) -> GateView:
    unresolved = [g for g in gaps if g.importance == "critical" and g.status not in engine.DECIDED]
    blocking = [g.id for g in unresolved if g.category in cats.HARD_BLOCKER_CATEGORIES]
    return GateView(
        open_critical=len(unresolved),
        blocking_gap_ids=blocking,
        gate="blocked" if blocking else "clear",
    )


def batch_state(questions: list[StakeholderQuestion]) -> BatchState:
    batches = [q.batch for q in questions if q.batch is not None]
    return BatchState(
        current=max(batches) if batches else None,
        asked=sum(q.status in ("asked", "delegated") for q in questions),
        answered=sum(q.status == "answered" for q in questions),
        remaining=sum(q.status == "draft" for q in questions),
    )


async def proposals_of(db: AsyncSession, intake_id: uuid.UUID) -> list[IntakeProposalOut]:
    rows = (
        await db.scalars(
            select(IntakeProposal)
            .where(IntakeProposal.intake_id == intake_id)
            .order_by(IntakeProposal.created_at.desc(), IntakeProposal.id)
        )
    ).all()
    return [IntakeProposalOut.model_validate(p) for p in rows]


async def build(
    db: AsyncSession, intake: ProductIntake, principal: Principal | None
) -> IntakeSummary:
    pin = await pinned(db, intake)
    gaps = await engine.intake_gaps(db, intake.id)
    questions = await engine.intake_questions(db, intake.id)
    analysis = intake.analysis or {}
    item_ids: set[uuid.UUID] = {i for g in gaps for i in g.evidence_ids}
    for item in analysis.get("items") or []:
        item_ids |= {uuid.UUID(i) for i in item.get("evidence_ids") or []}
    for c in analysis.get("conflicts") or []:
        item_ids |= {uuid.UUID(cl["item_id"]) for cl in c["claims"]}
    stale_rows = analysis.get("stale") or []
    item_ids |= {uuid.UUID(s["item_id"]) for s in stale_rows}
    refs = await ev.refs(db, list(item_ids), principal, pin.as_of)

    ranked = ranked_gaps(gaps, refs)
    open_ranked = [g for g in ranked if g.status in engine.OPEN]
    goals, features = await goals_and_features(db, intake)
    by_gap = {str(g.id): g for g in gaps}
    coverage = []
    for row in analysis.get("coverage") or []:
        gap = by_gap.get(row.get("gap_id") or "")
        state = row["state"]
        knowledge = row["knowledge_state"]
        if gap is not None:
            knowledge = gap.knowledge_state
            if gap.status in engine.DECIDED:
                state = "covered"
        coverage.append(
            Coverage(
                category=row["category"],
                state=state,
                knowledge_state=knowledge,
                reason=row["reason"],
                entity_ids=row.get("entity_ids") or [],
                gap_id=row.get("gap_id"),
            )
        )
    actions = [a for g in gaps if g.importance == "critical" for a in next_actions(g)]
    return IntakeSummary(
        intake=intake_out(intake),
        pinned=pin,
        new_evidence=await new_evidence(db, intake, principal, pin),
        extracted=[
            ExtractedItem(
                field=i["field"],
                text=i["text"],
                knowledge_state=i["knowledge_state"],
                origin=i.get("origin", "brief"),
                evidence=[
                    refs[uuid.UUID(e)] for e in i.get("evidence_ids") or [] if uuid.UUID(e) in refs
                ],
            )
            for i in analysis.get("items") or []
        ],
        coverage=coverage,
        goals=goals,
        missing_goals=not goals,
        features=features,
        conflicts=await conflicts(db, intake, refs),
        stale=[
            StaleEvidence(
                evidence=refs[uuid.UUID(s["item_id"])],
                reason=f"Old when pinned: freshness {s['freshness']:.2f} of 1.",
            )
            for s in stale_rows
            if uuid.UUID(s["item_id"]) in refs
        ],
        assumptions=[g for g in open_ranked if g.knowledge_state in ("hypothesis", "ai_inference")],
        top_uncertainties=open_ranked[:TOP],
        gaps=ranked,
        next_actions=actions,
        template=await template_hint(db, intake, gaps),
        readiness=gate(gaps),
        batch=batch_state(questions),
        proposals=await proposals_of(db, intake.id),
    )


async def question_batch(
    db: AsyncSession, intake: ProductIntake, principal: Principal | None, number: int | None
) -> QuestionBatch:
    questions = await engine.intake_questions(db, intake.id)
    if number is None:
        number = max((q.batch for q in questions if q.batch is not None), default=None)
    chosen = [q for q in questions if number is not None and q.batch == number]
    gaps = {g.id: g for g in await engine.intake_gaps(db, intake.id)}
    answers: dict[uuid.UUID, list[StakeholderAnswer]] = {}
    if chosen:
        rows = (
            await db.scalars(
                select(StakeholderAnswer)
                .where(StakeholderAnswer.question_id.in_([q.id for q in chosen]))
                .order_by(StakeholderAnswer.created_at)
            )
        ).all()
        for a in rows:
            answers.setdefault(a.question_id, []).append(a)
    pin = await pinned(db, intake)
    ids = [i for q in chosen if q.gap_id in gaps for i in gaps[q.gap_id].evidence_ids]
    refs = await ev.refs(db, ids, principal, pin.as_of)
    cards = []
    for q in chosen:
        gap = gaps.get(q.gap_id) if q.gap_id else None
        cards.append(
            QuestionCard(
                question=StakeholderQuestionOut.model_validate(q),
                gap=KnowledgeGapOut.model_validate(gap) if gap else None,
                evidence=[refs[i] for i in (gap.evidence_ids if gap else []) if i in refs],
                answer_paths=list(ANSWER_PATHS),
                answers=[StakeholderAnswerOut.model_validate(a) for a in answers.get(q.id, [])],
            )
        )
    return QuestionBatch(
        intake_id=intake.id,
        batch=number,
        questions=cards,
        remaining=sum(q.status == "draft" for q in questions),
    )


async def composition_inputs(db: AsyncSession, intake: ProductIntake) -> CompositionInputs:
    """What the modules lane's composer reads for a PRD from this intake (§4.3 step 1)."""
    analysis = intake.analysis or {}
    gaps = await engine.intake_gaps(db, intake.id)
    open_critical = [
        g for g in gaps if g.importance == "critical" and g.status not in engine.DECIDED
    ]
    return CompositionInputs(
        brief={"title": intake.title, "text": intake.brief},
        category=analysis.get("category"),
        scope={
            "features": analysis.get("scope") or [],
            "non_goals": analysis.get("non_goals") or [],
            "dependencies": analysis.get("dependencies") or [],
        },
        signals=analysis.get("signals") or {},
        baseline={
            "goal_ids": analysis.get("goal_ids") or [],
            "feature_ids": analysis.get("feature_ids") or [],
            "constraint_ids": analysis.get("constraint_ids") or [],
        },
        sources={
            "source_ids": analysis.get("source_ids") or [],
            "relevant_items": len(analysis.get("relevant_item_ids") or []),
            "conflicts": len(analysis.get("conflicts") or []),
        },
        stakeholders={
            "answered": sum(g.status in engine.DECIDED for g in gaps),
            "open": sum(g.status in engine.OPEN for g in gaps),
        },
        outputs=["prd"],
        blockers={
            "open_critical_gap_ids": [str(g.id) for g in open_critical],
            "categories": sorted({g.category for g in open_critical}),
        },
        policy={},
        intake_id=intake.id,
        source_snapshot_ids=list(intake.source_snapshot_ids),
    )
