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
"""

import hashlib
import json
import re
import uuid
from dataclasses import dataclass
from html import escape
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, company_time, safe_yaml
from oracle.auth.models import User
from oracle.authz import has_role
from oracle.docs import visibility
from oracle.docs.models import Document, DocumentVersion, Section
from oracle.review.models import DocumentReviewPolicy
from oracle.roadmap.models import ProductTrack
from oracle.simple import drafts
from oracle.simple.changes import IDLE, ChangeError, _session_for_change
from oracle.simple.models import SimpleChange, SimpleDraft, SimpleOnePager, SimpleSession
from oracle.simple.schemas import (
    OnePagerBlock,
    OnePagerDraft,
    OnePagerItem,
    OnePagerLine,
    OnePagerMetric,
    OnePagerNote,
    OnePagerOut,
    OnePagerSectionPatch,
    SimpleChangeConflict,
    SimpleChangeIn,
    SimpleChangeResult,
    SimpleDocRef,
    SimplePersonRef,
)

OPS: frozenset[str] = frozenset({"edit_line"})
LINE_MAX = 300
PROBLEM_WORDS = 60


@dataclass(frozen=True)
class Spec:
    """One block: its words, caps and either the template's section keys or the heading
    words that map sections to it."""

    key: str
    title: str
    rules: str
    kind: str
    min_lines: int
    max_lines: int
    max_words: int
    whole_block: bool = False
    words: tuple[str, ...] = ()
    sections: tuple[str, ...] = ()


# D5's six fallback blocks. Mapping tries them in MATCH order (the narrower words first).
FALLBACK: tuple[Spec, ...] = (
    Spec(
        "problem",
        "Problem and who has it",
        "At most 60 words",
        "text",
        1,
        1,
        PROBLEM_WORDS,
        True,
        (
            "problem",
            "who has it",
            "who",
            "user",
            "customer",
            "why",
            "background",
            "context",
            "pain",
        ),
    ),
    Spec(
        "bets",
        "What we will build",
        "3-5 bets",
        "lines",
        3,
        5,
        30,
        False,
        (
            "build",
            "solution",
            "scope",
            "bet",
            "requirement",
            "feature",
            "proposal",
            "approach",
            "what we",
        ),
    ),
    Spec(
        "outcomes",
        "Outcomes and how we measure them",
        "2-4 metrics, from → to",
        "metrics",
        2,
        4,
        30,
        False,
        ("outcome", "metric", "success", "measure", "goal", "kpi", "impact"),
    ),
    Spec(
        "not_doing",
        "Not doing",
        "At most 5 lines",
        "lines",
        0,
        5,
        30,
        False,
        ("not doing", "non-goal", "non goal", "out of scope", "won't", "not in scope"),
    ),
    Spec(
        "risks",
        "Risks and open decisions",
        "At most 5",
        "lines",
        0,
        5,
        30,
        False,
        (
            "risk",
            "open question",
            "open decision",
            "decision",
            "assumption",
            "dependenc",
            "question",
        ),
    ),
)
MATCH = ("not_doing", "risks", "outcomes", "problem", "bets")
TIMELINE = Spec("timeline", "Timeline", "The PRD's roadmap slice", "timeline", 0, 0, 0)

_BULLET = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$")
_SENTENCE = re.compile(r"(?<=[.!?])\s+")
_METRIC = re.compile(
    r"^(?P<name>.*?)[:\s,-]*\s(?:from\s+)?(?P<from>[~<>]?[$€£]?\d[\d.,]*\s?(?:%|ms|s|x|k|m|days?|"
    r"hours?|minutes?)?)\s*(?:→|->|\bto\b)\s*(?P<to>[~<>]?[$€£]?\d[\d.,]*\s?(?:%|ms|s|x|k|m|"
    r"days?|hours?|minutes?)?)",
    re.IGNORECASE,
)
_MD = re.compile(r"[*_`]+|\[([^\]]*)\]\([^)]*\)|\[\^?[\w-]+\]")


# --------------------------------------------------------------------------- blocks


def _template_specs(body: str | None) -> tuple[Spec, ...] | None:
    """The blocks a template names in its front matter (``one_pager.blocks``), or None."""
    if not body or not body.startswith("---"):
        return None
    end = body.find("\n---", 3)
    if end < 0:
        return None
    try:
        meta = safe_yaml.load(body[3:end]) or {}
    except Exception:  # noqa: BLE001 - a template that does not parse names no blocks
        return None
    blocks = ((meta.get("one_pager") or {}) if isinstance(meta, dict) else {}).get("blocks")
    if not isinstance(blocks, list) or not blocks:
        return None
    out = []
    for b in blocks:
        if not isinstance(b, dict) or not b.get("key") or not b.get("title"):
            continue
        n = int(b.get("max_lines") or 5)
        out.append(
            Spec(
                str(b["key"]),
                str(b["title"]),
                f"At most {n} lines",
                "lines",
                0,
                max(1, min(n, 5)),
                30,
                sections=tuple(str(s) for s in b.get("sections") or []),
            )
        )
    return tuple(out) or None


async def specs_for(db: AsyncSession, document: Document) -> tuple[Spec, ...]:
    from oracle.templates.models import Template, TemplateVersion

    if document.template:
        body = await db.scalar(
            select(TemplateVersion.body)
            .join(Template, Template.id == TemplateVersion.template_id)
            .where(Template.key == document.template)
            .order_by(TemplateVersion.version.desc())
            .limit(1)
        )
        found = _template_specs(body)
        if found:
            return found
    return FALLBACK


def mapping(specs: tuple[Spec, ...], sections: list[Section]) -> dict[str, list[Section]]:
    """Each block's sections: the template's keys, else the first block (MATCH order)
    whose words the section's heading or key holds. Level-1 headings (the title) and empty
    sections map nowhere."""
    out: dict[str, list[Section]] = {s.key: [] for s in specs}
    by_key = {s.key: s for s in specs}
    explicit = any(s.sections for s in specs)
    for sec in sections:
        if sec.level <= 1 or not (sec.body_text or "").strip():
            continue
        if explicit:
            for s in specs:
                if sec.section_key in s.sections:
                    out[s.key].append(sec)
            continue
        name = f"{sec.heading} {sec.section_key}".casefold().replace("_", " ")
        for k in MATCH:
            spec = by_key.get(k)
            if spec and any(w in name for w in spec.words):
                out[k].append(sec)
                break
    return out


def sections_hash(version: DocumentVersion, specs, mapped: dict[str, list[Section]]) -> str:
    raw = json.dumps(
        [
            str(version.id),
            [s.key for s in specs],
            {k: [(s.section_key, s.content_hash) for s in v] for k, v in mapped.items()},
        ],
        sort_keys=True,
    )
    return hashlib.sha256(raw.encode()).hexdigest()


def _plain(text: str) -> str:
    return " ".join(_MD.sub(lambda m: m.group(1) or "", text).split())


def _words(text: str, n: int) -> str:
    w = text.split()
    return text if len(w) <= n else " ".join(w[:n]).rstrip(",;:") + "…"


def _facts(sec: Section) -> list[str]:
    """A section's bullets, else its sentences."""
    bullets = [
        _plain(m.group(1)) for line in sec.body_md.splitlines() if (m := _BULLET.match(line))
    ]
    if bullets:
        return [b for b in bullets if b]
    return [s for s in (_plain(x) for x in _SENTENCE.split(sec.body_text or "")) if s]


def metric_of(text: str) -> OnePagerMetric | None:
    m = _METRIC.search(text)
    if not m:
        return None
    name = m.group("name").strip(" :,-") or text
    return OnePagerMetric.model_validate(
        {"name": name, "from": m.group("from").strip(), "to": m.group("to").strip()}
    )


def extract(specs: tuple[Spec, ...], mapped: dict[str, list[Section]]) -> list[dict[str, Any]]:
    """Oracle's quick read: each block's lines from its sections' bullets and sentences,
    capped."""
    out = []
    for spec in specs:
        secs = mapped.get(spec.key, [])
        lines: list[dict[str, Any]] = []
        if spec.whole_block:
            text, keys = "", []
            for sec in secs:
                for fact in _facts(sec):
                    if len(text.split()) >= spec.max_words:
                        break
                    text = f"{text} {fact}".strip()
                    if sec.section_key not in keys:
                        keys.append(sec.section_key)
            if text:
                lines.append({"text": _words(text, spec.max_words), "source_keys": keys})
        else:
            facts = [(f, sec.section_key) for sec in secs for f in _facts(sec)]
            if spec.kind == "metrics":
                facts = sorted(facts, key=lambda f: metric_of(f[0]) is None)
            for fact, key in facts[: spec.max_lines]:
                line: dict[str, Any] = {"text": _words(fact, spec.max_words), "source_keys": [key]}
                if spec.kind == "metrics" and (m := metric_of(fact)):
                    line["metric"] = m.model_dump(by_alias=True)
                lines.append(line)
        out.append({"key": spec.key, "lines": lines})
    return out


def _numbered(blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    for b in blocks:
        for i, line in enumerate(b["lines"], 1):
            line["id"] = f"{b['key']}-{i}"
    return blocks


def clean_answer(
    answer: Any, specs: tuple[Spec, ...], mapped: dict[str, list[Section]]
) -> list[dict[str, Any]] | None:
    """The job's answer, held to each block's caps and its own section keys; None when it
    is not usable (the quick read stays)."""
    given = {b.get("key"): b for b in (answer or {}).get("blocks") or [] if isinstance(b, dict)}
    out = []
    for spec in specs:
        allowed = {s.section_key for s in mapped.get(spec.key, [])}
        lines = []
        for raw in (given.get(spec.key) or {}).get("lines") or []:
            if not isinstance(raw, dict):
                continue
            text = " ".join(str(raw.get("text") or "").split())[:LINE_MAX]
            keys = [str(k) for k in raw.get("source_keys") or [] if str(k) in allowed]
            if not text or not keys:
                continue
            line: dict[str, Any] = {"text": _words(text, spec.max_words), "source_keys": keys}
            m = raw.get("metric")
            if spec.kind == "metrics" and isinstance(m, dict) and m.get("name") and m.get("to"):
                line["metric"] = {
                    "name": str(m["name"])[:120],
                    "from": str(m.get("from") or "")[:40],
                    "to": str(m["to"])[:40],
                }
            lines.append(line)
        lines = lines[: spec.max_lines]
        facts = sum(len(_facts(x)) for x in mapped.get(spec.key, []))
        if len(lines) < min(spec.min_lines, facts):
            return None
        out.append({"key": spec.key, "lines": lines})
    return _numbered(out)


# --------------------------------------------------------------------------- reading


async def _document(db: AsyncSession, principal: Any, doc: str) -> Document:
    cond = Document.slug == doc
    try:
        cond = cond | (Document.id == uuid.UUID(doc))
    except ValueError:
        pass
    d = await db.scalar(select(Document).where(cond, Document.kind == "prd"))
    if d is None or not visibility.can_see(principal, d) or getattr(d, "deleted_at", None):
        raise ChangeError(404, "No such PRD")
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


@dataclass
class Built:
    document: Document
    version: DocumentVersion
    specs: tuple[Spec, ...]
    sections: list[Section]
    row: SimpleOnePager


async def built(db: AsyncSession, document: Document, *, queue: bool = True) -> Built:
    """The cached one-pager of the published version and its mapped sections; built now
    (Oracle's quick read) and the ``one_pager`` job queued when the hash is new."""
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
            blocks=_numbered(extract(specs, mapped)),
            built_by="extract",
            built_at=company_time.now(),
        )
        db.add(row)
        await db.flush()
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
                    {"key": x.section_key, "heading": x.heading, "text": x.body_text}
                    for x in mapped.get(sp.key, [])
                ],
            }
            for sp in specs
        ],
    }
    answer = await ask("one_pager", payload)
    blocks = clean_answer(answer, specs, mapped)
    if blocks is None:
        return {"built": False, "reason": "the answer missed a block's lines or section keys"}
    row = await s.scalar(
        select(SimpleOnePager).where(
            SimpleOnePager.version_id == v.id, SimpleOnePager.sections_hash == h
        )
    )
    if row is None:
        row = SimpleOnePager(document_id=document.id, version_id=v.id, sections_hash=h)
        s.add(row)
    row.blocks, row.built_by, row.job_id = blocks, "oracle", job.id
    row.built_at = company_time.now()
    await s.flush()
    return {"built": True, "sections_hash": h}


# --------------------------------------------------------------------------- who


@dataclass
class Who:
    decider: uuid.UUID | None
    reviewers: list[uuid.UUID]
    track_owners: dict[uuid.UUID, str]  # id -> role
    company_owners: list[uuid.UUID]


async def who(db: AsyncSession, document: Document) -> Who:
    policy = await db.scalar(
        select(DocumentReviewPolicy).where(DocumentReviewPolicy.document_id == document.id)
    )
    owners = {
        u.id: u.role
        for u in await db.scalars(
            select(User)
            .join(ProductTrack, ProductTrack.owner_id == User.id)
            .where(ProductTrack.prd_document_id == document.id, User.disabled_at.is_(None))
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


def _body(values: dict[str, Any], key: str) -> str:
    return str(((values.get("sections") or {}).get(key) or {}).get("body") or "")


def _section_body(b: Built, d: SimpleDraft | None, key: str) -> tuple[str, str] | None:
    sec = next((s for s in b.sections if s.section_key == key), None)
    if sec is None:
        return None
    patched = ((d.overlay or {}).get("sections") or {}) if d else {}
    return sec.heading, patched.get(key, sec.body_md)


def patch(body: str, old: str, new: str) -> str:
    """The section with the line's new words: the old line's words replaced where the
    section holds them (a bullet, a sentence), else the new line added as a bullet."""
    if old and old.rstrip("…") in body:
        return body.replace(old.rstrip("…"), new, 1)
    for line in body.splitlines():
        m = _BULLET.match(line)
        if m and _plain(m.group(1)) == old:
            return body.replace(m.group(1), new, 1)
    sep = "" if body.endswith("\n") or not body else "\n"
    return f"{body}{sep}\n- {new}\n"


# --------------------------------------------------------------------------- the read


async def read(db: AsyncSession, principal: Any, doc: str) -> OnePagerOut:
    from oracle.simple import service

    document = await _document(db, principal, doc)
    b = await built(db, document)
    await db.commit()
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
                SimpleChange.op == "edit_line",
                SimpleChange.status == "proposed",
            )
            .order_by(SimpleChange.at)
        )
    )
    shown = [c for c in proposals if sees_change(principal, c)]
    hidden = (len(proposals) - len(shown)) + (
        0 if sees or d is None else (await drafts.counts(db, [d]))[d.id]
    )
    live = [c for c in live if c.op == "edit_line"]
    sids = {c.session_id for c in live if c.session_id}
    sessions = (
        {s.id: s for s in await db.scalars(select(SimpleSession).where(SimpleSession.id.in_(sids)))}
        if sids
        else {}
    )
    ids = {c.by for c in live + shown} | ({w.decider} if w.decider else set()) | set(w.track_owners)
    if d is not None:
        ids |= set(d.waiting_on or [])
    owner_id = next(iter(w.track_owners), None) or b.version.imported_by
    if owner_id:
        ids.add(owner_id)
    names = {
        u.id: u.name or u.email for u in await db.scalars(select(User).where(User.id.in_(ids)))
    }
    now = company_time.now()

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
            can_undo=kind == "change"
            and c.by == me
            and s is not None
            and s.closed_at is None
            and (s.last_change_at or s.started_at) > now - IDLE,
            can_decide=kind == "proposal" and may_decide(principal, c),
            adds_feature=line_id.startswith("bets-"),
        )

    notes = [note(c, "change") for c in live] + [note(c, "proposal") for c in shown]
    proposed = {n.line_id for n in notes if n.kind == "proposal"}
    blocks = []
    for spec in b.specs:
        raw = next((x for x in b.row.blocks if x["key"] == spec.key), {"lines": []})
        lines = []
        for line in raw["lines"]:
            edited = line["id"] in line_text
            lines.append(
                OnePagerLine(
                    id=line["id"],
                    text=line_text.get(line["id"], line["text"]),
                    source_keys=line["source_keys"],
                    metric=OnePagerMetric.model_validate(line["metric"])
                    if line.get("metric")
                    else None,
                    state="edited"
                    if edited
                    else "proposal"
                    if line["id"] in proposed
                    else "published",
                )
            )
        blocks.append(
            OnePagerBlock(
                key=spec.key, title=spec.title, rules=spec.rules, kind=spec.kind, lines=lines
            )
        )  # type: ignore[arg-type]
    slice_ = await service.build(db, principal, prd=str(document.id))
    items = [
        OnePagerItem(
            id=i.id,
            title=i.title,
            horizon=i.horizon,
            start=i.start.date,
            end=i.end.date,
            estimated=i.estimated,
        )
        for i in slice_.items
        if i.status != "cut"
    ]
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
            can_submit=d.status == "working" and decides(principal, w),
        )
    person = lambda i: SimplePersonRef(id=i, name=names.get(i, "someone")) if i else None  # noqa: E731
    return OnePagerOut(
        document=SimpleDocRef(id=document.id, slug=document.slug, title=document.title),
        version=b.version.number,
        published_at=b.version.approved_at,
        owner=person(owner_id),
        decider=person(w.decider),
        span_start=min((i.start for i in items), default=None),
        span_end=max((i.end for i in items), default=None),
        built_by=b.row.built_by,
        built_at=b.row.built_at,  # type: ignore[arg-type]
        blocks=[*blocks, timeline.model_copy(update={"lines": []})],
        timeline=items,
        notes=notes,
        draft=draft,
        changes_in_review=hidden,
        can_edit=decides(principal, w),
        can_propose=not decides(principal, w)
        and _me(principal) is not None
        and has_role(principal.role, "commenter"),
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
    d.overlay = {"sections": secs, "lines": lines}


async def _current(db: AsyncSession, b: Built, line_id: str) -> tuple[str, dict[str, str]]:
    d = await _open_draft(db, b.document)
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

    me, now = changes._me(principal), company_time.now()
    doc_id, line_id = body.target.get("document_id"), str(body.target.get("line_id") or "")
    document = await _document(db, principal, str(doc_id))
    await db.execute(select(Document.id).where(Document.id == document.id).with_for_update())
    b = await built(db, document)
    old = body.before.get("line")
    new = " ".join(str(body.after.get("line") or "").split())
    if not isinstance(old, str):
        raise ChangeError(422, "before.line: the line as you saw it")
    if not new or len(new) > LINE_MAX:
        raise ChangeError(422, f"after.line: 1 to {LINE_MAX} characters")
    block = line_id.rsplit("-", 1)[0]
    if block == "problem" and len(new.split()) > PROBLEM_WORDS:
        raise ChangeError(422, f"The problem is at most {PROBLEM_WORDS} words")
    text, bodies = await _current(db, b, line_id)
    if text != old:
        raise _conflict("This line changed since you read it", text)
    if not bodies:
        raise ChangeError(409, "This line rests on no section of the PRD")
    w = await who(db, document)
    applies = decides(principal, w)
    if not applies and not has_role(principal.role, "commenter"):
        raise ChangeError(403, "Viewers read the one-pager")
    session = await _session_for_change(db, me, body.session_id, applies, now)
    heads = {s.section_key: s.heading for s in b.sections}
    after = {
        "line": new,
        "sections": {
            k: {"heading": heads.get(k, k), "body": patch(v, text, new)} for k, v in bodies.items()
        },
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


async def decide(db, principal, c: SimpleChange, action: str, reason: str | None):
    from oracle.simple import changes

    me, now = changes._me(principal), company_time.now()
    if not may_decide(principal, c):
        raise ChangeError(403, "Only an owner or the PRD's decider decides this proposal")
    if c.status != "proposed":
        raise ChangeError(409, f"This change is {c.status} already")
    if action == "accept":
        document = await db.get(Document, c.document_id)
        await db.execute(select(Document.id).where(Document.id == document.id).with_for_update())
        b = await built(db, document)
        text, bodies = await _current(db, b, str(c.target["line_id"]))
        was = {k: v["body"] for k, v in (c.before.get("sections") or {}).items()}
        if text != c.before.get("line") or bodies != was:
            raise _conflict("outdated: the line or its sections changed since the proposal", text)
        session = await _session_for_change(db, me, None, True, now)
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


async def undo(db, principal, c: SimpleChange):
    from oracle.simple import changes

    me, now = changes._me(principal), company_time.now()
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
    text, bodies = await _current(db, b, str(c.target["line_id"]))
    if text != c.after.get("line") or bodies != {
        k: v["body"] for k, v in (c.after.get("sections") or {}).items()
    }:
        raise _conflict("Changed since", text)
    u = SimpleChange(
        session_id=c.session_id,
        document_id=c.document_id,
        op=c.op,
        target=c.target,
        before=c.after,
        after=c.before,
        status="undone",
        by=me,
        at=now,
        undoes_id=c.id,
        routed_to=[],
        draft_ids=list(c.draft_ids or []),
    )
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


# --------------------------------------------------------------------------- submit


def patched_markdown(
    base: DocumentVersion, sections: list[Section], patched: dict[str, str]
) -> str:
    """The base version's markdown with each patched section's body replaced."""
    md = base.markdown
    for sec in sections:
        new = patched.get(sec.section_key)
        if new is None or new == sec.body_md:
            continue
        old = sec.body_md.strip("\n")
        if old and old in md:
            md = md.replace(old, new.strip("\n"), 1)
        else:
            raise ChangeError(
                409,
                f"Section {sec.heading!r} could not be patched; open the detailed view to edit it",
            )
    return md


# --------------------------------------------------------------------------- PDF


PAGE_CSS = """
@page { size: A4; margin: 14mm 16mm; }
body { font-family: "Inter", "Helvetica Neue", Arial, sans-serif; color: #1c1f24;
  font-size: 10pt; line-height: 1.4; margin: 0; }
h1 { font-size: 17pt; margin: 4px 0 2px; }
.meta { color: #5b6270; font-size: 8.5pt; margin-bottom: 10px; }
h2 { font-size: 9pt; text-transform: uppercase; letter-spacing: .06em; color: #5b6270;
  margin: 10px 0 3px; border-top: 1px solid #e3e5e9; padding-top: 6px; }
ul { margin: 0; padding-left: 16px; } li { margin: 1px 0; }
.metric b { font-variant-numeric: tabular-nums; }
.strip { display: flex; gap: 4px; flex-wrap: wrap; }
.bar { border: 1px solid #c9ced6; border-radius: 3px; padding: 1px 5px; font-size: 8pt; }
.bar.est { border-style: dashed; color: #5b6270; }
"""


async def pdf_html(db: AsyncSession, principal: Any, doc: str) -> tuple[str, str]:
    """The one-pager's branded page (the published lines: a PDF is shared), and a file
    stem."""
    from oracle.branding import BRAND_CSS, accent_css, load_brand, render_brand_header

    out = await read(db, principal, doc)
    brand = await load_brand(db)
    parts = [
        "<!doctype html><html><head><meta charset='utf-8'>",
        '<meta name="oracle-page-fit" content="one_page">',
        f"<title>{escape(out.document.title)}</title><style>{PAGE_CSS}{BRAND_CSS}"
        f"{accent_css(brand)}</style></head><body>",
        str(render_brand_header(brand)),
        f"<h1>{escape(out.document.title)}</h1>",
    ]
    meta = [f"Version {out.version}"]
    if out.published_at:
        meta.append(f"published {out.published_at.date().isoformat()}")
    if out.owner:
        meta.append(f"owner {escape(out.owner.name)}")
    if out.decider:
        meta.append(f"decider {escape(out.decider.name)}")
    if out.span_start and out.span_end:
        meta.append(f"{out.span_start.isoformat()} – {out.span_end.isoformat()}")
    parts.append(f"<div class='meta'>{' · '.join(meta)}</div>")
    published_lines = await _published_lines(db, out)
    for blk in out.blocks:
        parts.append(f"<h2>{escape(blk.title)}</h2>")
        if blk.kind == "timeline":
            bars = "".join(
                f"<span class='bar{' est' if i.estimated else ''}'>{escape(i.title)} · "
                f"{i.start.isoformat()} – {i.end.isoformat()}</span>"
                for i in out.timeline
            )
            parts.append(f"<div class='strip'>{bars or 'No roadmap items yet'}</div>")
            continue
        items = []
        for line in blk.lines:
            text = escape(published_lines.get(line.id, line.text))
            if line.metric:
                m = line.metric
                span = f"{escape(m.from_ or '—')} → {escape(m.to)}"
                text = f"<span class='metric'>{escape(m.name)}: <b>{span}</b></span>"
            items.append(f"<li>{text}</li>")
        parts.append(f"<ul>{''.join(items)}</ul>" if items else "<p>—</p>")
    parts.append("</body></html>")
    return "".join(parts), f"{out.document.slug}-v{out.version}-one-pager"


async def _published_lines(db: AsyncSession, out: OnePagerOut) -> dict[str, str]:
    row = await db.scalar(
        select(SimpleOnePager)
        .join(DocumentVersion, DocumentVersion.id == SimpleOnePager.version_id)
        .where(SimpleOnePager.document_id == out.document.id, DocumentVersion.number == out.version)
        .order_by(SimpleOnePager.built_at.desc())
        .limit(1)
    )
    return {
        line["id"]: line["text"] for blk in (row.blocks if row else []) for line in blk["lines"]
    }
