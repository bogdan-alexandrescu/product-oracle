"""One Company time zone (owner decision 2026-10-22)

The weekly alignment report has no time zone of its own any more: it reads the Company
time zone (``company_timezone``), as goals' "today" and the rituals do. A company whose
``alignment_report`` setting holds a ``timezone`` gets it as its ``company_timezone``
when it has none yet, and the report's value loses the key.

Rituals have no zone of their own either (owner decision 2026-10-22, one zone): a ritual
stored in another zone than the Company time zone (America/Los_Angeles when none is
set, the default from the same day) moves to it, with its next date recomputed there.

The downgrade gives every stored ``alignment_report`` the company's zone back
(America/Los_Angeles when none is set); ``company_timezone`` stays (0026_rituals'
downgrade drops it), and so do the rituals' zones (each is a valid schedule).

Revision ID: 0028_company_timezone
Revises: 0027_outcome_tracking
"""

import json
from collections.abc import Sequence
from datetime import UTC, datetime

import sqlalchemy as sa
from alembic import op

from oracle.rituals.schedule import next_occurrence

revision: str = "0028_company_timezone"
down_revision: str | None = "0027_outcome_tracking"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# The Company time zone of a company that never set one, as of this revision.
DEFAULT_ZONE = "America/Los_Angeles"


def upgrade() -> None:
    op.execute(
        """
        INSERT INTO tenant_settings (id, tenant_id, key, value)
        SELECT gen_random_uuid(), r.tenant_id, 'company_timezone', r.value -> 'timezone'
        FROM tenant_settings r
        WHERE r.key = 'alignment_report'
          AND jsonb_typeof(r.value -> 'timezone') = 'string'
          AND NOT EXISTS (
              SELECT 1 FROM tenant_settings c
              WHERE c.tenant_id = r.tenant_id AND c.key = 'company_timezone'
          )
        """
    )
    op.execute(
        "UPDATE tenant_settings SET value = value - 'timezone' "
        "WHERE key = 'alignment_report' AND value -> 'timezone' IS NOT NULL"
    )
    _rituals_on_the_company_zone()


def _rituals_on_the_company_zone() -> None:
    conn = op.get_bind()
    rows = conn.execute(
        sa.text(
            """
            SELECT r.id, r.schedule, r.status, z.zone
            FROM rituals r
            CROSS JOIN LATERAL (
                SELECT COALESCE(
                    (SELECT c.value #>> '{}' FROM tenant_settings c
                     WHERE c.tenant_id = r.tenant_id AND c.key = 'company_timezone'),
                    :default
                ) AS zone
            ) z
            WHERE r.schedule ->> 'timezone' IS DISTINCT FROM z.zone
            """
        ),
        {"default": DEFAULT_ZONE},
    ).all()
    now = datetime.now(UTC)
    for ritual_id, schedule, status, zone in rows:
        moved = {**schedule, "timezone": zone}
        conn.execute(
            sa.text(
                "UPDATE rituals SET schedule = CAST(:s AS jsonb), next_due_at = :n, "
                "lock_version = lock_version + 1 WHERE id = :id"
            ),
            {
                "s": json.dumps(moved),
                "n": next_occurrence(moved, now) if status == "active" else None,
                "id": ritual_id,
            },
        )


def downgrade() -> None:
    op.execute(
        """
        UPDATE tenant_settings r
        SET value = r.value || jsonb_build_object('timezone', COALESCE(
            (SELECT c.value FROM tenant_settings c
             WHERE c.tenant_id = r.tenant_id AND c.key = 'company_timezone'),
            '"America/Los_Angeles"'::jsonb))
        WHERE r.key = 'alignment_report'
        """
    )
