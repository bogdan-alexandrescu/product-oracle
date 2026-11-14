"""goal-figure-words: a measured goal's target (a number and its stored unit, as train BM
keeps it) reads as people write it wherever it is shown. Invented example data only.

Test cards (protects / fails_when / no_claim):

- test_figure_words: protects=the shared formatter puts a currency's sign before the number
  ("usd" is "$", any case), other units after it ("1,200 shops", "60%", "3 days"), commas
  between thousands, decimals kept (a currency's to at most two, as the web's goalFigure) and a
  whole float without ".0"; fails_when=it prints the stored code ("50000 usd"), the number
  without separators or a currency with three decimals ("$13,400.555"); no_claim=typed-target
  parsing.
- test_figure_words_past_decimal_range: protects=an infinite currency value or one past about
  1e26 prints as before rounding to cents came in ("$inf", digits with commas);
  fails_when=figure_words raises InvalidOperation; no_claim=how such a figure should read.
- test_figure_words_singular_for_one: protects=a unit with a plural reads singular for 1 or -1
  ("1 event", "1 failed payment per 100 orders", "-1 day"), as the web's goalFigure, so a
  prediction's threshold and every export agree with the pages; fails_when=it reads "1 events";
  no_claim=other languages or irregular plurals.
- test_goal_buckets_read_money_and_count_goals: protects=Goal buckets read a usd goal as
  "$50,000" and a shops goal as "1,200 shops"; fails_when=they read "50000 usd" or "1200
  shops"; no_claim=the web.
"""

import pytest

from tests.test_goal_attrs_revisions import _set_attrs
from tests.test_simple_goal_buckets_api import World


def test_figure_words():
    from oracle.baseline.goals import figure_words

    for value, unit, shown in (
        (50000, "usd", "$50,000"),
        (50000.0, "USD", "$50,000"),
        (1200, "eur", "€1,200"),
        (3.5, "gbp", "£3.5"),
        (1234.5, "$", "$1,234.5"),
        (1200, "shops", "1,200 shops"),
        (60, "%", "60%"),
        (60.0, "%", "60%"),
        (3, "days", "3 days"),
        (12000000, "", "12,000,000"),
        (7, None, "7"),
        (-2500, "usd", "-$2,500"),
        (13400.555, "usd", "$13,400.56"),
        (13400.001, "usd", "$13,400"),
        (-2.675, "eur", "-€2.68"),
        (12.345, "%", "12.345%"),
        (1200.125, "shops", "1,200.125 shops"),
    ):
        assert figure_words(value, unit) == shown, (value, unit)


def test_figure_words_past_decimal_range():
    from oracle.baseline.goals import figure_words

    assert figure_words(float("inf"), "usd") == "$inf"
    assert figure_words(float("-inf"), "eur") == "-€inf"
    assert figure_words(1e27, "usd") == f"${int(1e27):,}"
    assert figure_words(-1e30, "gbp") == f"-£{int(1e30):,}"


def test_figure_words_singular_for_one():
    from oracle.baseline.goals import figure_words
    from oracle.quality.capture import figure_text

    for value, unit, shown in (
        (1, "events", "1 event"),
        (1.0, "events", "1 event"),
        (-1, "days", "-1 day"),
        (1, "failed payments per 100 orders", "1 failed payment per 100 orders"),
        (1, "stories", "1 story"),
        (1, "boxes", "1 box"),
        (1, "status", "1 status"),
        (1, "% done", "1 % done"),
        (1, "%", "1%"),
        (1, "usd", "$1"),
        (2, "events", "2 events"),
        (1.5, "events", "1.5 events"),
    ):
        assert figure_words(value, unit) == shown, (value, unit)
    assert figure_text(1, "events") == "1 event"


@pytest.mark.asyncio(loop_scope="session")
async def test_goal_buckets_read_money_and_count_goals(client):
    w = await World().build()
    tid = w.ctx.tenant_id
    gid = w.goals["grow"]
    for target, unit, shown in ((50000, "usd", "$50,000"), (1200, "shops", "1,200 shops")):
        await _set_attrs(tid, gid, {"position": 1, "metric": "Shops live", "target": target,
                                    "unit": unit, "due": "2027-03-31"})  # fmt: skip
        grow = next(g for g in (await w.read(client))["goals"] if g["id"] == gid)
        assert grow["target"] == shown, (unit, grow["target"])
