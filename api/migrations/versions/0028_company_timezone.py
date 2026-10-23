"""One Company time zone (owner decision 2026-10-22)

The weekly alignment report has no time zone of its own any more: it reads the Company
time zone (``company_timezone``), as goals' "today" and the rituals do. A company whose
``alignment_report`` setting holds a ``timezone`` gets it as its ``company_timezone``
when it has none yet, and the report's value loses the key.

The downgrade gives every stored ``alignment_report`` the company's zone back (UTC when
none is set); ``company_timezone`` stays (0026_rituals' downgrade drops it).

Revision ID: 0028_company_timezone
Revises: 0027_outcome_tracking
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0028_company_timezone"
down_revision: str | None = "0027_outcome_tracking"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


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


def downgrade() -> None:
    op.execute(
        """
        UPDATE tenant_settings r
        SET value = r.value || jsonb_build_object('timezone', COALESCE(
            (SELECT c.value FROM tenant_settings c
             WHERE c.tenant_id = r.tenant_id AND c.key = 'company_timezone'),
            '"UTC"'::jsonb))
        WHERE r.key = 'alignment_report'
        """
    )
