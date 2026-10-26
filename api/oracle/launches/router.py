"""Launch and changelog routes (H6).

Everyone reads (viewer+). Approvers plan, set tiers, mark launched, cancel, draft the
kit, add tasks and requesters, notify members and publish changelog entries. A task's
owner may update their task; a launch's owner may update its notes. Every route is
company-scoped (another company's id is a 404) and becomes an MCP tool by its operation
id. Run tokens read launches and the changelog (``read:baseline``), and requester notes
only with ``read:sources``; they never publish, mark sent or mark launched
(oracle.mcp.scopes).

Importing this module registers the ``launches.plan`` change handler: an approved
roadmap version plans one launch per item in Now.
"""

import uuid
from datetime import date
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import select

from oracle import audit, autonomy_drafts, changes
from oracle.auth.deps import Principal, TenantDB
from oracle.authz import has_role, require_role
from oracle.launches import changelog, service
from oracle.launches.models import ChangelogEntry, Launch, LaunchTask, RequesterNote
from oracle.launches.schemas import (
    CancelIn,
    ChangelogAudience,
    ChangelogCreate,
    ChangelogEntryOut,
    ChangelogPatch,
    ChangelogStatus,
    LaunchCreate,
    LaunchedIn,
    LaunchOut,
    LaunchPatch,
    LaunchState,
    LaunchSummary,
    NotifiedOut,
    RequesterCreate,
    RequesterNoteOut,
    RequesterNotePatch,
    TaskCreate,
    TaskOut,
    TaskPatch,
)
from oracle.roadmap import router as _roadmap_router  # noqa: F401 - roadmap.items runs first
from oracle.runs import extensions
from oracle.runs import service as runs_service
from oracle.runs.schemas import RunOut

router = APIRouter(prefix="/v1", tags=["launches"])

# H11 external_messages: at Observe the kit run is told to keep to internal words.
extensions.register_prompt_lines("launch_kit", autonomy_drafts.kit_lines)

Reader = Annotated[Principal, Depends(require_role("viewer"))]
Approver = Annotated[Principal, Depends(require_role("approver"))]

changes.register_handler("launches.plan", service.on_published, subjects={"document_version"})


def _fail(exc: service.LaunchError) -> HTTPException:
    return HTTPException(exc.status, str(exc))


async def _launch(db, launch_id: uuid.UUID, *, for_update: bool = False) -> Launch:
    try:
        return await service.get_launch(db, launch_id, for_update=for_update)
    except service.LaunchError as e:
        raise _fail(e) from e


# --- launches ---------------------------------------------------------------------------------


@router.get("/launches", response_model=list[LaunchSummary])
async def list_launches(
    principal: Reader,
    db: TenantDB,
    state: LaunchState | None = None,
    track_id: uuid.UUID | None = None,
    tier: Annotated[int | None, Query(ge=1, le=3)] = None,
) -> list[LaunchSummary]:
    """Launches, newest first, each with its tier (or Oracle's suggestion), state, task
    and note counts. ``tier`` filters on the tier a person set."""
    query = select(Launch).order_by(Launch.created_at.desc(), Launch.id)
    if state is not None:
        query = query.where(Launch.state == state)
    if track_id is not None:
        query = query.where(Launch.track_id == track_id)
    if tier is not None:
        query = query.where(Launch.tier == tier)
    return await service.summaries(db, list(await db.scalars(query)))


@router.post("/launches", response_model=LaunchOut, status_code=201)
async def create_launch(body: LaunchCreate, principal: Approver, db: TenantDB) -> LaunchOut:
    """Plan a launch by hand ("Plan a launch"): one or more items of the track's latest
    approved roadmap. 422 for items not on it; 409 when they already have a launch."""
    try:
        launch = await service.create_launch(
            db, principal, body.title, body.track_id, body.item_keys, body.owner_id
        )
    except service.LaunchError as e:
        raise _fail(e) from e
    await db.commit()
    return await service.launch_out(db, launch)


@router.get("/launches/{launch_id}", response_model=LaunchOut)
async def get_launch(launch_id: uuid.UUID, principal: Reader, db: TenantDB) -> LaunchOut:
    """One launch: its tier with Oracle's reason, owner, items, checklist with the
    drafted text, note counts and kit run."""
    return await service.launch_out(db, await _launch(db, launch_id))


@router.patch("/launches/{launch_id}", response_model=LaunchOut)
async def update_launch(
    launch_id: uuid.UUID, body: LaunchPatch, principal: Approver, db: TenantDB
) -> LaunchOut:
    """Set the tier (1 to 3; the checklist follows), the owner, the title or the items.
    409 on a stale ``lock_version``."""
    launch = await _launch(db, launch_id, for_update=True)
    try:
        await service.update_launch(db, principal, launch, body.model_dump(exclude_unset=True))
    except service.LaunchError as e:
        raise _fail(e) from e
    await db.commit()
    return await service.launch_out(db, launch)


@router.post("/launches/{launch_id}/launched", response_model=LaunchOut)
async def mark_launched(
    launch_id: uuid.UUID, principal: Approver, db: TenantDB, body: LaunchedIn | None = None
) -> LaunchOut:
    """Mark launched: always a person's go. Records when, sends the launch ship signal
    per item, lists the people who asked, and starts the kit run unless it ran at Ready.
    409 "Already launched" the second time."""
    launch = await _launch(db, launch_id, for_update=True)
    try:
        run_id = await service.mark_launched(db, principal, launch, (body or LaunchedIn()).at)
    except service.LaunchError as e:
        raise _fail(e) from e
    if run_id is not None:
        await runs_service.submit_queued(db, run_id)
    return await service.launch_out(db, await _launch(db, launch_id))


@router.post("/launches/{launch_id}/cancel", response_model=LaunchOut)
async def cancel_launch(
    launch_id: uuid.UUID, body: CancelIn, principal: Approver, db: TenantDB
) -> LaunchOut:
    """Cancel a planned or ready launch, with a reason (409 once launched)."""
    launch = await _launch(db, launch_id, for_update=True)
    try:
        await service.cancel_launch(db, principal, launch, body.reason)
    except service.LaunchError as e:
        raise _fail(e) from e
    await db.commit()
    return await service.launch_out(db, launch)


@router.post("/launches/{launch_id}/draft", response_model=RunOut, status_code=201)
async def draft_launch_kit(launch_id: uuid.UUID, principal: Approver, db: TenantDB) -> RunOut:
    """Start Oracle's launch kit run (one writer step, quick depth: $3.00): the
    changelog entries, task drafts and personal notes. 409 while one is under way."""
    launch = await _launch(db, launch_id, for_update=True)
    if launch.state == "cancelled":
        raise HTTPException(status.HTTP_409_CONFLICT, "The launch is cancelled")
    try:
        run_id = await service.start_kit(db, principal, launch)
    except service.LaunchError as e:
        raise _fail(e) from e
    except runs_service.RunError as e:
        raise HTTPException(e.status, str(e)) from e
    await runs_service.submit_queued(db, run_id)
    return await runs_service.read_run(db, run_id, principal)


@router.post("/launches/{launch_id}/tasks", response_model=TaskOut, status_code=201)
async def add_launch_task(
    launch_id: uuid.UUID, body: TaskCreate, principal: Approver, db: TenantDB
) -> TaskOut:
    """Add a task of the company's own to the launch's checklist."""
    launch = await _launch(db, launch_id)
    try:
        task = await service.add_task(
            db, principal, launch, body.key, body.title, body.audience, body.owner_id
        )
    except service.LaunchError as e:
        raise _fail(e) from e
    await db.commit()
    await db.refresh(task)
    return service.task_out(task, service.effective_tier(launch), await service.hidden_for(db))


@router.patch("/launch-tasks/{task_id}", response_model=TaskOut)
async def update_launch_task(
    task_id: uuid.UUID, body: TaskPatch, principal: Reader, db: TenantDB
) -> TaskOut:
    """Edit a task's text, owner or state (todo, drafted, done, skipped with a reason).
    The task's owner or an approver."""
    task = await db.scalar(select(LaunchTask).where(LaunchTask.id == task_id).with_for_update())
    if task is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Task not found")
    if principal.is_run or not await service.may_edit_task(db, principal, task):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "Only the task's owner or an approver can change it"
        )
    try:
        await service.update_task(db, principal, task, body.model_dump(exclude_unset=True))
    except service.LaunchError as e:
        raise _fail(e) from e
    await db.commit()
    await db.refresh(task)
    launch = await db.get(Launch, task.launch_id)
    tier = service.effective_tier(launch) if launch else None
    return service.task_out(task, tier, await service.hidden_for(db))


# --- requester notes ----------------------------------------------------------------------------


@router.get("/launches/{launch_id}/notes", response_model=list[RequesterNoteOut])
async def list_requester_notes(
    launch_id: uuid.UUID, principal: Reader, db: TenantDB
) -> list[RequesterNoteOut]:
    """The people who asked for the launch's items, each with what they asked (their
    words) and Oracle's draft of a personal note. External notes are sent by a person;
    Oracle never sends them."""
    await _launch(db, launch_id)
    rows = await db.scalars(
        select(RequesterNote)
        .where(RequesterNote.launch_id == launch_id)
        .order_by(RequesterNote.created_at, RequesterNote.id)
    )
    hidden = await service.hidden_for(db)
    return [service.note_out(n, hidden) for n in rows]


@router.post("/launches/{launch_id}/notes", response_model=RequesterNoteOut, status_code=201)
async def add_requester(
    launch_id: uuid.UUID, body: RequesterCreate, principal: Approver, db: TenantDB
) -> RequesterNoteOut:
    """Add someone who asked by hand: a name and what they gave to reach them."""
    launch = await _launch(db, launch_id)
    note = await service.add_requester(
        db, principal, launch, body.display_name, body.contact_hint, body.asked
    )
    await db.commit()
    await db.refresh(note)
    return service.note_out(note, await service.hidden_for(db))


@router.patch("/requester-notes/{note_id}", response_model=RequesterNoteOut)
async def update_requester_note(
    note_id: uuid.UUID, body: RequesterNotePatch, principal: Reader, db: TenantDB
) -> RequesterNoteOut:
    """Edit the draft, Mark sent (with the channel and date: the person sent it) or Skip
    (with a reason). The launch's owner or an approver."""
    note = await db.scalar(
        select(RequesterNote).where(RequesterNote.id == note_id).with_for_update()
    )
    if note is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Note not found")
    launch = await _launch(db, note.launch_id)
    if principal.is_run or not (
        has_role(principal.role, "approver") or launch.owner_id == principal.id
    ):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "Only the launch's owner or an approver can change notes"
        )
    try:
        await service.update_note(db, principal, note, body.model_dump(exclude_unset=True))
    except service.LaunchError as e:
        raise _fail(e) from e
    await db.commit()
    await db.refresh(note)
    return service.note_out(note, await service.hidden_for(db))


@router.post("/launches/{launch_id}/notify-members", response_model=NotifiedOut)
async def notify_requesters(launch_id: uuid.UUID, principal: Approver, db: TenantDB) -> NotifiedOut:
    """Tell the members who asked, inside Oracle: each gets a "Shipped" row in their
    Inbox carrying their note. Only once the launch is launched (409 before)."""
    launch = await _launch(db, launch_id, for_update=True)
    if launch.state != "launched":
        raise HTTPException(status.HTTP_409_CONFLICT, "Mark the launch launched first")
    n = await service.notify_members(db, principal, launch)
    await db.commit()
    return NotifiedOut(notified=n)


# --- changelog -------------------------------------------------------------------------------


@router.get("/changelog", response_model=list[ChangelogEntryOut])
async def list_changelog(
    principal: Reader,
    db: TenantDB,
    audience: ChangelogAudience | None = None,
    status_: Annotated[ChangelogStatus | None, Query(alias="status")] = None,
    since: date | None = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 200,
) -> list[ChangelogEntry]:
    """Changelog entries, newest first (by release date), internal and public."""
    query = select(ChangelogEntry).order_by(
        ChangelogEntry.released_on.desc(), ChangelogEntry.created_at.desc(), ChangelogEntry.id
    )
    if audience is not None:
        query = query.where(ChangelogEntry.audience == audience)
    if status_ is not None:
        query = query.where(ChangelogEntry.status == status_)
    if since is not None:
        query = query.where(ChangelogEntry.released_on >= since)
    rows = list(await db.scalars(query.limit(limit)))
    # #541 part 5: a draft naming what the reader may not see is left out for them.
    return service.changelog_shown(rows, await service.hidden_for(db))


@router.get(
    "/changelog/export",
    response_class=Response,
    responses={200: {"content": {"text/markdown": {}, "text/html": {}}}},
)
async def export_changelog(
    principal: Reader,
    db: TenantDB,
    audience: ChangelogAudience = "public",
    format: Literal["md", "html"] = "md",
    since: date | None = None,
) -> Response:
    """Published entries as Markdown or HTML (Keep a Changelog: newest first, dated
    YYYY-MM-DD, grouped by category), for a person to post on the company's site or help
    center. Drafts and withdrawn entries are never in it; Oracle posts nothing."""
    query = select(ChangelogEntry).where(
        ChangelogEntry.status == "published", ChangelogEntry.audience == audience
    )
    if since is not None:
        query = query.where(ChangelogEntry.released_on >= since)
    rows = [
        changelog.ExportEntry(
            category=e.category, audience=e.audience, title=e.title, body=e.body,
            released_on=e.released_on,
        )
        for e in await db.scalars(query.order_by(ChangelogEntry.created_at, ChangelogEntry.id))
    ]  # fmt: skip
    if format == "html":
        return Response(changelog.render_html(rows), media_type="text/html; charset=utf-8")
    return Response(
        changelog.render_markdown(rows),
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="changelog.md"'},
    )


@router.post("/changelog", response_model=ChangelogEntryOut, status_code=201)
async def create_changelog_entry(
    body: ChangelogCreate, principal: Approver, db: TenantDB
) -> ChangelogEntry:
    """Add an entry (draft). A public entry needs ``released_on``."""
    if body.audience == "public" and body.released_on is None:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "A public entry needs its release date"
        )
    if body.launch_id is not None:
        await _launch(db, body.launch_id)
    entry = ChangelogEntry(
        launch_id=body.launch_id,
        category=body.category,
        audience=body.audience,
        title=body.title.strip(),
        body=body.body.strip(),
        released_on=body.released_on or service.now().date(),
        created_actor=principal.actor,
    )
    db.add(entry)
    await db.flush()
    await audit.record(db, principal, "changelog.created", "changelog_entry", entry.id,
                       {"audience": entry.audience, "category": entry.category})  # fmt: skip
    await db.commit()
    await db.refresh(entry)
    return entry


async def _entry(db, entry_id: uuid.UUID) -> ChangelogEntry:
    entry = await db.scalar(
        select(ChangelogEntry).where(ChangelogEntry.id == entry_id).with_for_update()
    )
    if entry is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Changelog entry not found")
    return entry


@router.patch("/changelog/{entry_id}", response_model=ChangelogEntryOut)
async def update_changelog_entry(
    entry_id: uuid.UUID, body: ChangelogPatch, principal: Approver, db: TenantDB
) -> ChangelogEntry:
    entry = await _entry(db, entry_id)
    fields = body.model_dump(exclude_unset=True)
    if fields.pop("lock_version") != entry.lock_version:
        raise HTTPException(status.HTTP_409_CONFLICT, "The entry changed since it was loaded")
    if nulls := [k for k in ("category", "audience", "title", "released_on", "body")
                 if k in fields and fields[k] is None]:  # fmt: skip
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, f"{', '.join(nulls)} cannot be cleared"
        )
    for key, value in fields.items():
        setattr(entry, key, value.strip() if isinstance(value, str) else value)
    entry.lock_version += 1
    await audit.record(db, principal, "changelog.updated", "changelog_entry", entry.id,
                       {"fields": sorted(fields)})  # fmt: skip
    await db.commit()
    await db.refresh(entry)
    return entry


@router.post("/changelog/{entry_id}/publish", response_model=ChangelogEntryOut)
async def publish_changelog_entry(
    entry_id: uuid.UUID, principal: Approver, db: TenantDB
) -> ChangelogEntry:
    """Publish an entry inside Oracle (an approver; a public entry is never published
    by Oracle). Then Export it for a person to post. 409 for a withdrawn entry."""
    entry = await _entry(db, entry_id)
    if entry.status == "withdrawn":
        raise HTTPException(status.HTTP_409_CONFLICT, "A withdrawn entry cannot be published")
    if entry.status != "published":
        entry.status = "published"
        entry.published_by = principal.id
        entry.published_actor = principal.actor
        entry.published_at = service.now()
        entry.lock_version += 1
        await audit.record(db, principal, "changelog.published", "changelog_entry", entry.id,
                           {"audience": entry.audience})  # fmt: skip
        await db.commit()
        await db.refresh(entry)
    return entry


@router.post("/changelog/{entry_id}/withdraw", response_model=ChangelogEntryOut)
async def withdraw_changelog_entry(
    entry_id: uuid.UUID, principal: Approver, db: TenantDB
) -> ChangelogEntry:
    """Withdraw an entry: it leaves the export (a copy a person already posted elsewhere
    is theirs to take down)."""
    entry = await _entry(db, entry_id)
    if entry.status != "withdrawn":
        entry.status = "withdrawn"
        entry.lock_version += 1
        await audit.record(db, principal, "changelog.withdrawn", "changelog_entry", entry.id,
                           {"audience": entry.audience})  # fmt: skip
        await db.commit()
        await db.refresh(entry)
    return entry
