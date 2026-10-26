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


_STRING = re.compile(r"'(?:[^'\\]|\\.)*'|\"(?:[^\"\\]|\\.)*\"|`[^`]*`")
_FORBIDDEN = re.compile(
    r"\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE|GRANT|REVOKE|ATTACH|DETACH|RENAME|"
    r"OPTIMIZE|SYSTEM|KILL|SETTINGS|INTO|OUTFILE|FORMAT|SHOW|DESCRIBE|EXPLAIN|USE)\b",
    re.IGNORECASE,
)
_SOURCE = re.compile(r"\b(?:FROM|JOIN)\s+(\(|[A-Za-z_][\w.$]*)(\s*\()?", re.IGNORECASE)


def check_query(hogql: str) -> None:
    """One read-only SELECT over :data:`ALLOWED_TABLES` (subqueries and joins of them
    allowed, a trailing semicolon too); QueryRefused naming why otherwise. Words inside
    string literals do not count."""
    text = _STRING.sub("''", (hogql or "").strip())
    if text.endswith(";"):
        text = text[:-1].rstrip()
    if not text:
        raise QueryRefused("query: write one SELECT")
    if ";" in text:
        raise QueryRefused("query: one statement only")
    if "--" in text or "/*" in text or "#" in text:
        raise QueryRefused("query: no comments")
    if not re.match(r"SELECT\b", text, re.IGNORECASE):
        raise QueryRefused("query: only a SELECT can be run")
    if m := _FORBIDDEN.search(text):
        raise QueryRefused(f"query: {m.group(1).upper()} is not allowed")
    for name, call in _SOURCE.findall(text):
        if name == "(":
            continue
        if call:
            raise QueryRefused(f"query: the table function {name} is not allowed")
        if name.lower() not in ALLOWED_TABLES:
            allowed = ", ".join(sorted(ALLOWED_TABLES))
            raise QueryRefused(f"query: {name} cannot be read (only {allowed})")


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
