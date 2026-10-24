"""Pre-read block builders: deterministic, from Oracle's own data, no model call.

Each builder is ``await fn(db, ctx)`` and returns the block's rows; every row has a
one-line ``text`` (the markdown) and, where there is one, the ``href`` of the Oracle
page it came from. :data:`BUILDERS` maps a block key to its builder; a kind lists its
blocks in order (oracle.rituals.kinds). The ``goals`` block's distance to go is Home's
(``web/app/home/_goals.ts`` ``assess``), on B5's figure port (oracle.baseline.figures).
"""

import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import company_time
from oracle.baseline import figures
from oracle.baseline.figures import Figure
from oracle.baseline.models import Edge, Entity, GoalMeasurement, Proposal
from oracle.docs.models import Document, DocumentVersion
from oracle.market import blocks as market_blocks
from oracle.priorities.models import PrioritySnapshot
from oracle.quality.models import OutcomeRecord
from oracle.roadmap.models import ProductTrack, RoadmapItem, TrackerRecord, TrackMilestone
from oracle.runs.models import Checkpoint, Run
from oracle.v2.models import BlockerResolutionEvent

TITLES = {
    "goals": "Goals",
    "since_last": "Since last time",
    "outcomes_due": "Outcomes due for a check",
    "needs_decision": "Needs a decision",
    "tracks": "Tracks",
    "slips": "Date slips",
    "stale_items": "Possibly stale items",
    "done_items": "Done",
    "priority_changes": "Priority changes",
    "new_requests": "New requests",
    "horizon_ending": "Goals whose horizon ends this quarter",
    "goal_gaps": "Goals missing a field",
    "outcomes_assessed": "Outcomes assessed",
    "unserved_features": "Features serving no confirmed goal",
    "suggested_next": "Suggested next",
    "alignment_report": "Weekly alignment report",
    "decisions_due": "Decisions due for review",
    "decisions_made": "Decisions made",
    "strategy_drift": "Strategy drift",
    "strategy_age": "Strategy age",
    "changelog_drafts": "Changelog drafts",
    "update_draft": "Update draft",
    "metrics_table": "Metrics",
    "variances": "Variances",
}
# Features that moved this many ranks between the last two snapshots.
PRIORITY_MOVE = 3
CURRENCY = {"USD": "$", "EUR": "€", "GBP": "£"}


@dataclass(frozen=True)
class BlockCtx:
    ritual_owner_id: uuid.UUID
    period_from: datetime
    period_to: datetime
    now: datetime
    # The occurrence being built (H5's variances block ties its variances to it).
    occurrence_id: uuid.UUID | None = None


# --- Home's distance to go ------------------------------------------------------------


def _typed(value: Any, unit: Any) -> Figure | None:
    """A B5 typed number with its unit, as the figure Home would read from the text."""
    if isinstance(value, bool) or not isinstance(value, int | float):
        return figures.parse_figure(value)
    unit = unit if isinstance(unit, str) else ""
    if unit in CURRENCY:
        return Figure(value=float(value), currency=CURRENCY[unit])
    return Figure(value=float(value), unit=unit)


def _first(attrs: dict[str, Any], key: str) -> Any:
    v = attrs.get(key)
    return attrs.get(f"{key}_text") if v is None or v == "" else v


def _noun(u: str) -> str:
    return u[:-1] if len(u) > 3 and u.endswith("s") else u


def _same_unit(c: Figure, t: Figure) -> bool:
    if c.currency and t.currency and c.currency != t.currency:
        return False
    if c.currency and not t.currency:
        return False
    ct, tt = c.unit in figures.TIME.values(), t.unit in figures.TIME.values()
    if ct or tt:
        return ct and tt
    if c.unit == "%" or t.unit == "%":
        return c.unit == t.unit
    return c.unit == "" or _noun(c.unit) == _noun(t.unit)


MS = {"ms": 1, "s": 1e3, "min": 6e4, "h": 3.6e6, "days": 8.64e7}


def _base(f: Figure, v: float | None = None) -> float:
    return (f.value if v is None else v) * MS.get(f.unit, 1)


def _round1(n: float) -> float:
    return round(n * 10) / 10


def _amount(n: float, compact: bool) -> str:
    if compact:
        for s, v in (("B", 1e9), ("M", 1e6), ("k", 1e3)):
            if abs(n) >= v:
                return f"{_round1(n / v):g}{s}"
    return f"{_round1(n):g}"


def distance_text(attrs: dict[str, Any]) -> str:
    """What Home shows under the goal: "7 pts to go", "Target met", "Not below", "" (no
    distance can be given) or "No current value"."""
    current = _first(attrs, "current")
    if current is None or current == "":
        return "No current value"
    unit = attrs.get("unit")
    c, t = _typed(current, unit), _typed(_first(attrs, "target"), unit)
    if not c or not t or c.range or not _same_unit(c, t):
        return ""
    raw_target = _first(attrs, "target")
    said = figures.direction(raw_target)
    comparison = attrs.get("comparison")
    if said is None and comparison in ("at_least", "above", "at_most", "below"):
        said = figures.Direction(
            "up" if comparison in ("at_least", "above") else "down",
            comparison in ("above", "below"),
        )
    way, strict = (said.way, said.strict) if said else ("up", False)
    lo, hi = t.range or (t.value, t.value)
    bound = _base(t, lo if way == "up" else hi)
    now = _base(c)
    left = bound - now if way == "up" else now - bound
    if left == 0 and strict:
        return "Not below" if way == "down" else "Not above"
    if left <= 0:
        return "Target met"
    distance = left / MS.get(t.unit, 1)
    shown_unit = "pts" if t.unit == "%" else t.unit
    cur = t.currency or c.currency
    shown = f"{cur}{_amount(distance, t.compact or c.compact)}"
    if float(shown.lstrip("$€£").rstrip("kMB") or 0) == 0:
        shown = f"{cur}{float(f'{distance:.1g}'):g}"
    return f"{shown}{' ' + shown_unit if shown_unit else ''} to go"


# --- builders ---------------------------------------------------------------------------


async def _goals(db: AsyncSession, confirmed: bool = True) -> list[Entity]:
    q = select(Entity).where(Entity.type == "goal").order_by(Entity.title)
    if confirmed:
        q = q.where(Entity.status == "confirmed")
    return list(await db.scalars(q))


def _shown(v: Any) -> str | None:
    return None if v is None or v == "" else str(v)


async def goals(db: AsyncSession, ctx: BlockCtx) -> list[dict[str, Any]]:
    rows = []
    for g in await _goals(db):
        a = g.attrs or {}
        before = await db.scalar(
            select(GoalMeasurement.value)
            .where(GoalMeasurement.entity_id == g.id, GoalMeasurement.measured_on
                   <= ctx.period_from.date())
            .order_by(GoalMeasurement.measured_on.desc())
            .limit(1)
        )  # fmt: skip
        current = _first(a, "current")
        change = None
        if before is not None and isinstance(current, int | float):
            change = float(current) - float(before)
        distance = distance_text(a)
        rows.append({
            "goal_id": str(g.id), "title": g.title, "metric": _shown(a.get("metric")),
            "target": _shown(_first(a, "target")), "current": _shown(current),
            "distance": distance, "change_since_last": change,
            "owner": _shown(_first(a, "owner")), "href": f"/baseline?entity={g.id}",
            "text": f"{g.title}: {_shown(current) or '-'} of {_shown(_first(a, 'target')) or '-'}"
                    f"{' · ' + distance if distance else ''}",
        })  # fmt: skip
    return rows


async def since_last(db: AsyncSession, ctx: BlockCtx) -> list[dict[str, Any]]:
    window = (ctx.period_from, ctx.period_to)

    async def count(q) -> int:
        return int(await db.scalar(q) or 0)

    approved = (
        select(Document.kind, func.count())
        .select_from(DocumentVersion)
        .join(Document, Document.id == DocumentVersion.document_id)
        .where(DocumentVersion.approved_at.between(*window))
        .group_by(Document.kind)
    )
    by_kind = dict((await db.execute(approved)).all())
    runs = await count(
        select(func.count()).select_from(Run).where(Run.finished_at.between(*window))
    )
    proposals = await count(
        select(func.count())
        .select_from(Proposal)
        .where(Proposal.status == "accepted", Proposal.decided_at.between(*window))
    )
    # Blockers (CR-04): constraint entities carrying a blocker strategy, opened in the
    # window, and those whose status turned resolved in it.
    opened = await count(
        select(func.count())
        .select_from(Entity)
        .where(Entity.type == "constraint", Entity.attrs.has_key("blocker"),
               Entity.created_at.between(*window))
    )  # fmt: skip
    resolved = await count(
        select(func.count(func.distinct(BlockerResolutionEvent.blocker_id))).where(
            BlockerResolutionEvent.to_status == "resolved",
            BlockerResolutionEvent.created_at.between(*window),
        )
    )
    figures_ = [
        ("PRD versions approved", by_kind.get("prd", 0), "/documents?kind=prd"),
        ("Roadmap versions approved", by_kind.get("roadmap", 0), "/roadmap"),
        ("Runs finished", runs, "/runs"),
        ("Proposals accepted", proposals, "/baseline"),
        ("Blockers opened", opened, "/baseline?type=constraint"),
        ("Blockers resolved", resolved, "/baseline?type=constraint"),
    ]
    return [{"label": label, "count": n, "href": href, "text": f"{label}: {n}"}
            for label, n, href in figures_]  # fmt: skip


async def outcomes_due(db: AsyncSession, ctx: BlockCtx) -> list[dict[str, Any]]:
    today = ctx.now.date().isoformat()
    rows = []
    for o in await db.scalars(
        select(OutcomeRecord)
        .where(OutcomeRecord.status == "tracking")
        .order_by(OutcomeRecord.created_at)
    ):
        by = (o.prediction or {}).get("by")
        if isinstance(by, str) and by[:10] <= today:
            rows.append({"outcome_id": str(o.id), "title": o.title, "by": by[:10],
                         "href": f"/plan/outcomes?outcome={o.id}",
                         "text": f"{o.title} (due {by[:10]})"})  # fmt: skip
    return rows


async def needs_decision(db: AsyncSession, ctx: BlockCtx) -> list[dict[str, Any]]:
    from oracle.decisions.models import Decision

    rows = []
    for c in await db.scalars(
        select(Checkpoint).where(Checkpoint.status == "pending").order_by(Checkpoint.created_at)
    ):
        what = c.kind.replace("_", " ")
        rows.append({"kind": "checkpoint", "id": str(c.id), "title": what,
                     "href": f"/runs/{c.run_id}", "text": f"Run stop: {what}"})  # fmt: skip
    for d in await db.scalars(
        select(Decision)
        .where(Decision.status == "proposed", Decision.approver_id == ctx.ritual_owner_id)
        .order_by(Decision.number)
    ):
        rows.append({"kind": "decision", "id": str(d.id), "title": d.title,
                     "href": f"/company/decisions?d={d.number}",
                     "text": f"D-{d.number} {d.title}"})  # fmt: skip
    for r in await db.scalars(
        select(Run).where(Run.status == "awaiting_approval").order_by(Run.created_at)
    ):
        rows.append({"kind": "cost_approval", "id": str(r.id), "title": r.flow,
                     "href": f"/runs/{r.id}", "text": f"Cost approval: {r.flow} run"})  # fmt: skip
    return rows


async def _active_tracks(db: AsyncSession) -> list[ProductTrack]:
    return list(
        await db.scalars(
            select(ProductTrack).where(ProductTrack.status == "active").order_by(ProductTrack.title)
        )
    )


async def tracks(db: AsyncSession, ctx: BlockCtx) -> list[dict[str, Any]]:
    rows = []
    for t in await _active_tracks(db):
        m = t.monitor or {}
        nxt = m.get("next_milestone")
        health = m.get("health") or "unknown"
        at_risk = len(m.get("at_risk") or [])
        rows.append({
            "track_id": str(t.id), "title": t.title, "health": health, "at_risk_items": at_risk,
            "next_milestone": nxt, "href": f"/roadmap?track={t.id}",
            "text": f"{t.title}: {health.replace('_', ' ')}, {at_risk} at risk",
        })  # fmt: skip
    return rows


async def slips(db: AsyncSession, ctx: BlockCtx) -> list[dict[str, Any]]:
    rows = []
    milestones = await db.scalars(
        select(TrackMilestone)
        .where(TrackMilestone.status == "planned", TrackMilestone.target_date.is_not(None))
        .order_by(TrackMilestone.target_date)
    )
    for m in milestones:
        latest = await db.scalar(
            select(func.max(TrackerRecord.target_date)).where(
                TrackerRecord.track_id == m.track_id,
                TrackerRecord.item_key.in_(m.item_keys or [""]),
            )
        )
        if latest is not None and m.target_date is not None and latest > m.target_date:
            rows.append({
                "milestone_id": str(m.id), "track_id": str(m.track_id), "title": m.name,
                "milestone_date": m.target_date.isoformat(), "tracker_date": latest.isoformat(),
                "href": f"/roadmap?track={m.track_id}",
                "text": f"{m.name}: {m.target_date.isoformat()} -> {latest.isoformat()}",
            })  # fmt: skip
    return rows


async def stale_items(db: AsyncSession, ctx: BlockCtx) -> list[dict[str, Any]]:
    return [
        {"item_key": i.item_key, "title": i.title, "track_id": str(i.track_id) if i.track_id
         else None, "href": f"/roadmap?item={i.item_key}", "text": i.title}
        for i in await db.scalars(
            select(RoadmapItem).where(RoadmapItem.freshness == "potentially_stale")
            .order_by(RoadmapItem.title)
        )
    ]  # fmt: skip


async def done_items(db: AsyncSession, ctx: BlockCtx) -> list[dict[str, Any]]:
    return [
        {"external_ref": r.external_ref, "title": r.title or r.external_ref,
         "item_key": r.item_key, "href": f"/roadmap?track={r.track_id}" if r.track_id else None,
         "text": f"{r.external_ref} {r.title or ''}".strip()}
        for r in await db.scalars(
            select(TrackerRecord)
            .where(TrackerRecord.state == "done", TrackerRecord.item_key.is_not(None),
                   TrackerRecord.observed_at.between(ctx.period_from, ctx.period_to))
            .order_by(TrackerRecord.observed_at)
        )
    ]  # fmt: skip


async def priority_changes(db: AsyncSession, ctx: BlockCtx) -> list[dict[str, Any]]:
    last_two = list(
        await db.scalars(
            select(PrioritySnapshot)
            .where(PrioritySnapshot.status == "saved")
            .order_by(PrioritySnapshot.created_at.desc())
            .limit(2)
        )
    )
    if len(last_two) < 2:
        return []
    now, before = last_two
    was = {r.get("key"): r for r in before.ranking or []}
    rows = []
    for r in now.ranking or []:
        old = was.get(r.get("key"))
        if old is None or "rank" not in r or "rank" not in old:
            continue
        moved = old["rank"] - r["rank"]
        if abs(moved) >= PRIORITY_MOVE:
            title = r.get("title") or r.get("key")
            rows.append({"key": r.get("key"), "title": title, "from": old["rank"],
                         "to": r["rank"], "href": "/priorities",
                         "text": f"{title}: #{old['rank']} -> #{r['rank']}"})  # fmt: skip
    return rows


async def new_requests(db: AsyncSession, ctx: BlockCtx) -> list[dict[str, Any]]:
    """C1 requests filed in the window, merged ones left out (their survivor counts)."""
    from oracle.requests.models import ProductRequest

    return [
        {"request_id": str(r.id), "title": r.title, "channel": r.channel, "state": r.state,
         "href": f"/requests?request={r.id}", "text": f"{r.title} ({r.channel})"}
        for r in await db.scalars(
            select(ProductRequest)
            .where(ProductRequest.created_at.between(ctx.period_from, ctx.period_to),
                   ProductRequest.state != "merged")
            .order_by(ProductRequest.created_at)
        )
    ]  # fmt: skip


def _quarter_end(d: date) -> date:
    q_last_month = ((d.month - 1) // 3) * 3 + 3
    return date(d.year + (q_last_month > 12), (q_last_month - 1) % 12 + 1, 1)


async def horizon_ending(db: AsyncSession, ctx: BlockCtx) -> list[dict[str, Any]]:
    today = ctx.now.date()
    rows = []
    for g in await _goals(db):
        a = g.attrs or {}
        due = a.get("due")
        ends = a.get("horizon") == "short"
        if isinstance(due, str):
            try:
                d = date.fromisoformat(due)
                ends = ends or _quarter_end(d) == _quarter_end(today)
            except ValueError:
                pass
        if ends:
            rows.append({"goal_id": str(g.id), "title": g.title, "href": f"/baseline?entity={g.id}",
                         "text": g.title})  # fmt: skip
    return rows


async def goal_gaps(db: AsyncSession, ctx: BlockCtx) -> list[dict[str, Any]]:
    rows = []
    for g in await _goals(db):
        a = g.attrs or {}
        missing = [k for k in ("metric", "target", "owner", "weight") if _first(a, k) in (None, "")]
        if missing:
            rows.append({"goal_id": str(g.id), "title": g.title, "missing": missing,
                         "href": f"/baseline?entity={g.id}",
                         "text": f"{g.title}: no {', '.join(missing)}"})  # fmt: skip
    return rows


async def outcomes_assessed(db: AsyncSession, ctx: BlockCtx) -> list[dict[str, Any]]:
    rows = []
    for o in await db.scalars(
        select(OutcomeRecord)
        .where(OutcomeRecord.assessed_at.between(ctx.period_from, ctx.period_to))
        .order_by(OutcomeRecord.assessed_at)
    ):
        held = o.status in ("held", "partially_held")
        rows.append({"outcome_id": str(o.id), "title": o.title, "status": o.status, "held": held,
                     "href": f"/plan/outcomes?outcome={o.id}",
                     "text": f"{o.title}: {o.status.replace('_', ' ')}"})  # fmt: skip
    if rows:
        share = round(100 * sum(r["held"] for r in rows) / len(rows))
        rows.append({"share_held": share, "text": f"{share}% held", "href": None})
    return rows


async def unserved_features(db: AsyncSession, ctx: BlockCtx) -> list[dict[str, Any]]:
    goal_ids = {g.id for g in await _goals(db)}
    served = set(
        await db.scalars(
            select(Edge.src_id).where(
                Edge.type == "supports", Edge.status != "rejected",
                Edge.dst_id.in_(goal_ids or {uuid.UUID(int=0)}),
            )
        )
    )  # fmt: skip
    return [
        {"feature_id": str(f.id), "title": f.title, "href": f"/baseline?entity={f.id}",
         "text": f.title}
        for f in await db.scalars(
            select(Entity).where(Entity.type == "feature", Entity.status == "confirmed")
            .order_by(Entity.title)
        )
        if f.id not in served
    ]  # fmt: skip


async def suggested_next(db: AsyncSession, ctx: BlockCtx) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = [
        {"label": f"Start a roadmap run from {t.title}", "method": "POST",
         "href": f"/v1/tracks/{t.id}/roadmap-run", "text": f"Start a roadmap run from {t.title}"}
        for t in await _active_tracks(db)
    ]  # fmt: skip
    rows.append({"label": "Review goals", "href": "/baseline", "text": "Review goals"})
    rows.append({"label": "Open priorities", "href": "/priorities", "text": "Open priorities"})
    return rows


async def alignment_report(db: AsyncSession, ctx: BlockCtx) -> list[dict[str, Any]]:
    """F6's weekly report for the week before the occurrence's local week, built once
    (oracle.reports.alignment.build; its Slack post goes out on the same tick). A company
    with no active or paused track gets none that week."""
    from oracle.reports import alignment
    from oracle.reports.models import AlignmentReport

    settings = await alignment.load_settings(db)
    week = alignment.week_start_of(ctx.period_to, settings.timezone) - timedelta(days=7)
    try:
        report: AlignmentReport | None = await alignment.build(
            db, kind="weekly", week_start=week, settings=settings
        )
    except alignment.NoTracks:
        return [{"text": "No active or paused track: no report this week", "href": None}]
    except alignment.AlreadyBuilt:
        report = await db.scalar(
            select(AlignmentReport).where(
                AlignmentReport.kind == "weekly", AlignmentReport.week_start == week
            )
        )
    assert report is not None
    title = alignment.title("weekly", week)
    return [{"report_id": str(report.id), "title": title,
             "headline": report.content.get("headline"), "href": f"/plan/reports/{report.id}",
             "text": f"{title}: {report.content.get('headline')}"}]  # fmt: skip


# --- H1 Decision log, H4 Strategy and vision, H6 Launches and changelog, H8 drafts -----


def _decision_row(d: Any) -> dict[str, Any]:
    return {"decision_id": str(d.id), "number": d.number, "title": d.title,
            "review_at": d.review_at.isoformat() if d.review_at else None,
            "href": f"/company/decisions?d={d.number}",
            "text": f"D-{d.number} {d.title}"}  # fmt: skip


async def decisions_due(db: AsyncSession, ctx: BlockCtx) -> list[dict[str, Any]]:
    """Decided judgement calls whose review date has come by the due time (H1's
    ``review_due``)."""
    from oracle.decisions.models import Decision

    return [
        _decision_row(d)
        for d in await db.scalars(
            select(Decision)
            .where(Decision.status == "decided", Decision.origin != "checkpoint",
                   Decision.review_at <= ctx.period_to.date())
            .order_by(Decision.review_at, Decision.number)
        )
    ]  # fmt: skip


async def decisions_made(db: AsyncSession, ctx: BlockCtx) -> list[dict[str, Any]]:
    from oracle.decisions.models import Decision

    return [
        _decision_row(d)
        for d in await db.scalars(
            select(Decision)
            .where(Decision.status == "decided",
                   Decision.decided_at.between(ctx.period_from, ctx.period_to))
            .order_by(Decision.decided_at)
        )
    ]  # fmt: skip


async def strategy_drift(db: AsyncSession, ctx: BlockCtx) -> list[dict[str, Any]]:
    """H4's open drift findings, worst first."""
    from oracle.strategy.models import StrategyFinding

    order = {"high": 0, "warning": 1, "info": 2}
    found = sorted(
        await db.scalars(select(StrategyFinding).where(StrategyFinding.status == "open")),
        key=lambda f: (order.get(f.severity, 3), f.kind, f.subject_ref),
    )
    return [{"finding_id": str(f.id), "kind": f.kind, "severity": f.severity,
             "subject_ref": f.subject_ref, "href": "/company/strategy",
             "text": f"{f.kind.replace('_', ' ').capitalize()}: {f.subject_ref}"}
            for f in found]  # fmt: skip


async def strategy_age(db: AsyncSession, ctx: BlockCtx) -> list[dict[str, Any]]:
    """How old the approved vision and strategy are, and when each is due for review."""
    from oracle.strategy.drift import _latest_approved

    rows: list[dict[str, Any]] = []
    for kind, label in (("strategy", "strategy"), ("vision", "vision")):
        a = await _latest_approved(db, kind)
        if a is None:
            if kind == "strategy":
                rows.append({"kind": kind, "href": "/company/strategy",
                             "text": "No approved strategy yet"})  # fmt: skip
            continue
        approved = a.version.approved_at
        days = (ctx.now - approved).days if approved else None
        rows.append({
            "kind": kind, "title": a.document.title, "approved_at":
            approved.isoformat() if approved else None, "age_days": days,
            "review_on": a.review_on.isoformat(), "href": "/company/strategy",
            "text": f"The {label} was approved {days} days ago; review by {a.review_on}",
        })  # fmt: skip
    return rows


async def changelog_drafts(db: AsyncSession, ctx: BlockCtx) -> list[dict[str, Any]]:
    """H6's changelog entries still in draft."""
    from oracle.launches.models import ChangelogEntry

    return [
        {"entry_id": str(e.id), "title": e.title, "category": e.category,
         "audience": e.audience, "released_on": e.released_on.isoformat(),
         "href": "/roadmap/changelog", "text": f"{e.category.capitalize()}: {e.title}"}
        for e in await db.scalars(
            select(ChangelogEntry).where(ChangelogEntry.status == "draft")
            .order_by(ChangelogEntry.released_on, ChangelogEntry.title)
        )
    ]  # fmt: skip


async def update_draft(db: AsyncSession, ctx: BlockCtx) -> list[dict[str, Any]]:
    """H8's latest update document, linked. Starting the update draft run during
    preparation is not built yet: the owner starts it from Company › Updates."""
    doc = await db.scalar(
        select(Document)
        .where(Document.kind == "update")
        .order_by(Document.created_at.desc())
        .limit(1)
    )
    if doc is None:
        return [{"href": "/company/updates", "text": "No update draft yet"}]
    return [{"document_id": str(doc.id), "title": doc.title, "status": doc.status,
             "href": f"/company/updates?document={doc.id}",
             "text": f"{doc.title} ({doc.status})"}]  # fmt: skip


# --- H5 Metrics review (oracle.metrics.review) ----------------------------------------


async def metrics_table(db: AsyncSession, ctx: BlockCtx) -> list[dict[str, Any]]:
    """The fixed-format metrics table of the week the review reads."""
    from oracle.metrics import review

    return await review.metrics_table(db, ctx.period_to)


async def variances(db: AsyncSession, ctx: BlockCtx) -> list[dict[str, Any]]:
    """The period's variances, tied to the occurrence being built."""
    from oracle.metrics import review

    return await review.variances(db, ctx.period_from, ctx.period_to, ctx.occurrence_id)


# H7 Competitive digest's four blocks (oracle.market.blocks).
TITLES.update(market_blocks.TITLES)

Builder = Callable[[AsyncSession, BlockCtx], Awaitable[list[dict[str, Any]]]]
BUILDERS: dict[str, Builder] = {
    "goals": goals,
    "since_last": since_last,
    "outcomes_due": outcomes_due,
    "needs_decision": needs_decision,
    "tracks": tracks,
    "slips": slips,
    "stale_items": stale_items,
    "done_items": done_items,
    "priority_changes": priority_changes,
    "new_requests": new_requests,
    "horizon_ending": horizon_ending,
    "goal_gaps": goal_gaps,
    "outcomes_assessed": outcomes_assessed,
    "unserved_features": unserved_features,
    "suggested_next": suggested_next,
    "alignment_report": alignment_report,
    "decisions_due": decisions_due,
    "decisions_made": decisions_made,
    "strategy_drift": strategy_drift,
    "strategy_age": strategy_age,
    "changelog_drafts": changelog_drafts,
    "update_draft": update_draft,
    "metrics_table": metrics_table,
    "variances": variances,
    **market_blocks.BUILDERS,
}


async def build(db: AsyncSession, keys: tuple[str, ...], ctx: BlockCtx) -> list[dict[str, Any]]:
    """The blocks ``keys`` in order; a key with no builder is left out. Raises what a
    builder raises."""
    out = []
    for key in keys:
        fn = BUILDERS.get(key)
        if fn is None:
            continue
        rows = await fn(db, ctx)
        out.append({"key": key, "title": TITLES.get(key, key), "as_of": ctx.now.isoformat(),
                    "rows": rows})  # fmt: skip
    return out


def markdown(
    title: str,
    due_at: datetime,
    blocks: list[dict[str, Any]],
    zone: str = company_time.DEFAULT_ZONE,
) -> str:
    """The pre-read as markdown, due in the Company time zone with its short name (#463)."""
    lines = [f"# {title}", "", f"Due {company_time.stamp(due_at, zone)}", ""]
    for b in blocks:
        lines += [f"## {b['title']}", ""]
        if not b["rows"]:
            lines.append("Nothing this time.")
        for r in b["rows"]:
            text = r.get("text") or ""
            lines.append(f"- [{text}]({r['href']})" if r.get("href") else f"- {text}")
        lines.append("")
    return "\n".join(lines)
