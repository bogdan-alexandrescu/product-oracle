"""H10 Inbox rows on Requests: Replies to send, Asked again, Answer to your request."""

import uuid
from datetime import timedelta

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.auth.deps import Principal
from oracle.decisions.models import Decision
from oracle.requests import replies
from oracle.requests.models import ProductRequest, RequestReply
from oracle.runs.schemas import InboxRequestReply
from oracle.tenant_settings_api import get_setting

# Answer to your request: shown for this long after a person told the member in Oracle.
ANSWER_DAYS = 14


async def _asked_again_counts(
    db: AsyncSession, roots: list[ProductRequest]
) -> dict[uuid.UUID, int]:
    from oracle.requests.service import _children, _merge_parents, descendants

    children = _children(await _merge_parents(db))
    ids = {d: r.id for r in roots for d in descendants(r.id, children)}
    if not ids:
        return {}
    merged = await db.execute(
        select(ProductRequest.id, ProductRequest.decided_at).where(ProductRequest.id.in_(list(ids)))
    )
    since = {r.id: r.asked_again_since for r in roots}
    out: dict[uuid.UUID, int] = {}
    for mid, at in merged.all():
        root = ids[mid]
        if at is not None and since[root] is not None and at > since[root]:
            out[root] = out.get(root, 0) + 1
    return out


async def inbox_rows(db: AsyncSession, principal: Principal) -> list[InboxRequestReply]:
    if principal.is_run or principal.user_id is None:
        return []
    me = principal.user_id
    rows: list[InboxRequestReply] = []

    # Replies to send: the request's filer and its decider.
    to_send = (
        await db.execute(
            select(ProductRequest, func.count(RequestReply.id))
            .join(RequestReply, RequestReply.root_request_id == ProductRequest.id)
            .where(
                RequestReply.status == "drafted",
                ProductRequest.state == "disqualified",
                or_(ProductRequest.filed_by == me, ProductRequest.decided_by == me),
            )
            .group_by(ProductRequest.id)
            .order_by(ProductRequest.decided_at.desc())
        )
    ).all()
    decisions = await replies.decisions_for(db, [r.id for r, _ in to_send])
    for r, n in to_send:
        d = decisions.get(r.id)
        rows.append(
            InboxRequestReply(
                request_id=r.id,
                title=r.title,
                reason="replies_to_send",
                count=n,
                decision_number=d.number if d else None,
                at=r.decided_at,
                counts=True,
            )
        )

    # Asked again N times since you said no: the decision's approver, at the threshold.
    mine = list(
        await db.scalars(
            select(Decision).where(
                Decision.origin == "request_decline",
                Decision.status == "decided",
                Decision.approver_id == me,
            )
        )
    )
    request_ids = [
        uuid.UUID(s["id"])
        for d in mine
        for s in d.subjects or []
        if s.get("kind") == "request" and s.get("id")
    ]
    if request_ids:
        roots = list(
            await db.scalars(
                select(ProductRequest).where(
                    ProductRequest.id.in_(request_ids), ProductRequest.state == "disqualified"
                )
            )
        )
        threshold = int(await get_setting(db, "request_asked_again_threshold"))
        counts = await _asked_again_counts(db, roots)
        latest = await replies.decisions_for(db, [r.id for r in roots])
        for r in roots:
            n = counts.get(r.id, 0)
            d = latest.get(r.id)
            if n >= threshold and d is not None and d.status == "decided" and d.approver_id == me:
                rows.append(
                    InboxRequestReply(
                        request_id=r.id,
                        title=r.title,
                        reason="asked_again",
                        count=n,
                        decision_number=d.number,
                        at=r.decided_at,
                        counts=True,
                    )
                )

    # Answer to your request: the member who asked, shown only.
    since = replies.now() - timedelta(days=ANSWER_DAYS)
    told = (
        await db.execute(
            select(RequestReply, ProductRequest.title)
            .join(ProductRequest, ProductRequest.id == RequestReply.request_id)
            .where(
                RequestReply.member_id == me,
                RequestReply.status == "notified",
                RequestReply.notified_at >= since,
            )
            .order_by(RequestReply.notified_at.desc())
        )
    ).all()
    for reply, title in told:
        rows.append(
            InboxRequestReply(
                request_id=reply.request_id,
                title=title,
                reason="answer",
                body=reply.body,
                at=reply.notified_at,
                counts=False,
            )
        )
    return rows
