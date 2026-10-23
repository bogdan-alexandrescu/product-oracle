"""The decision log: propose, edit, decide, reassign, withdraw and review decisions, list
them, the Inbox rows they raise, and the baseline ``decision`` entity a decided judgement
call keeps in step.

A decision has one approver, and only that person decides it: Oracle never decides on
its own (H11 Autonomy is not built). A hard-to-reverse decision also needs its approver
to hold the company setting ``decision_irreversible_role`` (default ``owner``). Checkpoint
records (:mod:`oracle.decisions.capture`) record a run's decision and are never edited.

The caller commits.
"""

import uuid
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import Text, and_, any_, cast, func, inspect, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.auth.deps import Principal
from oracle.auth.models import User
from oracle.authz import has_role
from oracle.baseline import service as baseline
from oracle.baseline.models import Entity, Evidence
from oracle.decisions.models import CAPTURED_ORIGINS, Decision, DecisionReview
from oracle.decisions.schemas import (
    DecideIn,
    DecisionCreate,
    DecisionOut,
    DecisionPatch,
    DecisionReviewOut,
    DecisionSource,
    DecisionSummary,
    PredictionIn,
    ReassignIn,
    ReviewIn,
)
from oracle.jobs.models import LlmJob
from oracle.quality.models import OutcomeRecord
from oracle.runs.schemas import InboxDecision
from oracle.tenancy import current_tenant
from oracle.tenant_settings_api import get_setting
from oracle.v2.concurrency import expect_version, flush_or_conflict

REVIEW_DAYS = 90
MAX_REVIEW_DAYS = 365
# Inbox rows shown, not counted: decided for those informed, and what I just handled.
SHOWN_DAYS = 7
CHECKPOINT_LOCKED = "A checkpoint record is not edited; it records the run's decision"
DECIDED_LOCKED = "Decided decisions are not edited. Revisit it instead."
# A captured judgement call's approver may still set these on the decided record.
CAPTURED_FIELDS = ("review_at", "expected_outcome", "prediction")
ENTITY_REASON = "Synced from the decision log"


class DecisionError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


def ref(number: int) -> str:
    return f"D-{number}"


def _now() -> datetime:
    return datetime.now(UTC)


def today(zone: str = "UTC") -> date:
    """The date now in ``zone``. Read the company's day through :func:`company_today`."""
    return _now().astimezone(ZoneInfo(zone)).date()


async def company_zone(db: AsyncSession) -> str:
    return await get_setting(db, "company_timezone")


async def company_today(db: AsyncSession) -> date:
    """Today in the company time zone (#336): review dates are the company's days."""
    return today(await company_zone(db))


def class_of(d: Decision) -> str:
    """The generated column, also before the row is read back."""
    return "checkpoint" if d.origin == "checkpoint" else "judgement"


def state_of(d: Decision, on: date) -> str:
    """``on``: the company's today."""
    if (
        d.status == "decided"
        and class_of(d) == "judgement"
        and d.review_at is not None
        and d.review_at <= on
    ):
        return "review_due"
    return d.status


def _who(principal: Principal) -> uuid.UUID:
    """The person behind the call: an API token acting for a user is that user."""
    return principal.user_id or principal.id


# --- reads ---------------------------------------------------------------------------------


async def resolve(db: AsyncSession, key: str, *, lock: bool = False) -> Decision:
    """A decision of this company by id, number or D-number; 404 otherwise."""
    raw = key.strip()
    query = select(Decision)
    try:
        query = query.where(Decision.id == uuid.UUID(raw))
    except ValueError:
        digits = raw[2:] if raw[:2].upper() == "D-" else raw
        if not digits.isdigit() or len(digits) > 9:
            raise DecisionError(404, f"decision {key} not found") from None
        query = query.where(Decision.number == int(digits))
    if lock:
        query = query.with_for_update()
    d = await db.scalar(query)
    if d is None:
        raise DecisionError(404, f"decision {key} not found")
    return d


async def _emails(db: AsyncSession, ids: set[uuid.UUID]) -> dict[uuid.UUID, str]:
    ids = {i for i in ids if i is not None}
    if not ids:
        return {}
    return dict((await db.execute(select(User.id, User.email).where(User.id.in_(ids)))).all())


def source_of(d: Decision) -> DecisionSource | None:
    if d.source_kind is None or d.source_id is None:
        return None
    extra: dict[str, Any] = {}
    if d.source_kind == "checkpoint":
        # A checkpoint record keeps its stop on its run subject (capture.checkpoint).
        stop = next((s for s in d.subjects or [] if s.get("kind") == "run"), {})
        extra = {"checkpoint_kind": stop.get("checkpoint_kind"), "segment": stop.get("segment")}
    return DecisionSource(kind=d.source_kind, id=d.source_id, **extra)


def summary(d: Decision, emails: dict[uuid.UUID, str], day: date) -> DecisionSummary:
    return DecisionSummary(
        id=d.id,
        number=d.number,
        ref=ref(d.number),
        title=d.title,
        status=d.status,  # type: ignore[arg-type]
        state=state_of(d, day),  # type: ignore[arg-type]
        class_=class_of(d),  # type: ignore[arg-type]
        origin=d.origin,  # type: ignore[arg-type]
        reversibility=d.reversibility,  # type: ignore[arg-type]
        approver_id=d.approver_id,
        approver_email=emails.get(d.approver_id),
        chosen_option=d.chosen_option,
        decided_at=d.decided_at,
        review_at=d.review_at,
        run_id=d.run_id,
        created_at=d.created_at,
        source=source_of(d),
    )


async def _revisit_of(db: AsyncSession, d: Decision) -> Decision | None:
    """The newest decision that supersedes ``d`` (a revisit), proposed or decided."""
    return await db.scalar(
        select(Decision)
        .where(Decision.supersedes_id == d.id, Decision.status.in_(("proposed", "decided")))
        .order_by(Decision.created_at.desc())
        .limit(1)
    )


async def out(db: AsyncSession, principal: Principal | None, d: Decision) -> DecisionOut:
    # updated_at, lock_version and class are server-side: read back after a write.
    if inspect(d).expired_attributes:
        await db.refresh(d)
    reviews = list(
        await db.scalars(
            select(DecisionReview)
            .where(DecisionReview.decision_id == d.id)
            .order_by(DecisionReview.created_at, DecisionReview.id)
        )
    )
    emails = await _emails(
        db,
        {d.approver_id, d.decided_by, *(r.reviewed_by for r in reviews)},  # type: ignore[arg-type]
    )
    revisit = await _revisit_of(db, d)
    base = summary(d, emails, await company_today(db)).model_dump(by_alias=False)
    can = _abilities(principal, d)
    return DecisionOut(
        **base,
        question=d.question,
        context=d.context,
        options=list(d.options or []),  # type: ignore[arg-type]
        rationale=d.rationale,
        driver=d.driver,
        contributor_ids=list(d.contributor_ids or []),
        informed_ids=list(d.informed_ids or []),
        evidence_ids=list(d.evidence_ids or []),
        entity_ids=list(d.entity_ids or []),
        subjects=list(d.subjects or []),
        expected_outcome=d.expected_outcome,
        prediction=d.prediction,
        outcome_id=d.outcome_id,
        supersedes_id=d.supersedes_id,
        revisit_id=revisit.id if revisit and d.status == "decided" else None,
        superseded_by_id=revisit.id if revisit and d.status == "superseded" else None,
        entity_id=d.entity_id,
        decided_via=d.decided_via,
        decided_by=d.decided_by,
        decided_by_email=emails.get(d.decided_by) if d.decided_by else None,
        decided_actor=d.decided_actor,
        created_by=d.created_by,
        updated_at=d.updated_at,
        lock_version=d.lock_version,
        reviews=[
            DecisionReviewOut.model_validate(r).model_copy(
                update={"reviewed_by_email": emails.get(r.reviewed_by)}
            )
            for r in reviews
        ],
        **can,
    )


def _abilities(principal: Principal | None, d: Decision) -> dict[str, bool]:
    if principal is None or principal.is_run or class_of(d) == "checkpoint":
        return {}
    who = _who(principal)
    approver = who == d.approver_id
    owner = has_role(principal.role, "owner")
    editor = approver or owner or who == d.created_by
    proposed = d.status == "proposed"
    captured = d.status == "decided" and d.origin in CAPTURED_ORIGINS
    return {
        "can_edit": (proposed and editor) or (captured and approver),
        "can_decide": proposed and approver,
        "can_withdraw": proposed and editor,
        "can_review": d.status == "decided" and approver,
        "can_reassign": d.status in ("proposed", "decided") and owner,
    }


@dataclass
class Filters:
    class_: str = "all"
    status: str | None = None
    approver: str | None = None
    due: bool | None = None
    origin: str | None = None
    chosen: str | None = None
    run_id: uuid.UUID | None = None
    subject_kind: str | None = None
    subject_id: str | None = None
    q: str | None = None
    limit: int = 50
    offset: int = 0


def _due(day: date):
    """A decided judgement call whose review date has come (state ``review_due``) on
    ``day``, the company's today."""
    return and_(
        Decision.status == "decided",
        Decision.origin != "checkpoint",
        Decision.review_at <= day,
    )


async def list_decisions(
    db: AsyncSession, principal: Principal, f: Filters
) -> list[DecisionSummary]:
    day = await company_today(db)
    query = select(Decision)
    if f.class_ in ("judgement", "checkpoint"):
        query = query.where(Decision.class_ == f.class_)
    if f.status == "review_due":
        f.due = True
    elif f.status == "open":
        query = query.where(or_(Decision.status == "proposed", _due(day)))
    elif f.status:
        query = query.where(Decision.status == f.status)
    if f.approver == "me":
        query = query.where(Decision.approver_id == _who(principal))
    elif f.approver:
        try:
            query = query.where(Decision.approver_id == uuid.UUID(f.approver))
        except ValueError:
            raise DecisionError(422, "approver is me or a member id") from None
    if f.due:
        query = query.where(_due(day))
    if f.origin:
        query = query.where(Decision.origin.in_([o for o in f.origin.split(",") if o]))
    if f.chosen:
        query = query.where(Decision.chosen_option == f.chosen)
    if f.run_id is not None:
        query = query.where(Decision.run_id == f.run_id)
    if f.subject_kind or f.subject_id:
        match: dict[str, str] = {}
        if f.subject_kind:
            match["kind"] = f.subject_kind
        if f.subject_id:
            match["id"] = f.subject_id
        query = query.where(Decision.subjects.contains([match]))
    if f.q and f.q.strip():
        like = f"%{f.q.strip()}%"
        query = query.where(
            or_(
                Decision.title.ilike(like),
                Decision.question.ilike(like),
                Decision.rationale.ilike(like),
                cast(Decision.number, Text) == f.q.strip().upper().removeprefix("D-"),
            )
        )
    query = query.order_by(Decision.number.desc()).limit(f.limit).offset(f.offset)
    rows = list(await db.scalars(query))
    emails = await _emails(db, {d.approver_id for d in rows})
    return [summary(d, emails, day) for d in rows]


async def people(db: AsyncSession) -> list[User]:
    """Active members, by email: who can be named on a decision."""
    return list(
        await db.scalars(select(User).where(User.disabled_at.is_(None)).order_by(User.email))
    )


# --- validation ----------------------------------------------------------------------------


async def check_approver(db: AsyncSession, user_id: uuid.UUID) -> User:
    user = await db.get(User, user_id)
    if user is None or user.disabled_at is not None or not has_role(user.role, "approver"):
        raise DecisionError(
            422, "The approver must be an active member with the approver role or above"
        )
    return user


async def _check_members(db: AsyncSession, ids: list[uuid.UUID], what: str) -> list[uuid.UUID]:
    ids = list(dict.fromkeys(ids))
    if ids:
        found = set(await db.scalars(select(User.id).where(User.id.in_(ids))))
        missing = [str(i) for i in ids if i not in found]
        if missing:
            raise DecisionError(422, f"{what}: not members of this company: {', '.join(missing)}")
    return ids


async def _check_ids(db: AsyncSession, model: Any, ids: list[uuid.UUID], what: str) -> list:
    ids = list(dict.fromkeys(ids))
    if ids:
        found = set(await db.scalars(select(model.id).where(model.id.in_(ids))))
        missing = [str(i) for i in ids if i not in found]
        if missing:
            raise DecisionError(422, f"unknown {what}: {', '.join(missing)}")
    return ids


def _options(options: list[Any]) -> list[dict[str, Any]]:
    return [o.model_dump(mode="json") for o in options]


def _subjects(subjects: list[Any]) -> list[dict[str, Any]]:
    return [{k: v for k, v in s.model_dump(mode="json").items() if v is not None} for s in subjects]


def check_review_at(value: date, first: date, *, start: date | None = None) -> date:
    """``first``: the company's today."""
    if value < first:
        raise DecisionError(422, "The review date cannot be in the past")
    if value > (start or first) + timedelta(days=MAX_REVIEW_DAYS):
        raise DecisionError(422, f"The review date is at most {MAX_REVIEW_DAYS} days out")
    return value


def _refuse_checkpoint(d: Decision) -> None:
    if class_of(d) == "checkpoint":
        raise DecisionError(409, CHECKPOINT_LOCKED)


def _refuse_run(principal: Principal, what: str) -> None:
    if principal.is_run:
        raise DecisionError(403, f"Oracle does not {what} on its own: a person does")


async def next_number(db: AsyncSession) -> int:
    """The company's next D-number, under a lock held until the transaction ends."""
    tenant_id = current_tenant(db)
    await db.execute(
        text("SELECT pg_advisory_xact_lock(hashtext('decisions:' || :t))"), {"t": str(tenant_id)}
    )
    latest = await db.scalar(select(func.max(Decision.number)))
    return (latest or 0) + 1


# --- writes --------------------------------------------------------------------------------


async def create(
    db: AsyncSession,
    principal: Principal,
    body: DecisionCreate,
    *,
    supersedes: Decision | None = None,
) -> Decision:
    await check_approver(db, body.approver_id)
    contributors = await _check_members(db, body.contributor_ids, "contributor_ids")
    informed = await _check_members(db, body.informed_ids, "informed_ids")
    evidence = await _check_ids(db, Evidence, body.evidence_ids, "evidence_ids")
    entities = await _check_ids(db, Entity, body.entity_ids, "entity_ids")
    option_evidence = {e for o in body.options for e in o.evidence_ids}
    await _check_ids(db, Evidence, sorted(option_evidence), "option evidence_ids")
    by_oracle = principal.is_run
    d = Decision(
        number=await next_number(db),
        title=body.title.strip(),
        question=(body.question or "").strip() or None,
        context=(body.context or "").strip() or None,
        options=_options(body.options),
        reversibility=body.reversibility,
        status="proposed",
        approver_id=body.approver_id,
        driver="oracle" if by_oracle else f"user:{_who(principal)}",
        contributor_ids=contributors,
        informed_ids=informed,
        evidence_ids=evidence,
        entity_ids=entities,
        subjects=_subjects(body.subjects),
        origin="oracle" if by_oracle else "manual",
        run_id=principal.run_id if by_oracle else None,
        supersedes_id=supersedes.id if supersedes else None,
        created_by=_who(principal),
    )
    db.add(d)
    await db.flush()
    await audit.record(
        db,
        principal,
        "decision.proposed",
        "decision",
        d.id,
        {"number": d.number, "approver_id": str(d.approver_id), "origin": d.origin},
    )
    return d


def _editor(principal: Principal, d: Decision) -> bool:
    who = _who(principal)
    return who in (d.created_by, d.approver_id) or has_role(principal.role, "owner")


async def update(
    db: AsyncSession, principal: Principal, d: Decision, body: DecisionPatch
) -> Decision:
    _refuse_checkpoint(d)
    _refuse_run(principal, "edit decisions")
    fields = body.model_fields_set - {"lock_version"}
    if d.status == "decided" and d.origin in CAPTURED_ORIGINS and fields <= set(CAPTURED_FIELDS):
        if _who(principal) != d.approver_id:
            raise DecisionError(403, "Only the approver edits a recorded decision")
        expect_version(d, body.lock_version)
        if "review_at" in fields:
            if body.review_at is None:
                raise DecisionError(422, "A decided decision keeps a review date")
            d.review_at = check_review_at(body.review_at, await company_today(db))
        if "expected_outcome" in fields:
            d.expected_outcome = (body.expected_outcome or "").strip() or None
        if "prediction" in fields:
            await _set_prediction(db, principal, d, body.prediction)
        await flush_or_conflict(db)
        await audit.record(
            db, principal, "decision.updated", "decision", d.id, {"fields": sorted(fields)}
        )
        return d
    if d.status == "decided":
        raise DecisionError(409, DECIDED_LOCKED)
    if d.status != "proposed":
        raise DecisionError(409, f"{ref(d.number)} is {d.status}; it is not edited")
    if not _editor(principal, d):
        raise DecisionError(403, "Only its creator, its approver or an owner edits a proposal")
    expect_version(d, body.lock_version)
    if "title" in fields and body.title is not None:
        d.title = body.title.strip()
    if "question" in fields:
        d.question = (body.question or "").strip() or None
    if "context" in fields:
        d.context = (body.context or "").strip() or None
    if "options" in fields and body.options is not None:
        evidence = sorted({e for o in body.options for e in o.evidence_ids})
        await _check_ids(db, Evidence, evidence, "option evidence_ids")
        d.options = _options(body.options)
    if "reversibility" in fields and body.reversibility is not None:
        d.reversibility = body.reversibility
    if "contributor_ids" in fields and body.contributor_ids is not None:
        d.contributor_ids = await _check_members(db, body.contributor_ids, "contributor_ids")
    if "informed_ids" in fields and body.informed_ids is not None:
        d.informed_ids = await _check_members(db, body.informed_ids, "informed_ids")
    if "evidence_ids" in fields and body.evidence_ids is not None:
        d.evidence_ids = await _check_ids(db, Evidence, body.evidence_ids, "evidence_ids")
    if "entity_ids" in fields and body.entity_ids is not None:
        d.entity_ids = await _check_ids(db, Entity, body.entity_ids, "entity_ids")
    if "subjects" in fields and body.subjects is not None:
        d.subjects = _subjects(body.subjects)
    if "expected_outcome" in fields:
        d.expected_outcome = (body.expected_outcome or "").strip() or None
    await flush_or_conflict(db)
    await audit.record(
        db, principal, "decision.updated", "decision", d.id, {"fields": sorted(fields)}
    )
    return d


async def _set_prediction(
    db: AsyncSession, principal: Principal | None, d: Decision, prediction: PredictionIn | None
) -> None:
    """Store the measurable version; the first one creates the outcome record (H3)."""
    if prediction is None:
        d.prediction = None
        return
    goal = await db.get(Entity, prediction.goal_id)
    if goal is None or goal.type != "goal":
        raise DecisionError(422, "prediction.goal_id is not a goal of the baseline")
    d.prediction = prediction.model_dump(mode="json")
    if d.outcome_id is not None:
        return
    record = OutcomeRecord(
        title=d.title,
        goal_id=goal.id,
        prediction={k: v for k, v in d.prediction.items() if k != "goal_id"},
        module_keys=[],
        gap_categories=[],
        status="tracking",
        assessments=[],
        evidence_ids=list(d.evidence_ids or []),
        owner_id=d.approver_id,
        created_by=principal.id if principal else None,
    )
    db.add(record)
    await db.flush()
    d.outcome_id = record.id


async def irreversible_refusal(db: AsyncSession, approver: User) -> str | None:
    role = await get_setting(db, "decision_irreversible_role")
    if has_role(approver.role, role):
        return None
    return f"Only an {role} can decide a hard-to-reverse decision"


async def decide(db: AsyncSession, principal: Principal, d: Decision, body: DecideIn) -> Decision:
    _refuse_checkpoint(d)
    _refuse_run(principal, "decide")
    if d.status != "proposed":
        raise DecisionError(409, f"{ref(d.number)} is {d.status}; only a proposal is decided")
    who = _who(principal)
    if who != d.approver_id:
        name = (await _emails(db, {d.approver_id})).get(d.approver_id, "its approver")
        raise DecisionError(403, f"Only {name} decides {ref(d.number)}")
    if body.lock_version is not None:
        expect_version(d, body.lock_version)
    approver = await db.get(User, who)
    if (
        approver is None
        or approver.disabled_at is not None
        or not has_role(approver.role, "approver")
    ):
        raise DecisionError(403, "Requires the approver role: an owner reassigns this decision")
    options = list(d.options or [])
    if len(options) < 2:
        raise DecisionError(422, "Add at least two options to decide")
    if body.option_key not in {o.get("key") for o in options}:
        raise DecisionError(422, f"{body.option_key!r} is not one of the options")
    rationale = body.rationale.strip()
    if not rationale:
        raise DecisionError(422, "Say why (rationale)")
    expected = body.expected_outcome.strip()
    if not expected:
        raise DecisionError(422, "Say what should happen if it is right (expected_outcome)")
    reversibility = body.reversibility or d.reversibility
    if reversibility == "irreversible":
        refusal = await irreversible_refusal(db, approver)
        if refusal:
            raise DecisionError(403, refusal)
    day = await company_today(db)
    review_at = check_review_at(body.review_at or day + timedelta(days=REVIEW_DAYS), day)
    d.reversibility = reversibility
    d.chosen_option = body.option_key
    d.rationale = rationale
    d.expected_outcome = expected
    d.review_at = review_at
    if body.prediction is not None:
        await _set_prediction(db, principal, d, body.prediction)
    d.status = "decided"
    d.decided_by = who
    d.decided_actor = "user"
    d.decided_at = _now()
    await flush_or_conflict(db)
    if d.supersedes_id is not None:
        original = await db.get(Decision, d.supersedes_id, with_for_update=True)
        if original is not None and original.status == "decided":
            original.status = "superseded"
            await flush_or_conflict(db)
            await reject_entity(db, principal, original, f"superseded by {ref(d.number)}")
    await sync_entity(db, principal, d)
    await audit.record(
        db,
        principal,
        "decision.decided",
        "decision",
        d.id,
        {
            "number": d.number,
            "chosen_option": d.chosen_option,
            "reversibility": d.reversibility,
            "review_at": d.review_at.isoformat(),
            "outcome_id": str(d.outcome_id) if d.outcome_id else None,
        },
    )
    return d


async def reassign(
    db: AsyncSession, principal: Principal, d: Decision, body: ReassignIn
) -> Decision:
    _refuse_checkpoint(d)
    _refuse_run(principal, "reassign decisions")
    if not has_role(principal.role, "owner"):
        raise DecisionError(403, "Only an owner reassigns a decision's approver")
    if d.status not in ("proposed", "decided"):
        raise DecisionError(409, f"{ref(d.number)} is {d.status}; there is nothing to reassign")
    await check_approver(db, body.approver_id)
    before = d.approver_id
    d.approver_id = body.approver_id
    await flush_or_conflict(db)
    await audit.record(
        db,
        principal,
        "decision.reassigned",
        "decision",
        d.id,
        {"from": str(before), "to": str(body.approver_id), "reason": body.reason},
    )
    return d


async def withdraw(db: AsyncSession, principal: Principal, d: Decision, reason: str) -> Decision:
    _refuse_checkpoint(d)
    _refuse_run(principal, "withdraw decisions")
    if d.status != "proposed":
        raise DecisionError(409, f"{ref(d.number)} is {d.status}; only a proposal is withdrawn")
    if not _editor(principal, d):
        raise DecisionError(403, "Only its creator, its approver or an owner withdraws it")
    d.status = "withdrawn"
    await flush_or_conflict(db)
    await audit.record(
        db, principal, "decision.withdrawn", "decision", d.id, {"reason": reason.strip()}
    )
    return d


async def review(db: AsyncSession, principal: Principal, d: Decision, body: ReviewIn) -> Decision:
    _refuse_checkpoint(d)
    _refuse_run(principal, "review decisions")
    if d.status != "decided":
        raise DecisionError(409, f"{ref(d.number)} is {d.status}; only a decided one is reviewed")
    who = _who(principal)
    if who != d.approver_id:
        name = (await _emails(db, {d.approver_id})).get(d.approver_id, "its approver")
        raise DecisionError(403, f"Only {name} reviews {ref(d.number)}")
    note = body.note.strip()
    row = DecisionReview(
        decision_id=d.id,
        verdict=body.verdict,
        note=note,
        reviewed_by=who,
        outcome_status=await _outcome_status(db, d),
    )
    if body.verdict == "reaffirmed":
        day = await company_today(db)
        nxt = check_review_at(body.next_review_at or day + timedelta(days=REVIEW_DAYS), day)
        d.review_at = nxt
        row.next_review_at = nxt
    elif body.verdict == "revisit":
        if await _revisit_of(db, d) is not None:
            raise DecisionError(409, f"{ref(d.number)} is already being revisited")
        new = await create(
            db,
            principal,
            DecisionCreate(
                title=d.title,
                question=d.question,
                context=d.context,
                options=[{**o, "recommended": False} for o in d.options or []],  # type: ignore[misc]
                approver_id=d.approver_id,
                reversibility=d.reversibility,  # type: ignore[arg-type]
                contributor_ids=list(d.contributor_ids or []),
                informed_ids=list(d.informed_ids or []),
                evidence_ids=list(d.evidence_ids or []),
                entity_ids=list(d.entity_ids or []),
                subjects=list(d.subjects or [])[:10],  # type: ignore[arg-type]
            ),
            supersedes=d,
        )
        row.revisit_id = new.id
    else:
        d.status = "reversed"
    db.add(row)
    await flush_or_conflict(db)
    if body.verdict == "reversed":
        await reject_entity(db, principal, d, f"reversed: {note}")
    await audit.record(
        db,
        principal,
        f"decision.review_{body.verdict}",
        "decision",
        d.id,
        {"note": note, "revisit_id": str(row.revisit_id) if row.revisit_id else None},
    )
    return d


async def _outcome_status(db: AsyncSession, d: Decision) -> str | None:
    if d.outcome_id is None:
        return None
    return await db.scalar(select(OutcomeRecord.status).where(OutcomeRecord.id == d.outcome_id))


async def queue_options_job(db: AsyncSession, principal: Principal, d: Decision) -> LlmJob:
    """Ask Oracle for options: one built-in job at a time per decision."""
    _refuse_checkpoint(d)
    if d.status != "proposed":
        raise DecisionError(409, f"{ref(d.number)} is {d.status}; options are for a proposal")
    live = await db.scalar(
        select(LlmJob).where(
            LlmJob.decision_id == d.id,
            LlmJob.kind == "decision_options",
            LlmJob.status.in_(("queued", "running")),
        )
    )
    if live is not None:
        return live
    job = LlmJob(
        kind="decision_options",
        decision_id=d.id,
        status="queued",
        input={"decision": d.number},
        requested_by=principal.id,
        attempts=0,
    )
    db.add(job)
    await db.flush()
    await audit.record(
        db,
        principal,
        "llm_job.queue",
        "llm_job",
        job.id,
        {"kind": "decision_options", "decision_id": str(d.id)},
    )
    return job


# --- the Inbox -----------------------------------------------------------------------------


async def inbox_rows(
    db: AsyncSession, principal: Principal, seen: datetime | None
) -> list[InboxDecision]:
    """The decision rows of my Inbox (checkpoint records raise none): proposals I decide
    and reviews that have come due (counted), decisions made that I am informed of and
    what I handled in the last week (shown only). ``seen``: my previous visit."""
    if principal.is_run:
        return []
    who = _who(principal)
    day, now = await company_today(db), _now()
    since = now - timedelta(days=SHOWN_DAYS)
    judgement = Decision.origin != "checkpoint"
    revisited = select(Decision.supersedes_id).where(
        Decision.status == "proposed", Decision.supersedes_id.is_not(None)
    )
    rows: list[InboxDecision] = []

    def row(
        d: Decision, reason: str, state: str, counts: bool, since: datetime | None = None
    ) -> InboxDecision:
        return InboxDecision(
            id=d.id,
            number=d.number,
            ref=ref(d.number),
            title=d.title,
            reason=reason,  # type: ignore[arg-type]
            review_at=d.review_at,
            since=since or d.decided_at or d.created_at,
            state=state,  # type: ignore[arg-type]
            counts=counts,
        )

    def fresh(at: datetime | None) -> str:
        return "new" if seen is None or (at is not None and at > seen) else "open"

    proposed = await db.scalars(
        select(Decision)
        .where(judgement, Decision.approver_id == who, Decision.status == "proposed")
        .order_by(Decision.created_at, Decision.number)
    )
    rows += [row(d, "needs_decision", fresh(d.created_at), True, d.created_at) for d in proposed]
    due = await db.scalars(
        select(Decision)
        .where(
            judgement,
            Decision.approver_id == who,
            Decision.status == "decided",
            Decision.review_at <= day,
            Decision.id.not_in(revisited),
        )
        .order_by(Decision.review_at, Decision.number)
    )
    for d in due:
        came = datetime.combine(d.review_at, datetime.min.time(), UTC) if d.review_at else None
        rows.append(row(d, "review_due", fresh(came), True, came))
    shown = {r.id for r in rows}
    # Done: what I decided or reviewed in the last week.
    reviewed = (
        await db.execute(
            select(Decision, DecisionReview.created_at)
            .join(DecisionReview, DecisionReview.decision_id == Decision.id)
            .where(judgement, DecisionReview.reviewed_by == who, DecisionReview.created_at >= since)
            .order_by(DecisionReview.created_at.desc())
        )
    ).all()
    for d, at in reviewed:
        if d.id not in shown:
            shown.add(d.id)
            rows.append(row(d, "review_due", "done", False, at))
    decided = await db.scalars(
        select(Decision)
        .where(judgement, Decision.decided_by == who, Decision.decided_at >= since)
        .order_by(Decision.decided_at.desc())
    )
    for d in decided:
        if d.id not in shown:
            shown.add(d.id)
            rows.append(row(d, "needs_decision", "done", False))
    informed = await db.scalars(
        select(Decision)
        .where(
            judgement,
            Decision.status == "decided",
            Decision.decided_at >= since,
            any_(Decision.informed_ids) == who,
        )
        .order_by(Decision.decided_at.desc())
    )
    for d in informed:
        if d.id not in shown:
            shown.add(d.id)
            rows.append(row(d, "informed", fresh(d.decided_at), False))
    return rows


# --- the baseline graph --------------------------------------------------------------------


def _writer(principal: Principal | None, reason: str) -> baseline.Writer:
    return baseline.Writer(principal, "user", reason=reason, manages=("decision_id",))


async def sync_entity(db: AsyncSession, principal: Principal | None, d: Decision) -> None:
    """A decided judgement call is a locked, confirmed baseline ``decision`` entity
    (key ``d-<number>``) with ``affects`` edges to what it is about. Checkpoint records
    never sync."""
    if class_of(d) == "checkpoint" or d.status != "decided":
        return
    writer = _writer(principal, f"{ENTITY_REASON}: {ref(d.number)} decided")
    attrs = {
        "decision_id": str(d.id),
        "chosen_option": d.chosen_option,
        "reversibility": d.reversibility,
    }
    key = f"d-{d.number}"
    entity = await db.get(Entity, d.entity_id) if d.entity_id else None
    entity = entity or await baseline.find_entity(db, "decision", key)
    if entity is None:
        entity = (
            await baseline.create_entity(
                db,
                writer,
                type_="decision",
                key=key,
                title=d.title,
                body=d.rationale,
                attrs=attrs,
                status="confirmed",
            )
        ).entity
    else:
        await baseline.update_entity(
            db,
            writer,
            entity,
            {"title": d.title, "body": d.rationale, "attrs": attrs, "status": "confirmed"},
        )
    assert entity is not None
    d.entity_id = entity.id
    for target in d.entity_ids or []:
        if target == entity.id or await db.get(Entity, target) is None:
            continue
        if await baseline.find_edge(db, entity.id, target, "affects") is None:
            await baseline.create_edge(db, writer, src_id=entity.id, dst_id=target, type_="affects")
    await db.flush()


async def reject_entity(
    db: AsyncSession, principal: Principal | None, d: Decision, why: str
) -> None:
    """A reversed or superseded decision's entity goes to ``rejected``: the baseline
    records the ``decision`` change and the staleness handler marks what depends on it."""
    if d.entity_id is None:
        return
    entity = await db.get(Entity, d.entity_id)
    if entity is None or entity.status == "rejected":
        return
    writer = _writer(principal, f"{ENTITY_REASON}: {ref(d.number)} {why}"[:500])
    await baseline.update_entity(db, writer, entity, {"status": "rejected"})
    await db.flush()
