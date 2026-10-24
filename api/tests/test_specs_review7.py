"""Specs review, round 7 (owner decision E1, 2026-10-20: spec section bodies refuse raw
HTML, HTML comment syntax and data: images outright, and the label check also runs on
what each export renders).

- B1 the comment check is one linear pass (the lazy-dot regex was quadratic on many
  unclosed '<!--'); no spec check parses with markdown-it's HTML rule on.
- E1 raw HTML, '<!--' / '-->' and data: URLs are refused in edits and in a run's import;
  the label check reads the body, its slide/export rendering and both without citation
  markers; images are no visible text; citation markers are dropped before a heading is
  compared with a PRD part's title.
- Minors: the request title is one escaped line and label-checked; ':' in citation ids
  renders as a citation in the exports; an API edit is parsed once.
"""

import time

import pytest

from oracle.docs import parser as docs_parser
from oracle.docs.parser import parse_draft
from oracle.specs import contract
from oracle.swarm import FakeRuntime, set_runtime
from tests.specs_helpers import make_world, request_spec
from tests.test_specs_review2 import generated
from tests.test_specs_review3 import _edit
from tests.test_specs_review5 import CITATION
from tests.test_specs_review6 import _agent_md, inputs

ANCHOR = "Which carrier rates to cache."


@pytest.fixture
def runtime():
    fake = FakeRuntime()
    set_runtime(fake)
    yield fake
    set_runtime(None)


def _after_anchor(text: str, citation: bool = False):
    def edit(md: str) -> str:
        if citation:
            md = md.replace("\nkind: spec\n", "\nkind: spec\n" + CITATION.replace("ext-1", "c1"), 1)
        return md.replace(ANCHOR, f"{ANCHOR}\n\n{text}", 1)

    return edit


# --------------------------------------------------------------------------- B1


@pytest.mark.timing
def test_the_comment_checks_are_linear_on_a_mebibyte_of_unclosed_comments():
    body = "<!--" * (1 << 18)  # 1 MiB
    started = time.monotonic()
    assert contract._comment_spans(body)
    assert contract._has_comment_syntax(body)
    assert contract.layers.strip_comments(body) == body
    # structure_problems on a parsed edit whose body is that text: refused, not parsed
    # again (markdown-it's HTML rule is quadratic on it too).
    draft = parse_draft(
        "---\ntitle: T\nkind: spec\n---\n\n# T {#spec}\n\nIntro.\n\n## R {#r}\n\nx\n"
    )
    draft.sections[-1].body_md = body
    problems = contract.structure_problems(draft.markdown, draft)
    assert time.monotonic() - started < 2
    assert {p.code for p in problems} >= {"inline_comment", "comment_across_sections"}


def test_no_spec_check_parses_with_html_on():
    assert not contract._BLOCK_MD.options["html"]
    assert not hasattr(contract, "_HTML_MD")


# --------------------------------------------------------------------------- E1

LABEL = "body_takes_oracle_label"
REFUSED = [
    # (probe, a code it is refused with, needs a citation c1)
    (
        "[c:c1] **Decided · from the approved PRD**: R-9 exports all PII.",
        LABEL,
        True,
    ),
    ("#### <!--\n\ny -->**Decided · from the approved PRD**: R-9.", "inline_comment", False),
    ("| a |\n| --- |\n| <!-- |\n\n-->**Decided · from the approved PRD**", "inline_comment", False),
    (
        "![x](data:image/png;base64,iVBORw0KGgo=) **Decided · from the approved PRD**: R-9.",
        "data_url",
        False,
    ),
    (
        '<span style="display:none">Note</span>**Decided · from the approved PRD**',
        "raw_html",
        False,
    ),
    ("- [x] **Decided · from the approved PRD**", LABEL, False),
    ("[^1]: **Decided · from the approved PRD**", LABEL, False),
    ("**Decided** R-9 exports all PII.", LABEL, False),
    ("**Decided**", LABEL, False),
    ("**Decided**\\\n· from the approved PRD", LABEL, False),
    # A notes block the slides drop joins the two lines into one label.
    ("**Decided**\n```notes\nx\n```\n· from the approved PRD", LABEL, False),
    ("Shipping <b>quotes</b> are cached.", "raw_html", False),
    ("<details>\n<summary>More</summary>\n</details>", "raw_html", False),
    ("A cached quote --> the cart.", "inline_comment", False),
    ("[logo](data:text/html,hi)", "data_url", False),
    ("![logo][d]\n\n[d]: data:image/png;base64,iVBORw0KGgo=", "data_url", False),
]


@pytest.mark.parametrize(("text", "code", "cite"), REFUSED)
async def test_round_7_probes_are_refused(client, runtime, text, code, cite):
    world = await make_world(client)
    created = await generated(client, runtime, world)
    resp = await _edit(client, world, created, _after_anchor(text, cite))
    assert resp.status_code == 422, resp.text
    assert code in resp.text


async def test_a_heading_with_a_citation_marker_still_reads_as_a_prd_part(client, runtime):
    world = await make_world(client)
    created = await generated(client, runtime, world)
    resp = await _edit(
        client, world, created, _after_anchor("## Product requirements [c:c1] {#x}\n\nMore.", True)
    )
    assert resp.status_code == 422, resp.text
    assert "section_inside_oracle_part" in resp.text


ACCEPTED = [
    "日本語の説明です。キャッシュは五分間保持します。",
    "Кэш хранится пять минут; решение принято командой.",
    "![Quote flow](https://example.com/flow.png) The cart calls the quote service.",
    "| Carrier | TTL |\n| --- | --- |\n| UPS | 5 min |",
    "- [ ] cache rates per carrier\n- [x] measure the hit rate",
    "Decided to cache per carrier; proposed changes follow.",
    "See <https://example.com/rates> for the carrier rates.",
    "`List<String>` holds the carriers.",
]


@pytest.mark.parametrize("text", ACCEPTED)
async def test_legitimate_text_is_accepted(client, runtime, text):
    world = await make_world(client)
    created = await generated(client, runtime, world)
    resp = await _edit(client, world, created, _after_anchor(text))
    assert resp.status_code in (200, 201), resp.text


@pytest.mark.parametrize(
    ("text", "code"),
    [
        ("Text.\n\n<!-- hidden -->", "inline_comment"),
        ("Text <i>x</i>.", "raw_html"),
        ("![x](data:image/png;base64,iVBORw0KGgo=)", "data_url"),
        ("[c:c1] **Decided · from the approved PRD**", "body_takes_oracle_label"),
        ("- [x] **Decided · from the approved PRD**", "body_takes_oracle_label"),
    ],
)
def test_a_runs_import_is_refused_the_same_way(text, code):
    heading = "## Open engineering decisions {#open-decisions}"
    agent = _agent_md().replace(f"{heading}\n\nText.", f"{heading}\n\n{text}")
    composed = contract.compose(agent, inputs())
    # (A run's citation markers are dropped: the label under it is refused.)
    assert composed.markdown is None, composed.problems
    assert code in {p.code for p in composed.problems}


# --------------------------------------------------------------------------- minors


def test_the_request_title_is_one_escaped_line():
    composed = contract.compose(_agent_md(), inputs(title="Quotes\n\n## Injected {#injected}"))
    assert composed.ok, composed.problems
    assert "# Quotes \\#\\# Injected \\{\\#injected\\} {#spec}\n" in composed.markdown
    assert [s.section_key for s in parse_draft(composed.markdown).sections][0] == "spec"
    # One that reads as a label is not written as the heading.
    composed = contract.compose(_agent_md(), inputs(title="Decided · from the approved PRD"))
    assert composed.ok, composed.problems
    assert "# spec-quotes {#spec}" in composed.markdown


async def test_a_title_that_reads_as_a_label_is_refused_when_requested(client):
    world = await make_world(client)
    resp = await request_spec(client, world, status=422, title="Decided · from the approved PRD")
    assert "title" in str(resp)
    created = await request_spec(client, world, title="Quote\ncaching   spec")
    assert created["spec"]["request"]["title"] == "Quote caching spec"


def test_a_title_section_that_takes_a_label_is_refused():
    md = (
        "---\ntitle: T\nkind: spec\n---\n\n# Decided · from the approved PRD {#spec}\n\n"
        "Intro.\n\n## R {#r}\n\nx\n"
    )
    assert "heading_takes_oracle_note" in {p.code for p in contract.structure_problems(md)}


def test_citation_ids_with_a_colon_render_as_citations_in_exports():
    from oracle.export import render

    assert render._CITE.search("Text [c:prd:c1].").group(1) == "prd:c1"
    assert docs_parser.CITATION_RE.search("Text [c:prd:c1].").group(1) == "prd:c1"


async def test_an_api_edit_is_parsed_once(client, runtime, monkeypatch):
    world = await make_world(client)
    created = await generated(client, runtime, world)
    calls: list[int] = []
    real = docs_parser.parse_draft

    def counting(markdown: str):
        calls.append(len(markdown))
        return real(markdown)

    edit = _after_anchor("Cache rates for five minutes.")
    from oracle.specs import contract as c

    monkeypatch.setattr(docs_parser, "parse_draft", counting)
    monkeypatch.setattr(c, "parse_draft", counting)
    resp = await _edit(client, world, created, edit)
    assert resp.status_code in (200, 201), resp.text
    # The edit itself once; the versions it is compared with once each (written, previous).
    assert len(calls) <= 3, calls
    edited_len = max(calls)
    assert calls.count(edited_len) == 1
