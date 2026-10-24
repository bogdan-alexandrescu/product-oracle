"""The ritual kinds: a code registry. A kind decides its default schedule, length,
preparation lead time and which pre-read blocks it has.

A kind whose ``requires`` feature has no block builders registered here
(:data:`FEATURES`) is not listed and never fires; each pick that adds such a feature
registers its builders in :mod:`oracle.rituals.blocks` and its feature in
:data:`FEATURES`.
"""

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class RitualKind:
    key: str
    title: str
    default_schedule: dict[str, Any]
    duration_min: int
    # The pre-read is ready this long before the due time.
    prep_hours: int
    # Pre-read block builders, in order.
    blocks: tuple[str, ...]
    # A feature that must exist: "decisions" (H1), "strategy" (H4), "launches" (H6),
    # "updates" (H8), "metrics" (H5), "market" (H7).
    requires: str | None
    enabled_by_default: bool


def _s(freq: str, **kw: Any) -> dict[str, Any]:
    return {"freq": freq, **kw}


KINDS: dict[str, RitualKind] = {
    k.key: k
    for k in (
        RitualKind("goals_checkin", "Weekly goals check-in",
                   _s("weekly", weekday=0, time="09:00"), 30, 12,
                   ("goals", "since_last", "outcomes_due", "needs_decision"), None, True),
        RitualKind("roadmap_refresh", "Monthly roadmap refresh",
                   _s("monthly", week_of_month=1, weekday=1, time="10:00"), 60, 24,
                   ("tracks", "slips", "stale_items", "done_items", "priority_changes",
                    "new_requests", "suggested_next"), None, True),
        RitualKind("goals_review", "Quarterly goals review",
                   _s("quarterly", month=1, week_of_month=1, weekday=2, time="10:00"), 90, 48,
                   ("goals", "horizon_ending", "goal_gaps", "outcomes_assessed",
                    "unserved_features", "suggested_next"), None, True),
        RitualKind("decision_review", "Decisions due",
                   _s("weekly", weekday=3, time="09:00"), 30, 12,
                   ("decisions_due", "decisions_made"), "decisions", True),
        RitualKind("strategy_review", "Strategy check",
                   _s("quarterly", month=1, week_of_month=1, weekday=2, time="14:00"), 60, 48,
                   ("strategy_drift", "strategy_age"), "strategy", True),
        RitualKind("changelog", "Weekly changelog",
                   _s("weekly", weekday=4, time="15:00"), 15, 4,
                   ("changelog_drafts",), "launches", True),
        RitualKind("investor_update", "Investor update",
                   _s("monthly", week_of_month=1, weekday=0, time="09:00"), 30, 72,
                   ("update_draft",), "updates", False),
        RitualKind("board_meeting", "Board meeting",
                   _s("every_n_weeks", interval=7, weekday=3, time="10:00"), 120, 72,
                   ("update_draft", "goals", "outcomes_assessed"), "updates", False),
        # H5: seeded paused; the first stored weekly value resumes it on the goals
        # check-in's schedule and pauses the check-in (oracle.metrics.activate).
        RitualKind("metrics_review", "Weekly metrics review",
                   _s("weekly", weekday=0, time="09:00"), 45, 6,
                   ("metrics_table", "variances", "goals", "outcomes_due", "needs_decision"),
                   "metrics", False),
        # F6's weekly report on the ritual clock: seeded on F6's stored day, time and zone
        # (oracle.reports.alignment settings), built at its moment with no lead time.
        RitualKind("alignment_report", "Weekly alignment report",
                   _s("weekly", weekday=0, time="08:00"), 15, 0,
                   ("alignment_report",), None, True),
        # H7 Competitive digest: seeded paused; the first alternative or watched page
        # resumes it once (oracle.market.service.resume_digest_once).
        RitualKind("competitive_digest", "Monthly competitive digest",
                   _s("monthly", week_of_month=1, weekday=3, time="10:00"), 30, 72,
                   ("competitor_changes", "competitor_web", "competitor_mentions",
                    "watch_problems"), "market", False),
        RitualKind("custom", "Custom ritual",
                   _s("weekly", weekday=0, time="09:00"), 30, 12,
                   ("since_last", "needs_decision"), None, True),
    )
}  # fmt: skip

# Features whose block builders are registered (oracle.rituals.blocks). All four are on
# main: H1 Decision log (oracle.decisions), H4 Strategy and vision (oracle.strategy), H6
# Launches and changelog (oracle.launches) and H8 Board and investor drafts (the update
# document kind and the update_draft flow). H8's kinds stay off by default
# (enabled_by_default); their update_draft block links the latest update draft and does
# not start the update draft run yet. H5 Metrics review (oracle.metrics) adds "metrics";
# H7 Competitive digest (oracle.market) adds "market". A kind whose feature is not
# listed here is not listed and never fires.
FEATURES: set[str] = {"decisions", "strategy", "launches", "updates", "metrics", "market"}


def available(kind: RitualKind) -> bool:
    return kind.requires is None or kind.requires in FEATURES


def builtins() -> list[RitualKind]:
    """The built-in kinds a company gets, those whose feature exists."""
    return [k for k in KINDS.values() if k.key != "custom" and available(k)]
