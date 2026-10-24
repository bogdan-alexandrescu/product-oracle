"""Interviews for members (C3 lane 1: customer interviews; lane 2: team interviews).
Every route is an MCP tool.

Viewers read; commenters create; the interview's creator or an approver edits a Draft,
redrafts its guide, creates its private link (shown once) and withdraws it. The
customer's own routes are in :mod:`oracle.interviews.public`. A member's team interview
on an intake (:mod:`oracle.interviews.team`) is theirs alone to answer in.
"""

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status

from oracle.auth.deps import Principal, TenantDB, same_origin
from oracle.authz import require_role
from oracle.intake.router import answer_result
from oracle.interviews import service, team
from oracle.interviews.schemas import (
    InterviewCreate,
    InterviewLinkOut,
    InterviewMessageOut,
    InterviewOut,
    InterviewPatch,
    InterviewSummary,
    Kind,
    Preset,
    Status,
    TeamTurnIn,
    TeamTurnOut,
)

router = APIRouter(prefix="/v1", tags=["interviews"])

Viewer = Annotated[Principal, Depends(require_role("viewer"))]
Commenter = Annotated[Principal, Depends(require_role("commenter"))]


def _http(exc: service.InterviewError) -> HTTPException:
    return HTTPException(exc.status, str(exc))


@router.post("/interviews", response_model=InterviewOut, status_code=status.HTTP_201_CREATED)
async def create_interview(
    body: InterviewCreate, db: TenantDB, principal: Commenter
) -> InterviewOut:
    """Create a Draft customer interview and queue Oracle's draft of its questions; with
    ``preset=pricing``, its guide is the fixed pricing questions and no job is queued."""
    try:
        row = await service.create(db, principal, body)
    except service.InterviewError as e:
        raise _http(e) from e
    out = await service.out(db, principal, row)
    await db.commit()
    return out


@router.get("/interviews", response_model=list[InterviewSummary])
async def list_interviews(
    db: TenantDB,
    _: Viewer,
    status: Status | None = None,
    intake_id: uuid.UUID | None = None,
    theme_id: uuid.UUID | None = None,
    kind: Kind | None = None,
    preset: Preset | None = None,
) -> list[InterviewSummary]:
    """Interviews, newest first; ``preset=pricing`` for pricing interviews."""
    return await service.list_interviews(
        db, status=status, intake_id=intake_id, theme_id=theme_id, kind=kind, preset=preset
    )


@router.get("/interviews/{interview_id}", response_model=InterviewOut)
async def get_interview(interview_id: uuid.UUID, db: TenantDB, principal: Viewer) -> InterviewOut:
    """An interview: its approved guide, the guide job, the transcript, the snapshot and
    the requests it created."""
    try:
        row = await service.get_row(db, interview_id)
    except service.InterviewError as e:
        raise _http(e) from e
    return await service.out(db, principal, row)


@router.patch("/interviews/{interview_id}", response_model=InterviewOut)
async def patch_interview(
    interview_id: uuid.UUID, body: InterviewPatch, db: TenantDB, principal: Commenter
) -> InterviewOut:
    """Edit a Draft's intro, questions (at most 8, in order) or the customer's name."""
    try:
        row = await service.patch(db, principal, interview_id, body)
    except service.InterviewError as e:
        raise _http(e) from e
    out = await service.out(db, principal, row)
    await db.commit()
    return out


@router.post(
    "/interviews/{interview_id}/guide",
    response_model=InterviewOut,
    dependencies=[Depends(same_origin)],
)
async def redraft_interview_guide(
    interview_id: uuid.UUID, db: TenantDB, principal: Commenter
) -> InterviewOut:
    """Ask Oracle to draft a Draft's questions again (not a pricing interview's: 409)."""
    try:
        row = await service.redraft(db, principal, interview_id)
    except service.InterviewError as e:
        raise _http(e) from e
    out = await service.out(db, principal, row)
    await db.commit()
    return out


@router.post(
    "/interviews/{interview_id}/link",
    response_model=InterviewLinkOut,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(same_origin)],
)
async def create_interview_link(
    interview_id: uuid.UUID, db: TenantDB, principal: Commenter
) -> InterviewLinkOut:
    """Create the private link: shown once, works once, expires after 7 days."""
    try:
        link = await service.create_link(db, principal, interview_id)
    except service.InterviewError as e:
        raise _http(e) from e
    await db.commit()
    return link


@router.post(
    "/interviews/{interview_id}/revoke",
    response_model=InterviewOut,
    dependencies=[Depends(same_origin)],
)
async def revoke_interview(
    interview_id: uuid.UUID, db: TenantDB, principal: Commenter
) -> InterviewOut:
    """Withdraw the interview: its link stops working at once."""
    try:
        row = await service.revoke(db, principal, interview_id)
    except service.InterviewError as e:
        raise _http(e) from e
    out = await service.out(db, principal, row)
    await db.commit()
    return out


@router.post(
    "/intakes/{intake_id}/interview",
    response_model=InterviewOut,
    dependencies=[Depends(same_origin)],
)
async def open_team_interview(
    intake_id: uuid.UUID, db: TenantDB, principal: Commenter
) -> InterviewOut:
    """My team interview for this intake (created on first call): Oracle's follow-ups
    and my replies on the intake's questions."""
    try:
        row = await team.open_for(db, principal, intake_id)
    except service.InterviewError as e:
        raise _http(e) from e
    out = await service.out(db, principal, row)
    await db.commit()
    return out


@router.post("/interviews/{interview_id}/turns", response_model=TeamTurnOut)
async def take_team_turn(
    interview_id: uuid.UUID, body: TeamTurnIn, db: TenantDB, principal: Commenter
) -> TeamTurnOut:
    """Answer one of the intake's questions in my team interview. Oracle follows up once
    when the answer does not meet the gap's stop condition; the reply, or with
    ``skip_follow_up`` the answer as written, is recorded as my decision. A turn past 25
    seconds records the answer as written."""
    try:
        added, result = await team.take_turn(
            db, principal, interview_id, body.question_id, body.body, body.skip_follow_up
        )
    except service.InterviewError as e:
        raise _http(e) from e
    messages = [
        InterviewMessageOut(
            id=m.id,
            role=m.role,  # type: ignore[arg-type]
            kind=m.kind,
            body=m.body,
            question_id=m.question_id,
            created_at=m.created_at,
        )
        for m in added
    ]
    row = await service.get_row(db, interview_id)
    following = await team.next_question(db, principal, row, body.question_id) if result else None
    await db.commit()
    return TeamTurnOut(
        messages=messages,
        recorded=await answer_result(db, principal, result) if result else None,
        next_question_id=following,
    )
