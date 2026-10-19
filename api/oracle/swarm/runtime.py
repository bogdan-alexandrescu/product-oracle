"""The agent runtime protocol: what runs need from whatever executes their agents.

A run's segment is one multi-step workflow. Oracle submits it, polls its status and
cost, reads its artifacts when it ends, and may cancel it. Nothing else crosses this
boundary: the runtime has no view of Oracle's tenants, users or documents beyond the
prompts and the run token a spec carries.
"""

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Literal, Protocol, runtime_checkable

WorkflowState = Literal["running", "succeeded", "failed", "cancelled"]
TERMINAL: frozenset[str] = frozenset({"succeeded", "failed", "cancelled"})


@dataclass(frozen=True)
class StepSpec:
    """One agent step. ``role`` is the Oracle agent role; ``profile`` the runtime's name."""

    key: str
    role: str
    profile: str
    prompt: str
    depends_on: tuple[str, ...] = ()
    # Upstream step key -> artifact file name staged into this step.
    input_from: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class McpAccess:
    """Oracle's MCP server and the run token a segment's agents call it with."""

    url: str
    token: str
    scopes: tuple[str, ...]


@dataclass(frozen=True)
class WorkflowSpec:
    name: str
    steps: tuple[StepSpec, ...]
    # Artifact names Oracle expects back (e.g. "prd.md").
    outputs: tuple[str, ...] = ()
    mcp: McpAccess | None = None
    budget_usd: Decimal | None = None
    # Free-form labels the runtime may keep for attribution (run id, segment, attempt).
    labels: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class WorkflowStatus:
    state: WorkflowState
    cost_usd: Decimal = Decimal(0)
    error: str | None = None

    @property
    def terminal(self) -> bool:
        return self.state in TERMINAL


class RuntimeUnavailable(RuntimeError):
    """The runtime refused a call or could not be reached."""


@runtime_checkable
class AgentRuntime(Protocol):
    #: Short name shown on runs ("fake", "swarmcloud").
    name: str

    @property
    def can_reach_oracle(self) -> bool:
        """True when a submitted spec's ``mcp`` access reaches the agents."""
        ...

    def notes(self) -> list[str]:
        """Caveats about this runtime that a run's page should show."""
        ...

    async def submit(self, spec: WorkflowSpec) -> str:
        """Submit a workflow; returns the runtime's workflow id."""
        ...

    async def status(self, workflow_id: str) -> WorkflowStatus: ...

    async def cost(self, workflow_id: str) -> Decimal: ...

    async def artifacts(self, workflow_id: str) -> dict[str, str]:
        """Text artifacts by file name, once the workflow has ended."""
        ...

    async def cancel(self, workflow_id: str) -> None: ...

    async def whoami(self) -> dict[str, str | None]:
        """Who the runtime says Oracle is: ``{"tenant_id": ...}``. Raises
        :class:`RuntimeUnavailable` when it cannot be reached or refuses Oracle."""
        ...
