"""Code-defined flows (W1) with their knobs, cost table and segment prompts.

A flow is a list of segments. A segment is one agent workflow (one step per agent
role) that ends at a checkpoint (W2); until SwarmCloud's ``await_input`` (#1436)
lands, Oracle submits one workflow per segment and re-sends earlier outputs in the
next segment's prompt. Each segment's run token carries only the scopes it needs.

Knobs: ``depth`` (quick | standard | deep), agent ``roles`` per segment, which
``checkpoints`` are on (all by default) and ``budget_usd`` (a cap on the estimate).
"""

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

# Runs whose estimate is above this wait for an owner's approval (P3).
APPROVAL_THRESHOLD_USD = Decimal(50)
# Spend past this multiple of the estimate pauses the run (P3).
OVERRUN_FACTOR = Decimal("1.5")
DEPTHS: dict[str, Decimal] = {"quick": Decimal("0.5"), "standard": Decimal(1), "deep": Decimal(2)}
DEPTH_GUIDANCE = {
    "quick": "Depth: quick. Use the strongest few sources per claim and keep outputs short.",
    "standard": "Depth: standard. Cover every goal and feature with its best evidence.",
    "deep": "Depth: deep. Look for contradicting evidence on every claim and say how you "
    "resolved it.",
}

# Tools of Oracle's MCP server (/mcp) that segment prompts name.
MCP_TOOLS = {
    "search_sources": "full-text search over the sources you may read, ranked by "
    "relevance x confidence",
    "get_source_item": "one source item at the run's pinned snapshot, with its confidence",
    "get_baseline": "the baseline graph: goals, products, features, edges, evidence",
    "get_traceability": "features that serve no confirmed goal",
    "get_document": "a PRD and its versions",
    "get_feedback_package": "a version's open feedback items and locked sections",
    "propose_change": "propose a baseline change (locked items become proposals)",
    "submit_draft": "hand back a draft for import",
}


@dataclass(frozen=True)
class AgentRole:
    key: str
    title: str
    description: str
    # Cost of one step at standard depth, from the cost table below.
    base_usd: Decimal


# The cost table: one step per role per segment, scaled by depth. Every step runs the
# pinned Opus profile until model-tier profiles exist (SwarmCloud #1435).
ROLES: dict[str, AgentRole] = {
    r.key: r
    for r in (
        AgentRole("researcher", "Researcher", "Gathers and weighs evidence", Decimal("4.00")),
        AgentRole("analyst", "Analyst", "Turns evidence into structured claims", Decimal("3.00")),
        AgentRole("architect", "Architect", "Dependencies and high-level design", Decimal("5.00")),
        AgentRole("prioritizer", "Prioritizer", "Goal-weighted priority order", Decimal("2.50")),
        AgentRole("writer", "Writer", "Writes the PRD draft", Decimal("6.00")),
        AgentRole("critic", "Critic", "Checks traceability and citations", Decimal("3.00")),
    )
}


@dataclass(frozen=True)
class SegmentDef:
    name: str
    title: str
    roles: tuple[str, ...]
    scopes: tuple[str, ...]
    # Files the segment's last step must write.
    outputs: tuple[str, ...]
    checkpoint: str
    task: str
    # The lowest role that may decide this segment's checkpoint.
    approver_role: str = "approver"
    # Import prd.md as the document's next version when the segment succeeds.
    imports_prd: bool = False
    tools: tuple[str, ...] = ()


@dataclass(frozen=True)
class FlowDef:
    key: str
    title: str
    description: str
    segments: tuple[SegmentDef, ...]
    # True: the run needs an existing document with at least one version.
    requires_document: bool = False

    def segment(self, name: str) -> SegmentDef:
        return next(s for s in self.segments if s.name == name)

    @property
    def checkpoints(self) -> tuple[str, ...]:
        return tuple(s.checkpoint for s in self.segments)


READ = ("read:sources", "read:baseline")

FLOWS: dict[str, FlowDef] = {
    f.key: f
    for f in (
        FlowDef(
            key="baseline_to_prd",
            title="Baseline to PRD",
            description="Baseline proposal, feature set and design, priority order, PRD draft.",
            segments=(
                SegmentDef(
                    name="baseline",
                    title="Baseline proposal",
                    roles=("researcher", "analyst"),
                    scopes=(*READ, "write:proposals"),
                    outputs=("baseline.yaml", "summary.md"),
                    checkpoint="baseline_confirm",
                    task="Propose the baseline: company goals in measurable form (metric, "
                    "target, horizon, owner), products and their features, each with "
                    "evidence. Propose changes through propose_change; write the whole "
                    "proposal to baseline.yaml and a one-page summary to summary.md.",
                    tools=("search_sources", "get_source_item", "get_baseline", "propose_change"),
                ),
                SegmentDef(
                    name="feature_set",
                    title="Feature set, dependencies and design",
                    roles=("analyst", "architect"),
                    scopes=(*READ, "write:proposals"),
                    outputs=("feature_set.yaml", "design.md"),
                    checkpoint="feature_set",
                    task="From the confirmed baseline, propose the feature set for the next "
                    "version: each feature traces to a confirmed goal or is flagged as "
                    "serving none; list depends_on and blocks edges. Write the set to "
                    "feature_set.yaml and a high-level design to design.md.",
                    tools=(
                        "get_baseline",
                        "get_traceability",
                        "search_sources",
                        "get_source_item",
                        "propose_change",
                    ),
                ),
                SegmentDef(
                    name="priority",
                    title="Priority order",
                    roles=("prioritizer",),
                    scopes=("read:baseline", "write:proposals"),
                    outputs=("priority.yaml",),
                    checkpoint="priority_order",
                    task="Order the approved feature set by goal-weighted priority, respecting "
                    "dependencies. Explain every number. Write the order to priority.yaml.",
                    tools=("get_baseline", "get_traceability", "propose_change"),
                ),
                SegmentDef(
                    name="prd_draft",
                    title="PRD draft",
                    roles=("writer", "critic"),
                    scopes=(*READ, "read:documents", "write:drafts"),
                    outputs=("prd.md",),
                    checkpoint="prd_review",
                    imports_prd=True,
                    task="Write the PRD draft for the approved, ordered feature set as prd.md: "
                    "markdown with YAML front matter (title, template, citations) and a "
                    "{#id} on every heading. Every claim cites; no evidence in the body, a "
                    "final Sources and data points section.",
                    tools=(
                        "get_baseline",
                        "get_document",
                        "search_sources",
                        "get_source_item",
                        "submit_draft",
                    ),
                ),
            ),
        ),
        FlowDef(
            key="feedback_loop",
            title="Feedback loop",
            description="Pull open feedback on the PRD, write the next draft, review it.",
            requires_document=True,
            segments=(
                SegmentDef(
                    name="next_draft",
                    title="Next draft",
                    roles=("analyst", "writer"),
                    scopes=(*READ, "read:documents", "write:drafts"),
                    outputs=("prd.md",),
                    checkpoint="prd_review",
                    imports_prd=True,
                    task="Address every open feedback item listed below in the next draft of "
                    "the PRD. Do not change locked sections unless an item asks for it. "
                    "Write the draft as prd.md with a resolutions list in its front matter "
                    "(feedback_id, status addressed | declined, note) for every item.",
                    tools=(
                        "get_document",
                        "get_feedback_package",
                        "get_baseline",
                        "search_sources",
                        "get_source_item",
                        "submit_draft",
                    ),
                ),
            ),
        ),
    )
}


class KnobError(ValueError):
    pass


@dataclass(frozen=True)
class Knobs:
    depth: str = "standard"
    # Segment name -> roles, in step order. Missing segments use the flow's defaults.
    roles: dict[str, list[str]] = field(default_factory=dict)
    # Checkpoint kind -> on. Missing kinds are on.
    checkpoints: dict[str, bool] = field(default_factory=dict)
    budget_usd: Decimal | None = None

    def as_json(self) -> dict[str, Any]:
        return {
            "depth": self.depth,
            "roles": self.roles,
            "checkpoints": self.checkpoints,
            "budget_usd": None if self.budget_usd is None else str(self.budget_usd),
        }


def resolve_knobs(flow: FlowDef, raw: dict[str, Any]) -> Knobs:
    """Validated knobs with every segment's roles and every checkpoint filled in."""
    depth = raw.get("depth") or "standard"
    if depth not in DEPTHS:
        raise KnobError(f"unknown depth {depth!r}; expected one of {', '.join(DEPTHS)}")
    names = {s.name for s in flow.segments}
    roles_in = raw.get("roles") or {}
    for name, roles in roles_in.items():
        if name not in names:
            raise KnobError(f"flow {flow.key} has no segment {name!r}")
        if not roles:
            raise KnobError(f"segment {name!r} needs at least one agent role")
        unknown = [r for r in roles if r not in ROLES]
        if unknown:
            raise KnobError(f"unknown agent roles: {', '.join(unknown)}")
        if len(set(roles)) != len(roles):
            raise KnobError(f"segment {name!r} lists an agent role twice")
    checkpoints_in = raw.get("checkpoints") or {}
    for kind in checkpoints_in:
        if kind not in flow.checkpoints:
            raise KnobError(f"flow {flow.key} has no checkpoint {kind!r}")
    budget = raw.get("budget_usd")
    if budget is not None:
        budget = Decimal(str(budget))
        if budget <= 0:
            raise KnobError("budget_usd must be positive")
    return Knobs(
        depth=depth,
        roles={s.name: list(roles_in.get(s.name) or s.roles) for s in flow.segments},
        checkpoints={k: bool(checkpoints_in.get(k, True)) for k in flow.checkpoints},
        budget_usd=budget,
    )


def segment_estimate(segment: SegmentDef, knobs: Knobs) -> Decimal:
    roles = knobs.roles.get(segment.name) or list(segment.roles)
    base = sum((ROLES[r].base_usd for r in roles), Decimal(0))
    return (base * DEPTHS[knobs.depth]).quantize(Decimal("0.01"))


@dataclass(frozen=True)
class PromptContext:
    run_id: str
    document: str | None
    snapshot_as_of: str | None
    low_confidence: float
    depth: str = "standard"
    # Earlier segments' outputs, re-sent because a workflow cannot wait for a person.
    prior_outputs: dict[str, str] = field(default_factory=dict)
    # Notes from checkpoint approvals and requested changes.
    reviewer_notes: list[str] = field(default_factory=list)
    # Open feedback for the feedback loop: id, section, summary.
    feedback: list[dict[str, Any]] = field(default_factory=list)
    locked_sections: list[str] = field(default_factory=list)
    attempt: int = 1
    change_request: str | None = None
    # False until the runtime can attach Oracle's MCP server (SwarmCloud #1433).
    mcp_reachable: bool = True


MAX_PRIOR_CHARS = 20_000


def step_prompt(
    flow: FlowDef, segment: SegmentDef, role: str, *, last: bool, ctx: PromptContext
) -> str:
    """The prompt of one agent step."""
    r = ROLES[role]
    lines = [
        f"You are the {r.title.lower()} ({r.description.lower()}) in Product Oracle's "
        f"{flow.title} flow, segment '{segment.title}'.",
        f"Run {ctx.run_id}"
        + (f", PRD document '{ctx.document}'" if ctx.document else "")
        + (f", sources pinned at {ctx.snapshot_as_of}" if ctx.snapshot_as_of else "")
        + ".",
        "",
        "Task: " + segment.task,
        DEPTH_GUIDANCE[ctx.depth],
        "",
    ]
    if ctx.mcp_reachable:
        lines.append(
            "Read Oracle's knowledge through its MCP server (/mcp) with the run token you were "
            "given. Tools for this segment:"
        )
    else:
        lines.append(
            "Oracle's MCP server (/mcp) is not reachable from this runtime yet; work from this "
            "prompt and say which claims you could not check. Tools it will offer:"
        )
    lines += [f"- {t}: {MCP_TOOLS[t]}" for t in segment.tools]
    lines += [
        "",
        "Evidence: every source item and piece of evidence carries a confidence score "
        "(0-1). Weigh evidence by its confidence, prefer the higher-confidence source when "
        "two disagree, and flag every claim whose best evidence is below "
        f"{ctx.low_confidence:g} as low confidence instead of stating it as fact.",
    ]
    if last:
        lines.append("Write these files as artifacts: " + ", ".join(segment.outputs) + ".")
    else:
        lines.append(f"Write your working notes to {role}.md for the next step.")
    if ctx.change_request:
        lines += ["", f"Attempt {ctx.attempt}. The reviewer requested changes:", ctx.change_request]
    if ctx.reviewer_notes:
        lines += ["", "Reviewer notes from earlier checkpoints:"]
        lines += [f"- {n}" for n in ctx.reviewer_notes]
    if ctx.feedback:
        lines += ["", "Open feedback items:"]
        lines += [
            f"- {f['id']} [{f.get('section_key') or 'general'}]: {f['summary']}"
            for f in ctx.feedback
        ]
    if ctx.locked_sections:
        lines += ["", "Locked (approved) sections: " + ", ".join(ctx.locked_sections)]
    if ctx.prior_outputs:
        lines += ["", "Outputs of earlier segments:"]
        budget = MAX_PRIOR_CHARS
        for name, content in ctx.prior_outputs.items():
            part = content[:budget]
            budget -= len(part)
            lines += [f"--- {name} ---", part]
            if budget <= 0:
                lines.append("(truncated)")
                break
    return "\n".join(lines)


def build_steps(
    flow: FlowDef, segment: SegmentDef, knobs: Knobs, ctx: PromptContext
) -> list[tuple[str, str, str, tuple[str, ...], dict[str, str]]]:
    """(key, role, prompt, depends_on, input_from) per step, chained in role order."""
    roles = knobs.roles.get(segment.name) or list(segment.roles)
    steps: list[tuple[str, str, str, tuple[str, ...], dict[str, str]]] = []
    for i, role in enumerate(roles):
        key = f"{segment.name}-{i + 1}-{role}"
        prev = steps[-1] if steps else None
        steps.append(
            (
                key,
                role,
                step_prompt(flow, segment, role, last=i == len(roles) - 1, ctx=ctx),
                (prev[0],) if prev else (),
                {prev[0]: f"{prev[1]}.md"} if prev else {},
            )
        )
    return steps
