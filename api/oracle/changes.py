"""Change events: the hook where v2 lanes meet without calling each other's code.

A lane that changes something other outputs depend on records it::

    await changes.record_change(
        db, "document_section", cause="section_edited", actor=principal,
        subject_ref="checkout-redesign@4#goal-trace", document_id=doc.id,
        data={"before_hash": old, "after_hash": new},
    )

``record_change`` stores a :class:`~oracle.v2.models.ChangeEvent` and awaits every
registered handler, in registration order, in the same session and transaction. A
handler that raises aborts the change: the caller's transaction rolls back, so a change
never commits without its consequences (stale artifacts, invalidated approvals).

Lanes register handlers once, at import time of a module ``oracle.main`` imports (their
router module, say)::

    changes.register_handler("trace.mark_stale", mark_stale)
    changes.register_handler(
        "review.invalidate_approvals", invalidate, subjects={"document_section"}
    )

Handlers must stay within the event's company (the session is tenant-scoped) and must
not commit.
"""

import uuid
from collections.abc import Awaitable, Callable, Iterable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, get_args

from sqlalchemy.ext.asyncio import AsyncSession

from oracle.v2.models import ChangeEvent
from oracle.v2.schemas import ChangeSubject

if TYPE_CHECKING:
    from oracle.auth.deps import Principal

SUBJECTS: tuple[str, ...] = get_args(ChangeSubject)

Handler = Callable[[AsyncSession, ChangeEvent], Awaitable[None]]


@dataclass(frozen=True)
class Registration:
    name: str
    handler: Handler
    # None: every subject.
    subjects: frozenset[str] | None


_handlers: list[Registration] = []


class UnknownSubjectError(ValueError):
    pass


def _check_subjects(subjects: Iterable[str]) -> frozenset[str]:
    subjects = frozenset(subjects)
    if unknown := subjects - set(SUBJECTS):
        raise UnknownSubjectError(f"unknown change subjects: {', '.join(sorted(unknown))}")
    return subjects


def register_handler(name: str, handler: Handler, *, subjects: Iterable[str] | None = None) -> None:
    """Run ``handler`` for every recorded change (or only those ``subjects``).

    Registering the same name again replaces the earlier handler (module reloads).
    """
    reg = Registration(name, handler, None if subjects is None else _check_subjects(subjects))
    for i, existing in enumerate(_handlers):
        if existing.name == name:
            _handlers[i] = reg
            return
    _handlers.append(reg)


def unregister_handler(name: str) -> None:
    _handlers[:] = [r for r in _handlers if r.name != name]


def handlers() -> list[Registration]:
    return list(_handlers)


@contextmanager
def isolated_handlers() -> Iterator[None]:
    """Tests: start with no handlers and restore the registry afterwards."""
    saved = list(_handlers)
    _handlers.clear()
    try:
        yield
    finally:
        _handlers[:] = saved


def _actor(actor: "Principal | str | None") -> str:
    if actor is None:
        return "system"
    if isinstance(actor, str):
        return actor
    return actor.actor


async def record_change(
    db: AsyncSession,
    subject_kind: str,
    *,
    cause: str,
    actor: "Principal | str | None",
    subject_id: uuid.UUID | None = None,
    subject_ref: str | None = None,
    document_id: uuid.UUID | None = None,
    data: dict[str, Any] | None = None,
) -> ChangeEvent:
    """Store a change event and await the handlers for its subject. The caller commits.

    ``actor`` is a principal, an audit actor string (``"run:<uuid>"``) or ``None``
    (``"system"``).
    """
    _check_subjects([subject_kind])
    if not cause:
        raise ValueError("a change needs a cause")
    event = ChangeEvent(
        subject_kind=subject_kind,
        subject_id=subject_id,
        subject_ref=subject_ref,
        document_id=document_id,
        cause=cause,
        actor=_actor(actor),
        data=data or {},
        handled_by=[],
    )
    db.add(event)
    await db.flush()
    ran: list[str] = []
    for reg in list(_handlers):
        if reg.subjects is not None and subject_kind not in reg.subjects:
            continue
        await reg.handler(db, event)
        ran.append(reg.name)
    event.handled_by = ran
    await db.flush()
    return event
