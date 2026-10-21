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

from markupsafe import Markup, escape

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
    section_body_html,
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


def _banner(ev: ExportVersion) -> str:
    parts = [ev.title, f"Version {ev.version.number}", ev.status.replace("_", " ")]
    if ev.version.approved_at is not None:
        parts.append(f"approved {_format_dt(ev.version.approved_at)}")
    else:
        parts.append(f"imported {_format_dt(ev.version.created_at)}")
    if ev.source_label:
        parts.append(ev.source_label)
    return " · ".join(parts)


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
    return [
        [k for k in g if isinstance(k, str)] for g in groups if isinstance(g, list) and g
    ]


def _grouped(ev: ExportVersion, brief: list[Section]) -> list[tuple[Section, str]]:
    """Each slide's lead section and the body it shows: a section's own body, or for a
    group (:func:`slide_groups`) the lead's body then each further section under its own
    heading."""
    groups = slide_groups(ev.version.front_matter, ev.document.template)
    by_key = {s.section_key: s for s in brief}
    lead_of: dict[str, list[Section]] = {}
    taken: set[str] = set()
    for g in groups:
        members = [by_key[k] for k in g if k in by_key and k not in taken]
        if members:
            lead_of[members[0].section_key] = members
            taken.update(m.section_key for m in members)
    out: list[tuple[Section, str]] = []
    for s in brief:
        if s.section_key in lead_of:
            members = lead_of[s.section_key]
            parts = [s.body_md or ""]
            parts += [f"### {_plain_heading(m)}\n\n{m.body_md or ''}" for m in members[1:]]
            out.append((s, "\n\n".join(parts)))
        elif s.section_key not in taken:
            out.append((s, s.body_md or ""))
    return out


def build_deck(ev: ExportVersion) -> Deck:
    """Slides for ``ev`` (already restricted to the brief layer by ``apply_layer``)."""
    appendix = sources_keys(ev.all_sections)
    brief = [s for s in ev.sections if s.section_key not in appendix]
    refs = [layers.SectionRef(s.section_key, s.level) for s in ev.all_sections]
    by_key = {s.section_key: s for s in ev.all_sections}
    on_slides = {s.section_key for s in brief}
    all_keys = set(by_key)
    detail_keys = {s.section_key for s in ev.all_sections if s.layer != layers.BRIEF} - appendix

    slides: list[Slide] = [Slide(index=1, kind="title", heading=ev.title)]
    for s, raw in _grouped(ev, brief):
        body = layers.slide_body(raw)
        expand = []
        for key in layers.linked_sections(raw):
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
        slides.append(
            Slide(
                index=len(slides) + 1,
                kind="section",
                heading=_plain_heading(s),
                body_md=body,
                section_key=s.section_key,
                notes=layers.presenter_notes(raw),
                body_html=Markup(
                    section_body_html(
                        ev, s.section_key, body, lambda text: str(_render_md(text, on_slides))
                    )
                ),
                expand=expand,
                dense=len(body) > DENSE_CHARS or rows > DENSE_ROWS,
                state=states[0].label if states else None,
                state_kind=_state_kind(states[0]) if states else None,
            )
        )

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
                _format_dt(by_cite[k].retrieved_at),
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
    css = "\n".join(
        [
            slide_stylesheet(),
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
        as_of=ev.version.snapshot or _format_dt(ev.date),
        banner=_banner(ev),
        source_label=ev.source_label,
        theme_key=theme.key if theme else None,
        theme_name=theme.name if theme else None,
        tokens=tokens,
        css=Markup(css),
        slides=slides,
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
