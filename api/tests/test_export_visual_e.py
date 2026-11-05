"""Visual QA pass E: PRD exports and Present mode.

E-6 no export shows an ISO date (the snapshot reads month first); E-8 a long title fits
the PPTX title slide and the footer stays on the slide; E-9 an overlong brief section goes
on continuation slides, never past the slide's edge; E-11 dates in brief text read month
first on slides; E-12 a goal in the items table carries its name; E-15 the no-brief
refusal names the PRD by its title.
"""

import io
import re

import pytest
from pptx import Presentation
from pptx.util import Pt
from pypdf import PdfReader

from oracle.export import pptx as pptx_module
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
    seen["pptx"] = " ".join(t for ts in _pptx_texts(pptx.content) for t in ts)
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
