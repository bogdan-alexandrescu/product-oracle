"""goal-figure-words: a measured goal's target (a number and its stored unit, as train BM
keeps it) reads as people write it wherever it is shown. Invented example data only.

Test cards (protects / fails_when / no_claim):

- test_figure_words: protects=the shared formatter puts a currency's sign before the number
  ("usd" is "$", any case), other units after it ("1,200 shops", "60%", "3 days"), commas
  between thousands, decimals kept and a whole float without ".0"; fails_when=it prints the
  stored code ("50000 usd") or the number without separators; no_claim=typed-target parsing.
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
    ):
        assert figure_words(value, unit) == shown, (value, unit)


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
