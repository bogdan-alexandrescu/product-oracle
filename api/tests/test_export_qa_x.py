"""Export QA pass X: PRDs and the roadmap are presentable when they leave Oracle.

X-1 the deck footer's banner gives way to the slide number; X-2 a wide table fits the
page; X-7 a share link's PDF footer joins only the parts it prints; X-8 every goal reads
its code and name; X-9 the Sources list prints once, by title; X-10 the page number never
wraps; X-11 the roadmap header names the roadmap, the codes legend shows only with codes;
X-12 a flagged date carries a small plain mark; X-16 a Board deck keeps a horizon's note
with its table; X-17 the markdown export is plain markdown with month-first dates.
Invented data only (tests.test_brief's checkout PRD, tests.test_export_audience's
roadmap).
"""

import re

import pytest

from oracle.export import render as render_module
from tests.baseline_helpers import make_ctx
from tests.test_brief import DRAFT, _import
from tests.test_export_audience import DECK, EXPORT, seed_roadmap
from tests.test_priorities import _token
from tests.test_share_links import PUBLIC, create, opened, token_of

BASE = "/v1/documents/checkout/versions/1"
WIDE = (
    "| Step | Owner | Region | Start | End | Risk | Metric | Target | Notes |\n"
    "|---|---|---|---|---|---|---|---|---|\n"
    + "\n".join(
        f"| Step {i} | Team {i} | Region {i} | Nov {i} | Dec {i} | medium | "
        f"orders_per_returning_buyer_{i} | 12% | a long note that runs on for a while {i} |"
        for i in range(1, 6)
    )
)


def _draft() -> str:
    md = DRAFT.replace(
        "## Goal trace {#goal-trace}\n- Activation: more first orders this quarter.",
        "## Goal trace {#goal-trace}\n- **G2 (retention)**: more repeat orders within 30 days.",
    )
    md = md.replace("| Activation | Less typing |", "| G2 | Less typing |")
    md = md.replace("| Activation | One step to pay |", "| G2 | One step to pay |")
    md = md.replace(
        "Shipping, payment and review on one page.",
        f"Shipping, payment and review on one page. Serves G2.\n\n{WIDE}",
    )
    return md


@pytest.fixture
async def prd(client, tenant_id):
    h = await _token(tenant_id, "approver")
    resp = await _import(client, h, _draft())
    assert resp.status_code == 201, resp.text
    return h


@pytest.fixture
async def ctx():
    from oracle.shares import public as share_public

    share_public.reset_limits()
    return await make_ctx("Example Labs")


def _visible(html: str) -> str:
    html = re.sub(r"<(style|script)[^>]*>.*?</\1>", " ", html, flags=re.S)
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html))


# A goal code standing alone: not followed by its name or a bracketed name.
BARE_G2 = re.compile(r"\bG2\b(?!\s+Retention)(?!\**\s*\()")
BARE_G1 = re.compile(r"\bG1\b(?!\s+Activation)(?!\**\s*\()")


async def test_x1_the_deck_footer_banner_gives_way_to_the_slide_number(client, prd):
    html = (await client.get(f"{BASE}/export?layer=deck&format=html", headers=prd)).text
    banner = re.search(r"\.deck \.slide-banner \{([^}]*)\}", html).group(1)
    for rule in ("flex: 1 1 auto", "min-width: 0", "white-space: nowrap", "ellipsis"):
        assert rule in banner, banner
    number = re.search(r"\.deck \.slide-number \{([^}]*)\}", html).group(1)
    assert "flex: none" in number and "white-space: nowrap" in number


async def test_x2_a_wide_table_fits_the_page(client, prd):
    html = (await client.get(f"{BASE}/export?format=html", headers=prd)).text
    assert "table-layout: fixed" in html and "overflow-wrap: anywhere" in html
    # A table of many columns is marked for a smaller font; a narrow one is not.
    assert len(re.findall(r'<table class="table-wide"', html)) == 1, html.count("<table")
    assert "table.table-wide" in html


async def test_x8_x9_goals_carry_names_and_sources_print_once_by_title(client, prd):
    for q in ("format=html", "layer=brief&format=html"):
        html = (await client.get(f"{BASE}/export?{q}", headers=prd)).text
        text = _visible(html)
        assert "G2 Retention" in text, q
        assert not BARE_G2.search(text), (
            q,
            [text[m.start() - 30 : m.end() + 30] for m in BARE_G2.finditer(text)],
        )
        # X-9: one Sources list, by title: no citation ids, source kinds or raw refs.
        assert text.count("Drop-off thread") == 1, q
        assert "c1 slack" not in text and "src-kind" not in html, q
        assert "example.slack.com" not in text, q
    deck = (await client.get(f"{BASE}/deck", headers=prd)).json()
    slides = " ".join(_visible(s["html"]) for s in deck["slides"])
    assert "G2 Retention" in slides and not BARE_G2.search(slides)


async def test_x8_roadmap_goals_read_code_and_name(client, ctx):
    await seed_roadmap(ctx)
    for audience in ("team", "engineering"):
        resp = await client.get(
            EXPORT, params={"format": "html", "audience": audience}, headers=ctx.as_("viewer")
        )
        text = _visible(resp.text).replace("G1, G2 … goal codes", "")
        assert "G1 Activation" in text, audience
        assert not BARE_G1.search(text), (
            audience,
            [text[m.start() - 30 : m.end() + 30] for m in BARE_G1.finditer(text)],
        )
        # Never the name alone where the code is known.
        assert "Goal: Activation" not in text, audience


async def test_x11_the_roadmap_header_names_the_roadmap(client, ctx):
    await seed_roadmap(ctx)
    for audience in ("team", "board"):
        resp = await client.get(
            EXPORT, params={"format": "html", "audience": audience}, headers=ctx.as_("viewer")
        )
        text = _visible(resp.text)
        assert "example-labs-roadmap" not in text and "(ROADMAP)" not in text, audience
    # Board prints goal names alone, so its legend does not explain codes.
    board = await client.get(
        EXPORT, params={"format": "html", "audience": "board"}, headers=ctx.as_("viewer")
    )
    if re.search(r"\bG\d\b", _visible(board.text).replace("G1, G2 … goal codes", "")) is None:
        assert "goal codes" not in board.text


async def test_x7_x10_the_share_link_pdf_footer_prints_only_its_parts(client, ctx, monkeypatch):
    from oracle.shares import render as share_render

    seen: list[str] = []

    def capture(html: str) -> bytes:
        seen.append(html)
        return b"%PDF-1.7 "

    monkeypatch.setattr(share_render, "html_to_pdf", capture)
    await seed_roadmap(ctx, publish=True)
    token = token_of((await create(client, ctx, "owner")).json())
    cookie = await opened(client, token)
    resp = await client.get(f"{PUBLIC}/{token}/pdf", headers=cookie)
    assert resp.status_code == 200, resp.text
    html = seen[-1]
    # The footer joins strings that carry their own separator, never fixed dots.
    assert 'string(doc-title) " \\00B7' not in html
    left = re.findall(r"@bottom-left \{([^}]*)\}", html)
    right = re.findall(r"@bottom-right \{([^}]*)\}", html)
    assert left and all("white-space: nowrap" in b for b in left)
    assert right and all("white-space: nowrap" in b for b in right)
    # A link holder sees no version or status: the carrier holds the title alone.
    carrier = re.search(r'<div class="doc-strings".*?</div>', html, re.S).group(0)
    assert "Version" not in carrier and "·" not in _visible(carrier)
    assert "Example Labs roadmap" in carrier


async def test_x7_x10_an_internal_pdf_footer_joins_version_and_status(client, prd):
    html = (await client.get(f"{BASE}/export?format=html", headers=prd)).text
    assert 'string(doc-title) " \\00B7' not in html
    # The separator rides on the version and status, which an internal export prints.
    assert 'string-set: doc-version " \\00B7  " content(text)' in html
    assert 'string-set: doc-status " \\00B7  " content(text)' in html
    assert re.search(r'class="banner-footer-title"[^>]*>Checkout PRD<', html)
    left = re.findall(r"@bottom-left \{([^}]*)\}", html)
    assert left and all("white-space: nowrap" in b for b in left)


def test_x12_a_flagged_date_is_a_small_plain_mark():
    html = (
        "<p>Beta on Nov 20, 2026 <strong>[unverified]</strong> and GA "
        "<strong>[date withdrawn]</strong></p>"
    )
    out = render_module.date_marks(html)
    assert "[unverified]" not in out and "<strong>" not in out
    assert '<span class="date-mark" data-date-mark="unverified">unverified</span>' in out
    assert '<span class="date-mark" data-date-mark="withdrawn">date withdrawn</span>' in out


async def test_x16_a_board_deck_keeps_a_horizon_note_with_its_table(client, ctx):
    await seed_roadmap(ctx)
    deck = (await client.get(DECK, params={"audience": "board"}, headers=ctx.as_("viewer"))).json()
    for s in deck["slides"][1:]:
        body = _visible(s["html"])
        if "left out" in body:
            assert "<table" in s["html"], s["heading"]


async def test_x17_the_markdown_export_is_plain_markdown(client, prd):
    md = (await client.get(f"{BASE}/export?format=md", headers=prd)).text
    assert "<!-- Product Oracle export" not in md
    body = md.split("\n---\n", 1)[1]
    assert not re.search(r"\b\d{4}-\d{2}-\d{2}\b", body), re.findall(r"\d{4}-\d{2}-\d{2}", body)
    assert "Nov 1, 2026" in body
    # The import needs the front matter and the section ids (oracle.docs.parser), so the
    # file still imports: they stay.
    assert md.startswith("---\n") and "{#summary}" in md


async def test_x8_x9_the_pptx_names_goals_and_sources_by_title(client, prd):
    from tests.test_export_visual_e import _pptx_texts

    resp = await client.get(f"{BASE}/export?layer=deck&format=pptx", headers=prd)
    texts = " ".join(t for ts in _pptx_texts(resp.content) for t in ts)
    assert "G2 Retention" in texts and not BARE_G2.search(texts)
    assert "Drop-off thread" in texts and "slack" not in texts and "notion" not in texts


def test_x12_the_pptx_mark_is_a_plain_word():
    from oracle.export import pptx as pptx_module

    blocks = pptx_module.parse_blocks("Beta on Nov 20, 2026 **[unverified]**.")
    runs = [r for b in blocks.items for r in getattr(b, "runs", [])]
    marks = [r for r in runs if "unverified" in r.text]
    assert marks and all(r.text == "unverified" and not r.bold for r in marks), runs


GOALS = {"G1": "Activation", "G2": "Retention"}


@pytest.mark.parametrize(
    "text",
    [
        "[dash](https://example.com/d?goal=G1)",
        "<https://example.com/d?goal=G1>",
        "See https://example.com/d?goal=G1 for more.",
        "[dash]: https://example.com/d?goal=G1",
        "Run `G1` or ``G2 only``.",
        "```\nG1 and G2\n```\n",
        "~~~\nG1\n~~~\n",
        '<a href="https://example.com/d?goal=G1">dash</a>',
        "Kept in docs/G1/G2.",
    ],
)
def test_x8_goal_names_leave_links_and_code_alone(text):
    assert render_module.with_goal_names(text, GOALS) == text


def test_x8_goal_names_name_prose_beside_links_and_each_code_of_a_pair():
    w = render_module.with_goal_names
    assert w("[G1 dash](https://example.com/d?goal=G1)", GOALS) == (
        "[G1 Activation dash](https://example.com/d?goal=G1)"
    )
    assert w("Serves G1/G2.", GOALS) == "Serves G1 Activation/G2 Retention."
    assert w("`G1` then G1.", GOALS) == "`G1` then G1 Activation."


DATED_LINKS = (
    "See [report](https://example.com/a?from=2026-01-02), "
    "<https://example.com/b?to=2026-02-03> and https://example.com/c?on=2026-03-04. "
    "Due 2026-11-01."
)


@pytest.mark.parametrize(
    "text",
    [
        "[report](https://example.com/a?from=2026-01-02)",
        "[report]: https://example.com/a?from=2026-01-02",
        "<https://example.com/b?to=2026-02-03>",
        "Open https://example.com/c?on=2026-03-04 today.",
        "<!-- checked 2026-04-05 -->",
        "Run `2026-05-06`.",
    ],
)
def test_x17_markdown_days_leave_links_comments_and_code_alone(text):
    assert render_module._days_in_plain_words(text) == text


async def test_x17_a_url_with_a_date_round_trips_through_export_and_import(client, prd):
    md = _draft().replace("Shipping, payment and review on one page.", DATED_LINKS)
    assert (await _import(client, prd, md)).status_code == 201
    exported = (
        await client.get("/v1/documents/checkout/versions/2/export?format=md", headers=prd)
    ).text
    for url in (
        "](https://example.com/a?from=2026-01-02)",
        "<https://example.com/b?to=2026-02-03>",
        "https://example.com/c?on=2026-03-04.",
    ):
        assert url in exported, exported
    assert "Due Nov 1, 2026." in exported
    resp = await _import(client, prd, exported)
    assert resp.status_code == 201, resp.text
    v = (await client.get("/v1/documents/checkout/versions/3", headers=prd)).json()
    body = "\n".join(s["body_md"] or "" for s in v["sections"])
    assert "[report](https://example.com/a?from=2026-01-02)" in body
    assert "<https://example.com/b?to=2026-02-03>" in body
    assert "https://example.com/c?on=2026-03-04." in body
