"""Confidence of a source item or a piece of evidence, and how much it counts.

Bogdan, 2026-10-17: sources behind a PRD or roadmap get a confidence score derived
from their freshness (latest timestamp), the kind of source, how many independent
sources mention the same thing, and their direct impact on company or product goals;
the score sets how much they weigh in the outputs.

The score is a weighted mean of four factors, each in [0, 1], so every number can be
explained. The defaults below are a starting point; a company overrides any of them
with the ``confidence_weights`` tenant setting (same shape as ``DEFAULTS``).

Where it is used: search ranking (``rank_weight``), conflict resolution (higher
confidence wins unless the two are within ``tie_margin``, then source precedence),
a feature's priority confidence (the mean of its evidence), the PRD's data-points
table, and the guidance given to agents (claims below ``low`` are flagged).
"""

import copy
import math
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

DEFAULTS: dict[str, Any] = {
    # Factor weights in the mean.
    "weights": {"source": 0.35, "freshness": 0.25, "mentions": 0.20, "goal_impact": 0.20},
    # How much a kind of source is trusted for product facts (B3: code > tracker > docs
    # > chat). Keys are "<source kind>" or "<source kind>:<item kind>"; the most
    # specific key wins.
    "source": {
        "github": 0.85,
        "github:readme": 0.9,
        "github:release": 0.9,
        "github:issue": 0.75,
        "github:pull_request": 0.8,
        "notion": 0.7,
        "google_docs": 0.7,
        "upload": 0.7,
        "fireflies": 0.6,
        "slack": 0.5,
        # A public web page cited through a link (Notion and Google Docs links count as
        # their own kinds above).
        "web": 0.55,
    },
    # A planning or feature document (item acl/attrs "doc_type": "planning") gets this
    # much on top of its kind, capped at 1.
    "planning_bonus": 0.1,
    # Freshness halves every N days after the latest timestamp, down to the floor.
    "half_life_days": {
        "slack": 30,
        "fireflies": 45,
        "github:issue": 60,
        "github:pull_request": 60,
        "notion": 90,
        "google_docs": 90,
        "upload": 90,
        "web": 90,
        "github": 180,
    },
    "freshness_floor": 0.2,
    # Contribution (0-3) of the goal link the evidence supports -> factor; unlinked 0.5.
    "goal_impact": {"3": 1.0, "2": 0.85, "1": 0.7, "0": 0.5},
    "tie_margin": 0.1,
    "low": 0.4,
}


@dataclass(frozen=True)
class Factors:
    source_kind: str
    item_kind: str | None = None
    # Latest of the item's updated / occurred timestamps (fetched_at as a fallback).
    latest_at: datetime | None = None
    # Distinct sources that state the same claim, this one included.
    mentions: int = 1
    # Highest contribution (0-3) to a confirmed goal; None when not linked to one.
    goal_contribution: int | None = None
    planning_doc: bool = False


@dataclass(frozen=True)
class Score:
    confidence: float
    # Each factor's value and weight, for the UI and confidence_factors.
    breakdown: dict[str, dict[str, float]] = field(default_factory=dict)


def merged(overrides: dict[str, Any] | None) -> dict[str, Any]:
    """DEFAULTS with a company's overrides applied one level deep."""
    out = copy.deepcopy(DEFAULTS)
    for key, value in (overrides or {}).items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key].update(value)
        else:
            out[key] = value
    return out


def _lookup(table: dict[str, Any], source_kind: str, item_kind: str | None, default: Any):
    if item_kind and f"{source_kind}:{item_kind}" in table:
        return table[f"{source_kind}:{item_kind}"]
    return table.get(source_kind, default)


def score(f: Factors, settings: dict[str, Any] | None = None, now: datetime | None = None) -> Score:
    cfg = merged(settings)
    now = now or datetime.now(UTC)

    source = float(_lookup(cfg["source"], f.source_kind, f.item_kind, 0.5))
    if f.planning_doc:
        source = min(1.0, source + float(cfg["planning_bonus"]))

    if f.latest_at is None:
        freshness = float(cfg["freshness_floor"])
    else:
        age_days = max(0.0, (now - f.latest_at).total_seconds() / 86400)
        half_life = float(_lookup(cfg["half_life_days"], f.source_kind, f.item_kind, 90))
        freshness = max(float(cfg["freshness_floor"]), 0.5 ** (age_days / half_life))

    mentions = 1 - 0.5 ** max(1, f.mentions)

    contribution = "0" if f.goal_contribution is None else str(min(3, max(0, f.goal_contribution)))
    goal_impact = float(cfg["goal_impact"].get(contribution, 0.5))

    values = {
        "source": source,
        "freshness": freshness,
        "mentions": mentions,
        "goal_impact": goal_impact,
    }
    weights = {k: float(cfg["weights"].get(k, 0)) for k in values}
    total = sum(weights.values()) or 1.0
    confidence = sum(values[k] * weights[k] for k in values) / total
    breakdown = {k: {"value": round(values[k], 3), "weight": weights[k]} for k in values}
    return Score(confidence=round(confidence, 3), breakdown=breakdown)


def aggregate(confidences: list[float]) -> float | None:
    """A claim's confidence from its evidence: independent support raises it."""
    if not confidences:
        return None
    return round(1 - math.prod(1 - c for c in confidences), 3)


def rank_weight(confidence: float | None) -> float:
    """Multiplier for search relevance: low-confidence items sink but stay findable."""
    return 0.5 + 0.5 * (0.5 if confidence is None else confidence)


def prefer(a: float, b: float, settings: dict[str, Any] | None = None) -> int:
    """1 if a wins, -1 if b wins, 0 when within the tie margin (fall back to precedence)."""
    margin = float(merged(settings)["tie_margin"])
    if abs(a - b) <= margin:
        return 0
    return 1 if a > b else -1
