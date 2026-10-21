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
from oracle.connections.providers import get_provider
from oracle.sources import base, store
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


class StaleError(Exception):
    """The save loaded an older ``config_version`` than the source has now (answered 409)."""

    code = "source_changed"

    def __init__(self) -> None:
        super().__init__(
            "This source changed since you opened it. Reload to see the current picks."
        )


class InvalidError(Exception):
    """The request cannot be carried out as asked (answered 422)."""


class RateLimitedError(Exception):
    """The provider asked to slow down while checking a config (answered 429)."""

    def __init__(self, message: str, retry_after: int):
        super().__init__(message)
        self.retry_after = retry_after


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


async def mark_connection_rejected(
    db: AsyncSession, connection_id: uuid.UUID | None, owner_id: uuid.UUID, error: str
) -> None:
    """A provider rejected the credential of ``connection_id`` (the one a sync used)
    during a sync: mark the user's connection expired with the error, so Settings >
    Connections offers Reconnect. Commits."""
    if connection_id is None:
        return
    conn = await db.scalar(
        select(Connection).where(Connection.id == connection_id, Connection.user_id == owner_id)
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
    db: AsyncSession, source: Source, connection_id: uuid.UUID | None = None
) -> tuple[dict[str, Any] | None, Connection | None]:
    """The decrypted credential of the source's connection (``None`` for uploads), or of
    ``connection_id`` when given (the connection a sync read when it started)."""
    if KIND_PROVIDER[source.kind] is None:
        return None, None
    connection_id = connection_id or source.connection_id
    if connection_id is None:
        raise InvalidError("This source has no connection: pick one of your connections")
    try:
        credential = await connections.get_credential(db, connection_id, source.owner_user_id)
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
    except base.ConnectorRateLimited as e:
        wait = max(1, round(e.retry_after)) if e.retry_after else 60
        provider = get_provider(KIND_PROVIDER[kind] or "")
        name = provider.name if provider else kind
        raise RateLimitedError(
            f"{name} is busy checking the selection: try again in {wait} seconds", wait
        ) from None
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


async def item_counts(
    db: AsyncSession, source_ids: list[uuid.UUID], exclude: set[uuid.UUID] | None = None
) -> dict[uuid.UUID, int]:
    """Live items per source; ``exclude``: items the caller may not read (not counted,
    so a count never tells how many are withheld)."""
    if not source_ids:
        return {}
    stmt = (
        select(SourceItem.source_id, func.count())
        .where(SourceItem.source_id.in_(source_ids), SourceItem.deleted_at.is_(None))
        .group_by(SourceItem.source_id)
    )
    if exclude:
        stmt = stmt.where(SourceItem.id.not_in(exclude))
    rows = await db.execute(stmt)
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
    config = normalize_config(kind, config)
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
    changes = dict(changes)
    base_version = changes.pop("base_version", None)
    if changes.get("config") is not None:
        changes = {**changes, "config": normalize_config(source.kind, changes["config"])}
    asks = "connection_id" in changes or changes.get("config") is not None
    if asks or base_version is not None:
        # The row was loaded when the request started (sessions do not expire on
        # commit): a sync, or another save, may have changed it since. Read it again,
        # locked until the commit below, and compare what is asked with THAT copy (a
        # request asking for the config it loaded, after another save narrowed it, is a
        # widening, and is validated as one). A running sync takes the same row lock
        # before it writes items (sync._hold), so this sweep and its checkpoints never
        # wait on each other's rows.
        await db.refresh(source, with_for_update=True)
        _check_base(source, base_version)
        reconnect, reconfigure, narrowing = _what_changed(source, changes)
        if reconnect or (reconfigure and not narrowing):
            connection_id = changes["connection_id"] if reconnect else source.connection_id
            config = changes["config"] if reconfigure else source.config
            # Validating reads the credential, which commits (and so frees the lock):
            # nothing is changed before it, and the row is read again, locked, after it.
            # What was validated is the target (connection and config), whatever the row
            # looked like meanwhile.
            await db.commit()
            conn = await _check_connection(db, source.owner_user_id, source.kind, connection_id)
            await _validate(db, source.kind, config, conn)
            await db.refresh(source, with_for_update=True)
            _check_base(source, base_version)  # another save may have landed meanwhile
            reconnect, reconfigure, narrowing = _what_changed(source, changes)
        old_config = dict(source.config or {})
        connection_id = changes.get("connection_id", source.connection_id)
    else:
        reconnect = reconfigure = False
    if reconnect or reconfigure:
        config = changes["config"] if reconfigure else source.config
        if reconnect:
            # Another connection may sign in to another account: its position in the
            # old one means nothing. Start over (unchanged content writes no new version).
            source.cursor = None
        source.connection_id = connection_id
        source.config = config
        if reconfigure:
            # Narrowing takes effect on save (S5, owner 2026-10-20): what the stored items
            # show to fall outside the new selection is deleted (soft) in this request,
            # without calling the provider. What only the provider can tell (a Fireflies
            # series, a Notion sub-page) goes on the next sync's pass.
            await _sweep(db, source, old_config, config)
        # A config change keeps the cursor: the next sync sees the selection changed (its
        # fingerprint, oracle.sources.sync), sweeps again (nothing left by then) and asks
        # the connector how much of the cursor still holds (rescope_cursor), so it only
        # re-reads what remains. A sync running now keeps none of what it reads from here
        # on (its writes are conditional).
        if source.status in ("error", "needs_attention"):
            source.status = "active"
            source.last_error = None
    name = changes.get("name")
    renamed = name is not None and name.strip() != source.name
    if renamed:
        source.name = name.strip()
    if reconnect or reconfigure or renamed:
        source.config_version += 1
    await _commit_unique(db)
    return source


def _check_base(source: Source, base_version: int | None) -> None:
    """Refuse (nothing is changed yet) a save that loaded another version than the
    locked row has. Omitted: last write wins."""
    if base_version is not None and base_version != source.config_version:
        raise StaleError


def _what_changed(source: Source, changes: dict[str, Any]) -> tuple[bool, bool, bool]:
    """(connection changed, config changed, the config change only narrows), each against
    ``source`` as it is now. A pure narrowing (no new pick, no wider date, same connection;
    owner S5 2026-10-20: "no provider call") needs neither the provider nor an active
    connection."""
    reconnect = "connection_id" in changes and changes["connection_id"] != source.connection_id
    reconfigure = changes.get("config") is not None and changes["config"] != source.config
    narrowing = (
        reconfigure
        and not reconnect
        and _only_narrows(source.kind, source.config, changes["config"])
    )
    return reconnect, reconfigure, narrowing


def _only_narrows(kind: str, old: dict[str, Any] | None, new: dict[str, Any]) -> bool:
    connector = connector_for(kind)
    scope = getattr(connector, "scope", None)
    if scope is None:
        return False
    try:
        narrows = getattr(connector, "narrows", None)
        if narrows is not None:
            return bool(narrows(dict(old or {}), new))
        return base.scope_narrows(scope(dict(old or {})), scope(new))
    except base.ConnectorConfigError:
        return False  # saved before a rule it now breaks, or refused now: validate


async def _sweep(
    db: AsyncSession, source: Source, old_config: dict[str, Any], config: dict[str, Any]
) -> int:
    """Soft-delete the source's stored items outside ``config`` (the connector's
    ``scope``), in the caller's transaction; how many. A selection that keeps the same
    scope (new labels, say) sweeps nothing: an item of unknown provenance is only swept
    when the picks change."""
    scope = getattr(connector_for(source.kind), "scope", None)
    if scope is None:
        return 0
    new_scope = scope(config)
    try:
        old_scope = scope(old_config)
    except base.ConnectorConfigError:
        old_scope = None  # saved before a rule it now breaks: sweep by the new one
    if new_scope == old_scope:
        return 0
    return await store.delete_out_of_scope(db, source, new_scope)


def normalize_config(kind: str, config: dict[str, Any]) -> dict[str, Any]:
    """``config`` in the connector's canonical form (oracle.sources.base), as it is saved
    and fingerprinted; unchanged when it does not parse (validating says why)."""
    normalize = getattr(connector_for(kind), "normalize_config", None)
    if normalize is None:
        return config
    try:
        return normalize(config)
    except base.ConnectorConfigError:
        return config


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
