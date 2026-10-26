"""G4: a discussion change follows what happens to what it staged (Status sync).

Called inside D8's writes (:mod:`oracle.runs.actions`), C1e's apply
(:mod:`oracle.jobs.next_draft`) and the checkpoint decision
(:func:`oracle.runs.service.decide_checkpoint`), in their transactions. They flush and
never commit.
"""

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.discussions.models import DiscussionChange
from oracle.runs.models import Checkpoint, CheckpointAction

REPLACED = "Replaced by a later change to the same item"
SENT = "Sent to the agents"
APPLIED_ON_APPROVAL = "Applied on approval"


async def _change(db: AsyncSession, change_id: uuid.UUID | None) -> DiscussionChange | None:
    return await db.get(DiscussionChange, change_id) if change_id else None


def back(change: DiscussionChange) -> None:
    """Unstaged: back to the discussion, as suggested when someone suggested it."""
    change.status = "suggested" if change.suggested_by else "proposed"
    change.result_ref = None


async def replaced(db: AsyncSession, change_id: uuid.UUID) -> None:
    """D8 replaced the change's action with a later one for the same item, kind and field."""
    change = await _change(db, change_id)
    if change is not None and change.status in ("suggested", "staged"):
        change.status = "proposed"
        change.decision_note = REPLACED
        change.result_ref = None
        await db.flush()


async def staged(db: AsyncSession, action: CheckpointAction) -> None:
    """An approver staged the change's suggested action from the review screen."""
    change = await _change(db, action.discussion_change_id)
    if change is not None:
        change.status = "staged"
        change.result_ref = {"kind": "checkpoint_action", "id": str(action.id)}
        await db.flush()


async def removed(db: AsyncSession, change_id: uuid.UUID) -> None:
    """D8's delete removed the change's action."""
    change = await _change(db, change_id)
    if change is not None and change.status in ("suggested", "staged"):
        back(change)
        await db.flush()


async def decided(db: AsyncSession, cp: Checkpoint, decision: str) -> None:
    """The checkpoint is decided: changes behind staged actions are done, those behind
    suggestions stay suggested."""
    rows = await db.scalars(
        select(CheckpointAction).where(
            CheckpointAction.checkpoint_id == cp.id,
            CheckpointAction.discussion_change_id.is_not(None),
        )
    )
    note = APPLIED_ON_APPROVAL if decision == "approved" else SENT
    for action in rows:
        change = await _change(db, action.discussion_change_id)
        # A done change (Ask's question action) stays done.
        if change is None or change.status == "done":
            continue
        if action.state == "staged":
            change.status = "done"
            change.decision_note = note
        else:
            change.status = "suggested"
    await db.flush()
