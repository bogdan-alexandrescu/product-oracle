"""The typed changes a discussion ends in (G1 3.3): the registry G3 Outcome extraction and
G4 One staging list build on.

One entry per kind: its payload model, the subjects it may appear on, its action verb and
the lowest role that acts on it (``suggest``: commenters suggest it for an approver to
stage, c6), where it lands, and ``available``, false until the pick that applies it has
landed. Oracle is only ever offered the kinds available for the subject (G3). In G1 the
changes are listed read-only, so no kind is available yet.
"""

import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from oracle.discussions.models import CHANGE_KINDS, SUBJECT_KINDS

Text = Field(min_length=1, max_length=2000)


class _Payload(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class SectionEdit(_Payload):
    section_key: str = Field(min_length=1, max_length=200)
    instruction: str = Text
    text: str | None = Field(default=None, max_length=20000)


class GoalMeasure(_Payload):
    entity_id: uuid.UUID
    metric: str | None = Field(default=None, max_length=200)
    unit: str | None = Field(default=None, max_length=50)
    target: float | str | None = None
    horizon: str | None = Field(default=None, max_length=100)
    owner_id: uuid.UUID | None = None
    weight: float | None = None


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
    rationale: str = Text
    category: str = Field(min_length=1, max_length=100)


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
SHARED_DRAFT = "the checkpoint's shared draft"


def _list(values: list[str]) -> str:
    return ", ".join(values)


def _dependency(p: dict[str, Any]) -> str:
    if p.get("remove"):
        return f"Remove {p['item_key']}'s dependency on {_list(p['remove'])}"
    return f"Make {p['item_key']} depend on {_list(p.get('add') or [])}"


def _requirement(p: dict[str, Any]) -> str:
    what = p.get("text") or p.get("requirement_id") or ""
    return f"{p['op'].capitalize()} requirement: {what}"


def _measure(p: dict[str, Any]) -> str:
    parts = [p.get("metric") or "a metric"]
    if p.get("target") is not None:
        parts.append(f"to {p['target']}")
    if p.get("horizon"):
        parts.append(f"by {p['horizon']}")
    return f"Make {p['entity_id']} measurable: {' '.join(parts)}"


_KINDS = [
    Kind("section_edit", SectionEdit, ("document", "section"), "Stage", "approver",
         "the document's next draft",
         lambda p: f"Change {p['section_key']}: {p['instruction']}",
         suggest=True, available=_landed),
    Kind("goal_measure", GoalMeasure, ("entity", "intake", "gap"), "Propose", "commenter",
         "a baseline proposal", _measure, available=_landed),
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
    Kind("ask_person", AskPerson, SUBJECT_KINDS, "Ask", "commenter",
         "a question asked of that person", lambda p: f"Ask {p['asked_to']}: {p['prompt']}"),
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
         lambda p: f"{p['decision'].capitalize()} {p['feature_id']}: {p['reason']}",
         suggest=True),
    Kind("scope_requirement", ScopeRequirement, SCOPE_SUBJECTS, "Stage", "approver",
         "the feature set at its checkpoint", _requirement, suggest=True),
    Kind("priority_move", PriorityMove, PRIORITY_SUBJECTS, "Apply", "approver",
         "the priority order",
         lambda p: f"Move {p['feature_id']} above {p['above_feature_id']}: {p['reason']}",
         suggest=True),
    Kind("priority_pin", PriorityPin, PRIORITY_SUBJECTS, "Apply", "approver",
         "the priority order",
         lambda p: f"Pin {p['feature_id']} at #{p['position']}: {p['reason']}", suggest=True),
]  # fmt: skip
REGISTRY: dict[str, Kind] = {k.name: k for k in _KINDS}
assert tuple(REGISTRY) == CHANGE_KINDS


def validate_payload(kind: str, payload: dict[str, Any]) -> dict[str, Any]:
    """The payload as its kind's model reads it (``pydantic.ValidationError`` if it does not)."""
    model = REGISTRY[kind].payload.model_validate(payload)
    return model.model_dump(mode="json", by_alias=True, exclude_none=True)


def label(kind: str, payload: dict[str, Any]) -> str:
    """The plain sentence a change reads as ("Move R-1 to Next")."""
    return REGISTRY[kind].label(payload)


def schema_of(kind: str) -> dict[str, Any]:
    """The payload's JSON schema, as the prompt and the Propose a change form read it."""
    return REGISTRY[kind].payload.model_json_schema(by_alias=True)


def available_for(subject_kind: str, db: Any = None) -> list[str]:
    """The kinds Oracle may be offered on a subject now (G3)."""
    return [k.name for k in _KINDS if subject_kind in k.subjects and k.available(db)]
