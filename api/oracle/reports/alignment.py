"""The weekly alignment report (F6 §1, §2): what it says, and when it is made.

Built only from Oracle's data, deterministically (no model call): for every active or
paused product track, its overview (``views.overview``: health, headline, next milestone,
at-risk items, drift, ``prd_moved``), its roadmap's read-only alignment counts
(``views.alignment``, the same numbers as ``GET /v1/roadmaps/{doc}/alignment``), the health
the monitor recorded a week ago (``product_track`` change events), and the schedule bases
verified and withdrawn in the period (the ``schedule_basis.*`` audit events). The
alignment rules themselves are read only.

Until F2 Track health ships its alerts, "needs attention" lists the track's current
at-risk reasons and says "as of now" (``needs_attention_as_of_now``).

The schedule is the company setting ``alignment_report`` (Monday 08:00 by default) in
the Company time zone (``company_timezone``, America/Los_Angeles by default). Its clock is H2's: the
built-in ``alignment_report`` ritual (oracle.rituals) is seeded on this setting's day
and time in that zone, follows their changes, and at each weekly moment builds the
week that just ended (``oracle.rituals.blocks.alignment_report``); the same tick posts it to Slack
(oracle.reports.slack). The unique index on (company, week_start) for weekly reports
makes a second build impossible. A company with no active or paused track gets none.
"""

import logging
import re
import uuid
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.docs.models import Document
from oracle.models import AuditEvent
from oracle.reports import clock
from oracle.reports.models import AlignmentReport
from oracle.rituals.schedule import DEFAULT_ZONE
from oracle.roadmap import views
from oracle.roadmap.models import ProductTrack, ScheduleBasis
from oracle.v2.models import ChangeEvent

log = logging.getLogger(__name__)

SETTING_KEY = "alignment_report"
WEEKDAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
TIME = re.compile(r"([01]\d|2[0-3]):([0-5]\d)")
CHANNEL_ID = re.compile(r"[CG][A-Z0-9]{2,30}")
REPORTED_STATUSES = ("active", "paused")
# Worst first.
HEALTH_ORDER = {"off_track": 0, "at_risk": 1, "no_roadmap": 2, "on_track": 3, "paused": 4}
HEALTH_LABEL = {
    "on_track": "On track",
    "at_risk": "At risk",
    "off_track": "Off track",
    "no_roadmap": "No roadmap",
    "paused": "Paused",
    "closed": "Closed",
}
HORIZON_LABEL = {"now": "Now", "next": "Next", "later": "Later"}
DRIFT_KINDS = ("ahead", "unplanned")


class AlreadyBuilt(Exception):
    """This company's weekly report for that week exists."""


class NoTracks(Exception):
    """No active or paused track: nothing to report."""


# --- the setting -------------------------------------------------------------------------


@dataclass(frozen=True)
class ReportSettings:
    enabled: bool = True
    weekday: str = "mon"
    time: str = "08:00"
    # The Company time zone (Settings), read by load_settings; the setting has no zone.
    timezone: str = DEFAULT_ZONE
    slack_channel: dict[str, str] | None = field(default=None, hash=False)

    @property
    def zone(self) -> ZoneInfo:
        return ZoneInfo(self.timezone)


DEFAULT_SETTING: dict[str, Any] = {
    "enabled": True,
    "weekday": "mon",
    "time": "08:00",
    "slack_channel": None,
}


def validate_setting(value: Any) -> dict[str, Any]:
    """The stored value: ``value`` over the defaults, every key checked (ValueError)."""
    if not isinstance(value, dict):
        raise ValueError("alignment_report must be an object")
    if unknown := sorted(set(value) - set(DEFAULT_SETTING)):
        raise ValueError(
            f"alignment_report: unknown key {unknown[0]!r}; known: {', '.join(DEFAULT_SETTING)}"
        )
    out = {**DEFAULT_SETTING, **value}
    if not isinstance(out["enabled"], bool):
        raise ValueError("alignment_report.enabled must be true or false")
    if out["weekday"] not in WEEKDAYS:
        raise ValueError(f"alignment_report.weekday must be one of {', '.join(WEEKDAYS)}")
    if not isinstance(out["time"], str) or not TIME.fullmatch(out["time"]):
        raise ValueError("alignment_report.time must be HH:MM, 00:00 to 23:59")
    channel = out["slack_channel"]
    if channel is not None:
        if not isinstance(channel, dict) or not isinstance(channel.get("id"), str):
            raise ValueError("alignment_report.slack_channel must be {id, name} or null")
        if not CHANNEL_ID.fullmatch(channel["id"]):
            raise ValueError("alignment_report.slack_channel.id is not a Slack channel id")
        name = channel.get("name")
        if name is not None and not isinstance(name, str):
            raise ValueError("alignment_report.slack_channel.name must be text")
        name = (name or "").strip().lstrip("#")[:80] or channel["id"]
        out["slack_channel"] = {"id": channel["id"], "name": name}
    return out


async def load_settings(db: AsyncSession) -> ReportSettings:
    """The report's setting, in the Company time zone."""
    from oracle.tenant_settings_api import company_timezone, get_setting

    raw = await get_setting(db, SETTING_KEY)
    try:
        value = validate_setting(raw)
    except ValueError:
        log.warning("alignment_report setting is invalid; using the defaults")
        value = dict(DEFAULT_SETTING)
    return ReportSettings(**value, timezone=str(await company_timezone(db)))


# --- weeks -------------------------------------------------------------------------------


def week_start_of(moment: datetime, tz: str = "America/Los_Angeles") -> date:
    """The Monday of the local week ``moment`` falls in."""
    local = moment.astimezone(ZoneInfo(tz)).date()
    return local - timedelta(days=local.weekday())


def week_window(week_start: date, tz: str) -> tuple[datetime, datetime]:
    """Monday 00:00 to the next Monday 00:00 in ``tz``, in UTC."""
    zone = ZoneInfo(tz)
    start = datetime.combine(week_start, time(0), tzinfo=zone)
    end = datetime.combine(week_start + timedelta(days=7), time(0), tzinfo=zone)
    return start.astimezone(UTC), end.astimezone(UTC)


def scheduled_moment(week_start: date, settings: ReportSettings) -> datetime:
    """When the week starting ``week_start`` reports on the week before: its weekday and
    time in the company's zone, in UTC."""
    hours, minutes = (int(p) for p in settings.time.split(":"))
    day = week_start + timedelta(days=WEEKDAYS.index(settings.weekday))
    return datetime.combine(day, time(hours, minutes), tzinfo=settings.zone).astimezone(UTC)


def short_day(d: date) -> str:
    """ "Oct 19"."""
    return f"{d:%b} {d.day}"


# --- content -----------------------------------------------------------------------------


def _plural(n: int, one: str, many: str) -> str:
    return f"{n} {one if n == 1 else many}"


def headline(summary: dict[str, Any]) -> str:
    """ "1 of 3 tracks at risk; 2 dates slipping as of now; 4 Now items have no issue.\""""
    risky = summary.get("at_risk", 0) + summary.get("off_track", 0)
    tracks = summary.get("tracks", 0)
    slips = summary.get("slips", 0)
    untracked = summary.get("untracked_now", 0)
    return (
        f"{risky} of {_plural(tracks, 'track', 'tracks')} at risk; "
        f"{_plural(slips, 'date', 'dates')} slipping as of now; "
        f"{_plural(untracked, 'Now item has', 'Now items have')} no issue."
    )


def title(kind: str, week_start: date | str) -> str:
    day = date.fromisoformat(week_start) if isinstance(week_start, str) else week_start
    word = "Weekly alignment" if kind == "weekly" else "Alignment so far"
    return f"{word} · week of {short_day(day)}"


def plan_link(prd: str, item_key: str | None = None) -> str:
    """Where an item or a track opens in the Plan (F1)."""
    return f"/plan?item={prd}:{item_key}" if item_key else f"/plan?item={prd}"


async def _health_before(
    db: AsyncSession, track: ProductTrack, start: datetime, now_health: str
) -> str:
    """The health the monitor recorded at the period's start: the last change before it,
    else what the first change in the period moved from (or to, for a track first
    monitored this week), else the health now."""
    events = ChangeEvent.subject_kind == "product_track", ChangeEvent.subject_id == track.id
    last = await db.scalar(
        select(ChangeEvent)
        .where(*events, ChangeEvent.created_at < start)
        .order_by(ChangeEvent.created_at.desc())
        .limit(1)
    )
    if last is not None and (h := ((last.data or {}).get("after") or {}).get("health")):
        return h
    first = await db.scalar(
        select(ChangeEvent)
        .where(*events, ChangeEvent.created_at >= start)
        .order_by(ChangeEvent.created_at)
        .limit(1)
    )
    if first is not None:
        data = first.data or {}
        if h := (data.get("before") or {}).get("health"):
            return h
        if h := (data.get("after") or {}).get("health"):
            return h
    return now_health


async def _dates(
    db: AsyncSession, prd_ids: set[uuid.UUID], start: datetime, end: datetime
) -> dict[uuid.UUID, dict[str, list[dict[str, Any]]]]:
    """Per PRD: the bases verified and withdrawn in the period (the audit events), each
    withdrawal with its reason."""
    out: dict[uuid.UUID, dict[str, list[dict[str, Any]]]] = {
        p: {"verified": [], "withdrawn": []} for p in prd_ids
    }
    events = list(
        await db.scalars(
            select(AuditEvent)
            .where(
                AuditEvent.action.in_(("schedule_basis.verified", "schedule_basis.withdrawn")),
                AuditEvent.created_at >= start,
                AuditEvent.created_at < end,
            )
            .order_by(AuditEvent.created_at, AuditEvent.id)
        )
    )
    ids = {e.entity_id for e in events if e.entity_id}
    bases = (
        {b.id: b for b in await db.scalars(select(ScheduleBasis).where(ScheduleBasis.id.in_(ids)))}
        if ids
        else {}
    )
    for e in events:
        b = bases.get(e.entity_id) if e.entity_id else None
        if b is None or b.prd_document_id not in out:
            continue
        data = e.data or {}
        entry = {"reference": b.reference, "supports_date": b.supports_date.isoformat()}
        if e.action == "schedule_basis.verified":
            out[b.prd_document_id]["verified"].append(entry)
        else:
            entry["reason"] = data.get("reason") or None
            out[b.prd_document_id]["withdrawn"].append(entry)
    return out


async def _track_content(
    db: AsyncSession,
    track: ProductTrack,
    start: datetime,
    dates: dict[str, list[dict[str, Any]]],
) -> tuple[dict[str, Any], int]:
    """One track's part of the report, and its Now items without a tracker issue."""
    o = await views.overview(db, track)
    prd = await db.get(Document, track.prd_document_id)
    slug = prd.slug if prd else str(track.prd_document_id)
    counts = {"aligned": 0, "drift": 0, "untracked": 0, "done": 0}
    untracked_now = 0
    # Every roadmap item's name as the Plan shows it (qa-plan-41), for drift on items that
    # are not at risk too.
    titles: dict[str, str] = {}
    if track.roadmap_document_id:
        roadmap = await db.get(Document, track.roadmap_document_id)
        if roadmap is not None:
            report = await views.alignment(db, roadmap, await views.items_version(db, roadmap))
            counts = {k: report.counts.get(k, 0) for k in counts}
            titles = {i.item_key: i.title for i in report.items}
            untracked_now = sum(
                1 for i in report.items if i.alignment == "untracked" and i.horizon == "now"
            )
    nxt = o.next_milestone
    needs = [
        {
            "item_key": item.item_key,
            "title": item.title,
            "horizon": item.horizon,
            "kind": reason.get("kind"),
            "detail": reason.get("detail"),
            "alert_id": None,
            "link": plan_link(slug, item.item_key),
        }
        for item in o.at_risk
        for reason in item.reasons
    ]
    titles |= {i.item_key: i.title for i in o.at_risk}
    drift = [
        {
            "kind": d.kind,
            "item_key": d.item_key,
            "tracker_ref": d.tracker_ref,
            "detail": d.detail,
            "title": titles.get(d.item_key or ""),
            "link": plan_link(slug, d.item_key) if d.item_key else None,
        }
        for d in o.drift
        if d.kind in DRIFT_KINDS
    ]
    content = {
        "track_id": str(track.id),
        "status": track.status,
        "prd": {"slug": slug, "title": prd.title if prd else track.title},
        "link": plan_link(slug),
        "health": o.health,
        "health_before": await _health_before(db, track, start, o.health),
        "headline": o.headline,
        "next_milestone": None
        if nxt is None
        else {
            "name": nxt.name,
            "date": nxt.target_date.isoformat() if nxt.target_date else None,
            "verified": nxt.dated,
        },
        "alignment": counts,
        "needs_attention": needs,
        "drift": drift,
        "slips": slips_in(needs),
        "dates": dates,
        "prd_moved": o.prd_moved,
        # qa-plan-43: which version is approved, so the report can say "v2 is approved".
        "prd_moved_to": o.latest_approved_version if o.prd_moved else None,
    }
    return content, untracked_now


async def reported_tracks(db: AsyncSession) -> list[ProductTrack]:
    return list(
        await db.scalars(
            select(ProductTrack)
            .where(ProductTrack.status.in_(REPORTED_STATUSES))
            .order_by(ProductTrack.created_at, ProductTrack.id)
        )
    )


async def content_for(
    db: AsyncSession, kind: str, week_start: date, start: datetime, end: datetime
) -> dict[str, Any]:
    tracks = await reported_tracks(db)
    if not tracks:
        raise NoTracks("no active or paused track: nothing to report")
    dates = await _dates(db, {t.prd_document_id for t in tracks}, start, end)
    parts: list[dict[str, Any]] = []
    unreadable: list[dict[str, str]] = []
    untracked_now = 0
    for track in tracks:
        track_id, track_title = track.id, track.title
        # Each track on its own, as monitoring does: one that raises is logged and named
        # in the report, and the others' parts stand.
        try:
            async with db.begin_nested():
                part, untracked = await _track_content(
                    db, track, start, dates[track.prd_document_id]
                )
        except Exception:  # noqa: BLE001 - logged; the report goes on without it
            log.exception("alignment report: track %s could not be read", track_id)
            unreadable.append({"track_id": str(track_id), "title": track_title})
            continue
        parts.append(part)
        untracked_now += untracked
    parts.sort(key=lambda t: (HEALTH_ORDER.get(t["health"], 9), t["prd"]["title"].lower()))
    summary = {
        "tracks": len(parts),
        "at_risk": sum(1 for t in parts if t["health"] == "at_risk"),
        "off_track": sum(1 for t in parts if t["health"] == "off_track"),
        "slips": sum(t["slips"] for t in parts),
        "untracked_now": untracked_now,
        "unplanned": sum(1 for t in parts for d in t["drift"] if d["kind"] == "unplanned"),
        "dates_verified": sum(len(t["dates"]["verified"]) for t in parts),
        "dates_withdrawn": sum(len(t["dates"]["withdrawn"]) for t in parts),
    }
    return {
        "kind": kind,
        "week_start": week_start.isoformat(),
        "headline": headline(summary),
        "summary": summary,
        "tracks": parts,
        "unreadable_tracks": unreadable,
        "needs_attention_as_of_now": True,
    }


def _day(iso: str) -> str:
    """ "Nov 30" from "2026-11-30"."""
    return short_day(date.fromisoformat(iso[:10]))


def _line(text: str | None) -> str:
    return " ".join((text or "").split())


def slips_in(needs: list[dict[str, Any]]) -> int:
    """How many of a track's needs-attention reasons are "slipping" (qa-plan-56): the same
    count the page lists under Needs attention, not only the date_slip/overdue drift
    entries - a track milestone that has passed with no tracker issue is "slipping" too,
    but is not drift."""
    return sum(1 for n in needs if n.get("kind") == "slipping")


def prd_moved_text(track: dict[str, Any]) -> str:
    """qa-plan-43: "v2 of the PRD is approved": which newer version the roadmap is behind
    (a report made before the version was kept says only that a newer one is)."""
    n = track.get("prd_moved_to")
    return f"v{n} of the PRD is approved" if n else "A newer version of the PRD is approved"


def _link_text(text: str | None) -> str:
    """A link's text: brackets (and backslashes) escaped so a "]" does not end it early."""
    return _line(text).replace("\\", "\\\\").replace("[", "\\[").replace("]", "\\]")


def markdown(content: dict[str, Any]) -> str:
    """The report as Markdown: what the page shows, printable and exportable."""
    s = content["summary"]
    lines = [
        f"# {title(content['kind'], content['week_start'])}",
        "",
        content["headline"],
        "",
        "| Tracks | At risk | Off track | Dates slipping | Now items without an issue "
        "| Unplanned work | Dates verified | Dates withdrawn |",
        "|---|---|---|---|---|---|---|---|",
        f"| {s['tracks']} | {s['at_risk']} | {s['off_track']} | {s['slips']} | "
        f"{s['untracked_now']} | {s['unplanned']} | {s['dates_verified']} | "
        f"{s['dates_withdrawn']} |",
    ]
    if unreadable := content.get("unreadable_tracks"):
        names = ", ".join(_line(t["title"]) for t in unreadable)
        lines += ["", f"Oracle could not read {len(unreadable)} track(s) this time: {names}."]
    when = "as of now" if content.get("needs_attention_as_of_now") else "this week"
    for t in content["tracks"]:
        health = HEALTH_LABEL.get(t["health"], t["health"])
        before = t.get("health_before")
        if before and before != t["health"]:
            health += f", was {HEALTH_LABEL.get(before, before)}"
        lines += ["", f"## {_line(t['prd']['title'])} · {health}", "", _line(t["headline"]), ""]
        nxt = t.get("next_milestone")
        if nxt:
            day = short_day(date.fromisoformat(nxt["date"])) if nxt["date"] else "no date"
            basis = "verified basis" if nxt["verified"] else "no verified basis"
            lines.append(f"- Next milestone: {_line(nxt['name'])}, {day} ({basis})")
        a = t["alignment"]
        lines.append(
            f"- Alignment: {a['aligned']} aligned, {a['drift']} drift, "
            f"{a['untracked']} untracked, {a['done']} done"
        )
        if t.get("prd_moved"):
            lines.append(f"- {prd_moved_text(t)} · [Update the roadmap]({t['link']})")
        if t["needs_attention"]:
            lines += ["", f"### Needs attention ({when})", ""]
            lines += [
                f"- [{_link_text(n['title'])}]({n['link']}) · "
                f"{HORIZON_LABEL.get(n['horizon'], n['horizon'])}: {_line(n['detail'])}"
                for n in t["needs_attention"]
            ]
        if t["drift"]:
            lines += ["", "### Drift", ""]
            lines += [f"- {_line(d['detail'])}" for d in t["drift"]]
        dates = t["dates"]
        if dates["verified"] or dates["withdrawn"]:
            lines += ["", "### Dates", ""]
            lines += [
                f"- Verified: {_line(d['reference'])} supports {_day(d['supports_date'])}"
                for d in dates["verified"]
            ]
            lines += [
                f"- Withdrawn: {_line(d['reference'])} ({_day(d['supports_date'])})"
                + (f": {_line(d['reason'])}" if d.get("reason") else "")
                for d in dates["withdrawn"]
            ]
    return "\n".join(lines) + "\n"


# --- building ----------------------------------------------------------------------------


async def build(
    db: AsyncSession,
    *,
    kind: str,
    week_start: date,
    settings: ReportSettings | None = None,
    generated_by: Any = None,
    post_to_slack: bool = True,
) -> AlignmentReport:
    """Build and add a report (the caller commits). A weekly report covers its whole week;
    an on-demand one the week so far. Raises :class:`NoTracks` without an active or paused
    track and :class:`AlreadyBuilt` for a week that has its weekly report. The Slack
    status starts ``pending`` when it should post and can (oracle.reports.slack.deliver
    posts it), ``not_configured`` without an install or a channel, ``not_requested``
    for an on-demand report not asked to post."""
    from oracle.integrations import slack_oauth

    settings = settings or await load_settings(db)
    now = clock.now()
    start, end = week_window(week_start, settings.timezone)
    if kind == "on_demand":
        end = min(end, now)
    content = await content_for(db, kind, week_start, start, end)
    channel = settings.slack_channel
    if not post_to_slack:
        slack_status = "not_requested"
    elif channel and await slack_oauth.installed(db) is not None:
        slack_status = "pending"
    else:
        slack_status = "not_configured"
    report = AlignmentReport(
        kind=kind,
        week_start=week_start,
        period_start=start,
        period_end=end,
        timezone=settings.timezone,
        content=content,
        markdown=markdown(content),
        generated_by=getattr(generated_by, "id", None),
        slack_status=slack_status,
        slack_channel_id=channel["id"] if channel and slack_status == "pending" else None,
        slack_channel_name=channel["name"] if channel and slack_status == "pending" else None,
        slack_next_attempt_at=now if slack_status == "pending" else None,
        created_at=now,
    )
    try:
        async with db.begin_nested():
            db.add(report)
            await db.flush()
    except IntegrityError:
        raise AlreadyBuilt(f"the weekly report for the week of {week_start} exists") from None
    await audit.record(
        db,
        generated_by,
        "alignment_report.generated",
        "alignment_report",
        report.id,
        {
            "kind": kind,
            "week_start": week_start.isoformat(),
            "tracks": content["summary"]["tracks"],
            "slack_status": slack_status,
        },
    )
    return report
