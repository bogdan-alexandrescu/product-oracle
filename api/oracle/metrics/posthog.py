"""The PostHog query client (H5): one HogQL query returning one row with one number.

``POST {host}/api/projects/{project_id}/query/`` with
``{"query": {"kind": "HogQLQuery", "query": "..."}}`` and the personal API key as a
Bearer token (a key limited to query reads). The host is US cloud, EU cloud, or the
company's own ``https`` address, which must resolve to public addresses only: it is
checked before any request, and every connect goes through
:func:`oracle.baseline.public_links.guarded_transport`.

The key is never returned, logged or audited; a provider's message is capped at 300
characters with the key removed (:func:`redact`).
"""

import json
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
TIMEOUT_SECONDS = 30.0
KEY_CHECK_QUERY = "SELECT 1"
PROVIDER = "posthog"
PURPOSE = "metrics"

# Tests swap these: a fake transport (no request leaves) and a resolver.
resolve = system_resolve
_transport: httpx.AsyncBaseTransport | None = None


def set_transport(transport: httpx.AsyncBaseTransport | None) -> None:
    global _transport
    _transport = transport


class PostHogError(Exception):
    """PostHog refused or failed a query; ``message`` is safe to show (no key)."""

    def __init__(self, message: str, status_code: int | None = None):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


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


def _number(body: Any) -> float:
    rows = body.get("results") if isinstance(body, dict) else None
    if not isinstance(rows, list) or len(rows) != 1:
        raise PostHogError("The query must return one row with one number")
    row = rows[0]
    if not isinstance(row, list | tuple) or len(row) != 1:
        raise PostHogError("The query must return one row with one number")
    value = row[0]
    if value is None:
        return 0.0
    try:
        return float(value)
    except (TypeError, ValueError):
        raise PostHogError("The query must return one row with one number") from None


async def query_number(conn: Connection, hogql: str) -> float:
    """Run ``hogql``; its single number. PostHogError with a redacted message otherwise."""
    await check_host(conn.host)
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
        raise PostHogError(redact(f"Could not reach PostHog: {exc}", conn.api_key)) from None
    if response.status_code >= 400:
        raise PostHogError(redact(_message(response), conn.api_key), response.status_code)
    try:
        return _number(response.json())
    except (json.JSONDecodeError, ValueError):
        raise PostHogError("PostHog's answer was not JSON") from None


def seal(api_key: str) -> bytes:
    return crypto.encrypt(api_key.encode())


def unseal(ciphertext: bytes) -> str:
    return crypto.decrypt(ciphertext).decode()
