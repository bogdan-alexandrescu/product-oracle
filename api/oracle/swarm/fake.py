"""A deterministic agent runtime for tests and local development.

Every workflow succeeds on its first poll, costs 90% of the estimate its spec carries,
and leaves generic artifacts for the segment it ran. Tests script other outcomes:

    runtime = FakeRuntime({"baseline": [Outcome(polls=2, cost_usd=Decimal("80"))]})

Each submission of a segment takes the next scripted outcome for it, then falls back to
the default. The workflow id encodes the segment, attempt and estimate, so a process
that did not submit it (``oracle tick`` against a running API) still answers for it.

Adapter v2's features are all off here (runs take today's one-workflow-per-segment
flow); tests of v2 drive :class:`oracle.swarm.SwarmCloudRuntime` against a fake
SwarmCloud API instead (``tests/swarmcloud_fake.py``).
"""

import re
import secrets
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from typing import Any

from oracle.swarm.runtime import (
    Answer,
    Features,
    RecordedAnswer,
    WorkflowSpec,
    WorkflowState,
    WorkflowStatus,
)

_ID = re.compile(r"^fake-(?P<segment>[a-z_]+)-a(?P<attempt>\d+)-c(?P<cents>\d+)-[0-9a-f]+$")

# Files each built-in segment leaves when no outcome is scripted.
SEGMENT_FILES: dict[str, tuple[str, ...]] = {
    "baseline": ("baseline.yaml", "summary.md"),
    "feature_set": ("feature_set.yaml", "design.md"),
    "priority": ("priority.yaml",),
    "prd_draft": ("prd.md",),
    "next_draft": ("prd.md", "resolutions.yaml"),
    "roadmap_items": ("roadmap_items.yaml",),
    "roadmap_draft": ("roadmap.md",),
}


@dataclass(frozen=True)
class Outcome:
    state: WorkflowState = "succeeded"
    # None: 90% of the spec's estimate.
    cost_usd: Decimal | None = None
    # None: the default files for the segment.
    artifacts: dict[str, str] | None = None
    # How many status polls answer "running" (with half the cost) before the end.
    polls: int = 0
    error: str | None = None


@dataclass
class _Record:
    segment: str
    attempt: int
    estimate: Decimal
    outcome: Outcome
    polls_left: int
    spec: WorkflowSpec | None = None
    cancelled: bool = False


def _default_files(segment: str, attempt: int, outputs: tuple[str, ...] = ()) -> dict[str, str]:
    files = {}
    names = SEGMENT_FILES.get(segment, ("summary.md",))
    # A segment whose draft file depends on the document's kind (the feedback loop on a
    # roadmap writes roadmap.md): the spec's outputs say which.
    if "roadmap.md" in outputs:
        names = tuple("roadmap.md" if n == "prd.md" else n for n in names)
    for name in names:
        files[name] = _default_content(name, segment, attempt)
    return files


def _default_content(name: str, segment: str, attempt: int) -> str:
    if name == "prd.md":
        return (
            "---\n"
            "title: Example product PRD\n"
            "template: oracle-default\n"
            "---\n\n"
            "# Example product PRD {#title}\n\n"
            "## Problem {#problem}\n\n"
            f"Draft {attempt} written by the local agent runtime. Buyers drop off when the\n"
            "total changes late in the flow.\n\n"
            "## Goal trace {#goal-trace}\n\n"
            "Serves G1 (activation).\n\n"
            "## Features {#features}\n\n"
            "1. Show the full price early.\n"
            "2. Keep form state on back navigation.\n\n"
            "## Open questions {#open-questions}\n\n"
            "- None yet.\n"
        )
    if name == "roadmap.md":
        return (
            "---\n"
            "title: Example product roadmap\n"
            "kind: roadmap\n"
            "template: now-next-later\n"
            "brief: [summary, brief-items]\n"
            "---\n\n"
            "# Example product roadmap {#roadmap}\n\n"
            "## Summary {#summary}\n\n"
            f"Draft {attempt} written by the local agent runtime.\n\n"
            "## Items by horizon {#brief-items}\n\n"
            "| Horizon | Item | Outcome |\n|---|---|---|\n"
            "| [Now](#now) | [Show the price early](#now-price) | Fewer drop-offs |\n\n"
            "# Full version {#full}\n\n"
            "## Now {#now}\n\n"
            "### Show the price early {#now-price}\n\n"
            "Buyers see the full price before checkout.\n\n"
            "## Next {#next}\n\n"
            "## Later {#later}\n\n"
            "## Sources and data points {#sources}\n\n"
            "- None yet.\n"
        )
    if name == "roadmap_items.yaml":
        return (
            f"# {segment} (local agent runtime, attempt {attempt})\n"
            "version: 1\n"
            "items:\n"
            "  - id: price-early\n"
            "    title: Show the price early\n"
            "    outcome: Fewer buyers drop off at checkout\n"
            "    horizon: now\n"
            "    milestone: Beta\n"
            "    depends_on: []\n"
            "    priority: {score: 1, rank: 1, explanation: local agent runtime}\n"
            "    confidence: medium\n"
            "    prd_section: features\n"
        )
    if name == "baseline.yaml":
        # The baseline YAML format (oracle.baseline.yaml_io); nothing to propose.
        return (
            f"# {segment} (local agent runtime, attempt {attempt})\n"
            "version: 1\nentities: []\nedges: []\n"
        )
    if name.endswith(".yaml"):
        return f"# {segment} (local agent runtime, attempt {attempt})\nitems: []\n"
    return f"# {segment}\n\nWritten by the local agent runtime (attempt {attempt}).\n"


@dataclass
class FakeRuntime:
    script: dict[str, list[Outcome]] = field(default_factory=dict)
    name: str = "fake"
    submitted: list[WorkflowSpec] = field(default_factory=list)
    cancelled: list[str] = field(default_factory=list)
    # None: run tokens are accepted from any address (no runtime egress to check).
    egress: frozenset[str] | None = None
    _records: dict[str, _Record] = field(default_factory=dict)

    @property
    def can_reach_oracle(self) -> bool:
        return True

    def notes(self) -> list[str]:
        return ["Local agent runtime: segments finish at once with generic drafts."]

    async def whoami(self) -> dict[str, str | None]:
        return {"tenant_id": "fake"}

    def _record(self, workflow_id: str) -> _Record:
        record = self._records.get(workflow_id)
        if record is not None:
            return record
        m = _ID.match(workflow_id)
        if m is None:
            raise LookupError(f"unknown workflow {workflow_id}")
        record = _Record(
            segment=m["segment"],
            attempt=int(m["attempt"]),
            estimate=Decimal(m["cents"]) / 100,
            outcome=Outcome(),
            polls_left=0,
        )
        self._records[workflow_id] = record
        return record

    def _cost(self, record: _Record) -> Decimal:
        if record.outcome.cost_usd is not None:
            return record.outcome.cost_usd
        return (record.estimate * Decimal("0.9")).quantize(Decimal("0.0001"))

    async def features(self, *, refresh: bool = False) -> Features:
        # Off, with nothing to report on a run: the local runtime has no such switches.
        return Features()

    async def ensure_mcp_server(self, url: str) -> str:
        return "unchanged"

    async def egress_addresses(self) -> frozenset[str] | None:
        return self.egress

    async def find_by_label(self, label: str, since: datetime | None = None) -> str | None:
        for workflow_id, record in self._records.items():
            if record.spec is not None and record.spec.label == label:
                return workflow_id
        return None

    async def answer(
        self,
        workflow_id: str,
        step_id: str,
        *,
        answer_id: str,
        payload: dict[str, Any],
        on_behalf_of: str | None = None,
    ) -> Answer:
        raise LookupError("the local agent runtime has no steps that wait for a person")

    async def answer_record(self, workflow_id: str, step_id: str, artifact: str) -> RecordedAnswer:
        raise LookupError("the local agent runtime has no steps that wait for a person")

    async def submit(self, spec: WorkflowSpec) -> str:
        segment = spec.labels.get("segment", spec.name)
        attempt = int(spec.labels.get("attempt", "1"))
        estimate = Decimal(spec.labels.get("estimate_usd", "0"))
        queue = self.script.get(segment)
        outcome = queue.pop(0) if queue else Outcome()
        cents = int((estimate * 100).to_integral_value())
        workflow_id = f"fake-{segment}-a{attempt}-c{cents}-{secrets.token_hex(4)}"
        self._records[workflow_id] = _Record(
            segment=segment,
            attempt=attempt,
            estimate=estimate,
            outcome=outcome,
            polls_left=outcome.polls,
            spec=spec,
        )
        self.submitted.append(spec)
        return workflow_id

    async def status(self, workflow_id: str) -> WorkflowStatus:
        record = self._record(workflow_id)
        if record.cancelled:
            return WorkflowStatus("cancelled", self._cost(record) / 2)
        if record.polls_left > 0:
            record.polls_left -= 1
            return WorkflowStatus("running", self._cost(record) / 2)
        o = record.outcome
        return WorkflowStatus(o.state, self._cost(record), o.error)

    async def cost(self, workflow_id: str) -> Decimal:
        record = self._record(workflow_id)
        if record.cancelled or record.polls_left > 0:
            return self._cost(record) / 2
        return self._cost(record)

    async def artifacts(
        self,
        workflow_id: str,
        steps: tuple[str, ...] | None = None,
        *,
        prefer: tuple[str, ...] = (),
    ) -> dict[str, str]:
        record = self._record(workflow_id)
        if record.outcome.artifacts is not None:
            return dict(record.outcome.artifacts)
        outputs = tuple(record.spec.outputs) if record.spec is not None else ()
        return _default_files(record.segment, record.attempt, outputs)

    async def cancel(self, workflow_id: str) -> None:
        self._record(workflow_id).cancelled = True
        self.cancelled.append(workflow_id)
