"""Simple S3a (#723): the change engine's routes (oracle.simple.changes). For people: a
run's token is refused (the ``simple`` area is in no run-token scope, oracle.mcp.scopes).

- ``POST /v1/simple/sessions``: commenter and up; an editing session is reused while open.
- ``GET /v1/simple/sessions/current``: the caller's open editing session, or null.
- ``POST /v1/simple/sessions/{id}/close``: its starter.
- ``POST /v1/simple/changes``: commenter and up; applied or proposed by the caller's right.
- ``POST /v1/simple/changes/{id}/undo``: its author, in its open session.
- ``POST /v1/simple/changes/{id}/accept|decline``: those who decide the proposal.
- ``GET /v1/simple/changes``: viewer and up; the changes the caller may see.
"""

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status

from oracle.auth.deps import Principal, TenantDB
from oracle.simple import changes
from oracle.simple.router import _people
from oracle.simple.schemas import (
    ChangeConflict,
    ChangeIn,
    ChangeOut,
    ChangeResult,
    ChangeStatus,
    DecisionIn,
    SessionIn,
    SessionOut,
)

router = APIRouter(prefix="/v1/simple", tags=["simple"])

Reader = Annotated[Principal, Depends(_people("viewer"))]
Commenter = Annotated[Principal, Depends(_people("commenter"))]
CONFLICT = {409: {"model": dict[str, ChangeConflict], "description": "Stale: nothing written"}}


async def _run(db, coro):
    try:
        return await coro
    except changes.ChangeError as e:
        await db.rollback()
        raise HTTPException(e.status, e.detail) from e


@router.post("/sessions", response_model=SessionOut, name="create_simple_session")
async def create_simple_session(body: SessionIn, principal: Commenter, db: TenantDB) -> SessionOut:
    """Start a session: the caller's open editing session is reused (one per person); a
    meeting session is always new. A session closes after 30 minutes without a change."""
    s = await _run(db, changes.start_session(db, principal, body.kind))
    await db.commit()
    return changes.session_out(s)


@router.get("/sessions/current", response_model=SessionOut | None,
            name="get_current_simple_session")  # fmt: skip
async def get_current_simple_session(principal: Reader, db: TenantDB) -> SessionOut | None:
    """The caller's open editing session, or null."""
    s = await _run(db, changes.current_session(db, principal))
    await db.commit()
    return changes.session_out(s) if s is not None else None


@router.post("/sessions/{session_id}/close", response_model=SessionOut,
             name="close_simple_session")  # fmt: skip
async def close_simple_session(
    session_id: uuid.UUID, principal: Commenter, db: TenantDB
) -> SessionOut:
    """Close a session the caller started: its changes no longer undo."""
    s = await _run(db, changes.close_session(db, principal, session_id))
    await db.commit()
    return changes.session_out(s)


@router.post("/changes", response_model=ChangeResult, status_code=status.HTTP_201_CREATED,
             name="create_simple_change", responses=CONFLICT)  # fmt: skip
async def create_simple_change(body: ChangeIn, principal: Commenter, db: TenantDB) -> ChangeResult:
    """Make a change to a roadmap item: applied for an owner and the roadmap's decider
    (with no decider, its owner), proposed to them for approvers and commenters. 409 when
    ``before`` no longer matches the stored values (nothing is written). Returns the
    constraint flags of the touched items (a proposal's as if applied)."""
    return await _run(db, changes.create(db, principal, body))


@router.post("/changes/{change_id}/undo", response_model=ChangeResult,
             status_code=status.HTTP_201_CREATED, name="undo_simple_change",
             responses=CONFLICT)  # fmt: skip
async def undo_simple_change(
    change_id: uuid.UUID, principal: Commenter, db: TenantDB
) -> ChangeResult:
    """Undo one of the caller's applied changes, in its open session, while the target
    still holds its ``after``: writes an ``undone`` row (history is kept)."""
    return await _run(db, changes.undo(db, principal, change_id))


@router.post("/changes/{change_id}/accept", response_model=ChangeResult,
             name="accept_simple_change", responses=CONFLICT)  # fmt: skip
async def accept_simple_change(
    change_id: uuid.UUID, principal: Commenter, db: TenantDB, body: DecisionIn | None = None
) -> ChangeResult:
    """Accept a proposal: it applies, unless the item changed since (409 "outdated")."""
    reason = body.reason if body else None
    return await _run(db, changes.decide(db, principal, change_id, "accept", reason))


@router.post("/changes/{change_id}/decline", response_model=ChangeResult,
             name="decline_simple_change")  # fmt: skip
async def decline_simple_change(
    change_id: uuid.UUID, principal: Commenter, db: TenantDB, body: DecisionIn | None = None
) -> ChangeResult:
    """Decline a proposal, with an optional reason: nothing changes."""
    reason = body.reason if body else None
    return await _run(db, changes.decide(db, principal, change_id, "decline", reason))


@router.get("/changes", response_model=list[ChangeOut], name="list_simple_changes")
async def list_simple_changes(
    principal: Reader,
    db: TenantDB,
    session: uuid.UUID | None = None,
    document: uuid.UUID | None = None,
    status_: Annotated[ChangeStatus | None, Query(alias="status")] = None,
    mine: bool = False,
) -> list[ChangeOut]:
    """Changes newest first: those the caller made, decides or reviews, or whose session
    they started (owners: all); everyone else sees none (the published version only)."""
    return await _run(db, changes.listing(db, principal, session, document, status_, mine))
