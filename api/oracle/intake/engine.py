"""The gap registry and question engine (§5 steps 1-6).

``analyze`` reads the intake's pinned snapshot and the baseline, and brings the gap
registry up to date:

1. extract from the brief and the pinned items (``oracle.intake.extract``);
2. check the baseline first (confirmed goals, their metrics and owners, confirmed
   constraints) and gaps already decided for the same PRD: those categories are
   *covered* and never asked. Neither a decision elsewhere nor the baseline clears a
   critical gap here (B4): the gap is marked answered pending review, for the role
   that reviews it (an owner for a hard blocker, else an approver);
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
order never tells others which categories the author's private sources speak to;
batch sizes and numbers, the intake's status and each coverage row are counted in what
everyone may see too. Rule-made gaps carry their category as ``rule_key``. Nothing here
commits.
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

OPEN = sharing.OPEN_STATUSES
DECIDED = frozenset({"answered", "validated", "accepted_risk"})
# A critical gap answered below the owner role: not asked again, not cleared (B4).
PENDING = "answered_pending_review"
SETTLED = DECIDED | {"deferred", PENDING}
# Decided by an explicit decision: later non-answers never rewrite it.
FROZEN = frozenset({"validated", "accepted_risk"})
STATE_ORDER = sharing.STATE_ORDER
BRIEF_FIELDS = cats.BRIEF_FIELDS
MAX_EVIDENCE = 5


_stronger = sharing.stronger


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


def elsewhere_reason(category: str) -> str:
    """Why a critical gap decided elsewhere waits here, naming who reviews it (B4)."""
    return (
        f"Answered for the same PRD in another intake; an {cats.reviewer(category)} reviews "
        "it here before it counts as decided."
    )


def baseline_reason(category: str, reason: str) -> str:
    """Why a critical gap the baseline answers waits for review here (B4)."""
    return (
        f"{reason.rstrip('.')}. A critical gap is not closed by the baseline alone: an "
        f"{cats.reviewer(category)} reviews it here before it counts as decided."
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
            rule_key=cat.key,
            impact=list(cat.impact),
            importance=importance,
            importance_basis="brief",
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
    elif existing.status in OPEN:
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
    """The category's rule-made gap, by its stable key (never by its statement text)."""
    return next((g for g in gaps if g.category == category and g.rule_key == category), None)


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


def _row(gap: KnowledgeGap, knowledge: str, reason: str) -> dict[str, Any]:
    """A coverage row's state, knowledge state and reason for a rule-made gap."""
    return {
        "state": "covered" if gap.status in DECIDED else
        ("missing" if knowledge == "unknown" else "partial"),
        "knowledge_state": knowledge,
        "reason": f"Decided ({gap.status})." if gap.status in SETTLED else reason,
    }  # fmt: skip


async def analyze(db: AsyncSession, intake: ProductIntake) -> None:
    """Bring the intake's analysis, gaps and draft questions up to date (no commit)."""
    items, _ = await ev.pinned_items(db, intake)
    brief = extract.from_brief(intake.brief)
    hits = extract.relevant(items, intake.brief)
    sources = extract.from_sources(hits, ev.STALE_FRESHNESS)
    baseline = await read_baseline(db, intake.brief)
    covered = await coverage_from_baseline(db, intake, baseline)
    gaps = await intake_gaps(db, intake.id)
    _record_importance_basis(intake, gaps)

    previous = intake.analysis or {}
    model_items = [i for i in previous.get("items") or [] if i.get("origin") == "llm"]
    brief_items = brief.items()
    by_field: dict[str, list[dict]] = {}
    for item in brief_items:
        by_field.setdefault(item["field"], []).append(item)

    coverage: list[dict[str, Any]] = []
    # What each category's knowledge state is without the author's sources (S6), and
    # each coverage row that reads differently without them.
    public_states: dict[str, str] = {}
    # What the author's sources say about each open rule-made gap: (evidence, conf).
    private: dict[str, tuple[list[uuid.UUID], float | None]] = {}
    public_coverage: dict[str, dict[str, Any]] = {}
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
                            "reason": elsewhere_reason(cat.key)
                            if existing.status == PENDING
                            else info["reason"],
                            "entity_ids": info["entity_ids"],
                            "gap_id": None,
                        }
                    )
                    continue
            if existing is not None and existing.status in OPEN:
                # The baseline answers it now, as the baseline says (asked or under
                # investigation too, so the gap closes with its coverage row); a
                # critical gap still waits for its review (B4: the baseline never
                # clears it alone).
                existing.status = PENDING if existing.importance == "critical" else "answered"
                existing.knowledge_state = state
                existing.entity_ids = [uuid.UUID(i) for i in info["entity_ids"]]
            if existing is not None and existing.status == PENDING:
                coverage.append(
                    {
                        "category": cat.key,
                        "state": "partial",
                        "knowledge_state": existing.knowledge_state,
                        "reason": baseline_reason(cat.key, info["reason"]),
                        "entity_ids": info["entity_ids"],
                        "gap_id": str(existing.id),
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
            continue

        evidence_ids, conf = [], None
        found = sorted(sources.by_category.get(cat.key, []), key=lambda i: -i.confidence)
        if found:
            evidence_ids = [i.id for i in found[:MAX_EVIDENCE]]
            conf = ev.aggregate([i.confidence for i in found[:MAX_EVIDENCE]])
        brief_says = by_field.get(BRIEF_FIELDS.get(cat.key, ""), [])
        public = "hypothesis" if brief_says else "unknown"
        public_states[cat.key] = public
        # What the author reads: the brief, and what their sources seem to say.
        state = "ai_inference" if found else public
        # From the brief alone (everyone reads it), never from the author's sources: a
        # gap's importance must not tell others which categories those sources speak to.
        importance = cats.brief_importance(cat, brief.signals, bool(brief_says))
        reasons = {
            "unknown": cats.UNKNOWN_REASON,
            "hypothesis": cats.brief_reason([i["text"] for i in brief_says]),
            "ai_inference": f"{len(found)} pinned source item(s) seem to speak to it.",
        }
        reason = reasons[state]
        # The shared row holds public facts only (S6): what the author's sources say
        # (evidence, confidence, the inferred state) is kept in the gap's finding, so
        # its arrival moves no row anyone else reads.
        if existing is None:
            existing = KnowledgeGap(
                intake_id=intake.id,
                document_id=intake.document_id,
                category=cat.key,
                statement=cat.statement,
                rule_key=cat.key,
                impact=list(cat.impact),
                importance=importance,
                importance_basis="brief",
                evidence_ids=[],
                confidence=None,
                knowledge_state=public,
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
            # Public facts reach an open gap; its status stays, and so does an
            # importance a person set (or one from before the basis was recorded).
            stronger = _stronger(existing.knowledge_state, public)
            if stronger != existing.knowledge_state and existing.knowledge_state != "user_decision":
                existing.knowledge_state = stronger
            if existing.importance_basis == "brief" and existing.importance != importance:
                existing.importance = importance
        if existing.status in OPEN and found:
            private[cat.key] = (evidence_ids, conf)
        known = existing.knowledge_state
        if known == "ai_inference":
            # A row from before the shared row held public facts only.
            known = public
        kept = (previous.get("findings") or {}).get(str(existing.id)) or {}
        mine = known
        if (
            existing.status in OPEN
            and known != "user_decision"
            and (found or kept.get("state") or existing.knowledge_state == "ai_inference")
        ):
            mine = _stronger(known, "ai_inference")
        coverage.append(
            {
                "category": cat.key,
                **_row(existing, mine, reason),
                "entity_ids": [str(i) for i in existing.entity_ids],
                "gap_id": None,
            }
        )
        # The same row as the brief and the baseline alone give it (S6): what anyone
        # but the author reads, word for word what a plain intake would show.
        shown = _row(existing, known, reasons[public])
        if shown != {k: coverage[-1][k] for k in shown}:
            public_coverage[cat.key] = shown
    await db.flush()
    for row in coverage:
        if row["gap_id"] is None:
            gap = rules_gap(gaps, row["category"])
            row["gap_id"] = str(gap.id) if gap else None

    reg, stale_ids = register_findings(
        intake, gaps, sources, {i.id for i in items}, public_states, private
    )

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

    analysis = {
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
        "public_coverage": public_coverage,
        "relevant_item_ids": [str(i.id) for i in hits],
    }
    # What this analysis read, kept with what earlier ones read (S6): withheld from the
    # author's runs while any finding is below "shared in full".
    ev.note_reads(intake, analysis, [i.id for i in hits])
    intake.analysis = analysis
    await ev.record_reads(db, intake)
    await sync_questions(db, intake, gaps)
    refresh_status(intake, gaps, ("draft", "analyzing", "awaiting_answers", "ready"))
    await db.flush()


def _record_importance_basis(intake: ProductIntake, gaps: list[KnowledgeGap]) -> None:
    """A rule-made row from before its importance basis was recorded takes the
    importance everyone reads (S6) and its basis, so it never needs reading from the
    brief again (``/v1/gaps?importance=`` reads such rows one by one)."""
    reg = sharing.registry(intake)
    for gap in gaps:
        if not sharing.rule_made(gap) or gap.importance_basis is not None:
            continue
        entry = reg.get(str(gap.id)) or {}
        gap.importance = sharing.public_importance(gap, reg, entry)
        gap.importance_basis = "person" if entry.get("public_importance") else "brief"


def refresh_status(
    intake: ProductIntake,
    gaps: list[KnowledgeGap],
    among: tuple[str, ...] = ("analyzing", "awaiting_answers", "ready"),
) -> None:
    """``awaiting_answers`` while a gap everyone may see is open, else ``ready`` (S6:
    a gap hidden from others never keeps the intake waiting in their eyes, nor writes
    to the intake row; the author's view adds their own, :func:`status_for`)."""
    if intake.status not in among:
        return
    reg = sharing.registry(intake)
    shown = any(
        sharing.gap_changes(g, reg, sharing.EVERYONE) is not None for g in gaps if g.status in OPEN
    )
    intake.status = "awaiting_answers" if shown else "ready"


async def status_for(db: AsyncSession, intake: ProductIntake, v: sharing.Viewer) -> str:
    """The intake's status as ``v`` reads it: the author also waits on their own
    hidden gaps (``ready`` with an open gap: only a hidden one can be open)."""
    if v.is_author and intake.status == "ready":
        waiting = await db.scalar(
            select(func.count())
            .select_from(KnowledgeGap)
            .where(KnowledgeGap.intake_id == intake.id, KnowledgeGap.status.in_(OPEN))
        )
        if waiting:
            return "awaiting_answers"
    return intake.status


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
    private: dict[str, tuple[list[uuid.UUID], float | None]] | None = None,
) -> tuple[dict[str, dict[str, Any]], dict[uuid.UUID, str]]:
    """Register what the author's sources say as findings (S6), keeping every level the
    author set. Conflicts and stale items no longer found are dropped; model-written
    items and gaps stay (the job registered them; one it never registered becomes a
    private model finding). A rule-made gap's finding holds what the author's sources
    add to it (``private``: this analysis's evidence and confidence for each open gap,
    added to what earlier ones kept) and the knowledge state it has without them
    (``public_states``). Returns the registry and the stale items' finding ids."""
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
        known = old.get(str(gap.id)) or {}
        # Evidence on the row from the author's pinned items: a row from before the row
        # held public facts only.
        legacy = [str(e) for e in gap.evidence_ids if e in pinned_ids]
        found, conf = (private or {}).get(gap.category, ([], None))
        if not sharing.rule_made(gap):
            found, conf = [], None
        evidence = list(dict.fromkeys([*known.get("evidence_ids", []), *map(str, found)]))
        cited = list(dict.fromkeys([*known.get("source_item_ids", []), *legacy, *evidence]))
        if not cited:
            continue
        added = len(evidence) > len(known.get("evidence_ids", []))
        reg[str(gap.id)] = known
        sharing.register(
            reg, str(gap.id), kind="gap", origin="rules", category=gap.category,
            source_item_ids=cited, gap_id=gap.id,
            public_state=(public_states or {}).get(gap.category, "unknown"),
            summary=f"Oracle found evidence about {sharing.category_label(gap.category)} in "
            "the author's sources.",
            private={
                "evidence_ids": evidence or None,
                "confidence": conf if added and conf is not None else known.get("confidence"),
                "state": "ai_inference" if evidence else None,
            },
        )  # fmt: skip
    return reg, stale_ids


def question_prompt(gap: KnowledgeGap) -> str:
    return sharing.question_prompt(gap)


def priorities(intake: ProductIntake, gaps: list[KnowledgeGap]) -> dict[uuid.UUID, int]:
    """Each gap's question priority, from what everyone may see (S6).

    A gap's evidence, confidence and inferred state from the author's private sources
    (nor any importance they once gave it) do not move it: the gaps everyone sees are
    ranked as everyone sees them (10, 20, ...). A gap hidden from everyone else sits
    between them (an odd priority, seen by its author only), where its own facts rank
    it. The reads show anyone but the author these priorities, whatever is stored."""
    reg = sharing.registry(intake)
    public: dict[uuid.UUID, tuple] = {}
    for gap in gaps:
        changes = sharing.gap_changes(gap, reg, sharing.EVERYONE)
        if changes is None:
            continue
        state = changes.get("knowledge_state", gap.knowledge_state)
        conf = changes["confidence"] if "confidence" in changes else gap.confidence
        score = cats.rank_score(
            changes.get("importance", gap.importance),
            list(gap.impact),
            state,
            float(conf) if conf is not None else None,
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
    reg = sharing.registry(intake)
    for gap in ranked(gaps):
        mine = by_gap.get(gap.id, [])
        live = [q for q in mine if q.status != "withdrawn"]
        if gap.status not in OPEN:
            for q in live:
                if q.status == "draft":
                    q.status = "withdrawn"
            continue
        cat = cats.BY_KEY[gap.category]
        # Stored from what everyone may see (S6); a gap hidden from them, from its own.
        shown = sharing.gap_view(gap, reg, sharing.EVERYONE) or gap
        rationale = cats.rank_reason(
            cat, shown.importance, list(shown.impact), shown.knowledge_state
        )
        drafts = [q for q in live if q.status == "draft"]
        for q in drafts:
            if q.priority != priority[gap.id]:
                q.priority = priority[gap.id]
            if q.rationale != rationale:
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
    ``skip``: gaps the asker may not see; their questions stay drafts.

    Sizes and numbers are counted in what everyone may see (S6): a batch holds ``size``
    questions everyone sees, and the author's hidden questions ranked among them ride
    along; hidden questions asked on their own join the latest batch instead of
    opening a new number. So no reader but the author learns from a short batch or a
    skipped number that a hidden question exists."""
    questions = await intake_questions(db, intake.id)
    by_id = {g.id: g for g in await intake_gaps(db, intake.id)}
    reg = sharing.registry(intake)

    def shown(q: StakeholderQuestion) -> bool:
        gap = by_id.get(q.gap_id) if q.gap_id else None
        return gap is None or sharing.gap_changes(gap, reg, sharing.EVERYONE) is not None

    waiting = [q for q in questions if q.status == "draft" and q.gap_id not in skip]
    public = [q for q in waiting if shown(q)]
    chosen = public[:size]
    if len(public) > size:
        # Hidden drafts ranked before the first public draft left for later.
        cut = waiting.index(public[size])
        riders = [q for q in waiting[:cut] if not shown(q)]
    else:
        riders = [q for q in waiting if not shown(q)][: max(0, size - len(chosen))]
    drafts = [q for q in waiting if q in chosen or q in riders]
    if not drafts:
        return []
    latest = max((q.batch or 0 for q in questions if shown(q)), default=0)
    number = latest + 1 if chosen else max(latest, 1)
    for q in drafts:
        q.status = "asked"
        q.batch = number
        q.asked_by = asked_by
        gap = by_id.get(q.gap_id) if q.gap_id else None
        if gap is not None and gap.status == "unknown":
            gap.status = "asked"
    await db.flush()
    return drafts
