"""O4 date-check details (owner, 2026-10-20; docs/questions.md row O4), pinned after the
merge with main: the roadmap's PRD comes from its front matter only; a numeric date that
reads two ways is verified only when both readings are backed; a year-less date is the
next such day on or after the draft's date; dates inside HTML comments are checked."""

import uuid
from dataclasses import dataclass
from datetime import date

from oracle.roadmap import doc_dates
from oracle.roadmap.schedule import Basis


@dataclass
class _Section:
    section_key: str
    heading: str
    body_md: str
    level: int = 2


def _basis(day: date) -> Basis:
    return Basis(id=uuid.uuid4(), kind="commitment", reference="ENG-1", supports_date=day)


def _marks(body: str, bases: list[Basis], ref: date = date(2026, 10, 20)):
    found = doc_dates.find([_Section("now", "Now", body)], ref=ref)
    return doc_dates.check_found(found, bases, [])


def test_the_prd_is_the_one_named_in_front_matter_never_a_link():
    assert doc_dates.declared_prd({"prd": {"document": "checkout", "version": 2}}) == "checkout"
    assert doc_dates.declared_prd({"prd": "checkout"}) == "checkout"
    assert doc_dates.declared_prd({"title": "See [PRD](/documents/checkout/v/2#now)"}) is None
    assert doc_dates.declared_prd(None) is None


def test_an_ambiguous_numeric_date_needs_a_basis_for_both_readings():
    may_6, jun_5 = date(2026, 5, 6), date(2026, 6, 5)
    (one,) = _marks("Beta on 05/06/2026.", [_basis(may_6)])
    assert set(one.days) == {may_6, jun_5} and one.status == "unverified"
    (both,) = _marks("Beta on 05/06/2026.", [_basis(may_6), _basis(jun_5)])
    assert both.status == "verified"
    # One real reading only (13 is no month): one basis is enough.
    (plain,) = _marks("Beta on 13/06/2026.", [_basis(date(2026, 6, 13))])
    assert plain.status == "verified"


def test_a_year_less_date_is_the_next_such_day_on_or_after_the_draft():
    ref = date(2026, 10, 20)
    (later,) = _marks("GA Dec 15.", [_basis(date(2026, 12, 15))], ref)
    assert later.day == date(2026, 12, 15) and later.status == "verified"
    (passed,) = _marks("GA Mar 3.", [_basis(date(2026, 3, 3))], ref)
    assert passed.day == date(2027, 3, 3) and passed.status == "unverified"
    (today,) = _marks("GA Oct 20.", [], ref)
    assert today.day == ref


def test_a_date_inside_an_html_comment_is_checked():
    (mark,) = _marks("Plan.\n\n<!-- GA 2026-12-15 -->\n", [])
    assert mark.text == "2026-12-15" and mark.status == "unverified"
    (inline,) = _marks("Plan <!-- ship 2026-12-16 --> soon.\n", [_basis(date(2026, 12, 16))])
    assert inline.status == "verified"
