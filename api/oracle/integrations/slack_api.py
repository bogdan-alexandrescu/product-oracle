"""Calls to Slack's Web API for Oracle's own Slack app (F6): the OAuth code exchange,
listing channels, posting a message and revoking the bot token.

Every call goes to ``https://slack.com/api/<method>`` and nowhere else, through
``guarded_transport`` (oracle.baseline.public_links: public addresses only, no redirects
followed). The bot token travels in the Authorization header only; it is never logged and
never part of an error message (:class:`SlackError` carries Slack's error code alone).
Tests replace the transport with an ``httpx.MockTransport`` (:func:`set_transport`).
"""

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import httpx

from oracle.baseline.public_links import guarded_transport

log = logging.getLogger(__name__)

SLACK_HOST = "slack.com"
API_BASE = f"https://{SLACK_HOST}/api/"
TIMEOUT_SECONDS = 10.0

_transport: httpx.AsyncBaseTransport | None = None


def set_transport(transport: httpx.AsyncBaseTransport | None) -> httpx.AsyncBaseTransport | None:
    """Replace the transport (tests); returns the previous override."""
    global _transport
    previous, _transport = _transport, transport
    return previous


class SlackError(Exception):
    """Slack refused or did not answer. ``code`` is Slack's error code (``ratelimited``,
    ``channel_not_found``) or a short description; never a token."""

    def __init__(self, code: str, *, retry_after: float | None = None, status: int | None = None):
        super().__init__(code)
        self.code = code
        self.retry_after = retry_after
        self.status = status


async def _only_slack(request: httpx.Request) -> None:
    if request.url.scheme != "https" or request.url.host != SLACK_HOST:
        raise httpx.UnsupportedProtocol(f"Oracle's Slack client calls {SLACK_HOST} only")


@asynccontextmanager
async def http_client() -> AsyncIterator[httpx.AsyncClient]:
    transport = _transport if _transport is not None else guarded_transport()
    async with httpx.AsyncClient(
        transport=transport,
        timeout=TIMEOUT_SECONDS,
        follow_redirects=False,
        event_hooks={"request": [_only_slack]},
    ) as client:
        yield client


def _retry_after(resp: httpx.Response) -> float | None:
    raw = resp.headers.get("retry-after")
    try:
        return max(1.0, float(raw)) if raw is not None else None
    except ValueError:
        return None


async def call(
    http: httpx.AsyncClient,
    method: str,
    *,
    token: str | None = None,
    data: dict[str, str] | None = None,
    json: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """One Web API call; Slack's answer when ``ok``, else :class:`SlackError`."""
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    try:
        if json is not None:
            resp = await http.post(API_BASE + method, json=json, headers=headers)
        else:
            resp = await http.post(API_BASE + method, data=data or {}, headers=headers)
    except httpx.HTTPError as e:
        raise SlackError(f"Slack did not answer ({type(e).__name__})") from None
    if resp.status_code == 429:
        raise SlackError("ratelimited", retry_after=_retry_after(resp) or 60.0, status=429)
    try:
        body = resp.json()
    except ValueError:
        body = None
    if resp.status_code >= 400 or not isinstance(body, dict):
        raise SlackError(f"Slack answered HTTP {resp.status_code}", status=resp.status_code)
    if not body.get("ok"):
        error = str(body.get("error") or "unknown_error")[:200]
        raise SlackError(error, retry_after=_retry_after(resp) if error == "ratelimited" else None)
    return body
