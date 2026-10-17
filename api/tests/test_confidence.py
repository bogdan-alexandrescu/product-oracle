from datetime import UTC, datetime, timedelta

from oracle import confidence
from oracle.confidence import Factors, aggregate, prefer, rank_weight, score

NOW = datetime(2026, 10, 17, tzinfo=UTC)


def test_fresh_corroborated_goal_linked_code_beats_stale_lone_chat():
    strong = score(
        Factors("github", "readme", NOW - timedelta(days=1), mentions=3, goal_contribution=3),
        now=NOW,
    )
    weak = score(Factors("slack", "message", NOW - timedelta(days=120)), now=NOW)
    assert strong.confidence > 0.8 > 0.5 > weak.confidence
    assert set(strong.breakdown) == {"source", "freshness", "mentions", "goal_impact"}


def test_freshness_halves_per_half_life_down_to_the_floor():
    month = score(Factors("slack", latest_at=NOW - timedelta(days=30)), now=NOW)
    assert month.breakdown["freshness"]["value"] == 0.5
    ancient = score(Factors("slack", latest_at=NOW - timedelta(days=3000)), now=NOW)
    assert ancient.breakdown["freshness"]["value"] == confidence.DEFAULTS["freshness_floor"]
    undated = score(Factors("notion"), now=NOW)
    assert undated.breakdown["freshness"]["value"] == confidence.DEFAULTS["freshness_floor"]


def test_more_mentions_and_planning_docs_raise_the_score():
    one = score(Factors("notion", latest_at=NOW), now=NOW).confidence
    three = score(Factors("notion", latest_at=NOW, mentions=3), now=NOW).confidence
    planning = score(Factors("notion", latest_at=NOW, planning_doc=True), now=NOW).confidence
    assert three > one and planning > one


def test_company_overrides_change_weights_and_kinds():
    f = Factors("slack", latest_at=NOW)
    base = score(f, now=NOW).confidence
    trusted = score(f, {"source": {"slack": 0.95}}, now=NOW).confidence
    only_freshness = score(
        f,
        {"weights": {"source": 0, "freshness": 1, "mentions": 0, "goal_impact": 0}},
        now=NOW,
    )
    assert trusted > base
    assert only_freshness.confidence == 1.0
    assert confidence.DEFAULTS["source"]["slack"] == 0.5  # overrides never leak


def test_aggregate_rank_and_prefer():
    assert aggregate([]) is None
    assert aggregate([0.5, 0.5]) == 0.75
    assert rank_weight(1.0) == 1.0 and rank_weight(0.0) == 0.5
    assert prefer(0.9, 0.5) == 1 and prefer(0.5, 0.9) == -1 and prefer(0.6, 0.65) == 0
