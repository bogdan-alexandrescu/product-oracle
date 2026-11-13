"""Dates month first in the text people read from a model: every prompt kind whose
output a person reads carries the shared DATES rule once, added by ``current()``."""

import pytest

from oracle.jobs import prompting

#: Kinds whose output people read (replies, summaries, drafts, reports, questions).
READ = [
    "discussion_reply",
    "chat_reader",
    "discussion_summary",
    "one_pager",
    "meeting_minutes",
    "review_comments",
    "refinement",
    "refinement_batch",
    "reporting",
    "item_draft",
    "interview_guide",
    "interview_turn",
    "interview_team_turn",
    "interview_snapshot",
    "why_not_reply",
    "scope_enhance",
    "decision_options",
    "goal_suggestions",
    "intake_analysis",
    "quality_review",
    "prd_plan",
    "prd_questions",
    "simple_visual",
]
#: public_text writes no date at all; discussion_reply_goal is appended to
#: discussion_reply's prompt, which already carries the rule.
WITHOUT = ["public_text", "discussion_reply_goal"]


def _dates() -> str:
    dates = getattr(prompting, "DATES", None)
    assert isinstance(dates, str) and dates, "prompting.DATES: the shared dates rule"
    return dates


def test_dates_rule_says_month_first() -> None:
    dates = _dates()
    assert "Nov 12, 2026" in dates and "Nov 12, 2026, 2:49 PM PST" in dates
    assert "time zone" in dates and "ISO" in dates and "YYYY-MM-DD" in dates


@pytest.mark.parametrize("kind", READ)
def test_read_prompts_carry_dates_once(kind: str) -> None:
    name, text = prompting.current(kind)
    # The recorded name says the rule was added, so a job's prompt stays traceable.
    assert name == f"{prompting.CURRENT[kind]}+dates.v1"
    assert text.count(_dates()) == 1


@pytest.mark.parametrize("kind", WITHOUT)
def test_dateless_prompts_do_not(kind: str) -> None:
    name, text = prompting.current(kind)
    assert name == prompting.CURRENT[kind]
    assert _dates() not in text


def test_every_kind_is_decided() -> None:
    """A new prompt kind says whether people read it."""
    assert sorted(prompting.CURRENT) == sorted(READ + WITHOUT)


def test_goal_discussion_carries_dates_once() -> None:
    """A goal discussion's prompt is discussion_reply's with discussion_reply_goal's after."""
    text = prompting.current("discussion_reply")[1] + prompting.current("discussion_reply_goal")[1]
    assert text.count(_dates()) == 1
