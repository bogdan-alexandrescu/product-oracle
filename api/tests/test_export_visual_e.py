"""Visual QA pass E: PRD exports and Present mode.

E-6 no export shows an ISO date (the snapshot reads month first); E-8 a long title fits
the PPTX title slide and the footer stays on the slide; E-9 an overlong brief section goes
on continuation slides, never past the slide's edge; E-11 dates in brief text read month
first on slides; E-12 a goal in the items table carries its name; E-15 the no-brief
refusal names the PRD by its title.
"""

import io
import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest
from pptx import Presentation
from pptx.util import Pt
from pypdf import PdfReader

from oracle.export import deck as deck_module
from oracle.export import pptx as pptx_module
from oracle.export import render as render_module
from tests.test_brief import DETAIL_ONLY, DRAFT, _import, requires_pdf
from tests.test_priorities import _token

ISO = re.compile(r"\d{4}-\d{2}-\d{2}")
LONG_TITLE = (
    "Checkout for returning buyers on every device, with saved addresses, one-page payment "
    "and reminders for carts left behind"
)
RISKS = "\n".join(
    f"- Risk {i}: the payment provider may limit calls during the beta in region {i}, so we "
    f"test with the provider first and keep a fallback ready."
    for i in range(1, 14)
)


def _draft(title: str = "Checkout PRD") -> str:
    md = DRAFT.replace("title: Checkout PRD\n", f"title: {title}\nsnapshot: 2026-10-16T14:00Z\n")
    md = md.replace("# Checkout PRD {#title}", f"# {title} {{#title}}")
    md = md.replace(
        "## Goal trace {#goal-trace}\n- Activation: more first orders this quarter.",
        "## Goal trace {#goal-trace}\n- **G2 (retention)**: more repeat orders within 30 days.",
    )
    md = md.replace("| Activation | Less typing |", "| G2 | Less typing |")
    md = md.replace("| Activation | One step to pay |", "| G2 | One step to pay |")
    return md.replace(
        "- Payment provider limits: test with the provider first. See [Risks](#risks).", RISKS
    )


@pytest.fixture
async def long_doc(client, tenant_id):
    h = await _token(tenant_id, "approver")
    resp = await _import(client, h, _draft(LONG_TITLE))
    assert resp.status_code == 201, resp.text
    return h


BASE = "/v1/documents/checkout/versions/1"


def _visible(html: str) -> str:
    """What a reader sees: the text, without tags, styles or attributes."""
    html = re.sub(r"<(style|script)[^>]*>.*?</\1>", " ", html, flags=re.S)
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html))


def _pptx_texts(content: bytes) -> list[list[str]]:
    out = []
    for slide in Presentation(io.BytesIO(content)).slides:
        texts = []
        for sh in slide.shapes:
            if sh.has_text_frame:
                texts.append(sh.text_frame.text)
            if sh.has_table:
                texts += [c.text for row in sh.table.rows for c in row.cells]
        out.append(texts)
    return out


async def test_e6_no_export_shows_an_iso_date(client, long_doc):
    h = long_doc
    seen = {}
    for q in ("format=html", "layer=brief&format=html", "layer=deck&format=html"):
        resp = await client.get(f"{BASE}/export?{q}", headers=h)
        assert resp.status_code == 200, resp.text
        seen[q] = _visible(resp.text)
    deck = (await client.get(f"{BASE}/deck", headers=h)).json()
    seen["deck"] = " ".join(
        [deck["as_of"], deck["banner"]] + [_visible(s["html"]) for s in deck["slides"]]
    )
    pptx = await client.get(f"{BASE}/export?layer=deck&format=pptx", headers=h)
    # A date's parts are joined by no-break spaces (E-11); read as a person does.
    seen["pptx"] = " ".join(t for ts in _pptx_texts(pptx.content) for t in ts).replace(
        "\u00a0", " "
    )
    for where, text in seen.items():
        assert not ISO.search(text), (where, ISO.findall(text)[:3])
    # The snapshot reads month first, as the dates beside it do.
    assert "Oct 16, 2026" in seen["format=html"] and "Oct 16, 2026" in seen["pptx"]
    assert "Oct 16, 2026" in seen["deck"]
    # E-11: a date in the brief's own text, on the slides and in the PPTX.
    assert "needed by Nov 1, 2026" in seen["deck"] and "needed by Nov 1, 2026" in seen["pptx"]


@requires_pdf
async def test_e6_pdfs_show_no_iso_date(client, long_doc):
    for q in ("format=pdf", "layer=brief&format=pdf", "layer=deck&format=pdf"):
        resp = await client.get(f"{BASE}/export?{q}", headers=long_doc)
        assert resp.status_code == 200
        text = " ".join(p.extract_text() for p in PdfReader(io.BytesIO(resp.content)).pages)
        assert not ISO.search(text), (q, ISO.findall(text)[:3])


def _lines(text: str, size_pt: float, width_emu: int) -> int:
    """Lines ``text`` wraps to in bold heading type (about 0.55 em a character)."""
    per_line = max(1, int(width_emu / Pt(size_pt * 0.55)))
    return -(-len(text) // per_line)


async def test_e8_a_long_title_fits_the_title_slide_and_the_footer_the_slide(client, long_doc):
    resp = await client.get(f"{BASE}/export?layer=deck&format=pptx", headers=long_doc)
    prs = Presentation(io.BytesIO(resp.content))
    first = list(prs.slides)[0]
    boxes = {sh.text_frame.text: sh for sh in first.shapes if sh.has_text_frame}
    title = boxes[LONG_TITLE]
    sub = next(sh for t, sh in boxes.items() if t.startswith("Version 1"))
    size = title.text_frame.paragraphs[0].runs[0].font.size.pt
    assert size < 44
    wrapped = _lines(LONG_TITLE, size, title.width) * Pt(size * 1.2)
    assert wrapped <= title.height, "the title's wrapped text is taller than its box"
    assert title.top + title.height <= sub.top, "the title runs over the subtitle"
    for slide in prs.slides:
        footer = next(
            sh
            for sh in slide.shapes
            if sh.has_text_frame
            and "Version 1" in sh.text_frame.text
            and sh.top >= pptx_module.FOOTER_TOP
        )
        text = footer.text_frame.text
        run = footer.text_frame.paragraphs[0].runs[0]
        # 10 pt type, about 0.5 em a character: the whole line within the box, on the slide.
        assert len(text) * Pt(run.font.size.pt * 0.5) <= footer.width, text
        assert footer.left + footer.width <= prs.slide_width
        assert "…" in text and LONG_TITLE not in text


async def test_e9_a_long_section_goes_on_continuation_slides(client, long_doc):
    deck = (await client.get(f"{BASE}/deck", headers=long_doc)).json()
    headings = [s["heading"] for s in deck["slides"]]
    risks = [s for s in deck["slides"] if s["heading"].startswith("Top risks")]
    n = len(risks)
    assert n >= 2 and [s["heading"] for s in risks] == [
        f"Top risks ({i} of {n})" for i in range(1, n + 1)
    ], headings
    assert {s["section_key"] for s in risks} == {"top-risks"}
    shown = " ".join(_visible(s["html"]) for s in risks)
    for i in range(1, 14):
        assert shown.count(f"Risk {i}:") == 1, i
    # The deck's numbering counts every slide.
    assert [s["index"] for s in deck["slides"]] == list(range(1, len(deck["slides"]) + 1))
    assert f"/ {len(deck['slides'])}" in deck["slides"][-1]["html"]

    resp = await client.get(f"{BASE}/export?layer=deck&format=pptx", headers=long_doc)
    prs = Presentation(io.BytesIO(resp.content))
    titles = [_pptx_texts(resp.content)[i][0] for i in range(1, len(prs.slides))]
    assert [t for t in titles if t.startswith("Top risks")] == [s["heading"] for s in risks]
    for n, slide in enumerate(prs.slides, start=1):
        for sh in slide.shapes:
            if sh.top < pptx_module.FOOTER_TOP:
                assert sh.top + sh.height <= pptx_module.FOOTER_TOP, (n, sh.name)


async def test_e12_a_goal_in_the_items_table_has_its_name(client, long_doc):
    deck = (await client.get(f"{BASE}/deck", headers=long_doc)).json()
    items = next(s for s in deck["slides"] if s["heading"] == "Features by milestone")
    assert "G2 Retention" in _visible(items["html"])
    resp = await client.get(f"{BASE}/export?layer=deck&format=pptx", headers=long_doc)
    cells = next(ts for ts in _pptx_texts(resp.content) if ts and ts[0] == "Features by milestone")
    assert "G2 Retention" in cells and "G2" not in cells


async def test_e15_the_no_brief_refusal_names_the_prd_by_its_title(client, tenant_id):
    h = await _token(tenant_id, "approver")
    assert (await _import(client, h, DETAIL_ONLY, "notes")).status_code == 201
    resp = await client.get(
        "/v1/documents/notes/versions/1/export?layer=deck&format=pptx", headers=h
    )
    assert resp.status_code == 422
    assert resp.json()["detail"] == (
        "Version 1 of Notes has no brief: export the full PRD instead."
    )


# Review round 2 of PR 1300: a single paragraph, list item, code block or table row longer
# than a slide is split too (it once stayed on one slide and ran past the PPTX's footer);
# a date never wraps between its parts; the continuation heading fits its box; Present mode's
# no-brief message does not speak of exporting; a freeform snapshot is not doubled.
NBSP = " "
SENTENCES = [
    f"Sentence {i} says the saved cart for returning buyers keeps its items for thirty days."
    for i in range(1, 31)
]
ONE_PARAGRAPH = " ".join(SENTENCES)


def _paragraph_draft() -> str:
    return _draft().replace(RISKS, ONE_PARAGRAPH)


def test_e9_one_paragraph_longer_than_a_slide_is_split_at_sentences():
    budget = deck_module.SLIDE_LINES
    pages = deck_module.slide_pages(ONE_PARAGRAPH, budget)
    assert len(pages) >= 2
    shown = " ".join(pages)
    for i, sentence in enumerate(SENTENCES, start=1):
        assert shown.count(sentence) == 1, i
    for page in pages:
        assert sum(u.cost for u in deck_module._units(page)) <= budget, page


def test_e9_a_long_list_item_and_table_row_are_split():
    budget = deck_module.SLIDE_LINES
    item = "- " + ONE_PARAGRAPH
    pages = deck_module.slide_pages(item, budget)
    assert len(pages) >= 2 and pages[0].startswith("- Sentence 1 ")
    assert all(" ".join(pages).count(s) == 1 for s in SENTENCES)

    table = "| Feature | Outcome |\n| --- | --- |\n| Saved carts | " + ONE_PARAGRAPH + " |"
    pages = deck_module.slide_pages(table, budget)
    assert len(pages) >= 2
    for page in pages:
        assert page.startswith("| Feature | Outcome |\n| --- | --- |\n"), page
    assert all(" ".join(pages).count(s) == 1 for s in SENTENCES)


async def test_e9_a_paragraph_longer_than_a_slide_stays_above_the_pptx_footer(client, tenant_id):
    h = await _token(tenant_id, "approver")
    assert (await _import(client, h, _paragraph_draft())).status_code == 201
    deck = (await client.get(f"{BASE}/deck", headers=h)).json()
    risks = [s for s in deck["slides"] if s["heading"].startswith("Top risks")]
    assert len(risks) >= 2, [s["heading"] for s in deck["slides"]]
    shown = " ".join(_visible(s["html"]) for s in risks)
    for i, sentence in enumerate(SENTENCES, start=1):
        assert shown.count(sentence) == 1, i

    resp = await client.get(f"{BASE}/export?layer=deck&format=pptx", headers=h)
    prs = Presentation(io.BytesIO(resp.content))
    pptx_text = " ".join(t for ts in _pptx_texts(resp.content) for t in ts)
    for i, sentence in enumerate(SENTENCES, start=1):
        assert pptx_text.count(sentence) == 1, i
    for n, slide in enumerate(prs.slides, start=1):
        for sh in slide.shapes:
            if sh.top < pptx_module.FOOTER_TOP:
                assert sh.top + sh.height <= pptx_module.FOOTER_TOP, (n, sh.name)


def test_e11_a_date_never_wraps_between_its_parts():
    assert render_module.days_in_words("needed by 2026-11-15.") == (
        f"needed by Nov{NBSP}15,{NBSP}2026."
    )


async def test_e11_dates_on_slides_and_in_the_pptx_hold_together(client, long_doc):
    deck = (await client.get(f"{BASE}/deck", headers=long_doc)).json()
    html = " ".join(s["html"] for s in deck["slides"])
    assert f"needed by Nov{NBSP}1,{NBSP}2026" in html
    assert "Nov 1, 2026" not in html
    assert f"Oct{NBSP}16,{NBSP}2026" in deck["as_of"]
    assert re.search(r"Imported [A-Z][a-z]{2}\u00a0\d{1,2},\u00a0\d{4}, ", deck["banner"]), deck[
        "banner"
    ]
    resp = await client.get(f"{BASE}/export?layer=deck&format=pptx", headers=long_doc)
    pptx_text = " ".join(t for ts in _pptx_texts(resp.content) for t in ts)
    assert f"needed by Nov{NBSP}1,{NBSP}2026" in pptx_text
    resp = await client.get(f"{BASE}/export?layer=brief&format=html", headers=long_doc)
    assert f"Nov{NBSP}1,{NBSP}2026" in resp.text


def test_e6_a_freeform_snapshot_is_not_doubled():
    for text in ("sources as of the Oct 16 pull", "Sources as of the Oct 16 pull"):
        assert render_module.snapshot_in_words(text, "UTC") == "the Oct 16 pull"
    assert render_module.snapshot_in_words("as of the Oct 16 pull", "UTC") == "the Oct 16 pull"


def test_e8_a_continuation_heading_fits_its_box():
    width = pptx_module.WIDTH - 2 * pptx_module.MARGIN
    heading = LONG_TITLE + " (2 of 3)"
    size, height = pptx_module.heading_fit(heading, width)
    assert size < 28
    assert _lines(heading, size, width) * Pt(size * 1.2) <= height
    assert pptx_module.HEADING_TOP + height <= pptx_module.BODY_TOP


async def test_e8_a_long_section_title_in_the_pptx_ends_above_the_body(client, tenant_id):
    h = await _token(tenant_id, "approver")
    md = _draft().replace("## Top risks {#top-risks}", f"## Top risks: {LONG_TITLE} {{#top-risks}}")
    assert (await _import(client, h, md)).status_code == 201
    resp = await client.get(f"{BASE}/export?layer=deck&format=pptx", headers=h)
    prs = Presentation(io.BytesIO(resp.content))
    seen = 0
    for slide in prs.slides:
        for sh in slide.shapes:
            if sh.has_text_frame and sh.text_frame.text.startswith("Top risks: "):
                seen += 1
                size = sh.text_frame.paragraphs[0].runs[0].font.size.pt
                text = sh.text_frame.text
                assert _lines(text, size, sh.width) * Pt(size * 1.2) <= sh.height, text
                assert sh.top + sh.height <= pptx_module.BODY_TOP, text
    assert seen >= 2


async def test_e15_present_mode_without_a_brief_does_not_say_export(client, tenant_id):
    h = await _token(tenant_id, "approver")
    assert (await _import(client, h, DETAIL_ONLY, "notes")).status_code == 201
    resp = await client.get("/v1/documents/notes/versions/1/deck", headers=h)
    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert "export" not in detail.lower()
    assert detail == "Version 1 of Notes has no brief to present: open the full PRD instead."


@requires_pdf
async def test_e9_a_paragraph_longer_than_a_slide_is_whole_in_the_deck_pdf(client, tenant_id):
    h = await _token(tenant_id, "approver")
    assert (await _import(client, h, _paragraph_draft())).status_code == 201
    resp = await client.get(f"{BASE}/export?layer=deck&format=pdf", headers=h)
    assert resp.status_code == 200
    text = " ".join(p.extract_text() for p in PdfReader(io.BytesIO(resp.content)).pages)
    text = re.sub(r"\s+", " ", text)
    for i, sentence in enumerate(SENTENCES, start=1):
        assert text.count(sentence) == 1, i


# Review round 3 of PR 1300. The owner (Nov 5): code stays out of decks. A code block is one
# line on its slide, "Code: N lines, in the full PRD", linking to that place in the full PRD
# (the HTML deck and Present mode; the PPTX and the deck PDF show the words); it is never
# split into continuation slides, never a blank slide. A table row with one overlong cell
# fills its continuation slides; the document exports hold their stamps together.
CODE = (
    "Steps to try:\n\n```\n" + "\n".join(f"step {i} of the rollout" for i in range(1, 41)) + "\n```"
)
CODE_LINE = "Code: 40 lines, in the full PRD"


def _code_draft() -> str:
    return _draft().replace(RISKS, CODE)


def _no_code(text: str) -> None:
    assert text.count(CODE_LINE) == 1, text
    for i in (1, 7, 20, 40):
        assert f"step {i} of the rollout" not in text, i


async def test_r3_a_code_block_is_one_line_on_its_slide(client, tenant_id):
    h = await _token(tenant_id, "approver")
    assert (await _import(client, h, _code_draft())).status_code == 201
    deck = (await client.get(f"{BASE}/deck", headers=h)).json()
    headings = [s["heading"] for s in deck["slides"]]
    assert "Top risks" in headings and not any(x.startswith("Top risks (") for x in headings)
    _no_code(" ".join(_visible(s["html"]) for s in deck["slides"]))
    for s in deck["slides"]:
        if s["kind"] == "section":
            body = s["html"][s["html"].index("slide-body") :]
            assert _visible(body).replace(s["heading"], "").strip(), s["heading"]
            assert "<pre" not in s["html"], s["heading"]
    risks = next(s for s in deck["slides"] if s["heading"] == "Top risks")
    assert "Steps to try:" in _visible(risks["html"])
    link = re.search(r'<a href="([^"]+)">' + CODE_LINE + "</a>", risks["html"])
    assert link and link.group(1).endswith("/documents/checkout/v/1#s-top-risks"), risks["html"]

    html = (await client.get(f"{BASE}/export?layer=deck&format=html", headers=h)).text
    assert re.search(r'<a href="[^"]*/documents/checkout/v/1#s-top-risks">' + CODE_LINE, html)

    resp = await client.get(f"{BASE}/export?layer=deck&format=pptx", headers=h)
    texts = _pptx_texts(resp.content)
    assert len(texts) == len(deck["slides"])
    _no_code(" ".join(t for ts in texts for t in ts))
    on_risks = [ts for ts in texts if "Top risks" in ts]
    assert len(on_risks) == 1 and any(CODE_LINE in t for t in on_risks[0])


@requires_pdf
async def test_r3_a_code_block_is_one_plain_line_in_the_deck_pdf(client, tenant_id):
    h = await _token(tenant_id, "approver")
    assert (await _import(client, h, _code_draft())).status_code == 201
    deck = (await client.get(f"{BASE}/deck", headers=h)).json()
    resp = await client.get(f"{BASE}/export?layer=deck&format=pdf", headers=h)
    assert resp.status_code == 200
    reader = PdfReader(io.BytesIO(resp.content))
    assert len(reader.pages) == len(deck["slides"])
    pages = [re.sub(r"\s+", " ", p.extract_text()) for p in reader.pages]
    _no_code(" ".join(pages))
    for n, text in enumerate(pages, start=1):
        assert text.strip(), n
    for page in reader.pages:
        for annot in page.get("/Annots") or []:
            uri = str((annot.get_object().get("/A") or {}).get("/URI") or "")
            assert "#s-top-risks" not in uri, uri


def test_r3_a_table_row_with_one_long_cell_fills_its_slides():
    budget = deck_module.SLIDE_LINES
    table = "| Feature | Outcome |\n| --- | --- |\n| Saved carts | " + ONE_PARAGRAPH + " |"
    pages = deck_module.slide_pages(table, budget)
    assert len(pages) >= 2
    assert all(" ".join(pages).count(s) == 1 for s in SENTENCES)
    # The Outcome cell is rendered most of the slide wide (the Feature column holds two
    # words), so each slide but the last holds more than half its lines of it at about
    # 80 characters a line, not at half the slide's width.
    rows = int((budget - 1.2) / 1.2)
    for page in pages[:-1]:
        cell = page.splitlines()[-1].strip("| ").split(" | ")[-1]
        assert len(cell) > 0.6 * rows * 80, (len(cell), page)


def test_r3_document_stamps_hold_together():
    from datetime import UTC, datetime

    at = datetime(2026, 10, 30, 21, 49, tzinfo=UTC)
    assert render_module._format_dt(at, "America/Los_Angeles") == (
        f"Oct{NBSP}30,{NBSP}2026, 2:49{NBSP}PM{NBSP}PDT"
    )


# PR 1300 review round 3, again: every code block is found as CommonMark finds it, not only
# ``` / ~~~ fences: an indented block, a longer fence holding a ``` line, a one-line block
# ("Code: 1 line"); an empty block is dropped, and the line never joins a paragraph.
INDENTED = "Steps to try:\n\n" + "\n".join(f"    step {i} of the rollout" for i in range(1, 41))
MIXED = (
    "The check, fenced with four backticks:\n\n````\n```\nrun the check\n````\n\n"
    "One command:\n~~~\nmake carts\n~~~\nNothing to run:\n\n```\n```\n\nAfter the steps."
)
HREF = "/documents/checkout/v/1#top-risks"


def _code_lines(text: str) -> list[str]:
    return re.findall(r"Code: \d+ lines?, in the full PRD", text)


def test_r3_an_indented_code_block_is_one_line():
    out = deck_module.code_left_out(INDENTED, HREF)
    assert _code_lines(out) == [CODE_LINE], out
    assert "step 7 of the rollout" not in out
    assert deck_module.slide_pages(out) == [out]


def test_r3_every_fence_is_one_line_and_never_joins_a_paragraph():
    out = deck_module.code_left_out(MIXED, HREF)
    assert _code_lines(out) == [
        "Code: 2 lines, in the full PRD",
        "Code: 1 line, in the full PRD",
    ], out
    assert "run the check" not in out and "make carts" not in out and "```" not in out
    assert "Code: 0" not in out
    html = render_module._markdown().render(out)
    paragraphs = re.findall(r"<p>(.*?)</p>", html, re.S)
    assert "One command:" in paragraphs, html
    assert "Nothing to run:" in paragraphs and "After the steps." in paragraphs, html
    assert (
        '<a href="/documents/checkout/v/1#top-risks">Code: 1 line, in the full PRD</a>'
        in paragraphs
    )


async def test_r3_an_indented_code_block_is_one_line_on_its_slide(client, tenant_id):
    h = await _token(tenant_id, "approver")
    assert (await _import(client, h, _draft().replace(RISKS, INDENTED))).status_code == 201
    deck = (await client.get(f"{BASE}/deck", headers=h)).json()
    headings = [s["heading"] for s in deck["slides"]]
    assert "Top risks" in headings and not any(x.startswith("Top risks (") for x in headings)
    _no_code(" ".join(_visible(s["html"]) for s in deck["slides"]))
    risks = next(s for s in deck["slides"] if s["heading"] == "Top risks")
    assert re.search(
        r'<a href="[^"]*/documents/checkout/v/1#s-top-risks">' + CODE_LINE, risks["html"]
    )


# PR 1300 review round 4: a code block that opens on a list item's line is one item, "Code: 1
# line", never a blank bullet nor code; a fence in a list or a quote ends with its item or
# quote; a lone \r is a line break; a line that only looks like a fence ("```a`b") is text.
ON_ITEM = {
    "fence": "- ```\n  ship the carts\n  ```\n- then check",
    "ordered": "1. ```sh\n   ship the carts\n2. then check",
    "indented": "-     ship the carts\n- then check",
}


@pytest.mark.parametrize("body", ON_ITEM.values(), ids=ON_ITEM.keys())
def test_r4_code_on_a_list_item_line_is_one_item(body):
    out = deck_module.code_left_out(body, HREF)
    html = render_module._markdown().render(out)
    items = [re.sub(r"<[^>]+>", "", x).strip() for x in re.findall(r"<li>(.*?)</li>", html, re.S)]
    assert items == ["Code: 1 line, in the full PRD", "then check"], (out, html)
    assert "ship the carts" not in out and "<pre" not in html


def test_r4_a_lone_carriage_return_is_a_line_break():
    out = deck_module.code_left_out("Steps:\r\r```\rship the carts\r```\rAfter.", HREF)
    assert _code_lines(out) == ["Code: 1 line, in the full PRD"], out
    assert "ship the carts" not in out and "\r" not in out
    assert out.startswith("Steps:") and out.endswith("After.")


def test_r4_a_line_that_only_looks_like_a_fence_is_text():
    units = deck_module._units("```a`b\n\nFirst paragraph.\n\nSecond paragraph.")
    assert [u.text for u in units] == ["```a`b", "First paragraph.", "Second paragraph."]


CASES = Path(__file__).parent / "fixtures" / "code_left_out_cases.json"
MOCK = Path(__file__).parents[2] / "web" / "lib" / "api" / "mock" / "code-left-out.ts"
NODE_RUN = (
    "const { codeLeftOut } = await import(process.argv[1]);"
    "let s = ''; process.stdin.on('data', (d) => (s += d));"
    "process.stdin.on('end', () => console.log("
    "JSON.stringify(JSON.parse(s).map((b) => codeLeftOut(b, 'H')))));"
)


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_r4_the_mock_leaves_code_out_as_the_api_does():
    """web/lib/api/mock/code-left-out.ts, run through node, gives what code_left_out gives
    for every case in the shared fixture."""
    cases = json.loads(CASES.read_text(encoding="utf-8"))
    run = subprocess.run(
        ["node", "--input-type=module", "-e", NODE_RUN, MOCK.as_uri()],
        input=json.dumps(cases),
        capture_output=True,
        text=True,
        check=True,
    )
    mock = json.loads(run.stdout)
    wrong = [
        (body, api, got)
        for body, got in zip(cases, mock, strict=True)
        if got != (api := deck_module.code_left_out(body, "H"))
    ]
    assert not wrong, "\n\n".join(f"{b!r}\n api: {a!r}\nmock: {m!r}" for b, a, m in wrong)
