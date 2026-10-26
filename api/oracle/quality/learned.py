"""What kept learnings tell later recommendations (build prompt §10, 03b §5).

``nudges`` reads the active learnings about one kind of target (modules or question
categories) and gives each target its net signal, the words of the learnings behind it
and the reason a person reads ("Recommended because ..."). Retired learnings never count.

The effect is capped: each point of net signal moves a question's rank score by
``LEARNING_STEP`` of itself (``apply``) and a module's 0-1 advisory score by
``LEARNING_STEP`` (the composer), never more than ``LEARNING_CAP`` either way. The cap
sits below one importance step (high is 3/4 of critical, medium 2/3 of high), so among
gaps of like impact learnings reorder questions of the same importance but one signal
never outweighs a gap's importance. In a module composition a learning only suggests a
module that is unconditional or whose condition held, and never overrides company
policy, a condition or a person's decision.
"""

import uuid
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.quality.models import QualityLearning

LEARNING_STEP = 0.1
LEARNING_CAP = 0.2
SIGN = {"recommend_more": 1, "recommend_less": -1, "note": 0}


@dataclass(frozen=True)
class Nudge:
    """The net signal of the active learnings about one target (never zero)."""

    target: str
    net: int
    # The learnings pulling the way of the net signal: how many, and their words,
    # newest first.
    count: int
    statements: tuple[str, ...]

    @property
    def factor(self) -> float:
        """The capped share a score moves by: within +/- LEARNING_CAP."""
        return max(-LEARNING_CAP, min(LEARNING_CAP, self.net * LEARNING_STEP))

    def reason(self) -> str:
        how = "Recommended" if self.net > 0 else "Recommended less"
        which = "a learning" if self.count == 1 else f"{self.count} learnings"
        said = self.statements[0].strip()
        if said and said[-1] not in ".!?":
            said += "."
        return f"{how} because of {which} from past outcomes: {said}"

    def as_json(self) -> dict:
        return {
            "target": self.target,
            "net": self.net,
            "count": self.count,
            "statements": list(self.statements),
        }

    @classmethod
    def from_json(cls, data: dict) -> "Nudge":
        return cls(
            str(data["target"]), int(data["net"]), int(data["count"]), tuple(data["statements"])
        )


def stored(analysis: dict | None) -> dict[uuid.UUID, Nudge]:
    """The nudges an intake's last question sync ranked its gaps with, by gap id
    (``analysis["learned"]``): what every reader ranks its questions with until the next
    sync, so a learning added or retired since moves nobody's order."""
    raw = (analysis or {}).get("learned") or {}
    return {uuid.UUID(k): Nudge.from_json(v) for k, v in raw.items()}


def apply(score: float, nudge: "Nudge | None") -> float:
    """A score moved by a learning's capped factor."""
    return score if nudge is None else round(score * (1 + nudge.factor), 3)


async def nudges(db: AsyncSession, applies_to: str) -> dict[str, Nudge]:
    """Each target's nudge from the active learnings about ``applies_to`` targets."""
    rows = await db.scalars(
        select(QualityLearning)
        .where(QualityLearning.status == "active", QualityLearning.applies_to == applies_to)
        .order_by(QualityLearning.created_at.desc(), QualityLearning.id)
    )
    groups: dict[str, list[QualityLearning]] = {}
    for row in rows:
        groups.setdefault(row.target, []).append(row)
    out: dict[str, Nudge] = {}
    for target, group in groups.items():
        net = sum(SIGN[r.direction] * r.weight for r in group)
        if net == 0:
            continue
        way = [r for r in group if SIGN[r.direction] == (1 if net > 0 else -1)]
        out[target] = Nudge(target, net, len(way), tuple(r.statement for r in way[:3]))
    return out
