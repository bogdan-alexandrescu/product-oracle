"""G3 Outcome extraction: Oracle's reply ends in typed changes, and people act on them.

- **Extraction.** After its reply text Oracle writes ``<<<CHANGES>>>`` and one JSON object
  (``discussion_reply.v2``). The stream never shows the delimiter or what follows it
  (:class:`HoldBack`); :func:`extract` checks each entry (available and allowed kind, a
  payload its model reads, a target that exists and is not locked, a basis the reply's
  context held), drops the rest with an audit event that carries no text, and writes the
  others as ``proposed`` rows. A new Oracle proposal for the same kind and target
  supersedes Oracle's open one; a person's suggestion is never superseded.
- **Actions** (3.2): commenters suggest, approvers stage (c6), viewers read. Every write
  re-reads the caller and the discussion and takes ``lock_version``. Staging lands through
  G4 (:mod:`oracle.staging.service`), proposals through the baseline's ``submit_proposal``,
  a conflict pick through its resolution, an answer through the answers service, a date
  basis through F3's ``record_basis`` with the rights ``leads.date_rights`` gives.
- **Rules 4 and 5** (S6): on the author's own private finding only Dismiss, Edit and
  Withdraw work; a finding made private supersedes the open changes resting on it.
"""

import dataclasses
import uuid
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.authz import has_role, recheck_caller
from oracle.discussions import access, kinds
from oracle.discussions.context import Context
from oracle.discussions.models import MAX_RATIONALE, Discussion, DiscussionChange, DiscussionMessage
from oracle.discussions.schemas import (
    ChangeAction,
    ChangeCan,
    DiscussionChangeOut,
    DiscussionPerson,
)
from oracle.jobs import prompting
from oracle.members.names import display_name

if TYPE_CHECKING:
    from oracle.auth.deps import Principal

DELIMITER = "<<<CHANGES>>>"
HOLD = 16
MAX_PER_REPLY = 5
OPEN = ("proposed", "suggested")

APPROVERS_STAGE = "Approvers stage changes. You can suggest it."
APPROVERS_ACT = "Approvers {verb} this change."
SHARE_FIRST = "Share the finding first to use this change"
DECIDED = "This checkpoint was decided"
PUSHED_BACK = "Oracle pushed back on this. Give a reason to stage it anyway."
WRITE_REASON = "Write the reason everyone will see"
CHANGED = "This change changed since you loaded it; look again"
NOT_OPEN = "This change was already handled"
MADE_PRIVATE = "The finding was made private"
LOCKED = "Section {section} is approved and locked"
RECORDERS = "Engineering leads and approvers record date bases"
NOT_FOUND = "Change not found"


# --- the stream's hold-back -------------------------------------------------------------------


class HoldBack:
    """What of a streamed reply may be shown: everything before the delimiter, holding
    back the last 16 characters until they cannot be its start. ``tail``: what followed
    the delimiter, once it came."""

    def __init__(self) -> None:
        self.buf = ""
        self.tail: str | None = None
        self.seen = 0

    def feed(self, text: str) -> str:
        self.seen += len(text)
        if self.tail is not None:
            self.tail += text
            return ""
        self.buf += text
        at = self.buf.find(DELIMITER)
        if at != -1:
            out, self.tail = self.buf[:at], self.buf[at + len(DELIMITER) :]
            self.buf = ""
            return out
        if len(self.buf) <= HOLD:
            return ""
        out, self.buf = self.buf[:-HOLD], self.buf[-HOLD:]
        return out

    def flush(self) -> str:
        out, self.buf = self.buf, ""
        return out


def split_goal_reply(text: str) -> tuple[str, str | None]:
    """A goal discussion's reply, where B6's versions block (a JSON array up to
    ``<<<END>>>``, oracle.baseline.goal_interview) and G3's changes (a JSON object) both
    follow the delimiter: the text with the versions block left in, and G3's changes."""
    at = 0
    while (at := text.find(DELIMITER, at)) != -1:
        after = text[at + len(DELIMITER) :]
        head = after.lstrip().removeprefix("```json").removeprefix("```").lstrip()
        if head.startswith("["):
            at += len(DELIMITER)
            continue
        nxt = after.find(DELIMITER)
        tail, rest = (after, "") if nxt == -1 else (after[:nxt], after[nxt:])
        return text[:at].rstrip() + (f"\n\n{rest}" if rest else ""), tail
    return text, None


# --- what the prompt lists --------------------------------------------------------------------


async def prompt_notes(db: AsyncSession, d: Discussion) -> str:
    """The kinds Oracle may propose on this subject, each with its payload's schema, and the
    discussion's open changes with their ids (so it replaces one instead of repeating it)."""
    import json

    lines = ["Kinds you may propose here (payload JSON schemas):"]
    names = kinds.available_for(d.subject_kind, db)
    for name in names:
        lines.append(f"- {name}: {json.dumps(kinds.schema_of(name), separators=(',', ':'))}")
    if not names:
        lines.append("- none: propose no changes")
    rows = await db.scalars(
        select(DiscussionChange).where(
            DiscussionChange.discussion_id == d.id, DiscussionChange.status.in_(OPEN)
        )
    )
    open_ = [f"- {c.id}: {_label(c)}" for c in rows]
    lines += ["Open changes in this discussion:", *(open_ or ["- none"])]
    return "\n".join(lines)


# --- extraction -------------------------------------------------------------------------------


async def locked_sections(db: AsyncSession, document_id: uuid.UUID) -> set[str]:
    """The sections approved, and so locked, in the document's latest version."""
    from oracle.docs.models import DocumentVersion
    from oracle.review.state import approved_keys

    version = await _latest(db, document_id)
    if version is None:
        return set()
    row = await db.scalar(
        select(DocumentVersion).where(
            DocumentVersion.document_id == document_id, DocumentVersion.number == version
        )
    )
    return await approved_keys(db, document_id, row) if row is not None else set()


async def _latest(db: AsyncSession, document_id: uuid.UUID) -> int | None:
    from oracle.docs.models import DocumentVersion

    return await db.scalar(
        select(DocumentVersion.number)
        .where(DocumentVersion.document_id == document_id)
        .order_by(DocumentVersion.number.desc())
        .limit(1)
    )


async def _section_keys(db: AsyncSession, document_id: uuid.UUID) -> set[str]:
    from oracle.docs.models import DocumentVersion, Section

    number = await _latest(db, document_id)
    rows = await db.scalars(
        select(Section.section_key)
        .join(DocumentVersion, DocumentVersion.id == Section.version_id)
        .where(DocumentVersion.document_id == document_id, DocumentVersion.number == number)
    )
    return set(rows)


async def _heading(db: AsyncSession, document_id: uuid.UUID, key: str) -> str:
    """The section's heading in the document's latest version ("2. Problem")."""
    from oracle.docs.models import DocumentVersion, Section

    heading = await db.scalar(
        select(Section.heading)
        .join(DocumentVersion, DocumentVersion.id == Section.version_id)
        .where(
            DocumentVersion.document_id == document_id,
            DocumentVersion.number == await _latest(db, document_id),
            Section.section_key == key,
        )
    )
    return heading or key


def target_of(d: Discussion, kind: str, payload: dict[str, Any]) -> dict[str, Any]:
    """What a change changes, read from the subject and the payload (never the model's)."""
    s = d.subject or {}
    if kind == "section_edit":
        return {"document_id": str(d.document_id), "section_key": payload["section_key"]}
    if kind.startswith("item_"):
        keep = {k: s[k] for k in ("run_id", "checkpoint_kind", "document_id") if k in s}
        return {**keep, "item_key": payload["item_key"]}
    for key in ("entity_id", "conflict_id", "question_id"):
        if key in payload:
            return {key: str(payload[key])}
    return {}


async def _target_problem(
    db: AsyncSession, d: Discussion, kind: str, payload: dict[str, Any]
) -> str | None:
    """Why the target does not take the change ("target", "locked"), or None."""
    from oracle.baseline.models import Conflict, Entity
    from oracle.v2.models import StakeholderQuestion

    if kind == "section_edit":
        if d.document_id is None:
            return "target"
        if payload["section_key"] not in await _section_keys(db, d.document_id):
            return "target"
        if payload["section_key"] in await locked_sections(db, d.document_id):
            return "locked"
        return None
    if kind.startswith("item_"):
        keys = await _item_keys(db, d)
        return None if keys is None or payload["item_key"] in keys else "target"
    if kind in ("goal_measure", "entity_edit"):
        return None if await db.get(Entity, payload["entity_id"]) else "target"
    if kind == "conflict_pick":
        c = await db.get(Conflict, payload["conflict_id"])
        return None if c is not None and c.status != "resolved" else "target"
    if kind == "answer":
        q = await db.get(StakeholderQuestion, payload["question_id"])
        return None if q is not None and q.status == "open" else "target"
    return None


async def _item_keys(db: AsyncSession, d: Discussion) -> set[str] | None:
    """The items of the subject's checkpoint output; None when they cannot be read (the
    staging write checks them again)."""
    from oracle.runs import actions
    from oracle.runs.models import Checkpoint, Run

    s = d.subject or {}
    if d.subject_kind != "checkpoint_item" or not s.get("checkpoint_id"):
        return None
    cp = await db.get(Checkpoint, uuid.UUID(str(s["checkpoint_id"])))
    run = await db.get(Run, cp.run_id) if cp is not None else None
    if cp is None or run is None:
        return None
    found = await actions._file(db, run, cp) if cp.kind in actions.VOCABULARY else None
    vocab = actions._context(found) if cp.kind in actions.ITEM_FILES else actions._gate_context(cp)
    keys = set(vocab.item_keys or ())
    return (keys | {s.get("item_key")}) if keys else None


def _basis(entry: Any, ctx: Context) -> list[dict[str, str]] | None:
    """The basis as ``[{intake_id, finding_id}]``, or None when it names a finding the
    reply's context did not hold."""
    if not entry:
        return []
    if not isinstance(entry, list):
        return None
    refs = {e["ref"] for e in ctx.entries.values() if e.get("kind") == "finding"}
    out = []
    for fid in entry:
        fid = str(fid)
        hit = next((r for r in refs if r == fid or r.endswith(f":{fid}")), None)
        if hit is None:
            return None
        intake, _, finding = hit.rpartition(":")
        out.append({"intake_id": intake, "finding_id": finding or hit})
    return out


async def _drop(db: AsyncSession, d: Discussion, index: int, kind: Any, reason: str) -> None:
    await audit.record(
        db, audit.ORACLE, "discussion.change_dropped", "discussion", d.id,
        {"reason": reason, "index": index, "kind": kind if kind in kinds.REGISTRY else None},
    )  # fmt: skip


async def extract(
    db: AsyncSession,
    d: Discussion,
    reply: DiscussionMessage | None,
    raw: str,
    ctx: Context,
) -> list[DiscussionChange]:
    """The reply's valid changes as ``proposed`` rows (flushed, not committed)."""
    try:
        found = prompting.parse_answer(raw).get("changes")
    except prompting.AnswerError:
        found = None
    if not isinstance(found, list):
        await _drop(db, d, 0, None, "unreadable")
        return []
    made: list[DiscussionChange] = []
    for i, entry in enumerate(found[:MAX_PER_REPLY]):
        kind = entry.get("kind") if isinstance(entry, dict) else None
        if not isinstance(entry, dict) or kind not in kinds.REGISTRY:
            await _drop(db, d, i, kind, "unavailable")
            continue
        k = kinds.REGISTRY[kind]
        if not k.available(db):
            await _drop(db, d, i, kind, "unavailable")
            continue
        if d.subject_kind not in k.subjects:
            await _drop(db, d, i, kind, "not_allowed")
            continue
        try:
            payload = kinds.validate_payload(kind, entry.get("payload") or {})
        except (ValidationError, TypeError):
            await _drop(db, d, i, kind, "bad_payload")
            continue
        problem = await _target_problem(db, d, kind, payload)
        if problem is not None:
            await _drop(db, d, i, kind, problem)
            continue
        basis = _basis(entry.get("basis"), ctx)
        if basis is None:
            await _drop(db, d, i, kind, "basis")
            continue
        target = target_of(d, kind, payload)
        await _supersede(db, d, kind, target, entry.get("replaces"))
        row = DiscussionChange(
            discussion_id=d.id,
            kind=kind,
            target=target,
            payload=payload,
            rationale=prompting.as_str(entry.get("rationale"), MAX_RATIONALE) or None,
            basis=basis,
            proposed_by_kind="oracle",
            from_message_id=reply.id if reply is not None else None,
            status="proposed",
            pushback=reply.pushback if reply is not None else None,
        )
        db.add(row)
        await db.flush()
        made.append(row)
    for i in range(MAX_PER_REPLY, len(found)):
        await _drop(db, d, i, None, "too_many")
    return made


async def _supersede(
    db: AsyncSession, d: Discussion, kind: str, target: dict[str, Any], replaces: Any
) -> None:
    """Oracle's open proposal it replaces, or of the same kind and target, is superseded;
    a person's suggestion never is."""
    rows = await db.scalars(
        select(DiscussionChange).where(
            DiscussionChange.discussion_id == d.id,
            DiscussionChange.proposed_by_kind == "oracle",
            DiscussionChange.status == "proposed",
        )
    )
    for c in rows:
        if str(c.id) == str(replaces) or (c.kind == kind and c.target == target):
            c.status = "superseded"
            c.decision_note = "Replaced by a later proposal from Oracle"
    await db.flush()


# --- what the caller may do -------------------------------------------------------------------


def action_for(
    seat: access.Seat,
    c: DiscussionChange,
    decided: bool = False,
    records: bool | None = None,
    locked: str | None = None,
) -> ChangeAction | None:
    """The kind's action for this caller; None for a viewer or a handled change.
    ``records``: whether ``leads.date_rights`` lets the caller record a date basis (F3), which
    decides Record instead of the role. ``locked``: "Section <n>. <heading> is approved and
    locked" when a section_edit's section is (AUD-1: Stage refuses it, so it is not offered)."""
    if not access.can_write(seat) or c.status not in OPEN:
        return None
    k = kinds.REGISTRY[c.kind]
    if seat.author_only:
        return ChangeAction(verb=k.verb, allowed=False, why_not=SHARE_FIRST)  # type: ignore[arg-type]
    if decided:
        return ChangeAction(verb=k.verb, allowed=False, why_not=DECIDED)  # type: ignore[arg-type]
    if not k.available(None):
        return ChangeAction(verb=k.verb, allowed=False, why_not=None)  # type: ignore[arg-type]
    if locked is not None:
        return ChangeAction(verb=k.verb, allowed=False, why_not=locked)  # type: ignore[arg-type]
    if c.kind == "basis_record" and records is not None:
        return ChangeAction(verb=k.verb, allowed=records, why_not=None if records else RECORDERS)  # type: ignore[arg-type]
    if has_role(seat.role, k.role):
        return ChangeAction(verb=k.verb, allowed=True)  # type: ignore[arg-type]
    why = APPROVERS_STAGE if k.verb == "Stage" else APPROVERS_ACT.format(verb=k.verb.lower())
    return ChangeAction(verb=k.verb, allowed=False, why_not=why)  # type: ignore[arg-type]


def can_of(seat: access.Seat, c: DiscussionChange, me: uuid.UUID | None) -> ChangeCan:
    if not access.can_write(seat):
        return ChangeCan()
    open_ = c.status in OPEN
    approver = has_role(seat.role, "approver")
    k = kinds.REGISTRY[c.kind]
    return ChangeCan(
        suggest=open_ and k.suggest and not approver and c.status == "proposed",
        edit=open_,
        withdraw=c.status == "suggested" and me is not None and c.suggested_by == me,
        dismiss=open_ and approver,
    )


def _label(c: DiscussionChange) -> str:
    try:
        return kinds.label(c.kind, c.edited_payload or c.payload, c.target)
    except (KeyError, TypeError, AttributeError):
        return c.kind.replace("_", " ").capitalize()


async def changes_out(
    db: AsyncSession,
    principal: "Principal",
    d: Discussion,
    seat: access.Seat,
    rows: list[DiscussionChange],
) -> list[DiscussionChangeOut]:
    from oracle.discussions.service import users_by_id

    users = await users_by_id(
        db, {i for c in rows for i in (c.proposed_by, c.suggested_by) if i is not None}
    )

    def person(i: uuid.UUID | None) -> DiscussionPerson | None:
        if i is None:
            return None
        u = users.get(i)
        return DiscussionPerson(user_id=i, name=display_name(u.email) if u else "Someone")

    decided = await _decided(db, d)
    seat = dataclasses.replace(seat, author_only=await share_first(db, d, seat))
    records = None
    if any(c.kind == "basis_record" for c in rows):
        from oracle.members.leads import date_rights, engineering_leads

        records = date_rights(principal, await engineering_leads(db)) is not None
    locked = await _locked_reasons(db, d, rows)
    return [
        DiscussionChangeOut(
            id=c.id,
            discussion_id=c.discussion_id,
            kind=c.kind,
            label=_label(c),
            target=c.target,
            payload=c.payload,
            edited_payload=c.edited_payload,
            rationale=c.rationale,
            proposed_by_kind=c.proposed_by_kind,  # type: ignore[arg-type]
            proposed_by=person(c.proposed_by),
            suggested_by=person(c.suggested_by),
            status=c.status,  # type: ignore[arg-type]
            action=action_for(
                seat, c, decided and c.kind.startswith("item_"), records, locked.get(c.id)
            ),
            can=can_of(seat, c, principal.user_id),
            pushback=c.pushback,
            needs_reason=d.visibility == "private" and access.can_write(seat),
            basis=c.basis or [],
            result_ref=c.result_ref,
            override_reason=c.override_reason,
            decision_note=c.decision_note,
            created_at=c.created_at,
            lock_version=c.lock_version,
        )
        for c in rows
    ]


async def _locked_reasons(
    db: AsyncSession, d: Discussion, rows: list[DiscussionChange]
) -> dict[uuid.UUID, str]:
    """Each open section_edit whose section is approved in the document's latest version, with
    the reason Stage would refuse it (AUD-1)."""
    edits = [c for c in rows if c.kind == "section_edit" and c.status in OPEN]
    if not edits or d.document_id is None:
        return {}
    keys = await locked_sections(db, d.document_id)
    out = {}
    for c in edits:
        key = (c.edited_payload or c.payload).get("section_key")
        if key in keys:
            out[c.id] = LOCKED.format(section=await _heading(db, d.document_id, key))
    return out


async def _decided(db: AsyncSession, d: Discussion) -> bool:
    """The subject's checkpoint was decided: its items take no more changes."""
    from oracle.runs.models import Checkpoint

    cid = (d.subject or {}).get("checkpoint_id")
    if d.subject_kind not in ("checkpoint", "checkpoint_item") or not cid:
        return False
    cp = await db.get(Checkpoint, uuid.UUID(str(cid)))
    return cp is not None and cp.status != "pending"


async def list_changes(
    db: AsyncSession,
    principal: "Principal",
    d: Discussion,
    seat: access.Seat,
    status: str | None = None,
    ids: list[uuid.UUID] | None = None,
) -> list[DiscussionChangeOut]:
    stmt = select(DiscussionChange).where(DiscussionChange.discussion_id == d.id)
    if status:
        stmt = stmt.where(DiscussionChange.status == status)
    if ids is not None:
        stmt = stmt.where(DiscussionChange.id.in_(ids))
    rows = list(await db.scalars(stmt.order_by(DiscussionChange.created_at, DiscussionChange.id)))
    return await changes_out(db, principal, d, seat, rows)


# --- people act on changes --------------------------------------------------------------------


def _now() -> datetime:
    return datetime.now(UTC)


async def _load(
    db: AsyncSession, principal: "Principal", change_id: uuid.UUID, lock_version: int | None
) -> tuple[Discussion, access.Seat, DiscussionChange]:
    from oracle.discussions import service

    await recheck_caller(db, principal, "viewer")
    c = await db.get(DiscussionChange, change_id)
    if c is None:
        raise service.DiscussionError(404, NOT_FOUND)
    d, _parts, seat = await service.readable(db, principal, c.discussion_id)
    if not access.can_write(seat):
        raise service.DiscussionError(403, service.VIEWERS_READ)
    seat = dataclasses.replace(seat, author_only=await share_first(db, d, seat))
    if principal.user_id is None:
        raise service.DiscussionError(403, "Only a person can act on a change")
    c = await db.get(DiscussionChange, change_id, with_for_update=True, populate_existing=True)
    assert c is not None
    if lock_version is not None and c.lock_version != lock_version:
        raise service.DiscussionError(409, CHANGED)
    return d, seat, c


async def share_first(db: AsyncSession, d: Discussion, seat: access.Seat) -> bool:
    """Rule 4 (S6, G1 §3.4.3): the discussion is on its author's own finding, still below
    ``counts``. (The seat's ``author_only`` holds until Summary, when others may join.)"""
    from oracle.intake import sharing

    if not seat.author_only:
        return False
    found = await access.hidden_finding(db, uuid.UUID(str(d.subject["gap_id"])))
    if found is None:
        return False
    level = sharing.level_of(sharing.registry(found[0]), d.subject["gap_id"])
    return level is not None and sharing.RANK[level] < sharing.RANK["counts"]


def _need_open(c: DiscussionChange) -> None:
    from oracle.discussions.service import DiscussionError

    if c.status not in OPEN:
        raise DiscussionError(409, NOT_OPEN)


def _need_shared(seat: access.Seat) -> None:
    from oracle.discussions.service import DiscussionError

    if seat.author_only:
        raise DiscussionError(422, SHARE_FIRST)


def _need_kind(c: DiscussionChange, *names: str) -> kinds.Kind:
    from oracle.discussions.service import DiscussionError

    k = kinds.REGISTRY[c.kind]
    if c.kind not in names or not k.available(None):
        raise DiscussionError(422, f"A {c.kind} change is not used this way")
    return k


def _need_role(seat: access.Seat, role: str, why: str) -> None:
    from oracle.discussions.service import DiscussionError

    if not has_role(seat.role, role):
        raise DiscussionError(403, why)


async def _staging(op: Any) -> Any:
    from oracle.discussions.service import DiscussionError
    from oracle.staging.service import StagingError

    try:
        return await op
    except StagingError as e:
        raise DiscussionError(e.status, e.detail) from e


async def _name(db: AsyncSession, principal: "Principal") -> str:
    from oracle.discussions.service import users_by_id

    users = await users_by_id(db, {principal.user_id}) if principal.user_id else {}
    u = users.get(principal.user_id)  # type: ignore[arg-type]
    return display_name(u.email) if u else "Someone"


async def _line(db: AsyncSession, principal: "Principal", d: Discussion, c: DiscussionChange,
                did: str) -> None:  # fmt: skip
    """The thread's system line: "<name> staged: Move <item> to Next"."""
    from oracle.discussions.service import _system_line

    await _system_line(db, d, f"{await _name(db, principal)} {did}: {_label(c)}")


async def _record(db: AsyncSession, principal: "Principal", action: str, c: DiscussionChange,
                  **data: Any) -> None:  # fmt: skip
    await audit.record(
        db, principal, f"discussion.change_{action}", "discussion_change", c.id,
        {"discussion_id": str(c.discussion_id), "kind": c.kind, **data},
    )  # fmt: skip


async def suggest(
    db: AsyncSession, principal: "Principal", change_id: uuid.UUID, lock_version: int
) -> tuple[DiscussionChange, dict[str, Any] | None]:
    from oracle.discussions.service import DiscussionError
    from oracle.staging import mapping
    from oracle.staging import service as staging

    d, seat, c = await _load(db, principal, change_id, lock_version)
    _need_shared(seat)
    if c.status != "proposed":
        raise DiscussionError(409, NOT_OPEN)
    k = kinds.REGISTRY[c.kind]
    if not k.suggest or not k.available(None):
        raise DiscussionError(422, f"A {c.kind} change is not suggested")
    ref = None
    if mapping.target_of(c.kind) == "checkpoint":
        ref = await _staging(staging.suggest_discussion_change(db, principal, c))
        c = await db.get(DiscussionChange, change_id, populate_existing=True)
    else:
        c.status, c.suggested_by, c.suggested_at = "suggested", principal.user_id, _now()
    await _record(db, principal, "suggested", c)
    return c, ref


async def edit(
    db: AsyncSession,
    principal: "Principal",
    change_id: uuid.UUID,
    payload: dict[str, Any],
    rationale: str | None,
    lock_version: int,
) -> tuple[DiscussionChange, None]:
    """A commenter's edit becomes their suggestion (at a checkpoint, also the item's
    suggested D8 action, as Suggest writes it); an approver's keeps the status."""
    from oracle.discussions.service import DiscussionError
    from oracle.staging import mapping
    from oracle.staging import service as staging

    _d, seat, c = await _load(db, principal, change_id, lock_version)
    _need_open(c)
    try:
        c.edited_payload = kinds.validate_payload(c.kind, payload)
    except ValidationError as e:
        raise DiscussionError(
            422, f"The change does not read as a {c.kind}: {e.errors()[0]['msg']}"
        ) from e
    if rationale is not None:
        c.rationale = rationale.strip()[:MAX_RATIONALE] or c.rationale
    k = kinds.REGISTRY[c.kind]
    if has_role(seat.role, "approver"):
        pass
    elif mapping.target_of(c.kind) == "checkpoint" and k.suggest and k.available(None):
        await _staging(staging.suggest_discussion_change(db, principal, c))
        c = await db.get(DiscussionChange, change_id, populate_existing=True)
    else:
        c.status, c.suggested_by, c.suggested_at = "suggested", principal.user_id, _now()
    await _record(db, principal, "edited", c)
    return c, None


async def withdraw(
    db: AsyncSession, principal: "Principal", change_id: uuid.UUID, lock_version: int
) -> tuple[DiscussionChange, None]:
    """The suggester's own suggestion: back to proposed when Oracle proposed it, else
    dismissed. A suggested D8 action it wrote is removed."""
    from oracle.discussions.service import DiscussionError
    from oracle.runs import actions
    from oracle.runs.models import CheckpointAction

    _d, _seat, c = await _load(db, principal, change_id, lock_version)
    if c.status != "suggested" or c.suggested_by != principal.user_id:
        raise DiscussionError(403, "Only the person who suggested it can withdraw it")
    ref = c.result_ref or {}
    if ref.get("kind") == "checkpoint_action":
        row = await db.get(CheckpointAction, uuid.UUID(ref["id"]))
        if row is not None and row.state == "suggested":
            try:
                await actions.remove_action(db, principal, row.run_id, row.checkpoint_id, row.id)
            except Exception as e:  # D8 refuses: the change stays as it is
                raise DiscussionError(409, str(e)) from e
            c = await db.get(DiscussionChange, change_id, populate_existing=True)
    c.suggested_by = c.suggested_at = c.result_ref = None
    c.status = "proposed" if c.proposed_by_kind == "oracle" else "dismissed"
    await _record(db, principal, "withdrawn", c)
    return c, None


async def stage(
    db: AsyncSession,
    principal: "Principal",
    change_id: uuid.UUID,
    lock_version: int,
    override_reason: str | None,
    reason: str | None,
) -> tuple[DiscussionChange, dict[str, Any]]:
    from oracle.discussions.service import DiscussionError
    from oracle.staging import mapping
    from oracle.staging import service as staging

    d, seat, c = await _load(db, principal, change_id, lock_version)
    _need_shared(seat)
    _need_open(c)
    _need_role(seat, "approver", APPROVERS_STAGE)
    if mapping.target_of(c.kind) is None or not kinds.REGISTRY[c.kind].available(None):
        raise DiscussionError(422, f"A {c.kind} change is not staged")
    if c.kind == "section_edit" and d.document_id is not None:
        # AUD-1: a section approved since the change was proposed is not changed.
        key = (c.edited_payload or c.payload)["section_key"]
        if key in await locked_sections(db, d.document_id):
            heading = await _heading(db, d.document_id, key)
            raise DiscussionError(422, LOCKED.format(section=heading))
    override = (override_reason or "").strip() or None
    if c.pushback and not c.override_reason and override is None:
        raise DiscussionError(422, PUSHED_BACK)
    reason = (reason or "").strip() or None
    if d.visibility == "private" and reason is None:
        raise DiscussionError(422, WRITE_REASON)
    first = not await db.scalar(
        select(DiscussionChange.id).where(
            DiscussionChange.discussion_id == d.id,
            DiscussionChange.status.in_(("staged", "done")),
        )
    )
    ref = await _staging(staging.stage_discussion_change(db, principal, c, reason, override))
    c = await db.get(DiscussionChange, change_id, populate_existing=True)
    d = await db.get(Discussion, d.id, populate_existing=True)
    if override is not None:
        await _record(db, principal, "override", c, change_id=str(c.id), length=len(override))
    await _record(db, principal, "staged", c, from_private=d.visibility == "private")
    await _line(db, principal, d, c, "staged")
    if first:
        await queue_summary(db, d)
    return c, ref


async def dismiss(
    db: AsyncSession, principal: "Principal", change_id: uuid.UUID, lock_version: int,
    note: str | None,
) -> tuple[DiscussionChange, None]:  # fmt: skip
    _d, seat, c = await _load(db, principal, change_id, lock_version)
    _need_open(c)
    _need_role(seat, "approver", "Approvers dismiss changes")
    c.status, c.decided_by, c.decided_at = "dismissed", principal.user_id, _now()
    c.decision_note = (note or "").strip()[:1000] or None
    await _record(db, principal, "dismissed", c)
    return c, None


async def _done(db, principal, d, c, ref: dict[str, Any], did: str) -> None:
    c.status, c.result_ref = "done", ref
    c.decided_by, c.decided_at = principal.user_id, _now()
    await _record(db, principal, "done", c, **{k: str(v) for k, v in ref.items()})
    await _line(db, principal, d, c, did)


async def propose(
    db: AsyncSession,
    principal: "Principal",
    change_id: uuid.UUID,
    lock_version: int,
    payload: dict[str, Any] | None = None,
) -> tuple[DiscussionChange, dict[str, Any] | None]:
    """``goal_measure`` and ``entity_edit``: an open baseline proposal an approver accepts
    in Baseline, its reason naming the discussion and linking its page (B1). A goal version
    goes through B6's one path (``goal_interview.propose_version``): B5's checks, Oracle's
    pushback once when its target is already met (the result is then None and the change
    carries the pushback), and the typed values clearing their ``*_text``. ``payload``: the
    person's Edit, proposed instead and kept as ``edited_payload`` only when it is used."""
    from oracle.baseline import goal_interview
    from oracle.baseline import service as baseline
    from oracle.baseline.models import Proposal
    from oracle.discussions.service import DiscussionError

    d, seat, c = await _load(db, principal, change_id, lock_version)
    _need_shared(seat)
    _need_open(c)
    k = _need_kind(c, "goal_measure", "entity_edit")
    _need_role(seat, k.role, "Commenters and up propose changes")
    reason = f"From discussion {d.title} ({await discussion_page(db, d)})"
    if c.kind == "goal_measure":
        try:
            act = goal_interview.GoalMeasureAct(payload=payload)
            out = await goal_interview.propose_version(db, principal, c, d, act, reason=reason)
        except baseline.GoalFieldsInvalid:
            raise  # B5: 422 with every problem (the app's handler)
        except baseline.BaselineError as e:
            raise DiscussionError(422, str(e)) from e
        if isinstance(out, goal_interview.GoalMeasurePushback):
            return c, None
        proposal_id = out.result_ref["proposal_id"]
        status = (await db.get(Proposal, uuid.UUID(proposal_id))).status
    else:
        if payload is not None:
            try:
                c.edited_payload = kinds.validate_payload(c.kind, payload)
            except ValidationError as e:
                raise DiscussionError(
                    422, f"The change does not read as a {c.kind}: {e.errors()[0]['msg']}"
                ) from e
        p = c.edited_payload or c.payload
        writer = baseline.Writer(principal, "user", reason=reason)
        try:
            proposal = await baseline.submit_proposal(
                db, writer, op="update", kind="entity", fields={p["field"]: p["value"]},
                entity_id=uuid.UUID(str(p["entity_id"])), edge_id=None,
            )  # fmt: skip
        except baseline.BaselineError as e:
            raise DiscussionError(422, str(e)) from e
        proposal_id, status = str(proposal.id), proposal.status
    await _done(db, principal, d, c, {"proposal_id": proposal_id}, "proposed")
    return c, {"proposal_id": proposal_id, "status": status}


async def discussion_page(db: AsyncSession, d: Discussion) -> str:
    """The discussion's page in the web app: its subject's page opened on the thread."""
    from oracle.discussions.inbox import with_discussion
    from oracle.discussions.service import Labels

    _label, url = await Labels(db).of(d)
    return with_discussion(url, d.id)


async def resolve(
    db: AsyncSession, principal: "Principal", change_id: uuid.UUID, lock_version: int
) -> tuple[DiscussionChange, dict[str, Any]]:
    from oracle.baseline import conflicts
    from oracle.baseline import service as baseline
    from oracle.discussions.service import DiscussionError

    d, seat, c = await _load(db, principal, change_id, lock_version)
    _need_shared(seat)
    _need_open(c)
    _need_kind(c, "conflict_pick")
    _need_role(seat, "approver", APPROVERS_ACT.format(verb="resolve"))
    p = c.edited_payload or c.payload
    try:
        conflict = await conflicts.resolve(
            db, principal, uuid.UUID(str(p["conflict_id"])), claim=p["claim_index"], value=None,
            note=p.get("reason"),
        )  # fmt: skip
    except baseline.BaselineError as e:
        raise DiscussionError(e.status_code, str(e)) from e
    await _done(db, principal, d, c, {"conflict_id": str(conflict.id)}, "resolved")
    return c, {"conflict_id": str(conflict.id), "status": conflict.status}


async def answer(
    db: AsyncSession, principal: "Principal", change_id: uuid.UUID, lock_version: int
) -> tuple[DiscussionChange, dict[str, Any]]:
    """Use as answer: the person asked, or an approver."""
    from oracle.discussions.service import DiscussionError
    from oracle.intake import answers
    from oracle.intake import service as intake
    from oracle.intake.schemas import AnswerIn

    d, seat, c = await _load(db, principal, change_id, lock_version)
    _need_shared(seat)
    _need_open(c)
    _need_kind(c, "answer")
    p = c.edited_payload or c.payload
    try:
        question = await intake.get_question(db, uuid.UUID(str(p["question_id"])))
    except intake.IntakeError as e:
        raise DiscussionError(e.status, str(e)) from e
    if not (has_role(seat.role, "approver") or question.asked_to == principal.user_id):
        raise DiscussionError(403, "The person asked, or an approver, uses it as the answer")
    try:
        result = await answers.answer(
            db, principal, question, AnswerIn(kind="answer", body=p["body"])
        )
    except intake.IntakeError as e:
        raise DiscussionError(e.status, str(e)) from e
    ref = {"answer_id": str(result["answer"].id)}
    await _done(db, principal, d, c, ref, "answered")
    return c, ref


async def record(
    db: AsyncSession, principal: "Principal", change_id: uuid.UUID, lock_version: int
) -> tuple[DiscussionChange, dict[str, Any]]:
    """``basis_record``: Record the schedule basis as F3 Date bases does, with the rights
    ``leads.date_rights`` gives the caller now (owner 2026-10-21, "Who verifies"): verified
    for an engineering lead or an owner (an approver while no lead is named); proposed for
    the lead when an approver records it while a lead is named, so no date rests on it until
    the lead verifies it."""
    from oracle.discussions.service import DiscussionError
    from oracle.docs.models import Document
    from oracle.roadmap import router as roadmap
    from oracle.roadmap.models import ScheduleBasis
    from oracle.roadmap.schemas import ScheduleBasisCreate

    d, seat, c = await _load(db, principal, change_id, lock_version)
    _need_shared(seat)
    _need_open(c)
    _need_kind(c, "basis_record")
    rights = await roadmap.rights_now(db, principal)
    if rights is None:
        raise DiscussionError(403, RECORDERS)
    p = c.edited_payload or c.payload
    try:
        body = ScheduleBasisCreate(
            kind=p["kind"], reference=p["reference"], supports_date=p["supports_date"],
            detail=p.get("detail"), prd=str(p["prd_document_id"]), item_key=p.get("item_key"),
            tracker_key=p.get("tracker_key"),
        )  # fmt: skip
    except ValidationError as e:
        raise DiscussionError(422, f"The date basis does not read: {e.errors()[0]['msg']}") from e
    prd = await db.get(Document, uuid.UUID(body.prd))
    if prd is None or prd.kind != "prd":
        raise DiscussionError(422, "The date basis names no PRD")
    row = ScheduleBasis(
        kind=body.kind, reference=body.reference.strip(), supports_date=body.supports_date,
        detail=body.detail, prd_document_id=prd.id, item_key=body.item_key,
        tracker_key=body.tracker_key,
    )  # fmt: skip
    await roadmap.record_basis(db, principal, rights, row, prd)
    await _done(db, principal, d, c, {"basis_id": str(row.id)}, "recorded")
    return c, {"basis_id": str(row.id), "status": row.status}


async def create(
    db: AsyncSession,
    principal: "Principal",
    discussion_id: uuid.UUID,
    kind: str,
    payload: dict[str, Any],
    rationale: str | None,
) -> DiscussionChange:
    """A change written by hand: a commenter's is suggested, an approver's proposed."""
    from oracle.discussions import service

    await recheck_caller(db, principal, "viewer")
    d, _parts, seat = await service.readable(db, principal, discussion_id)
    if not access.can_write(seat) or principal.user_id is None:
        raise service.DiscussionError(403, service.VIEWERS_READ)
    if kind not in kinds.available_for(d.subject_kind, db):
        raise service.DiscussionError(422, f"A {kind} change cannot be proposed here")
    try:
        payload = kinds.validate_payload(kind, payload)
    except ValidationError as e:
        raise service.DiscussionError(
            422, f"The change does not read as a {kind}: {e.errors()[0]['msg']}"
        ) from e
    problem = await _target_problem(db, d, kind, payload)
    if problem == "locked":
        raise service.DiscussionError(422, "That section is approved and locked")
    if problem is not None:
        raise service.DiscussionError(422, "The change's target is not there")
    approver = has_role(seat.role, "approver")
    row = DiscussionChange(
        discussion_id=d.id, kind=kind, target=target_of(d, kind, payload), payload=payload,
        rationale=(rationale or "").strip()[:MAX_RATIONALE] or None, proposed_by_kind="person",
        proposed_by=principal.user_id, status="proposed" if approver else "suggested",
        suggested_by=None if approver else principal.user_id,
        suggested_at=None if approver else _now(),
    )  # fmt: skip
    db.add(row)
    await db.flush()
    await _record(db, principal, "written", row)
    return row


# --- rule 5 and the summary queue -------------------------------------------------------------


async def on_finding_lowered(db: AsyncSession, intake_id: uuid.UUID, finding_ids: list[str]) -> int:
    """Rule 5: the open changes whose basis names a finding now private are superseded.
    Staged and done changes stay. Returns how many."""
    wanted = {str(f) for f in finding_ids}
    if not wanted:
        return 0
    rows = await db.scalars(select(DiscussionChange).where(DiscussionChange.status.in_(OPEN)))
    n = 0
    for c in rows:
        if any(
            str(b.get("intake_id")) == str(intake_id) and str(b.get("finding_id")) in wanted
            for b in c.basis or []
        ):
            c.status, c.decision_note = "superseded", MADE_PRIVATE
            n += 1
    await db.flush()
    return n


async def queue_summary(db: AsyncSession, d: Discussion) -> None:
    """Queue a summary draft for the minute tick (closed, or its first change staged)."""
    from oracle.discussions import summary

    await summary.queue(db, d)
