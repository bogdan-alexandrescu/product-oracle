import pytest

from oracle.docs.parser import DraftError, body_text, parse_draft
from tests.fixtures import FEEDBACK_GUEST, FEEDBACK_SHIPPING, draft

V1_KEYS = [
    "title",
    "goal-trace",
    "problem",
    "users",
    "solution",
    "s-5-1",
    "s-5-2",
    "metrics",
    "risks",
    "open-questions",
]


def _draft(body: str, citations: str = "") -> str:
    return f"---\ndocument: d\ntitle: T\n{citations}---\n\n{body}"


def _codes(exc: DraftError) -> list[tuple[str, str | None, str | None]]:
    return [(p.code, p.section_key, p.cite_key) for p in exc.problems]


def test_v1_sections_and_citations():
    parsed = parse_draft(draft("prd_v1.md"))
    assert parsed.document == "checkout-redesign"
    assert parsed.title == "Checkout redesign PRD"
    assert parsed.template == "oracle-default"
    assert parsed.template_version == "1"
    assert parsed.snapshot == "2026-10-16T14:00Z"
    assert [s.section_key for s in parsed.sections] == V1_KEYS
    assert [s.ordinal for s in parsed.sections] == list(range(1, len(V1_KEYS) + 1))
    assert [c.id for c in parsed.citations] == ["c1", "c2", "c3", "c4"]
    assert parsed.resolutions == []

    by_key = {s.section_key: s for s in parsed.sections}
    assert by_key["title"].level == 1
    assert by_key["goal-trace"].level == 2
    assert by_key["s-5-2"].level == 3
    assert by_key["goal-trace"].heading == "1. Goal trace"
    assert by_key["problem"].citation_keys == ["c2", "c3"]
    assert by_key["users"].citation_keys == []
    # Level-4 headings need no id and stay in the section body.
    assert "#### Edge cases" in by_key["s-5-2"].body_md
    assert "Edge cases" in by_key["s-5-2"].body_text
    # body_text is plain text: no markdown syntax, no citation markers.
    goal = by_key["goal-trace"]
    assert goal.body_md.endswith("purchase [c:c1].")
    assert goal.body_text == ("Serves G1 (activation): more first-time buyers complete a purchase.")
    # A table keeps its rows: cells joined by " | ", one row per line, no separator row.
    assert by_key["metrics"].body_text == (
        "Metric | Baseline | Target\nCheckout completion | 52% | 60%"
    )


def test_v2_resolutions():
    parsed = parse_draft(draft("prd_v2.md"))
    assert [(r.feedback_id, r.status) for r in parsed.resolutions] == [
        (FEEDBACK_SHIPPING, "addressed"),
        (FEEDBACK_GUEST, "declined"),
    ]
    assert parsed.front_matter["resolutions"][0]["note"].startswith("Shipping estimate")


def test_content_hash_ignores_line_endings_and_trailing_space():
    a = parse_draft(draft("prd_v1.md"))
    b = parse_draft(draft("prd_v1.md").replace("\n", "\r\n") + "\n\n")
    assert a.content_hash == b.content_hash
    assert [s.content_hash for s in a.sections] == [s.content_hash for s in b.sections]


def test_section_hash_changes_with_heading_level_and_body():
    base = parse_draft(_draft("## A {#a}\n\nbody\n")).sections[0].content_hash
    assert parse_draft(_draft("## A {#a}\n\nbody\n\n")).sections[0].content_hash == base
    assert parse_draft(_draft("## B {#a}\n\nbody\n")).sections[0].content_hash != base
    assert parse_draft(_draft("### A {#a}\n\nbody\n")).sections[0].content_hash != base
    assert parse_draft(_draft("## A {#a}\n\nbody!\n")).sections[0].content_hash != base


def test_every_problem_is_reported():
    text = _draft(
        "# Title {#title}\n\n"
        "## No id here\n\nSee [c:c1] and [c:ghost].\n\n"
        "## Fine {#fine}\n\nAlso [c:phantom] and [c:ghost].\n\n"
        "### Also missing\n\ntext\n\n"
        "## Again {#fine}\n\ndup\n",
        citations="citations:\n  - id: c1\n    source: web\n    ref: https://example.com\n",
    )
    with pytest.raises(DraftError) as info:
        parse_draft(text)
    problems = info.value.problems
    assert sorted(_codes(info.value)) == sorted(
        [
            ("missing_section_id", None, None),
            ("missing_section_id", None, None),
            ("duplicate_section_id", "fine", None),
            ("unknown_citation", "fine", "phantom"),
            ("unknown_citation", "fine", "ghost"),
        ]
    )
    missing = [p for p in problems if p.code == "missing_section_id"]
    # Line numbers are file lines (front matter included); the message names the heading.
    assert [p.line for p in missing] == [12, 20]
    assert "No id here" in missing[0].message
    assert "Also missing" in missing[1].message


def test_oracle_baseline_citations_parse():
    # A run's writer cites Oracle's own baseline (goals, decisions, constraints,
    # features): source 'oracle', its ref free text naming the baseline item.
    parsed = parse_draft(draft("prd_oracle_citations.md"))
    assert [(c.id, c.source) for c in parsed.citations] == [
        ("o-g1", "oracle"),
        ("o-d-ship", "oracle"),
        ("c1", "slack"),
    ]
    by_id = {c.id: c for c in parsed.citations}
    assert by_id["o-g1"].ref == "baseline goal g1 (activation), locked"
    assert by_id["o-d-ship"].ref.startswith("baseline decision show-shipping-early (D2)")
    assert by_id["o-g1"].title == "Goal G1: raise first-order completion"
    by_key = {s.section_key: s for s in parsed.sections}
    assert by_key["goal"].citation_keys == ["o-g1", "c1"]
    assert by_key["decisions"].citation_keys == ["o-d-ship"]


def test_text_under_heading_without_id_is_not_citation_checked():
    # Text under a heading without an id is not a section, so its citations are not
    # checked; once the id is added they are. The missing id itself is reported.
    text = _draft("# T {#t}\n\n## Missing\n\n[c:x]\n")
    with pytest.raises(DraftError) as info:
        parse_draft(text)
    assert _codes(info.value) == [("missing_section_id", None, None)]


def test_headings_in_code_fences_are_not_sections():
    parsed = parse_draft(_draft("# T {#t}\n\n```\n# not a heading\n```\n"))
    assert [s.section_key for s in parsed.sections] == ["t"]
    assert parsed.sections[0].body_text == "# not a heading"


def test_setext_heading_needs_id_too():
    with pytest.raises(DraftError) as info:
        parse_draft(_draft("# T {#t}\n\nSub\n---\n\ntext\n"))
    assert _codes(info.value) == [("missing_section_id", None, None)]
    parsed = parse_draft(_draft("# T {#t}\n\nSub {#sub}\n---\n\ntext\n"))
    assert [(s.section_key, s.heading, s.body_md) for s in parsed.sections][1] == (
        "sub",
        "Sub",
        "text",
    )


@pytest.mark.parametrize(
    ("text", "code"),
    [
        ("# T {#t}\n", "missing_front_matter"),
        ("---\ntitle: [unclosed\n---\n# T {#t}\n", "invalid_front_matter"),
        ("---\n- a list\n---\n# T {#t}\n", "invalid_front_matter"),
        (_draft("intro\n\n# T {#t}\n"), "content_before_heading"),
        (_draft("just text\n"), "no_sections"),
        ("---\ndocument: Bad Slug\ntitle: T\n---\n# T {#t}\n", "invalid_document"),
        (
            _draft("# T {#t}\n", "citations:\n  - id: c1\n    source: fax\n    ref: x\n"),
            "invalid_citation",
        ),
        (
            _draft(
                "# T {#t}\n",
                "citations:\n"
                "  - {id: c1, source: web, ref: x}\n"
                "  - {id: c1, source: web, ref: y}\n",
            ),
            "duplicate_citation",
        ),
        (
            _draft("# T {#t}\n", "resolutions:\n  - feedback_id: nope\n    status: addressed\n"),
            "invalid_resolution",
        ),
    ],
)
def test_front_matter_and_structure_problems(text, code):
    with pytest.raises(DraftError) as info:
        parse_draft(text)
    assert code in [p.code for p in info.value.problems]


def test_body_text_strips_markdown_and_citations():
    md = "Some **bold** and `code` [c:c1], then a [link](https://example.com).\n\n- one\n- two"
    assert body_text(md) == "Some bold and code, then a link.\none\ntwo"


def test_body_text_keeps_table_rows():
    # A literal pipe inside a cell stays escaped, so " | " always separates cells.
    md = (
        "Targets [c:c1]:\n\n"
        "| Metric | Baseline | Target |\n"
        "|:-------|---------:|:------:|\n"
        "| **Checkout** completion [c:c1] | 52% | `60%` |\n"
        "| Empty cell |  | 5 |\n"
        "| Escaped \\| pipe | 1 | 2 |\n\n"
        "After the table."
    )
    assert body_text(md) == (
        "Targets:\n"
        "Metric | Baseline | Target\n"
        "Checkout completion | 52% | 60%\n"
        "Empty cell |  | 5\n"
        "Escaped \\| pipe | 1 | 2\n"
        "After the table."
    )


def test_body_text_of_header_only_table():
    assert body_text("| A | B |\n|---|---|") == "A | B"


def test_title_falls_back_to_first_heading():
    parsed = parse_draft("---\ndocument: d\n---\n# From heading {#t}\n")
    assert parsed.title == "From heading"
