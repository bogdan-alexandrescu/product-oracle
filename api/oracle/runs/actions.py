"""The shared draft decision of a pending checkpoint (D8).

Each pending checkpoint has one draft on the server: a list of per-item actions
(:class:`~oracle.runs.models.CheckpointAction`) and a note to the agents
(``Checkpoint.draft_note``), visible to every member who can see the run.

- **Roles** (C2 Approvers, c6 Who may stage): viewers read; commenters **suggest** (their
  actions count for nothing until an approver stages them); members with the checkpoint's
  approver role or above **stage** actions, remove any action, edit the note and decide.
  A commenter changes or removes only their own suggestion. Every write re-checks the
  caller's role as it lands (:func:`oracle.auth.service.caller_refusal`).
- **Revision**: every change bumps ``Checkpoint.draft_revision``. A decision sent with the
  revision the decider saw is refused when it changed since (:func:`review_changed`).
- **Vocabulary**: what an action may say depends on the checkpoint kind
  (:data:`VOCABULARY`); the spec owning each kind registers its own. A kind with none takes
  no item actions (its draft still has the note, the revision and the wait).
- **Questions**: a ``question`` action asks a teammate about one item through C2's create
  service (:func:`oracle.intake.questions.create`); undoing it withdraws the question while
  unanswered. The read joins the latest answer onto the action.
- **Decided**: the actions are frozen and kept (history); every write is 409.

The writes commit; :func:`read` does not write.
"""

import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.auth.deps import Principal
from oracle.auth.models import ApiToken, User
from oracle.authz import has_role
from oracle.docs.models import DocumentVersion
from oracle.members.names import display_name
from oracle.models import AuditEvent
from oracle.runs import reasons, roadmap, service
from oracle.runs.models import ACTION_KINDS, Checkpoint, CheckpointAction, Run, RunSegment
from oracle.runs.schemas import (
    ActionIn,
    CheckpointReview,
    ItemReason,
    ItemsProblem,
    ReviewAction,
    ReviewAnswer,
    ReviewAnswerer,
    ReviewFile,
    ReviewItem,
    ReviewMilestone,
    ReviewPerson,
    ReviewQuestion,
    ReviewTally,
    WaitInfo,
    WaitingOn,
)
from oracle.v2.models import StakeholderAnswer, StakeholderQuestion

__all__ = ["VOCABULARY", "ActionIn", "InvalidAction", "ValidationContext", "validate"]

DECIDED = "this checkpoint is decided"
# What each write records on the audit trail (oracle.audit.record).
STAGED, SUGGESTED, REMOVED, NOTE_SET = (
    "checkpoint.action_staged",
    "checkpoint.action_suggested",
    "checkpoint.action_removed",
    "checkpoint.note_set",
)
WRITES = (STAGED, SUGGESTED, REMOVED, NOTE_SET)
# The whole file, not one item.
WHOLE_FILE = "*"
# Asked of someone, waiting for them (oracle.intake.questions.OPEN).
OPEN_QUESTIONS = ("asked", "delegated")
# The checkpoint kinds whose segment leaves an item file the draft reviews.
ITEM_FILES = {"roadmap_items": reasons.ITEMS_FILE}
KIND_WORDS = {
    "baseline_confirm": "baseline confirm",
    "feature_set": "feature set",
    "priority_order": "priority order",
    "prd_review": "PRD review",
    "eng_review": "Engineering review",
    "roadmap_items": "roadmap items",
    "roadmap_review": "roadmap review",
    "request_triage": "request triage",
    "strategy_review": "strategy review",
    "launch_review": "launch review",
}


class InvalidAction(ValueError):
    """An action the checkpoint kind's vocabulary does not allow; the message names the
    rule (422)."""


@dataclass(frozen=True)
class ValidationContext:
    """What a vocabulary checks an action against: the item ids in the reviewed file, the
    ids only the reasons name (dropped items, restorable), and the section keys of the run's
    PRD version (None without one)."""

    item_keys: frozenset[str] = frozenset()
    prd_sections: frozenset[str] | None = None
    dropped_keys: frozenset[str] = frozenset()
    # item id -> the item as the file has it (a question's PRD section).
    items: dict[str, dict[str, Any]] = field(default_factory=dict)


# --------------------------------------------------------------------------- vocabulary

Validator = Callable[[ActionIn, ValidationContext], None]

HORIZONS = ("now", "next", "later")
# kind=edit: the fields of the D2 vocabulary, and the bound of the strings among them.
TEXT_FIELDS = {"milestone_name": 120, "title": 200, "outcome": 500}
NULL_FIELDS = ("milestone_date",)
EDIT_FIELDS = ("horizon", *NULL_FIELDS, "order", *TEXT_FIELDS, "depends_on", "prd_section")
# clear:<field>: the optional fields a malformed-field reason names (D2).
CLEARABLE = frozenset(reasons.MALFORMED.values())
QUESTION_TEXT = 1000
WAIVE_REASON = 2000


def _ids(value: Any) -> list[str] | None:
    if not isinstance(value, list) or not all(isinstance(v, str) and v for v in value):
        return None
    return value


def _known(ids: list[str], ctx: ValidationContext, rule: str) -> None:
    for i in ids:
        if i not in ctx.item_keys:
            raise InvalidAction(f"{rule} names unknown item {i}")


def _edit(body: ActionIn, ctx: ValidationContext) -> None:
    f, v = body.field, body.value
    if f is not None and f.startswith("clear:"):
        if f.removeprefix("clear:") not in CLEARABLE:
            raise InvalidAction(
                f"{f} is not a field that can be cleared: one of "
                + ", ".join(f"clear:{c}" for c in sorted(CLEARABLE))
            )
        if v is not None:
            raise InvalidAction(f"{f} takes no value")
        return
    if f not in EDIT_FIELDS:
        raise InvalidAction(
            f"edit cannot change {f or 'nothing (no field)'}: name one of "
            + ", ".join(EDIT_FIELDS)
            + " or clear:<field>"
        )
    if f == "horizon":
        if v not in HORIZONS:
            raise InvalidAction("horizon is now, next or later")
    elif f in NULL_FIELDS:
        if v is not None:
            raise InvalidAction(
                "milestone_date can only be removed (value null): a date is added through a "
                "schedule basis"
            )
    elif f == "order":
        # "Fix order": null, or after the dependency it must follow (D2's fix).
        if v is not None:
            after = v.get("after") if isinstance(v, dict) and set(v) == {"after"} else None
            if not isinstance(after, str) or not after:
                raise InvalidAction('order is null or {"after": id}')
            _known([after], ctx, "order")
    elif f in TEXT_FIELDS:
        limit = TEXT_FIELDS[f]
        if not isinstance(v, str) or not v.strip() or len(v) > limit:
            raise InvalidAction(f"{f} is a string of 1 to {limit} characters")
    elif f == "depends_on":
        if not isinstance(v, dict) or not v or set(v) - {"add", "remove"}:
            raise InvalidAction('depends_on is {"add": [ids], "remove": [ids]}')
        lists = [_ids(v.get(k, [])) for k in ("add", "remove")]
        if any(x is None for x in lists) or not any(lists):
            raise InvalidAction('depends_on is {"add": [ids], "remove": [ids]}, one not empty')
        for ids in lists:
            _known(ids or [], ctx, "depends_on")
    elif f == "prd_section":
        if ctx.prd_sections is None:
            raise InvalidAction("prd_section: the run has no PRD version to link a section of")
        if not isinstance(v, str) or v not in ctx.prd_sections:
            raise InvalidAction(f"prd_section {v} is not in the PRD version")


def _no_value(body: ActionIn) -> None:
    if body.field is not None or body.value is not None:
        raise InvalidAction(f"{body.kind} takes no value")


def _roadmap_items(body: ActionIn, ctx: ValidationContext) -> None:
    """The D2 Product reasons vocabulary on ``roadmap_items.yaml`` (all kinds but
    look_again and add)."""
    if body.kind in ("look_again", "add"):
        raise InvalidAction(f"{body.kind} does not apply to roadmap items")
    known = ctx.item_keys | ctx.dropped_keys | {WHOLE_FILE}
    if body.item_key not in known:
        raise InvalidAction(f"{body.item_key} is not an item of the file")
    if body.kind in ("accept", "drop", "restore"):
        _no_value(body)
    elif body.kind == "edit":
        _edit(body, ctx)
    elif body.kind in ("split", "merge"):
        key = "into" if body.kind == "split" else "with"
        ids = _ids(body.value.get(key)) if isinstance(body.value, dict) else None
        if body.field is not None or not ids or set(body.value) != {key}:
            raise InvalidAction(f'{body.kind} needs {{"{key}": [ids]}}, one id or more')
        if body.kind == "merge":
            _known(ids, ctx, "merge")
    elif body.kind == "question":
        v = body.value if isinstance(body.value, dict) else {}
        text = v.get("text")
        try:
            uuid.UUID(str(v.get("asked_to")))
        except ValueError:
            text = None
        if (
            body.field is not None
            or not isinstance(text, str)
            or not text.strip()
            or len(text) > QUESTION_TEXT
            or set(v) != {"asked_to", "text"}
        ):
            raise InvalidAction(
                f"question needs asked_to (a member id) and text (1 to {QUESTION_TEXT} characters)"
            )
    elif body.kind == "waive":
        reason = body.value.get("reason") if isinstance(body.value, dict) else None
        if not isinstance(reason, str) or not reason.strip() or len(reason) > WAIVE_REASON:
            raise InvalidAction("waive needs a reason")


# The spec owning each checkpoint kind registers its vocabulary here.
VOCABULARY: dict[str, Validator] = {"roadmap_items": _roadmap_items}


def validate(checkpoint_kind: str, body: ActionIn, ctx: ValidationContext) -> None:
    """Raise :class:`InvalidAction` unless ``body`` is in the checkpoint kind's vocabulary."""
    if body.kind not in ACTION_KINDS:
        raise InvalidAction(f"unknown action kind {body.kind}: one of {', '.join(ACTION_KINDS)}")
    vocabulary = VOCABULARY.get(checkpoint_kind)
    if vocabulary is None:
        words = KIND_WORDS.get(checkpoint_kind, checkpoint_kind)
        raise InvalidAction(f"a {words} checkpoint takes no item actions")
    if any(not a or len(a) > 80 for a in body.answers):
        raise InvalidAction("answers are reason codes of 1 to 80 characters")
    vocabulary(body, ctx)


# --------------------------------------------------------------------------- the file


@dataclass
class _File:
    seq: int
    name: str
    checked: service.CheckedItems | None


async def _file(db: AsyncSession, run: Run, cp: Checkpoint) -> _File | None:
    """The checkpoint's item file with its check and reasons, as of now; None for a kind
    with no item file."""
    name = ITEM_FILES.get(cp.kind)
    seq = (cp.payload or {}).get("segment_seq")
    if name is None or not isinstance(seq, int):
        return None
    segment = await db.scalar(
        select(RunSegment).where(RunSegment.run_id == run.id, RunSegment.seq == seq)
    )
    text = ((segment.artifacts or {}).get("files") or {}).get(name) if segment else None
    if not isinstance(text, str):
        return _File(seq, name, None)
    return _File(seq, name, await service.checked_items(db, run, text))


def _context(found: _File | None) -> ValidationContext:
    if found is None or found.checked is None:
        return ValidationContext()
    checked = found.checked
    items = {i["id"]: i for i in checked.check.items}
    dropped = {r["item"] for r in checked.reasons if r["item"] not in items}
    return ValidationContext(
        item_keys=frozenset(items),
        prd_sections=frozenset(checked.prd_sections) if checked.prd_sections is not None else None,
        dropped_keys=frozenset(dropped),
        items=items,
    )


# --------------------------------------------------------------------------- writes


async def _writable(
    db: AsyncSession,
    principal: Principal,
    run_id: uuid.UUID,
    checkpoint_id: uuid.UUID,
    stage: bool,
) -> tuple[Run, Checkpoint]:
    """The run (row locked: draft writes and decisions land one at a time) and the pending
    checkpoint; the caller holds the role a write needs, read now under the review gate
    (CR-06: a disable or a demotion that commits first wins), as decide reads it."""
    from oracle.auth.service import caller_refusal
    from oracle.review import publish

    await publish.gate_lock(db, shared=True)
    run = await service._get_run(db, run_id, lock=True)
    cp = await db.scalar(
        select(Checkpoint)
        .where(Checkpoint.id == checkpoint_id, Checkpoint.run_id == run.id)
        .execution_options(populate_existing=True)
    )
    if cp is None:
        raise service.NotFound(f"checkpoint {checkpoint_id} not found")
    role = cp.approver_role if stage else "commenter"
    if not has_role(principal.role, role):  # type: ignore[arg-type]
        raise service.Forbidden(f"Requires the {role} role")
    refusal = await caller_refusal(db, principal, role)  # type: ignore[arg-type]
    if refusal is not None:
        raise service.Forbidden(refusal)
    if cp.status != "pending":
        raise service.RunError(DECIDED)
    return run, cp


def _stages(principal: Principal, cp: Checkpoint) -> bool:
    return has_role(principal.role, cp.approver_role)  # type: ignore[arg-type]


async def _action(db: AsyncSession, cp: Checkpoint, action_id: uuid.UUID) -> CheckpointAction:
    action = await db.scalar(
        select(CheckpointAction).where(
            CheckpointAction.id == action_id, CheckpointAction.checkpoint_id == cp.id
        )
    )
    if action is None:
        raise service.NotFound(f"action {action_id} not found")
    return action


def _snapshot(action: CheckpointAction) -> dict[str, Any]:
    return {
        "id": str(action.id),
        "kind": action.kind,
        "field": action.field,
        "value": action.value,
        "state": action.state,
    }


async def _bump(
    db: AsyncSession,
    principal: Principal,
    run: Run,
    cp: Checkpoint,
    event: str,
    item_key: str | None,
    action: dict[str, Any] | None,
) -> None:
    """One change of the draft: the revision bumped and the change audited, with the
    revision it made (what :func:`review_changed` reads)."""
    cp.draft_revision = (cp.draft_revision or 0) + 1
    await audit.record(
        db, principal, event, "checkpoint", cp.id,
        {"run_id": str(run.id), "kind": cp.kind, "item_key": item_key, "action": action,
         "revision": cp.draft_revision},
    )  # fmt: skip


async def _withdraw(db: AsyncSession, principal: Principal, question_id: uuid.UUID | None) -> None:
    """A question action's question, withdrawn while nobody answered it."""
    question = await db.get(StakeholderQuestion, question_id) if question_id else None
    if question is not None and question.status in OPEN_QUESTIONS:
        question.status = "withdrawn"
        await audit.record(
            db, principal, "question.withdrawn", "stakeholder_question", question.id, {}
        )


async def _ask(
    db: AsyncSession,
    principal: Principal,
    run: Run,
    cp: Checkpoint,
    body: ActionIn,
    ctx: ValidationContext,
) -> uuid.UUID:
    """Ask the named member about the item through C2 (the one way questions are made),
    about the run's document or its source PRD and the item's PRD section."""
    from oracle.intake import questions
    from oracle.intake.schemas import CheckpointItemSubject, QuestionCreate
    from oracle.intake.service import IntakeError

    try:
        question = await questions.create(
            db,
            principal,
            QuestionCreate(
                prompt=body.value["text"].strip(),
                asked_to=uuid.UUID(str(body.value["asked_to"])),
                subject=CheckpointItemSubject(
                    kind="checkpoint_item", checkpoint_id=cp.id, item_ref=body.item_key
                ),
            ),
        )
    except IntakeError as exc:
        error = service.RunError(str(exc))
        error.status = exc.status
        raise error from None
    document_id = run.document_id
    source_id = service._source_id(run)
    if document_id is None and source_id is not None:
        document_id = await db.scalar(
            select(DocumentVersion.document_id).where(DocumentVersion.id == source_id)
        )
    section = (ctx.items.get(body.item_key) or {}).get("prd_section")
    question.document_id = document_id
    question.section_key = section if isinstance(section, str) and section else None
    return question.id


async def put_action(
    db: AsyncSession,
    principal: Principal,
    run_id: uuid.UUID,
    checkpoint_id: uuid.UUID,
    body: ActionIn,
) -> None:
    """Stage (the approver role or above) or suggest (commenters) one action: one per
    item, kind and field, so the same again replaces it."""
    run, cp = await _writable(db, principal, run_id, checkpoint_id, stage=False)
    found = await _file(db, run, cp) if cp.kind in VOCABULARY else None
    ctx = _context(found)
    try:
        validate(cp.kind, body, ctx)
    except InvalidAction as exc:
        raise service.Invalid(str(exc)) from None
    stages = _stages(principal, cp)
    existing = await db.scalar(
        select(CheckpointAction).where(
            CheckpointAction.checkpoint_id == cp.id,
            CheckpointAction.item_key == body.item_key,
            CheckpointAction.kind == body.kind,
            func.coalesce(CheckpointAction.field, "") == (body.field or ""),
        )
    )
    if existing is not None and not stages and existing.created_by != principal.id:
        raise service.Forbidden("Only its author or an approver can change this action")
    question_id = None
    if body.kind == "question":
        if existing is not None:
            await _withdraw(db, principal, existing.question_id)
        question_id = await _ask(db, principal, run, cp, body, ctx)
    action = existing or CheckpointAction(
        checkpoint_id=cp.id, item_key=body.item_key, kind=body.kind, field=body.field
    )
    action.value = body.value
    action.answers = list(body.answers)
    action.note = (body.note or "").strip() or None
    action.state = "staged" if stages else "suggested"
    action.question_id = question_id
    # Staging again replaces the action: its author is who wrote it now.
    action.created_by = principal.id
    action.updated_by = principal.id
    if existing is None:
        db.add(action)
    await db.flush()
    event = STAGED if stages else SUGGESTED
    await _bump(db, principal, run, cp, event, body.item_key, _snapshot(action))
    await db.commit()


async def stage_action(
    db: AsyncSession,
    principal: Principal,
    run_id: uuid.UUID,
    checkpoint_id: uuid.UUID,
    action_id: uuid.UUID,
) -> None:
    """A suggestion becomes staged: it keeps who suggested it, ``updated_by`` says who
    staged it. Staging a staged action changes nothing."""
    run, cp = await _writable(db, principal, run_id, checkpoint_id, stage=True)
    action = await _action(db, cp, action_id)
    if action.state == "staged":
        return
    action.state = "staged"
    action.updated_by = principal.id
    await db.flush()
    await _bump(db, principal, run, cp, STAGED, action.item_key, _snapshot(action))
    await db.commit()


async def remove_action(
    db: AsyncSession,
    principal: Principal,
    run_id: uuid.UUID,
    checkpoint_id: uuid.UUID,
    action_id: uuid.UUID,
) -> None:
    """Undo: by its author, or the approver role or above. A question action withdraws its
    question while nobody answered it."""
    from oracle.auth.service import caller_refusal

    run, cp = await _writable(db, principal, run_id, checkpoint_id, stage=False)
    action = await _action(db, cp, action_id)
    if action.created_by != principal.id:
        if not _stages(principal, cp):
            raise service.Forbidden("Only its author or an approver can undo this action")
        refusal = await caller_refusal(db, principal, cp.approver_role)  # type: ignore[arg-type]
        if refusal is not None:
            raise service.Forbidden(refusal)
    await _withdraw(db, principal, action.question_id)
    snapshot = _snapshot(action)
    await db.delete(action)
    await db.flush()
    await _bump(db, principal, run, cp, REMOVED, action.item_key, snapshot)
    await db.commit()


async def set_note(
    db: AsyncSession,
    principal: Principal,
    run_id: uuid.UUID,
    checkpoint_id: uuid.UUID,
    note: str | None,
) -> None:
    """The draft's note to the agents (the approver role or above); the same note again
    changes nothing."""
    run, cp = await _writable(db, principal, run_id, checkpoint_id, stage=True)
    note = note if note is not None and note.strip() else None
    if note == cp.draft_note:
        return
    cp.draft_note = note
    await _bump(db, principal, run, cp, NOTE_SET, None, None)
    await db.commit()


# --------------------------------------------------------------------------- revision


def _listed(names: list[str]) -> str:
    if len(names) < 2:
        return "".join(names)
    return f"{', '.join(names[:-1])} and {names[-1]}"


async def review_changed(db: AsyncSession, cp: Checkpoint, expected: int) -> service.RunError:
    """The 409 a decision sent with an older revision gets: how many changes since, and by
    whom (from the audit trail), in the words the decider reads."""
    revision = cp.draft_revision or 0
    events = (
        await db.scalars(
            select(AuditEvent)
            .where(
                AuditEvent.entity == "checkpoint",
                AuditEvent.entity_id == cp.id,
                AuditEvent.action.in_(WRITES),
                AuditEvent.data["revision"].as_integer() > expected,
            )
            .order_by(AuditEvent.data["revision"].as_integer())
        )
    ).all()
    actors: list[uuid.UUID] = []
    for e in events:
        try:
            actor = uuid.UUID(e.actor.split(":", 1)[1])
        except (IndexError, ValueError):
            continue
        if actor not in actors:
            actors.append(actor)
    people = await _people(db, actors)
    by = [people[a].name for a in actors if a in people]
    changes = max(revision - expected, 0) or len(events)
    word = "change" if changes == 1 else "changes"
    who = f" by {_listed(by)}" if by else ""
    message = (
        f"The review changed since you loaded it ({changes} {word}{who}): look again, then decide."
    )
    error = service.RunError(message)
    error.detail = {  # type: ignore[attr-defined]
        "code": "review_changed",
        "revision": revision,
        "changes": changes,
        "by": by,
        "message": message,
    }
    return error


# --------------------------------------------------------------------------- read


async def _people(db: AsyncSession, ids: list[uuid.UUID]) -> dict[uuid.UUID, ReviewPerson]:
    """Members by id (their name and role now), and API tokens by their name."""
    wanted = list({i for i in ids if i is not None})
    if not wanted:
        return {}
    out: dict[uuid.UUID, ReviewPerson] = {}
    for user in await db.scalars(select(User).where(User.id.in_(wanted))):
        out[user.id] = ReviewPerson(id=user.id, name=display_name(user.email), role=user.role)
    for token in await db.scalars(select(ApiToken).where(ApiToken.id.in_(wanted))):
        out[token.id] = ReviewPerson(id=token.id, name=token.name, role=token.role)
    return out


def wait_info(payload: dict[str, Any] | None, now: datetime) -> WaitInfo:
    """The SwarmCloud wait the checkpoint's step is parked in (``payload.wait``)."""
    wait = (payload or {}).get("wait") or {}
    if not wait.get("workflow_id") and not wait.get("expires_at") and not wait.get("ended"):
        return WaitInfo(state="none")
    if wait.get("ended"):
        return WaitInfo(state="ended")
    ends: datetime | None = None
    try:
        ends = datetime.fromisoformat(wait["expires_at"]) if wait.get("expires_at") else None
    except (TypeError, ValueError):
        ends = None
    if ends is None:
        return WaitInfo(state="open")
    left = int((ends - now).total_seconds())
    if left <= 0:
        return WaitInfo(state="ended")
    return WaitInfo(state="open", ends_at=ends, seconds_left=left)


def _text(value: Any) -> str | None:
    return roadmap._text(value)


def _milestone(value: Any) -> ReviewMilestone | None:
    if isinstance(value, dict):
        date = value.get("date")
        return ReviewMilestone(name=_text(value.get("name")), date=str(date) if date else None)
    name = _text(value)
    return ReviewMilestone(name=name) if name else None


def _rank(item: dict[str, Any]) -> int | None:
    priority = item.get("priority")
    rank = priority.get("rank") if isinstance(priority, dict) else None
    return rank if isinstance(rank, int) and not isinstance(rank, bool) else None


def _answers(action: ReviewAction, reason: dict[str, Any]) -> bool:
    """A staged action answers a reason it names, every reason of its item when it names
    none, and a waiver answers them all. Questions answer nothing."""
    if action.state != "staged" or action.kind == "question":
        return False
    return action.kind == "waive" or not action.answers or reason["code"] in action.answers


async def read(
    db: AsyncSession, principal: Principal, run_id: uuid.UUID, checkpoint_id: uuid.UUID
) -> CheckpointReview:
    """The checkpoint's shared draft, as the caller may use it; reasons as of now."""
    run = await service._get_run(db, run_id)
    cp = await db.scalar(
        select(Checkpoint).where(Checkpoint.id == checkpoint_id, Checkpoint.run_id == run.id)
    )
    if cp is None:
        raise service.NotFound(f"checkpoint {checkpoint_id} not found")
    found = await _file(db, run, cp)
    rows = (
        await db.scalars(
            select(CheckpointAction)
            .where(CheckpointAction.checkpoint_id == cp.id)
            .order_by(CheckpointAction.created_at, CheckpointAction.id)
        )
    ).all()
    question_ids = [r.question_id for r in rows if r.question_id]
    questions = {
        q.id: q
        for q in await db.scalars(
            select(StakeholderQuestion).where(StakeholderQuestion.id.in_(question_ids))
        )
    }
    answers: dict[uuid.UUID, StakeholderAnswer] = {}
    for a in await db.scalars(
        select(StakeholderAnswer)
        .where(StakeholderAnswer.question_id.in_(question_ids))
        .order_by(StakeholderAnswer.created_at)
    ):
        answers[a.question_id] = a  # the latest wins
    ids = [r.created_by for r in rows] + [r.updated_by for r in rows]
    ids += [q.asked_to for q in questions.values()]
    ids += [a.answered_by for a in answers.values()]
    people = await _people(db, [i for i in ids if i])

    def named(i: uuid.UUID | None) -> ReviewAnswerer | None:
        if i is None:
            return None
        p = people.get(i)
        return ReviewAnswerer(id=i, name=p.name if p else "Someone")

    def question_of(row: CheckpointAction) -> ReviewQuestion | None:
        q = questions.get(row.question_id) if row.question_id else None
        if q is None:
            return None
        a = answers.get(q.id)
        answer = (
            ReviewAnswer(kind=a.kind, body=a.body, answered_by=named(a.answered_by)) if a else None
        )
        return ReviewQuestion(
            id=q.id, status=q.status, text=q.prompt, asked_to=named(q.asked_to), answer=answer
        )

    by_item: dict[str, list[ReviewAction]] = {}
    for r in rows:
        by_item.setdefault(r.item_key, []).append(
            ReviewAction(
                id=r.id,
                item_key=r.item_key,
                kind=r.kind,
                field=r.field,
                value=r.value,
                answers=list(r.answers or []),
                state=r.state,  # type: ignore[arg-type]
                note=r.note,
                created_by=people.get(r.created_by) if r.created_by else None,
                updated_by=people.get(r.updated_by) if r.updated_by else None,
                updated_at=r.updated_at,
                question=question_of(r),
            )
        )

    checked = found.checked if found else None
    file_items = checked.check.items if checked else []
    all_reasons = checked.reasons if checked else []
    reasons_of: dict[str, list[dict[str, Any]]] = {}
    for reason in all_reasons:
        reasons_of.setdefault(reason["item"], []).append(reason)
    titles = {r["item"]: r.get("item_title") for r in all_reasons}

    tally = ReviewTally()
    waiting: dict[uuid.UUID, WaitingOn] = {}
    items: list[ReviewItem] = []
    seen: set[str] = set()
    keys: list[tuple[str, int | None, dict[str, Any]]] = []
    for n, item in enumerate(file_items):
        if item["id"] not in seen:
            seen.add(item["id"])
            keys.append((item["id"], n + 1, item))
    for key in [*reasons_of, *by_item]:
        if key not in seen:
            seen.add(key)
            keys.append((key, None, {}))
    for key, position, item in keys:
        mine = by_item.get(key, [])
        found_reasons = reasons_of.get(key, [])
        open_reasons = [x for x in found_reasons if not any(_answers(a, x) for a in mine)]
        asked = [a for a in mine if a.question is not None and a.question.status in OPEN_QUESTIONS]
        for a in asked:
            to = a.question.asked_to if a.question else None
            if to is not None and to.id is not None:
                row = waiting.setdefault(to.id, WaitingOn(user_id=to.id, name=to.name, count=0))
                row.count += 1
        if not found_reasons:
            state = "fine"
        elif not open_reasons:
            state = "handled"
        elif asked:
            state = "waiting"
        else:
            state = "needs_you"
        tally.need_you += state == "needs_you"
        tally.handled += state == "handled"
        tally.blocking_open += sum(1 for x in open_reasons if x["severity"] == reasons.BLOCKING)
        tally.to_confirm_open += sum(1 for x in open_reasons if x["severity"] == reasons.CONFIRM)
        tally.suggested += sum(1 for a in mine if a.state == "suggested")
        depends = item.get("depends_on")
        items.append(
            ReviewItem(
                key=key,
                position=position,
                title=_text(item.get("title")) or titles.get(key) or None,
                horizon=_text(item.get("horizon")),
                milestone=_milestone(item.get("milestone")),
                confidence=_text(item.get("confidence")),
                rank=_rank(item),
                outcome=_text(item.get("outcome")),
                depends_on=[d for d in depends if isinstance(d, str)]
                if isinstance(depends, list)
                else [],
                prd_section=_text(item.get("prd_section")),
                reasons=[ItemReason(**x) for x in found_reasons],
                actions=mine,
                state=state,  # type: ignore[arg-type]
            )
        )
    tally.waiting_on = list(waiting.values())

    pending = cp.status == "pending"
    stages = pending and _stages(principal, cp) and not principal.read_only
    attempt = (cp.payload or {}).get("attempt")
    problems = checked.check.problems if checked else []
    return CheckpointReview(
        checkpoint_id=cp.id,
        run_id=run.id,
        kind=cp.kind,  # type: ignore[arg-type]
        status=cp.status,  # type: ignore[arg-type]
        approver_role=cp.approver_role,
        attempt=attempt if isinstance(attempt, int) else None,
        revision=cp.draft_revision or 0,
        wait=wait_info(cp.payload, service._now()),
        file=ReviewFile(name=found.name, seq=found.seq) if found and found.checked else None,
        file_problems=[ItemsProblem(**p) for p in problems if not p.get("item")],
        items=items,
        tally=tally,
        note=cp.draft_note,
        can_read=True,
        can_suggest=pending
        and has_role(principal.role, "commenter")  # type: ignore[arg-type]
        and not principal.read_only,
        can_stage=stages,
        can_decide=stages,
    )
