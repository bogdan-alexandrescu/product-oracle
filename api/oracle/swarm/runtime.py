"""The agent runtime protocol: what runs need from whatever executes their agents.

A run's segment is one multi-step workflow. Oracle submits it, polls its status and
cost, reads its artifacts when it ends, and may cancel it. Nothing else crosses this
boundary: the runtime has no view of Oracle's tenants, users or documents beyond the
prompts and the run token a spec carries.

Adapter v2 (docs/swarmcloud-interface.md) adds what a runtime may offer behind feature
switches: attaching Oracle's MCP server with the run token (``mcp``), steps that wait
for a person (``await_input``), and Oracle's own principal answering them
(``service_answer``). :meth:`AgentRuntime.features` says which are on; a run uses a
feature only while it is on and keeps today's one-workflow-per-segment flow otherwise.
"""

from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from typing import Any, Literal, Protocol, runtime_checkable

WorkflowState = Literal["running", "succeeded", "failed", "cancelled"]
TERMINAL: frozenset[str] = frozenset({"succeeded", "failed", "cancelled"})
FeatureState = Literal["on", "off", "unknown"]
FEATURES = ("mcp", "await_input", "service_answer")

# The profile of a step that waits for a person, and the verdicts it takes.
AWAIT_PROFILE = "await-input"
MERGE, NOT_YET = "MERGE", "NOT_YET"
# The name Oracle's MCP server is registered under in the runtime.
MCP_SERVER = "oracle"


@dataclass(frozen=True)
class StepSpec:
    """One step. ``role`` is the Oracle agent role (``reviewer`` for a wait for a person);
    ``profile`` the runtime's name."""

    key: str
    role: str
    profile: str
    prompt: str
    depends_on: tuple[str, ...] = ()
    # Upstream step key -> artifact file name staged into this step.
    input_from: dict[str, str] = field(default_factory=dict)
    # A wait for a person: the runtime's ``await_input`` object (form, artifact, expiry).
    await_input: dict[str, Any] | None = None
    # Run only on a verdict of an earlier wait: {"step": ..., "verdict_in": [...]}.
    when: dict[str, Any] | None = None

    @property
    def waits(self) -> bool:
        return self.await_input is not None


@dataclass(frozen=True)
class McpAccess:
    """Oracle's MCP server and the run token a segment's agents call it with.

    ``attach`` is True only when the runtime sends the token to the server for the
    agents (the caller-MCP feature is on); ``expires_in`` is then the credential's
    lifetime from submission, the same as the run token's."""

    url: str
    token: str = field(repr=False)
    scopes: tuple[str, ...]
    expires_in: int = 0
    attach: bool = False
    server: str = MCP_SERVER


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
    # The submission's de-duplication label: ``oracle-<run id>-<segment>-<attempt>``.
    label: str | None = None

    @property
    def waits(self) -> bool:
        return any(s.waits for s in self.steps)


@dataclass(frozen=True)
class StepStatus:
    step_id: str
    task_id: str | None = None
    # The runtime's task state, upper case (PENDING, RUNNING, PARKED, SUCCEEDED, ...);
    # SKIPPED for a gated step whose verdict did not match.
    state: str = "PENDING"
    error: str | None = None


@dataclass(frozen=True)
class Parked:
    """A step whose task is parked: waiting for a person, or for its credential."""

    step_id: str
    task_id: str | None
    # AWAITING_INPUT | CREDENTIAL_MISSING | another runtime reason
    reason: str
    opened_at: datetime | None = None
    expires_at: datetime | None = None


@dataclass(frozen=True)
class WorkflowStatus:
    state: WorkflowState
    cost_usd: Decimal = Decimal(0)
    error: str | None = None
    # The runtime's code for the failure (mcp_credential_expired, expired, ...), if any.
    error_code: str | None = None
    steps: tuple[StepStatus, ...] = ()
    parked: tuple[Parked, ...] = ()

    @property
    def terminal(self) -> bool:
        return self.state in TERMINAL

    def step(self, step_id: str) -> StepStatus | None:
        return next((s for s in self.steps if s.step_id == step_id), None)


@dataclass(frozen=True)
class Features:
    """Which adapter v2 features the runtime has switched on, and why one is not."""

    mcp: FeatureState = "off"
    await_input: FeatureState = "off"
    service_answer: FeatureState = "off"
    reasons: dict[str, str] = field(default_factory=dict)

    def as_dict(self) -> dict[str, FeatureState]:
        return {
            "mcp": self.mcp,
            "await_input": self.await_input,
            "service_answer": self.service_answer,
        }


@dataclass(frozen=True)
class Answer:
    """The runtime's reply to an answer: accepted, or replayed (the same answer again)."""

    replayed: bool = False


class RuntimeUnavailable(RuntimeError):
    """The runtime refused a call or could not be reached.

    ``code`` is the runtime's refusal code when it gave one (``mcp_unavailable``,
    ``already_answered``, ...); ``status`` its HTTP status; ``lost`` is True when the
    answer never arrived (a timeout, a dropped connection or a 5xx), so the call may
    have happened."""

    def __init__(
        self,
        message: str,
        *,
        code: str | None = None,
        status: int | None = None,
        lost: bool = False,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.status = status
        self.lost = lost


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

    async def artifacts(
        self, workflow_id: str, steps: tuple[str, ...] | None = None
    ) -> dict[str, str]:
        """Text artifacts by file name: of the whole workflow once it has ended, or of
        the named steps (read by their task ids) while it waits."""
        ...

    async def cancel(self, workflow_id: str) -> None: ...

    async def whoami(self) -> dict[str, str | None]:
        """Who the runtime says Oracle is: ``{"tenant_id": ...}``. Raises
        :class:`RuntimeUnavailable` when it cannot be reached or refuses Oracle."""
        ...

    async def features(self, *, refresh: bool = False) -> Features:
        """Which v2 features are on; cached briefly, never slower than the timeout."""
        ...

    async def ensure_mcp_server(self, url: str) -> str:
        """Register Oracle's MCP server at ``url`` once: ``created``, ``updated`` (the URL
        changed) or ``unchanged``."""
        ...

    async def egress_addresses(self) -> frozenset[str] | None:
        """The addresses the runtime calls Oracle's MCP server from; ``None`` when this
        runtime places no limit (a local runtime)."""
        ...

    async def find_by_label(self, label: str) -> str | None:
        """The workflow submitted with ``label``, if any (submits are not idempotent)."""
        ...

    async def answer(
        self,
        workflow_id: str,
        step_id: str,
        *,
        answer_id: str,
        payload: dict[str, Any],
        on_behalf_of: str | None = None,
    ) -> Answer:
        """Answer a waiting step as Oracle's principal."""
        ...
