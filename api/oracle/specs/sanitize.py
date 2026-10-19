"""Allowlist sanitiser for the design artifacts agents hand back (O2, §11.2, §12, §16.20).

Flows are SVG and wireframes are grayscale, low-fidelity HTML. Both are untrusted agent
output. They must be **static** (no scripts, no event handlers, nothing that runs) and
**offline** (nothing that fetches: no external URL, image, font, frame, stylesheet,
form target or CSS ``url()``).

Each sanitiser parses the candidate and rebuilds it from an allowlist of elements and
attributes, so what is stored is only what Oracle wrote out. Findings come in two kinds:

- ``blocked``: something that would run code or reach the network (a script, an ``on*``
  attribute, a ``javascript:`` or external URL, an iframe, an image, CSS ``@import``).
  The design check refuses an artifact with any (it is not quietly "fixed": an agent that
  writes these may have read an injected instruction).
- ``removed``: harmless markup outside the allowlist (an unknown tag, a ``target``),
  dropped and reported.

Every rebuilt document is then checked again by :func:`static_problems`, the same check
the tests apply. The download route also serves it with a sandboxing CSP.
"""

import html
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from html.parser import HTMLParser

SVG_NS = "http://www.w3.org/2000/svg"
XLINK_NS = "http://www.w3.org/1999/xlink"

# The policy of every wireframe, as a meta tag (the download route adds a header too).
WIREFRAME_CSP = (
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; "
    "form-action 'none'; base-uri 'none'"
)
# Served with every design output: no scripts, no network, an opaque origin (sandbox
# without allow-same-origin), so it can never read Oracle's cookies or call its API.
DOWNLOAD_CSP = WIREFRAME_CSP + "; frame-ancestors 'self'; sandbox"

# Grayscale and low fidelity whatever the agents' CSS says (it comes last, !important).
LOWFI_CSS = (
    "html{filter:grayscale(100%)!important}"
    "body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#222;"
    "background:#fff;margin:0;padding:16px;line-height:1.4}"
    "*{box-sizing:border-box}"
    "[data-annotation]{outline:1px dashed #777;outline-offset:2px}"
    ".oracle-annotations{margin-top:24px;border-top:1px solid #999;padding-top:8px;"
    "font-size:13px;color:#444}"
)

MAX_NODES = 5000
MAX_DEPTH = 32


@dataclass
class Sanitized:
    content: str
    blocked: list[str] = field(default_factory=list)
    removed: list[str] = field(default_factory=list)
    # Element ids and data-annotation targets present in the content.
    targets: set[str] = field(default_factory=set)

    @property
    def safe(self) -> bool:
        return not self.blocked


# --- CSS ---------------------------------------------------------------------------------

_CSS_COMMENT = re.compile(r"/\*.*?\*/", re.S)
_CSS_URL = re.compile(r"url\s*\(\s*(['\"]?)(.*?)\1\s*\)", re.I | re.S)
_CSS_BANNED = (
    "@import",
    "@font-face",
    "@namespace",
    "expression(",
    "javascript:",
    "vbscript:",
    "behavior",
    "-moz-binding",
    "image-set(",
    "image(",
    "element(",
    "</",
    "<!--",
)


def css_problems(css: str, *, local_urls: bool = False) -> list[str]:
    """What in a stylesheet or ``style`` attribute could run code or fetch. ``local_urls``
    allows ``url(#id)`` (SVG markers and gradients)."""
    out: list[str] = []
    # Checked as written and with comments removed: a comment marker inside a string
    # must not hide anything (a{content:"/*"} b{...} c{content:"*/"}).
    for text in (css, _CSS_COMMENT.sub("", css)):
        if "\\" in text:
            out.append("CSS escape sequences are not allowed")
        if "<" in text:
            out.append("'<' is not allowed in CSS")
        lowered = text.lower()
        for word in _CSS_BANNED:
            if word in lowered:
                out.append(f"CSS {word.strip('(:<')!r} is not allowed")
        if re.search(r"@(?!media\b)", lowered):
            out.append("CSS at-rules other than @media are not allowed")
        for m in _CSS_URL.finditer(text):
            target = m.group(2).strip()
            if not (local_urls and re.fullmatch(r"#[A-Za-z][\w.-]*", target)):
                out.append(f"CSS url({target[:40]}) would fetch a resource")
    return list(dict.fromkeys(out))


# --- HTML wireframes ---------------------------------------------------------------------

HTML_TAGS = frozenset(
    """main header footer nav section article aside div span p h1 h2 h3 h4 h5 h6 ul ol li
    dl dt dd table thead tbody tfoot tr th td caption colgroup col fieldset legend label
    input button select option optgroup textarea small strong em b i u s mark br hr figure
    figcaption blockquote code pre a abbr sup sub progress meter details summary output
    """.split()
)
VOID = frozenset({"br", "hr", "input", "col"})
# Structure Oracle writes itself: the tags are dropped, their content kept.
STRUCTURAL = frozenset({"html", "head", "body", "form"})
# Elements dropped with everything inside them.
DROP_WITH_CONTENT = frozenset({"title", "svg", "math", "canvas", "noscript", "template"})
# Elements that run code or fetch: the artifact is refused.
BLOCKED_TAGS = frozenset(
    """script iframe frame frameset object embed applet base link meta img picture source
    video audio track image portal""".split()
)
GLOBAL_ATTRS = frozenset({"id", "class", "style", "title", "role", "lang", "dir", "hidden",
                          "tabindex"})  # fmt: skip
TAG_ATTRS: dict[str, frozenset[str]] = {
    "a": frozenset({"href"}),
    "input": frozenset({"type", "name", "value", "placeholder", "checked", "disabled",
                        "readonly", "required", "min", "max", "step", "multiple", "size"}),
    "button": frozenset({"type", "name", "value", "disabled"}),
    "select": frozenset({"name", "disabled", "multiple", "size"}),
    "option": frozenset({"value", "selected", "disabled", "label"}),
    "optgroup": frozenset({"label", "disabled"}),
    "textarea": frozenset({"name", "placeholder", "rows", "cols", "disabled", "readonly"}),
    "label": frozenset({"for"}),
    "td": frozenset({"colspan", "rowspan"}),
    "th": frozenset({"colspan", "rowspan", "scope"}),
    "col": frozenset({"span"}),
    "colgroup": frozenset({"span"}),
    "ol": frozenset({"start", "reversed"}),
    "progress": frozenset({"value", "max"}),
    "meter": frozenset({"value", "min", "max", "low", "high", "optimum"}),
    "details": frozenset({"open"}),
}  # fmt: skip
INPUT_TYPES = frozenset({"text", "email", "password", "number", "search", "tel", "url", "date",
                         "time", "checkbox", "radio", "range", "hidden", "button"})  # fmt: skip
# Attributes that name a resource: only an in-page fragment may stay.
URL_ATTRS = frozenset({"href", "src", "srcset", "action", "formaction", "poster", "background",
                       "data", "codebase", "cite", "longdesc", "manifest", "ping", "xlink:href",
                       "lowsrc", "dynsrc"})  # fmt: skip
_FRAGMENT = re.compile(r"#[A-Za-z][\w.:-]*")
_SCHEME = re.compile(r"^\s*[a-z][a-z0-9+.-]*:", re.I)


class _HtmlRebuilder(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []
        self.css: list[str] = []
        self.blocked: list[str] = []
        self.removed: list[str] = []
        self.targets: set[str] = set()
        self.open: list[str] = []
        self.skip_depth = 0  # inside an element dropped with its content
        self.skip_tag: str | None = None
        self.in_style = False
        self.nodes = 0

    # Findings are kept unique and short.
    def _block(self, what: str) -> None:
        if what not in self.blocked:
            self.blocked.append(what)

    def _remove(self, what: str) -> None:
        if what not in self.removed:
            self.removed.append(what)

    def _attrs(self, tag: str, attrs: list[tuple[str, str | None]]) -> list[tuple[str, str]]:
        allowed = GLOBAL_ATTRS | TAG_ATTRS.get(tag, frozenset())
        kept: list[tuple[str, str]] = []
        for name, value in attrs:
            name = name.lower()
            value = "" if value is None else value
            if name.startswith("on"):
                self._block(f"event handler attribute {name} on <{tag}>")
                continue
            if "javascript:" in value.lower().replace(" ", "") or "vbscript:" in value.lower():
                self._block(f"script URL in {name} on <{tag}>")
                continue
            if name in URL_ATTRS:
                if name == "href" and tag == "a" and _FRAGMENT.fullmatch(value.strip()):
                    kept.append((name, value.strip()))
                elif value.strip() in ("", "#"):
                    self._remove(f"empty {name} on <{tag}>")
                else:
                    self._block(f"{name}={value[:60]!r} on <{tag}> would load or navigate")
                continue
            if name == "style":
                problems = css_problems(value)
                for p in problems:
                    self._block(f"{p} (style on <{tag}>)")
                if problems:
                    continue
            if name.startswith("aria-") or name.startswith("data-"):
                if not re.fullmatch(r"[a-z][a-z0-9-]*", name):
                    self._remove(f"attribute {name}")
                    continue
                kept.append((name, value))
            elif name in allowed:
                if tag == "input" and name == "type":
                    if value.lower() in ("submit", "reset", "image", "file"):
                        if value.lower() in ("image", "file"):
                            self._block(f'<input type="{value}">')
                            continue
                        value = "button"
                    elif value.lower() not in INPUT_TYPES:
                        self._remove(f'input type "{value}"')
                        value = "text"
                if tag == "button" and name == "type":
                    value = "button"
                kept.append((name, value))
            else:
                self._remove(f"attribute {name} on <{tag}>")
            if name == "id" and value:
                self.targets.add(value)
            if name == "data-annotation" and value:
                self.targets.add(value)
        if tag == "button" and not any(n == "type" for n, _ in kept):
            kept.append(("type", "button"))
        return kept

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        self.nodes += 1
        if self.skip_depth:
            if tag == self.skip_tag:
                self.skip_depth += 1
            if tag in BLOCKED_TAGS:
                self._block(f"<{tag}> element")
            return
        if tag in BLOCKED_TAGS:
            if tag == "meta" and all(n.lower() == "charset" for n, _ in attrs):
                return
            self._block(f"<{tag}> element")
            if tag not in ("img", "meta", "link", "base", "source", "track", "embed", "image"):
                self.skip_tag, self.skip_depth = tag, 1
            return
        if tag in DROP_WITH_CONTENT:
            if tag != "title":
                self._remove(f"<{tag}> element and its content")
            self.skip_tag, self.skip_depth = tag, 1
            return
        if tag == "style":
            self.in_style = True
            return
        if tag in STRUCTURAL:
            if tag == "form":
                for name, value in attrs:
                    if name.lower() in URL_ATTRS and (value or "").strip():
                        self._block(f"<form {name}> would submit somewhere")
                    elif name.lower().startswith("on"):
                        self._block(f"event handler attribute {name} on <form>")
            return
        if tag not in HTML_TAGS:
            self._remove(f"<{tag}> element (content kept)")
            return
        if len(self.open) >= MAX_DEPTH:
            self._remove("elements nested too deeply")
            return
        kept = self._attrs(tag, attrs)
        rendered = "".join(f' {n}="{html.escape(v, quote=True)}"' for n, v in kept)
        self.out.append(f"<{tag}{rendered}>")
        if tag not in VOID:
            self.open.append(tag)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() in ("style", *DROP_WITH_CONTENT, *BLOCKED_TAGS):
            # A self-closing <style/> or <title/> opens nothing: the parser does not switch
            # to raw text for it, so what follows is markup, not CSS.
            if tag.lower() in BLOCKED_TAGS:
                self._block(f"<{tag.lower()}> element")
            return
        self.handle_starttag(tag, attrs)
        if tag.lower() in HTML_TAGS and tag.lower() not in VOID and self.open:
            if self.open[-1] == tag.lower():
                self.handle_endtag(tag)

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if self.skip_depth:
            if tag == self.skip_tag:
                self.skip_depth -= 1
                if not self.skip_depth:
                    self.skip_tag = None
            return
        if tag == "style":
            self.in_style = False
            return
        if tag not in HTML_TAGS or tag in VOID or tag not in self.open:
            return
        while self.open:
            top = self.open.pop()
            self.out.append(f"</{top}>")
            if top == tag:
                break

    def handle_data(self, data: str) -> None:
        if self.skip_depth:
            return
        if self.in_style:
            # Checked whole, once the document is read (close_all).
            self.css.append(data)
            return
        self.out.append(html.escape(data, quote=False))

    def handle_comment(self, data: str) -> None:
        if "[if" in data.lower():
            self._block("conditional comment")

    def handle_pi(self, data: str) -> None:
        self._remove("processing instruction")

    def unknown_decl(self, data: str) -> None:
        self._remove("declaration")

    def stylesheet(self) -> str:
        css = "".join(self.css)
        for p in css_problems(css):
            self._block(f"{p} (<style>)")
        return "" if self.blocked else css

    def close_all(self) -> str:
        while self.open:
            self.out.append(f"</{self.open.pop()}>")
        return "".join(self.out)


def sanitize_wireframe(
    candidate: str, *, title: str, annotations: list[tuple[str, str]] | None = None
) -> Sanitized:
    """A static, offline, grayscale HTML page from an agent's wireframe. ``annotations``
    (label, note) are listed in a static footer, numbered as the review shows them."""
    parser = _HtmlRebuilder()
    try:
        parser.feed(candidate)
        parser.close()
    except Exception as exc:  # HTMLParser is lenient; anything else is a broken input
        return Sanitized("", blocked=[f"unreadable HTML: {type(exc).__name__}"])
    if parser.nodes > MAX_NODES:
        return Sanitized("", blocked=[f"more than {MAX_NODES} elements"])
    body = parser.close_all()
    notes = ""
    if annotations:
        items = "".join(
            f"<li><strong>{html.escape(label)}</strong> {html.escape(note)}</li>"
            for label, note in annotations
        )
        notes = f'<aside class="oracle-annotations"><ol>{items}</ol></aside>'
    agent_css = parser.stylesheet()
    content = (
        "<!doctype html>\n"
        '<html lang="en"><head><meta charset="utf-8">'
        f'<meta http-equiv="Content-Security-Policy" content="{WIREFRAME_CSP}">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        f"<title>{html.escape(title)}</title>"
        + (f"<style>{agent_css}</style>" if agent_css.strip() else "")
        + f"<style>{LOWFI_CSS}</style></head>"
        f'<body><main data-oracle-wireframe="1">{body}</main>{notes}</body></html>\n'
    )
    out = Sanitized(content, parser.blocked, parser.removed, parser.targets)
    out.blocked += [p for p in static_problems(content, "html") if p not in out.blocked]
    return out


# --- SVG flows ---------------------------------------------------------------------------

SVG_TAGS = frozenset(
    """svg g defs title desc rect circle ellipse line polyline polygon path text tspan marker
    use symbol style""".split()
)
SVG_BLOCKED = frozenset(
    """script foreignObject image a iframe animate animateTransform animateMotion set feImage
    handler listener video audio""".split()
)
SVG_ATTRS = frozenset(
    """id class style x y x1 y1 x2 y2 cx cy r rx ry width height d points transform fill stroke
    stroke-width stroke-dasharray stroke-linecap stroke-linejoin opacity fill-opacity
    stroke-opacity font-size font-family font-weight font-style text-anchor
    dominant-baseline alignment-baseline viewBox preserveAspectRatio marker-start marker-mid
    marker-end markerWidth markerHeight refX refY orient markerUnits role dx dy
    letter-spacing version""".split()
)
_DECL = re.compile(r"<!\s*(DOCTYPE|ENTITY|ELEMENT|ATTLIST)", re.I)


def _local(name: str) -> tuple[str | None, str]:
    if name.startswith("{"):
        ns, _, local = name[1:].partition("}")
        return ns, local
    return None, name


def sanitize_svg(candidate: str, *, title: str) -> Sanitized:
    """A static, offline, grayscale SVG from an agent's flow diagram."""
    if _DECL.search(candidate):
        return Sanitized("", blocked=["DOCTYPE or entity declarations are not allowed"])
    try:
        parser = ET.XMLParser(target=ET.TreeBuilder(insert_comments=False, insert_pis=False))
        root = ET.fromstring(candidate, parser=parser)
    except ET.ParseError as exc:
        return Sanitized("", blocked=[f"not well-formed SVG: {exc}"])
    if _local(root.tag) != (SVG_NS, "svg"):
        return Sanitized("", blocked=["the root element must be <svg> in the SVG namespace"])
    blocked: list[str] = []
    removed: list[str] = []
    targets: set[str] = set()
    count = 0

    def note(bucket: list[str], what: str) -> None:
        if what not in bucket:
            bucket.append(what)

    def copy(src: ET.Element, depth: int) -> ET.Element | None:
        nonlocal count
        count += 1
        ns, tag = _local(src.tag)
        if tag in SVG_BLOCKED:
            note(blocked, f"<{tag}> element")
            return None
        if ns != SVG_NS or tag not in SVG_TAGS:
            note(removed, f"<{tag}> element")
            return None
        if depth > MAX_DEPTH:
            note(removed, "elements nested too deeply")
            return None
        dst = ET.Element(f"{{{SVG_NS}}}{tag}")
        for raw, value in src.attrib.items():
            ans, name = _local(raw)
            lowered = value.lower().replace(" ", "")
            if name.lower().startswith("on"):
                note(blocked, f"event handler attribute {name} on <{tag}>")
                continue
            if "javascript:" in lowered or "vbscript:" in lowered:
                note(blocked, f"script URL in {name} on <{tag}>")
                continue
            if name == "href" and ans in (None, XLINK_NS):
                if tag == "use" and _FRAGMENT.fullmatch(value.strip()):
                    dst.set("href", value.strip())
                else:
                    note(blocked, f"href={value[:60]!r} on <{tag}> would load or navigate")
                continue
            if ans is not None:
                note(removed, f"attribute {name} ({ans})")
                continue
            if name.startswith("aria-") or name.startswith("data-"):
                dst.set(name, value)
            elif name in SVG_ATTRS:
                if name == "style" or "url(" in lowered:
                    problems = css_problems(value, local_urls=True)
                    for p in problems:
                        note(blocked, f"{p} ({name} on <{tag}>)")
                    if problems:
                        continue
                dst.set(name, value)
            else:
                note(removed, f"attribute {name} on <{tag}>")
                continue
            if name in ("id", "data-annotation") and value:
                targets.add(value)
        if tag == "style":
            problems = css_problems(src.text or "", local_urls=True)
            for p in problems:
                note(blocked, f"{p} (<style>)")
            dst.text = "" if problems else (src.text or "")
            return dst
        dst.text = src.text
        for child in src:
            kept = copy(child, depth + 1)
            if kept is not None:
                kept.tail = child.tail
                dst.append(kept)
            # The text after a dropped child is kept on the previous sibling or parent.
            elif child.tail:
                if len(dst):
                    dst[-1].tail = (dst[-1].tail or "") + child.tail
                else:
                    dst.text = (dst.text or "") + child.tail
        return dst

    clean = copy(root, 0)
    if count > MAX_NODES:
        return Sanitized("", blocked=[f"more than {MAX_NODES} elements"])
    assert clean is not None
    style = clean.get("style", "").rstrip("; ")
    clean.set("style", (style + "; " if style else "") + "filter:grayscale(100%)")
    if clean.find(f"{{{SVG_NS}}}title") is None:
        t = ET.Element(f"{{{SVG_NS}}}title")
        t.text = title
        clean.insert(0, t)
    ET.register_namespace("", SVG_NS)
    content = ET.tostring(clean, encoding="unicode") + "\n"
    out = Sanitized(content, blocked, removed, targets)
    out.blocked += [p for p in static_problems(content, "svg") if p not in out.blocked]
    return out


# --- the final check (also what the tests assert) ---------------------------------------

_STATIC_CHECKS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("a script element", re.compile(r"<\s*script", re.I)),
    ("an event handler attribute", re.compile(r"<[^>]*[\s/\"'] on[a-z]+\s*=", re.I | re.X)),
    ("a script URL", re.compile(r"(java|vb)script\s*:", re.I)),
    (
        "an external URL",
        re.compile(
            r"(src|href|action|formaction|xlink:href)\s*=\s*['\"]?\s*"
            r"(?!#)[^'\"\s>]",
            re.I,
        ),
    ),  # fmt: skip
    (
        "a frame, object or embed",
        re.compile(r"<\s*(iframe|frame|object|embed|applet|portal)\b", re.I),
    ),  # fmt: skip
    (
        "an image or media element",
        re.compile(r"<\s*(img|image|video|audio|source|picture)\b", re.I),
    ),  # fmt: skip
    ("a stylesheet link or base", re.compile(r"<\s*(link|base)\b", re.I)),
    ("a refresh", re.compile(r"http-equiv\s*=\s*['\"]?refresh", re.I)),
    ("a foreignObject", re.compile(r"foreignObject", re.I)),
    ("a CSS import", re.compile(r"@import", re.I)),
    ("a CSS escape", re.compile(r"<style[^>]*>[^<]*\\", re.I)),
)
_ANY_URL = re.compile(r"url\s*\(\s*['\"]?\s*(?!#)", re.I)


def static_problems(content: str, kind: str) -> list[str]:
    """What in a design output could run or fetch; empty when it is static and offline."""
    # Entities decoded too: &#114;efresh is a refresh.
    decoded = html.unescape(content)
    out = [
        f"contains {what}"
        for what, rx in _STATIC_CHECKS
        if rx.search(content) or rx.search(decoded)
    ]
    if _ANY_URL.search(content) or _ANY_URL.search(decoded):
        out.append("contains a CSS url() that is not an in-document reference")
    if kind == "html" and "Content-Security-Policy" not in content:
        out.append("has no Content-Security-Policy")
    return out
