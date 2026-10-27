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
- test_items_carry_their_linked_milestone_record: protects=an item a track milestone names
  carries that record (id and name) on the roadmap read and into the one-pager's strip,
  with or without milestone text of its own; fails_when=the record is dropped, so items
  whose texts differ split into rows or a linked item falls into "No milestone";
  no_claim=which record wins when two name the item (the first, as before).
- test_legacy_shortened_line_shows_its_own_fact: protects="Show all" of a line an older
  build stored shortened (no whole text kept) is that line's own source fact, not all its
  sections' facts joined; fails_when=the expanded line reads every bullet of the section;
  no_claim=a line whose fact has changed since (no whole text then).
- test_legacy_long_whole_line_keeps_its_last_word: protects=an older build's stored line of
  LINE_MAX characters or more that is its source fact whole reads whole; fails_when=its last
  word is dropped for "…"; no_claim=a long line with no source fact (still read as cut).
"""

import json
import uuid
from datetime import date
from pathlib import Path
from types import SimpleNamespace

import pytest

from oracle.simple import one_pager, plan_strip, service

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
            (i.get("record") or {}).get("id"),
            (i.get("record") or {}).get("name"),
        )
        for i in case["items"]
    ]
    got = plan_strip.strip(items, date.fromisoformat(case["today"]))
    assert (got.model_dump(mode="json") if got else None) == case["expected"]


# CLD's production walk (2026-10-27): a skeleton PRD and a long problem line.
SKELETON = """<!-- Brief: fits one slide; say who has the problem and what it costs them. -->
- <Milestone>: <Feature>
- <Risk>: <mitigation>
- →

| Milestone | Feature |
|---|---|
| <M1> | <Feature> |
"""


def sec(key: str, md: str) -> SimpleNamespace:
    return SimpleNamespace(section_key=key, body_md=md, body_text=md)


def test_template_guidance_is_never_a_line():
    """Card skeleton-quick-read: protects = an empty skeleton's HTML comments, placeholder-only
    lines and bare arrows never become one-pager lines (each block is empty, so the page reads
    "Not written yet"); fails_when = "<!-- Brief ... -->", "<Milestone>: <Feature>" or "→"
    shows as a line; no_claim = how a block is drawn (the web spec)."""
    assert facts(SKELETON) == []
    assert facts("<!-- Say who has it -->\n→\n<Problem>") == []
    # Real words next to the guidance stay; "<" in prose is not a placeholder.
    assert facts("<!-- guidance -->\n- Admins stall in setup\n- p95 < 200 ms") == [
        "Admins stall in setup",
        "p95 < 200 ms",
    ]
    mapped = {s.key: [sec(s.key, SKELETON)] for s in one_pager.FALLBACK}
    assert all(b["lines"] == [] for b in one_pager.extract(one_pager.FALLBACK, mapped))


def test_job_answer_drops_template_guidance():
    """Card skeleton-job: protects = the one_pager job's answer loses its comments and
    placeholder-only lines too (a skeleton's page stays empty, not the model's echo of the
    template); fails_when = the job's "<Risk>: <mitigation>" line is kept; no_claim = the
    model's wording."""
    mapped = {s.key: [sec(s.key, SKELETON)] for s in one_pager.FALLBACK}
    answer = {
        "blocks": [
            {"key": s.key, "lines": [{"text": t, "source_keys": [s.key]} for t in bad]}
            for s in one_pager.FALLBACK
            for bad in [["<!-- Brief: fits one slide -->", "<Risk>: <mitigation>", "→"]]
        ]
    }
    got = one_pager.clean_answer(answer, one_pager.FALLBACK, mapped)
    assert got is not None and all(b["lines"] == [] for b in got)


LONG = (
    "Support leads answer the same billing question by hand every week because the invoice "
    "page hides the plan change, and the queue grows when a renewal lands; teams with more "
    "than twenty seats wait the longest, and the promise we make is a first answer against "
    "a 48-hour target that we miss on most Mondays after a renewal batch closes overnight"
)


def test_problem_line_is_cut_at_a_word_with_its_whole_text():
    """Card problem-line-cut: protects = a problem line longer than a line's characters is
    cut at a word boundary and ends with "…", and the line keeps its whole text for "Show
    all" (the job's answer and an older one-pager's stored line cut mid-word alike);
    fails_when = the line ends mid-word ("against a 48-ho") or has no ellipsis, or its whole
    text is lost; no_claim = the expand control (the web spec)."""
    problem = one_pager.FALLBACK[0]
    mapped = {"problem": [sec("problem", LONG)]}
    answer = {"blocks": [{"key": "problem", "lines": [{"text": LONG, "source_keys": ["problem"]}]}]}
    got = one_pager.clean_answer(answer, (problem,), mapped)
    line = got[0]["lines"][0]
    assert len(line["text"]) <= one_pager.LINE_MAX
    assert line["text"].endswith("…")
    assert LONG.startswith(line["text"][:-1])
    assert LONG[len(line["text"]) - 1] == " "  # the cut falls between words
    assert line["full"] == LONG
    # A line an older build stored cut mid-word reads to its last whole word, with "…" and
    # the source section's whole text.
    old = LONG[: one_pager.LINE_MAX]
    assert not old.endswith(" ")
    text, full = one_pager._tidy(old, 60, None, [sec("problem", LONG)])
    assert text.endswith("…") and LONG.startswith(text[:-1]) and LONG[len(text) - 1] == " "
    assert full == LONG
    # A short line is whole: nothing to expand.
    assert one_pager._tidy("Admins stall in setup.", 60, None, []) == (
        "Admins stall in setup.",
        None,
    )


def test_items_carry_their_linked_milestone_record():
    track = SimpleNamespace(id=uuid.uuid4())
    beta = SimpleNamespace(id=uuid.uuid4(), name="Beta launch", target_date=None)
    links = {(track.id, "invites"): beta, (track.id, "form"): beta}
    noted = SimpleNamespace(
        item_key="invites", milestone={"name": "Beta launch, two teams first", "date": "2026-12-10"}
    )
    bare = SimpleNamespace(item_key="form", milestone=None)
    own = service._milestone(noted, track, links)
    assert (own.source, own.name, own.record_id, own.record_name) == (
        "item",
        "Beta launch, two teams first",
        beta.id,
        "Beta launch",
    )
    linked = service._milestone(bare, track, links)
    assert (linked.name, linked.record_id, linked.record_name) == (
        "Beta launch",
        beta.id,
        "Beta launch",
    )
    # The one-pager's strip keys both by the record: one row.
    day = SimpleNamespace(date=date(2026, 11, 2))
    items = [
        SimpleNamespace(start=day, end=day, estimated=False, status="planned", milestone=m)
        for m in (own, linked)
    ]
    plan = plan_strip.strip(one_pager.plan_items(items), date(2026, 10, 27))
    assert [(r.name, r.items) for r in plan.rows] == [("Beta launch", 2)]


SETUP = (
    "- Spend alerts warn at 80% of the cap and again when the cap is reached for the team\n"
    "- Digest goes out weekly to team leads with the alerts they missed"
)


def test_legacy_shortened_line_shows_its_own_fact():
    stored = "Spend alerts warn at 80% of the…"
    text, full = one_pager._tidy(stored, 6, None, [sec("bets", SETUP)])
    assert text.endswith("…")
    assert (
        full == "Spend alerts warn at 80% of the cap and again when the cap is reached for the team"
    )


def test_legacy_long_whole_line_keeps_its_last_word():
    whole = " ".join(["word"] * 59) + " " + "x" * (one_pager.LINE_MAX - 59 * 5)
    assert len(whole) == one_pager.LINE_MAX and not whole.endswith("…")
    assert one_pager._tidy(whole, 60, None, [sec("problem", whole)]) == (whole, None)
