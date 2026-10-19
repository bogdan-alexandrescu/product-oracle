"""Readiness checks: the second hook where v2 lanes meet.

Lanes register checks; whoever needs a verdict (the readiness dashboard, the publish
transaction) calls :func:`evaluate`::

    readiness.register_check("critical_blockers", critical_blockers, hard=True)
    readiness.register_check("problem_clarity", problem_clarity)  # advisory

    report = await readiness.evaluate(ReadinessContext(db, document_id, version_id))
    if report.blocked:
        ...  # refuse the publish: a hard check is critical

A check is ``async def check(ctx) -> CheckOutcome`` and returns ``pass``, ``warning``,
``critical`` or ``not_applicable`` with a rationale, evidence ids and an owner.

Only a **hard** check can block (T2 is open: quality criteria are advisory; hard checks
are review and publish invariants, critical blockers and failed security or policy
checks). A hard check that raises counts as critical (fail closed); an advisory check
that raises counts as a warning. Each check runs in a savepoint. Checks read; they never
write or commit.
"""

import uuid
from collections.abc import Awaitable, Callable, Iterable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Literal

from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

Status = Literal["pass", "warning", "critical", "not_applicable"]


@dataclass(frozen=True)
class ReadinessContext:
    """What is being judged. ``version_id`` None: the document's latest version."""

    db: AsyncSession
    document_id: uuid.UUID
    version_id: uuid.UUID | None = None
    composition_revision: int | None = None
    # "publish" when the publish transaction asks; checks may be stricter then.
    purpose: Literal["advisory", "publish"] = "advisory"


class CheckOutcome(BaseModel):
    status: Status
    rationale: str
    evidence_ids: list[uuid.UUID] = []
    owner_id: uuid.UUID | None = None
    section_keys: list[str] = []


class CheckResult(CheckOutcome):
    key: str
    hard: bool
    # Set when the check raised instead of answering.
    error: str | None = None


class ReadinessReport(BaseModel):
    results: list[CheckResult]

    @property
    def blocking(self) -> list[CheckResult]:
        """Hard checks that are critical: these refuse a publish."""
        return [r for r in self.results if r.hard and r.status == "critical"]

    @property
    def blocked(self) -> bool:
        return bool(self.blocking)


Check = Callable[[ReadinessContext], Awaitable[CheckOutcome]]


@dataclass(frozen=True)
class Registration:
    key: str
    check: Check
    hard: bool


_checks: dict[str, Registration] = {}


def register_check(key: str, fn: Check, *, hard: bool = False) -> None:
    """Add a check (or replace the one with this key)."""
    if not key:
        raise ValueError("a check needs a key")
    _checks[key] = Registration(key, fn, hard)


def unregister_check(key: str) -> None:
    _checks.pop(key, None)


def checks() -> list[Registration]:
    return list(_checks.values())


@contextmanager
def isolated_checks() -> Iterator[None]:
    """Tests: start with no checks and restore the registry afterwards."""
    saved = dict(_checks)
    _checks.clear()
    try:
        yield
    finally:
        _checks.clear()
        _checks.update(saved)


async def evaluate(ctx: ReadinessContext, keys: Iterable[str] | None = None) -> ReadinessReport:
    """Run the registered checks (or only ``keys``) in registration order."""
    wanted = None if keys is None else set(keys)
    results: list[CheckResult] = []
    for reg in list(_checks.values()):
        if wanted is not None and reg.key not in wanted:
            continue
        try:
            # A savepoint per check: a check whose query fails cannot poison the
            # session for the checks after it.
            async with ctx.db.begin_nested():
                outcome = await reg.check(ctx)
            if not isinstance(outcome, CheckOutcome):
                raise TypeError(f"returned {type(outcome).__name__}, not a CheckOutcome")
        except Exception as e:  # noqa: BLE001 - a failing check is a result, not a crash
            results.append(
                CheckResult(
                    key=reg.key,
                    hard=reg.hard,
                    status="critical" if reg.hard else "warning",
                    rationale="The check could not run, so it cannot vouch for readiness.",
                    error=f"{type(e).__name__}: {e}",
                )
            )
            continue
        results.append(CheckResult(key=reg.key, hard=reg.hard, **outcome.model_dump()))
    return ReadinessReport(results=results)
