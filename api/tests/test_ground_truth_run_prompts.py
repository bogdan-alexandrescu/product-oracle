"""Owner's decision (Nov 4): Oracle's cited graph is the Ground Truth in every word a person
sees, text Oracle writes included. A run's agents write what people read (a discussion's
research answer is posted as Oracle's reply), so every run task prompt and every tool
description they read calls the graph the Ground Truth and tells them to. Only the tool
names (get_baseline), the file and scope names (baseline.yaml, read:baseline) and the
starting-value sense ("a goal's baseline") may still say baseline.
"""

import re

from oracle.mcp.curated import CURATED
from oracle.runs import flows, workflow

BASELINE = re.compile(r"baseline", re.I)

# What may still say baseline: names an agent types, and the starting-value sense.
ALLOWED = (
    *(rf"\b{name}\b" for name in flows.MCP_TOOLS),
    r"\bcreate_baseline_proposal\b",
    r"baseline\.yaml",
    r"read:baseline",
    r"`oracle baseline pull`",
    r'never "baseline"',
    r'"baseline decision <key>"',
    r"(?:goal|key result|metric|measure)'s (?:starting value|baseline)",
)
ALLOW = re.compile("|".join(ALLOWED))


def _left(text: str) -> list[str]:
    """The lines of ``text`` that still say baseline once the allowed names are out."""
    return [line for line in text.splitlines() if BASELINE.search(ALLOW.sub("", line))]


def _contexts(flow: flows.FlowDef) -> list[flows.PromptContext]:
    kinds = (flow.target_kind,) if flow.target_kind else tuple(flows.KIND_NAMES)
    source = flows.SourceContext(slug="example-prd", title="Example", version=1, markdown="# A")
    return [
        flows.PromptContext(
            run_id="run-1",
            document="example-prd",
            snapshot_as_of=None,
            low_confidence=0.5,
            kind=kind,
            baseline_reused="Oct 12",
            source=source if flow.source_prompt else None,
        )
        for kind in kinds
    ]


def test_every_run_task_prompt_says_ground_truth():
    left: dict[str, list[str]] = {}
    for flow in flows.FLOWS.values():
        for ctx in _contexts(flow):
            for seg in flow.segments:
                for i, role in enumerate(seg.roles):
                    prompt = flows.step_prompt(
                        flow, seg, role, last=i == len(seg.roles) - 1, ctx=ctx
                    )
                    if lines := _left(prompt):
                        left[f"{flow.key}/{seg.name}/{role}/{ctx.kind}"] = lines
    assert not left, left


def test_every_run_task_tells_its_agents_to_say_ground_truth():
    for flow in flows.FLOWS.values():
        for seg in flow.segments:
            line = flows.GROUND_TRUTH_LINE
            assert line in seg.task_for(flow.target_kind or "prd"), (flow.key, seg.name)
    assert "Ground Truth" in line and "never" in line


def test_every_tool_description_says_ground_truth():
    for name, about in flows.MCP_TOOLS.items():
        assert not _left(about), (name, about)
    for tool in CURATED:
        assert not _left(tool.about), (tool.name, tool.about)
    assert "the Ground Truth graph" in flows.MCP_TOOLS["get_baseline"]
    assert "Ground Truth" in flows.MCP_TOOLS["propose_change"]


def test_the_run_note_with_mcp_names_the_ground_truth():
    """The note a run page shows while caller MCP is on."""
    assert not BASELINE.search(workflow.SEGMENT_MODE_WITH_MCP), workflow.SEGMENT_MODE_WITH_MCP
    assert "Ground Truth" in workflow.SEGMENT_MODE_WITH_MCP


def test_a_discussion_research_answer_names_the_ground_truth():
    """Its answer.md is posted as Oracle's reply: fails_when=its task says "the baseline"."""
    seg = flows.FLOWS["discussion_research"].segment("research")
    task = seg.task_for("prd")
    assert not _left(task), task
    assert "Ground Truth and document tools" in task
    assert "documents and Ground Truth do not settle" in task


def test_the_allow_list_still_catches_the_graph():
    assert _left("Read the baseline with get_baseline.") == ["Read the baseline with get_baseline."]
    assert not _left("Write baseline.yaml; a goal's baseline is 12%.")
