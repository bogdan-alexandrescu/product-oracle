import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

SourceKind = Literal["upload", "github", "slack", "notion", "fireflies", "google_docs"]
SourceStatus = Literal["active", "paused", "error", "needs_attention"]


class ORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class SourceCreate(BaseModel):
    kind: SourceKind
    name: str = Field(min_length=1, max_length=200)
    # One of the current user's connections, of the provider the kind needs; none for uploads.
    connection_id: uuid.UUID | None = None
    # The allowlist: repos, channel ids, root pages, folders. Never secrets.
    config: dict[str, Any] = Field(default_factory=dict)


class SourcePatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    connection_id: uuid.UUID | None = None
    config: dict[str, Any] | None = None


class SourceOut(ORM):
    id: uuid.UUID
    kind: SourceKind
    name: str
    connection_id: uuid.UUID | None
    config: dict[str, Any]
    status: SourceStatus
    last_error: str | None
    last_synced_at: datetime | None
    created_at: datetime
    updated_at: datetime
    item_count: int = 0
    # False while no connector is registered for the kind (sync answers 422).
    connector_available: bool = True


class ConnectionChoice(BaseModel):
    id: uuid.UUID
    account_label: str | None
    status: str


class SourceKindOut(BaseModel):
    kind: SourceKind
    # Connection provider the kind syncs with; None for uploads.
    provider: str | None
    connector_available: bool
    # The current user's connections of that provider.
    connections: list[ConnectionChoice]


class SyncResult(BaseModel):
    source_id: uuid.UUID
    # completed: ran to the end; rate_limited: stopped cleanly, resumes from the saved
    # cursor; error: the source is now in status error (see error); superseded: the
    # source's config or connection changed while it ran, so nothing it read after its
    # last checkpoint was kept (sync again);
    # needs_attention: the saved selection breaks a newer rule, edit the source (see error).
    outcome: Literal["completed", "rate_limited", "error", "superseded", "needs_attention"]
    upserted: int = 0
    versions_written: int = 0
    deleted: int = 0
    checkpoints: int = 0
    retry_after: float | None = None
    error: str | None = None
    source: SourceOut


class FactorOut(BaseModel):
    value: float
    weight: float


class ConfidenceOut(BaseModel):
    value: float
    # Each factor's value and weight (source, freshness, mentions, goal_impact).
    breakdown: dict[str, FactorOut]
    # Below the company's "low" threshold: agents flag claims resting on it.
    low: bool


class ItemOut(ORM):
    id: uuid.UUID
    source_id: uuid.UUID
    source_kind: SourceKind
    external_id: str
    kind: str
    title: str | None
    url: str | None
    author: str | None
    acl: dict[str, Any]
    occurred_at: datetime | None
    source_updated_at: datetime | None
    deleted_at: datetime | None
    version_id: uuid.UUID | None
    fetched_at: datetime | None
    confidence: ConfidenceOut


class ItemDetail(ItemOut):
    content: str | None
    version_count: int


class UploadResult(BaseModel):
    items: list[ItemOut]
    # Files whose content was already stored (no new version).
    unchanged: list[str]


class SnapshotCreate(BaseModel):
    label: str | None = Field(default=None, max_length=200)
    # Defaults to now; must not be in the future.
    as_of: datetime | None = None


class SnapshotOut(ORM):
    id: uuid.UUID
    label: str | None
    as_of: datetime
    created_by: uuid.UUID | None
    created_at: datetime


class SearchHit(BaseModel):
    item: ItemOut
    snippet: str
    # Text relevance (ts_rank) and the score results are ordered by:
    # relevance x confidence.rank_weight(confidence).
    relevance: float
    score: float


class SearchResults(BaseModel):
    query: str
    as_of: datetime | None
    hits: list[SearchHit]
