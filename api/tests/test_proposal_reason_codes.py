"""codes-and-chips: a proposal's reason never shows a code without its name.

Every prompt that writes a proposal's reason (a run step that may propose, and the
propose_change tool an agent writes it with) says to name each code the reason cites, each
time, and to give a source document's own requirement numbers with the document's title.
"""

from oracle.mcp import curated
from oracle.runs import flows

RULE = "F-08 Example feature, never F-08"
SOURCE = "with the title of the document they come from"


def _prompt(flow: flows.FlowDef, seg: flows.SegmentDef, role: str) -> str:
    ctx = flows.PromptContext(
        run_id="run-1", document="team-calendar", snapshot_as_of=None, low_confidence=0.4
    )
    return flows.step_prompt(flow, seg, role, last=True, ctx=ctx)


def test_every_step_that_proposes_says_to_name_each_code_in_a_reason():
    proposing = [
        (flow, seg)
        for flow in flows.FLOWS.values()
        for seg in flow.segments
        if "write:proposals" in seg.scopes
    ]
    assert proposing
    for flow, seg in proposing:
        for role in seg.roles:
            text = _prompt(flow, seg, role)
            assert flows.PROPOSAL_REASON_CODES in text, (flow.key, seg.name, role)
    assert RULE in flows.PROPOSAL_REASON_CODES
    assert SOURCE in flows.PROPOSAL_REASON_CODES


def test_a_step_that_cannot_propose_does_not_carry_the_reason_rule():
    flow = flows.FLOWS["prd_to_roadmap"]
    ctx = flows.PromptContext(
        run_id="run-1",
        document="team-calendar-roadmap",
        snapshot_as_of=None,
        low_confidence=0.4,
        kind="roadmap",
    )
    for seg in flow.segments:
        for role in seg.roles:
            text = flows.step_prompt(flow, seg, role, last=True, ctx=ctx)
            assert flows.PROPOSAL_REASON_CODES not in text, (seg.name, role)


def test_the_propose_change_tool_says_to_name_each_code_in_its_reason():
    tool = next(c for c in curated.CURATED if c.name == "propose_change")
    assert flows.PROPOSAL_REASON_CODES in tool.about
