"""The owner-scoped source registry.

Every function takes the acting user's id: a user sees, changes and syncs only the
sources they own (S3 revised). Another user's source reads as "not found".
"""

import importlib
import pkgutil
import re
import uuid
from typing import TYPE_CHECKING, Any

from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import changes
from oracle.auth.models import User
from oracle.config import get_settings
from oracle.connections import service as connections
from oracle.connections.models import Connection
from oracle.connections.providers import (
    DRIVE_FILE,
    DRIVE_READONLY,
    RECONNECT_TO_CHOOSE_FILES,
    get_provider,
    reconnect_reason,
)
from oracle.sources import base, store
from oracle.sources.connectors import google_docs
from oracle.sources.items import current_xid
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


class BadRequestError(InvalidError):
    """The config is malformed, e.g. an id that is not one (answered 400)."""


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


def scope_problem(kind: str, config: dict[str, Any], conn: Connection | None) -> str | None:
    """Why the connection's grant cannot read this source's allowlist, before calling
    the provider. Google: Oracle reads Drive through drive.readonly (S5, 'Drive folders');
    a picked folder cannot be read without it, since the short-lived drive.file grant
    does not open a folder's docs. Picked files also open under drive.file. Unknown
    scopes (an older pasted token) are not judged."""
    if kind != "google_docs" or conn is None or not conn.scopes:
        return None
    scopes = set(conn.scopes)
    if config.get("folders") and DRIVE_READONLY not in scopes:
        return (
            f"{RECONNECT_TO_CHOOSE_FILES}: this Google connection cannot read folders; "
            "reconnect Google to give Oracle read access to your Drive"
        )
    if config.get("docs") and not scopes & {DRIVE_FILE, DRIVE_READONLY}:
        return f"{RECONNECT_TO_CHOOSE_FILES}: this Google connection cannot read Drive files"
    return None


def source_reconnect_reason(source: Source, conn: Connection | None) -> str | None:
    """What the Sources page shows next to a source whose connection should be signed
    in again (a Google grant without drive.readonly), or whose folders the connection
    cannot read."""
    if conn is None or KIND_PROVIDER.get(source.kind) != conn.provider:
        return None
    if scope_problem(source.kind, dict(source.config or {}), conn):
        return RECONNECT_TO_CHOOSE_FILES
    return reconnect_reason(conn.provider, list(conn.scopes or []))


async def connections_by_id(
    db: AsyncSession, user_id: uuid.UUID, ids: list[uuid.UUID | None]
) -> dict[uuid.UUID, Connection]:
    wanted = [i for i in ids if i is not None]
    if not wanted:
        return {}
    rows = await db.scalars(
        select(Connection).where(Connection.user_id == user_id, Connection.id.in_(wanted))
    )
    return {c.id: c for c in rows}


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


def _picks(config: dict[str, Any]) -> dict[str, Any]:
    """A source's config without the display names of what was picked."""
    return {k: v for k, v in (config or {}).items() if k != "names"}


def _check_shape(kind: str, config: dict[str, Any]) -> None:
    """The connector's offline check of a config's shape and ids (no provider call)."""
    if kind == "upload":
        return
    connector = connector_for(kind)
    if connector is None:
        raise InvalidError(CONNECTOR_UNAVAILABLE)
    # A connector may be stricter with what is saved than with what it syncs (Google
    # Docs: the display names a stored config carries are trimmed when it syncs).
    check = getattr(connector, "check_new_config", None) or getattr(connector, "check_config", None)
    if check is not None:
        try:
            check(config)
        except base.ConnectorBadInput as e:
            raise BadRequestError(str(e)) from None
        except base.ConnectorError as e:
            raise InvalidError(str(e)) from None


async def _validate(
    db: AsyncSession, kind: str, config: dict[str, Any], conn: Connection | None
) -> None:
    if kind == "upload":
        return
    connector = connector_for(kind)
    # The shape and ids first: nothing is sent to the provider for a bad id.
    _check_shape(kind, config)
    problem = scope_problem(kind, config, conn)
    if problem:
        raise InvalidError(problem)
    credential = await _read_credential(db, conn) if conn is not None else None
    try:
        await connector.validate(config, credential)
    except base.ConnectorBadInput as e:
        raise BadRequestError(redact(str(e), credential)) from None
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
    _check_config(config)
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


# Mail providers anyone can sign up with: a member's address there says nothing about
# which documents are the company's.
PUBLIC_MAIL_DOMAINS = frozenset(
    {
        "gmail.com",
        "googlemail.com",
        "outlook.com",
        "hotmail.com",
        "hotmail.co.uk",
        "live.com",
        "msn.com",
        "yahoo.com",
        "yahoo.co.uk",
        "aol.com",
        "icloud.com",
        "me.com",
        "proton.me",
        "protonmail.com",
        "pm.me",
        "gmx.com",
        "gmx.de",
        "gmx.net",
        "yandex.com",
        "yandex.ru",
        "mail.ru",
        "qq.com",
        "zoho.com",
        "fastmail.com",
        "hey.com",
        "mail.com",
        "ymail.com",
        "web.de",
        "tutanota.com",
        "tuta.io",
    }
)
# Providers with an address under many country domains (gmx.de, yahoo.co.uk): the name,
# then one or two short labels.
PUBLIC_MAIL_NAMES = frozenset(
    {
        "gmail",
        "googlemail",
        "outlook",
        "hotmail",
        "live",
        "msn",
        "yahoo",
        "aol",
        "icloud",
        "protonmail",
        "gmx",
        "yandex",
    }
)
_COUNTRY_SUFFIX = re.compile(r"[a-z]{2,3}(?:\.[a-z]{2,3})?")


def is_public_mail_domain(domain: str) -> bool:
    """Whether ``domain`` is a mail provider anyone can sign up with (gmail.com, gmx.de,
    yahoo.co.uk, ...): an address there says nothing about whose a document is."""
    domain = domain.strip().lower().lstrip("@")
    if domain in PUBLIC_MAIL_DOMAINS:
        return True
    name, _, suffix = domain.partition(".")
    return name in PUBLIC_MAIL_NAMES and bool(_COUNTRY_SUFFIX.fullmatch(suffix))


async def company_domains(db: AsyncSession, tenant_id: uuid.UUID) -> list[str]:
    """The company's email domains, set explicitly (S5, owner 2026-10-20):
    ``ORACLE_IAP_ALLOWED_DOMAINS`` and the owner's ``company_email_domains`` setting.
    Neither set: none (the outside-owner check fails closed), unless
    ``ORACLE_INFER_COMPANY_DOMAINS`` (local development only) takes them from the members'
    email addresses, public mail providers left out."""
    from oracle.tenant_settings_api import get_setting

    configured = {d.strip().lower().lstrip("@") for d in get_settings().iap_allowed_domains}
    configured |= {str(d).strip().lower() for d in await get_setting(db, "company_email_domains")}
    configured.discard("")
    if configured or not get_settings().infer_company_domains:
        return sorted(configured)
    emails = await db.scalars(select(User.email).where(User.tenant_id == tenant_id))
    found = {e.rpartition("@")[2].strip().lower() for e in emails if "@" in e}
    return sorted(d for d in found if d and not is_public_mail_domain(d))


async def company_shared_drives(db: AsyncSession) -> list[str]:
    """The ids of the shared drives the owner listed as the company's (S5)."""
    from oracle.tenant_settings_api import get_setting

    return sorted({d["id"] for d in await get_setting(db, "company_shared_drives")})


async def company_scope(db: AsyncSession, tenant_id: uuid.UUID) -> tuple[list[str], list[str]]:
    """The company's email domains and shared drives, as a Google Docs sync reads them."""
    return await company_domains(db, tenant_id), await company_shared_drives(db)


# --- Narrowing without the provider (S5, owner 2026-10-20) ---------------------------
#
# Saving a narrower Google Docs allowlist, or narrower company Drive settings, deletes
# (soft delete) what falls outside in the same request, judged from what Oracle stored:
# no provider call, so it works with an expired connection or a paused source.
#
# Locks: the source row first (a save's FOR UPDATE, or FOR NO KEY UPDATE as a sync takes
# it before its first item write and every checkpoint, oracle.sources.sync._hold), then
# the items with SKIP LOCKED. A running sync holds the source row while it holds item
# rows, so a save waits for its commit and then finds nothing locked; SKIP LOCKED keeps a
# save from ever waiting on item rows all the same. A row skipped that way was written by
# a sync that has not committed; that sync then finds the source changed at its next
# hold, rolls back and runs tidy_drive_source, which deletes it.


async def _lock_source(db: AsyncSession, source_id: uuid.UUID) -> Source | None:
    """The source row, locked until the commit and loaded afresh (a sync may have saved
    a checkpoint since it was read)."""
    return await db.scalar(
        select(Source)
        .where(Source.id == source_id)
        .with_for_update(key_share=True)
        .execution_options(populate_existing=True)
    )


async def _live_items(db: AsyncSession, source_id: uuid.UUID) -> list[tuple[str, dict[str, Any]]]:
    rows = await db.execute(
        select(SourceItem.external_id, SourceItem.acl).where(
            SourceItem.source_id == source_id, SourceItem.deleted_at.is_(None)
        )
    )
    return [(r.external_id, r.acl) for r in rows]


async def _hide_items(db: AsyncSession, source: Source, external_ids: set[str]) -> set[str]:
    """Soft-delete these live items of ``source`` (versions kept; citations show 'source
    removed') and drop them from its cursor, so a sync that finds them under the
    allowlist again reads them again. Rows a running sync holds are skipped (see above).
    Returns the ids deleted."""
    if not external_ids:
        return set()
    rows = (
        await db.execute(
            select(SourceItem.id, SourceItem.external_id)
            .where(
                SourceItem.source_id == source.id,
                SourceItem.external_id.in_(sorted(external_ids)),
                SourceItem.deleted_at.is_(None),
            )
            .order_by(SourceItem.external_id)
            .with_for_update(key_share=True, skip_locked=True)
        )
    ).all()
    if not rows:
        return set()
    await db.execute(
        update(SourceItem)
        .where(SourceItem.id.in_([r.id for r in rows]))
        .values(deleted_at=func.clock_timestamp(), deleted_xid=current_xid())
        .execution_options(synchronize_session=False)
    )
    hidden = {r.external_id for r in rows}
    source.cursor = google_docs.forget(source.cursor, hidden)
    return hidden


async def _apply_drive_edit(
    db: AsyncSession,
    source: Source,
    old: dict[str, Any],
    config: dict[str, Any],
    *,
    reconnect: bool,
) -> None:
    """Delete, now, the Google Docs source's items ``config`` no longer picks
    (google_docs.outside_picks); the caller holds the source row (update_source). On a
    new connection the next sync reads everything again, keeping which folder each doc
    came from; otherwise the cursor stays (the folders are listed again since the
    allowlist changed) and so does what the last sync said about what is still picked.
    A change of display names alone changes nothing else."""
    if not reconnect and _picks(old) == _picks(config):
        return
    old_folders, old_docs = google_docs.picked_ids(old)
    new_folders, new_docs = google_docs.picked_ids(config)
    removed = (old_folders | old_docs) - (new_folders | new_docs)
    live = [external_id for external_id, _ in await _live_items(db, source.id)]
    await _hide_items(db, source, google_docs.outside_picks(config, source.cursor, live, removed))
    if reconnect:
        tree = (source.cursor or {}).get("tree")
        source.cursor = {"tree": tree} if tree else None
        source.unavailable_items = []
    else:
        picked = new_folders | new_docs
        keep = [n for n in source.unavailable_items or [] if n.get("external_id") in picked]
        source.unavailable_items = keep
        if source.cursor and source.cursor.get("notes"):
            notes = [n for n in source.cursor["notes"] if n.get("external_id") in picked]
            source.cursor = {**source.cursor, "notes": notes}


async def tidy_drive_source(
    db: AsyncSession, source_id: uuid.UUID, *, unknown_outside: bool = False
) -> int:
    """After a Google Docs sync stopped because its source or the company's Drive
    settings changed: delete the live items that now fall outside (what the edit's save
    could not, because the sync held their rows). Commits; returns how many.
    ``unknown_outside``: also delete items whose drive and owner are not known; only after
    a company narrowing (domains or shared drives), not a person's own edit."""
    source = await _lock_source(db, source_id)
    if source is None or source.kind != "google_docs":
        await db.rollback()
        return 0
    items = await _live_items(db, source.id)
    gone = google_docs.outside_picks(source.config or {}, source.cursor, [i for i, _ in items])
    if get_settings().drive_docs_owned_outside == "skip":
        domains, drives = await company_scope(db, source.tenant_id)
        gone |= google_docs.outside_company(
            source.config or {}, items, domains, drives, unknown_outside=unknown_outside
        )
    hidden = await _hide_items(db, source, gone)
    await db.commit()
    return len(hidden)


async def hide_outside_company(
    db: AsyncSession, tenant_id: uuid.UUID, before: tuple[list[str], list[str]]
) -> int:
    """After an owner changed the company's email domains or shared drives (``before``:
    what they were): when that narrowed them, delete now, across every member's Google
    Docs sources, the docs in picked folders that fall outside, judged from what each
    item stored (google_docs.outside_company). One whose drive and owner are not known is
    deleted too; the next sync reads it again if it is the company's. Nothing is deleted
    when docs owned outside are pulled in and flagged (ORACLE_DRIVE_DOCS_OWNED_OUTSIDE).
    Does not commit; returns how many were deleted."""
    domains, drives = await company_scope(db, tenant_id)
    narrowed = not set(before[0]) <= set(domains) or not set(before[1]) <= set(drives)
    if not narrowed or get_settings().drive_docs_owned_outside != "skip":
        return 0
    sources = await db.scalars(
        select(Source)
        .where(Source.kind == "google_docs")
        .order_by(Source.id)
        .with_for_update(key_share=True)
        .execution_options(populate_existing=True)
    )
    hidden = 0
    for source in list(sources):
        items = await _live_items(db, source.id)
        gone = google_docs.outside_company(
            source.config or {}, items, domains, drives, unknown_outside=True
        )
        hidden += len(await _hide_items(db, source, gone))
    return hidden


def _check_config(config: dict[str, Any]) -> None:
    reserved = sorted(k for k in config if str(k).startswith("_"))
    if reserved:
        raise InvalidError(f"Unknown setting {reserved[0]!r}: names starting with _ are Oracle's")


async def update_source(db: AsyncSession, source: Source, changes: dict[str, Any]) -> Source:
    changes = dict(changes)
    base_version = changes.pop("base_version", None)
    if changes.get("config") is not None:
        _check_config(changes["config"])
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
        if narrowing:
            # Nothing is asked of the provider (S5, owner 2026-10-20), so the connection
            # may be expired; the shape and ids are still checked, offline.
            _check_shape(source.kind, changes["config"])
        old_config = dict(source.config or {})
        connection_id = changes.get("connection_id", source.connection_id)
    else:
        reconnect = reconfigure = narrowing = False
    if reconnect or reconfigure:
        config = changes["config"] if reconfigure else source.config
        if source.kind == "google_docs":
            # Google Docs narrows on save from its cursor's tree (which folder each doc
            # came from), not from item provenance: it has no ``scope``, so _sweep below
            # does nothing for it. Its cursor stays for a new allowlist (the folders are
            # listed again when the allowlist changes); a new connection keeps the tree.
            await _apply_drive_edit(db, source, old_config, config, reconnect=reconnect)
        else:
            if reconnect:
                # Another connection may sign in to another account: its position in the
                # old one means nothing. Start over (unchanged content writes no version).
                source.cursor = None
            source.unavailable_items = []
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
        # on (it holds the row before each write and finds the source changed).
        if source.status == "needs_attention" or (source.status == "error" and not narrowing):
            # An error was checked with the provider just now; a pure narrowing asked it
            # nothing, so an error (a rejected connection) still stands.
            source.status = "active"
            source.last_error = None
    name = changes.get("name")
    renamed = name is not None and name.strip() != source.name
    if renamed:
        source.name = name.strip()
    if reconnect or reconfigure or renamed:
        # In SQL: a rename-only save holds no lock, so the row may have moved on since it
        # was read at request start; add one to what is stored now.
        source.config_version = Source.config_version + 1
    await _commit_unique(db)
    await db.refresh(source)  # config_version was an SQL expression
    return source


def _check_base(source: Source, base_version: int | None) -> None:
    """Refuse (nothing is changed yet) a save that loaded another version than the
    locked row has. Omitted (the API requires it when config or connection change; a
    rename or pause may leave it out): not checked."""
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
    """The one rule for a pure narrowing, whatever the kind: the connector's ``narrows``
    when it has one (Fireflies, Google Docs), else its ``scope`` of each config compared
    by base.scope_narrows. A kind with neither never narrows without the provider."""
    connector = connector_for(kind)
    narrows = getattr(connector, "narrows", None)
    scope = getattr(connector, "scope", None)
    try:
        if narrows is not None:
            return bool(narrows(dict(old or {}), new))
        if scope is not None:
            return base.scope_narrows(scope(dict(old or {})), scope(new))
    except base.ConnectorConfigError:
        return False  # saved before a rule it now breaks, or refused now: validate
    return False


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
