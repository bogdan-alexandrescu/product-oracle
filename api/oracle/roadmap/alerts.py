"""Track alerts (F2 Track health): each situation the monitor finds on a track, durable,
with a state, so it reaches the person who decides.

An alert is one situation on one track: ``(track, item key or '', kind, fingerprint)``.
:func:`sync` runs from every :func:`oracle.roadmap.views.monitor` (hourly from the ticker,
after a tracker import, after an action here), whether or not the snapshot changed:

- a situation with no alert row of that fingerprint opens one;
- an open or kept alert whose situation is gone is resolved;
- a kept alert stays kept while its fingerprint holds; new facts (a new fingerprint) open
  a new alert and the old one resolves.

The monitoring rules stay where they are (``views.item_risk``, ``tracker.drift_of``):
alerts only read what they found. No model call.

Accepting a slipped date (:func:`accept_date`) is the one write that moves a date: in one
transaction it records a verified basis from the tracker record, moves the planned Now
milestones resting on the old date, withdraws the old bases (O4: a date rests only on a
verified basis) and monitors the track again. An approved roadmap version is never
rewritten: its old date reads as withdrawn.
"""

import uuid
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from typing import TYPE_CHECKING, Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, autonomy
from oracle.auth.models import User
from oracle.authz import has_role
from oracle.docs import visibility
from oracle.docs.models import Document
from oracle.members.leads import date_rights, engineering_leads
from oracle.members.names import display_name
from oracle.members.schemas import PersonOut
from oracle.roadmap import schedule, staleness, tracker, tracks
from oracle.roadmap.models import (
    ProductTrack,
    RoadmapItem,
    ScheduleBasis,
    TrackAlert,
    TrackerRecord,
    TrackerRecordEvent,
    TrackMilestone,
)
from oracle.roadmap.schemas import (
    InboxTrack,
    InboxTrackCounts,
    TrackAlertOut,
    TrackAlertPrd,
)

if TYPE_CHECKING:
    from oracle.auth.deps import Principal
    from oracle.roadmap.views import TrackRead

# Kinds that also reach the engineering leads (A3), and the kinds a re-plan answers.
LEAD_KINDS = ("date_slip", "overdue")
REPLAN_KINDS = ("date_slip", "overdue", "cancelled", "ahead", "prd_moved")
# Ask the engineering lead (C2 Questions to named people); Discuss fits every kind (G1).
ASK_KINDS = ("date_slip", "overdue", "ahead")
# Kept and resolved alerts stay in the Inbox's Done tab this long.
DONE_DAYS = 30
INBOX_CHILDREN = 3


class AlertError(Exception):
    status_code = 422


class NotFound(AlertError):
    status_code = 404


class Conflict(AlertError):
    status_code = 409


class Forbidden(AlertError):
    status_code = 403


@dataclass
class Situation:
    item_key: str
    kind: str
    fingerprint: str
    detail: str
    data: dict[str, Any] = field(default_factory=dict)


def _day(d: date | None) -> str | None:
    return d.isoformat() if d else None


async def _last_target_change(
    db: AsyncSession, record_ids: list[uuid.UUID]
) -> dict[uuid.UUID, TrackerRecordEvent]:
    """Each record's latest ``target_date`` change, from the tracker history."""
    if not record_ids:
        return {}
    out: dict[uuid.UUID, TrackerRecordEvent] = {}
    for e in await db.scalars(
        select(TrackerRecordEvent)
        .where(
            TrackerRecordEvent.record_id.in_(record_ids), TrackerRecordEvent.field == "target_date"
        )
        .order_by(TrackerRecordEvent.observed_at, TrackerRecordEvent.created_at)
    ):
        out[e.record_id] = e
    return out


def _milestone_name(
    item: RoadmapItem, when: date, own: dict[str, Any] | None, milestones: list[TrackMilestone]
) -> str:
    if own and own.get("date") == when.isoformat() and own.get("name"):
        return str(own["name"])
    for m in milestones:
        if m.status == "planned" and m.target_date == when and item.item_key in (m.item_keys or []):
            return m.name
    return "the milestone"


async def situations(db: AsyncSession, track: ProductTrack, found: "TrackRead") -> list[Situation]:
    """What needs attention on the track now, one situation per alert (§1 of F2)."""
    from oracle.roadmap.views import blocker_dependency, dated_items, today

    if track.status != "active":
        return []
    out: list[Situation] = []
    ctx, now = found.ctx, await today(db)
    dated = dated_items(found.milestones)
    slips: list[tuple[RoadmapItem, TrackerRecord, date]] = []
    for item in found.rows:
        risk = found.risks.get(item.id)
        if risk is None:
            continue
        records = ctx.records_of(item)
        by_ref = {r.external_ref: r for r in records}
        own = ctx.milestone_of(item)
        when = tracker.milestone_date(item, dated, own)
        refs = ",".join(sorted(r.external_ref for r in records))
        overdue_on: date | None = None
        for d in risk.drift:
            if d.kind == "date_slip" and when is not None and d.tracker_ref in by_ref:
                slips.append((item, by_ref[d.tracker_ref], when))
            elif d.kind == "overdue":
                overdue_on = when
            elif d.kind == "cancelled":
                out.append(
                    Situation(item.item_key, "cancelled", refs,
                              "Every issue for this item is cancelled", {"tracker_refs": refs})
                )  # fmt: skip
            elif d.kind == "ahead":
                out.append(
                    Situation(
                        item.item_key, "ahead", f"{refs}|{item.horizon}",
                        f"Engineering started work planned for {item.horizon.title()}",
                        {"tracker_refs": refs, "horizon": item.horizon},
                    )
                )  # fmt: skip
        if overdue_on is None and risk.passed:
            passed = [
                m.target_date
                for m in found.milestones
                if m.status == "planned"
                and m.target_date
                and m.target_date < now
                and item.item_key in (m.item_keys or [])
            ]
            overdue_on = min(passed) if passed else None
        if overdue_on is not None:
            out.append(
                Situation(
                    item.item_key, "overdue", overdue_on.isoformat(),
                    f"The {overdue_on.isoformat()} date has passed and the work is not done",
                    {"milestone_date": overdue_on.isoformat()},
                )
            )  # fmt: skip
        for b in (blocker_dependency(e) for e in ctx.blockers.get(item.id, [])):
            if not b.resolved:
                out.append(
                    Situation(
                        item.item_key, "blocked", f"{b.id}|{b.blocker_status}",
                        f"{b.title} ({b.blocker_status})",
                        {"blocker_id": str(b.id), "blocker_status": b.blocker_status},
                    )
                )  # fmt: skip
        if staleness.is_stale(item):
            # Stored as the item's own reasons (refs kept), so each reader's line hides what
            # they may not see before it is put into words (staleness.detail_for_reader).
            own = staleness.one_count(staleness.own_reasons(item))
            why = "; ".join(own) or "Its PRD trace changed"
            out.append(
                Situation(
                    item.item_key, "stale", str(item.caused_by_change_id or ""), why,
                    {"freshness": item.freshness},
                )
            )  # fmt: skip
    history = await _last_target_change(db, [r.id for _, r, _ in slips])
    for item, r, when in slips:
        name = _milestone_name(item, when, ctx.milestone_of(item), found.milestones)
        last = history.get(r.id)
        out.append(
            Situation(
                item.item_key,
                "date_slip",
                f"{r.external_ref}|{_day(r.target_date)}|{when.isoformat()}",
                f"{r.external_ref} moved to {_day(r.target_date)}; {name} rests on "
                f"{when.isoformat()}",
                {
                    "record_id": str(r.id),
                    "tracker_ref": r.external_ref,
                    "tracker_date": _day(r.target_date),
                    "milestone_name": name,
                    "milestone_date": when.isoformat(),
                    "slip_days": (r.target_date - when).days if r.target_date else None,
                    "previous_tracker_date": last.before if last else None,
                    "changed_at": last.observed_at.isoformat() if last else None,
                },
            )
        )
    keys = {i.item_key for i in found.rows}
    titles = {r.external_ref: r for r in found.records}
    for d in tracker.unplanned(found.records, keys):
        r = titles.get(d.tracker_ref or "")
        out.append(
            Situation(
                "", "unplanned", d.tracker_ref or "",
                f"{d.tracker_ref} ({(r.title if r else None) or 'untitled'}) is not on the "
                "roadmap",
                {"tracker_ref": d.tracker_ref, "record_id": str(r.id) if r else None},
            )
        )  # fmt: skip
    o = found.overview
    if o.prd_moved:
        n = o.latest_approved_version
        out.append(
            Situation(
                "", "prd_moved", str(n), f"The PRD has a newer approved version (v{n})",
                {"version": n},
            )
        )  # fmt: skip
    return out


async def sync(
    db: AsyncSession, track: ProductTrack, found: "TrackRead", change_id: uuid.UUID | None
) -> list[TrackAlert]:
    """Open, keep and resolve the track's alerts to match what is true now. Returns the
    alerts opened. The caller commits."""
    now = datetime.now(UTC)
    current = {(s.item_key, s.kind, s.fingerprint): s for s in await situations(db, track, found)}
    rows = {
        (a.item_key, a.kind, a.fingerprint): a
        for a in await db.scalars(
            select(TrackAlert).where(TrackAlert.track_id == track.id).with_for_update()
        )
    }
    opened: list[TrackAlert] = []
    for key, s in current.items():
        a = rows.get(key)
        if a is None:
            a = TrackAlert(
                track_id=track.id, item_key=s.item_key, kind=s.kind, fingerprint=s.fingerprint,
                detail=s.detail, data=s.data, state="open", opened_at=now,
                opened_change_id=change_id,
            )  # fmt: skip
            db.add(a)
            opened.append(a)
            continue
        if a.state == "resolved":
            # The same facts again: the alert opens again.
            a.state, a.resolved_at, a.opened_at = "open", None, now
            a.opened_change_id = change_id
            a.kept_by = a.kept_at = a.note = None
            opened.append(a)
        a.detail, a.data = s.detail, s.data
    for key, a in rows.items():
        if key not in current and a.state != "resolved":
            a.state, a.resolved_at = "resolved", now
    await db.flush()
    return opened


# --- who sees and does what ------------------------------------------------------------


def in_audience(
    principal: "Principal", track: ProductTrack, kind: str, leads: frozenset[uuid.UUID]
) -> bool:
    """The alert's Inbox audience: the track's owner, else every owner; date slips and
    overdue items also the engineering leads (A3)."""
    uid = principal.user_id
    if track.owner_id is not None:
        if uid == track.owner_id:
            return True
    elif principal.role == "owner":
        return True
    return kind in LEAD_KINDS and uid is not None and uid in leads


def may_accept(principal: "Principal", leads: frozenset[uuid.UUID]) -> bool:
    """Who verifies a date basis (F3 "Who verifies", decided 2026-10-21): engineering leads
    and owners; approvers while no lead is named."""
    if principal.run_id is not None or principal.run_token_id is not None:
        return False
    if leads:
        return principal.role == "owner" or (
            principal.user_id is not None
            and principal.user_id in leads
            and has_role(principal.role, "commenter")
        )
    return has_role(principal.role, "approver")


def actions(
    a: TrackAlert,
    track: ProductTrack,
    principal: "Principal",
    leads: frozenset[uuid.UUID],
    level: str = "recommend",
) -> list[str]:
    """What the caller may do now. ``level``: H11 ``roadmap_watch``. Oracle's one-step
    fixes follow it: Re-plan (a draft roadmap run for the track's owner) from Draft, Accept
    new date (the date change with the tracker's evidence) at Recommend; at Observe an
    alert only flags."""
    if principal.read_only:
        return ["open_blocker"] if a.kind == "blocked" and a.state != "resolved" else []
    out: list[str] = []
    live = a.state != "resolved"
    approver = has_role(principal.role, "approver") and principal.run_id is None
    proposes, drafts = level == "recommend", level in ("draft", "recommend")
    if proposes and a.kind == "date_slip" and a.state == "open" and may_accept(principal, leads):
        out.append("accept_date")
    if drafts and live and approver and a.kind in REPLAN_KINDS:
        out.append("replan")
    if live and approver and a.kind == "stale":
        out += ["review", "reconcile"]
    if live and a.kind == "blocked":
        out.append("open_blocker")
    if live and a.kind == "unplanned" and date_rights(principal, leads) is not None:
        out.append("link")
    person = principal.run_id is None and principal.run_token_id is None
    if live and person and has_role(principal.role, "commenter"):
        if a.kind in ASK_KINDS:
            out.append("ask")
        out.append("discuss")
    if in_audience(principal, track, a.kind, leads):
        if a.state == "open":
            out.append("keep")
        elif a.state == "kept":
            out.append("reopen")
    return out


@dataclass
class Lookups:
    tracks: dict[uuid.UUID, ProductTrack]
    prds: dict[uuid.UUID, Document]
    titles: dict[tuple[uuid.UUID, str], str]
    names: dict[uuid.UUID, str]
    leads: frozenset[uuid.UUID]
    # Ask's pre-fill: the one active engineering lead, when there is exactly one.
    lead: PersonOut | None = None
    # What the reader may not see (visibility.hidden_for_reader); None: everything.
    hidden: Any = None
    # H11 ``roadmap_watch``, read per request.
    level: str = "recommend"


async def lookups(db: AsyncSession, alerts: list[TrackAlert]) -> Lookups:
    track_ids = {a.track_id for a in alerts}
    track_rows = {
        t.id: t
        for t in (
            await db.scalars(select(ProductTrack).where(ProductTrack.id.in_(track_ids)))
            if track_ids
            else []
        )
    }
    prd_ids = {t.prd_document_id for t in track_rows.values()}
    prds = {
        d.id: d
        for d in (
            await db.scalars(select(Document).where(Document.id.in_(prd_ids))) if prd_ids else []
        )
    }
    titles: dict[tuple[uuid.UUID, str], str] = {}
    if track_ids:
        for track_id, key, title in await db.execute(
            select(RoadmapItem.track_id, RoadmapItem.item_key, RoadmapItem.title)
            .where(RoadmapItem.track_id.in_(track_ids))
            .order_by(RoadmapItem.created_at)
        ):
            titles[(track_id, key)] = title
    kept_by = {a.kept_by for a in alerts if a.kept_by}
    names = {
        u.id: u.email
        for u in (await db.scalars(select(User).where(User.id.in_(kept_by))) if kept_by else [])
    }
    leads = await engineering_leads(db)
    lead = None
    if len(leads) == 1 and (user := await db.get(User, next(iter(leads)))) is not None:
        lead = PersonOut(
            user_id=user.id, name=display_name(user.email, user.name), email=user.email,
            role=user.role, can_write=has_role(user.role, "commenter"),  # type: ignore[arg-type]
        )  # fmt: skip
    level = await autonomy.level(db, "roadmap_watch")
    return Lookups(track_rows, prds, titles, names, leads, lead,
                   await visibility.hidden_for_reader(db), level)  # fmt: skip


def out(
    a: TrackAlert, principal: "Principal", lk: Lookups, inbox_state: str | None = None
) -> TrackAlertOut:
    track = lk.tracks[a.track_id]
    prd = lk.prds.get(track.prd_document_id)
    may = actions(a, track, principal, lk.leads, lk.level)
    ask_lead = "ask" in may and lk.lead is not None and lk.lead.user_id != principal.user_id
    return TrackAlertOut(
        id=a.id,
        track_id=a.track_id,
        prd=TrackAlertPrd(slug=prd.slug if prd else "", title=prd.title if prd else track.title),
        item_key=a.item_key or None,
        item_title=lk.titles.get((a.track_id, a.item_key)) if a.item_key else None,
        kind=a.kind,  # type: ignore[arg-type]
        detail=staleness.detail_for_reader(a.detail, lk.hidden) if a.kind == "stale" else a.detail,
        data=a.data or {},
        state=a.state,  # type: ignore[arg-type]
        inbox_state=inbox_state,  # type: ignore[arg-type]
        opened_at=a.opened_at,
        kept_by=a.kept_by,
        kept_by_name=lk.names.get(a.kept_by) if a.kept_by else None,
        kept_at=a.kept_at,
        note=a.note,
        resolved_at=a.resolved_at,
        actions=may,  # type: ignore[arg-type]
        suggested_assignee=lk.lead if ask_lead else None,
    )


async def list_alerts(
    db: AsyncSession, principal: "Principal", state: str, track_id: uuid.UUID | None
) -> list[TrackAlertOut]:
    query = select(TrackAlert).order_by(TrackAlert.opened_at.desc(), TrackAlert.id)
    if state != "all":
        query = query.where(TrackAlert.state == state)
    if track_id is not None:
        query = query.where(TrackAlert.track_id == track_id)
    rows = list(await db.scalars(query))
    lk = await lookups(db, rows)
    return [out(a, principal, lk) for a in rows]


async def get_alert(db: AsyncSession, alert_id: uuid.UUID) -> TrackAlert:
    a = await db.scalar(select(TrackAlert).where(TrackAlert.id == alert_id).with_for_update())
    if a is None:
        raise NotFound("Track alert not found")
    return a


async def _audience_or_403(db: AsyncSession, principal: "Principal", a: TrackAlert) -> None:
    from oracle.auth.service import caller_refusal

    if principal.run_id is not None or principal.run_token_id is not None or principal.read_only:
        raise Forbidden("Keeping an alert is for people")
    track = await db.get(ProductTrack, a.track_id)
    if refusal := await caller_refusal(db, principal, "viewer"):
        raise Forbidden(refusal)
    if track is None or not in_audience(principal, track, a.kind, await engineering_leads(db)):
        raise Forbidden("Only the people this alert goes to keep or reopen it")


async def keep(
    db: AsyncSession, principal: "Principal", alert_id: uuid.UUID, note: str | None
) -> TrackAlert:
    """Keep watching: the alert leaves the Inbox until its facts change. The caller
    commits."""
    a = await get_alert(db, alert_id)
    await _audience_or_403(db, principal, a)
    if a.state != "open":
        raise Conflict(f"This alert is {a.state}, not open")
    a.state, a.kept_by, a.kept_at = "kept", principal.user_id, datetime.now(UTC)
    a.note = (note or "").strip() or None
    await db.flush()
    await audit.record(
        db, principal, "track_alert.kept", "track_alert", a.id,
        {"track_id": str(a.track_id), "kind": a.kind, "item_key": a.item_key or None,
         "note": a.note},
    )  # fmt: skip
    return a


async def reopen(db: AsyncSession, principal: "Principal", alert_id: uuid.UUID) -> TrackAlert:
    a = await get_alert(db, alert_id)
    await _audience_or_403(db, principal, a)
    if a.state != "kept":
        raise Conflict(f"This alert is {a.state}, not kept")
    a.state = "open"
    await db.flush()
    await audit.record(
        db, principal, "track_alert.reopened", "track_alert", a.id,
        {"track_id": str(a.track_id), "kind": a.kind, "item_key": a.item_key or None},
    )  # fmt: skip
    return a


@dataclass
class Accepted:
    alert: TrackAlert
    basis: ScheduleBasis
    withdrawn: list[uuid.UUID]
    moved: list[tuple[uuid.UUID, date | None, date]]
    stale: list[uuid.UUID]


async def accept_date(
    db: AsyncSession, principal: "Principal", alert_id: uuid.UUID, reason: str | None
) -> Accepted:
    """Accept a slipped date in one transaction (the caller commits; any failure rolls
    all of it back): a verified basis from the tracker record, the planned Now milestones
    that listed the item at the old date moved to the new one on it, the bases the old
    date rested on withdrawn, the track monitored again."""
    from oracle.auth.service import caller_refusal
    from oracle.roadmap import views

    a = await get_alert(db, alert_id)
    # Who may: re-checked at write time, with the leads read now (F3 "Who verifies").
    if refusal := await caller_refusal(db, principal, "commenter"):
        raise Forbidden(refusal)
    if not may_accept(principal, await engineering_leads(db)):
        raise Forbidden(
            "Only an engineering lead or an owner accepts a new date"
            if await engineering_leads(db)
            else "Requires the approver role"
        )
    if a.kind != "date_slip" or a.state != "open":
        raise Conflict("Only an open date slip can be accepted")
    track = await tracks.get_track(db, a.track_id, for_update=True)
    data = a.data or {}
    record = await db.get(TrackerRecord, uuid.UUID(data["record_id"]))
    if record is None or _day(record.target_date) != data.get("tracker_date"):
        # The tracker moved again since the alert opened: re-sync, and say so.
        await views.monitor(db, track, principal)
        raise Conflict("The tracker date changed since this alert opened; look again")
    new_date: date = record.target_date  # type: ignore[assignment]
    old_date = date.fromisoformat(data["milestone_date"])
    who = principal.user_id and await db.get(User, principal.user_id)
    person = who.email if who else "an API token"
    note = f"Moved to {new_date.isoformat()} per {record.external_ref}, accepted by {person}"
    if reason and reason.strip():
        note += f": {reason.strip()}"

    basis = ScheduleBasis(
        kind="estimate", reference=record.external_ref, supports_date=new_date,
        detail=note, prd_document_id=track.prd_document_id,
        tracker_record_id=record.id, status="verified", verified_by=principal.id,
        verified_at=schedule.now(),
    )  # fmt: skip
    db.add(basis)
    await db.flush()
    prd = await db.get(Document, track.prd_document_id)
    await audit.record(
        db, principal, "schedule_basis.verified", "schedule_basis", basis.id,
        {"kind": basis.kind, "reference": basis.reference,
         "supports_date": str(basis.supports_date), "prd": prd.slug if prd else None,
         "item_key": None, "tracker_key": None, "via": "track_alert.date_accepted"},
    )  # fmt: skip

    # The milestones resting on the old date move to the new one, on the new basis.
    old_bases: set[uuid.UUID] = set()
    moved: list[tuple[uuid.UUID, date | None, date]] = []
    for m in await db.scalars(
        select(TrackMilestone)
        .where(
            TrackMilestone.track_id == track.id,
            TrackMilestone.status == "planned",
            TrackMilestone.horizon == "now",
            TrackMilestone.target_date == old_date,
            TrackMilestone.item_keys.contains([a.item_key]),
        )
        .order_by(TrackMilestone.id)
        .with_for_update()
    ):
        ids = await tracks.check_date(db, track, "now", new_date, [basis.id], list(m.item_keys))
        old_bases.update(m.basis_ids or [])
        moved.append((m.id, m.target_date, new_date))
        m.target_date, m.basis_ids = new_date, ids
        await db.flush()
        await audit.record(
            db, principal, "milestone.updated", "track_milestone", m.id,
            {"before": {"target_date": old_date.isoformat(), "horizon": m.horizon,
                        "status": m.status},
             "after": {"target_date": new_date.isoformat(), "horizon": m.horizon,
                       "status": m.status},
             "via": "track_alert.date_accepted"},
        )  # fmt: skip
    # The item's own milestone date (its roadmap version is never rewritten).
    found = await views.read(db, track)
    for item in found.rows:
        if item.item_key == a.item_key:
            own = found.ctx.milestone_of(item) or {}
            if own.get("date") == old_date.isoformat():
                old_bases.update(uuid.UUID(b) for b in own.get("basis_ids") or [])
    withdrawn: list[uuid.UUID] = []
    stale: list[uuid.UUID] = []
    for b in await db.scalars(
        select(ScheduleBasis)
        .where(
            ScheduleBasis.id.in_(old_bases),
            ScheduleBasis.status == "verified",
            ScheduleBasis.supports_date == old_date,
        )
        .order_by(ScheduleBasis.id)
        .with_for_update()
    ):
        _, items = await schedule.withdraw(db, principal, b, note)
        withdrawn.append(b.id)
        stale += [i for i in items if i not in stale]
    a.state, a.resolved_at = "resolved", datetime.now(UTC)
    await db.flush()
    await audit.record(
        db, principal, "track_alert.date_accepted", "track_alert", a.id,
        {"track_id": str(track.id), "item_key": a.item_key, "basis_id": str(basis.id),
         "supports_date": new_date.isoformat(), "from": old_date.isoformat(),
         "withdrawn_basis_ids": [str(i) for i in withdrawn],
         "milestones_moved": [{"id": str(i), "from": _day(f), "to": t.isoformat()}
                              for i, f, t in moved],
         "reason": reason},
    )  # fmt: skip
    await views.monitor(db, track, principal)
    return Accepted(a, basis, withdrawn, moved, stale)


# --- Inbox (F2 §4) -----------------------------------------------------------------------


async def inbox_rows(
    db: AsyncSession, principal: "Principal", seen: datetime | None
) -> list[InboxTrack]:
    """The caller's track rows: their audience's open alerts (New since the last visit,
    else Open), and kept and resolved ones of the last 30 days (Done)."""
    if principal.run_id is not None or principal.run_token_id is not None:
        return []
    since = datetime.now(UTC) - timedelta(days=DONE_DAYS)
    rows = list(
        await db.scalars(
            select(TrackAlert)
            .where(
                (TrackAlert.state == "open")
                | ((TrackAlert.state == "kept") & (TrackAlert.kept_at >= since))
                | ((TrackAlert.state == "resolved") & (TrackAlert.resolved_at >= since))
            )
            .order_by(TrackAlert.opened_at.desc(), TrackAlert.id)
        )
    )
    if not rows:
        return []
    lk = await lookups(db, rows)
    mine = [a for a in rows if in_audience(principal, lk.tracks[a.track_id], a.kind, lk.leads)]
    groups: dict[uuid.UUID, list[TrackAlert]] = {}
    for a in mine:
        groups.setdefault(a.track_id, []).append(a)
    result: list[InboxTrack] = []
    for track_id, alerts in groups.items():
        track = lk.tracks[track_id]
        prd = lk.prds.get(track.prd_document_id)
        live = [a for a in alerts if a.state == "open"]
        counts = InboxTrackCounts(
            new=sum(1 for a in live if seen is None or a.opened_at > seen),
            kept=sum(1 for a in alerts if a.state == "kept"),
        )
        counts.open = len(live) - counts.new

        def state(a: TrackAlert) -> str:
            if a.state != "open":
                return "done"
            return "new" if seen is None or a.opened_at > seen else "open"

        result.append(
            InboxTrack(
                track_id=track_id,
                prd=TrackAlertPrd(
                    slug=prd.slug if prd else "", title=prd.title if prd else track.title
                ),
                health=(track.monitor or {}).get("health"),
                counts=counts,
                newest_at=max((a.opened_at for a in live), default=None),
                alerts=[out(a, principal, lk, state(a)) for a in live[:INBOX_CHILDREN]],
                more=max(0, len(live) - INBOX_CHILDREN),
                done=[out(a, principal, lk, "done") for a in alerts if a.state != "open"][:20],
            )
        )
    result.sort(key=lambda t: t.newest_at or datetime.min.replace(tzinfo=UTC), reverse=True)
    return result


async def record_events(db: AsyncSession, record_id: uuid.UUID) -> list[TrackerRecordEvent]:
    if await db.get(TrackerRecord, record_id) is None:
        raise NotFound("Tracker record not found")
    return list(
        await db.scalars(
            select(TrackerRecordEvent)
            .where(TrackerRecordEvent.record_id == record_id)
            .order_by(TrackerRecordEvent.observed_at, TrackerRecordEvent.created_at)
        )
    )
