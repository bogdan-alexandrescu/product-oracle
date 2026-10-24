"""Requests and request themes (C1). Every route is also an MCP tool.

Roles: viewers read; commenters add requests and edit the words of their own while New;
approvers and owners qualify, merge, disqualify, reopen, set goals, theme, feature and
PRD, accept Oracle's suggestions, and create and archive themes. A run token reads
requests and themes under ``read:baseline`` and writes none (oracle.mcp.scopes).
Another company's ids are 404 (tenant-scoped session).

Oracle's triage (oracle.requests.triage): Classify now starts a run (approvers), approvers
turn the daily 07:00 PT run on or off (off by default), and the
requests it found in a person's own sources are theirs alone until filed (decision S6):
nobody else, run tokens included, lists, files or dismisses them.
"""

import uuid
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status

from oracle.auth.deps import Principal, TenantDB, same_origin
from oracle.authz import require_role, require_role_now
from oracle.requests import launch_requesters, service, triage
from oracle.requests.schemas import (
    AcceptSuggestionIn,
    CandidateFile,
    CandidateOut,
    Channel,
    DeclineSuggestionIn,
    DisqualifyIn,
    DraftJobOut,
    KeepNoIn,
    MergeIn,
    QualifyIn,
    ReopenIn,
    ReplyOut,
    ReplyPatch,
    ReplySent,
    ReplySkip,
    RequestCreate,
    RequestDetail,
    RequestList,
    RequestOut,
    RequestPatch,
    RequestThemeCreate,
    RequestThemeOut,
    RequestThemePatch,
    State,
    ThemeProblemIn,
    TriageDailyIn,
    TriageStart,
    TriageStatus,
)
from oracle.runs import service as runs_service
from oracle.runs.schemas import RunOut

router = APIRouter(prefix="/v1", tags=["requests"])
# H6's request lookup (H10): launch notes reach the people who filed requests too.
launch_requesters.register()

Viewer = Annotated[Principal, Depends(require_role("viewer"))]
Commenter = Annotated[Principal, Depends(require_role("commenter"))]
Approver = Annotated[Principal, Depends(require_role_now("approver"))]


def _http(exc: service.RequestError | triage.TriageError) -> HTTPException:
    return HTTPException(exc.status, str(exc))


@router.get("/requests", response_model=RequestList)
async def list_requests(
    db: TenantDB,
    _: Viewer,
    state: State | None = None,
    theme_id: Annotated[
        str | None, Query(description="A theme id, or `none` for requests with no theme")
    ] = None,
    goal_id: uuid.UUID | None = None,
    channel: Channel | None = None,
    q: Annotated[str | None, Query(max_length=200, description="Title or body search")] = None,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
) -> RequestList:
    """The request queue, newest first, with the tab counts and the Sources facet."""
    theme: uuid.UUID | None = None
    if theme_id and theme_id != "none":
        try:
            theme = uuid.UUID(theme_id)
        except ValueError as e:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, "theme_id: a theme id or none"
            ) from e
    return await service.list_requests(
        db,
        state=state,
        theme_id=theme,
        no_theme=theme_id == "none",
        goal_id=goal_id,
        channel=channel,
        q=q,
        limit=limit,
        offset=offset,
    )


@router.post("/requests", response_model=RequestOut, status_code=status.HTTP_201_CREATED)
async def create_request(data: RequestCreate, db: TenantDB, principal: Commenter) -> RequestOut:
    """Add a request, in the asker's words. A ``source_item_id`` of one of your own items
    shares its title, link and a 400-character excerpt with everyone who sees Requests."""
    try:
        row = await service.create(db, principal, data)
    except service.RequestError as e:
        raise _http(e) from e
    await db.commit()
    return await service.out_one(db, row)


@router.get("/requests/triage", response_model=TriageStatus)
async def get_request_triage(db: TenantDB, principal: Viewer) -> TriageStatus:
    """Oracle's latest triage run: under way, or how many suggestions it made and how many
    possible requests it found in your own sources."""
    return await triage.status(db, principal)


@router.put(
    "/requests/triage/daily", response_model=TriageStatus, dependencies=[Depends(same_origin)]
)
async def set_request_triage_daily(
    data: TriageDailyIn, db: TenantDB, principal: Approver
) -> TriageStatus:
    """Turn "Daily triage at 07:00 PT" on or off (approvers and owners; off by default).
    While on, Oracle's daily run acts as whoever turned it on, while they are an active
    approver or owner, else as the longest-standing active owner. A run's token never
    turns it (403); a read-only credential changes nothing."""
    if principal.is_run or principal.run_token_id is not None:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "A run's agents cannot turn the daily triage on or off"
        )
    await triage.set_daily(db, principal, data.on)
    return await triage.status(db, principal)


@router.post("/requests/triage", response_model=RunOut, status_code=status.HTTP_201_CREATED)
async def start_request_triage(data: TriageStart, db: TenantDB, principal: Approver) -> RunOut:
    """Classify now: start Oracle's triage run (one analyst step, quick depth: $1.50). It
    suggests a theme, goals, a duplicate and a feature for every New request and looks
    through your own sources for requests; it decides nothing. 409 while one is under way.
    Oracle also classifies new requests every day at 07:00 PT."""
    try:
        run_id = await triage.classify_now(db, principal, data.depth)
    except triage.TriageError as e:
        raise _http(e) from e
    except runs_service.RunError as e:
        raise HTTPException(e.status, str(e)) from e
    await runs_service.submit_queued(db, run_id)
    return await runs_service.read_run(db, run_id, principal)


@router.get("/requests/{request_id}", response_model=RequestDetail)
async def get_request(request_id: uuid.UUID, db: TenantDB, _: Viewer) -> RequestDetail:
    """A request with what was merged into it and its linked PRD's review progress."""
    try:
        return await service.detail(db, request_id)
    except service.RequestError as e:
        raise _http(e) from e


@router.patch("/requests/{request_id}", response_model=RequestOut)
async def update_request(
    request_id: uuid.UUID, data: RequestPatch, db: TenantDB, principal: Commenter
) -> RequestOut:
    """The filer edits title and body while New; approvers set goals, theme, feature and
    the linked PRD."""
    try:
        row = await service.patch(db, principal, request_id, data)
    except service.RequestError as e:
        raise _http(e) from e
    await db.commit()
    return await service.out_one(db, row)


@router.post("/requests/{request_id}/qualify", response_model=RequestOut)
async def qualify_request(
    request_id: uuid.UUID, data: QualifyIn, db: TenantDB, principal: Approver
) -> RequestOut:
    """Qualify a New request; it needs a confirmed goal (decision F3b)."""
    try:
        row = await service.qualify(db, principal, request_id, data)
    except service.RequestError as e:
        raise _http(e) from e
    await db.commit()
    return await service.out_one(db, row)


@router.post("/requests/{request_id}/merge", response_model=RequestOut)
async def merge_request(
    request_id: uuid.UUID, data: MergeIn, db: TenantDB, principal: Approver
) -> RequestOut:
    """Merge into another request (the root of its chain); a cycle is refused (409)."""
    try:
        row = await service.merge(db, principal, request_id, data)
    except service.RequestError as e:
        raise _http(e) from e
    await db.commit()
    return await service.out_one(db, row)


@router.post("/requests/{request_id}/disqualify", response_model=RequestOut)
async def disqualify_request(
    request_id: uuid.UUID, data: DisqualifyIn, db: TenantDB, principal: Approver
) -> RequestOut:
    """Disqualify with a reason; Other needs a note. A reason that answers the asker (and
    Won't do with a note) is a no (H10): a decided decision in the log, reviewed in 90
    days, and a reply to everyone who asked, drafted by Oracle. On the stop list needs a
    stop choice and Already possible a feature as its ``basis``."""
    try:
        row = await service.disqualify(db, principal, request_id, data)
    except service.RequestError as e:
        raise _http(e) from e
    await db.commit()
    return await service.out_one(db, row)


@router.post("/requests/{request_id}/reopen", response_model=RequestOut)
async def reopen_request(
    request_id: uuid.UUID, data: ReopenIn, db: TenantDB, principal: Approver
) -> RequestOut:
    """Bring a merged or disqualified request back to New. A logged no is reversed (a
    review by you) and its Drafted replies are withdrawn."""
    try:
        row = await service.reopen(db, principal, request_id, data)
    except service.RequestError as e:
        raise _http(e) from e
    await db.commit()
    return await service.out_one(db, row)


@router.post("/requests/{request_id}/suggestion/accept", response_model=RequestOut)
async def accept_request_suggestion(
    request_id: uuid.UUID, data: AcceptSuggestionIn, db: TenantDB, principal: Approver
) -> RequestOut:
    """Accept parts of Oracle's suggestion: theme, goals, feature, or duplicate (merges)."""
    try:
        row = await service.accept_suggestion(db, principal, request_id, data)
    except service.RequestError as e:
        raise _http(e) from e
    await db.commit()
    return await service.out_one(db, row)


@router.post("/requests/{request_id}/suggestion/decline", response_model=RequestOut)
async def decline_request_suggestion(
    request_id: uuid.UUID, data: DeclineSuggestionIn, db: TenantDB, principal: Approver
) -> RequestOut:
    """Decline Oracle's suggestion; nothing else changes."""
    try:
        row = await service.decline_suggestion(db, principal, request_id, data)
    except service.RequestError as e:
        raise _http(e) from e
    await db.commit()
    return await service.out_one(db, row)


# --- why-not replies (H10) ---------------------------------------------------------------


@router.get("/requests/{request_id}/replies", response_model=list[ReplyOut])
async def list_request_replies(request_id: uuid.UUID, db: TenantDB, _: Viewer) -> list[ReplyOut]:
    """The replies to the people who asked for a request said no to: name as given, how
    they asked, state and the draft. A run token reads them under ``read:sources``: they
    quote what people asked."""
    try:
        return [ReplyOut(**r) for r in await service.list_replies(db, request_id)]
    except service.RequestError as e:
        raise _http(e) from e


async def _reply(db: TenantDB, reply) -> ReplyOut:  # type: ignore[no-untyped-def]
    await db.commit()
    return ReplyOut(**await service.reply_out(db, reply))


@router.patch("/request-replies/{reply_id}", response_model=ReplyOut)
async def update_request_reply(
    reply_id: uuid.UUID, data: ReplyPatch, db: TenantDB, principal: Commenter
) -> ReplyOut:
    """Edit a Drafted reply (at most 2,000 characters). The filer of the request, an
    approver or an owner. A date or "later" carries the warning "Sounds like a promise"."""
    try:
        reply = await service.update_reply(db, principal, reply_id, data.body, data.lock_version)
    except service.RequestError as e:
        raise _http(e) from e
    return await _reply(db, reply)


@router.post("/request-replies/{reply_id}/sent", response_model=ReplyOut)
async def mark_request_reply_sent(
    reply_id: uuid.UUID, data: ReplySent, db: TenantDB, principal: Commenter
) -> ReplyOut:
    """Mark sent: how (Email, Slack, Call, In the app, Other) and the day (default today
    in the Company time zone). Oracle sends nothing itself."""
    try:
        reply = await service.mark_reply_sent(db, principal, reply_id, data.channel, data.sent_on)
    except service.RequestError as e:
        raise _http(e) from e
    return await _reply(db, reply)


@router.post("/request-replies/{reply_id}/skip", response_model=ReplyOut)
async def skip_request_reply(
    reply_id: uuid.UUID, data: ReplySkip, db: TenantDB, principal: Commenter
) -> ReplyOut:
    """Skip a reply, with a reason (for example "Asked anonymously")."""
    try:
        reply = await service.skip_reply(db, principal, reply_id, data.reason)
    except service.RequestError as e:
        raise _http(e) from e
    return await _reply(db, reply)


@router.post("/request-replies/{reply_id}/notify", response_model=ReplyOut)
async def notify_request_reply(reply_id: uuid.UUID, db: TenantDB, principal: Commenter) -> ReplyOut:
    """Tell them in Oracle: the member who asked finds the reply in their Inbox. 409 when
    the asker is not a member."""
    try:
        reply = await service.notify_reply(db, principal, reply_id)
    except service.RequestError as e:
        raise _http(e) from e
    return await _reply(db, reply)


@router.post(
    "/requests/{request_id}/replies/draft",
    response_model=DraftJobOut,
    status_code=status.HTTP_202_ACCEPTED,
)
async def draft_request_replies(
    request_id: uuid.UUID, db: TenantDB, principal: Commenter
) -> DraftJobOut:
    """Draft again with Oracle: one ``why_not_reply`` job on Oracle's own model for the
    replies still Drafted; poll ``GET /v1/llm-jobs/{job_id}``. 409 while one runs and
    while Words for people outside is at Observe."""
    try:
        job_id = await service.draft_replies(db, principal, request_id)
    except service.RequestError as e:
        raise _http(e) from e
    await db.commit()
    return DraftJobOut(job_id=job_id)


@router.post("/requests/{request_id}/replies/reopened", response_model=list[ReplyOut])
async def tell_reopened(request_id: uuid.UUID, db: TenantDB, principal: Approver) -> list[ReplyOut]:
    """Tell the people who asked, after Reopen: a reply saying it is being looked at
    again, for each asker whose no was sent or told."""
    try:
        made = await service.tell_reopened(db, principal, request_id)
    except service.RequestError as e:
        raise _http(e) from e
    await db.commit()
    return [
        ReplyOut(**r)
        for r in await service.list_replies(db, request_id)
        if r["id"] in {m.id for m in made}
    ]


@router.post("/requests/{request_id}/keep-no", response_model=RequestOut)
async def keep_request_no(
    request_id: uuid.UUID, data: KeepNoIn, db: TenantDB, principal: Commenter
) -> RequestOut:
    """Keep the no: the decision's approver records a reaffirmed review, and asked again
    counts from now."""
    try:
        row = await service.keep_no(db, principal, request_id, data.note)
    except service.RequestError as e:
        raise _http(e) from e
    await db.commit()
    return await service.out_one(db, row)


@router.post("/request-themes/{theme_id}/problem/confirm", response_model=RequestThemeOut)
async def confirm_request_theme_problem(
    theme_id: uuid.UUID, data: ThemeProblemIn, db: TenantDB, principal: Approver
) -> RequestThemeOut:
    """Confirm Oracle's suggested problem: what replies and agents cite."""
    try:
        theme = await service.confirm_problem(db, principal, theme_id, data.lock_version)
    except service.RequestError as e:
        raise _http(e) from e
    await db.commit()
    await db.refresh(theme)
    return (await service.themes_out(db, [theme]))[0]


@router.post("/request-themes/{theme_id}/problem/dismiss", response_model=RequestThemeOut)
async def dismiss_request_theme_problem(
    theme_id: uuid.UUID, data: ThemeProblemIn, db: TenantDB, principal: Approver
) -> RequestThemeOut:
    """Dismiss Oracle's suggested problem."""
    try:
        theme = await service.dismiss_problem(db, principal, theme_id, data.lock_version)
    except service.RequestError as e:
        raise _http(e) from e
    await db.commit()
    await db.refresh(theme)
    return (await service.themes_out(db, [theme]))[0]


@router.get("/request-themes", response_model=list[RequestThemeOut])
async def list_request_themes(
    db: TenantDB, _: Viewer, include_archived: bool = False
) -> list[RequestThemeOut]:
    return await service.list_themes(db, include_archived)


@router.post("/request-themes", response_model=RequestThemeOut, status_code=status.HTTP_201_CREATED)
async def create_request_theme(
    data: RequestThemeCreate, db: TenantDB, principal: Approver
) -> RequestThemeOut:
    try:
        theme = await service.create_theme(db, principal, data)
    except service.RequestError as e:
        raise _http(e) from e
    await db.commit()
    await db.refresh(theme)
    return (await service.themes_out(db, [theme]))[0]


@router.patch("/request-themes/{theme_id}", response_model=RequestThemeOut)
async def update_request_theme(
    theme_id: uuid.UUID, data: RequestThemePatch, db: TenantDB, principal: Approver
) -> RequestThemeOut:
    """Rename, describe, relink or archive a theme (archived: takes no new requests)."""
    try:
        theme = await service.patch_theme(db, principal, theme_id, data)
    except service.RequestError as e:
        raise _http(e) from e
    await db.commit()
    await db.refresh(theme)
    return (await service.themes_out(db, [theme]))[0]


@router.get("/request-candidates", response_model=list[CandidateOut])
async def list_request_candidates(
    db: TenantDB, principal: Commenter, status: Literal["open", "filed", "dismissed"] | None = None
) -> list[CandidateOut]:
    """The possible requests Oracle found in your own sources: yours alone (S6)."""
    try:
        rows = await triage.list_candidates(db, principal, status)
    except triage.TriageError as e:
        raise _http(e) from e
    return await triage.candidates_out(db, rows)


@router.post(
    "/request-candidates/{candidate_id}/file",
    response_model=RequestOut,
    status_code=status.HTTP_201_CREATED,
)
async def file_request_candidate(
    candidate_id: uuid.UUID, data: CandidateFile, db: TenantDB, principal: Commenter
) -> RequestOut:
    """File a found item as a request, in its words unless you change them. Filing shares
    the item: everyone who can see Requests reads your text, the item's title and link,
    and a 400-character excerpt."""
    try:
        row = await triage.file(db, principal, candidate_id, data)
    except triage.TriageError as e:
        raise _http(e) from e
    await db.commit()
    return await service.out_one(db, row)


@router.post("/request-candidates/{candidate_id}/dismiss", response_model=CandidateOut)
async def dismiss_request_candidate(
    candidate_id: uuid.UUID, db: TenantDB, principal: Commenter
) -> CandidateOut:
    """Dismiss a found item: Oracle does not offer it again."""
    try:
        row = await triage.dismiss(db, principal, candidate_id)
    except triage.TriageError as e:
        raise _http(e) from e
    await db.commit()
    await db.refresh(row)
    return (await triage.candidates_out(db, [row]))[0]
