"""The event types a webhook may subscribe to (I1 v1), as a fixed registry.

Each type names its group (the New webhook sheet's Runs · Drafts · Approvals), a label,
its payload model (:mod:`oracle.webhooks.schemas`) and how its subject is checked against
the owners-and-approvers rule (Q2): an event is approvers-only when its subject is hidden
from a commenter (:data:`oracle.docs.visibility.MEMBER`):

- a document with ``visibility = 'approvers'``;
- a run whose document is such a document, or of a flow that only drafts them
  (:data:`APPROVERS_FLOWS`);
- a checkpoint of a kind that belongs to them (:data:`APPROVERS_CHECKPOINTS`).

Such an event goes only to a webhook an owner opted in. The check runs at capture (the
event row's ``approvers_only``) and again at send. A new type must declare its check
here, or tests.test_webhooks_events fails. ``GET /v1/webhook-event-types`` and the
Settings screen read this registry; later picks add their types to it.
"""

import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.docs import visibility
from oracle.docs.models import Document
from oracle.runs.models import Checkpoint, Run
from oracle.webhooks import schemas

# Flows that only draft owners-and-approvers documents (an update, a pricing memo).
APPROVERS_FLOWS = frozenset({"update_draft", "pricing_memo"})
# Checkpoint kinds of those documents.
APPROVERS_CHECKPOINTS = frozenset({"update_review", "pricing_review"})

Check = Callable[[AsyncSession, dict[str, Any]], Awaitable[bool]]


@dataclass(frozen=True)
class EventType:
    type: str
    group: str
    label: str
    check: Check
    payload: type[BaseModel]
    # Whether the check can ever answer True (the Settings screen's lock hint).
    can_be_approvers_only: bool = True


def _uuid(value: Any) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(value)) if value else None
    except ValueError:
        return None


async def _document_hidden(db: AsyncSession, document_id: uuid.UUID | None) -> bool:
    """Whether a commenter may not see the document. A missing one is hidden: nothing is
    said about what cannot be read."""
    if document_id is None:
        return True
    shown = await db.scalar(
        select(Document.visibility)
        .where(Document.id == document_id)
        .execution_options(oracle_all_documents=True)
    )
    return shown != visibility.COMPANY


async def _run_hidden(db: AsyncSession, run_id: uuid.UUID | None) -> bool:
    if run_id is None:
        return True
    row = (
        await db.execute(
            select(Run.flow, Run.document_id)
            .where(Run.id == run_id)
            .execution_options(oracle_all_documents=True)
        )
    ).first()
    if row is None:
        return True
    flow, document_id = row
    if flow in APPROVERS_FLOWS:
        return True
    return document_id is not None and await _document_hidden(db, document_id)


async def run_subject(db: AsyncSession, subject: dict[str, Any]) -> bool:
    return await _run_hidden(db, _uuid(subject.get("run_id")))


async def checkpoint_subject(db: AsyncSession, subject: dict[str, Any]) -> bool:
    if await _run_hidden(db, _uuid(subject.get("run_id"))):
        return True
    checkpoint_id = _uuid(subject.get("checkpoint_id"))
    if checkpoint_id is None:
        return True
    kind = await db.scalar(select(Checkpoint.kind).where(Checkpoint.id == checkpoint_id))
    return kind is None or kind in APPROVERS_CHECKPOINTS


async def document_subject(db: AsyncSession, subject: dict[str, Any]) -> bool:
    return await _document_hidden(db, _uuid(subject.get("document_id")))


def _type(name: str, group: str, label: str, check: Check, data: type[BaseModel]) -> EventType:
    return EventType(name, group, label, check, schemas.payload_model(name, data))


EVENT_TYPES: dict[str, EventType] = {
    et.type: et
    for et in (
        _type(
            "run.awaiting_approval",
            "runs",
            "A run's estimate is over the limit and waits for an owner",
            run_subject,
            schemas.WebhookRunData,
        ),
        _type("run.started", "runs", "A run started", run_subject, schemas.WebhookRunData),
        _type(
            "run.checkpoint_waiting",
            "runs",
            "A run is waiting at a checkpoint for a person",
            checkpoint_subject,
            schemas.WebhookCheckpointData,
        ),
        _type(
            "run.checkpoint_decided",
            "runs",
            "A checkpoint was approved or sent back with changes",
            checkpoint_subject,
            schemas.WebhookCheckpointData,
        ),
        _type(
            "run.checkpoint_voided",
            "runs",
            "A checkpoint decision was voided by a disable or demotion",
            checkpoint_subject,
            schemas.WebhookCheckpointData,
        ),
        _type(
            "run.paused_overrun",
            "runs",
            "A run passed its spend limit; an owner must resume it",
            run_subject,
            schemas.WebhookRunData,
        ),
        _type("run.resumed", "runs", "An owner resumed a run", run_subject, schemas.WebhookRunData),
        _type("run.succeeded", "runs", "A run succeeded", run_subject, schemas.WebhookRunData),
        _type("run.failed", "runs", "A run failed", run_subject, schemas.WebhookRunData),
        _type("run.cancelled", "runs", "A run was cancelled", run_subject, schemas.WebhookRunData),
        _type(
            "draft.version_created",
            "drafts",
            "A new version of a document was imported",
            document_subject,
            schemas.WebhookDocumentData,
        ),
        _type(
            "draft.in_review",
            "drafts",
            "A document moved to In review",
            document_subject,
            schemas.WebhookDocumentData,
        ),
        _type(
            "approval.version_approved",
            "approvals",
            "A version was approved",
            document_subject,
            schemas.WebhookApprovalData,
        ),
        _type(
            "approval.approvals_invalidated",
            "approvals",
            "Approvals on a version lapsed or were voided",
            document_subject,
            schemas.WebhookInvalidatedData,
        ),
        _type(
            "approval.version_published",
            "approvals",
            "A version was published",
            document_subject,
            schemas.WebhookDocumentData,
        ),
    )
}


async def approvers_only(db: AsyncSession, event_type: str, subject: dict[str, Any]) -> bool:
    """Whether an event of ``event_type`` about ``subject`` is about owners-and-approvers
    content, for the subject's current state."""
    return await EVENT_TYPES[event_type].check(db, subject)
