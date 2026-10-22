"""D10: a run's PRD or roadmap review follows the document review (one review place).

A run that imported a draft waits at ``prd_review`` (``roadmap_review`` for a roadmap)
on the version it made. That checkpoint is decided in the version view: the run review
bar reads it (:func:`run_review`), the last section approved or the version published
approves it (:func:`on_document_review`), and Send back carries the document's own
feedback as the structured review file (:func:`review_file`).
"""

import logging
import uuid
from datetime import UTC, datetime
from typing import Any

import yaml
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.auth.deps import Principal
from oracle.docs.models import Document, DocumentVersion, Section
from oracle.review.models import FeedbackItem
from oracle.runs import flows
from oracle.runs.models import Checkpoint, Run
from oracle.runs.schemas import RunReviewOut

log = logging.getLogger(__name__)

KINDS = ("prd_review", "roadmap_review")
SEND_BACK_VERDICTS = ("changes_requested", "rejected")
NOTHING = "Nothing to send back: comment, request changes on a section, or write a note."


def imported(cp: Checkpoint) -> dict[str, Any] | None:
    """The version a run review checkpoint reviews (``payload.import``), when its draft
    was imported."""
    imp = (cp.payload or {}).get("import") or {}
    if cp.kind in KINDS and imp.get("document_id") and imp.get("version"):
        return imp
    return None


def link(cp: Checkpoint) -> str | None:
    """Where every client opens the checkpoint: its version, with the run review bar."""
    imp = imported(cp)
    if imp is None or not imp.get("slug"):
        return None
    return f"/documents/{imp['slug']}/v/{imp['version']}?run_review={cp.id}"


async def checkpoint_for(
    db: AsyncSession, document_id: uuid.UUID, number: int
) -> Checkpoint | None:
    """The latest run review checkpoint whose import made version ``number``."""
    imp = Checkpoint.payload["import"]
    return await db.scalar(
        select(Checkpoint)
        .where(
            Checkpoint.kind.in_(KINDS),
            imp["document_id"].astext == str(document_id),
            imp["version"].astext == str(number),
        )
        .order_by(Checkpoint.created_at.desc(), Checkpoint.id.desc())
        .limit(1)
    )


async def _feedback(
    db: AsyncSession, document: Document, version: DocumentVersion
) -> tuple[list[dict[str, Any]], list[str], int]:
    """The review entries (open items, then staged changes), the locked sections and how
    many sections carry Request changes or Reject."""
    from oracle.jobs.kinds import staged_suggestions
    from oracle.review.service import latest_verdicts, locked_section_keys

    staged = await staged_suggestions(db, document.id)
    staged_ids = {s.feedback_item_id for s in staged}
    items = list(
        await db.scalars(
            select(FeedbackItem)
            .where(
                FeedbackItem.document_id == document.id,
                FeedbackItem.status == "open",
                FeedbackItem.raised_on_version <= version.number,
            )
            .order_by(FeedbackItem.created_at, FeedbackItem.id)
        )
    )
    entries = [
        {
            "id": str(item.id),
            "section": item.section_key or "general",
            "action": "change",
            "summary": item.summary,
        }
        for item in items
        if item.id not in staged_ids
    ]
    by_id = {
        f.id: f
        for f in await db.scalars(select(FeedbackItem).where(FeedbackItem.id.in_(list(staged_ids))))
    }
    for s in staged:
        item = by_id.get(s.feedback_item_id)
        entries.append(
            {
                "id": str(s.feedback_item_id),
                "section": s.section_key or "general",
                "action": "change",
                "summary": item.summary if item else "",
                "accepted_text": s.text,
            }
        )
    ordered = list(
        await db.scalars(
            select(Section.section_key)
            .where(Section.version_id == version.id)
            .order_by(Section.ordinal)
        )
    )
    locked = await locked_section_keys(db, version.id)
    verdicts = await latest_verdicts(db, version.id)
    sent_back = sum(1 for r in verdicts.values() if r.verdict in SEND_BACK_VERDICTS)
    return entries, [k for k in ordered if k in locked], sent_back


async def review_file(
    db: AsyncSession, cp: Checkpoint, note: str | None
) -> tuple[str, list[str]] | None:
    """The structured review file a Send back gives the agents (D4), as YAML, and its
    findings (one line per entry, then the note). None when the checkpoint reviews no
    imported version; raises Invalid when there is nothing to send back."""
    from oracle.runs.service import Invalid

    imp = imported(cp)
    if imp is None:
        return None
    document = await db.get(Document, uuid.UUID(imp["document_id"]))
    version = await db.scalar(
        select(DocumentVersion).where(
            DocumentVersion.document_id == uuid.UUID(imp["document_id"]),
            DocumentVersion.number == int(imp["version"]),
        )
    )
    if document is None or version is None:
        return None
    entries, locked, _ = await _feedback(db, document, version)
    if not entries and not note:
        raise Invalid(NOTHING)
    body: dict[str, Any] = {
        "checkpoint": cp.kind,
        "file": flows.draft_file(document.kind),
        "entries": entries,
        "locked_sections": locked,
    }
    if note:
        body["general_note"] = note
    text = yaml.safe_dump(body, sort_keys=False, allow_unicode=True)
    findings = [
        f"{e['section']}: {e['summary']}"
        + (f" (accepted text: {e['accepted_text']})" if e.get("accepted_text") else "")
        + f" [{e['id']}]"
        for e in entries
    ] + ([note] if note else [])
    return text, findings


async def _counts(db: AsyncSession, document: Document, version: DocumentVersion):
    from oracle.review.service import latest_verdicts
    from oracle.review.state import approved_keys

    keys = set(
        await db.scalars(select(Section.section_key).where(Section.version_id == version.id))
    )
    verdicts = await latest_verdicts(db, version.id)
    approved = await approved_keys(db, document.id, version)
    return keys, {k for k in verdicts if k in keys}, approved & keys


async def run_review(
    db: AsyncSession, principal: Principal, document: Document, version: DocumentVersion
) -> RunReviewOut | None:
    """The run review bar of a version: None when no run checkpoint points at it."""
    from oracle.members.leads import engineering_leads, may_decide
    from oracle.runs.actions import wait_info

    cp = await checkpoint_for(db, document.id, version.number)
    if cp is None:
        return None
    run = await db.get(Run, cp.run_id)
    keys, reviewed, approved = await _counts(db, document, version)
    entries, _, sent_back = await _feedback(db, document, version)
    leads = await engineering_leads(db)
    return RunReviewOut(
        checkpoint_id=cp.id,
        run_id=cp.run_id,
        kind=cp.kind,  # type: ignore[arg-type]
        status=cp.status,  # type: ignore[arg-type]
        flow_title=flows.FLOWS[run.flow].title if run else "",
        approver_role=cp.approver_role,  # type: ignore[arg-type]
        sections={"total": len(keys), "reviewed": len(reviewed), "approved": len(approved)},
        feedback={
            "open": sum(1 for e in entries if "accepted_text" not in e),
            "staged": sum(1 for e in entries if "accepted_text" in e),
            "verdicts": sent_back,
        },
        wait=wait_info(cp.payload, datetime.now(UTC)),
        can_decide=cp.status == "pending"
        and run is not None
        and run.status == "awaiting_checkpoint"
        and may_decide(principal, cp, run.flow, leads),
    )


async def _decide(db: AsyncSession, principal: Principal, cp: Checkpoint) -> None:
    from oracle.runs import service

    await service.decide_checkpoint(
        db, principal, cp.run_id, cp.id, "approved", None, audit_via="document_review"
    )
    await service.submit_queued(db, cp.run_id)


async def on_document_review(
    db: AsyncSession, principal: Principal, version: DocumentVersion, *, published: bool = False
) -> None:
    """After a section verdict or a publish has committed: a pending run review of
    ``version`` is approved when every section is approved, or the version was published.
    Best effort: a failure is logged and the checkpoint stays pending."""
    try:
        cp = await checkpoint_for(db, version.document_id, version.number)
        if cp is None or cp.status != "pending":
            return
        if not published:
            document = await db.get(Document, version.document_id)
            keys, _, approved = await _counts(db, document, version)
            if not keys or approved != keys:
                return
        await _decide(db, principal, cp)
    except Exception:
        log.exception("run review of version %s: not decided", version.id)
        await db.rollback()
