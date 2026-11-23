"""An approved roadmap version settles the stale items it keeps (the owner, Nov 23).

Approving a version now reconciles every potentially stale or under-review item it keeps
(oracle.roadmap.staleness.settle_on_approval). This applies the same rule to the flags
stored before: an item of its roadmap's latest approved version, kept as the version
before it had it (same key, title, outcome and horizon), whose flagging change is older
than the approval, is reconciled as a person's reconcile is (the PRD's latest approved
version and the section's hash as its anchor), with "Kept in version N, approved <Mon D>
by <name>" and the approver, audited. An item changed after the approval, one the
version changed, and the rows of older versions stay as they are. Freshness columns only:
an item's content and an approved version are never rewritten. Safe to run twice: a
settled item is no longer flagged.

The downgrade does nothing (the settled items were settled by the approval).

Revision ID: 0134_stale_settled_by_approval
Revises: 0133_null_run_cost
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0134_stale_settled_by_approval"
down_revision: str | None = "0133_null_run_cost"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SETTLE = """
WITH latest AS (
    SELECT DISTINCT ON (v.document_id)
        v.id, v.document_id, v.number, v.approved_at, v.approved_by
    FROM document_versions AS v
    JOIN documents AS d ON d.id = v.document_id
    WHERE d.kind = 'roadmap' AND v.approved_at IS NOT NULL
    ORDER BY v.document_id, v.number DESC
),
targets AS (
    SELECT
        i.id,
        i.tenant_id,
        i.item_key,
        i.freshness AS was,
        i.roadmap_document_id,
        l.approved_by,
        CASE WHEN u.id IS NOT NULL THEN :user_kind ELSE :machine_kind END
            || ':' || l.approved_by AS actor,
        'Kept in version ' || l.number || ', approved '
            || to_char(l.approved_at AT TIME ZONE 'UTC', 'Mon FMDD') || ' by '
            || COALESCE(
                NULLIF(btrim(u.name), ''),
                initcap(regexp_replace(split_part(u.email, '@', 1), '[._+-]+', ' ', 'g')),
                t.name,
                'an approver'
            ) AS reason,
        CASE
            WHEN prd.id IS NOT NULL AND (cur.number IS NULL OR prd.number >= cur.number)
            THEN prd.id
        END AS prd_version_id
    FROM roadmap_items AS i
    JOIN latest AS l ON l.id = i.roadmap_version_id
    JOIN change_events AS e ON e.id = i.caused_by_change_id AND e.created_at < l.approved_at
    LEFT JOIN users AS u ON u.id = l.approved_by
    LEFT JOIN api_tokens AS t ON t.id = l.approved_by
    LEFT JOIN document_versions AS cur
        ON cur.id = COALESCE(i.reconciled_version_id, i.prd_version_id)
    LEFT JOIN LATERAL (
        SELECT pv.id, pv.number
        FROM document_versions AS pv
        WHERE pv.document_id = i.prd_document_id AND pv.approved_at IS NOT NULL
        ORDER BY pv.number DESC
        LIMIT 1
    ) AS prd ON TRUE
    WHERE i.freshness IN ('potentially_stale', 'under_review')
      AND EXISTS (
        SELECT 1
        FROM roadmap_items AS b
        WHERE b.roadmap_version_id = (
                SELECT p.id
                FROM document_versions AS p
                WHERE p.document_id = l.document_id AND p.number < l.number
                ORDER BY p.number DESC
                LIMIT 1
            )
          AND b.item_key = i.item_key
          AND b.title IS NOT DISTINCT FROM i.title
          AND b.outcome IS NOT DISTINCT FROM i.outcome
          AND b.horizon IS NOT DISTINCT FROM i.horizon
      )
),
settled AS (
    UPDATE roadmap_items AS i
    SET freshness = 'reconciled',
        reconciled_by = targets.approved_by,
        reconciled_at = now(),
        note = targets.reason,
        reconciled_version_id = COALESCE(targets.prd_version_id, i.reconciled_version_id),
        reconciled_section_hash = CASE
            WHEN targets.prd_version_id IS NULL THEN i.reconciled_section_hash
            ELSE (
                SELECT s.content_hash
                FROM sections AS s
                WHERE s.version_id = targets.prd_version_id
                  AND s.section_key = i.prd_section_key
            )
        END
    FROM targets
    WHERE i.id = targets.id
    RETURNING i.id
)
INSERT INTO audit_events (id, tenant_id, actor, action, entity, entity_id, data)
SELECT
    gen_random_uuid(),
    targets.tenant_id,
    targets.actor,
    'roadmap.items.settled_by_approval',
    'document',
    targets.roadmap_document_id,
    jsonb_build_object(
        'items',
        jsonb_build_array(jsonb_build_object(
            'item', targets.item_key, 'id', targets.id, 'from', targets.was, 'to', 'reconciled'
        )),
        'reason', targets.reason,
        'via', 'migration 0134'
    )
FROM targets
JOIN settled ON settled.id = targets.id
"""


# The actor kinds as models.py names them ("user:<uuid>", or the API token's id).
STATEMENT = sa.text(SETTLE).bindparams(user_kind="user", machine_kind="token")


def upgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.execute(STATEMENT)


def downgrade() -> None:
    pass
