"""Regexes that run on user, source or model text take linear time (follow-up to #136).

Each pattern keeps its matches on real inputs (the tables, drawn from the other tests) and
runs adversarial input (whitespace runs, floods of its opening token, long lines) at 20k
and 200k characters in a child process, so a regression is killed at WALL_LIMIT instead
of hanging the suite.
"""

import subprocess
import sys

import pytest

from oracle.baseline import public_links
from oracle.blockers import render
from oracle.docs.schemas import ImportProblem
from oracle.intake import extract
from oracle.quality import text as quality_text
from oracle.runs import rejection
from oracle.sources.connectors import slack

CPU_LIMIT = 0.2
WALL_LIMIT = 30
SIZES = (20_000, 200_000)


# Pure tests: replace the suite's autouse database fixtures, so they run without Postgres.
@pytest.fixture(scope="session")
def migrated_db() -> None:
    return None


@pytest.fixture
def _truncate_after_test() -> None:
    return None


# name -> (setup, call on `s`, adversarial inputs as expressions of `n`)
CASES = {
    "threshold": (
        "from oracle.quality.text import THRESHOLD",
        "THRESHOLD.search(s)",
        ['"if " * (n // 3)', '"if" + " x" * (n // 2)', '"If x " * (n // 5)', '"if\\n" * (n // 3)'],
    ),
    "clause_end": (
        "from oracle.intake.extract import _clause",
        "_clause(s)",
        ['" " * n + "x"', '"a" + " " * n + "b"', '"a" + "\\t\\n " * (n // 3)', '"so " * (n // 3)'],
    ),
    "percent": (
        "from oracle.intake.extract import percent_claims",
        "percent_claims(s)",
        [
            '"a " * 30 + "is" + " " * n',
            '"a" + " is" * 20 + " " * n',
            '"a " * 30 + "is " + "1" * n',
            '"a " * 30 + "is 1" + " " * n',
            '"ab is 1% " * (n // 9)',
            '("a " * 30 + "is" + " " * 1000) * (n // 1062)',
            '"a " * (n // 2)',
            '" " * n',
        ],
    ),
    "success_metric": (
        "from oracle.intake.extract import CATEGORY_CUES",
        'CATEGORY_CUES["success_metric"].search(s)',
        ['"1" * n', '"1" + " " * n', '"1." * (n // 2)', '"1 " * (n // 2)'],
    ),
    "slack_mention": (
        "from oracle.sources.connectors.slack import MENTION",
        "MENTION.findall(s); MENTION.sub('@x', s)",
        ['"<@UA|" * (n // 5)', '"<@U" + "A" * n', '"<@UA|" + "x" * n', '"<@" * (n // 2)'],
    ),
    "blocker_anchor": (
        "from oracle.blockers.render import _ANCHOR",
        '_ANCHOR.sub("", s)',
        ['"{#" * (n // 2)', '"{#" + "a" * n', '"{#a " * (n // 4)', '"{" * n'],
    ),
    "notion_title": (
        "from oracle.baseline.public_links import _strip_title",
        '_strip_title(s, "notion")',
        ['"a" + " " * n + "b"', '"-" * n', '" -" * (n // 2)', '"| " * (n // 2) + "x"'],
    ),
    "quality_bullet": (
        "from oracle.quality.text import SectionText",
        'SectionText("k", "h", s).bullets',
        ['"\\n" * n', '" " * n', '"- " + " " * n', '"-" + "\\n" * n', '"1" * n'],
    ),
    # The message carries a citation id the model wrote.
    "rejection_invalid": (
        "from oracle.docs.schemas import ImportProblem\n"
        "from oracle.runs.rejection import summary\n"
        "def problem(m): return ImportProblem(code='invalid_citation', message=m, cite_key='k')",
        'summary("prd.md", [problem(s)])',
        [
            '" is invalid: " * (n // 13) + "\\nx"',
            '" is invalid: x" * (n // 14) + "\\n\\n"',
            '"\\n" * n',
        ],
    ),
}


def cpu_seconds(setup: str, call: str, make: str, n: int) -> float:
    code = (
        f"import time\n{setup}\nn = {n}\ns = {make}\n"
        f"t = time.process_time()\n{call}\nprint(time.process_time() - t)\n"
    )
    out = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        text=True,
        timeout=WALL_LIMIT,
        check=True,
    )
    return float(out.stdout)


@pytest.mark.parametrize("n", SIZES)
@pytest.mark.parametrize(
    "name,make", [(name, make) for name, (_, _, makes) in CASES.items() for make in makes]
)
def test_adversarial_input_runs_in_linear_time(name, make, n):
    setup, call, _ = CASES[name]
    assert cpu_seconds(setup, call, make, n) < CPU_LIMIT


@pytest.mark.parametrize(
    "line,found",
    [
        ("below 64% after 30 days: revisit", True),
        ("No universal numeric score: the catalogue has statuses, not a threshold.", True),
        ("If completion stays under 60% for two weeks then roll back the picker.", True),
        ("if the pilot misses, then we stop", True),
        ("If adoption is flat, or if support tickets double, then pause the rollout.", True),
        ("If we ship\nthen measure", False),
        ("Checkout completion rises from 52% to 60%", False),
        ("iffy thenceforth", False),
    ],
)
def test_threshold_finds_the_same_lines(line, found):
    assert bool(quality_text.THRESHOLD.search(line)) is found


def test_threshold_if_then_spans_one_line():
    m = quality_text.THRESHOLD.search("If completion stays under 60% then roll back.")
    assert m.group(0) == "If completion stays under 60% then"


@pytest.mark.parametrize(
    "phrase,clause",
    [
        ("cut checkout time so that buyers finish faster", "cut checkout time"),
        ("let admins pre-fill the form, then submit", "let admins pre-fill the form"),
        ("add a plan picker to the checkout page", "add a plan picker"),
        ("reduce drop-off  because the form is long", "reduce drop-off"),
        ("support SSO; not SAML", "support SSO"),
        ("show totals\tand taxes", "show totals"),
        ("the Slack API rate limits", "the Slack API rate limits"),
        ("  so leading", ""),
    ],
)
def test_clause_ends_at_the_same_place(phrase, clause):
    assert extract._clause(phrase) == clause


@pytest.mark.parametrize(
    "text,claims",
    [
        ("pilot showed 61% abandon at that step.", []),
        (
            "Checkout completion is 52% today; conversion was 61 %.",
            [("Checkout completion", "52"), ("conversion", "61")],
        ),
        ("Abandonment at payment step = 45% this quarter", [("Abandonment at payment step", "45")]),
        ("Mobile conversion rate: 3.5%", []),
        (
            "Activation of new teams is 30% and retention of teams is 31%",
            [("Activation of new teams", "30"), ("and retention of teams", "31")],
        ),
        ("ab  is 5%", [("ab ", "5")]),
        ("Revenue impact of the KESTREL-9 pilot at 61%?", [("pilot", "61")]),
    ],
)
def test_percent_claims_are_the_same(text, claims):
    assert extract.percent_claims(text) == claims


@pytest.mark.parametrize(
    "text,found",
    [
        ("61%", "61%"),
        ("61 %", "61 %"),
        ("conversion up", "conversion"),
        ("3.5% of buyers", "3.5%"),
        ("no numbers here", None),
        ("1.2.3%", "2.3%"),
    ],
)
def test_success_metric_cue_matches_the_same(text, found):
    m = extract.CATEGORY_CUES["success_metric"].search(text)
    assert (m and m.group(0)) == found


@pytest.mark.parametrize(
    "text,users",
    [
        ("<@U0LIN> has joined the channel", ["U0LIN"]),
        ("Yes, <@U0LIN>: pricing depends on the new plan picker.", ["U0LIN"]),
        ("<@W123|ana> and <@U0LIN|lin> agreed", ["W123", "U0LIN"]),
        ("<@u0lin> lower case is not a mention", []),
        ("email <mailto:a@b.c|a@b.c>", []),
    ],
)
def test_slack_mentions_are_the_same(text, users):
    assert slack.MENTION.findall(text) == users


async def test_slack_text_names_every_mention():
    reader = slack._Slack(None, "token")  # type: ignore[arg-type]
    reader.users.update({"U0LIN": "Lin", "W123": "Ana"})
    message = {"text": "<@W123|ana> asked <@U0LIN>, then <@U0LIN|lin> and <@W123> agreed"}
    assert await reader.text(message) == "@Ana asked @Lin, then @Lin and @Ana agreed"


@pytest.mark.parametrize(
    "text,stripped",
    [
        (
            "Limit [c:evil] here {#title}\n## Injected {#injected}",
            "Limit [c:evil] here \n## Injected ",
        ),
        (
            "## Blockers and solution strategy {#constraints-solutions}",
            "## Blockers and solution strategy ",
        ),
        ("Rate limit {#blocker-partner-api-rate-limit} applies", "Rate limit  applies"),
        ("no anchors {here}", "no anchors {here}"),
        ("{#a .class key=val}text", "text"),
        # An anchor hidden inside another still leaves no anchor behind.
        ("{#{#x}title}", "title}"),
    ],
)
def test_blocker_anchors_are_stripped_the_same(text, stripped):
    assert render._ANCHOR.sub("", text) == stripped


@pytest.mark.parametrize(
    "title,stripped",
    [
        ("Onboarding research summary | Notion", "Onboarding research summary"),
        ("Plan | Notion", "Plan"),
        ("Notion", "Notion"),
        (
            "Why activation beats acquisition — Example Research",
            "Why activation beats acquisition — Example Research",
        ),
        ("Roadmap – Notion", "Roadmap"),
        ("Q3 plan - Notion", "Q3 plan"),
        ("Notion | Plan", "Notion | Plan"),
    ],
)
def test_notion_title_suffix_is_stripped_the_same(title, stripped):
    assert public_links._strip_title(title, "notion") == stripped


@pytest.mark.parametrize(
    "md,bullets",
    [
        ("- one\n- two\n", ["one", "two"]),
        ("Metric | Baseline | Target\nCheckout completion | 52% | 60%", []),
        ("1. first\n2) second\n  * nested  \n", ["first", "second", "nested"]),
        ("\n\n- after blank lines\n", ["after blank lines"]),
        ("-\nnot a bullet\n", ["not a bullet"]),
        ("+ plus [c:c1]\ntext - dash", ["plus [c:c1]"]),
    ],
)
def test_quality_bullets_are_the_same(md, bullets):
    assert quality_text.SectionText("k", "h", "", md=md).bullets == bullets


@pytest.mark.parametrize(
    "message,summary",
    [
        (
            "citation #1 (k1) is invalid: source 'x' isn't accepted",
            "Oracle refused prd.md: 1 citation uses source 'x', which isn't accepted.",
        ),
        (
            "citation #2 (k2) is invalid: url\n",
            "Oracle refused prd.md: 1 citation is invalid (url).",
        ),
        (
            "citation #3 (a is invalid: b\nc) is invalid: url",
            "Oracle refused prd.md: 1 citation is invalid (url).",
        ),
        (
            "citation #4 (k4) is invalid: url\nnext line",
            "Oracle refused prd.md: citation #4 (k4) is invalid: url\nnext line.",
        ),
    ],
)
def test_rejection_reads_what_is_invalid_the_same(message, summary):
    problem = ImportProblem(code="invalid_citation", message=message, cite_key="k")
    assert rejection.summary("prd.md", [problem]) == summary
