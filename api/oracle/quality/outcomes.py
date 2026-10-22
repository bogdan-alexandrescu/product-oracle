"""Post-publish outcome tracking and learnings (§10, last paragraph).

An outcome record links what launched (an approved PRD version, a roadmap item, a
validation experiment) to the goal it serves, with the PRD's prediction. An assessment
records whether the prediction held and drafts learnings; a person keeps the ones that
matter. Active learnings add up to a signal per module, question category or criterion,
which future module and question recommendations can read (``GET /v1/learnings/signals``).

Nothing here writes to a document, a version, a section or a composition: published
documents stay exactly as they were approved.

Service functions flush but never commit; the router commits.
"""

import uuid
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.baseline.models import Entity
from oracle.docs.models import Document, DocumentVersion, Section
from oracle.quality import criteria
from oracle.quality.models import ASSESSED, OutcomeRecord, QualityLearning
from oracle.quality.schemas import (
    Assessment,
    AssessmentIn,
    AssessmentResult,
    InboxOutcome,
    LearningCreate,
    LearningDraft,
    LearningOut,
    LearningSignal,
    OutcomeCreate,
    OutcomeOut,
    OutcomeUpdate,
    ShippedIn,
)
from oracle.v2 import models as m
from oracle.v2.models import GAP_CATEGORIES

if TYPE_CHECKING:
    from oracle.auth.deps import Principal


class OutcomeError(Exception):
    def __init__(self, status: int, message: str):
        self.status = status
        super().__init__(message)


def _now() -> datetime:
    return datetime.now(UTC)


async def _entity(db: AsyncSession, entity_id: uuid.UUID, type_: str, label: str) -> Entity:
    entity = await db.get(Entity, entity_id)
    if entity is None or entity.type != type_:
        raise OutcomeError(422, f"{label} {entity_id} is not a {type_.replace('_', ' ')}")
    return entity


async def create_outcome(
    db: AsyncSession, principal: "Principal", data: OutcomeCreate
) -> OutcomeOut:
    await _entity(db, data.goal_id, "goal", "goal_id")
    if data.outcome_entity_id:
        await _entity(db, data.outcome_entity_id, "outcome", "outcome_entity_id")
    document_id = None
    if data.prd_version_id:
        version = await db.get(DocumentVersion, data.prd_version_id)
        document = await db.get(Document, version.document_id) if version else None
        if version is None or document is None or document.kind != "prd":
            raise OutcomeError(422, f"prd_version_id {data.prd_version_id} is not a PRD version")
        if version.approved_at is None:
            raise OutcomeError(
                422, "only an approved (published) PRD version is tracked; approve it first"
            )
        document_id = document.id
    if data.roadmap_version_id:
        version = await db.get(DocumentVersion, data.roadmap_version_id)
        document = await db.get(Document, version.document_id) if version else None
        if version is None or document is None or document.kind != "roadmap":
            raise OutcomeError(
                422, f"roadmap_version_id {data.roadmap_version_id} is not a roadmap version"
            )
        item = await db.scalar(
            select(Section.id).where(
                Section.version_id == version.id, Section.section_key == data.roadmap_item_key
            )
        )
        if item is None:
            raise OutcomeError(
                422, f"roadmap item {data.roadmap_item_key!r} is not in that roadmap version"
            )
    if data.experiment_id and await db.get(m.FeasibilityExperiment, data.experiment_id) is None:
        raise OutcomeError(422, f"experiment_id {data.experiment_id} is not an experiment")
    item = None
    if data.roadmap_item_id:
        from oracle.roadmap.models import RoadmapItem

        item = await db.get(RoadmapItem, data.roadmap_item_id)
        if item is None:
            raise OutcomeError(422, f"roadmap_item_id {data.roadmap_item_id} is not a roadmap item")
        if await db.scalar(
            select(OutcomeRecord.id).where(OutcomeRecord.roadmap_item_id == item.id)
        ):
            raise OutcomeError(409, "That roadmap item already has an outcome record")
    row = OutcomeRecord(
        title=data.title,
        goal_id=data.goal_id,
        outcome_entity_id=data.outcome_entity_id,
        document_id=document_id,
        prd_version_id=data.prd_version_id,
        roadmap_version_id=data.roadmap_version_id or (item.roadmap_version_id if item else None),
        roadmap_item_key=data.roadmap_item_key or (item.item_key if item else None),
        roadmap_item_id=item.id if item else None,
        track_id=item.track_id if item else None,
        experiment_id=data.experiment_id,
        prediction=data.prediction.model_dump(mode="json"),
        needs_prediction=data.prediction.predicted_value is None and item is not None,
        module_keys=list(dict.fromkeys(data.module_keys)),
        gap_categories=list(dict.fromkeys(data.gap_categories)),
        status="tracking",
        assessments=[],
        owner_id=data.owner_id or principal.id,
        created_by=principal.id,
    )
    db.add(row)
    await db.flush()
    await audit.record(
        db,
        principal,
        "outcome.created",
        "outcome_record",
        row.id,
        {"goal_id": str(data.goal_id), "document_id": str(document_id) if document_id else None},
    )
    await db.refresh(row)
    return OutcomeOut.model_validate(row)


async def list_outcomes(
    db: AsyncSession,
    *,
    goal_id: uuid.UUID | None = None,
    document_id: uuid.UUID | None = None,
    status: str | None = None,
    state: str | None = None,
    needs_prediction: bool | None = None,
    track_id: uuid.UUID | None = None,
    roadmap_item_id: uuid.UUID | None = None,
    limit: int = 100,
    offset: int = 0,
) -> list[OutcomeOut]:
    stmt = select(OutcomeRecord)
    if state == "predicted":
        stmt = stmt.where(OutcomeRecord.status == "predicted")
    elif state == "tracking":
        stmt = stmt.where(
            OutcomeRecord.status == "tracking", OutcomeRecord.proposed_assessment.is_(None)
        )
    elif state == "due":
        stmt = stmt.where(
            OutcomeRecord.status == "tracking", OutcomeRecord.proposed_assessment.is_not(None)
        )
    elif state == "assessed":
        stmt = stmt.where(OutcomeRecord.status.in_(ASSESSED))
    if needs_prediction is not None:
        stmt = stmt.where(OutcomeRecord.needs_prediction.is_(needs_prediction))
    if track_id:
        stmt = stmt.where(OutcomeRecord.track_id == track_id)
    if roadmap_item_id:
        stmt = stmt.where(OutcomeRecord.roadmap_item_id == roadmap_item_id)
    if goal_id:
        stmt = stmt.where(OutcomeRecord.goal_id == goal_id)
    if document_id:
        stmt = stmt.where(OutcomeRecord.document_id == document_id)
    if status:
        stmt = stmt.where(OutcomeRecord.status == status)
    rows = await db.scalars(
        stmt.order_by(OutcomeRecord.created_at.desc(), OutcomeRecord.id).limit(limit).offset(offset)
    )
    return [OutcomeOut.model_validate(r) for r in rows]


async def get_outcome(db: AsyncSession, outcome_id: uuid.UUID) -> OutcomeRecord:
    row = await db.get(OutcomeRecord, outcome_id)
    if row is None:
        raise OutcomeError(404, "Outcome not found")
    return row


def draft_learnings(row: OutcomeRecord, verdict: str) -> list[LearningDraft]:
    """What an assessment suggests the company learn; a person decides to keep it."""
    if verdict == "inconclusive":
        return [
            LearningDraft(
                outcome_id=row.id,
                statement=(
                    f"'{row.title}' could not be assessed: ask for a measurable metric and a "
                    "decision threshold earlier"
                ),
                applies_to="question_category",
                target="success_metric",
                direction="recommend_more",
            )
        ]
    held = verdict == "held"
    direction = "note" if held else "recommend_more"
    how = "held" if held else ("partly held" if verdict == "partially_held" else "did not hold")
    out = [
        LearningDraft(
            outcome_id=row.id,
            statement=(
                f"The prediction for '{row.title}' {how}"
                + ("" if held else f": ask about {category.replace('_', ' ')} earlier")
            ),
            applies_to="question_category",
            target=category,
            direction=direction,
        )
        for category in row.gap_categories
    ]
    out += [
        LearningDraft(
            outcome_id=row.id,
            statement=(
                f"Module {key} backed a prediction that {how}"
                + ("" if held else "; recommend it with its validation fields filled")
            ),
            applies_to="module",
            target=key,
            direction=direction,
        )
        for key in row.module_keys
    ]
    return out


async def assess(
    db: AsyncSession, principal: "Principal", outcome_id: uuid.UUID, data: AssessmentIn
) -> AssessmentResult:
    row = await get_outcome(db, outcome_id)
    if row.status == "predicted":
        raise OutcomeError(409, "Not shipped yet: mark it shipped before assessing it")
    entry = Assessment(
        verdict=data.verdict,
        observed=data.observed,
        note=data.note,
        evidence_ids=data.evidence_ids,
        assessed_by=principal.id,
        assessed_at=_now(),
        actual_value=data.actual_value,
        measured_at=data.measured_at,
    )
    before = row.status
    row.assessments = [*(row.assessments or []), entry.model_dump(mode="json")]
    row.status = data.verdict
    row.observed = data.observed
    row.evidence_ids = list(dict.fromkeys([*(row.evidence_ids or []), *data.evidence_ids]))
    row.assessed_by = principal.id
    row.assessed_at = entry.assessed_at
    await db.flush()
    await audit.record(
        db,
        principal,
        "outcome.assessed",
        "outcome_record",
        row.id,
        {"from": before, "to": data.verdict, "observed": data.observed},
    )
    await db.refresh(row)
    return AssessmentResult(
        outcome=OutcomeOut.model_validate(row),
        suggested_learnings=draft_learnings(row, data.verdict),
    )


async def update_outcome(
    db: AsyncSession, principal: "Principal", outcome_id: uuid.UUID, data: OutcomeUpdate
) -> OutcomeOut:
    """Edit the prediction (only while predicted: shipped, it is frozen) or the owner."""
    row = await get_outcome(db, outcome_id)
    if data.lock_version != row.lock_version:
        raise OutcomeError(409, "This outcome changed since you opened it; reload it")
    if data.prediction is not None:
        if row.status != "predicted":
            raise OutcomeError(409, "Shipped: the prediction is frozen")
        before = row.prediction
        row.prediction = data.prediction.model_dump(mode="json")
        row.needs_prediction = data.prediction.predicted_value is None
        await audit.record(
            db, principal, "outcome.prediction_edited", "outcome_record", row.id,
            {"before": before, "after": row.prediction},
        )  # fmt: skip
    if "owner_id" in data.model_fields_set and data.owner_id is not None:
        row.owner_id = data.owner_id
    await db.flush()
    await db.refresh(row)
    return OutcomeOut.model_validate(row)


async def mark_shipped(
    db: AsyncSession, principal: "Principal", outcome_id: uuid.UUID, data: ShippedIn
) -> OutcomeOut:
    """A person says it shipped (signal ``manual``)."""
    from oracle.quality import shipping

    row = await get_outcome(db, outcome_id)
    if row.status != "predicted":
        raise OutcomeError(409, "Already shipped")
    at = data.at or _now()
    await shipping.ship(db, row, "manual", at, note=data.note, actor=principal)
    await db.refresh(row)
    return OutcomeOut.model_validate(row)


VERDICT_WORDS = {
    "held": "held",
    "partially_held": "partly held",
    "not_held": "not held",
    "inconclusive": "inconclusive",
}


async def inbox_rows(db: AsyncSession, principal: "Principal") -> list[InboxOutcome]:
    """The caller's outcome rows: Add predictions (per roadmap, counted), Outcome check
    due (per record, counted) and Oracle recorded (shown, for 14 days)."""
    from datetime import timedelta

    from oracle.quality.capture import figure_text

    me = principal.user_id or principal.id
    rows: list[InboxOutcome] = []
    mine = list(
        await db.scalars(
            select(OutcomeRecord)
            .where(OutcomeRecord.owner_id == me)
            .order_by(OutcomeRecord.created_at, OutcomeRecord.id)
        )
    )
    waiting: dict[uuid.UUID | None, list[OutcomeRecord]] = {}
    for r in mine:
        if r.status == "predicted" and r.needs_prediction:
            waiting.setdefault(r.roadmap_version_id, []).append(r)
    for version_id, records in waiting.items():
        title = "a roadmap"
        if version_id is not None:
            version = await db.get(DocumentVersion, version_id)
            document = await db.get(Document, version.document_id) if version else None
            title = document.title if document else title
        n = len(records)
        rows.append(
            InboxOutcome(
                id=records[0].id, title=f"Add predictions · {title} · {n} item{'s' * (n != 1)}",
                reason="needs_prediction", state="predicted", counts=True, count=n,
                roadmap_version_id=version_id,
            )
        )  # fmt: skip
    recent = _now() - timedelta(days=14)
    for r in mine:
        p = r.prediction or {}
        if r.status == "tracking" and r.proposed_assessment:
            prop = r.proposed_assessment
            now = figure_text(prop.get("actual_value"), p.get("unit")) or "no value"
            rows.append(
                InboxOutcome(
                    id=r.id,
                    title=(
                        f"Outcome check due · {r.title} · predicted {p.get('baseline') or '?'}"
                        f" → {p.get('predicted')}, now {now}"
                    ),
                    reason="check_due", state="due", counts=True, due_on=r.assess_due_on,
                )
            )  # fmt: skip
        last = (r.assessments or [])[-1:] or [{}]
        if (
            r.status in ASSESSED
            and last[0].get("actor") == "oracle"
            and r.assessed_at is not None
            and r.assessed_at >= recent
        ):
            rows.append(
                InboxOutcome(
                    id=r.id,
                    title=f"Oracle recorded: {VERDICT_WORDS[r.status]} · {r.title}",
                    reason="oracle_recorded", state="assessed", counts=False,
                    due_on=r.assess_due_on,
                )
            )  # fmt: skip
    return rows


def _check_target(applies_to: str, target: str) -> None:
    if applies_to == "question_category" and target not in GAP_CATEGORIES:
        raise OutcomeError(422, f"{target!r} is not a question category")
    if applies_to == "criterion" and target not in criteria.KEYS:
        raise OutcomeError(422, f"{target!r} is not a quality criterion")


async def create_learning(
    db: AsyncSession, principal: "Principal", data: LearningCreate
) -> LearningOut:
    _check_target(data.applies_to, data.target)
    if data.outcome_id:
        await get_outcome(db, data.outcome_id)
    row = QualityLearning(
        outcome_id=data.outcome_id,
        statement=data.statement,
        applies_to=data.applies_to,
        target=data.target,
        direction=data.direction,
        weight=data.weight,
        status="active",
        created_by=principal.id,
    )
    db.add(row)
    await db.flush()
    await audit.record(
        db,
        principal,
        "learning.created",
        "quality_learning",
        row.id,
        {"applies_to": data.applies_to, "target": data.target, "direction": data.direction},
    )
    await db.refresh(row)
    return LearningOut.model_validate(row)


async def list_learnings(
    db: AsyncSession,
    *,
    applies_to: str | None = None,
    target: str | None = None,
    status: str | None = None,
    limit: int = 100,
    offset: int = 0,
) -> list[LearningOut]:
    stmt = select(QualityLearning)
    if applies_to:
        stmt = stmt.where(QualityLearning.applies_to == applies_to)
    if target:
        stmt = stmt.where(QualityLearning.target == target)
    if status:
        stmt = stmt.where(QualityLearning.status == status)
    rows = await db.scalars(
        stmt.order_by(QualityLearning.created_at.desc(), QualityLearning.id)
        .limit(limit)
        .offset(offset)
    )
    return [LearningOut.model_validate(r) for r in rows]


async def retire_learning(
    db: AsyncSession, principal: "Principal", learning_id: uuid.UUID, reason: str | None
) -> LearningOut:
    row = await db.get(QualityLearning, learning_id)
    if row is None:
        raise OutcomeError(404, "Learning not found")
    if row.status != "retired":
        row.status = "retired"
        row.retired_reason = reason
        row.retired_by = principal.id
        row.retired_at = _now()
        await db.flush()
        await audit.record(
            db, principal, "learning.retired", "quality_learning", row.id, {"reason": reason}
        )
    await db.refresh(row)
    return LearningOut.model_validate(row)


SIGN = {"recommend_more": 1, "recommend_less": -1, "note": 0}


async def signals(db: AsyncSession, applies_to: str | None = None) -> list[LearningSignal]:
    """The net signal of active learnings per target, strongest first."""
    stmt = select(QualityLearning).where(QualityLearning.status == "active")
    if applies_to:
        stmt = stmt.where(QualityLearning.applies_to == applies_to)
    groups: dict[tuple[str, str], list[QualityLearning]] = {}
    for row in await db.scalars(stmt.order_by(QualityLearning.created_at.desc())):
        groups.setdefault((row.applies_to, row.target), []).append(row)
    out = [
        LearningSignal(
            applies_to=kind,
            target=target,
            score=sum(SIGN[r.direction] * r.weight for r in rows),
            learning_ids=[r.id for r in rows],
            statements=[r.statement for r in rows[:3]],
        )
        for (kind, target), rows in groups.items()
    ]
    return sorted(out, key=lambda s: (-abs(s.score), s.applies_to, s.target))
