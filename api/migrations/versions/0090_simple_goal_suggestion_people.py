"""People's goal suggestions: a person files a suggestion next to Oracle's.

- ``simple_goal_suggestions.proposed_by``: the person who filed it (origin ``person``);
  null for Oracle's (``auto``, ``on_demand``).
- ``ck_simple_goal_suggestions_origin`` widens to ``('auto', 'on_demand', 'person')``.

The downgrade drops people's suggestions, the column, and narrows the check back.

Revision ID: 0090_goal_suggestion_people
Revises: 0089_ritual_attendees_edited_at
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0090_goal_suggestion_people"
down_revision: str | None = "0089_ritual_attendees_edited_at"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

T = "simple_goal_suggestions"
CK = f"ck_{T}_origin"


def upgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.add_column(T, sa.Column("proposed_by", sa.Uuid()))
    op.execute(f"ALTER TABLE {T} DROP CONSTRAINT {CK}")
    op.execute(
        f"ALTER TABLE {T} ADD CONSTRAINT {CK} CHECK (origin IN ('auto', 'on_demand', 'person'))"
    )


def downgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.execute(f"DELETE FROM {T} WHERE origin = 'person'")
    op.execute(f"ALTER TABLE {T} DROP CONSTRAINT {CK}")
    op.execute(f"ALTER TABLE {T} ADD CONSTRAINT {CK} CHECK (origin IN ('auto', 'on_demand'))")
    op.drop_column(T, "proposed_by")
