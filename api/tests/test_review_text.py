"""The generated text a run review shows reads plainly (oracle.runs.review_text).

An architect's approach, a date's assumptions and its no-date reason are written by agents;
the review shows them with month-first dates, codes with their names, and no confidence
numbers, question ids or citation ids. The agents' tasks ask for the same.

Every test states its card: protects / fails_when / no_claim. The unit tests need no
database; the last one reads a run against Postgres with the FakeRuntime (no model is
called). Synthetic placeholders only.
"""

import pytest

from oracle.runs import flows
from oracle.swarm import FakeRuntime, Outcome, set_runtime
from tests.fixtures import seed_auth
from tests.test_runs import get, pending


def _plain(text, codes=None, questions=None):
    from oracle.runs import review_text

    return review_text.plain(text, codes=codes or {}, questions=questions or {})


@pytest.mark.parametrize(
    ("text", "want"),
    [
        ("Ship by 2026-11-02 if the tax call holds.", "Ship by Nov 2, 2026 if the tax call holds."),
        ("Between 2026-10-31 and 2027-01-05.", "Between Oct 31, 2026 and Jan 5, 2027."),
        ("Started 2026-11-02T14:49:00Z.", "Started Nov 2, 2026."),
        ("The team has two engineers [c:c4].", "The team has two engineers."),
        ("Two engineers [c:c4] [c:c11] and a designer.", "Two engineers and a designer."),
        ("Capacity holds (team estimate, 0.73).", "Capacity holds (team estimate)."),
        ("Capacity holds (0.6).", "Capacity holds."),
        ("Capacity holds, confidence 0.55, per the plan.", "Capacity holds, per the plan."),
        ("Waits on decision Q1.", "Waits on a decision."),
        ("Waits on FS-Q2 first.", "Waits on a question first."),
        ("Ship in Q4 as planned.", "Ship in Q4 as planned."),
        ("Version 2026.1 stays.", "Version 2026.1 stays."),
        ("", ""),
    ],
)
def test_the_text_reads_plainly(text, want):
    # protects=walk-eng-check ITEM 11: ISO dates month first, citation ids, confidence
    # numbers and bare question ids gone; fails_when=any raw token is left or a plain
    # sentence (a quarter, a version) changes; no_claim=the agents' own wording.
    assert _plain(text) == want


def test_known_questions_and_codes_go_by_their_words():
    # protects=ITEM 11 "codes with their names"; fails_when=a brief's question id or a
    # feature key shows alone; no_claim=codes the review does not know.
    codes = {"price-early": "Show the price early"}
    questions = {"q1": "Can the tax service answer within 200 ms?"}
    assert _plain("Depends on q1 and on price-early.", codes, questions) == (
        'Depends on "Can the tax service answer within 200 ms?" and on '
        "price-early Show the price early."
    )
    assert _plain("Per question q1, price-early Show the price early waits.", codes, questions) == (
        'Per "Can the tax service answer within 200 ms?", price-early Show the price early waits.'
    )


def test_a_question_id_never_reads_open():
    # protects=walk-eng-check review minor: an id the text names may be a question already
    # answered, so it never reads "an open question"; an id of another brief's question is
    # quoted as that question; fails_when="an open decision" or "an open question" shows, or
    # another brief's question id stays bare; no_claim=whether the question is answered.
    from oracle.runs import review_text

    payload = {
        "briefs_check": {
            "features": [
                {"key": "f.tax-call", "title": "Fast tax call", "approach": "Cache the rates.",
                 "questions": [{"id": "Q1", "question": "Can the tax service answer within 200 ms?",
                                "blocking": True}]},
                {"key": "f.price-early", "title": "Show the price early",
                 "approach": "Waits on decision Q1, then on FS-Q2.", "questions": []},
            ]
        }
    }  # fmt: skip
    out = review_text.review_payload("eng_review", payload)["briefs_check"]["features"]
    assert out[1]["approach"] == (
        'Waits on "Can the tax service answer within 200 ms?", then on a question.'
    )
    assert "open" not in out[1]["approach"]


def test_the_dates_review_payload_reads_plainly():
    # protects=ITEM 11 on the Engineering dates stop: assumptions and the no-date reason;
    # fails_when=the payload shown keeps an ISO date, a citation or a confidence, or a
    # structured field (the proposed date, the key) changes; no_claim=the web's own render.
    from oracle.runs import review_text

    payload = {
        "dates_check": {
            "items": [
                {
                    "key": "price-early",
                    "title": "Show the price early",
                    "proposed": {"kind": "estimate", "reference": "est-price-early",
                                 "supports_date": "2026-11-02"},
                    "assumptions": ["Two engineers from 2026-11-02 [c:c4] (plan, 0.73)"],
                    "no_date_reason": None,
                },
                {"key": "tax-call", "title": "Fast tax call", "proposed": None,
                 "assumptions": [], "no_date_reason": "Waits on decision Q1 [c:c2]."},
            ],
            "others": [],
        }
    }  # fmt: skip
    out = review_text.review_payload("eng_dates", payload)["dates_check"]["items"]
    assert out[0]["assumptions"] == ["Two engineers from Nov 2, 2026 (plan)"]
    assert out[0]["proposed"]["supports_date"] == "2026-11-02"
    assert out[0]["key"] == "price-early"
    assert out[1]["no_date_reason"] == "Waits on a decision."
    assert payload["dates_check"]["items"][1]["no_date_reason"].endswith("[c:c2].")


def test_the_flows_tell_the_architects_to_write_plainly():
    # protects=ITEM 11 at the source; fails_when=the tech brief or dates task does not ask
    # for month-first dates and no ids or confidence numbers in prose; no_claim=the model.
    for task in (flows.TECH_BRIEF_TASK, flows.ENG_DATES_TASK):
        assert flows.PLAIN_PROSE in task
    for words in ("Nov 2, 2026", "[c:", "question ids", "confidence numbers"):
        assert words in flows.PLAIN_PROSE


BRIEFS = """\
version: 1
code_map: {used: false, repos: []}
features:
  - feature: price-early
    title: Show the price early
    approach: "Show the total from 2026-11-02 once q1 is settled [c:c4] (tax service, 0.73)."
    touches: []
    reuse: []
    risks: []
    questions:
      - {id: q1, question: "Can the tax service answer within 200 ms?", why: Latency,
         blocking: false}
    size: m
    size_why: One page and one service call
    depends_on: []
    assumptions: ["A tax service exists"]
"""


async def test_the_engineering_check_shows_the_approach_plainly(client):
    # protects=ITEM 11 on the run review read: the architect's approach as the check shows
    # it; fails_when=the run's payload keeps the ISO date, the question id, the citation or
    # the confidence; no_claim=the stored file (kept as written).
    from tests.test_eng_review_stop import _at_check

    set_runtime(FakeRuntime({"eng_review": [Outcome(artifacts={flows.BRIEFS_FILE: BRIEFS})]}))
    try:
        _, auth = await seed_auth()
        run = await _at_check(client, auth)
        run = await get(client, auth, run["id"])
        feature = pending(run)["payload"]["briefs_check"]["features"][0]
        assert feature["approach"] == (
            'Show the total from Nov 2, 2026 once "Can the tax service answer within 200 ms?" '
            "is settled (tax service)."
        )
        assert feature["questions"][0]["id"] == "q1"
    finally:
        set_runtime(None)
