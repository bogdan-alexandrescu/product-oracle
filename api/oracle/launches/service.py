"""Launches (H6): planned on roadmap approval, Ready from the ship signals, Launched by
a person, their tier, checklist, kit run, requester notes and Inbox rows.

Lifecycle::

    planned --(every ship signal of its items in: oracle.roadmap.shipped)--> ready
    ready --(a person: Mark launched)--> launched
    planned/ready --(a person: Cancel)--> cancelled

- **Planned**: approving a roadmap version plans one launch per item in Now, owned by
  the approver (the ``launches.plan`` change handler); an approver can plan one by hand.
- **Ready**: set by the hourly ticker step (:func:`detect_ready`), which also starts the
  ``launch_kit`` drafting run, so the drafts wait for the person who marks it launched.
- **Launched**: always a person's action (approver and above): the go or no-go stays
  human. It records ``launched_at``, sends the ``launch`` ship signal for each item to
  whoever registered for it (H3 Predicted versus actual), starts the kit run unless it
  ran at Ready, and lists the requesters. With H11 Autonomy's ``launches`` at "Act
  within limits", Oracle also publishes the launch's internal changelog entries and
  notifies the member requesters, and tells the owner.

Oracle never sends anything outside Oracle: external notes and public entries leave it
through a person.
"""

import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, autonomy, autonomy_drafts, company_time
from oracle.auth.deps import Principal
from oracle.auth.models import ApiToken, User
from oracle.authz import has_role
from oracle.docs import visibility
from oracle.docs.models import Document, DocumentVersion
from oracle.launches import checklist, requesters, tiers
from oracle.launches.models import ChangelogEntry, Launch, LaunchTask, RequesterNote
from oracle.launches.schemas import (
    InboxLaunch,
    LaunchItem,
    LaunchOut,
    LaunchSummary,
    NoteCounts,
    RequesterNoteOut,
    TaskCounts,
    TaskOut,
    TierSuggestion,
)
from oracle.roadmap.models import RoadmapItem
from oracle.roadmap.shipped import shipped_items

LIVE_STATES = ("planned", "ready")
# Run states during which a launch's kit run is still under way.
ACTIVE_RUN = ("draft", "awaiting_approval", "running", "awaiting_checkpoint", "paused_overrun")
# How long a member's "Shipped" row stays in their Inbox.
SHIPPED_ROW_DAYS = 30


class LaunchError(Exception):
    status = 422

    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        if status is not None:
            self.status = status


class NotFound(LaunchError):
    status = 404


class Conflict(LaunchError):
    status = 409


def now() -> datetime:
    return datetime.now(UTC)


# --- ship signals and autonomy ------------------------------------------------------------

# (db, launch, item_key, kind, at): H3 Predicted versus actual registers here to give its
# outcome record the "launch" ship signal.
ShipSignal = Callable[[AsyncSession, Launch, str, str, datetime], Awaitable[None]]
_SHIP_SIGNALS: dict[str, ShipSignal] = {}


def register_ship_signal(name: str, hook: ShipSignal) -> None:
    _SHIP_SIGNALS[name] = hook


def unregister_ship_signal(name: str) -> None:
    _SHIP_SIGNALS.pop(name, None)


async def _send_ship_signals(db: AsyncSession, launch: Launch, at: datetime) -> None:
    for key in launch.item_keys:
        for hook in list(_SHIP_SIGNALS.values()):
            await hook(db, launch, key, "launch", at)


async def autonomy_acts(db: AsyncSession) -> bool:
    """Whether H11 Autonomy lets Oracle act within limits on launches (the ``launches``
    responsibility at "act"). Off by default (Draft): people publish and notify."""
    return await autonomy.level(db, "launches") == "act"


# --- reading ------------------------------------------------------------------------------


async def get_launch(db: AsyncSession, launch_id: uuid.UUID, *, for_update: bool = False) -> Launch:
    query = select(Launch).where(Launch.id == launch_id)
    if for_update:
        query = query.with_for_update()
    launch = await db.scalar(query)
    if launch is None:
        raise NotFound("Launch not found")
    return launch


def _suggestion(launch: Launch) -> TierSuggestion:
    raw = dict(launch.tier_suggestion or {})
    if not raw.get("reason"):
        raw = {"tier": 3, "reason": tiers.reason("fix", "none", None), "innovation": "fix",
               "goal": "none"}  # fmt: skip
    return TierSuggestion.model_validate(raw)


def effective_tier(launch: Launch) -> int:
    return launch.tier or int((launch.tier_suggestion or {}).get("tier") or 3)


# #541 part 5: the text a launch kit run wrote before it read as a commenter (a task's
# body, release notes, a changelog draft, a requester note) may name a decision or a
# document the reader may not see; it is withheld from that reader (None), as
# oracle.docs.visibility ``hidden_for_reader`` says. ``hidden`` None: the reader sees all.
Hidden = visibility.Hidden


async def hidden_for(db: AsyncSession) -> Hidden | None:
    return await visibility.hidden_for_reader(db)


def _withheld(hidden: Hidden | None, *texts: str | None) -> bool:
    return hidden is not None and any(hidden.names(t) for t in texts)


def task_out(task: LaunchTask, tier: int | None = None, hidden: Hidden | None = None) -> TaskOut:
    tdef = checklist.BY_KEY.get(task.key or "")
    out = TaskOut.model_validate(task)
    if _withheld(hidden, task.body):
        out.body = None
    out.drafts = tdef.drafts if tdef else "no"  # type: ignore[assignment]
    out.optional = bool(tdef and tier in tdef.optional_in)
    out.notice = checklist.EXTERNAL_NOTICE if task.audience == "external" and out.body else None
    return out


def note_out(note: RequesterNote, hidden: Hidden | None = None) -> RequesterNoteOut:
    out = RequesterNoteOut.model_validate(note)
    if _withheld(hidden, note.body):
        out.body = None
    out.internal = note.requester_kind == "member"
    out.notice = None if out.internal or not out.body else checklist.EXTERNAL_NOTICE
    return out


def changelog_shown(entries: list[ChangelogEntry], hidden: Hidden | None) -> list[ChangelogEntry]:
    """The entries the reader sees: a draft or withdrawn entry naming something hidden
    from them is left out (a published one an approver published, for everyone)."""
    return [e for e in entries if e.status == "published" or not _withheld(hidden, e.title, e.body)]


async def _counts(
    db: AsyncSession, ids: list[uuid.UUID]
) -> tuple[dict[uuid.UUID, TaskCounts], dict[uuid.UUID, NoteCounts]]:
    tasks = {i: TaskCounts() for i in ids}
    notes = {i: NoteCounts() for i in ids}
    if not ids:
        return tasks, notes
    for launch_id, status, n in (
        await db.execute(
            select(LaunchTask.launch_id, LaunchTask.status, func.count())
            .where(LaunchTask.launch_id.in_(ids))
            .group_by(LaunchTask.launch_id, LaunchTask.status)
        )
    ).all():
        c = tasks[launch_id]
        c.total += n
        if status in ("done", "skipped"):
            c.closed += n
        else:
            c.open += n
    for launch_id, status, n in (
        await db.execute(
            select(RequesterNote.launch_id, RequesterNote.status, func.count())
            .where(RequesterNote.launch_id.in_(ids))
            .group_by(RequesterNote.launch_id, RequesterNote.status)
        )
    ).all():
        c = notes[launch_id]
        c.total += n
        if status == "drafted":
            c.open += n
        else:
            setattr(c, status, getattr(c, status) + n)
    return tasks, notes


async def summaries(db: AsyncSession, launches: list[Launch]) -> list[LaunchSummary]:
    task_counts, note_counts = await _counts(db, [x.id for x in launches])
    hidden = await hidden_for(db) if any(x.kit_error for x in launches) else None
    return [
        LaunchSummary(
            id=x.id,
            title=x.title,
            track_id=x.track_id,
            roadmap_version_id=x.roadmap_version_id,
            item_keys=list(x.item_keys or []),
            state=x.state,  # type: ignore[arg-type]
            tier=x.tier,
            tier_suggestion=_suggestion(x),
            owner_id=x.owner_id,
            ready_at=x.ready_at,
            launched_at=x.launched_at,
            cancel_reason=x.cancel_reason,
            kit_run_id=x.kit_run_id,
            kit_error=None if _withheld(hidden, x.kit_error) else x.kit_error,
            task_counts=task_counts[x.id],
            notes=note_counts[x.id],
            lock_version=x.lock_version,
            created_at=x.created_at,
            updated_at=x.updated_at,
        )
        for x in launches
    ]


async def launch_out(db: AsyncSession, launch: Launch) -> LaunchOut:
    await db.refresh(launch)
    (summary,) = await summaries(db, [launch])
    items: list[LaunchItem] = []
    rows = {i.item_key: i for i in await tiers.items_of(db, launch)}
    slug = number = None
    if launch.roadmap_version_id is not None:
        found = (
            await db.execute(
                select(Document.slug, DocumentVersion.number)
                .join(DocumentVersion, DocumentVersion.document_id == Document.id)
                .where(DocumentVersion.id == launch.roadmap_version_id)
            )
        ).first()
        if found is not None:
            slug, number = found
    for key in launch.item_keys or []:
        item = rows.get(key)
        items.append(
            LaunchItem(
                item_key=key,
                title=item.title if item else None,
                horizon=item.horizon if item else None,
                roadmap_slug=slug,
                roadmap_version=number,
            )
        )
    tier = effective_tier(launch)
    hidden = await hidden_for(db)
    tasks = [task_out(t, tier, hidden) for t in await checklist.tasks_of(db, launch.id)]
    return LaunchOut(**summary.model_dump(), items=items, tasks=tasks)


# --- planning -----------------------------------------------------------------------------


async def latest_items(
    db: AsyncSession, track_id: uuid.UUID
) -> tuple[uuid.UUID | None, dict[str, RoadmapItem]]:
    """The track's latest approved roadmap version with items, and its items by key."""
    version_id = await db.scalar(
        select(RoadmapItem.roadmap_version_id)
        .join(DocumentVersion, DocumentVersion.id == RoadmapItem.roadmap_version_id)
        .where(RoadmapItem.track_id == track_id, DocumentVersion.approved_at.is_not(None))
        .order_by(DocumentVersion.approved_at.desc(), DocumentVersion.number.desc())
        .limit(1)
    )
    if version_id is None:
        return None, {}
    rows = await db.scalars(
        select(RoadmapItem)
        .where(RoadmapItem.roadmap_version_id == version_id)
        .order_by(RoadmapItem.position)
    )
    return version_id, {i.item_key: i for i in rows}


async def _live_launch(
    db: AsyncSession, track_id: uuid.UUID | None, item_keys: list[str]
) -> Launch | None:
    return await db.scalar(
        select(Launch).where(
            Launch.track_id == track_id,
            Launch.item_keys == item_keys,
            Launch.state != "cancelled",
        )
    )


async def _member_exists(db: AsyncSession, member_id: uuid.UUID) -> bool:
    if await db.scalar(select(User.id).where(User.id == member_id, User.disabled_at.is_(None))):
        return True
    return bool(await db.scalar(select(ApiToken.id).where(ApiToken.id == member_id)))


async def new_launch(
    db: AsyncSession,
    *,
    title: str,
    track_id: uuid.UUID | None,
    version_id: uuid.UUID | None,
    item_keys: list[str],
    owner_id: uuid.UUID | None,
    actor: Principal | str | None,
    created_by: uuid.UUID | None,
) -> Launch:
    launch = Launch(
        title=title,
        track_id=track_id,
        roadmap_version_id=version_id,
        item_keys=item_keys,
        owner_id=owner_id,
        created_by=created_by,
    )
    db.add(launch)
    await db.flush()
    launch.tier_suggestion = await tiers.suggest(db, launch)
    await checklist.apply(db, launch, effective_tier(launch))
    await audit.record(
        db, actor, "launch.planned", "launch", launch.id,
        {"items": item_keys, "track_id": str(track_id) if track_id else None,
         "suggested_tier": launch.tier_suggestion.get("tier")},
    )  # fmt: skip
    return launch


async def create_launch(
    db: AsyncSession,
    principal: Principal,
    title: str,
    track_id: uuid.UUID,
    item_keys: list[str],
    owner_id: uuid.UUID | None,
) -> Launch:
    from oracle.roadmap import tracks

    try:
        await tracks.get_track(db, track_id)
    except tracks.TrackError as e:
        raise NotFound("Track not found") from e
    keys = list(dict.fromkeys(k.strip() for k in item_keys if k.strip()))
    if not keys:
        raise LaunchError("name at least one roadmap item")
    version_id, items = await latest_items(db, track_id)
    if unknown := [k for k in keys if k not in items]:
        raise LaunchError("not items of the track's latest approved roadmap: " + ", ".join(unknown))
    if await _live_launch(db, track_id, keys) is not None:
        raise Conflict("These items already have a launch")
    if owner_id is not None and not await _member_exists(db, owner_id):
        raise LaunchError("owner_id is not a member of this company")
    return await new_launch(
        db,
        title=title.strip(),
        track_id=track_id,
        version_id=version_id,
        item_keys=keys,
        owner_id=owner_id or principal.id,
        actor=principal,
        created_by=principal.id,
    )


def _actor_id(actor: str | None) -> uuid.UUID | None:
    if not actor or ":" not in actor:
        return None
    kind, _, raw = actor.partition(":")
    if kind not in ("user", "token"):
        return None
    try:
        return uuid.UUID(raw)
    except ValueError:
        return None


async def plan_roadmap(
    db: AsyncSession,
    version: DocumentVersion,
    *,
    actor: Principal | str | None,
    owner_id: uuid.UUID | None,
) -> list[Launch]:
    """Plan one launch per item in Now of an approved roadmap version, owned by the
    approver. Items with a live launch get none (approving again plans nothing)."""
    if version.approved_at is None:
        return []
    document = await db.get(Document, version.document_id)
    if document is None or document.kind != "roadmap":
        return []
    items = await db.scalars(
        select(RoadmapItem)
        .where(RoadmapItem.roadmap_version_id == version.id, RoadmapItem.horizon == "now")
        .order_by(RoadmapItem.position)
    )
    planned = []
    for item in list(items):
        track_id = item.track_id
        if track_id is None and item.prd_document_id is not None:
            from oracle.roadmap.tracks import track_of_prd

            track = await track_of_prd(db, item.prd_document_id)
            track_id = track.id if track else None
        if track_id is None:
            continue
        if await _live_launch(db, track_id, [item.item_key]) is not None:
            continue
        planned.append(
            await new_launch(
                db,
                title=item.title,
                track_id=track_id,
                version_id=version.id,
                item_keys=[item.item_key],
                owner_id=owner_id,
                actor=actor,
                created_by=owner_id,
            )
        )
    return planned


async def on_published(db: AsyncSession, event: Any) -> None:
    """``oracle.changes`` handler: a roadmap version published (approved) plans its
    launches, as approving it does (:func:`plan_roadmap`)."""
    if event.cause != "published" or event.subject_id is None:
        return
    version = await db.get(DocumentVersion, event.subject_id)
    if version is None:
        return
    await plan_roadmap(db, version, actor=event.actor, owner_id=_actor_id(event.actor))


# --- edits --------------------------------------------------------------------------------


async def update_launch(
    db: AsyncSession, principal: Principal, launch: Launch, fields: dict[str, Any]
) -> None:
    if fields.pop("lock_version") != launch.lock_version:
        raise Conflict("The launch changed since it was loaded")
    if launch.state in ("launched", "cancelled") and set(fields) - {"title", "owner_id"}:
        raise Conflict(f"The launch is {launch.state}")
    if "title" in fields and fields["title"] is None:
        raise LaunchError("title cannot be cleared")
    before: dict[str, Any] = {}
    if fields.get("owner_id") is not None and not await _member_exists(db, fields["owner_id"]):
        raise LaunchError("owner_id is not a member of this company")
    if fields.get("item_keys") is not None:
        keys = list(dict.fromkeys(fields["item_keys"]))
        if launch.track_id is None:
            raise LaunchError("this launch has no track to take items from")
        version_id, items = await latest_items(db, launch.track_id)
        if unknown := [k for k in keys if k not in items]:
            raise LaunchError(
                "not items of the track's latest approved roadmap: " + ", ".join(unknown)
            )
        other = await _live_launch(db, launch.track_id, keys)
        if other is not None and other.id != launch.id:
            raise Conflict("These items already have a launch")
        before["item_keys"] = list(launch.item_keys)
        launch.item_keys = keys
        launch.roadmap_version_id = version_id
        launch.tier_suggestion = await tiers.suggest(db, launch)
    for key in ("title", "owner_id"):
        if key in fields:
            before[key] = getattr(launch, key)
            setattr(launch, key, fields[key])
    tier_changed = False
    if fields.get("tier") is not None:
        before["tier"] = launch.tier
        tier_changed = launch.tier != fields["tier"]
        launch.tier = fields["tier"]
        launch.tier_set_by = principal.id
    if "tier_reason_override" in fields:
        launch.tier_suggestion = {
            **(launch.tier_suggestion or {}),
            "person_reason": fields["tier_reason_override"],
        }
    if tier_changed or "item_keys" in before:
        await checklist.apply(db, launch, effective_tier(launch))
    launch.lock_version += 1
    await audit.record(
        db, principal, "launch.updated", "launch", launch.id,
        {"before": {k: str(v) if v is not None else None for k, v in before.items()},
         "after": {k: str(v) if v is not None else None for k, v in fields.items()}},
    )  # fmt: skip


async def add_task(
    db: AsyncSession,
    principal: Principal,
    launch: Launch,
    key: str | None,
    title: str,
    audience: str,
    owner_id: uuid.UUID | None,
) -> LaunchTask:
    tasks = await checklist.tasks_of(db, launch.id)
    if key and any(t.key == key for t in tasks):
        raise Conflict(f"The launch already has a task {key!r}")
    if owner_id is not None and not await _member_exists(db, owner_id):
        raise LaunchError("owner_id is not a member of this company")
    task = LaunchTask(
        launch_id=launch.id,
        key=key,
        title=title.strip(),
        audience=audience,
        position=max((t.position for t in tasks), default=0) + 1,
        owner_id=owner_id,
    )
    db.add(task)
    await db.flush()
    await audit.record(db, principal, "launch.task_added", "launch_task", task.id,
                       {"launch_id": str(launch.id), "title": task.title})  # fmt: skip
    return task


async def update_task(
    db: AsyncSession, principal: Principal, task: LaunchTask, fields: dict[str, Any]
) -> None:
    if fields.pop("lock_version") != task.lock_version:
        raise Conflict("The task changed since it was loaded")
    status = fields.get("status")
    if status == "skipped":
        reason = (fields.get("skip_reason") or "").strip()
        if not reason:
            raise LaunchError("Skipping a task needs a reason")
        task.skip_reason = reason
    if fields.get("owner_id") is not None and not await _member_exists(db, fields["owner_id"]):
        raise LaunchError("owner_id is not a member of this company")
    if "owner_id" in fields:
        task.owner_id = fields["owner_id"]
    if fields.get("body") is not None:
        task.body = fields["body"]
        if task.status == "todo" and status is None:
            task.status = "drafted"
    if status is not None:
        task.status = status
        if status == "done":
            task.done_by, task.done_at = principal.id, now()
        if status != "skipped":
            task.skip_reason = None
        if status in ("todo", "drafted"):
            task.done_by = task.done_at = None
    task.lock_version += 1
    await audit.record(db, principal, "launch.task_updated", "launch_task", task.id,
                       {"status": task.status, "fields": sorted(fields)})  # fmt: skip


async def may_edit_task(db: AsyncSession, principal: Principal, task: LaunchTask) -> bool:
    return has_role(principal.role, "approver") or task.owner_id == principal.id


# --- kit run ------------------------------------------------------------------------------


async def acting(
    db: AsyncSession, tenant_id: uuid.UUID, member_id: uuid.UUID | None
) -> Principal | None:
    """The member a kit run Oracle starts acts for (the launch's owner): its run token
    reads with their role."""
    if member_id is None:
        return None
    user = await db.get(User, member_id)
    if user is not None and user.disabled_at is None:
        return Principal(tenant_id=tenant_id, kind="user", role=user.role, user_id=user.id)  # type: ignore[arg-type]
    token = await db.get(ApiToken, member_id)
    if token is not None and token.revoked_at is None:
        return Principal(
            tenant_id=tenant_id, kind="token", role=token.role,  # type: ignore[arg-type]
            token_id=token.id, user_id=token.user_id,
        )  # fmt: skip
    return None


async def kit_active(db: AsyncSession, launch: Launch) -> bool:
    from oracle.runs.models import Run

    if launch.kit_run_id is None:
        return False
    status = await db.scalar(select(Run.status).where(Run.id == launch.kit_run_id))
    return status in ACTIVE_RUN


async def start_kit(db: AsyncSession, principal: Principal, launch: Launch) -> uuid.UUID:
    """Create, estimate and start the launch's ``launch_kit`` run ($3.00 at quick
    depth, under the approval threshold); commits. The caller submits it
    (``runs.service.submit_queued``), or the next tick does."""
    from oracle.runs import service as runs_service
    from oracle.runs.schemas import KnobsIn, RunCreate

    if await kit_active(db, launch):
        raise Conflict("A launch kit run is already under way for this launch")
    body = RunCreate(
        flow="launch_kit",
        # C1's FlowDef.default_checkpoints turns launch_review off too; said here as well.
        knobs=KnobsIn(depth="quick", checkpoints={"launch_review": False}),
    )
    run_id = await runs_service.create_run(
        db, principal, body, oracle_knobs={"launch_id": str(launch.id)}, commit=False
    )
    launch.kit_run_id = run_id
    launch.kit_error = None
    await requesters.sync_notes(db, launch)
    await db.commit()
    await runs_service.estimate(db, principal, run_id)
    await runs_service.start(db, principal, run_id)
    return run_id


async def import_kit_run(db: AsyncSession, run: Any, text: str | None) -> dict[str, Any]:
    """Import a finished kit run's launch.yaml into its launch (runs.service calls this
    when the segment succeeds; the caller commits)."""
    from oracle.launches import kit

    raw = (run.knobs or {}).get("launch_id")
    try:
        launch = await get_launch(db, uuid.UUID(str(raw)), for_update=True)
    except (ValueError, NotFound):
        return {"error": "the run's launch is gone"}
    if launch.kit_run_id != run.id:
        return {"error": "a later kit run replaced this one"}
    # H11 external_messages: at Observe the kit keeps to internal words.
    external = await autonomy_drafts.kit_external_allowed(db)
    result = await kit.import_kit(db, launch, text, external=external)
    await audit.record(db, audit.ORACLE, "launch.kit_imported", "launch", launch.id,
                       {"run_id": str(run.id), **{k: v for k, v in result.items()
                                                  if k != "problems"}})  # fmt: skip
    return result


# --- Ready, launched, cancelled -----------------------------------------------------------


async def detect_ready(db: AsyncSession, tenant_id: uuid.UUID) -> int:
    """The ticker step: planned launches whose items have all shipped become Ready, and
    their kit run starts. Commits per launch; returns how many became Ready."""
    planned = list(
        await db.scalars(
            select(Launch)
            .where(Launch.state == "planned", Launch.track_id.is_not(None))
            .order_by(Launch.created_at, Launch.id)
        )
    )
    signals: dict[uuid.UUID, dict[str, tuple[str, datetime]]] = {}
    ready = 0
    for launch in planned:
        track_id = launch.track_id
        if track_id not in signals:
            signals[track_id] = await shipped_items(db, track_id)  # type: ignore[index]
        shipped = signals[track_id]  # type: ignore[index]
        if not launch.item_keys or any(k not in shipped for k in launch.item_keys):
            continue
        row = await get_launch(db, launch.id, for_update=True)
        if row.state != "planned":
            continue
        row.state = "ready"
        row.ready_at = max(shipped[k][1] for k in row.item_keys)
        row.lock_version += 1
        await requesters.sync_notes(db, row)
        await audit.record(db, audit.ORACLE, "launch.ready", "launch", row.id,
                           {"signals": {k: shipped[k][0] for k in row.item_keys}})  # fmt: skip
        await db.commit()
        ready += 1
        principal = await acting(db, tenant_id, row.owner_id or row.created_by)
        if principal is not None and row.kit_run_id is None:
            await _start_kit_or_note(db, principal, row)
    return ready


async def _start_kit_or_note(
    db: AsyncSession, principal: Principal, launch: Launch
) -> uuid.UUID | None:
    """Start the kit run; when it cannot start, say why on the launch (``kit_error``) and
    leave Draft to a person. The launch's own change is already committed."""
    from oracle.runs.service import RunError

    launch_id = launch.id
    try:
        return await start_kit(db, principal, launch)
    except (LaunchError, RunError) as e:
        await db.rollback()
        row = await get_launch(db, launch_id, for_update=True)
        row.kit_error = f"The launch kit run did not start: {e}"
        await db.commit()
        return None


async def mark_launched(
    db: AsyncSession, principal: Principal, launch: Launch, at: datetime | None
) -> uuid.UUID | None:
    """A person's Mark launched; returns the kit run to submit when one was started."""
    if launch.state == "launched":
        raise Conflict("Already launched")
    if launch.state == "cancelled":
        raise Conflict("The launch is cancelled")
    when = at or now()
    launch.state = "launched"
    launch.launched_at = when
    launch.launched_by = principal.id
    launch.lock_version += 1
    # Entries of this launch carry the day it went out.
    for entry in await db.scalars(
        select(ChangelogEntry).where(
            ChangelogEntry.launch_id == launch.id, ChangelogEntry.status == "draft"
        )
    ):
        entry.released_on = when.date()
    await _send_ship_signals(db, launch, when)
    added = await requesters.sync_notes(db, launch)
    data: dict[str, Any] = {"at": when.isoformat(), "requesters_added": added}
    if await autonomy_acts(db):
        published = await publish_internal(db, launch)
        notified = await notify_members(db, audit.ORACLE, launch)
        data.update(oracle_published=published, oracle_notified=notified)
        if published or notified:
            await autonomy.acted(
                db,
                "launches",
                summary=_acted_summary(launch, published, notified),
                subject={
                    "kind": "launch",
                    "key": str(launch.id),
                    "href": f"/roadmap/launches?launch={launch.id}",
                },
                undo=None,
                notify=[launch.owner_id or principal.id],
            )
    await audit.record(db, principal, "launch.launched", "launch", launch.id, data)
    await db.commit()
    if launch.kit_run_id is None:
        return await _start_kit_or_note(db, principal, launch)
    return None


def _acted_summary(launch: Launch, published: int, notified: int) -> str:
    done = []
    if published:
        done.append(f"published {published} internal changelog " + _plural(published, "entry"))
    if notified:
        done.append(f"told {notified} member " + _plural(notified, "requester"))
    return f"{launch.title} launched: Oracle {' and '.join(done)}"


def _plural(n: int, word: str) -> str:
    if n == 1:
        return word
    return word[:-1] + "ies" if word.endswith("y") else word + "s"


async def cancel_launch(
    db: AsyncSession, principal: Principal, launch: Launch, reason: str
) -> None:
    if launch.state not in LIVE_STATES:
        raise Conflict(f"A {launch.state} launch cannot be cancelled")
    launch.state = "cancelled"
    launch.cancel_reason = reason.strip()
    launch.lock_version += 1
    await audit.record(db, principal, "launch.cancelled", "launch", launch.id,
                       {"reason": launch.cancel_reason})  # fmt: skip


async def publish_internal(db: AsyncSession, launch: Launch) -> int:
    """Within limits only: Oracle publishes the launch's internal draft entries (never
    a public one)."""
    rows = list(
        await db.scalars(
            select(ChangelogEntry).where(
                ChangelogEntry.launch_id == launch.id,
                ChangelogEntry.status == "draft",
                ChangelogEntry.audience == "internal",
            )
        )
    )
    for entry in rows:
        entry.status = "published"
        entry.published_actor = audit.ORACLE
        entry.published_at = now()
        entry.lock_version += 1
        await audit.record(db, audit.ORACLE, "changelog.published", "changelog_entry", entry.id,
                           {"audience": "internal", "within_limits": True})  # fmt: skip
    return len(rows)


async def notify_members(db: AsyncSession, actor: Principal | str, launch: Launch) -> int:
    """Put a shown-only "Shipped" row, carrying the note, in each member requester's
    Inbox: their drafted notes become ``notified``."""
    rows = list(
        await db.scalars(
            select(RequesterNote).where(
                RequesterNote.launch_id == launch.id,
                RequesterNote.requester_kind == "member",
                RequesterNote.status == "drafted",
            )
        )
    )
    for note in rows:
        note.status = "notified"
        note.notified_at = now()
    if rows:
        await audit.record(db, actor, "launch.members_notified", "launch", launch.id,
                           {"notified": len(rows)})  # fmt: skip
    return len(rows)


# --- notes ---------------------------------------------------------------------------------


async def add_requester(
    db: AsyncSession,
    principal: Principal,
    launch: Launch,
    display_name: str,
    contact_hint: str | None,
    asked: str | None,
) -> RequesterNote:
    note = RequesterNote(
        launch_id=launch.id,
        requester_kind="manual",
        display_name=display_name.strip(),
        contact_hint=(contact_hint or "").strip() or None,
        asked=(asked or "").strip() or None,
    )
    db.add(note)
    await db.flush()
    await audit.record(db, principal, "launch.requester_added", "requester_note", note.id,
                       {"launch_id": str(launch.id)})  # fmt: skip
    return note


async def update_note(
    db: AsyncSession, principal: Principal, note: RequesterNote, fields: dict[str, Any]
) -> None:
    status = fields.get("status")
    if status == "sent":
        channel = fields.get("channel") or note.channel
        if not channel:
            raise LaunchError("Say how the note was sent (channel)")
        note.channel = channel
        note.sent_on = fields.get("sent_on") or company_time.day(
            now(), await company_time.company_time_zone(db)
        )
        note.sent_by = principal.id
        note.skip_reason = None
    elif status == "skipped":
        reason = (fields.get("skip_reason") or "").strip()
        if not reason:
            raise LaunchError("Skipping a note needs a reason")
        note.skip_reason = reason
    elif fields.get("channel") is not None:
        note.channel = fields["channel"]
    if fields.get("body") is not None:
        note.body = fields["body"]
    if status is not None:
        note.status = status
    await audit.record(db, principal, "launch.note_updated", "requester_note", note.id,
                       {"status": note.status, "channel": note.channel})  # fmt: skip


# --- Inbox -------------------------------------------------------------------------------


def _item_title(launch: Launch) -> str:
    return launch.title


async def inbox_rows(db: AsyncSession, principal: Principal) -> list[InboxLaunch]:
    """The launch rows of the caller's Inbox; ``counted`` ones add to its total."""
    rows: list[InboxLaunch] = []
    me = principal.id
    live = list(
        await db.scalars(
            select(Launch)
            .where(Launch.state.in_(("planned", "ready", "launched")))
            .order_by(Launch.created_at, Launch.id)
        )
    )
    for launch in live:
        if launch.state == "ready" and launch.owner_id == me:
            rows.append(
                InboxLaunch(
                    launch_id=launch.id, title=f"Ready to launch · {_item_title(launch)}",
                    item=_item_title(launch), reason="ready", state="ready", counted=True,
                    at=launch.ready_at,
                )
            )  # fmt: skip
        if (
            launch.state in LIVE_STATES
            and launch.tier is None
            and has_role(principal.role, "approver")
        ):
            rows.append(
                InboxLaunch(
                    launch_id=launch.id, title=f"Set tier · {_item_title(launch)}",
                    item=_item_title(launch), reason="set_tier", state=launch.state,  # type: ignore[arg-type]
                    counted=True, at=launch.created_at,
                )
            )  # fmt: skip
    mine = [x for x in live if x.state == "launched" and x.owner_id == me]
    if mine:
        _, notes = await _counts(db, [x.id for x in mine])
        for launch in mine:
            n = notes[launch.id].open
            if n:
                rows.append(
                    InboxLaunch(
                        launch_id=launch.id,
                        title=f"Notes to send · {_item_title(launch)} · {n}",
                        item=_item_title(launch), reason="notes_to_send", state="launched",
                        counted=True, count=n, at=launch.launched_at,
                    )
                )  # fmt: skip
    since = now() - timedelta(days=SHIPPED_ROW_DAYS)
    shipped = (
        await db.execute(
            select(RequesterNote, Launch)
            .join(Launch, Launch.id == RequesterNote.launch_id)
            .where(
                RequesterNote.member_id == me,
                RequesterNote.status == "notified",
                RequesterNote.notified_at >= since,
            )
            .order_by(RequesterNote.notified_at.desc())
        )
    ).all()
    hidden = await hidden_for(db) if shipped else None
    for note, launch in shipped:
        rows.append(
            InboxLaunch(
                launch_id=launch.id, title=f"Shipped: {_item_title(launch)}",
                item=_item_title(launch), reason="shipped_note", state=launch.state,  # type: ignore[arg-type]
                counted=False, count=0, at=note.notified_at,
                note=None if _withheld(hidden, note.body) else note.body,
            )
        )  # fmt: skip
    return rows
