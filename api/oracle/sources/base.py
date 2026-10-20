"""The connector protocol: how a source kind (GitHub, Slack, Notion, uploads) is read.

A connector is stateless and does no database work. The sync engine
(``oracle.sources``) hands it the source's allowlist ``config``, its decrypted
``credential`` and the last ``cursor``, and stores what ``sync`` yields:

- :class:`ItemUpsert` creates or updates an item (a new version only when the
  content changes);
- :class:`ItemDelete` marks an item deleted;
- :class:`CursorCheckpoint` is a resumable position: everything yielded before it is
  stored, then the cursor is saved, so an interrupted sync resumes from there.

Optional hooks a connector may define:

- ``check_config(config)`` raises :class:`ConnectorConfigError` when a saved config breaks
  a rule (one added after it was saved, say); the engine then marks the source as
  needing attention instead of calling the provider;
- ``scope(config) -> Scope`` says what the selection keeps. After the selection changed,
  the engine deletes (soft: ``deleted_at``) the stored items outside it, in one SQL
  statement: narrowing a source removes what now falls outside it (S5, owner 2026-10-19
  and 2026-10-20);
- ``rescope_cursor(old_cursor, new_config)`` returns the cursor to resume from after the
  selection changed (``None``: from the start). Keep what upstream deletes are compared
  against; drop what would skip re-reading.

The engine notices a changed selection (config or connection) by a fingerprint it keeps
in the saved cursor under :data:`SCOPE_KEY`; connectors never see that key.

Connectors never yield direct messages (S3 Visibility); ``acl`` records who can see an
item in the source.

    class GithubConnector:
        kind = "github"

        async def validate(self, config, credential): ...

        async def sync(self, config, credential, cursor):
            yield ItemUpsert(...)
            yield CursorCheckpoint({"since": "..."})

    register(GithubConnector())
"""

from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Protocol, runtime_checkable

from oracle.sources.models import ITEM_KINDS


class ConnectorError(Exception):
    """Base class of connector failures."""


class ConnectorConfigError(ConnectorError):
    """The config or credential is invalid (bad repo name, missing scope, ...)."""


class ConnectorAuthError(ConnectorError):
    """The source rejected the credential (revoked, expired, insufficient)."""


class ConnectorForbidden(ConnectorAuthError):
    """The source refused one request (a 403, Slack's ``no_permission``) while the
    credential itself may still be good. Syncs treat it as a rejection; browsing does
    not mark the connection expired for it."""


class ConnectorRateLimited(ConnectorError):
    """The source asked to slow down; retry no earlier than ``retry_after`` seconds."""

    def __init__(self, message: str = "rate limited", retry_after: float | None = None):
        super().__init__(message)
        self.retry_after = retry_after


@dataclass(frozen=True)
class ItemUpsert:
    external_id: str
    # One of oracle.sources.models.ITEM_KINDS.
    kind: str
    title: str | None
    url: str | None
    author: str | None
    content: str
    acl: dict[str, Any] = field(default_factory=dict)
    occurred_at: datetime | None = None
    source_updated_at: datetime | None = None

    def __post_init__(self) -> None:
        if self.kind not in ITEM_KINDS:
            raise ValueError(f"unknown item kind {self.kind!r}")


@dataclass(frozen=True)
class ItemDelete:
    external_id: str


@dataclass(frozen=True)
class CursorCheckpoint:
    cursor: dict[str, Any]


SyncEvent = ItemUpsert | ItemDelete | CursorCheckpoint

# The key of the saved cursor holding the engine's fingerprint of the selection.
SCOPE_KEY = "_scope"


@dataclass(frozen=True)
class Scope:
    """What a selection keeps. Every field that is set narrows it:

    - ``groups``: the allowed values of the external id's part before the first ``:``
      (a channel, a repo), compared case-insensitively;
    - ``kinds``: the allowed item kinds;
    - ``occurred_from`` / ``occurred_before``: the range (``before`` exclusive) an item's
      ``occurred_at`` must fall in; items without a date stay.
    """

    groups: frozenset[str] | None = None
    kinds: frozenset[str] | None = None
    occurred_from: datetime | None = None
    occurred_before: datetime | None = None


@runtime_checkable
class Connector(Protocol):
    kind: str

    async def validate(self, config: dict[str, Any], credential: dict[str, Any] | None) -> None:
        """Check config and credential; raise :class:`ConnectorConfigError` if unusable."""
        ...

    def sync(
        self,
        config: dict[str, Any],
        credential: dict[str, Any] | None,
        cursor: dict[str, Any] | None,
    ) -> AsyncIterator[SyncEvent]:
        """Yield changes since ``cursor`` (``None``: from the start)."""
        ...


_registry: dict[str, Connector] = {}


def register(connector: Connector) -> Connector:
    """Register a connector for its ``kind``; a second one for the same kind is refused."""
    existing = _registry.get(connector.kind)
    if existing is not None and existing is not connector:
        raise ValueError(f"a connector for {connector.kind!r} is already registered")
    _registry[connector.kind] = connector
    return connector


def get_connector(kind: str) -> Connector:
    try:
        return _registry[kind]
    except KeyError:
        raise LookupError(f"no connector registered for {kind!r}") from None
