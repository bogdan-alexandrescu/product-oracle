"""#680 re-review: what each audience hides in written item text (oracle.roadmap.variants).

The cases in ``fixtures/audience_redaction.json`` are shared with the web mock
(web/e2e/audience-redaction.spec.ts runs the same table through
web/lib/api/mock/audience.ts), so the mock and the API agree on every one. Invented
data only.
"""

import json
import random
import re
from pathlib import Path

import pytest

from oracle.roadmap import variants

CASES = json.loads((Path(__file__).parent / "fixtures" / "audience_redaction.json").read_text())


def _items(case: dict) -> list[variants.ItemView]:
    return [
        variants.ItemView(
            key=f"item-{n}",
            title=i["title"],
            outcome=None,
            horizon="now",
            position=n,
            tracker=[(ref, None) for ref in i.get("tracker", [])],
            no_goal=bool(i.get("no_goal")),
        )
        for n, i in enumerate(case["items"])
    ]


def render(case: dict, audience: str) -> str:
    """The case's text as ``audience`` shows it; Board leaves the goal-less items out."""
    items = _items(case)
    drop = [i.title for i in items if i.no_goal] if audience == "board" else []
    return variants.redact(case["text"], variants.VARIANTS[audience], items, drop)


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_shared_redaction_cases(case):
    """protects=#680 re-review majors 1-4 and minors: every GFM table form, owner labels
    with qualifiers and emphasis, short titles dropping only their own entries, spacing,
    dashes and HTML tags kept, as the mock does (same table); fails_when=an owner or
    estimate shows on Board, or a shown item's line is dropped; no_claim=rendered HTML."""
    for audience in ("board", "team", "engineering"):
        assert render(case, audience) == case[audience], audience


# --- property: no owner name or estimate survives on Board ------------------------------

NAMES = ["Zed Quorra", "Dr. Ilse Vantor", "Prof. A. B. Smithwick", "Oona K. Brask", "Tamsin"]
NAME_MARKS = ["Quorra", "Vantor", "Smithwick", "Brask", "Tamsin"]
ESTIMATES = ["9119 points", "9119w", "L (9119)"]
OWNER_HEADERS = ["Owner", "Owners", "Owner(s)", "**Owner**", "_Owner_", "*Owner*", "Lead"]
OWNER_HEADERS += ["Tech lead", "Eng lead", "PM", "Lead PM", "Owner / PM", "Who", "DRI"]
OWNER_HEADERS += ["Assignee", "Owner (PM)"]
EST_HEADERS = ["Est.", "Estimate", "Story points", "Points", "Size", "**Est.**", "Effort"]
OTHER_HEADERS = ["Item", "Goal", "Note", "Quarter"]
SEPARATORS = [":", " —", " –", " -"]


def _table(rnd: random.Random) -> str:
    heads = [rnd.choice(OTHER_HEADERS)]
    heads += rnd.sample(OWNER_HEADERS, rnd.randint(0, 2))
    heads += rnd.sample(EST_HEADERS, rnd.randint(0, 2))
    heads += rnd.sample(OTHER_HEADERS, rnd.randint(0, 2))
    rnd.shuffle(heads)
    outer = rnd.random() < 0.5

    def row(cells: list[str]) -> str:
        line = " | ".join(cells)
        return f"| {line} |" if outer else line

    def sep() -> str:
        dash = "-" * rnd.randint(1, 4)
        return rnd.choice(["", ":"]) + dash + rnd.choice(["", ":"])

    seps = [sep() for _ in heads]
    if not outer and seps[0] == "-":
        seps[0] = "--"  # "- | --" starts a list, not a table (GFM, markdown-it)
    rows = [row(heads), row(seps)]
    for _ in range(rnd.randint(1, 3)):
        cells = []
        for h in heads:
            if h in OWNER_HEADERS:
                cells.append(rnd.choice(NAMES))
            elif h in EST_HEADERS:
                cells.append(rnd.choice(ESTIMATES))
            elif rnd.random() < 0.3:
                cells.append(_labelled(rnd))
            else:
                cells.append("CSV parser")
        rows.append(row(cells))
    if rnd.random() < 0.3:
        rows.append(rnd.choice(["---", "| -- | -- |", "Bulk import"]))
    return "\n".join(rows)


def _labelled(rnd: random.Random) -> str:
    if rnd.random() < 0.6:
        head, value = rnd.choice(OWNER_HEADERS), rnd.choice(NAMES)
    else:
        head, value = rnd.choice(EST_HEADERS), rnd.choice(ESTIMATES)
    if rnd.random() < 0.15 and head in ("Owner", "Owners"):
        return f"Owned by {value}"
    return f"{head}{rnd.choice(SEPARATORS)} {value}"


def _line(rnd: random.Random) -> str:
    part = _labelled(rnd)
    start = rnd.choice(["", "- ", "* ", "1. "])
    start += rnd.choice(["", "CSV parser (must). ", "CSV parser — "])
    if rnd.random() < 0.2:
        return f"{start}CSV parser ({part}) ships."
    return f"{start}{part}{rnd.choice(['', '.', '; Why: day one.', '. Why: day one.'])}"


@pytest.mark.parametrize("seed", range(4))
def test_no_owner_or_estimate_survives_on_board(seed):
    """protects=#680 re-review majors 1-3: tables and labelled lines built from a small
    grammar (pipe styles, separator widths and alignments, qualified and emphasised
    labels, rules and placeholder rows after a table) never show an owner name or an
    estimate on Board; fails_when=any generated form leaks; no_claim=free prose."""
    rnd = random.Random(seed)
    board = variants.VARIANTS["board"]
    for _ in range(250):
        text = _table(rnd) if rnd.random() < 0.5 else "\n".join(_line(rnd) for _ in range(3))
        out = variants.redact(text, board, [], [])
        leaked = [m for m in NAME_MARKS + ["9119"] if m in out]
        assert not leaked, f"{text!r}\n->\n{out!r}"
        # A table stays a table: its separator row keeps one cell per header cell.
        lines = out.split("\n")
        if len(lines) > 1 and re.fullmatch(r"[\s|:-]+", lines[1]) and "|" in lines[1]:
            assert len(variants._split_row(lines[1])) == len(variants._split_row(lines[0])), out
