"""Section edits with optimistic concurrency (CR-06, build prompt §9).

Versions stay immutable: saving one section imports the next version, which is the
latest version with that section replaced. The editor sends the version and the
section revision (content hash) it loaded:

- someone changed **the same section** since: 409 ``section_conflict``, with the
  current text to merge (never a silent last write);
- someone changed **another section** since: the edit applies on top of the latest
  version, so people work on different sections in parallel.

Each save records a ``document_section`` change (``oracle.changes``) for the edited
section only, which invalidates that section's approval (``oracle.review.state``).
"""

from typing import TYPE_CHECKING

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.docs.models import DocumentVersion, Section
from oracle.docs.service import (
    BaseVersionConflictError,
    ImportResult,
    NotFoundError,
    find_document,
    import_draft,
    read_version,
)

if TYPE_CHECKING:
    from oracle.auth.deps import Principal


class EditRefused(ValueError):
    """422: the edit itself is invalid (unknown base version)."""


def section_conflict(
    base_version: int, latest: DocumentVersion, key: str, base_revision: str, current
) -> BaseVersionConflictError:
    return BaseVersionConflictError(
        base_version,
        latest.number,
        [
            {
                "section_key": key,
                "base_revision": base_revision,
                "current_revision": current.content_hash if current else None,
                "your_revision": None,
                "current_heading": current.heading if current else None,
                "current_body_md": current.body_md if current else None,
            }
        ],
        code="section_conflict",
        message=(
            f"section {key!r} changed since you loaded it (version {base_version}); "
            f"version {latest.number} has another revision. Merge it and save again"
            if current
            else f"section {key!r} is no longer in version {latest.number}"
        ),
    )


async def edit_section(
    db: AsyncSession,
    principal: "Principal",
    doc: str,
    key: str,
    *,
    base_version: int,
    base_revision: str,
    heading: str | None,
    body_md: str,
    resolutions: list[dict] | None = None,
    cause: str = "section_edited",
) -> ImportResult:
    """Import the latest version with section ``key`` replaced. Commits (import_draft)."""
    from oracle.jobs.service import compose_markdown

    document = await find_document(db, doc, for_update=True)
    if document is None:
        raise NotFoundError(f"document '{doc}' not found")
    latest = await db.scalar(
        select(DocumentVersion)
        .where(DocumentVersion.document_id == document.id)
        .order_by(DocumentVersion.number.desc())
        .limit(1)
    )
    if latest is None or base_version > latest.number:
        raise EditRefused(f"version {base_version} of '{document.slug}' does not exist")
    sections = list(
        await db.scalars(
            select(Section).where(Section.version_id == latest.id).order_by(Section.ordinal)
        )
    )
    current = next((s for s in sections if s.section_key == key), None)
    if current is None or current.content_hash != base_revision:
        raise section_conflict(base_version, latest, key, base_revision, current)
    body = body_md.strip("\n")
    new_heading = heading or current.heading
    unchanged = (new_heading, body) == (current.heading, current.body_md.strip("\n"))
    if unchanged and not resolutions:
        return ImportResult(version=await read_version(db, latest), created=False)
    markdown = compose_markdown(
        latest.front_matter, sections, {key: (new_heading, body)}, resolutions or []
    )
    return await import_draft(
        db, document.slug, markdown, principal, base_version=latest.number, cause=cause
    )
