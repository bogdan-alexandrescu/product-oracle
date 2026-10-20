"""The connector protocol: how a source kind (GitHub, Slack, Notion, uploads) is read.

A connector is stateless and does no database work. The sync engine
(``oracle.sources``) hands it the source's allowlist ``config``, its decrypted
``credential`` and the last ``cursor``, and stores what ``sync`` yields:

- :class:`ItemUpsert` creates or updates an item (a new version only when the
  content changes);
- :class:`ItemDelete` marks an item deleted;
- :class:`ItemUnavailable` reports one allowlisted item the connector cannot read
  (unshared, access removed); the rest of the source still syncs;
- :class:`CursorCheckpoint` is a resumable position: everything yielded before it is
  stored, then the cursor is saved, so an interrupted sync resumes from there.

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

# Added to a Google Docs source's config by the sync engine, never stored: the company's
# email domains (oracle.sources.service.company_domains). Config keys starting with "_"
# are refused from people.
COMPANY_DOMAINS = "_company_domains"
# The ids of the shared drives that are the company's, added the same way (S5).
COMPANY_SHARED_DRIVES = "_company_shared_drives"


class ConnectorError(Exception):
    """Base class of connector failures."""


class ConnectorConfigError(ConnectorError):
    """The config or credential is invalid (bad repo name, missing scope, ...)."""


class ConnectorBadInput(ConnectorConfigError):
    """The config itself is malformed (an id that is not an id): answered 400, before
    the provider is called."""


class ConnectorAuthError(ConnectorError):
    """The source rejected the credential (revoked, expired, insufficient)."""


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
class ItemUnavailable:
    """An allowlisted item that cannot be read now. Shown on the source, per item."""

    external_id: str
    # One short line for the owner, e.g. "No access: removed, or no longer shared".
    reason: str
    # The item's name when the source config does not name it (a doc found in a folder).
    name: str | None = None
    # "unavailable": cannot be read; "skipped": readable, left out on purpose (a doc in
    # a picked folder owned outside the company); "flagged": pulled in, with a warning;
    # "limited": a folder listing stopped at the source's cap.
    status: str = "unavailable"


@dataclass(frozen=True)
class CursorCheckpoint:
    cursor: dict[str, Any]


SyncEvent = ItemUpsert | ItemDelete | ItemUnavailable | CursorCheckpoint


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
