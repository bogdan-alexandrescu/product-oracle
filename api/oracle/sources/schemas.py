import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

SourceKind = Literal["upload", "github", "slack", "notion", "fireflies", "google_docs"]
SourceStatus = Literal["active", "paused", "error", "needs_attention"]


CONFIG_DESCRIPTION = (
    'What the source reads, by kind. github: {"repos": ["owner/name"]}. slack: '
    '{"channels": [channel id], "since"?: "YYYY-MM-DD", "until"?: "YYYY-MM-DD", '
    '"timezone"?: IANA zone the days are in (the Company time zone; UTC without one), '
    '"labels"?: {channel id: "#name"}}. notion: {"roots": [page id], "labels"?: '
    "{page id: title}}. labels only name the picks for people to read (at most 200 "
    "characters each; names of ids not picked are dropped): a save that changes labels "
    "alone reads nothing again and asks the provider nothing. Pick ids from the browse "
    "lists (list_slack_channels, list_notion_pages). Never secrets."
)


class ORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class SourceCreate(BaseModel):
    kind: SourceKind
    name: str = Field(min_length=1, max_length=200)
    # One of the current user's connections, of the provider the kind needs; none for uploads.
    connection_id: uuid.UUID | None = None
    # The allowlist: repos, channel ids, root pages, folders. Never secrets.
    config: dict[str, Any] = Field(default_factory=dict, description=CONFIG_DESCRIPTION)


class SourcePatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    connection_id: uuid.UUID | None = None
    config: dict[str, Any] | None = Field(default=None, description=CONFIG_DESCRIPTION)
    # The config_version the form loaded. When given and the source has changed since
    # (another save), the save is refused with 409 source_changed and nothing changes.
    # Required (422 base_version_required) when config or connection_id change; a rename
    # or pause may omit it, and if given it is checked.
    base_version: int | None = Field(default=None, ge=1)


class UnavailableItem(BaseModel):
    external_id: str
    reason: str
    # The item's name when the source config does not name it (a doc found in a folder).
    name: str | None = None
    # unavailable: cannot be read; skipped: left out on purpose (e.g. a doc in a picked
    # folder owned outside the company); flagged: pulled in with a warning; limited: a
    # folder listing stopped at the source's cap.
    status: Literal["unavailable", "skipped", "flagged", "limited"] = "unavailable"


class SourceOut(ORM):
    id: uuid.UUID
    kind: SourceKind
    name: str
    connection_id: uuid.UUID | None
    config: dict[str, Any]
    status: SourceStatus
    # Counts the saves that changed the config, connection or name; send it back as
    # base_version when saving.
    config_version: int = 1
    last_error: str | None
    # The last sync that finished; null when none has.
    last_synced_at: datetime | None
    # Set when a sync stopped part way after storing something (a rate limit): what it
    # stored is kept and the next sync resumes. Null once a sync finishes.
    partly_synced_at: datetime | None = None
    created_at: datetime
    updated_at: datetime
    item_count: int = 0
    # False while no connector is registered for the kind (sync answers 422).
    connector_available: bool = True
    # Allowlisted items the last completed sync could not read (unshared, removed), or
    # left out or flagged on purpose (see UnavailableItem.status).
    unavailable_items: list[UnavailableItem] = Field(default_factory=list)
    # Set when the source's connection should be signed in again, e.g. a Google
    # connection without drive.readonly: "Reconnect to choose files".
    reconnect_reason: str | None = None


class ConnectionChoice(BaseModel):
    id: uuid.UUID
    account_label: str | None
    status: str
    # "Reconnect to choose files" for a Google connection without drive.readonly.
    reconnect_reason: str | None = None
    # Fireflies: the GraphQL endpoint the connection reads (never the key).
    endpoint_url: str | None = None


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
    # source's config or connection (for Google Docs, also the company's Drive settings)
    # changed while it ran, so nothing it read after its last checkpoint was kept and the
    # next sync uses the new ones;
    # needs_attention: the saved selection breaks a newer rule, edit the source (see error).
    outcome: Literal["completed", "rate_limited", "error", "superseded", "needs_attention"]
    upserted: int = 0
    versions_written: int = 0
    deleted: int = 0
    checkpoints: int = 0
    retry_after: float | None = None
    error: str | None = None
    # Items this sync could not read; the rest of the source synced.
    unavailable: list[UnavailableItem] = Field(default_factory=list)
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


# --- coverage (A2) ------------------------------------------------------------------


class NotReadCounts(BaseModel):
    """Entries of ``unavailable_items`` by status (a missing status is unavailable)."""

    skipped: int
    unavailable: int
    flagged: int
    limited: int


class FreshnessCounts(BaseModel):
    """Live items by age: fresh up to one half-life, aging up to two, stale older."""

    fresh: int
    aging: int
    stale: int


class UsedCounts(BaseModel):
    evidence: int
    citations: int
    section_links: int
    # Distinct documents across the citations and the section links.
    documents: int


class SourceCoverage(BaseModel):
    source_id: uuid.UUID
    name: str
    kind: SourceKind
    status: SourceStatus
    last_synced_at: datetime | None
    # Live items; removed: soft-deleted (narrowed out, or deleted where they live).
    items: int
    removed: int
    not_read: NotReadCounts
    newest_at: datetime | None
    oldest_at: datetime | None
    freshness: FreshnessCounts
    used: UsedCounts


class CoverageList(BaseModel):
    as_of: datetime
    sources: list[SourceCoverage]


class KindCoverage(BaseModel):
    kind: str
    items: int
    newest_at: datetime | None
    half_life_days: float


class UsedItem(BaseModel):
    id: uuid.UUID
    title: str | None


class UsedEntity(BaseModel):
    id: uuid.UUID
    type: str
    key: str
    title: str
    status: str


class UsedDocument(BaseModel):
    slug: str
    title: str
    kind: str


class UsedIn(BaseModel):
    """One use of one of the source's items: baseline evidence (on an entity, or on an
    edge, shown on its source entity), a citation in a document version, or a section's
    evidence link."""

    kind: Literal["evidence", "citation", "section_link"]
    at: datetime
    item: UsedItem
    entity: UsedEntity | None = None
    document: UsedDocument | None = None
    version: int | None = None
    cite_key: str | None = None
    section_key: str | None = None
    section_title: str | None = None


class SourceCoverageDetail(SourceCoverage):
    by_kind: list[KindCoverage]
    not_read_items: list[UnavailableItem]
    # Newest first, one page (limit, offset); used_in_total counts them all.
    used_in: list[UsedIn]
    used_in_total: int


class CompanyMember(BaseModel):
    id: uuid.UUID
    email: str
    # The member's display name once people have one; null until then.
    name: str | None
    role: str


class CompanyKindCoverage(BaseModel):
    """One member's sources of one kind, as counts: never a name, id or item."""

    kind: SourceKind
    sources: int
    items: int
    # fresh / items; null with no items.
    fresh_share: float | None
    freshness: FreshnessCounts
    last_synced_at: datetime | None


class CompanyMemberCoverage(BaseModel):
    member: CompanyMember
    kinds: list[CompanyKindCoverage]


class CompanyCoverage(BaseModel):
    """Owners only (A2, owner 2026-10-21 "Coverage"): counts per active member and source
    kind. Nothing here can carry a source name, config, external id, item or not-read
    entry."""

    as_of: datetime
    members_total: int
    members_with_sources: int
    members: list[CompanyMemberCoverage]
