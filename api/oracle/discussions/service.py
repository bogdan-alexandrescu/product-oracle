"""Discussions (G1): subjects, people, messages, visibility and the audit of each write.

Every write re-reads the caller under the review gate (oracle.authz.recheck_caller) and
checks their role and their place in the discussion at the moment it writes. Audit data
holds ids and lengths, never message text.
"""

import uuid
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy import func, or_, select
from sqlalchemy import update as sql_update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import set_committed_value

from oracle import audit
from oracle.auth.models import User
from oracle.authz import has_role, recheck_caller
from oracle.discussions import access, kinds, replies
from oracle.discussions.models import (
    MAX_BODY,
    MAX_SUMMARY,
    MAX_TITLE,
    Discussion,
    DiscussionChange,
    DiscussionMessage,
    DiscussionParticipant,
)
from oracle.discussions.schemas import (
    DiscussionChangeCounts,
    DiscussionChangeOut,
    DiscussionCreate,
    DiscussionExposure,
    DiscussionMe,
    DiscussionMessageIn,
    DiscussionMessageOut,
    DiscussionMeSummary,
    DiscussionOut,
    DiscussionParticipantOut,
    DiscussionPatch,
    DiscussionPerson,
    DiscussionStarter,
    DiscussionSummary,
    HiddenDiscussion,
    PrivateFindings,
    ReplyUsage,
)
from oracle.members.names import display_name
from oracle.v2.concurrency import expect_version, flush_or_conflict

if TYPE_CHECKING:
    from oracle.auth.deps import Principal

ENTITY = "discussion"
VIEWERS_READ = "Viewers can read discussions but not write in them"
PRIVATE = "This discussion is private"
CLOSED = "This discussion is closed"
STARTER_ADDS = "Only the starter can add people to a private discussion"
SHARE_TO_ADD = "Share this finding at Summary or above to add people"
STARTER_OPENS = "Only the starter can make a private discussion open"
SHARE_FIRST = "Share this finding at Summary or above first"
PANEL_CHAT = "Share a panel chat with Share as discussion"
CONFIRM_EXPOSURE = "Confirm what this exposes"
BODY_TOO_LONG = "A message can be at most 8,000 characters"
SUMMARY_TOO_LONG = "A summary can be at most 1,200 characters"
STARTER_ONLY = "Only the starter can change this"
NOT_FOUND = "Discussion not found"
# The Runs page's checkpoint names (web/app/runs/_lib.tsx CHECKPOINT_LABEL).
CHECKPOINT_LABEL = {
    "baseline_confirm": "Confirm the baseline",
    "feature_set": "Feature set",
    "priority_order": "Priority order",
    "prd_review": "PRD review",
    "eng_review": "Engineering review",
    "roadmap_items": "Roadmap items",
    "roadmap_review": "Roadmap review",
    "request_triage": "Request triage",
}


class DiscussionError(Exception):
    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


class SubjectError(DiscussionError):
    def __init__(self, detail: str, status: int = 422) -> None:
        super().__init__(status, detail)


class ExposureMismatch(Exception):
    """Make open without the current counts: the client shows the warning again."""

    def __init__(self, messages: int, people: int) -> None:
        super().__init__(CONFIRM_EXPOSURE)
        self.messages = messages
        self.people = people


# --- subjects -----------------------------------------------------------------------------


class _Subject(BaseModel):
    model_config = ConfigDict(extra="forbid")


class DocumentSubject(_Subject):
    document_id: uuid.UUID
    version: int = Field(ge=1)


class SectionSubject(DocumentSubject):
    section_key: str = Field(min_length=1, max_length=200)


class RoadmapItemSubject(DocumentSubject):
    item_key: str = Field(min_length=1, max_length=200)


class CheckpointSubject(_Subject):
    run_id: uuid.UUID
    checkpoint_id: uuid.UUID


class CheckpointItemSubject(CheckpointSubject):
    checkpoint_kind: str = Field(min_length=1, max_length=50)
    item_key: str = Field(min_length=1, max_length=200)


class EntitySubject(_Subject):
    entity_id: uuid.UUID
    # B6 Goals interview's flag: the composer's Ask Oracle is on by default.
    interview: bool | None = None


class ConflictSubject(_Subject):
    conflict_id: uuid.UUID


class IntakeSubject(_Subject):
    intake_id: uuid.UUID


class GapSubject(_Subject):
    gap_id: uuid.UUID


class TrackSubject(_Subject):
    track_id: uuid.UUID
    milestone: str | None = Field(default=None, min_length=1, max_length=200)


class PrioritiesSubject(_Subject):
    snapshot_id: uuid.UUID | None = None


class ScreenSubject(_Subject):
    path: str = Field(pattern=r"^/", max_length=200)


SUBJECTS: dict[str, type[_Subject]] = {
    "document": DocumentSubject,
    "section": SectionSubject,
    "checkpoint": CheckpointSubject,
    "checkpoint_item": CheckpointItemSubject,
    "roadmap_item": RoadmapItemSubject,
    "entity": EntitySubject,
    "conflict": ConflictSubject,
    "intake": IntakeSubject,
    "gap": GapSubject,
    "track": TrackSubject,
    "priorities": PrioritiesSubject,
    "screen": ScreenSubject,
}


def parse_subject(kind: str, raw: dict[str, Any]) -> dict[str, Any]:
    """The subject as its kind's shape reads it, as JSON (422 when it does not)."""
    try:
        model = SUBJECTS[kind].model_validate(raw)
    except ValidationError as e:
        problem = e.errors()[0]
        where = ".".join(str(p) for p in problem["loc"]) or "subject"
        raise SubjectError(f"Invalid {kind} subject: {where}: {problem['msg']}") from e
    return model.model_dump(mode="json", exclude_none=True)


def subject_key(kind: str, s: dict[str, Any], *, checkpoint_kind: str | None = None) -> str:
    """The lookup key: the subject without its version (a discussion follows its section
    across versions) and, for a checkpoint, the run and the checkpoint kind (it stays on
    the item when a send-back opens the next attempt's checkpoint)."""
    match kind:
        case "document":
            return f"document:{s['document_id']}"
        case "section":
            return f"section:{s['document_id']}:{s['section_key']}"
        case "checkpoint":
            return f"checkpoint:{s['run_id']}:{checkpoint_kind}"
        case "checkpoint_item":
            return f"run_item:{s['run_id']}:{s['checkpoint_kind']}:{s['item_key']}"
        case "roadmap_item":
            return f"roadmap_item:{s['document_id']}:{s['item_key']}"
        case "entity":
            return f"entity:{s['entity_id']}"
        case "conflict":
            return f"conflict:{s['conflict_id']}"
        case "intake":
            return f"intake:{s['intake_id']}"
        case "gap":
            return f"gap:{s['gap_id']}"
        case "track":
            milestone = s.get("milestone")
            return f"track:{s['track_id']}" + (f":{milestone}" if milestone else "")
        case "priorities":
            return "priorities"
        case "screen":
            return f"screen:{s['path']}"
    raise SubjectError(f"Unknown subject kind {kind}")


@dataclass
class Resolved:
    key: str
    document_id: uuid.UUID | None = None
    run_id: uuid.UUID | None = None
    intake_id: uuid.UUID | None = None
    # Rule 3.4.3: the subject is its author's private finding; who the author is.
    finding_author: uuid.UUID | None = None


async def _document_version(db: AsyncSession, s: dict[str, Any]):
    from oracle.docs.models import Document, DocumentVersion

    doc = await db.get(Document, uuid.UUID(s["document_id"]))
    if doc is None:
        raise SubjectError("Document not found", 404)
    version = await db.scalar(
        select(DocumentVersion).where(
            DocumentVersion.document_id == doc.id, DocumentVersion.number == s["version"]
        )
    )
    if version is None:
        raise SubjectError(f"Version {s['version']} not found", 404)
    return doc, version


async def resolve_subject(
    db: AsyncSession, principal: "Principal", kind: str, s: dict[str, Any]
) -> Resolved:
    """Check the subject exists in the company (404 "Document not found" and the like;
    422 for a section not in that version) and derive its key and links."""
    from oracle.baseline.models import Conflict, Entity
    from oracle.docs.models import Section
    from oracle.priorities.models import PrioritySnapshot
    from oracle.roadmap.models import ProductTrack
    from oracle.runs.models import Checkpoint, Run
    from oracle.v2.models import ProductIntake

    def uid(field: str) -> uuid.UUID:
        return uuid.UUID(s[field])

    if kind in ("document", "section", "roadmap_item"):
        doc, version = await _document_version(db, s)
        if kind == "section":
            found = await db.scalar(
                select(Section.id).where(
                    Section.version_id == version.id, Section.section_key == s["section_key"]
                )
            )
            if found is None:
                raise SubjectError(f"Section {s['section_key']} is not in version {s['version']}")
        return Resolved(subject_key(kind, s), document_id=doc.id)
    if kind in ("checkpoint", "checkpoint_item"):
        run = await db.get(Run, uid("run_id"))
        if run is None:
            raise SubjectError("Run not found", 404)
        cp = await db.get(Checkpoint, uid("checkpoint_id"))
        if cp is None or cp.run_id != run.id:
            raise SubjectError("Checkpoint not found", 404)
        if kind == "checkpoint_item" and cp.kind != s["checkpoint_kind"]:
            raise SubjectError(f"The checkpoint is not a {s['checkpoint_kind']} checkpoint")
        return Resolved(subject_key(kind, s, checkpoint_kind=cp.kind), run_id=run.id)
    if kind == "entity":
        if await db.get(Entity, uid("entity_id")) is None:
            raise SubjectError("Entity not found", 404)
    elif kind == "conflict":
        if await db.get(Conflict, uid("conflict_id")) is None:
            raise SubjectError("Conflict not found", 404)
    elif kind == "intake":
        if await db.get(ProductIntake, uid("intake_id")) is None:
            raise SubjectError("Intake not found", 404)
        return Resolved(subject_key(kind, s), intake_id=uid("intake_id"))
    elif kind == "gap":
        return await _resolve_gap(db, principal, s)
    elif kind == "track":
        if await db.get(ProductTrack, uid("track_id")) is None:
            raise SubjectError("Track not found", 404)
    elif kind == "priorities":
        if s.get("snapshot_id") and await db.get(PrioritySnapshot, uid("snapshot_id")) is None:
            raise SubjectError("Priority snapshot not found", 404)
    return Resolved(subject_key(kind, s))


async def _resolve_gap(db: AsyncSession, principal: "Principal", s: dict[str, Any]) -> Resolved:
    """A gap the caller can read (S6: one its author has not shared does not exist for
    anyone else); its author's private finding makes the discussion rule 3.4.3's."""
    from oracle.intake import sharing
    from oracle.v2.models import KnowledgeGap

    gap = await db.get(KnowledgeGap, uuid.UUID(s["gap_id"]))
    if gap is None:
        raise SubjectError("Gap not found", 404)
    found = await access.hidden_finding(db, gap.id)
    if found is None:
        return Resolved(subject_key("gap", s), document_id=gap.document_id)
    intake, hidden = found
    if hidden and not sharing.is_author(principal, intake):
        raise SubjectError("Gap not found", 404)
    return Resolved(
        subject_key("gap", s),
        intake_id=intake.id,
        finding_author=intake.author_id if hidden else None,
    )


class Labels:
    """Subject labels and links, each row read once per request."""

    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.rows: dict[tuple[type, uuid.UUID], Any] = {}

    async def get(self, model: type, id_: Any) -> Any:
        key = (model, uuid.UUID(str(id_)))
        if key not in self.rows:
            self.rows[key] = await self.db.get(model, key[1])
        return self.rows[key]

    async def of(self, d: Discussion) -> tuple[str, str]:
        try:
            return await self._of(d)
        except (KeyError, ValueError):
            return d.subject_kind.replace("_", " ").capitalize(), "/"

    async def _of(self, d: Discussion) -> tuple[str, str]:
        from oracle.baseline.models import Conflict, Entity
        from oracle.docs.models import Document, DocumentVersion, Section
        from oracle.intake import categories
        from oracle.roadmap.models import ProductTrack
        from oracle.runs import flows
        from oracle.runs.models import Checkpoint, Run
        from oracle.v2.models import KnowledgeGap, ProductIntake

        s, kind = d.subject, d.subject_kind
        gone = kind.replace("_", " ").capitalize()
        if kind in ("document", "section", "roadmap_item"):
            doc = await self.get(Document, s["document_id"])
            if doc is None:
                return gone, "/"
            url = f"/documents/{doc.slug}/v/{s['version']}"
            if kind == "document":
                return doc.title, url
            if kind == "roadmap_item":
                return f"{doc.title} · {s['item_key']}", f"{url}/items"
            heading = await self.db.scalar(
                select(Section.heading)
                .join(DocumentVersion, DocumentVersion.id == Section.version_id)
                .where(
                    DocumentVersion.document_id == doc.id,
                    DocumentVersion.number == s["version"],
                    Section.section_key == s["section_key"],
                )
            )
            return f"{doc.title} · {heading or s['section_key']}", f"{url}#{s['section_key']}"
        if kind in ("checkpoint", "checkpoint_item"):
            run = await self.get(Run, s["run_id"])
            cp = await self.get(Checkpoint, s["checkpoint_id"])
            if run is None:
                return gone, "/runs"
            flow = flows.FLOWS.get(run.flow)
            cp_kind = cp.kind if cp is not None else s.get("checkpoint_kind", "")
            label = f"{flow.title if flow else run.flow} · {CHECKPOINT_LABEL.get(cp_kind, cp_kind)}"
            if kind == "checkpoint_item":
                label += f" · {s['item_key']}"
            return label, f"/runs/{run.id}"
        if kind == "entity":
            entity = await self.get(Entity, s["entity_id"])
            return (entity.title if entity else gone), "/baseline"
        if kind == "conflict":
            conflict = await self.get(Conflict, s["conflict_id"])
            return (f"Conflict on {conflict.field}" if conflict else gone), "/baseline"
        if kind == "intake":
            intake = await self.get(ProductIntake, s["intake_id"])
            return (intake.title if intake else gone), f"/briefs/{s['intake_id']}"
        if kind == "gap":
            gap = await self.get(KnowledgeGap, s["gap_id"])
            if gap is None:
                return gone, "/"
            category = categories.BY_KEY.get(gap.category)
            label = f"{category.label if category else gap.category} gap"
            return label, f"/briefs/{gap.intake_id}" if gap.intake_id else "/"
        if kind == "track":
            track = await self.get(ProductTrack, s["track_id"])
            label = track.title if track else gone
            return (f"{label} · {s['milestone']}" if s.get("milestone") else label), "/plan"
        if kind == "priorities":
            return "Priority order", "/priorities"
        return s["path"], s["path"]


# --- people -------------------------------------------------------------------------------


async def users_by_id(db: AsyncSession, ids: set[uuid.UUID]) -> dict[uuid.UUID, User]:
    if not ids:
        return {}
    return {u.id: u for u in await db.scalars(select(User).where(User.id.in_(ids)))}


async def members(db: AsyncSession, ids: list[uuid.UUID]) -> dict[uuid.UUID, User]:
    """The company's active members with these ids (the ones ``GET /v1/people`` lists);
    422 "<id> is not a member of this company" for any other."""
    found = await users_by_id(db, set(ids))
    for i in ids:
        user = found.get(i)
        if user is None or user.disabled_at is not None:
            raise DiscussionError(422, f"{i} is not a member of this company")
    return found


def _writes(user: User | None) -> bool:
    return user is not None and user.disabled_at is None and has_role(user.role, "commenter")


async def _participants(db: AsyncSession, d: Discussion) -> dict[uuid.UUID, DiscussionParticipant]:
    """Everyone ever in it, by user id (``left_at`` set: left or removed)."""
    rows = await db.scalars(
        select(DiscussionParticipant)
        .where(DiscussionParticipant.discussion_id == d.id)
        .order_by(DiscussionParticipant.created_at, DiscussionParticipant.id)
    )
    return {p.user_id: p for p in rows}


def _active(parts: dict[uuid.UUID, DiscussionParticipant]) -> dict[uuid.UUID, Any]:
    return {k: p for k, p in parts.items() if p.left_at is None}


async def _seat(
    db: AsyncSession,
    principal: "Principal",
    d: Discussion,
    parts: dict[uuid.UUID, DiscussionParticipant],
) -> access.Seat:
    me = principal.user_id
    return access.Seat(
        role=principal.role,
        visibility=d.visibility,
        participant=me is not None and me in _active(parts),
        starter=me is not None and me == d.started_by,
        author_only=await access.author_only_now(db, d),
        origin=d.origin,
    )


def _add(
    db: AsyncSession,
    d: Discussion,
    parts: dict[uuid.UUID, DiscussionParticipant],
    user_id: uuid.UUID,
    via: str,
    by: uuid.UUID | None,
) -> bool:
    """Put someone in (again); False when they already are."""
    row = parts.get(user_id)
    if row is not None and row.left_at is None:
        return False
    if row is None:
        row = DiscussionParticipant(discussion_id=d.id, user_id=user_id)
        db.add(row)
        parts[user_id] = row
    row.added_via, row.added_by = via, by
    row.left_at = row.removed_by = None
    return True


# --- reading ------------------------------------------------------------------------------


async def get_discussion(db: AsyncSession, discussion_id: uuid.UUID, *, lock: bool = False):
    d = await db.get(Discussion, discussion_id, with_for_update=lock)
    if d is None:
        raise DiscussionError(404, NOT_FOUND)
    return d


async def readable(
    db: AsyncSession, principal: "Principal", discussion_id: uuid.UUID, *, lock: bool = False
) -> tuple[Discussion, dict[uuid.UUID, DiscussionParticipant], access.Seat]:
    """The discussion, its people and the caller's seat, or 404 (it does not exist for
    them: rule 3.4.3, or a subject they cannot see) or 403 "This discussion is private"."""
    d = await get_discussion(db, discussion_id, lock=lock)
    parts = await _participants(db, d)
    seat = await _seat(db, principal, d, parts)
    if seat.author_only and not seat.participant:
        raise DiscussionError(404, NOT_FOUND)
    if not await access.can_read_subject(db, principal, d):
        raise DiscussionError(404, NOT_FOUND)
    if not access.can_read(seat):
        raise DiscussionError(403, PRIVATE)
    return d, parts, seat


async def exposure(db: AsyncSession, d: Discussion) -> tuple[int, int]:
    """What making it open exposes: the messages not deleted, people's and Oracle's
    (system lines excluded), and the distinct people who wrote them."""
    rows = (
        await db.execute(
            select(DiscussionMessage.author_kind, DiscussionMessage.author_id).where(
                DiscussionMessage.discussion_id == d.id,
                DiscussionMessage.deleted_at.is_(None),
                DiscussionMessage.author_kind.in_(("person", "oracle")),
            )
        )
    ).all()
    people = {a for k, a in rows if k == "person" and a is not None}
    return len(rows), len(people)


@dataclass
class Stats:
    messages: Counter
    changes: dict[uuid.UUID, Counter]
    unread: Counter


async def _stats(db: AsyncSession, principal: "Principal", ds: list[Discussion]) -> Stats:
    ids = [d.id for d in ds]
    stats = Stats(Counter(), defaultdict(Counter), Counter())
    if not ids:
        return stats
    counted = (DiscussionMessage.deleted_at.is_(None), DiscussionMessage.author_kind != "system")
    for did, n in await db.execute(
        select(DiscussionMessage.discussion_id, func.count())
        .where(DiscussionMessage.discussion_id.in_(ids), *counted)
        .group_by(DiscussionMessage.discussion_id)
    ):
        stats.messages[did] = n
    for did, st, n in await db.execute(
        select(DiscussionChange.discussion_id, DiscussionChange.status, func.count())
        .where(DiscussionChange.discussion_id.in_(ids))
        .group_by(DiscussionChange.discussion_id, DiscussionChange.status)
    ):
        stats.changes[did][st] = n
    if principal.user_id is not None:
        mine = DiscussionParticipant
        for did, n in await db.execute(
            select(DiscussionMessage.discussion_id, func.count())
            .join(
                mine,
                (mine.discussion_id == DiscussionMessage.discussion_id)
                & (mine.user_id == principal.user_id)
                & mine.left_at.is_(None),
            )
            .where(
                DiscussionMessage.discussion_id.in_(ids),
                *counted,
                or_(
                    DiscussionMessage.author_id.is_(None),
                    DiscussionMessage.author_id != principal.user_id,
                ),
                or_(mine.last_read_at.is_(None), DiscussionMessage.created_at > mine.last_read_at),
            )
            .group_by(DiscussionMessage.discussion_id)
        ):
            stats.unread[did] = n
    return stats


def _started_on(d: Discussion) -> int | None:
    version = d.subject.get("version")
    return version if isinstance(version, int) else None


async def _summary_fields(
    db: AsyncSession,
    principal: "Principal",
    d: Discussion,
    seat: access.Seat,
    stats: Stats,
    labels: Labels,
    users: dict[uuid.UUID, User],
) -> dict[str, Any]:
    label, url = await labels.of(d)
    starter = users.get(d.started_by)
    changes = stats.changes.get(d.id, Counter())
    return {
        "id": d.id,
        "subject_kind": d.subject_kind,
        "subject_key": d.subject_key,
        "subject_label": label,
        "subject_url": url,
        "title": d.title,
        "visibility": d.visibility,
        "author_only": d.author_only,
        "status": d.status,
        "origin": d.origin,
        "started_by": DiscussionStarter(
            user_id=d.started_by,
            name=display_name(starter.email) if starter else "Someone",
            role=starter.role if starter else "viewer",  # type: ignore[arg-type]
        ),
        "started_on_version": _started_on(d),
        "message_count": stats.messages.get(d.id, 0),
        "last_message_at": d.last_message_at,
        "summary": d.summary,
        "summary_status": d.summary_status,
        "summary_shared": d.summary_shared,
        "changes": DiscussionChangeCounts(
            proposed=changes["proposed"], suggested=changes["suggested"], staged=changes["staged"]
        ),
        "lock_version": d.lock_version,
        "created_at": d.created_at,
        "updated_at": d.updated_at,
        "me": {
            "participant": seat.participant,
            "can_write": access.can_write(seat) and principal.user_id is not None,
            "unread": stats.unread.get(d.id, 0),
        },
    }


async def discussion_out(db: AsyncSession, principal: "Principal", d: Discussion) -> DiscussionOut:
    parts = await _participants(db, d)
    seat = await _seat(db, principal, d, parts)
    active = _active(parts)
    users = await users_by_id(db, {d.started_by, *active})
    stats = await _stats(db, principal, [d])
    fields = await _summary_fields(db, principal, d, seat, stats, Labels(db), users)
    fields["me"] = DiscussionMe(**fields["me"], can_manage=access.can_manage(seat))
    out = DiscussionOut(
        **fields,
        subject=d.subject,
        participants=[
            DiscussionParticipantOut(
                user_id=p.user_id,
                name=display_name(users[p.user_id].email),
                role=users[p.user_id].role,  # type: ignore[arg-type]
                can_write=_writes(users[p.user_id]),
                added_via=p.added_via,  # type: ignore[arg-type]
            )
            for p in active.values()
            if p.user_id in users
        ],
    )
    if d.visibility == "private" and seat.starter:
        messages, people = await exposure(db, d)
        out.exposure = DiscussionExposure(messages=messages, people=people)
    out.me.private_findings = await private_findings(db, principal, d)
    return out


async def private_findings(
    db: AsyncSession, principal: "Principal", d: Discussion
) -> PrivateFindings | None:
    """G1 §3.4.6: the caller's own findings below Summary on the subject's intake, for
    the intake's author only."""
    from oracle.intake import sharing
    from oracle.v2.models import KnowledgeGap, ProductIntake

    intake: ProductIntake | None = None
    if d.subject_kind == "intake":
        intake = await db.get(ProductIntake, uuid.UUID(d.subject["intake_id"]))
    elif d.subject_kind == "gap":
        gap = await db.get(KnowledgeGap, uuid.UUID(d.subject["gap_id"]))
        if gap is not None and gap.intake_id is not None:
            intake = await db.get(ProductIntake, gap.intake_id)
    elif d.subject_kind == "document" and d.document_id is not None:
        intake = await db.scalar(
            select(ProductIntake).where(ProductIntake.document_id == d.document_id).limit(1)
        )
    if intake is None or not sharing.is_author(principal, intake):
        return None
    reg = sharing.registry(intake)
    below = [
        e
        for e in reg.values()
        if not sharing.is_open(e)
        and sharing.RANK[e.get("sharing", sharing.DEFAULT)] < sharing.RANK["summary"]
    ]
    return PrivateFindings(count=len(below), intake_id=intake.id) if below else None


async def list_discussions(
    db: AsyncSession,
    principal: "Principal",
    *,
    subject_key: str | None = None,
    document_id: uuid.UUID | None = None,
    run_id: uuid.UUID | None = None,
    status: str | None = None,
    mine: bool = False,
    origin: str | None = None,
    limit: int = 50,
) -> list[DiscussionSummary | HiddenDiscussion]:
    """Latest activity first. A private discussion the caller is not in comes back as a
    hidden row only when the filter names its subject; ``mine`` never returns one; rule
    3.4.3 discussions are not returned at all to anyone but their author."""
    stmt = select(Discussion)
    if subject_key:
        stmt = stmt.where(Discussion.subject_key == subject_key)
    if document_id:
        stmt = stmt.where(Discussion.document_id == document_id)
    if run_id:
        stmt = stmt.where(Discussion.run_id == run_id)
    if status:
        stmt = stmt.where(Discussion.status == status)
    if origin:
        stmt = stmt.where(Discussion.origin == origin)
    if mine:
        if principal.user_id is None:
            return []
        stmt = stmt.where(
            Discussion.id.in_(
                select(DiscussionParticipant.discussion_id).where(
                    DiscussionParticipant.user_id == principal.user_id,
                    DiscussionParticipant.left_at.is_(None),
                )
            )
        )
    activity = func.coalesce(Discussion.last_message_at, Discussion.created_at)
    rows = list(await db.scalars(stmt.order_by(activity.desc(), Discussion.id).limit(limit)))
    named = bool(subject_key or document_id or run_id)
    shown: list[tuple[Discussion, access.Seat | None]] = []
    for d in rows:
        parts = await _participants(db, d)
        seat = await _seat(db, principal, d, parts)
        if seat.author_only and not seat.participant:
            continue
        if not await access.can_read_subject(db, principal, d):
            continue
        if access.can_read(seat):
            shown.append((d, seat))
        elif named and not mine:
            shown.append((d, None))
    readable_rows = [d for d, seat in shown if seat is not None]
    stats = await _stats(db, principal, readable_rows)
    users = await users_by_id(db, {d.started_by for d in readable_rows})
    labels = Labels(db)
    out: list[DiscussionSummary | HiddenDiscussion] = []
    for d, seat in shown:
        if seat is None:
            out.append(
                HiddenDiscussion(
                    id=d.id,
                    visibility="private",
                    hidden=True,
                    summary=d.summary if d.summary_shared else None,
                )
            )
            continue
        fields = await _summary_fields(db, principal, d, seat, stats, labels, users)
        out.append(DiscussionSummary(**{**fields, "me": DiscussionMeSummary(**fields["me"])}))
    return out


def message_out(
    m: DiscussionMessage, users: dict[uuid.UUID, User], role: str | None = None
) -> DiscussionMessageOut:
    def ref(uid: uuid.UUID) -> DiscussionPerson:
        user = users.get(uid)
        return DiscussionPerson(user_id=uid, name=display_name(user.email) if user else "Someone")

    deleted = m.deleted_at is not None
    return DiscussionMessageOut(
        id=m.id,
        discussion_id=m.discussion_id,
        author_kind=m.author_kind,  # type: ignore[arg-type]
        author=ref(m.author_id) if m.author_kind == "person" and m.author_id else None,
        via=m.via,  # type: ignore[arg-type]
        body="" if deleted else m.body,
        mentions=[] if deleted else [ref(u) for u in m.mentions],
        mentions_oracle=m.mentions_oracle,
        reply_to=m.reply_to,
        status=m.status,  # type: ignore[arg-type]
        citations=m.citations,
        created_at=m.created_at,
        edited_at=m.edited_at,
        deleted=deleted,
        error_reason=m.error_reason,
        error=replies.error_copy(m, role),
        pushback=m.pushback,
        usage=ReplyUsage(
            model=m.model,
            input_tokens=m.input_tokens,
            output_tokens=m.output_tokens,
            cost_usd=float(m.cost_usd) if m.cost_usd is not None else None,
            account_label=m.account_label,
            llm_via=m.llm_via,
            attempts=m.attempts,
        )
        if m.author_kind == "oracle" and role == "owner"
        else None,
    )


async def messages_out(
    db: AsyncSession, rows: list[DiscussionMessage], principal: "Principal | None" = None
) -> list[DiscussionMessageOut]:
    ids = {m.author_id for m in rows if m.author_id} | {u for m in rows for u in m.mentions}
    users = await users_by_id(db, ids)
    role = principal.role if principal is not None else None
    return [message_out(m, users, role) for m in rows]


async def list_messages(
    db: AsyncSession, d: Discussion, before: uuid.UUID | None, limit: int
) -> tuple[list[DiscussionMessage], bool]:
    """A page of the thread, oldest first within the page; ``before``: older than it."""
    stmt = select(DiscussionMessage).where(DiscussionMessage.discussion_id == d.id)
    if before is not None:
        pivot = await db.get(DiscussionMessage, before)
        if pivot is None or pivot.discussion_id != d.id:
            raise DiscussionError(404, "Message not found")
        stmt = stmt.where(
            or_(
                DiscussionMessage.created_at < pivot.created_at,
                (DiscussionMessage.created_at == pivot.created_at)
                & (DiscussionMessage.id < pivot.id),
            )
        )
    stmt = stmt.order_by(DiscussionMessage.created_at.desc(), DiscussionMessage.id.desc())
    rows = list(await db.scalars(stmt.limit(limit + 1)))
    return list(reversed(rows[:limit])), len(rows) > limit


async def list_changes(
    db: AsyncSession, d: Discussion, status: str | None
) -> list[DiscussionChangeOut]:
    stmt = select(DiscussionChange).where(DiscussionChange.discussion_id == d.id)
    if status:
        stmt = stmt.where(DiscussionChange.status == status)
    rows = await db.scalars(stmt.order_by(DiscussionChange.created_at, DiscussionChange.id))
    return [
        DiscussionChangeOut(
            id=c.id,
            kind=c.kind,
            label=kinds.label(c.kind, c.edited_payload or c.payload),
            target=c.target,
            payload=c.payload,
            edited_payload=c.edited_payload,
            rationale=c.rationale,
            proposed_by_kind=c.proposed_by_kind,  # type: ignore[arg-type]
            proposed_by=c.proposed_by,
            suggested_by=c.suggested_by,
            status=c.status,  # type: ignore[arg-type]
            created_at=c.created_at,
            lock_version=c.lock_version,
        )
        for c in rows
    ]


# --- writing ------------------------------------------------------------------------------


def _person(principal: "Principal") -> uuid.UUID:
    if principal.user_id is None:
        raise DiscussionError(403, "Only a person can write in a discussion")
    return principal.user_id


def _check_write(d: Discussion, seat: access.Seat) -> None:
    if not has_role(seat.role, "commenter"):
        raise DiscussionError(403, VIEWERS_READ)
    if d.status == "closed":
        raise DiscussionError(409, CLOSED)


def _check_body(body: str) -> str:
    if len(body) > MAX_BODY:
        raise DiscussionError(422, BODY_TOO_LONG)
    if not body.strip():
        raise DiscussionError(422, "A message needs some text")
    return body


async def _record(
    db: AsyncSession, principal: "Principal", action: str, d: Discussion, **data: Any
) -> None:
    await audit.record(db, principal, f"discussion.{action}", ENTITY, d.id, data)


async def _bring_in(
    db: AsyncSession,
    principal: "Principal",
    d: Discussion,
    parts: dict[uuid.UUID, DiscussionParticipant],
    seat: access.Seat,
    user_ids: list[uuid.UUID],
    via: str,
) -> list[uuid.UUID]:
    """Add the people not in it yet, as the seat allows; the ones added."""
    await members(db, user_ids)
    new = [u for u in dict.fromkeys(user_ids) if u not in _active(parts)]
    if not new:
        return []
    if seat.author_only:
        raise DiscussionError(422, SHARE_TO_ADD)
    if not access.can_add(seat):
        if d.visibility == "private":
            raise DiscussionError(422, STARTER_ADDS)
        raise DiscussionError(403, VIEWERS_READ)
    for u in new:
        _add(db, d, parts, u, via, principal.user_id)
        await _record(db, principal, "participant_add", d, user_id=str(u), via=via)
    return new


async def _post(
    db: AsyncSession,
    principal: "Principal",
    d: Discussion,
    parts: dict[uuid.UUID, DiscussionParticipant],
    seat: access.Seat,
    body: DiscussionMessageIn,
    via: str,
) -> DiscussionMessage:
    me = _person(principal)
    text = _check_body(body.body)
    mentions = list(dict.fromkeys(body.mentions))
    await _bring_in(db, principal, d, parts, seat, mentions, "mention")
    if body.reply_to is not None:
        parent = await db.get(DiscussionMessage, body.reply_to)
        if parent is None or parent.discussion_id != d.id:
            raise DiscussionError(422, "The message replied to is not in this discussion")
    if d.visibility == "open" and _add(db, d, parts, me, "posted", me):
        await _record(db, principal, "participant_add", d, user_id=str(me), via="posted")
    message = DiscussionMessage(
        created_at=datetime.now(UTC),
        discussion_id=d.id,
        author_kind="person",
        author_id=me,
        via=via,
        body=text,
        mentions=mentions,
        mentions_oracle=body.mention_oracle,
        reply_to=body.reply_to,
    )
    db.add(message)
    await db.flush()
    await _touch_thread(db, d, message.created_at)
    await _record(
        db, principal, "message_post", d,
        message_id=str(message.id), length=len(text), mentions=len(mentions),
        mentions_oracle=body.mention_oracle,
    )  # fmt: skip
    return message


def _via(principal: "Principal") -> str:
    return "mcp" if principal.grant_id is not None else "web"


async def start(
    db: AsyncSession, principal: "Principal", body: DiscussionCreate
) -> tuple[Discussion, DiscussionMessage | None]:
    """The discussion, and its first message when ``body`` has one."""
    await recheck_caller(db, principal, "commenter")
    me = _person(principal)
    subject = parse_subject(body.subject_kind, body.subject)
    found = await resolve_subject(db, principal, body.subject_kind, subject)
    author_only = found.finding_author is not None
    visibility = "private" if author_only else body.visibility
    picked = list(dict.fromkeys(u for u in body.participants if u != me))
    await members(db, picked)
    if author_only and (picked or (body.message and body.message.mentions)):
        raise DiscussionError(422, SHARE_TO_ADD)
    title = (body.title or "").strip()
    if not title:
        d_probe = Discussion(subject_kind=body.subject_kind, subject=subject)
        title = (await Labels(db).of(d_probe))[0][:MAX_TITLE]
    d = Discussion(
        subject_kind=body.subject_kind,
        subject=subject,
        subject_key=found.key,
        document_id=found.document_id,
        run_id=found.run_id,
        intake_id=found.intake_id,
        title=title,
        visibility=visibility,
        author_only=author_only,
        started_by=me,
        summary_shared=visibility == "open",
    )
    db.add(d)
    await db.flush()
    parts: dict[uuid.UUID, DiscussionParticipant] = {}
    _add(db, d, parts, me, "started", me)
    via = "added" if visibility == "private" else "mention"
    for u in picked:
        _add(db, d, parts, u, via, me)
    await _record(
        db, principal, "start", d,
        subject_kind=d.subject_kind, subject_key=d.subject_key, visibility=visibility,
        participants=len(picked), author_only=author_only,
    )  # fmt: skip
    for u in picked:
        await _record(db, principal, "participant_add", d, user_id=str(u), via=via)
    first = None
    if body.message is not None:
        seat = await _seat(db, principal, d, parts)
        first = await _post(db, principal, d, parts, seat, body.message, _via(principal))
    await db.flush()
    return d, first


async def post_message(
    db: AsyncSession, principal: "Principal", discussion_id: uuid.UUID, body: DiscussionMessageIn
) -> DiscussionMessage:
    await recheck_caller(db, principal, "viewer")
    d, parts, seat = await readable(db, principal, discussion_id, lock=True)
    _check_write(d, seat)
    message = await _post(db, principal, d, parts, seat, body, _via(principal))
    await flush_or_conflict(db)
    return message


async def _own_message(
    db: AsyncSession, principal: "Principal", discussion_id: uuid.UUID, message_id: uuid.UUID
) -> tuple[Discussion, DiscussionMessage]:
    await recheck_caller(db, principal, "viewer")
    d, _parts, seat = await readable(db, principal, discussion_id)
    message = await db.get(DiscussionMessage, message_id)
    if message is None or message.discussion_id != d.id or message.deleted_at is not None:
        raise DiscussionError(404, "Message not found")
    _check_write(d, seat)
    if message.author_kind != "person" or message.author_id != principal.user_id:
        raise DiscussionError(403, "Only its author can change a message")
    return d, message


async def edit_message(
    db: AsyncSession,
    principal: "Principal",
    discussion_id: uuid.UUID,
    message_id: uuid.UUID,
    body: str,
) -> DiscussionMessage:
    d, message = await _own_message(db, principal, discussion_id, message_id)
    message.body = _check_body(body)
    message.edited_at = datetime.now(UTC)
    await _record(db, principal, "message_edit", d, message_id=str(message.id), length=len(body))
    await db.flush()
    return message


async def delete_message(
    db: AsyncSession, principal: "Principal", discussion_id: uuid.UUID, message_id: uuid.UUID
) -> None:
    d, message = await _own_message(db, principal, discussion_id, message_id)
    message.body = ""
    message.deleted_at = datetime.now(UTC)
    await _record(db, principal, "message_delete", d, message_id=str(message.id))
    await db.flush()


async def _touch_thread(db: AsyncSession, d: Discussion, at: datetime) -> None:
    """Record the last activity without a new ``lock_version``: a message is not an edit
    of the discussion, so a rename or a Make open loaded before it still applies (Make
    open then answers with the new counts, not a stale version)."""
    await db.execute(
        sql_update(Discussion)
        .where(Discussion.id == d.id)
        .values(last_message_at=at)
        .execution_options(synchronize_session=False)
    )
    set_committed_value(d, "last_message_at", at)


async def _system_line(db: AsyncSession, d: Discussion, body: str) -> None:
    line = DiscussionMessage(
        created_at=datetime.now(UTC), discussion_id=d.id, author_kind="system", body=body
    )
    db.add(line)
    await db.flush()
    d.last_message_at = line.created_at


async def update(
    db: AsyncSession, principal: "Principal", discussion_id: uuid.UUID, body: DiscussionPatch
) -> Discussion:
    await recheck_caller(db, principal, "viewer")
    d, parts, seat = await readable(db, principal, discussion_id, lock=True)
    expect_version(d, body.lock_version)
    if principal.user_id is None:
        raise DiscussionError(403, "Only a person can change a discussion")
    sent = body.model_fields_set
    manages = {"title", "summary", "summary_status", "summary_shared"} & sent
    if body.status is not None and body.status != d.status:
        if not access.can_close(seat):
            raise DiscussionError(403, "Only the starter or an approver can close or reopen it")
        d.status = body.status
        d.closed_by = principal.user_id if body.status == "closed" else None
        d.closed_at = datetime.now(UTC) if body.status == "closed" else None
        await _record(db, principal, "close" if body.status == "closed" else "reopen", d)
        if body.status == "closed":
            from oracle.discussions import summary

            await summary.queue(db, d)
    if (manages or body.visibility not in (None, d.visibility)) and d.status == "closed":
        raise DiscussionError(409, CLOSED)
    if body.visibility == "open" and d.visibility == "private":
        await _make_open(db, principal, d, seat, body.exposes)
    elif body.visibility == "private" and d.visibility == "open":
        await _make_private(db, principal, d, parts, seat)
    if manages and not access.can_manage(seat):
        raise DiscussionError(403, STARTER_ONLY)
    if "title" in sent and body.title is not None:
        d.title = body.title.strip()[:MAX_TITLE] or d.title
        await _record(db, principal, "rename", d, length=len(d.title))
    if "summary" in sent or body.summary_status is not None:
        summary = (body.summary or "").strip() if "summary" in sent else d.summary
        if summary and len(summary) > MAX_SUMMARY:
            raise DiscussionError(422, SUMMARY_TOO_LONG)
        d.summary = summary or None
        d.summary_status = "confirmed" if d.summary else "none"
        d.summary_by, d.summary_at = principal.user_id, datetime.now(UTC)
        await _record(
            db, principal, "summary", d, length=len(d.summary or ""), status=d.summary_status
        )
    if body.summary_shared is not None and body.summary_shared != d.summary_shared:
        d.summary_shared = body.summary_shared
        await _record(db, principal, "summary_share", d, shared=d.summary_shared)
    await flush_or_conflict(db)
    return d


async def _make_open(
    db: AsyncSession,
    principal: "Principal",
    d: Discussion,
    seat: access.Seat,
    exposes: DiscussionExposure | None,
) -> None:
    """G1 "Open later?" (owner, 2026-10-21): the starter alone, after a warning naming
    what it exposes; everyone in it stays in it."""
    if not seat.starter:
        raise DiscussionError(403, STARTER_OPENS)
    if seat.author_only:
        raise DiscussionError(422, SHARE_FIRST)
    if d.origin == "panel":
        raise DiscussionError(422, PANEL_CHAT)
    messages, people = await exposure(db, d)
    if exposes is None or (exposes.messages, exposes.people) != (messages, people):
        raise ExposureMismatch(messages, people)
    d.visibility = "open"
    users = await users_by_id(db, {principal.user_id}) if principal.user_id else {}
    starter = users.get(principal.user_id)  # type: ignore[arg-type]
    name = display_name(starter.email) if starter else "The starter"
    today = datetime.now(UTC)
    await _system_line(db, d, f"{name} made this discussion open on {today:%b} {today.day}")
    await _record(
        db, principal, "visibility", d, **{"from": "private", "to": "open"},
        messages=messages, people=people,
    )  # fmt: skip


async def _make_private(
    db: AsyncSession,
    principal: "Principal",
    d: Discussion,
    parts: dict[uuid.UUID, DiscussionParticipant],
    seat: access.Seat,
) -> None:
    """The starter makes an open discussion private: everyone who has written or been
    mentioned in it stays; followers who did neither leave it."""
    if not seat.starter:
        raise DiscussionError(403, "Only the starter can make a discussion private")
    writers = set(
        await db.scalars(
            select(DiscussionMessage.author_id).where(
                DiscussionMessage.discussion_id == d.id,
                DiscussionMessage.author_id.is_not(None),
            )
        )
    )
    now = datetime.now(UTC)
    for user_id, p in _active(parts).items():
        if p.added_via == "followed" and user_id not in writers:
            p.left_at, p.removed_by = now, principal.user_id
            await _record(db, principal, "participant_remove", d, user_id=str(user_id))
    messages, people = await exposure(db, d)
    d.visibility = "private"
    d.summary_shared = False
    await _record(
        db, principal, "visibility", d, **{"from": "open", "to": "private"},
        messages=messages, people=people,
    )  # fmt: skip


async def add_participants(
    db: AsyncSession, principal: "Principal", discussion_id: uuid.UUID, user_ids: list[uuid.UUID]
) -> list[DiscussionParticipantOut]:
    """On a private discussion only the starter adds people. On an open one any reader
    follows it (adds themselves) and commenters and up add others."""
    await recheck_caller(db, principal, "viewer")
    me = _person(principal)
    d, parts, seat = await readable(db, principal, discussion_id, lock=True)
    if d.status == "closed":
        raise DiscussionError(409, CLOSED)
    if user_ids == [me] and access.can_follow(seat):
        if _add(db, d, parts, me, "followed", me):
            await _record(db, principal, "participant_add", d, user_id=str(me), via="followed")
    else:
        others = [u for u in user_ids if u != me]
        await _bring_in(db, principal, d, parts, seat, others, "added")
    await flush_or_conflict(db)
    return (await discussion_out(db, principal, d)).participants


async def remove_participant(
    db: AsyncSession, principal: "Principal", discussion_id: uuid.UUID, user_id: uuid.UUID
) -> None:
    """Anyone leaves (or unfollows); the starter removes others from a private one. The
    starter cannot leave a private discussion while it is open."""
    await recheck_caller(db, principal, "viewer")
    me = _person(principal)
    d, parts, seat = await readable(db, principal, discussion_id, lock=True)
    row = _active(parts).get(user_id)
    if user_id == me:
        if d.visibility == "private" and seat.starter and d.status == "open":
            raise DiscussionError(
                422, "The starter cannot leave a private discussion while it is open"
            )
    elif not (d.visibility == "private" and seat.starter):
        raise DiscussionError(403, "Only the starter can remove people from a private discussion")
    if row is None:
        return
    row.left_at, row.removed_by = datetime.now(UTC), me
    await _record(db, principal, "participant_remove", d, user_id=str(user_id))
    await flush_or_conflict(db)


async def mark_read(
    db: AsyncSession, principal: "Principal", discussion_id: uuid.UUID, message_id: uuid.UUID
) -> None:
    d, parts, _seat_ = await readable(db, principal, discussion_id)
    message = await db.get(DiscussionMessage, message_id)
    if message is None or message.discussion_id != d.id:
        raise DiscussionError(404, "Message not found")
    row = _active(parts).get(principal.user_id) if principal.user_id else None
    if row is not None and (row.last_read_at is None or row.last_read_at < message.created_at):
        row.last_read_at = message.created_at
        await db.flush()


async def hand_over(db: AsyncSession, principal: "Principal", user_id: uuid.UUID) -> None:
    """A starter was removed from the company (C2): each of their discussions passes to
    its earliest-added remaining participant with the approver role or above (audited).
    With none, nobody can add people."""
    started = list(await db.scalars(select(Discussion).where(Discussion.started_by == user_id)))
    for d in started:
        parts = _active(await _participants(db, d))
        users = await users_by_id(db, set(parts))
        heir = next(
            (
                u
                for u, p in parts.items()
                if u != user_id
                and u in users
                and users[u].disabled_at is None
                and has_role(users[u].role, "approver")
            ),
            None,
        )
        if heir is None:
            continue
        d.started_by = heir
        await audit.record(
            db, principal, "discussion.starter", ENTITY, d.id,
            {"from": str(user_id), "to": str(heir)},
        )  # fmt: skip
    await db.flush()
