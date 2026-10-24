"""Responsibilities a member holds, and handing them to someone else (A5).

Each kind registers what it holds (open items only) and how it moves. A removal or a
demotion lists them (:mod:`oracle.members.impact`), and ``hand_over`` moves the ones the
owner chose, all or none, in the caller's transaction, before the change itself."""

import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.auth.models import Role, User
from oracle.authz import has_role

if TYPE_CHECKING:
    from oracle.auth.deps import Principal


@dataclass(frozen=True)
class Held:
    ref: str  # "review_policy:company", "document:<slug>", "section:<slug>#<key>", ...
    title: str


@dataclass(frozen=True)
class Responsibility:
    kind: str
    label: str
    needs_role: Role
    blocks: str | None
    held: Callable[[AsyncSession, uuid.UUID], Awaitable[list[Held]]]  # open items only
    move: Callable[["AsyncSession", "Principal", uuid.UUID, uuid.UUID | None], Awaitable[int]]
    # What the target may do, in a refusal: "<email> needs the <role> role to <does>".
    does: str = "hold this"


REGISTRY: dict[str, Responsibility] = {}


def register(r: Responsibility) -> None:
    REGISTRY[r.kind] = r


async def held_by(db: AsyncSession, user_id: uuid.UUID) -> list[tuple[Responsibility, list[Held]]]:
    """What ``user_id`` holds now, kind by kind (kinds with nothing held left out)."""
    out = []
    for r in REGISTRY.values():
        items = await r.held(db, user_id)
        if items:
            out.append((r, items))
    return out


def responsibility_out(r: Responsibility, items: list[Held]) -> dict[str, Any]:
    return {
        "kind": r.kind,
        "label": r.label,
        "count": len(items),
        "items": [{"ref": h.ref, "title": h.title} for h in items],
        "needs_role": r.needs_role,
        "blocks": r.blocks,
    }


async def remaining(db: AsyncSession, user_id: uuid.UUID) -> list[dict[str, Any]]:
    return [responsibility_out(r, items) for r, items in await held_by(db, user_id)]


async def hand_over(
    db: AsyncSession, principal: "Principal", from_id: uuid.UUID, moves: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Move what ``from_id`` holds, kind by kind, to each move's ``to`` (``None``
    clears). Every target is checked first: an active member other than ``from_id``
    with the kind's role; any refusal is a 422 listing each refused move, and nothing
    moves. Audited ``member.hand_over``. The caller holds (or this takes) the members
    gate exclusively; it commits."""
    from oracle.members.service import MemberError, _gate

    await _gate(db, principal)
    if await db.get(User, from_id) is None:
        raise MemberError("not_found", f"Member {from_id} not found")
    refused: list[dict[str, str]] = []
    unknown = [m["kind"] for m in moves if m["kind"] not in REGISTRY]
    if unknown:
        raise MemberError(
            "invalid",
            f"Unknown responsibility: {', '.join(unknown)}",
            detail=[
                {"code": "hand_over_kind", "kind": k, "message": f"Unknown responsibility {k}"}
                for k in unknown
            ],
        )
    for m in moves:
        r = REGISTRY[m["kind"]]
        to = m.get("to")
        if to is None:
            continue
        user = await db.get(User, to)
        if user is None or user.disabled_at is not None:
            message = f"{to} is not an active member of this company"
        elif user.id == from_id:
            message = f"{user.email} already holds this; choose someone else"
        elif not has_role(user.role, r.needs_role):
            message = f"{user.email} needs the {r.needs_role} role to {r.does}"
        else:
            continue
        refused.append({"code": "hand_over_target", "kind": r.kind, "message": message})
    if refused:
        raise MemberError("invalid", refused[0]["message"], detail=refused)
    done = []
    for m in moves:
        r = REGISTRY[m["kind"]]
        to = m.get("to")
        refs = [h.ref for h in await r.held(db, from_id)]
        count = await r.move(db, principal, from_id, to)
        done.append({"kind": r.kind, "to": str(to) if to else None, "count": count, "refs": refs})
    if done:
        await db.flush()
        await audit.record(
            db, principal, "member.hand_over", "user", from_id,
            {"from": str(from_id), "moves": done},
        )  # fmt: skip
    return done


# --- review_decider and mandatory_reviewer --------------------------------------------------


async def _company_policy(db: AsyncSession) -> dict[str, Any] | None:
    from oracle.review.state import POLICY_SETTING
    from oracle.tenant_settings import TenantSetting

    row = await db.scalar(select(TenantSetting).where(TenantSetting.key == POLICY_SETTING))
    return dict(row.value) if row is not None and isinstance(row.value, dict) else None


async def _document_policies(db: AsyncSession, where) -> list[tuple[Any, Any]]:
    from oracle.docs.models import Document
    from oracle.review.models import DocumentReviewPolicy

    return list(
        (
            await db.execute(
                select(DocumentReviewPolicy, Document)
                .join(Document, Document.id == DocumentReviewPolicy.document_id)
                .where(where)
                .order_by(Document.slug)
            )
        ).all()
    )


def _is_decider(value: dict[str, Any], user_id: uuid.UUID) -> bool:
    return value.get("decider_id") == str(user_id)


def _is_mandatory(value: dict[str, Any], user_id: uuid.UUID) -> bool:
    return str(user_id) in [str(i) for i in value.get("mandatory_reviewer_ids") or []]


async def _policies_held(db: AsyncSession, user_id: uuid.UUID, mandatory: bool) -> list[Held]:
    from oracle.review.models import DocumentReviewPolicy

    out: list[Held] = []
    company = await _company_policy(db)
    test = _is_mandatory if mandatory else _is_decider
    if company is not None and test(company, user_id):
        out.append(Held("review_policy:company", "Company review policy"))
    where = (
        DocumentReviewPolicy.mandatory_reviewer_ids.contains([user_id])
        if mandatory
        else DocumentReviewPolicy.decider_id == user_id
    )
    out += [
        Held(f"document:{doc.slug}", doc.title or doc.slug)
        for _, doc in await _document_policies(db, where)
    ]
    return out


def _replaced(ids: list[Any], from_id: uuid.UUID, to: uuid.UUID | None) -> list[str]:
    out = []
    for i in ids:
        i = str(i)
        if i == str(from_id):
            if to is None:
                continue
            i = str(to)
        if i not in out:
            out.append(i)
    return out


async def _move_policies(
    db: AsyncSession,
    principal: "Principal",
    from_id: uuid.UUID,
    to: uuid.UUID | None,
    mandatory: bool,
) -> int:
    """Through the policies' own write paths: the company setting's (validated by
    ``validate_policy``, audited ``setting.update``) and ``set_policy`` (audited
    ``review_policy.update``)."""
    from oracle.members.service import MemberError
    from oracle.review.models import DocumentReviewPolicy
    from oracle.review.schemas import ReviewPolicyIn
    from oracle.review.service import ReviewError
    from oracle.review.state import DEFAULT_POLICY, POLICY_SETTING, PolicyError, set_policy
    from oracle.tenant_settings import TenantSetting
    from oracle.tenant_settings_api import InvalidSetting, validate
    from oracle.v2.concurrency import VersionConflict

    def changed(value: dict[str, Any]) -> dict[str, Any]:
        value = dict(value)
        if mandatory:
            value["mandatory_reviewer_ids"] = _replaced(
                value.get("mandatory_reviewer_ids") or [], from_id, to
            )
        else:
            value["decider_id"] = str(to) if to else None
        return value

    count = 0
    test = _is_mandatory if mandatory else _is_decider
    company = await _company_policy(db)
    if company is not None and test(company, from_id):
        try:
            value = await validate(
                db, principal, POLICY_SETTING, changed({**DEFAULT_POLICY, **company})
            )
        except InvalidSetting as e:
            raise MemberError("invalid", f"Company review policy: {e}") from None
        row = await db.scalar(select(TenantSetting).where(TenantSetting.key == POLICY_SETTING))
        row.value = value
        row.updated_by = principal.id
        await db.flush()
        await audit.record(
            db, principal, "setting.update", "tenant_setting",
            data={"key": POLICY_SETTING, "value": value, "via": "member.hand_over"},
        )  # fmt: skip
        count += 1
    where = (
        DocumentReviewPolicy.mandatory_reviewer_ids.contains([from_id])
        if mandatory
        else DocumentReviewPolicy.decider_id == from_id
    )
    for row, doc in await _document_policies(db, where):
        current = {
            "decider_id": str(row.decider_id) if row.decider_id else None,
            "mandatory_reviewer_ids": [str(i) for i in row.mandatory_reviewer_ids],
            "required_section_keys": list(row.required_section_keys),
            "section_approval": row.section_approval,
            "rereview_on_change": row.rereview_on_change,
        }
        body = ReviewPolicyIn.model_validate({**changed(current), "lock_version": row.lock_version})
        try:
            await set_policy(db, principal, doc, body)
        except (PolicyError, ReviewError, VersionConflict) as e:
            message = getattr(e, "detail", None) or getattr(e, "message", None) or str(e)
            raise MemberError("invalid", f"Review policy of {doc.slug}: {message}") from None
        count += 1
    return count


async def _decider_held(db: AsyncSession, user_id: uuid.UUID) -> list[Held]:
    return await _policies_held(db, user_id, mandatory=False)


async def _decider_move(db, principal, from_id, to) -> int:
    return await _move_policies(db, principal, from_id, to, mandatory=False)


async def _mandatory_held(db: AsyncSession, user_id: uuid.UUID) -> list[Held]:
    return await _policies_held(db, user_id, mandatory=True)


async def _mandatory_move(db, principal, from_id, to) -> int:
    return await _move_policies(db, principal, from_id, to, mandatory=True)


# --- section_owner and section_reviewer ----------------------------------------------------


async def _sections(db: AsyncSession, user_id: uuid.UUID, reviewer: bool) -> list[tuple]:
    from oracle.docs.models import Document
    from oracle.review.models import SectionReviewState

    where = (
        SectionReviewState.reviewer_ids.contains([user_id])
        if reviewer
        else SectionReviewState.owner_id == user_id
    )
    return list(
        (
            await db.execute(
                select(SectionReviewState, Document)
                .join(Document, Document.id == SectionReviewState.document_id)
                .where(where)
                .order_by(Document.slug, SectionReviewState.section_key)
            )
        ).all()
    )


async def _sections_held(db: AsyncSession, user_id: uuid.UUID, reviewer: bool) -> list[Held]:
    return [
        Held(
            f"section:{doc.slug}#{row.section_key}", f"{doc.title or doc.slug} · {row.section_key}"
        )
        for row, doc in await _sections(db, user_id, reviewer)
    ]


async def _move_sections(db, principal, from_id, to, reviewer: bool) -> int:
    """Through ``review/collab.set_assignment`` (its audit and the new person's
    notification). A section no longer in the latest version, or whose other people
    were removed meanwhile (the path refuses them), is updated directly, audited
    ``section_assignment.update`` as that path does."""
    from oracle.review.collab import CollabError, set_assignment
    from oracle.review.schemas import SectionAssignmentIn

    rows = await _sections(db, from_id, reviewer)
    for row, doc in rows:
        owner = row.owner_id
        reviewers = list(row.reviewer_ids)
        if reviewer:
            reviewers = [uuid.UUID(i) for i in _replaced(reviewers, from_id, to)]
        else:
            owner = to
        body = SectionAssignmentIn(
            owner_id=owner, reviewer_ids=reviewers, due_at=row.due_at, lock_version=row.lock_version
        )
        try:
            # It refuses before it writes anything.
            await set_assignment(db, principal, doc, row.section_key, body)
        except CollabError:
            before = {
                "owner_id": str(row.owner_id) if row.owner_id else None,
                "reviewer_ids": [str(r) for r in row.reviewer_ids],
            }
            row.owner_id = owner
            row.reviewer_ids = reviewers
            await db.flush()
            await audit.record(
                db, principal, "section_assignment.update", "document", doc.id,
                {"section_key": row.section_key, "before": before,
                 "after": {"owner_id": str(owner) if owner else None,
                           "reviewer_ids": [str(r) for r in reviewers]},
                 "via": "member.hand_over"},
            )  # fmt: skip
    return len(rows)


async def _owner_held(db, user_id) -> list[Held]:
    return await _sections_held(db, user_id, reviewer=False)


async def _owner_move(db, principal, from_id, to) -> int:
    return await _move_sections(db, principal, from_id, to, reviewer=False)


async def _reviewer_held(db, user_id) -> list[Held]:
    return await _sections_held(db, user_id, reviewer=True)


async def _reviewer_move(db, principal, from_id, to) -> int:
    return await _move_sections(db, principal, from_id, to, reviewer=True)


# --- questions -------------------------------------------------------------------------------

OPEN_QUESTIONS = ("asked", "deferred")


async def _questions(db: AsyncSession, user_id: uuid.UUID) -> list:
    from oracle.v2.models import StakeholderQuestion

    return list(
        await db.scalars(
            select(StakeholderQuestion)
            .where(
                StakeholderQuestion.asked_to == user_id,
                StakeholderQuestion.status.in_(OPEN_QUESTIONS),
            )
            .order_by(StakeholderQuestion.id)
        )
    )


async def _questions_held(db, user_id) -> list[Held]:
    return [Held(f"question:{q.id}", q.prompt) for q in await _questions(db, user_id)]


async def _questions_move(db, principal, from_id, to) -> int:
    """Through C2's reassign (``intake.questions.patch``: the new person is asked it,
    audited ``question.reassigned``); cleared, a direct update audited
    ``question.reassign``."""
    from oracle.intake.questions import patch
    from oracle.intake.schemas import QuestionPatch
    from oracle.intake.service import IntakeError
    from oracle.members.service import MemberError

    rows = await _questions(db, from_id)
    for q in rows:
        if to is None:
            q.asked_to = None
            await db.flush()
            await audit.record(
                db, principal, "question.reassign", "stakeholder_question", q.id,
                {"from": str(from_id), "to": None, "via": "member.hand_over"},
            )  # fmt: skip
            continue
        try:
            await patch(db, principal, q, QuestionPatch(asked_to=to))
        except IntakeError as e:
            raise MemberError("invalid", f"Question {q.id}: {e}") from None
    return len(rows)


# --- open_items ------------------------------------------------------------------------------


def _open_item_tables() -> list[tuple[str, Any, Any, Any]]:
    """(audit entity, model, title column, open-status filter) of each table whose rows
    have an owner."""
    from oracle.quality.models import OutcomeRecord
    from oracle.roadmap.models import ProductTrack
    from oracle.v2.models import (
        BlockerOption,
        EvaluationFinding,
        FeasibilityExperiment,
        KnowledgeGap,
    )

    return [
        ("knowledge_gap", KnowledgeGap, KnowledgeGap.statement,
         KnowledgeGap.status.not_in(("answered", "answered_pending_review", "validated"))),
        ("blocker_option", BlockerOption, BlockerOption.title,
         BlockerOption.status.in_(("proposed", "evaluating"))),
        ("feasibility_experiment", FeasibilityExperiment, FeasibilityExperiment.hypothesis,
         FeasibilityExperiment.status.in_(("planned", "running"))),
        ("evaluation_finding", EvaluationFinding, EvaluationFinding.criterion,
         EvaluationFinding.status.in_(("warning", "critical"))),
        ("outcome_record", OutcomeRecord, OutcomeRecord.title,
         OutcomeRecord.status == "tracking"),
        ("product_track", ProductTrack, ProductTrack.title,
         ProductTrack.status.in_(("active", "paused"))),
    ]  # fmt: skip


async def _open_items_held(db: AsyncSession, user_id: uuid.UUID) -> list[Held]:
    out: list[Held] = []
    for entity, model, title, open_ in _open_item_tables():
        rows = await db.execute(
            select(model.id, title).where(model.owner_id == user_id, open_).order_by(model.id)
        )
        out += [Held(f"{entity}:{i}", str(t or entity)) for i, t in rows]
    return out


async def _open_items_move(db, principal, from_id, to) -> int:
    """A direct update of each open row's owner, audited ``<entity>.owner_handed_over``."""
    count = 0
    for entity, model, _, open_ in _open_item_tables():
        rows = list(await db.scalars(select(model).where(model.owner_id == from_id, open_)))
        for row in rows:
            row.owner_id = to
            await db.flush()
            await audit.record(
                db, principal, f"{entity}.owner_handed_over", entity, row.id,
                {"from": str(from_id), "to": str(to) if to else None, "via": "member.hand_over"},
            )  # fmt: skip
        count += len(rows)
    return count


# --- engineering_lead (A3) --------------------------------------------------------------------


async def _lead_held(db: AsyncSession, user_id: uuid.UUID) -> list[Held]:
    user = await db.get(User, user_id)
    return [Held("engineering_lead", "Engineering lead")] if user and user.engineering_lead else []


async def _lead_move(db, principal, from_id, to) -> int:
    """Through A3's audited path: named on the new holder, cleared on the old one."""
    from oracle.members.service import set_engineering_lead

    if not await _lead_held(db, from_id):
        return 0
    if to is not None:
        await set_engineering_lead(db, principal, to, True)
    await set_engineering_lead(db, principal, from_id, False)
    return 1


register(Responsibility(
    "review_decider", "Decides document reviews", "approver",
    "Publishing waits until someone else decides", _decider_held, _decider_move,
    "decide document reviews",
))  # fmt: skip
register(Responsibility(
    "mandatory_reviewer", "Must approve document reviews", "approver",
    "Publishing waits for this approval", _mandatory_held, _mandatory_move,
    "approve document reviews",
))  # fmt: skip
register(Responsibility(
    "section_owner", "Owns document sections", "commenter", None, _owner_held, _owner_move,
    "own document sections",
))  # fmt: skip
register(Responsibility(
    "section_reviewer", "Reviews document sections", "commenter", None, _reviewer_held,
    _reviewer_move, "review document sections",
))  # fmt: skip
register(Responsibility(
    "questions", "Has open questions to answer", "commenter", None, _questions_held,
    _questions_move, "answer questions",
))  # fmt: skip
register(Responsibility(
    "open_items", "Owns open items", "viewer", None, _open_items_held, _open_items_move,
    "own open items",
))  # fmt: skip
register(Responsibility(
    "engineering_lead", "Is the engineering lead", "commenter", None, _lead_held, _lead_move,
    "be the engineering lead",
))  # fmt: skip
