"""port-an-decisions: the API says "date source" wherever a person reads it (a discussion's
proposed change, who may add one, the publish gate's and a meeting's date warnings), as the web
does ("Add a date source"); "basis" stays in routes, fields and codes only.

protects=the words people read; fails_when=any of them says "date basis" or "date bases";
no_claim=the schedule-bases routes and fields (machine names)."""

from oracle import wording
from oracle.discussions import changes, kinds


def test_the_shared_wording_says_date_source():
    assert wording.RECORD_DATE_BASIS == (
        "add a date source on Plan › Dates (or ask the engineering lead to)"
    )


def test_a_discussions_proposed_date_source_reads_date_source():
    words = kinds.label(
        "basis_record",
        {"reference": "Sizing sheet", "supports_date": "2026-12-01", "kind": "estimate"},
    )
    assert words.startswith("Add a date source: Sizing sheet")
    assert "basis" not in words.lower()
    assert changes.RECORDERS == "Engineering leads and approvers add date sources"


def test_a_stored_date_warning_reads_date_source():
    """A warning stored with the old words reads the new ones when served."""
    old = (
        "the date Nov 20 is not backed by a confirmed schedule: record a date basis on Plan "
        "› Dates (or ask the engineering lead to) or drop the date"
    )
    message, _refs = wording.legacy(old)
    assert "add a date source on Plan › Dates" in message
    assert "basis" not in message
