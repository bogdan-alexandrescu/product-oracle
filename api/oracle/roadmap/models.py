"""Roadmap and engineering alignment tables (CR-11, migration 0016_roadmap).

Nothing here replaces the roadmap document: a roadmap is still a ``documents`` row of
kind ``roadmap`` whose versions are reviewed, approved, exported and presented as before
(O4b). These tables add what a document's Markdown cannot carry:

- ``roadmap_items``: one row per item of a roadmap version, traced to the exact PRD
  version, section, feature and requirement ids (through the trace lane's section links
  and the baseline graph), with its blocker dependencies, validation gates, economics,
  and a freshness state of its own (§11.5);
- ``schedule_bases``: the verified estimates, capacity and commitments a dated milestone
  rests on (O4: never an invented date);
- ``product_tracks`` and ``track_milestones``: the product track an accepted PRD starts
  (V2b), its milestones, and the last monitoring snapshot;
- ``tracker_records``: engineering status read back from a tracker, read-only (E1).
  Oracle never writes to a tracker from here.
"""

import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    Text,
    UniqueConstraint,
    Uuid,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from oracle.db import Base, TenantScoped
from oracle.docs.models import _in
from oracle.v2.models import FRESHNESS, _fk, _json, _lock_version, _texts, _updated_at, _uuids

HORIZONS = ("now", "next", "later")
TRACK_STATUSES = ("active", "paused", "closed")
# The monitor's verdict on a track (oracle.roadmap.views.monitor).
TRACK_HEALTH = ("on_track", "at_risk", "off_track", "no_roadmap", "paused", "closed")
MILESTONE_STATUSES = ("planned", "done", "dropped")
BASIS_KINDS = ("estimate", "capacity", "commitment")
BASIS_STATUSES = ("verified", "withdrawn", "proposed", "rejected")
TRACKERS = ("linear", "jira", "github", "other")
TRACKER_STATES = ("todo", "in_progress", "done", "cancelled", "unknown")
# E1 Roadmap per PRD draft (migration 0034_draft_roadmaps): a draft's derivation. "none"
# (no row) is the API's word for a version imported before E1.
DRAFT_STATUSES = ("queued", "running", "ready", "failed", "superseded", "off", "skipped")
DRAFT_DEPTHS = ("quick", "standard", "deep")
# new_draft: queued by the version's import; derive: a person's Derive (never superseded).
DRAFT_VIA = ("new_draft", "derive")
# F2 Track health: the situations an alert names (oracle.roadmap.alerts), its states, and
# the tracker record fields whose changes are kept.
ALERT_KINDS = ("date_slip", "overdue", "cancelled", "ahead", "unplanned", "blocked", "stale",
               "prd_moved")  # fmt: skip
ALERT_STATES = ("open", "kept", "resolved")
RECORD_FIELDS = ("state", "target_date", "estimate", "raw_status")


class ProductTrack(TenantScoped, Base):
    """A product track: started by an accepted PRD, followed through its roadmap (V2b)."""

    __tablename__ = "product_tracks"
    __table_args__ = (
        UniqueConstraint("tenant_id", "prd_document_id"),
        CheckConstraint(_in("status", TRACK_STATUSES), name="status"),
    )

    prd_document_id: Mapped[uuid.UUID] = _fk("documents", nullable=False)
    # The accepted PRD version that started the track, and the one it follows now.
    started_version_id: Mapped[uuid.UUID | None] = _fk("document_versions", "SET NULL")
    current_version_id: Mapped[uuid.UUID | None] = _fk("document_versions", "SET NULL")
    roadmap_document_id: Mapped[uuid.UUID | None] = _fk("documents", "SET NULL")
    title: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(
        Text, nullable=False, default="active", server_default="active"
    )
    owner_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    created_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    # The last monitoring snapshot (health, at-risk item keys, next milestone, when).
    monitor: Mapped[dict[str, Any]] = _json()
    monitored_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Bumped by people's edits only (PATCH checks it): monitoring writes ``monitor``
    # without making a person's loaded copy stale.
    lock_version: Mapped[int] = _lock_version()
    updated_at: Mapped[datetime] = _updated_at()


class ScheduleBasis(TenantScoped, Base):
    """A verified estimate, capacity figure or commitment that supports a date (O4).

    ``reference`` is what a roadmap names in a milestone's ``date_source`` (a tracker
    issue key, a capacity plan); ``supports_date`` is the date it supports. It is
    recorded for one PRD (O4, owner 2026-10-19) and supports only that PRD's roadmap
    items; naming an ``item_key`` or a ``tracker_key`` narrows it to that item, or to the
    items that tracker issue is matched to. Who records it decides its status (F3,
    oracle.members.leads.date_rights): an engineering lead or an owner (an approver while
    no lead is named) verifies it at once; an approver's waits as ``proposed`` until a lead
    verifies or rejects it. Only a verified basis supports a date.
    """

    __tablename__ = "schedule_bases"
    __table_args__ = (
        CheckConstraint(_in("kind", BASIS_KINDS), name="kind"),
        CheckConstraint(_in("status", BASIS_STATUSES), name="status"),
        CheckConstraint("item_key IS NULL OR tracker_key IS NULL", name="one_key"),
        CheckConstraint(
            "status = 'proposed' OR status = 'rejected' OR verified_at IS NOT NULL",
            name="verified_at",
        ),
        Index("ix_schedule_bases_reference", "tenant_id", "reference"),
    )

    kind: Mapped[str] = mapped_column(Text, nullable=False)
    reference: Mapped[str] = mapped_column(Text, nullable=False)
    supports_date: Mapped[date] = mapped_column(Date, nullable=False)
    detail: Mapped[str | None] = mapped_column(Text)
    # The PRD whose roadmap items it supports (never null: O4).
    prd_document_id: Mapped[uuid.UUID] = _fk("documents", nullable=False)
    # Optionally narrowed to one roadmap item key, or to one tracker issue key (the
    # items its tracker records are matched to).
    item_key: Mapped[str | None] = mapped_column(Text)
    tracker_key: Mapped[str | None] = mapped_column(Text)
    # The tracker record it was read from, when it was.
    tracker_record_id: Mapped[uuid.UUID | None] = _fk("tracker_records", "SET NULL")
    status: Mapped[str] = mapped_column(
        Text, nullable=False, default="verified", server_default="verified"
    )
    verified_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    withdrawn_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    withdrawn_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    withdrawn_reason: Mapped[str | None] = mapped_column(Text)
    proposed_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    proposed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # The recorder's or verifier's note.
    note: Mapped[str | None] = mapped_column(Text)
    rejected_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    rejected_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    rejected_reason: Mapped[str | None] = mapped_column(Text)


class TrackMilestone(TenantScoped, Base):
    """A milestone of a track. Undated by default (Now/Next/Later, O4); a date needs at
    least one verified schedule basis supporting exactly that date."""

    __tablename__ = "track_milestones"
    __table_args__ = (
        UniqueConstraint("track_id", "name"),
        CheckConstraint(_in("horizon", HORIZONS), name="horizon"),
        CheckConstraint(_in("status", MILESTONE_STATUSES), name="status"),
        CheckConstraint(
            "target_date IS NULL OR cardinality(basis_ids) > 0", name="dated_needs_basis"
        ),
    )

    track_id: Mapped[uuid.UUID] = _fk("product_tracks", nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    horizon: Mapped[str] = mapped_column(Text, nullable=False, server_default="now")
    target_date: Mapped[date | None] = mapped_column(Date)
    basis_ids: Mapped[list[uuid.UUID]] = _uuids()
    item_keys: Mapped[list[str]] = _texts()
    status: Mapped[str] = mapped_column(
        Text, nullable=False, default="planned", server_default="planned"
    )
    created_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    lock_version: Mapped[int] = _lock_version()
    __mapper_args__ = {"version_id_col": lock_version}
    updated_at: Mapped[datetime] = _updated_at()


class TrackerRecord(TenantScoped, Base):
    """Engineering status read back from a tracker (E1), read-only: the latest state of
    one tracker issue, optionally matched to a roadmap item key of a track."""

    __tablename__ = "tracker_records"
    __table_args__ = (
        UniqueConstraint("tenant_id", "tracker", "external_ref"),
        CheckConstraint(_in("tracker", TRACKERS), name="tracker"),
        CheckConstraint(_in("state", TRACKER_STATES), name="state"),
        CheckConstraint("estimate IS NULL OR estimate >= 0", name="estimate"),
        Index("ix_tracker_records_prd_item", "tenant_id", "prd_document_id", "item_key"),
        Index("ix_tracker_records_source_item", "source_item_id"),
    )

    tracker: Mapped[str] = mapped_column(Text, nullable=False)
    external_ref: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str | None] = mapped_column(Text)
    url: Mapped[str | None] = mapped_column(Text)
    track_id: Mapped[uuid.UUID | None] = _fk("product_tracks", "SET NULL")
    item_key: Mapped[str | None] = mapped_column(Text)
    state: Mapped[str] = mapped_column(Text, nullable=False)
    # The tracker's own status name, as read.
    raw_status: Mapped[str | None] = mapped_column(Text)
    estimate: Mapped[Decimal | None] = mapped_column(Numeric(10, 2))
    estimate_unit: Mapped[str | None] = mapped_column(Text)
    target_date: Mapped[date | None] = mapped_column(Date)
    observed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    recorded_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    # F7 Link tracker issues: the PRD whose item it is matched to (by PRD and item key
    # while the record has no track), the synced issue it was linked from and is
    # refreshed from, who linked it, and when that source item went away for good.
    prd_document_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("documents.id", ondelete="SET NULL")
    )
    source_item_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("source_items.id", ondelete="SET NULL")
    )
    linked_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    linked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    refresh_lost_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = _updated_at()


class DraftRoadmap(TenantScoped, Base):
    """E1: the items-only roadmap of one PRD version (draft or approved), derived by a
    prd_draft_items run. Its items are ``roadmap_items`` rows with ``draft_roadmap_id``
    set; they never go stale (the next draft derives again)."""

    __tablename__ = "draft_roadmaps"
    __table_args__ = (
        UniqueConstraint("prd_version_id"),
        CheckConstraint(_in("status", DRAFT_STATUSES), name="status"),
        CheckConstraint(_in("depth", DRAFT_DEPTHS), name="depth"),
        CheckConstraint(_in("requested_via", DRAFT_VIA), name="via"),
        Index("ix_draft_roadmaps_prd_status", "tenant_id", "prd_document_id", "status"),
    )

    prd_document_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("documents.id", ondelete="CASCADE"), nullable=False
    )
    prd_version_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("document_versions.id", ondelete="CASCADE"), nullable=False
    )
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="queued")
    run_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("runs.id", ondelete="SET NULL")
    )
    # A user or API token id, like runs.created_by.
    requested_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    requested_via: Mapped[str] = mapped_column(Text, nullable=False, server_default="new_draft")
    depth: Mapped[str] = mapped_column(Text, nullable=False, server_default="standard")
    # {"items", "by_horizon", "problems"}, as the run's items check returned it.
    items_check: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    error: Mapped[str | None] = mapped_column(Text)
    ready_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = _updated_at()


class RoadmapItem(TenantScoped, Base):
    """One item of a roadmap version, traced to the PRD version it came from (§11.4).
    Or (E1) one item of a PRD draft's items-only roadmap (``draft_roadmap_id``): exactly
    one owner each.

    Rows of an approved roadmap version are never rewritten; only their freshness
    columns move (as ``artifact_dependencies`` do, §11.5).
    """

    __tablename__ = "roadmap_items"
    __table_args__ = (
        UniqueConstraint("roadmap_version_id", "item_key"),
        CheckConstraint(_in("horizon", HORIZONS), name="horizon"),
        CheckConstraint(_in("freshness", FRESHNESS), name="freshness"),
        CheckConstraint(
            "(roadmap_version_id IS NULL) <> (draft_roadmap_id IS NULL)", name="one_owner"
        ),
        Index("ix_roadmap_items_prd_section", "prd_version_id", "prd_section_key"),
        Index(
            "uq_roadmap_items_draft_key",
            "draft_roadmap_id",
            "item_key",
            unique=True,
            postgresql_where=text("draft_roadmap_id IS NOT NULL"),
        ),
    )

    roadmap_document_id: Mapped[uuid.UUID | None] = _fk("documents")
    roadmap_version_id: Mapped[uuid.UUID | None] = _fk("document_versions")
    draft_roadmap_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("draft_roadmaps.id", ondelete="CASCADE")
    )
    track_id: Mapped[uuid.UUID | None] = _fk("product_tracks", "SET NULL")
    run_id: Mapped[uuid.UUID | None] = _fk("runs", "SET NULL")
    item_key: Mapped[str] = mapped_column(Text, nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    outcome: Mapped[str | None] = mapped_column(Text)
    horizon: Mapped[str] = mapped_column(Text, nullable=False)
    # The exact PRD version and section the item came from, at that section's hash.
    prd_document_id: Mapped[uuid.UUID | None] = _fk("documents", "SET NULL")
    prd_version_id: Mapped[uuid.UUID | None] = _fk("document_versions", "SET NULL")
    prd_section_key: Mapped[str | None] = mapped_column(Text)
    prd_section_hash: Mapped[str | None] = mapped_column(Text)
    feature_id: Mapped[uuid.UUID | None] = _fk("entities", "SET NULL")
    requirement_ids: Mapped[list[uuid.UUID]] = _uuids()
    blocker_ids: Mapped[list[uuid.UUID]] = _uuids()
    depends_on: Mapped[list[str]] = _texts()
    # How each trace was made: [{"target": "feature", "id": ..., "via": "section_link"}].
    trace: Mapped[list[dict[str, Any]]] = _json("[]")
    # {"name", "date", "date_source", "basis_ids"}; a date only with a verified basis.
    milestone: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    validation_gates: Mapped[list[dict[str, Any]]] = _json("[]")
    economics: Mapped[dict[str, Any]] = _json()
    priority: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    confidence: Mapped[str | None] = mapped_column(Text)
    freshness: Mapped[str] = mapped_column(
        Text, nullable=False, default="fresh", server_default="fresh"
    )
    caused_by_change_id: Mapped[uuid.UUID | None] = _fk("change_events", "SET NULL")
    stale_since: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    stale_reasons: Mapped[list[str]] = _texts()
    reconciled_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    reconciled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # What a person confirmed the item still holds against (the PRD's approved version
    # and that section's hash). The anchor above stays as built; staleness compares
    # with this one once set.
    reconciled_version_id: Mapped[uuid.UUID | None] = _fk("document_versions", "SET NULL")
    reconciled_section_hash: Mapped[str | None] = mapped_column(Text)
    note: Mapped[str | None] = mapped_column(Text)
    updated_at: Mapped[datetime] = _updated_at()


CHANGE_SET_STATUSES = ("draft", "proposed", "discarded", "superseded")


class RoadmapChangeSet(TenantScoped, Base):
    """Edits to a roadmap's approved version, proposed as a new version (#346).

    Nobody edits an approved version in place: a change set is opened on the approved
    version (``base_version_id``) and holds its changes in order (add, move, defer, cut
    with a reason, reorder within a horizon). Proposing it imports the next roadmap
    version, with the base's items plus the changes, for the document's decider to
    approve. A roadmap has at most one draft change set. A later proposal while one waits
    supersedes it (``superseded``, ``superseded_by_version_id``): it can't be approved.
    """

    __tablename__ = "roadmap_change_sets"
    __table_args__ = (
        CheckConstraint(_in("status", CHANGE_SET_STATUSES), name="status"),
        Index(
            "ux_roadmap_change_sets_draft",
            "roadmap_document_id",
            unique=True,
            postgresql_where=text("status = 'draft'"),
        ),
    )

    roadmap_document_id: Mapped[uuid.UUID] = _fk("documents", nullable=False)
    base_version_id: Mapped[uuid.UUID] = _fk("document_versions", nullable=False)
    status: Mapped[str] = mapped_column(
        Text, nullable=False, default="draft", server_default="draft"
    )
    # [{"op": "add" | "move" | "defer" | "cut" | "reorder", ...}], applied in order.
    changes: Mapped[list[dict[str, Any]]] = _json("[]")
    proposed_version_id: Mapped[uuid.UUID | None] = _fk("document_versions", "SET NULL")
    # The later proposal's version that superseded this one's (status ``superseded``).
    superseded_by_version_id: Mapped[uuid.UUID | None] = _fk("document_versions", "SET NULL")
    created_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    lock_version: Mapped[int] = _lock_version()
    updated_at: Mapped[datetime] = _updated_at()


class TrackAlert(TenantScoped, Base):
    """One situation on one track (F2 Track health): a slip, drift either way, a blocker,
    a stale item or a moved PRD, synced by every monitoring check (oracle.roadmap.alerts).
    ``item_key`` is ``''`` for a track-level alert; a new ``fingerprint`` (the facts it
    rests on) opens a new alert."""

    __tablename__ = "track_alerts"
    __table_args__ = (
        UniqueConstraint("track_id", "item_key", "kind", "fingerprint"),
        CheckConstraint(_in("kind", ALERT_KINDS), name="kind"),
        CheckConstraint(_in("state", ALERT_STATES), name="state"),
        CheckConstraint("note IS NULL OR char_length(note) <= 500", name="note"),
        Index(
            "ix_track_alerts_open",
            "tenant_id",
            "state",
            postgresql_where=text("state <> 'resolved'"),
        ),
    )

    track_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("product_tracks.id", ondelete="CASCADE"), nullable=False
    )
    item_key: Mapped[str] = mapped_column(Text, nullable=False, server_default="")
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    fingerprint: Mapped[str] = mapped_column(Text, nullable=False)
    detail: Mapped[str] = mapped_column(Text, nullable=False)
    data: Mapped[dict[str, Any]] = _json()
    state: Mapped[str] = mapped_column(Text, nullable=False, default="open", server_default="open")
    opened_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    opened_change_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("change_events.id", ondelete="SET NULL")
    )
    kept_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    kept_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    note: Mapped[str | None] = mapped_column(Text)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class TrackerRecordEvent(TenantScoped, Base):
    """One field of a tracker record changed by an import: before and after (F2)."""

    __tablename__ = "tracker_record_events"
    __table_args__ = (
        CheckConstraint(_in("field", RECORD_FIELDS), name="field"),
        Index("ix_tracker_record_events_record", "record_id", "observed_at"),
    )

    record_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("tracker_records.id", ondelete="CASCADE"), nullable=False
    )
    observed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    field: Mapped[str] = mapped_column(Text, nullable=False)
    before: Mapped[str | None] = mapped_column(Text)
    after: Mapped[str | None] = mapped_column(Text)


# --- O5 lane 2: the public-safe variant (migration 0056_public_texts) -----------------

PUBLIC_STAGES = ("exploring", "planned", "in_progress", "shipped")
PUBLIC_TEXT_STATES = ("draft", "approved", "excluded")


class RoadmapPublicText(TenantScoped, Base):
    """One roadmap item's public text (spec-O5 §2): per (document, item key), so it
    carries over between versions while the item exists. Oracle drafts it (``public_text``
    job), a person approves or excludes it. ``source_hash`` is the item's title and
    outcome when the text was written: once it differs, the text is no longer approved."""

    __tablename__ = "roadmap_public_texts"
    __table_args__ = (
        UniqueConstraint("document_id", "item_key"),
        CheckConstraint("char_length(title) BETWEEN 1 AND 80", name="title"),
        CheckConstraint("char_length(description) <= 280", name="description"),
        CheckConstraint(_in("stage", PUBLIC_STAGES), name="stage"),
        CheckConstraint("announced_quarter ~ '^[0-9]{4}-Q[1-4]$'", name="announced_quarter"),
        CheckConstraint(_in("state", PUBLIC_TEXT_STATES), name="state"),
        CheckConstraint("state <> 'approved' OR approved_at IS NOT NULL", name="approved"),
    )

    document_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("documents.id", ondelete="CASCADE"), nullable=False
    )
    item_key: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, server_default="")
    stage: Mapped[str] = mapped_column(Text, nullable=False)
    announced_quarter: Mapped[str | None] = mapped_column(Text)
    changelog_url: Mapped[str | None] = mapped_column(Text)
    state: Mapped[str] = mapped_column(Text, nullable=False, server_default="draft")
    # "oracle" or the member's id.
    drafted_by: Mapped[str] = mapped_column(Text, nullable=False)
    approved_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # The leak-check warnings the approver ticked "I checked this" for.
    checked_warnings: Mapped[list[str]] = _texts()
    source_hash: Mapped[str] = mapped_column(Text, nullable=False)
    updated_at: Mapped[datetime] = _updated_at()


class RoadmapPublicCheck(TenantScoped, Base):
    """A person checked the exact Public page of one publication (spec-O5 §2). It holds
    while the page's ``content_hash`` still matches; any change lapses it."""

    __tablename__ = "roadmap_public_checks"
    __table_args__ = (
        Index("ix_roadmap_public_checks_publication", "publication_id", "checked_at"),
    )

    document_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("documents.id", ondelete="CASCADE"), nullable=False
    )
    version_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("document_versions.id", ondelete="CASCADE"), nullable=False
    )
    publication_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("document_publications.id", ondelete="CASCADE"), nullable=False
    )
    checked_by: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    checked_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    shown_item_keys: Mapped[list[str]] = _texts()
    content_hash: Mapped[str] = mapped_column(Text, nullable=False)
