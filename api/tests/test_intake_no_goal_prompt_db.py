"""qa-onboarding-22 (review): a company whose only goals are proposed has no confirmed goal,
so the goal question asks for the outcome, never "which confirmed goal"."""

from oracle.intake import categories as cats
from tests.baseline_helpers import entity
from tests.intake_helpers import all_questions, company, create_intake


async def test_proposed_goal_only_asks_the_no_goal_question(client):
    ctx = await company()
    await entity(
        client, ctx, type="goal", key="repeat-purchases", title="Grow repeat purchases",
    )  # fmt: skip
    out = await create_intake(
        client, ctx,
        brief="Add saved addresses so returning buyers make more repeat purchases.",
    )  # fmt: skip
    questions = await all_questions(client, ctx, out["intake"]["id"])
    [goal_q] = [q for q in questions if q["category"] == "goal_alignment"]
    assert goal_q["prompt"] == cats.NO_GOAL_PROMPT
    assert "which confirmed" not in goal_q["prompt"].lower()
