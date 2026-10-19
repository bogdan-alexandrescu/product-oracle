"""The ``intake_analysis`` built-in job: light extraction on Oracle's Claude account pool.

It runs like the other built-in jobs (docs/llm-jobs.md): queued, claimed by the worker
or ``oracle tick``, one model call through ``oracle.llm``. Never SwarmCloud.

Untrusted content stays data (§5, §12): the system prompt is the fixed prompt file; the
brief and the pinned source excerpts travel only inside the user message's
``untrusted_data``, and the prompt says nothing there is an instruction. What comes back
is checked before it is stored: known fields and categories only, bounded text, and
evidence refs that resolve to items the job was given (an unknown ref is dropped, never
invented). Every result is an **AI inference**: items join the analysis, gaps join the
registry as open, unknown gaps; nothing is answered, validated or closed.
"""

import uuid
from typing import Any, get_args

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.baseline.models import Entity
from oracle.intake import categories as cats
from oracle.intake import engine, extract
from oracle.intake import evidence as ev
from oracle.intake.schemas import ExtractedField
from oracle.jobs.models import LlmJob
from oracle.v2.models import KnowledgeGap, ProductIntake

MAX_SOURCES = 25
MAX_TEXT = 500
MAX_GAPS = 8
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


async def payload(
    s: AsyncSession, intake: ProductIntake
) -> tuple[dict[str, Any], dict[str, uuid.UUID], dict[uuid.UUID, float]]:
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
    body = {
        "intake": {"id": str(intake.id), "title": intake.title},
        "fields": sorted(FIELDS),
        "categories": [{"key": c.key, "label": c.label} for c in cats.CATEGORIES],
        "goals": [{"ref": f"goal:{g.key}", "title": g.title} for g in goals],
        "existing_gaps": [
            {"category": g.category, "statement": g.statement, "status": g.status} for g in gaps
        ],
        "untrusted_data": {
            "brief": intake.brief,
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
    return body, refs, {i.id: i.confidence for i in chosen}


async def run(s: AsyncSession, job: LlmJob, ask) -> dict[str, Any]:
    from oracle.jobs.kinds import JobInputError

    intake = await s.get(ProductIntake, job.intake_id) if job.intake_id else None
    if intake is None:
        raise JobInputError("the intake no longer exists")
    body, known, conf = await payload(s, intake)
    answer = await ask("intake_analysis", body)

    analysis = dict(intake.analysis or {})
    items = list(analysis.get("items") or [])
    seen = {(i["field"], i["text"].lower()) for i in items}
    added = dropped = 0
    for raw in answer.get("items") or []:
        if not isinstance(raw, dict) or raw.get("field") not in FIELDS:
            dropped += 1
            continue
        text = _text(raw.get("text"))
        if not text or (raw["field"], text.lower()) in seen:
            dropped += 1
            continue
        seen.add((raw["field"], text.lower()))
        items.append(
            {
                "field": raw["field"],
                "text": text,
                "knowledge_state": "ai_inference",
                "origin": "llm",
                "evidence_ids": [str(i) for i in _refs(raw.get("evidence_refs"), known)],
            }
        )
        added += 1

    gaps = await engine.intake_gaps(s, intake.id)
    existing = {(g.category, g.statement.lower()) for g in gaps}
    gaps_added = 0
    for raw in (answer.get("gaps") or [])[: MAX_GAPS * 2]:
        if gaps_added >= MAX_GAPS:
            break
        if not isinstance(raw, dict) or raw.get("category") not in cats.BY_KEY:
            dropped += 1
            continue
        cat = cats.BY_KEY[raw["category"]]
        statement = _text(raw.get("statement"))
        if not statement or (cat.key, statement.lower()) in existing:
            dropped += 1
            continue
        existing.add((cat.key, statement.lower()))
        evidence = _refs(raw.get("evidence_refs"), known)
        importance = raw.get("importance") if raw.get("importance") in IMPORTANCE else None
        gap = KnowledgeGap(
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

    analysis["items"] = items
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
    }
