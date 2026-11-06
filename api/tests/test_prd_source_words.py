"""PRD source words: a published PRD lists its sources by their titles, names an issue by
what it is, and writes every code with its name, and Oracle's own PRD warnings name goals
and features the same way.

The writer's prompt and the PRD template say so; a run's PRD draft whose Sources section
carries a citation key, a file path or name, a bracket tag or a code without its name, or
whose body names an issue by its number, is imported with a warning that names the line,
and the run sends it back to the writer before a person reviews it.
"""

import uuid
from pathlib import Path
from types import SimpleNamespace

from oracle import wording
from oracle.baseline.schemas import TraceFeature, TraceGoalLink
from oracle.docs import draft_checks, named_codes, source_words
from oracle.docs.parser import parse_draft
from oracle.quality import criteria
from oracle.quality.inputs import QualityInputs
from oracle.runs import feature_set, flows, service, workflow
from tests.review_v2_helpers import DRAFT, replace

TEMPLATE = Path(flows.__file__).parents[1] / "templates/builtin/prd/oracle-default.md"


def _prompt(flow_key: str, segment: str, role: str) -> str:
    flow = flows.FLOWS[flow_key]
    ctx = flows.PromptContext(
        run_id="run-1", document="team-calendar", snapshot_as_of=None, low_confidence=0.4
    )
    return flows.step_prompt(flow, flow.segment(segment), role, last=True, ctx=ctx)


def _sources(*lines: str) -> str:
    return replace(DRAFT, "- Calendar survey, as of September.\n", "\n".join(lines) + "\n")


def _line_of(md: str, text: str) -> int:
    return next(i for i, line in enumerate(md.splitlines(), start=1) if text in line)


# --- The writer's instructions --------------------------------------------------------


def test_the_prd_writer_is_told_to_list_sources_by_title_and_name_issues_and_codes():
    for role in flows.FLOWS["baseline_to_prd"].segment("prd_draft").roles:
        text = _prompt("baseline_to_prd", "prd_draft", role)
        assert flows.PRD_SOURCE_WORDS in text
    words = flows.PRD_SOURCE_WORDS
    assert "by its title in plain words" in words
    for never in ("citation key", "file path", "file name", "tag"):
        assert never in words, never
    assert "issue by what it is" in words
    assert "with its name at its first use" in words and "tables" in words


def test_the_prd_template_shapes_sources_by_title_not_by_id():
    text = TEMPLATE.read_text()
    sources = text[text.index("## Sources and data points {#sources}") :]
    assert "citation id" not in sources and "source id" not in sources
    assert 'e.g. "problem: c2, c5"' not in sources
    assert "by its title in plain words" in sources
    assert "file path" in sources


# --- The draft check ------------------------------------------------------------------


def test_clean_sources_raise_nothing():
    md = _sources(
        "- Calendar survey (web, as of Sep 30)",
        "- Alerting design notes (GitHub, Oct 2)",
        "- Activation (G-A1): 40% of teams plan together weekly",
    )
    assert source_words.check(parse_draft(md).sections) == []


def test_a_citation_key_a_file_path_and_a_tag_in_sources_are_flagged_with_their_line():
    md = _sources(
        "- c7, github: example-org/web docs/alerting.md",
        "- c45: upload, pricing-notes.md",
        "- [BE] Billing export plan",
        "- Calendar survey (web, as of Sep 30)",
    )
    [warning] = source_words.check(parse_draft(md).sections)
    assert warning.code == "source_not_named"
    assert warning.section_keys == ["sources"]
    message = warning.message
    first, second, third = (
        _line_of(md, "c7, github"),
        _line_of(md, "c45: upload"),
        _line_of(md, "[BE]"),
    )
    assert f"line {first}" in message and f"line {second}" in message
    assert f"line {third}" in message
    assert "citation key" in message and "file path" in message and "tag" in message
    assert f"line {_line_of(md, 'Calendar survey (web')}" not in message
    # The message never repeats the raw tokens a person must not read.
    for raw in ("c7", "c45", "alerting.md", "pricing-notes.md", "[BE]"):
        assert raw not in message, raw
    assert "title in plain words" in message


def test_a_code_without_its_name_in_sources_or_a_data_points_table_is_flagged():
    md = _sources(
        "### Data points {#sources-data}",
        "",
        "| Value | Measures | Goal |",
        "|---|---|---|",
        "| 40% | Weekly planners | G-A1 |",
        "",
        "- KR 1.1 rose to 40% by Oct 31",
        "- F-25b ships after the beta",
    )
    warnings = source_words.check(parse_draft(md).sections)
    [warning] = warnings
    assert warning.code == "source_not_named"
    for code, text in (("G-A1", "| 40% |"), ("KR 1.1", "KR 1.1 rose"), ("F-25b", "F-25b ships")):
        assert f"line {_line_of(md, text)} ({code} without its name)" in warning.message, code


def test_an_issue_named_by_its_number_in_the_body_is_flagged_with_its_line():
    md = replace(DRAFT, "Teams miss shared deadlines.", "Teams miss shared deadlines (be#1357).")
    [warning] = source_words.check(parse_draft(md).sections)
    assert warning.code == "issue_number"
    assert warning.section_keys == ["problem"]
    assert f"Problem, line {_line_of(md, 'be#1357')}" in warning.message
    assert "be#1357" not in warning.message
    assert "by what it is" in warning.message


def test_letter_suffixed_and_key_result_codes_need_names_in_the_body():
    assert named_codes.findings("F-25b ships first.").unnamed == ["F-25b"]
    assert named_codes.findings("KR 1.1 moves.").unnamed == ["KR 1.1"]
    assert named_codes.findings("KR 1.1 Weekly planners moves.").unnamed == []
    assert named_codes.findings("the bulk import slice (F-25b) ships.").unnamed == []


def test_a_prd_draft_runs_the_source_check_and_sends_it_back():
    md = _sources("- c7, github: example-org/web docs/alerting.md")
    codes = [w.code for w in draft_checks.run_warnings("prd", parse_draft(md).sections)]
    assert "source_not_named" in codes
    assert set(source_words.CODES) <= set(draft_checks.SENT_BACK)
    lead = workflow.code_name_trouble(["source_not_named", "issue_number"])
    assert "lists sources by key, path or tag" in lead
    assert "names an issue by its number" in lead


# --- Oracle's own PRD warnings --------------------------------------------------------


def test_named_puts_the_name_first_and_the_code_beside_it():
    assert wording.named("Grow activation", "G-C") == "Grow activation (G-C)"
    assert wording.named("", "G-C") == "G-C"
    assert wording.named("G-C", "G-C") == "G-C"


def test_the_goal_trace_note_names_the_goal_with_its_code_beside_it():
    run = SimpleNamespace(knobs={"target_goals": [{"key": "G-C", "title": "Grow activation"}]})
    art: dict = {"notes": []}
    imported: dict = {}
    service._check_goal_trace(run, art, imported, "# T {#title}\n\n## Goal trace {#goal-trace}\n")
    assert art["notes"] == ["The PRD's Goal trace leaves out target goal: Grow activation (G-C)"]


def test_the_feature_set_names_an_unserved_target_goal_with_its_code_beside_it():
    known = feature_set.Known(targets={"G-C": "Grow activation"})
    check = feature_set.check_feature_set("version: 1\nfeatures: []\n", document=None, known=known)
    messages = [p["message"] for p in check.as_json()["problems"]]
    assert "no included feature serves the target goal Grow activation (G-C)" in messages


def _quality(served: bool) -> QualityInputs:
    fid, gid = uuid.uuid4(), uuid.uuid4()
    feature = SimpleNamespace(id=fid, type="feature", key="F-12", title="Bulk import")
    goal = TraceGoalLink(goal_id=gid, key="G-C", title="Grow activation", contribution=2)
    row = TraceFeature(
        id=fid,
        key="F-12",
        title="Bulk import",
        status="confirmed",
        evidence_count=1,
        goals=[goal] if served else [],
        flags=[] if served else ["serves_no_goal"],
    )
    return QualityInputs(
        document=None,
        version=None,
        entities={fid: feature},
        trace=SimpleNamespace(features=[row]),
    )


def test_the_goal_alignment_check_names_features_and_goals_with_their_codes():
    reasons = criteria.goal_alignment(_quality(served=False)).rationale
    assert "Bulk import (F-12) serves no confirmed goal" in reasons
    reasons = criteria.goal_alignment(_quality(served=True)).rationale
    assert "serves a confirmed goal: Grow activation (G-C)" in reasons
