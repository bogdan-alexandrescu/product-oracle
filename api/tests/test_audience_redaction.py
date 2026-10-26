"""What each audience shows of a roadmap's written text (oracle.roadmap.variants).

Team and Engineering keep the written text without what they hide; the cases in
``fixtures/audience_redaction.json`` are shared with the web mock
(web/e2e/audience-redaction.spec.ts runs the same table through
web/lib/api/mock/audience.ts), so the mock and the API agree on every one.

Board (owner decision 2026-10-26) renders from the roadmap items alone: each shown
item's title, outcome, confidence and goal, grouped by horizon, and no written text of
any form. Invented data only.
"""

import json
import random
import re
from pathlib import Path

import pytest

from oracle.docs.models import Section
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


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_team_and_engineering_redaction_cases(case):
    """protects=Team and Engineering render the written text as before (the mock does
    the same, same table); fails_when=an estimate or tracker part shows where hidden, or
    a line is lost; no_claim=Board (built from items only, below)."""
    items = _items(case)
    for audience in ("team", "engineering"):
        got = variants.redact(case["text"], variants.VARIANTS[audience], items)
        assert got == case[audience], audience


# --- Board: the items' rows and nothing written --------------------------------------

# Words Board may write itself: its headings, column heads and the left-out and no-items
# lines. Anything else must come from a shown item's title, outcome, confidence or goal.
BOARD_WORDS = {"now", "next", "later", "item", "items", "outcome", "confidence", "goal"}
BOARD_WORDS |= {"serve", "serves", "no", "confirmed", "and", "is", "are", "left", "out"}
BOARD_WORDS |= {"this", "roadmap", "version", "has", "structured", "so", "board", "rows"}
BOARD_WORDS |= {"to", "show", "built", "from", "its", "only", "never", "written", "text"}
BOARD_WORDS |= {"yet", "the", "a", "of"} | {str(n) for n in range(10)}


def _words(text: str) -> set[str]:
    return {w.lower() for w in re.findall(r"[^\W_]+", text)}


def _sections(text: str, items: list[variants.ItemView]) -> list[Section]:
    """A version whose every section, card and item area holds ``text``."""
    rows = [("roadmap", 1, "Written roadmap heading"), ("summary", 2, "Summary")]
    rows += [("brief-items", 2, "Items by horizon"), ("now", 2, "Now")]
    rows += [(f"now-{i.key}", 3, i.title) for i in items]
    rows += [("next", 2, "Next"), ("releases", 2, "Releases"), ("release-1", 3, "Release one")]
    rows += [("timeline", 2, "Timeline"), ("lane-a", 3, "Lane heading"), ("ideas", 2, "Ideas")]
    rows += [("not-doing", 2, "Not doing"), ("decisions", 2, "Decisions needed")]
    return [
        Section(
            section_key=k,
            ordinal=n,
            level=lv,
            heading=h,
            body_md=text,
            body_text=text,
            content_hash="h",
            citation_keys=[],
            layer="detail",
        )  # fmt: skip
        for n, (k, lv, h) in enumerate(rows)
    ]


def _board_items(case_items: list[dict]) -> list[variants.ItemView]:
    return [
        variants.ItemView(
            key=f"item-{n}",
            title=i["title"],
            outcome=f"Outcome {n} lands",
            horizon=("now", "next", "later")[n % 3],
            position=n,
            confidence="high",
            tracker=[(ref, None) for ref in i.get("tracker", [])],
            goals=[] if i.get("no_goal") else [f"Goal {n}"],
            no_goal=bool(i.get("no_goal")),
        )
        for n, i in enumerate(case_items)
    ]


def _board(text: str, items: list[variants.ItemView]) -> str:
    out = variants.rebuild(_sections(text, items), "board", items, set())
    return "\n".join(f"{s.heading}\n{s.body_md}" for s in out)


def assert_rows_only(text: str, items: list[variants.ItemView]) -> str:
    """Board of a version written with ``text``: the same as with nothing written, no
    word that is not Board's own or a shown item's, and every shown item's title,
    outcome, confidence and goal."""
    out = _board(text, items)
    assert out == _board("", items), out
    shown = [i for i in items if not i.no_goal]
    allowed = BOARD_WORDS | _words(" ".join(f"{i.title} {i.outcome} {i.confidence} "
                                            f"{' '.join(i.goals)}" for i in shown))  # fmt: skip
    assert _words(out) <= allowed, (_words(out) - allowed, out)
    assert "<" not in out and ">" not in out and "`" not in out, out
    for i in shown:
        assert i.title in out and i.outcome in out and i.goals[0] in out, out
        assert re.search(rf"\| {re.escape(i.title)} \| {i.outcome} \| high \| {i.goals[0]} \|", out)
    for i in items:
        if i.no_goal:
            assert not re.search(rf"\| {re.escape(i.title)} \|", out), out
    return out


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_board_shows_no_written_text_in_any_case(case):
    """protects=owner decision 2026-10-26 (#692 review majors 1-3 moot): whatever the
    written text holds (tables in blockquotes and nested lists, owner labels of any
    qualifier, estimate headers, task-list bullets, a left-out item's heading, HTML),
    Board shows only the items' rows; fails_when=any written word reaches Board, or a
    shown item's title, outcome, confidence or goal is missing; no_claim=Team."""
    items = _board_items(case["items"] or [{"title": "Bulk import"}])
    assert_rows_only(case["text"], items)


def test_board_leaves_out_goalless_items_and_says_how_many():
    """protects=items serving no confirmed goal stay left out (their own row only);
    fails_when=a left-out item's row shows, a shown item's row is lost, or the count is
    missing; no_claim=which goal an item serves (oracle.launches.tiers)."""
    items = _board_items([{"title": "Import", "no_goal": True}, {"title": "Import wizard"},
                          {"title": "SSO"}, {"title": "Audit", "no_goal": True}])  # fmt: skip
    out = assert_rows_only("- Import: a second importer\n- Import wizard: guided", items)
    assert "2 items serve no confirmed goal and are left out." in out
    assert "Import wizard" in out and "second importer" not in out


def test_board_of_a_version_without_items_says_so_in_words():
    """protects=a version with no roadmap_items renders a sentence, never the written
    text; fails_when=Board falls back to the prose; no_claim=Team (written text)."""
    out = variants.rebuild(_sections("| Item | Owner |\n|---|---|\n| CSV | Dana |", []),
                           "board", [], set())  # fmt: skip
    assert [s.body_md for s in out] == [variants.BOARD_NO_ITEMS]
    assert _words(f"{out[0].heading} {out[0].body_md}") <= BOARD_WORDS


def test_board_rows_are_grouped_by_horizon_and_capped():
    """protects=Board groups rows as before (Now, Next, Later; at most 7 per horizon,
    best ranked first); fails_when=a row sits under another horizon or the cap is lost;
    no_claim=grouping by goal (an open owner question)."""
    items = [
        variants.ItemView(key=f"k{n}", title=f"Row {n}", outcome="Lands", horizon="now",
                          position=n, rank=float(10 - n), confidence="low", goals=["Grow"])
        for n in range(9)
    ] + [variants.ItemView(key="z", title="Later row", outcome="Ships", horizon="later",
                           position=9, confidence="medium")]  # fmt: skip
    out = variants.rebuild(_sections("Written.", items), "board", items, set())
    assert [(s.section_key, s.heading) for s in out] == [("now", "Now"), ("later", "Later")]
    now_rows = [ln for ln in out[0].body_md.split("\n") if ln.startswith("| Row")]
    assert [r.split(" | ")[0] for r in now_rows] == [f"| Row {n}" for n in range(8, 1, -1)]
    # An item with no goal link where the tenant has no confirmed goal: an empty cell.
    assert "| Later row | Ships | medium |  |" in out[1].body_md


# --- property: no written text of any form reaches Board -------------------------------

NAMES = ["Zed Quorra", "Dr. Ilse Vantor", "Prof. A. B. Smithwick", "Oona K. Brask", "Tamsin"]
ESTIMATES = ["9119 points", "9119w", "L (9119)"]
QUALIFIERS = ["", "Tech ", "Frontend ", "QA ", "Feature ", "Growth squad ", "Co-"]
OWNER_HEADERS = ["Owner", "Owners", "Owner(s)", "**Owner**", "_Owner_", "*Owner*", "Lead"]
OWNER_HEADERS += ["PM", "Owner / PM", "Who", "DRI", "Assignee", "Owner (PM)", "Champion"]
EST_HEADERS = ["Est.", "Estimate", "Story points", "Points", "Size", "**Est.**", "Effort"]
EST_HEADERS += ["Est. effort", "T-shirt", "Days"]
OTHER_HEADERS = ["Item", "Goal", "Note", "Quarter", "Lane", "Q1", "Now", "Next"]
SEPARATORS = [":", " —", " –", " -", ":**", "</b>"]
PREFIXES = ["", "> ", "    ", "  - ", "- [ ] ", "- [x] ", "1. ", "<p>", "### "]


def _table(rnd: random.Random) -> str:
    heads = [rnd.choice(OTHER_HEADERS)]
    heads += [rnd.choice(QUALIFIERS) + h for h in rnd.sample(OWNER_HEADERS, rnd.randint(0, 2))]
    heads += rnd.sample(EST_HEADERS, rnd.randint(0, 2))
    rnd.shuffle(heads)
    outer, prefix = rnd.random() < 0.5, rnd.choice(["", "> ", "    ", "  "])

    def row(cells: list[str]) -> str:
        line = " | ".join(cells)
        return prefix + (f"| {line} |" if outer else line)

    rows = [row(heads), row(["-" * rnd.randint(1, 4) + ":" * rnd.randint(0, 1) for _ in heads])]
    for _ in range(rnd.randint(1, 3)):
        rows.append(row([rnd.choice(NAMES + ESTIMATES + ["`a|b`", "CSV parser"]) for _ in heads]))
    return "\n".join(rows)


def _line(rnd: random.Random) -> str:
    head = rnd.choice(QUALIFIERS) + rnd.choice(OWNER_HEADERS + EST_HEADERS)
    value = rnd.choice(NAMES + ESTIMATES)
    start = rnd.choice(PREFIXES) + rnd.choice(["", "CSV parser (must). ", "Import — "])
    return f"{start}{head}{rnd.choice(SEPARATORS)}{rnd.choice([' ', chr(10)])}{value}."


@pytest.mark.parametrize("seed", range(4))
def test_no_written_text_of_any_form_reaches_board(seed):
    """protects=owner decision 2026-10-26: tables (any pipe style, in blockquotes and
    nested lists), owner labels of any qualifier, estimate headers, task lists, headings,
    HTML and code spans, all drawn from a small grammar, never reach Board, whose rows
    stay whole; fails_when=any generated text shows on Board; no_claim=Team."""
    rnd = random.Random(seed)
    for _ in range(60):
        text = "\n\n".join(
            _table(rnd) if rnd.random() < 0.5 else "\n".join(_line(rnd) for _ in range(3))
            for _ in range(rnd.randint(1, 3))
        )
        names = rnd.sample(["CSV parser", "Import", "Import wizard", "SSO", "Audit log"], 3)
        items = _board_items([{"title": t, "no_goal": rnd.random() < 0.3} for t in names])
        if all(i.no_goal for i in items):
            items[0].no_goal, items[0].goals = False, ["Goal 0"]
        assert_rows_only(text, items)
