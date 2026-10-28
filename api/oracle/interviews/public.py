"""The customer's routes behind a private interview link: ``/v1/public/interviews/{token}``.

No member credential: the token is the only key, and these operations are never MCP
tools (``oracle.mcp.tools.PUBLIC_OPERATIONS``). Rules (decision V2e):

1. Single use: the first open sets an ``HttpOnly; Secure; SameSite=Strict`` cookie scoped
   to the interview's API path and records ``link_opened_at``; only its sha256 is kept
   (``session_hash``). Every later request needs that cookie: without it, 410 ``used``.
2. Expiry: 7 days from the link's creation (410 ``expired``); a withdrawn link is 410
   ``withdrawn``; a link a new one replaced (Make a new link) is 410 ``replaced``; an
   unknown token is 404 with the same body as ``expired``, so a guess learns nothing.
3. Limits: 2000 characters a message (422), one message every 2 seconds (429), 40
   customer messages at most: the 40th finishes the interview.
4. The shared connection pool: the link, cookie, status and pace checks run before any
   row lock; a message's model call (up to 25 s) holds no row lock and no connection
   (the turn is claimed and committed, the model is called, then the reply is written);
   one turn per link runs at a time, claimed on the interview row so it holds across API
   instances (oracle.interviews.turns.claim_turn), and a message while it runs is 429.
5. Audit: every request on a known interview is audited with the interview id, never
   the token; refused requests at most :data:`REFUSED_AUDITS` a minute per interview
   (counted on its row), so a flood of them cannot fill the audit log.

The token is 32 random bytes, URL-safe; only its sha256 is stored (as ``runtokens``).
"""

import hashlib
import secrets
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from sqlalchemy import Text, case, literal, or_, select, update
from sqlalchemy.dialects.postgresql import ARRAY
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
#: Refused requests audited per interview per window; past it they are not audited.
REFUSED_AUDITS = 20
REFUSAL_WINDOW_SECONDS = 60.0
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


async def _locate(token: str) -> tuple[Interview, str]:
    """The link's interview, read without a lock, and its company's name (an unscoped
    lookup by hash, before the company is known), or 404 ``expired``."""
    if not token or len(token) > 128:
        raise _refuse("expired", 404)
    digest = hash_value(token)
    async with unscoped_session() as s:
        found = (
            await s.execute(
                select(Interview, Tenant.name)
                .join(Tenant, Tenant.id == Interview.tenant_id)
                .where(
                    or_(
                        Interview.link_token_hash == digest,
                        Interview.replaced_link_hashes.contains(literal([digest], ARRAY(Text))),
                    )
                )
            )
        ).first()
    if found is None:
        raise _refuse("expired", 404)
    return found[0], found[1]


def _check(row: Interview, token: str, cookie: str | None, *, opening: bool) -> None:
    """Refuse a link that is withdrawn, expired, finished or bound to another browser,
    and one a new link replaced (``token`` is the request's own link). A closed interview
    says why it closed, whichever of its links is opened."""
    if row.status == "revoked":
        raise _refuse("withdrawn")
    if row.status == "expired" or (row.link_expires_at and row.link_expires_at <= _now()):
        raise _refuse("expired")
    if row.status not in ("invited", "in_progress"):
        raise _refuse("used")
    if not secrets.compare_digest(hash_value(token), row.link_token_hash or ""):
        raise _refuse("replaced")
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


async def _refused(tenant_id: uuid.UUID, interview_id: uuid.UUID, action: str, r: Refused):
    """The refusal's response, audited while this minute's count on the interview row is
    under :data:`REFUSED_AUDITS` (counted and checked in one update)."""
    now = _now()
    fresh = or_(
        Interview.refusals_since.is_(None),
        Interview.refusals_since <= now - timedelta(seconds=REFUSAL_WINDOW_SECONDS),
    )
    async with tenant_session(tenant_id) as db:
        counted = await db.scalar(
            update(Interview)
            .where(Interview.id == interview_id, or_(fresh, Interview.refusals < REFUSED_AUDITS))
            .values(
                refusals=case((fresh, 1), else_=Interview.refusals + 1),
                refusals_since=case((fresh, now), else_=Interview.refusals_since),
                updated_at=Interview.updated_at,
            )
            .returning(Interview.id)
        )
        if counted is not None:
            await audit.record(
                db, ACTOR, f"interview.public_{action}", "interview", interview_id,
                {"refused": r.body.get("reason") or r.status},
            )  # fmt: skip
        await db.commit()
    return JSONResponse(r.body, status_code=r.status)


async def _within(
    token: str,
    request: Request,
    action: str,
    work: Any,
    *,
    opening: bool = False,
    lock: bool = True,
) -> JSONResponse:
    """Run ``work(db, row, company)`` on the link's interview after the link rules;
    audit the request (the interview id, never the token). The rules run first on an
    unlocked read, so a refused request never waits for the row; with ``lock`` they run
    again under the row lock before ``work``."""
    try:
        seen, company = await _locate(token)
    except Refused as r:
        return JSONResponse(r.body, status_code=r.status)
    tenant_id, interview_id = seen.tenant_id, seen.id
    cookie = request.cookies.get(COOKIE)
    try:
        _check(seen, token, cookie, opening=opening)
    except Refused as r:
        return await _refused(tenant_id, interview_id, action, r)
    async with tenant_session(tenant_id) as db:
        row = await db.get(Interview, interview_id, with_for_update=lock or None)
        if row is None:
            return JSONResponse({"reason": "expired"}, status_code=404)
        try:
            _check(row, token, cookie, opening=opening)
            response = await work(db, row, company)
        except Refused as r:
            await db.rollback()
            return await _refused(tenant_id, interview_id, action, r)
        await audit.record(db, ACTOR, f"interview.public_{action}", "interview", row.id)
        await db.commit()
        return response


WAIT: dict[str, Any] = {"detail": "Please wait a moment"}


async def _paced(db: AsyncSession, interview_id: uuid.UUID) -> None:
    """429 when the customer's last message is under ``MIN_INTERVAL_SECONDS`` old, or
    its turn is still running (the newest message is that answer, within the model
    call's deadline)."""
    newest = (
        await db.execute(
            select(InterviewMessage.role, InterviewMessage.kind, InterviewMessage.created_at)
            .where(InterviewMessage.interview_id == interview_id)
            .order_by(InterviewMessage.created_at.desc(), InterviewMessage.id.desc())
            .limit(1)
        )
    ).first()
    last = await db.scalar(
        select(InterviewMessage.created_at)
        .where(
            InterviewMessage.interview_id == interview_id,
            InterviewMessage.role == "interviewee",
        )
        .order_by(InterviewMessage.created_at.desc())
        .limit(1)
    )
    if last is not None and (_now() - last).total_seconds() < MIN_INTERVAL_SECONDS:
        raise Refused(429, WAIT)
    if (
        newest is not None
        and (newest.role, newest.kind) == ("interviewee", "answer")
        and (_now() - newest.created_at).total_seconds() < turns.DEADLINE_SECONDS + 5
    ):
        raise Refused(429, WAIT)


@dataclass
class Claimed:
    """A turn claimed under the row lock and committed: the customer's answer is saved."""

    interview_id: uuid.UUID
    answer_id: uuid.UUID
    position: int
    may_follow_up: bool
    payload: dict[str, Any]
    answer: PublicInterviewMessage


async def _claim(
    tenant_id: uuid.UUID, interview_id: uuid.UUID, token: str, cookie: str | None, text: str
) -> Claimed | JSONResponse:
    """Save the customer's answer under a short row lock. The 40th finishes the
    interview, as does an answer after the last question; either is the response."""
    async with tenant_session(tenant_id) as db:
        row = await db.get(Interview, interview_id, with_for_update=True)
        if row is None:
            return JSONResponse({"reason": "expired"}, status_code=404)
        try:
            _check(row, token, cookie, opening=False)
            await _paced(db, interview_id)
        except Refused as r:
            await db.rollback()
            return await _refused(tenant_id, interview_id, "message", r)
        answer = _post(db, row, "interviewee", "answer", text)
        row.customer_messages += 1
        guide = row.guide or []
        done = row.customer_messages >= MAX_MESSAGES
        if done:
            await _finish(db, row)
        await db.flush()
        await audit.record(db, ACTOR, "interview.public_message", "interview", row.id)
        if done or row.position >= len(guide):
            await db.commit()
            return _json(
                PublicInterviewTurn(messages=_public([answer]), progress=_progress(row), done=done)
            )
        may_follow_up = not row.followed_up
        claimed = Claimed(
            interview_id=row.id,
            answer_id=answer.id,
            position=row.position,
            may_follow_up=may_follow_up,
            payload=turns.turn_payload(row, await _messages(db, row), may_follow_up),
            answer=_public([answer])[0],
        )
        await db.commit()
        return claimed


async def _reply(
    tenant_id: uuid.UUID,
    claimed: Claimed,
    reply: turns.Reply | None,
    spent: turns.Spent | None,
) -> JSONResponse:
    """Write Oracle's reply under a short row lock, unless the interview moved on while
    the model ran (skipped, finished or withdrawn): then only the answer is returned."""
    async with tenant_session(tenant_id) as db:
        row = await db.get(Interview, claimed.interview_id, with_for_update=True)
        if row is None:
            return JSONResponse({"reason": "expired"}, status_code=404)
        newest = await db.scalar(
            select(InterviewMessage.id)
            .where(InterviewMessage.interview_id == row.id)
            .order_by(InterviewMessage.created_at.desc(), InterviewMessage.id.desc())
            .limit(1)
        )
        if (
            row.status != "in_progress"
            or row.position != claimed.position
            or newest != claimed.answer_id
        ):
            return _json(
                PublicInterviewTurn(
                    messages=[claimed.answer],
                    progress=_progress(row),
                    done=row.status != "in_progress",
                )
            )
        new: list[InterviewMessage] = []
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
            if reply.follow_up and claimed.may_follow_up:
                new.append(_post(db, row, "oracle", "follow_up", reply.follow_up))
                row.followed_up = True
            else:
                new += _advance(db, row)
        await db.flush()
        response = _json(
            PublicInterviewTurn(
                messages=[claimed.answer, *_public(new)], progress=_progress(row), done=False
            )
        )
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
            # Only the first open binds the link: it alone takes the row lock.
            await db.refresh(row, with_for_update=True)
            _check(row, token, None, opening=True)
            secret = secrets.token_urlsafe(32)
            row.link_opened_at = _now()
            row.session_hash = hash_value(secret)
            guide = row.guide or []
            # A new link (qa-work-43) on an interview in progress carries it on.
            if guide and row.status == "invited":
                _post(db, row, "oracle", "question", guide[0]["prompt"])
            row.status = "in_progress"
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

    return await _within(token, request, "opened", work, opening=True, lock=False)


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

    try:
        seen, _company = await _locate(token)
    except Refused as r:
        return JSONResponse(r.body, status_code=r.status)
    tenant_id, interview_id = seen.tenant_id, seen.id
    cookie = request.cookies.get(COOKIE)
    try:
        # The cheap check, before any lock: the link and this browser.
        _check(seen, token, cookie, opening=False)
    except Refused as r:
        return await _refused(tenant_id, interview_id, "message", r)
    # One turn per link at a time, claimed on the interview row (any API instance).
    at = await turns.claim_turn(tenant_id, interview_id)
    if at is None:
        return await _refused(tenant_id, interview_id, "message", Refused(429, WAIT))
    try:
        try:
            async with tenant_session(tenant_id) as db:
                await _paced(db, interview_id)  # the pace, on an unlocked read
        except Refused as r:
            return await _refused(tenant_id, interview_id, "message", r)
        claimed = await _claim(tenant_id, interview_id, token, cookie, text)
        if isinstance(claimed, JSONResponse):
            return claimed
        # No row lock and no connection are held across the model call.
        async with tenant_session(tenant_id) as call:
            reply, spent = await turns.customer_turn(call, claimed.payload)
        return await _reply(tenant_id, claimed, reply, spent)
    finally:
        await turns.release_turn(tenant_id, interview_id, at)


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
