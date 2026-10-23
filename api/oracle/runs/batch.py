"""Reads shared by the reviews of one Inbox call (D9).

``GET /v1/inbox`` reads the review of every pending Roadmap items checkpoint. Inside
:func:`batched` the company-wide inputs (the baseline trace report, the low-confidence
threshold, a PRD version's sections and verified date bases) and each item's trace are read
once per call and shared by its checkpoints, and the checkpoints' segments and draft actions
are read for them all at once (:func:`put`): the same reads, as of the same moment, so the
counts stay exact. Outside it every :func:`once` reads, as before.
"""

from collections.abc import Awaitable, Callable, Hashable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any

_memo: ContextVar[dict[Hashable, Any] | None] = ContextVar("runs_batch", default=None)


@contextmanager
def batched() -> Iterator[None]:
    token = _memo.set({})
    try:
        yield
    finally:
        _memo.reset(token)


async def once[T](key: Hashable, load: Callable[[], Awaitable[T]]) -> T:
    """``load()``, read once per :func:`batched` block for ``key``; the result is shared, so
    callers never change it."""
    memo = _memo.get()
    if memo is None:
        return await load()
    if key not in memo:
        memo[key] = await load()
    return memo[key]


def put(key: Hashable, value: Any) -> None:
    """Gives :func:`once` its value for ``key`` read ahead with others; nothing outside a
    :func:`batched` block."""
    memo = _memo.get()
    if memo is not None:
        memo[key] = value
