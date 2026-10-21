"""The built-in launch checklist per tier (research [66]). People add tasks to a
launch or skip them with a reason; a tier change adds the tier's missing tasks and
removes untouched ``todo`` tasks the new tier does not list (never one a person or
Oracle touched, nor one a person added).

``drafts``: whether Oracle's ``launch_kit`` run drafts the task's text (``yes``), an
outline only (``outline``), or a person does it (``no``). ``optional_in``: tiers where
the task is listed as optional (kept, or skipped with a reason)."""

from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.launches.models import Launch, LaunchTask


@dataclass(frozen=True)
class TaskDef:
    key: str
    title: str
    audience: str
    drafts: str
    tiers: tuple[int, ...]
    optional_in: tuple[int, ...] = ()


TASKS: tuple[TaskDef, ...] = (
    TaskDef("changelog_entry", "Changelog entry", "external", "yes", (1, 2, 3)),
    TaskDef("release_notes", "Release notes", "external", "yes", (1, 2)),
    TaskDef("internal_announcement", "Internal announcement", "internal", "yes", (1, 2)),
    TaskDef(
        "support_notes",
        "Support notes (what changed, known limits, FAQ)",
        "internal",
        "yes",
        (1, 2, 3),
    ),
    TaskDef("sales_briefing", "Sales and success briefing", "internal", "yes", (1,)),
    TaskDef("help_docs", "Help docs update", "external", "outline", (1, 2)),
    TaskDef("in_app_message", "In-app message", "external", "yes", (1, 2), (2,)),
    TaskDef("customer_email", "Customer email", "external", "yes", (1, 2), (2,)),
    TaskDef("positioning_check", "Positioning check", "internal", "no", (1,)),
    TaskDef("demo", "Demo", "internal", "no", (1,)),
    TaskDef(
        "pre_mortem",
        "Pre-mortem (tigers, paper tigers, elephants)",
        "internal",
        "yes",
        (1,),
    ),
    TaskDef("requester_notes", "Notes to the people who asked", "external", "yes", (1, 2, 3)),
)
BY_KEY = {t.key: t for t in TASKS}
ORDER = {t.key: i for i, t in enumerate(TASKS)}
# The line an external task's draft carries: Oracle never sends anything outside (L1).
EXTERNAL_NOTICE = "Draft by Oracle. A person checks and sends it."


def for_tier(tier: int) -> list[TaskDef]:
    return [t for t in TASKS if tier in t.tiers]


def untouched(task: LaunchTask) -> bool:
    """A checklist task nobody changed: still todo, no text, never edited."""
    return (
        task.key in BY_KEY
        and task.status == "todo"
        and task.body is None
        and task.lock_version == 1
    )


async def tasks_of(db: AsyncSession, launch_id) -> list[LaunchTask]:
    return list(
        await db.scalars(
            select(LaunchTask)
            .where(LaunchTask.launch_id == launch_id)
            .order_by(LaunchTask.position, LaunchTask.created_at, LaunchTask.id)
        )
    )


def _renumber(tasks: list[LaunchTask]) -> None:
    """The table's order first, then the tasks people added, in the order they came."""
    ranked = sorted(
        tasks,
        key=lambda t: (0, ORDER[t.key], 0) if t.key in ORDER else (1, 0, t.position),
    )
    for i, task in enumerate(ranked, start=1):
        if task.position != i:
            task.position = i


async def apply(db: AsyncSession, launch: Launch, tier: int) -> None:
    """Make the launch's checklist the tier's: add what is missing, drop untouched todo
    tasks the tier does not list, keep the rest."""
    tasks = await tasks_of(db, launch.id)
    wanted = {t.key for t in for_tier(tier)}
    kept = []
    for task in tasks:
        if task.key not in wanted and untouched(task):
            await db.delete(task)
        else:
            kept.append(task)
    have = {t.key for t in kept}
    for i, tdef in enumerate(for_tier(tier)):
        if tdef.key in have:
            continue
        task = LaunchTask(
            launch_id=launch.id,
            key=tdef.key,
            title=tdef.title,
            audience=tdef.audience,
            position=1000 + i,
            owner_id=launch.owner_id,
        )
        db.add(task)
        kept.append(task)
    _renumber(kept)
    await db.flush()
