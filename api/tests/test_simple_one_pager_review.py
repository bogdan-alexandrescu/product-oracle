"""Simple polish, from the review of CLD's production walk (#723, 2026-10-27). Pure rules.

Test cards (protects / fails_when / no_claim):

- test_short_separator_rows_hide_the_header: protects=a GFM table whose separator row has
  fewer than three dashes per cell (|--|--|, |-|-|, |:-|-:|) reads as a table: its header
  and separator rows are never lines; fails_when=the header or a "--: --" line comes back;
  no_claim=tables without a separator row.
- test_prose_with_pipes_keeps_its_words: protects=a bullet or sentence with pipes inside it
  (not at its start or end) is kept as written; fails_when="Latency p50 | p95 | p99
  targets" becomes "Latency p50: p95"; no_claim=a row starting or ending with a pipe.
- test_plan_strip_cases: protects=the API's strip on the cases shared with the web's mirror
  (api/tests/fixtures/plan_strip_cases.json, run there by web/e2e/simple-plan-strip-rules
  .spec.ts); fails_when=the rules change on one side only; no_claim=drawing.
"""

import json
from datetime import date
from pathlib import Path
from types import SimpleNamespace

import pytest

from oracle.simple import one_pager, plan_strip

CASES = json.loads((Path(__file__).parent / "fixtures" / "plan_strip_cases.json").read_text())


def facts(md: str) -> list[str]:
    return one_pager._facts(SimpleNamespace(body_md=md, body_text=md))


@pytest.mark.parametrize("sep", ["|--|--|", "|-|-|", "|:-|-:|", "--|--", "| - | - |"])
def test_short_separator_rows_hide_the_header(sep):
    md = f"| Bet | What it does |\n{sep}\n| Spend alerts | Warns at 80% |\n| Digest | Weekly |"
    assert facts(md) == ["Spend alerts: Warns at 80%", "Digest: Weekly"]


def test_prose_with_pipes_keeps_its_words():
    assert facts("- Latency p50 | p95 | p99 targets\n- Ship it") == [
        "Latency p50 | p95 | p99 targets",
        "Ship it",
    ]
    assert facts("We track p50 | p95 | p99 latency. Then we ship.") == [
        "We track p50 | p95 | p99 latency.",
        "Then we ship.",
    ]
    # A row's pipes at its start or end still go.
    assert facts("- | Safety | 0.320 |") == ["Safety: 0.320"]


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_plan_strip_cases(case):
    items = [
        plan_strip.PlanItem(
            date.fromisoformat(i["start"]),
            date.fromisoformat(i["end"]),
            i["estimated"],
            i["milestone"],
            date.fromisoformat(i["milestoneDate"]) if i["milestoneDate"] else None,
        )
        for i in case["items"]
    ]
    got = plan_strip.strip(items, date.fromisoformat(case["today"]))
    assert (got.model_dump(mode="json") if got else None) == case["expected"]
