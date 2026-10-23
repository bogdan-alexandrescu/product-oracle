"""G6: discussion rows in the one Inbox.

Invited and Mentioned rows are written with the message or the add that makes them (in
its transaction), done when the person reads past them or dismisses them, and deleted at
once when they are removed. "Changes proposed" rows are derived on read: participants
who are approvers and up get one for Oracle's ``proposed`` and people's ``suggested``
changes; approvers not in an open discussion get one for ``suggested`` changes only
(c6: commenters suggest, approvers stage). Every row is shown with G1's access check at
read time, so none shows a title its reader may not see.
"""

import uuid
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING

from sqlalchemy import delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.authz import has_role
from oracle.discussions import access
from oracle.discussions.models import (
    Discussion,
    DiscussionChange,
    DiscussionInboxItem,
    DiscussionMessage,
    DiscussionParticipant,
)
from oracle.members.names import display_name
from oracle.runs.schemas import InboxDiscussionItem, InboxDiscussionPerson

if TYPE_CHECKING:
    from oracle.auth.deps import Principal

#: A mention's row shows this much of its message.
EXCERPT = 140
#: Done rows are kept this long, and at most SETTLED_LIMIT listed (C1e).
DONE_DAYS = 30
SETTLED_LIMIT = 100
PEOPLE_SHOWN = 3
CHANGES_ID = "chg_"
PREFIX = {"invited": "inv_", "mentioned": "men_"}


class InboxItemNotFound(Exception):
    pass


# --- writing (G1's service calls these in its transactions) -------------------------------


async def invited(
    db: AsyncSession, d: Discussion, user_ids: list[uuid.UUID], by: uuid.UUID | None
) -> None:
    """Someone else added these people (a mention, or a private one's starter)."""
    for u in user_ids:
        if u == by:
            continue
        row = await db.scalar(
            select(DiscussionInboxItem).where(
                DiscussionInboxItem.user_id == u,
                DiscussionInboxItem.discussion_id == d.id,
                DiscussionInboxItem.kind == "invited",
            )
        )
        if row is None:
            db.add(
                DiscussionInboxItem(
                    created_at=datetime.now(UTC),
                    user_id=u,
                    discussion_id=d.id,
                    kind="invited",
                    by_user_id=by,
                )
            )
    await db.flush()


async def mentioned(
    db: AsyncSession, message: DiscussionMessage, user_ids: list[uuid.UUID]
) -> None:
    """A message mentions people already in the discussion."""
    for u in dict.fromkeys(user_ids):
        if u == message.author_id:
            continue
        db.add(
            DiscussionInboxItem(
                created_at=message.created_at,
                user_id=u,
                discussion_id=message.discussion_id,
                kind="mentioned",
                message_id=message.id,
                by_user_id=message.author_id,
            )
        )
    await db.flush()


async def read_to(
    db: AsyncSession, d: Discussion, user_id: uuid.UUID, message: DiscussionMessage
) -> None:
    """Read up to ``message``: the invitation and every mention at or before it are done."""
    upto = select(DiscussionMessage.id).where(
        DiscussionMessage.discussion_id == d.id,
        DiscussionMessage.created_at <= message.created_at,
    )
    rows = await db.scalars(
        select(DiscussionInboxItem).where(
            DiscussionInboxItem.user_id == user_id,
            DiscussionInboxItem.discussion_id == d.id,
            DiscussionInboxItem.done_at.is_(None),
            or_(DiscussionInboxItem.kind == "invited", DiscussionInboxItem.message_id.in_(upto)),
        )
    )
    now = datetime.now(UTC)
    for row in rows:
        row.done_at = now
    await db.flush()


async def removed(db: AsyncSession, d: Discussion, user_id: uuid.UUID) -> None:
    """They left or were removed: their rows go at once, done ones too."""
    await db.execute(
        delete(DiscussionInboxItem).where(
            DiscussionInboxItem.user_id == user_id, DiscussionInboxItem.discussion_id == d.id
        )
    )


async def dismiss(db: AsyncSession, principal: "Principal", item_id: str) -> None:
    """The row's owner dismisses an Invited or Mentioned row (it goes to Done); 404 for
    anyone else and for a changes-proposed row (it goes when the changes are handled)."""
    prefix, _, raw = item_id.partition("_")
    try:
        row_id = uuid.UUID(raw)
    except ValueError:
        raise InboxItemNotFound from None
    row = await db.get(DiscussionInboxItem, row_id)
    if (
        row is None
        or principal.user_id is None
        or row.user_id != principal.user_id
        or PREFIX.get(row.kind) != f"{prefix}_"
    ):
        raise InboxItemNotFound
    if row.done_at is None:
        now = datetime.now(UTC)
        row.done_at = row.dismissed_at = now
    await db.flush()


# --- reading ------------------------------------------------------------------------------


def with_discussion(url: str, discussion_id: uuid.UUID) -> str:
    """The subject's link opened on the thread: ``?discussion=<id>`` before any #anchor."""
    path, hash_, anchor = url.partition("#")
    sep = "&" if "?" in path else "?"
    return f"{path}{sep}discussion={discussion_id}{hash_}{anchor}"


async def rows(
    db: AsyncSession, principal: "Principal", seen: datetime | None
) -> list[InboxDiscussionItem]:
    """My discussion rows, newest first: invited and mentioned (live, and done in the last
    30 days, at most 100), and the derived changes-proposed rows."""
    from oracle.discussions.service import Labels, _participants, _seat, users_by_id

    me = principal.user_id if principal.kind == "user" else None
    if me is None:
        return []
    since = datetime.now(UTC) - timedelta(days=DONE_DAYS)
    live = list(
        await db.scalars(
            select(DiscussionInboxItem)
            .where(DiscussionInboxItem.user_id == me, DiscussionInboxItem.done_at.is_(None))
            .order_by(DiscussionInboxItem.created_at.desc())
        )
    )
    done = list(
        await db.scalars(
            select(DiscussionInboxItem)
            .where(DiscussionInboxItem.user_id == me, DiscussionInboxItem.done_at >= since)
            .order_by(DiscussionInboxItem.done_at.desc())
            .limit(SETTLED_LIMIT)
        )
    )
    pending: dict[uuid.UUID, dict[str, int]] = {}
    pending_at: dict[uuid.UUID, datetime] = {}
    if has_role(principal.role, "approver"):
        for did, status, n, at in await db.execute(
            select(
                DiscussionChange.discussion_id,
                DiscussionChange.status,
                func.count(),
                func.max(func.coalesce(DiscussionChange.suggested_at, DiscussionChange.created_at)),
            )
            .where(DiscussionChange.status.in_(("proposed", "suggested")))
            .group_by(DiscussionChange.discussion_id, DiscussionChange.status)
        ):
            pending.setdefault(did, {})[status] = n
            pending_at[did] = max(at, pending_at.get(did, at))
    ids = {r.discussion_id for r in [*live, *done]} | set(pending)
    if not ids:
        return []
    labels = Labels(db)
    seen_ok: dict[uuid.UUID, tuple] = {}
    for d in await db.scalars(select(Discussion).where(Discussion.id.in_(ids))):
        parts = await _participants(db, d)
        seat = await _seat(db, principal, d, parts)
        if seat.author_only and not seat.participant:
            continue
        if not access.can_read(seat) or not await access.can_read_subject(db, principal, d):
            continue
        seen_ok[d.id] = (d, parts, seat)
    people_ids = {
        u for _d, parts, _s in seen_ok.values() for u, p in parts.items() if p.left_at is None
    }
    people_ids |= {r.by_user_id for r in [*live, *done] if r.by_user_id}
    users = await users_by_id(db, people_ids)

    def name(u: uuid.UUID | None) -> str | None:
        user = users.get(u) if u else None
        return display_name(user.email) if user else None

    messages = {
        m.id: m
        for m in await db.scalars(
            select(DiscussionMessage).where(
                DiscussionMessage.id.in_({r.message_id for r in [*live, *done] if r.message_id})
            )
        )
    }

    async def base(d: Discussion, parts: dict[uuid.UUID, DiscussionParticipant]) -> dict:
        label, url = await labels.of(d)
        active = [u for u, p in parts.items() if p.left_at is None]
        names = [n for n in (name(u) for u in active) if n]
        return {
            "discussion_id": d.id,
            "title": d.title,
            "visibility": d.visibility,
            "subject_label": label,
            "subject_url": with_discussion(url, d.id),
            "people": names[:PEOPLE_SHOWN],
            "people_more": max(len(names) - PEOPLE_SHOWN, 0),
            "can_write": has_role(principal.role, "commenter"),
        }

    def fresh(at: datetime) -> str:
        return "new" if seen is None or at > seen else "open"

    out: list[InboxDiscussionItem] = []
    listed: set[uuid.UUID] = set()
    for r in [*live, *done]:
        if r.id in listed or r.discussion_id not in seen_ok:
            continue
        listed.add(r.id)
        d, parts, _seat_ = seen_ok[r.discussion_id]
        msg = messages.get(r.message_id) if r.message_id else None
        by = name(r.by_user_id)
        out.append(
            InboxDiscussionItem(
                **await base(d, parts),
                id=f"{PREFIX[r.kind]}{r.id}",
                kind=r.kind,  # type: ignore[arg-type]
                by=InboxDiscussionPerson(user_id=r.by_user_id, name=by)
                if r.by_user_id and by
                else None,
                excerpt=msg.body[:EXCERPT] if msg is not None else None,
                at=r.created_at,
                state="done" if r.done_at else fresh(r.created_at),  # type: ignore[arg-type]
            )
        )
    for did, counts in pending.items():
        if did not in seen_ok:
            continue
        d, parts, seat = seen_ok[did]
        if seat.participant:
            n = counts.get("proposed", 0) + counts.get("suggested", 0)
        elif d.visibility == "open":
            n = counts.get("suggested", 0)
        else:
            n = 0
        if n == 0:
            continue
        out.append(
            InboxDiscussionItem(
                **await base(d, parts),
                id=f"{CHANGES_ID}{d.id}",
                kind="changes_proposed",
                count=n,
                at=pending_at[did],
                state=fresh(pending_at[did]),  # type: ignore[arg-type]
            )
        )
    out.sort(key=lambda i: (i.at, i.id), reverse=True)
    return out
