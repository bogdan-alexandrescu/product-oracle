"""The draft parser's and template titles' regexes take linear time (follow-up to #138).

Each pattern keeps its matches on real inputs (the tables, drawn from the parser, template
and blocker tests, and a fuzz against the pattern it replaced) and runs adversarial input
at 20k and 200k characters in a child process, so a regression is killed at WALL_LIMIT
instead of hanging the suite.
"""

import random
import re
import subprocess
import sys

import pytest

from oracle.blockers import render
from oracle.docs import parser
from oracle.templates import service

CPU_LIMIT = 0.2
WALL_LIMIT = 30
SIZES = (20_000, 200_000)

_OLD_CITATION_STRIP = re.compile(r"[ \t]*\[c:[^\]\s]+\]")
_OLD_SECTION_ID = re.compile(r"\s*\{#([A-Za-z0-9][A-Za-z0-9_.:-]*)\}\s*$")
_OLD_TITLE_LINE = re.compile(r"^(#\s+)(.*?)(\s*\{#[A-Za-z0-9][A-Za-z0-9_.:-]*\}\s*)$", re.M)
_PIECES = [" ", "\t", "\n", "\r", "a", "b", "-", "{", "}", "#", "[", "]", "c", ":"]
_PIECES += ["{#", "[c:", "{#a}", "{#a.b-c}", "[c:x]", "[c:c1]", "# ", "## ", "  "]


# Pure tests: replace the suite's autouse database fixtures, so they run without Postgres.
@pytest.fixture(scope="session")
def migrated_db() -> None:
    return None


@pytest.fixture
def _truncate_after_test() -> None:
    return None


# name -> (setup, call on `s`, adversarial inputs as expressions of `n`)
CASES = {
    "citation_strip": (
        "from oracle.docs.parser import CITATION_STRIP_RE",
        'CITATION_STRIP_RE.sub("", s)',
        [
            '"a" + " " * n + "b"',
            '"a" + " \\t" * (n // 2) + "[c:"',
            '"[c:" * (n // 3)',
            '"[c:" + "[" * n',
            '" [c:a" * (n // 5)',
        ],
    ),
    "body_text": (
        "from oracle.docs.parser import body_text",
        "body_text(s)",
        # Not a "[c:" flood: markdown-it alone takes ~14 us a character on one.
        ['"a" + " " * n + "b"', '"a" + " \\t" * (n // 2) + "[c:"'],
    ),
    "section_id": (
        "from oracle.docs.parser import SECTION_ID_RE",
        "SECTION_ID_RE.search(s)",
        ['"a" + " " * n + "b"', '"{#a} " * (n // 5) + "b"', '"{#a}" + " " * n + "b"', '"{#" * n'],
    ),
    "template_headings": (
        "from oracle.templates.validation import _headings",
        "_headings(s, 0)",
        ['"## a" + " " * n + "b"'],
    ),
    "title_line": (
        "from oracle.templates.service import _TITLE_LINE",
        '_TITLE_LINE.sub("", s, count=1)',
        [
            '"# a" + " " * n + "x"',
            '"#" + " " * n + "x"',
            '"#" + "\\n" * n + "x"',
            '"# a" + "\\n" * n + "x"',
            '"# " + "a " * (n // 2)',
            '"# " + "{#a} " * (n // 5) + "x"',
            '"# a {#b}x\\n" * (n // 10)',
        ],
    ),
    "draft_skeleton": (
        "from oracle.templates.service import draft_skeleton",
        'draft_skeleton(s, slug="d", title="T", kind="prd", template="t", version=1, theme=None)',
        ['"# a" + " " * n + "x"'],
    ),
    "blocker_inline": (
        "from oracle.blockers.render import _inline",
        "_inline(s)",
        [
            '"a" + " " * n + "b"',
            '"{" * (n // 4) + "{#}" + "#}" * (n // 4)',
            '"[" * (n // 4) + "{#}" + "c:x]" * (n // 8)',
            '"{{#}#x}" * (n // 7)',
            '"[c:" * (n // 3) + "]"',
            '"[c:a" * (n // 4)',
        ],
    ),
}


def cpu_seconds(setup: str, call: str, make: str, n: int) -> float:
    code = (
        f"import time\n{setup}\nn = {n}\ns = {make}\n"
        f"t = time.process_time()\n{call}\nprint(time.process_time() - t)\n"
    )
    out = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        text=True,
        timeout=WALL_LIMIT,
        check=True,
    )
    return float(out.stdout)


@pytest.mark.parametrize("n", SIZES)
@pytest.mark.parametrize(
    "name,make", [(name, make) for name, (_, _, makes) in CASES.items() for make in makes]
)
def test_adversarial_input_runs_in_linear_time(name, make, n):
    setup, call, _ = CASES[name]
    assert cpu_seconds(setup, call, make, n) < CPU_LIMIT


def _fuzz(count: int, seed: int) -> list[str]:
    rng = random.Random(seed)
    return ["".join(rng.choices(_PIECES, k=rng.randint(0, 16))) for _ in range(count)]


@pytest.mark.parametrize(
    "text,stripped",
    [
        ("Some **bold** and `code` [c:c1], then", "Some **bold** and `code`, then"),
        ("purchase [c:c1].", "purchase."),
        ("See [c:c1] and [c:ghost].", "See and."),
        ("| **Checkout** completion [c:c1] | 52% |", "| **Checkout** completion | 52% |"),
        ("a\t \t[c:x][c:y] b", "a b"),
        ("[c:a b] and [c:] stay", "[c:a b] and [c:] stay"),
        ("Limit [c:evil] here", "Limit here"),
        ("- [c:c9]", "-"),
        ("id [c:a[b]", "id"),
    ],
)
def test_citations_are_stripped_the_same(text, stripped):
    assert parser.CITATION_STRIP_RE.sub("", text) == stripped
    assert _OLD_CITATION_STRIP.sub("", text) == stripped


def test_citation_strip_matches_the_old_pattern():
    for text in _fuzz(30_000, 1):
        old = _OLD_CITATION_STRIP.sub("", text)
        # A citation id holding another "[c:" is stripped from the inner one: not real input.
        if any(m.group().count("[c:") > 1 for m in _OLD_CITATION_STRIP.finditer(text)):
            continue
        assert parser.CITATION_STRIP_RE.sub("", text) == old, text


def test_body_text_still_strips_citations():
    md = "Some **bold** and `code` [c:c1], then a [link](https://example.com).\n\n- one\n- two"
    assert parser.body_text(md) == "Some bold and code, then a link.\none\ntwo"


@pytest.mark.parametrize(
    "raw,found",
    [
        ("Problem {#problem}", (7, "problem")),
        ("Sources and data points {#sources}", (23, "sources")),
        ("{{title}} {#title}", (9, "title")),
        ("T {#t}", (1, "t")),
        ("Constraints {#constraints-solutions-detail}  ", (11, "constraints-solutions-detail")),
        ("A\t{#a.b:c_d-e}", (1, "a.b:c_d-e")),
        ("{#only}", (0, "only")),
        ("No id here", None),
        ("Bad {#-x}", None),
        ("Mid {#x} text", None),
    ],
)
def test_section_ids_are_found_the_same(raw, found):
    for pattern in (parser.SECTION_ID_RE, _OLD_SECTION_ID):
        m = pattern.search(raw)
        assert (m and (m.start(), m.group(1))) == found


def test_section_id_matches_the_old_pattern():
    for text in _fuzz(30_000, 2):
        old, new = _OLD_SECTION_ID.search(text), parser.SECTION_ID_RE.search(text)
        assert (old and (old.span(), old.groups())) == (new and (new.span(), new.groups())), text


def test_parse_draft_reads_heading_ids():
    parsed = parser.parse_draft("---\ndocument: d\ntitle: T\n---\n# T   {#t}\n\nBody.\n")
    assert [(s.section_key, s.heading) for s in parsed.sections] == [("t", "T")]


@pytest.mark.parametrize(
    "md,titled",
    [
        ("# {{title}} {#title}\n\n## Problem {#p}\n", "# T {#title}\n\n## Problem {#p}\n"),
        ("# Old title   {#t}  \nBody", "# T   {#t}  \nBody"),
        ("#\t{#t}\n", "#\tT{#t}\n"),
        ("## Sub {#s}\n# Top {#t}\n", "## Sub {#s}\n# T {#t}\n"),
        ("# No id\n# Has {#h}\n", "# No id\n# T {#h}\n"),
        ("# A {#x} tail\n", "# A {#x} tail\n"),
    ],
)
def test_title_line_is_replaced_the_same(md, titled):
    for pattern in (service._TITLE_LINE, _OLD_TITLE_LINE):
        assert pattern.sub(lambda m: f"{m.group(1)}T{m.group(3)}", md, count=1) == titled


def test_title_line_matches_the_old_pattern():
    for text in _fuzz(30_000, 3):
        old = [(m.span(), m.groups()) for m in _OLD_TITLE_LINE.finditer(text)]
        assert [(m.span(), m.groups()) for m in service._TITLE_LINE.finditer(text)] == old, text


@pytest.mark.parametrize(
    "text,clean",
    [
        ("Limit [c:evil] here {#title}\n## Injected {#injected}", "Limit here ## Injected"),
        ("Rate limit {#blocker-partner-api-rate-limit} applies", "Rate limit applies"),
        ("no anchors {here}", "no anchors {here}"),
        ("[c:a b] stays", "[c:a b] stays"),
        # Stripping one token joins its neighbours into another: strip until none is left.
        ("{{#}#evil-id}", ""),
        ("[{#}c:x]", ""),
        ("a {{{#}#}#evil}b", "a b"),
        ("x [c:a[c:b] y", "x [c:a y"),
        ("[c:[c:]", "]"),
    ],
)
def test_inline_leaves_no_citation_or_anchor(text, clean):
    out = render._inline(text)
    assert out == clean
    assert "{#" not in out
    assert not parser.CITATION_RE.search(out)


def test_inline_reaches_a_fixed_point():
    for text in _fuzz(30_000, 4):
        out = render._inline(text)
        assert "{#" not in out, text
        assert not parser.CITATION_RE.search(out), text
