"""Launches and changelog (H6): launch tiers, checklists, changelog entries and notes to
the people who asked

Adds four tables:

- ``launches``: one shipped unit (one roadmap item of a track by default), its state
  (planned, ready, launched, cancelled), its tier (set by an approver; Oracle's
  suggestion in ``tier_suggestion`` until then), owner and kit run. One live launch per
  set of items of a track (``ux_launches_item``, cancelled ones excepted);
- ``launch_tasks``: the tier's checklist and the tasks people add, with the text
  Oracle drafted; a skipped task carries its reason;
- ``changelog_entries``: dated, categorized lines (Keep a Changelog), internal or
  public, draft until published;
- ``requester_notes``: a personal note to one person who asked (a request, a member,
  or someone added by hand). ``contact_hint`` holds only what the requester gave;
  ``asked`` their own words, quoted in the note.

``runs.flow`` gains ``launch_kit`` and ``checkpoints.kind`` gains ``launch_review``,
extended from what the database holds (other lanes' values survive in either order).

Additive. The downgrade drops the four tables and the two values; it refuses while
``launch_kit`` runs exist (their checkpoints included), unless ``-x force=1`` is given,
which deletes those runs first.

Revision ID: 0020_launches
Revises: 0014_member_follow_up_retry
"""

import re
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import context, op
from sqlalchemy.dialects import postgresql

revision: str = "0020_launches"
down_revision: str | None = "0014_member_follow_up_retry"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

FLOW_CHECK = ("runs", "ck_runs_flow", "flow")
CHECKPOINT_CHECK = ("checkpoints", "ck_checkpoints_kind", "kind")
FLOWS = ("launch_kit",)
CHECKPOINTS = ("launch_review",)
TABLES = ("requester_notes", "changelog_entries", "launch_tasks", "launches")


# --- oracle.migration_checks, frozen here as of this revision ----------------------------
# A migration must not import application code that can change after it ships; this is
# that module's behaviour, copied.

_VALUE = re.compile(r"'((?:[^']|'')*)'")


def check_values(table: str, constraint: str) -> list[str]:
    """The values a ``column IN (...)`` check constraint allows now, in its order."""
    definition = op.get_bind().scalar(
        sa.text(
            "SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c "
            "JOIN pg_class t ON t.oid = c.conrelid "
            "WHERE c.conname = :name AND t.relname = :table AND c.contype = 'c'"
        ),
        {"name": constraint, "table": table},
    )
    if definition is None:
        raise RuntimeError(f"check constraint {constraint} on {table} not found")
    return [v.replace("''", "'") for v in _VALUE.findall(definition)]


def _replace(table: str, constraint: str, column: str, values: list[str]) -> None:
    listed = ", ".join("'" + v.replace("'", "''") + "'" for v in values)
    op.drop_constraint(op.f(constraint), table, type_="check")
    op.create_check_constraint(op.f(constraint), table, f"{column} IN ({listed})")


def add_check_values(table: str, constraint: str, column: str, values: tuple[str, ...]) -> None:
    """Allow ``values`` too, keeping every value the constraint already allows."""
    now = check_values(table, constraint)
    missing = [v for v in values if v not in now]
    if missing:
        _replace(table, constraint, column, now + missing)


def remove_check_values(table: str, constraint: str, column: str, values: tuple[str, ...]) -> None:
    """Stop allowing ``values`` only, keeping every other value the constraint allows."""
    now = check_values(table, constraint)
    kept = [v for v in now if v not in values]
    if kept != now:
        _replace(table, constraint, column, kept)


def upgrade() -> None:
    add_check_values(*FLOW_CHECK, FLOWS)
    add_check_values(*CHECKPOINT_CHECK, CHECKPOINTS)
    op.create_table(
        "launches",
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("track_id", sa.Uuid(), nullable=True),
        sa.Column("roadmap_version_id", sa.Uuid(), nullable=True),
        sa.Column("item_keys", postgresql.ARRAY(sa.Text()), server_default="{}", nullable=False),
        sa.Column("state", sa.Text(), server_default="planned", nullable=False),
        sa.Column("tier", sa.SmallInteger(), nullable=True),
        sa.Column("tier_set_by", sa.Uuid(), nullable=True),
        sa.Column(
            "tier_suggestion",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="{}",
            nullable=False,
        ),
        sa.Column("owner_id", sa.Uuid(), nullable=True),
        sa.Column("ready_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("launched_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("launched_by", sa.Uuid(), nullable=True),
        sa.Column("cancel_reason", sa.Text(), nullable=True),
        sa.Column("kit_run_id", sa.Uuid(), nullable=True),
        sa.Column("kit_error", sa.Text(), nullable=True),
        sa.Column("created_by", sa.Uuid(), nullable=True),
        sa.Column("lock_version", sa.Integer(), server_default="1", nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "state IN ('planned', 'ready', 'launched', 'cancelled')", name=op.f("ck_launches_state")
        ),
        sa.CheckConstraint("tier BETWEEN 1 AND 3", name=op.f("ck_launches_tier")),
        sa.ForeignKeyConstraint(
            ["kit_run_id"],
            ["runs.id"],
            name=op.f("fk_launches_kit_run_id_runs"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["roadmap_version_id"],
            ["document_versions.id"],
            name=op.f("fk_launches_roadmap_version_id_document_versions"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_launches_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["track_id"],
            ["product_tracks.id"],
            name=op.f("fk_launches_track_id_product_tracks"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_launches")),
    )
    op.create_index(op.f("ix_launches_kit_run_id"), "launches", ["kit_run_id"], unique=False)
    op.create_index(
        op.f("ix_launches_roadmap_version_id"), "launches", ["roadmap_version_id"], unique=False
    )
    op.create_index(op.f("ix_launches_tenant_id"), "launches", ["tenant_id"], unique=False)
    op.create_index(op.f("ix_launches_track_id"), "launches", ["track_id"], unique=False)
    op.create_index(
        "ux_launches_item",
        "launches",
        ["tenant_id", "track_id", "item_keys"],
        unique=True,
        postgresql_where=sa.text("state <> 'cancelled'"),
    )
    op.create_table(
        "changelog_entries",
        sa.Column("launch_id", sa.Uuid(), nullable=True),
        sa.Column("category", sa.Text(), nullable=False),
        sa.Column("audience", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("body", sa.Text(), server_default="", nullable=False),
        sa.Column("released_on", sa.Date(), nullable=False),
        sa.Column("status", sa.Text(), server_default="draft", nullable=False),
        sa.Column("published_by", sa.Uuid(), nullable=True),
        sa.Column("published_actor", sa.Text(), nullable=True),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_actor", sa.Text(), nullable=False),
        sa.Column("lock_version", sa.Integer(), server_default="1", nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "audience IN ('internal', 'public')", name=op.f("ck_changelog_entries_audience")
        ),
        sa.CheckConstraint(
            "category IN ('added', 'changed', 'deprecated', 'removed', 'fixed', 'security')",
            name=op.f("ck_changelog_entries_category"),
        ),
        sa.CheckConstraint(
            "status IN ('draft', 'published', 'withdrawn')",
            name=op.f("ck_changelog_entries_status"),
        ),
        sa.ForeignKeyConstraint(
            ["launch_id"],
            ["launches.id"],
            name=op.f("fk_changelog_entries_launch_id_launches"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_changelog_entries_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_changelog_entries")),
    )
    op.create_index(
        op.f("ix_changelog_entries_launch_id"), "changelog_entries", ["launch_id"], unique=False
    )
    op.create_index(
        op.f("ix_changelog_entries_tenant_id"), "changelog_entries", ["tenant_id"], unique=False
    )
    op.create_table(
        "launch_tasks",
        sa.Column("launch_id", sa.Uuid(), nullable=False),
        sa.Column("key", sa.Text(), nullable=True),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("audience", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), server_default="todo", nullable=False),
        sa.Column("owner_id", sa.Uuid(), nullable=True),
        sa.Column("body", sa.Text(), nullable=True),
        sa.Column("skip_reason", sa.Text(), nullable=True),
        sa.Column("done_by", sa.Uuid(), nullable=True),
        sa.Column("done_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("lock_version", sa.Integer(), server_default="1", nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "audience IN ('internal', 'external')", name=op.f("ck_launch_tasks_audience")
        ),
        sa.CheckConstraint(
            "status <> 'skipped' OR skip_reason IS NOT NULL",
            name=op.f("ck_launch_tasks_skip_reason"),
        ),
        sa.CheckConstraint(
            "status IN ('todo', 'drafted', 'done', 'skipped')", name=op.f("ck_launch_tasks_status")
        ),
        sa.ForeignKeyConstraint(
            ["launch_id"],
            ["launches.id"],
            name=op.f("fk_launch_tasks_launch_id_launches"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_launch_tasks_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_launch_tasks")),
    )
    op.create_index(op.f("ix_launch_tasks_launch_id"), "launch_tasks", ["launch_id"], unique=False)
    op.create_index(op.f("ix_launch_tasks_tenant_id"), "launch_tasks", ["tenant_id"], unique=False)
    op.create_table(
        "requester_notes",
        sa.Column("launch_id", sa.Uuid(), nullable=False),
        sa.Column("requester_kind", sa.Text(), nullable=False),
        sa.Column("request_id", sa.Uuid(), nullable=True),
        sa.Column("member_id", sa.Uuid(), nullable=True),
        sa.Column("display_name", sa.Text(), nullable=False),
        sa.Column("contact_hint", sa.Text(), nullable=True),
        sa.Column("asked", sa.Text(), nullable=True),
        sa.Column("body", sa.Text(), nullable=True),
        sa.Column("status", sa.Text(), server_default="drafted", nullable=False),
        sa.Column("channel", sa.Text(), nullable=True),
        sa.Column("sent_on", sa.Date(), nullable=True),
        sa.Column("sent_by", sa.Uuid(), nullable=True),
        sa.Column("skip_reason", sa.Text(), nullable=True),
        sa.Column("notified_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "channel IS NULL OR channel IN ('email', 'slack', 'call', 'in_app', 'other')",
            name=op.f("ck_requester_notes_channel"),
        ),
        sa.CheckConstraint(
            "requester_kind IN ('request', 'member', 'manual')",
            name=op.f("ck_requester_notes_requester_kind"),
        ),
        sa.CheckConstraint(
            "status IN ('drafted', 'sent', 'skipped', 'notified')",
            name=op.f("ck_requester_notes_status"),
        ),
        sa.ForeignKeyConstraint(
            ["launch_id"],
            ["launches.id"],
            name=op.f("fk_requester_notes_launch_id_launches"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_requester_notes_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_requester_notes")),
        sa.UniqueConstraint(
            "launch_id",
            "requester_kind",
            "request_id",
            "member_id",
            name=op.f("uq_requester_notes_launch_id_requester_kind_request_id_member_id"),
        ),
    )
    op.create_index(
        op.f("ix_requester_notes_launch_id"), "requester_notes", ["launch_id"], unique=False
    )
    op.create_index(
        op.f("ix_requester_notes_tenant_id"), "requester_notes", ["tenant_id"], unique=False
    )


def downgrade() -> None:
    bind = op.get_bind()
    kits = bind.scalar(sa.text("SELECT count(*) FROM runs WHERE flow = 'launch_kit'"))
    if kits:
        if context.get_x_argument(as_dictionary=True).get("force") not in ("1", "true"):
            raise RuntimeError(
                f"{kits} launch_kit runs exist: a downgrade would leave runs of an unknown "
                "flow. Downgrade with -x force=1 to delete them first."
            )
        op.execute("DELETE FROM runs WHERE flow = 'launch_kit'")
    op.execute("DELETE FROM checkpoints WHERE kind = 'launch_review'")
    for table in TABLES:
        op.drop_table(table)
    remove_check_values(*CHECKPOINT_CHECK, CHECKPOINTS)
    remove_check_values(*FLOW_CHECK, FLOWS)
