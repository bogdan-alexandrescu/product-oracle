"""What calls taught Oracle about the agent runtime's features, kept in the database.

A submission or an answer shows whether a feature is on (SwarmCloud accepted Oracle's MCP
registration or a run token; a wait was submitted; a service answer was recorded) or off
(a 503 ``mcp_unavailable``, a 422 ``await_input_disabled``, a 403 ``person_required``).
Reads alone never show it. Kept in one process's memory, that knowledge was lost on every
deploy and was never shared by the other Cloud Run instances, so the runtime status and the
New run form said caller MCP was off or not confirmed until the next run was submitted
(UI test finding E3, 2026-10-20). The database is the instances' shared truth: each one
writes what it learns and reads what all of them learned on every feature read.

One row per feature, for the whole deployment: the runtime is Oracle's, not a company's
(no tenant). A row's lifetime is the in-memory one's: ``expires_at`` is the learned
state's end (the features cache's TTL after it was learned), NULL for a sticky state kept
until the runtime reports the feature on. An expired row still says what was learned
last: caller MCP stays confirmed until something shows it off, as it did in one process.
"""

import math
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Protocol

from sqlalchemy import CheckConstraint, DateTime, Text, delete, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Mapped, mapped_column

from oracle.db import Base
from oracle.swarm.runtime import FeatureState
from oracle.tenancy import unscoped_session


class LearnedFeature(Base):
    """The latest state a call taught Oracle about one runtime feature."""

    __tablename__ = "runtime_features"
    __table_args__ = (CheckConstraint("state IN ('on', 'off', 'unknown')", name="state"),)

    feature: Mapped[str] = mapped_column(Text, primary_key=True)
    state: Mapped[str] = mapped_column(Text, nullable=False)
    reason: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    learned_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # When the learned state stops applying; NULL: sticky, until the runtime reports the
    # feature on.
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


@dataclass(frozen=True)
class Learned:
    """A learned state, its reason, and when it was learned and ends (epoch seconds;
    ``until`` is infinite for a sticky state)."""

    state: FeatureState
    reason: str
    learned_at: float
    until: float

    @property
    def sticky(self) -> bool:
        return math.isinf(self.until)


class LearnedStore(Protocol):
    async def sync(
        self, save: Mapping[str, Learned], forget: Mapping[str, float]
    ) -> dict[str, Learned]:
        """Write ``save`` (a later learning is never overwritten by an earlier one), drop
        each sticky state in ``forget`` learned before the time given, and return the
        latest learning of every feature, expired ones included."""
        ...


def _at(seconds: float) -> datetime:
    return datetime.fromtimestamp(seconds, UTC)


class DatabaseLearnedStore:
    """The ``runtime_features`` table, in a short session of its own."""

    async def sync(
        self, save: Mapping[str, Learned], forget: Mapping[str, float]
    ) -> dict[str, Learned]:
        async with unscoped_session() as s:
            for feature, learned in save.items():
                values = {
                    "state": learned.state,
                    "reason": learned.reason,
                    "learned_at": _at(learned.learned_at),
                    "expires_at": None if learned.sticky else _at(learned.until),
                }
                stmt = insert(LearnedFeature).values(feature=feature, **values)
                await s.execute(
                    stmt.on_conflict_do_update(
                        index_elements=[LearnedFeature.feature],
                        set_=values,
                        # Another instance may have learned something since: newest wins.
                        where=LearnedFeature.learned_at <= stmt.excluded.learned_at,
                    )
                )
            for feature, at in forget.items():
                await s.execute(
                    delete(LearnedFeature).where(
                        LearnedFeature.feature == feature,
                        LearnedFeature.expires_at.is_(None),
                        LearnedFeature.learned_at <= _at(at),
                    )
                )
            rows = list(await s.scalars(select(LearnedFeature)))
            await s.commit()
        return {
            r.feature: Learned(
                state=r.state,  # type: ignore[arg-type]
                reason=r.reason,
                learned_at=r.learned_at.timestamp(),
                until=math.inf if r.expires_at is None else r.expires_at.timestamp(),
            )
            for r in rows
        }
