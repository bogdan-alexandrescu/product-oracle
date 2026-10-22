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

import json
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
    "spec_draft": ("spec.md", "design.json"),
}
# The machine-readable line a spec prompt carries (oracle.specs.service.prompt_lines).
_SPEC_INPUTS = re.compile(r"^Spec inputs \(JSON\): (\{.*\})$", re.M)
_SPEC_SECTIONS = (
    ("summary", "Summary"),
    ("approach", "Proposed engineering approach"),
    ("open-decisions", "Open engineering decisions"),
    ("user-flows", "User flows"),
    ("inputs-outputs", "Inputs and outputs"),
    ("architecture", "Proposed architecture"),
    ("apis-data", "APIs and data models"),
    ("dependencies", "Dependencies"),
    ("failure-modes", "Failure modes"),
    ("security-privacy-performance", "Security, privacy and performance"),
    ("test-strategy", "Test strategy"),
    ("release-flags", "Release flags"),
    ("migration-rollback", "Migration and rollback"),
    ("assumptions", "Assumptions"),
)


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


# The PRD a step's prompt names ("PRD document '<slug>'", oracle.runs.flows.step_prompt).
_DOCUMENT = re.compile(r"document '([^']+)'")


def document_of(prompt: str) -> str | None:
    """The document slug a step's prompt names, if any: the default feature_set.yaml
    names it, as the run's agents are told to."""
    m = _DOCUMENT.search(prompt or "")
    return m[1] if m else None


# The approved PRD scope a prompt pastes (oracle.runs.flows: "--- PRD scope ---").
_SCOPE = re.compile(r"^--- PRD scope ---\n(.*?)(?:\n\n|\Z)", re.M | re.S)


def scope_order_of(prompt: str) -> list[str] | None:
    """The included feature keys of the approved PRD scope a prompt pastes, each after the
    features it depends on (as the run's prioritizer is told), or None when none is pasted:
    the default priority.yaml ranks them."""
    m = _SCOPE.search(prompt or "")
    if m is None:
        return None
    from oracle import safe_yaml

    try:
        data = safe_yaml.load(m[1])
    except Exception:  # noqa: BLE001 - a pasted scope the fake cannot read: the default order
        return None
    features = [
        f for f in (data or {}).get("features") or [] if isinstance(f, dict) and f.get("key")
    ]
    keys = [str(f["key"]) for f in features]
    deps = {
        str(f["key"]): [str(d) for d in f.get("depends_on") or [] if d in keys] for f in features
    }
    order: list[str] = []

    def place(key: str, seen: frozenset[str] = frozenset()) -> None:
        if key in order or key in seen:
            return
        for dep in deps.get(key, []):
            place(dep, seen | {key})
        order.append(key)

    for key in keys:
        place(key)
    return order


def _spec_inputs(prompt: str) -> dict:
    m = _SPEC_INPUTS.search(prompt)
    if m is None:
        return {}
    try:
        return json.loads(m.group(1))
    except ValueError:
        return {}


def _spec_md(attempt: int) -> str:
    parts = [
        f"## {title} {{#{key}}}\n\nWritten by the local agent runtime (attempt {attempt})."
        for key, title in _SPEC_SECTIONS
    ]
    return "\n\n".join(parts) + "\n"


def _design_json(inputs: dict) -> str:
    """Placeholder flows and wireframes linked to the prompt's sections and requirements."""
    if not inputs.get("design", True):
        return json.dumps({"version": 1, "flows": [], "wireframes": []})
    sections = list(inputs.get("section_keys") or [])[:1]
    reqs = list(inputs.get("requirement_ids") or [])[:1]
    screens = max(2, min(4, int(inputs.get("screens") or 2)))
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 80">'
        '<rect id="step-1" x="10" y="20" width="120" height="40" fill="#eee" stroke="#333"/>'
        '<text x="70" y="45" text-anchor="middle">Start</text>'
        '<rect id="step-2" x="190" y="20" width="120" height="40" fill="#eee" stroke="#333"/>'
        '<text x="250" y="45" text-anchor="middle">Done</text>'
        '<line x1="130" y1="40" x2="190" y2="40" stroke="#333"/></svg>'
    )
    note = {
        "id": "a1",
        "target": "step-1",
        "note": "Placeholder step.",
        "section_key": sections[0] if sections else None,
        "requirement_ids": reqs,
    }
    flows = [
        {
            "name": "main-flow.svg",
            "title": "Main flow",
            "svg": svg,
            "section_keys": sections,
            "requirement_ids": reqs,
            "annotations": [note],
        }
    ]
    wireframes = [
        {"name": f"screen-{n}.html", "title": f"Screen {n}", "screen": f"screen-{n}",
         "html": f'<h1 id="title-{n}">Screen {n}</h1><p>Placeholder content.</p>'
                 '<button>Continue</button>',
         "section_keys": sections, "requirement_ids": reqs,
         "annotations": [{**note, "target": f"title-{n}"}]}
        for n in range(1, screens + 1)
    ]  # fmt: skip
    return json.dumps({"version": 1, "flows": flows, "wireframes": wireframes})


def _default_files(
    segment: str, attempt: int, outputs: tuple[str, ...] = (), prompt: str = ""
) -> dict[str, str]:
    files = {}
    if segment == "spec_draft":
        return {"spec.md": _spec_md(attempt), "design.json": _design_json(_spec_inputs(prompt))}
    names = SEGMENT_FILES.get(segment, ("summary.md",))
    # A segment whose draft file depends on the document's kind (the feedback loop on a
    # roadmap writes roadmap.md): the spec's outputs say which.
    if "roadmap.md" in outputs:
        names = tuple("roadmap.md" if n == "prd.md" else n for n in names)
    document = document_of(prompt)
    for name in names:
        files[name] = _default_content(name, segment, attempt, document, scope_order_of(prompt))
    return files


def _default_content(
    name: str,
    segment: str,
    attempt: int,
    document: str | None = None,
    scope: list[str] | None = None,
) -> str:
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
        # The baseline YAML format (oracle.baseline.yaml_io): the one feature the default
        # feature_set.yaml includes.
        return (
            f"# {segment} (local agent runtime, attempt {attempt})\n"
            "version: 1\n"
            "entities:\n"
            "  - {type: feature, key: price-early, title: Show the price early}\n"
            "edges: []\n"
        )
    if name == "feature_set.yaml":
        # The C6 format (oracle.runs.feature_set): the baseline's one feature, serving no
        # confirmed goal yet (flagged, not blocking).
        return (
            f"# {segment} (local agent runtime, attempt {attempt})\n"
            "version: 1\n" + (f"document: {document}\n" if document else "") + "features:\n"
            "  - key: price-early\n"
            "    title: Show the price early\n"
            "    summary: Buyers see the full price before checkout\n"
            "    goals: []\n"
            "    depends_on: []\n"
            "    confidence: 0.8\n"
            "    requirements: []\n"
            "excluded: []\n"
        )
    if name == "requests_triage.yaml":
        # C1 (oracle.requests.triage): nothing classified, nothing found.
        return (
            f"# {segment} (local agent runtime, attempt {attempt})\n"
            "version: 1\nrequests: []\nfound: []\n"
        )
    if name == "priority.yaml":
        # The C8 format (oracle.priorities.run_order): the approved scope the prompt pastes,
        # in dependency order, else the default feature set's one feature.
        rows = "".join(
            f"  - key: {key}\n    rank: {n}\n    score: 0\n"
            "    explanation: Ranked by the local agent runtime\n"
            for n, key in enumerate(scope or ["price-early"], start=1)
        )
        return (
            f"# {segment} (local agent runtime, attempt {attempt})\n"
            "version: 1\nmethod: goal_weighted\norder:\n" + rows
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
        self, workflow_id: str, steps: tuple[str, ...] | None = None
    ) -> dict[str, str]:
        record = self._record(workflow_id)
        if record.outcome.artifacts is not None:
            return dict(record.outcome.artifacts)
        outputs = tuple(record.spec.outputs) if record.spec is not None else ()
        prompt = record.spec.steps[-1].prompt if record.spec and record.spec.steps else ""
        return _default_files(record.segment, record.attempt, outputs, prompt)

    async def cancel(self, workflow_id: str) -> None:
        self._record(workflow_id).cancelled = True
        self.cancelled.append(workflow_id)
