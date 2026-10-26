"""Routes of a roadmap's Public version (spec-O5 §2, API): public texts, the page's own
title and intro, Draft public texts (the ``public_text`` job), the preview and the public
check (oracle.roadmap.public).

Every route is an approver's (O5-Q1: public texts are approved by approvers) and refuses
a run's token: agents get no tool that reads or writes public texts (spec-O5 "MCP and
agents"); words for people outside are a person's (H11 ``external_messages``).
"""

import uuid
from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select

from oracle import audit
from oracle.auth.deps import CurrentPrincipal, Principal, TenantDB
from oracle.authz import has_role
from oracle.docs import service as docs_service
from oracle.docs.models import Document, DocumentVersion
from oracle.jobs import service as jobs_service
from oracle.jobs.schemas import LlmJobOut
from oracle.review.models import DocumentPublication
from oracle.roadmap import leak_check, public, views
from oracle.roadmap.models import RoadmapItem, RoadmapPublicCheck, RoadmapPublicText

router = APIRouter(prefix="/v1", tags=["roadmaps"])

RUN_REFUSED = "Public texts are written and approved by people, not a run's agents"


async def public_approver(principal: CurrentPrincipal) -> Principal:
    if principal.is_run or principal.run_token_id is not None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, RUN_REFUSED)
    if not has_role(principal.role, "approver"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Requires the approver role")
    return principal


# Read by oracle.capabilities (#370).
public_approver.min_role = "approver"  # type: ignore[attr-defined]
Approver = Annotated[Principal, Depends(public_approver)]

Stage = Literal["exploring", "planned", "in_progress", "shipped"]


class LeakFindingOut(BaseModel):
    code: str
    severity: Literal["blocking", "warning"]
    words: list[str]


class PublicTextIn(BaseModel):
    title: str = Field(min_length=1, max_length=public.TITLE_MAX)
    description: str = Field(default="", max_length=public.DESCRIPTION_MAX)
    stage: Stage
    # Only a person sets it ("Has this quarter been said in public?").
    announced_quarter: str | None = Field(default=None, pattern=r"^[0-9]{4}-Q[1-4]$")
    changelog_url: str | None = Field(default=None, max_length=500)
    state: Literal["draft", "approved", "excluded"] = "draft"
    # The warnings the approver ticked "I checked this" for.
    checked_warnings: list[str] = Field(default_factory=list, max_length=10)

    @field_validator("changelog_url")
    @classmethod
    def _https(cls, v: str | None) -> str | None:
        if v is None or v.strip() == "":
            return None
        v = v.strip()
        if not v.startswith("https://") or any(c.isspace() for c in v):
            raise ValueError("a changelog link must be an https address")
        return v


class PublicTextOut(BaseModel):
    item_key: str
    title: str
    description: str
    stage: Stage
    announced_quarter: str | None = None
    changelog_url: str | None = None
    state: Literal["draft", "approved", "excluded"]
    drafted_by: str
    approved_by: uuid.UUID | None = None
    approved_at: datetime | None = None
    checked_warnings: list[str] = []
    updated_at: datetime | None = None
    findings: list[LeakFindingOut] = []


class PublicRowOut(BaseModel):
    item_key: str
    internal_title: str
    horizon: str
    state: Literal["approved", "draft", "excluded", "missing", "changed"]
    text: PublicTextOut | None = None
    findings: list[LeakFindingOut] = []
    shown: bool
    left_out_reason: Literal["no_approved_text", "excluded", "no_goal"] | None = None


class PublicCheckOut(BaseModel):
    id: uuid.UUID
    publication_id: uuid.UUID
    version_number: int
    checked_by: uuid.UUID
    checked_at: datetime
    shown_item_keys: list[str]
    content_hash: str
    state: Literal["checked", "lapsed"]


class PublicCheckState(BaseModel):
    state: Literal["none", "checked", "lapsed"]
    check: PublicCheckOut | None = None


class PublicTextsOut(BaseModel):
    document: str
    version: int
    public_title: str | None = None
    public_intro: str | None = None
    page_findings: list[LeakFindingOut] = []
    rows: list[PublicRowOut]
    shown: int
    left_out: dict[str, int]
    # "What is removed": each removed category with its count for this version.
    removed: dict[str, int]
    content_hash: str
    check: PublicCheckState
    # What stops Mark as checked; empty when ready.
    not_ready: list[dict[str, Any]]


class PublicPageIn(BaseModel):
    public_title: str | None = Field(default=None, min_length=1, max_length=120)
    public_intro: str | None = Field(default=None, max_length=600)


class PublicPageOut(BaseModel):
    public_title: str | None = None
    public_intro: str | None = None
    findings: list[LeakFindingOut] = []


def _refuse_format_characters(*texts: str | None) -> None:
    """422 ``format_characters`` when a public text holds an invisible character (a
    zero-width space, soft hyphen, combining grapheme joiner, variation selector or Hangul
    filler; an ordinary emoji sequence's joiners are fine): it could hide a name from the
    leak check and from the person approving it."""
    found = list(dict.fromkeys(c for t in texts for c in leak_check.format_characters(t or "")))
    if found:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            {
                "code": "format_characters",
                "message": "Remove the invisible characters from this text: " + ", ".join(found),
                "characters": found,
            },
        )


def _findings(found: list[leak_check.Finding]) -> list[LeakFindingOut]:
    return [LeakFindingOut(code=f.code, severity=f.severity, words=f.words) for f in found]  # type: ignore[arg-type]


def _text_out(t: RoadmapPublicText, found: list[leak_check.Finding]) -> PublicTextOut:
    return PublicTextOut(
        item_key=t.item_key,
        title=t.title,
        description=t.description,
        stage=t.stage,  # type: ignore[arg-type]
        announced_quarter=t.announced_quarter,
        changelog_url=t.changelog_url,
        state=t.state,  # type: ignore[arg-type]
        drafted_by=t.drafted_by,
        approved_by=t.approved_by,
        approved_at=t.approved_at,
        checked_warnings=list(t.checked_warnings or []),
        updated_at=t.updated_at,
        findings=_findings(found),
    )


async def _roadmap(db, doc: str) -> Document:
    try:
        document = await docs_service.get_document_or_404(db, doc)
    except docs_service.NotFoundError as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(e)) from e
    if document.kind != "roadmap":
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f"'{document.slug}' is a {document.kind}; a public version is for roadmaps only",
        )
    return document


async def _version(db, document: Document, n: int | None) -> DocumentVersion:
    version = await views.items_version(db, document, n)
    if version is None:
        detail = f"version {n} of '{document.slug}' not found" if n else "no version yet"
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail)
    return version


def _check_out(check: RoadmapPublicCheck, number: int, current: str) -> PublicCheckOut:
    return PublicCheckOut(
        id=check.id,
        publication_id=check.publication_id,
        version_number=number,
        checked_by=check.checked_by,
        checked_at=check.checked_at,
        shown_item_keys=list(check.shown_item_keys),
        content_hash=check.content_hash,
        state=public.check_state(check, current),  # type: ignore[arg-type]
    )


def _actor(principal: Principal) -> uuid.UUID:
    return principal.user_id or principal.id


@router.get("/roadmaps/{doc}/public-texts", response_model=PublicTextsOut)
async def list_public_texts(
    doc: str,
    principal: Approver,
    db: TenantDB,
    version: Annotated[int | None, Query(ge=1)] = None,
) -> PublicTextsOut:
    """The Public check's review list: one row per item of the version with its public
    text, state (Approved, Draft, Excluded, Missing, Internal item changed) and leak
    findings, the shown and left-out counts, what is removed, and the check's state."""
    document = await _roadmap(db, doc)
    v = await _version(db, document, version)
    r = await public.review(db, document, v)
    current = public.content_hash(r.page)
    check = await public.latest_check(db, v)
    return PublicTextsOut(
        document=document.slug,
        version=v.number,
        public_title=document.public_title,
        public_intro=document.public_intro,
        page_findings=_findings(r.page_findings),
        rows=[
            PublicRowOut(
                item_key=row.item_key,
                internal_title=row.internal_title,
                horizon=row.horizon,
                state=row.state,  # type: ignore[arg-type]
                text=_text_out(row.text, row.findings) if row.text is not None else None,
                findings=_findings(row.findings),
                shown=row.shown,
                left_out_reason=row.left_out_reason,  # type: ignore[arg-type]
            )
            for row in r.rows
        ],
        shown=len(r.shown_keys),
        left_out=r.left_out(),
        removed=r.removed,
        content_hash=current,
        check=PublicCheckState(
            state=public.check_state(check, current),  # type: ignore[arg-type]
            check=_check_out(check, v.number, current) if check is not None else None,
        ),
        not_ready=r.not_ready(),
    )


@router.put("/roadmaps/{doc}/public-texts/{item_key}", response_model=PublicTextOut)
async def put_public_text(
    doc: str,
    item_key: str,
    body: PublicTextIn,
    principal: Approver,
    db: TenantDB,
    version: Annotated[int | None, Query(ge=1)] = None,
) -> PublicTextOut:
    """Edit, approve or exclude one item's public text. Approving is refused (422
    ``leak_blocking``) while the text has a blocking leak finding, and (422
    ``warnings_unchecked``) until every warning is ticked in ``checked_warnings``. A text
    holding an invisible format character is refused in any state (422
    ``format_characters``)."""
    document = await _roadmap(db, doc)
    v = await _version(db, document, version)
    item = await db.scalar(
        select(RoadmapItem).where(
            RoadmapItem.roadmap_version_id == v.id, RoadmapItem.item_key == item_key
        )
    )
    if item is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, f"item '{item_key}' is not in version {v.number}"
        )
    _refuse_format_characters(body.title, body.description, body.changelog_url)
    ctx = await leak_check.load_context(db)
    found = public.text_findings(
        ctx,
        title=body.title,
        description=body.description,
        changelog_url=body.changelog_url,
        announced_quarter=body.announced_quarter,
        internal_title=item.title,
    )
    if body.state == "approved":
        blocking = leak_check.blocking(found)
        if blocking:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                {
                    "code": "leak_blocking",
                    "message": "This text names something a public reader may not see: "
                    + "; ".join(f"{f.code} ({', '.join(f.words)})" for f in blocking),
                    "findings": [f.model_dump() for f in _findings(blocking)],
                },
            )
        unticked = sorted(set(leak_check.warnings(found)) - set(body.checked_warnings))
        if unticked:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                {
                    "code": "warnings_unchecked",
                    "message": 'Tick "I checked this" for each warning first',
                    "warnings": unticked,
                },
            )
    row = await db.scalar(
        select(RoadmapPublicText)
        .where(RoadmapPublicText.document_id == document.id, RoadmapPublicText.item_key == item_key)
        .with_for_update()
    )
    now = datetime.now(UTC)
    if row is None:
        row = RoadmapPublicText(
            id=uuid.uuid4(), document_id=document.id, item_key=item_key,
            drafted_by=str(_actor(principal)),
        )  # fmt: skip
        db.add(row)
    before = {"state": row.state, "title": row.title} if row.title else None
    row.title = body.title
    row.description = body.description
    row.stage = body.stage
    row.announced_quarter = body.announced_quarter
    row.changelog_url = body.changelog_url
    row.state = body.state
    row.checked_warnings = sorted(set(body.checked_warnings) & set(leak_check.WARNINGS))
    row.source_hash = public.source_hash(item.title, item.outcome)
    row.updated_at = now
    if body.state == "approved":
        row.approved_by, row.approved_at = _actor(principal), now
    else:
        row.approved_by, row.approved_at = None, None
    await db.flush()
    action = {"approved": "approved", "excluded": "excluded"}.get(body.state, "edited")
    await audit.record(
        db,
        principal,
        f"roadmap.public_text.{action}",
        "document",
        document.id,
        {"item_key": item_key, "version": v.number, "before": before,
         "findings": [f.code for f in found]},
    )  # fmt: skip
    await db.commit()
    await db.refresh(row)
    return _text_out(row, found)


@router.put("/roadmaps/{doc}/public-page", response_model=PublicPageOut)
async def put_public_page(
    doc: str, body: PublicPageIn, principal: Approver, db: TenantDB
) -> PublicPageOut:
    """The Public page's own title and intro (the internal title is never shown). A
    blocking leak finding is 422 ``leak_blocking``, an invisible format character 422
    ``format_characters``; a change lapses the public check. Both are re-checked at every
    render and left out of the page once they leak."""
    document = await _roadmap(db, doc)
    sent = body.model_fields_set
    title = body.public_title if "public_title" in sent else document.public_title
    intro = body.public_intro if "public_intro" in sent else document.public_intro
    _refuse_format_characters(title, intro)
    found = public.page_text_findings(await leak_check.load_context(db), title, intro)
    blocking = leak_check.blocking(found)
    if blocking:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            {
                "code": "leak_blocking",
                "message": "The public title or intro names something a public reader may not see",
                "findings": [f.model_dump() for f in _findings(blocking)],
            },
        )
    before = {"public_title": document.public_title, "public_intro": document.public_intro}
    document.public_title = title or None
    document.public_intro = intro or None
    await db.flush()
    await audit.record(
        db, principal, "roadmap.public_page.edited", "document", document.id,
        {"before": before, "after": {"public_title": title, "public_intro": intro}},
    )  # fmt: skip
    await db.commit()
    return PublicPageOut(public_title=title, public_intro=intro, findings=_findings(found))


@router.post(
    "/roadmaps/{doc}/public-texts/draft",
    response_model=LlmJobOut,
    status_code=status.HTTP_202_ACCEPTED,
    responses={409: {"description": "the job is turned off, or Oracle only observes"}},
)
async def draft_public_texts(
    doc: str,
    principal: Approver,
    db: TenantDB,
    version: Annotated[int | None, Query(ge=1)] = None,
) -> LlmJobOut:
    """Draft public texts (O5-Q7): one ``public_text`` job on Oracle's Claude account
    pool writes a draft for each item with none. It only ever drafts (H11
    ``external_messages``, ceiling Draft); a person approves each text."""
    from oracle import autonomy

    document = await _roadmap(db, doc)
    v = await _version(db, document, version)
    if not await autonomy.allows(db, "external_messages", "draft"):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Oracle is set to observe words for people outside (Settings, Autonomy); "
            "write the public texts yourself",
        )
    try:
        job = await jobs_service.enqueue(
            db, document, "public_text", version=v, principal=principal, coalesce=True
        )
    except jobs_service.JobError as e:
        raise HTTPException(e.status, str(e)) from None
    await db.commit()
    await db.refresh(job)
    return await jobs_service.job_out(db, job)


@router.get(
    "/roadmaps/{doc}/versions/{n}/public-preview",
    response_class=Response,
    responses={200: {"content": {"text/html": {}}}},
)
async def get_public_preview(doc: str, n: int, principal: Approver, db: TenantDB) -> Response:
    """Exactly the page a Public link holder sees, rendered by the same code
    (``render_public``) from the same rows; only the footer's dates are a link's."""
    document = await _roadmap(db, doc)
    v = await _version(db, document, n)
    r = await public.review(db, document, v)
    return Response(
        public.render_public(r.page),
        media_type="text/html; charset=utf-8",
        headers=public.PAGE_HEADERS,
    )


@router.post(
    "/roadmaps/{doc}/publications/{p}/public-check",
    response_model=PublicCheckOut,
    status_code=status.HTTP_201_CREATED,
    responses={409: {"description": "not_ready: what is left before the check"}},
)
async def post_public_check(doc: str, p: int, principal: Approver, db: TenantDB) -> PublicCheckOut:
    """Mark as checked: a person looked at the exact Public page of this publication.
    409 ``not_ready`` while any item that serves a goal and is not excluded lacks an
    approved, current text, or has a blocking finding."""
    document = await _roadmap(db, doc)
    publication = await db.scalar(
        select(DocumentPublication).where(
            DocumentPublication.document_id == document.id, DocumentPublication.number == p
        )
    )
    if publication is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"publication {p} of '{doc}' not found")
    v = await db.get(DocumentVersion, publication.version_id)
    r = await public.review(db, document, v)
    left = r.not_ready()
    if left:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            {
                "code": "not_ready",
                "message": "Approve or exclude every item's public text first",
                "left": left,
            },
        )
    current = public.content_hash(r.page)
    check = RoadmapPublicCheck(
        id=uuid.uuid4(),
        document_id=document.id,
        version_id=v.id,
        publication_id=publication.id,
        checked_by=_actor(principal),
        checked_at=datetime.now(UTC),
        shown_item_keys=r.shown_keys,
        content_hash=current,
    )
    db.add(check)
    await db.flush()
    await audit.record(
        db, principal, "roadmap.public_checked", "document", document.id,
        {"publication": p, "version": v.number, "shown": len(r.shown_keys),
         "content_hash": current},
    )  # fmt: skip
    number = v.number
    await db.commit()
    await db.refresh(check)
    return _check_out(check, number, current)
