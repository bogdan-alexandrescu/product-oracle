"""qa-onboarding-22: the goal question never asks "which confirmed goal" with none."""

import uuid
from types import SimpleNamespace

from oracle.intake import categories as cats
from oracle.intake.sharing import question_prompt


def _gap(entity_ids: list[uuid.UUID]) -> SimpleNamespace:
    return SimpleNamespace(
        category="goal_alignment",
        rule_key="goal_alignment",
        statement=cats.BY_KEY["goal_alignment"].statement,
        entity_ids=entity_ids,
    )


def test_no_goal_asks_for_the_outcome() -> None:
    prompt = question_prompt(_gap([]))
    assert prompt == cats.NO_GOAL_PROMPT
    assert "which confirmed" not in prompt.lower()


def test_with_goals_asks_which_goal() -> None:
    assert question_prompt(_gap([uuid.uuid4()])) == cats.BY_KEY["goal_alignment"].prompt


def test_the_company_s_goals_decide_over_the_gap_s_links() -> None:
    assert question_prompt(_gap([uuid.uuid4()]), has_goal=False) == cats.NO_GOAL_PROMPT
    assert question_prompt(_gap([]), has_goal=True) == cats.BY_KEY["goal_alignment"].prompt
