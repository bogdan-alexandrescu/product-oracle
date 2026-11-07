"""One effort reader (oracle.priorities.scoring.effort_weeks) for Simple's estimated starts,
its Priorities estimates and its chat's draft entries. Pure functions, no database.

Test cards (protects / fails_when / no_claim):

- test_the_effort_reader_reads_effort_else_effort_weeks: protects=a feature's effort in
  weeks as Priorities reads it: attrs ``effort`` (T-shirt sizes, numbers, number words),
  else ``effort_weeks``; none -> None; fails_when=the reader is missing, or reads
  ``effort_weeks`` over ``effort``; no_claim=the score's division (test_priorities.py).
- test_service_and_targets_read_effort_through_it: protects=oracle.simple.service and
  oracle.simple.targets use the public reader, not the private ``_number`` helper, and
  targets.estimates' effort is the reader's; fails_when=either imports ``_number`` again;
  no_claim=the efforts query (test_simple_roadmap_api.py).
- test_a_chat_draft_entry_starts_its_effort_before_its_end: protects=chat._draft_entry
  dates an end-only draft item's estimated start the effort's days before its end (a
  1-week item spans 7 days, a 3-week item 21), else 28 days; fails_when=the effort is
  dropped or spans one day more; no_claim=where the chat reads the effort (service.efforts).
"""

from datetime import date

from oracle.docs.models import Document
from oracle.priorities import scoring
from oracle.roadmap.models import RoadmapItem
from oracle.simple import chat, service, targets

WINDOW = (date(2026, 10, 1), date(2026, 12, 31))


def test_the_effort_reader_reads_effort_else_effort_weeks():
    assert scoring.effort_weeks({"effort": "M"}) == 2.0
    assert scoring.effort_weeks({"effort": 3}) == 3.0
    assert scoring.effort_weeks({"effort_weeks": "1.5"}) == 1.5
    assert scoring.effort_weeks({"effort": 2, "effort_weeks": 9}) == 2.0
    # ``effort`` set but unreadable reads as none, as the ranking reads it.
    assert scoring.effort_weeks({"effort": "lots", "effort_weeks": 9}) is None
    assert scoring.effort_weeks({}) is None
    assert scoring.effort_weeks(None) is None


def test_service_and_targets_read_effort_through_it():
    assert not hasattr(service, "_number")
    assert not hasattr(targets, "_number")
    for attrs in ({"effort": "L"}, {"effort_weeks": 3}, {"effort": True}, {}):
        assert targets.estimates(attrs)["effort"] == scoring.effort_weeks(attrs)


def _read() -> service.Read:
    return service.Read(
        today=date(2026, 10, 15), windows={"now": WINDOW}, entries=[], milestones=[],
        deciders={},
    )  # fmt: skip


def test_a_chat_draft_entry_starts_its_effort_before_its_end():
    prd = Document(title="Example PRD")
    row = RoadmapItem(item_key="example-item", horizon="now", end_date=date(2026, 11, 30),
                      date_source="tracker")  # fmt: skip
    one = chat._draft_entry(_read(), prd, row, 1)
    assert one.resolved.start.date == date(2026, 11, 24)
    assert one.resolved.start.estimated
    assert one.resolved.end.date == date(2026, 11, 30)
    assert chat._draft_entry(_read(), prd, row, 3).resolved.start.date == date(2026, 11, 10)
    assert chat._draft_entry(_read(), prd, row).resolved.start.date == date(2026, 11, 3)
