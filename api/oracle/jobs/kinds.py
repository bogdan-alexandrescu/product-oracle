"""The built-in job kinds. Each builds its prompt's JSON payload from the database,
makes one model call through ``ask`` and turns the answer into the job's output (and,
for review comments, suggestions). The worker owns the call's accounting and the
transaction; nothing here commits.

Locked sections (latest verdict ``approved``) are never given new text: a review
suggestion for one becomes ``none``, and a refinement of one is refused.
"""

import json
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import confidence as confidence_rules
from oracle.baseline import scoring
from oracle.baseline.models import Entity, Evidence
from oracle.docs.diff import diff_sections, word_diff
from oracle.docs.models import Document, DocumentVersion, Section
from oracle.docs.parser import body_text
from oracle.jobs import prompting
from oracle.jobs.models import CLASSIFICATIONS, LlmJob, LlmSuggestion
from oracle.review.models import Comment, FeedbackItem, SectionReview
from oracle.review.service import locked_section_keys

#: Evidence at or above this confidence counts as high-confidence for pushback (C1b).
# Default for the company's confidence_weights "pushback" setting (oracle.confidence).
HIGH_CONFIDENCE = confidence_rules.DEFAULTS["pushback"]
MAX_GOALS = 30
MAX_EVIDENCE = 40
MAX_FEEDBACK = 60
MAX_TOKENS = {
    "review_comments": 8000,
    "reporting": 4000,
    "refinement": 6000,
    "intake_analysis": 4000,
    "quality_review": 4000,
    "refinement_batch": 16000,
}

# ask(kind, payload) -> the parsed answer: one model call with the kind's prompt.
Ask = Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]]


class JobInputError(RuntimeError):
    """The job cannot run as asked (its version is gone, its section is locked...)."""


@dataclass
class Context:
    document: Document
    version: DocumentVersion
    sections: list[Section]
    locked: set[str]


async def _context(s: AsyncSession, job: LlmJob) -> Context:
    document = await s.get(Document, job.document_id)
    if document is None:
        raise JobInputError("the document no longer exists")
    version = await s.get(DocumentVersion, job.version_id) if job.version_id else None
    if version is None:
        version = await s.scalar(
            select(DocumentVersion)
            .where(DocumentVersion.document_id == document.id)
            .order_by(DocumentVersion.number.desc())
            .limit(1)
        )
    if version is None:
        raise JobInputError("the document has no version")
    sections = list(
        await s.scalars(
            select(Section).where(Section.version_id == version.id).order_by(Section.ordinal)
        )
    )
    return Context(document, version, sections, await locked_section_keys(s, version.id))


def _doc(ctx: Context) -> dict[str, Any]:
    return {"title": ctx.document.title, "slug": ctx.document.slug, "version": ctx.version.number}


def _short(text: str | None, limit: int = 600) -> str:
    text = (text or "").strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


# --- review comments ------------------------------------------------------------------


async def pending_feedback(s: AsyncSession, document_id: uuid.UUID, number: int):
    """Open items raised on this or an earlier version with no live suggestion yet."""
    live = select(LlmSuggestion.feedback_item_id).where(
        LlmSuggestion.document_id == document_id, LlmSuggestion.status != "superseded"
    )
    return list(
        await s.scalars(
            select(FeedbackItem)
            .where(
                FeedbackItem.document_id == document_id,
                FeedbackItem.status == "open",
                FeedbackItem.raised_on_version <= number,
                FeedbackItem.id.not_in(live),
            )
            .order_by(FeedbackItem.created_at, FeedbackItem.id)
            .limit(MAX_FEEDBACK)
        )
    )


async def baseline_context(s: AsyncSession) -> tuple[list[dict], list[dict], dict[str, dict]]:
    """Confirmed goals and high-confidence evidence, each with a ``ref`` the model cites,
    plus the sources those refs resolve to."""
    goals = list(
        await s.scalars(
            select(Entity)
            .where(Entity.type == "goal", Entity.status == "confirmed")
            .order_by(Entity.key)
            .limit(MAX_GOALS)
        )
    )
    threshold = float(confidence_rules.merged(await scoring.company_weights(s))["pushback"])
    rows = (
        await s.execute(
            select(Evidence, Entity.title)
            .join(Entity, Entity.id == Evidence.entity_id)
            .where(Evidence.confidence >= threshold, Entity.status != "rejected")
            .order_by(Evidence.confidence.desc(), Evidence.created_at.desc())
            .limit(MAX_EVIDENCE)
        )
    ).all()
    refs: dict[str, dict] = {}
    goal_payload = []
    for g in goals:
        ref = f"goal:{g.key}"
        goal_payload.append(
            {
                "ref": ref,
                "title": g.title,
                "body": _short(g.body),
                "metric": g.attrs.get("metric"),
                "target": g.attrs.get("target"),
            }
        )
        refs[ref] = {"ref": ref, "kind": "goal", "title": g.title, "excerpt": _short(g.body, 300)}
    evidence_payload = []
    for i, (ev, about) in enumerate(rows, start=1):
        ref = f"ev:{i}"
        confidence = float(ev.confidence) if ev.confidence is not None else None
        evidence_payload.append(
            {"ref": ref, "about": about, "excerpt": _short(ev.excerpt), "confidence": confidence}
        )
        refs[ref] = {
            "ref": ref,
            "kind": "evidence",
            "title": ev.ref or about,
            "url": ev.url,
            "excerpt": _short(ev.excerpt, 300),
            "confidence": confidence,
        }
    return goal_payload, evidence_payload, refs


async def review_comments(s: AsyncSession, job: LlmJob, ask: Ask) -> dict[str, Any]:
    ctx = await _context(s, job)
    items = await pending_feedback(s, ctx.document.id, ctx.version.number)
    if not items:
        return {"handled": 0, "note": "No new feedback to handle"}
    by_id = {str(i.id): i for i in items}
    anchors = dict(
        (
            await s.execute(
                select(Comment.id, Comment.anchor).where(
                    Comment.id.in_([i.comment_id for i in items if i.comment_id])
                )
            )
        ).all()
    )
    verdicts = dict(
        (
            await s.execute(
                select(SectionReview.id, SectionReview.verdict).where(
                    SectionReview.id.in_(
                        [i.section_review_id for i in items if i.section_review_id]
                    )
                )
            )
        ).all()
    )
    # C1b: push back once per item. An item pushed back on before keeps that.
    pushed = set(
        await s.scalars(
            select(LlmSuggestion.feedback_item_id).where(
                LlmSuggestion.feedback_item_id.in_([i.id for i in items]),
                LlmSuggestion.pushback.is_not(None),
            )
        )
    )
    goals, evidence, refs = await baseline_context(s)
    payload = {
        "document": _doc(ctx),
        "sections": [
            {
                "section_key": sec.section_key,
                "heading": sec.heading,
                "body_md": sec.body_md,
                "locked": sec.section_key in ctx.locked,
            }
            for sec in ctx.sections
        ],
        "feedback": [
            {
                "feedback_id": str(i.id),
                "kind": i.kind,
                "section_key": i.section_key,
                "summary": i.summary,
                "anchor": (anchors.get(i.comment_id) or {}).get("exact"),
                "verdict": verdicts.get(i.section_review_id),
            }
            for i in items
        ],
        "goals": goals,
        "evidence": evidence,
        "no_pushback": [str(i) for i in pushed],
    }
    answer = await ask("review_comments", payload)
    keys = {sec.section_key for sec in ctx.sections}

    entries: dict[str, dict] = {}
    for raw in answer.get("items") or []:
        if isinstance(raw, dict) and str(raw.get("feedback_id")) in by_id:
            entries.setdefault(str(raw["feedback_id"]), raw)

    written: list[LlmSuggestion] = []
    pushbacks = 0
    for fid, item in by_id.items():
        raw = entries.get(fid)
        if raw is None:
            continue
        classification = raw.get("classification")
        if classification not in CLASSIFICATIONS:
            classification = "other"
        suggestion = raw.get("suggestion") if isinstance(raw.get("suggestion"), dict) else {}
        kind = suggestion.get("kind")
        text = prompting.as_str(suggestion.get("text")) or None
        rationale = prompting.as_str(suggestion.get("rationale"), 2000) or None
        section_key = prompting.as_str(suggestion.get("section_key")) or item.section_key
        duplicate_of = str(raw.get("duplicate_of") or "")
        if duplicate_of and duplicate_of != fid and duplicate_of in by_id:
            kind, text = "duplicate", None
        else:
            duplicate_of = ""
            if classification == "approval" or kind not in ("section_text", "answer", "none"):
                kind = "none" if classification == "approval" or not text else "answer"
            if kind == "section_text":
                if section_key not in keys:
                    kind, text = "none", None
                    rationale = rationale or "No section to change was identified."
                elif section_key in ctx.locked:
                    kind, text = "none", None
                    rationale = (
                        "The section is approved and locked, so Oracle proposes no new text for it."
                    )
                elif text is not None:
                    heading = next(x.heading for x in ctx.sections if x.section_key == section_key)
                    text = (await prompting.clean_body_in_thread(text, heading)).text
            if kind != "section_text":
                section_key = item.section_key
            if kind == "none":
                text = None
        pushback = None
        raw_push = raw.get("pushback")
        if isinstance(raw_push, dict) and item.id not in pushed:
            reason = prompting.as_str(raw_push.get("reason"), 2000)
            sources = [refs[str(r)] for r in raw_push.get("sources") or [] if str(r) in refs]
            # Push back only with reasoning AND at least one confirmed goal or piece of
            # high-confidence evidence behind it.
            if reason and sources:
                pushback = {
                    "reason": reason,
                    "sources": list({x["ref"]: x for x in sources}.values()),
                }
                pushbacks += 1
        group = prompting.as_str(raw.get("group"), 120) or None
        row = LlmSuggestion(
            document_id=ctx.document.id,
            feedback_item_id=item.id,
            job_id=job.id,
            version_number=ctx.version.number,
            classification=classification,
            group_key=group,
            duplicate_of=uuid.UUID(duplicate_of) if duplicate_of else None,
            kind=kind,
            section_key=section_key,
            text=text,
            rationale=rationale,
            pushback=pushback,
            status="open",
        )
        s.add(row)
        written.append(row)
    await s.flush()
    counts: dict[str, int] = {}
    for row in written:
        counts[row.classification] = counts.get(row.classification, 0) + 1
    groups = {r.group_key for r in written if r.group_key}
    return {
        "handled": len(written),
        "skipped": len(by_id) - len(written),
        "classifications": counts,
        "groups": len(groups),
        "duplicates": sum(1 for r in written if r.kind == "duplicate"),
        "pushbacks": pushbacks,
        "suggestion_ids": [str(r.id) for r in written],
    }


# --- reporting ------------------------------------------------------------------------


async def _version(s: AsyncSession, document_id: uuid.UUID, number: int) -> DocumentVersion | None:
    return await s.scalar(
        select(DocumentVersion).where(
            DocumentVersion.document_id == document_id, DocumentVersion.number == number
        )
    )


async def new_sources(s: AsyncSession, after, until) -> list[dict[str, Any]]:
    """Evidence added to the baseline in (after, until]."""
    stmt = (
        select(Evidence, Entity.title)
        .outerjoin(Entity, Entity.id == Evidence.entity_id)
        .where(Evidence.created_at <= until)
        .order_by(Evidence.created_at)
        .limit(50)
    )
    if after is not None:
        stmt = stmt.where(Evidence.created_at > after)
    out = []
    for ev, about in (await s.execute(stmt)).all():
        out.append(
            {
                "title": ev.ref or _short(ev.excerpt, 80) or ev.url or "Evidence",
                "kind": ev.kind or ("source item" if ev.source_item_id else "note"),
                "about": about,
                "url": ev.url,
                "added_at": ev.created_at.isoformat(),
            }
        )
    return out


async def reporting(s: AsyncSession, job: LlmJob, ask: Ask) -> dict[str, Any]:
    ctx = await _context(s, job)
    n = ctx.version.number
    since_n = job.input.get("since") or (n - 1 if n > 1 else None)
    since = await _version(s, ctx.document.id, since_n) if since_n else None
    if since_n and since is None:
        raise JobInputError(f"version {since_n} does not exist")

    items = list(
        await s.scalars(
            select(FeedbackItem)
            .where(FeedbackItem.document_id == ctx.document.id, FeedbackItem.raised_on_version < n)
            .order_by(FeedbackItem.raised_on_version, FeedbackItem.created_at, FeedbackItem.id)
            .limit(200)
        )
    )
    counts: dict[str, int] = {}
    for i in items:
        counts[i.status] = counts.get(i.status, 0) + 1

    changed: list[dict[str, Any]] = []
    if since is not None:
        old = list(await s.scalars(select(Section).where(Section.version_id == since.id)))
        old_by_key = {x.section_key: x for x in old}
        new_by_key = {x.section_key: x for x in ctx.sections}
        for d in diff_sections(old, ctx.sections):
            if d.status == "unchanged":
                continue
            before = old_by_key.get(d.section_key)
            after = new_by_key.get(d.section_key)
            changed.append(
                {
                    "section_key": d.section_key,
                    "status": d.status,
                    "heading": d.to_heading or d.from_heading or d.section_key,
                    "before": _short(before.body_text if before else "", 1500),
                    "after": _short(after.body_text if after else "", 1500),
                }
            )
    sources = await new_sources(s, since.created_at if since else None, ctx.version.created_at)

    answer: dict[str, Any] = {}
    if items or changed or sources:
        payload = {
            "document": {**_doc(ctx), "since": since_n},
            "feedback": [
                {
                    "feedback_id": str(i.id),
                    "summary": _short(i.summary),
                    "section_key": i.section_key,
                    "status": i.status,
                    "resolution_note": i.resolution_note,
                    "addressed_in_version": i.addressed_in_version,
                }
                for i in items
            ],
            "sections": changed,
            "new_sources": [{k: v for k, v in x.items() if k != "url"} for x in sources],
        }
        answer = await ask("reporting", payload)

    explanations = {
        str(x.get("feedback_id")): prompting.as_str(x.get("explanation"), 1000)
        for x in answer.get("items") or []
        if isinstance(x, dict)
    }
    section_notes = {
        str(x.get("section_key")): prompting.as_str(x.get("summary"), 1000)
        for x in answer.get("sections") or []
        if isinstance(x, dict)
    }
    resolution_summary = prompting.as_str(answer.get("resolution_summary"), 3000) or (
        "No feedback was raised on earlier versions."
        if not items
        else f"{len(items)} feedback item(s) were raised on earlier versions."
    )
    changes_summary = prompting.as_str(answer.get("changes_summary"), 3000) or (
        "This is the first version." if since is None and not changed else "Nothing changed."
    )
    return {
        "version": n,
        "since": since_n,
        "resolution": {
            "summary": resolution_summary,
            "counts": counts,
            "items": [
                {
                    "feedback_id": str(i.id),
                    "summary": i.summary,
                    "section_key": i.section_key,
                    "status": i.status,
                    "resolution_note": i.resolution_note,
                    "addressed_in_version": i.addressed_in_version,
                    "explanation": explanations.get(str(i.id), ""),
                }
                for i in items
            ],
        },
        "changes": {
            "since": since_n,
            "summary": changes_summary,
            "sections": [
                {
                    "section_key": c["section_key"],
                    "status": c["status"],
                    "heading": c["heading"],
                    "summary": section_notes.get(c["section_key"], ""),
                }
                for c in changed
            ],
            "new_sources": sources,
        },
    }


# --- refinement -----------------------------------------------------------------------


async def accepted_suggestions(
    s: AsyncSession, document_id: uuid.UUID, section_key: str, ids: list[str] | None
) -> list[LlmSuggestion]:
    stmt = select(LlmSuggestion).where(
        LlmSuggestion.document_id == document_id,
        LlmSuggestion.section_key == section_key,
        LlmSuggestion.kind == "section_text",
        LlmSuggestion.status == "accepted",
    )
    if ids is not None:
        stmt = stmt.where(LlmSuggestion.id.in_([uuid.UUID(i) for i in ids]))
    return list(await s.scalars(stmt.order_by(LlmSuggestion.created_at)))


def clean_heading(heading: str, fallback: str) -> str:
    line = prompting.as_str(heading, 300).splitlines()[0] if heading else ""
    line = line.lstrip("#").strip()
    line = prompting._HEADING_ID.sub("", line).strip()
    return line or fallback


def preview_words(before_heading: str, before_text: str, heading: str, body_md: str):
    return [
        w.model_dump()
        for w in word_diff(f"{before_heading}\n{before_text}", f"{heading}\n{body_text(body_md)}")
    ]


async def refinement(s: AsyncSession, job: LlmJob, ask: Ask) -> dict[str, Any]:
    ctx = await _context(s, job)
    key = job.section_key or ""
    if key in ctx.locked:
        raise JobInputError(f"section {key!r} is approved and locked; it is never changed")
    section = next((x for x in ctx.sections if x.section_key == key), None)
    if section is None:
        raise JobInputError(f"section {key!r} is not in version {ctx.version.number}")
    suggestions = await accepted_suggestions(
        s, ctx.document.id, key, job.input.get("suggestion_ids")
    )
    instruction = prompting.as_str(job.input.get("instruction"), 4000)
    if not suggestions and not instruction:
        raise JobInputError("nothing to refine: no accepted suggestions and no instruction")
    feedback = {
        f.id: f
        for f in await s.scalars(
            select(FeedbackItem).where(
                FeedbackItem.id.in_([x.feedback_item_id for x in suggestions])
            )
        )
    }
    payload = {
        "document": _doc(ctx),
        "section": {
            "section_key": key,
            "level": section.level,
            "heading": section.heading,
            "body_md": section.body_md,
        },
        "context": [x.heading for x in ctx.sections if x.section_key != key],
        "suggestions": [
            {
                "feedback_id": str(x.feedback_item_id),
                "feedback": feedback[x.feedback_item_id].summary
                if x.feedback_item_id in feedback
                else "",
                "text": x.edited_text or x.text or "",
            }
            for x in suggestions
        ],
        "instruction": instruction,
    }
    answer = await ask("refinement", payload)
    raw_body = answer.get("body_md")
    if not isinstance(raw_body, str) or not raw_body.strip():
        raise prompting.AnswerError("the refinement has no body_md")
    if len(raw_body) > prompting.MAX_BODY_CHARS:
        raise prompting.AnswerError(
            f"the refinement's body_md is longer than {prompting.MAX_BODY_CHARS:,} characters"
        )
    heading = clean_heading(prompting.as_str(answer.get("heading")), section.heading)
    cleaned = await prompting.clean_body_in_thread(raw_body, heading)

    asked = {str(x.feedback_item_id) for x in suggestions}
    resolutions = []
    for r in answer.get("resolutions") or []:
        if isinstance(r, dict) and str(r.get("feedback_id")) in asked:
            status = (
                r.get("status") if r.get("status") in ("addressed", "declined") else "addressed"
            )
            note = prompting.as_str(r.get("note"), 1000) or None
            resolutions.append(
                {"feedback_id": str(r["feedback_id"]), "status": status, "note": note}
            )
    missing = asked - {r["feedback_id"] for r in resolutions}
    resolutions += [
        {"feedback_id": fid, "status": "addressed", "note": "Refined in this version"}
        for fid in sorted(missing)
    ]
    data_points = [
        {k: prompting.as_str(d.get(k), 300) for k in ("value", "as_of", "source")}
        for d in answer.get("data_points") or []
        if isinstance(d, dict) and d.get("value")
    ][:20]
    return {
        "base_version": ctx.version.number,
        "section_key": key,
        "level": section.level,
        "heading": heading,
        "body_md": cleaned.text,
        "before": {"heading": section.heading, "body_md": section.body_md},
        "o1c_fixes": cleaned.fixes,
        "data_points": data_points,
        "notes": prompting.as_str(answer.get("notes"), 2000),
        "suggestion_ids": [str(x.id) for x in suggestions],
        "resolutions": resolutions,
        "preview": preview_words(section.heading, section.body_text, heading, cleaned.text),
    }


async def intake_analysis(s: AsyncSession, job: LlmJob, ask: Ask) -> dict[str, Any]:
    """Light extraction for a product intake (oracle.intake.job)."""
    from oracle.intake import job as intake_job

    return await intake_job.run(s, job, ask)


def _resolutions(raw: Any, asked: set[str], default_note: str) -> list[dict[str, Any]]:
    out = []
    for r in raw or []:
        if isinstance(r, dict) and str(r.get("feedback_id")) in asked:
            if any(x["feedback_id"] == str(r["feedback_id"]) for x in out):
                continue
            status = (
                r.get("status") if r.get("status") in ("addressed", "declined") else "addressed"
            )
            note = prompting.as_str(r.get("note"), 1000) or None
            out.append({"feedback_id": str(r["feedback_id"]), "status": status, "note": note})
    missing = asked - {r["feedback_id"] for r in out}
    out += [
        {"feedback_id": fid, "status": "addressed", "note": default_note} for fid in sorted(missing)
    ]
    return out


def _data_points(raw: Any) -> list[dict[str, str]]:
    return [
        {k: prompting.as_str(d.get(k), 300) for k in ("value", "as_of", "source")}
        for d in raw or []
        if isinstance(d, dict) and d.get("value")
    ][:20]


async def staged_suggestions(
    s: AsyncSession, document_id: uuid.UUID, ids: list[str] | None = None
) -> list[LlmSuggestion]:
    """C1e: accepted section-text suggestions not applied in any draft yet, whichever
    draft they were raised on, oldest first."""
    stmt = select(LlmSuggestion).where(
        LlmSuggestion.document_id == document_id,
        LlmSuggestion.kind == "section_text",
        LlmSuggestion.status == "accepted",
        LlmSuggestion.applied_in_version.is_(None),
    )
    if ids is not None:
        stmt = stmt.where(LlmSuggestion.id.in_([uuid.UUID(str(i)) for i in ids]))
    return list(await s.scalars(stmt.order_by(LlmSuggestion.created_at, LlmSuggestion.id)))


async def refinement_batch(s: AsyncSession, job: LlmJob, ask: Ask) -> dict[str, Any]:
    """C1e: every section the chosen staged suggestions touch, revised in one call."""
    ctx = await _context(s, job)
    suggestions = await staged_suggestions(s, ctx.document.id, job.input.get("suggestion_ids"))
    keys = {x.section_key for x in ctx.sections}
    skipped: list[dict[str, Any]] = []
    usable = []
    for x in suggestions:
        if x.section_key not in keys:
            skipped.append(
                {
                    "section_key": x.section_key,
                    "suggestion_ids": [str(x.id)],
                    "reason": f"the section is not in version {ctx.version.number}",
                }
            )
        else:
            usable.append(x)
    if not usable:
        raise JobInputError("nothing to build: no staged suggestion is left for this draft")
    locked = sorted({x.section_key for x in usable if x.section_key in ctx.locked})
    if locked:
        names = ", ".join(
            f"{x.heading} ({x.section_key})" for x in ctx.sections if x.section_key in locked
        )
        raise JobInputError(f"approved and locked, never changed: {names}")
    feedback = {
        f.id: f
        for f in await s.scalars(
            select(FeedbackItem).where(FeedbackItem.id.in_([x.feedback_item_id for x in usable]))
        )
    }
    affected = {x.section_key for x in usable}
    payload = {
        "document": {**_doc(ctx), "next_version": ctx.version.number + 1},
        "sections": [
            {
                "section_key": sec.section_key,
                "level": sec.level,
                "heading": sec.heading,
                "body_md": sec.body_md,
                "locked": sec.section_key in ctx.locked,
                "affected": sec.section_key in affected,
            }
            for sec in ctx.sections
        ],
        "suggestions": [
            {
                "feedback_id": str(x.feedback_item_id),
                "section_key": x.section_key,
                "feedback": feedback[x.feedback_item_id].summary
                if x.feedback_item_id in feedback
                else "",
                "raised_on_version": feedback[x.feedback_item_id].raised_on_version
                if x.feedback_item_id in feedback
                else x.version_number,
                "text": x.edited_text or x.text or "",
            }
            for x in usable
        ],
    }
    answer = await ask("refinement_batch", payload)
    entries: dict[str, dict[str, Any]] = {}
    for raw in answer.get("sections") or []:
        if not isinstance(raw, dict):
            continue
        key = str(raw.get("section_key") or "")
        body = raw.get("body_md")
        if key in affected and isinstance(body, str) and body.strip():
            entries.setdefault(key, raw)
    if not entries:
        raise prompting.AnswerError("the next draft has no revised section")

    out_sections = []
    for sec in ctx.sections:
        key = sec.section_key
        if key not in affected:
            continue
        mine = [x for x in usable if x.section_key == key]
        raw = entries.get(key)
        too_long = raw is not None and len(raw["body_md"]) > prompting.MAX_BODY_CHARS
        if raw is None or too_long:
            skipped.append(
                {
                    "section_key": key,
                    "suggestion_ids": [str(x.id) for x in mine],
                    "reason": (
                        "Oracle's text for this section is longer than "
                        f"{prompting.MAX_BODY_CHARS:,} characters"
                        if too_long
                        else "Oracle returned no text for this section"
                    ),
                }
            )
            continue
        heading = clean_heading(prompting.as_str(raw.get("heading")), sec.heading)
        cleaned = await prompting.clean_body_in_thread(raw["body_md"], heading)
        asked = {str(x.feedback_item_id) for x in mine}
        out_sections.append(
            {
                "section_key": key,
                "level": sec.level,
                "heading": heading,
                "body_md": cleaned.text,
                "before": {"heading": sec.heading, "body_md": sec.body_md},
                "o1c_fixes": cleaned.fixes,
                "data_points": _data_points(raw.get("data_points")),
                "notes": prompting.as_str(raw.get("notes"), 2000),
                "suggestion_ids": [str(x.id) for x in mine],
                "resolutions": _resolutions(
                    raw.get("resolutions"), asked, "Worked into the next draft"
                ),
                "preview": preview_words(sec.heading, sec.body_text, heading, cleaned.text),
            }
        )
    return {
        "base_version": ctx.version.number,
        "notes": prompting.as_str(answer.get("notes"), 3000),
        "sections": out_sections,
        "skipped": skipped,
        "suggestion_ids": [str(x.id) for x in usable],
    }


async def quality_review(s: AsyncSession, job: LlmJob, ask: Ask) -> dict[str, Any]:
    """CR-08 light judging; it lives with the quality criteria it judges."""
    from oracle.quality import judge

    return await judge.run(s, job, ask, await _context(s, job))


RUNNERS: dict[str, Callable[[AsyncSession, LlmJob, Ask], Awaitable[dict[str, Any]]]] = {
    "review_comments": review_comments,
    "reporting": reporting,
    "refinement": refinement,
    "intake_analysis": intake_analysis,
    "quality_review": quality_review,
    "refinement_batch": refinement_batch,
}


def payload_text(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False, default=str, indent=1)
