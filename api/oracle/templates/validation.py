"""Checks a template body or a theme must pass before it is saved.

A template body is a draft skeleton: optional YAML front matter, then markdown whose
level 1-3 headings each end with ``{#section-id}``. O1c: the body carries no
citations; every ``[c:...]`` marker belongs in the final ``Sources and data points``
section (id ``sources``), which must be present and last.

O1f: the front matter's ``brief: [section ids]`` marks the brief layer (everything
else is detail); without it, the sections before a level-1 ``Full version {#full}``
heading are the brief. O1g: a template with no brief sections is refused
(``no_brief_sections``). Versions saved before that keep resolving; their next edit
must add brief markers.

A theme's colour tokens must reach WCAG AA contrast for body text (4.5:1) against
the background, and its CSS may not load anything from outside the export.
"""

import re
from dataclasses import dataclass, field
from typing import Any

from markdown_it import MarkdownIt

from oracle import safe_yaml
from oracle.docs import layers
from oracle.docs.parser import CITATION_RE, SECTION_ID_RE, split_front_matter

SOURCES_SECTION_ID = "sources"
SOURCES_HEADING = "Sources and data points"
NO_BRIEF_SECTIONS = "no_brief_sections"
# Front matter keys a template may carry for itself; they are dropped from drafts.
TEMPLATE_META_KEYS = ("theme", "suggest_when", "brief")

_md = MarkdownIt("commonmark", {"html": False}).enable("table")
_LAYOUT_FENCE = re.compile(r"^```ya?ml[ \t]*\n(.*?)^```", re.S | re.M)


@dataclass
class Problem:
    code: str
    message: str
    line: int | None = None
    section_key: str | None = None


@dataclass
class Heading:
    level: int
    text: str
    key: str | None
    line: int


@dataclass
class TemplateCheck:
    problems: list[Problem] = field(default_factory=list)
    # Findings that do not block saving (none today; no_brief_sections blocks, O1g).
    warnings: list[Problem] = field(default_factory=list)
    front_matter: dict[str, Any] = field(default_factory=dict)
    headings: list[Heading] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.problems

    @property
    def section_keys(self) -> list[str]:
        return [h.key for h in self.headings if h.key]

    @property
    def suggested_theme(self) -> str | None:
        value = self.front_matter.get("theme")
        return value if isinstance(value, str) and value else None

    @property
    def suggest_when(self) -> str | None:
        value = self.front_matter.get("suggest_when")
        return value if isinstance(value, str) and value else None

    @property
    def marked_brief(self) -> list[str] | None:
        """The front matter's ``brief`` list, as written (None when absent)."""
        return layers.marked_brief(self.front_matter)

    @property
    def brief_sections(self) -> list[str]:
        """The brief layer: the marked sections, else those before ``{#full}``."""
        refs = [layers.SectionRef(h.key, h.level) for h in self.headings if h.key]
        keys, _ = layers.resolve_brief(refs, draft_brief=None, template_brief=self.marked_brief)
        return keys

    def default_required_sections(self) -> list[str]:
        """Level 1-2 sections: the skeleton's spine."""
        return [h.key for h in self.headings if h.key and h.level <= 2]


def _headings(body: str, offset: int) -> list[Heading]:
    out: list[Heading] = []
    tokens = _md.parse(body)
    for i, token in enumerate(tokens):
        if token.type != "heading_open" or token.map is None:
            continue
        level = int(token.tag[1])
        if level > 3:
            continue
        raw = tokens[i + 1].content.strip()
        m = SECTION_ID_RE.search(raw)
        out.append(
            Heading(
                level=level,
                text=raw[: m.start()].strip() if m else raw,
                key=m.group(1) if m else None,
                line=token.map[0] + 1 + offset,
            )
        )
    return out


def check_template(body: str, *, theme_keys: set[str] | None = None) -> TemplateCheck:
    """Every problem in a template body, so an editor can fix them in one pass."""
    result = TemplateCheck()
    problems = result.problems
    text = body.replace("\r\n", "\n")
    yaml_text, rest, offset = split_front_matter(text)
    if text.lstrip().startswith("---") and yaml_text is None:
        problems.append(
            Problem("invalid_front_matter", "front matter starts with '---' but never ends", 1)
        )
    elif yaml_text is not None:
        try:
            fm = safe_yaml.load(yaml_text) or {}
        except safe_yaml.SafeYamlError as e:
            problems.append(Problem("invalid_front_matter", f"front matter is not valid YAML: {e}"))
            fm = {}
        if not isinstance(fm, dict):
            problems.append(Problem("invalid_front_matter", "front matter must be a mapping"))
            fm = {}
        result.front_matter = fm
    theme = result.front_matter.get("theme")
    if theme is not None and (not isinstance(theme, str) or not theme):
        problems.append(Problem("invalid_theme", "front matter 'theme' must be a theme key"))
    elif theme_keys is not None and isinstance(theme, str) and theme not in theme_keys:
        problems.append(Problem("unknown_theme", f"suggested theme '{theme}' does not exist"))

    headings = _headings(rest, offset)
    result.headings = headings
    if not headings:
        problems.append(Problem("no_sections", "the template has no level 1-3 headings"))
    seen: set[str] = set()
    for h in headings:
        if h.key is None:
            problems.append(
                Problem(
                    "missing_section_id",
                    f"heading '{h.text}' (level {h.level}) must end with {{#section-id}}",
                    h.line,
                )
            )
        elif h.key in seen:
            problems.append(
                Problem(
                    "duplicate_section_id",
                    f"section id '{h.key}' is used more than once",
                    h.line,
                    h.key,
                )
            )
        else:
            seen.add(h.key)

    # The sources section: present, top level of the body (level 1-2), and last.
    sources = next((h for h in headings if h.key == SOURCES_SECTION_ID), None)
    if sources is None:
        problems.append(
            Problem(
                "missing_sources_section",
                f"the template must end with a '## {SOURCES_HEADING} {{#{SOURCES_SECTION_ID}}}' "
                "section: sources, data points and evidence live there, not in the body",
            )
        )
    else:
        later = [h for h in headings if h.line > sources.line and h.level <= sources.level]
        if sources.level > 2:
            problems.append(
                Problem(
                    "sources_section_level",
                    f"'{SOURCES_HEADING}' must be a level 1 or 2 heading",
                    sources.line,
                    SOURCES_SECTION_ID,
                )
            )
        if later:
            problems.append(
                Problem(
                    "sources_section_not_last",
                    f"'{SOURCES_HEADING}' must be the final section; '{later[0].text}' "
                    "comes after it",
                    later[0].line,
                    later[0].key,
                )
            )

    # Citations: only inside the sources section (and its sub-sections).
    lines = rest.split("\n")
    sources_line = sources.line - offset if sources else len(lines) + 1
    current: str | None = None
    starts = {h.line - offset: h.key for h in headings}
    for i, line in enumerate(lines, start=1):
        if i in starts:
            current = starts[i]
        if i >= sources_line:
            break
        for m in CITATION_RE.finditer(line):
            problems.append(
                Problem(
                    "citation_in_body",
                    f"citation [c:{m.group(1)}] is outside '{SOURCES_HEADING}': the body states "
                    "conclusions only (O1c)",
                    i + offset,
                    current,
                )
            )

    # O1f: brief markers name real sections. O1g: a template without a brief is refused.
    for code, message, key in layers.brief_problems(
        result.front_matter.get("brief"), result.section_keys
    ):
        problems.append(Problem(code, message, None, key))
    if headings and not result.brief_sections:
        problems.append(
            Problem(
                NO_BRIEF_SECTIONS,
                "the template marks no brief sections: add 'brief: [section ids]' to its "
                f"front matter, or a level-1 '# {layers.FULL_HEADING} "
                f"{{#{layers.FULL_SECTION_ID}}}' heading after the brief sections",
            )
        )

    # Roadmap layout blocks are read by the renderer: they must parse.
    for m in _LAYOUT_FENCE.finditer(rest):
        try:
            safe_yaml.load(m.group(1))
        except safe_yaml.SafeYamlError as e:
            line = rest[: m.start()].count("\n") + 1 + offset
            problems.append(Problem("invalid_layout", f"layout block is not valid YAML: {e}", line))
    return result


def check_required_sections(required: list[str], check: TemplateCheck) -> list[Problem]:
    known = set(check.section_keys)
    return [
        Problem("unknown_required_section", f"required section '{key}' is not in the body")
        for key in required
        if key not in known
    ]


# --- themes -----------------------------------------------------------------------

AA_BODY = 4.5
_HEX = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")
# Font stacks are written into CSS: names, quotes, commas, spaces and hyphens only.
_FONT = re.compile(r"^[A-Za-z0-9 ,'\"_-]{1,200}$")
# Colours that are read as text on the page background.
TEXT_COLOURS = ("text", "muted", "accent", "heading")
PAGE_SIZES = ("A4", "Letter")
ORIENTATIONS = ("portrait", "landscape")


def _channel(c: int) -> float:
    s = c / 255
    return s / 12.92 if s <= 0.03928 else ((s + 0.055) / 1.055) ** 2.4


def _rgb(hex_colour: str) -> tuple[int, int, int]:
    h = hex_colour.lstrip("#")
    if len(h) == 3:
        h = "".join(ch * 2 for ch in h)
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def luminance(hex_colour: str) -> float:
    r, g, b = (_channel(c) for c in _rgb(hex_colour))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a: str, b: str) -> float:
    """WCAG 2 contrast ratio of two hex colours, 1-21."""
    la, lb = sorted((luminance(a), luminance(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def check_theme_tokens(tokens: dict[str, Any]) -> list[Problem]:
    problems: list[Problem] = []
    colours = tokens.get("colors") or {}
    for name, value in colours.items():
        if not isinstance(value, str) or not _HEX.match(value):
            problems.append(
                Problem("invalid_color", f"colors.{name} must be a hex colour like #1f2933")
            )
    background = colours.get("background")
    if isinstance(background, str) and _HEX.match(background):
        for name in TEXT_COLOURS:
            value = colours.get(name)
            if not isinstance(value, str) or not _HEX.match(value):
                continue
            ratio = contrast(value, background)
            if ratio < AA_BODY:
                problems.append(
                    Problem(
                        "insufficient_contrast",
                        f"colors.{name} {value} on colors.background {background} has a "
                        f"contrast of {ratio:.2f}:1; WCAG AA needs at least {AA_BODY}:1 for "
                        "body text. Darken the text colour or lighten the background.",
                    )
                )
    for name, value in (tokens.get("fonts") or {}).items():
        if not isinstance(value, str) or not _FONT.match(value):
            problems.append(
                Problem(
                    "invalid_font",
                    f"fonts.{name} must be a font stack (letters, digits, spaces, commas, quotes)",
                )
            )
    page = tokens.get("page") or {}
    if page.get("size", "A4") not in PAGE_SIZES:
        problems.append(
            Problem("invalid_page", f"page.size must be one of {', '.join(PAGE_SIZES)}")
        )
    if page.get("orientation", "portrait") not in ORIENTATIONS:
        problems.append(
            Problem("invalid_page", f"page.orientation must be one of {', '.join(ORIENTATIONS)}")
        )
    spacing = tokens.get("spacing") or {}
    for name, (low, high) in {
        "base_size_pt": (6, 20),
        "line_height": (1, 2.5),
        "page_margin_mm": (5, 40),
        "section_gap_rem": (0, 6),
    }.items():
        value = spacing.get(name)
        if value is None:
            continue
        if (
            not isinstance(value, int | float)
            or isinstance(value, bool)
            or not low <= value <= high
        ):
            problems.append(
                Problem("invalid_spacing", f"spacing.{name} must be a number from {low} to {high}")
            )
    return problems


# Nothing in a theme's CSS may reach outside the export: no imports, no remote or
# file URLs (WeasyPrint would fetch them on the server), no way out of <style>.
_CSS_FORBIDDEN = [
    (re.compile(r"@import", re.I), "@import is not allowed"),
    (re.compile(r"</", re.I), "'</' is not allowed in CSS"),
    (re.compile(r"expression\s*\(", re.I), "expression() is not allowed"),
    (re.compile(r"javascript:", re.I), "javascript: URLs are not allowed"),
    (re.compile(r"\\"), "backslash escapes are not allowed"),
]
_CSS_URL = re.compile(r"url\s*\(\s*(['\"]?)\s*([^'\")\s]*)", re.I)
# These take a quoted URL without url(), and browsers fetch it (Present mode). Not
# element(): it names an element (WeasyPrint's running headers), never a URL. Checked on
# the raw CSS: a browser only reads the function with its name and "(" side by side, so
# nothing can hide one, while stripping comments or strings first could (a "/*" inside a
# string). The price: the words inside a string, e.g. content: "image (1)", count too.
_CSS_URL_FUNCTIONS = re.compile(r"(?:image-set|cross-fade|\bimage)\s*\(", re.I)
# Slide CSS runs in a shadow root inside the app: :host would restyle the presenter's
# own controls. A browser allows only comments between ":" and "host", so a comment
# straight after any ":" is refused too. Linear: no pattern that can backtrack.
_SLIDE_CSS_HOST = re.compile(r":(?:host\b|/\*)", re.I)


def check_theme_css(css: str) -> list[Problem]:
    problems = [Problem("unsafe_css", msg) for rx, msg in _CSS_FORBIDDEN if rx.search(css)]
    if _CSS_URL_FUNCTIONS.search(css):
        problems.append(
            Problem("unsafe_css", "image-set(), image() and cross-fade() are not allowed")
        )
    for m in _CSS_URL.finditer(css):
        if not m.group(2).lower().startswith("data:"):
            problems.append(
                Problem(
                    "unsafe_css", "url() may only use data: URIs; the export loads nothing else"
                )
            )
            break
    if css.count("{") != css.count("}"):
        problems.append(Problem("invalid_css", "unbalanced braces in CSS"))
    return problems


def check_slide_css(css: str | None) -> list[Problem]:
    """A theme's slide CSS (O1g): the same checks as its CSS, named as slide CSS."""
    if not css:
        return []
    problems = [Problem(p.code, f"slide CSS: {p.message}") for p in check_theme_css(css)]
    if _SLIDE_CSS_HOST.search(css):
        problems.append(
            Problem(
                "unsafe_css",
                "slide CSS: :host is not allowed, nor a comment straight after ':'",
            )
        )
    return problems
