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
- ``normalize_config(config)`` returns the config in one canonical form (ids stripped,
  without repeats, sorted), so the same selection saved in another order is the same
  selection; the service stores it normalised and the engine fingerprints it so;
- ``rescope_cursor(old_cursor, new_config)`` returns the cursor to resume from after the
  selection changed (``None``: from the start). Keep what upstream deletes are compared
  against; drop what would skip re-reading.

The engine notices a changed selection (config or connection) by a fingerprint it keeps
in the saved cursor under :data:`SCOPE_KEY`; connectors never see that key.

A connector whose class sets ``prunes = True`` also receives ``known``, an async callable
returning the external ids of the source's stored (not deleted) items, so a full pass
can delete what its config no longer selects and skip what is already stored.

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

from collections.abc import AsyncIterator, Callable
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
    credential itself may still be good. A sync fails the source (status ``error``) and
    leaves the connection active; browsing does not mark the connection expired either.
    Only a :class:`ConnectorAuthError` that is not this (a 401, a revoked key) expires
    the connection."""


class ConnectorNeedsAttention(ConnectorError):
    """The source cannot be read as it is until its owner acts (a Slack connection
    holding a bot token, say): the sync keeps what it stored up to its last checkpoint
    and the source shows the message as needing attention. Stored items are kept."""


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
    # Where in the selection it came from; see :attr:`Scope.provenance`.
    provenance: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.kind not in ITEM_KINDS:
            raise ValueError(f"unknown item kind {self.kind!r}")


@dataclass(frozen=True)
class ItemDelete:
    external_id: str


@dataclass(frozen=True)
class CursorCheckpoint:
    cursor: dict[str, Any]


@dataclass(frozen=True)
class Attention:
    """A part of the selection could not be read (a private channel the person left):
    the sync goes on with the rest and ends with the source needing attention, showing
    ``message``. Nothing of that part is deleted; its cursor state is kept."""

    message: str


SyncEvent = ItemUpsert | ItemDelete | CursorCheckpoint | Attention

# The key of the saved cursor holding the engine's fingerprint of the selection.
SCOPE_KEY = "_scope"


@dataclass(frozen=True)
class Scope:
    """What a selection keeps. Every field that is set narrows it:

    - ``groups``: the allowed values of the external id's part before the first ``:``
      (a channel, a repo), compared case-insensitively;
    - ``kinds``: the allowed item kinds;
    - ``occurred_from`` / ``occurred_before``: the range (``before`` exclusive) an item's
      ``occurred_at`` must fall in; items without a date stay;
    - ``provenance``: pairs of (key, allowed values): an item stays only if, for at least
      one pair, its stored provenance holds one of the values under the key. An item whose
      provenance is unknown (empty, or without the key) is not shown to be inside, so it
      goes.
    """

    groups: frozenset[str] | None = None
    kinds: frozenset[str] | None = None
    occurred_from: datetime | None = None
    occurred_before: datetime | None = None
    provenance: tuple[tuple[str, frozenset[str]], ...] | None = None


def scope_narrows(old: Scope, new: Scope) -> bool:
    """Whether ``new`` keeps strictly less than ``old`` and nothing ``old`` did not: no
    new pick, no wider date. Such a change needs no provider call to be trusted (S5,
    owner 2026-10-20: a narrowing save makes none); an unconstrained field of ``old``
    admits anything, an unconstrained field of ``new`` under a constrained ``old`` is wider."""
    if new == old:
        return False

    def within(n: Any, o: Any, inside: Callable[[Any, Any], bool]) -> bool:
        if o is None:
            return True
        return n is not None and inside(n, o)

    def picks(n: tuple[tuple[str, frozenset[str]], ...], o: tuple[tuple[str, frozenset[str]], ...]):
        allowed = dict(o)
        return all(key in allowed and values <= allowed[key] for key, values in n)

    return (
        within(new.groups, old.groups, lambda n, o: n <= o)
        and within(new.kinds, old.kinds, lambda n, o: n <= o)
        and within(new.occurred_from, old.occurred_from, lambda n, o: n >= o)
        and within(new.occurred_before, old.occurred_before, lambda n, o: n <= o)
        and within(new.provenance, old.provenance, picks)
    )


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
