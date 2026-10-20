"""Full-text search over the current user's items (and, for a run, the items findings
shared in full released, at the version released: ``also``).

Matches use ``websearch_to_tsquery`` against the generated ``search`` tsvector of the
versions a read sees (current, or pinned at ``as_of``). Results are ordered by
``ts_rank x confidence.rank_weight(item confidence)``, so a low-confidence item sinks
but stays findable. Confidence is computed in Python, so the database returns the
best ``CANDIDATES`` by text relevance and the final order is taken over those.
"""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import confidence
from oracle.sources import items
from oracle.sources.models import Source, SourceItem, SourceItemVersion

CANDIDATES = 200
HEADLINE_OPTIONS = "MaxWords=30, MinWords=12, MaxFragments=2, StartSel=<mark>, StopSel=</mark>"


async def search(
    session: AsyncSession,
    user_id: uuid.UUID,
    q: str,
    *,
    kinds: list[str] | None = None,
    source_id: uuid.UUID | None = None,
    as_of: datetime | None = None,
    txn_snapshot: str | None = None,
    limit: int = 20,
    exclude: set[uuid.UUID] | None = None,
    include: set[uuid.UUID] | None = None,
    source_ids: list[uuid.UUID] | None = None,
    also: items.RunReads | None = None,
) -> list[dict[str, Any]]:
    """``exclude``: items the caller may not read; ``include``: the only items the
    caller may be shown; ``source_ids``: the only sources searched; ``also``: a run's
    reads (S6, ``items.RunReads``): shared items at the version released only, whoever
    owns them and whatever ``as_of`` says, and nothing deleted upstream. All applied in SQL, before
    ranking and the limit, so what is left out never changes what is returned."""
    if include is not None and not include:
        return []
    query = func.websearch_to_tsquery("english", q)
    visible = items.version_ids(user_id, as_of, txn_snapshot, also).subquery()
    rank = func.ts_rank(SourceItemVersion.search, query)
    stmt = (
        select(SourceItem, SourceItemVersion, Source.kind, rank.label("rank"))
        .join(SourceItem, SourceItem.id == SourceItemVersion.item_id)
        .join(Source, Source.id == SourceItem.source_id)
        .where(
            SourceItemVersion.id.in_(select(visible.c.id)),
            SourceItemVersion.search.op("@@")(query),
        )
        .order_by(rank.desc(), SourceItemVersion.id)
        .limit(CANDIDATES)
    )
    if kinds:
        stmt = stmt.where(SourceItem.kind.in_(kinds))
    if source_id is not None:
        stmt = stmt.where(SourceItem.source_id == source_id)
    if exclude:
        stmt = stmt.where(SourceItem.id.not_in(exclude))
    if include is not None:
        stmt = stmt.where(SourceItem.id.in_(include))
    if source_ids:
        stmt = stmt.where(SourceItem.source_id.in_(source_ids))
    rows = (await session.execute(stmt)).all()
    if not rows:
        return []

    settings = await items.confidence_settings(session)
    scored = []
    for item, version, source_kind, relevance in rows:
        row = items.ItemRow(item, version, source_kind)
        out = items.item_out(row, settings, now=as_of)
        weight = confidence.rank_weight(out["confidence"]["value"])
        scored.append((float(relevance) * weight, float(relevance), version.id, out))
    scored.sort(key=lambda s: (-s[0], -s[1], str(s[2])))
    top = scored[:limit]

    # Snippets only for the hits returned.
    ids = [s[2] for s in top]
    headline = func.ts_headline("english", SourceItemVersion.content, query, HEADLINE_OPTIONS)
    snippets = dict(
        (
            await session.execute(
                select(SourceItemVersion.id, headline).where(SourceItemVersion.id.in_(ids))
            )
        ).all()
    )
    return [
        {
            "item": out,
            "snippet": snippets.get(version_id, ""),
            "relevance": round(relevance, 6),
            "score": round(score, 6),
        }
        for score, relevance, version_id, out in top
    ]
