"""Product tracks (V2b): an accepted PRD starts a track, which follows its roadmap.

A track is started:

- when a PRD version is approved, which publishes it (T2: approving = publishing;
  oracle.review.service.approve_version calls :func:`ensure_track`);
- by the review lane's publish transaction, through ``oracle.changes`` (a
  ``document_version`` change with cause ``published``; :func:`on_published`);
- when a roadmap's items are stored from an approved PRD version (a ``prd_to_roadmap``
  run reads only approved versions), so tracks exist on today's approve flow too;
- by a person (``POST /v1/tracks``) from a PRD with an approved version.

tracks-goal (owner Nov 9): a track holds many PRDs (``track_prds``); a PRD has at most one
track. Oracle starts no track on its own: a newly accepted PRD with no track gets one Inbox
suggestion (:func:`auto_track`) that a person confirms, and a PRD a person took off a track
gets none again. A track follows its PRDs' latest approved version (``current_version_id``:
the last one it advanced to) and the roadmap built from them. Milestones are undated by
default (Now/Next/Later, O4); a date needs verified schedule bases that support exactly
that date, and only in Now.
"""

import uuid
from datetime import date
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.auth.deps import Principal
from oracle.docs.models import Document, DocumentVersion
from oracle.models import AuditEvent
from oracle.roadmap import links
from oracle.roadmap.models import ProductTrack, ScheduleBasis, TrackMilestone, TrackPrd


class TrackError(Exception):
    status_code = 422


class NotFound(TrackError):
    status_code = 404


class Invalid(TrackError):
    status_code = 422


class Conflict(TrackError):
    status_code = 409


async def latest_approved(db: AsyncSession, document_id: uuid.UUID) -> DocumentVersion | None:
    return await db.scalar(
        select(DocumentVersion)
        .where(
            DocumentVersion.document_id == document_id,
            DocumentVersion.approved_at.is_not(None),
        )
        .order_by(DocumentVersion.number.desc())
        .limit(1)
    )


def on_prd(prd_document_id: Any) -> Any:
    """``ProductTrack`` rows holding the PRD (or any of the PRDs: a list or a select)."""
    prds = (
        TrackPrd.prd_document_id.in_(prd_document_id)
        if not isinstance(prd_document_id, uuid.UUID)
        else TrackPrd.prd_document_id == prd_document_id
    )
    return ProductTrack.id.in_(select(TrackPrd.track_id).where(prds, TrackPrd.state == "linked"))


async def track_of_prd(db: AsyncSession, prd_document_id: uuid.UUID) -> ProductTrack | None:
    return await db.scalar(select(ProductTrack).where(on_prd(prd_document_id)))


async def any_track_of_prd(db: AsyncSession, prd_document_id: uuid.UUID) -> ProductTrack | None:
    """The PRD's track, one in Trash too (removed-tracks): a PRD has one track, and one
    in Trash is restored from there, not started again."""
    from oracle.trash.filter import INCLUDE_TRASHED

    return await db.scalar(
        select(ProductTrack)
        .where(on_prd(prd_document_id))
        .execution_options(**{INCLUDE_TRASHED: True})
    )


async def tracks_of_prds(
    db: AsyncSession, prd_ids: Any, *, trashed: bool = False
) -> dict[uuid.UUID, ProductTrack]:
    """Each PRD's track, by PRD (``trashed``: one in Trash too)."""
    from oracle.trash.filter import INCLUDE_TRASHED

    query = select(ProductTrack).where(on_prd(prd_ids))
    if trashed:
        query = query.execution_options(**{INCLUDE_TRASHED: True})
    return {p: t for t in await db.scalars(query) for p in t.prd_ids}


async def lead_prd(db: AsyncSession, track: ProductTrack) -> uuid.UUID | None:
    """tracks-goal: the PRD a track follows now (its current version's), else its first."""
    following = await db.scalar(
        select(DocumentVersion.document_id).where(DocumentVersion.id == track.current_version_id)
    )
    return following if following in track.prd_ids else next(iter(track.prd_ids), None)


async def link_of(db: AsyncSession, prd_document_id: uuid.UUID) -> TrackPrd | None:
    return await db.scalar(select(TrackPrd).where(TrackPrd.prd_document_id == prd_document_id))


async def refresh(db: AsyncSession, *track_ids: uuid.UUID | None) -> None:
    """The tracks loaded in this session read their PRDs again."""
    from oracle.trash.filter import INCLUDE_TRASHED

    for track_id in {t for t in track_ids if t is not None}:
        track = await db.get(ProductTrack, track_id, execution_options={INCLUDE_TRASHED: True})
        if track is not None:
            await db.refresh(track, ["prd_links"])


async def set_link(
    db: AsyncSession,
    prd_document_id: uuid.UUID,
    track_id: uuid.UUID | None,
    state: str,
    suggested_track_id: uuid.UUID | None = None,
) -> TrackPrd:
    """Put the PRD on a track (``linked``), off one (``off``) or suggest one (``suggested``);
    the tracks it leaves and joins read it at once."""
    link = await link_of(db, prd_document_id)
    before = link.track_id if link else None
    if link is None:
        link = TrackPrd(prd_document_id=prd_document_id)
        db.add(link)
    elif before != track_id:
        # Joining a track: it reads last among the track's PRDs.
        link.created_at = func.now()
    link.track_id, link.state = track_id, state
    link.suggested_track_id = suggested_track_id
    await db.flush()
    await db.refresh(link, ["created_at"])
    await refresh(db, before, track_id)
    return link


async def link_prd(db: AsyncSession, track: ProductTrack, prd_document_id: uuid.UUID) -> None:
    """tracks-goal: the PRD joins the track (leaving its old one) as ``ensure_track`` starts
    one: the track takes the PRD's latest roadmap when it has none, and the PRD's linked
    issues with no track; it follows the PRD's latest approved version when it has none."""
    await set_link(db, prd_document_id, track.id, "linked")
    if track.roadmap_document_id is None:
        track.roadmap_document_id = await _latest_roadmap_of(db, prd_document_id)
    if track.current_version_id is None:
        version = await latest_approved(db, prd_document_id)
        track.current_version_id = version.id if version else None
        track.started_version_id = track.started_version_id or track.current_version_id
    await db.flush()
    await links.adopt(db, track, prd_document_id)


async def _number(db: AsyncSession, version_id: uuid.UUID | None) -> int:
    if version_id is None:
        return 0
    return (
        await db.scalar(select(DocumentVersion.number).where(DocumentVersion.id == version_id)) or 0
    )


async def _latest_roadmap_of(db: AsyncSession, prd_document_id: uuid.UUID) -> uuid.UUID | None:
    """The roadmap most recently built from any version of this PRD."""
    source = select(DocumentVersion.id).where(DocumentVersion.document_id == prd_document_id)
    return await db.scalar(
        select(DocumentVersion.document_id)
        .join(Document, Document.id == DocumentVersion.document_id)
        .where(Document.kind == "roadmap", DocumentVersion.source_version_id.in_(source))
        .order_by(DocumentVersion.created_at.desc())
        .limit(1)
    )


async def ensure_track(
    db: AsyncSession,
    prd: Document,
    version: DocumentVersion,
    *,
    actor: Principal | str | None,
    roadmap_document_id: uuid.UUID | None = None,
    cause: str,
) -> tuple[ProductTrack, bool]:
    """The PRD's track, started from ``version`` (an approved version) when it has none;
    an existing track follows a later approved version. Returns (track, created)."""
    if prd.kind != "prd":
        raise Invalid(f"'{prd.slug}' is a {prd.kind}: only a PRD starts a track")
    if version.document_id != prd.id:
        raise Invalid(f"that version is not a version of '{prd.slug}'")
    if version.approved_at is None:
        raise Invalid(f"version {version.number} of '{prd.slug}' is not approved")
    # One track per PRD: concurrent starts (a publish and a person) wait on the PRD row.
    await db.execute(select(Document.id).where(Document.id == prd.id).with_for_update())
    track = await any_track_of_prd(db, prd.id)
    created = track is None
    if track is None:
        track = ProductTrack(
            started_version_id=version.id,
            current_version_id=version.id,
            title=prd.title,
            status="active",
            created_by=actor.id if isinstance(actor, Principal) else None,
            roadmap_document_id=roadmap_document_id or await _latest_roadmap_of(db, prd.id),
        )
        db.add(track)
    else:
        if version.number > await _number(db, track.current_version_id):
            track.current_version_id = version.id
        if roadmap_document_id is not None and track.roadmap_document_id is None:
            track.roadmap_document_id = roadmap_document_id
    await db.flush()
    if created:
        await set_link(db, prd.id, track.id, "linked")
        # F7: issues linked to this PRD's items before it had a track join it.
        await links.adopt(db, track, prd.id)
        data = {"prd": prd.slug, "version": version.number, "cause": cause}
        if isinstance(actor, Principal):
            await audit.record(db, actor, "track.started", "product_track", track.id, data)
        else:
            db.add(
                AuditEvent(
                    actor=actor or "system",
                    action="track.started",
                    entity="product_track",
                    entity_id=track.id,
                    data=data,
                )
            )
        await db.flush()
    return track, created


def _words(text: str | None) -> set[str]:
    return {w for w in "".join(c if c.isalnum() else " " for c in (text or "").casefold()).split()
            if len(w) > 2}  # fmt: skip


async def best_track(db: AsyncSession, prd: Document) -> ProductTrack | None:
    """tracks-goal: the existing track that best fits a PRD with none: one tied to the goal
    the PRD mainly serves (or holding PRDs that mainly serve it), else the one whose name or
    PRDs share the most words with the PRD's title; none when nothing fits."""
    from oracle.baseline.goal_order import sort_goals
    from oracle.baseline.models import Entity
    from oracle.docs.prd_order import main_goals

    live = list(
        await db.scalars(
            select(ProductTrack)
            .where(ProductTrack.status != "closed")
            .order_by(ProductTrack.title, ProductTrack.id)
        )
    )
    if not live:
        return None
    goals = sort_goals(await db.scalars(select(Entity).where(Entity.type == "goal")))
    held = [p for t in live for p in t.prd_ids]
    mains = await main_goals(db, [prd.id, *held])
    if (rank := mains.get(prd.id)) is not None:
        goal = goals[rank].id
        for t in live:
            if t.goal_id == goal or any(mains.get(p) == rank for p in t.prd_ids):
                return t
    titles = (
        {d.id: d.title for d in await db.scalars(select(Document).where(Document.id.in_(held)))}
        if held
        else {}
    )
    want = _words(prd.title)
    scored = [
        (len(want & (_words(t.title) | {w for p in t.prd_ids for w in _words(titles.get(p))})), t)
        for t in live
    ]
    score, track = max(scored, key=lambda st: st[0])
    return track if score else None


async def auto_track(
    db: AsyncSession,
    prd: Document,
    version: DocumentVersion,
    *,
    roadmap_document_id: uuid.UUID | None = None,
) -> ProductTrack | None:
    """tracks-goal: what an accepted PRD version does to its track on its own: a PRD on a
    track advances it; a PRD a person took off a track, or one waiting on a suggestion, has
    none; a new PRD with no track gets Oracle's suggestion in its owner's Inbox (owner Nov 9:
    no track starts on its own)."""
    if prd.kind != "prd" or version.approved_at is None:
        return None
    await db.execute(select(Document.id).where(Document.id == prd.id).with_for_update())
    link = await link_of(db, prd.id)
    if link is None:
        best = await best_track(db, prd)
        await set_link(db, prd.id, None, "suggested", best.id if best else None)
        return None
    if link.state != "linked":
        return None
    track = await any_track_of_prd(db, prd.id)
    if track is None:
        return None
    if version.number > await _number(db, track.current_version_id):
        track.current_version_id = version.id
    if roadmap_document_id is not None and track.roadmap_document_id is None:
        track.roadmap_document_id = roadmap_document_id
    await db.flush()
    return track


async def track_for_roadmap(
    db: AsyncSession, roadmap_version: DocumentVersion, prd_version: DocumentVersion | None
) -> ProductTrack | None:
    """The track a roadmap version's items belong to: its PRD's, started if the PRD
    version is approved and the PRD has none."""
    if prd_version is None:
        return None
    prd = await db.get(Document, prd_version.document_id)
    if prd is None or prd.kind != "prd":
        return None
    track = await any_track_of_prd(db, prd.id)
    if track is not None and track.deleted_at is not None:
        # removed-tracks: a track in Trash takes no new items.
        return None
    if track is None and prd_version.approved_at is None:
        return None
    if prd_version.approved_at is None:
        if track.roadmap_document_id is None:
            track.roadmap_document_id = roadmap_version.document_id
        return track
    return await auto_track(db, prd, prd_version, roadmap_document_id=roadmap_version.document_id)


async def on_published(db: AsyncSession, event: Any) -> None:
    """``oracle.changes`` handler: a published PRD version advances its track (or has one
    suggested)."""
    if event.cause != "published" or event.subject_id is None:
        return
    version = await db.get(DocumentVersion, event.subject_id)
    if version is None or version.approved_at is None:
        return
    prd = await db.get(Document, version.document_id)
    if prd is None or prd.kind != "prd":
        return
    await auto_track(db, prd, version)


async def get_track(
    db: AsyncSession, track_id: uuid.UUID, *, for_update: bool = False
) -> ProductTrack:
    query = select(ProductTrack).where(ProductTrack.id == track_id)
    if for_update:
        query = query.with_for_update()
    track = await db.scalar(query)
    if track is None:
        raise NotFound("Track not found")
    return track


# --- milestones ------------------------------------------------------------------------


async def check_date(
    db: AsyncSession,
    track: ProductTrack,
    horizon: str,
    target_date: date | None,
    basis_ids: list[uuid.UUID],
    item_keys: list[str] | None = None,
) -> list[uuid.UUID]:
    """A milestone date stands only on verified bases recorded for this track's PRD that
    support exactly that date, and only in Now (O4). A basis limited to an item (or a
    tracker issue's items) supports a milestone only of those items. Returns the bases
    kept."""
    from oracle.roadmap import schedule

    if target_date is None:
        return list(dict.fromkeys(basis_ids))
    if horizon != "now":
        raise Invalid(f"dated milestones belong only in now (this one is in {horizon})")
    if not basis_ids:
        raise Invalid(
            "a dated milestone needs a verified estimate, capacity or commitment "
            "(basis_ids); Oracle never invents dates"
        )
    ids = list(dict.fromkeys(basis_ids))
    rows = {
        b.id: b for b in await db.scalars(select(ScheduleBasis).where(ScheduleBasis.id.in_(ids)))
    }
    scopes = {b.id: b for p in track.prd_ids for b in await schedule.verified_bases(db, p)}
    keys = set(item_keys or [])
    for basis_id in ids:
        basis = rows.get(basis_id)
        if basis is None:
            raise Invalid(f"schedule basis {basis_id} is unknown")
        if basis.status != "verified":
            raise Invalid(f"schedule basis {basis.reference} was withdrawn")
        if basis.prd_document_id not in track.prd_ids:
            raise Invalid(f"schedule basis {basis.reference} belongs to another track's PRD")
        if basis.supports_date != target_date:
            raise Invalid(
                f"schedule basis {basis.reference} supports {basis.supports_date}, "
                f"not {target_date}"
            )
        scope = scopes[basis_id].item_keys
        if scope is not None and not (keys and keys <= scope):
            raise Invalid(
                f"schedule basis {basis.reference} supports only "
                f"{', '.join(sorted(scope)) or 'no item yet'}; list only those items"
            )
    return ids


async def get_milestone(
    db: AsyncSession, milestone_id: uuid.UUID, *, for_update: bool = False
) -> TrackMilestone:
    query = select(TrackMilestone).where(TrackMilestone.id == milestone_id)
    if for_update:
        query = query.with_for_update()
    row = await db.scalar(query)
    if row is None:
        raise NotFound("Milestone not found")
    return row
