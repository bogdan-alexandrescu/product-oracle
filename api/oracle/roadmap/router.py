"""Roadmap alignment and product track routes (CR-11, V2b).

Everyone reads (viewer+). Approvers and owners write: import a version's items, settle
item staleness, record tracker state and schedule bases (engineering leads too, A3),
start and edit tracks and milestones, monitor a track, start a roadmap run. Every route
is company-scoped; another company's id is a 404. MCP tools derive from these
operations. Run tokens reach none of them (their areas are not in oracle.mcp.scopes).

Importing this module registers two ``oracle.changes`` handlers: ``roadmap.items`` (store
a roadmap version's items; mark items traced to a changed PRD section or baseline item
potentially stale) after the trace lane's ``trace.mark_stale``, and
``roadmap.start_track`` (a published PRD starts its track).
"""

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, changes
from oracle.auth.deps import CurrentPrincipal, Principal, TenantDB
from oracle.auth.models import User
from oracle.authz import require_role
from oracle.docs import service as docs_service
from oracle.docs.models import Document, DocumentVersion
from oracle.docs.parser import DraftError
from oracle.members.leads import engineering_leads, may_verify_dates
from oracle.roadmap import changeset, schedule, staleness, tracker, tracks, views
from oracle.roadmap import items as items_mod
from oracle.roadmap.models import (
    ProductTrack,
    RoadmapItem,
    ScheduleBasis,
    TrackerRecord,
    TrackMilestone,
)
from oracle.roadmap.schemas import (
    AlignmentReport,
    BasisStatus,
    ChangeSetOut,
    ChangeSetPatch,
    ChangeSetStatus,
    ItemProblem,
    ItemsImport,
    ItemsImportOut,
    ItemStalenessAction,
    ItemStalenessOut,
    ItemView,
    MilestoneCreate,
    MilestoneOut,
    MilestonePatch,
    MonitorOut,
    RoadmapItemsOut,
    ScheduleBasisCreate,
    ScheduleBasisOut,
    ScheduleBasisWithdraw,
    TrackChange,
    TrackCreate,
    TrackerConnectorOut,
    TrackerImportOut,
    TrackerPlanEpic,
    TrackerPlanIssue,
    TrackerPlanOut,
    TrackerRecordOut,
    TrackerRecordsImport,
    TrackOverview,
    TrackPatch,
    TrackStatus,
    TrackSummary,
    WithdrawOut,
)
from oracle.runs import service as runs_service
from oracle.runs.schemas import KnobsIn, RunCreate, RunOut
from oracle.trace import router as _trace_router  # noqa: F401 - trace.mark_stale runs first

router = APIRouter(prefix="/v1", tags=["roadmaps"])

Reader = Annotated[Principal, Depends(require_role("viewer"))]
Approver = Annotated[Principal, Depends(require_role("approver"))]


async def date_verifier(principal: CurrentPrincipal, db: TenantDB) -> Principal:
    """Who records and withdraws a verified schedule basis (A3): approvers and owners (O4
    Roadmap shape), plus engineering leads, until F3 Date bases applies the owner's decided
    rule (oracle.members.leads.may_verify_dates)."""
    if not may_verify_dates(principal, await engineering_leads(db)):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "Requires the approver role or the engineering lead"
        )
    return principal


DateVerifier = Annotated[Principal, Depends(date_verifier)]

changes.register_handler(staleness.HANDLER, staleness.mark_items, subjects=staleness.SUBJECTS)
changes.register_handler("roadmap.start_track", tracks.on_published, subjects={"document_version"})


def _fail(exc: Exception) -> HTTPException:
    return HTTPException(getattr(exc, "status_code", 422), str(exc))


async def _document(db, doc: str, kind: str | None = None) -> Document:
    try:
        document = await docs_service.get_document_or_404(db, doc)
    except docs_service.NotFoundError as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(e)) from e
    if kind is not None and document.kind != kind:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f"'{document.slug}' is a {document.kind}, not a {kind}",
        )
    return document


async def _version(db, document: Document, n: int | None) -> DocumentVersion | None:
    version = await views.items_version(db, document, n)
    if n is not None and version is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, f"version {n} of '{document.slug}' not found"
        )
    return version


async def _track(db, track_id: uuid.UUID, *, for_update: bool = False) -> ProductTrack:
    try:
        return await tracks.get_track(db, track_id, for_update=for_update)
    except tracks.TrackError as e:
        raise _fail(e) from e


# --- roadmap items ---------------------------------------------------------------------------


@router.get("/roadmaps/{doc}/items", response_model=RoadmapItemsOut)
async def list_roadmap_items(
    doc: str,
    principal: Reader,
    db: TenantDB,
    version: Annotated[int | None, Query(ge=1)] = None,
    view: ItemView = "full",
) -> RoadmapItemsOut:
    """A roadmap version's items (default: the latest version with items), each traced to
    the exact PRD version, section, feature and requirements, with its blocker
    dependencies, validation gates, economics, freshness and engineering status. The
    brief view keeps the headline fields only."""
    document = await _document(db, doc, "roadmap")
    return await views.items_view(db, document, await _version(db, document, version), view)


@router.put("/roadmaps/{doc}/versions/{n}/items", response_model=ItemsImportOut)
async def import_roadmap_items(
    doc: str, n: int, body: ItemsImport, principal: Approver, db: TenantDB
) -> ItemsImportOut:
    """Store ``roadmap_items.yaml`` as a roadmap version's items (the file a
    ``prd_to_roadmap`` run writes), replacing any it had. Refused (422, with the
    problems) on any problem, a date without a verified basis included; an approved
    version's items cannot be replaced (409)."""
    document = await _document(db, doc, "roadmap")
    version = await _version(db, document, n)
    if version.source_version_id is None:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f"version {n} of '{document.slug}' was built from no PRD version: roadmap items "
            "trace to the approved PRD version a roadmap is built from (run prd_to_roadmap)",
        )
    if version.approved_at is not None:
        has = await db.scalar(
            select(RoadmapItem.id).where(RoadmapItem.roadmap_version_id == version.id).limit(1)
        )
        if has:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"version {n} is approved: its items are pinned; import a new version",
            )
    result = await items_mod.import_items(db, version, body.yaml, strict=True)
    if result.problems:
        await db.rollback()
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            {"message": "roadmap_items.yaml was refused", "problems": result.problems},
        )
    await audit.record(
        db,
        principal,
        "roadmap.items_imported",
        "document_version",
        version.id,
        {"roadmap": document.slug, "version": n, "items": len(result.items)},
    )
    await db.commit()
    out = await views.items_view(db, document, version, "full")
    return ItemsImportOut(
        **out.model_dump(),
        problems=[ItemProblem.model_validate(p) for p in result.problems],
        refused_dates=result.refused_dates,
    )


@router.post("/roadmaps/{doc}/items/staleness", response_model=ItemStalenessOut)
async def act_on_roadmap_item_staleness(
    doc: str, body: ItemStalenessAction, principal: Approver, db: TenantDB
) -> ItemStalenessOut:
    """Settle potentially stale items: ``review`` (under review) or ``reconcile`` (still
    valid, with a reason; re-anchored on the PRD's latest approved version). 409 when no
    item is in a state the action applies to."""
    document = await _document(db, doc, "roadmap")
    version = await _version(db, document, body.version)
    rows = await views.version_items(db, version)
    if body.item_keys:
        known = {i.item_key for i in rows}
        if unknown := [k for k in body.item_keys if k not in known]:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                f"not items of this version: {', '.join(unknown)}",
            )
        rows = [i for i in rows if i.item_key in set(body.item_keys)]
    try:
        changed = await staleness.act(db, principal, body.action, rows, body.reason)
    except staleness.Conflict as e:
        raise HTTPException(status.HTTP_409_CONFLICT, str(e)) from e
    except staleness.Invalid as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(e)) from e
    await db.commit()
    out = await views.items_view(db, document, version, "full")
    return ItemStalenessOut(changed=changed, items=out.items)


@router.get("/roadmaps/{doc}/alignment", response_model=AlignmentReport)
async def get_roadmap_alignment(
    doc: str,
    principal: Reader,
    db: TenantDB,
    version: Annotated[int | None, Query(ge=1)] = None,
) -> AlignmentReport:
    """The roadmap against the tracker's state, read-only (E1): per item aligned, drift
    (ahead, date slip, overdue, cancelled), untracked or done, and tracker work no item
    names. Works without any tracker write permission."""
    document = await _document(db, doc, "roadmap")
    return await views.alignment(db, document, await _version(db, document, version))


# --- change sets: edits to the approved plan, proposed as a new version (#346) ----------


async def _change_set(db, doc: str, set_id: uuid.UUID):
    document = await _document(db, doc, "roadmap")
    try:
        return document, await changeset.get(db, document, set_id)
    except changeset.ChangeSetError as e:
        raise _fail(e) from e


@router.post(
    "/roadmaps/{doc}/change-sets", response_model=ChangeSetOut, status_code=201,
    responses={200: {}},
)  # fmt: skip
async def open_roadmap_change_set(
    doc: str, principal: Approver, db: TenantDB, response: Response
) -> ChangeSetOut:
    """Edit plan: open a draft change set on the roadmap's approved version (201), or
    return the draft it has (200). Nobody edits an approved version in place: the changes
    are proposed as a new version. 422 when no version is approved."""
    document = await _document(db, doc, "roadmap")
    try:
        row, created = await changeset.open_set(db, principal, document)
    except changeset.ChangeSetError as e:
        raise _fail(e) from e
    await db.commit()
    if not created:
        response.status_code = status.HTTP_200_OK
    return await changeset.view(db, document, row)


@router.get("/roadmaps/{doc}/change-sets", response_model=list[ChangeSetOut])
async def list_roadmap_change_sets(
    doc: str,
    principal: Reader,
    db: TenantDB,
    status_: Annotated[ChangeSetStatus | None, Query(alias="status")] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> list[ChangeSetOut]:
    """The roadmap's change sets, newest first: the draft being edited, the proposals
    waiting for the decider (``approved`` false) and the rest. ``limit`` and ``offset``
    page through them."""
    document = await _document(db, doc, "roadmap")
    return [
        await changeset.view(db, document, row)
        for row in await changeset.list_sets(db, document, status_, limit, offset)
    ]


@router.get("/roadmaps/{doc}/change-sets/{set_id}", response_model=ChangeSetOut)
async def get_roadmap_change_set(
    doc: str, set_id: uuid.UUID, principal: Reader, db: TenantDB
) -> ChangeSetOut:
    """A change set: its changes, the plan they make, and the diff against the base."""
    document, row = await _change_set(db, doc, set_id)
    return await changeset.view(db, document, row)


@router.patch("/roadmaps/{doc}/change-sets/{set_id}", response_model=ChangeSetOut)
async def update_roadmap_change_set(
    doc: str, set_id: uuid.UUID, body: ChangeSetPatch, principal: Approver, db: TenantDB
) -> ChangeSetOut:
    """Replace a draft change set's changes (in order): add, move, defer, cut with a
    reason, reorder within a horizon. 422 when a change does not apply; 409 when it
    changed since it was loaded, is no longer a draft, or its base is no longer the
    approved version."""
    document, row = await _change_set(db, doc, set_id)
    try:
        await changeset.update(db, principal, document, row, body.changes, body.lock_version)
    except changeset.ChangeSetError as e:
        raise _fail(e) from e
    await db.commit()
    return await changeset.view(db, document, row)


@router.delete("/roadmaps/{doc}/change-sets/{set_id}", response_model=ChangeSetOut)
async def discard_roadmap_change_set(
    doc: str, set_id: uuid.UUID, principal: Approver, db: TenantDB
) -> ChangeSetOut:
    """Discard a draft change set: the approved plan stays as it is."""
    document, row = await _change_set(db, doc, set_id)
    try:
        await changeset.discard(db, principal, document, row)
    except changeset.ChangeSetError as e:
        raise _fail(e) from e
    await db.commit()
    return await changeset.view(db, document, row)


@router.post("/roadmaps/{doc}/change-sets/{set_id}/propose", response_model=ChangeSetOut)
async def propose_roadmap_change_set(
    doc: str, set_id: uuid.UUID, principal: Approver, db: TenantDB
) -> ChangeSetOut:
    """Propose changes: import the next roadmap version (the base's items plus the
    changes), for the document's decider to approve through the review. 409 on a stale
    base; 422 when there is nothing to propose."""
    document, row = await _change_set(db, doc, set_id)
    try:
        await changeset.propose(db, principal, document, row)
    except changeset.ChangeSetError as e:
        await db.rollback()
        raise _fail(e) from e
    except DraftError as e:
        await db.rollback()
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(e)) from e
    await db.commit()
    return await changeset.view(db, document, await changeset.get(db, document, set_id))


# --- schedule bases (O4: never an invented date) ---------------------------------------------


@router.get("/schedule-bases", response_model=list[ScheduleBasisOut])
async def list_schedule_bases(
    principal: Reader,
    db: TenantDB,
    prd: str | None = None,
    status_: Annotated[BasisStatus | None, Query(alias="status")] = None,
) -> list[ScheduleBasis]:
    query = select(ScheduleBasis).order_by(ScheduleBasis.supports_date, ScheduleBasis.reference)
    if prd is not None:
        document = await _document(db, prd, "prd")
        query = query.where(ScheduleBasis.prd_document_id == document.id)
    if status_ is not None:
        query = query.where(ScheduleBasis.status == status_)
    return list(await db.scalars(query))


async def _record_is_prds(db, record: TrackerRecord, prd: Document) -> bool:
    """Whether a track-less tracker record is matched to a roadmap item of this PRD."""
    if not record.item_key:
        return False
    found = await db.scalar(
        select(RoadmapItem.id)
        .where(RoadmapItem.prd_document_id == prd.id, RoadmapItem.item_key == record.item_key)
        .limit(1)
    )
    return found is not None


@router.post("/schedule-bases", response_model=ScheduleBasisOut, status_code=201)
async def create_schedule_basis(
    body: ScheduleBasisCreate, principal: DateVerifier, db: TenantDB
) -> ScheduleBasis:
    """Record a verified estimate, capacity figure or commitment supporting a date for
    one PRD's roadmap items (O4), optionally only one item (``item_key``) or the items a
    tracker issue is matched to (``tracker_key``). The approver or engineering lead
    recording it verifies it.
    From a tracker record, the record's own target date must be that date, and the record
    must be this PRD's."""
    prd = await _document(db, body.prd, "prd")
    tracker_key = body.tracker_key.strip() if body.tracker_key else None
    if body.tracker_record_id is not None:
        record = await db.get(TrackerRecord, body.tracker_record_id)
        if record is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Tracker record not found")
        if record.target_date != body.supports_date:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                f"tracker record {record.external_ref} targets {record.target_date}, "
                f"not {body.supports_date}",
            )
        if tracker_key is not None and tracker_key != record.external_ref:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                f"tracker_key {tracker_key} is not the record's issue {record.external_ref}",
            )
        track = await db.get(ProductTrack, record.track_id) if record.track_id else None
        if track is not None and track.prd_document_id != prd.id:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                f"tracker record {record.external_ref} belongs to another PRD's track",
            )
        if track is None and not await _record_is_prds(db, record, prd):
            # On no track: only an item of this PRD's roadmap ties the record to it.
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                f"tracker record {record.external_ref} is on no track and matched to no "
                f"roadmap item of {prd.slug}; match it to this PRD's track first",
            )
    row = ScheduleBasis(
        kind=body.kind,
        reference=body.reference.strip(),
        supports_date=body.supports_date,
        detail=body.detail,
        prd_document_id=prd.id,
        item_key=body.item_key.strip() if body.item_key else None,
        tracker_key=tracker_key,
        tracker_record_id=body.tracker_record_id,
        status="verified",
        verified_by=principal.id,
        verified_at=schedule.now(),
    )
    db.add(row)
    await db.flush()
    await audit.record(
        db,
        principal,
        "schedule_basis.verified",
        "schedule_basis",
        row.id,
        {
            "kind": row.kind,
            "reference": row.reference,
            "supports_date": str(row.supports_date),
            "prd": prd.slug,
            "item_key": row.item_key,
            "tracker_key": row.tracker_key,
        },
    )
    await db.commit()
    await db.refresh(row)
    return row


@router.post("/schedule-bases/{basis_id}/withdraw", response_model=WithdrawOut)
async def withdraw_schedule_basis(
    basis_id: uuid.UUID, body: ScheduleBasisWithdraw, principal: DateVerifier, db: TenantDB
) -> WithdrawOut:
    """Withdraw a basis: it supports nothing from now on. Milestones lose a date no other
    verified basis supports, and roadmap items whose date rested on it go potentially
    stale. 409 when already withdrawn."""
    row = await db.scalar(
        select(ScheduleBasis).where(ScheduleBasis.id == basis_id).with_for_update()
    )
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Schedule basis not found")
    if row.status == "withdrawn":
        raise HTTPException(status.HTTP_409_CONFLICT, "This schedule basis is already withdrawn")
    undated, stale = await schedule.withdraw(db, principal, row, body.reason)
    await db.commit()
    await db.refresh(row)
    return WithdrawOut(
        basis=ScheduleBasisOut.model_validate(row), undated_milestones=undated, stale_items=stale
    )


# --- tracker (read-only) ----------------------------------------------------------------------


@router.get("/tracker/connector", response_model=TrackerConnectorOut)
async def get_tracker_connector(principal: Reader) -> TrackerConnectorOut:
    """The two-way tracker connector's gate: off, so Oracle makes no tracker writes."""
    return tracker.connector()


@router.get("/tracker/records", response_model=list[TrackerRecordOut])
async def list_tracker_records(
    principal: Reader,
    db: TenantDB,
    track_id: uuid.UUID | None = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 200,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> list[TrackerRecord]:
    query = select(TrackerRecord).order_by(TrackerRecord.tracker, TrackerRecord.external_ref)
    if track_id is not None:
        query = query.where(TrackerRecord.track_id == track_id)
    return list(await db.scalars(query.limit(limit).offset(offset)))


@router.post("/tracker/records", response_model=TrackerImportOut)
async def import_tracker_records(
    body: TrackerRecordsImport, principal: Approver, db: TenantDB
) -> TrackerImportOut:
    """Record engineering status read from a tracker (latest state per issue). Read-only
    toward the tracker: Oracle stores what was read and writes nothing back. The tracks
    the records belong to are monitored again."""
    try:
        created, updated, rows = await tracker.import_records(
            db, principal, body.tracker, body.records
        )
    except tracker.TrackerError as e:
        raise _fail(e) from e
    for track_id in {r.track_id for r in rows if r.track_id}:
        await views.monitor(db, await tracks.get_track(db, track_id), principal)
    await db.commit()
    for r in rows:
        await db.refresh(r)
    return TrackerImportOut(
        created=created,
        updated=updated,
        records=[TrackerRecordOut.model_validate(r) for r in rows],
    )


# --- product tracks ---------------------------------------------------------------------------


@router.get("/tracks", response_model=list[TrackSummary])
async def list_tracks(
    principal: Reader,
    db: TenantDB,
    status_: Annotated[TrackStatus | None, Query(alias="status")] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> list[TrackSummary]:
    """Product tracks, newest first, each with its health and a one-line headline."""
    query = select(ProductTrack).order_by(ProductTrack.created_at.desc(), ProductTrack.id)
    if status_ is not None:
        query = query.where(ProductTrack.status == status_)
    rows = await db.scalars(query.limit(limit).offset(offset))
    return [await views.summary(db, t) for t in list(rows)]


@router.post("/tracks", response_model=TrackOverview, status_code=201, responses={200: {}})
async def create_track(
    body: TrackCreate, principal: Approver, db: TenantDB, response: Response
) -> TrackOverview:
    """Start the track of an accepted PRD (its latest approved version; approving a PRD
    version starts it too). A PRD has one track: 409 when it already has one; 200 with
    that track when a concurrent start made it first."""
    prd = await _document(db, body.prd, "prd")
    if await tracks.track_of_prd(db, prd.id) is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, f"'{prd.slug}' already has a track")
    version = await tracks.latest_approved(db, prd.id)
    if version is None:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f"'{prd.slug}' has no approved version: a track starts from an accepted PRD",
        )
    track, created = await tracks.ensure_track(db, prd, version, actor=principal, cause="started")
    if not created:
        # A concurrent start (a publish, another person) made it first: that one stands.
        await db.commit()
        response.status_code = status.HTTP_200_OK
        return await views.overview(db, track)
    if body.title:
        track.title = body.title
    await db.commit()
    return await views.overview(db, track)


@router.get("/tracks/{track_id}", response_model=TrackOverview)
async def get_track(track_id: uuid.UUID, principal: Reader, db: TenantDB) -> TrackOverview:
    """The track's overview: health, headline, the next milestone, items at risk
    (blocked, stale or slipping), drift from engineering status where known, and
    whether the PRD moved on since the roadmap was built."""
    return await views.overview(db, await _track(db, track_id))


async def _is_disabled(db: AsyncSession, member: User) -> bool:
    """Whether a member is disabled (``users.disabled_at`` set, PR #69's member disable),
    whichever lands first: the column read from the database when it exists there, even
    before this code's User model maps it; the model's attribute when it does."""
    if getattr(member, "disabled_at", None) is not None:
        return True
    if "disabled_at" in User.__table__.c:
        return False
    exists = await db.scalar(
        text(
            "SELECT EXISTS (SELECT 1 FROM information_schema.columns "
            "WHERE table_schema = current_schema() AND table_name = 'users' "
            "AND column_name = 'disabled_at')"
        )
    )
    if not exists:
        return False
    return bool(
        await db.scalar(
            text("SELECT disabled_at IS NOT NULL FROM users WHERE id = :id"), {"id": member.id}
        )
    )


@router.patch("/tracks/{track_id}", response_model=TrackOverview)
async def update_track(
    track_id: uuid.UUID, body: TrackPatch, principal: Approver, db: TenantDB
) -> TrackOverview:
    track = await _track(db, track_id, for_update=True)
    if body.lock_version != track.lock_version:
        raise HTTPException(status.HTTP_409_CONFLICT, "The track changed since it was loaded")
    fields = body.model_dump(exclude_unset=True, exclude={"lock_version"})
    if nulls := [k for k in ("title", "status") if k in fields and fields[k] is None]:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, f"{', '.join(nulls)} cannot be cleared"
        )
    if fields.get("owner_id") is not None:
        member = await db.scalar(select(User).where(User.id == fields["owner_id"]))
        if member is None:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                "owner_id is not a member of this company",
            )
        # A disabled member (users.disabled_at, the member disable of PR #69) owns
        # nothing new.
        if await _is_disabled(db, member):
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, "owner_id is a disabled member"
            )
    before = {k: getattr(track, k) for k in fields}
    for k, v in fields.items():
        setattr(track, k, v)
    track.lock_version += 1
    await audit.record(
        db,
        principal,
        "track.updated",
        "product_track",
        track.id,
        {"before": {k: str(v) if v is not None else None for k, v in before.items()},
         "after": {k: str(v) if v is not None else None for k, v in fields.items()}},
    )  # fmt: skip
    await db.commit()
    return await views.overview(db, track)


@router.post("/tracks/{track_id}/monitor", response_model=MonitorOut)
async def monitor_track(track_id: uuid.UUID, principal: Approver, db: TenantDB) -> MonitorOut:
    """Check the track now: a ``product_track`` change event is recorded when its health,
    its items at risk or its next milestone changed since the last check."""
    track = await _track(db, track_id, for_update=True)
    overview, event_id, changed = await views.monitor(db, track, principal)
    await db.commit()
    return MonitorOut(overview=overview, change_event_id=event_id, changed=changed)


@router.get("/tracks/{track_id}/changes", response_model=list[TrackChange])
async def list_track_changes(
    track_id: uuid.UUID,
    principal: Reader,
    db: TenantDB,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> list[TrackChange]:
    """The track's monitoring change events, newest first."""
    from oracle.v2.models import ChangeEvent

    await _track(db, track_id)
    rows = await db.scalars(
        select(ChangeEvent)
        .where(ChangeEvent.subject_kind == "product_track", ChangeEvent.subject_id == track_id)
        .order_by(ChangeEvent.created_at.desc(), ChangeEvent.id)
        .limit(limit)
    )
    return [
        TrackChange(
            id=e.id, cause=e.cause, actor=e.actor, data=e.data or {}, created_at=e.created_at
        )
        for e in rows
    ]


@router.post("/tracks/{track_id}/roadmap-run", response_model=RunOut, status_code=201)
async def create_track_roadmap_run(
    track_id: uuid.UUID, principal: Approver, db: TenantDB, body: KnobsIn | None = None
) -> RunOut:
    """Draft a ``prd_to_roadmap`` run (SwarmCloud) from the track's latest approved PRD
    version into its roadmap. Nothing runs or is spent until it is estimated and started
    (the $50 owner approval and the 1.5x pause apply as for every run)."""
    track = await _track(db, track_id)
    prd = await db.get(Document, track.prd_document_id)
    roadmap = (
        await db.get(Document, track.roadmap_document_id) if track.roadmap_document_id else None
    )
    create = RunCreate(
        flow="prd_to_roadmap",
        source=prd.slug,
        document=roadmap.slug if roadmap else None,
        knobs=body or KnobsIn(),
    )
    try:
        run_id = await runs_service.create_run(db, principal, create)
    except runs_service.RunError as e:
        raise HTTPException(e.status, str(e)) from e
    return await runs_service.read_run(db, run_id, principal)


@router.get("/tracks/{track_id}/tracker-plan", response_model=TrackerPlanOut)
async def get_track_tracker_plan(
    track_id: uuid.UUID, principal: Reader, db: TenantDB
) -> TrackerPlanOut:
    """What a two-way tracker connector would create from the roadmap (an epic per Now
    and Next item, an issue per requirement): a preview, never written."""
    track = await _track(db, track_id)
    roadmap = (
        await db.get(Document, track.roadmap_document_id) if track.roadmap_document_id else None
    )
    version = await views.items_version(db, roadmap, approved_first=True) if roadmap else None
    items = await views.items_view(db, roadmap, version, "full") if roadmap else None
    epics = []
    for item in items.items if items else []:
        if item.horizon == "later":
            continue
        epics.append(
            TrackerPlanEpic(
                item_key=item.item_key,
                title=item.title,
                horizon=item.horizon,
                description=item.outcome,
                prd_link=item.prd.link,
                issues=[
                    TrackerPlanIssue(title=r.title, requirement_key=r.key)
                    for r in item.requirements
                ],
            )
        )
    return TrackerPlanOut(track_id=track.id, connector=tracker.connector(), epics=epics)


@router.post("/tracks/{track_id}/tracker-push", status_code=202, responses={409: {}, 501: {}})
async def push_track_to_tracker(track_id: uuid.UUID, principal: Approver, db: TenantDB) -> None:
    """Write the tracker plan to Linear or Jira. Refused: two-way sync is off (409), or
    on but no connector is verified (501). Oracle makes no unattended external writes."""
    await _track(db, track_id)
    try:
        tracker.refuse_push()
    except tracker.TrackerError as e:
        raise _fail(e) from e


# --- milestones -------------------------------------------------------------------------------


@router.get("/tracks/{track_id}/milestones", response_model=list[MilestoneOut])
async def list_track_milestones(
    track_id: uuid.UUID, principal: Reader, db: TenantDB
) -> list[TrackMilestone]:
    await _track(db, track_id)
    return await views.milestones_of(db, track_id)


@router.post("/tracks/{track_id}/milestones", response_model=MilestoneOut, status_code=201)
async def create_track_milestone(
    track_id: uuid.UUID, body: MilestoneCreate, principal: Approver, db: TenantDB
) -> TrackMilestone:
    """Add a milestone. Undated by default; a date only in Now and only with verified
    schedule bases that support exactly that date (422 otherwise)."""
    track = await _track(db, track_id)
    try:
        bases = await tracks.check_date(
            db, track, body.horizon, body.target_date, body.basis_ids, body.item_keys
        )
    except tracks.TrackError as e:
        raise _fail(e) from e
    exists = await db.scalar(
        select(TrackMilestone.id).where(
            TrackMilestone.track_id == track.id, TrackMilestone.name == body.name
        )
    )
    if exists:
        raise HTTPException(
            status.HTTP_409_CONFLICT, f"the track already has a milestone {body.name!r}"
        )
    row = TrackMilestone(
        track_id=track.id,
        name=body.name,
        horizon=body.horizon,
        target_date=body.target_date,
        basis_ids=bases,
        item_keys=list(dict.fromkeys(body.item_keys)),
        created_by=principal.id,
    )
    db.add(row)
    await db.flush()
    await audit.record(
        db,
        principal,
        "milestone.created",
        "track_milestone",
        row.id,
        {"track_id": str(track.id), "name": row.name, "target_date": str(row.target_date)
         if row.target_date else None, "basis_ids": [str(b) for b in bases]},
    )  # fmt: skip
    await db.commit()
    await db.refresh(row)
    return row


@router.patch("/milestones/{milestone_id}", response_model=MilestoneOut)
async def update_milestone(
    milestone_id: uuid.UUID, body: MilestonePatch, principal: Approver, db: TenantDB
) -> TrackMilestone:
    """Edit a milestone. Setting or keeping a date re-checks its verified bases."""
    try:
        row = await tracks.get_milestone(db, milestone_id, for_update=True)
    except tracks.TrackError as e:
        raise _fail(e) from e
    if body.lock_version != row.lock_version:
        raise HTTPException(status.HTTP_409_CONFLICT, "The milestone changed since it was loaded")
    fields = body.model_dump(exclude_unset=True, exclude={"lock_version"})
    if nulls := [k for k in ("name", "horizon", "status") if k in fields and fields[k] is None]:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, f"{', '.join(nulls)} cannot be cleared"
        )
    if fields.get("name") and fields["name"] != row.name:
        taken = await db.scalar(
            select(TrackMilestone.id).where(
                TrackMilestone.track_id == row.track_id, TrackMilestone.name == fields["name"]
            )
        )
        if taken:
            raise HTTPException(
                status.HTTP_409_CONFLICT, f"the track already has a milestone {fields['name']!r}"
            )
    horizon = fields.get("horizon", row.horizon)
    target = fields["target_date"] if "target_date" in fields else row.target_date
    basis_ids = fields["basis_ids"] if fields.get("basis_ids") is not None else row.basis_ids
    item_keys = fields["item_keys"] if fields.get("item_keys") is not None else row.item_keys
    track = await _track(db, row.track_id)
    try:
        basis_ids = await tracks.check_date(
            db, track, horizon, target, list(basis_ids or []), list(item_keys or [])
        )
    except tracks.TrackError as e:
        raise _fail(e) from e
    before = {"target_date": str(row.target_date) if row.target_date else None,
              "horizon": row.horizon, "status": row.status}  # fmt: skip
    if "name" in fields and fields["name"] is not None:
        row.name = fields["name"]
    if fields.get("item_keys") is not None:
        row.item_keys = list(dict.fromkeys(fields["item_keys"]))
    if fields.get("status") is not None:
        row.status = fields["status"]
    row.horizon = horizon
    row.target_date = target
    row.basis_ids = basis_ids
    await db.flush()
    await audit.record(
        db,
        principal,
        "milestone.updated",
        "track_milestone",
        row.id,
        {"before": before, "after": {"target_date": str(target) if target else None,
                                     "horizon": horizon, "status": row.status}},
    )  # fmt: skip
    await db.commit()
    await db.refresh(row)
    return row
