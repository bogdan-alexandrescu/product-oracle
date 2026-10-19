"""Evaluate an applicability expression (oracle.v2.contract.Condition) against inputs.

Deterministic and closed: the tree is walked node by node; nothing is ever evaluated as
code, imported or looked up by name. Inputs are the composition inputs
(:class:`oracle.v2.schemas.CompositionInputs`, as a dict): only the condition roots are
readable, and a path walks nested objects only.

Semantics:

- ``present`` holds when the value exists and is not ``None``, ``""``, ``[]`` or ``{}``;
  ``absent`` is its opposite.
- A comparison against a path that is missing is false, and the path is reported in
  :attr:`Evaluation.missing` (the "missing information" the composition inspector shows).
  ``ne`` against a missing path is false too: nothing is known, so nothing differs.
- Comparisons are typed: a number is never compared with a string, and a boolean is not
  a number. A value of the wrong type raises :class:`ConditionTypeError` rather than
  guessing.

Typed errors, all :class:`ConditionError`:

- :class:`ConditionInvalidError`: the tree does not validate (unknown op, bad root,
  too deep, too large);
- :class:`ConditionTypeError`: an input has a type the comparison cannot use;
- :class:`ConditionPathError`: a path walks through something that is not an object.
"""

import math
from dataclasses import dataclass, field
from typing import Any

from pydantic import BaseModel, ValidationError

from oracle.v2.contract import (
    MAX_CONDITION_DEPTH,
    MAX_CONDITION_NODES,
    AllOf,
    Always,
    AtLeast,
    Contains,
    Equality,
    Membership,
    Not,
    Ordering,
    Presence,
    condition_stats,
    parse_condition,
)

_MISSING = object()


class ConditionError(ValueError):
    """Base of every evaluation error; ``path`` names the input involved, if any."""

    code = "condition_error"

    def __init__(self, message: str, path: str | None = None) -> None:
        super().__init__(message)
        self.path = path


class ConditionInvalidError(ConditionError):
    code = "condition_invalid"


class ConditionTypeError(ConditionError):
    code = "condition_type"


class ConditionPathError(ConditionError):
    code = "condition_path"


@dataclass(frozen=True)
class Leaf:
    """One comparison that was evaluated: what it read and whether it held."""

    op: str
    path: str
    expected: Any
    actual: Any
    holds: bool
    missing: bool

    def describe(self) -> str:
        shown = "missing" if self.missing else _show(self.actual)
        if self.op in ("present", "absent"):
            return f"{self.path} is {self.op} ({shown})"
        return f"{self.path} {_OP_WORDS[self.op]} {_show(self.expected)} (actual: {shown})"


@dataclass
class Evaluation:
    value: bool
    # Every leaf, in tree order (left to right), including those short-circuiting skipped.
    leaves: list[Leaf] = field(default_factory=list)

    @property
    def missing(self) -> list[str]:
        """Paths the condition reads that the inputs do not have (sorted, unique)."""
        return sorted({leaf.path for leaf in self.leaves if leaf.missing})

    @property
    def score(self) -> float | None:
        """Advisory signal: the share of leaves that hold (``None`` without leaves)."""
        if not self.leaves:
            return None
        return round(sum(1 for leaf in self.leaves if leaf.holds) / len(self.leaves), 3)

    def reasons(self, *, held: bool | None = None) -> list[str]:
        return [leaf.describe() for leaf in self.leaves if held is None or leaf.holds == held]


_OP_WORDS = {
    "eq": "=",
    "ne": "≠",
    "lt": "<",
    "lte": "≤",
    "gt": ">",
    "gte": "≥",
    "in": "is one of",
    "contains": "contains",
}


def _show(value: Any) -> str:
    if isinstance(value, str):
        return repr(value) if len(value) <= 60 else repr(value[:57] + "...")
    if isinstance(value, list):
        if len(value) > 8:
            return "[" + ", ".join(_show(v) for v in value[:8]) + ", ...]"
        return "[" + ", ".join(_show(v) for v in value) + "]"
    if isinstance(value, dict):
        return "{...}"
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _kind(value: Any) -> str | None:
    """'bool', 'number', 'str', or None for anything else."""
    if isinstance(value, bool):
        return "bool"
    if isinstance(value, int | float):
        if isinstance(value, float) and not math.isfinite(value):
            return None
        return "number"
    if isinstance(value, str):
        return "str"
    return None


def resolve(inputs: dict[str, Any], path: str) -> Any:
    """The value at a dotted path, or ``_MISSING``. Walks objects (dicts) only."""
    current: Any = inputs
    walked: list[str] = []
    for part in path.split("."):
        if current is None:
            return _MISSING
        if not isinstance(current, dict):
            raise ConditionPathError(
                f"{'.'.join(walked)} is not an object, so {path} cannot be read", path
            )
        if part not in current:
            return _MISSING
        current = current[part]
        walked.append(part)
    return current


def _empty(value: Any) -> bool:
    return value is _MISSING or value is None or value in ("", [], {})


def _typed(path: str, actual: Any, expected: Any, op: str) -> None:
    a, e = _kind(actual), _kind(expected)
    if a is None or a != e:
        raise ConditionTypeError(
            f"{path}: cannot compare {type(actual).__name__} with {type(expected).__name__} "
            f"using {op}",
            path,
        )


class _Walker:
    def __init__(self, inputs: dict[str, Any]) -> None:
        self.inputs = inputs
        self.leaves: list[Leaf] = []

    def leaf(self, node: Any, expected: Any, actual: Any, holds: bool) -> bool:
        missing = actual is _MISSING
        self.leaves.append(
            Leaf(node.op, node.path, expected, None if missing else actual, holds, missing)
        )
        return holds

    def eval(self, node: BaseModel) -> bool:  # noqa: C901 - one branch per op reads best
        if isinstance(node, Always):
            return node.op == "true"
        if isinstance(node, AllOf):
            # Every branch is evaluated (no short-circuit), so the explanation and the
            # missing information are complete and independent of argument order.
            results = [self.eval(arg) for arg in node.args]
            return all(results) if node.op == "and" else any(results)
        if isinstance(node, Not):
            return not self.eval(node.arg)
        if isinstance(node, AtLeast):
            return sum(1 for arg in node.args if self.eval(arg)) >= node.count
        if isinstance(node, Presence):
            actual = resolve(self.inputs, node.path)
            present = not _empty(actual)
            holds = present if node.op == "present" else not present
            return self.leaf(node, None, actual, holds)
        actual = resolve(self.inputs, node.path)
        if isinstance(node, Equality):
            if actual is _MISSING or actual is None:
                return self.leaf(node, node.value, _MISSING, False)
            _typed(node.path, actual, node.value, node.op)
            equal = actual == node.value
            return self.leaf(node, node.value, actual, equal if node.op == "eq" else not equal)
        if isinstance(node, Ordering):
            if actual is _MISSING or actual is None:
                return self.leaf(node, node.value, _MISSING, False)
            _typed(node.path, actual, node.value, node.op)
            holds = {
                "lt": actual < node.value,
                "lte": actual <= node.value,
                "gt": actual > node.value,
                "gte": actual >= node.value,
            }[node.op]
            return self.leaf(node, node.value, actual, holds)
        if isinstance(node, Membership):
            if actual is _MISSING or actual is None:
                return self.leaf(node, node.values, _MISSING, False)
            for value in node.values:
                _typed(node.path, actual, value, node.op)
            return self.leaf(node, node.values, actual, actual in node.values)
        if isinstance(node, Contains):
            if actual is _MISSING or actual is None:
                return self.leaf(node, node.value, _MISSING, False)
            if not isinstance(actual, list):
                raise ConditionTypeError(
                    f"{node.path}: contains needs a list, got {type(actual).__name__}", node.path
                )
            want = _kind(node.value)
            holds = any(_kind(item) == want and item == node.value for item in actual)
            return self.leaf(node, node.value, actual, holds)
        raise ConditionInvalidError(f"unknown condition node {type(node).__name__}")


def evaluate(condition: Any, inputs: dict[str, Any] | BaseModel) -> Evaluation:
    """Evaluate ``condition`` (a parsed node or its JSON form) against ``inputs``.

    Raises a :class:`ConditionError` subclass; never anything else for bad input.
    """
    if not isinstance(condition, BaseModel):
        try:
            condition = parse_condition(condition)
        except ValidationError as e:
            raise ConditionInvalidError(_first_error(e)) from None
        except ValueError as e:
            raise ConditionInvalidError(str(e)) from None
    else:
        # A node built in code skipped parsing: bound it here too.
        depth, count = condition_stats(condition)
        if depth > MAX_CONDITION_DEPTH:
            raise ConditionInvalidError(f"condition is nested deeper than {MAX_CONDITION_DEPTH}")
        if count > MAX_CONDITION_NODES:
            raise ConditionInvalidError(f"condition has more than {MAX_CONDITION_NODES} nodes")
    if isinstance(inputs, BaseModel):
        inputs = inputs.model_dump(mode="json")
    if not isinstance(inputs, dict):
        raise ConditionInvalidError("inputs must be an object")
    walker = _Walker(inputs)
    value = walker.eval(condition)
    return Evaluation(value=value, leaves=walker.leaves)


def _first_error(e: ValidationError) -> str:
    errors = e.errors()
    if not errors:
        return "invalid condition"
    first = errors[0]
    where = ".".join(str(p) for p in first.get("loc", ()) if p != "condition")
    return f"{where}: {first.get('msg')}" if where else str(first.get("msg"))


__all__ = [
    "ConditionError",
    "ConditionInvalidError",
    "ConditionPathError",
    "ConditionTypeError",
    "Evaluation",
    "Leaf",
    "evaluate",
    "resolve",
]
