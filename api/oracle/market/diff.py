"""Text normalisation and the line diff between two reads of a watched page (no model).

A read's text is normalised before it is hashed and compared: whitespace collapsed in
each line, empty lines dropped. The diff keeps at most :data:`MAX_LINES` lines; its
counts are of every added and removed line.
"""

import difflib
import hashlib
from dataclasses import dataclass
from typing import Any

MAX_LINES = 200
# A change of this many lines or fewer is minor until the digest run rates it.
MINOR_LINES = 3


def normalise(text: str) -> str:
    lines = (" ".join(line.split()) for line in (text or "").replace("\r", "\n").split("\n"))
    return "\n".join(line for line in lines if line)


def content_hash(title: str | None, text: str) -> str:
    return hashlib.sha256(f"{title or ''}\n{text}".encode()).hexdigest()


@dataclass(frozen=True)
class Diff:
    added: int
    removed: int
    lines: list[dict[str, Any]]

    @property
    def rating(self) -> str:
        return "minor" if self.added + self.removed <= MINOR_LINES else "notable"


def line_diff(before: str, after: str) -> Diff:
    """The lines removed from ``before`` and added in ``after`` (both normalised)."""
    added = removed = 0
    lines: list[dict[str, Any]] = []
    for line in difflib.ndiff(before.split("\n") if before else [], after.split("\n")):
        op, text = line[:1], line[2:]
        if op not in ("+", "-"):
            continue
        if op == "+":
            added += 1
        else:
            removed += 1
        if len(lines) < MAX_LINES:
            lines.append({"op": op, "text": text})
    return Diff(added=added, removed=removed, lines=lines)
