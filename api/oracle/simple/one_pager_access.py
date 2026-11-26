"""The PRD, version and working draft a one-pager reads, and who may read, change, decide
and remind (moved from oracle.simple.one_pager)."""

import uuid
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import company_time
from oracle.auth.models import User
from oracle.authz import has_role
from oracle.docs import visibility
from oracle.docs.models import Document, DocumentVersion, Section
from oracle.members.names import display_name
from oracle.review.models import DocumentReviewPolicy
from oracle.roadmap.models import ProductTrack
from oracle.roadmap.tracks import on_prd as tracks_on_prd
from oracle.simple import drafts, one_pager_checks, plan_strip
from oracle.simple.changes import ChangeError
from oracle.simple.models import (
    SimpleChange,
    SimpleDraft,
    SimpleOnePager,
)
from oracle.simple.one_pager_text import Built
from oracle.simple.schemas import (
    SimpleChangeConflict,
    SimplePersonRef,
)

# --------------------------------------------------------------------------- reading


async def _document(
    db: AsyncSession, principal: Any, doc: str, *, current: bool = False
) -> Document:
    """The PRD ``doc`` (slug or id) the caller sees; with ``current``, 404 for a PRD marked
    replaced, its detail naming the PRDs that replaced it (simple-replaced-prds: Simple shows
    those; the replaced one is history, read in Detailed)."""
    cond = Document.slug == doc
    try:
        cond = cond | (Document.id == uuid.UUID(doc))
    except ValueError:
        pass
    d = await db.scalar(select(Document).where(cond, Document.kind == "prd"))
    if d is None or not visibility.can_see(principal, d) or getattr(d, "deleted_at", None):
        raise ChangeError(404, "No such PRD")
    if current and d.replaced_by:
        from oracle.roadmap import company

        if live := (await company.history(db)).prds.get(d.id):
            by = [{**r, "id": str(r["id"])} for r in await company.refs(db, live)]
            raise ChangeError(404, {"message": "This PRD was replaced", "replaced_by": by})
    return d


async def published(db: AsyncSession, document: Document) -> DocumentVersion:
    """The version a one-pager reads: the latest approved; with none, the latest that is
    not a Simple draft in review."""
    hidden = await drafts.submitted_versions(db)
    q = select(DocumentVersion).where(DocumentVersion.document_id == document.id)
    if hidden:
        q = q.where(DocumentVersion.id.not_in(hidden))
    v = await db.scalar(
        q.where(DocumentVersion.approved_at.is_not(None))
        .order_by(DocumentVersion.number.desc())
        .limit(1)
    ) or await db.scalar(q.order_by(DocumentVersion.number.desc()).limit(1))
    if v is None:
        raise ChangeError(404, "This PRD has no version yet")
    return v


async def _sections(db: AsyncSession, v: DocumentVersion) -> list[Section]:
    return list(
        await db.scalars(
            select(Section).where(Section.version_id == v.id).order_by(Section.ordinal)
        )
    )


def _said(text: str) -> str:
    return " ".join(str(text or "").split()).lower()


async def carry_keys(
    db: AsyncSession,
    document: Document,
    v: DocumentVersion,
    blocks: list[dict[str, Any]],
    row: SimpleOnePager | None = None,
) -> list[dict[str, Any]]:
    """Each new bet line takes the key (``visuals.bet_key``) of the bet it is on the page
    built before (the document's latest other row): line ids are positions, renumbered on
    every build, so a bet keeps its drawn flow when bets are added, dropped or reordered.
    Matched by words (the earlier bet's, or the words the published draft gave it); then by
    the earlier bet it reads most like (``visuals.pair_alike``); then, with as many bets as
    before, by place when that place's bet is unmatched (a bet reworded past likeness); else
    a new key."""
    from oracle.simple import visuals

    q = select(SimpleOnePager).where(SimpleOnePager.document_id == document.id)
    if row is not None and row.id is not None:
        q = q.where(SimpleOnePager.id != row.id)
    prev = row if row is not None and row.blocks else None
    prev = prev or await db.scalar(q.order_by(SimpleOnePager.built_at.desc()).limit(1))
    new = [x for b in blocks if b["key"] == "bets" for x in b["lines"]]
    if prev is None:
        return blocks
    old = [x for b in prev.blocks or [] if b.get("key") == "bets" for x in b.get("lines") or []]
    edited = {}
    d = await db.scalar(select(SimpleDraft).where(SimpleDraft.version_id == v.id))
    if d is not None:
        edited = (d.overlay or {}).get("lines") or {}
    # Each earlier bet's key is the key of the flow it showed (visuals.flows_of_bets): on a
    # page whose keys were shifted, a bet's flow is under another bet's key or its own
    # (``visuals.own_subject``), so the next page carries the flow, never the stored key.
    keys = [visuals.bet_key(x) for x in old]
    by_subject = {visuals.line_subject(document.id, k): k for k in keys}
    by_subject |= {visuals.own_subject(document.id, k): k + "/own" for k in keys}
    showed = await visuals.flows_of_bets(
        db,
        document.id,
        [
            (k, [t for t in (x.get("text"), edited.get(x.get("id"))) if t])
            for k, x in zip(keys, old, strict=True)
        ],
    )
    keys = [by_subject.get(sid, k) for k, (sid, _) in zip(keys, showed, strict=True)]
    words: dict[str, str] = {}
    for x, k in zip(old, keys, strict=True):
        for t in (edited.get(x.get("id")), x.get("text")):
            if t:
                words.setdefault(_said(t), k)
    used: set[str] = set()
    for x in new:
        key = words.get(_said(x["text"]))
        if key and key not in used:
            x["flow_key"] = key
            used.add(key)
    # Reworded (Oracle words each build its own way): the earlier bet it reads most like.
    was = [
        [] if k in used else [t for t in (edited.get(x.get("id")), x.get("text")) if t]
        for x, k in zip(old, keys, strict=True)
    ]
    now = [[] if "flow_key" in x else [x["text"]] for x in new]
    for j, i in visuals.pair_alike(was, now).items():
        new[j]["flow_key"] = keys[i]
        used.add(new[j]["flow_key"])
    by_place = (
        {str(x.get("id")): k for x, k in zip(old, keys, strict=True)}
        if len(old) == len(new)
        else {}
    )
    taken = set(keys) | {visuals.bet_key(x) for x in old}
    for x in new:
        if "flow_key" not in x:
            key = by_place.get(x["id"])
            if not key or key in used:
                # A new bet: a key of its own, the same on every read of this version.
                key, n = f"{v.id.hex}-{x['id']}", 1
                while key in used or key in taken:
                    key, n = f"{v.id.hex}-{x['id']}-{n}", n + 1
            x["flow_key"] = key
            used.add(key)
    return blocks


async def _writing(db: AsyncSession, b: Built) -> bool:
    """The page is Oracle's quick read while its ``one_pager`` job, queued or running, writes
    it (the page says so in one line)."""
    from oracle.jobs.models import LlmJob

    if b.row.built_by != "extract" or b.row.held:
        return False
    return bool(
        await db.scalar(
            select(LlmJob.id)
            .where(
                LlmJob.document_id == b.document.id,
                LlmJob.version_id == b.version.id,
                LlmJob.kind == "one_pager",
                LlmJob.status.in_(("queued", "running")),
            )
            .limit(1)
        )
    )


async def _lines_in_use(db: AsyncSession, document: Document) -> bool:
    """An open draft or an open proposal of the PRD names the cached page's line ids."""
    if await _open_draft(db, document) is not None:
        return True
    return (
        await db.scalar(
            select(SimpleChange.id)
            .where(
                SimpleChange.document_id == document.id,
                SimpleChange.op == "edit_line",
                SimpleChange.status == "proposed",
            )
            .limit(1)
        )
        is not None
    )


# --------------------------------------------------------------------------- who

# Remind: a reviewer is nudged at most once in this long.
REMIND_EVERY = timedelta(days=1)


@dataclass
class Who:
    decider: uuid.UUID | None
    reviewers: list[uuid.UUID]
    track_owners: dict[uuid.UUID, str]  # id -> role
    company_owners: list[uuid.UUID]


def drafts_who(w: Who, document_id: uuid.UUID) -> drafts.Who:
    """The page's ``who`` as oracle.simple.drafts reads it (its decider, required reviewers and
    track owners): a one-pager read never asks the database again (review read budget)."""
    return drafts.Who(
        deciders={document_id: w.decider},
        reviewers={document_id: list(w.reviewers)},
        owners={document_id: set(w.track_owners)},
    )


async def who(db: AsyncSession, document: Document) -> Who:
    policy = await db.scalar(
        select(DocumentReviewPolicy).where(DocumentReviewPolicy.document_id == document.id)
    )
    owners = {
        u.id: u.role
        for u in await db.scalars(
            select(User)
            .join(ProductTrack, ProductTrack.owner_id == User.id)
            .where(tracks_on_prd(document.id), User.disabled_at.is_(None))
        )
    }
    company = list(
        await db.scalars(
            select(User.id)
            .where(User.role == "owner", User.disabled_at.is_(None))
            .order_by(User.created_at, User.id)
        )
    )
    return Who(
        policy.decider_id if policy else None,
        list(policy.mandatory_reviewer_ids or []) if policy else [],
        owners,
        company,
    )


async def _person_of(db: AsyncSession, imported_by: uuid.UUID | None) -> uuid.UUID | None:
    """Who imported a version: its user, or the user an API token acts for (a service
    token is no one: None)."""
    from oracle.auth.models import ApiToken

    if imported_by is None:
        return None
    if await db.scalar(select(User.id).where(User.id == imported_by)) is not None:
        return imported_by
    return await db.scalar(select(ApiToken.user_id).where(ApiToken.id == imported_by))


async def document_owner(
    db: AsyncSession, document: Document, version: DocumentVersion, w: Who
) -> uuid.UUID | None:
    """The PRD's owner (the owner's walk, P4): its track owner; else the person who brought
    the document in (its first version's importer: a user, or the user its API token acts
    for), else the one who imported or approved the version read. None only when no person
    is any of those (a PRD a service token imported and nobody approved yet)."""
    if w.track_owners:
        return next(iter(w.track_owners))
    first = await db.scalar(
        select(DocumentVersion.imported_by)
        .where(DocumentVersion.document_id == document.id)
        .order_by(DocumentVersion.number)
        .limit(1)
    )
    for who in (first, version.imported_by, version.approved_by):
        person = await _person_of(db, who)
        if person is not None and await db.scalar(
            select(User.id).where(User.id == person, User.disabled_at.is_(None))
        ):
            return person
    return None


def span_words(start: date, end: date) -> str:
    """A span as people read it, month first: "Nov 2 – Dec 23, 2026", "Nov 2, 2026 – Feb 26,
    2027"; never ISO."""
    first = company_time.calendar_day(start) + ("" if start.year == end.year else f", {start.year}")
    return f"{first} – {company_time.calendar_day(end)}, {end.year}"


def milestone_span(items: list[plan_strip.PlanItem]) -> tuple[date, date] | None:
    """The PRD's span in the header (P4): from the earliest start of its items that carry a
    dated milestone (or that milestone's date, when earlier) to its latest milestone date.
    None with no dated milestone: never the estimated windows' year."""
    dated = [i for i in items if i.milestone_date is not None]
    if not dated:
        return None
    end = max(i.milestone_date for i in dated)  # type: ignore[type-var]
    start = min(min(i.start, i.milestone_date) for i in dated)  # type: ignore[type-var]
    return min(start, end), end


def _me(principal: Any) -> uuid.UUID | None:
    if principal is None or getattr(principal, "run_id", None) is not None:
        return None
    return getattr(principal, "user_id", None)


def decides(principal: Any, w: Who) -> bool:
    """D4 and D-a for a PRD: an owner; its decider; with none, its track owner while an
    approver or owner."""
    me = _me(principal)
    if me is None:
        return False
    if has_role(principal.role, "owner"):
        return True
    if w.decider is not None:
        return me == w.decider
    return me in w.track_owners and has_role(principal.role, "approver")


def starts(principal: Any, w: Who) -> bool:
    """Start review: the start API's rule (meetings.may_start), not who edits lines."""
    from oracle.simple import meetings

    return meetings.may_start(principal, meetings.PrdWho(w.decider, [], []))


def may_remind(principal: Any, w: Who) -> bool:
    """Remind: the PRD's owners (a company owner, its track owners) and its decider."""
    me = _me(principal)
    return me is not None and (decides(principal, w) or me in w.track_owners)


def owns(principal: Any, w: Who, owner_id: uuid.UUID | None) -> bool:
    """The PRD's owners (its "Needs a look" note): a company owner, its track owners and
    its document owner."""
    me = _me(principal)
    return me is not None and (
        has_role(principal.role, "owner") or me in w.track_owners or me == owner_id
    )


def due_reminders(d: SimpleDraft, now: datetime) -> list[uuid.UUID]:
    """The reviewers a submitted draft waits on who were not reminded in the last day."""
    if d.status != "submitted":
        return []
    sent = d.reminders or {}
    return [
        i
        for i in d.waiting_on or []
        if str(i) not in sent or now - datetime.fromisoformat(sent[str(i)]) >= REMIND_EVERY
    ]


def reminded_at(d: SimpleDraft) -> datetime | None:
    """The draft's last reminder (to a reviewer it still waits on)."""
    waiting = {str(i) for i in d.waiting_on or []}
    at = [datetime.fromisoformat(v) for k, v in (d.reminders or {}).items() if k in waiting]
    return max(at, default=None)


def route(w: Who) -> list[uuid.UUID]:
    if w.decider is not None:
        return [w.decider]
    return [i for i, r in w.track_owners.items() if has_role(r, "approver")] or w.company_owners


def sees_draft(principal: Any, d: SimpleDraft, w: Who) -> bool:
    me = _me(principal)
    if me is None:
        return False
    return (
        has_role(principal.role, "owner")
        or me in (d.created_by, w.decider)
        or me in (d.participant_ids or [])
        or me in w.reviewers
        or me in w.track_owners
        # Whom it waits on, and the reviewers its sender added (drafts.sees).
        or me in (d.waiting_on or [])
        or me in drafts.added_ids(d)
    )


def may_decide(principal: Any, c: SimpleChange) -> bool:
    """A proposal's decider: an owner, or whom it is routed to."""
    me = _me(principal)
    return me is not None and (has_role(principal.role, "owner") or me in (c.routed_to or []))


def sees_change(principal: Any, c: SimpleChange) -> bool:
    me = _me(principal)
    return me is not None and (c.by == me or may_decide(principal, c))


async def _open_draft(
    db: AsyncSession, document: Document, lock: bool = False
) -> SimpleDraft | None:
    q = select(SimpleDraft).where(
        SimpleDraft.document_id == document.id, SimpleDraft.status.in_(drafts.OPEN)
    )
    if lock:
        q = q.with_for_update()
    return await db.scalar(q.order_by(SimpleDraft.created_at.desc()).limit(1))


def _lines(b: Built) -> dict[str, dict[str, Any]]:
    return {line["id"]: line for blk in b.row.blocks for line in blk["lines"]}


def _section_body(b: Built, d: SimpleDraft | None, key: str) -> tuple[str, str] | None:
    sec = next((s for s in b.sections if s.section_key == key), None)
    if sec is None:
        return None
    patched = ((d.overlay or {}).get("sections") or {}) if d else {}
    heads = ((d.overlay or {}).get("headings") or {}) if d else {}
    return heads.get(key, sec.heading), patched.get(key, sec.body_md)


# --------------------------------------------------------------------------- set_section_number
# A "Needs a look" numbers item's one-click fix (owner, Nov 5): the number in the words
# ``said`` of one section set to ``value``, through the PRD's working draft as edit_line;
# a one-pager line resting on the section and saying the same words is set with it, so
# the line and its section never disagree. The same rights, Undo and approval as a line.
# ``target.part`` "heading" (owner, Nov 5, 'Fix the heading too'): the number is in the
# section's heading ("Later · 8 items"); the draft holds the new heading.


def _number_values(b: Built, d: SimpleDraft | None, key: str) -> dict[str, Any]:
    """The section ``key`` and the lines resting on it, as ``d`` (None: published) has
    them."""
    hb = _section_body(b, d, key)
    if hb is None:
        raise ChangeError(404, "No such section in this PRD")
    drafted = ((d.overlay or {}).get("lines") or {}) if d else {}
    lines = {
        x["id"]: drafted.get(x["id"], x["text"])
        for x in _lines(b).values()
        if key in x["source_keys"]
    }
    return {"sections": {key: {"heading": hb[0], "body": hb[1]}}, "lines": lines}


def _held(values: dict[str, Any]) -> dict[str, Any]:
    return {"sections": values.get("sections") or {}, "lines": values.get("lines") or {}}


async def _number_conflict(
    db: AsyncSession, b: Built, d: SimpleDraft | None, target: dict, message: str
) -> ChangeError:
    """409: the section's words now, and who changed the section last in the draft."""
    key = str(target.get("section"))
    hb = _section_body(b, d, key)
    last = None
    if d is not None:
        last = next(
            (c for c in reversed(await drafts._live_changes(db, d))
             if key in ((c.after or {}).get("sections") or {})),
            None,
        )  # fmt: skip
    by = None
    if last is not None and last.by is not None:
        u = await db.get(User, last.by)
        by = SimplePersonRef(id=last.by, name=display_name(u.email, u.name) if u else "someone")
        message = f"Changed by {by.name}"
    return ChangeError(
        409,
        SimpleChangeConflict(
            message=message,
            current={"section": key, "heading": hb[0] if hb else "", "body": hb[1] if hb else ""},
            changed_by=by,
            changed_at=last.at if last is not None else None,
        ).model_dump(mode="json"),
    )


def _number_undone(c: SimpleChange, now: dict[str, Any]) -> dict[str, Any] | None:
    """The section and its lines as ``now`` holds them with only ``c``'s number put back,
    so either of two fixes in one section undoes (review, Nov 7); None when the number
    ``c`` set is no longer there (changed since)."""
    if now == _held(c.after):
        return _held(c.before)
    key, part = str(c.target["section"]), str(c.target.get("part") or "body")
    first, *rest = str(c.target["said"]).split()
    was = str(c.before.get("number") or first)
    said = " ".join([one_pager_checks.as_written(first, str(c.after.get("number") or "")), *rest])
    sec = dict(now["sections"][key])
    put = one_pager_checks.set_number(sec[part], said, was)
    if put is None:
        return None
    sec[part] = put
    set_before, set_after = c.before.get("lines") or {}, c.after.get("lines") or {}
    lines = {
        i: (one_pager_checks.set_number(text, said, was) or text)
        if set_before.get(i) != set_after.get(i)
        else text
        for i, text in (now.get("lines") or {}).items()
    }
    return {"sections": {key: sec}, "lines": lines}


def _write_number(d: SimpleDraft, b: Built, values: dict[str, Any]) -> None:
    """The section (its heading and words) and its lines, together (a value equal to the
    published one leaves the draft)."""
    ov = dict(d.overlay or {})
    secs, lines = dict(ov.get("sections") or {}), dict(ov.get("lines") or {})
    heads = dict(ov.get("headings") or {})
    published = _lines(b)
    for line_id, text in (values.get("lines") or {}).items():
        if text == published.get(line_id, {}).get("text"):
            lines.pop(line_id, None)
        else:
            lines[line_id] = text
    for k, p in (values.get("sections") or {}).items():
        sec = next((s for s in b.sections if s.section_key == k), None)
        if sec is not None and p["body"] == sec.body_md:
            secs.pop(k, None)
        else:
            secs[k] = p["body"]
        if sec is not None and p.get("heading", sec.heading) == sec.heading:
            heads.pop(k, None)
        elif sec is not None:
            heads[k] = p["heading"]
    ov = {**ov, "sections": secs, "lines": lines, "headings": heads}
    if not heads:
        ov.pop("headings")
    d.overlay = ov
