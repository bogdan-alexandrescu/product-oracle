"""A rejected draft is clear on the run page (owner, 2026-10-20).

When a segment's draft import is refused at segment end, the import keeps the parser's
problems (code, message, cite_key, section_key, line) beside its error string, on the
segment (``segments[].draft_import.problems``) and in the review's payload, with one
plain summary grouped by cause (``draft_import.summary``): knock-on ``unknown_citation``
problems count against the rejected citation they depend on. The runs list carries the
same summary (``draft_rejected``), and so does the Inbox (the review's payload).
"""

import pytest

from oracle.docs.parser import DraftError, parse_draft
from oracle.docs.schemas import ImportProblem
from oracle.runs import rejection, workflow
from oracle.runs.rejection import summary
from oracle.swarm import FakeRuntime, Outcome, set_runtime
from tests.fixtures import seed_auth
from tests.test_runs import get, pending, started, tick

OFF = {
    "baseline_confirm": False,
    "feature_set": False,
    "eng_review": False,
    "priority_order": False,
}
# The live case: 24 citations of a source this Oracle does not accept, cited 102 times.
SOURCE_SUMMARY = (
    "Oracle refused prd.md: 24 citations use source 'x', which isn't accepted; "
    "102 references fail because of them."
)


def bad_source_draft(citations: int = 24, sections: int = 34, per_section: int = 3) -> str:
    """A draft whose ``citations`` all use source 'x'; each of ``sections`` sections cites
    ``per_section`` of them (``sections * per_section`` references)."""
    front = ["---", "document: example-prd", "title: Example PRD", "citations:"]
    for i in range(1, citations + 1):
        front += [f"  - id: k{i}", "    source: x", f"    ref: ref {i}"]
    body = ["---", "", "# Example PRD {#title}", ""]
    for s in range(sections):
        keys = " ".join(f"[c:k{(s * per_section + j) % citations + 1}]" for j in range(per_section))
        body += [f"## Section {s} {{#s{s}}}", "", f"Claims {keys}.", ""]
    return "\n".join(front + body)


def _problems(markdown: str):
    with pytest.raises(DraftError) as exc:
        parse_draft(markdown)
    return exc.value.problems


def test_the_summary_counts_knock_on_references_against_the_rejected_citations():
    problems = _problems(bad_source_draft())
    assert len(problems) == 126
    assert sum(p.code == "invalid_citation" for p in problems) == 24
    assert sum(p.code == "unknown_citation" for p in problems) == 102
    # The parser names the refused value.
    first = next(p for p in problems if p.code == "invalid_citation")
    assert first.message == "citation #1 (k1) is invalid: source 'x' isn't accepted"
    assert first.cite_key == "k1"
    assert summary("prd.md", problems) == SOURCE_SUMMARY


def test_the_summary_groups_every_cause_largest_first():
    markdown = "\n".join(
        [
            "---",
            "title: Mixed",
            "citations:",
            "  - {id: a1, source: x, ref: r}",
            "  - {id: a2, source: x, ref: r}",
            "  - {id: b1, source: y, ref: r}",
            "  - {id: c1, source: slack}",
            "---",
            "",
            "# Mixed {#title}",
            "",
            "## One {#one}",
            "",
            "[c:a1] [c:a2] [c:b1] [c:zz]",
            "",
            "## Two {#two}",
            "",
            "[c:a1] [c:a2]",
            "",
            "## No id",
            "",
            "Text.",
        ]
    )
    problems = _problems(markdown)
    assert summary("prd.md", problems) == (
        "Oracle refused prd.md: 2 citations use source 'x', which isn't accepted; "
        "4 references fail because of them. "
        "1 citation uses source 'y', which isn't accepted; 1 reference fails because of it. "
        "1 citation is invalid (ref). "
        "1 heading has no {#section-id}. "
        "1 reference cites a citation that isn't defined."
    )


def test_a_single_unknown_problem_reads_as_its_message():
    problems = _problems("# No front matter {#title}\n")
    assert summary("prd.md", problems) == (
        "Oracle refused prd.md: draft must start with YAML front matter between '---' lines."
    )


def _citations_draft(citations: list[str], body: str) -> str:
    return "\n".join(
        ["---", "title: T", "citations:", *citations, "---", "", "# T {#title}", "", body]
    )


def test_invalid_citations_are_grouped_per_bad_field():
    # a2 is wrong in two fields: it counts in the source group and in the confidence group,
    # not as a cause of its own.
    problems = _problems(
        _citations_draft(
            [
                "  - {id: a1, source: x, ref: 'https://example.com'}",
                "  - {id: a2, source: x, ref: 'https://example.com', confidence: 7}",
                "  - {id: a3, source: web, ref: 'https://example.com', confidence: 9}",
            ],
            "[c:a1] [c:a2] [c:a3]",
        )
    )
    assert summary("prd.md", problems) == (
        "Oracle refused prd.md: 2 citations use source 'x', which isn't accepted; "
        "2 references fail because of them. "
        "2 citations are invalid (confidence must be a number from 0 to 1); "
        "1 reference fails because of them."
    )


def test_a_second_invalid_citation_with_the_same_id_does_not_replace_the_first():
    # Both "d" are refused; the references to "d" count against the first one.
    problems = _problems(
        _citations_draft(
            [
                "  - {id: d, source: x, ref: 'https://example.com'}",
                "  - {id: d, source: web, ref: 'https://example.com', confidence: 5}",
            ],
            "[c:d] and again [c:d]",
        )
    )
    assert [p.cite_key for p in problems if p.code == "invalid_citation"] == ["d", "d"]
    assert summary("prd.md", problems) == (
        "Oracle refused prd.md: 1 citation uses source 'x', which isn't accepted; "
        "2 references fail because of it. "
        "1 citation is invalid (confidence must be a number from 0 to 1)."
    )


def test_the_findings_are_capped_and_summarise_knock_ons():
    """The agents' rendering (the send-back's findings) of the same groups as the summary:
    each group lists at most FINDINGS_LISTED messages, then how many more; knock-on
    references are one line, not one message each."""
    problems = [p.model_dump(mode="json") for p in _problems(bad_source_draft())]
    lines = rejection.findings("prd.md", problems)
    assert lines[0].startswith("Oracle could not import prd.md")
    (citations,) = [line for line in lines if line.startswith("Citations:")]
    assert citations.count(" is invalid: ") == 10
    assert "and 14 more like them" in citations
    assert "102 references fail only because they cite these invalid citations" in citations
    assert "cites a citation" not in "".join(lines)
    assert sum(len(line) for line in lines) < 4000
    # One summariser: the send-back's findings are this rendering.
    assert workflow.import_findings("prd.md", problems) == lines


def test_the_findings_say_how_many_problems_were_not_stored():
    problems = [p.model_dump(mode="json") for p in _problems(bad_source_draft())]
    lines = rejection.findings("prd.md", problems[: rejection.MAX_PROBLEMS], total=len(problems))
    assert lines[-1] == (
        f"Only the first {rejection.MAX_PROBLEMS} of 126 problems are listed; fix these and the "
        "import lists the rest."
    )


MISSING_SUMMARY = "Oracle could not import prd.md: the run's agents did not write it."


def test_a_missing_draft_reads_as_a_sentence():
    """No file reached the import: a sentence of its own, not "Oracle refused"."""
    missing = [ImportProblem(code="missing_draft", message="the segment left no prd.md")]
    assert summary("prd.md", missing) == MISSING_SUMMARY
    assert summary("roadmap.md", [ImportProblem(code="missing_draft", message="m")]) == (
        "Oracle could not import roadmap.md: the run's agents did not write it."
    )


@pytest.fixture
def runtime():
    fake = FakeRuntime()
    set_runtime(fake)
    yield fake
    set_runtime(None)


async def test_a_refused_draft_carries_its_problems_and_summary(runtime, client):
    tenant_id, auth = await seed_auth()
    runtime.script["prd_draft"] = [Outcome(artifacts={"prd.md": bad_source_draft()})]
    run = await started(client, auth, document="example-prd", checkpoints=OFF)
    for _ in range(4):
        await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "awaiting_checkpoint" and run["waiting_on"] == "prd_review"

    imp = run["segments"][4]["draft_import"]
    # The string stays, for compatibility.
    assert imp["error"].startswith("prd.md was rejected: [invalid_citation] citation #1 (k1)")
    assert imp["summary"] == SOURCE_SUMMARY
    # Stored capped (the segment, the review's payload, the runs list): the first
    # MAX_PROBLEMS and the count; the error string names how many it leaves out.
    assert len(imp["problems"]) == 50
    assert imp["problems_total"] == 126
    assert imp["error"].endswith(f"; and {126 - rejection.MAX_PROBLEMS} more")
    assert (
        imp["error"].count("[invalid_citation]") + imp["error"].count("[unknown_citation]")
        == rejection.MAX_PROBLEMS
    )
    assert imp["problems"][0] == {
        "code": "invalid_citation",
        "message": "citation #1 (k1) is invalid: source 'x' isn't accepted",
        "section_key": None,
        "cite_key": "k1",
        "line": None,
        "refs": {},
    }
    knock_on = next(p for p in imp["problems"] if p["code"] == "unknown_citation")
    assert knock_on["cite_key"] == "k1" and knock_on["section_key"] == "s0"
    assert isinstance(knock_on["line"], int)

    # The review's payload carries the same, so the Inbox and MCP read the same text.
    cp = pending(run)
    assert cp["payload"]["import"]["summary"] == SOURCE_SUMMARY
    assert len(cp["payload"]["import"]["problems"]) == rejection.MAX_PROBLEMS
    inbox = (await client.get("/v1/inbox", headers=auth)).json()
    (item,) = [c for c in inbox["checkpoints"] if c["id"] == cp["id"]]
    assert item["payload"]["import"]["summary"] == SOURCE_SUMMARY

    # The run (and the runs list) say the draft was rejected, with the summary.
    assert run["draft_rejected"] == SOURCE_SUMMARY
    listed = (await client.get("/v1/runs", headers=auth)).json()
    (row,) = [r for r in listed if r["id"] == run["id"]]
    assert row["draft_rejected"] == SOURCE_SUMMARY


async def test_an_imported_draft_has_no_problems(runtime, client):
    _, auth = await seed_auth()
    run = await started(client, auth, document="example-prd", checkpoints=OFF)
    for _ in range(4):
        await tick(client, auth)
    run = await get(client, auth, run["id"])
    imp = run["segments"][4]["draft_import"]
    assert imp["error"] is None and imp["version"] == 1
    assert imp["problems"] == [] and imp["summary"] is None
    assert run["draft_rejected"] is None


async def test_a_segment_that_left_no_draft_carries_the_same_shape(runtime, client):
    """The missing file is a problem like the parser's, with its own summary, on the
    segment, in the review's payload and on the runs list."""
    _, auth = await seed_auth()
    runtime.script["prd_draft"] = [Outcome(artifacts={"notes.md": "No draft today.\n"})]
    run = await started(client, auth, document="example-prd", checkpoints=OFF)
    for _ in range(4):
        await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "awaiting_checkpoint" and run["waiting_on"] == "prd_review"
    imp = run["segments"][4]["draft_import"]
    assert imp["error"] == "the segment left no prd.md"
    assert imp["problems"] == [
        {
            "code": "missing_draft",
            "message": "the segment left no prd.md",
            "section_key": None,
            "cite_key": None,
            "line": None,
            "refs": {},
        }
    ]
    assert imp["summary"] == MISSING_SUMMARY
    assert pending(run)["payload"]["import"]["summary"] == MISSING_SUMMARY
    assert run["draft_rejected"] == MISSING_SUMMARY
