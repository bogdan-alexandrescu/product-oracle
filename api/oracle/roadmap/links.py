"""Tracker records linked to synced GitHub issues (F7 Link tracker issues), read-only.

A person who may link (an approver, an owner or an engineering lead) ties one of their
own synced GitHub issues (``source_items`` of kind ``issue``) to a roadmap item of a PRD.
The link is a ``tracker_records`` row: tracker ``github``, ref ``org/app#412``, its state
read from the issue item's State line and its target date from its milestone's Due line
(oracle.sources.connectors.github). Only the owner of a source item may share it (AUD-9):
another member's issue is not found. Oracle reads nothing from GitHub here and writes
nothing to it; the sync keeps the record fresh (:func:`refresh_from_item`, called by
oracle.sources.store) and a removed source relinks it to another member's copy of the
same issue or marks it ``refresh_lost_at`` (:func:`items_gone`).
"""

import re
import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.auth.deps import Principal
from oracle.docs.models import Document
from oracle.roadmap.models import ProductTrack, RoadmapItem, TrackerRecord
from oracle.roadmap.schemas import (
    TrackerIssueLinked,
    TrackerIssueMilestone,
    TrackerIssueOut,
    TrackerLinkIn,
)
from oracle.sources.connectors.github import github_issue_facts, github_milestone_due
from oracle.sources.models import Source, SourceItem, SourceItemVersion

NOT_FOUND = "Issue not found among your synced GitHub issues"
_URL = re.compile(r"^https?://(?:www\.)?github\.com/([^/\s]+/[^/\s]+)/issues/(\d+)/?(?:[?#].*)?$")
_REF = re.compile(r"^([^/\s#]+/[^/\s#]+)#(\d+)$")
_NUMBER = re.compile(r"^#?(\d+)$")


class LinkError(Exception):
    status_code = 422


class NotFound(LinkError):
    status_code = 404


class Conflict(LinkError):
    status_code = 409

    def __init__(self, message: str, linked: dict[str, Any]) -> None:
        super().__init__(message)
        self.linked = linked


def _mine(principal: Principal):
    """The caller's own live synced GitHub issues."""
    return (
        select(SourceItem)
        .join(Source, Source.id == SourceItem.source_id)
        .where(
            Source.owner_user_id == principal.user_id,
            Source.kind == "github",
            SourceItem.kind == "issue",
            SourceItem.deleted_at.is_(None),
        )
    )


def _issue_id(repo: str, number: str) -> Any:
    return func.lower(SourceItem.external_id) == f"{repo.lower()}:issue:{int(number)}"


async def _content(db: AsyncSession, item: SourceItem) -> str:
    if item.current_version_id is None:
        return ""
    return (
        await db.scalar(
            select(SourceItemVersion.content).where(SourceItemVersion.id == item.current_version_id)
        )
        or ""
    )


def _repo_key(item: SourceItem) -> str:
    return item.external_id.rsplit(":issue:", 1)[0]


async def _milestone(db: AsyncSession, item: SourceItem, title: str | None) -> Any:
    """The milestone item of the issue's repo, in the same source, named ``title``."""
    if not title:
        return None
    return await db.scalar(
        select(SourceItem)
        .where(
            SourceItem.source_id == item.source_id,
            SourceItem.kind == "milestone",
            SourceItem.deleted_at.is_(None),
            SourceItem.title == title,
            SourceItem.external_id.startswith(f"{_repo_key(item)}:milestone:", autoescape=True),
        )
        .limit(1)
    )


async def read_issue(db: AsyncSession, item: SourceItem) -> dict[str, Any]:
    """What a record copies from a synced issue item: ref, title, url, state, raw
    status, milestone (title and due day) and when GitHub last changed it."""
    facts = github_issue_facts(await _content(db, item))
    milestone = await _milestone(db, item, facts["milestone"])
    due = github_milestone_due(await _content(db, milestone)) if milestone else None
    number = facts["number"] or item.external_id.rsplit(":", 1)[-1]
    return {
        "external_ref": f"{facts['repository'] or _repo_key(item)}#{number}",
        "title": item.title,
        "url": item.url,
        "state": facts["state"],
        "raw_status": facts["raw_status"],
        "milestone": {"title": facts["milestone"], "due": due} if facts["milestone"] else None,
        "observed_at": item.source_updated_at or datetime.now(UTC),
    }


def _apply(record: TrackerRecord, read: dict[str, Any], item: SourceItem) -> None:
    record.title = read["title"]
    record.url = read["url"]
    record.state = read["state"]
    record.raw_status = read["raw_status"]
    record.target_date = (read["milestone"] or {}).get("due")
    record.observed_at = read["observed_at"]
    record.source_item_id = item.id
    record.refresh_lost_at = None


async def _item_of(db: AsyncSession, record: TrackerRecord) -> tuple[str | None, str | None]:
    """(PRD slug, item title) of the item a record is linked to."""
    prd_id = record.prd_document_id
    if prd_id is None and record.track_id is not None:
        prd_id = await db.scalar(
            select(ProductTrack.prd_document_id).where(ProductTrack.id == record.track_id)
        )
    slug = await db.scalar(select(Document.slug).where(Document.id == prd_id)) if prd_id else None
    title = None
    if prd_id is not None and record.item_key:
        title = await db.scalar(
            select(RoadmapItem.title)
            .where(
                RoadmapItem.prd_document_id == prd_id,
                RoadmapItem.item_key == record.item_key,
                RoadmapItem.roadmap_version_id.is_not(None),
            )
            .order_by(RoadmapItem.created_at.desc())
            .limit(1)
        )
    return slug, title


async def search(
    db: AsyncSession, principal: Principal, q: str, limit: int
) -> list[TrackerIssueOut]:
    """The caller's synced GitHub issues matching ``q``: "#412", "org/app#412", a pasted
    issue URL, or words of the title."""
    query = _mine(principal)
    q = q.strip()
    if m := _URL.match(q) or _REF.match(q):
        query = query.where(_issue_id(m.group(1), m.group(2)))
    elif m := _NUMBER.match(q):
        query = query.where(SourceItem.external_id.endswith(f":issue:{int(m.group(1))}"))
    else:
        for word in q.split():
            query = query.where(SourceItem.title.icontains(word, autoescape=True))
    items = list(
        await db.scalars(
            query.order_by(SourceItem.source_updated_at.desc().nulls_last()).limit(limit)
        )
    )
    reads = [await read_issue(db, i) for i in items]
    records = {
        r.external_ref: r
        for r in await db.scalars(
            select(TrackerRecord).where(
                TrackerRecord.tracker == "github",
                TrackerRecord.external_ref.in_([r["external_ref"] for r in reads]),
            )
        )
    }
    out = []
    for item, read in zip(items, reads, strict=True):
        record = records.get(read["external_ref"])
        linked = None
        if record is not None and record.item_key:
            slug, title = await _item_of(db, record)
            linked = TrackerIssueLinked(
                prd=slug, item_key=record.item_key, record_id=record.id, item_title=title
            )
        out.append(
            TrackerIssueOut(
                source_item_id=item.id,
                external_ref=read["external_ref"],
                title=read["title"],
                url=read["url"],
                state=read["state"],
                raw_status=read["raw_status"],
                milestone=TrackerIssueMilestone(**read["milestone"]) if read["milestone"] else None,
                linked=linked,
            )
        )
    return out


async def _source_item(db: AsyncSession, principal: Principal, body: TrackerLinkIn) -> SourceItem:
    if body.url is not None:
        m = _URL.match(body.url.strip())
        if m is None:
            raise LinkError("that is not a GitHub issue URL (https://github.com/org/app/issues/1)")
        item = await db.scalar(_mine(principal).where(_issue_id(m.group(1), m.group(2))))
        if item is None:
            raise NotFound(NOT_FOUND)
        return item
    item = await db.scalar(
        select(SourceItem)
        .join(Source, Source.id == SourceItem.source_id)
        .where(
            SourceItem.id == body.source_item_id,
            Source.owner_user_id == principal.user_id,
            SourceItem.deleted_at.is_(None),
        )
    )
    if item is None:
        raise NotFound(NOT_FOUND)
    if item.kind != "issue" or ":issue:" not in item.external_id:
        raise LinkError(f"only a GitHub issue can be linked, not a {item.kind.replace('_', ' ')}")
    return item


async def link(
    db: AsyncSession, principal: Principal, prd: Document, body: TrackerLinkIn
) -> tuple[TrackerRecord, set[uuid.UUID]]:
    """Link the issue to ``body.item_key`` of ``prd``; returns the record and the tracks
    to monitor again. The caller commits."""
    item = await _source_item(db, principal, body)
    roadmap_item = await db.scalar(
        select(RoadmapItem)
        .where(
            RoadmapItem.prd_document_id == prd.id,
            RoadmapItem.item_key == body.item_key,
            RoadmapItem.roadmap_version_id.is_not(None),
        )
        .order_by(RoadmapItem.created_at.desc())
        .limit(1)
    )
    if roadmap_item is None:
        raise LinkError(f"'{body.item_key}' is not a roadmap item of {prd.slug}")
    track_id = roadmap_item.track_id or await db.scalar(
        select(ProductTrack.id).where(ProductTrack.prd_document_id == prd.id)
    )
    read = await read_issue(db, item)
    ref = read["external_ref"]
    # Links and imports of GitHub records run one at a time (read, then write).
    await db.execute(
        text("SELECT pg_advisory_xact_lock(hashtext(:k))"),
        {"k": f"tracker:{principal.tenant_id}:github"},
    )
    record = await db.scalar(
        select(TrackerRecord).where(
            TrackerRecord.tracker == "github", TrackerRecord.external_ref == ref
        )
    )
    touched: set[uuid.UUID] = {track_id} if track_id else set()
    action = "tracker.issue_linked"
    moved_from = None
    if record is None:
        record = TrackerRecord(tracker="github", external_ref=ref, recorded_by=principal.id)
        db.add(record)
    elif record.item_key and (record.item_key, record.prd_document_id) != (
        body.item_key,
        prd.id,
    ):
        slug, title = await _item_of(db, record)
        moved_from = {"prd": slug, "item_key": record.item_key, "item_title": title}
        if not body.move:
            raise Conflict(f"{ref} is linked to {title or record.item_key} ({slug})", moved_from)
        action = "tracker.issue_moved"
        if record.track_id:
            touched.add(record.track_id)
    _apply(record, read, item)
    record.item_key = body.item_key
    record.track_id = track_id
    record.prd_document_id = prd.id
    record.linked_by = principal.user_id
    record.linked_at = datetime.now(UTC)
    await db.flush()
    data: dict[str, Any] = {"ref": ref, "prd": prd.slug, "item": body.item_key}
    if moved_from is not None:
        data["from"] = moved_from
    await audit.record(db, principal, action, "tracker_record", record.id, data)
    return record, touched


async def unlink(
    db: AsyncSession, principal: Principal, record_id: uuid.UUID
) -> tuple[TrackerRecord, set[uuid.UUID]]:
    """Clear the record's item, track and PRD; the record (and its history) stays."""
    record = await db.scalar(
        select(TrackerRecord).where(TrackerRecord.id == record_id).with_for_update()
    )
    if record is None:
        raise NotFound("Tracker record not found")
    slug, _ = await _item_of(db, record)
    touched = {record.track_id} if record.track_id else set()
    data = {"ref": record.external_ref, "prd": slug, "item": record.item_key}
    record.item_key = None
    record.track_id = None
    record.prd_document_id = None
    await db.flush()
    await audit.record(db, principal, "tracker.issue_unlinked", "tracker_record", record.id, data)
    return record, touched


async def _monitor(db: AsyncSession, track_ids: set[uuid.UUID]) -> None:
    from oracle.roadmap import views

    for track in await db.scalars(
        select(ProductTrack).where(ProductTrack.id.in_(track_ids)).order_by(ProductTrack.id)
    ):
        await views.monitor(db, track, "system")


async def refresh_from_item(db: AsyncSession, item: SourceItem) -> None:
    """A sync wrote a new version of ``item``: refresh the records linked to it (an
    issue) or to the issues of its repo naming it (a milestone), then monitor their
    tracks again. The caller commits."""
    if item.kind == "issue":
        records = list(
            await db.scalars(select(TrackerRecord).where(TrackerRecord.source_item_id == item.id))
        )
        issues = {item.id: item}
    elif item.kind == "milestone" and ":milestone:" in item.external_id:
        repo = item.external_id.rsplit(":milestone:", 1)[0]
        rows = (
            await db.execute(
                select(TrackerRecord, SourceItem)
                .join(SourceItem, SourceItem.id == TrackerRecord.source_item_id)
                .where(
                    SourceItem.source_id == item.source_id,
                    SourceItem.external_id.startswith(f"{repo}:issue:", autoescape=True),
                )
            )
        ).all()
        records = [r for r, _ in rows]
        issues = {i.id: i for _, i in rows}
    else:
        return
    touched: set[uuid.UUID] = set()
    for record in records:
        issue = issues[record.source_item_id]  # type: ignore[index]
        read = await read_issue(db, issue)
        if item.kind == "milestone" and (read["milestone"] or {}).get("title") != item.title:
            continue
        _apply(record, read, issue)
        if record.track_id:
            touched.add(record.track_id)
    await db.flush()
    if touched:
        await _monitor(db, touched)


async def items_gone(db: AsyncSession, item_ids: set[uuid.UUID]) -> None:
    """These source items are being deleted (a source removed, narrowed, disconnected):
    a record linked to one is relinked to another live item of the company with the same
    issue, else keeps its last state and gets ``refresh_lost_at``. The caller commits."""
    if not item_ids:
        return
    rows = (
        await db.execute(
            select(TrackerRecord, SourceItem.external_id)
            .join(SourceItem, SourceItem.id == TrackerRecord.source_item_id)
            .where(TrackerRecord.source_item_id.in_(item_ids))
        )
    ).all()
    for record, external_id in rows:
        other = await db.scalar(
            select(SourceItem)
            .where(
                SourceItem.external_id == external_id,
                SourceItem.kind == "issue",
                SourceItem.deleted_at.is_(None),
                SourceItem.id.not_in(item_ids),
            )
            .order_by(SourceItem.source_updated_at.desc().nulls_last())
            .limit(1)
        )
        if other is not None:
            record.source_item_id = other.id
            record.refresh_lost_at = None
        else:
            record.source_item_id = None
            record.refresh_lost_at = datetime.now(UTC)
    await db.flush()


async def adopt(db: AsyncSession, track: ProductTrack) -> None:
    """A PRD's track started: its linked records with no track get it."""
    await db.execute(
        update(TrackerRecord)
        .where(
            TrackerRecord.prd_document_id == track.prd_document_id,
            TrackerRecord.track_id.is_(None),
            TrackerRecord.item_key.is_not(None),
        )
        .values(track_id=track.id)
        .execution_options(synchronize_session=False)
    )
