"""The one-pager of a run-written PRD reads as the PRD says (CLD's walk B on production,
2026-11-01): outcomes with how they are measured, one plain line of who has it, codes with
their names in a sentence that still reads, month-first dates, no pointer, nothing cut, and
"Needs a look" only for a real disagreement. Invented PRD sections.

Test cards (protects / fails_when / no_claim):

- test_measure_from_success_lines: protects=an outcome whose Success measures line says how
  in its own words ("recomputed daily", "reported weekly per person") shows that, with its
  source and no citation id, never its target or time frame; fails_when=it reads "How it is
  measured is not in the PRD yet" or carries the target; no_claim=the web's words.
- test_who_has_it_one_plain_line: protects=a users section with Primary, Secondary, Not the
  target, a hypothesis note and a job story names the primary people in one line; a section
  of only a job story and prose names the people of the prose, whole; fails_when=labels
  only ("Primary; Secondary; ...") or a cut job story ("..., I").
- test_codes_keep_the_sentence: protects=a code named by its feature's own section gets that
  name; a requirement's "F-01: every newly ..." is not its name; a code already named where it
  stands gets none again; fails_when=the sentence breaks ("F-01 every newly connected ...").
- test_generated_words_read_month_first_and_whole: protects=ISO dates read month first, no
  anchors, and a target an older build cut mid-word reads whole; the job's answer cuts at a
  word; fails_when=an ISO date, "(#...)" or "80% of acc" shows.
- test_needs_a_look_only_for_real_disagreement: protects=a count in a milestone's prose
  above its scope, exit and date lines is no disagreement; a count against a list of the
  same things still is; fails_when=the milestone is a "Needs a look" item, or the real one
  is not.
- test_measure_is_the_lines_own_words_never_a_citation: protects=an outcome shows only the
  measure its PRD line says in words (what is counted and where); one whose definition is
  only citations (a meeting's, a feature's) has none ("How it is measured is not in the PRD
  yet"); fails_when=a citation's excerpt (one quote on several outcomes, or cut with "…") or
  a citation's title with its label ("(current name)") is a measure or its source.
"""

# ruff: noqa: E501 - the fixture sections keep their long lines
import inspect

from oracle.docs.models import Section
from oracle.simple import one_pager
from oracle.simple import one_pager_checks as checks
from oracle.simple.schemas import OnePagerBlock, OnePagerLine, OnePagerMetric


def sec(key: str, heading: str, body: str) -> Section:
    return Section(section_key=key, heading=heading, level=3, ordinal=1, content_hash="x",
                   body_md=body, body_text=body)  # fmt: skip


SUCCESS = sec(
    "success",
    "Success measures",
    """\
- **Onboarding on time:** share of new accounts live within 30 days, from 55% to 80% by Mar 31, 2027; recomputed daily from the onboarding tracker [c:c2].
- **Hours saved per manager:** from 0 to 3 hours a week by the end of Q2, reported weekly per person [c:c3].
- Albums renamed by hand from 30% to 10%""",
)

WHO = sec(
    "audience",
    "Who has it",
    """\
- **Primary:** Customer success managers who run onboarding for new accounts [c:c1].
- **Secondary:** Account owners who watch onboarding across their book [c:c2].
- **Not the target:** Self-serve customers with no assigned manager [c:c3].
- The primary segment is a hypothesis until the pilot confirms it [c:c1].

**Job story:** When a new customer's onboarding is running late, I want to know before they do, so I can step in [c:c1].""",
)


def outcome(text: str, name: str, frm: str, to: str) -> OnePagerLine:
    return OnePagerLine(id="outcomes-1", text=text, source_keys=["success"],
                        metric=OnePagerMetric.model_validate({"name": name, "from": frm, "to": to}))  # fmt: skip


def test_measure_from_success_lines():
    found = {m.name: m for m in checks.measures([SUCCESS])}
    assert (
        found["Onboarding on time"].measure
        == "share of new accounts live within 30 days, recomputed daily"
    )
    assert found["Onboarding on time"].source == "the onboarding tracker"
    assert found["Hours saved per manager"].measure == "reported weekly per person"
    assert "Albums renamed by hand" not in found
    # On the page: a job's outcome line (name, from, to) finds its measure by its name.
    lines = [
        outcome("Onboarding on time from 55% to 80%", "Onboarding on time", "55%", "80%"),
        outcome(
            "Hours saved per manager from 0 to 3 hours a week",
            "Hours saved per manager",
            "0",
            "3 hours a week",
        ),
    ]
    blk = OnePagerBlock(key="outcomes", title="Outcomes", rules="", kind="metrics", lines=lines)
    checks.annotate([blk], [SUCCESS])
    assert [x.measure for x in blk.lines] == [
        "share of new accounts live within 30 days, recomputed daily",
        "reported weekly per person",
    ]
    assert "[c" not in (blk.lines[0].measure_source or "")


def test_who_has_it_one_plain_line():
    assert (
        checks.who_has_it([WHO]) == "Customer success managers who run onboarding for new accounts"
    )
    only_story = sec(
        "audience",
        "Who has it",
        "When a new customer's onboarding is running late, I want to know before they do, so I can step in. Customer success managers at mid-size software companies feel it most.",
    )
    assert (
        checks.who_has_it([only_story])
        == "Customer success managers at mid-size software companies feel it most"
    )
    # A long lead among labels is a sentence, never a cut name.
    assert (
        checks.who_has_it(
            [
                sec(
                    "u",
                    "Users",
                    "- Primary: Account owners\n- When a renewal is close, I want to see the pace",
                )
            ]
        )
        == "Account owners"
    )


def test_codes_keep_the_sentence():
    secs = [
        sec(
            "requirements",
            "Requirements",
            "- F-01: every newly connected account gets a pacing plan within a day.\n- F-02 must alert the manager.",
        ),
        sec("f-01", "F-01 Pacing plan", "A plan per account."),
        sec("f-02", "F-02 Late alerts", "An alert when a step is late."),
    ]
    names = checks.glossary(secs)
    assert names["F-01"] == "Pacing plan"
    assert checks.with_names("F-01 gives every new account a pace to follow.", names)[0] == (
        "F-01 Pacing plan gives every new account a pace to follow."
    )
    # Already named where it stands: no name put in twice.
    assert checks.with_names("Pacing plan (F-01) gives every account a pace.", names)[0] == (
        "Pacing plan (F-01) gives every account a pace."
    )
    assert (
        checks.with_names("F-02 Late alerts warn first.", names)[0]
        == "F-02 Late alerts warn first."
    )


def test_generated_words_read_month_first_and_whole():
    assert checks.month_first(
        "M1 ends 2027-03-31; see [Pacing plan](#f-01) (#feature-pacing-plan)"
    ) == ("M1 ends Mar 31, 2027; see Pacing plan")
    line = outcome(
        "Accounts live on time from 55% to 80% of accounts by 2027-03-31",
        "Accounts live on time",
        "55%",
        "80% of acc",
    )
    blk = OnePagerBlock(key="outcomes", title="Outcomes", rules="", kind="metrics", lines=[line])
    checks.annotate([blk], [])
    assert blk.lines[0].metric.to == "80% of accounts"
    assert blk.lines[0].text == "Accounts live on time from 55% to 80% of accounts by Mar 31, 2027"
    assert one_pager._upto("80% of accounts live within thirty days", 20) == "80% of accounts…"


def test_needs_a_look_only_for_real_disagreement():
    m1 = sec(
        "milestone-m1",
        "M1 Pace",
        "M1 ships two features to the first ten accounts.\n\n- **Scope:** F-01 Pacing plan, F-02 Late alerts\n- **Exit:** ten accounts on a plan\n- **Date:** Dec 18",
    )
    assert checks.numbers([m1]) == []
    real = sec(
        "brief-items",
        "Features by milestone",
        "We plan four features.\n\n| Milestone | Feature |\n|---|---|\n| M1 | F-01 Pacing plan |\n| | F-02 Late alerts |",
    )
    assert [x.text for x in checks.numbers([real])] == [
        "“four features” says 4, but “Features by milestone” shows 2 items."
    ]


# The one-pager PDF's header printed its span as "2026-11-02 – 2027-02-26".
def test_pdf_span_reads_month_first():
    from datetime import date

    assert (
        one_pager.span_words(date(2026, 11, 2), date(2027, 2, 26)) == "Nov 2, 2026 – Feb 26, 2027"
    )
    assert one_pager.span_words(date(2026, 11, 2), date(2026, 12, 23)) == "Nov 2 – Dec 23, 2026"


def test_measure_is_the_lines_own_words_never_a_citation():
    # Cited by a meeting's notes and by a feature: never the measure (vqa one-pager 2).
    success = sec(
        "success",
        "Success measures",
        "- Pages fresh within a day from 40% to 70%, counted as: [c:m1]\n"
        "- Cost per crawled page from $0.02 to $0.01, measured by: [c:m1]\n"
        "- Crawl errors a week from 300 to 100, defined as: [c:m1] [c:f2]\n"
        "- Faster fresh results, measured as: [c:f2]\n"
        "- Sites added a week from 5 to 12, counted as: sites with a first full crawl [c:m1]; source: the crawl log",
    )
    lines = [
        outcome(
            "Pages fresh within a day from 40% to 70%", "Pages fresh within a day", "40%", "70%"
        ),
        outcome(
            "Cost per crawled page from $0.02 to $0.01", "Cost per crawled page", "$0.02", "$0.01"
        ),
        outcome("Crawl errors a week from 300 to 100", "Crawl errors a week", "300", "100"),
        outcome("Faster fresh results", "Faster fresh results", "", ""),
        outcome("Sites added a week from 5 to 12", "Sites added a week", "5", "12"),
    ]
    blk = OnePagerBlock(key="outcomes", title="Outcomes", rules="", kind="metrics", lines=lines)
    # The version's citations by id (title, excerpt): a meeting's quote, long enough to be cut,
    # and a feature's title with its label. A build whose annotate still takes them (the read
    # passed them before vqa one-pager 2) gets them, so one that turns them into a measure or
    # its source fails here.
    cites = {
        "m1": (
            "Weekly crawl review (current name)",
            "we look at the fresh pages every morning and the crawl errors every Friday, "
            "then agree what to fix first and who picks it up before the next review",
        ),
        "f2": ("F-02 Fresh index (current name)", "pages crawled again within a day of a change"),
    }
    takes = "cites" in inspect.signature(checks.annotate).parameters
    checks.annotate([blk], [success], **({"cites": cites} if takes else {}))
    assert [(x.measure, x.measure_source) for x in blk.lines] == [
        (None, None),
        (None, None),
        (None, None),
        (None, None),
        ("sites with a first full crawl", "the crawl log"),
    ]
