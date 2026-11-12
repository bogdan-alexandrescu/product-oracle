"""prio-twin-propose (the owner, Nov 10: "Offer a proposal"): a same-name twin on Priorities that
is a separate Ground Truth feature, merged through the change engine, so who may not merge
Ground Truth features (below approver, as merge_twin needs) proposes it.

- ``POST /v1/simple/changes`` op ``merge_twin``, ``target`` ``{feature_id, into_id}`` (the twin's
  feature and the row's): refused as merge_twin refuses a feature that is not the row's twin
  (422: not two Ground Truth features, or none of its names is the row's); a viewer's is 403.
  An approver's or owner's runs merge_twin at once (``applied``); a commenter's is ``proposed``,
  routed to the company's owners, one open proposal per twin. An approver or owner accepts it:
  the same merge_twin runs (every roadmap; its 409 and 422 refusals, nothing written); a
  decline changes nothing. A waiting proposal shows on its twin on Priorities; when the twin's
  feature is merged by any other way (an approver's Merge into…), it is closed (``close_open``).
"""

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, company_time
from oracle.authz import has_role
from oracle.simple.models import SimpleChange

OPS: frozenset[str] = frozenset({"merge_twin"})


def may_act(principal: Any) -> bool:
    """Merges a twin at once (as merge_twin allows)."""
    return has_role(principal.role, "approver")


def may_decide(principal: Any) -> bool:
    """Decides a proposed merge: who may run merge_twin (it refuses roadmaps they do not decide)."""
    return has_role(principal.role, "approver")


def _id(raw: Any, field: str) -> uuid.UUID:
    from oracle.simple.changes import ChangeError

    try:
        return uuid.UUID(str(raw))
    except ValueError:
        raise ChangeError(422, f"{field} is not an id") from None


async def _apply(db: AsyncSession, principal: Any, c: SimpleChange) -> None:
    from oracle.simple import priorities

    await priorities.merge_twin(
        db, principal, _id(c.target.get("feature_id"), "feature_id"),
        _id(c.target.get("into_id"), "into_id"),
    )  # fmt: skip


async def close_open(db: AsyncSession, principal: Any, feature_id: uuid.UUID, note: str) -> None:
    """The open proposals to merge ``feature_id``, merged just now, are closed (declined,
    ``note``): nothing is left to accept (baseline.merge_entity). Not committed."""
    from oracle.simple.changes import _me

    for c in await db.scalars(
        select(SimpleChange).where(
            SimpleChange.op.in_(OPS),
            SimpleChange.status == "proposed",
            SimpleChange.target["feature_id"].astext == str(feature_id),
        )
    ):
        c.status, c.decision_reason = "declined", note
        c.decided_by, c.decided_at = _me(principal), company_time.now()


async def create_change(db: AsyncSession, principal: Any, body: Any) -> Any:
    from oracle.simple import priorities
    from oracle.simple.changes import ChangeError, _company_owners, _me, one_out
    from oracle.simple.schemas import SimpleChangeResult

    if not has_role(principal.role, "commenter"):
        raise ChangeError(403, "Only a commenter or above proposes a merge")
    source, into, code, into_code = await priorities.check_twin_merge(
        db, principal, _id(body.target.get("feature_id"), "feature_id"),
        _id(body.target.get("into_id"), "into_id"),
    )  # fmt: skip
    # Each named by the code Priorities shows it with, for the change's words.
    target = {"feature_id": str(source.id), "into_id": str(into.id), "title": source.title,
              "into_title": into.title, "code": code, "into_code": into_code}  # fmt: skip
    done = may_act(principal)
    if not done:
        open_ = await db.scalar(
            select(SimpleChange.id).where(
                SimpleChange.op == body.op,
                SimpleChange.status == "proposed",
                SimpleChange.target["feature_id"].astext == str(source.id),
            )
        )
        if open_ is not None:
            raise ChangeError(409, "This merge is proposed already")
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
    """Accept (merge_twin, as the decider) or decline a proposed merge."""
    from oracle.simple.changes import ChangeError, _me, one_out
    from oracle.simple.schemas import SimpleChangeResult

    if not may_decide(principal):
        raise ChangeError(403, "Only an approver merges Ground Truth features")
    if c.status != "proposed":
        raise ChangeError(409, f"This change is {c.status} already")
    if action == "accept":
        # The merge closes its open proposals (close_open), this one too: it is accepted below.
        await _apply(db, principal, c)
    c.status = "accepted" if action == "accept" else "declined"
    c.decided_by, c.decided_at, c.decision_reason = _me(principal), company_time.now(), reason
    await db.flush()
    await audit.record(db, principal, f"simple_change.{c.status}", "simple_change", c.id,
                       data={"op": c.op, "target": c.target, "reason": reason})  # fmt: skip
    await db.commit()
    return SimpleChangeResult(change=await one_out(db, principal, c), flags=[])
