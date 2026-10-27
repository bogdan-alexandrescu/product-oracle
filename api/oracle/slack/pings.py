"""Slack pings (C1 feedback channels; G8 §4: "draft-ready pings… can use this outbox later").

A ping is one Slack message to one member, queued in G8's outbox (``op = 'ping'``) and
delivered by the minute tick with the outbox's retries. The events, and who gets them:

- ``draft_ready``: a new draft of a document is ready for review, to its reviewers (the
  section owners and reviewers, the decider and the mandatory reviewers);
- ``review_requested``: a review or a decision is requested of the person (a section to
  review, a re-review, a proposed change to an approved section, a decision to make, a
  question asked of them);
- ``comments``, ``feedback_wanted``, ``published``: the member's own notifications
  (comments and replies on what they review, a call for feedback, a publication).

Each member chooses (My account, their ``slack_pings`` preference): ``review_requested``
and ``draft_ready`` are on by default, the rest off (:data:`DEFAULTS`; the owner's call).
The choice is read when a ping is queued and again when it goes, so a ping turned off
meanwhile is dropped (``turned_off``). Nothing is queued while the company's Slack
(Settings › Notifications) is not connected, and a ping not sent within a day (Slack
disconnected, then reconnected) is never sent late (oracle.slack.outbox, ``expired``).

Where it goes: a DM when Slack knows the member's e-mail (``users.lookupByEmail``, the
install's ``users:read.email``); otherwise the Notifications channel (the alignment
report's channel, Settings › Notifications), naming the member. A channel post carries an
item's title only for a document every member may read: an approvers-only document's
title, a decision's and a question's never go to a channel members read. Without the
member in Slack and without a channel, the ping is dropped (``users_not_found``).
"""

import uuid
from collections.abc import Iterable
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.auth.models import User
from oracle.docs import visibility
from oracle.docs.models import Document
from oracle.export.render import app_url
from oracle.integrations import slack_api, slack_oauth
from oracle.members.names import display_name
from oracle.preferences.models import UserPreference
from oracle.slack.models import SlackOutbox

PREFERENCE = "slack_pings"
EVENTS = ("draft_ready", "review_requested", "comments", "feedback_wanted", "published")
DEFAULTS: dict[str, bool] = {
    "draft_ready": True,
    "review_requested": True,
    "comments": False,
    "feedback_wanted": False,
    "published": False,
}
# In-app notification kinds (oracle.review.collab.notify) and the ping each one is.
KIND_EVENT = {
    "assignment": "review_requested",
    "rereview_requested": "review_requested",
    "patch_proposed": "review_requested",
    "review_reminder": "review_requested",
    "comment": "comments",
    "reply": "comments",
    "campaign": "feedback_wanted",
    "published": "published",
}
# What a channel post says instead of a title it may not carry.
UNTITLED = {
    "draft_ready": "a draft is ready for your review",
    "review_requested": "your review is requested",
    "comments": "there is a new comment for you",
    "feedback_wanted": "your feedback is wanted",
    "published": "a document you follow was published",
}
NOT_IN_SLACK = "users_not_found"
TURNED_OFF = "turned_off"


class Undeliverable(Exception):
    """The ping has nowhere to go; it is dropped with ``reason``."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


# Slack mrkdwn has no escape for its formatting characters (as oracle.reports.slack).
_NEUTRAL = str.maketrans({"*": "＊", "_": "＿", "~": "～", "`": "｀"})


def _escape(text: str) -> str:
    flat = " ".join(text.split()).translate(_NEUTRAL)
    return flat.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def chosen_of(value: Any) -> dict[str, bool]:
    """A stored preference over the defaults (unknown keys ignored)."""
    stored = value if isinstance(value, dict) else {}
    return {e: bool(stored.get(e, d)) for e, d in DEFAULTS.items()}


async def _chosen(db: AsyncSession, ids: list[uuid.UUID]) -> dict[uuid.UUID, dict[str, bool]]:
    rows = await db.execute(
        select(UserPreference.principal_id, UserPreference.value).where(
            UserPreference.principal_id.in_(ids), UserPreference.key == PREFERENCE
        )
    )
    stored = dict(rows.all())
    return {i: chosen_of(stored.get(i)) for i in ids}


async def _readable_by_all(db: AsyncSession, document_id: uuid.UUID | None) -> bool:
    if document_id is None:
        return False
    seen = await db.scalar(
        select(Document.visibility)
        .where(Document.id == document_id)
        .execution_options(oracle_all_documents=True)
    )
    return seen == visibility.COMPANY


async def queue(
    db: AsyncSession,
    event: str,
    recipients: Iterable[uuid.UUID | None],
    *,
    title: str,
    path: str,
    document_id: uuid.UUID | None = None,
    actor_id: uuid.UUID | None = None,
) -> int:
    """One ping per active member in ``recipients`` who chose ``event`` (never whoever
    caused it), while the company's Slack is connected. Returns how many were queued."""
    assert event in DEFAULTS, event
    ids = [r for r in dict.fromkeys(recipients) if r is not None and r != actor_id]
    if not ids:
        return 0
    install = await slack_oauth.installed(db)
    if install is None or install.status != "active":
        return 0
    stmt = select(User).where(User.id.in_(ids), User.disabled_at.is_(None))
    public = await _readable_by_all(db, document_id)
    if document_id is not None and not public:
        # H8: nobody hears about a document they may not see.
        stmt = stmt.where(User.role.in_(("approver", "owner")))
    users = list(await db.scalars(stmt))
    chosen = await _chosen(db, [u.id for u in users])
    link = f"<{app_url(path)}|Open in Oracle>"
    queued = 0
    for user in users:
        if not chosen[user.id][event]:
            continue
        said = _escape(title) if public else UNTITLED[event]
        name = _escape(display_name(user.email, user.name))
        db.add(
            SlackOutbox(
                op="ping",
                link_id=None,
                recipient_id=user.id,
                payload={
                    "event": event,
                    "text": f"{_escape(title)}\n{link}",
                    "channel_text": f"For {name}: {said}\n{link}",
                },
            )
        )
        queued += 1
    if queued:
        await db.flush()
    return queued


async def draft_ready(
    db: AsyncSession, document: Document, number: int, actor_id: uuid.UUID | None
) -> int:
    """A new draft of ``document``: its reviewers who chose ``draft_ready``."""
    from oracle.review.models import SectionReviewState
    from oracle.review.state import effective_policy

    rows = await db.execute(
        select(SectionReviewState.owner_id, SectionReviewState.reviewer_ids).where(
            SectionReviewState.document_id == document.id
        )
    )
    people: list[uuid.UUID | None] = []
    for owner_id, reviewer_ids in rows.all():
        people += [owner_id, *(reviewer_ids or [])]
    policy = await effective_policy(db, document)
    people += [policy.decider_id, *policy.mandatory_reviewer_ids]
    return await queue(
        db,
        "draft_ready",
        people,
        title=f"Draft {number} of {document.title} is ready for your review",
        path=f"/documents/{document.id}/v/{number}",
        document_id=document.id,
        actor_id=actor_id,
    )


async def notification(
    db: AsyncSession,
    kind: str,
    recipients: Iterable[uuid.UUID],
    *,
    title: str,
    actor: str,
    document_id: uuid.UUID | None,
    version_number: int | None,
    section_key: str | None,
) -> int:
    """The ping of an in-app notification (oracle.review.collab.notify), if it has one."""
    event = KIND_EVENT.get(kind)
    if event is None:
        return 0
    path = "/inbox"
    if document_id is not None:
        path = f"/documents/{document_id}"
        if version_number is not None:
            path += f"/v/{version_number}"
            if section_key:
                path += f"#s-{section_key}"
    actor_id = None
    if actor.startswith("user:"):
        try:
            actor_id = uuid.UUID(actor.removeprefix("user:"))
        except ValueError:
            actor_id = None
    return await queue(
        db, event, recipients, title=title, path=path, document_id=document_id, actor_id=actor_id
    )


async def _notify_channel(db: AsyncSession) -> str | None:
    from oracle.reports.alignment import validate_setting
    from oracle.tenant_settings_api import get_setting

    channel = validate_setting(await get_setting(db, "alignment_report")).get("slack_channel")
    return channel["id"] if channel else None


async def send(db: AsyncSession, http: httpx.AsyncClient, token: str, item: SlackOutbox) -> str:
    """Post one ping: a DM to the member, else the Notifications channel naming them.
    Returns Slack's ts; :class:`Undeliverable` when it has nowhere to go."""
    user = await db.get(User, item.recipient_id) if item.recipient_id else None
    if user is None or user.disabled_at is not None:
        raise Undeliverable("member_removed")
    event = str(item.payload.get("event") or "")
    if event in DEFAULTS and not (await _chosen(db, [user.id]))[user.id][event]:
        raise Undeliverable(TURNED_OFF)
    try:
        found = await slack_api.call(
            http, "users.lookupByEmail", token=token, data={"email": user.email}
        )
        slack_id = (found.get("user") or {}).get("id")
        if not slack_id:
            raise slack_api.SlackError(NOT_IN_SLACK)
        channel, text = str(slack_id), str(item.payload["text"])
    except slack_api.SlackError as e:
        if e.code != NOT_IN_SLACK:
            raise
        fallback = await _notify_channel(db)
        if fallback is None:
            raise Undeliverable(NOT_IN_SLACK) from None
        channel, text = fallback, str(item.payload["channel_text"])
    body = {"channel": channel, "text": text[:3000], "mrkdwn": True, "unfurl_links": False}
    got = await slack_api.call(http, "chat.postMessage", token=token, json=body)
    return str(got.get("ts") or "")
