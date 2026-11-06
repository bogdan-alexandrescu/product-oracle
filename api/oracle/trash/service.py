"""Delete, restore and purge (#482): one dependents resolver for the dialog, the delete
and the restore.

A delete moves the root (a document, an intake or a run) and everything that depends on it
to Trash in one :class:`~oracle.trash.models.TrashEntry`:

- a document: the documents built from any of its versions and its spec requests' tech
  briefs (a PRD's roadmaps and tech briefs, and theirs in turn), and the runs that write
  any of them. What hangs off those (versions, feedback, discussions, review campaigns,
  change sets, publications, draft roadmaps, spec requests) is left out of every read
  with them (oracle.trash.filter);
- an intake: the document it became, with that document's dependents;
- a run: itself (its checkpoints and segments leave the Inbox with it).

A run still working is never trashed (cancel it first), nor is a document a working run
writes. Restore brings the entry back together; the ticker purges it after
:data:`~oracle.trash.models.RETENTION_DAYS` days.
"""

import math
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import Text, cast, delete, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.auth.deps import Principal
from oracle.authz import has_role
from oracle.docs.models import Document, DocumentVersion
from oracle.runs.models import Run
from oracle.runs.service import creator_only_visible
from oracle.trash.filter import INCLUDE_TRASHED
from oracle.trash.models import RETENTION_DAYS, TrashEntry
from oracle.v2.models import ProductIntake

ALL = {INCLUDE_TRASHED: True}
# A run in one of these is working: cancel it before it goes to Trash.
WORKING = ("awaiting_approval", "running", "awaiting_checkpoint", "paused_overrun")
PUBLISHED_WARNING = (
    "This document is published. Deleting it moves it to Trash here only: the external "
    "copy (Notion, Google Docs, Slack) stays where it is. Confirm to delete it."
)


class TrashError(Exception):
    status = 400


class NotFound(TrashError):
    status = 404


class Forbidden(TrashError):
    status = 403


class Conflict(TrashError):
    status = 409


class Invalid(TrashError):
    status = 422


def now() -> datetime:
    """The clock (tests freeze it)."""
    return datetime.now(UTC)


@dataclass
class Resolved:
    root_type: str
    root: Any
    documents: list[Document] = field(default_factory=list)
    intakes: list[ProductIntake] = field(default_factory=list)
    runs: list[Run] = field(default_factory=list)
    published: bool = False

    def rows(self) -> list[Any]:
        return [*self.documents, *self.intakes, *self.runs]


def describe(row: Any) -> dict[str, Any]:
    from oracle.baseline.models import Entity
    from oracle.roadmap.models import RoadmapItem

    if isinstance(row, (RoadmapItem, Entity)):
        from oracle.simple import trash_items

        return trash_items.describe(row)
    from oracle.decisions.models import Decision

    if isinstance(row, Decision):
        from oracle.simple import decision_sheet

        return decision_sheet.describe(row)
    from oracle.requests.models import ProductRequest

    if isinstance(row, ProductRequest):
        from oracle.requests import service as requests_service

        return requests_service.describe_for_trash(row)
    if isinstance(row, Document):
        return {
            "type": "document",
            "id": str(row.id),
            "slug": row.slug,
            "title": row.title,
            "kind": row.kind,
        }
    if isinstance(row, ProductIntake):
        return {"type": "intake", "id": str(row.id), "slug": None, "title": row.title,
                "kind": "intake"}  # fmt: skip
    return {"type": "run", "id": str(row.id), "slug": None, "title": row.flow, "kind": row.flow}


async def published_ids(db: AsyncSession, ids: set[uuid.UUID]) -> set[uuid.UUID]:
    """The documents of ``ids`` with a publication (an external copy may exist)."""
    from oracle.review.models import DocumentPublication

    if not ids:
        return set()
    stmt = select(DocumentPublication.document_id).where(DocumentPublication.document_id.in_(ids))
    return set(await db.scalars(stmt.execution_options(**ALL)))


async def _derived(db: AsyncSession, document_ids: set[uuid.UUID]) -> list[Document]:
    """Documents built from any version of ``document_ids``, and their tech briefs (a spec
    request's ``params["document_id"]``: the spec import sets no source on their versions),
    transitively."""
    from oracle.v2.models import ArtifactRequest

    seen = set(document_ids)
    found: list[Document] = []
    frontier = set(document_ids)
    while frontier:
        versions = select(DocumentVersion.id).where(DocumentVersion.document_id.in_(frontier))
        built = select(DocumentVersion.document_id).where(
            DocumentVersion.source_version_id.in_(versions)
        )
        specs = select(_spec_document()).where(ArtifactRequest.source_document_id.in_(frontier))
        stmt = (
            select(Document)
            .where(
                or_(Document.id.in_(built), cast(Document.id, Text).in_(specs)),
                Document.id.not_in(seen),
            )
            .order_by(Document.id)
        )
        rows = list(await db.scalars(stmt))
        frontier = {d.id for d in rows}
        seen |= frontier
        found += rows
    return sorted(found, key=lambda d: (d.kind, d.slug))


def _spec_document() -> Any:
    from oracle.v2.models import ArtifactRequest

    return ArtifactRequest.params["document_id"].astext


async def _built_from(db: AsyncSession, document_ids: set[uuid.UUID]) -> list[Document]:
    """The documents ``document_ids`` were built from, outside them: the source of any of
    their versions, and a tech brief's PRD (its spec request's)."""
    from oracle.v2.models import ArtifactRequest

    if not document_ids:
        return []
    versions = select(DocumentVersion.document_id).where(
        DocumentVersion.id.in_(
            select(DocumentVersion.source_version_id).where(
                DocumentVersion.document_id.in_(document_ids)
            )
        )
    )
    specs = select(ArtifactRequest.source_document_id).where(
        _spec_document().in_([str(i) for i in document_ids])
    )
    stmt = select(Document).where(
        or_(Document.id.in_(versions), Document.id.in_(specs)),
        Document.id.not_in(document_ids),
    )
    return sorted(await db.scalars(stmt), key=lambda d: (d.kind, d.slug))


async def _runs_of(db: AsyncSession, document_ids: set[uuid.UUID]) -> list[Run]:
    if not document_ids:
        return []
    stmt = select(Run).where(Run.document_id.in_(document_ids)).order_by(Run.created_at)
    return list(await db.scalars(stmt))


async def find_root(db: AsyncSession, root_type: str, ref: str, *, trashed: bool = False) -> Any:
    """The document (slug or id), intake or run named, live or (``trashed``) in Trash."""
    from oracle.docs.parser import is_uuid

    if root_type == "document":
        column = Document.id if is_uuid(ref) else Document.slug
        stmt: Any = select(Document).where(column == (uuid.UUID(ref) if is_uuid(ref) else ref))
    elif not is_uuid(ref):
        raise NotFound(f"{root_type} '{ref}' not found")
    elif root_type in ("feature", "goal"):
        # trash-features-goals (oracle.simple.trash_items): a roadmap feature or a goal.
        kind = _feature_goal_models()[root_type]
        stmt = select(kind).where(kind.id == uuid.UUID(ref))  # type: ignore[attr-defined]
        if root_type == "goal":
            stmt = stmt.where(kind.type == "goal")  # type: ignore[attr-defined]
    elif root_type in ("decision", "question"):
        # edit-decisions (oracle.simple.decision_sheet): a decision or a PRD question.
        from oracle.decisions.models import Decision

        stmt = select(Decision).where(Decision.id == uuid.UUID(ref))
        prd = Decision.origin == "prd"
        stmt = stmt.where(prd if root_type == "question" else ~prd)
    elif root_type == "intake":
        stmt = select(ProductIntake).where(ProductIntake.id == uuid.UUID(ref))
    else:
        stmt = select(Run).where(Run.id == uuid.UUID(ref))
        # #689 review: as the run routes, another member's run of a flow private to its
        # creator (Oracle's read of an intake) is not found.
        if (private := creator_only_visible(db)) is not None:
            stmt = stmt.where(private)
    model = stmt.column_descriptions[0]["entity"]
    if trashed:
        stmt = stmt.where(model.deleted_at.is_not(None)).execution_options(**ALL)
    row = await db.scalar(stmt)
    if row is None:
        raise NotFound(f"{root_type} '{ref}' not found" + (" in Trash" if trashed else ""))
    return row


async def resolve(db: AsyncSession, root_type: str, root: Any) -> Resolved:
    """The root and everything that goes to Trash with it."""
    out = Resolved(root_type, root)
    if root_type == "run":
        out.runs = [root]
        return out
    tops: list[Document] = []
    if root_type == "intake":
        out.intakes = [root]
        if root.document_id is not None:
            doc = await db.scalar(select(Document).where(Document.id == root.document_id))
            if doc is not None:
                tops = [doc]
    else:
        tops = [root]
    if tops:
        derived = await _derived(db, {d.id for d in tops})
        out.documents = [*tops, *derived]
    ids = {d.id for d in out.documents}
    out.runs = await _runs_of(db, ids)
    out.published = bool(await published_ids(db, ids))
    return out


def _said(resolved: Resolved, row: Any) -> dict[str, Any]:
    """An item as the delete dialog and Trash name it. qa4-docs-26, F-69: a run says when it
    ran and which document it wrote, in both."""
    if isinstance(row, Run):
        titles = {d.id: d.title for d in resolved.documents}
        return {**describe(row), "created_at": row.created_at.isoformat(),
                "wrote": titles.get(row.document_id)}  # fmt: skip
    return describe(row)


def preview(resolved: Resolved) -> dict[str, Any]:
    """What the delete dialog lists."""
    rows = [r for r in resolved.rows() if r is not resolved.root]
    return {
        "root": describe(resolved.root),
        "items": [_said(resolved, r) for r in rows],
        "published": resolved.published,
        "working_runs": [str(r.id) for r in resolved.runs if r.status in WORKING],
    }


async def _actor_name(db: AsyncSession, principal: Principal) -> str | None:
    from oracle.auth.models import ApiToken, User

    if principal.user_id is not None:
        user = await db.get(User, principal.user_id)
        return (getattr(user, "name", None) or user.email) if user else None
    if principal.token_id is not None:
        token = await db.get(ApiToken, principal.token_id)
        return f"API token {token.name}" if token else None
    return None


async def delete_root(
    db: AsyncSession,
    principal: Principal,
    root_type: str,
    ref: str,
    *,
    reason: str | None = None,
    confirm_published: bool = False,
) -> TrashEntry:
    root = await find_root(db, root_type, ref)
    resolved = await resolve(db, root_type, root)
    working = [r for r in resolved.runs if r.status in WORKING]
    if working:
        raise Conflict(
            f"A run is still working on this ({working[0].flow}, {working[0].status}): "
            "cancel it first"
        )
    if resolved.published and not confirm_published:
        raise Conflict(PUBLISHED_WARNING)
    at = now()
    rows = resolved.rows()
    sources = await _built_from(db, {d.id for d in resolved.documents})
    # inbox-trashed-track: the open alerts of a track whose PRD or roadmap goes close now
    # (before the documents leave every read), and a restore reopens them.
    from oracle.roadmap import alerts

    closed = await alerts.close_for_trash(db, {d.id for d in resolved.documents}, at)
    # New PRD (4): the requests linked to these PRDs are released; a restore links back
    # each one still free.
    from oracle.requests import service as requests_service

    released = await requests_service.release_documents(
        db, principal, {d.id for d in resolved.documents}
    )
    entry = TrashEntry(
        id=uuid.uuid4(),
        root_type=root_type,
        root_id=root.id,
        # What it was built from outside this delete: Restore says if that is gone.
        root={
            **describe(root),
            "built_from": [describe(d) for d in sources],
            # Track alerts it closed: a restore reopens them.
            "closed_alerts": closed,
            # Requests it released: a restore links back the ones still free.
            "released_requests": released,
        },
        items=[_said(resolved, r) for r in rows if r is not root],
        deleted_by=principal.id,
        deleted_by_name=await _actor_name(db, principal),
        reason=reason,
        published=resolved.published,
        purge_after=at + timedelta(days=RETENTION_DAYS),
    )
    entry.created_at = at
    db.add(entry)
    await db.flush()
    # O5: every share link on a trashed document ends at once; a restore brings none back.
    from oracle.shares import service as shares

    await shares.revoke_documents(
        db, principal, {d.id for d in resolved.documents}, shares.DOCUMENT_TRASHED
    )
    for row in rows:
        row.deleted_at = at
        row.deleted_by = principal.id
        row.deleted_reason = reason
        row.trash_entry_id = entry.id
    await audit.record(
        db,
        principal,
        "trash.delete",
        root_type,
        root.id,
        {"entry_id": str(entry.id), "root": entry.root, "items": entry.items, "reason": reason},
    )
    await db.flush()
    return entry


async def trashed_documents(db: AsyncSession, ids: set[uuid.UUID]) -> dict[uuid.UUID, Document]:
    """Those of these documents that are in Trash (a request's conflict names its PRD)."""
    if not ids:
        return {}
    rows = await db.scalars(
        select(Document)
        .where(Document.id.in_(ids), Document.deleted_at.is_not(None))
        .execution_options(**ALL)
    )
    return {d.id: d for d in rows}


def _feature_goal_models() -> dict[str, type]:
    from oracle.baseline.models import Entity
    from oracle.roadmap.models import RoadmapItem

    return {"feature": RoadmapItem, "goal": Entity}


def _decision_model() -> type:
    from oracle.decisions.models import Decision

    return Decision


def _request_model() -> type:
    from oracle.requests.models import ProductRequest

    return ProductRequest


def _models() -> tuple[type, ...]:
    return (
        Document,
        ProductIntake,
        Run,
        *_feature_goal_models().values(),
        _decision_model(),
        _request_model(),
    )


async def get_entry(db: AsyncSession, entry_id: uuid.UUID) -> TrashEntry:
    entry = await db.get(TrashEntry, entry_id)
    if entry is None or entry.root_id in await _hidden_runs(db, [entry]):
        raise NotFound("Not in Trash")
    return entry


async def _hidden_runs(db: AsyncSession, entries: list[TrashEntry]) -> set[uuid.UUID]:
    """The entries' root runs the session's principal may not see (#689 review: another
    member's run of a flow private to its creator), as :func:`find_root` does."""
    ids = [e.root_id for e in entries if e.root_type == "run"]
    if not ids or (private := creator_only_visible(db)) is None:
        return set()
    stmt = select(Run.id).where(Run.id.in_(ids), ~private).execution_options(**ALL)
    return set(await db.scalars(stmt))


async def _not_restored(db: AsyncSession, entry: TrashEntry) -> list[dict[str, Any]]:
    """What did not come back with ``entry``: what it was built from, purged meanwhile or
    still in Trash, and what was built from it and went to Trash in a separate delete."""
    out: list[dict[str, Any]] = []
    for source in entry.root.get("built_from") or []:
        row = await db.scalar(
            select(Document).where(Document.id == uuid.UUID(source["id"])).execution_options(**ALL)
        )
        if row is None:
            reason = (
                f"'{source['title']}', which it was built from, was deleted for good: it "
                "is back without it"
            )
        elif row.deleted_at is not None:
            reason = (
                f"'{source['title']}', which it was built from, is still in Trash (deleted "
                "separately): restore it from Trash to bring it back"
            )
        else:
            continue
        out.append({"item": source, "reason": reason})
    ids = [uuid.UUID(i["id"]) for i in (entry.root, *entry.items) if i["type"] == "document"]
    if ids:
        from oracle.v2.models import ArtifactRequest

        built = select(DocumentVersion.document_id).where(
            DocumentVersion.source_version_id.in_(
                select(DocumentVersion.id).where(DocumentVersion.document_id.in_(ids))
            )
        )
        specs = select(_spec_document()).where(ArtifactRequest.source_document_id.in_(ids))
        stmt = (
            select(Document)
            .where(
                or_(Document.id.in_(built), cast(Document.id, Text).in_(specs)),
                Document.deleted_at.is_not(None),
                Document.trash_entry_id.is_distinct_from(entry.id),
            )
            .execution_options(**ALL)
        )
        for row in sorted(await db.scalars(stmt), key=lambda d: (d.kind, d.slug)):
            out.append(
                {
                    "item": describe(row),
                    "reason": f"'{row.title}' was deleted separately: it stays in Trash, "
                    "restore it from there",
                }
            )
    return out


# trash-features-goals (owner's answer, Nov 5): whoever deleted a feature or a goal restores
# it too (edit-decisions: and a decision or a PRD question); everything else in Trash is the
# owners' alone. port-an-decisions: and a meeting's agenda item (a request is an owner's
# delete).
OWN_RESTORE = frozenset({"feature", "goal", "decision", "question", "agenda_item"})


def may_restore(principal: Any, entry: TrashEntry) -> bool:
    """An owner restores anything; whoever deleted a feature or a goal restores it too."""
    if has_role(principal.role, "owner"):
        return True
    mine = entry.deleted_by is not None and entry.deleted_by == getattr(principal, "id", None)
    return mine and entry.root_type in OWN_RESTORE


async def restore_entry(
    db: AsyncSession, principal: Principal, entry_id: uuid.UUID
) -> tuple[TrashEntry, list[dict[str, Any]]]:
    """Bring the entry's root and everything that went with it back; with what could not
    come back with it (:func:`_not_restored`). Refused unless :func:`may_restore`."""
    entry = await get_entry(db, entry_id)
    if not may_restore(principal, entry):
        raise Forbidden("Only an owner, or whoever deleted it, restores this")
    from oracle.simple import trash_items

    await trash_items.before_restore(db, entry)
    if entry.root_type == "agenda_item":
        # port-an-decisions: the row goes back onto its meeting's agenda.
        from oracle.simple import meetings

        await meetings.restore_agenda_item(db, entry)
    for model in _models():
        await db.execute(
            update(model)
            .where(model.trash_entry_id == entry.id)
            .values(deleted_at=None, deleted_by=None, deleted_reason=None, trash_entry_id=None)
            .execution_options(synchronize_session=False)
        )
    from oracle.roadmap import alerts

    dropped = await trash_items.after_restore(db, entry, principal)
    await alerts.reopen_after_trash(db, entry.root.get("closed_alerts") or [])
    from oracle.requests import service as requests_service

    await requests_service.relink_documents(
        db, principal, entry.root.get("released_requests") or []
    )
    not_restored = [*dropped, *await _not_restored(db, entry)]
    await audit.record(
        db,
        principal,
        "trash.restore",
        entry.root_type,
        entry.root_id,
        {
            "entry_id": str(entry.id),
            "root": entry.root,
            "items": entry.items,
            "not_restored": not_restored,
        },
    )
    await db.delete(entry)
    await db.flush()
    return entry, not_restored


async def restore_root(
    db: AsyncSession, principal: Principal, root_type: str, ref: str
) -> tuple[TrashEntry, list[dict[str, Any]]]:
    """Restore whatever went to Trash with this document, intake or run."""
    row = await find_root(db, root_type, ref, trashed=True)
    if row.trash_entry_id is None:
        raise NotFound(f"{root_type} '{ref}' not found in Trash")
    return await restore_entry(db, principal, row.trash_entry_id)


async def purge_entry(
    db: AsyncSession, principal: Principal | str | None, entry: TrashEntry
) -> None:
    """Delete the entry's rows for good (what hangs off them goes by cascade; a feature's
    milestones and dependents drop it first)."""
    from oracle.simple import trash_items

    await trash_items.before_purge(db, entry)
    for model in (
        Run,
        Document,
        ProductIntake,
        *_feature_goal_models().values(),
        _decision_model(),
        _request_model(),
    ):
        await db.execute(
            delete(model)
            .where(model.trash_entry_id == entry.id, model.deleted_at.is_not(None))
            .execution_options(synchronize_session=False, **ALL)
        )
    await audit.record(
        db,
        principal,
        "trash.purge",
        entry.root_type,
        entry.root_id,
        {"entry_id": str(entry.id), "root": entry.root, "items": entry.items},
    )
    await db.delete(entry)
    await db.flush()


async def purge_due(db: AsyncSession) -> int:
    """The ticker's part: purge what has waited in Trash for its 30 days. Each entry in
    its own savepoint: one that cannot be purged stays, and the others still go."""
    import logging

    due = list(
        await db.scalars(
            select(TrashEntry)
            .where(TrashEntry.purge_after <= now())
            .order_by(TrashEntry.purge_after)
        )
    )
    purged = 0
    for entry in due:
        try:
            async with db.begin_nested():
                await purge_entry(db, audit.ORACLE, entry)
            purged += 1
        except Exception:
            logging.getLogger(__name__).exception("trash: could not purge entry %s", entry.id)
    await db.commit()
    return purged


def days_left(entry: TrashEntry) -> int:
    seconds = (entry.purge_after - now()).total_seconds()
    return max(0, math.ceil(seconds / 86400))


async def list_entries(db: AsyncSession, principal: Any = None) -> list[TrashEntry]:
    """Everything in Trash, newest first; for ``principal`` below owner, only the features
    and goals they deleted (:func:`may_restore`)."""
    stmt = select(TrashEntry).order_by(TrashEntry.created_at.desc(), TrashEntry.id)
    if principal is not None and not has_role(principal.role, "owner"):
        stmt = stmt.where(
            TrashEntry.deleted_by == principal.id, TrashEntry.root_type.in_(OWN_RESTORE)
        )
    entries = list(await db.scalars(stmt))
    hidden = await _hidden_runs(db, entries)
    return [e for e in entries if e.root_id not in hidden]


async def highest_decision_number(db: AsyncSession) -> int | None:
    """The highest decision number, a trashed PRD's open questions' too (the filter hides
    them; a new decision's number must still be new)."""
    from sqlalchemy import func

    from oracle.decisions.models import Decision

    return await db.scalar(select(func.max(Decision.number)).execution_options(**ALL))


async def only_in_trash(db: AsyncSession, kind: str) -> bool:
    """Every document of this kind is in Trash (and there is at least one): a review of
    them reviews what is in Trash (Home's "Next review meeting")."""
    kinds = await db.scalars(
        select(Document.deleted_at).where(Document.kind == kind).execution_options(**ALL)
    )
    at = list(kinds)
    return bool(at) and all(d is not None for d in at)


async def deleted_for_good(db: AsyncSession, kind: str) -> bool:
    """No document of this kind is left, live or in Trash, and one was purged: a review of
    them reviews what was deleted for good (Home's "Next review meeting")."""
    from oracle.models import AuditEvent

    left = await db.scalar(
        select(Document.id).where(Document.kind == kind).limit(1).execution_options(**ALL)
    )
    if left is not None:
        return False
    purged = await db.scalar(
        select(AuditEvent.id)
        .where(
            AuditEvent.action == "trash.purge",
            (AuditEvent.data["root"]["kind"].astext == kind)
            | AuditEvent.data["items"].contains([{"kind": kind}]),
        )
        .limit(1)
    )
    return purged is not None
