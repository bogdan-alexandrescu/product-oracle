"""QA Nov 17 (ask finding 5): Ask's change card names the feature with its code, as every
reader reads it ("Move F-06 Weekly alert digest to Next"), on a horizon move and a dates
move. No database: the card's build reads only the item it is given.

Test cards (protects / fails_when / no_claim):

- test_change_cards_name_the_item_with_its_code: protects=change_horizon and move_dates
  card summaries start "Move <code> <title>"; fails_when=the summary names the title alone;
  no_claim=an item with no code (its title alone, as roadmap_talk.label).
"""

import uuid
from datetime import date
from types import SimpleNamespace

from oracle.simple import chat


def entry(code: str | None) -> SimpleNamespace:
    row = SimpleNamespace(id=uuid.uuid4(), title="Weekly alert digest", start_date=date(2026, 10, 31),
                          end_date=date(2026, 12, 10), date_source="typed")  # fmt: skip
    day = lambda d: SimpleNamespace(date=d)  # noqa: E731
    resolved = SimpleNamespace(start=day(date(2026, 10, 31)), end=day(date(2026, 12, 10)),
                               undated=False, source="typed")  # fmt: skip
    return SimpleNamespace(row=row, code=code, horizon="now", resolved=resolved)


def ctx(e: SimpleNamespace) -> SimpleNamespace:
    return SimpleNamespace(find=lambda _: e, today=date(2026, 11, 2), plan_span=None)


def test_change_cards_name_the_item_with_its_code() -> None:
    e = entry("F-06")
    assert chat._b_horizon(ctx(e), {"item": "Weekly alert digest", "horizon": "next"})["summary"] == (
        "Move F-06 Weekly alert digest to Next"
    )
    moved = chat._b_move(ctx(e), {"item": "Weekly alert digest", "shift": "2 weeks later"})
    assert moved["summary"].startswith("Move F-06 Weekly alert digest to Nov 14 – ")
    # No code: the title alone.
    plain = chat._b_horizon(ctx(entry(None)), {"item": "Weekly alert digest", "horizon": "next"})
    assert plain["summary"] == "Move Weekly alert digest to Next"
