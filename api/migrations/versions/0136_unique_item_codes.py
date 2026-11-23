"""Every roadmap item has its own code; nothing shares one (the owner, Nov 23).

Items of one Ground Truth feature read the feature's code, so several items read the same
one. Within each group of a roadmap's items sharing a code, the item with the earliest start
date (ties: the earliest created) keeps it; each other one, in date order, takes the next free
feature number as its own code (its title's lead), as does an item with no code at all. An
item whose code is unique is never renumbered. Each change is audited (old code -> new code):
oracle.roadmap.renumber. Safe to run twice: a second run changes nothing.

The downgrade does nothing (the codes given stay, as a person's set_code would).

Revision ID: 0136_unique_item_codes
Revises: 0135_feature_comments
"""

from collections.abc import Sequence

from alembic import op
from sqlalchemy.orm import Session

revision: str = "0136_unique_item_codes"
down_revision: str | None = "0135_feature_comments"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    from oracle.roadmap.renumber import renumber

    with Session(bind=op.get_bind()) as session:
        renumber(session)
        session.flush()


def downgrade() -> None:
    pass
