"""Board's goal tables span the card board (train O5 follow-up): under a horizon, each
goal group holding Board's item table is marked full width (``section-wide``) where the
themed export builds the group, and every built-in theme that lays a horizon's sections
out as a grid of cards spans it (``grid-column: 1 / -1``), in the HTML and in the PDF
(WeasyPrint lays out the same HTML). Ordinary item cards keep the three-column board.

The "empty fifth column" seen beside a goal table was the card frame, not a cell: the
table's right rule, the card's side padding and the card's own rule (the same colour)
read as a narrow headerless column. A full-width goal section draws no side frame.
"""

import os
import re
from pathlib import Path

import pytest

from oracle.export import pdf
from oracle.shares import public as share_public
from tests.baseline_helpers import make_ctx
from tests.test_board_goal_groups import add_goal_links
from tests.test_export_audience import EXPORT, seed_roadmap

THEMES = Path(__file__).parents[1] / "oracle" / "templates" / "builtin" / "themes"

requires_pdf = pytest.mark.skipif(
    not os.environ.get("ORACLE_REQUIRE_PDF") and not pdf.pdf_available(),
    reason="WeasyPrint's system libraries are not installed",
)


@pytest.fixture
async def ctx():
    share_public.reset_limits()
    return await make_ctx("Example Labs")


async def two_goal_roadmap(ctx) -> None:
    """The Now horizon's two served items in two goals (Activation, Retention)."""
    await seed_roadmap(ctx, served=())
    await add_goal_links(
        ctx, {"csv-parser": [("Activation", 2)], "bulk-import": [("Retention", 2)]}
    )


async def render(client, ctx, audience: str) -> str:
    resp = await client.get(EXPORT, params={"audience": audience}, headers=ctx.as_("viewer"))
    assert resp.status_code == 200, resp.text
    return resp.text


def sections(html: str) -> dict[str, tuple[set[str], str]]:
    """Each body section's key: its classes and its markup (to the next section)."""
    main = html[html.index("<main") :]
    out = {}
    for m in re.finditer(
        r'<section id="[^"]*" class="([^"]*)" data-section-key="([^"]*)">(.*?)</section>',
        main,
        re.S,
    ):
        out[m.group(2)] = (set(m.group(1).split()), m.group(3))
    return out


def grid_themes() -> list[Path]:
    return [p for p in sorted(THEMES.glob("*.css")) if ".group-body" in p.read_text()]


async def test_board_goal_tables_are_marked_full_width_and_the_theme_spans_them(client, ctx):
    """protects=Board's goal groups (a section holding its item table) carry the
    full-width mark and the roadmap-board theme spans it across the card grid with no
    side frame; fails_when=a goal table is laid out as one card column again, the theme
    loses the rule, or the mark lands on another section; no_claim=the measured width
    (the PDF and Playwright checks)."""
    await two_goal_roadmap(ctx)
    html = await render(client, ctx, "board")
    assert "theme-roadmap-board" in html
    found = sections(html)
    groups = {k: v for k, v in found.items() if "<table>" in v[1]}
    assert sorted(groups) == ["now-group-1", "now-group-2"], sorted(found)
    assert all("section-wide" in classes for classes, _ in groups.values()), groups
    assert [k for k, (c, _) in found.items() if "section-wide" in c] == sorted(groups)
    rule = re.search(r"\.section-wide\s*\{([^}]*)\}", html)
    assert rule and re.search(r"grid-column:\s*1\s*/\s*-1", rule.group(1)), "theme rule"


@pytest.mark.parametrize("audience", ["team", "engineering"])
async def test_ordinary_item_cards_keep_the_card_board(client, ctx, audience):
    """protects=Team's and Engineering's item cards (and Team's goal headings, which hold
    no table) stay cards in the three-column board; fails_when=any of their sections is
    marked full width; no_claim=Board."""
    await two_goal_roadmap(ctx)
    found = sections(await render(client, ctx, audience))
    assert "now-csv-parser" in found and "now-bulk-import" in found, sorted(found)
    assert not [k for k, (c, _) in found.items() if "section-wide" in c]


def test_every_built_in_grid_theme_spans_a_wide_section_and_others_are_unchanged():
    """protects=each built-in theme laying a horizon's sections out as a card grid spans a
    full-width section across it with no side frame; themes without a card grid carry no
    such rule; fails_when=a grid theme lacks the rule or a non-grid theme gains one;
    no_claim=company themes (their own CSS)."""
    grid = grid_themes()
    assert [p.stem for p in grid] == ["roadmap-board"]
    for path in sorted(THEMES.glob("*.css")):
        css = path.read_text()
        rule = re.search(r"\.group-body\s*>\s*\.section-wide\s*\{([^}]*)\}", css)
        if path in grid:
            assert rule, path.name
            assert re.search(r"grid-column:\s*1\s*/\s*-1", rule.group(1)), path.name
            assert re.search(r"padding-(?:left|right):\s*0|padding:\s*[^;]*\b0\b", rule.group(1))
        else:
            assert "section-wide" not in css, path.name


async def test_the_rebuilt_board_table_has_as_many_cells_per_row_as_header_cells(client, ctx):
    """protects=the empty fifth column is not a cell: every row of each rebuilt Board
    table has exactly as many cells as its header (Item, Outcome, Confidence, Goal);
    fails_when=a rebuilt row leaves an extra (or a missing) cell; no_claim=the card frame
    beside the table (the theme test above)."""
    await two_goal_roadmap(ctx)
    for _, body in sections(await render(client, ctx, "board")).values():
        for table in re.findall(r"<table>.*?</table>", body, re.S):
            rows = re.findall(r"<tr>(.*?)</tr>", table, re.S)
            head = re.findall(r"<th[ >]", rows[0])
            assert len(head) == 4, table
            for row in rows[1:]:
                assert len(re.findall(r"<td[ >]", row)) == len(head), table


def _tables(box, section=None, out=None) -> list:
    """Each table box on a page with the section box it sits in."""
    out = [] if out is None else out
    if getattr(box, "element_tag", "") == "section":
        section = box
    if type(box).__name__ == "TableBox" and section is not None:
        out.append((section, box))
    for child in getattr(box, "children", []):
        _tables(child, section, out)
    return out


def _main(box):
    if getattr(box, "element_tag", "") == "main":
        return box
    return next((m for c in getattr(box, "children", []) if (m := _main(c)) is not None), None)


@requires_pdf
async def test_the_board_pdf_table_spans_the_text_width(client, ctx):
    """protects=in the Board PDF each goal table spans at least 90% of the text width and
    ends at its section's edge (no strip of card frame beside it); fails_when=the PDF lays a
    goal table out as one card column, or draws the frame beside it;
    no_claim=the HTML preview (the Playwright spec). The geometry is read from the
    WeasyPrint document html_to_pdf writes: pypdf, the repo's PDF reader, holds no layout."""
    await two_goal_roadmap(ctx)
    html = await render(client, ctx, "board")
    resp = await client.get(
        EXPORT, params={"audience": "board", "format": "pdf"}, headers=ctx.as_("viewer")
    )
    assert resp.status_code == 200 and resp.content.startswith(b"%PDF")
    document = pdf._document(html)
    tables = []
    for page in document.pages:
        main = _main(page._page_box)
        tables += [(main, s, t) for s, t in _tables(page._page_box) if main is not None]
    assert len(tables) == 2, tables
    for main, section, table in tables:
        assert table.margin_width() >= 0.9 * main.width, (table.margin_width(), main.width)
        section_right = section.position_x + section.margin_width()
        table_right = table.position_x + table.margin_width()
        assert section_right - table_right < 2, (section_right, table_right)
