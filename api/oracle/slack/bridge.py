"""Mirroring a discussion to a Slack thread (G8 §3.1): link and unlink, the lines Oracle
posts, and the outbox items that carry them.

Only an open discussion mirrors, to one thread at most, through Oracle's Slack app (F6's
company install with :data:`oracle.integrations.slack_oauth.MIRROR_SCOPES`). Earlier
messages are never copied: the root carries the title, the subject, the link and the
summary (or the first message, cut to 280 characters); the tick then queues every new
message (:func:`queue_new`) and delivers the outbox (oracle.slack.outbox).
"""

import re
import uuid
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any, Literal

from sqlalchemy import exists, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.authz import has_role, recheck_caller
from oracle.discussions import service
from oracle.discussions.models import Discussion, DiscussionMessage
from oracle.discussions.schemas import DiscussionSlackOut
from oracle.export.render import app_url
from oracle.integrations import slack_api, slack_oauth
from oracle.integrations.models import CompanyIntegration
from oracle.members.names import display_name
from oracle.slack.models import DiscussionSlackLink, SlackOutbox

if TYPE_CHECKING:
    from oracle.auth.deps import Principal

PRIVATE_STAYS = "Private discussions stay in Oracle"
NOT_CONNECTED = "An owner connects Oracle to Slack in Settings"
RECONNECT = "Reconnect Slack to allow mirroring discussions"
WHO_MIRRORS = "Only the starter or an approver can mirror this discussion"
NOT_MIRRORED = "This discussion is not mirrored to Slack"
NO_CHANNEL = "Oracle's Slack app is not in that channel"
CLOSING = "This discussion is no longer mirrored."
CONTINUE = "Continue in Oracle: {url}"
FIRST_MESSAGE_CHARS = 280
# Slack's limit for one message's text, as Oracle splits it.
SLACK_TEXT_CHARS = 3000
# After this many failures in a row, the starter sees "Slack mirror failing: <error>".
FAILING_AFTER = 3
_SLACK_CONTROL = re.compile(r"[<>&]")


def escape(text: str) -> str:
    """Slack's mrkdwn control characters, so text never becomes a link or a mention."""
    return _SLACK_CONTROL.sub(lambda m: {"<": "&lt;", ">": "&gt;", "&": "&amp;"}[m.group()], text)


def split(text: str, limit: int = SLACK_TEXT_CHARS) -> list[str]:
    """Text over Slack's limit as several posts, cut at a line break or a space if one is
    near the end of each part."""
    parts: list[str] = []
    rest = text
    while len(rest) > limit:
        cut = max(rest.rfind("\n", 0, limit), rest.rfind(" ", 0, limit))
        if cut < limit // 2:
            cut = limit
        parts.append(rest[:cut].rstrip())
        rest = rest[cut:].lstrip()
    if rest or not parts:
        parts.append(rest)
    return parts


def thread_url(link: DiscussionSlackLink) -> str | None:
    if not link.thread_ts:
        return None
    return f"https://slack.com/archives/{link.channel_id}/p{link.thread_ts.replace('.', '')}"


def discussion_url(subject_url: str, d: Discussion) -> str:
    path, hash_, fragment = subject_url.partition("#")
    sep = "&" if "?" in path else "?"
    return app_url(f"{path}{sep}discussion={d.id}{hash_}{fragment}")


async def live_link(
    db: AsyncSession, discussion_id: uuid.UUID, *, lock: bool = False
) -> DiscussionSlackLink | None:
    stmt = select(DiscussionSlackLink).where(
        DiscussionSlackLink.discussion_id == discussion_id,
        DiscussionSlackLink.unlinked_at.is_(None),
    )
    if lock:
        stmt = stmt.with_for_update()
    return await db.scalar(stmt)


async def slack_out(
    db: AsyncSession, link: DiscussionSlackLink | None
) -> DiscussionSlackOut | None:
    if link is None:
        return None
    if link.failed_at is not None:
        # Slack gave up on the root message: no thread, and Slack's reason.
        return DiscussionSlackOut(
            channel_name=link.channel_name, thread_url=None, status="failed", error=link.error
        )
    failing = await db.scalar(
        select(SlackOutbox)
        .where(
            SlackOutbox.link_id == link.id,
            SlackOutbox.attempts >= FAILING_AFTER,
            SlackOutbox.status.in_(("queued", "failed")),
        )
        .order_by(SlackOutbox.created_at.desc())
        .limit(1)
    )
    status: Literal["posting", "live", "failing"] = "live" if link.thread_ts else "posting"
    if failing is not None:
        status = "failing"
    return DiscussionSlackOut(
        channel_name=link.channel_name,
        thread_url=thread_url(link),
        status=status,
        error=failing.error if failing is not None else None,
    )


def queue(
    db: AsyncSession,
    link: DiscussionSlackLink,
    op: str,
    payload: dict[str, Any],
    message_id: uuid.UUID | None = None,
) -> SlackOutbox:
    item = SlackOutbox(link_id=link.id, op=op, payload=payload, message_id=message_id)
    db.add(item)
    return item


async def _channel(db: AsyncSession, row: CompanyIntegration, channel_id: str) -> dict[str, Any]:
    try:
        async with slack_api.http_client() as http:
            found = await slack_oauth.channels(http, row)
    except slack_api.SlackError as e:
        raise service.DiscussionError(502, f"Slack answered {e.code}") from None
    for ch in found:
        if ch["id"] == channel_id:
            return ch
    raise service.DiscussionError(422, NO_CHANNEL)


async def _root_text(db: AsyncSession, d: Discussion) -> str:
    label, url = await service.Labels(db).of(d)
    lines = [f"*{escape(d.title)}*", escape(label), f"<{discussion_url(url, d)}|Open in Oracle>"]
    if d.summary:
        lines.append(escape(d.summary))
    else:
        first = await db.scalar(
            select(DiscussionMessage)
            .where(
                DiscussionMessage.discussion_id == d.id,
                DiscussionMessage.author_kind == "person",
                DiscussionMessage.deleted_at.is_(None),
            )
            .order_by(DiscussionMessage.created_at, DiscussionMessage.id)
            .limit(1)
        )
        if first is not None and first.body:
            lines.append(escape(first.body[:FIRST_MESSAGE_CHARS]))
    return "\n".join(lines)


async def mirror(
    db: AsyncSession, principal: "Principal", discussion_id: uuid.UUID, channel_id: str
) -> DiscussionSlackLink:
    """Link the discussion to a new thread in ``channel_id`` and queue its root message."""
    await recheck_caller(db, principal, "commenter")
    d, _parts, seat = await service.readable(db, principal, discussion_id, lock=True)
    if not (seat.starter or has_role(seat.role, "approver")) or principal.user_id is None:
        raise service.DiscussionError(403, WHO_MIRRORS)
    if d.origin == "panel":
        # G7: a panel chat is only its starter and Oracle; Share as discussion opens it.
        raise service.DiscussionError(422, service.PANEL_CHAT)
    if d.visibility != "open":
        raise service.DiscussionError(422, PRIVATE_STAYS)
    if d.status == "closed":
        raise service.DiscussionError(409, service.CLOSED)
    existing = await live_link(db, d.id)
    if existing is not None:
        raise service.DiscussionError(409, f"Already mirrored to #{existing.channel_name}")
    row = await slack_oauth.installed(db)
    if row is None or row.status != "active":
        raise service.DiscussionError(409, NOT_CONNECTED)
    if not slack_oauth.can_mirror(row):
        raise service.DiscussionError(409, RECONNECT)
    channel = await _channel(db, row, channel_id)
    link = DiscussionSlackLink(
        discussion_id=d.id,
        channel_id=channel["id"],
        channel_name=channel["name"],
        linked_by=principal.user_id,
    )
    db.add(link)
    await db.flush()
    queue(db, link, "root", {"text": await _root_text(db, d)})
    await audit.record(
        db, principal, "discussion.slack_mirror", service.ENTITY, d.id,
        {"channel_id": link.channel_id, "channel": link.channel_name},
    )  # fmt: skip
    await db.flush()
    return link


async def _close(
    db: AsyncSession,
    principal: "Principal | None",
    link: DiscussionSlackLink,
    *,
    with_link: bool,
) -> SlackOutbox | None:
    """Unlink, with a closing line in the thread; a failed mirror, or one whose root is not
    posted yet, has no thread, so none (and its root is never posted)."""
    if link.failed_at is not None or not link.thread_ts:
        link.unlinked_at = datetime.now(UTC)
        link.unlinked_by = principal.user_id if principal is not None else None
        for pending in await db.scalars(
            select(SlackOutbox).where(
                SlackOutbox.link_id == link.id, SlackOutbox.status == "queued"
            )
        ):
            pending.status = "dropped"
        await db.flush()
        return None
    text = CLOSING
    if with_link:
        d = await db.get(Discussion, link.discussion_id)
        if d is not None:
            _label, url = await service.Labels(db).of(d)
            text = f"{CLOSING} {CONTINUE.format(url=discussion_url(url, d))}"
    item = queue(db, link, "close", {"text": text})
    link.unlinked_at = datetime.now(UTC)
    link.unlinked_by = principal.user_id if principal is not None else None
    # What was queued for the thread and not sent yet stays out of Slack.
    for pending in await db.scalars(
        select(SlackOutbox).where(
            SlackOutbox.link_id == link.id,
            SlackOutbox.status == "queued",
            SlackOutbox.op != "close",
        )
    ):
        pending.status = "dropped"
    await db.flush()
    return item


async def unmirror(db: AsyncSession, principal: "Principal", discussion_id: uuid.UUID) -> None:
    """Stop mirroring: the closing line with the link to Oracle, then unlink."""
    await recheck_caller(db, principal, "commenter")
    d, _parts, seat = await service.readable(db, principal, discussion_id, lock=True)
    if not (seat.starter or has_role(seat.role, "approver")):
        raise service.DiscussionError(403, WHO_MIRRORS)
    link = await live_link(db, d.id, lock=True)
    if link is None:
        raise service.DiscussionError(404, NOT_MIRRORED)
    await _close(db, principal, link, with_link=True)
    await audit.record(
        db, principal, "discussion.slack_unmirror", service.ENTITY, d.id,
        {"channel_id": link.channel_id},
    )  # fmt: skip


async def made_private(db: AsyncSession, principal: "Principal", d: Discussion) -> None:
    """A mirrored discussion made private: the closing line without the link (the title
    stays out of the channel), then unlink. What was posted stays in Slack."""
    link = await live_link(db, d.id, lock=True)
    if link is not None:
        await _close(db, principal, link, with_link=False)
        await audit.record(
            db, principal, "discussion.slack_unmirror", service.ENTITY, d.id,
            {"channel_id": link.channel_id, "reason": "private"},
        )  # fmt: skip


async def close_all(db: AsyncSession, principal: "Principal") -> list[SlackOutbox]:
    """Disconnect: a closing line for every live link, each unlinked."""
    links = list(
        await db.scalars(
            select(DiscussionSlackLink)
            .where(DiscussionSlackLink.unlinked_at.is_(None))
            .with_for_update()
        )
    )
    closes = [await _close(db, principal, link, with_link=True) for link in links]
    return [c for c in closes if c is not None]


# --- what the tick queues --------------------------------------------------------------------


def _citations(citations: list[dict[str, Any]]) -> str:
    """Titles only, as links to Oracle; never an excerpt."""
    out = []
    for c in citations:
        title = escape(str(c.get("title") or "Source"))
        url = c.get("url")
        out.append(f"<{app_url(url)}|{title}>" if isinstance(url, str) and url else title)
    return " · ".join(out)


def line_of(m: DiscussionMessage, name: str | None) -> str:
    if m.author_kind == "oracle":
        text = f"*Oracle*: {escape(m.body)}"
        if m.citations:
            text += f"\n{_citations(m.citations)}"
        return text
    if m.author_kind == "system":
        return escape(m.body)
    return f"*{escape(name or 'Someone')}* in Oracle: {escape(m.body)}"


async def queue_new(db: AsyncSession) -> int:
    """Queue a ``post`` for every message written since its discussion was mirrored and not
    queued yet: people's (not the ones that came from Slack), Oracle's once complete, and
    system lines. Returns how many were queued."""
    links = list(
        await db.scalars(
            select(DiscussionSlackLink).where(
                DiscussionSlackLink.unlinked_at.is_(None),
                # A failed mirror takes nothing more.
                DiscussionSlackLink.failed_at.is_(None),
            )
        )
    )
    queued = 0
    for link in links:
        rows = list(
            await db.scalars(
                select(DiscussionMessage)
                .where(
                    DiscussionMessage.discussion_id == link.discussion_id,
                    DiscussionMessage.created_at > link.created_at,
                    DiscussionMessage.status == "complete",
                    DiscussionMessage.deleted_at.is_(None),
                    ~(
                        (DiscussionMessage.author_kind == "person")
                        & (DiscussionMessage.via == "slack")
                    ),
                    ~exists().where(
                        SlackOutbox.link_id == link.id,
                        SlackOutbox.message_id == DiscussionMessage.id,
                    ),
                )
                .order_by(DiscussionMessage.created_at, DiscussionMessage.id)
            )
        )
        if not rows:
            continue
        users = await service.users_by_id(db, {m.author_id for m in rows if m.author_id})
        for m in rows:
            author = users.get(m.author_id) if m.author_id else None
            name = display_name(author.email) if author is not None else None
            queue(db, link, "post", {"text": line_of(m, name)}, message_id=m.id)
            queued += 1
    await db.flush()
    return queued
