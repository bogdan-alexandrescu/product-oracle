"""Section edits with optimistic concurrency (CR-06, build prompt §9).

Versions stay immutable: saving one section imports the next version, which is the
latest version with that section replaced. The editor sends the version and the
section revision it loaded:

- someone changed **the same section** since: 409 ``section_conflict``, with the
  current text to merge (never a silent last write);
- someone changed **another section** since: the edit applies on top of the latest
  version, so people work on different sections in parallel.

Each save records a ``document_section`` change (``oracle.changes``) for the edited
section only, which invalidates that section's approval (``oracle.review.state``). The
saved draft is parsed again: an edit that would add, rewrite, remove or swallow another
section is refused.
"""

from typing import TYPE_CHECKING

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.docs.models import DocumentVersion, Section
from oracle.docs.parser import parse_draft
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
    """422: the edit itself is invalid (unknown base version, or it reaches outside its
    section)."""


class EditForbidden(PermissionError):
    """403: the edit closes feedback the editor may not close."""


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
                "current_revision": current.revision if current else None,
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
    remove: bool = False,
    resolve_any: bool = True,
) -> ImportResult:
    """Import the latest version with section ``key`` replaced (or, with ``remove``,
    dropped). Commits (import_draft).

    The edit stays inside its section: the composed draft is parsed again and refused
    (:class:`EditRefused`) unless it has the same section keys in the same order and
    only this section changed, so a body cannot add sections, rewrite another one or
    swallow later ones (a heading, an unclosed code fence). With ``resolve_any`` false
    (a section owner below the approver role), ``resolutions`` may close only this
    section's feedback (:class:`EditForbidden`).
    """
    from oracle.jobs.service import compose_markdown
    from oracle.review.models import FeedbackItem

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
    if current is None or current.revision != base_revision:
        raise section_conflict(base_version, latest, key, base_revision, current)
    if resolutions and not resolve_any:
        ids = {str(r.get("feedback_id")) for r in resolutions}
        others = [
            str(i.id)
            for i in await db.scalars(
                select(FeedbackItem).where(FeedbackItem.document_id == document.id)
            )
            if str(i.id) in ids and i.section_key != key
        ]
        if others:
            raise EditForbidden(
                "a section edit closes only that section's feedback; closing other "
                f"feedback ({', '.join(sorted(others))}) takes the approver role"
            )
    body = body_md.strip("\n")
    new_heading = (heading or current.heading).strip()
    if "\n" in new_heading or "\r" in new_heading:
        raise EditRefused("a section heading is one line")
    if remove:
        kept = [s for s in sections if s.section_key != key]
        markdown = compose_markdown(latest.front_matter, kept, {}, resolutions or [])
    else:
        unchanged = (new_heading, body) == (current.heading, current.body_md.strip("\n"))
        if unchanged and not resolutions:
            return ImportResult(version=await read_version(db, latest), created=False)
        kept = sections
        markdown = compose_markdown(
            latest.front_matter, sections, {key: (new_heading, body)}, resolutions or []
        )
    _confined(markdown, kept, key, None if remove else (current.level, new_heading, body))
    return await import_draft(
        db, document.slug, markdown, principal, base_version=latest.number, cause=cause
    )


def _confined(
    markdown: str, expected: list[Section], key: str, edited: tuple[int, str, str] | None
) -> None:
    """Refuse a composed draft whose sections are not ``expected`` with only ``key``
    changed (to ``edited``: level, heading, body)."""
    parsed = parse_draft(markdown)
    keys = [s.section_key for s in parsed.sections]
    if keys != [s.section_key for s in expected]:
        added = sorted(set(keys) - {s.section_key for s in expected})
        lost = [s.section_key for s in expected if s.section_key not in keys]
        detail = "; ".join(
            part
            for part in (
                f"it adds {', '.join(added)}" if added else "",
                f"it removes {', '.join(lost)}" if lost else "",
            )
            if part
        )
        raise EditRefused(
            f"the edit of section {key!r} reaches outside it ({detail or 'it reorders sections'})"
        )
    by_key = {s.section_key: s for s in parsed.sections}
    for s in expected:
        mine = by_key[s.section_key]
        want = edited if s.section_key == key and edited else (s.level, s.heading, s.body_md)
        if (mine.level, mine.heading, mine.body_md) != want:
            where = "itself" if s.section_key == key else f"section {s.section_key!r}"
            raise EditRefused(
                f"the edit of section {key!r} does not stay inside it (it changes {where} "
                "as it is parsed); remove headings and close code fences"
            )
