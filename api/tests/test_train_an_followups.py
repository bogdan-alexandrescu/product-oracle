"""Train AN's review follow-ups: ParseBusy on the parse-once items check and one day-words
helper. Invented data only.
"""

import datetime as dt

import pytest

from oracle import company_time, safe_yaml
from oracle.roadmap import doc_dates
from oracle.runs import plan_tables
from oracle.runs import roadmap as runs_roadmap
from tests.test_roadmap import ITEMS

# --- ParseBusy on the parse-once items check ------------------------------------------------


async def test_a_busy_items_check_is_raised_and_not_kept(monkeypatch):
    """No worker for the check: ParseBusy reaches the caller (who retries on the next tick)
    and nothing is kept, so the next call checks the file."""
    text = ITEMS + "\n# busy once\n"
    real = safe_yaml.run_parse_within
    calls = []

    async def busy_once(*args, **kwargs):
        calls.append(1)
        if len(calls) == 1:
            raise safe_yaml.ParseBusy("parse_busy")
        return await real(*args, **kwargs)

    monkeypatch.setattr(safe_yaml, "run_parse_within", busy_once)
    with pytest.raises(safe_yaml.ParseBusy):
        await runs_roadmap.check_items_async(text)
    check = await runs_roadmap.check_items_async(text)
    assert len(calls) == 2
    assert [i["id"] for i in check.items][:1] == ["payment-step"]
    # Kept now: a third call reads the cache, not the pool.
    await runs_roadmap.check_items_async(text)
    assert len(calls) == 2


async def test_a_busy_check_for_a_person_with_parses_running_is_429(monkeypatch):
    async def busy(*args, **kwargs):
        raise safe_yaml.ParseBusy("parse_busy_you")

    monkeypatch.setattr(safe_yaml, "run_parse_within", busy)
    with pytest.raises(safe_yaml.ParseBusy) as caught:
        await runs_roadmap.check_items_async(ITEMS + "\n# busy you\n")
    assert caught.value.status == 429


# --- one day-words helper -------------------------------------------------------------------


def test_doc_dates_words_a_day_through_company_time():
    assert doc_dates.shown_day is company_time.calendar_day_with_year
    assert doc_dates.shown_day(dt.date(2026, 11, 30)) == "Nov 30, 2026"


def test_the_plan_tables_word_a_day_through_company_time():
    """The plan tables' day words are company_time's; no day is an empty cell."""
    assert plan_tables._day is company_time.calendar_day_with_year
    assert plan_tables._day(dt.date(2027, 1, 5)) == "Jan 5, 2027"
    assert plan_tables._day(None) == ""
