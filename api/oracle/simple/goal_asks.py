"""edit-goals-prds EG1: Archive and Delete a goal through the change engine, so who may
not archive or delete a goal (below approver, as ``archive_bucket_goal`` and
``delete_bucket_goal`` need) asks for it.

- ``POST /v1/simple/changes`` op ``archive_goal`` or ``delete_goal``, ``target``
  ``{goal_id, to_goal_id?}`` (where the goal's features go, as Archive moves them): an
  approver or owner's applies at once (``applied``); a commenter's is ``proposed``, routed
  to the company's owners (``GoalBucketsOut.asks_to`` names them), one open ask per goal
  and op. An approver or owner accepts (the goal is archived, or goes to Trash with
  oracle.simple.trash_items.trash_goal) or declines it (nothing changes).
"""

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, company_time
from oracle.authz import has_role
from oracle.simple.models import SimpleChange

OPS: frozenset[str] = frozenset({"archive_goal", "delete_goal"})


def may_decide(principal: Any) -> bool:
    return has_role(principal.role, "approver")


def _id(raw: Any, field: str) -> uuid.UUID:
    from oracle.simple.changes import ChangeError

    try:
        return uuid.UUID(str(raw))
    except ValueError:
        raise ChangeError(422, f"{field} is not an id") from None


async def _apply(db: AsyncSession, principal: Any, c: SimpleChange) -> None:
    from oracle.simple import goal_buckets, trash_items

    goal_id = _id(c.target.get("goal_id"), "goal_id")
    to = c.target.get("to_goal_id")
    to_id = _id(to, "to_goal_id") if to else None
    if c.op == "archive_goal":
        await goal_buckets.archive(db, goal_id, to_id)
        return
    g = await goal_buckets._entity(db, goal_id, "goal")
    if to_id is not None:
        dest = await goal_buckets._entity(db, to_id, "goal")
        if dest.id == g.id or dest.status == "rejected":
            from oracle.simple.changes import ChangeError

            raise ChangeError(422, "Pick another goal")
    await trash_items.trash_goal(db, principal, g, to_id, c.reason)


async def create_change(db: AsyncSession, principal: Any, body: Any) -> Any:
    from oracle.simple import goal_buckets
    from oracle.simple.changes import ChangeError, _company_owners, _me, one_out
    from oracle.simple.schemas import SimpleChangeResult

    goal_id = _id(body.target.get("goal_id"), "goal_id")
    g = await goal_buckets._entity(db, goal_id, "goal")
    if body.op == "archive_goal" and g.status == "rejected":
        raise ChangeError(409, f"{g.title} is archived already")
    to = body.target.get("to_goal_id")
    target = {"goal_id": str(g.id), "title": g.title,
              "to_goal_id": str(_id(to, "to_goal_id")) if to else None}  # fmt: skip
    done = may_decide(principal)
    if not done:
        open_ = await db.scalar(
            select(SimpleChange.id).where(
                SimpleChange.op == body.op,
                SimpleChange.status == "proposed",
                SimpleChange.target["goal_id"].astext == str(g.id),
            )
        )
        if open_ is not None:
            raise ChangeError(409, "This is asked already")
    c = SimpleChange(
        document_id=None, op=body.op, target=target, before={}, after={},
        status="applied" if done else "proposed", by=_me(principal), at=company_time.now(),
        reason=body.reason, routed_to=[] if done else await _company_owners(db),
    )  # fmt: skip
    if done:
        await _apply(db, principal, c)
    db.add(c)
    await db.flush()
    await audit.record(db, principal, f"simple_change.{c.status}", "simple_change", c.id,
                       data={"op": c.op, "target": c.target})  # fmt: skip
    await db.commit()
    return SimpleChangeResult(change=await one_out(db, principal, c), flags=[])


async def decide(
    db: AsyncSession, principal: Any, c: SimpleChange, action: str, reason: str | None
) -> Any:
    """Accept (archive the goal, or move it to Trash) or decline an ask."""
    from oracle.simple.changes import ChangeError, _me, one_out
    from oracle.simple.schemas import SimpleChangeResult

    if not may_decide(principal):
        raise ChangeError(403, "Only an approver or owner decides this")
    if c.status != "proposed":
        raise ChangeError(409, f"This change is {c.status} already")
    if action == "accept":
        await _apply(db, principal, c)
    c.status = "accepted" if action == "accept" else "declined"
    c.decided_by, c.decided_at, c.decision_reason = _me(principal), company_time.now(), reason
    await db.flush()
    await audit.record(db, principal, f"simple_change.{c.status}", "simple_change", c.id,
                       data={"op": c.op, "target": c.target, "reason": reason})  # fmt: skip
    await db.commit()
    return SimpleChangeResult(change=await one_out(db, principal, c), flags=[])
