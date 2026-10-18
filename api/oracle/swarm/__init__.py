"""Agent runtimes that execute run segments (Lane E).

``get_runtime()`` returns the process-wide runtime chosen by ``ORACLE_RUNTIME``: the
deterministic :class:`FakeRuntime` (default) or :class:`SwarmCloudRuntime`. Tests swap
it with ``set_runtime()``.
"""

from oracle.swarm.fake import FakeRuntime, Outcome
from oracle.swarm.runtime import (
    AgentRuntime,
    McpAccess,
    RuntimeUnavailable,
    StepSpec,
    WorkflowSpec,
    WorkflowStatus,
)
from oracle.swarm.settings import get_runtime_settings
from oracle.swarm.swarmcloud import SwarmCloudRuntime

__all__ = [
    "AgentRuntime",
    "FakeRuntime",
    "McpAccess",
    "Outcome",
    "RuntimeUnavailable",
    "StepSpec",
    "SwarmCloudRuntime",
    "WorkflowSpec",
    "WorkflowStatus",
    "get_runtime",
    "set_runtime",
]

_runtime: AgentRuntime | None = None


def get_runtime() -> AgentRuntime:
    global _runtime
    if _runtime is None:
        settings = get_runtime_settings()
        if settings.runtime == "swarmcloud":
            _runtime = SwarmCloudRuntime.from_settings(settings)
        else:
            _runtime = FakeRuntime()
    return _runtime


def set_runtime(runtime: AgentRuntime | None) -> None:
    """Replace the process-wide runtime (``None``: rebuild from settings on next use)."""
    global _runtime
    _runtime = runtime
