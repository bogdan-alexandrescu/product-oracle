"""Posting the alignment report to the company's Slack channel (F6 §4).

The message is Slack mrkdwn: the title, the summary line, at most five track lines, then
a link to the report in Oracle. Item titles come from roadmap items (company data, posted
into the company's own Slack, as O4 decided); no source excerpts, no evidence text.

Posted right after the build. A failure is retried with backoff (1, 5, 15, 60 minutes,
then hourly) for 24 hours from the build; Slack's ``ratelimited`` waits for its
``Retry-After``. After 24 hours the report is ``failed`` and owners' Inbox shows "Report
not posted to Slack" with Retry and Dismiss. Calls go through oracle.integrations.slack_api
(slack.com only, through ``guarded_transport``).
"""

import logging
import uuid
from datetime import date, datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.config import get_settings
from oracle.integrations import slack_api, slack_oauth
from oracle.reports import clock
from oracle.reports.alignment import HEALTH_LABEL, short_day, title
from oracle.reports.models import AlignmentReport

log = logging.getLogger(__name__)

MAX_ITEM_LINES = 5
BACKOFF_MINUTES = (1, 5, 15, 60)
RETRY_WINDOW = timedelta(hours=24)
# Posts the ticker makes per company per tick.
MAX_POSTS_PER_TICK = 5


def _escape(text: str | None) -> str:
    """Slack's three control characters, and no line breaks inside a line."""
    flat = " ".join((text or "").split())
    return flat.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def report_url(report_id: uuid.UUID | str) -> str:
    from oracle.swarm.settings import get_runtime_settings

    base = (get_settings().app_url or get_runtime_settings().public_url).rstrip("/")
    return f"{base}/plan/reports/{report_id}"


def _track_line(t: dict[str, Any]) -> str:
    health = HEALTH_LABEL.get(t["health"], t["health"])
    head = f"• {_escape(t['prd']['title'])} · {health}"
    if t.get("needs_attention"):
        return f"{head} · {_escape(t['needs_attention'][0]['detail'])}"
    nxt = t.get("next_milestone")
    if nxt:
        if nxt.get("date"):
            mark = " ✓" if nxt.get("verified") else ""
            day = short_day(date.fromisoformat(nxt["date"]))
            return f"{head} · next: {_escape(nxt['name'])}, {day}{mark}"
        return f"{head} · next: {_escape(nxt['name'])}"
    return head


def message(content: dict[str, Any], report_id: uuid.UUID | str) -> str:
    s = content["summary"]
    risky = s["at_risk"] + s["off_track"]
    n_tracks = s["tracks"]
    slips, untracked = s["slips"], s["untracked_now"]
    summary = (
        f"{risky} of {n_tracks} {'track' if n_tracks == 1 else 'tracks'} at risk · "
        f"{slips} {'date' if slips == 1 else 'dates'} slipping · "
        f"{untracked} Now {'item' if untracked == 1 else 'items'} without an issue"
    )
    tracks = content["tracks"]
    lines = [f"*{title(content['kind'], content['week_start'])}*", summary]
    lines += [_track_line(t) for t in tracks[:MAX_ITEM_LINES]]
    if len(tracks) > MAX_ITEM_LINES:
        lines.append(f"+{len(tracks) - MAX_ITEM_LINES} more in Oracle")
    lines.append(f"<{report_url(report_id)}|Open the report in Oracle>")
    return "\n".join(lines)


def _backoff(attempts: int) -> timedelta:
    """The wait after the ``attempts``-th failed attempt."""
    if attempts <= len(BACKOFF_MINUTES):
        return timedelta(minutes=BACKOFF_MINUTES[attempts - 1])
    return timedelta(hours=1)


async def deliver(db: AsyncSession, report: AlignmentReport, *, actor: Any = None) -> None:
    """One attempt to post ``report`` (the caller commits). Without the install, the report
    is ``not_configured``; a failure is ``pending`` with its next attempt, or ``failed``
    once the 24 hours since the build have passed."""
    now = clock.now()
    install = await slack_oauth.installed(db)
    if install is None or install.status != "active" or not report.slack_channel_id:
        report.slack_status = "not_configured"
        report.slack_next_attempt_at = None
        return
    report.slack_attempts += 1
    try:
        async with slack_api.http_client() as http:
            ts = await slack_oauth.post(
                http, install, report.slack_channel_id, message(report.content, report.id)
            )
    except slack_api.SlackError as e:
        report.slack_error = e.code
        if now >= report.created_at + RETRY_WINDOW:
            report.slack_status = "failed"
            report.slack_next_attempt_at = None
            await audit.record(
                db,
                actor,
                "alignment_report.post_failed",
                "alignment_report",
                report.id,
                {"channel_id": report.slack_channel_id, "error": e.code,
                 "attempts": report.slack_attempts},
            )  # fmt: skip
        else:
            wait = (
                timedelta(seconds=e.retry_after)
                if e.retry_after is not None
                else _backoff(report.slack_attempts)
            )
            if report.slack_status != "failed":
                report.slack_status = "pending"
                report.slack_next_attempt_at = now + wait
        log.info("alignment report %s not posted to Slack: %s", report.id, e.code)
        return
    report.slack_status = "posted"
    report.slack_ts = ts
    report.slack_error = None
    report.slack_posted_at = now
    report.slack_next_attempt_at = None
    report.slack_dismissed_at = None
    await audit.record(
        db,
        actor,
        "alignment_report.posted",
        "alignment_report",
        report.id,
        {"channel_id": report.slack_channel_id, "ts": ts, "attempts": report.slack_attempts},
    )


async def deliver_due(db: AsyncSession) -> int:
    """The posts whose next attempt is due, oldest first; returns the attempts made."""
    now: datetime = clock.now()
    rows = list(
        await db.scalars(
            select(AlignmentReport)
            .where(
                AlignmentReport.slack_status == "pending",
                AlignmentReport.slack_next_attempt_at <= now,
            )
            .order_by(AlignmentReport.slack_next_attempt_at)
            .limit(MAX_POSTS_PER_TICK)
            .with_for_update(skip_locked=True)
        )
    )
    for report in rows:
        await deliver(db, report)
    if rows:
        await db.flush()
    return len(rows)
