"""Sources, sync, uploads, items, snapshots and search (Lane B1).

Sources are owned (S3 revised): every route acts for the signed-in user, who sees and
syncs only their own sources and items. Another user's source or item is a 404.
"""

import uuid
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, File, HTTPException, Query, Response, UploadFile, status
from sqlalchemy import func, select

from oracle.auth.deps import CurrentPrincipal, Principal, TenantDB
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


def _user(principal: Principal) -> uuid.UUID:
    if principal.kind != "user" or principal.user_id is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, NOT_A_USER)
    return principal.user_id


def _http(exc: Exception) -> HTTPException:
    if isinstance(exc, service.NotFoundError):
        return HTTPException(status.HTTP_404_NOT_FOUND, str(exc))
    if isinstance(exc, service.ConflictError | sync_engine.SyncRefused):
        return HTTPException(status.HTTP_409_CONFLICT, str(exc))
    return HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc))


_ERRORS = (
    service.NotFoundError,
    service.ConflictError,
    service.InvalidError,
    sync_engine.SyncRefused,
)


def _source_out(source: Source, count: int = 0) -> SourceOut:
    return SourceOut.model_validate(source).model_copy(
        update={
            "item_count": count,
            "connector_available": service.connector_available(source.kind),
        }
    )


async def _one_out(db: TenantDB, source: Source) -> SourceOut:
    # Reload server-set columns (updated_at) the last flush expired.
    await db.refresh(source)
    counts = await service.item_counts(db, [source.id])
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
    counts = await service.item_counts(db, [s.id for s in sources])
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


@router.post("/sources", response_model=SourceOut, status_code=status.HTTP_201_CREATED)
async def create_source(body: SourceCreate, principal: CurrentPrincipal, db: TenantDB) -> SourceOut:
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
    return await _one_out(db, await _owned(db, principal, source_id))


@router.patch("/sources/{source_id}", response_model=SourceOut)
async def update_source(
    source_id: uuid.UUID, body: SourcePatch, principal: CurrentPrincipal, db: TenantDB
) -> SourceOut:
    source = await _owned(db, principal, source_id)
    try:
        source = await service.update_source(db, source, body.model_dump(exclude_unset=True))
    except _ERRORS as e:
        raise _http(e) from e
    return await _one_out(db, source)


@router.delete("/sources/{source_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_source(
    source_id: uuid.UUID, principal: CurrentPrincipal, db: TenantDB
) -> Response:
    await service.delete_source(db, await _owned(db, principal, source_id), actor=principal)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/sources/{source_id}/pause", response_model=SourceOut)
async def pause_source(
    source_id: uuid.UUID, principal: CurrentPrincipal, db: TenantDB
) -> SourceOut:
    source = await service.set_paused(db, await _owned(db, principal, source_id), True)
    return await _one_out(db, source)


@router.post("/sources/{source_id}/resume", response_model=SourceOut)
async def resume_source(
    source_id: uuid.UUID, principal: CurrentPrincipal, db: TenantDB
) -> SourceOut:
    source = await service.set_paused(db, await _owned(db, principal, source_id), False)
    return await _one_out(db, source)


@router.post(
    "/sources/{source_id}/sync",
    response_model=SyncResult,
    responses={
        409: {"description": "Paused, or an upload source"},
        422: {"description": "No connector registered for the kind"},
    },
)
async def sync_source(
    source_id: uuid.UUID, principal: CurrentPrincipal, db: TenantDB
) -> SyncResult:
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
        source=await _one_out(db, source),
    )


@router.post(
    "/sources/{source_id}/uploads",
    response_model=UploadResult,
    status_code=status.HTTP_201_CREATED,
)
async def upload_files(
    source_id: uuid.UUID,
    principal: CurrentPrincipal,
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
    rows = {r.item.id: r for r in await items.source_items(db, source, ids=ids, limit=len(ids))}
    return UploadResult(
        items=[ItemOut(**items.item_out(rows[i], settings)) for i in ids],
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
    source = await _owned(db, principal, source_id)
    rows = await items.source_items(
        db, source, include_deleted=include_deleted, limit=limit, offset=offset
    )
    settings = await items.confidence_settings(db)
    return [ItemOut(**items.item_out(r, settings)) for r in rows]


@router.get("/source-items/{item_id}", response_model=ItemDetail)
async def get_source_item(
    item_id: uuid.UUID, principal: CurrentPrincipal, db: TenantDB
) -> ItemDetail:
    row = await items.owned_item(db, _user(principal), item_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Item not found")
    versions = await db.scalar(select(func.count()).where(SourceItemVersion.item_id == row.item.id))
    settings = await items.confidence_settings(db)
    return ItemDetail(
        **items.item_out(row, settings),
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
    snapshot = await db.scalar(
        select(Snapshot).where(Snapshot.id == snapshot_id, Snapshot.created_by == _user(principal))
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
    """The user's items as they were at the snapshot (each at its pinned version)."""
    snapshot = await _snapshot(db, principal, snapshot_id)
    rows = await items.items_as_of(db, _user(principal), snapshot.as_of, source_id=source)
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
    """Search the user's own items. Ranked by relevance x confidence weight; ``as_of``
    searches the versions pinned at that time."""
    user_id = _user(principal)
    if as_of is not None and as_of.tzinfo is None:
        as_of = as_of.replace(tzinfo=UTC)
    hits = await search_service.search(
        db, user_id, q, kinds=_kinds(kinds), source_id=source, as_of=as_of, limit=limit
    )
    return SearchResults(query=q, as_of=as_of, hits=hits)  # type: ignore[arg-type]
