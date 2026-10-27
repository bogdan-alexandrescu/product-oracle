"""Simple S3a (#723): the change engine's routes (oracle.simple.changes). For people: a
run's token is refused (the ``simple`` area is in no run-token scope, oracle.mcp.scopes).

- ``POST /v1/simple/sessions``: commenter and up; an editing session is reused while open.
- ``GET /v1/simple/sessions/current``: the caller's open editing session, or null.
- ``POST /v1/simple/sessions/{id}/close``: its starter.
- ``POST /v1/simple/changes``: commenter and up; applied or proposed by the caller's right.
- ``POST /v1/simple/changes/{id}/undo``: its author, in its open session.
- ``POST /v1/simple/changes/{id}/accept|decline``: those who decide the proposal.
- ``GET /v1/simple/changes``: viewer and up; the changes the caller may see.

S3b, working drafts (oracle.simple.drafts):

- ``GET /v1/simple/drafts``: viewer and up; the open drafts the caller may see.
- ``GET /v1/simple/drafts/{id}``: one of them.
- ``POST /v1/simple/drafts/{id}/submit``: an owner or the roadmap's decider (with none, its
  owner): the draft becomes the next version, in review.
- ``POST /v1/simple/drafts/{id}/approve``: the decider (held until the required reviewers
  have approved) or a required reviewer.
- ``POST /v1/simple/drafts/{id}/withdraw``: its author or the decider: a submitted draft
  returns to working (its changes kept); the version is marked withdrawn.
- ``POST /v1/simple/drafts/{id}/resume``: its author or the decider: a new session on it.
"""

import asyncio
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status

from oracle.auth.deps import Principal, TenantDB
from oracle.export.pdf import PdfUnavailable, html_to_pdf
from oracle.simple import changes, drafts, one_pager
from oracle.simple.router import _people
from oracle.simple.schemas import (
    ChangeStatus,
    OnePagerOut,
    SimpleChangeConflict,
    SimpleChangeIn,
    SimpleChangeOut,
    SimpleChangeResult,
    SimpleDecisionIn,
    SimpleDraftOut,
    SimpleResumeOut,
    SimpleSessionIn,
    SimpleSessionOut,
)

router = APIRouter(prefix="/v1/simple", tags=["simple"])

Reader = Annotated[Principal, Depends(_people("viewer"))]
Commenter = Annotated[Principal, Depends(_people("commenter"))]
CONFLICT = {
    409: {"model": dict[str, SimpleChangeConflict], "description": "Stale: nothing written"}
}


async def _run(db, coro):
    try:
        return await coro
    except (changes.ChangeError, drafts.DraftError) as e:
        await db.rollback()
        raise HTTPException(e.status, e.detail) from e


@router.post("/sessions", response_model=SimpleSessionOut, name="create_simple_session")
async def create_simple_session(
    body: SimpleSessionIn, principal: Commenter, db: TenantDB
) -> SimpleSessionOut:
    """Start a session: the caller's open editing session is reused (one per person); a
    meeting session is always new. A session closes after 30 minutes without a change."""
    s = await _run(db, changes.start_session(db, principal, body.kind))
    await db.commit()
    return changes.session_out(s)


@router.get("/sessions/current", response_model=SimpleSessionOut | None,
            name="get_current_simple_session")  # fmt: skip
async def get_current_simple_session(principal: Reader, db: TenantDB) -> SimpleSessionOut | None:
    """The caller's open editing session, or null."""
    s = await _run(db, changes.current_session(db, principal))
    await db.commit()
    return changes.session_out(s) if s is not None else None


@router.post("/sessions/{session_id}/close", response_model=SimpleSessionOut,
             name="close_simple_session")  # fmt: skip
async def close_simple_session(
    session_id: uuid.UUID, principal: Commenter, db: TenantDB
) -> SimpleSessionOut:
    """Close a session the caller started: its changes no longer undo."""
    s = await _run(db, changes.close_session(db, principal, session_id))
    await db.commit()
    return changes.session_out(s)


@router.post("/changes", response_model=SimpleChangeResult, status_code=status.HTTP_201_CREATED,
             name="create_simple_change", responses=CONFLICT)  # fmt: skip
async def create_simple_change(
    body: SimpleChangeIn, principal: Commenter, db: TenantDB
) -> SimpleChangeResult:
    """Make a change to a roadmap item: applied for an owner and the roadmap's decider
    (with no decider, its owner), proposed to them for approvers and commenters. 409 when
    ``before`` no longer matches the stored values (nothing is written). Returns the
    constraint flags of the touched items (a proposal's as if applied)."""
    return await _run(db, changes.create(db, principal, body))


@router.post("/changes/{change_id}/undo", response_model=SimpleChangeResult,
             status_code=status.HTTP_201_CREATED, name="undo_simple_change",
             responses=CONFLICT)  # fmt: skip
async def undo_simple_change(
    change_id: uuid.UUID, principal: Commenter, db: TenantDB
) -> SimpleChangeResult:
    """Undo one of the caller's applied changes, in its open session, while the target
    still holds its ``after``: writes an ``undone`` row (history is kept)."""
    return await _run(db, changes.undo(db, principal, change_id))


@router.post("/changes/{change_id}/accept", response_model=SimpleChangeResult,
             name="accept_simple_change", responses=CONFLICT)  # fmt: skip
async def accept_simple_change(
    change_id: uuid.UUID, principal: Commenter, db: TenantDB, body: SimpleDecisionIn | None = None
) -> SimpleChangeResult:
    """Accept a proposal: it applies, unless the item changed since (409 "outdated")."""
    reason = body.reason if body else None
    return await _run(db, changes.decide(db, principal, change_id, "accept", reason))


@router.post("/changes/{change_id}/decline", response_model=SimpleChangeResult,
             name="decline_simple_change")  # fmt: skip
async def decline_simple_change(
    change_id: uuid.UUID, principal: Commenter, db: TenantDB, body: SimpleDecisionIn | None = None
) -> SimpleChangeResult:
    """Decline a proposal, with an optional reason: nothing changes."""
    reason = body.reason if body else None
    return await _run(db, changes.decide(db, principal, change_id, "decline", reason))


@router.get("/changes", response_model=list[SimpleChangeOut], name="list_simple_changes")
async def list_simple_changes(
    principal: Reader,
    db: TenantDB,
    session: uuid.UUID | None = None,
    document: uuid.UUID | None = None,
    status_: Annotated[ChangeStatus | None, Query(alias="status")] = None,
    mine: bool = False,
) -> list[SimpleChangeOut]:
    """Changes newest first: those the caller made, decides or reviews, or whose session
    they started (owners: all); everyone else sees none (the published version only)."""
    return await _run(db, changes.listing(db, principal, session, document, status_, mine))


@router.get("/drafts", response_model=list[SimpleDraftOut], name="list_simple_drafts")
async def list_simple_drafts(principal: Reader, db: TenantDB) -> list[SimpleDraftOut]:
    """The open working and submitted drafts the caller may see: their participants, the
    company's owners, the roadmap's decider, required reviewers and owners."""
    return await _run(db, drafts.listing(db, principal))


@router.get("/drafts/{draft_id}", response_model=SimpleDraftOut, name="get_simple_draft")
async def get_simple_draft(draft_id: uuid.UUID, principal: Reader, db: TenantDB) -> SimpleDraftOut:
    """One draft the caller may see (404 otherwise)."""
    return await _run(db, drafts.one(db, principal, draft_id))


async def _commit(db, coro):
    out = await _run(db, coro)
    await db.commit()
    return out


@router.post("/drafts/{draft_id}/submit", response_model=SimpleDraftOut,
             name="submit_simple_draft")  # fmt: skip
async def submit_simple_draft(
    draft_id: uuid.UUID, principal: Commenter, db: TenantDB
) -> SimpleDraftOut:
    """Submit the draft: it is imported as the roadmap's next version and goes through the
    document's review policy; readers keep the published version until it is approved."""
    return await _commit(db, drafts.submit(db, principal, draft_id))


@router.post("/drafts/{draft_id}/approve", response_model=SimpleDraftOut,
             name="approve_simple_draft")  # fmt: skip
async def approve_simple_draft(
    draft_id: uuid.UUID, principal: Commenter, db: TenantDB
) -> SimpleDraftOut:
    """Approve a submitted draft: the decider's approval waits for every required
    reviewer's; a required reviewer's approves every section of the version. The version
    is approved (published to readers) when all are in."""
    return await _commit(db, drafts.approve(db, principal, draft_id))


@router.post("/drafts/{draft_id}/withdraw", response_model=SimpleDraftOut,
             name="withdraw_simple_draft")  # fmt: skip
async def withdraw_simple_draft(
    draft_id: uuid.UUID, principal: Commenter, db: TenantDB
) -> SimpleDraftOut:
    """Withdraw a submitted draft from review: it is a working draft again, its changes
    kept and undoable in their session; the version it imported is marked withdrawn and
    can't be approved. Its author or the roadmap's decider."""
    return await _commit(db, drafts.withdraw(db, principal, draft_id))


@router.post("/drafts/{draft_id}/resume", response_model=SimpleResumeOut,
             name="resume_simple_draft")  # fmt: skip
async def resume_simple_draft(
    draft_id: uuid.UUID, principal: Commenter, db: TenantDB
) -> SimpleResumeOut:
    """Open a session on a working draft whose session closed: its author or the decider."""
    s, d = await _run(db, drafts.resume(db, principal, draft_id))
    await db.commit()
    return SimpleResumeOut(session=changes.session_out(s), draft=d)


# --------------------------------------------------------------------------- S5 one-pagers


@router.get("/one-pagers/{doc}", response_model=OnePagerOut, name="get_simple_one_pager")
async def get_simple_one_pager(doc: str, principal: Reader, db: TenantDB) -> OnePagerOut:
    """A PRD's one-pager (slug or id): its published version's blocks, each line with its
    source sections, built by the ``one_pager`` job and cached per version and section
    hashes; to those who see the PRD's working draft, its edited lines and the margin
    notes (changes, proposals). Lines change through POST /v1/simple/changes
    (``edit_line``)."""
    return await _run(db, one_pager.read(db, principal, doc))


@router.get("/one-pagers/{doc}/pdf", name="export_simple_one_pager",
            response_class=Response)  # fmt: skip
async def export_simple_one_pager(doc: str, principal: Reader, db: TenantDB) -> Response:
    """The one-pager as a branded one-page PDF (its published lines)."""
    html, stem = await _run(db, one_pager.pdf_html(db, principal, doc))
    await db.commit()
    try:
        content = await asyncio.to_thread(html_to_pdf, html)
    except PdfUnavailable as e:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(e)) from None
    return Response(
        content=content,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{stem}.pdf"'},
    )
