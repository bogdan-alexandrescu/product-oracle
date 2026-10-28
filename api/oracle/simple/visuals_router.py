"""Simple S10 (#723, D26): a proposal's visual (oracle.simple.visuals). For people only.

- ``GET /v1/simple/visuals/{kind}/{subject_id}``: viewer and up (who may read the
  subject): the newest drawing, its versions, comments and what the caller may do.
- ``GET .../versions/{number}``: one version's drawing.
- ``POST .../comments``: commenter and up, on the newest version (or one annotation).
- ``POST .../revise``: who changes the subject directly: Oracle redraws it from the open
  comments as the next version.
- ``POST .../request``: the same people ask Oracle to draw a subject that has none (a
  one-pager bet line with its PRD's ``document_id``).
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException, Response, status

from oracle.auth.deps import TenantDB
from oracle.simple import visuals
from oracle.simple.changes_router import Commenter, Reader
from oracle.simple.schemas import (
    SimpleFlow,
    SimpleVisualCommentIn,
    SimpleVisualOut,
    SimpleVisualRequestIn,
    SimpleVisualReviseIn,
)


def _no_store(response: Response) -> None:
    """The walk-fixes review: a visual's read changes when Oracle's job ends, and the panel
    polls it while Oracle draws; no browser or proxy may answer a poll from a copy kept
    from before (the place that asked kept "Oracle is drawing..." until a reload)."""
    response.headers["Cache-Control"] = "no-store"


router = APIRouter(prefix="/v1/simple/visuals", tags=["simple"], dependencies=[Depends(_no_store)])
SUBJECT = "/{kind}/{subject_id}"


async def _run(db, coro):
    try:
        return await coro
    except visuals.VisualError as e:
        await db.rollback()
        raise HTTPException(e.status, e.detail) from e


@router.get(SUBJECT, response_model=SimpleVisualOut, name="get_simple_visual")
async def get_simple_visual(
    kind: str, subject_id: uuid.UUID, principal: Reader, db: TenantDB,
    document_id: uuid.UUID | None = None,
) -> SimpleVisualOut:  # fmt: skip
    """The subject's visual: its newest drawing (null: none yet), versions newest first,
    comments, whether Oracle is drawing it, and what the caller may do. ``document_id``: a
    one-pager line's PRD (who may ask Oracle to draw a bet with none)."""
    return await _run(db, visuals.read(db, principal, kind, subject_id, document_id))


@router.get(SUBJECT + "/versions/{number}", response_model=SimpleFlow,
            name="get_simple_visual_version")  # fmt: skip
async def get_simple_visual_version(
    kind: str, subject_id: uuid.UUID, number: int, principal: Reader, db: TenantDB
) -> SimpleFlow:
    """One version of the visual (the history)."""
    return await _run(db, visuals.version(db, principal, kind, subject_id, number))


@router.post(SUBJECT + "/comments", response_model=SimpleVisualOut,
             status_code=status.HTTP_201_CREATED, name="comment_simple_visual")  # fmt: skip
async def comment_simple_visual(
    kind: str, subject_id: uuid.UUID, body: SimpleVisualCommentIn, principal: Commenter,
    db: TenantDB,
) -> SimpleVisualOut:  # fmt: skip
    """Comment on the newest drawing, or on one of its numbered annotations."""
    out = await _run(
        db, visuals.comment(db, principal, kind, subject_id, body.body, body.annotation)
    )
    await db.commit()
    return out


@router.post(SUBJECT + "/revise", response_model=SimpleVisualOut,
             status_code=status.HTTP_202_ACCEPTED, name="revise_simple_visual")  # fmt: skip
async def revise_simple_visual(
    kind: str, subject_id: uuid.UUID, principal: Commenter, db: TenantDB,
    body: SimpleVisualReviseIn | None = None,
) -> SimpleVisualOut:  # fmt: skip
    """Revise: Oracle redraws the visual from its open comments (and the note) as the next
    version (the ``simple_visual`` job). Who changes the subject directly; 409 with no
    open comment and no note."""
    out = await _run(
        db, visuals.revise(db, principal, kind, subject_id, body.note if body else None)
    )
    await db.commit()
    return out


@router.post(SUBJECT + "/request", response_model=SimpleVisualOut,
             status_code=status.HTTP_202_ACCEPTED, name="request_simple_visual")  # fmt: skip
async def request_simple_visual(
    kind: str, subject_id: uuid.UUID, principal: Commenter, db: TenantDB,
    body: SimpleVisualRequestIn | None = None,
) -> SimpleVisualOut:  # fmt: skip
    """Ask Oracle to draw a subject's visual (a feature on the roadmap, or a one-pager bet
    with its PRD's ``document_id``, that has none)."""
    out = await _run(
        db,
        visuals.ask_for(
            db, principal, kind, subject_id, body.brief if body else "",
            body.document_id if body else None,
        ),
    )  # fmt: skip
    await db.commit()
    return out
