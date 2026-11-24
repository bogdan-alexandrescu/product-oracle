"""task-push (#1816): a task under a roadmap item goes to the connected tracker.

When a tracker is connected (oracle.roadmap.tracker.connected), each applied task change
(add, edit, status; an accepted proposal; an undo that leaves the task) pushes the task
through ``tracker.push_task``, the one tracker gate: the first push creates its record and
links it (``tracker_record_id``), later ones move that record. The task change never fails
or waits on it: a failure is stored on the task (``tracker_push_error``), shown with Retry
(``POST /v1/simple/tasks/{task_id}/tracker-push``), and cleared when a push lands.
"""

import logging
import uuid
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from oracle.authz import has_role
from oracle.errors import exception_text
from oracle.members.names import display_name
from oracle.roadmap import tracker
from oracle.roadmap.models import TrackerRecord

log = logging.getLogger(__name__)

FAILED = "The tracker did not take the task"


async def push(db: AsyncSession, principal: Any, task: Any) -> None:
    """Push ``task`` when a tracker is connected; the outcome is stored on the task."""
    if not tracker.connected():
        return
    record = await db.get(TrackerRecord, task.tracker_record_id) if task.tracker_record_id else None
    await db.flush()  # the task change is written before the tracker is asked
    task_id = task.id
    try:
        async with db.begin_nested():
            out = await tracker.push_task(db, principal, task, record)
    except Exception as e:  # the task is saved; the tracker is best effort, never silent
        if not isinstance(e, tracker.TrackerError):
            log.warning("task-push: pushing task %s failed", task_id, exc_info=True)
        await db.refresh(task)  # a rolled-back savepoint expires what it touched
        task.tracker_push_error = (
            exception_text(e) if isinstance(e, tracker.TrackerError) else FAILED
        )
    else:
        task.tracker_record_id = out.id
        task.tracker_push_error = None
    await db.flush()


async def retry(db: AsyncSession, principal: Any, task_id: uuid.UUID) -> Any:
    """Retry: push the task again. Whoever changes the task directly (an owner, the item's
    decider) may (403 otherwise); 404 for no such task. Returns the task as the read shows it."""
    from oracle.simple import drafts, service
    from oracle.simple.changes import ChangeError
    from oracle.simple.models import RoadmapItemTask

    row = await db.get(RoadmapItemTask, task_id, with_for_update=True)
    if row is None:
        raise ChangeError(404, "No such task")
    read_ = await service.load(db)
    entry = read_.by_id().get(row.item_id) if row.item_id else None
    same = (
        e
        for e in read_.entries
        if e.row.item_key == row.item_key and e.row.roadmap_document_id == row.roadmap_document_id
    )
    entry = entry or next(same, None)
    allowed = (
        service.can_decide(principal, entry, read_.deciders)
        if entry is not None
        else has_role(principal.role, "owner")
    )
    if not allowed:
        raise ChangeError(403, "Only those who change this task directly retry its push")
    await push(db, principal, row)
    await db.commit()
    names = {u.id: display_name(u.email, u.name) for u in await drafts.all_users(db)
             if u.id == row.owner_id}  # fmt: skip
    return service.task_out(row, names, await service.task_records(db, [row]))
