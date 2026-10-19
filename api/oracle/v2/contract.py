"""The versioned semantic module contract (§4.2) and its applicability expression.

Validation only. Deciding whether a module applies (evaluating a :data:`Condition`
against composition inputs) is the modules lane's job (``oracle/modules/``).

The applicability expression is a typed tree, never code: ``and`` / ``or`` / ``not`` /
``at_least`` (k of n), ``present`` / ``absent``, and typed comparisons (``eq``, ``ne``,
``lt``, ``lte``, ``gt``, ``gte``, ``in``, ``contains``) of a dotted input path against a
literal. Paths start at one of :data:`CONDITION_ROOTS`. Depth and size are bounded.

    {"op": "and", "args": [
        {"op": "present", "path": "scope.tenants"},
        {"op": "gte", "path": "signals.tenant_count", "value": 2}]}
"""

import hashlib
import json
import re
from typing import Annotated, Any, Literal, Union

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictFloat,
    StrictInt,
    StrictStr,
    ValidationError,
    model_validator,
)

SEMVER_PATTERN = r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$"
# "goals.outcomes", "constraints.solutions", "ai_agent.tool-policies".
MODULE_ID_PATTERN = r"^[a-z][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*)*$"
# Template section ids, as in a heading's {#id}.
SECTION_ID_PATTERN = r"^[a-z0-9][a-z0-9._-]*$"
SLUG_PATTERN = r"^[a-z0-9][a-z0-9._-]*$"
FIELD_KEY_PATTERN = r"^[a-z][a-z0-9_]*$"
PATH_PATTERN = r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$"

# What a condition may read: the composition inputs (oracle.v2.schemas.CompositionInputs).
CONDITION_ROOTS = (
    "brief",
    "category",
    "scope",
    "signals",
    "baseline",
    "sources",
    "stakeholders",
    "outputs",
    "blockers",
    "policy",
    "template",
)
MAX_CONDITION_DEPTH = 12
MAX_CONDITION_NODES = 200
MAX_PATH_SEGMENTS = 8
MAX_IN_VALUES = 100
MAX_PATTERN_LENGTH = 500

ModulePolicy = Literal["required", "conditional", "optional"]
ReviewRole = Literal["viewer", "commenter", "approver", "owner"]
OutputKind = Literal[
    "prd",
    "roadmap",
    "tech_brief",
    "engineering_spec",
    "user_flow",
    "wireframe",
    "prototype",
    "acceptance_tests",
]
EvidencePolicy = Literal[
    # O1c: evidence lives in the Sources and data points appendix, never the body.
    "record_provenance_in_appendix",
    "required",
    "optional",
    "none",
]
ApprovalPolicy = Literal["decider", "any_approver", "all_assigned"]
Category = Literal[
    "customer_user",
    "pain_evidence",
    "goal_alignment",
    "success_metric",
    "differentiation",
    "alternatives",
    "constraints",
    "blockers",
    "economic_benefit",
    "effort_cost",
    "security_privacy",
    "ownership",
    "non_goals",
    "release_rollout",
    "evaluation_criteria",
    "third_party_policy",
    "configurability_scaling",
]

# Typed literals: no coercion, so "2" is never compared as 2.
Scalar = Annotated[StrictStr, Field(max_length=500)] | StrictInt | StrictFloat | StrictBool
Number = StrictInt | StrictFloat
Path = Annotated[str, Field(pattern=PATH_PATTERN, max_length=200)]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


# --- the applicability expression -------------------------------------------------------


class _PathNode(_Strict):
    path: Path

    @model_validator(mode="after")
    def _known_root(self):
        parts = self.path.split(".")
        if parts[0] not in CONDITION_ROOTS:
            raise ValueError(
                f"path must start with one of {', '.join(CONDITION_ROOTS)}; got {parts[0]!r}"
            )
        if len(parts) > MAX_PATH_SEGMENTS:
            raise ValueError(f"path has more than {MAX_PATH_SEGMENTS} segments")
        return self


class Always(_Strict):
    op: Literal["true", "false"]


class AllOf(_Strict):
    op: Literal["and", "or"]
    args: list["Condition"] = Field(min_length=1, max_length=50)


class Not(_Strict):
    op: Literal["not"]
    arg: "Condition"


class AtLeast(_Strict):
    """Threshold over conditions: true when at least ``count`` of ``args`` hold."""

    op: Literal["at_least"]
    count: int = Field(ge=1)
    args: list["Condition"] = Field(min_length=1, max_length=50)

    @model_validator(mode="after")
    def _count_fits(self):
        if self.count > len(self.args):
            raise ValueError("count is larger than the number of args")
        return self


class Presence(_PathNode):
    """The input exists and is not empty (``present``), or the opposite (``absent``)."""

    op: Literal["present", "absent"]


class Equality(_PathNode):
    op: Literal["eq", "ne"]
    value: Scalar


class Ordering(_PathNode):
    """Numeric threshold: ``signals.tenant_count >= 2``."""

    op: Literal["lt", "lte", "gt", "gte"]
    value: Number


class Membership(_PathNode):
    """``in``: the input is one of ``values``; ``contains``: the input list holds ``value``."""

    op: Literal["in"]
    values: list[Scalar] = Field(min_length=1, max_length=MAX_IN_VALUES)

    @model_validator(mode="after")
    def _one_type(self):
        kinds = {_kind(v) for v in self.values}
        if len(kinds) > 1:
            raise ValueError("values must all have the same type")
        return self


class Contains(_PathNode):
    op: Literal["contains"]
    value: Scalar


def _kind(value: Any) -> str:
    if isinstance(value, bool):
        return "bool"
    if isinstance(value, int | float):
        return "number"
    return "str"


Condition = Annotated[
    Union[Always, AllOf, Not, AtLeast, Presence, Equality, Ordering, Membership, Contains],  # noqa: UP007
    Field(discriminator="op"),
]
for _model in (AllOf, Not, AtLeast):
    _model.model_rebuild()

ALWAYS = Always(op="true")


def condition_stats(node: BaseModel, depth: int = 1) -> tuple[int, int]:
    """(max depth, node count) of a condition tree."""
    children: list[BaseModel] = []
    if isinstance(node, AllOf | AtLeast):
        children = list(node.args)
    elif isinstance(node, Not):
        children = [node.arg]
    deepest, count = depth, 1
    for child in children:
        d, c = condition_stats(child, depth + 1)
        deepest, count = max(deepest, d), count + c
    return deepest, count


def condition_paths(node: BaseModel) -> set[str]:
    """Every input path a condition reads."""
    if isinstance(node, _PathNode):
        return {node.path}
    if isinstance(node, AllOf | AtLeast):
        return set().union(*(condition_paths(a) for a in node.args))
    if isinstance(node, Not):
        return condition_paths(node.arg)
    return set()


def _check_bounds(condition: BaseModel) -> None:
    depth, count = condition_stats(condition)
    if depth > MAX_CONDITION_DEPTH:
        raise ValueError(f"condition is nested deeper than {MAX_CONDITION_DEPTH}")
    if count > MAX_CONDITION_NODES:
        raise ValueError(f"condition has more than {MAX_CONDITION_NODES} nodes")


class ConditionDoc(_Strict):
    """A standalone condition (for validating one outside a contract)."""

    condition: Condition

    @model_validator(mode="after")
    def _bounded(self):
        _check_bounds(self.condition)
        return self


def parse_condition(data: Any) -> BaseModel:
    """Validate a condition tree; raises ``pydantic.ValidationError``."""
    return ConditionDoc.model_validate({"condition": data}).condition


# --- the module contract ----------------------------------------------------------------

FieldType = Literal[
    "text", "markdown", "number", "integer", "boolean", "date", "enum", "list", "reference"
]
ReferenceType = Literal[
    "goal",
    "product",
    "feature",
    "requirement",
    "constraint",
    "decision",
    "person",
    "outcome",
    "acceptance_criterion",
    "assumption",
    "risk",
]


class FieldDefinition(_Strict):
    """A reusable, typed field a module collects (e.g. a metric with a baseline)."""

    key: Annotated[str, Field(pattern=FIELD_KEY_PATTERN, max_length=64)]
    label: Annotated[str, Field(min_length=1, max_length=200)]
    type: FieldType
    required: bool = False
    help: Annotated[str, Field(max_length=2000)] | None = None
    # enum: the allowed values.
    options: list[Annotated[str, Field(max_length=200)]] = Field(default=[], max_length=100)
    # list: the item type.
    item_type: FieldType | None = None
    # reference: the baseline entity type it points at.
    reference_type: ReferenceType | None = None

    @model_validator(mode="after")
    def _type_details(self):
        if self.type == "enum" and not self.options:
            raise ValueError(f"field {self.key!r}: an enum needs options")
        if self.type != "enum" and self.options:
            raise ValueError(f"field {self.key!r}: only an enum has options")
        if self.type == "list" and self.item_type in (None, "list"):
            raise ValueError(f"field {self.key!r}: a list needs a non-list item_type")
        if self.type != "list" and self.item_type is not None:
            raise ValueError(f"field {self.key!r}: only a list has an item_type")
        if (self.type == "reference" or self.item_type == "reference") != (
            self.reference_type is not None
        ):
            raise ValueError(f"field {self.key!r}: reference_type goes with type reference")
        return self


ValidatorKind = Literal[
    "required", "min_length", "max_length", "pattern", "min", "max", "one_of", "requires_evidence"
]


class FieldValidator(_Strict):
    """A declarative check on a field's value; no code."""

    kind: ValidatorKind
    field: Annotated[str, Field(pattern=FIELD_KEY_PATTERN, max_length=64)]
    value: Scalar | list[Scalar] | None = None
    message: Annotated[str, Field(max_length=500)] | None = None

    @model_validator(mode="after")
    def _value_fits(self):
        k, v = self.kind, self.value
        if k in ("required", "requires_evidence"):
            if v is not None:
                raise ValueError(f"{k} takes no value")
        elif k in ("min_length", "max_length"):
            if not isinstance(v, int) or isinstance(v, bool) or v < 0:
                raise ValueError(f"{k} needs a non-negative integer")
        elif k in ("min", "max"):
            if not isinstance(v, int | float) or isinstance(v, bool):
                raise ValueError(f"{k} needs a number")
        elif k == "one_of":
            if not isinstance(v, list) or not v:
                raise ValueError("one_of needs a non-empty list")
        elif k == "pattern":
            if not isinstance(v, str) or len(v) > MAX_PATTERN_LENGTH:
                raise ValueError(f"pattern needs a string of at most {MAX_PATTERN_LENGTH}")
            try:
                re.compile(v)
            except re.error as e:
                raise ValueError(f"pattern does not compile: {e}") from None
        return self


class QuestionPrompt(_Strict):
    """A question the module asks when its information is missing (§5)."""

    key: Annotated[str, Field(pattern=FIELD_KEY_PATTERN, max_length=64)]
    prompt: Annotated[str, Field(min_length=1, max_length=1000)]
    category: Category
    importance: Literal["critical", "high", "medium", "low"] = "medium"
    # The fields an answer fills.
    fills: list[Annotated[str, Field(pattern=FIELD_KEY_PATTERN)]] = []
    # Ask only when this holds; default always.
    when: Condition | None = None


class AgentInstruction(_Strict):
    """Versioned instructions for one agent role working on the module (§8)."""

    role: Annotated[str, Field(pattern=SLUG_PATTERN, max_length=64)]
    instructions: Annotated[str, Field(min_length=1, max_length=8000)]


class EvidenceExpectations(_Strict):
    min_sources: StrictInt = Field(default=0, ge=0, le=50)
    source_kinds: list[Annotated[str, Field(pattern=SLUG_PATTERN)]] = []
    # Older evidence is flagged as possibly stale.
    max_age_days: int | None = Field(default=None, ge=1)
    # Fields whose claims need evidence or a confirmed assumption.
    fields: list[Annotated[str, Field(pattern=FIELD_KEY_PATTERN)]] = []


class ModuleContract(_Strict):
    """One release of a semantic module. Stored in ``module_versions.contract``."""

    # Stable semantic id and release.
    id: Annotated[str, Field(pattern=MODULE_ID_PATTERN, max_length=100)]
    version: Annotated[str, Field(pattern=SEMVER_PATTERN)]
    title: Annotated[str, Field(min_length=1, max_length=200)]
    description: Annotated[str, Field(max_length=4000)] | None = None
    # Pack ids, e.g. "startup.standard", "ai-agent.platform".
    applies_to: list[Annotated[str, Field(pattern=MODULE_ID_PATTERN)]] = []
    # Selection: required, conditional (needs a condition) or optional.
    policy: ModulePolicy
    # Applicability (typed tree); default always.
    condition: Condition = ALWAYS
    # Prerequisites and mutual exclusions (module ids).
    depends_on: list[Annotated[str, Field(pattern=MODULE_ID_PATTERN)]] = []
    conflicts_with: list[Annotated[str, Field(pattern=MODULE_ID_PATTERN)]] = []
    # Ordering: a default position plus hard constraints relative to other modules.
    display_order: int = Field(default=100, ge=0, le=10_000)
    order_after: list[Annotated[str, Field(pattern=MODULE_ID_PATTERN)]] = []
    order_before: list[Annotated[str, Field(pattern=MODULE_ID_PATTERN)]] = []
    # Reusable typed fields and declarative validators over them.
    fields: list[FieldDefinition] = Field(default=[], max_length=100)
    validators: list[FieldValidator] = Field(default=[], max_length=200)
    # Illustrative JSON-Schema form (§4.2 example); ``fields`` is the typed form.
    fields_schema: dict[str, Any] | None = None
    question_prompts: list[QuestionPrompt] = Field(default=[], max_length=50)
    # Drafting guidance, and per-agent-role instructions.
    instructions: Annotated[str, Field(max_length=8000)] = ""
    agent_instructions: list[AgentInstruction] = Field(default=[], max_length=20)
    evidence_policy: EvidencePolicy = "record_provenance_in_appendix"
    evidence_expectations: EvidenceExpectations = EvidenceExpectations()
    # The document sections ({#id}) it renders; default: the id with dots as dashes.
    section_ids: list[Annotated[str, Field(pattern=SECTION_ID_PATTERN, max_length=100)]] = []
    # Brief/full presentation mapping (O1f): which layers, and which sections are brief.
    brief_layer: bool = True
    full_layer: bool = True
    brief_section_ids: list[Annotated[str, Field(pattern=SECTION_ID_PATTERN)]] = []
    # Ownership and approval.
    owner_role: Annotated[str, Field(pattern=SLUG_PATTERN, max_length=64)] = "product"
    required_review_role: ReviewRole = "approver"
    approval_policy: ApprovalPolicy = "decider"
    # Outputs it feeds, and which of its fields or sections feed each.
    outputs: list[OutputKind] = Field(default=["prd"], min_length=1)
    output_mappings: dict[OutputKind, list[Annotated[str, Field(pattern=SLUG_PATTERN)]]] = {}

    @model_validator(mode="after")
    def _consistent(self):  # noqa: C901 - one list of rules reads best here
        problems: list[str] = []
        if self.policy == "conditional" and self.condition == ALWAYS:
            problems.append("a conditional module needs a condition")
        if self.policy != "conditional" and self.condition != ALWAYS:
            problems.append("only a conditional module has a condition")
        _check_bounds(self.condition)
        refs = (
            ("depends_on", self.depends_on),
            ("conflicts_with", self.conflicts_with),
            ("order_after", self.order_after),
            ("order_before", self.order_before),
        )
        for name, ids in refs:
            if self.id in ids:
                problems.append(f"{name} names the module itself")
            if len(set(ids)) != len(ids):
                problems.append(f"{name} has duplicates")
        if both := set(self.depends_on) & set(self.conflicts_with):
            problems.append(f"depends on and conflicts with {sorted(both)}")
        if both := set(self.order_after) & set(self.order_before):
            problems.append(f"ordered both before and after {sorted(both)}")
        keys = [f.key for f in self.fields]
        if len(set(keys)) != len(keys):
            problems.append("field keys must be unique")
        known = set(keys)
        for v in self.validators:
            if v.field not in known:
                problems.append(f"validator {v.kind} names unknown field {v.field!r}")
        for q in self.question_prompts:
            if unknown := set(q.fills) - known:
                problems.append(f"question {q.key!r} fills unknown fields {sorted(unknown)}")
            if q.when is not None:
                _check_bounds(q.when)
        if len({q.key for q in self.question_prompts}) != len(self.question_prompts):
            problems.append("question keys must be unique")
        if unknown := set(self.evidence_expectations.fields) - known:
            problems.append(f"evidence_expectations names unknown fields {sorted(unknown)}")
        roles = [a.role for a in self.agent_instructions]
        if len(set(roles)) != len(roles):
            problems.append("one instruction per agent role")
        if not (self.brief_layer or self.full_layer):
            problems.append("a module renders in the brief layer, the full layer, or both")
        if len(set(self.section_ids)) != len(self.section_ids):
            problems.append("section_ids has duplicates")
        if self.brief_section_ids:
            if not self.brief_layer:
                problems.append("brief_section_ids needs brief_layer")
            if extra := set(self.brief_section_ids) - set(self.effective_section_ids()):
                problems.append(f"brief_section_ids not in section_ids: {sorted(extra)}")
        if extra := set(self.output_mappings) - set(self.outputs):
            problems.append(f"output_mappings for outputs not listed: {sorted(extra)}")
        mappable = known | set(self.effective_section_ids())
        for out, targets in self.output_mappings.items():
            if unknown := set(targets) - mappable:
                problems.append(f"output_mappings[{out}] names unknown {sorted(unknown)}")
        if self.fields_schema is not None and self.fields_schema.get("type") != "object":
            problems.append('fields_schema must be a JSON Schema with "type": "object"')
        if len(set(self.outputs)) != len(self.outputs):
            problems.append("outputs has duplicates")
        if problems:
            raise ValueError("; ".join(problems))
        return self

    def effective_section_ids(self) -> list[str]:
        return self.section_ids or [self.id.replace(".", "-")]


def validate_contract(data: Any) -> ModuleContract:
    """Validate a contract (dict or JSON text); raises ``pydantic.ValidationError``."""
    if isinstance(data, str | bytes):
        return ModuleContract.model_validate_json(data)
    return ModuleContract.model_validate(data)


def contract_json(contract: ModuleContract) -> dict[str, Any]:
    """The stored form (``module_versions.contract``)."""
    return contract.model_dump(mode="json")


def contract_hash(contract: ModuleContract) -> str:
    """sha256 of the canonical JSON: equal contracts hash equal (``contract_hash``)."""
    canonical = json.dumps(contract_json(contract), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


def semver_key(version: str) -> tuple[int, int, int]:
    """Sort key for a release version; raises ``ValueError`` when it is not semver."""
    if not re.match(SEMVER_PATTERN, version):
        raise ValueError(f"not a semantic version: {version!r}")
    major, minor, patch = version.split(".")
    return int(major), int(minor), int(patch)


__all__ = [
    "ALWAYS",
    "CONDITION_ROOTS",
    "Condition",
    "FieldDefinition",
    "FieldValidator",
    "ModuleContract",
    "QuestionPrompt",
    "ValidationError",
    "condition_paths",
    "condition_stats",
    "contract_hash",
    "contract_json",
    "parse_condition",
    "semver_key",
    "validate_contract",
]
