"""Which decisions still stand, for every reader that feeds decisions to drafting.

Production finding (Nov 3): a decision taken in a review meeting of a test roadmap, since
put in Trash, was cited by later PRD and roadmap drafts as a standing company decision.
A decision that is reversed, withdrawn or superseded no longer stands, and neither does
one about something in Trash: its subject document (a section or version of it), a
roadmap item's roadmap, or the document its meeting reviewed. Readers keep the standing
ones (:func:`split`) and say which were left out (:func:`left_out_line`).
"""

import uuid
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.decisions.models import Decision

LAPSED = ("reversed", "withdrawn", "superseded")
_WHY = {
    "reversed": "reversed",
    "withdrawn": "withdrawn",
    "superseded": "replaced by a later decision",
}


def trash_label(kind: str) -> str:
    """Company > Decisions' mark: "Made about a roadmap now in Trash"."""
    return f"Made about {'a roadmap' if kind == 'roadmap' else 'a document'} now in Trash"


@dataclass
class LeftOut:
    decision: Decision
    why: str

    @property
    def line(self) -> str:
        return f"D-{self.decision.number} {self.decision.title} ({self.why})"


def _subject_ids(d: Decision, kinds: tuple[str, ...]) -> set[uuid.UUID]:
    out: set[uuid.UUID] = set()
    for s in d.subjects or []:
        if s.get("kind") in kinds:
            try:
                out.add(uuid.UUID(str(s.get("id"))))
            except ValueError:
                continue
    return out


async def trashed_about(db: AsyncSession, ds: list[Decision]) -> dict[uuid.UUID, str]:
    """Each decision about something in Trash: its id -> the trashed document's kind."""
    from oracle.docs.models import Document, DocumentVersion
    from oracle.roadmap.models import RoadmapItem
    from oracle.simple.models import SimpleMeeting, SimpleMeetingDecision
    from oracle.trash.filter import INCLUDE_TRASHED

    if not ds:
        return {}
    every = {INCLUDE_TRASHED: True}
    docs: dict[uuid.UUID, set[uuid.UUID]] = {
        d.id: _subject_ids(d, ("document", "section")) for d in ds
    }
    versions = {d.id: _subject_ids(d, ("document_version",)) for d in ds}
    items = {d.id: _subject_ids(d, ("roadmap_item",)) for d in ds}
    if any(versions.values()):
        found = dict(
            (
                await db.execute(
                    select(DocumentVersion.id, DocumentVersion.document_id)
                    .where(DocumentVersion.id.in_(set().union(*versions.values())))
                    .execution_options(**every)
                )
            ).all()
        )
        for i, vs in versions.items():
            docs[i] |= {found[v] for v in vs if v in found}
    if any(items.values()):
        found = dict(
            (
                await db.execute(
                    select(RoadmapItem.id, RoadmapItem.roadmap_document_id)
                    .where(RoadmapItem.id.in_(set().union(*items.values())))
                    .execution_options(**every)
                )
            ).all()
        )
        for i, its in items.items():
            docs[i] |= {found[t] for t in its if found.get(t)}
    for decision_id, document_id in (
        await db.execute(
            select(SimpleMeetingDecision.decision_id, SimpleMeeting.prd_document_id)
            .join(SimpleMeeting, SimpleMeeting.id == SimpleMeetingDecision.meeting_id)
            .where(SimpleMeetingDecision.decision_id.in_([d.id for d in ds]))
            .execution_options(**every)
        )
    ).all():
        docs[decision_id].add(document_id)
    wanted = set().union(*docs.values())
    if not wanted:
        return {}
    trashed = dict(
        (
            await db.execute(
                select(Document.id, Document.kind)
                .where(Document.id.in_(wanted), Document.deleted_at.is_not(None))
                .execution_options(**every)
            )
        ).all()
    )
    out: dict[uuid.UUID, str] = {}
    for decision_id, ids in docs.items():
        kinds = [trashed[i] for i in ids if i in trashed]
        if kinds:
            out[decision_id] = "roadmap" if "roadmap" in kinds else kinds[0]
    return out


async def split(db: AsyncSession, ds: list[Decision]) -> tuple[list[Decision], list[LeftOut]]:
    """The decisions that stand, in their order, and the ones left out with why."""
    trashed = await trashed_about(db, [d for d in ds if d.status not in LAPSED])
    kept: list[Decision] = []
    left: list[LeftOut] = []
    for d in ds:
        if d.status in LAPSED:
            left.append(LeftOut(d, _WHY[d.status]))
        elif d.id in trashed:
            kind = "roadmap" if trashed[d.id] == "roadmap" else "document"
            left.append(LeftOut(d, f"about a {kind} now in Trash"))
        else:
            kept.append(d)
    return kept, left


def left_out_line(left: list[LeftOut]) -> str | None:
    """What a sources list says when a decision was left out."""
    if not left:
        return None
    return "Left out, no longer standing: " + "; ".join(x.line for x in left) + "."


def sources_entry(left: list[LeftOut]) -> dict[str, Any] | None:
    """The same, as one entry of a draft's sources list."""
    line = left_out_line(left)
    if line is None:
        return None
    return {"kind": "left_out", "title": line, "decision_ids": [str(x.decision.id) for x in left]}


async def note_reversed(db: AsyncSession, d: Decision, note: str) -> int:
    """The owner reversed ``d``: every open draft that cited it (a draft of a document it
    is about, or of the document its meeting reviewed) carries a note on its next draft.
    Returns how many drafts got the note."""
    from oracle.docs.models import DocumentVersion
    from oracle.roadmap.models import RoadmapItem
    from oracle.simple.drafts import OPEN
    from oracle.simple.models import SimpleDraft, SimpleMeeting, SimpleMeetingDecision

    docs = _subject_ids(d, ("document", "section"))
    versions = _subject_ids(d, ("document_version",))
    if versions:
        docs |= set(
            await db.scalars(
                select(DocumentVersion.document_id).where(DocumentVersion.id.in_(versions))
            )
        )
    items = _subject_ids(d, ("roadmap_item",))
    if items:
        docs |= {
            i
            for i in await db.scalars(
                select(RoadmapItem.roadmap_document_id).where(RoadmapItem.id.in_(items))
            )
            if i
        }
    docs |= set(
        await db.scalars(
            select(SimpleMeeting.prd_document_id)
            .join(SimpleMeetingDecision, SimpleMeetingDecision.meeting_id == SimpleMeeting.id)
            .where(SimpleMeetingDecision.decision_id == d.id)
        )
    )
    if not docs:
        return 0
    text = f"D-{d.number} {d.title} was reversed: {note}".strip()
    n = 0
    for draft in await db.scalars(
        select(SimpleDraft).where(SimpleDraft.document_id.in_(docs), SimpleDraft.status.in_(OPEN))
    ):
        notes = [x for x in draft.decision_notes or [] if x.get("decision_id") != str(d.id)]
        notes.append({"decision_id": str(d.id), "text": text})
        draft.decision_notes = notes
        n += 1
    return n
