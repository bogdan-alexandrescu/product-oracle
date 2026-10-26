"""C1 Start a PRD (#599 re-review): release the requests behind briefs archived before

Archiving a brief that made no PRD now releases the requests behind it (decided "Release
on archive", 2026-10-25). Briefs archived before this revision kept theirs, hidden from
every new brief with no way to free them: this data step clears ``intake_id`` on each
request behind an archived brief that no PRD links (a request with a PRD keeps both).

Live-safe: one UPDATE on the few rows behind archived briefs; no schema change.

The downgrade does nothing: which brief a released request was behind is not kept (the
audit log names it), and a request may since be behind another brief.

Revision ID: 0055_release_archived_briefs
Revises: 0054_reply_opened
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0055_release_archived_briefs"
down_revision: str | None = "0054_reply_opened"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"

RELEASE = (
    "UPDATE product_requests SET intake_id = NULL, updated_at = now(), "
    "lock_version = lock_version + 1 "
    "WHERE document_id IS NULL AND intake_id IN "
    "(SELECT id FROM product_intakes WHERE status = 'archived')"
)


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.execute(RELEASE)


def downgrade() -> None:
    pass
