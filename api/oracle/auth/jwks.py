"""A cache of Google's published signing keys (a JWK set), refreshed when stale.

Used by IAP sign-in (``oracle.auth.iap``, ES256) and the run ticker's ID tokens
(``oracle.ticker.idtoken``, RS256). Keys are refetched hourly, and early when a token
names an unknown kid (Google rotated its keys), at most once a minute. A failed fetch
keeps serving the cached keys; with none cached it raises ``KeysUnavailable``, and so
does every request for the next ``_FAILED_FETCH_BACKOFF_SECONDS`` without fetching
again (concurrent requests share the one failed fetch).
"""

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from typing import Any

import jwt

log = logging.getLogger(__name__)

_TTL_SECONDS = 60 * 60
# An unknown kid triggers a refetch (Google rotated keys), at most this often.
_MIN_REFRESH_SECONDS = 60
# With no keys cached, a failed fetch is not retried for this long.
_FAILED_FETCH_BACKOFF_SECONDS = 30


class KeysUnavailable(Exception):
    """Google's public keys could not be fetched and none are cached."""


class KeyCache:
    def __init__(self, fetch: Callable[[], Awaitable[dict[str, Any]]], alg: str, name: str):
        self._fetch = fetch
        self.alg = alg
        self.name = name
        self.keys: dict[str, jwt.PyJWK] = {}
        self.fetched_at = 0.0
        self.failed_at: float | None = None
        self._lock = asyncio.Lock()

    def clear(self) -> None:
        self.keys = {}
        self.fetched_at = 0.0
        self.failed_at = None

    def _backing_off(self) -> bool:
        return (
            not self.keys
            and self.failed_at is not None
            and time.monotonic() - self.failed_at < _FAILED_FETCH_BACKOFF_SECONDS
        )

    async def get(self, kid: str) -> jwt.PyJWK | None:
        age = time.monotonic() - self.fetched_at
        stale = not self.keys or age > _TTL_SECONDS
        if stale or (kid not in self.keys and age > _MIN_REFRESH_SECONDS):
            if self._backing_off():
                raise KeysUnavailable
            await self._refresh(self.fetched_at)
        return self.keys.get(kid)

    async def _refresh(self, seen_fetched_at: float) -> None:
        async with self._lock:
            if self.fetched_at != seen_fetched_at:
                return  # another request refreshed while this one waited
            if self._backing_off():
                raise KeysUnavailable  # another request's fetch failed while this one waited
            try:
                data = await self._fetch()
                keys = {
                    k["kid"]: jwt.PyJWK(k, algorithm=self.alg)
                    for k in data["keys"]
                    if k.get("alg", self.alg) == self.alg
                }
            except Exception as e:
                log.warning("fetching %s keys failed: %s", self.name, e)
                if not self.keys:
                    self.failed_at = time.monotonic()
                    raise KeysUnavailable from e
                # Keep serving the cached keys; retry after the minimum interval.
                self.fetched_at = time.monotonic() - _TTL_SECONDS + _MIN_REFRESH_SECONDS
                return
            self.keys, self.fetched_at, self.failed_at = keys, time.monotonic(), None
