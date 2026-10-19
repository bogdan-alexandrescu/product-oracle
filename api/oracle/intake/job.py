"""The ``intake_analysis`` built-in job: light extraction on Oracle's Claude account pool.

It runs like the other built-in jobs (docs/llm-jobs.md): queued, claimed by the worker
or ``oracle tick``, one model call through ``oracle.llm``. Never SwarmCloud. (Under V2c
and V2d this is background work that moves to SwarmCloud in wave 2: INT-2.)

Untrusted content stays data (§5, §12): the system prompt is the fixed prompt file, and
the user message carries, outside ``untrusted_data``, only Oracle's own fixed values (ids,
fields, category keys and labels, gap categories and statuses, limits). Everything a
person or a source wrote travels inside ``untrusted_data``: the intake's title, the
brief, every gap statement (any commenter can write one), the confirmed goals and the
pinned source excerpts.

What comes back is checked before it is stored: known fields and categories only,
bounded text, at most ``MAX_ITEMS`` items and ``MAX_GAPS`` gaps per run (and
``MAX_MODEL_ITEMS`` / ``MAX_MODEL_GAPS`` in all), evidence refs that resolve to items
the job was given, no gap in a category already answered or covered by the baseline,
and no gap that says what an existing gap of its category says. Every result is an
**AI inference**: items join the analysis, gaps join the registry as open, unknown gaps.
When the job read any of the author's sources, every item and gap it writes is a
finding that starts ``private`` (S6): only the author sees it until they share it, and
its shareable summary never repeats source text or figures. A converted or archived
intake is left as it is.
"""

import uuid
from typing import Any, get_args

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.baseline.models import Entity
from oracle.intake import categories as cats
from oracle.intake import engine, extract, sharing
from oracle.intake import evidence as ev
from oracle.intake.schemas import ExtractedField
from oracle.jobs.models import LlmJob
from oracle.v2.models import KnowledgeGap, ProductIntake

MAX_SOURCES = 25
MAX_TEXT = 500
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
    chosen = sorted(extract.relevant(items, intake.brief), key=lambda i: -i.confidence)
    chosen = chosen[:MAX_SOURCES]
    refs = {f"src:{n}": i.id for n, i in enumerate(chosen, start=1)}
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
            "gap_statements": [{"ref": ref, "statement": g.statement} for ref, g in gap_refs],
            "goals": [{"ref": f"goal:{g.key}", "title": g.title} for g in goals],
            "sources": [
                {
                    "ref": ref,
                    "kind": i.row.source_kind,
                    "title": i.title,
                    "excerpt": ev.excerpt(i.text, 1500),
                }
                for ref, i in zip(refs, chosen, strict=True)
            ],
        },
    }
    return body, refs, chosen


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

    conf = {i.id: i.confidence for i in chosen}
    # The author's sources were read: what the model writes is a finding (S6).
    restricted = bool(chosen)
    texts = [t for i in chosen for t in (i.text, i.title or "")]
    shared = f"{intake.title} {intake.brief}"
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
        }
        fid = str(uuid.uuid4())
        item["finding_id"] = fid
        label = sharing.category_label(raw["field"])
        sharing.register(
            reg, fid, kind="item", origin="model", category=raw["field"],
            source_item_ids=evidence, restricted=restricted,
            summary=sharing.oracle_summary(
                text, texts, f"Oracle inferred something about the {label} from the "
                "author's sources.", shared),
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
            entity_ids=[],
            section_keys=[],
        )
        s.add(gap)
        gaps.append(gap)
        gaps_added += 1
        sharing.register(
            reg, str(gap.id), kind="gap", origin="model", category=cat.key,
            source_item_ids=evidence, gap_id=gap.id, restricted=restricted,
            summary=sharing.oracle_summary(
                statement, texts, f"Oracle found an open question about "
                f"{sharing.category_label(cat.key)} in the author's sources.", shared),
        )  # fmt: skip

    analysis["items"] = items
    analysis["findings"] = reg
    if isinstance(answer.get("category"), str) and answer["category"]:
        analysis["model_category"] = _text(answer["category"])[:40]
    analysis["extraction"] = {
        **(analysis.get("extraction") or {}),
        "llm_job_id": str(job.id),
        "snapshot_id": str(intake.source_snapshot_ids[-1]) if intake.source_snapshot_ids else None,
    }
    intake.analysis = analysis
    await s.flush()
    await engine.sync_questions(s, intake, gaps)
    if intake.status in ("ready", "awaiting_answers", "analyzing"):
        intake.status = (
            "awaiting_answers" if any(g.status in engine.OPEN for g in gaps) else "ready"
        )
    return {
        "intake_id": str(intake.id),
        "items_added": added,
        "gaps_added": gaps_added,
        "dropped": dropped,
        "sources_read": len(known),
        "private": restricted,
    }
