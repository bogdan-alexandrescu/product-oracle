"""walk b, roadmap approval: only schedule dates are checked against the PRD's verified
bases. The roadmap's own "As of <day>" line and its "Changes since last version" section
are not schedule dates; a date outside every item's section (a summary, a brief table)
passes when a verified basis of the PRD supports that day.

Test card: protects=Approve version is not refused for verified or non-schedule dates;
fails_when=those dates are marked unverified; no_claim=withdrawn bases. Synthetic data only."""

import uuid
from dataclasses import dataclass
from datetime import date

from oracle.roadmap import doc_dates
from oracle.roadmap.schedule import Basis

REF = date(2026, 10, 20)


@dataclass
class _Section:
    section_key: str
    heading: str
    body_md: str
    level: int = 2


def _basis(day: date, item_key: str | None = None) -> Basis:
    return Basis(
        id=uuid.uuid4(), kind="commitment", reference="ENG-1", supports_date=day, item_key=item_key
    )


def _flagged(sections: list[_Section], bases: list[Basis]) -> list[str]:
    found = doc_dates.find(sections, ref=REF)
    return [m.text for m in doc_dates.flagged(doc_dates.check_found(found, bases, []))]


def test_the_as_of_line_and_the_changes_section_are_not_schedule_dates():
    sections = [
        _Section("roadmap", "Example roadmap", "As of Nov 2, 2026 · version 3", level=1),
        _Section(
            "changes", "Changes since last version (Oct 15, 2026)", "Moved Search on Oct 30, 2026."
        ),
        _Section("now", "Now", "Nothing dated."),
    ]
    assert _flagged(sections, []) == []


def test_a_schedule_date_still_needs_a_basis():
    sections = [_Section("now-search", "Search", "Ships Dec 15, 2026.", level=3)]
    assert _flagged(sections, []) == ["Dec 15, 2026"]


def test_a_date_outside_any_item_passes_on_an_item_s_verified_basis():
    sections = [
        _Section("summary", "Summary", "Search ships Dec 15, 2026."),
        _Section("now-search", "Search", "Ships Dec 15, 2026.", level=3),
    ]
    assert _flagged(sections, [_basis(date(2026, 12, 15), item_key="search")]) == []
    # Another item's section still needs its own basis.
    other = [_Section("now-export", "Export", "Ships Dec 15, 2026.", level=3)]
    assert _flagged(other, [_basis(date(2026, 12, 15), item_key="search")]) == ["Dec 15, 2026"]
