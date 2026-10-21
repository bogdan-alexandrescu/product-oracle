"""Export rendering off the event loop, within a time cap.

Rendering an export (markdown-it, Jinja, WeasyPrint, python-pptx) is CPU-bound: seconds
for a large document. It never runs on the event loop: on the export pool, through the
parse pool's mechanism (:func:`oracle.safe_yaml.run_parse_within`), and a request waits
for it at most ``SECONDS``, then is refused with ``TOO_LARGE`` (422) rather than hanging.

The export pool is its own (2 threads), not the parse pool: a PDF of a long document takes
seconds, and the parse pool's 4 threads read every draft an import or a run brings, whose
wait for a thread counts against their own cap.
"""

from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from fastapi import HTTPException, status

from oracle import safe_yaml

POOL = ThreadPoolExecutor(max_workers=2, thread_name_prefix="export")
# The longest a request waits for its export to render (the whole wait, a queue included).
# The abandoned render finishes on the pool.
SECONDS = 20.0
TOO_LARGE = "This document is too large to export quickly"


async def run[T](fn: Callable[..., T], /, *args: Any) -> T:
    """``fn(*args)`` on the export pool; past ``SECONDS``, an HTTP 422 (``TOO_LARGE``).
    Exceptions from ``fn`` propagate unchanged."""
    try:
        return await safe_yaml.run_parse_within(
            fn, *args, name="the export", seconds=SECONDS, pool=POOL
        )
    except safe_yaml.ParseTimeout:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, TOO_LARGE) from None
