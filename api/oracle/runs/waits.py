"""Why SwarmCloud holds a run's step, in plain words (owner, 2026-10-26).

SwarmCloud parks a task with a ``park_reason`` while it holds it: at admission when no
Claude account lent to Oracle's tenant has quota (PROVIDER_QUOTA_EXHAUSTED), while there
is no room for it, or while its dependencies have not finished (DEPENDENCY_INCOMPLETE, an
ordinary wait: nothing extra is shown). The task document Oracle reads
(oracle.swarm.swarmcloud) carries neither when the park began nor when it should clear:
the moment shown is when Oracle first read the step held (its workflow's submission, on
the first read after it), and no clearing time is shown.

A run's current workflow that has started no agent :data:`NOT_STARTED_SECONDS` after its
submission waits in the Inbox for its owner or creator (Cancel, Open).
"""

import re

from oracle.swarm.runtime import WORKING, StepStatus

QUOTA = "Waiting for a Claude account: the accounts lent to Oracle have no quota left"
ROOM = "Waiting for room in SwarmCloud"
WORDS: dict[str, str] = {
    "PROVIDER_QUOTA_EXHAUSTED": QUOTA,
    # Its run note (workflow.ADVICE) says who acts; the Runs row says what it waits for.
    "CREDENTIAL_MISSING": "Waiting for Oracle's connection to SwarmCloud to be switched back on",
}
# Ordinary waits: the dependencies are not done, or a checkpoint waits for a person
# (shown as the checkpoint).
SILENT = frozenset({"DEPENDENCY_INCOMPLETE", "AWAITING_INPUT"})
# Capacity and pool waits, whatever SwarmCloud names them (owner, 2026-10-26: a reason
# containing any of these; SLOT covers SLOTS).
_ROOM = re.compile(r"CAPACITY|POOL|CONCURRENCY|SLOT|NO_ROOM|QUEUE_FULL")

NOT_STARTED_SECONDS = 30 * 60

# A step's task that has not been handed to an agent yet.
QUEUED_STATES = frozenset({"PENDING", "READY", "QUEUED", "SUBMITTED"})


def words(reason: str | None) -> str | None:
    """A park reason in plain words; None for an ordinary wait. A reason Oracle has no
    words for is shown as SwarmCloud's code."""
    if not reason or reason in SILENT:
        return None
    if reason in WORDS:
        return WORDS[reason]
    if _ROOM.search(reason):
        return ROOM
    return f"Held by SwarmCloud: {reason}"


def began(step: StepStatus) -> bool:
    """Whether the step's agent has started (a failure alone does not say it did)."""
    if step.started_at is not None or step.state in WORKING or step.state == "SUCCEEDED":
        return True
    # A wait for a person opens only after the agents before it ran.
    return step.state == "PARKED" and step.park_reason == "AWAITING_INPUT"


def waits(step: StepStatus) -> bool:
    """Whether the step waits to start, held or queued (not for its dependencies)."""
    if not step.task_read or began(step):
        return False
    if step.state == "PARKED":
        return step.park_reason not in SILENT
    return step.state in QUEUED_STATES


def minutes(seconds: float) -> str:
    """'45 min', '2 h', '2 h 5 min': a wait, to the nearest minute."""
    total = max(0, round(seconds / 60))
    hours, mins = divmod(total, 60)
    if not hours:
        return f"{mins} min"
    return f"{hours} h {mins} min" if mins else f"{hours} h"


def restarted_note(waited: float) -> str:
    return (
        f"Restarted once: its key expired while it waited {minutes(waited)} in SwarmCloud's queue"
    )


def queued_expiry(waited: float, restarted: bool) -> str:
    """A run's error when its key expired before its failing step started."""
    then = (
        "Oracle restarted it once already, so it must be started again."
        if restarted
        else "Start the run again."
    )
    return (
        f"The run's key expired while it waited in SwarmCloud's queue for "
        f"{minutes(waited)}, before its work began (mcp_credential_expired). {then}"
    )
