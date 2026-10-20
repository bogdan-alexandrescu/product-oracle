"""The owner-scoped source registry.

Every function takes the acting user's id: a user sees, changes and syncs only the
sources they own (S3 revised). Another user's source reads as "not found".
"""

import importlib
import pkgutil
import uuid
from typing import TYPE_CHECKING, Any

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import changes
from oracle.connections import service as connections
from oracle.connections.models import Connection
from oracle.sources import base
from oracle.sources.models import SOURCE_KINDS, Source, SourceItem
from oracle.v2 import links

if TYPE_CHECKING:
    from oracle.auth.deps import Principal

# Source kind -> the connection provider it syncs with. Uploads need no connection.
KIND_PROVIDER: dict[str, str | None] = {
    "upload": None,
    "github": "github",
    "slack": "slack",
    "notion": "notion",
    "fireflies": "fireflies",
    "google_docs": "google",
}
assert set(KIND_PROVIDER) == set(SOURCE_KINDS)

CONNECTOR_UNAVAILABLE = "connector not available yet"


class NotFoundError(Exception):
    pass


class ConflictError(Exception):
    pass


class InvalidError(Exception):
    """The request cannot be carried out as asked (answered 422)."""


_loaded = False


def load_connectors() -> None:
    """Import every module of ``oracle.sources.connectors`` so each registers itself.

    The package belongs to the connector lanes; until it exists nothing is loaded.
    """
    global _loaded
    if _loaded:
        return
    _loaded = True
    try:
        package = importlib.import_module("oracle.sources.connectors")
    except ModuleNotFoundError:
        return
    for info in pkgutil.iter_modules(getattr(package, "__path__", [])):
        importlib.import_module(f"{package.__name__}.{info.name}")


def connector_for(kind: str) -> base.Connector | None:
    if kind == "upload":
        return None
    load_connectors()
    try:
        return base.get_connector(kind)
    except LookupError:
        return None


def connector_available(kind: str) -> bool:
    return kind == "upload" or connector_for(kind) is not None


def _connector_credential(credential: connections.Credential) -> dict[str, Any]:
    """The credential in the shape connectors read: ``token`` / ``access_token``, plus
    ``api_key`` for API-key providers (Fireflies), plus the stored non-secret extras."""
    token = credential.access_token
    bundle: dict[str, Any] = {**credential.extra, "access_token": token, "token": token}
    if credential.provider == "fireflies":
        bundle["api_key"] = token
    return bundle


async def _read_credential(db: AsyncSession, conn: Connection) -> dict[str, Any]:
    """Read (and refresh, if due) a connection's credential through Lane K's service.

    Commits the session, as :func:`oracle.connections.service.credential_for` does.
    """
    try:
        return _connector_credential(await connections.credential_for(db, conn))
    except connections.ConnectionUnavailable as e:
        raise InvalidError(f"{e}") from None


async def mark_connection_rejected(db: AsyncSession, source: Source, error: str) -> None:
    """A provider rejected the credential during a sync: mark the user's connection
    expired with the error, so Settings > Connections offers Reconnect. Commits."""
    if source.connection_id is None:
        return
    conn = await db.scalar(
        select(Connection).where(
            Connection.id == source.connection_id,
            Connection.user_id == source.owner_user_id,
        )
    )
    if conn is not None:
        await connections.mark_failure(db, conn, "expired", error)


async def owned_connection(
    db: AsyncSession, user_id: uuid.UUID, connection_id: uuid.UUID
) -> Connection:
    conn = await db.scalar(
        select(Connection).where(Connection.id == connection_id, Connection.user_id == user_id)
    )
    if conn is None:
        raise NotFoundError("Connection not found")
    return conn


async def credential_for(
    db: AsyncSession, source: Source
) -> tuple[dict[str, Any] | None, Connection | None]:
    """The decrypted credential of the source's connection (``None`` for uploads)."""
    if KIND_PROVIDER[source.kind] is None:
        return None, None
    if source.connection_id is None:
        raise InvalidError("This source has no connection: pick one of your connections")
    try:
        credential = await connections.get_credential(
            db, source.connection_id, source.owner_user_id
        )
    except connections.ConnectionUnavailable as e:
        if e.status is None:
            raise NotFoundError("Connection not found") from None
        raise InvalidError(f"{e}") from None
    conn = await db.get(Connection, credential.connection_id)
    return _connector_credential(credential), conn


async def _check_connection(
    db: AsyncSession, user_id: uuid.UUID, kind: str, connection_id: uuid.UUID | None
) -> Connection | None:
    provider = KIND_PROVIDER[kind]
    if provider is None:
        if connection_id is not None:
            raise InvalidError("Uploads take no connection")
        return None
    if connection_id is None:
        raise InvalidError(f"A {kind} source needs one of your {provider} connections")
    conn = await owned_connection(db, user_id, connection_id)
    if conn.provider != provider:
        raise InvalidError(
            f"A {kind} source needs a {provider} connection, not a {conn.provider} one"
        )
    if conn.status != "active":
        raise InvalidError(f"The connection is {conn.status}: reconnect it first")
    return conn


async def _validate(
    db: AsyncSession, kind: str, config: dict[str, Any], conn: Connection | None
) -> None:
    if kind == "upload":
        return
    connector = connector_for(kind)
    if connector is None:
        raise InvalidError(CONNECTOR_UNAVAILABLE)
    credential = await _read_credential(db, conn) if conn is not None else None
    try:
        await connector.validate(config, credential)
    except base.ConnectorAuthError as e:
        raise InvalidError(f"The connection was rejected: {redact(str(e), credential)}") from None
    except base.ConnectorError as e:
        raise InvalidError(redact(str(e), credential)) from None


def redact(message: str, credential: dict[str, Any] | None) -> str:
    """Remove any credential value a connector may have echoed into an error message."""
    for value in _secret_strings(credential):
        message = message.replace(value, "***")
    return message


def _secret_strings(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value] if len(value) >= 6 else []
    if isinstance(value, dict):
        return [s for v in value.values() for s in _secret_strings(v)]
    if isinstance(value, list | tuple):
        return [s for v in value for s in _secret_strings(v)]
    return []


async def get_source(db: AsyncSession, user_id: uuid.UUID, source_id: uuid.UUID) -> Source:
    source = await db.scalar(
        select(Source).where(Source.id == source_id, Source.owner_user_id == user_id)
    )
    if source is None:
        raise NotFoundError("Source not found")
    return source


async def list_sources(db: AsyncSession, user_id: uuid.UUID) -> list[Source]:
    rows = await db.scalars(
        select(Source).where(Source.owner_user_id == user_id).order_by(Source.created_at)
    )
    return list(rows)


async def item_counts(db: AsyncSession, source_ids: list[uuid.UUID]) -> dict[uuid.UUID, int]:
    if not source_ids:
        return {}
    rows = await db.execute(
        select(SourceItem.source_id, func.count())
        .where(SourceItem.source_id.in_(source_ids), SourceItem.deleted_at.is_(None))
        .group_by(SourceItem.source_id)
    )
    return {sid: n for sid, n in rows.all()}


async def _commit_unique(db: AsyncSession) -> None:
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise ConflictError("You already have a source with this name") from None


async def create_source(
    db: AsyncSession,
    user_id: uuid.UUID,
    *,
    kind: str,
    name: str,
    connection_id: uuid.UUID | None,
    config: dict[str, Any],
) -> Source:
    conn = await _check_connection(db, user_id, kind, connection_id)
    await _validate(db, kind, config, conn)
    source = Source(
        owner_user_id=user_id,
        connection_id=connection_id,
        kind=kind,
        name=name.strip(),
        config=config,
        status="active",
    )
    db.add(source)
    await _commit_unique(db)
    return source


async def update_source(db: AsyncSession, source: Source, changes: dict[str, Any]) -> Source:
    reconnect = "connection_id" in changes and changes["connection_id"] != source.connection_id
    reconfigure = changes.get("config") is not None and changes["config"] != source.config
    if reconnect or reconfigure:
        connection_id = changes["connection_id"] if reconnect else source.connection_id
        config = changes["config"] if reconfigure else source.config
        conn = await _check_connection(db, source.owner_user_id, source.kind, connection_id)
        # Validating reads the credential, which commits: change nothing before it.
        await _validate(db, source.kind, config, conn)
        source.connection_id = connection_id
        source.config = config
        # A new allowlist or account: sync from the start. Unchanged content writes no
        # new versions, so a full pass is cheap in storage. A connector that deletes by
        # its cursor (items it knew minus items still live) must keep its known ids across
        # a config change, or narrowing the source could never delete anything (S5).
        if source.kind == "notion":
            # Keep the page ids, drop the render cache: every live page is re-rendered
            # and pages now outside the roots are deleted.
            pages = (source.cursor or {}).get("pages") or {}
            source.cursor = {"pages": {page_id: {} for page_id in pages}}
        else:
            source.cursor = None
        if source.status == "error":
            source.status = "active"
            source.last_error = None
    if "name" in changes and changes["name"] is not None:
        source.name = changes["name"].strip()
    await _commit_unique(db)
    return source


async def set_paused(db: AsyncSession, source: Source, paused: bool) -> Source:
    if paused:
        source.status = "paused"
    else:
        source.status = "active"
        source.last_error = None
    await db.commit()
    return source


async def delete_source(
    db: AsyncSession, source: Source, *, actor: "Principal | str | None"
) -> None:
    """Delete a source and its items. Recorded first (v2 hook, oracle.trace): what the
    items' evidence backs, and the section links citing the items, are marked potentially
    stale while they still exist. Then a link citing an item keeps its other target (an
    entity or evidence) and only drops the item; one left with no target is deleted."""
    await changes.record_change(
        db,
        "source_permission",
        cause="source_deleted",
        actor=actor,
        subject_id=source.id,
        subject_ref=f"{source.kind} source",
        # The name stays out: a source is private to its owner.
        data={"source": {"id": str(source.id), "kind": source.kind}},
    )
    item_ids = (
        await db.scalars(select(SourceItem.id).where(SourceItem.source_id == source.id))
    ).all()
    await links.release(db, source_item_ids=set(item_ids))
    await db.delete(source)
    await db.commit()


async def connection_choices(db: AsyncSession, user_id: uuid.UUID) -> dict[str, list[Connection]]:
    rows = await db.scalars(
        select(Connection).where(Connection.user_id == user_id).order_by(Connection.created_at)
    )
    by_provider: dict[str, list[Connection]] = {}
    for conn in rows:
        by_provider.setdefault(conn.provider, []).append(conn)
    return by_provider
