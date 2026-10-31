"""qa4-docs-share-5: on a phone the shared roadmap's theme cards stack in one column.

protects=the built-in roadmap-board theme carries a screen-only narrow-width rule that
turns its three-column card grid into one column (and a full-width goal group stops
spanning three columns there), and the link holder's reader styles carry the same rule so
a company's copy of the theme seeded before it stacks too; fails_when=either rule is
missing, applies to print (the PDF), or leaves the grid at three columns;
no_claim=how a browser lays the page out (web/e2e/qa4-docs-share-links.spec.ts).
"""

import re

from oracle.shares.render import READER_CSS, for_reader
from oracle.templates.builtins import BUILTIN_DIR

BOARD = BUILTIN_DIR / "themes" / "roadmap-board.css"


def _narrow_blocks(css: str) -> list[str]:
    """The bodies of every @media block limited to a max width of 640px or less."""
    out = []
    for m in re.finditer(r"@media([^{]*)\{", css):
        query = m.group(1)
        width = re.search(r"max-width:\s*(\d+)px", query)
        if not width or int(width.group(1)) > 640:
            continue
        depth, i = 1, m.end()
        while depth and i < len(css):
            depth += {"{": 1, "}": -1}.get(css[i], 0)
            i += 1
        out.append((query, css[m.end() : i - 1]))
    return out


def _stacks(body: str) -> bool:
    grid = re.search(r"\.group-body\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)", body)
    wide = re.search(r"\.section-wide\s*\{[^}]*grid-column:\s*auto", body)
    return bool(grid and wide)


def test_the_board_theme_stacks_its_cards_on_a_phone_screen():
    css = BOARD.read_text("utf-8")
    blocks = [(q, b) for q, b in _narrow_blocks(css) if _stacks(b)]
    assert blocks, "roadmap-board.css has no narrow-screen rule stacking its cards"
    # Screen only: the PDF (print, landscape pages) keeps the three-column board.
    assert all("screen" in q and "print" not in q for q, _ in blocks)
    # The board itself is still three columns wide.
    assert re.search(r"grid-template-columns:\s*repeat\(3,", css)


def test_the_link_holders_page_stacks_an_older_theme_copy_too():
    assert any(_stacks(b) for _, b in _narrow_blocks(READER_CSS))
    page = for_reader("<html><head><style>.x{}</style></head><body></body></html>")
    assert "grid-template-columns:minmax(0,1fr)" in page
