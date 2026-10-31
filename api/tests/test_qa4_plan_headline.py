"""qa4-plan-26: a track's headline counts items and reasons apart.

One item that is both slipping and may be out of date read "1 of 7 items need attention
(1 may be out of date, 1 slipping)", two counts for one item; it now names that item's reasons
without counts. Several items keep a count per reason.
"""

from oracle.roadmap.views import _headline


def _counts(**kw: int) -> dict[str, int]:
    return {"items": 7, "at_risk": 0, "blocked": 0, "stale": 0, "slipping": 0, **kw}


def test_one_item_with_two_reasons_reads_as_one_item() -> None:
    text = _headline("at_risk", _counts(at_risk=1, stale=1, slipping=1), None)
    assert text == "At risk: 1 of 7 items needs attention (may be out of date and slipping)."
    assert "1 slipping" not in text


def test_several_items_keep_a_count_per_reason() -> None:
    text = _headline("at_risk", _counts(at_risk=2, blocked=1, slipping=2), None)
    assert text == "At risk: 2 of 7 items need attention (1 blocked, 2 slipping)."


def test_a_single_item_track_says_the_item() -> None:
    text = _headline("off_track", {**_counts(at_risk=1, slipping=1), "items": 1}, None)
    assert text == "Off track: the item needs attention (slipping)."
