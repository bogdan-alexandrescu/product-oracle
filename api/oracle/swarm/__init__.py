"""Agent runtimes that execute run segments (Lane E).

``get_runtime()`` returns the process-wide runtime chosen by ``ORACLE_RUNTIME``:
:class:`SwarmCloudRuntime` (default; runs execute in SwarmCloud, on SwarmCloud's own
Claude accounts) or the deterministic :class:`FakeRuntime`, which tests choose with
``set_runtime()`` or ``ORACLE_RUNTIME=fake``. SwarmCloud chosen but not configured is
:class:`UnconfiguredSwarmCloud`: runs say what is missing instead of the API failing.
"""

from oracle.swarm.fake import FakeRuntime, Outcome
from oracle.swarm.runtime import (
    AgentRuntime,
    Answer,
    Features,
    McpAccess,
    Parked,
    RecordedAnswer,
    RuntimeUnavailable,
    StepSpec,
    StepStatus,
    WorkflowSpec,
    WorkflowStatus,
)
from oracle.swarm.settings import get_runtime_settings
from oracle.swarm.swarmcloud import SwarmCloudRuntime, UnconfiguredSwarmCloud, redact

__all__ = [
    "AgentRuntime",
    "Answer",
    "FakeRuntime",
    "Features",
    "McpAccess",
    "Outcome",
    "Parked",
    "RecordedAnswer",
    "RuntimeUnavailable",
    "StepSpec",
    "StepStatus",
    "SwarmCloudRuntime",
    "UnconfiguredSwarmCloud",
    "WorkflowSpec",
    "WorkflowStatus",
    "get_runtime",
    "load_learned",
    "redact",
    "close_runtime",
    "set_runtime",
]

_runtime: AgentRuntime | None = None


def get_runtime() -> AgentRuntime:
    global _runtime
    if _runtime is None:
        settings = get_runtime_settings()
        if settings.runtime == "swarmcloud":
            try:
                _runtime = SwarmCloudRuntime.from_settings(settings)
            except ValueError as e:
                _runtime = UnconfiguredSwarmCloud(str(e))
        else:
            _runtime = FakeRuntime()
    return _runtime


def set_runtime(runtime: AgentRuntime | None) -> None:
    """Replace the process-wide runtime (``None``: rebuild from settings on next use)."""
    global _runtime
    _runtime = runtime


async def load_learned(runtime: AgentRuntime) -> None:
    """Before a synchronous read of what the runtime can do (``can_reach_oracle``,
    ``notes()``): read what every instance learned about its features (the database), so
    a fresh process does not report a confirmed feature as unknown. A runtime that learns
    nothing does nothing."""
    load = getattr(runtime, "load_learned", None)
    if load is not None:
        await load()


async def close_runtime() -> None:
    """Close the runtime's shared HTTP client, if it made one (on shutdown)."""
    close = getattr(_runtime, "aclose", None)
    if close is not None:
        await close()
