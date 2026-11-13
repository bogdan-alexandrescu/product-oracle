"""The HogQL syntax-tree checks behind :func:`oracle.metrics.posthog.check_query`, apart
so sqlglot loads at a metric's first check, not with the app."""

from typing import ClassVar

import sqlglot
from sqlglot import exp
from sqlglot.dialects.clickhouse import ClickHouse

from oracle.metrics.posthog import ALLOWED_TABLES, QueryRefused


class _HogQL(ClickHouse):
    """ClickHouse's grammar with HogQL's names: ``$`` is part of a name
    (``properties.$os``, ``$start_timestamp``), never a heredoc string."""

    class Tokenizer(ClickHouse.Tokenizer):
        HEREDOC_STRINGS: ClassVar[list[str | tuple[str, str]]] = []
        SINGLE_TOKENS = {k: v for k, v in ClickHouse.Tokenizer.SINGLE_TOKENS.items() if k != "$"}
        VAR_SINGLE_TOKENS = {*ClickHouse.Tokenizer.VAR_SINGLE_TOKENS, "$"}


# Functions whose operands after the first may name a table, as IN's right side does.
_IN_FUNCTIONS = frozenset(
    {"in", "notin", "globalin", "globalnotin", "nullin", "notnullin", "globalnullin"}
    | {"globalnotnullin"}
)
# Words never taken as a table's alias: where sqlglot and HogQL may read them differently.
_KEYWORDS = frozenset(
    {"WHERE", "PREWHERE", "GROUP", "ORDER", "HAVING", "LIMIT", "OFFSET", "WINDOW", "QUALIFY"}
    | {"SAMPLE", "FINAL", "SETTINGS", "FORMAT", "INTO", "ARRAY", "GLOBAL", "JOIN", "INNER"}
    | {"LEFT", "RIGHT", "FULL", "CROSS", "OUTER", "ASOF", "SEMI", "ANTI", "ANY", "ALL", "PASTE"}
    | {"ON", "USING", "UNION", "INTERSECT", "EXCEPT", "WITH", "SELECT", "FROM", "AS", "BY"}
)
# What a LIMIT, OFFSET or SAMPLE count may hold.
_NUMERIC = (exp.Literal, exp.Neg, exp.Paren, exp.Add, exp.Sub, exp.Mul, exp.Div)


def parse(text: str) -> exp.Select:
    """``text`` as one SELECT's syntax tree; QueryRefused when the parser cannot read it
    (fail closed) or it is anything else."""
    try:
        statements = sqlglot.parse(text, read=_HogQL)
    except Exception:  # any parser failure, not only ParseError, refuses the query
        raise QueryRefused("query: HogQL could not be read as one SELECT") from None
    if len(statements) != 1 or statements[0] is None:
        raise QueryRefused("query: one statement only")
    statement = statements[0]
    if isinstance(statement, exp.SetOperation):
        raise QueryRefused("query: UNION, INTERSECT and EXCEPT are not allowed")
    if not isinstance(statement, exp.Select):
        raise QueryRefused("query: only a SELECT can be run")
    return statement


def _bare_names(operand: exp.Expression) -> list[str]:
    """The bare names in an IN operand (through parentheses, tuples, arrays and
    aliases): HogQL may read each as a table."""
    if isinstance(operand, exp.Paren | exp.Tuple | exp.Array):
        parts = [operand.this] if isinstance(operand, exp.Paren) else operand.expressions
        return [name for part in parts if part is not None for name in _bare_names(part)]
    if isinstance(operand, exp.Alias):
        return [operand.alias or "an alias", *_bare_names(operand.this)]
    if isinstance(operand, exp.Column | exp.Table | exp.Identifier | exp.Dot):
        return [operand.sql(_HogQL)]
    return []


def _check_in(operands: list[exp.Expression], field: exp.Expression | None) -> None:
    """IN's right side is a list, an array or a (SELECT ...): never a bare name, and never
    a lone call (``IN numbers(10)``, ``in(x, numbers(10))``), which may be a table function."""
    if field is not None:
        raise QueryRefused("query: IN takes a list in parentheses, not a table")
    for operand in operands:
        if names := _bare_names(operand):
            raise QueryRefused(f"query: IN cannot take the bare name {names[0]}")
    lone = operands[0].unnest() if len(operands) == 1 else None
    if isinstance(lone, exp.Func) and not isinstance(lone, exp.Tuple | exp.Array):
        raise QueryRefused(f"query: IN cannot take the call {lone.sql(_HogQL)}")


def _check_source(node: exp.From | exp.Join) -> None:
    """A FROM or JOIN reads a table or a (SELECT ...); an ARRAY JOIN reads an expression,
    with no ON or USING."""
    source = node.this.this if isinstance(node.this, exp.Final) else node.this
    if isinstance(node, exp.Join) and node.args.get("kind") == "ARRAY":
        if node.args.get("on") or node.args.get("using") or node.side not in ("", "LEFT"):
            raise QueryRefused("query: ARRAY JOIN takes an array, with no ON or USING")
        return
    if not isinstance(source, exp.Table | exp.Subquery):
        raise QueryRefused("query: FROM and JOIN read a table or a (SELECT ...)")
    alias = source.args.get("alias")
    if alias is not None and alias.name.upper() in _KEYWORDS:
        raise QueryRefused(f"query: {alias.name.upper()} cannot be an alias")


def check_tree(statement: exp.Select) -> None:
    """Every table read anywhere in ``statement`` (FROM, JOIN, subqueries, WITH, IN,
    ARRAY JOIN) is a bare allowed table; QueryRefused naming the first that is not.
    Where sqlglot's grammar and HogQL's may differ, the form is refused: a keyword as a
    table's alias, anything but numbers in LIMIT, OFFSET or SAMPLE (sqlglot reads
    ``LIMIT n, name``), a bare name or a lone call after IN."""
    allowed = ", ".join(sorted(ALLOWED_TABLES))
    for node in statement.walk():
        if isinstance(node, exp.SetOperation):
            raise QueryRefused("query: UNION, INTERSECT and EXCEPT are not allowed")
        if isinstance(node, exp.Placeholder | exp.Parameter | exp.Command | exp.Into):
            raise QueryRefused("query: only a plain SELECT can be run")
        if isinstance(node, exp.Select) and any(
            node.args.get(k) for k in ("settings", "format", "into")
        ):
            raise QueryRefused("query: SETTINGS, FORMAT and INTO are not allowed")
        if isinstance(node, exp.Identifier) and node.quoted:
            raise QueryRefused('query: write names bare (no ` or ")')
        if isinstance(node, exp.Table):
            if not isinstance(node.this, exp.Identifier):
                raise QueryRefused(f"query: the table function {node.sql(_HogQL)} is not allowed")
            if node.args.get("db") or node.args.get("catalog"):
                raise QueryRefused(f"query: {node.sql(_HogQL)} cannot be read (only {allowed})")
            if node.name.lower() not in ALLOWED_TABLES:
                raise QueryRefused(f"query: {node.name} cannot be read (only {allowed})")
        elif isinstance(node, exp.Subquery):
            if not isinstance(node.this, exp.Select) or node.args.get("joins"):
                raise QueryRefused("query: ( after FROM or JOIN must hold one SELECT")
        elif isinstance(node, exp.Select) and node is not statement:
            # Not ``IN (SELECT ..., numbers(10))`` read as a list holding a SELECT.
            if not isinstance(node.parent, exp.Subquery | exp.CTE | exp.Exists):
                raise QueryRefused("query: a SELECT in ( ) must stand alone")
        elif isinstance(node, exp.Window) and node.arg_key == "windows":
            # Not ``FROM events window FINAL, t`` read as two named windows.
            if not any(node.args.get(k) for k in ("partition_by", "order", "spec")):
                raise QueryRefused("query: each WINDOW needs AS ( ... )")
        elif isinstance(node, exp.From | exp.Join):
            _check_source(node)
        elif isinstance(node, exp.Limit | exp.Offset | exp.TableSample):
            counts = [node.args.get(k) for k in ("expression", "offset", "size", "percent")]
            for count in filter(None, counts):
                if not all(isinstance(n, _NUMERIC) for n in count.walk()):
                    raise QueryRefused("query: LIMIT, OFFSET and SAMPLE take numbers only")
        elif isinstance(node, exp.In):
            _check_in(node.expressions, node.args.get("field"))
        elif isinstance(node, exp.Anonymous) and node.name.lower() in _IN_FUNCTIONS:
            _check_in(node.expressions[1:], None)
