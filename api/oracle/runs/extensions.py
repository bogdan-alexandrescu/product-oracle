"""Hooks a lane registers for its code-defined flow, so the runs service does not import it.

- ``register_prompt_lines(flow, fn)``: ``await fn(db, run)`` returns lines added to every
  step prompt of the flow's runs (the spec contract, the PRD requirements).
- ``register_importer(name, fn)``: a segment with ``importer=name`` hands its files to
  ``await fn(db, run, files, principal)`` when it succeeds. The importer works in its own
  transaction (like the draft import) and returns the checkpoint's ``import`` payload:
  ``document_id`` (the run's document from then on) and, when nothing could be imported,
  ``error``.

Lanes register at import time of a module ``oracle.main`` imports (their router module).
"""

from collections.abc import Awaitable, Callable
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from oracle.auth.deps import Principal

PromptLines = Callable[[AsyncSession, Any], Awaitable[list[str]]]
Importer = Callable[[AsyncSession, Any, dict[str, str], Principal], Awaitable[dict[str, Any]]]

_prompt_lines: dict[str, PromptLines] = {}
_importers: dict[str, Importer] = {}


def register_prompt_lines(flow: str, fn: PromptLines) -> None:
    _prompt_lines[flow] = fn


def register_importer(name: str, fn: Importer) -> None:
    _importers[name] = fn


async def prompt_lines(db: AsyncSession, run: Any) -> list[str]:
    fn = _prompt_lines.get(run.flow)
    return await fn(db, run) if fn is not None else []


async def run_importer(
    name: str, db: AsyncSession, run: Any, files: dict[str, str], principal: Principal
) -> dict[str, Any]:
    fn = _importers.get(name)
    if fn is None:
        return {"error": f"no importer {name!r} is registered"}
    return await fn(db, run, files, principal)
