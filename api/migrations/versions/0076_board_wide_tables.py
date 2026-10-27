"""Board's goal tables span the roadmap-board card grid (train O5 follow-up)

The built-in roadmap-board theme gains a rule spanning a goal group that holds an
audience's item table (``section-wide``) across the card grid, without the card's side
frame. A company's copy of the theme still exactly as seeded takes the new CSS; a copy
an owner edited is left alone (its CSS is theirs).

Live-safe: one UPDATE of unedited rows. The downgrade restores the old CSS on rows still
holding the new one.

Revision ID: 0076_board_wide_tables
Revises: 0075_live_tokens
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0076_board_wide_tables"
down_revision: str | None = "0075_live_tokens"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Frozen copies: the packaged file changes with later work, this step does not.
OLD_CSS = (
    "/* Roadmap board: landscape pages, the as-of header and legend repeate"
    "d on every\n"
    "   PDF page, horizon sections laid out as columns of cards that never "
    "split. */\n"
    ".section-group > .group-body { display: grid; grid-template-columns: r"
    "epeat(3, minmax(0, 1fr)); gap: 0.6rem; }\n"
    ".section-group > .group-body > .prd-section {\n"
    "  margin: 0;\n"
    "  padding: 0.45rem 0.6rem;\n"
    "  border: 1px solid var(--color-rule);\n"
    "  border-top: 3px solid var(--color-accent);\n"
    "  border-radius: 4px;\n"
    "  break-inside: avoid;\n"
    "}\n"
    ".section-group > .group-body > .prd-section > h3 { margin-top: 0; font"
    "-size: 1em; }\n"
    ".section-group > .group-body > .flag-no-goal { border: 2px solid #b423"
    "18; }\n"
    '.prd-section[data-section-key="now"] > h2::after { content: "  high co'
    'nfidence ●●●"; font-size: 0.6em; color: var(--color-muted); }\n'
    '.prd-section[data-section-key="next"] > h2::after { content: "  medium'
    ' ●●○"; font-size: 0.6em; color: var(--color-muted); }\n'
    '.prd-section[data-section-key="later"] > h2::after { content: "  low ●'
    '○○"; font-size: 0.6em; color: var(--color-muted); }\n'
    "@media print {\n"
    "  .doc-header { position: running(docheader); margin: 0; }\n"
    "  @page { @top-center { content: element(docheader); width: 100%; } ma"
    "rgin-top: 30mm; }\n"
    "}\n"
)
NEW_CSS = (
    "/* Roadmap board: landscape pages, the as-of header and legend repeate"
    "d on every\n"
    "   PDF page, horizon sections laid out as columns of cards that never "
    "split. */\n"
    ".section-group > .group-body { display: grid; grid-template-columns: r"
    "epeat(3, minmax(0, 1fr)); gap: 0.6rem; }\n"
    ".section-group > .group-body > .prd-section {\n"
    "  margin: 0;\n"
    "  padding: 0.45rem 0.6rem;\n"
    "  border: 1px solid var(--color-rule);\n"
    "  border-top: 3px solid var(--color-accent);\n"
    "  border-radius: 4px;\n"
    "  break-inside: avoid;\n"
    "}\n"
    ".section-group > .group-body > .prd-section > h3 { margin-top: 0; font"
    "-size: 1em; }\n"
    "/* A goal group holding an audience's item table (Board's) spans the r"
    "ow, framed by its\n"
    "   accent rule only: side padding and a side border beside the table's"
    " own rules read as\n"
    "   an empty extra column. It spans the three columns by count: WeasyPr"
    "int (the PDF) places\n"
    "   a negative line number such as 1 / -1 wrongly. */\n"
    ".section-group > .group-body > .section-wide { grid-column: 1 / span 3"
    "; padding: 0.45rem 0 0; border: none; border-top: 3px solid var(--colo"
    "r-accent); border-radius: 0; }\n"
    ".section-group > .group-body > .flag-no-goal { border: 2px solid #b423"
    "18; }\n"
    '.prd-section[data-section-key="now"] > h2::after { content: "  high co'
    'nfidence ●●●"; font-size: 0.6em; color: var(--color-muted); }\n'
    '.prd-section[data-section-key="next"] > h2::after { content: "  medium'
    ' ●●○"; font-size: 0.6em; color: var(--color-muted); }\n'
    '.prd-section[data-section-key="later"] > h2::after { content: "  low ●'
    '○○"; font-size: 0.6em; color: var(--color-muted); }\n'
    "@media print {\n"
    "  .doc-header { position: running(docheader); margin: 0; }\n"
    "  @page { @top-center { content: element(docheader); width: 100%; } ma"
    "rgin-top: 30mm; }\n"
    "}\n"
)

_SWAP = sa.text(
    "UPDATE themes SET css = :to WHERE key = 'roadmap-board' AND builtin AND css = :from_"
)


def upgrade() -> None:
    op.execute(_SWAP.bindparams(to=NEW_CSS, from_=OLD_CSS))


def downgrade() -> None:
    op.execute(_SWAP.bindparams(to=OLD_CSS, from_=NEW_CSS))
