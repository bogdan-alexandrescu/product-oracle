"""Section-level and word-level diff between two versions. Pure functions.

Sections are matched by ``section_key`` (stable across versions by contract):
- only in ``to``: added; only in ``from``: removed;
- in both: changed when ``content_hash`` differs, else unchanged;
- ``moved`` marks common sections outside the longest common subsequence of the two
  orders, so one inserted or removed section does not flag everything after it.

Output follows the ``to`` order; removed sections sit right after the nearest section
that preceded them in ``from`` and did not move.
"""

import difflib
import re
from collections.abc import Sequence
from typing import Protocol

from oracle.docs.schemas import SectionDiff, WordOp

_TOKEN_RE = re.compile(r"\s+|\w+|[^\w\s]")


class SectionLike(Protocol):
    section_key: str
    ordinal: int
    heading: str
    body_text: str
    content_hash: str


def tokenize(text: str) -> list[str]:
    """Words, whitespace runs and punctuation; ``"".join(tokenize(t)) == t``."""
    return _TOKEN_RE.findall(text)


def word_diff(old: str, new: str) -> list[WordOp]:
    a, b = tokenize(old), tokenize(new)
    ops: list[WordOp] = []

    def emit(op: str, parts: list[str]) -> None:
        text = "".join(parts)
        if not text:
            return
        if ops and ops[-1].op == op:
            ops[-1].text += text
        else:
            ops.append(WordOp(op=op, text=text))

    matcher = difflib.SequenceMatcher(a=a, b=b, autojunk=False)
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            emit("equal", a[i1:i2])
        else:
            emit("delete", a[i1:i2])
            emit("insert", b[j1:j2])
    return ops


def _lcs(a: list[str], b: list[str]) -> set[str]:
    """Keys on a longest common subsequence of two orderings (keys are unique)."""
    n, m = len(a), len(b)
    table = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n - 1, -1, -1):
        for j in range(m - 1, -1, -1):
            table[i][j] = (
                table[i + 1][j + 1] + 1 if a[i] == b[j] else max(table[i + 1][j], table[i][j + 1])
            )
    keep: set[str] = set()
    i = j = 0
    while i < n and j < m:
        if a[i] == b[j]:
            keep.add(a[i])
            i += 1
            j += 1
        elif table[i + 1][j] > table[i][j + 1]:
            i += 1
        else:
            j += 1
    return keep


def _diff_text(section: SectionLike) -> str:
    return f"{section.heading}\n{section.body_text}"


def diff_sections(old: Sequence[SectionLike], new: Sequence[SectionLike]) -> list[SectionDiff]:
    old = sorted(old, key=lambda s: s.ordinal)
    new = sorted(new, key=lambda s: s.ordinal)
    old_by_key = {s.section_key: s for s in old}
    new_by_key = {s.section_key: s for s in new}
    in_order = _lcs(
        [s.section_key for s in old if s.section_key in new_by_key],
        [s.section_key for s in new if s.section_key in old_by_key],
    )

    # Removed sections, grouped under the nearest preceding section that stayed in place.
    removed_after: dict[str | None, list[SectionDiff]] = {}
    anchor: str | None = None
    for s in old:
        if s.section_key in new_by_key:
            if s.section_key in in_order:
                anchor = s.section_key
            continue
        removed_after.setdefault(anchor, []).append(
            SectionDiff(
                section_key=s.section_key,
                status="removed",
                from_ordinal=s.ordinal,
                from_heading=s.heading,
            )
        )

    result: list[SectionDiff] = list(removed_after.get(None, []))
    for s in new:
        before = old_by_key.get(s.section_key)
        if before is None:
            result.append(
                SectionDiff(
                    section_key=s.section_key,
                    status="added",
                    to_ordinal=s.ordinal,
                    to_heading=s.heading,
                )
            )
            continue
        changed = before.content_hash != s.content_hash
        result.append(
            SectionDiff(
                section_key=s.section_key,
                status="changed" if changed else "unchanged",
                moved=s.section_key not in in_order,
                from_ordinal=before.ordinal,
                to_ordinal=s.ordinal,
                from_heading=before.heading,
                to_heading=s.heading,
                words=word_diff(_diff_text(before), _diff_text(s)) if changed else None,
            )
        )
        result.extend(removed_after.get(s.section_key, []))
    return result
