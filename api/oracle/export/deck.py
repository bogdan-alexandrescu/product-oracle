"""The brief layer as slides (O1f): Present mode in the app, the deck PDF and the PPTX.

One slide per brief section, in document order, after a title slide that carries the
version banner; Sources and data points slides close the deck when the version has
sources. Each section slide carries its presenter notes (only a fenced ``notes`` block,
O1g; none without one) and, for every detail section its body links to with
``[text](#section-id)`` (feature rows, milestones), that section and its sub-sections
rendered for the Expand overlay.

Slides are laid out at 960 x 540 CSS px (10 x 5.625 in, 16:9) with the document's
theme: its tokens as CSS variables, the shared slide stylesheet, and the slide variant
of a built-in theme (``templates/builtin/themes/slides/<key>.css``). A company theme
gets the shared slide layout in its own colours and fonts, then its own slide CSS
(``themes.slide_css``, O1g) when it has one. The PPTX uses the tokens only.
"""

import re
from dataclasses import dataclass, field
from functools import cache
from pathlib import Path

from markdown_it import MarkdownIt
from markupsafe import Markup, escape

from oracle import company_time
from oracle.branding import BRAND_CSS, render_brand_logo
from oracle.docs import layers
from oracle.docs.models import Section
from oracle.docs.parser import strip_citations
from oracle.export.render import (
    _HEADING_ID,
    STATIC,
    ExportVersion,
    _decorate,
    _format_dt,
    _jinja,
    _themed_markdown,
    absolute_doc_links,
    brand_dark,
    days_in_words,
    held_together,
    section_body_html,
    snapshot_in_words,
    sources_keys,
    token_vars,
    unlink_missing,
)
from oracle.templates import validation
from oracle.templates.models import Theme

SLIDE_VARIANTS = Path(__file__).resolve().parents[1] / "templates" / "builtin" / "themes" / "slides"
SOURCES_PER_SLIDE = 8
# Past these, a slide's type is set smaller so the section still fits.
DENSE_CHARS = 520
DENSE_ROWS = 6
# A slide holds about this many lines of its smaller (dense) type below its title, in the
# PPTX (16 pt across 11.7 in, 5.4 in high) and the HTML deck (17 px across 840 px, 394 px
# high), whichever is tighter; a section past it goes on continuation slides ("Top risks
# (2 of 2)", visual QA E-9), never past the slide's edge or clipped.
SLIDE_LINES = 15
LINE_CHARS = 95


@dataclass
class ExpandItem:
    """A detail section (with its sub-sections) a slide links to, for the overlay."""

    section_key: str
    heading: str
    html: Markup


@dataclass
class Slide:
    index: int  # 1-based
    kind: str  # title | section | sources
    heading: str
    body_md: str = ""
    section_key: str | None = None
    notes: str | None = None
    body_html: Markup = Markup("")
    html: Markup = Markup("")
    expand: list[ExpandItem] = field(default_factory=list)
    # Sources slides: (number, title, kind, retrieved) rows.
    sources: list[tuple[int, str, str, str]] = field(default_factory=list)
    dense: bool = False
    # E1: a spec's state label for the slide (the PPTX shows it as a styled run; the
    # HTML has it in body_html) and its kind ("decided", "proposed" or "added").
    state: str | None = None
    state_kind: str | None = None


@dataclass
class Deck:
    title: str
    slug: str
    number: int
    latest_number: int
    status: str
    as_of: str
    banner: str
    theme_key: str | None
    theme_name: str | None
    tokens: dict
    css: Markup
    slides: list[Slide]
    # Provenance (O4b): "From <PRD title> v<n>".
    source_label: str | None = None
    # O5: the company's name and logo on the title slide (and the PPTX's).
    brand_name: str | None = None
    brand_logo: Markup = Markup("")
    brand_logo_png: bytes | None = None
    brand_logo_size: tuple[int, int] | None = None
    # The title slide's kicker: what kind of document this is (qa-docs-63), not "Brief".
    kicker: str = "Brief"


# The title slide's kicker per document kind (qa-docs-63).
KICKER = {
    "prd": "PRD",
    "roadmap": "Roadmap",
    "spec": "Spec",
    "vision": "Vision",
    "strategy": "Strategy",
    "update": "Update",
    "pricing": "Pricing memo",
}


@cache
def slide_stylesheet() -> str:
    return (STATIC / "slides.css").read_text(encoding="utf-8")


def slide_variant_css(theme_key: str | None, builtin: bool) -> str:
    """The slide variant of a built-in theme; empty for company themes."""
    if not theme_key or not builtin:
        return ""
    path = SLIDE_VARIANTS / f"{theme_key}.css"
    return path.read_text(encoding="utf-8") if path.is_file() else ""


def company_slide_css(theme: Theme | None) -> str:
    """A company theme's own slide CSS (O1g), checked like its CSS when saved; left
    out if it would not pass the check now. Built-in themes use their variant."""
    if theme is None or theme.builtin or not theme.slide_css:
        return ""
    return "" if validation.check_slide_css(theme.slide_css) else theme.slide_css


def _plain_heading(s: Section) -> str:
    return _HEADING_ID.sub("", s.heading).strip()


def _render_md(md_text: str, present: set[str]) -> Markup:
    md = _themed_markdown(False)
    html = md.render(strip_citations(md_text), {"numbers": {}})
    return Markup(_mark_expand(absolute_doc_links(unlink_missing(_decorate(html), present))))


_DETAIL_REF = re.compile(r'<span class="detail-ref" data-section-ref="([^"]+)">(.*?)</span>', re.S)


def _mark_expand(html: str) -> str:
    """Detail links become Expand controls (the overlay shows that section)."""
    return _DETAIL_REF.sub(
        lambda m: (
            f'<span class="detail-ref" data-section-ref="{m.group(1)}">{m.group(2)}</span>'
            f'<button type="button" class="expand" data-expand="{m.group(1)}" '
            f'aria-label="Expand {escape(re.sub(r"<[^>]+>", "", m.group(2)))}">Expand</button>'
        ),
        html,
    )


def _moment(value, zone: str) -> str:
    """A moment in the Company time zone in words: "Oct 18, 2026, 1:30 AM PDT" (a slide is
    read by people, not parsed: no ISO date; the year, as a deck outlives its quarter)."""
    words = company_time.in_words(value, zone)
    # in_words leads with the weekday ("Sun Oct 18, 1:30 AM PDT"); a footer needs only the
    # day, with its year.
    day, time = words.split(" ", 1)[1].split(", ", 1)
    year = company_time.day(value, zone).year
    # Each part held on one line (E-11): "Oct 18, 2026," then "1:30 AM PDT".
    return f"{held_together(f'{day}, {year}')}, {held_together(time)}"


def _banner(ev: ExportVersion) -> str:
    status = ev.status.replace("_", " ")
    parts = [ev.title, f"Version {ev.version.number}", status[:1].upper() + status[1:]]
    if ev.audience_label:
        parts.insert(2, f"Audience {ev.audience_label}")
    if ev.version.approved_at is not None:
        parts.append(f"Approved {_moment(ev.version.approved_at, ev.zone)}")
    else:
        parts.append(f"Imported {_moment(ev.version.created_at, ev.zone)}")
    if ev.source_label:
        parts.append(ev.source_label)
    return " · ".join(parts)


_FENCE = re.compile(r"^\s*(`{3,}|~{3,})(.*)$")
_ITEM = re.compile(r"^(?:[-*+]|\d{1,3}[.)])\s")
_TABLE_SEP = re.compile(r"^\s*\|?\s*:?-{2,}")


def _fence_close(line: str) -> re.Pattern | None:
    """What closes the fence ``line`` opens, as CommonMark reads a fence (a backtick fence's
    info has no backtick); None if it opens none."""
    m = _FENCE.match(line)
    if not m or (m.group(1)[0] == "`" and "`" in m.group(2)):
        return None
    return re.compile(rf"^\s*{re.escape(m.group(1)[0])}{{{len(m.group(1))},}}\s*$")


@dataclass
class _Unit:
    """A piece of a slide body kept on one slide: a paragraph, a top-level list item (with
    its sub-items), a table row; a heading goes with what follows. A paragraph, item or row
    longer than a slide is cut into pieces that each fit. A deck shows no code
    (:func:`code_left_out`)."""

    text: str
    cost: float
    group: int
    kind: str  # block | item | row
    header: str = ""  # a row's table header and separator, repeated on a continuation
    # A piece of a unit too long for one slide, after the piece before it: what joins them
    # when both land on one slide (" " within a line, "\n" between lines); "" otherwise.
    glue: str = ""


def _lines(text: str, chars: int = LINE_CHARS) -> float:
    text = strip_citations(re.sub(r"\]\([^)]*\)", "]", text))
    return sum(max(1, -(-len(line.strip()) // chars)) for line in text.splitlines() if line.strip())


def _units(body: str, budget: float = SLIDE_LINES) -> list[_Unit]:
    units: list[_Unit] = []
    group = 0
    lines = body.splitlines()
    i = 0
    heading = ""
    while i < len(lines):
        line = lines[i]
        if not line.strip():
            group += 1
            i += 1
            continue
        if close := _fence_close(line):
            j = i + 1
            while j < len(lines) and not close.match(lines[j]):
                j += 1
            block = lines[i : j + 1]
            units.append(_Unit(heading + "\n".join(block), len(block) + 0.4, group, "block"))
            heading = ""
            i = j + 1
            group += 1
            continue
        if line.lstrip().startswith("#"):
            heading += line + "\n\n"
            i += 1
            group += 1
            continue
        if line.lstrip().startswith("|"):
            j = i
            while j < len(lines) and lines[j].lstrip().startswith("|"):
                j += 1
            rows = lines[i:j]
            head = rows[:2] if len(rows) > 1 and _TABLE_SEP.match(rows[1]) else []
            header = "\n".join(head)
            widths = column_widths([_cells(r) for r in rows if not _TABLE_SEP.match(r)])
            for k, row in enumerate(rows[len(head) :]):
                cost = _row_cost(_cells(row), widths)
                lead = heading + header + "\n" if k == 0 and header else ""
                extra = 1.2 if k == 0 and header else 0
                if cost + extra <= budget:
                    units.append(_Unit(lead + row, cost + extra, group, "row", header))
                else:
                    units += _row_pieces(lead, row, extra, widths, group, header, budget)
                heading = ""
            i = j
            group += 1
            continue
        j = i + 1
        if _ITEM.match(line):
            while j < len(lines) and lines[j].strip() and (lines[j][:1].isspace()):
                j += 1
            kind = "item"
        else:
            while (
                j < len(lines)
                and lines[j].strip()
                and not lines[j].lstrip().startswith(("|", "#"))
                and not _ITEM.match(lines[j])
                and not _fence_close(lines[j])
            ):
                j += 1
            kind = "block"
        text = "\n".join(lines[i:j])
        units += _prose_pieces(heading, text, group, kind, budget)
        heading = ""
        i = j
    if heading:
        units.append(_Unit(heading.strip(), 1.5, group + 1, "block"))
    return units


_SENTENCE_END = re.compile(r"(?<=[.!?])\s+(?=\S)")


def _fill(atoms: list[tuple[str, str]], room, cost) -> list[tuple[str, str]]:
    """``atoms`` ((glue, text): each joined to the one before by its glue) packed into
    pieces each within ``room(i)`` (the i-th piece's room) by ``cost``; each piece comes
    with the glue before its first atom."""
    pieces: list[tuple[str, str]] = []
    glue, text = "", ""
    for g, atom in atoms:
        if not text:
            glue, text = g, atom
        elif cost(text + g + atom) > room(len(pieces)):
            pieces.append((glue, text))
            glue, text = g, atom
        else:
            text += g + atom
    if text:
        pieces.append((glue, text))
    return pieces


def _prose_pieces(heading: str, text: str, group: int, kind: str, budget: float) -> list[_Unit]:
    """A paragraph or list item as units: itself when it fits a slide, else cut between
    sentences (a sentence longer than a slide between words), each piece within the slide."""
    lead = 1.5 if heading else 0
    cost = _lines(text) + 0.4 + lead
    if cost <= budget:
        return [_Unit(heading + text, cost, group, kind)]
    atoms: list[tuple[str, str]] = []
    for n, line in enumerate(text.splitlines()):
        for m, sentence in enumerate(_SENTENCE_END.split(line)):
            glue = "" if n == m == 0 else (" " if m else "\n")
            if _lines(sentence) + 0.4 + lead > budget:
                words = sentence.split(" ")
                atoms += [(glue if k == 0 else " ", w) for k, w in enumerate(words)]
            else:
                atoms.append((glue, sentence))
    pieces = _fill(atoms, lambda i: budget - 0.4 - (lead if i == 0 else 0), _lines)
    return [
        _Unit(
            (heading if i == 0 else "") + piece,
            _lines(piece) + 0.4 + (lead if i == 0 else 0),
            group,
            kind if i == 0 or glue == "\n" else "block",
            glue=glue,
        )
        for i, (glue, piece) in enumerate(pieces)
    ]


def _cells(row: str) -> list[str]:
    return [c.strip() for c in row.strip().strip("|").split("|")]


def column_widths(rows: list[list[str]], chars: int = LINE_CHARS) -> list[int]:
    """Characters a line each column of a table is shown at, as a browser lays the table
    out across the slide: a column whose longest cell fits its share keeps that width, the
    rest of the line is shared by the others in proportion to their text (one long cell
    takes most of the slide, not ``chars / columns``). The PPTX sets its columns so too."""
    cols = max((len(r) for r in rows), default=1)
    natural = [
        max((len(r[c]) if c < len(r) else 0 for r in rows), default=0) + 2 for c in range(cols)
    ]
    widths = [0] * cols
    left, room = set(range(cols)), chars
    while left:
        share = room / len(left)
        fixed = {c for c in left if natural[c] <= share}
        if not fixed:
            total = sum(natural[c] for c in left)
            for c in left:
                widths[c] = int(room * natural[c] / total)
            break
        for c in fixed:
            widths[c] = natural[c]
            room -= natural[c]
        left -= fixed
    # A cell's padding takes about a character on each side.
    return [max(1, w - 2) for w in widths]


def _row_cost(cells: list[str], widths: list[int]) -> float:
    lines = (-(-len(t) // widths[c]) for c, t in enumerate(cells) if c < len(widths))
    return 1.2 * max([1, *lines])


def _row_pieces(
    lead: str, row: str, extra: float, widths: list[int], group: int, header: str, budget: float
) -> list[_Unit]:
    """A table row longer than a slide as rows that each fit: each cell's text cut between
    sentences (else words) at its column's width, its pieces in the rows in turn, the other
    cells left empty."""
    cells = _cells(row)

    def cut(cell: str, room: int) -> list[str]:
        atoms = [(" " if k else "", a) for k, a in enumerate(_SENTENCE_END.split(cell))]
        if any(len(a) > room for _, a in atoms):
            atoms = [(" " if k else "", w) for k, w in enumerate(cell.split(" "))]
        return [p for _, p in _fill(atoms, lambda i: room, len)] or [""]

    lines_first = max(1, int((budget - extra) / 1.2))
    lines_rest = max(1, int(budget / 1.2))
    # Cut for the tighter (first) row, so every piece fits wherever it lands.
    lines = min(lines_first, lines_rest)
    width = widths + [widths[-1]] * (len(cells) - len(widths))
    parts = [cut(c, lines * width[i]) for i, c in enumerate(cells)]
    count = max(len(p) for p in parts)
    units = []
    for r in range(count):
        texts = [p[r] if r < len(p) else "" for p in parts]
        line = "| " + " | ".join(texts) + " |"
        cost = _row_cost(texts, width) + (extra if r == 0 else 0)
        units.append(_Unit((lead if r == 0 else "") + line, cost, group, "row", header))
    return units


def _pack(units: list[_Unit], budget: float) -> list[list[_Unit]]:
    pages: list[list[_Unit]] = [[]]
    used = 0.0
    for u in units:
        if pages[-1] and used + u.cost > budget:
            pages.append([])
            used = 0.0
        pages[-1].append(u)
        used += u.cost
    return pages


def _join(page: list[_Unit]) -> str:
    out = ""
    prev: _Unit | None = None
    for u in page:
        text = u.text
        if prev is None and u.kind == "row" and u.header and u.header not in text:
            text = u.header + "\n" + text
        if prev is not None and u.glue:
            out += u.glue
        elif prev is not None:
            close = prev.group == u.group and u.kind == prev.kind and u.kind in ("item", "row")
            out += "\n" if close else "\n\n"
        out += text
        prev = u
    return out


def slide_pages(body: str, budget: float = SLIDE_LINES) -> list[str]:
    """``body`` as the slides it needs (E-9): itself when it fits one slide, else split
    between paragraphs, list items or table rows (a table's header on each), as evenly as
    the pieces allow; a paragraph, item or row longer than a slide is cut too."""
    units = _units(body, budget)
    total = sum(u.cost for u in units)
    if total <= budget or len(units) < 2:
        return [body]
    count = len(_pack(units, budget))
    # The same number of slides, filled evenly: never one full slide and a last line.
    even = max(total / count, max(u.cost for u in units))
    while len(pages := _pack(units, even)) > count:
        even = min(even + 0.5, budget)
    return [_join(p) for p in pages if p]


CODE_LINE = "Code: {n} {lines}, in the full PRD"
_CODE_LINK = re.compile(r'<a href="[^"]*">(Code: \d+ lines?, in the full PRD)</a>')


# The parser the exports render with: code blocks are found as they are rendered.
_CODE_MD = MarkdownIt("commonmark", {"html": False}).enable(["table", "strikethrough"])
_NEWLINE = re.compile(r"\r\n?|\n")


def _blank(line: str) -> bool:
    return not line.strip(" \t>")


def code_left_out(body: str, href: str) -> str:
    """``body`` with each code block (fenced or indented, as markdown-it finds it) as one
    line, "Code: 40 lines, in the full PRD", a link to ``href`` (that place in the full
    PRD), in a paragraph of its own: a deck shows no code (owner, Nov 5), so a long block is
    never cut into continuation slides or left as a blank slide. An empty block is dropped."""
    lines = _NEWLINE.split(body)
    out: list[str] = []
    i = 0
    for t in _CODE_MD.parse(body):
        if t.type not in ("fence", "code_block") or not t.map or t.map[0] < i:
            continue
        start, end = t.map
        out += lines[i:start]
        first = lines[start]
        # What the block's first line holds before the code: its quote and list markers ("> ",
        # "- "), kept, so the line stays in its list item.
        if t.type == "fence":
            prefix = first[: first.index(t.markup)] if t.markup in first else ""
        else:
            code = t.content.split("\n", 1)[0]
            prefix = first[: len(first) - len(code)] if first.endswith(code) else ""
            prefix = prefix[:-4] if prefix.endswith("    ") else prefix.removesuffix("\t")
        # The line that sets it apart continues its container: quote markers only, a list
        # marker as spaces (a "-" alone would be an empty item).
        gap = re.sub(r"[^>]", " ", prefix).rstrip()
        n = len(t.content.splitlines())
        after = end < len(lines) and not _blank(lines[end])
        if n:
            if out and not _blank(out[-1]):
                out.append(gap)
            text = CODE_LINE.format(n=n, lines="line" if n == 1 else "lines")
            out.append(f"{prefix}[{text}]({href})")
            if after:
                out.append(gap)
        elif out and not _blank(out[-1]) and after:
            out.append(gap)
        i = end
    out += lines[i:]
    return "\n".join(out)


def unlink_code(html: str) -> str:
    """The deck PDF's "Code: N lines, in the full PRD" as plain words, as in the PPTX."""
    return _CODE_LINK.sub(r'<span class="code-left-out">\1</span>', html)


# A goal's code and its name where the PRD names it: "**G2 (retention)**", "G2 (Retention)".
_GOAL_NAMED = re.compile(r"\b(G\d{1,3})\b\**\s*\(([A-Za-z][^()\n]{0,40})\)")
_GOAL_CELL = re.compile(r"(?<=\|)([ \t]*)(G\d{1,3})([ \t]*)(?=\|)")


def goal_names(sections: list[Section]) -> dict[str, str]:
    """Each goal code the version names, with its name ("G2" -> "Retention"): what the Goal
    trace says, read once for the deck."""
    out: dict[str, str] = {}
    for s in sections:
        for m in _GOAL_NAMED.finditer(f"{s.heading}\n{s.body_md or ''}"):
            name = m.group(2).strip()
            out.setdefault(m.group(1), name[:1].upper() + name[1:])
    return out


def with_goal_names(body: str, names: dict[str, str]) -> str:
    """A table cell holding only a goal's code shows its name too ("G2 Retention", E-12)."""
    if not names:
        return body
    return _GOAL_CELL.sub(
        lambda m: (
            f"{m.group(1)}{m.group(2)} {names[m.group(2)]}{m.group(3)}"
            if m.group(2) in names
            else m.group(0)
        ),
        body,
    )


def _state_kind(state) -> str:
    return "added" if state.added else ("decided" if state.decided else "proposed")


def slide_groups(front_matter: dict | None, template: str | None) -> list[list[str]]:
    """Brief sections that share one slide (H8: a board update's two slides): the
    version's front matter ``slides``, else its built-in template's."""
    groups = (front_matter or {}).get("slides")
    if groups is None and template:
        from oracle.docs.parser import split_front_matter
        from oracle.templates.builtins import BUILTIN_TEMPLATES_BY_KEY, builtin_body
        from oracle.templates.service import slide_groups_of

        builtin = BUILTIN_TEMPLATES_BY_KEY.get(template)
        if builtin is not None:
            groups = slide_groups_of(split_front_matter(builtin_body(builtin))[0])
    if not isinstance(groups, list):
        return []
    return [[k for k in g if isinstance(k, str)] for g in groups if isinstance(g, list) and g]


def _grouped(ev: ExportVersion, brief: list[Section]) -> list[tuple[Section, str, str]]:
    """Each slide's lead section, its raw body (for the notes) and the body it shows: a
    section's own body, or for a group (:func:`slide_groups`) the lead's body then each
    further section under its own heading; each section's code as one line linking to it
    in the full PRD (:func:`code_left_out`)."""

    def shown(s: Section) -> str:
        href = f"/documents/{ev.document.slug}/v/{ev.version.number}#{s.section_key}"
        return code_left_out(layers.slide_body(s.body_md or ""), href)

    groups = slide_groups(ev.version.front_matter, ev.document.template)
    by_key = {s.section_key: s for s in brief}
    lead_of: dict[str, list[Section]] = {}
    taken: set[str] = set()
    for g in groups:
        members = [by_key[k] for k in g if k in by_key and k not in taken]
        if members:
            lead_of[members[0].section_key] = members
            taken.update(m.section_key for m in members)
    out: list[tuple[Section, str, str]] = []
    for s in brief:
        if s.section_key in lead_of:
            members = lead_of[s.section_key]
            raw = [s.body_md or ""]
            raw += [f"### {_plain_heading(m)}\n\n{m.body_md or ''}" for m in members[1:]]
            parts = [shown(s)] + [f"### {_plain_heading(m)}\n\n{shown(m)}" for m in members[1:]]
            out.append((s, "\n\n".join(raw), "\n\n".join(parts)))
        elif s.section_key not in taken:
            out.append((s, s.body_md or "", shown(s)))
    return out


def _section_slide(
    ev: ExportVersion,
    s: Section,
    raw: str,
    body: str,
    heading: str,
    index: int,
    *,
    dense: bool,
    refs: list,
    by_key: dict[str, Section],
    on_slides: set[str],
    detail_keys: set[str],
) -> Slide:
    """One slide of a brief section: ``body`` (all of it, or one page of it); its notes
    from ``raw`` (the first page's only), its Expand items for the details ``body`` links."""
    all_keys = set(by_key)
    expand = []
    for key in layers.linked_sections(body):
        if key not in detail_keys:
            continue
        parts = []
        for sub in layers.subtree(refs, key):
            d = by_key[sub]
            level = min(max(d.level, 2), 4)
            body_html = section_body_html(
                ev,
                sub,
                layers.slide_body(d.body_md or ""),
                lambda text: str(_render_md(text, all_keys)),
            )
            parts.append(
                f'<section class="expand-section" data-section-key="{escape(sub)}">'
                f"<h{level}>{escape(_plain_heading(d))}</h{level}>"
                f"{body_html}</section>"
            )
        expand.append(ExpandItem(key, _plain_heading(by_key[key]), Markup("".join(parts))))
    rows = body.count("\n|")
    states = ev.spec_states.get(s.section_key) or []
    notes = layers.presenter_notes(raw) if raw else None
    return Slide(
        index=index,
        kind="section",
        heading=heading,
        body_md=body,
        section_key=s.section_key,
        notes=days_in_words(notes) if notes else None,
        body_html=Markup(
            section_body_html(
                ev, s.section_key, body, lambda text: str(_render_md(text, on_slides))
            )
        ),
        expand=expand,
        dense=dense or len(body) > DENSE_CHARS or rows > DENSE_ROWS,
        state=states[0].label if states else None,
        state_kind=_state_kind(states[0]) if states else None,
    )


def build_deck(ev: ExportVersion) -> Deck:
    """Slides for ``ev`` (already restricted to the brief layer by ``apply_layer``)."""
    appendix = sources_keys(ev.all_sections)
    brief = [s for s in ev.sections if s.section_key not in appendix]
    refs = [layers.SectionRef(s.section_key, s.level) for s in ev.all_sections]
    by_key = {s.section_key: s for s in ev.all_sections}
    on_slides = {s.section_key for s in brief}
    detail_keys = {s.section_key for s in ev.all_sections if s.layer != layers.BRIEF} - appendix

    goals = goal_names(ev.all_sections)
    slides: list[Slide] = [Slide(index=1, kind="title", heading=ev.title)]
    for s, raw, shown in _grouped(ev, brief):
        states = ev.spec_states.get(s.section_key) or []
        whole = with_goal_names(shown, goals)
        pages = slide_pages(whole, SLIDE_LINES - (2 if states else 0))
        for page, body in enumerate(pages, start=1):
            heading = days_in_words(_plain_heading(s))
            if len(pages) > 1:
                heading += f" ({page} of {len(pages)})"
            slides.append(
                _section_slide(ev, s, raw if page == 1 else "", body, heading, len(slides) + 1,
                               dense=len(pages) > 1, refs=refs, by_key=by_key,
                               on_slides=on_slides, detail_keys=detail_keys)
            )  # fmt: skip

    if ev.citations:
        cited = []
        seen: set[str] = set()
        for s in ev.all_sections:
            for key in s.citation_keys or []:
                if key not in seen:
                    seen.add(key)
                    cited.append(key)
        order = cited + [c.cite_key for c in ev.citations if c.cite_key not in seen]
        by_cite = {c.cite_key: c for c in ev.citations}
        rows = [
            (
                i + 1,
                by_cite[k].title or by_cite[k].ref,
                by_cite[k].source,
                _format_dt(by_cite[k].retrieved_at, ev.zone),
            )
            for i, k in enumerate(k for k in order if k in by_cite)
        ]
        keys = [k for k in order if k in by_cite]
        # E1: a spec's citations added in an edit get their own slides, labelled, never
        # inside Oracle's Sources.
        lists = [
            ("Sources and data points", None, [r for r, k in zip(rows, keys, strict=True)
                                               if k not in ev.added_citations]),
            ("Added sources", ev.added_label, [r for r, k in zip(rows, keys, strict=True)
                                               if k in ev.added_citations]),
        ]  # fmt: skip
        for title, label, listed in lists:
            chunks = [
                listed[i : i + SOURCES_PER_SLIDE] for i in range(0, len(listed), SOURCES_PER_SLIDE)
            ]
            for i, chunk in enumerate(chunks):
                heading = title + (f" ({i + 1}/{len(chunks)})" if len(chunks) > 1 else "")
                slides.append(
                    Slide(
                        index=len(slides) + 1,
                        kind="sources",
                        heading=heading,
                        sources=chunk,
                        state=label,
                        state_kind="added" if label else None,
                    )
                )

    theme = ev.theme
    tokens = (theme.tokens or {}) if theme is not None else {}
    brand = ev.brand
    if brand is not None:
        # O5: the brand's accent replaces the theme's on slides and in the PPTX.
        tokens = brand.apply_accent(tokens)
    # O5: the dark logo on a dark theme's slides, the light one otherwise.
    dark = brand_dark(ev)
    logo_png, logo_size = brand.logo_for(dark) if brand is not None else (None, None)
    css = "\n".join(
        [
            slide_stylesheet(),
            BRAND_CSS if brand is not None else "",
            token_vars(tokens, ".deck"),
            slide_variant_css(theme.key if theme else None, bool(theme and theme.builtin)),
            company_slide_css(theme),
        ]
    )
    deck = Deck(
        title=ev.title,
        slug=ev.document.slug,
        number=ev.version.number,
        latest_number=ev.latest_number,
        status=ev.status,
        as_of=snapshot_in_words(ev.version.snapshot, ev.zone, lambda v: _moment(v, ev.zone))
        or _moment(ev.date, ev.zone),
        banner=_banner(ev),
        source_label=ev.source_label,
        theme_key=theme.key if theme else None,
        theme_name=theme.name if theme else None,
        tokens=tokens,
        css=Markup(css),
        slides=slides,
        brand_name=brand.display_name if brand is not None else None,
        brand_logo=render_brand_logo(brand, dark=dark),
        brand_logo_png=logo_png,
        brand_logo_size=logo_size,
        kicker=KICKER.get(ev.document.kind, "Brief"),
    )
    macro = _jinja().get_template("slide.html.j2").module.slide  # type: ignore[attr-defined]
    for slide in slides:
        slide.html = Markup(macro(slide, deck, len(slides)))
    return deck


def theme_class(deck: Deck) -> str:
    return f"theme-{re.sub(r'[^a-z0-9-]', '', deck.theme_key or 'none')}"


def render_deck_html(deck: Deck, preview: bool = False) -> str:
    """Every slide on its own 16:9 page: the input for the deck PDF. ``preview`` lays
    the slides out for the theme editor's slide preview instead."""
    return (
        _jinja()
        .get_template("deck.html.j2")
        .render(deck=deck, theme_class=theme_class(deck), total=len(deck.slides), preview=preview)
    )
