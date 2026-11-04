"""The fake runtime's roadmap draft copies the plan tables its brief gives, so a faked
prd_to_roadmap run passes the plan tables check as a real writer's draft does."""

from oracle.swarm import fake

PROMPT = """Write roadmap.md.

--- plan tables ---
| Key | Item | Start | End | Dates from | Status |
|---|---|---|---|---|---|
| price-early | Show the price early |  | Nov 30, 2026 | estimate | planned |

| Milestone | Date | Gates | Counts when |
|---|---|---|---|
| Beta | Nov 30, 2026 | Show the price early |  |
--- end of plan tables ---
"""


def test_a_faked_roadmap_draft_carries_the_briefs_plan_tables():
    draft = fake._default_files("roadmap_draft", 1, ("roadmap.md",), PROMPT)["roadmap.md"]
    plan = draft.index("## Plan {#plan}")
    milestones = draft.index("## Milestones {#plan-milestones}")
    assert plan < milestones < draft.index("## Sources and data points {#sources}")
    assert "| price-early | Show the price early |  | Nov 30, 2026 | estimate | planned |" in draft
    assert "| Beta | Nov 30, 2026 | Show the price early |  |" in draft


def test_without_plan_tables_in_the_brief_the_draft_is_unchanged():
    draft = fake._default_files("roadmap_draft", 1, ("roadmap.md",), "Write it.")["roadmap.md"]
    assert "## Plan {#plan}" not in draft
