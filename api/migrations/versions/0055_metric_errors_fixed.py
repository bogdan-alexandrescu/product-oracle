"""#565 review minor: a metric error stored before #565 becomes a fixed sentence

Before #565 a failed PostHog pull stored PostHog's own text (redacted, at most 300
characters) in ``metrics.last_error``, which every member reads. #565 stores fixed
sentences only; this revision rewrites the older rows: a "Could not reach PostHog: ..."
text becomes "Could not reach PostHog", any other text that is not one of Oracle's own
sentences or query refusals ("query: ...") becomes the query-failed sentence. A clear
error stays clear. The original text is not kept anywhere.

Live-safe: one UPDATE over the PostHog metrics with an error (a handful of rows).

The downgrade changes nothing (the old text is gone).

Revision ID: 0055_metric_errors_fixed
Revises: 0054_reply_opened
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0055_metric_errors_fixed"
down_revision: str | None = "0054_reply_opened"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"
# Copied, not imported: a migration keeps the words of its day.
QUERY_FAILED = "PostHog could not run the query; the details are in Oracle's server log"
UNREACHABLE = "Could not reach PostHog"
KEPT = (
    QUERY_FAILED,
    UNREACHABLE,
    "Analytics disconnected",
    "The query must return one row with one number",
    "PostHog's answer was not JSON",
)


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.get_bind().execute(
        sa.text(
            "UPDATE metrics SET last_error = CASE "
            "WHEN last_error LIKE 'Could not reach PostHog%' THEN :unreachable "
            "ELSE :failed END "
            "WHERE source = 'posthog' AND last_error IS NOT NULL "
            "AND last_error NOT LIKE 'query: %' AND NOT (last_error = ANY(:kept))"
        ),
        {"unreachable": UNREACHABLE, "failed": QUERY_FAILED, "kept": list(KEPT)},
    )


def downgrade() -> None:
    pass
