"""C1e: feedback in the Inbox by state, and the staged rows for the next draft.

States: ``new`` (open and raised after my last Inbox visit), ``open``, ``staged`` (its
suggestion was accepted and waits for the next draft, or an approver staged it for the
agents, D12), ``declined`` and ``done``
(addressed, applied or superseded). My last visit is a per-user preference
(``inbox_last_seen_at``), set by ``GET /v1/inbox?mark_seen=true``; before the first visit
every open item is new.
"""

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import ColumnElement, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.docs.models import Document, DocumentVersion, Section
from oracle.jobs import kinds
from oracle.jobs.models import LlmSuggestion
from oracle.jobs.next_draft import current_job
from oracle.jobs.service import (
    latest_suggestions,
    oracle_notes,
    shown_note,
    staged_suggestions,
    suggestion_out,
)
from oracle.preferences.models import UserPreference
from oracle.review.models import FeedbackItem
from oracle.review.service import feedback_state, latest_numbers, staged_for_agents
from oracle.runs.schemas import InboxCounts, InboxFeedbackItem, InboxStaged

LAST_SEEN = "inbox_last_seen_at"
#: Declined and done items listed at most (the counts are always complete).
SETTLED_LIMIT = 100
#: An Inbox row shows this much of a suggestion's text and rationale; the document has the rest.
EXCERPT = 280


def _excerpt(text: str | None) -> str | None:
    if text is None:
        return None
    return text if len(text) <= EXCERPT else text[:EXCERPT] + "…"


async def last_seen_and(
    db: AsyncSession, principal_id: uuid.UUID, *flags: ColumnElement[bool]
) -> tuple[datetime | None, list[bool]]:
    """My last Inbox visit, and each of ``flags`` in the same read (#689 review: the Inbox's
    checks for rows most readers never have ride on it rather than read on their own)."""
    stored = (
        select(UserPreference.value)
        .where(UserPreference.principal_id == principal_id, UserPreference.key == LAST_SEEN)
        .scalar_subquery()
    )
    value, *got = (await db.execute(select(stored, *flags))).one()
    return _seen_at(value), [bool(f) for f in got]


def _seen_at(value: Any) -> datetime | None:
    try:
        return datetime.fromisoformat(value) if isinstance(value, str) else None
    except ValueError:
        return None


async def mark_seen(db: AsyncSession, principal_id: uuid.UUID, at: datetime | None = None) -> None:
    value = (at or datetime.now(UTC)).isoformat()
    row = await db.scalar(
        select(UserPreference).where(
            UserPreference.principal_id == principal_id, UserPreference.key == LAST_SEEN
        )
    )
    if row is None:
        db.add(UserPreference(principal_id=principal_id, key=LAST_SEEN, value=value))
    else:
        row.value = value
    await db.flush()


_STAGED = (
    LlmSuggestion.kind == "section_text",
    LlmSuggestion.status == "accepted",
    LlmSuggestion.applied_in_version.is_(None),
)


def _with_staged_change():
    """Items with an accepted section-text change no draft has applied yet. They stay live
    (Staged) whatever their own status (owner, 2026-10-20): closing the item, as a draft's
    resolutions or an approval do, does not take the change out of the next draft."""
    return select(LlmSuggestion.feedback_item_id).where(*_STAGED)


async def feedback_states(
    db: AsyncSession, seen: datetime | None
) -> tuple[list[InboxFeedbackItem], InboxCounts]:
    """Every live item (open, or with a staged change) and the most recent settled ones,
    newest first."""
    live = list(
        await db.scalars(
            select(FeedbackItem)
            .where(or_(FeedbackItem.status == "open", FeedbackItem.id.in_(_with_staged_change())))
            .order_by(FeedbackItem.created_at.desc(), FeedbackItem.id)
        )
    )
    live_ids = {f.id for f in live}
    settled_only = (
        FeedbackItem.status != "open",
        FeedbackItem.id.not_in(_with_staged_change()),
    )
    settled = list(
        await db.scalars(
            select(FeedbackItem)
            .where(*settled_only)
            .order_by(FeedbackItem.updated_at.desc(), FeedbackItem.id)
            .limit(SETTLED_LIMIT * 2)
        )
    )
    settled_counts = dict(
        (
            await db.execute(
                select(FeedbackItem.status, func.count())
                .where(*settled_only)
                .group_by(FeedbackItem.status)
            )
        ).all()
    )
    rows = [*live, *settled]
    suggestions = await latest_suggestions(db, [f.id for f in rows])
    staged = await staged_suggestions(db, [f.id for f in live])
    notes = await oracle_notes(db, rows)
    latest = await latest_numbers(db, {f.document_id for f in rows})
    docs = {
        d.id: d
        for d in await db.scalars(
            select(Document).where(Document.id.in_({f.document_id for f in rows}))
        )
    }
    counts = InboxCounts(
        declined=settled_counts.get("declined", 0),
        done=sum(v for k, v in settled_counts.items() if k != "declined"),
    )
    items: list[InboxFeedbackItem] = []
    settled_listed = 0
    for f in rows:
        s = suggestions.get(f.id)
        state = feedback_state(f.status, staged.get(f.id, s), f.staged_for_agents_at)
        if state == "open" and (seen is None or f.created_at > seen):
            state = "new"
        if f.id in live_ids:
            if state == "done":
                counts.done += 1
            else:
                setattr(counts, state, getattr(counts, state) + 1)
        elif settled_listed >= SETTLED_LIMIT:
            continue
        else:
            settled_listed += 1
        d = docs.get(f.document_id)
        acting = s if s is not None and s.status == "open" else None
        # #636 re-review: a withheld item's suggestion text and rationale are left out.
        shown = suggestion_out(acting, f.withheld_at is not None) if acting else None
        items.append(
            InboxFeedbackItem(
                id=f.id,
                summary=f.summary,
                kind=f.kind,  # type: ignore[arg-type]
                section_key=f.section_key,
                raised_on_version=f.raised_on_version,
                created_at=f.created_at,
                updated_at=f.updated_at,
                document_id=f.document_id,
                slug=d.slug if d else None,
                title=d.title if d else None,
                latest_version=latest.get(f.document_id),
                state=state,  # type: ignore[arg-type]
                resolution_note=shown_note(f, notes),
                addressed_in_version=f.addressed_in_version,
                staged_for_version=(latest.get(f.document_id) or 0) + 1
                if state == "staged"
                else None,
                staged_for_agents=staged_for_agents(f),
                suggestion_status=s.status if s else None,  # type: ignore[arg-type]
                suggestion_kind=s.kind if s else None,
                suggestion_id=acting.id if acting else None,
                suggestion_text=_excerpt(shown.edited_text or shown.text) if shown else None,
                suggestion_pushback=acting.pushback is not None if acting else None,
                suggestion_rationale=_excerpt(shown.rationale) if shown else None,
            )
        )
    items.sort(key=lambda i: (i.created_at, str(i.id)), reverse=True)
    return items, counts


def _agent_staged():
    """D12: open items an approver staged for the agents."""
    return (FeedbackItem.status == "open", FeedbackItem.staged_for_agents_at.is_not(None))


async def staged_rows(db: AsyncSession) -> list[InboxStaged]:
    """One row per document with staged changes: 'N changes staged for draft N+1',
    counting the text changes and the items staged for the agents."""
    doc_ids = set(await db.scalars(select(LlmSuggestion.document_id).where(*_STAGED)))
    agents = dict(
        (
            await db.execute(
                select(FeedbackItem.document_id, func.count())
                .where(*_agent_staged())
                .group_by(FeedbackItem.document_id)
            )
        ).all()
    )
    doc_ids |= set(agents)
    # G4: the discussions' section changes staged for the next draft count with them.
    from oracle.staging.models import NextDraftChange

    discussed: dict[Any, list[str]] = {}
    for doc_id, key in (
        await db.execute(
            select(NextDraftChange.document_id, NextDraftChange.section_key).where(
                NextDraftChange.status == "staged"
            )
        )
    ).all():
        discussed.setdefault(doc_id, []).append(key)
    doc_ids |= set(discussed)
    if not doc_ids:
        return []
    latest = await latest_numbers(db, doc_ids)
    out = []
    for d in await db.scalars(select(Document).where(Document.id.in_(doc_ids))):
        rows = await kinds.staged_suggestions(db, d.id)
        number = latest.get(d.id)
        keys: set[str] = set()
        if number is not None:
            keys = set(
                await db.scalars(
                    select(Section.section_key)
                    .join(DocumentVersion, DocumentVersion.id == Section.version_id)
                    .where(DocumentVersion.document_id == d.id, DocumentVersion.number == number)
                )
            )
        buildable = [r for r in rows if r.section_key in keys]
        sections = discussed.get(d.id, [])
        built_rows = [k for k in sections if k in keys]
        job = await current_job(db, d.id)
        out.append(
            InboxStaged(
                document_id=d.id,
                slug=d.slug,
                title=d.title,
                latest_version=number,
                next_version=(number or 0) + 1,
                count=len(buildable) + len(built_rows) + agents.get(d.id, 0),
                gone_count=len(rows) - len(buildable) + len(sections) - len(built_rows),
                draft_job_id=job.id if job else None,
                draft_job_status=job.status if job else None,
            )
        )
    out.sort(key=lambda r: r.title.lower())
    return [r for r in out if r.count or r.gone_count]
