"""The one writer of subscription credentials.

Ported from SwarmCloud's ``apps/quota-broker/quota_broker/credentials.py``. Reads an
account's pair, exchanges it when the access token is within the refresh window, and
writes back. Nothing else in Oracle refreshes: refresh tokens rotate, so two writers
invalidate each other's tokens. The sweep (under its lease) and the owner's Refresh
button both go through ``CredentialRefresher``.

1. The rotated PAIR is written BEFORE the access token. If the process dies between
   the two, the account has a valid refresh token and a stale access token --
   recoverable on the next sweep. The other order loses the means of getting more.
2. ``invalid_grant`` stops at once (``reauth_required``); retrying cannot help.
3. An unchanged credential is not written again (``still_valid``).
4. A HELD account (a job is running on it) is left alone inside the ordinary window
   until its token is within ``DEFAULT_HELD_REFRESH_MARGIN`` of expiry: exchanging
   revokes the access token the running call uses (``held_deferred``).

SwarmCloud's publish ledger exists because its broker could not read back the secret
it writes; Oracle reads its own database, so a failed read is UNKNOWN and nothing is
written (``unverified_skipped``), and the ledger is not needed.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable, Collection
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from enum import Enum
from typing import Any, Protocol

from oracle.claude_accounts.oauth import (
    CredentialError,
    ReauthRequired,
    TokenEndpoint,
    parse_credential,
    refresh,
    serialise,
)
from oracle.claude_accounts.store import REFRESH_SUFFIX

log = logging.getLogger(__name__)

#: How close to expiry a HELD account's token may get before the sweep refreshes it
#: anyway: six five-minute ticks, so a sweep or two can fail and it still lands.
DEFAULT_HELD_REFRESH_MARGIN = timedelta(minutes=30)

#: The ordinary refresh window.
DEFAULT_WINDOW = timedelta(hours=3)


class SecretStore(Protocol):
    async def access(self, name: str) -> str:
        """The payload; KeyError -- and only KeyError -- when there is none."""
        ...

    async def add_version(self, name: str, payload: str) -> None: ...


class _BaseState(Enum):
    #: The access column already holds this token: nothing to do.
    CURRENT = "current"
    #: It differs, or is empty: a write is needed.
    NEEDS_PUBLISH = "needs_publish"
    #: The read failed: nothing is known, so nothing may be written.
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class RefreshOutcome:
    #: The account id (SwarmCloud's ``tenant_id`` field, which its sweep fills with
    #: the account id too).
    account_id: str
    refreshed: bool
    reason: str
    expires_at: datetime | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "account_id": self.account_id,
            "refreshed": self.refreshed,
            "reason": self.reason,
            "expires_at": self.expires_at.isoformat() if self.expires_at else None,
        }


class CredentialRefresher:
    def __init__(
        self,
        store: SecretStore,
        endpoint: TokenEndpoint,
        *,
        window: timedelta = DEFAULT_WINDOW,
        held_margin: timedelta = DEFAULT_HELD_REFRESH_MARGIN,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self._store = store
        self._endpoint = endpoint
        self._window = window
        self._held_margin = held_margin
        self._now = now or (lambda: datetime.now(UTC))

    async def refresh_secret(self, base: str, *, held: bool = False) -> RefreshOutcome:
        now = self._now()
        refresh_secret = f"{base}{REFRESH_SUFFIX}"
        try:
            stored = await self._store.access(refresh_secret)
        except KeyError:
            return RefreshOutcome(base, False, "no_refresh_credential")
        except Exception as exc:
            log.warning(
                "could not read the refresh credential",
                extra={"account_id": base, "error": type(exc).__name__},
            )
            return RefreshOutcome(base, False, "store_unavailable")

        try:
            credential = parse_credential(stored, now=now)
        except CredentialError as exc:
            log.warning(
                "stored subscription credential is unusable",
                extra={"account_id": base, "error": str(exc)},
            )
            return RefreshOutcome(base, False, "unreadable")

        if (
            held
            and credential.needs_refresh(now, self._window)
            and not credential.needs_refresh(now, self._held_margin)
        ):
            # A JOB IS ON THIS ACCOUNT. Nothing exchanged and nothing written; the next
            # sweep looks again.
            log.info(
                "account is held by a running job; refresh deferred until its token nears expiry",
                extra={"account_id": base, "expires_at": credential.expires_at.isoformat()},
            )
            return RefreshOutcome(base, False, "held_deferred", credential.expires_at)

        if not credential.needs_refresh(now, self._window):
            # STILL VALID IS NOT THE SAME AS ALREADY PUBLISHED: a pasted pair minted
            # minutes ago lands here at once, and the access column must carry it.
            state = await self._base_state(base, credential.access_token)
            if state is _BaseState.CURRENT:
                return RefreshOutcome(base, False, "still_valid", credential.expires_at)
            if state is _BaseState.UNKNOWN:
                log.error(
                    "could not read an account's access token, so nothing was written",
                    extra={"account_id": base},
                )
                return RefreshOutcome(base, False, "unverified_skipped", credential.expires_at)
            try:
                await self._store.add_version(base, credential.access_token)
            except Exception as exc:
                log.warning(
                    "could not publish a still-valid access token",
                    extra={"account_id": base, "error": type(exc).__name__},
                )
                return RefreshOutcome(base, False, "publish_failed")
            return RefreshOutcome(base, True, "published", credential.expires_at)

        try:
            fresh = await refresh(credential, self._endpoint, now=now)
        except ReauthRequired as exc:
            log.error(
                "subscription credential needs a person to sign in again",
                extra={"account_id": base, "error": str(exc)},
            )
            return RefreshOutcome(base, False, "reauth_required")
        except CredentialError as exc:
            log.warning(
                "credential refresh failed; will retry on the next sweep",
                extra={"account_id": base, "error": str(exc)},
            )
            return RefreshOutcome(base, False, "refresh_failed")

        # ORDER IS THE SAFETY PROPERTY: the pair (the means of getting more
        # credentials), written on EVERY refresh because it also carries the new expiry,
        # then the access token.
        await self._store.add_version(refresh_secret, serialise(fresh))
        await self._store.add_version(base, fresh.access_token)
        log.info("subscription credential refreshed", extra={"account_id": base})
        return RefreshOutcome(base, True, "refreshed", fresh.expires_at)

    async def _base_state(self, base: str, access_token: str) -> _BaseState:
        try:
            stored = await self._store.access(base)
        except KeyError:
            return _BaseState.NEEDS_PUBLISH
        except Exception:
            return _BaseState.UNKNOWN
        return _BaseState.CURRENT if stored == access_token else _BaseState.NEEDS_PUBLISH

    async def sweep_accounts(
        self,
        bases: list[str],
        *,
        keep_going: Callable[[], Awaitable[bool]] | None = None,
        held: Collection[str] = (),
    ) -> list[RefreshOutcome]:
        """Refresh every account given, INCLUDING ones nobody is using.

        One account's failure never stops the sweep. ``keep_going`` (the lease's fence)
        does: False means another sweep holds the lease now. ``held`` names the accounts
        a running job holds; each is still visited but exchanged only within the margin.
        """
        outcomes: list[RefreshOutcome] = []
        for base in bases:
            if keep_going is not None and not await keep_going():
                break
            try:
                outcomes.append(await self.refresh_secret(base, held=base in held))
            except Exception as exc:
                log.error(
                    "account refresh raised; continuing with the rest of the pool",
                    extra={"account_id": base, "error": type(exc).__name__},
                )
                outcomes.append(RefreshOutcome(base, False, "error"))
        return outcomes
