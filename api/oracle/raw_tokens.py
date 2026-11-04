"""Raw tokens in generated text: one sanitizer for everything people are shown or export.

A writer cites with ``[c:id]`` (a PRD's sources), ``[l:n]`` (a reply's live reads) and
``[s:id]``; none of them is words a person reads. :func:`strip_raw_tokens` drops them, with
the space before each ("appears [c:c1]." -> "appears."); :func:`markdown_footnotes` turns
the ``[c:id]`` a document defines into the Markdown footnotes its export reads, and drops
the ones that point to nothing. web/lib/raw-tokens.ts is the web's counterpart.
"""

import re
from collections.abc import Callable, Mapping

# One marker: "[c:", "[l:" or "[s:", an id without brackets or line breaks, "]". A match
# starts only at the head of a space run, so a long run is scanned once.
RAW_TOKEN = re.compile(r"(?<![ \t])[ \t]*\[[cls]:[^\[\]\n]*\]")
# What is left of a nested or unclosed marker after stripping: its opener.
_OPENER = re.compile(r"\[[cls]:")
# [c:c1] or [c:c1, c2]
_CITE = re.compile(r"(?<![ \t])[ \t]*\[c:\s*([^\[\]\n]*?)\s*\]")


def has_raw_tokens(text: str | None) -> bool:
    """Whether ``text`` carries a marker opener a person would see ("[c:", "[l:", "[s:")."""
    return bool(text) and _OPENER.search(text) is not None


def strip_raw_tokens(text: str) -> str:
    """``text`` without its raw markers; a nested one (``[c:[c:x]]``) leaves nothing."""
    for _ in range(4):
        out = RAW_TOKEN.sub("", text)
        if out == text:
            break
        text = out
    return _OPENER.sub("", text) if _OPENER.search(text) else text


def strip_opt(text: str | None) -> str | None:
    """:func:`strip_raw_tokens` of an optional text."""
    return None if text is None else strip_raw_tokens(text)


def markdown_footnotes(markdown: str, label: Callable[[str], str | None]) -> str:
    """``markdown`` with each ``[c:id]`` as a Markdown footnote reference (``[^1]``),
    numbered in order of first use, and their definitions at the end (``[^1]: label``).
    A key ``label`` gives None for points to nothing and is dropped; any other raw marker
    is dropped too."""
    numbers: dict[str, int] = {}
    notes: list[str] = []

    def ref(m: re.Match[str]) -> str:
        refs = []
        for key in (k.strip() for k in m.group(1).split(",")):
            if not key:
                continue
            if key not in numbers:
                text = label(key)
                if text is None:
                    continue
                numbers[key] = len(numbers) + 1
                notes.append(f"[^{numbers[key]}]: {strip_raw_tokens(text).strip()}")
            refs.append(f"[^{numbers[key]}]")
        return "".join(refs)

    body = strip_raw_tokens(_CITE.sub(ref, markdown))
    if not notes:
        return body
    return body.rstrip("\n") + "\n\n" + "\n".join(notes) + "\n"


def citation_labels(rows: Mapping[str, object]) -> Callable[[str], str | None]:
    """A :func:`markdown_footnotes` label from citations by key: the source's title and
    where it is ("Customer interview notes (upload: notes.pdf)")."""

    def label(key: str) -> str | None:
        c = rows.get(key)
        if c is None:
            return None
        title = getattr(c, "title", None) or getattr(c, "excerpt", None) or ""
        where = " ".join(x for x in (getattr(c, "source", None), getattr(c, "ref", None)) if x)
        text = f"{title} ({where})" if title and where else title or where
        return " ".join(text.split()) or None

    return label
