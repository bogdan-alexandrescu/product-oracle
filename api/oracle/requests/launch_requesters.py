"""H6's request lookup, registered by C1 Requests (H10 Reasoned no): the people who asked
for a launch's items, so launch notes reach them too.

For a launch's items: every Qualified request whose feature is an item's feature or whose
PRD is an item's PRD, and each request merged into one of those (through chains). Each is
a requester by the name as given ("Unnamed asker" without one), with what they asked.
A request declined, reopened and later shipped is Qualified by then, so its asker gets
H6's "shipped" note through the existing launch flow.
"""

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.launches.models import Launch
from oracle.launches.requesters import REQUEST_SOURCES, Requester
from oracle.requests.models import ProductRequest
from oracle.requests.replies import UNNAMED
from oracle.requests.service import _children, _merge_parents, descendants


async def request_requesters(db: AsyncSession, launch: Launch, items: list) -> list[Requester]:
    features = {i.feature_id for i in items if getattr(i, "feature_id", None)}
    prds = {i.prd_document_id for i in items if getattr(i, "prd_document_id", None)}
    if not features and not prds:
        return []
    matches = []
    if features:
        matches.append(ProductRequest.feature_id.in_(features))
    if prds:
        matches.append(ProductRequest.document_id.in_(prds))
    roots = list(
        await db.scalars(
            select(ProductRequest)
            .where(ProductRequest.state == "qualified", or_(*matches))
            .order_by(ProductRequest.created_at, ProductRequest.id)
        )
    )
    if not roots:
        return []
    children = _children(await _merge_parents(db))
    merged_ids = [d for r in roots for d in descendants(r.id, children)]
    merged = (
        list(
            await db.scalars(
                select(ProductRequest)
                .where(ProductRequest.id.in_(merged_ids))
                .order_by(ProductRequest.created_at, ProductRequest.id)
            )
        )
        if merged_ids
        else []
    )
    seen: set = set()
    out = []
    for r in [*roots, *merged]:
        if r.id in seen:
            continue
        seen.add(r.id)
        out.append(
            Requester(
                kind="request",
                request_id=r.id,
                display_name=r.requester_name or UNNAMED,
                asked="\n\n".join(p for p in (r.title, r.body) if p),
            )
        )
    return out


def register() -> None:
    """Adds the lookup once (imported by oracle.main)."""
    if request_requesters not in REQUEST_SOURCES:
        REQUEST_SOURCES.append(request_requesters)


register()
