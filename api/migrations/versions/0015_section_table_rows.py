"""Section body_text keeps table rows (follow-up fix: tables in the version diff)

Data only. ``sections.body_text`` used to put every table cell on its own line, so the
version diff could not rebuild a table. The parser now writes one line per row, cells
joined by ``" | "`` (header first, separator row dropped, a literal ``|`` in a cell kept
as ``\\|``). This recomputes ``body_text`` of the stored sections that have a table, so a
diff between a version imported before the fix and one imported after it compares rows
with rows instead of showing the whole table as rewritten. ``body_md`` and
``content_hash`` are untouched.

The text logic is a frozen copy of ``oracle.docs.parser.body_text`` at this revision
(old and new table handling), so later parser changes do not change what this migration
does. The downgrade writes the old cell-per-line text back.

Revision ID: 0015_section_table_rows
Revises: 0014_trace
"""

import re
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from markdown_it import MarkdownIt
from markdown_it.token import Token

revision: str = "0015_section_table_rows"
down_revision: str | None = "0014_trace"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_CITATION_STRIP_RE = re.compile(r"[ \t]*\[c:[^\]\s]+\]")
_md = MarkdownIt("commonmark", {"html": False}).enable("table")


def _inline_text(token: Token) -> str:
    out: list[str] = []
    for child in token.children or []:
        if child.type in ("text", "code_inline"):
            out.append(child.content)
        elif child.type in ("softbreak", "hardbreak"):
            out.append("\n")
        elif child.type == "image":
            out.append(_inline_text(child))
    return "".join(out)


def _body_text(body_md: str, rows: bool) -> str:
    blocks: list[str] = []
    row: list[str] | None = None
    for token in _md.parse(body_md):
        if rows and token.type == "tr_open":
            row = []
            continue
        if rows and token.type == "tr_close":
            if row is not None and any(row):
                blocks.append(" | ".join(row))
            row = None
            continue
        if token.type == "inline":
            text = _inline_text(token)
        elif token.type in ("fence", "code_block"):
            text = token.content.rstrip("\n")
        else:
            continue
        text = _CITATION_STRIP_RE.sub("", text).strip()
        if row is not None:
            row.append(text.replace("|", "\\|"))
        elif text:
            blocks.append(text)
    return "\n".join(blocks)


def _has_table(body_md: str) -> bool:
    return any(t.type == "table_open" for t in _md.parse(body_md))


def _rewrite(rows: bool) -> None:
    conn = op.get_bind()
    # Every table row has a pipe; the parse below drops the rest of the candidates.
    candidates = conn.execute(
        sa.text("SELECT id, body_md, body_text FROM sections WHERE body_md LIKE '%|%'")
    )
    update = sa.text("UPDATE sections SET body_text = :body_text WHERE id = :id")
    for section_id, body_md, old in candidates.all():
        if not _has_table(body_md):
            continue
        new = _body_text(body_md, rows)
        if new != old:
            conn.execute(update, {"id": section_id, "body_text": new})


def upgrade() -> None:
    _rewrite(rows=True)


def downgrade() -> None:
    _rewrite(rows=False)
