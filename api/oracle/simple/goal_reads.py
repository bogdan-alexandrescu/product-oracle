"""tb-mk: the company's goals, read once per session (one request: a roadmap read's items,
tracks, ladder, codes, goal targets and plans share it) until the session writes or ends,
as oracle.roadmap.company.history is."""

from typing import Any

from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import ORMExecuteState, Session

from oracle.baseline.models import Entity

_CACHE = "simple_goals"


@event.listens_for(Session, "after_flush")
@event.listens_for(Session, "after_commit")
@event.listens_for(Session, "after_rollback")
@event.listens_for(Session, "after_soft_rollback")
def _forget(session: Session, *_: Any) -> None:
    session.info.pop(_CACHE, None)


@event.listens_for(Session, "do_orm_execute")
def _forget_on_write(state: ORMExecuteState) -> None:
    if not state.is_select:
        state.session.info.pop(_CACHE, None)


async def all_goals(db: AsyncSession) -> list[Entity]:
    """Every goal not in Trash (rejected ones too), in the order the database gives them."""
    info = db.sync_session.info
    if (cached := info.get(_CACHE)) is None:
        cached = info[_CACHE] = list(await db.scalars(select(Entity).where(Entity.type == "goal")))
    return cached


async def goals_by_id(db: AsyncSession) -> dict[Any, Entity]:
    return {g.id: g for g in await all_goals(db)}
