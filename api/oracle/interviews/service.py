"""Customer interviews for members: create, draft the guide, edit it, link, withdraw.

Who may do what: viewers read; commenters create; the interview's creator or an
approver edits a Draft, redrafts its guide, creates its link and withdraws it. Nothing
reaches the customer that a member did not approve, except Oracle's acknowledgements
and at most one follow-up per question (oracle.interviews.turns).

The link is 32 random bytes, URL-safe, shown once; only its sha256 is kept
(oracle.interviews.public). It expires 7 days after it is created (decision V2e); the
ticker marks such interviews expired (:func:`expire_due`) and queues the snapshot of one
that holds an answer.
"""

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.auth.deps import Principal
from oracle.auth.models import User
from oracle.authz import has_role
from oracle.export.render import app_url
from oracle.interviews.models import Interview, InterviewMessage
from oracle.interviews.schemas import (
    InterviewCreate,
    InterviewGuideItem,
    InterviewJobState,
    InterviewLinkOut,
    InterviewMessageOut,
    InterviewOut,
    InterviewPatch,
    InterviewSummary,
)
from oracle.jobs.models import LlmJob
from oracle.requests.models import ProductRequest, RequestTheme
from oracle.v2.concurrency import expect_version, flush_or_conflict
from oracle.v2.models import ProductIntake

LINK_DAYS = 7
TITLE_MAX = 200
LINK_EXISTS = "A link exists; withdraw it first"
DRAFT_ONLY = "Only a draft interview can change"
NO_GUIDE = "Draft the questions first"
OPEN = ("draft", "invited", "in_progress")
PRICING_FIXED = "A pricing interview's guide is fixed; edit it instead"

#: H9: the guide of a pricing interview, (prompt, purpose) in order. Questions 1 to 4 are
#: the Van Westendorp questions; the snapshot reads the prices back (oracle.interviews.jobs).
PRICING_GUIDE = (
    ("At what price would this be so cheap you would doubt its quality?", "Too cheap"),
    ("At what price would it start to feel like a bargain?", "Bargain"),
    (
        "At what price would it start to feel expensive, though you would still consider it?",
        "Expensive",
    ),
    ("At what price would it be too expensive to consider?", "Too expensive"),
    ("What would you stop using or paying for if you bought this?", "What it replaces"),
    ("Who approves a purchase like this, and from which budget?", "Budget owner"),
)


class InterviewError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


def _now() -> datetime:
    return datetime.now(UTC)


def can_manage(principal: Principal, row: Interview) -> bool:
    """The interview's creator or an approver (and not a read-only credential)."""
    if principal.read_only or not has_role(principal.role, "commenter"):
        return False
    return principal.id == row.created_by or has_role(principal.role, "approver")


def _manage(principal: Principal, row: Interview) -> None:
    if not can_manage(principal, row):
        raise InterviewError(403, "Only its creator or an approver can change this interview")


async def get_row(db: AsyncSession, interview_id: uuid.UUID, *, lock: bool = False) -> Interview:
    row = await db.get(Interview, interview_id, with_for_update=lock)
    if row is None:
        raise InterviewError(404, "Interview not found")
    return row


def pricing_guide() -> list[dict[str, Any]]:
    return [
        {"id": uuid.uuid4().hex[:12], "prompt": prompt, "purpose": purpose}
        for prompt, purpose in PRICING_GUIDE
    ]


def queue_job(row: Interview, kind: str, requested_by: uuid.UUID | None) -> LlmJob:
    return LlmJob(kind=kind, interview_id=row.id, requested_by=requested_by, input={})


async def create(db: AsyncSession, principal: Principal, body: InterviewCreate) -> Interview:
    subject = body.subject
    if subject.intake_id is not None:
        intake = await db.get(ProductIntake, subject.intake_id)
        if intake is None:
            raise InterviewError(404, "PRD idea not found")
        title = intake.title
    elif subject.theme_id is not None:
        theme = await db.get(RequestTheme, subject.theme_id)
        if theme is None or theme.archived_at is not None:
            raise InterviewError(404, "Request theme not found")
        title = theme.title
    else:
        title = subject.topic or ""
    row = Interview(
        kind="customer",
        intake_id=subject.intake_id,
        theme_id=subject.theme_id,
        topic=subject.topic,
        title=title[:TITLE_MAX],
        interviewee_name=body.interviewee_name,
        interviewee_company=body.interviewee_company,
        preset=body.preset,
        created_by=principal.id,
    )
    db.add(row)
    await db.flush()
    if body.preset == "pricing":
        # The preset is the guide: no guide job, no model cost.
        row.guide = pricing_guide()
    else:
        job = queue_job(row, "interview_guide", principal.id)
        db.add(job)
        await db.flush()
        row.guide_job_id = job.id
    await db.flush()
    data = {"kind": row.kind} | ({"preset": row.preset} if row.preset else {})
    await audit.record(db, principal, "interview.created", "interview", row.id, data)
    return row


async def _jobs(db: AsyncSession, ids: list[uuid.UUID | None]) -> dict[uuid.UUID, LlmJob]:
    wanted = [i for i in ids if i is not None]
    if not wanted:
        return {}
    return {j.id: j for j in await db.scalars(select(LlmJob).where(LlmJob.id.in_(wanted)))}


def _state(job: LlmJob | None) -> InterviewJobState | None:
    return InterviewJobState(id=job.id, status=job.status, error=job.error) if job else None


async def _names(db: AsyncSession, ids: list[uuid.UUID]) -> dict[uuid.UUID, str]:
    if not ids:
        return {}
    rows = await db.execute(select(User.id, User.email).where(User.id.in_(ids)))
    return {i: e for i, e in rows.all()}


async def out(db: AsyncSession, principal: Principal, row: Interview) -> InterviewOut:
    messages = list(
        await db.scalars(
            select(InterviewMessage)
            .where(InterviewMessage.interview_id == row.id)
            .order_by(InterviewMessage.created_at, InterviewMessage.id)
        )
    )
    if row.kind == "team" and principal.id != row.interviewee_user_id:
        from oracle.interviews.team import visible

        messages = await visible(db, principal, messages)
    jobs = await _jobs(db, [row.guide_job_id, row.snapshot_job_id])
    request_ids = list(
        await db.scalars(
            select(ProductRequest.id)
            .where(ProductRequest.interview_id == row.id)
            .order_by(ProductRequest.created_at, ProductRequest.id)
        )
    )
    names = await _names(db, [row.created_by])
    return InterviewOut(
        id=row.id,
        kind=row.kind,  # type: ignore[arg-type]
        status=row.status,  # type: ignore[arg-type]
        preset=row.preset,  # type: ignore[arg-type]
        title=row.title,
        intake_id=row.intake_id,
        theme_id=row.theme_id,
        topic=row.topic,
        intro=row.intro,
        guide=[InterviewGuideItem(**q) for q in row.guide or []],
        guide_job=_state(jobs.get(row.guide_job_id)) if row.guide_job_id else None,
        interviewee_name=row.interviewee_name,
        interviewee_company=row.interviewee_company,
        link_expires_at=row.link_expires_at,
        link_opened_at=row.link_opened_at,
        created_by=row.created_by,
        created_by_name=names.get(row.created_by),
        created_at=row.created_at,
        finished_at=row.finished_at,
        lock_version=row.lock_version,
        messages=[
            InterviewMessageOut(
                id=m.id,
                role=m.role,  # type: ignore[arg-type]
                kind=m.kind,
                body=m.body,
                guide_item=m.guide_item,
                question_id=m.question_id,
                created_at=m.created_at,
            )
            for m in messages
        ],
        snapshot=row.snapshot or {},
        snapshot_job=_state(jobs.get(row.snapshot_job_id)) if row.snapshot_job_id else None,
        request_ids=request_ids,
        can_manage=can_manage(principal, row),
    )


async def list_interviews(
    db: AsyncSession,
    *,
    status: str | None = None,
    intake_id: uuid.UUID | None = None,
    theme_id: uuid.UUID | None = None,
    kind: str | None = None,
    preset: str | None = None,
) -> list[InterviewSummary]:
    q = select(Interview).order_by(Interview.created_at.desc(), Interview.id)
    if status:
        q = q.where(Interview.status == status)
    if intake_id:
        q = q.where(Interview.intake_id == intake_id)
    if theme_id:
        q = q.where(Interview.theme_id == theme_id)
    if kind:
        q = q.where(Interview.kind == kind)
    if preset:
        q = q.where(Interview.preset == preset)
    rows = list(await db.scalars(q))
    counts: dict[uuid.UUID, int] = {}
    if rows:
        counted = await db.execute(
            select(ProductRequest.interview_id, func.count())
            .where(ProductRequest.interview_id.in_([r.id for r in rows]))
            .group_by(ProductRequest.interview_id)
        )
        counts = {i: n for i, n in counted.all()}
    names = await _names(db, list({r.created_by for r in rows}))
    return [
        InterviewSummary(
            id=r.id,
            kind=r.kind,  # type: ignore[arg-type]
            status=r.status,  # type: ignore[arg-type]
            preset=r.preset,  # type: ignore[arg-type]
            title=r.title,
            interviewee_name=r.interviewee_name,
            interviewee_company=r.interviewee_company,
            created_by=r.created_by,
            created_by_name=names.get(r.created_by),
            created_at=r.created_at,
            finished_at=r.finished_at,
            request_count=counts.get(r.id, 0),
        )
        for r in rows
    ]


def _guide(items: list[Any], before: list[dict[str, Any]]) -> list[dict[str, Any]]:
    known = {q["id"] for q in before}
    seen: set[str] = set()
    guide = []
    for item in items:
        gid = item.id if item.id in known and item.id not in seen else uuid.uuid4().hex[:12]
        seen.add(gid)
        guide.append({"id": gid, "prompt": item.prompt, "purpose": item.purpose or None})
    return guide


async def patch(
    db: AsyncSession, principal: Principal, interview_id: uuid.UUID, body: InterviewPatch
) -> Interview:
    row = await get_row(db, interview_id, lock=True)
    _manage(principal, row)
    expect_version(row, body.lock_version)
    if row.status != "draft":
        raise InterviewError(409, DRAFT_ONLY)
    fields = body.model_fields_set
    if "intro" in fields:
        row.intro = body.intro or None
    if "guide" in fields and body.guide is not None:
        row.guide = _guide(body.guide, row.guide or [])
    if "interviewee_name" in fields and body.interviewee_name:
        row.interviewee_name = body.interviewee_name
    if "interviewee_company" in fields:
        row.interviewee_company = body.interviewee_company
    await flush_or_conflict(db)
    await audit.record(
        db, principal, "interview.edited", "interview", row.id, {"fields": sorted(fields)}
    )
    return row


async def redraft(db: AsyncSession, principal: Principal, interview_id: uuid.UUID) -> Interview:
    row = await get_row(db, interview_id, lock=True)
    _manage(principal, row)
    if row.status != "draft":
        raise InterviewError(409, DRAFT_ONLY)
    if row.preset is not None:
        # Refused rather than refilled: a refill would silently undo a member's edits,
        # and the preset has nothing for Oracle to draft.
        raise InterviewError(409, PRICING_FIXED)
    current = await db.get(LlmJob, row.guide_job_id) if row.guide_job_id else None
    if current is not None and current.status in ("queued", "running"):
        raise InterviewError(409, "Oracle is already drafting the questions")
    job = queue_job(row, "interview_guide", principal.id)
    db.add(job)
    await db.flush()
    row.guide_job_id = job.id
    await flush_or_conflict(db)
    await audit.record(db, principal, "interview.guide_requested", "interview", row.id)
    return row


async def create_link(
    db: AsyncSession, principal: Principal, interview_id: uuid.UUID
) -> InterviewLinkOut:
    row = await get_row(db, interview_id, lock=True)
    _manage(principal, row)
    if row.link_token_hash is not None:
        raise InterviewError(409, LINK_EXISTS)
    if row.status != "draft" or not row.guide:
        raise InterviewError(409, NO_GUIDE)
    from oracle.interviews.public import new_token

    raw, digest = new_token()
    row.link_token_hash = digest
    row.link_expires_at = _now() + timedelta(days=LINK_DAYS)
    row.status = "invited"
    await flush_or_conflict(db)
    await audit.record(db, principal, "interview.link_created", "interview", row.id)
    return InterviewLinkOut(url=app_url(f"/i/{raw}"), expires_at=row.link_expires_at)


async def revoke(db: AsyncSession, principal: Principal, interview_id: uuid.UUID) -> Interview:
    row = await get_row(db, interview_id, lock=True)
    _manage(principal, row)
    if row.status not in OPEN:
        raise InterviewError(409, f"This interview is already {row.status}")
    row.status = "revoked"
    await flush_or_conflict(db)
    await audit.record(db, principal, "interview.revoked", "interview", row.id)
    return row


async def has_answer(db: AsyncSession, row: Interview) -> bool:
    found = await db.scalar(
        select(InterviewMessage.id)
        .where(InterviewMessage.interview_id == row.id, InterviewMessage.kind == "answer")
        .limit(1)
    )
    return found is not None


async def queue_snapshot(db: AsyncSession, row: Interview) -> None:
    """Queue the snapshot when the interview holds at least one answer."""
    if row.snapshot_job_id is not None or not await has_answer(db, row):
        return
    job = queue_job(row, "interview_snapshot", None)
    db.add(job)
    await db.flush()
    row.snapshot_job_id = job.id


async def expire_due(db: AsyncSession) -> int:
    """Invited or in-progress customer interviews past their link's expiry become
    expired; one with an answer gets its snapshot. The caller commits."""
    rows = list(
        await db.scalars(
            select(Interview)
            .where(
                Interview.kind == "customer",
                Interview.status.in_(("invited", "in_progress")),
                Interview.link_expires_at <= _now(),
            )
            .with_for_update(skip_locked=True)
        )
    )
    for row in rows:
        row.status = "expired"
        await queue_snapshot(db, row)
        await audit.record(db, audit.ORACLE, "interview.expired", "interview", row.id)
    await db.flush()
    return len(rows)
