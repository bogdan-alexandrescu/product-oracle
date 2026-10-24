"""Requests (C1): add, read, qualify, merge, disqualify, reopen, accept Oracle's
suggestions, and the themes that group them.

Rules (issue #150, behaviour rules 1-10): commenters add; approvers and owners decide.
Qualifying needs a confirmed goal (decision F3b). A merge points at the root of the
target's chain and never forms a cycle; mentions count every request merged in, through
chains. Oracle's triage writes ``suggestion`` only (oracle.requests.triage):
nothing changes until an approver accepts a part. A request filed from the filer's own
source item carries a copy of its title, link, kind and a 400-character excerpt
(decided 2026-10-21, C1 "Found items"), audited as shared in full.
"""

import uuid
from collections import defaultdict
from collections.abc import Iterable, Mapping
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import ColumnElement, func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, autonomy
from oracle.auth.deps import Principal
from oracle.auth.models import User
from oracle.authz import has_role, recheck_caller
from oracle.baseline.models import Entity
from oracle.decisions import capture
from oracle.docs.models import Document, DocumentVersion, Section
from oracle.members.names import display_name
from oracle.requests import replies
from oracle.requests.models import EXCERPT_MAX, ProductRequest, RequestReply, RequestTheme
from oracle.requests.schemas import (
    AcceptSuggestionIn,
    BasisOut,
    DeclineSuggestionIn,
    DisqualifyIn,
    MergeIn,
    QualifyIn,
    ReopenIn,
    ReplyCounts,
    RequestCreate,
    RequestDetail,
    RequestDocumentProgress,
    RequestDocumentRef,
    RequestList,
    RequestOut,
    RequestPatch,
    RequestThemeCreate,
    RequestThemeOut,
    RequestThemePatch,
    RequestThemeRef,
    SourceCopy,
    StateCounts,
    SuggestedProblem,
    Suggestion,
)
from oracle.sources.models import Source, SourceItem, SourceItemVersion
from oracle.v2.concurrency import expect_version, flush_or_conflict

NEEDS_GOAL = "Link a confirmed goal first, or disqualify it as 'No goal'"
INTERVIEW_ONLY = "Interview requests come from interviews"
NOT_YOUR_ITEM = "source_item_id is not one of your own source items"
OWNER_NAMES_REQUESTER = "Only an owner files a request in someone else's name"


class RequestError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


def _not_found(what: str = "Request") -> RequestError:
    return RequestError(404, f"{what} not found")


def _invalid(message: str) -> RequestError:
    return RequestError(422, message)


def _conflict(message: str) -> RequestError:
    return RequestError(409, message)


def _forbidden(message: str) -> RequestError:
    return RequestError(403, message)


def _now() -> datetime:
    return datetime.now(UTC)


# --- merge chains (pure) ---------------------------------------------------------------


class MergeCycle(Exception):
    """A chain of merges loops (never stored: merges are refused before)."""


def root_of(rid: Any, parent: Mapping[Any, Any]) -> Any:
    """The request at the end of ``rid``'s chain of merges (``parent``: id -> the id it
    is merged into, or None/absent for a root)."""
    seen = {rid}
    while (up := parent.get(rid)) is not None:
        if up in seen:
            raise MergeCycle(f"merge chain of {rid} loops")
        seen.add(up)
        rid = up
    return rid


def _children(parent: Mapping[Any, Any]) -> dict[Any, list[Any]]:
    out: dict[Any, list[Any]] = defaultdict(list)
    for child, up in parent.items():
        if up is not None:
            out[up].append(child)
    return out


def descendants(rid: Any, children: Mapping[Any, list[Any]]) -> list[Any]:
    """Every request merged into ``rid``, directly or through a chain."""
    out, stack, seen = [], list(children.get(rid, ())), {rid}
    while stack:
        node = stack.pop()
        if node in seen:
            continue
        seen.add(node)
        out.append(node)
        stack.extend(children.get(node, ()))
    return out


def mention_counts(parent: Mapping[Any, Any]) -> dict[Any, int]:
    """Mentions per request: 1 plus every request merged into it, through chains."""
    children = _children(parent)
    return {rid: 1 + len(descendants(rid, children)) for rid in parent}


async def _merge_parents(db: AsyncSession) -> dict[uuid.UUID, uuid.UUID]:
    """Every merged request of the company and what it is merged into."""
    rows = await db.execute(
        select(ProductRequest.id, ProductRequest.merged_into_id).where(
            ProductRequest.merged_into_id.is_not(None)
        )
    )
    return {rid: up for rid, up in rows.all()}


# --- lookups -----------------------------------------------------------------------------


def _unique(ids: Iterable[uuid.UUID]) -> list[uuid.UUID]:
    return list(dict.fromkeys(ids))


async def confirmed_goals(db: AsyncSession, ids: Iterable[uuid.UUID]) -> set[uuid.UUID]:
    ids = _unique(ids)
    if not ids:
        return set()
    rows = await db.scalars(
        select(Entity.id).where(
            Entity.id.in_(ids), Entity.type == "goal", Entity.status == "confirmed"
        )
    )
    return set(rows)


async def _goal_ids(db: AsyncSession, ids: Iterable[uuid.UUID]) -> list[uuid.UUID]:
    """``ids`` when each is a confirmed goal, else 422."""
    ids = _unique(ids)
    known = await confirmed_goals(db, ids)
    unknown = [str(i) for i in ids if i not in known]
    if unknown:
        raise _invalid(f"Unknown goal: {', '.join(unknown)} is not a confirmed goal")
    return ids


async def _live_theme(db: AsyncSession, theme_id: uuid.UUID) -> RequestTheme:
    theme = await db.get(RequestTheme, theme_id)
    if theme is None or theme.archived_at is not None:
        raise _invalid(f"Unknown theme: {theme_id}")
    return theme


async def _feature(db: AsyncSession, feature_id: uuid.UUID) -> uuid.UUID:
    entity = await db.get(Entity, feature_id)
    if entity is None or entity.type != "feature" or entity.status == "rejected":
        raise _invalid(f"Unknown feature: {feature_id}")
    return feature_id


async def _document(db: AsyncSession, document_id: uuid.UUID) -> uuid.UUID:
    if await db.get(Document, document_id) is None:
        raise _invalid(f"Unknown document: {document_id}")
    return document_id


async def _locked(db: AsyncSession, request_id: uuid.UUID) -> ProductRequest:
    row = await db.scalar(
        select(ProductRequest)
        .where(ProductRequest.id == request_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if row is None:
        raise _not_found()
    return row


def excerpt_of(content: str | None) -> str | None:
    """At most :data:`EXCERPT_MAX` characters of an item's text, whitespace collapsed."""
    flat = " ".join((content or "").split())
    if not flat:
        return None
    if len(flat) <= EXCERPT_MAX:
        return flat
    return flat[: EXCERPT_MAX - 1].rstrip() + "…"


async def item_copy(
    db: AsyncSession, owner_user_id: uuid.UUID, item_id: uuid.UUID
) -> dict[str, Any] | None:
    """What filing copies from one of ``owner_user_id``'s own live source items: its
    title, link, source kind and excerpt (C1 "Found items"); None for anyone else's."""
    found = (
        await db.execute(
            select(SourceItem, Source.kind)
            .join(Source, Source.id == SourceItem.source_id)
            .where(
                SourceItem.id == item_id,
                SourceItem.deleted_at.is_(None),
                Source.owner_user_id == owner_user_id,
            )
        )
    ).first()
    if found is None:
        return None
    item, kind = found
    version = (
        await db.get(SourceItemVersion, item.current_version_id)
        if item.current_version_id
        else None
    )
    return {
        "source_item_id": item.id,
        "source_title": item.title or (version.title if version else None),
        "source_url": item.url or (version.url if version else None),
        "source_kind": kind,
        "source_excerpt": excerpt_of(version.content if version else None),
    }


async def copy_source(db: AsyncSession, principal: Principal, item_id: uuid.UUID) -> dict[str, Any]:
    """:func:`item_copy` of one of the principal's own source items; 422 for anyone
    else's."""
    copied = await item_copy(db, principal.user_id, item_id) if principal.user_id else None
    if copied is None:
        raise _invalid(NOT_YOUR_ITEM)
    return copied


# --- reading -----------------------------------------------------------------------------


def _suggestion(raw: dict[str, Any]) -> Suggestion | None:
    if not raw:
        return None
    try:
        return Suggestion.model_validate(raw)
    except ValueError:
        return None


def _without_decline(s: Suggestion | None, show: bool) -> Suggestion | None:
    if s is None or show or s.decline is None:
        return s
    return s.model_copy(update={"decline": None})


async def to_out(db: AsyncSession, rows: list[ProductRequest]) -> list[RequestOut]:
    """The rows as the API shows them, with themes, PRDs, sources and mentions."""
    if not rows:
        return []
    theme_ids = {r.theme_id for r in rows if r.theme_id}
    doc_ids = {r.document_id for r in rows if r.document_id}
    item_ids = {r.source_item_id for r in rows if r.source_item_id}
    themes = {}
    if theme_ids:
        found = await db.scalars(select(RequestTheme).where(RequestTheme.id.in_(theme_ids)))
        themes = {t.id: t for t in found}
    docs = (
        {d.id: d for d in await db.scalars(select(Document).where(Document.id.in_(doc_ids)))}
        if doc_ids
        else {}
    )
    gone = (
        set(
            await db.scalars(
                select(SourceItem.id).where(
                    SourceItem.id.in_(item_ids), SourceItem.deleted_at.is_not(None)
                )
            )
        )
        if item_ids
        else set()
    )
    children = _children(await _merge_parents(db))
    declined = [r.id for r in rows if r.state == "disqualified"]
    decisions = await replies.decisions_for(db, declined)
    counts = await replies.reply_counts(db, [r.id for r in rows])
    merged_at = await _merged_at(db, [d for r in declined for d in descendants(r, children)])
    basis_titles = await _basis_titles(db, rows)
    # H11 requests: Oracle's decline suggestions show at Recommend and above.
    show_decline = await autonomy.allows(db, "requests", "recommend")
    out = []
    for r in rows:
        theme = themes.get(r.theme_id) if r.theme_id else None
        d = decisions.get(r.id)
        total, open_ = counts.get(r.id, (0, 0))
        basis = None
        if r.basis and r.basis.get("kind"):
            bid = r.basis.get("id")
            basis = BasisOut(
                kind=r.basis["kind"],
                id=bid,
                title=basis_titles.get(uuid.UUID(bid)) if bid else None,
            )
        since = r.asked_again_since
        asked_again = (
            sum(
                1
                for m in descendants(r.id, children)
                if (at := merged_at.get(m)) is not None and at > since
            )
            if r.state == "disqualified" and since is not None
            else 0
        )
        doc = docs.get(r.document_id) if r.document_id else None
        source = None
        if r.source_item_id or r.source_kind or r.source_title:
            source = SourceCopy(
                item_id=r.source_item_id,
                title=r.source_title,
                url=r.source_url,
                kind=r.source_kind,
                removed=r.source_item_id is None or r.source_item_id in gone,
                excerpt=r.source_excerpt,
            )
        out.append(
            RequestOut(
                id=r.id,
                title=r.title,
                body=r.body,
                channel=r.channel,
                origin=r.origin,
                requester_name=r.requester_name,
                requester_kind=r.requester_kind,
                verified=r.verified,
                state=r.state,
                merged_into_id=r.merged_into_id,
                disqualify_reason=r.disqualify_reason,
                decision_note=r.decision_note,
                theme=RequestThemeRef(id=theme.id, title=theme.title) if theme else None,
                goal_ids=list(r.goal_ids),
                feature_id=r.feature_id,
                document=RequestDocumentRef(id=doc.id, slug=doc.slug, title=doc.title)
                if doc
                else None,
                intake_id=r.intake_id,
                interview_id=r.interview_id,
                source=source,
                mentions=1 + len(descendants(r.id, children)),
                suggestion=_without_decline(_suggestion(r.suggestion), show_decline),
                filed_by=r.filed_by,
                decided_by=r.decided_by,
                decided_at=r.decided_at,
                decision_number=d.number if d else None,
                decision_title=d.title if d else None,
                decision_status=d.status if d else None,
                basis=basis,
                asked_again=asked_again,
                replies=ReplyCounts(total=total, open=open_),
                loop_closed_on=r.loop_closed_on,
                no_reply_reason=replies.no_reply_reason(r),  # type: ignore[arg-type]
                created_at=r.created_at,
                updated_at=r.updated_at,
                lock_version=r.lock_version,
            )
        )
    return out


async def _merged_at(db: AsyncSession, ids: list[uuid.UUID]) -> dict[uuid.UUID, datetime]:
    """When each merged request was merged (its ``decided_at``)."""
    if not ids:
        return {}
    rows = await db.execute(
        select(ProductRequest.id, ProductRequest.decided_at).where(ProductRequest.id.in_(ids))
    )
    return {rid: at for rid, at in rows.all() if at is not None}


async def _basis_titles(db: AsyncSession, rows: list[ProductRequest]) -> dict[uuid.UUID, str]:
    ids = {uuid.UUID(r.basis["id"]) for r in rows if r.basis and r.basis.get("id")}
    if not ids:
        return {}
    found = await db.execute(select(Entity.id, Entity.title).where(Entity.id.in_(ids)))
    return {eid: title for eid, title in found.all()}


async def out_one(db: AsyncSession, row: ProductRequest) -> RequestOut:
    await db.refresh(row)
    return (await to_out(db, [row]))[0]


async def _progress(db: AsyncSession, document_id: uuid.UUID) -> RequestDocumentProgress | None:
    from oracle.review.state import approved_keys

    doc = await db.get(Document, document_id)
    if doc is None:
        return None
    version = await db.scalar(
        select(DocumentVersion)
        .where(DocumentVersion.document_id == doc.id)
        .order_by(DocumentVersion.number.desc())
        .limit(1)
    )
    sections = reviewed = 0
    if version is not None:
        sections = await db.scalar(
            select(func.count()).select_from(Section).where(Section.version_id == version.id)
        )
        reviewed = len(await approved_keys(db, doc.id, version))
    return RequestDocumentProgress(
        id=doc.id,
        slug=doc.slug,
        title=doc.title,
        latest_version=version.number if version else None,
        reviewed_sections=reviewed,
        sections=sections or 0,
    )


async def detail(db: AsyncSession, request_id: uuid.UUID) -> RequestDetail:
    row = await db.get(ProductRequest, request_id)
    if row is None:
        raise _not_found()
    [out] = await to_out(db, [row])
    merged_ids = descendants(row.id, _children(await _merge_parents(db)))
    merged = (
        list(
            await db.scalars(
                select(ProductRequest)
                .where(ProductRequest.id.in_(merged_ids))
                .order_by(ProductRequest.created_at, ProductRequest.id)
            )
        )
        if merged_ids
        else []
    )
    data = out.model_dump(exclude={"document"})
    return RequestDetail(
        **data,
        merged=await to_out(db, merged),
        document=await _progress(db, row.document_id) if row.document_id else None,
        suggested_basis={
            k: BasisOut(**v) for k, v in (await replies.suggested_basis(db, row)).items()
        },
        drafting=await replies.running_job(db, row.id) is not None,
    )


def _like(q: str) -> str:
    escaped = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


async def list_requests(
    db: AsyncSession,
    *,
    state: str | None = None,
    theme_id: uuid.UUID | None = None,
    no_theme: bool = False,
    goal_id: uuid.UUID | None = None,
    channel: str | None = None,
    q: str | None = None,
    replies_to_send: bool = False,
    limit: int = 50,
    offset: int = 0,
) -> RequestList:
    filters: dict[str, ColumnElement[bool]] = {}
    if replies_to_send:
        # H10: declined requests with replies still Drafted.
        filters["replies"] = (ProductRequest.state == "disqualified") & ProductRequest.id.in_(
            select(RequestReply.root_request_id).where(RequestReply.status == "drafted")
        )
    if state:
        filters["state"] = ProductRequest.state == state
    if no_theme:
        filters["theme"] = ProductRequest.theme_id.is_(None)
    elif theme_id:
        filters["theme"] = ProductRequest.theme_id == theme_id
    if goal_id:
        filters["goal"] = ProductRequest.goal_ids.contains([goal_id])
    if channel:
        filters["channel"] = ProductRequest.channel == channel
    if q and q.strip():
        pattern = _like(q.strip())
        filters["q"] = ProductRequest.title.ilike(pattern, escape="\\") | ProductRequest.body.ilike(
            pattern, escape="\\"
        )

    def where(*but: str) -> list[ColumnElement[bool]]:
        return [c for k, c in filters.items() if k not in but]

    rows = list(
        await db.scalars(
            select(ProductRequest)
            .where(*where())
            .order_by(ProductRequest.created_at.desc(), ProductRequest.id)
            .limit(limit)
            .offset(offset)
        )
    )
    total = await db.scalar(select(func.count(ProductRequest.id)).where(*where()))
    per_state = dict(
        (
            await db.execute(
                select(ProductRequest.state, func.count(ProductRequest.id))
                .where(*where("state"))
                .group_by(ProductRequest.state)
            )
        ).all()
    )
    per_channel = dict(
        (
            await db.execute(
                select(ProductRequest.channel, func.count(ProductRequest.id))
                .where(*where("channel"))
                .group_by(ProductRequest.channel)
            )
        ).all()
    )
    week = await db.scalar(
        select(func.count(ProductRequest.id)).where(
            ProductRequest.created_at >= _now() - timedelta(days=7)
        )
    )
    counts = StateCounts(
        all=sum(per_state.values()),
        new=per_state.get("new", 0),
        qualified=per_state.get("qualified", 0),
        merged=per_state.get("merged", 0),
        disqualified=per_state.get("disqualified", 0),
    )
    return RequestList(
        items=await to_out(db, rows),
        total=total or 0,
        counts=counts,
        by_channel={k: v for k, v in sorted(per_channel.items(), key=lambda kv: (-kv[1], kv[0]))},
        new_this_week=week or 0,
    )


# --- writing -----------------------------------------------------------------------------


async def create(db: AsyncSession, principal: Principal, body: RequestCreate) -> ProductRequest:
    if body.channel == "interview":
        raise _invalid(INTERVIEW_ONLY)
    goal_ids = await _goal_ids(db, body.goal_ids)
    if body.theme_id:
        await _live_theme(db, body.theme_id)
    requester_name, requester_kind = body.requester_name or None, body.requester_kind
    if body.channel == "in_app":
        requester_name, requester_kind = await _in_app_requester(db, principal, body)
    copied = await copy_source(db, principal, body.source_item_id) if body.source_item_id else {}
    row = ProductRequest(
        title=body.title,
        body=body.body or None,
        channel=body.channel,
        origin="person",
        requester_name=requester_name,
        requester_kind=requester_kind,
        verified=True,
        goal_ids=goal_ids,
        theme_id=body.theme_id,
        filed_by=principal.id,
        **copied,
    )
    db.add(row)
    await db.flush()
    data: dict[str, Any] = {"channel": row.channel}
    if copied:
        data |= {"shared": "full", "source_item_id": str(row.source_item_id)}
    await audit.record(db, principal, "request.created", "product_request", row.id, data)
    return row


async def _in_app_requester(
    db: AsyncSession, principal: Principal, body: RequestCreate
) -> tuple[str | None, str]:
    """New request in the app (#329): the requester is the signed-in member, by name, as
    team; an owner may name someone else (403 for anyone else)."""
    named = body.requester_name or None
    email = await db.scalar(select(User.email).where(User.id == principal.user_id))
    me = display_name(email) if email else None
    if named and named != me:
        if not has_role(principal.role, "owner"):
            raise _forbidden(OWNER_NAMES_REQUESTER)
        return named, body.requester_kind
    return me, "team"


TEXT_FIELDS = {"title", "body"}
LINK_FIELDS = {"goal_ids", "theme_id", "feature_id", "document_id"}


async def patch(
    db: AsyncSession, principal: Principal, request_id: uuid.UUID, body: RequestPatch
) -> ProductRequest:
    row = await _locked(db, request_id)
    expect_version(row, body.lock_version)
    fields = body.model_fields_set - {"lock_version"}
    with db.no_autoflush:
        await _apply_patch(db, principal, row, body, fields)
    if not fields:
        return row
    await flush_or_conflict(db)
    await audit.record(
        db, principal, "request.updated", "product_request", row.id, {"fields": sorted(fields)}
    )
    return row


async def _apply_patch(
    db: AsyncSession, principal: Principal, row: ProductRequest, body: RequestPatch,
    fields: set[str],
) -> None:  # fmt: skip
    if fields & TEXT_FIELDS:
        if row.origin == "interview":
            raise _forbidden("A request from an interview keeps the customer's words")
        if row.filed_by != principal.id:
            raise _forbidden("Only the person who filed a request edits its words")
        if row.state != "new":
            raise _conflict("A request's words change only while it is New")
        if "title" in fields:
            if body.title is None:
                raise _invalid("A request needs a title")
            row.title = body.title
        if "body" in fields:
            row.body = body.body or None
    if fields & LINK_FIELDS:
        if not has_role(principal.role, "approver"):
            raise _forbidden("Requires the approver role")
        await recheck_caller(db, principal, "approver")
        if "goal_ids" in fields:
            row.goal_ids = await _goal_ids(db, body.goal_ids or [])
        if "theme_id" in fields:
            row.theme_id = (await _live_theme(db, body.theme_id)).id if body.theme_id else None
        if "feature_id" in fields:
            row.feature_id = await _feature(db, body.feature_id) if body.feature_id else None
        if "document_id" in fields:
            row.document_id = await _document(db, body.document_id) if body.document_id else None


def _decided(row: ProductRequest, principal: Principal) -> None:
    row.decided_by = principal.id
    row.decided_at = _now()


async def qualify(
    db: AsyncSession, principal: Principal, request_id: uuid.UUID, body: QualifyIn
) -> ProductRequest:
    row = await _locked(db, request_id)
    expect_version(row, body.lock_version)
    if row.state != "new":
        raise _conflict("Only a New request can be qualified")
    goal_ids = await _goal_ids(db, body.goal_ids) if body.goal_ids is not None else row.goal_ids
    if not await confirmed_goals(db, goal_ids):
        raise _invalid(NEEDS_GOAL)
    row.goal_ids = list(goal_ids)
    row.state = "qualified"
    row.decision_note = body.note or None
    _decided(row, principal)
    await flush_or_conflict(db)
    await audit.record(
        db, principal, "request.qualified", "product_request", row.id,
        {"goal_ids": [str(g) for g in row.goal_ids]},
    )  # fmt: skip
    return row


async def _merge_into(
    db: AsyncSession, principal: Principal, row: ProductRequest, into_id: uuid.UUID
) -> uuid.UUID:
    """Merges ``row`` into the root of ``into_id``'s chain; returns that root."""
    if row.state not in ("new", "qualified"):
        raise _conflict("Only a New or Qualified request can be merged")
    # One merge at a time per company: two crossing merges cannot form a loop.
    await db.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:k, 0))"),
        {"k": f"product_requests.merge:{row.tenant_id}"},
    )
    target = await db.get(ProductRequest, into_id)
    if target is None:
        raise _not_found("Request to merge into")
    try:
        root = root_of(target.id, await _merge_parents(db))
    except MergeCycle as e:
        raise _conflict("That merge would form a cycle") from e
    if root == row.id:
        raise _conflict("That merge would form a cycle")
    row.state = "merged"
    row.merged_into_id = root
    _decided(row, principal)
    return root


async def merge(
    db: AsyncSession, principal: Principal, request_id: uuid.UUID, body: MergeIn
) -> ProductRequest:
    row = await _locked(db, request_id)
    expect_version(row, body.lock_version)
    with db.no_autoflush:
        root = await _merge_into(db, principal, row, body.into_id)
    await flush_or_conflict(db)
    data = {"into_id": str(root), "asked_into_id": str(body.into_id)}
    data |= await _asked_again(db, principal, row, root)
    await audit.record(db, principal, "request.merged", "product_request", row.id, data)
    return row


async def _asked_again(
    db: AsyncSession, principal: Principal, row: ProductRequest, root_id: uuid.UUID
) -> dict[str, Any]:
    """H10 Asked again: a request merged into one said no to gets the same reasoned reply,
    under the same decision. The root stays disqualified; its ``asked_again`` counts it."""
    root = await db.get(ProductRequest, root_id)
    if root is None or root.state != "disqualified":
        return {}
    decision = await replies.live_decision(db, root.id)
    if decision is None or decision.status != "decided":
        return {"asked_again": True}
    made = await _replies_for(db, root, [row], decision, principal)
    return {"asked_again": True, "replies": len(made)}


async def disqualify(
    db: AsyncSession, principal: Principal, request_id: uuid.UUID, body: DisqualifyIn
) -> ProductRequest:
    row = await _locked(db, request_id)
    expect_version(row, body.lock_version)
    if row.state not in ("new", "qualified"):
        raise _conflict("Only a New or Qualified request can be disqualified")
    if body.reason == "other" and not body.note:
        raise _invalid("Say why in a note when the reason is Other")
    try:
        basis, entity = await replies.check_basis(
            db, body.reason, body.basis.model_dump(mode="json") if body.basis else None
        )
    except replies.ReplyError as e:
        raise RequestError(e.status, str(e)) from e
    row.state = "disqualified"
    row.disqualify_reason = body.reason
    row.decision_note = body.note or None
    row.basis = basis
    row.loop_closed_on = None
    _decided(row, principal)
    row.asked_again_since = row.decided_at
    await flush_or_conflict(db)
    data: dict[str, Any] = {"reason": body.reason}
    if replies.is_no(body.reason, body.note):
        # H10: a no is a logged decision and a reply to everyone who asked.
        decision = await capture.request_declined(
            db, principal, row, reason_label=replies.LABELS[body.reason], basis_entity=entity
        )
        made = await _replies_for(db, row, [row], decision, principal)
        data |= {"decision_id": str(decision.id), "replies": len(made)}
    await audit.record(db, principal, "request.disqualified", "product_request", row.id, data)
    return row


async def _replies_for(
    db: AsyncSession,
    root: ProductRequest,
    askers: list[ProductRequest],
    decision: Any,
    principal: Principal | None = None,
) -> list[RequestReply]:
    """Replies (kind no) for ``askers`` and every request merged into them, and the job
    that drafts them (at H11 external_messages Draft; none at Observe)."""
    children = _children(await _merge_parents(db))
    ids = _unique([a.id for a in askers] + [d for a in askers for d in descendants(a.id, children)])
    rows = list(
        await db.scalars(
            select(ProductRequest)
            .where(ProductRequest.id.in_(ids))
            .order_by(ProductRequest.created_at, ProductRequest.id)
        )
    )
    made = await replies.create_replies(db, root, rows, kind="no", decision=decision)
    if made and await replies.running_job(db, root.id) is None:
        await replies.queue_job(db, principal, root, made)
    elif made:
        # A job under way: these are drafted by the next Draft again, or get templates now.
        await replies.fill_templates(db, root, made)
    return made


async def reopen(
    db: AsyncSession, principal: Principal, request_id: uuid.UUID, body: ReopenIn
) -> ProductRequest:
    row = await _locked(db, request_id)
    expect_version(row, body.lock_version)
    if row.state not in ("merged", "disqualified"):
        raise _conflict("Only a Merged or Disqualified request can be reopened")
    was = row.state
    decision = None
    if was == "disqualified":
        # H10: the logged no is reversed, by the reopener's review.
        decision = await capture.request_reopened(db, principal, row, body.reason)
    await _reopen(db, row)
    await flush_or_conflict(db)
    data: dict[str, Any] = {"from": was}
    if decision is not None:
        data["decision_id"] = str(decision.id)
    await audit.record(db, principal, "request.reopened", "product_request", row.id, data)
    return row


async def _reopen(db: AsyncSession, row: ProductRequest) -> None:
    row.state = "new"
    row.merged_into_id = None
    row.disqualify_reason = None
    row.decision_note = None
    row.decided_by = None
    row.decided_at = None
    row.asked_again_since = None
    row.loop_closed_on = None
    # Drafted replies go: nobody is told a no that no longer stands.
    for reply in await db.scalars(
        select(RequestReply).where(
            RequestReply.root_request_id == row.id, RequestReply.status == "drafted"
        )
    ):
        reply.status = "withdrawn"


async def reopen_from_decision(
    db: AsyncSession, principal: Principal, decision: Any, note: str
) -> None:
    """A ``reversed`` review on a ``request_decline`` decision reopens the request in the
    same transaction while it is still disqualified. The review is already recorded, so
    nothing reverses the decision again (the guard: this path skips the capture)."""
    rid = next((s.get("id") for s in decision.subjects or [] if s.get("kind") == "request"), None)
    if rid is None:
        return
    row = await db.scalar(
        select(ProductRequest)
        .where(ProductRequest.id == uuid.UUID(rid))
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if row is None or row.state != "disqualified":
        return
    await _reopen(db, row)
    await flush_or_conflict(db)
    await audit.record(
        db, principal, "request.reopened", "product_request", row.id,
        {"from": "disqualified", "decision_id": str(decision.id), "by_review": True},
    )  # fmt: skip


async def _theme_by_title(db: AsyncSession, title: str) -> RequestTheme | None:
    return await db.scalar(
        select(RequestTheme).where(
            func.lower(RequestTheme.title) == title.strip().lower(),
            RequestTheme.archived_at.is_(None),
        )
    )


async def accept_suggestion(
    db: AsyncSession, principal: Principal, request_id: uuid.UUID, body: AcceptSuggestionIn
) -> ProductRequest:
    row = await _locked(db, request_id)
    expect_version(row, body.lock_version)
    if row.state != "new":
        raise _conflict("Only a New request takes Oracle's suggestions")
    s = _suggestion(row.suggestion)
    if s is None or s.declined_at:
        raise _invalid("Oracle has no suggestion for this request")
    parts = set(body.parts)
    with db.no_autoflush:
        await _accept(db, principal, row, s, parts)
    row.suggestion = {**row.suggestion, "accepted": sorted(parts | set(s.accepted))}
    await flush_or_conflict(db)
    data: dict[str, Any] = {"parts": sorted(parts)}
    if "duplicate" in parts and row.merged_into_id is not None:
        data |= await _asked_again(db, principal, row, row.merged_into_id)
    await audit.record(
        db, principal, "request.suggestion_accepted", "product_request", row.id, data
    )
    return row


async def decline_suggestion(
    db: AsyncSession, principal: Principal, request_id: uuid.UUID, body: DeclineSuggestionIn
) -> ProductRequest:
    """Declines Oracle's suggestion: kept, marked declined, so the daily triage leaves it."""
    row = await _locked(db, request_id)
    expect_version(row, body.lock_version)
    if row.state != "new":
        raise _conflict("Only a New request takes Oracle's suggestions")
    s = _suggestion(row.suggestion)
    if s is None or s.declined_at:
        raise _invalid("Oracle has no suggestion for this request")
    email = await db.scalar(select(User.email).where(User.id == principal.user_id))
    row.suggestion = {
        **row.suggestion,
        "declined_at": _now().isoformat(),
        "declined_by": str(principal.user_id),
        "declined_by_name": display_name(email) if email else None,
    }
    await flush_or_conflict(db)
    await audit.record(db, principal, "request.suggestion_declined", "product_request", row.id, {})
    return row


async def _accept(
    db: AsyncSession, principal: Principal, row: ProductRequest, s: Suggestion, parts: set[str]
) -> None:
    """Applies the accepted parts; the merge (duplicate) last, after every check."""
    if "theme" in parts:
        if s.theme_id:
            row.theme_id = (await _live_theme(db, s.theme_id)).id
        elif s.theme_title and s.theme_title.strip():
            theme = await _theme_by_title(db, s.theme_title)
            if theme is None:
                goals = await confirmed_goals(db, s.goal_ids)
                theme = RequestTheme(
                    title=s.theme_title.strip()[:120],
                    goal_ids=[g for g in s.goal_ids if g in goals],
                    origin="oracle",
                    created_by=principal.id,
                )
                if s.problem and s.problem.problem:
                    theme.problem_suggestion = s.problem.model_dump(exclude_none=True)
                    theme.problem_state = "suggested"
                db.add(theme)
                await db.flush()
                await audit.record(
                    db, principal, "request_theme.created", "request_theme", theme.id,
                    {"title": theme.title, "from_suggestion": str(row.id)},
                )  # fmt: skip
            row.theme_id = theme.id
        else:
            raise _invalid("Oracle suggested no theme")
    if "goals" in parts:
        if not s.goal_ids:
            raise _invalid("Oracle suggested no goal")
        row.goal_ids = await _goal_ids(db, s.goal_ids)
    if "feature" in parts:
        if not s.feature_id:
            raise _invalid("Oracle suggested no feature")
        row.feature_id = await _feature(db, s.feature_id)
    if "duplicate" in parts:
        if not s.duplicate_of:
            raise _invalid("Oracle suggested no duplicate")
        await _merge_into(db, principal, row, s.duplicate_of)


# --- themes ------------------------------------------------------------------------------


async def themes_out(db: AsyncSession, themes: list[RequestTheme]) -> list[RequestThemeOut]:
    ids = [t.id for t in themes]
    counts = (
        dict(
            (
                await db.execute(
                    select(ProductRequest.theme_id, func.count(ProductRequest.id))
                    .where(ProductRequest.theme_id.in_(ids), ProductRequest.state != "merged")
                    .group_by(ProductRequest.theme_id)
                )
            ).all()
        )
        if ids
        else {}
    )
    return [
        RequestThemeOut(
            id=t.id,
            title=t.title,
            description=t.description,
            goal_ids=list(t.goal_ids),
            origin=t.origin,
            archived=t.archived_at is not None,
            archived_at=t.archived_at,
            request_count=counts.get(t.id, 0),
            problem=t.problem,
            success=t.success,
            constraints=t.constraints,
            problem_state=t.problem_state,  # type: ignore[arg-type]
            problem_suggestion=SuggestedProblem(**t.problem_suggestion)
            if t.problem_state == "suggested" and t.problem_suggestion
            else None,
            problem_confirmed_at=t.problem_confirmed_at,
            created_by=t.created_by,
            created_at=t.created_at,
            updated_at=t.updated_at,
            lock_version=t.lock_version,
        )
        for t in themes
    ]


async def list_themes(db: AsyncSession, include_archived: bool) -> list[RequestThemeOut]:
    stmt = select(RequestTheme).order_by(func.lower(RequestTheme.title), RequestTheme.id)
    if not include_archived:
        stmt = stmt.where(RequestTheme.archived_at.is_(None))
    return await themes_out(db, list(await db.scalars(stmt)))


TITLE_TAKEN = "A theme with this title exists; pick another or use that one"


async def _title_free(db: AsyncSession, title: str, but: uuid.UUID | None = None) -> None:
    taken = await _theme_by_title(db, title)
    if taken is not None and taken.id != but:
        raise _conflict(TITLE_TAKEN)


async def _flush_theme(db: AsyncSession) -> None:
    try:
        await flush_or_conflict(db)
    except IntegrityError as e:
        if "ux_request_themes_title" in str(e):
            raise _conflict(TITLE_TAKEN) from e
        raise


async def create_theme(
    db: AsyncSession, principal: Principal, body: RequestThemeCreate
) -> RequestTheme:
    goal_ids = await _goal_ids(db, body.goal_ids)
    await _title_free(db, body.title)
    theme = RequestTheme(
        title=body.title,
        description=body.description or None,
        goal_ids=goal_ids,
        origin="person",
        created_by=principal.id,
    )
    db.add(theme)
    await _flush_theme(db)
    await audit.record(
        db, principal, "request_theme.created", "request_theme", theme.id, {"title": theme.title}
    )
    return theme


async def patch_theme(
    db: AsyncSession, principal: Principal, theme_id: uuid.UUID, body: RequestThemePatch
) -> RequestTheme:
    theme = await db.scalar(
        select(RequestTheme)
        .where(RequestTheme.id == theme_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if theme is None:
        raise _not_found("Theme")
    expect_version(theme, body.lock_version)
    fields = body.model_fields_set - {"lock_version"}
    title = body.title if "title" in fields and body.title is not None else theme.title
    archived = theme.archived_at is not None
    if "archived" in fields and body.archived is not None:
        archived = body.archived
    goal_ids = await _goal_ids(db, body.goal_ids or []) if "goal_ids" in fields else None
    if not archived and fields & {"title", "archived"}:
        await _title_free(db, title, but=theme.id)
    theme.title = title
    if "description" in fields:
        theme.description = body.description or None
    problem_fields = fields & {"problem", "success", "constraints"}
    for name in problem_fields:
        setattr(theme, name, getattr(body, name) or None)
    if problem_fields:
        # A person's problem is a confirmed one (H10).
        if theme.problem:
            _problem_confirmed(theme, principal)
        elif theme.problem_state == "confirmed":
            theme.problem_state = "none"
    if goal_ids is not None:
        theme.goal_ids = goal_ids
    if archived and theme.archived_at is None:
        theme.archived_at = _now()
    elif not archived:
        theme.archived_at = None
    if not fields:
        return theme
    await _flush_theme(db)
    await audit.record(
        db, principal, "request_theme.updated", "request_theme", theme.id,
        {"fields": sorted(fields)},
    )  # fmt: skip
    return theme


# --- why-not replies (H10) ------------------------------------------------------------------

NOT_YOURS = "Only an approver, an owner or the person who filed the request acts on its replies"


async def _reply_and_root(
    db: AsyncSession, principal: Principal, reply_id: uuid.UUID
) -> tuple[RequestReply, ProductRequest]:
    reply = await db.scalar(
        select(RequestReply)
        .where(RequestReply.id == reply_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if reply is None:
        raise _not_found("Reply")
    root = await _locked(db, reply.root_request_id)
    if not replies.may_act(principal, root):
        raise _forbidden(NOT_YOURS)
    if has_role(principal.role, "approver"):
        await recheck_caller(db, principal, "approver")
    return reply, root


async def list_replies(db: AsyncSession, request_id: uuid.UUID) -> list[dict[str, Any]]:
    if await db.get(ProductRequest, request_id) is None:
        raise _not_found()
    return await replies.replies_out(db, await replies.list_for(db, request_id))


async def reply_out(db: AsyncSession, reply: RequestReply) -> dict[str, Any]:
    await db.refresh(reply)
    return (await replies.replies_out(db, [reply]))[0]


async def _reply_done(
    db: AsyncSession, principal: Principal, reply: RequestReply, root: ProductRequest,
    action: str, data: dict[str, Any],
) -> None:  # fmt: skip
    await replies.update_loop(db, root)
    await flush_or_conflict(db)
    await audit.record(
        db, principal, f"request_reply.{action}", "request_reply", reply.id,
        {"request_id": str(root.id), **data},
    )  # fmt: skip


async def update_reply(
    db: AsyncSession, principal: Principal, reply_id: uuid.UUID, body: str, lock_version: int
) -> RequestReply:
    reply, root = await _reply_and_root(db, principal, reply_id)
    expect_version(reply, lock_version)
    if reply.status != "drafted":
        raise _conflict("Only a Drafted reply is edited")
    reply.body = body
    reply.draft_source = "person"
    reply.warnings = replies.promise_warnings(body, reply.asked)
    await _reply_done(db, principal, reply, root, "edited", {"warnings": reply.warnings})
    return reply


async def mark_reply_sent(
    db: AsyncSession, principal: Principal, reply_id: uuid.UUID, channel: str, sent_on: Any
) -> RequestReply:
    reply, root = await _reply_and_root(db, principal, reply_id)
    if reply.status != "drafted":
        raise _conflict("Only a Drafted reply is marked sent")
    from oracle.decisions.service import company_today

    day = sent_on or await company_today(db)
    reply.status = "sent"
    reply.channel = channel
    reply.sent_on = day
    reply.sent_by = principal.id
    await _reply_done(db, principal, reply, root, "sent", {"channel": channel})
    return reply


async def skip_reply(
    db: AsyncSession, principal: Principal, reply_id: uuid.UUID, reason: str
) -> RequestReply:
    reply, root = await _reply_and_root(db, principal, reply_id)
    if reply.status != "drafted":
        raise _conflict("Only a Drafted reply is skipped")
    reply.status = "skipped"
    reply.skip_reason = reason
    await _reply_done(db, principal, reply, root, "skipped", {})
    return reply


async def notify_reply(db: AsyncSession, principal: Principal, reply_id: uuid.UUID) -> RequestReply:
    """Tell them in Oracle: the member who asked gets a shown-only Inbox row with the
    reply. Only for a member asker (409 for anyone else)."""
    reply, root = await _reply_and_root(db, principal, reply_id)
    if reply.member_id is None:
        raise _conflict("Only a member who asked in Oracle can be told in Oracle")
    if reply.status != "drafted":
        raise _conflict("Only a Drafted reply is told in Oracle")
    if not (reply.body or "").strip():
        raise _invalid("Write the reply first")
    reply.status = "notified"
    reply.notified_at = _now()
    reply.sent_by = principal.id
    await _reply_done(db, principal, reply, root, "notified", {})
    return reply


def _refuse_run(principal: Principal) -> None:
    if principal.is_run or principal.run_token_id is not None:
        raise _forbidden("A run's agents never send, mark or edit replies")


async def draft_replies(db: AsyncSession, principal: Principal, request_id: uuid.UUID) -> uuid.UUID:
    """Draft again with Oracle: one job for the replies still Drafted. 409 while one runs,
    and at H11 external_messages Observe."""
    _refuse_run(principal)
    root = await _locked(db, request_id)
    if not replies.may_act(principal, root):
        raise _forbidden(NOT_YOURS)
    if not await replies.drafts_allowed(db):
        raise _conflict("Oracle drafts no replies while Words for people outside is at Observe")
    if await replies.running_job(db, root.id) is not None:
        raise _conflict("Oracle is drafting these replies already")
    open_ = [r for r in await replies.list_for(db, root.id) if r.status == "drafted"]
    if not open_:
        raise _conflict("No reply is still Drafted")
    reopened = any(r.kind == "reopened" for r in open_)
    job = await replies.queue_job(
        db, principal, root, open_, instruction=replies.REOPENED if reopened else None
    )
    assert job is not None
    return job.id


async def tell_reopened(
    db: AsyncSession, principal: Principal, request_id: uuid.UUID
) -> list[RequestReply]:
    """Tell the people who asked (after Reopen): a ``reopened`` reply for each asker whose
    no was Sent or Told, drafted with "say we are looking at it again; promise nothing"."""
    _refuse_run(principal)
    root = await _locked(db, request_id)
    decision = await replies.live_decision(db, root.id)
    if root.state == "disqualified" or decision is None or decision.status != "reversed":
        raise _conflict("Tell the people who asked comes after Reopen")
    told = list(
        await db.scalars(
            select(RequestReply).where(
                RequestReply.root_request_id == root.id,
                RequestReply.kind == "no",
                RequestReply.decision_id == decision.id,
                RequestReply.status.in_(("sent", "notified")),
            )
        )
    )
    askers = list(
        await db.scalars(
            select(ProductRequest).where(ProductRequest.id.in_([r.request_id for r in told]))
        )
    )
    made = await replies.create_replies(db, root, askers, kind="reopened", decision=decision)
    if made and await replies.running_job(db, root.id) is None:
        await replies.queue_job(db, principal, root, made, instruction=replies.REOPENED)
    await flush_or_conflict(db)
    await audit.record(
        db, principal, "request.reopened_told", "product_request", root.id,
        {"replies": len(made)},
    )  # fmt: skip
    return made


async def keep_no(
    db: AsyncSession, principal: Principal, request_id: uuid.UUID, note: str
) -> ProductRequest:
    """Keep the no: a ``reaffirmed`` review on the decision (its approver only, as every
    review), and asked again counts from now."""
    from oracle.decisions import service as decisions
    from oracle.decisions.schemas import ReviewIn

    _refuse_run(principal)
    row = await _locked(db, request_id)
    d = await replies.live_decision(db, row.id)
    if row.state != "disqualified" or d is None or d.status != "decided":
        raise _conflict("Only a request said no to, with its decision logged, keeps its no")
    try:
        await decisions.review(db, principal, d, ReviewIn(verdict="reaffirmed", note=note))
    except decisions.DecisionError as e:
        raise RequestError(e.status, str(e)) from e
    row.asked_again_since = _now()
    await flush_or_conflict(db)
    await audit.record(
        db, principal, "request.no_kept", "product_request", row.id, {"decision_id": str(d.id)}
    )
    return row


# --- theme problems (H10) ---------------------------------------------------------------------


async def _locked_theme(db: AsyncSession, theme_id: uuid.UUID) -> RequestTheme:
    theme = await db.scalar(
        select(RequestTheme)
        .where(RequestTheme.id == theme_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if theme is None:
        raise _not_found("Theme")
    return theme


async def confirm_problem(
    db: AsyncSession, principal: Principal, theme_id: uuid.UUID, lock_version: int
) -> RequestTheme:
    """Confirm Oracle's suggested problem: it becomes the theme's problem."""
    theme = await _locked_theme(db, theme_id)
    expect_version(theme, lock_version)
    s = theme.problem_suggestion or {}
    if not s.get("problem"):
        raise _conflict("Oracle has suggested no problem for this theme")
    theme.problem = str(s.get("problem"))[:1000]
    theme.success = (str(s["success"])[:500] if s.get("success") else None) or theme.success
    theme.constraints = (
        str(s["constraints"])[:500] if s.get("constraints") else None
    ) or theme.constraints
    _problem_confirmed(theme, principal)
    await flush_or_conflict(db)
    await audit.record(
        db, principal, "request_theme.problem_confirmed", "request_theme", theme.id, {}
    )
    return theme


async def dismiss_problem(
    db: AsyncSession, principal: Principal, theme_id: uuid.UUID, lock_version: int
) -> RequestTheme:
    theme = await _locked_theme(db, theme_id)
    expect_version(theme, lock_version)
    if theme.problem_state != "suggested":
        raise _conflict("Oracle has suggested no problem for this theme")
    theme.problem_suggestion = {}
    theme.problem_state = "confirmed" if theme.problem else "none"
    await flush_or_conflict(db)
    await audit.record(
        db, principal, "request_theme.problem_dismissed", "request_theme", theme.id, {}
    )
    return theme


def _problem_confirmed(theme: RequestTheme, principal: Principal) -> None:
    theme.problem_state = "confirmed"
    theme.problem_suggestion = {}
    theme.problem_confirmed_by = principal.id
    theme.problem_confirmed_at = _now()
