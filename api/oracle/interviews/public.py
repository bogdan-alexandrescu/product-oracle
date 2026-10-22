"""The customer's routes behind a private interview link: ``/v1/public/interviews/{token}``.

No member credential: the token is the only key, and these operations are never MCP
tools (``oracle.mcp.tools.PUBLIC_OPERATIONS``). Rules (decision V2e):

1. Single use: the first open sets an ``HttpOnly; Secure; SameSite=Strict`` cookie scoped
   to the interview's API path and records ``link_opened_at``; only its sha256 is kept
   (``session_hash``). Every later request needs that cookie: without it, 410 ``used``.
2. Expiry: 7 days from the link's creation (410 ``expired``); a withdrawn link is 410
   ``withdrawn``; an unknown token is 404 with the same body as ``expired``, so a guess
   learns nothing.
3. Limits: 2000 characters a message (422), one message every 2 seconds (429), 40
   customer messages at most: the 40th finishes the interview.

The token is 32 random bytes, URL-safe; only its sha256 is stored (as ``runtokens``). Every
request on a known interview is audited with the interview id, never the token.
"""

import hashlib
import secrets
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.interviews import service, turns
from oracle.interviews.models import Interview, InterviewMessage
from oracle.interviews.schemas import (
    MESSAGE_MAX,
    PublicInterview,
    PublicInterviewDone,
    PublicInterviewMessage,
    PublicInterviewMessageIn,
    PublicInterviewProgress,
    PublicInterviewRefusal,
    PublicInterviewTurn,
)
from oracle.models import Tenant
from oracle.tenancy import tenant_session, unscoped_session

router = APIRouter(prefix="/v1/public/interviews", tags=["interviews"])

#: The interviewee's routes; never MCP tools (oracle.mcp.tools).
OPERATIONS = (
    "public_interview",
    "public_interview_message",
    "public_interview_skip",
    "public_interview_finish",
)
COOKIE = "po_interview"
MIN_INTERVAL_SECONDS = 2.0
MAX_MESSAGES = 40
ACTOR = "interviewee"
CLOSING = "That was my last question. Press Send my answers when you're ready."
SKIPPED = "(skipped)"
REFUSALS: dict[int | str, dict[str, Any]] = {
    404: {
        "model": PublicInterviewRefusal,
        "description": "Unknown link (the body of an expired one)",
    },
    410: {
        "model": PublicInterviewRefusal,
        "description": "Used in another browser, expired or withdrawn",
    },
}


def hash_value(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def new_token() -> tuple[str, str]:
    """A new link token (32 random bytes, URL-safe) and its sha256."""
    raw = secrets.token_urlsafe(32)
    return raw, hash_value(raw)


def _now() -> datetime:
    return datetime.now(UTC)


class Refused(Exception):
    def __init__(self, status: int, body: dict[str, Any]) -> None:
        super().__init__(body)
        self.status = status
        self.body = body


def _refuse(reason: str, status: int = 410) -> Refused:
    return Refused(status, {"reason": reason})


async def _locate(token: str) -> tuple[uuid.UUID, uuid.UUID, str]:
    """(company id, interview id, company name) of a link token, before the company is
    known (an unscoped lookup by hash), or 404 ``expired``."""
    if not token or len(token) > 128:
        raise _refuse("expired", 404)
    async with unscoped_session() as s:
        found = (
            await s.execute(
                select(Interview.tenant_id, Interview.id, Tenant.name)
                .join(Tenant, Tenant.id == Interview.tenant_id)
                .where(Interview.link_token_hash == hash_value(token))
            )
        ).first()
    if found is None:
        raise _refuse("expired", 404)
    return found[0], found[1], found[2]


def _check(row: Interview, cookie: str | None, *, opening: bool) -> None:
    """Refuse a link that is withdrawn, expired, finished or bound to another browser."""
    if row.status == "revoked":
        raise _refuse("withdrawn")
    if row.status == "expired" or (row.link_expires_at and row.link_expires_at <= _now()):
        raise _refuse("expired")
    if row.status not in ("invited", "in_progress"):
        raise _refuse("used")
    if row.link_opened_at is None:
        if not opening:
            raise _refuse("used")
        return
    if not cookie or row.session_hash is None:
        raise _refuse("used")
    if not secrets.compare_digest(hash_value(cookie), row.session_hash):
        raise _refuse("used")


async def _messages(db: AsyncSession, row: Interview) -> list[InterviewMessage]:
    return list(
        await db.scalars(
            select(InterviewMessage)
            .where(InterviewMessage.interview_id == row.id)
            .order_by(InterviewMessage.created_at, InterviewMessage.id)
        )
    )


def _public(messages: list[InterviewMessage]) -> list[PublicInterviewMessage]:
    return [
        PublicInterviewMessage(role=turns.role_of(m), body=m.body, at=m.created_at)  # type: ignore[arg-type]
        for m in messages
        if m.kind not in ("skip", "intro")
    ]


def _progress(row: Interview) -> PublicInterviewProgress:
    total = len(row.guide or [])
    return PublicInterviewProgress(asked=min(row.position + 1, total), total=total)


def _post(
    db: AsyncSession, row: Interview, role: str, kind: str, body: str, **extra: Any
) -> InterviewMessage:
    guide = row.guide or []
    current = guide[row.position]["id"] if row.position < len(guide) else None
    message = InterviewMessage(
        interview_id=row.id,
        role=role,
        kind=kind,
        body=body,
        guide_item=current,
        created_at=_now(),
        **extra,
    )
    db.add(message)
    return message


def _advance(db: AsyncSession, row: Interview, **spent: Any) -> list[InterviewMessage]:
    """Move to the next approved question, word for word, or the closing line."""
    row.position += 1
    row.followed_up = False
    guide = row.guide or []
    if row.position < len(guide):
        return [_post(db, row, "oracle", "question", guide[row.position]["prompt"], **spent)]
    return [_post(db, row, "oracle", "closing", CLOSING, **spent)]


async def _finish(db: AsyncSession, row: Interview) -> None:
    row.status = "finished"
    row.finished_at = _now()
    await service.queue_snapshot(db, row)


async def _within(
    token: str,
    request: Request,
    action: str,
    work: Any,
    *,
    opening: bool = False,
) -> JSONResponse:
    """Run ``work(db, row, company)`` on the link's interview under its row lock, after
    the link rules; audit the request (the interview id, never the token)."""
    try:
        tenant_id, interview_id, company = await _locate(token)
    except Refused as r:
        return JSONResponse(r.body, status_code=r.status)
    cookie = request.cookies.get(COOKIE)
    async with tenant_session(tenant_id) as db:
        row = await db.get(Interview, interview_id, with_for_update=True)
        if row is None:
            return JSONResponse({"reason": "expired"}, status_code=404)
        try:
            _check(row, cookie, opening=opening)
            response = await work(db, row, company)
        except Refused as r:
            await db.rollback()
            await audit.record(
                db, ACTOR, f"interview.public_{action}", "interview", interview_id,
                {"refused": r.body.get("reason") or r.status},
            )  # fmt: skip
            await db.commit()
            return JSONResponse(r.body, status_code=r.status)
        await audit.record(db, ACTOR, f"interview.public_{action}", "interview", row.id)
        await db.commit()
        return response


def _json(model: Any, status_code: int = 200) -> JSONResponse:
    return JSONResponse(model.model_dump(mode="json"), status_code=status_code)


@router.get(
    "/{token}",
    response_model=PublicInterview,
    responses=REFUSALS,
    name="public_interview",
)
async def public_interview(token: str, request: Request) -> JSONResponse:
    """The interview behind a private link (no member credential). The first open binds
    the link to this browser with a cookie and posts Oracle's first question."""

    async def work(db: AsyncSession, row: Interview, company: str) -> JSONResponse:
        secret = None
        if row.link_opened_at is None:
            secret = secrets.token_urlsafe(32)
            row.link_opened_at = _now()
            row.session_hash = hash_value(secret)
            row.status = "in_progress"
            guide = row.guide or []
            if guide:
                _post(db, row, "oracle", "question", guide[0]["prompt"])
            await db.flush()
        page = PublicInterview(
            company=company,
            interviewee_name=row.interviewee_name or "",
            intro=row.intro or "",
            status=row.status,  # type: ignore[arg-type]
            messages=_public(await _messages(db, row)),
            progress=_progress(row),
        )
        response = _json(page)
        if secret is not None:
            response.set_cookie(
                COOKIE,
                secret,
                max_age=int(timedelta(days=service.LINK_DAYS).total_seconds()),
                path=f"/v1/public/interviews/{token}",
                httponly=True,
                secure=True,
                samesite="strict",
            )
        return response

    return await _within(token, request, "opened", work, opening=True)


@router.post(
    "/{token}/messages",
    response_model=PublicInterviewTurn,
    responses={**REFUSALS, 422: {"description": "Empty or too long"}, 429: {}},
    name="public_interview_message",
)
async def public_interview_message(
    token: str, body: PublicInterviewMessageIn, request: Request
) -> JSONResponse:
    """The customer's answer; Oracle acknowledges it and asks one follow-up or the next
    approved question."""
    text = body.body.strip()
    if not text or len(text) > MESSAGE_MAX:
        return JSONResponse(
            {"detail": f"Write a message of at most {MESSAGE_MAX} characters"}, status_code=422
        )

    async def work(db: AsyncSession, row: Interview, _company: str) -> JSONResponse:
        last = await db.scalar(
            select(InterviewMessage.created_at)
            .where(InterviewMessage.interview_id == row.id, InterviewMessage.role == "interviewee")
            .order_by(InterviewMessage.created_at.desc())
            .limit(1)
        )
        if last is not None and (_now() - last).total_seconds() < MIN_INTERVAL_SECONDS:
            raise Refused(429, {"detail": "Please wait a moment"})
        new = [_post(db, row, "interviewee", "answer", text)]
        row.customer_messages += 1
        guide = row.guide or []
        if row.customer_messages >= MAX_MESSAGES:
            await _finish(db, row)
            await db.flush()
            return _json(
                PublicInterviewTurn(messages=_public(new), progress=_progress(row), done=True)
            )
        if row.position < len(guide):
            await db.flush()
            may_follow_up = not row.followed_up
            payload = turns.turn_payload(row, await _messages(db, row), may_follow_up)
            reply, spent = await turns.customer_turn(db, payload)
            if reply is None:
                cost = (
                    {"model": spent.model, "usage": spent.usage, "cost_usd": spent.cost_usd}
                    if spent
                    else {}
                )
                new += _advance(db, row, **cost)
            else:
                cost = {"model": reply.model, "usage": reply.usage, "cost_usd": reply.cost_usd}
                new.append(_post(db, row, "oracle", "ack", reply.ack, **cost))
                if reply.follow_up and may_follow_up:
                    new.append(_post(db, row, "oracle", "follow_up", reply.follow_up))
                    row.followed_up = True
                else:
                    new += _advance(db, row)
        await db.flush()
        return _json(
            PublicInterviewTurn(messages=_public(new), progress=_progress(row), done=False)
        )

    return await _within(token, request, "message", work)


@router.post(
    "/{token}/skip",
    response_model=PublicInterviewTurn,
    responses=REFUSALS,
    name="public_interview_skip",
)
async def public_interview_skip(token: str, request: Request) -> JSONResponse:
    """Skip the current question: Oracle asks the next one."""

    async def work(db: AsyncSession, row: Interview, _company: str) -> JSONResponse:
        new: list[InterviewMessage] = []
        if row.position < len(row.guide or []):
            _post(db, row, "interviewee", "skip", SKIPPED)
            new = _advance(db, row)
        await db.flush()
        return _json(
            PublicInterviewTurn(messages=_public(new), progress=_progress(row), done=False)
        )

    return await _within(token, request, "skip", work)


@router.post(
    "/{token}/finish",
    response_model=PublicInterviewDone,
    responses=REFUSALS,
    name="public_interview_finish",
)
async def public_interview_finish(token: str, request: Request) -> JSONResponse:
    """Send my answers: the interview finishes and the link stops working."""

    async def work(db: AsyncSession, row: Interview, _company: str) -> JSONResponse:
        await _finish(db, row)
        await db.flush()
        return _json(PublicInterviewDone(done=True))

    return await _within(token, request, "finished", work)
