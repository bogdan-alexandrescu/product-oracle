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

**Remind** (owner, 2026-10-26): on a submitted draft, the PRD's owners (company owners, its
track owners) and its decider press Remind (:func:`remind`): each reviewer the draft waits
on gets an Inbox nudge "<name> is waiting for your review of <PRD>" (``review_reminder``),
at most once a day per reviewer (``simple_drafts.reminders``), audited. It changes no
document data, so it is not a change-engine op.
"""

import hashlib
import json
import re
import uuid
from dataclasses import dataclass
from datetime import date, datetime, timedelta
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
from oracle.simple import drafts, plan_strip
from oracle.simple import plan as plan_model
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
    OnePagerRemindOut,
    OnePagerSectionPatch,
    OnePagerSource,
    SimpleChangeConflict,
    SimpleChangeIn,
    SimpleChangeResult,
    SimpleDocRef,
    SimplePersonRef,
)

OPS: frozenset[str] = frozenset({"edit_line"})
LINE_MAX = 300
PROBLEM_WORDS = 60
# A shortened line keeps its whole text (at most this long) for "Show all".
FULL_MAX = 2000


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
# A markdown table's separator row ("|---|:---:|", GFM's "|-|-|" too); its header is the row
# above it.
# A template's guidance (CLD's production walk, 2026-10-27): HTML comments, and lines that are
# only placeholders ("<Milestone>: <Feature>") or arrows ("→") are never a one-pager line.
_COMMENT = re.compile(r"<!--.*?(?:-->|\Z)", re.S)
_PLACEHOLDER = re.compile(r"<[^<>\n]*>")
_WORDY = re.compile(r"[^\W_]")
_TABLE_SEP = re.compile(r"^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$")
_CELL_SPLIT = re.compile(r"(?<!\\)\|")


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


def _uncomment(text: str) -> str:
    return _COMMENT.sub(" ", text)


def template_only(text: str) -> bool:
    """Only a template's placeholders, arrows or punctuation: no words of the PRD's own."""
    return not _WORDY.search(_PLACEHOLDER.sub("", _uncomment(text)))


def clip(text: str, words: int, chars: int = LINE_MAX) -> tuple[str, str | None]:
    """A line held to its words and characters, cut at a word boundary with "…", and the
    whole text when it was cut (else None)."""
    text = " ".join(text.split())
    shown = _words(text, words)
    if len(shown) > chars:
        head = shown[: chars - 1]
        head = head.rsplit(" ", 1)[0] if " " in head else head
        shown = head.rstrip(",;: …") + "…"
    return shown, (text[:FULL_MAX] if shown != text else None)


def _tidy(
    text: str, words: int, full: str | None, sources: list[Section]
) -> tuple[str, str | None]:
    """A stored line as it reads: comments out, cut at a word boundary (a line cut mid-word
    by an older build loses its broken word; one that is its source fact whole stays), and
    its whole text when it is shortened (as stored, else its own source fact, else its prose
    sections' sentences)."""
    text = " ".join(_uncomment(text).split())
    own = _own_fact(text, sources)
    if len(text) >= LINE_MAX and not text.endswith("…") and own != text:
        text = (text.rsplit(" ", 1)[0] if " " in text else text).rstrip(",;:") + "…"
    shown, cut = clip(text, words)
    if not shown.endswith("…"):
        return shown, None
    whole = full or (cut if cut and not cut.endswith("…") else None) or own
    # A prose section's line is its sentences; a bullet's or a row's is its own fact only.
    whole = whole or " ".join(f for sec in sources if not _listed(sec) for f in _facts(sec))
    whole = whole[:FULL_MAX] if whole else None
    return shown, (whole if whole and whole != shown else None)


def _listed(sec: Section) -> bool:
    """Whether a section's facts are its bullets or table rows (one line each), not prose."""
    rows, rest = _tables(_uncomment(sec.body_md or ""))
    return bool(rows) or any(_BULLET.match(line) for line in rest)


def _own_fact(text: str, sources: list[Section]) -> str | None:
    """The source fact a stored line was taken from: the first that starts with the line's
    words (less a trailing "…"), else None."""
    head = text.removesuffix("…").rstrip(",;: ")
    if not head:
        return None
    return next((f for sec in sources for f in _facts(sec) if f.startswith(head)), None)


def plan_items(items: list[Any]) -> list[plan_strip.PlanItem]:
    """The plan strip's reading of a PRD's roadmap items (uncut), each with the milestone
    record that links it, when any."""
    out = []
    for i in items:
        if i.status == "cut":
            continue
        # plan-model: one input per slice, each in its milestone as the PRD's plan dates it.
        for sl in getattr(i, "slices", None) or []:
            out.append(
                plan_strip.PlanItem(
                    sl.start_date or i.start.date,
                    sl.end_date or i.end.date,
                    not (sl.milestone_start and sl.milestone_end),
                    f"{sl.milestone} · {sl.milestone_name}",
                    sl.milestone_end,
                    milestone_start=sl.milestone_start,
                )
            )
        if getattr(i, "slices", None):
            continue
        out.append(
            plan_strip.PlanItem(
                i.start.date,
                i.end.date,
                i.estimated,
                (i.milestone.name or "Milestone") if i.milestone else None,
                i.milestone.date if i.milestone else None,
                str(i.milestone.record_id) if i.milestone and i.milestone.record_id else None,
                i.milestone.record_name if i.milestone else None,
                i.milestone.start_date if i.milestone else None,
            )
        )
    return out


def _cells(row: str) -> list[str]:
    """A table row's cells, without the outer pipes."""
    r = row.strip()
    r = r[1:] if r.startswith("|") else r
    r = r[:-1] if r.endswith("|") and not r.endswith("\\|") else r
    return [c.strip() for c in _CELL_SPLIT.split(r)]


def _tables(md: str) -> tuple[list[tuple[str, list[str]]], list[str]]:
    """A section's table body rows (each raw line and its cells) and its other lines. A
    table's header and separator rows are neither: they are never a line."""
    lines = md.splitlines()
    rows: list[tuple[str, list[str]]] = []
    rest: list[str] = []
    i = 0
    while i < len(lines):
        if "|" in lines[i] and i + 1 < len(lines) and _TABLE_SEP.match(lines[i + 1]):
            i += 2
            while i < len(lines) and "|" in lines[i] and lines[i].strip():
                rows.append((lines[i], _cells(lines[i])))
                i += 1
            continue
        rest.append(lines[i])
        i += 1
    return rows, rest


def _row_line(cells: list[str]) -> str:
    """A table body row as one readable line: "<first cell>: <the next non-empty cell>"."""
    vals = [v for v in (_plain(c.replace("\\|", "/")).strip(" |") for c in cells) if v]
    return ": ".join(vals[:2])


def _unpiped(text: str) -> str:
    """A line never starts or ends with a pipe: a table row's words read as one line. Pipes
    inside prose ("p50 | p95 | p99") stay as written."""
    t = text.strip()
    if t.startswith("|") or t.endswith("|"):
        t = _row_line(_cells(t)) if "|" in t.strip("| ") else t.strip(" |")
    return t.strip(" |")


def _facts(sec: Section) -> list[str]:
    """A section's bullets and its tables' body rows (one line each), else its sentences."""
    rows, rest = _tables(_uncomment(sec.body_md or ""))
    bullets = [_plain(m.group(1)) for line in rest if (m := _BULLET.match(line))]
    facts = [b for b in (_unpiped(x) for x in bullets) if b and not template_only(b)]
    facts += [x for x in (_row_line(c) for _, c in rows) if x and not template_only(x)]
    if facts:
        return facts
    prose = _plain("\n".join(rest)) if rows else _uncomment(sec.body_text or "")
    # A skeleton's bare lines ("→", "<Risk>: <mitigation>") are not sentences of the PRD.
    prose = "\n".join(x for x in prose.splitlines() if not template_only(x))
    return [
        s
        for s in (_unpiped(_plain(x)) for x in _SENTENCE.split(prose))
        if s and not template_only(s)
    ]


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
            text, whole, keys = "", "", []
            for sec in secs:
                for fact in _facts(sec):
                    whole = f"{whole} {fact}".strip()
                    if len(text.split()) >= spec.max_words:
                        continue
                    text = f"{text} {fact}".strip()
                    if sec.section_key not in keys:
                        keys.append(sec.section_key)
            if text:
                shown = clip(text, spec.max_words)[0]
                line = {"text": shown, "source_keys": keys}
                if shown != whole:
                    line["full"] = whole[:FULL_MAX]
                lines.append(line)
        else:
            facts = [(f, sec.section_key) for sec in secs for f in _facts(sec)]
            if spec.kind == "metrics":
                facts = sorted(facts, key=lambda f: metric_of(f[0]) is None)
            for fact, key in facts[: spec.max_lines]:
                shown, cut = clip(fact, spec.max_words)
                line: dict[str, Any] = {"text": shown, "source_keys": [key]}
                if cut:
                    line["full"] = cut
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
            text = _unpiped(" ".join(_uncomment(str(raw.get("text") or "")).split()))
            keys = [str(k) for k in raw.get("source_keys") or [] if str(k) in allowed]
            if not text or not keys or template_only(text):
                continue
            shown, cut = clip(text, spec.max_words)
            line: dict[str, Any] = {"text": shown, "source_keys": keys}
            if cut:
                line["full"] = cut
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
            blocks=_numbered(extract(specs, mapped)),
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
    answer = await ask("one_pager", payload)
    blocks = clean_answer(answer, specs, mapped)
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
    if row is None:
        row = SimpleOnePager(document_id=document.id, version_id=v.id, sections_hash=h)
        s.add(row)
    row.blocks, row.built_by, row.job_id = blocks, "oracle", job.id
    row.built_at = company_time.now()
    await s.flush()
    # S10: Oracle drafts each bet's visual with the page (once per bet's words).
    from oracle.simple import visuals

    for b in blocks:
        for line in b["lines"] if b["key"] == "bets" else []:
            sid = visuals.line_subject(document.id, line["text"])
            await visuals.request_visual(
                s, None, "one_pager_line", sid, line["text"], document_id=document.id
            )
    await s.flush()
    return {"built": True, "sections_hash": h}


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


def may_remind(principal: Any, w: Who) -> bool:
    """Remind: the PRD's owners (a company owner, its track owners) and its decider."""
    me = _me(principal)
    return me is not None and (decides(principal, w) or me in w.track_owners)


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


def _spans(body: str) -> tuple[list[str], bool]:
    """A section's facts as written: its bullets' text, else its sentences."""
    bullets = [m.group(1) for line in body.splitlines() if (m := _BULLET.match(line))]
    if bullets:
        return bullets, True
    return [x.strip() for x in _SENTENCE.split(body.strip()) if x.strip()], False


def _stems(text: str) -> set[str]:
    return {w[:4] for w in re.findall(r"[\w%]+", text.casefold()) if len(w) > 2}


def _hits(spans: list[str], old: str) -> list[str]:
    """The facts a line says: those its words hold (a quick read's line, the concatenated
    Problem, a truncated line), else the one fact a paraphrase (the job's wording) rests on."""
    o = _plain(old).rstrip("…").strip()
    if not o:
        return []
    exact = [r for r in spans if (p := _plain(r)) and (p in o or (o in p and len(o.split()) > 2))]
    if exact:
        return exact
    line = _stems(o)
    scored = [(len(_stems(r) & line) / max(len(_stems(r)), 1), r) for r in spans]
    best = max(scored, default=(0.0, ""))
    return [best[1]] if best[0] >= 0.6 else []


def _drop(body: str, raw: str, bullets: bool) -> str:
    if bullets:
        pat = r"^[ \t]*(?:[-*+]|\d+[.)])[ \t]+" + re.escape(raw) + r"[ \t]*(?:\n|$)"
        return re.sub(pat, "", body, count=1, flags=re.M)
    return re.sub(re.escape(raw) + r"[ \t]*", "", body, count=1)


def _row_with(cells: list[str], new: str) -> str:
    """A table row saying the new line: "A: B" writes its first two non-empty cells, other
    words the second (the row's other cells stay)."""
    out = list(cells)
    filled = [i for i, c in enumerate(cells) if _plain(c).strip(" |")] or [0]
    head, sep, tail = new.partition(": ")
    put = lambda i, v: out.__setitem__(i, v.strip().replace("|", "\\|"))  # noqa: E731
    if len(filled) >= 2 and sep:
        put(filled[0], head)
        put(filled[1], tail)
    else:
        put(filled[1] if len(filled) >= 2 else filled[0], new)
    return "| " + " | ".join(out) + " |"


def patch(body: str, old: str, new: str, *, first: bool = True) -> str | None:
    """The section with the line's new words: the fact(s) the old line says replaced by
    the new line (``first``), or dropped (a later section of a line resting on several,
    which the new words now speak for). None when the section holds nothing the line says:
    the edit is refused rather than a new claim added beside the old one."""
    o = _plain(old).rstrip("…").strip()
    for raw, cells in _tables(body)[0]:
        said = _row_line(cells)
        if said and o and (said == o or (said.startswith(o) and len(o.split()) > 2)):
            if not first:
                return re.sub(re.escape(raw) + r"[ \t]*(?:\n|$)", "", body, count=1)
            return body.replace(raw, _row_with(cells, new), 1)
    spans, bullets = _spans(body)
    hits = _hits(spans, old)
    if not hits:
        stripped = old.rstrip("…").strip()
        if not stripped or stripped not in body:
            return None
        return body.replace(stripped, new, 1) if first else body.replace(stripped, "", 1)
    out = body
    for i, raw in enumerate(hits):
        out = out.replace(raw, new, 1) if first and i == 0 else _drop(out, raw, bullets)
    return out


def patch_all(bodies: dict[str, str], old: str, new: str) -> dict[str, str] | None:
    """Every source section of a line patched (see :func:`patch`), or None."""
    out: dict[str, str] = {}
    for i, (k, body) in enumerate(bodies.items()):
        got = patch(body, old, new, first=i == 0)
        if got is None:
            return None
        out[k] = got
    return out


# --------------------------------------------------------------------------- the read


async def read(db: AsyncSession, principal: Any, doc: str) -> OnePagerOut:
    from oracle.simple import service

    document = await _document(db, principal, doc)
    # A viewer's read writes nothing (the page is built in memory until a writer reads it).
    writer = _me(principal) is not None and has_role(principal.role, "commenter")
    b = await built(db, document, persist=writer)
    if writer:
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
    owner_id = await document_owner(db, document, b.version, w)
    if owner_id:
        ids.add(owner_id)
    names = {
        u.id: u.name or u.email for u in await db.scalars(select(User).where(User.id.in_(ids)))
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
    line_ids = [x["id"] for blk in b.row.blocks for x in blk["lines"]]
    by_line = await meetings.decided_in(
        db, [{"kind": "section", "id": str(document.id), "ref": f"line:{i}"} for i in line_ids]
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
            can_undo=kind == "change"
            and c.by == me
            and s is not None
            and s.closed_at is None
            and (s.last_change_at or s.started_at) > now - IDLE,
            can_decide=kind == "proposal" and may_decide(principal, c),
            adds_feature=line_id.startswith("bets-"),
            flow=visuals.one_pager_flow(note_flows.get(c.id)),
        )

    notes = [note(c, "change") for c in live] + [note(c, "proposal") for c in shown]
    proposed = {n.line_id for n in notes if n.kind == "proposal"}
    blocks = []
    for spec in b.specs:
        raw = next((x for x in b.row.blocks if x["key"] == spec.key), {"lines": []})
        lines = []
        for line in raw["lines"]:
            edited = line["id"] in line_text
            text, full = line_text.get(line["id"], line["text"]), None
            if not edited:
                if template_only(line["text"]):
                    continue  # a template's guidance in a one-pager built before this rule
                srcs = [x for x in b.sections if x.section_key in line["source_keys"]]
                text, full = _tidy(text, spec.max_words, line.get("full"), srcs)
            metric = OnePagerMetric.model_validate(line["metric"]) if line.get("metric") else None
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
                key=spec.key, title=spec.title, rules=spec.rules, kind=spec.kind, lines=lines
            )
        )  # type: ignore[arg-type]
    # S10: each bet ("What we will build") carries its visual.
    bets = [x for blk in blocks for x in blk.lines if x.id.startswith("bets-")]
    for x in bets:
        x.flow_subject = visuals.line_subject(document.id, x.text)
    line_flows = await visuals.flows_for(db, "one_pager_line", [x.flow_subject for x in bets])
    for x in bets:
        x.flow = visuals.one_pager_flow(line_flows.get(x.flow_subject))
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
    plan = plan_strip.strip(plan_items(slice_.items), slice_.today)
    span = milestone_span(plan_items(slice_.items))
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
            reminded_at=reminded_at(d),
            can_remind=may_remind(principal, w) and bool(due_reminders(d, now)),
            approved_in=titles.get(uuid.UUID(approved_sid)) if approved_sid else None,
            blocked_by=drafts.held(d),
        )
    patched = ((d.overlay or {}).get("sections") or {}) if sees and d else {}
    used = {k for blk in b.row.blocks for x in blk["lines"] for k in x["source_keys"]}
    sources = [
        OnePagerSource(
            key=x.section_key, heading=x.heading, body=patched.get(x.section_key, x.body_md)
        )  # fmt: skip
        for x in b.sections
        if x.section_key in used
    ]
    person = lambda i: SimplePersonRef(id=i, name=names.get(i, "someone")) if i else None  # noqa: E731
    return OnePagerOut(
        document=SimpleDocRef(id=document.id, slug=document.slug, title=document.title),
        version=b.version.number,
        published_at=b.version.approved_at,
        owner=person(owner_id) if owner_id in names else None,
        decider=person(w.decider) if w.decider in names else None,
        span_start=span[0] if span else None,
        span_end=span[1] if span else None,
        built_by=b.row.built_by,
        built_at=b.row.built_at,  # type: ignore[arg-type]
        blocks=[*blocks, timeline.model_copy(update={"lines": []})],
        timeline=items,
        plan=plan,
        sections=sources,
        notes=notes,
        draft=draft,
        changes_in_review=hidden,
        can_edit=decides(principal, w),
        can_propose=not decides(principal, w)
        and _me(principal) is not None
        and has_role(principal.role, "commenter"),
    )


# --------------------------------------------------------------------------- Remind


async def remind(db: AsyncSession, principal: Any, doc: str) -> OnePagerRemindOut:
    """Nudge each reviewer the PRD's submitted draft waits on (an Inbox notification), each
    at most once a day; commits. 403 to anyone but the PRD's owners and its decider; 409
    with no submitted draft waiting, or when every waiting reviewer was reminded today."""
    from oracle.review.collab import notify

    document = await _document(db, principal, doc)
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
    d.overlay = {"sections": secs, "lines": lines}


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
    w = await who(db, document)
    d = await _open_draft(db, document)
    # Who cannot see the working draft proposes against the published line and sections
    # (and a conflict shows them nothing of the draft).
    sees = d is not None and sees_draft(principal, d, w)
    text, bodies = await _current(db, b, line_id, d if sees else None)
    if text != old:
        raise _conflict("This line changed since you read it", text)
    if not bodies:
        raise ChangeError(409, "This line rests on no section of the PRD")
    patched = patch_all(bodies, text, new)
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
    if action == "accept":
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
    text, bodies = await _current(db, b, str(c.target["line_id"]), await _open_draft(db, document))
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
.plan { font-size: 8pt; }
.plan .r { display: flex; align-items: center; height: 15px; }
.plan .n { width: 34%; overflow: hidden; white-space: nowrap; padding-right: 6px; }
.plan .t { position: relative; flex: 1; height: 15px; border-left: 1px solid #e3e5e9; }
.plan .m { position: absolute; top: 0; color: #5b6270; border-left: 1px solid #e3e5e9;
  padding-left: 3px; }
.plan .b { position: absolute; top: 4px; height: 7px; border-radius: 2px; background: #c9ced6; }
.plan .b.est { background: none; border: 1px dashed #9aa1ad; }
.plan .d { position: absolute; top: 2px; width: 9px; height: 9px; margin-left: -5px;
  background: #1c1f24; transform: rotate(45deg); }
.plan .now { position: absolute; top: 0; bottom: 0; border-left: 1.5px solid #c0392b; }
.plan .more { color: #5b6270; margin-top: 3px; }
.tl { font-size: 8pt; }
.tl .r { display: flex; border-bottom: 1px solid #e3e5e9; }
.tl .n { width: 30%; padding: 3px 6px 3px 0; }
.tl .n b { display: block; font-size: 8.5pt; }
.tl .t { position: relative; flex: 1; }
.tl .ax { height: 30px; }
.tl .f { position: absolute; top: 0; transform: translateX(-100%); white-space: nowrap;
  padding: 0 3px; font-weight: 600; border-right: 2px solid; }
.tl .mo { position: absolute; bottom: 0; color: #5b6270; border-left: 1px solid #e3e5e9;
  padding-left: 2px; }
.tl .bar { position: absolute; height: 13px; border: 1px solid; border-radius: 7px;
  padding: 0 4px; white-space: nowrap; font-weight: 600; font-size: 7pt; overflow: hidden; }
.tl .bar.pm { border-style: dashed; }
.tl .off { position: absolute; top: 0; bottom: 0;
  background: repeating-linear-gradient(135deg, #d9d5cc 0 2px, transparent 2px 5px); }
.tl .end { position: absolute; top: 0; bottom: 0; border-left: 1px dashed; }
.tl .now { position: absolute; top: 0; bottom: 0; border-left: 1.5px solid #c0392b; }
.part { page-break-before: always; }
.part h3 { font-size: 9.5pt; margin: 6px 0 2px; }
.part .what { color: #5b6270; }
"""

# prd-timeline: each milestone's colour in the PDF (M1 blue, M2 violet, M3 amber): fill, edge, ink.
TONES = [("#dce8ff", "#3b6fd8", "#173d8a"), ("#ece3ff", "#7a4fd6", "#432088"),
         ("#fdeccb", "#c27c0e", "#6b4300")]  # fmt: skip
PM_LANE = "PM-owned · no engineering"
# prd-timeline review: the lanes' width on the page (70% of A4's 178 mm between margins, in
# CSS px) and a 7pt bold character's, to fit a bar's codes as the web's fitCodes does.
TL_PX = 0.70 * 178 / 25.4 * 96
TL_CH = 5.2


def fit_codes(codes: list[str], px: float) -> str:
    """As many whole codes as fit the bar, then "+N"; never a code cut mid-way (a bar too
    narrow for even its first code and "+N" shows its first code, as wide as the bar is)."""
    for k in range(len(codes), 0, -1):
        text = " · ".join(codes[:k]) + (f" +{len(codes) - k}" if k < len(codes) else "")
        if len(text) * TL_CH + 10 <= px:
            return text
    return codes[0] if codes else ""


# The plan strip shows this many rows; the rest are "+N more on the roadmap".
PLAN_ROWS = 8
NOT_WRITTEN = "Not written yet"


def _plan_html(plan: Any) -> str:
    """The plan strip for the PDF: months across, one row per milestone, today's line."""
    if plan is None:
        return "<p>No roadmap items yet</p>"
    span = (plan.end - plan.start).days + 1

    def pct(d: Any) -> float:
        return max(0.0, min(100.0, (d - plan.start).days / span * 100))

    now = f"<span class='now' style='left:{pct(plan.today):.1f}%'></span>" if plan.today else ""
    months = "".join(
        f"<span class='m' style='left:{pct(m):.1f}%'>{m.strftime('%b')}</span>" for m in plan.months
    )
    out = [
        "<div class='plan'><div class='r'><span class='n'></span>"
        f"<span class='t'>{months}{now}</span></div>"
    ]
    for r in plan.rows[:PLAN_ROWS]:
        n = f"{r.items} item{'' if r.items == 1 else 's'}"
        when = f" · {r.date.strftime('%b')} {r.date.day}" if r.date else ""
        left = pct(r.start)
        bar = (
            f"<span class='b{' est' if r.estimated else ''}' "
            f"style='left:{left:.1f}%;width:{max(1.0, pct(r.end) - left):.1f}%'></span>"
        )
        mark = f"<span class='d' style='left:{pct(r.date):.1f}%'></span>" if r.date else ""
        out.append(
            f"<div class='r'><span class='n'>{escape(r.name)} · {n}{when}</span>"
            f"<span class='t'>{bar}{mark}{now}</span></div>"
        )
    extra = []
    if len(plan.rows) > PLAN_ROWS:
        extra.append(f"+{len(plan.rows) - PLAN_ROWS} more on the roadmap")
    if plan.past_edge:
        word = "commitment ends" if plan.past_edge == 1 else "commitments end"
        extra.append(f"{plan.past_edge} {word} past {plan.end.strftime('%b')} →")
    if extra:
        out.append(f"<div class='more'>{' · '.join(extra)}</div>")
    return "".join(out) + "</div>"


def _pieces(slices: list[Any]) -> list[tuple[str, list[Any], Any, Any, int]]:
    """A lane's pieces (as the web's PrdTimeline): a run of one milestone's slices (a gap of
    more than two weeks starts another), stacked into rows where they run within a week."""
    out: list[list[Any]] = []
    by: dict[str, list[Any]] = {}
    for sl in slices:
        if sl.start_date and sl.end_date:
            by.setdefault(sl.milestone, []).append(sl)
    for code, of in by.items():
        cur: list[Any] | None = None
        for sl in sorted(of, key=lambda x: x.start_date):
            if cur and (sl.start_date - cur[3]).days <= 14:
                cur[1].append(sl)
                cur[3] = max(cur[3], sl.end_date)
            else:
                cur = [code, [sl], sl.start_date, sl.end_date, 0]
                out.append(cur)
    out.sort(key=lambda p: p[2])
    rows: list[Any] = []
    for p in out:
        r = next((i for i, end in enumerate(rows) if (p[2] - end).days >= 7), len(rows))
        if r == len(rows):
            rows.append(p[3])
        rows[r] = p[3]
        p[4] = r
    return [tuple(p) for p in out]  # type: ignore[misc]


def _timeline_html(view: Any, today: Any) -> str:
    """prd-timeline: the plan's timeline for the PDF's first page: milestone flags, months,
    one lane per goal (its targets and what is measured now) and the PM-owned lane."""
    tone = {m.code: TONES[i % 3] for i, m in enumerate(view.milestones)}
    first = min(view.span.start, today)
    start = first - timedelta(days=first.weekday())
    last = max(view.span.end, today)
    end = last + timedelta(days=7 - last.weekday())
    days = (end - start).days

    def pct(d: Any, end_of_day: bool = False) -> str:
        return f"{((d - start).days + (1 if end_of_day else 0)) / days * 100:.2f}%"

    def px(a: Any, b: Any) -> float:
        return ((b - a).days + 1) / days * TL_PX

    out = ["<div class='tl'><div class='r'><div class='n'></div><div class='t ax'>"]
    for m in view.milestones:
        fill, edge, ink = tone[m.code]
        out.append(f"<span class='f' style='left:{pct(m.end_date, True)};background:{fill};"
                   f"color:{ink};border-color:{edge}'>{escape(m.code)} ends "
                   f"{plan_model._day(m.end_date)}</span>")  # fmt: skip
    mo = start.replace(day=1)
    while mo < end:
        at = max(mo, start)
        out.append(f"<span class='mo' style='left:{pct(at)}'>{at.strftime('%b')}</span>")
        mo = (mo.replace(day=28) + timedelta(days=4)).replace(day=1)
    out.append("</div></div>")
    names = [g.name for g in view.goals]
    for sl in view.slices:
        if not sl.pm_owned and sl.goal and sl.goal not in names:
            names.append(sl.goal)
    lanes = [
        (n, next((g for g in view.goals if g.name == n), None),
         [x for x in view.slices if not x.pm_owned and x.goal == n])
        for n in names
    ]  # fmt: skip
    pm = [x for x in view.slices if x.pm_owned]
    if pm:
        lanes.append((PM_LANE, None, pm))
    for name, goal, slices in lanes:
        pieces = _pieces(slices)
        rows = max([p[4] + 1 for p in pieces] or [1])
        label = f"<b>{escape(name)}</b>"
        if goal is not None:
            steps = " → ".join(f"{t.milestone} {t.target}" for t in goal.targets)
            now = f"Now {goal.measured}" if goal.measured else "Not counted yet"
            if goal.measured and goal.on_track is not None:
                now += " · on track" if goal.on_track else " · behind"
            label += f"{escape(steps)}<br>{escape(now)}"
        out.append(f"<div class='r'><div class='n'>{label}</div>"
                   f"<div class='t' style='min-height:{rows * 17 + 4}px'>")  # fmt: skip
        for h in view.holidays:
            out.append(f"<span class='off' style='left:{pct(h.start)};width:calc("
                       f"{pct(h.end, True)} - {pct(h.start)})'></span>")  # fmt: skip
        for m in view.milestones:
            out.append(f"<span class='end' style='left:{pct(m.end_date, True)};"
                       f"border-color:{tone[m.code][1]}'></span>")  # fmt: skip
        out.append(f"<span class='now' style='left:{pct(today)}'></span>")
        for code, of, a, b, row in pieces:
            fill, edge, ink = tone.get(code, TONES[0])
            pm_cls = " pm" if of[0].pm_owned else ""
            out.append(f"<span class='bar{pm_cls}' style='left:{pct(a)};width:calc({pct(b, True)}"
                       f" - {pct(a)});top:{2 + row * 17}px;background:{fill};border-color:{edge};"
                       f"color:{ink};min-width:{len(of[0].code) * TL_CH + 10:.0f}px'>"
                       f"{escape(fit_codes([x.code for x in of], px(a, b)))}</span>")  # fmt: skip
        out.append("</div></div>")
    return "".join(out) + "</div>"


def _part_html(view: Any, m: Any) -> str:
    """prd-timeline: one milestone's page: name and dates, Done when, targets, what it
    builds by kind, its open decisions and risks."""
    day = plan_model._day
    out = [f"<section class='part'><h1>{escape(m.code)} {escape(m.name)}</h1>"
           f"<div class='meta'>{day(m.start_date)} – {day(m.end_date)}"]  # fmt: skip
    if m.effort_weeks is not None:
        out.append(f" · {m.planned_weeks:g} of {m.effort_weeks:g} engineer-weeks planned")
    out.append("</div><h2>Done when</h2><ul>")
    out += [f"<li>☐ {escape(d)}</li>" for d in m.done_when] or [f"<li>{NOT_WRITTEN}</li>"]
    out.append("</ul><h2>Targets</h2><ul>")
    out += [f"<li>{escape(t.goal)}: {escape(t.target)}</li>" for t in m.targets] or [
        "<li>No targets yet</li>"
    ]
    out.append("</ul><h2>What it builds</h2>")
    groups: dict[str, list[Any]] = {}
    for sl in view.slices:
        if sl.milestone == m.code:
            groups.setdefault("PM-owned" if sl.pm_owned else sl.kind or "Other work", []).append(sl)
    for kind in sorted(groups, key=lambda k: k == "PM-owned"):
        out.append(f"<h3>{escape(kind)}</h3><ul>")
        for sl in groups[kind]:
            what = f" <span class='what'>{escape(sl.what)}</span>" if sl.what else ""
            out.append(f"<li><b>{escape(sl.code)} {escape(sl.name)}</b>{what}</li>")
        out.append("</ul>")
    if not groups:
        out.append("<p>Nothing planned in it yet</p>")
    out.append("<h2>Open decisions</h2><ul>")
    out += [f"<li>{escape(d.code)} {escape(d.title)}</li>" for d in m.decisions] or [
        "<li>No open decisions</li>"
    ]
    out.append("</ul><h2>Risks</h2><ul>")
    out += [f"<li>{escape(r)}</li>" for r in m.risks] or ["<li>No risks written yet</li>"]
    out.append("</ul></section>")
    return "".join(out)


async def pdf_html(db: AsyncSession, principal: Any, doc: str) -> tuple[str, str]:
    """The one-pager's branded page (the published lines: a PDF is shared), and a file
    stem."""
    from oracle.branding import BRAND_CSS, accent_css, load_brand, render_brand_header

    out = await read(db, principal, doc)
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
        f"{accent_css(brand)}</style></head><body>",
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
        meta.append(f"{out.span_start.isoformat()} – {out.span_end.isoformat()}")
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
            m = OnePagerMetric.model_validate(pub["metric"]) if pub and pub.get("metric") else None
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


async def _published_lines(db: AsyncSession, out: OnePagerOut) -> dict[str, dict[str, Any]]:
    row = await db.scalar(
        select(SimpleOnePager)
        .join(DocumentVersion, DocumentVersion.id == SimpleOnePager.version_id)
        .where(SimpleOnePager.document_id == out.document.id, DocumentVersion.number == out.version)
        .order_by(SimpleOnePager.built_at.desc())
        .limit(1)
    )
    return {line["id"]: line for blk in (row.blocks if row else []) for line in blk["lines"]}
