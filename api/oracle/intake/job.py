"""The ``intake_analysis`` built-in job: light extraction on Oracle's Claude account pool.

It runs like the other built-in jobs (docs/llm-jobs.md): queued, claimed by the worker
or ``oracle tick``, one model call through ``oracle.llm``. INT2 moved the read to a
SwarmCloud ``intake_analysis`` run (``oracle.intake.read``); this job stays as that run's
fallback when it cannot start or fails (owner answer Q3) and as the rollback
(``ORACLE_INTAKE_READ_RUNTIME=job``). :func:`payload` is also exactly what the run reads
(``GET /v1/intakes/{id}/analysis-input``), and :func:`apply_answer` stores either answer.

Untrusted content stays data (§5, §12): the system prompt is the fixed prompt file, and
the user message carries, outside ``untrusted_data``, only Oracle's own fixed values (ids,
fields, category keys and labels, gap categories and statuses, limits). Everything a
person or a source wrote travels inside ``untrusted_data``: the intake's title, the
brief, every gap statement (any commenter can write one), the confirmed goals and the
pinned sources. Walk 2, problem 17: the read holds every uploaded document, whole or by
its relevant sections, and the baseline features the brief names with their descriptions
and evidence (``features``), so it never calls them missing. A gap whose own words are
a restricted finding (model text drawn from the author's sources) travels by its
category and status only, so a later run that reads none of the author's sources (its
output is shared) cannot restate it.

What comes back is checked before it is stored: known fields and categories only,
bounded text, at most ``MAX_ITEMS`` items and ``MAX_GAPS`` gaps per run (and
``MAX_MODEL_ITEMS`` / ``MAX_MODEL_GAPS`` in all), evidence refs that resolve to items
the job was given, no gap in a category already answered or covered by the baseline,
no gap that says what an existing gap of its category says, and no gap that says something
is not described or missing when a feature or a source section the job was given
describes it (:func:`described`). Every result is an
**AI inference**: items join the analysis, gaps join the registry as open, unknown gaps.
When the job read any of the author's sources, every item and gap it writes is a
finding that starts ``private`` (S6): only the author sees it until they share it, and
its shareable summary never repeats source text or figures. A converted or archived
intake is left as it is.
"""

import re
import uuid
from typing import Any, get_args

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.baseline.models import Entity, Evidence
from oracle.intake import categories as cats
from oracle.intake import engine, extract, sharing
from oracle.intake import evidence as ev
from oracle.intake.schemas import ExtractedField
from oracle.jobs.models import LlmJob
from oracle.v2.models import KnowledgeGap, ProductIntake

MAX_SOURCES = 25
MAX_TEXT = 500
# Walk 2, problem 17: an uploaded document (an old PRD, a spec) is read whole up to
# UPLOAD_CHARS, past that by its sections that speak to the brief and the features it
# names; any other item by an excerpt of EXCERPT_CHARS. READ_CHARS bounds the whole read:
# once it is spent, an upload is read by an excerpt too.
UPLOAD_CHARS = 8000
EXCERPT_CHARS = 1500
READ_CHARS = 60000
# The baseline features the brief names, each with its description and evidence.
MAX_FEATURES = 12
FEATURE_EVIDENCE = 3
FEATURE_REF = "feat:"
# Per run.
MAX_ITEMS = 12
MAX_GAPS = 8
# Per intake, over every run.
MAX_MODEL_ITEMS = 40
MAX_MODEL_GAPS = 24
# Two gaps of a category mean the same when this share of their content words match.
SAME_MEANING = 0.5
CLOSED_INTAKE = ("converted", "archived")
FIELDS = set(get_args(ExtractedField))
IMPORTANCE = set(cats.IMPORTANCE_WEIGHTS)


def _text(value: Any) -> str:
    text = " ".join(str(value or "").split())
    return text if len(text) <= MAX_TEXT else text[: MAX_TEXT - 1].rstrip() + "…"


def _refs(raw: Any, known: dict[str, uuid.UUID]) -> list[uuid.UUID]:
    out: list[uuid.UUID] = []
    for ref in raw if isinstance(raw, list) else []:
        item = known.get(str(ref))
        if item is not None and item not in out:
            out.append(item)
    return out


_HEADING = re.compile(r"^ {0,3}#{1,6}[ \t]+(.+?)[ \t#]*$", re.M)


def sections(text: str) -> list[tuple[str | None, str]]:
    """(heading, body) of each markdown section of a text, the part before the first
    heading under None."""
    out: list[tuple[str | None, str]] = []
    heading, pos = None, 0
    for m in _HEADING.finditer(text):
        out.append((heading, text[pos : m.start()]))
        heading, pos = m.group(1).strip(), m.end()
    out.append((heading, text[pos:]))
    return [(h, b) for h, b in out if h or b.strip()]


def read_of(text: str, wanted: set[str], limit: int) -> dict[str, Any]:
    """What the read holds of one item: its whole text when it fits ``limit``, else the
    sections sharing words with ``wanted`` (in their order), else its start. ``sections``
    names the headings of the sections held that have a body."""
    parts = sections(text)
    if len(" ".join(text.split())) <= limit:
        named = [h for h, b in parts if h and b.strip()]
        return {"excerpt": ev.excerpt(text, limit) or "", "whole": True, "sections": named}
    ranked = sorted(
        ((len(wanted & extract.terms(f"{h or ''} {b}")), n) for n, (h, b) in enumerate(parts)),
        key=lambda x: (-x[0], x[1]),
    )
    keep: dict[int, str] = {}
    used = 0
    for score, n in ranked:
        if score == 0 or limit - used < 200:
            break
        h, b = parts[n]
        piece = ev.excerpt(f"{h}: {b}" if h else b, limit - used) or ""
        keep[n] = piece
        used += len(piece) + 3
    if not keep:
        return {"excerpt": ev.excerpt(text, limit) or "", "whole": False, "sections": []}
    return {
        "excerpt": " … ".join(keep[n] for n in sorted(keep)),
        "whole": False,
        "sections": [parts[n][0] for n in sorted(keep) if parts[n][0] and parts[n][1].strip()],
    }


# A gap that says its subject is not described (walk 2, problem 17).
_ABSENT = re.compile(
    r"\b(not (?:described|defined|documented|specified|covered|explained|mentioned|detailed"
    r"|stated)|missing|undefined|unspecified|undocumented|absent|nowhere|no (?:description"
    r"|details?|definition|specs?|specification|mention))\b",
    re.I,
)
# Words that name no subject: "the two must-include engines are not described anywhere".
_VAGUE = extract.terms(
    "one two three all anywhere include included includes brief briefs source sources "
    "document documents prd described describe description details defined yet still "
    "there is are was were"
)


def described(statement: str, features: list[dict[str, Any]], headings: list[str]) -> bool:
    """Whether a gap calls something not described or missing that a feature the read
    holds (with a description or evidence) or a source section it holds describes."""
    if not _ABSENT.search(statement):
        return False
    subject = extract.terms(_ABSENT.sub(" ", statement).replace("-", " ")) - _VAGUE
    if not subject:
        return False
    names = [
        f"{f.get('title') or ''} {str(f.get('key') or '').replace('-', ' ')}"
        for f in features
        if f.get("description") or f.get("evidence")
    ]
    return any(subject & extract.terms(name) for name in [*names, *headings])


def same_meaning(a: str, b: str) -> bool:
    """Whether two gap statements say the same thing (normalized content words)."""
    ta, tb = extract.terms(a), extract.terms(b)
    if not ta or not tb:
        return a.strip().lower() == b.strip().lower()
    overlap = len(ta & tb)
    return overlap / len(ta | tb) >= SAME_MEANING or overlap / min(len(ta), len(tb)) >= 0.8


def closed_categories(intake: ProductIntake, gaps: list[KnowledgeGap]) -> set[str]:
    """Categories never asked again: answered or decided, or covered by the baseline."""
    closed = {g.category for g in gaps if g.status in engine.SETTLED}
    for row in (intake.analysis or {}).get("coverage") or []:
        if row.get("state") == "covered" and row.get("gap_id") is None:
            closed.add(row["category"])
    return closed


async def payload(
    s: AsyncSession, intake: ProductIntake
) -> tuple[dict[str, Any], dict[str, uuid.UUID], list[ev.PinnedItem]]:
    items, _ = await ev.pinned_items(s, intake)
    baseline = await engine.read_baseline(s, intake.brief)
    named = baseline.features[:MAX_FEATURES]
    wanted = extract.terms(" ".join([intake.brief, *(f.title for f in named)]))
    # Every uploaded document is read, whatever words it shares with the brief; then the
    # other items that speak to the brief or the features it names.
    uploads = [i for i in items if i.row.source_kind == "upload"]
    others = extract.relevant(
        [i for i in items if i.row.source_kind != "upload"],
        " ".join([intake.brief, *(f.title for f in named)]),
    )
    by_confidence = lambda i: -i.confidence  # noqa: E731
    chosen = [*sorted(uploads, key=by_confidence), *sorted(others, key=by_confidence)]
    chosen = chosen[:MAX_SOURCES]
    refs = {f"src:{n}": i.id for n, i in enumerate(chosen, start=1)}
    reads, spent = [], 0
    for i in chosen:
        upload = i.row.source_kind == "upload" and spent < READ_CHARS
        got = read_of(
            i.text, wanted, min(UPLOAD_CHARS, READ_CHARS - spent) if upload else EXCERPT_CHARS
        )
        spent += len(got["excerpt"])
        reads.append(got)
    features = await _features(s, named, {i.id: ref for ref, i in zip(refs, chosen, strict=True)})
    goals = (
        await s.scalars(
            select(Entity)
            .where(Entity.type == "goal", Entity.status == "confirmed")
            .order_by(Entity.key)
            .limit(30)
        )
    ).all()
    gaps = await engine.intake_gaps(s, intake.id)
    gap_refs = [(f"gap:{n}", g) for n, g in enumerate(gaps, start=1)]
    reg = sharing.registry(intake)
    body = {
        "intake": {"id": str(intake.id)},
        "fields": sorted(FIELDS),
        "categories": [{"key": c.key, "label": c.label} for c in cats.CATEGORIES],
        "existing_gaps": [
            {"ref": ref, "category": g.category, "status": g.status} for ref, g in gap_refs
        ],
        "closed_categories": sorted(closed_categories(intake, gaps)),
        "limits": {"items": MAX_ITEMS, "gaps": MAX_GAPS},
        "untrusted_data": {
            "title": intake.title,
            "brief": intake.brief,
            # A restricted gap's own words never go in: a run that reads none of the
            # author's sources writes shared output, which must not restate them.
            "gap_statements": [
                {"ref": ref, "statement": g.statement}
                for ref, g in gap_refs
                if not sharing.statement_restricted(g, reg)
            ],
            "goals": [{"ref": f"goal:{g.key}", "title": g.title} for g in goals],
            "sources": [
                {"ref": ref, "kind": i.row.source_kind, "title": i.title, **got}
                for ref, i, got in zip(refs, chosen, reads, strict=True)
            ],
            "features": features,
        },
    }
    return body, refs, chosen


async def _features(
    s: AsyncSession, named: list[Entity], src_refs: dict[uuid.UUID, str]
) -> list[dict[str, Any]]:
    """The baseline features the brief names: title, description, status and up to
    FEATURE_EVIDENCE pieces of evidence. Evidence from a source item is held only when the
    item is one the read holds (cited by its src ref): another person's item never enters
    the author's read."""
    rows = (
        (
            await s.scalars(
                select(Evidence)
                .where(Evidence.entity_id.in_([f.id for f in named]))
                .order_by(Evidence.confidence.desc().nulls_last(), Evidence.created_at)
            )
        ).all()
        if named
        else []
    )
    evidence: dict[uuid.UUID, list[dict[str, Any]]] = {}
    for e in rows:
        if e.source_item_id is not None and e.source_item_id not in src_refs:
            continue
        held = evidence.setdefault(e.entity_id, [])  # type: ignore[arg-type]
        if len(held) < FEATURE_EVIDENCE and (e.excerpt or e.source_item_id):
            row: dict[str, Any] = {"excerpt": ev.excerpt(e.excerpt, ev.EXCERPT_CHARS)}
            if e.source_item_id is not None:
                row["ref"] = src_refs[e.source_item_id]
            held.append(row)
    return [
        {
            "ref": f"{FEATURE_REF}{f.key}",
            "id": str(f.id),
            "key": f.key,
            "title": f.title,
            "status": f.status,
            "description": ev.excerpt(f.body, EXCERPT_CHARS),
            "evidence": evidence.get(f.id, []),
        }
        for f in named
    ]


def _feature_ids(raw: Any, features: dict[str, dict[str, Any]]) -> list[str]:
    """The keys of the features a model answer cites by their feat: refs."""
    out: list[str] = []
    for ref in raw if isinstance(raw, list) else []:
        f = features.get(str(ref))
        if f is not None and f["key"] not in out:
            out.append(f["key"])
    return out


async def run(s: AsyncSession, job: LlmJob, ask) -> dict[str, Any]:
    from oracle.jobs.kinds import JobInputError

    intake = await s.get(ProductIntake, job.intake_id) if job.intake_id else None
    if intake is None:
        raise JobInputError("the intake no longer exists")
    if intake.status in CLOSED_INTAKE:
        return {"intake_id": str(intake.id), "skipped": f"the intake is {intake.status}"}
    body, known, chosen = await payload(s, intake)
    answer = await ask("intake_analysis", body)
    await s.refresh(intake)
    if intake.status in CLOSED_INTAKE:
        # Converted or archived while the model was thinking.
        return {"intake_id": str(intake.id), "skipped": f"the intake is {intake.status}"}
    marker = {"llm_job_id": str(job.id)}
    out = await apply_answer(s, intake, answer, known, chosen, marker, body)
    # INT2: the read this job is (the rollback, or the fallback for a SwarmCloud read).
    from oracle.intake import read

    read.job_finished(intake, job, out)
    await s.flush()
    return out


async def apply_answer(
    s: AsyncSession,
    intake: ProductIntake,
    answer: dict[str, Any],
    known: dict[str, uuid.UUID],
    chosen: list[ev.PinnedItem],
    marker: dict[str, Any],
    body: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Store a model answer (the job's, or an intake_analysis run's analysis.yaml) as AI
    inferences and open gaps, checked as described above. ``known``/``chosen``: the refs
    and items of the payload the model was given; ``marker``: what produced the answer
    (``llm_job_id`` or ``run_id``), kept on ``analysis.extraction``. Returns the counts;
    ``dropped_refs`` counts evidence refs outside the payload's (a feature's feat: ref is a
    citation, kept on the item or gap); ``body``: that payload, whose features and source
    sections a gap may not call missing (``dropped_described``)."""
    if not isinstance(answer, dict):
        answer = {}
    conf = {i.id: i.confidence for i in chosen}
    read = (body or {}).get("untrusted_data") or {}
    features = {f["ref"]: f for f in read.get("features") or []}
    headings = [h for src in read.get("sources") or [] for h in src.get("sections") or []]
    dropped_refs = dropped_described = 0
    for raw in [*(answer.get("items") or []), *(answer.get("gaps") or [])]:
        refs = raw.get("evidence_refs") if isinstance(raw, dict) else None
        if isinstance(refs, list):
            dropped_refs += sum(1 for r in refs if str(r) not in known and str(r) not in features)
    # The author's sources were read: what the model writes is a finding (S6).
    restricted = bool(chosen)
    analysis = dict(intake.analysis or {})
    reg = sharing.registry(intake)

    items = list(analysis.get("items") or [])
    seen = {(i["field"], i["text"].lower()) for i in items}
    room = max(0, min(MAX_ITEMS, MAX_MODEL_ITEMS - sum(i.get("origin") == "llm" for i in items)))
    added = dropped = 0
    for raw in answer.get("items") or []:
        if added >= room:
            dropped += 1
            continue
        if not isinstance(raw, dict) or raw.get("field") not in FIELDS:
            dropped += 1
            continue
        text = _text(raw.get("text"))
        if not text or (raw["field"], text.lower()) in seen:
            dropped += 1
            continue
        seen.add((raw["field"], text.lower()))
        evidence = _refs(raw.get("evidence_refs"), known)
        item = {
            "field": raw["field"],
            "text": text,
            "knowledge_state": "ai_inference",
            "origin": "llm",
            "evidence_ids": [str(i) for i in evidence],
            "feature_keys": _feature_ids(raw.get("evidence_refs"), features),
        }
        fid = str(uuid.uuid4())
        item["finding_id"] = fid
        label = sharing.category_label(raw["field"])
        # The model's words are only a draft for the summary level: the author confirms
        # or edits it before anyone else reads it (S6).
        sharing.register(
            reg, fid, kind="item", origin="model", category=raw["field"],
            source_item_ids=evidence, restricted=restricted,
            summary=f"Oracle inferred something about the {label} from the author's sources.",
            draft=sharing.one_line(text),
        )  # fmt: skip
        items.append(item)
        added += 1

    gaps = await engine.intake_gaps(s, intake.id)
    closed = closed_categories(intake, gaps)
    statements: dict[str, list[str]] = {}
    for g in gaps:
        statements.setdefault(g.category, []).append(g.statement)
    for cat in cats.CATEGORIES:
        statements.setdefault(cat.key, []).extend([cat.statement, cat.prompt])
    model_gaps = sum(1 for e in reg.values() if e.get("kind") == "gap" and e["origin"] == "model")
    gap_room = max(0, min(MAX_GAPS, MAX_MODEL_GAPS - model_gaps))
    gaps_added = 0
    for raw in answer.get("gaps") or []:
        if gaps_added >= gap_room:
            dropped += 1
            continue
        if not isinstance(raw, dict) or raw.get("category") not in cats.BY_KEY:
            dropped += 1
            continue
        cat = cats.BY_KEY[raw["category"]]
        statement = _text(raw.get("statement"))
        if (
            not statement
            or cat.key in closed
            or any(same_meaning(statement, known_) for known_ in statements[cat.key])
        ):
            dropped += 1
            continue
        if described(statement, list(features.values()), headings):
            # Walk 2, problem 17: never "not described" when the read holds it.
            dropped += 1
            dropped_described += 1
            continue
        statements[cat.key].append(statement)
        evidence = _refs(raw.get("evidence_refs"), known)
        importance = raw.get("importance") if raw.get("importance") in IMPORTANCE else None
        gap = KnowledgeGap(
            id=uuid.uuid4(),
            intake_id=intake.id,
            document_id=intake.document_id,
            category=cat.key,
            statement=statement,
            impact=list(cat.impact),
            importance=importance or cat.importance,
            evidence_ids=evidence,
            confidence=ev.aggregate([conf[i] for i in evidence if i in conf]),
            knowledge_state="ai_inference",
            status="unknown",
            related_modules=list(cat.modules),
            stop_condition=cat.stop,
            entity_ids=[
                uuid.UUID(features[f"{FEATURE_REF}{k}"]["id"])
                for k in _feature_ids(raw.get("evidence_refs"), features)
            ],
            section_keys=[],
        )
        s.add(gap)
        gaps.append(gap)
        gaps_added += 1
        sharing.register(
            reg, str(gap.id), kind="gap", origin="model", category=cat.key,
            source_item_ids=evidence, gap_id=gap.id, restricted=restricted,
            summary=f"Oracle found an open question about "
            f"{sharing.category_label(cat.key)} in the author's sources.",
            draft=sharing.one_line(statement),
        )  # fmt: skip

    analysis["items"] = items
    analysis["findings"] = reg
    if isinstance(answer.get("category"), str) and answer["category"]:
        analysis["model_category"] = _text(answer["category"])[:40]
    analysis["extraction"] = {
        **(analysis.get("extraction") or {}),
        **marker,
        "snapshot_id": str(intake.source_snapshot_ids[-1]) if intake.source_snapshot_ids else None,
    }
    # The job read what it was given, cited or not (S6, owner 2026-10-19).
    ev.note_reads(intake, analysis, conf)
    intake.analysis = analysis
    await s.flush()
    await ev.record_reads(s, intake)
    await engine.sync_questions(s, intake, gaps)
    engine.refresh_status(intake, gaps)
    return {
        "intake_id": str(intake.id),
        "items_added": added,
        "gaps_added": gaps_added,
        "dropped": dropped,
        "sources_read": len(known),
        "private": restricted,
        "dropped_refs": dropped_refs,
        "dropped_described": dropped_described,
    }
