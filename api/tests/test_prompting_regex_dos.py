"""The house rules for section text must stay linear, and the text they read is capped.

``clean_body`` runs on an approver's edit (edit, accept, apply a refinement or a next
draft) and on model output, on the event loop. On main since 54e6559 an unclosed link
backtracked exponentially (2 s of CPU at 28 characters, four times more for every two
more), and a long heading line, a run of spaces and a ``{#`` flood were quadratic: one
request froze the API. ``parse_answer``'s fence pattern was quadratic on a run of spaces.

Each crafted input runs in a child process with a wall limit, so a regex that hangs
fails its own test instead of the suite.
"""

import json
import subprocess
import sys
import uuid
from pathlib import Path

import pytest

from oracle.jobs import prompting
from oracle.seed import seed

API = Path(__file__).resolve().parents[1]
CPU_LIMIT = 0.2
WALL_LIMIT = 10.0
# The spec's cap on section text (06-security-and-threat-model: 200k characters).
CAP = 200_000

_CHILD = r"""
import json, sys, time
from oracle.jobs import prompting

case = json.loads(sys.stdin.read())
text = case["head"] + case["piece"] * case["times"] + case["tail"]
run = {
    "clean_body": lambda: prompting.clean_body(text, "Proposed solution"),
    "body_problems": lambda: prompting.body_problems(text),
    "heading_id": lambda: prompting._HEADING_ID.subn("", text),
    "parse_answer": lambda: prompting.parse_answer(text),
}[case["target"]]
start = time.process_time()
try:
    run()
except prompting.AnswerError:
    pass
print(time.process_time() - start)
"""

# name: (target, head, piece, times, tail)
CRAFTED = {
    "unclosed link, 60 characters": ("clean_body", "[a](", "b", 56, ""),
    "unclosed link, 60 characters, problems": ("body_problems", "[a](", "b", 56, ""),
    "heading line, 20,000 characters": ("clean_body", "# a", " ", 20_000, "b"),
    "heading id flood, 1 MB": ("heading_id", "", "{#", 500_000, ""),
    "heading id flood, at the cap": ("clean_body", "", "{#", CAP // 2, ""),
    "run of spaces": ("clean_body", "a", " ", CAP, "b"),
    "run of blank lines": ("clean_body", "a", "\n", CAP, "b"),
    "open brackets": ("clean_body", "", "[", CAP, "]"),
    "open images": ("clean_body", "", "![", CAP // 2, ""),
    "open image targets": ("clean_body", "", "![a](", CAP // 5, ""),
    "open link parentheses": ("clean_body", "", "[x](a(", CAP // 6, ""),
    "open link titles": ("clean_body", "", '[a](b "', CAP // 7, ""),
    "open citations": ("clean_body", "", "[c:", CAP // 3, ""),
    "fence and spaces": ("parse_answer", "```", " ", CAP // 2, ""),
}


def _cpu(target: str, head: str, piece: str, times: int, tail: str) -> float:
    case = {"target": target, "head": head, "piece": piece, "times": times, "tail": tail}
    try:
        done = subprocess.run(
            [sys.executable, "-c", _CHILD],
            input=json.dumps(case),
            capture_output=True,
            text=True,
            timeout=WALL_LIMIT,
            cwd=API,
        )
    except subprocess.TimeoutExpired:
        done = None
    if done is None:
        pytest.fail(f"{target} did not finish within {WALL_LIMIT:g} s", pytrace=False)
    assert done.returncode == 0, done.stderr[-2000:]
    return float(done.stdout)


@pytest.mark.parametrize("name", sorted(CRAFTED))
def test_crafted_text_is_cleaned_in_linear_time(name):
    took = _cpu(*CRAFTED[name])
    assert took < CPU_LIMIT, f"{name} took {took:.2f}s of CPU"


# Main's output on real-world text, from the existing tests and common Markdown: the
# fix keeps every one of them exactly.
NORMAL = [
    (
        "## Solution {#solution}\nA checklist [c:c1] (see https://example.com/x).\n"
        "### Detail {#detail}\n![chart](https://example.com/c.png) [study](https://e.x/s)\n"
        "60% of teams finish it.",
        None,
        "A checklist (see).\n#### Detail\nchart study\n60% of teams finish it.",
        ["headings", "citation_markers", "links", "urls"],
    ),
    (
        "## Checklist\n\nA guided checklist [c:c1] that teams can skip; "
        "see [the study](https://example.com/study). 45% of teams finish it.\n",
        "Proposed solution",
        "#### Checklist\n\nA guided checklist that teams can skip; see the study. "
        "45% of teams finish it.",
        ["citation_markers", "links", "headings"],
    ),
    (
        "A guided checklist [c:c1] that new teams can [skip](https://x.example).",
        None,
        "A guided checklist that new teams can skip.",
        ["citation_markers", "links"],
    ),
    (
        "Half of new teams never invite a teammate [c:c1], so they churn.",
        None,
        "Half of new teams never invite a teammate, so they churn.",
        ["citation_markers"],
    ),
    (
        'See [the guide](https://e.x/guide "The guide") first.',
        None,
        "See the guide first.",
        ["links"],
    ),
    ("Read [Foo](https://en.wikipedia.org/wiki/Foo_(bar)) now.", None, "Read Foo now.", ["links"]),
    ("Jump to [goals](#goals).", None, "Jump to goals.", ["links"]),
    ("![diagram](https://e.x/a_(b).png) below", None, "diagram.png) below", ["links"]),
    ("![](https://e.x/i.png) Caption", None, " Caption", ["links"]),
    ("Docs at <https://e.x/docs> and https://e.x/b.", None, "Docs at and", ["urls"]),
    ("A checklist (https://e.x/x) works.", None, "A checklist works.", ["urls"]),
    ("## Proposed solution\n\nA checklist.", "Proposed solution", "A checklist.", ["headings"]),
    ("### Proposed Solution   \nBody.", "proposed solution", "Body.", ["headings"]),
    ("## Rollout\nPhase one.", "Proposed solution", "#### Rollout\nPhase one.", ["headings"]),
    ("# Anything {#solution}\n\nBody.", "Proposed solution", "Body.", ["headings"]),
    (
        "Intro.\n## Plan {#plan}\nStep one.\n### Risks  {#risks}  \nNone.",
        None,
        "Intro.\n#### Plan\nStep one.\n#### Risks\nNone.",
        ["headings"],
    ),
    (
        "Users drop off [c:c1] at [shipping](https://e.x/s) and [payment](https://e.x/p) [c:c2].",
        None,
        "Users drop off at shipping and payment.",
        ["citation_markers", "links"],
    ),
    ("#### Already small\nText", None, "#### Already small\nText", []),
    (
        "Activation rose from 31% to 45% in Q3 (n=1,200).",
        None,
        "Activation rose from 31% to 45% in Q3 (n=1,200).",
        [],
    ),
    (
        "[the October\nfunnel](https://e.x/f) shows it",
        None,
        "the October\nfunnel shows it",
        ["links"],
    ),
    (
        "- one [c:c1]\n- two ([link](https://e.x/2))\n\n1. three",
        None,
        "- one\n- two (link)\n\n1. three",
        ["citation_markers", "links"],
    ),
]


@pytest.mark.parametrize(("body", "heading", "text", "fixes"), NORMAL)
def test_normal_text_is_cleaned_exactly_as_before(body, heading, text, fixes):
    out = prompting.clean_body(body, heading)
    assert (out.text, out.fixes) == (text, fixes)
    assert prompting.body_problems(out.text) == []


def test_a_heading_id_goes_with_its_own_line_only():
    # Before, the whitespace around an id crossed lines, so the blank line after a
    # heading went with the heading's id. Now the id and the spaces beside it go; the
    # lines stay, and an id never spans two lines.
    out = prompting.clean_body("Intro.\n## Plan {#plan}\n\nStep one.")
    assert (out.text, out.fixes) == ("Intro.\n#### Plan\n\nStep one.", ["headings"])
    assert prompting._HEADING_ID.sub("", "a {#x}\n\n{#y}\nb") == "a\n\n\nb"
    assert prompting._HEADING_ID.sub("", "x {#a\nb}") == "x {#a\nb}"


# Section text an approver sends is capped at the spec's 200k characters (422 past it).
ROUTES = {
    "edit a suggestion": ("PATCH", "/v1/suggestions/{id}", "text"),
    "accept a suggestion": ("POST", "/v1/suggestions/{id}/accept", "text"),
    "apply a refinement": ("POST", "/v1/llm-jobs/{id}/apply", "body_md"),
    "apply a next draft": (
        "POST",
        "/v1/documents/onboarding-revamp/next-draft/{id}/apply",
        "edits",
    ),
}


@pytest.mark.parametrize("route", sorted(ROUTES))
async def test_section_text_is_capped_at_200k_characters(client, route):
    r = await seed(token_name="test")
    headers = {"Authorization": f"Bearer {r.token}"}
    method, path, field = ROUTES[route]
    url = path.format(id=uuid.uuid4())

    def body(text: str) -> dict:
        return {"edits": {"solution": text}} if field == "edits" else {field: text}

    over = await client.request(method, url, json=body("a" * (CAP + 1)), headers=headers)
    assert over.status_code == 422, over.text[:300]
    at = await client.request(method, url, json=body("a" * CAP), headers=headers)
    assert at.status_code != 422, at.text[:300]
