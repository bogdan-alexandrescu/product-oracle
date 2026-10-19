"""Section patches: AI text reviewed as a targeted diff before it replaces accepted human
text (CR-06, build prompt §9).

An agent's draft (a run's import) that rewrote an approved section keeps the approved
text in the imported version and leaves the rewrite here. An approver compares it with
the section's current text (a word diff), then accepts it (optionally edited), which
saves the section as the next version through :func:`oracle.docs.edit.edit_section`
with cause ``patch_accepted`` (so the section's approval is invalidated and only that
section's), or rejects it. Oracle's own refinement job keeps its preview-and-apply
flow (``oracle.jobs``), which records the same ``patch_accepted`` change.
"""

import uuid
from typing import TYPE_CHECKING

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.docs.diff import word_diff
from oracle.docs.models import Document, DocumentVersion, Section
from oracle.docs.parser import body_text
from oracle.docs.service import ImportResult
from oracle.review.models import SectionPatch, SectionReviewState
from oracle.review.schemas import SectionPatchDetail, SectionPatchOut
from oracle.review.state import effective_policy, now
from oracle.v2.concurrency import expect_version, flush_or_conflict

if TYPE_CHECKING:
    from oracle.auth.deps import Principal


class PatchError(Exception):
    def __init__(self, kind: str, message: str):
        self.kind = kind  # "not_found" | "conflict" | "invalid"
        self.message = message
        super().__init__(message)


async def propose_held(
    db: AsyncSession,
    principal: "Principal | None",
    document: Document,
    version: DocumentVersion,
    held: dict[str, tuple[str, str]],
    *,
    origin: str,
    run_id: uuid.UUID | None = None,
) -> list[SectionPatch]:
    """One open patch per approved section an agent draft rewrote (import_draft)."""
    from oracle.review import collab

    hashes = dict(
        (
            await db.execute(
                select(Section.section_key, Section.content_hash).where(
                    Section.version_id == version.id, Section.section_key.in_(list(held))
                )
            )
        ).all()
    )
    out = []
    for key, (heading, body) in sorted(held.items()):
        row = SectionPatch(
            document_id=document.id,
            section_key=key,
            base_version=version.number,
            base_hash=hashes[key],
            heading=heading,
            body_md=body,
            origin=origin if origin in ("run", "llm_job", "agent", "person") else "agent",
            run_id=run_id,
            rationale="An agent draft rewrote this approved section; the approved text was "
            "kept. Review the rewrite as a diff.",
            status="open",
            created_by=principal.id if principal else None,
        )
        db.add(row)
        out.append(row)
    await db.flush()
    policy = await effective_policy(db, document)
    states = {
        s.section_key: s
        for s in await db.scalars(
            select(SectionReviewState).where(
                SectionReviewState.document_id == document.id,
                SectionReviewState.section_key.in_(list(held)),
            )
        )
    }
    for row in out:
        await audit.record(
            db,
            principal,
            "section_patch.propose",
            "section_patch",
            row.id,
            {"section_key": row.section_key, "version": version.number, "origin": row.origin},
        )
        state = states.get(row.section_key)
        await collab.notify(
            db,
            [policy.decider_id, *([state.owner_id, *state.reviewer_ids] if state else [])],
            kind="patch_proposed",
            title=f"Proposed change to approved section {row.section_key} in {document.title}",
            actor=principal.actor if principal else "system",
            document_id=document.id,
            version_number=version.number,
            section_key=row.section_key,
            data={"patch_id": str(row.id)},
        )
    return out


async def get_patch(db: AsyncSession, patch_id: uuid.UUID, *, lock: bool = False) -> SectionPatch:
    stmt = select(SectionPatch).where(SectionPatch.id == patch_id)
    if lock:
        stmt = stmt.with_for_update()
    row = await db.scalar(stmt)
    if row is None:
        raise PatchError("not_found", f"Section patch {patch_id} not found")
    return row


async def list_patches(
    db: AsyncSession, document: Document, status: str | None
) -> list[SectionPatchOut]:
    stmt = select(SectionPatch).where(SectionPatch.document_id == document.id)
    if status is not None:
        stmt = stmt.where(SectionPatch.status == status)
    rows = await db.scalars(stmt.order_by(SectionPatch.created_at.desc(), SectionPatch.id))
    return [SectionPatchOut.model_validate(r) for r in rows]


async def _latest_section(
    db: AsyncSession, document_id: uuid.UUID, key: str
) -> tuple[DocumentVersion, Section | None]:
    latest = await db.scalar(
        select(DocumentVersion)
        .where(DocumentVersion.document_id == document_id)
        .order_by(DocumentVersion.number.desc())
        .limit(1)
    )
    section = await db.scalar(
        select(Section).where(Section.version_id == latest.id, Section.section_key == key)
    )
    return latest, section


async def patch_detail(db: AsyncSession, row: SectionPatch) -> SectionPatchDetail:
    latest, current = await _latest_section(db, row.document_id, row.section_key)
    before = f"{current.heading}\n{current.body_text}" if current else ""
    after = f"{row.heading}\n{body_text(row.body_md)}"
    return SectionPatchDetail(
        **SectionPatchOut.model_validate(row).model_dump(),
        latest_version=latest.number,
        current_revision=current.content_hash if current else None,
        current_heading=current.heading if current else None,
        current_body_md=current.body_md if current else None,
        rebase_needed=current is None or current.content_hash != row.base_hash,
        words=word_diff(before, after),
    )


async def accept_patch(
    db: AsyncSession,
    principal: "Principal",
    patch_id: uuid.UUID,
    *,
    base_revision: str,
    lock_version: int,
    heading: str | None,
    body_md: str | None,
    note: str | None,
) -> ImportResult:
    """Save the patch (or the reviewer's edit of it) as the section's next revision."""
    from oracle.docs.edit import edit_section

    row = await get_patch(db, patch_id, lock=True)
    expect_version(row, lock_version)
    if row.status != "open":
        raise PatchError("conflict", f"an {row.status} patch cannot be accepted")
    document = await db.get(Document, row.document_id)
    latest, _ = await _latest_section(db, row.document_id, row.section_key)
    edited = heading is not None or body_md is not None
    row.status = "accepted"
    row.decided_by = principal.id
    row.decided_at = now()
    row.decision_note = note
    row.applied_version = latest.number + 1
    await flush_or_conflict(db)
    await audit.record(
        db,
        principal,
        "section_patch.accept",
        "section_patch",
        row.id,
        {"section_key": row.section_key, "edited": edited, "note": note},
    )
    others = await db.scalars(
        select(SectionPatch).where(
            SectionPatch.document_id == row.document_id,
            SectionPatch.section_key == row.section_key,
            SectionPatch.status == "open",
            SectionPatch.id != row.id,
        )
    )
    for other in others:
        other.status = "superseded"
        other.decision_note = f"Superseded by patch {row.id}"
    result = await edit_section(
        db,
        principal,
        str(document.id),
        row.section_key,
        base_version=latest.number,
        base_revision=base_revision,
        heading=heading or row.heading,
        body_md=body_md if body_md is not None else row.body_md,
        cause="patch_accepted",
    )
    if not result.created:
        # The section already had this text: nothing new was imported.
        row = await get_patch(db, patch_id)
        row.applied_version = result.version.number
        await db.commit()
    return result


async def reject_patch(
    db: AsyncSession,
    principal: "Principal",
    patch_id: uuid.UUID,
    lock_version: int,
    note: str | None,
) -> SectionPatch:
    row = await get_patch(db, patch_id, lock=True)
    expect_version(row, lock_version)
    if row.status != "open":
        raise PatchError("conflict", f"an {row.status} patch cannot be rejected")
    row.status = "rejected"
    row.decided_by = principal.id
    row.decided_at = now()
    row.decision_note = note
    await flush_or_conflict(db)
    await audit.record(
        db,
        principal,
        "section_patch.reject",
        "section_patch",
        row.id,
        {"section_key": row.section_key, "note": note},
    )
    await db.refresh(row)
    return row
