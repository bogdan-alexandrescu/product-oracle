"""The typed changes a discussion ends in (G1 3.3): the registry G3 Outcome extraction and
G4 One staging list build on.

One entry per kind: its payload model, the subjects it may appear on, its action verb and
the lowest role that acts on it (``suggest``: commenters suggest it for an approver to
stage, c6), where it lands, and ``available``, false until the pick that applies it has
landed. Oracle is only ever offered the kinds available for the subject (G3). In G1 the
changes are listed read-only; ``goal_measure`` is available since B6 Goals interview
(oracle.baseline.goal_interview proposes it). Since C2 Questions, C6 and C7 Scope and C8 and
C9 Priorities landed, every kind is: Ask through C2, scope changes staged at the feature-set
stop, moves and pins applied through C9. ``decision`` is H1 Decision log's entry point: a
discussion proposes a decision.
"""

import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from oracle.baseline import goals
from oracle.discussions.models import CHANGE_KINDS, SUBJECT_KINDS

Text = Field(min_length=1, max_length=2000)


class _Payload(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class SectionEdit(_Payload):
    section_key: str = Field(min_length=1, max_length=200)
    instruction: str = Text
    text: str | None = Field(default=None, max_length=20000)


class GoalMeasure(_Payload):
    """A measurable version of a goal (B6): B5 Typed goal fields' fields, ``owner`` as
    ``owner_id``. Oracle's never carry ``owner_id`` or ``weight`` (:func:`goal_measure`)."""

    entity_id: uuid.UUID
    metric: str | None = Field(default=None, min_length=3, max_length=200)
    unit: str | None = Field(default=None, max_length=50)
    comparison: Literal["at_least", "above", "at_most", "below"] | None = None
    target: float | None = None
    start: float | None = None
    horizon: Literal["short", "medium", "long"] | None = None
    due: date | None = None
    owner_id: uuid.UUID | None = None
    weight: float | None = Field(default=None, gt=0, le=10)


# The goal attrs a goal_measure payload sets (payload key -> attrs key).
GOAL_FIELDS = {
    "metric": "metric", "unit": "unit", "comparison": "comparison", "target": "target",
    "start": "start", "horizon": "horizon", "due": "due", "owner_id": "owner",
    "weight": "weight",
}  # fmt: skip
# Ranking and ownership are a person's call (B6 3.1 (6)).
PEOPLE_ONLY = ("owner_id", "weight")


class EntityEdit(_Payload):
    entity_id: uuid.UUID
    field: str = Field(min_length=1, max_length=100)
    value: Any = Field(...)


class ConflictPick(_Payload):
    conflict_id: uuid.UUID
    claim_index: int = Field(ge=0)
    reason: str = Text


class Answer(_Payload):
    question_id: uuid.UUID
    body: str = Text


class AskPerson(_Payload):
    asked_to: uuid.UUID
    prompt: str = Text
    rationale: str | None = Field(default=None, max_length=500)
    category: str = Field(default="general", min_length=1, max_length=100)


class BasisRecord(_Payload):
    prd_document_id: uuid.UUID
    kind: str = Field(min_length=1, max_length=50)
    reference: str = Text
    supports_date: date
    item_key: str | None = None
    tracker_key: str | None = None
    detail: str | None = Field(default=None, max_length=2000)


ItemKey = Field(min_length=1, max_length=200)


class ItemHorizon(_Payload):
    item_key: str = ItemKey
    horizon: Literal["now", "next", "later"]


class ItemOutcome(_Payload):
    item_key: str = ItemKey
    outcome: str = Text


class ItemDrop(_Payload):
    item_key: str = ItemKey
    reason: str = Text


class ItemDependency(_Payload):
    item_key: str = ItemKey
    add: list[str] = Field(default_factory=list)
    remove: list[str] = Field(default_factory=list)


class ItemDateRemove(_Payload):
    item_key: str = ItemKey


class ItemSplit(_Payload):
    item_key: str = ItemKey
    into: list[str] = Field(min_length=2)


class ItemMerge(_Payload):
    item_key: str = ItemKey
    with_: list[str] = Field(alias="with", min_length=1)


class ScopeFeature(_Payload):
    feature_id: uuid.UUID
    decision: Literal["include", "exclude", "defer"]
    reason: str = Text


class ScopeRequirement(_Payload):
    op: Literal["add", "enhance", "cut"]
    requirement_id: uuid.UUID | None = None
    # The feature a new requirement belongs to (``add``); the subject's item when absent.
    feature_id: uuid.UUID | None = None
    text: str | None = Field(default=None, max_length=2000)
    goal_id: uuid.UUID | None = None


class PriorityMove(_Payload):
    feature_id: uuid.UUID
    above_feature_id: uuid.UUID
    reason: str = Text


class PriorityPin(_Payload):
    feature_id: uuid.UUID
    position: int = Field(ge=1)
    reason: str = Text


class DecisionOptionIn(_Payload):
    key: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$")
    label: str = Field(min_length=1, max_length=200)
    summary: str | None = Field(default=None, max_length=1000)


class DecisionProposal(_Payload):
    """H1 Decision log's entry point: what a discussion proposes to decide. ``approver_id``:
    who decides it (the person proposing, when an approver, if none is named)."""

    title: str = Field(min_length=1, max_length=200)
    question: str | None = Field(default=None, max_length=1000)
    options: list[DecisionOptionIn] = Field(default_factory=list, max_length=6)
    approver_id: uuid.UUID | None = None
    reversibility: Literal["reversible", "irreversible"] = "reversible"


def _not_yet(_db: Any) -> bool:
    """The pick that applies the kind has not landed."""
    return False


def _landed(_db: Any) -> bool:
    """G3: the path that applies the kind exists (G4 staging, baseline proposals, conflict
    resolution, answers)."""
    return True


@dataclass(frozen=True)
class Kind:
    name: str
    payload: type[_Payload]
    subjects: tuple[str, ...]
    # What acting on it is called, and the lowest role that does it.
    verb: str
    role: Literal["commenter", "approver"]
    # Where acting on it lands.
    lands_in: str
    label: Callable[[dict[str, Any]], str]
    # Commenters suggest it; an approver stages it (c6).
    suggest: bool = False
    available: Callable[[Any], bool] = _not_yet


ITEM_SUBJECTS = ("checkpoint_item", "roadmap_item")
SCOPE_SUBJECTS = ("intake", "document", "checkpoint_item", "entity")
PRIORITY_SUBJECTS = ("priorities", "checkpoint_item")
# The subjects C2 asks a question about (oracle.intake.schemas.QuestionSubject); a gap's is
# its intake.
ASK_SUBJECTS = ("section", "checkpoint_item", "entity", "intake", "gap")
SHARED_DRAFT = "the checkpoint's shared draft"


def _list(values: list[str]) -> str:
    return ", ".join(values)


def _dependency(p: dict[str, Any]) -> str:
    if p.get("remove"):
        return f"Remove {p['item_key']}'s dependency on {_list(p['remove'])}"
    return f"Make {p['item_key']} depend on {_list(p.get('add') or [])}"


def _requirement(p: dict[str, Any]) -> str:
    what = p.get("text") or p.get("title") or p.get("requirement_id") or ""
    return f"{p['op'].capitalize()} requirement: {what}"


def _named(p: dict[str, Any], key: str, title: str = "title") -> Any:
    """A feature's or person's name from the target (``title``), else its id."""
    return p.get(title) or p[key]


def _measure(p: dict[str, Any]) -> str:
    """Reads "Make Cut early churn measurable: less than 8% by Jun 30"."""
    if p.get("comparison") in goals.COMPARISONS and p.get("target") is not None and p.get("unit"):
        what = goals.comparison_words(p["comparison"], float(p["target"]), p["unit"])
    else:
        what = p.get("metric") or "a metric"
        if p.get("target") is not None:
            what += f" to {p['target']}"
    due = p.get("due")
    if due:
        day = due if isinstance(due, date) else date.fromisoformat(str(due))
        what += f" by {day:%b} {day.day}"
    elif p.get("horizon"):
        what += f" within the {p['horizon']} horizon"
    return f"Make {p.get('title') or p['entity_id']} measurable: {what}"


_KINDS = [
    Kind("section_edit", SectionEdit, ("document", "section"), "Stage", "approver",
         "the document's next draft",
         lambda p: f"Change {p['section_key']}: {p['instruction']}",
         suggest=True, available=_landed),
    Kind("goal_measure", GoalMeasure, ("entity", "intake", "gap"), "Propose", "commenter",
         "a baseline proposal", _measure, available=lambda _db: True),
    Kind("entity_edit", EntityEdit, ("entity", "conflict"), "Propose", "commenter",
         "a baseline proposal",
         lambda p: f"Change {p['entity_id']}'s {p['field']} to {p['value']}",
         available=_landed),
    Kind("conflict_pick", ConflictPick, ("conflict",), "Resolve", "approver",
         "the conflict's resolution",
         lambda p: f"Resolve the conflict: keep claim {p['claim_index'] + 1}",
         available=_landed),
    Kind("answer", Answer, SUBJECT_KINDS, "Use as answer", "approver", "the question's answer",
         lambda p: f"Answer: {p['body']}", available=_landed),
    Kind("ask_person", AskPerson, ASK_SUBJECTS, "Ask", "commenter",
         "a question asked of that person",
         lambda p: f"Ask {_named(p, 'asked_to', 'asked_name')}: {p['prompt']}",
         available=_landed),
    Kind("basis_record", BasisRecord, ("roadmap_item", "checkpoint_item", "track"), "Record",
         "approver", "a schedule basis",
         lambda p: f"Record a date basis: {p['reference']} supports {p['supports_date']}",
         available=_landed),
    Kind("item_horizon", ItemHorizon, ITEM_SUBJECTS, "Stage", "approver", SHARED_DRAFT,
         lambda p: f"Move {p['item_key']} to {p['horizon'].capitalize()}",
         suggest=True, available=_landed),
    Kind("item_outcome", ItemOutcome, ITEM_SUBJECTS, "Stage", "approver", SHARED_DRAFT,
         lambda p: f"Change {p['item_key']}'s outcome to {p['outcome']}",
         suggest=True, available=_landed),
    Kind("item_drop", ItemDrop, ITEM_SUBJECTS, "Stage", "approver", SHARED_DRAFT,
         lambda p: f"Drop {p['item_key']}: {p['reason']}",
         suggest=True, available=_landed),
    Kind("item_dependency", ItemDependency, ITEM_SUBJECTS, "Stage", "approver", SHARED_DRAFT,
         _dependency,
         suggest=True, available=_landed),
    Kind("item_date_remove", ItemDateRemove, ITEM_SUBJECTS, "Stage", "approver", SHARED_DRAFT,
         lambda p: f"Remove {p['item_key']}'s date",
         suggest=True, available=_landed),
    Kind("item_split", ItemSplit, ("checkpoint_item",), "Stage", "approver", SHARED_DRAFT,
         lambda p: f"Split {p['item_key']} into {_list(p['into'])}", available=_landed),
    Kind("item_merge", ItemMerge, ("checkpoint_item",), "Stage", "approver", SHARED_DRAFT,
         lambda p: f"Merge {p['item_key']} with {_list(p['with'])}", available=_landed),
    Kind("scope_feature", ScopeFeature, SCOPE_SUBJECTS, "Stage", "approver",
         "the feature set at its checkpoint",
         lambda p: f"{p['decision'].capitalize()} {_named(p, 'feature_id')}: {p['reason']}",
         suggest=True, available=_landed),
    Kind("scope_requirement", ScopeRequirement, SCOPE_SUBJECTS, "Stage", "approver",
         "the feature set at its checkpoint", _requirement, suggest=True, available=_landed),
    Kind("priority_move", PriorityMove, PRIORITY_SUBJECTS, "Apply", "approver",
         "the priority order",
         lambda p: (f"Move {_named(p, 'feature_id')} above "
                    f"{_named(p, 'above_feature_id', 'above_title')}: {p['reason']}"),
         suggest=True, available=_landed),
    Kind("priority_pin", PriorityPin, PRIORITY_SUBJECTS, "Apply", "approver",
         "the priority order",
         lambda p: f"Pin {_named(p, 'feature_id')} at #{p['position']}: {p['reason']}",
         suggest=True, available=_landed),
    Kind("decision", DecisionProposal, SUBJECT_KINDS, "Propose", "commenter",
         "a proposed decision in the decision log", lambda p: f"Decide: {p['title']}",
         available=_landed),
]  # fmt: skip
REGISTRY: dict[str, Kind] = {k.name: k for k in _KINDS}
assert tuple(REGISTRY) == CHANGE_KINDS


def validate_payload(kind: str, payload: dict[str, Any]) -> dict[str, Any]:
    """The payload as its kind's model reads it (``pydantic.ValidationError`` if it does not)."""
    model = REGISTRY[kind].payload.model_validate(payload)
    return model.model_dump(mode="json", by_alias=True, exclude_none=True)


def label(kind: str, payload: dict[str, Any], target: dict[str, Any] | None = None) -> str:
    """The plain sentence a change reads as ("Move R-1 to Next"); a ``title`` in its
    target names what it changes ("Make Cut early churn measurable: ...")."""
    if target:
        names = {k: target[k] for k in ("title", "above_title", "asked_name") if target.get(k)}
        payload = {**names, **payload}
    return REGISTRY[kind].label(payload)


def goal_attrs(payload: dict[str, Any]) -> dict[str, Any]:
    """The goal attrs a goal_measure payload sets."""
    return {a: payload[k] for k, a in GOAL_FIELDS.items() if payload.get(k) is not None}


def goal_measure(payload: dict[str, Any], proposed_by_kind: str) -> dict[str, Any]:
    """A goal_measure payload as stored: Oracle's cut down to the fields it may propose,
    refused by B5's checks on its own fields (``goals.GoalFieldsError``) or by the kind's
    model (``pydantic.ValidationError``)."""
    if proposed_by_kind == "oracle":
        payload = {k: v for k, v in payload.items() if k not in PEOPLE_ONLY}
    found = goals.field_problems(goal_attrs(payload))
    if found:
        raise goals.GoalFieldsError(found)
    return validate_payload("goal_measure", payload)


def schema_of(kind: str) -> dict[str, Any]:
    """The payload's JSON schema, as the prompt and the Propose a change form read it."""
    return REGISTRY[kind].payload.model_json_schema(by_alias=True)


def available_for(subject_kind: str, db: Any = None) -> list[str]:
    """The kinds Oracle may be offered on a subject now (G3)."""
    return [k.name for k in _KINDS if subject_kind in k.subjects and k.available(db)]
