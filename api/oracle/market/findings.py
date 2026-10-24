"""Checks on text that comes from outside the company (web results, agents' files).

- :func:`plain`: a title or summary as plain text: HTML, Markdown links, images and code
  fences removed (a link keeps its words, never its address).
- :func:`excerpt_found`: whether an excerpt appears word for word in a result's text,
  case and whitespace ignored.
- :func:`safe_markdown`: the digest's Markdown with raw HTML stripped and links kept only
  when they point at an Oracle page or at a URL the run recorded.
"""

import html
import re

_FENCE = re.compile(r"```.*?(```|$)", re.S)
_TAG = re.compile(r"<[^>]*>")
_IMAGE = re.compile(r"!\[([^\]]*)\]\([^)]*\)")
_LINK = re.compile(r"\[([^\]]*)\]\(([^)\s]*)(?:\s+\"[^\"]*\")?\)")
_REF_DEF = re.compile(r"^\s*\[[^\]]+\]:\s*\S+.*$", re.M)
_BARE = re.compile(r"(?<![(\w/])(?:https?|ftp|javascript|data):[^\s<>)\]]+", re.I)
_WWW = re.compile(r"(?<![\w/.])www\.[^\s<>)\]]+", re.I)


def plain(text: str) -> str:
    text = _FENCE.sub(" ", text or "")
    text = _IMAGE.sub(r"\1", text)
    text = _LINK.sub(r"\1", text)
    text = _REF_DEF.sub("", text)
    text = _TAG.sub("", html.unescape(_TAG.sub("", text)))
    text = text.replace("`", "")
    return " ".join(text.split())


def _norm(text: str) -> str:
    return " ".join((text or "").split()).casefold()


def excerpt_found(excerpt: str, source: str) -> bool:
    e = _norm(excerpt)
    return bool(e) and e in _norm(source)


def _oracle(url: str) -> bool:
    # A browser reads a backslash as "/": "/" then "/" or a backslash is "//host", another
    # site (_LINK's destination holds no whitespace).
    return url.startswith("/") and url[1:2] not in ("/", "\\")


def safe_markdown(text: str, recorded: set[str]) -> str:
    """Raw HTML stripped; a Markdown link kept only to an Oracle page (``/…``) or a URL in
    ``recorded``; any other address in the text dropped."""
    text = _TAG.sub("", text or "")
    text = _IMAGE.sub(r"\1", text)
    text = _REF_DEF.sub("", text)
    kept: list[str] = []

    def link(m: re.Match[str]) -> str:
        words, url = m.group(1), m.group(2)
        if _oracle(url) or url in recorded:
            kept.append(f"[{words}]({url})")
            return f"\x00{len(kept) - 1}\x00"
        return words

    text = _LINK.sub(link, text)
    text = _BARE.sub(lambda m: m.group(0) if m.group(0) in recorded else "", text)
    text = _WWW.sub("", text)
    text = text.replace("<", "")
    return re.sub(r"\x00(\d+)\x00", lambda m: kept[int(m.group(1))], text).strip()
