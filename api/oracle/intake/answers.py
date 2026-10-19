"""The question and answer ledger, decisions on gaps, and what answers propose (§5 steps
6-8).

An answer is one of five paths: ``answer``, ``dont_know``, ``defer``, ``delegate`` (to
another person of the company) or ``research`` ("Research this"). Every path is kept in
the ledger and updates its gap. What an answer implies elsewhere is only ever
*proposed* (§5 step 7):

- the baseline: an entity proposal (outcome, constraint, risk or decision), decided by
  an approver on the baseline's proposals;
- module selection: a ``decision`` change event (``oracle.changes``) the modules lane
  listens to, and the intake's composition inputs;
- the linked PRD: a ``prd_patch`` proposal; accepting it opens a feedback item, so the
  text changes only through review and refinement, never over an approved section;
- research: a ``research_run`` proposal; accepting it creates a *draft* run only.

Unresolved critical gaps reach the review gate through ``oracle.intake.checks``; an
owner may accept the risk explicitly (``decide``). Nothing here commits.
"""

import re
import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, changes
from oracle.auth.deps import Principal
from oracle.authz import has_role
from oracle.baseline import service as baseline_service
from oracle.docs.models import Document, DocumentVersion
from oracle.intake import categories as cats
from oracle.intake import engine
from oracle.intake.models import IntakeProposal
from oracle.intake.schemas import AnswerIn, DecisionIn, IntakeRunIn, NextAction
from oracle.intake.service import (
    IntakeError,
    actor_user,
    create_run,
    get_intake,
    member,
)
from oracle.review.models import FeedbackItem
from oracle.review.service import locked_section_keys
from oracle.sources import items as source_items
from oracle.v2.models import (
    AssumptionDecision,
    KnowledgeGap,
    ProductIntake,
    StakeholderAnswer,
    StakeholderQuestion,
)

ANSWERABLE = frozenset({"draft", "asked", "delegated", "deferred", "researching"})
# Answer kind -> (question status, gap status or None to keep).
EFFECTS: dict[str, tuple[str, str | None]] = {
    "answer": ("answered", "answered"),
    "dont_know": ("answered", "unknown"),
    "defer": ("deferred", "deferred"),
    "delegate": ("delegated", None),
    "research": ("researching", "under_investigation"),
}
# What an answer proposes to the baseline, by category.
BASELINE_TYPES = {
    "success_metric": "outcome",
    "blockers": "constraint",
    "constraints": "constraint",
    "third_party_policy": "constraint",
    "security_privacy": "risk",
    "non_goals": "decision",
    "alternatives": "decision",
    "differentiation": "decision",
}


def _now() -> datetime:
    return datetime.now(UTC)


def _slug(text: str, limit: int = 48) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:limit].strip("-") or "item"


def needs_owner(gap: KnowledgeGap, decision: str) -> bool:
    """Proceeding without an answer on a critical gap is the owner's call."""
    return gap.importance == "critical" and decision in ("accept_risk", "accept_assumption")


def next_actions(gap: KnowledgeGap) -> list[NextAction]:
    """What can move an open gap: answer it, research it, ask someone else, or decide."""
    if gap.status not in engine.OPEN and gap.status != "deferred":
        return []
    label = cats.BY_KEY[gap.category].label.lower()
    owner = "owner" if gap.importance == "critical" else "approver"
    return [
        NextAction(gap_id=gap.id, kind="answer", label=f"Answer the {label} question",
                   role="commenter"),
        NextAction(gap_id=gap.id, kind="research",
                   label="Research this: propose a run that looks into it", role="commenter"),
        NextAction(gap_id=gap.id, kind="delegate", label="Ask someone who knows",
                   role="commenter"),
        NextAction(gap_id=gap.id, kind="accept_assumption",
                   label="Proceed on a stated assumption, with a review date", role=owner),
        NextAction(gap_id=gap.id, kind="accept_risk",
                   label="Accept the risk explicitly, with a reason", role=owner),
    ]  # fmt: skip


async def _check_evidence(
    db: AsyncSession, principal: Principal, ids: list[uuid.UUID]
) -> list[uuid.UUID]:
    me = actor_user(principal)
    for item_id in ids:
        if me is None or await source_items.owned_item(db, me, item_id) is None:
            raise IntakeError(422, f"Evidence {item_id} is not one of your source items")
    return list(dict.fromkeys(ids))


async def answer(
    db: AsyncSession, principal: Principal, question: StakeholderQuestion, body: AnswerIn
) -> dict[str, Any]:
    intake = await get_intake(db, question.intake_id) if question.intake_id else None
    gap = await db.get(KnowledgeGap, question.gap_id) if question.gap_id else None
    approver = has_role(principal.role, "approver")
    if question.status == "answered" and not (approver and body.kind == "answer"):
        raise IntakeError(409, "This question is answered; it is not asked again")
    if question.status not in ANSWERABLE and question.status != "answered":
        raise IntakeError(409, f"A {question.status} question cannot be answered")
    if question.asked_to is not None and question.asked_to != principal.id and not approver:
        raise IntakeError(403, "This question was asked of someone else")
    if body.kind == "answer" and not (body.body or "").strip():
        raise IntakeError(422, "An answer needs a body")
    if body.kind == "delegate":
        target = await member(db, body.delegated_to) if body.delegated_to else None
        if target is None or not has_role(target.role, "commenter"):  # type: ignore[arg-type]
            raise IntakeError(422, "Delegate to a person of this company who can answer")
    evidence = await _check_evidence(db, principal, body.evidence_ids)
    state = body.knowledge_state or ("unknown" if body.kind != "answer" else "user_decision")
    if state == "verified_fact" and not evidence:
        raise IntakeError(422, "A verified fact needs evidence")

    row = StakeholderAnswer(
        question_id=question.id,
        kind=body.kind,
        body=(body.body or "").strip() or None,
        answered_by=principal.id,
        delegated_to=body.delegated_to if body.kind == "delegate" else None,
        evidence_ids=evidence,
        knowledge_state=state,
    )
    db.add(row)
    question_status, gap_status = EFFECTS[body.kind]
    question.status = question_status
    if body.kind == "delegate":
        question.asked_to = body.delegated_to
    if gap is not None:
        if gap_status is not None:
            gap.status = gap_status
        if body.kind == "answer":
            gap.knowledge_state = state
            gap.evidence_ids = [
                *gap.evidence_ids,
                *[e for e in evidence if e not in gap.evidence_ids],
            ]
        elif body.kind == "dont_know":
            gap.knowledge_state = "unknown"
        if body.kind == "delegate":
            gap.owner_id = body.delegated_to
    await db.flush()

    proposals: list[IntakeProposal] = []
    baseline_ids: list[uuid.UUID] = []
    if gap is not None and intake is not None:
        if body.kind == "answer":
            proposal = await _propose_baseline(db, principal, intake, gap, question, row)
            if proposal is not None:
                baseline_ids.append(proposal)
            patch = await _propose_patch(db, principal, intake, gap, question, row)
            if patch is not None:
                proposals.append(patch)
        if body.kind == "research" or (body.kind == "dont_know" and gap.importance == "critical"):
            proposals.append(
                await propose_research(
                    db,
                    principal,
                    intake,
                    gap,
                    question,
                    row,
                    investigate=body.kind == "research",
                )  # fmt: skip
            )
    event = None
    if gap is not None:
        event = await changes.record_change(
            db,
            "decision",
            cause=f"intake_answer:{body.kind}",
            actor=principal,
            subject_id=gap.id,
            subject_ref=f"intake:{gap.intake_id}#gap:{gap.id}",
            document_id=gap.document_id,
            data={
                "intake_id": str(gap.intake_id) if gap.intake_id else None,
                "gap_id": str(gap.id),
                "question_id": str(question.id),
                "category": gap.category,
                "answer_kind": body.kind,
                "gap_status": gap.status,
                "impact": list(gap.impact),
                "related_modules": list(gap.related_modules),
                "signals": (intake.analysis or {}).get("signals", {}) if intake else {},
            },
        )
    await audit.record(
        db, principal, "intake.question_answered", "stakeholder_question", question.id,
        {"kind": body.kind, "answer_id": str(row.id),
         "gap_id": str(gap.id) if gap else None},
    )  # fmt: skip
    if intake is not None:
        await engine.sync_questions(db, intake)
        if intake.status in ("awaiting_answers", "ready"):
            gaps = await engine.intake_gaps(db, intake.id)
            intake.status = (
                "awaiting_answers" if any(g.status in engine.OPEN for g in gaps) else "ready"
            )
    await db.flush()
    return {
        "answer": row,
        "question": question,
        "gap": gap,
        "proposals": proposals,
        "baseline_proposal_ids": baseline_ids,
        "change_event_id": event.id if event else None,
        "next_actions": next_actions(gap) if gap is not None else [],
    }


async def _propose_baseline(
    db: AsyncSession,
    principal: Principal,
    intake: ProductIntake,
    gap: KnowledgeGap,
    question: StakeholderQuestion,
    row: StakeholderAnswer,
) -> uuid.UUID | None:
    type_ = BASELINE_TYPES.get(gap.category)
    if type_ is None or not row.body:
        return None
    label = cats.BY_KEY[gap.category].label
    title = row.body if len(row.body) <= 120 else row.body[:119].rstrip() + "…"
    if type_ == "decision" and gap.category == "non_goals":
        title = f"Non-goal: {title}"
    attrs: dict[str, Any] = {
        "intake_id": str(intake.id),
        "gap_id": str(gap.id),
        "answer_id": str(row.id),
    }
    if gap.category in ("blockers", "third_party_policy"):
        attrs["blocker"] = {
            "type": "unknown",
            "limit_kind": "policy" if gap.category == "third_party_policy" else "other",
            "severity": gap.importance,
            "status": "open",
        }
    writer = baseline_service.Writer(
        principal, "agent", reason=f"{label} answered in intake '{intake.title}'"
    )
    proposal = await baseline_service.propose(
        db,
        writer,
        op="create",
        kind="entity",
        fields={
            "type": type_,
            "key": f"{_slug(intake.title, 24)}-{gap.category.replace('_', '-')}-{str(row.id)[:6]}",
            "title": title,
            "body": f"{question.prompt}\n\n{row.body}",
            "attrs": attrs,
        },
    )
    return proposal.id


async def _propose_patch(
    db: AsyncSession,
    principal: Principal,
    intake: ProductIntake,
    gap: KnowledgeGap,
    question: StakeholderQuestion,
    row: StakeholderAnswer,
) -> IntakeProposal | None:
    if intake.document_id is None or not row.body:
        return None
    document = await db.get(Document, intake.document_id)
    latest = await db.scalar(
        select(DocumentVersion)
        .where(DocumentVersion.document_id == intake.document_id)
        .order_by(DocumentVersion.number.desc())
        .limit(1)
    )
    if document is None or latest is None:
        return None
    label = cats.BY_KEY[gap.category].label
    proposal = IntakeProposal(
        intake_id=intake.id,
        gap_id=gap.id,
        question_id=question.id,
        answer_id=row.id,
        kind="prd_patch",
        title=f"Add to the PRD: {label}",
        detail={
            "document_id": str(document.id),
            "document": document.slug,
            "base_version": latest.number,
            "section_key": (gap.section_keys or [None])[0] or question.section_key,
            "text": f"{question.prompt} {row.body}",
        },
        created_by=principal.id,
    )
    db.add(proposal)
    await db.flush()
    return proposal


async def propose_research(
    db: AsyncSession,
    principal: Principal,
    intake: ProductIntake,
    gap: KnowledgeGap,
    question: StakeholderQuestion | None = None,
    row: StakeholderAnswer | None = None,
    *,
    investigate: bool = True,
) -> IntakeProposal:
    """'Research this': a proposal to run research through the existing runs flow.

    ``investigate``: mark the gap under investigation (not for a "don't know", whose
    research is only offered)."""
    open_one = await db.scalar(
        select(IntakeProposal).where(
            IntakeProposal.gap_id == gap.id,
            IntakeProposal.kind == "research_run",
            IntakeProposal.status == "proposed",
        )
    )
    if open_one is not None:
        return open_one
    label = cats.BY_KEY[gap.category].label
    proposal = IntakeProposal(
        intake_id=intake.id,
        gap_id=gap.id,
        question_id=question.id if question else None,
        answer_id=row.id if row else None,
        kind="research_run",
        title=f"Research: {label}",
        detail={
            "gap_ids": [str(gap.id)],
            "flow": "baseline_to_prd",
            "depth": "quick",
            "question": question.prompt if question else gap.statement,
            "why": "Agents look into the pinned sources and propose what they find; an "
            "approver estimates and starts the run, and its results arrive as proposals.",
        },
        created_by=principal.id,
    )
    db.add(proposal)
    if investigate and gap.status in ("unknown", "asked"):
        gap.status = "under_investigation"
    await db.flush()
    await audit.record(
        db, principal, "intake.research_proposed", "intake_proposal", proposal.id,
        {"gap_id": str(gap.id), "intake_id": str(intake.id)},
    )  # fmt: skip
    return proposal


async def decide(
    db: AsyncSession, principal: Principal, gap: KnowledgeGap, body: DecisionIn
) -> AssumptionDecision:
    """An explicit, authorized decision on a gap (§5 step 8)."""
    if needs_owner(gap, body.decision) and not has_role(principal.role, "owner"):
        raise IntakeError(403, "Accepting a critical gap's risk or assumption needs an owner")
    if not body.rationale.strip():
        raise IntakeError(422, "A decision needs a rationale")
    decision = AssumptionDecision(
        gap_id=gap.id,
        document_id=gap.document_id,
        statement=gap.statement,
        decision=body.decision,
        rationale=body.rationale.strip(),
        decided_by=principal.id,
        review_at=body.review_at,
    )
    db.add(decision)
    before = gap.status
    if body.decision == "accept_risk":
        gap.status = "accepted_risk"
    elif body.decision == "accept_assumption":
        gap.status = "accepted_risk"
        gap.knowledge_state = "hypothesis"
    elif body.decision == "validate":
        gap.status = "validated"
        if gap.knowledge_state != "verified_fact":
            gap.knowledge_state = "user_decision"
    else:  # reject: the earlier answer or assumption does not hold; ask again, anew
        gap.status = "unknown"
        gap.knowledge_state = "unknown"
    await db.flush()
    if body.decision == "reject" and gap.intake_id is not None:
        cat = cats.BY_KEY[gap.category]
        db.add(
            StakeholderQuestion(
                gap_id=gap.id,
                intake_id=gap.intake_id,
                document_id=gap.document_id,
                category=gap.category,
                prompt=f"The earlier answer was rejected ({decision.rationale}). {cat.prompt}",
                rationale=cats.rank_reason(cat, gap.importance, list(gap.impact), "unknown"),
                priority=5,
                status="draft",
            )
        )
        # The earlier question stays answered in the ledger; the follow-up is new.
        for q in await engine.intake_questions(db, gap.intake_id):
            if q.gap_id == gap.id and q.status in ("asked", "delegated", "researching"):
                q.status = "withdrawn"
    await db.flush()
    await changes.record_change(
        db,
        "decision",
        cause=f"gap_{body.decision}",
        actor=principal,
        subject_id=gap.id,
        subject_ref=f"intake:{gap.intake_id}#gap:{gap.id}",
        document_id=gap.document_id,
        data={
            "intake_id": str(gap.intake_id) if gap.intake_id else None,
            "gap_id": str(gap.id),
            "category": gap.category,
            "decision": body.decision,
            "from": before,
            "to": gap.status,
            "related_modules": list(gap.related_modules),
        },
    )
    await audit.record(
        db, principal, "intake.gap_decided", "knowledge_gap", gap.id,
        {"decision": body.decision, "from": before, "to": gap.status,
         "assumption_decision_id": str(decision.id)},
    )  # fmt: skip
    if gap.intake_id is not None:
        intake = await get_intake(db, gap.intake_id)
        await engine.sync_questions(db, intake)
    return decision


async def accept(
    db: AsyncSession, principal: Principal, proposal: IntakeProposal
) -> IntakeProposal:
    if proposal.status != "proposed":
        raise IntakeError(409, f"This proposal is already {proposal.status}")
    intake = await get_intake(db, proposal.intake_id)
    if proposal.kind == "research_run":
        gap_ids = [uuid.UUID(g) for g in proposal.detail.get("gap_ids") or []]
        run_id = await create_run(
            db, principal, intake, IntakeRunIn(), gap_ids=gap_ids,
            depth=proposal.detail.get("depth"),
        )  # fmt: skip
        proposal.result = {"run_id": str(run_id)}
    else:
        proposal.result = {"feedback_item_id": str(await _open_feedback(db, intake, proposal))}
    proposal.status = "accepted"
    proposal.decided_by = principal.id
    proposal.decided_at = _now()
    await db.flush()
    await audit.record(
        db, principal, "intake.proposal_accepted", "intake_proposal", proposal.id,
        {"kind": proposal.kind, **proposal.result},
    )  # fmt: skip
    return proposal


async def _open_feedback(
    db: AsyncSession, intake: ProductIntake, proposal: IntakeProposal
) -> uuid.UUID:
    """A PRD patch reaches the document as feedback on its latest version."""
    from oracle.jobs import service as jobs_service

    document_id = uuid.UUID(proposal.detail["document_id"])
    latest = await db.scalar(
        select(DocumentVersion)
        .where(DocumentVersion.document_id == document_id)
        .order_by(DocumentVersion.number.desc())
        .limit(1)
    )
    if latest is None:
        raise IntakeError(409, "The PRD has no version to raise this on")
    section = proposal.detail.get("section_key")
    if section and section in await locked_section_keys(db, latest.id):
        raise IntakeError(
            409, f"Section '{section}' is approved and locked; its text is kept as approved"
        )
    item = FeedbackItem(
        document_id=document_id,
        raised_on_version=latest.number,
        kind="general",
        section_key=section,
        summary=f"From intake '{intake.title}': {proposal.detail.get('text', '')}"[:4000],
        status="open",
    )
    db.add(item)
    await db.flush()
    await jobs_service.on_feedback(db, document_id, latest.number)
    return item.id


async def dismiss(
    db: AsyncSession, principal: Principal, proposal: IntakeProposal, reason: str | None
) -> IntakeProposal:
    if proposal.status != "proposed":
        raise IntakeError(409, f"This proposal is already {proposal.status}")
    proposal.status = "dismissed"
    proposal.decided_by = principal.id
    proposal.decided_at = _now()
    proposal.decision_note = reason
    if proposal.kind == "research_run" and proposal.gap_id is not None:
        gap = await db.get(KnowledgeGap, proposal.gap_id)
        if gap is not None and gap.status == "under_investigation":
            gap.status = "unknown"
    await db.flush()
    await audit.record(
        db, principal, "intake.proposal_dismissed", "intake_proposal", proposal.id,
        {"kind": proposal.kind, "reason": reason},
    )  # fmt: skip
    if proposal.gap_id is not None:
        await engine.sync_questions(db, await get_intake(db, proposal.intake_id))
    return proposal
