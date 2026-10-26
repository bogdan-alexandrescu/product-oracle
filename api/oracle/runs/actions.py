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

import logging
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, company_time
from oracle.auth.deps import Principal
from oracle.auth.models import ApiToken, User
from oracle.authz import has_role
from oracle.docs.models import Document, DocumentVersion
from oracle.engineering import check as eng_check
from oracle.engineering import dates as eng_dates
from oracle.members.leads import (
    ENGINEERING_KINDS,
    LEAD_ONLY,
    engineering_leads,
    lead_refusal,
    lead_stop,
    may_decide,
)
from oracle.members.names import display_name
from oracle.models import AuditEvent
from oracle.runs import batch, gate, reasons, roadmap, service
from oracle.runs.models import ACTION_KINDS, Checkpoint, CheckpointAction, Run, RunSegment
from oracle.runs.schemas import (
    ActionIn,
    CheckpointReview,
    ConsoleAnswer,
    FieldDiff,
    InboxChild,
    InboxChildReason,
    InboxSource,
    InboxSummary,
    ItemReason,
    ItemsAttemptDiff,
    ItemsProblem,
    ReasonFix,
    ResolutionEntry,
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
    "eng_dates": "Engineering dates",
    "roadmap_items": "roadmap items",
    "roadmap_review": "roadmap review",
    "request_triage": "request triage",
    "strategy_review": "strategy review",
    "launch_review": "launch review",
}

log = logging.getLogger(__name__)


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
        _question(body)
    elif body.kind == "waive":
        _waive_reason(body)


def _question(body: ActionIn) -> None:
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


def _waive_reason(body: ActionIn) -> None:
    reason = body.value.get("reason") if isinstance(body.value, dict) else None
    if not isinstance(reason, str) or not reason.strip() or len(reason) > WAIVE_REASON:
        raise InvalidAction("waive needs a reason")


# C7 Scope review: the fields an edit of a scope row may change.
SCOPE_FIELDS = ("decision", "text", "acceptance", "goals", "depends_on", "blocker_keys")
SCOPE_DECISIONS = ("include", "exclude", "defer", "keep", "cut")


def _feature_set(body: ActionIn, ctx: ValidationContext) -> None:
    """C7 Scope review on the scope's rows (keys of its features and requirements): an
    ``edit`` of one field, an ``add`` of a requirement (``{parent, text, acceptance}``),
    an ``accept`` of a reason to confirm, a ``waive`` of a blocking one (D3), a
    ``question``. A commenter's is a suggestion; an approver's Accept applies an edit or
    an add to the row (oracle.runs.scope_review.apply_action)."""
    if body.kind not in ("edit", "add", "accept", "waive", "question"):
        raise InvalidAction(f"{body.kind} does not apply to a feature set")
    if body.item_key not in ctx.item_keys | {WHOLE_FILE}:
        raise InvalidAction(f"{body.item_key} is not a row of the feature set")
    v = body.value
    if body.kind == "waive":
        _waive_reason(body)
    elif body.kind == "edit":
        if body.field not in SCOPE_FIELDS:
            raise InvalidAction("edit changes one of " + ", ".join(SCOPE_FIELDS))
        if body.field == "decision":
            d = v.get("decision") if isinstance(v, dict) else v
            if d not in SCOPE_DECISIONS:
                raise InvalidAction('decision is {"decision": include|exclude|defer|keep|cut}')
        elif body.field == "text" and (not isinstance(v, str) or not v.strip() or len(v) > 1000):
            raise InvalidAction("text is a string of 1 to 1000 characters")
        elif body.field in ("acceptance", "depends_on", "blocker_keys") and _ids(v) is None:
            raise InvalidAction(f"{body.field} is a list of strings")
        elif body.field == "goals" and not isinstance(v, list):
            raise InvalidAction('goals is [{"goal_id": id, "contribution": 0-3}]')
    elif body.kind == "add":
        text = v.get("text") if isinstance(v, dict) else None
        if not isinstance(text, str) or not text.strip() or len(text) > 1000:
            raise InvalidAction('add is {"parent": feature key, "text": 1 to 1000 characters}')
    elif body.kind == "question":
        _question(body)


def _eng_review(body: ActionIn, ctx: ValidationContext) -> None:
    """F4 Engineering check: a verdict, a size or an answer per feature, or a question."""
    asked = {k: set(v.get("questions") or ()) for k, v in ctx.items.items()}
    try:
        eng_check.validate(body.kind, body.item_key, body.field, body.value, ctx.item_keys, asked)
    except eng_check.Invalid as exc:
        raise InvalidAction(str(exc)) from None
    if body.kind == "question":
        _question(body)


def _eng_dates(body: ActionIn, ctx: ValidationContext) -> None:
    """F4 Engineering dates: accept, change or No date per Now item, or a question."""
    try:
        eng_dates.validate(body.kind, body.item_key, body.field, body.value, ctx.items)
    except eng_dates.Invalid as exc:
        raise InvalidAction(str(exc)) from None
    if body.kind == "question":
        _question(body)


LOOK_AGAIN_NOTE = 2000


def _baseline_confirm(body: ActionIn, ctx: ValidationContext) -> None:
    """B2 Baseline review from this run: on a row of the run (``<type>:<key>``), Look again
    (``{"note"}``) or, on a goal of the run, Leave proposed (a ``waive`` with a reason).
    Every other change is a baseline write, applied at once through the baseline routes."""
    if body.kind not in ("look_again", "waive"):
        raise InvalidAction(
            f"{body.kind} does not apply to the baseline: confirm, reject, edit or merge it "
            "through the baseline"
        )
    if body.item_key not in ctx.item_keys:
        raise InvalidAction(f"{body.item_key} is not an item from this run")
    if body.kind == "waive":
        if (ctx.items.get(body.item_key) or {}).get("type") != "goal":
            raise InvalidAction("only a goal from this run is left proposed")
        _waive_reason(body)
        return
    v = body.value if isinstance(body.value, dict) else {}
    note = v.get("note")
    if (
        body.field is not None
        or set(v) != {"note"}
        or not isinstance(note, str)
        or not note.strip()
        or len(note) > LOOK_AGAIN_NOTE
    ):
        raise InvalidAction(f"look_again needs a note of 1 to {LOOK_AGAIN_NOTE} characters")


# The spec owning each checkpoint kind registers its vocabulary here.
VOCABULARY: dict[str, Validator] = {
    "roadmap_items": _roadmap_items,
    "feature_set": _feature_set,
    "eng_review": _eng_review,
    "eng_dates": _eng_dates,
    "baseline_confirm": _baseline_confirm,
}


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
    segment = await batch.once(
        ("segment", run.id, seq),
        lambda: db.scalar(
            select(RunSegment).where(RunSegment.run_id == run.id, RunSegment.seq == seq)
        ),
    )
    text = ((segment.artifacts or {}).get("files") or {}).get(name) if segment else None
    if not isinstance(text, str):
        return _File(seq, name, None)
    attempt = (cp.payload or {}).get("attempt")
    prior = await service.prior_review(
        db, run, segment, attempt if isinstance(attempt, int) else None
    )
    return _File(seq, name, await service.checked_items(db, run, text, prior))


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


async def _baseline_context(db: AsyncSession, run: Run) -> ValidationContext:
    """B2: the run's baseline rows (``<type>:<key>``), each with its type."""
    from oracle.baseline import from_run

    found = await from_run.members(db, run.id)
    items = {from_run.item_key(e): {"type": e.type} for e in found.entities.values()}
    return ValidationContext(item_keys=frozenset(items), items=items)


def _gate_context(cp: Checkpoint) -> ValidationContext:
    """A kind with no item file: its items are those its approve gate's reasons name (the
    Engineering check: its briefs' features, with their question ids)."""
    if cp.kind == eng_check.KIND:
        asked = eng_check.questions(cp)
        return ValidationContext(
            item_keys=eng_check.item_keys(cp),
            items={k: {"questions": sorted(v)} for k, v in asked.items()},
        )
    if cp.kind == eng_dates.KIND:
        items = eng_dates.items_of(cp)
        return ValidationContext(item_keys=frozenset(items), items=items)
    source = gate.BLOCKING_SOURCES.get(cp.kind)
    reasons = source.read(cp)[0] if source is not None else []
    return ValidationContext(item_keys=frozenset(r["item"] for r in reasons))


async def _scope_context(db: AsyncSession, cp: Checkpoint) -> ValidationContext:
    """C7: a feature-set checkpoint's items are its scope's rows (and what its stored
    check names, for a run from before scopes)."""
    from oracle.runs import feature_set

    keys = set(_gate_context(cp).item_keys)
    scope = await service._scope_of(db, cp)
    if scope is not None:
        keys |= {i.key for i in await feature_set.scope_items(db, scope.id)}
    return ValidationContext(item_keys=frozenset(keys))


# --------------------------------------------------------------------------- writes


@dataclass(frozen=True)
class ActionSource:
    """Where an action came from when a discussion staged it (G4): the discussion, its
    change and whether the discussion was private as it was staged."""

    discussion_id: uuid.UUID
    change_id: uuid.UUID
    from_private: bool


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
    if stage and await _by_lead(db, run, cp):
        # F4: with an engineering lead named, its leads and owners stage at its stops.
        if not await _may_stage(db, principal, run, cp):
            raise service.Forbidden(LEAD_ONLY)
        refusal = await lead_refusal(db, principal)
        if refusal is not None:
            raise service.Forbidden(refusal)
    else:
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


async def _by_lead(db: AsyncSession, run: Run, cp: Checkpoint) -> bool:
    """Whether the stop waits for the engineering leads and owners (F4, A3's rule)."""
    if cp.kind not in ENGINEERING_KINDS:
        return False
    return lead_stop(cp.kind, run.flow, await engineering_leads(db))


async def _may_stage(db: AsyncSession, principal: Principal, run: Run, cp: Checkpoint) -> bool:
    """Who stages (and so decides): A3's ``may_decide`` at an engineering stop, else the
    checkpoint's role floor."""
    if cp.kind in ENGINEERING_KINDS:
        return may_decide(principal, cp, run.flow, await engineering_leads(db))
    return _stages(principal, cp)


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
    *,
    source: ActionSource | None = None,
    suggest_only: bool = False,
) -> CheckpointAction:
    """Stage (the approver role or above) or suggest (commenters, or ``suggest_only``) one
    action: one per item, kind and field, so the same again replaces it. ``source``: the
    discussion change it comes from (G4), whose status follows the action."""
    from oracle.auth.service import caller_refusal
    from oracle.staging import hooks

    run, cp = await _writable(db, principal, run_id, checkpoint_id, stage=False)
    found = await _file(db, run, cp) if cp.kind in VOCABULARY else None
    if cp.kind == "baseline_confirm":
        ctx = await _baseline_context(db, run)
    elif cp.kind in ITEM_FILES:
        ctx = _context(found)
    elif cp.kind == "feature_set":
        ctx = await _scope_context(db, cp)
    else:
        ctx = _gate_context(cp)
    try:
        validate(cp.kind, body, ctx)
    except InvalidAction as exc:
        raise service.Invalid(str(exc)) from None
    leads = await engineering_leads(db) if cp.kind in ENGINEERING_KINDS else frozenset()
    by_lead = lead_stop(cp.kind, run.flow, leads)
    # F4: with an engineering lead named, the leads and owners stage at its stops; anyone
    # else's choice is a suggestion (c6).
    may_stage = may_decide(principal, cp, run.flow, leads) if by_lead else _stages(principal, cp)
    stages = may_stage and not suggest_only
    if body.kind == "waive":
        _waivable(cp, body, found, stages)
        if cp.kind == "roadmap_items" and OWNER_WAIVES & set(body.answers):
            # H4 §5: only an owner waives a planned item the strategy stops.
            if not has_role(principal.role, "owner"):
                raise service.Forbidden(OWNER_WAIVES_TEXT)
            refusal = await caller_refusal(db, principal, "owner")
            if refusal is not None:
                raise service.Forbidden(refusal)
    if stages:
        # A staged action counts: the approver role (or the flag), re-read under the gate.
        refusal = (
            await lead_refusal(db, principal)
            if by_lead
            else await caller_refusal(db, principal, cp.approver_role)  # type: ignore[arg-type]
        )
        if refusal is not None:
            raise service.Forbidden(refusal)
    field = body.field
    if body.kind == "waive" and cp.kind == "roadmap_items":
        # An owner's waiver of Stopped in the strategy is its own action (gate.OWNER_WAIVES).
        field = gate.OWNER_WAIVE_FIELD if OWNER_WAIVES & set(body.answers) else None
    existing = await db.scalar(
        select(CheckpointAction).where(
            CheckpointAction.checkpoint_id == cp.id,
            CheckpointAction.item_key == body.item_key,
            CheckpointAction.kind == body.kind,
            func.coalesce(CheckpointAction.field, "") == (field or ""),
        )
    )
    if existing is not None and not may_stage and existing.created_by != principal.id:
        raise service.Forbidden("Only its author or an approver can change this action")
    replaced = existing.discussion_change_id if existing is not None else None
    if stages and source is None and cp.kind == "feature_set" and body.kind in ("edit", "add"):
        return await _apply_now(db, principal, run, cp, body, existing, replaced)
    question_id = None
    if body.kind == "question":
        if existing is not None:
            await _withdraw(db, principal, existing.question_id)
        question_id = await _ask(db, principal, run, cp, body, ctx)
    answers = list(body.answers)
    if body.kind == "waive" and existing is not None and existing.state == "staged":
        # A waiver answers only the reasons it names: waiving another reason of the item
        # adds it to the waiver before (naming none covers them all).
        answers = [*existing.answers, *(a for a in answers if a not in existing.answers)]
        answers = answers if existing.answers and body.answers else []
    action = existing or CheckpointAction(
        checkpoint_id=cp.id, item_key=body.item_key, kind=body.kind, field=field
    )
    action.value = body.value
    action.answers = answers
    action.note = (body.note or "").strip() or None
    action.state = "staged" if stages else "suggested"
    action.question_id = question_id
    # Staging again replaces the action: its author is who wrote it now.
    action.created_by = principal.id
    action.updated_by = principal.id
    action.origin = "discussion" if source else "row"
    action.discussion_id = source.discussion_id if source else None
    action.discussion_change_id = source.change_id if source else None
    action.from_private = source.from_private if source else False
    if existing is None:
        db.add(action)
    await db.flush()
    if replaced is not None and replaced != action.discussion_change_id:
        await hooks.replaced(db, replaced)
    event = STAGED if stages else SUGGESTED
    await _bump(db, principal, run, cp, event, body.item_key, _snapshot(action))
    await db.commit()
    return action


async def _apply_now(
    db: AsyncSession,
    principal: Principal,
    run: Run,
    cp: Checkpoint,
    body: ActionIn,
    existing: CheckpointAction | None,
    replaced: uuid.UUID | None,
) -> CheckpointAction:
    """C7: an approver's own ``edit`` or ``add`` on a feature-set row is applied to the
    scope at once, as the approver's (Approve and Send back read the rows); nothing is
    staged, and a suggestion in the same slot goes. Returns the action, not stored."""
    from oracle.runs import scope_review
    from oracle.staging import hooks

    try:
        await scope_review.apply_change(
            db, principal, cp, body.item_key, body.kind, body.field, body.value
        )
    except service.RunError:
        await db.rollback()
        raise
    if existing is not None:
        await db.delete(existing)
        await db.flush()
    if replaced is not None:
        await hooks.replaced(db, replaced)
    action = CheckpointAction(
        id=uuid.uuid4(), checkpoint_id=cp.id, item_key=body.item_key, kind=body.kind,
        field=body.field, value=body.value, state="staged", created_by=principal.id,
    )  # fmt: skip
    await _bump(db, principal, run, cp, STAGED, body.item_key, _snapshot(action))
    await db.commit()
    return action


# H4 §5 Waive: Stopped in the strategy is an owner's to waive.
OWNER_WAIVES = gate.OWNER_WAIVES
OWNER_WAIVES_TEXT = "Only an owner waives an item the product strategy stops"


def _waivable(cp: Checkpoint, body: ActionIn, found: _File | None, stages: bool) -> None:
    """D3: a waiver is the approver's (a commenter cannot even suggest one), and never of
    a date reason or a problem of the whole file."""
    file_codes = {
        p["code"]
        for p in (found.checked.check.problems if found and found.checked else [])
        if not p.get("item")
    }
    if body.item_key == WHOLE_FILE or any(a in file_codes for a in body.answers):
        raise service.Invalid(gate.FILE_NOT_WAIVED)
    if any(not gate.waivable(cp.kind, a) for a in body.answers):
        raise service.Invalid(gate.BLOCKING_SOURCES[cp.kind].refusal)
    if not stages:
        raise service.Forbidden(f"Only the {cp.approver_role} role or above waives a problem")


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
    from oracle.runs import scope_review

    snapshot = _snapshot(action)
    try:
        applied = await scope_review.apply_action(db, principal, cp, action)
    except service.RunError:
        await db.rollback()
        raise
    if applied:
        # C7: a suggested edit or add is now the row's, as the approver's; the action goes.
        await _bump(db, principal, run, cp, STAGED, action.item_key, snapshot)
        await db.commit()
        return
    action.state = "staged"
    action.updated_by = principal.id
    await db.flush()
    if action.discussion_change_id is not None:
        from oracle.staging import hooks

        await hooks.staged(db, action)
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
        if not await _may_stage(db, principal, run, cp):
            raise service.Forbidden("Only its author or an approver can undo this action")
        refusal = (
            await lead_refusal(db, principal)
            if await _by_lead(db, run, cp)
            else await caller_refusal(db, principal, cp.approver_role)  # type: ignore[arg-type]
        )
        if refusal is not None:
            raise service.Forbidden(refusal)
    await _withdraw(db, principal, action.question_id)
    if action.discussion_change_id is not None:
        from oracle.staging import hooks

        await hooks.removed(db, action.discussion_change_id)
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
        out[user.id] = ReviewPerson(
            id=user.id, name=display_name(user.email, user.name), role=user.role
        )
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


async def _sent_yaml(db: AsyncSession, cp: Checkpoint) -> str | None:
    from oracle.runs import review_file

    if cp.status == "pending" or not cp.review or cp.review.get("kind") == "edits":
        return None
    zone = await company_time.company_time_zone(db)
    return review_file.render_yaml(cp.review, cp.decided_at, zone)


def _answers(action: ReviewAction, reason: dict[str, Any]) -> bool:
    """A staged action answers a reason it names and every reason of its item when it
    names none, but for a waiver naming none: never one only an owner waives (H4 §5).
    Questions answer nothing."""
    if action.state != "staged" or action.kind == "question":
        return False
    if action.answers:
        return reason["code"] in action.answers
    return action.kind != "waive" or reason["code"] not in OWNER_WAIVES


async def _actions(db: AsyncSession, checkpoint_ids: list[uuid.UUID]) -> list[CheckpointAction]:
    return list(
        await db.scalars(
            select(CheckpointAction)
            .where(CheckpointAction.checkpoint_id.in_(checkpoint_ids))
            .order_by(CheckpointAction.created_at, CheckpointAction.id)
        )
    )


async def read_ahead(db: AsyncSession, cps: list[Checkpoint], runs: dict[uuid.UUID, Run]) -> None:
    """In one Inbox call (oracle.runs.batch): the checkpoints' segments and draft actions in
    two reads, and their items' traces together (oracle.runs.reasons.read_ahead), for their
    reviews to share."""
    seqs = {
        (c.run_id, s)
        for c in cps
        if c.kind in ITEM_FILES and isinstance(s := (c.payload or {}).get("segment_seq"), int)
    }
    if not seqs:
        return
    found = {
        (s.run_id, s.seq): s
        for s in await db.scalars(
            select(RunSegment).where(RunSegment.run_id.in_({r for r, _ in seqs}))
        )
    }
    for key in seqs:
        batch.put(("segment", *key), found.get(key))
    rows = await _actions(db, [c.id for c in cps if c.kind in ITEM_FILES])
    for c in cps:
        batch.put(("actions", c.id), [r for r in rows if r.checkpoint_id == c.id])
    runs_items = []
    for c in cps:
        name, seq = ITEM_FILES.get(c.kind), (c.payload or {}).get("segment_seq")
        segment = found.get((c.run_id, seq)) if name else None
        text = ((segment.artifacts or {}).get("files") or {}).get(name) if segment else None
        if isinstance(text, str):
            check = await service.items_check(db, runs[c.run_id], text)
            runs_items.append((runs[c.run_id], check.items))
    try:
        # As each review's own reasons (service.checked_items): an error here loses only
        # the read ahead; each review then reads its own, in its savepoint.
        async with db.begin_nested():
            await reasons.read_ahead(db, runs_items)
    except Exception:  # noqa: BLE001 - the read ahead never fails the Inbox
        log.exception("the Inbox could not read its checkpoints' traces ahead")


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
    return await _read(db, principal, run, cp)


async def _read(
    db: AsyncSession, principal: Principal, run: Run, cp: Checkpoint
) -> CheckpointReview:
    found = await _file(db, run, cp)
    rows = await batch.once(("actions", cp.id), lambda: _actions(db, [cp.id]))
    question_ids = [r.question_id for r in rows if r.question_id]
    questions: dict[uuid.UUID, StakeholderQuestion] = {}
    answers: dict[uuid.UUID, StakeholderAnswer] = {}
    if question_ids:
        questions = {
            q.id: q
            for q in await db.scalars(
                select(StakeholderQuestion).where(StakeholderQuestion.id.in_(question_ids))
            )
        }
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

    resolution = checked.resolution if checked else None
    attempt_diff = checked.diff if checked else None
    answered: dict[str, ResolutionEntry] = {}
    for e in (resolution or {}).get("entries") or []:
        answered.setdefault(e["id"], ResolutionEntry(**e))
    changed = {
        d["id"]: [FieldDiff(**c) for c in d["changes"]]
        for d in (attempt_diff or {}).get("items") or []
    }

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
                resolution=answered.get(key),
                diff=changed.get(key, []),
            )
        )
    tally.waiting_on = list(waiting.values())
    live = None
    if cp.kind == "baseline_confirm":
        items, tally, live = await _baseline_items(db, run, by_item)

    pending = cp.status == "pending"
    stages = pending and await _may_stage(db, principal, run, cp) and not principal.read_only
    attempt = (cp.payload or {}).get("attempt")
    problems = checked.check.problems if checked else []
    staged = [r for r in rows if r.state == "staged"]
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
        sent_review=cp.review
        if cp.status != "pending" and (cp.review or {}).get("kind") != "edits"
        else None,
        sent_review_yaml=await _sent_yaml(db, cp),
        can_read=True,
        can_suggest=pending
        and has_role(principal.role, "commenter")  # type: ignore[arg-type]
        and not principal.read_only,
        can_stage=stages,
        can_decide=stages,
        gate=gate.approve_gate(cp, live, staged) if pending else None,
        diff=ItemsAttemptDiff(**attempt_diff) if attempt_diff else None,
    )


async def _baseline_items(
    db: AsyncSession, run: Run, by_item: dict[str, list[ReviewAction]]
) -> tuple[list[ReviewItem], ReviewTally, list[dict[str, Any]]]:
    """B2: a Confirm the baseline checkpoint's items are the run's baseline rows (the same
    code as GET /v1/baseline/from-run), its tally and the gate's live reasons."""
    from oracle.baseline import from_run

    built = await from_run.build(db, run.id, [a for acts in by_item.values() for a in acts])
    tally = ReviewTally()
    items: list[ReviewItem] = []
    live: list[dict[str, Any]] = []
    for row in built.rows:
        open_reasons = [
            r for r in row.reasons if not any(from_run._answers(a, r) for a in row.actions)
        ]
        tally.need_you += row.state == "needs_you"
        tally.handled += row.state == "handled"
        if row.state == "needs_you":
            tally.blocking_open += sum(1 for r in open_reasons if r.severity == gate.BLOCKING)
            tally.to_confirm_open += sum(1 for r in open_reasons if r.severity != gate.BLOCKING)
        tally.suggested += sum(1 for a in row.actions if a.state == "suggested")
        live += [r.model_dump() for r in row.reasons if r.code == from_run.GOAL_UNDECIDED]
        items.append(
            ReviewItem(
                key=row.key,
                title=row.entity.title,
                reasons=row.reasons,
                actions=row.actions,
                state=row.state,
                baseline=row,
            )
        )
    return items, tally, live


# --------------------------------------------------------------------------- inbox (D9)

# Child rows under a checkpoint's Inbox row.
INBOX_CHILDREN = 3
_SEVERITY = {reasons.BLOCKING: 0, reasons.CONFIRM: 1}


def _determined(kind: str, field_: str | None, value: Any) -> bool:
    """A safe fix (D9): it only stages, needs no text and one click undoes it: accept, a
    horizon, Remove date, removing dependencies, an order."""
    if kind == "accept":
        return True
    if kind != "edit":
        return False
    if field_ == "horizon":
        return value in HORIZONS
    if field_ == "milestone_date":
        return value is None
    if field_ == "depends_on":
        return isinstance(value, dict) and set(value) == {"remove"} and bool(_ids(value["remove"]))
    if field_ == "order":
        after = value.get("after") if isinstance(value, dict) and set(value) == {"after"} else None
        return value is None or (isinstance(after, str) and bool(after))
    return False


def safe_fix(item: str, fixes: list[ReasonFix] | list[dict[str, Any]]) -> ReasonFix | None:
    """The first of a reason's fixes the Inbox offers in one click: safe, and on its item."""
    for raw in fixes:
        f = raw if isinstance(raw, ReasonFix) else ReasonFix.model_validate(raw)
        a = f.action
        if a.item == item and _determined(a.kind, a.field, a.value):
            return f
    return None


def _first(found: list[ItemReason]) -> ItemReason:
    return sorted(found, key=lambda r: _SEVERITY.get(r.severity, 0))[0]


def summarize(review: CheckpointReview) -> InboxSummary:
    """The Inbox's projection of a roadmap items review: its tally and the child rows. A
    child is an item still needing the caller, with its first open reason; an item fixed
    earlier (handled) never takes a slot. Blocking first, then in position order."""
    rows: list[tuple[tuple[int, int], InboxChild]] = []
    for it in review.items:
        if not it.reasons or it.state != "needs_you":
            continue
        shown = _first(
            [r for r in it.reasons if not any(_answers(a, r.model_dump()) for a in it.actions)]
        )
        suggested = next(
            (a for a in it.actions if a.state == "suggested" and a.kind != "question"), None
        )
        child = InboxChild(
            item=it.key,
            title=it.title,
            reason=InboxChildReason(
                code=shown.code, severity=shown.severity, label=shown.label, text=shown.text
            ),
            fix=safe_fix(it.key, shown.fixes),
            suggested=suggested,
        )
        order = (_SEVERITY.get(shown.severity, 0), it.position or 10**6)
        rows.append((order, child))
    rows.sort(key=lambda r: r[0])
    shown_rows = rows[:INBOX_CHILDREN]
    tally = review.tally
    return InboxSummary(
        need_you=tally.need_you,
        blocking=tally.blocking_open,
        to_confirm=tally.to_confirm_open,
        handled=tally.handled,
        waiting_on=sum(1 for i in review.items if i.state == "waiting"),
        wait=review.wait,
        children=[c for _, c in shown_rows],
        more=tally.need_you - len(shown_rows),
    )


async def _roadmap_items(
    db: AsyncSession, principal: Principal, run: Run, cp: Checkpoint
) -> InboxSummary:
    summary = summarize(await _read(db, principal, run, cp))
    if run.document_id is not None:
        document_id = run.document_id
        summary.title = await batch.once(
            ("document_title", document_id),
            lambda: db.scalar(select(Document.title).where(Document.id == document_id)),
        )
    source_id = service._source_id(run)
    source = await service._version_source(db, source_id) if source_id else None
    if source is not None:
        summary.source = InboxSource(title=source.title, version=source.version)
    return summary


async def _baseline_confirm_summary(
    db: AsyncSession, principal: Principal, run: Run, cp: Checkpoint
) -> InboxSummary:
    """B2: Confirm the baseline's Inbox counts, read from the run's baseline rows."""
    from oracle.baseline import from_run

    review = await _read(db, principal, run, cp)
    rows = [i.baseline for i in review.items if i.baseline is not None]
    return InboxSummary(**from_run.row_tally(rows), wait=review.wait)


Summary = Callable[[AsyncSession, Principal, Run, Checkpoint], Any]
# checkpoint kind -> its Inbox summary; the spec owning a kind's review registers it here.
SUMMARIES: dict[str, Summary] = {
    "roadmap_items": _roadmap_items,
    "baseline_confirm": _baseline_confirm_summary,
}


async def inbox_summary(
    db: AsyncSession,
    cp: Checkpoint,
    principal: Principal,
    *,
    run: Run,
    console: ConsoleAnswer | None = None,
) -> InboxSummary | None:
    """A pending checkpoint's Inbox counts (D9), one review read; None for a kind without a
    summary. ``console_held``: a console approval waiting for Confirm while blocking reasons
    are open (D3: recorded, not followed). Until D3's gate lands it is judged by the
    summary's open blocking reasons, so a kind without a summary is never held."""
    found = SUMMARIES.get(cp.kind)
    if found is None:
        return None
    summary: InboxSummary = await found(db, principal, run, cp)
    summary.console_held = bool(console and console.needs == "confirm" and summary.blocking)
    return summary
