"""The PostHog query client (H5): one HogQL query returning one row with one number.

``POST {host}/api/projects/{project_id}/query/`` with
``{"query": {"kind": "HogQLQuery", "query": "..."}}`` and the personal API key as a
Bearer token (a key limited to query reads). The host is US cloud, EU cloud, or the
company's own ``https`` address, which must resolve to public addresses only: it is
checked before any request, and every connect goes through
:func:`oracle.baseline.public_links.guarded_transport`.

The key is never returned, logged or audited. A metric's query is one read-only SELECT
over the allowed tables (:func:`check_query`), sent wrapped in a row limit, with a time
limit on the read. PostHog's own error text goes to the server log only (capped at 300
characters, the key removed, :func:`redact`); what is stored and shown is a fixed
sentence (:data:`QUERY_FAILED`), since members read a metric's last error (#541).
"""

import json
import logging
import re
from dataclasses import dataclass
from typing import Any, ClassVar
from urllib.parse import urlsplit

import httpx
import sqlglot
from sqlglot import exp
from sqlglot.dialects.clickhouse import ClickHouse

from oracle import crypto
from oracle.baseline.public_links import (
    LinkError,
    guarded_transport,
    public_addresses,
    system_resolve,
)

CLOUD_HOSTS = {"us": "https://us.posthog.com", "eu": "https://eu.posthog.com"}
MAX_ERROR = 300
TIMEOUT_SECONDS = 20.0
# The rows a metric query may return: one is wanted, a second shows it returns more.
MAX_ROWS = 2
# The tables a metric query may read (PostHog's HogQL names).
ALLOWED_TABLES = frozenset({"events", "persons", "sessions", "groups"})
QUERY_FAILED = "PostHog could not run the query; the details are in Oracle's server log"
UNREACHABLE = "Could not reach PostHog"
KEY_CHECK_QUERY = "SELECT 1"
PROVIDER = "posthog"
PURPOSE = "metrics"

# Tests swap these: a fake transport (no request leaves) and a resolver.
resolve = system_resolve
_transport: httpx.AsyncBaseTransport | None = None


def set_transport(transport: httpx.AsyncBaseTransport | None) -> None:
    global _transport
    _transport = transport


log = logging.getLogger(__name__)


class PostHogError(Exception):
    """PostHog refused or failed a query; ``message`` is a fixed sentence, safe to store
    and show to every member. ``detail``: PostHog's own text (redacted), for the owner's
    key check only."""

    def __init__(self, message: str, status_code: int | None = None, detail: str | None = None):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.detail = detail or message


class QueryRefused(ValueError):
    """A metric query that is not one read-only SELECT over the allowed tables (422)."""


class HostError(Exception):
    """An own host that is not ``https`` or not public (422)."""


@dataclass(frozen=True)
class Connection:
    host: str
    project_id: str
    api_key: str

    @property
    def base_url(self) -> str:
        return CLOUD_HOSTS.get(self.host, self.host).rstrip("/")


def redact(message: str, key: str | None) -> str:
    """``message`` with the key removed, at most 300 characters."""
    text = " ".join(str(message).split())
    if key:
        text = text.replace(key, "[key]")
    return text[:MAX_ERROR]


async def check_host(host: str) -> None:
    """A cloud name, or an own ``https`` host whose addresses are all public."""
    if host in CLOUD_HOSTS:
        return
    parts = urlsplit(host)
    if parts.scheme != "https" or not parts.hostname:
        raise HostError("The host must be US cloud, EU cloud or an https address")
    try:
        await public_addresses(parts.hostname, parts.port or 443, resolve)
    except LinkError as exc:
        raise HostError(f"The host {parts.hostname} is not a public address") from exc


# Single-quoted strings only: a backtick or double quote names a table or column in
# HogQL, so any left once strings are blanked refuses the query.
_STRING = re.compile(r"'(?:[^'\\]|\\.)*'")
_PLACEHOLDER = re.compile(r"\{period_(?:start|end)\}")
_FORBIDDEN = re.compile(
    r"\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE|GRANT|REVOKE|ATTACH|DETACH|RENAME|"
    r"OPTIMIZE|SYSTEM|KILL|SETTINGS|INTO|OUTFILE|FORMAT|SHOW|DESCRIBE|EXPLAIN|USE|"
    r"UNION|INTERSECT|EXCEPT)\b",
    re.IGNORECASE,
)


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


def _blank_strings(text: str) -> str:
    """``text`` with each single-quoted string as ``0``; QueryRefused for a string glued
    to a name (an f-string or other prefix the checker cannot read)."""

    def blank(m: re.Match[str]) -> str:
        before = text[m.start() - 1] if m.start() else " "
        if before.isalnum() or before in "_$":
            raise QueryRefused("query: only plain 'strings' are allowed")
        return "0"

    return _STRING.sub(blank, text)


def _parse(text: str) -> exp.Select:
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


def _check_tree(statement: exp.Select) -> None:
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


def check_query(hogql: str) -> None:
    """One read-only SELECT over :data:`ALLOWED_TABLES` (subqueries, joins, WITH and
    ARRAY JOIN allowed, a trailing semicolon too); QueryRefused naming why otherwise.
    The query is parsed with sqlglot's ClickHouse grammar and the tree is checked
    (:func:`_check_tree`); what the parser cannot read is refused, as are quoted names,
    comments and set operators, found before parsing."""
    text = _PLACEHOLDER.sub("0", _blank_strings((hogql or "").strip()))
    if text.endswith(";"):
        text = text[:-1].rstrip()
    if not text:
        raise QueryRefused("query: write one SELECT")
    if any(q in text for q in "'\"`"):
        raise QueryRefused("query: close every 'string', and write names bare (no ` or \")")
    if not text.isascii():
        raise QueryRefused("query: only ASCII outside strings")
    if "{" in text or "}" in text:
        raise QueryRefused("query: only {period_start} and {period_end} may be filled in")
    if ";" in text:
        raise QueryRefused("query: one statement only")
    if "--" in text or "/*" in text or "#" in text:
        raise QueryRefused("query: no comments")
    if not re.match(r"(SELECT|WITH)\b", text, re.IGNORECASE):
        raise QueryRefused("query: only a SELECT can be run")
    if m := _FORBIDDEN.search(text):
        raise QueryRefused(f"query: {m.group(1).upper()} is not allowed")
    _check_tree(_parse(_PLACEHOLDER.sub("0", hogql.strip()).removesuffix(";")))


def limited(hogql: str) -> str:
    """``hogql`` (checked, :func:`check_query`) wrapped in the row limit. The text sent is
    the statement as written (sqlglot's own rendering would change HogQL's functions), so
    the wrapped text is parsed again and must be exactly the limit over that statement's
    tree; QueryRefused otherwise."""
    check_query(hogql)
    inner = hogql.strip().removesuffix(";").rstrip()
    text = f"SELECT * FROM ({inner}) LIMIT {MAX_ROWS}"
    expected = _parse(f"SELECT * FROM (SELECT 1) LIMIT {MAX_ROWS}")
    expected.find(exp.Subquery).set("this", _parse(_PLACEHOLDER.sub("0", inner)))
    if _parse(_PLACEHOLDER.sub("0", text)) != expected:
        raise QueryRefused("query: the row limit could not wrap the query")
    return text


def _message(response: httpx.Response) -> str:
    try:
        body: Any = response.json()
    except (json.JSONDecodeError, ValueError):
        return response.text or f"PostHog answered {response.status_code}"
    if isinstance(body, dict):
        for key in ("detail", "error", "message"):
            if body.get(key):
                return str(body[key])
    return f"PostHog answered {response.status_code}"


def _number(body: Any) -> float | None:
    """The one number; None when the query answered SQL NULL (no value that week)."""
    rows = body.get("results") if isinstance(body, dict) else None
    if not isinstance(rows, list) or len(rows) != 1:
        raise PostHogError("The query must return one row with one number")
    row = rows[0]
    if not isinstance(row, list | tuple) or len(row) != 1:
        raise PostHogError("The query must return one row with one number")
    value = row[0]
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        raise PostHogError("The query must return one row with one number") from None


async def query_number(conn: Connection, hogql: str) -> float | None:
    """Run ``hogql`` (checked, :func:`check_query`, and row-limited; the key check's
    ``SELECT 1`` as it is); its single number (None for NULL). PostHogError with a fixed
    message otherwise, PostHog's own text logged (redacted)."""
    await check_host(conn.host)
    if hogql != KEY_CHECK_QUERY:
        try:
            check_query(hogql)
        except QueryRefused as exc:
            raise PostHogError(str(exc)) from None
        hogql = limited(hogql)
    transport = _transport or guarded_transport(resolve)
    url = f"{conn.base_url}/api/projects/{conn.project_id}/query/"
    try:
        async with httpx.AsyncClient(transport=transport, timeout=TIMEOUT_SECONDS) as http:
            response = await http.post(
                url,
                json={"query": {"kind": "HogQLQuery", "query": hogql}},
                headers={"Authorization": f"Bearer {conn.api_key}"},
            )
    except httpx.HTTPError as exc:
        detail = redact(f"Could not reach PostHog: {exc}", conn.api_key)
        log.warning("PostHog query failed: %s", detail)
        raise PostHogError(UNREACHABLE, detail=detail) from None
    if response.status_code >= 400:
        detail = redact(_message(response), conn.api_key)
        log.warning("PostHog answered %s: %s", response.status_code, detail)
        raise PostHogError(QUERY_FAILED, response.status_code, detail)
    try:
        return _number(response.json())
    except (json.JSONDecodeError, ValueError):
        raise PostHogError("PostHog's answer was not JSON") from None


def seal(api_key: str) -> bytes:
    return crypto.encrypt(api_key.encode())


def unseal(ciphertext: bytes) -> str:
    return crypto.decrypt(ciphertext).decode()
