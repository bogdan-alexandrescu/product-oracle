"""Export rendering off the event loop: a fair share of a small pool, within a time cap.

Rendering an export (markdown-it, Jinja, WeasyPrint, python-pptx) is CPU-bound: seconds
for a large document. It never runs on the event loop: on the export pool (4 threads), its
own, not the parse pool: a PDF of a long document takes seconds, and the parse pool's 4
threads read every draft an import or a run brings.

Owner decisions 2026-10-20 (security review of PR #134):

- One export per person at a time (``EXPORTS_PER_PERSON``) and two per company, running
  or queued (``EXPORTS_PER_COMPANY``): one more is refused at once, 429
  ``export_busy_you``. An export keeps its place until its render ends, even after its
  request gave up: a request that gave up never frees a worker that is still busy. With
  4 workers, one company never holds every worker.
- Present mode's deck (``/deck``) is not counted against these caps; it renders on the
  same pool, within the same waits.
- A wait of more than ``QUEUE_SECONDS`` for a free worker is 503 ``export_busy`` (``BUSY``),
  never "too large"; the export it refused never renders.
- ``SECONDS`` caps the render itself, counted from when it starts (not its wait): past it,
  422 ``TOO_LARGE``. The abandoned render finishes on the pool (a thread cannot be
  stopped), still in its place.

A request holds no database connection while it waits: the caller commits first and hands
the render copies of the rows it read (:func:`oracle.export.render.detached`).

A refusal's body is ``{"detail": message, "code": ..., "message": ...}``: ``detail`` as
every other error (what the web client shows), ``code`` for a client that tells them apart.
"""

import asyncio
import contextlib
import contextvars
import threading
import time
import uuid
from collections import Counter
from collections.abc import Callable, Hashable, Iterator
from concurrent.futures import ThreadPoolExecutor
from typing import TYPE_CHECKING, Any

from fastapi import HTTPException, status
from fastapi.responses import JSONResponse

if TYPE_CHECKING:
    from oracle.auth.deps import Principal

# Owner decisions 2026-10-20: 4 workers; a render may take 60 s, counted from when it
# starts (every format alike); a wait of more than 10 s for a free worker is "busy"; at
# most 1 export per person at a time and 2 per company, running or queued (so one company
# never holds every worker).
POOL = ThreadPoolExecutor(max_workers=4, thread_name_prefix="export")
SECONDS = 60.0
QUEUE_SECONDS = 10.0
EXPORTS_PER_PERSON = 1
EXPORTS_PER_COMPANY = 2
TOO_LARGE = "This document is too large to export quickly"
BUSY = "Oracle is busy with other exports. Try again in a moment."
BUSY_YOU = "Your previous export is still running"
BUSY_COMPANY = "Your company's other exports are still running. Try again in a moment."
RETRY_AFTER_SECONDS = 5


class Refused(Exception):
    """An export refused before it rendered (busy). :meth:`response` is its answer."""

    def __init__(self, status_code: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message

    def response(self) -> JSONResponse:
        return JSONResponse(
            {"detail": self.message, "code": self.code, "message": self.message},
            self.status_code,
            headers={"Retry-After": str(RETRY_AFTER_SECONDS)},
        )


_lock = threading.Lock()
_people: Counter[Hashable] = Counter()
_companies: Counter[Hashable] = Counter()


class Place:
    """One export's place in its person's and its company's share. Held by its request
    and, once handed to the pool, by its render: free when both are done."""

    def __init__(self, person: Hashable, company: Hashable) -> None:
        self.person = person
        self.company = company
        self._holders = 1

    def hold(self) -> None:
        with _lock:
            self._holders += 1

    def leave(self) -> None:
        with _lock:
            self._holders -= 1
            if self._holders:
                return
            for counts, key in ((_people, self.person), (_companies, self.company)):
                counts[key] -= 1
                if counts[key] <= 0:
                    del counts[key]


def _admit(principal: "Principal") -> Place:
    person = (principal.tenant_id, principal.actor)
    company = principal.tenant_id
    with _lock:
        if _people[person] >= EXPORTS_PER_PERSON:
            raise Refused(status.HTTP_429_TOO_MANY_REQUESTS, "export_busy_you", BUSY_YOU)
        if _companies[company] >= EXPORTS_PER_COMPANY:
            raise Refused(status.HTTP_429_TOO_MANY_REQUESTS, "export_busy_you", BUSY_COMPANY)
        _people[person] += 1
        _companies[company] += 1
    return Place(person, company)


@contextlib.contextmanager
def place(principal: "Principal") -> Iterator[Place]:
    """A place for one export of ``principal`` (:class:`Refused` 429 when its person or its
    company has none left), held while the block runs and by the render it starts."""
    held = _admit(principal)
    try:
        yield held
    finally:
        held.leave()


def in_flight(company: uuid.UUID) -> int:
    """How many exports ``company`` has running or queued."""
    with _lock:
        return _companies.get(company, 0)


def _started(future: asyncio.Future[None]) -> None:
    if not future.done():
        future.set_result(None)


async def run[T](held: Place | None, fn: Callable[..., T], /, *args: Any) -> T:
    """``fn(*args)`` on the export pool, in ``held``'s place (None: counted against no
    cap, as Present mode's deck). Refused when no worker is free
    within ``QUEUE_SECONDS`` (:class:`Refused`, 503 ``export_busy``: it never renders);
    past ``SECONDS`` from its start, an HTTP 422 (``TOO_LARGE``). Exceptions from ``fn``
    propagate unchanged."""
    loop = asyncio.get_running_loop()
    started: asyncio.Future[None] = loop.create_future()
    state: dict[str, Any] = {}
    gate = threading.Lock()
    ctx = contextvars.copy_context()

    def call() -> Any:
        with gate:
            if state.get("abandoned"):
                return None  # refused while queued: its place is already free
            state["at"] = time.monotonic()
        try:
            with contextlib.suppress(RuntimeError):  # its loop is gone: nobody waits
                loop.call_soon_threadsafe(_started, started)
            try:
                return ctx.run(fn, *args)
            finally:
                state["took"] = time.monotonic() - state["at"]
        finally:
            if held is not None:
                held.leave()

    if held is not None:
        held.hold()
    try:
        work = loop.run_in_executor(POOL, call)
    except BaseException:
        if held is not None:
            held.leave()
        raise
    # Its outcome is read even when nobody waits for it any more.
    work.add_done_callback(lambda f: f.cancelled() or f.exception())

    try:
        await asyncio.wait_for(asyncio.shield(started), QUEUE_SECONDS)
    except (TimeoutError, asyncio.CancelledError) as exc:
        with gate:
            abandoned = "at" not in state
            if abandoned:
                state["abandoned"] = True
        if abandoned and held is not None:
            held.leave()  # the render's hold: it will not render
        if isinstance(exc, asyncio.CancelledError):
            raise
        if abandoned:
            raise Refused(status.HTTP_503_SERVICE_UNAVAILABLE, "export_busy", BUSY) from None
    left = SECONDS - (time.monotonic() - state["at"])
    try:
        value = await asyncio.wait_for(asyncio.shield(work), max(left, 0.0))
    except TimeoutError:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, TOO_LARGE) from None
    if state["took"] > SECONDS:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, TOO_LARGE)
    return value
