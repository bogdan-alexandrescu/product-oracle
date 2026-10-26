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
from typing import Any
from urllib.parse import urlsplit

import httpx

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
_TOKEN = re.compile(r"\s*(?:([A-Za-z_$][\w$]*)|(\d[\w.]*)|(\S))", re.ASCII)
# The words that end a FROM clause at its own depth (a comma after them is not a join).
_CLAUSE_ENDS = frozenset(
    {"WHERE", "PREWHERE", "GROUP", "ORDER", "HAVING", "LIMIT", "OFFSET", "WINDOW", "QUALIFY"}
)
# What may follow a table's alias but never starts a clause's body: a clause word followed
# by one of these is an alias (``FROM events order, t``), so it does not end the FROM.
_AFTER_ALIAS = frozenset(
    {",", ")", "", "ON", "USING", "AS", "FINAL", "SAMPLE", "JOIN", "INNER", "LEFT", "RIGHT"}
    | {"FULL", "CROSS", "OUTER", "ASOF", "SEMI", "ANTI", "ARRAY", "GLOBAL", "PASTE"}
    | _CLAUSE_ENDS
)
# Bare words that are values, not names, inside IN ( ... ).
_IN_VALUES = frozenset({"NULL", "TRUE", "FALSE"})


def _blank_strings(text: str) -> str:
    """``text`` with each single-quoted string as ``0``; QueryRefused for a string glued
    to a name (an f-string or other prefix the checker cannot read)."""

    def blank(m: re.Match[str]) -> str:
        before = text[m.start() - 1] if m.start() else " "
        if before.isalnum() or before in "_$":
            raise QueryRefused("query: only plain 'strings' are allowed")
        return "0"

    return _STRING.sub(blank, text)


def _check_sources(text: str) -> None:
    """Walk the tokens: parentheses balance and never close the row-limit wrapper; each
    FROM or JOIN reads a bare allowed table or a ``(SELECT ...)``; no comma joins; IN
    takes a list, never a table or a bare name; a clause word is never an alias."""
    tokens = [m.group(1) or m.group(2) or m.group(3) for m in _TOKEN.finditer(text)]
    allowed = ", ".join(sorted(ALLOWED_TABLES))
    depth = 0
    from_at: set[int] = set()  # the depths inside a FROM clause
    in_at: set[int] = set()  # the depths inside IN ( ... ) or in( ... )
    for i, tok in enumerate(tokens):
        word = tok.upper()
        before = tokens[i - 1].upper() if i else ""
        after = tokens[i + 1] if i + 1 < len(tokens) else ""
        if tok == "(":
            depth += 1
            if before == "IN":
                in_at.add(depth)
        elif tok == ")":
            from_at.discard(depth)
            in_at.discard(depth)
            depth -= 1
            if depth < 0:
                raise QueryRefused("query: a ) has no matching (")
        elif tok == ",":
            if depth in from_at:
                raise QueryRefused("query: join tables with JOIN, not a comma")
        elif word in _CLAUSE_ENDS:
            if before == "AS":
                raise QueryRefused(f"query: {word} cannot be an alias")
            if word in ("GROUP", "ORDER") and after.upper() != "BY":
                raise QueryRefused(f"query: {word} cannot be an alias")
            if depth in from_at and after.upper() in _AFTER_ALIAS:
                raise QueryRefused(f"query: {word} cannot be an alias")
            from_at.discard(depth)
        elif word == "IN":
            if after not in ("(", "["):
                raise QueryRefused("query: IN takes a list in parentheses, not a table")
        elif depth in in_at and before in ("(", ",") and after in (",", ")"):
            if tok[0].isalpha() or tok[0] in "_$":
                if word not in _IN_VALUES:
                    raise QueryRefused(f"query: IN cannot take the bare name {tok}")
        elif word in ("FROM", "JOIN"):
            from_at.add(depth)
            nxt = tokens[i + 2] if i + 2 < len(tokens) else ""
            if after == "(":
                if nxt.upper() != "SELECT":
                    raise QueryRefused(f"query: {word} ( must be followed by SELECT")
                continue
            if nxt == "(":
                raise QueryRefused(f"query: the table function {after} is not allowed")
            if after.lower() not in ALLOWED_TABLES or nxt == ".":
                name = after + ("." if nxt == "." else "")
                raise QueryRefused(f"query: {name} cannot be read (only {allowed})")
    if depth:
        raise QueryRefused("query: a ( is never closed")


def check_query(hogql: str) -> None:
    """One read-only SELECT over :data:`ALLOWED_TABLES` (subqueries and joins of them
    allowed, a trailing semicolon too); QueryRefused naming why otherwise. Words inside
    string literals do not count. Anything the checker cannot read with certainty is
    refused: quoted names, comma joins, unbalanced parentheses, set operators."""
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
    if not re.match(r"SELECT\b", text, re.IGNORECASE):
        raise QueryRefused("query: only a SELECT can be run")
    if m := _FORBIDDEN.search(text):
        raise QueryRefused(f"query: {m.group(1).upper()} is not allowed")
    _check_sources(text)


def limited(hogql: str) -> str:
    """``hogql`` wrapped in the row limit."""
    inner = hogql.strip().removesuffix(";").rstrip()
    return f"SELECT * FROM ({inner}) LIMIT {MAX_ROWS}"


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
