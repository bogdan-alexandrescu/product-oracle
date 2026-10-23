"""Delete, restore and purge (#482): one dependents resolver for the dialog, the delete
and the restore.

A delete moves the root (a document, an intake or a run) and everything that depends on it
to Trash in one :class:`~oracle.trash.models.TrashEntry`:

- a document: the documents built from any of its versions (a PRD's roadmaps and tech
  briefs, and theirs in turn), and the runs that write any of them. What hangs off those
  (versions, feedback, discussions, review campaigns, change sets, publications, draft
  roadmaps, spec requests) is left out of every read with them (oracle.trash.filter);
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
from oracle.docs.models import Document, DocumentVersion
from oracle.runs.models import Run
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
    """Documents built from any version of ``document_ids``, transitively."""
    seen = set(document_ids)
    found: list[Document] = []
    frontier = set(document_ids)
    while frontier:
        versions = select(DocumentVersion.id).where(DocumentVersion.document_id.in_(frontier))
        stmt = (
            select(Document)
            .join(DocumentVersion, DocumentVersion.document_id == Document.id)
            .where(DocumentVersion.source_version_id.in_(versions), Document.id.not_in(seen))
            .distinct()
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
    elif root_type == "intake":
        stmt = select(ProductIntake).where(ProductIntake.id == uuid.UUID(ref))
    else:
        stmt = select(Run).where(Run.id == uuid.UUID(ref))
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


def preview(resolved: Resolved) -> dict[str, Any]:
    """What the delete dialog lists."""
    rows = [r for r in resolved.rows() if r is not resolved.root]
    return {
        "root": describe(resolved.root),
        "items": [describe(r) for r in rows],
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
    entry = TrashEntry(
        id=uuid.uuid4(),
        root_type=root_type,
        root_id=root.id,
        # What it was built from outside this delete: Restore says if that is gone.
        root={**describe(root), "built_from": [describe(d) for d in sources]},
        items=[describe(r) for r in rows if r is not root],
        deleted_by=principal.id,
        deleted_by_name=await _actor_name(db, principal),
        reason=reason,
        published=resolved.published,
        purge_after=at + timedelta(days=RETENTION_DAYS),
    )
    entry.created_at = at
    db.add(entry)
    await db.flush()
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


def _models() -> tuple[type, ...]:
    return (Document, ProductIntake, Run)


async def get_entry(db: AsyncSession, entry_id: uuid.UUID) -> TrashEntry:
    entry = await db.get(TrashEntry, entry_id)
    if entry is None:
        raise NotFound("Not in Trash")
    return entry


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


async def restore_entry(
    db: AsyncSession, principal: Principal, entry_id: uuid.UUID
) -> tuple[TrashEntry, list[dict[str, Any]]]:
    """Bring the entry's root and everything that went with it back; with what could not
    come back with it (:func:`_not_restored`)."""
    entry = await get_entry(db, entry_id)
    for model in _models():
        await db.execute(
            update(model)
            .where(model.trash_entry_id == entry.id)
            .values(deleted_at=None, deleted_by=None, deleted_reason=None, trash_entry_id=None)
            .execution_options(synchronize_session=False)
        )
    not_restored = await _not_restored(db, entry)
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
    """Delete the entry's rows for good (what hangs off them goes by cascade)."""
    for model in (Run, Document, ProductIntake):
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


async def list_entries(db: AsyncSession) -> list[TrashEntry]:
    stmt = select(TrashEntry).order_by(TrashEntry.created_at.desc(), TrashEntry.id)
    return list(await db.scalars(stmt))
