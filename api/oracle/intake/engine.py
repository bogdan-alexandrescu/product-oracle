"""The gap registry and question engine (§5 steps 1-6).

``analyze`` reads the intake's pinned snapshot and the baseline, and brings the gap
registry up to date:

1. extract from the brief and the pinned items (``oracle.intake.extract``);
2. check the baseline first (confirmed goals, their metrics and owners, confirmed
   constraints) and gaps already decided for the same PRD: those categories are
   *covered* and never asked. A decision elsewhere never clears a critical gap here
   (B4: an owner only): the gap is marked answered pending review, for an owner;
3. label every gap with its knowledge state (brief = hypothesis, sources = AI inference
   with its confidence, baseline = user decision);
4. keep source conflicts and stale evidence for the summary;
5. rank open gaps by their expected effect (``categories.rank_score``);
6. keep one question per open gap, drafted, then asked in short batches.

It never rewrites a decided gap (answered, answered pending review, validated, accepted
risk, deferred): later evidence only reaches open gaps, so in-progress decisions survive
a repin (S4). What the author's sources say (conflicts, stale evidence, a gap's
evidence) is registered as a finding with its sharing level (S6, ``oracle.intake.
sharing``). Questions are ranked, and batches asked, by what everyone may see: the
order never tells others which categories the author's private sources speak to.
Nothing here commits.
"""

import uuid
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.baseline.models import Edge, Entity
from oracle.intake import categories as cats
from oracle.intake import evidence as ev
from oracle.intake import extract, sharing
from oracle.v2.models import KnowledgeGap, ProductIntake, StakeholderQuestion

OPEN = frozenset({"unknown", "under_investigation", "asked"})
DECIDED = frozenset({"answered", "validated", "accepted_risk"})
# A critical gap answered below the owner role: not asked again, not cleared (B4).
PENDING = "answered_pending_review"
SETTLED = DECIDED | {"deferred", PENDING}
# Decided by an explicit decision: later non-answers never rewrite it.
FROZEN = frozenset({"validated", "accepted_risk"})
LOWER = {"critical": "critical", "high": "medium", "medium": "low", "low": "low"}
STATE_ORDER = ["unknown", "hypothesis", "ai_inference", "user_decision", "verified_fact"]
# Brief fields that speak to a category (the author's claim, a hypothesis).
BRIEF_FIELDS = {
    "customer_user": "users",
    "non_goals": "non_goals",
    "constraints": "dependencies",
    "blockers": "blockers",
}
MAX_EVIDENCE = 5


def _stronger(a: str, b: str) -> str:
    return a if STATE_ORDER.index(a) >= STATE_ORDER.index(b) else b


def _matches(entity_text: str, brief_terms: set[str]) -> bool:
    wanted = extract.terms(entity_text)
    if not wanted:
        return False
    need = min(2, len(wanted)) if len(wanted) < 4 else max(2, (len(wanted) + 1) // 2)
    return len(wanted & brief_terms) >= need


class Baseline:
    """What the baseline already says about the brief."""

    def __init__(self) -> None:
        self.goals: list[Entity] = []
        self.features: list[Entity] = []
        self.constraints: list[Entity] = []
        # Confirmed goals linked through a matched feature's supports edge.
        self.linked_goals: list[Entity] = []

    @property
    def confirmed_goals(self) -> list[Entity]:
        seen: dict[uuid.UUID, Entity] = {}
        for g in [*self.goals, *self.linked_goals]:
            if g.status == "confirmed":
                seen.setdefault(g.id, g)
        return list(seen.values())


async def read_baseline(db: AsyncSession, brief: str) -> Baseline:
    brief_terms = extract.terms(brief)
    out = Baseline()
    rows = (
        await db.scalars(
            select(Entity)
            .where(Entity.type.in_(("goal", "feature", "constraint")), Entity.status != "rejected")
            .order_by(Entity.key)
        )
    ).all()
    for e in rows:
        if not _matches(f"{e.title} {e.key.replace('-', ' ')}", brief_terms):
            continue
        {"goal": out.goals, "feature": out.features, "constraint": out.constraints}[e.type].append(
            e
        )
    if out.features:
        linked = (
            await db.scalars(
                select(Entity)
                .join(Edge, Edge.dst_id == Entity.id)
                .where(
                    Edge.type == "supports",
                    Edge.status != "rejected",
                    Edge.src_id.in_([f.id for f in out.features]),
                    Entity.type == "goal",
                    Entity.status == "confirmed",
                )
            )
        ).all()
        out.linked_goals = list(linked)
    return out


async def _owned_by(db: AsyncSession, ids: list[uuid.UUID]) -> bool:
    if not ids:
        return False
    found = await db.scalar(
        select(func.count())
        .select_from(Edge)
        .where(Edge.type == "owned_by", Edge.status == "confirmed", Edge.src_id.in_(ids))
    )
    return bool(found)


async def _decided_elsewhere(db: AsyncSession, intake: ProductIntake) -> dict[str, KnowledgeGap]:
    """Gaps decided for the same PRD (another intake, or the document itself), as
    everyone may see them: a gap its author has not shared decides nothing here."""
    if intake.document_id is None:
        return {}
    others = select(ProductIntake.id).where(
        ProductIntake.document_id == intake.document_id, ProductIntake.id != intake.id
    )
    rows = (
        await db.scalars(
            select(KnowledgeGap)
            .where(
                KnowledgeGap.status.in_(DECIDED),
                (KnowledgeGap.intake_id.in_(others))
                | (
                    (KnowledgeGap.document_id == intake.document_id)
                    & (KnowledgeGap.intake_id.is_(None))
                ),
            )
            .order_by(KnowledgeGap.updated_at.desc())
        )
    ).all()
    out: dict[str, KnowledgeGap] = {}
    registries: dict[uuid.UUID, Any] = {}
    for gap in rows:
        if gap.category in out:
            continue
        if gap.intake_id is not None:
            if gap.intake_id not in registries:
                other = await db.get(ProductIntake, gap.intake_id)
                registries[gap.intake_id] = sharing.registry(other) if other else {}
            if sharing.gap_view(gap, registries[gap.intake_id], sharing.EVERYONE) is None:
                continue
        out[gap.category] = gap
    return out


async def coverage_from_baseline(
    db: AsyncSession, intake: ProductIntake, baseline: Baseline
) -> dict[str, dict[str, Any]]:
    """Categories the baseline (or a decided gap of the same PRD) already answers."""
    covered: dict[str, dict[str, Any]] = {}
    goals = baseline.confirmed_goals
    if goals:
        covered["goal_alignment"] = {
            "reason": "Linked to confirmed goal(s): " + ", ".join(g.title for g in goals),
            "entity_ids": [str(g.id) for g in goals],
        }
        measured = [g for g in goals if (g.attrs or {}).get("metric") and g.attrs.get("target")]
        if measured:
            covered["success_metric"] = {
                "reason": "The confirmed goal has a metric and a target: "
                + "; ".join(f"{g.attrs['metric']} → {g.attrs['target']}" for g in measured),
                "entity_ids": [str(g.id) for g in measured],
            }
    owners = [
        e for e in [*goals, *baseline.features] if e.status == "confirmed" and e.attrs.get("owner")
    ]
    if owners or await _owned_by(db, [e.id for e in [*goals, *baseline.features]]):
        covered["ownership"] = {
            "reason": "The baseline names an owner for the linked goal or feature.",
            "entity_ids": [str(e.id) for e in owners],
        }
    constraints = [c for c in baseline.constraints if c.status == "confirmed"]
    if constraints:
        for key in ("constraints", "blockers"):
            covered[key] = {
                "reason": "Confirmed constraint(s) in the baseline: "
                + ", ".join(c.title for c in constraints),
                "entity_ids": [str(c.id) for c in constraints],
            }
    for category, gap in (await _decided_elsewhere(db, intake)).items():
        owner = await db.get(ProductIntake, gap.intake_id) if gap.intake_id else None
        reg = sharing.registry(owner) if owner is not None else {}
        covered.setdefault(
            category,
            {
                "reason": "Already decided for the same PRD: " + sharing.public_statement(reg, gap),
                "entity_ids": [str(i) for i in gap.entity_ids],
                # A person decided it; how the other gap was known (its author's
                # sources, a hypothesis) is not copied.
                "knowledge_state": "user_decision",
                "elsewhere": True,
            },
        )
    return covered


ELSEWHERE_REASON = (
    "Answered for the same PRD in another intake; an owner reviews it here before it "
    "counts as decided."
)


def _pending_elsewhere(
    db: AsyncSession,
    intake: ProductIntake,
    cat: cats.Category,
    existing: KnowledgeGap | None,
    importance: str,
    info: dict[str, Any],
    gaps: list[KnowledgeGap],
) -> KnowledgeGap:
    """A critical gap decided for the same PRD elsewhere: answered, pending an owner's
    review here (B4). It is not asked again, and it still holds the review gate."""
    entity_ids = [uuid.UUID(i) for i in info["entity_ids"]]
    if existing is None:
        existing = KnowledgeGap(
            intake_id=intake.id,
            document_id=intake.document_id,
            category=cat.key,
            statement=cat.statement,
            impact=list(cat.impact),
            importance=importance,
            evidence_ids=[],
            knowledge_state="user_decision",
            status=PENDING,
            related_modules=list(cat.modules),
            stop_condition=cat.stop,
            entity_ids=entity_ids,
            section_keys=[],
        )
        db.add(existing)
        gaps.append(existing)
    elif existing.status == "unknown":
        existing.status = PENDING
        existing.knowledge_state = "user_decision"
        existing.entity_ids = entity_ids
    return existing


async def intake_gaps(db: AsyncSession, intake_id: uuid.UUID) -> list[KnowledgeGap]:
    return list(
        (
            await db.scalars(
                select(KnowledgeGap)
                .where(KnowledgeGap.intake_id == intake_id)
                .order_by(KnowledgeGap.created_at, KnowledgeGap.id)
            )
        ).all()
    )


async def intake_questions(db: AsyncSession, intake_id: uuid.UUID) -> list[StakeholderQuestion]:
    return list(
        (
            await db.scalars(
                select(StakeholderQuestion)
                .where(StakeholderQuestion.intake_id == intake_id)
                .order_by(StakeholderQuestion.priority, StakeholderQuestion.created_at)
            )
        ).all()
    )


def rules_gap(gaps: list[KnowledgeGap], category: str) -> KnowledgeGap | None:
    statement = cats.BY_KEY[category].statement
    return next((g for g in gaps if g.category == category and g.statement == statement), None)


def score_of(gap: KnowledgeGap) -> float:
    conf = float(gap.confidence) if gap.confidence is not None else None
    return cats.rank_score(gap.importance, list(gap.impact), gap.knowledge_state, conf)


def group_of(gap: KnowledgeGap) -> int:
    if gap.status in OPEN:
        return 0
    return 1 if gap.status in ("deferred", PENDING) else 2


def ranked(gaps: list[KnowledgeGap]) -> list[KnowledgeGap]:
    """Open gaps first, by expected effect; then deferred; then decided."""
    return sorted(
        gaps,
        key=lambda g: (group_of(g), -score_of(g), cats.ORDER.get(g.category, 99), g.created_at),
    )


async def analyze(db: AsyncSession, intake: ProductIntake) -> None:
    """Bring the intake's analysis, gaps and draft questions up to date (no commit)."""
    items, _ = await ev.pinned_items(db, intake)
    brief = extract.from_brief(intake.brief)
    hits = extract.relevant(items, intake.brief)
    sources = extract.from_sources(hits, ev.STALE_FRESHNESS)
    baseline = await read_baseline(db, intake.brief)
    covered = await coverage_from_baseline(db, intake, baseline)
    gaps = await intake_gaps(db, intake.id)

    previous = intake.analysis or {}
    model_items = [i for i in previous.get("items") or [] if i.get("origin") == "llm"]
    brief_items = brief.items()
    by_field: dict[str, list[dict]] = {}
    for item in brief_items:
        by_field.setdefault(item["field"], []).append(item)

    coverage: list[dict[str, Any]] = []
    # What each category's knowledge state is without the author's sources (S6).
    public_states: dict[str, str] = {}
    for cat in cats.CATEGORIES:
        existing = rules_gap(gaps, cat.key)
        if cat.key in covered:
            info = covered[cat.key]
            state = info.get("knowledge_state", "user_decision")
            importance = (
                existing.importance
                if existing is not None
                else cats.importance_for(cat, brief.signals)
            )
            if info.get("elsewhere") and importance == "critical":
                existing = _pending_elsewhere(db, intake, cat, existing, importance, info, gaps)
                if existing.status not in DECIDED:
                    coverage.append(
                        {
                            "category": cat.key,
                            "state": "partial",
                            "knowledge_state": existing.knowledge_state,
                            "reason": ELSEWHERE_REASON
                            if existing.status == PENDING
                            else info["reason"],
                            "entity_ids": info["entity_ids"],
                            "gap_id": None,
                        }
                    )
                    continue
            coverage.append(
                {
                    "category": cat.key,
                    "state": "covered",
                    "knowledge_state": state,
                    "reason": info["reason"],
                    "entity_ids": info["entity_ids"],
                    "gap_id": str(existing.id) if existing else None,
                }
            )
            if existing is not None and existing.status == "unknown":
                # The baseline answers it now: close it, as the baseline says.
                existing.status = "answered"
                existing.knowledge_state = state
                existing.entity_ids = [uuid.UUID(i) for i in info["entity_ids"]]
            continue

        state, evidence_ids, conf = "unknown", [], None
        found = sorted(sources.by_category.get(cat.key, []), key=lambda i: -i.confidence)
        if found:
            state = "ai_inference"
            evidence_ids = [i.id for i in found[:MAX_EVIDENCE]]
            conf = ev.aggregate([i.confidence for i in found[:MAX_EVIDENCE]])
        brief_says = by_field.get(BRIEF_FIELDS.get(cat.key, ""), [])
        public_states[cat.key] = "hypothesis" if brief_says else "unknown"
        if brief_says and state == "unknown":
            state = "hypothesis"
        # From the brief alone (everyone reads it), never from the author's sources: a
        # gap's importance must not tell others which categories those sources speak to.
        importance = cats.importance_for(cat, brief.signals)
        if brief_says:
            importance = LOWER[importance]
        reason = {
            "unknown": "Nothing in the pinned sources or the baseline answers it.",
            "hypothesis": "Only the brief states it: " + "; ".join(i["text"] for i in brief_says),
            "ai_inference": f"{len(found)} pinned source item(s) seem to speak to it.",
        }[state]
        if existing is None:
            existing = KnowledgeGap(
                intake_id=intake.id,
                document_id=intake.document_id,
                category=cat.key,
                statement=cat.statement,
                impact=list(cat.impact),
                importance=importance,
                evidence_ids=evidence_ids,
                confidence=conf,
                knowledge_state=state,
                status="unknown",
                related_modules=list(cat.modules),
                stop_condition=cat.stop,
                entity_ids=[g.id for g in baseline.goals]
                if cat.key in ("goal_alignment", "success_metric")
                else [],
                section_keys=[],
            )
            db.add(existing)
            gaps.append(existing)
        elif existing.status in OPEN:
            # New evidence reaches an open gap; its status and importance stay.
            merged = list(existing.evidence_ids)
            merged += [i for i in evidence_ids if i not in merged]
            if merged != list(existing.evidence_ids):
                existing.evidence_ids = merged
                existing.confidence = conf if conf is not None else existing.confidence
            stronger = _stronger(existing.knowledge_state, state)
            if stronger != existing.knowledge_state and existing.knowledge_state != "user_decision":
                existing.knowledge_state = stronger
        settled = existing.status in SETTLED
        coverage.append(
            {
                "category": cat.key,
                "state": "covered" if existing.status in DECIDED else
                ("missing" if existing.knowledge_state == "unknown" else "partial"),
                "knowledge_state": existing.knowledge_state,
                "reason": f"Decided ({existing.status})." if settled else reason,
                "entity_ids": [str(i) for i in existing.entity_ids],
                "gap_id": None,
            }
        )  # fmt: skip
    await db.flush()
    for row in coverage:
        if row["gap_id"] is None:
            gap = rules_gap(gaps, row["category"])
            row["gap_id"] = str(gap.id) if gap else None

    reg, stale_ids = register_findings(intake, gaps, sources, {i.id for i in items}, public_states)

    hit_items = {
        cat: [str(i.id) for i in found] for cat, found in sources.by_category.items() if found
    }
    for item in brief_items:
        field = item["field"]
        evidence = []
        if field == "users":
            evidence = hit_items.get("customer_user", [])[:3]
        elif field == "problem":
            evidence = hit_items.get("pain_evidence", [])[:3]
        item["evidence_ids"] = evidence

    intake.analysis = {
        **{
            k: v for k, v in previous.items() if k in ("source_ids", "extraction", "model_category")
        },
        "findings": reg,
        "items": brief_items + model_items,
        "users": [{"text": u, "knowledge_state": "hypothesis"} for u in brief.users],
        "problem": {"text": brief.problem, "knowledge_state": "hypothesis"}
        if brief.problem
        else None,
        "outcomes": [{"text": o, "knowledge_state": "hypothesis"} for o in brief.outcomes],
        "goal_ids": [str(g.id) for g in baseline.confirmed_goals],
        "feature_ids": [str(f.id) for f in baseline.features],
        "constraint_ids": [str(c.id) for c in baseline.constraints],
        "scope": brief.features,
        "non_goals": brief.non_goals,
        "dependencies": brief.dependencies,
        "blockers": [{"text": b, "knowledge_state": "hypothesis"} for b in brief.blockers],
        "category": brief.category,
        "signals": brief.signals,
        "source_signals": sources.signals,
        "conflicts": sources.conflicts,
        "stale": [
            {"item_id": str(i.id), "freshness": i.freshness, "finding_id": stale_ids[i.id]}
            for i in sources.stale
        ],
        "coverage": coverage,
        "relevant_item_ids": [str(i.id) for i in hits],
    }
    await sync_questions(db, intake, gaps)
    if intake.status in ("draft", "analyzing", "awaiting_answers", "ready"):
        intake.status = "awaiting_answers" if any(g.status in OPEN for g in gaps) else "ready"
    await db.flush()


def conflict_category(conflict: dict[str, Any], sources: extract.SourceFacts) -> str:
    """The question category a source conflict is about (for counts and summaries)."""
    ids = {c["item_id"] for c in conflict["claims"]}
    spoken = [
        cat.key
        for cat in cats.CATEGORIES
        if any(str(i.id) in ids for i in sources.by_category.get(cat.key, []))
    ]
    return "success_metric" if "success_metric" in spoken or not spoken else spoken[0]


def register_findings(
    intake: ProductIntake,
    gaps: list[KnowledgeGap],
    sources: extract.SourceFacts,
    pinned_ids: set[uuid.UUID],
    public_states: dict[str, str] | None = None,
) -> tuple[dict[str, dict[str, Any]], dict[uuid.UUID, str]]:
    """Register what the author's sources say as findings (S6), keeping every level the
        author set. Conflicts and stale items no longer found are dropped; model-written
        items and gaps stay (the job registered them; one it never registered becomes a
        private model finding). A rule-made gap's finding keeps the knowledge state it has
    without the author's sources (``public_states``), which is what others see. Returns the
    registry and the stale items' finding ids."""
    old = sharing.registry(intake)
    reg = {k: v for k, v in old.items() if v.get("kind") in ("item", "gap")}
    for c in sources.conflicts:
        ids = sorted({cl["item_id"] for cl in c["claims"]})
        fid, previous, match = sharing.finding_id(old, intake.id, "conflict", c["topic"], *ids)
        c["finding_id"] = fid
        category = conflict_category(c, sources)
        reg[fid] = previous
        sharing.register(
            reg, fid, kind="conflict", origin="rules", category=category, source_item_ids=ids,
            summary=f"{len(ids)} of the author's sources disagree on a figure in "
            f"{sharing.category_label(category)} evidence.", match=match,
        )  # fmt: skip
    stale_ids: dict[uuid.UUID, str] = {}
    for item in sources.stale:
        fid, previous, match = sharing.finding_id(old, intake.id, "stale", str(item.id))
        stale_ids[item.id] = fid
        reg[fid] = previous
        sharing.register(
            reg, fid, kind="stale", origin="rules", category=None, source_item_ids=[item.id],
            summary=f"An item of the author's {item.row.source_kind} source was old when "
            "pinned.", match=match,
        )  # fmt: skip
    for gap in gaps:
        if str(gap.id) in reg and reg[str(gap.id)].get("origin") == "model":
            continue
        if sharing.model_written(gap):
            # Model text never registered as such (written before S6): a private model
            # finding, which its author may share.
            known = old.get(str(gap.id)) or {}
            reg[str(gap.id)] = known
            sharing.register(
                reg, str(gap.id), kind="gap", origin="model", category=gap.category,
                source_item_ids=[e for e in gap.evidence_ids if e in pinned_ids],
                gap_id=gap.id,
                summary=f"Oracle found an open question about "
                f"{sharing.category_label(gap.category)} in the author's sources.",
            )  # fmt: skip
            continue
        private = [e for e in gap.evidence_ids if e in pinned_ids]
        known = old.get(str(gap.id))
        if known is not None:
            private = list(dict.fromkeys([*known.get("source_item_ids", []), *map(str, private)]))
        if not private:
            continue
        reg[str(gap.id)] = known or {}
        sharing.register(
            reg, str(gap.id), kind="gap", origin="rules", category=gap.category,
            source_item_ids=private, gap_id=gap.id,
            public_state=(public_states or {}).get(gap.category, "unknown"),
            summary=f"Oracle found evidence about {sharing.category_label(gap.category)} in "
            "the author's sources.",
        )  # fmt: skip
    return reg, stale_ids


def question_prompt(gap: KnowledgeGap) -> str:
    return sharing.question_prompt(gap)


def priorities(intake: ProductIntake, gaps: list[KnowledgeGap]) -> dict[uuid.UUID, int]:
    """Each gap's question priority, from what everyone may see (S6).

    A gap's evidence, confidence and inferred state from the author's private sources
    do not move it: the gaps everyone sees are ranked as everyone sees them (10, 20,
    ...). A gap hidden from everyone else sits between them (an odd priority, seen by
    its author only), where its own facts rank it."""
    reg = sharing.registry(intake)
    public: dict[uuid.UUID, tuple] = {}
    for gap in gaps:
        changes = sharing.gap_changes(gap, reg, sharing.EVERYONE)
        if changes is None:
            continue
        state = changes.get("knowledge_state", gap.knowledge_state)
        conf = changes["confidence"] if "confidence" in changes else gap.confidence
        score = cats.rank_score(
            gap.importance, list(gap.impact), state, float(conf) if conf is not None else None
        )
        public[gap.id] = (group_of(gap), -score, cats.ORDER.get(gap.category, 99), gap.created_at)
    out = {gid: n * 10 for n, gid in enumerate(sorted(public, key=lambda g: public[g]), start=1)}
    seen = 0
    for gap in ranked(gaps):
        if gap.id in public:
            seen = max(seen, out[gap.id])
        else:
            out[gap.id] = seen + 5
    return out


async def sync_questions(
    db: AsyncSession, intake: ProductIntake, gaps: list[KnowledgeGap] | None = None
) -> None:
    """One question per open gap: draft new ones, re-prioritise drafts, withdraw drafts
    of gaps that were settled. Asked or answered questions are never touched."""
    gaps = gaps if gaps is not None else await intake_gaps(db, intake.id)
    questions = await intake_questions(db, intake.id)
    by_gap: dict[uuid.UUID, list[StakeholderQuestion]] = {}
    for q in questions:
        if q.gap_id is not None:
            by_gap.setdefault(q.gap_id, []).append(q)
    priority = priorities(intake, gaps)
    for gap in ranked(gaps):
        mine = by_gap.get(gap.id, [])
        live = [q for q in mine if q.status != "withdrawn"]
        if gap.status not in OPEN:
            for q in live:
                if q.status == "draft":
                    q.status = "withdrawn"
            continue
        cat = cats.BY_KEY[gap.category]
        rationale = cats.rank_reason(cat, gap.importance, list(gap.impact), gap.knowledge_state)
        drafts = [q for q in live if q.status == "draft"]
        for q in drafts:
            q.priority = priority[gap.id]
            q.rationale = rationale
        if live:
            continue
        if gap.status != "unknown":
            continue
        db.add(
            StakeholderQuestion(
                gap_id=gap.id,
                intake_id=intake.id,
                document_id=intake.document_id,
                category=gap.category,
                prompt=question_prompt(gap),
                rationale=rationale,
                priority=priority[gap.id],
                asked_to=gap.owner_id,
                module_key=(gap.related_modules or [None])[0],
                section_key=(gap.section_keys or [None])[0],
                status="draft",
            )
        )
    await db.flush()


async def ask_batch(
    db: AsyncSession,
    intake: ProductIntake,
    asked_by: uuid.UUID | None,
    size: int,
    skip: set[uuid.UUID] | frozenset[uuid.UUID] = frozenset(),
) -> list[StakeholderQuestion]:
    """Ask the next short batch: the highest-priority drafts, at most ``size``.
    ``skip``: gaps the asker may not see; their questions stay drafts."""
    questions = await intake_questions(db, intake.id)
    drafts = [q for q in questions if q.status == "draft" and q.gap_id not in skip][:size]
    if not drafts:
        return []
    number = max((q.batch or 0 for q in questions), default=0) + 1
    gap_ids = {q.gap_id for q in drafts if q.gap_id}
    gaps = {g.id: g for g in await intake_gaps(db, intake.id) if g.id in gap_ids}
    for q in drafts:
        q.status = "asked"
        q.batch = number
        q.asked_by = asked_by
        gap = gaps.get(q.gap_id) if q.gap_id else None
        if gap is not None and gap.status == "unknown":
            gap.status = "asked"
    await db.flush()
    return drafts
