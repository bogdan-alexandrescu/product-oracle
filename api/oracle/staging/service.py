"""G4 One staging list.

- **From a discussion** (G3's Suggest and Stage call these): an item change becomes a D8
  action through D8's own service (:func:`oracle.runs.actions.put_action`), so revision,
  roles, tally and history behave exactly as for row actions; a ``section_edit`` becomes a
  ``next_draft_changes`` row the document's next draft builds with C1e's suggestions.
- **One read** (:func:`staging_list`): everything staged for one document or checkpoint,
  from C1e's suggestions, ``next_draft_changes`` and D8's actions, each row once.
- **Who sees what**: a row from a private discussion the reader is not in shows only that
  it came from a private discussion. ``from_private`` records how it was staged and is
  never rewritten; what readers see follows the discussion's visibility now.

The writes commit (D8's do too); the read does not write.
"""

import uuid
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any, Protocol

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.authz import has_role
from oracle.discussions.models import Discussion, DiscussionChange, DiscussionParticipant
from oracle.docs.models import Document, DocumentVersion
from oracle.runs.models import Checkpoint, CheckpointAction
from oracle.staging import hooks, mapping
from oracle.staging.models import NextDraftChange
from oracle.staging.schemas import (
    NextDraftChangeOut,
    StagingCounts,
    StagingDiscussion,
    StagingItem,
    StagingList,
    StagingPerson,
    StagingTarget,
)

if TYPE_CHECKING:
    from oracle.auth.deps import Principal

PRIVATE_LINE = "From a private discussion"
NOT_STAGED = "This change is not staged"
CHANGED = "This change changed since you loaded it; look again"
NOT_AVAILABLE = "Item changes on an approved roadmap wait for its re-plan"


class StagingError(Exception):
    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


def _now() -> datetime:
    return datetime.now(UTC)


# --- the list merge ------------------------------------------------------------------------


class _Row(Protocol):
    id: Any
    at: Any


@dataclass
class ListRow:
    id: uuid.UUID
    at: Any


def merge[R: _Row](*stores: Iterable[R]) -> list[R]:
    """The rows of every store, each once (by id), oldest first."""
    seen: dict[Any, R] = {}
    for rows in stores:
        for r in rows:
            seen.setdefault(r.id, r)
    return sorted(seen.values(), key=lambda r: (r.at is None, r.at or 0, str(r.id)))


# --- who sees which discussion -------------------------------------------------------------


async def discussion_views(
    db: AsyncSession, principal: "Principal | None", ids: Sequence[uuid.UUID | None]
) -> dict[uuid.UUID, StagingDiscussion]:
    """Each discussion as the reader sees it now: its id and title, or for a private one
    the reader is not in, only that it is private."""
    wanted = list({i for i in ids if i})
    if not wanted:
        return {}
    found = list(await db.scalars(select(Discussion).where(Discussion.id.in_(wanted))))
    mine: set[uuid.UUID] = set()
    if principal is not None and principal.user_id is not None:
        mine = set(
            await db.scalars(
                select(DiscussionParticipant.discussion_id).where(
                    DiscussionParticipant.discussion_id.in_(wanted),
                    DiscussionParticipant.user_id == principal.user_id,
                    DiscussionParticipant.left_at.is_(None),
                )
            )
        )
    out = {}
    for d in found:
        private = d.visibility == "private"
        if private and d.id not in mine:
            out[d.id] = StagingDiscussion(id=None, title=None, private=True)
        else:
            out[d.id] = StagingDiscussion(id=d.id, title=d.title, private=private)
    return out


def origin_line(view: StagingDiscussion | None) -> str | None:
    if view is None:
        return None
    if view.title is None:
        return PRIVATE_LINE
    return f"From discussion {view.title}"


async def _people(db: AsyncSession, ids: Iterable[uuid.UUID | None]) -> dict[uuid.UUID, str]:
    from oracle.runs.actions import _people as people

    return {k: v.name for k, v in (await people(db, [i for i in ids if i])).items()}


def _person(names: dict[uuid.UUID, str], i: uuid.UUID | None) -> StagingPerson | None:
    if i is None:
        return None
    return StagingPerson(user_id=i, name=names.get(i, "Someone"))


# --- from a discussion ---------------------------------------------------------------------


async def _pending(db: AsyncSession, d: Discussion, kind: str) -> Checkpoint:
    from oracle.runs.actions import KIND_WORDS

    if d.subject_kind == "roadmap_item":
        raise StagingError(422, NOT_AVAILABLE)
    if d.subject_kind not in ("checkpoint", "checkpoint_item") or d.run_id is None:
        raise StagingError(422, "Item changes are staged at a checkpoint of a run")
    wanted = mapping.CHECKPOINT_KIND[kind]
    cp = await db.scalar(
        select(Checkpoint)
        .where(
            Checkpoint.run_id == d.run_id,
            Checkpoint.kind == wanted,
            Checkpoint.status == "pending",
        )
        .order_by(Checkpoint.created_at.desc())
        .limit(1)
    )
    if cp is None:
        raise StagingError(
            409, f"No {KIND_WORDS.get(wanted, wanted)} checkpoint is waiting in this run"
        )
    return cp


async def _to_checkpoint(
    db: AsyncSession,
    principal: "Principal",
    change: DiscussionChange,
    reason: str | None,
    stage: bool,
) -> CheckpointAction:
    from oracle.runs import actions
    from oracle.runs.service import RunError

    d = await db.get(Discussion, change.discussion_id)
    cp = await _pending(db, d, change.kind)
    if stage and not has_role(principal.role, cp.approver_role):  # type: ignore[arg-type]
        raise StagingError(403, f"Requires the {cp.approver_role} role")
    item_key = (d.subject or {}).get("item_key")
    body = mapping.to_action(change.kind, change.edited_payload or change.payload, item_key)
    if reason is not None and reason.strip():
        body.note = reason.strip()
    source = actions.ActionSource(d.id, change.id, d.visibility == "private")
    try:
        return await actions.put_action(
            db, principal, d.run_id, cp.id, body, source=source, suggest_only=not stage
        )
    except RunError as e:
        raise StagingError(getattr(e, "status", 409), str(e)) from None


async def suggest_discussion_change(
    db: AsyncSession, principal: "Principal", change: DiscussionChange
) -> dict[str, str] | None:
    """A commenter's Suggest: a ``suggested`` D8 action at the checkpoint, shown on the
    item as "Suggested by <name>". Nothing for a next-draft change (the suggestion stays
    in the discussion)."""
    target = mapping.target_of(change.kind)
    if target is None:
        raise StagingError(422, f"A {change.kind} change is not staged")
    if target == "next_draft":
        return None
    action = await _to_checkpoint(db, principal, change, None, stage=False)
    ref = {"kind": "checkpoint_action", "id": str(action.id)}
    change = await db.get(DiscussionChange, change.id)
    change.status = "suggested"
    change.suggested_by = principal.id
    change.suggested_at = _now()
    change.result_ref = ref
    await db.commit()
    return ref


async def stage_discussion_change(
    db: AsyncSession,
    principal: "Principal",
    change: DiscussionChange,
    reason: str | None,
    override_reason: str | None,
) -> dict[str, str]:
    """An approver's Stage: the D8 action written or upgraded to ``staged``, or a
    ``next_draft_changes`` row. Returns what G3 stores in ``result_ref``."""
    target = mapping.target_of(change.kind)
    if target is None:
        raise StagingError(422, f"A {change.kind} change is not staged")
    if target == "checkpoint":
        action = await _to_checkpoint(db, principal, change, reason, stage=True)
        ref = {"kind": "checkpoint_action", "id": str(action.id)}
    else:
        ref = await _to_next_draft(db, principal, change, reason)
    change = await db.get(DiscussionChange, change.id)
    change.status = "staged"
    change.result_ref = ref
    change.decided_by = principal.id
    change.decided_at = _now()
    if override_reason:
        change.override_reason = override_reason
    await db.commit()
    return ref


async def _to_next_draft(
    db: AsyncSession, principal: "Principal", change: DiscussionChange, reason: str | None
) -> dict[str, str]:
    from oracle.auth.service import caller_refusal

    if not has_role(principal.role, "approver"):
        raise StagingError(403, "Requires the approver role")
    refusal = await caller_refusal(db, principal, "approver")
    if refusal is not None:
        raise StagingError(403, refusal)
    d = await db.get(Discussion, change.discussion_id)
    if d is None or d.document_id is None:
        raise StagingError(422, "A section change is staged on a document's discussion")
    existing = await db.scalar(
        select(NextDraftChange).where(
            NextDraftChange.discussion_change_id == change.id, NextDraftChange.status == "staged"
        )
    )
    if existing is not None:
        return {"kind": "next_draft_change", "id": str(existing.id)}
    payload = change.edited_payload or change.payload
    version = (d.subject or {}).get("version")
    if not isinstance(version, int):
        version = await db.scalar(
            select(DocumentVersion.number)
            .where(DocumentVersion.document_id == d.document_id)
            .order_by(DocumentVersion.number.desc())
            .limit(1)
        )
    row = NextDraftChange(
        document_id=d.document_id,
        section_key=payload["section_key"],
        raised_on_version=version or 1,
        instruction=payload["instruction"][:1000],
        text=payload.get("text"),
        reason=(reason or "").strip()[:1000] or None,
        discussion_id=d.id,
        discussion_change_id=change.id,
        from_private=d.visibility == "private",
        staged_by=principal.id,
        suggested_by=change.suggested_by,
    )
    db.add(row)
    await db.flush()
    await audit.record(
        db, principal, "next_draft_change.staged", "next_draft_change", row.id,
        {"document_id": str(d.document_id), "section_key": row.section_key,
         "discussion_id": str(d.id)},
    )  # fmt: skip
    return {"kind": "next_draft_change", "id": str(row.id)}


# --- unstage a next-draft row --------------------------------------------------------------


def change_out(row: NextDraftChange) -> NextDraftChangeOut:
    return NextDraftChangeOut(
        id=row.id,
        document_id=row.document_id,
        section_key=row.section_key,
        raised_on_version=row.raised_on_version,
        instruction=row.instruction,
        text=row.text,
        reason=row.reason,
        status=row.status,  # type: ignore[arg-type]
        applied_in_version=row.applied_in_version,
        from_private=row.from_private,
        lock_version=row.lock_version,
    )


async def unstage(
    db: AsyncSession, principal: "Principal", row_id: uuid.UUID, lock_version: int
) -> NextDraftChangeOut:
    row = await db.get(NextDraftChange, row_id, with_for_update=True)
    if row is None:
        raise StagingError(404, "Staged change not found")
    if row.status == "applied":
        raise StagingError(409, f"Already in draft {row.applied_in_version}")
    if row.status != "staged":
        raise StagingError(409, NOT_STAGED)
    if row.lock_version != lock_version:
        raise StagingError(409, CHANGED)
    row.status = "unstaged"
    row.unstaged_by = principal.id
    row.unstaged_at = _now()
    change = (
        await db.get(DiscussionChange, row.discussion_change_id)
        if row.discussion_change_id
        else None
    )
    if change is not None and change.status == "staged":
        hooks.back(change)
    await db.flush()
    await audit.record(
        db, principal, "next_draft_change.unstaged", "next_draft_change", row.id,
        {"document_id": str(row.document_id), "section_key": row.section_key},
    )  # fmt: skip
    await db.commit()
    return change_out(row)


# --- the one read --------------------------------------------------------------------------


async def staged_rows(db: AsyncSession, document_id: uuid.UUID) -> list[NextDraftChange]:
    """A document's staged next-draft rows, oldest first."""
    return list(
        await db.scalars(
            select(NextDraftChange)
            .where(NextDraftChange.document_id == document_id, NextDraftChange.status == "staged")
            .order_by(NextDraftChange.created_at, NextDraftChange.id)
        )
    )


async def _document_list(db: AsyncSession, principal: "Principal", slug: str) -> StagingList:
    from oracle.jobs import next_draft

    staged = await next_draft.staged_changes(db, slug, include_gone=True, principal=principal)
    document = await db.get(Document, staged.document_id)
    items = [
        StagingItem(
            id=c.suggestion_id,
            source="suggestion",
            kind="section_edit",
            label=f"Change {c.section_heading}: {c.feedback_summary}".strip(": "),
            section_key=c.section_key,
            payload={"section_key": c.section_key, "text": c.text},
            state="staged",
            origin="review",
            staged_by=StagingPerson(user_id=c.accepted_by, name=c.accepted_by_name or "Someone")
            if c.accepted_by
            else None,
            at=c.accepted_at,
            section_gone=c.section_gone,
            section_locked=c.section_locked,
        )
        for c in staged.items
    ]
    rows = {r.id: r for r in await staged_rows(db, staged.document_id)}
    views = await discussion_views(db, principal, [r.discussion_id for r in rows.values()])
    names = await _people(db, [r.staged_by for r in rows.values()]
                          + [r.suggested_by for r in rows.values()])  # fmt: skip
    for c in staged.next_draft_changes:
        r = rows[c.id]
        items.append(
            StagingItem(
                id=c.id,
                source="next_draft_change",
                kind="section_edit",
                label=mapping.label(
                    "section_edit",
                    {"section_key": c.section_heading, "instruction": c.instruction},
                    None,
                ),
                section_key=c.section_key,
                payload={"section_key": c.section_key, "instruction": c.instruction,
                         **({"text": c.text} if c.text else {})},
                state="staged",
                reason=c.reason,
                origin="discussion",
                discussion=views.get(r.discussion_id) if r.discussion_id else None,
                from_private=c.from_private,
                origin_line=c.origin_line,
                staged_by=_person(names, r.staged_by),
                suggested_by=_person(names, r.suggested_by),
                at=r.created_at,
                section_gone=c.section_gone,
                section_locked=c.section_locked,
                lock_version=r.lock_version,
            )
        )  # fmt: skip
    items = merge(items)
    return StagingList(
        target=StagingTarget(
            kind="document",
            label=document.title if document else slug,
            document_id=staged.document_id,
            slug=staged.slug,
            next_version=staged.next_version,
        ),
        items=items,
        counts=StagingCounts(staged=len(items)),
        can_stage=has_role(principal.role, "approver") and not principal.read_only,  # type: ignore[arg-type]
    )


async def _checkpoint_list(
    db: AsyncSession, principal: "Principal", checkpoint_id: uuid.UUID
) -> StagingList:
    from oracle.runs.actions import KIND_WORDS

    cp = await db.get(Checkpoint, checkpoint_id)
    if cp is None:
        raise StagingError(404, f"checkpoint {checkpoint_id} not found")
    rows = list(
        await db.scalars(
            select(CheckpointAction)
            .where(CheckpointAction.checkpoint_id == cp.id)
            .order_by(CheckpointAction.created_at, CheckpointAction.id)
        )
    )
    views = await discussion_views(db, principal, [r.discussion_id for r in rows])
    change_ids = [r.discussion_change_id for r in rows if r.discussion_change_id]
    changes = {
        c.id: c
        for c in await db.scalars(
            select(DiscussionChange).where(DiscussionChange.id.in_(change_ids))
        )
    }
    ids: list[uuid.UUID | None] = [r.updated_by for r in rows] + [r.created_by for r in rows]
    ids += [c.suggested_by for c in changes.values()]
    names = await _people(db, ids)
    items = []
    for r in rows:
        kind, payload = mapping.to_change(r.item_key, r.kind, r.field, r.value)
        change = changes.get(r.discussion_change_id) if r.discussion_change_id else None
        suggester = change.suggested_by if change and change.suggested_by else None
        if suggester is None and r.state == "suggested":
            suggester = r.created_by
        view = views.get(r.discussion_id) if r.discussion_id else None
        if view is None and r.origin == "discussion":
            # The discussion is gone: what the row recorded.
            view = StagingDiscussion(id=None, title=None, private=r.from_private)
        items.append(
            StagingItem(
                id=r.id,
                source="checkpoint_action",
                kind=kind or r.kind,
                label=mapping.label(kind, payload, r.item_key, d8_kind=r.kind, field=r.field),
                item_key=r.item_key,
                payload=payload or {"item_key": r.item_key, "kind": r.kind, "field": r.field,
                                    "value": r.value},
                state=r.state,  # type: ignore[arg-type]
                reason=r.note,
                origin=r.origin,  # type: ignore[arg-type]
                discussion=view,
                from_private=r.from_private,
                origin_line=origin_line(view) if r.origin == "discussion" else None,
                staged_by=_person(names, r.updated_by) if r.state == "staged" else None,
                suggested_by=_person(names, suggester),
                at=r.created_at,
            )
        )  # fmt: skip
    attempt = (cp.payload or {}).get("attempt")
    words = KIND_WORDS.get(cp.kind, cp.kind.replace("_", " "))
    label = words[:1].upper() + words[1:]
    if isinstance(attempt, int):
        label += f" · attempt {attempt}"
    pending = cp.status == "pending"
    return StagingList(
        target=StagingTarget(
            kind="checkpoint",
            label=label,
            run_id=cp.run_id,
            checkpoint_id=cp.id,
            checkpoint_kind=cp.kind,
        ),
        items=items,
        counts=StagingCounts(
            staged=sum(1 for i in items if i.state == "staged"),
            suggested=sum(1 for i in items if i.state == "suggested"),
        ),
        revision=cp.draft_revision or 0,
        can_stage=pending
        and has_role(principal.role, cp.approver_role)  # type: ignore[arg-type]
        and not principal.read_only,
    )


async def staging_list(
    db: AsyncSession,
    principal: "Principal",
    document: str | None,
    checkpoint: uuid.UUID | None,
) -> StagingList:
    if (document is None) == (checkpoint is None):
        raise StagingError(422, "Name one target: document or checkpoint")
    if document is not None:
        return await _document_list(db, principal, document)
    assert checkpoint is not None
    return await _checkpoint_list(db, principal, checkpoint)
