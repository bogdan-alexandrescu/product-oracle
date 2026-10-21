"""Sources, sync, uploads, items, snapshots and search (Lane B1).

Sources are owned (S3 revised): every route acts for the signed-in user, who sees and
syncs only their own sources and items. Another user's source or item is a 404. A run
token acting for its user never reads raw an item behind one of the user's intake
findings not shared in full (S6, ``oracle.intake.evidence.run_withheld``): the item is
left out of every list, count and search, and is a 404. Any run also reads in full text
the items a finding shared in full released (``oracle.intake.evidence.run_shared``, owner
2026-10-19), whoever owns them, unless an intake withholds them or they were deleted
upstream: ``/v1/source-items/{id}`` returns them and ``/v1/search`` finds them, as
``/v1/intakes/{id}/evidence`` does, only ever at the version sharing released (freeze
at sharing: what the finding cited when its author shared it).

Changing a source (adding, editing, deleting, pausing, syncing, uploading) also needs a
role that may change things (commenter or above): a viewer, or an MCP client granted
only ``oracle:read`` (which acts as a viewer), reads but cannot change sources.
"""

import uuid
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, File, HTTPException, Query, Response, UploadFile, status
from fastapi.responses import JSONResponse
from sqlalchemy import func, or_, select

from oracle.auth.deps import CurrentPrincipal, Principal, TenantDB
from oracle.authz import require_role
from oracle.sources import items, service, store, uploads
from oracle.sources import search as search_service
from oracle.sources import sync as sync_engine
from oracle.sources.models import ITEM_KINDS, SOURCE_KINDS, Snapshot, Source, SourceItemVersion
from oracle.sources.schemas import (
    ConnectionChoice,
    ItemDetail,
    ItemOut,
    SearchResults,
    SnapshotCreate,
    SnapshotOut,
    SourceCreate,
    SourceKindOut,
    SourceOut,
    SourcePatch,
    SyncResult,
    UploadResult,
)

router = APIRouter(prefix="/v1", tags=["sources"])

NOT_A_USER = "Sources belong to a user: sign in (API tokens do not act for a user yet)"
# Who may change a source: not a viewer, nor an MCP client limited to oracle:read.
SourceWriter = Annotated[Principal, Depends(require_role("commenter"))]


def _user(principal: Principal) -> uuid.UUID:
    if principal.kind != "user" or principal.user_id is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, NOT_A_USER)
    return principal.user_id


async def _withheld(db: TenantDB, principal: Principal) -> set[uuid.UUID]:
    """Items a run token may not read raw (empty for anyone else)."""
    from oracle.intake.evidence import run_withheld

    return await run_withheld(db, principal) or set()


def _shared(principal: Principal) -> items.RunReads | None:
    """A run's reads (``items.RunReads``): what it reads at the version a finding shared
    in full released, its user's own items included, and every item ever frozen, read
    only that way (None for anyone else)."""
    from oracle.intake.evidence import run_shared

    return run_shared(principal)


def _http(exc: Exception) -> HTTPException:
    if isinstance(exc, service.RateLimitedError):
        return HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            str(exc),
            headers={"Retry-After": str(exc.retry_after)},
        )
    if isinstance(exc, service.NotFoundError):
        return HTTPException(status.HTTP_404_NOT_FOUND, str(exc))
    if isinstance(exc, service.ConflictError | sync_engine.SyncRefused):
        return HTTPException(status.HTTP_409_CONFLICT, str(exc))
    return HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc))


_ERRORS = (
    service.NotFoundError,
    service.ConflictError,
    service.InvalidError,
    service.RateLimitedError,
    sync_engine.SyncRefused,
)


def _source_out(source: Source, count: int = 0) -> SourceOut:
    return SourceOut.model_validate(source).model_copy(
        update={
            "item_count": count,
            "connector_available": service.connector_available(source.kind),
        }
    )


async def _one_out(db: TenantDB, source: Source, principal: Principal) -> SourceOut:
    # Reload server-set columns (updated_at) the last flush expired.
    await db.refresh(source)
    counts = await service.item_counts(db, [source.id], await _withheld(db, principal))
    return _source_out(source, counts.get(source.id, 0))


async def _owned(db: TenantDB, principal: Principal, source_id: uuid.UUID) -> Source:
    try:
        return await service.get_source(db, _user(principal), source_id)
    except service.NotFoundError as e:
        raise _http(e) from e


# --- sources ----------------------------------------------------------------------


@router.get("/sources", response_model=list[SourceOut])
async def list_sources(principal: CurrentPrincipal, db: TenantDB) -> list[SourceOut]:
    sources = await service.list_sources(db, _user(principal))
    # A run counts only what it may list (S6).
    counts = await service.item_counts(db, [s.id for s in sources], await _withheld(db, principal))
    return [_source_out(s, counts.get(s.id, 0)) for s in sources]


@router.get("/sources/kinds", response_model=list[SourceKindOut])
async def list_source_kinds(principal: CurrentPrincipal, db: TenantDB) -> list[SourceKindOut]:
    """What the user can add: each kind, whether its connector is available, and the
    user's own connections it can sync with."""
    by_provider = await service.connection_choices(db, _user(principal))
    out = []
    for kind in SOURCE_KINDS:
        provider = service.KIND_PROVIDER[kind]
        conns = by_provider.get(provider, []) if provider else []
        out.append(
            SourceKindOut(
                kind=kind,
                provider=provider,
                connector_available=service.connector_available(kind),
                connections=[
                    ConnectionChoice(id=c.id, account_label=c.account_label, status=c.status)
                    for c in conns
                ],
            )
        )
    return out


@router.post(
    "/sources",
    response_model=SourceOut,
    status_code=status.HTTP_201_CREATED,
    responses={429: {"description": "The provider is rate limiting; retry after Retry-After"}},
)
async def create_source(body: SourceCreate, principal: SourceWriter, db: TenantDB) -> SourceOut:
    try:
        source = await service.create_source(
            db,
            _user(principal),
            kind=body.kind,
            name=body.name,
            connection_id=body.connection_id,
            config=body.config,
        )
    except _ERRORS as e:
        raise _http(e) from e
    return _source_out(source)


@router.get("/sources/{source_id}", response_model=SourceOut)
async def get_source(source_id: uuid.UUID, principal: CurrentPrincipal, db: TenantDB) -> SourceOut:
    return await _one_out(db, await _owned(db, principal, source_id), principal)


@router.patch(
    "/sources/{source_id}",
    response_model=SourceOut,
    responses={
        409: {
            "description": "base_version is not the source's config_version, or the name is "
            'taken: {"code": "source_changed", "message": ...} for the first'
        },
        429: {"description": "The provider is rate limiting; retry after Retry-After"},
    },
)
async def update_source(
    source_id: uuid.UUID, body: SourcePatch, principal: SourceWriter, db: TenantDB
) -> SourceOut | JSONResponse:
    source = await _owned(db, principal, source_id)
    try:
        source = await service.update_source(db, source, body.model_dump(exclude_unset=True))
    except service.StaleError as e:
        return JSONResponse({"code": e.code, "message": str(e)}, status.HTTP_409_CONFLICT)
    except _ERRORS as e:
        raise _http(e) from e
    return await _one_out(db, source, principal)


@router.delete("/sources/{source_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_source(source_id: uuid.UUID, principal: SourceWriter, db: TenantDB) -> Response:
    await service.delete_source(db, await _owned(db, principal, source_id), actor=principal)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/sources/{source_id}/pause", response_model=SourceOut)
async def pause_source(source_id: uuid.UUID, principal: SourceWriter, db: TenantDB) -> SourceOut:
    source = await service.set_paused(db, await _owned(db, principal, source_id), True)
    return await _one_out(db, source, principal)


@router.post("/sources/{source_id}/resume", response_model=SourceOut)
async def resume_source(source_id: uuid.UUID, principal: SourceWriter, db: TenantDB) -> SourceOut:
    source = await service.set_paused(db, await _owned(db, principal, source_id), False)
    return await _one_out(db, source, principal)


@router.post(
    "/sources/{source_id}/sync",
    response_model=SyncResult,
    responses={
        409: {"description": "Paused, or an upload source"},
        422: {"description": "No connector registered for the kind"},
    },
)
async def sync_source(source_id: uuid.UUID, principal: SourceWriter, db: TenantDB) -> SyncResult:
    """Run the connector now. A rejected credential puts the source in status error;
    a rate limit stops cleanly and the next sync resumes from the saved cursor."""
    source = await _owned(db, principal, source_id)
    try:
        stats = await sync_engine.sync_source(db, source)
    except _ERRORS as e:
        raise _http(e) from e
    return SyncResult(
        source_id=source.id,
        outcome=stats.outcome,  # type: ignore[arg-type]
        upserted=stats.upserted,
        versions_written=stats.versions_written,
        deleted=stats.deleted,
        checkpoints=stats.checkpoints,
        retry_after=stats.retry_after,
        error=stats.error,
        source=await _one_out(db, source, principal),
    )


@router.post(
    "/sources/{source_id}/uploads",
    response_model=UploadResult,
    status_code=status.HTTP_201_CREATED,
)
async def upload_files(
    source_id: uuid.UUID,
    principal: SourceWriter,
    db: TenantDB,
    files: Annotated[list[UploadFile], File(description=".md, .txt or .pdf files")],
) -> UploadResult:
    """Add files to an upload source; each becomes an item of kind ``file``. A file
    with the name of an earlier one is a new version of it when its content changed."""
    source = await _owned(db, principal, source_id)
    if source.kind != "upload":
        raise HTTPException(status.HTTP_409_CONFLICT, "Only upload sources take files")
    if source.status == "paused":
        raise HTTPException(status.HTTP_409_CONFLICT, "This source is paused: resume it first")
    events = []
    try:
        for f in files:
            data = await f.read(uploads.MAX_BYTES + 1)
            events.append(uploads.to_item(uploads.UploadedFile(f.filename or "", data)))
    except uploads.UploadError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(e)) from e

    item_ids, unchanged = [], []
    for event in events:
        item, written = await store.upsert_item(db, source, event)
        item_ids.append(item.id)
        if not written:
            unchanged.append(event.external_id)
    source.last_synced_at = func.now()
    source.last_error = None
    await db.commit()

    settings = await items.confidence_settings(db)
    ids = list(dict.fromkeys(item_ids))
    withheld = await _withheld(db, principal)
    found = await items.source_items(db, source, ids=ids, limit=len(ids), exclude=withheld)
    # A run reads a shared item as released, title included (S6, titles).
    rows = {r.item.id: r for r in await items.as_released(db, found, _shared(principal))}
    return UploadResult(
        # A run never reads back an item it may not read, even one it just rewrote.
        items=[ItemOut(**items.item_out(rows[i], settings)) for i in ids if i in rows],
        unchanged=unchanged,
    )


# --- items ------------------------------------------------------------------------


@router.get("/sources/{source_id}/items", response_model=list[ItemOut])
async def list_source_items(
    source_id: uuid.UUID,
    principal: CurrentPrincipal,
    db: TenantDB,
    include_deleted: bool = False,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> list[ItemOut]:
    """The source's items at their current versions. A run never lists a deleted item
    (``include_deleted`` is ignored) and reads a shared item at the version released,
    its title as shared (S6, owner 2026-10-19)."""
    source = await _owned(db, principal, source_id)
    shared = _shared(principal)
    # Left out and read as released before paging, so a run's pages are full.
    rows = await items.source_items(
        db, source, include_deleted=include_deleted and shared is None, limit=limit,
        offset=offset, exclude=await _withheld(db, principal), also=shared,
    )  # fmt: skip
    settings = await items.confidence_settings(db)
    return [ItemOut(**items.item_out(r, settings)) for r in rows]


@router.get("/source-items/{item_id}", response_model=ItemDetail)
async def get_source_item(
    item_id: uuid.UUID, principal: CurrentPrincipal, db: TenantDB
) -> ItemDetail:
    user_id = _user(principal)
    shared = _shared(principal)
    released = None
    if shared is not None:
        # A run reads a shared item at the version released only, never another
        # (S6, freeze at sharing), and nothing deleted upstream.
        frozen = shared.released.subquery()
        released = await db.scalar(select(frozen.c.version_id).where(frozen.c.item_id == item_id))
    if released is not None:
        row = await items.item_row(db, item_id, released)
    elif shared is not None and await db.scalar(
        select(shared.frozen.where(shared.frozen.selected_columns[0] == item_id).exists())
    ):
        # Ever frozen, not readable now (deleted upstream or withheld): never read as
        # the run's user's own item, as ``/v1/search`` never finds it.
        row = None
    else:
        row = await items.owned_item(db, user_id, item_id)
        if row is not None and principal.is_run and row.item.deleted_at is not None:
            row = None
        if row is not None and item_id in await _withheld(db, principal):
            row = None
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Item not found")
    versions = 1
    if released is None:
        versions = await db.scalar(
            select(func.count()).where(SourceItemVersion.item_id == row.item.id)
        )
    foreign = released is not None and user_id != await db.scalar(
        select(Source.owner_user_id).where(Source.id == row.item.source_id)
    )
    if released is not None:
        # Its user's own item too reads as at release (S6, freeze at sharing).
        row = items.ItemRow(row.item, row.version, row.source_kind, released=True)
    settings = await items.confidence_settings(db)
    return ItemDetail(
        **items.item_out(row, settings, foreign=foreign),
        content=row.version.content if row.version is not None else None,
        version_count=versions or 0,
    )


# --- snapshots --------------------------------------------------------------------


@router.post(
    "/snapshots",
    response_model=SnapshotOut,
    status_code=status.HTTP_201_CREATED,
    tags=["snapshots"],
)
async def create_snapshot(
    body: SnapshotCreate, principal: CurrentPrincipal, db: TenantDB
) -> SnapshotOut:
    """Pin a point in time: reads at a snapshot see each item's newest version fetched
    at or before ``as_of``."""
    user_id = _user(principal)
    snapshot = Snapshot(label=body.label, created_by=user_id)
    if body.as_of is not None:
        as_of = body.as_of if body.as_of.tzinfo else body.as_of.replace(tzinfo=UTC)
        if as_of > datetime.now(UTC):
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "as_of is in the future")
        snapshot.as_of = as_of
    else:
        snapshot.as_of = func.clock_timestamp()
    db.add(snapshot)
    await db.commit()
    await db.refresh(snapshot)
    return SnapshotOut.model_validate(snapshot)


@router.get("/snapshots", response_model=list[SnapshotOut], tags=["snapshots"])
async def list_snapshots(principal: CurrentPrincipal, db: TenantDB) -> list[SnapshotOut]:
    rows = await db.scalars(
        select(Snapshot)
        .where(Snapshot.created_by == _user(principal))
        .order_by(Snapshot.as_of.desc())
    )
    return [SnapshotOut.model_validate(s) for s in rows]


async def _snapshot(db: TenantDB, principal: Principal, snapshot_id: uuid.UUID) -> Snapshot:
    """A snapshot the user took, or the one a run they created is pinned to.

    A run started from someone else's intake reads the intake's snapshot (S4), taken by
    the intake's author; its creator (and the agents acting for them) may read it. The
    items they see are still their own (AUD-9), never the author's."""
    from oracle.runs.models import Run

    user_id = _user(principal)
    pinned_by_run = select(Run.snapshot_id).where(
        Run.created_by == user_id, Run.snapshot_id.is_not(None)
    )
    snapshot = await db.scalar(
        select(Snapshot).where(
            Snapshot.id == snapshot_id,
            or_(Snapshot.created_by == user_id, Snapshot.id.in_(pinned_by_run)),
        )
    )
    if snapshot is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Snapshot not found")
    return snapshot


@router.get("/snapshots/{snapshot_id}", response_model=SnapshotOut, tags=["snapshots"])
async def get_snapshot(
    snapshot_id: uuid.UUID, principal: CurrentPrincipal, db: TenantDB
) -> SnapshotOut:
    return SnapshotOut.model_validate(await _snapshot(db, principal, snapshot_id))


@router.get("/snapshots/{snapshot_id}/items", response_model=list[ItemOut], tags=["snapshots"])
async def list_snapshot_items(
    snapshot_id: uuid.UUID,
    principal: CurrentPrincipal,
    db: TenantDB,
    source: uuid.UUID | None = None,
) -> list[ItemOut]:
    """The user's items as they were at the snapshot (each at its pinned version). A run
    reads a shared item at the version released whatever the snapshot, its title as
    shared, and nothing deleted upstream (S6, owner 2026-10-19)."""
    snapshot = await _snapshot(db, principal, snapshot_id)
    rows = await items.items_as_of(
        db, _user(principal), snapshot.as_of, source_id=source,
        txn_snapshot=snapshot.txn_snapshot, also=_shared(principal),
    )  # fmt: skip
    withheld = await _withheld(db, principal)
    rows = [r for r in rows if r.item.id not in withheld]
    settings = await items.confidence_settings(db)
    return [ItemOut(**items.item_out(r, settings, now=snapshot.as_of)) for r in rows]


# --- search -----------------------------------------------------------------------


def _kinds(values: list[str] | None) -> list[str] | None:
    kinds = [k.strip() for v in values or [] for k in v.split(",") if k.strip()]
    unknown = sorted(set(kinds) - set(ITEM_KINDS))
    if unknown:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, f"Unknown item kind(s): {', '.join(unknown)}"
        )
    return kinds or None


@router.get("/search", response_model=SearchResults, tags=["search"])
async def search_sources(
    principal: CurrentPrincipal,
    db: TenantDB,
    q: Annotated[str, Query(min_length=1, max_length=500)],
    kinds: Annotated[
        list[str] | None, Query(description="Item kinds, repeated or comma-separated")
    ] = None,
    source: uuid.UUID | None = None,
    as_of: datetime | None = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
) -> SearchResults:
    """Search the user's own items (a run: also those a finding shared in full
    released). Ranked by relevance x confidence weight; ``as_of`` searches the versions
    pinned at that time, except a run's shared items: those are searched at the version
    sharing released only, whatever ``as_of`` says (S6, freeze at sharing)."""
    user_id = _user(principal)
    if as_of is not None and as_of.tzinfo is None:
        as_of = as_of.replace(tzinfo=UTC)
    hits = await search_service.search(
        db, user_id, q, kinds=_kinds(kinds), source_id=source, as_of=as_of, limit=limit,
        exclude=await _withheld(db, principal), also=_shared(principal),
    )  # fmt: skip
    return SearchResults(query=q, as_of=as_of, hits=hits)  # type: ignore[arg-type]
