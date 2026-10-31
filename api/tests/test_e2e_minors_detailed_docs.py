"""Production minors (detailed docs lane): the template and theme previews word their times
month first, and a brief's side panel names the template the brief chose.

Synthetic placeholders only.
"""

import re
from datetime import UTC, datetime

from oracle import company_time
from oracle.templates.preview import render_preview
from oracle.templates.schemas import ThemeTokens
from tests.intake_helpers import company, create_intake, summary

RAW_STAMP = re.compile(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}")
MONTH_FIRST = re.compile(r"[A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [AP]M [A-Z]{3,4}")


def test_moment_in_words_is_month_first():
    at = datetime(2026, 10, 30, 20, 28, tzinfo=UTC)
    assert company_time.moment_in_words(at, "America/Los_Angeles") == "Oct 30, 1:28 PM PDT"
    assert company_time.moment_in_words(at, "UTC") == "Oct 30, 8:28 PM UTC"


def test_theme_preview_words_its_times_month_first():
    """Production minors 22: the previews showed "2026-10-30 13:28 PDT"."""
    tokens = ThemeTokens.model_validate({"features": {"status_header": True}})
    html = render_preview(tokens, "", "prd")
    assert not RAW_STAMP.search(html), RAW_STAMP.search(html)
    assert MONTH_FIRST.search(html)


async def test_brief_summary_names_the_template_the_brief_chose(client):
    """Production minors 23: the side panel named the recommendation, not the brief's pick."""
    ctx = await company()
    intake = await create_intake(client, ctx, template="one-pager")
    out = await summary(client, ctx, intake["intake"]["id"])
    assert out["template"]["key"] == "one-pager"
    assert out["template"]["name"] == "One-pager"


async def test_brief_summary_without_a_pick_names_the_recommendation(client):
    ctx = await company()
    intake = await create_intake(client, ctx)
    out = await summary(client, ctx, intake["intake"]["id"])
    assert out["template"]["name"]
    assert out["template"]["reason"] != "The template chosen for this PRD."
