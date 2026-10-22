"""Who reads, writes and manages a discussion (G1; owner, Discuss access, 2026-10-20).

- **Open** (the default): everyone who can see the subject reads it
  (:func:`can_read_subject`). Viewers read; commenters and up write, follow and mention.
- **Private**: only the people in it read it, and only the starter adds or removes people.
  Everyone else sees that a private discussion exists, and nothing else.
- Closing and reopening: the starter, or any approver who can read it.
- Making a private discussion open: the starter alone (G1 "Open later?", 2026-10-21), never
  on a panel chat or while rule 3.4.3 applies.
- Rule 3.4.3: a discussion on its author's own private finding is the author's alone;
  nobody is added while the finding stays below Summary, and nobody else learns it exists.

The rules are plain functions of a :class:`Seat`, so the truth table is tested without a
database; the routes build the seat from the caller and the rows.
"""

import uuid
from dataclasses import dataclass
from typing import TYPE_CHECKING

from sqlalchemy.ext.asyncio import AsyncSession

from oracle.authz import has_role
from oracle.intake import sharing
from oracle.v2.models import KnowledgeGap, ProductIntake

if TYPE_CHECKING:
    from oracle.auth.deps import Principal
    from oracle.discussions.models import Discussion


@dataclass(frozen=True)
class Seat:
    """The caller as one discussion sees them."""

    role: str
    visibility: str
    # In it now (not left or removed).
    participant: bool
    starter: bool
    # Rule 3.4.3 applies now: the author's own finding is still below Summary.
    author_only: bool = False
    origin: str = "discuss"


def can_read(s: Seat) -> bool:
    return s.visibility == "open" or s.participant


def can_write(s: Seat) -> bool:
    """Post, edit their own messages, suggest (G3): commenters and up who read it."""
    return can_read(s) and has_role(s.role, "commenter")


def can_add(s: Seat) -> bool:
    """Add someone else (a pick, or a mention of someone not in it)."""
    if s.author_only:
        return False
    if s.visibility == "private":
        return s.starter and s.participant
    return has_role(s.role, "commenter")


def can_follow(s: Seat) -> bool:
    """Add themselves: any reader of an open discussion."""
    return s.visibility == "open"


def can_close(s: Seat) -> bool:
    return can_read(s) and (s.starter or has_role(s.role, "approver"))


def can_manage(s: Seat) -> bool:
    """Rename, change visibility, write the summary and share it: the starter."""
    return s.starter and can_read(s)


def can_make_open(s: Seat) -> bool:
    return (
        s.visibility == "private"
        and s.starter
        and s.participant
        and not s.author_only
        and s.origin != "panel"
    )


async def hidden_finding(db: AsyncSession, gap_id: uuid.UUID) -> tuple[ProductIntake, bool] | None:
    """(intake, whether the gap is its author's private finding below Summary), or None
    when the gap has no intake. A gap everyone else cannot see is such a finding (S6)."""
    gap = await db.get(KnowledgeGap, gap_id)
    if gap is None or gap.intake_id is None:
        return None
    intake = await db.get(ProductIntake, gap.intake_id)
    if intake is None:
        return None
    reg = sharing.registry(intake)
    return intake, sharing.gap_view(gap, reg, sharing.EVERYONE) is None


async def can_read_subject(db: AsyncSession, principal: "Principal", d: "Discussion") -> bool:
    """Whether the caller can see the discussion's subject: every active member today
    (every document is readable by viewers and up), except a gap, which reads as
    ``sharing.gap_view`` allows. A subject restricted later restricts its discussions here."""
    if d.subject_kind != "gap":
        return True
    gap = await db.get(KnowledgeGap, uuid.UUID(d.subject["gap_id"]))
    if gap is None:
        return False
    if gap.intake_id is None:
        return True
    intake = await db.get(ProductIntake, gap.intake_id)
    if intake is None:
        return False
    view = sharing.gap_view(gap, sharing.registry(intake), sharing.viewer(principal, intake))
    return view is not None


async def author_only_now(db: AsyncSession, d: "Discussion") -> bool:
    """Rule 3.4.3 applies: the discussion is on its author's finding, still below Summary."""
    if not d.author_only or d.subject_kind != "gap":
        return False
    found = await hidden_finding(db, uuid.UUID(d.subject["gap_id"]))
    return found is not None and found[1]
