"""The endpoint behind Claude Code's /usage, read for an account's quota windows.

Ported from SwarmCloud's ``apps/quota-broker/quota_broker/usage.py`` and
``usagepoll.py``. ``GET https://api.anthropic.com/api/oauth/usage`` authenticates with
whatever OAuth access token is presented, so an account is read without being used.

* ``utilization`` is a PERCENTAGE (0-100); ``WindowReading.utilization`` is 0-1,
  clamped, because an overage has been reported above 100.
* Windows are top-level keys, several null, with names that change; every window
  that parses is kept.
* The budget is roughly FIVE calls per five minutes, shared with anyone running
  ``/usage`` on the same accounts, answered 429 with ``retry-after``. So a round
  polls at most ``DEFAULT_MAX_POLLS_PER_SWEEP`` accounts, OLDEST READING FIRST, and a
  429 ENDS the round.

A failed read is never a reading: every failure raises, and the previous windows
stay in place to age out.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import httpx

from oracle.claude_accounts.accounts import Account, WindowReading

ENDPOINT = "https://api.anthropic.com/api/oauth/usage"
BETA_HEADER = "oauth-2025-04-20"
#: The endpoint answers 403 to an unrecognised client.
USER_AGENT = "claude-cli/2.1.266 (external, cli)"

#: The observed budget is ~5 calls / 5 minutes and shared; the sweep runs every five
#: minutes, so three leaves headroom for a person running /usage.
DEFAULT_MAX_POLLS_PER_SWEEP = 3


class UsageUnavailable(RuntimeError):
    """The reading could not be taken. NEVER conflated with "nothing is used"."""


class RateLimited(UsageUnavailable):
    """The budget is spent. The caller must stop, not retry."""

    def __init__(self, retry_after_seconds: int) -> None:
        super().__init__(f"usage endpoint rate limited; retry after {retry_after_seconds}s")
        self.retry_after_seconds = retry_after_seconds


def _parse_window(raw: Any) -> WindowReading | None:
    if not isinstance(raw, dict):
        return None
    pct = raw.get("utilization")
    if not isinstance(pct, int | float) or isinstance(pct, bool):
        return None
    resets = raw.get("resets_at")
    if not isinstance(resets, str):
        return None
    try:
        resets_at = datetime.fromisoformat(resets)
    except ValueError:
        return None
    if resets_at.tzinfo is None:
        resets_at = resets_at.replace(tzinfo=UTC)
    return WindowReading(utilization=max(0.0, min(1.0, float(pct) / 100.0)), resets_at=resets_at)


def parse(payload: dict[str, Any]) -> dict[str, WindowReading]:
    """Every window in the payload that carries a usable reading, unknown names kept."""
    windows: dict[str, WindowReading] = {}
    for key, value in payload.items():
        reading = _parse_window(value)
        if reading is not None:
            windows[key] = reading
    return windows


async def fetch(
    access_token: str,
    *,
    timeout_seconds: float = 10.0,
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict[str, WindowReading]:
    """Read one account's windows. Raises rather than returning an empty dict."""
    if not access_token:
        raise UsageUnavailable("no access token for this account")
    try:
        async with httpx.AsyncClient(timeout=timeout_seconds, transport=transport) as client:
            resp = await client.get(
                ENDPOINT,
                headers={
                    "authorization": f"Bearer {access_token}",
                    "anthropic-beta": BETA_HEADER,
                    "user-agent": USER_AGENT,
                    "accept": "application/json",
                },
            )
    except httpx.HTTPError as exc:
        raise UsageUnavailable(f"usage endpoint unreachable: {type(exc).__name__}") from exc
    if resp.status_code == 429:
        try:
            retry_after = int(resp.headers.get("retry-after", ""))
        except (TypeError, ValueError):
            retry_after = 300
        raise RateLimited(retry_after)
    if resp.status_code >= 400:
        raise UsageUnavailable(f"usage endpoint returned HTTP {resp.status_code}")
    try:
        payload = resp.json()
    except ValueError as exc:
        raise UsageUnavailable("usage endpoint returned a body that is not JSON") from exc
    if not isinstance(payload, dict):
        raise UsageUnavailable("usage endpoint returned JSON that is not an object")
    windows = parse(payload)
    if not windows:
        # A SHAPE CHANGE, not an account with no quota.
        raise UsageUnavailable(
            "usage endpoint returned no parseable window; the response shape may have changed"
        )
    return windows


@dataclass(frozen=True)
class PollOutcome:
    account_id: str
    polled: bool
    reason: str


Fetch = Callable[[str], Awaitable[dict[str, WindowReading]]]


def poll_order(accounts: list[Account]) -> list[Account]:
    """Oldest reading first; never read sorts first of all."""
    return sorted(
        accounts,
        key=lambda a: (
            a.observed_at is not None,
            a.observed_at or datetime.min.replace(tzinfo=UTC),
        ),
    )


async def poll_round(
    accounts: list[Account],
    *,
    read_token: Callable[[Account], Awaitable[str]],
    record: Callable[[Account, dict[str, WindowReading]], Awaitable[None]],
    fetch_windows: Fetch | None = None,
    max_polls: int = DEFAULT_MAX_POLLS_PER_SWEEP,
    keep_going: Callable[[], Awaitable[bool]] | None = None,
) -> list[PollOutcome]:
    """One round: at most ``max_polls`` accounts, oldest reading first, stopping on 429.

    ``keep_going`` is the sweep lease's fence, asked before each poll: two concurrent
    rounds spend one budget twice.
    """
    outcomes: list[PollOutcome] = []
    if max_polls <= 0 or not accounts:
        return outcomes
    get = fetch_windows or fetch
    for account in poll_order(accounts)[:max_polls]:
        if keep_going is not None and not await keep_going():
            break
        try:
            token = await read_token(account)
        except Exception:
            outcomes.append(PollOutcome(account.account_id, False, "token_unreadable"))
            continue
        try:
            windows = await get(token)
        except RateLimited:
            outcomes.append(PollOutcome(account.account_id, False, "rate_limited"))
            break
        except UsageUnavailable:
            outcomes.append(PollOutcome(account.account_id, False, "unavailable"))
            continue
        await record(account, windows)
        outcomes.append(PollOutcome(account.account_id, True, "ok"))
    return outcomes
