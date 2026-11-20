"""Simple S5 (#723): one-pagers (D2, D5, D8, D20; the owner's pick "A · Paper").

**What it is**: one page per PRD, read from its published version (its latest approved
version; with none yet, its latest): the template's blocks (D5: the template's front
matter ``one_pager: {blocks: [{key, title, sections, max_lines}]}``) or the six fallback
blocks, each capped: Problem and who has it (at most 60 words), What we will build (3-5
bets), Outcomes and how we measure them (2-4 metrics, from -> to), Not doing (at most 5),
Risks and open decisions (at most 5) and the Timeline strip (the PRD's slice of the
Simple roadmap, its span in the header). Each line keeps its source section keys.

**Built** by the ``one_pager`` job (oracle.jobs.kinds) from each block's mapped sections;
cached per version and hash of the mapped sections (``simple_one_pagers``), so a changed
mapped section is a new hash and a rebuild. Until the job answers, Oracle's quick read of
the sections (``built_by="extract"``) is shown, so every PRD has a one-pager at once
(Definition of Done 2).

**Editing a line** (D2, D4, D18) is the change engine's ``edit_line`` op: Oracle drafts the
matching section patch for EVERY source section of the line (the old line's words replaced
in the section, else the new line added to it), shown as before/after. Owners, the PRD's
decider (with none, its track owner while an approver, D-a) apply it into the PRD's ONE
shared working draft (oracle.simple.drafts: ``overlay`` ``{"sections": {key: markdown},
"lines": {line id: text}}``), undoable step by step; approvers and commenters propose it to
the decider (else that track owner, else the company's owners); viewers read. The line and
its sections are written together, so they never disagree; submitting the draft imports
the PRD's next version with the patched sections, through its review policy.

**Fixing a number** (owner, Nov 5): each "Needs a look" numbers item carries its fix (the
count set to the items listed, the company-wide target to what its parts add up to), the
change engine's ``set_section_number`` op: the number in the words ``said`` of one section,
through the same working draft, with the same rights, Undo and approval as a line edit; a
stale ``before`` is 409 naming who changed the section. The item clears for those who see
the draft (the numbers are checked on the drafted sections). A count in the section's
heading ("Later · 8 items" over six listed; owner, Nov 5, 'Fix the heading too') is set the
same way (``target.part`` "heading"): the draft holds the new heading
(``overlay["headings"]``: {key: heading}), the one-pager reads it, and submitting the draft
imports it under the same section key.

**Remind** (owner, 2026-10-26): on a submitted draft, the PRD's owners (company owners, its
track owners) and its decider press Remind (:func:`remind`): each reviewer the draft waits
on gets an Inbox nudge "<name> is waiting for your review of <PRD>" (``review_reminder``),
at most once a day per reviewer (``simple_drafts.reminders``), audited. It changes no
document data, so it is not a change-engine op.
"""

import logging
import re
import uuid
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from html import escape
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, company_time
from oracle.auth.models import User
from oracle.authz import has_role
from oracle.docs import visibility
from oracle.docs.models import Document, DocumentVersion, Section
from oracle.review.models import DocumentReviewPolicy
from oracle.roadmap.models import ProductTrack
from oracle.roadmap.tracks import on_prd as tracks_on_prd
from oracle.simple import drafts, one_pager_checks, plan_strip, quality
from oracle.simple import plan as plan_model
from oracle.simple.changes import IDLE, ChangeError, _session_for_change
from oracle.simple.models import (
    SimpleChange,
    SimpleDraft,
    SimpleOnePager,
    SimpleSession,
    SimpleVisual,
)
from oracle.simple.one_pager_pdf import (  # noqa: F401
    FLAG_CH,
    FLAG_PAD,
    NAME_CH,
    NOT_WRITTEN,
    PAGE_CSS,
    PAGE_NUMBERS,
    PLAN_ROWS,
    PM_LANE,
    TL_CH,
    TL_PX,
    TONES,
    _part_html,
    _pieces,
    _plan_html,
    _published_lines,
    _timeline_html,
    bar_box,
    bar_label,
    cut_name,
    milestone_words,
    month_label,
    place_flags,
    range_words,
)
from oracle.simple.one_pager_text import (  # noqa: F401
    _BULLET,
    _CELL_SPLIT,
    _COMMENT,
    _FEATURE_CODE,
    _GOAL_AFTER,
    _GOAL_PAREN,
    _MD,
    _METRIC,
    _PLACEHOLDER,
    _SENTENCE,
    _TABLE_SEP,
    _WORDY,
    FALLBACK,
    FULL_MAX,
    GOAL_CODE,
    LINE_MAX,
    MATCH,
    NUMBER_OP,
    OPS,
    PROBLEM_WORDS,
    TIMELINE,
    Built,
    Spec,
    _body,
    _cells,
    _drop,
    _facts,
    _feature_code,
    _goal_name,
    _hits,
    _id,
    _listed,
    _metric,
    _numbered,
    _own_fact,
    _plain,
    _row_line,
    _row_with,
    _says_not_in_prd,
    _spans,
    _stems,
    _tables,
    _template_specs,
    _tidy,
    _uncomment,
    _unpiped,
    _upto,
    _words,
    clean_answer,
    clip,
    extract,
    goal_names,
    mapping,
    metric_of,
    patch,
    patch_all,
    plan_items,
    prd_items,
    roadmap_codes_of,
    sections_hash,
    specs_for,
    template_only,
    with_goal_names,
)
from oracle.simple.schemas import (
    OnePagerBlock,
    OnePagerDraft,
    OnePagerFix,
    OnePagerFixed,
    OnePagerFixProposal,
    OnePagerInReview,
    OnePagerItem,
    OnePagerLine,
    OnePagerLook,
    OnePagerNote,
    OnePagerOut,
    OnePagerRemindOut,
    OnePagerSectionPatch,
    OnePagerSource,
    SimpleChangeConflict,
    SimpleChangeIn,
    SimpleChangeResult,
    SimpleDocRef,
    SimplePersonRef,
)

log = logging.getLogger(__name__)


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


async def built(
    db: AsyncSession, document: Document, *, queue: bool = True, persist: bool = True
) -> Built:
    """The cached one-pager of the published version and its mapped sections; built now
    (Oracle's quick read) and the ``one_pager`` job queued when the hash is new. With
    ``persist`` false (a viewer's read) a new quick read stays in memory: nothing is
    written. Two first reads of a version insert one row: the second reads the first's."""
    from sqlalchemy.exc import IntegrityError

    from oracle.jobs import service as jobs

    v = await published(db, document)
    specs = await specs_for(db, document)
    secs = await _sections(db, v)
    mapped = mapping(specs, secs)
    h = sections_hash(v, specs, mapped)
    row = await db.scalar(
        select(SimpleOnePager).where(
            SimpleOnePager.version_id == v.id, SimpleOnePager.sections_hash == h
        )
    )
    if row is None:
        row = SimpleOnePager(
            document_id=document.id,
            version_id=v.id,
            sections_hash=h,
            blocks=await carry_keys(db, document, v, _numbered(extract(specs, mapped))),
            built_by="extract",
            built_at=company_time.now(),
        )
        if not persist:
            return Built(document, v, specs, secs, row)
        try:
            async with db.begin_nested():
                db.add(row)
                await db.flush()
        except IntegrityError:
            row = await db.scalar(
                select(SimpleOnePager).where(
                    SimpleOnePager.version_id == v.id, SimpleOnePager.sections_hash == h
                )
            )
            assert row is not None
            return Built(document, v, specs, secs, row)
        if queue and any(mapped.values()):
            try:
                job = await jobs.enqueue(
                    db, document, "one_pager", version=v, input={"sections_hash": h}, coalesce=True
                )
                row.job_id = job.id
            except jobs.JobError:
                pass  # turned off or observing: the quick read stays
        await db.flush()
    return Built(document, v, specs, secs, row)


async def bet_flows(db: AsyncSession, document: Document) -> list[tuple[str, list[str], Any]]:
    """walkb-roadmap review: each bet of the PRD's published one-pager with the flow drawn for
    it (its words, its source sections, its ``SimpleFlow`` or None), as the page reads them: by
    the bet it was drawn for (visuals.flows_of_bets), else by its words (0092_bet_flow_line_key).
    Nothing is written or queued."""
    from oracle.simple import visuals

    try:
        b = await built(db, document, queue=False, persist=False)
    except ChangeError:
        return []
    bets = [
        x
        for blk in b.row.blocks or []
        for x in blk.get("lines") or []
        if str(x.get("id", "")).startswith("bets-")
    ]
    said = [str(x.get("text") or "") for x in bets]
    found = await visuals.flows_of_bets(
        db, document.id, [(visuals.bet_key(x), [t]) for x, t in zip(bets, said, strict=True)]
    )
    return [
        (t, list(x.get("source_keys") or []), flow)
        for x, t, (_, flow) in zip(bets, said, found, strict=True)
    ]


def _problem_names_no_one(answer: Any, sections: list[Section]) -> str | None:
    """ad-onepager's check on a raw ``one_pager`` answer: the reason its problem names no one
    of the PRD's users, else None (oracle.simple.one_pager_checks.problem_check)."""
    raw = (answer or {}).get("blocks") if isinstance(answer, dict) else None
    return one_pager_checks.problem_check([b for b in raw or [] if isinstance(b, dict)], sections)


async def run_job(s: AsyncSession, job, ask) -> dict[str, Any]:
    """The ``one_pager`` job: one call with each block's mapped sections; the answer,
    held to the caps and section keys, replaces the quick read of the same hash."""
    from oracle.jobs.kinds import JobInputError

    document = await s.get(Document, job.document_id)
    v = await s.get(DocumentVersion, job.version_id) if job.version_id else None
    if document is None or v is None:
        raise JobInputError("the PRD version no longer exists")
    specs = await specs_for(s, document)
    mapped = mapping(specs, await _sections(s, v))
    h = sections_hash(v, specs, mapped)
    payload = {
        "title": document.title,
        "blocks": [
            {
                "key": sp.key,
                "title": sp.title,
                "rules": sp.rules,
                "min_lines": sp.min_lines,
                "max_lines": sp.max_lines,
                "max_words": sp.max_words,
                "whole_block": sp.whole_block,
                "sections": [
                    {
                        "key": x.section_key,
                        "heading": x.heading,
                        "text": " ".join(_uncomment(x.body_text or "").split()),
                    }
                    for x in mapped.get(sp.key, [])
                ],
            }
            for sp in specs
        ],
    }
    # Who has it (ad-onepager): from the PRD's users or personas section, for the prompt.
    sections = await _sections(s, v)
    payload["who"] = one_pager_checks.who_has_it(sections)
    # oracle.simple.quality: a failing answer is asked once more with its failures named;
    # failing again, it is stored with them (held for owners; the last good page stays).
    # A problem that names no one of the PRD's users is asked for again too, but only the
    # quality checks hold a build: naming no one twice is built anyway (ad-onepager review),
    # and the page shows who has it beside the problem.
    answer = await ask("one_pager", payload)
    checks = quality.one_pager(answer, specs, mapped)
    why = _problem_names_no_one(answer, sections)
    if checks or why:
        failed = quality.said(checks) + ([why] if why else [])
        answer = await ask("one_pager", {**payload, "failed_checks": failed})
        checks = quality.one_pager(answer, specs, mapped)
    blocks = clean_answer(answer, specs, mapped, strict=not checks)
    if blocks is None:
        return {"built": False, "reason": "the answer missed a block's lines or section keys"}
    if await _lines_in_use(s, document):
        # Line ids are positions: replacing the lines under an open draft or proposal would
        # move its edit onto another line. The next version (a new hash) gets the answer.
        return {"built": False, "reason": "a working draft or a proposal holds this page's lines"}
    row = await s.scalar(
        select(SimpleOnePager).where(
            SimpleOnePager.version_id == v.id, SimpleOnePager.sections_hash == h
        )
    )
    blocks = await carry_keys(s, document, v, blocks, row)
    if row is None:
        quick = _numbered(extract(specs, mapped))
        row = SimpleOnePager(
            document_id=document.id,
            version_id=v.id,
            sections_hash=h,
            blocks=quick,
            built_at=company_time.now(),
        )
        s.add(row)
    row.job_id = job.id
    if checks:
        row.held, row.checks = blocks, checks
        await s.flush()
        # Held for owners, not built: the shown page and its visuals stay the last good.
        return {"built": False, "held": True, "sections_hash": h, "checks": quality.said(checks)}
    row.blocks, row.built_by, row.held, row.checks = blocks, "oracle", None, None
    row.built_at = company_time.now()  # a held run leaves the last good page's time
    await s.flush()
    # S10: Oracle drafts each bet's visual with the page (once per bet: a bet keeps its flow
    # when its words change).
    from oracle.simple import visuals

    for b in blocks:
        for line in b["lines"] if b["key"] == "bets" else []:
            sid = visuals.line_subject(document.id, visuals.bet_key(line))
            await visuals.request_visual(
                s, None, "one_pager_line", sid, line["text"], document_id=document.id
            )
    await s.flush()
    return {"built": True, "sections_hash": h}


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


# --------------------------------------------------------------------------- the read


async def read(
    db: AsyncSession, principal: Any, doc: str, *, held: bool = True, current: bool = False
) -> OnePagerOut:
    """The one-pager as ``principal`` reads it; ``held`` false (the PDF, which is shared): the
    last good version, never a build held for owners."""
    from oracle.simple import service

    document = await _document(db, principal, doc, current=current)
    # A viewer's read writes nothing (the page is built in memory until a writer reads it).
    writer = _me(principal) is not None and has_role(principal.role, "commenter")
    b = await built(db, document, persist=writer)
    if writer:
        await db.commit()
    # oracle.simple.quality: a build that failed its checks twice is read by owners, with a
    # note naming them; people below owner read the last good version.
    owner_reads = held and has_role(principal.role, "owner") and bool(b.row.held)
    page = b.row.held if owner_reads else b.row.blocks
    w = await who(db, document)
    d = await _open_draft(db, document)
    me = _me(principal)
    sees = d is not None and sees_draft(principal, d, w)
    line_text = ((d.overlay or {}).get("lines") or {}) if sees and d else {}
    # Notes: the draft's live changes (those who see it), and open proposals (their people).
    live = await drafts._live_changes(db, d) if sees and d else []
    proposals = list(
        await db.scalars(
            select(SimpleChange)
            .where(
                SimpleChange.document_id == document.id,
                SimpleChange.op.in_(("edit_line", NUMBER_OP)),
                SimpleChange.status == "proposed",
            )
            .order_by(SimpleChange.at, SimpleChange.seq)
        )
    )
    # A numbers fix proposed shows on its "Needs a look" item, never as a line's note.
    fixes = [c for c in proposals if c.op == NUMBER_OP and sees_change(principal, c)]
    proposals = [c for c in proposals if c.op == "edit_line"]
    shown = [c for c in proposals if sees_change(principal, c)]
    hidden = (len(proposals) - len(shown)) + (
        0 if sees or d is None else (await drafts.counts(db, [d]))[d.id]
    )
    # The changes behind that count, listed (build-review): the hidden draft's line changes
    # and the proposals not shown. A counted draft change with no line (a change of another
    # kind in the same draft) is skipped, so the list can be shorter than the count.
    unseen = await drafts._live_changes(db, d) if d is not None and not sees else []
    unseen = [c for c in unseen if c.op == "edit_line"]
    not_shown = [c for c in proposals if not sees_change(principal, c)]
    number_live = [c for c in live if c.op == NUMBER_OP]
    live = [c for c in live if c.op == "edit_line"]
    sids = {c.session_id for c in live + number_live if c.session_id}
    sessions = (
        {s.id: s for s in await db.scalars(select(SimpleSession).where(SimpleSession.id.in_(sids)))}
        if sids
        else {}
    )
    ids = (
        {c.by for c in live + shown + fixes}
        | ({w.decider} if w.decider else set())
        | set(w.track_owners)
    )
    ids |= {c.by for c in unseen + not_shown} | {i for c in not_shown for i in c.routed_to or []}
    required: list[uuid.UUID] = []
    if d is not None:
        ids |= set(d.waiting_on or [])
        if sees and d.status == "working":
            # build-review: Send for approval names who approves before it is sent.
            from oracle.review.state import effective_policy

            required = list((await effective_policy(db, document)).mandatory_reviewer_ids)
            ids |= set(required)
    owner_id = await document_owner(db, document, b.version, w)
    if owner_id:
        ids.add(owner_id)
    from oracle.members.names import display_name

    # Export QA X-15: a name, never an email ("mira.santos@example.com" reads "Mira Santos").
    names = {
        u.id: display_name(u.email, u.name)
        for u in await db.scalars(select(User).where(User.id.in_(ids)))
    }
    now = company_time.now()
    from oracle.simple import visuals

    note_flows = await visuals.flows_for(db, "change", [c.id for c in live + shown])

    from oracle.simple import meetings

    approved_sid = ((d.decider_approval or {}).get("session_id") if d is not None else None) or None
    titles = await meetings.titles_by_session(
        db, sids | {c.session_id for c in shown if c.session_id}
        | ({uuid.UUID(approved_sid)} if approved_sid else set())
    )  # fmt: skip
    line_ids = [x["id"] for blk in page for x in blk["lines"]]
    left_out: list = []
    by_line = await meetings.decided_in(
        db,
        [{"kind": "section", "id": str(document.id), "ref": f"line:{i}"} for i in line_ids],
        left_out,
    )

    def note(c: SimpleChange, kind: str) -> OnePagerNote:
        s = sessions.get(c.session_id) if c.session_id else None
        line_id = str(c.target.get("line_id"))
        return OnePagerNote(
            change_id=c.id,
            line_id=line_id,
            kind=kind,
            by=c.by,  # type: ignore[arg-type]
            by_name=names.get(c.by, "someone"),
            at=c.at,
            in_meeting=s is not None and s.kind == "meeting",
            meeting_title=titles.get(c.session_id) if c.session_id else None,
            before=str(c.before.get("line") or ""),
            after=str(c.after.get("line") or ""),
            sections=[
                OnePagerSectionPatch(
                    key=k,
                    heading=str(p.get("heading") or k),
                    before=_body(c.before, k),
                    after=str(p.get("body") or ""),
                )
                for k, p in (c.after.get("sections") or {}).items()
            ],
            can_undo=(kind == "proposal" and c.by == me)
            or (
                kind == "change"
                and c.by == me
                and s is not None
                and s.closed_at is None
                and (s.last_change_at or s.started_at) > now - IDLE
            ),
            can_decide=kind == "proposal" and may_decide(principal, c),
            adds_feature=line_id.startswith("bets-"),
            flow=visuals.one_pager_flow(note_flows.get(c.id)),
        )

    notes = [note(c, "change") for c in live] + [note(c, "proposal") for c in shown]

    def fixed_out(c: SimpleChange) -> OnePagerFixed:
        s = sessions.get(c.session_id) if c.session_id else None
        key = str(c.target.get("section") or "")
        sec = (c.after.get("sections") or {}).get(key) or {}
        heading = str(sec.get("heading") or key)
        return OnePagerFixed(
            change_id=c.id,
            words=f"Fixed: set to {c.after.get('number') or ''} in “{heading}”",
            can_undo=c.status == "applied"
            and c.by == me
            and s is not None
            and s.closed_at is None
            and (s.last_change_at or s.started_at) > now - IDLE,
        )

    # The draft's number fixes ("Needs a look"), each with its Undo while it can be undone.
    fixed = [fixed_out(c) for c in number_live]
    proposed = {n.line_id for n in notes if n.kind == "proposal"}
    blocks = []
    for spec in b.specs:
        raw = next((x for x in page if x["key"] == spec.key), {"lines": []})
        lines = []
        said_missing = False
        for line in raw["lines"]:
            edited = line["id"] in line_text
            text, full = line_text.get(line["id"], line["text"]), None
            if not edited:
                if template_only(line["text"]):
                    continue  # a template's guidance in a one-pager built before this rule
                if _says_not_in_prd(line["text"]):
                    said_missing = True  # P-9: the block's mark says it, once
                    continue
                srcs = [x for x in b.sections if x.section_key in line["source_keys"]]
                text, full = _tidy(text, spec.max_words, line.get("full"), srcs)
            metric = _metric(line.get("metric"))
            if edited and spec.kind == "metrics":
                metric = metric_of(text)  # the edited words' numbers, never the published
            lines.append(
                OnePagerLine(
                    id=line["id"],
                    text=text,
                    full=full,
                    source_keys=line["source_keys"],
                    metric=metric,
                    state="edited"
                    if edited
                    else "proposal"
                    if line["id"] in proposed
                    else "published",
                    decisions=by_line.get(("section", str(document.id), f"line:{line['id']}"), []),
                )
            )
        blocks.append(
            OnePagerBlock(
                key=spec.key,
                title=spec.title,
                rules=spec.rules,
                kind=spec.kind,
                lines=lines,
                missing=(bool(raw.get("missing")) or said_missing) and not lines,
            )
        )  # type: ignore[arg-type]
    # S10: each bet ("What we will build") carries its visual.
    bets = [x for blk in blocks for x in blk.lines if x.id.startswith("bets-")]
    # Each bet's flow by its key, on the bet it was drawn for (visuals.flows_of_bets); a flow
    # still keyed by a bet's words (0092_bet_flow_line_key) by a bet with those words.
    raw = {x["id"]: x for blk in page for x in blk["lines"]}
    found = await visuals.flows_of_bets(
        db,
        document.id,
        [
            (
                visuals.bet_key(raw.get(x.id) or {"id": x.id}),
                [x.text, (raw.get(x.id) or {}).get("text") or ""],
            )
            for x in bets
        ],
    )
    # The request's own rule (visuals.may_revise of a bet: who changes the PRD directly).
    draws = await visuals.may_revise(db, principal, SimpleVisual(document_id=document.id))
    for x, (sid, flow) in zip(bets, found, strict=True):
        x.flow_subject, x.flow = sid, visuals.one_pager_flow(flow)
        x.can_draw_flow = x.flow is None and draws
    # Reads clearly (2026-10-30): who has it, measures, codes with names, footnotes; the
    # "Needs a look" items for the PRD's owners. After the flows: a flow still keyed by a
    # bet's words is found by the words before codes got their names.
    patched = ((d.overlay or {}).get("sections") or {}) if sees and d else {}
    # A heading's count fixed in the draft (owner, Nov 5): the drafted heading.
    heads = ((d.overlay or {}).get("headings") or {}) if sees and d else {}
    checked = [
        Section(
            section_key=x.section_key,
            heading=heads.get(x.section_key, x.heading),
            body_md=patched.get(x.section_key, x.body_md),
        )
        if x.section_key in patched or x.section_key in heads
        else x
        for x in b.sections
    ]
    looks = one_pager_checks.annotate(blocks, b.sections, checked)
    # A draft in review takes no change that applies (_ensure refuses it): who would apply a
    # fix is offered none until it is approved. Who proposes still proposes, and an open
    # proposal stays on its item.
    held_fix = d is not None and d.status == "submitted" and decides(principal, w)

    def look_out(x: one_pager_checks.Look) -> OnePagerLook:
        fix = None
        if x.fix is not None:
            f = x.fix
            part = f.get("part", "body")
            p = next(
                (c for c in fixes if c.target.get("section") == f["section"]
                 and c.target.get("said") == f["said"]
                 and c.target.get("part", "body") == part),
                None,
            )  # fmt: skip
            if not (held_fix and p is None):
                fix = OnePagerFix(
                    action=NUMBER_OP,
                    target={
                        "document_id": str(document.id),
                        "section": f["section"],
                        "said": f["said"],
                        **({"part": part} if part == "heading" else {}),
                    },
                    before=f["before"],
                    value=f["value"],
                    words=f"Use {f['value']}",
                    proposal=OnePagerFixProposal(
                        change_id=p.id,
                        by_name=names.get(p.by, "someone"),
                        can_decide=may_decide(principal, p),
                        can_undo=p.by == me,
                    )
                    if p is not None
                    else None,
                )
        return OnePagerLook(
            kind=x.kind, text=x.text, where=x.where, source_keys=x.source_keys, fix=fix
        )

    # P-5: each goal code with its name beside it; the Edit box keeps the PRD's words.
    goals = await goal_names(db, b.sections)
    for blk in blocks:
        for x in blk.lines:
            said = x.words or x.full or x.text
            x.text = with_goal_names(x.text, goals)
            x.full = with_goal_names(x.full, goals) if x.full else x.full
            if x.metric is not None:
                x.metric.name = with_goal_names(x.metric.name, goals)
            x.measure = with_goal_names(x.measure, goals) if x.measure else x.measure
            if x.words is None and (x.full or x.text) != said:
                x.words = said
    slice_ = await service.build(db, principal)
    view = (await plan_model.views(db, {document.id})).get(document.id)
    mine = await prd_items(db, document, b, slice_.items, view)
    items = [
        OnePagerItem(
            id=i.id,
            title=i.title,
            horizon=i.horizon,
            start=i.start.date,
            end=i.end.date,
            estimated=i.estimated,
        )
        for i in mine
        if i.status not in ("cut", "merged")
    ]
    called = {m.code: m.name for m in view.milestones if m.name} if view is not None else {}
    # roadmap-milestone-codes: each row reads its milestone's roadmap code, as the Roadmap does.
    plan = plan_strip.strip(
        plan_items(mine, called, roadmap_codes_of(slice_, document.id)), slice_.today, coded=True
    )
    # A dated plan's span is the one its timeline draws (its milestones, or the dates the
    # lead accepted); else the items' dated milestones.
    if view is not None and view.dated and view.span:
        span: tuple[date, date] | None = (view.span.start, view.span.end)
    else:
        span = milestone_span(plan_items(mine, called))
    timeline = OnePagerBlock(
        key=TIMELINE.key, title=TIMELINE.title, rules=TIMELINE.rules, kind="timeline", lines=[]
    )
    draft = None
    if sees and d is not None:
        n = (await drafts.counts(db, [d]))[d.id]
        draft = OnePagerDraft(
            id=d.id,
            status=d.status,
            changes=n,  # type: ignore[arg-type]
            base_version=await db.scalar(
                select(DocumentVersion.number).where(DocumentVersion.id == d.base_version_id)
            )
            if d.base_version_id
            else None,
            decider_approved=d.decider_approval is not None,
            waiting_on=[
                SimplePersonRef(id=i, name=names.get(i, "someone")) for i in d.waiting_on or []
            ],
            reviewers=[SimplePersonRef(id=i, name=names.get(i, "someone")) for i in required],
            can_submit=d.status == "working" and decides(principal, w),
            can_approve=drafts.can_approve(principal, d, drafts_who(w, d.document_id)),
            reminded_at=reminded_at(d),
            can_remind=may_remind(principal, w) and bool(due_reminders(d, now)),
            approved_in=titles.get(uuid.UUID(approved_sid)) if approved_sid else None,
            blocked_by=drafts.held(d),
            decision_notes=[str(x.get("text")) for x in d.decision_notes or []],
        )
    used = {k for blk in page for x in blk["lines"] for k in x["source_keys"]}
    sources = [
        OnePagerSource(
            key=x.section_key,
            heading=heads.get(x.section_key, x.heading),
            body=patched.get(x.section_key, x.body_md),
        )  # fmt: skip
        for x in b.sections
        if x.section_key in used
    ]
    person = lambda i: SimplePersonRef(id=i, name=names.get(i, "someone")) if i else None  # noqa: E731
    waits = (
        [person(i) for i in d.waiting_on or []] if d is not None and d.status == "submitted" else []
    )

    def in_review(c: SimpleChange, kind: str, waiting_on: list) -> OnePagerInReview:
        return OnePagerInReview(
            line_id=str(c.target.get("line_id")),
            kind=kind,  # type: ignore[arg-type]
            before=str(c.before.get("line") or ""),
            after=str(c.after.get("line") or ""),
            by_name=names.get(c.by, "someone"),
            waiting_on=waiting_on,
        )

    return OnePagerOut(
        document=SimpleDocRef(id=document.id, slug=document.slug, title=document.title),
        version=b.version.number,
        published_at=b.version.approved_at,
        owner=person(owner_id) if owner_id in names else None,
        decider=person(w.decider) if w.decider in names else None,
        span_start=span[0] if span else None,
        span_end=span[1] if span else None,
        built_by="oracle" if owner_reads else b.row.built_by,
        writing=not owner_reads and await _writing(db, b),
        built_at=b.row.built_at,  # type: ignore[arg-type]
        blocks=[*blocks, timeline.model_copy(update={"lines": []})],
        timeline=items,
        plan=plan,
        sections=sources,
        left_out=meetings.left_out_entry(left_out),
        notes=notes,
        draft=draft,
        changes_in_review=hidden,
        in_review=[in_review(c, "change", waits) for c in unseen]
        + [in_review(c, "proposal", [person(i) for i in c.routed_to or []]) for c in not_shown],
        can_edit=decides(principal, w),
        can_propose=not decides(principal, w)
        and _me(principal) is not None
        and has_role(principal.role, "commenter"),
        can_start=starts(principal, w),
        fixed=fixed,
        # Who is no owner reads only the items holding a proposal of theirs or one they
        # decide (the Inbox's Open on "Section number on <PRD>" lands there, review Nov 7).
        needs_look=(
            [look_out(x) for x in looks]
            if owns(principal, w, owner_id)
            else [y for y in map(look_out, looks) if y.fix is not None and y.fix.proposal]
        )
        + (
            [OnePagerLook(kind="check", text=t) for t in quality.said(b.row.checks)]
            if owner_reads
            else []
        ),
    )


# --------------------------------------------------------------------------- Remind


async def remind(db: AsyncSession, principal: Any, doc: str) -> OnePagerRemindOut:
    """Nudge each reviewer the PRD's submitted draft waits on (an Inbox notification), each
    at most once a day; commits. 403 to anyone but the PRD's owners and its decider; 409
    with no submitted draft waiting, or when every waiting reviewer was reminded today."""
    from oracle.review.collab import notify

    document = await _document(db, principal, doc, current=True)
    w = await who(db, document)
    if not may_remind(principal, w):
        raise ChangeError(403, "Only the PRD's owners and its decider remind its reviewers")
    d = await _open_draft(db, document, lock=True)
    if d is None or d.status != "submitted" or not d.waiting_on:
        raise ChangeError(409, "No submitted draft of this PRD waits on a review")
    now = company_time.now()
    due = due_reminders(d, now)
    if not due:
        raise ChangeError(409, "Every reviewer it waits on was reminded in the last day")
    me = _me(principal)
    names = {
        u.id: u.name or u.email
        for u in await db.scalars(select(User).where(User.id.in_([*due, me])))
    }
    number = await db.scalar(
        select(DocumentVersion.number).where(DocumentVersion.id == d.version_id)
    )
    n = (await drafts.counts(db, [d]))[d.id]
    waits = f"Version {number} · {n} {'change' if n == 1 else 'changes'}"
    await notify(
        db,
        due,
        kind="review_reminder",
        title=f"{names.get(me, 'Someone')} is waiting for your review of {document.title}",
        actor=principal.actor,
        document_id=document.id,
        version_number=number,
        data={
            "draft_id": str(d.id),
            "href": f"/simple/one-pagers/{document.slug}",
            "waits": waits,
        },
    )
    d.reminders = {**(d.reminders or {}), **{str(i): now.isoformat() for i in due}}
    await audit.record(
        db,
        principal,
        "simple_draft.reminded",
        "simple_draft",
        d.id,
        data={"document_id": str(document.id), "reviewer_ids": [str(i) for i in due]},
    )
    await db.commit()
    return OnePagerRemindOut(
        reminded=[SimplePersonRef(id=i, name=names.get(i, "someone")) for i in due],
        reminded_at=now,
    )


# --------------------------------------------------------------------------- edit_line


def _conflict(message: str, current: str) -> ChangeError:
    return ChangeError(
        409,
        SimpleChangeConflict(
            message=message, current={"line": current}, changed_by=None, changed_at=None
        ).model_dump(mode="json"),
    )


async def _ensure(
    db: AsyncSession, session: SimpleSession, document: Document, base: DocumentVersion
) -> SimpleDraft:
    """The PRD's one shared working draft, opened on the published version when it has
    none; the session joins it. 409 while a submitted draft waits for approval."""
    d = await _open_draft(db, document, lock=True)
    if d is not None and d.status == "submitted":
        raise ChangeError(409, "This PRD's draft is in review: changes wait until it is approved")
    if d is None:
        d = SimpleDraft(
            document_id=document.id,
            base_version_id=base.id,
            status="working",
            overlay={},
            created_by=session.started_by,
            participant_ids=[session.started_by],
        )
        db.add(d)
        await db.flush()
    await drafts.link(db, session, d)
    return d


def _write(d: SimpleDraft, b: Built, line_id: str, values: dict[str, Any]) -> None:
    """The line and every one of its sections, together (a value equal to the published
    one leaves the draft)."""
    ov = dict(d.overlay or {})
    secs, lines = dict(ov.get("sections") or {}), dict(ov.get("lines") or {})
    published_line = _lines(b).get(line_id, {}).get("text")
    if values["line"] == published_line:
        lines.pop(line_id, None)
    else:
        lines[line_id] = values["line"]
    for k, p in (values.get("sections") or {}).items():
        sec = next((s for s in b.sections if s.section_key == k), None)
        if sec is not None and p["body"] == sec.body_md:
            secs.pop(k, None)
        else:
            secs[k] = p["body"]
    d.overlay = {**ov, "sections": secs, "lines": lines}


async def _current(
    db: AsyncSession, b: Built, line_id: str, d: SimpleDraft | None
) -> tuple[str, dict[str, str]]:
    """The line and its sections as the caller reads them: the draft ``d`` overlaid, or the
    published version (None: the caller does not see the draft)."""
    line = _lines(b).get(line_id)
    if line is None:
        raise ChangeError(404, "No such line on this one-pager")
    text = ((d.overlay or {}).get("lines") or {}).get(line_id, line["text"]) if d else line["text"]
    bodies = {}
    for k in line["source_keys"]:
        hb = _section_body(b, d, k)
        if hb is not None:
            bodies[k] = hb[1]
    return text, bodies


async def _apply(db, principal, c: SimpleChange, b: Built, values, session, undo=False) -> None:
    if undo:
        d = await db.get(SimpleDraft, (c.draft_ids or [None])[0], with_for_update=True)
        if d is None or d.status != "working":
            raise ChangeError(
                409, "Its draft was submitted: undo works only inside a working draft"
            )
        await drafts.link(db, session, d)
    else:
        d = await _ensure(db, session, b.document, b.version)
    _write(d, b, str(c.target["line_id"]), values)
    c.draft_ids = [d.id]
    await db.flush()


async def create(db: AsyncSession, principal: Any, body: SimpleChangeIn) -> SimpleChangeResult:
    from oracle.simple import changes

    if body.op == NUMBER_OP:
        return await _create_number(db, principal, body)
    me, now = changes._me(principal), company_time.now()
    doc_id, line_id = body.target.get("document_id"), str(body.target.get("line_id") or "")
    document = await _document(db, principal, str(doc_id))
    await db.execute(select(Document.id).where(Document.id == document.id).with_for_update())
    b = await built(db, document)
    old = body.before.get("line")
    new = " ".join(str(body.after.get("line") or "").split())
    if not isinstance(old, str):
        raise ChangeError(422, "before.line: the line as you saw it")
    # A line shown cut ("…", its whole text behind it) is edited from its whole words
    # (vqa-one-pager): the new words may be as long as a whole line, never cut to LINE_MAX.
    if not new or len(new) > FULL_MAX:
        raise ChangeError(422, f"after.line: 1 to {FULL_MAX} characters")
    block = line_id.rsplit("-", 1)[0]
    if block == "problem" and len(new.split()) > PROBLEM_WORDS:
        raise ChangeError(422, f"The problem is at most {PROBLEM_WORDS} words")
    w = await who(db, document)
    d = await _open_draft(db, document)
    # Who cannot see the working draft proposes against the published line and sections
    # (and a conflict shows them nothing of the draft).
    sees = d is not None and sees_draft(principal, d, w)
    text, bodies = await _current(db, b, line_id, d if sees else None)
    if text != old:
        held = (b.row.held or []) if has_role(principal.role, "owner") else []
        if old in (x["text"] for blk in held for x in blk["lines"] if x["id"] == line_id):
            # Owners read a held build ("Needs a look"); edits act on the last good line.
            raise _conflict(
                "This line is from Oracle's draft that needs a look; edit the last good line",
                text,
            )
        raise _conflict("This line changed since you read it", text)
    if not bodies:
        raise ChangeError(409, "This line rests on no section of the PRD")
    # A published line shown cut patches the facts of its whole text, so the cut tail does
    # not stay in the section beside the new words (vqa-one-pager).
    published = _lines(b).get(line_id) or {}
    whole = published.get("full") if text == published.get("text") else None
    patched = (patch_all(bodies, whole, new) if whole else None) or patch_all(bodies, text, new)
    if patched is None:
        raise ChangeError(
            409,
            "Oracle could not find this line's words in its sections; "
            "open the detailed view to edit them",
        )
    applies = decides(principal, w)
    if not applies and not has_role(principal.role, "commenter"):
        raise ChangeError(403, "Viewers read the one-pager")
    session = await _session_for_change(db, me, body.session_id, applies, now)
    heads = {s.section_key: s.heading for s in b.sections}
    after = {
        "line": new,
        "sections": {k: {"heading": heads.get(k, k), "body": v} for k, v in patched.items()},
    }
    before = {
        "line": text,
        "sections": {k: {"heading": heads.get(k, k), "body": v} for k, v in bodies.items()},
    }
    c = SimpleChange(
        session_id=session.id if session else None,
        document_id=document.id,
        op="edit_line",
        target={"document_id": str(document.id), "line_id": line_id, "version": b.version.number},
        before=before,
        after=after,
        status="applied" if applies else "proposed",
        by=me,
        at=now,
        reason=body.reason,
        routed_to=[] if applies else route(w),
    )
    if applies:
        await _apply(db, principal, c, b, after, session)
        session.last_change_at = now  # type: ignore[union-attr]
    db.add(c)
    await db.flush()
    await audit.record(
        db,
        principal,
        f"simple_change.{c.status}",
        "simple_change",
        c.id,
        data={
            "op": c.op,
            "target": c.target,
            "before": before,
            "after": after,
            "document_id": str(document.id),
        },
    )
    await db.commit()
    return SimpleChangeResult(change=await changes.one_out(db, principal, c), flags=[])


async def decide(db, principal, c: SimpleChange, action: str, reason: str | None, session_id=None):
    from oracle.simple import changes

    me, now = changes._me(principal), company_time.now()
    if not may_decide(principal, c):
        raise ChangeError(403, "Only an owner or the PRD's decider decides this proposal")
    if c.status != "proposed":
        raise ChangeError(409, f"This change is {c.status} already")
    if action == "accept" and c.op == NUMBER_OP:
        document = await db.get(Document, c.document_id)
        await db.execute(select(Document.id).where(Document.id == document.id).with_for_update())
        b = await built(db, document)
        d = await _open_draft(db, document)
        if _number_values(b, d, str(c.target["section"])) != _held(c.before):
            raise await _number_conflict(
                db, b, d, c.target, "outdated: the section changed since the proposal"
            )
        session = await _session_for_change(db, me, session_id, True, now)
        await _apply_number(db, c, b, c.after, session)
        session.last_change_at = now  # type: ignore[union-attr]
    elif action == "accept":
        document = await db.get(Document, c.document_id)
        await db.execute(select(Document.id).where(Document.id == document.id).with_for_update())
        b = await built(db, document)
        text, bodies = await _current(
            db, b, str(c.target["line_id"]), await _open_draft(db, document)
        )
        was = {k: v["body"] for k, v in (c.before.get("sections") or {}).items()}
        if text != c.before.get("line") or bodies != was:
            raise _conflict("outdated: the line or its sections changed since the proposal", text)
        session = await _session_for_change(db, me, session_id, True, now)
        await _apply(db, principal, c, b, c.after, session)
        session.last_change_at = now  # type: ignore[union-attr]
    c.status = "accepted" if action == "accept" else "declined"
    c.decided_by, c.decided_at, c.decision_reason = me, now, reason
    await db.flush()
    await audit.record(
        db,
        principal,
        f"simple_change.{c.status}",
        "simple_change",
        c.id,
        data={"op": c.op, "target": c.target, "reason": reason},
    )
    await db.commit()
    return SimpleChangeResult(change=await changes.one_out(db, principal, c), flags=[])


async def _withdraw(db, principal, c: SimpleChange, me, now):
    """A proposal withdrawn by its author (qa-simple-prd-p3-17): declined by them, the PRD
    untouched; its note leaves the margin."""
    from oracle.simple import changes

    if c.by != me:
        raise ChangeError(403, "Only the person who proposed it withdraws it")
    # Lock the row so a decider's accept and this withdraw never both win.
    await db.refresh(c, with_for_update=True)
    if c.status != "proposed":
        raise ChangeError(409, f"This change is {c.status} already")
    c.status = "declined"
    c.decided_by, c.decided_at = me, now
    c.decision_reason = "Withdrawn by its author"
    await db.flush()
    await audit.record(
        db,
        principal,
        "simple_change.withdrawn",
        "simple_change",
        c.id,
        data={"op": c.op, "target": c.target},
    )
    await db.commit()
    return SimpleChangeResult(change=await changes.one_out(db, principal, c), flags=[])


async def undo(db, principal, c: SimpleChange):
    from oracle.simple import changes

    me, now = changes._me(principal), company_time.now()
    if c.status == "proposed":
        return await _withdraw(db, principal, c, me, now)
    if c.status != "applied":
        raise ChangeError(409, f"Only an applied change undoes; this one is {c.status}")
    if c.by != me:
        raise ChangeError(403, "Only the person who made a change undoes it")
    if await db.scalar(select(SimpleChange.id).where(SimpleChange.undoes_id == c.id)):
        raise ChangeError(409, "This change is undone already")
    session = (
        await db.get(SimpleSession, c.session_id, with_for_update=True) if c.session_id else None
    )
    if session is None or session.closed_at is not None or changes._idle(session, now):
        raise ChangeError(409, "Its session is closed: undo works only in the change's session")
    document = await db.get(Document, c.document_id)
    await db.execute(select(Document.id).where(Document.id == document.id).with_for_update())
    b = await built(db, document)
    held_now, back = c.after, c.before
    if c.op == NUMBER_OP:
        d = await _open_draft(db, document)
        now_held = _number_values(b, d, str(c.target["section"]))
        undone = _number_undone(c, now_held)
        if undone is None:
            raise await _number_conflict(db, b, d, c.target, "Changed since")
        held_now = {**now_held, "number": c.after.get("number")}
        back = {**undone, "number": c.before.get("number")}
    else:
        text, bodies = await _current(
            db, b, str(c.target["line_id"]), await _open_draft(db, document)
        )
        if text != c.after.get("line") or bodies != {
            k: v["body"] for k, v in (c.after.get("sections") or {}).items()
        }:
            raise _conflict("Changed since", text)
    u = SimpleChange(
        session_id=c.session_id,
        document_id=c.document_id,
        op=c.op,
        target=c.target,
        before=held_now,
        after=back,
        status="undone",
        by=me,
        at=now,
        undoes_id=c.id,
        routed_to=[],
        draft_ids=list(c.draft_ids or []),
    )
    if c.op == NUMBER_OP:
        await _apply_number(db, u, b, back, session, undo=True)
    else:
        await _apply(db, principal, u, b, c.before, session, undo=True)
    db.add(u)
    session.last_change_at = now
    await db.flush()
    await audit.record(
        db,
        principal,
        "simple_change.undone",
        "simple_change",
        u.id,
        data={"op": c.op, "target": c.target, "undoes_id": str(c.id)},
    )
    await db.commit()
    return SimpleChangeResult(change=await changes.one_out(db, principal, u), flags=[])


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
        by = SimplePersonRef(id=last.by, name=(u.name or u.email) if u else "someone")
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


async def _apply_number(db, c: SimpleChange, b: Built, values, session, undo=False) -> None:
    if undo:
        d = await db.get(SimpleDraft, (c.draft_ids or [None])[0], with_for_update=True)
        if d is None or d.status != "working":
            raise ChangeError(
                409, "Its draft was submitted: undo works only inside a working draft"
            )
        await drafts.link(db, session, d)
    else:
        d = await _ensure(db, session, b.document, b.version)
    _write_number(d, b, values)
    c.draft_ids = [d.id]
    await db.flush()


async def _create_number(
    db: AsyncSession, principal: Any, body: SimpleChangeIn
) -> SimpleChangeResult:
    from oracle.simple import changes

    me, now = changes._me(principal), company_time.now()
    t = body.target or {}
    key, said = str(t.get("section") or ""), " ".join(str(t.get("said") or "").split())
    part = str(t.get("part") or "body")
    old = str(body.before.get("number") or "").strip()
    new = str(body.after.get("number") or "").strip()
    if not key or not said:
        raise ChangeError(422, "target: the section and the words the number is in")
    if part not in ("body", "heading"):
        raise ChangeError(422, "target.part: body or heading")
    if not re.fullmatch(r"\d[\d,]*(?:\.\d+)?", new) or len(new) > 20:
        raise ChangeError(422, "after.number: a number")
    if not old:
        raise ChangeError(422, "before.number: the number as you saw it")
    document = await _document(db, principal, str(t.get("document_id")))
    await db.execute(select(Document.id).where(Document.id == document.id).with_for_update())
    b = await built(db, document)
    w = await who(db, document)
    d = await _open_draft(db, document)
    sees = d is not None and sees_draft(principal, d, w)
    applies = decides(principal, w)
    if not applies and not has_role(principal.role, "commenter"):
        raise ChangeError(403, "Viewers read the one-pager")
    before = _number_values(b, d if sees else None, key)
    cur = before["sections"][key]
    # A number other than the one its words begin with is stale, as words no longer there.
    stale = said.split()[0].lower() != old.lower()
    patched = None if stale else one_pager_checks.set_number(cur[part], said, new)
    if patched is None:
        raise await _number_conflict(
            db, b, d if sees else None, t, "This number changed since you read it"
        )
    after = {
        "sections": {key: {**cur, part: patched}},
        # A heading's count is no line's words: the lines stay as they are.
        "lines": {
            i: text if part == "heading" else one_pager_checks.set_number(text, said, new) or text
            for i, text in before["lines"].items()
        },
    }
    before |= {"number": old}
    after |= {"number": new}
    session = await _session_for_change(db, me, body.session_id, applies, now)
    c = SimpleChange(
        session_id=session.id if session else None,
        document_id=document.id,
        op=NUMBER_OP,
        target={
            "document_id": str(document.id),
            "section": key,
            "said": said,
            **({"part": part} if part == "heading" else {}),
            "version": b.version.number,
        },
        before=before,
        after=after,
        status="applied" if applies else "proposed",
        by=me,
        at=now,
        reason=body.reason,
        routed_to=[] if applies else route(w),
    )
    if applies:
        await _apply_number(db, c, b, after, session)
        session.last_change_at = now  # type: ignore[union-attr]
    db.add(c)
    await db.flush()
    await audit.record(
        db,
        principal,
        f"simple_change.{c.status}",
        "simple_change",
        c.id,
        data={
            "op": c.op,
            "target": c.target,
            "before": before,
            "after": after,
            "document_id": str(document.id),
        },
    )
    await db.commit()
    return SimpleChangeResult(change=await changes.one_out(db, principal, c), flags=[])


# --------------------------------------------------------------------------- submit


def patched_markdown(
    base: DocumentVersion,
    sections: list[Section],
    patched: dict[str, str],
    headings: dict[str, str] | None = None,
) -> str:
    """The base version's markdown with each patched section's body replaced, and each
    drafted heading (``headings``: key -> heading) written over its own, its ``{#key}`` kept
    so the section's key and links do not change."""
    md = base.markdown
    unpatched = "Section {!r} could not be patched; open the detailed view to edit it"
    for sec in sections:
        head = (headings or {}).get(sec.section_key)
        if head is None or head == sec.heading:
            continue
        key, said = re.escape(sec.section_key), re.escape(sec.heading)
        # An ATX heading ("## Later · 8 items {#later}") or a setext one (its words over a
        # line of "=" or "-"), its key kept.
        atx = re.compile(rf"^(#{{1,6}}[ \t]+){said}([ \t]*\{{#{key}\}}[ \t]*)$", re.M)
        setext = re.compile(rf"^(){said}([ \t]*\{{#{key}\}}[ \t]*\n(?:=+|-+)[ \t]*)$", re.M)
        n = 0
        for line in (atx, setext):
            md, n = line.subn(lambda m, h=head: m.group(1) + h + m.group(2), md, count=1)
            if n:
                break
        if not n:
            raise ChangeError(
                409,
                f"The heading “{sec.heading}” is not in the PRD's text as a heading with its"
                f" key {{#{sec.section_key}}}, so its new words could not be written; open the"
                " detailed view to edit it",
            )
    for sec in sections:
        new = patched.get(sec.section_key)
        if new is None or new == sec.body_md:
            continue
        old = sec.body_md.strip("\n")
        if old and old in md:
            md = md.replace(old, new.strip("\n"), 1)
        else:
            raise ChangeError(409, unpatched.format(sec.heading))
    return md


async def pdf_html(db: AsyncSession, principal: Any, doc: str) -> tuple[str, str]:
    """The one-pager's branded page (the published lines: a PDF is shared), and a file
    stem."""
    from oracle.branding import BRAND_CSS, accent_css, load_brand, render_brand_header

    out = await read(db, principal, doc, held=False, current=True)
    brand = await load_brand(db)
    # prd-timeline: a PRD with a dated plan prints its timeline page, then a page per milestone.
    view = (await plan_model.views(db, {out.document.id})).get(out.document.id)
    if view is not None:
        view = await plan_model.enrich(db, out.document.id, view)
    timeline = view if view is not None and view.dated and view.span else None
    parts = [
        "<!doctype html><html><head><meta charset='utf-8'>",
        "" if timeline else '<meta name="oracle-page-fit" content="one_page">',
        f"<title>{escape(out.document.title)}</title><style>{PAGE_CSS}{BRAND_CSS}"
        f"{accent_css(brand)}{PAGE_NUMBERS if timeline else ''}</style></head><body>",
        str(render_brand_header(brand)),
        f"<h1>{escape(out.document.title)}</h1>",
    ]
    meta = [f"Version {out.version}"]
    if out.published_at:
        zone = await company_time.company_time_zone(db)
        meta.append(f"published {company_time.day_in_words(out.published_at, zone)}")
    meta.append(f"owner {escape(out.owner.name)}" if out.owner else "No owner yet")
    if out.decider:
        meta.append(f"decider {escape(out.decider.name)}")
    if out.span_start and out.span_end:
        meta.append(span_words(out.span_start, out.span_end))
    parts.append(f"<div class='meta'>{' · '.join(meta)}</div>")
    published_lines = await _published_lines(db, out)
    for blk in out.blocks:
        parts.append(f"<h2>{escape(blk.title)}</h2>")
        if blk.kind == "timeline":
            if timeline is not None:
                today = await company_time.company_today(db)
                parts.append(_timeline_html(timeline, today))
            else:
                parts.append(_plan_html(out.plan))
            continue
        items = []
        for line in blk.lines:
            pub = published_lines.get(line.id)
            if pub and line.state != "published":
                pub_text = _tidy(pub["text"], LINE_MAX, None, [])[0]
            else:
                pub_text = line.text
            text = escape(pub_text)
            m = _metric(pub.get("metric")) if pub else None
            m = m if pub else line.metric
            if m:
                span = f"{escape(m.from_ or '—')} → {escape(m.to)}"
                text = f"<span class='metric'>{escape(m.name)}: <b>{span}</b></span>"
            items.append(f"<li>{text}</li>")
        parts.append(f"<ul>{''.join(items)}</ul>" if items else f"<p>{NOT_WRITTEN}</p>")
    if timeline is not None:
        parts += [_part_html(timeline, m) for m in timeline.milestones]
    parts.append("</body></html>")
    return "".join(parts), f"{out.document.slug}-v{out.version}-one-pager"
