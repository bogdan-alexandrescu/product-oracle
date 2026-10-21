"""The tier Oracle suggests for a launch: the innovation x goal matrix (research [66]).

|                  | serves a top goal | another goal or none |
|------------------|-------------------|----------------------|
| new              | Tier 1            | Tier 2               |
| improvement      | Tier 2            | Tier 3               |
| fix or internal  | Tier 3            | Tier 3               |

Read from the baseline, per item of the launch (the launch takes the highest tier any
of its items gets):

- **innovation**: ``fix`` when the item has no feature and no requirements (nothing
  external-facing) or its feature is marked ``internal``; ``new`` when the PRD's template
  is the PR/FAQ or the feature entity was created for this PRD (no earlier than the PRD
  document); ``improvement`` otherwise. The item's feature is its traced ``feature_id``,
  else the feature entity whose key is the item's id.
- **goal**: the confirmed goals with the highest weight (``attrs.weight``, 1 when unset)
  are the top goals. ``top`` when the feature supports a top goal (a confirmed
  ``supports`` edge, contribution above 0); ``other`` when it supports only other
  confirmed goals; ``none`` when it supports none.

An approver sets the tier; until then the suggestion stands, with its reason in words.
"""

from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.baseline.models import Edge, Entity
from oracle.docs.models import Document
from oracle.launches.models import Launch
from oracle.priorities.scoring import DEFAULT_CONTRIBUTION, DEFAULT_WEIGHT
from oracle.roadmap.models import RoadmapItem

INNOVATIONS = ("new", "improvement", "fix")
GOALS = ("top", "other", "none")
PR_FAQ = "pr-faq"

_MATRIX = {
    ("new", "top"): 1,
    ("new", "other"): 2,
    ("improvement", "top"): 2,
    ("improvement", "other"): 3,
    ("fix", "top"): 3,
    ("fix", "other"): 3,
}
_KIND = {"new": "New feature", "improvement": "Improvement"}


def matrix(innovation: str, goal: str) -> int:
    """The matrix cell; a feature serving no goal is in the 'another goal or none' column."""
    return _MATRIX[(innovation, "top" if goal == "top" else "other")]


def reason(innovation: str, goal: str, goal_title: str | None) -> str:
    """The suggestion's reason in words, e.g. "New feature serving a top goal (Raise
    activation)"."""
    if innovation == "fix":
        return "Fix or internal change"
    kind = _KIND[innovation]
    if goal == "none" or not goal_title:
        return f"{kind} serving no confirmed goal"
    which = "a top goal" if goal == "top" else "another goal"
    return f"{kind} serving {which} ({goal_title})"


def _number(value: Any, default: float) -> float:
    try:
        return float(value) if value is not None else default
    except (TypeError, ValueError):
        return default


async def _feature(db: AsyncSession, item: RoadmapItem) -> Entity | None:
    if item.feature_id is not None:
        found = await db.get(Entity, item.feature_id)
        if found is not None:
            return found
    return await db.scalar(
        select(Entity).where(Entity.type == "feature", Entity.key == item.item_key)
    )


async def items_of(db: AsyncSession, launch: Launch) -> list[RoadmapItem]:
    """The launch's roadmap items, in the launch's order."""
    if launch.roadmap_version_id is None or not launch.item_keys:
        return []
    rows = {
        i.item_key: i
        for i in await db.scalars(
            select(RoadmapItem).where(
                RoadmapItem.roadmap_version_id == launch.roadmap_version_id,
                RoadmapItem.item_key.in_(launch.item_keys),
            )
        )
    }
    return [rows[k] for k in launch.item_keys if k in rows]


async def _innovation(db: AsyncSession, item: RoadmapItem, feature: Entity | None) -> str:
    if feature is None:
        return "fix" if not item.requirement_ids else "improvement"
    if (feature.attrs or {}).get("internal"):
        return "fix"
    prd = await db.get(Document, item.prd_document_id) if item.prd_document_id else None
    if prd is not None and prd.template == PR_FAQ:
        return "new"
    if prd is not None and feature.created_at >= prd.created_at:
        return "new"
    return "improvement"


async def _goal(db: AsyncSession, feature: Entity | None) -> tuple[str, str | None]:
    goals = {
        g.id: g
        for g in await db.scalars(
            select(Entity).where(Entity.type == "goal", Entity.status == "confirmed")
        )
    }
    if feature is None or not goals:
        return "none", None
    weights = {
        gid: _number((g.attrs or {}).get("weight"), DEFAULT_WEIGHT) for gid, g in goals.items()
    }
    top = max(weights.values())
    served: list[tuple[float, float, Entity]] = []
    for edge in await db.scalars(
        select(Edge).where(
            Edge.src_id == feature.id,
            Edge.type == "supports",
            Edge.status == "confirmed",
            Edge.dst_id.in_(goals),
        )
    ):
        contribution = _number((edge.attrs or {}).get("contribution"), DEFAULT_CONTRIBUTION)
        if contribution > 0:
            weight = weights[edge.dst_id]
            served.append((weight, weight * contribution, goals[edge.dst_id]))
    if not served:
        return "none", None
    tops = [s for s in served if s[0] == top]
    if tops:
        best = max(tops, key=lambda s: (s[1], s[2].title))
        return "top", best[2].title
    best = max(served, key=lambda s: (s[1], s[2].title))
    return "other", best[2].title


async def suggest(db: AsyncSession, launch: Launch) -> dict[str, Any]:
    """``{"tier", "reason", "innovation", "goal", "goal_title"}`` for the launch: the
    highest tier (lowest number) any of its items gets; a launch with no readable item
    is a Tier 3 fix."""
    best: dict[str, Any] | None = None
    for item in await items_of(db, launch):
        feature = await _feature(db, item)
        innovation = await _innovation(db, item, feature)
        goal, title = await _goal(db, feature)
        tier = matrix(innovation, goal)
        if best is None or tier < best["tier"]:
            best = {
                "tier": tier,
                "reason": reason(innovation, goal, title),
                "innovation": innovation,
                "goal": goal,
                "goal_title": title,
                "item_key": item.item_key,
            }
    return best or {
        "tier": 3,
        "reason": reason("fix", "none", None),
        "innovation": "fix",
        "goal": "none",
        "goal_title": None,
        "item_key": None,
    }
