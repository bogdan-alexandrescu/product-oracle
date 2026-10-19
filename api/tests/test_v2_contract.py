"""The semantic module contract (§4.2) and its applicability expression: validation only."""

import copy

import pytest
from pydantic import ValidationError

from oracle.v2.contract import (
    ALWAYS,
    MAX_CONDITION_DEPTH,
    ModuleContract,
    condition_paths,
    contract_hash,
    contract_json,
    parse_condition,
    semver_key,
    validate_contract,
)

# The illustrative example of the build prompt, §4.2, verbatim.
EXAMPLE = {
    "id": "constraints.solutions",
    "version": "1.0.0",
    "title": "Constraints, Blockers & Solution Strategy",
    "applies_to": ["startup.standard", "ai-agent.platform"],
    "policy": "required",
    "condition": {"op": "true"},
    "depends_on": ["goals.outcomes"],
    "conflicts_with": [],
    "display_order": 60,
    "fields_schema": {"type": "object", "properties": {}},
    "instructions": (
        "Identify and prioritize current/potential limitations, evidence, viable solutions, "
        "feasibility tests, fallbacks, scaling triggers and ownership."
    ),
    "evidence_policy": "record_provenance_in_appendix",
    "brief_layer": True,
    "full_layer": True,
    "required_review_role": "approver",
    "outputs": ["prd"],
}

# Every field of the true schema, filled in (synthetic placeholders only).
FULL = {
    "id": "platform.tenant-isolation",
    "version": "2.1.0",
    "title": "Multi-tenant isolation",
    "description": "How customer data and configuration stay separate.",
    "applies_to": ["ai-agent.platform"],
    "policy": "conditional",
    "condition": {
        "op": "and",
        "args": [
            {"op": "present", "path": "scope.tenants"},
            {"op": "gte", "path": "signals.tenant_count", "value": 2},
            {"op": "not", "arg": {"op": "eq", "path": "category", "value": "internal_tool"}},
            {
                "op": "at_least",
                "count": 1,
                "args": [
                    {"op": "in", "path": "policy.data_class", "values": ["restricted", "secret"]},
                    {"op": "contains", "path": "outputs", "value": "engineering_spec"},
                ],
            },
        ],
    },
    "depends_on": ["goals.outcomes", "requirements.functional"],
    "conflicts_with": ["platform.single-tenant"],
    "display_order": 75,
    "order_after": ["requirements.functional"],
    "order_before": ["risks.register"],
    "fields": [
        {
            "key": "isolation_model",
            "label": "Isolation model",
            "type": "enum",
            "options": ["shared", "pooled", "dedicated"],
            "required": True,
        },
        {"key": "max_tenants", "label": "Planned tenants", "type": "integer"},
        {
            "key": "owners",
            "label": "Owners",
            "type": "list",
            "item_type": "reference",
            "reference_type": "person",
        },
        {"key": "notes", "label": "Notes", "type": "markdown"},
    ],
    "validators": [
        {"kind": "required", "field": "isolation_model"},
        {"kind": "min", "field": "max_tenants", "value": 1},
        {"kind": "pattern", "field": "notes", "value": "^[^<>]*$", "message": "no HTML"},
        {"kind": "one_of", "field": "isolation_model", "value": ["pooled", "dedicated"]},
        {"kind": "requires_evidence", "field": "max_tenants"},
    ],
    "question_prompts": [
        {
            "key": "isolation",
            "prompt": "How must customer data be separated?",
            "category": "security_privacy",
            "importance": "critical",
            "fills": ["isolation_model"],
            "when": {"op": "absent", "path": "baseline.isolation_decision"},
        },
    ],
    "instructions": "Draft the isolation requirements; do not invent customer names.",
    "agent_instructions": [
        {"role": "prd-section-drafter", "instructions": "Write testable requirements."},
        {"role": "independent-prd-critic", "instructions": "Look for leakage paths."},
    ],
    "evidence_policy": "required",
    "evidence_expectations": {
        "min_sources": 1,
        "source_kinds": ["github", "notion"],
        "max_age_days": 180,
        "fields": ["max_tenants"],
    },
    "section_ids": ["tenant-isolation", "tenant-isolation-detail"],
    "brief_layer": True,
    "full_layer": True,
    "brief_section_ids": ["tenant-isolation"],
    "owner_role": "engineering",
    "required_review_role": "approver",
    "approval_policy": "all_assigned",
    "outputs": ["prd", "engineering_spec"],
    "output_mappings": {"engineering_spec": ["isolation_model", "tenant-isolation-detail"]},
}


def _with(**changes):
    data = copy.deepcopy(FULL)
    data.update(changes)
    return data


def test_the_build_prompt_example_validates():
    c = validate_contract(EXAMPLE)
    assert c.id == "constraints.solutions" and c.condition == ALWAYS
    assert c.effective_section_ids() == ["constraints-solutions"]


def test_every_field_of_the_true_schema_validates_and_round_trips():
    c = validate_contract(FULL)
    stored = contract_json(c)
    again = validate_contract(stored)
    assert again == c
    assert contract_hash(again) == contract_hash(c)
    assert condition_paths(c.condition) == {
        "scope.tenants",
        "signals.tenant_count",
        "category",
        "policy.data_class",
        "outputs",
    }
    # Every concern of §4.2 has a field.
    for name in (
        "id", "version", "condition", "policy", "depends_on", "conflicts_with",
        "display_order", "order_after", "order_before", "fields", "validators",
        "question_prompts", "agent_instructions", "evidence_expectations", "section_ids",
        "brief_layer", "full_layer", "brief_section_ids", "owner_role",
        "required_review_role", "approval_policy", "outputs", "output_mappings",
    ):  # fmt: skip
        assert name in ModuleContract.model_fields, name


def test_json_text_validates_too():
    assert validate_contract(ModuleContract.model_validate(EXAMPLE).model_dump_json()).id


def test_hash_changes_with_the_contract():
    a = validate_contract(EXAMPLE)
    b = validate_contract({**EXAMPLE, "display_order": 61})
    assert contract_hash(a) != contract_hash(b)


@pytest.mark.parametrize(
    ("changes", "message"),
    [
        ({"id": "Bad Id"}, "id"),
        ({"version": "1.0"}, "version"),
        ({"version": "01.0.0"}, "version"),
        ({"policy": "mandatory"}, "policy"),
        ({"condition": ALWAYS.model_dump()}, "conditional module needs a condition"),
        ({"policy": "required"}, "only a conditional module has a condition"),
        ({"depends_on": ["platform.tenant-isolation"]}, "names the module itself"),
        ({"depends_on": ["a.b", "a.b"]}, "duplicates"),
        ({"conflicts_with": ["goals.outcomes"]}, "depends on and conflicts with"),
        ({"order_after": ["risks.register"]}, "ordered both before and after"),
        ({"unknown_key": 1}, "Extra inputs"),
        ({"brief_layer": False, "full_layer": False, "brief_section_ids": []}, "brief layer"),
        ({"brief_section_ids": ["nope"]}, "brief_section_ids not in section_ids"),
        ({"output_mappings": {"roadmap": ["notes"]}}, "outputs not listed"),
        ({"output_mappings": {"prd": ["missing"]}}, "unknown"),
        ({"fields_schema": {"type": "array"}}, "fields_schema"),
        ({"outputs": []}, "outputs"),
        ({"required_review_role": "admin"}, "required_review_role"),
    ],
)
def test_invalid_contracts_are_refused(changes, message):
    with pytest.raises(ValidationError, match=message):
        validate_contract(_with(**changes))


@pytest.mark.parametrize(
    ("field", "message"),
    [
        ({"key": "x", "label": "X", "type": "enum"}, "an enum needs options"),
        ({"key": "x", "label": "X", "type": "text", "options": ["a"]}, "only an enum"),
        ({"key": "x", "label": "X", "type": "list"}, "list needs"),
        ({"key": "x", "label": "X", "type": "list", "item_type": "list"}, "list needs"),
        ({"key": "x", "label": "X", "type": "reference"}, "reference_type"),
        ({"key": "x", "label": "X", "type": "text", "reference_type": "goal"}, "reference_type"),
        ({"key": "X-bad", "label": "X", "type": "text"}, "key"),
    ],
)
def test_invalid_fields_are_refused(field, message):
    with pytest.raises(ValidationError, match=message):
        validate_contract(_with(fields=[*FULL["fields"], field]))


def test_duplicate_fields_and_dangling_references_are_refused():
    dup = [*FULL["fields"], FULL["fields"][0]]
    with pytest.raises(ValidationError, match="field keys must be unique"):
        validate_contract(_with(fields=dup))
    with pytest.raises(ValidationError, match="unknown field 'ghost'"):
        validate_contract(_with(validators=[{"kind": "required", "field": "ghost"}]))
    q = {**FULL["question_prompts"][0], "fills": ["ghost"]}
    with pytest.raises(ValidationError, match="fills unknown fields"):
        validate_contract(_with(question_prompts=[q]))
    ev = {**FULL["evidence_expectations"], "fields": ["ghost"]}
    with pytest.raises(ValidationError, match="evidence_expectations"):
        validate_contract(_with(evidence_expectations=ev))
    two = [FULL["agent_instructions"][0]] * 2
    with pytest.raises(ValidationError, match="one instruction per agent role"):
        validate_contract(_with(agent_instructions=two))


@pytest.mark.parametrize(
    ("validator", "message"),
    [
        ({"kind": "required", "field": "notes", "value": 1}, "takes no value"),
        ({"kind": "min_length", "field": "notes", "value": -1}, "non-negative"),
        ({"kind": "max_length", "field": "notes", "value": True}, "non-negative"),
        ({"kind": "min", "field": "max_tenants", "value": "1"}, "needs a number"),
        ({"kind": "one_of", "field": "notes", "value": []}, "non-empty list"),
        ({"kind": "pattern", "field": "notes", "value": "("}, "does not compile"),
        ({"kind": "pattern", "field": "notes", "value": "a" * 501}, "at most"),
        ({"kind": "exec", "field": "notes"}, "kind"),
    ],
)
def test_invalid_validators_are_refused(validator, message):
    with pytest.raises(ValidationError, match=message):
        validate_contract(_with(validators=[validator]))


# --- the applicability expression -------------------------------------------------------


@pytest.mark.parametrize(
    "tree",
    [
        {"op": "true"},
        {"op": "false"},
        {"op": "or", "args": [{"op": "present", "path": "brief.problem"}]},
        {"op": "not", "arg": {"op": "absent", "path": "blockers.critical"}},
        {"op": "lt", "path": "signals.cost_per_user", "value": 0.5},
        {"op": "ne", "path": "template.key", "value": "one-pager"},
        {"op": "eq", "path": "policy.regulated", "value": True},
        {"op": "in", "path": "category", "values": ["platform", "ai_feature"]},
        {"op": "contains", "path": "stakeholders.roles", "value": "eng_lead"},
        {"op": "at_least", "count": 2, "args": [{"op": "true"}, {"op": "false"}]},
    ],
)
def test_valid_conditions(tree):
    assert parse_condition(tree).op == tree["op"]


@pytest.mark.parametrize(
    ("tree", "message"),
    [
        # No code evaluation of any kind.
        ({"op": "eval", "code": "__import__('os')"}, "does not match any of the expected"),
        ({"op": "expr", "value": "1 + 1"}, "does not match any of the expected"),
        ({"op": "present", "path": "__class__.__mro__"}, "path"),
        ({"op": "present", "path": "env.secret"}, "path must start with one of"),
        ({"op": "present", "path": "scope." + ".".join(["a"] * 8)}, "segments"),
        ({"op": "and", "args": []}, "args"),
        ({"op": "gte", "path": "signals.n", "value": "2"}, "value"),
        ({"op": "gte", "path": "signals.n", "value": True}, "value"),
        ({"op": "eq", "path": "signals.n", "value": None}, "value"),
        ({"op": "in", "path": "category", "values": ["a", 1]}, "same type"),
        ({"op": "at_least", "count": 3, "args": [{"op": "true"}]}, "count is larger"),
        ({"op": "not", "args": [{"op": "true"}]}, "arg"),
        ({"op": "true", "extra": 1}, "Extra inputs"),
    ],
)
def test_invalid_conditions(tree, message):
    with pytest.raises(ValidationError, match=message):
        parse_condition(tree)


def test_conditions_are_bounded():
    deep = {"op": "true"}
    for _ in range(MAX_CONDITION_DEPTH):
        deep = {"op": "not", "arg": deep}
    with pytest.raises(ValidationError, match="nested deeper"):
        parse_condition(deep)
    wide = {"op": "and", "args": [{"op": "and", "args": [{"op": "true"}] * 50}] * 5}
    with pytest.raises(ValidationError, match="more than 200 nodes"):
        parse_condition(wide)
    # A contract applies the same bounds.
    with pytest.raises(ValidationError, match="nested deeper"):
        validate_contract(_with(condition=deep))


def test_semver_key_orders_releases():
    assert sorted(["1.10.0", "1.2.0", "0.9.9"], key=semver_key) == ["0.9.9", "1.2.0", "1.10.0"]
    with pytest.raises(ValueError, match="not a semantic version"):
        semver_key("v1")
