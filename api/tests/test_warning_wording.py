"""#396 Warnings speak the app's words: every version warning and publish-gate message a
person sees says what to do in the app (record a date basis on Plan › Dates), names the
document by its title and the section by its heading, and never carries an HTTP method,
an API route or a raw id. The ids stay in the machine fields (``code``, ``refs``,
``section_keys``) for agents and the API. One helper (:mod:`oracle.wording`) builds and
checks these messages, and rewrites the old wording stored on versions before #396.
Against Postgres with the FakeRuntime for the import and approve paths."""

import re
import uuid
from datetime import date

import pytest

from oracle import wording
from oracle.docs.schemas import ImportProblem, VersionWarning
from oracle.review import publish_gate
from oracle.review.schemas import PublishBlock
from oracle.roadmap import doc_dates, schedule
from tests.test_roadmap import (  # noqa: F401 - fixtures
    PRD,
    approved_prd,
    owner,
    runtime,
)
from tests.test_roadmap_fixes_4 import VERSIONS, _run_import, _with_paragraph

API_WORDS = re.compile(
    r"/v1/|\b(GET|POST|PUT|PATCH|DELETE)\b"
    r"|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
    re.IGNORECASE,
)
ID = "00000000-0000-0000-0000-000000000000"

LEGACY_DATE = (
    "the date 2026-01-01 (section roadmap, line 1) rests on no verified estimate, capacity "
    "or commitment of PRD example-prd for this item; record one (POST /v1/schedule-bases) "
    "or drop the date. Oracle never invents dates"
)
LEGACY_CITATION = (
    f"citation 'bl-example' names source item '{ID}', which this company does not have; "
    "the citation is kept without it"
)


def _plain(text: str) -> None:
    assert not API_WORDS.search(text), text
    assert wording.api_words(text) == [], text


def _mark(status: str = "unverified", **kw) -> doc_dates.Mark:
    defaults = dict(
        section_key="now-payment-step",
        text="2026-12-15",
        day=date(2026, 12, 15),
        status=status,
        line=1,
        bases=["ENG-412"] if status == "withdrawn" else [],
    )
    return doc_dates.Mark(**{**defaults, **kw})


MARKS = [
    _mark(),
    _mark(line=0),
    _mark(where="title", section_key=""),
    _mark("withdrawn"),
    _mark(days=(date(2026, 12, 1), date(2026, 1, 12)), text="12/1/2026"),
]


# --------------------------------------------------------------------------- builders


@pytest.mark.parametrize("mark", MARKS, ids=lambda m: f"{m.status}-{m.where}-{m.line}")
@pytest.mark.parametrize(
    "prd,update", [("Checkout redesign PRD", False), (None, False), (None, True)]
)
def test_every_date_message_says_what_to_do_in_the_app(mark, prd, update):
    """protects=#396 the date warning, the import refusal and the withdrawn note name
    Plan › Dates, the PRD by its title and the section by its heading;
    fails_when=a message carries an API route, an HTTP method or a raw id, or names the
    section by its key; no_claim=which dates are marked (test_roadmap_doc_dates.py)."""
    msg = doc_dates.problem_message(mark, prd, update=update, heading="Payment step")
    _plain(msg)
    assert "Plan › Dates" in msg and "now-payment-step" not in msg
    if mark.where != "title":
        assert '"Payment step"' in msg
    if prd and mark.status != "withdrawn":
        assert '"Checkout redesign PRD"' in msg


def test_the_item_and_track_date_refusals_say_what_to_do_in_the_app():
    for msg in (schedule.UNVERIFIED, schedule.OUTSIDE_NOW, doc_dates.SOURCES_NOT_LAST):
        _plain(msg)
    assert "Plan › Dates" in schedule.UNVERIFIED and "never invents dates" in schedule.UNVERIFIED


def test_the_citation_warning_names_a_source_item_oracle_no_longer_has():
    for headings in (["Problem"], ["Problem", "Decisions"], []):
        msg = wording.unknown_source_item(headings)
        _plain(msg)
        assert "a source item Oracle no longer has" in msg
        for h in headings:
            assert f'"{h}"' in msg


def test_the_publish_gate_message_names_headings_and_plan_dates():
    marks = [_mark(), _mark("withdrawn", text="2026-11-30", day=date(2026, 11, 30))]
    headings = {"now-payment-step": "Payment step"}
    detail, blocks = publish_gate.dates_refusal(marks, headings)
    _plain(detail)
    assert "Plan › Dates" in detail and '"Payment step"' in detail
    assert "now-payment-step" not in detail
    for b in blocks:
        _plain(b.rationale)
        # The ids stay in the machine field.
        assert b.key == "unverified_date" and b.id.startswith("now-payment-step:")


# --------------------------------------------------------------------------- the helper


def test_the_helper_finds_api_words_and_rewrites_the_old_stored_wording():
    """protects=#396 versions imported before #396 show the new wording when served;
    fails_when=a stored message still reaches the web with a route or a raw id;
    no_claim=the stored JSON is not rewritten (it is read through the helper)."""
    assert wording.api_words(LEGACY_DATE) == ["POST", "/v1/"]
    assert wording.api_words(LEGACY_CITATION) == [ID]
    date_msg = wording.say(LEGACY_DATE)
    _plain(date_msg)
    assert "record a date basis on Plan › Dates" in date_msg
    citation = wording.say(LEGACY_CITATION)
    _plain(citation)
    assert "a source item Oracle no longer has" in citation and "bl-example" not in citation
    # Anything else that slips through still reaches no one with a route or an id.
    _plain(wording.say(f"call PATCH /v1/things/{uuid.uuid4()} (GET /v1/other) now"))
    # The served models go through it.
    _plain(VersionWarning(code="unverified_date", message=LEGACY_DATE).message)
    _plain(ImportProblem(code="unknown_citation_item", message=LEGACY_CITATION).message)
    _plain(PublishBlock(key="k", id=ID, title="t", rationale=LEGACY_DATE).rationale)
    # Plain text is left as it is.
    assert wording.say("sections approved in version 1 changed: scope") == (
        "sections approved in version 1 changed: scope"
    )


def test_a_warning_keeps_its_ids_in_refs():
    w = VersionWarning(
        code="unknown_citation_item",
        message=LEGACY_CITATION,
        refs={"cite_key": "bl-example", "source_item": ID},
    )
    assert w.model_dump()["refs"] == {"cite_key": "bl-example", "source_item": ID}
    assert VersionWarning(code="x", message="y").refs == {}


# --------------------------------------------------------------------------- served


async def test_a_run_s_date_warning_and_the_approve_refusal_are_plain(client, owner, runtime):  # noqa: F811
    """protects=#396 the roadmap version's Warnings panel and Approve's 409 as served;
    fails_when=the served warning or the 409 detail carries /v1/, a method or an id, or the
    ids agents need are gone; no_claim=the Warnings panel layout (e2e/version-warnings)."""
    _, auth = owner
    await approved_prd(client, auth)
    await _run_import(client, auth, runtime, _with_paragraph("GA 2026-12-15."))
    version = (await client.get(f"{VERSIONS}/1", headers=auth)).json()
    (w,) = [w for w in version["warnings"] if w["code"] == "unverified_date"]
    _plain(w["message"])
    assert "Plan › Dates" in w["message"] and "2026-12-15" in w["message"]
    assert '"Payment step"' in w["message"] and "Checkout redesign" in w["message"]
    # The ids agents need: the section key, the date and the PRD's slug.
    assert w["section_keys"] == ["now-payment-step"]
    assert w["refs"] == {"date": "2026-12-15", "prd": PRD}
    for other in version["warnings"]:
        _plain(other["message"])

    resp = await client.post(f"{VERSIONS}/1/approve", headers=auth)
    assert resp.status_code == 409, resp.text
    body = resp.json()
    _plain(body["detail"])
    assert "Plan › Dates" in body["detail"] and "2026-12-15" in body["detail"]
    for b in body["blocking"]:
        _plain(b["rationale"])
    assert [b["id"] for b in body["blocking"]] == ["now-payment-step:2026-12-15"]
