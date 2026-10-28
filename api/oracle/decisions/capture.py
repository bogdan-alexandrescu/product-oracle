"""Decisions Oracle records on its own (H1, owner 2026-10-21 "Log scope": everything that
decides). Each hook writes one decided record per source, enforced by the unique
``(tenant_id, source_kind, source_id)``: a retried hook finds its record and adds none.

Judgement calls (a first version approval, an accepted gap risk or assumption, a blocker's
risk, option or feasibility scope, an override of Oracle's pushback, a priority moved
against Oracle's order) are reviewed in 90 days and sync to the baseline graph.
Checkpoint records (a run's stop approved or sent back) record the run's decision and
nothing more: no review date, no Inbox row, no baseline entity.

Captured calls name what they are about in ``subjects`` only, never ``entity_ids``: their
baseline entity gets no ``affects`` edges, so recording a call made elsewhere never adds a
change of its own to the graph (the source already recorded its change). A request's no
(H10) is the one exception: it cites its basis (a stop choice, a feature or a goal) in
``entity_ids``, so agents asking "why didn't we build X?" find it from that record.

Every hook runs in the transaction of the decision it records; the caller commits.
"""

import uuid
from collections.abc import Iterable
from datetime import UTC, date, datetime, timedelta
from typing import TYPE_CHECKING, Any
from zoneinfo import ZoneInfo

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.decisions import service
from oracle.decisions.models import Decision

if TYPE_CHECKING:
    from oracle.auth.deps import Principal
    from oracle.baseline.models import Entity
    from oracle.docs.models import Document, DocumentVersion
    from oracle.jobs.models import LlmSuggestion
    from oracle.requests.models import ProductRequest
    from oracle.runs.models import Checkpoint, Run
    from oracle.v2.models import AssumptionDecision, BlockerOption, BlockerResolutionEvent

# The stop of each checkpoint kind, as checkpoint records name it.
STOP_LABELS = {
    "baseline_confirm": "Baseline confirm",
    "feature_set": "Feature set",
    "priority_order": "Priority order",
    "prd_review": "PRD review",
    "eng_review": "Engineering check",
    "eng_dates": "Engineering dates",
    "roadmap_items": "Roadmap items",
    "roadmap_review": "Roadmap review",
    "strategy_review": "Vision or strategy review",
    "request_triage": "Request triage",
    "launch_review": "Launch kit review",
    "pricing_review": "Pricing memo review",
}
CHECKPOINT_OPTIONS = (("approve", "Approve"), ("request_changes", "Send back"))
NO_OUTCOME = "See the document's success metrics"


def _option(key: str, label: str, **extra: Any) -> dict[str, Any]:
    return {
        "key": key,
        "label": label[:200],
        "summary": extra.get("summary"),
        "pros": list(extra.get("pros") or []),
        "cons": list(extra.get("cons") or []),
        "evidence_ids": [str(e) for e in extra.get("evidence_ids") or []],
        "cost_if_wrong": extra.get("cost_if_wrong"),
        "recommended": bool(extra.get("recommended")),
    }


def _plural(n: int, word: str) -> str:
    return f"{n} {word}" if n == 1 else f"{n} {word}s"


def checkpoint_line(decision: str, *, staged: int = 0, waivers: int = 0) -> str:
    """The rationale of a checkpoint decision made with no note, from what was staged
    (D8: "Approved with 3 staged changes and 1 waiver")."""
    verb = "Approved" if decision == "approved" else "Sent back"
    parts = []
    if staged:
        parts.append(_plural(staged, "staged change"))
    if waivers:
        parts.append(_plural(waivers, "waiver"))
    return f"{verb} with {' and '.join(parts)}" if parts else f"{verb} with no note"


def _title(text: str) -> str:
    text = " ".join((text or "").split())
    return text if len(text) <= 200 else text[:199].rstrip() + "…"


async def _review_date(db: AsyncSession, value: datetime | date | None) -> date:
    """The review day in the company time zone; by default the company's today + 90."""
    zone = await service.company_zone(db)
    if isinstance(value, datetime):
        moment = value if value.tzinfo else value.replace(tzinfo=UTC)
        return moment.astimezone(ZoneInfo(zone)).date()
    if isinstance(value, date):
        return value
    return service.today(zone) + timedelta(days=service.REVIEW_DAYS)


def _person(principal: "Principal | None") -> uuid.UUID | None:
    if principal is None:
        return None
    return principal.user_id or principal.id


async def capture(
    db: AsyncSession,
    principal: "Principal | None",
    *,
    origin: str,
    source_kind: str,
    source_id: uuid.UUID,
    title: str,
    options: list[dict[str, Any]],
    chosen_option: str,
    rationale: str,
    approver_id: uuid.UUID,
    question: str | None = None,
    context: str | None = None,
    review_at: datetime | date | None = None,
    expected_outcome: str | None = None,
    evidence_ids: Iterable[uuid.UUID] = (),
    entity_ids: Iterable[uuid.UUID] = (),
    subjects: Iterable[dict[str, Any]] = (),
    run_id: uuid.UUID | None = None,
    decided_via: str | None = None,
    decided_actor: str = "user",
    decided_by: uuid.UUID | None = None,
    reversibility: str = "reversible",
) -> Decision:
    """Record a decision made elsewhere, decided, once per source. Returns the record
    (the existing one when this source was recorded before)."""
    number = await service.next_number(db)
    existing = await db.scalar(
        select(Decision).where(Decision.source_kind == source_kind, Decision.source_id == source_id)
    )
    if existing is not None:
        return existing
    checkpoint = origin == "checkpoint"
    d = Decision(
        number=number,
        title=_title(title),
        question=question,
        context=(context or "").strip()[:4000] or None,
        options=[{**_option(o["key"], o.get("label") or o["key"]), **o} for o in options],
        chosen_option=chosen_option,
        rationale=(rationale or "").strip() or ("Recorded" if checkpoint else "No reason given"),
        reversibility=reversibility,
        status="decided",
        approver_id=approver_id,
        # A call a person made (an approval, a review meeting) is driven by them; Oracle
        # only wrote the record. Oracle drives its own calls and autonomy's.
        driver=(
            f"user:{decided_by or approver_id}"
            if decided_actor == "user" and origin not in ("oracle", "autonomy")
            else "oracle"
        ),
        evidence_ids=list(dict.fromkeys(evidence_ids)),
        entity_ids=list(dict.fromkeys(entity_ids)),
        subjects=list(subjects)[:10],
        expected_outcome=expected_outcome,
        review_at=None if checkpoint else await _review_date(db, review_at),
        origin=origin,
        source_kind=source_kind,
        source_id=source_id,
        run_id=run_id,
        decided_via=decided_via,
        decided_by=decided_by or approver_id,
        decided_actor=decided_actor,
        decided_at=service._now(),
        created_by=_person(principal),
    )
    db.add(d)
    await db.flush()
    if not checkpoint:
        await service.sync_entity(db, principal, d)
    await audit.record(
        db,
        principal if principal is not None else audit.ORACLE,
        "decision.captured",
        "decision",
        d.id,
        {"number": d.number, "origin": origin, "source_kind": source_kind},
    )
    return d


# --- judgement calls -------------------------------------------------------------------------


async def version_approved(
    db: AsyncSession,
    principal: "Principal",
    document: "Document",
    version: "DocumentVersion",
    readiness: str | None = None,
) -> Decision:
    """A document version approved for the first time: "Publish <document> v<n>"."""
    from oracle.quality.models import OutcomeRecord

    outcomes = list(
        await db.scalars(
            select(OutcomeRecord)
            .where(OutcomeRecord.prd_version_id == version.id)
            .order_by(OutcomeRecord.created_at)
        )
    )
    expected = "; ".join(
        f"{(o.prediction or {}).get('metric')}: {(o.prediction or {}).get('predicted')}"
        for o in outcomes
        if (o.prediction or {}).get("metric")
    )
    approver = _person(principal)
    assert approver is not None
    return await capture(
        db,
        principal,
        origin="version_approval",
        source_kind="document_version",
        source_id=version.id,
        title=f"Publish {document.title} v{version.number}",
        options=[_option("publish", "Publish"), _option("keep_in_review", "Keep in review")],
        chosen_option="publish",
        rationale=f"Approved version {version.number} of {document.title}",
        context=readiness,
        approver_id=approver,
        expected_outcome=expected[:2000] or NO_OUTCOME,
        subjects=[
            {
                "kind": "document_version",
                "id": str(version.id),
                "ref": f"{document.slug}@{version.number}",
            },
            {"kind": "document", "id": str(document.id), "ref": document.slug},
        ],
    )


async def gap_decided(
    db: AsyncSession, principal: "Principal", decision: "AssumptionDecision"
) -> Decision | None:
    """A gap's assumption or risk accepted (validate and reject are not judgement calls
    to review: they close or reopen the gap)."""
    if decision.decision not in ("accept_risk", "accept_assumption"):
        return None
    label = "Accept the risk" if decision.decision == "accept_risk" else "Proceed on the assumption"
    approver = _person(principal)
    assert approver is not None
    subjects = []
    if decision.gap_id is not None:
        subjects.append(
            {"kind": "gap", "id": str(decision.gap_id), "ref": f"gap:{decision.gap_id}"}
        )
    if decision.document_id is not None:
        subjects.append({"kind": "document", "id": str(decision.document_id)})
    if decision.entity_id is not None:
        subjects.append({"kind": "entity", "id": str(decision.entity_id)})
    return await capture(
        db,
        principal,
        origin="assumption",
        source_kind="assumption_decision",
        source_id=decision.id,
        title=decision.statement,
        context=decision.statement if len(decision.statement) > 200 else None,
        options=[_option(decision.decision, label), _option("validate", "Validate it first")],
        chosen_option=decision.decision,
        rationale=decision.rationale,
        approver_id=approver,
        review_at=decision.review_at,
        subjects=subjects,
    )


async def blocker_decided(
    db: AsyncSession,
    principal: "Principal",
    entity: "Entity",
    event: "BlockerResolutionEvent",
    *,
    chosen: str,
    rationale: str | None,
    review_at: datetime | None = None,
) -> Decision:
    """A blocker's risk accepted, an option selected or a feasibility scope approved: the
    options are the blocker's, with what was chosen when it is not one of them."""
    from oracle.v2.models import BlockerOption

    rows: list[BlockerOption] = list(
        await db.scalars(
            select(BlockerOption)
            .where(BlockerOption.blocker_id == entity.id)
            .order_by(BlockerOption.created_at, BlockerOption.id)
        )
    )
    options = [_blocker_option(o) for o in rows]
    extra = {"accept_risk": "Accept the risk", "feasibility_scope": "Scoped feasibility experiment"}
    if chosen in extra and chosen not in {o["key"] for o in options}:
        options.append(_option(chosen, extra[chosen]))
    verb = {
        "option_selected": "Resolve",
        "risk_accepted": "Accept the risk of",
        "feasibility_scope_approved": "Scope a feasibility experiment for",
    }.get(event.kind, "Decide")
    chosen_label = next((o["label"] for o in options if o["key"] == chosen), chosen)
    title = f"{verb} {entity.title}" + (
        f": {chosen_label}" if event.kind == "option_selected" else ""
    )
    approver = _person(principal)
    assert approver is not None
    return await capture(
        db,
        principal,
        origin="blocker",
        source_kind="blocker_event",
        source_id=event.id,
        title=title,
        options=options,
        chosen_option=chosen,
        rationale=rationale or event.reason or "",
        approver_id=approver,
        review_at=review_at,
        evidence_ids=[e for o in rows for e in o.evidence_ids or []],
        subjects=[{"kind": "blocker", "id": str(entity.id), "ref": f"constraint:{entity.key}"}],
    )


def _blocker_option(o: "BlockerOption") -> dict[str, Any]:
    details = o.details or {}
    return _option(
        str(o.id),
        o.title,
        summary=(o.description or "")[:1000] or None,
        pros=[str(details["expected_outcome"])] if details.get("expected_outcome") else [],
        cons=[str(details["risk"])] if details.get("risk") else [],
        evidence_ids=o.evidence_ids or [],
        cost_if_wrong=str(details["fallback"]) if details.get("fallback") else None,
    )


async def pushback_overridden(
    db: AsyncSession, principal: "Principal", row: "LlmSuggestion", reason: str
) -> Decision:
    """An approver kept their call over Oracle's pushback (C1b: logged for review)."""
    from oracle.docs.models import Document

    pushback = row.pushback or {}
    sources = [s for s in pushback.get("sources") or [] if isinstance(s, dict)]
    lines = [f"Oracle pushed back: {pushback.get('reason') or 'no reason recorded'}"]
    lines += [
        f"- {s.get('title') or s.get('ref')}" + (f" ({s['url']})" if s.get("url") else "")
        for s in sources
    ]
    evidence = []
    for s in sources:
        try:
            evidence.append(uuid.UUID(str(s.get("id"))))
        except ValueError:
            continue
    document = await db.get(Document, row.document_id)
    name = document.title if document else "the document"
    approver = _person(principal)
    assert approver is not None
    return await capture(
        db,
        principal,
        origin="pushback_override",
        source_kind="llm_suggestion",
        source_id=row.id,
        title=f"Keep the reviewer's call over Oracle's pushback on {name}",
        options=[
            _option("keep_reviewers_call", "Keep the reviewer's call"),
            _option("take_oracles_advice", "Take Oracle's advice", recommended=True),
        ],
        chosen_option="keep_reviewers_call",
        rationale=reason,
        context="\n".join(lines),
        approver_id=approver,
        evidence_ids=[],
        subjects=[
            {"kind": "document", "id": str(row.document_id), "ref": document.slug}
            if document
            else {"kind": "document", "id": str(row.document_id)}
        ],
    )


# --- checkpoint records ---------------------------------------------------------------------


def _staged_counts(cp: "Checkpoint") -> tuple[int, int, list[dict[str, Any]]]:
    """Staged changes and waivers (with reasons) a stop's decision carried (D8, D3),
    when the checkpoint's payload records them."""
    payload = cp.payload or {}
    draft = payload.get("draft") if isinstance(payload.get("draft"), dict) else {}
    staged = draft.get("staged") or payload.get("staged") or []
    waivers = draft.get("waivers") or payload.get("waivers") or []
    staged_n = len(staged) if isinstance(staged, list) else int(staged or 0)
    waiver_rows = [w for w in waivers if isinstance(w, dict)] if isinstance(waivers, list) else []
    return staged_n, len(waiver_rows), waiver_rows


async def checkpoint(
    db: AsyncSession,
    principal: "Principal | None",
    run: "Run",
    cp: "Checkpoint",
    *,
    decided_via: str = "oracle",
) -> Decision | None:
    """A run's stop approved or sent back, recorded in the decision's own transaction.
    A skipped stop or one still pending (a console answer waiting to be confirmed) is
    not a decision."""
    from oracle.docs.models import Document, DocumentVersion
    from oracle.runs.flows import FLOWS

    if cp.status not in ("approved", "changes_requested"):
        return None
    chosen = "approve" if cp.status == "approved" else "request_changes"
    stop = STOP_LABELS.get(cp.kind, cp.kind.replace("_", " ").capitalize())
    document = await db.get(Document, run.document_id) if run.document_id else None
    name = document.title if document else (run.knobs or {}).get("document_slug")
    flow = FLOWS.get(run.flow)
    run_title = f"{name} run" if name else (f"{flow.title} run" if flow else "Run")
    verb = "Approve" if chosen == "approve" else "Send back"
    staged, waived, waivers = _staged_counts(cp)
    rationale = cp.note or checkpoint_line(cp.status, staged=staged, waivers=waived)
    payload = cp.payload or {}
    seq = payload.get("segment_seq")
    segment = None
    if flow is not None and isinstance(seq, int) and 0 < seq <= len(flow.segments):
        segment = flow.segments[seq - 1].name
    context = []
    if waivers:
        context.append("Waivers:")
        context += [f"- {w.get('title') or w.get('key')}: {w.get('reason') or ''}" for w in waivers]
    if staged:
        context.append(f"Staged changes: {staged}")
    review_file = payload.get("review_file")
    if isinstance(review_file, str) and review_file:
        context.append(f"Review file: {review_file}")
    subjects: list[dict[str, Any]] = [
        {
            "kind": "run",
            "id": str(run.id),
            "ref": f"run:{run.id}",
            "checkpoint_kind": cp.kind,
            "segment": segment,
        }
    ]
    imported = payload.get("import")
    if isinstance(imported, dict) and imported.get("version") and imported.get("document_id"):
        version_id = await db.scalar(
            select(DocumentVersion.id).where(
                DocumentVersion.document_id == uuid.UUID(str(imported["document_id"])),
                DocumentVersion.number == int(imported["version"]),
            )
        )
        if version_id is not None:
            subjects.append(
                {
                    "kind": "document_version",
                    "id": str(version_id),
                    "ref": f"{imported.get('slug')}@{imported['version']}",
                }
            )
    approver = cp.decided_by or run.created_by or _person(principal)
    if approver is None:
        return None
    actor = "user" if decided_via == "oracle" else decided_via
    return await capture(
        db,
        principal,
        origin="checkpoint",
        source_kind="checkpoint",
        source_id=cp.id,
        title=f"{verb} {stop} · {run_title}",
        options=[_option(k, label) for k, label in CHECKPOINT_OPTIONS],
        chosen_option=chosen,
        rationale=rationale,
        context="\n".join(context) or None,
        approver_id=approver,
        decided_by=cp.decided_by,
        decided_via=decided_via,
        decided_actor=actor,
        run_id=run.id,
        subjects=subjects,
    )


async def checkpoint_voided(db: AsyncSession, checkpoint_id: uuid.UUID) -> None:
    """A decision voided before it reached the run is no decision: its record goes, so
    the checkpoint's next decision is recorded instead."""
    await db.execute(
        delete(Decision).where(
            Decision.source_kind == "checkpoint", Decision.source_id == checkpoint_id
        )
    )


# --- requests (H10 Reasoned no) ---------------------------------------------------------------


async def request_declined(
    db: AsyncSession,
    principal: "Principal",
    request: "ProductRequest",
    *,
    reason_label: str,
    basis_entity: "Entity | None" = None,
) -> Decision:
    """A request said no to for a reason that answers the asker: "Say no to <title>",
    reviewed in 90 days. Its basis entity (a stop choice, a feature, a goal) is the one
    record the no cites, in ``entity_ids``. A request declined again after a reopen gets
    a record of its own (the earlier one stays reversed)."""
    approver = _person(principal)
    assert approver is not None
    earlier = await db.scalar(
        select(func.count(Decision.id)).where(
            Decision.origin == "request_decline",
            Decision.subjects.contains([{"kind": "request", "id": str(request.id)}]),
        )
    )
    source_id = request.id if not earlier else uuid.uuid5(request.id, f"request_decline:{earlier}")
    note = (request.decision_note or "").strip()
    return await capture(
        db,
        principal,
        origin="request_decline",
        source_kind="product_request",
        source_id=source_id,
        title=f"Say no to {request.title}",
        question=f"Build {request.title}?",
        options=[_option("say_no", "Say no"), _option("keep_open", "Keep it open")],
        chosen_option="say_no",
        rationale=f"{reason_label}: {note}" if note else reason_label,
        approver_id=approver,
        reversibility="reversible",
        entity_ids=[basis_entity.id] if basis_entity is not None else [],
        subjects=[{"kind": "request", "id": str(request.id), "ref": _title(request.title)}],
    )


async def request_reopened(
    db: AsyncSession, principal: "Principal", request: "ProductRequest", reason: str | None
) -> Decision | None:
    """A declined request reopened: its decided ``request_decline`` record is reversed,
    with a review by the reopener (who may not be the decision's approver; the reopen
    route's own approver check stands). None when the decline logged no decision."""
    from oracle.decisions.models import DecisionReview
    from oracle.requests.replies import live_decision

    d = await live_decision(db, request.id)
    if d is None or d.status != "decided":
        return None
    note = (
        f"Request reopened: {reason.strip()}" if reason and reason.strip() else "Request reopened"
    )
    who = _person(principal)
    assert who is not None
    d.status = "reversed"
    db.add(DecisionReview(decision_id=d.id, verdict="reversed", note=note, reviewed_by=who))
    await db.flush()
    await service.reject_entity(db, principal, d, f"reversed: {note}")
    await audit.record(
        db,
        principal,
        "decision.review_reversed",
        "decision",
        d.id,
        {"note": note, "revisit_id": None},
    )
    return d
