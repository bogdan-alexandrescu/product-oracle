"""The applicability evaluator: deterministic, typed, no eval, typed errors."""

import pytest

from oracle.modules.evaluator import (
    ConditionError,
    ConditionInvalidError,
    ConditionPathError,
    ConditionTypeError,
    evaluate,
)
from oracle.v2.schemas import CompositionInputs

INPUTS = {
    "category": "ai_agent_platform",
    "scope": {"capabilities": ["tool_use", "memory"], "items": []},
    "signals": {"tenant_count": 12, "ratio": 0.5, "end_user_facing": True, "label": "2"},
    "brief": {"decision": "choose_between", "nested": {"deep": "x"}},
}


@pytest.mark.parametrize(
    ("condition", "expected"),
    [
        ({"op": "true"}, True),
        ({"op": "false"}, False),
        ({"op": "eq", "path": "category", "value": "ai_agent_platform"}, True),
        ({"op": "ne", "path": "category", "value": "other"}, True),
        ({"op": "gte", "path": "signals.tenant_count", "value": 12}, True),
        ({"op": "gt", "path": "signals.tenant_count", "value": 12}, False),
        ({"op": "lt", "path": "signals.ratio", "value": 1}, True),
        ({"op": "lte", "path": "signals.ratio", "value": 0.5}, True),
        ({"op": "in", "path": "brief.decision", "values": ["choose_between", "x"]}, True),
        ({"op": "contains", "path": "scope.capabilities", "value": "memory"}, True),
        ({"op": "contains", "path": "scope.capabilities", "value": "quotas"}, False),
        ({"op": "present", "path": "scope.capabilities"}, True),
        ({"op": "present", "path": "scope.items"}, False),  # empty counts as absent
        ({"op": "absent", "path": "signals.missing"}, True),
        ({"op": "eq", "path": "signals.end_user_facing", "value": True}, True),
        ({"op": "eq", "path": "brief.nested.deep", "value": "x"}, True),
        ({"op": "not", "arg": {"op": "present", "path": "blockers.items"}}, True),
        (
            {
                "op": "and",
                "args": [
                    {"op": "eq", "path": "category", "value": "ai_agent_platform"},
                    {"op": "gte", "path": "signals.tenant_count", "value": 2},
                ],
            },
            True,
        ),
        (
            {
                "op": "or",
                "args": [
                    {"op": "eq", "path": "category", "value": "other"},
                    {"op": "contains", "path": "scope.capabilities", "value": "tool_use"},
                ],
            },
            True,
        ),
        (
            {
                "op": "at_least",
                "count": 2,
                "args": [
                    {"op": "present", "path": "signals.tenant_count"},
                    {"op": "present", "path": "signals.nothing"},
                    {"op": "eq", "path": "brief.decision", "value": "choose_between"},
                ],
            },
            True,
        ),
    ],
)
def test_operators(condition, expected):
    assert evaluate(condition, INPUTS).value is expected


def test_missing_paths_are_false_and_reported_never_errors():
    ev = evaluate(
        {
            "op": "or",
            "args": [
                {"op": "gte", "path": "signals.agent_count", "value": 1},
                {"op": "eq", "path": "brief.size", "value": "new_product"},
                {"op": "ne", "path": "brief.readers", "value": "founder"},
            ],
        },
        INPUTS,
    )
    assert ev.value is False
    assert ev.missing == ["brief.readers", "brief.size", "signals.agent_count"]
    assert ev.score == 0.0
    assert "signals.agent_count ≥ 1 (actual: missing)" in ev.reasons()


def test_every_branch_is_explained_without_short_circuit():
    ev = evaluate(
        {
            "op": "or",
            "args": [
                {"op": "eq", "path": "category", "value": "ai_agent_platform"},
                {"op": "gte", "path": "signals.tenant_count", "value": 100},
            ],
        },
        INPUTS,
    )
    assert ev.value is True
    assert [leaf.holds for leaf in ev.leaves] == [True, False]
    assert ev.score == 0.5


@pytest.mark.parametrize(
    "condition",
    [
        # A number is never compared with a string, a boolean is not a number.
        {"op": "gte", "path": "signals.label", "value": 1},
        {"op": "eq", "path": "signals.tenant_count", "value": "12"},
        {"op": "eq", "path": "signals.end_user_facing", "value": 1},
        {"op": "lt", "path": "signals.end_user_facing", "value": 2},
        {"op": "in", "path": "signals.tenant_count", "values": ["12"]},
        {"op": "contains", "path": "category", "value": "ai"},
        {"op": "eq", "path": "scope.capabilities", "value": "tool_use"},
    ],
)
def test_type_mismatch_is_a_typed_error(condition):
    with pytest.raises(ConditionTypeError) as e:
        evaluate(condition, INPUTS)
    assert isinstance(e.value, ConditionError)
    assert e.value.path == condition["path"]


def test_walking_through_a_scalar_is_a_path_error():
    with pytest.raises(ConditionPathError):
        evaluate({"op": "eq", "path": "category.sub", "value": "x"}, INPUTS)


@pytest.mark.parametrize(
    "condition",
    [
        {"op": "eval", "code": "__import__('os').system('true')"},
        {"op": "eq", "path": "__class__", "value": 1},
        {"op": "eq", "path": "secrets.token", "value": 1},  # not a readable root
        {"op": "eq", "path": "signals.x", "value": {"nested": 1}},
        {"op": "at_least", "count": 3, "args": [{"op": "true"}]},
        {"op": "in", "path": "category", "values": ["a", 1]},
        "category == 'x'",
    ],
)
def test_invalid_trees_are_refused_not_run(condition):
    with pytest.raises(ConditionInvalidError):
        evaluate(condition, INPUTS)


def test_depth_and_size_are_bounded():
    deep = {"op": "true"}
    for _ in range(13):
        deep = {"op": "not", "arg": deep}
    with pytest.raises(ConditionInvalidError):
        evaluate(deep, INPUTS)
    wide = {"op": "or", "args": [{"op": "or", "args": [{"op": "true"}] * 50}] * 5}
    with pytest.raises(ConditionInvalidError):
        evaluate(wide, INPUTS)


def test_strings_are_data_never_code():
    hostile = {"brief": {"decision": "__import__('os').system('exit 1')"}}
    ev = evaluate({"op": "eq", "path": "brief.decision", "value": "choose_between"}, hostile)
    assert ev.value is False


def test_deterministic_and_accepts_the_typed_inputs_model():
    typed = CompositionInputs(category="ai_agent_platform", signals={"tenant_count": 3})
    cond = {"op": "gte", "path": "signals.tenant_count", "value": 2}
    results = {(evaluate(cond, typed).value, evaluate(cond, typed).score) for _ in range(20)}
    assert results == {(True, 1.0)}
