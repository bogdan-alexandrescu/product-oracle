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
# The one list of SwarmCloud step states (StepStatus.state, upper case) that mean the
# workflow has NOT reached a step: not started yet (PENDING), or never to run (SKIPPED: a
# gated step whose verdict did not match). Deny by default: any other state, one
# SwarmCloud adds later, or no row for the step at all, counts as reached. A run token is
# read-only from the moment a checkpoint's review step is reached (W5, owner 2026-10-19).
NOT_REACHED_STATES: frozenset[str] = frozenset({"PENDING", "SKIPPED"})
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


@dataclass(frozen=True)
class RecordedAnswer:
    """The answer a waiting step holds, as the runtime recorded it: who answered and when
    (``GET .../steps/{step}/input``), and the verdict from the step's form artifact. The
    runtime never serves the payload back, and its hash is over its own re-serialised
    form, so the verdict is the only thing to compare."""

    answer_id: str | None = None
    answered_by: str | None = None
    on_behalf_of: str | None = None
    answered_at: datetime | None = None
    via: str | None = None
    # MERGE | NOT_YET, or None when the form artifact could not be read.
    verdict: str | None = None
    findings: tuple[str, ...] = ()
    # The wait's state: waiting, not_open, answered, expired or cancelled.
    state: str | None = None
    # Recorded as posted by Oracle's own principal through its channel (not the console).
    by_oracle: bool = False
    # ``answered_by`` is not what SwarmCloud recorded (redaction withheld or clipped part
    # of it): never matched to a member.
    answered_by_altered: bool = False

    @property
    def answered(self) -> bool:
        return self.answer_id is not None or self.state == "answered"


class RuntimeUnavailable(RuntimeError):
    """The runtime refused a call or could not be reached.

    ``code`` is the runtime's refusal reason when it gave one (``detail.reason`` of its
    error envelope, e.g. ``already_answered``, else its top-level code such as
    ``mcp_unavailable``); ``status`` its HTTP status; ``detail`` the envelope's
    ``detail`` object; ``lost`` is True when the answer never arrived (a timeout, a
    dropped connection or a 5xx), so the call may have happened; ``gone`` is True only
    when the runtime's own error envelope says the thing asked about does not exist (a
    404 ``not_found``): a bare 404 (a proxy's page, a changed URL or principal) proves
    nothing and is retryable."""

    def __init__(
        self,
        message: str,
        *,
        code: str | None = None,
        status: int | None = None,
        lost: bool = False,
        detail: dict[str, Any] | None = None,
        gone: bool = False,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.status = status
        self.lost = lost
        self.detail = detail or {}
        self.gone = gone

    @property
    def retryable(self) -> bool:
        """Nothing was recorded and the same call may succeed later: the answer was lost,
        or the runtime was unavailable (a 5xx or 429)."""
        return (
            self.lost
            or self.status is None
            or self.status >= 500
            or self.status == 429
            or (self.status == 404 and not self.gone)
        )


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

    async def find_by_label(self, label: str, since: datetime | None = None) -> str | None:
        """The workflow submitted with ``label`` (its ``oracle_key``), if any: submits are
        not idempotent. ``since``: when the submission was sent; the search ends, "not
        found", at the first task older than that (less a clock-skew margin)."""
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

    async def answer_record(self, workflow_id: str, step_id: str, artifact: str) -> RecordedAnswer:
        """The wait's state and the answer it holds, if any (after a 409
        ``already_answered``, or watched while the run waits): the runtime's record and
        the verdict from the step's form ``artifact``."""
        ...
