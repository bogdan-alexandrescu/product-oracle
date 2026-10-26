"""Read models for the screens: the Opportunity and Gaps summary, the question batch
view and the composition inputs the modules lane's composer reads.

The baseline parts (goals, features and their traceability flags, conflicts) are read
live, so a goal confirmed after the intake shows at once; gaps change only through the
engine, answers and decisions.

Every read model is built for its reader (S6, ``oracle.intake.sharing``): the intake's
author sees every finding; anyone else, and every run token, sees each finding drawn
from the author's sources only as its sharing level allows, including in counts,
rankings and the review gate shown here.
"""

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.auth.deps import Principal
from oracle.baseline import conflicts as baseline_conflicts
from oracle.baseline import scoring
from oracle.baseline import trace as baseline_trace
from oracle.baseline.models import Conflict, Entity
from oracle.intake import categories as cats
from oracle.intake import drafting, engine, sharing
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
    FindingCount,
    GateView,
    GoalLink,
    IntakeOut,
    IntakeProposalOut,
    IntakeSummary,
    ModuleHint,
    NewEvidence,
    NewEvidenceItem,
    NextBatch,
    Pinned,
    PinnedVersion,
    QuestionBatch,
    QuestionCard,
    RankedGap,
    StaleEvidence,
    TemplateHint,
)
from oracle.runs.models import Run
from oracle.sources.models import Snapshot
from oracle.templates import service as templates_service
from oracle.templates.schemas import PrdAnswers, RecommendIn
from oracle.v2.models import KnowledgeGap, ProductIntake, StakeholderAnswer
from oracle.v2.schemas import (
    CompositionInputs,
    IntakeAnalysis,
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


async def intake_out(
    db: AsyncSession, intake: ProductIntake, principal: Principal | None
) -> IntakeOut:
    v = sharing.viewer(principal, intake)
    out = IntakeOut.model_validate(intake)
    out.status = await engine.status_for(db, intake, v)  # type: ignore[assignment]
    out.source_ids = ev.source_ids_of(intake)
    out.analysis = IntakeAnalysis.model_validate(sharing.analysis_view(intake, v))
    out.goal_ids = list(intake.goal_ids or [])
    out.out_of_scope = list(intake.out_of_scope or [])
    out.template = intake.draft_template
    out.theme = intake.draft_theme
    out.prd_answers = PrdAnswers.model_validate(intake.prd_answers) if intake.prd_answers else None
    out.run_ids = await run_ids(db, intake.id)
    return out


async def run_ids(db: AsyncSession, intake_id: uuid.UUID) -> list[uuid.UUID]:
    """Runs started from the intake (``knobs.intake_id``), newest first (C4)."""
    return list(
        await db.scalars(
            select(Run.id)
            .where(Run.knobs["intake_id"].astext == str(intake_id))
            .order_by(Run.created_at.desc(), Run.id)
        )
    )


async def pinned_snapshot(db: AsyncSession, pin: Pinned) -> Snapshot | None:
    return await db.get(Snapshot, pin.snapshot_id) if pin.snapshot_id else None


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
    """What changed in the author's sources since the pin: for the author only (it is
    drawn from their sources); anyone else sees neither the items nor their number."""
    visible = sharing.is_author(principal, intake)
    if not visible:
        return NewEvidence(since_version=pin.version, as_of=pin.as_of, count=None, visible=False)
    snapshot = await pinned_snapshot(db, pin)
    found = await ev.new_since(db, intake, snapshot)
    items: list[NewEvidenceItem] = []
    if found:
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
        visible=True,
        items=items,
    )


def ranked_gaps(
    gaps: list,
    refs: dict[uuid.UUID, EvidenceRef],
    reg: dict[str, dict] | None = None,
    v: sharing.Viewer = sharing.EVERYONE,
) -> list[RankedGap]:
    """Gaps in rank order. A gap's finding id and level show to its author, and to
    others only once it is shared at counts or above: a private finding's id or level
    would tell them the author's sources speak to its category (S6)."""
    reg = reg or {}
    out = []
    for position, gap in enumerate(engine.ranked(gaps), start=1):
        cat = cats.BY_KEY[gap.category]
        base = KnowledgeGapOut.model_validate(gap).model_dump()
        level = sharing.level_of(reg, gap.id)
        if level is not None and not v.is_author and sharing.RANK[level] < sharing.RANK["counts"]:
            level = None
        out.append(
            RankedGap(
                **base,
                rank=position,
                score=engine.score_of(gap),
                rank_reason=cats.rank_reason(
                    cat, gap.importance, list(gap.impact), gap.knowledge_state
                ),
                evidence=[refs[i] for i in gap.evidence_ids if i in refs],
                finding_id=gap.id if level is not None else None,
                sharing=level,  # type: ignore[arg-type]
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
    analysis: dict | None = None,
) -> list[ConflictView]:
    """Source conflicts as the reader may see them (``analysis``: the reader's view of
    the stored analysis), then the baseline's own conflicts on the linked entities."""
    settings = await scoring.company_weights(db)
    reg = sharing.registry(intake)
    out: list[ConflictView] = []
    shown = analysis if analysis is not None else (intake.analysis or {})
    for c in shown.get("conflicts") or []:
        claims = c["claims"]
        if c.get("summary_only"):
            winner, reason = None, "Shared as a summary only: the values stay with the author."
        else:
            winner, reason = baseline_conflicts.pick_winner(claims, settings)
        out.append(
            ConflictView(
                kind="source",
                finding_id=c.get("finding_id"),
                sharing=sharing.level_of(reg, c.get("finding_id")),  # type: ignore[arg-type]
                summary_only=bool(c.get("summary_only")),
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


def _unresolved_critical(gaps: list) -> list:
    return [g for g in gaps if g.importance == "critical" and g.status not in engine.DECIDED]


def gate(view: "View") -> GateView:
    """The review gate as everyone sees it (S6 decision 1): a private critical gap gates
    nothing until its author shares it at counts or above; the author alone sees their
    private blockers listed apart."""
    raw = list(view.raw.values())
    public = [g for g in (sharing.gating_view(g, view.reg) for g in raw) if g is not None]
    unresolved = _unresolved_critical(public)
    blocking = [g.id for g in unresolved if g.category in cats.HARD_BLOCKER_CATEGORIES]
    private: list[uuid.UUID] = []
    if view.v.is_author:
        private = [
            g.id
            for g in _unresolved_critical([g for g in raw if sharing.withheld(g, view.reg)])
            if g.category in cats.HARD_BLOCKER_CATEGORIES
        ]
    return GateView(
        open_critical=len(unresolved),
        blocking_gap_ids=blocking,
        gate="blocked" if blocking else "clear",
        private_blocking_gap_ids=private,
    )


def batch_state(questions: list) -> BatchState:
    batches = [q.batch for q in questions if q.batch is not None]
    return BatchState(
        current=max(batches) if batches else None,
        asked=sum(q.status in ("asked", "delegated") for q in questions),
        answered=sum(q.status == "answered" for q in questions),
        remaining=sum(q.status == "draft" for q in questions),
    )


async def proposals_of(
    db: AsyncSession, intake: ProductIntake, principal: Principal | None
) -> list[IntakeProposalOut]:
    """The intake's proposals, leaving out those of gaps the reader may not see."""
    rows = (
        await db.scalars(
            select(IntakeProposal)
            .where(IntakeProposal.intake_id == intake.id)
            .order_by(IntakeProposal.created_at.desc(), IntakeProposal.id)
        )
    ).all()
    hidden = await hidden_gap_ids(db, intake, principal)
    return [IntakeProposalOut.model_validate(p) for p in rows if p.gap_id not in hidden]


async def hidden_gap_ids(
    db: AsyncSession, intake: ProductIntake, principal: Principal | None
) -> set[uuid.UUID]:
    v = sharing.viewer(principal, intake)
    if v.is_author:
        return set()
    reg = sharing.registry(intake)
    return {
        g.id for g in await engine.intake_gaps(db, intake.id) if sharing.gap_view(g, reg, v) is None
    }


class View:
    """The intake as one reader may see it: gaps, questions, analysis, shared items."""

    def __init__(self, intake: ProductIntake, principal: Principal | None) -> None:
        self.intake = intake
        self.principal = principal
        self.v = sharing.viewer(principal, intake)
        self.reg = sharing.registry(intake)
        self.analysis = sharing.analysis_view(intake, self.v)
        # What findings shared in full released (freeze at sharing), for anyone else.
        self.reveal = set() if self.v.is_author else sharing.frozen_item_ids(self.reg)
        self.raw: dict[uuid.UUID, KnowledgeGap] = {}
        self.gaps: list = []
        self.views: dict[uuid.UUID, Any] = {}
        self.questions: list = []

    async def load(self, db: AsyncSession) -> "View":
        raw = await engine.intake_gaps(db, self.intake.id)
        self.raw = {g.id: g for g in raw}
        self.views = sharing.gap_views(raw, self.reg, self.v)
        self.gaps = [self.views[g.id] for g in raw if g.id in self.views]
        # Anyone but the author reads each question's place among what everyone sees,
        # ranked with the learnings of the last sync, as the stored order is.
        learned = engine.synced_learned(self.intake)
        priorities = None if self.v.is_author else engine.priorities(self.intake, raw, learned)
        self.questions = [
            q
            for q in (
                sharing.question_view(q, self.raw, self.views, priorities, learned)
                for q in await engine.intake_questions(db, self.intake.id)
            )
            if q is not None
        ]
        self.questions.sort(key=lambda q: (q.priority, q.created_at))
        return self

    def importance(self, gap: Any) -> str:
        """The gap's importance as everyone reads it (S6): what names who decides it and
        what counts as an open critical gap, for every reader alike."""
        raw = self.raw.get(gap.id)
        return sharing.public_importance(raw, self.reg) if raw is not None else gap.importance

    async def refs(
        self, db: AsyncSession, ids: set[uuid.UUID], pin: Pinned
    ) -> dict[uuid.UUID, EvidenceRef]:
        snapshot = await pinned_snapshot(db, pin)
        reveal = self.reveal
        released: dict[uuid.UUID, uuid.UUID] | None = None
        if self.v.is_run:
            # A run reads an item a finding shared in full cites only while no intake
            # withholds it (S6, owner 2026-10-19): not its title or excerpt either.
            released = await ev.run_include(db, self.intake)
            reveal = reveal & set(released)
        elif reveal:
            # Shown at the version sharing released (freeze at sharing).
            released = await ev.released_versions(db, sharing.frozen_pairs(self.reg))
        return await ev.refs(
            db,
            ids,
            self.principal,
            pin.as_of,
            txn_snapshot=snapshot.txn_snapshot if snapshot else None,
            reveal=reveal,
            released=released,
        )


def excerpt_item_ids(value: Any) -> list[str]:
    """Source items whose title, link or excerpt a response carries (to audit the read)."""
    found: list[str] = []

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            if node.get("untrusted") is True and node.get("visible") and node.get("source_item_id"):
                found.append(str(node["source_item_id"]))
            for child in node.values():
                walk(child)
        elif isinstance(node, list):
            for child in node:
                walk(child)

    walk(value.model_dump(mode="json") if hasattr(value, "model_dump") else value)
    return list(dict.fromkeys(found))


async def build(
    db: AsyncSession, intake: ProductIntake, principal: Principal | None
) -> IntakeSummary:
    pin = await pinned(db, intake)
    view = await View(intake, principal).load(db)
    gaps, questions, analysis = view.gaps, view.questions, view.analysis
    item_ids: set[uuid.UUID] = {i for g in gaps for i in g.evidence_ids}
    for item in analysis.get("items") or []:
        item_ids |= {uuid.UUID(i) for i in item.get("evidence_ids") or []}
    for c in analysis.get("conflicts") or []:
        item_ids |= {uuid.UUID(cl["item_id"]) for cl in c["claims"]}
    stale_rows = analysis.get("stale") or []
    item_ids |= {uuid.UUID(s["item_id"]) for s in stale_rows}
    refs = await view.refs(db, item_ids, pin)
    for s in stale_rows:
        item_id = uuid.UUID(s["item_id"])
        if s.get("summary_only") and item_id in refs and not refs[item_id].visible:
            # A stale finding at summary shows its line, never how old the item is: its
            # confidence counts freshness, so it is left out below "shared in full".
            refs[item_id] = refs[item_id].model_copy(update={"confidence": None})

    ranked = ranked_gaps(gaps, refs, view.reg, view.v)
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
                gap_id=row.get("gap_id") if gap is not None else None,
            )
        )
    actions = [
        a
        for g in engine.ranked(gaps)
        if view.importance(g) == "critical"
        for a in next_actions(g, view.importance(g))
    ]
    return IntakeSummary(
        intake=await intake_out(db, intake, principal),
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
                finding_id=i.get("finding_id"),
                sharing=sharing.level_of(view.reg, i.get("finding_id")),  # type: ignore[arg-type]
            )
            for i in analysis.get("items") or []
        ],
        coverage=coverage,
        goals=goals,
        missing_goals=not goals,
        features=features,
        conflicts=await conflicts(db, intake, refs, analysis),
        stale=[
            StaleEvidence(
                evidence=refs[uuid.UUID(s["item_id"])],
                reason=s["summary"]
                if s.get("summary_only")
                else f"Old when pinned: freshness {s['freshness']:.2f} of 1.",
                finding_id=s.get("finding_id"),
                sharing=sharing.level_of(view.reg, s.get("finding_id")),  # type: ignore[arg-type]
            )
            for s in stale_rows
            if uuid.UUID(s["item_id"]) in refs
        ],
        assumptions=[g for g in open_ranked if g.knowledge_state in ("hypothesis", "ai_inference")],
        top_uncertainties=open_ranked[:TOP],
        gaps=ranked,
        next_actions=actions,
        template=await template_hint(db, intake, gaps),
        readiness=gate(view),
        batch=batch_state(questions),
        proposals=await proposals_of(db, intake, principal),
        shared_counts=[FindingCount(**c) for c in sharing.counts(view.reg, view.v)],
        is_author=view.v.is_author,
        **await _drafting(db, intake, view),
    )


async def _drafting(db: AsyncSession, intake: ProductIntake, view: "View") -> dict[str, Any]:
    """The intake's draft run, and how many answers the reader may see came after it
    started (C5: that run reads the ones before)."""
    run = await drafting.draft_run(db, intake)
    if run is None:
        return {}
    since = 0
    pinned = (run.knobs or {}).get(drafting.ANSWER_IDS)
    if intake.status == "converted" and isinstance(pinned, list) and view.questions:
        kept = {str(i) for i in pinned}
        ids = await db.scalars(
            select(StakeholderAnswer.id).where(
                StakeholderAnswer.question_id.in_([q.id for q in view.questions])
            )
        )
        since = sum(str(a) not in kept for a in ids)
    return {"draft_run_id": run.id, "answers_since_run": since}


async def _cards(
    db: AsyncSession,
    intake: ProductIntake,
    principal: Principal | None,
    view: "View",
    chosen: list,
) -> list[QuestionCard]:
    """Question cards as the reader may see them: gap, evidence, answers. A run reads the
    answers given before it started only (C5, :mod:`oracle.intake.drafting`)."""
    gaps = view.views
    answers: dict[uuid.UUID, list[StakeholderAnswer]] = {}
    if chosen:
        pin = await drafting.pin_of(db, principal)
        rows = (
            await db.scalars(
                select(StakeholderAnswer)
                .where(StakeholderAnswer.question_id.in_([q.id for q in chosen]))
                .order_by(StakeholderAnswer.created_at)
            )
        ).all()
        for a in rows:
            if pin is None or pin.keeps(intake.id, a.id):
                answers.setdefault(a.question_id, []).append(a)
    pin = await pinned(db, intake)
    ids = {i for q in chosen if q.gap_id in gaps for i in gaps[q.gap_id].evidence_ids}
    refs = await view.refs(db, ids, pin)
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
    return cards


async def question_batch(
    db: AsyncSession, intake: ProductIntake, principal: Principal | None, number: int | None
) -> QuestionBatch:
    view = await View(intake, principal).load(db)
    questions = view.questions
    if number is None:
        number = max((q.batch for q in questions if q.batch is not None), default=None)
    chosen = [q for q in questions if number is not None and q.batch == number]
    return QuestionBatch(
        intake_id=intake.id,
        batch=number,
        questions=await _cards(db, intake, principal, view, chosen),
        remaining=sum(q.status == "draft" for q in questions),
    )


async def next_batch(
    db: AsyncSession, intake: ProductIntake, principal: Principal, size: int
) -> NextBatch:
    """The next batch as ``principal`` would ask it (C5): the questions
    :func:`engine.choose_batch` picks, in order, each with the person it would be asked of
    (:func:`engine.default_person`). Nothing is asked or changed."""
    view = await View(intake, principal).load(db)
    raw = await engine.intake_questions(db, intake.id)
    skip = await hidden_gap_ids(db, intake, principal)
    batch = engine.choose_batch(raw, view.raw, view.reg, size, skip)
    shown = {q.id: q for q in view.questions}
    able: dict[uuid.UUID, bool] = {}
    chosen = []
    for q in batch.questions:
        gap = view.raw.get(q.gap_id) if q.gap_id else None
        hidden = gap is not None and sharing.gap_changes(gap, view.reg, sharing.EVERYONE) is None
        person = await engine.default_person(db, intake, q, gap, principal.id, hidden, able)
        # A copy: the stored row keeps its person until the batch is asked.
        out = StakeholderQuestionOut.model_validate(shown[q.id])
        chosen.append(out.model_copy(update={"asked_to": person}))
    return NextBatch(
        questions=await _cards(db, intake, principal, view, chosen),
        remaining=sum(q.status == "draft" for q in view.questions),
    )


async def composition_inputs(
    db: AsyncSession, intake: ProductIntake, principal: Principal | None
) -> CompositionInputs:
    """What the modules lane's composer reads for a PRD from this intake (§4.3 step 1),
    as the reader may see it (S6)."""
    view = await View(intake, principal).load(db)
    analysis = view.analysis
    gaps = view.gaps
    conflict_count = len(analysis.get("conflicts") or []) + sum(
        c["count"] for c in analysis.get("shared_counts") or [] if c["kind"] == "conflict"
    )
    open_critical = [
        g for g in gaps if view.importance(g) == "critical" and g.status not in engine.DECIDED
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
            "conflicts": conflict_count,
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
