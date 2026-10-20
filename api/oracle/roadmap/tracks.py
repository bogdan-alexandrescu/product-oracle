"""Product tracks (V2b): an accepted PRD starts a track, which follows its roadmap.

A track is started:

- by the review lane's publish transaction, through ``oracle.changes`` (a
  ``document_version`` change with cause ``published``; :func:`on_published`);
- when a roadmap's items are stored from an approved PRD version (a ``prd_to_roadmap``
  run reads only approved versions), so tracks exist on today's approve flow too;
- by a person (``POST /v1/tracks``) from a PRD with an approved version.

One track per PRD. It follows the PRD's latest approved version (``current_version_id``)
and the roadmap built from it. Milestones are undated by default (Now/Next/Later, O4); a
date needs verified schedule bases that support exactly that date, and only in Now.
"""

import uuid
from datetime import date
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.auth.deps import Principal
from oracle.docs.models import Document, DocumentVersion
from oracle.models import AuditEvent
from oracle.roadmap.models import ProductTrack, ScheduleBasis, TrackMilestone


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


async def track_of_prd(db: AsyncSession, prd_document_id: uuid.UUID) -> ProductTrack | None:
    return await db.scalar(
        select(ProductTrack).where(ProductTrack.prd_document_id == prd_document_id)
    )


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
    if version.approved_at is None:
        raise Invalid(f"version {version.number} of '{prd.slug}' is not approved")
    # One track per PRD: concurrent starts (a publish and a person) wait on the PRD row.
    await db.execute(select(Document.id).where(Document.id == prd.id).with_for_update())
    track = await track_of_prd(db, prd.id)
    created = track is None
    if track is None:
        track = ProductTrack(
            prd_document_id=prd.id,
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


async def track_for_roadmap(
    db: AsyncSession, roadmap_version: DocumentVersion, prd_version: DocumentVersion | None
) -> ProductTrack | None:
    """The track a roadmap version's items belong to: its PRD's, started if the PRD
    version is approved and the PRD has none."""
    if prd_version is None:
        return None
    prd = await db.get(Document, prd_version.document_id)
    if prd is None:
        return None
    track = await track_of_prd(db, prd.id)
    if track is None and prd_version.approved_at is None:
        return None
    if prd_version.approved_at is None:
        if track.roadmap_document_id is None:
            track.roadmap_document_id = roadmap_version.document_id
        return track
    track, _ = await ensure_track(
        db,
        prd,
        prd_version,
        actor="system",
        roadmap_document_id=roadmap_version.document_id,
        cause="roadmap_items",
    )
    return track


async def on_published(db: AsyncSession, event: Any) -> None:
    """``oracle.changes`` handler: a published PRD version starts (or advances) its track."""
    if event.cause != "published" or event.subject_id is None:
        return
    version = await db.get(DocumentVersion, event.subject_id)
    if version is None or version.approved_at is None:
        return
    prd = await db.get(Document, version.document_id)
    if prd is None or prd.kind != "prd":
        return
    await ensure_track(db, prd, version, actor=event.actor, cause="published")


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
) -> list[uuid.UUID]:
    """A milestone date stands only on verified bases of this company that support
    exactly that date, and only in Now (O4). Returns the bases kept."""
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
    for basis_id in ids:
        basis = rows.get(basis_id)
        if basis is None:
            raise Invalid(f"schedule basis {basis_id} is unknown")
        if basis.status != "verified":
            raise Invalid(f"schedule basis {basis.reference} was withdrawn")
        if basis.prd_document_id not in (None, track.prd_document_id):
            raise Invalid(f"schedule basis {basis.reference} belongs to another PRD")
        if basis.supports_date != target_date:
            raise Invalid(
                f"schedule basis {basis.reference} supports {basis.supports_date}, "
                f"not {target_date}"
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
