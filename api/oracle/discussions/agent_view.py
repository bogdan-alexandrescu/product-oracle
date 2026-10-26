"""G5 Agents read discussions: what a run's agents get from the discussions about the run.

c5: a short summary plus the typed changes, with a link, never the transcript. Which
discussions: those whose subject is in the run (its checkpoints, every attempt), those on
the run's intake, and, for a feedback loop, those on its document with a staged
next-draft change.

- An **open** discussion gives its title, its latest summary (draft or confirmed) and the
  changes staged from it.
- A **private** one gives its staged changes with the stager's reason, and its summary only
  when the starter shared it (G5 "Agent view", 2026-10-21). A discussion made open later
  reads as open: the view never reads the history of its visibility.
- A discussion on its author's own private finding (G1 §3.4.3) is left out, uncounted.
- The agents' view never uses the run creator's participation (S6 follow-up 3). People
  read the same shape, with the title and summary of a private discussion they are in.
"""

import json
import uuid
from typing import TYPE_CHECKING, Any

from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.discussions import access, kinds
from oracle.discussions.models import Discussion, DiscussionChange, DiscussionParticipant
from oracle.discussions.schemas import RunDiscussion, RunDiscussionsOut
from oracle.runs.models import Checkpoint, CheckpointAction, Run
from oracle.staging import mapping
from oracle.staging.models import NextDraftChange

if TYPE_CHECKING:
    from oracle.auth.deps import Principal

MAX_DISCUSSIONS = 50
MAX_CHARS = 40_000
# The subject's ids the run already knows; the rest of the subject says what it is about.
_RUN_IDS = ("run_id", "checkpoint_id")
# What acting created when the change was staged: shown as a staged change, not as done.
_STAGED_REFS = ("checkpoint_action", "next_draft_change")


class RunNotFound(Exception):
    pass


def entry(
    d: Discussion,
    *,
    reads: bool,
    subject_label: str | None,
    link: str,
    staged: list[dict[str, Any]],
    decided: list[dict[str, Any]],
) -> dict[str, Any]:
    """One discussion's row. ``reads``: the reader is a person in it (never for a run)."""
    shown = d.visibility == "open" or reads
    summary, status, withheld = None, None, False
    if shown or d.summary_shared:
        summary = d.summary if d.summary_status != "none" else None
        status = d.summary_status
    else:
        withheld = True
    subject = {k: v for k, v in (d.subject or {}).items() if k not in _RUN_IDS}
    return {
        "id": str(d.id),
        "visibility": d.visibility,
        "title": d.title if shown else None,
        "subject_label": subject_label if shown else None,
        "subject": {"kind": d.subject_kind, **subject},
        "link": link,
        "summary": summary,
        "summary_status": status,
        "summary_withheld": withheld,
        "staged_changes": staged,
        "decided": decided,
    }


def cap(entries: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], int]:
    """At most ``MAX_DISCUSSIONS`` rows and ``MAX_CHARS`` characters, in order; and how
    many were left out."""
    kept: list[dict[str, Any]] = []
    used = 2
    for e in entries[:MAX_DISCUSSIONS]:
        size = len(json.dumps(e, default=str)) + 2
        if used + size > MAX_CHARS:
            break
        kept.append(e)
        used += size
    return kept, len(entries) - len(kept)


def _link(run_id: uuid.UUID, discussion_id: uuid.UUID) -> str:
    from oracle.export.render import app_url

    return app_url(f"/runs/{run_id}?discussion={discussion_id}")


def _next_draft_rows(run: Run) -> Any:
    """For a feedback loop, which staged next-draft rows are its agents': every staged row
    on its document, or, for a run Build next draft started (D12 knobs), only the ones it
    was sent (none when its knobs name none)."""
    knobs = run.knobs or {}
    rows = NextDraftChange.status == "staged"
    if any(k in knobs for k in ("feedback_ids", "suggestion_ids", "next_draft_change_ids")):
        sent = [uuid.UUID(str(i)) for i in knobs.get("next_draft_change_ids") or []]
        rows = and_(rows, NextDraftChange.id.in_(sent))
    return and_(NextDraftChange.document_id == run.document_id, rows)


async def _discussions(db: AsyncSession, run: Run) -> list[Discussion]:
    about = [Discussion.run_id == run.id]
    intake_id = (run.knobs or {}).get("intake_id")
    if intake_id:
        about.append(
            and_(
                Discussion.intake_id == uuid.UUID(str(intake_id)),
                Discussion.subject_kind.in_(("intake", "gap")),
            )
        )
    if run.flow == "feedback_loop" and run.document_id is not None:
        staged = select(NextDraftChange.discussion_id).where(
            _next_draft_rows(run), NextDraftChange.discussion_id.is_not(None)
        )
        about.append(
            and_(
                Discussion.document_id == run.document_id,
                Discussion.subject_kind.in_(("document", "section")),
                Discussion.id.in_(staged),
            )
        )
    activity = func.coalesce(Discussion.last_message_at, Discussion.created_at)
    rows = await db.scalars(
        select(Discussion).where(or_(*about)).order_by(activity.desc(), Discussion.id)
    )
    out = []
    for d in rows:
        if d.subject_kind == "gap":
            found = await access.hidden_finding(db, uuid.UUID(d.subject["gap_id"]))
            if found is not None and found[1]:
                continue
        out.append(d)
    return out


async def _staged(
    db: AsyncSession, run: Run, ids: list[uuid.UUID]
) -> dict[uuid.UUID, list[dict[str, Any]]]:
    by: dict[uuid.UUID, list[dict[str, Any]]] = {i: [] for i in ids}
    rows = await db.execute(
        select(CheckpointAction, Checkpoint)
        .join(Checkpoint, Checkpoint.id == CheckpointAction.checkpoint_id)
        .where(
            Checkpoint.run_id == run.id,
            CheckpointAction.discussion_id.in_(ids),
            CheckpointAction.origin == "discussion",
            CheckpointAction.state == "staged",
        )
        .order_by(CheckpointAction.created_at, CheckpointAction.id)
    )
    for a, cp in rows:
        kind, payload = mapping.to_change(a.item_key, a.kind, a.field, a.value)
        attempt = (cp.payload or {}).get("attempt")
        by[a.discussion_id].append(  # type: ignore[index]
            {
                "id": str(a.id),
                "kind": kind or a.kind,
                "label": mapping.label(kind, payload, a.item_key, d8_kind=a.kind, field=a.field),
                "item_key": a.item_key,
                "payload": payload
                or {"item_key": a.item_key, "kind": a.kind, "field": a.field, "value": a.value},
                "reason": a.note,
                "status": "staged" if cp.status == "pending" else "sent",
                "target": {
                    "kind": "checkpoint",
                    "checkpoint_kind": cp.kind,
                    "attempt": attempt if isinstance(attempt, int) else 1,
                },
            }
        )
    if run.flow == "feedback_loop" and run.document_id is not None:
        drafts = await db.scalars(
            select(NextDraftChange)
            .where(_next_draft_rows(run), NextDraftChange.discussion_id.in_(ids))
            .order_by(NextDraftChange.created_at, NextDraftChange.id)
        )
        for r in drafts:
            payload = {"section_key": r.section_key, "instruction": r.instruction}
            if r.text:
                payload["text"] = r.text
            by[r.discussion_id].append(  # type: ignore[index]
                {
                    "id": str(r.id),
                    "kind": "section_edit",
                    "label": mapping.label("section_edit", payload, None),
                    "section_key": r.section_key,
                    "payload": payload,
                    "reason": r.reason,
                    "status": "staged",
                    "target": {"kind": "next_draft", "document_id": str(r.document_id)},
                }
            )
    return by


async def _decided(db: AsyncSession, ids: list[uuid.UUID]) -> dict[uuid.UUID, list[dict]]:
    by: dict[uuid.UUID, list[dict[str, Any]]] = {i: [] for i in ids}
    rows = await db.scalars(
        select(DiscussionChange)
        .where(DiscussionChange.discussion_id.in_(ids), DiscussionChange.status == "done")
        .order_by(DiscussionChange.created_at, DiscussionChange.id)
    )
    for c in rows:
        if (c.result_ref or {}).get("kind") in _STAGED_REFS:
            continue
        try:
            label = kinds.label(c.kind, c.edited_payload or c.payload)
        except (KeyError, TypeError, AttributeError):
            label = c.kind.replace("_", " ").capitalize()
        by[c.discussion_id].append({"kind": c.kind, "label": label})
    return by


async def build(db: AsyncSession, run: Run, reader: uuid.UUID | None) -> list[dict[str, Any]]:
    """Every discussion about the run, newest activity first. ``reader``: the person
    reading (None: the run's agents, who never read as a participant)."""
    from oracle.discussions.service import Labels

    ds = await _discussions(db, run)
    ids = [d.id for d in ds]
    if not ids:
        return []
    member: set[uuid.UUID] = set()
    if reader is not None:
        member = set(
            await db.scalars(
                select(DiscussionParticipant.discussion_id).where(
                    DiscussionParticipant.discussion_id.in_(ids),
                    DiscussionParticipant.user_id == reader,
                    DiscussionParticipant.left_at.is_(None),
                )
            )
        )
    staged = await _staged(db, run, ids)
    decided = await _decided(db, ids)
    labels = Labels(db)
    out = []
    for d in ds:
        label, _url = await labels.of(d)
        out.append(
            entry(
                d,
                reads=d.id in member,
                subject_label=label,
                link=_link(run.id, d.id),
                staged=staged[d.id],
                decided=decided[d.id],
            )
        )
    return out


async def run_discussions(
    db: AsyncSession, principal: "Principal", run_id: uuid.UUID
) -> RunDiscussionsOut:
    """``GET /v1/runs/{run_id}/discussions``: a run's call reads its own run only."""
    if principal.is_run and principal.run_id != run_id:
        raise RunNotFound(run_id)
    run = await db.get(Run, run_id)
    if run is None:
        raise RunNotFound(run_id)
    reader = None if principal.is_run else principal.user_id
    entries = await build(db, run, reader)
    if reader is None:
        entries = await for_member_run(db, run, entries)
    kept, omitted = cap(entries)
    return RunDiscussionsOut(
        run_id=run.id,
        discussions=[RunDiscussion.model_validate(e) for e in kept],
        truncated=omitted > 0,
        omitted=omitted,
    )


async def for_prompt(db: AsyncSession, run: Run) -> list[dict[str, Any]]:
    """The agents' view for the step prompt (``PromptContext.discussions``)."""
    kept, _omitted = cap(await for_member_run(db, run, await build(db, run, None)))
    return kept


async def for_member_run(
    db: AsyncSession, run: Run, entries: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """#562 review: the agents of a run that reads as a member (oracle.runs.service
    ``reads_as_member``) get no discussion whose title, summary or staged change names
    something a commenter may not see (oracle.docs.visibility ``Hidden.names``)."""
    from oracle.runs.service import member_hidden

    hidden = await member_hidden(db, run)
    if hidden is None:
        return entries
    return [e for e in entries if not hidden.names_in(e)]
